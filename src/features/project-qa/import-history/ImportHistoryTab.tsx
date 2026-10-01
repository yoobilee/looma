import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useRepositoryData } from '@/hooks/useRepositoryData';
import {
  buildImportHistory,
  filterImportHistory,
  type AssetImportHistoryItem,
  type ImportHistoryFilter,
  type ImportHistoryItem,
  type ResultImportHistoryItem,
} from '@/domain/importHistory';
import { resultImportSummaryText } from '@/domain/testResultImport';
import { executionTypeLabel, platformLabel } from '@/domain/labels';
import type { ImportSourceFormat } from '@/domain/types';
import { formatDateTime } from '@/lib/date';
import { FilterTabs } from '@/components/ui/FilterTabs';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { Tag } from '@/components/ui/Tag';
import { LoadingState, StateMessage } from '@/components/ui/StateMessage';
import { useProjectContext } from '../projectContext';
import { SourceExportAction } from '../source-export/SourceExportAction';
import styles from './ImportHistoryTab.module.css';

function assetSummary(item: AssetImportHistoryItem): string {
  return `신규 ${item.created} · 업데이트 ${item.updated} · 동일 ${item.unchanged} · 제외 ${item.excluded}`;
}

/** 수행일 · 환경 · 플랫폼 중 있는 것만 잇는다. */
function resultMeta(item: ResultImportHistoryItem): string[] {
  const period = item.executedFrom ? `수행일 ${item.executedFrom.replaceAll('-', '.')}${item.executedTo ? ` ~ ${item.executedTo.replaceAll('-', '.')}` : ''}` : undefined;
  return [period, item.environment, item.platform && platformLabel[item.platform]].filter((value): value is string => !!value);
}

function HistoryRow({ item, base, sourceFormat }: { item: ImportHistoryItem; base: string; sourceFormat?: ImportSourceFormat }) {
  const isResult = item.type === 'result';
  const meta = isResult ? resultMeta(item) : [`총 ${item.totalRows}행`];
  return (
    <li className={styles.item}>
      <div className={styles.head}>
        <Tag tone={isResult ? 'coral' : 'sky'}>{isResult ? '수행 결과 가져오기' : 'TC 가져오기'}</Tag>
        <time className={styles.time} dateTime={item.importedAt}>
          {formatDateTime(item.importedAt)}
        </time>
      </div>
      <p className={styles.title}>
        {isResult && <span>{`${item.round}차 · ${executionTypeLabel[item.executionType]}`} · </span>}
        <span className={styles.fileName}>{item.fileName}</span>
      </p>
      <p className={styles.summary}>{isResult ? resultImportSummaryText(item.summary) : assetSummary(item)}</p>
      {meta.length > 0 && <p className={styles.meta}>{meta.join(' · ')}</p>}
      <Link className={styles.link} to={isResult ? `${base}/results?import=${encodeURIComponent(item.id)}` : `${base}/test-design`}>
        {isResult ? '수행 결과 보기' : '테스트 설계 보기'}
      </Link>
      <SourceExportAction kind={item.type} projectId={item.projectId} recordId={item.id} sourceFormat={sourceFormat} />
    </li>
  );
}

/**
 * 프로젝트의 TC 가져오기와 수행 결과 가져오기 이력. 저장된 기록을 모아 보여 주기만 하는 읽기 전용 화면이며
 * 전체 업무 활동 타임라인(기록)과 달리 가져오기 작업만 다룬다.
 */
export function ImportHistoryTab() {
  const { project } = useProjectContext();
  const [filter, setFilter] = useState<ImportHistoryFilter>('all');
  const base = `/projects/${project.id}`;

  const data = useRepositoryData(
    async (repos) => {
      const [sessions, resultImports] = await Promise.all([repos.testAssetImports.listByProject(project.id), repos.testResults.listImports(project.id)]);
      const resultsByImport = Object.fromEntries(await Promise.all(resultImports.map(async (item) => [item.id, await repos.testResults.listResults(item.id)] as const)));
      const items = buildImportHistory(sessions, resultImports, resultsByImport);
      // 원본 형식 내보내기를 쓸 수 있는지 알기 위해 보관한 원본의 형식만 읽는다(bytes는 읽지 않는다).
      const artifactIds = items.flatMap((item) => (item.artifactId ? [item.artifactId] : []));
      const artifacts = await Promise.all(artifactIds.map((id) => repos.importSources.get(id)));
      const formatByArtifact = Object.fromEntries(artifacts.flatMap((artifact) => (artifact ? [[artifact.id, artifact.format] as const] : [])));
      return { items, formatByArtifact };
    },
    [project.id],
  );

  if (data.status === 'loading') return <LoadingState />;
  if (data.status === 'error') return <StateMessage tone="error" title="가져오기 이력을 불러오지 못했어요." />;

  const { items: all, formatByArtifact } = data.data;
  const visible = filterImportHistory(all, filter);

  if (all.length === 0) {
    return (
      <StateMessage
        title="아직 가져오기 이력이 없어요."
        description={
          <>
            TC 파일은 <Link to={`${base}/test-design`}>테스트 설계</Link>에서, 수행 결과 파일은 <Link to={`${base}/results`}>수행 결과</Link>에서 가져올 수 있어요.
          </>
        }
      />
    );
  }

  return (
    <section className={styles.page} aria-labelledby="import-history-title">
      <SectionHeader id="import-history-title" title="가져오기 이력" meta={`${visible.length}건`} />
      <p className={styles.intro}>원본 형식 내보내기는 가져온 원본 XLSX의 기존 문자열 셀에만 지금 값을 반영해요. 신규 TC는 포함되지 않고, 바꿀 칸이 수식 · 병합 · 숫자 셀이거나 원본에 없는 셀이면 파일을 만들지 않아요. 원본 XLSX가 보관된 가져오기에서만 쓸 수 있어요.</p>
      <FilterTabs
        label="가져오기 종류"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: '전체', count: all.length },
          { value: 'asset', label: 'TC 가져오기', count: filterImportHistory(all, 'asset').length },
          { value: 'result', label: '수행 결과 가져오기', count: filterImportHistory(all, 'result').length },
        ]}
      />
      {visible.length === 0 ? (
        <StateMessage compact title="이 종류의 가져오기 이력이 없어요." />
      ) : (
        <ul className={styles.list}>
          {visible.map((item) => (
            <HistoryRow key={`${item.type}-${item.id}`} item={item} base={base} sourceFormat={item.artifactId ? formatByArtifact[item.artifactId] : undefined} />
          ))}
        </ul>
      )}
    </section>
  );
}
