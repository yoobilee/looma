import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useRepositoryData } from '@/hooks/useRepositoryData';
import { useNow } from '@/hooks/useNow';
import type { Activity, ActivityType } from '@/domain/types';
import { dayKey, isSameDay } from '@/lib/date';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { SelectField } from '@/components/ui/Field';
import { LoadingState, StateMessage } from '@/components/ui/StateMessage';
import { ActivityTimeline } from './ActivityTimeline';
import { groupActivitiesByDay } from './groupActivities';
import styles from './RecordsPage.module.css';

const PERSONAL = 'personal';

const summaryPhrases: Partial<Record<ActivityType, (count: number) => string>> = {
  task_completed: (count) => `업무 ${count}건을 완료했어요`,
  task_started: (count) => `업무 ${count}건을 시작했어요`,
  task_created: (count) => `새 업무 ${count}건을 등록했어요`,
  memo_created: (count) => `메모 ${count}건을 남겼어요`,
  scratch_pinned: (count) => `임시 자료 ${count}건을 고정했어요`,
  deliverable_added: (count) => `산출물 ${count}건을 추가했어요`,
  requirements_analyzed: (count) => `요구사항 분석 ${count}건을 진행했어요`,
  test_case_changed: (count) => `TC 변경 ${count}건이 있었어요`,
  results_uploaded: (count) => `수행 결과 ${count}건을 업로드했어요`,
  issue_created: (count) => `이슈·확인사항 ${count}건을 등록했어요`,
  knowledge_saved: (count) => `업무 지식 ${count}건을 정리했어요`,
  changes_applied: (count) => `변경사항 ${count}건을 반영했어요`,
};

/** AI 요약 연결 전까지 쓰는 규칙 기반 하루 정리 */
function summarize(activities: Activity[]): string[] {
  const counts = new Map<ActivityType, number>();
  for (const activity of activities) counts.set(activity.type, (counts.get(activity.type) ?? 0) + 1);
  return [...counts.entries()].map(([type, count]) => summaryPhrases[type]?.(count)).filter((line): line is string => !!line);
}

/** 모든 프로젝트와 개인 업무의 "언제 무엇을 했는가" */
export function RecordsPage() {
  const now = useNow();
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [scope, setScope] = useState('');
  const data = useRepositoryData(async (repos) => ({ activities: await repos.activities.list(), projects: await repos.projects.list() }), []);

  const projectNames = Object.fromEntries((data.data?.projects ?? []).map((project) => [project.id, project.name]));
  const scoped = (data.data?.activities ?? []).filter((activity) =>
    !scope ? true : scope === PERSONAL ? !activity.projectId : activity.projectId === scope,
  );
  const days = groupActivitiesByDay(scoped);
  const current = days.find((day) => day.key === selectedDay) ?? days[0];
  const isCurrentToday = current ? isSameDay(new Date(current.items[0].createdAt), now) : false;
  const summaryLines = current ? summarize(current.items) : [];

  return (
    <>
      <PageHeader eyebrow="기록" title="업무 기록" searchPlaceholder="날짜, 프로젝트, 활동 검색" />

      {data.status === 'loading' && <LoadingState />}
      {data.status === 'error' && <StateMessage tone="error" title="기록을 불러오지 못했어요." />}

      {data.status === 'success' && (
        <div className={styles.layout}>
          <aside className={styles.dates}>
            <SelectField label="범위" value={scope} onChange={(event) => setScope(event.target.value)}>
              <option value="">전체</option>
              <option value={PERSONAL}>개인 업무</option>
              {data.data.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </SelectField>
            <h2 className={styles.datesTitle}>날짜</h2>
            <ul className={styles.dateList}>
              {days.map((day) => (
                <li key={day.key}>
                  <button
                    type="button"
                    className={`${styles.date} ${day.key === current?.key ? styles.dateActive : ''}`}
                    aria-pressed={day.key === current?.key}
                    onClick={() => setSelectedDay(day.key)}
                  >
                    <span>{day.key === dayKey(now.toISOString()) ? `오늘 · ${day.label}` : day.label}</span>
                    <span className={styles.dateCount}>{day.items.length}</span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          <section className={styles.timeline} aria-labelledby="records-day-title">
            {current ? (
              <>
                <h2 id="records-day-title" className={styles.dayTitle}>
                  {current.label}
                </h2>
                <ActivityTimeline activities={current.items} projectNames={projectNames} />

                <div className={styles.summary}>
                  <h3 className={styles.summaryTitle}>{isCurrentToday ? '오늘 한 일 정리' : `${current.label} 한 일 정리`}</h3>
                  <ul className={styles.summaryLines}>
                    {summaryLines.map((line) => (
                      <li key={line}>{line}.</li>
                    ))}
                  </ul>
                  <div className={styles.summaryFooter}>
                    <p className={styles.summaryNote}>활동 기록을 그대로 묶은 정리예요. AI 요약은 이후 연결됩니다.</p>
                    <Button variant="primary" size="sm" icon={<Sparkles aria-hidden />} disabled>
                      AI 요약 만들기
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <StateMessage title="이 범위에는 기록이 없어요." description="업무를 시작·완료하거나 자료를 고정하면 자동으로 쌓여요." />
            )}
          </section>
        </div>
      )}
    </>
  );
}
