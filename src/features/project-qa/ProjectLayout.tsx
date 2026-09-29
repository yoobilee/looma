import { Link, NavLink, Outlet, useLocation, useParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useRepositoryData } from '@/hooks/useRepositoryData';
import { platformLabel, projectStatusLabel, testScopeLabel } from '@/domain/labels';
import { formatDateRange } from '@/lib/date';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { LoadingState, StateMessage } from '@/components/ui/StateMessage';
import { ButtonLink } from '@/components/ui/Button';
import { DeliverableCreateDialog } from './deliverables/DeliverableCreateDialog';
import type { ProjectOutletContext } from './projectContext';
import styles from './ProjectLayout.module.css';

const tabs = [
  { path: '', label: '산출물', search: '산출물 검색' },
  { path: 'requirements', label: '요구사항 분석', search: '기능, 요구사항, 확인 필요 검색' },
  { path: 'test-design', label: '테스트 설계', search: 'TC, 기능, 근거 검색' },
  { path: 'results', label: '수행 결과', search: 'TC, 결과, 이슈 검색' },
  { path: 'issues', label: '이슈 / 확인사항', search: '이슈, 질문, 기능 검색' },
  { path: 'records', label: '기록', search: '프로젝트 활동 검색' },
];

/** 프로젝트 QA 작업공간: 산출물 → 요구사항 분석 → 테스트 설계 → 수행 결과 → 이슈/확인사항 → 기록 */
export function ProjectLayout() {
  const { projectId = '' } = useParams();
  const location = useLocation();
  const [deliverableOpen, setDeliverableOpen] = useState(false);
  const project = useRepositoryData((repos) => repos.projects.get(projectId), [projectId]);

  const base = `/projects/${projectId}`;
  const currentPath = location.pathname.replace(base, '').replace(/^\//, '');
  const currentTab = tabs.find((tab) => tab.path === currentPath) ?? tabs[0];
  const isOverview = currentTab.path === '';

  if (project.status === 'loading') return <LoadingState />;
  if (project.status === 'error' || !project.data) {
    return (
      <>
        <PageHeader eyebrow="프로젝트" title="프로젝트를 찾을 수 없어요" />
        <StateMessage
          title="삭제되었거나 주소가 잘못되었어요."
          action={
            <ButtonLink to="/projects" variant="primary">
              프로젝트 목록으로
            </ButtonLink>
          }
        />
      </>
    );
  }

  const data = project.data;
  const context: ProjectOutletContext = { project: data, openDeliverableCreate: () => setDeliverableOpen(true) };

  return (
    <>
      <PageHeader
        eyebrow={
          <>
            <Link to="/projects">프로젝트</Link>
            {' · '}
            {isOverview ? 'QA 작업공간' : <Link to={base}>{data.name}</Link>}
          </>
        }
        title={isOverview ? data.name : currentTab.label}
        searchPlaceholder={isOverview ? '프로젝트에서 검색' : currentTab.search}
      />

      {isOverview && (
        <section className={styles.summary} aria-label="프로젝트 기본 정보">
          <div>
            <p className={styles.eyebrow}>
              {projectStatusLabel[data.status]} · {data.testScopes.map((scope) => testScopeLabel[scope]).join(' · ')}
            </p>
            <p className={styles.description}>{data.description ?? '프로젝트 설명을 추가하면 TC 양식 초안에 활용할 수 있어요.'}</p>
            <dl className={styles.facts}>
              <div>
                <dt>고객사 / 서비스</dt>
                <dd>{[data.clientName, data.serviceName].filter(Boolean).join(' · ') || '미정'}</dd>
              </div>
              <div>
                <dt>기간</dt>
                <dd>{formatDateRange(data.startDate, data.endDate)}</dd>
              </div>
              <div>
                <dt>플랫폼</dt>
                <dd>{data.platforms.map((platform) => platformLabel[platform]).join(' / ') || '미정'}</dd>
              </div>
            </dl>
          </div>
          <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setDeliverableOpen(true)}>
            산출물 추가
          </Button>
        </section>
      )}

      <nav className={styles.tabs} aria-label="프로젝트 작업 단계">
        {tabs.map((tab, index) => (
          <NavLink
            key={tab.path}
            to={tab.path ? `${base}/${tab.path}` : base}
            end
            className={({ isActive }) => `${styles.tab} ${isActive ? styles.active : ''}`}
          >
            <span className={styles.step} aria-hidden>
              {index + 1}
            </span>
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <div className={styles.body}>
        <Outlet context={context} />
      </div>

      <DeliverableCreateDialog open={deliverableOpen} onClose={() => setDeliverableOpen(false)} projectId={data.id} />
    </>
  );
}
