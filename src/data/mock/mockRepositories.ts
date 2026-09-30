import type { Activity, ActivityType, ScratchItem } from '@/domain/types';
import { testCaseStatusLabel } from '@/domain/labels';
import type { Repositories } from '../repositories/types';
import { createSeed, type SeedData } from './seed';

const SCRATCH_LIFETIME_MS = 12 * 60 * 60 * 1000;

let idCounter = 0;
function createId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function byNewest<T>(pick: (item: T) => string) {
  return (a: T, b: T) => new Date(pick(b)).getTime() - new Date(pick(a)).getTime();
}

function notFound(kind: string, id: string): Error {
  return new Error(`${kind}을(를) 찾을 수 없어요. (${id})`);
}

/**
 * 메모리 기반 mock 저장소. 새로고침하면 예시 데이터로 돌아간다.
 * 상태 변경 시 Activity를 자동으로 남겨 "기록" 화면과 연결한다.
 */
export function createMockRepositories(seed: SeedData = createSeed()): Repositories {
  const db = structuredClone(seed);
  const listeners = new Set<() => void>();

  const emit = () => listeners.forEach((listener) => listener());

  const record = (type: ActivityType, title: string, extra: Partial<Activity> = {}) => {
    db.activities.push({
      id: createId('act'),
      type,
      title,
      metadata: {},
      createdAt: nowIso(),
      ...extra,
    });
  };

  const isAlive = (item: ScratchItem) => !!item.pinnedAt || !item.expiresAt || new Date(item.expiresAt) > new Date();

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    tasks: {
      async list() {
        return [...db.tasks];
      },
      async get(id) {
        return db.tasks.find((task) => task.id === id);
      },
      async create(input) {
        const task = {
          id: createId('task'),
          title: input.title.trim(),
          status: 'planned' as const,
          dueAt: input.dueAt,
          projectId: input.projectId,
          notes: input.notes,
          tags: input.tags ?? [],
          repeat: input.repeat ?? 'none',
          createdAt: nowIso(),
        };
        db.tasks.push(task);
        record('task_created', `${task.title} 업무 생성`, { taskId: task.id, projectId: task.projectId, metadata: { detail: '업무 생성' } });
        emit();
        return task;
      },
      async updateStatus(id, status) {
        const task = db.tasks.find((item) => item.id === id);
        if (!task) throw notFound('업무', id);
        if (task.status === status) return task;
        task.status = status;
        if (status === 'in_progress') {
          task.startedAt = nowIso();
          record('task_started', `${task.title} 시작`, { taskId: id, projectId: task.projectId, metadata: { detail: '업무 시작' } });
        }
        if (status === 'done') {
          task.completedAt = nowIso();
          record('task_completed', `${task.title} 완료`, { taskId: id, projectId: task.projectId, metadata: { detail: '업무 완료' } });
        } else {
          task.completedAt = undefined;
        }
        emit();
        return task;
      },
    },

    projects: {
      async list() {
        return [...db.projects];
      },
      async get(id) {
        return db.projects.find((project) => project.id === id);
      },
      async create(input) {
        const project = {
          id: createId('proj'),
          status: 'preparing' as const,
          currentStage: 'deliverables' as const,
          ...input,
        };
        db.projects.push(project);
        record('project_changed', `${project.name} 프로젝트 생성`, { projectId: project.id, metadata: { detail: '프로젝트 생성' } });
        emit();
        return project;
      },
    },

    deliverables: {
      async listByProject(projectId) {
        return db.deliverables.filter((item) => item.projectId === projectId).sort(byNewest((item) => item.importedAt));
      },
      async create(input) {
        if (input.previousRevisionId) {
          const previous = db.deliverables.find((item) => item.id === input.previousRevisionId);
          if (!previous || previous.projectId !== input.projectId) throw notFound('이전 버전 산출물', input.previousRevisionId);
          // revision은 선형이다. 이미 다음 버전이 있는 산출물에서 갈라지는 새 버전은 만들 수 없다.
          const hasNext = db.deliverables.some((item) => item.projectId === input.projectId && item.previousRevisionId === input.previousRevisionId);
          if (hasNext) throw new Error('이미 다음 버전이 있는 산출물이에요. 가장 최신 버전을 이전 버전으로 지정해 주세요.');
        }
        const deliverable = { id: createId('dlv'), importedAt: nowIso(), ...input };
        db.deliverables.push(deliverable);
        record('deliverable_added', `${deliverable.title} 추가`, { projectId: input.projectId, metadata: { detail: input.type.toUpperCase() } });
        emit();
        return deliverable;
      },
    },

    requirements: {
      async listByProject(projectId) {
        return db.requirements.filter((item) => item.projectId === projectId);
      },
    },

    templates: {
      async get(id) {
        return db.templates.find((template) => template.id === id);
      },
      async saveForProject(projectId, template) {
        const saved = { id: createId('tpl'), projectId, ...template };
        db.templates.push(saved);
        const project = db.projects.find((item) => item.id === projectId);
        if (project) project.tcTemplateId = saved.id;
        record('project_changed', `${saved.name} 저장`, { projectId, metadata: { detail: 'TC Template' } });
        emit();
        return saved;
      },
    },

    changeAnalyses: {
      async listByProject(projectId) {
        return db.changeAnalyses.filter((item) => item.projectId === projectId).sort(byNewest((item) => item.createdAt));
      },
    },

    testConditions: {
      async listByProject(projectId) {
        return db.testConditions.filter((item) => item.projectId === projectId);
      },
    },

    testCases: {
      async listByProject(projectId) {
        return db.testCases.filter((item) => item.projectId === projectId);
      },
      async updateStatus(id, status) {
        const testCase = db.testCases.find((item) => item.id === id);
        if (!testCase) throw notFound('TC', id);
        testCase.status = status;
        testCase.updatedAt = nowIso();
        record('test_case_changed', `${testCase.externalId ?? testCase.id} 상태 변경`, {
          projectId: testCase.projectId,
          metadata: { detail: status === 'draft' ? '초안으로 되돌림' : testCaseStatusLabel[status] },
        });
        emit();
        return testCase;
      },
    },

    testResults: {
      async listImports(projectId) {
        return db.resultImports.filter((item) => item.projectId === projectId).sort((a, b) => a.round - b.round);
      },
      async listResults(importId) {
        return db.results.filter((item) => item.importId === importId);
      },
    },

    issues: {
      async listByProject(projectId) {
        return db.issues.filter((item) => item.projectId === projectId).sort(byNewest((item) => item.createdAt));
      },
      async create(input) {
        const issue = {
          id: createId('issue'),
          status: input.type === 'defect' ? ('open' as const) : ('waiting' as const),
          createdAt: nowIso(),
          ...input,
        };
        db.issues.push(issue);
        record('issue_created', `${input.type === 'defect' ? '이슈' : '확인사항'} 등록: ${issue.title}`, {
          projectId: input.projectId,
          metadata: { detail: input.feature ?? '' },
        });
        emit();
        return issue;
      },
      async updateStatus(id, status) {
        const issue = db.issues.find((item) => item.id === id);
        if (!issue) throw notFound('이슈', id);
        issue.status = status;
        emit();
        return issue;
      },
    },

    knowledge: {
      async list() {
        return [...db.knowledge];
      },
      async get(id) {
        return db.knowledge.find((term) => term.id === id);
      },
      async create(input) {
        const term = {
          id: createId('term'),
          examples: [],
          relatedProjectIds: [],
          relatedTerms: [],
          tags: [],
          aiDraftUsed: false,
          updatedAt: nowIso(),
          ...input,
        };
        db.knowledge.push(term);
        record('knowledge_saved', `${term.term} 용어 추가`, { metadata: { detail: '업무 지식' } });
        emit();
        return term;
      },
      async update(id, input) {
        const term = db.knowledge.find((item) => item.id === id);
        if (!term) throw notFound('용어', id);
        Object.assign(term, input, { updatedAt: nowIso() });
        emit();
        return term;
      },
    },

    scratch: {
      async list() {
        return db.scratch.filter(isAlive).sort(byNewest((item) => item.createdAt));
      },
      async create(input) {
        const createdAt = nowIso();
        const item = {
          id: createId('scr'),
          createdAt,
          expiresAt: new Date(Date.now() + SCRATCH_LIFETIME_MS).toISOString(),
          ...input,
        };
        db.scratch.push(item);
        emit();
        return item;
      },
      async pin(id, target, targetId) {
        const item = db.scratch.find((scratchItem) => scratchItem.id === id);
        if (!item) throw notFound('임시 자료', id);
        item.pinnedAt = nowIso();
        item.expiresAt = undefined;
        item.linkedType = target;
        item.linkedId = targetId;
        const projectId = target === 'project' ? targetId : item.contextProjectId;
        record('scratch_pinned', `${item.title ?? '임시 자료'} 고정`, {
          projectId,
          taskId: target === 'task' ? targetId : undefined,
          metadata: { detail: `임시 작업공간 → ${{ task: '업무', project: '프로젝트', record: '기록', knowledge: '업무 지식' }[target]}` },
        });
        if (target === 'knowledge') {
          db.knowledge.push({
            id: createId('term'),
            term: item.title ?? '새 용어',
            explanation: item.type === 'text' || item.type === 'note' ? item.content : '',
            examples: [],
            relatedProjectIds: item.contextProjectId ? [item.contextProjectId] : [],
            relatedTerms: [],
            tags: ['임시함에서 저장'],
            userNote: item.type === 'text' || item.type === 'note' ? undefined : item.content,
            aiDraftUsed: false,
            updatedAt: nowIso(),
          });
        }
        emit();
        return item;
      },
      async remove(id) {
        db.scratch = db.scratch.filter((item) => item.id !== id);
        emit();
      },
    },

    activities: {
      async list(filter) {
        // 같은 시각이면 나중에 기록된 활동이 먼저 오도록 역순에서 안정 정렬한다.
        return [...db.activities]
          .reverse()
          .filter((activity) => !filter?.projectId || activity.projectId === filter.projectId)
          .sort(byNewest((activity) => activity.createdAt));
      },
    },

    calendar: {
      async connectionStatus() {
        return 'not_connected';
      },
      async listUpcoming(fromIso, limit) {
        return db.calendarEvents
          .filter((event) => new Date(event.endAt) >= new Date(fromIso))
          .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime())
          .slice(0, limit);
      },
    },
  };
}
