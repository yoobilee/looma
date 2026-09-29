import { Link } from 'react-router-dom';
import { useRepositoryData } from '@/hooks/useRepositoryData';
import { useNow } from '@/hooks/useNow';
import { formatFullDate, greetingFor, isToday } from '@/lib/date';
import { sortTasks } from '@/domain/taskFilters';
import { PageHeader } from '@/components/layout/PageHeader';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { LoadingState, StateMessage } from '@/components/ui/StateMessage';
import { ScratchPanel } from '@/features/scratch/ScratchPanel';
import { ActivityTimeline } from '@/features/records/ActivityTimeline';
import { CurrentTaskHero } from './CurrentTaskHero';
import { TodayTaskList } from './TodayTaskList';
import { TodayStatus } from './TodayStatus';
import { QuickStart } from './QuickStart';
import styles from './TodayPage.module.css';

/** 하루 종일 켜두는 실행 중심 화면 */
export function TodayPage() {
  const now = useNow();
  const data = useRepositoryData(
    async (repos) => ({
      tasks: await repos.tasks.list(),
      projects: await repos.projects.list(),
      activities: await repos.activities.list(),
      scratch: await repos.scratch.list(),
      events: await repos.calendar.listUpcoming(new Date().toISOString(), 3),
      calendarStatus: await repos.calendar.connectionStatus(),
    }),
    [],
  );

  const projectNames = Object.fromEntries((data.data?.projects ?? []).map((project) => [project.id, project.name]));
  const tasks = data.data?.tasks ?? [];
  const currentTask = tasks.find((task) => task.status === 'in_progress');
  const todayTasks = sortTasks(tasks.filter((task) => task.id !== currentTask?.id && task.status !== 'done' && isToday(task.dueAt, now)));
  const nextTask = todayTasks[0];
  const todayActivities = (data.data?.activities ?? []).filter((activity) => isToday(activity.createdAt, now));
  const remainingCount = tasks.filter((task) => task.status !== 'done' && isToday(task.dueAt, now)).length;
  const scratchCount = (data.data?.scratch ?? []).filter((item) => !item.pinnedAt).length;
  // 현재 업무와 연결된 임시 자료: 업무에 고정했거나 같은 프로젝트 맥락에서 담은 자료
  const relatedCount = currentTask
    ? (data.data?.scratch ?? []).filter(
        (item) => item.linkedId === currentTask.id || (!!currentTask.projectId && item.contextProjectId === currentTask.projectId),
      ).length
    : 0;

  return (
    <>
      <PageHeader eyebrow={formatFullDate(now)} title={greetingFor(now)} />

      {data.status === 'loading' && <LoadingState />}
      {data.status === 'error' && <StateMessage tone="error" title="오늘 화면을 불러오지 못했어요." description={data.error.message} />}

      {data.data && (
        <div className={styles.layout}>
          <div className={styles.primary}>
            <CurrentTaskHero
              task={currentTask}
              nextTask={nextTask}
              projectName={currentTask?.projectId ? projectNames[currentTask.projectId] : undefined}
              relatedCount={relatedCount}
              now={now}
            />

            <div className={styles.split}>
              <section aria-labelledby="today-tasks-title">
                <SectionHeader id="today-tasks-title" title="오늘 할 일" meta={`${todayTasks.length}개`} />
                <TodayTaskList tasks={todayTasks} projectNames={projectNames} />
              </section>

              <TodayStatus
                remainingCount={remainingCount}
                inProgressCount={tasks.filter((task) => task.status === 'in_progress').length}
                scratchCount={scratchCount}
                events={data.data.events}
                calendarStatus={data.data.calendarStatus}
              />
            </div>

            <section aria-labelledby="today-activity-title" className={styles.activity}>
              <SectionHeader
                id="today-activity-title"
                title="오늘의 기록"
                action={
                  <Link to="/records" className={styles.link}>
                    전체 기록
                  </Link>
                }
              />
              {todayActivities.length === 0 ? (
                <p className={styles.muted}>아직 남긴 기록이 없어요. 업무를 시작하거나 완료하면 자동으로 쌓여요.</p>
              ) : (
                <ActivityTimeline activities={todayActivities.slice(0, 5)} density="compact" />
              )}
            </section>
          </div>

          <aside className={styles.secondary} aria-label="임시 작업공간과 빠른 시작">
            <ScratchPanel />
            <QuickStart />
          </aside>
        </div>
      )}
    </>
  );
}
