import { describe, expect, it } from 'vitest';
import { resolveComparisonRounds } from './comparisonView';

const IMPORTS = [
  { id: 'r1', round: 1 },
  { id: 'r10', round: 10 },
  { id: 'r9', round: 9 },
];

describe('비교할 두 차수', () => {
  it('고른 차수(주소의 base · target)가 둘 다 있고 서로 다르면 그 차수다. 방향도 그대로다', () => {
    expect(resolveComparisonRounds(IMPORTS, 'r10', 'r1')).toEqual({ previous: { id: 'r10', round: 10 }, current: { id: 'r1', round: 1 } });
  });

  it('고른 차수가 없으면 차수 번호(숫자)가 가장 큰 두 차수다', () => {
    expect(resolveComparisonRounds(IMPORTS, null, null)).toEqual({ previous: { id: 'r9', round: 9 }, current: { id: 'r10', round: 10 } });
    expect(resolveComparisonRounds(IMPORTS, undefined, undefined)).toEqual({ previous: { id: 'r9', round: 9 }, current: { id: 'r10', round: 10 } });
  });

  it('지워졌거나 없는 차수 · 한쪽만 있는 차수 · 같은 차수는 가장 큰 두 차수로 돌아간다', () => {
    const fallback = { previous: { id: 'r9', round: 9 }, current: { id: 'r10', round: 10 } };
    expect(resolveComparisonRounds(IMPORTS, 'gone', 'r1')).toEqual(fallback);
    expect(resolveComparisonRounds(IMPORTS, 'r1', null)).toEqual(fallback);
    expect(resolveComparisonRounds(IMPORTS, 'r1', 'r1')).toEqual(fallback);
  });

  it('차수가 0 · 1개면 비교할 차수가 없다', () => {
    expect(resolveComparisonRounds([], 'r1', 'r10')).toBeUndefined();
    expect(resolveComparisonRounds([{ id: 'r1', round: 1 }], 'r1', 'r1')).toBeUndefined();
  });
});
