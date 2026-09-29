import { useId, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { repositories } from '@/data';
import { detectScratchType, deriveScratchTitle } from '@/domain/scratchDetection';
import { scratchTypeLabel } from '@/domain/labels';
import type { ScratchType } from '@/domain/types';
import { Button } from '@/components/ui/Button';
import styles from './ScratchComposer.module.css';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const selectableTypes: ScratchType[] = ['text', 'url', 'log', 'json', 'note'];

interface ScratchComposerProps {
  contextProjectId?: string;
  size?: 'compact' | 'large';
  autoFocus?: boolean;
}

/** 임시 작업공간 입력. 붙여넣으면 종류를 추정하고, 이미지는 바로 저장한다. */
export function ScratchComposer({ contextProjectId, size = 'compact', autoFocus }: ScratchComposerProps) {
  const [content, setContent] = useState('');
  const [typeOverride, setTypeOverride] = useState<ScratchType | null>(null);
  const [message, setMessage] = useState('');
  const inputId = useId();
  const hintId = useId();

  const detectedType = detectScratchType(content);
  const type = typeOverride ?? detectedType;

  const save = async () => {
    const trimmed = content.trim();
    if (!trimmed) return;
    await repositories.scratch.create({ type, content: trimmed, title: deriveScratchTitle(trimmed, type), contextProjectId });
    setContent('');
    setTypeOverride(null);
    setMessage(`${scratchTypeLabel[type]} 자료를 임시함에 담았어요.`);
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const file = [...event.clipboardData.files].find((item) => item.type.startsWith('image/'));
    if (!file) return;
    event.preventDefault();
    if (file.size > MAX_IMAGE_BYTES) {
      setMessage('2MB보다 큰 이미지는 아직 담을 수 없어요.');
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      await repositories.scratch.create({ type: 'image', content: String(reader.result), title: '붙여넣은 이미지', contextProjectId });
      setMessage('이미지를 임시함에 담았어요.');
    };
    reader.readAsDataURL(file);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void save();
    }
  };

  return (
    <div className={`${styles.composer} ${styles[size]}`}>
      <label htmlFor={inputId} className={styles.label}>
        무엇이든 붙여넣기
      </label>
      <textarea
        id={inputId}
        className={styles.input}
        value={content}
        placeholder="텍스트 · 이미지 · 링크 · JSON · 로그"
        aria-describedby={hintId}
        autoFocus={autoFocus}
        onChange={(event) => {
          setContent(event.target.value);
          setMessage('');
        }}
        onPaste={handlePaste}
        onKeyDown={handleKeyDown}
      />
      <p id={hintId} className="visually-hidden">
        Ctrl 또는 Command와 Enter를 함께 누르면 저장해요. 이미지는 붙여넣는 즉시 저장돼요.
      </p>

      {content.trim() && (
        <div className={styles.footer}>
          <label className={styles.typeSelect}>
            <span className="visually-hidden">자료 종류</span>
            <select value={type} onChange={(event) => setTypeOverride(event.target.value as ScratchType)}>
              {selectableTypes.map((option) => (
                <option key={option} value={option}>
                  {scratchTypeLabel[option]}
                  {option === detectedType && !typeOverride ? ' (자동 감지)' : ''}
                </option>
              ))}
            </select>
          </label>
          <Button size="sm" variant="primary" onClick={() => void save()}>
            임시함에 담기
          </Button>
        </div>
      )}
      <p className={styles.message} role="status" aria-live="polite">
        {message}
      </p>
    </div>
  );
}
