import type { IssueStatus } from '@/domain/types';
import { CURRENT_SCHEMA_VERSION, type AppData } from './appData';
import { assertCurrentAppData, assertV1AppData, isCurrentAppData, StoredDataError } from './schemaValidation';

/** 한 버전을 다음 버전으로 바꾼다. 입력을 해석할 수 없으면 던진다. */
export type AppDataMigration = (data: unknown) => unknown;

type Fields = Record<string, unknown>;

/** v1의 결과 → 이슈 연결을 잃지 않고 옮길 수 없다. */
export class LegacyLinkError extends StoredDataError {}

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
 * v1 → v2: 이슈 · 확인사항 추적. 해석할 수 있는 v1 데이터만 v2로 올리고, 아니면 던져서 변환을 멈춘다(저장된 v1은 그대로).
 * 1) v1 모양 검증(assertV1AppData): 구조 · 열거값 · 날짜 · 참조 필드 타입 · ID 중복. 모르는 필드는 그대로 둔다.
 * 2) 이슈 상태를 세 가지로 바꾸고, 없던 updatedAt은 createdAt으로 채운다. 해결 시각은 만들지 않는다.
 * 3) 결과 → 이슈 연결(TestResult.issueId)을 이슈 → 결과 연결(Issue.resultId)로 옮기고 결과에서는 지운다.
 *    옮길 수 있는 연결은 1:1뿐이다: 그 이슈가 있고, 한 이슈를 결과 하나만 가리키며, 결과의 차수가 같은 프로젝트이고, TC가 어긋나지 않는다.
 *    하나라도 아니면(없는 이슈 · 같은 이슈를 여러 결과가 가리킴 · 다른 프로젝트 · 다른 TC) 결과를 고르거나 연결을 지우지 않고 변환 전체를 멈춘다.
 *    v2에는 결과 쪽 연결 필드가 없어, 옮기지 못한 연결을 지우면 원래 관계를 다시 알 수 없기 때문이다.
 * 4) 결과가 현재 버전 검증(assertCurrentAppData)을 통과해야 한다.
 * 결과는 배열 순서와 무관하다. 입력은 바꾸지 않고 새 객체를 돌려준다.
 */
export function migrateV1ToV2(data: unknown): unknown {
  const root = assertV1AppData(data);
  const legacyIssues = (root.issues ?? []) as Fields[];
  const results = root.results as Fields[];
  const projectOfImport = new Map((root.resultImports as Fields[]).map((item) => [item.id, item.projectId]));
  const issueById = new Map(legacyIssues.map((issue) => [issue.id, issue]));

  const referencingResults = new Map<unknown, Fields[]>();
  for (const result of results) {
    if (result.issueId === undefined) continue;
    referencingResults.set(result.issueId, [...(referencingResults.get(result.issueId) ?? []), result]);
  }
  const linkOf = new Map<unknown, Fields>();
  for (const [issueId, references] of referencingResults) {
    const at = `결과 ${references.map((result) => String(result.id)).sort().join(', ')} → 이슈 ${String(issueId)}`;
    const issue = issueById.get(issueId);
    if (!issue) throw new LegacyLinkError(`${at}: 없는 이슈를 가리켜요.`);
    if (references.length > 1) throw new LegacyLinkError(`${at}: 한 이슈를 결과 여러 개가 가리켜요.`);
    const [result] = references;
    if (projectOfImport.get(result.importId) !== issue.projectId) throw new LegacyLinkError(`${at}: 결과의 차수가 이슈와 다른 프로젝트예요.`);
    if (issue.testCaseId !== undefined && issue.testCaseId !== result.testCaseId) throw new LegacyLinkError(`${at}: 결과의 TC와 이슈의 TC가 달라요.`);
    linkOf.set(issueId, result);
  }

  const issues = legacyIssues.map((issue) => {
    const next: Fields = { ...issue, status: v1IssueStatusMapping.get(issue.status as string), updatedAt: issue.updatedAt ?? issue.createdAt };
    const result = linkOf.get(issue.id);
    if (result) {
      next.resultId = result.id;
      if (result.testCaseId !== undefined) next.testCaseId = result.testCaseId;
    }
    return next;
  });
  const migratedResults = results.map((result) => {
    const next = { ...result };
    delete next.issueId;
    return next;
  });

  return assertCurrentAppData({ ...root, issues, results: migratedResults });
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
  /** 현재 버전이라고 적혀 있는데 현재 버전 검증을 통과하지 못한다(이전 버전 모양 포함) */
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

  // 버전 표기만 믿지 않는다. 현재 버전이라도 현재 모양이 아니면(예: v2로 적힌 v1 모양) 읽지 않는다.
  if (version === currentVersion) return isCurrentAppData(data) ? { status: 'current', data } : { status: 'corrupt' };

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
  // 변환 결과도 저장하기 전에 현재 버전 검증을 통과해야 한다.
  return isCurrentAppData(working) ? { status: 'migrated', data: working, fromVersion: version } : { status: 'failed', version };
}
