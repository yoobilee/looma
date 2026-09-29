import { useState } from 'react';
import { Plus } from 'lucide-react';
import { repositories } from '@/data';
import { useRepositoryData } from '@/hooks/useRepositoryData';
import { defectStatuses, issueStatusLabel, questionStatuses } from '@/domain/labels';
import type { Deliverable, Issue, IssueStatus, TestCase } from '@/domain/types';
import { Button } from '@/components/ui/Button';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { LoadingState, StateMessage } from '@/components/ui/StateMessage';
import { useProjectContext } from '../projectContext';
import { IssueCreateDialog } from './IssueCreateDialog';
import { QuestionBundleDialog } from './QuestionBundleDialog';
import styles from './IssuesTab.module.css';

function IssueLinks({ issue, testCases, deliverables }: { issue: Issue; testCases: TestCase[]; deliverables: Deliverable[] }) {
  const testCase = testCases.find((item) => item.id === issue.testCaseId);
  const source = issue.sourceRef ? deliverables.find((item) => item.id === issue.sourceRef?.deliverableId) : undefined;
  const parts = [
    issue.feature && `기능 ${issue.feature}`,
    testCase && `연결 TC ${testCase.externalId}`,
    source && `근거 ${source.type === 'figma' ? 'Figma' : source.type.toUpperCase()} ${issue.sourceRef?.locator}`,
  ].filter(Boolean);
  return parts.length ? <p className={styles.links}>{parts.join(' · ')}</p> : null;
}

function StatusSelect({ issue, options }: { issue: Issue; options: IssueStatus[] }) {
  return (
    <label className={styles.statusSelect}>
      <span className="visually-hidden">{issue.title} 상태</span>
      <select
        value={issue.status}
        className={styles[`status_${issue.status}`]}
        onChange={(event) => void repositories.issues.updateStatus(issue.id, event.target.value as IssueStatus)}
      >
        {options.map((status) => (
          <option key={status} value={status}>
            {issueStatusLabel[status]}
          </option>
        ))}
      </select>
    </label>
  );
}

/** 결함(이슈)과 기획/정책 확인사항을 분리해서 관리한다. */
export function IssuesTab() {
  const { project } = useProjectContext();
  const [createType, setCreateType] = useState<Issue['type'] | null>(null);
  const [bundleOpen, setBundleOpen] = useState(false);
  const data = useRepositoryData(
    async (repos) => ({
      issues: await repos.issues.listByProject(project.id),
      testCases: await repos.testCases.listByProject(project.id),
      deliverables: await repos.deliverables.listByProject(project.id),
    }),
    [project.id],
  );

  if (data.status === 'loading') return <LoadingState />;
  if (data.status === 'error') return <StateMessage tone="error" title="이슈를 불러오지 못했어요." />;

  const { issues, testCases, deliverables } = data.data;
  const defects = issues.filter((issue) => issue.type === 'defect');
  const questions = issues.filter((issue) => issue.type === 'question');
  const openQuestions = questions.filter((issue) => issue.status !== 'answered');

  return (
    <div className={styles.layout}>
      <section aria-labelledby="defects-title">
        <SectionHeader
          id="defects-title"
          title="이슈"
          meta={`${defects.filter((issue) => issue.status !== 'closed').length}건 진행 중 · 전체 ${defects.length}`}
          action={
            <Button size="sm" variant="secondary" icon={<Plus aria-hidden />} onClick={() => setCreateType('defect')}>
              이슈 등록
            </Button>
          }
        />
        {defects.length === 0 ? (
          <StateMessage compact title="등록된 이슈가 없어요." />
        ) : (
          <ul className={styles.list}>
            {defects.map((issue) => (
              <li key={issue.id} className={`${styles.item} ${issue.status === 'closed' ? styles.closed : ''}`}>
                <div className={styles.itemHead}>
                  <span className={styles.key}>{issue.externalKey ?? '내부 이슈'}</span>
                  <StatusSelect issue={issue} options={defectStatuses} />
                </div>
                <p className={styles.title}>{issue.title}</p>
                <IssueLinks issue={issue} testCases={testCases} deliverables={deliverables} />
                {issue.note && <p className={styles.note}>{issue.note}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="questions-title" className={styles.questions}>
        <SectionHeader
          id="questions-title"
          title="확인사항"
          meta={`${openQuestions.length}개 대기`}
          metaTone="coral"
          action={
            <Button size="sm" variant="ghost" icon={<Plus aria-hidden />} onClick={() => setCreateType('question')} aria-label="확인사항 추가">
              추가
            </Button>
          }
        />
        <p className={styles.caption}>요구사항 분석에서 &lsquo;확인 필요&rsquo;로 나온 항목을 보내거나 직접 추가할 수 있어요.</p>
        <ul className={styles.questionList}>
          {questions.map((issue) => (
            <li key={issue.id} className={`${styles.question} ${issue.status === 'answered' ? styles.answered : ''}`}>
              <p className={styles.title}>{issue.title}</p>
              {issue.note && <p className={styles.note}>{issue.note}</p>}
              <IssueLinks issue={issue} testCases={testCases} deliverables={deliverables} />
              <StatusSelect issue={issue} options={questionStatuses} />
            </li>
          ))}
        </ul>
        <button type="button" className={styles.bundle} onClick={() => setBundleOpen(true)} disabled={openQuestions.length === 0}>
          <strong>질문 묶음 만들기</strong>
          <span>답변 대기 중인 확인사항 {openQuestions.length}개를 한 번에 정리</span>
        </button>
      </section>

      {createType && (
        <IssueCreateDialog open type={createType} projectId={project.id} testCases={testCases} onClose={() => setCreateType(null)} key={createType} />
      )}
      <QuestionBundleDialog open={bundleOpen} onClose={() => setBundleOpen(false)} projectName={project.name} questions={openQuestions} deliverables={deliverables} />
    </div>
  );
}
