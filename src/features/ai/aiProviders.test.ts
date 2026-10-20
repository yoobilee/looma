import { afterEach, describe, expect, it, vi } from 'vitest';
import { AI_ACCESS_CODE_HEADER, AI_TEST_DRAFT_ENDPOINT, type AiDraftItem } from '@/shared/aiTestDraftContract';
import {
  AiProviderError,
  createGroqProvider,
  createMockAiProvider,
  createOpenAiProvider,
  DEFAULT_AI_PROVIDER_ID,
  describeAiError,
  resolveAiProvider,
  selectableAiProviders,
  type AiClientErrorCode,
  type AiRequest,
} from './aiProviders';

const ACCESS_CODE = 'client-access-code-0123456789-abcdef';
const REQUEST: AiRequest = {
  perspectives: ['normal_flow'],
  requirements: [{ id: 'req-1', feature: '로그인', text: '이메일로 로그인할 수 있다.', needsConfirmation: false }],
};
const item = (overrides: Partial<AiDraftItem> = {}): AiDraftItem => ({
  requirementId: 'req-1',
  perspective: 'normal_flow',
  conditionTitle: '조건',
  title: '제목',
  precondition: null,
  steps: ['절차'],
  expectedResult: '결과',
  ...overrides,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.restoreAllMocks());

function groqWith(reply: () => Promise<Response>) {
  const fetchMock = vi.fn<typeof fetch>(() => reply());
  return { fetchMock, provider: createGroqProvider(() => fetchMock as unknown as typeof fetch) };
}
const failure = async (promise: Promise<unknown>) => (await promise.then(() => undefined, (error: unknown) => error)) as AiProviderError;

describe('Groq 공급자 (서버 함수 호출)', () => {
  it('접근 코드가 없으면 서버를 부르지 않는다', async () => {
    const { provider, fetchMock } = groqWith(() => Promise.resolve(json({})));
    expect((await failure(provider.generateTestDrafts(REQUEST, { accessCode: null }))).code).toBe('missing_access_code');
    expect((await failure(provider.generateTestDrafts(REQUEST, { accessCode: '' }))).code).toBe('missing_access_code');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('같은 출처의 서버 함수에 접근 코드를 헤더로만 보내고 요청 계약의 필드만 담는다', async () => {
    const { provider, fetchMock } = groqWith(() => Promise.resolve(json({ drafts: [item()], rejected: 0, model: 'openai/gpt-oss-120b' })));
    const response = await provider.generateTestDrafts(REQUEST, { accessCode: ACCESS_CODE });
    expect(response).toEqual({ drafts: [item()], rejected: 0, model: 'openai/gpt-oss-120b' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(AI_TEST_DRAFT_ENDPOINT);
    expect(url).not.toContain(ACCESS_CODE);
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', cache: 'no-store' });
    expect((init.headers as Record<string, string>)[AI_ACCESS_CODE_HEADER]).toBe(ACCESS_CODE);
    expect(init.body).not.toContain(ACCESS_CODE);
    expect(JSON.parse(init.body as string)).toEqual({ provider: 'groq', ...REQUEST });
  });

  it('응답을 다시 검증해 요청하지 않은 요구사항 · 관점의 초안과 알 수 없는 필드를 버린다', async () => {
    const { provider } = groqWith(() =>
      Promise.resolve(json({ drafts: [item(), item({ requirementId: 'req-other' }), { ...item({ perspective: 'api' }) }], rejected: 1, model: 'm', apiKey: 'leak' })),
    );
    // 요구사항 1개 × 관점 1개이므로 초안은 최대 1건이다. 3건이 오면 응답 전체를 믿지 않는다.
    expect((await failure(provider.generateTestDrafts(REQUEST, { accessCode: ACCESS_CODE }))).code).toBe('invalid_response');
    const two = groqWith(() => Promise.resolve(json({ drafts: [item({ requirementId: 'req-other' })], rejected: 1, model: 'm', apiKey: 'leak' })));
    const response = await two.provider.generateTestDrafts(REQUEST, { accessCode: ACCESS_CODE });
    expect(response.drafts).toEqual([]);
    expect(response.rejected).toBe(2);
    expect(response).not.toHaveProperty('apiKey');
  });

  it.each<[string, () => Promise<Response>, AiClientErrorCode]>([
    ['접근 코드 오류', () => Promise.resolve(json({ error: { code: 'unauthorized' } }, 401)), 'unauthorized'],
    ['서버 설정 없음', () => Promise.resolve(json({ error: { code: 'not_configured' } }, 503)), 'not_configured'],
    ['사용량 제한', () => Promise.resolve(json({ error: { code: 'rate_limited', retryAfterSeconds: 12 } }, 429)), 'rate_limited'],
    ['동시 실행', () => Promise.resolve(json({ error: { code: 'busy', retryAfterSeconds: 5 } }, 429)), 'busy'],
    ['시간 초과', () => Promise.resolve(json({ error: { code: 'timeout' } }, 504)), 'timeout'],
    ['AI 서비스 오류', () => Promise.resolve(json({ error: { code: 'upstream_error' } }, 502)), 'upstream_error'],
    ['AI 응답 형식 오류', () => Promise.resolve(json({ error: { code: 'invalid_response' } }, 502)), 'invalid_response'],
    ['공급자 비활성', () => Promise.resolve(json({ error: { code: 'provider_disabled' } }, 403)), 'provider_disabled'],
    ['알 수 없는 오류 분류', () => Promise.resolve(json({ error: { code: 'something_else' } }, 500)), 'upstream_error'],
    ['오류 본문 없음', () => Promise.resolve(json({}, 500)), 'upstream_error'],
    ['서버 함수 없음(개발 서버의 HTML 응답)', () => Promise.resolve(new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } })), 'unavailable'],
    ['서버 함수 없음(404)', () => Promise.resolve(new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } })), 'unavailable'],
    ['깨진 JSON 본문', () => Promise.resolve(new Response('{broken', { status: 200, headers: { 'content-type': 'application/json' } })), 'invalid_response'],
    ['응답 스키마 위반', () => Promise.resolve(json({ drafts: 'nope' })), 'invalid_response'],
    ['네트워크 오류', () => Promise.reject(new TypeError('Failed to fetch')), 'network'],
    ['시간 초과(브라우저)', () => Promise.reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), 'timeout'],
  ])('%s → %s', async (_name, reply, code) => {
    const { provider, fetchMock } = groqWith(reply);
    const error = await failure(provider.generateTestDrafts(REQUEST, { accessCode: ACCESS_CODE }));
    expect(error).toBeInstanceOf(AiProviderError);
    expect(error.code).toBe(code);
    // 자동 재시도 없음
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('429는 다시 시도할 초를 문구에 담고 유료로 넘어가지 않는다고 알린다', async () => {
    const { provider } = groqWith(() => Promise.resolve(json({ error: { code: 'rate_limited', retryAfterSeconds: 12 } }, 429)));
    const error = await failure(provider.generateTestDrafts(REQUEST, { accessCode: ACCESS_CODE }));
    expect(error.retryAfterSeconds).toBe(12);
    expect(describeAiError(error)).toContain('12초');
    expect(describeAiError(error)).toContain('유료 AI로 자동 전환하지 않아요');
  });

  it('사용자가 취소하면 aborted다', async () => {
    const controller = new AbortController();
    const { provider } = groqWith(() => {
      controller.abort();
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });
    expect((await failure(provider.generateTestDrafts(REQUEST, { accessCode: ACCESS_CODE, signal: controller.signal }))).code).toBe('aborted');
  });

  it('어떤 오류 문구에도 접근 코드가 들어가지 않는다', () => {
    const codes: AiClientErrorCode[] = [
      'missing_access_code', 'unauthorized', 'not_configured', 'provider_disabled', 'invalid_request', 'payload_too_large', 'unsupported_media_type', 'method_not_allowed',
      'rate_limited', 'busy', 'timeout', 'upstream_error', 'invalid_response', 'output_too_long', 'server_error', 'unavailable', 'network', 'aborted',
    ];
    for (const code of codes) expect(describeAiError(new AiProviderError(code, 5))).not.toContain(ACCESS_CODE);
    expect(describeAiError(new Error(`내부 ${ACCESS_CODE}`))).toBe('AI 초안을 만들지 못했어요.');
  });
});

describe('OpenAI 공급자 (비활성)', () => {
  it('사용할 수 없고 호출하면 네트워크를 쓰지 않고 거부한다', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const openai = createOpenAiProvider();
    expect(openai).toMatchObject({ id: 'openai', tier: 'paid', available: false });
    expect((await failure(openai.generateTestDrafts(REQUEST, { accessCode: ACCESS_CODE }))).code).toBe('provider_disabled');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('설정 목록에서 무료 Groq가 먼저이고 기본값이며 OpenAI는 사용할 수 없다', () => {
    expect(DEFAULT_AI_PROVIDER_ID).toBe('groq');
    expect(selectableAiProviders.map((provider) => [provider.id, provider.tier, provider.available])).toEqual([
      ['groq', 'free', true],
      ['openai', 'paid', false],
    ]);
    expect(selectableAiProviders[0].name).toBe('Groq · GPT-OSS 120B');
  });

  it('저장된 값이 openai · 알 수 없는 값 · 없음이어도 유료로 해석되지 않고 무료 기본값이 된다', () => {
    for (const stored of ['openai', 'OpenAI', 'mock', 'anthropic', '', null, undefined]) expect(resolveAiProvider(stored).id).toBe('groq');
    expect(resolveAiProvider('groq').id).toBe('groq');
  });

  it('유료 공급자를 열어도(가정) 사용자가 고르지 않으면 쓰이지 않는다 — 무료가 실패해도 자동 전환은 없다', async () => {
    const opened = { ...createOpenAiProvider(), available: true };
    const openaiCalls = vi.fn();
    opened.generateTestDrafts = () => (openaiCalls(), Promise.resolve({ drafts: [], rejected: 0, model: 'paid' }));
    const providers = [createGroqProvider(() => (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch), opened];
    // 저장된 선택이 없거나 groq면 groq이고, groq가 실패해도 openai를 부르지 않는다.
    for (const stored of [null, 'groq']) {
      const chosen = resolveAiProvider(stored, providers);
      expect(chosen.id).toBe('groq');
      expect((await failure(chosen.generateTestDrafts(REQUEST, { accessCode: ACCESS_CODE }))).code).toBe('network');
    }
    expect(openaiCalls).not.toHaveBeenCalled();
    // 사용자가 openai를 직접 골랐을 때만 openai다.
    expect(resolveAiProvider('openai', providers).id).toBe('openai');
  });

  it('Groq 공급자는 OpenAI 주소를 포함해 서버 함수 외의 주소로는 요청하지 않는다', async () => {
    const { provider, fetchMock } = groqWith(() => Promise.resolve(json({ error: { code: 'rate_limited' } }, 429)));
    await failure(provider.generateTestDrafts(REQUEST, { accessCode: ACCESS_CODE }));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([AI_TEST_DRAFT_ENDPOINT]);
  });
});

describe('Mock 공급자', () => {
  it('네트워크 없이 요청한 모든 조합에 같은 초안을 만든다', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const mock = createMockAiProvider();
    const request: AiRequest = { perspectives: ['normal_flow', 'exception'], requirements: [...REQUEST.requirements, { id: 'req-2', feature: '기능', text: '문장', needsConfirmation: true }] };
    const first = await mock.generateTestDrafts(request, { accessCode: null });
    expect(first.drafts.map((draft) => `${draft.requirementId}|${draft.perspective}`)).toEqual(['req-1|normal_flow', 'req-1|exception', 'req-2|normal_flow', 'req-2|exception']);
    expect(first.drafts.find((draft) => draft.requirementId === 'req-2')!.expectedResult).toMatch(/^확인 필요 — /);
    expect(await mock.generateTestDrafts(request, { accessCode: null })).toEqual(first);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
