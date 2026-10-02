import type {
  ActivityType,
  ChangeAnalysisStatus,
  DeliverableType,
  DuplicateResolution,
  ExecutionType,
  IssueStatus,
  IssueType,
  Platform,
  ProjectStage,
  ProjectStatus,
  RequirementChangeKind,
  ReviewDecision,
  TestCaseGenerationType,
  TestCaseStatus,
  TestImpactKind,
  ScratchLinkTarget,
  ScratchType,
  SourceType,
  TaskRepeat,
  TaskStatus,
  TestPerspective,
  TestResultValue,
  TestScope,
} from './types';
import type {
  TestAssetConflictReason,
  TestAssetContentField,
  TestAssetImportDecision,
  TestAssetImportField,
  TestAssetMatchKind,
} from './testAssetImport';
import type { ResultConflictReason, ResultImportField, ResultMatchKind } from './testResultImport';
import type { ResultChangeType } from './resultComparison';

// 화면에 보이는 한국어 라벨은 모두 이 파일에서 관리한다.
// PASS/FAIL/BLOCKED, TC, Android/iOS처럼 QA 실무에서 그대로 쓰는 용어는 원문을 유지한다.

export const taskStatusLabel: Record<TaskStatus, string> = {
  planned: '예정',
  in_progress: '진행 중',
  waiting: '대기',
  done: '완료',
};

export const taskRepeatLabel: Record<TaskRepeat, string> = {
  none: '반복 안 함',
  daily: '매일',
  weekdays: '평일마다',
  weekly: '매주',
};

export const projectStatusLabel: Record<ProjectStatus, string> = {
  preparing: '준비 중',
  active: '진행 중',
  archived: '보관',
};

export const platformLabel: Record<Platform, string> = {
  android: 'Android',
  ios: 'iOS',
  web: 'Web',
  desktop: 'PC',
};

export const testScopeLabel: Record<TestScope, string> = {
  functional: '기능',
  ui_ux: 'UI/UX',
  regression: '회귀',
  api: 'API',
  performance: '성능',
  compatibility: '호환성',
};

export const projectStageLabel: Record<ProjectStage, string> = {
  deliverables: '산출물',
  requirements: '요구사항 분석',
  test_design: '테스트 설계',
  results: '수행 결과',
  issues: '이슈 / 확인사항',
};

export const projectStageOrder: ProjectStage[] = [
  'deliverables',
  'requirements',
  'test_design',
  'results',
  'issues',
];

export const deliverableTypeLabel: Record<DeliverableType, string> = {
  pdf: 'PDF',
  xlsx: 'XLSX',
  csv: 'CSV',
  docx: 'DOCX',
  image: '이미지',
  url: 'URL',
  figma: 'Figma',
};

export const deliverableTypeBadge: Record<DeliverableType, string> = {
  pdf: 'PDF',
  xlsx: 'XLSX',
  csv: 'CSV',
  docx: 'DOC',
  image: 'IMG',
  url: 'URL',
  figma: 'FIG',
};

// 요구사항 화면에서는 "산출물 직접 명시", TC 화면에서는 "산출물 직접 근거"로 표기한다.
export const requirementSourceLabel: Record<SourceType, string> = {
  source_explicit: '산출물 직접 명시',
  ai_suggestion: 'AI 제안',
  needs_confirmation: '확인 필요',
};

export const generationTypeLabel: Record<TestCaseGenerationType, string> = {
  source_explicit: '산출물 직접 근거',
  ai_suggestion: 'AI 테스트 관점 제안',
  needs_confirmation: '확인 필요',
  imported_existing: '기존 TC 가져오기',
};

export const testCaseStatusLabel: Record<TestCaseStatus, string> = {
  draft: '초안',
  reviewed: '검토 완료',
  active: '사용 중',
  needs_review: '재검토 필요',
  deprecated: '폐기',
};

export const requirementChangeOrder: RequirementChangeKind[] = ['added', 'modified', 'removed', 'unchanged'];

export const requirementChangeLabel: Record<RequirementChangeKind, string> = {
  added: '신규',
  modified: '변경',
  removed: '제거 후보',
  unchanged: '유지',
};

export const testImpactOrder: TestImpactKind[] = ['create', 'modify', 'keep', 'deprecate', 'duplicate_candidate'];

export const testImpactLabel: Record<TestImpactKind, string> = {
  create: '신규 TC 제안',
  modify: '수정 제안',
  keep: '유지',
  deprecate: '폐기 후보',
  duplicate_candidate: '중복 후보',
};

export const changeAnalysisStatusLabel: Record<ChangeAnalysisStatus, string> = {
  draft: '검토 중',
  reviewed: '검토 완료 · 반영 전',
  applied: '반영 완료',
};

export const reviewDecisionLabel: Record<ReviewDecision, string> = {
  pending: '판단 필요',
  accepted: '수락',
  rejected: '제외',
};

export const duplicateResolutionLabel: Record<DuplicateResolution, string> = {
  pending: '판단 필요',
  modify_existing: '기존 TC 수정',
  create_separate: '별도 신규 TC',
  excluded: '제외',
};

export const testPerspectiveLabel: Record<TestPerspective, string> = {
  normal_flow: '정상 흐름',
  exception: '예외',
  boundary: '경계값',
  permission: '권한',
  state_change: '상태 변화',
  data_io: '데이터 조회/저장',
  api: 'API',
  performance: '성능',
  compatibility: '호환성',
};

export const basePerspectives: TestPerspective[] = [
  'normal_flow',
  'exception',
  'boundary',
  'permission',
  'state_change',
  'data_io',
];

// 프로젝트 테스트 범위를 선택했을 때만 노출되는 관점
export const scopeDrivenPerspectives: Partial<Record<TestScope, TestPerspective>> = {
  api: 'api',
  performance: 'performance',
  compatibility: 'compatibility',
};

export const testResultLabel: Record<TestResultValue, string> = {
  pass: 'PASS',
  fail: 'FAIL',
  blocked: 'BLOCKED',
  not_tested: '미수행',
};

export const testResultOrder: TestResultValue[] = ['pass', 'fail', 'blocked', 'not_tested'];

/** 수행 결과 비교에서 한쪽 차수에 결과 자체가 없을 때. 미수행과 다르다. */
export const NO_RESULT_LABEL = '결과 없음';

export const resultChangeTypeLabel: Record<ResultChangeType, string> = {
  newly_failed: '신규 실패',
  still_failed: '계속 실패',
  fixed: '수정됨',
  newly_blocked: '신규 차단',
  unblocked: '차단 해제',
  newly_not_tested: '신규 미수행',
  resumed: '수행 재개',
  unchanged_pass: '계속 PASS',
  unchanged_blocked: '계속 차단',
  unchanged_not_tested: '계속 미수행',
  added_to_scope: '범위 추가',
  removed_from_scope: '범위 제외',
};

export const issueTypeLabel: Record<IssueType, string> = {
  defect: '결함',
  question: '확인사항',
};

export const issueStatusLabel: Record<IssueStatus, string> = {
  open: '확인 중',
  fixed: '수정됨',
  closed: '종료',
  waiting: '질문 대기',
  checking: '답변 확인 중',
  answered: '확인 완료',
};

export const defectStatuses: IssueStatus[] = ['open', 'fixed', 'closed'];
export const questionStatuses: IssueStatus[] = ['waiting', 'checking', 'answered'];

export const scratchTypeLabel: Record<ScratchType, string> = {
  text: '텍스트',
  image: '이미지',
  url: '링크',
  log: '로그',
  json: 'JSON',
  note: '메모',
};

export const scratchLinkLabel: Record<ScratchLinkTarget, string> = {
  task: '업무에 연결',
  project: '프로젝트에 연결',
  record: '기록으로 저장',
  knowledge: '업무 지식에 저장',
};

export const activityTypeLabel: Record<ActivityType, string> = {
  task_created: '업무 생성',
  task_started: '업무 시작',
  task_completed: '업무 완료',
  memo_created: '메모',
  scratch_pinned: '임시 자료 고정',
  deliverable_added: '산출물 추가',
  requirements_analyzed: '요구사항 분석',
  test_case_changed: 'TC 변경',
  results_uploaded: '수행 결과 업로드',
  issue_created: '이슈 등록',
  project_changed: '프로젝트 변경',
  knowledge_saved: '업무 지식',
  changes_applied: '변경사항 반영',
  test_assets_imported: 'TC 가져오기',
};

/* TC 자산 가져오기 */
export const testAssetImportFieldLabel: Record<TestAssetImportField, string> = {
  externalId: '고객사 TC ID',
  category: '구분(테스트 관점)',
  feature: '기능',
  depth1: '대분류',
  depth2: '중분류',
  depth3: '소분류',
  title: '테스트 항목',
  precondition: 'Pre-condition',
  steps: 'Test Step',
  expectedResult: 'Expected Result',
};

export const testAssetContentFieldLabel: Record<TestAssetContentField, string> = {
  category: '구분',
  feature: '기능',
  depth: 'Depth',
  title: '테스트 항목',
  precondition: 'Pre-condition',
  steps: 'Test Step',
  expectedResult: 'Expected Result',
};

export const testAssetConflictReasonLabel: Record<TestAssetConflictReason, string> = {
  external_id_mismatch: '파일의 고객사 TC ID를 쓰는 기존 TC는 없지만, 내용이 같은 기존 TC가 있어요.',
  ambiguous_content: '내용이 같은 기존 TC가 여러 개예요.',
  ambiguous_external_id: '같은 고객사 TC ID를 쓰는 기존 TC가 여러 개예요. 기존 TC를 먼저 정리해 주세요.',
  shared_target: '파일의 다른 행이 같은 기존 TC를 가리켜요.',
};

export const testAssetMatchOrder: TestAssetMatchKind[] = ['new', 'exact_match', 'changed', 'conflict', 'invalid'];

export const testAssetMatchLabel: Record<TestAssetMatchKind, string> = {
  new: '신규',
  exact_match: '동일',
  changed: '변경 후보',
  conflict: '충돌',
  invalid: '오류',
};

export const testAssetImportDecisionLabel: Record<TestAssetImportDecision, string> = {
  pending: '판단 필요',
  import: '가져오기',
  update: '기존 TC 업데이트',
  create_separate: '별도 신규 TC',
  excluded: '제외',
};

/* 수행 결과 가져오기 */
export const executionTypeOrder: ExecutionType[] = ['full', 'partial', 'retest', 'release_candidate'];

export const executionTypeLabel: Record<ExecutionType, string> = {
  full: '전체 수행',
  partial: '부분 수행',
  retest: '재수행',
  release_candidate: 'RC 검증',
};

export const resultImportFieldLabel: Record<ResultImportField, string> = {
  externalId: '고객사 TC ID',
  title: '테스트 항목',
  feature: '기능',
  result: '수행 결과',
  platform: '플랫폼',
  note: '비고',
  result_android: '수행 결과 · Android',
  result_ios: '수행 결과 · iOS',
  result_web: '수행 결과 · Web',
  result_desktop: '수행 결과 · PC',
};

export const resultMatchOrder: ResultMatchKind[] = ['matched', 'unmatched', 'conflict', 'invalid'];

export const resultMatchLabel: Record<ResultMatchKind, string> = {
  matched: '연결됨',
  unmatched: '미연결',
  conflict: '충돌',
  invalid: '오류',
};

export const resultConflictReasonLabel: Record<ResultConflictReason, string> = {
  ambiguous_external_id: '같은 고객사 TC ID를 쓰는 TC가 여러 개라 어느 TC인지 정할 수 없어요. 가져오면 미연결 결과로 보존해요.',
  duplicate_in_file: '같은 TC · 플랫폼 결과가 파일에 둘 이상 있어요. 하나만 가져올 수 있어요.',
};
