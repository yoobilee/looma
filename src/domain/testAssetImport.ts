import { testAssetImportFieldLabel, testPerspectiveLabel } from './labels';
import type { TestAssetImportSession, TestCase, TestPerspective } from './types';

/*
 * TC 자산 가져오기 — 고객사가 쓰던 TC 정의 파일을 Looma의 기준 TC로 가져온다. 수행 결과 업로드와 별개다.
 * 파일 parser → ImportTable(형식 무관 표) → 컬럼 매핑 → 정규화 행 → 검증 · 기존 TC 매칭 → 사용자 판단 → 반영 계획.
 * 이 파일은 파일 형식을 모른다. XLSX parser가 추가돼도 ImportTable만 만들면 나머지는 그대로 쓴다.
 */

/* ---------- 표 ---------- */

export interface ImportTableRow {
  /** 파일에서의 행 번호(1부터). 헤더 행도 센다. */
  rowNumber: number;
  /** 헤더 순서와 같은 원본 셀 값. 헤더보다 짧은 행은 빈 값으로 채운다. */
  cells: string[];
}

/** 파일 형식과 무관한 표. 첫 번째 비어 있지 않은 행을 헤더로 쓴다. */
export interface ImportTable {
  headers: string[];
  rows: ImportTableRow[];
}

const isBlank = (cells: string[]) => cells.every((cell) => cell.trim() === '');

/**
 * parser가 읽은 행 배열을 표로 바꾼다. 내용이 없으면 undefined.
 * lines가 있으면 records[i]가 원본에서 시작하는 줄 번호이고(CSV는 따옴표 안 줄바꿈으로 한 레코드가 여러 줄일 수 있다), 없으면 레코드 순서가 곧 행 번호다(XLSX).
 */
export function toImportTable(records: string[][], lines?: number[]): ImportTable | undefined {
  const headerIndex = records.findIndex((cells) => !isBlank(cells));
  if (headerIndex < 0) return undefined;
  const headers = records[headerIndex].map((header, index) => header.trim() || `열 ${index + 1}`);
  const rows = records.slice(headerIndex + 1).map((cells, offset) => ({
    rowNumber: lines ? lines[headerIndex + offset + 1] : headerIndex + offset + 2,
    cells: headers.map((_, index) => cells[index] ?? ''),
  }));
  return { headers, rows };
}

/* ---------- 컬럼 매핑 ---------- */

export type TestAssetImportField =
  | 'externalId'
  | 'category'
  | 'feature'
  | 'depth1'
  | 'depth2'
  | 'depth3'
  | 'title'
  | 'precondition'
  | 'steps'
  | 'expectedResult';

export const testAssetImportFields: TestAssetImportField[] = [
  'externalId',
  'category',
  'feature',
  'depth1',
  'depth2',
  'depth3',
  'title',
  'precondition',
  'steps',
  'expectedResult',
];

/** 파일 컬럼 순서대로 연결한 Looma 필드. 연결하지 않은 컬럼은 null. */
export type ColumnMapping = (TestAssetImportField | null)[];

const headerKey = (header: string) => header.normalize('NFC').toLowerCase().replace(/[\s_\-./]/g, '');

// 이름만으로 뜻이 분명한 경우만 자동으로 연결한다. "ID", "구분", "Category"처럼 뜻이 갈리는 이름은 사용자가 고른다.
const headerAliases: Record<TestAssetImportField, string[]> = {
  externalId: ['tcid', 'testcaseid', 'tcno', 'tc번호', '고객사tcid'],
  category: ['테스트관점'],
  feature: ['기능', '기능명', 'feature'],
  depth1: ['대분류', 'depth1'],
  depth2: ['중분류', 'depth2'],
  depth3: ['소분류', 'depth3'],
  title: ['테스트항목', 'tc명', '테스트케이스명', 'testcasename', 'title', '제목'],
  precondition: ['precondition', '사전조건', '전제조건'],
  steps: ['teststep', 'teststeps', 'steps', '테스트절차', '수행절차', '절차'],
  expectedResult: ['expectedresult', '기대결과', '예상결과'],
};

/** 명백한 컬럼명만 후보로 연결한다. 같은 필드 후보가 여럿이면 첫 컬럼만 연결한다. */
export function suggestColumnMapping(headers: string[]): ColumnMapping {
  const used = new Set<TestAssetImportField>();
  return headers.map((header) => {
    const key = headerKey(header);
    const field = testAssetImportFields.find((candidate) => !used.has(candidate) && headerAliases[candidate].includes(key));
    if (!field) return null;
    used.add(field);
    return field;
  });
}

const mappedFields = (mapping: ColumnMapping) => new Set(mapping.filter((field): field is TestAssetImportField => !!field));

/** 전체 가져오기를 막는 매핑 문제 */
export function columnMappingProblems(headers: string[], mapping: ColumnMapping): string[] {
  const problems: string[] = [];
  for (const field of testAssetImportFields) {
    const columns = headers.filter((_, index) => mapping[index] === field);
    if (columns.length > 1) problems.push(`'${testAssetImportFieldLabel[field]}'에 컬럼이 둘 이상 연결됐어요. (${columns.join(', ')})`);
  }
  const fields = mappedFields(mapping);
  for (const field of ['title', 'expectedResult'] as const) {
    if (!fields.has(field)) problems.push(`'${testAssetImportFieldLabel[field]}' 컬럼을 연결해 주세요.`);
  }
  if (!fields.has('feature') && !fields.has('depth1')) problems.push(`'기능' 또는 '대분류' 컬럼을 연결해 주세요.`);
  return problems;
}

/** 가져올 수는 있지만 알고 있어야 하는 매핑 안내 */
export function columnMappingNotices(mapping: ColumnMapping): string[] {
  const fields = mappedFields(mapping);
  const notices: string[] = [];
  if (!fields.has('externalId')) notices.push('고객사 TC ID를 연결하지 않아 내용이 정확히 같은 기존 TC만 찾아요. 새 TC는 ID 없이 가져와요.');
  if (!fields.has('category')) notices.push(`구분(테스트 관점)을 연결하지 않아 새 TC는 '${testPerspectiveLabel.normal_flow}'으로 가져와요. 기존 TC의 구분은 바꾸지 않아요.`);
  if (!fields.has('steps')) notices.push('Test Step을 연결하지 않아 새 TC의 절차는 비어 있어요. 기존 TC의 절차는 바꾸지 않아요.');
  if (!fields.has('precondition')) notices.push('Pre-condition을 연결하지 않아 기존 TC의 Pre-condition은 바꾸지 않아요.');
  return notices;
}

/* ---------- 정규화 행 ---------- */

/** 파일의 한 행을 TC로 만들기 전 중간 모델. 원본 값과 해석한 값을 함께 둔다. */
export interface TestAssetImportRow {
  rowNumber: number;
  /** 헤더 순서와 같은 원본 셀 값 */
  rawValues: string[];
  externalId?: string;
  /** 구분 원본 값. 알 수 없는 값이면 category가 비어 있다. */
  categoryRaw?: string;
  category?: TestPerspective;
  /** 기능. 기능 컬럼이 없으면 대분류를 쓴다. */
  feature?: string;
  /** 대분류 · 중분류 · 소분류 자리별 값. 대분류가 없으면 기능을 쓴다. */
  depthLevels: (string | undefined)[];
  /** 빈 자리를 뺀 Depth. 새 TC에 쓴다. */
  depth: string[];
  title?: string;
  precondition?: string;
  steps?: string[];
  expectedResult?: string;
}

const clean = (value: string | undefined) => {
  const text = value?.normalize('NFC').trim();
  return text ? text : undefined;
};

/** 비교용. 공백 차이와 유니코드 조합 방식(NFC/NFD) 차이는 같은 내용으로 본다. */
const normalizeText = (value: string | undefined) => (value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();

/** 셀 안의 줄을 절차로 나눈다. 줄 앞의 "1.", "2)", "-" 같은 번호 표시는 목록이 대신하므로 뺀다. */
export function parseSteps(value: string | undefined): string[] {
  return (value ?? '')
    .split(/\r?\n/)
    .map((line) => line.normalize('NFC').trim().replace(/^(\d+\s*[.)]|[-•·*])\s*/, '').trim())
    .filter(Boolean);
}

const perspectiveByText = new Map<string, TestPerspective>(
  (Object.keys(testPerspectiveLabel) as TestPerspective[]).flatMap((key) => [
    [key.toLowerCase(), key],
    [normalizeText(testPerspectiveLabel[key]).toLowerCase(), key],
  ]),
);

export function parseImportRow(row: ImportTableRow, mapping: ColumnMapping): TestAssetImportRow {
  const value = (field: TestAssetImportField) => {
    const index = mapping.indexOf(field);
    return index < 0 ? undefined : clean(row.cells[index]);
  };
  const categoryRaw = value('category');
  const feature = value('feature') ?? value('depth1');
  const depthLevels = [value('depth1') ?? feature, value('depth2'), value('depth3')];
  return {
    rowNumber: row.rowNumber,
    rawValues: [...row.cells],
    ...(value('externalId') && { externalId: value('externalId') }),
    ...(categoryRaw && { categoryRaw, category: perspectiveByText.get(normalizeText(categoryRaw).toLowerCase()) }),
    ...(feature && { feature }),
    depthLevels,
    depth: depthLevels.filter((item): item is string => !!item),
    ...(value('title') && { title: value('title') }),
    ...(value('precondition') && { precondition: value('precondition') }),
    ...(mapping.includes('steps') && { steps: parseSteps(row.cells[mapping.indexOf('steps')]) }),
    ...(value('expectedResult') && { expectedResult: value('expectedResult') }),
  };
}

/* ---------- 검증 · 매칭 ---------- */

/**
 * new: 기존 TC 없음 / exact_match: 기존 TC와 내용이 같음 / changed: 같은 TC라는 근거가 있고 내용이 다름
 * conflict: 어느 TC인지 자동으로 정하기 위험함 / invalid: 오류가 있어 가져올 수 없음
 */
export type TestAssetMatchKind = 'new' | 'exact_match' | 'changed' | 'conflict' | 'invalid';

export type TestAssetConflictReason =
  /** 파일의 고객사 TC ID를 쓰는 기존 TC는 없는데, 내용이 같은 기존 TC가 있다(다른 ID이거나 ID가 없다) */
  | 'external_id_mismatch'
  /** 내용이 같은 기존 TC가 둘 이상이다 */
  | 'ambiguous_content'
  /** 기존 TC 여러 개가 같은 고객사 TC ID를 쓰고 있다 */
  | 'ambiguous_external_id'
  /** 파일의 여러 행이 같은 기존 TC를 가리킨다 */
  | 'shared_target';

export interface TestAssetImportIssue {
  level: 'error' | 'warning';
  message: string;
}

/** 파일이 소유하는 TC 내용 필드. 가져오기는 이 필드만 바꾼다. */
export type TestAssetContentField = 'category' | 'feature' | 'depth' | 'title' | 'precondition' | 'steps' | 'expectedResult';
export type TestAssetContent = Pick<TestCase, TestAssetContentField>;

export const testAssetContentFields: TestAssetContentField[] = ['category', 'feature', 'depth', 'title', 'precondition', 'steps', 'expectedResult'];

export interface AnalyzedImportRow {
  row: TestAssetImportRow;
  issues: TestAssetImportIssue[];
  kind: TestAssetMatchKind;
  /** exact_match · changed의 대상 기존 TC */
  targetId?: string;
  /** conflict에서 비교할 기존 TC 후보 */
  candidateIds: string[];
  conflictReason?: TestAssetConflictReason;
  /** changed에서 실제로 바뀌는 필드와 새 값 */
  changes?: Partial<TestAssetContent>;
}

export interface TestAssetImportAnalysis {
  /** 전체 가져오기를 막는 문제 */
  fileProblems: string[];
  notices: string[];
  rows: AnalyzedImportRow[];
  /** 건너뛴 빈 행 수 */
  blankRows: number;
}

/** 고객사 TC ID가 없을 때 같은 TC를 찾는 내용 기준. 원본 형식 내보내기도 ID 없는 새 행을 같은 기준으로 확인한다. */
export const compositeKey = (content: { feature?: string; title?: string; precondition?: string; expectedResult?: string }) =>
  [content.feature, content.title, content.precondition, content.expectedResult].map(normalizeText).join('\u0000');

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((item, index) => normalizeText(item) === normalizeText(b[index]));

/** 파일이 소유한 필드 중 기존 TC와 실제로 다른 것만 모은다. 매핑하지 않은 필드는 기존 값을 그대로 둔다. 원본 형식 내보내기도 같은 기준으로 바뀐 칸을 고른다. */
export function contentChanges(row: TestAssetImportRow, target: TestCase, fields: Set<TestAssetImportField>): Partial<TestAssetContent> {
  const changes: Partial<TestAssetContent> = {};
  if (row.category && row.category !== target.category) changes.category = row.category;
  if (row.feature && normalizeText(row.feature) !== normalizeText(target.feature)) changes.feature = row.feature;
  // 대분류는 기능과 함께 늘 파일이 소유하고, 중분류 · 소분류는 연결했을 때만 바꾼다.
  const [depth1, depth2, depth3] = row.depthLevels;
  const depth = [
    depth1 ?? target.depth[0],
    fields.has('depth2') ? depth2 : target.depth[1],
    fields.has('depth3') ? depth3 : target.depth[2],
    ...target.depth.slice(3),
  ].filter((item): item is string => !!item);
  if (!sameList(depth, target.depth)) changes.depth = depth;
  if (row.title && normalizeText(row.title) !== normalizeText(target.title)) changes.title = row.title;
  if (fields.has('precondition') && normalizeText(row.precondition) !== normalizeText(target.precondition)) changes.precondition = row.precondition;
  if (row.steps && !sameList(row.steps, target.steps)) changes.steps = row.steps;
  if (row.expectedResult && normalizeText(row.expectedResult) !== normalizeText(target.expectedResult)) changes.expectedResult = row.expectedResult;
  return changes;
}

const groupBy = <T>(items: T[], key: (item: T) => string | undefined) => {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    if (value === undefined) continue;
    map.set(value, [...(map.get(value) ?? []), item]);
  }
  return map;
};

/**
 * 파일 표를 검증하고 프로젝트의 기존 TC와 맞춰 본다. 입력은 바꾸지 않는다.
 * 매칭은 확실한 기준만 쓴다: 고객사 TC ID 정확 일치 → (ID가 없을 때) 기능 · 테스트 항목 · Pre-condition · Expected Result 정확 일치.
 * 테스트 항목 하나만 같다고 같은 TC로 보지 않고, 비슷한 내용을 추측하지 않는다.
 */
export function analyzeTestAssetImport(table: ImportTable, mapping: ColumnMapping, existing: TestCase[]): TestAssetImportAnalysis {
  const mappingProblems = columnMappingProblems(table.headers, mapping);
  if (mappingProblems.length > 0) return { fileProblems: mappingProblems, notices: [], rows: [], blankRows: 0 };

  const fields = mappedFields(mapping);
  const dataRows = table.rows.filter((row) => !isBlank(row.cells));
  const parsed = dataRows.map((row) => parseImportRow(row, mapping));

  const rows: AnalyzedImportRow[] = parsed.map((row) => ({ row, issues: [], kind: 'invalid', candidateIds: [] }));
  const error = (item: AnalyzedImportRow, message: string) => item.issues.push({ level: 'error', message });
  const warn = (item: AnalyzedImportRow, message: string) => item.issues.push({ level: 'warning', message });

  /* 행 단위 검증 */
  const rowsByExternalId = groupBy(rows, (item) => item.row.externalId);
  for (const item of rows) {
    const { row } = item;
    if (!row.title) error(item, '테스트 항목이 비어 있어요.');
    if (!row.expectedResult) error(item, 'Expected Result가 비어 있어요.');
    if (!row.feature) error(item, '기능(대분류)이 비어 있어요.');
    if (row.externalId) {
      const others = rowsByExternalId.get(row.externalId)!.filter((other) => other !== item);
      if (others.length > 0) error(item, `고객사 TC ID ${row.externalId}가 ${others.map((other) => `${other.row.rowNumber}행`).join(', ')}에도 있어요.`);
    } else if (fields.has('externalId')) {
      warn(item, '고객사 TC ID가 비어 있어요. 내용이 정확히 같은 기존 TC만 찾고, 없으면 ID 없이 가져와요.');
    }
    if (row.categoryRaw && !row.category) warn(item, `구분 값 '${row.categoryRaw}'을(를) 알 수 없어요. 새 TC는 '${testPerspectiveLabel.normal_flow}'으로 가져오고 기존 TC는 기존 값을 유지해요.`);
    if (row.steps && row.steps.length === 0) warn(item, 'Test Step이 비어 있어요.');
  }

  const valid = rows.filter((item) => !item.issues.some((issue) => issue.level === 'error'));
  for (const [, group] of groupBy(valid, (item) => (item.row.externalId ? undefined : compositeKey(item.row)))) {
    if (group.length < 2) continue;
    for (const item of group) {
      const others = group.filter((other) => other !== item).map((other) => `${other.row.rowNumber}행`);
      warn(item, `${others.join(', ')}과 내용이 같아요.`);
    }
  }

  /* 기존 TC 매칭 */
  const byExternalId = groupBy(existing, (testCase) => clean(testCase.externalId));
  const byContent = groupBy(existing, compositeKey);
  const claims = new Map<string, { item: AnalyzedImportRow; by: 'external_id' | 'content' }[]>();
  const claim = (item: AnalyzedImportRow, target: TestCase, by: 'external_id' | 'content') => {
    item.targetId = target.id;
    claims.set(target.id, [...(claims.get(target.id) ?? []), { item, by }]);
  };
  const conflict = (item: AnalyzedImportRow, reason: TestAssetConflictReason, candidates: TestCase[]) => {
    item.kind = 'conflict';
    item.conflictReason = reason;
    item.targetId = undefined;
    item.candidateIds = candidates.map((testCase) => testCase.id);
  };

  for (const item of valid) {
    const { row } = item;
    const sameContent = byContent.get(compositeKey(row)) ?? [];
    if (row.externalId) {
      const holders = byExternalId.get(row.externalId) ?? [];
      if (holders.length > 1) conflict(item, 'ambiguous_external_id', holders);
      else if (holders.length === 1) claim(item, holders[0], 'external_id');
      else if (sameContent.length > 0) conflict(item, 'external_id_mismatch', sameContent);
      else item.kind = 'new';
    } else if (sameContent.length > 1) conflict(item, 'ambiguous_content', sameContent);
    else if (sameContent.length === 1) claim(item, sameContent[0], 'content');
    else item.kind = 'new';
  }

  // 한 기존 TC는 한 행만 가리킬 수 있다. 고객사 TC ID로 찾은 행이 우선이고, 내용으로만 찾은 행끼리 겹치면 모두 충돌이다.
  const byId = new Map(existing.map((testCase) => [testCase.id, testCase]));
  for (const [targetId, group] of claims) {
    const target = byId.get(targetId)!;
    const winner = group.length === 1 ? group[0] : group.find((entry) => entry.by === 'external_id');
    for (const entry of group) {
      if (entry !== winner) {
        conflict(entry.item, 'shared_target', [target]);
        continue;
      }
      const changes = contentChanges(entry.item.row, target, fields);
      entry.item.kind = Object.keys(changes).length > 0 ? 'changed' : 'exact_match';
      if (entry.item.kind === 'changed') {
        entry.item.changes = changes;
        if (target.status === 'deprecated') warn(entry.item, '폐기된 TC예요. 업데이트하면 재검토 필요 상태로 돌아와요.');
      }
    }
  }

  const fileProblems = valid.length === 0 ? ['가져올 수 있는 행이 없어요.'] : [];
  return { fileProblems, notices: columnMappingNotices(mapping), rows, blankRows: table.rows.length - dataRows.length };
}

export type TestAssetImportSummary = Record<TestAssetMatchKind, number>;

export function summarizeTestAssetImport(analysis: TestAssetImportAnalysis): TestAssetImportSummary {
  const summary: TestAssetImportSummary = { new: 0, exact_match: 0, changed: 0, conflict: 0, invalid: 0 };
  for (const item of analysis.rows) summary[item.kind] += 1;
  return summary;
}

/* ---------- 사용자 판단 ---------- */

export type TestAssetImportDecision = 'pending' | 'import' | 'update' | 'create_separate' | 'excluded';

/** 이 판정에서 고를 수 있는 처리. 비어 있으면 판단하지 않는 행이다. */
export function decisionOptionsFor(item: AnalyzedImportRow): TestAssetImportDecision[] {
  if (item.kind === 'new') return ['import', 'excluded'];
  if (item.kind === 'changed') return ['update', 'excluded'];
  // 같은 고객사 TC ID를 쓰는 기존 TC가 여럿이면 별도 신규 TC도 같은 ID를 또 쓰게 되므로 제외만 할 수 있다.
  if (item.kind === 'conflict') return item.conflictReason === 'ambiguous_external_id' ? ['excluded'] : ['create_separate', 'excluded'];
  return [];
}

/** 신규는 가져오기가 기본이고, 기존 TC를 바꾸거나 identity가 불확실한 행은 사람이 고른다. */
export function defaultDecisionFor(item: AnalyzedImportRow): TestAssetImportDecision | undefined {
  if (item.kind === 'new') return 'import';
  if (item.kind === 'changed' || item.kind === 'conflict') return 'pending';
  return undefined;
}

export interface TestAssetImportRowDecision {
  rowNumber: number;
  /** 미리보기에서 본 판정과 대상. 반영 시점에 다시 계산한 판정과 다르면 반영하지 않는다. */
  kind: TestAssetMatchKind;
  targetId?: string;
  decision: TestAssetImportDecision;
}

/* ---------- 반영 ---------- */

export class TestAssetImportError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`TC를 가져올 수 없어요. ${problems[0]}${problems.length > 1 ? ` 외 ${problems.length - 1}건` : ''}`);
    this.name = 'TestAssetImportError';
    this.problems = problems;
  }
}

export interface TestAssetImportOptions {
  projectId: string;
  fileName: string;
  now: string;
  createId: (prefix: string) => string;
  /** 새 TC에 붙일 프로젝트의 고객사 Template */
  templateId?: string;
}

export interface TestAssetImportPlan {
  /** 입력 TC 전체에 반영 결과를 적용한 목록 */
  testCases: TestCase[];
  session: TestAssetImportSession;
}

/**
 * 판단이 끝난 가져오기를 TC 목록에 반영한 결과를 계산한다. 입력은 바꾸지 않는다.
 * 1단계에서 파일 문제 · 오류 행 · 미판단 · 미리보기와 다른 판정 · 고객사 TC ID 중복을 모두 검사한다.
 * 문제가 하나라도 있으면 새 ID를 하나도 만들지 않고 예외를 던진다. 2단계에서만 ID를 할당한다.
 * 가져오기 목록에 없는 기존 TC는 재-가져오기일 수 있으므로 절대 삭제 · 폐기하지 않는다.
 */
export function planTestAssetImport(
  analysis: TestAssetImportAnalysis,
  decisions: TestAssetImportRowDecision[],
  testCases: TestCase[],
  options: TestAssetImportOptions,
): TestAssetImportPlan {
  const problems: string[] = [...analysis.fileProblems];
  const invalidRows = analysis.rows.filter((item) => item.kind === 'invalid');
  if (invalidRows.length > 0) problems.push(`오류 행이 ${invalidRows.length}건 있어요. 파일을 고친 뒤 다시 가져와 주세요.`);

  const projectCases = testCases.filter((testCase) => testCase.projectId === options.projectId);
  const byId = new Map(projectCases.map((testCase) => [testCase.id, testCase]));
  const decisionByRow = new Map(decisions.map((decision) => [decision.rowNumber, decision]));

  type Work = { type: 'create'; item: AnalyzedImportRow } | { type: 'update'; item: AnalyzedImportRow; target: TestCase };
  const work: Work[] = [];
  let unchanged = 0;
  let excluded = 0;
  let pending = 0;
  const touched = new Set<string>();

  for (const item of analysis.rows) {
    if (item.kind === 'invalid') continue;
    const label = `${item.row.rowNumber}행`;
    const decision = decisionByRow.get(item.row.rowNumber);
    if (decision && (decision.kind !== item.kind || decision.targetId !== item.targetId)) {
      problems.push(`${label}: 미리보기 이후 기존 TC가 바뀌어 판정이 달라졌어요. 다시 확인해 주세요.`);
      continue;
    }
    if (item.kind === 'exact_match') {
      unchanged += 1;
      continue;
    }
    const value = decision?.decision ?? 'pending';
    if (value === 'pending') {
      pending += 1;
      continue;
    }
    if (!decisionOptionsFor(item).includes(value)) {
      problems.push(`${label}: 이 판정에서는 고를 수 없는 처리예요.`);
      continue;
    }
    if (value === 'excluded') {
      excluded += 1;
      continue;
    }
    if (value === 'update') {
      const target = item.targetId ? byId.get(item.targetId) : undefined;
      if (!target) problems.push(`${label}: 대상 TC를 찾을 수 없어요. (${item.targetId ?? '없음'})`);
      else if (touched.has(target.id)) problems.push(`${label}: 같은 TC를 바꾸는 행이 둘 이상이에요. (${target.externalId ?? target.id})`);
      else {
        touched.add(target.id);
        work.push({ type: 'update', item, target });
      }
      continue;
    }
    work.push({ type: 'create', item });
  }
  if (pending > 0) problems.push(`판단하지 않은 행이 ${pending}건 있어요.`);
  else if (problems.length === 0 && work.length === 0) problems.push('새로 만들거나 업데이트할 TC가 없어요.');

  // 프로젝트 안에서 비어 있지 않은 고객사 TC ID는 한 TC만 쓴다. 업데이트는 기존 ID를 그대로 쓰므로 새로 만드는 TC만 본다.
  const takenExternalIds = new Set(projectCases.map((testCase) => clean(testCase.externalId)).filter((id): id is string => !!id));
  for (const entry of work) {
    const externalId = entry.type === 'create' ? entry.item.row.externalId : undefined;
    if (!externalId) continue;
    if (takenExternalIds.has(externalId)) problems.push(`${entry.item.row.rowNumber}행: 고객사 TC ID ${externalId}를 이미 다른 TC가 쓰고 있어요.`);
    takenExternalIds.add(externalId);
  }

  if (problems.length > 0) throw new TestAssetImportError(problems);

  /* 2단계: 검증을 모두 통과했을 때만 새 ID를 할당하고 결과를 만든다. */
  const sessionId = options.createId('tai');
  const updates = new Map<string, TestCase>();
  const created: TestCase[] = [];

  for (const entry of work) {
    const { row } = entry.item;
    const importSource = { sessionId, rowNumber: row.rowNumber };
    if (entry.type === 'create') {
      created.push({
        id: options.createId('tc'),
        projectId: options.projectId,
        ...(options.templateId && { templateId: options.templateId }),
        ...(row.externalId && { externalId: row.externalId }),
        category: row.category ?? 'normal_flow',
        feature: row.feature!,
        depth: [...row.depth],
        title: row.title!,
        ...(row.precondition && { precondition: row.precondition }),
        steps: [...(row.steps ?? [])],
        expectedResult: row.expectedResult!,
        // 파일에는 Looma 요구사항 · 테스트 조건 ID가 없다. 추측해서 잇지 않고 이후 요구사항 화면에서 연결한다.
        requirementIds: [],
        testConditionIds: [],
        sourceRefs: [],
        // 고객사가 이미 쓰던 TC 정의 자체가 근거다.
        generationType: 'imported_existing',
        origin: 'imported',
        // 가져온 TC도 기존 검토 흐름을 거친다. 자동으로 사용 중(active)으로 만들지 않는다.
        status: 'draft',
        revision: 1,
        importSource,
        createdAt: options.now,
        updatedAt: options.now,
      });
      continue;
    }
    const changes = structuredClone(entry.item.changes ?? {});
    const merged: TestCase = { ...entry.target, ...changes };
    if ('precondition' in changes && !changes.precondition) delete merged.precondition;
    const contentChanged = testAssetContentFields.some((field) => JSON.stringify(entry.target[field]) !== JSON.stringify(merged[field]));
    if (!contentChanged) {
      unchanged += 1;
      continue;
    }
    // 내부 ID · 고객사 TC ID · 요구사항 · 테스트 조건 · 근거 연결은 파일이 소유하지 않으므로 그대로 둔다.
    updates.set(entry.target.id, {
      ...merged,
      revision: entry.target.revision + 1,
      origin: 'import_modified',
      status: 'needs_review',
      importSource,
      updatedAt: options.now,
    });
  }

  return {
    testCases: [...testCases.map((testCase) => updates.get(testCase.id) ?? testCase), ...created],
    session: {
      id: sessionId,
      projectId: options.projectId,
      fileName: options.fileName,
      importedAt: options.now,
      totalRows: analysis.rows.length,
      created: created.length,
      updated: updates.size,
      unchanged,
      excluded,
    },
  };
}
