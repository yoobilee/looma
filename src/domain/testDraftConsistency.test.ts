import { describe, expect, it } from 'vitest';
import { createSeed, PROJECT_A, PROJECT_B } from '@/data/mock/seed';
import {
  analyzeTestDraftGeneration,
  planTestDraftGeneration,
  produceRuleBasedTestDrafts,
  StaleTestDraftPreviewError,
  summarizeTestDraftAnalysis,
  testDraftSummaryText,
  toTestDraftDecisionInputs,
  type TestDraftContext,
  type TestDraftDecision,
  type TestDraftDecisionInput,
} from './testDraftGeneration';
import type { Requirement, TestCase, TestCondition } from './types';

/*
 * 저장될 결과가 미리보기와 다르면(양식 · 테스트 조건 재사용 · 비교 대상 TC의 내용) 저장을 거부한다.
 * 지문(fingerprint)에 저장 결과를 정하는 값이 모두 들어 있는지 확인한다.
 */

const seed = createSeed();
const NOW = '2026-10-05T09:00:00.000Z';
const STALE = '요구사항이나 기존 TC가 바뀌어 미리보기를 다시 확인해 주세요.';

const requirement = (overrides: Partial<Requirement> = {}): Requirement => ({
  id: 'req-x',
  projectId: PROJECT_A,
  feature: '회원가입',
  text: '이메일로 가입할 수 있다.',
  sourceRefs: [{ deliverableId: 'dlv-plan-pdf', locator: 'p.10' }],
  sourceType: 'source_explicit',
  needsConfirmation: false,
  lifecycle: 'active',
  status: 'draft',
  ...overrides,
});

const baseProject = seed.projects.find((item) => item.id === PROJECT_A)!;
const templates = [
  { id: 'tpl-a', projectId: PROJECT_A },
  { id: 'tpl-b', projectId: PROJECT_A },
];

/** tcTemplateId가 null이면 양식 없는 프로젝트다. */
function context(overrides: Partial<TestDraftContext> = {}, tcTemplateId: string | null = 'tpl-a'): TestDraftContext {
  return {
    project: { ...baseProject, tcTemplateId: tcTemplateId ?? undefined },
    requirements: [requirement()],
    deliverables: structuredClone(seed.deliverables.filter((item) => item.projectId === PROJECT_A)),
    testConditions: [],
    testCases: [],
    templates,
    ...overrides,
  };
}

let nextId = 0;
const createId = (prefix: string) => `${prefix}-${++nextId}`;
const analyze = (ctx: TestDraftContext) => analyzeTestDraftGeneration(ctx, { requirementIds: ['req-x'], perspectives: ['normal_flow'] });
/** 미리보기 시점의 입력을 만든 뒤 지금 상태(current)로 저장을 계획한다. */
function applyLater(previewCtx: TestDraftContext, currentCtx: TestDraftContext, decisions: Record<string, TestDraftDecision> = {}) {
  const inputs = toTestDraftDecisionInputs(analyze(previewCtx), decisions);
  return planTestDraftGeneration(currentCtx, analyze(currentCtx), inputs, { createId, now: NOW });
}
const candidateOf = (ctx: TestDraftContext) => produceRuleBasedTestDrafts(ctx, { requirementIds: ['req-x'], perspectives: ['normal_flow'] }).candidates[0];

const conditionFor = (ctx: TestDraftContext, overrides: Partial<TestCondition> = {}): TestCondition => {
  const candidate = candidateOf(ctx);
  return { id: 'cond-a', projectId: PROJECT_A, requirementIds: ['req-x'], feature: candidate.condition.feature, title: candidate.condition.title, status: 'active', createdAt: NOW, updatedAt: NOW, ...overrides };
};

const existingTestCase = (ctx: TestDraftContext, overrides: Partial<TestCase> = {}): TestCase => {
  const candidate = candidateOf(ctx);
  return {
    id: 'tc-existing',
    projectId: PROJECT_A,
    externalId: 'SIGN-099',
    category: candidate.perspective,
    feature: candidate.testCase.feature,
    depth: ['회원가입', '가입'],
    title: candidate.testCase.title,
    precondition: 'session A',
    steps: [...candidate.testCase.steps],
    expectedResult: candidate.testCase.expectedResult,
    requirementIds: ['req-old'],
    testConditionIds: ['cond-old'],
    sourceRefs: [{ deliverableId: 'dlv-plan-pdf', locator: 'p.1' }],
    generationType: 'source_explicit',
    origin: 'imported',
    status: 'reviewed',
    revision: 3,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
};

describe('양식(templateId)이 미리보기 뒤 바뀐 경우', () => {
  it('저장될 양식이 미리보기 때와 같으면 그 양식이 붙는다', () => {
    expect(applyLater(context(), context()).testCases[0].templateId).toBe('tpl-a');
  });

  it.each([
    ['A → B', () => context({}, 'tpl-b')],
    ['A → 양식 없음', () => context({}, null)],
  ])('%s: 유효한 양식이어도 달라졌으면 저장을 거부한다', (_, current) => {
    expect(() => applyLater(context(), current())).toThrow(StaleTestDraftPreviewError);
    expect(() => applyLater(context(), current())).toThrow(STALE);
  });

  it('양식 없음 → A도 거부한다', () => {
    expect(() => applyLater(context({}, null), context())).toThrow(STALE);
  });

  it('양식이 모든 후보의 지문에 들어 있다(신규 · 중복 · 오류 후보 모두)', () => {
    const ctx = context({ requirements: [requirement({ id: 'ok' }), requirement({ id: 'gone', lifecycle: 'removed' })] });
    const duplicateCtx = context();
    duplicateCtx.testCases = [existingTestCase(duplicateCtx)];
    for (const target of [context(), duplicateCtx]) {
      expect(analyze(target).rows[0].fingerprint).not.toBe(analyze({ ...target, project: { ...target.project, tcTemplateId: 'tpl-b' } }).rows[0].fingerprint);
    }
    expect(ctx.requirements).toHaveLength(2);
  });
});

describe('테스트 조건 재사용이 미리보기 뒤 바뀐 경우(신규 후보)', () => {
  it('미리보기 때 새 조건이 필요했는데 같은 조건이 생겼으면 거부한다', () => {
    const preview = context();
    const current = context({ testConditions: [conditionFor(preview)] });
    expect(() => applyLater(preview, current)).toThrow(STALE);
  });

  it('미리보기 때 재사용하기로 한 조건이 폐기 · 사라졌거나 같은 내용의 다른 ID로 바뀌면 거부한다', () => {
    const base = context();
    const preview = context({ testConditions: [conditionFor(base)] });
    expect(analyze(preview).rows[0].reusedConditionId).toBe('cond-a');
    expect(applyLater(preview, context({ testConditions: [conditionFor(base)] })).testCases[0].testConditionIds).toEqual(['cond-a']);
    expect(() => applyLater(preview, context({ testConditions: [conditionFor(base, { status: 'deprecated' })] }))).toThrow(STALE);
    expect(() => applyLater(preview, context({ testConditions: [] }))).toThrow(STALE);
    expect(() => applyLater(preview, context({ testConditions: [conditionFor(base, { id: 'cond-b' })] }))).toThrow(STALE);
    // 재사용하는 조건의 상태가 바뀌어도(활성 → 재검토 필요) 저장될 결과가 달라진 것이다.
    expect(() => applyLater(preview, context({ testConditions: [conditionFor(base, { status: 'needs_review' })] }))).toThrow(STALE);
  });
});

describe('테스트 조건 재사용이 미리보기 뒤 바뀐 경우(중복 후보)', () => {
  /** 같은 내용의 기존 TC가 있어 중복이고, 판단은 기존 TC와 연결이다. */
  const duplicateContext = (testConditions: TestCondition[] = []) => {
    const base = context();
    return context({ testConditions, testCases: [existingTestCase(base)] });
  };
  const linkKey = 'normal_flow|req-x';

  it('중복 후보도 조건 재사용을 미리보기 때 정하고 지문에 담는다(TC 중복 판정과 별개)', () => {
    const base = context();
    const withCondition = duplicateContext([conditionFor(base)]);
    const row = analyze(withCondition).rows[0];
    expect(row).toMatchObject({ kind: 'duplicate', reusedConditionId: 'cond-a', duplicateTarget: { type: 'existing', id: 'tc-existing' } });
    expect(row.fingerprint).not.toBe(analyze(duplicateContext()).rows[0].fingerprint);
  });

  it('미리보기 때 새 조건이 필요했는데 같은 조건이 생겼으면 연결을 거부한다', () => {
    const base = context();
    expect(() => applyLater(duplicateContext(), duplicateContext([conditionFor(base)]), { [linkKey]: 'link_existing' })).toThrow(STALE);
  });

  it('미리보기 때 재사용하기로 한 조건이 사라지면 연결을 거부하고, 그대로면 그 조건을 연결한다', () => {
    const base = context();
    const preview = duplicateContext([conditionFor(base)]);
    const plan = applyLater(preview, duplicateContext([conditionFor(base)]), { [linkKey]: 'link_existing' });
    expect(plan.testConditions).toEqual([]);
    expect(plan.updatedTestCases[0].testConditionIds).toEqual(['cond-old', 'cond-a']);
    expect(() => applyLater(preview, duplicateContext(), { [linkKey]: 'link_existing' })).toThrow(STALE);
  });
});

describe('연결할 기존 TC의 판단에 영향을 주는 값이 미리보기 뒤 바뀐 경우', () => {
  const link = { 'normal_flow|req-x': 'link_existing' as const };
  const withTarget = (overrides: Partial<TestCase> = {}) => {
    const base = context();
    return context({ testCases: [existingTestCase(base, overrides)] });
  };

  it('바뀌지 않았으면 연결한다(revision +1, 내용 그대로)', () => {
    const plan = applyLater(withTarget(), withTarget(), link);
    expect(plan.updatedTestCases).toHaveLength(1);
    expect(plan.updatedTestCases[0]).toMatchObject({ id: 'tc-existing', revision: 4, precondition: 'session A', requirementIds: ['req-old', 'req-x'] });
  });

  it.each([
    ['사전 조건(revision이 올라도 제목 · 절차 · 기대 결과 · 상태는 그대로)', { precondition: 'session B', revision: 4 }],
    ['사전 조건만(revision은 그대로)', { precondition: 'session B' }],
    ['Depth', { depth: ['회원가입', '다른 분류'] }],
    ['근거 위치', { sourceRefs: [{ deliverableId: 'dlv-plan-pdf', locator: 'p.99' }] }],
    ['근거 산출물', { sourceRefs: [{ deliverableId: 'dlv-figma-auth', locator: 'p.1' }] }],
    ['요구사항 연결', { requirementIds: ['req-old', 'req-z'] }],
    ['테스트 조건 연결', { testConditionIds: ['cond-old', 'cond-z'] }],
    ['revision만 올라감', { revision: 4 }],
    ['상태(검토 완료 → 재검토 필요)', { status: 'needs_review' as const }],
    ['근거 유형', { generationType: 'ai_suggestion' as const }],
    ['출처(origin)', { origin: 'manual' as const }],
    ['양식 ID', { templateId: 'tpl-b' }],
    ['고객사 ID', { externalId: 'SIGN-100' }],
    ['중복 표시', { duplicateOf: 'SIGN-001' }],
  ] as [string, Partial<TestCase>][])('%s → 연결을 거부한다', (_, change) => {
    expect(() => applyLater(withTarget(), withTarget(change), link)).toThrow(StaleTestDraftPreviewError);
    expect(() => applyLater(withTarget(), withTarget(change), link)).toThrow(STALE);
  });

  it('생성 · 수정 시각 · 가져오기 위치처럼 판단과 무관한 값만 바뀌면 그대로 연결할 수 있다', () => {
    const plan = applyLater(withTarget(), withTarget({ updatedAt: '2026-11-01T00:00:00.000Z', importSource: { sessionId: 's', rowNumber: 3 } }), link);
    expect(plan.updatedTestCases).toHaveLength(1);
  });

  it('비교 대상 안의 같은 값이 다른 TC로 바뀌어도 거부한다', () => {
    expect(() => applyLater(withTarget(), withTarget({ id: 'tc-other' }), link)).toThrow(STALE);
  });

  it('저장 계획이 지문과 별개로 비교 대상을 다시 확인한다: 입력 지문을 맞춰도 현재 TC의 값이 다르면 거부한다', () => {
    const previewCtx = withTarget();
    const previewAnalysis = analyze(previewCtx);
    const inputs = toTestDraftDecisionInputs(previewAnalysis, link);
    // 분석은 미리보기 때의 것을 쓰고 문맥(현재 TC)만 바뀐 경우를 직접 만든다.
    const changed = withTarget({ precondition: 'session B' });
    expect(() => planTestDraftGeneration(changed, previewAnalysis, inputs, { createId, now: NOW })).toThrow(STALE);
  });

  it('연결하지 않는 판단(별도 신규 · 제외)도 비교 대상이 바뀌면 거부한다(사용자가 본 판단 대상이 달라졌다)', () => {
    expect(() => applyLater(withTarget(), withTarget({ precondition: 'session B' }), { 'normal_flow|req-x': 'create_separate' })).toThrow(STALE);
  });
});

describe('지문 완전성: 새 TC에 영향을 주는 값이 모두 지문에 있다', () => {
  const fingerprintFor = (ctx: TestDraftContext) => analyze(ctx).rows[0].fingerprint;
  const reference = fingerprintFor(context());

  it.each([
    ['요구사항 문장(제목 · 절차 · 기대 결과)', () => context({ requirements: [requirement({ text: '다른 문장이다.' })] })],
    ['기능(구분 · 기능 · Depth · 조건)', () => context({ requirements: [requirement({ feature: '다른 기능' })] })],
    ['근거(sourceRefs)', () => context({ requirements: [requirement({ sourceRefs: [{ deliverableId: 'dlv-plan-pdf', locator: 'p.77' }] })] })],
    ['근거 유형(generationType)', () => context({ requirements: [requirement({ sourceType: 'ai_suggestion' })] })],
    ['확인 필요(조건 상태)', () => context({ requirements: [requirement({ needsConfirmation: true })] })],
    ['양식 ID', () => context({}, 'tpl-b')],
    ['양식 없음', () => context({}, null)],
    ['조건 재사용 ID', () => context({ testConditions: [conditionFor(context())] })],
    ['같은 TC가 생겨 중복 판정', () => context({ testCases: [existingTestCase(context())] })],
  ] as [string, () => TestDraftContext][])('%s가 달라지면 지문이 달라진다', (_, change) => {
    expect(fingerprintFor(change())).not.toBe(reference);
  });

  it('같은 입력이면 지문이 같고 다른 프로젝트의 TC · 조건은 영향이 없다', () => {
    expect(fingerprintFor(context())).toBe(reference);
    const other = context({ testCases: [existingTestCase(context(), { projectId: PROJECT_B })], testConditions: [conditionFor(context(), { projectId: PROJECT_B })] });
    expect(fingerprintFor(other)).toBe(reference);
  });
});

describe('요약 문구: 기존 TC 연결과 생성 TC 연결을 나눈다', () => {
  const sums = (decisions: Record<string, TestDraftDecision>, ctx: TestDraftContext, ids = ['req-x']) => {
    const analysis = analyzeTestDraftGeneration(ctx, { requirementIds: ids, perspectives: ['normal_flow'] });
    const plan = planTestDraftGeneration(ctx, analysis, toTestDraftDecisionInputs(analysis, decisions), { createId, now: NOW });
    return { analysis, plan };
  };

  it('기존 TC에 연결하면 기존 TC 연결 1 · 생성 TC 연결 0이다', () => {
    const base = context();
    const ctx = context({ testCases: [existingTestCase(base)] });
    const { plan } = sums({ 'normal_flow|req-x': 'link_existing' }, ctx);
    expect(plan.summary).toMatchObject({ created: 0, linked: 1, linkedToNew: 0 });
    expect(testDraftSummaryText(plan)).toContain('기존 TC 연결 1 · 생성 TC 연결 0');
  });

  it('같은 배치의 앞선 후보에 연결하면 기존 TC 연결 0 · 생성 TC 연결 1이다', () => {
    const ctx = context({ requirements: [requirement({ id: 'r1' }), requirement({ id: 'r2' })] });
    const { plan } = sums({ 'normal_flow|r2': 'link_existing' }, ctx, ['r1', 'r2']);
    expect(plan.summary).toMatchObject({ created: 1, linked: 0, linkedToNew: 1 });
    expect(testDraftSummaryText(plan)).toContain('신규 TC 1(별도 신규 0) · 기존 TC 연결 0 · 생성 TC 연결 1');
    expect(plan.updatedTestCases).toEqual([]);
  });

  it('둘 다 있으면 각각 센다', () => {
    const base = context({ requirements: [requirement({ id: 'r1' }), requirement({ id: 'r2' }), requirement({ id: 'r3', text: '다른 문장이다.' })] });
    // r3의 정상 흐름과 같은 내용의 기존 TC
    const r3 = produceRuleBasedTestDrafts(base, { requirementIds: ['r3'], perspectives: ['normal_flow'] }).candidates[0];
    const ctx = { ...base, testCases: [existingTestCase(context(), { title: r3.testCase.title, feature: r3.testCase.feature, steps: r3.testCase.steps, expectedResult: r3.testCase.expectedResult })] };
    const analysis = analyzeTestDraftGeneration(ctx, { requirementIds: ['r1', 'r2', 'r3'], perspectives: ['normal_flow'] });
    const decisions = { 'normal_flow|r2': 'link_existing' as const, 'normal_flow|r3': 'link_existing' as const };
    const inputs: TestDraftDecisionInput[] = toTestDraftDecisionInputs(analysis, decisions);
    const plan = planTestDraftGeneration(ctx, analysis, inputs, { createId, now: NOW });
    expect(summarizeTestDraftAnalysis(analysis, decisions)).toMatchObject({ created: 1, linked: 1, linkedToNew: 1 });
    expect(plan.summary).toMatchObject({ created: 1, linked: 1, linkedToNew: 1 });
    expect(plan.updatedTestCases).toHaveLength(1);
  });
});
