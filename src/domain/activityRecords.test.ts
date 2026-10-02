import { describe, expect, it } from 'vitest';
import { groupActivitiesByDay } from '@/features/records/groupActivities';
import { activityCategory, activityCategoryFilters, activityLinkPath, matchesActivityCategory, parseActivityCategoryFilter } from './activityRecords';
import { activityTypeLabel } from './labels';
import type { Activity, ActivityType } from './types';

const make = (id: string, createdAt: string, overrides: Partial<Activity> = {}): Activity => ({ id, type: 'issue_created', title: id, metadata: {}, createdAt, ...overrides });

describe('활동 분류', () => {
  it('모든 ActivityType이 정확히 하나의 분류에 들어가고 그 분류는 필터에 있다', () => {
    const types = Object.keys(activityTypeLabel) as ActivityType[];
    expect(Object.keys(activityCategory).sort()).toEqual([...types].sort());
    for (const type of types) expect(activityCategoryFilters).toContain(activityCategory[type]);
  });

  it('필터는 분류로 걸러 내고 전체는 모두 통과시킨다', () => {
    const issue = make('a', '2026-10-01T09:00:00.000Z', { type: 'issue_resolved' });
    const result = make('b', '2026-10-01T09:00:00.000Z', { type: 'results_uploaded' });
    expect([issue, result].filter((item) => matchesActivityCategory(item, 'issues'))).toEqual([issue]);
    expect([issue, result].filter((item) => matchesActivityCategory(item, 'all'))).toHaveLength(2);
  });

  it('알 수 없거나 없는 query 값은 전체로 되돌린다', () => {
    expect(parseActivityCategoryFilter('results')).toBe('results');
    expect(parseActivityCategoryFilter('bogus')).toBe('all');
    expect(parseActivityCategoryFilter('')).toBe('all');
    expect(parseActivityCategoryFilter(null)).toBe('all');
  });
});

describe('활동 원본 링크', () => {
  it('issueId가 있는 이슈 기록만 이슈 화면으로 연결한다', () => {
    const linked = make('a', '2026-10-01T09:00:00.000Z', { metadata: { issueId: 'issue 1' } });
    expect(activityLinkPath(linked, 'proj-1')).toBe('/projects/proj-1/issues?issue=issue%201');
    expect(activityLinkPath({ ...linked, type: 'issue_resolved' }, 'proj-1')).toBe('/projects/proj-1/issues?issue=issue%201');
  });

  it('issueId가 없거나 이슈 기록이 아니면 링크가 없다', () => {
    expect(activityLinkPath(make('a', '2026-10-01T09:00:00.000Z'), 'proj-1')).toBeUndefined();
    expect(activityLinkPath(make('b', '2026-10-01T09:00:00.000Z', { type: 'results_uploaded', metadata: { issueId: 'x' } }), 'proj-1')).toBeUndefined();
  });
});

describe('날짜별 묶음 정렬', () => {
  const items = [make('early', '2026-10-01T09:00:00.000Z'), make('late', '2026-10-01T10:00:00.000Z'), make('other-day', '2026-09-30T12:00:00.000Z')];

  it('기본은 같은 날짜 안에서 오래된 것이 먼저다(전역 기록 동작)', () => {
    const groups = groupActivitiesByDay(items);
    expect(groups.map((group) => group.items.map((item) => item.id))).toEqual([['early', 'late'], ['other-day']]);
  });

  it('newest는 날짜도 최신 먼저, 같은 날짜 안에서도 최신 먼저이며 같은 시각이면 입력 순서를 지킨다', () => {
    const tied = [make('first', '2026-10-01T10:00:00.000Z'), make('second', '2026-10-01T10:00:00.000Z'), ...items];
    const groups = groupActivitiesByDay(tied, { within: 'newest' });
    expect(groups.map((group) => group.items.map((item) => item.id))).toEqual([['first', 'second', 'late', 'early'], ['other-day']]);
  });
});
