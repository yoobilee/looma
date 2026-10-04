import { describe, expect, it } from 'vitest';
import { activityLinkLabel, activityLinkPath } from '@/domain/activityRecords';
import {
  analyzeTestDraftCandidates,
  analyzeTestDraftGeneration,
  planTestDraftGeneration,
  produceRuleBasedTestDrafts,
  StaleTestDraftPreviewError,
  TestDraftGenerationError,
  toTestDraftDecisionInputs,
  type TestDraftContext,
  type TestDraftDecision,
} from '@/domain/testDraftGeneration';
import type { Requirement, TestCase, TestPerspective } from '@/domain/types';
import { PersistenceError } from '../persistenceError';
import type { CreateTestDraftsInput, PersistenceStatus, Repositories } from '../repositories/types';
import { createSeed, PROJECT_A, PROJECT_B } from '../mock/seed';
import type { AppData, StoredAppState } from './appData';
import { createLocalRepositories } from './localRepositories';
import { createMemoryStateStore, type StateStore } from './stateStore';

/*
 * 요구사항 기반 TC 초안 저장. 현재 데이터로 다시 분석해 미리보기와 같은 후보(지문)만 반영하고, 중복은 사용자의 판단대로 처리하며,
 * 테스트 조건 · TC · 기존 TC 연결 · 활동을 한 번의 저장으로 남긴다.
 * 입력이 맞지 않거나 · 미리보기가 오래됐거나 · 양식이 맞지 않거나 · 저장에 실패하면 조건 · TC · 활동 · 저장 상태 · revision이 모두 그대로다.
 * 스키마 · 저장 구조는 그대로라 migration 없이 현재 버전 데이터에 쓴다.
 */

const STALE = '요구사항이나 기존 TC가 바뀌어 미리보기를 다시 확인해 주세요.';

/** 다음 commit 한 번만 실패시키는 저장소. 실패한 쓰기는 아무것도 남기지 않는다. */
function failingOnce(base: StateStore) {
  let fail = false;
  const store: StateStore = { ...base, commit: async (input) => (fail ? ((fail = false), Promise.reject(new Error('write failed'))) : base.commit(input)) };
  return { store, failNext: () => (fail = true) };
}

async function open(seed: AppData = createSeed()) {
  const base = createMemoryStateStore();
  const { store, failNext } = failingOnce(base);
  const repos = createLocalRepositories({ openStore: async () => store, createInitialData: () => seed });
  await repos.persistence.load();
  return { repos, base, failNext };
}

const ready = (repos: Repositories) => repos.persistence.getStatus() as Extract<PersistenceStatus, { state: 'ready' }>;
const stored = (store: ReturnType<typeof createMemoryStateStore>) => structuredClone(store.inspect().state as StoredAppState & { data: AppData });
const draftActivities = async (repos: Repositories) => (await repos.activities.list({ projectId: PROJECT_A })).filter((item) => item.type === 'test_drafts_generated');
const snapshot = async (repos: Repositories, base: ReturnType<typeof createMemoryStateStore>) => ({
  state: stored(base),
  testCases: await repos.testCases.listByProject(PROJECT_A),
  conditions: await repos.testConditions.listByProject(PROJECT_A),
  activities: await repos.activities.list(),
  revision: ready(repos).revision,
});

/** 화면과 같은 방법으로 지금 저장소 데이터를 분석해 미리보기 · 저장 입력을 만든다. */
async function previewOf(repos: Repositories, request: { requirementIds: string[]; perspectives: TestPerspective[] }, decisions: Record<string, TestDraftDecision> = {}, projectId = PROJECT_A) {
  const project = (await repos.projects.get(projectId))!;
  const context: TestDraftContext = {
    project,
    requirements: await repos.requirements.listByProject(projectId),
    deliverables: await repos.deliverables.listByProject(projectId),
    testConditions: await repos.testConditions.listByProject(projectId),
    testCases: await repos.testCases.listByProject(projectId),
    templates: project.tcTemplateId ? [(await repos.templates.get(project.tcTemplateId))!].filter(Boolean) : [],
  };
  const analysis = analyzeTestDraftGeneration(context, request);
  const input: CreateTestDraftsInput = { projectId, ...request, candidates: toTestDraftDecisionInputs(analysis, decisions) };
  return { analysis, input, context };
}

const REQUEST = { requirementIds: ['req-001', 'req-002'], perspectives: ['normal_flow', 'boundary'] as TestPerspective[] };

/** 저장된 데이터를 바꾼다(미리보기 뒤 다른 경로로 바뀐 상황). */
async function changeStored(base: ReturnType<typeof createMemoryStateStore>, repos: Repositories, change: (data: AppData) => void) {
  const current = stored(base);
  change(current.data);
  await base.commit({ expectedRevision: current.revision, schemaVersion: current.schemaVersion, savedAt: current.savedAt, data: current.data });
  await repos.persistence.reloadLatest();
}

describe('요구사항 기반 TC 초안 저장', () => {
  it('테스트 조건 · TC 초안을 만들고 요구사항 · 조건 · 근거 · 템플릿을 연결하며, 같은 저장에 활동 하나를 남긴다', async () => {
    const { repos, base } = await open();
    const before = await snapshot(repos, base);

    // req-001: 정상 흐름만(경계값 단서 없음), req-002: 정상 흐름 + 경계값 → 3건 중 경계값 1건 제외
    const { input } = await previewOf(repos, REQUEST, { 'boundary|req-002': 'excluded' });
    const result = await repos.testCases.createDraftsFromRequirements(input);

    expect(result.summary).toMatchObject({ requirementCount: 2, perspectiveCount: 2, created: 2, linked: 0, needsConfirmation: 0, duplicate: 0, invalid: 0, excluded: 1, skipped: 1 });
    expect(result.testCases).toHaveLength(2);
    expect(result.testConditions).toHaveLength(2);
    expect(result.updatedTestCases).toEqual([]);
    for (const testCase of result.testCases) {
      expect(testCase).toMatchObject({ projectId: PROJECT_A, templateId: 'tpl-client-a', status: 'draft', revision: 1, origin: 'manual', generationType: 'source_explicit', category: 'normal_flow' });
      expect(testCase).not.toHaveProperty('externalId');
      expect(testCase.testConditionIds).toHaveLength(1);
    }
    expect(result.testCases.map((item) => item.requirementIds)).toEqual([['req-001'], ['req-002']]);
    expect(result.testCases[1].sourceRefs).toEqual([{ deliverableId: 'dlv-plan-pdf', locator: 'p.14' }]);
    expect(new Set([...result.testCases.map((item) => item.createdAt), ...result.testConditions.map((item) => item.createdAt)]).size).toBe(1);

    // 기존 TC · 조건은 그대로이고 새 항목만 더해진다.
    expect(await repos.testCases.listByProject(PROJECT_A)).toEqual([...before.testCases, ...result.testCases]);
    expect(await repos.testConditions.listByProject(PROJECT_A)).toEqual([...before.conditions, ...result.testConditions]);
    expect(await repos.testCases.listByProject(PROJECT_B)).toEqual(createSeed().testCases.filter((item) => item.projectId === PROJECT_B));
    const conditionIds = new Set(result.testConditions.map((item) => item.id));
    expect(result.testCases.every((item) => conditionIds.has(item.testConditionIds[0]))).toBe(true);

    const activities = await repos.activities.list();
    expect(activities).toHaveLength(before.activities.length + 1);
    expect(activities[0]).toEqual({
      id: expect.any(String),
      type: 'test_drafts_generated',
      projectId: PROJECT_A,
      title: 'TC 초안 2건 생성',
      metadata: {
        detail: '요구사항 2 · 관점 2 · 신규 TC 2(별도 신규 0) · 기존 TC 연결 0 · 생성 TC 연결 0 · 테스트 조건 신규 2 · 재사용 0 · 중복 제외 0 · 제외 1',
        generatedTestCaseIds: result.testCases.map((item) => item.id).join(','),
      },
      createdAt: expect.any(String),
    });
    // 기록에서는 제목이 아닌 "테스트 설계 보기"로 테스트 설계 탭에 간다.
    expect(activityLinkPath(activities[0], PROJECT_A)).toBe(`/projects/${PROJECT_A}/test-design`);
    expect(activityLinkLabel(activities[0])).toBe('테스트 설계 보기');
    expect(ready(repos).revision).toBe(before.revision + 1);
    const saved = stored(base);
    expect(saved.revision).toBe(before.revision + 1);
    expect(saved.data.testCases.filter((item) => result.testCases.some((created) => created.id === item.id))).toEqual(result.testCases);
    expect(saved.data.testConditions.filter((item) => conditionIds.has(item.id))).toEqual(result.testConditions);
  });

  it('이미 있는 같은 테스트 조건은 다시 쓰고 수정하지 않으며, 같은 내용의 TC가 이미 있으면 판단 없이는 만들지 않는다', async () => {
    const { repos } = await open();
    const request = { requirementIds: ['req-001'], perspectives: ['normal_flow'] as TestPerspective[] };
    const first = await repos.testCases.createDraftsFromRequirements((await previewOf(repos, request)).input);
    const conditionsAfterFirst = await repos.testConditions.listByProject(PROJECT_A);

    // 같은 요구사항 · 관점으로 다시 만들면 TC가 중복이라 판단이 필요하고, 이미 연결돼 있어 기본은 제외라 반영할 것이 없다.
    const again = await previewOf(repos, request);
    expect(again.analysis.rows[0]).toMatchObject({ kind: 'duplicate', duplicateTarget: { type: 'existing', id: first.testCases[0].id, linked: true } });
    await expect(repos.testCases.createDraftsFromRequirements(again.input)).rejects.toThrow('새로 반영할 TC 초안 또는 연결이 없어요.');
    expect(await repos.testConditions.listByProject(PROJECT_A)).toEqual(conditionsAfterFirst);
    expect(await draftActivities(repos)).toHaveLength(1);

    // 첫 TC를 폐기하면 같은 내용을 다시 만들 수 있고, 조건은 재사용한다.
    await repos.testCases.updateStatus(first.testCases[0].id, 'deprecated');
    const result = await repos.testCases.createDraftsFromRequirements((await previewOf(repos, request)).input);
    expect(result.testConditions).toEqual([]);
    expect(result.testCases[0].testConditionIds).toEqual(first.testCases[0].testConditionIds);
    expect(await repos.testConditions.listByProject(PROJECT_A)).toEqual(conditionsAfterFirst);
    const [latest] = await draftActivities(repos);
    expect(latest.metadata.detail).toBe('요구사항 1 · 관점 1 · 신규 TC 1(별도 신규 0) · 기존 TC 연결 0 · 생성 TC 연결 0 · 테스트 조건 신규 0 · 재사용 1 · 중복 제외 0 · 제외 0');
  });

  it('확인 필요 요구사항은 needs_confirmation 초안으로 만들고 조건은 재검토 필요 상태다', async () => {
    const { repos } = await open();
    const result = await repos.testCases.createDraftsFromRequirements((await previewOf(repos, { requirementIds: ['req-004'], perspectives: ['normal_flow'] })).input);
    expect(result.testCases[0]).toMatchObject({ generationType: 'needs_confirmation', status: 'draft' });
    expect(result.testConditions[0].status).toBe('needs_review');
    expect(result.summary.needsConfirmation).toBe(1);
  });

  it('저장에 실패하면 조건 · TC · 활동 · 저장 상태 · revision이 저장소와 메모리 모두 그대로이고, 다시 시도하면 한 번만 만든다', async () => {
    const { repos, base, failNext } = await open();
    const before = await snapshot(repos, base);
    const { input } = await previewOf(repos, REQUEST);

    failNext();
    await expect(repos.testCases.createDraftsFromRequirements(input)).rejects.toBeInstanceOf(PersistenceError);
    expect(await snapshot(repos, base)).toEqual(before);
    expect(await draftActivities(repos)).toEqual([]);

    const retry = await repos.testCases.createDraftsFromRequirements(input);
    expect(retry.summary).toMatchObject({ created: 3 });
    expect(ready(repos).revision).toBe(before.revision + 1);
    expect(await draftActivities(repos)).toHaveLength(1);
    expect((await repos.testCases.listByProject(PROJECT_A)).length).toBe(before.testCases.length + 3);

    // 성공한 뒤 같은 입력을 또 보내면 미리보기가 오래된 것이라 거부하고 활동도 늘지 않는다.
    await expect(repos.testCases.createDraftsFromRequirements(input)).rejects.toThrow(STALE);
    expect(await draftActivities(repos)).toHaveLength(1);
  });

  it('입력을 바꾸지 않고, 새로고침(저장소 다시 열기) 뒤에도 만든 항목과 활동이 남는다', async () => {
    const base = createMemoryStateStore();
    const first = createLocalRepositories({ openStore: async () => base, createInitialData: createSeed });
    await first.persistence.load();
    const { input } = await previewOf(first, REQUEST);
    const copyOfInput = structuredClone(input);
    const result = await first.testCases.createDraftsFromRequirements(input);
    expect(input).toEqual(copyOfInput);

    const reopened = createLocalRepositories({ openStore: async () => base });
    await reopened.persistence.load();
    const reloaded = await reopened.testCases.listByProject(PROJECT_A);
    expect(reloaded.filter((item) => result.testCases.some((created) => created.id === item.id))).toEqual(result.testCases);
    expect(await draftActivities(reopened)).toHaveLength(1);
  });
});

describe('입력 거부(아무것도 저장하지 않는다)', () => {
  async function expectRejected(change: (input: CreateTestDraftsInput) => Partial<CreateTestDraftsInput>, message: string | RegExp, errorClass: new (...args: never[]) => Error = TestDraftGenerationError) {
    const { repos, base } = await open();
    const before = await snapshot(repos, base);
    const { input } = await previewOf(repos, REQUEST);
    await expect(repos.testCases.createDraftsFromRequirements({ ...input, ...change(input) })).rejects.toThrow(message);
    await expect(repos.testCases.createDraftsFromRequirements({ ...input, ...change(input) })).rejects.toBeInstanceOf(errorClass);
    expect(await snapshot(repos, base)).toEqual(before);
  }

  it.each([
    ['없는 프로젝트', () => ({ projectId: 'proj-missing' }), '프로젝트'],
    ['없는 요구사항', () => ({ requirementIds: ['req-missing'] }), '요구사항을 찾을 수 없어요'],
    ['제거된 요구사항', () => ({ requirementIds: ['req-013'] }), '제거된 요구사항으로는 초안을 만들 수 없어요.'],
    ['빈 요구사항 목록', () => ({ requirementIds: [] }), '요구사항을 하나 이상 골라 주세요.'],
    ['빈 관점 목록', () => ({ perspectives: [] }), '테스트 관점을 하나 이상 골라 주세요.'],
    ['알 수 없는 관점', () => ({ perspectives: ['hacked' as TestPerspective] }), '알 수 없는 테스트 관점이에요.'],
    ['프로젝트 범위에 없는 관점', () => ({ perspectives: ['api'] as TestPerspective[] }), '테스트 범위에 없는 관점이에요.'],
  ])('%s', async (_, change, message) => {
    await expectRejected(change, message, Error);
  });

  it('후보를 빼거나 더하거나 지문이 다르면 오래된 미리보기로 거부한다', async () => {
    await expectRejected((input) => ({ candidates: input.candidates.slice(1) }), STALE, StaleTestDraftPreviewError);
    await expectRejected((input) => ({ candidates: [...input.candidates, { key: 'boundary|req-999', fingerprint: 'x', decision: 'create' }] }), STALE, StaleTestDraftPreviewError);
    await expectRejected((input) => ({ candidates: [...input.candidates, input.candidates[0]] }), STALE, StaleTestDraftPreviewError);
    await expectRejected((input) => ({ candidates: input.candidates.map((item, index) => (index === 0 ? { ...item, fingerprint: 'deadbeef' } : item)) }), STALE, StaleTestDraftPreviewError);
    await expectRejected(() => ({ candidates: [] }), STALE, StaleTestDraftPreviewError);
  });

  it('쓸 수 없는 판단 · 모두 제외는 거부한다', async () => {
    await expectRejected((input) => ({ candidates: input.candidates.map((item, index) => (index === 0 ? { ...item, decision: 'link_existing' as const } : item)) }), '쓸 수 없는 판단이에요.');
    await expectRejected((input) => ({ candidates: input.candidates.map((item) => ({ ...item, decision: 'excluded' as const })) }), '새로 반영할 TC 초안 또는 연결이 없어요.');
  });
});

describe('미리보기 뒤 데이터가 바뀐 경우(저장하지 않는다)', () => {
  async function staleAfter(change: (data: AppData) => void, message = STALE) {
    const { repos, base } = await open();
    const { input } = await previewOf(repos, { requirementIds: ['req-001'], perspectives: ['normal_flow'] });
    await changeStored(base, repos, change);
    const before = await snapshot(repos, base);
    await expect(repos.testCases.createDraftsFromRequirements(input)).rejects.toThrow(message);
    expect(await snapshot(repos, base)).toEqual(before);
    expect(await draftActivities(repos)).toEqual([]);
  }
  const req001 = (data: AppData) => data.requirements.find((item) => item.id === 'req-001')!;

  it('요구사항 문장이 같은 key 그대로 바뀌면 거부한다', async () => {
    await staleAfter((data) => void (req001(data).text = '이메일만 입력하면 가입할 수 있다.'));
  });

  it('근거 위치 · 근거 유형(확인 필요)이 바뀌면 거부한다', async () => {
    await staleAfter((data) => void (req001(data).sourceRefs = [{ deliverableId: 'dlv-plan-pdf', locator: 'p.77' }]));
    await staleAfter((data) => void (req001(data).needsConfirmation = true));
    await staleAfter((data) => void (req001(data).sourceType = 'ai_suggestion'));
  });

  it('신규였던 후보가 같은 내용의 기존 TC 때문에 중복으로 바뀌면 거부한다', async () => {
    await staleAfter((data) => {
      const [candidate] = produceRuleBasedTestDrafts(
        { project: data.projects.find((item) => item.id === PROJECT_A)!, requirements: data.requirements, deliverables: data.deliverables, testConditions: [], testCases: [], templates: data.templates },
        { requirementIds: ['req-001'], perspectives: ['normal_flow'] },
      ).candidates;
      data.testCases.push(duplicateOf(candidate));
    });
  });

  it('요구사항이 제거되면 요청 자체를 거부한다', async () => {
    await staleAfter((data) => void (req001(data).lifecycle = 'removed'), '제거된 요구사항으로는 초안을 만들 수 없어요.');
  });
});

/** 후보와 같은 내용의 기존 TC */
function duplicateOf(candidate: { perspective: TestPerspective; testCase: { feature: string; title: string; steps: string[]; expectedResult: string } }, overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'tc-existing-same',
    projectId: PROJECT_A,
    externalId: 'SIGN-099',
    category: candidate.perspective,
    feature: candidate.testCase.feature,
    depth: ['회원가입'],
    title: candidate.testCase.title,
    steps: [...candidate.testCase.steps],
    expectedResult: candidate.testCase.expectedResult,
    requirementIds: ['req-old'],
    testConditionIds: ['cond-old'],
    sourceRefs: [{ deliverableId: 'dlv-plan-pdf', locator: 'p.1' }],
    generationType: 'source_explicit',
    origin: 'imported',
    status: 'reviewed',
    revision: 3,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('중복 판단 저장', () => {
  /** req-001 정상 흐름과 같은 내용의 기존 TC가 있는 저장소 */
  async function withDuplicate(overrides: Partial<TestCase> = {}) {
    const seed = createSeed();
    const project = seed.projects.find((item) => item.id === PROJECT_A)!;
    const [candidate] = produceRuleBasedTestDrafts(
      { project, requirements: seed.requirements, deliverables: seed.deliverables, testConditions: [], testCases: [], templates: seed.templates },
      { requirementIds: ['req-001'], perspectives: ['normal_flow'] },
    ).candidates;
    seed.testCases.push(duplicateOf(candidate, overrides));
    const opened = await open(seed);
    return { ...opened, request: { requirementIds: ['req-001'], perspectives: ['normal_flow'] as TestPerspective[] }, key: candidate.key };
  }

  it('판단하지 않은 중복은 저장하지 않는다(요구사항의 연결이 조용히 사라지지 않는다)', async () => {
    const { repos, base, request } = await withDuplicate();
    const before = await snapshot(repos, base);
    const { input, analysis } = await previewOf(repos, request);
    expect(analysis.rows[0]).toMatchObject({ kind: 'duplicate', duplicateTarget: { type: 'existing', id: 'tc-existing-same', label: 'SIGN-099', linked: false } });
    await expect(repos.testCases.createDraftsFromRequirements(input)).rejects.toThrow('판단하지 않은 중복이 1건 있어요.');
    expect(await snapshot(repos, base)).toEqual(before);
  });

  it('기존 TC와 연결: 새 TC는 만들지 않고 기존 TC에 요구사항 · 조건 · 근거 연결만 더하며 내용 · 상태 · 고객사 ID는 그대로다(revision +1)', async () => {
    const { repos, base, request, key } = await withDuplicate();
    const before = await snapshot(repos, base);
    const original = before.testCases.find((item) => item.id === 'tc-existing-same')!;
    const { input } = await previewOf(repos, request, { [key]: 'link_existing' });
    const result = await repos.testCases.createDraftsFromRequirements(input);

    expect(result.testCases).toEqual([]);
    expect(result.summary).toMatchObject({ created: 0, linked: 1 });
    expect(result.testConditions).toHaveLength(1);
    const updated = (await repos.testCases.listByProject(PROJECT_A)).find((item) => item.id === 'tc-existing-same')!;
    expect(updated).toEqual({
      ...original,
      requirementIds: ['req-old', 'req-001'],
      testConditionIds: ['cond-old', result.testConditions[0].id],
      sourceRefs: [
        { deliverableId: 'dlv-plan-pdf', locator: 'p.1' },
        { deliverableId: 'dlv-plan-pdf', locator: 'p.10' },
      ],
      revision: 4,
      updatedAt: expect.any(String),
    });
    expect(updated.updatedAt).not.toBe(original.updatedAt);
    for (const field of ['category', 'feature', 'depth', 'title', 'steps', 'expectedResult', 'generationType', 'origin', 'externalId', 'status'] as const) expect(updated[field]).toEqual(original[field]);
    // 다른 TC는 그대로이고 새 TC는 없다.
    expect((await repos.testCases.listByProject(PROJECT_A)).length).toBe(before.testCases.length);
    expect(updated.status).toBe('reviewed');

    // 활동: 새 TC가 없어도 연결을 기록하고, 만든 TC가 없으므로 링크 대상 ID는 비어 있다.
    const [activity] = await draftActivities(repos);
    expect(activity.title).toBe('기존 TC 1건 연결');
    expect(activity.metadata).toEqual({
      detail: '요구사항 1 · 관점 1 · 신규 TC 0(별도 신규 0) · 기존 TC 연결 1 · 생성 TC 연결 0 · 테스트 조건 신규 1 · 재사용 0 · 중복 제외 0 · 제외 0',
      generatedTestCaseIds: '',
    });
    expect(ready(repos).revision).toBe(before.revision + 1);

    // 연결된 뒤 같은 요청은 이미 연결된 중복이라 반영할 것이 없다(활동이 늘지 않는다).
    const again = await previewOf(repos, request);
    expect(again.analysis.rows[0].duplicateTarget).toMatchObject({ linked: true });
    await expect(repos.testCases.createDraftsFromRequirements(again.input)).rejects.toThrow('새로 반영할 TC 초안 또는 연결이 없어요.');
    expect(await draftActivities(repos)).toHaveLength(1);
  });

  it('별도 신규: 같은 내용이어도 새 TC를 만들고 기존 TC는 바꾸지 않는다', async () => {
    const { repos, base, request, key } = await withDuplicate();
    const original = (await snapshot(repos, base)).testCases.find((item) => item.id === 'tc-existing-same')!;
    const result = await repos.testCases.createDraftsFromRequirements((await previewOf(repos, request, { [key]: 'create_separate' })).input);
    expect(result.testCases).toHaveLength(1);
    expect(result.summary).toMatchObject({ created: 1, separate: 1, linked: 0 });
    expect((await repos.testCases.listByProject(PROJECT_A)).find((item) => item.id === 'tc-existing-same')).toEqual(original);
    const [activity] = await draftActivities(repos);
    expect(activity.title).toBe('TC 초안 1건 생성');
    expect(activity.metadata.detail).toContain('신규 TC 1(별도 신규 1)');
  });

  it('제외: 아무것도 저장하지 않는다(반영할 것이 없으면 거부, 활동 없음)', async () => {
    const { repos, base, request, key } = await withDuplicate();
    const before = await snapshot(repos, base);
    await expect(repos.testCases.createDraftsFromRequirements((await previewOf(repos, request, { [key]: 'excluded' })).input)).rejects.toThrow('새로 반영할 TC 초안 또는 연결이 없어요.');
    expect(await snapshot(repos, base)).toEqual(before);
  });

  it('다른 신규 후보와 함께 중복을 제외하면 신규만 만들고 중복 제외로 센다', async () => {
    const { repos, key } = await withDuplicate();
    const request = { requirementIds: ['req-001', 'req-006'], perspectives: ['normal_flow'] as TestPerspective[] };
    const result = await repos.testCases.createDraftsFromRequirements((await previewOf(repos, request, { [key]: 'excluded' })).input);
    expect(result.testCases.map((item) => item.requirementIds)).toEqual([['req-006']]);
    expect(result.summary).toMatchObject({ created: 1, duplicate: 1, duplicateSkipped: 1 });
    expect((await draftActivities(repos))[0].metadata.detail).toContain('중복 제외 1');
  });

  it('같은 배치의 중복: 뒤 요구사항이 판단 없이 연결을 잃지 않고, 연결하면 앞선 후보의 새 TC에 더해진다', async () => {
    const seed = createSeed();
    // 같은 기능 · 같은 문장의 요구사항 둘(근거 위치만 다르다)
    const copy = (id: string, locator: string): Requirement => ({ ...seed.requirements.find((item) => item.id === 'req-001')!, id, sourceRefs: [{ deliverableId: 'dlv-plan-pdf', locator }] });
    seed.requirements.push(copy('req-dup-1', 'p.31'), copy('req-dup-2', 'p.32'));
    const { repos, base } = await open(seed);
    const request = { requirementIds: ['req-dup-1', 'req-dup-2'], perspectives: ['normal_flow'] as TestPerspective[] };
    const preview = await previewOf(repos, request);
    expect(preview.analysis.rows.map((row) => row.kind)).toEqual(['create', 'duplicate']);
    const before = await snapshot(repos, base);
    await expect(repos.testCases.createDraftsFromRequirements(preview.input)).rejects.toThrow('판단하지 않은 중복이 1건 있어요.');
    expect(await snapshot(repos, base)).toEqual(before);

    const linked = await repos.testCases.createDraftsFromRequirements((await previewOf(repos, request, { 'normal_flow|req-dup-2': 'link_existing' })).input);
    expect(linked.testCases).toHaveLength(1);
    expect(linked.testCases[0]).toMatchObject({ requirementIds: ['req-dup-1', 'req-dup-2'], revision: 1 });
    expect(linked.testCases[0].sourceRefs.map((ref) => ref.locator)).toEqual(['p.31', 'p.32']);
    expect(linked.testCases[0].testConditionIds).toHaveLength(2);
    expect(linked.testConditions).toHaveLength(2);
  });

  it('비교 대상이 미리보기 뒤 바뀌면 거부한다: 다른 TC로 바뀜 · 폐기 · 연결이 달라짐', async () => {
    for (const change of [
      (data: AppData) => void (data.testCases.find((item) => item.id === 'tc-existing-same')!.status = 'deprecated'),
      (data: AppData) => void (data.testCases.find((item) => item.id === 'tc-existing-same')!.requirementIds = ['req-001']),
      (data: AppData) => void (data.testCases.find((item) => item.id === 'tc-existing-same')!.title = '제목이 바뀜'),
      (data: AppData) => void (data.testCases.find((item) => item.id === 'tc-existing-same')!.id = 'tc-other-same'),
    ]) {
      const { repos, base, request, key } = await withDuplicate();
      const { input } = await previewOf(repos, request, { [key]: 'link_existing' });
      await changeStored(base, repos, change);
      const before = await snapshot(repos, base);
      await expect(repos.testCases.createDraftsFromRequirements(input)).rejects.toThrow(STALE);
      expect(await snapshot(repos, base)).toEqual(before);
    }
  });

  it('다른 프로젝트의 같은 내용 TC · 폐기된 TC는 비교 대상이 아니라 신규다(연결할 수 없다)', async () => {
    for (const overrides of [{ projectId: PROJECT_B }, { status: 'deprecated' as const }]) {
      const { repos, request } = await withDuplicate(overrides);
      const { analysis } = await previewOf(repos, request);
      expect(analysis.rows[0].kind).toBe('create');
    }
  });

  it('연결 도중 저장에 실패하면 기존 TC · 조건 · 활동 · revision이 모두 그대로이고, 다시 시도하면 한 번만 연결한다', async () => {
    const { repos, base, request, key, failNext } = await withDuplicate();
    const before = await snapshot(repos, base);
    const { input } = await previewOf(repos, request, { [key]: 'link_existing' });
    failNext();
    await expect(repos.testCases.createDraftsFromRequirements(input)).rejects.toBeInstanceOf(PersistenceError);
    expect(await snapshot(repos, base)).toEqual(before);
    await repos.testCases.createDraftsFromRequirements(input);
    expect((await repos.testCases.listByProject(PROJECT_A)).find((item) => item.id === 'tc-existing-same')!.revision).toBe(4);
    expect(await draftActivities(repos)).toHaveLength(1);
  });
});

describe('TC 양식 확인(저장하지 않는다)', () => {
  async function expectTemplateRejected(change: (data: AppData) => void, message: string) {
    const seed = createSeed();
    change(seed);
    const { repos, base } = await open(seed);
    const before = await snapshot(repos, base);
    // 화면과 같은 방법으로 미리보기를 만들 수 없으므로(양식이 맞지 않으면 분석이 거부한다) 올바른 양식 데이터로 만든 입력을 보낸다.
    const valid = await open();
    const { input } = await previewOf(valid.repos, { requirementIds: ['req-001'], perspectives: ['normal_flow'] });
    await expect(repos.testCases.createDraftsFromRequirements(input)).rejects.toThrow(message);
    expect(await snapshot(repos, base)).toEqual(before);
    expect(await draftActivities(repos)).toEqual([]);
  }

  it('프로젝트의 양식 ID가 없는 양식이면 거부한다', async () => {
    await expectTemplateRejected((data) => void (data.projects.find((item) => item.id === PROJECT_A)!.tcTemplateId = 'tpl-missing'), '프로젝트의 TC 양식을 찾을 수 없어요. (tpl-missing)');
  });

  it('다른 프로젝트 전용 양식이면 거부한다', async () => {
    await expectTemplateRejected((data) => void (data.templates.find((item) => item.id === 'tpl-client-a')!.projectId = PROJECT_B), '다른 프로젝트의 TC 양식은 쓸 수 없어요.');
  });

  it('프로젝트가 정해지지 않은 공용 양식이나 양식이 없는 프로젝트는 만들 수 있다', async () => {
    for (const change of [
      (data: AppData) => void delete (data.templates.find((item) => item.id === 'tpl-client-a') as { projectId?: string }).projectId,
      (data: AppData) => void delete (data.projects.find((item) => item.id === PROJECT_A) as { tcTemplateId?: string }).tcTemplateId,
    ]) {
      const seed = createSeed();
      change(seed);
      const { repos } = await open(seed);
      const result = await repos.testCases.createDraftsFromRequirements((await previewOf(repos, { requirementIds: ['req-001'], perspectives: ['normal_flow'] })).input);
      const templateId = seed.projects.find((item) => item.id === PROJECT_A)!.tcTemplateId;
      if (templateId) expect(result.testCases[0].templateId).toBe(templateId);
      else expect(result.testCases[0]).not.toHaveProperty('templateId');
    }
  });
});

describe('확인 필요 TC의 상태 보호(저장소 경계)', () => {
  it('확인 필요 TC는 초안이든 재검토 필요든 검토 완료 · 사용 중으로 바꿀 수 없고, 저장 상태 · revision은 그대로다', async () => {
    const seed = createSeed();
    seed.testCases.find((item) => item.id === 'tc-015')!.status = 'needs_review';
    const { repos, base } = await open(seed);
    const before = await snapshot(repos, base);
    for (const id of ['tc-010', 'tc-015']) {
      for (const status of ['reviewed', 'active'] as const) {
        await expect(repos.testCases.updateStatus(id, status)).rejects.toThrow('확인 필요 TC는 확인사항이 답변되기 전에는 검토 완료로 표시할 수 없어요.');
      }
    }
    expect(await snapshot(repos, base)).toEqual(before);
    // 초안으로 되돌리거나 폐기는 막지 않는다.
    expect((await repos.testCases.updateStatus('tc-015', 'draft')).status).toBe('draft');
    expect((await repos.testCases.updateStatus('tc-010', 'deprecated')).status).toBe('deprecated');
  });

  it('외부 생산자가 source_explicit이라고 보낸 확인 필요 요구사항의 후보도 확인 필요 TC가 되어 검토 완료 · 사용 중으로 바꿀 수 없다', async () => {
    const seed = createSeed();
    const { context } = await previewOf((await open(createSeed())).repos, { requirementIds: ['req-004'], perspectives: ['normal_flow'] });
    const [ruleBased] = produceRuleBasedTestDrafts(context, { requirementIds: ['req-004'], perspectives: ['normal_flow'] }).candidates;
    const candidate = { ...ruleBased, generationType: 'source_explicit' as const, testCase: { ...ruleBased.testCase, expectedResult: '가입 화면이 열린다.' } };
    const analysis = analyzeTestDraftCandidates(context, [candidate], [], { requirementCount: 1, perspectiveCount: 1 });
    const planned = planTestDraftGeneration(context, analysis, toTestDraftDecisionInputs(analysis), { createId: (prefix) => `${prefix}-external`, now: '2026-10-05T00:00:00.000Z' });
    expect(planned.testCases[0]).toMatchObject({ id: 'tc-external', generationType: 'needs_confirmation', expectedResult: '확인 필요 — 가입 화면이 열린다.' });
    seed.testConditions.push(...planned.testConditions);
    seed.testCases.push(...planned.testCases);
    const { repos, base } = await open(seed);
    const before = await snapshot(repos, base);
    for (const status of ['reviewed', 'active'] as const) {
      await expect(repos.testCases.updateStatus('tc-external', status)).rejects.toThrow('확인 필요 TC는 확인사항이 답변되기 전에는 검토 완료로 표시할 수 없어요.');
    }
    expect(await snapshot(repos, base)).toEqual(before);
  });

  it('일반 TC는 재검토 필요 → 검토 완료가 그대로 가능하다', async () => {
    const seed = createSeed();
    seed.testCases.find((item) => item.id === 'tc-001')!.status = 'needs_review';
    const { repos } = await open(seed);
    expect((await repos.testCases.updateStatus('tc-001', 'reviewed')).status).toBe('reviewed');
    expect((await repos.testCases.updateStatus('tc-002', 'reviewed')).status).toBe('reviewed');
  });

  it('변경 영향 분석으로 재검토 필요가 된 확인 필요 TC도 검토 완료로 바꿀 수 없다', async () => {
    const seed = createSeed();
    seed.testCases.find((item) => item.id === 'tc-002')!.generationType = 'needs_confirmation';
    const { repos, base } = await open(seed);
    const analysisId = 'cia-plan-v15';
    for (const id of ['rc-001', 'rc-002', 'rc-003']) await repos.changeAnalyses.updateRequirementDecision(analysisId, id, 'accepted');
    for (const id of ['ti-001', 'ti-002', 'ti-003', 'ti-004', 'ti-006']) await repos.changeAnalyses.updateTestImpactDecision(analysisId, id, 'accepted');
    await repos.changeAnalyses.resolveDuplicate(analysisId, 'ti-007', 'modify_existing');
    await repos.changeAnalyses.markReviewed(analysisId);
    await repos.changeAnalyses.apply(analysisId);
    const target = (await repos.testCases.listByProject(PROJECT_A)).find((item) => item.id === 'tc-002')!;
    expect(target).toMatchObject({ status: 'needs_review', generationType: 'needs_confirmation' });
    const before = await snapshot(repos, base);
    await expect(repos.testCases.updateStatus('tc-002', 'reviewed')).rejects.toThrow('확인 필요 TC는');
    expect(await snapshot(repos, base)).toEqual(before);
  });
});
