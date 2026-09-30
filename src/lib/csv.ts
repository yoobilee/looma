/**
 * RFC 4180 CSV를 행 · 셀 배열로 읽는다.
 * 따옴표 안의 쉼표 · 줄바꿈과 이중 따옴표("") 이스케이프를 지원하고, 줄 끝은 CRLF · LF 모두 받는다.
 * 셀 값은 가공하지 않는다. 공백 정리와 의미 해석은 읽는 쪽이 맡는다.
 */
export function parseCsv(text: string): string[][] {
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell === '') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }

  // 마지막 줄바꿈 뒤에는 빈 행을 만들지 않는다.
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/**
 * 파일 내용을 문자열로 바꾼다. UTF-8로 읽을 수 없으면
 * 한국어 Excel이 CSV를 저장할 때 기본으로 쓰는 EUC-KR(CP949)로 읽는다.
 */
export function decodeText(buffer: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('euc-kr').decode(buffer);
  }
}
