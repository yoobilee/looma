import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useRepositoryData } from '@/hooks/useRepositoryData';
import type { ScratchItem } from '@/domain/types';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { LoadingState, StateMessage } from '@/components/ui/StateMessage';
import { ScratchComposer } from './ScratchComposer';
import { ScratchItemView } from './ScratchItemView';
import { PinScratchDialog } from './PinScratchDialog';
import styles from './ScratchPanel.module.css';

interface ScratchPanelProps {
  contextProjectId?: string;
  limit?: number;
  headingId?: string;
}

/** Today 우측, 프로젝트 화면 서랍에서 함께 쓰는 임시 작업공간 */
export function ScratchPanel({ contextProjectId, limit = 4, headingId = 'scratch-panel-title' }: ScratchPanelProps) {
  const [pinTarget, setPinTarget] = useState<ScratchItem | null>(null);
  const scratch = useRepositoryData((repos) => repos.scratch.list(), []);
  const volatileItems = (scratch.data ?? []).filter((item) => !item.pinnedAt);
  const ordered = contextProjectId
    ? [...volatileItems].sort((a, b) => Number(b.contextProjectId === contextProjectId) - Number(a.contextProjectId === contextProjectId))
    : volatileItems;
  const visible = ordered.slice(0, limit);

  return (
    <section className={styles.panel} aria-labelledby={headingId}>
      <SectionHeader id={headingId} title="임시 작업공간" meta={`${volatileItems.length}개`} />
      <p className={styles.caption}>잠깐 필요한 자료를 여기에. 고정하지 않으면 자동으로 비워져요.</p>
      <ScratchComposer contextProjectId={contextProjectId} />

      {scratch.status === 'loading' && <LoadingState />}
      {scratch.status === 'error' && <StateMessage tone="error" compact title="임시 자료를 불러오지 못했어요." />}
      {scratch.status === 'success' && volatileItems.length === 0 && (
        <p className={styles.empty}>비어 있어요. 로그, 링크, 캡처를 붙여넣어 보세요.</p>
      )}

      <div className={styles.list}>
        {visible.map((item) => (
          <ScratchItemView key={item.id} item={item} onPin={setPinTarget} />
        ))}
      </div>
      {volatileItems.length > visible.length && (
        <Link to="/scratch" className={styles.more}>
          임시함에서 {volatileItems.length - visible.length}개 더 보기
        </Link>
      )}
      <PinScratchDialog item={pinTarget} onClose={() => setPinTarget(null)} />
    </section>
  );
}
