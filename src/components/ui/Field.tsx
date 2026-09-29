import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import styles from './Field.module.css';

interface FieldShellProps {
  label: string;
  hint?: ReactNode;
  hideLabel?: boolean;
  children: (id: string, describedBy?: string) => ReactNode;
}

function FieldShell({ label, hint, hideLabel, children }: FieldShellProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={hideLabel ? 'visually-hidden' : styles.label}>
        {label}
      </label>
      {children(id, hintId)}
      {hint && (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      )}
    </div>
  );
}

type TextFieldProps = { label: string; hint?: ReactNode; hideLabel?: boolean } & InputHTMLAttributes<HTMLInputElement>;

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField({ label, hint, hideLabel, className, ...rest }, ref) {
  return (
    <FieldShell label={label} hint={hint} hideLabel={hideLabel}>
      {(id, describedBy) => <input ref={ref} id={id} aria-describedby={describedBy} className={`${styles.control} ${className ?? ''}`} {...rest} />}
    </FieldShell>
  );
});

type TextAreaFieldProps = { label: string; hint?: ReactNode; hideLabel?: boolean } & TextareaHTMLAttributes<HTMLTextAreaElement>;

export function TextAreaField({ label, hint, hideLabel, className, ...rest }: TextAreaFieldProps) {
  return (
    <FieldShell label={label} hint={hint} hideLabel={hideLabel}>
      {(id, describedBy) => (
        <textarea id={id} aria-describedby={describedBy} className={`${styles.control} ${styles.textarea} ${className ?? ''}`} {...rest} />
      )}
    </FieldShell>
  );
}

type SelectFieldProps = { label: string; hint?: ReactNode; hideLabel?: boolean; children: ReactNode } & SelectHTMLAttributes<HTMLSelectElement>;

export function SelectField({ label, hint, hideLabel, className, children, ...rest }: SelectFieldProps) {
  return (
    <FieldShell label={label} hint={hint} hideLabel={hideLabel}>
      {(id, describedBy) => (
        <select id={id} aria-describedby={describedBy} className={`${styles.control} ${styles.select} ${className ?? ''}`} {...rest}>
          {children}
        </select>
      )}
    </FieldShell>
  );
}

interface CheckboxGroupProps<T extends string> {
  legend: string;
  options: { value: T; label: string }[];
  value: T[];
  onChange: (next: T[]) => void;
}

export function CheckboxGroup<T extends string>({ legend, options, value, onChange }: CheckboxGroupProps<T>) {
  return (
    <fieldset className={styles.fieldset}>
      <legend className={styles.label}>{legend}</legend>
      <div className={styles.chips}>
        {options.map((option) => {
          const checked = value.includes(option.value);
          return (
            <label key={option.value} className={`${styles.chip} ${checked ? styles.chipChecked : ''}`}>
              <input
                type="checkbox"
                className="visually-hidden"
                checked={checked}
                onChange={() => onChange(checked ? value.filter((item) => item !== option.value) : [...value, option.value])}
              />
              {option.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
