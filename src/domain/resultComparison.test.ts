import { describe, expect, it } from 'vitest';
import { classifyResultChange, compareResultRounds, defaultComparisonRounds, resultChangeTypes, type ResultComparison } from './resultComparison';
import type { Platform, TestCase, TestResult, TestResultValue } from './types';

const PREV = { id: 'imp-1', round: 1 };
const CURR = { id: 'imp-2', round: 2 };

let sequence = 0;
const result = (importId: string, testCaseId: string | undefined, value: TestResultValue, overrides: Partial<TestResult> = {}): TestResult => ({
  id: `res-${(sequence += 1)}`,
  importId,
  ...(testCaseId && { testCaseId }),
  externalId: testCaseId ? `EXT-${testCaseId}` : undefined,
  feature: '로그인',
  title: `제목 ${testCaseId ?? ''}`,
  result: value,
  ...overrides,
});

function ready(comparison: ResultComparison) {
  if (!comparison.ok) throw new Error(`비교할 수 없어요: ${comparison.reason}`);
  return comparison;
}
/** testCaseId(· 플랫폼) → [이전, 이번, 변화 유형] */
const table = (comparison: ResultComparison) =>
  Object.fromEntries(ready(comparison).rows.map((row) => [`${row.testCaseId}${row.platform ? `/${row.platform}` : ''}`, [row.previousStatus, row.currentStatus, row.changeType]]));

describe('변화 유형 판정', () => {
  const cases: [TestResultValue | null, TestResultValue | null, string][] = [
    ['pass', 'fail', 'newly_failed'],
    ['fail', 'fail', 'still_failed'],
    ['fail', 'pass', 'fixed'],
    ['pass', 'pass', 'unchanged_pass'],
    ['blocked', 'pass', 'unblocked'],
    ['pass', 'blocked', 'newly_blocked'],
    ['not_tested', 'fail', 'newly_failed'],
    ['fail', 'not_tested', 'newly_not_tested'],
    ['blocked', 'fail', 'newly_failed'],
    ['not_tested', 'blocked', 'newly_blocked'],
    ['fail', 'blocked', 'newly_blocked'],
    ['blocked', 'not_tested', 'newly_not_tested'],
    ['not_tested', 'pass', 'resumed'],
    ['blocked', 'blocked', 'unchanged_blocked'],
    ['not_tested', 'not_tested', 'unchanged_not_tested'],
    [null, 'fail', 'added_to_scope'],
    [null, 'not_tested', 'added_to_scope'],
    ['pass', null, 'removed_from_scope'],
    ['not_tested', null, 'removed_from_scope'],
  ];
  for (const [previous, current, expected] of cases) {
    it(`${previous ?? '결과 없음'} → ${current ?? '결과 없음'} = ${expected}`, () => {
      expect(classifyResultChange(previous, current)).toBe(expected);
    });
  }

  it('모든 상태 조합(결과 없음 포함 24가지)이 정확히 한 유형으로 정해진다', () => {
    const values: (TestResultValue | null)[] = ['pass', 'fail', 'blocked', 'not_tested', null];
    for (const previous of values) {
      for (const current of values) {
        if (previous === null && current === null) expect(() => classifyResultChange(previous, current)).toThrow();
        else expect(resultChangeTypes).toContain(classifyResultChange(previous, current));
      }
    }
  });
});

describe('두 차수 비교', () => {
  it('상태가 있는 TC는 상태 변화로, 한쪽에만 있는 TC는 범위 추가 · 제외로 나타낸다', () => {
    const results = [
      result('imp-1', 'tc-a', 'pass'),
      result('imp-2', 'tc-a', 'fail'),
      result('imp-1', 'tc-b', 'fail'),
      result('imp-2', 'tc-b', 'fail'),
      result('imp-1', 'tc-c', 'fail'),
      result('imp-2', 'tc-c', 'pass'),
      result('imp-2', 'tc-new', 'fail'),
      result('imp-1', 'tc-gone', 'pass'),
    ];
    const comparison = ready(compareResultRounds(PREV, CURR, results));
    expect(table(comparison)).toEqual({
      'tc-a': ['pass', 'fail', 'newly_failed'],
      'tc-b': ['fail', 'fail', 'still_failed'],
      'tc-c': ['fail', 'pass', 'fixed'],
      'tc-new': [null, 'fail', 'added_to_scope'],
      'tc-gone': ['pass', null, 'removed_from_scope'],
    });
    expect(comparison.counts).toMatchObject({ newly_failed: 1, still_failed: 1, fixed: 1, added_to_scope: 1, removed_from_scope: 1, unchanged_pass: 0 });
  });

  it('결과 없음과 미수행을 합치지 않는다: 이번에 빠진 TC는 미수행이 아니라 범위 제외이고, 미수행 결과는 미수행으로 남는다', () => {
    const results = [result('imp-1', 'tc-a', 'pass'), result('imp-1', 'tc-b', 'pass'), result('imp-2', 'tc-b', 'not_tested'), result('imp-2', 'tc-c', 'not_tested')];
    expect(table(compareResultRounds(PREV, CURR, results))).toEqual({
      'tc-a': ['pass', null, 'removed_from_scope'],
      'tc-b': ['pass', 'not_tested', 'newly_not_tested'],
      'tc-c': [null, 'not_tested', 'added_to_scope'],
    });
  });

  it('고객사 TC ID가 없거나 차수마다 달라도 내부 TC ID로 같은 TC를 맞댄다', () => {
    const results = [
      result('imp-1', 'tc-a', 'fail', { externalId: undefined }),
      result('imp-2', 'tc-a', 'pass', { externalId: undefined }),
      result('imp-1', 'tc-b', 'pass', { externalId: 'OLD-001' }),
      result('imp-2', 'tc-b', 'fail', { externalId: 'NEW-001' }),
      // 고객사 TC ID가 같아도 내부 TC가 다르면 다른 TC다.
      result('imp-1', 'tc-c', 'pass', { externalId: 'SAME-1' }),
      result('imp-2', 'tc-d', 'pass', { externalId: 'SAME-1' }),
    ];
    expect(table(compareResultRounds(PREV, CURR, results))).toEqual({
      'tc-a': ['fail', 'pass', 'fixed'],
      'tc-b': ['pass', 'fail', 'newly_failed'],
      'tc-c': ['pass', null, 'removed_from_scope'],
      'tc-d': [null, 'pass', 'added_to_scope'],
    });
  });

  it('TC revision · 상태(폐기 포함)는 비교에 쓰지 않는다: 결과만으로 비교하므로 폐기된 TC의 과거 결과도 그대로 비교된다', () => {
    // 비교 함수는 TC 정의를 받지 않는다. 같은 내부 ID면 revision이 달라졌어도 같은 TC다.
    const deprecated: Pick<TestCase, 'id' | 'status' | 'revision'> = { id: 'tc-old', status: 'deprecated', revision: 3 };
    const results = [result('imp-1', deprecated.id, 'fail'), result('imp-2', deprecated.id, 'fail'), result('imp-1', 'tc-x', 'pass')];
    expect(table(compareResultRounds(PREV, CURR, results))['tc-old']).toEqual(['fail', 'fail', 'still_failed']);
  });

  it('플랫폼별 결과는 TC · 플랫폼 단위로 따로 비교한다', () => {
    const results = (['android', 'ios'] as Platform[]).flatMap((platform) => [result('imp-1', 'tc-a', 'pass', { platform }), result('imp-2', 'tc-a', platform === 'ios' ? 'fail' : 'pass', { platform })]);
    expect(table(compareResultRounds(PREV, CURR, results))).toEqual({
      'tc-a/android': ['pass', 'pass', 'unchanged_pass'],
      'tc-a/ios': ['pass', 'fail', 'newly_failed'],
    });
  });

  it('플랫폼 구성이 다르면 추측해서 맞대지 않는다(플랫폼 없는 결과와 Android 결과는 다른 단위)', () => {
    const results = [result('imp-1', 'tc-a', 'pass'), result('imp-2', 'tc-a', 'pass', { platform: 'android' })];
    const comparison = ready(compareResultRounds(PREV, CURR, results));
    expect(table(comparison)).toEqual({ 'tc-a': ['pass', null, 'removed_from_scope'], 'tc-a/android': [null, 'pass', 'added_to_scope'] });
    expect(comparison.previous.platforms).toEqual([null]);
    expect(comparison.current.platforms).toEqual(['android']);
  });

  it('같은 차수에 같은 TC · 플랫폼 결과가 여럿이면 하나를 고르지 않고 비교에서 빼서 알린다', () => {
    const duplicateA = result('imp-2', 'tc-a', 'pass');
    const duplicateB = result('imp-2', 'tc-a', 'fail');
    const results = [result('imp-1', 'tc-a', 'fail'), duplicateA, duplicateB, result('imp-1', 'tc-b', 'pass'), result('imp-2', 'tc-b', 'pass')];
    const comparison = ready(compareResultRounds(PREV, CURR, results));
    expect(table(comparison)).toEqual({ 'tc-b': ['pass', 'pass', 'unchanged_pass'] });
    expect(comparison.ambiguous).toEqual([{ importId: 'imp-2', testCaseId: 'tc-a', resultIds: [duplicateA.id, duplicateB.id] }]);
  });

  it('TC에 연결되지 않은 결과는 비교하지 않고 건수만 센다', () => {
    const results = [result('imp-1', 'tc-a', 'pass'), result('imp-1', undefined, 'fail'), result('imp-2', 'tc-a', 'pass'), result('imp-2', undefined, 'fail'), result('imp-2', undefined, 'pass')];
    const comparison = ready(compareResultRounds(PREV, CURR, results));
    expect(comparison.rows).toHaveLength(1);
    expect([comparison.previous.unlinked, comparison.current.unlinked, comparison.previous.linked, comparison.current.linked]).toEqual([1, 2, 1, 1]);
  });

  it('같은 차수끼리 · TC에 연결된 결과가 없는 차수는 비교하지 않는다', () => {
    expect(compareResultRounds(PREV, PREV, [result('imp-1', 'tc-a', 'pass')])).toEqual({ ok: false, reason: 'same_round' });
    const empty = compareResultRounds(PREV, CURR, [result('imp-1', 'tc-a', 'pass'), result('imp-2', undefined, 'pass')]);
    expect(empty).toMatchObject({ ok: false, reason: 'no_linked_results', current: { linked: 0, unlinked: 1 } });
  });

  it('비교 방향이 기준 → 비교다', () => {
    const results = [result('imp-1', 'tc-a', 'fail'), result('imp-2', 'tc-a', 'pass')];
    expect(table(compareResultRounds(PREV, CURR, results))['tc-a']).toEqual(['fail', 'pass', 'fixed']);
    expect(table(compareResultRounds(CURR, PREV, results))['tc-a']).toEqual(['pass', 'fail', 'newly_failed']);
  });

  it('입력 결과를 바꾸지 않는다', () => {
    const results = [result('imp-1', 'tc-a', 'fail'), result('imp-2', 'tc-a', 'pass'), result('imp-2', 'tc-a', 'fail')];
    const before = JSON.stringify(results);
    compareResultRounds(PREV, CURR, results);
    expect(JSON.stringify(results)).toBe(before);
  });

  it('수천 건도 TC · 플랫폼 키로 바로 비교한다', () => {
    const many: TestResult[] = [];
    for (let index = 0; index < 5000; index += 1) {
      for (const platform of ['android', 'ios'] as Platform[]) {
        many.push(result('imp-1', `tc-${index}`, 'pass', { platform }));
        many.push(result('imp-2', `tc-${index}`, index % 10 === 0 ? 'fail' : 'pass', { platform }));
      }
    }
    const started = performance.now();
    const comparison = ready(compareResultRounds(PREV, CURR, many));
    expect(performance.now() - started).toBeLessThan(500);
    expect(comparison.rows).toHaveLength(10000);
    expect(comparison.counts.newly_failed).toBe(1000);
  });
});

describe('기본 비교 차수', () => {
  it('차수 번호가 가장 큰 두 차수를 기준 → 비교로 고른다(목록 순서와 무관)', () => {
    const imports = [
      { id: 'c', round: 3 },
      { id: 'a', round: 1 },
      { id: 'b', round: 2 },
    ];
    expect(defaultComparisonRounds(imports)).toEqual({ previous: { id: 'b', round: 2 }, current: { id: 'c', round: 3 } });
    expect(defaultComparisonRounds([{ id: 'a', round: 1 }])).toBeUndefined();
  });
});
