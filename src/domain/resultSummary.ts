import type { Platform, ResultMapping, TestResult, TestResultValue } from './types';

export type ResultCounts = Record<TestResultValue, number> & { total: number };

export function emptyCounts(): ResultCounts {
  return { total: 0, pass: 0, fail: 0, blocked: 0, not_tested: 0 };
}

export function countResults(results: TestResult[]): ResultCounts {
  const counts = emptyCounts();
  for (const result of results) {
    counts[result.result] += 1;
    counts.total += 1;
  }
  return counts;
}

/** 수행률: 미수행을 제외한 비율 (0–100) */
export function executionRate(counts: ResultCounts): number {
  if (counts.total === 0) return 0;
  return Math.round(((counts.total - counts.not_tested) / counts.total) * 100);
}

/** 통과율: 수행한 항목 중 PASS 비율 (0–100) */
export function passRate(counts: ResultCounts): number {
  const executed = counts.total - counts.not_tested;
  if (executed === 0) return 0;
  return Math.round((counts.pass / executed) * 100);
}

export function groupByPlatform(results: TestResult[]): { platform: Platform; counts: ResultCounts }[] {
  const map = new Map<Platform, TestResult[]>();
  for (const result of results) {
    if (!result.platform) continue;
    map.set(result.platform, [...(map.get(result.platform) ?? []), result]);
  }
  return [...map.entries()].map(([platform, items]) => ({ platform, counts: countResults(items) }));
}

export interface FeatureSummary {
  feature: string;
  counts: ResultCounts;
  /** FAIL + BLOCKED + 미수행 비율. 집중 영역 판단에 사용 */
  attentionRate: number;
}

export function groupByFeature(results: TestResult[]): FeatureSummary[] {
  const map = new Map<string, TestResult[]>();
  for (const result of results) {
    map.set(result.feature, [...(map.get(result.feature) ?? []), result]);
  }
  return [...map.entries()].map(([feature, items]) => {
    const counts = countResults(items);
    const attention = counts.fail + counts.blocked + counts.not_tested;
    return { feature, counts, attentionRate: counts.total ? attention / counts.total : 0 };
  });
}

/** 실패·미수행이 몰린 기능 상위 n개 (문제가 하나도 없으면 제외) */
export function attentionAreas(results: TestResult[], limit = 3): FeatureSummary[] {
  return groupByFeature(results)
    .filter((summary) => summary.attentionRate > 0)
    .sort((a, b) => b.attentionRate - a.attentionRate || b.counts.fail - a.counts.fail)
    .slice(0, limit);
}

/** 재수행이 필요한 항목: FAIL 또는 BLOCKED */
export function retestCandidates(results: TestResult[]): TestResult[] {
  return results.filter((result) => result.result === 'fail' || result.result === 'blocked');
}

export interface RoundComparison {
  value: TestResultValue;
  previous: number;
  current: number;
  delta: number;
}

export function compareRounds(previous: ResultCounts, current: ResultCounts): RoundComparison[] {
  const values: TestResultValue[] = ['pass', 'fail', 'blocked', 'not_tested'];
  return values.map((value) => ({
    value,
    previous: previous[value],
    current: current[value],
    delta: current[value] - previous[value],
  }));
}

/** 고객사 결과 원문(P, OK, NG 등)을 표준 결과로 변환. 매핑이 없으면 undefined */
export function mapRawResult(raw: string, mappings: ResultMapping[]): TestResultValue | undefined {
  const normalized = raw.trim().toUpperCase();
  return mappings.find((mapping) => mapping.rawValue.trim().toUpperCase() === normalized)?.result;
}
