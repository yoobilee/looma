import { useMemo, useState } from 'react';
import { repositories } from '@/data';
import { testDraftKindLabel, testPerspectiveLabel } from '@/domain/labels';
import {
  analyzeTestDraftGeneration,
  summarizeTestDraftAnalysis,
  TestDraftGenerationError,
  type AnalyzedTestDraft,
  type TestDraftContext,
  type TestDraftSummary,
} from '@/domain/testDraftGeneration';
import type { Deliverable, Project, Requirement, TestCase, TestCondition, TestPerspective } from '@/domain/types';
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
  /** 초안을 만들 요구사항과 관점. 호출하는 쪽이 고른 값이다. */
  requirementIds: string[];
  perspectives: TestPerspective[];
}

/**
 * 요구사항과 테스트 관점으로 만들 TC 초안을 미리 보고, 만들 것을 확인한 뒤에만 저장한다. AI가 만드는 초안이 아니다.
 * 미리보기와 저장소는 같은 규칙으로 계산한다. 저장하기 전까지는 아무것도 바뀌지 않는다.
 */
export function TestDraftDialog({ open, onClose, project, requirements, deliverables, testConditions, testCases, requirementIds, perspectives }: TestDraftDialogProps) {
  const [excludedKeys, setExcludedKeys] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [result, setResult] = useState<TestDraftSummary>();

  const context: TestDraftContext = useMemo(() => ({ project, requirements, deliverables, testConditions, testCases }), [project, requirements, deliverables, testConditions, testCases]);
  const analysis = useMemo(() => {
    try {
      return { value: analyzeTestDraftGeneration(context, { requirementIds, perspectives }) };
    } catch (error) {
      return { problem: error instanceof TestDraftGenerationError ? error.message : '초안을 계산하지 못했어요.' };
    }
  }, [context, requirementIds, perspectives]);

  // 미리보기를 보는 동안 데이터가 바뀌어 더는 새로 만들 수 없는 후보의 제외는 넘기지 않는다(저장소는 그런 제외를 거부한다).
  const effectiveExcluded = analysis.value ? excludedKeys.filter((key) => analysis.value!.rows.some((row) => row.kind === 'create' && row.candidate.key === key)) : [];
  const summary = analysis.value ? summarizeTestDraftAnalysis(analysis.value, effectiveExcluded) : undefined;
  const requirementById = new Map(requirements.map((item) => [item.id, item]));
  const deliverableTitle = (id: string) => deliverables.find((item) => item.id === id)?.title ?? '산출물';

  const toggleExcluded = (key: string, excluded: boolean) => setExcludedKeys((current) => (excluded ? [...current.filter((item) => item !== key), key] : current.filter((item) => item !== key)));

  const apply = async () => {
    setBusy(true);
    setApplyError('');
    try {
      const created = await repositories.testCases.createDraftsFromRequirements({ projectId: project.id, requirementIds, perspectives, excludedKeys: effectiveExcluded });
      setResult(created.summary);
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : 'TC 초안을 만들지 못했어요.');
    } finally {
      setBusy(false);
    }
  };

  const canApply = !!summary && summary.created > 0 && !busy;
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
      <p className={summary && summary.created > 0 ? styles.readyNote : styles.pendingNote} aria-live="polite">
        {analysis.problem ?? (summary && summary.created > 0 ? `TC 초안 ${summary.created}건을 만들 예정이에요.` : '만들 수 있는 새 TC 초안이 없어요.')}
      </p>
      <Button variant="ghost" disabled={busy} onClick={onClose}>
        취소
      </Button>
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
            <p className={styles.doneTitle}>TC 초안 {result.created}건을 만들었어요.</p>
            <p>
              확인 필요 {result.needsConfirmation} · 중복 {result.duplicate} · 오류 {result.invalid} · 제외 {result.excluded}. 만든 초안은 테스트 설계에서 검토 대기 상태로 확인할 수 있어요.
            </p>
          </div>
        )}

        {!result && analysis.problem && (
          <p className={styles.problems} role="alert">
            {analysis.problem}
          </p>
        )}

        {!result && analysis.value && summary && (
          <>
            <dl className={styles.counts} aria-label="초안 판정 요약">
              <Count label="대상 요구사항" value={summary.requirementCount} />
              <Count label="선택 관점" value={summary.perspectiveCount} />
              <Count label="생성 후보" value={summary.created} />
              <Count label="확인 필요" value={summary.needsConfirmation} />
              <Count label="중복" value={summary.duplicate} />
              <Count label="오류" value={summary.invalid} />
              <Count label="제외" value={summary.excluded} />
            </dl>
            <ul className={styles.notices}>
              <li>AI가 만든 초안이 아니에요. 요구사항 문장과 선택한 관점으로 만든 기본 초안이라, 화면 문구 · 입력값 같은 구체적인 내용은 검토하면서 채워 주세요.</li>
              <li>기존 TC와 테스트 조건은 바꾸지 않아요. 같은 내용의 TC가 이미 있으면 중복으로 건너뛰고, 같은 테스트 조건은 다시 써요.</li>
              <li>확인 필요 요구사항으로 만든 초안은 확인이 끝나기 전에는 검토 완료로 표시할 수 없어요. 고객사 TC ID는 만들지 않아요.</li>
            </ul>
            {analysis.value.skipped.length > 0 && (
              <details className={styles.skipped}>
                <summary>단서가 없어 만들지 않은 조합 {analysis.value.skipped.length}건</summary>
                <ul>
                  {analysis.value.skipped.map((item) => (
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

            {analysis.value.rows.length > 0 ? (
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
                      <th scope="col">제외</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.value.rows.map((row) => (
                      <PreviewRow
                        key={row.candidate.key}
                        row={row}
                        excluded={effectiveExcluded.includes(row.candidate.key)}
                        requirementTexts={row.candidate.requirementIds.map((id) => requirementById.get(id)).filter((item): item is Requirement => !!item)}
                        sourceText={row.sourceRefs.map((ref) => `${deliverableTitle(ref.deliverableId)} ${ref.locator}`).join(', ')}
                        onExclude={(excluded) => toggleExcluded(row.candidate.key, excluded)}
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
  excluded: boolean;
  requirementTexts: Requirement[];
  sourceText: string;
  onExclude: (excluded: boolean) => void;
}

function PreviewRow({ row, excluded, requirementTexts, sourceText, onExclude }: PreviewRowProps) {
  const { candidate, kind, reasons } = row;
  const verdict = kind === 'create' ? (excluded ? { label: '제외', tone: 'outline' as const } : row.needsConfirmation ? { label: '확인 필요', tone: 'coral' as const } : { label: testDraftKindLabel.create, tone: kindTone.create }) : { label: testDraftKindLabel[kind], tone: kindTone[kind] };
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
        {row.duplicateOf && <p className={styles.meta}>기존 TC · {row.duplicateOf.label}</p>}
        {reasons.length > 0 && (
          <ul className={styles.issues}>
            {reasons.map((reason) => (
              <li key={reason} className={kind === 'invalid' ? styles.issueError : styles.issueWarning}>
                {kind === 'invalid' ? '오류' : '확인'} · {reason}
              </li>
            ))}
          </ul>
        )}
      </td>
      <td className={styles.meta}>{sourceText || <span className={styles.muted}>근거 없음</span>}</td>
      <td>
        <Tag tone={verdict.tone}>{verdict.label}</Tag>
      </td>
      <td>
        {kind === 'create' ? (
          <label className={styles.exclude}>
            <input type="checkbox" checked={excluded} aria-label={`제외: ${candidate.testCase.title}`} onChange={(event) => onExclude(event.target.checked)} />
            <span aria-hidden>제외</span>
          </label>
        ) : (
          <span className={styles.muted}>만들지 않음</span>
        )}
      </td>
    </tr>
  );
}
