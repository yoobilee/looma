import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import styles from './Button.module.css';

type ButtonVariant = 'primary' | 'accent' | 'secondary' | 'ghost' | 'inverse';
type ButtonSize = 'sm' | 'md';

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  children?: ReactNode;
  className?: string;
}

function classNames(variant: ButtonVariant, size: ButtonSize, className?: string, iconOnly?: boolean) {
  return [styles.button, styles[variant], styles[size], iconOnly ? styles.iconOnly : '', className ?? ''].filter(Boolean).join(' ');
}

export const Button = forwardRef<HTMLButtonElement, CommonProps & ButtonHTMLAttributes<HTMLButtonElement>>(
  function Button({ variant = 'secondary', size = 'md', icon, children, className, type = 'button', ...rest }, ref) {
    return (
      <button ref={ref} type={type} className={classNames(variant, size, className, !children)} {...rest}>
        {icon}
        {children}
      </button>
    );
  },
);

export function ButtonLink({ variant = 'secondary', size = 'md', icon, children, className, ...rest }: CommonProps & LinkProps) {
  return (
    <Link className={classNames(variant, size, className, !children)} {...rest}>
      {icon}
      {children}
    </Link>
  );
}
