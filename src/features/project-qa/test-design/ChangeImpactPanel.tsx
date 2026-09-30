import { useRepositoryData } from '@/hooks/useRepositoryData';
import { summarizeChangeAnalysis } from '@/domain/changeImpact';
import {
  changeAnalysisStatusLabel,
  requirementChangeLabel,
  requirementChangeOrder,
  testImpactLabel,
  testImpactOrder,
} from '@/domain/labels';
import type { Deliverable, RequirementChange, RequirementChangeKind, TestCase, TestImpactKind } from '@/domain/types';
import { ButtonLink } from '@/components/ui/Button';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { Tag, type TagTone } from '@/components/ui/Tag';
import styles from './ChangeImpactPanel.module.css';

const requirementTone: Record<RequirementChangeKind, TagTone> = {
  added: 'sky',
  modified: 'outline',
  removed: 'coral',
  unchanged: 'neutral',
};

const impactTone: Record<TestImpactKind, TagTone> = {
  create: 'sky',
  modify: 'outline',
  keep: 'neutral',
  deprecate: 'coral',
  duplicate_candidate: 'blocked',
};

interface ChangeImpactPanelProps {
  projectId: string;
  testCases: TestCase[];
  deliverables: Deliverable[];
}

/**
 * 최신 변경 영향 분석 요약. 모든 항목은 제안이며, 검토 전에는 기존 요구사항과 TC를 바꾸지 않는다.
 */
export function ChangeImpactPanel({ projectId, testCases, deliverables }: ChangeImpactPanelProps) {
  const data = useRepositoryData(
    async (repos) => ({
      analyses: await repos.changeAnalyses.listByProject(projectId),
      requirements: await repos.requirements.listByProject(projectId),
      conditions: await repos.testConditions.listByProject(projectId),
    }),
    [projectId],
  );

  if (data.status !== 'success') return null;
  const { analyses, requirements, conditions } = data.data;
  const analysis = analyses[0];

  if (!analysis) {
    return (
      <section className={styles.panel} aria-labelledby="impact-title">
        <SectionHeader id="impact-title" title="변경 영향 분석" />
        <p className={styles.caption}>산출물의 새 버전이 들어오면 기존 요구사항·TC와 비교한 신규 / 수정 / 유지 / 폐기 제안을 여기서 검토해요.</p>
      </section>
    );
  }

  const summary = summarizeChangeAnalysis(analysis);
  const deliverableLabel = (id?: string) => {
    const deliverable = deliverables.find((item) => item.id === id);
    return deliverable ? (deliverable.version ?? deliverable.title) : undefined;
  };
  const target = deliverables.find((item) => item.id === analysis.targetDeliverableId);
  const comparison = analysis.baselineDeliverableId
    ? `${deliverableLabel(analysis.baselineDeliverableId)} → ${deliverableLabel(analysis.targetDeliverableId)}`
    : `${target?.title ?? '새 산출물'} · 기존 자산과 비교`;

  const requirementText = (change: RequirementChange) => {
    const existing = requirements.find((item) => item.id === change.requirementId);
    return change.proposedText ?? existing?.text ?? '';
  };
  const testCaseLabel = (id?: string) => {
    const testCase = testCases.find((item) => item.id === id);
    return testCase ? `${testCase.externalId ?? testCase.id} ${testCase.title}` : undefined;
  };

  return (
    <section className={styles.panel} aria-labelledby="impact-title">
      <SectionHeader
        id="impact-title"
        title="변경 영향 분석"
        meta={`${target?.title ?? ''} · ${comparison} · ${changeAnalysisStatusLabel[analysis.status]}`}
        action={
          <ButtonLink to={`/projects/${projectId}/requirements`} variant="secondary" size="sm">
            요구사항 목록 보기
          </ButtonLink>
        }
      />
      <p className={styles.caption}>새 산출물 기준으로 만든 제안이에요. 검토해서 반영하기 전까지 기존 요구사항과 TC는 바뀌지 않아요.</p>

      <div className={styles.summary}>
        <div className={styles.countRow}>
          <p className={styles.countLabel} id="impact-requirements-label">
            요구사항
          </p>
          <dl className={styles.counts} aria-labelledby="impact-requirements-label">
            {requirementChangeOrder.map((kind) => (
              <div key={kind}>
                <dt>{requirementChangeLabel[kind]}</dt>
                <dd>{summary.requirements[kind]}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className={styles.countRow}>
          <p className={styles.countLabel} id="impact-tests-label">
            TC
          </p>
          <dl className={styles.counts} aria-labelledby="impact-tests-label">
            {testImpactOrder.map((kind) => (
              <div key={kind}>
                <dt>{testImpactLabel[kind]}</dt>
                <dd>{summary.testImpacts[kind]}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      <details className={styles.group}>
        <summary>요구사항 변경 {analysis.requirementChanges.length}건</summary>
        <ul className={styles.items}>
          {analysis.requirementChanges.map((change) => {
            const existing = requirements.find((item) => item.id === change.requirementId);
            return (
              <li key={change.id} className={styles.item}>
                <Tag tone={requirementTone[change.kind]}>{requirementChangeLabel[change.kind]}</Tag>
                <div>
                  <p className={styles.itemTitle}>{requirementText(change)}</p>
                  {change.kind === 'modified' && existing && <p className={styles.itemMeta}>기존 · {existing.text}</p>}
                  {change.note && <p className={styles.itemMeta}>{change.note}</p>}
                  <p className={styles.itemMeta}>
                    {change.feature} · {change.requirementId ? '기존 요구사항과 연결' : '새 요구사항'}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      </details>

      <details className={styles.group} open>
        <summary>TC 영향 {analysis.testImpacts.length}건</summary>
        <ul className={styles.items}>
          {analysis.testImpacts.map((impact) => {
            const linkedRequirements = analysis.requirementChanges.filter((change) => impact.requirementChangeIds.includes(change.id));
            const linkedConditions = conditions.filter((item) => impact.testConditionIds.includes(item.id));
            const existing = testCaseLabel(impact.testCaseId);
            return (
              <li key={impact.id} className={styles.item}>
                <Tag tone={impactTone[impact.kind]}>{testImpactLabel[impact.kind]}</Tag>
                <div>
                  <p className={styles.itemTitle}>
                    {impact.kind === 'create' ? impact.proposedTitle : existing}
                    {impact.kind !== 'create' && impact.proposedTitle && <span className={styles.proposal}> → {impact.proposedTitle}</span>}
                  </p>
                  <p className={styles.itemMeta}>{impact.reason}</p>
                  <dl className={styles.links}>
                    {linkedRequirements.length > 0 && (
                      <div>
                        <dt>요구사항</dt>
                        <dd>{linkedRequirements.map((change) => `${requirementChangeLabel[change.kind]} · ${requirementText(change)}`).join(' / ')}</dd>
                      </div>
                    )}
                    {linkedConditions.length > 0 && (
                      <div>
                        <dt>테스트 조건</dt>
                        <dd>{linkedConditions.map((item) => item.title).join(' / ')}</dd>
                      </div>
                    )}
                    {impact.kind === 'duplicate_candidate' && existing && (
                      <div>
                        <dt>비교 대상 TC</dt>
                        <dd>{existing}</dd>
                      </div>
                    )}
                  </dl>
                </div>
              </li>
            );
          })}
        </ul>
      </details>
    </section>
  );
}
