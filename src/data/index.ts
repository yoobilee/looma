import { openIndexedDbStateStore } from './local/indexedDbStateStore';
import { createLocalRepositories } from './local/localRepositories';
import { createBroadcastStateChannel } from './local/stateChannel';
import type { Repositories } from './repositories/types';

// 브라우저 IndexedDB에 저장한다. 실제 backend가 준비되면 이 구현만 교체한다.
// 화면은 repositories.persistence가 ready가 된 뒤에만 띄운다(PersistenceGate).
export const repositories: Repositories = createLocalRepositories({
  openStore: () => openIndexedDbStateStore(),
  channel: createBroadcastStateChannel(),
});

export type { Repositories } from './repositories/types';
