import { repositories } from '@/data';
import { taskRepeatLabel, taskStatusLabel } from '@/domain/labels';
import type { Task, TaskStatus } from '@/domain/types';
import { formatDue } from '@/lib/date';
import styles from './TaskList.module.css';

interface TaskListProps {
  tasks: Task[];
  projectNames: Record<string, string>;
  now: Date;
}

export function TaskList({ tasks, projectNames, now }: TaskListProps) {
  return (
    <ul className={styles.list}>
      {tasks.map((task) => {
        const context = task.projectId ? projectNames[task.projectId] : '개인';
        const overdue = task.status !== 'done' && task.dueAt && new Date(task.dueAt) < now;
        return (
          <li key={task.id} className={`${styles.row} ${task.status === 'done' ? styles.done : ''}`}>
            <span className={`${styles.dot} ${styles[task.status]}`} aria-hidden />
            <div className={styles.main}>
              <p className={styles.title}>{task.title}</p>
              <p className={styles.meta}>
                {context}
                {task.tags.length > 0 && ` · ${task.tags.join(', ')}`}
                {task.repeat !== 'none' && ` · ${taskRepeatLabel[task.repeat]}`}
              </p>
              {task.notes && <p className={styles.notes}>{task.notes}</p>}
            </div>
            <div className={styles.side}>
              <span className={`${styles.due} ${overdue ? styles.overdue : ''}`}>{formatDue(task.dueAt, now)}</span>
              <label className={styles.statusControl}>
                <span className="visually-hidden">{task.title} 상태</span>
                <select value={task.status} onChange={(event) => void repositories.tasks.updateStatus(task.id, event.target.value as TaskStatus)}>
                  {(Object.keys(taskStatusLabel) as TaskStatus[]).map((status) => (
                    <option key={status} value={status}>
                      {taskStatusLabel[status]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
