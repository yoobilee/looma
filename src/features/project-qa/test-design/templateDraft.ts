import type { Platform, Project, ResultMapping, TCTemplate } from '@/domain/types';
import { platformLabel } from '@/domain/labels';

export const defaultResultMappings: ResultMapping[] = [
  { rawValue: 'PASS', result: 'pass' },
  { rawValue: 'FAIL', result: 'fail' },
  { rawValue: 'BLOCKED', result: 'blocked' },
  { rawValue: 'N/T', result: 'not_tested' },
];

/**
 * 프로젝트 정보로 TC 양식 초안을 만든다.
 * AI 연결 전까지는 규칙 기반이며, 사용자가 검토한 뒤 저장한다.
 */
export function draftTemplateFromProject(project: Pick<Project, 'name' | 'platforms' | 'testScopes'>): Omit<TCTemplate, 'id' | 'projectId'> {
  const platformColumns = project.platforms.length > 0 ? project.platforms.map((platform: Platform) => platformLabel[platform]) : ['결과'];
  const scopeColumns = project.testScopes.includes('api') ? ['API / Endpoint'] : [];
  const performanceColumns = project.testScopes.includes('performance') ? ['기준값', '측정값'] : [];
  return {
    name: `${project.name} TC 양식 초안`,
    columns: ['대분류', '중분류', '소분류', 'Pre-condition', 'Test Step', 'Expected Result', ...scopeColumns, ...performanceColumns, ...platformColumns, 'Issue', '비고'],
    idRule: '기능코드-세 자리 번호',
    depthRule: '대분류 › 중분류 › 소분류 3단계',
    styleHints: '짧은 명사형 문장',
    resultMappings: defaultResultMappings,
  };
}
