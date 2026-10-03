import { describe, expect, it } from 'vitest';
import { groupActivitiesByDay } from '@/features/records/groupActivities';
import { activityCategory, activityCategoryFilters, activityLinkLabel, activityLinkPath, matchesActivityCategory, parseActivityCategoryFilter } from './activityRecords';
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
  const at = '2026-10-01T09:00:00.000Z';
  const linkOf = (type: ActivityType, metadata: Record<string, string>, projectId: string | null = 'proj-1') =>
    activityLinkPath(make('a', at, { type, metadata: { detail: '요약', ...metadata }, ...(projectId && { projectId }) }), 'proj-1');

  // 종류 · metadata key · 경로. 변경 분석만 항목을 여는 주소가 없어 ID가 있어도 탭까지만 간다.
  it.each([
    ['issue_created', 'issueId', '/projects/proj-1/issues?issue=id%201'],
    ['issue_updated', 'issueId', '/projects/proj-1/issues?issue=id%201'],
    ['issue_resolved', 'issueId', '/projects/proj-1/issues?issue=id%201'],
    ['results_uploaded', 'resultImportId', '/projects/proj-1/results?import=id%201'],
    ['test_case_changed', 'testCaseId', '/projects/proj-1/test-design?tc=id%201'],
    ['test_assets_imported', 'testAssetImportId', '/projects/proj-1/import-history?assetImport=id%201'],
    ['deliverable_added', 'deliverableId', '/projects/proj-1?deliverable=id%201'],
    ['changes_applied', 'analysisId', '/projects/proj-1/test-design'],
    ['requirements_analyzed', 'analysisId', '/projects/proj-1/test-design'],
    ['requirements_imported', 'deliverableId', '/projects/proj-1/requirements'],
  ] as [ActivityType, string, string][])('%s + %s → %s, ID가 없는 이전 기록은 링크가 없다', (type, key, path) => {
    expect(linkOf(type, { [key]: 'id 1' })).toBe(path);
    expect(linkOf(type, {})).toBeUndefined();
    expect(linkOf(type, { [key]: '' })).toBeUndefined();
  });

  it('개별 원본이 아닌 화면으로만 가는 변경 분석 기록(반영 · 검토 완료)만 별도 링크 문구를 쓰고, 나머지는 제목 링크다', () => {
    const labelOf = (type: ActivityType) => activityLinkLabel(make('a', at, { type }));
    expect(labelOf('changes_applied')).toBe('테스트 설계 보기');
    expect(labelOf('requirements_analyzed')).toBe('테스트 설계 보기');
    for (const type of ['issue_created', 'results_uploaded', 'test_case_changed', 'test_assets_imported', 'deliverable_added', 'requirements_imported'] as const) expect(labelOf(type)).toBeUndefined();
  });

  it('산출물 · TC 가져오기 링크는 ID를 인코딩하고, 수행 결과 차수의 `import`와 다른 이름을 쓴다', () => {
    expect(linkOf('deliverable_added', { deliverableId: 'a&b=c/d?e' })).toBe('/projects/proj-1?deliverable=a%26b%3Dc%2Fd%3Fe');
    expect(linkOf('test_assets_imported', { testAssetImportId: 'a&b=c/d?e' })).toBe('/projects/proj-1/import-history?assetImport=a%26b%3Dc%2Fd%3Fe');
    expect(linkOf('results_uploaded', { resultImportId: 'imp-1' })).toBe('/projects/proj-1/results?import=imp-1');
  });

  it('산출물 · TC 가져오기도 종류에 맞지 않는 key나 다른 프로젝트 활동은 링크가 없다', () => {
    expect(linkOf('deliverable_added', { testAssetImportId: 'x', analysisId: 'y', issueId: 'z' })).toBeUndefined();
    expect(linkOf('test_assets_imported', { deliverableId: 'x', resultImportId: 'y' })).toBeUndefined();
    expect(linkOf('deliverable_added', { deliverableId: 'x' }, 'proj-2')).toBeUndefined();
    expect(linkOf('test_assets_imported', { testAssetImportId: 'x' }, 'proj-2')).toBeUndefined();
  });

  it('종류에 맞지 않는 metadata key만 있으면 링크가 없다', () => {
    expect(linkOf('results_uploaded', { issueId: 'x', testCaseId: 'y' })).toBeUndefined();
    expect(linkOf('issue_created', { resultImportId: 'x' })).toBeUndefined();
    expect(linkOf('test_case_changed', { analysisId: 'x' })).toBeUndefined();
    expect(linkOf('requirements_analyzed', { deliverableId: 'x', testCaseId: 'y' })).toBeUndefined();
    expect(linkOf('requirements_imported', { analysisId: 'x', testAssetImportId: 'y' })).toBeUndefined();
  });

  it('링크를 정하지 않은 종류는 metadata가 있어도 링크가 없다', () => {
    const unlinked = (Object.keys(activityTypeLabel) as ActivityType[]).filter((type) => !['issues', 'results', 'testCases', 'deliverables'].includes(activityCategory[type]));
    expect(unlinked.length).toBeGreaterThan(0);
    for (const type of unlinked) {
      expect(linkOf(type, { issueId: 'x', resultImportId: 'x', testCaseId: 'x', testAssetImportId: 'x', deliverableId: 'x', analysisId: 'x' })).toBeUndefined();
    }
  });

  it('다른 프로젝트 · 프로젝트 없는 활동은 지금 프로젝트로 연결하지 않는다', () => {
    expect(linkOf('issue_created', { issueId: 'x' }, 'proj-2')).toBeUndefined();
    expect(linkOf('issue_created', { issueId: 'x' }, null)).toBeUndefined();
    expect(linkOf('requirements_analyzed', { analysisId: 'x' }, 'proj-2')).toBeUndefined();
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
