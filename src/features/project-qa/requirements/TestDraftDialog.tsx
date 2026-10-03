import { useMemo, useState } from 'react';
import { repositories } from '@/data';
import { testDraftDecisionLabel, testDraftKindLabel, testPerspectiveLabel } from '@/domain/labels';
import {
  analyzeTestDraftGeneration,
  resolveTestDraftDecisions,
  STALE_TEST_DRAFT_PREVIEW_MESSAGE,
  summarizeTestDraftAnalysis,
  testDraftDecisionOptions,
  TestDraftGenerationError,
  toTestDraftDecisionInputs,
  type AnalyzedTestDraft,
  type TestDraftAnalysis,
  type TestDraftContext,
  type TestDraftDecision,
  type TestDraftSummary,
} from '@/domain/testDraftGeneration';
import type { Deliverable, Project, Requirement, TCTemplate, TestCase, TestCondition, TestPerspective } from '@/domain/types';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Tag, type TagTone } from '@/components/ui/Tag';
import styles from './TestDraftDialog.module.css';

interface TestDraftDialogProps {
  open: boolean;
  onClose: () => void;
  project: Project;
  /** 이 프로젝트의 현재 데이터. 미리보기 판정의 기준이다. */
  requirements: Requirement[];
  deliverables: Deliverable[];
  testConditions: TestCondition[];
  testCases: TestCase[];
  templates: TCTemplate[];
  /** 초안을 만들 요구사항과 관점. 호출하는 쪽이 고른 값이다. */
  requirementIds: string[];
  perspectives: TestPerspective[];
}

type Preview = { value: TestDraftAnalysis; problem?: undefined } | { value?: undefined; problem: string };

/** 사용자가 본 미리보기: 분석 결과와, 화면에 보여준 요구사항 · 산출물(그 뒤 바뀌어도 보던 내용이 그대로 남도록 함께 붙들어 둔다). */
interface Frozen {
  result: Preview;
  requirements: Requirement[];
  deliverables: Deliverable[];
}

/** 미리보기가 같은지 비교하는 값: 후보 · 내용 · 판정이 하나라도 달라지면 달라진다. */
const signature = (preview: Preview) => preview.problem ?? preview.value.rows.map((row) => `${row.candidate.key}:${row.fingerprint}`).join('|');

/**
 * 요구사항과 테스트 관점으로 만들 TC 초안을 미리 보고, 중복을 판단한 뒤 확인했을 때만 저장한다. AI가 만드는 초안이 아니다.
 * 열 때 계산한 미리보기를 그대로 저장 입력으로 보낸다. 그 사이 요구사항이나 기존 TC가 바뀌면(저장소도 다시 확인한다) 저장하지 않고 다시 확인하게 한다.
 */
export function TestDraftDialog({ open, onClose, project, requirements, deliverables, testConditions, testCases, templates, requirementIds, perspectives }: TestDraftDialogProps) {
  const [chosen, setChosen] = useState<Record<string, TestDraftDecision>>({});
  const [busy, setBusy] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [result, setResult] = useState<TestDraftSummary>();

  const context: TestDraftContext = useMemo(() => ({ project, requirements, deliverables, testConditions, testCases, templates }), [project, requirements, deliverables, testConditions, testCases, templates]);
  const live = useMemo<Preview>(() => {
    try {
      return { value: analyzeTestDraftGeneration(context, { requirementIds, perspectives }) };
    } catch (error) {
      return { problem: error instanceof TestDraftGenerationError ? error.message : '초안을 계산하지 못했어요.' };
    }
  }, [context, requirementIds, perspectives]);
  // 사용자가 본 미리보기. 열 때의 계산이고, "다시 확인"을 눌러야만 지금 데이터로 바뀐다.
  const [frozen, setFrozen] = useState<Frozen>({ result: live, requirements, deliverables });
  const preview = frozen.result;
  const stale = !busy && !result && signature(live) !== signature(preview);

  const resolved = preview.value ? resolveTestDraftDecisions(preview.value, chosen) : {};
  const summary = preview.value ? summarizeTestDraftAnalysis(preview.value, chosen) : undefined;
  const requirementById = new Map(frozen.requirements.map((item) => [item.id, item]));
  const deliverableTitle = (id: string) => frozen.deliverables.find((item) => item.id === id)?.title ?? '산출물';

  const decide = (key: string, decision: TestDraftDecision) => setChosen((current) => ({ ...current, [key]: decision }));
  const recheck = () => {
    setFrozen({ result: live, requirements, deliverables });
    setChosen({});
    setApplyError('');
  };

  const apply = async () => {
    if (!preview.value) return;
    setBusy(true);
    setApplyError('');
    try {
      const created = await repositories.testCases.createDraftsFromRequirements({
        projectId: project.id,
        requirementIds,
        perspectives,
        candidates: toTestDraftDecisionInputs(preview.value, chosen),
      });
      setResult(created.summary);
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : 'TC 초안을 만들지 못했어요.');
    } finally {
      setBusy(false);
    }
  };

  const canApply = !!summary && summary.pending === 0 && summary.created + summary.linked + summary.linkedToNew > 0 && !stale && !busy;
  const statusNote = preview.problem
    ? preview.problem
    : stale
      ? STALE_TEST_DRAFT_PREVIEW_MESSAGE
      : summary && summary.pending > 0
        ? `판단하지 않은 중복 ${summary.pending}건이 있어요.`
        : summary && summary.created + summary.linked + summary.linkedToNew > 0
          ? `TC 초안 ${summary.created}건을 만들고 기존 TC ${summary.linked}건에 연결할 예정이에요.${summary.linkedToNew > 0 ? ` 만드는 TC에 요구사항 ${summary.linkedToNew}건을 더 연결해요.` : ''}`
          : '새로 반영할 TC 초안 또는 연결이 없어요.';

  const footer = result ? (
    <>
      <Button variant="ghost" onClick={onClose}>
        닫기
      </Button>
      <ButtonLink to={`/projects/${project.id}/test-design`} variant="primary">
        테스트 설계에서 보기
      </ButtonLink>
    </>
  ) : (
    <>
      <p className={canApply ? styles.readyNote : styles.pendingNote} aria-live="polite">
        {statusNote}
      </p>
      <Button variant="ghost" disabled={busy} onClick={onClose}>
        취소
      </Button>
      {(stale || applyError === STALE_TEST_DRAFT_PREVIEW_MESSAGE) && (
        <Button variant="secondary" disabled={busy} onClick={recheck}>
          미리보기 다시 확인
        </Button>
      )}
      <Button variant="primary" disabled={!canApply} onClick={() => void apply()}>
        TC 초안 만들기
      </Button>
    </>
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width="xl"
      title="TC 초안 만들기"
      description="선택한 요구사항과 테스트 관점으로 기본 TC 초안을 만들어요. 만들기를 누르기 전까지는 아무것도 바뀌지 않아요."
      footer={footer}
    >
      <div className={styles.body}>
        {result && (
          <div className={styles.done} role="status">
            <p className={styles.doneTitle}>
              TC 초안 {result.created}건을 만들고 기존 TC {result.linked}건에 연결했어요.{result.linkedToNew > 0 ? ` 만든 TC에 요구사항 ${result.linkedToNew}건을 더 연결했어요.` : ''}
            </p>
            <p>
              확인 필요 {result.needsConfirmation} · 중복 {result.duplicate} · 오류 {result.invalid} · 제외 {result.excluded}. 만든 초안은 테스트 설계에서 검토 대기 상태로 확인할 수 있어요.
            </p>
          </div>
        )}

        {!result && preview.problem && (
          <p className={styles.problems} role="alert">
            {preview.problem}
          </p>
        )}

        {!result && stale && (
          <p className={styles.problems} role="alert">
            {STALE_TEST_DRAFT_PREVIEW_MESSAGE}
          </p>
        )}

        {!result && preview.value && summary && (
          <>
            <dl className={styles.counts} aria-label="초안 판정 요약">
              <Count label="대상 요구사항" value={summary.requirementCount} />
              <Count label="선택 관점" value={summary.perspectiveCount} />
              <Count label="생성 후보" value={summary.created} />
              <Count label="기존 TC 연결" value={summary.linked} />
              <Count label="생성 TC 연결" value={summary.linkedToNew} />
              <Count label="확인 필요" value={summary.needsConfirmation} />
              <Count label="중복" value={summary.duplicate} />
              <Count label="판단 필요" value={summary.pending} />
              <Count label="오류" value={summary.invalid} />
              <Count label="제외" value={summary.excluded} />
            </dl>
            <ul className={styles.notices}>
              <li>AI가 만든 초안이 아니에요. 요구사항 문장과 선택한 관점으로 만든 기본 초안이라, 화면 문구 · 입력값 같은 구체적인 내용은 검토하면서 채워 주세요.</li>
              <li>기존 TC와 테스트 조건은 바꾸지 않아요. 같은 내용의 TC가 이미 있으면 기존 TC와 연결 · 별도 신규 · 제외 중에서 직접 골라 주세요. 연결은 요구사항 · 테스트 조건 · 근거 연결만 더하고 TC 내용은 그대로예요.</li>
              <li>확인 필요 요구사항으로 만든 초안은 확인이 끝나기 전에는 검토 완료로 표시할 수 없어요. 고객사 TC ID는 만들지 않아요.</li>
            </ul>
            {preview.value.skipped.length > 0 && (
              <details className={styles.skipped}>
                <summary>단서가 없어 만들지 않은 조합 {preview.value.skipped.length}건</summary>
                <ul>
                  {preview.value.skipped.map((item) => (
                    <li key={`${item.requirementId}-${item.perspective}`}>
                      {requirementById.get(item.requirementId)?.text ?? item.requirementId} · {testPerspectiveLabel[item.perspective]} — {item.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {applyError && (
              <p className={styles.error} role="alert">
                {applyError}
              </p>
            )}

            {preview.value.rows.length > 0 ? (
              <div className={styles.scroller} role="region" aria-label="TC 초안 미리보기 표" tabIndex={0}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">요구사항</th>
                      <th scope="col">관점</th>
                      <th scope="col">테스트 조건</th>
                      <th scope="col">TC 초안</th>
                      <th scope="col">근거</th>
                      <th scope="col">판정</th>
                      <th scope="col">처리</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.value.rows.map((row) => (
                      <PreviewRow
                        key={row.candidate.key}
                        row={row}
                        decision={resolved[row.candidate.key]}
                        requirementTexts={row.candidate.requirementIds.map((id) => requirementById.get(id)).filter((item): item is Requirement => !!item)}
                        sourceText={row.sourceRefs.map((ref) => `${deliverableTitle(ref.deliverableId)} ${ref.locator}`).join(', ')}
                        batchTitle={row.duplicateTarget?.type === 'batch' ? preview.value.rows.find((item) => item.candidate.key === (row.duplicateTarget as { key: string }).key)?.candidate.testCase.title : undefined}
                        onDecide={(decision) => decide(row.candidate.key, decision)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className={styles.caption}>선택한 요구사항과 관점으로 만들 수 있는 후보가 없어요. 관점을 바꾸거나 요구사항을 더 골라 보세요.</p>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

const kindTone: Record<AnalyzedTestDraft['kind'], TagTone> = { create: 'sky', duplicate: 'neutral', invalid: 'coral' };

interface PreviewRowProps {
  row: AnalyzedTestDraft;
  decision: TestDraftDecision;
  requirementTexts: Requirement[];
  sourceText: string;
  batchTitle?: string;
  onDecide: (decision: TestDraftDecision) => void;
}

function PreviewRow({ row, decision, requirementTexts, sourceText, batchTitle, onDecide }: PreviewRowProps) {
  const { candidate, kind, reasons, duplicateTarget } = row;
  const verdict =
    kind === 'create'
      ? decision === 'excluded'
        ? { label: '제외', tone: 'outline' as const }
        : row.needsConfirmation
          ? { label: '확인 필요', tone: 'coral' as const }
          : { label: testDraftKindLabel.create, tone: kindTone.create }
      : { label: testDraftKindLabel[kind], tone: kindTone[kind] };
  const options = testDraftDecisionOptions(row);
  const alreadyLinked = duplicateTarget?.type === 'existing' && duplicateTarget.linked;
  return (
    <tr>
      <td className={styles.wide}>
        {requirementTexts.map((requirement) => (
          <div key={requirement.id}>
            <p className={styles.rowTitle}>{requirement.text}</p>
            <p className={styles.meta}>{requirement.feature}</p>
          </div>
        ))}
        {requirementTexts.length === 0 && <span className={styles.muted}>요구사항 없음</span>}
      </td>
      <td className={styles.rowNumber}>{testPerspectiveLabel[candidate.perspective]}</td>
      <td className={styles.wide}>{candidate.condition.title}</td>
      <td className={styles.wide}>
        <p className={styles.rowTitle}>{candidate.testCase.title}</p>
        <p className={styles.meta}>기대 결과 · {candidate.testCase.expectedResult}</p>
        {duplicateTarget?.type === 'existing' && (
          <p className={styles.meta}>
            기존 TC · {duplicateTarget.label} · {duplicateTarget.linked ? '이 요구사항이 이미 연결돼 있어요' : '이 요구사항은 연결돼 있지 않아요'}
          </p>
        )}
        {duplicateTarget?.type === 'batch' && <p className={styles.meta}>이번에 만드는 TC · {batchTitle ?? '앞선 후보'}와 같은 내용이에요</p>}
        {reasons.length > 0 && (
          <ul className={styles.issues}>
            {reasons.map((reason) => (
              <li key={reason} className={kind === 'invalid' ? styles.issueError : styles.issueWarning}>
                {kind === 'invalid' ? '오류' : '확인'} · {reason}
              </li>
            ))}
          </ul>
        )}
        {kind === 'duplicate' && decision === 'excluded' && !alreadyLinked && <p className={styles.issueError}>제외하면 이 요구사항은 같은 내용의 TC와 연결되지 않아요.</p>}
        {kind === 'duplicate' && decision === 'pending' && <p className={styles.issueError}>이 중복을 어떻게 할지 골라 주세요.</p>}
      </td>
      <td className={styles.meta}>{sourceText || <span className={styles.muted}>근거 없음</span>}</td>
      <td>
        <Tag tone={verdict.tone}>{verdict.label}</Tag>
      </td>
      <td>
        {kind === 'create' ? (
          <label className={styles.exclude}>
            <input type="checkbox" checked={decision === 'excluded'} aria-label={`제외: ${candidate.testCase.title}`} onChange={(event) => onDecide(event.target.checked ? 'excluded' : 'create')} />
            <span aria-hidden>제외</span>
          </label>
        ) : kind === 'duplicate' ? (
          alreadyLinked && decision === 'excluded' ? (
            <p className={styles.meta}>이미 연결됨 · 할 일 없음</p>
          ) : null
        ) : (
          <span className={styles.muted}>만들지 않음</span>
        )}
        {kind === 'duplicate' && (
          <select
            className={styles.decision}
            value={decision}
            aria-label={`중복 처리: ${candidate.testCase.title}`}
            onChange={(event) => onDecide(event.target.value as TestDraftDecision)}
          >
            {decision === 'pending' && <option value="pending">{testDraftDecisionLabel.pending}</option>}
            {options.map((option) => (
              <option key={option} value={option}>
                {option === 'link_existing' && duplicateTarget?.type === 'batch' ? '앞선 후보 TC와 연결' : testDraftDecisionLabel[option]}
              </option>
            ))}
          </select>
        )}
      </td>
    </tr>
  );
}
