import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createBrowserRouter, Outlet, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '@/styles/tokens.css';
import '@/styles/base.css';
import type { AppData } from '@/data/local/appData';
import { createLocalRepositories } from '@/data/local/localRepositories';
import { createMemoryStateStore } from '@/data/local/stateStore';
import { createSeed, PROJECT_A } from '@/data/mock/seed';
import type { Repositories } from '@/data/repositories/types';
import type { Activity } from '@/domain/types';
import { GlobalSearchDialog } from './GlobalSearchDialog';

/*
 * 전역 검색 대화상자를 실제 브라우저(Chromium) · 주소 · 저장소와 함께 띄워 기록 검색을 확인한다.
 * 기록 그룹 표시(최신순), 결과 클릭 이동 · 대화상자 닫힘, 개인 활동 · 옛 기록 fallback, 내부 ID 검색 제외
 * 이동 위치의 종류별 세부는 searchIndex.test.ts에서 확인한다.
 */

const holder = vi.hoisted(() => ({ repos: undefined as Repositories | undefined }));
vi.mock('@/data', () => ({ repositories: new Proxy({}, { get: (_target, key) => holder.repos?.[key as keyof Repositories] }) }));

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let router: ReturnType<typeof createBrowserRouter> | undefined;
const originalUrl = `${location.pathname}${location.search}`;

const activity = (id: string, createdAt: string, overrides: Partial<Activity> = {}): Activity => ({ id, projectId: PROJECT_A, type: 'deliverable_added', title: id, metadata: {}, createdAt, ...overrides });

// 일부러 시간순이 아닌 순서로 넣는다. 저장소가 최신순으로 돌려준다.
const activities: Activity[] = [
  activity('검색확인 오래된 기록', '2026-09-01T09:00:00.000Z', { type: 'issue_created', metadata: { detail: '결함', issueId: 'issue-bug-014' } }),
  activity('검색확인 최신 기록', '2026-10-01T09:00:00.000Z', { type: 'test_case_changed', metadata: { detail: '검토 완료', testCaseId: 'tc-002' } }),
  activity('검색확인 개인 기록', '2026-09-15T09:00:00.000Z', { projectId: undefined, type: 'task_completed', metadata: { detail: '업무 완료' } }),
  activity('검색확인 옛 변경 분석', '2026-09-20T09:00:00.000Z', { type: 'requirements_analyzed', metadata: { detail: '기능 3 · 확인 필요 4' } }),
  activity('변경 분석 검토 완료', '2026-09-25T09:00:00.000Z', { type: 'requirements_analyzed', metadata: { detail: '요구사항 변경 3건 · TC 영향 6건', analysisId: 'cia-plan-v15' } }),
];

async function unmount() {
  await act(async () => root?.unmount());
  router?.dispose();
  container?.remove();
  root = container = router = undefined;
}

function Host() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        검색 열기
      </button>
      <GlobalSearchDialog open={open} onClose={() => setOpen(false)} />
      <Outlet />
    </>
  );
}

async function mount() {
  await unmount();
  const repos = createLocalRepositories({
    openStore: async () => createMemoryStateStore(),
    createInitialData: (): AppData => ({ ...createSeed(), activities: structuredClone(activities) }),
  });
  await repos.persistence.load();
  holder.repos = repos;
  history.replaceState(null, '', '/start');
  // 이동해도 대화상자가 살아 있어야 닫혔는지 볼 수 있어 앱 셸처럼 모든 경로 위에 둔다.
  router = createBrowserRouter([{ element: <Host />, children: [{ path: '/start', element: null }, { path: '*', element: <p>이동한 화면</p> }] }]);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<RouterProvider router={router!} />));
  await userEvent.click(page.getByRole('button', { name: '검색 열기' }));
  await expect.poll(() => dialog()?.open).toBe(true);
}

afterEach(async () => {
  await unmount();
  holder.repos = undefined;
  history.replaceState(null, '', originalUrl);
});

const dialog = () => document.querySelector('dialog');
const search = (query: string) => userEvent.fill(page.getByRole('searchbox', { name: '검색어' }), query);
const recordItems = () => [...(dialog()?.querySelectorAll('section[aria-label="기록"] a') ?? [])];
const pathname = () => router!.state.location.pathname + router!.state.location.search;

describe('전역 검색: 기록', () => {
  it('placeholder가 기록 검색을 알리고, 기록 그룹은 제목 · 프로젝트 · 요약으로 최신 먼저 보인다', async () => {
    await mount();
    expect(page.getByRole('searchbox', { name: '검색어' }).element().getAttribute('placeholder')).toBe('업무, 프로젝트, TC, 기록, 용어, 임시 자료 검색');
    await search('검색확인');
    await expect.poll(() => recordItems().length).toBe(4);
    expect(recordItems().map((item) => item.querySelector('span')?.textContent)).toEqual(['검색확인 최신 기록', '검색확인 옛 변경 분석', '검색확인 개인 기록', '검색확인 오래된 기록']);
    const projectName = (await holder.repos!.projects.get(PROJECT_A))!.name;
    expect(recordItems()[0].textContent).toContain(`${projectName} · 검토 완료`);
    expect(recordItems()[2].textContent).toContain('개인 · 업무 완료');
  });

  it('결과를 누르면 원본 위치로 이동하고 대화상자가 닫히며 검색어도 비워진다', async () => {
    await mount();
    await search('검색확인 최신');
    await expect.poll(() => recordItems().length).toBe(1);
    await userEvent.click(recordItems()[0]);
    await expect.poll(() => pathname()).toBe(`/projects/${PROJECT_A}/test-design?tc=tc-002`);
    await expect.poll(() => dialog()?.open).toBe(false);
    expect(dialog()!.querySelector('input')!.value).toBe('');
  });

  it('프로젝트 없는 개인 기록은 전역 기록으로, 원본 ID가 없는 옛 기록은 프로젝트 기록으로 간다', async () => {
    await mount();
    await search('검색확인 개인');
    await expect.poll(() => recordItems().length).toBe(1);
    await userEvent.click(recordItems()[0]);
    await expect.poll(() => pathname()).toBe('/records');

    await act(async () => router!.navigate('/start'));
    await userEvent.click(page.getByRole('button', { name: '검색 열기' }));
    await expect.poll(() => dialog()?.open).toBe(true);
    await search('검색확인 옛 변경 분석');
    await expect.poll(() => recordItems().length).toBe(1);
    // 옛 기록은 분석을 열 수 없으므로 테스트 설계라고 쓰지 않는다.
    expect(recordItems()[0].textContent).not.toContain('테스트 설계로 이동');
    await userEvent.click(recordItems()[0]);
    await expect.poll(() => pathname()).toBe(`/projects/${PROJECT_A}/records`);
  });

  it('변경 분석 검토 완료 기록은 현재 테스트 설계로 이동한다고 밝히고, 내부 analysisId로는 찾아지지 않는다', async () => {
    await mount();
    await search('cia-plan-v15');
    await expect.poll(() => dialog()?.textContent).toContain('맞는 결과가 없어요');
    expect(recordItems()).toHaveLength(0);

    await search('변경 분석 검토 완료');
    await expect.poll(() => recordItems().length).toBe(1);
    expect(recordItems()[0].textContent).toContain('요구사항 변경 3건 · TC 영향 6건 · 테스트 설계로 이동');
    await userEvent.click(recordItems()[0]);
    await expect.poll(() => pathname()).toBe(`/projects/${PROJECT_A}/test-design`);
  });
});
