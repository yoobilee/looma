import { useState, type FormEvent } from 'react';
import { repositories } from '@/data';
import type { Project } from '@/domain/types';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { CheckboxGroup, TextAreaField, TextField } from '@/components/ui/Field';
import styles from './TermCreateDialog.module.css';

interface TermCreateDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
  projects: Project[];
}

export function TermCreateDialog({ open, onClose, onCreated, projects }: TermCreateDialogProps) {
  const [term, setTerm] = useState('');
  const [explanation, setExplanation] = useState('');
  const [workMeaning, setWorkMeaning] = useState('');
  const [example, setExample] = useState('');
  const [tags, setTags] = useState('');
  const [projectIds, setProjectIds] = useState<string[]>([]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!term.trim()) return;
    const created = await repositories.knowledge.create({
      term: term.trim(),
      explanation: explanation.trim(),
      workMeaning: workMeaning.trim() || undefined,
      examples: example.trim() ? [example.trim()] : [],
      relatedProjectIds: projectIds,
      tags: tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    });
    setTerm('');
    setExplanation('');
    setWorkMeaning('');
    setExample('');
    setTags('');
    setProjectIds([]);
    onCreated(created.id);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width="md"
      title="새 용어 추가"
      description="AI 설명 초안은 연결 후 제공돼요. 지금은 직접 정리해 두세요."
    >
      <form className={styles.form} onSubmit={(event) => void submit(event)}>
        <TextField label="용어" required value={term} onChange={(event) => setTerm(event.target.value)} placeholder="예: 스테이징, D-1 배포" />
        <TextAreaField label="쉬운 설명" value={explanation} onChange={(event) => setExplanation(event.target.value)} />
        <TextAreaField label="업무에서의 의미" value={workMeaning} onChange={(event) => setWorkMeaning(event.target.value)} />
        <TextField label="예시" value={example} onChange={(event) => setExample(event.target.value)} />
        {projects.length > 0 && (
          <CheckboxGroup
            legend="관련 프로젝트"
            options={projects.map((project) => ({ value: project.id, label: project.name }))}
            value={projectIds}
            onChange={setProjectIds}
          />
        )}
        <TextField label="태그" value={tags} onChange={(event) => setTags(event.target.value)} hint="쉼표로 구분해요." />
        <div className={styles.footer}>
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button type="submit" variant="primary" disabled={!term.trim()}>
            저장
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
