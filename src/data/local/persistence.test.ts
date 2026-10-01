import { describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { buildImportHistory } from '@/domain/importHistory';
import { toImportSourceSnapshot } from '@/domain/importSource';
import { analyzeTestAssetImport, defaultDecisionFor, suggestColumnMapping, toImportTable, type ImportTable } from '@/domain/testAssetImport';
import { analyzeResultImport, defaultResultDecisionFor, suggestResultColumnMapping } from '@/domain/testResultImport';
import { parseCsv } from '@/lib/csv';
import { PersistenceError } from '../persistenceError';
import type { ImportSourceFileInput, PersistenceStatus, Repositories } from '../repositories/types';
import { createSeed, PROJECT_A } from '../mock/seed';
import { CURRENT_SCHEMA_VERSION, type AppData, type StoredAppState } from './appData';
import { createLocalRepositories } from './localRepositories';
import { migrateAppData } from './migrations';
import { createMemoryChannelHub, type StateChannel } from './stateChannel';
import { createMemoryStateStore, type StateStore } from './stateStore';

/* ---------- 준비 ---------- */

type Failure = 'quota' | 'write' | 'read';

/** 메모리 저장소에 실패를 끼워 넣는다. 실패한 쓰기는 IndexedDB transaction abort처럼 아무것도 남기지 않는다. */
function faultyStore(base = createMemoryStateStore()) {
  let next: { commit?: Failure; replaceAll?: Failure; readArtifact?: Failure } = {};
  const fail = (failure: Failure): never => {
    if (failure === 'quota') throw new DOMException('quota', 'QuotaExceededError');
    throw new Error(`${failure} failed`);
  };
  const store: StateStore = {
    read: () => base.read(),
    initialize: (state) => base.initialize(state),
    async commit(input) {
      if (next.commit) fail(next.commit);
      return base.commit(input);
    },
    async replaceAll(input) {
      if (next.replaceAll) fail(next.replaceAll);
      return base.replaceAll(input);
    },
    async readArtifactBytes(id) {
      if (next.readArtifact) fail(next.readArtifact);
      return base.readArtifactBytes(id);
    },
  };
  return {
    store,
    base,
    failNext(kind: keyof typeof next, failure: Failure) {
      next = { [kind]: failure };
    },
    heal() {
      next = {};
    },
  };
}

/** 같은 저장소를 쓰는 탭 하나. load까지 마친 저장소를 돌려준다. */
async function openTab(store: StateStore, options: { channel?: StateChannel; createInitialData?: () => AppData } = {}) {
  const repos = createLocalRepositories({ openStore: async () => store, ...options });
  await repos.persistence.load();
  return repos;
}

const ready = (repos: Repositories) => repos.persistence.getStatus() as Extract<PersistenceStatus, { state: 'ready' }>;
const storedState = async (store: StateStore) => (await store.read()) as StoredAppState & { data: AppData };

/* ---------- 가져오기 입력 ---------- */

const TC_HEADERS = ['TC ID', '테스트 관점', '대분류', '중분류', '소분류', '테스트 항목', 'Pre-condition', 'Test Step', 'Expected Result', '고객사 메모'];
const tcRow = (externalId: string, title: string) => [externalId, '예외', '마이페이지', '프로필', '닉네임', title, '로그인 상태', '1. 프로필로 이동한다.\n2. 저장한다.', '저장 완료 안내 노출', '고객사 메모 ✓'];

const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const csvText = (rows: string[][]) => rows.map((row) => row.map(quote).join(',')).join('\r\n');

function xlsxBytes(rows: string[][], sheetName: string): Uint8Array<ArrayBuffer> {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['표지']]), '표지');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), sheetName);
  return new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

async function tcImport(repos: Repositories, source?: ImportSourceFileInput, fileName = '고객사A_기존TC.xlsx') {
  const table = toImportTable(parseCsv(csvText([TC_HEADERS, tcRow('MY-001', '닉네임 변경 시 저장 가능')]))) as ImportTable;
  const mapping = suggestColumnMapping(table.headers);
  const analysis = analyzeTestAssetImport(table, mapping, await repos.testCases.listByProject(PROJECT_A));
  const decisions = analysis.rows.map((item) => ({ rowNumber: item.row.rowNumber, kind: item.kind, targetId: item.targetId, decision: defaultDecisionFor(item)! }));
  return { table, mapping, apply: () => repos.testAssetImports.apply({ projectId: PROJECT_A, fileName, table, mapping, decisions, source }) };
}

const RESULT_HEADERS = ['TC ID', '테스트 항목', '결과', '비고'];

async function resultImport(repos: Repositories, source?: ImportSourceFileInput) {
  const table = toImportTable(parseCsv(csvText([RESULT_HEADERS, ['SIGN-001', '로그인', 'P', ''], ['SIGN-002', '로그아웃', 'F', '재현']]))) as ImportTable;
  const mapping = suggestResultColumnMapping(table.headers);
  const project = (await repos.projects.get(PROJECT_A))!;
  const templateMappings = (await repos.templates.get(project.tcTemplateId!))?.resultMappings ?? [];
  const analysis = analyzeResultImport(table, mapping, await repos.testCases.listByProject(PROJECT_A), templateMappings);
  const rowDecisions = analysis.rows.map((item) => ({ rowNumber: item.row.rowNumber, kind: item.kind, testCaseId: item.testCaseId, decision: defaultResultDecisionFor(item)! }));
  return {
    table,
    mapping,
    apply: () =>
      repos.testResults.importResults({
        projectId: PROJECT_A,
        fileName: '고객사A_수행결과_3차.csv',
        table,
        mapping,
        cycle: { round: 3, executionType: 'full', executedFrom: '2026-09-28' },
        rowDecisions,
        valueDecisions: {},
        source,
      }),
  };
}

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array) => !!a && a.length === b.length && a.every((byte, index) => byte === b[index]);

/* ---------- 처음 실행 · 새로고침 ---------- */

describe('처음 실행과 새로고침', () => {
  it('저장된 상태가 없을 때만 예시 데이터를 만들어 schemaVersion 1 · revision 1로 저장한다', async () => {
    const store = createMemoryStateStore();
    const createInitialData = vi.fn(createSeed);
    const repos = await openTab(store, { createInitialData });

    expect(createInitialData).toHaveBeenCalledTimes(1);
    expect(ready(repos)).toMatchObject({ state: 'ready', mode: 'local', revision: 1, stale: false });
    expect(await storedState(store)).toMatchObject({ schemaVersion: CURRENT_SCHEMA_VERSION, revision: 1 });

    await openTab(store, { createInitialData });
    expect(createInitialData).toHaveBeenCalledTimes(1);
  });

  it('변경은 새로고침 뒤에도 남는다', async () => {
    const store = createMemoryStateStore();
    const first = await openTab(store);
    const task = await first.tasks.create({ title: '새로고침 확인 업무' });
    await first.tasks.updateStatus(task.id, 'done');

    const reloaded = await openTab(store);
    expect(await reloaded.tasks.get(task.id)).toMatchObject({ title: '새로고침 확인 업무', status: 'done' });
    expect((await reloaded.activities.list())[0]).toMatchObject({ type: 'task_completed', taskId: task.id });
    expect(ready(reloaded).revision).toBe(3);
  });

  it('예시 데이터의 날짜는 처음 만든 값 그대로이고, 날짜가 바뀌어도 다시 계산하지 않는다', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-01T09:00:00'));
      const store = createMemoryStateStore();
      const first = await openTab(store);
      const before = (await first.tasks.list()).map((task) => task.dueAt);

      vi.setSystemTime(new Date('2026-10-05T09:00:00'));
      const later = await openTab(store);
      expect((await later.tasks.list()).map((task) => task.dueAt)).toEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('불러오기 전에는 loading 상태이고 변경을 거부한다', async () => {
    const repos = createLocalRepositories({ openStore: async () => createMemoryStateStore() });
    expect(repos.persistence.getStatus()).toEqual({ state: 'loading' });
    await expect(repos.tasks.create({ title: 'x' })).rejects.toBeInstanceOf(PersistenceError);
  });
});

/* ---------- 모든 변경 저장 ---------- */

describe('저장소 변경은 모두 저장된다', () => {
  it('업무 · 프로젝트 · 산출물 · 템플릿 · TC · 이슈 · 지식 · 임시함 · 변경 영향 판단이 새로고침 뒤에도 남는다', async () => {
    const store = createMemoryStateStore();
    const repos = await openTab(store);
    let expectedRevision = 1;
    const step = async <T>(run: () => Promise<T>) => {
      const result = await run();
      expectedRevision += 1;
      expect(ready(repos).revision).toBe(expectedRevision);
      return result;
    };

    const task = await step(() => repos.tasks.create({ title: '저장 확인' }));
    await step(() => repos.tasks.updateStatus(task.id, 'in_progress'));
    const project = await step(() => repos.projects.create({ name: '새 프로젝트', platforms: ['android'], testScopes: ['functional'] }));
    const deliverable = await step(() => repos.deliverables.create({ projectId: project.id, type: 'pdf', title: '기획서' }));
    const template = await step(() => repos.templates.saveForProject(project.id, { name: '양식', columns: [], resultMappings: [] } as never));
    const [testCase] = await repos.testCases.listByProject(PROJECT_A);
    await step(() => repos.testCases.updateStatus(testCase.id, 'reviewed'));
    const issue = await step(() => repos.issues.create({ projectId: PROJECT_A, type: 'defect', title: '저장 확인 이슈' }));
    await step(() => repos.issues.updateStatus(issue.id, 'closed'));
    const term = await step(() => repos.knowledge.create({ term: '회귀', explanation: '설명' }));
    await step(() => repos.knowledge.update(term.id, { explanation: '바뀐 설명' }));
    const scratch = await step(() => repos.scratch.create({ type: 'text', content: '임시 메모' }));
    await step(() => repos.scratch.pin(scratch.id, 'record'));
    const removable = await step(() => repos.scratch.create({ type: 'text', content: '지울 메모' }));
    await step(() => repos.scratch.remove(removable.id));

    const [analysis] = await repos.changeAnalyses.listByProject(PROJECT_A);
    const change = analysis.requirementChanges.find((item) => item.kind !== 'unchanged');
    if (analysis.status === 'draft' && change) await step(() => repos.changeAnalyses.updateRequirementDecision(analysis.id, change.id, 'accepted'));

    const reloaded = await openTab(store);
    expect(await reloaded.tasks.get(task.id)).toMatchObject({ status: 'in_progress' });
    expect(await reloaded.projects.get(project.id)).toMatchObject({ name: '새 프로젝트', tcTemplateId: template.id });
    expect((await reloaded.deliverables.listByProject(project.id)).map((item) => item.id)).toEqual([deliverable.id]);
    expect(await reloaded.templates.get(template.id)).toBeDefined();
    expect((await reloaded.testCases.listByProject(PROJECT_A)).find((item) => item.id === testCase.id)).toMatchObject({ status: 'reviewed' });
    expect((await reloaded.issues.listByProject(PROJECT_A)).find((item) => item.id === issue.id)).toMatchObject({ status: 'closed' });
    expect(await reloaded.knowledge.get(term.id)).toMatchObject({ explanation: '바뀐 설명' });
    const scratchAfter = await reloaded.scratch.list();
    expect(scratchAfter.find((item) => item.id === scratch.id)).toMatchObject({ linkedType: 'record' });
    expect(scratchAfter.some((item) => item.id === removable.id)).toBe(false);
    if (analysis.status === 'draft' && change) {
      const [reloadedAnalysis] = await reloaded.changeAnalyses.listByProject(PROJECT_A);
      expect(reloadedAnalysis.requirementChanges.find((item) => item.id === change.id)?.decision).toBe('accepted');
    }
    expect(ready(reloaded).revision).toBe(expectedRevision);
  });

  it('상태가 같은 업무 상태 변경은 저장하지 않는다', async () => {
    const store = createMemoryStateStore();
    const repos = await openTab(store);
    const task = await repos.tasks.create({ title: '같은 상태' });
    await repos.tasks.updateStatus(task.id, 'planned');
    expect(ready(repos).revision).toBe(2);
  });
});

/* ---------- 저장 실패 ---------- */

describe('저장 실패', () => {
  it('저장에 실패하면 메모리 · 저장소 모두 그대로이고 실패를 알린다', async () => {
    const { store, failNext } = faultyStore();
    const repos = await openTab(store);
    const tasksBefore = await repos.tasks.list();
    const storedBefore = await storedState(store);

    failNext('commit', 'write');
    await expect(repos.tasks.create({ title: '저장 실패 업무' })).rejects.toMatchObject({ kind: 'write_failed' });

    expect(await repos.tasks.list()).toEqual(tasksBefore);
    expect(await storedState(store)).toEqual(storedBefore);
    expect(ready(repos).error).toContain('저장하지 못했어요');
  });

  it('저장 공간이 부족하면 quota로 알리고 반영하지 않는다', async () => {
    const { store, failNext } = faultyStore();
    const repos = await openTab(store);
    const scratchBefore = await repos.scratch.list();
    failNext('commit', 'quota');
    await expect(repos.scratch.create({ type: 'text', content: '메모' })).rejects.toMatchObject({ kind: 'quota' });
    expect(await repos.scratch.list()).toEqual(scratchBefore);
    expect(ready(repos).error).toContain('저장 공간');
  });

  it('검증에 실패한 변경은 저장소에 쓰지 않는다', async () => {
    const store = createMemoryStateStore();
    const repos = await openTab(store);
    await expect(repos.issues.updateStatus('issue-missing', 'closed')).rejects.toThrow('이슈을(를) 찾을 수 없어요');
    expect((await storedState(store)).revision).toBe(1);
  });

  it('저장 실패 뒤 다시 시도하면 정상 저장되고 안내가 사라진다', async () => {
    const { store, failNext, heal } = faultyStore();
    const repos = await openTab(store);
    failNext('commit', 'write');
    await expect(repos.tasks.create({ title: '다시 시도' })).rejects.toBeInstanceOf(PersistenceError);
    heal();
    const task = await repos.tasks.create({ title: '다시 시도' });
    expect(ready(repos).error).toBeUndefined();
    expect(await (await openTab(store)).tasks.get(task.id)).toBeDefined();
  });

  it('동시에 시작한 변경도 차례로 저장되어 서로 덮어쓰지 않는다', async () => {
    const store = createMemoryStateStore();
    const repos = await openTab(store);
    const [a, b] = await Promise.all([repos.tasks.create({ title: '동시 A' }), repos.tasks.create({ title: '동시 B' })]);
    const reloaded = await openTab(store);
    expect(await reloaded.tasks.get(a.id)).toBeDefined();
    expect(await reloaded.tasks.get(b.id)).toBeDefined();
  });
});

/* ---------- 여러 탭 ---------- */

describe('여러 탭', () => {
  it('다른 탭이 먼저 저장했으면 오래된 revision의 저장을 거부하고 다른 탭의 데이터를 지킨다(알림 없이도)', async () => {
    const store = createMemoryStateStore();
    const tabA = await openTab(store);
    const tabB = await openTab(store);

    const fromA = await tabA.tasks.create({ title: 'A 탭 업무' });
    await expect(tabB.tasks.create({ title: 'B 탭 업무' })).rejects.toMatchObject({ kind: 'conflict' });

    const stored = await storedState(store);
    expect(stored.revision).toBe(2);
    expect(stored.data.tasks.some((task) => task.id === fromA.id)).toBe(true);
    expect(stored.data.tasks.some((task) => task.title === 'B 탭 업무')).toBe(false);
    expect(ready(tabB)).toMatchObject({ stale: true });

    // 다시 불러오기 전에는 이후 변경도 저장하지 않는다.
    await expect(tabB.tasks.create({ title: 'B 탭 두 번째' })).rejects.toMatchObject({ kind: 'conflict' });
  });

  it('최신 데이터를 불러오면 다른 탭의 변경이 보이고 다시 저장할 수 있다', async () => {
    const store = createMemoryStateStore();
    const tabA = await openTab(store);
    const tabB = await openTab(store);
    const fromA = await tabA.tasks.create({ title: 'A 탭 업무' });
    await expect(tabB.tasks.create({ title: 'B 탭 업무' })).rejects.toBeInstanceOf(PersistenceError);

    await tabB.persistence.reloadLatest();
    expect(ready(tabB)).toMatchObject({ stale: false, revision: 2 });
    expect(await tabB.tasks.get(fromA.id)).toBeDefined();
    await tabB.tasks.create({ title: 'B 탭 업무' });
    expect((await storedState(store)).revision).toBe(3);
  });

  it('BroadcastChannel 알림을 받으면 저장 전에 미리 오래된 상태로 표시하고, 화면 데이터는 덮어쓰지 않는다', async () => {
    const store = createMemoryStateStore();
    const hub = createMemoryChannelHub();
    const tabA = await openTab(store, { channel: hub.connect() });
    const tabB = await openTab(store, { channel: hub.connect() });
    const tasksInB = await tabB.tasks.list();

    await tabA.tasks.create({ title: 'A 탭 업무' });
    expect(ready(tabB).stale).toBe(true);
    expect(ready(tabA).stale).toBe(false);
    expect(await tabB.tasks.list()).toEqual(tasksInB);
  });
});

/* ---------- schema version ---------- */

describe('schema version', () => {
  const v1 = (): StoredAppState => ({ schemaVersion: 1, revision: 4, savedAt: '2026-10-01T00:00:00.000Z', data: createSeed() });

  it('현재 버전은 그대로 읽는다', async () => {
    const repos = await openTab(createMemoryStateStore(v1()));
    expect(ready(repos).revision).toBe(4);
  });

  it('이 앱보다 새 버전이면 막고, 저장된 데이터는 지우지 않는다', async () => {
    const store = createMemoryStateStore({ ...v1(), schemaVersion: 99 });
    const before = await storedState(store);
    const repos = await openTab(store);
    expect(repos.persistence.getStatus()).toMatchObject({ state: 'blocked', reason: 'unsupported_version' });
    expect(await storedState(store)).toEqual(before);
    await expect(repos.tasks.create({ title: 'x' })).rejects.toBeInstanceOf(PersistenceError);
  });

  it('모양이 맞지 않는 데이터는 corrupt로 막고 지우지 않는다', async () => {
    const store = createMemoryStateStore({ schemaVersion: 1, revision: 2, savedAt: 'x', data: { tasks: 'broken' } });
    const repos = await openTab(store);
    expect(repos.persistence.getStatus()).toMatchObject({ state: 'blocked', reason: 'corrupt' });
    expect((await storedState(store)).data).toEqual({ tasks: 'broken' });
  });

  it('이전 버전이면 변환해 현재 버전으로 저장하고 revision을 올린다', async () => {
    const store = createMemoryStateStore(v1());
    const migrate = vi.fn((data: unknown) => data);
    const repos = createLocalRepositories({ openStore: async () => store, schema: { currentVersion: 2, migrations: { 1: migrate } } });
    await repos.persistence.load();

    expect(migrate).toHaveBeenCalledTimes(1);
    expect(ready(repos).revision).toBe(5);
    expect(await storedState(store)).toMatchObject({ schemaVersion: 2, revision: 5 });
    // 이후 저장도 새 버전으로 기록된다.
    await repos.tasks.create({ title: '변환 뒤 저장' });
    expect(await storedState(store)).toMatchObject({ schemaVersion: 2, revision: 6 });
  });

  it('변환에 실패하거나 변환한 데이터를 저장하지 못하면 막고, 이전 버전 데이터를 그대로 둔다', async () => {
    const throwing = () => {
      throw new Error('boom');
    };
    const failingStore = createMemoryStateStore(v1());
    const before = await storedState(failingStore);
    const failing = createLocalRepositories({ openStore: async () => failingStore, schema: { currentVersion: 2, migrations: { 1: throwing } } });
    await failing.persistence.load();
    expect(failing.persistence.getStatus()).toMatchObject({ state: 'blocked', reason: 'migration_failed' });
    expect(await storedState(failingStore)).toEqual(before);

    const { store, failNext } = faultyStore(createMemoryStateStore(v1()));
    failNext('commit', 'write');
    const unsaved = createLocalRepositories({ openStore: async () => store, schema: { currentVersion: 2, migrations: { 1: (data) => data } } });
    await unsaved.persistence.load();
    expect(unsaved.persistence.getStatus()).toMatchObject({ state: 'blocked', reason: 'migration_failed' });
    expect(await storedState(store)).toMatchObject({ schemaVersion: 1, revision: 4 });
  });

  it('막힌 상태에서도 사용자가 고르면 초기화할 수 있다', async () => {
    const store = createMemoryStateStore({ ...v1(), schemaVersion: 99 });
    const repos = await openTab(store);
    expect(repos.persistence.getStatus()).toMatchObject({ state: 'blocked' });
    await repos.persistence.resetToSeed();
    expect(ready(repos)).toMatchObject({ state: 'ready', mode: 'local', revision: 5 });
    expect(await storedState(store)).toMatchObject({ schemaVersion: 1, revision: 5 });
  });

  it('migration은 저장된 버전부터 한 단계씩 실행하고, 경로가 없거나 실패하면 결과만 알린다', () => {
    const seed = createSeed();
    const migrations = {
      1: (data: unknown) => ({ ...(data as object), step1: true }),
      2: (data: unknown) => {
        const { step1, ...rest } = data as AppData & { step1?: boolean };
        return step1 ? rest : data;
      },
    };
    expect(migrateAppData(1, seed, { currentVersion: 3, migrations })).toMatchObject({ status: 'migrated', fromVersion: 1 });
    expect(migrateAppData(3, seed, { currentVersion: 3, migrations })).toMatchObject({ status: 'current' });
    expect(migrateAppData(1, seed, { currentVersion: 3, migrations: { 1: migrations[1] } })).toEqual({ status: 'unsupported', version: 1 });
    const throwing = () => {
      throw new Error('boom');
    };
    expect(migrateAppData(1, seed, { currentVersion: 2, migrations: { 1: throwing } })).toEqual({ status: 'failed', version: 1 });
    expect(migrateAppData(1, seed, { currentVersion: 2, migrations: { 1: () => ({ broken: true }) } })).toEqual({ status: 'failed', version: 1 });
    expect(migrateAppData(4, seed, { currentVersion: 3, migrations })).toEqual({ status: 'unsupported', version: 4 });
    expect(migrateAppData(0, seed, { currentVersion: 3, migrations })).toEqual({ status: 'unsupported', version: 0 });
  });
});

/* ---------- 저장소를 쓸 수 없을 때 ---------- */

describe('저장소를 쓸 수 없을 때', () => {
  it('조용히 메모리로 넘어가지 않고 막힌 상태로 알린다', async () => {
    const repos = createLocalRepositories({ openStore: async () => Promise.reject(new PersistenceError('unavailable')) });
    await repos.persistence.load();
    expect(repos.persistence.getStatus()).toMatchObject({ state: 'blocked', reason: 'unavailable' });
    await expect(repos.tasks.create({ title: 'x' })).rejects.toBeInstanceOf(PersistenceError);
  });

  it('저장된 상태를 읽지 못하면 read_failed로 막고, 사용자가 고르면 초기화할 수 있다', async () => {
    const base = createMemoryStateStore();
    const store: StateStore = { ...base, read: async () => Promise.reject(new Error('read')) };
    const repos = await openTab(store);
    expect(repos.persistence.getStatus()).toMatchObject({ state: 'blocked', reason: 'read_failed' });
    await repos.persistence.resetToSeed();
    expect(ready(repos)).toMatchObject({ state: 'ready', mode: 'local' });
  });

  it('사용자가 고르면 저장하지 않는 모드로 열고 그 사실을 상태에 남긴다', async () => {
    const repos = createLocalRepositories({ openStore: async () => Promise.reject(new PersistenceError('unavailable')) });
    await repos.persistence.load();
    await repos.persistence.continueWithoutSaving();
    expect(ready(repos)).toMatchObject({ state: 'ready', mode: 'memory' });
    await repos.tasks.create({ title: '저장되지 않는 업무' });
  });
});

/* ---------- 원본 파일 ---------- */

describe('TC 가져오기 원본 파일', () => {
  it('성공하면 원본 · snapshot · 열 매핑이 함께 남고, 원본 bytes는 올린 파일과 완전히 같다(새로고침 뒤에도)', async () => {
    const store = createMemoryStateStore();
    const repos = await openTab(store);
    const original = xlsxBytes([TC_HEADERS, tcRow('MY-001', '닉네임 변경 시 저장 가능')], 'TC');
    const { table, mapping, apply } = await tcImport(repos, { bytes: new Blob([original]), format: 'xlsx', sheetName: 'TC' }, '고객사A_기존TC_한글.xlsx');

    const session = await apply();
    expect(session.artifactId).toBeDefined();
    expect(session.columnMapping).toEqual(mapping);
    expect(session.sourceSnapshot).toEqual(toImportSourceSnapshot(table, { format: 'xlsx', fileName: '고객사A_기존TC_한글.xlsx', sheetName: 'TC' }));

    const reloaded = await openTab(store);
    const [stored] = await reloaded.testAssetImports.listByProject(PROJECT_A);
    expect(stored).toEqual(session);
    expect(await reloaded.importSources.get(session.artifactId!)).toMatchObject({
      projectId: PROJECT_A,
      fileName: '고객사A_기존TC_한글.xlsx',
      format: 'xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: original.length,
      selectedSheetName: 'TC',
    });
    expect(sameBytes(await reloaded.importSources.getBytes(session.artifactId!), original)).toBe(true);
    // 가져오기로 만든 TC도 같이 남아 기록과 TC가 어긋나지 않는다.
    expect((await reloaded.testCases.listByProject(PROJECT_A)).some((item) => item.importSource?.sessionId === session.id)).toBe(true);
  });

  it('CSV 원본도 bytes 그대로 보관한다', async () => {
    const repos = await openTab(createMemoryStateStore());
    const original = new TextEncoder().encode(`\uFEFF${csvText([TC_HEADERS, tcRow('MY-001', '한글 항목')])}`);
    const session = await (await tcImport(repos, { bytes: new Blob([original], { type: 'text/csv' }), format: 'csv' }, '기존_TC.csv')).apply();
    const artifact = await repos.importSources.get(session.artifactId!);
    expect(artifact).toMatchObject({ format: 'csv', mimeType: 'text/csv', size: original.length });
    expect(artifact?.selectedSheetName).toBeUndefined();
    expect(sameBytes(await repos.importSources.getBytes(session.artifactId!), original)).toBe(true);
  });

  it('저장에 실패하면 TC · 가져오기 기록 · 원본 메타데이터 · 원본 bytes가 하나도 남지 않는다', async () => {
    const { store, base, failNext } = faultyStore();
    const repos = await openTab(store);
    const testCasesBefore = await repos.testCases.listByProject(PROJECT_A);
    const { apply } = await tcImport(repos, { bytes: new Blob([xlsxBytes([['A'], ['1']], 'TC')]), format: 'xlsx', sheetName: 'TC' });

    failNext('commit', 'quota');
    await expect(apply()).rejects.toMatchObject({ kind: 'quota' });

    expect(await repos.testAssetImports.listByProject(PROJECT_A)).toEqual([]);
    expect(await repos.testCases.listByProject(PROJECT_A)).toEqual(testCasesBefore);
    const stored = await storedState(store);
    expect(stored.data.importSourceArtifacts).toEqual([]);
    expect(stored.data.testAssetImports).toEqual([]);
    expect(base.inspect().artifactIds).toEqual([]);
  });

  it('가져오기 검증에 실패하면 원본도 저장하지 않는다', async () => {
    const store = createMemoryStateStore();
    const repos = await openTab(store);
    const table = toImportTable(parseCsv(csvText([TC_HEADERS, tcRow('MY-001', '항목')]))) as ImportTable;
    await expect(
      repos.testAssetImports.apply({
        projectId: 'proj-missing',
        fileName: 'x.xlsx',
        table,
        mapping: suggestColumnMapping(table.headers),
        decisions: [],
        source: { bytes: new Blob(['x']), format: 'xlsx' },
      }),
    ).rejects.toThrow('프로젝트을(를) 찾을 수 없어요');
    expect(store.inspect().artifactIds).toEqual([]);
    expect((await storedState(store)).revision).toBe(1);
  });

  it('원본 없이 가져오면 원본 · snapshot · 열 매핑이 모두 없다', async () => {
    const repos = await openTab(createMemoryStateStore());
    const session = await (await tcImport(repos)).apply();
    expect(session.artifactId).toBeUndefined();
    expect(session.sourceSnapshot).toBeUndefined();
    expect(session.columnMapping).toBeUndefined();
  });
});

describe('수행 결과 가져오기 원본 파일', () => {
  it('원본 · snapshot · 결과 열 매핑을 저장하고, 결과 원문 매핑(mapping)과 열 매핑을 섞지 않는다', async () => {
    const store = createMemoryStateStore();
    const repos = await openTab(store);
    const original = new TextEncoder().encode(csvText([RESULT_HEADERS, ['SIGN-001', '로그인', 'P', '']]));
    const { table, mapping, apply } = await resultImport(repos, { bytes: new Blob([original]), format: 'csv' });

    const saved = await apply();
    expect(saved.resultColumnMapping).toEqual(mapping);
    expect(saved.resultColumnMapping).toEqual(['externalId', 'title', 'result', 'note']);
    // mapping은 결과 원문 → 표준 결과 매핑 그대로다.
    expect(saved.mapping.length).toBeGreaterThan(0);
    for (const item of saved.mapping) expect(typeof item).toBe('object');
    expect(saved.sourceSnapshot?.headers).toEqual(table.headers);

    const reloaded = await openTab(store);
    const restored = (await reloaded.testResults.listImports(PROJECT_A)).find((item) => item.id === saved.id);
    expect(restored).toEqual(saved);
    expect((await reloaded.testResults.listResults(saved.id)).length).toBeGreaterThan(0);
    expect(sameBytes(await reloaded.importSources.getBytes(saved.artifactId!), original)).toBe(true);
  });

  it('저장에 실패하면 차수 · 결과 · 원본이 하나도 남지 않는다', async () => {
    const { store, base, failNext } = faultyStore();
    const repos = await openTab(store);
    const importsBefore = await repos.testResults.listImports(PROJECT_A);
    const { apply } = await resultImport(repos, { bytes: new Blob(['x']), format: 'csv' });
    failNext('commit', 'write');
    await expect(apply()).rejects.toBeInstanceOf(PersistenceError);
    expect(await repos.testResults.listImports(PROJECT_A)).toEqual(importsBefore);
    expect((await storedState(store)).data.importSourceArtifacts).toEqual([]);
    expect(base.inspect().artifactIds).toEqual([]);
  });
});

describe('원본 파일 읽기 오류', () => {
  it('기록이 없는 id는 undefined', async () => {
    const repos = await openTab(createMemoryStateStore());
    expect(await repos.importSources.get('src-missing')).toBeUndefined();
    expect(await repos.importSources.getBytes('src-missing')).toBeUndefined();
  });

  it('기록은 있는데 bytes가 없으면 artifact_missing, 크기가 다르면 artifact_corrupt', async () => {
    const store = createMemoryStateStore();
    const repos = await openTab(store);
    const session = await (await tcImport(repos, { bytes: new Blob(['원본']), format: 'csv' })).apply();
    const stored = await storedState(store);

    const withoutBytes = createMemoryStateStore(stored);
    await expect((await openTab(withoutBytes)).importSources.getBytes(session.artifactId!)).rejects.toMatchObject({ kind: 'artifact_missing' });

    const resized = createMemoryStateStore(stored);
    await resized.commit({ expectedRevision: stored.revision, schemaVersion: 1, savedAt: 'x', data: stored.data, artifacts: [{ id: session.artifactId!, bytes: new Blob(['다른 크기의 파일']) }] });
    await expect((await openTab(resized)).importSources.getBytes(session.artifactId!)).rejects.toMatchObject({ kind: 'artifact_corrupt' });
  });

  it('bytes를 읽지 못하면 read_failed로 알린다', async () => {
    const { store, failNext } = faultyStore();
    const repos = await openTab(store);
    const session = await (await tcImport(repos, { bytes: new Blob(['원본']), format: 'csv' })).apply();
    failNext('readArtifact', 'read');
    await expect(repos.importSources.getBytes(session.artifactId!)).rejects.toMatchObject({ kind: 'read_failed' });
  });
});

/* ---------- 로컬 데이터 초기화 ---------- */

describe('로컬 데이터 초기화', () => {
  it('상태와 원본 파일을 모두 지우고 지금 만든 예시 데이터로 저장하며, 다른 탭에 알린다', async () => {
    const store = createMemoryStateStore();
    const hub = createMemoryChannelHub();
    const createInitialData = vi.fn(createSeed);
    const tab = await openTab(store, { channel: hub.connect(), createInitialData });
    const other = await openTab(store, { channel: hub.connect(), createInitialData });
    await tab.tasks.create({ title: '지워질 업무' });
    const session = await (await tcImport(tab, { bytes: new Blob(['원본']), format: 'csv' })).apply();
    const revisionBefore = (await storedState(store)).revision;
    createInitialData.mockClear();

    await tab.persistence.resetToSeed();

    expect(createInitialData).toHaveBeenCalledTimes(1);
    expect(store.inspect().artifactIds).toEqual([]);
    const stored = await storedState(store);
    expect(stored.revision).toBe(revisionBefore + 1);
    expect(stored.data.tasks.some((task) => task.title === '지워질 업무')).toBe(false);
    expect(stored.data.importSourceArtifacts).toEqual([]);
    expect(await tab.importSources.get(session.artifactId!)).toBeUndefined();
    expect(ready(tab)).toMatchObject({ stale: false, revision: revisionBefore + 1 });
    expect(ready(other).stale).toBe(true);
  });

  it('초기화에 실패하면 기존 데이터와 원본 파일을 그대로 둔다', async () => {
    const { store, base, failNext } = faultyStore();
    const repos = await openTab(store);
    const task = await repos.tasks.create({ title: '남아야 하는 업무' });
    await (await tcImport(repos, { bytes: new Blob(['원본']), format: 'csv' })).apply();
    const before = await storedState(store);

    failNext('replaceAll', 'write');
    await expect(repos.persistence.resetToSeed()).rejects.toBeInstanceOf(PersistenceError);

    expect(await storedState(store)).toEqual(before);
    expect(base.inspect().artifactIds).toHaveLength(1);
    expect(await repos.tasks.get(task.id)).toBeDefined();
  });
});

/* ---------- 이전 데이터 · snapshot ---------- */

describe('원본이 없는 이전 가져오기', () => {
  it('예시 데이터의 수행 결과 차수는 원본 없이 그대로 동작하고 가져오기 이력도 만든다', async () => {
    const repos = await openTab(createMemoryStateStore());
    const imports = await repos.testResults.listImports(PROJECT_A);
    expect(imports.length).toBeGreaterThan(0);
    for (const item of imports) {
      expect(item.artifactId).toBeUndefined();
      expect(item.resultColumnMapping).toBeUndefined();
    }
    const resultsByImport = Object.fromEntries(await Promise.all(imports.map(async (item) => [item.id, await repos.testResults.listResults(item.id)] as const)));
    expect(buildImportHistory([], imports, resultsByImport)).toHaveLength(imports.length);
  });
});

describe('ImportSourceSnapshot', () => {
  const table: ImportTable = {
    headers: ['TC ID', '고객사 메모', '단계'],
    rows: [
      { rowNumber: 4, cells: ['SIGN-001', '매핑하지 않은 열 ✓', '1. 열기\n2. 입력'] },
      { rowNumber: 5, cells: ['', '', ''] },
      { rowNumber: 7, cells: ['SIGN-002', '한글 · 😀', ''] },
    ],
  };

  it('헤더 순서 · 행 번호 · 빈 행 · 매핑하지 않은 열 · 줄바꿈 · Unicode를 그대로 남긴다', () => {
    const snapshot = toImportSourceSnapshot(table, { format: 'xlsx', fileName: '고객사.xlsx', sheetName: 'TC 목록' });
    expect(snapshot).toEqual({ format: 'xlsx', fileName: '고객사.xlsx', sheetName: 'TC 목록', headers: table.headers, rows: table.rows });
  });

  it('원본 표와 공유하지 않는다', () => {
    const snapshot = toImportSourceSnapshot(table, { format: 'csv', fileName: 'a.csv' });
    snapshot.rows[0].cells[0] = '바뀜';
    snapshot.headers[0] = '바뀜';
    expect(table.rows[0].cells[0]).toBe('SIGN-001');
    expect(table.headers[0]).toBe('TC ID');
    expect(snapshot.sheetName).toBeUndefined();
  });

  it('JSON으로 저장했다가 읽어도 같다', () => {
    const snapshot = toImportSourceSnapshot(table, { format: 'xlsx', fileName: '고객사.xlsx', sheetName: 'TC' });
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });
});
