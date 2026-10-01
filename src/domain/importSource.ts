import type { ImportTable } from './testAssetImport';
import type { ImportSourceFormat, ImportSourceSnapshot } from './types';

/*
 * 가져오기 원본의 layout snapshot. 파일 bytes와 별개로 직렬화할 수 있는 표 구조를 남긴다.
 * 이후 고객사 양식 기준 내보내기에서 헤더 · 열 순서 · 행 위치 · 매핑하지 않은 열 값을 알 때 쓴다.
 */

export const importSourceMimeType: Record<ImportSourceFormat, string> = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** 가져온 표를 그대로 옮긴다. 빈 행 · 매핑하지 않은 열도 남기고, 원본 표와 공유하지 않도록 복사한다. */
export function toImportSourceSnapshot(table: ImportTable, source: { format: ImportSourceFormat; fileName: string; sheetName?: string }): ImportSourceSnapshot {
  return {
    format: source.format,
    fileName: source.fileName,
    ...(source.sheetName && { sheetName: source.sheetName }),
    headers: [...table.headers],
    rows: table.rows.map((row) => ({ rowNumber: row.rowNumber, cells: [...row.cells] })),
  };
}
