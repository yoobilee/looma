import type { Activity } from '@/domain/types';
import { activityTypeLabel } from '@/domain/labels';
import { formatTime } from '@/lib/date';
import styles from './ActivityTimeline.module.css';

const emphasized = new Set<Activity['type']>(['task_started', 'task_completed', 'results_uploaded', 'issue_created']);

interface ActivityTimelineProps {
  activities: Activity[];
  projectNames?: Record<string, string>;
  density?: 'compact' | 'regular';
}

/** "내가 언제 무엇을 했는가"를 시간순으로 보여준다. Today·기록·프로젝트 기록에서 공용 */
export function ActivityTimeline({ activities, projectNames, density = 'regular' }: ActivityTimelineProps) {
  return (
    <ol className={`${styles.timeline} ${styles[density]}`}>
      {activities.map((activity) => {
        const detail = activity.metadata.detail || activityTypeLabel[activity.type];
        const project = activity.projectId ? projectNames?.[activity.projectId] : undefined;
        return (
          <li key={activity.id} className={styles.entry}>
            <time className={styles.time} dateTime={activity.createdAt}>
              {formatTime(activity.createdAt)}
            </time>
            <span className={`${styles.dot} ${emphasized.has(activity.type) ? styles.dotStrong : ''}`} aria-hidden />
            <div className={styles.body}>
              <p className={styles.title}>{activity.title}</p>
              <p className={styles.detail}>
                {detail}
                {project && <span> · {project}</span>}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
