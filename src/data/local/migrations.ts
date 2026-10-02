import type { IssueStatus } from '@/domain/types';
import { CURRENT_SCHEMA_VERSION, isAppData, type AppData } from './appData';

/** 한 버전을 다음 버전으로 바꾼다. 입력을 해석할 수 없으면 던진다. */
export type AppDataMigration = (data: unknown) => unknown;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * v1 이슈 상태 → v2 상태. v2는 확인 필요 · 해결됨 · 보류 셋만 쓴다.
 * - 질문 대기 · 답변 확인 중은 아직 확인이 끝나지 않았으므로 확인 필요다.
 * - 수정됨(fixed)은 개발 수정만 알려졌고 QA 재확인 전이라 확인 필요로 둔다(해결로 숨기지 않는다).
 * - 종료 · 확인 완료는 해결됨이다. 해결 시각은 v1에 없어 남기지 않는다(추측해 만들지 않는다).
 */
export const v1IssueStatusMapping: ReadonlyMap<string, IssueStatus> = new Map([
  ['open', 'open'],
  ['waiting', 'open'],
  ['checking', 'open'],
  ['fixed', 'open'],
  ['closed', 'resolved'],
  ['answered', 'resolved'],
]);

/**
 * v1 → v2: 이슈 · 확인사항 추적.
 * - 이슈 상태를 세 가지로 바꾸고, 없던 updatedAt은 createdAt으로 채운다.
 * - 결과 → 이슈 연결(TestResult.issueId)을 이슈 → 결과 연결(Issue.resultId)로 옮기고 결과에서는 지운다. 연결은 한 곳에만 둔다.
 *   한 이슈를 가리키는 결과가 하나이고, 같은 프로젝트이며, TC가 서로 어긋나지 않을 때만 옮긴다.
 *   여러 결과가 같은 이슈를 가리키거나 맞지 않으면 어느 결과인지 고르지 않고 연결하지 않는다(이슈의 TC 연결은 그대로).
 * - 이슈 목록이 없으면 빈 목록으로 둔다.
 * - 알 수 없는 이슈 상태 · 모양이면 던져서 변환을 멈춘다. 저장된 데이터는 바꾸지 않는다.
 * 입력은 바꾸지 않고 새 객체를 돌려준다.
 */
export function migrateV1ToV2(data: unknown): unknown {
  const legacyIssues = isRecord(data) && data.issues === undefined ? [] : isRecord(data) ? data.issues : undefined;
  if (!isRecord(data) || !Array.isArray(legacyIssues) || !Array.isArray(data.results) || !Array.isArray(data.resultImports)) {
    throw new Error('v1 데이터 모양이 아니에요.');
  }
  const projectOfImport = new Map<unknown, unknown>();
  for (const item of data.resultImports) {
    if (!isRecord(item)) throw new Error('수행 차수 모양이 아니에요.');
    projectOfImport.set(item.id, item.projectId);
  }

  const referencingResults = new Map<unknown, Record<string, unknown>[]>();
  for (const result of data.results) {
    if (!isRecord(result)) throw new Error('수행 결과 모양이 아니에요.');
    if (result.issueId === undefined) continue;
    referencingResults.set(result.issueId, [...(referencingResults.get(result.issueId) ?? []), result]);
  }

  const issues = legacyIssues.map((issue) => {
    if (!isRecord(issue) || typeof issue.createdAt !== 'string') throw new Error('이슈 모양이 아니에요.');
    const status = v1IssueStatusMapping.get(issue.status as string);
    if (!status) throw new Error(`알 수 없는 이슈 상태예요. (${String(issue.status)})`);
    const next: Record<string, unknown> = { ...issue, status, updatedAt: issue.createdAt };
    const references = referencingResults.get(issue.id) ?? [];
    const [result] = references;
    const linkable =
      references.length === 1 &&
      projectOfImport.get(result.importId) === issue.projectId &&
      (issue.testCaseId === undefined || issue.testCaseId === result.testCaseId);
    if (linkable) {
      next.resultId = result.id;
      if (result.testCaseId !== undefined) next.testCaseId = result.testCaseId;
    }
    return next;
  });

  const results = data.results.map((result) => {
    const next = { ...(result as Record<string, unknown>) };
    delete next.issueId;
    return next;
  });

  return { ...data, issues, results };
}

/** 키는 출발 버전이다. 구조를 바꿀 때 CURRENT_SCHEMA_VERSION을 올리고 여기에 변환을 더한다. */
export const appDataMigrations: Readonly<Record<number, AppDataMigration>> = {
  1: migrateV1ToV2,
};

export type MigrationOutcome =
  | { status: 'current'; data: AppData }
  | { status: 'migrated'; data: AppData; fromVersion: number }
  /** 이 앱보다 새 버전이거나 변환 경로가 없는 버전 */
  | { status: 'unsupported'; version: number }
  | { status: 'failed'; version: number }
  /** 현재 버전인데 모양이 맞지 않는다 */
  | { status: 'corrupt' };

interface MigrationOptions {
  currentVersion?: number;
  migrations?: Readonly<Record<number, AppDataMigration>>;
}

/**
 * 저장된 버전에서 현재 버전까지 한 단계씩 변환한다. 저장소에는 손대지 않는다.
 * 실패하면 결과만 돌려주고, 저장된 데이터를 지우거나 덮어쓰는 판단은 사용자에게 맡긴다.
 */
export function migrateAppData(version: number, data: unknown, options: MigrationOptions = {}): MigrationOutcome {
  const currentVersion = options.currentVersion ?? CURRENT_SCHEMA_VERSION;
  const migrations = options.migrations ?? appDataMigrations;
  if (!Number.isInteger(version) || version < 1 || version > currentVersion) return { status: 'unsupported', version };

  if (version === currentVersion) return isAppData(data) ? { status: 'current', data } : { status: 'corrupt' };

  let working = data;
  for (let step = version; step < currentVersion; step += 1) {
    const migrate = migrations[step];
    if (!migrate) return { status: 'unsupported', version };
    try {
      working = migrate(working);
    } catch {
      return { status: 'failed', version };
    }
  }
  return isAppData(working) ? { status: 'migrated', data: working, fromVersion: version } : { status: 'failed', version };
}
