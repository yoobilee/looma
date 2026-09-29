import { useState, type FormEvent } from 'react';
import { repositories } from '@/data';
import { deliverableTypeLabel } from '@/domain/labels';
import type { DeliverableType } from '@/domain/types';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { SelectField, TextField } from '@/components/ui/Field';
import styles from './DeliverableCreateDialog.module.css';

const linkTypes: DeliverableType[] = ['url', 'figma'];
const acceptByType: Partial<Record<DeliverableType, string>> = {
  pdf: '.pdf',
  xlsx: '.xlsx,.xls',
  csv: '.csv',
  docx: '.docx,.doc',
  image: 'image/*',
};

interface DeliverableCreateDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
}

export function DeliverableCreateDialog({ open, onClose, projectId }: DeliverableCreateDialogProps) {
  const [type, setType] = useState<DeliverableType>('pdf');
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [fileName, setFileName] = useState('');
  const [version, setVersion] = useState('');
  const isLink = linkTypes.includes(type);

  const reset = () => {
    setTitle('');
    setUrl('');
    setFileName('');
    setVersion('');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const resolvedTitle = title.trim() || fileName || url.trim();
    if (!resolvedTitle) return;
    await repositories.deliverables.create({
      projectId,
      type,
      title: resolvedTitle,
      sourceUrl: isLink ? url.trim() : undefined,
      fileRef: !isLink && fileName ? `local://${fileName}` : undefined,
      version: version.trim() || undefined,
    });
    reset();
    onClose();
  };

  const canSubmit = isLink ? /^https?:\/\//i.test(url.trim()) : !!(fileName || title.trim());

  return (
    <Dialog open={open} onClose={onClose} title="산출물 추가" description="요구사항 분석과 TC 설계의 근거가 됩니다." width="md">
      <form className={styles.form} onSubmit={(event) => void submit(event)}>
        <SelectField label="종류" value={type} onChange={(event) => setType(event.target.value as DeliverableType)}>
          {(Object.keys(deliverableTypeLabel) as DeliverableType[]).map((value) => (
            <option key={value} value={value}>
              {deliverableTypeLabel[value]}
            </option>
          ))}
        </SelectField>

        {isLink ? (
          <TextField
            label={type === 'figma' ? 'Figma 링크' : 'URL'}
            type="url"
            inputMode="url"
            placeholder="https://"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            hint={type === 'figma' ? '전체 파일보다 필요한 Page나 Frame 링크를 권장해요. 접근 권한이 있는 자료만 추가하세요.' : undefined}
          />
        ) : (
          <TextField
            label="파일"
            type="file"
            accept={acceptByType[type]}
            onChange={(event) => setFileName(event.target.files?.[0]?.name ?? '')}
            hint="지금은 파일 이름만 등록돼요. 내용 분석은 파일 파싱이 연결된 뒤 지원합니다."
          />
        )}

        <div className={styles.row}>
          <TextField label="표시 이름" placeholder={fileName || '비워두면 파일 이름을 사용해요'} value={title} onChange={(event) => setTitle(event.target.value)} />
          <TextField label="버전" placeholder="예: v1.5" value={version} onChange={(event) => setVersion(event.target.value)} />
        </div>

        <div className={styles.footer}>
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button type="submit" variant="primary" disabled={!canSubmit}>
            추가
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
