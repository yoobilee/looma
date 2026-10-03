import type {
  ChangeAnalysis,
  ChangeApplySummary,
  Deliverable,
  Requirement,
  RequirementChange,
  RequirementProposal,
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

/** 검토 완료 기록의 요약. 판단 대상(유지 · keep을 뺀 요구사항 변경과 TC 영향) 수다. */
export function changeReviewSummaryText(analysis: ChangeAnalysis): string {
  const { requirements, testImpacts } = summarizeChangeAnalysis(analysis);
  const requirementChanges = requirements.added + requirements.modified + requirements.removed;
  const impacts = testImpacts.create + testImpacts.modify + testImpacts.deprecate + testImpacts.duplicate_candidate;
  return `요구사항 변경 ${requirementChanges}건 · TC 영향 ${impacts}건`;
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

/** 이 판단대로 반영하면 실제 TC가 바뀌는가. keep·제외·미판단은 바뀌지 않는다. */
export function testImpactChangesTestCase(impact: TestImpact): boolean {
  if (impact.kind === 'duplicate_candidate') return impact.duplicateResolution === 'modify_existing' || impact.duplicateResolution === 'create_separate';
  return testImpactNeedsDecision(impact) && impact.decision === 'accepted';
}

export interface DecisionConflict {
  impactId: string;
  /** 이 TC 제안의 근거인데 제외된 요구사항 변경 */
  rejectedChangeIds: string[];
}

/**
 * 판단 조합의 모순. TC를 실제로 바꾸는 제안이 제외된 요구사항 변경을 근거로 하면 추적이 끊긴다.
 * 어느 쪽을 고칠지는 사람이 정하므로 판단을 자동으로 바꾸지 않고 목록만 돌려준다.
 */
export function decisionConflicts(analysis: ChangeAnalysis): DecisionConflict[] {
  const rejected = new Set(
    analysis.requirementChanges.filter((change) => requirementChangeNeedsDecision(change) && change.decision === 'rejected').map((change) => change.id),
  );
  if (rejected.size === 0) return [];
  return analysis.testImpacts
    .filter(testImpactChangesTestCase)
    .map((impact) => ({ impactId: impact.id, rejectedChangeIds: impact.requirementChangeIds.filter((id) => rejected.has(id)) }))
    .filter((conflict) => conflict.rejectedChangeIds.length > 0);
}

export function decisionConflictMessage(count: number): string {
  return `제외한 요구사항을 근거로 수락된 TC 제안이 ${count}건 있어요.`;
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
 * 1단계에서 전제·참조·판단 모순·대상 충돌을 모두 검사하고 할 일만 모은다. 문제가 하나라도 있으면
 * 새 ID를 하나도 만들지 않고 예외를 던진다. 2단계(검증 통과 후)에서만 새 ID를 할당하고 결과를 만든다.
 * 호출하는 쪽은 성공한 결과만 한 번에 저장해 일부만 반영된 상태를 만들지 않는다.
 */
export function planChangeApplication(analysis: ChangeAnalysis, assets: ChangeApplicationAssets, options: ChangeApplicationOptions): ChangeApplicationPlan {
  const problems: string[] = [];
  if (analysis.status === 'applied') problems.push('이미 반영한 분석이에요.');
  else if (analysis.status !== 'reviewed') problems.push('검토를 완료한 분석만 반영할 수 있어요.');
  const pending = pendingDecisionCount(analysis);
  if (pending > 0) problems.push(`판단하지 않은 항목이 ${pending}건 있어요.`);
  // 저장소·화면 검증과 별개로 여기서도 판단 모순을 막는다.
  const conflicts = decisionConflicts(analysis);
  if (conflicts.length > 0) problems.push(decisionConflictMessage(conflicts.length));

  const inProject = <T extends { projectId: string }>(items: T[]) => items.filter((item) => item.projectId === analysis.projectId);
  const requirementById = new Map(inProject(assets.requirements).map((item) => [item.id, item]));
  const testCaseById = new Map(inProject(assets.testCases).map((item) => [item.id, item]));
  const conditionIds = new Set(inProject(assets.testConditions).map((item) => item.id));
  const deliverableIds = new Set(inProject(assets.deliverables).map((item) => item.id));
  const changeById = new Map(analysis.requirementChanges.map((change) => [change.id, change]));

  const checkSources = (label: string, refs: SourceRef[] | undefined) => {
    for (const ref of refs ?? []) if (!deliverableIds.has(ref.deliverableId)) problems.push(`${label}: 근거 산출물을 찾을 수 없어요. (${ref.deliverableId})`);
  };
  const checkDesignReferences = (label: string, design: Partial<TestCaseDesign>) => {
    for (const id of design.requirementIds ?? []) if (!requirementById.has(id)) problems.push(`${label}: 요구사항을 찾을 수 없어요. (${id})`);
    for (const id of design.testConditionIds ?? []) if (!conditionIds.has(id)) problems.push(`${label}: 테스트 조건을 찾을 수 없어요. (${id})`);
    checkSources(label, design.sourceRefs);
  };

  /* 1단계: 검증하고 할 일만 모은다. 여기서는 ID를 만들지 않는다. */
  type RequirementWork =
    | { type: 'add'; change: RequirementChange; proposal: RequirementProposal }
    | { type: 'modify'; change: RequirementChange; proposal: RequirementProposal; existing: Requirement }
    | { type: 'remove'; existing: Requirement };
  type TestCaseWork =
    | { type: 'create'; impact: TestImpact; design: TestCaseDesign }
    | { type: 'modify'; impact: TestImpact; changes: Partial<TestCaseDesign>; target: TestCase }
    | { type: 'deprecate'; target: TestCase };

  const requirementWork: RequirementWork[] = [];
  const touchedRequirementIds = new Set<string>();

  for (const change of analysis.requirementChanges) {
    if (!requirementChangeNeedsDecision(change) || change.decision !== 'accepted') continue;
    const label = `요구사항 변경 ${change.id}`;

    if (change.kind === 'added') {
      if (!change.proposal) problems.push(`${label}: 새 요구사항 내용이 없어요.`);
      else {
        checkSources(label, change.sourceRefs);
        requirementWork.push({ type: 'add', change, proposal: change.proposal });
      }
      continue;
    }

    const existing = change.requirementId ? requirementById.get(change.requirementId) : undefined;
    if (!existing) {
      problems.push(`${label}: 기존 요구사항을 찾을 수 없어요. (${change.requirementId ?? '없음'})`);
      continue;
    }
    if (touchedRequirementIds.has(existing.id)) {
      problems.push(`${label}: 같은 요구사항에 반영할 변경이 둘 이상이에요. (${existing.id})`);
      continue;
    }
    touchedRequirementIds.add(existing.id);

    if (change.kind === 'modified') {
      if (!change.proposal) problems.push(`${label}: 수정할 요구사항 내용이 없어요.`);
      else {
        checkSources(label, change.sourceRefs);
        requirementWork.push({ type: 'modify', change, proposal: change.proposal, existing });
      }
    } else if (change.kind === 'removed') {
      requirementWork.push({ type: 'remove', existing });
    }
  }

  const testCaseWork: TestCaseWork[] = [];
  const touchedTestCaseIds = new Set<string>();

  for (const impact of analysis.testImpacts) {
    const label = `TC 영향 ${impact.id}`;
    for (const id of impact.requirementChangeIds) if (!changeById.has(id)) problems.push(`${label}: 요구사항 변경을 찾을 수 없어요. (${id})`);

    const action = testCaseActionFor(impact);
    if (!action) continue;

    if (action.type === 'create') {
      if (!action.design) problems.push(`${label}: 새 TC 설계 내용이 없어요.`);
      else {
        checkDesignReferences(label, action.design);
        testCaseWork.push({ type: 'create', impact, design: action.design });
      }
      continue;
    }

    const target = impact.testCaseId ? testCaseById.get(impact.testCaseId) : undefined;
    if (!target) {
      problems.push(`${label}: 대상 TC를 찾을 수 없어요. (${impact.testCaseId ?? '없음'})`);
      continue;
    }
    if (touchedTestCaseIds.has(target.id)) {
      problems.push(`${label}: 같은 TC에 반영할 제안이 둘 이상이에요. (${target.externalId ?? target.id})`);
      continue;
    }
    touchedTestCaseIds.add(target.id);

    if (action.type === 'modify') {
      if (!action.changes || Object.keys(action.changes).length === 0) problems.push(`${label}: 수정할 내용이 없어요.`);
      else {
        checkDesignReferences(label, action.changes);
        testCaseWork.push({ type: 'modify', impact, changes: action.changes, target });
      }
    } else {
      testCaseWork.push({ type: 'deprecate', target });
    }
  }

  if (problems.length > 0) throw new ChangeApplicationError(problems);

  /* 2단계: 검증을 모두 통과했을 때만 새 ID를 할당하고 결과를 만든다. */
  const summary: ChangeApplySummary = {
    requirementsAdded: 0,
    requirementsModified: 0,
    requirementsRemoved: 0,
    testCasesCreated: 0,
    testCasesModified: 0,
    testCasesDeprecated: 0,
  };
  const createdRequirementIdByChange = new Map<string, string>();
  const requirementUpdates = new Map<string, Requirement>();
  const newRequirements: Requirement[] = [];

  for (const work of requirementWork) {
    if (work.type === 'add') {
      const id = options.createId('req');
      createdRequirementIdByChange.set(work.change.id, id);
      newRequirements.push({
        id,
        projectId: analysis.projectId,
        feature: work.change.feature,
        text: work.proposal.text,
        sourceRefs: structuredClone(work.change.sourceRefs),
        sourceType: work.proposal.sourceType,
        needsConfirmation: work.proposal.needsConfirmation,
        ...(work.proposal.confidence !== undefined && { confidence: work.proposal.confidence }),
        lifecycle: 'active',
        // seed와 같은 규칙: 산출물에 명시된 내용만 검토 완료, 나머지는 초안. 자동으로 확정하지 않는다.
        status: work.proposal.sourceType === 'source_explicit' ? 'reviewed' : 'draft',
      });
      summary.requirementsAdded += 1;
    } else if (work.type === 'modify') {
      const { confidence, ...rest } = work.existing;
      requirementUpdates.set(work.existing.id, {
        ...rest,
        text: work.proposal.text,
        sourceRefs: structuredClone(work.change.sourceRefs),
        sourceType: work.proposal.sourceType,
        needsConfirmation: work.proposal.needsConfirmation,
        ...((work.proposal.confidence ?? confidence) !== undefined && { confidence: work.proposal.confidence ?? confidence }),
        lifecycle: 'changed',
        status: work.proposal.sourceType === 'source_explicit' ? 'reviewed' : 'draft',
      });
      summary.requirementsModified += 1;
    } else {
      // 삭제하지 않는다. 기존 근거(sourceRefs)도 그대로 두고, 제거 판단의 근거는 이 분석에 남는다.
      requirementUpdates.set(work.existing.id, { ...work.existing, lifecycle: 'removed' });
      summary.requirementsRemoved += 1;
    }
  }

  // 이번 반영으로 새로 생기는 요구사항은 같은 요구사항 변경을 가리키는 TC에 함께 이어 준다.
  const createdRequirementIdsFor = (impact: TestImpact) =>
    impact.requirementChangeIds.map((id) => createdRequirementIdByChange.get(id)).filter((id): id is string => !!id);

  const testCaseUpdates = new Map<string, TestCase>();
  const newTestCases: TestCase[] = [];

  for (const work of testCaseWork) {
    if (work.type === 'create') {
      const design = structuredClone(work.design);
      newTestCases.push({
        id: options.createId('tc'),
        projectId: analysis.projectId,
        ...(options.templateId && { templateId: options.templateId }),
        // 고객사 TC ID는 Looma가 만들지 않는다.
        ...design,
        requirementIds: unique([...design.requirementIds, ...createdRequirementIdsFor(work.impact)]),
        origin: 'ai_generated',
        // 새 TC도 기존 검토 흐름을 거친다.
        status: 'draft',
        revision: 1,
        createdAt: options.now,
        updatedAt: options.now,
      });
      summary.testCasesCreated += 1;
    } else if (work.type === 'modify') {
      const merged: TestCase = { ...work.target, ...structuredClone(work.changes) };
      merged.requirementIds = unique([...merged.requirementIds, ...createdRequirementIdsFor(work.impact)]);
      const contentChanged = designKeys.some((key) => !sameValue(work.target[key], merged[key]));
      if (!contentChanged) continue;
      testCaseUpdates.set(work.target.id, {
        ...merged,
        // 기존 내부 ID와 고객사 ID는 그대로 두고, 내용이 바뀐 만큼 revision만 올린다.
        revision: work.target.revision + 1,
        origin: 'ai_modified',
        status: 'needs_review',
        updatedAt: options.now,
      });
      summary.testCasesModified += 1;
    } else if (work.target.status !== 'deprecated') {
      // 삭제하지 않고 상태만 바꾼다. 내용이 같으니 revision은 올리지 않는다.
      testCaseUpdates.set(work.target.id, { ...work.target, status: 'deprecated', updatedAt: options.now });
      summary.testCasesDeprecated += 1;
    }
  }

  return {
    requirements: [...assets.requirements.map((item) => requirementUpdates.get(item.id) ?? item), ...newRequirements],
    testCases: [...assets.testCases.map((item) => testCaseUpdates.get(item.id) ?? item), ...newTestCases],
    summary,
  };
}
