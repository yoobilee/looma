import styles from './AmbientBackground.module.css';

/**
 * Sky Blue → Pearl/Lilac → Soft Coral로 이어지는 하나의 ambient field.
 * 32초 주기, 이동폭 1–3%의 느린 움직임이며 prefers-reduced-motion에서는 멈춘다.
 */
export function AmbientBackground() {
  return <div className={styles.field} aria-hidden />;
}
