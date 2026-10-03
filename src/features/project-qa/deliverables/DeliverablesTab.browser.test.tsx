import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createBrowserRouter, Outlet, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import '@/styles/tokens.css';
import '@/styles/base.css';
import { createLocalRepositories } from '@/data/local/localRepositories';
import { createMemoryStateStore } from '@/data/local/stateStore';
import { createSeed, PROJECT_A } from '@/data/mock/seed';
import type { Repositories } from '@/data/repositories/types';
import { DeliverablesTab } from './DeliverablesTab';

/*
 * 산출물 탭을 실제 브라우저(Chromium)와 주소로 확인한다.
 * `?deliverable=<id>`로 이 프로젝트의 산출물을 표시하고(aria-current), 없는 ID · 다른 프로젝트 ID · 빈 값은 아무것도 고르지 않는다.
 */

const holder = vi.hoisted(() => ({ repos: undefined as Repositories | undefined }));
vi.mock('@/data', () => ({ repositories: new Proxy({}, { get: (_target, key) => holder.repos?.[key as keyof Repositories] }) }));

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let router: ReturnType<typeof createBrowserRouter> | undefined;
const originalUrl = `${location.pathname}${location.search}`;

async function mount(search = '') {
  const repos = createLocalRepositories({ openStore: async () => createMemoryStateStore(), createInitialData: createSeed });
  await repos.persistence.load();
  holder.repos = repos;
  const project = (await repos.projects.get(PROJECT_A))!;
  history.replaceState(null, '', `${location.pathname}${search}`);
  router = createBrowserRouter([{ element: <Outlet context={{ project, openDeliverableCreate: () => {} }} />, children: [{ path: '*', element: <DeliverablesTab /> }] }]);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<RouterProvider router={router!} />));
  await expect.poll(() => container!.querySelectorAll('ul li[class*="item"]').length).toBeGreaterThan(0);
  return container;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  router?.dispose();
  container?.remove();
  root = container = router = undefined;
  holder.repos = undefined;
  history.replaceState(null, '', originalUrl);
  await page.viewport(1280, 900);
});

const items = (view: HTMLElement) => [...view.querySelectorAll('ul li[class*="item"]')];
const selected = (view: HTMLElement) => items(view).filter((item) => item.getAttribute('aria-current') === 'true');
const titleOf = (item: Element) => item.querySelector('p')?.textContent?.replace('선택한 산출물: ', '');

describe('산출물 탭: ?deliverable= 선택', () => {
  it('query가 없으면 아무것도 선택하지 않고 기존 화면 그대로다', async () => {
    const view = await mount();
    expect(items(view)).toHaveLength(6);
    expect(selected(view)).toHaveLength(0);
    expect(view.querySelector('[class*="selected"]')).toBeNull();
  });

  it('이 프로젝트의 산출물 ID면 그 산출물만 aria-current로 선택하고, 제목 · 메타 · 기존 동작은 그대로다', async () => {
    const view = await mount('?deliverable=dlv-plan-pdf-v15');
    expect(selected(view)).toHaveLength(1);
    const [item] = selected(view);
    expect(titleOf(item)).toBe('모바일_개편_기획_v1.5.pdf');
    // 색이 아닌 텍스트로도 선택 상태를 알린다(화면에는 보이지 않는다).
    expect(item.querySelector('.visually-hidden')?.textContent).toBe('선택한 산출물: ');
    expect(item.textContent).toContain('추가');
    expect(item.querySelector('a, [class*="pending"]')).not.toBeNull();
    // 다른 산출물은 선택되지 않고 목록도 그대로다.
    expect(items(view).filter((other) => other !== item).every((other) => !other.hasAttribute('aria-current'))).toBe(true);
    expect(items(view)).toHaveLength(6);
    expect(location.search).toBe('?deliverable=dlv-plan-pdf-v15');
  });

  it('선택한 산출물이 화면 밖에 있어도 보이는 위치로 스크롤한다', async () => {
    await page.viewport(1280, 360);
    const view = await mount('?deliverable=dlv-staging-url');
    const [item] = selected(view);
    await expect.poll(() => item.getBoundingClientRect().bottom <= window.innerHeight + 1 && item.getBoundingClientRect().top >= 0).toBe(true);
  });

  it.each([
    ['없는 ID', '?deliverable=dlv-missing'],
    ['빈 값', '?deliverable='],
    ['다른 프로젝트의 산출물 ID', '?deliverable=dlv-b-spec'],
    ['산출물이 아닌 ID', '?deliverable=cia-plan-v15'],
  ])('%s는 오류 없이 아무것도 선택하지 않는다', async (_, search) => {
    const view = await mount(search);
    expect(items(view)).toHaveLength(6);
    expect(selected(view)).toHaveLength(0);
  });

  it('390px에서 가로로 넘치지 않는다', async () => {
    await page.viewport(390, 844);
    const view = await mount('?deliverable=dlv-api-doc');
    expect(selected(view)).toHaveLength(1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });
});
