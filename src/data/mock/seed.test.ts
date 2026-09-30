import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockRepositories } from './mockRepositories';
import { createSeed } from './seed';

// 실행 환경의 로컬 시각 기준으로 "오늘 이른 아침"을 만든다. CI(UTC) 오전과 같은 상황을 재현한다.
function earlyMorningToday(): Date {
  const date = new Date();
  date.setHours(1, 0, 0, 0);
  return date;
}

describe('mock seed 시각', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('이른 아침에도 이미 일어난 활동은 현재 시각보다 미래가 아니다', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(earlyMorningToday());
    const now = Date.now();

    const seed = createSeed();
    for (const activity of seed.activities) {
      expect(new Date(activity.createdAt).getTime(), activity.id).toBeLessThanOrEqual(now);
    }
  });

  it('이른 아침에도 방금 완료한 업무가 가장 최근 활동이 된다', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(earlyMorningToday());

    const repos = createMockRepositories();
    const task = await repos.tasks.create({ title: '이른 아침 업무' });
    await repos.tasks.updateStatus(task.id, 'done');

    const activities = await repos.activities.list();
    expect(activities[0]).toMatchObject({ type: 'task_completed', taskId: task.id });
  });

  it('오늘의 최근 활동 흐름 순서를 유지한다', () => {
    const seed = createSeed();
    const timeOf = (id: string) => new Date(seed.activities.find((activity) => activity.id === id)!.createdAt).getTime();
    const order = ['act-1', 'act-2', 'act-3', 'act-4', 'act-5'].map(timeOf);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('활동과 연결된 업무 완료·임시 자료 고정 시각이 활동 시각과 일치한다', () => {
    const seed = createSeed();
    const activity = (id: string) => seed.activities.find((item) => item.id === id)!;
    expect(seed.tasks.find((task) => task.id === 'task-access')?.completedAt).toBe(activity('act-2').createdAt);
    expect(seed.scratch.find((item) => item.id === 'scr-pinned-env')?.pinnedAt).toBe(activity('act-3').createdAt);
  });
});
