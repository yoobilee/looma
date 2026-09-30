import { describe, expect, it, vi } from 'vitest';
import { createSeed } from '@/data/mock/seed';
import {
  analyzeResultImport,
  normalizeResultValue,
  planResultImport,
  resultColumnMappingProblems,
  suggestNextRound,
  suggestResultColumnMapping,
  summarizeResultImport,
  usesCyclePlatform,
  type ResultColumnMapping,
} from './testResultImport';
import type { ImportTable } from './testAssetImport';

const PROJECT = 'proj-client-a-mobile';

describe('컬럼 매핑', () => {
  it('명백한 alias만 자동으로 연결하고 뜻이 갈리는 컬럼은 비워 둔다', () => {
    expect(suggestResultColumnMapping(['TC_ID', 'Test Case ID', '결과', 'Result', '비고', 'Remark', 'ID', '상태', 'Android', 'iOS'])).toEqual([
      'externalId',
      null,
      'result',
      null,
      'note',
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(suggestResultColumnMapping(['수행 결과'])).toEqual(['result']);
    expect(suggestResultColumnMapping(['Note'])).toEqual(['note']);
  });

  it('고객사 TC ID와 결과 컬럼은 필수이고, 결과 방식은 한 가지만 쓴다', () => {
    const headers = ['A', 'B', 'C'];
    expect(resultColumnMappingProblems(headers, ['title', null, null])).toEqual([
      "'고객사 TC ID' 컬럼을 연결해 주세요. 결과는 고객사 TC ID로만 TC에 연결해요.",
      "'수행 결과' 또는 플랫폼별 결과 컬럼을 연결해 주세요.",
    ]);
    expect(resultColumnMappingProblems(headers, ['externalId', 'result', 'result_ios'])).toEqual([
      "'수행 결과'과 플랫폼별 결과 컬럼은 함께 연결할 수 없어요. 한 가지 방식만 골라 주세요.",
    ]);
    expect(resultColumnMappingProblems(headers, ['externalId', 'platform', 'result_ios'])[0]).toContain("'플랫폼' 컬럼은 연결하지 않아요");
    expect(resultColumnMappingProblems(headers, ['externalId', 'result', 'result'])[0]).toContain('컬럼이 둘 이상');
    expect(resultColumnMappingProblems(headers, ['externalId', 'result_android', 'result_ios'])).toEqual([]);
  });

  it('차수 플랫폼은 결과 컬럼이 하나이고 플랫폼 컬럼이 없을 때만 쓴다', () => {
    expect(usesCyclePlatform(['externalId', 'result'])).toBe(true);
    expect(usesCyclePlatform(['externalId', 'result', 'platform'])).toBe(false);
    expect(usesCyclePlatform(['externalId', 'result_android'])).toBe(false);
  });
});

describe('결과 값 정규화', () => {
  it('템플릿 매핑을 기본 표기보다 먼저 본다', () => {
    expect(normalizeResultValue('PASS')).toBe('pass');
    expect(normalizeResultValue('PASS', [{ rawValue: 'pass', result: 'fail' }])).toBe('fail');
    expect(normalizeResultValue(' ng ')).toBe('fail');
  });

  it('알 수 없는 값과 빈 칸은 추측하지 않는다', () => {
    expect(normalizeResultValue('OK')).toBeUndefined();
    expect(normalizeResultValue('통과?')).toBeUndefined();
    expect(normalizeResultValue('  ')).toBeUndefined();
  });
});

describe('차수 · 요약', () => {
  it('다음 차수는 가장 큰 차수 + 1이고 차수가 없으면 1이다', () => {
    expect(suggestNextRound([])).toBe(1);
    expect(suggestNextRound([{ round: 1 }, { round: 4 }, { round: 2 }])).toBe(5);
  });

  it('차수 요약은 결과별 수와 연결 · 미연결 수를 센다', () => {
    const base = { importId: 'imp', feature: '회원가입', title: 'x' };
    expect(
      summarizeResultImport([
        { ...base, id: '1', testCaseId: 'tc-1', result: 'pass' },
        { ...base, id: '2', testCaseId: 'tc-2', result: 'fail' },
        { ...base, id: '3', result: 'blocked' },
        { ...base, id: '4', result: 'not_tested' },
      ]),
    ).toEqual({ total: 4, pass: 1, fail: 1, blocked: 1, not_tested: 1, linked: 2, unlinked: 2 });
  });
});

describe('반영 계획 · ID 할당', () => {
  const seed = createSeed();
  const testCases = seed.testCases.filter((item) => item.projectId === PROJECT);
  const table: ImportTable = {
    headers: ['TC ID', '결과'],
    rows: [
      { rowNumber: 2, cells: ['SIGN-001', 'P'] },
      { rowNumber: 3, cells: ['SIGN-002', 'F'] },
      { rowNumber: 4, cells: ['NEW-404', 'OK'] },
    ],
  };
  const mapping: ResultColumnMapping = ['externalId', 'result'];
  const analysis = analyzeResultImport(table, mapping, testCases, seed.templates[0].resultMappings);
  const decisions = [
    { rowNumber: 2, kind: 'matched' as const, testCaseId: 'tc-001', decision: 'import' as const },
    { rowNumber: 3, kind: 'matched' as const, testCaseId: 'tc-002', decision: 'import' as const },
    { rowNumber: 4, kind: 'unmatched' as const, decision: 'import' as const },
  ];
  const context = { testCases, existingImports: seed.resultImports, cyclePlatformAllowed: true };
  const cycle = { round: 3, executionType: 'full' as const, executedFrom: '2026-09-28' };

  it('뒤쪽 결과 값 판단이 빠져 실패하면 차수 · 결과 ID를 하나도 만들지 않는다', () => {
    const createId = vi.fn((prefix: string) => `${prefix}-new`);
    expect(() => planResultImport(analysis, decisions, {}, cycle, context, { projectId: PROJECT, fileName: 'r.csv', now: 'now', createId })).toThrow('결과 값 1종을');
    expect(createId).not.toHaveBeenCalled();
  });

  it('차수 문제로 실패해도 ID를 만들지 않는다', () => {
    const createId = vi.fn((prefix: string) => `${prefix}-new`);
    expect(() =>
      planResultImport(analysis, decisions, { OK: 'pass' }, { ...cycle, round: 1 }, context, { projectId: PROJECT, fileName: 'r.csv', now: 'now', createId }),
    ).toThrow('1차는 이미 있어요');
    expect(createId).not.toHaveBeenCalled();
  });

  it('검증을 통과하면 차수 ID를 먼저, 이어서 결과 ID를 행 순서대로 할당하고 입력은 바꾸지 않는다', () => {
    let counter = 0;
    const createId = vi.fn((prefix: string) => `${prefix}-new-${(counter += 1)}`);
    const testCasesBefore = structuredClone(testCases);
    const plan = planResultImport(analysis, decisions, { OK: 'pass' }, cycle, context, { projectId: PROJECT, fileName: 'r.csv', now: 'now', createId });
    expect(createId.mock.calls.map(([prefix]) => prefix)).toEqual(['imp', 'res', 'res', 'res']);
    expect(plan.resultImport.id).toBe('imp-new-1');
    expect(plan.results.map((item) => [item.id, item.importId, item.testCaseId, item.result])).toEqual([
      ['res-new-2', 'imp-new-1', 'tc-001', 'pass'],
      ['res-new-3', 'imp-new-1', 'tc-002', 'fail'],
      ['res-new-4', 'imp-new-1', undefined, 'pass'],
    ]);
    expect(testCases).toEqual(testCasesBefore);
  });
});
