import { isThisWeek, isToday } from '@/lib/date';
import type { Task, TaskStatus } from './types';

export type TaskPeriodFilter = 'all' | 'today' | 'this_week' | 'no_due';

export interface TaskFilter {
  period: TaskPeriodFilter;
  status?: TaskStatus;
  projectId?: string; // 'personal'이면 프로젝트 없는 개인 업무
  tag?: string;
}

export const PERSONAL_PROJECT_FILTER = 'personal';

export function filterTasks(tasks: Task[], filter: TaskFilter, now = new Date()): Task[] {
  return tasks.filter((task) => {
    if (filter.period === 'today' && !isToday(task.dueAt, now)) return false;
    if (filter.period === 'this_week' && !isThisWeek(task.dueAt, now)) return false;
    if (filter.period === 'no_due' && task.dueAt) return false;
    if (filter.status && task.status !== filter.status) return false;
    if (filter.projectId === PERSONAL_PROJECT_FILTER && task.projectId) return false;
    if (filter.projectId && filter.projectId !== PERSONAL_PROJECT_FILTER && task.projectId !== filter.projectId) {
      return false;
    }
    if (filter.tag && !task.tags.includes(filter.tag)) return false;
    return true;
  });
}

const statusRank: Record<TaskStatus, number> = { in_progress: 0, planned: 1, waiting: 2, done: 3 };

/** 진행 중 → 예정 → 대기 → 완료, 같은 상태는 기한이 빠른 순(기한 없음은 뒤) */
export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const byStatus = statusRank[a.status] - statusRank[b.status];
    if (byStatus !== 0) return byStatus;
    const aDue = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
    const bDue = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;
    return aDue - bDue;
  });
}
