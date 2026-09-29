import { createContext, useContext } from 'react';

export interface TaskCreateDefaults {
  projectId?: string;
  title?: string;
}

/** 어느 화면에서든 호출하는 전역 동작: 검색, 업무 추가, 임시함 열기 */
export interface AppCommands {
  openSearch: () => void;
  openTaskCreate: (defaults?: TaskCreateDefaults) => void;
  openScratchDrawer: () => void;
}

export const CommandsContext = createContext<AppCommands | null>(null);

export function useAppCommands(): AppCommands {
  const value = useContext(CommandsContext);
  if (!value) throw new Error('AppShell 안에서만 useAppCommands를 사용할 수 있어요.');
  return value;
}
