import { ExternalLink } from 'lucide-react';
import type { CalendarEvent } from '@/domain/types';
import { formatDue, formatTime, isToday } from '@/lib/date';
import { SectionHeader } from '@/components/ui/SectionHeader';
import styles from './TodayStatus.module.css';

interface TodayStatusProps {
  remainingCount: number;
  inProgressCount: number;
  scratchCount: number;
  events: CalendarEvent[];
  calendarStatus: 'connected' | 'not_connected';
}

/**
 * 추상적인 생산성 점수 대신 실용 정보(남은 업무, 진행 중, 임시 자료, 다음 일정)를 보여준다.
 * 일정은 Google Calendar read-only 연결 예정이며, 클릭 시 원본 일정으로 이동한다.
 */
export function TodayStatus({ remainingCount, inProgressCount, scratchCount, events, calendarStatus }: TodayStatusProps) {
  const [nextEvent, ...laterEvents] = events;

  return (
    <section aria-labelledby="today-status-title" className={styles.status}>
      <SectionHeader id="today-status-title" title="지금 상황" />

      <dl className={styles.figures}>
        <div className={styles.figureMain}>
          <dt>남은 업무</dt>
          <dd>
            {remainingCount}
            <span>개</span>
          </dd>
        </div>
        <div>
          <dt>진행 중</dt>
          <dd>{inProgressCount}</dd>
        </div>
        <div>
          <dt>임시 자료</dt>
          <dd>{scratchCount}</dd>
        </div>
      </dl>

      <div className={styles.calendar}>
        <p className={styles.calendarLabel}>
          다음 일정
          {calendarStatus === 'not_connected' && <span className={styles.sample}>Google Calendar 연결 전 · 예시 일정</span>}
        </p>
        {nextEvent ? (
          <a href={nextEvent.sourceUrl} target="_blank" rel="noopener noreferrer" className={styles.nextEvent}>
            <span className={styles.eventTime}>
              {isToday(nextEvent.startAt) ? formatTime(nextEvent.startAt) : formatDue(nextEvent.startAt)}
            </span>
            <span className={styles.eventTitle}>{nextEvent.title}</span>
            {nextEvent.location && <span className={styles.eventMeta}>{nextEvent.location}</span>}
            <ExternalLink aria-hidden className={styles.eventIcon} />
            <span className="visually-hidden">(Google Calendar에서 열기, 새 창)</span>
          </a>
        ) : (
          <p className={styles.noEvent}>남은 일정이 없어요.</p>
        )}
        {laterEvents.length > 0 && (
          <ul className={styles.later}>
            {laterEvents.map((event) => (
              <li key={event.id}>
                <a href={event.sourceUrl} target="_blank" rel="noopener noreferrer">
                  <span>{isToday(event.startAt) ? formatTime(event.startAt) : formatDue(event.startAt)}</span>
                  {event.title}
                  <span className="visually-hidden">(새 창)</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
