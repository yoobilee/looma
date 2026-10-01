import { toImportTable, type ImportTable } from '@/domain/testAssetImport';
import { decodeText, parseCsv } from '@/lib/csv';
import { ImportFileError, openXlsxWorkbook } from './xlsxSheet';

/*
 * 고객사 파일(TC 정의 · 수행 결과)을 형식과 무관한 ImportTable로 읽는다. 두 가져오기가 함께 쓴다.
 * 형식마다 다른 것은 파일을 읽는 단계뿐이고, 이후의 매핑 · 매칭 · 판단 · 반영은 가져오기 도메인이 그대로 맡는다.
 * 파일은 브라우저 메모리에서만 처리한다.
 */

const MAX_FILE_BYTES = 5 * 1024 * 1024;

export const importFileAccept = '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export type ImportTableResult = { ok: true; table: ImportTable; notes: string[] } | { ok: false; message: string };

/** 파일 하나. 시트가 둘 이상이면 호출한 쪽이 시트를 고른 뒤 readTable을 부른다. */
export interface ImportFileSource {
  format: 'csv' | 'xlsx';
  /** 고를 수 있는 시트 이름. CSV는 비어 있다. */
  sheetNames: string[];
  readTable(sheetName?: string): ImportTableResult;
}

export type ImportFileResult = { ok: true; source: ImportFileSource } | { ok: false; message: string };

const unsupportedExtensions = ['xls', 'xlsm', 'ods'];

/** 헤더 행과 데이터 행이 있는 표로 만든다. 파일이 비었거나 헤더만 있으면 이유를 돌려준다. */
function tableResult(records: string[][], emptyMessage: string, notes: string[] = []): ImportTableResult {
  const table = toImportTable(records);
  if (!table) return { ok: false, message: emptyMessage };
  if (table.rows.length === 0) return { ok: false, message: '헤더 아래에 데이터 행이 없어요.' };
  return { ok: true, table, notes };
}

export async function readImportFile(file: File): Promise<ImportFileResult> {
  const extension = file.name.includes('.') ? file.name.split('.').pop()?.toLowerCase() : undefined;
  if (extension !== 'csv' && extension !== 'xlsx') {
    const message =
      extension && unsupportedExtensions.includes(extension)
        ? `.${extension} 형식은 지원하지 않아요. Excel에서 XLSX 또는 CSV UTF-8로 저장한 파일을 올려 주세요.`
        : 'CSV와 XLSX 파일만 가져올 수 있어요.';
    return { ok: false, message };
  }
  if (file.size > MAX_FILE_BYTES) return { ok: false, message: '5MB 이하 파일만 가져올 수 있어요.' };

  try {
    const buffer = await file.arrayBuffer();

    if (extension === 'csv') {
      const records = parseCsv(decodeText(buffer));
      return { ok: true, source: { format: 'csv', sheetNames: [], readTable: () => tableResult(records, '파일에 내용이 없어요.') } };
    }

    const workbook = await openXlsxWorkbook(buffer);
    return {
      ok: true,
      source: {
        format: 'xlsx',
        sheetNames: workbook.sheetNames,
        readTable(sheetName) {
          if (!sheetName || !workbook.sheetNames.includes(sheetName)) return { ok: false, message: '가져올 시트를 선택해 주세요.' };
          try {
            const { records, uncachedFormulas } = workbook.readSheet(sheetName);
            const notes =
              uncachedFormulas > 0
                ? [`계산된 값이 저장되지 않은 수식 ${uncachedFormulas}칸은 빈 값으로 읽었어요. Excel에서 파일을 한 번 저장한 뒤 올리면 값이 채워져요.`]
                : [];
            return tableResult(records, '선택한 시트에 내용이 없어요.', notes);
          } catch (error) {
            return { ok: false, message: error instanceof ImportFileError ? error.message : '선택한 시트를 읽지 못했어요.' };
          }
        },
      },
    };
  } catch (error) {
    return { ok: false, message: error instanceof ImportFileError ? error.message : `${extension === 'csv' ? 'CSV' : 'XLSX'} 파일을 읽지 못했어요.` };
  }
}
