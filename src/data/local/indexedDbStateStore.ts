import { PersistenceError, toPersistenceError } from '../persistenceError';
import type { StoredAppState } from './appData';
import { nextRevisionAfter, type CommitInput, type SavedRevision, type StateStore } from './stateStore';

/*
 * 브라우저 IndexedDB 저장소. 새 의존성 없이 표준 API만 쓴다.
 * - state: 앱 상태 전체 한 레코드(key: app-state). 원본 파일 bytes는 넣지 않는다.
 * - artifactBytes: 원본 파일 bytes(key: artifactId, value: Blob). base64 · 문자열로 바꾸지 않는다.
 * 쓰기는 두 store를 한 transaction으로 묶어 상태와 원본 파일이 함께 저장되거나 함께 저장되지 않는다.
 */

const DB_NAME = 'looma';
const DB_VERSION = 1;
const STATE_STORE = 'state';
const ARTIFACT_STORE = 'artifactBytes';
const STATE_KEY = 'app-state';

const requestResult = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/** transaction이 끝까지 저장되면 resolve, 중단되거나 실패하면 reject. */
const transactionDone = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });

export function openIndexedDbStateStore(factory: IDBFactory | undefined = globalThis.indexedDB): Promise<StateStore> {
  if (!factory) return Promise.reject(new PersistenceError('unavailable'));

  return new Promise<StateStore>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DB_NAME, DB_VERSION);
    } catch {
      reject(new PersistenceError('unavailable'));
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STATE_STORE)) database.createObjectStore(STATE_STORE);
      if (!database.objectStoreNames.contains(ARTIFACT_STORE)) database.createObjectStore(ARTIFACT_STORE);
    };
    request.onerror = () => reject(new PersistenceError('unavailable'));
    request.onblocked = () => reject(new PersistenceError('unavailable', '다른 탭의 이전 Looma가 저장소를 사용 중이에요. 다른 Looma 탭을 닫은 뒤 새로고침해 주세요.'));
    request.onsuccess = () => {
      const database = request.result;
      // 다른 탭이 저장소 버전을 올리려 하면 연결을 닫아 막지 않는다. 이후 쓰기는 실패로 알린다.
      database.onversionchange = () => database.close();
      resolve(createStore(database));
    };
  });
}

function createStore(database: IDBDatabase): StateStore {
  const begin = (stores: string[], mode: IDBTransactionMode) => {
    try {
      return database.transaction(stores, mode);
    } catch {
      throw new PersistenceError(mode === 'readonly' ? 'read_failed' : 'write_failed');
    }
  };

  return {
    async read() {
      try {
        const transaction = begin([STATE_STORE], 'readonly');
        return await requestResult(transaction.objectStore(STATE_STORE).get(STATE_KEY));
      } catch (error) {
        throw toPersistenceError(error, 'read_failed');
      }
    },

    async initialize(state) {
      try {
        const transaction = begin([STATE_STORE], 'readwrite');
        const store = transaction.objectStore(STATE_STORE);
        let result: unknown;
        // 읽기와 쓰기를 한 transaction 안에서 해 두 탭이 동시에 처음 열어도 먼저 만든 상태 하나만 남는다.
        store.get(STATE_KEY).onsuccess = (event) => {
          const existing = (event.target as IDBRequest).result;
          if (existing === undefined) {
            store.put(state, STATE_KEY);
            result = state;
          } else {
            result = existing;
          }
        };
        await transactionDone(transaction);
        return result;
      } catch (error) {
        throw toPersistenceError(error, 'write_failed');
      }
    },

    async commit(input: CommitInput): Promise<SavedRevision> {
      let conflict = false;
      let revision = 0;
      try {
        const transaction = begin([STATE_STORE, ARTIFACT_STORE], 'readwrite');
        const states = transaction.objectStore(STATE_STORE);
        const artifacts = transaction.objectStore(ARTIFACT_STORE);
        // revision 확인과 쓰기를 같은 transaction에서 한다. 확인 뒤 다른 탭이 끼어들 틈이 없다.
        states.get(STATE_KEY).onsuccess = (event) => {
          const stored = (event.target as IDBRequest).result as StoredAppState | undefined;
          if (!stored || stored.revision !== input.expectedRevision) {
            conflict = true;
            transaction.abort();
            return;
          }
          revision = stored.revision + 1;
          for (const artifact of input.artifacts ?? []) artifacts.put(artifact.bytes, artifact.id);
          const next: StoredAppState = { schemaVersion: input.schemaVersion, revision, savedAt: input.savedAt, data: input.data };
          states.put(next, STATE_KEY);
        };
        await transactionDone(transaction);
        return { revision, savedAt: input.savedAt };
      } catch (error) {
        if (conflict) throw new PersistenceError('conflict');
        throw toPersistenceError(error, 'write_failed');
      }
    },

    async replaceAll(input) {
      let revision = 0;
      try {
        const transaction = begin([STATE_STORE, ARTIFACT_STORE], 'readwrite');
        const states = transaction.objectStore(STATE_STORE);
        states.get(STATE_KEY).onsuccess = (event) => {
          revision = nextRevisionAfter((event.target as IDBRequest).result);
          transaction.objectStore(ARTIFACT_STORE).clear();
          const next: StoredAppState = { schemaVersion: input.schemaVersion, revision, savedAt: input.savedAt, data: input.data };
          states.put(next, STATE_KEY);
        };
        await transactionDone(transaction);
        return { revision, savedAt: input.savedAt };
      } catch (error) {
        throw toPersistenceError(error, 'write_failed');
      }
    },

    async readArtifactBytes(id) {
      try {
        const transaction = begin([ARTIFACT_STORE], 'readonly');
        const value = await requestResult(transaction.objectStore(ARTIFACT_STORE).get(id));
        return value instanceof Blob ? value : undefined;
      } catch (error) {
        throw toPersistenceError(error, 'read_failed');
      }
    },
  };
}
