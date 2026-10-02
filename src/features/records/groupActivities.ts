import type { Activity } from '@/domain/types';
import { dayKey, formatMonthDay } from '@/lib/date';

interface GroupOptions {
  /** 같은 날짜 안의 순서. 기본은 시간순(오래된 것 먼저). newest는 입력 순서를 유지한 채 최신 먼저. */
  within?: 'oldest' | 'newest';
}

/** 활동을 날짜별로 묶는다. 최신 날짜가 먼저, 같은 날짜 안에서는 기본으로 시간순 */
export function groupActivitiesByDay(activities: Activity[], { within = 'oldest' }: GroupOptions = {}): { key: string; label: string; items: Activity[] }[] {
  const map = new Map<string, Activity[]>();
  for (const activity of activities) {
    const key = dayKey(activity.createdAt);
    map.set(key, [...(map.get(key) ?? []), activity]);
  }
  const time = (activity: Activity) => new Date(activity.createdAt).getTime();
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([key, items]) => ({
      key,
      label: formatMonthDay(items[0].createdAt),
      // 정렬은 안정적이라 같은 시각이면 입력 순서가 남는다.
      items: [...items].sort((a, b) => (within === 'newest' ? time(b) - time(a) : time(a) - time(b))),
    }));
}
