import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createBrowserRouter, Outlet, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '@/styles/tokens.css';
import '@/styles/base.css';
import type { AppData } from '@/data/local/appData';
import { createLocalRepositories } from '@/data/local/localRepositories';
import { createMemoryStateStore } from '@/data/local/stateStore';
import { createSeed, PROJECT_A, PROJECT_B } from '@/data/mock/seed';
import type { Repositories } from '@/data/repositories/types';
import type { Activity } from '@/domain/types';
import { ProjectRecordsTab } from './ProjectRecordsTab';

/*
 * 프로젝트 기록 탭을 실제 브라우저(Chromium) · 주소 · 저장소와 함께 띄워 확인한다.
 * 최신순, 종류 필터(주소에 남음, 뒤로가기 동기화), 50건 더 보기, 빈 상태, 이슈 링크, 390px 가로 넘침
 */

const holder = vi.hoisted(() => ({ repos: undefined as Repositories | undefined }));
vi.mock('@/data', () => ({ repositories: new Proxy({}, { get: (_target, key) => holder.repos?.[key as keyof Repositories] }) }));

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let router: ReturnType<typeof createBrowserRouter> | undefined;
const originalUrl = `${location.pathname}${location.search}`;

const activity = (id: string, createdAt: string, overrides: Partial<Activity> = {}): Activity => ({ id, projectId: PROJECT_A, type: 'deliverable_added', title: id, metadata: {}, createdAt, ...overrides });

async function unmount() {
  await act(async () => root?.unmount());
  router?.dispose();
  container?.remove();
  root = container = router = undefined;
}

/** 주어진 활동만 가진 예시 데이터로 탭을 띄운다. */
async function mount(activities: Activity[], search = '') {
  await unmount();
  const repos = createLocalRepositories({
    openStore: async () => createMemoryStateStore(),
    createInitialData: (): AppData => ({ ...createSeed(), activities }),
  });
  await repos.persistence.load();
  holder.repos = repos;
  const project = (await repos.projects.get(PROJECT_A))!;
  history.replaceState(null, '', `${location.pathname}${search}`);
  router = createBrowserRouter([{ element: <Outlet context={{ project, openDeliverableCreate: () => {} }} />, children: [{ path: '*', element: <ProjectRecordsTab /> }] }]);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<RouterProvider router={router!} />));
  await expect.poll(() => container!.querySelector('section')).toBeTruthy();
  return container;
}

afterEach(async () => {
  await unmount();
  holder.repos = undefined;
  history.replaceState(null, '', originalUrl);
  await page.viewport(1280, 900);
});

const titles = (view: HTMLElement) => [...view.querySelectorAll('ol li p:first-child')].map((node) => node.textContent);
const filterButton = (label: string) => page.getByRole('button', { name: new RegExp(`^${label} ?\\d+$`) });
const moreButton = () => page.getByRole('button', { name: /더 보기/ });

const base = [
  activity('산출물-이른', '2026-09-30T09:00:00.000Z'),
  activity('산출물-늦은', '2026-09-30T15:00:00.000Z'),
  activity('결과', '2026-10-01T09:00:00.000Z', { type: 'results_uploaded' }),
  activity('이슈-링크', '2026-10-01T10:00:00.000Z', { type: 'issue_created', metadata: { issueId: 'issue-bug-014' } }),
  activity('이슈-옛기록', '2026-10-01T11:00:00.000Z', { type: 'issue_updated' }),
  activity('다른 프로젝트', '2026-10-01T12:00:00.000Z', { projectId: PROJECT_B }),
];

describe('프로젝트 기록 탭', () => {
  it('이 프로젝트의 기록만 날짜도 같은 날짜 안에서도 최신 먼저 보여준다', async () => {
    const view = await mount(base);
    await expect.poll(() => titles(view)).toEqual(['이슈-옛기록', '이슈-링크', '결과', '산출물-늦은', '산출물-이른']);
  });

  it('종류 필터는 주소에 남고, 뒤로 · 앞으로 가기와 동기화된다', async () => {
    const view = await mount(base);
    await userEvent.click(filterButton('이슈·확인사항'));
    await expect.poll(() => location.search).toBe('?type=issues');
    expect(titles(view)).toEqual(['이슈-옛기록', '이슈-링크']);
    await userEvent.click(filterButton('수행 결과'));
    await expect.poll(() => titles(view)).toEqual(['결과']);
    await act(async () => router!.navigate(-1));
    await expect.poll(() => titles(view)).toEqual(['이슈-옛기록', '이슈-링크']);
    expect(filterButton('이슈·확인사항').element().getAttribute('aria-pressed')).toBe('true');
    await act(async () => router!.navigate(1));
    await expect.poll(() => titles(view)).toEqual(['결과']);
    await userEvent.click(filterButton('전체'));
    await expect.poll(() => location.search).toBe('');
  });

  it('잘못된 type은 전체로 보여준다', async () => {
    const view = await mount(base, '?type=bogus');
    await expect.poll(() => titles(view)).toHaveLength(5);
    expect(filterButton('전체').element().getAttribute('aria-pressed')).toBe('true');
  });

  it('결과가 0건인 종류는 그 종류의 기록이 없다고 알리고, 기록이 전혀 없으면 기존 빈 상태다', async () => {
    const view = await mount(base, '?type=testCases');
    expect(view.textContent).toContain('TC 기록이 없어요.');
    const empty = await mount([]);
    expect(empty.textContent).toContain('아직 기록이 없어요.');
    expect(empty.querySelector('[role="group"]')).toBeNull();
  });

  it('50건씩 보여주고 더 보기로 늘리며, 종류를 바꾸면 다시 50건부터 보여준다', async () => {
    const many = Array.from({ length: 120 }, (_, index) =>
      activity(`기록-${String(index).padStart(3, '0')}`, new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(), { type: index < 60 ? 'results_uploaded' : 'deliverable_added' }),
    );
    const view = await mount(many);
    expect(titles(view)).toHaveLength(50);
    expect(titles(view)[0]).toBe('기록-119');
    await userEvent.click(moreButton());
    await expect.poll(() => titles(view)).toHaveLength(100);
    await userEvent.click(filterButton('수행 결과'));
    await expect.poll(() => titles(view)).toHaveLength(50);
    await userEvent.click(moreButton());
    await expect.poll(() => titles(view)).toHaveLength(60);
    expect(moreButton().elements()).toHaveLength(0);
  });

  it('issueId가 있는 이슈 기록은 해당 이슈로 연결되고, 없는 옛 기록과 다른 종류는 링크가 없다', async () => {
    const view = await mount(base);
    const links = [...view.querySelectorAll('a')].map((link) => `${link.textContent}→${link.getAttribute('href')}`);
    expect(links).toEqual([`이슈-링크→/projects/${PROJECT_A}/issues?issue=issue-bug-014`]);
    await userEvent.click(page.getByRole('link', { name: '이슈-링크' }));
    await expect.poll(() => router!.state.location.pathname + router!.state.location.search).toBe(`/projects/${PROJECT_A}/issues?issue=issue-bug-014`);
  });

  it('390px에서 가로로 넘치지 않는다', async () => {
    await page.viewport(390, 844);
    await mount([...base, activity('아주 긴 제목 '.repeat(12), '2026-10-01T13:00:00.000Z')]);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });
});
