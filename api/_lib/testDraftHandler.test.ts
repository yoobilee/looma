import { afterEach, describe, expect, it, vi } from 'vitest';
import { AI_ACCESS_CODE_HEADER, AI_LIMITS, AI_SERVER_LIMITS } from '../../src/shared/aiTestDraftContract.js';
import { accessCodeMatches, configuredAccessCode, WindowCounter } from './accessControl.js';
import { GROQ_ENDPOINT, GROQ_MODEL } from './groqTestDrafts.js';
import { createTestDraftHandler } from './testDraftHandler.js';

/*
 * 서버 함수 검증. Groq는 실제로 부르지 않고 fetch를 대신한다.
 * 접근 제어(없음 · 틀림 · 설정 누락), 입력 한도, 호출 제한, Groq 오류 변환, 키 · 접근 코드 · 요청 내용이 응답과 로그에 나가지 않는지를 본다.
 */

const ACCESS_CODE = 'test-access-code-0123456789-abcdefgh';
const GROQ_KEY = 'gsk_test_key_should_never_leak_0001';
const REQUIREMENT_TEXT = '비밀요구사항문장-이메일로 로그인할 수 있다.';
const ENV = { LOOMA_AI_ACCESS_CODE: ACCESS_CODE, GROQ_API_KEY: GROQ_KEY };

const validBody = () => ({
  provider: 'groq',
  perspectives: ['normal_flow'],
  requirements: [{ id: 'req-1', feature: '로그인', text: REQUIREMENT_TEXT, needsConfirmation: false }],
});

const draft = (overrides: Record<string, unknown> = {}) => ({
  requirementId: 'req-1',
  perspective: 'normal_flow',
  conditionTitle: '정상 흐름 · 로그인',
  title: '로그인 정상 확인',
  precondition: null,
  steps: ['로그인 화면으로 이동한다.', '로그인한다.'],
  expectedResult: '로그인된다.',
  ...overrides,
});

const groqReply = (drafts: unknown, finishReason = 'stop') =>
  new Response(JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content: typeof drafts === 'string' ? drafts : JSON.stringify({ drafts }) } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

interface CallOptions {
  code?: string | null;
  body?: unknown;
  raw?: string;
  method?: string;
  headers?: Record<string, string>;
}

function request({ code = ACCESS_CODE, body = validBody(), raw, method = 'POST', headers = {} }: CallOptions = {}) {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json', ...(code !== null && { [AI_ACCESS_CODE_HEADER]: code }), ...headers } };
  if (method !== 'GET') init.body = raw ?? JSON.stringify(body);
  return new Request('https://looma.test/api/ai/test-drafts', init);
}

function setup(env: Record<string, string | undefined> = ENV, fetchImpl?: (...args: Parameters<typeof fetch>) => Promise<Response>) {
  const clock = { now: 1_000_000 };
  const groq = vi.fn(fetchImpl ?? (() => Promise.resolve(groqReply([draft()]))));
  const handler = createTestDraftHandler({ env, fetch: groq as unknown as typeof fetch, now: () => clock.now, upstreamTimeoutMs: 50 });
  return { handler, groq, clock };
}

const bodyOf = async (response: Response) => (await response.json()) as { drafts: unknown[]; rejected: number };
const errorOf = async (response: Response) => ((await response.json()) as { error: { code: string; retryAfterSeconds?: number } }).error;

afterEach(() => vi.restoreAllMocks());

describe('정상 흐름', () => {
  it('접근 코드가 맞으면 Groq를 한 번 부르고 검증된 초안을 돌려준다', async () => {
    const { handler, groq } = setup();
    const response = await handler(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ drafts: [draft()], rejected: 0, model: GROQ_MODEL });
    expect(groq).toHaveBeenCalledTimes(1);
  });

  it('Groq에는 Structured Outputs(strict JSON Schema)와 한도를 담아 요청 계약의 필드만 보낸다', async () => {
    const { handler, groq } = setup();
    await handler(request());
    const [url, init] = groq.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(GROQ_ENDPOINT);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${GROQ_KEY}`);
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({
      model: GROQ_MODEL,
      max_completion_tokens: AI_LIMITS.maxOutputTokens,
      stream: false,
      response_format: { type: 'json_schema', json_schema: { strict: true } },
    });
    const schema = sent.response_format.json_schema.schema;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.drafts.items.additionalProperties).toBe(false);
    expect(schema.properties.drafts.items.required).toEqual(Object.keys(schema.properties.drafts.items.properties));
    // 요청한 요구사항 ID · 관점만 고를 수 있다.
    expect(schema.properties.drafts.items.properties.requirementId.enum).toEqual(['req-1']);
    expect(schema.properties.drafts.items.properties.perspective.enum).toEqual(['normal_flow']);
    expect(JSON.parse(sent.messages[1].content)).toEqual({ perspectives: ['normal_flow'], requirements: validBody().requirements });
  });

  it('요청하지 않은 요구사항 ID · 중복 조합 초안은 버리고 개수를 센다', async () => {
    const twoRequirements = {
      ...validBody(),
      requirements: [...validBody().requirements, { id: 'req-2', feature: '로그아웃', text: '로그아웃할 수 있다.', needsConfirmation: false }],
    };
    const unknown = setup(ENV, () => Promise.resolve(groqReply([draft(), draft({ requirementId: 'req-999' })])));
    const unknownBody = await bodyOf(await unknown.handler(request({ body: twoRequirements })));
    expect(unknownBody.drafts).toHaveLength(1);
    expect(unknownBody.rejected).toBe(1);
    const duplicate = setup(ENV, () => Promise.resolve(groqReply([draft(), draft({ title: '같은 조합' })])));
    const duplicateBody = await bodyOf(await duplicate.handler(request({ body: twoRequirements })));
    expect(duplicateBody.drafts).toHaveLength(1);
    expect(duplicateBody.rejected).toBe(1);
  });

  it('GET 등 POST가 아닌 요청은 거부하고 Groq를 부르지 않는다', async () => {
    const { handler, groq } = setup();
    const response = await handler(request({ method: 'GET' }));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(groq).not.toHaveBeenCalled();
  });
});

describe('접근 제어 (fail-closed)', () => {
  it.each([
    ['환경변수 없음', undefined],
    ['빈 값', ''],
    ['너무 짧은 값', 'short-code'],
  ])('서버에 접근 코드가 %s이면 맞는 코드를 보내도 거부하고 Groq를 부르지 않는다', async (_name, value) => {
    const { handler, groq } = setup({ ...ENV, LOOMA_AI_ACCESS_CODE: value });
    const response = await handler(request({ code: value ?? 'short-code' }));
    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe('not_configured');
    expect(groq).not.toHaveBeenCalled();
  });

  it.each([
    ['헤더 없음', null],
    ['빈 값', ''],
    ['틀린 값', 'wrong-access-code-0123456789-abcdefgh'],
    ['앞부분만 같은 값', ACCESS_CODE.slice(0, -1)],
    ['뒤에 더 붙은 값', `${ACCESS_CODE}x`],
  ])('접근 코드가 %s이면 401로 거부하고 Groq를 부르지 않는다', async (_name, code) => {
    const { handler, groq } = setup();
    const response = await handler(request({ code }));
    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe('unauthorized');
    expect(groq).not.toHaveBeenCalled();
  });

  it('인증에 실패한 요청은 본문을 읽거나 검증하기 전에 거부한다', async () => {
    const { handler, groq } = setup();
    const response = await handler(request({ code: 'wrong-access-code-0123456789-abcdefgh', raw: 'x'.repeat(AI_LIMITS.maxRequestBytes * 2) }));
    expect(response.status).toBe(401);
    expect(groq).not.toHaveBeenCalled();
  });

  it('GROQ_API_KEY가 없으면 인증을 통과해도 503이고 Groq를 부르지 않는다', async () => {
    const { handler, groq } = setup({ LOOMA_AI_ACCESS_CODE: ACCESS_CODE });
    const response = await handler(request());
    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe('not_configured');
    expect(groq).not.toHaveBeenCalled();
  });

  it('접근 코드를 반복해서 틀리면 맞는 코드도 잠시 거부한다 (창이 지나면 풀린다)', async () => {
    const { handler, groq, clock } = setup();
    for (let index = 0; index < AI_SERVER_LIMITS.maxFailedAttempts; index += 1) {
      expect((await handler(request({ code: 'wrong-access-code-0123456789-abcdefgh' }))).status).toBe(401);
    }
    const blocked = await handler(request());
    expect(blocked.status).toBe(429);
    expect((await errorOf(blocked)).retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.headers.get('retry-after')).not.toBeNull();
    expect(groq).not.toHaveBeenCalled();
    clock.now += AI_SERVER_LIMITS.failedAttemptWindowMs + 1;
    expect((await handler(request())).status).toBe(200);
  });

  it('다른 접속자의 실패는 내 요청을 막지 않는다', async () => {
    const { handler } = setup();
    for (let index = 0; index < AI_SERVER_LIMITS.maxFailedAttempts; index += 1) {
      await handler(request({ code: 'wrong-access-code-0123456789-abcdefgh', headers: { 'x-vercel-forwarded-for': '203.0.113.9' } }));
    }
    expect((await handler(request({ headers: { 'x-vercel-forwarded-for': '198.51.100.7' } }))).status).toBe(200);
  });

  it('접근 코드 비교는 앞뒤 공백만 무시하고 정확히 같을 때만 통과한다', () => {
    expect(accessCodeMatches(ACCESS_CODE, ACCESS_CODE)).toBe(true);
    expect(accessCodeMatches(ACCESS_CODE, ` ${ACCESS_CODE}\n`)).toBe(true);
    expect(accessCodeMatches(ACCESS_CODE, null)).toBe(false);
    expect(accessCodeMatches(ACCESS_CODE, undefined)).toBe(false);
    expect(accessCodeMatches(ACCESS_CODE, '')).toBe(false);
    expect(accessCodeMatches(ACCESS_CODE, ACCESS_CODE.toUpperCase())).toBe(false);
    expect(configuredAccessCode('short')).toBeUndefined();
    expect(configuredAccessCode(undefined)).toBeUndefined();
    expect(configuredAccessCode(`  ${ACCESS_CODE}  `)).toBe(ACCESS_CODE);
  });
});

describe('입력 한도와 비선택 데이터 차단', () => {
  const rejects = async (body: unknown, status = 400, code = 'invalid_request') => {
    const { handler, groq } = setup();
    const response = await handler(request({ body }));
    expect(response.status).toBe(status);
    expect((await errorOf(response)).code).toBe(code);
    expect(groq).not.toHaveBeenCalled();
  };
  const requirement = (id: string, overrides: Record<string, unknown> = {}) => ({ id, feature: '기능', text: '문장', needsConfirmation: false, ...overrides });

  it('요청 크기 한도를 넘으면 413이다 (본문 길이 선언 · 실제 본문 모두)', async () => {
    const { handler, groq } = setup();
    const declared = await handler(request({ headers: { 'content-length': String(AI_LIMITS.maxRequestBytes + 1) } }));
    expect(declared.status).toBe(413);
    const actual = await handler(request({ raw: JSON.stringify({ ...validBody(), padding: 'x'.repeat(AI_LIMITS.maxRequestBytes) }) }));
    expect(actual.status).toBe(413);
    expect((await errorOf(actual)).code).toBe('payload_too_large');
    expect(groq).not.toHaveBeenCalled();
  });

  it('JSON이 아닌 형식 · 깨진 JSON을 거부한다', async () => {
    const { handler, groq } = setup();
    expect((await handler(request({ headers: { 'content-type': 'text/plain' } }))).status).toBe(415);
    expect((await handler(request({ raw: '{not json' }))).status).toBe(400);
    expect(groq).not.toHaveBeenCalled();
  });

  it('요구사항 개수 · 관점 개수 한도를 넘으면 거부한다', async () => {
    const six = Array.from({ length: AI_LIMITS.maxRequirements + 1 }, (_, index) => requirement(`req-${index}`));
    await rejects({ ...validBody(), requirements: six });
    await rejects({ ...validBody(), perspectives: ['normal_flow', 'exception', 'boundary', 'permission'] });
    await rejects({ ...validBody(), requirements: [] });
    await rejects({ ...validBody(), perspectives: [] });
  });

  it('필드 길이 한도 · 중복 · 알 수 없는 관점을 거부한다', async () => {
    await rejects({ ...validBody(), requirements: [requirement('req-1', { text: 'x'.repeat(AI_LIMITS.maxRequirementTextLength + 1) })] });
    await rejects({ ...validBody(), requirements: [requirement('req-1'), requirement('req-1')] });
    await rejects({ ...validBody(), perspectives: ['normal_flow', 'normal_flow'] });
    await rejects({ ...validBody(), perspectives: ['made_up'] });
    await rejects({ ...validBody(), requirements: [requirement('req-1', { text: '  ' })] });
  });

  it('선택하지 않은 데이터(산출물 · 기존 TC · 근거 위치 · 다른 프로젝트)를 담은 요청은 통째로 거부한다', async () => {
    await rejects({ ...validBody(), testCases: [{ id: 'tc-1', title: '기존 TC' }] });
    await rejects({ ...validBody(), deliverables: [{ id: 'dlv-1' }] });
    await rejects({ ...validBody(), projectId: 'prj-other' });
    await rejects({ ...validBody(), requirements: [requirement('req-1', { sourceRefs: [{ deliverableId: 'dlv-1', locator: 'p.1' }] })] });
  });

  it('유료 공급자(openai)나 알 수 없는 공급자는 Groq도 OpenAI도 부르지 않고 거부한다', async () => {
    const { handler, groq } = setup();
    const openai = await handler(request({ body: { ...validBody(), provider: 'openai' } }));
    expect(openai.status).toBe(403);
    expect((await errorOf(openai)).code).toBe('provider_disabled');
    await rejects({ ...validBody(), provider: 'anthropic' });
    expect(groq).not.toHaveBeenCalled();
  });

  it('OpenAI 키가 환경변수에 있어도 OpenAI를 호출하지 않는다 (요청 대상은 항상 Groq)', async () => {
    const { handler, groq } = setup({ ...ENV, OPENAI_API_KEY: 'sk-test-openai' });
    await handler(request({ body: { ...validBody(), provider: 'openai' } }));
    await handler(request());
    expect(groq.mock.calls.map(([url]) => url)).toEqual([GROQ_ENDPOINT]);
  });
});

describe('Groq 오류 변환', () => {
  const failsWith = async (reply: (...args: Parameters<typeof fetch>) => Promise<Response>, status: number, code: string) => {
    const { handler, groq } = setup(ENV, reply);
    const response = await handler(request());
    expect(response.status).toBe(status);
    const error = await errorOf(response);
    expect(error.code).toBe(code);
    // 자동 재시도 없음
    expect(groq).toHaveBeenCalledTimes(1);
    return { response, error };
  };

  it('429는 rate_limited와 다시 시도할 초를 돌려준다', async () => {
    const { response, error } = await failsWith(() => Promise.resolve(new Response('{}', { status: 429, headers: { 'retry-after': '7' } })), 429, 'rate_limited');
    expect(response.headers.get('retry-after')).toBe('7');
    expect(error.retryAfterSeconds).toBe(7);
  });

  it('retry-after가 없거나 터무니없으면 기본값 · 상한을 쓴다', async () => {
    const none = await failsWith(() => Promise.resolve(new Response('{}', { status: 429 })), 429, 'rate_limited');
    expect(none.error.retryAfterSeconds).toBe(30);
    const huge = await failsWith(() => Promise.resolve(new Response('{}', { status: 429, headers: { 'retry-after': '999999' } })), 429, 'rate_limited');
    expect(huge.error.retryAfterSeconds).toBe(3600);
  });

  it('Groq 인증 오류 · 서버 오류는 upstream_error로만 알린다', async () => {
    await failsWith(() => Promise.resolve(new Response('{"error":{"message":"Invalid API Key gsk_secret"}}', { status: 401 })), 502, 'upstream_error');
    await failsWith(() => Promise.resolve(new Response('oops', { status: 503 })), 502, 'upstream_error');
  });

  it('네트워크 오류는 upstream_error다', async () => {
    await failsWith(() => Promise.reject(new TypeError('fetch failed')), 502, 'upstream_error');
  });

  it('시간 안에 끝나지 않으면 중단하고 timeout이다', async () => {
    await failsWith(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          (init?.signal as AbortSignal).addEventListener('abort', () => reject((init?.signal as AbortSignal).reason));
        }),
      504,
      'timeout',
    );
  });

  it('깨진 JSON · 스키마 위반 · 빈 응답은 invalid_response다', async () => {
    await failsWith(() => Promise.resolve(groqReply('{broken')), 502, 'invalid_response');
    await failsWith(() => Promise.resolve(groqReply('{"drafts":"not an array"}')), 502, 'invalid_response');
    await failsWith(() => Promise.resolve(groqReply('{}')), 502, 'invalid_response');
    await failsWith(() => Promise.resolve(new Response('not json', { status: 200 })), 502, 'invalid_response');
    await failsWith(() => Promise.resolve(new Response(JSON.stringify({ choices: [] }), { status: 200 })), 502, 'invalid_response');
  });

  it('요청 조합 수보다 많은 초안을 보내면 응답 전체를 믿지 않는다', async () => {
    await failsWith(() => Promise.resolve(groqReply([draft(), draft({ title: 'b' })])), 502, 'invalid_response');
  });

  it('출력 한도에서 잘린 응답은 output_too_long이다', async () => {
    await failsWith(() => Promise.resolve(groqReply('{"drafts":[', 'length')), 502, 'output_too_long');
  });

  it('형식이 어긋난 초안(빈 절차 · 긴 제목 · 제어 문자)은 그것만 버린다', async () => {
    const { handler } = setup(ENV, () => Promise.resolve(groqReply([draft({ steps: [] })])));
    expect((await bodyOf(await handler(request()))).rejected).toBe(1);
    const long = setup(ENV, () => Promise.resolve(groqReply([draft({ title: 'x'.repeat(AI_LIMITS.maxTitleLength + 1) })])));
    expect((await bodyOf(await long.handler(request()))).rejected).toBe(1);
    const control = setup(ENV, () => Promise.resolve(groqReply([draft({ title: 'a\u0000b' })])));
    expect((await bodyOf(await control.handler(request()))).rejected).toBe(1);
  });
});

describe('호출 제한', () => {
  it('동시에 둘 이상 실행하지 않는다 (두 번째는 busy, Groq는 한 번만 호출)', async () => {
    let release: (response: Response) => void = () => undefined;
    const { handler, groq } = setup(ENV, () => new Promise<Response>((resolve) => (release = resolve)));
    const first = handler(request());
    await vi.waitFor(() => expect(groq).toHaveBeenCalledTimes(1));
    const second = await handler(request());
    expect(second.status).toBe(429);
    expect((await errorOf(second)).code).toBe('busy');
    expect(groq).toHaveBeenCalledTimes(1);
    release(groqReply([draft()]));
    expect((await first).status).toBe(200);
  });

  it('실행이 끝나면 같은 인스턴스가 다시 받는다', async () => {
    let release: (response: Response) => void = () => undefined;
    const { handler, groq } = setup(ENV, () => new Promise<Response>((resolve) => (release = resolve)));
    const first = handler(request());
    await vi.waitFor(() => expect(groq).toHaveBeenCalledTimes(1));
    release(groqReply([draft()]));
    expect((await first).status).toBe(200);
    const second = handler(request());
    await vi.waitFor(() => expect(groq).toHaveBeenCalledTimes(2));
    release(groqReply([draft()]));
    expect((await second).status).toBe(200);
  });

  it('오류로 끝나도 동시 실행 자리를 돌려준다', async () => {
    const { handler, groq } = setup(ENV, () => Promise.reject(new TypeError('fail')));
    expect((await handler(request())).status).toBe(502);
    expect((await handler(request())).status).toBe(502);
    expect(groq).toHaveBeenCalledTimes(2);
  });

  it('창 안의 호출 수를 넘으면 rate_limited이고 창이 지나면 풀린다', async () => {
    const { handler, groq, clock } = setup();
    for (let index = 0; index < AI_SERVER_LIMITS.maxRequestsPerWindow; index += 1) expect((await handler(request())).status).toBe(200);
    const limited = await handler(request());
    expect(limited.status).toBe(429);
    expect((await errorOf(limited)).code).toBe('rate_limited');
    expect(groq).toHaveBeenCalledTimes(AI_SERVER_LIMITS.maxRequestsPerWindow);
    clock.now += AI_SERVER_LIMITS.requestWindowMs + 1;
    expect((await handler(request())).status).toBe(200);
  });

  it('검증에 실패한 요청은 호출 한도를 쓰지 않는다', async () => {
    const { handler } = setup();
    for (let index = 0; index < AI_SERVER_LIMITS.maxRequestsPerWindow + 2; index += 1) expect((await handler(request({ raw: '{bad' }))).status).toBe(400);
    expect((await handler(request())).status).toBe(200);
  });

  it('WindowCounter는 키가 너무 많아지면 한도에 닿지 않은 오래된 키부터 버린다', () => {
    const counter = new WindowCounter(2, 1000, 2);
    counter.record('a', 0);
    counter.record('b', 0);
    counter.record('b', 0);
    counter.record('c', 0);
    // a는 한도에 닿지 않아 버려지고, 한도에 닿은 b는 남는다. (차단 중인 키를 지키는 동작은 reviewHardening.test.ts에서 확인)
    expect(counter.retryAfterSeconds('a', 1)).toBe(0);
    expect(counter.retryAfterSeconds('b', 1)).toBe(1);
  });
});

describe('키 · 접근 코드 · 요청 내용 노출 방지', () => {
  it('성공 · 실패 어느 응답에도 키 · 접근 코드 · 요구사항 문장이 되돌아오지 않는다', async () => {
    const scenarios: Array<() => Promise<Response>> = [
      () => setup().handler(request()),
      () => setup().handler(request({ code: 'wrong-access-code-0123456789-abcdefgh' })),
      () => setup(ENV, () => Promise.resolve(new Response(`${GROQ_KEY} ${REQUIREMENT_TEXT}`, { status: 500 }))).handler(request()),
      () => setup(ENV, () => Promise.reject(new Error(`${GROQ_KEY} ${ACCESS_CODE}`))).handler(request()),
      () => setup(ENV, () => Promise.resolve(groqReply(`{broken ${GROQ_KEY}`))).handler(request()),
      () => setup(ENV, () => Promise.resolve(new Response(`${GROQ_KEY}`, { status: 429, headers: { 'retry-after': '3' } }))).handler(request()),
      () => setup({ ...ENV, LOOMA_AI_ACCESS_CODE: undefined }).handler(request()),
    ];
    for (const run of scenarios) {
      const response = await run();
      const text = await response.clone().text();
      for (const secret of [GROQ_KEY, ACCESS_CODE]) expect(text).not.toContain(secret);
      if (response.status !== 200) expect(text).not.toContain(REQUIREMENT_TEXT);
      expect(JSON.stringify([...response.headers])).not.toContain(GROQ_KEY);
      expect(JSON.stringify([...response.headers])).not.toContain(ACCESS_CODE);
    }
  });

  it('로그에는 오류 분류만 남고 키 · 접근 코드 · 요청 · 응답 내용은 남지 않는다', async () => {
    const logged: unknown[][] = [];
    for (const method of ['error', 'warn', 'log', 'info', 'debug'] as const) vi.spyOn(console, method).mockImplementation((...args) => void logged.push(args));
    const failures: Array<() => Promise<Response>> = [
      () => setup(ENV, () => Promise.resolve(new Response(`${GROQ_KEY} ${REQUIREMENT_TEXT}`, { status: 500 }))).handler(request()),
      () => setup(ENV, () => Promise.reject(new Error(`${GROQ_KEY} ${ACCESS_CODE} ${REQUIREMENT_TEXT}`))).handler(request()),
      () => setup(ENV, () => Promise.resolve(groqReply(`{broken ${REQUIREMENT_TEXT}`))).handler(request()),
      () => setup(ENV, () => Promise.resolve(new Response(GROQ_KEY, { status: 429 }))).handler(request()),
      () => setup().handler(request({ code: 'wrong-access-code-0123456789-abcdefgh' })),
    ];
    for (const run of failures) await run();
    // 예상하지 못한 예외도 이름만 남긴다.
    const exploding = createTestDraftHandler({ env: ENV, fetch: (() => Promise.resolve(groqReply([draft()]))) as unknown as typeof fetch, now: () => { throw new Error(`${GROQ_KEY}`); } });
    expect((await exploding(request())).status).toBe(500);
    const output = JSON.stringify(logged);
    expect(logged.length).toBeGreaterThan(0);
    for (const secret of [GROQ_KEY, ACCESS_CODE, REQUIREMENT_TEXT, 'wrong-access-code']) expect(output).not.toContain(secret);
  });
});
