import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { resolveAiProvider, type AiProvider } from './aiProviders';
import { clearAccessCode, readAccessCode, readSelectedProvider, writeAccessCode, writeSelectedProvider } from './aiSettings';

/* 설정 화면과 TC 초안 대화상자가 같은 AI 설정(공급자 선택 · 접근 코드 유무)을 보게 하는 훅. 접근 코드 값은 상태로 들고 있지 않고 쓸 때 읽는다. */

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

const unavailableStore: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = {
  getItem: () => null,
  setItem: () => {
    throw new Error('저장소를 쓸 수 없어요.');
  },
  removeItem: () => undefined,
};
// 저장소 접근 자체가 막힌 브라우저에서는 저장되지 않은 것으로 다룬다.
const localStore = () => {
  try {
    return window.localStorage;
  } catch {
    return unavailableStore;
  }
};
const sessionStore = () => {
  try {
    return window.sessionStorage;
  } catch {
    return unavailableStore;
  }
};

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

/** "공급자|접근 코드 유무". 값이 같으면 다시 그리지 않도록 원시 값 하나로 만든다. */
const snapshot = () => `${readSelectedProvider(localStore()).id}|${readAccessCode(sessionStore()) ? 'code' : 'none'}`;

export interface AiSettings {
  provider: AiProvider;
  hasAccessCode: boolean;
  selectProvider: (id: string) => boolean;
  saveAccessCode: (code: string) => boolean;
  removeAccessCode: () => void;
  /** 호출하는 순간의 접근 코드. 상태로 들고 있지 않는다. */
  currentAccessCode: () => string | null;
}

export function useAiSettings(): AiSettings {
  const [providerId, codeState] = useSyncExternalStore(subscribe, snapshot).split('|');
  const provider = useMemo(() => resolveAiProvider(providerId), [providerId]);
  const selectProvider = useCallback((id: string) => {
    const saved = writeSelectedProvider(localStore(), id);
    notify();
    return saved;
  }, []);
  const saveAccessCode = useCallback((code: string) => {
    const saved = writeAccessCode(sessionStore(), code);
    notify();
    return saved;
  }, []);
  const removeAccessCode = useCallback(() => {
    clearAccessCode(sessionStore());
    notify();
  }, []);
  const currentAccessCode = useCallback(() => readAccessCode(sessionStore()), []);
  return { provider, hasAccessCode: codeState === 'code', selectProvider, saveAccessCode, removeAccessCode, currentAccessCode };
}
