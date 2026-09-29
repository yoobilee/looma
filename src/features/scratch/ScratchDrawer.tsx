import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { ScratchPanel } from './ScratchPanel';
import styles from './ScratchDrawer.module.css';

interface ScratchDrawerProps {
  open: boolean;
  onClose: () => void;
  contextProjectId?: string;
}

/** 어느 화면에서든 여는 임시함 서랍. glass 컨트롤 레이어로 표시한다. */
export function ScratchDrawer({ open, onClose, contextProjectId }: ScratchDrawerProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={styles.drawer}
      aria-labelledby="scratch-drawer-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className={styles.inner}>
        <button type="button" className={styles.close} onClick={onClose} aria-label="임시함 닫기">
          <X aria-hidden />
        </button>
        {open && <ScratchPanel contextProjectId={contextProjectId} limit={8} headingId="scratch-drawer-title" />}
      </div>
    </dialog>
  );
}
