import type { ReactNode } from 'react';
import styles from './SectionHeader.module.css';

interface SectionHeaderProps {
  id?: string;
  title: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  level?: 2 | 3;
  metaTone?: 'muted' | 'coral' | 'sky';
}

export function SectionHeader({ id, title, meta, action, level = 2, metaTone = 'muted' }: SectionHeaderProps) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <div className={styles.header}>
      <Heading id={id} className={styles.title}>
        {title}
      </Heading>
      {meta !== undefined && <span className={`${styles.meta} ${styles[metaTone]}`}>{meta}</span>}
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
