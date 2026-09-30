import { describe, expect, it } from 'vitest';
import { summarizeChangeAnalysis } from '@/domain/changeImpact';
import type { ChangeAnalysis, TestImpactKind } from '@/domain/types';
import { createMockRepositories } from './mockRepositories';
import { createSeed, PROJECT_A, PROJECT_B } from './seed';

async function loadProjectA() {
  const seed = createSeed();
  const testCasesBefore = structuredClone(seed.testCases);
  const requirementsBefore = structuredClone(seed.requirements);
  const repos = createMockRepositories(seed);
  const [analyses, requirements, conditions, testCases, deliverables] = await Promise.all([
    repos.changeAnalyses.listByProject(PROJECT_A),
    repos.requirements.listByProject(PROJECT_A),
    repos.testConditions.listByProject(PROJECT_A),
    repos.testCases.listByProject(PROJECT_A),
    repos.deliverables.listByProject(PROJECT_A),
  ]);
  return { repos, analysis: analyses[0] as ChangeAnalysis, analyses, requirements, conditions, testCases, deliverables, testCasesBefore, requirementsBefore };
}

describe('변경 영향 분석 세트', () => {
  it('어떤 revision을 어떤 이전 revision과 비교했는지 기록한다', async () => {
    const { analyses, analysis, deliverables } = await loadProjectA();
    expect(analyses).toHaveLength(1);
    const target = deliverables.find((item) => item.id === analysis.targetDeliverableId);
    expect(target?.version).toBe('v1.5');
    expect(target?.previousRevisionId).toBe(analysis.baselineDeliverableId);
    expect(analysis.status).toBe('draft');
  });

  it('프로젝트별로 분리된다', async () => {
    const { repos } = await loadProjectA();
    expect(await repos.changeAnalyses.listByProject(PROJECT_B)).toEqual([]);
  });

  it('요구사항 변경과 TC 영향 종류별 개수를 요약한다', async () => {
    const { analysis } = await loadProjectA();
    expect(summarizeChangeAnalysis(analysis)).toEqual({
      requirements: { added: 1, modified: 1, removed: 1, unchanged: 1 },
      testImpacts: { create: 2, modify: 2, keep: 1, deprecate: 1, duplicate_candidate: 1 },
    });
  });
});

describe('요구사항 변경 제안', () => {
  it('modified는 기존 요구사항 identity를 유지하고 원문은 바꾸지 않는다', async () => {
    const { analysis, requirements, requirementsBefore } = await loadProjectA();
    const modified = analysis.requirementChanges.find((change) => change.kind === 'modified')!;
    const existing = requirements.find((item) => item.id === modified.requirementId);
    expect(existing?.id).toBe('req-002');
    expect(modified.proposedText).not.toBe(existing?.text);
    expect(requirements).toEqual(requirementsBefore);
  });

  it('removed는 요구사항을 삭제하지 않고 분석 결과로만 표시한다', async () => {
    const { analysis, requirements } = await loadProjectA();
    const removed = analysis.requirementChanges.find((change) => change.kind === 'removed')!;
    const existing = requirements.find((item) => item.id === removed.requirementId);
    expect(existing).toBeDefined();
    expect(existing?.lifecycle).toBe('active');
  });

  it('added만 기존 요구사항 없이 새 문장을 가지며, 나머지는 기존 요구사항을 가리킨다', async () => {
    const { analysis, requirements } = await loadProjectA();
    const ids = new Set(requirements.map((item) => item.id));
    for (const change of analysis.requirementChanges) {
      if (change.kind === 'added') {
        expect(change.requirementId, change.id).toBeUndefined();
        expect(change.proposedText, change.id).toBeTruthy();
      } else {
        expect(ids.has(change.requirementId!), change.id).toBe(true);
      }
      if (change.kind === 'modified') expect(change.proposedText, change.id).toBeTruthy();
    }
  });
});

describe('TC 영향 제안', () => {
  it('기존 TC를 직접 바꾸지 않는다', async () => {
    const { analysis, testCases, testCasesBefore } = await loadProjectA();
    expect(testCases).toEqual(testCasesBefore);
    for (const impact of analysis.testImpacts.filter((item) => item.kind === 'modify')) {
      const testCase = testCases.find((item) => item.id === impact.testCaseId)!;
      expect(testCase.title).not.toBe(impact.proposedTitle);
      expect(testCase.revision).toBe(1);
    }
  });

  it('create / modify / keep / deprecate / duplicate_candidate가 모두 있고 종류별 연결 규칙을 지킨다', async () => {
    const { analysis } = await loadProjectA();
    const kinds = new Set<TestImpactKind>(analysis.testImpacts.map((impact) => impact.kind));
    expect([...kinds].sort()).toEqual(['create', 'deprecate', 'duplicate_candidate', 'keep', 'modify']);

    for (const impact of analysis.testImpacts) {
      expect(impact.requirementChangeIds.length, impact.id).toBeGreaterThan(0);
      if (impact.kind === 'create') {
        expect(impact.testCaseId, impact.id).toBeUndefined();
        expect(impact.proposedTitle, impact.id).toBeTruthy();
      } else {
        expect(impact.testCaseId, impact.id).toBeTruthy();
      }
      if (impact.kind === 'modify' || impact.kind === 'duplicate_candidate') expect(impact.proposedTitle, impact.id).toBeTruthy();
    }
  });

  it('존재하지 않는 요구사항·테스트 조건·TC·산출물을 참조하지 않는다', async () => {
    const { analysis, requirements, conditions, testCases, deliverables } = await loadProjectA();
    const requirementIds = new Set(requirements.map((item) => item.id));
    const conditionIds = new Set(conditions.map((item) => item.id));
    const testCaseIds = new Set(testCases.map((item) => item.id));
    const deliverableIds = new Set(deliverables.map((item) => item.id));
    const changeIds = new Set(analysis.requirementChanges.map((item) => item.id));

    expect(deliverableIds.has(analysis.targetDeliverableId)).toBe(true);
    if (analysis.baselineDeliverableId) expect(deliverableIds.has(analysis.baselineDeliverableId)).toBe(true);
    for (const change of analysis.requirementChanges) {
      if (change.requirementId) expect(requirementIds.has(change.requirementId), change.id).toBe(true);
      for (const ref of change.sourceRefs) expect(deliverableIds.has(ref.deliverableId), change.id).toBe(true);
    }
    for (const impact of analysis.testImpacts) {
      if (impact.testCaseId) expect(testCaseIds.has(impact.testCaseId), impact.id).toBe(true);
      for (const id of impact.testConditionIds) expect(conditionIds.has(id), impact.id).toBe(true);
      for (const id of impact.requirementChangeIds) expect(changeIds.has(id), impact.id).toBe(true);
    }
  });

  it('수정·유지·폐기·중복 대상 TC의 조건은 그 TC가 실제로 연결된 조건이다', async () => {
    const { analysis, testCases } = await loadProjectA();
    for (const impact of analysis.testImpacts.filter((item) => item.testCaseId)) {
      const testCase = testCases.find((item) => item.id === impact.testCaseId)!;
      for (const id of impact.testConditionIds) expect(testCase.testConditionIds, impact.id).toContain(id);
    }
  });
});

describe('기존 결과 연결 회귀', () => {
  it('폐기·재검토 상태의 TC도 수행 결과 연결이 유지된다', async () => {
    const { repos, testCases } = await loadProjectA();
    const imports = await repos.testResults.listImports(PROJECT_A);
    const byId = new Map(testCases.map((item) => [item.id, item]));
    for (const resultImport of imports) {
      const results = await repos.testResults.listResults(resultImport.id);
      expect(results).toHaveLength(212);
      const linked = results.filter((item) => item.testCaseId);
      expect(linked).toHaveLength(30);
      for (const result of linked) expect(byId.get(result.testCaseId!)?.externalId).toBe(result.externalId);
      expect(linked.some((item) => byId.get(item.testCaseId!)?.status === 'deprecated')).toBe(true);
      expect(linked.some((item) => byId.get(item.testCaseId!)?.status === 'needs_review')).toBe(true);
    }
  });
});
