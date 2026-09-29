import type { Activity } from '@/domain/types';
import { dayKey, formatMonthDay } from '@/lib/date';

/** 활동을 날짜별로 묶는다. 최신 날짜가 먼저, 같은 날짜 안에서는 시간순 */
export function groupActivitiesByDay(activities: Activity[]): { key: string; label: string; items: Activity[] }[] {
  const map = new Map<string, Activity[]>();
  for (const activity of activities) {
    const key = dayKey(activity.createdAt);
    map.set(key, [...(map.get(key) ?? []), activity]);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([key, items]) => ({
      key,
      label: formatMonthDay(items[0].createdAt),
      items: [...items].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    }));
}
