import { describe, expect, it } from 'vitest';
import { testPerspectiveLabel } from '@/domain/labels';
import {
  analyzeTestAssetImport,
  defaultDecisionFor,
  suggestColumnMapping,
  toImportTable,
  type ColumnMapping,
  type ImportTable,
  type TestAssetImportDecision,
  type TestAssetImportRowDecision,
} from '@/domain/testAssetImport';
import type { TestCase } from '@/domain/types';
import { parseCsv } from '@/lib/csv';
import { createMockRepositories } from './mockRepositories';
import { createSeed, PROJECT_A, type SeedData } from './seed';

const HEADERS = ['TC ID', '테스트 관점', '대분류', '중분류', '소분류', '테스트 항목', 'Pre-condition', 'Test Step', 'Expected Result', '비고'];

/** 모든 셀을 따옴표로 감싼 CSV. 실제 파일과 같은 parser 경로를 거친다. */
function csv(rows: string[][]): string {
  return [HEADERS, ...rows].map((cells) => cells.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(',')).join('\r\n');
}

/** 기존 TC와 같은 내용의 파일 행 */
function rowOf(testCase: TestCase, overrides: Partial<Record<'externalId' | 'title' | 'expectedResult' | 'steps' | 'category', string>> = {}): string[] {
  return [
    overrides.externalId ?? testCase.externalId ?? '',
    overrides.category ?? testPerspectiveLabel[testCase.category],
    testCase.depth[0] ?? '',
    testCase.depth[1] ?? '',
    testCase.depth[2] ?? '',
    overrides.title ?? testCase.title,
    testCase.precondition ?? '',
    overrides.steps ?? testCase.steps.map((step, index) => `${index + 1}. ${step}`).join('\n'),
    overrides.expectedResult ?? testCase.expectedResult,
    '',
  ];
}

const newRow = (externalId: string, title: string) => [externalId, '예외', '마이페이지', '프로필', '닉네임', title, '로그인 상태', '1. 프로필로 이동한다.\n2. 저장한다.', '저장 완료 안내 노출', '고객사 메모'];

async function setup(seed: SeedData = createSeed()) {
  const before = structuredClone(seed);
  const repos = createMockRepositories(seed);
  const load = async () => ({
    testCases: await repos.testCases.listByProject(PROJECT_A),
    sessions: await repos.testAssetImports.listByProject(PROJECT_A),
    activities: await repos.activities.list({ projectId: PROJECT_A }),
  });

  /** 화면과 같은 순서로 파일을 읽고 미리보기를 계산한다. */
  const preview = async (rows: string[][], mapping?: ColumnMapping) => {
    const table = toImportTable(parseCsv(csv(rows))) as ImportTable;
    const columnMapping = mapping ?? suggestColumnMapping(table.headers);
    const analysis = analyzeTestAssetImport(table, columnMapping, await repos.testCases.listByProject(PROJECT_A));
    /** 기본 판단에 일부만 바꾼 판단 목록 */
    const decisions = (overrides: Record<number, TestAssetImportDecision> = {}): TestAssetImportRowDecision[] =>
      analysis.rows
        .filter((item) => defaultDecisionFor(item) || overrides[item.row.rowNumber])
        .map((item) => ({ rowNumber: item.row.rowNumber, kind: item.kind, targetId: item.targetId, decision: overrides[item.row.rowNumber] ?? defaultDecisionFor(item)! }));
    const apply = (overrides?: Record<number, TestAssetImportDecision>, given = decisions(overrides)) =>
      repos.testAssetImports.apply({ projectId: PROJECT_A, fileName: '고객사A_기존TC.csv', table, mapping: columnMapping, decisions: given });
    return { table, mapping: columnMapping, analysis, decisions, apply };
  };

  return { seed, before, repos, load, preview };
}

const original = (seed: SeedData, id: string) => seed.testCases.find((item) => item.id === id)!;

describe('신규 가져오기', () => {
  it('새 내부 ID · 파일의 고객사 TC ID · revision 1 · 초안 · imported로 만들고 연결은 비워 둔다', async () => {
    const { before, load, preview } = await setup();
    const { analysis, apply } = await preview([newRow('MY-001', '닉네임 변경 시 저장 가능')]);
    expect(analysis.rows[0].kind).toBe('new');

    const session = await apply();
    const { testCases, sessions } = await load();
    expect(testCases).toHaveLength(before.testCases.length + 1);
    const created = testCases.find((item) => item.externalId === 'MY-001')!;
    expect(before.testCases.some((item) => item.id === created.id)).toBe(false);
    expect(created).toMatchObject({
      projectId: PROJECT_A,
      templateId: 'tpl-client-a',
      category: 'exception',
      feature: '마이페이지',
      depth: ['마이페이지', '프로필', '닉네임'],
      title: '닉네임 변경 시 저장 가능',
      precondition: '로그인 상태',
      steps: ['프로필로 이동한다.', '저장한다.'],
      expectedResult: '저장 완료 안내 노출',
      requirementIds: [],
      testConditionIds: [],
      sourceRefs: [],
      origin: 'imported',
      status: 'draft',
      revision: 1,
      importSource: { sessionId: session.id, rowNumber: 2 },
    });
    expect(created.createdAt).toBe(created.updatedAt);
    expect(sessions).toEqual([session]);
    expect(session).toMatchObject({ projectId: PROJECT_A, fileName: '고객사A_기존TC.csv', totalRows: 1, created: 1, updated: 0, unchanged: 0, excluded: 0 });
  });

  it('고객사 TC ID가 없는 행은 ID 없이 만들고 경고를 남긴다', async () => {
    const { load, preview } = await setup();
    const { analysis, apply } = await preview([newRow('', '닉네임 공백 입력 시 오류 노출')]);
    expect(analysis.rows[0].issues).toEqual([{ level: 'warning', message: expect.stringContaining('고객사 TC ID가 비어 있어요') }]);
    await apply();
    const created = (await load()).testCases.find((item) => item.title === '닉네임 공백 입력 시 오류 노출')!;
    expect('externalId' in created).toBe(false);
  });

  it('가져오기 활동을 남긴다', async () => {
    const { load, preview } = await setup();
    await (await preview([newRow('MY-001', 'a'), newRow('MY-002', 'b')])).apply();
    expect((await load()).activities[0]).toMatchObject({
      type: 'test_assets_imported',
      title: 'TC 자산 2건 가져오기',
      metadata: { detail: '고객사A_기존TC.csv · 신규 2 · 업데이트 0 · 변경 없음 0 · 제외 0' },
    });
  });
});

describe('기존 TC 매칭 · 업데이트', () => {
  it('내용이 같은 행은 exact_match이고 revision이 바뀌지 않는다', async () => {
    const { seed, load, preview } = await setup();
    const { analysis, apply } = await preview([rowOf(original(seed, 'tc-001')), newRow('MY-001', 'a')]);
    expect(analysis.rows.map((item) => [item.kind, item.targetId])).toEqual([
      ['exact_match', 'tc-001'],
      ['new', undefined],
    ]);
    const session = await apply();
    expect((await load()).testCases.find((item) => item.id === 'tc-001')).toEqual(original(seed, 'tc-001'));
    expect(session).toMatchObject({ created: 1, unchanged: 1 });
  });

  it('changed 업데이트 → 내부 ID · 고객사 TC ID 유지, 바뀐 필드만 반영, revision +1, 재검토 필요', async () => {
    const { seed, load, preview } = await setup();
    const tc = original(seed, 'tc-003');
    const { analysis, apply } = await preview([rowOf(tc, { title: '9자 입력 시 오류 노출', expectedResult: '"10자 이상 입력" 안내 노출' })]);
    expect(analysis.rows[0]).toMatchObject({ kind: 'changed', targetId: 'tc-003', changes: { title: '9자 입력 시 오류 노출', expectedResult: '"10자 이상 입력" 안내 노출' } });
    expect(Object.keys(analysis.rows[0].changes!)).toEqual(['title', 'expectedResult']);

    const session = await apply({ 2: 'update' });
    const updated = (await load()).testCases.find((item) => item.id === 'tc-003')!;
    expect(updated).toEqual({
      ...tc,
      title: '9자 입력 시 오류 노출',
      expectedResult: '"10자 이상 입력" 안내 노출',
      revision: tc.revision + 1,
      status: 'needs_review',
      origin: 'import_modified',
      importSource: { sessionId: session.id, rowNumber: 2 },
      updatedAt: updated.updatedAt,
    });
    expect(session).toMatchObject({ created: 0, updated: 1 });
  });

  it('업데이트는 파일이 소유하지 않는 요구사항 · 테스트 조건 · 근거 연결과 생성 유형을 지우지 않는다', async () => {
    const { seed, load, preview } = await setup();
    const tc = original(seed, 'tc-001');
    await (await preview([rowOf(tc, { title: '유효한 비밀번호로 가입 완료' })])).apply({ 2: 'update' });
    const updated = (await load()).testCases.find((item) => item.id === 'tc-001')!;
    expect(updated.requirementIds).toEqual(['req-001', 'req-002']);
    expect(updated.testConditionIds).toEqual(['cond-001']);
    expect(updated.sourceRefs).toEqual(tc.sourceRefs);
    expect(updated.generationType).toBe(tc.generationType);
    expect(updated.createdAt).toBe(tc.createdAt);
  });

  it('연결하지 않은 필드와 알 수 없는 구분 값은 기존 값을 유지한다', async () => {
    const { seed, load, preview } = await setup();
    const tc = original(seed, 'tc-004');
    // Test Step 컬럼을 연결하지 않는다.
    const mapping: ColumnMapping = ['externalId', 'category', 'depth1', 'depth2', 'depth3', 'title', 'precondition', null, 'expectedResult', null];
    const { analysis, apply } = await preview([rowOf(tc, { category: '스모크', steps: '전혀 다른 절차', title: '영문 없이 숫자만 입력 시 오류 노출' })], mapping);
    expect(analysis.rows[0].issues.map((issue) => issue.level)).toEqual(['warning']);
    expect(Object.keys(analysis.rows[0].changes!)).toEqual(['title']);
    await apply({ 2: 'update' });
    const updated = (await load()).testCases.find((item) => item.id === 'tc-004')!;
    expect(updated.category).toBe(tc.category);
    expect(updated.steps).toEqual(tc.steps);
  });

  it('같은 파일을 다시 가져오면 모두 exact_match이고 revision이 더 오르지 않는다', async () => {
    const { seed, load, preview } = await setup();
    const rows = [rowOf(original(seed, 'tc-002'), { title: '최소 길이 10자 입력' }), newRow('MY-001', 'a')];
    await (await preview(rows)).apply({ 2: 'update' });
    const afterFirst = (await load()).testCases;

    const second = await preview(rows);
    expect(second.analysis.rows.map((item) => item.kind)).toEqual(['exact_match', 'exact_match']);
    await expect(second.apply()).rejects.toThrow('새로 만들거나 업데이트할 TC가 없어요');
    expect((await load()).testCases).toEqual(afterFirst);
    expect(afterFirst.find((item) => item.id === 'tc-002')!.revision).toBe(2);
  });

  it('changed 판단 전에는 반영할 수 없다', async () => {
    const { seed, preview } = await setup();
    const { apply } = await preview([rowOf(original(seed, 'tc-003'), { title: '바뀐 제목' })]);
    await expect(apply()).rejects.toThrow('판단하지 않은 행이 1건');
  });

  it('제외한 행은 아무것도 바꾸지 않는다', async () => {
    const { seed, before, load, preview } = await setup();
    const { apply } = await preview([rowOf(original(seed, 'tc-003'), { title: '바뀐 제목' }), newRow('MY-001', '제외할 신규'), newRow('MY-002', '가져올 신규')]);
    const session = await apply({ 2: 'excluded', 3: 'excluded' });
    const { testCases } = await load();
    expect(testCases.find((item) => item.id === 'tc-003')).toEqual(original(seed, 'tc-003'));
    expect(testCases.some((item) => item.externalId === 'MY-001')).toBe(false);
    expect(testCases).toHaveLength(before.testCases.length + 1);
    expect(session).toMatchObject({ created: 1, updated: 0, excluded: 2 });
  });

  it('파일에 없는 기존 TC는 삭제 · 폐기하지 않는다', async () => {
    const { before, load, preview } = await setup();
    await (await preview([newRow('MY-001', 'a')])).apply();
    const { testCases } = await load();
    for (const tc of before.testCases) expect(testCases.find((item) => item.id === tc.id)).toEqual(tc);
  });
});

describe('충돌', () => {
  it('파일 ID는 새것인데 내용이 기존 TC와 같으면 충돌이고, 판단 전에는 반영할 수 없다', async () => {
    const { seed, before, load, preview } = await setup();
    const { analysis, apply } = await preview([rowOf(original(seed, 'tc-001'), { externalId: 'SIGN-900' })]);
    expect(analysis.rows[0]).toMatchObject({ kind: 'conflict', conflictReason: 'external_id_mismatch', candidateIds: ['tc-001'] });
    await expect(apply()).rejects.toThrow('판단하지 않은 행이 1건');
    expect((await load()).testCases).toEqual(before.testCases);
  });

  it('충돌을 별도 신규 TC로 고르면 기존 TC는 그대로 두고 새 TC를 만든다', async () => {
    const { seed, before, load, preview } = await setup();
    await (await preview([rowOf(original(seed, 'tc-001'), { externalId: 'SIGN-900' })])).apply({ 2: 'create_separate' });
    const { testCases } = await load();
    expect(testCases.find((item) => item.id === 'tc-001')).toEqual(original(seed, 'tc-001'));
    expect(testCases.find((item) => item.externalId === 'SIGN-900')).toMatchObject({ revision: 1, status: 'draft', origin: 'imported' });
    expect(testCases).toHaveLength(before.testCases.length + 1);
  });

  it('기존 TC 여러 개가 같은 고객사 TC ID를 쓰면 제외만 고를 수 있다', async () => {
    const seed = createSeed();
    seed.testCases.find((item) => item.id === 'tc-002')!.externalId = 'SIGN-001';
    const { before, load, preview } = await setup(seed);
    const { analysis, apply } = await preview([rowOf(original(seed, 'tc-001'), { title: '바뀐 제목' })]);
    expect(analysis.rows[0]).toMatchObject({ kind: 'conflict', conflictReason: 'ambiguous_external_id' });
    await expect(apply({ 2: 'create_separate' })).rejects.toThrow('고를 수 없는 처리');
    expect((await load()).testCases).toEqual(before.testCases);
  });
});

describe('검증', () => {
  it('파일 안에서 고객사 TC ID가 겹치면 두 행 모두 오류이고 반영할 수 없다', async () => {
    const { before, load, preview } = await setup();
    const { analysis, apply } = await preview([newRow('MY-001', 'a'), newRow('MY-001', 'b'), newRow('MY-002', 'c')]);
    expect(analysis.rows.map((item) => item.kind)).toEqual(['invalid', 'invalid', 'new']);
    expect(analysis.rows[0].issues).toContainEqual({ level: 'error', message: '고객사 TC ID MY-001가 3행에도 있어요.' });
    await expect(apply()).rejects.toThrow('오류 행이 2건');
    expect((await load()).testCases).toEqual(before.testCases);
  });

  it('필수 설계 필드가 빈 행은 오류 행이고, 완전히 빈 행은 건너뛴다', async () => {
    const { preview } = await setup();
    const blank = HEADERS.map(() => '');
    const noTitle = newRow('MY-001', '');
    const noExpected = [...newRow('MY-002', 'b').slice(0, 8), '', ''];
    const { analysis } = await preview([noTitle, blank, noExpected, newRow('MY-003', 'c')]);
    expect(analysis.blankRows).toBe(1);
    expect(analysis.rows.map((item) => [item.row.rowNumber, item.kind])).toEqual([
      [2, 'invalid'],
      [4, 'invalid'],
      [5, 'new'],
    ]);
    expect(analysis.rows[0].issues).toContainEqual({ level: 'error', message: '테스트 항목이 비어 있어요.' });
    expect(analysis.rows[1].issues).toContainEqual({ level: 'error', message: 'Expected Result가 비어 있어요.' });
  });

  it('필수 컬럼을 연결하지 않았거나 한 필드에 두 컬럼을 연결하면 파일 문제로 막는다', async () => {
    const { preview } = await setup();
    const missing = await preview([newRow('MY-001', 'a')], ['externalId', null, 'depth1', null, null, 'title', null, null, null, null]);
    expect(missing.analysis.fileProblems).toEqual(["'Expected Result' 컬럼을 연결해 주세요."]);
    const duplicated = await preview([newRow('MY-001', 'a')], ['externalId', null, 'depth1', null, null, 'title', 'title', null, 'expectedResult', null]);
    expect(duplicated.analysis.fileProblems[0]).toContain("'테스트 항목'에 컬럼이 둘 이상");
    await expect(duplicated.apply()).rejects.toThrow('컬럼이 둘 이상');
  });

  it('가져올 수 있는 행이 없으면 파일 문제다', async () => {
    const { preview } = await setup();
    expect((await preview([newRow('MY-001', '')])).analysis.fileProblems).toEqual(['가져올 수 있는 행이 없어요.']);
  });
});

describe('원자성', () => {
  it('판단 하나가 빠지면 TC · 가져오기 기록 · 활동 모두 그대로다', async () => {
    const { seed, before, load, preview } = await setup();
    const activitiesBefore = (await load()).activities.length;
    const { apply } = await preview([newRow('MY-001', 'a'), newRow('MY-002', 'b'), rowOf(original(seed, 'tc-003'), { title: '바뀐 제목' })]);
    await expect(apply()).rejects.toThrow('판단하지 않은 행이 1건');
    const { testCases, sessions, activities } = await load();
    expect(testCases).toEqual(before.testCases);
    expect(sessions).toEqual([]);
    expect(activities).toHaveLength(activitiesBefore);
  });

  it('미리보기 이후 같은 고객사 TC ID가 생기면 반영하지 않는다', async () => {
    const { load, preview } = await setup();
    const stale = await preview([newRow('MY-001', 'a')]);
    await (await preview([newRow('MY-001', 'a')])).apply();
    const afterOther = await load();
    await expect(stale.apply()).rejects.toThrow('미리보기 이후 기존 TC가 바뀌어');
    const { testCases, sessions } = await load();
    expect(testCases).toEqual(afterOther.testCases);
    expect(sessions).toHaveLength(1);
    expect(testCases.filter((item) => item.externalId === 'MY-001')).toHaveLength(1);
  });

  it('없는 프로젝트에는 가져올 수 없다', async () => {
    const { repos, preview } = await setup();
    const { table, mapping, decisions } = await preview([newRow('MY-001', 'a')]);
    await expect(repos.testAssetImports.apply({ projectId: 'proj-missing', fileName: 'x.csv', table, mapping, decisions: decisions() })).rejects.toThrow('프로젝트을(를) 찾을 수 없어요');
  });
});

describe('회귀', () => {
  it('가져오기로 업데이트해도 두 차수의 수행 결과가 externalId로 같은 TC에 연결된다', async () => {
    const { seed, repos, load, preview } = await setup();
    await (
      await preview([
        rowOf(original(seed, 'tc-001'), { title: '바뀐 제목 1' }),
        rowOf(original(seed, 'tc-002'), { expectedResult: '바뀐 기대 결과' }),
        rowOf(original(seed, 'tc-010')),
        newRow('MY-001', 'a'),
      ])
    ).apply({ 2: 'update', 3: 'update' });
    const byId = new Map((await load()).testCases.map((item) => [item.id, item]));
    for (const resultImport of await repos.testResults.listImports(PROJECT_A)) {
      const results = await repos.testResults.listResults(resultImport.id);
      expect(results).toHaveLength(212);
      const linked = results.filter((item) => item.testCaseId);
      expect(linked).toHaveLength(30);
      for (const result of linked) expect(byId.get(result.testCaseId!)?.externalId).toBe(result.externalId);
    }
    expect(byId.get('tc-001')).toMatchObject({ externalId: 'SIGN-001', revision: 2, status: 'needs_review' });
  });

  it('다른 프로젝트 TC와는 매칭하지 않는다', async () => {
    const seed = createSeed();
    const other = { ...structuredClone(original(seed, 'tc-001')), id: 'tc-other', projectId: 'proj-client-b-admin', externalId: 'MY-001' };
    seed.testCases.push(other);
    const { load, preview } = await setup(seed);
    const { analysis, apply } = await preview([newRow('MY-001', 'a')]);
    expect(analysis.rows[0].kind).toBe('new');
    await apply();
    expect((await load()).testCases.filter((item) => item.externalId === 'MY-001')).toHaveLength(1);
  });
});
