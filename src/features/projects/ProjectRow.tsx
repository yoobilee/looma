import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { platformLabel, projectStageLabel, projectStatusLabel, testScopeLabel } from '@/domain/labels';
import { formatDateRange } from '@/lib/date';
import { ProgressBar } from '@/components/ui/ProgressBar';
import type { ProjectOverview } from './loadProjectOverview';
import styles from './ProjectRow.module.css';

export function ProjectRow({ overview }: { overview: ProjectOverview }) {
  const { project } = overview;
  const archived = project.status === 'archived';
  const stats = [
    `산출물 ${overview.deliverableCount}`,
    `TC ${overview.testCaseCount}`,
    overview.draftCount > 0 && `초안 ${overview.draftCount}`,
    overview.hasTemplate ? 'TC Template 설정됨' : 'TC Template 미설정',
  ].filter(Boolean);

  return (
    <Link to={`/projects/${project.id}`} className={`${styles.row} ${archived ? styles.archived : ''}`}>
      <div className={styles.main}>
        <p className={`${styles.status} ${styles[project.status]}`}>{projectStatusLabel[project.status]}</p>
        <h2 className={styles.name}>{project.name}</h2>
        <p className={styles.scope}>
          {project.testScopes.map((scope) => testScopeLabel[scope]).join(' · ')}
          <span className={styles.divider} aria-hidden>
            |
          </span>
          {project.platforms.map((platform) => platformLabel[platform]).join(' / ')}
          <span className={styles.divider} aria-hidden>
            |
          </span>
          {formatDateRange(project.startDate, project.endDate)}
        </p>
        <p className={styles.stats}>
          {stats.join(' · ')}
          {!archived && <span className={styles.stage}>현재 단계 · {projectStageLabel[project.currentStage]}</span>}
        </p>
      </div>

      <div className={styles.progress}>
        {overview.executionRate !== undefined ? (
          <>
            <p className={styles.rate}>
              {overview.executionRate}
              <span>%</span>
            </p>
            <ProgressBar value={overview.executionRate} label={`${project.name} 수행률`} />
            <p className={styles.rateCaption}>{overview.latestImport?.round}차 수행 결과 기준 수행률</p>
          </>
        ) : (
          <>
            <p className={`${styles.rate} ${styles.rateEmpty}`}>—</p>
            <ProgressBar value={0} label={`${project.name} 수행률`} />
            <p className={styles.rateCaption}>아직 수행 결과가 없어요</p>
          </>
        )}
      </div>
      <ArrowRight aria-hidden className={styles.arrow} />
    </Link>
  );
}
