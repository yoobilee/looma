import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useRepositoryData } from '@/hooks/useRepositoryData';
import type { ProjectStatus } from '@/domain/types';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { LoadingState, StateMessage } from '@/components/ui/StateMessage';
import { loadProjectOverview } from './loadProjectOverview';
import { ProjectRow } from './ProjectRow';
import { ProjectCreateDialog } from './ProjectCreateDialog';
import styles from './ProjectsPage.module.css';

const statusOrder: Record<ProjectStatus, number> = { active: 0, preparing: 1, archived: 2 };

export function ProjectsPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const data = useRepositoryData(async (repos) => {
    const projects = await repos.projects.list();
    const overviews = await Promise.all(projects.map((project) => loadProjectOverview(repos, project)));
    return overviews.sort((a, b) => statusOrder[a.project.status] - statusOrder[b.project.status]);
  }, []);

  return (
    <>
      <PageHeader eyebrow="프로젝트" title="QA 프로젝트" searchPlaceholder="프로젝트 검색" />

      <div className={styles.intro}>
        <div>
          <h2 className={styles.introTitle}>프로젝트마다 테스트 범위와 양식을 다르게 가져갈 수 있어요.</h2>
          <p className={styles.introText}>기능 QA만 있는 프로젝트도, API·성능까지 포함하는 프로젝트도 같은 구조에서 확장됩니다.</p>
        </div>
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setCreateOpen(true)}>
          새 프로젝트
        </Button>
      </div>

      {data.status === 'loading' && <LoadingState />}
      {data.status === 'error' && <StateMessage tone="error" title="프로젝트를 불러오지 못했어요." />}
      {data.status === 'success' && data.data.length === 0 && (
        <StateMessage title="아직 프로젝트가 없어요." description="투입된 QA 프로젝트를 추가하면 산출물부터 수행 결과까지 한 곳에서 관리할 수 있어요." />
      )}
      {data.data && data.data.length > 0 && (
        <ul className={styles.list} aria-label="프로젝트 목록">
          {data.data.map((overview) => (
            <li key={overview.project.id}>
              <ProjectRow overview={overview} />
            </li>
          ))}
        </ul>
      )}

      <ProjectCreateDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </>
  );
}
