import { useMemo, useState } from 'react';
import { repositories } from '@/data';
import {
  analyzeResultImport,
  defaultResultDecisionFor,
  linkedTestCaseId,
  planResultImport,
  resultColumnMappingProblems,
  resultCycleProblems,
  resultDecisionOptionsFor,
  resultImportFields,
  resultImportSummaryText,
  resultValueKey,
  suggestNextRound,
  suggestResultColumnMapping,
  summarizeResultImport,
  summarizeResultImportAnalysis,
  usesCyclePlatform,
  type AnalyzedResultRow,
  type ResultColumnMapping,
  type ResultCycleInput,
  type ResultImportField,
  type ResultImportRowDecision,
  type ResultMatchKind,
  type ResultRowDecision,
  type ResultValueDecision,
} from '@/domain/testResultImport';
import type { ImportTable } from '@/domain/testAssetImport';
import {
  executionTypeLabel,
  executionTypeOrder,
  platformLabel,
  resultConflictReasonLabel,
  resultImportFieldLabel,
  resultMatchLabel,
  resultMatchOrder,
  testResultLabel,
  testResultOrder,
} from '@/domain/labels';
import type { ExecutionType, Platform, ResultMapping, TestCase, TestResultImport } from '@/domain/types';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { SelectField, TextAreaField, TextField } from '@/components/ui/Field';
import { FilterTabs } from '@/components/ui/FilterTabs';
import { ResultTag, Tag, type TagTone } from '@/components/ui/Tag';
import { importFileAccept } from '../imports/importFile';
import { ImportSheetSelect } from '../imports/ImportSheetSelect';
import { useImportFile } from '../imports/useImportFile';
import styles from './ResultImportDialog.module.css';

type Step = 'file' | 'mapping' | 'cycle' | 'preview' | 'confirm' | 'done';
type RowFilter = 'all' | ResultMatchKind;

const steps: { step: Step; label: string }[] = [
  { step: 'file', label: '파일' },
  { step: 'mapping', label: '컬럼 매핑' },
  { step: 'cycle', label: '차수 정보' },
  { step: 'preview', label: '미리보기' },
  { step: 'confirm', label: '반영 확인' },
];

const matchTone: Record<ResultMatchKind, TagTone> = {
  matched: 'sky',
  unmatched: 'outline',
  conflict: 'blocked',
  invalid: 'coral',
};

const allPlatforms = Object.keys(platformLabel) as Platform[];

/** 날짜 입력 기본값(로컬 기준 오늘) */
function today(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const rawText = (raw: string) => (raw.trim() === '' ? '(빈 값)' : raw.trim());
const testCaseName = (testCase: TestCase | undefined) => (testCase ? `${testCase.externalId ?? '미지정'} · ${testCase.title}` : '찾을 수 없는 TC');

/** 고를 수 없는 판단이 남아 있으면(미리보기 중 기준 TC가 바뀐 경우) 기본 판단으로 돌아간다. */
function effectiveDecision(item: AnalyzedResultRow, decisions: Record<number, ResultRowDecision>): ResultRowDecision | undefined {
  const chosen = decisions[item.row.rowNumber];
  return chosen && resultDecisionOptionsFor(item).includes(chosen) ? chosen : defaultResultDecisionFor(item);
}

interface ResultImportDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  /** 프로젝트 플랫폼. 차수 기본 플랫폼 후보를 앞에 둔다. */
  platforms: Platform[];
  /** 이 프로젝트의 현재 기준 TC. 연결 판정의 기준이며 수정하지 않는다. */
  testCases: TestCase[];
  imports: TestResultImport[];
  templateMappings: ResultMapping[];
}

/**
 * 고객사에서 수행을 마친 결과 파일을 새 수행 차수로 가져온다.
 * 파일 → 컬럼 매핑 → 차수 정보 → 미리보기 · 판단 → 반영 확인 순서이며, 마지막 확인 전까지는 아무것도 저장하지 않는다.
 * TC 정의는 TC 가져오기에서만 다룬다. 이 흐름은 기준 TC를 만들거나 바꾸지 않는다.
 */
export function ResultImportDialog({ open, onClose, projectId, platforms, testCases, imports, templateMappings }: ResultImportDialogProps) {
  const [step, setStep] = useState<Step>('file');
  const [mapping, setMapping] = useState<ResultColumnMapping>([]);
  const [cycle, setCycle] = useState<ResultCycleInput>(() => ({ round: suggestNextRound(imports), executionType: 'full', executedFrom: today() }));
  const [roundText, setRoundText] = useState(() => String(suggestNextRound(imports)));
  const [rowDecisions, setRowDecisions] = useState<Record<number, ResultRowDecision>>({});
  const [valueDecisions, setValueDecisions] = useState<Record<string, ResultValueDecision>>({});
  const [filter, setFilter] = useState<RowFilter>('all');
  // 파일이나 시트가 바뀌면 이전 파일의 컬럼 매핑과 판단은 버리고 새 표 기준으로 다시 시작한다.
  const { fileName, table, notes, fileError, chooseFile, chooseSheet, sheetNames, sheetName, formatLabel } = useImportFile((nextTable) => {
    setMapping(nextTable ? suggestResultColumnMapping(nextTable.headers) : []);
    setRowDecisions({});
    setValueDecisions({});
    setFilter('all');
  });
  const [busy, setBusy] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [saved, setSaved] = useState<TestResultImport>();

  const inPreview = step === 'preview' || step === 'confirm';
  const analysis = useMemo(
    () => (table && inPreview ? analyzeResultImport(table, mapping, testCases, templateMappings) : undefined),
    [table, mapping, testCases, templateMappings, inPreview],
  );
  const testCaseById = useMemo(() => new Map(testCases.map((testCase) => [testCase.id, testCase])), [testCases]);
  const cyclePlatformAllowed = usesCyclePlatform(mapping);
  const cycleInput: ResultCycleInput = { ...cycle, round: roundText.trim() === '' ? Number.NaN : Number(roundText), platform: cyclePlatformAllowed ? cycle.platform : undefined };

  const decisions: ResultImportRowDecision[] = (analysis?.rows ?? []).flatMap((item) => {
    const decision = effectiveDecision(item, rowDecisions);
    return decision ? [{ rowNumber: item.row.rowNumber, kind: item.kind, testCaseId: item.testCaseId, decision }] : [];
  });

  // 저장소와 같은 계획 함수로 결과를 미리 계산한다. 막히는 이유가 있으면 첫 번째 이유를 보여준다.
  let plan: { summary?: ReturnType<typeof summarizeResultImport>; problem?: string } = {};
  if (analysis) {
    try {
      const planned = planResultImport(
        analysis,
        decisions,
        valueDecisions,
        cycleInput,
        { testCases, existingImports: imports, cyclePlatformAllowed },
        { projectId, fileName, now: '', createId: (prefix) => `${prefix}-preview` },
      );
      plan = { summary: summarizeResultImport(planned.results) };
    } catch (error) {
      plan = { problem: error instanceof Error ? error.message.replace('수행 결과를 가져올 수 없어요. ', '') : '가져올 수 없어요.' };
    }
  }

  const goToPreview = () => {
    setRowDecisions({});
    setValueDecisions({});
    setFilter('all');
    setStep('preview');
  };

  const apply = async () => {
    if (!table) return;
    setBusy(true);
    setApplyError('');
    try {
      setSaved(
        await repositories.testResults.importResults({ projectId, fileName, table, mapping, cycle: cycleInput, rowDecisions: decisions, valueDecisions }),
      );
      setStep('done');
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : '수행 결과를 가져오지 못했어요.');
    } finally {
      setBusy(false);
    }
  };

  const mappingProblems = table ? resultColumnMappingProblems(table.headers, mapping) : [];
  const cycleProblems = resultCycleProblems(cycleInput, imports);
  const counts = analysis ? summarizeResultImportAnalysis(analysis) : undefined;
  const visibleRows = (analysis?.rows ?? []).filter((item) => filter === 'all' || item.kind === filter);
  const pendingRows = decisions.filter((item) => item.decision === 'pending').length;
  const pendingValues = (analysis?.unknownValues ?? []).filter((item) => (valueDecisions[item.key] ?? 'pending') === 'pending').length;
  const unmatchedRows = (analysis?.rows ?? []).filter((item) => item.kind === 'unmatched');
  const platformOptions = [...platforms, ...allPlatforms.filter((platform) => !platforms.includes(platform))];

  const footer = {
    file: (
      <>
        <Button variant="ghost" onClick={onClose}>
          취소
        </Button>
        <Button variant="primary" disabled={!table} onClick={() => setStep('mapping')}>
          다음: 컬럼 매핑
        </Button>
      </>
    ),
    mapping: (
      <>
        <Button variant="ghost" onClick={() => setStep('file')}>
          이전
        </Button>
        <Button variant="primary" disabled={mappingProblems.length > 0} onClick={() => setStep('cycle')}>
          다음: 차수 정보
        </Button>
      </>
    ),
    cycle: (
      <>
        <Button variant="ghost" onClick={() => setStep('mapping')}>
          이전
        </Button>
        <Button variant="primary" disabled={cycleProblems.length > 0} onClick={goToPreview}>
          다음: 미리보기
        </Button>
      </>
    ),
    preview: (
      <>
        <p className={plan.summary ? styles.readyNote : styles.pendingNote} aria-live="polite">
          {plan.summary ? `결과 ${plan.summary.total}건 · 연결 ${plan.summary.linked} · 미연결 ${plan.summary.unlinked} 저장 예정` : plan.problem}
        </p>
        <Button variant="ghost" onClick={() => setStep('cycle')}>
          이전
        </Button>
        <Button variant="primary" disabled={!plan.summary} onClick={() => setStep('confirm')}>
          다음: 반영 확인
        </Button>
      </>
    ),
    confirm: (
      <>
        <Button variant="ghost" disabled={busy} onClick={() => setStep('preview')}>
          이전
        </Button>
        <Button variant="primary" disabled={!plan.summary || busy} onClick={() => void apply()}>
          수행 결과 저장
        </Button>
      </>
    ),
    done: (
      <Button variant="primary" onClick={onClose}>
        닫기
      </Button>
    ),
  }[step];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width="xl"
      title="수행 결과 가져오기"
      description="고객사 양식에서 수행을 마친 파일을 새 수행 차수로 저장해요. TC 정의는 바꾸지 않고, 저장 확인 전까지는 아무것도 바뀌지 않아요."
      footer={footer}
    >
      <div className={styles.body}>
        {step !== 'done' && (
          <ol className={styles.steps} aria-label="가져오기 단계">
            {steps.map((item, index) => (
              <li key={item.step} aria-current={item.step === step ? 'step' : undefined} className={item.step === step ? styles.currentStep : undefined}>
                <span className={styles.stepNumber}>{index + 1}</span>
                {item.label}
              </li>
            ))}
          </ol>
        )}

        {step === 'file' && (
          <>
            <TextField
              label="수행 결과 파일"
              type="file"
              accept={importFileAccept}
              onChange={(event) => void chooseFile(event.target.files?.[0])}
              hint="CSV와 XLSX 파일을 지원해요. TC 정의 파일은 테스트 설계의 TC 가져오기에서 올려요."
            />
            <ImportSheetSelect sheetNames={sheetNames} value={sheetName} onChange={chooseSheet} />
            {fileError && (
              <p className={styles.error} role="alert">
                {fileError}
              </p>
            )}
            {table && (
              <section className={styles.fileSummary} aria-labelledby="result-file-title">
                <h3 id="result-file-title" className={styles.subTitle}>
                  {fileName}
                </h3>
                <p className={styles.caption}>
                  {formatLabel} · 컬럼 {table.headers.length}개 · 데이터 행 {table.rows.length}개(빈 행 포함)
                </p>
                <p className={styles.columns}>
                  {table.headers.map((header, index) => (
                    <span key={index}>{header}</span>
                  ))}
                </p>
                {notes.map((note) => (
                  <p key={note} className={styles.caption}>
                    {note}
                  </p>
                ))}
              </section>
            )}
          </>
        )}

        {step === 'mapping' && table && (
          <>
            <p className={styles.caption}>
              파일 컬럼을 Looma 필드에 연결하세요. 이름이 명확한 컬럼만 미리 연결했어요. Android · iOS 열에 결과를 따로 적는 양식이면 각 열을 플랫폼별 수행 결과로 연결하세요.
            </p>
            <div className={styles.mappingGrid}>
              {table.headers.map((header, index) => (
                <SelectField
                  key={index}
                  label={header}
                  hint={sampleValue(table, index)}
                  value={mapping[index] ?? ''}
                  onChange={(event) =>
                    setMapping((current) => current.map((field, columnIndex) => (columnIndex === index ? ((event.target.value || null) as ResultImportField | null) : field)))
                  }
                >
                  <option value="">연결 안 함</option>
                  {resultImportFields.map((field) => (
                    <option key={field} value={field}>
                      {resultImportFieldLabel[field]}
                    </option>
                  ))}
                </SelectField>
              ))}
            </div>
            {mappingProblems.length > 0 && (
              <ul className={styles.problems} aria-live="polite">
                {mappingProblems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
          </>
        )}

        {step === 'cycle' && (
          <>
            <p className={styles.caption}>이 파일을 몇 번째 수행으로 저장할지 정해요. 같은 TC의 결과는 차수마다 따로 쌓여요.</p>
            <div className={styles.cycleGrid}>
              <TextField
                label="차수"
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={roundText}
                onChange={(event) => setRoundText(event.target.value)}
                hint={`기존 차수: ${imports.length > 0 ? imports.map((item) => `${item.round}차`).join(', ') : '없음'}`}
              />
              <SelectField label="수행 유형" value={cycle.executionType} onChange={(event) => setCycle((current) => ({ ...current, executionType: event.target.value as ExecutionType }))}>
                {executionTypeOrder.map((type) => (
                  <option key={type} value={type}>
                    {executionTypeLabel[type]}
                  </option>
                ))}
              </SelectField>
              <TextField label="수행 시작일" type="date" value={cycle.executedFrom} onChange={(event) => setCycle((current) => ({ ...current, executedFrom: event.target.value }))} />
              <TextField
                label="수행 종료일 (선택)"
                type="date"
                value={cycle.executedTo ?? ''}
                min={cycle.executedFrom}
                onChange={(event) => setCycle((current) => ({ ...current, executedTo: event.target.value || undefined }))}
              />
              {cyclePlatformAllowed && (
                <SelectField
                  label="플랫폼 (선택)"
                  value={cycle.platform ?? ''}
                  hint="파일에 플랫폼 정보가 없어 이 차수의 모든 결과에 붙여요."
                  onChange={(event) => setCycle((current) => ({ ...current, platform: (event.target.value || undefined) as Platform | undefined }))}
                >
                  <option value="">지정 안 함</option>
                  {platformOptions.map((platform) => (
                    <option key={platform} value={platform}>
                      {platformLabel[platform]}
                    </option>
                  ))}
                </SelectField>
              )}
              <TextField
                label="환경 (선택)"
                value={cycle.environment ?? ''}
                placeholder="예: STG · v2.3.0 빌드"
                onChange={(event) => setCycle((current) => ({ ...current, environment: event.target.value }))}
              />
            </div>
            <TextAreaField label="메모 (선택)" rows={2} value={cycle.note ?? ''} onChange={(event) => setCycle((current) => ({ ...current, note: event.target.value }))} />
            {cycleProblems.length > 0 && (
              <ul className={styles.problems} aria-live="polite">
                {cycleProblems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
          </>
        )}

        {step === 'preview' && analysis && counts && (
          <>
            <dl className={styles.counts} aria-label="판정별 행 수">
              {resultMatchOrder.map((kind) => (
                <div key={kind}>
                  <dt>{kind === 'invalid' ? '오류 행' : resultMatchLabel[kind]}</dt>
                  <dd>{counts[kind]}</dd>
                </div>
              ))}
              <div>
                <dt>결과 값 확인 필요</dt>
                <dd>{counts.unknownValues}</dd>
              </div>
            </dl>
            {analysis.blankRows > 0 && <p className={styles.caption}>빈 행 {analysis.blankRows}개는 건너뛰었어요.</p>}
            {analysis.fileProblems.length > 0 && (
              <ul className={styles.problems}>
                {analysis.fileProblems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
            {analysis.notices.length > 0 && (
              <ul className={styles.notices}>
                {analysis.notices.map((notice) => (
                  <li key={notice}>{notice}</li>
                ))}
              </ul>
            )}

            {analysis.unknownValues.length > 0 && (
              <fieldset className={styles.values}>
                <legend>결과 값 확인</legend>
                <p className={styles.caption}>고객사 Template과 기본 표기로 알 수 없는 값이에요. 추측하지 않으니 표준 결과를 고르거나 제외하세요.</p>
                <div className={styles.valueRows}>
                  {analysis.unknownValues.map((item) => {
                    const value = valueDecisions[item.key] ?? 'pending';
                    return (
                      <label key={item.key} className={styles.valueRow}>
                        <span className={styles.raw}>{rawText(item.raw)}</span>
                        <span className={styles.caption}>{item.count}건</span>
                        <select
                          className={`${styles.decision} ${value === 'pending' ? styles.decisionPending : ''}`}
                          value={value}
                          aria-label={`${rawText(item.raw)} 값의 표준 결과`}
                          onChange={(event) => setValueDecisions((current) => ({ ...current, [item.key]: event.target.value as ResultValueDecision }))}
                        >
                          <option value="pending">판단 필요</option>
                          {testResultOrder.map((result) => (
                            <option key={result} value={result}>
                              {testResultLabel[result]}
                            </option>
                          ))}
                          <option value="excluded">제외</option>
                        </select>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            )}

            <div className={styles.toolbar}>
              <FilterTabs
                label="판정"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'all', label: '전체', count: analysis.rows.length },
                  ...resultMatchOrder.filter((kind) => counts[kind] > 0).map((kind) => ({ value: kind, label: resultMatchLabel[kind], count: counts[kind] })),
                ]}
              />
              {unmatchedRows.length > 0 && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setRowDecisions((current) => ({ ...current, ...Object.fromEntries(unmatchedRows.map((item) => [item.row.rowNumber, 'import' as const])) }))}
                >
                  미연결 모두 보존
                </Button>
              )}
            </div>
            {(pendingRows > 0 || pendingValues > 0) && (
              <p className={styles.pendingNote}>
                판단이 필요한 {[pendingRows > 0 && `행 ${pendingRows}건`, pendingValues > 0 && `결과 값 ${pendingValues}종`].filter(Boolean).join(' · ')}이 남았어요.
              </p>
            )}

            <div className={styles.scroller} role="region" aria-label="수행 결과 미리보기 표" tabIndex={0}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">행</th>
                    <th scope="col">고객사 TC ID</th>
                    <th scope="col" className={styles.titleCol}>
                      테스트 항목
                    </th>
                    <th scope="col">결과</th>
                    <th scope="col">판정</th>
                    <th scope="col">처리</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((item) => (
                    <PreviewRow
                      key={item.row.rowNumber}
                      item={item}
                      target={item.testCaseId ? testCaseById.get(item.testCaseId) : undefined}
                      candidates={item.candidateIds.map((id) => testCaseById.get(id))}
                      decision={effectiveDecision(item, rowDecisions)}
                      valueDecisions={valueDecisions}
                      cyclePlatform={cycleInput.platform}
                      onDecide={(decision) => setRowDecisions((current) => ({ ...current, [item.row.rowNumber]: decision }))}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {step === 'confirm' && plan.summary && (
          <section className={styles.confirm} aria-labelledby="result-confirm-title">
            <h3 id="result-confirm-title" className={styles.subTitle}>
              {cycleInput.round}차 {executionTypeLabel[cycleInput.executionType]} 결과 {plan.summary.total}건을 저장해요.
            </h3>
            <dl className={styles.confirmList}>
              <div>
                <dt>파일</dt>
                <dd>{fileName}</dd>
              </div>
              <div>
                <dt>수행일</dt>
                <dd>{cycleInput.executedTo && cycleInput.executedTo !== cycleInput.executedFrom ? `${cycleInput.executedFrom} ~ ${cycleInput.executedTo}` : cycleInput.executedFrom}</dd>
              </div>
              <div>
                <dt>결과</dt>
                <dd>{resultImportSummaryText(plan.summary)}</dd>
              </div>
              <div>
                <dt>TC 연결</dt>
                <dd>
                  연결 {plan.summary.linked}건 · 미연결 {plan.summary.unlinked}건
                </dd>
              </div>
            </dl>
            <ul className={styles.notices}>
              <li>기준 TC는 만들거나 바꾸지 않아요. revision · 상태 · 요구사항 연결도 그대로예요.</li>
              <li>미연결 결과는 고객사 TC ID · 제목 · 결과 원문을 그대로 보존하고, 새 TC를 만들지 않아요.</li>
              <li>이전 차수의 결과는 그대로 두고 이 차수의 결과를 따로 쌓아요.</li>
            </ul>
            {applyError && (
              <p className={styles.error} role="alert">
                {applyError}
              </p>
            )}
          </section>
        )}

        {step === 'done' && saved && (
          <div className={styles.done} role="status">
            <p className={styles.doneTitle}>
              {saved.round}차 {executionTypeLabel[saved.executionType ?? 'full']} 결과를 저장했어요.
            </p>
            <p>수행 결과 탭에서 {saved.round}차를 선택하면 PASS · FAIL · BLOCKED · 미수행과 미연결 결과를 확인할 수 있어요.</p>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function sampleValue(table: ImportTable, index: number): string {
  const sample = table.rows.map((row) => row.cells[index]?.trim()).find(Boolean);
  if (!sample) return '예시 값 없음';
  const line = sample.split(/\r?\n/)[0];
  return `예: ${line.length > 40 ? `${line.slice(0, 40)}…` : line}`;
}

interface PreviewRowProps {
  item: AnalyzedResultRow;
  target?: TestCase;
  candidates: (TestCase | undefined)[];
  decision?: ResultRowDecision;
  valueDecisions: Record<string, ResultValueDecision>;
  cyclePlatform?: Platform;
  onDecide: (decision: ResultRowDecision) => void;
}

function PreviewRow({ item, target, candidates, decision, valueDecisions, cyclePlatform, onDecide }: PreviewRowProps) {
  const { row } = item;
  const options = resultDecisionOptionsFor(item);
  const linked = !!linkedTestCaseId(item);

  return (
    <tr>
      <td className={styles.rowNumber}>{row.rowNumber}</td>
      <td className={styles.id}>{row.externalId ?? <span className={styles.muted}>없음</span>}</td>
      <td className={styles.titleCol}>
        <p className={styles.rowTitle}>{row.title ?? <span className={styles.muted}>테스트 항목 없음</span>}</p>
        {target && linked && <p className={styles.meta}>연결 TC · {testCaseName(target)}</p>}
        {item.conflictReason && (
          <p className={styles.meta}>
            {resultConflictReasonLabel[item.conflictReason]}
            {item.conflictReason === 'ambiguous_external_id' && ` 후보 · ${candidates.map(testCaseName).join(', ')}`}
          </p>
        )}
        {row.note && <p className={styles.meta}>비고 · {row.note}</p>}
        {item.issues.length > 0 && (
          <ul className={styles.issues}>
            {item.issues.map((issue) => (
              <li key={issue.message} className={issue.level === 'error' ? styles.issueError : styles.issueWarning}>
                {issue.level === 'error' ? '오류' : '확인'} · {issue.message}
              </li>
            ))}
          </ul>
        )}
      </td>
      <td>
        <ul className={styles.entries}>
          {row.entries.map((entry) => {
            const chosen = entry.result ?? valueDecisions[resultValueKey(entry.rawResult)];
            const platform = entry.platform ?? cyclePlatform;
            return (
              <li key={entry.column}>
                {platform && <small>{platformLabel[platform]}</small>}
                <span className={styles.raw}>{rawText(entry.rawResult)}</span>
                <span aria-hidden>→</span>
                <span className="visually-hidden">표준 결과</span>
                {chosen && chosen !== 'pending' ? (
                  chosen === 'excluded' ? (
                    <span className={styles.muted}>제외</span>
                  ) : (
                    <ResultTag result={chosen} />
                  )
                ) : (
                  <span className={styles.pendingText}>확인 필요</span>
                )}
              </li>
            );
          })}
        </ul>
      </td>
      <td>
        <Tag tone={matchTone[item.kind]}>{resultMatchLabel[item.kind]}</Tag>
      </td>
      <td>
        {options.length > 0 ? (
          <select
            className={`${styles.decision} ${decision === 'pending' ? styles.decisionPending : ''}`}
            value={decision}
            aria-label={`${row.rowNumber}행 처리`}
            onChange={(event) => onDecide(event.target.value as ResultRowDecision)}
          >
            {decision === 'pending' && <option value="pending">판단 필요</option>}
            {options.map((option) => (
              <option key={option} value={option}>
                {option === 'excluded' ? '제외' : linked ? '가져오기' : '미연결로 보존'}
              </option>
            ))}
          </select>
        ) : (
          <span className={styles.muted}>가져올 수 없음</span>
        )}
      </td>
    </tr>
  );
}
