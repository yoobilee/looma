/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalRepositories } from '@/data/local/localRepositories';
import { createMemoryStateStore, type StateStore } from '@/data/local/stateStore';
import type { AppData, StoredAppState } from '@/data/local/appData';
import type { Repositories } from '@/data/repositories/types';
import { PROJECT_A } from '@/data/mock/seed';
import { analyzeTestAssetImport, defaultDecisionFor, parseImportRow, suggestColumnMapping, type ImportTable } from '@/domain/testAssetImport';
import type { TestCase } from '@/domain/types';
import { analyzeResultImport, defaultResultDecisionFor, type ResultColumnMapping } from '@/domain/testResultImport';
import { nodeCrc32, rebuildZip } from '@/lib/ooxml/__fixtures__/zipBuilder';
import { patchXlsx } from '@/lib/ooxml/xlsxPatch';
import { readImportFile } from '../imports/importFile';
import { exportResultSource, exportTestAssetSource } from './exportImportSource';
import { runSourceExport } from './runSourceExport';

/** 일부 테스트에서 patcher가 "셀을 하나도 고치지 않았다(changedCells 0개)"며 원본 bytes를 돌려주게 바꾼다. 기본은 실제 patcher다. */
const patcherOverride = vi.hoisted(() => ({ current: undefined as ((original: Uint8Array) => { ok: true; bytes: Uint8Array; changedCells: string[] }) | undefined }));
vi.mock('@/lib/ooxml/xlsxPatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ooxml/xlsxPatch')>();
  return { ...actual, patchXlsx: (...args: Parameters<typeof actual.patchXlsx>) => patcherOverride.current?.(args[0]) ?? actual.patchXlsx(...args) };
});
afterEach(() => {
  patcherOverride.current = undefined;
});

/*
 * 가져오기 → 로컬 저장 → (Looma에서 값 변경) → 원본 형식 내보내기 → 다시 읽기 전체 흐름.
 * fixture는 openpyxl로 만든 서식 많은 가상 파일이다(src/lib/ooxml/__fixtures__/style-rich.xlsx).
 */

const FIXTURE_NAME = '고객사_TC.xlsx';
const fixtureBytes = () => new Uint8Array(readFileSync(fileURLToPath(new URL('../../../lib/ooxml/__fixtures__/style-rich.xlsx', import.meta.url))));

async function readTable(bytes: Uint8Array, sheetName: string): Promise<{ table: ImportTable; blob: Blob }> {
  const file = new File([bytes as Uint8Array<ArrayBuffer>], FIXTURE_NAME);
  const read = await readImportFile(file);
  if (!read.ok) throw new Error(read.message);
  const result = read.source.readTable(sheetName);
  if (!result.ok) throw new Error(result.message);
  return { table: result.table, blob: read.source.bytes };
}

async function openRepos(store: StateStore) {
  const repos = createLocalRepositories({ openStore: async () => store });
  await repos.persistence.load();
  return repos;
}

/** Looma에서 값을 바꾼 것처럼 저장된 상태를 고친 뒤 다시 읽는다(지금은 TC · 결과 필드를 직접 고치는 화면이 없다). */
async function editState(store: StateStore, repos: Repositories, edit: (data: AppData) => void) {
  const stored = (await store.read()) as StoredAppState & { data: AppData };
  edit(stored.data);
  await store.commit({ expectedRevision: stored.revision, schemaVersion: stored.schemaVersion, savedAt: 'edit', data: stored.data });
  await repos.persistence.reloadLatest();
}

async function importTestAssets(repos: Repositories, original: Uint8Array = fixtureBytes()) {
  const { table, blob } = await readTable(original, 'TC');
  const mapping = suggestColumnMapping(table.headers);
  const analysis = analyzeTestAssetImport(table, mapping, await repos.testCases.listByProject(PROJECT_A));
  const decisions = analysis.rows.flatMap((item) => (defaultDecisionFor(item) ? [{ rowNumber: item.row.rowNumber, kind: item.kind, targetId: item.targetId, decision: defaultDecisionFor(item)! }] : []));
  const session = await repos.testAssetImports.apply({ projectId: PROJECT_A, fileName: FIXTURE_NAME, table, mapping, decisions, source: { bytes: blob, format: 'xlsx', sheetName: 'TC' } });
  return { original, table, mapping, session };
}

const changedEntries = (a: Uint8Array, b: Uint8Array) => {
  const before = unzipSync(a);
  const after = unzipSync(b);
  return Object.keys(before).filter((path) => !after[path] || after[path].length !== before[path].length || after[path].some((byte, index) => byte !== before[path][index]));
};

describe('TC 원본 형식 내보내기 (가져오기부터 다시 읽기까지)', () => {
  it('Looma에서 바꾼 값만 원본 행에 반영되고, 다시 가져오면 지금 TC와 같다', async () => {
    const store = createMemoryStateStore();
    const repos = await openRepos(store);
    const { original, table, mapping, session } = await importTestAssets(repos);
    expect(session.artifactId).toBeDefined();

    const linked = (await repos.testCases.listByProject(PROJECT_A)).filter((item) => item.importSource?.sessionId === session.id);
    expect(linked).toHaveLength(3);
    const target = linked.find((item) => item.externalId === 'signup-005')!;
    await editState(store, repos, (data) => {
      const testCase = data.testCases.find((item) => item.id === target.id)!;
      testCase.title = '약관 동의 & <필수> 😀';
      testCase.steps = ['약관을 연다.', '전체 동의를 누른다.'];
      testCase.status = 'deprecated';
    });

    const outcome = await exportTestAssetSource(PROJECT_A, session.id, { repos });
    if (!outcome.ok) throw new Error(outcome.problems.join('\n'));
    expect(outcome.fileName).toBe('고객사_TC_Looma.xlsx');
    expect(outcome.changedCells).toEqual(['D4', 'F4']);
    expect(outcome.notices[0]).toMatch(/^이 파일의 행과 연결되지 않은 TC \d+건/);
    expect(changedEntries(original, outcome.bytes)).toEqual(['xl/worksheets/sheet2.xml']);

    // 다시 읽으면 바꾼 두 칸 말고는 가져올 때와 같다.
    const reread = (await readTable(outcome.bytes, 'TC')).table;
    expect(reread.headers).toEqual(table.headers);
    expect(reread.rows.map((row) => row.rowNumber)).toEqual(table.rows.map((row) => row.rowNumber));
    reread.rows.forEach((row, index) => {
      row.cells.forEach((cell, column) => {
        const expected = row.rowNumber === 4 && column === 2 ? '약관 동의 & <필수> 😀' : row.rowNumber === 4 && column === 4 ? '1. 약관을 연다.\n2. 전체 동의를 누른다.' : table.rows[index].cells[column];
        expect(cell, `${row.rowNumber}행 ${table.headers[column]}`).toBe(expected);
      });
    });
    const row4 = parseImportRow(reread.rows.find((row) => row.rowNumber === 4)!, mapping);
    expect(row4).toMatchObject({ title: '약관 동의 & <필수> 😀', steps: ['약관을 연다.', '전체 동의를 누른다.'] });

    // 원본 bytes는 그대로 남아 있다.
    const stillOriginal = await repos.importSources.getBytes(session.artifactId!);
    expect(stillOriginal).toEqual(original);
  });

  it('바뀐 값이 없으면 원본 bytes와 같은 파일을 내보낸다', async () => {
    const repos = await openRepos(createMemoryStateStore());
    const { original, session } = await importTestAssets(repos);
    const outcome = await exportTestAssetSource(PROJECT_A, session.id, { repos });
    if (!outcome.ok) throw new Error(outcome.problems.join('\n'));
    expect(outcome.changedCells).toEqual([]);
    expect(outcome.bytes).toEqual(original);
  });

  it('검증에 실패하면 파일을 만들지 않는다(원본 셀이 이미 다른 값인 경우)', async () => {
    const store = createMemoryStateStore();
    const repos = await openRepos(store);
    const { session } = await importTestAssets(repos);
    await editState(store, repos, (data) => {
      const saved = data.testAssetImports.find((item) => item.id === session.id)!;
      saved.sourceSnapshot!.rows[0].cells[2] = '가져올 때와 다른 값';
      const testCase = data.testCases.find((item) => item.importSource?.sessionId === session.id && item.importSource.rowNumber === 3)!;
      testCase.title = '바뀐 항목';
    });
    const outcome = await exportTestAssetSource(PROJECT_A, session.id, { repos });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.problems[0]).toContain('D3(테스트 항목): 셀 값이 가져올 때와 달라요');
  });

  it('M1 · 만든 파일을 다시 읽은 값이 지금 TC와 다르면(단독 CR이 줄바꿈으로 바뀜) 파일을 내주지 않는다', async () => {
    const store = createMemoryStateStore();
    const repos = await openRepos(store);
    const { session } = await importTestAssets(repos);
    await editState(store, repos, (data) => {
      const testCase = data.testCases.find((item) => item.importSource?.sessionId === session.id && item.importSource.rowNumber === 3)!;
      testCase.title = '바뀐\r제목';
    });
    const outcome = await exportTestAssetSource(PROJECT_A, session.id, { repos });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.problems[0]).toContain('다시 읽어 확인했더니');
    expect(!outcome.ok && outcome.problems.join(' ')).toContain('3행 테스트 항목: 내보낸 파일에 쓰인 값이 계획한 값과 달라요');
  });

  it('별도 XML 검사기가 문제를 알리면 파일을 내주지 않는다', async () => {
    const store = createMemoryStateStore();
    const repos = await openRepos(store);
    const { session } = await importTestAssets(repos);
    await editState(store, repos, (data) => {
      data.testCases.find((item) => item.importSource?.sessionId === session.id && item.importSource.rowNumber === 3)!.title = '바뀐 항목';
    });
    const outcome = await exportTestAssetSource(PROJECT_A, session.id, { repos, validateXml: () => '검사 실패' });
    expect(!outcome.ok && outcome.problems[0]).toContain('검사 실패');
  });

  it('원본 셀이 숫자 · 병합 · 수식이면 그 칸을 바꾸려 할 때 파일을 내주지 않는다(H3 · H4)', async () => {
    const store = createMemoryStateStore();
    const repos = await openRepos(store);
    const { table, mapping, session } = await importTestAssets(repos);
    // 매핑하지 않은 고객사 메모(병합 H4:H5)를 TC 필드로 연결했다고 가정하면 그 칸은 바꿀 수 없다.
    const memo = table.headers.indexOf('고객사 메모');
    await editState(store, repos, (data) => {
      const saved = data.testAssetImports.find((item) => item.id === session.id)!;
      saved.columnMapping = mapping.map((field, index) => (index === memo ? 'precondition' : field === 'precondition' ? null : field));
      data.testCases.find((item) => item.importSource?.sessionId === session.id && item.importSource.rowNumber === 4)!.precondition = '병합 칸에 쓰기';
    });
    const outcome = await exportTestAssetSource(PROJECT_A, session.id, { repos });
    expect(!outcome.ok && outcome.problems.join(' ')).toContain('병합된 셀(H4:H5)');
  });

  it('원본을 보관하지 않은 가져오기는 다른 방식으로 대신 만들지 않는다', async () => {
    const repos = await openRepos(createMemoryStateStore());
    const { table, mapping } = await importTestAssets(repos);
    const withoutSource = await repos.testAssetImports.apply({
      projectId: PROJECT_A,
      fileName: 'no-source.xlsx',
      table: { headers: table.headers, rows: [{ rowNumber: 3, cells: ['new-001', '신규', '원본 없음', '', '1. a', '결과', '', '', '', ''] }] },
      mapping,
      decisions: [{ rowNumber: 3, kind: 'new', decision: 'import' }],
    });
    const outcome = await exportTestAssetSource(PROJECT_A, withoutSource.id, { repos });
    expect(outcome).toEqual({ ok: false, problems: [expect.stringContaining('원본 형식을 유지한 XLSX 내보내기를 사용할 수 없어요.')] });
  });
});

async function importResults(repos: Repositories) {
  const original = fixtureBytes();
  const { table, blob } = await readTable(original, '결과');
  const mapping: ResultColumnMapping = ['externalId', 'title', 'result_android', 'result_ios', null, 'note'];
  const analysis = analyzeResultImport(table, mapping, await repos.testCases.listByProject(PROJECT_A), []);
  // 이 프로젝트에 signup-* TC가 없어 미연결 결과로 가져온다.
  const rowDecisions = analysis.rows.map((item) => ({
    rowNumber: item.row.rowNumber,
    kind: item.kind,
    testCaseId: item.testCaseId,
    decision: defaultResultDecisionFor(item) === 'pending' ? ('import' as const) : defaultResultDecisionFor(item)!,
  }));
  const saved = await repos.testResults.importResults({
    projectId: PROJECT_A,
    fileName: '고객사_수행결과.xlsx',
    table,
    mapping,
    cycle: { round: 3, executionType: 'full', executedFrom: '2026-09-30' },
    rowDecisions,
    valueDecisions: { P: 'pass', F: 'fail' },
    source: { bytes: blob, format: 'xlsx', sheetName: '결과' },
  });
  return { original, saved };
}

describe('수행 결과 원본 형식 내보내기', () => {
  it('결과가 그대로면 원본과 같은 파일, 결과가 바뀌면 원본 표기로 그 칸만 바꾼다', async () => {
    const store = createMemoryStateStore();
    const repos = await openRepos(store);
    const { original, saved } = await importResults(repos);
    expect(saved.resultColumnMapping).toEqual(['externalId', 'title', 'result_android', 'result_ios', null, 'note']);

    const unchanged = await exportResultSource(PROJECT_A, saved.id, { repos });
    expect(unchanged.ok && unchanged.bytes).toEqual(original);

    // 2행 iOS(F)를 pass로 바꾼다. 이 차수에서 pass 표기는 P와 PASS 둘이라 추측하지 않고 멈춘다.
    await editState(store, repos, (data) => {
      const result = data.results.find((item) => item.importId === saved.id && item.sourceRowNumber === 2 && item.platform === 'ios')!;
      result.result = 'pass';
    });
    const ambiguous = await exportResultSource(PROJECT_A, saved.id, { repos });
    expect(!ambiguous.ok && ambiguous.problems[0]).toContain('표기가 여럿');

    // 3행 Android(PASS)를 fail로 바꾸면 이 차수의 fail 표기(F) 하나로 쓴다.
    await editState(store, repos, (data) => {
      for (const result of data.results.filter((item) => item.importId === saved.id)) {
        if (result.sourceRowNumber === 2 && result.platform === 'ios') result.result = 'fail';
        if (result.sourceRowNumber === 3 && result.platform === 'android') result.result = 'fail';
      }
    });
    const changed = await exportResultSource(PROJECT_A, saved.id, { repos });
    if (!changed.ok) throw new Error(changed.problems.join('\n'));
    expect(changed.changedCells).toEqual(['C3']);
    expect(changedEntries(original, changed.bytes)).toEqual(['xl/worksheets/sheet4.xml']);
    const reread = (await readTable(changed.bytes, '결과')).table;
    expect(reread.rows.map((row) => row.cells)).toEqual([
      ['signup-001', '이메일 가입', 'P', 'F', 'P', ''],
      ['signup-005', '약관 동의', 'F', 'P', 'PASS', '재확인'],
    ]);
  });
});

/** 3행 Test Step(F3)의 줄바꿈을 단독 CR(&#13;)로 바꾼 fixture. 가져오기는 단독 CR을 절차 구분으로 보지 않는다. */
function lonelyCrFixture(): Uint8Array {
  const files = unzipSync(fixtureBytes());
  const sheet = strFromU8(files['xl/worksheets/sheet2.xml']);
  const lf = '&#50672;&#45796;.\n2. ';
  expect(sheet).toContain(lf);
  files['xl/worksheets/sheet2.xml'] = strToU8(sheet.replace(lf, '&#50672;&#45796;.&#13;2. '));
  return zipSync(files);
}

/** 압축이 되는 101 bytes 그림 파트. 기록 크기를 3 bytes로 줄이면 fflate unzipSync는 3 bytes로 잘라 돌려준다. */
const IMAGE = new Uint8Array(101).map((_, index) => [0x89, 0x50, 0x4e, 0x47][index % 4]);
function fixtureWithImage(declared?: number): Uint8Array {
  const sizes = declared === undefined ? {} : { uncompressedSize: declared, crc: nodeCrc32(IMAGE.subarray(0, declared)) };
  return rebuildZip(unzipSync(fixtureBytes()), undefined, [{ name: 'xl/media/image1.png', content: IMAGE, local: sizes, central: sizes }]);
}

async function editRow3Title(store: StateStore, repos: Repositories, sessionId: string) {
  await editState(store, repos, (data) => {
    data.testCases.find((item) => item.importSource?.sessionId === sessionId && item.importSource.rowNumber === 3)!.title = '바뀐 항목';
  });
}

describe('ZIP 무결성 (독립 리뷰 재현)', () => {
  it('정상 패키지는 내보내고, 바꾸지 않은 그림 파트를 byte 그대로 유지한다', async () => {
    const store = createMemoryStateStore();
    const repos = await openRepos(store);
    const { session } = await importTestAssets(repos, fixtureWithImage());
    await editRow3Title(store, repos, session.id);
    const outcome = await exportTestAssetSource(PROJECT_A, session.id, { repos });
    if (!outcome.ok) throw new Error(outcome.problems.join('\n'));
    expect(unzipSync(outcome.bytes)['xl/media/image1.png']).toEqual(IMAGE);
  });

  it('실제 DEFLATE 출력(101 bytes)이 기록(3 bytes)보다 크면 파일을 만들지 않고 다운로드도 하지 않는다', async () => {
    const store = createMemoryStateStore();
    const repos = await openRepos(store);
    const malformed = fixtureWithImage(3);
    // 기존 방식(fflate unzipSync)은 그림을 3 bytes로 잘라 정상처럼 돌려준다.
    expect(unzipSync(malformed)['xl/media/image1.png']).toHaveLength(3);
    const { session } = await importTestAssets(repos, malformed);
    await editRow3Title(store, repos, session.id);

    const outcome = await exportTestAssetSource(PROJECT_A, session.id, { repos });
    expect(!outcome.ok && outcome.problems[0]).toContain('압축을 풀면 기록된 크기보다 커요: xl/media/image1.png');
    const download = vi.fn();
    const state = await runSourceExport(() => exportTestAssetSource(PROJECT_A, session.id, { repos }), download);
    expect(state.status).toBe('failed');
    expect(download).not.toHaveBeenCalled();
    expect(await repos.importSources.getBytes(session.artifactId!)).toEqual(malformed);
  });

  /** 'A' 한 글자를 raw DEFLATE stored block으로 담은 파트를 붙인다. 기록(크기 · CRC)은 'A' 기준으로 맞다. */
  const fixtureWithStoredBlock = (deflate: number[]) => rebuildZip(unzipSync(fixtureBytes()), undefined, [{ name: 'xl/media/image1.png', content: strToU8('A'), data: Uint8Array.from(deflate) }]);
  const BAD_NLEN = [0x01, 0x01, 0x00, 0xff, 0xff, 0x41];

  it('독립 리뷰 재현: stored block LEN/NLEN이 맞지 않으면 바꾼 값이 있든 없든 파일을 만들지 않고 다운로드도 하지 않는다', async () => {
    const malformed = fixtureWithStoredBlock(BAD_NLEN);
    expect(() => inflateRawSync(Uint8Array.from(BAD_NLEN))).toThrow('invalid stored block lengths');
    expect(unzipSync(malformed)['xl/media/image1.png']).toEqual(strToU8('A'));
    const problem = 'XLSX(ZIP) 구조가 올바르지 않아 내보낼 수 없어요. (압축 데이터가 손상되었거나 중간에 끊겼어요: xl/media/image1.png)';

    for (const edited of [false, true]) {
      const store = createMemoryStateStore();
      const repos = await openRepos(store);
      const { session } = await importTestAssets(repos, malformed);
      if (edited) await editRow3Title(store, repos, session.id);
      const outcome = await exportTestAssetSource(PROJECT_A, session.id, { repos });
      expect(!outcome.ok && outcome.problems).toEqual([problem]);
      const download = vi.fn();
      const state = await runSourceExport(() => exportTestAssetSource(PROJECT_A, session.id, { repos }), download);
      expect(state.status).toBe('failed');
      expect(download).not.toHaveBeenCalled();
      expect(await repos.importSources.getBytes(session.artifactId!)).toEqual(malformed);
    }
  });

  it('정상 stored block(NLEN=FFFE)은 내보내고 그 파트를 그대로 유지한다', async () => {
    const store = createMemoryStateStore();
    const repos = await openRepos(store);
    const { session } = await importTestAssets(repos, fixtureWithStoredBlock([0x01, 0x01, 0x00, 0xfe, 0xff, 0x41]));
    await editRow3Title(store, repos, session.id);
    const outcome = await exportTestAssetSource(PROJECT_A, session.id, { repos });
    if (!outcome.ok) throw new Error(outcome.problems.join('\n'));
    expect(outcome.changedCells).toHaveLength(1);
    expect(unzipSync(outcome.bytes)['xl/media/image1.png']).toEqual(strToU8('A'));
  });
});

describe('최종 파일 확인 (계획한 변경이 있으면 바꾼 셀이 0개여도 다시 읽는다)', () => {
  it('독립 리뷰 CR 재현: patcher가 단독 CR을 LF와 같다고 보고 셀을 고치지 않아도 원본을 성공으로 내주지 않는다', async () => {
    const store = createMemoryStateStore();
    const repos = await openRepos(store);
    const { original, table, session } = await importTestAssets(repos, lonelyCrFixture());
    const stepsColumn = table.headers.indexOf('Test Step');
    const sourceCell = table.rows.find((row) => row.rowNumber === 3)!.cells[stepsColumn];
    expect(sourceCell).toBe('1. 앱을 연다.\r2. 이메일을 입력한다.');
    const imported = (await repos.testCases.listByProject(PROJECT_A)).find((item) => item.importSource?.sessionId === session.id && item.importSource.rowNumber === 3)!;
    expect(imported.steps).toHaveLength(1);

    await editState(store, repos, (data) => {
      data.testCases.find((item) => item.id === imported.id)!.steps = ['앱을 연다.', '이메일을 입력한다.'];
    });
    // 계획에는 변경이 있지만 patcher는 셀을 하나도 고치지 않는다(상황 B).
    const layout = { sheetName: 'TC', headerRowNumber: 2, headers: table.headers };
    const direct = patchXlsx(original, layout, [{ rowNumber: 3, columnIndex: stepsColumn, previousValue: sourceCell, nextValue: '1. 앱을 연다.\n2. 이메일을 입력한다.', label: 'Test Step' }]);
    expect(direct).toMatchObject({ ok: true, changedCells: [] });

    const outcome = await exportTestAssetSource(PROJECT_A, session.id, { repos });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.problems[0]).toContain('다시 읽어 확인했더니');
    expect(!outcome.ok && outcome.problems.join(' ')).toContain('3행 Test Step: 내보낸 파일에 쓰인 값이 계획한 값과 달라요');
    const download = vi.fn();
    const state = await runSourceExport(() => exportTestAssetSource(PROJECT_A, session.id, { repos }), download);
    expect(state.status).toBe('failed');
    expect(download).not.toHaveBeenCalled();
  });

  it('TC · 수행 결과 모두, 계획한 변경이 있는데 patcher가 원본 bytes(changedCells 0개)를 돌려주면 실패한다', async () => {
    const store = createMemoryStateStore();
    const repos = await openRepos(store);
    const { session } = await importTestAssets(repos);
    const { saved } = await importResults(repos);
    await editRow3Title(store, repos, session.id);
    await editState(store, repos, (data) => {
      data.results.find((item) => item.importId === saved.id && item.sourceRowNumber === 3 && item.platform === 'android')!.result = 'fail';
    });
    patcherOverride.current = (original) => ({ ok: true, bytes: original.slice(), changedCells: [] });

    const tc = await exportTestAssetSource(PROJECT_A, session.id, { repos });
    expect(!tc.ok && tc.problems.join(' ')).toContain('3행 테스트 항목: 내보낸 파일에 쓰인 값이 계획한 값과 달라요');
    const result = await exportResultSource(PROJECT_A, saved.id, { repos });
    expect(!result.ok && result.problems.join(' ')).toContain('내보낸 파일에 쓰인 값이 계획한 값과 달라요');
  });

  it('계획한 변경이 없을 때(원본 그대로 내줄 때)도 내려주기 전에 다시 읽어 확인한다', async () => {
    const store = createMemoryStateStore();
    const repos = await openRepos(store);
    const { mapping, table, session } = await importTestAssets(repos);
    const { saved } = await importResults(repos);
    // 매핑하지 않은 칸의 snapshot이 원본 파일과 어긋나 있으면, 바꿀 셀이 없어도 원본 bytes를 그냥 내주지 않는다.
    const memo = table.headers.indexOf('고객사 메모');
    expect(mapping[memo]).toBeNull();
    expect(saved.resultColumnMapping![4]).toBeNull();
    await editState(store, repos, (data) => {
      data.testAssetImports.find((item) => item.id === session.id)!.sourceSnapshot!.rows[0].cells[memo] = 'snapshot과 원본이 다름';
      data.resultImports.find((item) => item.id === saved.id)!.sourceSnapshot!.rows[0].cells[4] = 'snapshot과 원본이 다름';
    });
    const tc = await exportTestAssetSource(PROJECT_A, session.id, { repos });
    expect(!tc.ok && tc.problems.join(' ')).toContain('고객사 메모: 바꾸지 않은 칸의 값이 달라졌어요');
    const result = await exportResultSource(PROJECT_A, saved.id, { repos });
    expect(!result.ok && result.problems.join(' ')).toContain('바꾸지 않은 칸의 값이 달라졌어요');
  });
});

/* ---------- 신규 TC 새 행 추가 (가져오기부터 다시 가져오기까지) ---------- */

/** openpyxl로 만든 단순 TC 시트(src/lib/ooxml/__fixtures__/make_append_fixtures.py). TC ID MEM-001~003, 2~4행 */
const appendFixtureBytes = (name: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../lib/ooxml/__fixtures__/${name}.xlsx`, import.meta.url))));

/** 예시 데이터 TC가 신규 TC 후보가 되지 않도록 이 프로젝트의 TC를 비운 뒤 fixture를 가져온다. */
async function importAppendFixture(store: StateStore, repos: Repositories, name = 'append-base') {
  await editState(store, repos, (data) => {
    data.testCases = data.testCases.filter((item) => item.projectId !== PROJECT_A);
  });
  return importTestAssets(repos, appendFixtureBytes(name));
}

const loomaCase = (id: string, overrides: Partial<TestCase>): TestCase => ({
  id,
  projectId: PROJECT_A,
  category: 'exception',
  feature: '회원가입',
  depth: ['회원가입', '소셜'],
  title: '카카오 가입 취소 & <확인>',
  precondition: '카카오 앱 설치',
  steps: ['카카오로 시작을 누른다.', '취소를 누른다.'],
  expectedResult: '가입 화면 유지 😀',
  requirementIds: [],
  testConditionIds: [],
  sourceRefs: [],
  generationType: 'ai_suggestion',
  origin: 'ai_generated',
  status: 'reviewed',
  revision: 1,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...overrides,
});

/** Looma에서 만든 TC 넷(TC ID 있는 둘 · TC ID 없는 하나 · 초안 하나)을 더하고, 가져온 2행 TC의 테스트 항목을 바꾼다. */
async function addLoomaCases(store: StateStore, repos: Repositories, sessionId: string) {
  await editState(store, repos, (data) => {
    data.testCases.push(
      loomaCase('tc-looma-1', { externalId: 'MEM-010' }),
      loomaCase('tc-looma-2', { externalId: 'MEM-011', category: 'boundary', title: '닉네임 20자', precondition: undefined, steps: ['20자를 입력한다.'], expectedResult: '저장됨', status: 'active', createdAt: '2026-09-02T00:00:00.000Z' }),
      loomaCase('tc-looma-no-id', { title: 'ID 없는 신규' }),
      loomaCase('tc-looma-draft', { externalId: 'MEM-012', title: '초안', status: 'draft' }),
    );
    data.testCases.find((item) => item.importSource?.sessionId === sessionId && item.importSource.rowNumber === 2)!.title = '이메일로 가입';
  });
}

describe('신규 TC 새 행 추가 내보내기', () => {
  it('기존 행 수정과 신규 행 추가(TC ID 없는 TC 포함)를 한 파일에 하고, 다시 가져오면 모든 행이 지금 TC와 같다', async () => {
    const store = createMemoryStateStore();
    const repos = await openRepos(store);
    const { original, table, mapping, session } = await importAppendFixture(store, repos);
    expect(mapping).toEqual(['externalId', 'category', 'depth1', 'depth2', 'title', 'precondition', 'steps', 'expectedResult', null, null]);
    await addLoomaCases(store, repos, session.id);
    const stateBefore = JSON.stringify(await store.read());

    const outcome = await exportTestAssetSource(PROJECT_A, session.id, { repos, appendNewTestCases: true });
    if (!outcome.ok) throw new Error(outcome.problems.join('\n'));
    expect(outcome.changedCells).toEqual(['E2']);
    // 같은 시각에 만든 TC는 내부 ID 순서로 놓는다(tc-looma-1 → tc-looma-no-id → tc-looma-2).
    expect(outcome.appendedRows).toEqual([
      { rowNumber: 5, label: 'MEM-010 · 카카오 가입 취소 & <확인>' },
      { rowNumber: 6, label: 'TC ID 없음 · ID 없는 신규' },
      { rowNumber: 7, label: 'MEM-011 · 닉네임 20자' },
    ]);
    // 상태 정책은 그대로다: 초안은 넣지 않는다. TC ID가 없는 것은 넣지 못한 이유가 아니다.
    expect(outcome.skipped.map(({ entityId }) => entityId)).toEqual(['tc-looma-draft']);
    expect(outcome.skipped[0].reason).toContain('검토를 마치지 않은 TC예요(초안)');
    expect(outcome.notices).toEqual(['고객사 TC ID가 없는 신규 TC 1건은 TC ID 칸을 비운 채 추가했어요. Looma는 고객사 TC ID를 만들지 않아요.']);
    expect(changedEntries(original, outcome.bytes)).toEqual(['xl/worksheets/sheet2.xml']);
    const sheetXml = strFromU8(unzipSync(outcome.bytes)['xl/worksheets/sheet2.xml']);
    expect(sheetXml).toContain('<dimension ref="A1:J7"/>');
    expect(sheetXml).toContain('<row r="5" ht="36" customHeight="1"><c r="A5" s="2" t="inlineStr">');
    // TC ID 없는 행의 ID 칸은 값 없이 스타일만 있는 셀이다.
    expect(sheetXml).toContain('<row r="6" ht="36" customHeight="1"><c r="A6" s="2"/><c r="B6" s="2" t="inlineStr">');
    // 고객사 TC ID를 만들지 않았고 Looma 내부 ID는 어느 파트에도 쓰지 않았다.
    const allParts = Object.values(unzipSync(outcome.bytes)).map((bytes) => strFromU8(bytes)).join('\n');
    expect(allParts).not.toContain('tc-looma');
    expect(allParts).not.toContain('MEM-012');

    // 가져오기와 같은 reader로 다시 읽으면 기존 행은 바꾼 칸만 다르고 새 행은 열마다 TC 값이 있다.
    const reread = (await readTable(outcome.bytes, 'TC')).table;
    expect(reread.headers).toEqual(table.headers);
    expect(reread.rows.map((row) => row.rowNumber)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(reread.rows[0].cells).toEqual(table.rows[0].cells.map((cell, index) => (index === 4 ? '이메일로 가입' : cell)));
    expect(reread.rows.slice(1, 3)).toEqual(table.rows.slice(1, 3));
    expect(reread.rows[3].cells).toEqual(['MEM-010', '예외', '회원가입', '소셜', '카카오 가입 취소 & <확인>', '카카오 앱 설치', '1. 카카오로 시작을 누른다.\n2. 취소를 누른다.', '가입 화면 유지 😀', '', '']);
    expect(reread.rows[4].cells).toEqual(['', '예외', '회원가입', '소셜', 'ID 없는 신규', '카카오 앱 설치', '1. 카카오로 시작을 누른다.\n2. 취소를 누른다.', '가입 화면 유지 😀', '', '']);
    expect(reread.rows[5].cells).toEqual(['MEM-011', '경계값', '회원가입', '소셜', '닉네임 20자', '', '1. 20자를 입력한다.', '저장됨', '', '']);

    // 내보낸 파일을 다시 가져오면 오류 행 없이 기존 행 · 새 행 모두 지금 TC와 내용이 같다고 판정된다.
    // TC ID 없는 행은 내용(기능 · 테스트 항목 · Pre-condition · Expected Result)으로 같은 TC를 찾는다.
    const analysis = analyzeTestAssetImport(reread, mapping, await repos.testCases.listByProject(PROJECT_A));
    expect(analysis.fileProblems).toEqual([]);
    expect(analysis.rows.flatMap((item) => item.issues.filter((issue) => issue.level === 'error'))).toEqual([]);
    expect(analysis.rows.map((item) => [item.row.rowNumber, item.kind, item.targetId?.startsWith('tc-looma') ? item.targetId : 'imported'])).toEqual([
      [2, 'exact_match', 'imported'],
      [3, 'exact_match', 'imported'],
      [4, 'exact_match', 'imported'],
      [5, 'exact_match', 'tc-looma-1'],
      [6, 'exact_match', 'tc-looma-no-id'],
      [7, 'exact_match', 'tc-looma-2'],
    ]);

    // 내보내기는 저장 상태 · 원본 bytes를 바꾸지 않는다.
    expect(JSON.stringify(await store.read())).toBe(stateBefore);
    expect(await repos.importSources.getBytes(session.artifactId!)).toEqual(original);
  });

  it('요청하지 않으면 신규 TC가 있어도 이전과 같이 기존 행만 다루고, 바뀐 값이 없으면 원본과 같은 파일이다', async () => {
    const store = createMemoryStateStore();
    const repos = await openRepos(store);
    const { original, session } = await importAppendFixture(store, repos);
    await editState(store, repos, (data) => {
      data.testCases.push(loomaCase('tc-looma-1', { externalId: 'MEM-010' }));
    });
    const outcome = await exportTestAssetSource(PROJECT_A, session.id, { repos });
    if (!outcome.ok) throw new Error(outcome.problems.join('\n'));
    expect(outcome).toMatchObject({ changedCells: [], appendedRows: [], skipped: [], notices: ['이 파일의 행과 연결되지 않은 TC 1건(신규 TC 등)은 포함되지 않아요.'] });
    expect(outcome.bytes).toEqual(original);
  });

  it('Excel 표가 있는 시트는 기존 행만 고친 파일을 만들고, 신규 TC는 이유와 함께 넣지 않은 TC로 알린다', async () => {
    const store = createMemoryStateStore();
    const repos = await openRepos(store);
    const { session } = await importAppendFixture(store, repos, 'append-table');
    await addLoomaCases(store, repos, session.id);
    const outcome = await exportTestAssetSource(PROJECT_A, session.id, { repos, appendNewTestCases: true });
    if (!outcome.ok) throw new Error(outcome.problems.join('\n'));
    expect(outcome.changedCells).toEqual(['E2']);
    expect(outcome.appendedRows).toEqual([]);
    // 붙이지 못했으므로 TC ID 칸을 비운 행 안내도 없다.
    expect(outcome.notices).toEqual([]);
    const blocked = outcome.skipped.filter((item) => item.entityId !== 'tc-looma-draft');
    expect(blocked.map((item) => item.entityId)).toEqual(['tc-looma-1', 'tc-looma-no-id', 'tc-looma-2']);
    for (const item of blocked) expect(item.reason).toContain('tableParts');
    const reread = (await readTable(outcome.bytes, 'TC')).table;
    expect(reread.rows.map((row) => row.rowNumber)).toEqual([2, 3, 4]);
    expect(strFromU8(unzipSync(outcome.bytes)['xl/tables/table1.xml'])).toContain('ref="A1:J4"');
  });

  it('신규 TC는 사용자가 내보내기를 실행한 가져오기 파일에만 붙고, 더 이전 가져오기에서도 붙일 수 있다', async () => {
    const store = createMemoryStateStore();
    const repos = await openRepos(store);
    // 고객사 파일 둘: 먼저 가져온 A(append-base), 나중에 가져온 B(append-second)
    const a = await importAppendFixture(store, repos);
    const b = await importTestAssets(repos, appendFixtureBytes('append-second'));
    await editState(store, repos, (data) => {
      data.testCases.push(loomaCase('tc-looma-1', { externalId: 'MEM-010' }), loomaCase('tc-looma-no-id', { title: 'ID 없는 신규' }));
    });
    const stateBefore = JSON.stringify(await store.read());

    // 더 이전에 가져온 A에서 직접 내보내면 A의 표 끝에 붙는다.
    const fromA = await exportTestAssetSource(PROJECT_A, a.session.id, { repos, appendNewTestCases: true });
    if (!fromA.ok) throw new Error(fromA.problems.join('\n'));
    expect(fromA.appendedRows.map((row) => row.rowNumber)).toEqual([5, 6]);
    expect(fromA.skipped).toEqual([]);
    const rereadA = (await readTable(fromA.bytes, 'TC')).table;
    expect(rereadA.rows.map((row) => row.cells[0])).toEqual(['MEM-001', 'MEM-002', 'MEM-003', 'MEM-010', '']);
    expect(rereadA.rows.some((row) => row.cells[0].startsWith('ACC-'))).toBe(false);

    // 선택하지 않은 B에는 자동으로 나누어 넣지 않는다. B의 원본과 B에서 옵션 없이 내보낸 파일은 그대로다.
    expect(await repos.importSources.getBytes(b.session.artifactId!)).toEqual(b.original);
    const fromBPlain = await exportTestAssetSource(PROJECT_A, b.session.id, { repos });
    if (!fromBPlain.ok) throw new Error(fromBPlain.problems.join('\n'));
    expect(fromBPlain.appendedRows).toEqual([]);
    expect(fromBPlain.bytes).toEqual(b.original);

    // B에서 사용자가 직접 켜고 내보내면 B의 표 끝에만 붙는다(A 원본은 그대로).
    const fromB = await exportTestAssetSource(PROJECT_A, b.session.id, { repos, appendNewTestCases: true });
    if (!fromB.ok) throw new Error(fromB.problems.join('\n'));
    const rereadB = (await readTable(fromB.bytes, 'TC')).table;
    expect(rereadB.rows.map((row) => row.cells[0])).toEqual(['ACC-001', 'ACC-002', 'ACC-003', 'MEM-010', '']);
    expect(await repos.importSources.getBytes(a.session.artifactId!)).toEqual(a.original);
    expect(JSON.stringify(await store.read())).toBe(stateBefore);
  });

  it('내보내기가 실패해도 저장된 TC · 가져오기 기록 · 원본 bytes는 그대로다', async () => {
    const store = createMemoryStateStore();
    const repos = await openRepos(store);
    const { original, session } = await importAppendFixture(store, repos);
    await addLoomaCases(store, repos, session.id);
    await editState(store, repos, (data) => {
      // 원본 셀(E2)이 가져올 때 기록과 달라 기존 행 patch가 멈추는 상황
      data.testAssetImports.find((item) => item.id === session.id)!.sourceSnapshot!.rows[0].cells[4] = '가져올 때와 다른 값';
    });
    const stateBefore = JSON.stringify(await store.read());
    const outcome = await exportTestAssetSource(PROJECT_A, session.id, { repos, appendNewTestCases: true });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.problems[0]).toContain('E2(테스트 항목): 셀 값이 가져올 때와 달라요');
    expect(JSON.stringify(await store.read())).toBe(stateBefore);
    expect(await repos.importSources.getBytes(session.artifactId!)).toEqual(original);
  });

  it('새 행을 다시 읽은 값이 계획과 다르면 파일을 내주지 않는다', async () => {
    const store = createMemoryStateStore();
    const repos = await openRepos(store);
    const { session } = await importAppendFixture(store, repos);
    await editState(store, repos, (data) => {
      data.testCases.push(loomaCase('tc-looma-1', { externalId: 'MEM-010' }));
    });
    // patcher가 새 행 값을 다르게 쓴 것처럼 바꿔, 다시 읽기 확인이 잡는지 본다.
    patcherOverride.current = (bytes) => {
      const files = unzipSync(bytes);
      const xml = strFromU8(files['xl/worksheets/sheet2.xml']).replace('</sheetData>', '<row r="5"><c r="A5" t="inlineStr"><is><t>MEM-999</t></is></c></row></sheetData>');
      files['xl/worksheets/sheet2.xml'] = strToU8(xml);
      return { ok: true, bytes: zipSync(files), changedCells: [] };
    };
    const outcome = await exportTestAssetSource(PROJECT_A, session.id, { repos, appendNewTestCases: true });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.problems.join(' ')).toContain('5행 TC ID: 새 행에 쓰인 값이 계획한 값과 달라요');
  });
});

/* ---------- Codex 리뷰 M1 · M2 (실제 파일 → 기존 reader → 다시 가져오기 분석) ---------- */

describe('신규 TC 새 행 추가 · 독립 리뷰 지적 회귀', () => {
  it('M1: Pre-condition 열을 매핑하지 않은 파일에서는 파일에 쓰일 값으로 그 TC를 정확히 다시 찾을 수 있는 TC만 넣는다', async () => {
    const store = createMemoryStateStore();
    const repos = await openRepos(store);
    await editState(store, repos, (data) => {
      data.testCases = data.testCases.filter((item) => item.projectId !== PROJECT_A);
    });
    // append-base를 Pre-condition 열 없이(매핑하지 않고) 가져온다.
    const original = appendFixtureBytes('append-base');
    const { table, blob } = await readTable(original, 'TC');
    const mapping = suggestColumnMapping(table.headers).map((field) => (field === 'precondition' ? null : field));
    const analysis = analyzeTestAssetImport(table, mapping, []);
    const decisions = analysis.rows.map((item) => ({ rowNumber: item.row.rowNumber, kind: item.kind, targetId: item.targetId, decision: defaultDecisionFor(item)! }));
    const session = await repos.testAssetImports.apply({ projectId: PROJECT_A, fileName: FIXTURE_NAME, table, mapping, decisions, source: { bytes: blob, format: 'xlsx', sheetName: 'TC' } });

    const login = (id: string, overrides: Partial<TestCase>) =>
      loomaCase(id, { category: 'normal_flow', feature: '로그인', depth: ['로그인', '이메일'], title: '로그인 성공', precondition: undefined, steps: ['로그인한다.'], expectedResult: '홈 이동', ...overrides });
    await editState(store, repos, (data) => {
      data.testCases.push(
        // Codex 재현: Pre-condition만 다른 TC ID 없는 TC 둘 → 파일에는 같은 행으로 쓰인다.
        login('tc-pre-a', { precondition: '조건 A' }),
        login('tc-pre-b', { precondition: '조건 B' }),
        // 매핑한 열만으로 유일한 TC ID 없는 TC
        login('tc-unique', { title: '로그인 실패', expectedResult: '오류 안내' }),
        // 같은 내용이어도 TC ID가 있으면 ID로 구별된다.
        login('tc-with-id', { externalId: 'MEM-020', precondition: '조건 A' }),
      );
    });
    const stateBefore = JSON.stringify(await store.read());

    const outcome = await exportTestAssetSource(PROJECT_A, session.id, { repos, appendNewTestCases: true });
    if (!outcome.ok) throw new Error(outcome.problems.join('\n'));
    expect(outcome.appendedRows).toEqual([
      { rowNumber: 5, label: 'TC ID 없음 · 로그인 실패' },
      { rowNumber: 6, label: 'MEM-020 · 로그인 성공' },
    ]);
    expect(outcome.skipped.map(({ entityId, reason }) => [entityId, reason.includes('매핑한 열')])).toEqual([
      ['tc-pre-a', true],
      ['tc-pre-b', true],
    ]);
    const allParts = Object.values(unzipSync(outcome.bytes)).map((bytes) => strFromU8(bytes)).join('\n');
    expect(allParts).not.toMatch(/tc-(pre|unique|with)/);

    // 내보낸 파일 → 기존 reader → 다시 가져오기 분석: 붙인 행은 모두 그 TC와 exact_match, 오류 행 없음
    const reread = (await readTable(outcome.bytes, 'TC')).table;
    expect(reread.rows.slice(3).map((row) => [row.rowNumber, row.cells[0], row.cells[4], row.cells[5]])).toEqual([
      [5, '', '로그인 실패', ''],
      [6, 'MEM-020', '로그인 성공', ''],
    ]);
    const again = analyzeTestAssetImport(reread, mapping, await repos.testCases.listByProject(PROJECT_A));
    expect(again.rows.flatMap((item) => item.issues.filter((issue) => issue.level === 'error'))).toEqual([]);
    expect(again.rows.slice(3).map((item) => [item.row.rowNumber, item.kind, item.targetId])).toEqual([
      [5, 'exact_match', 'tc-unique'],
      [6, 'exact_match', 'tc-with-id'],
    ]);
    expect(JSON.stringify(await store.read())).toBe(stateBefore);
    expect(await repos.importSources.getBytes(session.artifactId!)).toEqual(original);
  });

  it('M2: 마지막 TC 행이 1,048,576이면 신규 TC를 넣지 않고 기존 행 수정만 한 파일을 만들며, 화면 결과 수가 파일과 같다', async () => {
    const store = createMemoryStateStore();
    const repos = await openRepos(store);
    // append-base의 행을 내려 헤더 1,048,573행 · TC 1,048,574~1,048,576행으로 만든다.
    const offset = 1048572;
    const files = unzipSync(appendFixtureBytes('append-base'));
    files['xl/worksheets/sheet2.xml'] = strToU8(
      strFromU8(files['xl/worksheets/sheet2.xml'])
        .replace(/<row r="(\d+)"/g, (_, row: string) => `<row r="${Number(row) + offset}"`)
        .replace(/<c r="([A-Z]+)(\d+)"/g, (_, column: string, row: string) => `<c r="${column}${Number(row) + offset}"`)
        .replace('<dimension ref="A1:J4"/>', `<dimension ref="A${1 + offset}:J${4 + offset}"/>`),
    );
    await editState(store, repos, (data) => {
      data.testCases = data.testCases.filter((item) => item.projectId !== PROJECT_A);
    });
    const { original, session } = await importTestAssets(repos, zipSync(files));
    expect(session.sourceSnapshot!.rows.map((row) => row.rowNumber)).toEqual([1048574, 1048575, 1048576]);
    await editState(store, repos, (data) => {
      data.testCases.push(loomaCase('tc-looma-1', { externalId: 'MEM-010' }));
      data.testCases.find((item) => item.importSource?.sessionId === session.id && item.importSource.rowNumber === 1048574)!.title = '이메일로 가입';
    });

    const download = vi.fn();
    const state = await runSourceExport(() => exportTestAssetSource(PROJECT_A, session.id, { repos, appendNewTestCases: true }), download);
    expect(state).toEqual({
      status: 'done',
      message: '고객사_TC_Looma.xlsx · 셀 1개에 현재 값을 반영했어요.',
      notices: [],
      rows: {
        updatedRows: 1,
        appendedRows: 0,
        skipped: [{ entityId: 'tc-looma-1', label: 'MEM-010 · 카카오 가입 취소 & <확인>', reason: '새 행(1048577~1048577행)이 Excel 시트의 최대 행(1,048,576행)을 넘어 추가할 수 없어요.' }],
      },
    });
    // 내려받은 파일: 기존 행만 바뀌고, 최대 행을 넘는 행 · dimension은 없다.
    const bytes: Uint8Array = download.mock.calls[0][0];
    const sheetXml = strFromU8(unzipSync(bytes)['xl/worksheets/sheet2.xml']);
    expect(sheetXml).toContain(`<dimension ref="A${1 + offset}:J${4 + offset}"/>`);
    expect(sheetXml).not.toContain('1048577');
    const reread = (await readTable(bytes, 'TC')).table;
    expect(reread.rows.map((row) => [row.rowNumber, row.cells[4]])).toEqual([
      [1048574, '이메일로 가입'],
      [1048575, '약관 미동의 & <필수>'],
      [1048576, '비밀번호 8자'],
    ]);
    expect(await repos.importSources.getBytes(session.artifactId!)).toEqual(original);
  });
});
