import { describe, expect, it, vi } from 'vitest';
import { createMockRepositories } from './mockRepositories';
import { PROJECT_A } from './seed';

describe('mock 저장소', () => {
  it('업무를 완료하면 완료 시각과 활동 기록이 남는다', async () => {
    const repos = createMockRepositories();
    const task = await repos.tasks.create({ title: '  새 업무  ' });
    expect(task.title).toBe('새 업무');
    expect(task.status).toBe('planned');

    await repos.tasks.updateStatus(task.id, 'done');
    const saved = await repos.tasks.get(task.id);
    expect(saved?.completedAt).toBeDefined();

    const activities = await repos.activities.list();
    expect(activities[0]).toMatchObject({ type: 'task_completed', taskId: task.id });
  });

  it('완료를 되돌리면 완료 시각을 지운다', async () => {
    const repos = createMockRepositories();
    const task = await repos.tasks.create({ title: '되돌릴 업무' });
    await repos.tasks.updateStatus(task.id, 'done');
    await repos.tasks.updateStatus(task.id, 'planned');
    expect((await repos.tasks.get(task.id))?.completedAt).toBeUndefined();
  });

  it('임시 자료는 고정하면 만료되지 않고, 만료된 자료는 목록에서 빠진다', async () => {
    const repos = createMockRepositories();
    const item = await repos.scratch.create({ type: 'text', content: '메모' });
    expect(item.expiresAt).toBeDefined();

    const pinned = await repos.scratch.pin(item.id, 'project', PROJECT_A);
    expect(pinned.expiresAt).toBeUndefined();
    expect(pinned.linkedId).toBe(PROJECT_A);

    const projectActivities = await repos.activities.list({ projectId: PROJECT_A });
    expect(projectActivities[0].type).toBe('scratch_pinned');
  });

  it('만료 시각이 지난 임시 자료는 보이지 않는다', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const repos = createMockRepositories();
      const item = await repos.scratch.create({ type: 'text', content: '곧 사라질 메모' });
      expect((await repos.scratch.list()).some((entry) => entry.id === item.id)).toBe(true);
      // 반환 객체를 고쳐서는 저장소 상태가 바뀌지 않으므로 시간을 만료 뒤로 옮긴다.
      vi.setSystemTime(new Date(item.expiresAt!).getTime() + 1000);
      expect((await repos.scratch.list()).find((entry) => entry.id === item.id)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('변경이 생기면 구독자에게 알린다', async () => {
    const repos = createMockRepositories();
    let calls = 0;
    const unsubscribe = repos.subscribe(() => {
      calls += 1;
    });
    await repos.tasks.create({ title: '알림 확인' });
    unsubscribe();
    await repos.tasks.create({ title: '구독 해제 후' });
    expect(calls).toBe(1);
  });

  it('없는 업무의 상태를 바꾸면 오류를 낸다', async () => {
    const repos = createMockRepositories();
    await expect(repos.tasks.updateStatus('missing', 'done')).rejects.toThrow('찾을 수 없어요');
  });
});
