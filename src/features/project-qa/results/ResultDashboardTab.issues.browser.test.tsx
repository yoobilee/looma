import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createBrowserRouter, Outlet, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '@/styles/tokens.css';
import '@/styles/base.css';
import type { AppData, StoredAppState } from '@/data/local/appData';
import { createLocalRepositories } from '@/data/local/localRepositories';
import { createMemoryStateStore } from '@/data/local/stateStore';
import { importQaRound, QA_EXTERNAL_ID, QA_TEST_CASE_ID, qaScenarioSeed } from '@/data/mock/issueScenario';
import { PROJECT_A } from '@/data/mock/seed';
import type { Repositories } from '@/data/repositories/types';
import { compareResultRounds } from '@/domain/resultComparison';
import { ResultDashboardTab } from './ResultDashboardTab';

/*
 * 수행 결과 화면에서 이슈 · 확인사항을 만드는 흐름을 실제 브라우저(Chromium)에서 확인한다.
 * - 재수행 필요(FAIL · BLOCKED) 행에서만 만들기를 보여 주고, 결과 · TC · 차수 · 플랫폼을 연결한다. 자동으로 만들지 않는다.
 * - 수행 결과 비교의 신규 실패 · 계속 실패 · 신규 차단 행에서 비교 차수의 실제 결과에 연결한다.
 * - 이슈를 만들어도 수행 결과 · TC는 바뀌지 않는다.
 */

const holder = vi.hoisted(() => ({ repos: undefined as Repositories | undefined }));
vi.mock('@/data', () => ({ repositories: new Proxy({}, { get: (_target, key) => holder.repos?.[key as keyof Repositories] }) }));

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let router: ReturnType<typeof createBrowserRouter> | undefined;
const originalUrl = `${location.pathname}${location.search}`;

type MemoryStore = ReturnType<typeof createMemoryStateStore>;

async function mount(search: string, { store = createMemoryStateStore(), createInitialData }: { store?: MemoryStore; createInitialData?: () => AppData } = {}) {
  const repos = createLocalRepositories({ openStore: async () => store, ...(createInitialData && { createInitialData }) });
  await repos.persistence.load();
  holder.repos = repos;
  return { repos, store, render: () => render(repos, search) };
}

async function render(repos: Repositories, search: string) {
  const project = (await repos.projects.get(PROJECT_A))!;
  history.replaceState(null, '', `${location.pathname}${search}`);
  router = createBrowserRouter([{ element: <Outlet context={{ project, openDeliverableCreate: () => {} }} />, children: [{ path: '*', element: <ResultDashboardTab /> }] }]);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<RouterProvider router={router!} />));
  await expect.poll(() => container!.querySelector('h2, [role="group"]')).toBeTruthy();
  return container;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  router?.dispose();
  container?.remove();
  root = undefined;
  container = undefined;
  router = undefined;
  holder.repos = undefined;
  history.replaceState(null, '', originalUrl);
  await page.viewport(1280, 900);
});

const dialog = () => document.querySelector('dialog[open]') as HTMLDialogElement | null;
const createButton = (target: string) => page.getByRole('button', { name: `${target} 이슈 / 확인사항 만들기` });
const checkedType = () => (dialog()!.querySelector('input[type="radio"]:checked') as HTMLInputElement).value;
const data = (store: MemoryStore) => (store.inspect().state as StoredAppState & { data: AppData }).data;

async function showAllRetests() {
  const more = [...document.querySelectorAll('button')].find((button) => /건 더 보기$/.test(button.textContent ?? ''));
  if (more) await userEvent.click(more);
}

describe('수행 결과에서 이슈 / 확인사항 만들기', () => {
  it('FAIL 행에서 열면 이슈로 시작하고 TC · 차수 · 플랫폼 · 결과를 보여 주며 Expected · 비고를 채우고, 만들면 그 결과에 연결된다', async () => {
    const { store, render: draw } = await mount('');
    const view = await draw();
    const before = data(store);

    await userEvent.click(createButton('SIGN-002'));
    await expect.poll(() => dialog()).toBeTruthy();
    expect(checkedType()).toBe('defect');
    const source = dialog()!.querySelector('section[aria-label="연결할 수행 결과"]')!.textContent!;
    for (const text of ['SIGN-002', '2차', 'iOS', 'FAIL']) expect(source).toContain(text);
    // 같은 결과에 이미 연결된 BUG-014를 알려 주지만 막지 않는다.
    expect(source).toContain('이미 연결된 항목이 1건');
    expect((page.getByLabelText('Expected Result', { exact: true }).element() as HTMLTextAreaElement).value).toBe('가입 진행 가능');
    expect((page.getByLabelText('Actual', { exact: true }).element() as HTMLTextAreaElement).value).toBe('iOS 문구 상이');
    // 만들기 전에는 아무것도 저장하지 않는다.
    expect(data(store).issues).toEqual(before.issues);

    await userEvent.fill(page.getByLabelText('제목', { exact: true }), 'iOS 오류 문구 재확인');
    await userEvent.click(page.getByRole('button', { name: '이슈 만들기' }));
    await expect.poll(() => dialog()).toBeNull();

    const created = data(store).issues.find((issue) => issue.title === 'iOS 오류 문구 재확인');
    expect(created).toMatchObject({ type: 'defect', status: 'open', resultId: 'imp-a-2-SIGN-002-ios', testCaseId: 'tc-002', expected: '가입 진행 가능', actual: 'iOS 문구 상이' });
    expect(data(store).results).toEqual(before.results);
    expect(data(store).testCases).toEqual(before.testCases);
    // 행에 연결된 항목 링크가 늘어난다.
    await expect.poll(() => view.querySelectorAll(`a[href="/projects/${PROJECT_A}/issues?issue=${created!.id}"]`).length).toBe(1);
  });

  it('BLOCKED만 있는 행은 확인사항으로 시작하고, 플랫폼별 결과 중 하나를 골라 연결한다', async () => {
    const { store, render: draw } = await mount('');
    await draw();
    await showAllRetests();
    await userEvent.click(createButton('LOGIN-018'));
    await expect.poll(() => dialog()).toBeTruthy();
    expect(checkedType()).toBe('question');
    const select = page.getByLabelText('연결할 결과', { exact: true }).element() as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(['Android · BLOCKED', 'iOS · BLOCKED']);
    await userEvent.selectOptions(select, 'imp-a-2-LOGIN-018-ios');
    expect(dialog()!.textContent).toContain('iOS');

    await userEvent.fill(page.getByLabelText('제목', { exact: true }), '실패 횟수 정책 확인');
    await userEvent.click(page.getByRole('button', { name: '확인사항 만들기' }));
    await expect.poll(() => dialog()).toBeNull();
    expect(data(store).issues.find((issue) => issue.title === '실패 횟수 정책 확인')).toMatchObject({ type: 'question', resultId: 'imp-a-2-LOGIN-018-ios' });
  });

  it('취소하면 아무것도 만들지 않는다', async () => {
    const { store, render: draw } = await mount('');
    await draw();
    const before = store.inspect();
    await userEvent.click(createButton('SIGN-002'));
    await userEvent.fill(page.getByLabelText('제목', { exact: true }), '취소할 항목');
    await userEvent.click(page.getByRole('button', { name: '취소' }));
    await expect.poll(() => dialog()).toBeNull();
    expect(store.inspect()).toEqual(before);
  });

  it('비교 화면은 신규 실패 · 계속 실패 · 신규 차단 행에만 만들기를 보여 주고, 비교 차수의 실제 결과에 연결한다', async () => {
    const { repos, store, render: draw } = await mount('?view=compare');
    const view = await draw();
    const imports = await repos.testResults.listImports(PROJECT_A);
    const results = (await Promise.all(imports.map((item) => repos.testResults.listResults(item.id)))).flat();
    const comparison = compareResultRounds(imports[0], imports[1], results);
    if (!comparison.ok) throw new Error(comparison.reason);

    const actionable = new Set(['신규 실패', '계속 실패', '신규 차단']);
    const tableRows = [...view.querySelectorAll('tbody tr')];
    expect(tableRows.length).toBeGreaterThan(0);
    for (const row of tableRows) {
      const change = row.querySelector('td[data-label="변화"]')!.textContent!;
      const hasAction = !!row.querySelector('td[data-label="이슈 / 확인사항"] button');
      expect(hasAction, change).toBe(actionable.has(change));
    }

    const newlyFailed = tableRows.find((row) => row.querySelector('td[data-label="변화"]')!.textContent === '신규 실패')!;
    const externalId = newlyFailed.querySelector('td[data-label="TC ID"]')!.textContent!;
    const platform = newlyFailed.querySelector('td[data-label="플랫폼"]')!.textContent!;
    await userEvent.click(newlyFailed.querySelector('td[data-label="이슈 / 확인사항"] button')!);
    await expect.poll(() => dialog()).toBeTruthy();
    expect(dialog()!.textContent).toContain('2차');
    await userEvent.fill(page.getByLabelText('제목', { exact: true }), '비교에서 만든 이슈');
    await userEvent.click(page.getByRole('button', { name: '이슈 만들기' }));
    await expect.poll(() => dialog()).toBeNull();

    const created = data(store).issues.find((issue) => issue.title === '비교에서 만든 이슈')!;
    const expectedRow = comparison.rows.find((row) => row.changeType === 'newly_failed' && row.currentResultId === created.resultId);
    expect(expectedRow).toBeDefined();
    const linkedResult = results.find((result) => result.id === created.resultId)!;
    expect(linkedResult).toMatchObject({ importId: imports[1].id, result: 'fail', externalId });
    expect(linkedResult.platform === 'ios' ? 'iOS' : 'Android').toBe(platform);
    // 비교 행 자체(key 등)는 저장하지 않는다.
    expect(JSON.stringify(created)).not.toContain(expectedRow!.key);
  });

  it('실제 QA 흐름: TC-101 Android 1차 PASS → 2차 FAIL을 비교에서 이슈로 만들고, 3차 PASS를 가져와도 자동으로 해결되지 않는다', async () => {
    const { repos, store, render: draw } = await mount('?view=compare', { createInitialData: qaScenarioSeed });
    await importQaRound(repos, 1, 'P');
    const second = await importQaRound(repos, 2, 'F');
    const view = await draw();

    const [row] = view.querySelectorAll('tbody tr');
    expect(row.querySelector('td[data-label="TC ID"]')!.textContent).toBe(QA_EXTERNAL_ID);
    expect(row.querySelector('td[data-label="변화"]')!.textContent).toBe('신규 실패');
    await userEvent.click(createButton(`${QA_EXTERNAL_ID} Android`));
    await expect.poll(() => dialog()).toBeTruthy();
    expect(checkedType()).toBe('defect');
    await userEvent.fill(page.getByLabelText('제목', { exact: true }), 'Android 로그인 실패');
    await userEvent.click(page.getByRole('button', { name: '이슈 만들기' }));
    await expect.poll(() => dialog()).toBeNull();

    const [issue] = data(store).issues;
    expect(issue).toMatchObject({ type: 'defect', status: 'open', resultId: second.result.id, testCaseId: QA_TEST_CASE_ID });
    await expect.poll(() => row.querySelector('td[data-label="이슈 / 확인사항"] a')?.textContent).toBe('이슈 · 확인 필요');

    await importQaRound(repos, 3, 'P');
    // 화면이 2 → 3차 비교(수정됨)로 바뀌어도 이슈는 그대로다.
    await expect.poll(() => view.querySelector('tbody tr td[data-label="변화"]')?.textContent).toBe('수정됨');
    expect(data(store).issues).toEqual([issue]);
  });

  it('390px에서 재수행 목록의 만들기 버튼 · 연결 링크가 화면 안에 들어온다', async () => {
    await page.viewport(390, 844);
    const { render: draw } = await mount('');
    const view = await draw();
    await showAllRetests();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    const actions = view.querySelectorAll('button[aria-label$="이슈 / 확인사항 만들기"], a[href*="/issues?issue="]');
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) expect(action.getBoundingClientRect().right).toBeLessThanOrEqual(390.5);
  });

  it('390px에서 비교 카드의 만들기 버튼과 만들기 대화상자가 화면 안에 들어온다', async () => {
    await page.viewport(390, 844);
    const { render: draw } = await mount('?view=compare');
    const view = await draw();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    for (const button of view.querySelectorAll('td[data-label="이슈 / 확인사항"] button')) expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(390.5);

    await userEvent.click(view.querySelector('td[data-label="이슈 / 확인사항"] button')!);
    await expect.poll(() => dialog()).toBeTruthy();
    const box = dialog()!.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(390.5);
    const panel = dialog()!.firstElementChild as HTMLElement;
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
  });
});
