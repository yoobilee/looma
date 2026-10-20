import { createHash, timingSafeEqual } from 'node:crypto';
import { MIN_ACCESS_CODE_LENGTH } from '../../src/shared/aiTestDraftContract.js';

/*
 * 서버 함수 접근 제어. Looma에는 사용자 로그인이 없어서, 서버에 환경변수로 둔 접근 코드를 아는 사용자만 AI 함수를 쓸 수 있게 한다.
 * 이 파일의 한도(실패 횟수 · 분당 호출 · 동시 실행)는 서버리스 인스턴스 메모리에만 있다. 인스턴스가 여러 개 뜨거나 새로 뜨면 따로 세므로
 * 전체 사용량의 상한이 아니다. 접근 코드가 1차 방어선이고, 이 한도는 실수 · 단순 반복을 줄이는 보조 수단이다.
 */

/** 서버에 설정된 접근 코드. 없거나 짧으면 undefined — 이때는 모든 요청을 거부한다(fail-closed). */
export function configuredAccessCode(value: string | undefined): string | undefined {
  const code = value?.trim();
  return code !== undefined && code.length >= MIN_ACCESS_CODE_LENGTH ? code : undefined;
}

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/**
 * 접근 코드 비교. 양쪽을 SHA-256으로 같은 길이로 만든 뒤 상수 시간으로 비교하므로 길이나 일치하는 앞부분이 응답 시간에 드러나지 않는다.
 * 받은 값이 없어도 같은 비교를 해서 걸리는 시간이 같다.
 */
export function accessCodeMatches(expected: string, provided: string | null | undefined): boolean {
  return timingSafeEqual(digest(expected), digest((provided ?? '').trim())) && typeof provided === 'string';
}

/**
 * 접속자 키별로 시간 창 안의 횟수를 센다. 메모리를 묶으려고 키 수를 제한한다.
 * 이미 한도에 닿은(차단 중인) 키는 정리하지 않는다 — 다른 키를 잔뜩 만들어 차단을 풀 수 없게 한다.
 * 한도에 닿지 않은 키 중 오래된 것부터 정리하고, 모든 키가 차단 중이라 자리가 없으면 새 키는 차단된 것으로 본다(fail-closed).
 */
export class WindowCounter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 1000,
  ) {}

  private recent(key: string, now: number): number[] {
    const times = (this.hits.get(key) ?? []).filter((time) => now - time < this.windowMs);
    if (times.length === 0) this.hits.delete(key);
    else this.hits.set(key, times);
    return times;
  }

  /** 한도에 이미 닿았으면 다시 시도할 수 있을 때까지의 초, 아니면 0 */
  retryAfterSeconds(key: string, now: number): number {
    const times = this.recent(key, now);
    if (times.length >= this.limit) return Math.max(1, Math.ceil((times[0] + this.windowMs - now) / 1000));
    // 기록이 없는 새 키인데 자리가 모두 차단 중인 키로 차 있으면 받을 수 없다.
    if (times.length === 0 && this.isSaturated(now)) return Math.max(1, Math.ceil(this.windowMs / 1000));
    return 0;
  }

  record(key: string, now: number): void {
    const times = this.recent(key, now);
    if (times.length === 0 && this.hits.size >= this.maxKeys && !this.makeRoom(now)) return;
    times.push(now);
    this.hits.set(key, times);
  }

  private pruneExpired(now: number): void {
    for (const key of [...this.hits.keys()]) this.recent(key, now);
  }

  /** 자리가 없고 비울 수도 없다(모든 키가 차단 중) */
  private isSaturated(now: number): boolean {
    if (this.hits.size < this.maxKeys) return false;
    this.pruneExpired(now);
    return this.hits.size >= this.maxKeys && [...this.hits.values()].every((times) => times.length >= this.limit);
  }

  /** 한도에 닿지 않은 가장 오래된 키를 비운다. 모두 차단 중이면 false. */
  private makeRoom(now: number): boolean {
    this.pruneExpired(now);
    if (this.hits.size < this.maxKeys) return true;
    for (const [key, times] of this.hits) {
      if (times.length < this.limit) {
        this.hits.delete(key);
        return true;
      }
    }
    return false;
  }
}

/** 동시에 실행할 수 있는 수를 제한한다. */
export class ConcurrencyGate {
  private active = 0;

  constructor(private readonly max: number) {}

  tryEnter(): boolean {
    if (this.active >= this.max) return false;
    this.active += 1;
    return true;
  }

  leave(): void {
    this.active = Math.max(0, this.active - 1);
  }
}

/** 접속자 구분 값. Vercel이 덮어쓰는 헤더를 우선한다. 구분할 수 없으면 한 묶음으로 센다. */
export function clientKey(headers: Headers): string {
  const forwarded = headers.get('x-vercel-forwarded-for') ?? headers.get('x-forwarded-for') ?? '';
  return forwarded.split(',')[0]?.trim().slice(0, 64) || 'unknown';
}
