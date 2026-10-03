/** CSV 한 레코드. line은 원본에서 이 레코드가 시작하는 물리적 줄 번호(1부터)다. 따옴표 안 줄바꿈이 있는 레코드는 여러 줄에 걸친다. */
export interface CsvRecord {
  cells: string[];
  line: number;
}

/**
 * RFC 4180 CSV를 행 · 셀 배열로 읽는다.
 * 따옴표 안의 쉼표 · 줄바꿈과 이중 따옴표("") 이스케이프를 지원하고, 줄 끝은 CRLF · LF 모두 받는다.
 * 셀 값은 가공하지 않는다. 공백 정리와 의미 해석은 읽는 쪽이 맡는다.
 */
export function parseCsv(text: string): string[][] {
  return parseCsvRecords(text).map((record) => record.cells);
}

/**
 * parseCsv와 같게 읽되 레코드마다 원본의 시작 줄 번호를 함께 돌려준다.
 * 줄 번호는 사람이 원본 파일에서 찾는 줄이다: LF · CRLF · 홑 CR은 각각 한 줄이고(CRLF를 둘로 세지 않는다),
 * 따옴표 안의 줄바꿈도 센다. BOM은 줄 번호에 영향이 없고 빈 줄은 빈 레코드로 남아 자기 줄 번호를 가진다.
 */
export function parseCsvRecords(text: string): CsvRecord[] {
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  const rows: CsvRecord[] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let startLine = 1;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    // 줄이 끝나는 문자. CR은 항상 한 줄이고, LF는 바로 앞이 CR이 아닐 때만 센다(CRLF는 한 줄). 따옴표 안팎 모두 같다.
    if (char === '\r' || (char === '\n' && source[index - 1] !== '\r')) line += 1;
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
      rows.push({ cells: row, line: startLine });
      row = [];
      cell = '';
      startLine = line;
    } else cell += char;
  }

  // 마지막 줄바꿈 뒤에는 빈 행을 만들지 않는다.
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push({ cells: row, line: startLine });
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
