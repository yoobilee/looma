import type { Repositories } from '../repositories/types';
import type { StoredAppState } from '../local/appData';
import type { ImportTable } from '@/domain/testAssetImport';
import { analyzeResultImport, defaultResultDecisionFor, type ResultColumnMapping } from '@/domain/testResultImport';
import { createSeed, PROJECT_A, type SeedData } from './seed';

/*
 * 이슈 · 확인사항 테스트용 데이터. 단위 테스트와 실제 브라우저(IndexedDB) 테스트가 같은 데이터를 쓴다.
 * 제품 코드는 이 파일을 쓰지 않는다.
 */

/** v1에서 쓰던 이슈 상태로 되돌린 값. 현재 예시 데이터를 v1 저장 모양으로 만들 때 쓴다. */
const toLegacyStatus = (issue: SeedData['issues'][number]) => {
  if (issue.type === 'defect') return issue.status === 'resolved' ? 'closed' : 'open';
  if (issue.status === 'resolved') return 'answered';
  return issue.id === 'issue-q-terms' ? 'checking' : 'waiting';
};

/**
 * v1(schemaVersion 1)로 저장돼 있던 상태. 결과 → 이슈 연결은 TestResult.issueId에 있고, 이슈에는 updatedAt · resultId가 없다.
 * 예시 데이터의 이슈 두 건(BUG-014 · BUG-015)은 v1에서 결과의 issueId로 연결돼 있었다.
 */
export function legacyV1State(revision = 7): StoredAppState {
  const seed = createSeed();
  const issues = seed.issues.map((issue) => {
    const legacy: Record<string, unknown> = { ...issue, status: toLegacyStatus(issue) };
    for (const field of ['updatedAt', 'resolvedAt', 'resultId', 'expected', 'actual', 'description', 'reproduction']) delete legacy[field];
    return legacy;
  });
  const legacyLinks = new Map(seed.issues.filter((issue) => issue.resultId).map((issue) => [issue.resultId!, issue.id]));
  const results = seed.results.map((result) => (legacyLinks.has(result.id) ? { ...result, issueId: legacyLinks.get(result.id) } : { ...result }));
  return { schemaVersion: 1, revision, savedAt: '2026-09-30T09:00:00.000Z', data: { ...seed, issues, results } };
}

export const QA_TEST_CASE_ID = 'tc-qa-101';
export const QA_EXTERNAL_ID = 'TC-101';

/** 프로젝트 A에 TC-101만 남기고 수행 결과 · 이슈를 비운 예시 데이터. 1차부터 차수를 직접 가져온다. */
export function qaScenarioSeed(): SeedData {
  const seed = createSeed();
  const sample = seed.testCases.find((item) => item.projectId === PROJECT_A)!;
  seed.testCases.push({
    ...sample,
    id: QA_TEST_CASE_ID,
    externalId: QA_EXTERNAL_ID,
    feature: '로그인',
    title: '올바른 계정으로 로그인하면 홈으로 이동',
    expectedResult: '홈 화면이 열린다',
    status: 'active',
  });
  seed.resultImports = seed.resultImports.filter((item) => item.projectId !== PROJECT_A);
  seed.results = seed.results.filter((result) => seed.resultImports.some((item) => item.id === result.importId));
  seed.issues = [];
  return seed;
}

/** TC-101 Android 결과 한 행을 실제 가져오기와 같은 흐름으로 새 차수로 가져온다. raw는 템플릿 매핑 값(P · F · B · N/T). */
export async function importQaRound(repos: Repositories, round: number, raw: 'P' | 'F' | 'B' | 'N/T', note = '') {
  const table: ImportTable = { headers: ['TC ID', '테스트 항목', 'Android', '비고'], rows: [{ rowNumber: 2, cells: [QA_EXTERNAL_ID, '로그인', raw, note] }] };
  const mapping: ResultColumnMapping = ['externalId', 'title', 'result_android', 'note'];
  const project = (await repos.projects.get(PROJECT_A))!;
  const template = project.tcTemplateId ? await repos.templates.get(project.tcTemplateId) : undefined;
  const analysis = analyzeResultImport(table, mapping, await repos.testCases.listByProject(PROJECT_A), template?.resultMappings ?? []);
  const rowDecisions = analysis.rows.map((item) => ({ rowNumber: item.row.rowNumber, kind: item.kind, testCaseId: item.testCaseId, decision: defaultResultDecisionFor(item)! }));
  const resultImport = await repos.testResults.importResults({
    projectId: PROJECT_A,
    fileName: `TC-101_${round}차.csv`,
    table,
    mapping,
    cycle: { round, executionType: round === 1 ? 'full' : 'retest', executedFrom: `2026-10-0${Math.min(round, 9)}` },
    rowDecisions,
    valueDecisions: {},
  });
  const [result] = await repos.testResults.listResults(resultImport.id);
  return { resultImport, result };
}
