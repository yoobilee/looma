import { describe, expect, it } from 'vitest';
import { planResultSourceExport, planTestAssetSourceExport, sourceExportFileName, SOURCE_EXPORT_UNAVAILABLE, verifySourceExportOutput, type SourceExportPlan } from './importSourceExport';
import type { ColumnMapping } from './testAssetImport';
import type { ResultColumnMapping } from './testResultImport';
import type { ImportSourceArtifact, ImportSourceSnapshot, TestAssetImportSession, TestCase, TestResult, TestResultImport } from './types';

/* ---------- TC ---------- */

const HEADERS = ['TC ID', '대분류', '중분류', '테스트 항목', 'Pre-condition', 'Test Step', 'Expected Result', '고객사 메모'];
const MAPPING: ColumnMapping = ['externalId', 'depth1', 'depth2', 'title', 'precondition', 'steps', 'expectedResult', null];
const snapshot = (rows: string[][], headers = HEADERS): ImportSourceSnapshot => ({
  format: 'xlsx',
  fileName: '고객사_TC.xlsx',
  sheetName: 'TC',
  headers,
  rows: rows.map((cells, index) => ({ rowNumber: index + 3, cells })),
});
const ROWS = [
  ['SIGN-001', '회원가입', '이메일', '이메일 가입', '앱 설치', '1) 앱을 연다\n2) 입력한다', '가입 완료', '고객 메모 A'],
  ['SIGN-002', '회원가입', '약관', '약관 동의', '', '- 약관을 연다', '다음 단계', ''],
];
const artifact = (overrides: Partial<ImportSourceArtifact> = {}): ImportSourceArtifact => ({
  id: 'src-1',
  projectId: 'p',
  fileName: '고객사_TC.xlsx',
  format: 'xlsx',
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  size: 100,
  selectedSheetName: 'TC',
  createdAt: 'now',
  ...overrides,
});
const session = (overrides: Partial<TestAssetImportSession> = {}): TestAssetImportSession => ({
  id: 'tai-1',
  projectId: 'p',
  fileName: '고객사_TC.xlsx',
  importedAt: 'now',
  totalRows: 2,
  created: 2,
  updated: 0,
  unchanged: 0,
  excluded: 0,
  artifactId: 'src-1',
  sourceSnapshot: snapshot(ROWS),
  columnMapping: [...MAPPING],
  ...overrides,
});
/** 가져오기 직후의 TC(행 값과 같다) */
const importedCase = (rowIndex: number, overrides: Partial<TestCase> = {}): TestCase => {
  const row = ROWS[rowIndex];
  return {
    id: `tc-${rowIndex + 1}`,
    projectId: 'p',
    externalId: row[0],
    category: 'normal_flow',
    feature: row[1],
    depth: [row[1], row[2]],
    title: row[3],
    ...(row[4] && { precondition: row[4] }),
    steps: row[5].split('\n').map((line) => line.replace(/^(\d+\s*[.)]|[-•·*])\s*/, '')),
    expectedResult: row[6],
    requirementIds: [],
    testConditionIds: [],
    sourceRefs: [],
    generationType: 'imported_existing',
    origin: 'imported',
    status: 'draft',
    revision: 1,
    importSource: { sessionId: 'tai-1', rowNumber: rowIndex + 3 },
    createdAt: 'now',
    updatedAt: 'now',
    ...overrides,
  };
};

const patchesOf = (plan: SourceExportPlan) => {
  if (!plan.ok) throw new Error(plan.problems.join('\n'));
  return plan.patches.map(({ rowNumber, columnIndex, field, nextValue }) => ({ rowNumber, columnIndex, field, nextValue }));
};

describe('TC 원본 형식 내보내기 계획', () => {
  it('가져온 그대로면 바꿀 칸이 없다(원본 표기 1) · - 도 그대로 둔다)', () => {
    const plan = planTestAssetSourceExport(session(), artifact(), [importedCase(0), importedCase(1)]);
    expect(patchesOf(plan)).toEqual([]);
    expect(plan.ok && plan.layout).toEqual({ sheetName: 'TC', headerRowNumber: 2, headers: HEADERS });
  });

  it('바뀐 필드의 매핑된 열만 바꾸고 매핑하지 않은 열(고객사 메모)은 건드리지 않는다', () => {
    const plan = planTestAssetSourceExport(session(), artifact(), [importedCase(0, { title: '이메일로 가입', expectedResult: '가입 완료 안내' }), importedCase(1)]);
    expect(patchesOf(plan)).toEqual([
      { rowNumber: 3, columnIndex: 3, field: 'title', nextValue: '이메일로 가입' },
      { rowNumber: 3, columnIndex: 6, field: 'expectedResult', nextValue: '가입 완료 안내' },
    ]);
    expect(plan.ok && plan.patches[0]).toMatchObject({ entityId: 'tc-1', previousValue: '이메일 가입', fieldLabel: '테스트 항목' });
  });

  it('Test Step이 바뀌면 "번호. 내용" 줄로 쓰고, 공백 차이만 있으면 바꾸지 않는다', () => {
    const changed = planTestAssetSourceExport(session(), artifact(), [importedCase(0, { steps: ['앱을 연다', '입력한다', '저장한다'] })]);
    expect(patchesOf(changed)).toEqual([{ rowNumber: 3, columnIndex: 5, field: 'steps', nextValue: '1. 앱을 연다\n2. 입력한다\n3. 저장한다' }]);
    const spacing = planTestAssetSourceExport(session(), artifact(), [importedCase(0, { title: '  이메일 가입 ', steps: [' 앱을 연다', '입력한다 '] })]);
    expect(patchesOf(spacing)).toEqual([]);
  });

  it('중분류 · Pre-condition · 고객사 TC ID 변경, Pre-condition 비우기도 반영한다', () => {
    const plan = planTestAssetSourceExport(session(), artifact(), [importedCase(0, { depth: ['회원가입', '소셜'], precondition: undefined, externalId: 'SIGN-001A' })]);
    expect(patchesOf(plan)).toEqual([
      { rowNumber: 3, columnIndex: 0, field: 'externalId', nextValue: 'SIGN-001A' },
      { rowNumber: 3, columnIndex: 2, field: 'depth2', nextValue: '소셜' },
      { rowNumber: 3, columnIndex: 4, field: 'precondition', nextValue: '' },
    ]);
  });

  it('기능 열이 없으면 대분류 열이 기능 변경을 담는다', () => {
    const plan = planTestAssetSourceExport(session(), artifact(), [importedCase(0, { feature: '가입', depth: ['가입', '이메일'] })]);
    expect(patchesOf(plan)).toEqual([{ rowNumber: 3, columnIndex: 1, field: 'depth1', nextValue: '가입' }]);
  });

  it('원본 열 구조로 정확히 옮길 수 없는 값이면 멈춘다(예: 줄바꿈이 든 절차, 기능과 대분류가 다름)', () => {
    const multiline = planTestAssetSourceExport(session(), artifact(), [importedCase(0, { steps: ['앱을 연다\n그리고 입력한다'] })]);
    expect(multiline).toEqual({ ok: false, problems: [expect.stringContaining('3행(SIGN-001): 지금 TC 값을 원본 열 구조로 정확히 옮길 수 없어요. (steps)')] });
    const featureMismatch = planTestAssetSourceExport(session(), artifact(), [importedCase(0, { feature: '가입' })]);
    expect(featureMismatch.ok).toBe(false);
  });

  it('행 출처가 없거나 다른 가져오기를 가리키는 TC는 넣지 않고 건수를 알려 준다', () => {
    const fresh = importedCase(1, { id: 'tc-new', importSource: undefined, title: '신규 TC' });
    const fromOther = importedCase(1, { id: 'tc-other', importSource: { sessionId: 'tai-2', rowNumber: 4 }, title: '다른 가져오기' });
    const plan = planTestAssetSourceExport(session(), artifact(), [importedCase(0), fresh, fromOther]);
    expect(patchesOf(plan)).toEqual([]);
    expect(plan.ok && plan.notices).toEqual(['이 파일의 행과 연결되지 않은 TC 2건(신규 TC 등)은 포함되지 않아요.']);
  });

  it('행은 고객사 TC ID가 아니라 행 출처로 찾는다', () => {
    // 고객사 TC ID를 바꿔도 같은 행(3행)을 고친다.
    const plan = planTestAssetSourceExport(session(), artifact(), [importedCase(0, { externalId: 'SIGN-002', title: '바뀐 항목' })]);
    expect(patchesOf(plan).map((patch) => patch.rowNumber)).toEqual([3, 3]);
  });

  it('구분 원문을 해석할 수 없던 행은 구분을 바꾸지 않는다(가져오기와 같은 규칙)', () => {
    const headers = ['TC ID', '테스트 관점', '대분류', '테스트 항목', 'Expected Result'];
    const mapping: ColumnMapping = ['externalId', 'category', 'depth1', 'title', 'expectedResult'];
    const base = session({ sourceSnapshot: snapshot([['C-1', '알 수 없음', '기능', '항목', '결과'], ['C-2', '예외', '기능', '항목2', '결과']], headers), columnMapping: mapping });
    const tc = (id: string, row: number, title: string, category: TestCase['category']) =>
      importedCase(0, { id, externalId: id, feature: '기능', depth: ['기능'], title, steps: [], expectedResult: '결과', precondition: undefined, category, importSource: { sessionId: 'tai-1', rowNumber: row } });
    const plan = planTestAssetSourceExport(base, artifact(), [tc('C-1', 3, '항목', 'boundary'), tc('C-2', 4, '항목2', 'permission')]);
    expect(patchesOf(plan)).toEqual([{ rowNumber: 4, columnIndex: 1, field: 'category', nextValue: '권한' }]);
  });

  it('같은 원본 행을 가리키는 TC가 둘이거나 표에 없는 행이면 멈춘다', () => {
    const duplicate = planTestAssetSourceExport(session(), artifact(), [importedCase(0), importedCase(0, { id: 'tc-dup', title: '중복' })]);
    expect(!duplicate.ok && duplicate.problems[0]).toContain('같은 원본 행');
    const missing = planTestAssetSourceExport(session(), artifact(), [importedCase(0, { importSource: { sessionId: 'tai-1', rowNumber: 99 } })]);
    expect(!missing.ok && missing.problems[0]).toContain('가져온 표에 이 행이 없어요');
  });

  it('원본을 보관하지 않았거나(예시 데이터 등) CSV · snapshot · 매핑 · 시트 정보가 없으면 쓸 수 없다', () => {
    const cases: [string, SourceExportPlan][] = [
      ['원본 파일을 보관하지 않은', planTestAssetSourceExport(session({ artifactId: undefined }), undefined, [])],
      ['원본 파일 기록을 찾을 수 없어요', planTestAssetSourceExport(session(), undefined, [])],
      ['CSV로 가져온', planTestAssetSourceExport(session(), artifact({ format: 'csv' }), [])],
      ['snapshot', planTestAssetSourceExport(session({ sourceSnapshot: undefined }), artifact(), [])],
      ['열 매핑이 없어요', planTestAssetSourceExport(session({ columnMapping: undefined }), artifact(), [])],
      ['시트(다른 시트)', planTestAssetSourceExport(session(), artifact({ selectedSheetName: '다른 시트' }), [])],
      ['열 수가 달라요', planTestAssetSourceExport(session({ columnMapping: MAPPING.slice(1) }), artifact(), [])],
    ];
    for (const [message, plan] of cases) {
      expect(plan.ok, message).toBe(false);
      expect(!plan.ok && plan.problems.join(' '), message).toContain(message);
    }
    expect(!cases[0][1].ok && cases[0][1].problems[0]).toContain(SOURCE_EXPORT_UNAVAILABLE);
  });
});

/* ---------- 수행 결과 ---------- */

const RESULT_HEADERS = ['TC ID', 'Android', 'iOS', '비고'];
const RESULT_MAPPING: ResultColumnMapping = ['externalId', 'result_android', 'result_ios', 'note'];
const resultImport = (overrides: Partial<TestResultImport> = {}): TestResultImport => ({
  id: 'imp-1',
  projectId: 'p',
  round: 1,
  fileRef: '수행결과.xlsx',
  importedAt: 'now',
  mapping: [
    { rawValue: 'P', result: 'pass' },
    { rawValue: 'F', result: 'fail' },
    { rawValue: 'N/T', result: 'not_tested' },
  ],
  artifactId: 'src-1',
  sourceSnapshot: { format: 'xlsx', fileName: '수행결과.xlsx', sheetName: 'TC', headers: RESULT_HEADERS, rows: [{ rowNumber: 2, cells: ['SIGN-001', 'P', 'F', '재현'] }, { rowNumber: 3, cells: ['SIGN-002', 'p ', 'N/T', ''] }] },
  resultColumnMapping: [...RESULT_MAPPING],
  ...overrides,
});
const result = (id: string, row: number, platform: 'android' | 'ios', value: TestResult['result'], rawResult: string): TestResult => ({
  id,
  importId: 'imp-1',
  externalId: `SIGN-00${row - 1}`,
  feature: 'f',
  title: 't',
  platform,
  result: value,
  rawResult,
  sourceRowNumber: row,
});
const RESULTS = [result('r1', 2, 'android', 'pass', 'P'), result('r2', 2, 'ios', 'fail', 'F'), result('r3', 3, 'android', 'pass', 'p '), result('r4', 3, 'ios', 'not_tested', 'N/T')];

describe('수행 결과 원본 형식 내보내기 계획', () => {
  it('결과가 원본 표기와 같은 뜻이면 원본 표기(대소문자 · 공백 포함)를 그대로 둔다', () => {
    expect(patchesOf(planResultSourceExport(resultImport(), artifact(), RESULTS))).toEqual([]);
  });

  it('결과가 바뀌면 그 결과를 나타낸 표기가 하나일 때 그 표기로 플랫폼 열에 쓴다', () => {
    const changed = [RESULTS[0], { ...RESULTS[1], result: 'pass' as const }, RESULTS[2], { ...RESULTS[3], result: 'fail' as const }];
    expect(patchesOf(planResultSourceExport(resultImport(), artifact(), changed))).toEqual([
      { rowNumber: 2, columnIndex: 2, field: 'result_ios', nextValue: 'P' },
      { rowNumber: 3, columnIndex: 2, field: 'result_ios', nextValue: 'F' },
    ]);
  });

  it('결과 열이 하나인 양식은 그 열에 쓴다', () => {
    const single = resultImport({
      resultColumnMapping: ['externalId', 'result', null, 'note'],
      sourceSnapshot: { format: 'xlsx', fileName: 'r.xlsx', sheetName: 'TC', headers: ['TC ID', '결과', '담당', '비고'], rows: [{ rowNumber: 2, cells: ['SIGN-001', 'F', '김', ''] }] },
    });
    const plan = planResultSourceExport(single, artifact(), [{ ...result('r1', 2, 'android', 'pass', 'F'), platform: undefined }]);
    expect(patchesOf(plan)).toEqual([{ rowNumber: 2, columnIndex: 1, field: 'result', nextValue: 'P' }]);
  });

  it('바뀐 결과의 표기가 여럿이거나 없으면 추측하지 않고 멈춘다', () => {
    const ambiguous = resultImport({ mapping: [...resultImport().mapping, { rawValue: 'PASS', result: 'pass' }] });
    const toPass = planResultSourceExport(ambiguous, artifact(), [{ ...RESULTS[1], result: 'pass' }]);
    expect(!toPass.ok && toPass.problems[0]).toContain('표기가 여럿(P, PASS)');
    const toBlocked = planResultSourceExport(resultImport(), artifact(), [{ ...RESULTS[1], result: 'blocked' }]);
    expect(!toBlocked.ok && toBlocked.problems[0]).toContain('표기가 없어');
  });

  it('행 출처가 없거나 같은 칸을 가리키는 결과가 둘이면 멈춘다', () => {
    const noRow = planResultSourceExport(resultImport(), artifact(), [{ ...RESULTS[0], sourceRowNumber: undefined }]);
    expect(!noRow.ok && noRow.problems[0]).toContain('원본 행이 기록되어 있지 않아요');
    const duplicate = planResultSourceExport(resultImport(), artifact(), [RESULTS[0], { ...RESULTS[0], id: 'r9' }]);
    expect(!duplicate.ok && duplicate.problems[0]).toContain('같은 칸을 가리켜요');
  });

  it('다른 차수의 결과는 보지 않는다', () => {
    expect(patchesOf(planResultSourceExport(resultImport(), artifact(), [{ ...RESULTS[1], importId: 'imp-2', result: 'blocked' }]))).toEqual([]);
  });

  it('원본을 보관하지 않은 차수(예시 데이터)는 쓸 수 없다', () => {
    const plan = planResultSourceExport(resultImport({ artifactId: undefined, sourceSnapshot: undefined, resultColumnMapping: undefined }), undefined, RESULTS);
    expect(!plan.ok && plan.problems[0]).toContain(SOURCE_EXPORT_UNAVAILABLE);
  });
});

describe('내보내기 파일 이름', () => {
  it('원본 이름 뒤에 _Looma를 붙이고 확장자를 유지한다', () => {
    expect(sourceExportFileName('고객사_TC.xlsx')).toBe('고객사_TC_Looma.xlsx');
    expect(sourceExportFileName('a.b.XLSX')).toBe('a.b_Looma.XLSX');
  });
});

/* ---------- 만든 파일 다시 읽기 확인(M1) ---------- */

describe('내보낸 파일 다시 읽기 확인', () => {
  const ready = () => {
    const plan = planTestAssetSourceExport(session(), artifact(), [importedCase(0, { title: '이메일로 가입' }), importedCase(1)]);
    if (!plan.ok) throw new Error(plan.problems.join('\n'));
    return plan;
  };
  const table = (edit: (rows: string[][]) => void = () => undefined) => {
    const rows = ROWS.map((row) => [...row]);
    rows[0][3] = '이메일로 가입';
    edit(rows);
    return { headers: [...HEADERS], rows: rows.map((cells, index) => ({ rowNumber: index + 3, cells })) };
  };

  it('계획대로 바뀐 표면 문제가 없다', () => {
    expect(verifySourceExportOutput(ready(), table())).toEqual([]);
  });

  it('바꾼 칸이 계획한 값과 다르면(줄바꿈 등) 문제다', () => {
    expect(verifySourceExportOutput(ready(), table((rows) => (rows[0][3] = '이메일로\n가입')))).toEqual([expect.stringContaining('3행 테스트 항목: 내보낸 파일에 쓰인 값이 계획한 값과 달라요')]);
  });

  it('바꾸지 않은 칸 · 헤더 · 행 구성이 달라지면 문제다', () => {
    expect(verifySourceExportOutput(ready(), table((rows) => (rows[1][7] = '바뀐 메모')))).toEqual([expect.stringContaining('4행 고객사 메모: 바꾸지 않은 칸의 값이 달라졌어요')]);
    expect(verifySourceExportOutput(ready(), { ...table(), headers: ['다른', ...HEADERS.slice(1)] })[0]).toContain('헤더');
    const extra = table();
    extra.rows.push({ rowNumber: 9, cells: HEADERS.map(() => '') });
    expect(verifySourceExportOutput(ready(), extra)[0]).toContain('행 구성');
    expect(verifySourceExportOutput(ready(), undefined)[0]).toContain('다시 읽을 수 없어요');
  });

  it('다시 읽은 행이 지금 결과와 같은 뜻이 아니면 문제다', () => {
    const changed = [RESULTS[0], { ...RESULTS[1], result: 'pass' as const }, RESULTS[2], RESULTS[3]];
    const plan = planResultSourceExport(resultImport(), artifact(), changed);
    if (!plan.ok) throw new Error(plan.problems.join('\n'));
    const output = (iosValue: string) => ({ headers: [...RESULT_HEADERS], rows: [{ rowNumber: 2, cells: ['SIGN-001', 'P', iosValue, '재현'] }, { rowNumber: 3, cells: ['SIGN-002', 'p ', 'N/T', ''] }] });
    expect(verifySourceExportOutput(plan, output('P'))).toEqual([]);
    // 표를 비교하는 단계를 지나도 결과의 뜻이 다르면 잡는다(계획 자체를 바꿔 확인한다).
    const tampered = { ...plan, patches: plan.patches.map((patch) => ({ ...patch, nextValue: 'F' })) };
    expect(verifySourceExportOutput(tampered, output('F'))).toEqual([expect.stringContaining('2행(SIGN-001): 내보낸 파일을 다시 읽은 결과가 지금 결과(PASS)와 달라요')]);
  });
});
