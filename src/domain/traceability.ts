import type { Deliverable } from './types';

/**
 * 산출물의 revision 이력을 오래된 버전부터 순서대로 돌려준다.
 * 지정한 산출물 이후의 새 버전도 포함한다. 별도 신규 산출물은 자기 자신만 반환한다.
 */
export function deliverableRevisionChain(deliverables: Deliverable[], id: string): Deliverable[] {
  const byId = new Map(deliverables.map((item) => [item.id, item]));
  const start = byId.get(id);
  if (!start) return [];

  const older: Deliverable[] = [];
  const visited = new Set([start.id]);
  let previous = start.previousRevisionId ? byId.get(start.previousRevisionId) : undefined;
  while (previous && !visited.has(previous.id)) {
    visited.add(previous.id);
    older.unshift(previous);
    previous = previous.previousRevisionId ? byId.get(previous.previousRevisionId) : undefined;
  }

  const newer: Deliverable[] = [];
  let next = deliverables.find((item) => item.previousRevisionId === start.id);
  while (next && !visited.has(next.id)) {
    visited.add(next.id);
    newer.push(next);
    const currentId = next.id;
    next = deliverables.find((item) => item.previousRevisionId === currentId);
  }

  return [...older, start, ...newer];
}
