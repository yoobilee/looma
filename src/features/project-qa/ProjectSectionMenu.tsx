import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronDown } from 'lucide-react';
import styles from './ProjectSectionMenu.module.css';

export interface ProjectSectionMenuItem {
  path: string;
  label: string;
  to: string;
  group: string;
}

interface ProjectSectionMenuProps {
  items: ProjectSectionMenuItem[];
  currentPath: string;
}

/** 좁은 화면용 프로젝트 섹션 내비게이션. 현재 섹션만 보여 주고, 누르면 전체 섹션을 trigger 아래 메뉴로 펼친다. */
export function ProjectSectionMenu({ items, currentPath }: ProjectSectionMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const current = items.find((item) => item.path === currentPath) ?? items[0];
  const groups = [...new Set(items.map((item) => item.group))];

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutside);
    // 열리면 현재 섹션으로 초점을 옮겨 키보드로 바로 이어서 고를 수 있게 한다.
    rootRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
    return () => document.removeEventListener('pointerdown', closeOnOutside);
  }, [open]);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    const links = [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-menu-link]') ?? [])];
    const index = links.indexOf(document.activeElement as HTMLElement);
    const move = (next: number) => {
      event.preventDefault();
      links[(next + links.length) % links.length]?.focus();
    };
    if (event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowUp') move(index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(links.length - 1);
  };

  return (
    <div className={styles.root} ref={rootRef} onKeyDown={onMenuKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`프로젝트 섹션: ${current.label}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.current}>{current.label}</span>
        <ChevronDown aria-hidden className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`} />
      </button>
      {open && (
        <nav id={menuId} className={styles.menu} aria-label="프로젝트 섹션">
          {groups.map((group) => (
            <section key={group} className={styles.group} aria-label={group}>
              <p className={styles.groupLabel} aria-hidden>
                {group}
              </p>
              <ul className={styles.list}>
                {items
                  .filter((item) => item.group === group)
                  .map((item) => {
                    const active = item.path === current.path;
                    return (
                      <li key={item.path}>
                        <Link
                          to={item.to}
                          data-menu-link
                          className={`${styles.link} ${active ? styles.active : ''}`}
                          aria-current={active ? 'page' : undefined}
                          onClick={() => setOpen(false)}
                        >
                          {item.label}
                          {active && <Check aria-hidden className={styles.check} />}
                        </Link>
                      </li>
                    );
                  })}
              </ul>
            </section>
          ))}
        </nav>
      )}
    </div>
  );
}
