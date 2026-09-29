import styles from './FilterTabs.module.css';

interface FilterTabsProps<T extends string> {
  label: string;
  options: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (value: T) => void;
}

/** 목록 필터용 세그먼트. 선택 상태는 aria-pressed로 전달한다. */
export function FilterTabs<T extends string>({ label, options, value, onChange }: FilterTabsProps<T>) {
  return (
    <div className={styles.bar} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`${styles.item} ${option.value === value ? styles.active : ''}`}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {option.count !== undefined && <span className={styles.count}>{option.count}</span>}
        </button>
      ))}
    </div>
  );
}
