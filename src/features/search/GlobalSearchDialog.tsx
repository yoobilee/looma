import { useDeferredValue, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search } from 'lucide-react';
import { useRepositoryData } from '@/hooks/useRepositoryData';
import { scratchTypeLabel, taskStatusLabel } from '@/domain/labels';
import { searchAll, type SearchGroup } from './searchIndex';
import styles from './GlobalSearchDialog.module.css';

interface GlobalSearchDialogProps {
  open: boolean;
  onClose: () => void;
}

/** 기본 검색 UI. 업무·프로젝트·TC·기록·업무 지식·임시 자료를 한 번에 찾는다. */
export function GlobalSearchDialog({ open, onClose }: GlobalSearchDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);

  const sources = useRepositoryData(
    async (repos) => {
      const projects = await repos.projects.list();
      const testCases = (await Promise.all(projects.map((project) => repos.testCases.listByProject(project.id)))).flat();
      return {
        tasks: await repos.tasks.list(),
        projects,
        testCases,
        terms: await repos.knowledge.list(),
        scratch: await repos.scratch.list(),
        activities: await repos.activities.list(),
      };
    },
    [],
  );

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const groups: SearchGroup[] = sources.data ? searchAll(sources.data, deferredQuery, { taskStatusLabel, scratchTypeLabel }) : [];
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);

  const close = () => {
    setQuery('');
    onClose();
  };

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-label="검색"
      onClose={close}
      onClick={(event) => {
        if (event.target === ref.current) close();
      }}
    >
      <div className={styles.panel}>
        <div className={styles.inputRow}>
          <Search aria-hidden />
          <input
            className={styles.input}
            type="search"
            value={query}
            placeholder="업무, 프로젝트, TC, 기록, 용어, 임시 자료 검색"
            aria-label="검색어"
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // type="search"는 Esc로 입력값만 지우므로, 한 번에 닫히도록 직접 처리한다.
              if (event.key === 'Escape') {
                event.preventDefault();
                close();
              }
            }}
          />
          <kbd className={styles.kbd}>Esc</kbd>
        </div>

        <div className={styles.results}>
          {!deferredQuery.trim() && <p className={styles.hint}>찾고 싶은 단어를 입력하세요. 예: 로그인, SIGN-002, 회귀</p>}
          {deferredQuery.trim() && total === 0 && <p className={styles.hint}>“{deferredQuery}”에 맞는 결과가 없어요.</p>}
          <p className="visually-hidden" role="status" aria-live="polite">
            {deferredQuery.trim() ? `검색 결과 ${total}개` : ''}
          </p>
          {groups.map((group) => (
            <section key={group.label} className={styles.group} aria-label={group.label}>
              <h2 className={styles.groupTitle}>{group.label}</h2>
              <ul>
                {group.items.map((item) => (
                  <li key={item.id}>
                    <Link to={item.to} className={styles.result} onClick={close}>
                      <span className={styles.resultTitle}>{item.title}</span>
                      <span className={styles.resultMeta}>{item.meta}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </dialog>
  );
}
