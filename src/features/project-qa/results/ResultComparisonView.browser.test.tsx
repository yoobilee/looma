import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '@/styles/tokens.css';
import '@/styles/base.css';
import type { TestCase, TestResult, TestResultImport, TestResultValue } from '@/domain/types';
import { ResultComparisonView, type ResultComparisonViewProps } from './ResultComparisonView';

/*
 * 수행 결과 비교 화면을 실제 브라우저(Chromium)에서 그려 확인한다.
 * - 기준 · 비교 차수 선택(같은 차수는 고를 수 없음), 필터 건수와 목록 일치, 빈 상태, 390px 가로 넘침, 키보드 · 레이블
 */

const round = (id: string, number: number, executionType: TestResultImport['executionType'] = 'full'): TestResultImport => ({
  id,
  projectId: 'p',
  round: number,
  fileRef: `${number}차.xlsx`,
  importedAt: `2026-10-0${number}T09:00:00.000Z`,
  mapping: [],
  executionType,
  executedFrom: `2026-10-0${number}`,
});

const testCase = (id: string, overrides: Partial<TestCase> = {}): TestCase => ({
  id,
  projectId: 'p',
  externalId: `SIGN-${id.slice(3).padStart(3, '0')}`,
  category: 'normal_flow',
  feature: '회원가입',
  depth: ['회원가입'],
  title: `회원가입 항목 ${id}`,
  steps: [],
  expectedResult: '완료',
  requirementIds: [],
  testConditionIds: [],
  sourceRefs: [],
  generationType: 'source_explicit',
  origin: 'manual',
  status: 'reviewed',
  revision: 1,
  createdAt: 'now',
  updatedAt: 'now',
  ...overrides,
});

let sequence = 0;
const result = (importId: string, testCaseId: string, value: TestResultValue): TestResult => ({ id: `r-${(sequence += 1)}`, importId, testCaseId, feature: '회원가입', title: testCaseId, platform: 'android', result: value });

const IMPORTS = [round('imp-1', 1), round('imp-2', 2), round('imp-3', 3, 'retest')];
const TEST_CASES = [
  testCase('tc-1'),
  testCase('tc-2', { externalId: undefined, title: '고객사 TC ID가 없는 아주 긴 테스트 항목 이름이라 좁은 화면에서 줄바꿈되어야 하는 TC입니다 '.repeat(2) }),
  testCase('tc-3', { status: 'deprecated' }),
  testCase('tc-4'),
  testCase('tc-5'),
  testCase('tc-6'),
  testCase('tc-7'),
  testCase('tc-8'),
];
// 2차 → 3차(재수행): 신규 실패 2 · 계속 실패 1 · 수정됨 1 · 신규 차단 1 · 범위 제외 1 · 범위 추가 1(FAIL) · 변화 없음 1
const RESULTS: Record<string, TestResult[]> = {
  'imp-1': [result('imp-1', 'tc-1', 'pass'), result('imp-1', 'tc-2', 'pass')],
  'imp-2': [
    result('imp-2', 'tc-1', 'pass'),
    result('imp-2', 'tc-2', 'blocked'),
    result('imp-2', 'tc-3', 'fail'),
    result('imp-2', 'tc-4', 'fail'),
    result('imp-2', 'tc-5', 'pass'),
    result('imp-2', 'tc-6', 'pass'),
    result('imp-2', 'tc-8', 'pass'),
  ],
  'imp-3': [
    result('imp-3', 'tc-1', 'fail'),
    result('imp-3', 'tc-2', 'fail'),
    result('imp-3', 'tc-3', 'fail'),
    result('imp-3', 'tc-4', 'pass'),
    result('imp-3', 'tc-5', 'blocked'),
    result('imp-3', 'tc-7', 'fail'),
    result('imp-3', 'tc-8', 'pass'),
  ],
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

/** 결과 화면이 주소에 하듯 고른 차수를 들고 다시 넘긴다. */
function Harness({ onSelectionChange, ...props }: Partial<ResultComparisonViewProps>) {
  const [pair, setPair] = useState<{ previousId: string; currentId: string }>();
  return (
    <ResultComparisonView
      imports={IMPORTS}
      resultsByImport={RESULTS}
      testCases={TEST_CASES}
      previousId={pair?.previousId}
      currentId={pair?.currentId}
      onSelectionChange={(previousId, currentId) => {
        setPair({ previousId, currentId });
        onSelectionChange?.(previousId, currentId);
      }}
      {...props}
    />
  );
}

async function render(props: Partial<ResultComparisonViewProps> = {}) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<Harness {...props} />));
  return container;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  await page.viewport(1280, 900);
});

const select = (label: string) => page.getByLabelText(label, { exact: true }).element() as HTMLSelectElement;
const rowCount = (element: HTMLElement) => element.querySelectorAll('tbody tr').length;
const changeLabels = (element: HTMLElement) => [...element.querySelectorAll('tbody tr td:last-child')].map((cell) => cell.textContent);
const filterButton = (label: string) => page.getByRole('button', { name: new RegExp(`^${label} ?\\d+$`) });

describe('수행 결과 비교 화면', () => {
  it('기본은 차수 번호가 가장 큰 두 차수(2차 → 3차)이고, 바뀐 항목을 QA가 먼저 볼 순서로 보여 준다', async () => {
    const view = await render();
    expect(select('기준 차수').value).toBe('imp-2');
    expect(select('비교 차수').value).toBe('imp-3');
    expect(view.textContent).toContain('2차 → 3차 결과를 TC · 플랫폼별로 비교해요.');
    expect(changeLabels(view)).toEqual(['신규 실패', '신규 실패', '계속 실패', '신규 차단', '수정됨', '범위 추가', '범위 제외']);
    // 결과 없음은 미수행과 다른 표시다.
    expect(view.textContent).toContain('결과 없음');
    // 범위 추가 중 FAIL을 요약에서 따로 알린다.
    expect(view.textContent).toContain('그중 FAIL 1');
    // 폐기된 TC의 결과도 숨기지 않는다.
    expect(view.querySelector('tbody')!.textContent).toContain('폐기');
    // 재수행이 섞인 비교는 범위 변화 안내를 보여 준다.
    expect(view.textContent).toContain("'범위 추가' · '범위 제외'로 보여요");
  });

  it('기준 · 비교 차수를 고르면 바로 다시 비교하고, 같은 차수는 양쪽에서 고를 수 없다', async () => {
    const selections: string[] = [];
    const view = await render({ onSelectionChange: (previous, current) => selections.push(`${previous}>${current}`) });
    const base = select('기준 차수');
    const target = select('비교 차수');
    expect([...base.options].find((option) => option.value === 'imp-3')!.disabled).toBe(true);
    expect([...target.options].find((option) => option.value === 'imp-2')!.disabled).toBe(true);

    await userEvent.selectOptions(base, 'imp-1');
    expect(selections).toEqual(['imp-1>imp-3']);
    expect(view.textContent).toContain('1차 → 3차');
    // 1차에는 tc-1 · tc-2만 있다: 둘 다 신규 실패, 나머지는 범위 추가
    expect(changeLabels(view)).toEqual(['신규 실패', '신규 실패', '범위 추가', '범위 추가', '범위 추가', '범위 추가', '범위 추가']);
  });

  it('필터마다 건수와 목록 행 수가 같다', async () => {
    const view = await render();
    const expected: [string, number][] = [
      ['전체', 7],
      ['신규 실패', 2],
      ['계속 실패', 1],
      ['수정됨', 1],
      ['차단 변화', 1],
      ['범위 변화', 2],
    ];
    for (const [label, count] of expected) {
      const button = filterButton(label);
      expect(button.element().textContent).toBe(`${label}${count}`);
      await userEvent.click(button);
      expect(button.element().getAttribute('aria-pressed')).toBe('true');
      expect(rowCount(view), label).toBe(count);
    }
  });

  it('변화 없음은 기본으로 접고, 켜면 전체에 함께 보여 준다', async () => {
    const view = await render();
    expect(rowCount(view)).toBe(7);
    await userEvent.click(page.getByLabelText('변화 없음 포함'));
    expect(rowCount(view)).toBe(8);
    expect(filterButton('전체').element().textContent).toBe('전체8');
  });

  it('빈 상태: 바뀐 결과가 없을 때 · 필터에 항목이 없을 때 · TC에 연결된 결과가 없는 차수 · 차수가 하나뿐일 때', async () => {
    const same = { 'imp-1': [result('imp-1', 'tc-1', 'pass')], 'imp-2': [result('imp-2', 'tc-1', 'pass')] };
    let view = await render({ imports: IMPORTS.slice(0, 2), resultsByImport: same });
    expect(view.textContent).toContain('두 차수 사이에 바뀐 결과가 없어요.');
    expect(view.textContent).toContain("변화 없음 1건은 '변화 없음 포함'을 켜면 볼 수 있어요.");
    await userEvent.click(filterButton('신규 실패'));
    expect(view.textContent).toContain('신규 실패 항목이 없어요.');
    await act(async () => root!.unmount());
    container!.remove();

    const unlinked = { 'imp-1': [result('imp-1', 'tc-1', 'pass')], 'imp-2': [{ ...result('imp-2', 'tc-1', 'pass'), testCaseId: undefined }] };
    view = await render({ imports: IMPORTS.slice(0, 2), resultsByImport: unlinked });
    expect(view.textContent).toContain('이 두 차수는 비교할 수 없어요.');
    expect(view.textContent).toContain('2차에 TC와 연결된 결과가 없어요.');
    await act(async () => root!.unmount());
    container!.remove();

    view = await render({ imports: IMPORTS.slice(0, 1) });
    expect(view.textContent).toContain('비교할 수행 차수가 부족해요.');
  });

  it('390px에서 가로로 넘치지 않고(48자 고객사 TC ID 포함), 표는 행마다 카드로 쌓인다', async () => {
    await page.viewport(390, 844);
    const longId = `CLIENT-A-${'0'.repeat(39)}`;
    expect(longId).toHaveLength(48);
    const view = await render({ testCases: TEST_CASES.map((item) => (item.id === 'tc-1' ? { ...item, externalId: longId } : item)) });
    expect(view.querySelector('tbody')!.textContent).toContain(longId);
    await userEvent.click(page.getByLabelText('변화 없음 포함'));
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    expect(view.scrollWidth).toBeLessThanOrEqual(view.clientWidth);
    const firstRow = view.querySelector('tbody tr')!;
    expect(getComputedStyle(firstRow).display).toBe('block');
    for (const cell of view.querySelectorAll('tbody td')) expect(cell.getBoundingClientRect().right).toBeLessThanOrEqual(390.5);
  });

  it('키보드로 차수를 고를 수 있고 모든 입력에 레이블이 있다', async () => {
    const view = await render();
    for (const element of view.querySelectorAll('select, input')) {
      const id = element.getAttribute('id');
      expect(id && view.querySelector(`label[for="${id}"]`), element.outerHTML).toBeTruthy();
    }
    select('기준 차수').focus();
    expect(document.activeElement).toBe(select('기준 차수'));
    await userEvent.keyboard('{Tab}');
    expect(document.activeElement).toBe(select('비교 차수'));
    // 키보드로 기준 차수를 1차로 바꾼다(선택 목록에서 위로 이동).
    select('기준 차수').focus();
    await userEvent.keyboard('{ArrowUp}');
    expect(select('기준 차수').value).toBe('imp-1');
    expect(view.textContent).toContain('1차 → 3차');
  });
});
