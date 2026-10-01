/**
 * object URL을 해제하기까지 기다리는 시간. 일부 브라우저(Firefox · Safari)는 클릭 직후 해제하면 다운로드가 시작되지 않을 수 있어
 * 다운로드가 시작될 시간을 둔다(FileSaver.js는 40초를 쓴다). 파일 크기는 원본 상한(5MB) 이내라 그동안의 메모리는 작다.
 */
export const OBJECT_URL_REVOKE_DELAY_MS = 30_000;

/** 브라우저에서 파일을 내려받는다. 파일은 어디에도 보내지 않는다. 실패하면 object URL을 바로 해제하고 오류를 던진다. */
export function downloadFile(bytes: Uint8Array, fileName: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType }));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.append(link);
    try {
      link.click();
    } finally {
      link.remove();
    }
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_REVOKE_DELAY_MS);
}
