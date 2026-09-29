import type { KnowledgeTerm, Project, ScratchItem, ScratchType, Task, TaskStatus, TestCase } from '@/domain/types';

export interface SearchSources {
  tasks: Task[];
  projects: Project[];
  testCases: TestCase[];
  terms: KnowledgeTerm[];
  scratch: ScratchItem[];
}

export interface SearchResultItem {
  id: string;
  title: string;
  meta: string;
  to: string;
}

export interface SearchGroup {
  label: string;
  items: SearchResultItem[];
}

interface Labels {
  taskStatusLabel: Record<TaskStatus, string>;
  scratchTypeLabel: Record<ScratchType, string>;
}

const PER_GROUP = 5;

function matches(query: string, ...fields: (string | undefined)[]): boolean {
  return fields.some((field) => field?.toLowerCase().includes(query));
}

export function searchAll(sources: SearchSources, rawQuery: string, labels: Labels): SearchGroup[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];
  const projectName = (id?: string) => sources.projects.find((project) => project.id === id)?.name;

  const groups: SearchGroup[] = [
    {
      label: '업무',
      items: sources.tasks
        .filter((task) => matches(query, task.title, task.notes, ...task.tags))
        .map((task) => ({
          id: task.id,
          title: task.title,
          meta: [labels.taskStatusLabel[task.status], projectName(task.projectId) ?? '개인'].join(' · '),
          to: '/work',
        })),
    },
    {
      label: '프로젝트',
      items: sources.projects
        .filter((project) => matches(query, project.name, project.clientName, project.serviceName))
        .map((project) => ({ id: project.id, title: project.name, meta: project.clientName ?? '', to: `/projects/${project.id}` })),
    },
    {
      label: 'TC',
      items: sources.testCases
        .filter((testCase) => matches(query, testCase.externalId, testCase.title, testCase.feature))
        .map((testCase) => ({
          id: testCase.id,
          title: `${testCase.externalId ?? ''} ${testCase.title}`.trim(),
          meta: [testCase.feature, projectName(testCase.projectId)].filter(Boolean).join(' · '),
          to: `/projects/${testCase.projectId}/test-design`,
        })),
    },
    {
      label: '업무 지식',
      items: sources.terms
        .filter((term) => matches(query, term.term, term.explanation, ...term.tags))
        .map((term) => ({ id: term.id, title: term.term, meta: term.explanation, to: `/knowledge/${term.id}` })),
    },
    {
      label: '임시 자료',
      items: sources.scratch
        .filter((item) => matches(query, item.title, item.content))
        .map((item) => ({ id: item.id, title: item.title ?? labels.scratchTypeLabel[item.type], meta: labels.scratchTypeLabel[item.type], to: '/scratch' })),
    },
  ];

  return groups.map((group) => ({ ...group, items: group.items.slice(0, PER_GROUP) })).filter((group) => group.items.length > 0);
}
