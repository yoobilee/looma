import { useState } from 'react';
import { repositories } from '@/data';
import { useAppCommands } from '@/app/commandsContext';
import type { Task } from '@/domain/types';
import { formatDue, formatElapsed, formatTime } from '@/lib/date';
import { Button } from '@/components/ui/Button';
import { ProgressBar } from '@/components/ui/ProgressBar';
import styles from './CurrentTaskHero.module.css';

interface CurrentTaskHeroProps {
  task?: Task;
  nextTask?: Task;
  projectName?: string;
  relatedCount: number;
  now: Date;
}

const FOCUS_BLOCK_MINUTES = 90;

/** 지금 하고 있는 업무. 부드러운 gradient 면으로 묶어 Today 화면의 시각적 기준점이 되게 한다. */
export function CurrentTaskHero({ task, nextTask, projectName, relatedCount, now }: CurrentTaskHeroProps) {
  const { openScratchDrawer } = useAppCommands();
  const [notesOpen, setNotesOpen] = useState(false);

  if (!task) {
    return (
      <section className={styles.hero} aria-labelledby="current-task-title">
        <p className={styles.eyebrow}>진행 중인 업무 없음</p>
        <h2 id="current-task-title" className={styles.title}>
          {nextTask ? '다음 업무를 시작해 볼까요?' : '오늘 예정된 업무를 모두 마쳤어요.'}
        </h2>
        {nextTask && (
          <>
            <p className={styles.meta}>
              {nextTask.title} · {formatDue(nextTask.dueAt, now)}
            </p>
            <div className={styles.actions}>
              <Button variant="accent" onClick={() => void repositories.tasks.updateStatus(nextTask.id, 'in_progress')}>
                시작하기
              </Button>
            </div>
          </>
        )}
      </section>
    );
  }

  const elapsedMinutes = task.startedAt ? (now.getTime() - new Date(task.startedAt).getTime()) / 60000 : 0;
  const meta = [task.startedAt && `${formatTime(task.startedAt)} 시작`, projectName ?? task.tags[0], `관련 자료 ${relatedCount}개`].filter(Boolean).join(' · ');

  return (
    <section className={styles.hero} aria-labelledby="current-task-title">
      <p className={styles.eyebrow}>현재 진행 중</p>
      <h2 id="current-task-title" className={styles.title}>
        {task.title}
      </h2>
      <p className={styles.meta}>{meta}</p>
      {task.notes && <p className={`${styles.notes} ${notesOpen ? styles.notesOpen : ''}`}>{task.notes}</p>}

      <div className={styles.footer}>
        {task.startedAt && (
          <div className={styles.elapsed}>
            <ProgressBar value={(elapsedMinutes / FOCUS_BLOCK_MINUTES) * 100} label={`집중 시간 ${FOCUS_BLOCK_MINUTES}분 중 경과`} />
            <span>{formatElapsed(task.startedAt, now)}</span>
          </div>
        )}
        <div className={styles.actions}>
          {task.notes && (
            <Button variant="secondary" onClick={() => setNotesOpen((open) => !open)} aria-expanded={notesOpen}>
              {notesOpen ? '메모 접기' : '메모'}
            </Button>
          )}
          <Button variant="secondary" onClick={openScratchDrawer}>
            자료
          </Button>
          <Button variant="accent" onClick={() => void repositories.tasks.updateStatus(task.id, 'done')}>
            완료
          </Button>
        </div>
      </div>
    </section>
  );
}
