import { useState, type FormEvent } from 'react';
import { repositories } from '@/data';
import { useRepositoryData } from '@/hooks/useRepositoryData';
import { taskRepeatLabel } from '@/domain/labels';
import type { TaskRepeat } from '@/domain/types';
import { Button } from '@/components/ui/Button';
import { SelectField, TextAreaField, TextField } from '@/components/ui/Field';
import styles from './TaskCreateForm.module.css';

type OptionalField = 'due' | 'project' | 'notes' | 'repeat';

const optionalFieldLabel: Record<OptionalField, string> = {
  due: '날짜 / 시간',
  project: '프로젝트',
  notes: '메모',
  repeat: '반복',
};

interface TaskCreateFormProps {
  defaultProjectId?: string;
  defaultTitle?: string;
  autoFocus?: boolean;
  onCreated?: () => void;
}

/** 제목만 입력해도 생성되고, 필요한 필드만 펼쳐서 추가한다. */
export function TaskCreateForm({ defaultProjectId, defaultTitle = '', autoFocus, onCreated }: TaskCreateFormProps) {
  const [title, setTitle] = useState(defaultTitle);
  const [openFields, setOpenFields] = useState<OptionalField[]>(defaultProjectId ? ['project'] : []);
  const [dueAt, setDueAt] = useState('');
  const [projectId, setProjectId] = useState(defaultProjectId ?? '');
  const [notes, setNotes] = useState('');
  const [repeat, setRepeat] = useState<TaskRepeat>('none');
  const [status, setStatus] = useState('');
  const projects = useRepositoryData((repos) => repos.projects.list(), []);

  const toggleField = (field: OptionalField) =>
    setOpenFields((current) => (current.includes(field) ? current.filter((item) => item !== field) : [...current, field]));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) {
      setStatus('업무 제목을 입력해 주세요.');
      return;
    }
    await repositories.tasks.create({
      title,
      dueAt: openFields.includes('due') && dueAt ? new Date(dueAt).toISOString() : undefined,
      projectId: openFields.includes('project') && projectId ? projectId : undefined,
      notes: openFields.includes('notes') && notes.trim() ? notes.trim() : undefined,
      repeat: openFields.includes('repeat') ? repeat : 'none',
    });
    setStatus(`"${title.trim()}" 업무를 추가했어요.`);
    setTitle('');
    setNotes('');
    onCreated?.();
  };

  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)}>
      <TextField
        label="업무 제목"
        hideLabel
        placeholder="새 업무 입력…"
        value={title}
        autoFocus={autoFocus}
        onChange={(event) => setTitle(event.target.value)}
      />

      <div className={styles.optional}>
        <p className={styles.optionalLabel}>필요할 때만 추가</p>
        <div className={styles.toggles}>
          {(Object.keys(optionalFieldLabel) as OptionalField[]).map((field) => (
            <button
              key={field}
              type="button"
              className={`${styles.toggle} ${openFields.includes(field) ? styles.toggleOn : ''}`}
              aria-pressed={openFields.includes(field)}
              onClick={() => toggleField(field)}
            >
              {optionalFieldLabel[field]}
            </button>
          ))}
        </div>
      </div>

      {openFields.includes('due') && <TextField label="날짜와 시간" type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />}
      {openFields.includes('project') && (
        <SelectField label="프로젝트" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
          <option value="">개인 업무</option>
          {projects.data?.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </SelectField>
      )}
      {openFields.includes('notes') && <TextAreaField label="메모" value={notes} onChange={(event) => setNotes(event.target.value)} />}
      {openFields.includes('repeat') && (
        <SelectField label="반복" value={repeat} onChange={(event) => setRepeat(event.target.value as TaskRepeat)}>
          {(Object.keys(taskRepeatLabel) as TaskRepeat[]).map((option) => (
            <option key={option} value={option}>
              {taskRepeatLabel[option]}
            </option>
          ))}
        </SelectField>
      )}

      <div className={styles.footer}>
        <p className={styles.status} role="status" aria-live="polite">
          {status}
        </p>
        <Button type="submit" variant="primary" disabled={!title.trim()}>
          업무 추가
        </Button>
      </div>
    </form>
  );
}
