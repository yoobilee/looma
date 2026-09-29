import type { Activity } from '@/domain/types';
import { groupActivitiesByDay } from './groupActivities';
import { ActivityTimeline } from './ActivityTimeline';
import styles from './GroupedActivityList.module.css';

export function GroupedActivityList({ activities, projectNames }: { activities: Activity[]; projectNames?: Record<string, string> }) {
  return (
    <div className={styles.groups}>
      {groupActivitiesByDay(activities).map((group) => (
        <section key={group.key} aria-label={group.label} className={styles.group}>
          <h3 className={styles.day}>{group.label}</h3>
          <ActivityTimeline activities={group.items} projectNames={projectNames} density="compact" />
        </section>
      ))}
    </div>
  );
}
