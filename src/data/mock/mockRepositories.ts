import type { Repositories } from '../repositories/types';
import { CURRENT_SCHEMA_VERSION } from '../local/appData';
import { createLocalRepositories } from '../local/localRepositories';
import { createMemoryStateStore } from '../local/stateStore';
import { createSeed, type SeedData } from './seed';

/**
 * 메모리 저장소로 바로 시작하는 저장소. 브라우저 저장 없이 같은 규칙(복사본에서 계산 → 저장 성공 시 반영)으로 동작한다.
 * 테스트와 저장하지 않는 환경에서 쓴다.
 */
export function createMockRepositories(seed: SeedData = createSeed()): Repositories {
  const state = { schemaVersion: CURRENT_SCHEMA_VERSION, revision: 1, savedAt: new Date().toISOString(), data: structuredClone(seed) };
  return createLocalRepositories({
    openStore: async () => createMemoryStateStore(state),
    preloaded: { store: createMemoryStateStore(state), state, mode: 'memory' },
  });
}
