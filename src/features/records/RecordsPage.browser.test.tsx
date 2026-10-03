import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '@/styles/tokens.css';
import '@/styles/base.css';
import { CommandsContext } from '@/app/commandsContext';
import type { AppData } from '@/data/local/appData';
import { createLocalRepositories } from '@/data/local/localRepositories';
import { createMemoryStateStore } from '@/data/local/stateStore';
import { createSeed, PROJECT_A, PROJECT_B } from '@/data/mock/seed';
import type { Repositories } from '@/data/repositories/types';
import type { Activity } from '@/domain/types';
import { RecordsPage } from './RecordsPage';

/*
 * 전역 기록 화면을 실제 브라우저(Chromium) · 주소 · 저장소와 함께 띄워 확인한다.
 * 종류 필터(?type=)와 범위의 조합, 날짜 목록 · 선택한 날 · 하루 정리 동기화, 활동 자신의 프로젝트 기준 원본 링크, 390px 가로 넘침
 */

const holder = vi.hoisted(() => ({ repos: undefined as Repositories | undefined }));
vi.mock('@/data', () => ({ repositories: new Proxy({}, { get: (_target, key) => holder.repos?.[key as keyof Repositories] }) }));

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let router: ReturnType<typeof createBrowserRouter> | undefined;
const originalUrl = `${location.pathname}${location.search}`;

/** 로컬 시각 기준 날짜. 날짜 묶음(dayKey)도 로컬 기준이라 시간대와 무관하다. */
const local = (month: number, day: number, hour: number) => new Date(2026, month - 1, day, hour).toISOString();
const activity = (id: string, createdAt: string, overrides: Partial<Activity> = {}): Activity => ({ id, projectId: PROJECT_A, type: 'deliverable_added', title: id, metadata: {}, createdAt, ...overrides });

const activities: Activity[] = [
  // 9/30
  activity('산출물-A', local(9, 30, 10), { metadata: { detail: 'PDF', deliverableId: 'dlv-1' } }),
  activity('TC-B-전날', local(9, 30, 11), { projectId: PROJECT_B, type: 'test_case_changed', metadata: { detail: '검토 완료', testCaseId: 'tc-b-0' } }),
  activity('개인-완료', local(9, 30, 12), { projectId: undefined, type: 'task_completed', metadata: { detail: '업무 완료' } }),
  // 10/1
  activity('이슈-A', local(10, 1, 9), { type: 'issue_created', metadata: { detail: '결함', issueId: 'issue-a' } }),
  activity('결과-A', local(10, 1, 10), { type: 'results_uploaded', metadata: { detail: 'PASS 3', resultImportId: 'imp-a' } }),
  activity('검토-A', local(10, 1, 11), { type: 'requirements_analyzed', metadata: { detail: '요구사항 변경 3건 · TC 영향 6건', analysisId: 'cia-a' } }),
  activity('반영-A', local(10, 1, 12), { type: 'changes_applied', metadata: { detail: '요구사항 1 · TC 2', analysisId: 'cia-a' } }),
  activity('TC-A', local(10, 1, 13), { type: 'test_case_changed', metadata: { detail: '검토 완료', testCaseId: 'tc-a' } }),
  // 10/2
  activity('이슈-B', local(10, 2, 9), { projectId: PROJECT_B, type: 'issue_updated', metadata: { detail: '확인 필요 → 해결됨', issueId: 'issue-b' } }),
  activity('TC-B', local(10, 2, 10), { projectId: PROJECT_B, type: 'test_case_changed', metadata: { detail: '검토 완료', testCaseId: 'tc-b' } }),
  activity('결과-옛기록', local(10, 2, 11), { type: 'results_uploaded', metadata: { detail: 'PASS 3' } }),
  activity('TC-엉뚱한key', local(10, 2, 12), { type: 'test_case_changed', metadata: { detail: '검토 완료', issueId: 'issue-a' } }),
  activity('개인-이슈형', local(10, 2, 13), { projectId: undefined, type: 'issue_created', metadata: { detail: '프로젝트 없음', issueId: 'issue-x' } }),
];

async function unmount() {
  await act(async () => root?.unmount());
  router?.dispose();
  container?.remove();
  root = container = router = undefined;
}

async function mount(search = '') {
  await unmount();
  const repos = createLocalRepositories({
    openStore: async () => createMemoryStateStore(),
    createInitialData: (): AppData => ({ ...createSeed(), activities: structuredClone(activities) }),
  });
  await repos.persistence.load();
  holder.repos = repos;
  history.replaceState(null, '', `/records${search}`);
  const commands = { openSearch: () => {}, openTaskCreate: () => {}, openScratchDrawer: () => {} };
  router = createBrowserRouter([
    { path: '/records', element: <CommandsContext.Provider value={commands}><RecordsPage /></CommandsContext.Provider> },
    { path: '*', element: <p>이동한 화면</p> },
  ]);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<RouterProvider router={router!} />));
  await expect.poll(() => container!.querySelector('[role="group"]')).toBeTruthy();
  return container;
}

afterEach(async () => {
  await unmount();
  holder.repos = undefined;
  history.replaceState(null, '', originalUrl);
  await page.viewport(1280, 900);
});

const titles = (view: HTMLElement) => [...view.querySelectorAll('ol li p:first-child')].map((node) => node.textContent);
const dates = (view: HTMLElement) => [...view.querySelectorAll('ul button[aria-pressed]')].map((node) => node.textContent?.replace(/\d+$/, '').replace('오늘 · ', '').trim());
const activeDate = (view: HTMLElement) => view.querySelector('ul button[aria-pressed="true"]')?.textContent?.replace(/\d+$/, '').replace('오늘 · ', '').trim();
const shownDay = (view: HTMLElement) => view.querySelector('h2[id="records-day-title"]')?.textContent;
const summary = (view: HTMLElement) => [...view.querySelectorAll('[class*="summaryLines"] li')].map((node) => node.textContent);
const filterButton = (label: string) => page.getByRole('button', { name: new RegExp(`^${label} ?\\d+$`) });
const dateButton = (view: HTMLElement, label: string) => [...view.querySelectorAll<HTMLButtonElement>('ul button[aria-pressed]')].find((node) => node.textContent?.includes(label))!;
const links = (view: HTMLElement) => [...view.querySelectorAll('ol a')].map((link) => `${link.textContent}→${link.getAttribute('href')}`);
const chooseScope = (view: HTMLElement, value: string) => userEvent.selectOptions(view.querySelector('select')!, value);

describe('전역 기록: 종류 필터', () => {
  it('종류를 고르면 주소(?type=)에 남고, 그 종류의 활동 · 날짜 · 하루 정리만 보이며, 뒤로 가기와 동기화된다', async () => {
    const view = await mount();
    // 전체: 가장 최근 날(10/2)의 활동이 모두 보인다.
    expect(dates(view)).toEqual(['10월 2일', '10월 1일', '9월 30일']);
    expect(titles(view)).toEqual(['이슈-B', 'TC-B', '결과-옛기록', 'TC-엉뚱한key', '개인-이슈형']);

    await userEvent.click(filterButton('이슈·확인사항'));
    await expect.poll(() => location.search).toBe('?type=issues');
    // 이슈가 있는 날짜만 남고(9/30 제외), 최신 날의 이슈 활동만 보인다.
    await expect.poll(() => dates(view)).toEqual(['10월 2일', '10월 1일']);
    expect(titles(view)).toEqual(['이슈-B', '개인-이슈형']);
    // 하루 정리도 필터 밖 활동(TC · 결과)을 섞지 않는다.
    expect(summary(view)).toEqual(['이슈·확인사항 상태를 1번 바꿨어요.', '이슈·확인사항 1건을 등록했어요.']);

    await userEvent.click(filterButton('TC'));
    await expect.poll(() => titles(view)).toEqual(['TC-B', 'TC-엉뚱한key']);
    expect(summary(view)).toEqual(['TC 변경 2건이 있었어요.']);

    await act(async () => router!.navigate(-1));
    await expect.poll(() => titles(view)).toEqual(['이슈-B', '개인-이슈형']);
    expect(filterButton('이슈·확인사항').element().getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(filterButton('전체'));
    await expect.poll(() => location.search).toBe('');
    await expect.poll(() => titles(view)).toHaveLength(5);
  });

  it('잘못된 type은 전체로 보여준다', async () => {
    const view = await mount('?type=bogus');
    expect(titles(view)).toHaveLength(5);
    expect(filterButton('전체').element().getAttribute('aria-pressed')).toBe('true');
  });
});

describe('전역 기록: 범위와 종류의 조합', () => {
  it('프로젝트 A + TC는 프로젝트 A의 TC 활동만 보여준다', async () => {
    const view = await mount();
    await chooseScope(view, PROJECT_A);
    await userEvent.click(filterButton('TC'));
    await expect.poll(() => dates(view)).toEqual(['10월 2일', '10월 1일']);
    expect(titles(view)).toEqual(['TC-엉뚱한key']);
    await userEvent.click(page.getByRole('button', { name: /10월 1일/ }));
    await expect.poll(() => titles(view)).toEqual(['TC-A']);
    // 프로젝트 B의 TC 활동은 어느 날에도 없다.
    expect(view.textContent).not.toContain('TC-B');
  });

  it('개인 업무는 프로젝트 없는 활동만 보여주고 종류와도 조합된다', async () => {
    const view = await mount();
    await chooseScope(view, 'personal');
    await expect.poll(() => dates(view)).toEqual(['10월 2일', '9월 30일']);
    expect(titles(view)).toEqual(['개인-이슈형']);
    // 개인 활동 중 기타는 9/30의 업무 완료뿐이라 그날로 옮겨 보인다.
    await userEvent.click(filterButton('기타'));
    await expect.poll(() => titles(view)).toEqual(['개인-완료']);
    expect(dates(view)).toEqual(['9월 30일']);
    // 개인 활동에는 TC 기록이 없다.
    await userEvent.click(filterButton('TC'));
    await expect.poll(() => titles(view)).toEqual([]);
    expect(view.textContent).toContain('이 조건에 맞는 기록이 없어요.');
    expect(view.textContent).toContain('TC 기록이 없어요.');
    await userEvent.click(filterButton('이슈·확인사항'));
    await expect.poll(() => titles(view)).toEqual(['개인-이슈형']);
  });

  it('선택한 날에 결과가 없어지면 그 필터의 가장 최근 날로 옮겨 보이고, 선택 표시와 보이는 날이 같다', async () => {
    const view = await mount();
    await userEvent.click(page.getByRole('button', { name: /9월 30일/ }));
    await expect.poll(() => shownDay(view)).toBe('9월 30일');
    expect(titles(view)).toEqual(['산출물-A', 'TC-B-전날', '개인-완료']);

    // 9/30에는 이슈 활동이 없다.
    await userEvent.click(filterButton('이슈·확인사항'));
    await expect.poll(() => shownDay(view)).toBe('10월 2일');
    expect(activeDate(view)).toBe('10월 2일');
    expect(titles(view)).toEqual(['이슈-B', '개인-이슈형']);
    expect(dateButton(view, '9월 30일')).toBeUndefined();

    // 범위를 바꿔도 같다: 프로젝트 B에는 10/1 활동이 없다.
    await userEvent.click(page.getByRole('button', { name: /10월 1일/ }));
    await expect.poll(() => shownDay(view)).toBe('10월 1일');
    await chooseScope(view, PROJECT_B);
    await expect.poll(() => shownDay(view)).toBe('10월 2일');
    expect(activeDate(view)).toBe('10월 2일');
    expect(titles(view)).toEqual(['이슈-B']);
  });
});

describe('전역 기록: 원본 링크', () => {
  it('활동 자신의 프로젝트 기준으로 연결하고, 변경 분석 기록은 제목이 아닌 "테스트 설계 보기"로 연결한다', async () => {
    const view = await mount();
    await userEvent.click(page.getByRole('button', { name: /10월 1일/ }));
    await expect.poll(() => titles(view)).toEqual(['이슈-A', '결과-A', '검토-A', '반영-A', 'TC-A']);
    expect(links(view)).toEqual([
      `이슈-A→/projects/${PROJECT_A}/issues?issue=issue-a`,
      `결과-A→/projects/${PROJECT_A}/results?import=imp-a`,
      `테스트 설계 보기→/projects/${PROJECT_A}/test-design`,
      `테스트 설계 보기→/projects/${PROJECT_A}/test-design`,
      `TC-A→/projects/${PROJECT_A}/test-design?tc=tc-a`,
    ]);
    expect(page.getByRole('link', { name: '검토-A' }).elements()).toHaveLength(0);
    expect(page.getByRole('link', { name: '반영-A' }).elements()).toHaveLength(0);

    // 다른 프로젝트의 활동은 그 프로젝트로 연결한다.
    await userEvent.click(page.getByRole('button', { name: /10월 2일/ }));
    await expect.poll(() => titles(view)).toContain('이슈-B');
    expect(links(view)).toEqual([`이슈-B→/projects/${PROJECT_B}/issues?issue=issue-b`, `TC-B→/projects/${PROJECT_B}/test-design?tc=tc-b`]);

    await userEvent.click(page.getByRole('link', { name: 'TC-B' }));
    await expect.poll(() => router!.state.location.pathname + router!.state.location.search).toBe(`/projects/${PROJECT_B}/test-design?tc=tc-b`);
  });

  it('산출물 추가 · TC 가져오기 기록도 정확한 항목으로 연결한다(프로젝트 기록 · 검색과 같은 경로)', async () => {
    const view = await mount();
    await userEvent.click(page.getByRole('button', { name: /9월 30일/ }));
    await expect.poll(() => titles(view)).toContain('산출물-A');
    expect(links(view)).toContain(`산출물-A→/projects/${PROJECT_A}?deliverable=dlv-1`);
  });

  it('원본 ID가 없는 옛 기록 · 종류에 맞지 않는 key · 프로젝트 없는 활동은 오류 없이 평문이고, 프로젝트명은 그대로 보인다', async () => {
    const view = await mount();
    for (const title of ['결과-옛기록', 'TC-엉뚱한key', '개인-이슈형']) {
      expect(titles(view)).toContain(title);
      expect(page.getByRole('link', { name: title }).elements()).toHaveLength(0);
    }
    const projectName = (await holder.repos!.projects.get(PROJECT_A))!.name;
    const legacyEntry = [...view.querySelectorAll('ol li')].find((item) => item.textContent?.includes('결과-옛기록'))!;
    expect(legacyEntry.textContent).toContain(projectName);
    // 링크가 있는 활동도 프로젝트명이 한 번만 보인다.
    const linked = [...view.querySelectorAll('ol li')].find((item) => item.textContent?.includes('이슈-B'))!;
    const projectBName = (await holder.repos!.projects.get(PROJECT_B))!.name;
    expect(linked.textContent!.split(projectBName)).toHaveLength(2);
  });
});

describe('전역 기록: 390px', () => {
  it('종류 필터 · 날짜 목록 · 타임라인 · 정리가 가로로 넘치지 않는다', async () => {
    await page.viewport(390, 844);
    const view = await mount('?type=issues');
    expect(view.querySelectorAll('ol a').length).toBeGreaterThan(0);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    await userEvent.click(filterButton('전체'));
    await expect.poll(() => titles(view)).toHaveLength(5);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });
});
