import { describe, expect, it, vi } from 'vitest';
import { AI_ACCESS_CODE_HEADER, AI_SERVER_LIMITS } from '../../src/shared/aiTestDraftContract.js';
import { WindowCounter } from './accessControl.js';
import { readBoundedText } from './boundedBody.js';
import { createTestDraftHandler } from './testDraftHandler.js';

/*
 * 독립 리뷰(PR #44)의 지적에 대한 회귀 테스트.
 * - 실패 횟수 제한: 다른 키를 잔뜩 만들어도 차단 중인 키가 풀리지 않고, 접속자 구분 헤더를 바꿔도 서버 전체 상한에 닿는다.
 * - Groq 응답 · 요청 본문: 크기 한도를 넘으면 전부 읽지 않고 멈춘다.
 */

const ACCESS_CODE = 'test-access-code-0123456789-abcdefgh';
const WRONG = 'wrong-access-code-0123456789-abcdefgh';
const ENV = { LOOMA_AI_ACCESS_CODE: ACCESS_CODE, GROQ_API_KEY: 'gsk_test_key' };
const BODY = JSON.stringify({ provider: 'groq', perspectives: ['normal_flow'], requirements: [{ id: 'req-1', feature: '기능', text: '문장', needsConfirmation: false }] });

const call = (code: string, client: string) =>
  new Request('https://looma.test/api/ai/test-drafts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', [AI_ACCESS_CODE_HEADER]: code, 'x-vercel-forwarded-for': client },
    body: BODY,
  });

const okReply = () =>
  new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ drafts: [] }) } }] }), { status: 200 });

function handlerWith(fetchImpl: () => Promise<Response> = () => Promise.resolve(okReply())) {
  const groq = vi.fn(fetchImpl);
  const clock = { now: 1_000_000 };
  const handler = createTestDraftHandler({ env: ENV, fetch: groq as unknown as typeof fetch, now: () => clock.now, upstreamTimeoutMs: 1000 });
  return { handler, groq, clock };
}

describe('실패 횟수 제한: 차단 해제 우회 방지', () => {
  it('차단 중인 키는 다른 키가 많아져도 정리되지 않는다', () => {
    const counter = new WindowCounter(2, 1000, 3);
    counter.record('blocked', 0);
    counter.record('blocked', 0);
    counter.record('b', 0);
    counter.record('c', 0);
    // 자리가 모자라면 한도에 닿지 않은 키부터 비운다.
    for (let index = 0; index < 50; index += 1) counter.record(`new-${index}`, 0);
    expect(counter.retryAfterSeconds('blocked', 1)).toBeGreaterThan(0);
  });

  it('모든 자리가 차단 중인 키로 차면 새 키도 차단된 것으로 본다 (fail-closed)', () => {
    const counter = new WindowCounter(1, 1000, 2);
    counter.record('a', 0);
    counter.record('b', 0);
    expect(counter.retryAfterSeconds('c', 1)).toBeGreaterThan(0);
    counter.record('c', 1);
    expect(counter.retryAfterSeconds('a', 1)).toBeGreaterThan(0);
    // 창이 지나면 풀리고 새 키를 받는다.
    expect(counter.retryAfterSeconds('c', 1001)).toBe(0);
    counter.record('c', 1001);
    expect(counter.retryAfterSeconds('c', 1001)).toBeGreaterThan(0);
  });

  it('접속자 구분 헤더를 계속 바꿔도 서버 전체 실패 상한에 닿아 맞는 코드도 잠시 거부한다 (Groq 미호출)', async () => {
    const { handler, groq, clock } = handlerWith();
    for (let index = 0; index < AI_SERVER_LIMITS.maxFailedAttemptsAnyClient; index += 1) {
      expect((await handler(call(WRONG, `198.51.100.${index}`))).status).toBe(401);
    }
    const blocked = await handler(call(ACCESS_CODE, '203.0.113.200'));
    expect(blocked.status).toBe(429);
    expect(groq).not.toHaveBeenCalled();
    clock.now += AI_SERVER_LIMITS.failedAttemptWindowMs + 1;
    expect((await handler(call(ACCESS_CODE, '203.0.113.200'))).status).toBe(200);
  });

  it('한 접속자의 차단은 다른 접속자 1,000명이 실패해도 풀리지 않는다', async () => {
    const { handler } = handlerWith();
    for (let index = 0; index < AI_SERVER_LIMITS.maxFailedAttempts; index += 1) await handler(call(WRONG, '203.0.113.9'));
    expect((await handler(call(ACCESS_CODE, '203.0.113.9'))).status).toBe(429);
    for (let index = 0; index < 1000; index += 1) await handler(call(WRONG, `192.0.2.${index}`));
    expect((await handler(call(ACCESS_CODE, '203.0.113.9'))).status).toBe(429);
  });
});

/** 청크 수를 세는 큰 스트림 */
function bigStream(chunkBytes: number, chunks: number) {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= chunks) return controller.close();
      state.pulled += 1;
      controller.enqueue(new Uint8Array(chunkBytes).fill(120));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { body, state };
}

describe('본문 크기 한도: 전부 읽지 않고 멈춘다', () => {
  it('readBoundedText는 한도를 넘는 즉시 스트림을 취소한다', async () => {
    const { body, state } = bigStream(1024, 1000);
    expect(await readBoundedText(body, null, 4096)).toBeUndefined();
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(20);
  });

  it('한도 안이면 그대로 읽고, 없는 본문은 빈 문자열이다', async () => {
    const body = new Response('안녕하세요').body;
    expect(await readBoundedText(body, null, 1000)).toBe('안녕하세요');
    expect(await readBoundedText(null, null, 1000)).toBe('');
  });

  it('선언한 길이가 한도를 넘으면 읽지 않는다', async () => {
    const { body, state } = bigStream(1024, 1000);
    expect(await readBoundedText(body, '999999', 4096)).toBeUndefined();
    expect(state.pulled).toBe(0);
  });

  it('Groq가 아주 큰 응답을 보내면 invalid_response로 끊고 전부 읽지 않는다', async () => {
    const { body, state } = bigStream(1024, 1000);
    const { handler } = handlerWith(() => Promise.resolve(new Response(body, { status: 200 })));
    const response = await handler(call(ACCESS_CODE, '203.0.113.1'));
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('invalid_response');
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(400);
  });

  it('큰 오류 응답 본문도 전부 읽지 않는다', async () => {
    const { body, state } = bigStream(1024, 1000);
    const { handler } = handlerWith(() => Promise.resolve(new Response(body, { status: 200, headers: { 'content-length': '1024000' } })));
    const response = await handler(call(ACCESS_CODE, '203.0.113.2'));
    expect(response.status).toBe(502);
    // 스트림은 만들어질 때 첫 청크를 미리 당길 수 있다. 선언된 길이가 한도를 넘으면 그 뒤로는 읽지 않고 취소한다.
    expect(state.pulled).toBeLessThanOrEqual(1);
    expect(state.cancelled).toBe(true);
  });
});
