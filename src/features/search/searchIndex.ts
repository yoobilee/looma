import { activityLinkLabel, activityLinkPath } from '@/domain/activityRecords';
import type { Activity, KnowledgeTerm, Project, ScratchItem, ScratchType, Task, TaskStatus, TestCase } from '@/domain/types';

export interface SearchSources {
  tasks: Task[];
  projects: Project[];
  testCases: TestCase[];
  terms: KnowledgeTerm[];
  scratch: ScratchItem[];
  /** 최신순(저장소 목록 순서 그대로)이어야 기록 그룹도 최신 먼저다. */
  activities: Activity[];
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

/**
 * 기록 결과가 가는 곳. 기존 원본 링크 정책을 활동 자신의 프로젝트 기준으로 그대로 쓰고,
 * 링크가 없으면(이전 기록 · 종류에 맞지 않는 key · 링크 없는 종류) 프로젝트 기록으로, 프로젝트가 없는 개인 활동은 전역 기록으로 간다.
 */
function activityDestination(activity: Activity): { to: string; original: boolean } {
  if (!activity.projectId) return { to: '/records', original: false };
  const original = activityLinkPath(activity, activity.projectId);
  return original ? { to: original, original: true } : { to: `/projects/${activity.projectId}/records`, original: false };
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
      label: '기록',
      // 사람이 읽는 내용(제목 · 요약 · 프로젝트명)만 찾는다. metadata의 내부 ID는 검색하지 않는다.
      items: sources.activities
        .filter((activity) => matches(query, activity.title, activity.metadata.detail, projectName(activity.projectId)))
        .map((activity) => {
          const { to, original } = activityDestination(activity);
          // 변경 분석 기록은 그 분석이 아니라 현재 테스트 설계 탭으로 가므로 목적지를 meta에 밝힌다.
          const destination = original && activityLinkLabel(activity) ? '테스트 설계로 이동' : undefined;
          const meta = [activity.projectId ? projectName(activity.projectId) : '개인', activity.metadata.detail, destination].filter(Boolean).join(' · ');
          return { id: activity.id, title: activity.title, meta, to };
        }),
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
