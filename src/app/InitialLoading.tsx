import { LoadingState } from '@/components/ui/StateMessage';

/** 첫 화면 코드가 도착하기 전에만 보이는 최소 표시. 이후 화면 전환에서는 이전 화면이 남아 있어 쓰이지 않는다. */
export function InitialLoading() {
  return (
    <div style={{ padding: 'var(--space-6)' }}>
      <LoadingState />
    </div>
  );
}
