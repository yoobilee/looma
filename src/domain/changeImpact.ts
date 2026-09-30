import type {
  ChangeAnalysis,
  ChangeApplySummary,
  Deliverable,
  Requirement,
  RequirementChange,
  RequirementChangeKind,
  SourceRef,
  TestCase,
  TestCaseDesign,
  TestCondition,
  TestImpact,
  TestImpactKind,
} from './types';

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

/* ---------- 검토 ---------- */

/** unchanged는 참고용이라 판단하지 않는다. */
export function requirementChangeNeedsDecision(change: RequirementChange): boolean {
  return change.kind !== 'unchanged';
}

/** keep은 참고용, duplicate_candidate는 수락/제외 대신 처리 방법을 고른다. */
export function testImpactNeedsDecision(impact: TestImpact): boolean {
  return impact.kind === 'create' || impact.kind === 'modify' || impact.kind === 'deprecate';
}

/** 아직 판단하지 않은 항목 수. 0이어야 검토를 완료할 수 있다. */
export function pendingDecisionCount(analysis: ChangeAnalysis): number {
  const requirements = analysis.requirementChanges.filter((change) => requirementChangeNeedsDecision(change) && (change.decision ?? 'pending') === 'pending');
  const impacts = analysis.testImpacts.filter((impact) =>
    impact.kind === 'duplicate_candidate' ? (impact.duplicateResolution ?? 'pending') === 'pending' : testImpactNeedsDecision(impact) && (impact.decision ?? 'pending') === 'pending',
  );
  return requirements.length + impacts.length;
}

/* ---------- 반영 ---------- */

export class ChangeApplicationError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`변경사항을 반영할 수 없어요. ${problems[0]}${problems.length > 1 ? ` 외 ${problems.length - 1}건` : ''}`);
    this.name = 'ChangeApplicationError';
    this.problems = problems;
  }
}

export interface ChangeApplicationAssets {
  requirements: Requirement[];
  testCases: TestCase[];
  testConditions: TestCondition[];
  deliverables: Deliverable[];
}

export interface ChangeApplicationOptions {
  now: string;
  createId: (prefix: string) => string;
  /** 새 TC에 붙일 프로젝트의 고객사 Template */
  templateId?: string;
}

export interface ChangeApplicationPlan {
  requirements: Requirement[];
  testCases: TestCase[];
  summary: ChangeApplySummary;
}

const designKeys: (keyof TestCaseDesign)[] = [
  'category',
  'feature',
  'depth',
  'title',
  'precondition',
  'steps',
  'expectedResult',
  'requirementIds',
  'testConditionIds',
  'sourceRefs',
  'generationType',
];

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const unique = (values: string[]) => [...new Set(values)];

type TestCaseAction = { type: 'create'; design?: TestCaseDesign } | { type: 'modify'; changes?: Partial<TestCaseDesign> } | { type: 'deprecate' };

/** 판단 결과를 실제 동작으로 바꾼다. 반영하지 않는 항목은 null. */
function testCaseActionFor(impact: TestImpact): TestCaseAction | null {
  if (impact.kind === 'duplicate_candidate') {
    if (impact.duplicateResolution === 'modify_existing') return { type: 'modify', changes: impact.changes };
    if (impact.duplicateResolution === 'create_separate') return { type: 'create', design: impact.newTestCase };
    return null;
  }
  if (impact.decision !== 'accepted') return null;
  if (impact.kind === 'create') return { type: 'create', design: impact.newTestCase };
  if (impact.kind === 'modify') return { type: 'modify', changes: impact.changes };
  if (impact.kind === 'deprecate') return { type: 'deprecate' };
  return null;
}

/**
 * 검토가 끝난 분석을 실제 요구사항·TC 목록에 반영한 결과를 계산한다. 입력은 바꾸지 않는다.
 * 모든 전제와 참조를 먼저 검사하고, 문제가 하나라도 있으면 아무것도 반영하지 않도록 예외를 던진다.
 * 호출하는 쪽은 성공한 결과만 한 번에 저장해 일부만 반영된 상태를 만들지 않는다.
 */
export function planChangeApplication(analysis: ChangeAnalysis, assets: ChangeApplicationAssets, options: ChangeApplicationOptions): ChangeApplicationPlan {
  const problems: string[] = [];
  if (analysis.status === 'applied') problems.push('이미 반영한 분석이에요.');
  else if (analysis.status !== 'reviewed') problems.push('검토를 완료한 분석만 반영할 수 있어요.');
  const pending = pendingDecisionCount(analysis);
  if (pending > 0) problems.push(`판단하지 않은 항목이 ${pending}건 있어요.`);

  const inProject = <T extends { projectId: string }>(items: T[]) => items.filter((item) => item.projectId === analysis.projectId);
  const requirementById = new Map(inProject(assets.requirements).map((item) => [item.id, item]));
  const testCaseById = new Map(inProject(assets.testCases).map((item) => [item.id, item]));
  const conditionIds = new Set(inProject(assets.testConditions).map((item) => item.id));
  const deliverableIds = new Set(inProject(assets.deliverables).map((item) => item.id));
  const changeById = new Map(analysis.requirementChanges.map((change) => [change.id, change]));

  const checkSources = (label: string, refs: SourceRef[] | undefined) => {
    for (const ref of refs ?? []) if (!deliverableIds.has(ref.deliverableId)) problems.push(`${label}: 근거 산출물을 찾을 수 없어요. (${ref.deliverableId})`);
  };

  /* 요구사항 */
  const createdRequirementIdByChange = new Map<string, string>();
  const requirementUpdates = new Map<string, Requirement>();
  const newRequirements: Requirement[] = [];
  const summary: ChangeApplySummary = {
    requirementsAdded: 0,
    requirementsModified: 0,
    requirementsRemoved: 0,
    testCasesCreated: 0,
    testCasesModified: 0,
    testCasesDeprecated: 0,
  };

  for (const change of analysis.requirementChanges) {
    if (!requirementChangeNeedsDecision(change) || change.decision !== 'accepted') continue;
    const label = `요구사항 변경 ${change.id}`;

    if (change.kind === 'added') {
      if (!change.proposal) {
        problems.push(`${label}: 새 요구사항 내용이 없어요.`);
        continue;
      }
      checkSources(label, change.sourceRefs);
      const id = options.createId('req');
      createdRequirementIdByChange.set(change.id, id);
      newRequirements.push({
        id,
        projectId: analysis.projectId,
        feature: change.feature,
        text: change.proposal.text,
        sourceRefs: structuredClone(change.sourceRefs),
        sourceType: change.proposal.sourceType,
        needsConfirmation: change.proposal.needsConfirmation,
        ...(change.proposal.confidence !== undefined && { confidence: change.proposal.confidence }),
        lifecycle: 'active',
        // seed와 같은 규칙: 산출물에 명시된 내용만 검토 완료, 나머지는 초안. 자동으로 확정하지 않는다.
        status: change.proposal.sourceType === 'source_explicit' ? 'reviewed' : 'draft',
      });
      summary.requirementsAdded += 1;
      continue;
    }

    const existing = change.requirementId ? requirementById.get(change.requirementId) : undefined;
    if (!existing) {
      problems.push(`${label}: 기존 요구사항을 찾을 수 없어요. (${change.requirementId ?? '없음'})`);
      continue;
    }
    if (requirementUpdates.has(existing.id)) {
      problems.push(`${label}: 같은 요구사항에 반영할 변경이 둘 이상이에요. (${existing.id})`);
      continue;
    }

    if (change.kind === 'modified') {
      if (!change.proposal) {
        problems.push(`${label}: 수정할 요구사항 내용이 없어요.`);
        continue;
      }
      checkSources(label, change.sourceRefs);
      const { confidence, ...rest } = existing;
      requirementUpdates.set(existing.id, {
        ...rest,
        text: change.proposal.text,
        sourceRefs: structuredClone(change.sourceRefs),
        sourceType: change.proposal.sourceType,
        needsConfirmation: change.proposal.needsConfirmation,
        ...((change.proposal.confidence ?? confidence) !== undefined && { confidence: change.proposal.confidence ?? confidence }),
        lifecycle: 'changed',
        status: change.proposal.sourceType === 'source_explicit' ? 'reviewed' : 'draft',
      });
      summary.requirementsModified += 1;
    } else if (change.kind === 'removed') {
      // 삭제하지 않는다. 기존 근거(sourceRefs)도 그대로 두고, 제거 판단의 근거는 이 분석에 남는다.
      requirementUpdates.set(existing.id, { ...existing, lifecycle: 'removed' });
      summary.requirementsRemoved += 1;
    }
  }

  /* TC */
  const checkDesignReferences = (label: string, design: Partial<TestCaseDesign>) => {
    for (const id of design.requirementIds ?? []) if (!requirementById.has(id)) problems.push(`${label}: 요구사항을 찾을 수 없어요. (${id})`);
    for (const id of design.testConditionIds ?? []) if (!conditionIds.has(id)) problems.push(`${label}: 테스트 조건을 찾을 수 없어요. (${id})`);
    checkSources(label, design.sourceRefs);
  };

  const testCaseUpdates = new Map<string, TestCase>();
  const newTestCases: TestCase[] = [];

  for (const impact of analysis.testImpacts) {
    const label = `TC 영향 ${impact.id}`;
    for (const id of impact.requirementChangeIds) if (!changeById.has(id)) problems.push(`${label}: 요구사항 변경을 찾을 수 없어요. (${id})`);

    const action = testCaseActionFor(impact);
    if (!action) continue;
    // 이번 반영으로 새로 생기는 요구사항은 연결된 TC에 함께 이어 준다.
    const createdRequirementIds = impact.requirementChangeIds.map((id) => createdRequirementIdByChange.get(id)).filter((id): id is string => !!id);

    if (action.type === 'create') {
      if (!action.design) {
        problems.push(`${label}: 새 TC 설계 내용이 없어요.`);
        continue;
      }
      checkDesignReferences(label, action.design);
      const design = structuredClone(action.design);
      newTestCases.push({
        id: options.createId('tc'),
        projectId: analysis.projectId,
        ...(options.templateId && { templateId: options.templateId }),
        // 고객사 TC ID는 Looma가 만들지 않는다.
        ...design,
        requirementIds: unique([...design.requirementIds, ...createdRequirementIds]),
        origin: 'ai_generated',
        // 새 TC도 기존 검토 흐름을 거친다.
        status: 'draft',
        revision: 1,
        createdAt: options.now,
        updatedAt: options.now,
      });
      summary.testCasesCreated += 1;
      continue;
    }

    const target = impact.testCaseId ? testCaseById.get(impact.testCaseId) : undefined;
    if (!target) {
      problems.push(`${label}: 대상 TC를 찾을 수 없어요. (${impact.testCaseId ?? '없음'})`);
      continue;
    }
    if (testCaseUpdates.has(target.id)) {
      problems.push(`${label}: 같은 TC에 반영할 제안이 둘 이상이에요. (${target.externalId ?? target.id})`);
      continue;
    }

    if (action.type === 'modify') {
      if (!action.changes || Object.keys(action.changes).length === 0) {
        problems.push(`${label}: 수정할 내용이 없어요.`);
        continue;
      }
      checkDesignReferences(label, action.changes);
      const merged: TestCase = { ...target, ...structuredClone(action.changes) };
      merged.requirementIds = unique([...merged.requirementIds, ...createdRequirementIds]);
      const contentChanged = designKeys.some((key) => !sameValue(target[key], merged[key]));
      if (!contentChanged) continue;
      testCaseUpdates.set(target.id, {
        ...merged,
        // 기존 내부 ID와 고객사 ID는 그대로 두고, 내용이 바뀐 만큼 revision만 올린다.
        revision: target.revision + 1,
        origin: 'ai_modified',
        status: 'needs_review',
        updatedAt: options.now,
      });
      summary.testCasesModified += 1;
    } else if (target.status !== 'deprecated') {
      // 삭제하지 않고 상태만 바꾼다. 내용이 같으니 revision은 올리지 않는다.
      testCaseUpdates.set(target.id, { ...target, status: 'deprecated', updatedAt: options.now });
      summary.testCasesDeprecated += 1;
    }
  }

  if (problems.length > 0) throw new ChangeApplicationError(problems);

  return {
    requirements: [...assets.requirements.map((item) => requirementUpdates.get(item.id) ?? item), ...newRequirements],
    testCases: [...assets.testCases.map((item) => testCaseUpdates.get(item.id) ?? item), ...newTestCases],
    summary,
  };
}
