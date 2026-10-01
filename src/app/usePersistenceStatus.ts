import { useSyncExternalStore } from 'react';
import { repositories } from '@/data';
import type { PersistenceStatus } from '@/data/repositories/types';

/** 로컬 저장 상태(불러오는 중 · 사용 가능 · 막힘)를 구독한다. */
export function usePersistenceStatus(): PersistenceStatus {
  return useSyncExternalStore(repositories.persistence.subscribe, repositories.persistence.getStatus);
}
