import { useState } from 'react';
import { useRepositoryData } from '@/hooks/useRepositoryData';
import { useNow } from '@/hooks/useNow';
import { filterTasks, PERSONAL_PROJECT_FILTER, sortTasks, type TaskPeriodFilter } from '@/domain/taskFilters';
import { taskStatusLabel } from '@/domain/labels';
import type { TaskStatus } from '@/domain/types';
import { PageHeader } from '@/components/layout/PageHeader';
import { FilterTabs } from '@/components/ui/FilterTabs';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { SelectField } from '@/components/ui/Field';
import { Button } from '@/components/ui/Button';
import { LoadingState, StateMessage } from '@/components/ui/StateMessage';
import { TaskList } from './TaskList';
import { TaskCreateForm } from './TaskCreateForm';
import styles from './WorkPage.module.css';

type QuickView = 'all' | 'today' | 'this_week' | 'no_due' | 'in_progress' | 'waiting' | 'done';

const quickViews: { value: QuickView; label: string }[] = [
  { value: 'all', label: '전체' },
  { value: 'today', label: '오늘' },
  { value: 'this_week', label: '이번 주' },
  { value: 'no_due', label: '기한 없음' },
  { value: 'in_progress', label: '진행 중' },
  { value: 'waiting', label: '대기' },
  { value: 'done', label: '완료' },
];

function toFilter(view: QuickView): { period: TaskPeriodFilter; status?: TaskStatus } {
  if (view === 'today' || view === 'this_week' || view === 'no_due') return { period: view };
  if (view === 'in_progress' || view === 'waiting' || view === 'done') return { period: 'all', status: view };
  return { period: 'all' };
}

export function WorkPage() {
  const now = useNow();
  const [view, setView] = useState<QuickView>('all');
  const [projectId, setProjectId] = useState('');
  const [status, setStatus] = useState<TaskStatus | ''>('');
  const [tag, setTag] = useState('');

  const data = useRepositoryData(async (repos) => ({ tasks: await repos.tasks.list(), projects: await repos.projects.list() }), []);
  const tasks = data.data?.tasks ?? [];
  const base = toFilter(view);
  const filtered = sortTasks(
    filterTasks(tasks, { period: base.period, status: base.status ?? (status || undefined), projectId: projectId || undefined, tag: tag || undefined }, now),
  );
  // "전체"에서는 완료 업무를 목록 끝으로 보내되 숨기지 않는다.
  const tags = [...new Set(tasks.flatMap((task) => task.tags))];
  const projectNames = Object.fromEntries((data.data?.projects ?? []).map((project) => [project.id, project.name]));
  const hasDetailFilter = !!(projectId || status || tag);

  return (
    <>
      <PageHeader eyebrow="업무" title="전체 업무" searchPlaceholder="업무 검색" />
      <FilterTabs label="업무 보기" options={quickViews} value={view} onChange={setView} />

      <div className={styles.layout}>
        <section aria-labelledby="task-list-title" className={styles.list}>
          <SectionHeader id="task-list-title" title="업무 목록" meta={`${filtered.length}개`} />
          {data.status === 'loading' && <LoadingState />}
          {data.status === 'error' && <StateMessage tone="error" title="업무를 불러오지 못했어요." />}
          {data.status === 'success' &&
            (filtered.length === 0 ? (
              <StateMessage
                title="조건에 맞는 업무가 없어요."
                description={hasDetailFilter ? '빠른 필터를 조정해 보세요.' : '오른쪽에서 새 업무를 추가할 수 있어요.'}
              />
            ) : (
              <TaskList tasks={filtered} projectNames={projectNames} now={now} />
            ))}
        </section>

        <aside className={styles.aside}>
          <section aria-labelledby="task-filter-title" className={styles.filters}>
            <SectionHeader
              id="task-filter-title"
              title="빠른 필터"
              action={
                hasDetailFilter ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setProjectId('');
                      setStatus('');
                      setTag('');
                    }}
                  >
                    초기화
                  </Button>
                ) : undefined
              }
            />
            <SelectField label="프로젝트" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              <option value="">전체</option>
              <option value={PERSONAL_PROJECT_FILTER}>개인 업무</option>
              {data.data?.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </SelectField>
            <SelectField
              label="상태"
              value={base.status ?? status}
              disabled={!!base.status}
              hint={base.status ? '위 보기에서 상태를 이미 골랐어요.' : undefined}
              onChange={(event) => setStatus(event.target.value as TaskStatus | '')}
            >
              <option value="">전체</option>
              {(Object.keys(taskStatusLabel) as TaskStatus[]).map((value) => (
                <option key={value} value={value}>
                  {taskStatusLabel[value]}
                </option>
              ))}
            </SelectField>
            <SelectField label="태그" value={tag} onChange={(event) => setTag(event.target.value)}>
              <option value="">전체</option>
              {tags.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </SelectField>
          </section>

          <section aria-labelledby="task-create-title" className={styles.create}>
            <SectionHeader id="task-create-title" title="업무 만들기" />
            <p className={styles.caption}>제목만 입력해도 바로 생성됩니다.</p>
            <TaskCreateForm defaultProjectId={projectId && projectId !== PERSONAL_PROJECT_FILTER ? projectId : undefined} key={projectId} />
          </section>
        </aside>
      </div>
    </>
  );
}
