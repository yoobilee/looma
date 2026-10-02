import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { repositories } from '@/data';
import { issueStatuses, issueTypes, type IssueChanges, type LaterResult } from '@/domain/issues';
import { executionTypeLabel, issueStatusLabel, issueTypeLabel, platformLabel } from '@/domain/labels';
import type { Issue } from '@/domain/types';
import { formatDateTime } from '@/lib/date';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { RadioGroup, TextAreaField, TextField } from '@/components/ui/Field';
import { ResultTag } from '@/components/ui/Tag';
import { resultRoundPath, testCasePath, type IssueLinks, type IssueSource } from './issueView';
import styles from './IssueDetailDialog.module.css';

interface IssueDetailDialogProps {
  projectId: string;
  issue: Issue;
  links: IssueLinks;
  /** 저장된 근거 산출물 위치(sourceRef). 읽기 전용이다. */
  source?: IssueSource;
  /** 연결된 결과 뒤의 같은 TC · 플랫폼 결과. 보여 주기만 하고 상태를 바꾸지 않는다. */
  laterResults: LaterResult[];
  onClose: () => void;
}

type Draft = Required<Pick<Issue, 'type' | 'status' | 'title'>> & Record<'description' | 'expected' | 'actual' | 'reproduction' | 'note', string>;

const toDraft = (issue: Issue): Draft => ({
  type: issue.type,
  status: issue.status,
  title: issue.title,
  description: issue.description ?? '',
  expected: issue.expected ?? '',
  actual: issue.actual ?? '',
  reproduction: issue.reproduction ?? '',
  note: issue.note ?? '',
});

/**
 * 이슈 · 확인사항 상세 · 편집. 연결(TC · 결과)은 보여 주기만 하고 바꾸지 않는다.
 * 이후 수행 결과가 PASS여도 상태는 사용자가 직접 바꾼다.
 */
export function IssueDetailDialog({ projectId, issue, links, source, laterResults, onClose }: IssueDetailDialogProps) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(issue));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typeName = useId();
  const statusName = useId();
  const original = toDraft(issue);
  const dirty = (Object.keys(draft) as (keyof Draft)[]).some((key) => draft[key] !== original[key]);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const { testCase, result, resultImport } = links;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty || !draft.title.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const changes: IssueChanges = { ...draft };
      await repositories.issues.update(issue.id, changes);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '저장하지 못했어요.');
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} width="lg" title={`${issueTypeLabel[issue.type]} 상세`} description={issue.externalKey ? `외부 번호 ${issue.externalKey}` : undefined}>
      <div className={styles.layout}>
        <section aria-labelledby={`${typeName}-links`} className={styles.links}>
          <h3 id={`${typeName}-links`} className={styles.heading}>
            연결
          </h3>
          <dl className={styles.facts}>
            <div className={styles.wide}>
              <dt>TC</dt>
              <dd>
                {testCase ? (
                  <Link to={testCasePath(projectId, testCase.id)} className={styles.link}>
                    <span className={styles.tcId}>{testCase.externalId ?? 'ID 없음'}</span> {testCase.title}
                  </Link>
                ) : result ? (
                  <>
                    {[result.externalId, result.title].filter(Boolean).join(' ')}
                    <span className={styles.muted}> · 기준 TC 미연결</span>
                  </>
                ) : (
                  <span className={styles.muted}>연결 안 함</span>
                )}
              </dd>
            </div>
            <div>
              <dt>차수</dt>
              <dd>
                {resultImport ? (
                  <Link to={resultRoundPath(projectId, resultImport.id)} className={styles.link}>
                    {resultImport.round}차 수행 결과
                  </Link>
                ) : (
                  <span className={styles.muted}>{issue.resultId ? '결과를 찾을 수 없음' : '수행 결과 없이 등록'}</span>
                )}
              </dd>
            </div>
            <div>
              <dt>플랫폼</dt>
              <dd>{result?.platform ? platformLabel[result.platform] : '-'}</dd>
            </div>
            <div>
              <dt>연결된 결과</dt>
              <dd>{result ? <ResultTag result={result.result} /> : '-'}</dd>
            </div>
            {issue.feature && (
              <div>
                <dt>기능</dt>
                <dd>{issue.feature}</dd>
              </div>
            )}
            {source && (
              <div className={styles.wide}>
                <dt>근거</dt>
                <dd>
                  {source.deliverable ? source.deliverable.title : <span className={styles.muted}>찾을 수 없는 산출물</span>} · {source.locator}
                </dd>
              </div>
            )}
          </dl>

          {result && (
            <div className={styles.later}>
              <h4 className={styles.subheading}>이후 수행 결과</h4>
              {laterResults.length === 0 ? (
                <p className={styles.muted}>{result.testCaseId ? '이 차수 뒤에 같은 TC · 플랫폼 결과가 아직 없어요.' : 'TC에 연결되지 않은 결과라 이후 결과를 찾지 않아요.'}</p>
              ) : (
                <ol className={styles.timeline}>
                  {laterResults.map(({ result: later, resultImport: round }) => (
                    <li key={later.id}>
                      <Link to={resultRoundPath(projectId, round.id)} className={styles.link}>
                        {round.round}차
                      </Link>
                      <span className={styles.muted}>
                        {executionTypeLabel[round.executionType ?? 'full']} · {round.executedFrom ? `${round.executedFrom} 수행` : `${formatDateTime(round.importedAt)} 가져옴`}
                      </span>
                      <ResultTag result={later.result} />
                    </li>
                  ))}
                </ol>
              )}
              <p className={styles.caption}>이후 결과가 PASS여도 상태를 자동으로 바꾸지 않아요. 확인한 뒤 직접 해결됨으로 바꿔 주세요.</p>
            </div>
          )}
        </section>

        <form className={styles.form} onSubmit={(event) => void submit(event)}>
          <div className={styles.choices}>
            <RadioGroup legend="상태" name={statusName} value={draft.status} onChange={(value) => set('status', value)} options={issueStatuses.map((value) => ({ value, label: issueStatusLabel[value] }))} />
            <RadioGroup legend="유형" name={typeName} value={draft.type} onChange={(value) => set('type', value)} options={issueTypes.map((value) => ({ value, label: issueTypeLabel[value] }))} />
          </div>
          <TextField label="제목" required value={draft.title} onChange={(event) => set('title', event.target.value)} />
          <TextAreaField label="설명" value={draft.description} onChange={(event) => set('description', event.target.value)} />
          <div className={styles.row}>
            <TextAreaField label="Expected Result" value={draft.expected} onChange={(event) => set('expected', event.target.value)} />
            <TextAreaField label="Actual" value={draft.actual} onChange={(event) => set('actual', event.target.value)} />
          </div>
          <TextAreaField label="재현 방법" value={draft.reproduction} onChange={(event) => set('reproduction', event.target.value)} />
          <TextAreaField label="메모" value={draft.note} onChange={(event) => set('note', event.target.value)} />

          <p className={styles.times}>
            {formatDateTime(issue.createdAt)} 생성 · {formatDateTime(issue.updatedAt)} 수정
            {issue.resolvedAt && ` · ${formatDateTime(issue.resolvedAt)} 해결`}
          </p>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.footer}>
            <Button variant="ghost" onClick={onClose}>
              닫기
            </Button>
            <Button type="submit" variant="primary" disabled={!dirty || !draft.title.trim() || saving}>
              저장
            </Button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}
