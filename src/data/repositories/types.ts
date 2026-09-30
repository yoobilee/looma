import type {
  Activity,
  CalendarEvent,
  ChangeAnalysis,
  Deliverable,
  DeliverableType,
  Issue,
  IssueStatus,
  IssueType,
  KnowledgeTerm,
  Platform,
  Project,
  Requirement,
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
  TestResult,
  TestResultImport,
  TestScope,
} from '@/domain/types';

// UI는 이 인터페이스만 사용한다.
// 1차 구현은 data/mock의 메모리 구현을 쓰고, 이후 Supabase나 실제 연동 구현으로 교체한다.
// 모든 메서드는 Promise를 반환해 실제 네트워크 구현과 호출 방식을 맞춘다.

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

export interface RequirementRepository {
  listByProject(projectId: string): Promise<Requirement[]>;
}

export interface TemplateRepository {
  get(id: string): Promise<TCTemplate | undefined>;
  saveForProject(projectId: string, template: Omit<TCTemplate, 'id' | 'projectId'>): Promise<TCTemplate>;
}

export interface TestConditionRepository {
  listByProject(projectId: string): Promise<TestCondition[]>;
}

export interface TestCaseRepository {
  listByProject(projectId: string): Promise<TestCase[]>;
  updateStatus(id: string, status: TestCaseStatus): Promise<TestCase>;
}

export interface TestResultRepository {
  listImports(projectId: string): Promise<TestResultImport[]>;
  listResults(importId: string): Promise<TestResult[]>;
}

export interface CreateIssueInput {
  projectId: string;
  type: IssueType;
  title: string;
  feature?: string;
  testCaseId?: string;
  requirementId?: string;
  note?: string;
}

export interface IssueRepository {
  listByProject(projectId: string): Promise<Issue[]>;
  create(input: CreateIssueInput): Promise<Issue>;
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

export interface ChangeAnalysisRepository {
  /** 최신 분석부터 반환한다. 분석 결과는 제안이며 요구사항·TC를 바꾸지 않는다. */
  listByProject(projectId: string): Promise<ChangeAnalysis[]>;
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
  testResults: TestResultRepository;
  issues: IssueRepository;
  knowledge: KnowledgeRepository;
  scratch: ScratchRepository;
  changeAnalyses: ChangeAnalysisRepository;
  activities: ActivityRepository;
  calendar: CalendarRepository;
  /** 데이터가 바뀌면 호출된다. 반환 함수로 구독을 해제한다. */
  subscribe(listener: () => void): () => void;
}
