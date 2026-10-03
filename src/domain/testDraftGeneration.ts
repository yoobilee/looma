import { testPerspectiveLabel } from './labels';
import type { Deliverable, Project, Requirement, SourceRef, TestCase, TestCaseGenerationType, TestCondition, TestPerspective } from './types';

/*
 * 요구사항 기반 TC 초안 생성 — AI 없이 요구사항과 사용자가 고른 테스트 관점에서 TestCondition · TestCase 초안을 만든다.
 *
 *   요구사항 + 관점 ─ 후보 생산자(지금은 규칙 기반) ─▶ TestDraftCandidate[] ─ 분석(중복 · 오류 · 조건 재사용) ─▶ 사용자 검토 · 제외 ─▶ 저장 계획
 *
 * 후보 생산자만 갈아 끼울 수 있다. 나중에 AI가 같은 TestDraftCandidate를 만들면 analyzeTestDraftCandidates부터 그대로 쓴다.
 * 규칙 기반 생산자는 요구사항에 없는 구체값(화면 문구 · 버튼 이름 · API 경로 · 상태 코드 · 시간 · 브라우저 버전)을 만들지 않는다.
 * 단서가 있는 관점(경계값 · 권한 · 상태 변화 · 데이터 · API · 성능)은 요구사항 문장에 그 단서가 있을 때만 후보를 만든다.
 * 기존 TC · 테스트 조건은 읽기만 하고 고치지 않는다. 모든 계산은 입력을 바꾸지 않는다.
 */

export class TestDraftGenerationError extends Error {}

/* ---------- 후보 ---------- */

/** 요구사항 하나(또는 여럿)와 관점 하나에서 나온 TC 초안 후보. 파일 · 규칙 · AI 어디서 만들었는지는 모른다. */
export interface TestDraftCandidate {
  /** 후보를 가리키는 값. 같은 관점 · 같은 요구사항 조합은 같은 key라 사용자의 제외 판단을 다시 찾을 수 있다. */
  key: string;
  perspective: TestPerspective;
  /** 근거 요구사항. 여럿이 한 후보에 이어질 수 있다. */
  requirementIds: string[];
  /** 요구사항에서 물려받은 근거 유형. 확인 필요면 검토 완료로 표시할 수 없다. */
  generationType: TestCaseGenerationType;
  condition: { feature: string; title: string };
  testCase: { feature: string; depth: string[]; title: string; precondition?: string; steps: string[]; expectedResult: string };
}

export const testDraftCandidateKey = (perspective: TestPerspective, requirementIds: string[]) => `${perspective}|${requirementIds.join(',')}`;

export interface TestDraftContext {
  project: Pick<Project, 'id' | 'platforms' | 'testScopes' | 'tcTemplateId'>;
  requirements: Requirement[];
  deliverables: Deliverable[];
  testConditions: TestCondition[];
  testCases: TestCase[];
}

export interface TestDraftRequest {
  requirementIds: string[];
  perspectives: TestPerspective[];
}

/** 프로젝트 테스트 범위를 골랐을 때만 쓸 수 있는 관점 */
const scopeDrivenPerspectives = ['api', 'performance', 'compatibility'] as const;
const knownPerspectives = Object.keys(testPerspectiveLabel) as TestPerspective[];

/** 생성 대상이 될 수 있는 요구사항: 이 프로젝트의 요구사항이고 제거되지 않았다. 검토 상태(draft 등)는 보지 않는다. */
export const isTestDraftEligible = (requirement: Requirement, projectId: string) => requirement.projectId === projectId && requirement.lifecycle !== 'removed';

/** 관점이 이 프로젝트에서 쓸 수 있는지 */
export function isPerspectiveAvailable(perspective: TestPerspective, project: Pick<Project, 'testScopes'>): boolean {
  return !(scopeDrivenPerspectives as readonly string[]).includes(perspective) || project.testScopes.includes(perspective as 'api' | 'performance' | 'compatibility');
}

function validateRequest(context: TestDraftContext, request: TestDraftRequest): Requirement[] {
  if (request.requirementIds.length === 0) throw new TestDraftGenerationError('초안을 만들 요구사항을 하나 이상 골라 주세요.');
  if (request.perspectives.length === 0) throw new TestDraftGenerationError('테스트 관점을 하나 이상 골라 주세요.');
  const seenPerspectives = new Set<string>();
  for (const perspective of request.perspectives) {
    if (!knownPerspectives.includes(perspective)) throw new TestDraftGenerationError(`알 수 없는 테스트 관점이에요. (${String(perspective)})`);
    if (seenPerspectives.has(perspective)) throw new TestDraftGenerationError(`같은 테스트 관점을 두 번 골랐어요. (${testPerspectiveLabel[perspective]})`);
    seenPerspectives.add(perspective);
    if (!isPerspectiveAvailable(perspective, context.project)) throw new TestDraftGenerationError(`이 프로젝트의 테스트 범위에 없는 관점이에요. (${testPerspectiveLabel[perspective]})`);
  }
  const byId = new Map(context.requirements.map((item) => [item.id, item]));
  const seenRequirements = new Set<string>();
  return request.requirementIds.map((id) => {
    if (seenRequirements.has(id)) throw new TestDraftGenerationError(`같은 요구사항을 두 번 골랐어요. (${id})`);
    seenRequirements.add(id);
    const requirement = byId.get(id);
    if (!requirement || requirement.projectId !== context.project.id) throw new TestDraftGenerationError(`이 프로젝트에서 요구사항을 찾을 수 없어요. (${id})`);
    if (requirement.lifecycle === 'removed') throw new TestDraftGenerationError(`제거된 요구사항으로는 초안을 만들 수 없어요. (${id})`);
    return requirement;
  });
}

/* ---------- 규칙 기반 후보 생산자 ---------- */

const clean = (value: string) => value.normalize('NFC').replace(/\s+/g, ' ').trim();
/** 문장 끝의 마침표를 뺀 요구사항 문장 */
const sentence = (requirement: Requirement) => clean(requirement.text).replace(/[.。]+$/, '');

/** 요구사항 문장에 이 관점의 단서가 있는가. 단서가 없는 관점은 억지로 만들지 않는다. */
const clues: Partial<Record<TestPerspective, RegExp>> = {
  boundary: /\d|최소|최대|이상|이하|초과|미만|이내/,
  permission: /권한|역할|관리자|운영자|접근|비회원|열람|승인|허용|차단|admin/i,
  state_change: /유지|변경|전환|재실행|재시작|재접속|복원|종료|만료|상태/,
  data_io: /조회|저장|입력|출력|반영|등록|수정|삭제|전송|발송|보내|보낸|불러|업로드|다운로드/,
  api: /\bapi\b|엔드포인트|endpoint|요청|응답|호출|토큰/i,
  performance: /\d+\s*(ms|밀리초|초|분)|응답\s*시간|속도|동시|처리량|tps|로딩|성능/i,
};

/** 경계값 단서 중 숫자가 붙은 표현(예: 8자). 단계에 그대로 옮겨 적는다. */
const numericClues = (text: string) => [...new Set(clean(text).match(/\d+(?:[.,]\d+)?\s?[가-힣A-Za-z%]*/g) ?? [])].map((value) => value.trim());

const generationTypeOf = (requirements: Requirement[]): TestCaseGenerationType => {
  // 확인 필요 표시는 근거 유형보다 우선한다. 사용자가 불명확하다고 표시한 요구사항으로 검토 가능한 TC를 만들지 않는다.
  if (requirements.some((item) => item.needsConfirmation || item.sourceType === 'needs_confirmation')) return 'needs_confirmation';
  if (requirements.some((item) => item.sourceType === 'ai_suggestion')) return 'ai_suggestion';
  return 'source_explicit';
};

interface Draft {
  conditionTitle: string;
  title: string;
  steps: string[];
  expected: string;
}

/** 관점별 일반 초안. 요구사항 문장만 인용하고 문구 · 값 · 절차를 새로 지어내지 않는다. */
function draftFor(perspective: TestPerspective, requirement: Requirement, project: TestDraftContext['project']): Draft | { skip: string } {
  const text = sentence(requirement);
  const label = testPerspectiveLabel[perspective];
  const pending = generationTypeOf([requirement]) === 'needs_confirmation';
  const expect = (behavior: string) => (pending ? `확인 필요 — 요구사항 확정 후 기대 결과를 정해요. (${text})` : `${behavior} (${text})`);
  const base = { conditionTitle: `${label} · ${text}`, title: `${text} · ${label} 확인` };
  const clue = clues[perspective];
  if (clue && !clue.test(requirement.text)) return { skip: `요구사항에 ${label} 단서가 없어 만들지 않았어요.` };

  switch (perspective) {
    case 'normal_flow':
      return { ...base, steps: ['요구사항과 관련된 기능 화면으로 이동한다.', '요구사항에 적힌 조건으로 동작을 수행한다.', '결과를 확인한다.'], expected: expect('요구사항대로 동작한다.') };
    case 'exception':
      return {
        ...base,
        steps: ['요구사항의 정상 조건을 벗어나는 입력이나 상황을 만든다.', '동작을 수행한다.', '요구사항에 정의된 예외 처리 결과를 확인한다.'],
        expected: expect('요구사항에 정의된 예외 처리가 수행된다.'),
      };
    case 'boundary': {
      const values = numericClues(requirement.text);
      return {
        ...base,
        steps: [
          values.length > 0 ? `요구사항에 적힌 기준값(${values.join(', ')})을 확인한다.` : '요구사항에 적힌 기준값을 확인한다.',
          '기준값 안쪽과 바깥쪽 값으로 각각 동작을 수행한다.',
          '경계에서 결과가 달라지는지 확인한다.',
        ],
        expected: expect('기준값 경계에서 요구사항대로 동작한다.'),
      };
    }
    case 'permission':
      return { ...base, steps: ['요구사항에 적힌 권한 조건을 확인한다.', '권한이 있는 경우와 없는 경우 각각 동작을 수행한다.', '결과를 확인한다.'], expected: expect('권한에 따라 요구사항대로 동작한다.') };
    case 'state_change':
      return { ...base, steps: ['요구사항과 관련된 상태를 만든다.', '요구사항에 적힌 상태 변화 동작을 수행한다.', '변화 뒤 상태를 확인한다.'], expected: expect('상태 변화가 요구사항대로 반영된다.') };
    case 'data_io':
      return {
        ...base,
        steps: ['요구사항과 관련된 데이터를 입력하거나 조회한다.', '동작을 수행한다.', '데이터가 요구사항대로 저장 · 반영 · 표시되는지 확인한다.'],
        expected: expect('데이터가 요구사항대로 처리된다.'),
      };
    case 'api':
      return { ...base, steps: ['요구사항과 관련된 API 요청을 보낸다.', '응답을 확인한다.'], expected: expect('API가 요구사항대로 응답한다.') };
    case 'performance':
      return { ...base, steps: ['요구사항에 적힌 성능 기준을 확인한다.', '같은 조건에서 동작을 수행하며 측정한다.', '측정 결과를 요구사항 기준과 비교한다.'], expected: expect('성능이 요구사항 기준을 만족한다.') };
    case 'compatibility': {
      if (project.platforms.length === 0) return { skip: '프로젝트에 플랫폼이 없어 만들지 않았어요.' };
      return {
        ...base,
        steps: [...project.platforms.map((platform) => `${platformName[platform]}에서 요구사항과 관련된 동작을 수행한다.`), '플랫폼별 결과를 비교한다.'],
        expected: expect('모든 대상 플랫폼에서 요구사항대로 동작한다.'),
      };
    }
  }
}

const platformName: Record<Project['platforms'][number], string> = { android: 'Android', ios: 'iOS', web: 'Web', desktop: 'Desktop' };

export interface SkippedTestDraft {
  requirementId: string;
  perspective: TestPerspective;
  reason: string;
}

export interface RuleBasedTestDrafts {
  candidates: TestDraftCandidate[];
  skipped: SkippedTestDraft[];
}

/** 규칙 기반 후보 생산자. 같은 입력이면 같은 후보를 같은 순서(요구사항 순서 → 관점 순서)로 만든다. */
export function produceRuleBasedTestDrafts(context: TestDraftContext, request: TestDraftRequest): RuleBasedTestDrafts {
  const requirements = validateRequest(context, request);
  const candidates: TestDraftCandidate[] = [];
  const skipped: SkippedTestDraft[] = [];
  for (const requirement of requirements) {
    for (const perspective of request.perspectives) {
      const draft = draftFor(perspective, requirement, context.project);
      if ('skip' in draft) {
        skipped.push({ requirementId: requirement.id, perspective, reason: draft.skip });
        continue;
      }
      candidates.push({
        key: testDraftCandidateKey(perspective, [requirement.id]),
        perspective,
        requirementIds: [requirement.id],
        generationType: generationTypeOf([requirement]),
        condition: { feature: requirement.feature, title: draft.conditionTitle },
        testCase: { feature: requirement.feature, depth: [requirement.feature, testPerspectiveLabel[perspective]], title: draft.title, steps: draft.steps, expectedResult: draft.expected },
      });
    }
  }
  return { candidates, skipped };
}

/* ---------- 분석 ---------- */

/** create: 새 TC 초안으로 만들 수 있음 / duplicate: 같은 내용의 TC가 이미 있음 / invalid: 만들 수 없는 후보 */
export type TestDraftKind = 'create' | 'duplicate' | 'invalid';

export const testDraftKindOrder: TestDraftKind[] = ['create', 'duplicate', 'invalid'];

export interface AnalyzedTestDraft {
  candidate: TestDraftCandidate;
  kind: TestDraftKind;
  reasons: string[];
  /** create에서 확인 필요 요구사항에서 온 후보(검토 완료로 표시할 수 없다) */
  needsConfirmation: boolean;
  /** create에서 이미 있는 같은 테스트 조건을 다시 쓰면 그 ID */
  reusedConditionId?: string;
  /** duplicate에서 같은 내용의 기존 TC. label은 고객사 ID가 있으면 그것, 없으면 내부 ID */
  duplicateOf?: { id: string; label: string };
  /** 연결 요구사항의 근거를 합친 것(산출물 + 위치 기준 중복 없음) */
  sourceRefs: SourceRef[];
}

export interface TestDraftAnalysis {
  rows: AnalyzedTestDraft[];
  skipped: SkippedTestDraft[];
  /** 요청한 요구사항 수 · 관점 수 */
  requirementCount: number;
  perspectiveCount: number;
}

const conditionIdentity = (requirementIds: string[], feature: string, title: string) => `${[...requirementIds].sort().join(',')}\u0000${clean(feature)}\u0000${clean(title)}`;
const testCaseIdentity = (category: string, feature: string, title: string, steps: string[], expected: string) =>
  [category, clean(feature), clean(title), steps.map(clean).join('\u0001'), clean(expected)].join('\u0000');

/**
 * 후보를 판정한다. 후보가 어디서 왔든 같은 규칙이다.
 * - 같은 프로젝트의 요구사항이 아니거나 제거된 요구사항이거나 근거 산출물이 이 프로젝트에 없으면 오류(invalid)다.
 * - 구분 · 기능 · 제목 · 절차 · 기대 결과가 정확히 같은(공백 · 유니코드 정규화만 무시) 기존 TC(폐기 제외)나 앞선 후보가 있으면 중복이다. 비슷한 것은 같다고 보지 않는다.
 * - 같은 프로젝트 · 같은 요구사항 · 같은 기능 · 같은 제목의 테스트 조건이 이미 있으면(폐기 제외) 새로 만들지 않고 다시 쓴다.
 */
export function analyzeTestDraftCandidates(
  context: TestDraftContext,
  candidates: TestDraftCandidate[],
  skipped: SkippedTestDraft[],
  counts: { requirementCount: number; perspectiveCount: number },
): TestDraftAnalysis {
  const requirementById = new Map(context.requirements.filter((item) => item.projectId === context.project.id).map((item) => [item.id, item]));
  const deliverableIds = new Set(context.deliverables.filter((item) => item.projectId === context.project.id).map((item) => item.id));
  const existingTestCases = new Map<string, TestCase>();
  for (const testCase of context.testCases) {
    if (testCase.projectId !== context.project.id || testCase.status === 'deprecated') continue;
    const identity = testCaseIdentity(testCase.category, testCase.feature, testCase.title, testCase.steps, testCase.expectedResult);
    if (!existingTestCases.has(identity)) existingTestCases.set(identity, testCase);
  }
  const existingConditions = new Map<string, TestCondition>();
  for (const condition of context.testConditions) {
    if (condition.projectId !== context.project.id || condition.status === 'deprecated') continue;
    const identity = conditionIdentity(condition.requirementIds, condition.feature, condition.title);
    if (!existingConditions.has(identity)) existingConditions.set(identity, condition);
  }

  const seenKeys = new Set<string>();
  const seenTestCases = new Set<string>();
  const rows = candidates.map((candidate): AnalyzedTestDraft => {
    if (seenKeys.has(candidate.key)) throw new TestDraftGenerationError(`같은 후보가 두 번 있어요. (${candidate.key})`);
    seenKeys.add(candidate.key);
    const needsConfirmation = candidate.generationType === 'needs_confirmation';
    const linked = candidate.requirementIds.map((id) => requirementById.get(id));
    const reasons: string[] = [];
    if (candidate.requirementIds.length === 0) reasons.push('근거 요구사항이 없어요.');
    linked.forEach((requirement, index) => {
      if (!requirement) reasons.push(`이 프로젝트에서 요구사항을 찾을 수 없어요. (${candidate.requirementIds[index]})`);
      else if (requirement.lifecycle === 'removed') reasons.push(`제거된 요구사항이에요. (${requirement.id})`);
    });
    const requirements = linked.filter((item): item is Requirement => !!item);
    const sourceRefs: SourceRef[] = [];
    const seenRefs = new Set<string>();
    for (const requirement of requirements) {
      for (const ref of requirement.sourceRefs) {
        if (!deliverableIds.has(ref.deliverableId)) {
          reasons.push(`근거 산출물을 찾을 수 없어요. (${ref.deliverableId})`);
          continue;
        }
        const identity = `${ref.deliverableId}\u0000${ref.locator}`;
        if (seenRefs.has(identity)) continue;
        seenRefs.add(identity);
        sourceRefs.push({ deliverableId: ref.deliverableId, locator: ref.locator });
      }
    }
    if (reasons.length > 0) return { candidate, kind: 'invalid', reasons: [...new Set(reasons)], needsConfirmation, sourceRefs: [] };

    const identity = testCaseIdentity(candidate.perspective, candidate.testCase.feature, candidate.testCase.title, candidate.testCase.steps, candidate.testCase.expectedResult);
    const existing = existingTestCases.get(identity);
    if (existing) {
      return { candidate, kind: 'duplicate', reasons: ['같은 내용의 TC가 이미 있어요.'], needsConfirmation, duplicateOf: { id: existing.id, label: existing.externalId ?? existing.id }, sourceRefs };
    }
    if (seenTestCases.has(identity)) return { candidate, kind: 'duplicate', reasons: ['이번에 만드는 다른 후보와 같은 내용이에요.'], needsConfirmation, sourceRefs };
    seenTestCases.add(identity);
    const reused = existingConditions.get(conditionIdentity(candidate.requirementIds, candidate.condition.feature, candidate.condition.title));
    return { candidate, kind: 'create', reasons: [], needsConfirmation, ...(reused && { reusedConditionId: reused.id }), sourceRefs };
  });
  return { rows, skipped, ...counts };
}

/** 규칙 기반 생산자 + 분석. 화면 미리보기와 저장소가 같은 함수를 쓴다. */
export function analyzeTestDraftGeneration(context: TestDraftContext, request: TestDraftRequest): TestDraftAnalysis {
  const { candidates, skipped } = produceRuleBasedTestDrafts(context, request);
  return analyzeTestDraftCandidates(context, candidates, skipped, { requirementCount: request.requirementIds.length, perspectiveCount: request.perspectives.length });
}

export interface TestDraftSummary {
  requirementCount: number;
  perspectiveCount: number;
  /** 만들 수 있었던 후보에서 사용자가 제외하지 않은 것(확인 필요 포함) */
  created: number;
  /** created 중 확인 필요 요구사항에서 온 것 */
  needsConfirmation: number;
  duplicate: number;
  invalid: number;
  /** 만들 수 있었지만 사용자가 뺀 후보 */
  excluded: number;
  /** 단서가 없어 후보를 만들지 않은 조합 */
  skipped: number;
}

export function summarizeTestDraftAnalysis(analysis: TestDraftAnalysis, excludedKeys: readonly string[] = []): TestDraftSummary {
  const excluded = new Set(excludedKeys);
  const creatable = analysis.rows.filter((row) => row.kind === 'create');
  const kept = creatable.filter((row) => !excluded.has(row.candidate.key));
  return {
    requirementCount: analysis.requirementCount,
    perspectiveCount: analysis.perspectiveCount,
    created: kept.length,
    needsConfirmation: kept.filter((row) => row.needsConfirmation).length,
    duplicate: analysis.rows.filter((row) => row.kind === 'duplicate').length,
    invalid: analysis.rows.filter((row) => row.kind === 'invalid').length,
    excluded: creatable.length - kept.length,
    skipped: analysis.skipped.length,
  };
}

/* ---------- 저장 계획 ---------- */

export interface TestDraftPlanOptions {
  createId: (prefix: string) => string;
  /** 새로 만드는 모든 항목의 시각 */
  now: string;
}

export interface TestDraftPlan {
  testConditions: TestCondition[];
  testCases: TestCase[];
  summary: TestDraftSummary;
  /** 새 테스트 조건 수와 다시 쓴 수 */
  conditionsCreated: number;
  conditionsReused: number;
}

/**
 * 만들 항목을 계산한다(저장하지 않는다). 지금 새로 만들 수 있는 후보 중 제외하지 않은 것만 만든다.
 * 제외 목록은 "사용자가 만들 수 있는 후보를 뺀 결정"만 담는다: 없는 후보 · 중복 · 오류 · 같은 key 두 번은 조용히 무시하지 않고 던진다.
 * 만들 후보가 하나도 없으면 던진다. 새 TC는 초안(draft) · revision 1이고 고객사 TC ID(externalId)는 만들지 않는다.
 * 출처는 사람이 직접 만든 것이 아니라 규칙 기반이므로 origin은 manual(AI가 아님)로 두고 근거 유형은 요구사항에서 물려받는다.
 */
export function planTestDraftGeneration(context: TestDraftContext, analysis: TestDraftAnalysis, excludedKeys: readonly string[], options: TestDraftPlanOptions): TestDraftPlan {
  const creatableKeys = new Set(analysis.rows.filter((row) => row.kind === 'create').map((row) => row.candidate.key));
  const seen = new Set<string>();
  for (const key of excludedKeys) {
    if (seen.has(key)) throw new TestDraftGenerationError(`같은 후보를 제외 목록에 두 번 넣었어요. (${key})`);
    seen.add(key);
    if (!creatableKeys.has(key)) throw new TestDraftGenerationError(`제외할 수 있는 TC 초안 후보가 아니에요. (${key})`);
  }
  const excluded = new Set(excludedKeys);
  const rows = analysis.rows.filter((row) => row.kind === 'create' && !excluded.has(row.candidate.key));
  if (rows.length === 0) throw new TestDraftGenerationError('만들 수 있는 새 TC 초안이 없어요.');

  const newConditions = new Map<string, TestCondition>();
  const testConditions: TestCondition[] = [];
  const testCases: TestCase[] = [];
  let conditionsReused = 0;
  for (const row of rows) {
    const { candidate } = row;
    let conditionId = row.reusedConditionId;
    if (conditionId) conditionsReused += 1;
    else {
      const identity = conditionIdentity(candidate.requirementIds, candidate.condition.feature, candidate.condition.title);
      let condition = newConditions.get(identity);
      if (!condition) {
        condition = {
          id: options.createId('cond'),
          projectId: context.project.id,
          requirementIds: [...candidate.requirementIds],
          feature: candidate.condition.feature,
          title: candidate.condition.title,
          // 확인 필요 요구사항의 조건은 정리가 끝나지 않았다.
          status: row.needsConfirmation ? 'needs_review' : 'active',
          createdAt: options.now,
          updatedAt: options.now,
        };
        newConditions.set(identity, condition);
        testConditions.push(condition);
      } else conditionsReused += 1;
      conditionId = condition.id;
    }
    testCases.push({
      id: options.createId('tc'),
      projectId: context.project.id,
      ...(context.project.tcTemplateId && { templateId: context.project.tcTemplateId }),
      // 고객사 TC ID는 Looma가 만들지 않는다.
      category: candidate.perspective,
      feature: candidate.testCase.feature,
      depth: [...candidate.testCase.depth],
      title: candidate.testCase.title,
      ...(candidate.testCase.precondition && { precondition: candidate.testCase.precondition }),
      steps: [...candidate.testCase.steps],
      expectedResult: candidate.testCase.expectedResult,
      requirementIds: [...candidate.requirementIds],
      testConditionIds: [conditionId],
      sourceRefs: structuredClone(row.sourceRefs),
      generationType: candidate.generationType,
      origin: 'manual',
      status: 'draft',
      revision: 1,
      createdAt: options.now,
      updatedAt: options.now,
    });
  }
  return { testConditions, testCases, summary: summarizeTestDraftAnalysis(analysis, excludedKeys), conditionsCreated: testConditions.length, conditionsReused };
}

/** 활동 기록 · 완료 안내에 쓰는 요약 문구 */
export const testDraftSummaryText = (plan: Pick<TestDraftPlan, 'summary' | 'conditionsCreated' | 'conditionsReused'>) =>
  `요구사항 ${plan.summary.requirementCount} · 관점 ${plan.summary.perspectiveCount} · 신규 TC ${plan.summary.created} · 테스트 조건 신규 ${plan.conditionsCreated} · 재사용 ${plan.conditionsReused} · 중복 ${plan.summary.duplicate} · 제외 ${plan.summary.excluded}`;
