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

/** 접속자 키별로 시간 창 안의 횟수를 센다. 키가 너무 많아지면 오래된 키부터 버려 메모리를 묶는다. */
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
    if (times.length < this.limit) return 0;
    return Math.max(1, Math.ceil((times[0] + this.windowMs - now) / 1000));
  }

  record(key: string, now: number): void {
    const times = this.recent(key, now);
    times.push(now);
    this.hits.set(key, times);
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) break;
      this.hits.delete(oldest);
    }
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
