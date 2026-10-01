import { PersistenceError } from '../persistenceError';
import type { AppData, StoredAppState } from './appData';

/** 원본 파일 bytes 하나. 상태(JSON)와 같은 transaction으로 저장한다. */
export interface ArtifactBytesInput {
  id: string;
  bytes: Blob;
}

export interface CommitInput {
  /** 이 탭이 마지막으로 읽거나 저장한 revision. 저장소의 revision과 다르면 쓰지 않는다. */
  expectedRevision: number;
  schemaVersion: number;
  savedAt: string;
  data: AppData;
  artifacts?: ArtifactBytesInput[];
}

export interface SavedRevision {
  revision: number;
  savedAt: string;
}

/**
 * 앱 상태와 원본 파일 bytes의 저장 경계. 지금은 브라우저 IndexedDB 구현을 쓰고,
 * 이후 상태 → DB, bytes → Storage로 나눠 교체할 수 있다. 모든 쓰기는 전부 되거나 전혀 안 된다.
 */
export interface StateStore {
  /** 저장된 상태. 없으면 undefined. 모양은 확인하지 않는다(읽는 쪽이 확인한다). */
  read(): Promise<unknown>;
  /** 상태가 없을 때만 저장한다. 다른 탭이 먼저 만들었으면 그 상태를 돌려준다. */
  initialize(state: StoredAppState): Promise<unknown>;
  /**
   * 저장된 revision이 expectedRevision과 같을 때만 원본 bytes와 상태를 한 transaction으로 쓴다.
   * 다르면 conflict로 거부하고 아무것도 쓰지 않는다.
   */
  commit(input: CommitInput): Promise<SavedRevision>;
  /** 저장된 상태와 원본 bytes를 모두 지우고 새 상태를 쓴다. revision은 이전보다 커서 다른 탭이 변경을 알 수 있다. */
  replaceAll(input: Omit<CommitInput, 'expectedRevision' | 'artifacts'>): Promise<SavedRevision>;
  readArtifactBytes(id: string): Promise<Blob | undefined>;
}

/** 다음 revision. 저장된 값이 손상돼 revision을 읽을 수 없으면 1부터 다시 센다. */
export function nextRevisionAfter(stored: unknown): number {
  const revision = (stored as { revision?: unknown } | undefined)?.revision;
  return Number.isInteger(revision) && (revision as number) >= 1 ? (revision as number) + 1 : 1;
}

/**
 * 메모리 구현. 테스트와 mock 저장소에서 쓴다. IndexedDB 구현과 같은 규칙(revision 확인, 전부 또는 전혀)을 지킨다.
 * 저장할 때 복사해 두어 호출한 쪽이 객체를 바꿔도 저장된 값이 바뀌지 않는다.
 */
export function createMemoryStateStore(initial?: StoredAppState): StateStore & { inspect(): { state: unknown; artifactIds: string[] } } {
  let state: unknown = initial ? structuredClone(initial) : undefined;
  const artifacts = new Map<string, Blob>();

  return {
    async read() {
      return state === undefined ? undefined : structuredClone(state);
    },
    async initialize(next) {
      if (state === undefined) state = structuredClone(next);
      return structuredClone(state);
    },
    async commit(input) {
      const stored = state as StoredAppState | undefined;
      if (!stored || stored.revision !== input.expectedRevision) throw new PersistenceError('conflict');
      const revision = stored.revision + 1;
      const next: StoredAppState = { schemaVersion: input.schemaVersion, revision, savedAt: input.savedAt, data: structuredClone(input.data) };
      for (const artifact of input.artifacts ?? []) artifacts.set(artifact.id, artifact.bytes);
      state = next;
      return { revision, savedAt: input.savedAt };
    },
    async replaceAll(input) {
      const revision = nextRevisionAfter(state);
      const next: StoredAppState = { schemaVersion: input.schemaVersion, revision, savedAt: input.savedAt, data: structuredClone(input.data) };
      artifacts.clear();
      state = next;
      return { revision, savedAt: input.savedAt };
    },
    async readArtifactBytes(id) {
      return artifacts.get(id);
    },
    inspect() {
      return { state: state === undefined ? undefined : structuredClone(state), artifactIds: [...artifacts.keys()] };
    },
  };
}
