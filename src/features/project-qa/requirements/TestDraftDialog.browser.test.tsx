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
import { produceRuleBasedTestDrafts } from '@/domain/testDraftGeneration';
import type { TestCase, TestPerspective } from '@/domain/types';
import { ProjectRecordsTab } from '../records/ProjectRecordsTab';
import { TestDesignTab } from '../test-design/TestDesignTab';
import { RequirementsTab } from './RequirementsTab';

/*
 * 요구사항 기반 TC 초안 만들기를 실제 브라우저(Chromium) · 저장소와 함께 확인한다.
 * 요구사항 · 관점 선택 → 미리보기(제외 · 중복 판단 · 확인 필요 · 양식 오류) → 만들기 → 테스트 설계 표 · 검토 · 기록,
 * 미리보기 뒤 바뀐 데이터(다시 확인), 오탐 방지, 제거된 요구사항 · 빈 선택, 390px 가로 넘침.
 */

const holder = vi.hoisted(() => ({ repos: undefined as Repositories | undefined }));
vi.mock('@/data', () => ({ repositories: new Proxy({}, { get: (_target, key) => holder.repos?.[key as keyof Repositories] }) }));

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let router: ReturnType<typeof createBrowserRouter> | undefined;
let memoryStore: ReturnType<typeof createMemoryStateStore> | undefined;
const originalUrl = `${location.pathname}${location.search}`;
const requirementsPath = `/projects/${PROJECT_A}/requirements`;
const testDesignPath = `/projects/${PROJECT_A}/test-design`;

const REQ_001 = '이메일, 비밀번호, 약관 동의를 입력하면 가입할 수 있다.';
const REQ_002 = '비밀번호는 영문과 숫자를 포함해 8자 이상이어야 한다.';
const REQ_004 = '약관 재동의 조건이 모호함 — 개정 시점 기준인지 앱 업데이트 기준인지 명시 필요';
const STALE = '요구사항이나 기존 TC가 바뀌어 미리보기를 다시 확인해 주세요.';

async function unmount() {
  await act(async () => root?.unmount());
  router?.dispose();
  container?.remove();
  root = container = router = undefined;
}

async function mount({ change = () => {}, search = '' }: { change?: (data: AppData) => void; search?: string } = {}) {
  await unmount();
  memoryStore = createMemoryStateStore();
  const repos = createLocalRepositories({
    openStore: async () => memoryStore!,
    createInitialData: (): AppData => {
      const data = createSeed();
      change(data);
      return data;
    },
  });
  await repos.persistence.load();
  holder.repos = repos;
  const project = (await repos.projects.get(PROJECT_A))!;
  history.replaceState(null, '', `${requirementsPath}${search}`);
  router = createBrowserRouter([
    {
      element: <Outlet context={{ project, openDeliverableCreate: () => {} }} />,
      children: [
        { path: requirementsPath, element: <RequirementsTab /> },
        { path: testDesignPath, element: <TestDesignTab /> },
        { path: `/projects/${PROJECT_A}/records`, element: <ProjectRecordsTab /> },
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

/** 저장된 데이터를 바꾼다(미리보기를 보는 동안 다른 경로로 바뀐 상황). */
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
  history.replaceState(null, '', originalUrl);
  await page.viewport(1280, 900);
});

const dialog = () => document.querySelector('dialog[open]') as HTMLDialogElement | null;
const button = (name: string | RegExp, exact = false) => page.getByRole('button', { name, exact });
const startButton = () => button('선택 요구사항으로 TC 초안 만들기');
const makeButton = () => button('TC 초안 만들기', true);
const isDisabled = (locator: ReturnType<typeof button>) => (locator.element() as HTMLButtonElement).disabled;
const count = (label: string) => [...(dialog()?.querySelectorAll('dl[aria-label="초안 판정 요약"] > div') ?? [])].find((item) => item.querySelector('dt')?.textContent === label)?.querySelector('dd')?.textContent;
const counts = (...labels: string[]) => labels.map(count);
const previewRows = () => [...(dialog()?.querySelectorAll('tbody tr') ?? [])];
const targetBox = (text: string) => page.getByRole('checkbox', { name: new RegExp(`TC 초안 대상: ${text.slice(0, 12)}`) });
const chip = (view: HTMLElement, label: string) => [...view.querySelectorAll<HTMLLabelElement>('fieldset label')].find((item) => item.textContent === label)!;
const selectionText = (view: HTMLElement) => view.querySelector('aside')?.textContent ?? '';
const decisionSelect = () => dialog()!.querySelector('select[aria-label^="중복 처리"]') as HTMLSelectElement;
const decide = (label: string) => userEvent.selectOptions(decisionSelect(), label);

/** 기능 묶음은 접혀 있으므로 펼친 뒤 요구사항을 고른다. */
async function openFeature(view: HTMLElement, feature: string) {
  const summary = [...view.querySelectorAll('summary')].find((item) => item.textContent?.includes(feature))!;
  if (!summary.closest('details')!.open) await userEvent.click(summary);
}

/** 테스트 관점을 주어진 것만 남긴다. */
async function setPerspectives(view: HTMLElement, perspectives: string[]) {
  for (const label of ['정상 흐름', '예외', '경계값', '권한', '상태 변화', '데이터 조회/저장']) {
    const checked = chip(view, label).querySelector('input')!.checked;
    if (checked !== perspectives.includes(label)) await userEvent.click(chip(view, label));
  }
}

/** 모든 요구사항 선택을 풀고 주어진 요구사항만 고른다. 관점은 정상 흐름 + 경계값만 남긴다. */
async function choose(view: HTMLElement, features: Record<string, string[]>, perspectives = ['정상 흐름', '경계값']) {
  await userEvent.click(button('모두 해제'));
  for (const [feature, texts] of Object.entries(features)) {
    await openFeature(view, feature);
    for (const text of texts) await userEvent.click(targetBox(text));
  }
  await setPerspectives(view, perspectives);
}

/** req-001 정상 흐름과 같은 내용의 기존 TC를 더한다. */
function addDuplicateOfReq001(data: AppData, overrides: Partial<TestCase> = {}) {
  const [candidate] = produceRuleBasedTestDrafts(
    { project: data.projects.find((item) => item.id === PROJECT_A)!, requirements: data.requirements, deliverables: data.deliverables, testConditions: [], testCases: [], templates: data.templates },
    { requirementIds: ['req-001'], perspectives: ['normal_flow'] as TestPerspective[] },
  ).candidates;
  data.testCases.push({
    id: 'tc-existing-draft',
    projectId: PROJECT_A,
    externalId: 'SIGN-099',
    category: 'normal_flow',
    feature: candidate.testCase.feature,
    depth: ['회원가입'],
    title: candidate.testCase.title,
    steps: candidate.testCase.steps,
    expectedResult: candidate.testCase.expectedResult,
    requirementIds: [],
    testConditionIds: [],
    sourceRefs: [],
    generationType: 'source_explicit',
    origin: 'imported',
    status: 'draft',
    revision: 2,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  });
}

describe('요구사항 기반 TC 초안: 전체 흐름', () => {
  it('요구사항 · 관점을 고르고 미리보기에서 한 후보를 제외한 뒤 만들면, 테스트 설계 표에 초안으로 나타나고 검토 완료로 표시할 수 있으며 기록에 남는다', async () => {
    const { view, repos } = await mount();
    const before = await repos.testCases.listByProject(PROJECT_A);
    // 요구사항 화면 기본 선택은 보이는 요구사항 전체다.
    expect(selectionText(view)).toContain('선택한 요구사항 12 / 12개');
    await choose(view, { 회원가입: [REQ_001, REQ_002] });
    await expect.poll(() => selectionText(view)).toContain('선택한 요구사항 2 / 12개');

    await userEvent.click(startButton());
    await expect.poll(() => dialog()).not.toBeNull();
    // 정상 흐름 2건 + 경계값 1건(요구사항에 8자 이상 단서가 있는 것만). 첫 요구사항은 경계값 단서가 없어 건너뛴다.
    await expect.poll(() => counts('대상 요구사항', '선택 관점', '생성 후보', '확인 필요', '중복', '오류', '제외')).toEqual(['2', '2', '3', '0', '0', '0', '0']);
    expect(previewRows()).toHaveLength(3);
    expect(dialog()!.textContent).toContain('AI가 만든 초안이 아니에요');
    expect(dialog()!.querySelector('details')!.textContent).toContain('단서가 없어 만들지 않은 조합 1건');
    expect(dialog()!.querySelector('details')!.textContent).toContain('경계값 단서가 없어 만들지 않았어요');
    // 아직 아무것도 저장하지 않았다.
    expect(await repos.testCases.listByProject(PROJECT_A)).toEqual(before);

    // 경계값 후보를 제외한다.
    await userEvent.click(page.getByRole('checkbox', { name: /제외: .*경계값 확인/ }));
    await expect.poll(() => counts('생성 후보', '제외')).toEqual(['2', '1']);
    expect(dialog()!.textContent).toContain('TC 초안 2건을 만들고 기존 TC 0건에 연결할 예정이에요.');

    await userEvent.click(makeButton());
    await expect.poll(() => dialog()?.textContent).toContain('TC 초안 2건을 만들고 기존 TC 0건에 연결했어요.');
    expect((await repos.testCases.listByProject(PROJECT_A)).length).toBe(before.length + 2);

    await userEvent.click(page.getByRole('link', { name: '테스트 설계에서 보기' }));
    await expect.poll(() => router!.state.location.pathname).toBe(testDesignPath);
    const title = `${REQ_002.replace(/\.$/, '')} · 정상 흐름 확인`;
    await expect.poll(() => view.textContent).toContain(title);
    expect(view.textContent).not.toContain('경계값 확인');

    // 행을 펼치면 요구사항 문장 기반 내용 · 근거 · 생성 유형 · 초안 상태가 보인다.
    await userEvent.click(page.getByRole('button', { name: title }));
    await expect.poll(() => view.querySelector('[id^="tc-detail-"]')).not.toBeNull();
    const detail = view.querySelector('[id^="tc-detail-"]')!.textContent!;
    expect(detail).toContain(`요구사항대로 동작한다. (${REQ_002.replace(/\.$/, '')})`);
    expect(detail).toContain('산출물 직접 근거');
    const row = page.getByRole('button', { name: title }).element().closest('tr')!;
    expect(row.textContent).toContain('p.14');
    expect(row.textContent).toContain('초안');
    expect(row.textContent).toContain('미지정');

    // 일반 초안은 검토 완료로 표시할 수 있다.
    await userEvent.click(button('검토 완료로 표시'));
    await expect.poll(async () => (await repos.testCases.listByProject(PROJECT_A)).find((item) => item.title === title)?.status).toBe('reviewed');

    // 기록: 제목은 평문이고 "테스트 설계 보기"로 간다.
    await act(async () => router!.navigate(`/projects/${PROJECT_A}/records`));
    await expect.poll(() => view.textContent).toContain('TC 초안 2건 생성');
    expect(page.getByRole('link', { name: 'TC 초안 2건 생성' }).elements()).toHaveLength(0);
    expect(view.textContent).toContain('신규 TC 2(별도 신규 0) · 기존 TC 연결 0 · 생성 TC 연결 0 · 테스트 조건 신규 2 · 재사용 0 · 중복 제외 0 · 제외 1');
  });

  it('확인 필요 요구사항은 확인 필요 초안으로 미리보기 · 저장되고 테스트 설계에서 검토 완료가 막힌다', async () => {
    const { view, repos } = await mount();
    await choose(view, { 회원가입: [REQ_004] }, ['정상 흐름']);
    await userEvent.click(startButton());
    await expect.poll(() => counts('생성 후보', '확인 필요')).toEqual(['1', '1']);
    expect(previewRows()[0].textContent).toContain('확인 필요');
    await userEvent.click(makeButton());
    await expect.poll(() => dialog()?.textContent).toContain('TC 초안 1건을 만들고');
    const created = (await repos.testCases.listByProject(PROJECT_A)).find((item) => item.requirementIds.includes('req-004') && item.origin === 'manual')!;
    expect(created).toMatchObject({ generationType: 'needs_confirmation', status: 'draft' });

    await userEvent.click(page.getByRole('link', { name: '테스트 설계에서 보기' }));
    await expect.poll(() => view.textContent).toContain(created.title);
    await userEvent.click(page.getByRole('button', { name: created.title }));
    await expect.poll(() => view.querySelector('[id^="tc-detail-"]')).not.toBeNull();
    expect(isDisabled(button('검토 완료로 표시'))).toBe(true);
    expect(view.textContent).toContain('확인사항이 답변되면 검토할 수 있어요.');
  });

  it('재검토 필요 상태의 확인 필요 TC는 다시 검토 완료로 표시할 수 없고, 일반 재검토 필요 TC는 표시할 수 있다', async () => {
    const { view, repos } = await mount({
      change: (data) => {
        data.testCases.find((item) => item.id === 'tc-010')!.status = 'needs_review';
        data.testCases.find((item) => item.id === 'tc-001')!.status = 'needs_review';
      },
    });
    await act(async () => router!.navigate(testDesignPath));
    await expect.poll(() => view.textContent).toContain('LOGIN-018');

    await userEvent.click(page.getByRole('button', { name: '실패 횟수 정책 확인 필요' }));
    await expect.poll(() => view.querySelector('[id^="tc-detail-"]')).not.toBeNull();
    expect(isDisabled(button('다시 검토 완료로 표시'))).toBe(true);
    expect(view.textContent).toContain('확인사항이 답변되면 검토할 수 있어요.');
    expect((await repos.testCases.listByProject(PROJECT_A)).find((item) => item.id === 'tc-010')!.status).toBe('needs_review');

    // 행은 하나씩 펼쳐진다. 일반 TC로 옮겨 가면 다시 검토 완료로 표시할 수 있다.
    await userEvent.click(page.getByRole('button', { name: '유효한 비밀번호 입력 시 가입 가능' }));
    await expect.poll(() => view.textContent).not.toContain('확인사항이 답변되면 검토할 수 있어요.');
    expect(isDisabled(button('다시 검토 완료로 표시'))).toBe(false);
    await userEvent.click(button('다시 검토 완료로 표시'));
    await expect.poll(async () => (await repos.testCases.listByProject(PROJECT_A)).find((item) => item.id === 'tc-001')!.status).toBe('reviewed');
  });
});

describe('요구사항 기반 TC 초안: 중복 판단', () => {
  async function openDuplicatePreview(overrides: Partial<TestCase> = {}) {
    const mounted = await mount({ change: (data) => addDuplicateOfReq001(data, overrides) });
    await choose(mounted.view, { 회원가입: [REQ_001] }, ['정상 흐름']);
    await userEvent.click(startButton());
    await expect.poll(() => dialog()).not.toBeNull();
    return mounted;
  }

  it('연결돼 있지 않은 중복은 판단 전에는 만들 수 없고, 어떤 TC와 같은지 · 연결 여부를 보여준다', async () => {
    const { repos } = await openDuplicatePreview();
    const before = await repos.testCases.listByProject(PROJECT_A);
    await expect.poll(() => counts('생성 후보', '중복', '판단 필요')).toEqual(['0', '1', '1']);
    expect(previewRows()[0].textContent).toContain('기존 TC · SIGN-099');
    expect(previewRows()[0].textContent).toContain('이 요구사항은 연결돼 있지 않아요');
    expect(previewRows()[0].textContent).toContain('이 중복을 어떻게 할지 골라 주세요.');
    expect(dialog()!.textContent).toContain('판단하지 않은 중복 1건이 있어요.');
    expect(isDisabled(makeButton())).toBe(true);
    expect([...decisionSelect().options].map((option) => option.textContent)).toEqual(['판단 필요', '기존 TC와 연결', '별도 신규 TC로 만들기', '제외']);
    expect(await repos.testCases.listByProject(PROJECT_A)).toEqual(before);
  });

  it('기존 TC와 연결을 고르면 새 TC는 만들지 않고 기존 TC에 요구사항 · 근거 · 조건 연결만 더한다(내용은 그대로)', async () => {
    const { repos } = await openDuplicatePreview();
    const before = await repos.testCases.listByProject(PROJECT_A);
    const original = before.find((item) => item.id === 'tc-existing-draft')!;
    await decide('기존 TC와 연결');
    await expect.poll(() => counts('생성 후보', '기존 TC 연결', '판단 필요')).toEqual(['0', '1', '0']);
    expect(dialog()!.textContent).toContain('TC 초안 0건을 만들고 기존 TC 1건에 연결할 예정이에요.');
    await expect.poll(() => isDisabled(makeButton())).toBe(false);
    await userEvent.click(makeButton());
    await expect.poll(() => dialog()?.textContent).toContain('TC 초안 0건을 만들고 기존 TC 1건에 연결했어요.');

    const after = await repos.testCases.listByProject(PROJECT_A);
    expect(after).toHaveLength(before.length);
    const updated = after.find((item) => item.id === 'tc-existing-draft')!;
    expect(updated.requirementIds).toEqual(['req-001']);
    expect(updated.testConditionIds).toHaveLength(1);
    expect(updated.sourceRefs).toEqual([{ deliverableId: 'dlv-plan-pdf', locator: 'p.10' }]);
    expect(updated).toMatchObject({ title: original.title, steps: original.steps, expectedResult: original.expectedResult, status: 'draft', externalId: 'SIGN-099', revision: 3 });
  });

  it('별도 신규를 고르면 같은 내용의 새 TC를 만들고 기존 TC는 바꾸지 않는다', async () => {
    const { repos } = await openDuplicatePreview();
    const original = (await repos.testCases.listByProject(PROJECT_A)).find((item) => item.id === 'tc-existing-draft')!;
    await decide('별도 신규 TC로 만들기');
    await expect.poll(() => counts('생성 후보', '기존 TC 연결')).toEqual(['1', '0']);
    await userEvent.click(makeButton());
    await expect.poll(() => dialog()?.textContent).toContain('TC 초안 1건을 만들고');
    const after = await repos.testCases.listByProject(PROJECT_A);
    expect(after.find((item) => item.id === 'tc-existing-draft')).toEqual(original);
    expect(after.filter((item) => item.title === original.title)).toHaveLength(2);
  });

  it('제외를 고르면 만들 것이 없고, 이 요구사항이 TC와 연결되지 않는다는 점을 분명히 알린다', async () => {
    const { repos } = await openDuplicatePreview();
    const before = await repos.testCases.listByProject(PROJECT_A);
    await decide('제외');
    await expect.poll(() => previewRows()[0].textContent).toContain('제외하면 이 요구사항은 같은 내용의 TC와 연결되지 않아요.');
    expect(dialog()!.textContent).toContain('새로 반영할 TC 초안 또는 연결이 없어요.');
    expect(isDisabled(makeButton())).toBe(true);
    expect(await repos.testCases.listByProject(PROJECT_A)).toEqual(before);
  });

  it('이미 연결된 중복은 "이미 연결됨"으로 표시하고 할 일이 없으며 저장하지 않는다', async () => {
    const { repos } = await openDuplicatePreview({ requirementIds: ['req-001'] });
    const before = await repos.testCases.listByProject(PROJECT_A);
    await expect.poll(() => counts('중복', '판단 필요')).toEqual(['1', '0']);
    expect(previewRows()[0].textContent).toContain('이 요구사항이 이미 연결돼 있어요');
    expect(previewRows()[0].textContent).toContain('이미 연결됨 · 할 일 없음');
    expect(isDisabled(makeButton())).toBe(true);
    expect([...decisionSelect().options].map((option) => option.textContent)).toEqual(['별도 신규 TC로 만들기', '제외']);
    expect(await repos.testCases.listByProject(PROJECT_A)).toEqual(before);
    expect((await repos.activities.list({ projectId: PROJECT_A })).filter((item) => item.type === 'test_drafts_generated')).toEqual([]);
  });

  it('같은 배치의 중복: 뒤 요구사항이 앞선 후보와 같다고 보여주고, 연결을 고르면 하나의 TC에 두 요구사항이 이어진다', async () => {
    const { view, repos } = await mount({
      change: (data) => {
        const copy = (id: string, locator: string) => ({ ...data.requirements.find((item) => item.id === 'req-001')!, id, feature: '복제 기능', sourceRefs: [{ deliverableId: 'dlv-plan-pdf', locator }] });
        data.requirements.push(copy('req-dup-1', 'p.31'), copy('req-dup-2', 'p.32'));
      },
    });
    // 같은 문장이 두 번 있으므로 두 요구사항을 모두 고른다.
    await userEvent.click(button('모두 해제'));
    await setPerspectives(view, ['정상 흐름']);
    await openFeature(view, '복제 기능');
    for (const box of page.getByRole('checkbox', { name: new RegExp(`TC 초안 대상: ${REQ_001.slice(0, 12)}`) }).elements()) {
      const parent = box.closest('li');
      if (parent?.textContent?.includes('p.31') || parent?.textContent?.includes('p.32')) await userEvent.click(box as HTMLElement);
    }
    await expect.poll(() => selectionText(view)).toContain('선택한 요구사항 2 / 14개');
    await userEvent.click(startButton());
    await expect.poll(() => counts('대상 요구사항', '생성 후보', '중복', '판단 필요')).toEqual(['2', '1', '1', '1']);
    expect(previewRows()[1].textContent).toContain('이번에 만드는 TC');
    expect(previewRows()[1].textContent).toContain('이 요구사항은 그 후보의 TC에 연결되지 않아요');
    expect(isDisabled(makeButton())).toBe(true);
    expect([...decisionSelect().options].map((option) => option.textContent)).toEqual(['판단 필요', '앞선 후보 TC와 연결', '별도 신규 TC로 만들기', '제외']);

    await decide('앞선 후보 TC와 연결');
    // 앞선 후보로 만드는 새 TC에 연결하는 것이라 "기존 TC 연결"이 아니라 "생성 TC 연결"로 센다.
    await expect.poll(() => counts('생성 후보', '기존 TC 연결', '생성 TC 연결', '판단 필요')).toEqual(['1', '0', '1', '0']);
    expect(dialog()!.textContent).toContain('만드는 TC에 요구사항 1건을 더 연결해요.');
    await userEvent.click(makeButton());
    await expect.poll(() => dialog()?.textContent).toContain('만든 TC에 요구사항 1건을 더 연결했어요.');
    const created = (await repos.testCases.listByProject(PROJECT_A)).filter((item) => item.origin === 'manual');
    expect(created).toHaveLength(1);
    expect(created[0].requirementIds).toEqual(['req-dup-1', 'req-dup-2']);
    expect(created[0].sourceRefs.map((ref) => ref.locator)).toEqual(['p.31', 'p.32']);
  });
});

describe('요구사항 기반 TC 초안: 미리보기 뒤 바뀐 데이터', () => {
  it('미리보기를 본 뒤 요구사항 문장이 바뀌면 저장하지 않고 다시 확인하게 하며, 다시 확인하면 바뀐 내용으로 만들 수 있다', async () => {
    const { view, repos } = await mount();
    const before = await repos.testCases.listByProject(PROJECT_A);
    await choose(view, { 회원가입: [REQ_001] }, ['정상 흐름']);
    await userEvent.click(startButton());
    await expect.poll(() => counts('생성 후보')).toEqual(['1']);
    expect(previewRows()[0].textContent).toContain(REQ_001);

    // 미리보기를 보는 동안 같은 후보(같은 key)의 요구사항 문장이 바뀐다.
    const changedText = '이메일과 비밀번호만 입력하면 가입할 수 있다.';
    await changeStored(repos, (data) => void (data.requirements.find((item) => item.id === 'req-001')!.text = changedText));
    await expect.poll(() => dialog()!.textContent).toContain(STALE);
    expect(isDisabled(makeButton())).toBe(true);
    // 보던 미리보기는 그대로이고 아무것도 저장되지 않았다.
    expect(previewRows()[0].textContent).toContain(REQ_001);
    expect(await repos.testCases.listByProject(PROJECT_A)).toEqual(before);

    await userEvent.click(button('미리보기 다시 확인'));
    await expect.poll(() => previewRows()[0].textContent).toContain(changedText);
    expect(dialog()!.textContent).not.toContain(STALE);
    await expect.poll(() => isDisabled(makeButton())).toBe(false);
    await userEvent.click(makeButton());
    await expect.poll(() => dialog()?.textContent).toContain('TC 초안 1건을 만들고');
    const created = (await repos.testCases.listByProject(PROJECT_A)).find((item) => item.origin === 'manual')!;
    expect(created.title).toContain(changedText.replace(/\.$/, ''));
  });

  it('미리보기 뒤 신규였던 후보가 중복이 되면 저장하지 않고 다시 확인하게 한다', async () => {
    const { view, repos } = await mount();
    const before = await repos.testCases.listByProject(PROJECT_A);
    await choose(view, { 회원가입: [REQ_001] }, ['정상 흐름']);
    await userEvent.click(startButton());
    await expect.poll(() => counts('생성 후보', '중복')).toEqual(['1', '0']);
    await changeStored(repos, (data) => addDuplicateOfReq001(data));
    await expect.poll(() => dialog()!.textContent).toContain(STALE);
    expect(isDisabled(makeButton())).toBe(true);
    expect(await repos.testCases.listByProject(PROJECT_A)).toHaveLength(before.length + 1);
    await userEvent.click(button('미리보기 다시 확인'));
    await expect.poll(() => counts('생성 후보', '중복', '판단 필요')).toEqual(['0', '1', '1']);
  });
});

describe('요구사항 기반 TC 초안: 미리보기 뒤 저장 결과가 달라지는 변경', () => {
  const withTemplateB = (data: AppData) => void data.templates.push({ ...data.templates[0], id: 'tpl-b', projectId: PROJECT_A, name: '양식 B' });

  it('양식이 A에서 B로 바뀌면 저장하지 않고 다시 확인하게 하며, 다시 확인한 뒤에는 B 양식으로 만든다', async () => {
    const { view, repos } = await mount({ change: withTemplateB });
    const before = await repos.testCases.listByProject(PROJECT_A);
    await choose(view, { 회원가입: [REQ_001] }, ['정상 흐름']);
    await userEvent.click(startButton());
    await expect.poll(() => counts('생성 후보')).toEqual(['1']);

    await changeStored(repos, (data) => void (data.projects.find((item) => item.id === PROJECT_A)!.tcTemplateId = 'tpl-b'));
    await expect.poll(() => dialog()!.textContent).toContain(STALE);
    expect(isDisabled(makeButton())).toBe(true);
    expect(await repos.testCases.listByProject(PROJECT_A)).toEqual(before);

    await userEvent.click(button('미리보기 다시 확인'));
    await expect.poll(() => isDisabled(makeButton())).toBe(false);
    expect(dialog()!.textContent).not.toContain(STALE);
    await userEvent.click(makeButton());
    await expect.poll(() => dialog()?.textContent).toContain('TC 초안 1건을 만들고');
    expect((await repos.testCases.listByProject(PROJECT_A)).find((item) => item.origin === 'manual')!.templateId).toBe('tpl-b');
  });

  it('연결하려던 기존 TC의 사전 조건이 바뀌면 연결하지 않고 다시 확인하게 한다', async () => {
    const { view, repos } = await mount({ change: (data) => addDuplicateOfReq001(data, { precondition: 'session A' }) });
    await choose(view, { 회원가입: [REQ_001] }, ['정상 흐름']);
    await userEvent.click(startButton());
    await expect.poll(() => counts('판단 필요')).toEqual(['1']);
    await decide('기존 TC와 연결');
    await expect.poll(() => counts('기존 TC 연결', '판단 필요')).toEqual(['1', '0']);
    const before = await repos.testCases.listByProject(PROJECT_A);

    // 제목 · 절차 · 기대 결과 · 상태는 그대로이고 사전 조건과 revision만 바뀐다.
    await changeStored(repos, (data) => {
      const target = data.testCases.find((item) => item.id === 'tc-existing-draft')!;
      target.precondition = 'session B';
      target.revision += 1;
    });
    await expect.poll(() => dialog()!.textContent).toContain(STALE);
    expect(isDisabled(makeButton())).toBe(true);
    const stale = await repos.testCases.listByProject(PROJECT_A);
    expect(stale.find((item) => item.id === 'tc-existing-draft')).toMatchObject({ precondition: 'session B', requirementIds: [] });
    expect(stale).toHaveLength(before.length);

    // 다시 확인하면 판단이 처음으로 돌아가고, 새로 연결하면 바뀐 TC에 요구사항이 더해진다.
    await userEvent.click(button('미리보기 다시 확인'));
    await expect.poll(() => counts('판단 필요')).toEqual(['1']);
    await decide('기존 TC와 연결');
    await expect.poll(() => isDisabled(makeButton())).toBe(false);
    await userEvent.click(makeButton());
    await expect.poll(() => dialog()?.textContent).toContain('기존 TC 1건에 연결했어요.');
    expect((await repos.testCases.listByProject(PROJECT_A)).find((item) => item.id === 'tc-existing-draft')).toMatchObject({ precondition: 'session B', requirementIds: ['req-001'], revision: 4 });
  });

  it('연결하려던 기존 TC에 이미 연결된 요구사항이 확인 필요가 되면 연결하지 않고 다시 확인하게 하며, 다시 확인하면 연결을 고를 수 없다', async () => {
    const { view, repos } = await mount({ change: (data) => addDuplicateOfReq001(data, { requirementIds: ['req-002'], status: 'reviewed' }) });
    await choose(view, { 회원가입: [REQ_001] }, ['정상 흐름']);
    await userEvent.click(startButton());
    await expect.poll(() => counts('판단 필요')).toEqual(['1']);
    await decide('기존 TC와 연결');
    await expect.poll(() => counts('기존 TC 연결', '판단 필요')).toEqual(['1', '0']);
    const before = await repos.testCases.listByProject(PROJECT_A);

    // 비교 대상 TC는 그대로이고, 그 TC에 이미 연결된 다른 요구사항만 확인 필요가 된다.
    await changeStored(repos, (data) => void (data.requirements.find((item) => item.id === 'req-002')!.needsConfirmation = true));
    await expect.poll(() => dialog()!.textContent).toContain(STALE);
    expect(isDisabled(makeButton())).toBe(true);
    expect(await repos.testCases.listByProject(PROJECT_A)).toEqual(before);

    await userEvent.click(button('미리보기 다시 확인'));
    await expect.poll(() => counts('판단 필요')).toEqual(['1']);
    expect([...decisionSelect().options].map((option) => option.textContent)).toEqual(['판단 필요', '별도 신규 TC로 만들기', '제외']);
    expect(dialog()!.textContent).toContain('기존 TC에 이미 연결된 요구사항이 확인 필요라 이 TC에는 연결할 수 없어요.');
    expect((await repos.testCases.listByProject(PROJECT_A)).find((item) => item.id === 'tc-existing-draft')).toMatchObject({ status: 'reviewed', requirementIds: ['req-002'], revision: 2 });
  });

  it('미리보기 뒤 같은 테스트 조건이 생기면 저장하지 않고 다시 확인하게 한다', async () => {
    const { view, repos } = await mount();
    await choose(view, { 회원가입: [REQ_001] }, ['정상 흐름']);
    await userEvent.click(startButton());
    await expect.poll(() => counts('생성 후보')).toEqual(['1']);
    const before = await repos.testCases.listByProject(PROJECT_A);
    await changeStored(repos, (data) => {
      const [candidate] = produceRuleBasedTestDrafts(
        { project: data.projects.find((item) => item.id === PROJECT_A)!, requirements: data.requirements, deliverables: data.deliverables, testConditions: [], testCases: [], templates: data.templates },
        { requirementIds: ['req-001'], perspectives: ['normal_flow'] as TestPerspective[] },
      ).candidates;
      data.testConditions.push({ id: 'cond-appeared', projectId: PROJECT_A, requirementIds: ['req-001'], feature: candidate.condition.feature, title: candidate.condition.title, status: 'active', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' });
    });
    await expect.poll(() => dialog()!.textContent).toContain(STALE);
    expect(isDisabled(makeButton())).toBe(true);
    expect(await repos.testCases.listByProject(PROJECT_A)).toEqual(before);
    await userEvent.click(button('미리보기 다시 확인'));
    await expect.poll(() => isDisabled(makeButton())).toBe(false);
    await userEvent.click(makeButton());
    await expect.poll(() => dialog()?.textContent).toContain('TC 초안 1건을 만들고');
    expect((await repos.testCases.listByProject(PROJECT_A)).find((item) => item.origin === 'manual')!.testConditionIds).toEqual(['cond-appeared']);
  });
});

describe('요구사항 기반 TC 초안: 오탐 방지 · 양식', () => {
  it('일반적인 낱말만 있는 요구사항은 권한 · 경계값 초안을 만들지 않고 만들지 않은 이유를 보여준다', async () => {
    const { view } = await mount({
      change: (data) => {
        data.requirements.push({ id: 'req-fp', projectId: PROJECT_A, feature: '광고', text: '2026년 광고 팝업을 차단한다.', sourceRefs: [{ deliverableId: 'dlv-plan-pdf', locator: 'p.40' }], sourceType: 'source_explicit', needsConfirmation: false, lifecycle: 'active', status: 'draft' });
      },
    });
    await choose(view, { 광고: ['2026년 광고 팝업을 차단한다.'] }, ['경계값', '권한']);
    await userEvent.click(startButton());
    await expect.poll(() => dialog()).not.toBeNull();
    await expect.poll(() => counts('대상 요구사항', '생성 후보')).toEqual(['1', '0']);
    expect(previewRows()).toHaveLength(0);
    expect(dialog()!.querySelector('details')!.textContent).toContain('단서가 없어 만들지 않은 조합 2건');
    expect(dialog()!.querySelector('details')!.textContent).toContain('권한 단서가 없어 만들지 않았어요');
    expect(dialog()!.querySelector('details')!.textContent).toContain('경계값 단서가 없어 만들지 않았어요');
    expect(dialog()!.textContent).toContain('선택한 요구사항과 관점으로 만들 수 있는 후보가 없어요.');
    expect(isDisabled(makeButton())).toBe(true);
  });

  it('역할 이름만 있는 문장은 권한 초안을 만들지 않고, 접근을 제한하는 문장은 만든다', async () => {
    const { view } = await mount({
      change: (data) => {
        const base = { projectId: PROJECT_A, feature: '관리자', sourceRefs: [{ deliverableId: 'dlv-plan-pdf', locator: 'p.41' }], sourceType: 'source_explicit' as const, needsConfirmation: false, lifecycle: 'active' as const, status: 'draft' as const };
        data.requirements.push({ ...base, id: 'req-admin-logo', text: '관리자 페이지에는 로고만 노출한다.' }, { ...base, id: 'req-admin-only', text: '관리자만 접근할 수 있다.' });
      },
    });
    await choose(view, { 관리자: ['관리자 페이지에는 로고만 노출한다.', '관리자만 접근할 수 있다.'] }, ['권한']);
    await userEvent.click(startButton());
    await expect.poll(() => counts('대상 요구사항', '생성 후보')).toEqual(['2', '1']);
    expect(previewRows()).toHaveLength(1);
    expect(previewRows()[0].textContent).toContain('관리자만 접근할 수 있다');
    expect(dialog()!.querySelector('details')!.textContent).toContain('관리자 페이지에는 로고만 노출한다.');
    expect(dialog()!.querySelector('details')!.textContent).toContain('권한 단서가 없어 만들지 않았어요');
  });

  it('프로젝트 양식을 쓸 수 없으면 미리보기에서 오류를 알리고 만들 수 없다', async () => {
    const { view, repos } = await mount({ change: (data) => void (data.projects.find((item) => item.id === PROJECT_A)!.tcTemplateId = 'tpl-missing') });
    const before = await repos.testCases.listByProject(PROJECT_A);
    await userEvent.click(startButton());
    await expect.poll(() => dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain('프로젝트의 TC 양식을 찾을 수 없어요. (tpl-missing)');
    expect(isDisabled(makeButton())).toBe(true);
    expect(dialog()!.querySelector('tbody')).toBeNull();
    expect(await repos.testCases.listByProject(PROJECT_A)).toEqual(before);
    expect(view.textContent).toContain('요구사항');
  });
});

describe('요구사항 기반 TC 초안: 대상 선택', () => {
  it('제거된 요구사항 보기에서는 만들 수 없고, 제거된 요구사항에는 선택 상자가 없다', async () => {
    const { view } = await mount({ search: '?filter=removed' });
    await expect.poll(() => selectionText(view)).toContain('제거된 요구사항으로는 초안을 만들 수 없어요.');
    expect(isDisabled(startButton())).toBe(true);
    expect(view.querySelector('details')!.textContent).toContain('SNS 계정 연동 안내 팝업');
    expect(view.querySelectorAll('label input[type="checkbox"]:not(.visually-hidden)').length).toBe(0);
  });

  it('요구사항 선택이 없거나 관점이 없으면 시작할 수 없다', async () => {
    const { view } = await mount();
    expect(isDisabled(startButton())).toBe(false);
    await userEvent.click(button('모두 해제'));
    await expect.poll(() => selectionText(view)).toContain('선택한 요구사항 0 / 12개');
    expect(isDisabled(startButton())).toBe(true);
    await userEvent.click(button('모두 선택'));
    await expect.poll(() => isDisabled(startButton())).toBe(false);
    for (const label of ['정상 흐름', '예외', '경계값', '권한', '상태 변화', '데이터 조회/저장']) await userEvent.click(chip(view, label));
    await expect.poll(() => isDisabled(startButton())).toBe(true);
  });

  it('기본 선택(보이는 요구사항 전체)으로 미리보기를 열고, 취소하면 아무것도 저장하지 않는다', async () => {
    const { view, repos } = await mount();
    const before = await repos.testCases.listByProject(PROJECT_A);
    await userEvent.click(chip(view, '예외'));
    await userEvent.click(startButton());
    await expect.poll(() => count('대상 요구사항')).toBe('12');
    await userEvent.click(button('취소'));
    await expect.poll(() => dialog()).toBeNull();
    expect(await repos.testCases.listByProject(PROJECT_A)).toEqual(before);
    expect(await repos.testConditions.listByProject(PROJECT_A)).toEqual(createSeed().testConditions.filter((item) => item.projectId === PROJECT_A));
  });
});

describe('요구사항 기반 TC 초안: 390px', () => {
  it('요구사항 화면 · 미리보기 표(중복 판단 포함)가 가로로 넘치지 않는다', async () => {
    await page.viewport(390, 844);
    const long = `아주 긴 요구사항 문장입니다 ${'가나다라마바사 '.repeat(30)}최대 20자 이상`;
    const { view } = await mount({
      change: (data) => {
        data.requirements.push({ id: 'req-long', projectId: PROJECT_A, feature: `매우긴기능이름${'ABCDEFGHIJ'.repeat(10)}`, text: long, sourceRefs: [{ deliverableId: 'dlv-plan-pdf', locator: 'p.99' }], sourceType: 'source_explicit', needsConfirmation: false, lifecycle: 'active', status: 'draft' });
        addDuplicateOfReq001(data);
      },
    });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    await userEvent.click(startButton());
    await expect.poll(() => count('대상 요구사항')).toBe('13');
    expect(dialog()!.querySelector('select[aria-label^="중복 처리"]')).not.toBeNull();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    const box = dialog()!;
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
    const scroller = box.querySelector('[role="region"]') as HTMLElement;
    expect(scroller.getBoundingClientRect().right).toBeLessThanOrEqual(390);
    expect(view.textContent).toContain('요구사항');
  });
});
