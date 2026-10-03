import type {
  Activity,
  CalendarEvent,
  ChangeAnalysis,
  Deliverable,
  DuplicateResolution,
  DeliverableType,
  ImportSourceArtifact,
  ImportSourceFormat,
  Issue,
  IssueStatus,
  IssueType,
  KnowledgeTerm,
  Platform,
  Project,
  Requirement,
  ReviewDecision,
  ScratchItem,
  ScratchLinkTarget,
  ScratchType,
  Task,
  TaskRepeat,
  TaskStatus,
  TCTemplate,
  TestCase,
  TestCaseStatus,
  TestCondition,
  TestPerspective,
  TestResult,
  TestAssetImportSession,
  TestResultImport,
  TestScope,
} from '@/domain/types';
import type { IssueChanges } from '@/domain/issues';
import type { RequirementColumnMapping, RequirementImportSummary } from '@/domain/requirementImport';
import type { TestDraftSummary } from '@/domain/testDraftGeneration';
import type { ColumnMapping, ImportTable, TestAssetImportRowDecision } from '@/domain/testAssetImport';
import type { ResultColumnMapping, ResultCycleInput, ResultImportRowDecision, ResultValueDecision } from '@/domain/testResultImport';

// UI는 이 인터페이스만 사용한다.
// 지금은 data/local의 브라우저 저장(IndexedDB) 구현을 쓰고, 이후 Supabase나 실제 연동 구현으로 교체한다.
// 모든 메서드는 Promise를 반환해 실제 네트워크 구현과 호출 방식을 맞춘다.
// 변경 메서드는 저장에 성공했을 때만 resolve한다. 저장에 실패하면 PersistenceError로 reject하고 아무것도 바꾸지 않는다.

export interface CreateTaskInput {
  title: string;
  dueAt?: string;
  projectId?: string;
  notes?: string;
  tags?: string[];
  repeat?: TaskRepeat;
}

export interface TaskRepository {
  list(): Promise<Task[]>;
  get(id: string): Promise<Task | undefined>;
  create(input: CreateTaskInput): Promise<Task>;
  updateStatus(id: string, status: TaskStatus): Promise<Task>;
}

export interface CreateProjectInput {
  name: string;
  clientName?: string;
  serviceName?: string;
  platforms: Platform[];
  testScopes: TestScope[];
  startDate?: string;
  endDate?: string;
  description?: string;
}

export interface ProjectRepository {
  list(): Promise<Project[]>;
  get(id: string): Promise<Project | undefined>;
  create(input: CreateProjectInput): Promise<Project>;
}

export interface CreateDeliverableInput {
  projectId: string;
  type: DeliverableType;
  title: string;
  sourceUrl?: string;
  fileRef?: string;
  version?: string;
  /** 기존 산출물의 새 버전으로 등록할 때 직전 버전의 id */
  previousRevisionId?: string;
}

export interface DeliverableRepository {
  listByProject(projectId: string): Promise<Deliverable[]>;
  create(input: CreateDeliverableInput): Promise<Deliverable>;
}

export interface ImportRequirementsInput {
  projectId: string;
  /** 새 요구사항의 근거(sourceRefs)가 가리킬 이 프로젝트의 산출물 */
  deliverableId: string;
  fileName: string;
  table: ImportTable;
  mapping: RequirementColumnMapping;
  /** 새 요구사항이 될 수 있지만 사용자가 뺀 행 번호 */
  excludedRows: number[];
}

export interface RequirementRepository {
  listByProject(projectId: string): Promise<Requirement[]>;
  /**
   * 요구사항 파일의 표를 현재 요구사항 기준으로 다시 판정해 새 요구사항만 한 번에 만든다. 기존 요구사항은 바꾸지 않는다.
   * 만들 요구사항이 없거나 하나라도 문제가 있으면 아무것도 저장하지 않는다. 활동 기록도 같은 저장에 남는다.
   */
  importFromTable(input: ImportRequirementsInput): Promise<{ requirements: Requirement[]; summary: RequirementImportSummary }>;
}

export interface TemplateRepository {
  get(id: string): Promise<TCTemplate | undefined>;
  saveForProject(projectId: string, template: Omit<TCTemplate, 'id' | 'projectId'>): Promise<TCTemplate>;
}

export interface TestConditionRepository {
  listByProject(projectId: string): Promise<TestCondition[]>;
}

export interface CreateTestDraftsInput {
  projectId: string;
  /** TC 초안의 근거가 될 이 프로젝트의 요구사항(제거되지 않은 것) */
  requirementIds: string[];
  perspectives: TestPerspective[];
  /** 만들 수 있는 후보 중 사용자가 뺀 후보의 key(testDraftCandidateKey) */
  excludedKeys: string[];
}

export interface TestCaseRepository {
  listByProject(projectId: string): Promise<TestCase[]>;
  updateStatus(id: string, status: TestCaseStatus): Promise<TestCase>;
  /**
   * 요구사항과 테스트 관점으로 테스트 조건 · TC 초안을 한 번에 만든다. 현재 프로젝트 · 요구사항 · 테스트 조건 · TC 기준으로 다시 계산하고,
   * 기존 TC · 테스트 조건은 바꾸지 않는다. 만들 후보가 없거나 입력이 맞지 않으면 아무것도 저장하지 않는다. 활동 기록도 같은 저장에 남는다.
   */
  createDraftsFromRequirements(input: CreateTestDraftsInput): Promise<{ testCases: TestCase[]; testConditions: TestCondition[]; summary: TestDraftSummary }>;
}

/** 가져온 원본 파일. 표를 읽은 바로 그 bytes를 넘긴다(다시 쓴 파일이 아니다). */
export interface ImportSourceFileInput {
  bytes: Blob;
  format: ImportSourceFormat;
  sheetName?: string;
}

export interface ApplyTestAssetImportInput {
  projectId: string;
  fileName: string;
  table: ImportTable;
  mapping: ColumnMapping;
  decisions: TestAssetImportRowDecision[];
  /** 있으면 원본 파일 · layout snapshot · 열 매핑을 가져오기 기록과 한 번에 저장한다. */
  source?: ImportSourceFileInput;
}

/** 고객사 TC 파일을 기준 TC로 가져온다. 수행 결과 업로드와 별개다. */
export interface TestAssetImportRepository {
  /** 최신 가져오기부터 반환한다. */
  listByProject(projectId: string): Promise<TestAssetImportSession[]>;
  /**
   * 현재 TC 기준으로 다시 분석해 미리보기 판정과 같을 때만 한 번에 반영한다.
   * 하나라도 문제가 있으면 TC · 가져오기 기록 · 활동을 모두 그대로 둔다.
   */
  apply(input: ApplyTestAssetImportInput): Promise<TestAssetImportSession>;
}

export interface ImportTestResultsInput {
  projectId: string;
  fileName: string;
  table: ImportTable;
  mapping: ResultColumnMapping;
  cycle: ResultCycleInput;
  rowDecisions: ResultImportRowDecision[];
  /** 알 수 없는 결과 원문 키별 판단 */
  valueDecisions: Record<string, ResultValueDecision>;
  /** 있으면 원본 파일 · layout snapshot · 열 매핑을 차수와 한 번에 저장한다. */
  source?: ImportSourceFileInput;
}

/**
 * 가져오기 원본 파일. 메타데이터는 앱 상태에, bytes는 별도 저장소에 있다(이후 DB · Storage로 나눠 교체할 수 있다).
 * 원본은 가져오기와 함께만 만들어지고 바뀌지 않는다. 지우는 것은 로컬 데이터 초기화뿐이다.
 */
export interface ImportSourceArtifactRepository {
  get(id: string): Promise<ImportSourceArtifact | undefined>;
  /**
   * 원본 bytes. 기록이 없으면 undefined.
   * 기록은 있는데 파일이 없거나 크기가 다르면 PersistenceError(artifact_missing · artifact_corrupt)를 던진다.
   */
  getBytes(id: string): Promise<Uint8Array | undefined>;
}

/** 로컬 저장 상태. ready가 아니면 화면을 띄우지 않는다. 읽기 전용 snapshot이며 바뀔 때마다 새 객체로 교체된다. */
export type PersistenceStatus =
  | { readonly state: 'loading' }
  | {
      readonly state: 'ready';
      /** local: 브라우저에 저장, memory: 사용자가 고른 저장하지 않는 모드 */
      readonly mode: 'local' | 'memory';
      readonly revision: number;
      readonly savedAt: string;
      /** 다른 탭이 더 새 데이터를 저장했다. 다시 불러오기 전까지 저장하지 않는다. */
      readonly stale: boolean;
      /** 마지막 저장 실패 안내 */
      readonly error?: string;
    }
  | { readonly state: 'blocked'; readonly reason: 'unavailable' | 'read_failed' | 'corrupt' | 'unsupported_version' | 'migration_failed'; readonly message: string };

export interface PersistenceController {
  /**
   * 지금 상태의 snapshot. 고정(freeze)되어 있어 고쳐도 저장소 상태는 바뀌지 않는다.
   * 상태가 그대로면 같은 객체를, 바뀌었을 때만 새 객체를 돌려준다(useSyncExternalStore 참조 안정성).
   */
  getStatus(): PersistenceStatus;
  subscribe(listener: () => void): () => void;
  /** 저장된 데이터를 읽는다. 처음이면 예시 데이터를 만들어 저장한다. */
  load(): Promise<void>;
  /** 다른 탭이 저장한 최신 데이터로 바꾼다. */
  reloadLatest(): Promise<void>;
  /** 저장된 데이터와 원본 파일을 모두 지우고 지금 기준 예시 데이터로 바꾼다. 실패하면 기존 데이터를 그대로 둔다. */
  resetToSeed(): Promise<void>;
  /** 로컬 저장소를 쓸 수 없을 때 사용자가 고른 경우에만, 저장하지 않는 모드로 연다. */
  continueWithoutSaving(): Promise<void>;
  dismissError(): void;
}

export interface TestResultRepository {
  /** 차수 오름차순 */
  listImports(projectId: string): Promise<TestResultImport[]>;
  listResults(importId: string): Promise<TestResult[]>;
  /**
   * 수행 결과 파일을 새 차수로 가져온다. 현재 기준 TC · 템플릿 매핑으로 다시 분석해 미리보기와 같을 때만 한 번에 저장한다.
   * 하나라도 문제가 있으면 차수 · 결과 · 활동을 모두 그대로 둔다. 기준 TC는 어떤 경우에도 바꾸지 않는다.
   */
  importResults(input: ImportTestResultsInput): Promise<TestResultImport>;
}

export interface CreateIssueInput {
  projectId: string;
  type: IssueType;
  title: string;
  description?: string;
  feature?: string;
  /** 결과 없이 TC만 연결할 때. resultId가 있으면 결과의 TC를 쓰고, 이 값이 결과의 TC와 다르면 거부한다. */
  testCaseId?: string;
  /** 이 항목을 만든 수행 결과. 같은 결과에 여러 항목을 만들 수 있다. */
  resultId?: string;
  requirementId?: string;
  expected?: string;
  actual?: string;
  reproduction?: string;
  note?: string;
}

/** 고칠 수 있는 값. 연결(프로젝트 · TC · 결과 · 요구사항)은 만든 뒤 바꾸지 않는다. */
export type UpdateIssueInput = IssueChanges;

/**
 * 이슈 · 확인사항. 삭제는 없다(과거 QA 판단 기록을 남긴다. 필요 없으면 보류로 둔다).
 * 결과 · TC는 읽기만 하고 바꾸지 않으며, 이후 수행 결과로 상태를 자동으로 바꾸지 않는다.
 */
export interface IssueRepository {
  /** 최근 생성 순 */
  listByProject(projectId: string): Promise<Issue[]>;
  get(id: string): Promise<Issue | undefined>;
  /** 확인 필요(open)로 만든다. 결과 · TC · 요구사항이 이 프로젝트에 없으면 거부한다. */
  create(input: CreateIssueInput): Promise<Issue>;
  /** 바뀐 것이 없으면 저장하지 않는다. 상태가 바뀔 때만 활동을 남긴다. */
  update(id: string, changes: UpdateIssueInput): Promise<Issue>;
  updateStatus(id: string, status: IssueStatus): Promise<Issue>;
}

export interface SaveKnowledgeTermInput {
  term: string;
  explanation: string;
  workMeaning?: string;
  examples?: string[];
  relatedProjectIds?: string[];
  relatedTerms?: string[];
  tags?: string[];
  userNote?: string;
}

export interface KnowledgeRepository {
  list(): Promise<KnowledgeTerm[]>;
  get(id: string): Promise<KnowledgeTerm | undefined>;
  create(input: SaveKnowledgeTermInput): Promise<KnowledgeTerm>;
  update(id: string, input: Partial<SaveKnowledgeTermInput> & { aiDraftUsed?: boolean }): Promise<KnowledgeTerm>;
}

export interface CreateScratchInput {
  type: ScratchType;
  content: string;
  title?: string;
  contextProjectId?: string;
}

export interface ScratchRepository {
  /** 만료되지 않았거나 고정된 자료만 반환한다. */
  list(): Promise<ScratchItem[]>;
  create(input: CreateScratchInput): Promise<ScratchItem>;
  pin(id: string, target: ScratchLinkTarget, targetId?: string): Promise<ScratchItem>;
  remove(id: string): Promise<void>;
}

/**
 * 변경 영향 분석. 제안은 판단(draft) → 검토 완료(reviewed) → 반영(applied) 순서로만 실제 자산에 들어간다.
 * 판단은 draft에서만 바꿀 수 있고, 반영은 reviewed에서 한 번만 할 수 있다.
 */
export interface ChangeAnalysisRepository {
  /** 최신 분석부터 반환한다. */
  listByProject(projectId: string): Promise<ChangeAnalysis[]>;
  /** added·modified·removed 요구사항 변경의 수락/제외 */
  updateRequirementDecision(analysisId: string, changeId: string, decision: ReviewDecision): Promise<ChangeAnalysis>;
  /** create·modify·deprecate TC 영향의 수락/제외 */
  updateTestImpactDecision(analysisId: string, impactId: string, decision: ReviewDecision): Promise<ChangeAnalysis>;
  /** 중복 후보 처리 방법 */
  resolveDuplicate(analysisId: string, impactId: string, resolution: DuplicateResolution): Promise<ChangeAnalysis>;
  /** 모든 판단이 끝난 draft를 reviewed로 바꾼다. 실제 자산은 아직 바뀌지 않는다. */
  markReviewed(analysisId: string): Promise<ChangeAnalysis>;
  /** reviewed 분석을 실제 요구사항·TC에 한 번에 반영한다. 하나라도 문제가 있으면 아무것도 바꾸지 않는다. */
  apply(analysisId: string): Promise<ChangeAnalysis>;
}

export interface ActivityFilter {
  projectId?: string;
}

export interface ActivityRepository {
  list(filter?: ActivityFilter): Promise<Activity[]>;
}

export interface CalendarRepository {
  /** 연결 여부. 1차 구현은 예시 일정만 제공한다. */
  connectionStatus(): Promise<'not_connected' | 'connected'>;
  listUpcoming(fromIso: string, limit: number): Promise<CalendarEvent[]>;
}

export interface Repositories {
  tasks: TaskRepository;
  projects: ProjectRepository;
  deliverables: DeliverableRepository;
  requirements: RequirementRepository;
  templates: TemplateRepository;
  testConditions: TestConditionRepository;
  testCases: TestCaseRepository;
  testAssetImports: TestAssetImportRepository;
  testResults: TestResultRepository;
  importSources: ImportSourceArtifactRepository;
  issues: IssueRepository;
  knowledge: KnowledgeRepository;
  scratch: ScratchRepository;
  changeAnalyses: ChangeAnalysisRepository;
  activities: ActivityRepository;
  calendar: CalendarRepository;
  /** 데이터가 바뀌면 호출된다. 반환 함수로 구독을 해제한다. */
  subscribe(listener: () => void): () => void;
  persistence: PersistenceController;
}
