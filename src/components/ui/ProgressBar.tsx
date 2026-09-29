import styles from './ProgressBar.module.css';

interface ProgressBarProps {
  value: number; // 0–100
  label: string;
  size?: 'thin' | 'regular';
}

export function ProgressBar({ value, label, size = 'regular' }: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      className={`${styles.track} ${styles[size]}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
    >
      <span className={styles.fill} style={{ width: `${clamped}%` }} />
    </div>
  );
}
