import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { repositories } from '@/data';
import { issueTypes } from '@/domain/issues';
import { issueTypeLabel, platformLabel, testResultLabel } from '@/domain/labels';
import type { Issue, IssueType, TestCase, TestResult, TestResultImport } from '@/domain/types';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { RadioGroup, SelectField, TextAreaField, TextField } from '@/components/ui/Field';
import { ResultTag } from '@/components/ui/Tag';
import { issuePath } from './issueView';
import styles from './IssueCreateDialog.module.css';

interface IssueCreateDialogProps {
  open: boolean;
  projectId: string;
  initialType: IssueType;
  testCases: TestCase[];
  /**
   * 수행 결과에서 만들 때 연결할 수 있는 결과(FAIL · BLOCKED). 여럿이면(같은 TC의 플랫폼별 결과) 하나를 고른다.
   * 없으면 결과 없이 만드는 일반 항목이다.
   */
  sourceResults?: TestResult[];
  imports?: TestResultImport[];
  /** 이 프로젝트의 기존 항목. 같은 결과에 이미 만든 항목을 알려 주기만 하고 막지 않는다. */
  existingIssues?: Issue[];
  onClose: () => void;
  onCreated?: (issue: Issue) => void;
}

const resultOptionLabel = (result: TestResult) => `${result.platform ? platformLabel[result.platform] : '플랫폼 없음'} · ${testResultLabel[result.result]}`;

/**
 * 이슈 · 확인사항 만들기. 사용자가 저장을 눌러야만 만든다.
 * 결과에서 열면 프로젝트 · TC · 차수 · 결과 · 플랫폼을 결과에서 연결하고, Expected Result · 비고를 입력 칸에 미리 채운다(고칠 수 있다).
 */
export function IssueCreateDialog({ open, projectId, initialType, testCases, sourceResults = [], imports = [], existingIssues = [], onClose, onCreated }: IssueCreateDialogProps) {
  const fromResult = sourceResults.length > 0;
  const [type, setType] = useState<IssueType>(initialType);
  const [resultId, setResultId] = useState(sourceResults[0]?.id ?? '');
  const result = sourceResults.find((item) => item.id === resultId);
  const resultImport = result && imports.find((item) => item.id === result.importId);
  const linkedTestCase = result?.testCaseId ? testCases.find((item) => item.id === result.testCaseId) : undefined;

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [expected, setExpected] = useState(linkedTestCase?.expectedResult ?? '');
  // 실제 동작은 고르는 결과의 비고를 따라가다가, 사용자가 직접 고치면 그 값을 지킨다.
  const [actualDraft, setActualDraft] = useState<string | null>(null);
  const actual = actualDraft ?? result?.note ?? '';
  const [reproduction, setReproduction] = useState('');
  const [note, setNote] = useState('');
  const [feature, setFeature] = useState('');
  const [testCaseId, setTestCaseId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typeName = useId();

  const features = [...new Set(testCases.map((item) => item.feature))];
  const alreadyLinked = result ? existingIssues.filter((issue) => issue.resultId === result.id) : [];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      // 기능은 사용자가 고른 경우에만 저장한다. TC의 기능은 연결에서 찾는다(복사해 두지 않는다).
      const created = await repositories.issues.create({
        projectId,
        type,
        title,
        description,
        expected,
        actual,
        reproduction,
        note,
        ...(fromResult ? { resultId } : { testCaseId: testCaseId || undefined, feature: feature || undefined }),
      });
      onCreated?.(created);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '저장하지 못했어요.');
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width="lg"
      title={fromResult ? '수행 결과에서 이슈 / 확인사항 만들기' : `${issueTypeLabel[type]} 추가`}
      description={fromResult ? '이 결과와 TC · 차수 · 플랫폼을 연결해 남겨요. 결과와 TC는 바뀌지 않아요.' : '수행 결과 없이 남기는 일반 항목이에요. TC를 연결할 수도 있어요.'}
    >
      <form className={styles.form} onSubmit={(event) => void submit(event)}>
        <RadioGroup legend="유형" name={typeName} value={type} onChange={setType} options={issueTypes.map((value) => ({ value, label: issueTypeLabel[value] }))} />

        {fromResult && result && (
          <section className={styles.source} aria-label="연결할 수행 결과">
            {sourceResults.length > 1 && (
              <SelectField label="연결할 결과" value={resultId} onChange={(event) => setResultId(event.target.value)}>
                {sourceResults.map((item) => (
                  <option key={item.id} value={item.id}>
                    {resultOptionLabel(item)}
                  </option>
                ))}
              </SelectField>
            )}
            <dl className={styles.facts}>
              <div className={styles.wide}>
                <dt>TC</dt>
                <dd>
                  <span className={styles.tcId}>{linkedTestCase?.externalId ?? result.externalId ?? 'ID 없음'}</span> {linkedTestCase?.title ?? result.title}
                  {!result.testCaseId && <span className={styles.muted}> · 기준 TC에 연결되지 않은 결과</span>}
                </dd>
              </div>
              <div>
                <dt>차수</dt>
                <dd>{resultImport ? `${resultImport.round}차` : '-'}</dd>
              </div>
              <div>
                <dt>플랫폼</dt>
                <dd>{result.platform ? platformLabel[result.platform] : '-'}</dd>
              </div>
              <div>
                <dt>결과</dt>
                <dd>
                  <ResultTag result={result.result} />
                  {result.rawResult && <span className={styles.muted}> 원문 {result.rawResult}</span>}
                </dd>
              </div>
            </dl>
            {alreadyLinked.length > 0 && (
              <div className={styles.linked} role="note">
                <p>이 결과에 이미 연결된 항목이 {alreadyLinked.length}건 있어요. 다른 판단이면 그대로 추가해도 돼요.</p>
                <ul>
                  {alreadyLinked.map((issue) => (
                    <li key={issue.id}>
                      <Link to={issuePath(projectId, issue.id)}>
                        [{issueTypeLabel[issue.type]}] {issue.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        <TextField label="제목" required value={title} onChange={(event) => setTitle(event.target.value)} placeholder={type === 'defect' ? '예: iOS 비밀번호 오류 문구가 기획과 다름' : '예: 로그인 실패 횟수 제한 정책 확인'} />
        <TextAreaField label="설명" value={description} onChange={(event) => setDescription(event.target.value)} />

        {!fromResult && (
          <div className={styles.row}>
            <SelectField label="기능" value={feature} onChange={(event) => setFeature(event.target.value)}>
              <option value="">선택 안 함</option>
              {features.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </SelectField>
            <SelectField label="연결 TC" value={testCaseId} onChange={(event) => setTestCaseId(event.target.value)}>
              <option value="">선택 안 함</option>
              {testCases.map((item) => (
                <option key={item.id} value={item.id}>
                  {[item.externalId, item.title].filter(Boolean).join(' ')}
                </option>
              ))}
            </SelectField>
          </div>
        )}

        <div className={styles.row}>
          <TextAreaField label="Expected Result" value={expected} onChange={(event) => setExpected(event.target.value)} hint={fromResult && linkedTestCase ? 'TC의 Expected Result를 채워 두었어요.' : undefined} />
          <TextAreaField label="Actual" value={actual} onChange={(event) => setActualDraft(event.target.value)} hint={fromResult && result?.note ? '결과 비고를 채워 두었어요.' : undefined} />
        </div>
        <TextAreaField label="재현 방법" value={reproduction} onChange={(event) => setReproduction(event.target.value)} />
        <TextAreaField label="메모" value={note} onChange={(event) => setNote(event.target.value)} />

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <div className={styles.footer}>
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button type="submit" variant="primary" disabled={!title.trim() || saving}>
            {issueTypeLabel[type]} 만들기
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
