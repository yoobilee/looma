import { useState } from 'react';
import { mapRawResult } from '@/domain/resultSummary';
import { testResultLabel, testResultOrder } from '@/domain/labels';
import type { ResultMapping, TCTemplate, TestResultValue } from '@/domain/types';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/Field';
import { defaultResultMappings } from '../test-design/templateDraft';
import styles from './ResultUploadDialog.module.css';

// 파일 파싱 전까지 고객사 양식에서 흔히 쓰는 상태값을 후보로 보여준다.
const sampleRawValues = ['P', 'F', 'B', 'N/T', 'OK', 'NG'];

interface ResultUploadDialogProps {
  open: boolean;
  onClose: () => void;
  template?: TCTemplate;
}

/** 수행 완료 파일 업로드 + 고객사 상태값 매핑을 사용자가 한 번 확인한다. */
export function ResultUploadDialog({ open, onClose, template }: ResultUploadDialogProps) {
  const known = template?.resultMappings ?? defaultResultMappings;
  const [fileName, setFileName] = useState('');
  const [mappings, setMappings] = useState<Record<string, TestResultValue | ''>>(() =>
    Object.fromEntries(sampleRawValues.map((raw) => [raw, mapRawResult(raw, known) ?? guess(raw)])),
  );
  const [confirmed, setConfirmed] = useState(false);

  const unmapped = Object.values(mappings).filter((value) => !value).length;

  const close = () => {
    setConfirmed(false);
    setFileName('');
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      width="md"
      title="수행 결과 업로드"
      description="고객사 양식에서 수행을 마친 파일을 올리고, 상태값이 어떻게 읽힐지 한 번 확인해요."
      footer={
        confirmed ? (
          <Button variant="primary" onClick={close}>
            닫기
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              취소
            </Button>
            <Button variant="primary" disabled={!fileName || unmapped > 0} onClick={() => setConfirmed(true)}>
              매핑 확인
            </Button>
          </>
        )
      }
    >
      {confirmed ? (
        <div className={styles.done} role="status">
          <p className={styles.doneTitle}>매핑을 확인했어요.</p>
          <p>
            파일 파싱은 다음 단계에서 연결돼요. 연결되면 <strong>{fileName}</strong>의 결과가 새 차수로 추가되고, 확인한 매핑이 이 고객사 Template에 저장됩니다.
          </p>
        </div>
      ) : (
        <div className={styles.body}>
          <TextField label="수행 완료 파일" type="file" accept=".xlsx,.xls,.csv" onChange={(event) => setFileName(event.target.files?.[0]?.name ?? '')} />

          <fieldset className={styles.mapping}>
            <legend>상태값 매핑</legend>
            <p className={styles.hint}>고객사마다 결과 표기가 달라요. 파일에서 발견될 값을 표준 결과로 연결하세요.</p>
            <div className={styles.rows}>
              {sampleRawValues.map((raw) => (
                <label key={raw} className={styles.row}>
                  <span className={styles.raw}>{raw}</span>
                  <span aria-hidden>→</span>
                  <select
                    value={mappings[raw]}
                    onChange={(event) => setMappings((current) => ({ ...current, [raw]: event.target.value as TestResultValue | '' }))}
                    aria-label={`${raw} 값의 표준 결과`}
                  >
                    <option value="">선택</option>
                    {testResultOrder.map((value) => (
                      <option key={value} value={value}>
                        {testResultLabel[value]}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      )}
    </Dialog>
  );
}

function guess(raw: string): TestResultValue | '' {
  const known: ResultMapping[] = [
    { rawValue: 'OK', result: 'pass' },
    { rawValue: 'NG', result: 'fail' },
  ];
  return mapRawResult(raw, known) ?? '';
}
