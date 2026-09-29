import { createMockRepositories } from './mock/mockRepositories';
import type { Repositories } from './repositories/types';

// 실제 backend가 준비되면 이 한 줄만 교체한다.
export const repositories: Repositories = createMockRepositories();

export type { Repositories } from './repositories/types';
