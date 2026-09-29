import { useState, type FormEvent } from 'react';
import { repositories } from '@/data';
import type { IssueType, TestCase } from '@/domain/types';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { SelectField, TextAreaField, TextField } from '@/components/ui/Field';
import styles from './IssueCreateDialog.module.css';

interface IssueCreateDialogProps {
  open: boolean;
  type: IssueType;
  projectId: string;
  testCases: TestCase[];
  onClose: () => void;
}

export function IssueCreateDialog({ open, type, projectId, testCases, onClose }: IssueCreateDialogProps) {
  const [title, setTitle] = useState('');
  const [testCaseId, setTestCaseId] = useState('');
  const [note, setNote] = useState('');
  const features = [...new Set(testCases.map((item) => item.feature))];
  const [feature, setFeature] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    const linked = testCases.find((item) => item.id === testCaseId);
    await repositories.issues.create({
      projectId,
      type,
      title: title.trim(),
      feature: feature || linked?.feature || undefined,
      testCaseId: testCaseId || undefined,
      note: note.trim() || undefined,
    });
    onClose();
  };

  const isDefect = type === 'defect';

  return (
    <Dialog open={open} onClose={onClose} width="md" title={isDefect ? '이슈 등록' : '확인사항 추가'} description={isDefect ? '결함을 기능·TC와 연결해 두면 재수행 목록에서 바로 찾을 수 있어요.' : '기획·정책에 물어볼 내용을 남겨요.'}>
      <form className={styles.form} onSubmit={(event) => void submit(event)}>
        <TextField label={isDefect ? '이슈 제목' : '확인할 내용'} required value={title} onChange={(event) => setTitle(event.target.value)} />
        <div className={styles.row}>
          <SelectField label="기능" value={feature} onChange={(event) => setFeature(event.target.value)}>
            <option value="">선택 안 함</option>
            {features.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </SelectField>
          <SelectField label="연결 TC" value={testCaseId} onChange={(event) => setTestCaseId(event.target.value)}>
            <option value="">선택 안 함</option>
            {testCases.map((item) => (
              <option key={item.id} value={item.id}>
                {item.externalId} {item.title}
              </option>
            ))}
          </SelectField>
        </div>
        <TextAreaField label={isDefect ? '재현 경로 · 메모' : '메모'} value={note} onChange={(event) => setNote(event.target.value)} />
        <div className={styles.footer}>
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button type="submit" variant="primary" disabled={!title.trim()}>
            {isDefect ? '등록' : '추가'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
