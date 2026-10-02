import type { Repositories } from '@/data';
import { deliverableTypeLabel } from '@/domain/labels';
import type { Deliverable, Issue, IssueStatus, TestCase, TestResult, TestResultImport } from '@/domain/types';

/*
 * 이슈 · 확인사항 화면 전용 규칙: 필터 · 목록 순서 · 연결 표시. 저장하지 않고 매번 계산한다.
 * 연결 표시(TC ID · 제목 · 차수 · 플랫폼 · 결과 상태)는 지금의 TC · 결과에서 읽는다. 이슈에 복사해 두지 않는다.
 */

export type IssueFilter = 'all' | 'defect' | 'question' | IssueStatus;

export const issueFilters: IssueFilter[] = ['all', 'defect', 'question', 'open', 'resolved', 'deferred'];

export function matchesIssueFilter(issue: Pick<Issue, 'type' | 'status'>, filter: IssueFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'defect' || filter === 'question') return issue.type === filter;
  return issue.status === filter;
}

export const isIssueFilter = (value: string | null): value is IssueFilter => issueFilters.includes(value as IssueFilter);

/** 목록 순서. 확인 필요 → 보류 → 해결됨. 앞일수록 먼저 본다. */
const statusRank: Record<IssueStatus, number> = { open: 0, deferred: 1, resolved: 2 };

/** 상태 순서 → 최근 생성 순. 입력은 바꾸지 않는다. */
export function sortIssues<T extends Pick<Issue, 'status' | 'createdAt' | 'id'>>(issues: T[]): T[] {
  return [...issues].sort(
    (a, b) => statusRank[a.status] - statusRank[b.status] || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || a.id.localeCompare(b.id),
  );
}

/** 한 프로젝트의 TC · 수행 차수 · 결과. 이슈의 연결을 찾을 때 쓴다. */
export interface IssueLinkContext {
  testCases: TestCase[];
  imports: TestResultImport[];
  results: TestResult[];
}

export interface IssueLinks {
  testCase?: TestCase;
  result?: TestResult;
  resultImport?: TestResultImport;
}

export interface IssueLinkIndex {
  linksOf(issue: Pick<Issue, 'testCaseId' | 'resultId'>): IssueLinks;
}

/** id로 찾는 색인. 결과의 TC를 고객사 TC ID로 추측하지 않고, 저장된 id만 따라간다. */
export function indexIssueLinks({ testCases, imports, results }: IssueLinkContext): IssueLinkIndex {
  const testCaseById = new Map(testCases.map((item) => [item.id, item]));
  const importById = new Map(imports.map((item) => [item.id, item]));
  const resultById = new Map(results.map((item) => [item.id, item]));
  return {
    linksOf(issue) {
      const result = issue.resultId ? resultById.get(issue.resultId) : undefined;
      const testCaseId = issue.testCaseId ?? result?.testCaseId;
      return {
        ...(testCaseId && testCaseById.has(testCaseId) && { testCase: testCaseById.get(testCaseId) }),
        ...(result && { result }),
        ...(result && importById.has(result.importId) && { resultImport: importById.get(result.importId) }),
      };
    },
  };
}

/** 근거 산출물 위치. 저장된 sourceRef를 그대로 보여 준다. 산출물을 찾지 못하면 위치만 있다. */
export interface IssueSource {
  deliverable?: Deliverable;
  locator: string;
}

export function sourceOf(issue: Pick<Issue, 'sourceRef'>, deliverables: Deliverable[]): IssueSource | undefined {
  if (!issue.sourceRef) return undefined;
  const deliverable = deliverables.find((item) => item.id === issue.sourceRef!.deliverableId);
  return { ...(deliverable && { deliverable }), locator: issue.sourceRef.locator };
}

/** 목록용 짧은 근거 표기(예: PDF p.14). */
export const shortSourceLabel = (source: IssueSource) => `${source.deliverable ? deliverableTypeLabel[source.deliverable.type] : '산출물'} ${source.locator}`.trim();

/** 같은 결과에 이미 만든 항목. 여러 개를 허용하고 막지 않는다(표시만 한다). */
export function issuesByResult(issues: Issue[]): Map<string, Issue[]> {
  const map = new Map<string, Issue[]>();
  for (const issue of issues) {
    if (!issue.resultId) continue;
    map.set(issue.resultId, [...(map.get(issue.resultId) ?? []), issue]);
  }
  return map;
}

/** 이슈 화면 · 결과 화면이 함께 쓰는 데이터. 결과 · TC는 읽기만 한다. */
export async function loadIssueContext(repos: Repositories, projectId: string) {
  const [issues, testCases, imports] = await Promise.all([repos.issues.listByProject(projectId), repos.testCases.listByProject(projectId), repos.testResults.listImports(projectId)]);
  const results = (await Promise.all(imports.map((item) => repos.testResults.listResults(item.id)))).flat();
  return { issues, testCases, imports, results };
}

/** 결과 화면으로 가는 주소. 그 차수를 먼저 보여 준다(가져오기 이력과 같은 방식). */
export const resultRoundPath = (projectId: string, importId: string) => `/projects/${projectId}/results?import=${encodeURIComponent(importId)}`;
/** 테스트 설계에서 그 TC를 펼쳐 보여 준다. */
export const testCasePath = (projectId: string, testCaseId: string) => `/projects/${projectId}/test-design?tc=${encodeURIComponent(testCaseId)}`;
export const issuePath = (projectId: string, issueId: string) => `/projects/${projectId}/issues?issue=${encodeURIComponent(issueId)}`;
