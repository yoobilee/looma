import type {
  ActivityType,
  DeliverableType,
  IssueStatus,
  IssueType,
  Platform,
  ProjectStage,
  ProjectStatus,
  ReviewStatus,
  ScratchLinkTarget,
  ScratchType,
  SourceType,
  TaskRepeat,
  TaskStatus,
  TestPerspective,
  TestResultValue,
  TestScope,
} from './types';

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

export const generationTypeLabel: Record<SourceType, string> = {
  source_explicit: '산출물 직접 근거',
  ai_suggestion: 'AI 테스트 관점 제안',
  needs_confirmation: '확인 필요',
};

export const reviewStatusLabel: Record<ReviewStatus, string> = {
  draft: '초안',
  reviewed: '검토 완료',
  confirmed: '확정',
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
};
