import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ThemePreference } from '@/domain/types';
import { ThemeContext } from './themeContext';

const STORAGE_KEY = 'looma.theme';

function readStoredTheme(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** 라이트 모드가 기본이다. 사용자가 다크를 고르면 이 기기에서만 기억한다. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePreference>(readStoredTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // 저장할 수 없는 환경이면 현재 세션에서만 유지한다.
    }
  }, [theme]);

  const setTheme = useCallback((next: ThemePreference) => setThemeState(next), []);
  const toggleTheme = useCallback(() => setThemeState((current) => (current === 'light' ? 'dark' : 'light')), []);

  const value = useMemo(() => ({ theme, setTheme, toggleTheme }), [theme, setTheme, toggleTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
