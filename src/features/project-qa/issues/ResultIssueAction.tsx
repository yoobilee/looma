import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { issueStatusLabel, issueTypeLabel } from '@/domain/labels';
import type { Issue } from '@/domain/types';
import { Button } from '@/components/ui/Button';
import { issuePath } from './issueView';
import styles from './ResultIssueAction.module.css';

interface ResultIssueActionProps {
  projectId: string;
  /** 이 결과(들)에 이미 연결된 항목. 있어도 새로 만들 수 있다. */
  linked: Issue[];
  /** 스크린 리더용 대상 이름(TC ID · 플랫폼 등) */
  target: string;
  onCreate: () => void;
}

/** 수행 결과 행의 이슈 · 확인사항 동작: 이미 연결된 항목으로 가는 링크와 새로 만들기 버튼 */
export function ResultIssueAction({ projectId, linked, target, onCreate }: ResultIssueActionProps) {
  return (
    <span className={styles.action}>
      {linked.map((issue) => (
        <Link key={issue.id} to={issuePath(projectId, issue.id)} className={styles.link} title={issue.title}>
          {issueTypeLabel[issue.type]} · {issueStatusLabel[issue.status]}
        </Link>
      ))}
      <Button size="sm" variant="ghost" icon={<Plus aria-hidden />} onClick={onCreate} aria-label={`${target} 이슈 / 확인사항 만들기`}>
        이슈 / 확인사항
      </Button>
    </span>
  );
}
