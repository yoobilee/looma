/** 브라우저에서 파일을 내려받는다. 만든 object URL은 바로 해제한다. 파일은 어디에도 보내지 않는다. */
export function downloadFile(bytes: Uint8Array<ArrayBuffer>, fileName: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    // 클릭이 다운로드를 시작한 뒤 해제한다.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
