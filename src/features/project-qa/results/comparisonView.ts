import { defaultComparisonRounds, unchangedChangeTypes, type ResultChangeType, type ResultComparisonRow } from '@/domain/resultComparison';
import type { TestCase, TestResult, TestResultImport } from '@/domain/types';

/*
 * 수행 결과 비교 화면 전용 규칙: 목록 순서 · 필터 · 표시 값. 변화 유형 판정(도메인)과 분리한다.
 * 정렬 순서는 QA가 먼저 볼 항목 순서일 뿐 변화 유형의 의미가 아니다.
 */

/** 목록 순서. 앞일수록 먼저 본다. */
const displayOrder: ResultChangeType[] = [
  'newly_failed',
  'still_failed',
  'newly_blocked',
  'fixed',
  'unblocked',
  'added_to_scope',
  'removed_from_scope',
  'newly_not_tested',
  'resumed',
  'unchanged_blocked',
  'unchanged_not_tested',
  'unchanged_pass',
];
const rankOf = new Map(displayOrder.map((type, index) => [type, index]));

/**
 * 비교할 두 차수. 고른 차수(주소의 base · target)가 둘 다 있고 서로 다르면 그 차수이고,
 * 없거나 지워졌거나 같으면 차수 번호가 가장 큰 두 차수(자동 선택)다.
 * 따로 저장하지 않고 매번 계산하므로 새 차수를 가져오거나 주소가 바뀌면 바로 따라간다.
 */
export function resolveComparisonRounds<T extends Pick<TestResultImport, 'id' | 'round'>>(
  imports: T[],
  previousId: string | null | undefined,
  currentId: string | null | undefined,
): { previous: T; current: T } | undefined {
  const previous = imports.find((item) => item.id === previousId);
  const current = imports.find((item) => item.id === currentId);
  if (previous && current && previous !== current) return { previous, current };
  return defaultComparisonRounds(imports);
}

export type ComparisonFilter ='all' | 'newly_failed' | 'still_failed' | 'fixed' | 'blocked' | 'scope';

export const comparisonFilterLabel: Record<ComparisonFilter, string> = {
  all: '전체',
  newly_failed: '신규 실패',
  still_failed: '계속 실패',
  fixed: '수정됨',
  blocked: '차단 변화',
  scope: '범위 변화',
};

const filterTypes: Record<Exclude<ComparisonFilter, 'all'>, ResultChangeType[]> = {
  newly_failed: ['newly_failed'],
  still_failed: ['still_failed'],
  fixed: ['fixed'],
  blocked: ['newly_blocked', 'unblocked'],
  scope: ['added_to_scope', 'removed_from_scope'],
};

/** 이 필터에 들어가는 행인가. 변화 없는 행은 includeUnchanged일 때 '전체'에만 들어간다. */
export function matchesFilter(row: Pick<ResultComparisonRow, 'changeType'>, filter: ComparisonFilter, includeUnchanged: boolean): boolean {
  if (filter === 'all') return includeUnchanged || !unchangedChangeTypes.includes(row.changeType);
  return filterTypes[filter].includes(row.changeType);
}

export interface ComparisonRowView {
  row: ResultComparisonRow;
  externalId?: string;
  title: string;
  feature: string;
  deprecated: boolean;
  /** 지금 TC를 찾지 못해 결과에 남은 값으로 보여 준다. */
  fromResult: boolean;
}

/**
 * 표시 값은 지금의 기준 TC에서 가져온다(고객사 TC ID가 바뀌었으면 지금 값). TC를 찾을 수 없으면 결과에 남은 값을 쓴다.
 * 복사본을 저장하지 않는다.
 */
export function describeComparisonRows(rows: ResultComparisonRow[], testCases: TestCase[], results: TestResult[]): ComparisonRowView[] {
  const testCaseById = new Map(testCases.map((testCase) => [testCase.id, testCase]));
  const resultById = new Map(results.map((result) => [result.id, result]));
  return rows.map((row) => {
    const testCase = testCaseById.get(row.testCaseId);
    const result = resultById.get(row.currentResultId ?? row.previousResultId ?? '');
    const externalId = testCase ? testCase.externalId : result?.externalId;
    return {
      row,
      ...(externalId && { externalId }),
      title: testCase?.title ?? result?.title ?? row.testCaseId,
      feature: testCase?.feature ?? result?.feature ?? '',
      deprecated: testCase?.status === 'deprecated',
      fromResult: !testCase,
    };
  });
}

const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });

/** 변화 유형 순서 → 고객사 TC ID(없으면 뒤) → 제목 → 플랫폼 */
export function sortComparisonRows(views: ComparisonRowView[]): ComparisonRowView[] {
  return [...views].sort(
    (a, b) =>
      rankOf.get(a.row.changeType)! - rankOf.get(b.row.changeType)! ||
      Number(!a.externalId) - Number(!b.externalId) ||
      collator.compare(a.externalId ?? '', b.externalId ?? '') ||
      collator.compare(a.title, b.title) ||
      collator.compare(a.row.platform ?? '', b.row.platform ?? ''),
  );
}
