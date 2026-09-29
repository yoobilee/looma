import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardPaste, ListPlus, Plus, Search, Settings2 } from 'lucide-react';
import { useAppCommands } from '@/app/commandsContext';
import styles from './PageHeader.module.css';

interface PageHeaderProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  searchPlaceholder?: string;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function PageHeader({ eyebrow, title, searchPlaceholder = '업무, 메모, 자료 검색' }: PageHeaderProps) {
  const { openSearch, openTaskCreate, openScratchDrawer } = useAppCommands();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === 'Escape') setMenuOpen(false);
        return;
      }
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [menuOpen]);

  return (
    <header className={styles.header}>
      <div className={styles.titleGroup}>
        {eyebrow && <p className={styles.eyebrow}>{eyebrow}</p>}
        <h1 className={styles.title}>{title}</h1>
      </div>

      <div className={styles.tools}>
        <button type="button" className={styles.search} onClick={openSearch} aria-label={`검색 열기 (${searchPlaceholder})`} aria-keyshortcuts={isMac ? 'Meta+K' : 'Control+K'}>
          <Search aria-hidden />
          <span className={styles.searchText}>{searchPlaceholder}</span>
          <kbd className={styles.kbd}>{isMac ? '⌘ K' : 'Ctrl K'}</kbd>
        </button>

        <div className={styles.menuWrap} ref={menuRef}>
          <button
            type="button"
            className={styles.add}
            aria-label="빠르게 추가"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Plus aria-hidden />
          </button>
          {menuOpen && (
            <div id={menuId} role="menu" className={styles.menu}>
              <button
                type="button"
                role="menuitem"
                className={styles.menuItem}
                onClick={() => {
                  setMenuOpen(false);
                  openTaskCreate();
                }}
              >
                <ListPlus aria-hidden />
                <span>
                  <strong>업무 추가</strong>
                  <small>제목만 입력해도 바로 등록</small>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                className={styles.menuItem}
                onClick={() => {
                  setMenuOpen(false);
                  openScratchDrawer();
                }}
              >
                <ClipboardPaste aria-hidden />
                <span>
                  <strong>임시함에 붙여넣기</strong>
                  <small>텍스트 · 이미지 · 링크 · 로그</small>
                </span>
              </button>
            </div>
          )}
        </div>

        <Link to="/settings" className={styles.mobileSettings} aria-label="설정">
          <Settings2 aria-hidden />
        </Link>
      </div>
    </header>
  );
}
