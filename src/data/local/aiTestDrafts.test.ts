import { describe, expect, it } from 'vitest';
import { aiDraftBasis, buildAiDraftRequest, buildAiTestDraftCandidates } from '@/domain/aiTestDrafts';
import {
  analyzeTestDraftCandidates,
  analyzeTestDraftGeneration,
  TestDraftGenerationError,
  toTestDraftDecisionInputs,
  type TestDraftContext,
  type TestDraftDecision,
} from '@/domain/testDraftGeneration';
import type { TestPerspective } from '@/domain/types';
import { AI_LIMITS, type AiDraftItem } from '@/shared/aiTestDraftContract';
import type { CreateTestDraftsInput, Repositories } from '../repositories/types';
import { createSeed, PROJECT_A, PROJECT_B } from '../mock/seed';
import type { AppData, StoredAppState } from './appData';
import { createLocalRepositories } from './localRepositories';
import { createMemoryStateStore } from './stateStore';

/*
 * AI가 만든 TC 초안의 흐름: 요구사항 → AI 후보 → 분석 → 검토 → 명시적 적용.
 * AI 응답은 후보일 뿐이라 분석(중복 · 확인 필요 · 지문 · 추적성)을 규칙 기반 후보와 똑같이 거치고,
 * 검토만으로는 아무것도 저장되지 않으며, 적용해도 기존 TC · 조건은 바뀌지 않는다.
 */

const STALE = '요구사항이나 기존 TC가 바뀌어 미리보기를 다시 확인해 주세요.';
const REQUEST = { requirementIds: ['req-001', 'req-002'], perspectives: ['normal_flow', 'exception'] as TestPerspective[] };

const aiDraft = (requirementId: string, perspective: TestPerspective, overrides: Partial<AiDraftItem> = {}): AiDraftItem => ({
  requirementId,
  perspective,
  conditionTitle: `AI 조건 · ${requirementId} · ${perspective}`,
  title: `AI TC · ${requirementId} · ${perspective}`,
  precondition: null,
  steps: ['화면으로 이동한다.', '동작을 수행한다.'],
  expectedResult: '요구사항대로 동작한다.',
  ...overrides,
});

const fullDrafts = () => REQUEST.requirementIds.flatMap((id) => REQUEST.perspectives.map((perspective) => aiDraft(id, perspective)));

async function open() {
  const base = createMemoryStateStore();
  const repos = createLocalRepositories({ openStore: async () => base, createInitialData: () => createSeed() });
  await repos.persistence.load();
  return { repos, base };
}

const stored = (store: ReturnType<typeof createMemoryStateStore>) => structuredClone(store.inspect().state as StoredAppState & { data: AppData });

async function contextOf(repos: Repositories, projectId = PROJECT_A): Promise<TestDraftContext> {
  const project = (await repos.projects.get(projectId))!;
  return {
    project,
    requirements: await repos.requirements.listByProject(projectId),
    deliverables: await repos.deliverables.listByProject(projectId),
    testConditions: await repos.testConditions.listByProject(projectId),
    testCases: await repos.testCases.listByProject(projectId),
    templates: project.tcTemplateId ? [(await repos.templates.get(project.tcTemplateId))!].filter(Boolean) : [],
  };
}

/** 화면과 같은 방법으로 AI 초안을 후보로 바꿔 분석하고 저장 입력을 만든다. */
async function aiPreview(repos: Repositories, drafts: AiDraftItem[], request = REQUEST, decisions: Record<string, TestDraftDecision> = {}) {
  const context = await contextOf(repos);
  const produced = buildAiTestDraftCandidates(context, request, drafts);
  const analysis = analyzeTestDraftCandidates(context, produced.candidates, produced.skipped, { requirementCount: request.requirementIds.length, perspectiveCount: request.perspectives.length });
  const input: CreateTestDraftsInput = { projectId: PROJECT_A, ...request, candidates: toTestDraftDecisionInputs(analysis, decisions), aiDrafts: drafts };
  return { context, analysis, input };
}

const everything = async (repos: Repositories, base: ReturnType<typeof createMemoryStateStore>) => ({
  state: stored(base),
  testCases: await repos.testCases.listByProject(PROJECT_A),
  conditions: await repos.testConditions.listByProject(PROJECT_A),
  activities: await repos.activities.list(),
});

async function changeStored(base: ReturnType<typeof createMemoryStateStore>, repos: Repositories, change: (data: AppData) => void) {
  const current = stored(base);
  change(current.data);
  await base.commit({ expectedRevision: current.revision, schemaVersion: current.schemaVersion, savedAt: current.savedAt, data: current.data });
  await repos.persistence.reloadLatest();
}

describe('AI로 보내는 요청', () => {
  it('고른 요구사항의 ID · 기능 · 문장 · 확인 필요 여부와 관점만 담고, 고른 순서를 지킨다', async () => {
    const { repos } = await open();
    const context = await contextOf(repos);
    const request = buildAiDraftRequest(context, { requirementIds: ['req-004', 'req-001'], perspectives: ['exception', 'normal_flow'] });
    expect(request.perspectives).toEqual(['exception', 'normal_flow']);
    expect(request.requirements.map((item) => item.id)).toEqual(['req-004', 'req-001']);
    expect(request.requirements[0]).toEqual({ id: 'req-004', feature: '회원가입', text: expect.stringContaining('약관 재동의'), needsConfirmation: true });
    expect(request.requirements[1].needsConfirmation).toBe(false);
    for (const item of request.requirements) expect(Object.keys(item).sort()).toEqual(['feature', 'id', 'needsConfirmation', 'text']);
  });

  it('고르지 않은 요구사항 · 산출물 · 근거 위치 · 기존 TC · 다른 프로젝트 데이터는 담기지 않는다', async () => {
    const { repos } = await open();
    const context = await contextOf(repos);
    const serialized = JSON.stringify(buildAiDraftRequest(context, { requirementIds: ['req-001'], perspectives: ['normal_flow'] }));
    for (const other of context.requirements.filter((item) => item.id !== 'req-001')) expect(serialized).not.toContain(other.text);
    for (const testCase of context.testCases) expect(serialized).not.toContain(testCase.title);
    for (const deliverable of context.deliverables) expect(serialized).not.toContain(deliverable.title);
    for (const requirement of context.requirements) for (const ref of requirement.sourceRefs) expect(serialized).not.toContain(ref.locator);
    expect(serialized).not.toContain('sourceRefs');
    expect(serialized).not.toContain(PROJECT_A);
    expect(serialized).not.toContain(PROJECT_B);
    expect(serialized).not.toContain('tc-001');
  });

  it('제거된 요구사항 · 없는 요구사항 · 다른 프로젝트 요구사항 · 쓸 수 없는 관점은 요청을 만들지 않는다', async () => {
    const { repos } = await open();
    const context = await contextOf(repos);
    expect(() => buildAiDraftRequest(context, { requirementIds: ['req-013'], perspectives: ['normal_flow'] })).toThrow(TestDraftGenerationError);
    expect(() => buildAiDraftRequest(context, { requirementIds: ['req-nope'], perspectives: ['normal_flow'] })).toThrow(TestDraftGenerationError);
    expect(() => buildAiDraftRequest(context, { requirementIds: [], perspectives: ['normal_flow'] })).toThrow(TestDraftGenerationError);
    expect(() => buildAiDraftRequest(context, { requirementIds: ['req-001'], perspectives: [] })).toThrow(TestDraftGenerationError);
  });

  it('입력 기준값(basis)은 요구사항 문장 · 기능 · 확인 필요가 바뀌면 달라진다', async () => {
    const { repos } = await open();
    const context = await contextOf(repos);
    const before = aiDraftBasis(buildAiDraftRequest(context, REQUEST));
    expect(aiDraftBasis(buildAiDraftRequest(context, REQUEST))).toBe(before);
    const changed = structuredClone(context);
    changed.requirements.find((item) => item.id === 'req-001')!.text = '이메일로만 가입할 수 있다.';
    expect(aiDraftBasis(buildAiDraftRequest(changed, REQUEST))).not.toBe(before);
  });
});

describe('AI 초안 → 후보', () => {
  it('요구사항 순서 → 관점 순서의 후보로 바꾸고 AI가 보낸 순서와 무관하다', async () => {
    const { repos } = await open();
    const context = await contextOf(repos);
    const drafts = fullDrafts().reverse();
    const { candidates, skipped } = buildAiTestDraftCandidates(context, REQUEST, drafts);
    expect(candidates.map((item) => item.key)).toEqual(['normal_flow|req-001', 'exception|req-001', 'normal_flow|req-002', 'exception|req-002']);
    expect(skipped).toEqual([]);
    expect(candidates.every((item) => item.origin === 'ai_generated' && item.generationType === 'ai_suggestion')).toBe(true);
  });

  it('기능명 · 요구사항 연결은 AI가 아니라 저장된 요구사항에서 가져온다', async () => {
    const { repos } = await open();
    const context = await contextOf(repos);
    const { candidates } = buildAiTestDraftCandidates(context, REQUEST, [aiDraft('req-001', 'normal_flow')]);
    expect(candidates[0]).toMatchObject({
      requirementIds: ['req-001'],
      condition: { feature: '회원가입' },
      testCase: { feature: '회원가입', depth: ['회원가입', '정상 흐름'] },
    });
  });

  it('AI가 만들지 않은 조합은 건너뜀으로 남기고 채워 넣지 않는다', async () => {
    const { repos } = await open();
    const context = await contextOf(repos);
    const { candidates, skipped } = buildAiTestDraftCandidates(context, REQUEST, [aiDraft('req-001', 'normal_flow')]);
    expect(candidates).toHaveLength(1);
    expect(skipped.map((item) => `${item.requirementId}|${item.perspective}`)).toEqual(['req-001|exception', 'req-002|normal_flow', 'req-002|exception']);
    expect(skipped[0].reason).toContain('AI가');
  });

  it('요청하지 않은 요구사항 ID · 관점이거나 같은 조합이 두 번이면 후보로 바꾸지 않고 던진다', async () => {
    const { repos } = await open();
    const context = await contextOf(repos);
    expect(() => buildAiTestDraftCandidates(context, REQUEST, [aiDraft('req-003', 'normal_flow')])).toThrow();
    expect(() => buildAiTestDraftCandidates(context, REQUEST, [aiDraft('req-001', 'boundary')])).toThrow();
    expect(() => buildAiTestDraftCandidates(context, REQUEST, [aiDraft('req-001', 'normal_flow'), aiDraft('req-001', 'normal_flow')])).toThrow();
    expect(() => buildAiTestDraftCandidates(context, REQUEST, [aiDraft('req-nope', 'normal_flow')])).toThrow();
  });
});

describe('AI 후보 분석 (기존 보호 장치 유지)', () => {
  it('확인 필요 요구사항의 AI 초안은 확인 필요로 올리고 기대 결과가 확정처럼 보이지 않게 한다', async () => {
    const { repos } = await open();
    const request = { requirementIds: ['req-004'], perspectives: ['normal_flow'] as TestPerspective[] };
    const { analysis } = await aiPreview(repos, [aiDraft('req-004', 'normal_flow', { expectedResult: '약관 재동의 화면이 표시된다.' })], request);
    expect(analysis.rows[0]).toMatchObject({ kind: 'create', needsConfirmation: true });
    expect(analysis.rows[0].candidate.generationType).toBe('needs_confirmation');
    expect(analysis.rows[0].candidate.testCase.expectedResult).toBe('확인 필요 — 약관 재동의 화면이 표시된다.');
  });

  it('AI가 기대 결과를 확인 필요로 밝힌 초안은 요구사항이 확인 필요가 아니어도 확인 필요로 두고, 밝히지 않은 초안은 AI 제안으로 둔다', async () => {
    const { repos } = await open();
    const request = { requirementIds: ['req-001', 'req-002'], perspectives: ['exception'] as TestPerspective[] };
    const marked = '확인 필요 — 실패 시 보여 줄 문구와 잠금 정책이 정해지지 않았어요. 로그인되지 않는 것만 확인해요.';
    const { analysis } = await aiPreview(repos, [aiDraft('req-001', 'exception', { expectedResult: marked }), aiDraft('req-002', 'exception')], request);
    const [confirmation, plain] = analysis.rows;
    expect(confirmation).toMatchObject({ kind: 'create', needsConfirmation: true });
    expect(confirmation.candidate.generationType).toBe('needs_confirmation');
    expect(confirmation.candidate.testCase.expectedResult).toBe(marked);
    expect(plain).toMatchObject({ kind: 'create', needsConfirmation: false });
    expect(plain.candidate.generationType).toBe('ai_suggestion');
  });

  it('확인 필요로 밝힌 AI 초안을 적용하면 확인 필요 TC로 저장되고 검토 완료로 바꿀 수 없다', async () => {
    const { repos } = await open();
    const request = { requirementIds: ['req-001'], perspectives: ['exception'] as TestPerspective[] };
    const { input } = await aiPreview(repos, [aiDraft('req-001', 'exception', { expectedResult: '확인 필요 — 오류 문구 · 잠금 정책은 정해지지 않았어요.' })], request);
    const result = await repos.testCases.createDraftsFromRequirements(input);
    expect(result.testCases[0]).toMatchObject({ generationType: 'needs_confirmation', status: 'draft', origin: 'ai_generated' });
    expect(result.testConditions[0].status).toBe('needs_review');
    await expect(repos.testCases.updateStatus(result.testCases[0].id, 'reviewed')).rejects.toThrow('확인 필요 TC');
  });

  it('AI가 일반 근거라고 주장해도 AI 제안 이상으로 다루고, 근거는 요구사항의 근거 산출물을 따른다 (추적성)', async () => {
    const { repos } = await open();
    const { analysis } = await aiPreview(repos, fullDrafts());
    expect(analysis.rows.every((row) => row.candidate.generationType === 'ai_suggestion' && row.kind === 'create')).toBe(true);
    expect(analysis.rows.find((row) => row.candidate.key === 'normal_flow|req-002')!.sourceRefs).toEqual([{ deliverableId: 'dlv-plan-pdf', locator: 'p.14' }]);
  });

  it('같은 내용의 기존 TC가 있으면 중복으로 두고 사용자가 판단하기 전에는 저장하지 못한다', async () => {
    const { repos } = await open();
    // 기능은 요구사항에서 오므로, req-002와 같은 기능이고 req-002에 아직 연결되지 않은 기존 TC의 내용을 AI가 그대로 만들었다고 본다.
    const existing = (await repos.testCases.listByProject(PROJECT_A)).find((item) => item.feature === '회원가입' && item.status !== 'deprecated' && !item.requirementIds.includes('req-002'));
    expect(existing).toBeDefined();
    const drafts = [aiDraft('req-002', existing!.category, { title: existing!.title, steps: existing!.steps, expectedResult: existing!.expectedResult })];
    const request = { requirementIds: ['req-002'], perspectives: [existing!.category] };
    const { analysis, input } = await aiPreview(repos, drafts, request);
    expect(analysis.rows[0].kind).toBe('duplicate');
    expect(analysis.rows[0].duplicateTarget).toMatchObject({ type: 'existing', id: existing!.id, linked: false });
    expect(input.candidates[0].decision).toBe('pending');
    await expect(repos.testCases.createDraftsFromRequirements(input)).rejects.toThrow('판단하지 않은 중복');
  });

  it('요구사항이 다른 AI 초안끼리 내용이 같으면 앞선 후보와의 중복으로 판단을 요구한다', async () => {
    const { repos } = await open();
    const same = { title: '같은 제목', steps: ['같은 절차'], expectedResult: '같은 결과' };
    const { analysis } = await aiPreview(repos, [aiDraft('req-001', 'normal_flow', same), aiDraft('req-002', 'normal_flow', same)], { requirementIds: ['req-001', 'req-002'], perspectives: ['normal_flow'] });
    expect(analysis.rows.map((row) => row.kind)).toEqual(['create', 'duplicate']);
    expect(analysis.rows[1].duplicateTarget).toEqual({ type: 'batch', key: 'normal_flow|req-001' });
  });

  it('규칙 기반 후보와 AI 후보는 같은 키여도 지문이 다르다 (출처가 지문에 들어간다)', async () => {
    const { repos } = await open();
    const context = await contextOf(repos);
    const rule = analyzeTestDraftGeneration(context, { requirementIds: ['req-001'], perspectives: ['normal_flow'] }).rows[0];
    const { analysis } = await aiPreview(repos, [aiDraft('req-001', 'normal_flow', { title: rule.candidate.testCase.title, steps: rule.candidate.testCase.steps, expectedResult: rule.candidate.testCase.expectedResult })], {
      requirementIds: ['req-001'],
      perspectives: ['normal_flow'],
    });
    expect(analysis.rows[0].candidate.key).toBe(rule.candidate.key);
    expect(analysis.rows[0].fingerprint).not.toBe(rule.fingerprint);
  });
});

describe('검토 · 명시적 적용', () => {
  it('AI 초안을 받고 분석 · 검토만 해서는 저장소가 바뀌지 않는다', async () => {
    const { repos, base } = await open();
    const before = await everything(repos, base);
    await aiPreview(repos, fullDrafts(), REQUEST, { 'exception|req-001': 'excluded' });
    expect(await everything(repos, base)).toEqual(before);
  });

  it('적용하면 후보 상태(초안 · ai_generated · AI 제안)의 TC가 요구사항 · 조건 · 근거와 함께 만들어지고 기존 데이터는 그대로다', async () => {
    const { repos, base } = await open();
    const before = await everything(repos, base);
    const { input } = await aiPreview(repos, fullDrafts());
    const result = await repos.testCases.createDraftsFromRequirements(input);

    expect(result.testCases).toHaveLength(4);
    for (const testCase of result.testCases) {
      expect(testCase).toMatchObject({ projectId: PROJECT_A, status: 'draft', revision: 1, origin: 'ai_generated', generationType: 'ai_suggestion', templateId: 'tpl-client-a' });
      expect(testCase).not.toHaveProperty('externalId');
      expect(testCase.sourceRefs.length).toBeGreaterThan(0);
      expect(testCase.testConditionIds).toHaveLength(1);
    }
    expect(result.testCases.map((item) => item.requirementIds)).toEqual([['req-001'], ['req-001'], ['req-002'], ['req-002']]);
    expect(result.testCases[0].title).toBe('AI TC · req-001 · normal_flow');
    expect(result.updatedTestCases).toEqual([]);
    expect(await repos.testCases.listByProject(PROJECT_A)).toEqual([...before.testCases, ...result.testCases]);
    expect(await repos.testConditions.listByProject(PROJECT_A)).toEqual([...before.conditions, ...result.testConditions]);

    const activities = await repos.activities.list();
    expect(activities).toHaveLength(before.activities.length + 1);
    expect(activities[0].title).toBe('AI TC 초안 4건 생성');
    expect(activities[0].metadata?.detail).toContain('AI 초안 ·');
  });

  it('규칙 기반 저장은 그대로 manual TC를 만든다 (회귀)', async () => {
    const { repos } = await open();
    const context = await contextOf(repos);
    const request = { requirementIds: ['req-001'], perspectives: ['normal_flow'] as TestPerspective[] };
    const analysis = analyzeTestDraftGeneration(context, request);
    const result = await repos.testCases.createDraftsFromRequirements({ projectId: PROJECT_A, ...request, candidates: toTestDraftDecisionInputs(analysis) });
    expect(result.testCases[0]).toMatchObject({ origin: 'manual', generationType: 'source_explicit' });
    expect((await repos.activities.list())[0].title).toBe('TC 초안 1건 생성');
  });

  it('제외한 AI 초안은 저장하지 않는다', async () => {
    const { repos } = await open();
    const { input } = await aiPreview(repos, fullDrafts(), REQUEST, { 'exception|req-001': 'excluded', 'exception|req-002': 'excluded' });
    const result = await repos.testCases.createDraftsFromRequirements(input);
    expect(result.testCases.map((item) => item.title)).toEqual(['AI TC · req-001 · normal_flow', 'AI TC · req-002 · normal_flow']);
  });

  it('미리보기 뒤 요구사항이 바뀌면 AI 초안도 저장하지 않는다 (stale fingerprint)', async () => {
    const { repos, base } = await open();
    const { input } = await aiPreview(repos, fullDrafts());
    await changeStored(base, repos, (data) => {
      data.requirements.find((item) => item.id === 'req-001')!.text = '미리보기 뒤에 바뀐 요구사항 문장이다.';
    });
    const before = await everything(repos, base);
    await expect(repos.testCases.createDraftsFromRequirements(input)).rejects.toThrow(STALE);
    expect(await everything(repos, base)).toEqual(before);
  });

  it('미리보기 뒤 요구사항이 확인 필요가 되면 AI 초안도 저장하지 않는다', async () => {
    const { repos, base } = await open();
    const { input } = await aiPreview(repos, fullDrafts());
    await changeStored(base, repos, (data) => {
      data.requirements.find((item) => item.id === 'req-002')!.needsConfirmation = true;
    });
    const before = await everything(repos, base);
    await expect(repos.testCases.createDraftsFromRequirements(input)).rejects.toThrow(STALE);
    expect(await everything(repos, base)).toEqual(before);
  });

  it('미리보기 뒤 AI 초안 내용이 달라지면(바뀐 초안을 같은 지문으로 보내면) 저장하지 않는다', async () => {
    const { repos, base } = await open();
    const { input } = await aiPreview(repos, fullDrafts());
    const tampered = input.aiDrafts!.map((item, index) => (index === 0 ? { ...item, expectedResult: '미리보기에서 보지 않은 기대 결과' } : item));
    const before = await everything(repos, base);
    await expect(repos.testCases.createDraftsFromRequirements({ ...input, aiDrafts: tampered })).rejects.toThrow(STALE);
    expect(await everything(repos, base)).toEqual(before);
  });

  it('미리보기에 없던 AI 초안을 몰래 더하거나 빼면 저장하지 않는다', async () => {
    const { repos, base } = await open();
    const { input } = await aiPreview(repos, fullDrafts());
    const before = await everything(repos, base);
    await expect(repos.testCases.createDraftsFromRequirements({ ...input, aiDrafts: input.aiDrafts!.slice(1) })).rejects.toThrow(STALE);
    await expect(repos.testCases.createDraftsFromRequirements({ ...input, candidates: input.candidates.slice(1) })).rejects.toThrow(STALE);
    expect(await everything(repos, base)).toEqual(before);
  });

  it('요청하지 않은 요구사항 · 관점의 AI 초안은 저장소가 거부한다', async () => {
    const { repos, base } = await open();
    const { input } = await aiPreview(repos, fullDrafts());
    const before = await everything(repos, base);
    for (const aiDrafts of [
      [...input.aiDrafts!, aiDraft('req-003', 'normal_flow')],
      [...input.aiDrafts!, aiDraft('req-001', 'boundary')],
      [...input.aiDrafts!, aiDraft('req-nope', 'normal_flow')],
      [...input.aiDrafts!, input.aiDrafts![0]],
      [{ ...input.aiDrafts![0], steps: [] }],
      [{ ...input.aiDrafts![0], title: 'x'.repeat(AI_LIMITS.maxTitleLength + 1) }],
    ]) {
      await expect(repos.testCases.createDraftsFromRequirements({ ...input, aiDrafts })).rejects.toThrow();
    }
    expect(await everything(repos, base)).toEqual(before);
  });

  it('소규모 배치 한도를 넘는 AI 초안 저장은 거부한다', async () => {
    const { repos, base } = await open();
    const { input } = await aiPreview(repos, fullDrafts());
    const before = await everything(repos, base);
    const many = Array.from({ length: AI_LIMITS.maxDrafts + 1 }, () => input.aiDrafts![0]);
    await expect(repos.testCases.createDraftsFromRequirements({ ...input, aiDrafts: many })).rejects.toThrow();
    await expect(repos.testCases.createDraftsFromRequirements({ ...input, requirementIds: ['req-001', 'req-002', 'req-003', 'req-004', 'req-005', 'req-006'] })).rejects.toThrow();
    expect(await everything(repos, base)).toEqual(before);
  });

  it('제거된 요구사항이 포함되면 AI 초안도 저장하지 않는다', async () => {
    const { repos, base } = await open();
    const context = await contextOf(repos);
    expect(() => buildAiTestDraftCandidates(context, { requirementIds: ['req-013'], perspectives: ['normal_flow'] }, [aiDraft('req-013', 'normal_flow')])).toThrow(TestDraftGenerationError);
    const before = await everything(repos, base);
    await expect(
      repos.testCases.createDraftsFromRequirements({ projectId: PROJECT_A, requirementIds: ['req-013'], perspectives: ['normal_flow'], candidates: [], aiDrafts: [aiDraft('req-013', 'normal_flow')] }),
    ).rejects.toThrow();
    expect(await everything(repos, base)).toEqual(before);
  });
});
