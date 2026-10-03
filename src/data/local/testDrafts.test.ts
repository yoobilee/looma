import { describe, expect, it } from 'vitest';
import { activityLinkLabel, activityLinkPath } from '@/domain/activityRecords';
import { testDraftCandidateKey, TestDraftGenerationError } from '@/domain/testDraftGeneration';
import type { TestPerspective } from '@/domain/types';
import { PersistenceError } from '../persistenceError';
import type { CreateTestDraftsInput, PersistenceStatus, Repositories } from '../repositories/types';
import { createSeed, PROJECT_A, PROJECT_B } from '../mock/seed';
import type { AppData, StoredAppState } from './appData';
import { createLocalRepositories } from './localRepositories';
import { createMemoryStateStore, type StateStore } from './stateStore';

/*
 * 요구사항 기반 TC 초안 생성 저장. 현재 데이터로 다시 계산해 테스트 조건 · TC 초안을 만들고, 활동 기록도 같은 저장에 남긴다.
 * 입력이 맞지 않거나 · 만들 후보가 없거나 · 저장에 실패하면 조건 · TC · 활동 · 저장 상태 · revision이 모두 그대로다.
 * 스키마 · 저장 구조는 그대로라 migration 없이 현재 버전 데이터에 쓴다.
 */

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

const input = (overrides: Partial<CreateTestDraftsInput> = {}): CreateTestDraftsInput => ({
  projectId: PROJECT_A,
  requirementIds: ['req-001', 'req-002'],
  perspectives: ['normal_flow', 'boundary'] as TestPerspective[],
  excludedKeys: [],
  ...overrides,
});

describe('요구사항 기반 TC 초안 저장', () => {
  it('테스트 조건 · TC 초안을 만들고 요구사항 · 조건 · 근거 · 템플릿을 연결하며, 같은 저장에 활동 하나를 남긴다', async () => {
    const { repos, base } = await open();
    const before = await snapshot(repos, base);

    // req-001: 정상 흐름만(경계값 단서 없음), req-002: 정상 흐름 + 경계값 → 3건, 제외 1건
    const result = await repos.testCases.createDraftsFromRequirements(input({ excludedKeys: [testDraftCandidateKey('boundary', ['req-002'])] }));

    expect(result.summary).toEqual({ requirementCount: 2, perspectiveCount: 2, created: 2, needsConfirmation: 0, duplicate: 0, invalid: 0, excluded: 1, skipped: 1 });
    expect(result.testCases).toHaveLength(2);
    expect(result.testConditions).toHaveLength(2);
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
    // 조건 ID가 실제 새 조건을 가리킨다.
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
        detail: '요구사항 2 · 관점 2 · 신규 TC 2 · 테스트 조건 신규 2 · 재사용 0 · 중복 0 · 제외 1',
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

  it('이미 있는 같은 테스트 조건은 다시 쓰고 수정하지 않으며, 같은 내용의 TC가 이미 있으면 만들지 않는다', async () => {
    const seed = createSeed();
    const { repos } = await open(seed);
    const first = await repos.testCases.createDraftsFromRequirements(input({ requirementIds: ['req-001'], perspectives: ['normal_flow'] }));
    const conditionsAfterFirst = await repos.testConditions.listByProject(PROJECT_A);

    // 같은 요구사항 · 관점으로 다시 만들면 TC가 모두 중복이라 만들 것이 없다.
    await expect(repos.testCases.createDraftsFromRequirements(input({ requirementIds: ['req-001'], perspectives: ['normal_flow'] }))).rejects.toThrow('만들 수 있는 새 TC 초안이 없어요.');
    expect(await repos.testConditions.listByProject(PROJECT_A)).toEqual(conditionsAfterFirst);
    expect(await draftActivities(repos)).toHaveLength(1);

    // 첫 TC를 폐기하면 같은 내용을 다시 만들 수 있고, 조건은 재사용한다.
    await repos.testCases.updateStatus(first.testCases[0].id, 'deprecated');
    const again = await repos.testCases.createDraftsFromRequirements(input({ requirementIds: ['req-001'], perspectives: ['normal_flow'] }));
    expect(again.testConditions).toEqual([]);
    expect(again.testCases[0].testConditionIds).toEqual(first.testCases[0].testConditionIds);
    expect(again.summary).toMatchObject({ created: 1, duplicate: 0 });
    expect(await repos.testConditions.listByProject(PROJECT_A)).toEqual(conditionsAfterFirst);
    const [latest] = await draftActivities(repos);
    expect(latest.metadata.detail).toBe('요구사항 1 · 관점 1 · 신규 TC 1 · 테스트 조건 신규 0 · 재사용 1 · 중복 0 · 제외 0');
  });

  it('확인 필요 요구사항은 needs_confirmation 초안으로 만들고 조건은 재검토 필요 상태다', async () => {
    const { repos } = await open();
    const result = await repos.testCases.createDraftsFromRequirements(input({ requirementIds: ['req-004'], perspectives: ['normal_flow'] }));
    expect(result.testCases[0]).toMatchObject({ generationType: 'needs_confirmation', status: 'draft' });
    expect(result.testConditions[0].status).toBe('needs_review');
    expect(result.summary.needsConfirmation).toBe(1);
  });

  it.each([
    ['없는 프로젝트', (): Partial<CreateTestDraftsInput> => ({ projectId: 'proj-missing' }), '프로젝트'],
    ['없는 요구사항', () => ({ requirementIds: ['req-missing'] }), '요구사항을 찾을 수 없어요'],
    ['제거된 요구사항', () => ({ requirementIds: ['req-013'] }), '제거된 요구사항으로는 초안을 만들 수 없어요.'],
    ['빈 요구사항 목록', () => ({ requirementIds: [] }), '요구사항을 하나 이상 골라 주세요.'],
    ['빈 관점 목록', () => ({ perspectives: [] }), '테스트 관점을 하나 이상 골라 주세요.'],
    ['알 수 없는 관점', () => ({ perspectives: ['hacked' as TestPerspective] }), '알 수 없는 테스트 관점이에요.'],
    ['프로젝트 범위에 없는 관점', () => ({ perspectives: ['api'] as TestPerspective[] }), '테스트 범위에 없는 관점이에요.'],
    ['없는 후보 제외', () => ({ excludedKeys: ['boundary|req-999'] }), '제외할 수 있는 TC 초안 후보가 아니에요.'],
    ['같은 후보 두 번 제외', () => ({ excludedKeys: ['boundary|req-002', 'boundary|req-002'] }), '같은 후보를 제외 목록에 두 번 넣었어요.'],
    ['모두 제외', () => ({ excludedKeys: ['normal_flow|req-001', 'normal_flow|req-002', 'boundary|req-002'] }), '만들 수 있는 새 TC 초안이 없어요.'],
    ['만들 후보가 없는 조합', () => ({ requirementIds: ['req-001'], perspectives: ['boundary'] as TestPerspective[] }), '만들 수 있는 새 TC 초안이 없어요.'],
  ])('%s → 거부하고 조건 · TC · 활동 · 저장 상태 · revision이 그대로다', async (_, overrides, message) => {
    const { repos, base } = await open();
    const before = await snapshot(repos, base);
    const attempt = repos.testCases.createDraftsFromRequirements(input(overrides()));
    await expect(attempt).rejects.toThrow(message);
    expect(await snapshot(repos, base)).toEqual(before);
  });

  it('다른 프로젝트의 요구사항은 거부한다', async () => {
    const seed = createSeed();
    seed.requirements.push({ ...seed.requirements[0], id: 'req-b-1', projectId: PROJECT_B });
    const { repos, base } = await open(seed);
    const before = await snapshot(repos, base);
    await expect(repos.testCases.createDraftsFromRequirements(input({ requirementIds: ['req-b-1'] }))).rejects.toThrow('이 프로젝트에서 요구사항을 찾을 수 없어요. (req-b-1)');
    expect(await snapshot(repos, base)).toEqual(before);
  });

  it('요구사항이 제거된 뒤 오래된 요청은 거부한다(미리보기 뒤 바뀐 상태를 믿지 않는다)', async () => {
    const seed = createSeed();
    const { repos, base } = await open(seed);
    // 화면에서는 req-006을 고를 수 있었지만 그 사이 제거됐다.
    const stored1 = stored(base);
    stored1.data.requirements.find((item) => item.id === 'req-006')!.lifecycle = 'removed';
    await base.commit({ expectedRevision: stored1.revision, schemaVersion: stored1.schemaVersion, savedAt: stored1.savedAt, data: stored1.data });
    await repos.persistence.reloadLatest();
    const before = await snapshot(repos, base);
    await expect(repos.testCases.createDraftsFromRequirements(input({ requirementIds: ['req-006'], perspectives: ['normal_flow'] }))).rejects.toBeInstanceOf(TestDraftGenerationError);
    expect(await snapshot(repos, base)).toEqual(before);
  });

  it('저장에 실패하면 조건 · TC · 활동 · 저장 상태 · revision이 저장소와 메모리 모두 그대로이고, 다시 시도하면 한 번만 만든다', async () => {
    const { repos, base, failNext } = await open();
    const before = await snapshot(repos, base);

    failNext();
    await expect(repos.testCases.createDraftsFromRequirements(input())).rejects.toBeInstanceOf(PersistenceError);
    expect(await snapshot(repos, base)).toEqual(before);
    expect(await draftActivities(repos)).toEqual([]);

    const retry = await repos.testCases.createDraftsFromRequirements(input());
    expect(retry.summary).toMatchObject({ created: 3 });
    expect(ready(repos).revision).toBe(before.revision + 1);
    expect(await draftActivities(repos)).toHaveLength(1);
    expect((await repos.testCases.listByProject(PROJECT_A)).length).toBe(before.testCases.length + 3);

    // 성공한 뒤 같은 요청을 또 보내도 모두 중복이라 만들지 않고 활동도 늘지 않는다.
    await expect(repos.testCases.createDraftsFromRequirements(input())).rejects.toThrow('만들 수 있는 새 TC 초안이 없어요.');
    expect(await draftActivities(repos)).toHaveLength(1);
  });

  it('입력을 바꾸지 않고, 새로고침(저장소 다시 열기) 뒤에도 만든 항목과 활동이 남는다', async () => {
    const base = createMemoryStateStore();
    const first = createLocalRepositories({ openStore: async () => base, createInitialData: createSeed });
    await first.persistence.load();
    const request = input();
    const copyOfRequest = structuredClone(request);
    const result = await first.testCases.createDraftsFromRequirements(request);
    expect(request).toEqual(copyOfRequest);

    const reopened = createLocalRepositories({ openStore: async () => base });
    await reopened.persistence.load();
    const reloaded = await reopened.testCases.listByProject(PROJECT_A);
    expect(reloaded.filter((item) => result.testCases.some((created) => created.id === item.id))).toEqual(result.testCases);
    expect(await draftActivities(reopened)).toHaveLength(1);
  });
});
