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
import type { TestAssetImportSession } from '@/domain/types';
import { ImportHistoryTab } from './ImportHistoryTab';

/*
 * 가져오기 이력 탭을 실제 브라우저(Chromium)와 주소로 확인한다.
 * `?assetImport=<TC 가져오기 id>`로 그 가져오기만 표시하고(aria-current), 수행 결과 차수 ID · 없는 ID · 다른 프로젝트 ID · 빈 값은 아무것도 고르지 않는다.
 * 선택한 항목이 현재 필터에 가려지면 전체로 맞춘다. 수행 결과 링크와 원본 형식 내보내기는 그대로다.
 */

const holder = vi.hoisted(() => ({ repos: undefined as Repositories | undefined }));
vi.mock('@/data', () => ({ repositories: new Proxy({}, { get: (_target, key) => holder.repos?.[key as keyof Repositories] }) }));

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let router: ReturnType<typeof createBrowserRouter> | undefined;
const originalUrl = `${location.pathname}${location.search}`;

const session = (id: string, projectId: string, fileName: string, importedAt: string): TestAssetImportSession => ({
  id,
  projectId,
  fileName,
  importedAt,
  totalRows: 12,
  created: 10,
  updated: 1,
  unchanged: 1,
  excluded: 0,
});

async function mount(search = '') {
  const repos = createLocalRepositories({
    openStore: async () => createMemoryStateStore(),
    createInitialData: (): AppData => ({
      ...createSeed(),
      testAssetImports: [
        session('tai-a1', PROJECT_A, '고객사A_TC_1.csv', '2026-09-01T09:00:00.000Z'),
        session('tai-a2', PROJECT_A, '고객사A_TC_2.csv', '2026-09-02T09:00:00.000Z'),
        session('tai-b1', PROJECT_B, '고객사B_TC.csv', '2026-09-03T09:00:00.000Z'),
      ],
    }),
  });
  await repos.persistence.load();
  holder.repos = repos;
  const project = (await repos.projects.get(PROJECT_A))!;
  history.replaceState(null, '', `${location.pathname}${search}`);
  router = createBrowserRouter([{ element: <Outlet context={{ project, openDeliverableCreate: () => {} }} />, children: [{ path: '*', element: <ImportHistoryTab /> }] }]);
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
const fileOf = (item: Element) => item.querySelector('[class*="fileName"]')?.textContent;
const filterButton = (label: string) => page.getByRole('button', { name: new RegExp(`^${label} ?\\d+$`) });

describe('가져오기 이력 탭: ?assetImport= 선택', () => {
  it('query가 없으면 아무것도 선택하지 않고 기존 화면 그대로다(이 프로젝트의 TC 가져오기 2건 + 수행 결과 2건)', async () => {
    const view = await mount();
    expect(items(view)).toHaveLength(4);
    expect(selected(view)).toHaveLength(0);
    expect(view.querySelector('[class*="selected"]')).toBeNull();
  });

  it('이 프로젝트의 TC 가져오기 ID면 그 항목만 aria-current로 선택하고, 다른 항목 · 링크 · 내보내기는 그대로다', async () => {
    const view = await mount('?assetImport=tai-a2');
    expect(selected(view)).toHaveLength(1);
    const [item] = selected(view);
    expect(fileOf(item)).toBe('고객사A_TC_2.csv');
    expect(item.querySelector('.visually-hidden')?.textContent).toBe('선택한 가져오기: ');
    expect(item.textContent).toContain('TC 가져오기');
    expect(item.querySelector('a')?.getAttribute('href')).toBe(`/projects/${PROJECT_A}/test-design`);
    // 원본 형식 내보내기 영역도 그대로 있다(이 가져오기는 원본을 보관하지 않아 사용할 수 없다고 안내한다).
    expect(item.textContent).toContain('원본 형식 XLSX 내보내기를 사용할 수 없어요');
    // 수행 결과 항목의 링크는 기존 ?import= 그대로다.
    const resultLinks = items(view).flatMap((other) => [...other.querySelectorAll('a')].map((link) => link.getAttribute('href')).filter((href) => href?.includes('/results')));
    expect(resultLinks).toEqual([`/projects/${PROJECT_A}/results?import=imp-a-2`, `/projects/${PROJECT_A}/results?import=imp-a-1`]);
    expect(items(view)).toHaveLength(4);
  });

  it.each([
    ['없는 ID', '?assetImport=tai-missing'],
    ['빈 값', '?assetImport='],
    ['다른 프로젝트의 TC 가져오기 ID', '?assetImport=tai-b1'],
    ['수행 결과 차수 ID(타입이 맞지 않음)', '?assetImport=imp-a-2'],
    ['수행 결과 화면의 query(import)는 TC 가져오기를 고르지 않는다', '?import=tai-a1'],
  ])('%s는 오류 없이 아무것도 선택하지 않는다', async (_, search) => {
    const view = await mount(search);
    expect(items(view)).toHaveLength(4);
    expect(selected(view)).toHaveLength(0);
  });

  it('선택한 항목이 가려지는 필터에서 주소가 바뀌면 전체로 맞춰 항목이 보이고, 직접 고른 필터는 방해하지 않는다', async () => {
    const view = await mount();
    await userEvent.click(filterButton('수행 결과 가져오기'));
    await expect.poll(() => items(view)).toHaveLength(2);
    // 필터 때문에 TC 가져오기가 가려진 상태에서 대상이 있는 주소로 이동한다(검색 · 기록 링크).
    await act(async () => router!.navigate(`${location.pathname}?assetImport=tai-a1`));
    await expect.poll(() => selected(view).map(fileOf)).toEqual(['고객사A_TC_1.csv']);
    expect(filterButton('전체').element().getAttribute('aria-pressed')).toBe('true');
    // 사용자가 필터를 바꾸면 그대로 따른다(선택 항목이 가려져도 되돌리지 않는다).
    await userEvent.click(filterButton('수행 결과 가져오기'));
    await expect.poll(() => items(view)).toHaveLength(2);
    expect(selected(view)).toHaveLength(0);
    expect(location.search).toBe('?assetImport=tai-a1');
  });

  it('선택한 항목이 화면 밖에 있어도 보이는 위치로 스크롤한다', async () => {
    await page.viewport(1280, 300);
    const view = await mount('?assetImport=tai-a1');
    const [item] = selected(view);
    await expect.poll(() => item.getBoundingClientRect().bottom <= window.innerHeight + 1 && item.getBoundingClientRect().top >= 0).toBe(true);
  });

  it('390px에서 가로로 넘치지 않는다', async () => {
    await page.viewport(390, 844);
    const view = await mount('?assetImport=tai-a2');
    expect(selected(view)).toHaveLength(1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });
});
