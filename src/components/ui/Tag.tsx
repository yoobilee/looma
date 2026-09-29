import type { ReactNode } from 'react';
import type { SourceType, TestResultValue } from '@/domain/types';
import { requirementSourceLabel, testResultLabel } from '@/domain/labels';
import styles from './Tag.module.css';

export type TagTone = 'neutral' | 'sky' | 'coral' | 'pass' | 'fail' | 'blocked' | 'untested' | 'outline';

export function Tag({ tone = 'neutral', children, title }: { tone?: TagTone; children: ReactNode; title?: string }) {
  return (
    <span className={`${styles.tag} ${styles[tone]}`} title={title}>
      {children}
    </span>
  );
}

const sourceTone: Record<SourceType, TagTone> = {
  source_explicit: 'sky',
  ai_suggestion: 'outline',
  needs_confirmation: 'coral',
};

/** 산출물 직접 명시 / AI 제안 / 확인 필요 구분 */
export function SourceTypeTag({ sourceType, label }: { sourceType: SourceType; label?: string }) {
  return <Tag tone={sourceTone[sourceType]}>{label ?? requirementSourceLabel[sourceType]}</Tag>;
}

const resultTone: Record<TestResultValue, TagTone> = {
  pass: 'pass',
  fail: 'fail',
  blocked: 'blocked',
  not_tested: 'untested',
};

export function ResultTag({ result }: { result: TestResultValue }) {
  return <Tag tone={resultTone[result]}>{testResultLabel[result]}</Tag>;
}
