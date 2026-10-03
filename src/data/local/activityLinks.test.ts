import { describe, expect, it } from 'vitest';
import { activityLinkPath } from '@/domain/activityRecords';
import { analyzeTestAssetImport, defaultDecisionFor, suggestColumnMapping, toImportTable, type ImportTable } from '@/domain/testAssetImport';
import type { Activity } from '@/domain/types';
import { parseCsv } from '@/lib/csv';
import { PersistenceError } from '../persistenceError';
import type { Repositories } from '../repositories/types';
import { importQaRound, qaScenarioSeed } from '../mock/issueScenario';
import { createSeed, PROJECT_A } from '../mock/seed';
import { CURRENT_SCHEMA_VERSION, type AppData, type StoredAppState } from './appData';
import { createLocalRepositories } from './localRepositories';
import { createMemoryStateStore, type StateStore } from './stateStore';

/*
 * 활동 기록의 원본 ID(metadata). 기록하는 시점에 가진 ID만 남기고, 기존 detail · projectId는 그대로다.
 * ID는 활동과 같은 저장(mutate) 안에서 쓰이므로 저장에 실패하면 활동도 원본도 남지 않는다.
 * 이전에 저장된 활동(원본 ID 없음)은 migration 없이 그대로 읽히고 링크가 없다.
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

const latest = async (repos: Repositories) => (await repos.activities.list({ projectId: PROJECT_A }))[0];
const stored = (store: ReturnType<typeof createMemoryStateStore>) => store.inspect().state as StoredAppState & { data: AppData };

/* 각 생성 지점을 실제 저장소 동작으로 실행한다. */

const HEADERS = ['TC ID', '테스트 관점', '대분류', '중분류', '소분류', '테스트 항목', 'Pre-condition', 'Test Step', 'Expected Result', '비고'];
const assetRow = ['MY-001', '예외', '마이페이지', '프로필', '닉네임', '닉네임 저장', '로그인 상태', '1. 프로필로 이동한다.\n2. 저장한다.', '저장 완료 안내 노출', ''];

async function importTestAssets(repos: Repositories) {
  const text = [HEADERS, assetRow].map((cells) => cells.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const table = toImportTable(parseCsv(text)) as ImportTable;
  const mapping = suggestColumnMapping(table.headers);
  const analysis = analyzeTestAssetImport(table, mapping, await repos.testCases.listByProject(PROJECT_A));
  const decisions = analysis.rows.flatMap((item) => (defaultDecisionFor(item) ? [{ rowNumber: item.row.rowNumber, kind: item.kind, targetId: item.targetId, decision: defaultDecisionFor(item)! }] : []));
  return repos.testAssetImports.apply({ projectId: PROJECT_A, fileName: '고객사A_기존TC.csv', table, mapping, decisions });
}

const ANALYSIS = 'cia-plan-v15';

/** 예시 변경 영향 분석을 모두 수락으로 판단하고 검토 완료까지 한다(반영 직전). */
async function reviewAnalysis(repos: Repositories) {
  for (const id of ['rc-001', 'rc-002', 'rc-003']) await repos.changeAnalyses.updateRequirementDecision(ANALYSIS, id, 'accepted');
  for (const id of ['ti-001', 'ti-002', 'ti-003', 'ti-004', 'ti-006']) await repos.changeAnalyses.updateTestImpactDecision(ANALYSIS, id, 'accepted');
  await repos.changeAnalyses.resolveDuplicate(ANALYSIS, 'ti-007', 'modify_existing');
  await repos.changeAnalyses.markReviewed(ANALYSIS);
}

interface Case {
  name: string;
  type: Activity['type'];
  key: string;
  seed?: () => AppData;
  prepare?: (repos: Repositories) => Promise<void>;
  /** 실행하고, 활동에 남아야 할 원본 ID를 돌려준다. */
  run: (repos: Repositories) => Promise<string>;
  detail: string | RegExp;
  path: (id: string) => string;
}

const cases: Case[] = [
  {
    name: '수행 결과 가져오기',
    type: 'results_uploaded',
    key: 'resultImportId',
    seed: qaScenarioSeed,
    run: async (repos) => (await importQaRound(repos, 1, 'F')).resultImport.id,
    detail: /FAIL 1/,
    path: (id) => `/projects/${PROJECT_A}/results?import=${id}`,
  },
  {
    name: 'TC 상태 변경',
    type: 'test_case_changed',
    key: 'testCaseId',
    run: async (repos) => {
      const [testCase] = await repos.testCases.listByProject(PROJECT_A);
      await repos.testCases.updateStatus(testCase.id, 'reviewed');
      return testCase.id;
    },
    detail: '검토 완료',
    path: (id) => `/projects/${PROJECT_A}/test-design?tc=${id}`,
  },
  {
    name: 'TC 자산 가져오기',
    type: 'test_assets_imported',
    key: 'testAssetImportId',
    run: async (repos) => (await importTestAssets(repos)).id,
    detail: '고객사A_기존TC.csv · 신규 1 · 업데이트 0 · 변경 없음 0 · 제외 0',
    path: (id) => `/projects/${PROJECT_A}/import-history?assetImport=${id}`,
  },
  {
    name: '산출물 추가',
    type: 'deliverable_added',
    key: 'deliverableId',
    run: async (repos) => (await repos.deliverables.create({ projectId: PROJECT_A, type: 'pdf', title: '기획서' })).id,
    detail: 'PDF',
    path: (id) => `/projects/${PROJECT_A}?deliverable=${id}`,
  },
  {
    name: '변경사항 반영',
    type: 'changes_applied',
    key: 'analysisId',
    prepare: reviewAnalysis,
    run: async (repos) => (await repos.changeAnalyses.apply(ANALYSIS)).id,
    detail: /^요구사항 \d+ · TC \d+$/,
    path: () => `/projects/${PROJECT_A}/test-design`,
  },
];

describe('활동 기록의 원본 ID', () => {
  it.each(cases)('$name → $type에 $key를 남기고 detail · projectId는 그대로이며, 원본 화면으로 연결된다', async ({ type, key, seed, prepare, run, detail, path }) => {
    const { repos } = await open(seed?.());
    await prepare?.(repos);
    const id = await run(repos);
    const activity = await latest(repos);
    expect(activity).toMatchObject({ type, projectId: PROJECT_A, metadata: { [key]: id } });
    expect(activity.metadata.detail).toMatch(detail);
    // 원본 ID 하나 말고는 다른 key를 더하지 않는다.
    expect(Object.keys(activity.metadata).sort()).toEqual(['detail', key].sort());
    expect(activityLinkPath(activity, PROJECT_A)).toBe(path(id));
  });

  it.each(cases)('$name 저장에 실패하면 활동도 원본도 남지 않고 저장 상태 · revision이 그대로다', async ({ seed, prepare, run }) => {
    const { repos, base, failNext } = await open(seed?.());
    await prepare?.(repos);
    const before = structuredClone(stored(base));
    const activities = await repos.activities.list();
    failNext();
    await expect(run(repos)).rejects.toBeInstanceOf(PersistenceError);
    expect(stored(base)).toEqual(before);
    expect(await repos.activities.list()).toEqual(activities);
  });
});

describe('이전에 저장된 활동', () => {
  it('원본 ID가 없는 활동은 migration 없이 그대로 읽히고(현재 버전 · revision 유지) 링크가 없다', async () => {
    const legacy: Activity[] = [
      { id: 'act-old-result', projectId: PROJECT_A, type: 'results_uploaded', title: '1차 결과 가져오기', metadata: { detail: 'PASS 3' }, createdAt: '2026-09-01T09:00:00.000Z' },
      { id: 'act-old-tc', projectId: PROJECT_A, type: 'test_case_changed', title: 'TC 상태 변경', metadata: { detail: '검토 완료' }, createdAt: '2026-09-01T10:00:00.000Z' },
      { id: 'act-old-assets', projectId: PROJECT_A, type: 'test_assets_imported', title: 'TC 자산 가져오기', metadata: { detail: 'a.csv' }, createdAt: '2026-09-01T11:00:00.000Z' },
      { id: 'act-old-deliverable', projectId: PROJECT_A, type: 'deliverable_added', title: '기획서 추가', metadata: { detail: 'PDF' }, createdAt: '2026-09-01T12:00:00.000Z' },
      { id: 'act-old-apply', projectId: PROJECT_A, type: 'changes_applied', title: '변경사항 반영', metadata: {}, createdAt: '2026-09-01T13:00:00.000Z' },
    ];
    const store = createMemoryStateStore({ schemaVersion: CURRENT_SCHEMA_VERSION, revision: 4, savedAt: '2026-09-01T13:00:00.000Z', data: { ...createSeed(), activities: legacy } });
    const before = store.inspect();
    const repos = createLocalRepositories({ openStore: async () => store });
    await repos.persistence.load();
    expect(repos.persistence.getStatus()).toMatchObject({ state: 'ready', revision: 4 });
    expect(store.inspect()).toEqual(before);
    const activities = await repos.activities.list({ projectId: PROJECT_A });
    expect(activities.map((activity) => activity.id).sort()).toEqual(legacy.map((activity) => activity.id).sort());
    for (const activity of activities) expect(activityLinkPath(activity, PROJECT_A)).toBeUndefined();
  });
});
