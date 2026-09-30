import { useState } from 'react';
import { repositories } from '@/data';
import { useRepositoryData } from '@/hooks/useRepositoryData';
import { pendingDecisionCount, planChangeApplication, summarizeChangeAnalysis } from '@/domain/changeImpact';
import {
  changeAnalysisStatusLabel,
  duplicateResolutionLabel,
  requirementChangeLabel,
  requirementChangeOrder,
  reviewDecisionLabel,
  testImpactLabel,
  testImpactOrder,
} from '@/domain/labels';
import type {
  ChangeAnalysis,
  ChangeApplySummary,
  Deliverable,
  DuplicateResolution,
  RequirementChange,
  RequirementChangeKind,
  ReviewDecision,
  TestCase,
  TestImpact,
  TestImpactKind,
} from '@/domain/types';
import { formatMonthDay } from '@/lib/date';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
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

const statusTone: Record<ChangeAnalysis['status'], TagTone> = {
  draft: 'outline',
  reviewed: 'sky',
  applied: 'pass',
};

const reviewOptions: ReviewDecision[] = ['accepted', 'rejected'];
const duplicateOptions: DuplicateResolution[] = ['modify_existing', 'create_separate', 'excluded'];

/** 반영 결과를 화면에 보여줄 순서대로 나열한다. */
function applySummaryItems(summary: ChangeApplySummary): [string, number][] {
  return [
    ['요구사항 신규', summary.requirementsAdded],
    ['요구사항 수정', summary.requirementsModified],
    ['요구사항 제거', summary.requirementsRemoved],
    ['TC 신규', summary.testCasesCreated],
    ['TC 수정', summary.testCasesModified],
    ['TC 폐기', summary.testCasesDeprecated],
  ];
}

function applySummaryText(summary: ChangeApplySummary): string {
  const items = applySummaryItems(summary).filter(([, count]) => count > 0);
  return items.length === 0 ? '바뀌는 항목 없음' : items.map(([label, count]) => `${label} ${count}`).join(' · ');
}

interface ChoiceGroupProps<T extends string> {
  label: string;
  value: T | undefined;
  options: T[];
  optionLabel: Record<T, string>;
  disabled: boolean;
  onChange: (value: T) => void;
}

/** 수락/제외, 중복 처리 방법처럼 하나를 고르는 판단 버튼 묶음 */
function ChoiceGroup<T extends string>({ label, value, options, optionLabel, disabled, onChange }: ChoiceGroupProps<T>) {
  return (
    <div className={styles.choices} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          className={styles.choice}
          aria-pressed={value === option}
          disabled={disabled}
          onClick={() => onChange(option)}
        >
          {optionLabel[option]}
        </button>
      ))}
    </div>
  );
}

function DecisionResult({ label, pending }: { label: string; pending: boolean }) {
  return <p className={`${styles.decisionResult} ${pending ? styles.decisionPending : ''}`}>판단 · {label}</p>;
}

interface ChangeImpactPanelProps {
  projectId: string;
  testCases: TestCase[];
  deliverables: Deliverable[];
}

/**
 * 최신 변경 영향 분석. 항목별 판단(draft) → 검토 완료(reviewed) → 반영(applied) 순서로 진행한다.
 * 반영 버튼을 누르기 전까지 기존 요구사항과 TC는 바뀌지 않는다.
 */
export function ChangeImpactPanel({ projectId, testCases, deliverables }: ChangeImpactPanelProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

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

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '처리하지 못했어요.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const isDraft = analysis.status === 'draft';
  const pending = pendingDecisionCount(analysis);
  const summary = summarizeChangeAnalysis(analysis);

  // 반영 전 미리보기. 실제 반영과 같은 계산을 하되 저장하지 않는다.
  let preview: { summary?: ChangeApplySummary; problem?: string } = {};
  if (analysis.status === 'reviewed') {
    try {
      preview = {
        summary: planChangeApplication(
          analysis,
          { requirements, testCases, testConditions: conditions, deliverables },
          { now: analysis.reviewedAt ?? analysis.createdAt, createId: (prefix) => `${prefix}-preview` },
        ).summary,
      };
    } catch (caught) {
      preview = { problem: caught instanceof Error ? caught.message : '반영할 수 없어요.' };
    }
  }

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
    // 반영 후에는 기존 요구사항 원문이 이미 바뀌어 있으므로 제안 문장을 우선 보여 준다.
    return change.proposal?.text ?? existing?.text ?? '';
  };
  const testCaseLabel = (id?: string) => {
    const testCase = testCases.find((item) => item.id === id);
    return testCase ? `${testCase.externalId ?? '고객사 ID 미지정'} ${testCase.title}` : undefined;
  };
  const proposedTitle = (impact: TestImpact) => impact.changes?.title ?? impact.newTestCase?.title;

  const caption =
    analysis.status === 'draft'
      ? '새 산출물 기준으로 만든 제안이에요. 항목마다 판단하고 검토를 완료해도, "변경사항 반영"을 누르기 전까지 실제 요구사항과 TC는 바뀌지 않아요.'
      : analysis.status === 'reviewed'
        ? '검토를 마쳤어요. 반영 결과를 확인하고 반영하면 요구사항과 TC에 실제로 적용돼요.'
        : `${analysis.appliedAt ? `${formatMonthDay(analysis.appliedAt)} ` : ''}반영을 마쳤어요. 아래 판단 결과가 요구사항과 TC에 적용됐어요.`;

  return (
    <section className={styles.panel} aria-labelledby="impact-title">
      <SectionHeader
        id="impact-title"
        title="변경 영향 분석"
        meta={`${target?.title ?? ''} · ${comparison}`}
        action={
          <ButtonLink to={`/projects/${projectId}/requirements`} variant="secondary" size="sm">
            요구사항 목록 보기
          </ButtonLink>
        }
      />
      <div className={styles.statusRow}>
        <Tag tone={statusTone[analysis.status]}>{changeAnalysisStatusLabel[analysis.status]}</Tag>
        <p className={styles.caption}>{caption}</p>
      </div>

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

      <details className={styles.group} open={isDraft}>
        <summary>요구사항 변경 {analysis.requirementChanges.length}건</summary>
        <ul className={styles.items}>
          {analysis.requirementChanges.map((change) => {
            const existing = requirements.find((item) => item.id === change.requirementId);
            const decidable = change.kind !== 'unchanged';
            return (
              <li key={change.id} className={styles.item}>
                <Tag tone={requirementTone[change.kind]}>{requirementChangeLabel[change.kind]}</Tag>
                <div className={styles.itemBody}>
                  <p className={styles.itemTitle}>{requirementText(change)}</p>
                  {change.kind === 'modified' && existing && analysis.status !== 'applied' && <p className={styles.itemMeta}>기존 · {existing.text}</p>}
                  {change.note && <p className={styles.itemMeta}>{change.note}</p>}
                  <p className={styles.itemMeta}>
                    {change.feature} · {change.requirementId ? '기존 요구사항과 연결' : '새 요구사항'}
                  </p>
                  {decidable &&
                    (isDraft ? (
                      <ChoiceGroup
                        label={`${requirementChangeLabel[change.kind]} 요구사항 판단`}
                        value={change.decision}
                        options={reviewOptions}
                        optionLabel={reviewDecisionLabel}
                        disabled={busy}
                        onChange={(decision) => void run(() => repositories.changeAnalyses.updateRequirementDecision(analysis.id, change.id, decision))}
                      />
                    ) : (
                      <DecisionResult label={reviewDecisionLabel[change.decision ?? 'pending']} pending={(change.decision ?? 'pending') === 'pending'} />
                    ))}
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
            const proposal = proposedTitle(impact);
            return (
              <li key={impact.id} className={styles.item}>
                <Tag tone={impactTone[impact.kind]}>{testImpactLabel[impact.kind]}</Tag>
                <div className={styles.itemBody}>
                  <p className={styles.itemTitle}>
                    {impact.kind === 'create' ? impact.newTestCase?.title : existing}
                    {impact.kind !== 'create' && proposal && analysis.status !== 'applied' && <span className={styles.proposal}> → {proposal}</span>}
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
                  {impact.kind === 'duplicate_candidate' &&
                    (isDraft ? (
                      <ChoiceGroup
                        label="중복 후보 처리 방법"
                        value={impact.duplicateResolution === 'pending' ? undefined : impact.duplicateResolution}
                        options={duplicateOptions}
                        optionLabel={duplicateResolutionLabel}
                        disabled={busy}
                        onChange={(resolution) => void run(() => repositories.changeAnalyses.resolveDuplicate(analysis.id, impact.id, resolution))}
                      />
                    ) : (
                      <DecisionResult
                        label={duplicateResolutionLabel[impact.duplicateResolution ?? 'pending']}
                        pending={(impact.duplicateResolution ?? 'pending') === 'pending'}
                      />
                    ))}
                  {impact.kind !== 'duplicate_candidate' &&
                    impact.kind !== 'keep' &&
                    (isDraft ? (
                      <ChoiceGroup
                        label={`${testImpactLabel[impact.kind]} 판단`}
                        value={impact.decision}
                        options={reviewOptions}
                        optionLabel={reviewDecisionLabel}
                        disabled={busy}
                        onChange={(decision) => void run(() => repositories.changeAnalyses.updateTestImpactDecision(analysis.id, impact.id, decision))}
                      />
                    ) : (
                      <DecisionResult label={reviewDecisionLabel[impact.decision ?? 'pending']} pending={(impact.decision ?? 'pending') === 'pending'} />
                    ))}
                </div>
              </li>
            );
          })}
        </ul>
      </details>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <div className={styles.actionBar}>
        {analysis.status === 'draft' && (
          <>
            <p className={pending > 0 ? styles.pendingNote : styles.readyNote} aria-live="polite">
              {pending > 0 ? `판단이 필요한 항목 ${pending}건` : '모든 항목을 판단했어요.'}
            </p>
            <Button variant="primary" disabled={pending > 0 || busy} onClick={() => void run(() => repositories.changeAnalyses.markReviewed(analysis.id))}>
              검토 완료
            </Button>
          </>
        )}
        {analysis.status === 'reviewed' && (
          <>
            <p className={preview.problem ? styles.pendingNote : styles.readyNote}>
              {preview.summary ? `반영 예정 · ${applySummaryText(preview.summary)}` : preview.problem}
            </p>
            <Button variant="primary" disabled={!preview.summary || busy} onClick={() => setConfirmOpen(true)}>
              변경사항 반영
            </Button>
          </>
        )}
        {analysis.status === 'applied' && analysis.appliedSummary && <p className={styles.readyNote}>반영 완료 · {applySummaryText(analysis.appliedSummary)}</p>}
      </div>

      {preview.summary && (
        <Dialog
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          width="sm"
          title="변경사항 반영"
          description="검토한 결과를 실제 요구사항과 TC에 적용해요. 반영한 분석은 다시 반영하거나 판단을 바꿀 수 없어요."
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
                취소
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  void run(() => repositories.changeAnalyses.apply(analysis.id)).then((ok) => {
                    if (ok) setConfirmOpen(false);
                  })
                }
              >
                반영
              </Button>
            </>
          }
        >
          <dl className={styles.applyList}>
            {applySummaryItems(preview.summary).map(([label, count]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{count}</dd>
              </div>
            ))}
          </dl>
          <p className={styles.itemMeta}>기존 TC의 내부 ID와 고객사 ID, 수행 결과 연결은 그대로 유지돼요. 폐기·제거는 삭제하지 않고 상태만 바꿔요.</p>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
        </Dialog>
      )}
    </section>
  );
}
