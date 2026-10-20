import { describe, expect, it } from 'vitest';
import { MIN_ACCESS_CODE_LENGTH } from '@/shared/aiTestDraftContract';
import {
  AI_ACCESS_CODE_STORAGE_KEY,
  AI_PROVIDER_STORAGE_KEY,
  clearAccessCode,
  isPlausibleAccessCode,
  readAccessCode,
  readSelectedProvider,
  writeAccessCode,
  writeSelectedProvider,
} from './aiSettings';

const CODE = 'client-access-code-0123456789-abcdef';

/** localStorage · sessionStorage를 흉내 내는 저장소. 어떤 키에 무엇이 들어갔는지 확인한다. */
function fakeStorage(options: { throws?: boolean } = {}) {
  const data = new Map<string, string>();
  const guard = () => {
    if (options.throws) throw new Error('storage blocked');
  };
  return {
    data,
    getItem: (key: string) => (guard(), data.get(key) ?? null),
    setItem: (key: string, value: string) => (guard(), void data.set(key, value)),
    removeItem: (key: string) => (guard(), void data.delete(key)),
  };
}

describe('공급자 선택 저장', () => {
  it('저장된 값이 없으면 무료 Groq다', () => {
    expect(readSelectedProvider(fakeStorage()).id).toBe('groq');
  });

  it('사용할 수 있는 공급자만 저장하고 다시 읽는다', () => {
    const local = fakeStorage();
    expect(writeSelectedProvider(local, 'groq')).toBe(true);
    expect(local.data.get(AI_PROVIDER_STORAGE_KEY)).toBe('groq');
    expect(readSelectedProvider(local).id).toBe('groq');
  });

  it('OpenAI(비활성) · 알 수 없는 공급자는 저장하지 않는다', () => {
    const local = fakeStorage();
    expect(writeSelectedProvider(local, 'openai')).toBe(false);
    expect(writeSelectedProvider(local, 'mock')).toBe(false);
    expect(writeSelectedProvider(local, 'unknown')).toBe(false);
    expect(local.data.size).toBe(0);
  });

  it('저장소에 openai가 들어 있어도(손으로 고친 경우 포함) 무료 기본값으로 읽는다', () => {
    const local = fakeStorage();
    local.setItem(AI_PROVIDER_STORAGE_KEY, 'openai');
    expect(readSelectedProvider(local).id).toBe('groq');
  });

  it('저장소가 막혀 있어도 던지지 않는다', () => {
    const blocked = fakeStorage({ throws: true });
    expect(readSelectedProvider(blocked).id).toBe('groq');
    expect(writeSelectedProvider(blocked, 'groq')).toBe(false);
  });
});

describe('접근 코드 저장 (sessionStorage 전용)', () => {
  it('코드는 session에만 저장하고 local에는 어떤 키로도 들어가지 않는다', () => {
    const local = fakeStorage();
    const session = fakeStorage();
    expect(writeSelectedProvider(local, 'groq')).toBe(true);
    expect(writeAccessCode(session, CODE)).toBe(true);
    expect(session.data.get(AI_ACCESS_CODE_STORAGE_KEY)).toBe(CODE);
    expect(readAccessCode(session)).toBe(CODE);
    expect(JSON.stringify([...local.data])).not.toContain(CODE);
  });

  it('앞뒤 공백을 지우고, 서버가 인정하는 최소 길이보다 짧으면 저장하지 않는다', () => {
    const session = fakeStorage();
    expect(writeAccessCode(session, `  ${CODE}  `)).toBe(true);
    expect(readAccessCode(session)).toBe(CODE);
    const short = fakeStorage();
    expect(writeAccessCode(short, 'x'.repeat(MIN_ACCESS_CODE_LENGTH - 1))).toBe(false);
    expect(writeAccessCode(short, '')).toBe(false);
    expect(short.data.size).toBe(0);
    expect(isPlausibleAccessCode('x'.repeat(MIN_ACCESS_CODE_LENGTH))).toBe(true);
  });

  it('지우면 읽히지 않는다', () => {
    const session = fakeStorage();
    writeAccessCode(session, CODE);
    clearAccessCode(session);
    expect(readAccessCode(session)).toBeNull();
  });

  it('저장소가 막혀 있어도 던지지 않고 저장되지 않은 것으로 다룬다', () => {
    const blocked = fakeStorage({ throws: true });
    expect(writeAccessCode(blocked, CODE)).toBe(false);
    expect(readAccessCode(blocked)).toBeNull();
    expect(() => clearAccessCode(blocked)).not.toThrow();
  });
});
