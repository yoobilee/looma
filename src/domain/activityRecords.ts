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

/**
 * 활동 종류별로 원본 ID를 담는 metadata key와 그 ID로 갈 프로젝트 안 경로.
 * 항목을 표시하는 화면은 ID를 query로 넘기고, 없는 화면(변경 분석)은 탭까지만 간다.
 * 변경 분석은 테스트 설계 탭 안에 있다. 여기 없는 종류는 링크가 없다.
 */
const activityLinks: Partial<Record<ActivityType, { key: string; path: (base: string, id: string) => string }>> = {
  issue_created: { key: 'issueId', path: (base, id) => `${base}/issues?issue=${encodeURIComponent(id)}` },
  issue_updated: { key: 'issueId', path: (base, id) => `${base}/issues?issue=${encodeURIComponent(id)}` },
  issue_resolved: { key: 'issueId', path: (base, id) => `${base}/issues?issue=${encodeURIComponent(id)}` },
  results_uploaded: { key: 'resultImportId', path: (base, id) => `${base}/results?import=${encodeURIComponent(id)}` },
  test_case_changed: { key: 'testCaseId', path: (base, id) => `${base}/test-design?tc=${encodeURIComponent(id)}` },
  // 가져오기 이력은 TC 가져오기 id를 `assetImport`로 받는다(`import`는 수행 결과 차수라 쓰지 않는다). 산출물은 프로젝트 첫 화면이 `deliverable`을 받는다.
  test_assets_imported: { key: 'testAssetImportId', path: (base, id) => `${base}/import-history?assetImport=${encodeURIComponent(id)}` },
  deliverable_added: { key: 'deliverableId', path: (base, id) => `${base}?deliverable=${encodeURIComponent(id)}` },
  changes_applied: { key: 'analysisId', path: (base) => `${base}/test-design` },
  // 변경 분석 검토 완료. 반영과 같은 분석을 가리키므로 같은 key · 같은 탭이다.
  requirements_analyzed: { key: 'analysisId', path: (base) => `${base}/test-design` },
};

/**
 * 제목 대신 별도 버튼 문구로 보여줄 링크. 개별 원본을 여는 주소가 없어 현재 화면으로만 가는 경우다.
 * 변경 분석은 테스트 설계 탭이 최신 분석만 보여 주므로, 과거 기록의 제목이 그 분석을 여는 링크처럼 보이지 않게 한다.
 */
const tabLinkLabels: Partial<Record<ActivityType, string>> = {
  changes_applied: '테스트 설계 보기',
  requirements_analyzed: '테스트 설계 보기',
};

export const activityLinkLabel = (activity: Activity): string | undefined => tabLinkLabels[activity.type];

/**
 * 원본으로 가는 프로젝트 안 경로. 연결할 ID가 기록에 없거나(이전 기록), 다른 프로젝트의 활동이면 추측하지 않고 undefined.
 * 종류에 맞지 않는 metadata key는 보지 않는다.
 */
export function activityLinkPath(activity: Activity, projectId: string): string | undefined {
  const link = activityLinks[activity.type];
  if (!link || activity.projectId !== projectId) return undefined;
  const id = activity.metadata[link.key];
  return id ? link.path(`/projects/${encodeURIComponent(projectId)}`, id) : undefined;
}
