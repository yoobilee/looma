import { testResultLabel, testResultOrder } from '@/domain/labels';
import type { ResultCounts } from '@/domain/resultSummary';
import styles from './ResultStackedBar.module.css';

interface ResultStackedBarProps {
  counts: ResultCounts;
  label: string;
  size?: 'regular' | 'large';
}

/** PASS/FAIL/BLOCKED/미수행 비율 막대. 각 조각에 hover 툴팁이 있고, 수치는 옆 표·범례로 함께 제공한다. */
export function ResultStackedBar({ counts, label, size = 'regular' }: ResultStackedBarProps) {
  const description = testResultOrder.map((value) => `${testResultLabel[value]} ${counts[value]}`).join(', ');
  return (
    <div className={`${styles.bar} ${styles[size]}`} role="img" aria-label={`${label}: ${description}`}>
      {counts.total === 0 ? (
        <span className={styles.empty} />
      ) : (
        testResultOrder
          .filter((value) => counts[value] > 0)
          .map((value) => (
            <span
              key={value}
              className={`${styles.segment} ${styles[value]}`}
              style={{ flexGrow: counts[value] }}
              title={`${testResultLabel[value]} ${counts[value]}개 (${Math.round((counts[value] / counts.total) * 100)}%)`}
            />
          ))
      )}
    </div>
  );
}

export function ResultLegend() {
  return (
    <ul className={styles.legend} aria-label="범례">
      {testResultOrder.map((value) => (
        <li key={value}>
          <span className={`${styles.swatch} ${styles[value]}`} aria-hidden />
          {testResultLabel[value]}
        </li>
      ))}
    </ul>
  );
}
