import { testPerspectiveLabel } from './labels';
import { testDraftCandidateKey, validateRequest, type SkippedTestDraft, type TestDraftCandidate, type TestDraftContext, type TestDraftRequest } from './testDraftGeneration';
import type { TestPerspective } from './types';
import { isConfirmationExpectedResult, type AiDraftItem, type AiDraftRequest, type AiPerspective } from '@/shared/aiTestDraftContract';

/*
 * AI가 만든 TC 초안을 기존 후보 형식(TestDraftCandidate)으로 바꾼다.
 *
 *   요구사항 + 관점 ─ buildAiDraftRequest ─▶ 외부 AI ─▶ AiDraftItem[] ─ buildAiTestDraftCandidates ─▶ TestDraftCandidate[] ─ analyzeTestDraftCandidates ─▶ 검토 ─▶ 명시적 적용
 *
 * AI 응답은 후보일 뿐이다. 이 모듈은 저장하지 않고, AI가 보낸 값 중 제목 · 절차 · 기대 결과 같은 초안 내용만 쓴다.
 * 요구사항 연결 · 기능명 · 근거 위치 · 근거 유형은 저장된 요구사항에서 가져오며(AI가 정하지 않는다), 근거 유형은 분석 단계가 한 번 더 요구사항 기준으로 올린다.
 * 요청하지 않은 요구사항 · 관점의 초안은 이 단계에서 버리고, AI가 만들지 않은 조합은 "건너뜀"으로 남긴다.
 */

// 계약의 관점 목록과 도메인의 관점 목록이 어긋나면 컴파일이 실패한다.
type Assert<T extends true> = T;
export type PerspectivesMatch = Assert<[AiPerspective] extends [TestPerspective] ? ([TestPerspective] extends [AiPerspective] ? true : false) : false>;

export const AI_DRAFT_OUTDATED_MESSAGE = '요구사항이 바뀌어 AI 초안이 맞지 않아요. AI 초안을 다시 만들거나 규칙 기반 초안으로 돌아가 주세요.';

/** 외부 AI로 보낼 내용. 고른 요구사항의 ID · 기능 · 문장 · 확인 필요 여부와 관점뿐이다. 고른 순서를 지킨다. */
export function buildAiDraftRequest(context: TestDraftContext, request: TestDraftRequest): Omit<AiDraftRequest, 'provider'> {
  const requirements = validateRequest(context, request);
  return {
    perspectives: [...request.perspectives],
    requirements: requirements.map((item) => ({ id: item.id, feature: item.feature, text: item.text, needsConfirmation: item.needsConfirmation || item.sourceType === 'needs_confirmation' })),
  };
}

/** AI가 본 입력이 같은지 비교하는 값. 요구사항 문장 · 기능 · 확인 필요가 바뀌면 달라져서 그 요구사항으로 만든 AI 초안을 쓸 수 없다. */
export const aiDraftBasis = (request: Omit<AiDraftRequest, 'provider'>) => JSON.stringify([request.perspectives, request.requirements.map((item) => [item.id, item.feature, item.text, item.needsConfirmation])]);

export interface AiTestDraftCandidates {
  candidates: TestDraftCandidate[];
  skipped: SkippedTestDraft[];
}

/**
 * AI 초안을 후보로 바꾼다. 순서는 요구사항 순서 → 관점 순서로 고정한다(AI가 보낸 순서를 따르지 않는다).
 * 요청에 없는 요구사항 · 관점이거나 같은 조합이 두 번이면 던진다 — 호출하는 쪽이 먼저 검증한 값이어야 한다.
 */
export function buildAiTestDraftCandidates(context: TestDraftContext, request: TestDraftRequest, drafts: readonly AiDraftItem[]): AiTestDraftCandidates {
  const requirements = validateRequest(context, request);
  const byPair = new Map<string, AiDraftItem>();
  for (const draft of drafts) {
    const identity = `${draft.requirementId}\u0000${draft.perspective}`;
    if (byPair.has(identity) || !request.requirementIds.includes(draft.requirementId) || !(request.perspectives as string[]).includes(draft.perspective)) {
      throw new Error('요청하지 않은 조합이거나 중복된 AI 초안이에요.');
    }
    byPair.set(identity, draft);
  }

  const candidates: TestDraftCandidate[] = [];
  const skipped: SkippedTestDraft[] = [];
  for (const requirement of requirements) {
    for (const perspective of request.perspectives) {
      const draft = byPair.get(`${requirement.id}\u0000${perspective}`);
      if (!draft) {
        skipped.push({ requirementId: requirement.id, perspective, reason: `AI가 ${testPerspectiveLabel[perspective]} 초안을 만들지 않았어요.` });
        continue;
      }
      candidates.push({
        key: testDraftCandidateKey(perspective, [requirement.id]),
        perspective,
        requirementIds: [requirement.id],
        // 최소한 AI 제안이다. AI가 기대 결과를 확인 필요로 밝혔으면 확인 필요로 두어 검토 완료로 표시할 수 없게 한다(키워드로 근거를 판정하지 않고 AI가 밝힌 표시만 따른다).
        // 요구사항이 확인 필요인 경우는 분석 단계가 요구사항 기준으로 확인 필요로 올린다.
        generationType: isConfirmationExpectedResult(draft.expectedResult) ? 'needs_confirmation' : 'ai_suggestion',
        origin: 'ai_generated',
        condition: { feature: requirement.feature, title: draft.conditionTitle },
        testCase: {
          feature: requirement.feature,
          depth: [requirement.feature, testPerspectiveLabel[perspective]],
          title: draft.title,
          ...(draft.precondition && { precondition: draft.precondition }),
          steps: [...draft.steps],
          expectedResult: draft.expectedResult,
        },
      });
    }
  }
  return { candidates, skipped };
}
