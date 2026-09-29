import { useCallback, useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useMatch } from 'react-router-dom';
import { ClipboardPaste } from 'lucide-react';
import { CommandsContext, type AppCommands, type TaskCreateDefaults } from '@/app/commandsContext';
import { useRepositoryData } from '@/hooks/useRepositoryData';
import { Dialog } from '@/components/ui/Dialog';
import { GlobalSearchDialog } from '@/features/search/GlobalSearchDialog';
import { ScratchDrawer } from '@/features/scratch/ScratchDrawer';
import { TaskCreateForm } from '@/features/tasks/TaskCreateForm';
import { AmbientBackground } from './AmbientBackground';
import { FloatingSidebar } from './FloatingSidebar';
import styles from './AppShell.module.css';

export function AppShell() {
  const location = useLocation();
  const projectMatch = useMatch('/projects/:projectId/*');
  const contextProjectId = projectMatch?.params.projectId;

  const [searchOpen, setSearchOpen] = useState(false);
  const [scratchOpen, setScratchOpen] = useState(false);
  const [taskDefaults, setTaskDefaults] = useState<TaskCreateDefaults | null>(null);

  const scratch = useRepositoryData((repos) => repos.scratch.list(), []);
  const volatileCount = (scratch.data ?? []).filter((item) => !item.pinnedAt).length;

  const commands = useMemo<AppCommands>(
    () => ({
      openSearch: () => setSearchOpen(true),
      openTaskCreate: (defaults) => setTaskDefaults(defaults ?? {}),
      openScratchDrawer: () => setScratchOpen(true),
    }),
    [],
  );

  const handleShortcut = useCallback((event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      setSearchOpen(true);
    }
  }, []);

  useEffect(() => {
    document.addEventListener('keydown', handleShortcut);
    return () => document.removeEventListener('keydown', handleShortcut);
  }, [handleShortcut]);

  // Today와 임시함 화면에는 임시 작업공간이 이미 보이므로 플로팅 버튼을 숨긴다.
  const showScratchButton = !['/today', '/scratch'].includes(location.pathname);

  return (
    <CommandsContext.Provider value={commands}>
      <a className="skip-link" href="#main-content">
        본문으로 건너뛰기
      </a>
      <AmbientBackground />
      <FloatingSidebar scratchCount={volatileCount} />

      <main id="main-content" className={styles.main} tabIndex={-1}>
        <div className={styles.content}>
          <Outlet />
        </div>
      </main>

      {showScratchButton && (
        <button type="button" className={styles.scratchButton} onClick={() => setScratchOpen(true)} aria-label={`임시함 열기, 임시 자료 ${volatileCount}개`}>
          <ClipboardPaste aria-hidden />
          <span>임시함</span>
          <span className={styles.scratchCount} aria-hidden>
            {volatileCount}
          </span>
        </button>
      )}

      <GlobalSearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
      <ScratchDrawer open={scratchOpen} onClose={() => setScratchOpen(false)} contextProjectId={contextProjectId} />
      <Dialog open={taskDefaults !== null} onClose={() => setTaskDefaults(null)} title="업무 추가" description="제목만 입력해도 바로 생성돼요." width="sm">
        {taskDefaults !== null && (
          <TaskCreateForm
            key={JSON.stringify(taskDefaults)}
            autoFocus
            defaultProjectId={taskDefaults.projectId ?? contextProjectId}
            defaultTitle={taskDefaults.title}
            onCreated={() => setTaskDefaults(null)}
          />
        )}
      </Dialog>
    </CommandsContext.Provider>
  );
}
