import { useState } from 'react';
import { useRepositoryData } from '@/hooks/useRepositoryData';
import { scratchTypeLabel } from '@/domain/labels';
import type { ScratchItem, ScratchType } from '@/domain/types';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { FilterTabs } from '@/components/ui/FilterTabs';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { LoadingState, StateMessage } from '@/components/ui/StateMessage';
import { ScratchComposer } from './ScratchComposer';
import { ScratchItemView } from './ScratchItemView';
import { PinScratchDialog } from './PinScratchDialog';
import styles from './ScratchPage.module.css';

type TypeFilter = 'all' | ScratchType;

export function ScratchPage() {
  const [filter, setFilter] = useState<TypeFilter>('all');
  const [pinTarget, setPinTarget] = useState<ScratchItem | null>(null);
  const scratch = useRepositoryData((repos) => repos.scratch.list(), []);

  const items = scratch.data ?? [];
  const volatileItems = items.filter((item) => !item.pinnedAt && (filter === 'all' || item.type === filter));
  const pinnedItems = items.filter((item) => item.pinnedAt);
  const presentTypes = [...new Set(items.filter((item) => !item.pinnedAt).map((item) => item.type))];

  return (
    <>
      <PageHeader eyebrow="임시함" title="임시 작업공간" searchPlaceholder="임시 자료 검색" />

      <div className={styles.layout}>
        <div className={styles.main}>
          <ScratchComposer size="large" autoFocus />
          <p className={styles.policy}>
            붙여넣은 자료는 12시간 동안 보관한 뒤 비워져요. 계속 필요한 자료는 업무, 프로젝트, 기록, 업무 지식 중 한 곳에 고정하세요.
          </p>

          <section aria-labelledby="scratch-volatile-title" className={styles.section}>
            <SectionHeader id="scratch-volatile-title" title="지금 담긴 자료" meta={`${volatileItems.length}개`} />
            <FilterTabs
              label="자료 종류"
              value={filter}
              onChange={setFilter}
              options={[{ value: 'all' as TypeFilter, label: '전체' }, ...presentTypes.map((type) => ({ value: type as TypeFilter, label: scratchTypeLabel[type] }))]}
            />
            {scratch.status === 'loading' && <LoadingState />}
            {scratch.status === 'error' && <StateMessage tone="error" title="임시 자료를 불러오지 못했어요." action={<Button size="sm" onClick={scratch.reload}>다시 시도</Button>} />}
            {scratch.status === 'success' && volatileItems.length === 0 && (
              <StateMessage title="비어 있어요." description="로그, 링크, 캡처, JSON을 위 입력란에 붙여넣으면 여기에 모여요." />
            )}
            <div className={styles.grid}>
              {volatileItems.map((item) => (
                <ScratchItemView key={item.id} item={item} onPin={setPinTarget} variant="page" />
              ))}
            </div>
          </section>
        </div>

        <aside className={styles.aside} aria-labelledby="scratch-pinned-title">
          <SectionHeader id="scratch-pinned-title" title="고정한 자료" meta={`${pinnedItems.length}개`} />
          {pinnedItems.length === 0 ? (
            <p className={styles.muted}>아직 고정한 자료가 없어요.</p>
          ) : (
            pinnedItems.map((item) => <ScratchItemView key={item.id} item={item} onPin={setPinTarget} />)
          )}
        </aside>
      </div>
      <PinScratchDialog item={pinTarget} onClose={() => setPinTarget(null)} />
    </>
  );
}
