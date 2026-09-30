import { platformLabel, resultImportFieldLabel, testResultLabel } from './labels';
import { countResults, mapRawResult, type ResultCounts } from './resultSummary';
import type { ImportTable, ImportTableRow } from './testAssetImport';
import type { ExecutionType, Platform, ResultMapping, TestCase, TestResult, TestResultImport, TestResultValue } from './types';

/*
 * 수행 결과 가져오기 — 고객사에서 수행을 마친 결과 파일을 새 수행 차수(TestResultImport)와 결과(TestResult)로 저장한다.
 * 파일 parser → ImportTable(TC 자산 가져오기와 같은 표) → 컬럼 매핑 → 정규화 행 → 결과 값 정규화 · 기준 TC 연결 → 사용자 판단 → 반영 계획.
 * 수행 결과는 TC 정의를 소유하지 않는다. 이 흐름은 기준 TC를 만들거나 바꾸지 않고, 결과를 잘못된 TC에 붙이느니 미연결로 남긴다.
 */

/* ---------- 컬럼 매핑 ---------- */

export type ResultImportField =
  | 'externalId'
  | 'title'
  | 'feature'
  | 'result'
  | 'platform'
  | 'note'
  | 'result_android'
  | 'result_ios'
  | 'result_web'
  | 'result_desktop';

/** 플랫폼별 결과 컬럼. 고객사 양식이 Android · iOS 열에 결과를 따로 적는 경우에 쓴다. */
export const platformResultFields: Record<Platform, ResultImportField> = {
  android: 'result_android',
  ios: 'result_ios',
  web: 'result_web',
  desktop: 'result_desktop',
};

const platformByResultField = new Map((Object.entries(platformResultFields) as [Platform, ResultImportField][]).map(([platform, field]) => [field, platform]));

export const resultImportFields: ResultImportField[] = [
  'externalId',
  'title',
  'feature',
  'result',
  'platform',
  'note',
  'result_android',
  'result_ios',
  'result_web',
  'result_desktop',
];

/** 파일 컬럼 순서대로 연결한 Looma 필드. 연결하지 않은 컬럼은 null. */
export type ResultColumnMapping = (ResultImportField | null)[];

const headerKey = (header: string) => header.normalize('NFC').toLowerCase().replace(/[\s_\-./]/g, '');

// 이름만으로 뜻이 분명한 경우만 자동으로 연결한다. "ID", "상태"처럼 뜻이 갈리거나
// "Android" · "iOS"처럼 결과 열인지 플랫폼 표시 열인지 파일마다 다른 이름은 사용자가 고른다.
const headerAliases: Partial<Record<ResultImportField, string[]>> = {
  externalId: ['tcid', 'testcaseid', 'tcno', 'tc번호', '고객사tcid'],
  title: ['테스트항목', 'tc명', '테스트케이스명', 'testcasename', 'title', '제목'],
  feature: ['기능', '기능명', 'feature', '대분류'],
  result: ['result', '결과', '수행결과', '테스트결과', 'testresult'],
  platform: ['platform', '플랫폼'],
  note: ['note', '비고', 'remark', 'remarks', '메모'],
};

/** 명백한 컬럼명만 후보로 연결한다. 같은 필드 후보가 여럿이면 첫 컬럼만 연결한다. */
export function suggestResultColumnMapping(headers: string[]): ResultColumnMapping {
  const used = new Set<ResultImportField>();
  return headers.map((header) => {
    const key = headerKey(header);
    const field = resultImportFields.find((candidate) => !used.has(candidate) && headerAliases[candidate]?.includes(key));
    if (!field) return null;
    used.add(field);
    return field;
  });
}

const mappedFields = (mapping: ResultColumnMapping) => new Set(mapping.filter((field): field is ResultImportField => !!field));
const hasPlatformResultColumns = (fields: Set<ResultImportField>) => [...platformByResultField.keys()].some((field) => fields.has(field));

/** 전체 가져오기를 막는 매핑 문제 */
export function resultColumnMappingProblems(headers: string[], mapping: ResultColumnMapping): string[] {
  const problems: string[] = [];
  for (const field of resultImportFields) {
    const columns = headers.filter((_, index) => mapping[index] === field);
    if (columns.length > 1) problems.push(`'${resultImportFieldLabel[field]}'에 컬럼이 둘 이상 연결됐어요. (${columns.join(', ')})`);
  }
  const fields = mappedFields(mapping);
  // 제목만으로는 TC를 연결하지 않으므로 고객사 TC ID는 필수다.
  if (!fields.has('externalId')) problems.push(`'${resultImportFieldLabel.externalId}' 컬럼을 연결해 주세요. 결과는 고객사 TC ID로만 TC에 연결해요.`);
  const platformColumns = hasPlatformResultColumns(fields);
  if (!fields.has('result') && !platformColumns) problems.push(`'${resultImportFieldLabel.result}' 또는 플랫폼별 결과 컬럼을 연결해 주세요.`);
  if (fields.has('result') && platformColumns) problems.push(`'${resultImportFieldLabel.result}'과 플랫폼별 결과 컬럼은 함께 연결할 수 없어요. 한 가지 방식만 골라 주세요.`);
  if (fields.has('platform') && platformColumns) problems.push(`플랫폼별 결과 컬럼을 쓰면 '${resultImportFieldLabel.platform}' 컬럼은 연결하지 않아요.`);
  return problems;
}

/** 차수의 기본 플랫폼을 고를 수 있는가. 결과 컬럼이 하나이고 행마다 플랫폼 컬럼이 없을 때만 쓴다. */
export function usesCyclePlatform(mapping: ResultColumnMapping): boolean {
  const fields = mappedFields(mapping);
  return fields.has('result') && !fields.has('platform');
}

/* ---------- 결과 값 정규화 ---------- */

/** 고객사 템플릿 매핑이 없을 때 쓰는 기본 표기. 대소문자는 구분하지 않는다. */
export const defaultResultAliases: ResultMapping[] = [
  ...['PASS', '성공', '정상'].map((rawValue) => ({ rawValue, result: 'pass' as const })),
  ...['FAIL', '실패', 'NG'].map((rawValue) => ({ rawValue, result: 'fail' as const })),
  ...['BLOCKED', 'BLOCK', '차단', '진행불가'].map((rawValue) => ({ rawValue, result: 'blocked' as const })),
  ...['NOT_TESTED', 'NOT TESTED', 'N/T', '미수행', '미실행'].map((rawValue) => ({ rawValue, result: 'not_tested' as const })),
];

/** 사용자 판단을 묶는 결과 원문 키. 앞뒤 공백과 대소문자만 무시한다. 빈 칸은 빈 문자열이다. */
export const resultValueKey = (raw: string) => raw.normalize('NFC').trim().toUpperCase();

/**
 * 결과 원문을 표준 결과로 바꾼다. 프로젝트 템플릿 매핑을 먼저 보고, 없으면 기본 표기를 본다.
 * 둘 다 없거나 빈 칸이면 undefined — 추측하지 않고 사용자에게 묻는다.
 */
export function normalizeResultValue(raw: string, templateMappings: ResultMapping[] = []): TestResultValue | undefined {
  if (resultValueKey(raw) === '') return undefined;
  return mapRawResult(raw.normalize('NFC'), templateMappings) ?? mapRawResult(raw.normalize('NFC'), defaultResultAliases);
}

/* ---------- 정규화 행 ---------- */

/** 한 행에서 읽은 결과 하나. 플랫폼별 결과 컬럼이면 한 행에 여럿이다. */
export interface ResultImportEntry {
  /** 결과를 읽은 파일 컬럼 */
  column: number;
  /** 행의 플랫폼 또는 플랫폼별 결과 컬럼의 플랫폼. 차수 기본 플랫폼은 반영할 때 붙인다. */
  platform?: Platform;
  /** 셀 원문 그대로 */
  rawResult: string;
  /** 알 수 있는 값이면 표준 결과 */
  result?: TestResultValue;
}

/** 파일의 한 행을 결과로 만들기 전 중간 모델. 원본 값과 해석한 값을 함께 둔다. */
export interface TestResultImportRow {
  rowNumber: number;
  /** 헤더 순서와 같은 원본 셀 값 */
  rawValues: string[];
  externalId?: string;
  title?: string;
  feature?: string;
  /** 플랫폼 원문. 알 수 없는 값이면 결과 항목의 platform이 비어 있다. */
  platformRaw?: string;
  note?: string;
  entries: ResultImportEntry[];
}

const clean = (value: string | undefined) => {
  const text = value?.normalize('NFC').trim();
  return text ? text : undefined;
};

const platformByText = new Map<string, Platform>([
  ...(Object.keys(platformLabel) as Platform[]).flatMap((platform) => [
    [platform, platform] as [string, Platform],
    [headerKey(platformLabel[platform]), platform] as [string, Platform],
  ]),
  ['aos', 'android'],
  ['안드로이드', 'android'],
  ['웹', 'web'],
  ['데스크톱', 'desktop'],
]);

export function parseResultRow(row: ImportTableRow, mapping: ResultColumnMapping, templateMappings: ResultMapping[] = []): TestResultImportRow {
  const value = (field: ResultImportField) => {
    const index = mapping.indexOf(field);
    return index < 0 ? undefined : clean(row.cells[index]);
  };
  const platformRaw = value('platform');
  const rowPlatform = platformRaw ? platformByText.get(headerKey(platformRaw)) : undefined;
  const entries: ResultImportEntry[] = [];
  mapping.forEach((field, column) => {
    if (field !== 'result' && !platformByResultField.has(field!)) return;
    const rawResult = row.cells[column] ?? '';
    const result = normalizeResultValue(rawResult, templateMappings);
    const platform = field === 'result' ? rowPlatform : platformByResultField.get(field!);
    entries.push({ column, ...(platform && { platform }), rawResult, ...(result && { result }) });
  });
  return {
    rowNumber: row.rowNumber,
    rawValues: [...row.cells],
    ...(value('externalId') && { externalId: value('externalId') }),
    ...(value('title') && { title: value('title') }),
    ...(value('feature') && { feature: value('feature') }),
    ...(platformRaw && { platformRaw }),
    ...(value('note') && { note: value('note') }),
    entries,
  };
}

/* ---------- 검증 · 연결 ---------- */

/**
 * matched: 고객사 TC ID가 기준 TC 하나와 정확히 같음 / unmatched: 연결할 TC 없음(원본 보존 가능)
 * conflict: 자동으로 반영하기 위험함 / invalid: 오류가 있어 가져올 수 없음
 */
export type ResultMatchKind = 'matched' | 'unmatched' | 'conflict' | 'invalid';

export type ResultConflictReason =
  /** 같은 고객사 TC ID를 쓰는 기준 TC가 여럿이다 */
  | 'ambiguous_external_id'
  /** 파일의 여러 행이 같은 TC · 플랫폼의 결과를 준다 */
  | 'duplicate_in_file';

export interface ResultImportIssue {
  level: 'error' | 'warning';
  message: string;
}

export interface AnalyzedResultRow {
  row: TestResultImportRow;
  issues: ResultImportIssue[];
  kind: ResultMatchKind;
  /** 연결할 기준 TC. matched이거나, 파일 안 중복 충돌이지만 TC는 하나로 정해진 경우 */
  testCaseId?: string;
  /** 충돌에서 비교할 기준 TC 후보 */
  candidateIds: string[];
  conflictReason?: ResultConflictReason;
}

/** 템플릿 · 기본 표기로 알 수 없는 결과 원문. 같은 키는 한 번만 판단한다. */
export interface UnknownResultValue {
  key: string;
  /** 처음 나온 원문 표기 */
  raw: string;
  /** 이 값을 쓴 결과 수(오류 행 제외) */
  count: number;
}

export interface TestResultImportAnalysis {
  /** 전체 가져오기를 막는 문제 */
  fileProblems: string[];
  notices: string[];
  rows: AnalyzedResultRow[];
  /** 건너뛴 빈 행 수 */
  blankRows: number;
  unknownValues: UnknownResultValue[];
}

const isBlank = (cells: string[]) => cells.every((cell) => cell.trim() === '');

const groupBy = <T>(items: T[], key: (item: T) => string | undefined) => {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    if (value === undefined) continue;
    map.set(value, [...(map.get(value) ?? []), item]);
  }
  return map;
};

/** 같은 차수 안에서 한 TC · 플랫폼의 결과는 하나다. 고객사 TC ID가 없는 행은 비교할 수 없다. */
const entryKeys = (row: TestResultImportRow) => (row.externalId ? row.entries.map((entry) => `${row.externalId}\u0000${entry.platform ?? ''}`) : []);

/**
 * 파일 표를 검증하고 프로젝트의 기준 TC와 연결한다. 입력은 바꾸지 않는다.
 * 연결은 고객사 TC ID 정확 일치만 쓴다. ID가 없거나 일치하는 TC가 없으면 제목이 같아도 연결하지 않는다.
 */
export function analyzeResultImport(
  table: ImportTable,
  mapping: ResultColumnMapping,
  testCases: TestCase[],
  templateMappings: ResultMapping[] = [],
): TestResultImportAnalysis {
  const mappingProblems = resultColumnMappingProblems(table.headers, mapping);
  if (mappingProblems.length > 0) return { fileProblems: mappingProblems, notices: [], rows: [], blankRows: 0, unknownValues: [] };

  const fields = mappedFields(mapping);
  const dataRows = table.rows.filter((row) => !isBlank(row.cells));
  const rows: AnalyzedResultRow[] = dataRows.map((row) => ({ row: parseResultRow(row, mapping, templateMappings), issues: [], kind: 'invalid', candidateIds: [] }));
  const error = (item: AnalyzedResultRow, message: string) => item.issues.push({ level: 'error', message });
  const warn = (item: AnalyzedResultRow, message: string) => item.issues.push({ level: 'warning', message });

  /* 행 단위 검증 */
  for (const item of rows) {
    const { row } = item;
    if (!row.externalId && !row.title) error(item, '고객사 TC ID와 테스트 항목이 모두 비어 있어요.');
    else if (!row.externalId) warn(item, '고객사 TC ID가 비어 있어요. 제목만으로는 TC에 연결하지 않아요.');
    if (row.platformRaw && !platformByText.has(headerKey(row.platformRaw))) error(item, `플랫폼 값 '${row.platformRaw}'을(를) 알 수 없어요.`);
  }

  /* 기준 TC 연결 */
  const valid = rows.filter((item) => !item.issues.some((issue) => issue.level === 'error'));
  const byExternalId = groupBy(testCases, (testCase) => clean(testCase.externalId));
  for (const item of valid) {
    const holders = item.row.externalId ? (byExternalId.get(item.row.externalId) ?? []) : [];
    if (holders.length > 1) {
      item.kind = 'conflict';
      item.conflictReason = 'ambiguous_external_id';
      item.candidateIds = holders.map((testCase) => testCase.id);
    } else if (holders.length === 1) {
      item.kind = 'matched';
      item.testCaseId = holders[0].id;
      if (holders[0].status === 'deprecated') warn(item, '폐기된 TC예요. 결과는 이 차수의 기록으로 연결돼요.');
    } else {
      item.kind = 'unmatched';
    }
  }

  // 같은 차수에서 한 TC · 플랫폼 결과를 마지막 행으로 덮어쓰지 않는다. 겹치는 행은 모두 충돌로 두고 사람이 고른다.
  const rowsByKey = new Map<string, AnalyzedResultRow[]>();
  for (const item of valid) for (const key of new Set(entryKeys(item.row))) rowsByKey.set(key, [...(rowsByKey.get(key) ?? []), item]);
  for (const group of rowsByKey.values()) {
    if (group.length < 2) continue;
    for (const item of group) {
      const others = group.filter((other) => other !== item).map((other) => `${other.row.rowNumber}행`);
      const message = `${others.join(', ')}과 같은 TC · 플랫폼 결과예요. 하나만 가져올 수 있어요.`;
      if (!item.issues.some((issue) => issue.message === message)) warn(item, message);
      if (item.kind !== 'conflict') {
        item.kind = 'conflict';
        item.conflictReason = 'duplicate_in_file';
      }
    }
  }

  /* 알 수 없는 결과 값 */
  const unknown = new Map<string, UnknownResultValue>();
  for (const item of valid) {
    for (const entry of item.row.entries) {
      if (entry.result) continue;
      const key = resultValueKey(entry.rawResult);
      const current = unknown.get(key);
      if (current) current.count += 1;
      else unknown.set(key, { key, raw: entry.rawResult.trim(), count: 1 });
    }
  }

  const notices: string[] = [];
  if (!fields.has('title')) notices.push('테스트 항목을 연결하지 않아 연결된 결과는 기준 TC 제목으로, 미연결 결과는 고객사 TC ID로만 보여요.');
  if (templateMappings.length > 0) notices.push(`고객사 Template의 상태값 매핑(${templateMappings.map((item) => `${item.rawValue} → ${testResultLabel[item.result]}`).join(', ')})을 먼저 적용했어요.`);

  const fileProblems = valid.length === 0 ? ['가져올 수 있는 행이 없어요.'] : [];
  return { fileProblems, notices, rows, blankRows: table.rows.length - dataRows.length, unknownValues: [...unknown.values()] };
}

export type ResultImportPreviewSummary = Record<ResultMatchKind, number> & {
  /** 판단이 필요한 결과 원문 종류 수 */
  unknownValues: number;
};

export function summarizeResultImportAnalysis(analysis: TestResultImportAnalysis): ResultImportPreviewSummary {
  const summary: ResultImportPreviewSummary = { matched: 0, unmatched: 0, conflict: 0, invalid: 0, unknownValues: analysis.unknownValues.length };
  for (const item of analysis.rows) summary[item.kind] += 1;
  return summary;
}

/* ---------- 사용자 판단 ---------- */

/** import: 연결된 TC가 있으면 연결해서, 없으면 미연결 결과로 보존한다. */
export type ResultRowDecision = 'pending' | 'import' | 'excluded';

export function resultDecisionOptionsFor(item: AnalyzedResultRow): ResultRowDecision[] {
  return item.kind === 'invalid' ? [] : ['import', 'excluded'];
}

/** 연결된 행만 기본으로 가져온다. 미연결 · 충돌은 사람이 고른다. */
export function defaultResultDecisionFor(item: AnalyzedResultRow): ResultRowDecision | undefined {
  if (item.kind === 'matched') return 'import';
  if (item.kind === 'unmatched' || item.kind === 'conflict') return 'pending';
  return undefined;
}

/** 가져오면 어느 TC에 붙는가. 같은 ID의 TC가 여럿인 충돌은 추측하지 않고 미연결로 보존한다. */
export const linkedTestCaseId = (item: AnalyzedResultRow) => (item.conflictReason === 'ambiguous_external_id' ? undefined : item.testCaseId);

export interface ResultImportRowDecision {
  rowNumber: number;
  /** 미리보기에서 본 판정과 연결 대상. 반영 시점에 다시 계산한 값과 다르면 반영하지 않는다. */
  kind: ResultMatchKind;
  testCaseId?: string;
  decision: ResultRowDecision;
}

/** 알 수 없는 결과 원문에 대한 판단. excluded는 그 값을 가진 결과를 저장하지 않는다. */
export type ResultValueDecision = TestResultValue | 'excluded' | 'pending';

/* ---------- 차수 정보 ---------- */

export interface ResultCycleInput {
  round: number;
  executionType: ExecutionType;
  executedFrom: string;
  executedTo?: string;
  environment?: string;
  platform?: Platform;
  note?: string;
}

/** 프로젝트의 가장 큰 차수 + 1 */
export function suggestNextRound(imports: Pick<TestResultImport, 'round'>[]): number {
  return imports.reduce((max, item) => Math.max(max, item.round), 0) + 1;
}

const isDate = (value: string | undefined) => !!value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const executionTypes: ExecutionType[] = ['full', 'partial', 'retest', 'release_candidate'];

/** 차수 정보 문제. 차수는 1 이상의 정수이고 프로젝트 안에서 겹치지 않는다. */
export function resultCycleProblems(cycle: ResultCycleInput, existing: Pick<TestResultImport, 'round'>[]): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(cycle.round) || cycle.round < 1) problems.push('차수는 1 이상의 정수로 입력해 주세요.');
  else if (existing.some((item) => item.round === cycle.round)) problems.push(`${cycle.round}차는 이미 있어요. 다른 차수를 입력해 주세요.`);
  if (!executionTypes.includes(cycle.executionType)) problems.push('수행 유형을 골라 주세요.');
  if (!isDate(cycle.executedFrom)) problems.push('수행일을 입력해 주세요.');
  if (cycle.executedTo && !isDate(cycle.executedTo)) problems.push('수행 종료일 형식이 올바르지 않아요.');
  else if (cycle.executedTo && isDate(cycle.executedFrom) && cycle.executedTo < cycle.executedFrom) problems.push('수행 종료일이 시작일보다 빨라요.');
  if (cycle.platform && !(cycle.platform in platformLabel)) problems.push('플랫폼 값이 올바르지 않아요.');
  return problems;
}

/* ---------- 반영 ---------- */

export class ResultImportError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`수행 결과를 가져올 수 없어요. ${problems[0]}${problems.length > 1 ? ` 외 ${problems.length - 1}건` : ''}`);
    this.name = 'ResultImportError';
    this.problems = problems;
  }
}

export interface ResultImportOptions {
  projectId: string;
  fileName: string;
  now: string;
  createId: (prefix: string) => string;
}

export interface ResultImportPlan {
  resultImport: TestResultImport;
  results: TestResult[];
}

/** 미연결이고 파일에 기능도 없는 결과의 기능 표기 */
export const UNMATCHED_FEATURE = '미연결';

/**
 * 판단이 끝난 가져오기를 새 수행 차수와 결과로 만든다. 입력(기준 TC 포함)은 바꾸지 않는다.
 * 1단계에서 파일 · 차수 · 오류 행 · 미판단 · 판정 변경 · 결과 값 · 중복을 모두 검사하고, 문제가 하나라도 있으면
 * 새 ID를 하나도 만들지 않고 예외를 던진다. 2단계에서만 차수 · 결과 ID를 할당한다.
 */
export function planResultImport(
  analysis: TestResultImportAnalysis,
  rowDecisions: ResultImportRowDecision[],
  valueDecisions: Record<string, ResultValueDecision>,
  cycle: ResultCycleInput,
  context: { testCases: TestCase[]; existingImports: Pick<TestResultImport, 'round'>[]; cyclePlatformAllowed: boolean },
  options: ResultImportOptions,
): ResultImportPlan {
  const problems: string[] = [...analysis.fileProblems, ...resultCycleProblems(cycle, context.existingImports)];
  const invalidRows = analysis.rows.filter((item) => item.kind === 'invalid');
  if (invalidRows.length > 0) problems.push(`오류 행이 ${invalidRows.length}건 있어요. 파일을 고친 뒤 다시 가져와 주세요.`);

  const testCaseById = new Map(context.testCases.map((testCase) => [testCase.id, testCase]));
  const decisionByRow = new Map(rowDecisions.map((decision) => [decision.rowNumber, decision]));
  const imported: AnalyzedResultRow[] = [];
  let pendingRows = 0;

  for (const item of analysis.rows) {
    if (item.kind === 'invalid') continue;
    const label = `${item.row.rowNumber}행`;
    const decision = decisionByRow.get(item.row.rowNumber);
    if (decision && (decision.kind !== item.kind || decision.testCaseId !== item.testCaseId)) {
      problems.push(`${label}: 미리보기 이후 기준 TC가 바뀌어 연결 판정이 달라졌어요. 다시 확인해 주세요.`);
      continue;
    }
    const value = decision?.decision ?? defaultResultDecisionFor(item) ?? 'pending';
    if (value === 'pending') pendingRows += 1;
    else if (!resultDecisionOptionsFor(item).includes(value)) problems.push(`${label}: 이 판정에서는 고를 수 없는 처리예요.`);
    else if (value === 'import') {
      const testCaseId = linkedTestCaseId(item);
      if (testCaseId && !testCaseById.has(testCaseId)) problems.push(`${label}: 연결할 TC를 찾을 수 없어요. (${testCaseId})`);
      else imported.push(item);
    }
  }
  if (pendingRows > 0) problems.push(`판단하지 않은 행이 ${pendingRows}건 있어요.`);

  // 가져오는 결과의 원문이 모두 표준 결과로 정해졌는가. 템플릿이 바뀌었으면 다시 계산한 분석 기준으로 묻는다.
  const unknownKeys = new Set(analysis.unknownValues.map((item) => item.key));
  const pendingValues = new Set<string>();
  const resolve = (entry: ResultImportEntry): TestResultValue | 'excluded' | undefined => {
    if (entry.result) return entry.result;
    const key = resultValueKey(entry.rawResult);
    const chosen = unknownKeys.has(key) ? valueDecisions[key] : undefined;
    if (!chosen || chosen === 'pending') {
      pendingValues.add(key);
      return undefined;
    }
    return chosen;
  };

  type Work = { item: AnalyzedResultRow; entry: ResultImportEntry; result: TestResultValue };
  const work: Work[] = [];
  const seen = new Map<string, number>();
  for (const item of imported) {
    const keys = entryKeys(item.row);
    item.row.entries.forEach((entry, index) => {
      const result = resolve(entry);
      if (!result || result === 'excluded') return;
      const key = keys[index];
      if (key !== undefined) {
        const first = seen.get(key);
        if (first !== undefined) {
          problems.push(`${item.row.rowNumber}행: ${first}행과 같은 TC · 플랫폼 결과를 함께 가져올 수 없어요.`);
          return;
        }
        seen.set(key, item.row.rowNumber);
      }
      work.push({ item, entry, result });
    });
  }
  if (pendingValues.size > 0) problems.push(`결과 값 ${pendingValues.size}종을 PASS · FAIL · BLOCKED · 미수행 중 하나로 정하거나 제외해 주세요.`);
  if (problems.length === 0 && work.length === 0) problems.push('가져올 결과가 없어요.');

  if (problems.length > 0) throw new ResultImportError(problems);

  /* 2단계: 검증을 모두 통과했을 때만 새 ID를 할당하고 결과를 만든다. */
  const importId = options.createId('imp');
  const cyclePlatform = context.cyclePlatformAllowed ? cycle.platform : undefined;
  const usedMappings = new Map<string, ResultMapping>();

  const results: TestResult[] = work.map(({ item, entry, result }) => {
    const { row } = item;
    const testCase = linkedTestCaseId(item) ? testCaseById.get(linkedTestCaseId(item)!) : undefined;
    const platform = entry.platform ?? cyclePlatform;
    const key = resultValueKey(entry.rawResult);
    if (!usedMappings.has(key)) usedMappings.set(key, { rawValue: entry.rawResult.trim(), result });
    return {
      id: options.createId('res'),
      importId,
      ...(testCase && { testCaseId: testCase.id }),
      ...(row.externalId && { externalId: row.externalId }),
      // 기능은 TC 정의가 소유한다. 미연결 결과만 파일 값을 쓴다.
      feature: testCase?.feature ?? row.feature ?? UNMATCHED_FEATURE,
      title: row.title ?? testCase?.title ?? row.externalId ?? '',
      ...(platform && { platform }),
      result,
      rawResult: entry.rawResult,
      sourceRowNumber: row.rowNumber,
      ...(row.note && { note: row.note }),
    };
  });

  const order: TestResultValue[] = ['pass', 'fail', 'blocked', 'not_tested'];
  const resultImport: TestResultImport = {
    id: importId,
    projectId: options.projectId,
    round: cycle.round,
    fileRef: options.fileName,
    importedAt: options.now,
    mapping: [...usedMappings.values()].sort((a, b) => order.indexOf(a.result) - order.indexOf(b.result)),
    executionType: cycle.executionType,
    executedFrom: cycle.executedFrom,
    ...(cycle.executedTo && cycle.executedTo !== cycle.executedFrom && { executedTo: cycle.executedTo }),
    ...(clean(cycle.environment) && { environment: clean(cycle.environment) }),
    ...(cyclePlatform && { platform: cyclePlatform }),
    ...(clean(cycle.note) && { note: clean(cycle.note) }),
  };

  return { resultImport, results };
}

/* ---------- 차수 요약 ---------- */

export type ResultImportSummary = ResultCounts & { linked: number; unlinked: number };

/** 한 차수의 결과 요약. 미연결은 기준 TC에 연결되지 않은 결과 수다. */
export function summarizeResultImport(results: TestResult[]): ResultImportSummary {
  const linked = results.filter((result) => result.testCaseId).length;
  return { ...countResults(results), linked, unlinked: results.length - linked };
}

export function resultImportSummaryText(summary: ResultImportSummary): string {
  return `총 ${summary.total} · PASS ${summary.pass} · FAIL ${summary.fail} · BLOCKED ${summary.blocked} · ${testResultLabel.not_tested} ${summary.not_tested} · 미연결 ${summary.unlinked}`;
}
