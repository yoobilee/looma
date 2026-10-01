import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeTestAssetImport, defaultDecisionFor, suggestColumnMapping, toImportTable, type ImportTable } from '@/domain/testAssetImport';
import { analyzeResultImport, defaultResultDecisionFor, suggestResultColumnMapping } from '@/domain/testResultImport';
import { parseCsv } from '@/lib/csv';
import { PersistenceError } from '../persistenceError';
import type { Repositories } from '../repositories/types';
import { createSeed, PROJECT_A } from '../mock/seed';
import { CURRENT_SCHEMA_VERSION, type AppData, type StoredAppState } from './appData';
import { openIndexedDbStateStore } from './indexedDbStateStore';
import { createLocalRepositories, type LocalRepositoryOptions } from './localRepositories';
import { createBroadcastStateChannel } from './stateChannel';

/*
 * 실제 브라우저(Chromium) IndexedDB에서 저장소 규칙을 확인한다. 메모리 저장소로는 잡을 수 없는 회귀가 대상이다.
 * - add가 같은 key에서 ConstraintError를 내고 transaction 전체(앞서 쓴 원본 · 상태)가 되돌려지는지
 * - revision 확인과 쓰기가 한 transaction이라 오래된 revision · 동시 저장이 덮어쓰지 못하는지
 * - 요청 오류가 PersistenceError로 그대로 올라오는지(성공 · 다른 오류로 바뀌지 않는지)
 * 제품 코드(openIndexedDbStateStore · createLocalRepositories)를 그대로 쓰고, 테스트마다 다른 DB 이름만 끼워 넣는다.
 * 저장된 결과는 제품 코드를 거치지 않고 IndexedDB를 직접 열어 확인한다.
 */

/* ---------- 테스트마다 다른 DB ---------- */

const databases: string[] = [];

/** 제품 코드가 여는 DB 이름(looma)을 이 테스트만의 이름으로 바꾸는 IDBFactory. 그 밖의 동작은 실제 IndexedDB 그대로다. */
function isolatedFactory(): { factory: IDBFactory; name: string } {
  const name = `looma-test-${crypto.randomUUID()}`;
  databases.push(name);
  const factory = { open: (_name: string, version?: number) => indexedDB.open(name, version) } as Pick<IDBFactory, 'open'> as IDBFactory;
  return { factory, name };
}

const request = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/**
 * 테스트 DB를 지운다. 제품 코드의 연결은 versionchange에 스스로 닫힌다.
 * blocked 이벤트는 닫기가 아직 끝나지 않은 연결(마지막 transaction이 마무리 중)이 있을 때도 잠시 오며, 그 연결이 닫히면 삭제가 이어진다.
 * 그래서 blocked는 실패로 보지 않고 success를 기다린다. 연결이 끝내 닫히지 않으면 hook 시간 초과로 실패한다.
 */
function deleteDatabase(name: string) {
  return new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map(deleteDatabase));
  expect((await indexedDB.databases()).filter((db) => db.name?.startsWith('looma-test-'))).toEqual([]);
});

/** 제품 코드를 거치지 않고 저장된 상태와 원본 파일을 읽는다. */
async function inspectDatabase(name: string) {
  const db = await request(indexedDB.open(name));
  try {
    const transaction = db.transaction(['state', 'artifactBytes'], 'readonly');
    const [state, artifactKeys] = await Promise.all([
      request(transaction.objectStore('state').get('app-state')) as Promise<StoredAppState & { data: AppData }>,
      request(transaction.objectStore('artifactBytes').getAllKeys()),
    ]);
    const artifacts = new Map<string, string>();
    for (const key of artifactKeys) {
      const blob = (await request(db.transaction('artifactBytes', 'readonly').objectStore('artifactBytes').get(key))) as Blob;
      artifacts.set(String(key), await blob.text());
    }
    return { state, artifacts };
  } finally {
    db.close();
  }
}

const initialState = (revision = 1): StoredAppState => ({ schemaVersion: CURRENT_SCHEMA_VERSION, revision, savedAt: 'init', data: createSeed() });
const withMarker = (marker: string): AppData => {
  const data = createSeed();
  data.tasks[0].title = marker;
  return data;
};
const commitInput = (expectedRevision: number, marker: string, artifacts: [string, string][] = []) => ({
  expectedRevision,
  schemaVersion: CURRENT_SCHEMA_VERSION,
  savedAt: marker,
  data: withMarker(marker),
  artifacts: artifacts.map(([id, text]) => ({ id, bytes: new Blob([text]) })),
});

/** 실패가 PersistenceError(kind)로 왔는지. 성공으로 끝나거나 다른 종류로 바뀌면 실패다. */
async function expectPersistenceError(promise: Promise<unknown>, kind: PersistenceError['kind']) {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(PersistenceError);
  expect((error as PersistenceError).kind).toBe(kind);
}

/* ---------- StateStore ---------- */

describe('IndexedDB StateStore (실제 Chromium)', () => {
  it('이미 있는 원본 key를 add하면 ConstraintError로 transaction 전체를 되돌리고, 기존 원본 · 상태 · revision은 그대로다', async () => {
    const { factory, name } = isolatedFactory();
    const store = await openIndexedDbStateStore(factory);
    await store.initialize(initialState());
    await store.commit(commitInput(1, '첫 저장', [['src-1', '원래 원본']]));
    const before = await inspectDatabase(name);
    expect(before.state.revision).toBe(2);

    // 새 원본(src-new)을 먼저 add하고, 이미 있는 src-1을 add한다. 앞의 add와 상태 쓰기까지 모두 되돌려져야 한다.
    await expectPersistenceError(store.commit(commitInput(2, '덮어쓰기 시도', [['src-new', '새 원본'], ['src-1', '덮어쓴 원본']])), 'artifact_duplicate');

    const after = await inspectDatabase(name);
    expect(after).toEqual(before);
    expect([...after.artifacts]).toEqual([['src-1', '원래 원본']]);
    expect(after.state.data.tasks[0].title).toBe('첫 저장');
  });

  it('한 저장 안에서 같은 원본 key가 두 번 있어도 전부 되돌린다', async () => {
    const { factory, name } = isolatedFactory();
    const store = await openIndexedDbStateStore(factory);
    await store.initialize(initialState());
    const before = await inspectDatabase(name);

    await expectPersistenceError(store.commit(commitInput(1, '중복 요청', [['src-2', 'a'], ['src-2', 'b']])), 'artifact_duplicate');
    expect(await inspectDatabase(name)).toEqual(before);
  });

  it('실패한 저장 뒤에도 연결 · transaction이 막히지 않고 같은 revision으로 다시 저장할 수 있다', async () => {
    const { factory, name } = isolatedFactory();
    const store = await openIndexedDbStateStore(factory);
    await store.initialize(initialState());
    await store.commit(commitInput(1, '첫 저장', [['src-1', '원래 원본']]));
    await expectPersistenceError(store.commit(commitInput(2, '실패', [['src-1', 'x']])), 'artifact_duplicate');

    expect(await store.commit(commitInput(2, '다시 저장', [['src-2', '두 번째 원본']]))).toEqual({ revision: 3, savedAt: '다시 저장' });
    const saved = await inspectDatabase(name);
    expect(saved.state).toMatchObject({ revision: 3, savedAt: '다시 저장' });
    expect([...saved.artifacts]).toEqual([
      ['src-1', '원래 원본'],
      ['src-2', '두 번째 원본'],
    ]);
  });

  it('revision이 다르면 conflict로 거부하고 원본 · 상태를 쓰지 않는다', async () => {
    const { factory, name } = isolatedFactory();
    const store = await openIndexedDbStateStore(factory);
    await store.initialize(initialState());
    await store.commit(commitInput(1, '최신'));
    const before = await inspectDatabase(name);

    for (const stale of [1, 3]) {
      await expectPersistenceError(store.commit(commitInput(stale, `오래된 revision ${stale}`, [['src-stale', '쓰이면 안 되는 원본']])), 'conflict');
    }
    expect(await inspectDatabase(name)).toEqual(before);
  });

  it('두 연결이 같은 revision으로 동시에 저장하면 하나만 저장되고 다른 하나는 conflict다(덮어쓰기 없음)', async () => {
    const { factory, name } = isolatedFactory();
    const tabA = await openIndexedDbStateStore(factory);
    const tabB = await openIndexedDbStateStore(factory);
    await tabA.initialize(initialState());

    const results = await Promise.allSettled([tabA.commit(commitInput(1, 'A 탭', [['src-a', 'A 원본']])), tabB.commit(commitInput(1, 'B 탭', [['src-b', 'B 원본']]))]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(PersistenceError);
    expect(rejected[0].reason.kind).toBe('conflict');

    const winner = results[0].status === 'fulfilled' ? 'A' : 'B';
    const saved = await inspectDatabase(name);
    expect(saved.state.revision).toBe(2);
    expect(saved.state.data.tasks[0].title).toBe(`${winner} 탭`);
    expect([...saved.artifacts]).toEqual([[`src-${winner.toLowerCase()}`, `${winner} 원본`]]);
  });

  it('두 연결이 처음 동시에 열어도 먼저 만든 상태 하나만 남는다', async () => {
    const { factory, name } = isolatedFactory();
    const tabA = await openIndexedDbStateStore(factory);
    const tabB = await openIndexedDbStateStore(factory);
    const [fromA, fromB] = await Promise.all([tabA.initialize({ ...initialState(), savedAt: 'A' }), tabB.initialize({ ...initialState(), savedAt: 'B' })]);
    expect((fromA as StoredAppState).savedAt).toBe((fromB as StoredAppState).savedAt);
    expect((await inspectDatabase(name)).state.savedAt).toBe((fromA as StoredAppState).savedAt);
  });

  it('저장이 끝났다고 알린 뒤에는 새 연결에서도 원본 bytes(Blob)와 상태가 그대로 보인다', async () => {
    const { factory } = isolatedFactory();
    const store = await openIndexedDbStateStore(factory);
    await store.initialize(initialState());
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 0x50, 0x4b]);
    await store.commit({ ...commitInput(1, '저장'), artifacts: [{ id: 'src-bin', bytes: new Blob([bytes]) }] });

    const reopened = await openIndexedDbStateStore(factory);
    expect((await reopened.read()) as StoredAppState).toMatchObject({ revision: 2, savedAt: '저장' });
    const blob = await reopened.readArtifactBytes('src-bin');
    expect(blob).toBeInstanceOf(Blob);
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(bytes);
  });
});

/* ---------- 저장소(가져오기) + 실제 IndexedDB ---------- */

const TC_HEADERS = ['TC ID', '테스트 관점', '대분류', '중분류', '소분류', '테스트 항목', 'Pre-condition', 'Test Step', 'Expected Result'];
const csv = (rows: string[][]) => rows.map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(',')).join('\r\n');

async function openTab(factory: IDBFactory, options: Partial<LocalRepositoryOptions> = {}) {
  const repos = createLocalRepositories({ openStore: () => openIndexedDbStateStore(factory), ...options });
  await repos.persistence.load();
  expect(repos.persistence.getStatus()).toMatchObject({ state: 'ready', mode: 'local' });
  return repos;
}

async function tcImport(repos: Repositories, sourceText: string, externalId: string) {
  const table = toImportTable(parseCsv(csv([TC_HEADERS, [externalId, '예외', '마이페이지', '프로필', '닉네임', `${externalId} 저장`, '로그인', '1. 저장한다.', '저장 완료']]))) as ImportTable;
  const mapping = suggestColumnMapping(table.headers);
  const analysis = analyzeTestAssetImport(table, mapping, await repos.testCases.listByProject(PROJECT_A));
  const decisions = analysis.rows.map((item) => ({ rowNumber: item.row.rowNumber, kind: item.kind, targetId: item.targetId, decision: defaultDecisionFor(item)! }));
  return repos.testAssetImports.apply({ projectId: PROJECT_A, fileName: `${externalId}.csv`, table, mapping, decisions, source: { bytes: new Blob([sourceText]), format: 'csv' } });
}

async function resultImport(repos: Repositories, sourceText: string) {
  const table = toImportTable(parseCsv(csv([['TC ID', '테스트 항목', '결과', '비고'], ['SIGN-001', '로그인', 'P', ''], ['SIGN-002', '로그아웃', 'F', '재현']]))) as ImportTable;
  const mapping = suggestResultColumnMapping(table.headers);
  const project = (await repos.projects.get(PROJECT_A))!;
  const templateMappings = (await repos.templates.get(project.tcTemplateId!))?.resultMappings ?? [];
  const analysis = analyzeResultImport(table, mapping, await repos.testCases.listByProject(PROJECT_A), templateMappings);
  const rowDecisions = analysis.rows.map((item) => ({ rowNumber: item.row.rowNumber, kind: item.kind, testCaseId: item.testCaseId, decision: defaultResultDecisionFor(item)! }));
  return repos.testResults.importResults({
    projectId: PROJECT_A,
    fileName: '수행결과_3차.csv',
    table,
    mapping,
    cycle: { round: 3, executionType: 'full', executedFrom: '2026-09-28' },
    rowDecisions,
    valueDecisions: {},
    source: { bytes: new Blob([sourceText]), format: 'csv' },
  });
}

/** 두 탭이 같은 원본 ID를 만드는 상황을 강제로 만든다. */
const sameIds = (prefix: string) => `${prefix}-fixed`;

/** 이 탭이 화면에 들고 있는 가져오기 관련 상태 */
async function memoryView(repos: Repositories) {
  return {
    testCases: await repos.testCases.listByProject(PROJECT_A),
    tcImports: await repos.testAssetImports.listByProject(PROJECT_A),
    resultImports: await repos.testResults.listImports(PROJECT_A),
  };
}

describe('가져오기 원자성 (저장소 + 실제 IndexedDB)', () => {
  it('TC 가져오기가 원본 · 상태를 함께 저장하고, 새 연결로 다시 열어도 같다', async () => {
    const { factory, name } = isolatedFactory();
    const tab = await openTab(factory);
    const session = await tcImport(tab, '원본 TC 파일', 'OK-001');

    const saved = await inspectDatabase(name);
    expect([...saved.artifacts]).toEqual([[session.artifactId, '원본 TC 파일']]);
    expect(saved.state.data.importSourceArtifacts.map((artifact) => artifact.id)).toEqual([session.artifactId]);
    const reopened = await openTab(factory);
    expect(await (await reopened.importSources.getBytes(session.artifactId!))!.length).toBe(new TextEncoder().encode('원본 TC 파일').length);
    expect((await reopened.testAssetImports.listByProject(PROJECT_A)).map((item) => item.id)).toContain(session.id);
  });

  it('TC 가져오기의 원본 ID가 이미 있으면 TC · 가져오기 기록 · 원본이 하나도 바뀌지 않는다(ConstraintError → artifact_duplicate)', async () => {
    const { factory, name } = isolatedFactory();
    const tabA = await openTab(factory, { createId: sameIds });
    const tabB = await openTab(factory, { createId: sameIds });
    await tcImport(tabA, '첫 번째 원본', 'A-001');
    await tabB.persistence.reloadLatest();
    const stored = await inspectDatabase(name);
    const view = await memoryView(tabB);

    await expectPersistenceError(tcImport(tabB, '두 번째 원본', 'B-001'), 'artifact_duplicate');

    expect(await inspectDatabase(name)).toEqual(stored);
    expect([...stored.artifacts]).toEqual([['src-fixed', '첫 번째 원본']]);
    expect(stored.state.data.testCases.some((item) => item.title.includes('B-001'))).toBe(false);
    expect(await memoryView(tabB)).toEqual(view);
    expect(tabB.persistence.getStatus()).toMatchObject({ state: 'ready', stale: false, error: expect.stringContaining('기존 원본 파일은 그대로') });
  });

  it('수행 결과 가져오기의 원본 ID가 이미 있으면 차수 · 결과 · 원본이 하나도 바뀌지 않는다', async () => {
    const { factory, name } = isolatedFactory();
    const tab = await openTab(factory, { createId: sameIds });
    await tcImport(tab, 'TC 원본', 'A-001');
    const stored = await inspectDatabase(name);
    const view = await memoryView(tab);

    await expectPersistenceError(resultImport(tab, '결과 원본'), 'artifact_duplicate');

    expect(await inspectDatabase(name)).toEqual(stored);
    expect([...stored.artifacts]).toEqual([['src-fixed', 'TC 원본']]);
    expect(await memoryView(tab)).toEqual(view);
  });

  it.each([
    ['TC', (repos: Repositories) => tcImport(repos, '쓰이면 안 되는 TC 원본', 'B-001')],
    ['수행 결과', (repos: Repositories) => resultImport(repos, '쓰이면 안 되는 결과 원본')],
  ])('%s 가져오기를 오래된 revision으로 저장하면 conflict이고, 원본만 남거나 상태만 남지 않는다', async (_, run) => {
    const { factory, name } = isolatedFactory();
    const tabA = await openTab(factory);
    const tabB = await openTab(factory);
    await tabA.tasks.create({ title: 'A 탭이 먼저 저장' });
    const stored = await inspectDatabase(name);
    const view = await memoryView(tabB);

    await expectPersistenceError(run(tabB), 'conflict');

    expect(await inspectDatabase(name)).toEqual(stored);
    expect(stored.artifacts.size).toBe(0);
    expect(stored.state.data.tasks.some((task) => task.title === 'A 탭이 먼저 저장')).toBe(true);
    expect(await memoryView(tabB)).toEqual(view);
    expect(tabB.persistence.getStatus()).toMatchObject({ state: 'ready', stale: true });
  });

  it('BroadcastChannel 알림으로 다른 탭이 미리 오래된 상태가 되고, 다시 불러온 뒤 저장해도 앞선 저장을 덮어쓰지 않는다', async () => {
    const { factory, name } = isolatedFactory();
    const tabA = await openTab(factory, { channel: createBroadcastStateChannel() });
    const tabB = await openTab(factory, { channel: createBroadcastStateChannel() });

    const fromA = await tcImport(tabA, 'A 원본', 'A-001');
    await vi.waitFor(() => expect(tabB.persistence.getStatus()).toMatchObject({ stale: true }));
    await expectPersistenceError(tabB.tasks.create({ title: 'B 탭 업무' }), 'conflict');

    await tabB.persistence.reloadLatest();
    const fromB = await tcImport(tabB, 'B 원본', 'B-001');
    const saved = await inspectDatabase(name);
    expect(saved.state.revision).toBe(3);
    const ids = (items: { id: string }[]) => items.map((item) => item.id).sort();
    // B 탭 메모리와 저장소가 같고, A 탭의 가져오기가 남아 있다.
    expect(ids(saved.state.data.testAssetImports)).toEqual(ids((await memoryView(tabB)).tcImports));
    expect(ids(saved.state.data.testAssetImports)).toEqual(expect.arrayContaining([fromA.id, fromB.id]));
    expect(saved.artifacts.get(fromA.artifactId!)).toBe('A 원본');
    expect(saved.artifacts.get(fromB.artifactId!)).toBe('B 원본');
    expect(saved.state.data.tasks.some((task) => task.title === 'B 탭 업무')).toBe(false);
  });

  it('초기화는 상태와 원본을 한 transaction으로 지우고 revision을 올린다', async () => {
    const { factory, name } = isolatedFactory();
    const tab = await openTab(factory);
    await tcImport(tab, '지워질 원본', 'A-001');
    const before = await inspectDatabase(name);

    await tab.persistence.resetToSeed();

    const after = await inspectDatabase(name);
    expect(after.artifacts.size).toBe(0);
    expect(after.state.revision).toBe(before.state.revision + 1);
    expect(after.state.data.importSourceArtifacts).toEqual([]);
  });
});
