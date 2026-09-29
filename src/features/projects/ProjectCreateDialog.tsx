import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { repositories } from '@/data';
import { platformLabel, testScopeLabel } from '@/domain/labels';
import type { Platform, TestScope } from '@/domain/types';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { CheckboxGroup, TextAreaField, TextField } from '@/components/ui/Field';
import styles from './ProjectCreateDialog.module.css';

const platformOptions = (Object.keys(platformLabel) as Platform[]).map((value) => ({ value, label: platformLabel[value] }));
const scopeOptions = (Object.keys(testScopeLabel) as TestScope[]).map((value) => ({ value, label: testScopeLabel[value] }));

export function ProjectCreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [clientName, setClientName] = useState('');
  const [serviceName, setServiceName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [testScopes, setTestScopes] = useState<TestScope[]>(['functional']);
  const [description, setDescription] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    const project = await repositories.projects.create({
      name: name.trim(),
      clientName: clientName.trim() || undefined,
      serviceName: serviceName.trim() || undefined,
      startDate: startDate ? new Date(startDate).toISOString() : undefined,
      endDate: endDate ? new Date(endDate).toISOString() : undefined,
      platforms,
      testScopes,
      description: description.trim() || undefined,
    });
    onClose();
    navigate(`/projects/${project.id}`);
  };

  return (
    <Dialog open={open} onClose={onClose} title="새 프로젝트" description="이름만 있어도 시작할 수 있어요. 나머지는 나중에 채워도 돼요." width="lg">
      <form className={styles.form} onSubmit={(event) => void submit(event)}>
        <TextField label="프로젝트명" required value={name} onChange={(event) => setName(event.target.value)} placeholder="예: 고객사 C 결제 개편 QA" />
        <div className={styles.row}>
          <TextField label="고객사" value={clientName} onChange={(event) => setClientName(event.target.value)} />
          <TextField label="서비스" value={serviceName} onChange={(event) => setServiceName(event.target.value)} />
        </div>
        <div className={styles.row}>
          <TextField label="시작일" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
          <TextField label="종료일" type="date" value={endDate} min={startDate || undefined} onChange={(event) => setEndDate(event.target.value)} />
        </div>
        <CheckboxGroup legend="플랫폼" options={platformOptions} value={platforms} onChange={setPlatforms} />
        <CheckboxGroup legend="테스트 범위" options={scopeOptions} value={testScopes} onChange={setTestScopes} />
        <TextAreaField label="프로젝트 설명" value={description} onChange={(event) => setDescription(event.target.value)} hint="TC 양식 초안을 만들 때 참고해요." />
        <div className={styles.footer}>
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            만들기
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
