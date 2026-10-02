import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { MessageSquareText, Plus } from 'lucide-react';
import { useRepositoryData } from '@/hooks/useRepositoryData';
import { laterResultsFor } from '@/domain/issues';
import { issueStatusLabel, issueTypeLabel, platformLabel } from '@/domain/labels';
import type { IssueType } from '@/domain/types';
import { formatShortDate } from '@/lib/date';
import { Button } from '@/components/ui/Button';
import { FilterTabs } from '@/components/ui/FilterTabs';
import { ResultTag } from '@/components/ui/Tag';
import { LoadingState, StateMessage } from '@/components/ui/StateMessage';
import { useProjectContext } from '../projectContext';
import { IssueCreateDialog } from './IssueCreateDialog';
import { IssueDetailDialog } from './IssueDetailDialog';
import { IssueStatusTag, IssueTypeTag } from './IssueTags';
import { indexIssueLinks, isIssueFilter, issueFilters, loadIssueContext, matchesIssueFilter, sortIssues, type IssueFilter } from './issueView';
import { QuestionBundleDialog } from './QuestionBundleDialog';
import styles from './IssuesTab.module.css';

const filterLabel: Record<IssueFilter, string> = {
  all: '전체',
  defect: issueTypeLabel.defect,
  question: issueTypeLabel.question,
  open: issueStatusLabel.open,
  resolved: issueStatusLabel.resolved,
  deferred: issueStatusLabel.deferred,
};

/**
 * 이슈(결함)와 확인사항(사양 · 기획 · 정책 확인)을 한 목록에서 추적한다.
 * 필터(`?filter=`)와 열어 둔 항목(`?issue=`)은 주소에 남겨 새로 고쳐도 · 다른 화면에서 링크로 와도 같은 화면이다.
 */
export function IssuesTab() {
  const { project } = useProjectContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedFilter = searchParams.get('filter');
  const filter: IssueFilter = isIssueFilter(requestedFilter) ? requestedFilter : 'all';
  const openIssueId = searchParams.get('issue');
  const [createType, setCreateType] = useState<IssueType | null>(null);
  const [bundleOpen, setBundleOpen] = useState(false);
  const data = useRepositoryData(
    async (repos) => ({ ...(await loadIssueContext(repos, project.id)), deliverables: await repos.deliverables.listByProject(project.id) }),
    [project.id],
  );

  if (data.status === 'loading' && !data.data) return <LoadingState />;
  if (!data.data) return <StateMessage tone="error" title="이슈를 불러오지 못했어요." />;

  const { issues, testCases, imports, results, deliverables } = data.data;
  const links = indexIssueLinks({ testCases, imports, results });
  const sorted = sortIssues(issues);
  const visible = sorted.filter((issue) => matchesIssueFilter(issue, filter));
  const openQuestions = sorted.filter((issue) => issue.type === 'question' && issue.status === 'open');
  const openIssue = openIssueId ? issues.find((issue) => issue.id === openIssueId) : undefined;
  const openLinks = openIssue && links.linksOf(openIssue);

  const params = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    return next;
  };

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <div className={styles.filters}>
          <FilterTabs
            label="이슈 / 확인사항 보기"
            value={filter}
            onChange={(value) => setSearchParams(params({ filter: value === 'all' ? null : value }), { replace: true })}
            options={issueFilters.map((value) => ({ value, label: filterLabel[value], count: issues.filter((issue) => matchesIssueFilter(issue, value)).length }))}
          />
        </div>
        <div className={styles.actions}>
          <Button size="sm" variant="ghost" icon={<MessageSquareText aria-hidden />} onClick={() => setBundleOpen(true)} disabled={openQuestions.length === 0}>
            질문 묶음 {openQuestions.length > 0 && openQuestions.length}
          </Button>
          <Button size="sm" variant="secondary" icon={<Plus aria-hidden />} onClick={() => setCreateType('question')}>
            확인사항 추가
          </Button>
          <Button size="sm" variant="primary" icon={<Plus aria-hidden />} onClick={() => setCreateType('defect')}>
            이슈 추가
          </Button>
        </div>
      </div>
      <p className={styles.caption}>수행 결과의 FAIL · BLOCKED 행에서 만들면 TC · 차수 · 플랫폼이 함께 연결돼요. 여기서는 결과 없이 일반 항목을 추가할 수 있어요.</p>

      {issues.length === 0 ? (
        <StateMessage title="아직 이슈 · 확인사항이 없어요." description="수행 결과에서 FAIL · BLOCKED 결과를 보고 만들거나, 위의 버튼으로 직접 추가해 보세요." />
      ) : visible.length === 0 ? (
        <StateMessage compact title={`${filterLabel[filter]} 항목이 없어요.`} />
      ) : (
        <table className={styles.table}>
          <caption className="visually-hidden">
            이슈 / 확인사항 {filterLabel[filter]} {visible.length}건
          </caption>
          <thead>
            <tr>
              <th scope="col">유형</th>
              <th scope="col">상태</th>
              <th scope="col">제목</th>
              <th scope="col">TC</th>
              <th scope="col">차수</th>
              <th scope="col">플랫폼</th>
              <th scope="col">연결된 결과</th>
              <th scope="col">생성일</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((issue) => {
              const { testCase, result, resultImport } = links.linksOf(issue);
              return (
                <tr key={issue.id} className={issue.status === 'resolved' ? styles.resolved : undefined}>
                  <td data-label="유형">
                    <IssueTypeTag type={issue.type} />
                  </td>
                  <td data-label="상태">
                    <IssueStatusTag status={issue.status} />
                  </td>
                  <td data-label="제목" className={styles.title}>
                    <Link to={{ search: params({ issue: issue.id }).toString() }} className={styles.titleLink}>
                      {issue.title}
                    </Link>
                    {issue.externalKey && <span className={styles.key}>{issue.externalKey}</span>}
                  </td>
                  <td data-label="TC" className={styles.testCase}>
                    {testCase ? (
                      <span>
                        <span className={styles.tcId}>{testCase.externalId ?? 'ID 없음'}</span> {testCase.title}
                      </span>
                    ) : result ? (
                      <span>
                        {[result.externalId, result.title].filter(Boolean).join(' ')} <span className={styles.muted}>· 미연결</span>
                      </span>
                    ) : (
                      <span className={styles.muted}>-</span>
                    )}
                  </td>
                  <td data-label="차수">{resultImport ? `${resultImport.round}차` : <span className={styles.muted}>-</span>}</td>
                  <td data-label="플랫폼">{result?.platform ? platformLabel[result.platform] : <span className={styles.muted}>-</span>}</td>
                  <td data-label="연결된 결과">{result ? <ResultTag result={result.result} /> : <span className={styles.muted}>-</span>}</td>
                  <td data-label="생성일" className={styles.date}>
                    {formatShortDate(issue.createdAt)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {createType && (
        <IssueCreateDialog
          key={createType}
          open
          initialType={createType}
          projectId={project.id}
          testCases={testCases}
          onClose={() => setCreateType(null)}
        />
      )}
      {openIssue && openLinks && (
        <IssueDetailDialog
          // 저장되면 새 값으로 입력 칸을 다시 채운다.
          key={`${openIssue.id}:${openIssue.updatedAt}`}
          projectId={project.id}
          issue={openIssue}
          links={openLinks}
          laterResults={openLinks.result ? laterResultsFor(openLinks.result, imports, results) : []}
          onClose={() => setSearchParams(params({ issue: null }), { replace: true })}
        />
      )}
      <QuestionBundleDialog open={bundleOpen} onClose={() => setBundleOpen(false)} projectName={project.name} questions={openQuestions} deliverables={deliverables} testCases={testCases} />
    </div>
  );
}
