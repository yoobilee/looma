import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useRepositoryData } from '@/hooks/useRepositoryData';
import { activityCategoryFilters, activityCategoryLabel, activityLinkLabel, activityLinkPath, matchesActivityCategory, parseActivityCategoryFilter } from '@/domain/activityRecords';
import type { Activity } from '@/domain/types';
import { Button } from '@/components/ui/Button';
import { FilterTabs } from '@/components/ui/FilterTabs';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { LoadingState, StateMessage } from '@/components/ui/StateMessage';
import { GroupedActivityList } from '@/features/records/GroupedActivityList';
import { useProjectContext } from '../projectContext';
import styles from './ProjectRecordsTab.module.css';

const PAGE_SIZE = 50;

const byNewest = (a: Activity, b: Activity) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();

/** 이 프로젝트에서 일어난 활동을 최신순으로 보여준다. 종류 필터는 주소(?type=)에 남긴다. */
export function ProjectRecordsTab() {
  const { project } = useProjectContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = parseActivityCategoryFilter(searchParams.get('type'));
  const data = useRepositoryData((repos) => repos.activities.list({ projectId: project.id }), [project.id]);

  if (data.status === 'loading') return <LoadingState />;
  if (data.status === 'error') return <StateMessage tone="error" title="기록을 불러오지 못했어요." />;

  // 저장소가 이미 최신순이지만 같은 시각의 기록 순서를 유지하도록 안정 정렬만 다시 한다.
  const all = [...data.data].sort(byNewest);
  const filtered = all.filter((activity) => matchesActivityCategory(activity, filter));

  const changeFilter = (value: typeof filter) => {
    const next = new URLSearchParams(searchParams);
    if (value === 'all') next.delete('type');
    else next.set('type', value);
    setSearchParams(next);
  };

  return (
    <section aria-labelledby="project-records-title" className={styles.page}>
      <SectionHeader id="project-records-title" title="프로젝트 활동 기록" meta={filter === 'all' ? `${all.length}건` : `${all.length}건 중 ${filtered.length}건`} />
      {all.length === 0 ? (
        <StateMessage title="아직 기록이 없어요." description="산출물 추가, TC 변경, 수행 결과 업로드, 이슈 등록이 자동으로 기록돼요." />
      ) : (
        <>
          <FilterTabs
            label="기록 종류"
            value={filter}
            onChange={changeFilter}
            options={activityCategoryFilters.map((value) => ({ value, label: activityCategoryLabel[value], count: all.filter((activity) => matchesActivityCategory(activity, value)).length }))}
          />
          {filtered.length === 0 ? (
            <StateMessage title={`${activityCategoryLabel[filter]} 기록이 없어요.`} description="다른 종류를 고르면 이 프로젝트의 다른 기록을 볼 수 있어요." />
          ) : (
            // 종류나 프로젝트가 바뀌면 처음 50건부터 다시 보여준다.
            <RecordList key={`${project.id}:${filter}`} activities={filtered} projectId={project.id} />
          )}
        </>
      )}
    </section>
  );
}

function RecordList({ activities, projectId }: { activities: Activity[]; projectId: string }) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const shown = activities.slice(0, limit);
  return (
    <>
      <GroupedActivityList activities={shown} within="newest" linkOf={(activity) => activityLinkPath(activity, projectId)} linkLabelOf={activityLinkLabel} />
      {activities.length > limit && (
        <div className={styles.more}>
          <Button variant="ghost" size="sm" onClick={() => setLimit((current) => current + PAGE_SIZE)}>
            더 보기 ({shown.length}/{activities.length})
          </Button>
        </div>
      )}
    </>
  );
}
