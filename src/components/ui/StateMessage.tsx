import type { ReactNode } from 'react';
import styles from './StateMessage.module.css';

interface StateMessageProps {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  tone?: 'empty' | 'error';
  compact?: boolean;
}

/** 빈 화면과 오류 안내를 같은 형태로 보여준다. */
export function StateMessage({ title, description, action, tone = 'empty', compact }: StateMessageProps) {
  return (
    <div className={`${styles.state} ${compact ? styles.compact : ''}`} role={tone === 'error' ? 'alert' : undefined}>
      <p className={`${styles.title} ${tone === 'error' ? styles.error : ''}`}>{title}</p>
      {description && <p className={styles.description}>{description}</p>}
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}

export function LoadingState({ label = '불러오는 중이에요' }: { label?: string }) {
  return (
    <div className={styles.loading} role="status" aria-live="polite">
      <span className={styles.shimmer} />
      <span className={styles.shimmer} />
      <span className="visually-hidden">{label}</span>
    </div>
  );
}
