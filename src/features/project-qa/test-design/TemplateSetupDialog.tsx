import { useState, type FormEvent } from 'react';
import { repositories } from '@/data';
import { testResultLabel } from '@/domain/labels';
import type { Project, TCTemplate } from '@/domain/types';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { CheckboxGroup, TextField } from '@/components/ui/Field';
import { Tag } from '@/components/ui/Tag';
import { draftTemplateFromProject } from './templateDraft';
import styles from './TemplateSetupDialog.module.css';

type TemplateOption = 'keep_columns' | 'keep_id_rule' | 'refer_depth' | 'refer_style' | 'check_duplicates';

const optionLabels: Record<TemplateOption, string> = {
  keep_columns: '컬럼 구조 유지',
  keep_id_rule: 'ID 규칙 유지',
  refer_depth: 'Depth 구성 참고',
  refer_style: '기존 TC 문장 스타일 참고',
  check_duplicates: '중복 검사',
};

export type TemplateSetupMode = 'existing_tc' | 'description';

interface TemplateSetupDialogProps {
  open: boolean;
  mode: TemplateSetupMode;
  project: Project;
  currentTemplate?: TCTemplate;
  onClose: () => void;
}

/**
 * 기존 TC 파일에서 고객사 Template을 감지하거나, 프로젝트 설명으로 양식 초안을 만든다.
 * 파일 파싱이 연결되기 전에는 감지 결과를 예시로 보여주고, 저장 전 사용자가 확인한다.
 */
export function TemplateSetupDialog({ open, mode, project, currentTemplate, onClose }: TemplateSetupDialogProps) {
  const [fileName, setFileName] = useState('');
  const [options, setOptions] = useState<TemplateOption[]>(['keep_columns', 'keep_id_rule', 'refer_depth', 'check_duplicates']);
  const [name, setName] = useState(currentTemplate?.name ?? `${project.clientName ?? project.name} TC 양식`);

  const detected = currentTemplate ?? draftTemplateFromProject(project);
  const showDetection = mode === 'description' || !!fileName || !!currentTemplate;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await repositories.templates.saveForProject(project.id, {
      ...detected,
      name: name.trim() || detected.name,
      styleHints: options.includes('refer_style') ? detected.styleHints : undefined,
      idRule: options.includes('keep_id_rule') ? detected.idRule : undefined,
      depthRule: options.includes('refer_depth') ? detected.depthRule : undefined,
    });
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width="lg"
      title={mode === 'description' ? '프로젝트 설명으로 TC 양식 만들기' : '기존 TC로 고객사 Template 설정'}
      description={
        mode === 'description'
          ? '프로젝트 플랫폼과 테스트 범위로 컬럼 · Depth · 결과 구조 초안을 만들어요.'
          : '업로드한 XLSX/CSV에서 컬럼 구조, ID 규칙, Depth, 결과 컬럼과 상태값을 감지해요.'
      }
    >
      <form className={styles.form} onSubmit={(event) => void submit(event)}>
        {mode === 'existing_tc' && (
          <TextField
            label="기존 TC 파일"
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={(event) => setFileName(event.target.files?.[0]?.name ?? '')}
            hint="파일 파싱은 다음 단계에서 연결돼요. 지금은 저장된 감지 결과를 예시로 보여줘요."
          />
        )}

        {showDetection && (
          <section className={styles.detection} aria-labelledby="template-detection-title">
            <div className={styles.detectionHeader}>
              <h3 id="template-detection-title">감지된 구조</h3>
              <Tag tone="outline">{mode === 'description' ? '규칙 기반 초안 · 검토 필요' : '예시 감지 결과 · 검토 필요'}</Tag>
            </div>
            <dl className={styles.facts}>
              <div>
                <dt>컬럼</dt>
                <dd className={styles.columns}>
                  {detected.columns.map((column) => (
                    <span key={column}>{column}</span>
                  ))}
                </dd>
              </div>
              <div>
                <dt>ID 규칙</dt>
                <dd>{detected.idRule ?? '감지되지 않음'}</dd>
              </div>
              <div>
                <dt>Depth</dt>
                <dd>{detected.depthRule ?? '감지되지 않음'}</dd>
              </div>
              <div>
                <dt>작성 문체</dt>
                <dd>{detected.styleHints ?? '감지되지 않음'}</dd>
              </div>
              <div>
                <dt>결과 상태값</dt>
                <dd>
                  {detected.resultMappings.map((mapping) => `${mapping.rawValue} → ${testResultLabel[mapping.result]}`).join(' · ')}
                </dd>
              </div>
            </dl>
          </section>
        )}

        <CheckboxGroup
          legend="새 TC 설계에 적용할 옵션"
          options={(Object.keys(optionLabels) as TemplateOption[]).map((value) => ({ value, label: optionLabels[value] }))}
          value={options}
          onChange={setOptions}
        />
        <TextField label="Template 이름" value={name} onChange={(event) => setName(event.target.value)} hint="고객사 Template으로 저장하면 이 프로젝트의 TC 초안과 내보내기에 우선 적용돼요." />

        <div className={styles.footer}>
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button type="submit" variant="primary" disabled={!showDetection}>
            Template으로 저장
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
