import {
  AI_ACCESS_CODE_HEADER,
  AI_LIMITS,
  AI_SERVER_LIMITS,
  AiContractError,
  parseAiDraftRequest,
  type AiErrorCode,
} from '../../src/shared/aiTestDraftContract.js';
import { accessCodeMatches, clientKey, ConcurrencyGate, configuredAccessCode, WindowCounter } from './accessControl.js';
import { requestGroqTestDrafts, UpstreamError } from './groqTestDrafts.js';

/*
 * POST /api/ai/test-drafts
 *
 * 처리 순서(앞 단계에서 거부하면 뒤 단계는 실행하지 않는다 — 특히 접근 코드를 통과하기 전에는 Groq를 부르지 않는다):
 *   방식 확인 → 서버 설정 확인(접근 코드 없음 = 전부 거부) → 실패 횟수 확인 → 접근 코드 확인 → 형식 · 크기 확인 →
 *   요청 검증(알 수 없는 필드 거부) → 공급자 확인(Groq만) → 호출 제한 · 동시 실행 제한 → Groq 호출(1회, 시간 제한)
 * 오류 응답에는 분류(code)와 다시 시도할 초만 담는다. 접근 코드 · 키 · 요청 내용은 응답과 로그에 넣지 않는다.
 * OpenAI는 이 함수가 호출하지 않는다. 공급자가 openai면 provider_disabled로 거부한다.
 */

export interface TestDraftHandlerDeps {
  env: Readonly<Record<string, string | undefined>>;
  fetch: typeof fetch;
  now: () => number;
  /** 테스트에서 줄일 수 있는 Groq 대기 시간 */
  upstreamTimeoutMs?: number;
}

const BASE_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } as const;

function respond(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8', ...extra } });
}

function failure(code: AiErrorCode, status: number, retryAfterSeconds?: number): Response {
  const extra: Record<string, string> = {};
  if (retryAfterSeconds !== undefined) extra['retry-after'] = String(retryAfterSeconds);
  if (code === 'method_not_allowed') extra.allow = 'POST';
  return respond({ error: { code, ...(retryAfterSeconds !== undefined && { retryAfterSeconds }) } }, status, extra);
}

/** 본문을 한도까지만 읽는다. 한도를 넘으면 읽기를 멈추고 undefined를 돌려준다. */
async function readLimitedText(request: Request, maxBytes: number): Promise<string | undefined> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return undefined;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** 호출 제한 · 동시 실행 제한 상태는 핸들러마다(= 서버리스 인스턴스마다) 따로 갖는다. */
export function createTestDraftHandler(deps: TestDraftHandlerDeps): (request: Request) => Promise<Response> {
  const failedAttempts = new WindowCounter(AI_SERVER_LIMITS.maxFailedAttempts, AI_SERVER_LIMITS.failedAttemptWindowMs);
  const requests = new WindowCounter(AI_SERVER_LIMITS.maxRequestsPerWindow, AI_SERVER_LIMITS.requestWindowMs, 1);
  const gate = new ConcurrencyGate(AI_SERVER_LIMITS.maxConcurrentRequests);

  return async (request) => {
    try {
      if (request.method !== 'POST') return failure('method_not_allowed', 405);

      const expectedCode = configuredAccessCode(deps.env.LOOMA_AI_ACCESS_CODE);
      if (expectedCode === undefined) return failure('not_configured', 503);

      const client = clientKey(request.headers);
      const blockedFor = failedAttempts.retryAfterSeconds(client, deps.now());
      if (blockedFor > 0) return failure('rate_limited', 429, blockedFor);
      if (!accessCodeMatches(expectedCode, request.headers.get(AI_ACCESS_CODE_HEADER))) {
        failedAttempts.record(client, deps.now());
        return failure('unauthorized', 401);
      }

      if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return failure('unsupported_media_type', 415);
      const bodyText = await readLimitedText(request, AI_LIMITS.maxRequestBytes);
      if (bodyText === undefined) return failure('payload_too_large', 413);

      let draftRequest;
      try {
        draftRequest = parseAiDraftRequest(JSON.parse(bodyText));
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof AiContractError) return failure('invalid_request', 400);
        throw error;
      }

      if (draftRequest.provider !== 'groq') return failure('provider_disabled', 403);
      const apiKey = deps.env.GROQ_API_KEY?.trim();
      if (!apiKey) return failure('not_configured', 503);

      const waitFor = requests.retryAfterSeconds('all', deps.now());
      if (waitFor > 0) return failure('rate_limited', 429, waitFor);
      if (!gate.tryEnter()) return failure('busy', 429, 5);
      try {
        requests.record('all', deps.now());
        const result = await requestGroqTestDrafts(draftRequest, { apiKey, fetch: deps.fetch, timeoutMs: deps.upstreamTimeoutMs ?? AI_LIMITS.upstreamTimeoutMs });
        return respond(result, 200);
      } finally {
        gate.leave();
      }
    } catch (error) {
      if (error instanceof UpstreamError) {
        if (error.code === 'timeout' || error.code === 'upstream_error' || error.code === 'invalid_response' || error.code === 'output_too_long' || error.code === 'rate_limited') {
          // 분류만 남긴다. 요청 · 응답 내용과 키는 남기지 않는다.
          console.error(`[ai/test-drafts] upstream ${error.code} (${error.status})`);
        }
        return failure(error.code, error.status, error.retryAfterSeconds);
      }
      console.error(`[ai/test-drafts] unexpected ${error instanceof Error ? error.name : 'error'}`);
      return failure('server_error', 500);
    }
  };
}
