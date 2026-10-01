import type { SeedData } from '../mock/seed';

/**
 * 저장소가 소유한 앱 상태 전체. 서로 참조하는 엔티티(TC ↔ 가져오기 ↔ 결과 ↔ 활동 등)를 한 단위로 저장해야
 * 새로고침 뒤에도 참조가 어긋나지 않는다. 원본 파일 bytes는 여기 넣지 않고 따로 저장한다.
 */
export type AppData = SeedData;

/** 저장된 상태의 형식 버전. AppData 구조가 바뀌면 올리고 migrations에 이전 버전 변환을 추가한다. */
export const CURRENT_SCHEMA_VERSION = 1;

/** 저장소에 들어가는 한 레코드. revision은 저장할 때마다 1씩 오르며 여러 탭의 덮어쓰기를 막는다. */
export interface StoredAppState {
  schemaVersion: number;
  revision: number;
  savedAt: string;
  data: unknown;
}

// 키를 빠뜨리면 타입 오류가 난다. 저장된 상태가 AppData 모양인지 확인할 때 쓴다.
const appDataShape: Record<keyof AppData, true> = {
  projects: true,
  tasks: true,
  deliverables: true,
  requirements: true,
  templates: true,
  testConditions: true,
  testCases: true,
  testAssetImports: true,
  importSourceArtifacts: true,
  changeAnalyses: true,
  resultImports: true,
  results: true,
  issues: true,
  knowledge: true,
  scratch: true,
  activities: true,
  calendarEvents: true,
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** 최상위 컬렉션이 모두 배열인지만 본다. 엔티티 내부 검증은 하지 않는다. */
export function isAppData(value: unknown): value is AppData {
  return isRecord(value) && Object.keys(appDataShape).every((key) => Array.isArray(value[key]));
}

export function isStoredAppState(value: unknown): value is StoredAppState {
  return (
    isRecord(value) &&
    Number.isInteger(value.schemaVersion) &&
    Number.isInteger(value.revision) &&
    (value.revision as number) >= 1 &&
    typeof value.savedAt === 'string' &&
    'data' in value
  );
}
