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
import { createSeed, PROJECT_A } from '@/data/mock/seed';
import type { Repositories } from '@/data/repositories/types';
import { produceRuleBasedTestDrafts } from '@/domain/testDraftGeneration';
import { ProjectRecordsTab } from '../records/ProjectRecordsTab';
import { TestDesignTab } from '../test-design/TestDesignTab';
import { RequirementsTab } from './RequirementsTab';

/*
 * 요구사항 기반 TC 초안 만들기를 실제 브라우저(Chromium) · 저장소와 함께 확인한다.
 * 요구사항 · 관점 선택 → 미리보기(제외 · 중복 · 확인 필요) → 만들기 → 테스트 설계 표 · 검토 · 기록, 제거된 요구사항 · 빈 선택, 390px 가로 넘침.
 */

const holder = vi.hoisted(() => ({ repos: undefined as Repositories | undefined }));
vi.mock('@/data', () => ({ repositories: new Proxy({}, { get: (_target, key) => holder.repos?.[key as keyof Repositories] }) }));

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let router: ReturnType<typeof createBrowserRouter> | undefined;
const originalUrl = `${location.pathname}${location.search}`;
const requirementsPath = `/projects/${PROJECT_A}/requirements`;
const testDesignPath = `/projects/${PROJECT_A}/test-design`;

const REQ_001 = '이메일, 비밀번호, 약관 동의를 입력하면 가입할 수 있다.';
const REQ_002 = '비밀번호는 영문과 숫자를 포함해 8자 이상이어야 한다.';
const REQ_004 = '약관 재동의 조건이 모호함 — 개정 시점 기준인지 앱 업데이트 기준인지 명시 필요';

async function unmount() {
  await act(async () => root?.unmount());
  router?.dispose();
  container?.remove();
  root = container = router = undefined;
}

async function mount({ change = () => {}, search = '' }: { change?: (data: AppData) => void; search?: string } = {}) {
  await unmount();
  const repos = createLocalRepositories({
    openStore: async () => createMemoryStateStore(),
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

afterEach(async () => {
  await unmount();
  holder.repos = undefined;
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

/** 기능 묶음은 접혀 있으므로 펼친 뒤 요구사항을 고른다. */
async function openFeature(view: HTMLElement, feature: string) {
  const summary = [...view.querySelectorAll('summary')].find((item) => item.textContent?.includes(feature))!;
  if (!summary.closest('details')!.open) await userEvent.click(summary);
}

/** 모든 요구사항 선택을 풀고 주어진 요구사항만 고른다. 관점은 정상 흐름 + 경계값만 남긴다. */
async function choose(view: HTMLElement, features: Record<string, string[]>, perspectives = ['정상 흐름', '경계값']) {
  await userEvent.click(button('모두 해제'));
  for (const [feature, texts] of Object.entries(features)) {
    await openFeature(view, feature);
    for (const text of texts) await userEvent.click(targetBox(text));
  }
  for (const label of ['정상 흐름', '예외', '경계값', '권한', '상태 변화', '데이터 조회/저장']) {
    const checked = chip(view, label).querySelector('input')!.checked;
    if (checked !== perspectives.includes(label)) await userEvent.click(chip(view, label));
  }
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
    // 정상 흐름 2건 + 경계값 1건(요구사항에 8자 단서가 있는 것만). 첫 요구사항은 경계값 단서가 없어 건너뛴다.
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
    expect(dialog()!.textContent).toContain('TC 초안 2건을 만들 예정이에요.');

    await userEvent.click(makeButton());
    await expect.poll(() => dialog()?.textContent).toContain('TC 초안 2건을 만들었어요.');
    expect((await repos.testCases.listByProject(PROJECT_A)).length).toBe(before.length + 2);

    await userEvent.click(page.getByRole('link', { name: '테스트 설계에서 보기' }));
    await expect.poll(() => router!.state.location.pathname).toBe(testDesignPath);
    const title = `${REQ_002.replace(/\.$/, '')} · 정상 흐름 확인`;
    await expect.poll(() => view.textContent).toContain(title);
    expect(view.textContent).toContain('TC 초안17개'.replace('TC 초안', ''));
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
    expect(view.textContent).toContain('신규 TC 2 · 테스트 조건 신규 2 · 재사용 0 · 중복 0 · 제외 1');
  });

  it('확인 필요 요구사항은 확인 필요 초안으로 미리보기 · 저장되고 테스트 설계에서 검토 완료가 막힌다', async () => {
    const { view, repos } = await mount();
    await choose(view, { 회원가입: [REQ_004] }, ['정상 흐름']);
    await userEvent.click(startButton());
    await expect.poll(() => counts('생성 후보', '확인 필요')).toEqual(['1', '1']);
    expect(previewRows()[0].textContent).toContain('확인 필요');
    await userEvent.click(makeButton());
    await expect.poll(() => dialog()?.textContent).toContain('TC 초안 1건을 만들었어요.');
    const created = (await repos.testCases.listByProject(PROJECT_A)).find((item) => item.requirementIds.includes('req-004') && item.origin === 'manual')!;
    expect(created).toMatchObject({ generationType: 'needs_confirmation', status: 'draft' });

    await userEvent.click(page.getByRole('link', { name: '테스트 설계에서 보기' }));
    await expect.poll(() => view.textContent).toContain(created.title);
    await userEvent.click(page.getByRole('button', { name: created.title }));
    await expect.poll(() => view.querySelector('[id^="tc-detail-"]')).not.toBeNull();
    expect(isDisabled(button('검토 완료로 표시'))).toBe(true);
    expect(view.textContent).toContain('확인사항이 답변되면 검토할 수 있어요.');
  });

  it('같은 내용의 TC가 이미 있으면 중복으로 표시하고 만들지 않는다(만들 수 없으면 버튼이 비활성)', async () => {
    const { view, repos } = await mount({
      change: (data) => {
        const context = {
          project: data.projects.find((item) => item.id === PROJECT_A)!,
          requirements: data.requirements,
          deliverables: data.deliverables,
          testConditions: data.testConditions,
          testCases: data.testCases,
        };
        const [candidate] = produceRuleBasedTestDrafts(context, { requirementIds: ['req-001'], perspectives: ['normal_flow'] }).candidates;
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
          revision: 1,
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
        });
      },
    });
    const before = await repos.testCases.listByProject(PROJECT_A);
    await choose(view, { 회원가입: [REQ_001] }, ['정상 흐름']);
    await userEvent.click(startButton());
    await expect.poll(() => counts('생성 후보', '중복')).toEqual(['0', '1']);
    expect(previewRows()[0].textContent).toContain('기존 TC · SIGN-099');
    expect(previewRows()[0].textContent).toContain('같은 내용의 TC가 이미 있어요.');
    expect(previewRows()[0].querySelector('input[type="checkbox"]')).toBeNull();
    expect(dialog()!.textContent).toContain('만들 수 있는 새 TC 초안이 없어요.');
    expect(isDisabled(makeButton())).toBe(true);
    expect(await repos.testCases.listByProject(PROJECT_A)).toEqual(before);
  });
});

describe('요구사항 기반 TC 초안: 미리보기 중 바뀐 데이터', () => {
  it('제외한 후보가 그 사이 다른 경로로 만들어져 중복이 되어도 오류 없이 나머지를 만든다(미리보기를 다시 계산)', async () => {
    const { view, repos } = await mount();
    const before = await repos.testCases.listByProject(PROJECT_A);
    await choose(view, { 회원가입: [REQ_001, REQ_002] }, ['정상 흐름']);
    await userEvent.click(startButton());
    await expect.poll(() => counts('생성 후보', '중복')).toEqual(['2', '0']);
    await userEvent.click(page.getByRole('checkbox', { name: new RegExp(`제외: ${REQ_001.slice(0, 12)}`) }));
    await expect.poll(() => counts('생성 후보', '제외')).toEqual(['1', '1']);

    // 미리보기를 보는 동안 제외한 후보와 같은 TC가 다른 경로로 만들어졌다.
    await repos.testCases.createDraftsFromRequirements({ projectId: PROJECT_A, requirementIds: ['req-001'], perspectives: ['normal_flow'], excludedKeys: [] });
    await expect.poll(() => counts('생성 후보', '중복', '제외')).toEqual(['1', '1', '0']);
    await userEvent.click(makeButton());
    await expect.poll(() => dialog()?.textContent).toContain('TC 초안 1건을 만들었어요.');
    expect(dialog()!.textContent).not.toContain('제외할 수 있는 TC 초안 후보가 아니에요');
    expect((await repos.testCases.listByProject(PROJECT_A)).length).toBe(before.length + 2);
  });
});

describe('요구사항 기반 TC 초안: 대상 선택', () => {
  it('제거된 요구사항 보기에서는 만들 수 없고, 제거된 요구사항에는 선택 상자가 없다', async () => {
    const { view } = await mount({ search: '?filter=removed' });
    await expect.poll(() => selectionText(view)).toContain('제거된 요구사항으로는 초안을 만들 수 없어요.');
    expect(isDisabled(startButton())).toBe(true);
    expect(view.querySelector('details')!.textContent).toContain('SNS 계정 연동 안내 팝업');
    expect(view.querySelectorAll('input[type="checkbox"][class=""], label input[type="checkbox"]:not(.visually-hidden)').length).toBe(0);
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

  it('기본 선택(보이는 요구사항 전체)으로 만들면 모든 요구사항이 대상이고, 취소하면 아무것도 저장하지 않는다', async () => {
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
  it('요구사항 화면 · 미리보기 표가 가로로 넘치지 않는다', async () => {
    await page.viewport(390, 844);
    const long = `아주 긴 요구사항 문장입니다 ${'가나다라마바사 '.repeat(30)}최대 20자 이상`;
    const { view } = await mount({
      change: (data) => {
        data.requirements.push({ id: 'req-long', projectId: PROJECT_A, feature: `매우긴기능이름${'ABCDEFGHIJ'.repeat(10)}`, text: long, sourceRefs: [{ deliverableId: 'dlv-plan-pdf', locator: 'p.99' }], sourceType: 'source_explicit', needsConfirmation: false, lifecycle: 'active', status: 'draft' });
      },
    });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    await userEvent.click(startButton());
    await expect.poll(() => count('대상 요구사항')).toBe('13');
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    const box = dialog()!;
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
    const scroller = box.querySelector('[role="region"]') as HTMLElement;
    expect(scroller.getBoundingClientRect().right).toBeLessThanOrEqual(390);
    expect(view.textContent).toContain('요구사항');
  });
});
