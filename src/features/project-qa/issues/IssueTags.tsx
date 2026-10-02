import { issueStatusLabel, issueTypeLabel } from '@/domain/labels';
import type { IssueStatus, IssueType } from '@/domain/types';
import { Tag, type TagTone } from '@/components/ui/Tag';

const typeTone: Record<IssueType, TagTone> = { defect: 'neutral', question: 'sky' };
// 확인 필요가 가장 눈에 띄고, 보류 · 해결됨은 한발 물러선다.
const statusTone: Record<IssueStatus, TagTone> = { open: 'coral', deferred: 'untested', resolved: 'pass' };

export function IssueTypeTag({ type }: { type: IssueType }) {
  return <Tag tone={typeTone[type]}>{issueTypeLabel[type]}</Tag>;
}

export function IssueStatusTag({ status }: { status: IssueStatus }) {
  return <Tag tone={statusTone[status]}>{issueStatusLabel[status]}</Tag>;
}
