import { useId, useState } from 'react';
import { FileDown } from 'lucide-react';
import { importSourceMimeType } from '@/domain/importSource';
import type { ImportSourceFormat } from '@/domain/types';
import { downloadFile } from '@/lib/downloadFile';
import { Button } from '@/components/ui/Button';
import { exportResultSource, exportTestAssetSource } from './exportImportSource';
import { runSourceExport, type SourceExportState } from './runSourceExport';
import styles from './SourceExportAction.module.css';

interface SourceExportActionProps {
  kind: 'asset' | 'result';
  projectId: string;
  recordId: string;
  /** 보관한 원본 파일의 형식. 원본이 없으면 undefined */
  sourceFormat?: ImportSourceFormat;
  /** 가져온 원본 파일 이름. 신규 TC를 붙일 대상 파일로 보여 준다. */
  sourceFileName?: string;
}

const MAX_PROBLEMS = 5;

/** 가져온 원본 XLSX 형식을 유지해 기존 행의 값을 반영한(선택하면 신규 TC를 새 행으로 붙인) 파일을 내려받는다. */
export function SourceExportAction({ kind, projectId, recordId, sourceFormat, sourceFileName }: SourceExportActionProps) {
  const [state, setState] = useState<SourceExportState>({ status: 'idle' });
  const [appendNewTestCases, setAppendNewTestCases] = useState(false);
  const optionId = useId();

  if (sourceFormat !== 'xlsx') {
    return (
      <p className={styles.unavailable}>
        {sourceFormat === 'csv' ? 'CSV로 가져온 기록이라 원본 형식 XLSX 내보내기를 지원하지 않아요.' : '원본 파일을 보관하지 않은 가져오기라 원본 형식 XLSX 내보내기를 사용할 수 없어요.'}
      </p>
    );
  }

  const run = async () => {
    setState({ status: 'busy' });
    setState(
      await runSourceExport(
        () => (kind === 'asset' ? exportTestAssetSource(projectId, recordId, { appendNewTestCases }) : exportResultSource(projectId, recordId)),
        (bytes, fileName) => downloadFile(bytes, fileName, importSourceMimeType.xlsx),
      ),
    );
  };

  return (
    <div className={styles.action}>
      {kind === 'asset' && (
        <div className={styles.option}>
          <input
            id={optionId}
            type="checkbox"
            checked={appendNewTestCases}
            disabled={state.status === 'busy'}
            aria-describedby={`${optionId}-hint`}
            onChange={(event) => setAppendNewTestCases(event.target.checked)}
          />
          <label htmlFor={optionId}>Looma에서 만든 신규 TC도 이 파일에 새 행으로 추가</label>
          <p id={`${optionId}-hint`} className={styles.notice}>
            {sourceFileName ? `대상: ${sourceFileName}의 표 끝. ` : '대상: 이 가져오기 원본 파일의 표 끝. '}
            다른 가져오기 파일에는 추가하지 않아요. 검토 완료 · 사용 중인 TC만 추가하고, 고객사 TC ID가 없으면 ID 칸을 비워 둬요.
          </p>
        </div>
      )}
      <Button size="sm" variant="secondary" icon={<FileDown aria-hidden />} disabled={state.status === 'busy'} onClick={() => void run()}>
        {state.status === 'busy' ? '내보내는 중' : '원본 형식으로 XLSX 내보내기'}
      </Button>
      {state.status === 'done' && (
        <div className={styles.result} role="status">
          <p>{state.message}</p>
          {state.rows && (
            <dl className={styles.counts}>
              <div>
                <dt>기존 행 수정</dt>
                <dd>{state.rows.updatedRows}행</dd>
              </div>
              <div>
                <dt>신규 행 추가</dt>
                <dd>{state.rows.appendedRows}행</dd>
              </div>
              <div className={state.rows.skipped.length > 0 ? styles.countWarning : undefined}>
                <dt>내보내기 불가 TC</dt>
                <dd>{state.rows.skipped.length}건</dd>
              </div>
            </dl>
          )}
          {state.rows && state.rows.skipped.length > 0 && (
            <details className={styles.skipped}>
              <summary>추가하지 않은 TC와 이유 보기</summary>
              <ul>
                {state.rows.skipped.map((item) => (
                  <li key={item.entityId}>
                    <span className={styles.skippedLabel}>{item.label}</span> {item.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {state.notices.map((notice) => (
            <p key={notice} className={styles.notice}>
              {notice}
            </p>
          ))}
        </div>
      )}
      {state.status === 'failed' && (
        <div className={styles.failed} role="alert">
          <p>내보내지 않았어요. 아래 문제를 해결해야 해요.</p>
          <ul>
            {state.problems.slice(0, MAX_PROBLEMS).map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
            {state.problems.length > MAX_PROBLEMS && <li>외 {state.problems.length - MAX_PROBLEMS}건</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
