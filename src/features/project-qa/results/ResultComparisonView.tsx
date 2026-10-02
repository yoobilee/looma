import { useId, useMemo, useState, type ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { compareResultRounds, type ResultChangeType, type ResultComparisonRow } from '@/domain/resultComparison';
import { executionTypeLabel, NO_RESULT_LABEL, platformLabel, resultChangeTypeLabel } from '@/domain/labels';
import type { Platform, TestCase, TestResult, TestResultImport, TestResultValue } from '@/domain/types';
import { formatMonthDay } from '@/lib/date';
import { Button } from '@/components/ui/Button';
import { SelectField } from '@/components/ui/Field';
import { FilterTabs } from '@/components/ui/FilterTabs';
import { StateMessage } from '@/components/ui/StateMessage';
import { ResultTag, Tag, type TagTone } from '@/components/ui/Tag';
import {
  comparisonFilterLabel,
  describeComparisonRows,
  matchesFilter,
  resolveComparisonRounds,
  sortComparisonRows,
  type ComparisonFilter,
} from './comparisonView';
import styles from './ResultComparisonView.module.css';

export interface ResultComparisonViewProps {
  imports: TestResultImport[];
  resultsByImport: Record<string, TestResult[]>;
  testCases: TestCase[];
  /**
   * 고른 기준 · 비교 차수(주소의 base · target). 화면은 이 값을 따로 복사해 두지 않는다.
   * 없거나 맞지 않으면 차수 번호가 가장 큰 두 차수를 자동으로 고르고, 새 차수가 생기면 따라간다.
   */
  previousId?: string | null;
  currentId?: string | null;
  /** 사용자가 차수를 고르면 알린다. 호출한 쪽이 고른 값을 previousId · currentId로 다시 넘긴다. */
  onSelectionChange: (previousId: string, currentId: string) => void;
  /** 있으면 행마다 이슈 · 확인사항 열을 더한다. 동작이 없는 행은 null을 돌려준다. */
  renderIssueAction?: (row: ResultComparisonRow, view: { externalId?: string; title: string }) => ReactNode;
}

const PAGE_SIZE = 100;

const changeTone: Record<ResultChangeType, TagTone> = {
  newly_failed: 'fail',
  still_failed: 'fail',
  fixed: 'pass',
  newly_blocked: 'blocked',
  unblocked: 'pass',
  newly_not_tested: 'untested',
  resumed: 'pass',
  unchanged_pass: 'neutral',
  unchanged_blocked: 'neutral',
  unchanged_not_tested: 'neutral',
  added_to_scope: 'sky',
  removed_from_scope: 'sky',
};

/** 요약에 보여 줄 변화. 단순 총합보다 변화를 먼저 본다. */
const summaryTypes: ResultChangeType[] = ['newly_failed', 'still_failed', 'fixed', 'newly_blocked', 'unblocked', 'added_to_scope', 'removed_from_scope'];
const filters: ComparisonFilter[] = ['all', 'newly_failed', 'still_failed', 'fixed', 'blocked', 'scope'];

function roundOptionLabel(item: TestResultImport): string {
  const date = item.executedFrom ? `${item.executedFrom} 수행` : `${formatMonthDay(item.importedAt)} 업로드`;
  return `${item.round}차 · ${executionTypeLabel[item.executionType ?? 'full']} · ${date}`;
}

function StatusTag({ status }: { status: TestResultValue | null }) {
  return status ? <ResultTag result={status} /> : <Tag tone="outline">{NO_RESULT_LABEL}</Tag>;
}

const platformText = (platforms: (Platform | null)[]) =>
  platforms.length === 0 ? '없음' : platforms.map((platform) => (platform ? platformLabel[platform] : '플랫폼 없음')).join(' · ');

/** 두 수행 차수(기준 → 비교)의 결과를 TC · 플랫폼별로 비교한다. 데이터를 바꾸지 않는다. */
export function ResultComparisonView({ imports, resultsByImport, testCases, previousId, currentId, onSelectionChange, renderIssueAction }: ResultComparisonViewProps) {
  const sorted = useMemo(() => [...imports].sort((a, b) => a.round - b.round), [imports]);
  const { previous, current } = resolveComparisonRounds(sorted, previousId, currentId) ?? {};
  const [filter, setFilter] = useState<ComparisonFilter>('all');
  const [includeUnchanged, setIncludeUnchanged] = useState(false);
  // 비교하는 두 차수가 바뀌면(직접 고름 · 주소 이동 · 새 차수 자동 선택) 처음 100건부터 다시 보여 준다.
  // 바뀐 차수로 저장된 값도 바로 덮어써야 A → B → A로 돌아왔을 때 A의 이전 건수가 되살아나지 않는다.
  // (React의 "prop이 바뀔 때 state 조정" 방식: 이번 렌더를 버리고 바뀐 state로 곧바로 다시 그린다.)
  const pairKey = `${previous?.id}>${current?.id}`;
  const [paging, setPaging] = useState({ pairKey, limit: PAGE_SIZE });
  if (paging.pairKey !== pairKey) setPaging({ pairKey, limit: PAGE_SIZE });
  const limit = paging.pairKey === pairKey ? paging.limit : PAGE_SIZE;
  const setLimit = (next: number) => setPaging({ pairKey, limit: next });
  const unchangedId = useId();

  const comparison = useMemo(
    () => (previous && current ? compareResultRounds(previous, current, [...(resultsByImport[previous.id] ?? []), ...(resultsByImport[current.id] ?? [])]) : undefined),
    [previous, current, resultsByImport],
  );
  const views = useMemo(() => {
    if (!comparison?.ok || !previous || !current) return [];
    return sortComparisonRows(describeComparisonRows(comparison.rows, testCases, [...(resultsByImport[previous.id] ?? []), ...(resultsByImport[current.id] ?? [])]));
  }, [comparison, testCases, resultsByImport, previous, current]);

  if (!previous || !current) {
    return <StateMessage title="비교할 수행 차수가 부족해요." description="수행 결과 차수가 2개 이상 있어야 기준 차수와 비교 차수를 고를 수 있어요." />;
  }

  const changeFilter = (next: ComparisonFilter) => {
    setFilter(next);
    setLimit(PAGE_SIZE);
  };

  const filterCount = (value: ComparisonFilter) => views.filter((view) => matchesFilter(view.row, value, includeUnchanged)).length;
  const visible = views.filter((view) => matchesFilter(view.row, filter, includeUnchanged));
  const shown = visible.slice(0, limit);

  const executionTypes = [previous.executionType ?? 'full', current.executionType ?? 'full'];
  const notices: string[] = [];
  if (comparison?.ok) {
    if (executionTypes.some((type) => type === 'partial' || type === 'retest') || executionTypes[0] !== executionTypes[1]) {
      notices.push(
        `${executionTypeLabel[executionTypes[0]]} → ${executionTypeLabel[executionTypes[1]]} 비교예요. 한 차수에만 결과가 있는 TC는 '범위 추가' · '범위 제외'로 보여요. 이는 미수행(결과 값)과 다르며, 수행하지 않았다는 뜻으로 바꾸지 않아요.`,
      );
    }
    const before = platformText(comparison.previous.platforms);
    const after = platformText(comparison.current.platforms);
    if (before !== after) notices.push(`두 차수의 플랫폼 구성이 달라요(${previous.round}차: ${before}, ${current.round}차: ${after}). TC · 플랫폼별로 비교하므로 같은 TC도 범위 추가 · 제외로 보일 수 있어요.`);
    const unlinked = comparison.previous.unlinked + comparison.current.unlinked;
    if (unlinked > 0) notices.push(`TC에 연결되지 않은 결과 ${unlinked}건(${previous.round}차 ${comparison.previous.unlinked} · ${current.round}차 ${comparison.current.unlinked})은 비교하지 않았어요.`);
    if (comparison.ambiguous.length > 0) notices.push(`같은 차수에 같은 TC · 플랫폼 결과가 여러 개인 ${comparison.ambiguous.length}건은 어느 결과를 쓸지 정할 수 없어 비교하지 않았어요.`);
  }

  const optionsFor = (other: string) =>
    sorted.map((item) => (
      <option key={item.id} value={item.id} disabled={item.id === other}>
        {roundOptionLabel(item)}
      </option>
    ));

  const unchanged = comparison?.ok ? comparison.counts.unchanged_pass + comparison.counts.unchanged_blocked + comparison.counts.unchanged_not_tested : 0;
  const addedFails = comparison?.ok ? comparison.rows.filter((row) => row.changeType === 'added_to_scope' && row.currentStatus === 'fail').length : 0;

  return (
    <div className={styles.view}>
      <div className={styles.selectors}>
        <SelectField label="기준 차수" value={previous.id} onChange={(event) => onSelectionChange(event.target.value, current.id)}>
          {optionsFor(current.id)}
        </SelectField>
        <ArrowRight aria-hidden className={styles.arrow} />
        <SelectField label="비교 차수" value={current.id} onChange={(event) => onSelectionChange(previous.id, event.target.value)}>
          {optionsFor(previous.id)}
        </SelectField>
      </div>
      <p className={styles.direction} aria-live="polite">
        {previous.round}차 → {current.round}차 결과를 TC · 플랫폼별로 비교해요.
      </p>

      {!comparison?.ok ? (
        <StateMessage
          title="이 두 차수는 비교할 수 없어요."
          description={
            comparison?.reason === 'same_round'
              ? '기준 차수와 비교 차수를 서로 다르게 골라 주세요.'
              : `${[comparison?.previous?.linked === 0 && `${previous.round}차`, comparison?.current?.linked === 0 && `${current.round}차`].filter(Boolean).join(' · ')}에 TC와 연결된 결과가 없어요. 결과를 TC에 연결해 가져온 차수만 비교할 수 있어요.`
          }
        />
      ) : (
        <>
          {notices.length > 0 && (
            <ul className={styles.notices}>
              {notices.map((notice) => (
                <li key={notice}>{notice}</li>
              ))}
            </ul>
          )}

          <section aria-labelledby="comparison-summary-title">
            <h3 id="comparison-summary-title" className="visually-hidden">
              변화 요약
            </h3>
            <dl className={styles.summary}>
              {summaryTypes.map((type) => (
                <div key={type} className={styles[`tone_${changeTone[type]}`]}>
                  <dt>{resultChangeTypeLabel[type]}</dt>
                  <dd>{comparison.counts[type]}</dd>
                  {type === 'added_to_scope' && addedFails > 0 && <dd className={styles.subcount}>그중 FAIL {addedFails}</dd>}
                </div>
              ))}
            </dl>
            <p className={styles.others}>
              그 밖에 {resultChangeTypeLabel.newly_not_tested} {comparison.counts.newly_not_tested} · {resultChangeTypeLabel.resumed} {comparison.counts.resumed} · 변화 없음 {unchanged}
            </p>
          </section>

          <section aria-labelledby="comparison-list-title" className={styles.list}>
            <h3 id="comparison-list-title" className="visually-hidden">
              변화 목록
            </h3>
            <div className={styles.listTools}>
              <div className={styles.filterWrap}>
                <FilterTabs
                  label="변화 필터"
                  value={filter}
                  onChange={changeFilter}
                  options={filters.map((value) => ({ value, label: comparisonFilterLabel[value], count: filterCount(value) }))}
                />
              </div>
              <label className={styles.unchanged} htmlFor={unchangedId}>
                <input
                  id={unchangedId}
                  type="checkbox"
                  checked={includeUnchanged}
                  onChange={(event) => {
                    setIncludeUnchanged(event.target.checked);
                    setLimit(PAGE_SIZE);
                  }}
                />
                변화 없음 포함
              </label>
            </div>

            {visible.length === 0 ? (
              <StateMessage
                compact
                title={filter === 'all' ? '두 차수 사이에 바뀐 결과가 없어요.' : `${comparisonFilterLabel[filter]} 항목이 없어요.`}
                description={filter === 'all' && !includeUnchanged && unchanged > 0 ? `변화 없음 ${unchanged}건은 '변화 없음 포함'을 켜면 볼 수 있어요.` : undefined}
              />
            ) : (
              <table className={styles.table}>
                <caption className="visually-hidden">
                  {previous.round}차 → {current.round}차 {comparisonFilterLabel[filter]} {visible.length}건
                </caption>
                <thead>
                  <tr>
                    <th scope="col">TC ID</th>
                    <th scope="col">테스트 항목</th>
                    <th scope="col">기능</th>
                    <th scope="col">플랫폼</th>
                    <th scope="col">{previous.round}차</th>
                    <th scope="col">{current.round}차</th>
                    <th scope="col">변화</th>
                    {renderIssueAction && <th scope="col">이슈 / 확인사항</th>}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((view) => (
                    <tr key={view.row.key}>
                      <td data-label="TC ID" className={styles.id}>
                        {view.externalId ?? <span className={styles.muted}>미지정</span>}
                      </td>
                      <td data-label="테스트 항목" className={styles.title}>
                        {/* 좁은 화면에서 셀이 grid가 되므로 내용을 한 덩어리로 둔다. */}
                        <span>
                          {view.title}
                          {view.deprecated && (
                            <>
                              {' '}
                              <Tag tone="outline">폐기</Tag>
                            </>
                          )}
                        </span>
                      </td>
                      <td data-label="기능">{view.feature}</td>
                      <td data-label="플랫폼">{view.row.platform ? platformLabel[view.row.platform] : <span className={styles.muted}>-</span>}</td>
                      <td data-label={`${previous.round}차`}>
                        <StatusTag status={view.row.previousStatus} />
                      </td>
                      <td data-label={`${current.round}차`}>
                        <StatusTag status={view.row.currentStatus} />
                      </td>
                      <td data-label="변화">
                        <Tag tone={changeTone[view.row.changeType]}>{resultChangeTypeLabel[view.row.changeType]}</Tag>
                      </td>
                      {renderIssueAction && (
                        <td data-label="이슈 / 확인사항" className={styles.issueCell}>
                          {renderIssueAction(view.row, view)}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {visible.length > shown.length && (
              <Button size="sm" variant="ghost" onClick={() => setLimit(limit + PAGE_SIZE)}>
                {`${Math.min(PAGE_SIZE, visible.length - shown.length)}건 더 보기 (남은 ${visible.length - shown.length}건)`}
              </Button>
            )}
          </section>
        </>
      )}
    </div>
  );
}
