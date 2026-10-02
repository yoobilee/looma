import { describe, expect, it } from 'vitest';
import { laterResultsFor } from '@/domain/issues';
import { compareResultRounds } from '@/domain/resultComparison';
import type { Issue } from '@/domain/types';
import { PersistenceError } from '../persistenceError';
import type { PersistenceStatus, Repositories } from '../repositories/types';
import { importQaRound, legacyV1State, QA_TEST_CASE_ID, qaScenarioSeed } from '../mock/issueScenario';
import { createSeed, PROJECT_A, PROJECT_B } from '../mock/seed';
import { CURRENT_SCHEMA_VERSION, type AppData, type StoredAppState } from './appData';
import { createLocalRepositories, type LocalRepositoryOptions } from './localRepositories';
import { LegacyLinkError, migrateAppData, migrateV1ToV2 } from './migrations';
import { assertCurrentAppData, StoredDataError } from './schemaValidation';
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
type LegacyData = Record<'issues' | 'results' | 'resultImports' | 'projects' | 'testCases', Record<string, unknown>[]>;
const legacyData = () => legacyV1State().data as LegacyData;

/**
 * v1로 저장된 상태(revision 8)와 원본 bytes 하나. change로 저장 전 v1 데이터를 바꾼다.
 * schemaVersion을 주면 그 버전 표기로 저장한다(버전 표기와 실제 모양이 다른 경우).
 */
async function legacyStore(change: (data: LegacyData) => void = () => {}, schemaVersion = 1) {
  const state = legacyV1State(7);
  change(state.data as LegacyData);
  const store = createMemoryStateStore({ ...state, schemaVersion });
  await store.commit({ expectedRevision: 7, schemaVersion, savedAt: state.savedAt, data: state.data as AppData, artifacts: [{ id: 'src-legacy', bytes: new Blob(['v1 원본 bytes']) }] });
  return store;
}

/** 열면 막히고, 저장 상태 · revision · 원본 bytes가 그대로이며 메모리에도 아무 데이터가 없다. */
async function expectBlockedUnchanged(store: ReturnType<typeof createMemoryStateStore>, reason: 'migration_failed' | 'corrupt') {
  const before = store.inspect();
  const repos = await openTab(store);
  expect(repos.persistence.getStatus()).toMatchObject({ state: 'blocked', reason });
  expect(store.inspect()).toEqual(before);
  expect((before.state as StoredAppState).revision).toBe(8);
  expect(await (await store.readArtifactBytes('src-legacy'))!.text()).toBe('v1 원본 bytes');
  expect(await repos.projects.list()).toEqual([]);
  expect(await repos.issues.listByProject(PROJECT_A)).toEqual([]);
  await expect(repos.tasks.create({ title: 'x' })).rejects.toBeInstanceOf(PersistenceError);
  return repos;
}

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

  it('정상 1:1 연결만 옮기고, 배열 순서를 뒤집어도 결과가 같다', () => {
    const sortById = <T extends { id: string }>(items: T[]) => [...items].sort((a, b) => a.id.localeCompare(b.id));
    const forward = migrateV1ToV2(legacyData()) as AppData;
    const reversed = legacyData() as LegacyData & Record<string, unknown[]>;
    for (const key of ['issues', 'results', 'resultImports', 'projects']) reversed[key] = [...reversed[key]].reverse();
    const backward = migrateV1ToV2(reversed) as AppData;
    expect(sortById(backward.issues)).toEqual(sortById(forward.issues));
    expect(sortById(backward.results)).toEqual(sortById(forward.results));
  });

  // v1 결과 → 이슈 연결을 1:1로 옮길 수 없으면 연결을 지우거나 하나를 고르지 않고 변환 전체를 멈춘다.
  it.each([
    ['같은 이슈를 결과 2개가 가리킴', (data: LegacyData) => void (data.results.find((result) => result.id === 'imp-a-2-SIGN-002-android')!.issueId = 'issue-bug-014'), '여러 개'],
    ['이슈와 결과 차수의 프로젝트가 다름', (data: LegacyData) => void (data.issues.find((issue) => issue.id === 'issue-bug-014')!.projectId = PROJECT_B), '다른 프로젝트'],
    ['결과의 차수가 없음', (data: LegacyData) => void (data.results.find((result) => result.id === FAIL_RESULT)!.importId = 'imp-missing'), '다른 프로젝트'],
    ['이슈의 TC와 결과의 TC가 다름', (data: LegacyData) => void (data.issues.find((issue) => issue.id === 'issue-bug-015')!.testCaseId = 'tc-001'), 'TC가 달라요'],
    ['이슈에는 TC가 있는데 결과는 TC 미연결', (data: LegacyData) => void delete data.results.find((result) => result.id === FAIL_RESULT)!.testCaseId, 'TC가 달라요'],
    ['없는 이슈를 가리킴(orphan)', (data: LegacyData) => void (data.results.find((result) => result.id === PASS_RESULT)!.issueId = 'issue-missing'), '없는 이슈'],
  ])('%s → 변환 실패, v1 결과의 issueId · 저장 상태 · revision · 원본 bytes · 메모리 모두 그대로', async (_, breakLink, reason) => {
    const broken = legacyData();
    breakLink(broken);
    expect(() => migrateV1ToV2(broken)).toThrow(LegacyLinkError);
    expect(() => migrateV1ToV2(broken)).toThrow(reason);
    const reversed = { ...broken, results: [...broken.results].reverse(), issues: [...broken.issues].reverse() };
    expect(() => migrateV1ToV2(reversed)).toThrow(reason);

    const store = await legacyStore(breakLink);
    await expectBlockedUnchanged(store, 'migration_failed');
    const kept = (await storedState(store)).data as unknown as LegacyData;
    const linkedIds = (data: LegacyData) => data.results.filter((result) => result.issueId !== undefined).map((result) => `${String(result.id)}→${String(result.issueId)}`).sort();
    expect(linkedIds(kept)).toEqual(linkedIds(broken));
  });

  it('이슈 목록이 없고 결과 연결도 없으면 빈 목록이며, 이슈가 없는 프로젝트는 빈 목록을 돌려준다', async () => {
    const legacy = legacyData();
    delete (legacy as Partial<LegacyData>).issues;
    for (const result of legacy.results) delete result.issueId;
    expect((migrateV1ToV2(legacy) as AppData).issues).toEqual([]);

    const repos = await openTab(createMemoryStateStore(legacyV1State()));
    expect(await repos.issues.listByProject(PROJECT_B)).toEqual([]);
  });

  // 해석할 수 없는 v1은 v2로 올리지 않는다(화면에서 나중에 깨지지 않게 저장 전에 막는다).
  it.each([
    ['Issue.title이 객체', (data: LegacyData) => void (data.issues[0].title = { text: '제목' }), 'issues[0].title'],
    ['Issue.type이 알 수 없는 값', (data: LegacyData) => void (data.issues[0].type = 'bug'), 'issues[0].type'],
    ['Issue.status가 알 수 없는 값', (data: LegacyData) => void (data.issues[0].status = 'reopened'), 'issues[0].status'],
    ['Issue.createdAt이 날짜가 아님', (data: LegacyData) => void (data.issues[0].createdAt = 'not-a-date'), 'issues[0].createdAt'],
    ['Issue.updatedAt이 날짜가 아님', (data: LegacyData) => void (data.issues[0].updatedAt = 'yesterday'), 'issues[0].updatedAt'],
    ['Issue.resolvedAt이 날짜가 아님', (data: LegacyData) => void (data.issues[0].resolvedAt = 12), 'issues[0].resolvedAt'],
    ['Issue.id가 없음', (data: LegacyData) => void delete data.issues[0].id, 'issues[0].id'],
    ['Issue.id가 빈 문자열', (data: LegacyData) => void (data.issues[0].id = ' '), 'issues[0].id'],
    ['Issue.projectId가 문자열이 아님', (data: LegacyData) => void (data.issues[0].projectId = 1), 'issues[0].projectId'],
    ['Issue.testCaseId가 문자열이 아님', (data: LegacyData) => void (data.issues[0].testCaseId = ['tc-002']), 'issues[0].testCaseId'],
    ['Issue.sourceRef 모양이 아님', (data: LegacyData) => void (data.issues[0].sourceRef = { locator: 'p.14' }), 'issues[0].sourceRef.deliverableId'],
    ['v1 Issue에 v2 resultId가 있음', (data: LegacyData) => void (data.issues[0].resultId = FAIL_RESULT), 'issues[0].resultId'],
    ['Issue ID 중복', (data: LegacyData) => void (data.issues[1].id = data.issues[0].id), 'issues[1].id'],
    ['TestResult ID 중복', (data: LegacyData) => void (data.results[1].id = data.results[0].id), 'results[1].id'],
    ['TestResult.issueId가 문자열이 아님', (data: LegacyData) => void (data.results[0].issueId = 3), 'results[0].issueId'],
    ['TestResult.result가 알 수 없는 값', (data: LegacyData) => void (data.results[0].result = 'P'), 'results[0].result'],
    ['TestResultImport ID 중복', (data: LegacyData) => void (data.resultImports[1].id = data.resultImports[0].id), 'resultImports[1].id'],
    ['Project ID 중복', (data: LegacyData) => void (data.projects[1].id = data.projects[0].id), 'projects[1].id'],
    // 화면이 바로 읽는 필수 필드(날짜 표시 · 매핑 목록 · 파일 이름 · 프로젝트 이름 등)
    ['TestResultImport.importedAt이 날짜가 아님', (data: LegacyData) => void (data.resultImports[0].importedAt = 'not-a-date'), 'resultImports[0].importedAt'],
    ['TestResultImport.importedAt이 없음', (data: LegacyData) => void delete data.resultImports[0].importedAt, 'resultImports[0].importedAt'],
    ['TestResultImport.mapping이 없음', (data: LegacyData) => void delete data.resultImports[0].mapping, 'resultImports[0].mapping'],
    ['TestResultImport.mapping 항목의 결과가 없음', (data: LegacyData) => void (data.resultImports[0].mapping = [{ rawValue: 'P' }]), 'resultImports[0].mapping[0].result'],
    ['TestResultImport.mapping 항목의 원문이 문자열이 아님', (data: LegacyData) => void (data.resultImports[0].mapping = [{ rawValue: 1, result: 'pass' }]), 'resultImports[0].mapping[0].rawValue'],
    ['TestResultImport.fileRef가 객체', (data: LegacyData) => void (data.resultImports[0].fileRef = { name: 'a.xlsx' }), 'resultImports[0].fileRef'],
    ['TestResultImport.platform이 알 수 없는 값', (data: LegacyData) => void (data.resultImports[0].platform = 'tablet'), 'resultImports[0].platform'],
    ['TestResultImport.executionType이 알 수 없는 값', (data: LegacyData) => void (data.resultImports[0].executionType = 'smoke'), 'resultImports[0].executionType'],
    ['TestResultImport.executedFrom이 문자열이 아님', (data: LegacyData) => void (data.resultImports[0].executedFrom = 20260901), 'resultImports[0].executedFrom'],
    ['Project.name이 객체', (data: LegacyData) => void (data.projects[0].name = { ko: '프로젝트' }), 'projects[0].name'],
    ['Project.name이 없음', (data: LegacyData) => void delete data.projects[0].name, 'projects[0].name'],
    ['Project.status가 알 수 없는 값', (data: LegacyData) => void (data.projects[0].status = 'paused'), 'projects[0].status'],
    ['Project.platforms가 배열이 아님', (data: LegacyData) => void (data.projects[0].platforms = 'android'), 'projects[0].platforms'],
    ['Project.testScopes에 알 수 없는 값', (data: LegacyData) => void (data.projects[0].testScopes = ['security']), 'projects[0].testScopes[0]'],
    ['TestCase.projectId가 없음', (data: LegacyData) => void delete data.testCases[0].projectId, 'testCases[0].projectId'],
    ['TestCase ID 중복', (data: LegacyData) => void (data.testCases[1].id = data.testCases[0].id), 'testCases[1].id'],
  ])('%s → 변환 실패(migration_failed), v1 · revision · 원본 bytes · 메모리 그대로', async (_, corrupt, path) => {
    const broken = legacyData();
    corrupt(broken);
    expect(() => migrateV1ToV2(broken)).toThrow(StoredDataError);
    expect(() => migrateV1ToV2(broken)).toThrow(path);
    expect(migrateAppData(1, broken)).toEqual({ status: 'failed', version: 1 });
    await expectBlockedUnchanged(await legacyStore(corrupt), 'migration_failed');
  });

  it('변환 결과가 현재 버전 검증을 통과하지 못하면(확인 필요로 바뀌는 항목에 해결 시각) 저장하지 않는다', async () => {
    const withResolvedAt = (data: LegacyData) => void (data.issues.find((issue) => issue.id === 'issue-q-login-limit')!.resolvedAt = '2026-09-01T00:00:00.000Z');
    const broken = legacyData();
    withResolvedAt(broken);
    expect(() => migrateV1ToV2(broken)).toThrow('resolvedAt');
    await expectBlockedUnchanged(await legacyStore(withResolvedAt), 'migration_failed');
  });

  // 참조 대상이 없거나 다른 프로젝트면 v2로 올리지 않는다(이슈 상세에서 TC · 결과를 찾지 못하게 되기 때문).
  it.each([
    ['연결 결과의 TC(tc-002)가 삭제됨', (data: LegacyData) => void (data.testCases = data.testCases.filter((item) => item.id !== 'tc-002')), '없는 TC예요. (tc-002)'],
    ['연결 결과의 TC(tc-002)가 다른 프로젝트로 옮겨짐', (data: LegacyData) => void (data.testCases.find((item) => item.id === 'tc-002')!.projectId = PROJECT_B), '다른 프로젝트의 TC예요. (tc-002)'],
    ['연결 없는 결과의 차수가 없음', (data: LegacyData) => void (data.results.find((result) => result.id === PASS_RESULT)!.importId = 'imp-missing'), '없는 수행 차수예요. (imp-missing)'],
    ['차수의 프로젝트가 없음', (data: LegacyData) => void (data.resultImports.find((item) => item.id === 'imp-a-1')!.projectId = 'proj-missing'), '없는 프로젝트예요. (proj-missing)'],
    ['TC의 프로젝트가 없음', (data: LegacyData) => void (data.testCases.find((item) => item.id === 'tc-002')!.projectId = 'proj-missing'), '없는 프로젝트예요. (proj-missing)'],
    ['이슈의 프로젝트가 없음', (data: LegacyData) => void (data.issues.find((issue) => issue.id === 'issue-q-lock-policy')!.projectId = 'proj-missing'), '없는 프로젝트예요. (proj-missing)'],
    ['이슈의 TC가 없음', (data: LegacyData) => void (data.issues.find((issue) => issue.id === 'issue-q-terms')!.testCaseId = 'tc-missing'), '없는 TC예요. (tc-missing)'],
    ['이슈의 TC가 다른 프로젝트', (data: LegacyData) => void (data.issues.find((issue) => issue.id === 'issue-q-terms')!.projectId = PROJECT_B), '다른 프로젝트의 TC예요. (tc-007)'],
  ])('%s → 변환 실패(migration_failed), 배열 순서와 무관하며 v1 · revision · 원본 bytes · 메모리 그대로', async (_, breakRelation, reason) => {
    const broken = legacyData();
    breakRelation(broken);
    expect(() => migrateV1ToV2(broken)).toThrow(StoredDataError);
    expect(() => migrateV1ToV2(broken)).toThrow(reason);
    const reversed = Object.fromEntries(Object.entries(broken).map(([key, value]) => [key, Array.isArray(value) ? [...value].reverse() : value]));
    expect(() => migrateV1ToV2(reversed)).toThrow(reason);
    expect(migrateAppData(1, broken)).toEqual({ status: 'failed', version: 1 });
    expect(migrateAppData(1, reversed)).toEqual({ status: 'failed', version: 1 });
    await expectBlockedUnchanged(await legacyStore(breakRelation), 'migration_failed');
  });

  it('모르는 필드가 있다는 이유만으로는 실패하지 않고, 그 필드를 그대로 남긴다', () => {
    const legacy = legacyData();
    legacy.issues[0].customerMemo = '고객사 메모';
    legacy.results[0].extraColumn = 'x';
    const migrated = migrateV1ToV2(legacy) as unknown as LegacyData;
    expect(migrated.issues[0].customerMemo).toBe('고객사 메모');
    expect(migrated.results[0].extraColumn).toBe('x');
  });

  it('schemaVersion이 2라도 실제 데이터가 v1 모양이면 현재 버전으로 읽지 않는다(corrupt)', async () => {
    await expectBlockedUnchanged(await legacyStore(() => {}, CURRENT_SCHEMA_VERSION), 'corrupt');
    const v2 = migrateV1ToV2(legacyData()) as AppData;
    expect(migrateAppData(CURRENT_SCHEMA_VERSION, v2)).toMatchObject({ status: 'current' });
    const resultWithLegacyLink = structuredClone(v2) as unknown as LegacyData;
    resultWithLegacyLink.results[0].issueId = 'issue-bug-014';
    expect(migrateAppData(CURRENT_SCHEMA_VERSION, resultWithLegacyLink)).toEqual({ status: 'corrupt' });
    const legacyStatus = structuredClone(v2) as unknown as LegacyData;
    legacyStatus.issues[0].status = 'waiting';
    expect(migrateAppData(CURRENT_SCHEMA_VERSION, legacyStatus)).toEqual({ status: 'corrupt' });
    const missingUpdatedAt = structuredClone(v2) as unknown as LegacyData;
    delete missingUpdatedAt.issues[0].updatedAt;
    expect(migrateAppData(CURRENT_SCHEMA_VERSION, missingUpdatedAt)).toEqual({ status: 'corrupt' });
  });

  it('입력을 바꾸지 않는다', () => {
    const frozen = deepFreeze(legacyV1State().data);
    expect(() => migrateV1ToV2(frozen)).not.toThrow();
    expect((frozen as { results: Record<string, unknown>[] }).results.some((result) => 'issueId' in result)).toBe(true);
    expect(migrateAppData(1, { results: [] })).toEqual({ status: 'failed', version: 1 });
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

  it('변환에 실패해 막힌 뒤 원인을 고치고 다시 불러오면 같은 탭에서 변환에 성공한다', async () => {
    const store = await legacyStore((data) => void (data.issues[0].title = { text: '제목' }));
    const repos = await expectBlockedUnchanged(store, 'migration_failed');

    // 사용자가 다른 방법으로 v1 데이터를 고쳤다(같은 v1 형식, revision +1).
    const fixed = legacyV1State(8);
    await store.commit({ expectedRevision: 8, schemaVersion: 1, savedAt: fixed.savedAt, data: fixed.data as AppData });
    await repos.persistence.load();
    expect(ready(repos)).toMatchObject({ state: 'ready', revision: 10 });
    expect(await storedState(store)).toMatchObject({ schemaVersion: CURRENT_SCHEMA_VERSION, revision: 10 });
    expect(await repos.issues.get('issue-bug-014')).toMatchObject({ resultId: FAIL_RESULT });
    expect(store.inspect().artifactIds).toEqual(['src-legacy']);
  });

  it('변환한 v2를 저장하지 못하면 메모리에도 v2를 반영하지 않고(읽기 · 쓰기 모두 막힘), 실패가 사라지면 다시 불러와 변환한다', async () => {
    const base = await legacyStore();
    const { store, failNext } = failingOnce(base);
    const before = base.inspect();
    failNext();
    const repos = await openTab(store);

    expect(repos.persistence.getStatus()).toMatchObject({ state: 'blocked', reason: 'migration_failed' });
    expect(base.inspect()).toEqual(before);
    expect((await storedState(base)).schemaVersion).toBe(1);
    // 저장 전에 메모리를 먼저 바꾸는 회귀가 있으면 여기서 v2 데이터가 보인다.
    expect(await repos.projects.list()).toEqual([]);
    expect(await repos.issues.listByProject(PROJECT_A)).toEqual([]);
    expect(await repos.testResults.listImports(PROJECT_A)).toEqual([]);
    expect(await repos.issues.get('issue-bug-014')).toBeUndefined();
    await expect(repos.issues.create({ projectId: PROJECT_A, type: 'defect', title: 'x' })).rejects.toBeInstanceOf(PersistenceError);

    await repos.persistence.load();
    expect(ready(repos)).toMatchObject({ state: 'ready', revision: 9 });
    expect(await storedState(base)).toMatchObject({ schemaVersion: CURRENT_SCHEMA_VERSION, revision: 9 });
    expect(await repos.issues.get('issue-bug-014')).toMatchObject({ status: 'open', resultId: FAIL_RESULT });
    expect(await (await base.readArtifactBytes('src-legacy'))!.text()).toBe('v1 원본 bytes');
  });
});

/* ---------- 현재 버전 관계 무결성 ---------- */

describe('현재 버전(v2) 저장 데이터의 필수 필드 · 관계 무결성', () => {
  /** 예시 데이터를 v2로 저장한 상태(revision 8)와 원본 bytes 하나. change로 저장 전 데이터를 바꾼다. */
  async function currentStore(change: (data: AppData) => void) {
    const data = createSeed();
    change(data);
    const store = createMemoryStateStore({ schemaVersion: CURRENT_SCHEMA_VERSION, revision: 7, savedAt: '2026-10-01T00:00:00.000Z', data });
    await store.commit({ expectedRevision: 7, schemaVersion: CURRENT_SCHEMA_VERSION, savedAt: '2026-10-01T00:00:00.000Z', data, artifacts: [{ id: 'src-legacy', bytes: new Blob(['v1 원본 bytes']) }] });
    return store;
  }

  const issueOf = (data: AppData, id: string) => data.issues.find((issue) => issue.id === id)!;
  const reverseAll = (data: AppData) => Object.fromEntries(Object.entries(data).map(([key, value]) => [key, [...(value as unknown[])].reverse()])) as unknown as AppData;

  it('예시 데이터의 관계는 그대로 통과하고, 배열 순서를 뒤집어도 같다', () => {
    expect(migrateAppData(CURRENT_SCHEMA_VERSION, createSeed())).toMatchObject({ status: 'current' });
    expect(migrateAppData(CURRENT_SCHEMA_VERSION, reverseAll(createSeed()))).toMatchObject({ status: 'current' });
  });

  it('TC 미연결 결과에서 만든 이슈, 출처 산출물이 없는 이슈(화면이 대신 표시)는 통과한다', () => {
    const data = createSeed();
    delete data.results.find((result) => result.id === FAIL_RESULT)!.testCaseId;
    delete issueOf(data, 'issue-bug-014').testCaseId;
    issueOf(data, 'issue-q-terms').sourceRef = { deliverableId: 'deliverable-missing', locator: 'p.3' };
    expect(() => assertCurrentAppData(data)).not.toThrow();
  });

  it.each([
    ['결과의 차수가 없음', (data: AppData) => void (data.results.find((result) => result.id === PASS_RESULT)!.importId = 'imp-missing'), '없는 수행 차수예요. (imp-missing)'],
    ['결과의 TC가 없음', (data: AppData) => void (data.results.find((result) => result.id === PASS_RESULT)!.testCaseId = 'tc-missing'), '없는 TC예요. (tc-missing)'],
    ['결과의 TC가 차수와 다른 프로젝트', (data: AppData) => void (data.testCases.find((item) => item.id === 'tc-002')!.projectId = PROJECT_B), '다른 프로젝트의 TC예요. (tc-002)'],
    ['이슈의 결과가 없음', (data: AppData) => void (issueOf(data, 'issue-bug-014').resultId = 'result-missing'), '없는 결과예요. (result-missing)'],
    [
      '이슈와 결과의 프로젝트가 다름',
      (data: AppData) => {
        issueOf(data, 'issue-bug-014').projectId = PROJECT_B;
        delete issueOf(data, 'issue-bug-014').testCaseId;
      },
      `다른 프로젝트의 결과예요. (${FAIL_RESULT})`,
    ],
    ['이슈의 TC와 연결 결과의 TC가 다름', (data: AppData) => void (issueOf(data, 'issue-bug-014').testCaseId = 'tc-001'), '연결 결과의 TC와 달라요. (tc-001 ≠ tc-002)'],
    ['이슈의 TC가 없음', (data: AppData) => void (issueOf(data, 'issue-q-terms').testCaseId = 'tc-missing'), '없는 TC예요. (tc-missing)'],
    ['이슈의 프로젝트가 없음', (data: AppData) => void (issueOf(data, 'issue-q-lock-policy').projectId = 'proj-missing'), '없는 프로젝트예요. (proj-missing)'],
    ['차수의 프로젝트가 없음', (data: AppData) => void (data.resultImports.find((item) => item.id === 'imp-a-1')!.projectId = 'proj-missing'), '없는 프로젝트예요. (proj-missing)'],
    ['TC의 프로젝트가 없음', (data: AppData) => void (data.testCases.find((item) => item.id === 'tc-002')!.projectId = 'proj-missing'), '없는 프로젝트예요. (proj-missing)'],
    ['차수의 importedAt이 날짜가 아님', (data: AppData) => void (data.resultImports[0].importedAt = 'not-a-date'), 'importedAt'],
    ['차수의 mapping이 없음', (data: AppData) => void delete (data.resultImports[0] as Partial<AppData['resultImports'][number]>).mapping, 'mapping'],
  ])('%s → corrupt로 막고 배열 순서와 무관하며, 저장 상태 · revision · 원본 bytes · 메모리 그대로', async (_, corrupt, reason) => {
    const broken = createSeed();
    corrupt(broken);
    expect(() => assertCurrentAppData(broken)).toThrow(StoredDataError);
    expect(() => assertCurrentAppData(broken)).toThrow(reason);
    expect(() => assertCurrentAppData(reverseAll(broken))).toThrow(reason);
    expect(migrateAppData(CURRENT_SCHEMA_VERSION, broken)).toEqual({ status: 'corrupt' });
    await expectBlockedUnchanged(await currentStore(corrupt), 'corrupt');
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

  describe('결과에서 만들 때 결과가 가리키는 TC의 프로젝트 경계', () => {
    /** 예시 데이터에서 FAIL_RESULT의 testCaseId만 바꾼 저장소 */
    async function withResultTestCase(testCaseId: string | undefined) {
      const seed = createSeed();
      const sample = seed.testCases.find((item) => item.projectId === PROJECT_A)!;
      seed.testCases.push({ ...sample, id: 'tc-project-b', projectId: PROJECT_B, externalId: 'B-001' });
      const result = seed.results.find((item) => item.id === FAIL_RESULT)!;
      if (testCaseId === undefined) delete result.testCaseId;
      else result.testCaseId = testCaseId;
      seed.issues = seed.issues.filter((issue) => issue.resultId !== FAIL_RESULT);
      const store = createMemoryStateStore();
      return { store, repos: await openTab(store, { createInitialData: () => seed }) };
    }

    /** 거부되고 이슈 · 활동 · 저장 상태 · revision이 그대로다. */
    async function expectRejected(store: StateStore, repos: Repositories, input: Parameters<Repositories['issues']['create']>[0], message: string) {
      const before = await storedState(store);
      const activities = await repos.activities.list();
      const revision = ready(repos).revision;
      await expect(repos.issues.create(input)).rejects.toThrow(message);
      expect(await storedState(store)).toEqual(before);
      expect(await repos.activities.list()).toEqual(activities);
      expect(await repos.issues.listByProject(PROJECT_A)).toEqual(before.data.issues.filter((issue) => issue.projectId === PROJECT_A).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      expect(ready(repos).revision).toBe(revision);
    }

    it('결과의 TC가 같은 프로젝트에 있으면 만든다', async () => {
      const { repos } = await withResultTestCase('tc-002');
      expect(await repos.issues.create({ projectId: PROJECT_A, type: 'defect', title: 'x', resultId: FAIL_RESULT })).toMatchObject({ testCaseId: 'tc-002' });
    });

    // 결과가 다른 프로젝트 TC · 없는 TC를 가리키는 저장 상태는 처음부터 읽지 않는다. 그 결과로 이슈를 만들 기회가 없다.
    it.each([
      ['다른 프로젝트에 있으면', 'tc-project-b'],
      ['없으면', 'tc-missing'],
    ])('결과의 TC가 %s 저장 상태를 읽지 않고 그대로 둔다', async (_, testCaseId) => {
      const seed = createSeed();
      const sample = seed.testCases.find((item) => item.projectId === PROJECT_A)!;
      seed.testCases.push({ ...sample, id: 'tc-project-b', projectId: PROJECT_B, externalId: 'B-001' });
      seed.results.find((item) => item.id === FAIL_RESULT)!.testCaseId = testCaseId;
      seed.issues = seed.issues.filter((issue) => issue.resultId !== FAIL_RESULT);
      const store = createMemoryStateStore({ schemaVersion: CURRENT_SCHEMA_VERSION, revision: 3, savedAt: '2026-10-01T00:00:00.000Z', data: seed });
      const before = store.inspect();
      const repos = await openTab(store);
      expect(repos.persistence.getStatus()).toMatchObject({ state: 'blocked', reason: 'corrupt' });
      expect(store.inspect()).toEqual(before);
      await expect(repos.issues.create({ projectId: PROJECT_A, type: 'defect', title: 'x', resultId: FAIL_RESULT })).rejects.toBeInstanceOf(PersistenceError);
      expect(store.inspect()).toEqual(before);
    });

    it('TC 미연결 결과는 TC 없이 연결하고, 입력으로 TC를 따로 붙이면 거부한다(고객사 TC ID로 추측하지 않음)', async () => {
      const { store, repos } = await withResultTestCase(undefined);
      await expectRejected(store, repos, { projectId: PROJECT_A, type: 'defect', title: 'x', resultId: FAIL_RESULT, testCaseId: 'tc-002' }, '다른 TC');
      const created = await repos.issues.create({ projectId: PROJECT_A, type: 'defect', title: '미연결 결과', resultId: FAIL_RESULT });
      expect(created).toMatchObject({ resultId: FAIL_RESULT });
      expect(created).not.toHaveProperty('testCaseId');
    });

    it('resultId와 다른 입력 TC는 거부한다', async () => {
      const { store, repos } = await withResultTestCase('tc-002');
      await expectRejected(store, repos, { projectId: PROJECT_A, type: 'defect', title: 'x', resultId: FAIL_RESULT, testCaseId: 'tc-001' }, '다른 TC');
    });

    it('저장에 실패해도 이슈 · 활동이 남지 않는다', async () => {
      const { store: base, failNext } = failingOnce(createMemoryStateStore());
      const repos = await openTab(base);
      const before = await storedState(base);
      const activities = await repos.activities.list();
      failNext();
      await expect(repos.issues.create({ projectId: PROJECT_A, type: 'defect', title: 'x', resultId: FAIL_RESULT })).rejects.toBeInstanceOf(PersistenceError);
      expect(await storedState(base)).toEqual(before);
      expect(await repos.activities.list()).toEqual(activities);
    });
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
