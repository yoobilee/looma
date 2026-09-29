import { useState } from 'react';
import { repositories } from '@/data';
import { useRepositoryData } from '@/hooks/useRepositoryData';
import { scratchLinkLabel } from '@/domain/labels';
import type { ScratchItem, ScratchLinkTarget } from '@/domain/types';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { SelectField } from '@/components/ui/Field';
import styles from './PinScratchDialog.module.css';

const targets: { value: ScratchLinkTarget; description: string }[] = [
  { value: 'task', description: '진행 중인 업무의 참고 자료로 남겨요.' },
  { value: 'project', description: '프로젝트 기록에서 다시 찾을 수 있어요.' },
  { value: 'record', description: '오늘 기록에 남기고 만료되지 않게 해요.' },
  { value: 'knowledge', description: '업무 지식에 새 용어 초안으로 저장해요.' },
];

interface PinScratchDialogProps {
  item: ScratchItem | null;
  onClose: () => void;
}

export function PinScratchDialog({ item, onClose }: PinScratchDialogProps) {
  const [target, setTarget] = useState<ScratchLinkTarget>('record');
  const [targetId, setTargetId] = useState('');
  const [saving, setSaving] = useState(false);
  const options = useRepositoryData(
    async (repos) => ({
      tasks: (await repos.tasks.list()).filter((task) => task.status !== 'done'),
      projects: (await repos.projects.list()).filter((project) => project.status !== 'archived'),
    }),
    [],
  );

  const needsTarget = target === 'task' || target === 'project';
  const choices = target === 'task' ? options.data?.tasks.map((task) => ({ id: task.id, label: task.title })) : options.data?.projects.map((project) => ({ id: project.id, label: project.name }));
  const selectedId = targetId || (target === 'project' ? item?.contextProjectId : undefined) || choices?.[0]?.id || '';

  const submit = async () => {
    if (!item) return;
    setSaving(true);
    try {
      await repositories.scratch.pin(item.id, target, needsTarget ? selectedId : undefined);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={!!item}
      onClose={onClose}
      title="어디에 고정할까요?"
      description="고정한 자료는 만료되지 않아요."
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={saving || (needsTarget && !selectedId)}>
            고정하기
          </Button>
        </>
      }
    >
      <fieldset className={styles.targets}>
        <legend className="visually-hidden">고정 위치</legend>
        {targets.map((option) => (
          <label key={option.value} className={`${styles.target} ${target === option.value ? styles.selected : ''}`}>
            <input
              type="radio"
              name="scratch-pin-target"
              value={option.value}
              checked={target === option.value}
              onChange={() => {
                setTarget(option.value);
                setTargetId('');
              }}
            />
            <span>
              <strong>{scratchLinkLabel[option.value]}</strong>
              <small>{option.description}</small>
            </span>
          </label>
        ))}
      </fieldset>

      {needsTarget && (
        <div className={styles.choice}>
          <SelectField label={target === 'task' ? '연결할 업무' : '연결할 프로젝트'} value={selectedId} onChange={(event) => setTargetId(event.target.value)}>
            {choices?.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </SelectField>
        </div>
      )}
    </Dialog>
  );
}
