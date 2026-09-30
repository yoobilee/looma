import { describe, expect, it } from 'vitest';
import { toImportTable, type ImportTable } from '@/domain/testAssetImport';
import {
  analyzeResultImport,
  defaultResultDecisionFor,
  suggestNextRound,
  suggestResultColumnMapping,
  type ResultColumnMapping,
  type ResultCycleInput,
  type ResultImportRowDecision,
  type ResultRowDecision,
  type ResultValueDecision,
} from '@/domain/testResultImport';
import { parseCsv } from '@/lib/csv';
import { createMockRepositories } from './mockRepositories';
import { createSeed, PROJECT_A, PROJECT_B, type SeedData } from './seed';

const HEADERS = ['TC ID', '테스트 항목', '결과', '비고'];

/** 모든 셀을 따옴표로 감싼 CSV. 실제 파일과 같은 parser 경로를 거친다. */
function csv(headers: string[], rows: string[][]): string {
  return [headers, ...rows].map((cells) => cells.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(',')).join('\r\n');
}

const cycle = (overrides: Partial<ResultCycleInput> = {}): ResultCycleInput => ({ round: 3, executionType: 'full', executedFrom: '2026-09-28', ...overrides });

async function setup(seed: SeedData = createSeed()) {
  const before = structuredClone(seed);
  const repos = createMockRepositories(seed);
  const load = async () => {
    const imports = await repos.testResults.listImports(PROJECT_A);
    const resultsByImport = Object.fromEntries(await Promise.all(imports.map(async (item) => [item.id, await repos.testResults.listResults(item.id)] as const)));
    return {
      imports,
      resultsByImport,
      testCases: await repos.testCases.listByProject(PROJECT_A),
      activities: await repos.activities.list({ projectId: PROJECT_A }),
    };
  };

  /** 화면과 같은 순서로 파일을 읽고 미리보기를 계산한다. */
  const preview = async (rows: string[][], options: { headers?: string[]; mapping?: ResultColumnMapping } = {}) => {
    const table = toImportTable(parseCsv(csv(options.headers ?? HEADERS, rows))) as ImportTable;
    const mapping = options.mapping ?? suggestResultColumnMapping(table.headers);
    const project = (await repos.projects.get(PROJECT_A))!;
    const templateMappings = project.tcTemplateId ? ((await repos.templates.get(project.tcTemplateId))?.resultMappings ?? []) : [];
    const analysis = analyzeResultImport(table, mapping, await repos.testCases.listByProject(PROJECT_A), templateMappings);
    const decisions = (overrides: Record<number, ResultRowDecision> = {}): ResultImportRowDecision[] =>
      analysis.rows
        .filter((item) => defaultResultDecisionFor(item) || overrides[item.row.rowNumber])
        .map((item) => ({ rowNumber: item.row.rowNumber, kind: item.kind, testCaseId: item.testCaseId, decision: overrides[item.row.rowNumber] ?? defaultResultDecisionFor(item)! }));
    const apply = (
      input: { rows?: Record<number, ResultRowDecision>; values?: Record<string, ResultValueDecision>; cycle?: ResultCycleInput; rowDecisions?: ResultImportRowDecision[] } = {},
    ) =>
      repos.testResults.importResults({
        projectId: PROJECT_A,
        fileName: '고객사A_TC_수행결과_3차.csv',
        table,
        mapping,
        cycle: input.cycle ?? cycle(),
        rowDecisions: input.rowDecisions ?? decisions(input.rows),
        valueDecisions: input.values ?? {},
      });
    return { table, mapping, analysis, decisions, apply };
  };

  return { seed, before, repos, load, preview };
}

const resultsOf = async (repos: ReturnType<typeof createMockRepositories>, importId: string) => repos.testResults.listResults(importId);

describe('연결된 결과 가져오기', () => {
  it('고객사 TC ID가 정확히 같은 TC에 연결하고 원문 · 행 번호 · 비고를 보존한다', async () => {
    const { repos, preview } = await setup();
    const { analysis, apply } = await preview([
      ['SIGN-001', '유효한 비밀번호 입력 시 가입 가능', 'P', ''],
      ['SIGN-002', '최소 길이 8자 입력', 'F', 'iOS 문구 상이'],
    ]);
    expect(analysis.rows.map((item) => [item.kind, item.testCaseId])).toEqual([
      ['matched', 'tc-001'],
      ['matched', 'tc-002'],
    ]);

    const saved = await apply();
    const results = await resultsOf(repos, saved.id);
    expect(results).toEqual([
      {
        id: expect.any(String),
        importId: saved.id,
        testCaseId: 'tc-001',
        externalId: 'SIGN-001',
        feature: '회원가입',
        title: '유효한 비밀번호 입력 시 가입 가능',
        result: 'pass',
        rawResult: 'P',
        sourceRowNumber: 2,
      },
      {
        id: expect.any(String),
        importId: saved.id,
        testCaseId: 'tc-002',
        externalId: 'SIGN-002',
        feature: '회원가입',
        title: '최소 길이 8자 입력',
        result: 'fail',
        rawResult: 'F',
        sourceRowNumber: 3,
        note: 'iOS 문구 상이',
      },
    ]);
  });

  it('새 차수 기록을 만들고 쓴 상태값 매핑과 차수 정보를 남긴다', async () => {
    const { load, preview } = await setup();
    const { apply } = await preview([
      ['SIGN-001', '', 'P', ''],
      ['SIGN-002', '', 'F', ''],
      ['SIGN-003', '', 'P', ''],
    ]);
    const saved = await apply({ cycle: cycle({ executionType: 'retest', executedTo: '2026-09-29', environment: ' STG ', note: '회귀 확인' }) });
    expect(saved).toEqual({
      id: expect.any(String),
      projectId: PROJECT_A,
      round: 3,
      fileRef: '고객사A_TC_수행결과_3차.csv',
      importedAt: expect.any(String),
      mapping: [
        { rawValue: 'P', result: 'pass' },
        { rawValue: 'F', result: 'fail' },
      ],
      executionType: 'retest',
      executedFrom: '2026-09-28',
      executedTo: '2026-09-29',
      environment: 'STG',
      note: '회귀 확인',
    });
    const { imports } = await load();
    expect(imports.map((item) => item.round)).toEqual([1, 2, 3]);
  });

  it('활동에 차수 · 유형과 결과 요약을 남긴다', async () => {
    const { load, preview } = await setup();
    const { apply } = await preview([
      ['SIGN-001', '', 'P', ''],
      ['SIGN-002', '', 'F', ''],
      ['SIGN-003', '', 'B', ''],
      ['SIGN-004', '', 'N/T', ''],
      ['NEW-404', '없는 TC', 'P', ''],
    ]);
    await apply({ rows: { 6: 'import' } });
    expect((await load()).activities[0]).toMatchObject({
      type: 'results_uploaded',
      title: '3차 전체 수행 결과 가져오기',
      metadata: { detail: '총 5 · PASS 2 · FAIL 1 · BLOCKED 1 · 미수행 1 · 미연결 1' },
    });
  });

  it('같은 TC의 결과는 차수마다 따로 쌓이고 이전 차수 결과는 그대로다', async () => {
    const { repos, before, preview } = await setup();
    const saved = await (await preview([['SIGN-002', '', 'P', '']])).apply();
    expect((await resultsOf(repos, saved.id)).map((item) => [item.testCaseId, item.result])).toEqual([['tc-002', 'pass']]);
    for (const importId of ['imp-a-1', 'imp-a-2']) {
      expect(await resultsOf(repos, importId)).toEqual(before.results.filter((item) => item.importId === importId));
    }
  });
});

describe('미연결 결과', () => {
  it('일치하는 TC가 없으면 판단이 필요하고, 보존하면 원문을 그대로 남긴 미연결 결과가 된다', async () => {
    const { repos, load, before, preview } = await setup();
    const { analysis, apply } = await preview([['NEW-404', '신규 기능 확인', '성공', '신규 화면']]);
    expect(analysis.rows[0]).toMatchObject({ kind: 'unmatched', candidateIds: [] });
    await expect(apply()).rejects.toThrow('판단하지 않은 행이 1건');

    const saved = await apply({ rows: { 2: 'import' } });
    expect(await resultsOf(repos, saved.id)).toEqual([
      {
        id: expect.any(String),
        importId: saved.id,
        externalId: 'NEW-404',
        feature: '미연결',
        title: '신규 기능 확인',
        result: 'pass',
        rawResult: '성공',
        sourceRowNumber: 2,
        note: '신규 화면',
      },
    ]);
    // 미연결 결과로 새 TC를 만들지 않는다.
    expect((await load()).testCases).toEqual(before.testCases.filter((item) => item.projectId === PROJECT_A));
  });

  it('고객사 TC ID 없이 제목만 같아도 TC에 연결하지 않는다', async () => {
    const { repos, preview } = await setup();
    const { analysis, apply } = await preview([['', '유효한 비밀번호 입력 시 가입 가능', 'P', '']]);
    expect(analysis.rows[0].kind).toBe('unmatched');
    expect(analysis.rows[0].testCaseId).toBeUndefined();
    expect(analysis.rows[0].issues).toEqual([{ level: 'warning', message: '고객사 TC ID가 비어 있어요. 제목만으로는 TC에 연결하지 않아요.' }]);
    const saved = await apply({ rows: { 2: 'import' } });
    const [result] = await resultsOf(repos, saved.id);
    expect(result.testCaseId).toBeUndefined();
    expect('externalId' in result).toBe(false);
  });

  it('파일의 기능 컬럼이 있으면 미연결 결과의 기능으로 쓰고, 연결된 결과는 TC의 기능을 쓴다', async () => {
    const { repos, preview } = await setup();
    const { apply } = await preview(
      [
        ['NEW-404', '마이페이지', '프로필 저장', 'PASS'],
        ['SIGN-001', '다른 기능명', '', 'PASS'],
      ],
      { headers: ['TC ID', '기능', '테스트 항목', '결과'] },
    );
    const saved = await apply({ rows: { 2: 'import' } });
    expect((await resultsOf(repos, saved.id)).map((item) => item.feature)).toEqual(['마이페이지', '회원가입']);
  });
});

describe('충돌', () => {
  it('같은 고객사 TC ID를 쓰는 TC가 여럿이면 충돌이고, 가져오면 어느 TC에도 붙이지 않는다', async () => {
    const seed = createSeed();
    seed.testCases.find((item) => item.id === 'tc-002')!.externalId = 'SIGN-001';
    const { repos, preview } = await setup(seed);
    const { analysis, apply } = await preview([['SIGN-001', '', 'P', '']]);
    expect(analysis.rows[0]).toMatchObject({ kind: 'conflict', conflictReason: 'ambiguous_external_id', candidateIds: ['tc-001', 'tc-002'] });
    await expect(apply()).rejects.toThrow('판단하지 않은 행이 1건');
    const saved = await apply({ rows: { 2: 'import' } });
    const [result] = await resultsOf(repos, saved.id);
    expect(result.testCaseId).toBeUndefined();
    expect(result.externalId).toBe('SIGN-001');
  });

  it('파일 안에서 같은 TC 결과가 겹치면 모두 충돌이고, 마지막 행으로 덮어쓰지 않는다', async () => {
    const { repos, preview } = await setup();
    const { analysis, apply } = await preview([
      ['SIGN-001', '', 'P', ''],
      ['SIGN-001', '', 'F', ''],
    ]);
    expect(analysis.rows.map((item) => [item.kind, item.conflictReason, item.testCaseId])).toEqual([
      ['conflict', 'duplicate_in_file', 'tc-001'],
      ['conflict', 'duplicate_in_file', 'tc-001'],
    ]);
    await expect(apply()).rejects.toThrow('판단하지 않은 행이 2건');
    await expect(apply({ rows: { 2: 'import', 3: 'import' } })).rejects.toThrow('3행: 2행과 같은 TC · 플랫폼 결과를 함께 가져올 수 없어요');

    const saved = await apply({ rows: { 2: 'excluded', 3: 'import' } });
    expect((await resultsOf(repos, saved.id)).map((item) => [item.testCaseId, item.result, item.sourceRowNumber])).toEqual([['tc-001', 'fail', 3]]);
  });

  it('플랫폼이 다르면 같은 TC라도 중복이 아니다', async () => {
    const { preview } = await setup();
    const { analysis } = await preview(
      [
        ['SIGN-001', 'Android', 'P'],
        ['SIGN-001', 'iOS', 'F'],
        ['SIGN-001', 'AOS', 'F'],
      ],
      { headers: ['TC ID', '플랫폼', '결과'] },
    );
    expect(analysis.rows.map((item) => item.kind)).toEqual(['conflict', 'matched', 'conflict']);
  });
});

describe('결과 값 정규화', () => {
  it('템플릿 매핑과 기본 표기(대소문자 무시)로 PASS · FAIL · BLOCKED · 미수행을 정한다', async () => {
    const { repos, preview } = await setup();
    const values = ['P', 'Pass', '성공', '정상', 'F', 'fail', '실패', 'NG', 'B', 'Block', '차단', '진행불가', 'N/T', 'not tested', 'NOT_TESTED', '미수행', '미실행'];
    const ids = ['SIGN', 'LOGIN', 'PW'].flatMap((code) => [1, 2, 3, 4, 5, 6, 7].map((index) => `${code}-${String(index).padStart(3, '0')}`));
    const { analysis, apply } = await preview(values.map((value, index) => [ids[index], '', value, '']));
    expect(analysis.unknownValues).toEqual([]);
    const saved = await apply({ rows: Object.fromEntries(analysis.rows.filter((item) => item.kind !== 'matched').map((item) => [item.row.rowNumber, 'import'])) });
    const results = await resultsOf(repos, saved.id);
    expect(results.map((item) => [item.rawResult, item.result])).toEqual([
      ['P', 'pass'],
      ['Pass', 'pass'],
      ['성공', 'pass'],
      ['정상', 'pass'],
      ['F', 'fail'],
      ['fail', 'fail'],
      ['실패', 'fail'],
      ['NG', 'fail'],
      ['B', 'blocked'],
      ['Block', 'blocked'],
      ['차단', 'blocked'],
      ['진행불가', 'blocked'],
      ['N/T', 'not_tested'],
      ['not tested', 'not_tested'],
      ['NOT_TESTED', 'not_tested'],
      ['미수행', 'not_tested'],
      ['미실행', 'not_tested'],
    ]);
  });

  it('프로젝트 템플릿 매핑이 기본 표기보다 우선한다', async () => {
    const seed = createSeed();
    seed.templates[0].resultMappings = [...seed.templates[0].resultMappings, { rawValue: 'NG', result: 'blocked' }];
    const { repos, preview } = await setup(seed);
    const saved = await (await preview([['SIGN-001', '', 'NG', '']])).apply();
    const [result] = await resultsOf(repos, saved.id);
    expect(result).toMatchObject({ rawResult: 'NG', result: 'blocked' });
    expect(saved.mapping).toEqual([{ rawValue: 'NG', result: 'blocked' }]);
  });

  it('알 수 없는 값은 추측하지 않고 판단을 받는다. 판단 전에는 반영할 수 없다', async () => {
    const { load, preview } = await setup();
    const importsBefore = (await load()).imports;
    const { analysis, apply } = await preview([
      ['SIGN-001', '', 'OK', ''],
      ['SIGN-002', '', 'ok ', ''],
      ['SIGN-003', '', '', ''],
    ]);
    expect(analysis.unknownValues).toEqual([
      { key: 'OK', raw: 'OK', count: 2 },
      { key: '', raw: '', count: 1 },
    ]);
    expect(analysis.rows.every((item) => item.kind === 'matched')).toBe(true);
    await expect(apply()).rejects.toThrow('결과 값 2종을');
    await expect(apply({ values: { OK: 'pass' } })).rejects.toThrow('결과 값 1종을');
    expect((await load()).imports).toEqual(importsBefore);
  });

  it('사용자가 고른 결과를 적용하고 원문은 그대로 보존한다. 제외한 값의 결과는 저장하지 않는다', async () => {
    const { repos, preview } = await setup();
    const { apply } = await preview([
      ['SIGN-001', '', 'OK', ''],
      ['SIGN-002', '', 'ok ', ''],
      ['SIGN-003', '', '', ''],
    ]);
    const saved = await apply({ values: { OK: 'pass', '': 'excluded' } });
    expect((await resultsOf(repos, saved.id)).map((item) => [item.testCaseId, item.rawResult, item.result])).toEqual([
      ['tc-001', 'OK', 'pass'],
      ['tc-002', 'ok ', 'pass'],
    ]);
    expect(saved.mapping).toEqual([{ rawValue: 'OK', result: 'pass' }]);
  });
});

describe('판단 · 차수', () => {
  it('제외한 행은 저장하지 않는다', async () => {
    const { repos, preview } = await setup();
    const saved = await (
      await preview([
        ['SIGN-001', '', 'P', ''],
        ['SIGN-002', '', 'F', ''],
        ['NEW-404', '', 'P', ''],
      ])
    ).apply({ rows: { 3: 'excluded', 4: 'excluded' } });
    expect((await resultsOf(repos, saved.id)).map((item) => item.externalId)).toEqual(['SIGN-001']);
  });

  it('모든 행을 제외하면 가져올 결과가 없어 반영하지 않는다', async () => {
    const { load, preview } = await setup();
    const before = await load();
    await expect((await preview([['SIGN-001', '', 'P', '']])).apply({ rows: { 2: 'excluded' } })).rejects.toThrow('가져올 결과가 없어요');
    expect((await load()).imports).toEqual(before.imports);
  });

  it('다음 차수는 가장 큰 차수 + 1로 제안하고, 이미 있는 차수나 0 이하는 거부한다', async () => {
    const { repos, preview } = await setup();
    expect(suggestNextRound(await repos.testResults.listImports(PROJECT_A))).toBe(3);
    const { apply } = await preview([['SIGN-001', '', 'P', '']]);
    await expect(apply({ cycle: cycle({ round: 2 }) })).rejects.toThrow('2차는 이미 있어요');
    await expect(apply({ cycle: cycle({ round: 0 }) })).rejects.toThrow('차수는 1 이상의 정수');
    await expect(apply({ cycle: cycle({ executedFrom: '' }) })).rejects.toThrow('수행일을 입력해 주세요');
    await expect(apply({ cycle: cycle({ executedTo: '2026-09-01' }) })).rejects.toThrow('수행 종료일이 시작일보다 빨라요');
    expect((await apply({ cycle: cycle({ round: 7 }) })).round).toBe(7);
  });

  it('같은 차수로 두 번 가져오면 두 번째는 거부한다', async () => {
    const { load, preview } = await setup();
    const first = await preview([['SIGN-001', '', 'P', '']]);
    const second = await preview([['SIGN-002', '', 'P', '']]);
    await first.apply();
    const afterFirst = await load();
    await expect(second.apply()).rejects.toThrow('3차는 이미 있어요');
    expect(await load()).toEqual(afterFirst);
  });

  it('플랫폼별 결과 컬럼은 한 행을 플랫폼별 결과로 나눠 저장한다', async () => {
    const { repos, preview } = await setup();
    const headers = ['TC ID', '테스트 항목', 'Android', 'iOS'];
    // 플랫폼 이름 컬럼은 결과 열인지 알 수 없어 자동으로 연결하지 않는다.
    expect(suggestResultColumnMapping(headers)).toEqual(['externalId', 'title', null, null]);
    const { apply } = await preview(
      [
        ['SIGN-001', '', 'P', 'F'],
        ['LOGIN-018', '', 'B', 'N/T'],
      ],
      { headers, mapping: ['externalId', 'title', 'result_android', 'result_ios'] },
    );
    const saved = await apply();
    expect((await resultsOf(repos, saved.id)).map((item) => [item.externalId, item.platform, item.result])).toEqual([
      ['SIGN-001', 'android', 'pass'],
      ['SIGN-001', 'ios', 'fail'],
      ['LOGIN-018', 'android', 'blocked'],
      ['LOGIN-018', 'ios', 'not_tested'],
    ]);
    expect(saved.platform).toBeUndefined();
  });

  it('결과 컬럼이 하나이고 플랫폼 컬럼이 없으면 차수 플랫폼을 모든 결과에 붙인다', async () => {
    const { repos, preview } = await setup();
    const saved = await (await preview([['SIGN-001', '', 'P', '']])).apply({ cycle: cycle({ platform: 'ios' }) });
    expect(saved.platform).toBe('ios');
    expect((await resultsOf(repos, saved.id))[0].platform).toBe('ios');
  });

  it('알 수 없는 플랫폼 값은 오류 행이고 반영을 막는다', async () => {
    const { preview } = await setup();
    const { analysis, apply } = await preview(
      [
        ['SIGN-001', 'Tizen', 'P'],
        ['SIGN-002', 'Android', 'P'],
      ],
      { headers: ['TC ID', '플랫폼', '결과'] },
    );
    expect(analysis.rows[0]).toMatchObject({ kind: 'invalid', issues: [{ level: 'error', message: "플랫폼 값 'Tizen'을(를) 알 수 없어요." }] });
    await expect(apply()).rejects.toThrow('오류 행이 1건');
  });
});

describe('기준 TC 무변경', () => {
  it('연결 · 미연결 · 충돌 결과를 가져와도 기준 TC 목록이 완전히 같다', async () => {
    const seed = createSeed();
    seed.testCases.find((item) => item.id === 'tc-003')!.externalId = 'SIGN-002';
    const { load, preview } = await setup(seed);
    const testCasesBefore = structuredClone((await load()).testCases);
    await (
      await preview([
        ['SIGN-001', '', 'F', ''],
        ['SIGN-002', '', 'P', ''],
        ['LOGIN-020', '', 'B', ''],
        ['NEW-404', '', 'P', ''],
      ])
    ).apply({ rows: { 3: 'import', 5: 'import' } });
    const { testCases } = await load();
    expect(testCases).toEqual(testCasesBefore);
    for (const testCase of testCases) {
      const original = testCasesBefore.find((item) => item.id === testCase.id)!;
      expect([testCase.revision, testCase.status, testCase.origin, testCase.generationType, testCase.updatedAt]).toEqual([
        original.revision,
        original.status,
        original.origin,
        original.generationType,
        original.updatedAt,
      ]);
    }
  });
});

describe('원자성', () => {
  it('판단이 하나라도 남으면 차수 · 결과 · 활동 모두 그대로다', async () => {
    const { repos, load, preview } = await setup();
    const before = await load();
    const resultCount = (await Promise.all(before.imports.map((item) => resultsOf(repos, item.id)))).flat().length;
    await expect(
      (
        await preview([
          ['SIGN-001', '', 'P', ''],
          ['SIGN-002', '', 'F', ''],
          ['NEW-404', '', 'P', ''],
        ])
      ).apply(),
    ).rejects.toThrow('판단하지 않은 행이 1건');
    const after = await load();
    expect(after.imports).toEqual(before.imports);
    expect(after.resultsByImport).toEqual(before.resultsByImport);
    expect(after.activities).toEqual(before.activities);
    expect((await Promise.all(after.imports.map((item) => resultsOf(repos, item.id)))).flat()).toHaveLength(resultCount);
  });

  it('미리보기 이후 기준 TC가 바뀌어 연결 판정이 달라지면 반영하지 않는다', async () => {
    const { repos, load, preview } = await setup();
    const stale = await preview([['NEW-404', '', 'P', '']]);
    expect(stale.analysis.rows[0].kind).toBe('unmatched');
    // 다른 흐름(TC 가져오기)으로 같은 고객사 TC ID의 기준 TC가 생긴다.
    const table = toImportTable(parseCsv('TC ID,대분류,테스트 항목,Expected Result\r\nNEW-404,마이페이지,프로필 저장,저장 완료\r\n'))!;
    await repos.testAssetImports.apply({
      projectId: PROJECT_A,
      fileName: 'tc.csv',
      table,
      mapping: ['externalId', 'depth1', 'title', 'expectedResult'],
      decisions: [{ rowNumber: 2, kind: 'new', decision: 'import' }],
    });
    const before = await load();
    await expect(stale.apply({ rows: { 2: 'import' } })).rejects.toThrow('미리보기 이후 기준 TC가 바뀌어');
    expect((await load()).imports).toEqual(before.imports);
  });

  it('없는 프로젝트에는 가져올 수 없다', async () => {
    const { repos, preview } = await setup();
    const { table, mapping, decisions } = await preview([['SIGN-001', '', 'P', '']]);
    await expect(
      repos.testResults.importResults({ projectId: 'proj-missing', fileName: 'x.csv', table, mapping, cycle: cycle(), rowDecisions: decisions(), valueDecisions: {} }),
    ).rejects.toThrow('프로젝트을(를) 찾을 수 없어요');
  });
});

describe('회귀', () => {
  it('다른 프로젝트 TC와는 연결하지 않는다', async () => {
    const seed = createSeed();
    seed.testCases.push({ ...structuredClone(seed.testCases[0]), id: 'tc-other', projectId: PROJECT_B, externalId: 'NEW-404' });
    const { preview } = await setup(seed);
    expect((await preview([['NEW-404', '', 'P', '']])).analysis.rows[0].kind).toBe('unmatched');
  });

  it('기존 두 차수의 결과 조회와 TC 연결이 그대로다', async () => {
    const { repos, load, preview } = await setup();
    await (await preview([['SIGN-001', '', 'P', '']])).apply();
    const { imports, testCases } = await load();
    const byId = new Map(testCases.map((item) => [item.id, item]));
    for (const resultImport of imports.filter((item) => item.round <= 2)) {
      expect(resultImport.executionType).toBe('full');
      const results = await resultsOf(repos, resultImport.id);
      expect(results).toHaveLength(212);
      const linked = results.filter((item) => item.testCaseId);
      expect(linked).toHaveLength(30);
      for (const result of linked) expect(byId.get(result.testCaseId!)?.externalId).toBe(result.externalId);
    }
  });
});
