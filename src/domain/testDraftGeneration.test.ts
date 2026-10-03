import { describe, expect, it } from 'vitest';
import { createSeed, PROJECT_A, PROJECT_B } from '@/data/mock/seed';
import {
  analyzeTestDraftCandidates,
  analyzeTestDraftGeneration,
  isPerspectiveAvailable,
  isTestDraftEligible,
  planTestDraftGeneration,
  produceRuleBasedTestDrafts,
  summarizeTestDraftAnalysis,
  testDraftCandidateKey,
  TestDraftGenerationError,
  type TestDraftCandidate,
  type TestDraftContext,
} from './testDraftGeneration';
import type { Project, Requirement, TestCase, TestCondition, TestPerspective } from './types';

const seed = createSeed();
const NOW = '2026-10-05T09:00:00.000Z';

/** 예시 프로젝트 A를 바탕으로 한 입력. 기존 TC · 조건을 비워 필요한 것만 채워 쓴다. */
function context(overrides: Partial<TestDraftContext> = {}, project: Partial<Project> = {}): TestDraftContext {
  const base = seed.projects.find((item) => item.id === PROJECT_A)!;
  return {
    project: { ...base, ...project },
    requirements: structuredClone(seed.requirements.filter((item) => item.projectId === PROJECT_A)),
    deliverables: structuredClone(seed.deliverables.filter((item) => item.projectId === PROJECT_A)),
    testConditions: [],
    testCases: [],
    ...overrides,
  };
}

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

let nextId = 0;
const createId = (prefix: string) => `${prefix}-${++nextId}`;
const only = (ctx: TestDraftContext, perspectives: TestPerspective[], ...ids: string[]) => analyzeTestDraftGeneration(ctx, { requirementIds: ids, perspectives });
const withRequirements = (...items: Requirement[]) => context({ requirements: items });

describe('생성 대상 · 요청 검증', () => {
  it('고른 요구사항만 대상이고 검토 상태(draft)와 무관하다', () => {
    const analysis = only(context(), ['normal_flow'], 'req-001', 'req-006');
    expect(analysis.rows.map((row) => row.candidate.requirementIds)).toEqual([['req-001'], ['req-006']]);
    expect(seed.requirements.find((item) => item.id === 'req-005')!.status).toBe('draft');
    expect(only(context(), ['normal_flow'], 'req-005').rows).toHaveLength(1);
    expect(analysis.requirementCount).toBe(2);
    expect(analysis.perspectiveCount).toBe(1);
  });

  it('제거된 요구사항 · 없는 요구사항 · 다른 프로젝트의 요구사항은 거부한다', () => {
    const ctx = context({ requirements: [...context().requirements, requirement({ id: 'req-other', projectId: PROJECT_B })] });
    expect(isTestDraftEligible(seed.requirements.find((item) => item.id === 'req-013')!, PROJECT_A)).toBe(false);
    expect(() => only(ctx, ['normal_flow'], 'req-013')).toThrow('제거된 요구사항으로는 초안을 만들 수 없어요.');
    expect(() => only(ctx, ['normal_flow'], 'req-missing')).toThrow('이 프로젝트에서 요구사항을 찾을 수 없어요. (req-missing)');
    expect(() => only(ctx, ['normal_flow'], 'req-other')).toThrow('이 프로젝트에서 요구사항을 찾을 수 없어요. (req-other)');
    expect(() => only(ctx, ['normal_flow'], 'req-001', 'req-001')).toThrow('같은 요구사항을 두 번 골랐어요.');
    expect(() => only(ctx, ['normal_flow'])).toThrow('초안을 만들 요구사항을 하나 이상 골라 주세요.');
  });

  it('관점이 비었거나 알 수 없거나 겹치거나 프로젝트 범위에 없으면 거부한다', () => {
    expect(() => only(context(), [], 'req-001')).toThrow(TestDraftGenerationError);
    expect(() => only(context(), [], 'req-001')).toThrow('테스트 관점을 하나 이상 골라 주세요.');
    expect(() => only(context(), ['hacked' as TestPerspective], 'req-001')).toThrow('알 수 없는 테스트 관점이에요.');
    expect(() => only(context(), ['normal_flow', 'normal_flow'], 'req-001')).toThrow('같은 테스트 관점을 두 번 골랐어요.');
    // 프로젝트 A에는 API · 성능 · 호환성 범위가 없다.
    for (const perspective of ['api', 'performance', 'compatibility'] as const) {
      expect(isPerspectiveAvailable(perspective, context().project)).toBe(false);
      expect(() => only(context(), [perspective], 'req-001')).toThrow('이 프로젝트의 테스트 범위에 없는 관점이에요.');
    }
    expect(isPerspectiveAvailable('boundary', context().project)).toBe(true);
    expect(isPerspectiveAvailable('api', { testScopes: ['api'] })).toBe(true);
  });
});

describe('규칙 기반 후보', () => {
  it('정상 흐름 · 예외는 모든 요구사항에서 만들고, 요구사항 문장만 인용한다', () => {
    const ctx = withRequirements(requirement({ id: 'req-pw', feature: '비밀번호 재설정', text: '가입한 이메일로 재설정 링크를 보낸다.' }));
    const { candidates, skipped } = produceRuleBasedTestDrafts(ctx, { requirementIds: ['req-pw'], perspectives: ['normal_flow', 'exception'] });
    expect(skipped).toEqual([]);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toEqual({
      key: 'normal_flow|req-pw',
      perspective: 'normal_flow',
      requirementIds: ['req-pw'],
      generationType: 'source_explicit',
      condition: { feature: '비밀번호 재설정', title: '정상 흐름 · 가입한 이메일로 재설정 링크를 보낸다' },
      testCase: {
        feature: '비밀번호 재설정',
        depth: ['비밀번호 재설정', '정상 흐름'],
        title: '가입한 이메일로 재설정 링크를 보낸다 · 정상 흐름 확인',
        steps: ['요구사항과 관련된 기능 화면으로 이동한다.', '요구사항에 적힌 조건으로 동작을 수행한다.', '결과를 확인한다.'],
        expectedResult: '요구사항대로 동작한다. (가입한 이메일로 재설정 링크를 보낸다)',
      },
    });
    expect(candidates[1].testCase.expectedResult).toBe('요구사항에 정의된 예외 처리가 수행된다. (가입한 이메일로 재설정 링크를 보낸다)');
    // 사전 조건은 근거가 없으므로 만들지 않는다.
    expect(candidates[0].testCase).not.toHaveProperty('precondition');
  });

  it('경계값은 숫자 · 최소 · 최대 단서가 있을 때만 만들고, 숫자 표현은 절차에 그대로 옮긴다', () => {
    const ctx = context();
    const withClue = produceRuleBasedTestDrafts(ctx, { requirementIds: ['req-002'], perspectives: ['boundary'] });
    expect(withClue.candidates).toHaveLength(1);
    expect(withClue.candidates[0].testCase.steps[0]).toBe('요구사항에 적힌 기준값(8자)을 확인한다.');
    const wordOnly = produceRuleBasedTestDrafts(withRequirements(requirement({ text: '이름은 최소 한 글자 이상이어야 한다.' })), { requirementIds: ['req-x'], perspectives: ['boundary'] });
    expect(wordOnly.candidates[0].testCase.steps[0]).toBe('요구사항에 적힌 기준값을 확인한다.');
    const noClue = produceRuleBasedTestDrafts(withRequirements(requirement()), { requirementIds: ['req-x'], perspectives: ['boundary'] });
    expect(noClue.candidates).toEqual([]);
    expect(noClue.skipped).toEqual([{ requirementId: 'req-x', perspective: 'boundary', reason: '요구사항에 경계값 단서가 없어 만들지 않았어요.' }]);
  });

  it.each([
    ['permission', '관리자만 사용자 목록을 열람할 수 있다.', '이름을 입력하면 저장된다.'],
    ['state_change', '앱을 재실행해도 로그인 상태를 유지한다.', '이름을 입력하면 저장된다.'],
    ['data_io', '입력한 내용을 서버에 저장한다.', '로그인 화면이 열린다.'],
  ] as [TestPerspective, string, string][])('%s는 단서가 있는 요구사항에만 만든다', (perspective, clueText, plainText) => {
    const ctx = withRequirements(requirement({ id: 'with', text: clueText }), requirement({ id: 'without', text: plainText }));
    const { candidates, skipped } = produceRuleBasedTestDrafts(ctx, { requirementIds: ['with', 'without'], perspectives: [perspective] });
    expect(candidates.map((candidate) => candidate.requirementIds)).toEqual([['with']]);
    expect(skipped.map((item) => item.requirementId)).toEqual(['without']);
  });

  it('API · 성능은 프로젝트 범위에 있고 요구사항에 단서가 있을 때만 만들며 임의 값을 만들지 않는다', () => {
    const ctx = withRequirements(requirement({ id: 'api', text: '로그인 요청이 성공하면 토큰을 응답한다.' }), requirement({ id: 'perf', text: '목록은 3초 이내에 표시한다.' }), requirement({ id: 'none', text: '약관에 동의한다.' }));
    const project = { testScopes: ['functional', 'api', 'performance'] as Project['testScopes'] };
    const result = produceRuleBasedTestDrafts({ ...ctx, project: { ...ctx.project, ...project } }, { requirementIds: ['api', 'perf', 'none'], perspectives: ['api', 'performance'] });
    expect(result.candidates.map((candidate) => [candidate.requirementIds[0], candidate.perspective])).toEqual([
      ['api', 'api'],
      ['perf', 'performance'],
    ]);
    const text = result.candidates.map((candidate) => [...candidate.testCase.steps, candidate.testCase.expectedResult].join(' ')).join(' ');
    // 요구사항에 없는 상태 코드 · 경로 · 시간 값은 없다.
    expect(text).not.toMatch(/\b[1-5]\d\d\b|\/api|ms\b/);
    expect(result.skipped).toHaveLength(4);
  });

  it('호환성은 프로젝트 범위와 플랫폼 안에서만 만든다(임의 OS · 브라우저 없음)', () => {
    const ctx = context({}, { testScopes: ['functional', 'compatibility'], platforms: ['android', 'ios'] });
    const { candidates } = produceRuleBasedTestDrafts(ctx, { requirementIds: ['req-001'], perspectives: ['compatibility'] });
    expect(candidates[0].testCase.steps).toEqual(['Android에서 요구사항과 관련된 동작을 수행한다.', 'iOS에서 요구사항과 관련된 동작을 수행한다.', '플랫폼별 결과를 비교한다.']);
    const empty = produceRuleBasedTestDrafts(context({}, { testScopes: ['compatibility'], platforms: [] }), { requirementIds: ['req-001'], perspectives: ['compatibility'] });
    expect(empty.candidates).toEqual([]);
    expect(empty.skipped[0].reason).toBe('프로젝트에 플랫폼이 없어 만들지 않았어요.');
  });

  it('후보 순서는 요구사항 순서 → 관점 순서이고 같은 입력이면 같은 결과다(입력은 바뀌지 않는다)', () => {
    const ctx = context();
    const before = structuredClone(ctx);
    const request = { requirementIds: ['req-006', 'req-001'], perspectives: ['exception', 'normal_flow'] as TestPerspective[] };
    const first = produceRuleBasedTestDrafts(ctx, request);
    expect(first.candidates.map((candidate) => candidate.key)).toEqual(['exception|req-006', 'normal_flow|req-006', 'exception|req-001', 'normal_flow|req-001']);
    expect(produceRuleBasedTestDrafts(ctx, request)).toEqual(first);
    expect(ctx).toEqual(before);
  });
});

describe('확인 필요 · 근거 유형', () => {
  it('확인 필요 표시는 근거 유형보다 우선하고, 근거 유형은 요구사항에서 물려받는다', () => {
    const ctx = withRequirements(
      requirement({ id: 'explicit' }),
      requirement({ id: 'flagged', needsConfirmation: true }),
      requirement({ id: 'typed', sourceType: 'needs_confirmation' }),
      requirement({ id: 'suggested', sourceType: 'ai_suggestion' }),
    );
    const analysis = only(ctx, ['normal_flow'], 'explicit', 'flagged', 'typed', 'suggested');
    expect(analysis.rows.map((row) => [row.candidate.requirementIds[0], row.candidate.generationType, row.needsConfirmation])).toEqual([
      ['explicit', 'source_explicit', false],
      ['flagged', 'needs_confirmation', true],
      ['typed', 'needs_confirmation', true],
      ['suggested', 'ai_suggestion', false],
    ]);
    expect(analysis.rows[1].candidate.testCase.expectedResult).toBe('확인 필요 — 요구사항 확정 후 기대 결과를 정해요. (이메일로 가입할 수 있다)');
  });
});

describe('판정: 중복 · 조건 재사용 · 오류', () => {
  const existingTestCase = (candidate: TestDraftCandidate, overrides: Partial<TestCase> = {}): TestCase => ({
    id: 'tc-existing',
    projectId: PROJECT_A,
    externalId: 'SIGN-099',
    category: candidate.perspective,
    feature: candidate.testCase.feature,
    depth: ['a'],
    title: candidate.testCase.title,
    steps: [...candidate.testCase.steps],
    expectedResult: candidate.testCase.expectedResult,
    requirementIds: [],
    testConditionIds: [],
    sourceRefs: [],
    generationType: 'source_explicit',
    origin: 'imported',
    status: 'draft',
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
  const base = () => produceRuleBasedTestDrafts(withRequirements(requirement()), { requirementIds: ['req-x'], perspectives: ['normal_flow'] }).candidates[0];

  it('구분 · 기능 · 제목 · 절차 · 기대 결과가 정확히 같은 기존 TC는 중복이고 고객사 ID로 보여준다(공백 · 유니코드 차이 무시)', () => {
    const candidate = base();
    const ctx = withRequirements(requirement());
    ctx.testCases = [existingTestCase(candidate, { title: `  ${candidate.testCase.title.normalize('NFD')}  `, steps: candidate.testCase.steps.map((step) => ` ${step}  `) })];
    const analysis = only(ctx, ['normal_flow'], 'req-x');
    expect(analysis.rows[0]).toMatchObject({ kind: 'duplicate', duplicateOf: { id: 'tc-existing', label: 'SIGN-099' }, reasons: ['같은 내용의 TC가 이미 있어요.'] });
    // 고객사 ID가 없으면 내부 ID를 쓴다.
    ctx.testCases = [existingTestCase(candidate, { externalId: undefined })];
    expect(only(ctx, ['normal_flow'], 'req-x').rows[0].duplicateOf).toEqual({ id: 'tc-existing', label: 'tc-existing' });
  });

  it('비슷하기만 한 TC · 다른 구분 · 다른 프로젝트 · 폐기된 TC는 중복이 아니다(fuzzy 없음)', () => {
    const candidate = base();
    const ctx = withRequirements(requirement());
    for (const overrides of [
      { expectedResult: `${candidate.testCase.expectedResult}!` },
      { steps: candidate.testCase.steps.slice(1) },
      { title: candidate.testCase.title.replace('정상', '비정상') },
      { category: 'exception' as const },
      { projectId: PROJECT_B },
      { status: 'deprecated' as const },
    ]) {
      ctx.testCases = [existingTestCase(candidate, overrides)];
      expect(only(ctx, ['normal_flow'], 'req-x').rows[0].kind).toBe('create');
    }
  });

  it('externalId는 판정에 쓰이지 않고 새 후보에도 만들지 않는다', () => {
    const candidate = base();
    const ctx = withRequirements(requirement());
    ctx.testCases = [existingTestCase(candidate, { title: '다른 제목', externalId: 'SIGN-001' })];
    const analysis = only(ctx, ['normal_flow'], 'req-x');
    expect(analysis.rows[0].kind).toBe('create');
    expect(planTestDraftGeneration(ctx, analysis, [], { createId, now: NOW }).testCases[0]).not.toHaveProperty('externalId');
  });

  it('같은 요구사항 · 기능 · 제목의 테스트 조건이 있으면 새로 만들지 않고 재사용하며, 조건은 수정하지 않는다', () => {
    const candidate = base();
    const existing: TestCondition = { id: 'cond-existing', projectId: PROJECT_A, requirementIds: ['req-x'], feature: candidate.condition.feature, title: candidate.condition.title, status: 'active', createdAt: NOW, updatedAt: NOW };
    const ctx = withRequirements(requirement());
    ctx.testConditions = [existing];
    const before = structuredClone(ctx.testConditions);
    const analysis = only(ctx, ['normal_flow'], 'req-x');
    expect(analysis.rows[0].reusedConditionId).toBe('cond-existing');
    const plan = planTestDraftGeneration(ctx, analysis, [], { createId, now: NOW });
    expect(plan.testConditions).toEqual([]);
    expect(plan.testCases[0].testConditionIds).toEqual(['cond-existing']);
    expect([plan.conditionsCreated, plan.conditionsReused]).toEqual([0, 1]);
    expect(ctx.testConditions).toEqual(before);
    // 제목이 조금 달라도 · 요구사항이 다르거나 폐기된 조건도 재사용하지 않는다.
    for (const overrides of [{ title: `${existing.title}.` }, { requirementIds: ['req-y'] }, { status: 'deprecated' as const }, { projectId: PROJECT_B }]) {
      ctx.testConditions = [{ ...existing, ...overrides }];
      expect(only(ctx, ['normal_flow'], 'req-x').rows[0].reusedConditionId).toBeUndefined();
    }
  });

  it('시드의 한 조건이 여러 요구사항에 연결된 경우도 요구사항 집합이 같을 때만 재사용한다', () => {
    const multi: TestCondition = { id: 'cond-multi', projectId: PROJECT_A, requirementIds: ['req-001', 'req-002'], feature: '회원가입', title: '정상 흐름 · 이메일, 비밀번호, 약관 동의를 입력하면 가입할 수 있다', status: 'active', createdAt: NOW, updatedAt: NOW };
    const ctx = context({ testConditions: [multi] });
    expect(only(ctx, ['normal_flow'], 'req-001').rows[0].reusedConditionId).toBeUndefined();
  });

  it('제거된 요구사항 · 다른 프로젝트 산출물을 가리키는 후보는 오류다(AI가 만든 후보도 같은 규칙)', () => {
    const ctx = withRequirements(requirement({ id: 'ok' }), requirement({ id: 'gone', lifecycle: 'removed' }), requirement({ id: 'bad-ref', sourceRefs: [{ deliverableId: 'dlv-b-spec', locator: 'p.1' }] }));
    const candidate = (id: string): TestDraftCandidate => ({ ...base(), key: testDraftCandidateKey('normal_flow', [id]), requirementIds: [id] });
    const analysis = analyzeTestDraftCandidates(ctx, [candidate('ok'), candidate('gone'), candidate('bad-ref'), candidate('missing')], [], { requirementCount: 4, perspectiveCount: 1 });
    expect(analysis.rows.map((row) => row.kind)).toEqual(['create', 'invalid', 'invalid', 'invalid']);
    expect(analysis.rows[1].reasons).toEqual(['제거된 요구사항이에요. (gone)']);
    expect(analysis.rows[2].reasons).toEqual(['근거 산출물을 찾을 수 없어요. (dlv-b-spec)']);
    expect(analysis.rows[3].reasons).toEqual(['이 프로젝트에서 요구사항을 찾을 수 없어요. (missing)']);
    expect(() => analyzeTestDraftCandidates(ctx, [candidate('ok'), candidate('ok')], [], { requirementCount: 1, perspectiveCount: 1 })).toThrow('같은 후보가 두 번 있어요.');
  });

  it('이번에 만드는 후보끼리 같은 내용이면 뒤의 후보가 중복이다', () => {
    const ctx = withRequirements(requirement());
    const first = base();
    const second = { ...first, key: 'normal_flow|req-x#2' };
    const analysis = analyzeTestDraftCandidates(ctx, [first, second], [], { requirementCount: 1, perspectiveCount: 1 });
    expect(analysis.rows.map((row) => [row.kind, row.reasons[0]])).toEqual([['create', undefined], ['duplicate', '이번에 만드는 다른 후보와 같은 내용이에요.']]);
  });
});

describe('저장 계획', () => {
  const ctx = () => context();
  const analysisFor = (...ids: string[]) => only(ctx(), ['normal_flow', 'boundary'], ...ids);

  it('새 TC는 초안 · revision 1 · 요구사항 / 조건 / 근거 연결이고 고객사 ID가 없으며 같은 시각을 쓴다', () => {
    const plan = planTestDraftGeneration(ctx(), analysisFor('req-002'), [], { createId, now: NOW });
    expect(plan.testCases).toHaveLength(2);
    expect(plan.testConditions).toHaveLength(2);
    const [normal, boundary] = plan.testCases;
    expect(normal).toEqual({
      id: expect.stringMatching(/^tc-/),
      projectId: PROJECT_A,
      templateId: 'tpl-client-a',
      category: 'normal_flow',
      feature: '회원가입',
      depth: ['회원가입', '정상 흐름'],
      title: '비밀번호는 영문과 숫자를 포함해 8자 이상이어야 한다 · 정상 흐름 확인',
      steps: expect.any(Array),
      expectedResult: '요구사항대로 동작한다. (비밀번호는 영문과 숫자를 포함해 8자 이상이어야 한다)',
      requirementIds: ['req-002'],
      testConditionIds: [plan.testConditions[0].id],
      sourceRefs: [{ deliverableId: 'dlv-plan-pdf', locator: 'p.14' }],
      generationType: 'source_explicit',
      origin: 'manual',
      status: 'draft',
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(boundary.testConditionIds).toEqual([plan.testConditions[1].id]);
    expect(plan.testConditions[0]).toEqual({
      id: expect.stringMatching(/^cond-/),
      projectId: PROJECT_A,
      requirementIds: ['req-002'],
      feature: '회원가입',
      title: '정상 흐름 · 비밀번호는 영문과 숫자를 포함해 8자 이상이어야 한다',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
    for (const testCase of plan.testCases) expect(testCase).not.toHaveProperty('externalId');
  });

  it('프로젝트에 템플릿이 없어도 만들 수 있고 templateId만 비어 있다', () => {
    const noTemplate = context({}, { tcTemplateId: undefined });
    const plan = planTestDraftGeneration(noTemplate, only(noTemplate, ['normal_flow'], 'req-001'), [], { createId, now: NOW });
    expect(plan.testCases[0]).not.toHaveProperty('templateId');
    expect(plan.testCases[0].generationType).toBe('source_explicit');
    expect(plan.testConditions[0].status).toBe('active');
  });

  it('근거는 요구사항의 것을 그대로 쓰고, 여러 요구사항이 한 후보에 이어지면 중복 없이 순서대로 합친다', () => {
    const ctx2 = withRequirements(
      requirement({ id: 'r1', sourceRefs: [{ deliverableId: 'dlv-plan-pdf', locator: 'p.1' }, { deliverableId: 'dlv-plan-pdf', locator: 'p.2' }] }),
      requirement({ id: 'r2', sourceRefs: [{ deliverableId: 'dlv-plan-pdf', locator: 'p.2' }, { deliverableId: 'dlv-figma-auth', locator: 'F1' }] }),
    );
    const base = produceRuleBasedTestDrafts(ctx2, { requirementIds: ['r1'], perspectives: ['normal_flow'] }).candidates[0];
    const merged: TestDraftCandidate = { ...base, key: testDraftCandidateKey('normal_flow', ['r1', 'r2']), requirementIds: ['r1', 'r2'] };
    const analysis = analyzeTestDraftCandidates(ctx2, [merged], [], { requirementCount: 2, perspectiveCount: 1 });
    expect(analysis.rows[0].sourceRefs).toEqual([
      { deliverableId: 'dlv-plan-pdf', locator: 'p.1' },
      { deliverableId: 'dlv-plan-pdf', locator: 'p.2' },
      { deliverableId: 'dlv-figma-auth', locator: 'F1' },
    ]);
    const plan = planTestDraftGeneration(ctx2, analysis, [], { createId, now: NOW });
    expect(plan.testCases[0].requirementIds).toEqual(['r1', 'r2']);
    expect(plan.testConditions[0].requirementIds).toEqual(['r1', 'r2']);
    // 계획의 근거는 요구사항 객체와 따로 복사한 값이다.
    plan.testCases[0].sourceRefs[0].locator = '바뀜';
    expect(ctx2.requirements[0].sourceRefs[0].locator).toBe('p.1');
  });

  it('같은 조건을 쓰는 후보가 둘이면 조건은 한 번만 만들고 나머지는 재사용으로 센다', () => {
    const ctx2 = withRequirements(requirement());
    const first = produceRuleBasedTestDrafts(ctx2, { requirementIds: ['req-x'], perspectives: ['normal_flow'] }).candidates[0];
    const second: TestDraftCandidate = { ...first, key: 'normal_flow|req-x#2', testCase: { ...first.testCase, title: '다른 제목' } };
    const plan = planTestDraftGeneration(ctx2, analyzeTestDraftCandidates(ctx2, [first, second], [], { requirementCount: 1, perspectiveCount: 1 }), [], { createId, now: NOW });
    expect(plan.testCases).toHaveLength(2);
    expect(plan.testConditions).toHaveLength(1);
    expect(plan.testCases.map((item) => item.testConditionIds[0])).toEqual([plan.testConditions[0].id, plan.testConditions[0].id]);
    expect([plan.conditionsCreated, plan.conditionsReused]).toEqual([1, 1]);
  });

  it('사용자가 제외한 후보는 만들지 않고, 요약은 신규 · 확인 필요 · 중복 · 오류 · 제외 · 건너뜀을 센다', () => {
    const analysis = analysisFor('req-001', 'req-002');
    // req-001: 정상 흐름(경계값 단서 없음) / req-002: 정상 흐름 + 경계값
    expect(analysis.rows.map((row) => row.candidate.key)).toEqual(['normal_flow|req-001', 'normal_flow|req-002', 'boundary|req-002']);
    expect(analysis.skipped).toHaveLength(1);
    expect(summarizeTestDraftAnalysis(analysis)).toEqual({ requirementCount: 2, perspectiveCount: 2, created: 3, needsConfirmation: 0, duplicate: 0, invalid: 0, excluded: 0, skipped: 1 });
    const plan = planTestDraftGeneration(ctx(), analysis, ['boundary|req-002'], { createId, now: NOW });
    expect(plan.testCases.map((item) => item.category)).toEqual(['normal_flow', 'normal_flow']);
    expect(plan.summary).toMatchObject({ created: 2, needsConfirmation: 0, excluded: 1 });
    // 제외한 후보의 조건도 만들지 않는다.
    expect(plan.testConditions).toHaveLength(2);
  });

  it('제외 목록: 없는 후보 · 중복 · 오류 · 같은 key 두 번은 조용히 무시하지 않고 거부한다', () => {
    const existing = produceRuleBasedTestDrafts(ctx(), { requirementIds: ['req-001'], perspectives: ['normal_flow'] }).candidates[0];
    const c = ctx();
    c.testCases = [
      {
        id: 'tc-dup',
        projectId: PROJECT_A,
        category: 'normal_flow',
        feature: existing.testCase.feature,
        depth: [],
        title: existing.testCase.title,
        steps: existing.testCase.steps,
        expectedResult: existing.testCase.expectedResult,
        requirementIds: [],
        testConditionIds: [],
        sourceRefs: [],
        generationType: 'source_explicit',
        origin: 'manual',
        status: 'draft',
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    const analysis = only(c, ['normal_flow'], 'req-001', 'req-006');
    expect(analysis.rows.map((row) => row.kind)).toEqual(['duplicate', 'create']);
    const plan = (excluded: string[]) => planTestDraftGeneration(c, analysis, excluded, { createId, now: NOW });
    expect(() => plan(['normal_flow|req-missing'])).toThrow('제외할 수 있는 TC 초안 후보가 아니에요.');
    expect(() => plan(['normal_flow|req-001'])).toThrow('제외할 수 있는 TC 초안 후보가 아니에요.');
    expect(() => plan(['normal_flow|req-006', 'normal_flow|req-006'])).toThrow('같은 후보를 제외 목록에 두 번 넣었어요.');
    // 중복은 만들지 않고 나머지만 만든다.
    expect(plan([]).testCases.map((item) => item.requirementIds)).toEqual([['req-006']]);
    expect(plan([]).summary).toMatchObject({ created: 1, duplicate: 1 });
  });

  it('만들 후보가 없으면(모두 중복 · 오류 · 제외 · 건너뜀) 던진다', () => {
    const empty = only(withRequirements(requirement()), ['boundary'], 'req-x');
    expect(empty.rows).toEqual([]);
    expect(() => planTestDraftGeneration(ctx(), empty, [], { createId, now: NOW })).toThrow('만들 수 있는 새 TC 초안이 없어요.');
    const all = analysisFor('req-001');
    expect(() => planTestDraftGeneration(ctx(), all, ['normal_flow|req-001'], { createId, now: NOW })).toThrow('만들 수 있는 새 TC 초안이 없어요.');
  });

  it('입력(문맥 · 분석)을 바꾸지 않고 같은 입력이면 같은 계획이다', () => {
    const c = ctx();
    const before = structuredClone(c);
    const analysis = only(c, ['normal_flow', 'exception'], 'req-001', 'req-006');
    const analysisBefore = structuredClone(analysis);
    let n = 0;
    const ids = (prefix: string) => `${prefix}-${++n}`;
    const first = planTestDraftGeneration(c, analysis, [], { createId: ids, now: NOW });
    n = 0;
    expect(planTestDraftGeneration(c, analysis, [], { createId: ids, now: NOW })).toEqual(first);
    expect(c).toEqual(before);
    expect(analysis).toEqual(analysisBefore);
  });
});

describe('확인 필요 요구사항의 저장 계획', () => {
  it('확인 필요 요구사항(req-004)의 TC는 needs_confirmation · 초안이고 조건은 재검토 필요 상태다', () => {
    const c = context();
    const plan = planTestDraftGeneration(c, only(c, ['normal_flow'], 'req-004'), [], { createId, now: NOW });
    expect(plan.testCases[0]).toMatchObject({ generationType: 'needs_confirmation', status: 'draft', requirementIds: ['req-004'], sourceRefs: [{ deliverableId: 'dlv-figma-auth', locator: '회원가입 Frame' }] });
    expect(plan.testCases[0].expectedResult).toMatch(/^확인 필요 — /);
    expect(plan.testConditions[0].status).toBe('needs_review');
    expect(plan.summary).toMatchObject({ created: 1, needsConfirmation: 1 });
  });
});
