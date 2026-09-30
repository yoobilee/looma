import { describe, expect, it } from 'vitest';
import { deliverableRevisionChain } from '@/domain/traceability';
import { createMockRepositories } from './mockRepositories';
import { PROJECT_A } from './seed';

async function loadProjectA() {
  const repos = createMockRepositories();
  const [requirements, conditions, testCases] = await Promise.all([
    repos.requirements.listByProject(PROJECT_A),
    repos.testConditions.listByProject(PROJECT_A),
    repos.testCases.listByProject(PROJECT_A),
  ]);
  return { repos, requirements, conditions, testCases };
}

describe('요구사항 → 테스트 조건 → TC 추적', () => {
  it('요구사항 1개에서 테스트 조건 여러 개가 나온다', async () => {
    const { conditions } = await loadProjectA();
    const fromPasswordRule = conditions.filter((item) => item.requirementIds.includes('req-002'));
    expect(fromPasswordRule.map((item) => item.id)).toEqual(['cond-001', 'cond-002', 'cond-003']);
  });

  it('테스트 조건 1개가 요구사항 여러 개와 연결될 수 있다', async () => {
    const { conditions } = await loadProjectA();
    expect(conditions.find((item) => item.id === 'cond-001')?.requirementIds).toEqual(['req-001', 'req-002']);
  });

  it('테스트 조건 1개에서 TC 여러 개가 나온다', async () => {
    const { testCases } = await loadProjectA();
    const fromLengthBoundary = testCases.filter((item) => item.testConditionIds.includes('cond-002'));
    expect(fromLengthBoundary.map((item) => item.externalId)).toEqual(['SIGN-002', 'SIGN-003']);
  });

  it('TC 1개가 요구사항 여러 개를 검증할 수 있다', async () => {
    const { testCases } = await loadProjectA();
    expect(testCases.find((item) => item.id === 'tc-001')?.requirementIds).toEqual(['req-001', 'req-002']);
  });

  it('모든 연결은 실제로 존재하는 요구사항·조건·산출물을 가리킨다', async () => {
    const { repos, requirements, conditions, testCases } = await loadProjectA();
    const deliverableIds = new Set((await repos.deliverables.listByProject(PROJECT_A)).map((item) => item.id));
    const requirementIds = new Set(requirements.map((item) => item.id));
    const conditionIds = new Set(conditions.map((item) => item.id));

    for (const requirement of requirements) {
      expect(requirement.sourceRefs.length, requirement.id).toBeGreaterThan(0);
      for (const ref of requirement.sourceRefs) expect(deliverableIds.has(ref.deliverableId), requirement.id).toBe(true);
    }
    for (const condition of conditions) {
      for (const id of condition.requirementIds) expect(requirementIds.has(id), condition.id).toBe(true);
    }
    for (const testCase of testCases) {
      for (const id of testCase.requirementIds) expect(requirementIds.has(id), testCase.id).toBe(true);
      for (const id of testCase.testConditionIds) expect(conditionIds.has(id), testCase.id).toBe(true);
      for (const ref of testCase.sourceRefs) expect(deliverableIds.has(ref.deliverableId), testCase.id).toBe(true);
    }
  });

  it('TC 조건의 요구사항은 TC가 검증하는 요구사항에 포함된다', async () => {
    const { conditions, testCases } = await loadProjectA();
    for (const testCase of testCases) {
      for (const conditionId of testCase.testConditionIds) {
        const condition = conditions.find((item) => item.id === conditionId)!;
        for (const requirementId of condition.requirementIds) expect(testCase.requirementIds, testCase.id).toContain(requirementId);
      }
    }
  });
});

describe('산출물 revision', () => {
  // seed에는 기획서 v1.4(dlv-plan-pdf) → v1.5(dlv-plan-pdf-v15) revision이 이미 있다.
  it('기존 산출물의 새 버전은 이전 버전과 연결되고, 별도 신규 산출물과 구분된다', async () => {
    const repos = createMockRepositories();
    const v16 = await repos.deliverables.create({ projectId: PROJECT_A, type: 'pdf', title: '모바일_개편_기획_v1.6.pdf', version: 'v1.6', previousRevisionId: 'dlv-plan-pdf-v15' });
    const v17 = await repos.deliverables.create({ projectId: PROJECT_A, type: 'pdf', title: '모바일_개편_기획_v1.7.pdf', version: 'v1.7', previousRevisionId: v16.id });
    const separate = await repos.deliverables.create({ projectId: PROJECT_A, type: 'pdf', title: '결제_기획_v1.0.pdf', version: 'v1.0' });

    const deliverables = await repos.deliverables.listByProject(PROJECT_A);
    expect(deliverableRevisionChain(deliverables, v16.id).map((item) => item.version)).toEqual(['v1.4', 'v1.5', 'v1.6', 'v1.7']);
    expect(deliverableRevisionChain(deliverables, 'dlv-plan-pdf').map((item) => item.id)).toEqual(['dlv-plan-pdf', 'dlv-plan-pdf-v15', v16.id, v17.id]);
    expect(separate.previousRevisionId).toBeUndefined();
    expect(deliverableRevisionChain(deliverables, separate.id)).toEqual([separate]);
  });

  it('이미 다음 버전이 있는 산출물에서 갈라지는 revision은 만들 수 없다', async () => {
    const repos = createMockRepositories();
    // v1.4 → v1.5가 있으므로 v1.4에서 또 갈라질 수 없다.
    await expect(
      repos.deliverables.create({ projectId: PROJECT_A, type: 'pdf', title: '모바일_개편_기획_v1.5b.pdf', version: 'v1.5b', previousRevisionId: 'dlv-plan-pdf' }),
    ).rejects.toThrow('이미 다음 버전');

    // 실패한 요청은 저장되지 않고, 최신 버전에서 이어 붙이는 정상 흐름은 계속 통과한다.
    const v16 = await repos.deliverables.create({ projectId: PROJECT_A, type: 'pdf', title: '모바일_개편_기획_v1.6.pdf', version: 'v1.6', previousRevisionId: 'dlv-plan-pdf-v15' });
    const deliverables = await repos.deliverables.listByProject(PROJECT_A);
    expect(deliverables.filter((item) => item.previousRevisionId === 'dlv-plan-pdf')).toHaveLength(1);
    expect(deliverableRevisionChain(deliverables, 'dlv-plan-pdf').map((item) => item.id)).toEqual(['dlv-plan-pdf', 'dlv-plan-pdf-v15', v16.id]);
  });

  it('다른 프로젝트나 없는 산출물을 이전 버전으로 지정할 수 없다', async () => {
    const repos = createMockRepositories();
    await expect(repos.deliverables.create({ projectId: PROJECT_A, type: 'pdf', title: 'x', previousRevisionId: 'missing' })).rejects.toThrow('찾을 수 없어요');
    await expect(repos.deliverables.create({ projectId: PROJECT_A, type: 'pdf', title: 'x', previousRevisionId: 'dlv-b-spec' })).rejects.toThrow('찾을 수 없어요');
  });
});

describe('TC 수명주기와 기존 결과 연결', () => {
  it('Looma ID와 고객사 TC ID가 분리되어 있고 생성 출처·revision을 가진다', async () => {
    const { testCases } = await loadProjectA();
    const tc = testCases.find((item) => item.id === 'tc-001')!;
    expect(tc.externalId).toBe('SIGN-001');
    expect(tc.origin).toBe('ai_generated');
    expect(tc.revision).toBe(1);
  });

  it('상태를 바꿔도 revision은 유지된다', async () => {
    const { repos } = await loadProjectA();
    const updated = await repos.testCases.updateStatus('tc-002', 'needs_review');
    expect(updated.status).toBe('needs_review');
    expect(updated.revision).toBe(1);
  });

  it('수행 결과는 계속 externalId로 Looma TC와 연결된다', async () => {
    const { repos, testCases } = await loadProjectA();
    const byId = new Map(testCases.map((item) => [item.id, item]));
    const imports = await repos.testResults.listImports(PROJECT_A);
    expect(imports).toHaveLength(2);

    for (const resultImport of imports) {
      const results = await repos.testResults.listResults(resultImport.id);
      const linked = results.filter((item) => item.testCaseId);
      // Looma TC 15개 × Android/iOS
      expect(linked).toHaveLength(30);
      for (const result of linked) expect(byId.get(result.testCaseId!)?.externalId).toBe(result.externalId);
    }
  });
});
