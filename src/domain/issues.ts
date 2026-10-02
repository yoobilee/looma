import type { Issue, IssueStatus, IssueType, TestResult, TestResultImport } from './types';

/*
 * 이슈 · 확인사항 규칙. 저장소와 화면이 같은 규칙을 쓰도록 순수 함수로 둔다. 입력은 바꾸지 않는다.
 * - 결과에서 만든 항목은 그 결과(resultId)와 결과의 TC(testCaseId)를 가리킨다. 고객사 TC ID로 결과를 찾지 않는다.
 * - 결과 상태 · 차수 · 플랫폼은 결과에서 읽고 이슈에 복사하지 않는다.
 * - 연결(프로젝트 · TC · 결과 · 요구사항)은 만든 뒤 바꾸지 않는다.
 * - 이후 수행 결과가 PASS여도 자동으로 해결 처리하지 않는다. 해결은 사용자가 판단한다.
 */

export const issueTypes: IssueType[] = ['defect', 'question'];
export const issueStatuses: IssueStatus[] = ['open', 'resolved', 'deferred'];

/** 만들 때 받는 값 */
export interface IssueDraft {
  projectId: string;
  type: IssueType;
  title: string;
  description?: string;
  feature?: string;
  testCaseId?: string;
  resultId?: string;
  requirementId?: string;
  expected?: string;
  actual?: string;
  reproduction?: string;
  note?: string;
}

/** 고칠 수 있는 값. 연결 필드는 없다. */
export type IssueChanges = Partial<Pick<Issue, 'type' | 'status' | 'title' | 'description' | 'expected' | 'actual' | 'reproduction' | 'note'>>;

const optionalTextFields = ['description', 'expected', 'actual', 'reproduction', 'note'] as const;

/** 앞뒤 공백을 지우고, 비었으면 없는 값으로 본다. */
const cleanText = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const requireTitle = (value: string | undefined): string => {
  const title = cleanText(value);
  if (!title) throw new Error('제목을 입력해 주세요.');
  return title;
};

/**
 * 새 이슈 · 확인사항. 상태는 확인 필요(open)로 시작한다.
 * resultId가 있으면 그 결과(link.result)가 꼭 있어야 하고, TC는 결과의 TC를 쓴다. 입력 TC가 결과의 TC와 다르면 거부한다.
 */
export function buildIssue(draft: IssueDraft, link: { result?: TestResult }, meta: { id: string; now: string }): Issue {
  const title = requireTitle(draft.title);
  if (!draft.resultId && link.result) throw new Error('연결할 수행 결과가 지정되지 않았어요.');
  if (draft.resultId && link.result?.id !== draft.resultId) throw new Error(`수행 결과를 찾을 수 없어요. (${draft.resultId})`);
  const result = link.result;
  if (result && draft.testCaseId && draft.testCaseId !== result.testCaseId) throw new Error('수행 결과의 TC와 다른 TC를 연결할 수 없어요.');
  const testCaseId = result ? result.testCaseId : draft.testCaseId;

  const issue: Issue = {
    id: meta.id,
    projectId: draft.projectId,
    type: draft.type,
    title,
    status: 'open',
    createdAt: meta.now,
    updatedAt: meta.now,
  };
  const feature = cleanText(draft.feature);
  if (feature) issue.feature = feature;
  if (testCaseId) issue.testCaseId = testCaseId;
  if (result) issue.resultId = result.id;
  if (draft.requirementId) issue.requirementId = draft.requirementId;
  for (const field of optionalTextFields) {
    const value = cleanText(draft[field]);
    if (value) issue[field] = value;
  }
  return issue;
}

export interface IssueChangeOutcome {
  issue: Issue;
  /** 하나라도 바뀌었는가. 아니면 저장하지 않는다. */
  changed: boolean;
}

/**
 * 고친 새 객체를 돌려준다(입력은 그대로). 고칠 수 있는 필드만 보고 나머지(연결 · 생성 시각 등)는 무시한다.
 * - 상태 전환은 open · resolved · deferred 사이 어느 방향이든 된다.
 * - resolved에 들어가면 resolvedAt을 지금으로 쓰고, 다른 상태로 나가면 지운다. 다시 resolved가 되면 새 시각이다.
 * - 바뀐 것이 있을 때만 updatedAt을 지금으로 바꾼다.
 */
export function applyIssueChanges(issue: Issue, changes: IssueChanges, now: string): IssueChangeOutcome {
  const next: Issue = { ...issue };
  if (changes.title !== undefined) next.title = requireTitle(changes.title);
  if (changes.type !== undefined) {
    if (!issueTypes.includes(changes.type)) throw new Error(`알 수 없는 유형이에요. (${changes.type})`);
    next.type = changes.type;
  }
  for (const field of optionalTextFields) {
    if (!(field in changes)) continue;
    const value = cleanText(changes[field]);
    if (value) next[field] = value;
    else delete next[field];
  }
  if (changes.status !== undefined && changes.status !== issue.status) {
    if (!issueStatuses.includes(changes.status)) throw new Error(`알 수 없는 상태예요. (${changes.status})`);
    next.status = changes.status;
    if (changes.status === 'resolved') next.resolvedAt = now;
    else delete next.resolvedAt;
  }

  const fields = ['title', 'type', 'status', ...optionalTextFields] as const;
  const changed = fields.some((field) => next[field] !== issue[field]);
  if (!changed) return { issue: { ...issue }, changed: false };
  next.updatedAt = now;
  return { issue: next, changed: true };
}

export interface LaterResult {
  result: TestResult;
  resultImport: TestResultImport;
}

/**
 * 연결된 결과 뒤에 같은 TC · 같은 플랫폼으로 수행한 결과(차수 오름차순). 재시험 결과를 보여 주기만 하고 이슈를 바꾸지 않는다.
 * TC에 연결되지 않은 결과는 어느 TC인지 알 수 없어 고객사 TC ID로 추측하지 않고 빈 목록을 돌려준다.
 */
export function laterResultsFor(linked: TestResult, imports: TestResultImport[], results: TestResult[]): LaterResult[] {
  if (!linked.testCaseId) return [];
  const linkedImport = imports.find((item) => item.id === linked.importId);
  if (!linkedImport) return [];
  const importById = new Map(imports.filter((item) => item.projectId === linkedImport.projectId).map((item) => [item.id, item]));
  return results
    .filter((result) => result.id !== linked.id && result.testCaseId === linked.testCaseId && (result.platform ?? null) === (linked.platform ?? null))
    .flatMap((result) => {
      const resultImport = importById.get(result.importId);
      return resultImport && resultImport.round > linkedImport.round ? [{ result, resultImport }] : [];
    })
    .sort((a, b) => a.resultImport.round - b.resultImport.round);
}
