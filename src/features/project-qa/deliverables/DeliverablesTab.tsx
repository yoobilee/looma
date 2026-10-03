import { Link, useSearchParams } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { useNow } from '@/hooks/useNow';
import { useRepositoryData } from '@/hooks/useRepositoryData';
import { deliverableTypeBadge, deliverableTypeLabel, projectStageLabel, projectStageOrder } from '@/domain/labels';
import type { Deliverable, ProjectStage } from '@/domain/types';
import { formatMonthDay } from '@/lib/date';
import { revealElement } from '@/lib/revealElement';
import { ButtonLink, Button } from '@/components/ui/Button';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { LoadingState, StateMessage } from '@/components/ui/StateMessage';
import { loadProjectOverview } from '@/features/projects/loadProjectOverview';
import { useProjectContext } from '../projectContext';
import styles from './DeliverablesTab.module.css';

function nextActionFor(deliverable: Deliverable, projectPath: string, hasTemplate: boolean) {
  if (deliverable.type === 'xlsx' || deliverable.type === 'csv') {
    return { label: hasTemplate ? 'Template 보기' : 'Template 설정', to: `${projectPath}/test-design?panel=template` };
  }
  if (deliverable.type === 'figma') return { label: '변경 보기', to: `${projectPath}/requirements?filter=changes` };
  if (deliverable.analyzedAt) return { label: 'TC 생성', to: `${projectPath}/requirements` };
  return { label: '분석 대기', to: undefined };
}

export function DeliverablesTab() {
  const { project, openDeliverableCreate } = useProjectContext();
  const projectPath = `/projects/${project.id}`;
  const now = useNow();
  // 기록 등에서 `?deliverable=<id>`로 들어오면 그 산출물을 표시한다. 이 프로젝트의 산출물이 아니면 아무것도 고르지 않는다.
  const selectedId = useSearchParams()[0].get('deliverable');
  const data = useRepositoryData(
    async (repos) => ({
      deliverables: await repos.deliverables.listByProject(project.id),
      requirements: await repos.requirements.listByProject(project.id),
      overview: await loadProjectOverview(repos, project),
    }),
    [project],
  );

  if (data.status === 'loading') return <LoadingState />;
  if (data.status === 'error') return <StateMessage tone="error" title="산출물을 불러오지 못했어요." />;

  const { deliverables, requirements, overview } = data.data;
  const recentCount = deliverables.filter((item) => now.getTime() - new Date(item.importedAt).getTime() < 3 * 24 * 3600 * 1000).length;
  const analyzedCount = deliverables.filter((item) => item.analyzedAt).length;
  const features = new Set(requirements.map((requirement) => requirement.feature));
  const changeCount = requirements.filter((requirement) => requirement.lifecycle === 'changed').length;
  const stageIndex = projectStageOrder.indexOf(project.currentStage);

  const stageDetail: Record<ProjectStage, string> = {
    deliverables: `${deliverables.length}개 중 ${analyzedCount}개 분석 완료`,
    requirements: requirements.length ? `기능 ${features.size} · 확인 필요 ${overview.needsConfirmationCount}` : '분석 전',
    test_design: overview.testCaseCount ? `TC ${overview.testCaseCount} · 초안 ${overview.draftCount}` : '설계 전',
    results: overview.latestImport ? `${overview.latestImport.round}차 · 수행률 ${overview.executionRate}%` : '수행 결과 없음',
    issues: `이슈 ${overview.openIssueCount} · 확인사항 ${overview.openQuestionCount}`,
  };

  return (
    <div className={styles.layout}>
      <section aria-labelledby="deliverables-title" className={styles.main}>
        <SectionHeader id="deliverables-title" title="산출물" meta={`${deliverables.length}개 · 최근 추가 ${recentCount}개`} />

        {deliverables.length === 0 ? (
          <StateMessage
            title="아직 산출물이 없어요."
            description="기획서, 디자인, 기존 TC를 추가하면 요구사항 분석과 TC 설계의 근거로 쓰여요."
            action={
              <Button variant="primary" onClick={openDeliverableCreate}>
                산출물 추가
              </Button>
            }
          />
        ) : (
          <ul className={styles.list}>
            {deliverables.map((deliverable) => {
              const selected = !!selectedId && deliverable.id === selectedId;
              const action = nextActionFor(deliverable, projectPath, overview.hasTemplate);
              const featureCount = new Set(requirements.filter((item) => item.sourceRefs.some((ref) => ref.deliverableId === deliverable.id)).map((item) => item.feature)).size;
              const confirmCount = requirements.filter((item) => item.needsConfirmation && item.sourceRefs.some((ref) => ref.deliverableId === deliverable.id)).length;
              const meta = [
                deliverable.version,
                deliverable.summary,
                featureCount > 0 && `기능 ${featureCount}개`,
                confirmCount > 0 && `확인 필요 ${confirmCount}개`,
                `${formatMonthDay(deliverable.importedAt)} 추가`,
              ].filter(Boolean);
              return (
                <li
                  key={deliverable.id}
                  className={`${styles.item} ${selected ? styles.selected : ''}`}
                  aria-current={selected ? 'true' : undefined}
                  ref={selected ? revealElement : undefined}
                >
                  <span className={`${styles.badge} ${styles[deliverable.type]}`} aria-label={deliverableTypeLabel[deliverable.type]}>
                    {deliverableTypeBadge[deliverable.type]}
                  </span>
                  <div className={styles.text}>
                    <p className={styles.title}>
                      {selected && <span className="visually-hidden">선택한 산출물: </span>}
                      {deliverable.sourceUrl ? (
                        <a href={deliverable.sourceUrl} target="_blank" rel="noopener noreferrer">
                          {deliverable.title}
                          <ExternalLink aria-hidden />
                          <span className="visually-hidden">(새 창)</span>
                        </a>
                      ) : (
                        deliverable.title
                      )}
                    </p>
                    <p className={styles.meta}>{meta.join(' · ')}</p>
                  </div>
                  {action.to ? (
                    <ButtonLink to={action.to} size="sm" variant="secondary">
                      {action.label}
                    </ButtonLink>
                  ) : (
                    <span className={styles.pending}>{action.label}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {!overview.hasTemplate && (
          <div className={styles.templateCallout}>
            <div>
              <p className={styles.calloutTitle}>새 프로젝트라면 TC 양식부터 만들 수 있어요.</p>
              <p className={styles.calloutText}>프로젝트 설명 → AI가 컬럼 / Depth / 결과 구조 초안 생성 → 검토 후 저장</p>
            </div>
            <ButtonLink to={`${projectPath}/test-design?entry=description`} variant="inverse">
              TC 양식 만들기
            </ButtonLink>
          </div>
        )}
      </section>

      <aside className={styles.aside}>
        <section aria-labelledby="project-status-title">
          <SectionHeader id="project-status-title" title="현재 상태" meta="자동 요약" />
          <ol className={styles.stages}>
            {projectStageOrder.map((stage, index) => {
              const state = index < stageIndex ? 'done' : index === stageIndex ? 'current' : 'upcoming';
              return (
                <li key={stage} className={`${styles.stage} ${styles[state]}`} aria-current={state === 'current' ? 'step' : undefined}>
                  <span className={styles.stageDot} aria-hidden />
                  <span className={styles.stageName}>{projectStageLabel[stage]}</span>
                  <span className={styles.stageDetail}>{stageDetail[stage]}</span>
                </li>
              );
            })}
          </ol>
        </section>

        {requirements.length > 0 && (
          <section aria-labelledby="ai-analysis-title" className={styles.analysis}>
            <SectionHeader id="ai-analysis-title" title="분석 결과" meta="AI 초안 · 검토 필요" />
            <Link to={`${projectPath}/requirements`} className={`${styles.insight} ${styles.insightCoral}`}>
              <span className={styles.insightLabel}>확인 필요 · {overview.needsConfirmationCount}</span>
              <span className={styles.insightText}>{requirements.find((item) => item.needsConfirmation)?.text}</span>
            </Link>
            {changeCount > 0 && (
              <Link to={`${projectPath}/requirements?filter=changes`} className={`${styles.insight} ${styles.insightSky}`}>
                <span className={styles.insightLabel}>변경 감지 · {changeCount}</span>
                <span className={styles.insightText}>산출물 새 버전에서 달라진 요구사항 {changeCount}건</span>
              </Link>
            )}
          </section>
        )}
      </aside>
    </div>
  );
}
