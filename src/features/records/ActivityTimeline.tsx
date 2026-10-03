import { Link } from 'react-router-dom';
import type { Activity } from '@/domain/types';
import { activityTypeLabel } from '@/domain/labels';
import { formatTime } from '@/lib/date';
import styles from './ActivityTimeline.module.css';

const emphasized = new Set<Activity['type']>(['task_started', 'task_completed', 'results_uploaded', 'issue_created', 'issue_resolved']);

interface ActivityTimelineProps {
  activities: Activity[];
  projectNames?: Record<string, string>;
  density?: 'compact' | 'regular';
  /** 제목을 링크로 만들 활동의 경로. 없으면(기본) 텍스트로만 보여준다. */
  linkOf?: (activity: Activity) => string | undefined;
  /** 있으면 제목은 평문으로 두고, 이 문구의 별도 링크로 이동한다(개별 원본이 아닌 화면으로 가는 경우). */
  linkLabelOf?: (activity: Activity) => string | undefined;
}

/** "내가 언제 무엇을 했는가"를 시간순으로 보여준다. Today·기록·프로젝트 기록에서 공용 */
export function ActivityTimeline({ activities, projectNames, density = 'regular', linkOf, linkLabelOf }: ActivityTimelineProps) {
  return (
    <ol className={`${styles.timeline} ${styles[density]}`}>
      {activities.map((activity) => {
        const detail = activity.metadata.detail || activityTypeLabel[activity.type];
        const href = linkOf?.(activity);
        const actionLabel = href ? linkLabelOf?.(activity) : undefined;
        const project = activity.projectId ? projectNames?.[activity.projectId] : undefined;
        return (
          <li key={activity.id} className={styles.entry}>
            <time className={styles.time} dateTime={activity.createdAt}>
              {formatTime(activity.createdAt)}
            </time>
            <span className={`${styles.dot} ${emphasized.has(activity.type) ? styles.dotStrong : ''}`} aria-hidden />
            <div className={styles.body}>
              <p className={styles.title}>{href && !actionLabel ? <Link className={styles.link} to={href}>{activity.title}</Link> : activity.title}</p>
              <p className={styles.detail}>
                {detail}
                {project && <span> · {project}</span>}
              </p>
              {href && actionLabel && (
                <Link className={`${styles.link} ${styles.action}`} to={href}>
                  {actionLabel}
                </Link>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
