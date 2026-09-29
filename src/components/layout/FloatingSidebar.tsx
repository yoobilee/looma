import { NavLink } from 'react-router-dom';
import { ArrowUpRight, Check, CircleDot, ClipboardPaste, Command, Diamond, Moon, Settings2, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTheme } from '@/app/themeContext';
import styles from './FloatingSidebar.module.css';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
}

const mainItems: NavItem[] = [
  { to: '/today', label: '오늘', icon: <CircleDot aria-hidden /> },
  { to: '/work', label: '업무', icon: <Check aria-hidden /> },
  { to: '/projects', label: '프로젝트', icon: <Diamond aria-hidden /> },
  { to: '/records', label: '기록', icon: <ArrowUpRight aria-hidden /> },
  { to: '/knowledge', label: '업무 지식', icon: <Command aria-hidden /> },
];

const scratchItem: NavItem = { to: '/scratch', label: '임시함', icon: <ClipboardPaste aria-hidden /> };

function SidebarLink({ item, className }: { item: NavItem; className?: string }) {
  return (
    <NavLink to={item.to} className={({ isActive }) => `${styles.item} ${isActive ? styles.active : ''} ${className ?? ''}`}>
      {item.icon}
      <span className={styles.label}>{item.label}</span>
    </NavLink>
  );
}

/** 플로팅 glass 사이드바. 모바일에서는 하단 플로팅 바로 바뀐다. */
export function FloatingSidebar({ scratchCount }: { scratchCount: number }) {
  const { theme, toggleTheme } = useTheme();
  const nextThemeLabel = theme === 'light' ? '다크 모드로 전환' : '라이트 모드로 전환';

  return (
    <nav className={styles.sidebar} aria-label="주요 메뉴">
      <NavLink to="/today" className={styles.brand} aria-label="Looma 오늘 화면으로 이동">
        <span aria-hidden>L</span>
      </NavLink>

      <ul className={styles.list}>
        {mainItems.map((item) => (
          <li key={item.to}>
            <SidebarLink item={item} />
          </li>
        ))}
        <li className={styles.mobileOnly}>
          <SidebarLink item={scratchItem} />
        </li>
      </ul>

      <div className={styles.bottom}>
        <NavLink
          to={scratchItem.to}
          className={({ isActive }) => `${styles.item} ${isActive ? styles.active : ''}`}
          aria-label={`임시함, 임시 자료 ${scratchCount}개`}
        >
          {scratchItem.icon}
          <span className={styles.label}>임시함</span>
          {scratchCount > 0 && (
            <span className={styles.badge} aria-hidden>
              {scratchCount}
            </span>
          )}
        </NavLink>
        <button type="button" className={styles.item} onClick={toggleTheme} aria-label={nextThemeLabel} title={nextThemeLabel}>
          {theme === 'light' ? <Moon aria-hidden /> : <Sun aria-hidden />}
          <span className={styles.label}>테마</span>
        </button>
        <SidebarLink item={{ to: '/settings', label: '설정', icon: <Settings2 aria-hidden /> }} />
      </div>
    </nav>
  );
}
