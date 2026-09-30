// LOOMA_IMPLEMENTATION_SPEC.md 5장 데이터 모델을 TypeScript 타입으로 옮긴 것.
// 날짜는 모두 ISO 8601 문자열로 다룬다.

export type ThemePreference = 'light' | 'dark';

export interface User {
  id: string;
  locale: 'ko-KR';
  theme: ThemePreference;
  calendarConnection: 'not_connected' | 'connected';
}

/* 업무 */
export type TaskStatus = 'planned' | 'in_progress' | 'waiting' | 'done';
export type TaskRepeat = 'none' | 'daily' | 'weekdays' | 'weekly';

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  dueAt?: string;
  projectId?: string;
  notes?: string;
  tags: string[];
  repeat: TaskRepeat;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

/* 프로젝트 */
export type ProjectStatus = 'preparing' | 'active' | 'archived';
export type Platform = 'android' | 'ios' | 'web' | 'desktop';
export type TestScope = 'functional' | 'ui_ux' | 'regression' | 'api' | 'performance' | 'compatibility';
export type ProjectStage = 'deliverables' | 'requirements' | 'test_design' | 'results' | 'issues';

export interface Project {
  id: string;
  name: string;
  clientName?: string;
  serviceName?: string;
  status: ProjectStatus;
  startDate?: string;
  endDate?: string;
  platforms: Platform[];
  testScopes: TestScope[];
  description?: string;
  tcTemplateId?: string;
  currentStage: ProjectStage;
}

/* 산출물 */
export type DeliverableType = 'pdf' | 'xlsx' | 'csv' | 'docx' | 'image' | 'url' | 'figma';

export interface Deliverable {
  id: string;
  projectId: string;
  type: DeliverableType;
  title: string;
  sourceUrl?: string;
  fileRef?: string;
  version?: string;
  /** 기존 산출물의 새 버전이면 직전 버전의 id. 없으면 별도 신규 산출물이다. */
  previousRevisionId?: string;
  summary?: string;
  importedAt: string;
  analyzedAt?: string;
}

/* 요구사항 · TC 공통 출처 구분 */
export type SourceType = 'source_explicit' | 'ai_suggestion' | 'needs_confirmation';

export interface SourceRef {
  deliverableId: string;
  locator: string; // 페이지, Frame, 셀 등 사람이 읽을 수 있는 위치
}

export type RequirementStatus = 'draft' | 'reviewed' | 'confirmed';
/** 산출물 revision에 따른 요구사항 상태. 검토 상태(status)와 별개다. */
export type RequirementLifecycle = 'active' | 'changed' | 'removed';

/**
 * 요구사항. id는 산출물 revision이 바뀌어도 유지되고,
 * 근거(sourceRefs)만 새 revision을 가리키도록 갱신한다.
 */
export interface Requirement {
  id: string;
  projectId: string;
  feature: string;
  text: string;
  sourceRefs: SourceRef[];
  sourceType: SourceType;
  confidence?: number;
  needsConfirmation: boolean;
  lifecycle: RequirementLifecycle;
  status: RequirementStatus;
}

/* 테스트 조건: 요구사항에서 무엇을 검증할지 정리한 중간 근거. TC 설계의 기준이 된다. */
export type TestConditionStatus = 'active' | 'needs_review' | 'deprecated';

export interface TestCondition {
  id: string;
  projectId: string;
  requirementIds: string[];
  feature: string;
  title: string;
  status: TestConditionStatus;
  createdAt: string;
  updatedAt: string;
}

/* TC Template */
export type TestResultValue = 'pass' | 'fail' | 'blocked' | 'not_tested';

export interface ResultMapping {
  rawValue: string;
  result: TestResultValue;
}

export interface TCTemplate {
  id: string;
  projectId?: string;
  name: string;
  columns: string[];
  idRule?: string;
  depthRule?: string;
  styleHints?: string;
  resultMappings: ResultMapping[];
}

/* 테스트 케이스 */
export type TestPerspective =
  | 'normal_flow'
  | 'exception'
  | 'boundary'
  | 'permission'
  | 'state_change'
  | 'data_io'
  | 'api'
  | 'performance'
  | 'compatibility';

/** TC의 근거 유형. 요구사항과 공유하는 SourceType에 고객사 기존 TC 가져오기를 더한 값이다. */
export type TestCaseGenerationType = SourceType | 'imported_existing';

export type TestCaseStatus = 'draft' | 'reviewed' | 'active' | 'needs_review' | 'deprecated';
/** 누가 만들었는가. 근거 유형(generationType)과 별개다. */
export type TestCaseOrigin = 'manual' | 'ai_generated' | 'ai_modified' | 'imported' | 'import_modified';

/** 고객사 TC 파일 가져오기 근거. 이 TC를 마지막으로 만들거나 바꾼 가져오기 작업과 파일 행을 가리킨다. */
export interface TestAssetImportSource {
  sessionId: string;
  rowNumber: number;
}

export interface TestCase {
  /** Looma 내부 ID */
  id: string;
  projectId: string;
  templateId?: string;
  /** 고객사 TC ID (SIGN-001 등). 수행 결과는 이 값으로 연결된다. */
  externalId?: string;
  category: TestPerspective;
  feature: string;
  depth: string[]; // 대분류 · 중분류 · 소분류
  title: string;
  precondition?: string;
  steps: string[];
  expectedResult: string;
  requirementIds: string[];
  testConditionIds: string[];
  sourceRefs: SourceRef[];
  generationType: TestCaseGenerationType;
  origin: TestCaseOrigin;
  status: TestCaseStatus;
  /** 내용이 바뀔 때마다 1씩 증가한다. 상태 변경만으로는 올리지 않는다. */
  revision: number;
  duplicateOf?: string;
  importSource?: TestAssetImportSource;
  createdAt: string;
  updatedAt: string;
}

/* TC 자산 가져오기: 고객사가 쓰던 TC 정의를 기준 TC로 가져온 작업 단위. 수행 결과 업로드와 별개다. */
export interface TestAssetImportSession {
  id: string;
  projectId: string;
  fileName: string;
  importedAt: string;
  /** 빈 행을 뺀 파일의 데이터 행 수 */
  totalRows: number;
  created: number;
  updated: number;
  /** 기존 TC와 내용이 같아 바꾸지 않은 행 */
  unchanged: number;
  excluded: number;
}

/* 수행 결과 */
export interface TestResultImport {
  id: string;
  projectId: string;
  round: number;
  fileRef: string;
  importedAt: string;
  mapping: ResultMapping[];
}

export interface TestResult {
  id: string;
  importId: string;
  testCaseId?: string;
  externalId: string;
  feature: string;
  title: string;
  platform?: Platform;
  result: TestResultValue;
  issueId?: string;
  note?: string;
}

/*
 * 변경 영향 분석 — 새 산출물이 들어왔을 때 기존 자산 기준으로 만든 "제안".
 * 사람이 항목별로 판단(draft) → 검토 완료(reviewed) → 명시적으로 반영(applied)해야 실제 요구사항·TC가 바뀐다.
 */
export type RequirementChangeKind = 'added' | 'modified' | 'removed' | 'unchanged';
/** 사람의 판단. unchanged·keep처럼 판단이 필요 없는 항목에는 두지 않는다. */
export type ReviewDecision = 'pending' | 'accepted' | 'rejected';

/** 요구사항을 새로 만들거나 수정할 때 쓰는 내용. 근거 유형은 분석이 가진 값을 그대로 쓴다. */
export type RequirementProposal = Pick<Requirement, 'text' | 'sourceType' | 'needsConfirmation' | 'confidence'>;

export interface RequirementChange {
  id: string;
  kind: RequirementChangeKind;
  /** 기존 요구사항. added가 아니면 필수이며 modified는 이 identity를 유지한다. */
  requirementId?: string;
  /** added·modified에서 새 요구사항 내용 */
  proposal?: RequirementProposal;
  feature: string;
  /** 이번 분석의 근거. removed는 제거 판단의 근거로 분석 안에만 남고 기존 요구사항 근거를 덮어쓰지 않는다. */
  sourceRefs: SourceRef[];
  note?: string;
  /** added·modified·removed에서만 사용 */
  decision?: ReviewDecision;
}

export type TestImpactKind = 'create' | 'modify' | 'keep' | 'deprecate' | 'duplicate_candidate';
/** 중복 후보는 수락/제외가 아니라 처리 방법을 고른다. */
export type DuplicateResolution = 'pending' | 'modify_existing' | 'create_separate' | 'excluded';

/** TC 설계 내용. 생성·수정 제안이 담는 필드이며 ID·상태·revision 같은 관리 필드는 뺀다. */
export type TestCaseDesign = Pick<
  TestCase,
  'category' | 'feature' | 'depth' | 'title' | 'precondition' | 'steps' | 'expectedResult' | 'requirementIds' | 'testConditionIds' | 'sourceRefs' | 'generationType'
>;

export interface TestImpact {
  id: string;
  kind: TestImpactKind;
  /** 대상 기존 TC. create가 아니면 필수. duplicate_candidate는 비슷한 기존 TC를 가리킨다. */
  testCaseId?: string;
  requirementChangeIds: string[];
  testConditionIds: string[];
  /** create, 또는 중복 후보를 별도 신규 TC로 만들 때 쓰는 완전한 설계 */
  newTestCase?: TestCaseDesign;
  /** modify, 또는 중복 후보로 기존 TC를 수정할 때 바꿀 필드만 */
  changes?: Partial<TestCaseDesign>;
  reason: string;
  /** create·modify·deprecate에서만 사용 */
  decision?: ReviewDecision;
  /** duplicate_candidate에서만 사용 */
  duplicateResolution?: DuplicateResolution;
}

export type ChangeAnalysisStatus = 'draft' | 'reviewed' | 'applied';

/** 반영으로 실제 바뀐 요구사항·TC 수. 내용이 같아 바뀌지 않은 수정 제안은 세지 않는다. */
export interface ChangeApplySummary {
  requirementsAdded: number;
  requirementsModified: number;
  requirementsRemoved: number;
  testCasesCreated: number;
  testCasesModified: number;
  testCasesDeprecated: number;
}

/** 하나의 분석 작업 단위. 어떤 산출물을 무엇과 비교했는지와 제안 결과를 함께 묶는다. */
export interface ChangeAnalysis {
  id: string;
  projectId: string;
  /** 분석 기준 산출물(또는 revision) */
  targetDeliverableId: string;
  /** 비교한 이전 revision. 별도 신규 산출물이면 없고, 프로젝트의 기존 자산 전체와 비교한다. */
  baselineDeliverableId?: string;
  status: ChangeAnalysisStatus;
  createdAt: string;
  reviewedAt?: string;
  appliedAt?: string;
  /** applied일 때 실제 반영 결과 */
  appliedSummary?: ChangeApplySummary;
  requirementChanges: RequirementChange[];
  testImpacts: TestImpact[];
}

/* 이슈 / 확인사항 */
export type IssueType = 'defect' | 'question';
export type IssueStatus = 'open' | 'fixed' | 'closed' | 'waiting' | 'checking' | 'answered';

export interface Issue {
  id: string;
  projectId: string;
  type: IssueType;
  title: string;
  status: IssueStatus;
  feature?: string;
  testCaseId?: string;
  requirementId?: string; // 요구사항 분석의 확인 필요 항목에서 만든 경우
  externalKey?: string; // BUG-014 같은 외부 이슈 번호
  sourceRef?: SourceRef;
  note?: string;
  createdAt: string;
}

/* 업무 지식 */
export interface KnowledgeAiDraft {
  explanation: string;
  relatedKeywords: string[];
  createdAt: string;
}

export interface KnowledgeTerm {
  id: string;
  term: string;
  explanation: string;
  workMeaning?: string;
  examples: string[];
  relatedProjectIds: string[];
  relatedTerms: string[];
  tags: string[];
  userNote?: string;
  aiDraftUsed: boolean;
  aiDraft?: KnowledgeAiDraft;
  updatedAt: string;
}

/* 임시 작업공간 */
export type ScratchType = 'text' | 'image' | 'url' | 'log' | 'json' | 'note';
export type ScratchLinkTarget = 'task' | 'project' | 'record' | 'knowledge';

export interface ScratchItem {
  id: string;
  type: ScratchType;
  title?: string;
  content: string;
  createdAt: string;
  expiresAt?: string;
  pinnedAt?: string;
  linkedType?: ScratchLinkTarget;
  linkedId?: string;
  contextProjectId?: string;
}

/* 활동 기록 */
export type ActivityType =
  | 'task_created'
  | 'task_started'
  | 'task_completed'
  | 'memo_created'
  | 'scratch_pinned'
  | 'deliverable_added'
  | 'requirements_analyzed'
  | 'test_case_changed'
  | 'results_uploaded'
  | 'issue_created'
  | 'project_changed'
  | 'knowledge_saved'
  | 'changes_applied'
  | 'test_assets_imported';

export interface Activity {
  id: string;
  projectId?: string;
  taskId?: string;
  type: ActivityType;
  title: string;
  metadata: Record<string, string>;
  createdAt: string;
}

/* 외부 일정 (Google Calendar read-only 예정) */
export interface CalendarEvent {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  location?: string;
  sourceUrl: string;
}
