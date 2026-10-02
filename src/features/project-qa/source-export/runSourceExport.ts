import type { SourceExportSkip } from '@/domain/importSourceExport';
import type { SourceExportOutcome } from './exportImportSource';

/** 신규 TC를 새 행으로 붙이려 했을 때의 행 단위 결과 */
export interface SourceExportRowSummary {
  /** 값을 바꾼 기존 행 수 */
  updatedRows: number;
  /** 표 끝에 붙인 새 행 수 */
  appendedRows: number;
  /** 넣지 않은 TC와 이유 */
  skipped: SourceExportSkip[];
}

export type SourceExportState =
  | { status: 'idle' }
  | { status: 'busy' }
  | { status: 'done'; message: string; notices: string[]; rows?: SourceExportRowSummary }
  | { status: 'failed'; problems: string[] };

/**
 * 내보내기 버튼 한 번의 결과. 내보내기 · 다운로드 어디서 실패해도 던지지 않고 실패 상태를 돌려준다.
 * 그래서 화면이 "내보내는 중"에 멈추거나 처리되지 않은 오류가 남지 않는다.
 */
export async function runSourceExport(exporter: () => Promise<SourceExportOutcome>, download: (bytes: Uint8Array, fileName: string) => void): Promise<SourceExportState> {
  let outcome: SourceExportOutcome;
  try {
    outcome = await exporter();
  } catch {
    return { status: 'failed', problems: ['내보내기 중 알 수 없는 오류가 났어요. 원본 파일은 바뀌지 않았어요.'] };
  }
  if (!outcome.ok) return { status: 'failed', problems: outcome.problems };
  try {
    download(outcome.bytes, outcome.fileName);
  } catch {
    return { status: 'failed', problems: ['파일을 내려받지 못했어요. 브라우저의 다운로드 설정을 확인한 뒤 다시 시도해 주세요. 원본 파일은 바뀌지 않았어요.'] };
  }
  const changed = outcome.changedCells.length;
  const appended = outcome.appendedRows.length;
  const message =
    changed > 0 || appended > 0
      ? `${outcome.fileName} · ${[changed > 0 && `셀 ${changed}개에 현재 값을 반영`, appended > 0 && `신규 TC ${appended}건을 새 행으로 추가`].filter(Boolean).join(' · ')}했어요.`
      : `${outcome.fileName} · 바뀐 값이 없어 원본과 같은 파일이에요.`;
  // 신규 TC를 붙였거나 붙이지 못한 TC가 있을 때만 행 단위 결과를 따로 보여 준다.
  const rows: SourceExportRowSummary | undefined =
    appended > 0 || outcome.skipped.length > 0
      ? { updatedRows: new Set(outcome.changedCells.map((ref) => ref.replace(/^[A-Z]+/, ''))).size, appendedRows: appended, skipped: outcome.skipped }
      : undefined;
  return { status: 'done', message, notices: outcome.notices, ...(rows && { rows }) };
}
