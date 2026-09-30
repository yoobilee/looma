import { describe, expect, it, vi } from 'vitest';
import { createSeed } from '@/data/mock/seed';
import {
  analyzeTestAssetImport,
  columnMappingProblems,
  parseImportRow,
  parseSteps,
  planTestAssetImport,
  suggestColumnMapping,
  toImportTable,
  type AnalyzedImportRow,
  type ColumnMapping,
  type TestAssetImportAnalysis,
} from './testAssetImport';

const PROJECT = 'proj-client-a-mobile';
const options = (createId = vi.fn((prefix: string) => `${prefix}-new`)) => ({ projectId: PROJECT, fileName: 'tc.csv', now: 'now', createId });

describe('표 · 매핑', () => {
  it('첫 번째 비어 있지 않은 행을 헤더로 쓰고 파일 행 번호를 보존한다', () => {
    const table = toImportTable([[''], ['TC ID', '', '테스트 항목'], ['SIGN-001', 'x'], ['', '', '']])!;
    expect(table.headers).toEqual(['TC ID', '열 2', '테스트 항목']);
    expect(table.rows).toEqual([
      { rowNumber: 3, cells: ['SIGN-001', 'x', ''] },
      { rowNumber: 4, cells: ['', '', ''] },
    ]);
    expect(toImportTable([['', ' ']])).toBeUndefined();
  });

  it('명백한 alias만 자동으로 연결하고 뜻이 갈리는 컬럼은 비워 둔다', () => {
    expect(suggestColumnMapping(['TC ID', 'Test Case ID', 'ID', '구분', 'Category', '대분류', 'Pre-condition', 'Test Step', 'Expected Result'])).toEqual([
      'externalId',
      null,
      null,
      null,
      null,
      'depth1',
      'precondition',
      'steps',
      'expectedResult',
    ]);
    expect(suggestColumnMapping(['TC_ID'])).toEqual(['externalId']);
    expect(suggestColumnMapping(['test case id'])).toEqual(['externalId']);
  });

  it('필수 필드 미연결과 같은 필드 중복 연결을 막는다', () => {
    const headers = ['A', 'B', 'C'];
    expect(columnMappingProblems(headers, ['title', 'title', null])).toEqual([
      "'테스트 항목'에 컬럼이 둘 이상 연결됐어요. (A, B)",
      "'Expected Result' 컬럼을 연결해 주세요.",
      "'기능' 또는 '대분류' 컬럼을 연결해 주세요.",
    ]);
    expect(columnMappingProblems(headers, ['depth1', 'title', 'expectedResult'])).toEqual([]);
  });
});

describe('정규화 행', () => {
  const mapping: ColumnMapping = ['externalId', 'category', 'depth1', 'depth2', 'title', 'steps', 'expectedResult', null];

  it('원본 값과 해석한 값을 함께 두고, 기능이 없으면 대분류를 쓴다', () => {
    const cells = [' SIGN-100 ', '경계값', '회원가입', '비밀번호', '  8자 입력 ', '1. 이동한다.\n2) 입력한다.\n\n- 누른다.', '가입 가능', '메모'];
    const row = parseImportRow({ rowNumber: 5, cells }, mapping);
    expect(row).toEqual({
      rowNumber: 5,
      rawValues: cells,
      externalId: 'SIGN-100',
      categoryRaw: '경계값',
      category: 'boundary',
      feature: '회원가입',
      depthLevels: ['회원가입', '비밀번호', undefined],
      depth: ['회원가입', '비밀번호'],
      title: '8자 입력',
      steps: ['이동한다.', '입력한다.', '누른다.'],
      expectedResult: '가입 가능',
    });
  });

  it('알 수 없는 구분 값은 원본만 남긴다', () => {
    const row = parseImportRow({ rowNumber: 2, cells: ['', '스모크', '회원가입', '', '항목', '', '결과', ''] }, mapping);
    expect(row.categoryRaw).toBe('스모크');
    expect(row.category).toBeUndefined();
    expect(row.externalId).toBeUndefined();
    expect(row.steps).toEqual([]);
  });

  it('절차 번호 표시만 빼고 내용은 그대로 둔다', () => {
    expect(parseSteps('1.이동\r\n 10) 확인 \n2024년 기준')).toEqual(['이동', '확인', '2024년 기준']);
  });
});

describe('매칭', () => {
  const seed = createSeed();
  const existing = seed.testCases.filter((item) => item.projectId === PROJECT);
  const tc001 = existing.find((item) => item.id === 'tc-001')!;
  const headers = ['TC ID', '대분류', '테스트 항목', 'Pre-condition', 'Expected Result'];
  const mapping: ColumnMapping = ['externalId', 'depth1', 'title', 'precondition', 'expectedResult'];
  const analyze = (rows: string[][]) =>
    analyzeTestAssetImport({ headers, rows: rows.map((cells, index) => ({ rowNumber: index + 2, cells })) }, mapping, existing);

  it('테스트 항목만 같으면 같은 TC로 보지 않는다', () => {
    const [row] = analyze([['', tc001.feature, tc001.title, tc001.precondition!, '다른 기대 결과']]).rows;
    expect(row.kind).toBe('new');
  });

  it('ID 없이 기능 · 항목 · Pre-condition · Expected Result가 모두 같으면 그 TC로 본다', () => {
    // 공백 차이는 같은 내용이고, 연결하지 않은 중분류 · 소분류는 기존 값을 유지하므로 변경 없음이다.
    const [row] = analyze([['', tc001.feature, ` ${tc001.title} `, tc001.precondition!, tc001.expectedResult]]).rows;
    expect(row).toMatchObject({ kind: 'exact_match', targetId: 'tc-001' });
  });

  it('ID 없이 내용만 같은 행이 둘이면 둘 다 충돌이다', () => {
    const content = [tc001.feature, tc001.title, tc001.precondition!, tc001.expectedResult];
    const { rows } = analyze([['', ...content], ['', ...content]]);
    expect(rows.map((item) => [item.kind, item.conflictReason])).toEqual([
      ['conflict', 'shared_target'],
      ['conflict', 'shared_target'],
    ]);
    expect(rows[0].issues.map((issue) => issue.message)).toContain('3행과 내용이 같아요.');
  });

  it('ID로 찾은 행이 있으면 같은 TC를 내용으로만 찾은 행이 충돌이다', () => {
    const content = [tc001.feature, tc001.title, tc001.precondition!, tc001.expectedResult];
    const { rows } = analyze([['SIGN-001', ...content], ['', ...content]]);
    expect(rows.map((item) => item.kind)).toEqual(['exact_match', 'conflict']);
  });
});

/** 판정을 직접 만든 분석. 분석 규칙과 별개로 반영 단계의 방어를 확인할 때 쓴다. */
function craftedAnalysis(rows: AnalyzedImportRow[]): TestAssetImportAnalysis {
  return { fileProblems: [], notices: [], rows, blankRows: 0 };
}

const newRow = (rowNumber: number, externalId?: string): AnalyzedImportRow => ({
  row: { rowNumber, rawValues: [], ...(externalId && { externalId }), feature: '회원가입', depthLevels: ['회원가입'], depth: ['회원가입'], title: `항목 ${rowNumber}`, expectedResult: '결과' },
  issues: [],
  kind: 'new',
  candidateIds: [],
});

describe('반영 계획 방어', () => {
  it('내용이 실제로 같은 업데이트는 revision을 올리지 않고 변경 없음으로 센다', () => {
    const seed = createSeed();
    const tc = seed.testCases.find((item) => item.id === 'tc-001')!;
    const analysis = craftedAnalysis([
      { row: { rowNumber: 2, rawValues: [], depthLevels: tc.depth, depth: tc.depth }, issues: [], kind: 'changed', targetId: tc.id, candidateIds: [], changes: { title: tc.title } },
      newRow(3),
    ]);
    const plan = planTestAssetImport(
      analysis,
      [
        { rowNumber: 2, kind: 'changed', targetId: tc.id, decision: 'update' },
        { rowNumber: 3, kind: 'new', decision: 'import' },
      ],
      seed.testCases,
      options(),
    );
    expect(plan.testCases.find((item) => item.id === tc.id)).toEqual(tc);
    expect(plan.session).toMatchObject({ created: 1, updated: 0, unchanged: 1 });
  });

  it('기존 TC가 쓰는 고객사 TC ID로 새 TC를 만들 수 없다', () => {
    const seed = createSeed();
    const createId = vi.fn((prefix: string) => `${prefix}-new`);
    expect(() => planTestAssetImport(craftedAnalysis([newRow(2, 'SIGN-001')]), [{ rowNumber: 2, kind: 'new', decision: 'import' }], seed.testCases, options(createId))).toThrow(
      '고객사 TC ID SIGN-001를 이미 다른 TC가 쓰고 있어요',
    );
    expect(createId).not.toHaveBeenCalled();
  });

  it('두 신규 행이 같은 고객사 TC ID를 쓰면 거부한다', () => {
    const seed = createSeed();
    const decisions = [2, 3].map((rowNumber) => ({ rowNumber, kind: 'new' as const, decision: 'import' as const }));
    expect(() => planTestAssetImport(craftedAnalysis([newRow(2, 'NEW-001'), newRow(3, 'NEW-001')]), decisions, seed.testCases, options())).toThrow('3행: 고객사 TC ID NEW-001');
  });

  it('뒤쪽 행 검증이 실패해도 세션 · TC ID를 하나도 만들지 않는다', () => {
    const seed = createSeed();
    const createId = vi.fn((prefix: string) => `${prefix}-new`);
    const analysis = craftedAnalysis([newRow(2), newRow(3), { ...newRow(4), kind: 'changed', targetId: 'tc-missing', changes: { title: '바뀜' } }]);
    const decisions = [
      { rowNumber: 2, kind: 'new' as const, decision: 'import' as const },
      { rowNumber: 3, kind: 'new' as const, decision: 'import' as const },
      { rowNumber: 4, kind: 'changed' as const, targetId: 'tc-missing', decision: 'update' as const },
    ];
    expect(() => planTestAssetImport(analysis, decisions, seed.testCases, options(createId))).toThrow('대상 TC를 찾을 수 없어요');
    expect(createId).not.toHaveBeenCalled();
  });

  it('검증을 통과하면 세션 ID를 먼저, 이어서 새 TC ID를 행 순서대로 할당한다', () => {
    const seed = createSeed();
    let counter = 0;
    const createId = vi.fn((prefix: string) => `${prefix}-new-${(counter += 1)}`);
    const decisions = [2, 3].map((rowNumber) => ({ rowNumber, kind: 'new' as const, decision: 'import' as const }));
    const plan = planTestAssetImport(craftedAnalysis([newRow(2), newRow(3)]), decisions, seed.testCases, options(createId));
    expect(createId.mock.calls.map(([prefix]) => prefix)).toEqual(['tai', 'tc', 'tc']);
    expect(plan.session.id).toBe('tai-new-1');
    expect(plan.testCases.slice(-2).map((item) => [item.id, item.importSource])).toEqual([
      ['tc-new-2', { sessionId: 'tai-new-1', rowNumber: 2 }],
      ['tc-new-3', { sessionId: 'tai-new-1', rowNumber: 3 }],
    ]);
  });
});

describe('생성 유형 표시', () => {
  it('가져온 TC만 기존 TC 가져오기로 표시하고 요구사항 근거 라벨은 그대로다', async () => {
    const { generationTypeLabel, requirementSourceLabel } = await import('./labels');
    expect(generationTypeLabel.imported_existing).toBe('기존 TC 가져오기');
    expect(generationTypeLabel.source_explicit).toBe('산출물 직접 근거');
    expect(requirementSourceLabel).not.toHaveProperty('imported_existing');
  });
});
