import type { Activity } from '@/domain/types';
import { groupActivitiesByDay } from './groupActivities';
import { ActivityTimeline } from './ActivityTimeline';
import styles from './GroupedActivityList.module.css';

interface GroupedActivityListProps {
  activities: Activity[];
  projectNames?: Record<string, string>;
  within?: 'oldest' | 'newest';
  linkOf?: (activity: Activity) => string | undefined;
  linkLabelOf?: (activity: Activity) => string | undefined;
}

export function GroupedActivityList({ activities, projectNames, within, linkOf, linkLabelOf }: GroupedActivityListProps) {
  return (
    <div className={styles.groups}>
      {groupActivitiesByDay(activities, { within }).map((group) => (
        <section key={group.key} aria-label={group.label} className={styles.group}>
          <h3 className={styles.day}>{group.label}</h3>
          <ActivityTimeline activities={group.items} projectNames={projectNames} density="compact" linkOf={linkOf} linkLabelOf={linkLabelOf} />
        </section>
      ))}
    </div>
  );
}
