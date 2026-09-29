import { repositories } from '@/data';
import type { Task } from '@/domain/types';
import { formatTime } from '@/lib/date';
import { useAppCommands } from '@/app/commandsContext';
import styles from './TodayTaskList.module.css';

interface TodayTaskListProps {
  tasks: Task[];
  projectNames: Record<string, string>;
}

export function TodayTaskList({ tasks, projectNames }: TodayTaskListProps) {
  const { openTaskCreate } = useAppCommands();

  if (tasks.length === 0) {
    return (
      <div className={styles.empty}>
        <p>오늘 남은 할 일이 없어요.</p>
        <button type="button" className={styles.link} onClick={() => openTaskCreate()}>
          업무 추가
        </button>
      </div>
    );
  }

  return (
    <ul className={styles.list}>
      {tasks.map((task) => {
        const context = task.projectId ? projectNames[task.projectId] : task.tags[0] ?? '개인';
        return (
          <li key={task.id} className={styles.row}>
            <label className={styles.check}>
              <input type="checkbox" checked={false} onChange={() => void repositories.tasks.updateStatus(task.id, 'done')} />
              <span className="visually-hidden">{task.title} 완료로 표시</span>
            </label>
            <div className={styles.text}>
              <p className={styles.title}>{task.title}</p>
              <p className={styles.context}>
                {task.status === 'waiting' && <span className={styles.waiting}>대기 · </span>}
                {context}
              </p>
            </div>
            {task.dueAt && (
              <time className={styles.time} dateTime={task.dueAt}>
                {formatTime(task.dueAt)}
              </time>
            )}
          </li>
        );
      })}
    </ul>
  );
}
