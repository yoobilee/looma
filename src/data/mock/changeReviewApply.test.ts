import { describe, expect, it } from 'vitest';
import { pendingDecisionCount } from '@/domain/changeImpact';
import type { DuplicateResolution, ReviewDecision } from '@/domain/types';
import { createMockRepositories } from './mockRepositories';
import { createSeed, PROJECT_A, type SeedData } from './seed';

const ANALYSIS = 'cia-plan-v15';

interface Decisions {
  requirements?: Partial<Record<string, ReviewDecision>>;
  impacts?: Partial<Record<string, ReviewDecision>>;
  duplicate?: DuplicateResolution;
}

/** 모든 판단을 기본값(수락, 중복은 기존 TC 수정)으로 채우고 일부만 바꿔서 쓴다. */
async function decideAll(repos: ReturnType<typeof createMockRepositories>, decisions: Decisions = {}) {
  for (const id of ['rc-001', 'rc-002', 'rc-003']) await repos.changeAnalyses.updateRequirementDecision(ANALYSIS, id, decisions.requirements?.[id] ?? 'accepted');
  for (const id of ['ti-001', 'ti-002', 'ti-003', 'ti-004', 'ti-006']) await repos.changeAnalyses.updateTestImpactDecision(ANALYSIS, id, decisions.impacts?.[id] ?? 'accepted');
  await repos.changeAnalyses.resolveDuplicate(ANALYSIS, 'ti-007', decisions.duplicate ?? 'modify_existing');
}

async function setup(decisions?: Decisions, seed: SeedData = createSeed()) {
  const before = structuredClone(seed);
  const repos = createMockRepositories(seed);
  if (decisions) {
    await decideAll(repos, decisions);
    await repos.changeAnalyses.markReviewed(ANALYSIS);
  }
  const load = async () => ({
    analysis: (await repos.changeAnalyses.listByProject(PROJECT_A))[0],
    requirements: await repos.requirements.listByProject(PROJECT_A),
    testCases: await repos.testCases.listByProject(PROJECT_A),
  });
  return { repos, before, load };
}

describe('검토', () => {
  it('seed 분석은 판단할 항목 9건이 모두 pending이다', async () => {
    const { load } = await setup();
    expect(pendingDecisionCount((await load()).analysis)).toBe(9);
  });

  it('pending 항목이 있으면 reviewed로 바꿀 수 없다', async () => {
    const { repos, load } = await setup();
    await repos.changeAnalyses.updateRequirementDecision(ANALYSIS, 'rc-001', 'accepted');
    await expect(repos.changeAnalyses.markReviewed(ANALYSIS)).rejects.toThrow('판단하지 않은 항목이 8건');
    expect((await load()).analysis.status).toBe('draft');
  });

  it('중복 후보가 unresolved면 reviewed로 바꿀 수 없다', async () => {
    const { repos } = await setup();
    await decideAll(repos);
    await repos.changeAnalyses.resolveDuplicate(ANALYSIS, 'ti-007', 'pending');
    await expect(repos.changeAnalyses.markReviewed(ANALYSIS)).rejects.toThrow('판단하지 않은 항목이 1건');
  });

  it('모든 필수 판단 후 reviewed가 되며 요구사항·TC는 아직 바뀌지 않는다', async () => {
    const { before, load } = await setup({});
    const { analysis, requirements, testCases } = await load();
    expect(analysis.status).toBe('reviewed');
    expect(analysis.reviewedAt).toBeDefined();
    expect(requirements).toEqual(before.requirements);
    expect(testCases).toEqual(before.testCases);
  });

  it('reviewed 이후에는 판단을 바꿀 수 없다', async () => {
    const { repos } = await setup({});
    await expect(repos.changeAnalyses.updateRequirementDecision(ANALYSIS, 'rc-001', 'rejected')).rejects.toThrow('판단을 바꿀 수 없어요');
    await expect(repos.changeAnalyses.updateTestImpactDecision(ANALYSIS, 'ti-001', 'rejected')).rejects.toThrow('판단을 바꿀 수 없어요');
    await expect(repos.changeAnalyses.resolveDuplicate(ANALYSIS, 'ti-007', 'excluded')).rejects.toThrow('판단을 바꿀 수 없어요');
  });

  it('참고용 항목(unchanged·keep)과 종류가 맞지 않는 판단은 거부한다', async () => {
    const { repos } = await setup();
    await expect(repos.changeAnalyses.updateRequirementDecision(ANALYSIS, 'rc-004', 'accepted')).rejects.toThrow('판단하지 않아요');
    await expect(repos.changeAnalyses.updateTestImpactDecision(ANALYSIS, 'ti-005', 'accepted')).rejects.toThrow('판단하지 않아요');
    await expect(repos.changeAnalyses.updateTestImpactDecision(ANALYSIS, 'ti-007', 'accepted')).rejects.toThrow('판단하지 않아요');
    await expect(repos.changeAnalyses.resolveDuplicate(ANALYSIS, 'ti-001', 'excluded')).rejects.toThrow('중복 후보 항목만');
  });
});

describe('반영 단계', () => {
  it('draft에서는 반영할 수 없고 아무것도 바뀌지 않는다', async () => {
    const { repos, before, load } = await setup();
    await decideAll(repos);
    await expect(repos.changeAnalyses.apply(ANALYSIS)).rejects.toThrow('검토를 완료한 분석만');
    const { requirements, testCases } = await load();
    expect(requirements).toEqual(before.requirements);
    expect(testCases).toEqual(before.testCases);
  });

  it('reviewed에서 반영하면 applied가 되고 반영 결과와 활동을 남긴다', async () => {
    const { repos, load } = await setup({});
    const applied = await repos.changeAnalyses.apply(ANALYSIS);
    expect(applied.status).toBe('applied');
    expect(applied.appliedAt).toBeDefined();
    expect(applied.appliedSummary).toEqual({
      requirementsAdded: 1,
      requirementsModified: 1,
      requirementsRemoved: 1,
      testCasesCreated: 2,
      testCasesModified: 3,
      testCasesDeprecated: 1,
    });
    const activities = await repos.activities.list({ projectId: PROJECT_A });
    expect(activities[0]).toMatchObject({ type: 'changes_applied', title: '모바일_개편_기획_v1.5.pdf 변경사항 반영' });
    expect((await load()).analysis.status).toBe('applied');
  });

  it('applied 분석은 다시 반영할 수 없고 판단도 바꿀 수 없다', async () => {
    const { repos, load } = await setup({});
    await repos.changeAnalyses.apply(ANALYSIS);
    const afterFirst = await load();
    await expect(repos.changeAnalyses.apply(ANALYSIS)).rejects.toThrow('이미 반영한 분석');
    await expect(repos.changeAnalyses.updateRequirementDecision(ANALYSIS, 'rc-001', 'rejected')).rejects.toThrow('판단을 바꿀 수 없어요');
    const afterSecond = await load();
    expect(afterSecond.requirements).toEqual(afterFirst.requirements);
    expect(afterSecond.testCases).toEqual(afterFirst.testCases);
  });
});

describe('요구사항 반영', () => {
  it('added 수락 → 분석 근거로 새 요구사항을 만든다', async () => {
    const { repos, before, load } = await setup({});
    await repos.changeAnalyses.apply(ANALYSIS);
    const { requirements } = await load();
    expect(requirements).toHaveLength(before.requirements.length + 1);
    const created = requirements.find((item) => item.text === '카카오 계정으로 간편 가입할 수 있다.')!;
    expect(before.requirements.some((item) => item.id === created.id)).toBe(false);
    expect(created).toMatchObject({
      feature: '회원가입',
      sourceType: 'source_explicit',
      needsConfirmation: false,
      lifecycle: 'active',
      status: 'reviewed',
      sourceRefs: [{ deliverableId: 'dlv-plan-pdf-v15', locator: 'p.11' }],
    });
  });

  it('modified 수락 → 기존 ID를 유지하고 내용·근거를 바꾸며 lifecycle은 changed', async () => {
    const { repos, load } = await setup({});
    await repos.changeAnalyses.apply(ANALYSIS);
    const req = (await load()).requirements.find((item) => item.id === 'req-002')!;
    expect(req.text).toBe('비밀번호는 영문, 숫자, 특수문자를 포함해 10자 이상이어야 한다.');
    expect(req.sourceRefs).toEqual([{ deliverableId: 'dlv-plan-pdf-v15', locator: 'p.14' }]);
    expect(req.lifecycle).toBe('changed');
  });

  it('removed 수락 → 삭제하지 않고 lifecycle만 removed, 기존 근거는 그대로 둔다', async () => {
    const { repos, before, load } = await setup({});
    await repos.changeAnalyses.apply(ANALYSIS);
    const req = (await load()).requirements.find((item) => item.id === 'req-003')!;
    const original = before.requirements.find((item) => item.id === 'req-003')!;
    expect(req.lifecycle).toBe('removed');
    expect(req.text).toBe(original.text);
    expect(req.sourceRefs).toEqual(original.sourceRefs);
    // 제거 판단의 새 근거는 분석 안에 남는다.
    const change = (await load()).analysis.requirementChanges.find((item) => item.id === 'rc-003')!;
    expect(change.sourceRefs).toEqual([{ deliverableId: 'dlv-plan-pdf-v15', locator: 'p.15' }]);
  });

  it('rejected·unchanged → 요구사항에 아무 변화가 없다', async () => {
    const { repos, before, load } = await setup({ requirements: { 'rc-001': 'rejected', 'rc-002': 'rejected', 'rc-003': 'rejected' } });
    await repos.changeAnalyses.apply(ANALYSIS);
    expect((await load()).requirements).toEqual(before.requirements);
  });
});

describe('TC 반영', () => {
  it('create 수락 → 새 내부 ID, 고객사 ID 없음, revision 1, 초안, 새 요구사항 연결', async () => {
    const { repos, before, load } = await setup({});
    await repos.changeAnalyses.apply(ANALYSIS);
    const { testCases, requirements } = await load();
    const created = testCases.find((item) => item.title === '카카오 계정으로 간편 가입 시 가입 완료')!;
    const newRequirement = requirements.find((item) => item.text === '카카오 계정으로 간편 가입할 수 있다.')!;
    expect(before.testCases.some((item) => item.id === created.id)).toBe(false);
    expect(created.externalId).toBeUndefined();
    expect(created).toMatchObject({ revision: 1, status: 'draft', origin: 'ai_generated', projectId: PROJECT_A, templateId: 'tpl-client-a' });
    expect(created.requirementIds).toEqual([newRequirement.id]);
  });

  it('modify 수락 → 기존 ID·고객사 ID 유지, 제안 필드만 반영, revision +1, 재검토 필요', async () => {
    const { repos, before, load } = await setup({});
    await repos.changeAnalyses.apply(ANALYSIS);
    const tc = (await load()).testCases.find((item) => item.id === 'tc-003')!;
    const original = before.testCases.find((item) => item.id === 'tc-003')!;
    expect(tc.externalId).toBe('SIGN-003');
    expect(tc.title).toBe('9자 입력 시 오류 노출');
    expect(tc.expectedResult).toBe('"10자 이상 입력" 안내 노출');
    expect(tc.steps).toEqual(original.steps);
    expect(tc.revision).toBe(original.revision + 1);
    expect(tc.status).toBe('needs_review');
    expect(tc.origin).toBe('ai_modified');
  });

  it('modify 제안 내용이 이미 같으면 revision을 올리지 않는다', async () => {
    const seed = createSeed();
    const tc = seed.testCases.find((item) => item.id === 'tc-002')!;
    const impact = seed.changeAnalyses[0].testImpacts.find((item) => item.id === 'ti-003')!;
    impact.changes = { title: tc.title, sourceRefs: tc.sourceRefs };
    const { repos, before, load } = await setup({}, seed);
    const applied = await repos.changeAnalyses.apply(ANALYSIS);
    expect((await load()).testCases.find((item) => item.id === 'tc-002')).toEqual(before.testCases.find((item) => item.id === 'tc-002'));
    expect(applied.appliedSummary?.testCasesModified).toBe(2);
  });

  it('keep·rejected → TC에 아무 변화가 없다', async () => {
    const { repos, before, load } = await setup({ impacts: { 'ti-001': 'rejected', 'ti-002': 'rejected', 'ti-003': 'rejected', 'ti-004': 'rejected', 'ti-006': 'rejected' }, duplicate: 'excluded' });
    await repos.changeAnalyses.apply(ANALYSIS);
    expect((await load()).testCases).toEqual(before.testCases);
  });

  it('deprecate 수락 → 삭제하지 않고 폐기, revision 유지, 수행 결과 연결 유지', async () => {
    const { repos, before, load } = await setup({});
    await repos.changeAnalyses.apply(ANALYSIS);
    const tc = (await load()).testCases.find((item) => item.id === 'tc-005')!;
    expect(tc.status).toBe('deprecated');
    expect(tc.revision).toBe(before.testCases.find((item) => item.id === 'tc-005')!.revision);
    for (const resultImport of await repos.testResults.listImports(PROJECT_A)) {
      const linked = (await repos.testResults.listResults(resultImport.id)).filter((item) => item.testCaseId === 'tc-005');
      expect(linked.map((item) => item.externalId)).toEqual(['SIGN-005', 'SIGN-005']);
    }
  });

  it('중복 후보 · 기존 TC 수정 → 기존 ID·고객사 ID 유지, revision +1, 재검토 필요', async () => {
    const { repos, before, load } = await setup({ duplicate: 'modify_existing' });
    await repos.changeAnalyses.apply(ANALYSIS);
    const { testCases } = await load();
    const tc = testCases.find((item) => item.id === 'tc-001')!;
    expect(tc).toMatchObject({ externalId: 'SIGN-001', title: '바뀐 규칙에 맞는 비밀번호로 가입 완료', revision: 2, status: 'needs_review' });
    expect(testCases).toHaveLength(before.testCases.length + 2);
  });

  it('중복 후보 · 별도 신규 TC → 기존 TC는 그대로, 새 TC는 고객사 ID 없이 revision 1', async () => {
    const { repos, before, load } = await setup({ duplicate: 'create_separate' });
    await repos.changeAnalyses.apply(ANALYSIS);
    const { testCases } = await load();
    expect(testCases.find((item) => item.id === 'tc-001')).toEqual(before.testCases.find((item) => item.id === 'tc-001'));
    const separate = testCases.filter((item) => item.title === '바뀐 규칙에 맞는 비밀번호로 가입 완료');
    expect(separate).toHaveLength(1);
    expect(separate[0]).toMatchObject({ revision: 1, status: 'draft' });
    expect(separate[0].externalId).toBeUndefined();
    expect(testCases).toHaveLength(before.testCases.length + 3);
  });

  it('중복 후보 · 제외 → 아무 변화가 없다', async () => {
    const { repos, before, load } = await setup({ duplicate: 'excluded' });
    await repos.changeAnalyses.apply(ANALYSIS);
    const { testCases } = await load();
    expect(testCases.find((item) => item.id === 'tc-001')).toEqual(before.testCases.find((item) => item.id === 'tc-001'));
    expect(testCases.filter((item) => item.title === '바뀐 규칙에 맞는 비밀번호로 가입 완료')).toHaveLength(0);
  });
});

describe('원자성', () => {
  it('잘못된 참조가 하나라도 있으면 요구사항·TC·분석 상태 모두 그대로다', async () => {
    const seed = createSeed();
    // 요구사항 변경은 모두 유효하지만 마지막 TC 영향 하나가 없는 TC를 가리킨다.
    seed.changeAnalyses[0].testImpacts.find((item) => item.id === 'ti-006')!.testCaseId = 'tc-missing';
    const { repos, before, load } = await setup({}, seed);
    const activitiesBefore = (await repos.activities.list()).length;

    await expect(repos.changeAnalyses.apply(ANALYSIS)).rejects.toThrow('대상 TC를 찾을 수 없어요');

    const { analysis, requirements, testCases } = await load();
    expect(requirements).toEqual(before.requirements);
    expect(testCases).toEqual(before.testCases);
    expect(analysis.status).toBe('reviewed');
    expect(analysis.appliedSummary).toBeUndefined();
    expect(await repos.activities.list()).toHaveLength(activitiesBefore);
  });

  it('같은 TC를 두 제안이 동시에 바꾸려 하면 반영하지 않는다', async () => {
    const seed = createSeed();
    seed.changeAnalyses[0].testImpacts.find((item) => item.id === 'ti-006')!.testCaseId = 'tc-002';
    const { repos, before, load } = await setup({}, seed);
    await expect(repos.changeAnalyses.apply(ANALYSIS)).rejects.toThrow('같은 TC에 반영할 제안이 둘 이상');
    expect((await load()).testCases).toEqual(before.testCases);
  });

  it('없는 테스트 조건을 참조하는 새 TC 제안이 있으면 반영하지 않는다', async () => {
    const seed = createSeed();
    seed.changeAnalyses[0].testImpacts.find((item) => item.id === 'ti-002')!.newTestCase!.testConditionIds = ['cond-missing'];
    const { repos, before, load } = await setup({}, seed);
    await expect(repos.changeAnalyses.apply(ANALYSIS)).rejects.toThrow('테스트 조건을 찾을 수 없어요');
    const { requirements, testCases } = await load();
    expect(requirements).toEqual(before.requirements);
    expect(testCases).toEqual(before.testCases);
  });
});

describe('회귀', () => {
  it('반영 후에도 두 차수의 수행 결과가 externalId로 같은 TC에 연결된다', async () => {
    const { repos, load } = await setup({ duplicate: 'create_separate' });
    await repos.changeAnalyses.apply(ANALYSIS);
    const byId = new Map((await load()).testCases.map((item) => [item.id, item]));
    for (const resultImport of await repos.testResults.listImports(PROJECT_A)) {
      const results = await repos.testResults.listResults(resultImport.id);
      expect(results).toHaveLength(212);
      const linked = results.filter((item) => item.testCaseId);
      expect(linked).toHaveLength(30);
      for (const result of linked) expect(byId.get(result.testCaseId!)?.externalId).toBe(result.externalId);
    }
  });
});
