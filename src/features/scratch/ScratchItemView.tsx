import { ExternalLink, Pin, Trash2 } from 'lucide-react';
import { repositories } from '@/data';
import { scratchLinkLabel, scratchTypeLabel } from '@/domain/labels';
import type { ScratchItem } from '@/domain/types';
import { formatRemaining, formatTime } from '@/lib/date';
import { ProgressBar } from '@/components/ui/ProgressBar';
import styles from './ScratchItemView.module.css';

interface ScratchItemViewProps {
  item: ScratchItem;
  onPin: (item: ScratchItem) => void;
  variant?: 'panel' | 'page';
}

function remainingPercent(item: ScratchItem): number {
  if (!item.expiresAt) return 100;
  const total = new Date(item.expiresAt).getTime() - new Date(item.createdAt).getTime();
  const left = new Date(item.expiresAt).getTime() - Date.now();
  return total > 0 ? (left / total) * 100 : 0;
}

function toHref(content: string): string {
  return /^https?:\/\//i.test(content) ? content : `https://${content}`;
}

/** 임시 자료 한 건. 종류마다 미리보기 형태를 다르게 해 같은 카드가 반복되지 않게 한다. */
export function ScratchItemView({ item, onPin, variant = 'panel' }: ScratchItemViewProps) {
  const title = item.title ?? scratchTypeLabel[item.type];
  const body = item.type === 'text' || item.type === 'note' ? item.content.split('\n').slice(1).join(' ').trim() : '';

  return (
    <article className={`${styles.item} ${styles[variant]}`} aria-label={`${scratchTypeLabel[item.type]}: ${title}`}>
      <div className={styles.meta}>
        <span className={styles.type}>{scratchTypeLabel[item.type]}</span>
        <time dateTime={item.createdAt}>{formatTime(item.createdAt)}</time>
      </div>
      <h3 className={styles.title}>{title}</h3>

      {body && <p className={styles.body}>{body}</p>}
      {(item.type === 'log' || item.type === 'json') && <pre className={styles.code}>{item.content}</pre>}
      {item.type === 'url' && (
        <a className={styles.link} href={toHref(item.content)} target="_blank" rel="noopener noreferrer">
          {item.content.replace(/^https?:\/\//, '')}
          <ExternalLink aria-hidden />
          <span className="visually-hidden">(새 창)</span>
        </a>
      )}
      {item.type === 'image' && <img className={styles.image} src={item.content} alt={title} />}

      <div className={styles.footer}>
        {item.pinnedAt ? (
          <span className={styles.pinned}>
            <Pin aria-hidden /> 고정됨{item.linkedType ? ` · ${scratchLinkLabel[item.linkedType]}` : ''}
          </span>
        ) : (
          <div className={styles.expiry}>
            <ProgressBar value={remainingPercent(item)} size="thin" label="남은 보관 시간" />
            {item.expiresAt && <span>{formatRemaining(item.expiresAt)}</span>}
          </div>
        )}
        <div className={styles.actions}>
          {!item.pinnedAt && (
            <button type="button" className={styles.pinButton} onClick={() => onPin(item)}>
              고정
            </button>
          )}
          <button type="button" className={styles.remove} onClick={() => void repositories.scratch.remove(item.id)} aria-label={`${title} 삭제`}>
            <Trash2 aria-hidden />
          </button>
        </div>
      </div>
    </article>
  );
}
