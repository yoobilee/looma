import { summarizeResultImport, type ResultImportSummary } from './testResultImport';
import type { ExecutionType, Platform, TestAssetImportSession, TestResult, TestResultImport } from './types';

/** 가져오기 이력 화면용 읽기 전용 모델. 저장된 가져오기 기록을 한 목록으로 합쳐 보여 주기만 한다. */
interface ImportHistoryBase {
  id: string;
  projectId: string;
  fileName: string;
  importedAt: string;
  /** 보관한 원본 파일. 원본을 보관하지 않은 이전 가져오기에는 없다. */
  artifactId?: string;
}

export interface AssetImportHistoryItem extends ImportHistoryBase {
  type: 'asset';
  totalRows: number;
  created: number;
  updated: number;
  unchanged: number;
  excluded: number;
}

export interface ResultImportHistoryItem extends ImportHistoryBase {
  type: 'result';
  round: number;
  /** 수행 유형이 없던 기존 기록은 전체 수행으로 본다. */
  executionType: ExecutionType;
  executedFrom?: string;
  executedTo?: string;
  environment?: string;
  platform?: Platform;
  summary: ResultImportSummary;
}

export type ImportHistoryItem = AssetImportHistoryItem | ResultImportHistoryItem;
export type ImportHistoryFilter = 'all' | ImportHistoryItem['type'];

export function toAssetImportHistoryItem(session: TestAssetImportSession): AssetImportHistoryItem {
  return {
    type: 'asset',
    id: session.id,
    projectId: session.projectId,
    fileName: session.fileName,
    importedAt: session.importedAt,
    ...(session.artifactId && { artifactId: session.artifactId }),
    totalRows: session.totalRows,
    created: session.created,
    updated: session.updated,
    unchanged: session.unchanged,
    excluded: session.excluded,
  };
}

export function toResultImportHistoryItem(resultImport: TestResultImport, results: TestResult[]): ResultImportHistoryItem {
  return {
    type: 'result',
    id: resultImport.id,
    projectId: resultImport.projectId,
    fileName: resultImport.fileRef,
    importedAt: resultImport.importedAt,
    ...(resultImport.artifactId && { artifactId: resultImport.artifactId }),
    round: resultImport.round,
    executionType: resultImport.executionType ?? 'full',
    executedFrom: resultImport.executedFrom,
    executedTo: resultImport.executedTo,
    environment: resultImport.environment,
    platform: resultImport.platform,
    summary: summarizeResultImport(results),
  };
}

/** 가져온 시각 최신순. 시각이 같으면 종류·id로 항상 같은 순서를 유지한다. */
export function compareImportHistory(a: ImportHistoryItem, b: ImportHistoryItem): number {
  const byTime = new Date(b.importedAt).getTime() - new Date(a.importedAt).getTime();
  if (byTime !== 0) return byTime;
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function buildImportHistory(
  sessions: TestAssetImportSession[],
  resultImports: TestResultImport[],
  resultsByImport: Record<string, TestResult[]>,
): ImportHistoryItem[] {
  const items: ImportHistoryItem[] = [
    ...sessions.map(toAssetImportHistoryItem),
    ...resultImports.map((item) => toResultImportHistoryItem(item, resultsByImport[item.id] ?? [])),
  ];
  return items.sort(compareImportHistory);
}

export function filterImportHistory(items: ImportHistoryItem[], filter: ImportHistoryFilter): ImportHistoryItem[] {
  return filter === 'all' ? items : items.filter((item) => item.type === filter);
}
