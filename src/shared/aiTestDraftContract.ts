/*
 * AI TC 초안 요청 · 응답 계약. 브라우저(src)와 서버 함수(api)가 같은 한도와 같은 검증을 쓰도록 import가 없는 순수 파일로 둔다.
 *
 * 보내는 데이터는 이 파일에 적힌 필드가 전부다(요구사항 ID · 기능 · 문장 · 확인 필요 여부 + 테스트 관점).
 * 산출물 파일 · 근거 위치 · 기존 TC · 다른 프로젝트 데이터는 계약에 없으므로 보낼 수도 없다. 알 수 없는 필드가 있는 요청은 거부한다.
 * 응답은 믿지 않고 모든 필드를 다시 검증한다. 요청에 없던 요구사항 ID · 관점은 버린다.
 */

export const AI_TEST_DRAFT_ENDPOINT = '/api/ai/test-drafts';
export const AI_ACCESS_CODE_HEADER = 'x-looma-access-code';

export const AI_PROVIDER_IDS = ['groq', 'openai'] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

export const AI_PERSPECTIVES = ['normal_flow', 'exception', 'boundary', 'permission', 'state_change', 'data_io', 'api', 'performance', 'compatibility'] as const;
export type AiPerspective = (typeof AI_PERSPECTIVES)[number];

/*
 * 한 번에 보낼 수 있는 양. Groq 무료 한도(openai/gpt-oss-120b: 분당 8K 토큰)에 맞춘 작은 배치다.
 * 요구사항 5개 × 관점 3개 = 최대 15건 초안, 출력 상한 4,000토큰이면 입력과 합쳐도 분당 한도 안에 들어간다.
 */
export const AI_LIMITS = {
  maxRequirements: 5,
  maxPerspectives: 3,
  maxDrafts: 15,
  maxRequestBytes: 16 * 1024,
  maxOutputTokens: 4000,
  /** 서버가 Groq 응답을 기다리는 시간 */
  upstreamTimeoutMs: 20_000,
  /** 브라우저가 서버 응답을 기다리는 시간. 서버 대기 시간보다 길어야 서버가 보낸 오류를 받을 수 있다. */
  clientTimeoutMs: 30_000,
  maxRequirementIdLength: 64,
  maxFeatureLength: 200,
  maxRequirementTextLength: 1000,
  maxConditionTitleLength: 200,
  maxTitleLength: 200,
  maxPreconditionLength: 300,
  maxStepLength: 300,
  maxSteps: 10,
  maxExpectedResultLength: 500,
} as const;

/** 서버 함수의 호출 제한. 서버리스 인스턴스마다 따로 세므로 전체 사용량의 상한이 아니다(README의 "AI 초안" 참고). */
export const AI_SERVER_LIMITS = {
  /** 접근 코드 실패를 같은 접속자에서 이 횟수까지 받고, 그 뒤에는 코드를 비교하지 않고 거부한다. */
  maxFailedAttempts: 10,
  /** 접속자를 가리지 않고 서버 전체에서 받는 실패 횟수. 접속자 구분 헤더를 바꿔 가며 시도해도 이 상한에 닿는다. */
  maxFailedAttemptsAnyClient: 60,
  failedAttemptWindowMs: 60_000,
  maxRequestsPerWindow: 6,
  requestWindowMs: 60_000,
  maxConcurrentRequests: 1,
} as const;

export const MIN_ACCESS_CODE_LENGTH = 24;

export type AiErrorCode =
  | 'unauthorized'
  | 'not_configured'
  | 'provider_disabled'
  | 'invalid_request'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'method_not_allowed'
  | 'rate_limited'
  | 'busy'
  | 'timeout'
  | 'upstream_error'
  | 'invalid_response'
  | 'output_too_long'
  | 'server_error';

export interface AiDraftRequirement {
  id: string;
  feature: string;
  text: string;
  needsConfirmation: boolean;
}

export interface AiDraftRequest {
  provider: AiProviderId;
  perspectives: AiPerspective[];
  requirements: AiDraftRequirement[];
}

/** AI가 만든 TC 초안 하나. 요구사항 하나와 관점 하나에서 나온다. 근거 위치 · 기능명은 담지 않는다(요구사항에서 가져온다). */
export interface AiDraftItem {
  requirementId: string;
  perspective: AiPerspective;
  conditionTitle: string;
  title: string;
  precondition: string | null;
  steps: string[];
  expectedResult: string;
}

export interface AiDraftResponse {
  drafts: AiDraftItem[];
  /** 검증을 통과하지 못해 버린 초안 수 */
  rejected: number;
  model: string;
}

/** 계약을 어긴 값. 메시지에는 입력 내용을 넣지 않는다. */
export class AiContractError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));
// 제어 문자(줄바꿈 포함)는 공백으로 합친 뒤에도 남아 있으면 거부한다.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** 공백을 정리한 문자열. 문자열이 아니거나 비었거나 제어 문자가 있거나 한도를 넘으면 undefined(자르지 않는다). */
function cleanText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (text.length === 0 || text.length > maxLength || CONTROL_CHARACTERS.test(text)) return undefined;
  return text;
}

export function isAiPerspective(value: unknown): value is AiPerspective {
  return typeof value === 'string' && (AI_PERSPECTIVES as readonly string[]).includes(value);
}

/** 서버가 받은 요청을 검증한다. 알 수 없는 필드 · 한도 초과 · 중복은 모두 거부한다. */
export function parseAiDraftRequest(raw: unknown): AiDraftRequest {
  if (!isRecord(raw) || !hasOnlyKeys(raw, ['provider', 'perspectives', 'requirements'])) throw new AiContractError('요청 형식이 맞지 않아요.');
  if (typeof raw.provider !== 'string' || !(AI_PROVIDER_IDS as readonly string[]).includes(raw.provider)) throw new AiContractError('알 수 없는 AI 공급자예요.');
  if (!Array.isArray(raw.perspectives) || raw.perspectives.length === 0 || raw.perspectives.length > AI_LIMITS.maxPerspectives) {
    throw new AiContractError(`테스트 관점은 1~${AI_LIMITS.maxPerspectives}개여야 해요.`);
  }
  const perspectives = raw.perspectives.map((item) => {
    if (!isAiPerspective(item)) throw new AiContractError('알 수 없는 테스트 관점이에요.');
    return item;
  });
  if (new Set(perspectives).size !== perspectives.length) throw new AiContractError('같은 테스트 관점이 두 번 있어요.');
  if (!Array.isArray(raw.requirements) || raw.requirements.length === 0 || raw.requirements.length > AI_LIMITS.maxRequirements) {
    throw new AiContractError(`요구사항은 1~${AI_LIMITS.maxRequirements}개여야 해요.`);
  }
  const requirements = raw.requirements.map((item): AiDraftRequirement => {
    if (!isRecord(item) || !hasOnlyKeys(item, ['id', 'feature', 'text', 'needsConfirmation'])) throw new AiContractError('요구사항 형식이 맞지 않아요.');
    const id = cleanText(item.id, AI_LIMITS.maxRequirementIdLength);
    const feature = cleanText(item.feature, AI_LIMITS.maxFeatureLength);
    const text = cleanText(item.text, AI_LIMITS.maxRequirementTextLength);
    if (id === undefined || feature === undefined || text === undefined || typeof item.needsConfirmation !== 'boolean') {
      throw new AiContractError('요구사항 값이 비었거나 너무 길어요.');
    }
    return { id, feature, text, needsConfirmation: item.needsConfirmation };
  });
  if (new Set(requirements.map((item) => item.id)).size !== requirements.length) throw new AiContractError('같은 요구사항이 두 번 있어요.');
  return { provider: raw.provider as AiProviderId, perspectives, requirements };
}

export interface AllowedAiDrafts {
  requirementIds: readonly string[];
  perspectives: readonly string[];
}

/**
 * AI가 만든 초안 목록을 검증한다. 목록이 배열이 아니거나 한도보다 많으면 던진다(응답 전체를 믿을 수 없다).
 * 초안 하나가 어긋나면(요청에 없는 요구사항 ID · 관점, 같은 조합의 두 번째, 형식 · 길이 위반) 그것만 버리고 개수를 센다.
 */
export function parseAiDraftItems(raw: unknown, allowed: AllowedAiDrafts): { drafts: AiDraftItem[]; rejected: number } {
  if (!Array.isArray(raw)) throw new AiContractError('AI 응답 형식이 맞지 않아요.');
  if (raw.length > Math.min(AI_LIMITS.maxDrafts, allowed.requirementIds.length * allowed.perspectives.length)) throw new AiContractError('AI 응답에 초안이 너무 많아요.');
  const drafts: AiDraftItem[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const item of raw) {
    const draft = parseAiDraftItem(item, allowed);
    const identity = draft ? `${draft.requirementId}\u0000${draft.perspective}` : undefined;
    if (!draft || identity === undefined || seen.has(identity)) {
      rejected += 1;
      continue;
    }
    seen.add(identity);
    drafts.push(draft);
  }
  return { drafts, rejected };
}

/** AI가 요구사항으로 확정되지 않은 기대 결과를 밝힐 때 expectedResult 앞에 쓰는 표시. 규칙 기반 초안과 분석 단계가 쓰는 표시와 같다. */
export const AI_CONFIRMATION_MARK = '확인 필요';

/** 기대 결과가 확인 필요로 시작하는지. */
export const isConfirmationExpectedResult = (expectedResult: string) => expectedResult.startsWith(AI_CONFIRMATION_MARK);

/** 확인 필요 표시만 있고 무엇을 확인해야 하는지 없는 기대 결과인지. 사용자가 판단할 수 있는 내용이 없다. */
const isBareConfirmationMark = (expectedResult: string) =>
  isConfirmationExpectedResult(expectedResult) && expectedResult.slice(AI_CONFIRMATION_MARK.length).replace(/^[\s—–-]+/, '').length === 0;

function parseAiDraftItem(item: unknown, allowed: AllowedAiDrafts): AiDraftItem | undefined {
  if (!isRecord(item)) return undefined;
  const { requirementId, perspective } = item;
  if (typeof requirementId !== 'string' || !allowed.requirementIds.includes(requirementId)) return undefined;
  if (!isAiPerspective(perspective) || !allowed.perspectives.includes(perspective)) return undefined;
  const conditionTitle = cleanText(item.conditionTitle, AI_LIMITS.maxConditionTitleLength);
  const title = cleanText(item.title, AI_LIMITS.maxTitleLength);
  const expectedResult = cleanText(item.expectedResult, AI_LIMITS.maxExpectedResultLength);
  const precondition = item.precondition === null || item.precondition === undefined ? null : cleanText(item.precondition, AI_LIMITS.maxPreconditionLength);
  if (conditionTitle === undefined || title === undefined || expectedResult === undefined || precondition === undefined) return undefined;
  if (isBareConfirmationMark(expectedResult)) return undefined;
  if (!Array.isArray(item.steps) || item.steps.length === 0 || item.steps.length > AI_LIMITS.maxSteps) return undefined;
  const steps = item.steps.map((step) => cleanText(step, AI_LIMITS.maxStepLength));
  if (steps.some((step) => step === undefined)) return undefined;
  return { requirementId, perspective, conditionTitle, title, precondition, steps: steps as string[], expectedResult };
}

/** 브라우저가 서버에서 받은 응답을 검증한다. 서버가 이미 검증했어도 다시 확인한다. */
export function parseAiDraftResponse(raw: unknown, allowed: AllowedAiDrafts): AiDraftResponse {
  if (!isRecord(raw)) throw new AiContractError('AI 응답 형식이 맞지 않아요.');
  const { drafts, rejected } = parseAiDraftItems(raw.drafts, allowed);
  const model = cleanText(raw.model, 100);
  const serverRejected = typeof raw.rejected === 'number' && Number.isInteger(raw.rejected) && raw.rejected >= 0 && raw.rejected <= AI_LIMITS.maxDrafts ? raw.rejected : 0;
  if (model === undefined) throw new AiContractError('AI 응답 형식이 맞지 않아요.');
  return { drafts, rejected: rejected + serverRejected, model };
}
