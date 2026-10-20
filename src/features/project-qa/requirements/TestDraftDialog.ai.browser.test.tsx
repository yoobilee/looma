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
import { createSeed, PROJECT_A } from '@/data/mock/seed';
import type { Repositories } from '@/data/repositories/types';
import { AI_ACCESS_CODE_STORAGE_KEY, AI_PROVIDER_STORAGE_KEY } from '@/features/ai/aiSettings';
import { AI_ACCESS_CODE_HEADER, AI_TEST_DRAFT_ENDPOINT, type AiDraftItem } from '@/shared/aiTestDraftContract';
import { RequirementsTab } from './RequirementsTab';

/*
 * 요구사항 기반 TC 초안 대화상자의 AI 흐름을 실제 브라우저(Chromium)에서 확인한다. 외부 AI는 부르지 않고 서버 함수(fetch)만 대신한다.
 * 자동 호출 없음 · 접근 코드 · 중복 클릭 · 오류(사용량 제한 · 인증) · AI 초안 검토 → 명시적 적용 · 요구사항 변경 뒤 폐기 · 390px.
 */

const holder = vi.hoisted(() => ({ repos: undefined as Repositories | undefined }));
vi.mock('@/data', () => ({ repositories: new Proxy({}, { get: (_target, key) => holder.repos?.[key as keyof Repositories] }) }));

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let router: ReturnType<typeof createBrowserRouter> | undefined;
let memoryStore: ReturnType<typeof createMemoryStateStore> | undefined;
const originalUrl = `${location.pathname}${location.search}`;
const requirementsPath = `/projects/${PROJECT_A}/requirements`;
const ACCESS_CODE = 'browser-test-access-code-0123456789';

const REQ_001 = '이메일, 비밀번호, 약관 동의를 입력하면 가입할 수 있다.';
const REQ_004 = '약관 재동의 조건이 모호함 — 개정 시점 기준인지 앱 업데이트 기준인지 명시 필요';

async function unmount() {
  await act(async () => root?.unmount());
  router?.dispose();
  container?.remove();
  root = container = router = undefined;
}

async function mount() {
  await unmount();
  memoryStore = createMemoryStateStore();
  const repos = createLocalRepositories({ openStore: async () => memoryStore!, createInitialData: (): AppData => createSeed() });
  await repos.persistence.load();
  holder.repos = repos;
  const project = (await repos.projects.get(PROJECT_A))!;
  history.replaceState(null, '', requirementsPath);
  router = createBrowserRouter([
    {
      element: <Outlet context={{ project, openDeliverableCreate: () => {} }} />,
      children: [
        { path: requirementsPath, element: <RequirementsTab /> },
        { path: '/settings', element: <p>설정 화면</p> },
      ],
    },
  ]);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<RouterProvider router={router!} />));
  await expect.poll(() => container!.textContent).toContain('요구사항');
  return { view: container, repos };
}

async function changeStored(repos: Repositories, change: (data: AppData) => void) {
  const current = structuredClone(memoryStore!.inspect().state as StoredAppState & { data: AppData });
  change(current.data);
  await memoryStore!.commit({ expectedRevision: current.revision, schemaVersion: current.schemaVersion, savedAt: current.savedAt, data: current.data });
  await repos.persistence.reloadLatest();
}

afterEach(async () => {
  await unmount();
  holder.repos = undefined;
  memoryStore = undefined;
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.removeItem(AI_PROVIDER_STORAGE_KEY);
  history.replaceState(null, '', originalUrl);
  await page.viewport(1280, 900);
});

const dialog = () => document.querySelector('dialog[open]') as HTMLDialogElement | null;
const button = (name: string | RegExp, exact = false) => page.getByRole('button', { name, exact });
const startButton = () => button('선택 요구사항으로 TC 초안 만들기');
const makeButton = () => button('TC 초안 만들기', true);
const aiButton = () => button(/^AI로 (TC 초안 생성|다시 만들기)$/);
const isDisabled = (locator: ReturnType<typeof button>) => (locator.element() as HTMLButtonElement).disabled;
const targetBox = (text: string) => page.getByRole('checkbox', { name: new RegExp(`TC 초안 대상: ${text.slice(0, 12)}`) });
const chip = (view: HTMLElement, label: string) => [...view.querySelectorAll<HTMLLabelElement>('fieldset label')].find((item) => item.textContent === label)!;
const previewRows = () => [...(dialog()?.querySelectorAll('tbody tr') ?? [])];

async function openFeature(view: HTMLElement, feature: string) {
  const summary = [...view.querySelectorAll('summary')].find((item) => item.textContent?.includes(feature))!;
  if (!summary.closest('details')!.open) await userEvent.click(summary);
}

/** 모든 선택을 풀고 주어진 요구사항 · 관점만 남긴다. */
async function choose(view: HTMLElement, texts: string[], perspectives = ['정상 흐름']) {
  await userEvent.click(button('모두 해제'));
  await openFeature(view, '회원가입');
  for (const text of texts) await userEvent.click(targetBox(text));
  for (const label of ['정상 흐름', '예외', '경계값', '권한', '상태 변화', '데이터 조회/저장']) {
    if (chip(view, label).querySelector('input')!.checked !== perspectives.includes(label)) await userEvent.click(chip(view, label));
  }
}

const aiItem = (requirementId: string, overrides: Partial<AiDraftItem> = {}): AiDraftItem => ({
  requirementId,
  perspective: 'normal_flow',
  conditionTitle: 'AI 테스트 조건',
  title: 'AI가 만든 TC 제목',
  precondition: null,
  steps: ['AI 절차 1', 'AI 절차 2'],
  expectedResult: 'AI 기대 결과',
  ...overrides,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const aiOk = (...drafts: AiDraftItem[]) => json({ drafts, rejected: 0, model: 'openai/gpt-oss-120b' });

function stubFetch(reply: () => Promise<Response>) {
  const fetchMock = vi.fn<typeof fetch>(() => reply());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const withAccessCode = () => sessionStorage.setItem(AI_ACCESS_CODE_STORAGE_KEY, ACCESS_CODE);

describe('AI TC 초안: 호출 조건', () => {
  it('대화상자를 열어도 AI는 자동으로 호출되지 않는다 (버튼을 눌러야만 호출)', async () => {
    withAccessCode();
    const fetchMock = stubFetch(() => Promise.resolve(aiOk(aiItem('req-001'))));
    const { view } = await mount();
    await choose(view, [REQ_001]);
    await userEvent.click(startButton());
    await expect.poll(() => dialog()).not.toBeNull();
    await expect.poll(() => previewRows().length).toBeGreaterThan(0);
    // 규칙 기반 미리보기가 기본이다.
    expect(dialog()!.textContent).toContain('AI가 만든 초안이 아니에요');
    expect(dialog()!.textContent).toContain('현재 AI · Groq · GPT-OSS 120B (무료)');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('보낼 내용의 범위와 보낼 요구사항 목록을 호출 전에 보여 준다', async () => {
    withAccessCode();
    stubFetch(() => Promise.resolve(aiOk()));
    const { view } = await mount();
    await choose(view, [REQ_001]);
    await userEvent.click(startButton());
    await expect.poll(() => dialog()?.textContent).toContain('외부 AI(Groq)로 보내요');
    const text = dialog()!.textContent!;
    expect(text).toContain('선택한 요구사항 1건의 ID · 기능 · 문장 · 확인 필요 여부와 테스트 관점 1개만');
    expect(text).toContain('산출물 파일 · 근거 위치 · 기존 TC · 다른 프로젝트 데이터는 보내지 않아요');
    const panel = dialog()!.querySelector('section[aria-label="AI 초안"]')!;
    expect(panel.textContent).toContain('보낼 요구사항');
    expect(panel.querySelectorAll('li')).toHaveLength(1);
    expect(panel.querySelector('li')!.textContent).toBe(`회원가입 · ${REQ_001}`);
    expect(panel.querySelector('details')).toBeNull();
  });

  it('기본 선택(보이는 요구사항 전체)은 한도를 넘어 AI 버튼이 막히고, 규칙 기반 초안은 그대로 만들 수 있다', async () => {
    withAccessCode();
    const fetchMock = stubFetch(() => Promise.resolve(aiOk()));
    await mount();
    await userEvent.click(startButton());
    await expect.poll(() => dialog()).not.toBeNull();
    await expect.poll(() => isDisabled(aiButton())).toBe(true);
    expect(dialog()!.textContent).toContain('AI 초안은 한 번에 요구사항 5개 · 관점 3개까지 만들 수 있어요');
    expect(isDisabled(makeButton())).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('접근 코드가 없으면 AI 버튼이 막히고 설정으로 안내하며 서버를 부르지 않는다', async () => {
    const fetchMock = stubFetch(() => Promise.resolve(aiOk()));
    const { view } = await mount();
    await choose(view, [REQ_001]);
    await userEvent.click(startButton());
    await expect.poll(() => isDisabled(aiButton())).toBe(true);
    expect(dialog()!.textContent).toContain('AI 접근 코드가 없어요.');
    expect(dialog()!.querySelector('a[href="/settings"]')).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isDisabled(makeButton())).toBe(false);
  });
});

describe('AI TC 초안: 생성 → 검토 → 명시적 적용', () => {
  it('버튼을 누르면 선택한 요구사항만 한 번 보내고, 받은 초안은 후보로만 보이며 적용하기 전에는 아무것도 저장하지 않는다', async () => {
    withAccessCode();
    const fetchMock = stubFetch(() => Promise.resolve(aiOk(aiItem('req-001'))));
    const { view, repos } = await mount();
    const before = await repos.testCases.listByProject(PROJECT_A);
    await choose(view, [REQ_001]);
    await userEvent.click(startButton());
    await expect.poll(() => isDisabled(aiButton())).toBe(false);
    await userEvent.click(aiButton());

    await expect.poll(() => dialog()?.textContent).toContain('AI가 만든 TC 제목');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(AI_TEST_DRAFT_ENDPOINT);
    expect((init.headers as Record<string, string>)[AI_ACCESS_CODE_HEADER]).toBe(ACCESS_CODE);
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({ provider: 'groq', perspectives: ['normal_flow'], requirements: [{ id: 'req-001', feature: '회원가입', text: REQ_001, needsConfirmation: false }] });
    // 선택하지 않은 요구사항 · 접근 코드는 본문에 없다.
    expect(init.body).not.toContain('req-002');
    expect(init.body).not.toContain(ACCESS_CODE);

    expect(dialog()!.textContent).toContain('Groq · GPT-OSS 120B이(가) 만든 AI 초안이에요');
    expect(dialog()!.textContent).not.toContain('AI가 만든 초안이 아니에요');
    expect(previewRows()).toHaveLength(1);
    expect(dialog()!.textContent).toContain('AI 기대 결과');
    // 검토 단계: 저장된 것이 없다.
    expect(await repos.testCases.listByProject(PROJECT_A)).toEqual(before);
    expect(isDisabled(makeButton())).toBe(false);
  });

  it('명시적으로 적용하면 AI 초안이 초안 상태 · ai_generated TC로 저장되고 기존 TC는 바뀌지 않는다', async () => {
    withAccessCode();
    stubFetch(() => Promise.resolve(aiOk(aiItem('req-001'))));
    const { view, repos } = await mount();
    const before = await repos.testCases.listByProject(PROJECT_A);
    await choose(view, [REQ_001]);
    await userEvent.click(startButton());
    await expect.poll(() => isDisabled(aiButton())).toBe(false);
    await userEvent.click(aiButton());
    await expect.poll(() => dialog()?.textContent).toContain('AI가 만든 TC 제목');
    await userEvent.click(makeButton());
    await expect.poll(() => dialog()?.textContent).toContain('TC 초안 1건을 만들고 기존 TC 0건에 연결했어요.');

    const after = await repos.testCases.listByProject(PROJECT_A);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)).toMatchObject({ title: 'AI가 만든 TC 제목', origin: 'ai_generated', generationType: 'ai_suggestion', status: 'draft', requirementIds: ['req-001'], revision: 1 });
    expect(after.at(-1)!.sourceRefs.length).toBeGreaterThan(0);
    expect((await repos.activities.list())[0].title).toBe('AI TC 초안 1건 생성');
  });

  it('AI 초안은 저장될 사전 조건 · 절차까지 미리보기에 모두 보여 줘서 적용 전에 검토할 수 있다 (규칙 기반 초안에는 절차 목록을 더하지 않는다)', async () => {
    withAccessCode();
    stubFetch(() => Promise.resolve(aiOk(aiItem('req-001', { precondition: '로그아웃된 상태여야 한다', steps: ['첫 번째 AI 절차', '두 번째 AI 절차', '세 번째 AI 절차'] }))));
    const { view, repos } = await mount();
    await choose(view, [REQ_001]);
    await userEvent.click(startButton());
    await expect.poll(() => dialog()?.querySelector('tbody ol')).toBeNull();
    await expect.poll(() => isDisabled(aiButton())).toBe(false);
    await userEvent.click(aiButton());
    await expect.poll(() => dialog()?.textContent).toContain('AI가 만든 TC 제목');

    const steps = dialog()!.querySelector('tbody ol[aria-label="절차: AI가 만든 TC 제목"]') as HTMLOListElement;
    expect([...steps.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['첫 번째 AI 절차', '두 번째 AI 절차', '세 번째 AI 절차']);
    expect(dialog()!.textContent).toContain('사전 조건 · 로그아웃된 상태여야 한다');
    // 보이는 내용이 그대로 저장된다.
    await userEvent.click(makeButton());
    await expect.poll(() => dialog()?.textContent).toContain('TC 초안 1건을 만들고');
    const saved = (await repos.testCases.listByProject(PROJECT_A)).at(-1)!;
    expect(saved.steps).toEqual(['첫 번째 AI 절차', '두 번째 AI 절차', '세 번째 AI 절차']);
    expect(saved.precondition).toBe('로그아웃된 상태여야 한다');
  });

  it('확인 필요 요구사항의 AI 초안은 확인 필요로 표시되고 기대 결과가 확정처럼 보이지 않는다', async () => {
    withAccessCode();
    stubFetch(() => Promise.resolve(aiOk(aiItem('req-004', { expectedResult: '재동의 화면이 표시된다.' }))));
    const { view } = await mount();
    await choose(view, [REQ_004]);
    await userEvent.click(startButton());
    await expect.poll(() => isDisabled(aiButton())).toBe(false);
    await userEvent.click(aiButton());
    await expect.poll(() => dialog()?.textContent).toContain('AI가 만든 TC 제목');
    expect(dialog()!.textContent).toContain('확인 필요 — 재동의 화면이 표시된다.');
    const counts = dialog()!.querySelector('dl[aria-label="초안 판정 요약"]')!.textContent!;
    expect(counts).toContain('확인 필요1');
  });

  it('규칙 기반 초안으로 돌아가면 AI 초안이 사라지고 규칙 기반 초안이 다시 보인다', async () => {
    withAccessCode();
    stubFetch(() => Promise.resolve(aiOk(aiItem('req-001'))));
    const { view } = await mount();
    await choose(view, [REQ_001]);
    await userEvent.click(startButton());
    await expect.poll(() => isDisabled(aiButton())).toBe(false);
    await userEvent.click(aiButton());
    await expect.poll(() => dialog()?.textContent).toContain('AI가 만든 TC 제목');
    await userEvent.click(button('규칙 기반 초안으로 돌아가기'));
    await expect.poll(() => dialog()?.textContent).toContain('AI가 만든 초안이 아니에요');
    expect(dialog()!.textContent).not.toContain('AI가 만든 TC 제목');
  });

  it('AI 초안을 받은 뒤 요구사항 문장이 바뀌면 그 초안은 쓸 수 없고, 규칙 기반으로 돌아가거나 다시 만들어야 한다', async () => {
    withAccessCode();
    const fetchMock = stubFetch(() => Promise.resolve(aiOk(aiItem('req-001'))));
    const { view, repos } = await mount();
    const before = await repos.testCases.listByProject(PROJECT_A);
    await choose(view, [REQ_001]);
    await userEvent.click(startButton());
    await expect.poll(() => isDisabled(aiButton())).toBe(false);
    await userEvent.click(aiButton());
    await expect.poll(() => dialog()?.textContent).toContain('AI가 만든 TC 제목');

    await changeStored(repos, (data) => {
      data.requirements.find((item) => item.id === 'req-001')!.text = '미리보기 뒤에 바뀐 요구사항 문장이다.';
    });
    await expect.poll(() => dialog()?.textContent).toContain('요구사항이 바뀌어 AI 초안이 맞지 않아요');
    expect(isDisabled(makeButton())).toBe(true);
    // 바뀐 요구사항을 자동으로 다시 보내지 않는다.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await repos.testCases.listByProject(PROJECT_A)).toEqual(before);

    await userEvent.click(button('규칙 기반 초안으로 돌아가기'));
    await expect.poll(() => isDisabled(makeButton())).toBe(false);
    expect(dialog()!.textContent).toContain('AI가 만든 초안이 아니에요');
  });
});

describe('AI TC 초안: 중복 클릭 · 오류', () => {
  it('호출 중에는 다시 누를 수 없고 서버는 한 번만 호출된다 (더블 클릭)', async () => {
    withAccessCode();
    let release: (response: Response) => void = () => undefined;
    const fetchMock = stubFetch(() => new Promise<Response>((resolve) => (release = resolve)));
    const { view } = await mount();
    await choose(view, [REQ_001]);
    await userEvent.click(startButton());
    await expect.poll(() => isDisabled(aiButton())).toBe(false);
    await userEvent.dblClick(aiButton());
    await expect.poll(() => dialog()?.textContent).toContain('AI가 초안을 만드는 중이에요');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isDisabled(button('AI가 만드는 중…'))).toBe(true);
    // 호출 중에는 규칙 기반 저장도 막는다.
    release(aiOk(aiItem('req-001')));
    await expect.poll(() => dialog()?.textContent).toContain('AI가 만든 TC 제목');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('무료 사용량 제한(429)은 안내만 하고 재시도 · 유료 전환을 하지 않으며 규칙 기반 초안은 그대로 쓸 수 있다', async () => {
    withAccessCode();
    const fetchMock = stubFetch(() => Promise.resolve(json({ error: { code: 'rate_limited', retryAfterSeconds: 20 } }, 429)));
    const { view } = await mount();
    await choose(view, [REQ_001]);
    await userEvent.click(startButton());
    await expect.poll(() => isDisabled(aiButton())).toBe(false);
    await userEvent.click(aiButton());
    await expect.poll(() => dialog()?.querySelector('[role="alert"]')?.textContent).toContain('20초 뒤에 다시 시도해 주세요');
    const alert = dialog()!.querySelector('[role="alert"]')!.textContent!;
    expect(alert).toContain('유료 AI로 자동 전환하지 않아요');
    expect(alert).toContain('규칙 기반 초안은 그대로 만들 수 있어요');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([AI_TEST_DRAFT_ENDPOINT]);
    // 다시 누를 수 있고(자동 재시도는 없다), 규칙 기반 초안으로 만들 수 있다.
    expect(isDisabled(aiButton())).toBe(false);
    expect(dialog()!.textContent).toContain('AI가 만든 초안이 아니에요');
    expect(isDisabled(makeButton())).toBe(false);
  });

  it('접근 코드가 틀리면 안내하되 코드를 화면에 드러내지 않는다', async () => {
    withAccessCode();
    stubFetch(() => Promise.resolve(json({ error: { code: 'unauthorized' } }, 401)));
    const { view } = await mount();
    await choose(view, [REQ_001]);
    await userEvent.click(startButton());
    await expect.poll(() => isDisabled(aiButton())).toBe(false);
    await userEvent.click(aiButton());
    await expect.poll(() => dialog()?.querySelector('[role="alert"]')?.textContent).toContain('접근 코드가 맞지 않아요');
    expect(document.body.textContent).not.toContain(ACCESS_CODE);
    expect(location.href).not.toContain(ACCESS_CODE);
  });

  it.each([
    ['서버 함수가 없는 환경(HTML 응답)', () => Promise.resolve(new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } })), 'AI 서버 함수를 쓸 수 없어요'],
    ['AI 응답 형식 오류', () => Promise.resolve(json({ error: { code: 'invalid_response' } }, 502)), 'AI 응답 형식이 맞지 않아 쓰지 않았어요'],
    ['시간 초과', () => Promise.resolve(json({ error: { code: 'timeout' } }, 504)), 'AI 응답이 늦어 중단했어요'],
    ['네트워크 오류', () => Promise.reject(new TypeError('Failed to fetch')), '네트워크 문제로 AI 서버에 연결하지 못했어요'],
  ])('%s → 안내하고 미리보기는 규칙 기반 그대로다', async (_name, reply, message) => {
    withAccessCode();
    const fetchMock = stubFetch(reply);
    const { view } = await mount();
    await choose(view, [REQ_001]);
    await userEvent.click(startButton());
    await expect.poll(() => isDisabled(aiButton())).toBe(false);
    await userEvent.click(aiButton());
    await expect.poll(() => dialog()?.querySelector('[role="alert"]')?.textContent).toContain(message);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dialog()!.textContent).toContain('AI가 만든 초안이 아니에요');
    expect(isDisabled(makeButton())).toBe(false);
  });

  it('서버가 요청하지 않은 요구사항의 초안을 섞어 보내면 그 초안은 버리고 알린다', async () => {
    withAccessCode();
    stubFetch(() => Promise.resolve(json({ drafts: [aiItem('req-001'), aiItem('req-999', { title: '몰래 끼워 넣은 TC' })], rejected: 0, model: 'openai/gpt-oss-120b' })));
    const { view } = await mount();
    // 요구사항 2개를 골라 응답 개수 한도 안에서 검증이 걸리게 한다.
    await choose(view, [REQ_001, REQ_004]);
    await userEvent.click(startButton());
    await expect.poll(() => isDisabled(aiButton())).toBe(false);
    await userEvent.click(aiButton());
    await expect.poll(() => dialog()?.textContent).toContain('AI가 만든 TC 제목');
    expect(dialog()!.textContent).not.toContain('몰래 끼워 넣은 TC');
    expect(dialog()!.textContent).toContain('AI 응답 중 1건은 요청하지 않은 요구사항이거나 형식이 맞지 않아 버렸어요');
  });
});

describe('AI TC 초안: 390px', () => {
  it('AI 패널 · AI 초안 미리보기가 가로로 넘치지 않는다', async () => {
    await page.viewport(390, 844);
    withAccessCode();
    stubFetch(() => Promise.resolve(aiOk(aiItem('req-001', { title: '아주 긴 AI TC 제목 '.repeat(8), expectedResult: '아주 긴 기대 결과 '.repeat(10) }))));
    const { view } = await mount();
    await choose(view, [REQ_001]);
    await userEvent.click(startButton());
    await expect.poll(() => isDisabled(aiButton())).toBe(false);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    await userEvent.click(aiButton());
    await expect.poll(() => dialog()?.textContent).toContain('아주 긴 AI TC 제목');
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    const panel = dialog()!.querySelector('section[aria-label="AI 초안"]') as HTMLElement;
    expect(panel.getBoundingClientRect().right).toBeLessThanOrEqual(390);
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
  });
});
