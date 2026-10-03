import { describe, expect, it } from 'vitest';
import { activityLinkPath } from '@/domain/activityRecords';
import { RequirementImportError, type RequirementColumnMapping } from '@/domain/requirementImport';
import { toImportTable, type ImportTable } from '@/domain/testAssetImport';
import { PersistenceError } from '../persistenceError';
import type { ImportRequirementsInput, PersistenceStatus, Repositories } from '../repositories/types';
import { createSeed, PROJECT_A, PROJECT_B } from '../mock/seed';
import type { AppData, StoredAppState } from './appData';
import { createLocalRepositories } from './localRepositories';
import { createMemoryStateStore, type StateStore } from './stateStore';

/*
 * 요구사항 파일 가져오기. 현재 요구사항 기준으로 다시 판정해 새 요구사항만 만들고, 활동 기록도 같은 저장에 남긴다.
 * 만들 것이 없거나 · 입력이 잘못됐거나 · 저장에 실패하면 요구사항 · 활동 · 저장 상태 · revision이 모두 그대로다.
 * 스키마 · 저장 구조는 그대로라 migration 없이 현재 버전 데이터에 쓴다.
 */

const DELIVERABLE = 'dlv-plan-pdf-v15';
const MAPPING: RequirementColumnMapping = ['feature', 'text', 'locator', 'needsConfirmation'];

const table = (rows: string[][]): ImportTable => toImportTable([['기능명', '요구사항', '페이지/위치', '확인 필요'], ...rows])!;

/** 다음 commit 한 번만 실패시키는 저장소. 실패한 쓰기는 아무것도 남기지 않는다. */
function failingOnce(base: StateStore) {
  let fail = false;
  const store: StateStore = { ...base, commit: async (input) => (fail ? ((fail = false), Promise.reject(new Error('write failed'))) : base.commit(input)) };
  return { store, failNext: () => (fail = true) };
}

async function open() {
  const base = createMemoryStateStore();
  const { store, failNext } = failingOnce(base);
  const repos = createLocalRepositories({ openStore: async () => store, createInitialData: createSeed });
  await repos.persistence.load();
  return { repos, base, failNext };
}

const ready = (repos: Repositories) => repos.persistence.getStatus() as Extract<PersistenceStatus, { state: 'ready' }>;
const stored = (store: ReturnType<typeof createMemoryStateStore>) => structuredClone(store.inspect().state as StoredAppState & { data: AppData });
const importActivities = async (repos: Repositories) => (await repos.activities.list({ projectId: PROJECT_A })).filter((item) => item.type === 'requirements_imported');

const input = (rows: string[][], overrides: Partial<ImportRequirementsInput> = {}): ImportRequirementsInput => ({
  projectId: PROJECT_A,
  deliverableId: DELIVERABLE,
  fileName: '요구사항.csv',
  table: table(rows),
  mapping: MAPPING,
  excludedRows: [],
  ...overrides,
});

const FILE_ROWS = [
  ['소셜 로그인', '카카오 계정으로 로그인할 수 있다.', 'p.21', 'N'],
  ['소셜 로그인', '애플 계정으로 로그인할 수 있다.', '', '필요'],
  ['소셜 로그인', '', 'p.23', 'N'],
  ['소셜 로그인', '네이버 계정으로 로그인할 수 있다.', 'p.24', 'N'],
];

describe('요구사항 가져오기 저장', () => {
  it('새 요구사항만 만들고(draft · active · source_explicit), 근거 · 확인 필요를 파일 값대로 남기며, 같은 저장에 활동을 남긴다', async () => {
    const { repos, base } = await open();
    const before = await repos.requirements.listByProject(PROJECT_A);
    const revision = ready(repos).revision;
    const activitiesBefore = (await repos.activities.list()).length;

    const result = await repos.requirements.importFromTable(input(FILE_ROWS, { excludedRows: [5] }));

    expect(result.summary).toEqual({ total: 4, created: 2, duplicate: 0, invalid: 1, excluded: 1 });
    expect(result.requirements).toHaveLength(2);
    expect(result.requirements[0]).toEqual({
      id: expect.stringMatching(/^req-/),
      projectId: PROJECT_A,
      feature: '소셜 로그인',
      text: '카카오 계정으로 로그인할 수 있다.',
      sourceRefs: [{ deliverableId: DELIVERABLE, locator: 'p.21' }],
      sourceType: 'source_explicit',
      needsConfirmation: false,
      lifecycle: 'active',
      status: 'draft',
    });
    // 위치가 비어 있으면 원본 행 번호(헤더 포함 1부터)로 대신한다.
    expect(result.requirements[1]).toMatchObject({ text: '애플 계정으로 로그인할 수 있다.', needsConfirmation: true, sourceRefs: [{ deliverableId: DELIVERABLE, locator: '요구사항 파일 3행' }] });

    // 기존 요구사항은 그대로이고 새 요구사항만 더해진다.
    const after = await repos.requirements.listByProject(PROJECT_A);
    expect(after).toEqual([...before, ...result.requirements]);
    expect(await repos.requirements.listByProject(PROJECT_B)).toEqual(createSeed().requirements.filter((item) => item.projectId === PROJECT_B));

    // 활동 하나, 같은 저장, revision +1
    const activities = await repos.activities.list();
    expect(activities).toHaveLength(activitiesBefore + 1);
    expect(activities[0]).toEqual({
      id: expect.any(String),
      type: 'requirements_imported',
      projectId: PROJECT_A,
      title: '요구사항.csv 요구사항 2건 가져오기',
      metadata: { detail: '신규 2 · 중복 0 · 오류 1 · 제외 1', deliverableId: DELIVERABLE },
      createdAt: expect.any(String),
    });
    expect(activityLinkPath(activities[0], PROJECT_A)).toBe(`/projects/${PROJECT_A}/requirements`);
    expect(ready(repos).revision).toBe(revision + 1);
    const saved = stored(base);
    expect(saved.revision).toBe(revision + 1);
    expect(saved.data.requirements.filter((item) => result.requirements.some((created) => created.id === item.id))).toEqual(result.requirements);
    expect(saved.data.activities.filter((item) => item.type === 'requirements_imported')).toHaveLength(1);
  });

  it('현재 요구사항 기준으로 다시 판정하므로 이미 있는 요구사항(방금 가져온 것 포함)은 만들지 않는다', async () => {
    const { repos, base } = await open();
    const [seeded] = await repos.requirements.listByProject(PROJECT_A);
    // 기존 요구사항과 같은 행 + 새 행
    const first = await repos.requirements.importFromTable(input([[seeded.feature, seeded.text, 'p.1', 'N'], ['새 기능', '새 요구사항', 'p.2', 'N']]));
    expect(first.summary).toMatchObject({ created: 1, duplicate: 1 });
    expect(first.requirements.map((item) => item.feature)).toEqual(['새 기능']);

    // 같은 파일을 다시 가져오면 모두 중복이라 가져올 것이 없다.
    const snapshot = { state: stored(base), requirements: await repos.requirements.listByProject(PROJECT_A), activities: await repos.activities.list(), revision: ready(repos).revision };
    await expect(repos.requirements.importFromTable(input([['새 기능', '새 요구사항', 'p.2', 'N']]))).rejects.toThrow('가져올 수 있는 새 요구사항이 없어요.');
    expect(stored(base)).toEqual(snapshot.state);
    expect(await repos.requirements.listByProject(PROJECT_A)).toEqual(snapshot.requirements);
    expect(await repos.activities.list()).toEqual(snapshot.activities);
    expect(ready(repos).revision).toBe(snapshot.revision);
    expect(await importActivities(repos)).toHaveLength(1);
  });

  it.each([
    ['없는 프로젝트', (): Partial<ImportRequirementsInput> => ({ projectId: 'proj-missing' }), '프로젝트'],
    ['없는 산출물', () => ({ deliverableId: 'dlv-missing' }), '산출물'],
    ['다른 프로젝트의 산출물', () => ({ deliverableId: 'dlv-b-spec' }), '산출물'],
    ['필수 열 매핑 없음', () => ({ mapping: ['feature', null, null, null] as RequirementColumnMapping }), "'요구사항' 열을 연결해 주세요."],
    ['같은 필드에 열 둘', () => ({ mapping: ['feature', 'feature', 'text', null] as RequirementColumnMapping }), "'기능'에 열이 둘 이상"],
  ])('%s → 거부하고 요구사항 · 활동 · 저장 상태 · revision이 그대로다', async (_, overrides, message) => {
    const { repos, base } = await open();
    const before = { state: stored(base), requirements: await repos.requirements.listByProject(PROJECT_A), activities: await repos.activities.list(), revision: ready(repos).revision };
    await expect(repos.requirements.importFromTable(input(FILE_ROWS, overrides()))).rejects.toThrow(message);
    expect(stored(base)).toEqual(before.state);
    expect(await repos.requirements.listByProject(PROJECT_A)).toEqual(before.requirements);
    expect(await repos.activities.list()).toEqual(before.activities);
    expect(ready(repos).revision).toBe(before.revision);
  });

  it('오류 행뿐이면 거부한다(오류 행은 자동으로 만들지 않는다)', async () => {
    const { repos } = await open();
    await expect(repos.requirements.importFromTable(input([['기능만', '', '', 'N'], ['', '요구사항만', '', 'N'], ['기능', '요구사항', '', '아마도']]))).rejects.toBeInstanceOf(RequirementImportError);
    expect(await importActivities(repos)).toEqual([]);
  });

  it('저장에 실패하면 요구사항 · 활동 · 저장 상태 · revision이 저장소와 메모리 모두 그대로이고, 다시 시도하면 한 번만 가져온다', async () => {
    const { repos, base, failNext } = await open();
    const before = { state: stored(base), requirements: await repos.requirements.listByProject(PROJECT_A), activities: await repos.activities.list(), revision: ready(repos).revision };

    failNext();
    await expect(repos.requirements.importFromTable(input(FILE_ROWS))).rejects.toBeInstanceOf(PersistenceError);
    expect(stored(base)).toEqual(before.state);
    expect(await repos.requirements.listByProject(PROJECT_A)).toEqual(before.requirements);
    expect(await repos.activities.list()).toEqual(before.activities);
    expect(ready(repos).revision).toBe(before.revision);
    expect(await importActivities(repos)).toEqual([]);

    const retry = await repos.requirements.importFromTable(input(FILE_ROWS));
    expect(retry.summary).toMatchObject({ created: 3, invalid: 1 });
    expect(ready(repos).revision).toBe(before.revision + 1);
    expect(await importActivities(repos)).toHaveLength(1);
    expect((await repos.requirements.listByProject(PROJECT_A)).length).toBe(before.requirements.length + 3);

    // 성공한 뒤 같은 파일을 또 보내도 활동이 늘지 않는다.
    await expect(repos.requirements.importFromTable(input(FILE_ROWS))).rejects.toThrow('가져올 수 있는 새 요구사항이 없어요.');
    expect(await importActivities(repos)).toHaveLength(1);
  });

  it('입력을 바꾸지 않고, 저장소에 넘긴 뒤 입력 표를 고쳐도 저장된 내용은 그대로다', async () => {
    const { repos } = await open();
    const request = input(FILE_ROWS);
    const copyOfRequest = structuredClone(request);
    const result = await repos.requirements.importFromTable(request);
    expect(request).toEqual(copyOfRequest);
    request.table.rows[0].cells[1] = '바뀐 내용';
    expect((await repos.requirements.listByProject(PROJECT_A)).find((item) => item.id === result.requirements[0].id)?.text).toBe('카카오 계정으로 로그인할 수 있다.');
  });

  it('새로고침(저장소 다시 열기) 뒤에도 가져온 요구사항과 활동이 남는다', async () => {
    const base = createMemoryStateStore();
    const first = createLocalRepositories({ openStore: async () => base, createInitialData: createSeed });
    await first.persistence.load();
    const result = await first.requirements.importFromTable(input(FILE_ROWS));
    const reopened = createLocalRepositories({ openStore: async () => base });
    await reopened.persistence.load();
    expect((await reopened.requirements.listByProject(PROJECT_A)).filter((item) => result.requirements.some((created) => created.id === item.id))).toEqual(result.requirements);
    expect(await importActivities(reopened)).toHaveLength(1);
  });
});
