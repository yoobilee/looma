import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download, FileSpreadsheet, FileText, Sparkles, Upload } from 'lucide-react';
import { useRepositoryData } from '@/hooks/useRepositoryData';
import type { TestCase } from '@/domain/types';
import { Button, ButtonLink } from '@/components/ui/Button';
import { FilterTabs } from '@/components/ui/FilterTabs';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { LoadingState, StateMessage } from '@/components/ui/StateMessage';
import { useProjectContext } from '../projectContext';
import { ChangeImpactPanel } from './ChangeImpactPanel';
import { TestCaseTable } from './TestCaseTable';
import { TemplateSetupDialog, type TemplateSetupMode } from './TemplateSetupDialog';
import { TestAssetImportDialog } from './TestAssetImportDialog';
import styles from './TestDesignTab.module.css';

type CaseFilter = 'all' | 'draft' | 'reviewed' | 'confirm' | 'duplicate' | 'needs_review' | 'deprecated';

function matchesFilter(testCase: TestCase, filter: CaseFilter): boolean {
  if (filter === 'draft') return testCase.status === 'draft' && testCase.generationType !== 'needs_confirmation' && !testCase.duplicateOf;
  if (filter === 'reviewed') return testCase.status === 'reviewed' || testCase.status === 'active';
  if (filter === 'confirm') return testCase.generationType === 'needs_confirmation' && testCase.status !== 'deprecated';
  if (filter === 'duplicate') return !!testCase.duplicateOf && testCase.status !== 'deprecated';
  if (filter === 'needs_review') return testCase.status === 'needs_review';
  if (filter === 'deprecated') return testCase.status === 'deprecated';
  return true;
}

export function TestDesignTab() {
  const { project } = useProjectContext();
  const [searchParams] = useSearchParams();
  const initialSetup: TemplateSetupMode | null =
    searchParams.get('entry') === 'description' ? 'description' : searchParams.get('panel') === 'template' ? 'existing_tc' : null;
  const [setupMode, setSetupMode] = useState<TemplateSetupMode | null>(initialSetup);
  // 이슈 · 확인사항 등에서 `?tc=<id>`로 들어오면 전체 목록에서 그 TC를 펼친다.
  const focusTestCaseId = searchParams.get('tc') ?? undefined;
  const [filter, setFilter] = useState<CaseFilter>('all');
  const [importOpen, setImportOpen] = useState(false);

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
    needs_review: testCases.filter((item) => matchesFilter(item, 'needs_review')).length,
    deprecated: testCases.filter((item) => matchesFilter(item, 'deprecated')).length,
  };
  const visible = testCases.filter((item) => matchesFilter(item, filter));
  const hasDeliverables = deliverables.length > 0;

  return (
    <div className={styles.page}>
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
            <strong>요구사항에서 기본 초안 만들기</strong>
            <small>{hasDeliverables ? '요구사항 선택 → 관점 선택 → 초안 미리보기 → 검토' : '산출물을 먼저 추가하세요'}</small>
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
            <div className={styles.headerActions}>
              <Button size="sm" variant="secondary" icon={<Upload aria-hidden />} onClick={() => setImportOpen(true)}>
                TC 가져오기
              </Button>
              <Button size="sm" variant="secondary" icon={<Download aria-hidden />} disabled title="XLSX 내보내기는 다음 단계에서 연결돼요">
                고객사 양식으로 내보내기
              </Button>
            </div>
          }
        />
        {testCases.length === 0 ? (
          <StateMessage
            title="아직 TC 초안이 없어요."
            description="요구사항에서 선택한 관점으로 기본 TC 초안을 만들거나(AI 초안은 아직 연결되지 않았어요) 고객사가 쓰던 TC 파일을 가져오세요. 만든 초안은 사람이 검토하기 전까지 확정되지 않아요."
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
                  { value: 'needs_review', label: '재검토 필요', count: counts.needs_review },
                  { value: 'deprecated', label: '폐기', count: counts.deprecated },
                ]}
              />
            </div>
            <TestCaseTable testCases={visible} deliverables={deliverables} initialExpandedId={focusTestCaseId} />
          </>
        )}
      </section>

      <ChangeImpactPanel projectId={project.id} testCases={testCases} deliverables={deliverables} />

      {importOpen && <TestAssetImportDialog open projectId={project.id} testCases={testCases} onClose={() => setImportOpen(false)} />}

      {setupMode && (
        <TemplateSetupDialog open mode={setupMode} project={project} currentTemplate={template} onClose={() => setSetupMode(null)} key={setupMode} />
      )}
    </div>
  );
}
