import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, GitCompareArrows, Upload } from 'lucide-react';
import { useRepositoryData } from '@/hooks/useRepositoryData';
import {
  attentionAreas,
  compareRounds,
  countResults,
  executionRate,
  groupByFeature,
  groupByPlatform,
  passRate,
  retestCandidates,
} from '@/domain/resultSummary';
import { summarizeResultImport } from '@/domain/testResultImport';
import { executionTypeLabel, platformLabel, testResultLabel, testResultOrder } from '@/domain/labels';
import type { TestResult, TestResultImport } from '@/domain/types';
import { formatMonthDay } from '@/lib/date';
import { Button, ButtonLink } from '@/components/ui/Button';
import { FilterTabs } from '@/components/ui/FilterTabs';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { ResultTag } from '@/components/ui/Tag';
import { LoadingState, StateMessage } from '@/components/ui/StateMessage';
import { useProjectContext } from '../projectContext';
import { ResultLegend, ResultStackedBar } from './ResultStackedBar';
import { ResultComparisonView } from './ResultComparisonView';
import { ResultImportDialog } from './ResultImportDialog';
import styles from './ResultDashboardTab.module.css';

const flowSteps = ['Looma TC 초안', '고객사 양식 XLSX 내보내기', 'Excel 등에서 수동 수행', '수행 완료 파일 업로드', '결과 분석 · 요약'];

/** 결과를 같은 TC로 묶는 키. 연결된 TC가 우선이고, 고객사 TC ID도 없는 미연결 결과는 따로 둔다. */
const retestKey = (result: TestResult) => result.testCaseId ?? (result.externalId ? `ext:${result.externalId}` : `res:${result.id}`);

/** 재수행 목록은 TC 단위로 묶고 플랫폼별 결과를 함께 보여준다. */
function groupRetests(results: TestResult[]) {
  const map = new Map<string, TestResult[]>();
  for (const result of retestCandidates(results)) {
    map.set(retestKey(result), [...(map.get(retestKey(result)) ?? []), result]);
  }
  return [...map.entries()].map(([key, items]) => ({
    key,
    externalId: items[0].externalId,
    linked: !!items[0].testCaseId,
    title: items[0].title,
    feature: items[0].feature,
    items: results.filter((result) => retestKey(result) === key),
    issueId: items.find((item) => item.issueId)?.issueId,
    note: items.find((item) => item.note)?.note,
  }));
}

/**
 * 수행 결과 대시보드. TC 수행은 고객사 Excel 등 외부 양식에서 하고,
 * Looma는 업로드된 결과를 요약·분석한다. 직접 수행 UI를 제공하지 않는다.
 */
export function ResultDashboardTab() {
  const { project } = useProjectContext();
  // 가져오기 이력에서 `?import=<id>`로 들어오면 그 차수를 먼저 보여 준다. 없는 id면 기존처럼 최신 차수다.
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedImportId, setSelectedImportId] = useState<string | null>(searchParams.get('import'));
  const [uploadOpen, setUploadOpen] = useState(false);
  const [showAllRetests, setShowAllRetests] = useState(false);

  const data = useRepositoryData(
    async (repos) => {
      const imports = await repos.testResults.listImports(project.id);
      const resultsByImport = Object.fromEntries(await Promise.all(imports.map(async (item) => [item.id, await repos.testResults.listResults(item.id)] as const)));
      const issues = await repos.issues.listByProject(project.id);
      const template = project.tcTemplateId ? await repos.templates.get(project.tcTemplateId) : undefined;
      // 결과 연결 판정에만 쓴다. 수행 결과 가져오기는 TC를 바꾸지 않는다.
      const testCases = await repos.testCases.listByProject(project.id);
      return { imports, resultsByImport, issues, template, testCases };
    },
    [project.id, project.tcTemplateId],
  );

  if (data.status === 'loading') return <LoadingState />;
  if (data.status === 'error') return <StateMessage tone="error" title="수행 결과를 불러오지 못했어요." />;

  const { imports, resultsByImport, issues, template, testCases } = data.data;
  const flowCurrent = imports.length > 0 ? 4 : 1;

  const flow = (
    <ol className={styles.flow} aria-label="수행 결과 흐름">
      {flowSteps.map((step, index) => (
        <li key={step} className={index < flowCurrent ? styles.flowDone : index === flowCurrent ? styles.flowCurrent : undefined}>
          <span aria-hidden>{index + 1}</span>
          {step}
        </li>
      ))}
    </ol>
  );

  // 열 때마다 새로 만들어 이전 가져오기의 입력이 남지 않게 한다.
  const uploadDialog = uploadOpen && (
    <ResultImportDialog
      open
      onClose={() => setUploadOpen(false)}
      projectId={project.id}
      platforms={project.platforms}
      testCases={testCases}
      imports={imports}
      templateMappings={template?.resultMappings ?? []}
    />
  );

  if (imports.length === 0) {
    return (
      <div className={styles.page}>
        {flow}
        <StateMessage
          title="아직 업로드한 수행 결과가 없어요."
          description="고객사 양식에서 수행을 마친 CSV 또는 XLSX 파일을 올리면 PASS · FAIL · BLOCKED · 미수행을 플랫폼과 기능별로 요약해요."
          action={
            <Button variant="primary" icon={<Upload aria-hidden />} onClick={() => setUploadOpen(true)}>
              수행 결과 파일 업로드
            </Button>
          }
        />
        {uploadDialog}
      </div>
    );
  }

  // `?view=compare`: 두 차수를 TC별로 비교하는 화면. 고른 차수는 주소(base · target)에 남겨 새로 고쳐도 유지한다.
  if (searchParams.get('view') === 'compare') {
    return (
      <div className={styles.page}>
        <div className={styles.toolbar}>
          <ButtonLink size="sm" variant="ghost" icon={<ArrowLeft aria-hidden />} to="?">
            결과 요약으로
          </ButtonLink>
          <h2 className={styles.viewTitle}>수행 결과 비교</h2>
          <Button variant="primary" icon={<Upload aria-hidden />} onClick={() => setUploadOpen(true)}>
            수행 결과 업로드
          </Button>
        </div>
        <ResultComparisonView
          imports={imports}
          resultsByImport={resultsByImport}
          testCases={testCases}
          initialPreviousId={searchParams.get('base')}
          initialCurrentId={searchParams.get('target')}
          onSelectionChange={(base, target) => setSearchParams({ view: 'compare', base, target }, { replace: true })}
        />
        {uploadDialog}
      </div>
    );
  }

  const current = imports.find((item) => item.id === selectedImportId) ?? imports[imports.length - 1];
  const currentIndex = imports.indexOf(current);
  const previous = currentIndex > 0 ? imports[currentIndex - 1] : undefined;
  const results = resultsByImport[current.id] ?? [];
  const counts = countResults(results);
  const summary = summarizeResultImport(results);
  const previousCounts = previous ? countResults(resultsByImport[previous.id] ?? []) : undefined;
  const platforms = groupByPlatform(results);
  const features = groupByFeature(results);
  const focus = attentionAreas(results);
  const retests = groupRetests(results);
  const issueById = Object.fromEntries(issues.map((issue) => [issue.id, issue]));
  const visibleRetests = showAllRetests ? retests : retests.slice(0, 6);

  return (
    <div className={styles.page}>
      {flow}

      <div className={styles.toolbar}>
        <FilterTabs
          label="수행 차수"
          value={current.id}
          onChange={setSelectedImportId}
          options={imports.map((item) => ({ value: item.id, label: roundLabel(item) }))}
        />
        <p className={styles.fileMeta}>
          {[
            executionTypeLabel[current.executionType ?? 'full'],
            current.executedFrom && `${current.executedFrom}${current.executedTo ? ` ~ ${current.executedTo}` : ''} 수행`,
            current.environment,
            current.fileRef,
            `${formatMonthDay(current.importedAt)} 업로드`,
          ]
            .filter(Boolean)
            .join(' · ')}
          {summary.unlinked > 0 && <span className={styles.unlinked}> · 미연결 {summary.unlinked}건</span>}
        </p>
        <ButtonLink variant="secondary" icon={<GitCompareArrows aria-hidden />} to="?view=compare">
          수행 결과 비교
        </ButtonLink>
        <Button variant="primary" icon={<Upload aria-hidden />} onClick={() => setUploadOpen(true)}>
          수행 결과 업로드
        </Button>
      </div>

      <section aria-labelledby="summary-title">
        <h2 id="summary-title" className="visually-hidden">
          {current.round}차 결과 요약
        </h2>
        <dl className={styles.figures}>
          <div>
            <dt>전체</dt>
            <dd>{counts.total}</dd>
          </div>
          {testResultOrder.map((value) => (
            <div key={value} className={styles[`figure_${value}`]}>
              <dt>{testResultLabel[value]}</dt>
              <dd>{counts[value]}</dd>
            </div>
          ))}
          <div className={styles.rates}>
            <dt>수행률 · 통과율</dt>
            <dd>
              {executionRate(counts)}% · {passRate(counts)}%
            </dd>
          </div>
        </dl>
        <div className={styles.overallBar}>
          <ResultStackedBar counts={counts} label={`${current.round}차 전체 결과`} size="large" />
          <ResultLegend />
        </div>
      </section>

      <div className={styles.grid}>
        <section aria-labelledby="platform-title">
          <SectionHeader id="platform-title" title="플랫폼별 결과" level={2} />
          <ul className={styles.platforms}>
            {platforms.map(({ platform, counts: platformCounts }) => (
              <li key={platform}>
                <div className={styles.platformHead}>
                  <strong>{platformLabel[platform]}</strong>
                  <span>
                    PASS {platformCounts.pass} · FAIL {platformCounts.fail} · BLOCKED {platformCounts.blocked} · 미수행 {platformCounts.not_tested}
                  </span>
                </div>
                <ResultStackedBar counts={platformCounts} label={`${platformLabel[platform]} 결과`} />
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="focus-title">
          <SectionHeader id="focus-title" title="실패 · 미수행 집중 영역" />
          {focus.length === 0 ? (
            <p className={styles.muted}>집중해서 볼 영역이 없어요.</p>
          ) : (
            <ol className={styles.focus}>
              {focus.map((area) => (
                <li key={area.feature}>
                  <strong>{area.feature}</strong>
                  <span>
                    {Math.round(area.attentionRate * 100)}% 확인 필요 · FAIL {area.counts.fail} · BLOCKED {area.counts.blocked} · 미수행 {area.counts.not_tested}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <section aria-labelledby="feature-title">
        <SectionHeader id="feature-title" title="기능별 결과" meta="표로 보기" />
        <div className={styles.tableWrap} role="region" aria-labelledby="feature-title" tabIndex={0}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">기능</th>
                <th scope="col" className={styles.num}>
                  전체
                </th>
                {testResultOrder.map((value) => (
                  <th key={value} scope="col" className={styles.num}>
                    {testResultLabel[value]}
                  </th>
                ))}
                <th scope="col" className={styles.num}>
                  통과율
                </th>
                <th scope="col" className={styles.barCol}>
                  분포
                </th>
              </tr>
            </thead>
            <tbody>
              {features.map((feature) => (
                <tr key={feature.feature}>
                  <th scope="row">{feature.feature}</th>
                  <td className={styles.num}>{feature.counts.total}</td>
                  {testResultOrder.map((value) => (
                    <td key={value} className={`${styles.num} ${value === 'fail' && feature.counts.fail > 0 ? styles.failText : ''}`}>
                      {feature.counts[value]}
                    </td>
                  ))}
                  <td className={styles.num}>{passRate(feature.counts)}%</td>
                  <td className={styles.barCol}>
                    <ResultStackedBar counts={feature.counts} label={`${feature.feature} 결과 분포`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className={styles.grid}>
        <section aria-labelledby="retest-title">
          <SectionHeader id="retest-title" title="재수행 필요" meta={`${retests.length}건 · FAIL / BLOCKED`} metaTone="coral" />
          <ul className={styles.retests}>
            {visibleRetests.map((retest) => {
              const issue = retest.issueId ? issueById[retest.issueId] : undefined;
              return (
                <li key={retest.key} className={styles.retest}>
                  <div className={styles.retestMain}>
                    <p className={styles.retestTitle}>
                      <span className={styles.retestId}>{retest.externalId ?? 'ID 없음'}</span>
                      {retest.title}
                    </p>
                    <p className={styles.retestMeta}>
                      {retest.feature}
                      {!retest.linked && ' · 미연결'}
                      {retest.note && ` · ${retest.note}`}
                      {issue && (
                        <>
                          {' · '}
                          <Link to={`/projects/${project.id}/issues`} className={styles.issueLink}>
                            {issue.externalKey ?? '연결 이슈'}
                          </Link>
                        </>
                      )}
                    </p>
                  </div>
                  <div className={styles.retestResults}>
                    {retest.items.map((item) => (
                      <span key={item.id} className={styles.platformResult}>
                        <small>{item.platform ? platformLabel[item.platform] : ''}</small>
                        <ResultTag result={item.result} />
                      </span>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
          {retests.length > 6 && (
            <Button size="sm" variant="ghost" onClick={() => setShowAllRetests((value) => !value)} aria-expanded={showAllRetests}>
              {showAllRetests ? '접기' : `${retests.length - 6}건 더 보기`}
            </Button>
          )}
        </section>

        <section aria-labelledby="round-title">
          <SectionHeader id="round-title" title="차수별 비교" meta={previous ? `${previous.round}차 → ${current.round}차` : undefined} />
          {previousCounts ? (
            <table className={styles.compare}>
              <thead>
                <tr>
                  <th scope="col">결과</th>
                  <th scope="col" className={styles.num}>
                    {previous?.round}차
                  </th>
                  <th scope="col" className={styles.num}>
                    {current.round}차
                  </th>
                  <th scope="col" className={styles.num}>
                    변화
                  </th>
                </tr>
              </thead>
              <tbody>
                {compareRounds(previousCounts, counts).map((row) => (
                  <tr key={row.value}>
                    <th scope="row">{testResultLabel[row.value]}</th>
                    <td className={styles.num}>{row.previous}</td>
                    <td className={styles.num}>{row.current}</td>
                    <td className={`${styles.num} ${styles.delta}`}>{row.delta > 0 ? `+${row.delta}` : row.delta}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className={styles.muted}>비교할 이전 차수가 없어요.</p>
          )}
          {previous && (
            <Link className={styles.compareLink} to={`?view=compare&base=${encodeURIComponent(previous.id)}&target=${encodeURIComponent(current.id)}`}>
              TC별 변화 보기 ({previous.round}차 → {current.round}차)
            </Link>
          )}
          {previous && (previous.executionType ?? 'full') !== (current.executionType ?? 'full') && (
            <p className={styles.compareNote}>
              {executionTypeLabel[previous.executionType ?? 'full']}과 {executionTypeLabel[current.executionType ?? 'full']}은 수행 범위가 달라 건수 변화는 참고용이에요.
            </p>
          )}

          <div className={styles.mapping}>
            <p className={styles.mappingTitle}>이 파일의 상태값 매핑</p>
            <p className={styles.mappingValues}>{current.mapping.map((mapping) => `${mapping.rawValue.trim() || '(빈 값)'} → ${testResultLabel[mapping.result]}`).join(' · ')}</p>
          </div>
        </section>
      </div>

      <p className={styles.footnote}>실제 검증은 고객사 양식에서 수동으로 수행하고, Looma는 결과와 이슈·근거를 빠르게 정리하는 데 집중합니다.</p>
      {uploadDialog}
    </div>
  );
}

/** 차수 탭 라벨. 전체 수행이 아니면 유형을 함께 보여준다. */
function roundLabel(item: TestResultImport): string {
  return item.executionType && item.executionType !== 'full' ? `${item.round}차 · ${executionTypeLabel[item.executionType]}` : `${item.round}차`;
}
