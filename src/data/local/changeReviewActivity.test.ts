import { describe, expect, it } from 'vitest';
import { activityLinkLabel, activityLinkPath } from '@/domain/activityRecords';
import type { ChangeAnalysis, ReviewDecision } from '@/domain/types';
import { PersistenceError } from '../persistenceError';
import type { PersistenceStatus, Repositories } from '../repositories/types';
import { createSeed, PROJECT_A } from '../mock/seed';
import type { AppData, StoredAppState } from './appData';
import { createLocalRepositories } from './localRepositories';
import { createMemoryStateStore, type StateStore } from './stateStore';

/*
 * 변경 영향 분석 검토 완료(markReviewed) 기록. 검토 완료가 저장될 때만 같은 저장 안에서 활동 하나를 남긴다.
 * 판단이 남았거나 · 모순이 있거나 · 이미 검토 완료 · 반영된 분석, 저장 실패에서는 분석도 활동도 바뀌지 않는다.
 */

const ANALYSIS = 'cia-plan-v15';
const TITLE = '모바일_개편_기획_v1.5.pdf 변경 분석 검토 완료';
// 예시 분석의 판단 대상: 요구사항 신규 · 변경 · 제거 3건, TC 영향 신규 · 수정 · 폐기 · 중복 후보 6건(유지 1건 제외)
const DETAIL = '요구사항 변경 3건 · TC 영향 6건';

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
const analysisOf = async (repos: Repositories) => (await repos.changeAnalyses.listByProject(PROJECT_A)).find((item) => item.id === ANALYSIS)!;
/** 이 분석의 검토 완료 기록. 예시 데이터에는 analysisId 없는 이전 requirements_analyzed 기록이 있어 analysisId로 거른다. */
const reviewActivities = async (repos: Repositories) =>
  (await repos.activities.list({ projectId: PROJECT_A })).filter((item) => item.type === 'requirements_analyzed' && item.metadata.analysisId === ANALYSIS);

/** 예시 분석의 판단을 모두 채운다(기본은 수락, 중복은 기존 TC 수정). */
async function decideAll(repos: Repositories, requirements: Partial<Record<string, ReviewDecision>> = {}) {
  for (const id of ['rc-001', 'rc-002', 'rc-003']) await repos.changeAnalyses.updateRequirementDecision(ANALYSIS, id, requirements[id] ?? 'accepted');
  for (const id of ['ti-001', 'ti-002', 'ti-003', 'ti-004', 'ti-006']) await repos.changeAnalyses.updateTestImpactDecision(ANALYSIS, id, 'accepted');
  await repos.changeAnalyses.resolveDuplicate(ANALYSIS, 'ti-007', 'modify_existing');
}

/** 거부되고, 분석 · 활동 · 저장 상태 · revision이 그대로다. */
async function expectRejectedUnchanged(repos: Repositories, base: ReturnType<typeof createMemoryStateStore>, message: string | (new (...args: never[]) => Error)) {
  const before = { state: stored(base), analysis: await analysisOf(repos), activities: await repos.activities.list(), revision: ready(repos).revision };
  const attempt = repos.changeAnalyses.markReviewed(ANALYSIS);
  if (typeof message === 'string') await expect(attempt).rejects.toThrow(message);
  else await expect(attempt).rejects.toBeInstanceOf(message);
  expect(stored(base)).toEqual(before.state);
  expect(await analysisOf(repos)).toEqual(before.analysis);
  expect(await repos.activities.list()).toEqual(before.activities);
  expect(ready(repos).revision).toBe(before.revision);
}

describe('변경 분석 검토 완료 기록', () => {
  it('검토 완료가 저장되면 requirements_analyzed 활동 하나를 대상 산출물 이름 · 판단 대상 수 · analysisId와 함께 남긴다', async () => {
    const { repos, base } = await open();
    await decideAll(repos);
    const before = (await repos.activities.list()).length;
    const reviewed = await repos.changeAnalyses.markReviewed(ANALYSIS);

    expect(reviewed).toMatchObject({ id: ANALYSIS, status: 'reviewed' });
    expect(reviewed.reviewedAt).toEqual(expect.any(String));
    const activities = await repos.activities.list();
    expect(activities).toHaveLength(before + 1);
    expect(activities[0]).toEqual({
      id: expect.any(String),
      type: 'requirements_analyzed',
      projectId: PROJECT_A,
      title: TITLE,
      metadata: { detail: DETAIL, analysisId: ANALYSIS },
      createdAt: expect.any(String),
    });
    // 같은 저장에 분석 상태와 활동이 함께 남는다.
    const saved = stored(base).data;
    expect(saved.changeAnalyses.find((item) => item.id === ANALYSIS)).toMatchObject({ status: 'reviewed', reviewedAt: reviewed.reviewedAt });
    expect(saved.activities.filter((item) => item.type === 'requirements_analyzed' && item.metadata.analysisId === ANALYSIS)).toHaveLength(1);
    // 기록에서는 제목이 아닌 "테스트 설계 보기"로 현재 테스트 설계 탭에 간다.
    expect(activityLinkPath(activities[0], PROJECT_A)).toBe(`/projects/${PROJECT_A}/test-design`);
    expect(activityLinkLabel(activities[0])).toBe('테스트 설계 보기');
  });

  it('대상 산출물을 찾지 못하면 "산출물"로 기록한다', async () => {
    const seed = createSeed();
    seed.changeAnalyses.find((item) => item.id === ANALYSIS)!.targetDeliverableId = 'dlv-missing';
    const { repos } = await open(seed);
    await decideAll(repos);
    await repos.changeAnalyses.markReviewed(ANALYSIS);
    expect((await reviewActivities(repos))[0]).toMatchObject({ title: '산출물 변경 분석 검토 완료', metadata: { detail: DETAIL, analysisId: ANALYSIS } });
  });

  it('판단이 남아 있으면 거부하고 분석 · 활동 · 저장 상태 · revision이 그대로다', async () => {
    const { repos, base } = await open();
    await repos.changeAnalyses.updateRequirementDecision(ANALYSIS, 'rc-001', 'accepted');
    await expectRejectedUnchanged(repos, base, '판단하지 않은 항목이 8건');
    expect(await reviewActivities(repos)).toEqual([]);
  });

  it('판단 조합에 모순이 있으면 거부하고 그대로다', async () => {
    const { repos, base } = await open();
    await decideAll(repos, { 'rc-001': 'rejected' });
    await expectRejectedUnchanged(repos, base, '제외한 요구사항을 근거로 수락된 TC 제안이 1건');
    expect(await reviewActivities(repos)).toEqual([]);
  });

  it('두 번 검토 완료할 수 없고, 검토 완료 기록은 하나뿐이다', async () => {
    const { repos, base } = await open();
    await decideAll(repos);
    await repos.changeAnalyses.markReviewed(ANALYSIS);
    await expectRejectedUnchanged(repos, base, '검토를 완료한 분석은 판단을 바꿀 수 없어요.');
    expect(await reviewActivities(repos)).toHaveLength(1);
  });

  it('반영한 분석도 검토 완료할 수 없고, 검토 완료와 반영은 별개의 기록으로 남는다', async () => {
    const { repos, base } = await open();
    await decideAll(repos);
    await repos.changeAnalyses.markReviewed(ANALYSIS);
    await repos.changeAnalyses.apply(ANALYSIS);
    await expectRejectedUnchanged(repos, base, '검토를 완료한 분석은 판단을 바꿀 수 없어요.');
    const analysisActivities = (await repos.activities.list({ projectId: PROJECT_A })).filter((item) => item.metadata.analysisId === ANALYSIS);
    expect(analysisActivities.map((item) => item.type)).toEqual(['changes_applied', 'requirements_analyzed']);
  });

  it('저장에 실패하면 분석 상태 · reviewedAt · 활동 · revision이 저장소와 메모리 모두 그대로이고, 다시 시도하면 기록 하나로 끝난다', async () => {
    const { repos, base, failNext } = await open();
    await decideAll(repos);
    const draftAnalysis: ChangeAnalysis = await analysisOf(repos);
    expect(draftAnalysis.status).toBe('draft');
    expect(draftAnalysis).not.toHaveProperty('reviewedAt');

    failNext();
    await expectRejectedUnchanged(repos, base, PersistenceError);
    // 메모리 원본 엔티티도 draft 그대로다.
    expect(await analysisOf(repos)).toEqual(draftAnalysis);
    expect(await reviewActivities(repos)).toEqual([]);

    const revision = ready(repos).revision;
    await repos.changeAnalyses.markReviewed(ANALYSIS);
    expect(ready(repos).revision).toBe(revision + 1);
    expect(await reviewActivities(repos)).toHaveLength(1);
  });
});
