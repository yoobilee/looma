import { useState } from 'react';
import { repositories } from '@/data';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import styles from './LocalDataResetDialog.module.css';

interface LocalDataResetDialogProps {
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
}

/** 로컬 데이터 초기화 확인. 확인을 누르기 전에는 아무것도 지우지 않고, 실패하면 기존 데이터를 그대로 둔다. */
export function LocalDataResetDialog({ open, onClose, onDone }: LocalDataResetDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const close = () => {
    if (busy) return;
    setError('');
    onClose();
  };

  const reset = async () => {
    setBusy(true);
    setError('');
    try {
      await repositories.persistence.resetToSeed();
      setBusy(false);
      onClose();
      onDone?.();
    } catch (failure) {
      setBusy(false);
      setError(failure instanceof Error ? failure.message : '초기화하지 못했어요. 기존 데이터는 그대로예요.');
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="로컬 데이터를 초기화할까요?"
      width="sm"
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={close}>
            취소
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void reset()}>
            {busy ? '초기화하는 중' : '초기화'}
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <p>이 브라우저에 저장된 Looma 작업 데이터와 가져온 원본 파일을 모두 삭제하고, 오늘 날짜 기준 예시 데이터로 다시 시작해요.</p>
        <p className={styles.warning}>삭제한 데이터는 되돌릴 수 없어요.</p>
        {error && (
          <p className={styles.error} role="alert">
            {error} 기존 데이터는 그대로예요.
          </p>
        )}
      </div>
    </Dialog>
  );
}
