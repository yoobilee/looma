import { describe, expect, it } from 'vitest';
import { laterResultsFor } from '@/domain/issues';
import { compareResultRounds } from '@/domain/resultComparison';
import type { Issue } from '@/domain/types';
import { PersistenceError } from '../persistenceError';
import type { PersistenceStatus, Repositories } from '../repositories/types';
import { importQaRound, legacyV1State, QA_TEST_CASE_ID, qaScenarioSeed } from '../mock/issueScenario';
import { createSeed, PROJECT_A } from '../mock/seed';
import { CURRENT_SCHEMA_VERSION, type AppData, type StoredAppState } from './appData';
import { createLocalRepositories, type LocalRepositoryOptions } from './localRepositories';
import { migrateAppData, migrateV1ToV2 } from './migrations';
import { createMemoryChannelHub } from './stateChannel';
import { createMemoryStateStore, type StateStore } from './stateStore';

/* ---------- 준비 ---------- */

async function openTab(store: StateStore, options: Partial<LocalRepositoryOptions> = {}) {
  const repos = createLocalRepositories({ openStore: async () => store, ...options });
  await repos.persistence.load();
  return repos;
}

const ready = (repos: Repositories) => repos.persistence.getStatus() as Extract<PersistenceStatus, { state: 'ready' }>;
const storedState = async (store: StateStore) => (await store.read()) as StoredAppState & { data: AppData };

/** 다음 commit 한 번만 실패시키는 저장소. 실패한 쓰기는 IndexedDB transaction abort처럼 아무것도 남기지 않는다. */
function failingOnce(base: StateStore) {
  let fail = false;
  const store: StateStore = { ...base, commit: async (input) => (fail ? ((fail = false), Promise.reject(new Error('write failed'))) : base.commit(input)) };
  return { store, failNext: () => (fail = true) };
}

// 예시 데이터(2차)의 결과
const FAIL_RESULT = 'imp-a-2-SIGN-002-ios';
const BLOCKED_RESULT = 'imp-a-2-LOGIN-018-android';
const PASS_RESULT = 'imp-a-2-SIGN-001-android';

/** 저장된 v1 데이터. 엔티티 모양이 현재 타입과 달라 레코드로 다룬다. */
type LegacyData = { issues: Record<string, unknown>[]; results: Record<string, unknown>[] };
const legacyData = () => legacyV1State().data as LegacyData;

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

/* ---------- v1 → v2 변환 ---------- */

describe('v1 → v2 변환(이슈 · 확인사항 추적)', () => {
  it('이슈 상태를 확인 필요 · 해결됨으로 바꾸고, updatedAt은 createdAt으로 채우며 해결 시각은 만들지 않는다', () => {
    const legacy = legacyV1State().data as AppData;
    const migrated = migrateV1ToV2(legacy) as AppData;
    const statusOf = (id: string) => migrated.issues.find((issue) => issue.id === id)!;
    // open · waiting · checking → open, closed · answered → resolved
    expect(['issue-bug-014', 'issue-bug-015', 'issue-q-login-limit', 'issue-q-terms'].map((id) => statusOf(id).status)).toEqual(['open', 'open', 'open', 'open']);
    expect(['issue-bug-011', 'issue-q-push'].map((id) => statusOf(id).status)).toEqual(['resolved', 'resolved']);
    for (const issue of migrated.issues) {
      expect(issue.updatedAt).toBe(issue.createdAt);
      expect(issue).not.toHaveProperty('resolvedAt');
    }
  });

  it('수정됨(fixed)은 QA 재확인 전이라 확인 필요로 둔다', () => {
    const legacy = legacyData();
    legacy.issues[0].status = 'fixed';
    expect((migrateV1ToV2(legacy) as AppData).issues[0].status).toBe('open');
  });

  it('결과의 issueId를 이슈의 resultId로 옮기고 결과에서는 지운다', () => {
    const migrated = migrateV1ToV2(legacyV1State().data) as AppData;
    expect(migrated.issues.find((issue) => issue.id === 'issue-bug-014')).toMatchObject({ resultId: FAIL_RESULT, testCaseId: 'tc-002' });
    expect(migrated.issues.find((issue) => issue.id === 'issue-bug-015')).toMatchObject({ resultId: 'imp-a-2-LOGIN-019-android', testCaseId: 'tc-011' });
    expect(migrated.results.some((result) => 'issueId' in result)).toBe(false);
    expect(migrated.issues.filter((issue) => issue.resultId)).toHaveLength(2);
  });

  it('한 이슈를 여러 결과가 가리키거나, 프로젝트 · TC가 어긋나면 결과를 고르지 않고 연결하지 않는다', () => {
    const legacy = legacyData();
    // BUG-014를 iOS · Android 결과가 함께 가리킨다.
    legacy.results.find((result) => result.id === 'imp-a-2-SIGN-002-android')!.issueId = 'issue-bug-014';
    // BUG-015의 TC가 결과의 TC와 다르다.
    legacy.issues.find((issue) => issue.id === 'issue-bug-015')!.testCaseId = 'tc-001';
    const migrated = migrateV1ToV2(legacy) as AppData;
    expect(migrated.issues.find((issue) => issue.id === 'issue-bug-014')).not.toHaveProperty('resultId');
    expect(migrated.issues.find((issue) => issue.id === 'issue-bug-014')).toMatchObject({ testCaseId: 'tc-002' });
    expect(migrated.issues.find((issue) => issue.id === 'issue-bug-015')).toMatchObject({ testCaseId: 'tc-001' });
    expect(migrated.issues.find((issue) => issue.id === 'issue-bug-015')).not.toHaveProperty('resultId');
    expect(migrated.results.some((result) => 'issueId' in result)).toBe(false);

    const crossProject = legacyData();
    crossProject.issues.find((issue) => issue.id === 'issue-bug-014')!.projectId = 'proj-other';
    expect((migrateV1ToV2(crossProject) as AppData).issues.find((issue) => issue.id === 'issue-bug-014')).not.toHaveProperty('resultId');
  });

  it('이슈 목록이 없으면 빈 목록이고, 이슈가 없는 프로젝트는 빈 목록을 돌려준다', async () => {
    const legacy = legacyV1State();
    delete (legacy.data as Partial<AppData>).issues;
    expect((migrateV1ToV2(legacy.data) as AppData).issues).toEqual([]);

    const repos = await openTab(createMemoryStateStore(legacyV1State()));
    const [otherProject] = (await repos.projects.list()).filter((project) => project.id !== PROJECT_A);
    expect(await repos.issues.listByProject(otherProject.id)).toEqual([]);
  });

  it('알 수 없는 상태 · 모양이면 실패로 알리고(migration_failed), 입력은 바꾸지 않는다', () => {
    const legacy = legacyData();
    legacy.issues[0].status = 'reopened';
    expect(() => migrateV1ToV2(legacy)).toThrow('알 수 없는 이슈 상태');
    expect(migrateAppData(1, legacy)).toEqual({ status: 'failed', version: 1 });
    expect(migrateAppData(1, { results: [] })).toEqual({ status: 'failed', version: 1 });

    const frozen = deepFreeze(legacyV1State().data);
    expect(() => migrateV1ToV2(frozen)).not.toThrow();
    expect((frozen as { results: Record<string, unknown>[] }).results.some((result) => 'issueId' in result)).toBe(true);
  });

  it('v1로 저장된 데이터를 열면 한 번 변환해 v2로 저장하고(revision +1), 다시 열면 그대로 읽는다', async () => {
    const store = createMemoryStateStore(legacyV1State(7));
    const repos = await openTab(store);
    expect(ready(repos)).toMatchObject({ state: 'ready', revision: 8 });
    const saved = await storedState(store);
    expect(saved).toMatchObject({ schemaVersion: CURRENT_SCHEMA_VERSION, revision: 8 });
    expect(saved.data.results.some((result) => 'issueId' in result)).toBe(false);
    expect((await repos.issues.get('issue-bug-014'))).toMatchObject({ status: 'open', resultId: FAIL_RESULT });

    const reopened = await openTab(store);
    expect(ready(reopened).revision).toBe(8);
    expect(await reopened.issues.listByProject(PROJECT_A)).toEqual(await repos.issues.listByProject(PROJECT_A));
    // 변환 뒤에도 기존 결과 · TC는 그대로다(결과에서 옛 연결 필드만 빠졌다).
    const legacy = legacyV1State(7).data as AppData;
    expect(saved.data.testCases).toEqual(legacy.testCases);
    const withoutLegacyLink = (legacy.results as unknown as Record<string, unknown>[]).map((result) => {
      const rest = { ...result };
      delete rest.issueId;
      return rest;
    });
    expect(saved.data.results).toEqual(withoutLegacyLink);
  });

  it('변환에 실패하면 막고 v1 데이터를 그대로 둔다', async () => {
    const legacy = legacyV1State();
    (legacy.data as { issues: Record<string, unknown>[] }).issues[0].status = 'unknown';
    const store = createMemoryStateStore(legacy);
    const before = await storedState(store);
    const repos = await openTab(store);
    expect(repos.persistence.getStatus()).toMatchObject({ state: 'blocked', reason: 'migration_failed' });
    expect(await storedState(store)).toEqual(before);
  });
});

/* ---------- 저장소 ---------- */

describe('이슈 · 확인사항 저장소', () => {
  it('FAIL 결과에서 이슈를, BLOCKED 결과에서 확인사항을 만들고 결과 → TC → 프로젝트로 이어진다', async () => {
    const repos = await openTab(createMemoryStateStore());
    const issue = await repos.issues.create({ projectId: PROJECT_A, type: 'defect', title: 'iOS 문구 상이', resultId: FAIL_RESULT, expected: '가입 진행 가능' });
    const question = await repos.issues.create({ projectId: PROJECT_A, type: 'question', title: '잠금 정책 확인', resultId: BLOCKED_RESULT });

    expect(issue).toMatchObject({ type: 'defect', status: 'open', resultId: FAIL_RESULT, testCaseId: 'tc-002', expected: '가입 진행 가능' });
    expect(question).toMatchObject({ type: 'question', status: 'open', resultId: BLOCKED_RESULT });

    const imports = await repos.testResults.listImports(PROJECT_A);
    const results = (await Promise.all(imports.map((item) => repos.testResults.listResults(item.id)))).flat();
    const linked = results.find((result) => result.id === issue.resultId)!;
    expect(linked).toMatchObject({ result: 'fail', platform: 'ios' });
    expect(imports.find((item) => item.id === linked.importId)).toMatchObject({ projectId: PROJECT_A, round: 2 });
    expect((await repos.testCases.listByProject(PROJECT_A)).find((item) => item.id === linked.testCaseId)).toMatchObject({ externalId: 'SIGN-002' });
  });

  it('결과 없이 일반 확인사항을 만들 수 있다(TC는 선택)', async () => {
    const repos = await openTab(createMemoryStateStore());
    const general = await repos.issues.create({ projectId: PROJECT_A, type: 'question', title: '푸시 정책' });
    expect(general).not.toHaveProperty('resultId');
    expect(general).not.toHaveProperty('testCaseId');
    expect(await repos.issues.create({ projectId: PROJECT_A, type: 'question', title: '정책', testCaseId: 'tc-001' })).toMatchObject({ testCaseId: 'tc-001' });
  });

  it('같은 결과에 여러 항목을 만들 수 있다(실제 버그 하나 + 사양 확인 하나)', async () => {
    const repos = await openTab(createMemoryStateStore());
    await repos.issues.create({ projectId: PROJECT_A, type: 'defect', title: '버그', resultId: FAIL_RESULT });
    await repos.issues.create({ projectId: PROJECT_A, type: 'question', title: '사양 확인', resultId: FAIL_RESULT });
    // 예시 데이터의 BUG-014도 이 결과를 가리킨다.
    expect((await repos.issues.listByProject(PROJECT_A)).filter((item) => item.resultId === FAIL_RESULT)).toHaveLength(3);
  });

  it('다른 프로젝트 · 없는 결과 · TC · 요구사항 · 프로젝트, 결과와 다른 TC는 거부하고 아무것도 저장하지 않는다', async () => {
    const store = createMemoryStateStore();
    const repos = await openTab(store);
    const before = await storedState(store);
    const otherProject = (await repos.projects.list()).find((project) => project.id !== PROJECT_A)!.id;
    await expect(repos.issues.create({ projectId: otherProject, type: 'defect', title: 'x', resultId: FAIL_RESULT })).rejects.toThrow('수행 결과');
    await expect(repos.issues.create({ projectId: PROJECT_A, type: 'defect', title: 'x', resultId: 'missing' })).rejects.toThrow('수행 결과');
    await expect(repos.issues.create({ projectId: otherProject, type: 'defect', title: 'x', testCaseId: 'tc-001' })).rejects.toThrow('TC');
    await expect(repos.issues.create({ projectId: PROJECT_A, type: 'defect', title: 'x', requirementId: 'missing' })).rejects.toThrow('요구사항');
    await expect(repos.issues.create({ projectId: 'missing', type: 'defect', title: 'x' })).rejects.toThrow('프로젝트');
    await expect(repos.issues.create({ projectId: PROJECT_A, type: 'defect', title: 'x', resultId: FAIL_RESULT, testCaseId: 'tc-001' })).rejects.toThrow('다른 TC');
    await expect(repos.issues.create({ projectId: PROJECT_A, type: 'defect', title: ' ' })).rejects.toThrow('제목');
    expect(await storedState(store)).toEqual(before);
  });

  it('이슈를 만들고 고쳐도 수행 결과 · TC · 차수는 바뀌지 않는다', async () => {
    const store = createMemoryStateStore();
    const repos = await openTab(store);
    const before = await storedState(store);
    const issue = await repos.issues.create({ projectId: PROJECT_A, type: 'defect', title: '결과 불변 확인', resultId: FAIL_RESULT });
    await repos.issues.update(issue.id, { status: 'resolved', type: 'question', actual: '실제 동작' });
    const after = await storedState(store);
    expect(after.data.results).toEqual(before.data.results);
    expect(after.data.testCases).toEqual(before.data.testCases);
    expect(after.data.resultImports).toEqual(before.data.resultImports);
  });

  it('상태가 바뀔 때만 활동을 남긴다: 생성 · 해결 · 보류/다시 열기. 내용만 고치면 남기지 않고, 같은 값이면 저장하지 않는다', async () => {
    const repos = await openTab(createMemoryStateStore());
    const issue = await repos.issues.create({ projectId: PROJECT_A, type: 'defect', title: '활동 확인', resultId: FAIL_RESULT });
    const latest = async () => (await repos.activities.list({ projectId: PROJECT_A }))[0];
    expect(await latest()).toMatchObject({ type: 'issue_created', metadata: { issueId: issue.id, detail: '2차 SIGN-002 iOS FAIL' } });

    const count = async () => (await repos.activities.list()).length;
    const activitiesBefore = await count();
    await repos.issues.update(issue.id, { note: '메모만 고침', description: '설명' });
    expect(await count()).toBe(activitiesBefore);

    const revision = ready(repos).revision;
    const same = await repos.issues.update(issue.id, { note: '메모만 고침' });
    expect(ready(repos).revision).toBe(revision);
    expect(same.updatedAt).toBe((await repos.issues.get(issue.id))!.updatedAt);

    await repos.issues.update(issue.id, { status: 'resolved' });
    expect(await latest()).toMatchObject({ type: 'issue_resolved', metadata: { detail: '확인 필요 → 해결됨' } });
    await repos.issues.updateStatus(issue.id, 'deferred');
    expect(await latest()).toMatchObject({ type: 'issue_updated', metadata: { detail: '해결됨 → 보류' } });
    await repos.issues.updateStatus(issue.id, 'open');
    expect(await latest()).toMatchObject({ type: 'issue_updated', metadata: { detail: '보류 → 확인 필요' } });
  });

  it('resolvedAt은 해결 진입 때 생기고, 다시 열면 지워지며 새로고침 뒤에도 남는다', async () => {
    const store = createMemoryStateStore();
    const repos = await openTab(store);
    const issue = await repos.issues.create({ projectId: PROJECT_A, type: 'defect', title: '해결 시각', resultId: FAIL_RESULT, reproduction: '1. 열기\n2. 누르기' });
    const resolved = await repos.issues.updateStatus(issue.id, 'resolved');
    expect(resolved.resolvedAt).toEqual(expect.any(String));

    const reloaded = await openTab(store);
    expect(await reloaded.issues.get(issue.id)).toEqual(resolved);
    const reopened = await reloaded.issues.updateStatus(issue.id, 'open');
    expect(reopened).not.toHaveProperty('resolvedAt');
    expect(await (await openTab(store)).issues.get(issue.id)).toEqual(reopened);
  });

  it('저장에 실패하면 메모리 · 저장소 모두 그대로이고, 다시 시도하면 저장된다', async () => {
    const base = createMemoryStateStore();
    const { store, failNext } = failingOnce(base);
    const repos = await openTab(store);
    const issue = await repos.issues.create({ projectId: PROJECT_A, type: 'defect', title: '원래 제목', resultId: FAIL_RESULT });
    const stored = await storedState(base);
    const listed = await repos.issues.listByProject(PROJECT_A);
    const activities = await repos.activities.list();

    failNext();
    await expect(repos.issues.create({ projectId: PROJECT_A, type: 'question', title: '저장 안 됨' })).rejects.toBeInstanceOf(PersistenceError);
    failNext();
    await expect(repos.issues.update(issue.id, { title: '바뀌면 안 됨', status: 'resolved' })).rejects.toBeInstanceOf(PersistenceError);

    expect(await storedState(base)).toEqual(stored);
    expect(await repos.issues.listByProject(PROJECT_A)).toEqual(listed);
    expect(await repos.activities.list()).toEqual(activities);
    expect(ready(repos).error).toBeTruthy();

    expect(await repos.issues.updateStatus(issue.id, 'resolved')).toMatchObject({ status: 'resolved' });
    expect(ready(repos).error).toBeUndefined();
  });

  it('다른 탭이 먼저 저장했으면 오래된 revision의 생성 · 수정을 거부하고, 알림을 받으면 미리 오래된 상태가 된다', async () => {
    const store = createMemoryStateStore();
    const hub = createMemoryChannelHub();
    const tabA = await openTab(store, { channel: hub.connect() });
    const tabB = await openTab(store);
    const tabC = await openTab(store, { channel: hub.connect() });

    const fromA = await tabA.issues.create({ projectId: PROJECT_A, type: 'defect', title: 'A 탭', resultId: FAIL_RESULT });
    expect(ready(tabC).stale).toBe(true);
    const saved = await storedState(store);

    await expect(tabB.issues.create({ projectId: PROJECT_A, type: 'question', title: 'B 탭' })).rejects.toMatchObject({ kind: 'conflict' });
    await expect(tabC.issues.updateStatus('issue-bug-014', 'resolved')).rejects.toMatchObject({ kind: 'conflict' });
    expect(await storedState(store)).toEqual(saved);

    await tabB.persistence.reloadLatest();
    expect(await tabB.issues.get(fromA.id)).toEqual(fromA);
    await tabB.issues.create({ projectId: PROJECT_A, type: 'question', title: 'B 탭 다시' });
    expect((await storedState(store)).data.issues.map((item) => item.title)).toEqual(expect.arrayContaining(['A 탭', 'B 탭 다시']));
  });

  it('로컬 데이터 초기화는 만든 이슈도 함께 지우고 예시 데이터로 돌린다', async () => {
    const store = createMemoryStateStore();
    const repos = await openTab(store);
    const issue = await repos.issues.create({ projectId: PROJECT_A, type: 'defect', title: '초기화로 사라짐' });
    await repos.persistence.resetToSeed();
    expect(await repos.issues.get(issue.id)).toBeUndefined();
    expect((await repos.issues.listByProject(PROJECT_A)).map((item) => item.id).sort()).toEqual(createSeed().issues.map((item) => item.id).sort());
    expect((await storedState(store)).schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('입력 · 돌려받은 객체를 고쳐도 저장된 이슈는 바뀌지 않는다', async () => {
    const repos = await openTab(createMemoryStateStore());
    const input = { projectId: PROJECT_A, type: 'defect' as const, title: '격리', resultId: FAIL_RESULT };
    const issue = await repos.issues.create(input);
    input.title = '바꿈';
    (issue as Issue).title = '바꿈';
    const changes = { note: '메모' };
    const updated = await repos.issues.update(issue.id, changes);
    changes.note = '바꿈';
    updated.note = '바꿈';
    expect(await repos.issues.get(issue.id)).toMatchObject({ title: '격리', note: '메모' });
  });

  it('PASS 결과에도 저장소는 막지 않는다(화면이 FAIL · BLOCKED에만 만들기를 보여 준다)', async () => {
    const repos = await openTab(createMemoryStateStore());
    expect(await repos.issues.create({ projectId: PROJECT_A, type: 'question', title: 'PASS지만 확인', resultId: PASS_RESULT })).toMatchObject({ resultId: PASS_RESULT });
  });
});

/* ---------- 실제 QA 흐름 ---------- */

describe('실제 QA 흐름: TC-101 Android 1차 PASS → 2차 FAIL → 이슈 → 3차 PASS', () => {
  it('비교의 신규 실패에서 2차 결과로 이슈를 만들고, 3차 PASS가 생겨도 자동으로 해결되지 않으며, 사용자가 해결로 바꾼다', async () => {
    const store = createMemoryStateStore();
    const repos = await openTab(store, { createInitialData: qaScenarioSeed });

    const first = await importQaRound(repos, 1, 'P');
    const second = await importQaRound(repos, 2, 'F', '로그인 버튼 무반응');
    expect([first.result.result, second.result.result]).toEqual(['pass', 'fail']);

    const comparison = compareResultRounds(first.resultImport, second.resultImport, [first.result, second.result]);
    if (!comparison.ok) throw new Error(comparison.reason);
    const [row] = comparison.rows;
    expect(row).toMatchObject({ changeType: 'newly_failed', testCaseId: QA_TEST_CASE_ID, platform: 'android', currentResultId: second.result.id });

    // 비교 행이 아니라 비교 차수의 실제 결과에 연결한다.
    const issue = await repos.issues.create({ projectId: PROJECT_A, type: 'defect', title: 'Android 로그인 실패', resultId: row.currentResultId!, actual: second.result.note });
    expect(issue).toMatchObject({ type: 'defect', status: 'open', resultId: second.result.id, testCaseId: QA_TEST_CASE_ID, actual: '로그인 버튼 무반응' });

    const third = await importQaRound(repos, 3, 'P');
    expect(third.result.result).toBe('pass');
    expect(await repos.issues.get(issue.id)).toEqual(issue);

    const imports = await repos.testResults.listImports(PROJECT_A);
    const results = (await Promise.all(imports.map((item) => repos.testResults.listResults(item.id)))).flat();
    expect(laterResultsFor(second.result, imports, results).map((item) => [item.resultImport.round, item.result.result])).toEqual([[3, 'pass']]);

    const resolved = await repos.issues.updateStatus(issue.id, 'resolved');
    expect(resolved).toMatchObject({ status: 'resolved', resolvedAt: expect.any(String), resultId: second.result.id });
    expect(await (await openTab(store)).issues.get(issue.id)).toEqual(resolved);
  });
});
