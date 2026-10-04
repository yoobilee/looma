import { describe, expect, it } from 'vitest';
import { createSeed, PROJECT_A, PROJECT_B } from '@/data/mock/seed';
import {
  analyzeTestDraftCandidates,
  analyzeTestDraftGeneration,
  defaultTestDraftDecision,
  isPerspectiveAvailable,
  isTestDraftEligible,
  planTestDraftGeneration,
  produceRuleBasedTestDrafts,
  resolveTestDraftDecisions,
  StaleTestDraftPreviewError,
  summarizeTestDraftAnalysis,
  testDraftCandidateKey,
  TestDraftGenerationError,
  toTestDraftDecisionInputs,
  validateDraftTemplate,
  type TestDraftAnalysis,
  type TestDraftCandidate,
  type TestDraftContext,
  type TestDraftDecision,
  type TestDraftDecisionInput,
} from './testDraftGeneration';
import type { Project, Requirement, SourceRef, TestCase, TestCondition, TestPerspective } from './types';

const seed = createSeed();
const NOW = '2026-10-05T09:00:00.000Z';
const STALE = '요구사항이나 기존 TC가 바뀌어 미리보기를 다시 확인해 주세요.';

/** 예시 프로젝트 A를 바탕으로 한 입력. 기존 TC · 조건을 비워 필요한 것만 채워 쓴다. */
function context(overrides: Partial<TestDraftContext> = {}, project: Partial<Project> = {}): TestDraftContext {
  const base = seed.projects.find((item) => item.id === PROJECT_A)!;
  return {
    project: { ...base, ...project },
    requirements: structuredClone(seed.requirements.filter((item) => item.projectId === PROJECT_A)),
    deliverables: structuredClone(seed.deliverables.filter((item) => item.projectId === PROJECT_A)),
    testConditions: [],
    testCases: [],
    templates: structuredClone(seed.templates),
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
/** 판단(기본값 + 고른 것)으로 저장 입력을 만들어 계획한다. */
const plan = (ctx: TestDraftContext, analysis: TestDraftAnalysis, decisions: Record<string, TestDraftDecision> = {}) =>
  planTestDraftGeneration(ctx, analysis, toTestDraftDecisionInputs(analysis, decisions), { createId, now: NOW });

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

  it('경계값은 최소 · 최대 · 숫자+이상/이하 같은 단서가 있을 때만 만들고, 숫자 표현은 절차에 그대로 옮긴다', () => {
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

  // 일반적인 낱말 하나(숫자 · 차단 · 요청 · 입력 · 변경)만으로는 특수 관점의 근거로 보지 않는다.
  it.each([
    ['boundary', '2026년 보고서를 다운로드한다.'],
    ['boundary', '버전 3.2 안내 문구를 노출한다.'],
    ['boundary', '주문 번호 100234를 표시한다.'],
    ['permission', '광고 팝업을 차단한다.'],
    ['permission', '스팸 메일을 차단한다.'],
    ['permission', '관리자 페이지에 로고를 표시한다.'],
    ['permission', '운영자 화면 제목을 표시한다.'],
    ['permission', '운영자 화면의 제목을 바꾼다.'],
    ['permission', '관리자에게 공지 문구를 보여준다.'],
    ['permission', '설정 화면으로 접근한다.'],
    ['api', '가입 요청 시 안내 문구를 표시한다.'],
    ['api', '요청이 접수되면 완료 화면을 보여준다.'],
    ['api', '사용자 요청에 응답한다.'],
    ['api', '고객 요청에 응답 메시지를 보낸다.'],
    ['performance', '2026년 4월 목록을 보여준다.'],
    ['performance', '최대 3개의 항목을 표시한다.'],
    ['state_change', '비밀번호를 변경할 수 있다.'],
    ['state_change', '앱을 종료할 수 있다.'],
    ['data_io', '이메일을 입력하면 가입할 수 있다.'],
    ['data_io', '안내 문구를 보여준다.'],
  ] as [TestPerspective, string][])('오탐 방지: %s — "%s"는 만들지 않는다', (perspective, text) => {
    const ctx = context({ requirements: [requirement({ text })] }, { testScopes: ['functional', 'api', 'performance'] });
    const { candidates, skipped } = produceRuleBasedTestDrafts(ctx, { requirementIds: ['req-x'], perspectives: [perspective] });
    expect(candidates).toEqual([]);
    expect(skipped).toHaveLength(1);
  });

  it.each([
    ['boundary', '비밀번호는 8자 이상이어야 한다.'],
    ['boundary', '제목은 최대 50자까지 입력할 수 있다.'],
    ['boundary', '수량은 1~99 범위에서 고른다.'],
    ['permission', '관리자 권한이 있는 사용자만 접근 가능하다.'],
    ['permission', '관리자만 접근할 수 있다.'],
    ['permission', '관리자 권한이 있는 사용자만 수정할 수 있다.'],
    ['permission', '비로그인 사용자는 접근할 수 없다.'],
    ['permission', '운영자 역할에만 메뉴를 노출한다.'],
    ['permission', '권한이 없는 사용자는 사용할 수 없다.'],
    ['permission', '로그인하지 않은 사용자는 목록을 열람할 수 없다.'],
    ['api', 'API 요청 후 응답 값을 표시한다.'],
    ['api', '서버 응답이 실패하면 오류를 보여준다.'],
    ['api', '서버 요청이 성공하면 토큰을 응답한다.'],
    ['api', '서버 요청 후 응답 데이터를 처리한다.'],
    ['api', 'HTTP 요청 실패 시 상태 코드를 확인한다.'],
    ['performance', '응답 시간은 2초 이내여야 한다.'],
    ['performance', '동시 사용자 100명을 처리한다.'],
    ['performance', '목록은 3초 이내에 표시한다.'],
    ['state_change', '앱을 재실행해도 로그인 상태를 유지한다.'],
    ['state_change', '재설정 링크는 만료되면 사용할 수 없다.'],
    ['data_io', '입력한 내용을 서버에 저장한다.'],
    ['data_io', '프로필 정보를 조회할 수 있다.'],
    ['data_io', '파일을 업로드할 수 있다.'],
  ] as [TestPerspective, string][])('근거가 있으면 만든다: %s — "%s"', (perspective, text) => {
    const ctx = context({ requirements: [requirement({ text })] }, { testScopes: ['functional', 'api', 'performance'] });
    const { candidates } = produceRuleBasedTestDrafts(ctx, { requirementIds: ['req-x'], perspectives: [perspective] });
    expect(candidates.map((candidate) => candidate.perspective)).toEqual([perspective]);
  });

  it('API · 성능은 프로젝트 범위에 있고 요구사항에 단서가 있을 때만 만들며 임의 값을 만들지 않는다', () => {
    const ctx = withRequirements(
      requirement({ id: 'api', text: '서버 요청이 성공하면 토큰을 응답한다.' }),
      requirement({ id: 'perf', text: '목록은 3초 이내에 표시한다.' }),
      requirement({ id: 'none', text: '약관에 동의한다.' }),
    );
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

  it('확인 필요 요구사항(req-004)의 TC는 needs_confirmation · 초안이고 조건은 재검토 필요 상태다', () => {
    const c = context();
    const result = plan(c, only(c, ['normal_flow'], 'req-004'));
    expect(result.testCases[0]).toMatchObject({ generationType: 'needs_confirmation', status: 'draft', requirementIds: ['req-004'], sourceRefs: [{ deliverableId: 'dlv-figma-auth', locator: '회원가입 Frame' }] });
    expect(result.testCases[0].expectedResult).toMatch(/^확인 필요 — /);
    expect(result.testConditions[0].status).toBe('needs_review');
    expect(result.summary).toMatchObject({ created: 1, needsConfirmation: 1 });
  });
});

/** 후보와 같은 내용의 기존 TC */
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
  revision: 3,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});
const baseCandidate = () => produceRuleBasedTestDrafts(withRequirements(requirement()), { requirementIds: ['req-x'], perspectives: ['normal_flow'] }).candidates[0];

describe('판정: 중복 · 조건 재사용 · 오류', () => {
  it('구분 · 기능 · 제목 · 절차 · 기대 결과가 정확히 같은 기존 TC는 중복이고 비교 대상 · 연결 여부를 보여준다(공백 · 유니코드 차이 무시)', () => {
    const candidate = baseCandidate();
    const ctx = withRequirements(requirement());
    ctx.testCases = [existingTestCase(candidate, { title: `  ${candidate.testCase.title.normalize('NFD')}  `, steps: candidate.testCase.steps.map((step) => ` ${step}  `) })];
    const analysis = only(ctx, ['normal_flow'], 'req-x');
    expect(analysis.rows[0]).toMatchObject({
      kind: 'duplicate',
      duplicateTarget: { type: 'existing', id: 'tc-existing', label: 'SIGN-099', linked: false, snapshot: expect.stringMatching(/^[0-9a-f]+$/) },
      reasons: ['같은 내용의 TC가 이미 있어요. 이 요구사항은 그 TC에 연결돼 있지 않아요.'],
    });
    // 고객사 ID가 없으면 내부 ID를 쓰고, 이미 연결돼 있으면 linked다.
    ctx.testCases = [existingTestCase(candidate, { externalId: undefined, requirementIds: ['req-x'] })];
    expect(only(ctx, ['normal_flow'], 'req-x').rows[0].duplicateTarget).toMatchObject({ type: 'existing', id: 'tc-existing', label: 'tc-existing', linked: true });
  });

  it('비슷하기만 한 TC · 다른 구분 · 다른 프로젝트 · 폐기된 TC는 중복이 아니다(fuzzy 없음)', () => {
    const candidate = baseCandidate();
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
    const candidate = baseCandidate();
    const ctx = withRequirements(requirement());
    ctx.testCases = [existingTestCase(candidate, { title: '다른 제목', externalId: 'SIGN-001' })];
    const analysis = only(ctx, ['normal_flow'], 'req-x');
    expect(analysis.rows[0].kind).toBe('create');
    expect(plan(ctx, analysis).testCases[0]).not.toHaveProperty('externalId');
  });

  it('같은 요구사항 · 기능 · 제목의 테스트 조건이 있으면 새로 만들지 않고 재사용하며, 조건은 수정하지 않는다', () => {
    const candidate = baseCandidate();
    const existing: TestCondition = { id: 'cond-existing', projectId: PROJECT_A, requirementIds: ['req-x'], feature: candidate.condition.feature, title: candidate.condition.title, status: 'active', createdAt: NOW, updatedAt: NOW };
    const ctx = withRequirements(requirement());
    ctx.testConditions = [existing];
    const before = structuredClone(ctx.testConditions);
    const analysis = only(ctx, ['normal_flow'], 'req-x');
    expect(analysis.rows[0].reusedConditionId).toBe('cond-existing');
    const result = plan(ctx, analysis);
    expect(result.testConditions).toEqual([]);
    expect(result.testCases[0].testConditionIds).toEqual(['cond-existing']);
    expect([result.conditionsCreated, result.conditionsReused]).toEqual([0, 1]);
    expect(ctx.testConditions).toEqual(before);
    // 제목이 조금 달라도 · 요구사항이 다르거나 폐기된 조건도 재사용하지 않는다.
    for (const overrides of [{ title: `${existing.title}.` }, { requirementIds: ['req-y'] }, { status: 'deprecated' as const }, { projectId: PROJECT_B }]) {
      ctx.testConditions = [{ ...existing, ...overrides }];
      expect(only(ctx, ['normal_flow'], 'req-x').rows[0].reusedConditionId).toBeUndefined();
    }
  });

  it('요구사항 ID 집합은 중복을 없애고 정렬해 비교한다: 순서가 달라도 같은 조건이고, 입력 후보는 바뀌지 않는다', () => {
    expect(testDraftCandidateKey('normal_flow', ['b', 'a', 'a'])).toBe('normal_flow|a,b');
    const ctx2 = withRequirements(requirement({ id: 'r1' }), requirement({ id: 'r2', sourceRefs: [{ deliverableId: 'dlv-plan-pdf', locator: 'p.11' }] }));
    const base = produceRuleBasedTestDrafts(ctx2, { requirementIds: ['r1'], perspectives: ['normal_flow'] }).candidates[0];
    const messy: TestDraftCandidate = { ...base, key: 'normal_flow|r1,r2', requirementIds: ['r2', 'r1', 'r1'] };
    const before = structuredClone(messy);
    ctx2.testConditions = [{ id: 'cond-set', projectId: PROJECT_A, requirementIds: ['r1', 'r2', 'r2'], feature: base.condition.feature, title: base.condition.title, status: 'active', createdAt: NOW, updatedAt: NOW }];
    const analysis = analyzeTestDraftCandidates(ctx2, [messy], [], { requirementCount: 2, perspectiveCount: 1 });
    expect(analysis.rows[0].candidate.requirementIds).toEqual(['r1', 'r2']);
    expect(analysis.rows[0].reusedConditionId).toBe('cond-set');
    expect(messy).toEqual(before);
    const result = plan(ctx2, analysis);
    expect(result.testCases[0].requirementIds).toEqual(['r1', 'r2']);
    // 같은 집합이면 순서가 달라도 지문이 같다.
    const other = analyzeTestDraftCandidates(ctx2, [{ ...messy, requirementIds: ['r1', 'r2'] }], [], { requirementCount: 2, perspectiveCount: 1 });
    expect(other.rows[0].fingerprint).toBe(analysis.rows[0].fingerprint);
  });

  it('제거된 요구사항 · 다른 프로젝트 산출물을 가리키는 후보는 오류다(AI가 만든 후보도 같은 규칙)', () => {
    const ctx = withRequirements(requirement({ id: 'ok' }), requirement({ id: 'gone', lifecycle: 'removed' }), requirement({ id: 'bad-ref', sourceRefs: [{ deliverableId: 'dlv-b-spec', locator: 'p.1' }] }));
    const candidate = (id: string): TestDraftCandidate => ({ ...baseCandidate(), key: testDraftCandidateKey('normal_flow', [id]), requirementIds: [id] });
    const analysis = analyzeTestDraftCandidates(ctx, [candidate('ok'), candidate('gone'), candidate('bad-ref'), candidate('missing')], [], { requirementCount: 4, perspectiveCount: 1 });
    expect(analysis.rows.map((row) => row.kind)).toEqual(['create', 'invalid', 'invalid', 'invalid']);
    expect(analysis.rows[1].reasons).toEqual(['제거된 요구사항이에요. (gone)']);
    expect(analysis.rows[2].reasons).toEqual(['근거 산출물을 찾을 수 없어요. (dlv-b-spec)']);
    expect(analysis.rows[3].reasons).toEqual(['이 프로젝트에서 요구사항을 찾을 수 없어요. (missing)']);
    expect(() => analyzeTestDraftCandidates(ctx, [candidate('ok'), candidate('ok')], [], { requirementCount: 1, perspectiveCount: 1 })).toThrow('같은 후보가 두 번 있어요.');
  });

  it('이번에 만드는 후보끼리 같은 내용이면 뒤의 후보가 중복이고 앞선 후보를 비교 대상으로 가리킨다', () => {
    const ctx = withRequirements(requirement());
    const first = baseCandidate();
    const second = { ...first, key: 'normal_flow|req-x#2' };
    const analysis = analyzeTestDraftCandidates(ctx, [first, second], [], { requirementCount: 1, perspectiveCount: 1 });
    expect(analysis.rows.map((row) => [row.kind, row.duplicateTarget])).toEqual([['create', undefined], ['duplicate', { type: 'batch', key: 'normal_flow|req-x' }]]);
  });
});

describe('중복 판단', () => {
  /** 같은 내용의 기존 TC가 있고 이 요구사항은 아직 연결돼 있지 않다. */
  function unlinkedDuplicate(existingOverrides: Partial<TestCase> = {}) {
    const candidate = baseCandidate();
    const ctx = withRequirements(requirement());
    ctx.testCases = [existingTestCase(candidate, { requirementIds: ['req-old'], testConditionIds: ['cond-old'], sourceRefs: [{ deliverableId: 'dlv-plan-pdf', locator: 'p.1' }], ...existingOverrides })];
    return { ctx, analysis: only(ctx, ['normal_flow'], 'req-x'), key: candidate.key };
  }

  it('중복은 판단하기 전에는 저장할 수 없고(기본 pending), 이미 연결된 중복은 기본이 제외다', () => {
    const { ctx, analysis, key } = unlinkedDuplicate();
    expect(defaultTestDraftDecision(analysis.rows[0])).toBe('pending');
    expect(() => plan(ctx, analysis)).toThrow('판단하지 않은 중복이 1건 있어요.');
    expect(summarizeTestDraftAnalysis(analysis)).toMatchObject({ duplicate: 1, pending: 1, created: 0, linked: 0 });
    // 이미 연결된 중복은 할 일이 없다.
    const linkedCtx = withRequirements(requirement());
    linkedCtx.testCases = [existingTestCase(baseCandidate(), { requirementIds: ['req-x'] })];
    const linked = only(linkedCtx, ['normal_flow'], 'req-x');
    expect(defaultTestDraftDecision(linked.rows[0])).toBe('excluded');
    expect(resolveTestDraftDecisions(linked)[key]).toBe('excluded');
    // 아무것도 만들거나 연결할 것이 없으면 거부한다.
    expect(() => plan(linkedCtx, linked)).toThrow('새로 반영할 TC 초안 또는 연결이 없어요.');
  });

  it('기존 TC와 연결: 요구사항 · 조건 · 근거 연결만 합집합으로 더하고 내용 · 상태 · 출처 · 고객사 ID는 그대로이며 revision +1 · updatedAt 갱신이다', () => {
    const { ctx, analysis, key } = unlinkedDuplicate({ status: 'reviewed' });
    const original = structuredClone(ctx.testCases[0]);
    const result = plan(ctx, analysis, { [key]: 'link_existing' });
    expect(result.testCases).toEqual([]);
    expect(result.updatedTestCases).toHaveLength(1);
    const [updated] = result.updatedTestCases;
    expect(updated).toEqual({
      ...original,
      requirementIds: ['req-old', 'req-x'],
      testConditionIds: ['cond-old', result.testConditions[0].id],
      sourceRefs: [
        { deliverableId: 'dlv-plan-pdf', locator: 'p.1' },
        { deliverableId: 'dlv-plan-pdf', locator: 'p.10' },
      ],
      revision: 4,
      updatedAt: NOW,
    });
    // 내용 · 상태 · 출처 · 고객사 ID는 바뀌지 않는다(검토 완료 TC도 상태를 바꾸지 않는다).
    for (const field of ['category', 'feature', 'depth', 'title', 'precondition', 'steps', 'expectedResult', 'generationType', 'origin', 'externalId', 'status', 'createdAt'] as const) {
      expect(updated[field]).toEqual(original[field]);
    }
    expect(result.testConditions).toHaveLength(1);
    expect(result.testConditions[0].requirementIds).toEqual(['req-x']);
    expect(result.summary).toMatchObject({ created: 0, linked: 1, pending: 0 });
    // 입력(기존 TC)은 바뀌지 않는다.
    expect(ctx.testCases[0]).toEqual(original);
  });

  it('연결할 때 이미 연결된 값은 다시 더하지 않고, 같은 조건이 이미 있으면 재사용한다', () => {
    const candidate = baseCandidate();
    const ctx = withRequirements(requirement());
    const condition: TestCondition = { id: 'cond-same', projectId: PROJECT_A, requirementIds: ['req-x'], feature: candidate.condition.feature, title: candidate.condition.title, status: 'active', createdAt: NOW, updatedAt: NOW };
    ctx.testConditions = [condition];
    ctx.testCases = [existingTestCase(candidate, { requirementIds: ['req-old'], testConditionIds: ['cond-same'], sourceRefs: [{ deliverableId: 'dlv-plan-pdf', locator: 'p.10' }] })];
    const analysis = only(ctx, ['normal_flow'], 'req-x');
    const result = plan(ctx, analysis, { [candidate.key]: 'link_existing' });
    expect(result.updatedTestCases[0].testConditionIds).toEqual(['cond-same']);
    expect(result.updatedTestCases[0].sourceRefs).toEqual([{ deliverableId: 'dlv-plan-pdf', locator: 'p.10' }]);
    expect(result.updatedTestCases[0].requirementIds).toEqual(['req-old', 'req-x']);
    expect([result.conditionsCreated, result.conditionsReused]).toEqual([0, 1]);
  });

  it('별도 신규: 같은 내용이어도 새 TC와 조건을 만들고 기존 TC는 바꾸지 않는다', () => {
    const { ctx, analysis, key } = unlinkedDuplicate();
    const original = structuredClone(ctx.testCases);
    const result = plan(ctx, analysis, { [key]: 'create_separate' });
    expect(result.updatedTestCases).toEqual([]);
    expect(result.testCases).toHaveLength(1);
    expect(result.testCases[0]).toMatchObject({ requirementIds: ['req-x'], status: 'draft', revision: 1, title: ctx.testCases[0].title });
    expect(result.testCases[0].id).not.toBe('tc-existing');
    expect(result.summary).toMatchObject({ created: 1, separate: 1, linked: 0 });
    expect(ctx.testCases).toEqual(original);
  });

  it('제외: 아무것도 만들거나 바꾸지 않는다(다른 후보가 있으면 그것만 처리)', () => {
    const { ctx, analysis, key } = unlinkedDuplicate();
    expect(() => plan(ctx, analysis, { [key]: 'excluded' })).toThrow('새로 반영할 TC 초안 또는 연결이 없어요.');
    const both = context();
    both.testCases = [existingTestCase(baseCandidate(), { requirementIds: [] })];
    both.requirements = [requirement(), requirement({ id: 'req-y', text: '다른 문장이다.' })];
    const analysis2 = only(both, ['normal_flow'], 'req-x', 'req-y');
    const result = plan(both, analysis2, { 'normal_flow|req-x': 'excluded' });
    expect(result.testCases.map((item) => item.requirementIds)).toEqual([['req-y']]);
    expect(result.updatedTestCases).toEqual([]);
    expect(result.summary).toMatchObject({ created: 1, duplicate: 1, duplicateSkipped: 1 });
  });

  it('같은 배치의 중복: 뒤 요구사항의 연결이 조용히 사라지지 않고 판단이 필요하며, 연결하면 앞선 후보의 새 TC에 더해진다', () => {
    const ctx = withRequirements(requirement({ id: 'r1' }), requirement({ id: 'r2', sourceRefs: [{ deliverableId: 'dlv-plan-pdf', locator: 'p.11' }] }));
    const analysis = only(ctx, ['normal_flow'], 'r1', 'r2');
    expect(analysis.rows.map((row) => row.kind)).toEqual(['create', 'duplicate']);
    expect(() => plan(ctx, analysis)).toThrow('판단하지 않은 중복이 1건 있어요.');

    const linked = plan(ctx, analysis, { 'normal_flow|r2': 'link_existing' });
    expect(linked.testCases).toHaveLength(1);
    expect(linked.testCases[0].requirementIds).toEqual(['r1', 'r2']);
    expect(linked.testCases[0].sourceRefs).toEqual([
      { deliverableId: 'dlv-plan-pdf', locator: 'p.10' },
      { deliverableId: 'dlv-plan-pdf', locator: 'p.11' },
    ]);
    // 두 요구사항은 조건이 서로 다르므로 새 TC에 조건 둘이 이어진다.
    expect(linked.testCases[0].testConditionIds).toHaveLength(2);
    expect(linked.testConditions.map((item) => item.requirementIds)).toEqual([['r1'], ['r2']]);
    expect(linked.testCases[0].revision).toBe(1);
    // 앞선 후보로 만드는 새 TC에 연결한 것이라 "기존 TC 연결"이 아니라 "생성 TC 연결"로 센다.
    expect(linked.summary).toMatchObject({ created: 1, linked: 0, linkedToNew: 1 });

    const separate = plan(ctx, analysis, { 'normal_flow|r2': 'create_separate' });
    expect(separate.testCases.map((item) => item.requirementIds)).toEqual([['r1'], ['r2']]);
    const skipped = plan(ctx, analysis, { 'normal_flow|r2': 'excluded' });
    expect(skipped.testCases.map((item) => item.requirementIds)).toEqual([['r1']]);
  });

  it('앞선 후보를 제외하면 그 후보에 연결할 수 없다(판단은 pending으로 돌아가고, 직접 보내면 거부한다)', () => {
    const ctx = withRequirements(requirement({ id: 'r1' }), requirement({ id: 'r2' }));
    const analysis = only(ctx, ['normal_flow'], 'r1', 'r2');
    const chosen = { 'normal_flow|r1': 'excluded' as const, 'normal_flow|r2': 'link_existing' as const };
    expect(resolveTestDraftDecisions(analysis, chosen)['normal_flow|r2']).toBe('pending');
    expect(() => plan(ctx, analysis, chosen)).toThrow('판단하지 않은 중복이 1건 있어요.');
    const direct: TestDraftDecisionInput[] = analysis.rows.map((row) => ({ key: row.candidate.key, fingerprint: row.fingerprint, decision: chosen[row.candidate.key as keyof typeof chosen] }));
    expect(() => planTestDraftGeneration(ctx, analysis, direct, { createId, now: NOW })).toThrow('연결할 TC가 만들어지지 않아요.');
  });

  it('쓸 수 없는 판단은 거부한다: 신규에 link_existing · 중복에 create · 이미 연결된 중복에 link_existing · pending 신규', () => {
    const { ctx, analysis, key } = unlinkedDuplicate();
    const raw = (decision: TestDraftDecision, row = analysis.rows[0]): TestDraftDecisionInput[] => [{ key: row.candidate.key, fingerprint: row.fingerprint, decision }];
    expect(() => planTestDraftGeneration(ctx, analysis, raw('create'), { createId, now: NOW })).toThrow(`이 후보에는 쓸 수 없는 판단이에요. (${key}: create)`);
    const fresh = only(withRequirements(requirement()), ['normal_flow'], 'req-x');
    expect(() => planTestDraftGeneration(withRequirements(requirement()), fresh, raw('link_existing', fresh.rows[0]), { createId, now: NOW })).toThrow('쓸 수 없는 판단이에요.');
    expect(() => planTestDraftGeneration(withRequirements(requirement()), fresh, raw('pending', fresh.rows[0]), { createId, now: NOW })).toThrow('쓸 수 없는 판단이에요.');
    const linkedCtx = withRequirements(requirement());
    linkedCtx.testCases = [existingTestCase(baseCandidate(), { requirementIds: ['req-x'] })];
    const linked = only(linkedCtx, ['normal_flow'], 'req-x');
    expect(() => planTestDraftGeneration(linkedCtx, linked, raw('link_existing', linked.rows[0]), { createId, now: NOW })).toThrow('쓸 수 없는 판단이에요.');
    // 이미 연결된 중복도 별도 신규로 만들 수는 있다.
    expect(planTestDraftGeneration(linkedCtx, linked, raw('create_separate', linked.rows[0]), { createId, now: NOW }).testCases).toHaveLength(1);
  });

  it('비교 대상이 폐기됐거나 다른 프로젝트의 TC면 중복이 아니라 신규다(연결할 수 없다)', () => {
    for (const overrides of [{ status: 'deprecated' as const }, { projectId: PROJECT_B }]) {
      const { analysis } = unlinkedDuplicate(overrides);
      expect(analysis.rows[0].kind).toBe('create');
      expect(analysis.rows[0].duplicateTarget).toBeUndefined();
    }
  });

  it('미리보기 뒤 비교 대상이 폐기되면 연결을 거부한다(오래된 미리보기)', () => {
    const { ctx, analysis, key } = unlinkedDuplicate();
    const inputs = toTestDraftDecisionInputs(analysis, { [key]: 'link_existing' });
    const later = { ...ctx, testCases: [{ ...ctx.testCases[0], status: 'deprecated' as const }] };
    expect(() => planTestDraftGeneration(later, only(later, ['normal_flow'], 'req-x'), inputs, { createId, now: NOW })).toThrow(StaleTestDraftPreviewError);
  });
});

describe('미리보기 지문(fingerprint)', () => {
  const ctxWith = (overrides: Partial<Requirement> = {}, extra: Partial<TestDraftContext> = {}) => ({ ...withRequirements(requirement(overrides)), ...extra });
  const inputsFor = (ctx: TestDraftContext, decisions: Record<string, TestDraftDecision> = {}) => {
    const analysis = only(ctx, ['normal_flow'], 'req-x');
    return { analysis, inputs: toTestDraftDecisionInputs(analysis, decisions) };
  };
  const applyOld = (old: TestDraftDecisionInput[], current: TestDraftContext) => planTestDraftGeneration(current, only(current, ['normal_flow'], 'req-x'), old, { createId, now: NOW });

  it('같은 내용이면 지문이 같고(난수 · 시각 없음) 저장 계획이 만들어진다', () => {
    const ctx = ctxWith();
    const { analysis, inputs } = inputsFor(ctx);
    expect(only(ctxWith(), ['normal_flow'], 'req-x').rows[0].fingerprint).toBe(analysis.rows[0].fingerprint);
    expect(analysis.rows[0].fingerprint).toMatch(/^[0-9a-f]+$/);
    expect(applyOld(inputs, ctxWith()).testCases).toHaveLength(1);
  });

  it.each([
    ['요구사항 문장이 바뀜', () => ctxWith({ text: '다른 문장으로 바뀌었다.' })],
    ['근거 위치가 바뀜', () => ctxWith({ sourceRefs: [{ deliverableId: 'dlv-plan-pdf', locator: 'p.99' }] })],
    ['근거 산출물이 바뀜', () => ctxWith({ sourceRefs: [{ deliverableId: 'dlv-figma-auth', locator: 'p.10' }] })],
    ['확인 필요로 바뀜(근거 유형)', () => ctxWith({ needsConfirmation: true })],
    ['근거 유형이 AI 제안으로 바뀜', () => ctxWith({ sourceType: 'ai_suggestion' })],
    ['기능 이름이 바뀜', () => ctxWith({ feature: '다른 기능' })],
    ['제거됨', () => ctxWith({ lifecycle: 'removed' })],
    ['같은 조건이 새로 생겨 재사용으로 바뀜', () => ctxWith({}, { testConditions: [{ id: 'cond-new', projectId: PROJECT_A, requirementIds: ['req-x'], feature: baseCandidate().condition.feature, title: baseCandidate().condition.title, status: 'active', createdAt: NOW, updatedAt: NOW }] })],
  ])('%s → 저장을 거부한다(아무것도 만들지 않는다)', (label, current) => {
    const { inputs } = inputsFor(ctxWith());
    // 제거됨은 요청 자체가 거부되고(요구사항을 더는 고를 수 없다), 나머지는 오래된 미리보기로 거부한다.
    expect(() => applyOld(inputs, current())).toThrow(TestDraftGenerationError);
    const removed = label === '제거됨';
    expect(() => applyOld(inputs, current())).toThrow(removed ? '제거된 요구사항으로는 초안을 만들 수 없어요.' : STALE);
  });

  it('판정이 신규에서 중복으로 바뀌거나 비교 대상이 달라지면 거부한다', () => {
    const { analysis, inputs } = inputsFor(ctxWith());
    const candidate = analysis.rows[0].candidate;
    // 신규 → 중복
    const duplicate = ctxWith({}, { testCases: [existingTestCase(candidate)] });
    expect(() => applyOld(inputs, duplicate)).toThrow(STALE);
    // 중복(연결 안 됨) → 같은 TC가 이미 연결됨
    const unlinked = ctxWith({}, { testCases: [existingTestCase(candidate)] });
    const unlinkedInputs = inputsFor(unlinked, { [candidate.key]: 'link_existing' }).inputs;
    const nowLinked = ctxWith({}, { testCases: [existingTestCase(candidate, { requirementIds: ['req-x'] })] });
    expect(() => applyOld(unlinkedInputs, nowLinked)).toThrow(STALE);
    // 비교 대상 TC가 다른 TC로 바뀜
    const otherTarget = ctxWith({}, { testCases: [existingTestCase(candidate, { id: 'tc-other', externalId: 'SIGN-777' })] });
    expect(() => applyOld(unlinkedInputs, otherTarget)).toThrow(STALE);
    // 비교 대상의 다른 연결이 바뀜
    const changedLinks = ctxWith({}, { testCases: [existingTestCase(candidate, { requirementIds: ['req-z'] })] });
    expect(() => applyOld(unlinkedInputs, changedLinks)).toThrow(STALE);
  });

  it('후보가 빠지거나 더해지거나 두 번 들어오거나 모르는 후보가 있으면 거부한다', () => {
    const ctx = withRequirements(requirement({ id: 'r1' }), requirement({ id: 'r2', text: '다른 문장이다.' }));
    const analysis = only(ctx, ['normal_flow'], 'r1', 'r2');
    const inputs = toTestDraftDecisionInputs(analysis);
    const run = (list: TestDraftDecisionInput[]) => planTestDraftGeneration(ctx, analysis, list, { createId, now: NOW });
    expect(() => run(inputs.slice(0, 1))).toThrow(StaleTestDraftPreviewError);
    expect(() => run([...inputs, inputs[0]])).toThrow(STALE);
    expect(() => run([...inputs, { key: 'normal_flow|r9', fingerprint: 'x', decision: 'create' }])).toThrow(STALE);
    expect(() => run([{ ...inputs[0], fingerprint: 'deadbeef' }, inputs[1]])).toThrow(STALE);
    expect(run(inputs).testCases).toHaveLength(2);
  });
});

describe('TC 양식(template) 확인', () => {
  const withTemplate = (tcTemplateId: string | undefined, templates: TestDraftContext['templates']) => context({ templates }, { tcTemplateId });

  it('양식이 없는 프로젝트는 양식 없이 만들 수 있다', () => {
    const ctx = withTemplate(undefined, []);
    expect(() => validateDraftTemplate(ctx)).not.toThrow();
    expect(plan(ctx, only(ctx, ['normal_flow'], 'req-001')).testCases[0]).not.toHaveProperty('templateId');
  });

  it('프로젝트의 양식이거나 프로젝트가 정해지지 않은 공용 양식이면 붙인다', () => {
    for (const projectId of [PROJECT_A, undefined]) {
      const ctx = withTemplate('tpl-x', [{ id: 'tpl-x', projectId }]);
      expect(plan(ctx, only(ctx, ['normal_flow'], 'req-001')).testCases[0].templateId).toBe('tpl-x');
    }
  });

  it('없는 양식 ID는 맹목적으로 복사하지 않고 거부한다', () => {
    const ctx = withTemplate('tpl-missing', [{ id: 'tpl-other', projectId: PROJECT_A }]);
    expect(() => only(ctx, ['normal_flow'], 'req-001')).toThrow('프로젝트의 TC 양식을 찾을 수 없어요. (tpl-missing)');
    expect(() => validateDraftTemplate(withTemplate('tpl-missing', []))).toThrow(TestDraftGenerationError);
  });

  it('다른 프로젝트 전용 양식은 거부한다', () => {
    const ctx = withTemplate('tpl-b', [{ id: 'tpl-b', projectId: PROJECT_B }]);
    expect(() => only(ctx, ['normal_flow'], 'req-001')).toThrow('다른 프로젝트의 TC 양식은 쓸 수 없어요. (tpl-b)');
  });
});

describe('저장 계획', () => {
  const ctx = () => context();
  const analysisFor = (...ids: string[]) => only(ctx(), ['normal_flow', 'boundary'], ...ids);

  it('새 TC는 초안 · revision 1 · 요구사항 / 조건 / 근거 연결이고 고객사 ID가 없으며 같은 시각을 쓴다', () => {
    const result = plan(ctx(), analysisFor('req-002'));
    expect(result.testCases).toHaveLength(2);
    expect(result.testConditions).toHaveLength(2);
    const [normal, boundary] = result.testCases;
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
      testConditionIds: [result.testConditions[0].id],
      sourceRefs: [{ deliverableId: 'dlv-plan-pdf', locator: 'p.14' }],
      generationType: 'source_explicit',
      origin: 'manual',
      status: 'draft',
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(boundary.testConditionIds).toEqual([result.testConditions[1].id]);
    expect(result.testConditions[0]).toEqual({
      id: expect.stringMatching(/^cond-/),
      projectId: PROJECT_A,
      requirementIds: ['req-002'],
      feature: '회원가입',
      title: '정상 흐름 · 비밀번호는 영문과 숫자를 포함해 8자 이상이어야 한다',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(result.updatedTestCases).toEqual([]);
    for (const testCase of result.testCases) expect(testCase).not.toHaveProperty('externalId');
  });

  it('프로젝트에 템플릿이 없어도 만들 수 있고 templateId만 비어 있다', () => {
    const noTemplate = context({ templates: [] }, { tcTemplateId: undefined });
    const result = plan(noTemplate, only(noTemplate, ['normal_flow'], 'req-001'));
    expect(result.testCases[0]).not.toHaveProperty('templateId');
    expect(result.testCases[0].generationType).toBe('source_explicit');
    expect(result.testConditions[0].status).toBe('active');
  });

  it('근거는 요구사항의 것을 그대로 쓰고, 여러 요구사항이 한 후보에 이어지면 중복 없이 순서대로 합친다', () => {
    const ctx2 = withRequirements(
      requirement({ id: 'r1', sourceRefs: [{ deliverableId: 'dlv-plan-pdf', locator: 'p.1' }, { deliverableId: 'dlv-plan-pdf', locator: 'p.2' }] }),
      requirement({ id: 'r2', sourceRefs: [{ deliverableId: 'dlv-plan-pdf', locator: 'p.2' }, { deliverableId: 'dlv-figma-auth', locator: 'F1' }] }),
    );
    const base = produceRuleBasedTestDrafts(ctx2, { requirementIds: ['r1'], perspectives: ['normal_flow'] }).candidates[0];
    const merged: TestDraftCandidate = { ...base, key: testDraftCandidateKey('normal_flow', ['r1', 'r2']), requirementIds: ['r1', 'r2'] };
    const analysis = analyzeTestDraftCandidates(ctx2, [merged], [], { requirementCount: 2, perspectiveCount: 1 });
    const expected: SourceRef[] = [
      { deliverableId: 'dlv-plan-pdf', locator: 'p.1' },
      { deliverableId: 'dlv-plan-pdf', locator: 'p.2' },
      { deliverableId: 'dlv-figma-auth', locator: 'F1' },
    ];
    expect(analysis.rows[0].sourceRefs).toEqual(expected);
    const result = plan(ctx2, analysis);
    expect(result.testCases[0].requirementIds).toEqual(['r1', 'r2']);
    expect(result.testConditions[0].requirementIds).toEqual(['r1', 'r2']);
    // 계획의 근거는 요구사항 객체와 따로 복사한 값이다.
    result.testCases[0].sourceRefs[0].locator = '바뀜';
    expect(ctx2.requirements[0].sourceRefs[0].locator).toBe('p.1');
  });

  it('같은 조건을 쓰는 후보가 둘이면 조건은 한 번만 만들고 나머지는 재사용으로 센다', () => {
    const ctx2 = withRequirements(requirement());
    const first = produceRuleBasedTestDrafts(ctx2, { requirementIds: ['req-x'], perspectives: ['normal_flow'] }).candidates[0];
    const second: TestDraftCandidate = { ...first, key: 'normal_flow|req-x#2', testCase: { ...first.testCase, title: '다른 제목' } };
    const result = plan(ctx2, analyzeTestDraftCandidates(ctx2, [first, second], [], { requirementCount: 1, perspectiveCount: 1 }));
    expect(result.testCases).toHaveLength(2);
    expect(result.testConditions).toHaveLength(1);
    expect(result.testCases.map((item) => item.testConditionIds[0])).toEqual([result.testConditions[0].id, result.testConditions[0].id]);
    expect([result.conditionsCreated, result.conditionsReused]).toEqual([1, 1]);
  });

  it('사용자가 제외한 후보는 만들지 않고, 요약은 신규 · 연결 · 확인 필요 · 중복 · 판단 · 오류 · 제외 · 건너뜀을 센다', () => {
    const analysis = analysisFor('req-001', 'req-002');
    // req-001: 정상 흐름(경계값 단서 없음) / req-002: 정상 흐름 + 경계값
    expect(analysis.rows.map((row) => row.candidate.key)).toEqual(['normal_flow|req-001', 'normal_flow|req-002', 'boundary|req-002']);
    expect(analysis.skipped).toHaveLength(1);
    expect(summarizeTestDraftAnalysis(analysis)).toEqual({
      requirementCount: 2,
      perspectiveCount: 2,
      created: 3,
      separate: 0,
      linked: 0,
      linkedToNew: 0,
      needsConfirmation: 0,
      duplicate: 0,
      duplicateSkipped: 0,
      pending: 0,
      invalid: 0,
      excluded: 0,
      skipped: 1,
    });
    const result = plan(ctx(), analysis, { 'boundary|req-002': 'excluded' });
    expect(result.testCases.map((item) => item.category)).toEqual(['normal_flow', 'normal_flow']);
    expect(result.summary).toMatchObject({ created: 2, needsConfirmation: 0, excluded: 1 });
    // 제외한 후보의 조건도 만들지 않는다.
    expect(result.testConditions).toHaveLength(2);
  });

  it('오류 후보는 제외로만 보낼 수 있고 판단이 비어 있어도 기본값으로 처리한다', () => {
    const ctx2 = withRequirements(requirement({ id: 'ok' }), requirement({ id: 'gone', lifecycle: 'removed' }));
    const base = baseCandidate();
    const analysis = analyzeTestDraftCandidates(ctx2, [{ ...base, key: 'normal_flow|ok', requirementIds: ['ok'] }, { ...base, key: 'normal_flow|gone', requirementIds: ['gone'] }], [], { requirementCount: 2, perspectiveCount: 1 });
    expect(resolveTestDraftDecisions(analysis)['normal_flow|gone']).toBe('excluded');
    expect(plan(ctx2, analysis).testCases).toHaveLength(1);
    const bad = toTestDraftDecisionInputs(analysis).map((input) => (input.key === 'normal_flow|gone' ? { ...input, decision: 'create' as const } : input));
    expect(() => planTestDraftGeneration(ctx2, analysis, bad, { createId, now: NOW })).toThrow('쓸 수 없는 판단이에요.');
  });

  it('만들 후보가 없으면(모두 제외 · 건너뜀) 던진다', () => {
    const empty = only(withRequirements(requirement()), ['boundary'], 'req-x');
    expect(empty.rows).toEqual([]);
    expect(() => plan(ctx(), empty)).toThrow('새로 반영할 TC 초안 또는 연결이 없어요.');
    const all = analysisFor('req-001');
    expect(() => plan(ctx(), all, { 'normal_flow|req-001': 'excluded' })).toThrow('새로 반영할 TC 초안 또는 연결이 없어요.');
  });

  it('입력(문맥 · 분석)을 바꾸지 않고 같은 입력이면 같은 계획이다', () => {
    const c = ctx();
    const before = structuredClone(c);
    const analysis = only(c, ['normal_flow', 'exception'], 'req-001', 'req-006');
    const analysisBefore = structuredClone(analysis);
    let n = 0;
    const ids = (prefix: string) => `${prefix}-${++n}`;
    const inputs = toTestDraftDecisionInputs(analysis);
    const first = planTestDraftGeneration(c, analysis, inputs, { createId: ids, now: NOW });
    n = 0;
    expect(planTestDraftGeneration(c, analysis, inputs, { createId: ids, now: NOW })).toEqual(first);
    expect(c).toEqual(before);
    expect(analysis).toEqual(analysisBefore);
  });
});

describe('확인 필요는 생산자가 아니라 연결 요구사항 기준이다(분석 경계)', () => {
  /** 외부 생산자(AI 등)가 보낸 후보. 근거 유형은 생산자가 정한 값이다. */
  const external = (requirementIds: string[], generationType: TestDraftCandidate['generationType']): TestDraftCandidate => ({
    ...baseCandidate(),
    key: testDraftCandidateKey('normal_flow', requirementIds),
    requirementIds,
    generationType,
  });
  const analyze = (ctx: TestDraftContext, ...candidates: TestDraftCandidate[]) => analyzeTestDraftCandidates(ctx, candidates, [], { requirementCount: 1, perspectiveCount: 1 });

  it.each([
    ['확인 필요 표시 + 생산자 source_explicit', requirement({ needsConfirmation: true }), 'source_explicit'],
    ['근거 유형 needs_confirmation + 생산자 source_explicit', requirement({ sourceType: 'needs_confirmation' }), 'source_explicit'],
    ['확인 필요 표시 + 생산자 ai_suggestion', requirement({ needsConfirmation: true }), 'ai_suggestion'],
  ] as const)('%s → 확인 필요로 올리고 기대 결과에 확인 필요를 붙인다', (_, req, producerType) => {
    const input = external(['req-x'], producerType);
    const inputBefore = structuredClone(input);
    const [row] = analyze(withRequirements(req), input).rows;
    expect(row).toMatchObject({ kind: 'create', needsConfirmation: true, candidate: { generationType: 'needs_confirmation' } });
    expect(row.candidate.testCase.expectedResult).toBe(`확인 필요 — ${input.testCase.expectedResult}`);
    expect(input).toEqual(inputBefore);
  });

  it('여러 요구사항 중 하나만 확인 필요여도 후보는 확인 필요다', () => {
    const ctx = withRequirements(requirement({ id: 'a' }), requirement({ id: 'b', needsConfirmation: true }), requirement({ id: 'c', sourceType: 'ai_suggestion' }));
    const [row] = analyze(ctx, external(['a', 'b', 'c'], 'source_explicit')).rows;
    expect(row).toMatchObject({ needsConfirmation: true, candidate: { generationType: 'needs_confirmation', requirementIds: ['a', 'b', 'c'] } });
  });

  it('생산자가 더 조심스럽게 보낸 값은 낮추지 않고, 요구사항이 AI 제안이면 source_explicit을 AI 제안으로 올린다', () => {
    const ctx = withRequirements(requirement({ id: 'plain' }), requirement({ id: 'suggested', sourceType: 'ai_suggestion' }));
    const rows = analyze(ctx, external(['plain'], 'needs_confirmation'), external(['suggested'], 'source_explicit')).rows;
    expect(rows.map((row) => [row.candidate.generationType, row.needsConfirmation])).toEqual([
      ['needs_confirmation', true],
      ['ai_suggestion', false],
    ]);
    // 확인 필요가 아닌 요구사항에서 생산자가 확인 필요로 보낸 후보는 기대 결과를 바꾸지 않는다(생산자 문구 그대로).
    expect(rows[0].candidate.testCase.expectedResult).toBe(baseCandidate().testCase.expectedResult);
  });

  it('이미 확인 필요를 말하는 기대 결과에는 다시 붙이지 않는다', () => {
    const input = external(['req-x'], 'source_explicit');
    input.testCase = { ...input.testCase, expectedResult: '확인 필요 — 정책 미정' };
    const [row] = analyze(withRequirements(requirement({ needsConfirmation: true })), input).rows;
    expect(row.candidate.testCase.expectedResult).toBe('확인 필요 — 정책 미정');
  });

  it('저장 계획도 확인 필요 · 초안이고 조건은 재검토 필요다(외부 후보가 source_explicit이라고 보내도)', () => {
    const ctx = withRequirements(requirement({ needsConfirmation: true }));
    const analysis = analyze(ctx, external(['req-x'], 'source_explicit'));
    const result = plan(ctx, analysis);
    expect(result.testCases[0]).toMatchObject({ generationType: 'needs_confirmation', status: 'draft' });
    expect(result.testCases[0].expectedResult).toMatch(/^확인 필요 — /);
    expect(result.testConditions[0].status).toBe('needs_review');
    expect(result.summary).toMatchObject({ created: 1, needsConfirmation: 1 });
  });

  it('요구사항이 확인 필요로 바뀌면 같은 외부 후보의 지문이 달라져 오래된 미리보기로 거부된다', () => {
    const before = analyze(withRequirements(requirement()), external(['req-x'], 'source_explicit'));
    expect(analyze(withRequirements(requirement()), external(['req-x'], 'source_explicit')).rows[0].fingerprint).toBe(before.rows[0].fingerprint);
    const flagged = withRequirements(requirement({ needsConfirmation: true }));
    const after = analyze(flagged, external(['req-x'], 'source_explicit'));
    expect(after.rows[0].fingerprint).not.toBe(before.rows[0].fingerprint);
    expect(() => planTestDraftGeneration(flagged, after, toTestDraftDecisionInputs(before), { createId, now: NOW })).toThrow(StaleTestDraftPreviewError);
  });
});
