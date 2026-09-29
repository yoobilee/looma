import { describe, expect, it } from 'vitest';
import type { TestResult } from './types';
import { attentionAreas, compareRounds, countResults, executionRate, mapRawResult, passRate, retestCandidates } from './resultSummary';

const result = (externalId: string, feature: string, value: TestResult['result'], platform: TestResult['platform'] = 'android'): TestResult => ({
  id: `${externalId}-${platform}`,
  importId: 'imp',
  externalId,
  feature,
  title: externalId,
  platform,
  result: value,
});

const sample: TestResult[] = [
  result('A-1', '회원가입', 'pass'),
  result('A-2', '회원가입', 'pass'),
  result('A-3', '회원가입', 'fail'),
  result('B-1', '로그인', 'blocked'),
  result('B-2', '로그인', 'not_tested'),
  result('B-3', '로그인', 'not_tested'),
];

describe('수행 결과 요약', () => {
  it('결과별 개수를 센다', () => {
    expect(countResults(sample)).toEqual({ total: 6, pass: 2, fail: 1, blocked: 1, not_tested: 2 });
  });

  it('수행률은 미수행을 제외한 비율, 통과율은 수행한 것 중 PASS 비율이다', () => {
    const counts = countResults(sample);
    expect(executionRate(counts)).toBe(67);
    expect(passRate(counts)).toBe(50);
  });

  it('결과가 없으면 비율은 0이다', () => {
    const counts = countResults([]);
    expect(executionRate(counts)).toBe(0);
    expect(passRate(counts)).toBe(0);
  });

  it('실패·차단·미수행이 몰린 기능을 먼저 보여준다', () => {
    const areas = attentionAreas(sample);
    expect(areas.map((area) => area.feature)).toEqual(['로그인', '회원가입']);
    expect(areas[0].attentionRate).toBe(1);
  });

  it('문제가 없는 기능은 집중 영역에서 제외한다', () => {
    expect(attentionAreas([result('C-1', '마이페이지', 'pass')])).toEqual([]);
  });

  it('FAIL과 BLOCKED만 재수행 대상이다', () => {
    expect(retestCandidates(sample).map((item) => item.externalId)).toEqual(['A-3', 'B-1']);
  });

  it('차수 간 변화량을 계산한다', () => {
    const before = countResults(sample);
    const after = countResults([...sample.slice(0, 3), result('B-1', '로그인', 'pass'), result('B-2', '로그인', 'pass'), result('B-3', '로그인', 'fail')]);
    const pass = compareRounds(before, after).find((row) => row.value === 'pass');
    expect(pass).toEqual({ value: 'pass', previous: 2, current: 4, delta: 2 });
  });

  it('고객사 상태값을 대소문자·공백과 무관하게 매핑한다', () => {
    const mappings = [
      { rawValue: 'P', result: 'pass' as const },
      { rawValue: 'N/T', result: 'not_tested' as const },
    ];
    expect(mapRawResult(' p ', mappings)).toBe('pass');
    expect(mapRawResult('n/t', mappings)).toBe('not_tested');
    expect(mapRawResult('OK', mappings)).toBeUndefined();
  });
});
