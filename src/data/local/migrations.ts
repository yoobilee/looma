import { CURRENT_SCHEMA_VERSION, isAppData, type AppData } from './appData';

/** 한 버전을 다음 버전으로 바꾼다. 입력을 해석할 수 없으면 던진다. */
export type AppDataMigration = (data: unknown) => unknown;

/**
 * 키는 출발 버전이다. 예: { 1: migrateV1ToV2, 2: migrateV2ToV3 }
 * 아직 v1뿐이라 변환이 없다. 구조를 바꿀 때 CURRENT_SCHEMA_VERSION을 올리고 여기에 변환을 더한다.
 */
export const appDataMigrations: Readonly<Record<number, AppDataMigration>> = {};

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
