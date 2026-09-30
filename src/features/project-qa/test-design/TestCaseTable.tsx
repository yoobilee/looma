import { Fragment, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { repositories } from '@/data';
import { generationTypeLabel, testCaseStatusLabel, testPerspectiveLabel } from '@/domain/labels';
import type { Deliverable, TestCase } from '@/domain/types';
import { SourceTypeTag } from '@/components/ui/Tag';
import styles from './TestCaseTable.module.css';

interface TestCaseTableProps {
  testCases: TestCase[];
  deliverables: Deliverable[];
}

function sourceLabel(testCase: TestCase, deliverables: Deliverable[]): string {
  if (testCase.duplicateOf) return testCase.duplicateOf;
  const ref = testCase.sourceRefs[0];
  if (!ref) return '출처 없음';
  const deliverable = deliverables.find((item) => item.id === ref.deliverableId);
  const prefix = deliverable?.type === 'figma' ? 'Figma' : deliverable?.type.toUpperCase() ?? '';
  return `${prefix} ${ref.locator}`.trim();
}

function statusText(testCase: TestCase): { label: string; tone: 'reviewed' | 'draft' | 'confirm' | 'duplicate' } {
  if (testCase.duplicateOf) return { label: '중복 후보', tone: 'duplicate' };
  if (testCase.generationType === 'needs_confirmation') return { label: '확인 필요', tone: 'confirm' };
  return { label: testCaseStatusLabel[testCase.status], tone: testCase.status === 'draft' ? 'draft' : 'reviewed' };
}

/** TC 초안 표. 행을 펼치면 사전 조건·절차·기대 결과와 검토 동작이 보인다. */
export function TestCaseTable({ testCases, deliverables }: TestCaseTableProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className={styles.scroller} role="region" aria-label="TC 초안 표" tabIndex={0}>
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
                <tr className={expanded ? styles.expandedRow : undefined}>
                  <td className={styles.id}>{testCase.externalId}</td>
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
                        <div className={styles.detailActions}>
                          {testCase.status === 'draft' ? (
                            <button
                              type="button"
                              className={styles.reviewButton}
                              disabled={testCase.generationType === 'needs_confirmation' || !!testCase.duplicateOf}
                              onClick={() => void repositories.testCases.updateStatus(testCase.id, 'reviewed')}
                            >
                              검토 완료로 표시
                            </button>
                          ) : (
                            <button type="button" className={styles.revertButton} onClick={() => void repositories.testCases.updateStatus(testCase.id, 'draft')}>
                              초안으로 되돌리기
                            </button>
                          )}
                          {(testCase.generationType === 'needs_confirmation' || testCase.duplicateOf) && testCase.status === 'draft' && (
                            <p className={styles.blockedNote}>
                              {testCase.duplicateOf ? '기존 TC와 비교해 신규 / 수정 / 제외를 먼저 정해 주세요.' : '확인사항이 답변되면 검토할 수 있어요.'}
                            </p>
                          )}
                        </div>
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
