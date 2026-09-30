import type { ChangeAnalysis, RequirementChangeKind, TestImpactKind } from './types';

export interface ChangeAnalysisSummary {
  requirements: Record<RequirementChangeKind, number>;
  testImpacts: Record<TestImpactKind, number>;
}

/** 변경 영향 분석 결과를 종류별 개수로 요약한다. */
export function summarizeChangeAnalysis(analysis: ChangeAnalysis): ChangeAnalysisSummary {
  const requirements: Record<RequirementChangeKind, number> = { added: 0, modified: 0, removed: 0, unchanged: 0 };
  const testImpacts: Record<TestImpactKind, number> = { create: 0, modify: 0, keep: 0, deprecate: 0, duplicate_candidate: 0 };
  for (const change of analysis.requirementChanges) requirements[change.kind] += 1;
  for (const impact of analysis.testImpacts) testImpacts[impact.kind] += 1;
  return { requirements, testImpacts };
}
