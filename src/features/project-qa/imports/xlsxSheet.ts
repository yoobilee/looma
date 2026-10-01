import type { CellObject, WorkBook, WorkSheet } from 'xlsx';

/*
 * XLSX 워크북 → 시트 → 행 · 셀 문자열. 이 파일은 파일 형식만 안다. 열 매핑 · TC · 결과의 의미는 가져오기 도메인이 맡는다.
 * 셀 값은 "Excel에서 사용자가 보는 값"을 문자열로 넘긴다. 날짜 · 수식의 의미는 해석하지 않는다.
 */

type SheetJs = typeof import('xlsx');

/** 사용자에게 그대로 보여 줄 수 있는 파일 오류 */
export class ImportFileError extends Error {}

const pad = (value: number, length = 2) => String(value).padStart(length, '0');

/**
 * SheetJS는 cellDates를 켜면 날짜 셀을 "UTC getter로 읽으면 Excel에 적힌 그대로의 날짜와 시각"이 되는 Date로 준다.
 * 시간대에 따라 하루가 밀리지 않도록 UTC getter만 쓴다.
 */
function dateText(cell: CellObject, date: Date): string {
  if (Number.isNaN(date.getTime())) return cell.w ?? '';
  const year = date.getUTCFullYear();
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
  // 시각만 있는 셀은 Excel 기준일 이전(1899년)으로 들어온다. 날짜를 지어내지 않고 보이는 값을 쓴다.
  if (year < 1900) return cell.w ?? time;
  const day = `${pad(year, 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  const seconds = date.getUTCSeconds();
  if (date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && seconds === 0) return day;
  return `${day} ${time}${seconds ? `:${pad(seconds)}` : ''}`;
}

/** 셀 하나를 문자열로 바꾼다. 계산된 값이 없는 수식 셀은 uncachedFormula로 알린다. */
export function cellText(cell: CellObject | undefined): { text: string; uncachedFormula: boolean } {
  if (!cell || cell.t === 'z') return { text: '', uncachedFormula: false };
  // 수식은 계산하지 않는다. 파일에 저장된 계산 결과가 없으면 비워 두고 호출한 쪽이 알린다.
  if (cell.f !== undefined && cell.v === undefined) return { text: '', uncachedFormula: true };
  switch (cell.t) {
    case 'b':
      return { text: cell.v ? 'TRUE' : 'FALSE', uncachedFormula: false };
    case 'd':
      return { text: cell.v instanceof Date ? dateText(cell, cell.v) : (cell.w ?? ''), uncachedFormula: false };
    case 'n':
      return { text: cell.w ?? String(cell.v ?? ''), uncachedFormula: false };
    case 'e':
      return { text: cell.w ?? '', uncachedFormula: false };
    default:
      return { text: String(cell.v ?? ''), uncachedFormula: false };
  }
}

export interface SheetRecords {
  /** 워크시트 행 번호 순서의 행 배열. records[0]이 1행이라 ImportTable의 rowNumber가 Excel의 행 번호와 같다. */
  records: string[][];
  uncachedFormulas: number;
}

/**
 * 워크시트의 값이 있는 셀만 모아 행 배열로 만든다.
 * - 행 번호는 보존한다(위쪽 빈 행도 센다). 값이 있는 첫 열보다 왼쪽의 빈 열은 뺀다.
 * - 병합 셀은 SheetJS가 준 값만 쓴다. 병합 영역에 첫 값을 복제하지 않는다.
 * - 값이 없는 서식 전용 셀 때문에 범위가 부풀어 오르지 않도록 시트의 !ref가 아니라 실제 셀로 범위를 정한다.
 */
export function worksheetToRecords(sheetJs: SheetJs, sheet: WorkSheet): SheetRecords {
  const cells: { row: number; column: number; text: string }[] = [];
  let uncachedFormulas = 0;
  for (const address in sheet) {
    if (address.startsWith('!')) continue;
    const { r: row, c: column } = sheetJs.utils.decode_cell(address);
    const { text, uncachedFormula } = cellText(sheet[address] as CellObject);
    if (uncachedFormula) uncachedFormulas += 1;
    if (text !== '') cells.push({ row, column, text });
  }
  if (cells.length === 0) return { records: [], uncachedFormulas };

  let firstColumn = Infinity;
  let lastColumn = 0;
  let lastRow = 0;
  for (const { row, column } of cells) {
    firstColumn = Math.min(firstColumn, column);
    lastColumn = Math.max(lastColumn, column);
    lastRow = Math.max(lastRow, row);
  }
  const records = Array.from({ length: lastRow + 1 }, () => Array<string>(lastColumn - firstColumn + 1).fill(''));
  for (const { row, column, text } of cells) records[row][column - firstColumn] = text;
  return { records, uncachedFormulas };
}

const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];

/** XLSX는 ZIP 묶음이다. SheetJS는 형식을 추측해 읽으므로 CSV나 XLS를 .xlsx로 바꾼 파일을 먼저 걸러낸다. */
export const isZipArchive = (bytes: Uint8Array) => ZIP_SIGNATURE.every((byte, index) => bytes[index] === byte);

export interface XlsxWorkbook {
  /** 보이는 시트 이름. 워크북에 적힌 순서를 유지한다. */
  sheetNames: string[];
  readSheet(sheetName: string): SheetRecords;
}

/**
 * XLSX 파일을 브라우저 안에서만 읽는다. 파일 내용은 어디에도 보내지 않는다.
 * 라이브러리가 커서 XLSX를 실제로 열 때만 불러온다.
 */
export async function openXlsxWorkbook(buffer: ArrayBuffer): Promise<XlsxWorkbook> {
  const bytes = new Uint8Array(buffer);
  const unreadable = new ImportFileError('XLSX 파일을 읽지 못했어요. 암호가 걸려 있거나 손상된 파일일 수 있어요.');
  if (!isZipArchive(bytes)) throw unreadable;

  const sheetJs = await import('xlsx');
  let workbook: WorkBook;
  try {
    workbook = sheetJs.read(bytes, { type: 'array', cellDates: true });
  } catch {
    throw unreadable;
  }

  // 숨김(hidden)과 매우 숨김(very hidden) 시트는 고르는 목록에서 뺀다.
  const sheetNames = workbook.SheetNames.filter((_, index) => (workbook.Workbook?.Sheets?.[index]?.Hidden ?? 0) === 0);
  if (sheetNames.length === 0) throw new ImportFileError('사용할 수 있는 시트가 없어요. 숨겨진 시트만 있거나 시트가 비어 있어요.');

  return {
    sheetNames,
    readSheet(sheetName) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) throw new ImportFileError('선택한 시트를 읽지 못했어요.');
      return worksheetToRecords(sheetJs, sheet);
    },
  };
}
