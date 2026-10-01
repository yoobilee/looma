import { useRef, useState } from 'react';
import type { ImportTable } from '@/domain/testAssetImport';
import type { ImportSourceFileInput } from '@/data/repositories/types';
import { readImportFile, type ImportFileSource, type ImportTableResult } from './importFile';

/**
 * 가져오기 대화상자의 "파일" 단계 상태. TC 가져오기와 수행 결과 가져오기가 함께 쓴다.
 * 파일이나 시트가 바뀌면 이전 표를 버리고 onTableChange로 알린다. 호출한 쪽은 그때 컬럼 매핑과 판단을 다시 만든다.
 */
export function useImportFile(onTableChange: (table: ImportTable | undefined) => void) {
  const [fileName, setFileName] = useState('');
  const [source, setSource] = useState<ImportFileSource>();
  const [sheetName, setSheetName] = useState('');
  const [table, setTable] = useState<ImportTable>();
  const [notes, setNotes] = useState<string[]>([]);
  const [fileError, setFileError] = useState('');
  // 파일을 빠르게 바꿔 고르면 늦게 끝난 이전 파일의 읽기 결과는 버린다.
  const latestRead = useRef(0);

  const clearTable = () => {
    setTable(undefined);
    setNotes([]);
    onTableChange(undefined);
  };

  const showTable = (result: ImportTableResult) => {
    if (!result.ok) {
      clearTable();
      setFileError(result.message);
      return;
    }
    setFileError('');
    setTable(result.table);
    setNotes(result.notes);
    onTableChange(result.table);
  };

  const chooseFile = async (file: File | undefined) => {
    const read = ++latestRead.current;
    clearTable();
    setSource(undefined);
    setSheetName('');
    setFileError('');
    setFileName(file?.name ?? '');
    if (!file) return;

    const result = await readImportFile(file);
    if (read !== latestRead.current) return;
    if (!result.ok) {
      setFileError(result.message);
      return;
    }
    setSource(result.source);
    // 시트가 하나이거나 CSV면 고를 것이 없으므로 바로 표로 읽는다.
    if (result.source.sheetNames.length <= 1) {
      const onlySheet = result.source.sheetNames[0] ?? '';
      setSheetName(onlySheet);
      showTable(result.source.readTable(onlySheet || undefined));
    }
  };

  const chooseSheet = (name: string) => {
    if (!source) return;
    setSheetName(name);
    setFileError('');
    if (!name) {
      clearTable();
      return;
    }
    showTable(source.readTable(name));
  };

  /** 원본 파일로 함께 저장할 값. 표를 읽은 파일 · 시트와 같다. */
  const sourceFile: ImportSourceFileInput | undefined =
    source && table ? { bytes: source.bytes, format: source.format, ...(source.format === 'xlsx' && sheetName && { sheetName }) } : undefined;

  /** 파일 요약 첫머리. 예: "CSV · 시트 1개", "XLSX · 시트 TC" */
  const formatLabel = source?.format === 'xlsx' ? `XLSX · 시트 ${sheetName}` : 'CSV · 시트 1개';

  return {
    fileName,
    table,
    notes,
    fileError,
    chooseFile,
    chooseSheet,
    sheetNames: source?.sheetNames ?? [],
    sheetName,
    formatLabel,
    sourceFile,
  };
}
