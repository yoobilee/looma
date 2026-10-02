import type { IssueStatus, IssueType, Platform, TestResultValue } from '@/domain/types';
import { isAppData, type AppData } from './appData';

/*
 * 저장된 데이터 검증. 화면에서 나중에 깨지지 않도록 변환 · 저장 전에 끝낸다.
 * 이슈 · 확인사항 변환에 쓰이는 엔티티(프로젝트 · 수행 차수 · 결과 · 이슈)의 구조 · 열거값 · 날짜 · 참조 필드 타입 · ID 중복만 확인한다.
 * 모르는 필드가 있다는 이유만으로는 실패시키지 않는다. 입력은 바꾸지 않는다.
 */

/** 저장된 데이터를 해석할 수 없다. 메시지는 어느 값이 왜 맞지 않는지(경로: 이유)다. */
export class StoredDataError extends Error {}

type Fields = Record<string, unknown>;

const fail = (path: string, reason: string): never => {
  throw new StoredDataError(`${path}: ${reason}`);
};

const isRecord = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);

function record(value: unknown, path: string): Fields {
  return isRecord(value) ? value : fail(path, '객체가 아니에요.');
}

function list(value: unknown, path: string): unknown[] {
  return Array.isArray(value) ? value : fail(path, '배열이 아니에요.');
}

function id(value: unknown, path: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fail(path, '비어 있지 않은 문자열이 아니에요.');
}

function text(value: unknown, path: string): string {
  return typeof value === 'string' ? value : fail(path, '문자열이 아니에요.');
}

function date(value: unknown, path: string): string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : fail(path, '날짜 문자열이 아니에요.');
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  return allowed.includes(value as T) ? (value as T) : fail(path, `알 수 없는 값이에요. (${String(value)})`);
}

/** 있으면 검사하고, 없으면(undefined) 넘어간다. */
function optional(item: Fields, key: string, path: string, check: (value: unknown, path: string) => unknown) {
  if (item[key] !== undefined) check(item[key], `${path}.${key}`);
}

function uniqueIds(items: Fields[], path: string) {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const value = id(item.id, `${path}[${index}].id`);
    if (seen.has(value)) fail(`${path}[${index}].id`, `ID가 겹쳐요. (${value})`);
    seen.add(value);
  });
}

const issueTypes: readonly IssueType[] = ['defect', 'question'];
export const v1IssueStatuses = ['open', 'fixed', 'closed', 'waiting', 'checking', 'answered'] as const;
const currentIssueStatuses: readonly IssueStatus[] = ['open', 'resolved', 'deferred'];
const resultValues: readonly TestResultValue[] = ['pass', 'fail', 'blocked', 'not_tested'];
const platforms: readonly Platform[] = ['android', 'ios', 'web', 'desktop'];

function checkProjects(value: unknown) {
  const projects = list(value, 'projects').map((item, index) => record(item, `projects[${index}]`));
  uniqueIds(projects, 'projects');
}

function checkResultImports(value: unknown) {
  const imports = list(value, 'resultImports').map((item, index) => record(item, `resultImports[${index}]`));
  uniqueIds(imports, 'resultImports');
  imports.forEach((item, index) => {
    const path = `resultImports[${index}]`;
    id(item.projectId, `${path}.projectId`);
    if (!Number.isInteger(item.round)) fail(`${path}.round`, '정수가 아니에요.');
  });
}

/** legacyLink: v1 결과의 이슈 연결(issueId)을 허용하는가. v2에는 없는 필드다. */
function checkResults(value: unknown, legacyLink: boolean) {
  const results = list(value, 'results').map((item, index) => record(item, `results[${index}]`));
  uniqueIds(results, 'results');
  results.forEach((item, index) => {
    const path = `results[${index}]`;
    id(item.importId, `${path}.importId`);
    text(item.feature, `${path}.feature`);
    text(item.title, `${path}.title`);
    oneOf(item.result, resultValues, `${path}.result`);
    optional(item, 'testCaseId', path, id);
    optional(item, 'externalId', path, text);
    optional(item, 'platform', path, (platform, at) => oneOf(platform, platforms, at));
    if (legacyLink) optional(item, 'issueId', path, id);
    else if ('issueId' in item) fail(`${path}.issueId`, 'v1 결과 연결 필드가 남아 있어요.');
  });
}

const issueTextFields = ['description', 'feature', 'externalKey', 'expected', 'actual', 'reproduction', 'note'];
const issueReferenceFields = ['testCaseId', 'requirementId'];

function checkIssues(value: unknown, version: 'v1' | 'current') {
  const issues = list(value, 'issues').map((item, index) => record(item, `issues[${index}]`));
  uniqueIds(issues, 'issues');
  issues.forEach((item, index) => {
    const path = `issues[${index}]`;
    id(item.projectId, `${path}.projectId`);
    oneOf(item.type, issueTypes, `${path}.type`);
    text(item.title, `${path}.title`);
    date(item.createdAt, `${path}.createdAt`);
    for (const key of issueTextFields) optional(item, key, path, text);
    for (const key of issueReferenceFields) optional(item, key, path, id);
    optional(item, 'sourceRef', path, (ref, at) => {
      const fields = record(ref, at);
      id(fields.deliverableId, `${at}.deliverableId`);
      text(fields.locator, `${at}.locator`);
    });
    optional(item, 'resolvedAt', path, date);
    if (version === 'v1') {
      oneOf(item.status, v1IssueStatuses, `${path}.status`);
      optional(item, 'updatedAt', path, date);
      // 결과 연결은 v2에서 생긴 필드다. v1에 있으면 어느 버전 데이터인지 알 수 없다.
      if ('resultId' in item) fail(`${path}.resultId`, 'v1에 없는 연결 필드예요.');
      return;
    }
    const status = oneOf(item.status, currentIssueStatuses, `${path}.status`);
    date(item.updatedAt, `${path}.updatedAt`);
    optional(item, 'resultId', path, id);
    if (item.resolvedAt !== undefined && status !== 'resolved') fail(`${path}.resolvedAt`, '해결되지 않은 항목에 해결 시각이 있어요.');
  });
}

/** v1(schemaVersion 1)로 해석할 수 있는 데이터인가. 이슈 목록은 없어도 된다(빈 목록으로 본다). 아니면 StoredDataError. */
export function assertV1AppData(data: unknown): Fields {
  const root = record(data, 'data');
  checkProjects(root.projects);
  checkResultImports(root.resultImports);
  checkResults(root.results, true);
  if (root.issues !== undefined) checkIssues(root.issues, 'v1');
  return root;
}

/** 현재 버전(v2) 데이터인가. 최상위 컬렉션이 모두 배열이고 이슈 · 결과가 v2 모양이어야 한다. 아니면 StoredDataError. */
export function assertCurrentAppData(data: unknown): AppData {
  if (!isAppData(data)) return fail('data', '최상위 컬렉션이 모두 배열이 아니에요.');
  checkProjects(data.projects);
  checkResultImports(data.resultImports);
  checkResults(data.results, false);
  checkIssues(data.issues, 'current');
  return data;
}

export function isCurrentAppData(data: unknown): data is AppData {
  try {
    assertCurrentAppData(data);
    return true;
  } catch (error) {
    if (error instanceof StoredDataError) return false;
    throw error;
  }
}
