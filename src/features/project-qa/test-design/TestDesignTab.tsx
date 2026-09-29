import { useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { Download, FileSpreadsheet, FileText, Sparkles } from 'lucide-react';
import { useRepositoryData } from '@/hooks/useRepositoryData';
import { testPerspectiveLabel } from '@/domain/labels';
import type { TestCase, TestPerspective } from '@/domain/types';
import { Button, ButtonLink } from '@/components/ui/Button';
import { FilterTabs } from '@/components/ui/FilterTabs';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { LoadingState, StateMessage } from '@/components/ui/StateMessage';
import { useProjectContext } from '../projectContext';
import { TestCaseTable } from './TestCaseTable';
import { TemplateSetupDialog, type TemplateSetupMode } from './TemplateSetupDialog';
import styles from './TestDesignTab.module.css';

type CaseFilter = 'all' | 'draft' | 'reviewed' | 'confirm' | 'duplicate';

function matchesFilter(testCase: TestCase, filter: CaseFilter): boolean {
  if (filter === 'draft') return testCase.reviewStatus === 'draft' && testCase.generationType !== 'needs_confirmation' && !testCase.duplicateOf;
  if (filter === 'reviewed') return testCase.reviewStatus !== 'draft';
  if (filter === 'confirm') return testCase.generationType === 'needs_confirmation';
  if (filter === 'duplicate') return !!testCase.duplicateOf;
  return true;
}

export function TestDesignTab() {
  const { project } = useProjectContext();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const requestedPerspectives = (location.state as { requestedPerspectives?: TestPerspective[] } | null)?.requestedPerspectives;
  const initialSetup: TemplateSetupMode | null =
    searchParams.get('entry') === 'description' ? 'description' : searchParams.get('panel') === 'template' ? 'existing_tc' : null;
  const [setupMode, setSetupMode] = useState<TemplateSetupMode | null>(initialSetup);
  const [filter, setFilter] = useState<CaseFilter>('all');

  const data = useRepositoryData(
    async (repos) => ({
      testCases: await repos.testCases.listByProject(project.id),
      deliverables: await repos.deliverables.listByProject(project.id),
      template: project.tcTemplateId ? await repos.templates.get(project.tcTemplateId) : undefined,
    }),
    [project.id, project.tcTemplateId],
  );

  if (data.status === 'loading') return <LoadingState />;
  if (data.status === 'error') return <StateMessage tone="error" title="TC 설계 정보를 불러오지 못했어요." />;

  const { testCases, deliverables, template } = data.data;
  const counts = {
    all: testCases.length,
    draft: testCases.filter((item) => matchesFilter(item, 'draft')).length,
    reviewed: testCases.filter((item) => matchesFilter(item, 'reviewed')).length,
    confirm: testCases.filter((item) => matchesFilter(item, 'confirm')).length,
    duplicate: testCases.filter((item) => matchesFilter(item, 'duplicate')).length,
  };
  const visible = testCases.filter((item) => matchesFilter(item, filter));
  const hasDeliverables = deliverables.length > 0;

  return (
    <div className={styles.page}>
      {requestedPerspectives && (
        <div className={styles.notice} role="status">
          <Sparkles aria-hidden />
          <p>
            선택한 관점: <strong>{requestedPerspectives.map((value) => testPerspectiveLabel[value]).join(', ')}</strong>
            <br />
            AI 초안 생성은 아직 연결되지 않았어요. 연결되면 이 관점으로 초안을 만들고, 아래 목록처럼 근거와 생성 유형을 붙여 검토 대기 상태로 추가합니다.
          </p>
        </div>
      )}

      <section className={styles.templateBar} aria-labelledby="template-title">
        <div className={styles.templateInfo}>
          <h2 id="template-title" className={styles.templateTitle}>
            {template ? `고객사 TC Template 사용 중 · ${template.name}` : 'TC Template 미설정'}
          </h2>
          <p className={styles.templateColumns}>
            {template ? template.columns.join(' · ') : '기존 TC를 올리거나 프로젝트 설명으로 양식을 만들면 초안과 내보내기에 적용돼요.'}
          </p>
        </div>
        <div className={styles.templateActions}>
          <Button variant="secondary" onClick={() => setSetupMode('existing_tc')}>
            Template 설정
          </Button>
          <Button variant="accent" icon={<Sparkles aria-hidden />} disabled title="AI 연결 후 사용할 수 있어요">
            AI 초안 생성
          </Button>
        </div>
      </section>

      <section aria-labelledby="entry-title" className={styles.entries}>
        <h2 id="entry-title" className="visually-hidden">
          TC 설계 시작 방법
        </h2>
        <ButtonLink to={`/projects/${project.id}/requirements`} className={styles.entry} variant="ghost">
          <FileText aria-hidden />
          <span>
            <strong>산출물에서 생성</strong>
            <small>{hasDeliverables ? '요구사항 분석 → 범위 선택 → 초안 → 검토' : '산출물을 먼저 추가하세요'}</small>
          </span>
        </ButtonLink>
        <button type="button" className={styles.entry} onClick={() => setSetupMode('existing_tc')}>
          <FileSpreadsheet aria-hidden />
          <span>
            <strong>기존 TC 기반으로 이어서 설계</strong>
            <small>컬럼 · ID 규칙 · Depth · 문체를 이어받기</small>
          </span>
        </button>
        <button type="button" className={styles.entry} onClick={() => setSetupMode('description')}>
          <Sparkles aria-hidden />
          <span>
            <strong>프로젝트 설명으로 TC 양식 생성</strong>
            <small>새 프로젝트에서 양식이 없을 때</small>
          </span>
        </button>
      </section>

      <section aria-labelledby="tc-draft-title">
        <SectionHeader
          id="tc-draft-title"
          title="TC 초안"
          meta={`${counts.all}개 · 검토 완료 ${counts.reviewed} · 중복 후보 ${counts.duplicate}`}
          action={
            <Button size="sm" variant="secondary" icon={<Download aria-hidden />} disabled title="XLSX 내보내기는 다음 단계에서 연결돼요">
              고객사 양식으로 내보내기
            </Button>
          }
        />
        {testCases.length === 0 ? (
          <StateMessage
            title="아직 TC 초안이 없어요."
            description="위 세 가지 방법 중 하나로 시작하세요. AI가 만든 초안은 사람이 검토하기 전까지 확정되지 않아요."
          />
        ) : (
          <>
            <div className={styles.filters}>
              <FilterTabs
                label="TC 상태"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'all', label: '전체', count: counts.all },
                  { value: 'draft', label: '검토 대기', count: counts.draft },
                  { value: 'reviewed', label: '검토 완료', count: counts.reviewed },
                  { value: 'confirm', label: '확인 필요', count: counts.confirm },
                  { value: 'duplicate', label: '중복 후보', count: counts.duplicate },
                ]}
              />
            </div>
            <TestCaseTable testCases={visible} deliverables={deliverables} />
          </>
        )}
      </section>

      <section className={styles.changeBanner} aria-labelledby="change-banner-title">
        <div>
          <h2 id="change-banner-title" className={styles.bannerTitle}>
            신규/변경 기능만 골라 TC를 다시 설계할 수 있어요.
          </h2>
          <p className={styles.bannerText}>기존 TC와 비교해 수정 후보 / 신규 후보 / 중복 후보를 분리합니다.</p>
        </div>
        <ButtonLink to={`/projects/${project.id}/requirements?filter=changes`} variant="primary">
          변경 영향 기준으로 보기
        </ButtonLink>
      </section>

      {setupMode && (
        <TemplateSetupDialog open mode={setupMode} project={project} currentTemplate={template} onClose={() => setSetupMode(null)} key={setupMode} />
      )}
    </div>
  );
}
