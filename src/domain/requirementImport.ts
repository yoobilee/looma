import { requirementImportFieldLabel } from './labels';
import type { ImportTable } from './testAssetImport';
import type { Requirement } from './types';

/*
 * 요구사항 파일 가져오기 — 이미 정리된 요구사항 표(CSV · XLSX)를 이 프로젝트의 요구사항으로 가져온다. AI 분석이 아니다.
 * ImportTable → 열 매핑 → 후보 행(RequirementCandidate) → 판정(신규 · 중복 · 오류) → 사용자 제외 → 생성 계획(Requirement).
 * 후보 행부터는 파일 형식도 파일 열도 모른다. 나중에 AI가 문서에서 같은 후보 행을 만들면 classifyRequirementCandidates ·
 * planRequirementImport를 그대로 쓸 수 있다. 기존 요구사항은 읽기만 하고 고치지 않는다(동기화가 아니라 새 요구사항 가져오기다).
 */

/* ---------- 열 매핑 ---------- */

export type RequirementImportField = 'feature' | 'text' | 'locator' | 'needsConfirmation';

export const requirementImportFields: RequirementImportField[] = ['feature', 'text', 'locator', 'needsConfirmation'];

/** 파일 열 순서대로 연결한 Looma 필드. 연결하지 않은 열은 null. */
export type RequirementColumnMapping = (RequirementImportField | null)[];

const headerKey = (header: string) => header.normalize('NFC').toLowerCase().replace(/[\s_\-./]/g, '');

// 이름만으로 뜻이 분명한 경우만 자동으로 연결한다. 같은 필드 후보가 여럿이면 첫 열만 연결한다.
const headerAliases: Record<RequirementImportField, string[]> = {
  feature: ['기능', '기능명', 'feature'],
  text: ['요구사항', '요구사항내용', '요구사항명', 'requirement', 'requirements'],
  locator: ['출처', '출처위치', '페이지', '위치', '페이지위치', 'locator', 'page'],
  needsConfirmation: ['확인필요', '확인필요여부', 'needsconfirmation'],
};

export function suggestRequirementColumnMapping(headers: string[]): RequirementColumnMapping {
  const used = new Set<RequirementImportField>();
  return headers.map((header) => {
    const key = headerKey(header);
    const field = requirementImportFields.find((candidate) => !used.has(candidate) && headerAliases[candidate].includes(key));
    if (!field) return null;
    used.add(field);
    return field;
  });
}

/**
 * 가져오기를 막는 매핑 문제. 타입만 믿지 않고 실행 중 모양도 확인한다:
 * 파일 열 수와 같은 길이, 알려진 필드 또는 null, 기능 · 요구사항은 정확히 하나, 출처 위치 · 확인 필요는 최대 하나.
 */
export function requirementColumnMappingProblems(headers: string[], mapping: RequirementColumnMapping): string[] {
  if (!Array.isArray(mapping) || mapping.length !== headers.length) return ['요구사항 열 매핑 정보가 파일 열과 맞지 않아요.'];
  // 비어 있는 칸(undefined)도 알려지지 않은 값이다. find는 값이 undefined인 경우를 못 구분하므로 위치로 찾는다.
  const unknownIndex = Array.from(mapping).findIndex((field) => field !== null && !requirementImportFields.includes(field));
  if (unknownIndex >= 0) return [`알 수 없는 연결 필드예요. (${String(mapping[unknownIndex])})`];
  const problems: string[] = [];
  for (const field of requirementImportFields) {
    const columns = headers.filter((_, index) => mapping[index] === field);
    if (columns.length > 1) problems.push(`'${requirementImportFieldLabel[field]}'에 열이 둘 이상 연결됐어요. (${columns.join(', ')})`);
  }
  for (const field of ['feature', 'text'] as const) {
    if (!mapping.includes(field)) problems.push(`'${requirementImportFieldLabel[field]}' 열을 연결해 주세요.`);
  }
  return problems;
}

/**
 * 가져오기 입력(표 + 열 매핑)의 문제. 저장소처럼 화면 밖에서 직접 호출되는 곳에서 확인한다.
 * 표는 모든 행이 헤더와 같은 수의 칸을 가져야 하고(숨은 칸을 읽지 않도록 자르거나 채우지 않는다), 행 번호는 겹치지 않는 양의 정수여야 한다.
 */
export function requirementImportInputProblems(table: ImportTable, mapping: RequirementColumnMapping): string[] {
  const rowNumbers = new Set<number>();
  for (const row of table.rows) {
    if (!Array.isArray(row.cells) || row.cells.length !== table.headers.length) return [`${row.rowNumber}행의 칸 수가 파일 열 수와 맞지 않아요.`];
    if (!Number.isInteger(row.rowNumber) || row.rowNumber < 1 || rowNumbers.has(row.rowNumber)) return [`행 번호가 올바르지 않아요. (${String(row.rowNumber)})`];
    rowNumbers.add(row.rowNumber);
  }
  return requirementColumnMappingProblems(table.headers, mapping);
}

/* ---------- 후보 행 ---------- */

/** 요구사항이 될 한 행. 파일에서 만들었든 다른 곳에서 만들었든 같은 모양이다. */
export interface RequirementCandidate {
  /** 원본에서의 행 번호(1부터, 헤더 행도 센다). 근거 위치의 기본값이 된다. */
  rowNumber: number;
  feature?: string;
  text?: string;
  /** 근거 위치(페이지 · Frame · 셀 등). 없으면 행 번호로 대신한다. */
  locator?: string;
  /** 해석한 확인 필요 값. 열을 연결하지 않았거나 칸이 비어 있으면 false. 해석하지 못하면 undefined이고 원문이 confirmationRaw에 남는다. */
  needsConfirmation?: boolean;
  confirmationRaw?: string;
}

const clean = (value: string | undefined) => {
  const text = value?.normalize('NFC').trim();
  return text ? text : undefined;
};

/** 비교용. 공백 차이와 유니코드 조합 방식(NFC/NFD) 차이는 같은 내용으로 본다. 대소문자는 구분한다. */
const normalizeText = (value: string | undefined) => (value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();

const trueValues = new Set(['true', 'y', 'yes', '1', '필요', '확인필요']);
const falseValues = new Set(['false', 'n', 'no', '0', '불필요']);

/** 확인 필요 칸 해석. 비어 있으면 false, 알려진 값이 아니면 undefined(자동으로 false로 보지 않는다). */
export function parseNeedsConfirmation(value: string | undefined): boolean | undefined {
  const key = (value ?? '').normalize('NFC').replace(/\s+/g, '').toLowerCase();
  if (key === '') return false;
  if (trueValues.has(key)) return true;
  if (falseValues.has(key)) return false;
  return undefined;
}

export const requirementLocatorFallback = (rowNumber: number) => `요구사항 파일 ${rowNumber}행`;

/** 표의 한 행을 후보로 바꾼다. 빈 행은 호출하는 쪽에서 미리 걸러낸다. */
export function toRequirementCandidate(row: ImportTable['rows'][number], mapping: RequirementColumnMapping): RequirementCandidate {
  const raw = (field: RequirementImportField) => {
    const index = mapping.indexOf(field);
    return index < 0 ? undefined : row.cells[index];
  };
  const confirmationCell = raw('needsConfirmation');
  const needsConfirmation = parseNeedsConfirmation(confirmationCell);
  const feature = clean(raw('feature'));
  const text = clean(raw('text'));
  const locator = clean(raw('locator'));
  return {
    rowNumber: row.rowNumber,
    ...(feature && { feature }),
    ...(text && { text }),
    ...(locator && { locator }),
    needsConfirmation,
    ...(needsConfirmation === undefined && { confirmationRaw: confirmationCell?.trim() }),
  };
}

/* ---------- 판정 ---------- */

/** create: 새 요구사항으로 가져올 수 있음 / duplicate: 같은 기능 · 같은 내용이 이미 있음 / invalid: 오류가 있어 가져올 수 없음 */
export type RequirementImportKind = 'create' | 'duplicate' | 'invalid';

export const requirementImportKindOrder: RequirementImportKind[] = ['create', 'duplicate', 'invalid'];

export interface AnalyzedRequirementRow {
  candidate: RequirementCandidate;
  kind: RequirementImportKind;
  /** 판정 이유. create면 비어 있다. */
  reasons: string[];
}

export interface RequirementImportAnalysis {
  rows: AnalyzedRequirementRow[];
  /** 모든 칸이 빈 행. 판정하지 않고 건너뛴다. */
  blankRows: number;
}

const duplicateKey = (feature: string, text: string) => `${normalizeText(feature)}\u0000${normalizeText(text)}`;

/**
 * 후보 행을 판정한다. 같은 프로젝트의 기존 요구사항(existing)과 기능 · 내용이 정확히 같으면(공백 · 유니코드 정규화만 무시) 중복이다.
 * 파일 안에서 먼저 나온 같은 행이 있으면 뒤의 행이 중복이다. 비슷한 문장은 같다고 보지 않는다.
 */
export function classifyRequirementCandidates(candidates: RequirementCandidate[], existing: Requirement[]): AnalyzedRequirementRow[] {
  const existingByKey = new Map(existing.map((item) => [duplicateKey(item.feature, item.text), item]));
  const firstRowByKey = new Map<string, number>();
  return candidates.map((candidate): AnalyzedRequirementRow => {
    const reasons: string[] = [];
    if (!candidate.feature) reasons.push('기능이 비어 있어요.');
    if (!candidate.text) reasons.push('요구사항이 비어 있어요.');
    if (candidate.needsConfirmation === undefined) reasons.push(`확인 필요 값을 해석할 수 없어요. (${candidate.confirmationRaw ?? ''})`);
    if (reasons.length > 0) return { candidate, kind: 'invalid', reasons };

    const key = duplicateKey(candidate.feature!, candidate.text!);
    const found = existingByKey.get(key);
    if (found) return { candidate, kind: 'duplicate', reasons: [found.lifecycle === 'removed' ? '제거됨 상태로 이미 있는 요구사항이에요.' : '이미 있는 요구사항이에요.'] };
    const first = firstRowByKey.get(key);
    if (first !== undefined) return { candidate, kind: 'duplicate', reasons: [`파일의 ${first}행과 같은 요구사항이에요.`] };
    firstRowByKey.set(key, candidate.rowNumber);
    return { candidate, kind: 'create', reasons: [] };
  });
}

/** 표 → 후보 행 → 판정. 빈 행은 세어서 건너뛴다. */
export function analyzeRequirementImport(table: ImportTable, mapping: RequirementColumnMapping, existing: Requirement[]): RequirementImportAnalysis {
  const filled = table.rows.filter((row) => row.cells.some((cell) => cell.trim() !== ''));
  return {
    rows: classifyRequirementCandidates(
      filled.map((row) => toRequirementCandidate(row, mapping)),
      existing,
    ),
    blankRows: table.rows.length - filled.length,
  };
}

export interface RequirementImportSummary {
  /** 빈 행을 뺀 파일의 행 수 */
  total: number;
  created: number;
  duplicate: number;
  invalid: number;
  /** 새 요구사항이 될 수 있었지만 사용자가 뺀 행 */
  excluded: number;
}

/** 판정별 행 수. 사용자가 제외한 행은 신규에서 빼고 제외로 센다. */
export function summarizeRequirementImport(analysis: RequirementImportAnalysis, excludedRows: readonly number[] = []): RequirementImportSummary {
  const excluded = new Set(excludedRows);
  const count = (kind: RequirementImportKind) => analysis.rows.filter((row) => row.kind === kind).length;
  const excludedCreates = analysis.rows.filter((row) => row.kind === 'create' && excluded.has(row.candidate.rowNumber)).length;
  return { total: analysis.rows.length, created: count('create') - excludedCreates, duplicate: count('duplicate'), invalid: count('invalid'), excluded: excludedCreates };
}

/* ---------- 생성 계획 ---------- */

export class RequirementImportError extends Error {}

export interface RequirementImportPlanOptions {
  projectId: string;
  /** 근거(sourceRefs)가 가리킬 이 프로젝트의 산출물 */
  deliverableId: string;
  createId: (prefix: string) => string;
}

export interface RequirementImportPlan {
  requirements: Requirement[];
  summary: RequirementImportSummary;
}

/**
 * 만들 요구사항을 계산한다(저장하지 않는다). 신규 행 중 사용자가 제외하지 않은 행만 만들고 중복 · 오류 행은 만들지 않는다.
 * 새 요구사항은 산출물에 적힌 내용(source_explicit)이고 검토 전(draft) · 유효(active)다. 확인 필요는 파일 값 그대로다.
 * 근거 위치가 없는 행은 원본 행 번호로 대신한다. 만들 요구사항이 하나도 없으면 던진다.
 * 제외 목록(excludedRows)은 "지금 새 요구사항이 될 행을 사용자가 뺀 결정"만 담는다. 없는 행 · 중복 · 오류 · 빈 행 · 같은 번호 두 번은 조용히 무시하지 않고 던진다.
 * 미리보기 뒤에 요구사항이 바뀌어 신규였던 행이 중복이 됐다면 그 제외도 던진다(TC 가져오기가 미리보기 뒤 바뀐 판정을 거부하는 것과 같다). 화면은 미리보기를 다시 계산해 지금도 신규인 행만 넘긴다.
 */
export function planRequirementImport(analysis: RequirementImportAnalysis, excludedRows: readonly number[], options: RequirementImportPlanOptions): RequirementImportPlan {
  const creatable = new Set(analysis.rows.filter((row) => row.kind === 'create').map((row) => row.candidate.rowNumber));
  const seen = new Set<number>();
  for (const rowNumber of excludedRows) {
    if (seen.has(rowNumber)) throw new RequirementImportError(`${rowNumber}행을 제외 목록에 두 번 넣었어요.`);
    seen.add(rowNumber);
    if (!creatable.has(rowNumber)) throw new RequirementImportError(`${rowNumber}행은 제외할 수 있는 요구사항 행이 아니에요.`);
  }
  const excluded = new Set(excludedRows);
  const requirements = analysis.rows
    .filter((row) => row.kind === 'create' && !excluded.has(row.candidate.rowNumber))
    .map(
      ({ candidate }): Requirement => ({
        id: options.createId('req'),
        projectId: options.projectId,
        feature: candidate.feature!,
        text: candidate.text!,
        sourceRefs: [{ deliverableId: options.deliverableId, locator: candidate.locator ?? requirementLocatorFallback(candidate.rowNumber) }],
        sourceType: 'source_explicit',
        needsConfirmation: candidate.needsConfirmation === true,
        lifecycle: 'active',
        status: 'draft',
      }),
    );
  if (requirements.length === 0) throw new RequirementImportError('가져올 수 있는 새 요구사항이 없어요.');
  return { requirements, summary: summarizeRequirementImport(analysis, excludedRows) };
}

/** 활동 기록 · 완료 안내에 쓰는 요약 문구 */
export const requirementImportSummaryText = (summary: RequirementImportSummary) => `신규 ${summary.created} · 중복 ${summary.duplicate} · 오류 ${summary.invalid} · 제외 ${summary.excluded}`;
