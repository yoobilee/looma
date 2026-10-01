import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import styles from './Dialog.module.css';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'xl';
  placement?: 'center' | 'top';
}

/**
 * 네이티브 <dialog>를 사용해 초점 가두기, Esc 닫기, 배경 비활성화를 브라우저에 맡긴다.
 * 모달은 컨트롤 레이어라 glass 표면을 쓴다.
 */
export function Dialog({ open, onClose, title, description, children, footer, width = 'md', placement = 'center' }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`${styles.dialog} ${styles[width]} ${styles[placement]}`}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className={styles.panel}>
        <header className={styles.header}>
          <div>
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            {description && <p className={styles.description}>{description}</p>}
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="닫기">
            <X aria-hidden />
          </button>
        </header>
        <div className={styles.body}>{children}</div>
        {footer && <footer className={styles.footer}>{footer}</footer>}
      </div>
    </dialog>
  );
}
