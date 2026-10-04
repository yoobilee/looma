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
import { DeliverablesTab } from '../deliverables/DeliverablesTab';
import { ImportHistoryTab } from '../import-history/ImportHistoryTab';
import { TestDesignTab } from '../test-design/TestDesignTab';
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
async function mount(activities: Activity[], search = '', change: (data: AppData) => void = () => {}) {
  await unmount();
  const repos = createLocalRepositories({
    openStore: async () => createMemoryStateStore(),
    createInitialData: (): AppData => {
      const data = { ...createSeed(), activities };
      change(data);
      return data;
    },
  });
  await repos.persistence.load();
  holder.repos = repos;
  const project = (await repos.projects.get(PROJECT_A))!;
  history.replaceState(null, '', `${location.pathname}${search}`);
  router = createBrowserRouter([{ element: <Outlet context={{ project, openDeliverableCreate: () => {} }} />, children: [
        { path: `/projects/${PROJECT_A}`, element: <DeliverablesTab /> },
        { path: `/projects/${PROJECT_A}/import-history`, element: <ImportHistoryTab /> },
        { path: `/projects/${PROJECT_A}/test-design`, element: <TestDesignTab /> },
        { path: '*', element: <ProjectRecordsTab /> },
      ] }]);
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
    await expect.poll(() => titles(view)).toEqual(['이슈-옛기록', '이슈-링크']);
    await expect.poll(() => filterButton('이슈·확인사항').element().getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(filterButton('수행 결과'));
    await expect.poll(() => titles(view)).toEqual(['결과']);
    await act(async () => router!.navigate(-1));
    await expect.poll(() => titles(view)).toEqual(['이슈-옛기록', '이슈-링크']);
    await expect.poll(() => filterButton('이슈·확인사항').element().getAttribute('aria-pressed')).toBe('true');
    await act(async () => router!.navigate(1));
    await expect.poll(() => titles(view)).toEqual(['결과']);
    await userEvent.click(filterButton('전체'));
    await expect.poll(() => location.search).toBe('');
  });

  it('잘못된 type은 전체로 보여준다', async () => {
    const view = await mount(base, '?type=bogus');
    await expect.poll(() => titles(view)).toHaveLength(5);
    await expect.poll(() => filterButton('전체').element().getAttribute('aria-pressed')).toBe('true');
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

  // 원본 ID가 남은 기록. 변경 분석만 항목을 여는 주소가 없어 탭까지만 간다.
  const linked = [
    activity('결과-링크', '2026-10-02T09:00:00.000Z', { type: 'results_uploaded', metadata: { detail: 'PASS 3', resultImportId: 'imp-a-2' } }),
    activity('TC-링크', '2026-10-02T10:00:00.000Z', { type: 'test_case_changed', metadata: { detail: '검토 완료', testCaseId: 'tc-002' } }),
    activity('TC자산-링크', '2026-10-02T11:00:00.000Z', { type: 'test_assets_imported', metadata: { detail: 'a.csv', testAssetImportId: 'tai-1' } }),
    activity('산출물-링크', '2026-10-02T12:00:00.000Z', { metadata: { detail: 'PDF', deliverableId: 'dlv-1' } }),
    activity('반영-링크', '2026-10-02T13:00:00.000Z', { type: 'changes_applied', metadata: { detail: '요구사항 1 · TC 2', analysisId: 'cia-plan-v15' } }),
    activity('결과-옛기록', '2026-10-02T14:00:00.000Z', { type: 'results_uploaded', metadata: { detail: 'PASS 3' } }),
    activity('TC-엉뚱한key', '2026-10-02T15:00:00.000Z', { type: 'test_case_changed', metadata: { detail: '검토 완료', issueId: 'issue-bug-014' } }),
  ];

  it.each([
    ['결과-링크', `/projects/${PROJECT_A}/results?import=imp-a-2`],
    ['TC-링크', `/projects/${PROJECT_A}/test-design?tc=tc-002`],
    ['TC자산-링크', `/projects/${PROJECT_A}/import-history?assetImport=tai-1`],
    ['산출물-링크', `/projects/${PROJECT_A}?deliverable=dlv-1`],
    ['이슈-링크', `/projects/${PROJECT_A}/issues?issue=issue-bug-014`],
  ])('%s를 누르면 %s로 이동한다', async (title, path) => {
    await mount([...base, ...linked]);
    await userEvent.click(page.getByRole('link', { name: title }));
    await expect.poll(() => router!.state.location.pathname + router!.state.location.search).toBe(path);
  });

  it('원본 ID가 없는 옛 기록 · 종류에 맞지 않는 key만 있는 기록은 텍스트로 남고, 필터 · 최신순은 그대로다', async () => {
    const view = await mount([...base, ...linked]);
    const linkTitles = [...view.querySelectorAll('a')].map((link) => link.textContent);
    expect(linkTitles).toEqual(['테스트 설계 보기', '산출물-링크', 'TC자산-링크', 'TC-링크', '결과-링크', '이슈-링크']);
    for (const title of ['결과-옛기록', 'TC-엉뚱한key', '이슈-옛기록', '산출물-늦은']) expect(titles(view)).toContain(title);
    await userEvent.click(filterButton('TC'));
    await expect.poll(() => titles(view)).toEqual(['TC-엉뚱한key', 'TC자산-링크', 'TC-링크']);
    expect([...view.querySelectorAll('a')].map((link) => link.textContent)).toEqual(['TC자산-링크', 'TC-링크']);
  });

  it('변경사항 반영 기록은 제목이 평문이고, 현재 테스트 설계로 가는 별도 링크는 이후 분석이 생기면 최신 분석을 연다', async () => {
    const past = activity('v1.5 변경사항 반영', '2026-10-02T09:00:00.000Z', { type: 'changes_applied', metadata: { detail: '요구사항 1 · TC 2', analysisId: 'cia-plan-v15' } });
    const view = await mount([past], '', (data) => {
      // 과거 분석 A(v1.5)는 반영을 마쳤고, 이후 더 최신 분석 B(v99)가 생겼다.
      const analysisA = data.changeAnalyses.find((item) => item.id === 'cia-plan-v15')!;
      analysisA.status = 'applied';
      // 시드 분석의 createdAt은 실행 시각 기준 상대값이라, 정렬이 날짜에 따라 뒤집히지 않도록 두 분석의 시각을 고정한다.
      analysisA.createdAt = '2026-10-02T09:00:00.000Z';
      data.deliverables.push({ id: 'dlv-v99', projectId: PROJECT_A, type: 'pdf', title: '모바일_개편_기획_v99.pdf', importedAt: '2026-10-03T00:00:00.000Z' });
      data.changeAnalyses.push({ ...structuredClone(analysisA), id: 'cia-plan-v99', targetDeliverableId: 'dlv-v99', baselineDeliverableId: undefined, status: 'draft', createdAt: '2026-10-03T00:00:00.000Z' });
    });
    // 제목은 링크가 아니고, 이동 문구는 대상이 현재 테스트 설계 화면임을 알린다.
    expect(page.getByRole('link', { name: 'v1.5 변경사항 반영' }).elements()).toHaveLength(0);
    expect(titles(view)).toEqual(['v1.5 변경사항 반영']);
    const action = page.getByRole('link', { name: '테스트 설계 보기' });
    expect(action.element().getAttribute('href')).toBe(`/projects/${PROJECT_A}/test-design`);
    await userEvent.click(action);
    await expect.poll(() => router!.state.location.pathname + router!.state.location.search).toBe(`/projects/${PROJECT_A}/test-design`);
    await expect.poll(() => view.textContent).toContain('모바일_개편_기획_v99.pdf');
  });

  it('테스트 설계에서 검토 완료 · 반영하면 기록에 별개의 두 활동이 남고, 검토 완료는 산출물·변경에 제목 평문 + "테스트 설계 보기"로 보인다', async () => {
    const reviewTitle = '모바일_개편_기획_v1.5.pdf 변경 분석 검토 완료';
    const applyTitle = '모바일_개편_기획_v1.5.pdf 변경사항 반영';
    const view = await mount([]);
    const repos = holder.repos!;
    // 판단은 저장소로 채우고, 검토 완료 · 반영은 화면 버튼으로 한다.
    for (const id of ['rc-001', 'rc-002', 'rc-003']) await repos.changeAnalyses.updateRequirementDecision('cia-plan-v15', id, 'accepted');
    for (const id of ['ti-001', 'ti-002', 'ti-003', 'ti-004', 'ti-006']) await repos.changeAnalyses.updateTestImpactDecision('cia-plan-v15', id, 'accepted');
    await repos.changeAnalyses.resolveDuplicate('cia-plan-v15', 'ti-007', 'modify_existing');

    await act(async () => router!.navigate(`/projects/${PROJECT_A}/test-design`));
    await userEvent.click(page.getByRole('button', { name: '검토 완료' }));
    await expect.poll(() => page.getByRole('button', { name: '변경사항 반영' }).elements().length).toBe(1);

    await act(async () => router!.navigate(`/projects/${PROJECT_A}/records?type=deliverables`));
    await expect.poll(() => titles(view)).toEqual([reviewTitle]);
    expect(view.textContent).toContain('요구사항 변경 3건 · TC 영향 6건');
    expect(page.getByRole('link', { name: reviewTitle }).elements()).toHaveLength(0);
    const action = page.getByRole('link', { name: '테스트 설계 보기' });
    expect(action.element().getAttribute('href')).toBe(`/projects/${PROJECT_A}/test-design`);
    await userEvent.click(action);
    await expect.poll(() => router!.state.location.pathname).toBe(`/projects/${PROJECT_A}/test-design`);

    await userEvent.click(page.getByRole('button', { name: '변경사항 반영' }));
    await userEvent.click(page.getByRole('button', { name: '반영', exact: true }));
    await expect.poll(() => view.textContent).toContain('반영 완료');

    await act(async () => router!.navigate(`/projects/${PROJECT_A}/records?type=deliverables`));
    await expect.poll(() => titles(view)).toEqual([applyTitle, reviewTitle]);
    expect(page.getByRole('link', { name: '테스트 설계 보기' }).elements()).toHaveLength(2);
  });

  it('산출물 추가 기록의 제목을 누르면 산출물 탭에서 그 산출물이 선택된다', async () => {
    const view = await mount([activity('v1.5 산출물 추가', '2026-10-02T09:00:00.000Z', { metadata: { detail: 'PDF', deliverableId: 'dlv-plan-pdf-v15' } })]);
    await userEvent.click(page.getByRole('link', { name: 'v1.5 산출물 추가' }));
    await expect.poll(() => router!.state.location.pathname + router!.state.location.search).toBe(`/projects/${PROJECT_A}?deliverable=dlv-plan-pdf-v15`);
    await expect.poll(() => view.querySelector('[aria-current="true"]')?.textContent).toContain('모바일_개편_기획_v1.5.pdf');
    expect(view.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
  });

  it('TC 가져오기 기록의 제목을 누르면 가져오기 이력에서 그 가져오기가 선택된다', async () => {
    const view = await mount([activity('TC 자산 11건 가져오기', '2026-10-02T09:00:00.000Z', { type: 'test_assets_imported', metadata: { detail: 'b.csv', testAssetImportId: 'tai-2' } })], '', (data) => {
      const session = { projectId: PROJECT_A, importedAt: '2026-10-02T09:00:00.000Z', totalRows: 12, created: 11, updated: 1, unchanged: 0, excluded: 0 };
      data.testAssetImports.push({ ...session, id: 'tai-1', fileName: 'a.csv' }, { ...session, id: 'tai-2', fileName: 'b.csv' });
    });
    await userEvent.click(page.getByRole('link', { name: 'TC 자산 11건 가져오기' }));
    await expect.poll(() => router!.state.location.pathname + router!.state.location.search).toBe(`/projects/${PROJECT_A}/import-history?assetImport=tai-2`);
    await expect.poll(() => view.querySelector('[aria-current="true"] [class*="fileName"]')?.textContent).toBe('b.csv');
    expect(view.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
  });

  it('390px에서 가로로 넘치지 않는다(긴 링크 제목 포함)', async () => {
    await page.viewport(390, 844);
    const longLinked = activity('아주긴링크제목'.repeat(20), '2026-10-01T14:00:00.000Z', { type: 'results_uploaded', metadata: { resultImportId: 'imp-a-2' } });
    const view = await mount([...base, ...linked, longLinked, activity('아주 긴 제목 '.repeat(12), '2026-10-01T13:00:00.000Z')]);
    expect(view.querySelectorAll('a').length).toBeGreaterThan(0);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });
});
