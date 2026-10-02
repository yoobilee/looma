import { useState } from 'react';
import type { Deliverable, Issue, TestCase } from '@/domain/types';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import styles from './QuestionBundleDialog.module.css';

interface QuestionBundleDialogProps {
  open: boolean;
  onClose: () => void;
  projectName: string;
  questions: Issue[];
  deliverables: Deliverable[];
  /** 기능을 직접 고르지 않은 확인사항은 연결 TC의 기능으로 묶는다. */
  testCases: TestCase[];
}

/** 답변 대기 중인 확인사항을 기획자에게 보낼 수 있는 텍스트로 묶는다. (AI 없이 규칙 기반) */
export function QuestionBundleDialog({ open, onClose, projectName, questions, deliverables, testCases }: QuestionBundleDialogProps) {
  const [copied, setCopied] = useState(false);

  const lines = questions.map((question, index) => {
    const source = question.sourceRef ? deliverables.find((item) => item.id === question.sourceRef?.deliverableId) : undefined;
    const reference = source ? ` (근거: ${source.title} ${question.sourceRef?.locator})` : '';
    const feature = question.feature ?? testCases.find((item) => item.id === question.testCaseId)?.feature ?? '공통';
    return `${index + 1}. [${feature}] ${question.title}${reference}`;
  });
  const text = [`[${projectName}] 확인 요청드립니다.`, '', ...lines, '', '답변 주시면 TC 기대 결과에 반영하겠습니다.'].join('\n');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        setCopied(false);
        onClose();
      }}
      width="md"
      title="질문 묶음"
      description="메신저나 메일에 붙여넣어 한 번에 확인을 요청하세요."
      footer={
        <>
          <span className={styles.status} role="status" aria-live="polite">
            {copied ? '복사했어요.' : ''}
          </span>
          <Button variant="primary" onClick={() => void copy()}>
            복사하기
          </Button>
        </>
      }
    >
      <pre className={styles.preview}>{text}</pre>
    </Dialog>
  );
}
