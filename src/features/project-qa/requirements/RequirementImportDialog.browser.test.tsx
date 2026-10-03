import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createBrowserRouter, Outlet, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { page, userEvent } from 'vitest/browser';
import '@/styles/tokens.css';
import '@/styles/base.css';
import type { AppData } from '@/data/local/appData';
import { createLocalRepositories } from '@/data/local/localRepositories';
import { createMemoryStateStore } from '@/data/local/stateStore';
import { createSeed, PROJECT_A, PROJECT_B } from '@/data/mock/seed';
import type { Repositories } from '@/data/repositories/types';
import { ProjectRecordsTab } from '../records/ProjectRecordsTab';
import { RequirementsTab } from './RequirementsTab';

/*
 * 요구사항 가져오기를 실제 브라우저(Chromium) · 저장소와 함께 확인한다. 요구사항 화면에서 시작해
 * 파일(CSV · XLSX) → 산출물 선택 → 열 매핑 → 미리보기(중복 · 오류 · 제외) → 가져오기 → 목록 · 기록 표시까지, 그리고 390px 가로 넘침.
 */

const holder = vi.hoisted(() => ({ repos: undefined as Repositories | undefined }));
vi.mock('@/data', () => ({ repositories: new Proxy({}, { get: (_target, key) => holder.repos?.[key as keyof Repositories] }) }));

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let router: ReturnType<typeof createBrowserRouter> | undefined;
const originalUrl = `${location.pathname}${location.search}`;
const requirementsPath = `/projects/${PROJECT_A}/requirements`;
const DELIVERABLE = 'dlv-plan-pdf-v15';

async function unmount() {
  await act(async () => root?.unmount());
  router?.dispose();
  container?.remove();
  root = container = router = undefined;
}

/** 요구사항 화면을 띄운다. withExisting이 false면 이 프로젝트의 요구사항이 없는 빈 상태로 시작한다. */
async function mount({ withExisting = false }: { withExisting?: boolean } = {}) {
  await unmount();
  const repos = createLocalRepositories({
    openStore: async () => createMemoryStateStore(),
    createInitialData: (): AppData => {
      const data = createSeed();
      if (!withExisting) data.requirements = data.requirements.filter((item) => item.projectId !== PROJECT_A);
      return data;
    },
  });
  await repos.persistence.load();
  holder.repos = repos;
  const project = (await repos.projects.get(PROJECT_A))!;
  history.replaceState(null, '', requirementsPath);
  router = createBrowserRouter([
    {
      element: <Outlet context={{ project, openDeliverableCreate: () => {} }} />,
      children: [
        { path: requirementsPath, element: <RequirementsTab /> },
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
const button = (name: string | RegExp) => page.getByRole('button', { name });
const enabled = (name: string | RegExp) => expect.poll(() => (button(name).element() as HTMLButtonElement).disabled).toBe(false);
const tableRows = () => [...(dialog()?.querySelectorAll('tbody tr') ?? [])];
const cells = (row: Element) => [...row.querySelectorAll('td')].map((cell) => cell.textContent?.trim());
const count = (label: string) => [...(dialog()?.querySelectorAll('dl[aria-label="판정별 행 수"] > div') ?? [])].find((item) => item.querySelector('dt')?.textContent === label)?.querySelector('dd')?.textContent;

/** 완료 안내의 닫기(머리글의 닫기 버튼과 이름이 같아 푸터 버튼을 고른다) */
const closeDone = () => userEvent.click(dialog()!.querySelector('footer button')!);

const CSV = [
  '기능명,요구사항,페이지/위치,확인 필요',
  '소셜 로그인,카카오 계정으로 로그인할 수 있다.,p.21,N',
  '소셜 로그인,애플 계정으로 로그인할 수 있다.,,필요',
  '소셜 로그인,,p.23,N',
  '소셜 로그인,네이버 계정으로 로그인할 수 있다.,p.24,아마도',
  '소셜 로그인,카카오 계정으로 로그인할 수 있다.,p.25,N',
  '결제,카드로 결제할 수 있다.,p.30,Y',
].join('\n');

const csvFile = (text = CSV, name = '요구사항.csv') => new File([text], name, { type: 'text/csv' });

/** 파일 단계: 파일을 올리고 산출물을 고른 뒤 열 매핑 단계로 간다. */
async function chooseFileAndDeliverable(file: File) {
  await userEvent.upload(page.getByLabelText('요구사항 파일'), file);
  await expect.poll(() => dialog()?.textContent).toContain(file.name);
  await userEvent.selectOptions(page.getByRole('combobox', { name: '연결할 산출물' }), DELIVERABLE);
}

describe('요구사항 가져오기: CSV 전체 흐름', () => {
  it('빈 상태에서 시작해 산출물 · 열 매핑 · 미리보기(중복 · 오류) · 제외를 거쳐 가져오면 목록 · 근거 · 확인 필요 · 기록에 나온다', async () => {
    const { view, repos } = await mount();
    expect(view.textContent).toContain('요구사항 파일(CSV · XLSX)을 가져오거나');
    expect(view.textContent).toContain('AI 분석은 아직 연결되지 않았어요');
    await userEvent.click(button('요구사항 가져오기'));
    await expect.poll(() => dialog()).not.toBeNull();

    // 산출물을 고르기 전에는 다음으로 갈 수 없다.
    await userEvent.upload(page.getByLabelText('요구사항 파일'), csvFile());
    await expect.poll(() => dialog()?.textContent).toContain('요구사항.csv');
    expect((button('다음: 열 매핑').element() as HTMLButtonElement).disabled).toBe(true);
    await userEvent.selectOptions(page.getByRole('combobox', { name: '연결할 산출물' }), DELIVERABLE);
    await enabled('다음: 열 매핑');
    await userEvent.click(button('다음: 열 매핑'));

    // 열 매핑: 이름이 분명한 열은 미리 연결돼 있다.
    await expect.poll(() => dialog()?.textContent).toContain('파일 열을 Looma 필드에 연결하세요');
    const selects = [...dialog()!.querySelectorAll('select')].filter((select) => select.closest('[class*="mappingGrid"]'));
    expect(selects.map((select) => select.value)).toEqual(['feature', 'text', 'locator', 'needsConfirmation']);
    await enabled('다음: 미리보기');
    await userEvent.click(button('다음: 미리보기'));

    // 미리보기: 신규 3 · 중복 1(파일 안) · 오류 2
    await expect.poll(() => tableRows().length).toBe(6);
    expect(['전체 행', '신규', '중복', '오류', '제외'].map(count)).toEqual(['6', '3', '1', '2', '0']);
    expect(cells(tableRows()[0]).slice(0, 5)).toEqual(['2', '소셜 로그인', '카카오 계정으로 로그인할 수 있다.', 'p.21', '아님']);
    // 위치가 비어 있으면 행 번호로 보여준다.
    expect(cells(tableRows()[1])[3]).toBe('요구사항 파일 3행');
    expect(cells(tableRows()[1])[4]).toBe('필요');
    expect(tableRows()[2].textContent).toContain('오류 · 요구사항이 비어 있어요.');
    expect(tableRows()[3].textContent).toContain('오류 · 확인 필요 값을 해석할 수 없어요. (아마도)');
    expect(tableRows()[4].textContent).toContain('확인 · 파일의 2행과 같은 요구사항이에요.');
    // 중복 · 오류 행은 제외할 수 없다(가져오지 않는다).
    expect(tableRows()[2].querySelector('input[type="checkbox"]')).toBeNull();
    expect(tableRows()[4].querySelector('input[type="checkbox"]')).toBeNull();

    // 신규 행 하나를 제외한다.
    await userEvent.click(page.getByRole('checkbox', { name: '7행 제외' }));
    await expect.poll(() => count('제외')).toBe('1');
    expect(['신규', '중복', '오류'].map(count)).toEqual(['2', '1', '2']);
    expect(dialog()!.textContent).toContain('새 요구사항 2건을 가져올 예정이에요.');
    // 아직 아무것도 저장하지 않았다.
    expect((await repos.requirements.listByProject(PROJECT_A)).length).toBe(0);

    await userEvent.click(button('가져오기'));
    await expect.poll(() => dialog()?.textContent).toContain('요구사항 2건을 가져왔어요.');
    expect(dialog()!.textContent).toContain('신규 2 · 중복 1 · 오류 2 · 제외 1');
    // 목록이 비어 있음 → 있음으로 바뀌어도 완료 안내가 유지된다.
    expect(view.textContent).toContain('소셜 로그인');
    await closeDone();
    await expect.poll(() => dialog()).toBeNull();

    // 저장된 요구사항
    const saved = await repos.requirements.listByProject(PROJECT_A);
    expect(saved).toHaveLength(2);
    expect(saved.map((item) => [item.feature, item.text, item.needsConfirmation, item.sourceRefs[0].deliverableId, item.sourceRefs[0].locator, item.status, item.lifecycle, item.sourceType])).toEqual([
      ['소셜 로그인', '카카오 계정으로 로그인할 수 있다.', false, DELIVERABLE, 'p.21', 'draft', 'active', 'source_explicit'],
      ['소셜 로그인', '애플 계정으로 로그인할 수 있다.', true, DELIVERABLE, '요구사항 파일 3행', 'draft', 'active', 'source_explicit'],
    ]);

    // 요구사항 화면: 기능 · 근거 위치 · 확인 필요
    expect(view.textContent).toContain('기능 1 · 확인 필요 1');
    expect(view.textContent).toContain('근거 · 기획서 p.21');
    expect(view.textContent).toContain('근거 · 기획서 요구사항 파일 3행');
    const asideConfirm = view.querySelector('aside')!;
    expect(asideConfirm.textContent).toContain('애플 계정으로 로그인할 수 있다.');
    expect(asideConfirm.textContent).not.toContain('카카오 계정으로 로그인할 수 있다.');

    // 기록
    await act(async () => router!.navigate(`/projects/${PROJECT_A}/records`));
    await expect.poll(() => view.textContent).toContain('요구사항.csv 요구사항 2건 가져오기');
    expect(view.textContent).toContain('신규 2 · 중복 1 · 오류 2 · 제외 1');
    expect(view.querySelector('a[href$="/requirements"]')?.textContent).toBe('요구사항.csv 요구사항 2건 가져오기');
  });

  it('이미 요구사항이 있는 프로젝트에서도 가져올 수 있고, 같은 기능 · 같은 내용은 중복이라 가져오지 않으며 기존 요구사항은 그대로다', async () => {
    const { view, repos } = await mount({ withExisting: true });
    const before = await repos.requirements.listByProject(PROJECT_A);
    const existing = before[0];
    await userEvent.click(button('요구사항 가져오기'));
    await expect.poll(() => dialog()).not.toBeNull();
    await chooseFileAndDeliverable(csvFile(`기능,요구사항\n${existing.feature},${existing.text.includes(',') ? `"${existing.text}"` : existing.text}\n새 기능,새 요구사항 문장`, '추가.csv'));
    await enabled('다음: 열 매핑');
    await userEvent.click(button('다음: 열 매핑'));
    await enabled('다음: 미리보기');
    // 출처 위치 · 확인 필요를 연결하지 않았다는 안내
    expect(dialog()!.textContent).toContain('근거 위치는 원본 행 번호');
    await userEvent.click(button('다음: 미리보기'));
    await expect.poll(() => tableRows().length).toBe(2);
    expect(['신규', '중복'].map(count)).toEqual(['1', '1']);
    expect(tableRows()[0].textContent).toContain('이미 있는 요구사항이에요.');
    await userEvent.click(button('가져오기'));
    await expect.poll(() => dialog()?.textContent).toContain('요구사항 1건을 가져왔어요.');
    await closeDone();
    const after = await repos.requirements.listByProject(PROJECT_A);
    expect(after).toEqual([...before, expect.objectContaining({ feature: '새 기능', text: '새 요구사항 문장', needsConfirmation: false, sourceRefs: [{ deliverableId: DELIVERABLE, locator: '요구사항 파일 3행' }] })]);
    await expect.poll(() => view.textContent).toContain('새 기능');
  });

  it('필수 열을 연결하지 않으면 미리보기로 갈 수 없고, 연결하면 갈 수 있다', async () => {
    await mount();
    await userEvent.click(button('요구사항 가져오기'));
    await chooseFileAndDeliverable(csvFile('항목,설명\n로그인,로그인한다.', '다른헤더.csv'));
    await enabled('다음: 열 매핑');
    await userEvent.click(button('다음: 열 매핑'));
    await expect.poll(() => dialog()?.textContent).toContain("'기능' 열을 연결해 주세요.");
    expect((button('다음: 미리보기').element() as HTMLButtonElement).disabled).toBe(true);
    const [first, second] = [...dialog()!.querySelectorAll('select')].filter((select) => select.closest('[class*="mappingGrid"]'));
    await userEvent.selectOptions(first, 'feature');
    await userEvent.selectOptions(second, 'text');
    await enabled('다음: 미리보기');
  });

  it('가져올 신규 행이 없으면(모두 중복 · 오류 · 제외) 가져오기를 누를 수 없다', async () => {
    const { repos } = await mount();
    await userEvent.click(button('요구사항 가져오기'));
    await chooseFileAndDeliverable(csvFile('기능,요구사항\n로그인,\n,로그인한다.', '오류만.csv'));
    await enabled('다음: 열 매핑');
    await userEvent.click(button('다음: 열 매핑'));
    await enabled('다음: 미리보기');
    await userEvent.click(button('다음: 미리보기'));
    await expect.poll(() => tableRows().length).toBe(2);
    expect(dialog()!.textContent).toContain('가져올 수 있는 새 요구사항이 없어요.');
    expect((button('가져오기').element() as HTMLButtonElement).disabled).toBe(true);
    expect(await repos.requirements.listByProject(PROJECT_A)).toEqual([]);
  });
});

describe('요구사항 가져오기: 원본 행 번호 · 미리보기 중 변경', () => {
  it('따옴표 안 줄바꿈이 있는 CSV는 미리보기 · 저장 모두 원본 줄 번호를 쓴다', async () => {
    const { repos } = await mount();
    await userEvent.click(button('요구사항 가져오기'));
    // 1 헤더 / 2~3 로그인 / 4 결제
    await chooseFileAndDeliverable(csvFile('기능,요구사항\n로그인,"이메일로\n로그인한다."\n결제,카드로 결제한다.\n', '줄바꿈.csv'));
    await enabled('다음: 열 매핑');
    await userEvent.click(button('다음: 열 매핑'));
    await enabled('다음: 미리보기');
    await userEvent.click(button('다음: 미리보기'));
    await expect.poll(() => tableRows().length).toBe(2);
    expect(tableRows().map((row) => cells(row)[0])).toEqual(['2', '4']);
    expect(cells(tableRows()[1])[3]).toBe('요구사항 파일 4행');
    await userEvent.click(button('가져오기'));
    await expect.poll(() => dialog()?.textContent).toContain('요구사항 2건을 가져왔어요.');
    expect((await repos.requirements.listByProject(PROJECT_A)).map((item) => item.sourceRefs[0].locator)).toEqual(['요구사항 파일 2행', '요구사항 파일 4행']);
  });

  it('미리보기에서 제외한 행이 그 사이 다른 경로로 생긴 요구사항과 같아져도 오류 없이 나머지를 가져온다', async () => {
    const { repos } = await mount();
    await userEvent.click(button('요구사항 가져오기'));
    await chooseFileAndDeliverable(csvFile('기능,요구사항\n로그인,로그인한다.\n로그인,로그아웃한다.\n결제,결제한다.\n', '변경.csv'));
    await enabled('다음: 열 매핑');
    await userEvent.click(button('다음: 열 매핑'));
    await enabled('다음: 미리보기');
    await userEvent.click(button('다음: 미리보기'));
    await expect.poll(() => tableRows().length).toBe(3);
    await userEvent.click(page.getByRole('checkbox', { name: '2행 제외' }));
    await expect.poll(() => count('제외')).toBe('1');

    // 미리보기를 보는 동안 제외한 행(로그인한다.)과 같은 요구사항이 다른 경로로 생긴다.
    await repos.requirements.importFromTable({
      projectId: PROJECT_A,
      deliverableId: DELIVERABLE,
      fileName: '다른 경로.csv',
      table: { headers: ['기능', '요구사항'], rows: [{ rowNumber: 2, cells: ['로그인', '로그인한다.'] }] },
      mapping: ['feature', 'text'],
      excludedRows: [],
    });
    // 화면이 다시 판정해 2행은 중복이 되고, 사라진 제외는 넘기지 않는다.
    await expect.poll(() => tableRows()[0].textContent).toContain('이미 있는 요구사항이에요.');
    expect(['신규', '중복', '제외'].map(count)).toEqual(['2', '1', '0']);
    await userEvent.click(button('가져오기'));
    await expect.poll(() => dialog()?.textContent).toContain('요구사항 2건을 가져왔어요.');
    expect(dialog()!.textContent).not.toContain('제외할 수 있는 요구사항 행이 아니에요');
    expect((await repos.requirements.listByProject(PROJECT_A)).map((item) => item.text)).toEqual(['로그인한다.', '로그아웃한다.', '결제한다.']);
  });
});

describe('요구사항 가져오기: XLSX', () => {
  it('시트가 여러 개인 파일은 시트를 골라야 다음으로 가고, 고른 시트의 표로 가져온다', async () => {
    const { view, repos } = await mount();
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['문서', '요구사항 정의서'], ['버전', '1.0']]), '표지');
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ['기능', '요구사항', '출처', '확인 필요'],
        ['검색', '키워드로 검색할 수 있다.', 'p.5', 'false'],
        ['검색', '최근 검색어를 보여준다.', 'p.6', 'yes'],
      ]),
      '요구사항',
    );
    const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    await userEvent.click(button('요구사항 가져오기'));
    await userEvent.upload(page.getByLabelText('요구사항 파일'), new File([bytes], '정의서.xlsx'));
    await expect.poll(() => dialog()?.textContent).toContain('시트가 여러 개예요');
    await userEvent.selectOptions(page.getByRole('combobox', { name: '연결할 산출물' }), DELIVERABLE);
    expect((button('다음: 열 매핑').element() as HTMLButtonElement).disabled).toBe(true);
    await userEvent.selectOptions(page.getByRole('combobox', { name: '시트' }), '요구사항');
    await enabled('다음: 열 매핑');
    await userEvent.click(button('다음: 열 매핑'));
    await enabled('다음: 미리보기');
    await userEvent.click(button('다음: 미리보기'));
    await expect.poll(() => tableRows().length).toBe(2);
    expect(cells(tableRows()[1]).slice(0, 5)).toEqual(['3', '검색', '최근 검색어를 보여준다.', 'p.6', '필요']);
    await userEvent.click(button('가져오기'));
    await expect.poll(() => dialog()?.textContent).toContain('요구사항 2건을 가져왔어요.');
    await closeDone();
    expect((await repos.requirements.listByProject(PROJECT_A)).map((item) => [item.text, item.needsConfirmation, item.sourceRefs[0].locator])).toEqual([
      ['키워드로 검색할 수 있다.', false, 'p.5'],
      ['최근 검색어를 보여준다.', true, 'p.6'],
    ]);
    await expect.poll(() => view.textContent).toContain('근거 · 기획서 p.5');
    // 다른 프로젝트의 요구사항은 건드리지 않는다.
    expect(await repos.requirements.listByProject(PROJECT_B)).toEqual(createSeed().requirements.filter((item) => item.projectId === PROJECT_B));
  });
});

describe('요구사항 가져오기: 390px', () => {
  it('열 매핑 · 긴 요구사항이 있는 미리보기에서도 페이지 · 대화상자가 가로로 넘치지 않는다', async () => {
    await page.viewport(390, 844);
    await mount();
    await userEvent.click(button('요구사항 가져오기'));
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    const long = `아주 긴 요구사항 문장입니다 ${'가나다라마바사 '.repeat(40)}`;
    const longFeature = `매우긴기능이름${'ABCDEFGHIJ'.repeat(12)}`;
    await chooseFileAndDeliverable(csvFile(`기능명,요구사항,페이지/위치,확인 필요\n${longFeature},${long},${'p.'.repeat(60)},Y\n결제,카드 결제,p.2,N`, '긴내용.csv'));
    await enabled('다음: 열 매핑');
    await userEvent.click(button('다음: 열 매핑'));
    await enabled('다음: 미리보기');
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    await userEvent.click(button('다음: 미리보기'));
    await expect.poll(() => tableRows().length).toBe(2);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    // 표만 안쪽 영역에서 가로로 스크롤되고 대화상자 자체는 넘치지 않는다.
    const box = dialog()!;
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
    const scroller = dialog()!.querySelector('[role="region"]') as HTMLElement;
    expect(scroller.getBoundingClientRect().right).toBeLessThanOrEqual(390);
  });
});
