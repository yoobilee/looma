import { useState } from 'react';
import { FileDown } from 'lucide-react';
import { importSourceMimeType } from '@/domain/importSource';
import type { ImportSourceFormat } from '@/domain/types';
import { downloadFile } from '@/lib/downloadFile';
import { Button } from '@/components/ui/Button';
import { exportResultSource, exportTestAssetSource, type SourceExportOutcome } from './exportImportSource';
import styles from './SourceExportAction.module.css';

interface SourceExportActionProps {
  kind: 'asset' | 'result';
  projectId: string;
  recordId: string;
  /** 보관한 원본 파일의 형식. 원본이 없으면 undefined */
  sourceFormat?: ImportSourceFormat;
}

type State = { status: 'idle' } | { status: 'busy' } | { status: 'done'; message: string; notices: string[] } | { status: 'failed'; problems: string[] };

const MAX_PROBLEMS = 5;

/** 가져온 원본 XLSX 형식을 유지해 기존 행의 값만 반영한 파일을 내려받는다. */
export function SourceExportAction({ kind, projectId, recordId, sourceFormat }: SourceExportActionProps) {
  const [state, setState] = useState<State>({ status: 'idle' });

  if (sourceFormat !== 'xlsx') {
    return (
      <p className={styles.unavailable}>
        {sourceFormat === 'csv' ? 'CSV로 가져온 기록이라 원본 형식 XLSX 내보내기를 지원하지 않아요.' : '원본 파일을 보관하지 않은 가져오기라 원본 형식 XLSX 내보내기를 사용할 수 없어요.'}
      </p>
    );
  }

  const run = async () => {
    setState({ status: 'busy' });
    let outcome: SourceExportOutcome;
    try {
      outcome = kind === 'asset' ? await exportTestAssetSource(projectId, recordId) : await exportResultSource(projectId, recordId);
    } catch {
      setState({ status: 'failed', problems: ['내보내기 중 알 수 없는 오류가 났어요. 원본 파일은 바뀌지 않았어요.'] });
      return;
    }
    if (!outcome.ok) {
      setState({ status: 'failed', problems: outcome.problems });
      return;
    }
    downloadFile(outcome.bytes as Uint8Array<ArrayBuffer>, outcome.fileName, importSourceMimeType.xlsx);
    const changed = outcome.changedCells.length;
    setState({
      status: 'done',
      message: changed > 0 ? `${outcome.fileName} · 셀 ${changed}개에 현재 값을 반영했어요.` : `${outcome.fileName} · 바뀐 값이 없어 원본과 같은 파일이에요.`,
      notices: outcome.notices,
    });
  };

  return (
    <div className={styles.action}>
      <Button size="sm" variant="secondary" icon={<FileDown aria-hidden />} disabled={state.status === 'busy'} onClick={() => void run()}>
        {state.status === 'busy' ? '내보내는 중' : '원본 형식으로 XLSX 내보내기'}
      </Button>
      {state.status === 'done' && (
        <div className={styles.result} role="status">
          <p>{state.message}</p>
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
