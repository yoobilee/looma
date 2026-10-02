import type { Activity, ActivityType } from './types';

/*
 * 프로젝트 기록 화면용 활동 분류와 원본 링크. Activity 데이터는 그대로 두고 보는 방법만 정한다.
 */

export type ActivityCategory = 'deliverables' | 'testCases' | 'results' | 'issues' | 'etc';
export type ActivityCategoryFilter = 'all' | ActivityCategory;

/** 빠진 ActivityType이 있으면 타입 오류가 난다. */
export const activityCategory: Record<ActivityType, ActivityCategory> = {
  deliverable_added: 'deliverables',
  requirements_analyzed: 'deliverables',
  changes_applied: 'deliverables',
  test_case_changed: 'testCases',
  test_assets_imported: 'testCases',
  results_uploaded: 'results',
  issue_created: 'issues',
  issue_updated: 'issues',
  issue_resolved: 'issues',
  project_changed: 'etc',
  task_created: 'etc',
  task_started: 'etc',
  task_completed: 'etc',
  scratch_pinned: 'etc',
  memo_created: 'etc',
  knowledge_saved: 'etc',
};

export const activityCategoryFilters: readonly ActivityCategoryFilter[] = ['all', 'deliverables', 'testCases', 'results', 'issues', 'etc'];

export const activityCategoryLabel: Record<ActivityCategoryFilter, string> = {
  all: '전체',
  deliverables: '산출물·변경',
  testCases: 'TC',
  results: '수행 결과',
  issues: '이슈·확인사항',
  etc: '기타',
};

/** 주소 query 값을 필터로 바꾼다. 알 수 없는 값은 전체. */
export function parseActivityCategoryFilter(value: string | null): ActivityCategoryFilter {
  return activityCategoryFilters.find((filter) => filter === value) ?? 'all';
}

export function matchesActivityCategory(activity: Activity, filter: ActivityCategoryFilter): boolean {
  return filter === 'all' || activityCategory[activity.type] === filter;
}

/** 원본으로 가는 프로젝트 안 경로. 연결할 ID가 기록에 없으면 추측하지 않고 undefined. */
export function activityLinkPath(activity: Activity, projectId: string): string | undefined {
  if (activityCategory[activity.type] !== 'issues') return undefined;
  const issueId = activity.metadata.issueId;
  return issueId ? `/projects/${projectId}/issues?issue=${encodeURIComponent(issueId)}` : undefined;
}
