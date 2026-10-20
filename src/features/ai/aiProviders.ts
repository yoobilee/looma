import {
  AI_ACCESS_CODE_HEADER,
  AI_LIMITS,
  AI_TEST_DRAFT_ENDPOINT,
  AiContractError,
  parseAiDraftResponse,
  type AiDraftItem,
  type AiDraftRequest,
  type AiDraftResponse,
  type AiErrorCode,
  type AiProviderId,
} from '@/shared/aiTestDraftContract';

/*
 * AI 공급자. 모든 공급자는 같은 요청(AiDraftRequest 중 공급자를 뺀 부분)을 받아 같은 응답(AiDraftResponse)을 돌려준다.
 * 응답은 후보일 뿐이고, 저장은 사용자가 검토한 뒤 명시적으로 적용할 때만 한다.
 *
 * - groq: 무료 기본값. 같은 출처의 서버 함수(/api/ai/test-drafts)를 부른다. API 키는 서버에만 있다.
 * - openai: 유료. 지금은 사용할 수 없다(available: false). 서버 함수에 OpenAI 경로가 없고 이 클래스는 네트워크를 부르지 않는다.
 *   켜려면 서버 함수에 OpenAI 호출을 구현하고 OPENAI_API_KEY를 등록한 뒤 이 공급자를 열어야 한다(README "AI 초안" 참고).
 * - mock: 네트워크 없이 같은 입력에 같은 초안을 돌려준다. 테스트 · 화면 확인용이며 설정 화면에는 나오지 않는다.
 * 공급자를 자동으로 바꾸지 않는다: 오류가 나도 다른 공급자(특히 유료)로 다시 시도하지 않는다.
 */

export type AiProviderKey = AiProviderId | 'mock';
export type AiRequest = Omit<AiDraftRequest, 'provider'>;

export interface AiGenerateOptions {
  /** 서버 함수 접근 코드(sessionStorage). 로그 · URL · 오류 메시지에 넣지 않는다. */
  accessCode: string | null;
  signal?: AbortSignal;
}

export interface AiProvider {
  id: AiProviderKey;
  /** 화면에 보이는 이름. 예: "Groq · GPT-OSS 120B" */
  name: string;
  tier: 'free' | 'paid' | 'test';
  /** 지금 사용할 수 있는가. false면 선택할 수 없고 호출하지도 않는다. */
  available: boolean;
  unavailableReason?: string;
  generateTestDrafts(request: AiRequest, options: AiGenerateOptions): Promise<AiDraftResponse>;
}

export type AiClientErrorCode = AiErrorCode | 'missing_access_code' | 'unavailable' | 'network' | 'aborted';

export class AiProviderError extends Error {
  constructor(
    readonly code: AiClientErrorCode,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
  }
}

const allowedOf = (request: AiRequest) => ({ requirementIds: request.requirements.map((item) => item.id), perspectives: request.perspectives });

const knownServerCodes: readonly AiErrorCode[] = [
  'unauthorized', 'not_configured', 'provider_disabled', 'invalid_request', 'payload_too_large', 'unsupported_media_type', 'method_not_allowed',
  'rate_limited', 'busy', 'timeout', 'upstream_error', 'invalid_response', 'output_too_long', 'server_error',
];

/** 서버 오류 응답에서 분류와 다시 시도할 초를 읽는다. 서버가 보낸 문장은 쓰지 않는다. */
function readServerError(payload: unknown, status: number): AiProviderError {
  const error = (payload as { error?: { code?: unknown; retryAfterSeconds?: unknown } } | null | undefined)?.error;
  const code = typeof error?.code === 'string' && (knownServerCodes as readonly string[]).includes(error.code) ? (error.code as AiErrorCode) : undefined;
  if (!code) return new AiProviderError(status === 404 || status === 405 ? 'unavailable' : 'upstream_error');
  const seconds = typeof error?.retryAfterSeconds === 'number' && Number.isFinite(error.retryAfterSeconds) && error.retryAfterSeconds > 0 ? Math.ceil(error.retryAfterSeconds) : undefined;
  return new AiProviderError(code, seconds);
}

export function createGroqProvider(getFetch: () => typeof fetch = () => globalThis.fetch.bind(globalThis)): AiProvider {
  return {
    id: 'groq',
    name: 'Groq · GPT-OSS 120B',
    tier: 'free',
    available: true,
    async generateTestDrafts(request, { accessCode, signal }) {
      if (!accessCode) throw new AiProviderError('missing_access_code');
      const body: AiDraftRequest = { provider: 'groq', ...request };
      const timeout = AbortSignal.timeout(AI_LIMITS.clientTimeoutMs);
      let response: Response;
      try {
        response = await getFetch()(AI_TEST_DRAFT_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [AI_ACCESS_CODE_HEADER]: accessCode },
          body: JSON.stringify(body),
          credentials: 'omit',
          cache: 'no-store',
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (error) {
        if (signal?.aborted) throw new AiProviderError('aborted');
        if (error instanceof Error && error.name === 'TimeoutError') throw new AiProviderError('timeout');
        throw new AiProviderError('network');
      }
      const isJson = (response.headers.get('content-type') ?? '').toLowerCase().includes('json');
      // JSON이 아닌 응답은 서버 함수가 없는 환경(개발 서버의 index.html 등)이다.
      if (!isJson) throw new AiProviderError('unavailable');
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new AiProviderError(response.ok ? 'invalid_response' : 'upstream_error');
      }
      if (!response.ok) throw readServerError(payload, response.status);
      try {
        return parseAiDraftResponse(payload, allowedOf(request));
      } catch (error) {
        if (error instanceof AiContractError) throw new AiProviderError('invalid_response');
        throw error;
      }
    },
  };
}

/** 유료 공급자 자리. 호출할 수 없다. */
export function createOpenAiProvider(): AiProvider {
  return {
    id: 'openai',
    name: 'OpenAI',
    tier: 'paid',
    available: false,
    unavailableReason: '추후 활성화',
    generateTestDrafts: () => Promise.reject(new AiProviderError('provider_disabled')),
  };
}

/** 네트워크 없이 요청한 조합마다 정해진 초안을 만든다. 테스트 · 화면 확인용. */
export function createMockAiProvider(): AiProvider {
  return {
    id: 'mock',
    name: 'Mock AI',
    tier: 'test',
    available: true,
    generateTestDrafts: (request) => {
      const drafts: AiDraftItem[] = request.requirements.flatMap((requirement) =>
        request.perspectives.map((perspective) => ({
          requirementId: requirement.id,
          perspective,
          conditionTitle: `[Mock] ${perspective} · ${requirement.text}`,
          title: `[Mock] ${requirement.text} · ${perspective} 확인`,
          precondition: null,
          steps: ['요구사항과 관련된 화면으로 이동한다.', '요구사항에 적힌 조건으로 동작을 수행한다.'],
          expectedResult: requirement.needsConfirmation ? '확인 필요 — 요구사항 확정 후 기대 결과를 정해요.' : '요구사항대로 동작한다.',
        })),
      );
      return Promise.resolve({ drafts, rejected: 0, model: 'mock' });
    },
  };
}

export const DEFAULT_AI_PROVIDER_ID: AiProviderId = 'groq';

/** 설정 화면에 나오는 공급자. 무료가 먼저다. */
export const selectableAiProviders: readonly AiProvider[] = [createGroqProvider(), createOpenAiProvider()];

/**
 * 저장된 선택값으로 공급자를 정한다. 알 수 없거나 사용할 수 없는 값(예: 아직 닫힌 OpenAI)이면 무료 기본값(Groq)으로 돌아간다.
 * 이 함수는 유료로 올리는 방향으로는 절대 바꾸지 않는다: 사용할 수 있는 공급자만 돌려주고, 못 쓰면 무료 기본값이다.
 */
export function resolveAiProvider(id: string | null | undefined, providers: readonly AiProvider[] = selectableAiProviders): AiProvider {
  const chosen = providers.find((item) => item.id === id && item.available);
  return chosen ?? providers.find((item) => item.id === DEFAULT_AI_PROVIDER_ID)!;
}

const messages: Record<AiClientErrorCode, string> = {
  missing_access_code: 'AI 접근 코드를 설정에서 먼저 입력해 주세요.',
  unauthorized: '접근 코드가 맞지 않아요. 설정에서 다시 입력해 주세요.',
  not_configured: '서버에 AI 설정이 아직 없어요. Vercel 환경변수 설정이 필요해요.',
  provider_disabled: '선택한 AI 공급자는 아직 사용할 수 없어요.',
  invalid_request: '보낼 내용이 한도를 넘었거나 형식이 맞지 않아요. 요구사항이나 관점을 줄여 주세요.',
  payload_too_large: '보낼 내용이 한도를 넘었어요. 요구사항이나 관점을 줄여 주세요.',
  unsupported_media_type: '요청 형식이 맞지 않아요.',
  method_not_allowed: '이 환경에서는 AI 서버 함수를 쓸 수 없어요.',
  rate_limited: '무료 사용량 한도에 도달했어요. 잠시 뒤에 다시 시도해 주세요. 유료 AI로 자동 전환하지 않아요.',
  busy: '다른 AI 요청을 처리하고 있어요. 잠시 뒤에 다시 시도해 주세요.',
  timeout: 'AI 응답이 늦어 중단했어요. 요구사항 수를 줄여 다시 시도해 주세요.',
  upstream_error: 'AI 서비스에 문제가 있어요. 잠시 뒤에 다시 시도해 주세요.',
  invalid_response: 'AI 응답 형식이 맞지 않아 쓰지 않았어요. 다시 시도해 주세요.',
  output_too_long: 'AI 응답이 길어 잘렸어요. 요구사항이나 관점을 줄여 다시 시도해 주세요.',
  server_error: 'AI 서버에서 알 수 없는 오류가 났어요.',
  unavailable: '이 환경에서는 AI 서버 함수를 쓸 수 없어요. 배포된 환경에서 사용해 주세요.',
  network: '네트워크 문제로 AI 서버에 연결하지 못했어요.',
  aborted: 'AI 요청을 취소했어요.',
};

/** 사용자에게 보이는 오류 문구. 서버가 보낸 문장이나 입력 내용은 쓰지 않는다. */
export function describeAiError(error: unknown): string {
  if (!(error instanceof AiProviderError)) return 'AI 초안을 만들지 못했어요.';
  if (error.code === 'rate_limited' && error.retryAfterSeconds !== undefined) {
    return `무료 사용량 한도에 도달했어요. ${error.retryAfterSeconds}초 뒤에 다시 시도해 주세요. 유료 AI로 자동 전환하지 않아요.`;
  }
  return messages[error.code];
}
