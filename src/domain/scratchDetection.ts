import type { ScratchType } from './types';

const URL_PATTERN = /^(https?:\/\/|www\.)\S+$/i;
const HOST_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/\S*)?$/i;
const LOG_LINE_PATTERN = /^(\[?\d{2}:\d{2}(:\d{2})?|\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}|(INFO|WARN|ERROR|DEBUG)\b)/;

/** 붙여넣은 텍스트의 종류를 추정한다. 사용자가 저장 전에 바꿀 수 있다. */
export function detectScratchType(raw: string): ScratchType {
  const text = raw.trim();
  if (!text) return 'text';
  if (!text.includes('\n') && (URL_PATTERN.test(text) || HOST_PATTERN.test(text))) return 'url';
  if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
    try {
      JSON.parse(text);
      return 'json';
    } catch {
      // JSON처럼 보이지만 파싱되지 않으면 일반 텍스트로 둔다.
    }
  }
  const lines = text.split('\n').filter((line) => line.trim());
  const logLines = lines.filter((line) => LOG_LINE_PATTERN.test(line.trim()));
  if (lines.length >= 2 && logLines.length / lines.length >= 0.5) return 'log';
  return 'text';
}

/** 목록에 보일 제목. 첫 줄을 짧게 자른다. */
export function deriveScratchTitle(content: string, type: ScratchType): string {
  if (type === 'image') return '붙여넣은 이미지';
  if (type === 'json') return 'JSON 조각';
  if (type === 'log') return '로그 일부';
  const firstLine = content.trim().split('\n')[0] ?? '';
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine;
}
