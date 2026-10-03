import { describe, expect, it } from 'vitest';
import type { Activity, ActivityType } from '@/domain/types';
import { scratchTypeLabel, taskStatusLabel } from '@/domain/labels';
import { createSeed, PROJECT_A, PROJECT_B } from '@/data/mock/seed';
import { searchAll, type SearchSources } from './searchIndex';

const labels = { taskStatusLabel, scratchTypeLabel };

const activity = (id: string, type: ActivityType, overrides: Partial<Activity> = {}): Activity => ({
  id,
  type,
  projectId: PROJECT_A,
  title: id,
  metadata: {},
  createdAt: '2026-10-01T09:00:00.000Z',
  ...overrides,
});

/** 예시 데이터의 프로젝트 · 업무 등은 그대로 두고 활동만 바꾼 검색 대상 */
function sourcesWith(activities: Activity[]): SearchSources {
  const seed = createSeed();
  return { tasks: seed.tasks, projects: seed.projects, testCases: seed.testCases, terms: seed.knowledge, scratch: seed.scratch, activities };
}

const recordGroup = (activities: Activity[], query: string) => searchAll(sourcesWith(activities), query, labels).find((group) => group.label === '기록');
const projectName = (id: string) => createSeed().projects.find((project) => project.id === id)!.name;

describe('전역 검색: 기록 검색 대상', () => {
  const issue = activity('act-issue', 'issue_created', { title: '이슈 등록: 로그인 잠금 미동작', metadata: { detail: '2차 FAIL', issueId: 'issue-bug-015' } });

  it('제목 · 요약(detail) · 프로젝트명으로 찾고, 대소문자와 앞뒤 공백을 가리지 않는다', () => {
    expect(recordGroup([issue], '잠금 미동작')?.items.map((item) => item.id)).toEqual(['act-issue']);
    expect(recordGroup([issue], '2차 fail')?.items.map((item) => item.id)).toEqual(['act-issue']);
    expect(recordGroup([issue], projectName(PROJECT_A).toLowerCase())?.items.map((item) => item.id)).toEqual(['act-issue']);
    expect(recordGroup([activity('a', 'deliverable_added', { title: 'Plan.PDF 추가' })], '  plan.pdf  ')?.items).toHaveLength(1);
    expect(recordGroup([issue], '맞는 게 없는 말')).toBeUndefined();
  });

  it('metadata의 내부 ID(issueId · resultImportId · testCaseId · analysisId 등)로는 찾지 않는다', () => {
    const withIds = activity('act-ids', 'changes_applied', {
      title: '기획서 변경사항 반영',
      metadata: { detail: '요구사항 1 · TC 2', analysisId: 'cia-plan-v15', issueId: 'issue-zzz', resultImportId: 'imp-zzz', testCaseId: 'tc-zzz', deliverableId: 'dlv-zzz', testAssetImportId: 'tai-zzz' },
    });
    for (const id of ['cia-plan-v15', 'issue-zzz', 'imp-zzz', 'tc-zzz', 'dlv-zzz', 'tai-zzz']) expect(recordGroup([withIds], id)).toBeUndefined();
    // 같은 활동도 읽을 수 있는 내용으로는 찾는다.
    expect(recordGroup([withIds], '변경사항 반영')?.items).toHaveLength(1);
  });

  it('제목 · meta: 프로젝트명 · 요약, 개인은 "개인", 요약이 없으면 프로젝트명만', () => {
    const personal = activity('act-personal', 'task_completed', { projectId: undefined, title: '접근 권한 요청 완료', metadata: { detail: '온보딩 업무' } });
    const noDetail = activity('act-nodetail', 'project_changed', { title: '프로젝트 생성' });
    const all = [personal, noDetail, issue];
    const metaOf = (query: string) => recordGroup(all, query)!.items[0];
    expect(metaOf('접근 권한')).toMatchObject({ title: '접근 권한 요청 완료', meta: '개인 · 온보딩 업무' });
    expect(metaOf('프로젝트 생성')).toMatchObject({ title: '프로젝트 생성', meta: projectName(PROJECT_A) });
    expect(metaOf('잠금')).toMatchObject({ meta: `${projectName(PROJECT_A)} · 2차 FAIL` });
  });

  it('최대 5건이고 입력 순서(저장소의 최신순)를 그대로 유지한다. 기존 그룹은 그대로다', () => {
    const many = Array.from({ length: 8 }, (_, index) => activity(`act-${index}`, 'deliverable_added', { title: `산출물 ${index} 추가` }));
    expect(recordGroup(many, '산출물')!.items.map((item) => item.id)).toEqual(['act-0', 'act-1', 'act-2', 'act-3', 'act-4']);
    // 기록이 없는 검색어에는 기록 그룹이 없고, 기존 그룹은 그대로 나온다.
    const groups = searchAll(sourcesWith(many), '로그인', labels).map((group) => group.label);
    expect(groups).toContain('TC');
    expect(groups).not.toContain('기록');
    const empty = searchAll({ ...sourcesWith(many), activities: [] }, '로그인', labels);
    expect(empty.map((group) => group.label)).toEqual(groups);
  });
});

describe('전역 검색: 기록 결과의 이동 위치', () => {
  const toOf = (item: Activity) => recordGroup([item], item.title)!.items[0].to;
  const base = `/projects/${PROJECT_A}`;

  it.each([
    ['issue_created', { issueId: 'issue-a' }, `${base}/issues?issue=issue-a`],
    ['issue_updated', { issueId: 'issue-a' }, `${base}/issues?issue=issue-a`],
    ['issue_resolved', { issueId: 'issue-a' }, `${base}/issues?issue=issue-a`],
    ['results_uploaded', { resultImportId: 'imp-a' }, `${base}/results?import=imp-a`],
    ['test_case_changed', { testCaseId: 'tc-a' }, `${base}/test-design?tc=tc-a`],
    ['test_assets_imported', { testAssetImportId: 'tai-a' }, `${base}/import-history?assetImport=tai-a`],
    ['deliverable_added', { deliverableId: 'dlv-a' }, `${base}?deliverable=dlv-a`],
    ['requirements_imported', { deliverableId: 'dlv-a' }, `${base}/requirements`],
    ['requirements_analyzed', { analysisId: 'cia-a' }, `${base}/test-design`],
    ['changes_applied', { analysisId: 'cia-a' }, `${base}/test-design`],
  ] as [ActivityType, Record<string, string>, string][])('%s는 기존 원본 링크 정책을 따른다 → %s', (type, metadata, to) => {
    expect(toOf(activity('고유제목', type, { title: '고유제목', metadata }))).toBe(to);
  });

  it('활동 자신의 프로젝트 기준이다(다른 프로젝트 활동은 그 프로젝트로)', () => {
    expect(toOf(activity('고유제목', 'issue_created', { title: '고유제목', projectId: PROJECT_B, metadata: { issueId: 'issue-b' } }))).toBe(`/projects/${PROJECT_B}/issues?issue=issue-b`);
  });

  it('원본 링크가 없으면 프로젝트 기록으로 간다: 링크 없는 종류 · 옛 기록(ID 없음) · 종류에 맞지 않는 key', () => {
    const records = `${base}/records`;
    expect(toOf(activity('고유제목', 'project_changed', { title: '고유제목', metadata: { detail: 'TC Template' } }))).toBe(records);
    expect(toOf(activity('고유제목', 'requirements_analyzed', { title: '고유제목', metadata: { detail: '기능 3 · 확인 필요 4' } }))).toBe(records);
    expect(toOf(activity('고유제목', 'results_uploaded', { title: '고유제목', metadata: {} }))).toBe(records);
    expect(toOf(activity('고유제목', 'requirements_analyzed', { title: '고유제목', metadata: { issueId: 'x', testCaseId: 'y', deliverableId: 'z' } }))).toBe(records);
    expect(toOf(activity('고유제목', 'test_case_changed', { title: '고유제목', metadata: { analysisId: 'x' } }))).toBe(records);
    expect(toOf(activity('고유제목', 'issue_created', { title: '고유제목', metadata: { resultImportId: 'x' } }))).toBe(records);
  });

  it('프로젝트가 없는 개인 활동은 전역 기록으로 간다(ID가 있어도 링크하지 않는다)', () => {
    expect(toOf(activity('고유제목', 'task_completed', { title: '고유제목', projectId: undefined }))).toBe('/records');
    expect(toOf(activity('고유제목', 'issue_created', { title: '고유제목', projectId: undefined, metadata: { issueId: 'issue-a' } }))).toBe('/records');
  });

  it('변경 분석 기록은 meta에 현재 테스트 설계로 이동한다고 밝히고, 바로 가는 다른 기록 · 기록 fallback에는 붙이지 않는다', () => {
    const metaOf = (item: Activity) => recordGroup([item], item.title)!.items[0].meta;
    expect(metaOf(activity('고유제목', 'changes_applied', { title: '고유제목', metadata: { detail: '요구사항 1 · TC 2', analysisId: 'cia-a' } }))).toBe(`${projectName(PROJECT_A)} · 요구사항 1 · TC 2 · 테스트 설계로 이동`);
    expect(metaOf(activity('고유제목', 'requirements_analyzed', { title: '고유제목', metadata: { detail: '요구사항 변경 3건 · TC 영향 6건', analysisId: 'cia-a' } }))).toBe(
      `${projectName(PROJECT_A)} · 요구사항 변경 3건 · TC 영향 6건 · 테스트 설계로 이동`,
    );
    // 옛 기록은 기록 화면으로 가므로 테스트 설계라고 쓰지 않는다.
    expect(metaOf(activity('고유제목', 'requirements_analyzed', { title: '고유제목', metadata: { detail: '기능 3 · 확인 필요 4' } }))).toBe(`${projectName(PROJECT_A)} · 기능 3 · 확인 필요 4`);
    expect(metaOf(activity('고유제목', 'issue_created', { title: '고유제목', metadata: { detail: '결함', issueId: 'issue-a' } }))).toBe(`${projectName(PROJECT_A)} · 결함`);
    // 요구사항 가져오기는 요구사항 탭에서 가져온 요구사항을 모두 보여주므로 이동 문구를 붙이지 않는다.
    expect(metaOf(activity('고유제목', 'requirements_imported', { title: '고유제목', metadata: { detail: '신규 2 · 중복 1 · 오류 0 · 제외 0', deliverableId: 'dlv-a' } }))).toBe(`${projectName(PROJECT_A)} · 신규 2 · 중복 1 · 오류 0 · 제외 0`);
  });
});
