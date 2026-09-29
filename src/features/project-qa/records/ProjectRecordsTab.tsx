import { useRepositoryData } from '@/hooks/useRepositoryData';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { LoadingState, StateMessage } from '@/components/ui/StateMessage';
import { GroupedActivityList } from '@/features/records/GroupedActivityList';
import { useProjectContext } from '../projectContext';

/** 이 프로젝트에서 일어난 활동만 걸러 보여준다. */
export function ProjectRecordsTab() {
  const { project } = useProjectContext();
  const data = useRepositoryData((repos) => repos.activities.list({ projectId: project.id }), [project.id]);

  if (data.status === 'loading') return <LoadingState />;
  if (data.status === 'error') return <StateMessage tone="error" title="기록을 불러오지 못했어요." />;

  return (
    <section aria-labelledby="project-records-title">
      <SectionHeader id="project-records-title" title="프로젝트 활동 기록" meta={`${data.data.length}건`} />
      {data.data.length === 0 ? (
        <StateMessage title="아직 기록이 없어요." description="산출물 추가, TC 변경, 수행 결과 업로드, 이슈 등록이 자동으로 기록돼요." />
      ) : (
        <GroupedActivityList activities={data.data} />
      )}
    </section>
  );
}
