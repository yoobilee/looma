import { Fragment, useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { repositories } from '@/data';
import { generationTypeLabel, testCaseStatusLabel, testPerspectiveLabel } from '@/domain/labels';
import type { Deliverable, TestCase } from '@/domain/types';
import { SourceTypeTag } from '@/components/ui/Tag';
import styles from './TestCaseTable.module.css';

interface TestCaseTableProps {
  testCases: TestCase[];
  deliverables: Deliverable[];
  /** 처음 펼쳐 보여 줄 TC(다른 화면의 링크로 들어온 경우). 그 행으로 스크롤하고 초점을 옮긴다. */
  initialExpandedId?: string;
}

function sourceLabel(testCase: TestCase, deliverables: Deliverable[]): string {
  if (testCase.duplicateOf) return testCase.duplicateOf;
  const ref = testCase.sourceRefs[0];
  if (!ref) return testCase.importSource ? `가져온 TC ${testCase.importSource.rowNumber}행` : '출처 없음';
  const deliverable = deliverables.find((item) => item.id === ref.deliverableId);
  const prefix = deliverable?.type === 'figma' ? 'Figma' : deliverable?.type.toUpperCase() ?? '';
  return `${prefix} ${ref.locator}`.trim();
}

type StatusTone = 'reviewed' | 'draft' | 'confirm' | 'duplicate' | 'needsReview' | 'deprecated';

function statusText(testCase: TestCase): { label: string; tone: StatusTone } {
  // 수명주기 상태(폐기·재검토)가 초안 단계 표시보다 우선한다.
  if (testCase.status === 'deprecated') return { label: testCaseStatusLabel.deprecated, tone: 'deprecated' };
  if (testCase.status === 'needs_review') return { label: testCaseStatusLabel.needs_review, tone: 'needsReview' };
  if (testCase.duplicateOf) return { label: '중복 후보', tone: 'duplicate' };
  if (testCase.generationType === 'needs_confirmation') return { label: '확인 필요', tone: 'confirm' };
  return { label: testCaseStatusLabel[testCase.status], tone: testCase.status === 'draft' ? 'draft' : 'reviewed' };
}

/**
 * 상태별 검토 동작.
 * draft → 검토 완료, reviewed → 초안으로 되돌리기, needs_review → 다시 검토 완료.
 * active·deprecated는 여기서 바꾸지 않는다(변경 영향 분석의 제안을 거쳐 반영).
 */
function StatusActions({ testCase }: { testCase: TestCase }) {
  const markReviewed = () => void repositories.testCases.updateStatus(testCase.id, 'reviewed');
  const blocked = testCase.generationType === 'needs_confirmation' || !!testCase.duplicateOf;

  return (
    <div className={styles.detailActions}>
      {testCase.status === 'draft' && (
        <>
          <button type="button" className={styles.reviewButton} disabled={blocked} onClick={markReviewed}>
            검토 완료로 표시
          </button>
          {blocked && (
            <p className={styles.blockedNote}>
              {testCase.duplicateOf ? '기존 TC와 비교해 신규 / 수정 / 제외를 먼저 정해 주세요.' : '확인사항이 답변되면 검토할 수 있어요.'}
            </p>
          )}
        </>
      )}
      {testCase.status === 'reviewed' && (
        <button type="button" className={styles.revertButton} onClick={() => void repositories.testCases.updateStatus(testCase.id, 'draft')}>
          초안으로 되돌리기
        </button>
      )}
      {testCase.status === 'needs_review' && (
        <>
          <button type="button" className={styles.reviewButton} onClick={markReviewed}>
            다시 검토 완료로 표시
          </button>
          <p className={styles.blockedNote}>근거 요구사항이 바뀌었어요. 절차와 기대 결과를 다시 확인해 주세요.</p>
        </>
      )}
      {testCase.status === 'active' && <p className={styles.blockedNote}>사용 중인 TC예요. 바꿀 내용은 변경 영향 분석의 수정 제안으로 검토해요.</p>}
      {testCase.status === 'deprecated' && <p className={styles.blockedNote}>폐기된 TC예요. 기존 수행 결과 연결은 그대로 유지돼요.</p>}
    </div>
  );
}

/** TC 초안 표. 행을 펼치면 사전 조건·절차·기대 결과와 검토 동작이 보인다. */
export function TestCaseTable({ testCases, deliverables, initialExpandedId }: TestCaseTableProps) {
  const [expandedId, setExpandedId] = useState<string | null>(initialExpandedId ?? null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!initialExpandedId) return;
    const button = scrollerRef.current?.querySelector<HTMLElement>(`[aria-controls="tc-detail-${CSS.escape(initialExpandedId)}"]`);
    button?.scrollIntoView({ block: 'center' });
    button?.focus({ preventScroll: true });
  }, [initialExpandedId]);

  return (
    <div ref={scrollerRef} className={styles.scroller} role="region" aria-label="TC 초안 표" tabIndex={0}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">ID</th>
            <th scope="col">구분</th>
            <th scope="col">대분류</th>
            <th scope="col">중분류</th>
            <th scope="col" className={styles.titleCol}>
              테스트 항목
            </th>
            <th scope="col">근거</th>
            <th scope="col">생성 유형</th>
            <th scope="col">상태</th>
          </tr>
        </thead>
        <tbody>
          {testCases.map((testCase) => {
            const expanded = expandedId === testCase.id;
            const status = statusText(testCase);
            const detailId = `tc-detail-${testCase.id}`;
            return (
              <Fragment key={testCase.id}>
                <tr className={[expanded ? styles.expandedRow : '', testCase.status === 'deprecated' ? styles.deprecatedRow : ''].join(' ').trim() || undefined}>
                  <td className={styles.id}>{testCase.externalId ?? <span className={styles.muted}>미지정</span>}</td>
                  <td className={styles.muted}>{testPerspectiveLabel[testCase.category]}</td>
                  <td>{testCase.depth[0]}</td>
                  <td>{testCase.depth[1]}</td>
                  <td className={styles.titleCol}>
                    <button
                      type="button"
                      className={styles.titleButton}
                      aria-expanded={expanded}
                      aria-controls={detailId}
                      onClick={() => setExpandedId(expanded ? null : testCase.id)}
                    >
                      {testCase.title}
                      <ChevronDown aria-hidden className={styles.chevron} />
                    </button>
                  </td>
                  <td className={styles.source}>{sourceLabel(testCase, deliverables)}</td>
                  <td>
                    <SourceTypeTag sourceType={testCase.generationType} label={generationTypeLabel[testCase.generationType].replace(' 테스트 관점', '')} />
                  </td>
                  <td className={`${styles.status} ${styles[status.tone]}`}>{status.label}</td>
                </tr>
                {expanded && (
                  <tr id={detailId} className={styles.detailRow}>
                    <td colSpan={8}>
                      <div className={styles.detail}>
                        <dl>
                          <div>
                            <dt>Depth</dt>
                            <dd>{testCase.depth.join(' › ')}</dd>
                          </div>
                          <div>
                            <dt>Pre-condition</dt>
                            <dd>{testCase.precondition ?? '없음'}</dd>
                          </div>
                          <div>
                            <dt>Test Step</dt>
                            <dd>
                              <ol>
                                {testCase.steps.map((step) => (
                                  <li key={step}>{step}</li>
                                ))}
                              </ol>
                            </dd>
                          </div>
                          <div>
                            <dt>Expected Result</dt>
                            <dd>{testCase.expectedResult}</dd>
                          </div>
                          <div>
                            <dt>생성 유형</dt>
                            <dd>{generationTypeLabel[testCase.generationType]}</dd>
                          </div>
                        </dl>
                        <StatusActions testCase={testCase} />
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
