import { useEffect, useState, type ReactNode } from 'react';
import { repositories } from '@/data';
import { PersistenceError } from '@/data/persistenceError';
import type { PersistenceStatus } from '@/data/repositories/types';
import { Button } from '@/components/ui/Button';
import { LocalDataResetDialog } from '@/features/settings/LocalDataResetDialog';
import { InitialLoading } from './InitialLoading';
import { usePersistenceStatus } from './usePersistenceStatus';
import styles from './PersistenceGate.module.css';

const { persistence } = repositories;
// StrictMode에서 effect가 두 번 돌아도 저장소는 한 번만 연다.
let loadStarted = false;

/**
 * 저장된 데이터를 다 읽은 뒤에만 화면을 띄운다. 예시 데이터가 잠깐 보였다가 저장된 데이터로 바뀌는 깜박임을 막는다.
 * 저장소를 쓸 수 없거나 읽을 수 없으면 조용히 메모리로 넘어가지 않고 이유를 보여 준다.
 */
export function PersistenceGate({ children }: { children: ReactNode }) {
  const status = usePersistenceStatus();

  // 저장 실패는 화면 위 안내로 이미 보여 준다. 버튼 등에서 기다리지 않은 실패가 처리되지 않은 오류로 콘솔에 남지 않게 한다.
  useEffect(() => {
    const handle = (event: PromiseRejectionEvent) => {
      if (event.reason instanceof PersistenceError) event.preventDefault();
    };
    window.addEventListener('unhandledrejection', handle);
    return () => window.removeEventListener('unhandledrejection', handle);
  }, []);

  useEffect(() => {
    if (loadStarted) return;
    loadStarted = true;
    void persistence.load();
  }, []);

  if (status.state === 'loading') return <InitialLoading />;
  if (status.state === 'blocked') return <BlockedScreen status={status} />;
  return (
    <>
      <PersistenceNotice status={status} />
      {children}
    </>
  );
}

const blockedTitle: Record<Extract<PersistenceStatus, { state: 'blocked' }>['reason'], string> = {
  unavailable: '데이터를 저장할 수 없어요',
  read_failed: '저장된 데이터를 읽지 못했어요',
  corrupt: '저장된 데이터를 읽지 못했어요',
  unsupported_version: '이 버전에서 열 수 없는 데이터예요',
  migration_failed: '저장된 데이터를 변환하지 못했어요',
};

function BlockedScreen({ status }: { status: Extract<PersistenceStatus, { state: 'blocked' }> }) {
  const [resetOpen, setResetOpen] = useState(false);
  const canReset = status.reason !== 'unavailable';

  return (
    <main className={styles.blocked}>
      <section className={styles.panel} aria-labelledby="persistence-blocked-title">
        <h1 id="persistence-blocked-title" className={styles.title}>
          {blockedTitle[status.reason]}
        </h1>
        <p role="alert">{status.message}</p>
        {canReset ? (
          <p className={styles.muted}>저장된 데이터는 지우지 않았어요. 다시 시도하거나, 데이터를 포기하고 초기화할 수 있어요.</p>
        ) : (
          <p className={styles.muted}>저장하지 않는 모드로 예시 데이터를 둘러볼 수 있어요. 이 모드의 변경은 새로고침하면 사라져요.</p>
        )}
        <div className={styles.actions}>
          <Button variant="primary" onClick={() => window.location.reload()}>
            다시 시도
          </Button>
          {canReset ? (
            <Button variant="secondary" onClick={() => setResetOpen(true)}>
              로컬 데이터 초기화
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => void persistence.continueWithoutSaving()}>
              저장하지 않고 둘러보기
            </Button>
          )}
        </div>
      </section>
      {canReset && <LocalDataResetDialog open={resetOpen} onClose={() => setResetOpen(false)} />}
    </main>
  );
}

function PersistenceNotice({ status }: { status: Extract<PersistenceStatus, { state: 'ready' }> }) {
  const [reloading, setReloading] = useState(false);

  const reload = async () => {
    setReloading(true);
    try {
      await persistence.reloadLatest();
    } catch {
      // 실패 안내는 상태의 error로 보여 준다.
    } finally {
      setReloading(false);
    }
  };

  if (status.stale) {
    return (
      <div className={styles.notice} role="alert">
        <p>다른 탭에서 Looma 데이터가 변경되었어요. 최신 데이터를 불러와 주세요. 불러오기 전까지 이 탭의 변경은 저장하지 않아요.</p>
        <Button size="sm" variant="primary" disabled={reloading} onClick={() => void reload()}>
          {reloading ? '불러오는 중' : '최신 데이터 불러오기'}
        </Button>
      </div>
    );
  }
  if (status.error) {
    return (
      <div className={styles.notice} role="alert">
        <p>{status.error}</p>
        <Button size="sm" variant="ghost" onClick={() => persistence.dismissError()}>
          닫기
        </Button>
      </div>
    );
  }
  if (status.mode === 'memory') {
    return (
      <div className={`${styles.notice} ${styles.memory}`} role="status">
        <p>저장하지 않는 모드예요. 새로고침하면 변경 내용이 사라져요.</p>
      </div>
    );
  }
  return null;
}
