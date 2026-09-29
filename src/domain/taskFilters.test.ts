import { describe, expect, it } from 'vitest';
import type { Task } from './types';
import { filterTasks, PERSONAL_PROJECT_FILTER, sortTasks } from './taskFilters';

// 2026-09-30 수요일 12:00 기준
const now = new Date(2026, 8, 30, 12, 0);

const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  title: id,
  status: 'planned',
  tags: [],
  repeat: 'none',
  createdAt: now.toISOString(),
  ...overrides,
});

const tasks: Task[] = [
  task('today', { dueAt: new Date(2026, 8, 30, 15, 0).toISOString(), projectId: 'p1', tags: ['기능 QA'] }),
  task('friday', { dueAt: new Date(2026, 9, 2, 10, 0).toISOString(), status: 'waiting' }),
  task('next-monday', { dueAt: new Date(2026, 9, 5, 10, 0).toISOString(), projectId: 'p1' }),
  task('no-due', { status: 'in_progress' }),
  task('done', { dueAt: new Date(2026, 8, 29, 10, 0).toISOString(), status: 'done' }),
];

const ids = (list: Task[]) => list.map((item) => item.id);

describe('업무 필터', () => {
  it('오늘 기한인 업무만 고른다', () => {
    expect(ids(filterTasks(tasks, { period: 'today' }, now))).toEqual(['today']);
  });

  it('이번 주는 월요일부터 일요일까지다', () => {
    expect(ids(filterTasks(tasks, { period: 'this_week' }, now))).toEqual(['today', 'friday', 'done']);
  });

  it('기한 없음', () => {
    expect(ids(filterTasks(tasks, { period: 'no_due' }, now))).toEqual(['no-due']);
  });

  it('프로젝트·개인·상태·태그 조건을 함께 적용한다', () => {
    expect(ids(filterTasks(tasks, { period: 'all', projectId: 'p1' }, now))).toEqual(['today', 'next-monday']);
    expect(ids(filterTasks(tasks, { period: 'all', projectId: PERSONAL_PROJECT_FILTER }, now))).toEqual(['friday', 'no-due', 'done']);
    expect(ids(filterTasks(tasks, { period: 'all', status: 'waiting' }, now))).toEqual(['friday']);
    expect(ids(filterTasks(tasks, { period: 'all', tag: '기능 QA' }, now))).toEqual(['today']);
  });

  it('진행 중 → 예정 → 대기 → 완료 순, 같은 상태는 기한이 빠른 순으로 정렬한다', () => {
    expect(ids(sortTasks(tasks))).toEqual(['no-due', 'today', 'next-monday', 'friday', 'done']);
  });
});
