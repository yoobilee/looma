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
import { importQaRound, legacyV1State, qaScenarioSeed } from '@/data/mock/issueScenario';
import { createSeed, PROJECT_A } from '@/data/mock/seed';
import type { Repositories } from '@/data/repositories/types';
import { issueStatusLabel } from '@/domain/labels';
import type { IssueStatus } from '@/domain/types';
import { IssuesTab } from './IssuesTab';

/*
 * 이슈 / 확인사항 화면을 실제 브라우저(Chromium) · 주소 · 저장소와 함께 띄워 확인한다.
 * - 빈 상태, 일반 확인사항 만들기, 필터(주소에 남음), 기본 정렬, 상세 · 상태 변경, 연결 TC · 차수 링크, 이후 수행 결과
 * - 새로고침(같은 저장소로 다시 열기) 뒤 유지, 390px 가로 넘침 · 대화상자 크기, 키보드 · 레이블
 */

const holder = vi.hoisted(() => ({ repos: undefined as Repositories | undefined }));
vi.mock('@/data', () => ({ repositories: new Proxy({}, { get: (_target, key) => holder.repos?.[key as keyof Repositories] }) }));

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let router: ReturnType<typeof createBrowserRouter> | undefined;
const originalUrl = `${location.pathname}${location.search}`;

type MemoryStore = ReturnType<typeof createMemoryStateStore>;

async function openRepos(store: MemoryStore, createInitialData?: () => AppData) {
  const repos = createLocalRepositories({ openStore: async () => store, ...(createInitialData && { createInitialData }) });
  await repos.persistence.load();
  return repos;
}

/** 이슈 화면을 주소(search)와 함께 띄운다. 같은 저장소로 다시 띄우면 새로고침과 같다. */
async function mount(search = '', { store = createMemoryStateStore(), createInitialData }: { store?: MemoryStore; createInitialData?: () => AppData } = {}) {
  const repos = await openRepos(store, createInitialData);
  holder.repos = repos;
  const project = (await repos.projects.get(PROJECT_A))!;
  history.replaceState(null, '', `${location.pathname}${search}`);
  router = createBrowserRouter([{ element: <Outlet context={{ project, openDeliverableCreate: () => {} }} />, children: [{ path: '*', element: <IssuesTab /> }] }]);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<RouterProvider router={router!} />));
  await expect.poll(() => container!.querySelector('[role="group"], [class*="state"]')).toBeTruthy();
  return { repos, store, view: container };
}

async function unmount() {
  await act(async () => root?.unmount());
  router?.dispose();
  container?.remove();
  root = undefined;
  container = undefined;
  router = undefined;
}

afterEach(async () => {
  await unmount();
  holder.repos = undefined;
  history.replaceState(null, '', originalUrl);
  delete document.documentElement.dataset.theme;
  await page.viewport(1280, 900);
});

const rows = (view: HTMLElement) => [...view.querySelectorAll('tbody tr')];
const cell = (row: Element, label: string) => row.querySelector(`td[data-label="${label}"]`)?.textContent ?? '';
const filterButton = (label: string) => page.getByRole('button', { name: new RegExp(`^${label} ?\\d+$`) });
const dialog = () => document.querySelector('dialog[open]') as HTMLDialogElement | null;
const stored = async (store: MemoryStore) => (store.inspect().state as StoredAppState & { data: AppData }).data;

describe('이슈 / 확인사항 화면', () => {
  it('0건이면 만드는 방법을 안내하고, 결과 없이 일반 확인사항을 만들면 목록에 나오며 새로고침 뒤에도 남는다', async () => {
    const store = createMemoryStateStore();
    const { view } = await mount('', { store, createInitialData: qaScenarioSeed });
    expect(view.textContent).toContain('아직 이슈 · 확인사항이 없어요.');

    await userEvent.click(page.getByRole('button', { name: '확인사항 추가' }));
    expect(dialog()?.getAttribute('aria-labelledby')).toBeTruthy();
    expect(dialog()!.textContent).toContain('수행 결과 없이 남기는 일반 항목');
    await userEvent.fill(page.getByLabelText('제목', { exact: true }), '푸시 알림 기본값 확인');
    await userEvent.fill(page.getByLabelText('메모', { exact: true }), '기획서에 없음');
    await userEvent.click(page.getByRole('button', { name: '확인사항 만들기' }));

    await expect.poll(() => rows(view).length).toBe(1);
    expect(cell(rows(view)[0], '유형')).toBe('확인사항');
    expect(cell(rows(view)[0], '상태')).toBe('확인 필요');
    expect(cell(rows(view)[0], '차수')).toBe('-');
    const [created] = (await stored(store)).issues;
    expect(created).toMatchObject({ type: 'question', status: 'open', title: '푸시 알림 기본값 확인', note: '기획서에 없음' });
    expect(created).not.toHaveProperty('resultId');

    await unmount();
    const { view: reloaded } = await mount('', { store });
    await expect.poll(() => rows(reloaded).map((row) => cell(row, '제목'))).toEqual(['푸시 알림 기본값 확인']);
  });

  it('기본 정렬은 확인 필요 → 보류 → 해결됨이고, 필터는 유형 · 상태 하나씩 고르며 주소에 남는다', async () => {
    const store = createMemoryStateStore();
    const seed = createSeed();
    seed.issues.find((issue) => issue.id === 'issue-q-terms')!.status = 'deferred';
    await openRepos(store, () => seed);
    const { view } = await mount('', { store });
    const order: Record<IssueStatus, number> = { open: 0, deferred: 1, resolved: 2 };
    const labelToStatus = new Map(Object.entries(issueStatusLabel).map(([status, label]) => [label, status as IssueStatus]));
    const statuses = rows(view).map((row) => order[labelToStatus.get(cell(row, '상태'))!]);
    expect(statuses).toEqual([...statuses].sort((a, b) => a - b));
    expect(new Set(statuses)).toEqual(new Set([0, 1, 2]));

    // 필터는 주소를 거쳐 반영되므로 반영을 기다린다.
    await userEvent.click(filterButton('이슈'));
    await expect.poll(() => location.search).toBe('?filter=defect');
    await expect.poll(() => new Set(rows(view).map((row) => cell(row, '유형')))).toEqual(new Set(['이슈']));
    await userEvent.click(filterButton('보류'));
    await expect.poll(() => rows(view).map((row) => row.querySelector('td[data-label="제목"] a')?.textContent)).toEqual(['약관 재동의 조건']);
    await userEvent.click(filterButton('해결됨'));
    await expect.poll(() => location.search).toBe('?filter=resolved');
    await expect.poll(() => new Set(rows(view).map((row) => cell(row, '상태')))).toEqual(new Set(['해결됨']));

    // 새로고침해도 고른 필터가 남는다.
    await unmount();
    const { view: reloaded } = await mount('?filter=resolved', { store });
    expect(page.getByRole('button', { name: /^해결됨/ }).element().getAttribute('aria-pressed')).toBe('true');
    expect(rows(reloaded).every((row) => cell(row, '상태') === '해결됨')).toBe(true);
  });

  it('목록은 연결된 결과에서 TC · 차수 · 플랫폼 · 결과 상태를 보여 주고, 상세에서 TC · 차수로 이동하는 링크를 준다', async () => {
    const { view } = await mount();
    const row = rows(view).find((item) => cell(item, '제목').startsWith('iOS 비밀번호 오류 문구'))!;
    expect(cell(row, 'TC')).toContain('SIGN-002');
    expect(cell(row, '차수')).toBe('2차');
    expect(cell(row, '플랫폼')).toBe('iOS');
    expect(cell(row, '연결된 결과')).toBe('FAIL');

    await userEvent.click(page.getByRole('link', { name: 'iOS 비밀번호 오류 문구가 기획과 다름' }));
    await expect.poll(() => location.search).toBe('?issue=issue-bug-014');
    await expect.poll(() => dialog()).toBeTruthy();
    const links = [...dialog()!.querySelectorAll('a')].map((link) => link.getAttribute('href'));
    expect(links).toEqual(expect.arrayContaining([`/projects/${PROJECT_A}/test-design?tc=tc-002`, `/projects/${PROJECT_A}/results?import=imp-a-2`]));
    expect(dialog()!.textContent).toContain('이후 수행 결과');
    expect(dialog()!.textContent).toContain('이 차수 뒤에 같은 TC · 플랫폼 결과가 아직 없어요.');
  });

  it('상세에서 상태를 해결됨으로 바꾸면 목록 아래로 가고 resolvedAt이 남으며, 수행 결과 · TC는 바뀌지 않는다', async () => {
    const store = createMemoryStateStore();
    const { view } = await mount('?issue=issue-bug-014', { store });
    await expect.poll(() => dialog()).toBeTruthy();
    const before = await stored(store);
    const save = page.getByRole('button', { name: '저장', exact: true });
    expect(save.element().hasAttribute('disabled')).toBe(true);

    await userEvent.click(page.getByRole('radio', { name: '해결됨' }).element().closest('label')!);
    await userEvent.fill(page.getByLabelText('Actual', { exact: true }), 'iOS 17에서 문구 상이');
    await userEvent.click(save);

    await expect.poll(() => dialog()).toBeNull();
    await expect.poll(() => location.search).toBe('');
    const after = await stored(store);
    expect(after.issues.find((issue) => issue.id === 'issue-bug-014')).toMatchObject({ status: 'resolved', resolvedAt: expect.any(String), actual: 'iOS 17에서 문구 상이' });
    expect(after.results).toEqual(before.results);
    expect(after.testCases).toEqual(before.testCases);
    await expect.poll(() => cell(rows(view).at(-1)!, '상태')).toBe('해결됨');
    const resolvedTitles = rows(view).filter((row) => cell(row, '상태') === '해결됨').map((row) => cell(row, '제목'));
    expect(resolvedTitles[0]).toContain('iOS 비밀번호 오류 문구');
  });

  it('3차 PASS가 생겨도 이슈는 확인 필요로 남고, 상세의 이후 수행 결과에 3차 PASS가 보인다', async () => {
    const store = createMemoryStateStore();
    const repos = await openRepos(store, qaScenarioSeed);
    await importQaRound(repos, 1, 'P');
    const second = await importQaRound(repos, 2, 'F');
    const issue = await repos.issues.create({ projectId: PROJECT_A, type: 'defect', title: 'Android 로그인 실패', resultId: second.result.id });
    await importQaRound(repos, 3, 'P');

    const { view } = await mount(`?issue=${issue.id}`, { store });
    await expect.poll(() => dialog()).toBeTruthy();
    expect(cell(rows(view)[0], '상태')).toBe('확인 필요');
    const timeline = [...dialog()!.querySelectorAll('ol li')].map((item) => item.textContent);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toContain('3차');
    expect(timeline[0]).toContain('PASS');
    expect(dialog()!.textContent).toContain('자동으로 바꾸지 않아요');
  });

  it('대화상자의 모든 입력에 레이블이 있고, 상태는 화살표 키로 고르며, Esc로 닫으면 주소에서도 빠진다', async () => {
    await mount('?issue=issue-q-login-limit');
    await expect.poll(() => dialog()).toBeTruthy();
    for (const element of dialog()!.querySelectorAll('input, textarea, select')) {
      const id = element.getAttribute('id');
      const labelled = (id && dialog()!.querySelector(`label[for="${id}"]`)) || element.closest('label');
      expect(labelled, element.outerHTML).toBeTruthy();
    }
    const open = page.getByRole('radio', { name: '확인 필요' }).element() as HTMLInputElement;
    open.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect((page.getByRole('radio', { name: '해결됨' }).element() as HTMLInputElement).checked).toBe(true);
    expect(page.getByRole('button', { name: '저장', exact: true }).element().hasAttribute('disabled')).toBe(false);

    await userEvent.keyboard('{Escape}');
    await expect.poll(() => dialog()).toBeNull();
    await expect.poll(() => location.search).toBe('');
  });

  it('390px에서 목록은 카드로 쌓이고 가로로 넘치지 않으며, 긴 제목 · TC ID · 재현 방법도 대화상자 안에서 줄바꿈된다', async () => {
    await page.viewport(390, 844);
    const store = createMemoryStateStore();
    const seed = createSeed();
    const longId = `CLIENT-A-${'0'.repeat(39)}`;
    seed.testCases.find((item) => item.id === 'tc-002')!.externalId = longId;
    const target = seed.issues.find((issue) => issue.id === 'issue-bug-014')!;
    target.title = '아주 긴 이슈 제목이라 좁은 화면에서 줄바꿈되어야 하는 항목입니다 '.repeat(3);
    target.reproduction = `${'1.앱을열고로그인화면으로이동한다'.repeat(8)}\n2. 확인`;
    await openRepos(store, () => seed);
    const { view } = await mount('', { store });

    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    expect(getComputedStyle(rows(view)[0]).display).toBe('block');
    for (const td of view.querySelectorAll('tbody td')) expect(td.getBoundingClientRect().right).toBeLessThanOrEqual(390.5);
    expect(view.textContent).toContain(longId);

    await userEvent.click(page.getByRole('link', { name: target.title.trim() }));
    await expect.poll(() => dialog()).toBeTruthy();
    const box = dialog()!.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(390.5);
    const panel = dialog()!.firstElementChild as HTMLElement;
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
    for (const element of dialog()!.querySelectorAll('dd, textarea, input')) expect(element.getBoundingClientRect().right).toBeLessThanOrEqual(box.right + 0.5);
  });

  it('다크 테마에서도 상태 · 제목이 배경과 구분되는 색으로 보인다', async () => {
    document.documentElement.dataset.theme = 'dark';
    const { view } = await mount();
    const link = view.querySelector('tbody a') as HTMLElement;
    expect(getComputedStyle(link).color).toBe('rgb(238, 240, 245)');
    const tag = view.querySelector('td[data-label="상태"] span') as HTMLElement;
    expect(getComputedStyle(tag).color).not.toBe(getComputedStyle(document.body).backgroundColor);
  });
});

describe('이슈 / 확인사항 화면 · 기존 기능 · 근거 표시', () => {
  const detailFacts = () => Object.fromEntries([...dialog()!.querySelectorAll('dl > div')].map((item) => [item.querySelector('dt')!.textContent, item.querySelector('dd')!.textContent]));

  it('v1에서 옮긴 BUG-014의 기능 · 근거(sourceRef)를 목록과 상세에서 읽기 전용으로 보여 준다', async () => {
    // 저장소에 v1 데이터를 두고 열면 v2로 변환된다.
    const store = createMemoryStateStore(legacyV1State());
    const { view } = await mount('', { store });
    expect((store.inspect().state as StoredAppState).schemaVersion).toBe(2);
    const row = rows(view).find((item) => cell(item, '제목').startsWith('iOS 비밀번호 오류 문구'))!;
    expect(cell(row, '제목')).toContain('기능 회원가입 · 근거 PDF p.14');

    await userEvent.click(page.getByRole('link', { name: 'iOS 비밀번호 오류 문구가 기획과 다름' }));
    await expect.poll(() => dialog()).toBeTruthy();
    expect(detailFacts()).toMatchObject({ 기능: '회원가입', 근거: '모바일_개편_기획_v1.4.pdf · p.14', 차수: '2차 수행 결과', 플랫폼: 'iOS' });
    // 편집할 수 있는 입력으로 바뀌지 않는다.
    expect(dialog()!.querySelector('input[value="회원가입"], input[value="p.14"]')).toBeNull();
  });

  it('일반 확인사항을 만들 때 고른 기능이 목록 · 상세에 보인다', async () => {
    const store = createMemoryStateStore();
    const { view } = await mount('', { store, createInitialData: qaScenarioSeed });
    await userEvent.click(page.getByRole('button', { name: '확인사항 추가' }));
    await userEvent.fill(page.getByLabelText('제목', { exact: true }), '로그인 정책 확인');
    await userEvent.selectOptions(page.getByLabelText('기능', { exact: true }).element() as HTMLSelectElement, '로그인');
    await userEvent.click(page.getByRole('button', { name: '확인사항 만들기' }));
    await expect.poll(() => rows(view).length).toBe(1);
    expect(cell(rows(view)[0], '제목')).toContain('기능 로그인');

    await userEvent.click(page.getByRole('link', { name: '로그인 정책 확인' }));
    await expect.poll(() => dialog()).toBeTruthy();
    expect(detailFacts()).toMatchObject({ 기능: '로그인' });
    expect(detailFacts()).not.toHaveProperty('근거');
  });

  it('기능 · 근거가 없는 항목은 그 칸 없이 열리고, 산출물을 찾을 수 없는 근거는 위치만 보여 준다', async () => {
    const store = createMemoryStateStore();
    const seed = createSeed();
    const orphanSource = seed.issues.find((issue) => issue.id === 'issue-q-lock-policy')!;
    orphanSource.sourceRef = { deliverableId: 'dlv-deleted', locator: 'p.99' };
    await openRepos(store, () => seed);
    // 푸시 알림 기본값: 기능만 있고 근거는 없다.
    await mount('?issue=issue-q-push', { store });
    await expect.poll(() => dialog()).toBeTruthy();
    expect(detailFacts()).toMatchObject({ 기능: '마이페이지' });
    expect(detailFacts()).not.toHaveProperty('근거');
    await unmount();

    const { view } = await mount('?issue=issue-q-lock-policy', { store });
    await expect.poll(() => dialog()).toBeTruthy();
    expect(detailFacts()).toMatchObject({ 근거: '찾을 수 없는 산출물 · p.99' });
    expect(cell(rows(view).find((row) => cell(row, '제목').startsWith('계정 잠금 정책'))!, '제목')).toContain('근거 산출물 p.99');
  });

  it('기능 · 근거가 모두 없는 항목도 목록 · 상세가 깨지지 않는다', async () => {
    const store = createMemoryStateStore();
    const repos = await openRepos(store, qaScenarioSeed);
    const bare = await repos.issues.create({ projectId: PROJECT_A, type: 'defect', title: '연결 없는 이슈' });
    const { view } = await mount(`?issue=${bare.id}`, { store });
    await expect.poll(() => dialog()).toBeTruthy();
    expect(Object.keys(detailFacts())).toEqual(['TC', '차수', '플랫폼', '연결된 결과']);
    expect(rows(view)[0].querySelector('td[data-label="제목"] span')).toBeNull();
  });

  it('390px에서 긴 기능 · 근거도 목록 카드 · 상세 대화상자 안에서 줄바꿈된다', async () => {
    await page.viewport(390, 844);
    const store = createMemoryStateStore();
    const seed = createSeed();
    const target = seed.issues.find((issue) => issue.id === 'issue-bug-014')!;
    target.feature = '회원가입-비밀번호-정책-길이-검증-'.repeat(4);
    target.sourceRef = { deliverableId: 'dlv-plan-pdf', locator: `p.14-${'섹션'.repeat(30)}` };
    await openRepos(store, () => seed);
    const { view } = await mount('?issue=issue-bug-014', { store });
    await expect.poll(() => dialog()).toBeTruthy();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    for (const td of view.querySelectorAll('tbody td')) expect(td.getBoundingClientRect().right).toBeLessThanOrEqual(390.5);
    const box = dialog()!.getBoundingClientRect();
    expect(box.right).toBeLessThanOrEqual(390.5);
    for (const dd of dialog()!.querySelectorAll('dd')) expect(dd.getBoundingClientRect().right).toBeLessThanOrEqual(box.right + 0.5);
  });
});
