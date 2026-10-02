import type { Repositories } from '@/data';
import { countResults, executionRate, type ResultCounts } from '@/domain/resultSummary';
import type { Project, TestResultImport } from '@/domain/types';

export interface ProjectOverview {
  project: Project;
  deliverableCount: number;
  testCaseCount: number;
  draftCount: number;
  needsConfirmationCount: number;
  hasTemplate: boolean;
  latestImport?: TestResultImport;
  latestCounts?: ResultCounts;
  executionRate?: number;
  openIssueCount: number;
  openQuestionCount: number;
}

export async function loadProjectOverview(repos: Repositories, project: Project): Promise<ProjectOverview> {
  const [deliverables, testCases, imports, issues, requirements] = await Promise.all([
    repos.deliverables.listByProject(project.id),
    repos.testCases.listByProject(project.id),
    repos.testResults.listImports(project.id),
    repos.issues.listByProject(project.id),
    repos.requirements.listByProject(project.id),
  ]);
  const latestImport = imports.at(-1);
  const latestCounts = latestImport ? countResults(await repos.testResults.listResults(latestImport.id)) : undefined;

  return {
    project,
    deliverableCount: deliverables.length,
    testCaseCount: testCases.length,
    draftCount: testCases.filter((testCase) => testCase.status === 'draft').length,
    needsConfirmationCount: requirements.filter((requirement) => requirement.needsConfirmation).length,
    hasTemplate: !!project.tcTemplateId,
    latestImport,
    latestCounts,
    executionRate: latestCounts ? executionRate(latestCounts) : undefined,
    openIssueCount: issues.filter((issue) => issue.type === 'defect' && issue.status === 'open').length,
    openQuestionCount: issues.filter((issue) => issue.type === 'question' && issue.status === 'open').length,
  };
}
