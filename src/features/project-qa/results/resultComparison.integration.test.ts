import { describe, expect, it, vi } from 'vitest';
import { createLocalRepositories } from '@/data/local/localRepositories';
import { createMemoryStateStore, type StateStore } from '@/data/local/stateStore';
import type { Repositories } from '@/data/repositories/types';
import { PROJECT_A } from '@/data/mock/seed';
import { compareResultRounds, defaultComparisonRounds, type ResultComparison } from '@/domain/resultComparison';
import type { ImportTable } from '@/domain/testAssetImport';
import { analyzeResultImport, defaultResultDecisionFor, suggestResultColumnMapping, type ResultColumnMapping } from '@/domain/testResultImport';
import type { ExecutionType, TestResult } from '@/domain/types';

/*
 * 실제 수행 결과 가져오기(로컬 저장소 · 예시 데이터) → 수행 결과 비교.
 * 예시 데이터의 1 · 2차(전체 수행, Android · iOS)에 부분 수행 3차 · 재수행 4차를 가져와 비교한다.
 */

async function openRepos(store: StateStore) {
  const repos = createLocalRepositories({ openStore: async () => store });
  await repos.persistence.load();
  return repos;
}

/** 고객사 결과 파일 한 장(TC ID · 테스트 항목 · Android · iOS)을 실제 가져오기 흐름으로 가져온다. */
async function importRound(repos: Repositories, round: number, executionType: ExecutionType, rows: string[][]) {
  const table: ImportTable = { headers: ['TC ID', '테스트 항목', 'Android', 'iOS'], rows: rows.map((cells, index) => ({ rowNumber: index + 2, cells })) };
  // Android · iOS 열은 자동 연결하지 않으므로 가져오기 화면에서 사용자가 고르듯 플랫폼별 결과 열로 연결한다.
  const mapping: ResultColumnMapping = suggestResultColumnMapping(table.headers).map((field, index) => field ?? (['result_android', 'result_ios'] as const)[index - 2] ?? null);
  const template = await repos.templates.get('tpl-client-a');
  const analysis = analyzeResultImport(table, mapping, await repos.testCases.listByProject(PROJECT_A), template?.resultMappings ?? []);
  const rowDecisions = analysis.rows.map((item) => ({ rowNumber: item.row.rowNumber, kind: item.kind, testCaseId: item.testCaseId, decision: defaultResultDecisionFor(item) === 'pending' ? ('import' as const) : defaultResultDecisionFor(item)! }));
  return repos.testResults.importResults({
    projectId: PROJECT_A,
    fileName: `고객사A_${round}차.csv`,
    table,
    mapping,
    cycle: { round, executionType, executedFrom: `2026-10-0${round}` },
    rowDecisions,
    valueDecisions: {},
  });
}

async function loadAll(repos: Repositories) {
  const imports = await repos.testResults.listImports(PROJECT_A);
  const results = (await Promise.all(imports.map((item) => repos.testResults.listResults(item.id)))).flat();
  return { imports, results };
}

const byRound = (imports: { id: string; round: number }[], round: number) => imports.find((item) => item.round === round)!;

/** externalId/플랫폼 → [이전, 이번, 변화] (표시용 ID로 읽기 쉽게 만든 표. 비교 자체는 내부 TC ID로 한다.) */
function readable(comparison: ResultComparison, results: TestResult[]) {
  if (!comparison.ok) throw new Error(comparison.reason);
  const externalIdByTc = new Map(results.filter((item) => item.testCaseId).map((item) => [item.testCaseId!, item.externalId]));
  return Object.fromEntries(comparison.rows.map((row) => [`${externalIdByTc.get(row.testCaseId)}/${row.platform}`, [row.previousStatus, row.currentStatus, row.changeType]]));
}

describe('수행 결과 비교 (실제 가져오기 → 비교)', () => {
  it('예시 데이터 1 · 2차(전체 수행)를 비교하면 TC · 플랫폼별 변화가 나오고 미연결 결과는 비교하지 않는다', async () => {
    const repos = await openRepos(createMemoryStateStore());
    const { imports, results } = await loadAll(repos);
    const comparison = compareResultRounds(byRound(imports, 1), byRound(imports, 2), results);
    if (!comparison.ok) throw new Error(comparison.reason);
    const table = readable(comparison, results);
    expect(table['SIGN-002/ios']).toEqual([expect.any(String), 'fail', expect.stringMatching(/newly_failed|still_failed/)]);
    expect(table['LOGIN-018/android'][1]).toBe('blocked');
    // 전체 수행끼리라 범위 변화가 없다.
    expect(comparison.counts.added_to_scope + comparison.counts.removed_from_scope).toBe(0);
    expect(comparison.previous.unlinked).toBeGreaterThan(0);
    expect(comparison.rows.length).toBe(comparison.previous.linked);
  });

  it('전체 수행 → 부분 수행: 부분 수행에 없는 TC는 범위 제외이고 미수행이 아니다. 재수행 비교도 같은 규칙이다', async () => {
    const repos = await openRepos(createMemoryStateStore());
    const before = await loadAll(repos);
    const round2Results = before.results.filter((item) => item.importId === byRound(before.imports, 2).id);

    await importRound(repos, 3, 'partial', [
      ['SIGN-001', '유효한 비밀번호 입력 시 가입 가능', 'F', 'P'],
      ['SIGN-002', '최소 길이 8자 입력', 'P', 'P'],
      ['LOGIN-019', '계정 잠금', 'P', 'N/T'],
    ]);
    await importRound(repos, 4, 'retest', [
      ['SIGN-001', '유효한 비밀번호 입력 시 가입 가능', 'P', 'P'],
      ['LOGIN-018', '실패 횟수 정책', 'B', 'F'],
    ]);
    const { imports, results } = await loadAll(repos);

    // 2차(전체) → 3차(부분)
    const fullToPartial = compareResultRounds(byRound(imports, 2), byRound(imports, 3), results);
    const table = readable(fullToPartial, results);
    expect(table['SIGN-001/android']).toEqual(['pass', 'fail', 'newly_failed']);
    expect(table['SIGN-001/ios']).toEqual(['pass', 'pass', 'unchanged_pass']);
    expect(table['SIGN-002/ios']).toEqual(['fail', 'pass', 'fixed']);
    expect(table['LOGIN-019/android']).toEqual(['fail', 'pass', 'fixed']);
    expect(table['LOGIN-019/ios']).toEqual(['not_tested', 'not_tested', 'unchanged_not_tested']);
    if (!fullToPartial.ok) throw new Error();
    const removed = fullToPartial.rows.filter((row) => row.changeType === 'removed_from_scope');
    expect(removed.length).toBe(fullToPartial.previous.linked - 6);
    // 범위에서 빠진 TC를 미수행으로 바꾸지 않는다.
    expect(removed.every((row) => row.currentStatus === null && row.previousStatus !== null)).toBe(true);
    expect(fullToPartial.counts.newly_not_tested).toBe(0);

    // 3차(부분) → 4차(재수행)
    const partialToRetest = readable(compareResultRounds(byRound(imports, 3), byRound(imports, 4), results), results);
    expect(partialToRetest).toEqual({
      'SIGN-001/android': ['fail', 'pass', 'fixed'],
      'SIGN-001/ios': ['pass', 'pass', 'unchanged_pass'],
      'SIGN-002/android': ['pass', null, 'removed_from_scope'],
      'SIGN-002/ios': ['pass', null, 'removed_from_scope'],
      'LOGIN-019/android': ['pass', null, 'removed_from_scope'],
      'LOGIN-019/ios': ['not_tested', null, 'removed_from_scope'],
      'LOGIN-018/android': [null, 'blocked', 'added_to_scope'],
      'LOGIN-018/ios': [null, 'fail', 'added_to_scope'],
    });

    // 비교는 저장된 결과를 바꾸지 않는다.
    const round2After = await repos.testResults.listResults(byRound(imports, 2).id);
    expect(round2After).toEqual(round2Results);
  });

  it('결과를 가져오면 저장소 변경 알림이 오고, 다시 읽으면 새 차수가 기본 비교 대상이 된다', async () => {
    const repos = await openRepos(createMemoryStateStore());
    const listener = vi.fn();
    const unsubscribe = repos.subscribe(listener);
    await importRound(repos, 3, 'retest', [['SIGN-001', '유효한 비밀번호 입력 시 가입 가능', 'F', 'F']]);
    unsubscribe();
    expect(listener).toHaveBeenCalled();
    const { imports } = await loadAll(repos);
    expect(defaultComparisonRounds(imports)).toMatchObject({ previous: { round: 2 }, current: { round: 3 } });
  });

  it('저장소를 다시 열어도(persistence reload) 같은 비교 결과가 나온다', async () => {
    const store = createMemoryStateStore();
    const first = await openRepos(store);
    await importRound(first, 3, 'partial', [['SIGN-001', '유효한 비밀번호 입력 시 가입 가능', 'F', 'B']]);
    const a = await loadAll(first);
    const compare = (data: typeof a) => compareResultRounds(byRound(data.imports, 2), byRound(data.imports, 3), data.results);

    const reopened = await openRepos(store);
    const b = await loadAll(reopened);
    expect(b.results).toEqual(a.results);
    expect(compare(b)).toEqual(compare(a));
    expect(readable(compare(b), b.results)['SIGN-001/ios']).toEqual(['pass', 'blocked', 'newly_blocked']);
  });
});
