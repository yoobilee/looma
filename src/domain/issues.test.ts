import { describe, expect, it } from 'vitest';
import { applyIssueChanges, buildIssue, laterResultsFor } from './issues';
import type { Issue, TestResult, TestResultImport } from './types';

const NOW = '2026-10-02T09:00:00.000Z';
const LATER = '2026-10-02T10:00:00.000Z';
const LATEST = '2026-10-02T11:00:00.000Z';

const result = (overrides: Partial<TestResult> = {}): TestResult => ({
  id: 'res-1',
  importId: 'imp-2',
  testCaseId: 'tc-101',
  externalId: 'TC-101',
  feature: '로그인',
  title: '로그인 성공',
  platform: 'android',
  result: 'fail',
  ...overrides,
});

const round = (id: string, number: number, projectId = 'p'): TestResultImport => ({ id, projectId, round: number, fileRef: `${number}차.xlsx`, importedAt: NOW, mapping: [] });

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

const created = (overrides: Partial<Issue> = {}): Issue => ({ ...buildIssue({ projectId: 'p', type: 'defect', title: '이슈' }, {}, { id: 'issue-1', now: NOW }), ...overrides });

describe('이슈 · 확인사항 만들기', () => {
  it('이슈를 확인 필요 상태로 만들고, 빈 입력은 저장하지 않는다', () => {
    const issue = buildIssue({ projectId: 'p', type: 'defect', title: '  로그인 실패  ', description: ' ', note: '메모 ' }, {}, { id: 'issue-1', now: NOW });
    expect(issue).toEqual({ id: 'issue-1', projectId: 'p', type: 'defect', title: '로그인 실패', status: 'open', note: '메모', createdAt: NOW, updatedAt: NOW });
    expect(issue).not.toHaveProperty('resolvedAt');
    expect(issue).not.toHaveProperty('description');
  });

  it('확인사항을 수행 결과 없이 만들 수 있다(TC 연결은 선택)', () => {
    expect(buildIssue({ projectId: 'p', type: 'question', title: '정책 확인' }, {}, { id: 'q-1', now: NOW })).toMatchObject({ type: 'question', status: 'open' });
    const withTestCase = buildIssue({ projectId: 'p', type: 'question', title: '정책 확인', testCaseId: 'tc-101' }, {}, { id: 'q-2', now: NOW });
    expect(withTestCase).toMatchObject({ testCaseId: 'tc-101' });
    expect(withTestCase).not.toHaveProperty('resultId');
  });

  it.each(['fail', 'blocked'] as const)('%s 결과에서 만들면 resultId와 결과의 testCaseId를 연결하고, 결과 상태 · 차수 · 플랫폼은 복사하지 않는다', (value) => {
    const source = result({ result: value });
    const issue = buildIssue({ projectId: 'p', type: value === 'fail' ? 'defect' : 'question', title: '결과에서', resultId: source.id }, { result: source }, { id: 'issue-1', now: NOW });
    expect(issue).toMatchObject({ resultId: 'res-1', testCaseId: 'tc-101' });
    for (const copied of ['result', 'platform', 'importId', 'round', 'externalId']) expect(issue).not.toHaveProperty(copied);
  });

  it('결과 연결은 내부 ID로만 한다: 고객사 TC ID가 무엇이든(바뀌어도) 결과의 testCaseId를 쓴다', () => {
    const renamed = result({ externalId: 'NEW-ID' });
    expect(buildIssue({ projectId: 'p', type: 'defect', title: 'x', resultId: renamed.id }, { result: renamed }, { id: 'i', now: NOW })).toMatchObject({ testCaseId: 'tc-101' });
    const unlinked = result({ testCaseId: undefined });
    expect(buildIssue({ projectId: 'p', type: 'defect', title: 'x', resultId: unlinked.id }, { result: unlinked }, { id: 'i', now: NOW })).not.toHaveProperty('testCaseId');
  });

  it('결과와 다른 TC · 찾지 못한 결과 · 빈 제목은 거부한다', () => {
    const source = result();
    expect(() => buildIssue({ projectId: 'p', type: 'defect', title: 'x', resultId: source.id, testCaseId: 'tc-other' }, { result: source }, { id: 'i', now: NOW })).toThrow('다른 TC');
    expect(() => buildIssue({ projectId: 'p', type: 'defect', title: 'x', resultId: 'missing' }, {}, { id: 'i', now: NOW })).toThrow('찾을 수 없어요');
    expect(() => buildIssue({ projectId: 'p', type: 'defect', title: 'x' }, { result: source }, { id: 'i', now: NOW })).toThrow('지정되지 않았어요');
    expect(() => buildIssue({ projectId: 'p', type: 'defect', title: '   ' }, {}, { id: 'i', now: NOW })).toThrow('제목');
  });

  it('입력 객체(draft · 결과)를 바꾸지 않는다', () => {
    const draft = deepFreeze({ projectId: 'p', type: 'defect' as const, title: ' 제목 ', resultId: 'res-1', expected: ' 기대 ' });
    const source = deepFreeze(result());
    expect(() => buildIssue(draft, { result: source }, { id: 'i', now: NOW })).not.toThrow();
    expect(draft.title).toBe(' 제목 ');
  });
});

describe('이슈 · 확인사항 고치기', () => {
  it('open → resolved에서 resolvedAt을 기록하고, resolved → open에서 지우며, 다시 resolved면 새 시각이다', () => {
    const resolved = applyIssueChanges(created(), { status: 'resolved' }, LATER);
    expect(resolved).toMatchObject({ changed: true, issue: { status: 'resolved', resolvedAt: LATER, updatedAt: LATER } });

    const reopened = applyIssueChanges(resolved.issue, { status: 'open' }, LATEST);
    expect(reopened.issue.status).toBe('open');
    expect(reopened.issue).not.toHaveProperty('resolvedAt');

    const again = applyIssueChanges(reopened.issue, { status: 'resolved' }, '2026-10-03T00:00:00.000Z');
    expect(again.issue.resolvedAt).toBe('2026-10-03T00:00:00.000Z');
  });

  it('open ↔ deferred ↔ resolved 어느 방향이든 바꿀 수 있고, deferred에는 resolvedAt이 없다', () => {
    const deferred = applyIssueChanges(created(), { status: 'deferred' }, LATER).issue;
    expect(deferred).toMatchObject({ status: 'deferred' });
    expect(deferred).not.toHaveProperty('resolvedAt');
    expect(applyIssueChanges(deferred, { status: 'open' }, LATER).issue.status).toBe('open');
    const resolved = applyIssueChanges(deferred, { status: 'resolved' }, LATER).issue;
    expect(resolved.resolvedAt).toBe(LATER);
    const deferredAgain = applyIssueChanges(resolved, { status: 'deferred' }, LATEST).issue;
    expect(deferredAgain).not.toHaveProperty('resolvedAt');
  });

  it('바뀐 것이 없으면 changed=false이고 updatedAt을 그대로 둔다(같은 상태 · 같은 값 · 공백만 다른 값)', () => {
    const issue = created({ note: '메모' });
    for (const changes of [{}, { status: 'open' as const }, { title: '이슈' }, { note: ' 메모 ' }, { description: '' }]) {
      const outcome = applyIssueChanges(issue, changes, LATER);
      expect(outcome.changed).toBe(false);
      expect(outcome.issue.updatedAt).toBe(NOW);
    }
  });

  it('제목 · 설명 · expected · actual · 재현 방법 · 메모 · 유형을 고치고, 빈 값은 지운다', () => {
    const issue = created({ note: '지울 메모' });
    const { issue: next } = applyIssueChanges(issue, { type: 'question', title: '새 제목', description: '설명', expected: '기대', actual: '실제', reproduction: '1. 열기', note: '' }, LATER);
    expect(next).toMatchObject({ type: 'question', title: '새 제목', description: '설명', expected: '기대', actual: '실제', reproduction: '1. 열기', updatedAt: LATER });
    expect(next).not.toHaveProperty('note');
    expect(() => applyIssueChanges(issue, { title: ' ' }, LATER)).toThrow('제목');
  });

  it('연결 필드(프로젝트 · TC · 결과 · 생성 시각)는 고칠 수 없다', () => {
    const issue = created({ testCaseId: 'tc-101', resultId: 'res-1' });
    const sneaky = { title: '바꿈', resultId: 'res-2', testCaseId: 'tc-2', projectId: 'other', createdAt: LATEST } as never;
    expect(applyIssueChanges(issue, sneaky, LATER).issue).toMatchObject({ resultId: 'res-1', testCaseId: 'tc-101', projectId: 'p', createdAt: NOW });
  });

  it('입력 이슈를 바꾸지 않고 새 객체를 돌려준다', () => {
    const issue = deepFreeze(created());
    const outcome = applyIssueChanges(issue, { status: 'resolved', title: '고침' }, LATER);
    expect(outcome.issue).not.toBe(issue);
    expect(issue).toMatchObject({ status: 'open', title: '이슈' });
    expect(applyIssueChanges(issue, {}, LATER).issue).not.toBe(issue);
  });
});

describe('이후 수행 결과', () => {
  const imports = [round('imp-1', 1), round('imp-2', 2), round('imp-3', 3), round('imp-10', 10), round('imp-x', 4, 'other')];
  const linked = result({ id: 'r-2', importId: 'imp-2' });

  it('같은 TC · 같은 플랫폼의 뒤 차수 결과만 차수 오름차순으로 돌려준다', () => {
    const results = [
      linked,
      result({ id: 'r-1', importId: 'imp-1', result: 'pass' }),
      result({ id: 'r-10', importId: 'imp-10', result: 'pass' }),
      result({ id: 'r-3', importId: 'imp-3', result: 'pass' }),
      result({ id: 'r-3-ios', importId: 'imp-3', platform: 'ios', result: 'pass' }),
      result({ id: 'r-3-other-tc', importId: 'imp-3', testCaseId: 'tc-999', externalId: 'TC-101' }),
      result({ id: 'r-other-project', importId: 'imp-x' }),
    ];
    expect(laterResultsFor(linked, imports, results).map((item) => [item.result.id, item.resultImport.round])).toEqual([
      ['r-3', 3],
      ['r-10', 10],
    ]);
  });

  it('고객사 TC ID로 추측하지 않는다: TC에 연결되지 않은 결과는 이후 결과가 없다', () => {
    const unlinked = result({ id: 'u-2', importId: 'imp-2', testCaseId: undefined });
    expect(laterResultsFor(unlinked, imports, [unlinked, result({ id: 'u-3', importId: 'imp-3', testCaseId: undefined })])).toEqual([]);
  });
});
