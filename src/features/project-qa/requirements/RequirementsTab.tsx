import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { repositories } from '@/data';
import { useRepositoryData } from '@/hooks/useRepositoryData';
import { basePerspectives, scopeDrivenPerspectives, testPerspectiveLabel } from '@/domain/labels';
import { isTestDraftEligible } from '@/domain/testDraftGeneration';
import type { Requirement, TestPerspective } from '@/domain/types';
import { Button } from '@/components/ui/Button';
import { CheckboxGroup } from '@/components/ui/Field';
import { FilterTabs } from '@/components/ui/FilterTabs';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { SourceTypeTag, Tag } from '@/components/ui/Tag';
import { LoadingState, StateMessage } from '@/components/ui/StateMessage';
import { useProjectContext } from '../projectContext';
import { RequirementImportDialog } from './RequirementImportDialog';
import { TestDraftDialog } from './TestDraftDialog';
import styles from './RequirementsTab.module.css';

type RequirementFilter = 'all' | 'changes' | 'confirm' | 'removed';

export function RequirementsTab() {
  const { project, openDeliverableCreate } = useProjectContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = (searchParams.get('filter') as RequirementFilter | null) ?? 'all';

  const availablePerspectives: TestPerspective[] = [
    ...basePerspectives,
    ...project.testScopes.map((scope) => scopeDrivenPerspectives[scope]).filter((value): value is TestPerspective => !!value),
  ];
  const [perspectives, setPerspectives] = useState<TestPerspective[]>(basePerspectives);
  const [importOpen, setImportOpen] = useState(false);
  // TC 초안을 만들 요구사항은 보이는 요구사항 전체가 기본 선택이고, 사용자가 해제한 것만 기억한다.
  const [deselected, setDeselected] = useState<string[]>([]);
  const [draftOpen, setDraftOpen] = useState(false);

  const data = useRepositoryData(
    async (repos) => {
      const currentProject = (await repos.projects.get(project.id)) ?? project;
      return {
        requirements: await repos.requirements.listByProject(project.id),
        deliverables: await repos.deliverables.listByProject(project.id),
        issues: await repos.issues.listByProject(project.id),
        testConditions: await repos.testConditions.listByProject(project.id),
        testCases: await repos.testCases.listByProject(project.id),
        // 지금 저장된 프로젝트와 그 양식. 새 TC에 붙을 양식이 미리보기 뒤에 바뀌면 미리보기가 달라진 것으로 알 수 있게 항상 최신 값을 쓴다.
        currentProject,
        templates: currentProject.tcTemplateId ? [await repos.templates.get(currentProject.tcTemplateId)].filter((item): item is NonNullable<typeof item> => !!item) : [],
      };
    },
    [project.id],
  );

  if (data.status === 'loading') return <LoadingState />;
  if (data.status === 'error') return <StateMessage tone="error" title="요구사항을 불러오지 못했어요." />;

  const { requirements, deliverables, issues, testConditions, testCases, templates, currentProject } = data.data;
  // 가져오기 중 목록이 비어 있음 ↔ 있음으로 바뀌어도 대화상자가 다시 만들어지지 않도록 두 화면 모두 같은 자리에 둔다.
  const importDialog = importOpen ? <RequirementImportDialog open projectId={project.id} deliverables={deliverables} requirements={requirements} onClose={() => setImportOpen(false)} /> : null;
  if (requirements.length === 0) {
    return (
      <>
        <StateMessage
          title="분석된 요구사항이 없어요."
          description={
            deliverables.length === 0
              ? '먼저 기획서나 디자인 산출물을 추가하세요.'
              : '요구사항 파일(CSV · XLSX)을 가져오거나, 이후 연결될 AI 분석으로 산출물에서 기능 단위 요구사항을 추출할 수 있어요. AI 분석은 아직 연결되지 않았어요.'
          }
          action={
            deliverables.length === 0 ? (
              <Button variant="primary" onClick={openDeliverableCreate}>
                산출물 추가
              </Button>
            ) : (
              <Button variant="primary" onClick={() => setImportOpen(true)}>
                요구사항 가져오기
              </Button>
            )
          }
        />
        {importDialog}
      </>
    );
  }

  const deliverableName = (id: string) => {
    const deliverable = deliverables.find((item) => item.id === id);
    if (!deliverable) return '출처 없음';
    return deliverable.type === 'figma' ? 'Figma' : deliverable.type === 'pdf' ? '기획서' : deliverable.title;
  };
  const sourceText = (item: Requirement) => item.sourceRefs.map((ref) => `${deliverableName(ref.deliverableId)} ${ref.locator}`).join(', ');
  // 제거된 요구사항은 삭제하지 않고 이력으로 남기되, 기본 목록과 집계에서는 뺀다.
  const current = requirements.filter((item) => item.lifecycle !== 'removed');
  const removed = requirements.filter((item) => item.lifecycle === 'removed');
  const scope = filter === 'removed' ? removed : current;
  const visible = scope.filter((item) => (filter === 'changes' ? item.lifecycle === 'changed' : filter === 'confirm' ? item.needsConfirmation : true));
  const features = [...new Set(visible.map((item) => item.feature))];
  // 제거된 요구사항(제거됨 보기)은 TC 초안 대상이 아니다.
  const eligible = visible.filter((item) => isTestDraftEligible(item, project.id));
  const targetIds = eligible.filter((item) => !deselected.includes(item.id)).map((item) => item.id);
  const setTarget = (id: string, selected: boolean) => setDeselected((currentIds) => (selected ? currentIds.filter((item) => item !== id) : [...currentIds.filter((item) => item !== id), id]));
  const confirmItems = current.filter((item) => item.needsConfirmation);
  const alreadyAsked = (item: Requirement) => issues.some((issue) => issue.requirementId === item.id);

  const sendToQuestions = (item: Requirement) =>
    repositories.issues.create({
      projectId: project.id,
      type: 'question',
      title: item.text,
      feature: item.feature,
      requirementId: item.id,
      note: sourceText(item),
    });

  return (
    <>
    <div className={styles.layout}>
      <section aria-labelledby="features-title" className={styles.main}>
        <SectionHeader
          id="features-title"
          title="분석된 기능"
          meta={`기능 ${new Set(current.map((item) => item.feature)).size} · 확인 필요 ${confirmItems.length}`}
          action={
            <Button variant="secondary" size="sm" disabled={deliverables.length === 0} onClick={() => setImportOpen(true)}>
              요구사항 가져오기
            </Button>
          }
        />
        <p className={styles.legend}>
          <SourceTypeTag sourceType="source_explicit" /> 산출물에 적힌 내용
          <SourceTypeTag sourceType="ai_suggestion" /> 산출물에 없는 테스트 관점
          <SourceTypeTag sourceType="needs_confirmation" /> 기획 확인 전 확정 불가
        </p>
        <FilterTabs
          label="요구사항 보기"
          value={filter}
          onChange={(value) => setSearchParams(value === 'all' ? {} : { filter: value }, { replace: true })}
          options={[
            { value: 'all', label: '전체', count: current.length },
            { value: 'changes', label: '변경된 항목', count: current.filter((item) => item.lifecycle === 'changed').length },
            { value: 'confirm', label: '확인 필요', count: confirmItems.length },
            { value: 'removed', label: '제거됨', count: removed.length },
          ]}
        />

        <div className={styles.features}>
          {features.map((feature) => {
            const items = visible.filter((item) => item.feature === feature);
            const all = scope.filter((item) => item.feature === feature);
            const sources = [...new Set(all.map((item) => sourceText(item)))];
            return (
              <details key={feature} className={styles.feature} open={filter !== 'all'}>
                <summary className={styles.summary}>
                  <span className={styles.featureName}>{feature}</span>
                  <span className={styles.sources}>{sources.slice(0, 3).join(' · ')}</span>
                  <span className={styles.chips}>
                    <Tag tone="sky">요구사항 {all.length}</Tag>
                    {all.some((item) => item.needsConfirmation) && <Tag tone="coral">확인 필요 {all.filter((item) => item.needsConfirmation).length}</Tag>}
                    {all.some((item) => item.lifecycle === 'changed') && <Tag tone="outline">변경 {all.filter((item) => item.lifecycle === 'changed').length}</Tag>}
                  </span>
                  <span className={styles.expandHint} aria-hidden>
                    요구사항 보기 · 근거 확인
                  </span>
                </summary>
                <ul className={styles.requirements}>
                  {items.map((item) => (
                    <li key={item.id} className={`${styles.requirement} ${item.lifecycle === 'removed' ? styles.removed : ''}`}>
                      <div className={styles.requirementMeta}>
                        {item.lifecycle !== 'removed' && (
                          <label className={styles.pick}>
                            <input type="checkbox" checked={!deselected.includes(item.id)} onChange={(event) => setTarget(item.id, event.target.checked)} />
                            <span className="visually-hidden">TC 초안 대상: {item.text}</span>
                          </label>
                        )}
                        <SourceTypeTag sourceType={item.sourceType} />
                      </div>
                      <div>
                        <p className={styles.requirementText}>
                          <span className={styles.requirementBody}>{item.text}</span>
                          {item.lifecycle === 'changed' && <span className={styles.changeMark}>변경</span>}
                          {item.lifecycle === 'removed' && <span className={styles.removedMark}>제거됨</span>}
                        </p>
                        <p className={styles.locator}>
                          근거 · {sourceText(item)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </details>
            );
          })}
        </div>
      </section>

      <aside className={styles.aside}>
        <section aria-labelledby="confirm-title">
          <SectionHeader id="confirm-title" title="확인 필요" meta={`${confirmItems.length}개`} metaTone="coral" />
          <ul className={styles.confirmList}>
            {confirmItems.map((item) => (
              <li key={item.id} className={styles.confirmItem}>
                <p className={styles.confirmText}>{item.text}</p>
                <p className={styles.locator}>
                  {sourceText(item)}
                </p>
                {alreadyAsked(item) ? (
                  <span className={styles.asked}>확인사항에 등록됨</span>
                ) : (
                  <button type="button" className={styles.askButton} onClick={() => void sendToQuestions(item)}>
                    확인사항으로 보내기
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="scope-title" className={styles.scope}>
          <SectionHeader id="scope-title" title="테스트 범위" />
          <p className={styles.caption}>요구사항 목록에서 초안을 만들 요구사항을 고르고 테스트 관점을 선택합니다. API·성능·호환성은 프로젝트 범위에 있을 때만 보여요. 단서가 없는 관점은 만들지 않고, 기존 TC는 바꾸지 않아요.</p>
          <CheckboxGroup
            legend="테스트 관점"
            options={availablePerspectives.map((value) => ({ value, label: testPerspectiveLabel[value] }))}
            value={perspectives}
            onChange={setPerspectives}
          />
          <div className={styles.targetBar}>
            <p className={styles.caption} aria-live="polite">
              {filter === 'removed' ? '제거된 요구사항으로는 초안을 만들 수 없어요.' : `선택한 요구사항 ${targetIds.length} / ${eligible.length}개`}
            </p>
            <span className={styles.targetActions}>
              <button type="button" className={styles.linkButton} disabled={eligible.length === 0} onClick={() => setDeselected((currentIds) => currentIds.filter((id) => !eligible.some((item) => item.id === id)))}>
                모두 선택
              </button>
              <button type="button" className={styles.linkButton} disabled={eligible.length === 0} onClick={() => setDeselected((currentIds) => [...new Set([...currentIds, ...eligible.map((item) => item.id)])])}>
                모두 해제
              </button>
            </span>
          </div>
          <Button variant="primary" className={styles.generate} disabled={perspectives.length === 0 || targetIds.length === 0} onClick={() => setDraftOpen(true)}>
            선택 요구사항으로 TC 초안 만들기
          </Button>
        </section>
      </aside>
    </div>
    {importDialog}
    {draftOpen && (
      <TestDraftDialog
        open
        project={currentProject}
        requirements={requirements}
        deliverables={deliverables}
        testConditions={testConditions}
        testCases={testCases}
        templates={templates}
        requirementIds={targetIds}
        perspectives={perspectives}
        onClose={() => setDraftOpen(false)}
      />
    )}
    </>
  );
}
