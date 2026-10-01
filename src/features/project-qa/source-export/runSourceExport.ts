import type { SourceExportOutcome } from './exportImportSource';

export type SourceExportState =
  | { status: 'idle' }
  | { status: 'busy' }
  | { status: 'done'; message: string; notices: string[] }
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
  return {
    status: 'done',
    message: changed > 0 ? `${outcome.fileName} · 셀 ${changed}개에 현재 값을 반영했어요.` : `${outcome.fileName} · 바뀐 값이 없어 원본과 같은 파일이에요.`,
    notices: outcome.notices,
  };
}
