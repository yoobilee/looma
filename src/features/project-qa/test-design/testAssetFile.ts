import { toImportTable, type ImportTable } from '@/domain/testAssetImport';
import { decodeText, parseCsv } from '@/lib/csv';

const MAX_FILE_BYTES = 5 * 1024 * 1024;

export type TestAssetFileResult = { ok: true; table: ImportTable } | { ok: false; message: string };

/**
 * 고객사 TC 파일을 형식과 무관한 표로 읽는다. 지금은 브라우저 표준 기능만으로 읽을 수 있는 CSV만 지원한다.
 * XLSX parser를 추가할 때도 여기서 ImportTable만 만들면 가져오기 도메인은 그대로 쓴다.
 */
export async function readTestAssetFile(file: File): Promise<TestAssetFileResult> {
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension === 'xlsx' || extension === 'xls') {
    return { ok: false, message: 'XLSX는 아직 읽을 수 없어요. Excel에서 "CSV UTF-8"로 저장한 파일을 올려 주세요.' };
  }
  if (extension !== 'csv') return { ok: false, message: 'CSV 파일만 가져올 수 있어요.' };
  if (file.size > MAX_FILE_BYTES) return { ok: false, message: '5MB 이하 파일만 가져올 수 있어요.' };

  const table = toImportTable(parseCsv(decodeText(await file.arrayBuffer())));
  if (!table) return { ok: false, message: '파일에 내용이 없어요.' };
  if (table.rows.length === 0) return { ok: false, message: '헤더 아래에 데이터 행이 없어요.' };
  return { ok: true, table };
}
