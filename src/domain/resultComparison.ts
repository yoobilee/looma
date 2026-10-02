import type { Platform, TestResult, TestResultImport, TestResultValue } from './types';

/*
 * 수행 결과 비교 — 두 수행 차수(기준 → 비교)의 결과를 TC별로 맞대어 변화를 계산한다. 저장하지 않는 파생 데이터다.
 * - 비교 단위는 기준 TC 내부 ID(testCaseId) · 플랫폼이다. 고객사 TC ID는 표시용이며 맞대는 데 쓰지 않는다.
 *   수행 결과 가져오기는 "같은 차수 안에서 한 TC · 플랫폼의 결과는 하나"를 지키므로(testResultImport) 그 단위를 그대로 쓴다.
 * - "이 차수에 결과가 없음"(null)과 미수행(not_tested)은 다르다. 결과가 없으면 범위 추가 · 제외로만 나타내고 미수행으로 바꾸지 않는다.
 * - 같은 차수에 같은 TC · 플랫폼 결과가 여럿이면(가져오기 규칙상 생기지 않아야 한다) 하나를 고르지 않고 비교에서 빼 따로 알린다.
 * - TC에 연결되지 않은 결과는 비교하지 않고 건수만 알린다. 입력(차수 · 결과)은 바꾸지 않는다.
 */

/** 한 차수에서 이 TC · 플랫폼의 상태. null은 그 차수에 결과 자체가 없다는 뜻이다(미수행과 다르다). */
export type ComparedStatus = TestResultValue | null;

export type ResultChangeType =
  | 'newly_failed'
  | 'still_failed'
  | 'fixed'
  | 'newly_blocked'
  | 'unblocked'
  | 'newly_not_tested'
  | 'resumed'
  | 'unchanged_pass'
  | 'unchanged_blocked'
  | 'unchanged_not_tested'
  | 'added_to_scope'
  | 'removed_from_scope';

export const resultChangeTypes: ResultChangeType[] = [
  'newly_failed',
  'still_failed',
  'fixed',
  'newly_blocked',
  'unblocked',
  'newly_not_tested',
  'resumed',
  'unchanged_pass',
  'unchanged_blocked',
  'unchanged_not_tested',
  'added_to_scope',
  'removed_from_scope',
];

/** 상태가 그대로인 변화 유형 */
export const unchangedChangeTypes: ResultChangeType[] = ['unchanged_pass', 'unchanged_blocked', 'unchanged_not_tested'];

/**
 * 기준 → 비교 상태로 변화 유형을 정한다. 유형은 하나만 고르고, 원래 상태(이전 · 이번)는 행에 그대로 남긴다.
 * 1) 한쪽에 결과가 없으면 범위 추가 · 제외다(이번 결과가 FAIL이어도 범위 추가이며 currentStatus로 FAIL을 알 수 있다).
 * 2) 상태가 바뀌었으면 이번 상태가 무엇인지가 우선이다: FAIL → 신규 실패, BLOCKED → 신규 차단, 미수행 → 신규 미수행.
 *    그래서 BLOCKED → FAIL은 신규 실패, 미수행 → BLOCKED는 신규 차단이다.
 * 3) 이번이 PASS면 이전 상태로 나눈다: FAIL → 수정됨, BLOCKED → 차단 해제, 미수행 → 수행 재개.
 */
export function classifyResultChange(previous: ComparedStatus, current: ComparedStatus): ResultChangeType {
  if (previous === null && current === null) throw new Error('두 차수 모두 결과가 없는 항목은 비교 대상이 아니에요.');
  if (previous === null) return 'added_to_scope';
  if (current === null) return 'removed_from_scope';
  if (previous === current) {
    if (current === 'fail') return 'still_failed';
    if (current === 'pass') return 'unchanged_pass';
    if (current === 'blocked') return 'unchanged_blocked';
    return 'unchanged_not_tested';
  }
  if (current === 'fail') return 'newly_failed';
  if (current === 'blocked') return 'newly_blocked';
  if (current === 'not_tested') return 'newly_not_tested';
  if (previous === 'fail') return 'fixed';
  if (previous === 'blocked') return 'unblocked';
  return 'resumed';
}

export interface ResultComparisonRow {
  /** 비교 단위 키(testCaseId · 플랫폼) */
  key: string;
  testCaseId: string;
  platform?: Platform;
  previousStatus: ComparedStatus;
  currentStatus: ComparedStatus;
  changeType: ResultChangeType;
  /** 표시할 때 TC를 찾지 못하면 결과에 남은 고객사 TC ID · 제목을 쓰려고 둔다. */
  previousResultId?: string;
  currentResultId?: string;
}

/** 같은 차수에 같은 TC · 플랫폼 결과가 여러 개라 비교하지 않은 항목 */
export interface AmbiguousComparisonKey {
  importId: string;
  testCaseId: string;
  platform?: Platform;
  resultIds: string[];
}

export interface RoundSide {
  importId: string;
  /** TC에 연결된 결과 수 */
  linked: number;
  /** TC에 연결되지 않아 비교하지 않은 결과 수 */
  unlinked: number;
  /** 결과에 쓰인 플랫폼(플랫폼 없는 결과는 null) */
  platforms: (Platform | null)[];
}

export type ResultComparison =
  | {
      ok: true;
      previous: RoundSide;
      current: RoundSide;
      rows: ResultComparisonRow[];
      ambiguous: AmbiguousComparisonKey[];
      counts: Record<ResultChangeType, number>;
    }
  | { ok: false; reason: 'same_round' | 'no_linked_results'; previous?: RoundSide; current?: RoundSide };

const comparisonKey = (testCaseId: string, platform: Platform | undefined) => `${testCaseId}\u0000${platform ?? ''}`;

/** 한 차수의 결과를 TC · 플랫폼 키로 묶는다. 키 하나에 결과가 여럿이면 ambiguous로 따로 둔다. */
function indexRound(importId: string, results: TestResult[]) {
  const byKey = new Map<string, TestResult[]>();
  let unlinked = 0;
  const platforms = new Set<Platform | null>();
  for (const result of results) {
    if (result.importId !== importId) continue;
    platforms.add(result.platform ?? null);
    if (!result.testCaseId) {
      unlinked += 1;
      continue;
    }
    const key = comparisonKey(result.testCaseId, result.platform);
    const list = byKey.get(key);
    if (list) list.push(result);
    else byKey.set(key, [result]);
  }
  const single = new Map<string, TestResult>();
  const ambiguous: AmbiguousComparisonKey[] = [];
  let linked = 0;
  for (const [key, list] of byKey) {
    linked += list.length;
    if (list.length === 1) single.set(key, list[0]);
    else ambiguous.push({ importId, testCaseId: list[0].testCaseId!, ...(list[0].platform && { platform: list[0].platform }), resultIds: list.map((item) => item.id) });
  }
  const side: RoundSide = { importId, linked, unlinked, platforms: [...platforms] };
  return { single, ambiguousKeys: new Set(ambiguous.map((item) => comparisonKey(item.testCaseId, item.platform))), ambiguous, side };
}

export function emptyChangeCounts(): Record<ResultChangeType, number> {
  return Object.fromEntries(resultChangeTypes.map((type) => [type, 0])) as Record<ResultChangeType, number>;
}

/**
 * 기준 차수 → 비교 차수의 결과를 비교한다. 결과 목록은 두 차수의 결과를 함께 줘도 되고(importId로 나눈다) 바꾸지 않는다.
 * 두 차수 중 한쪽이라도 TC에 연결된 결과가 없으면 비교하지 않고 이유를 돌려준다.
 */
export function compareResultRounds(previous: Pick<TestResultImport, 'id'>, current: Pick<TestResultImport, 'id'>, results: TestResult[]): ResultComparison {
  if (previous.id === current.id) return { ok: false, reason: 'same_round' };
  const before = indexRound(previous.id, results);
  const after = indexRound(current.id, results);
  if (before.side.linked === 0 || after.side.linked === 0) return { ok: false, reason: 'no_linked_results', previous: before.side, current: after.side };

  // 어느 한쪽이라도 모호한 키는 비교하지 않는다(한쪽만 빼면 범위 추가 · 제외로 잘못 보인다).
  const skip = new Set([...before.ambiguousKeys, ...after.ambiguousKeys]);
  const rows: ResultComparisonRow[] = [];
  const counts = emptyChangeCounts();
  const push = (key: string, from: TestResult | undefined, to: TestResult | undefined) => {
    const base = (from ?? to)!;
    const changeType = classifyResultChange(from?.result ?? null, to?.result ?? null);
    counts[changeType] += 1;
    rows.push({
      key,
      testCaseId: base.testCaseId!,
      ...(base.platform && { platform: base.platform }),
      previousStatus: from?.result ?? null,
      currentStatus: to?.result ?? null,
      changeType,
      ...(from && { previousResultId: from.id }),
      ...(to && { currentResultId: to.id }),
    });
  };
  for (const [key, from] of before.single) if (!skip.has(key)) push(key, from, after.single.get(key));
  for (const [key, to] of after.single) if (!skip.has(key) && !before.single.has(key)) push(key, undefined, to);

  return { ok: true, previous: before.side, current: after.side, rows, ambiguous: [...before.ambiguous, ...after.ambiguous], counts };
}

/** 기본 비교 차수: 차수 번호(프로젝트 안에서 겹치지 않는다)가 가장 큰 두 차수. 기준은 그 앞 차수다. 둘 미만이면 없다. */
export function defaultComparisonRounds<T extends Pick<TestResultImport, 'id' | 'round'>>(imports: T[]): { previous: T; current: T } | undefined {
  if (imports.length < 2) return undefined;
  const sorted = [...imports].sort((a, b) => a.round - b.round);
  return { previous: sorted[sorted.length - 2], current: sorted[sorted.length - 1] };
}
