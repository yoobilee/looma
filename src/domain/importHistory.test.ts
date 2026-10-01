import { describe, expect, it } from 'vitest';
import { createSeed } from '@/data/mock/seed';
import { buildImportHistory, filterImportHistory, toAssetImportHistoryItem, toResultImportHistoryItem } from './importHistory';
import type { TestAssetImportSession, TestResult, TestResultImport } from './types';

const asset = (id: string, importedAt: string): TestAssetImportSession => ({
  id,
  projectId: 'p1',
  fileName: `${id}.csv`,
  importedAt,
  totalRows: 157,
  created: 34,
  updated: 8,
  unchanged: 112,
  excluded: 3,
});
const resultImport = (id: string, importedAt: string, extra: Partial<TestResultImport> = {}): TestResultImport => ({
  id,
  projectId: 'p1',
  round: 1,
  fileRef: `${id}.csv`,
  importedAt,
  mapping: [],
  ...extra,
});
const result = (id: string, value: TestResult['result'], testCaseId?: string): TestResult => ({
  id,
  importId: 'r',
  testCaseId,
  feature: 'f',
  title: 't',
  result: value,
});

describe('가져오기 이력 변환', () => {
  it('TC 가져오기는 건수와 총 행 수를 그대로 옮긴다', () => {
    expect(toAssetImportHistoryItem(asset('a', '2026-10-01T01:00:00Z'))).toMatchObject({
      type: 'asset',
      fileName: 'a.csv',
      totalRows: 157,
      created: 34,
      updated: 8,
      unchanged: 112,
      excluded: 3,
    });
  });

  it('수행 결과 가져오기는 결과 건수와 미연결을 계산한다', () => {
    const item = toResultImportHistoryItem(resultImport('r', '2026-10-01T01:00:00Z', { round: 3, environment: 'STG', executedFrom: '2026-09-30' }), [
      result('1', 'pass', 'tc1'),
      result('2', 'fail', 'tc2'),
      result('3', 'blocked'),
      result('4', 'not_tested', 'tc4'),
    ]);
    expect(item).toMatchObject({ type: 'result', round: 3, fileName: 'r.csv', environment: 'STG', executedFrom: '2026-09-30' });
    expect(item.summary).toMatchObject({ total: 4, pass: 1, fail: 1, blocked: 1, not_tested: 1, unlinked: 1 });
  });

  it('수행 유형이 없으면 전체 수행, 종료일·환경·플랫폼이 없으면 비워 둔다', () => {
    const item = toResultImportHistoryItem(resultImport('r', '2026-10-01T01:00:00Z'), []);
    expect(item.executionType).toBe('full');
    expect(item.executedTo).toBeUndefined();
    expect(item.environment).toBeUndefined();
    expect(item.platform).toBeUndefined();
    expect(item.summary.total).toBe(0);
  });
});

describe('가져오기 이력 목록', () => {
  const sessions = [asset('a-old', '2026-09-01T00:00:00Z'), asset('a-new', '2026-10-01T00:00:00Z')];
  const imports = [resultImport('r-1', '2026-09-15T00:00:00Z', { round: 9 }), resultImport('r-2', '2026-09-20T00:00:00Z', { round: 1 })];

  it('두 종류를 가져온 시각 최신순으로 합친다(차수 순서와 무관)', () => {
    expect(buildImportHistory(sessions, imports, {}).map((item) => item.id)).toEqual(['a-new', 'r-2', 'r-1', 'a-old']);
  });

  it('같은 시각이면 종류·id 순으로 고정한다', () => {
    const at = '2026-10-01T00:00:00Z';
    const ids = buildImportHistory([asset('b', at), asset('a', at)], [resultImport('z', at)], {}).map((item) => item.id);
    expect(ids).toEqual(['a', 'b', 'z']);
  });

  it('종류별로 거른다', () => {
    const all = buildImportHistory(sessions, imports, {});
    expect(filterImportHistory(all, 'all')).toHaveLength(4);
    expect(filterImportHistory(all, 'asset').map((item) => item.type)).toEqual(['asset', 'asset']);
    expect(filterImportHistory(all, 'result').map((item) => item.type)).toEqual(['result', 'result']);
  });

  it('이력이 없으면 빈 목록이다', () => {
    expect(buildImportHistory([], [], {})).toEqual([]);
  });

  it('기존 seed의 수행 결과 가져오기는 전체 수행으로 표시된다', () => {
    const seed = createSeed();
    const seeded = seed.resultImports.filter((item) => item.projectId === 'proj-client-a-mobile');
    const byImport = Object.fromEntries(seeded.map((item) => [item.id, seed.results.filter((entry) => entry.importId === item.id)]));
    const history = buildImportHistory([], seeded, byImport);
    expect(history.length).toBeGreaterThan(0);
    for (const item of history) if (item.type === 'result') expect(item.executionType).toBe('full');
  });
});
