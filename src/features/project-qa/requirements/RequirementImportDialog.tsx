import { useMemo, useState } from 'react';
import { repositories } from '@/data';
import {
  analyzeRequirementImport,
  requirementColumnMappingProblems,
  requirementImportFields,
  requirementImportSummaryText,
  requirementLocatorFallback,
  suggestRequirementColumnMapping,
  summarizeRequirementImport,
  type AnalyzedRequirementRow,
  type RequirementColumnMapping,
  type RequirementImportField,
  type RequirementImportKind,
  type RequirementImportSummary,
} from '@/domain/requirementImport';
import { requirementImportFieldLabel, requirementImportKindLabel } from '@/domain/labels';
import type { ImportTable } from '@/domain/testAssetImport';
import type { Deliverable, Requirement } from '@/domain/types';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { SelectField, TextField } from '@/components/ui/Field';
import { Tag, type TagTone } from '@/components/ui/Tag';
import { importFileAccept } from '../imports/importFile';
import { ImportSheetSelect } from '../imports/ImportSheetSelect';
import { useImportFile } from '../imports/useImportFile';
import styles from './RequirementImportDialog.module.css';

type Step = 'file' | 'mapping' | 'preview' | 'done';

const steps: { step: Step; label: string }[] = [
  { step: 'file', label: '파일' },
  { step: 'mapping', label: '열 매핑' },
  { step: 'preview', label: '미리보기' },
];

const kindTone: Record<RequirementImportKind, TagTone> = { create: 'sky', duplicate: 'neutral', invalid: 'coral' };

interface RequirementImportDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  /** 새 요구사항의 근거가 될 이 프로젝트의 산출물 */
  deliverables: Deliverable[];
  /** 이 프로젝트의 현재 요구사항. 미리보기 판정의 기준이다. */
  requirements: Requirement[];
}

/**
 * 정리된 요구사항 표(CSV · XLSX)를 이 프로젝트의 요구사항으로 가져온다. 파일 → 열 매핑 → 미리보기 · 제외 순서이며,
 * "가져오기"를 누르기 전까지는 아무것도 저장하지 않는다. AI 분석이 아니고 기존 요구사항은 바꾸지 않는다.
 */
export function RequirementImportDialog({ open, onClose, projectId, deliverables, requirements }: RequirementImportDialogProps) {
  const [step, setStep] = useState<Step>('file');
  const [deliverableId, setDeliverableId] = useState('');
  const [mapping, setMapping] = useState<RequirementColumnMapping>([]);
  const [excludedRows, setExcludedRows] = useState<number[]>([]);
  // 파일이나 시트가 바뀌면 이전 파일의 열 매핑과 제외는 버리고 새 표 기준으로 다시 시작한다.
  const { fileName, table, notes, fileError, chooseFile, chooseSheet, sheetNames, sheetName, formatLabel } = useImportFile((nextTable) => {
    setMapping(nextTable ? suggestRequirementColumnMapping(nextTable.headers) : []);
    setExcludedRows([]);
  });
  const [busy, setBusy] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [result, setResult] = useState<RequirementImportSummary>();

  const analysis = useMemo(() => (table && step === 'preview' ? analyzeRequirementImport(table, mapping, requirements) : undefined), [table, mapping, requirements, step]);
  // 미리보기를 보는 동안 요구사항이 바뀌어 더는 신규가 아닌 행의 제외는 넘기지 않는다(저장소는 그런 제외를 거부한다).
  const effectiveExcluded = analysis ? excludedRows.filter((rowNumber) => analysis.rows.some((row) => row.kind === 'create' && row.candidate.rowNumber === rowNumber)) : excludedRows;
  const summary = analysis ? summarizeRequirementImport(analysis, effectiveExcluded) : undefined;
  const mappingProblems = table ? requirementColumnMappingProblems(table.headers, mapping) : [];

  const toggleExcluded = (rowNumber: number, excluded: boolean) =>
    setExcludedRows((current) => (excluded ? [...current.filter((row) => row !== rowNumber), rowNumber] : current.filter((row) => row !== rowNumber)));

  const apply = async () => {
    if (!table || !deliverableId) return;
    setBusy(true);
    setApplyError('');
    try {
      const imported = await repositories.requirements.importFromTable({ projectId, deliverableId, fileName, table, mapping, excludedRows: effectiveExcluded });
      setResult(imported.summary);
      setStep('done');
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : '요구사항을 가져오지 못했어요.');
    } finally {
      setBusy(false);
    }
  };

  const footer = {
    file: (
      <>
        <Button variant="ghost" onClick={onClose}>
          취소
        </Button>
        <Button variant="primary" disabled={!table || !deliverableId} onClick={() => setStep('mapping')}>
          다음: 열 매핑
        </Button>
      </>
    ),
    mapping: (
      <>
        <Button variant="ghost" onClick={() => setStep('file')}>
          이전
        </Button>
        <Button
          variant="primary"
          disabled={mappingProblems.length > 0}
          onClick={() => {
            setExcludedRows([]);
            setApplyError('');
            setStep('preview');
          }}
        >
          다음: 미리보기
        </Button>
      </>
    ),
    preview: (
      <>
        <p className={summary && summary.created > 0 ? styles.readyNote : styles.pendingNote} aria-live="polite">
          {summary && summary.created > 0 ? `새 요구사항 ${summary.created}건을 가져올 예정이에요.` : '가져올 수 있는 새 요구사항이 없어요.'}
        </p>
        <Button variant="ghost" disabled={busy} onClick={() => setStep('mapping')}>
          이전
        </Button>
        <Button variant="primary" disabled={!summary || summary.created === 0 || busy} onClick={() => void apply()}>
          가져오기
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
      title="요구사항 가져오기"
      description="이미 정리된 요구사항 표(CSV · XLSX)를 이 프로젝트의 요구사항으로 가져와요. 가져오기를 누르기 전까지는 아무것도 바뀌지 않아요."
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
              label="요구사항 파일"
              type="file"
              accept={importFileAccept}
              onChange={(event) => void chooseFile(event.target.files?.[0])}
              hint="CSV와 XLSX 파일을 지원해요. 기능과 요구사항이 한 행에 하나씩 정리된 표여야 해요."
            />
            <ImportSheetSelect sheetNames={sheetNames} value={sheetName} onChange={chooseSheet} />
            {fileError && (
              <p className={styles.error} role="alert">
                {fileError}
              </p>
            )}
            {table && (
              <section className={styles.fileSummary} aria-labelledby="requirement-import-file-title">
                <h3 id="requirement-import-file-title" className={styles.subTitle}>
                  {fileName}
                </h3>
                <p className={styles.caption}>
                  {formatLabel} · 열 {table.headers.length}개 · 데이터 행 {table.rows.length}개(빈 행 포함)
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
            <SelectField label="연결할 산출물" hint="가져온 요구사항의 근거가 될 산출물을 골라요. 근거 위치는 파일의 출처 열이나 행 번호로 남겨요." value={deliverableId} onChange={(event) => setDeliverableId(event.target.value)}>
              <option value="">산출물을 선택하세요</option>
              {deliverables.map((deliverable) => (
                <option key={deliverable.id} value={deliverable.id}>
                  {deliverable.version ? `${deliverable.title} (${deliverable.version})` : deliverable.title}
                </option>
              ))}
            </SelectField>
          </>
        )}

        {step === 'mapping' && table && (
          <>
            <p className={styles.caption}>파일 열을 Looma 필드에 연결하세요. 이름이 명확한 열만 미리 연결했어요. 기능과 요구사항은 꼭 연결해야 해요.</p>
            <div className={styles.mappingGrid}>
              {table.headers.map((header, index) => (
                <SelectField
                  key={index}
                  label={header}
                  hint={sampleValue(table, index)}
                  value={mapping[index] ?? ''}
                  onChange={(event) => setMapping((current) => current.map((field, columnIndex) => (columnIndex === index ? ((event.target.value || null) as RequirementImportField | null) : field)))}
                >
                  <option value="">연결 안 함</option>
                  {requirementImportFields.map((field) => (
                    <option key={field} value={field}>
                      {requirementImportFieldLabel[field]}
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
            {mappingProblems.length === 0 && (
              <ul className={styles.notices}>
                {!mapping.includes('locator') && <li>출처 위치를 연결하지 않아 근거 위치는 원본 행 번호(예: {requirementLocatorFallback(2)})로 남아요.</li>}
                {!mapping.includes('needsConfirmation') && <li>확인 필요를 연결하지 않아 모든 요구사항을 확인 필요가 아닌 것으로 가져와요.</li>}
                <li>확인 필요 열은 true · y · yes · 1 · 필요 · 확인 필요 / false · n · no · 0 · 불필요(빈 칸은 불필요)만 읽어요. 그 밖의 값은 오류 행이 돼요.</li>
              </ul>
            )}
          </>
        )}

        {step === 'preview' && analysis && summary && (
          <>
            <dl className={styles.counts} aria-label="판정별 행 수">
              <Count label="전체 행" value={summary.total} />
              <Count label="신규" value={summary.created} />
              <Count label="중복" value={summary.duplicate} />
              <Count label="오류" value={summary.invalid} />
              <Count label="제외" value={summary.excluded} />
            </dl>
            {analysis.blankRows > 0 && <p className={styles.caption}>빈 행 {analysis.blankRows}개는 건너뛰었어요.</p>}
            <ul className={styles.notices}>
              <li>새 요구사항은 산출물에 적힌 내용으로, 검토 전 상태로 가져와요. 기존 요구사항은 바꾸지 않아요.</li>
              <li>중복 · 오류 행은 가져오지 않아요. 가져오고 싶지 않은 신규 행은 제외를 체크하세요.</li>
              <li>원본 파일은 보관하지 않아요. 근거 위치와 행 번호로 파일을 다시 찾을 수 있어요.</li>
            </ul>
            {applyError && (
              <p className={styles.error} role="alert">
                {applyError}
              </p>
            )}
            <div className={styles.scroller} role="region" aria-label="요구사항 미리보기 표" tabIndex={0}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">행</th>
                    <th scope="col">기능</th>
                    <th scope="col" className={styles.titleCol}>
                      요구사항
                    </th>
                    <th scope="col">근거 위치</th>
                    <th scope="col">확인 필요</th>
                    <th scope="col">판정</th>
                    <th scope="col">제외</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.rows.map((item) => (
                    <PreviewRow key={item.candidate.rowNumber} item={item} excluded={effectiveExcluded.includes(item.candidate.rowNumber)} onExclude={(excluded) => toggleExcluded(item.candidate.rowNumber, excluded)} />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {step === 'done' && result && (
          <div className={styles.done} role="status">
            <p className={styles.doneTitle}>요구사항 {result.created}건을 가져왔어요.</p>
            <p>{requirementImportSummaryText(result)}. 가져온 요구사항은 요구사항 목록에서 근거 위치와 함께 확인할 수 있어요.</p>
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

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function PreviewRow({ item, excluded, onExclude }: { item: AnalyzedRequirementRow; excluded: boolean; onExclude: (excluded: boolean) => void }) {
  const { candidate, kind, reasons } = item;
  const confirmation = candidate.needsConfirmation === undefined ? `해석 불가 (${candidate.confirmationRaw ?? ''})` : candidate.needsConfirmation ? '필요' : '아님';
  return (
    <tr>
      <td className={styles.rowNumber}>{candidate.rowNumber}</td>
      <td className={styles.feature}>{candidate.feature ?? <span className={styles.muted}>기능 없음</span>}</td>
      <td className={styles.titleCol}>
        <p className={styles.rowTitle}>{candidate.text ?? <span className={styles.muted}>요구사항 없음</span>}</p>
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
      <td className={styles.locator}>{candidate.locator ?? <span className={styles.muted}>{requirementLocatorFallback(candidate.rowNumber)}</span>}</td>
      <td className={styles.confirmation}>{confirmation}</td>
      <td>
        <Tag tone={excluded && kind === 'create' ? 'outline' : kindTone[kind]}>{excluded && kind === 'create' ? '제외' : requirementImportKindLabel[kind]}</Tag>
      </td>
      <td>
        {kind === 'create' ? (
          <label className={styles.exclude}>
            <input type="checkbox" checked={excluded} aria-label={`${candidate.rowNumber}행 제외`} onChange={(event) => onExclude(event.target.checked)} />
            <span aria-hidden>제외</span>
          </label>
        ) : (
          <span className={styles.muted}>가져오지 않음</span>
        )}
      </td>
    </tr>
  );
}
