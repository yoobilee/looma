/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { createLocalRepositories } from '@/data/local/localRepositories';
import { createMemoryStateStore, type StateStore } from '@/data/local/stateStore';
import type { AppData, StoredAppState } from '@/data/local/appData';
import type { Repositories } from '@/data/repositories/types';
import { PROJECT_A } from '@/data/mock/seed';
import { analyzeTestAssetImport, defaultDecisionFor, parseImportRow, suggestColumnMapping, type ImportTable } from '@/domain/testAssetImport';
import { analyzeResultImport, defaultResultDecisionFor, type ResultColumnMapping } from '@/domain/testResultImport';
import { readImportFile } from '../imports/importFile';
import { exportResultSource, exportTestAssetSource } from './exportImportSource';

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

async function importTestAssets(repos: Repositories) {
  const original = fixtureBytes();
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

describe('수행 결과 원본 형식 내보내기', () => {
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
