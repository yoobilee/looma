import { describe, expect, it } from 'vitest';
import { analyzeTestDraftGeneration, produceRuleBasedTestDrafts, toTestDraftDecisionInputs, type TestDraftContext, type TestDraftDecision } from '@/domain/testDraftGeneration';
import type { TestCase, TestCondition, TestPerspective } from '@/domain/types';
import { PersistenceError } from '../persistenceError';
import type { CreateTestDraftsInput, PersistenceStatus, Repositories } from '../repositories/types';
import { createSeed, PROJECT_A } from '../mock/seed';
import type { AppData, StoredAppState } from './appData';
import { createLocalRepositories } from './localRepositories';
import { createMemoryStateStore, type StateStore } from './stateStore';

/*
 * 미리보기 뒤 저장될 결과가 달라지는 변경(양식 · 테스트 조건 재사용 · 연결할 기존 TC의 내용)이 있으면 저장을 거부한다.
 * 거부에서 조건 · TC · 활동 · 저장 상태 · revision · 메모리는 모두 그대로이고, 그대로면 연결되며, 연결과 신규를 함께 쓰다 실패해도 되돌린다.
 */

const STALE = '요구사항이나 기존 TC가 바뀌어 미리보기를 다시 확인해 주세요.';
const REQUEST = { requirementIds: ['req-001'], perspectives: ['normal_flow'] as TestPerspective[] };
const KEY = 'normal_flow|req-001';

function failingOnce(base: StateStore) {
  let fail = false;
  const store: StateStore = { ...base, commit: async (input) => (fail ? ((fail = false), Promise.reject(new Error('write failed'))) : base.commit(input)) };
  return { store, failNext: () => (fail = true) };
}

const stored = (store: ReturnType<typeof createMemoryStateStore>) => structuredClone(store.inspect().state as StoredAppState & { data: AppData });
const ready = (repos: Repositories) => repos.persistence.getStatus() as Extract<PersistenceStatus, { state: 'ready' }>;

/** req-001 정상 흐름 후보와 같은 내용의 기존 TC(요구사항 연결 없음, 사전 조건 session A)를 만든다. */
function duplicateOfReq001(data: AppData, overrides: Partial<TestCase> = {}): TestCase {
  const project = data.projects.find((item) => item.id === PROJECT_A)!;
  const [candidate] = produceRuleBasedTestDrafts(
    { project, requirements: data.requirements, deliverables: data.deliverables, testConditions: [], testCases: [], templates: data.templates },
    REQUEST,
  ).candidates;
  return {
    id: 'tc-existing-same',
    projectId: PROJECT_A,
    externalId: 'SIGN-099',
    category: 'normal_flow',
    feature: candidate.testCase.feature,
    depth: ['회원가입'],
    title: candidate.testCase.title,
    precondition: 'session A',
    steps: candidate.testCase.steps,
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

/** 양식 B를 가진 저장소. withDuplicate면 중복 대상 TC도 있다. */
async function open({ withDuplicate = false, tcTemplateId }: { withDuplicate?: boolean; tcTemplateId?: string | null } = {}) {
  const seed = createSeed();
  seed.templates.push({ ...seed.templates[0], id: 'tpl-b', projectId: PROJECT_A, name: '양식 B' });
  if (tcTemplateId !== undefined) {
    const project = seed.projects.find((item) => item.id === PROJECT_A)!;
    if (tcTemplateId === null) delete project.tcTemplateId;
    else project.tcTemplateId = tcTemplateId;
  }
  if (withDuplicate) seed.testCases.push(duplicateOfReq001(seed));
  const base = createMemoryStateStore();
  const { store, failNext } = failingOnce(base);
  const repos = createLocalRepositories({ openStore: async () => store, createInitialData: () => seed });
  await repos.persistence.load();
  return { repos, base, failNext };
}

async function previewOf(repos: Repositories, decisions: Record<string, TestDraftDecision> = {}, request = REQUEST): Promise<CreateTestDraftsInput> {
  const project = (await repos.projects.get(PROJECT_A))!;
  const context: TestDraftContext = {
    project,
    requirements: await repos.requirements.listByProject(PROJECT_A),
    deliverables: await repos.deliverables.listByProject(PROJECT_A),
    testConditions: await repos.testConditions.listByProject(PROJECT_A),
    testCases: await repos.testCases.listByProject(PROJECT_A),
    templates: project.tcTemplateId ? [(await repos.templates.get(project.tcTemplateId))!].filter(Boolean) : [],
  };
  return { projectId: PROJECT_A, ...request, candidates: toTestDraftDecisionInputs(analyzeTestDraftGeneration(context, request), decisions) };
}

async function changeStored(base: ReturnType<typeof createMemoryStateStore>, repos: Repositories, change: (data: AppData) => void) {
  const current = stored(base);
  change(current.data);
  await base.commit({ expectedRevision: current.revision, schemaVersion: current.schemaVersion, savedAt: current.savedAt, data: current.data });
  await repos.persistence.reloadLatest();
}

const snapshot = async (repos: Repositories, base: ReturnType<typeof createMemoryStateStore>) => ({
  state: stored(base),
  testCases: await repos.testCases.listByProject(PROJECT_A),
  conditions: await repos.testConditions.listByProject(PROJECT_A),
  activities: await repos.activities.list(),
  revision: ready(repos).revision,
});

/** 미리보기 뒤 저장소가 바뀌면 거부되고 아무것도 저장되지 않는다. */
async function expectStale(setup: Parameters<typeof open>[0], decisions: Record<string, TestDraftDecision>, change: (data: AppData) => void) {
  const { repos, base } = await open(setup);
  const input = await previewOf(repos, decisions);
  await changeStored(base, repos, change);
  const before = await snapshot(repos, base);
  await expect(repos.testCases.createDraftsFromRequirements(input)).rejects.toThrow(STALE);
  expect(await snapshot(repos, base)).toEqual(before);
  expect((await repos.activities.list()).filter((item) => item.type === 'test_drafts_generated')).toEqual([]);
}

const project = (data: AppData) => data.projects.find((item) => item.id === PROJECT_A)!;
const matchingCondition = (data: AppData, overrides: Partial<TestCondition> = {}): TestCondition => {
  const [candidate] = produceRuleBasedTestDrafts(
    { project: project(data), requirements: data.requirements, deliverables: data.deliverables, testConditions: [], testCases: [], templates: data.templates },
    REQUEST,
  ).candidates;
  return { id: 'cond-new', projectId: PROJECT_A, requirementIds: ['req-001'], feature: candidate.condition.feature, title: candidate.condition.title, status: 'active', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...overrides };
};

describe('양식이 미리보기 뒤 바뀐 경우(저장하지 않는다)', () => {
  it('양식 A → B', async () => {
    await expectStale({}, {}, (data) => void (project(data).tcTemplateId = 'tpl-b'));
  });
  it('양식 A → 없음', async () => {
    await expectStale({}, {}, (data) => void delete (project(data) as { tcTemplateId?: string }).tcTemplateId);
  });
  it('양식 없음 → A', async () => {
    await expectStale({ tcTemplateId: null }, {}, (data) => void (project(data).tcTemplateId = 'tpl-client-a'));
  });
  it('바뀌지 않았으면 미리보기 때의 양식이 붙는다', async () => {
    const { repos } = await open({ tcTemplateId: 'tpl-b' });
    const result = await repos.testCases.createDraftsFromRequirements(await previewOf(repos));
    expect(result.testCases[0].templateId).toBe('tpl-b');
  });
});

describe('테스트 조건 재사용이 미리보기 뒤 바뀐 경우(저장하지 않는다)', () => {
  it('신규 후보: 새 조건이 필요했는데 같은 조건이 생김', async () => {
    await expectStale({}, {}, (data) => void data.testConditions.push(matchingCondition(data)));
  });

  it('신규 후보: 재사용하기로 한 조건이 폐기됨 · 사라짐 · 다른 ID로 바뀜', async () => {
    for (const change of [
      (data: AppData) => void (data.testConditions.find((item) => item.id === 'cond-new')!.status = 'deprecated'),
      (data: AppData) => void (data.testConditions = data.testConditions.filter((item) => item.id !== 'cond-new')),
      (data: AppData) => void (data.testConditions.find((item) => item.id === 'cond-new')!.id = 'cond-replaced'),
    ]) {
      const seeded = createSeed();
      const { repos, base } = await open();
      // 미리보기 전에 같은 조건이 있는 상태로 만든다.
      await changeStored(base, repos, (data) => void data.testConditions.push(matchingCondition(seeded)));
      const input = await previewOf(repos);
      expect(input.candidates[0]).toMatchObject({ key: KEY });
      await changeStored(base, repos, change);
      const before = await snapshot(repos, base);
      await expect(repos.testCases.createDraftsFromRequirements(input)).rejects.toThrow(STALE);
      expect(await snapshot(repos, base)).toEqual(before);
    }
  });

  it('중복 후보: 새 조건이 필요했는데 같은 조건이 생김(연결 판단)', async () => {
    await expectStale({ withDuplicate: true }, { [KEY]: 'link_existing' }, (data) => void data.testConditions.push(matchingCondition(data)));
  });
});

describe('연결할 기존 TC의 내용이 미리보기 뒤 바뀐 경우', () => {
  const target = (data: AppData) => data.testCases.find((item) => item.id === 'tc-existing-same')!;

  it('사전 조건이 바뀌면(revision이 올라도, 올라가지 않아도) 연결을 거부한다', async () => {
    await expectStale({ withDuplicate: true }, { [KEY]: 'link_existing' }, (data) => {
      target(data).precondition = 'session B';
      target(data).revision = 4;
    });
    await expectStale({ withDuplicate: true }, { [KEY]: 'link_existing' }, (data) => void (target(data).precondition = 'session B'));
  });

  it('Depth · 근거 · 요구사항 연결 · 조건 연결이 바뀌어도 거부한다', async () => {
    for (const change of [
      (data: AppData) => void (target(data).depth = ['다른 분류']),
      (data: AppData) => void (target(data).sourceRefs = [{ deliverableId: 'dlv-plan-pdf', locator: 'p.99' }]),
      (data: AppData) => void (target(data).requirementIds = ['req-old', 'req-z']),
      (data: AppData) => void (target(data).testConditionIds = ['cond-old', 'cond-z']),
    ]) {
      await expectStale({ withDuplicate: true }, { [KEY]: 'link_existing' }, change);
    }
  });

  it('revision만 올라가도 · 상태가 바뀌어도 거부한다', async () => {
    await expectStale({ withDuplicate: true }, { [KEY]: 'link_existing' }, (data) => void (target(data).revision = 4));
    await expectStale({ withDuplicate: true }, { [KEY]: 'link_existing' }, (data) => void (target(data).status = 'needs_review'));
  });

  it('바뀌지 않았으면 연결되고 기존 TC의 revision이 정확히 +1이다', async () => {
    const { repos, base } = await open({ withDuplicate: true });
    const before = await snapshot(repos, base);
    const result = await repos.testCases.createDraftsFromRequirements(await previewOf(repos, { [KEY]: 'link_existing' }));
    expect(result.testCases).toEqual([]);
    const updated = (await repos.testCases.listByProject(PROJECT_A)).find((item) => item.id === 'tc-existing-same')!;
    expect(updated).toMatchObject({ revision: 4, precondition: 'session A', status: 'reviewed', requirementIds: ['req-old', 'req-001'] });
    expect((await repos.testCases.listByProject(PROJECT_A)).length).toBe(before.testCases.length);
  });
});

describe('신규 TC와 기존 TC 연결을 함께 쓰다 실패하면', () => {
  it('모두 되돌리고, 다시 시도하면 한 번만 반영하며 기존 TC의 revision이 정확히 +1이다', async () => {
    const { repos, base, failNext } = await open({ withDuplicate: true });
    const request = { requirementIds: ['req-001', 'req-006'], perspectives: ['normal_flow'] as TestPerspective[] };
    const before = await snapshot(repos, base);
    const input = await previewOf(repos, { [KEY]: 'link_existing' }, request);

    failNext();
    await expect(repos.testCases.createDraftsFromRequirements(input)).rejects.toBeInstanceOf(PersistenceError);
    expect(await snapshot(repos, base)).toEqual(before);

    const result = await repos.testCases.createDraftsFromRequirements(input);
    expect(result.testCases).toHaveLength(1);
    expect(result.updatedTestCases).toHaveLength(1);
    const after = await repos.testCases.listByProject(PROJECT_A);
    expect(after.find((item) => item.id === 'tc-existing-same')!.revision).toBe(4);
    expect(after.length).toBe(before.testCases.length + 1);
    const activities = (await repos.activities.list()).filter((item) => item.type === 'test_drafts_generated');
    expect(activities).toHaveLength(1);
    expect(activities[0].title).toBe('TC 초안 1건 생성 · 기존 TC 1건 연결');
    expect(activities[0].metadata.detail).toContain('신규 TC 1(별도 신규 0) · 기존 TC 연결 1 · 생성 TC 연결 0');
    expect(ready(repos).revision).toBe(before.revision + 1);

    // 성공한 뒤 같은 입력을 다시 보내면 미리보기가 오래된 것이라 거부하고 기존 TC는 한 번만 올라간 채다.
    await expect(repos.testCases.createDraftsFromRequirements(input)).rejects.toThrow(STALE);
    expect((await repos.testCases.listByProject(PROJECT_A)).find((item) => item.id === 'tc-existing-same')!.revision).toBe(4);
  });
});
