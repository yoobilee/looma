import type { Activity, ActivityType, ImportSourceArtifact, ScratchItem } from '@/domain/types';
import { executionTypeLabel, testCaseStatusLabel } from '@/domain/labels';
import {
  decisionConflictMessage,
  decisionConflicts,
  pendingDecisionCount,
  planChangeApplication,
  requirementChangeNeedsDecision,
  testImpactNeedsDecision,
} from '@/domain/changeImpact';
import { importSourceMimeType, toImportSourceSnapshot } from '@/domain/importSource';
import { analyzeTestAssetImport, planTestAssetImport, type ImportTable } from '@/domain/testAssetImport';
import { analyzeResultImport, planResultImport, resultImportSummaryText, summarizeResultImport, usesCyclePlatform } from '@/domain/testResultImport';
import type { ImportSourceFileInput, PersistenceController, PersistenceStatus, Repositories } from '../repositories/types';
import { PersistenceError, toPersistenceError } from '../persistenceError';
import { createSeed } from '../mock/seed';
import { CURRENT_SCHEMA_VERSION, isStoredAppState, type AppData, type StoredAppState } from './appData';
import { appDataMigrations, migrateAppData, type AppDataMigration } from './migrations';
import type { StateChannel } from './stateChannel';
import { createRandomId } from './ids';
import { createMemoryStateStore, type ArtifactBytesInput, type StateStore } from './stateStore';

const SCRATCH_LIFETIME_MS = 12 * 60 * 60 * 1000;

function nowIso(): string {
  return new Date().toISOString();
}

function byNewest<T>(pick: (item: T) => string) {
  return (a: T, b: T) => new Date(pick(b)).getTime() - new Date(pick(a)).getTime();
}

function notFound(kind: string, id: string): Error {
  return new Error(`${kind}을(를) 찾을 수 없어요. (${id})`);
}

/** 바꿀 것이 없는 변경의 결과. 저장하지 않고 value만 돌려준다. */
const UNCHANGED = Symbol('unchanged');
type Unchanged<T> = { [UNCHANGED]: T };
const unchanged = <T>(value: T): Unchanged<T> => ({ [UNCHANGED]: value });
const isUnchanged = <T>(value: T | Unchanged<T>): value is Unchanged<T> => typeof value === 'object' && value !== null && UNCHANGED in value;

interface MutationContext {
  /** 상태와 같은 transaction으로 저장할 원본 파일 bytes */
  addArtifact(artifact: ArtifactBytesInput): void;
}

/**
 * 저장소 경계의 복사. 내부 상태의 객체 · 배열을 밖으로 내보내지 않고, 받은 입력의 배열 · 객체를 내부 상태와 공유하지 않는다.
 * 읽기는 돌려주는 엔티티 범위만 복사한다(상태 전체를 복사하지 않는다).
 */
const copy = <T>(value: T): T => structuredClone(value);

/** 가져오기 입력. 원본 bytes(Blob)는 바뀌지 않는 값이라 그대로 두고 나머지만 복사한다. */
const copyImportInput = <T extends { source?: ImportSourceFileInput }>(input: T): T => {
  const { source, ...rest } = input;
  return { ...copy(rest), ...(source && { source: { ...source } }) } as T;
};

/** 저장 상태의 값이 같은가. 필드는 모두 원시값이고, 값이 undefined인 필드(error)는 없는 것과 같게 본다. */
const sameStatus = (a: PersistenceStatus, b: PersistenceStatus): boolean => {
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => Object.is(left[key], right[key]));
};

const emptyAppData = (): AppData => ({
  projects: [],
  tasks: [],
  deliverables: [],
  requirements: [],
  templates: [],
  testConditions: [],
  testCases: [],
  testAssetImports: [],
  importSourceArtifacts: [],
  changeAnalyses: [],
  resultImports: [],
  results: [],
  issues: [],
  knowledge: [],
  scratch: [],
  activities: [],
  calendarEvents: [],
});

export interface LocalRepositoryOptions {
  /** 저장소를 연다. 열 수 없으면 PersistenceError('unavailable')를 던진다. */
  openStore: () => Promise<StateStore>;
  channel?: StateChannel;
  /** 저장된 상태가 없을 때 쓸 처음 데이터. 기본은 지금 시각 기준 예시 데이터다. */
  createInitialData?: () => AppData;
  /** 엔티티 ID 생성기. 기본은 암호학적 난수 UUID다. 테스트에서 같은 ID를 강제로 만들 때만 바꾼다. */
  createId?: (prefix: string) => string;
  /** 저장 형식 버전과 이전 버전 변환. 기본은 현재 앱의 값이다. 테스트에서 변환 경로를 바꿔 볼 때 쓴다. */
  schema?: { currentVersion: number; migrations: Readonly<Record<number, AppDataMigration>> };
  /** 이미 읽어 둔 상태로 바로 시작한다(load 없이 ready). 메모리 저장소 · 테스트에서 쓴다. */
  preloaded?: { store: StateStore; state: StoredAppState & { data: AppData }; mode: 'local' | 'memory' };
}

/**
 * 앱 데이터 저장소. 상태 전체를 메모리에 두고 읽으며, 바꿀 때는 복사본에서 계산한 뒤 저장소에 먼저 저장하고
 * 저장에 성공했을 때만 메모리를 교체한다. 저장에 실패하면 메모리 · 저장소 모두 그대로다.
 * 상태 변경 시 Activity를 자동으로 남겨 "기록" 화면과 연결한다.
 */
export function createLocalRepositories(options: LocalRepositoryOptions): Repositories {
  const createInitialData = options.createInitialData ?? createSeed;
  const createId = options.createId ?? createRandomId;
  const schema = options.schema ?? { currentVersion: CURRENT_SCHEMA_VERSION, migrations: appDataMigrations };
  const { preloaded } = options;
  let db: AppData = preloaded ? structuredClone(preloaded.state.data) : emptyAppData();
  let store: StateStore | undefined = preloaded?.store;
  let revision = preloaded?.state.revision ?? 0;
  // 상태는 고정한 snapshot으로만 바꾼다. getStatus가 돌려준 객체를 밖에서 고쳐도 이 상태는 바뀌지 않는다.
  let status: PersistenceStatus = Object.freeze<PersistenceStatus>(
    preloaded ? { state: 'ready', mode: preloaded.mode, revision, savedAt: preloaded.state.savedAt, stale: false } : { state: 'loading' },
  );

  const listeners = new Set<() => void>();
  const statusListeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  /** 값이 실제로 바뀌었을 때만 새 snapshot으로 교체하고 알린다. 같으면 같은 객체를 그대로 둔다(불필요한 다시 그리기 방지). */
  const setStatus = (next: PersistenceStatus) => {
    if (sameStatus(status, next)) return;
    status = Object.freeze(next);
    statusListeners.forEach((listener) => listener());
  };
  const updateReady = (patch: Partial<Extract<PersistenceStatus, { state: 'ready' }>>) => {
    if (status.state === 'ready') setStatus({ ...status, ...patch });
  };

  options.channel?.subscribe((message) => {
    // 다른 탭이 더 새 데이터를 저장했다. 이 탭의 화면은 덮어쓰지 않고 다시 불러오라고 안내만 한다.
    if (status.state === 'ready' && message.revision > revision) updateReady({ stale: true });
  });

  /* ---------- 저장 ---------- */

  // 변경은 한 번에 하나씩 저장한다. 앞선 저장이 끝나기 전에 시작한 변경이 같은 revision으로 부딪히지 않게 한다.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  /**
   * 복사본에서 바꾸고, 저장에 성공하면 그 복사본을 현재 상태로 쓴다.
   * - change가 던지면(검증 실패 등) 아무것도 저장하지 않는다.
   * - change가 unchanged(value)를 돌려주면 바꿀 것이 없다는 뜻이다. 저장하지 않고 revision도 올리지 않는다.
   * - 판단은 저장 대기열 안에서, 앞선 변경이 모두 반영된 최신 상태로 한다.
   * - 돌려주는 값은 복사본이다. 호출한 쪽이 고쳐도 저장소 상태는 바뀌지 않는다.
   */
  const mutate = <T>(change: (draft: AppData, context: MutationContext) => T | Unchanged<T>): Promise<T> =>
    enqueue(async () => {
      if (status.state !== 'ready' || !store) throw new PersistenceError('unavailable', '저장소가 준비되지 않아 변경을 저장하지 않았어요.');
      if (status.stale) throw new PersistenceError('conflict');
      const draft = structuredClone(db);
      const artifacts: ArtifactBytesInput[] = [];
      const outcome = change(draft, { addArtifact: (artifact) => artifacts.push(artifact) });
      if (isUnchanged(outcome)) return copy(outcome[UNCHANGED]);
      try {
        const saved = await store.commit({ expectedRevision: revision, schemaVersion: schema.currentVersion, savedAt: nowIso(), data: draft, artifacts });
        db = draft;
        revision = saved.revision;
        updateReady({ revision, savedAt: saved.savedAt, error: undefined });
        options.channel?.post({ type: 'state-updated', revision: saved.revision, savedAt: saved.savedAt });
      } catch (error) {
        const failure = toPersistenceError(error, 'write_failed');
        updateReady(failure.kind === 'conflict' ? { stale: true, error: failure.message } : { error: failure.message });
        throw failure;
      }
      emit();
      return copy(outcome);
    });

  /**
   * 저장된 상태를 읽어 현재 버전으로 맞춘다. 이전 버전이면 변환해 현재 버전으로 한 번에 저장한다.
   * 읽거나 변환할 수 없으면 막힌 상태를 돌려주고, 저장된 데이터는 지우거나 덮어쓰지 않는다.
   */
  const readStoredState = async (opened: StateStore): Promise<{ data: AppData; revision: number; savedAt: string } | PersistenceStatus> => {
    let stored = await opened.read();
    if (stored === undefined) {
      const savedAt = nowIso();
      const first: StoredAppState = { schemaVersion: schema.currentVersion, revision: 1, savedAt, data: createInitialData() };
      stored = await opened.initialize(first);
    }
    if (!isStoredAppState(stored)) return { state: 'blocked', reason: 'corrupt', message: '저장된 Looma 데이터의 형식을 읽을 수 없어요.' };
    const migrated = migrateAppData(stored.schemaVersion, stored.data, schema);
    if (migrated.status === 'unsupported') {
      return { state: 'blocked', reason: 'unsupported_version', message: `저장된 데이터 형식(v${stored.schemaVersion})을 이 버전의 Looma가 읽을 수 없어요. 더 새 버전의 Looma에서 저장한 데이터일 수 있어요.` };
    }
    if (migrated.status === 'failed') return { state: 'blocked', reason: 'migration_failed', message: `저장된 데이터(v${stored.schemaVersion})를 현재 형식으로 바꾸지 못했어요.` };
    if (migrated.status === 'corrupt') return { state: 'blocked', reason: 'corrupt', message: '저장된 Looma 데이터의 형식을 읽을 수 없어요.' };
    if (migrated.status === 'migrated') {
      // 읽은 revision 그대로일 때만 저장한다. 저장에 실패하면 이전 버전 데이터가 그대로 남는다.
      try {
        const saved = await opened.commit({ expectedRevision: stored.revision, schemaVersion: schema.currentVersion, savedAt: nowIso(), data: migrated.data });
        return { data: migrated.data, ...saved };
      } catch {
        return { state: 'blocked', reason: 'migration_failed', message: `변환한 데이터(v${stored.schemaVersion} → v${schema.currentVersion})를 저장하지 못했어요. 저장된 데이터는 바꾸지 않았어요.` };
      }
    }
    return { data: migrated.data, revision: stored.revision, savedAt: stored.savedAt };
  };

  const loadFrom = async (opened: StateStore, mode: 'local' | 'memory') => {
    // 읽기에 실패해도 초기화는 할 수 있도록 저장소는 먼저 붙잡아 둔다.
    store = opened;
    const loaded = await readStoredState(opened);
    if ('state' in loaded) {
      setStatus(loaded);
      return;
    }
    db = loaded.data;
    revision = loaded.revision;
    setStatus({ state: 'ready', mode, revision, savedAt: loaded.savedAt, stale: false });
    emit();
  };

  const persistence: PersistenceController = {
    getStatus: () => status,
    subscribe(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    async load() {
      setStatus({ state: 'loading' });
      let opened: StateStore;
      try {
        opened = await options.openStore();
      } catch (error) {
        setStatus({ state: 'blocked', reason: 'unavailable', message: toPersistenceError(error, 'unavailable').message });
        return;
      }
      try {
        await loadFrom(opened, 'local');
      } catch (error) {
        setStatus({ state: 'blocked', reason: 'read_failed', message: toPersistenceError(error, 'read_failed').message });
      }
    },
    reloadLatest: () =>
      enqueue(async () => {
        if (!store) throw new PersistenceError('unavailable');
        const mode = status.state === 'ready' ? status.mode : 'local';
        try {
          await loadFrom(store, mode);
        } catch (error) {
          const failure = toPersistenceError(error, 'read_failed');
          updateReady({ error: failure.message });
          throw failure;
        }
      }),
    resetToSeed: () =>
      enqueue(async () => {
        if (!store) throw new PersistenceError('unavailable');
        // 지금 시각 기준의 새 예시 데이터. 저장에 실패하면 기존 상태 · 원본 파일을 그대로 둔다.
        const data = createInitialData();
        const mode = status.state === 'ready' ? status.mode : 'local';
        const saved = await store.replaceAll({ schemaVersion: schema.currentVersion, savedAt: nowIso(), data }).catch((error: unknown) => {
          throw toPersistenceError(error, 'write_failed');
        });
        db = data;
        revision = saved.revision;
        setStatus({ state: 'ready', mode, revision, savedAt: saved.savedAt, stale: false });
        options.channel?.post({ type: 'state-updated', revision: saved.revision, savedAt: saved.savedAt });
        emit();
      }),
    async continueWithoutSaving() {
      // 사용자가 직접 고른 경우에만 쓰는 저장하지 않는 모드. 화면에 계속 표시해 저장된다고 착각하지 않게 한다.
      await loadFrom(createMemoryStateStore(), 'memory');
    },
    dismissError() {
      updateReady({ error: undefined });
    },
  };

  /* ---------- 저장소별 구현 ---------- */

  const record = (draft: AppData, type: ActivityType, title: string, extra: Partial<Activity> = {}) => {
    draft.activities.push({
      id: createId('act'),
      type,
      title,
      metadata: {},
      createdAt: nowIso(),
      ...extra,
    });
  };

  // 판단은 draft 분석에서만 바꿀 수 있다.
  const draftAnalysis = (draft: AppData, analysisId: string) => {
    const analysis = draft.changeAnalyses.find((item) => item.id === analysisId);
    if (!analysis) throw notFound('변경 영향 분석', analysisId);
    if (analysis.status !== 'draft') throw new Error('검토를 완료한 분석은 판단을 바꿀 수 없어요.');
    return analysis;
  };

  const isAlive = (item: ScratchItem) => !!item.pinnedAt || !item.expiresAt || new Date(item.expiresAt) > new Date();

  /**
   * 원본 파일을 가져오기 기록에 붙인다. 메타데이터는 상태에, bytes는 같은 transaction의 원본 파일 저장소에 들어간다.
   * 원본 · snapshot · 열 매핑은 함께 저장되거나 함께 저장되지 않는다.
   */
  const attachSource = (draft: AppData, context: MutationContext, projectId: string, fileName: string, table: ImportTable, source: ImportSourceFileInput) => {
    const artifact: ImportSourceArtifact = {
      id: createId('src'),
      projectId,
      fileName,
      format: source.format,
      mimeType: source.bytes.type || importSourceMimeType[source.format],
      size: source.bytes.size,
      ...(source.sheetName && { selectedSheetName: source.sheetName }),
      createdAt: nowIso(),
    };
    draft.importSourceArtifacts.push(artifact);
    context.addArtifact({ id: artifact.id, bytes: source.bytes });
    return {
      artifact,
      snapshot: toImportSourceSnapshot(table, { format: source.format, fileName, sheetName: source.sheetName }),
    };
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    persistence,

    tasks: {
      async list() {
        return copy(db.tasks);
      },
      async get(id) {
        return copy(db.tasks.find((task) => task.id === id));
      },
      create: (rawInput) => {
        const input = copy(rawInput);
        return mutate((draft) => {
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
          draft.tasks.push(task);
          record(draft, 'task_created', `${task.title} 업무 생성`, { taskId: task.id, projectId: task.projectId, metadata: { detail: '업무 생성' } });
          return task;
        });
      },
      updateStatus: (id, status) =>
        // 존재 확인과 "이미 같은 상태" 판단도 대기열 안에서 최신 상태로 한다. 앞선 변경이 끝나기 전의 값으로 판단하지 않는다.
        mutate((draft) => {
          const task = draft.tasks.find((item) => item.id === id);
          if (!task) throw notFound('업무', id);
          if (task.status === status) return unchanged(task);
          task.status = status;
          if (status === 'in_progress') {
            task.startedAt = nowIso();
            record(draft, 'task_started', `${task.title} 시작`, { taskId: id, projectId: task.projectId, metadata: { detail: '업무 시작' } });
          }
          if (status === 'done') {
            task.completedAt = nowIso();
            record(draft, 'task_completed', `${task.title} 완료`, { taskId: id, projectId: task.projectId, metadata: { detail: '업무 완료' } });
          } else {
            task.completedAt = undefined;
          }
          return task;
        }),
    },

    projects: {
      async list() {
        return copy(db.projects);
      },
      async get(id) {
        return copy(db.projects.find((project) => project.id === id));
      },
      create: (rawInput) => {
        const input = copy(rawInput);
        return mutate((draft) => {
          const project = {
            id: createId('proj'),
            status: 'preparing' as const,
            currentStage: 'deliverables' as const,
            ...input,
          };
          draft.projects.push(project);
          record(draft, 'project_changed', `${project.name} 프로젝트 생성`, { projectId: project.id, metadata: { detail: '프로젝트 생성' } });
          return project;
        });
      },
    },

    deliverables: {
      async listByProject(projectId) {
        return copy(db.deliverables.filter((item) => item.projectId === projectId).sort(byNewest((item) => item.importedAt)));
      },
      create: (rawInput) => {
        const input = copy(rawInput);
        return mutate((draft) => {
          if (input.previousRevisionId) {
            const previous = draft.deliverables.find((item) => item.id === input.previousRevisionId);
            if (!previous || previous.projectId !== input.projectId) throw notFound('이전 버전 산출물', input.previousRevisionId);
            // revision은 선형이다. 이미 다음 버전이 있는 산출물에서 갈라지는 새 버전은 만들 수 없다.
            const hasNext = draft.deliverables.some((item) => item.projectId === input.projectId && item.previousRevisionId === input.previousRevisionId);
            if (hasNext) throw new Error('이미 다음 버전이 있는 산출물이에요. 가장 최신 버전을 이전 버전으로 지정해 주세요.');
          }
          const deliverable = { id: createId('dlv'), importedAt: nowIso(), ...input };
          draft.deliverables.push(deliverable);
          record(draft, 'deliverable_added', `${deliverable.title} 추가`, { projectId: input.projectId, metadata: { detail: input.type.toUpperCase() } });
          return deliverable;
        });
      },
    },

    requirements: {
      async listByProject(projectId) {
        return copy(db.requirements.filter((item) => item.projectId === projectId));
      },
    },

    templates: {
      async get(id) {
        return copy(db.templates.find((template) => template.id === id));
      },
      saveForProject: (projectId, rawTemplate) => {
        const template = copy(rawTemplate);
        return mutate((draft) => {
          const saved = { id: createId('tpl'), projectId, ...template };
          draft.templates.push(saved);
          const project = draft.projects.find((item) => item.id === projectId);
          if (project) project.tcTemplateId = saved.id;
          record(draft, 'project_changed', `${saved.name} 저장`, { projectId, metadata: { detail: 'TC Template' } });
          return saved;
        });
      },
    },

    changeAnalyses: {
      async listByProject(projectId) {
        return copy(db.changeAnalyses.filter((item) => item.projectId === projectId).sort(byNewest((item) => item.createdAt)));
      },
      updateRequirementDecision: (analysisId, changeId, decision) =>
        mutate((draft) => {
          const analysis = draftAnalysis(draft, analysisId);
          const change = analysis.requirementChanges.find((item) => item.id === changeId);
          if (!change) throw notFound('요구사항 변경', changeId);
          if (!requirementChangeNeedsDecision(change)) throw new Error('유지 항목은 판단하지 않아요.');
          change.decision = decision;
          return analysis;
        }),
      updateTestImpactDecision: (analysisId, impactId, decision) =>
        mutate((draft) => {
          const analysis = draftAnalysis(draft, analysisId);
          const impact = analysis.testImpacts.find((item) => item.id === impactId);
          if (!impact) throw notFound('TC 영향', impactId);
          if (!testImpactNeedsDecision(impact)) throw new Error('유지·중복 후보 항목은 수락/제외로 판단하지 않아요.');
          impact.decision = decision;
          return analysis;
        }),
      resolveDuplicate: (analysisId, impactId, resolution) =>
        mutate((draft) => {
          const analysis = draftAnalysis(draft, analysisId);
          const impact = analysis.testImpacts.find((item) => item.id === impactId);
          if (!impact) throw notFound('TC 영향', impactId);
          if (impact.kind !== 'duplicate_candidate') throw new Error('중복 후보 항목만 처리 방법을 고를 수 있어요.');
          impact.duplicateResolution = resolution;
          return analysis;
        }),
      markReviewed: (analysisId) =>
        mutate((draft) => {
          const analysis = draftAnalysis(draft, analysisId);
          const pending = pendingDecisionCount(analysis);
          if (pending > 0) throw new Error(`판단하지 않은 항목이 ${pending}건 있어요.`);
          const conflicts = decisionConflicts(analysis);
          if (conflicts.length > 0) throw new Error(decisionConflictMessage(conflicts.length));
          analysis.status = 'reviewed';
          analysis.reviewedAt = nowIso();
          return analysis;
        }),
      apply: (analysisId) =>
        mutate((draft) => {
          const analysis = draft.changeAnalyses.find((item) => item.id === analysisId);
          if (!analysis) throw notFound('변경 영향 분석', analysisId);
          const now = nowIso();
          // 먼저 전부 계산하고 검증한다. 여기서 실패하면 아무것도 저장하지 않는다.
          const plan = planChangeApplication(analysis, draft, {
            now,
            createId,
            templateId: draft.projects.find((item) => item.id === analysis.projectId)?.tcTemplateId,
          });
          draft.requirements = plan.requirements;
          draft.testCases = plan.testCases;
          analysis.status = 'applied';
          analysis.appliedAt = now;
          analysis.appliedSummary = plan.summary;
          const target = draft.deliverables.find((item) => item.id === analysis.targetDeliverableId);
          const { summary } = plan;
          record(draft, 'changes_applied', `${target?.title ?? '산출물'} 변경사항 반영`, {
            projectId: analysis.projectId,
            metadata: {
              detail: `요구사항 ${summary.requirementsAdded + summary.requirementsModified + summary.requirementsRemoved} · TC ${summary.testCasesCreated + summary.testCasesModified + summary.testCasesDeprecated}`,
            },
          });
          return analysis;
        }),
    },

    testConditions: {
      async listByProject(projectId) {
        return copy(db.testConditions.filter((item) => item.projectId === projectId));
      },
    },

    testCases: {
      async listByProject(projectId) {
        return copy(db.testCases.filter((item) => item.projectId === projectId));
      },
      updateStatus: (id, status) =>
        mutate((draft) => {
          const testCase = draft.testCases.find((item) => item.id === id);
          if (!testCase) throw notFound('TC', id);
          testCase.status = status;
          testCase.updatedAt = nowIso();
          record(draft, 'test_case_changed', `${testCase.externalId ?? testCase.id} 상태 변경`, {
            projectId: testCase.projectId,
            metadata: { detail: status === 'draft' ? '초안으로 되돌림' : testCaseStatusLabel[status] },
          });
          return testCase;
        }),
    },

    testAssetImports: {
      async listByProject(projectId) {
        return copy(db.testAssetImports.filter((item) => item.projectId === projectId).sort(byNewest((item) => item.importedAt)));
      },
      apply: (rawInput) => {
        const input = copyImportInput(rawInput);
        return mutate((draft, context) => {
          const project = draft.projects.find((item) => item.id === input.projectId);
          if (!project) throw notFound('프로젝트', input.projectId);
          // 미리보기와 같은 규칙으로 현재 TC 기준 판정을 다시 계산한다. 그 사이 TC가 바뀌었으면 계획 단계에서 거부된다.
          const analysis = analyzeTestAssetImport(
            input.table,
            input.mapping,
            draft.testCases.filter((item) => item.projectId === input.projectId),
          );
          // 먼저 전부 계산하고 검증한다. 여기서 실패하면 아무것도 저장하지 않는다.
          const plan = planTestAssetImport(analysis, input.decisions, draft.testCases, {
            projectId: input.projectId,
            fileName: input.fileName,
            now: nowIso(),
            createId,
            templateId: project.tcTemplateId,
          });
          const attached = input.source && attachSource(draft, context, input.projectId, input.fileName, input.table, input.source);
          const session = attached
            ? { ...plan.session, artifactId: attached.artifact.id, sourceSnapshot: attached.snapshot, columnMapping: [...input.mapping] }
            : plan.session;
          draft.testCases = plan.testCases;
          draft.testAssetImports.push(session);
          record(draft, 'test_assets_imported', `TC 자산 ${session.created + session.updated}건 가져오기`, {
            projectId: input.projectId,
            metadata: { detail: `${session.fileName} · 신규 ${session.created} · 업데이트 ${session.updated} · 변경 없음 ${session.unchanged} · 제외 ${session.excluded}` },
          });
          return session;
        });
      },
    },

    testResults: {
      async listImports(projectId) {
        return copy(db.resultImports.filter((item) => item.projectId === projectId).sort((a, b) => a.round - b.round));
      },
      async listResults(importId) {
        return copy(db.results.filter((item) => item.importId === importId));
      },
      importResults: (rawInput) => {
        const input = copyImportInput(rawInput);
        return mutate((draft, context) => {
          const project = draft.projects.find((item) => item.id === input.projectId);
          if (!project) throw notFound('프로젝트', input.projectId);
          const templateMappings = draft.templates.find((item) => item.id === project.tcTemplateId)?.resultMappings ?? [];
          const testCases = draft.testCases.filter((item) => item.projectId === input.projectId);
          // 미리보기와 같은 규칙으로 현재 TC · 템플릿 기준 판정을 다시 계산한다. 그 사이 바뀌었으면 계획 단계에서 거부된다.
          const analysis = analyzeResultImport(input.table, input.mapping, testCases, templateMappings);
          // 먼저 전부 계산하고 검증한다. 여기서 실패하면 아무것도 저장하지 않는다. 기준 TC는 읽기만 한다.
          const plan = planResultImport(
            analysis,
            input.rowDecisions,
            input.valueDecisions,
            input.cycle,
            {
              testCases,
              existingImports: draft.resultImports.filter((item) => item.projectId === input.projectId),
              cyclePlatformAllowed: usesCyclePlatform(input.mapping),
            },
            { projectId: input.projectId, fileName: input.fileName, now: nowIso(), createId },
          );
          const attached = input.source && attachSource(draft, context, input.projectId, input.fileName, input.table, input.source);
          const resultImport = attached
            ? { ...plan.resultImport, artifactId: attached.artifact.id, sourceSnapshot: attached.snapshot, resultColumnMapping: [...input.mapping] }
            : plan.resultImport;
          draft.resultImports.push(resultImport);
          draft.results.push(...plan.results);
          const { round, executionType } = resultImport;
          record(draft, 'results_uploaded', `${round}차 ${executionTypeLabel[executionType ?? 'full']} 결과 가져오기`, {
            projectId: input.projectId,
            metadata: { detail: resultImportSummaryText(summarizeResultImport(plan.results)) },
          });
          return resultImport;
        });
      },
    },

    importSources: {
      async get(id) {
        return copy(db.importSourceArtifacts.find((item) => item.id === id));
      },
      async getBytes(id) {
        const artifact = db.importSourceArtifacts.find((item) => item.id === id);
        if (!artifact) return undefined;
        if (!store) throw new PersistenceError('unavailable');
        const blob = await store.readArtifactBytes(id).catch((error: unknown) => {
          throw toPersistenceError(error, 'read_failed');
        });
        // 기록은 있는데 파일이 없거나 크기가 다르면 조용히 넘기지 않는다.
        if (!blob) throw new PersistenceError('artifact_missing');
        if (blob.size !== artifact.size) throw new PersistenceError('artifact_corrupt');
        return new Uint8Array(await blob.arrayBuffer());
      },
    },

    issues: {
      async listByProject(projectId) {
        return copy(db.issues.filter((item) => item.projectId === projectId).sort(byNewest((item) => item.createdAt)));
      },
      create: (rawInput) => {
        const input = copy(rawInput);
        return mutate((draft) => {
          const issue = {
            id: createId('issue'),
            status: input.type === 'defect' ? ('open' as const) : ('waiting' as const),
            createdAt: nowIso(),
            ...input,
          };
          draft.issues.push(issue);
          record(draft, 'issue_created', `${input.type === 'defect' ? '이슈' : '확인사항'} 등록: ${issue.title}`, {
            projectId: input.projectId,
            metadata: { detail: input.feature ?? '' },
          });
          return issue;
        });
      },
      updateStatus: (id, status) =>
        mutate((draft) => {
          const issue = draft.issues.find((item) => item.id === id);
          if (!issue) throw notFound('이슈', id);
          issue.status = status;
          return issue;
        }),
    },

    knowledge: {
      async list() {
        return copy(db.knowledge);
      },
      async get(id) {
        return copy(db.knowledge.find((term) => term.id === id));
      },
      create: (rawInput) => {
        const input = copy(rawInput);
        return mutate((draft) => {
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
          draft.knowledge.push(term);
          record(draft, 'knowledge_saved', `${term.term} 용어 추가`, { metadata: { detail: '업무 지식' } });
          return term;
        });
      },
      update: (id, rawInput) => {
        const input = copy(rawInput);
        return mutate((draft) => {
          const term = draft.knowledge.find((item) => item.id === id);
          if (!term) throw notFound('용어', id);
          Object.assign(term, input, { updatedAt: nowIso() });
          return term;
        });
      },
    },

    scratch: {
      async list() {
        return copy(db.scratch.filter(isAlive).sort(byNewest((item) => item.createdAt)));
      },
      create: (rawInput) => {
        const input = copy(rawInput);
        return mutate((draft) => {
          const createdAt = nowIso();
          const item = {
            id: createId('scr'),
            createdAt,
            expiresAt: new Date(Date.now() + SCRATCH_LIFETIME_MS).toISOString(),
            ...input,
          };
          draft.scratch.push(item);
          return item;
        });
      },
      pin: (id, target, targetId) =>
        mutate((draft) => {
          const item = draft.scratch.find((scratchItem) => scratchItem.id === id);
          if (!item) throw notFound('임시 자료', id);
          item.pinnedAt = nowIso();
          item.expiresAt = undefined;
          item.linkedType = target;
          item.linkedId = targetId;
          const projectId = target === 'project' ? targetId : item.contextProjectId;
          record(draft, 'scratch_pinned', `${item.title ?? '임시 자료'} 고정`, {
            projectId,
            taskId: target === 'task' ? targetId : undefined,
            metadata: { detail: `임시 작업공간 → ${{ task: '업무', project: '프로젝트', record: '기록', knowledge: '업무 지식' }[target]}` },
          });
          if (target === 'knowledge') {
            draft.knowledge.push({
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
          return item;
        }),
      remove: (id) =>
        mutate((draft) => {
          draft.scratch = draft.scratch.filter((item) => item.id !== id);
        }),
    },

    activities: {
      async list(filter) {
        // 같은 시각이면 나중에 기록된 활동이 먼저 오도록 역순에서 안정 정렬한다.
        return copy(
          [...db.activities]
            .reverse()
            .filter((activity) => !filter?.projectId || activity.projectId === filter.projectId)
            .sort(byNewest((activity) => activity.createdAt)),
        );
      },
    },

    calendar: {
      async connectionStatus() {
        return 'not_connected';
      },
      async listUpcoming(fromIso, limit) {
        return copy(
          db.calendarEvents
            .filter((event) => new Date(event.endAt) >= new Date(fromIso))
            .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime())
            .slice(0, limit),
        );
      },
    },
  };
}
