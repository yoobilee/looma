import { createContext, useContext } from 'react';
import type { ThemePreference } from '@/domain/types';

export interface ThemeContextValue {
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
  toggleTheme: () => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('ThemeProvider 안에서만 useTheme을 사용할 수 있어요.');
  return value;
}
