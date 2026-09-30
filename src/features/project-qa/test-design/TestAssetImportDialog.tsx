import { useMemo, useState } from 'react';
import { repositories } from '@/data';
import {
  analyzeTestAssetImport,
  columnMappingNotices,
  columnMappingProblems,
  decisionOptionsFor,
  defaultDecisionFor,
  planTestAssetImport,
  suggestColumnMapping,
  summarizeTestAssetImport,
  testAssetImportFields,
  type AnalyzedImportRow,
  type ColumnMapping,
  type ImportTable,
  type TestAssetContent,
  type TestAssetContentField,
  type TestAssetImportDecision,
  type TestAssetImportField,
  type TestAssetImportRowDecision,
  type TestAssetMatchKind,
} from '@/domain/testAssetImport';
import {
  testAssetConflictReasonLabel,
  testAssetContentFieldLabel,
  testAssetImportDecisionLabel,
  testAssetImportFieldLabel,
  testAssetMatchLabel,
  testAssetMatchOrder,
  testPerspectiveLabel,
} from '@/domain/labels';
import type { TestAssetImportSession, TestCase } from '@/domain/types';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { SelectField, TextField } from '@/components/ui/Field';
import { FilterTabs } from '@/components/ui/FilterTabs';
import { Tag, type TagTone } from '@/components/ui/Tag';
import { readTestAssetFile } from './testAssetFile';
import styles from './TestAssetImportDialog.module.css';

type Step = 'file' | 'mapping' | 'preview' | 'confirm' | 'done';
type RowFilter = 'all' | TestAssetMatchKind;

const steps: { step: Step; label: string }[] = [
  { step: 'file', label: '파일' },
  { step: 'mapping', label: '컬럼 매핑' },
  { step: 'preview', label: '미리보기' },
  { step: 'confirm', label: '반영 확인' },
];

const matchTone: Record<TestAssetMatchKind, TagTone> = {
  new: 'sky',
  exact_match: 'neutral',
  changed: 'outline',
  conflict: 'blocked',
  invalid: 'coral',
};

function formatContent(field: TestAssetContentField, content: Partial<TestAssetContent>): string {
  if (field === 'category') return content.category ? testPerspectiveLabel[content.category] : '없음';
  if (field === 'depth') return content.depth?.join(' › ') || '없음';
  if (field === 'steps') return content.steps?.map((step, index) => `${index + 1}. ${step}`).join(' ') || '없음';
  return content[field] || '없음';
}

const testCaseName = (testCase: TestCase | undefined) => (testCase ? `${testCase.externalId ?? '미지정'} · ${testCase.title}` : '찾을 수 없는 TC');

/** 판정에서 고를 수 없는 판단이 남아 있으면(미리보기 중 기존 TC가 바뀐 경우) 기본 판단으로 돌아간다. */
function effectiveDecision(item: AnalyzedImportRow, decisions: Record<number, TestAssetImportDecision>): TestAssetImportDecision | undefined {
  const chosen = decisions[item.row.rowNumber];
  return chosen && decisionOptionsFor(item).includes(chosen) ? chosen : defaultDecisionFor(item);
}

interface TestAssetImportDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  /** 이 프로젝트의 현재 TC. 미리보기 판정의 기준이다. */
  testCases: TestCase[];
}

/**
 * 고객사가 쓰던 TC 파일을 기준 TC로 가져온다. 파일 → 컬럼 매핑 → 미리보기 · 판단 → 반영 확인 순서이며,
 * 마지막 확인 전까지는 아무것도 저장하지 않는다. 수행 결과 업로드와는 별개다.
 */
export function TestAssetImportDialog({ open, onClose, projectId, testCases }: TestAssetImportDialogProps) {
  const [step, setStep] = useState<Step>('file');
  const [fileName, setFileName] = useState('');
  const [table, setTable] = useState<ImportTable>();
  const [fileError, setFileError] = useState('');
  const [mapping, setMapping] = useState<ColumnMapping>([]);
  const [decisions, setDecisions] = useState<Record<number, TestAssetImportDecision>>({});
  const [filter, setFilter] = useState<RowFilter>('all');
  const [busy, setBusy] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [session, setSession] = useState<TestAssetImportSession>();

  const inPreview = step === 'preview' || step === 'confirm';
  const analysis = useMemo(
    () => (table && inPreview ? analyzeTestAssetImport(table, mapping, testCases) : undefined),
    [table, mapping, testCases, inPreview],
  );
  const testCaseById = useMemo(() => new Map(testCases.map((testCase) => [testCase.id, testCase])), [testCases]);

  const rowDecisions: TestAssetImportRowDecision[] = (analysis?.rows ?? []).flatMap((item) => {
    const decision = effectiveDecision(item, decisions);
    return decision ? [{ rowNumber: item.row.rowNumber, kind: item.kind, targetId: item.targetId, decision }] : [];
  });

  // 저장소와 같은 계획 함수로 반영 결과를 미리 계산한다. 막히는 이유가 있으면 첫 번째 이유를 보여준다.
  let plan: { summary?: TestAssetImportSession; problem?: string } = {};
  if (analysis) {
    try {
      plan = { summary: planTestAssetImport(analysis, rowDecisions, testCases, { projectId, fileName, now: '', createId: (prefix) => `${prefix}-preview` }).session };
    } catch (error) {
      plan = { problem: error instanceof Error ? error.message.replace('TC를 가져올 수 없어요. ', '') : '가져올 수 없어요.' };
    }
  }

  const chooseFile = async (file: File | undefined) => {
    setTable(undefined);
    setFileError('');
    setFileName(file?.name ?? '');
    if (!file) return;
    const result = await readTestAssetFile(file);
    if (!result.ok) {
      setFileError(result.message);
      return;
    }
    setTable(result.table);
    setMapping(suggestColumnMapping(result.table.headers));
  };

  const goToPreview = () => {
    setDecisions({});
    setFilter('all');
    setStep('preview');
  };

  const apply = async () => {
    if (!table) return;
    setBusy(true);
    setApplyError('');
    try {
      setSession(await repositories.testAssetImports.apply({ projectId, fileName, table, mapping, decisions: rowDecisions }));
      setStep('done');
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : 'TC를 가져오지 못했어요.');
    } finally {
      setBusy(false);
    }
  };

  const mappingProblems = table ? columnMappingProblems(table.headers, mapping) : [];
  const counts = analysis ? summarizeTestAssetImport(analysis) : undefined;
  const visibleRows = (analysis?.rows ?? []).filter((item) => filter === 'all' || item.kind === filter);
  const pendingCount = rowDecisions.filter((item) => item.decision === 'pending').length;
  const changedRows = (analysis?.rows ?? []).filter((item) => item.kind === 'changed');

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
        <Button variant="primary" disabled={mappingProblems.length > 0} onClick={goToPreview}>
          다음: 미리보기
        </Button>
      </>
    ),
    preview: (
      <>
        <p className={plan.summary ? styles.readyNote : styles.pendingNote} aria-live="polite">
          {plan.summary ? `신규 ${plan.summary.created} · 업데이트 ${plan.summary.updated} 반영 예정` : plan.problem}
        </p>
        <Button variant="ghost" onClick={() => setStep('mapping')}>
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
          가져오기 반영
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
      width="lg"
      title="TC 가져오기"
      description="고객사가 쓰던 TC 파일을 이 프로젝트의 기준 TC로 가져와요. 반영 확인 전까지는 아무것도 바뀌지 않아요."
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
              label="기존 TC 파일"
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => void chooseFile(event.target.files?.[0])}
              hint='CSV만 지원해요. XLSX는 Excel에서 "CSV UTF-8"로 저장해 올려 주세요. 수행 결과 파일은 수행 결과 탭에서 올려요.'
            />
            {fileError && (
              <p className={styles.error} role="alert">
                {fileError}
              </p>
            )}
            {table && (
              <section className={styles.fileSummary} aria-labelledby="import-file-title">
                <h3 id="import-file-title" className={styles.subTitle}>
                  {fileName}
                </h3>
                <p className={styles.caption}>
                  CSV · 시트 1개 · 컬럼 {table.headers.length}개 · 데이터 행 {table.rows.length}개(빈 행 포함)
                </p>
                <p className={styles.columns}>
                  {table.headers.map((header, index) => (
                    <span key={index}>{header}</span>
                  ))}
                </p>
              </section>
            )}
          </>
        )}

        {step === 'mapping' && table && (
          <>
            <p className={styles.caption}>파일 컬럼을 Looma 필드에 연결하세요. 이름이 명확한 컬럼만 미리 연결했어요. 필요 없는 컬럼은 연결하지 않아도 돼요.</p>
            <div className={styles.mappingGrid}>
              {table.headers.map((header, index) => (
                <SelectField
                  key={index}
                  label={header}
                  hint={sampleValue(table, index)}
                  value={mapping[index] ?? ''}
                  onChange={(event) =>
                    setMapping((current) => current.map((field, columnIndex) => (columnIndex === index ? ((event.target.value || null) as TestAssetImportField | null) : field)))
                  }
                >
                  <option value="">연결 안 함</option>
                  {testAssetImportFields.map((field) => (
                    <option key={field} value={field}>
                      {testAssetImportFieldLabel[field]}
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
            {mappingProblems.length === 0 && <NoticeList notices={columnMappingNotices(mapping)} />}
          </>
        )}

        {step === 'preview' && analysis && counts && (
          <>
            <dl className={styles.counts} aria-label="판정별 행 수">
              {testAssetMatchOrder.map((kind) => (
                <div key={kind}>
                  <dt>{kind === 'invalid' ? '오류 행' : testAssetMatchLabel[kind]}</dt>
                  <dd>{counts[kind]}</dd>
                </div>
              ))}
            </dl>
            {analysis.blankRows > 0 && <p className={styles.caption}>빈 행 {analysis.blankRows}개는 건너뛰었어요.</p>}
            {analysis.fileProblems.length > 0 && (
              <ul className={styles.problems}>
                {analysis.fileProblems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
            <NoticeList notices={analysis.notices} />

            <div className={styles.toolbar}>
              <FilterTabs
                label="판정"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'all', label: '전체', count: analysis.rows.length },
                  ...testAssetMatchOrder.filter((kind) => counts[kind] > 0).map((kind) => ({ value: kind, label: testAssetMatchLabel[kind], count: counts[kind] })),
                ]}
              />
              {changedRows.length > 0 && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setDecisions((current) => ({ ...current, ...Object.fromEntries(changedRows.map((item) => [item.row.rowNumber, 'update' as const])) }))}
                >
                  변경 후보 모두 업데이트
                </Button>
              )}
            </div>
            {pendingCount > 0 && <p className={styles.pendingNote}>판단이 필요한 행이 {pendingCount}건 남았어요.</p>}

            <div className={styles.scroller} role="region" aria-label="가져오기 미리보기 표" tabIndex={0}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">행</th>
                    <th scope="col">고객사 TC ID</th>
                    <th scope="col" className={styles.titleCol}>
                      테스트 항목
                    </th>
                    <th scope="col">판정</th>
                    <th scope="col">처리</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((item) => (
                    <PreviewRow
                      key={item.row.rowNumber}
                      item={item}
                      target={item.targetId ? testCaseById.get(item.targetId) : undefined}
                      candidates={item.candidateIds.map((id) => testCaseById.get(id))}
                      decision={effectiveDecision(item, decisions)}
                      onDecide={(decision) => setDecisions((current) => ({ ...current, [item.row.rowNumber]: decision }))}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {step === 'confirm' && plan.summary && (
          <section className={styles.confirm} aria-labelledby="import-confirm-title">
            <h3 id="import-confirm-title" className={styles.subTitle}>
              {fileName}에서 TC {plan.summary.created + plan.summary.updated}건을 반영해요.
            </h3>
            <dl className={styles.confirmList}>
              <div>
                <dt>새 TC</dt>
                <dd>{plan.summary.created}건 · 초안으로 추가</dd>
              </div>
              <div>
                <dt>기존 TC 업데이트</dt>
                <dd>{plan.summary.updated}건 · revision +1 · 재검토 필요</dd>
              </div>
              <div>
                <dt>변경 없음</dt>
                <dd>{plan.summary.unchanged}건</dd>
              </div>
              <div>
                <dt>제외</dt>
                <dd>{plan.summary.excluded}건</dd>
              </div>
            </dl>
            <ul className={styles.notices}>
              <li>파일에 없는 기존 TC는 삭제하거나 폐기하지 않아요.</li>
              <li>기존 TC의 내부 ID · 고객사 TC ID · 요구사항 · 테스트 조건 연결은 그대로 두고, 수행 결과 연결도 유지돼요.</li>
              <li>새 TC는 요구사항과 연결되지 않은 상태로 들어와요. 요구사항 화면에서 이어 주세요.</li>
            </ul>
            {applyError && (
              <p className={styles.error} role="alert">
                {applyError}
              </p>
            )}
          </section>
        )}

        {step === 'done' && session && (
          <div className={styles.done} role="status">
            <p className={styles.doneTitle}>TC {session.created + session.updated}건을 가져왔어요.</p>
            <p>
              신규 {session.created} · 업데이트 {session.updated} · 변경 없음 {session.unchanged} · 제외 {session.excluded}. 가져온 TC는 TC 초안 목록에서 검토 대기 · 재검토 필요 상태로 확인할 수 있어요.
            </p>
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

function NoticeList({ notices }: { notices: string[] }) {
  if (notices.length === 0) return null;
  return (
    <ul className={styles.notices}>
      {notices.map((notice) => (
        <li key={notice}>{notice}</li>
      ))}
    </ul>
  );
}

interface PreviewRowProps {
  item: AnalyzedImportRow;
  target?: TestCase;
  candidates: (TestCase | undefined)[];
  decision?: TestAssetImportDecision;
  onDecide: (decision: TestAssetImportDecision) => void;
}

function PreviewRow({ item, target, candidates, decision, onDecide }: PreviewRowProps) {
  const { row } = item;
  const options = decisionOptionsFor(item);
  const changedFields = Object.keys(item.changes ?? {}) as TestAssetContentField[];

  return (
    <tr>
      <td className={styles.rowNumber}>{row.rowNumber}</td>
      <td className={styles.id}>{row.externalId ?? <span className={styles.muted}>미지정</span>}</td>
      <td className={styles.titleCol}>
        <p className={styles.rowTitle}>{row.title ?? <span className={styles.muted}>테스트 항목 없음</span>}</p>
        {target && <p className={styles.meta}>기존 TC · {testCaseName(target)}</p>}
        {changedFields.length > 0 && target && (
          <dl className={styles.diff}>
            {changedFields.map((field) => (
              <div key={field}>
                <dt>{testAssetContentFieldLabel[field]}</dt>
                <dd>
                  <span className="visually-hidden">기존 값 </span>
                  <span className={styles.before}>{formatContent(field, target)}</span>
                  <span aria-hidden> → </span>
                  <span className="visually-hidden">새 값 </span>
                  <span className={styles.after}>{formatContent(field, item.changes!)}</span>
                </dd>
              </div>
            ))}
          </dl>
        )}
        {item.conflictReason && (
          <p className={styles.meta}>
            {testAssetConflictReasonLabel[item.conflictReason]} 후보 · {candidates.map(testCaseName).join(', ')}
          </p>
        )}
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
        <Tag tone={matchTone[item.kind]}>{testAssetMatchLabel[item.kind]}</Tag>
      </td>
      <td>
        {options.length > 0 ? (
          <select
            className={`${styles.decision} ${decision === 'pending' ? styles.decisionPending : ''}`}
            value={decision}
            aria-label={`${row.rowNumber}행 처리`}
            onChange={(event) => onDecide(event.target.value as TestAssetImportDecision)}
          >
            {decision === 'pending' && <option value="pending">{testAssetImportDecisionLabel.pending}</option>}
            {options.map((option) => (
              <option key={option} value={option}>
                {testAssetImportDecisionLabel[option]}
              </option>
            ))}
          </select>
        ) : (
          <span className={styles.muted}>{item.kind === 'exact_match' ? '변경 없음' : '가져올 수 없음'}</span>
        )}
      </td>
    </tr>
  );
}
