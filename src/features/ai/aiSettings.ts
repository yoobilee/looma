import { MIN_ACCESS_CODE_LENGTH } from '@/shared/aiTestDraftContract';
import { resolveAiProvider, type AiProvider } from './aiProviders';

/*
 * AI 설정 저장.
 * - 공급자 선택: localStorage. 비밀이 아니다.
 * - 접근 코드: sessionStorage에만 둔다(탭을 닫으면 사라진다). localStorage · IndexedDB · URL · 로그에는 두지 않는다.
 *   접근 코드는 이 앱의 서버 함수를 쓰기 위한 코드이고 Groq · OpenAI API 키가 아니다. API 키는 브라우저에 입력하거나 저장하지 않는다.
 * 저장소가 막혀 있어도(비공개 모드 등) 던지지 않고 저장되지 않은 것으로 다룬다.
 */

export const AI_PROVIDER_STORAGE_KEY = 'looma.ai.provider';
export const AI_ACCESS_CODE_STORAGE_KEY = 'looma.ai.accessCode';

type ReadableStore = Pick<Storage, 'getItem'>;
type WritableStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const safely = <T>(action: () => T, fallback: T): T => {
  try {
    return action();
  } catch {
    return fallback;
  }
};

export function readSelectedProvider(local: ReadableStore, providers?: readonly AiProvider[]): AiProvider {
  return resolveAiProvider(safely(() => local.getItem(AI_PROVIDER_STORAGE_KEY), null), providers);
}

/** 사용할 수 있는 공급자만 저장한다. 저장하지 못했거나 쓸 수 없으면 false. */
export function writeSelectedProvider(local: WritableStore, id: string, providers?: readonly AiProvider[]): boolean {
  const provider = resolveAiProvider(id, providers);
  if (provider.id !== id) return false;
  return safely(() => (local.setItem(AI_PROVIDER_STORAGE_KEY, provider.id), true), false);
}

export const readAccessCode = (session: ReadableStore): string | null => safely(() => session.getItem(AI_ACCESS_CODE_STORAGE_KEY) || null, null);

/** 서버가 받아 주는 최소 길이를 못 채우면 저장하지 않는다(서버는 짧은 코드를 설정으로 인정하지 않는다). */
export const isPlausibleAccessCode = (code: string) => code.trim().length >= MIN_ACCESS_CODE_LENGTH;

export function writeAccessCode(session: WritableStore, code: string): boolean {
  const trimmed = code.trim();
  if (!isPlausibleAccessCode(trimmed)) return false;
  return safely(() => (session.setItem(AI_ACCESS_CODE_STORAGE_KEY, trimmed), true), false);
}

export const clearAccessCode = (session: WritableStore) => safely(() => session.removeItem(AI_ACCESS_CODE_STORAGE_KEY), undefined);