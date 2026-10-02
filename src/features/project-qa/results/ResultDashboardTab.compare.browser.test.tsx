import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createBrowserRouter, Outlet, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '@/styles/tokens.css';
import '@/styles/base.css';
import { createLocalRepositories } from '@/data/local/localRepositories';
import { createMemoryStateStore } from '@/data/local/stateStore';
import { PROJECT_A } from '@/data/mock/seed';
import type { Repositories } from '@/data/repositories/types';
import { resultChangeTypeLabel } from '@/domain/labels';
import { compareResultRounds, type ResultChangeType } from '@/domain/resultComparison';
import type { ImportTable } from '@/domain/testAssetImport';
import { analyzeResultImport, defaultResultDecisionFor, suggestResultColumnMapping, type ResultColumnMapping } from '@/domain/testResultImport';
import type { ExecutionType } from '@/domain/types';
import { ResultDashboardTab } from './ResultDashboardTab';

/*
 * 수행 결과 비교 화면을 실제 결과 화면(ResultDashboardTab) · 주소 · 저장소와 함께 띄워 확인한다.
 * - 주소에 차수가 없으면 차수 번호가 가장 큰 두 차수이고, 화면을 연 채로 새 차수를 가져오면 바로 따라간다.
 * - 주소의 base · target이 기준이다. 같은 화면에서 주소가 바뀌거나 뒤로 · 앞으로 가도 select · 방향 · 요약이 주소와 같다.
 * - 사용자가 고른 차수는 새 차수를 가져와도 유지한다.
 * 저장소는 메모리 저장소(예시 데이터 1 · 2차)로 바꿔 끼운다. 결과 가져오기는 업로드 대화상자와 같은 repository 호출이다.
 */

const holder = vi.hoisted(() => ({ repos: undefined as Repositories | undefined }));
vi.mock('@/data', () => ({ repositories: new Proxy({}, { get: (_target, key) => holder.repos?.[key as keyof Repositories] }) }));

// 예시 데이터의 1 · 2차 ID(고정)
const ROUND_1 = 'imp-a-1';
const ROUND_2 = 'imp-a-2';

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let router: ReturnType<typeof createBrowserRouter> | undefined;
const originalUrl = `${location.pathname}${location.search}`;

/** 결과 화면을 주소(search)와 함께 띄운다. 주소 이동은 실제 브라우저 history를 쓴다. */
async function mount(search: string) {
  const store = createMemoryStateStore();
  const repos = createLocalRepositories({ openStore: async () => store });
  await repos.persistence.load();
  holder.repos = repos;
  const project = (await repos.projects.get(PROJECT_A))!;
  history.replaceState(null, '', `${location.pathname}${search}`);
  router = createBrowserRouter([{ element: <Outlet context={{ project, openDeliverableCreate: () => {} }} />, children: [{ path: '*', element: <ResultDashboardTab /> }] }]);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<RouterProvider router={router!} />));
  await expect.poll(() => container!.querySelector('select')).toBeTruthy();
  return { repos, store, view: container };
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
});

/** 고객사 결과 파일 한 장(TC ID · 테스트 항목 · Android · iOS)을 실제 가져오기와 같은 흐름으로 가져온다. */
async function importRound(repos: Repositories, round: number, executionType: ExecutionType = 'retest') {
  const rows = [
    ['SIGN-001', '유효한 비밀번호 입력 시 가입 가능', 'F', 'F'],
    ['LOGIN-018', '실패 횟수 정책', 'P', 'P'],
  ];
  const table: ImportTable = { headers: ['TC ID', '테스트 항목', 'Android', 'iOS'], rows: rows.map((cells, index) => ({ rowNumber: index + 2, cells })) };
  const mapping: ResultColumnMapping = suggestResultColumnMapping(table.headers).map((field, index) => field ?? (['result_android', 'result_ios'] as const)[index - 2] ?? null);
  const template = await repos.templates.get('tpl-client-a');
  const analysis = analyzeResultImport(table, mapping, await repos.testCases.listByProject(PROJECT_A), template?.resultMappings ?? []);
  const rowDecisions = analysis.rows.map((item) => ({ rowNumber: item.row.rowNumber, kind: item.kind, testCaseId: item.testCaseId, decision: defaultResultDecisionFor(item) === 'pending' ? ('import' as const) : defaultResultDecisionFor(item)! }));
  const created = await repos.testResults.importResults({
    projectId: PROJECT_A,
    fileName: `고객사A_${round}차.csv`,
    table,
    mapping,
    cycle: { round, executionType, executedFrom: '2026-10-01' },
    rowDecisions,
    valueDecisions: {},
  });
  return created.id;
}

const select = (label: string) => page.getByLabelText(label, { exact: true }).element() as HTMLSelectElement;
const summaryTypes: ResultChangeType[] = ['newly_failed', 'still_failed', 'fixed', 'newly_blocked', 'unblocked', 'added_to_scope', 'removed_from_scope'];

/** 화면에 보이는 선택 · 방향 · 요약 */
function shown(view: HTMLElement) {
  const summary = Object.fromEntries([...view.querySelectorAll('dl > div')].map((item) => [item.querySelector('dt')!.textContent, item.querySelector('dd')!.textContent]));
  return { base: select('기준 차수').value, target: select('비교 차수').value, direction: view.querySelector('p[aria-live]')?.textContent, summary };
}

/** 저장된 데이터로 직접 계산한 두 차수의 기대 값(화면의 요약 항목과 같은 이름) */
async function expected(repos: Repositories, baseId: string, targetId: string) {
  const imports = await repos.testResults.listImports(PROJECT_A);
  const base = imports.find((item) => item.id === baseId)!;
  const target = imports.find((item) => item.id === targetId)!;
  const comparison = compareResultRounds(base, target, [...(await repos.testResults.listResults(base.id)), ...(await repos.testResults.listResults(target.id))]);
  if (!comparison.ok) throw new Error(comparison.reason);
  return {
    base: base.id,
    target: target.id,
    direction: `${base.round}차 → ${target.round}차 결과를 TC · 플랫폼별로 비교해요.`,
    summary: Object.fromEntries(summaryTypes.map((type) => [resultChangeTypeLabel[type], String(comparison.counts[type])])),
  };
}

const compareUrl = (base: string, target: string) => `?view=compare&base=${base}&target=${target}`;
const navigate = (search: string) => act(async () => void (await router!.navigate(`${location.pathname}${search}`)));

describe('수행 결과 비교 화면 · 차수 선택과 주소 · 가져오기 동기화', () => {
  it('주소에 차수가 없으면 1 → 2차이고, 화면을 연 채로 3 · 4차를 가져오면 새로 고치지 않아도 2 → 3, 3 → 4차 요약으로 바뀐다', async () => {
    const { repos, view } = await mount('?view=compare');
    const oneToTwo = await expected(repos, ROUND_1, ROUND_2);
    expect(shown(view)).toEqual(oneToTwo);

    const three = await importRound(repos, 3);
    const twoToThree = await expected(repos, ROUND_2, three);
    // 요약 건수가 실제로 다른 쌍이어야 이전 요약이 남는 회귀를 잡는다.
    expect(twoToThree.summary).not.toEqual(oneToTwo.summary);
    await expect.poll(() => shown(view)).toEqual(twoToThree);
    // 자동 선택은 주소에 차수를 남기지 않는다(다음 가져오기에도 따라가야 한다).
    expect(location.search).toBe('?view=compare');

    const four = await importRound(repos, 4);
    await expect.poll(() => shown(view)).toEqual(await expected(repos, three, four));
  });

  it('차수 번호는 숫자로 비교한다: 9 · 10 · 11차를 가져오면 차례로 2 → 9, 9 → 10, 10 → 11차다', async () => {
    const { repos, view } = await mount('?view=compare');
    const nine = await importRound(repos, 9);
    await expect.poll(() => shown(view)).toEqual(await expected(repos, ROUND_2, nine));
    const ten = await importRound(repos, 10);
    await expect.poll(() => shown(view)).toEqual(await expected(repos, nine, ten));
    const eleven = await importRound(repos, 11);
    await expect.poll(() => shown(view)).toEqual(await expected(repos, ten, eleven));
    // 선택 목록도 차수 번호 순서다.
    expect([...select('기준 차수').options].map((option) => option.textContent!.split('차')[0])).toEqual(['1', '2', '9', '10', '11']);
  });

  it('사용자가 고른 1 → 2차는 3 · 4차를 가져와도 그대로 두고, 고른 차수는 주소에 남는다', async () => {
    const { repos, view } = await mount('?view=compare');
    const three = await importRound(repos, 3);
    await expect.poll(() => shown(view).target).toBe(three);

    // 2 → 3차에서 기준을 1차로, 비교를 2차로 고른다.
    // 고른 차수는 주소를 거쳐 반영되므로 한 번 고를 때마다 반영을 기다린다(다음 select의 비활성 항목이 바뀐다).
    await userEvent.selectOptions(select('기준 차수'), ROUND_1);
    await expect.poll(() => shown(view).base).toBe(ROUND_1);
    await userEvent.selectOptions(select('비교 차수'), ROUND_2);
    await expect.poll(() => shown(view).target).toBe(ROUND_2);
    const oneToTwo = await expected(repos, ROUND_1, ROUND_2);
    expect(shown(view)).toEqual(oneToTwo);
    expect(location.search).toBe(compareUrl(ROUND_1, ROUND_2));

    await importRound(repos, 4);
    // 새 차수가 목록에 나타난 뒤에도 선택은 1 → 2차다.
    await expect.poll(() => select('비교 차수').options.length).toBe(4);
    expect(shown(view)).toEqual(oneToTwo);
  });

  it('주소로 처음 열면 주소의 차수(2 → 1차)를 쓴다', async () => {
    const { repos, view } = await mount(compareUrl(ROUND_2, ROUND_1));
    expect(shown(view)).toEqual(await expected(repos, ROUND_2, ROUND_1));
  });

  it('주소의 base · target이 기준이다: 같은 화면에서 주소만 바뀔 때 · 뒤로 · 앞으로 갈 때 select와 요약이 주소와 같다', async () => {
    const { repos, view } = await mount('?view=compare');
    const three = await importRound(repos, 3);
    await expect.poll(() => shown(view).target).toBe(three);

    // 같은 화면에서 주소만 바꾼다(SPA 이동, 새로 고침 없음).
    await navigate(compareUrl(ROUND_1, three));
    await expect.poll(() => shown(view)).toEqual(await expected(repos, ROUND_1, three));
    await navigate(compareUrl(three, ROUND_1));
    await expect.poll(() => shown(view)).toEqual(await expected(repos, three, ROUND_1));
    await navigate(compareUrl(ROUND_1, ROUND_2));
    await expect.poll(() => shown(view)).toEqual(await expected(repos, ROUND_1, ROUND_2));

    // 브라우저 뒤로 · 앞으로
    history.back();
    await expect.poll(() => location.search).toBe(compareUrl(three, ROUND_1));
    await expect.poll(() => shown(view)).toEqual(await expected(repos, three, ROUND_1));
    history.back();
    await expect.poll(() => location.search).toBe(compareUrl(ROUND_1, three));
    await expect.poll(() => shown(view)).toEqual(await expected(repos, ROUND_1, three));
    history.forward();
    await expect.poll(() => location.search).toBe(compareUrl(three, ROUND_1));
    await expect.poll(() => shown(view)).toEqual(await expected(repos, three, ROUND_1));
    // 주소에 차수가 없던 처음으로 돌아가면 다시 자동 선택(가장 큰 두 차수)이다.
    history.go(-2);
    await expect.poll(() => location.search).toBe('?view=compare');
    await expect.poll(() => shown(view)).toEqual(await expected(repos, ROUND_2, three));
  });

  it('없는 차수 · 같은 차수를 가리키는 주소는 오류 없이 가장 큰 두 차수로 돌아가고, 새 차수도 따라간다', async () => {
    const { repos, view } = await mount(compareUrl('nope', 'missing'));
    expect(shown(view)).toEqual(await expected(repos, ROUND_1, ROUND_2));

    await navigate(compareUrl(ROUND_2, 'missing'));
    await expect.poll(() => shown(view)).toEqual(await expected(repos, ROUND_1, ROUND_2));
    await navigate(compareUrl(ROUND_2, ROUND_2));
    await expect.poll(() => shown(view)).toEqual(await expected(repos, ROUND_1, ROUND_2));
    expect(view.textContent).not.toContain('비교할 수 없어요');

    const three = await importRound(repos, 3);
    await expect.poll(() => shown(view)).toEqual(await expected(repos, ROUND_2, three));
  });

  it('차수 선택 · 주소 이동 · 뒤로 가기는 저장된 데이터(차수 · 결과 · TC · revision)를 바꾸지 않는다', async () => {
    const { repos, store, view } = await mount('?view=compare');
    const three = await importRound(repos, 3);
    await expect.poll(() => shown(view).target).toBe(three);
    const before = store.inspect();
    const status = repos.persistence.getStatus();

    await userEvent.selectOptions(select('기준 차수'), ROUND_1);
    await expect.poll(() => shown(view).base).toBe(ROUND_1);
    await navigate(compareUrl(three, ROUND_2));
    await expect.poll(() => shown(view).base).toBe(three);
    history.back();
    await expect.poll(() => shown(view).base).toBe(ROUND_1);

    expect(store.inspect()).toEqual(before);
    expect(repos.persistence.getStatus()).toBe(status);
  });
});
