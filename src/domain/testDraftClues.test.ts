import { describe, expect, it } from 'vitest';
import { createSeed, PROJECT_A } from '@/data/mock/seed';
import { analyzeTestDraftGeneration, planTestDraftGeneration, toTestDraftDecisionInputs, type TestDraftContext } from './testDraftGeneration';
import type { Requirement, TestPerspective } from './types';

/*
 * 권한 · API 관점 단서의 정확도. 단어가 문장 어딘가에 있는지가 아니라 주체와 동작의 관계로 판정하는지,
 * 실제 분석 경로(analyzeTestDraftGeneration → analyzeTestDraftCandidates)로 후보가 만들어지는지 · 건너뛰는지를 확인한다.
 * 정확도가 우선이다: 애매한 문장은 만들지 않는다.
 */

const seed = createSeed();
const project = { ...seed.projects.find((item) => item.id === PROJECT_A)!, testScopes: ['functional', 'api'] as const };

const requirement = (text: string): Requirement => ({
  id: 'req-clue',
  projectId: PROJECT_A,
  feature: '단서',
  text,
  sourceRefs: [{ deliverableId: 'dlv-plan-pdf', locator: 'p.1' }],
  sourceType: 'source_explicit',
  needsConfirmation: false,
  lifecycle: 'active',
  status: 'draft',
});

const context = (text: string): TestDraftContext => ({
  project: { ...project, testScopes: [...project.testScopes] },
  requirements: [requirement(text)],
  deliverables: seed.deliverables.filter((item) => item.projectId === PROJECT_A),
  testConditions: [],
  testCases: [],
  templates: seed.templates,
});

/** 실제 분석 경로로 이 관점의 후보가 만들어지는가. 만들지 않으면 건너뛴 이유가 남는다. */
function generates(perspective: TestPerspective, text: string): boolean {
  const analysis = analyzeTestDraftGeneration(context(text), { requirementIds: ['req-clue'], perspectives: [perspective] });
  if (analysis.rows.length > 0) {
    expect(analysis.rows[0]).toMatchObject({ kind: 'create', candidate: { perspective } });
    return true;
  }
  expect(analysis.skipped).toEqual([{ requirementId: 'req-clue', perspective, reason: expect.stringContaining('단서가 없어 만들지 않았어요') }]);
  return false;
}

describe('권한 관점: 주체와 접근 제한의 관계가 있을 때만 만든다', () => {
  it.each([
    // 리뷰 지적: 화면 이름 · 대상 한정 · 일반 동작
    '관리자 페이지에는 로고만 노출한다.',
    '운영자 화면에는 제목만 노출한다.',
    '운영자 화면의 제목을 수정할 수 있다.',
    '관리자에게 공지 문구를 보여준다.',
    '관리자 화면에서 프로필 사진을 업로드할 수 있다.',
    // 주체 + 화면 이름
    '관리자 메뉴의 아이콘을 바꾼다.',
    '운영자 대시보드에서 통계를 조회할 수 있다.',
    '비회원 주문 화면에서 배송지를 입력한다.',
    // 주체 + 표시 문구
    '관리자 이름을 헤더에 표시한다.',
    '운영자에게 알림 메일을 보낸다.',
    '관리자 연락처만 표시한다.',
    // 주체 없이 제한처럼 보이는 일반 동작
    '광고 팝업을 차단한다.',
    '스팸 메일을 차단한다.',
    '설정 화면으로 접근한다.',
    '첨부 파일은 10개까지만 업로드할 수 있다.',
    '권한 설정 화면의 제목을 바꾼다.',
    // 주체가 있지만 다른 구절의 동작
    '관리자는 공지를 작성하고, 사용자는 공지를 볼 수 있다.',
  ])('만들지 않는다: %s', (text) => {
    expect(generates('permission', text)).toBe(false);
  });

  it.each([
    // 리뷰 요구 positive
    '관리자만 접근할 수 있다.',
    '관리자 권한이 있는 사용자만 수정할 수 있다.',
    '비로그인 사용자는 접근할 수 없다.',
    '운영자 역할에만 메뉴를 노출한다.',
    '권한이 없는 사용자는 사용할 수 없다.',
    '비회원은 주문 내역을 조회할 수 없다.',
    // 명시적 권한 표현
    '접근 권한이 있는 사용자에게 보고서를 보여준다.',
    '역할 권한에 따라 메뉴가 달라진다.',
    '권한별로 버튼이 다르게 보인다.',
    '이 기능은 접근 제어 정책을 따른다.',
    '삭제에는 관리자 권한이 필요하다.',
    // 로그인 여부 제한
    '로그인하지 않은 사용자는 목록을 열람할 수 없다.',
    '로그인한 사용자만 댓글을 작성할 수 있다.',
    '비로그인 사용자에게는 기능을 노출하지 않는다.',
    // 역할 제한
    '운영자만 공지를 삭제할 수 있다.',
    '관리자에게만 통계 메뉴를 노출한다.',
  ])('만든다: %s', (text) => {
    expect(generates('permission', text)).toBe(true);
  });
});

describe('API 관점: 통신 주체와 요청 · 응답의 관계가 있을 때만 만든다', () => {
  it.each([
    // 리뷰 지적: 서버가 다른 명사를 꾸미는 경우
    '서버 관리자의 휴가 요청에 응답 메시지를 보낸다.',
    '서버 관리자 요청 목록을 표시한다.',
    '서버 이름과 고객 응답 메시지를 표시한다.',
    // 일반 · 업무 요청 · 응답
    '사용자 요청에 응답한다.',
    '고객 요청에 응답 메시지를 보낸다.',
    '가입 요청 시 안내 문구를 표시한다.',
    '요청이 접수되면 완료 화면을 보여준다.',
    '휴가 요청을 승인하면 신청자에게 응답을 보낸다.',
    '문의 요청에 대한 응답을 24시간 안에 보낸다.',
    // 서버 화면 · 이름
    '서버 목록 화면에 서버 이름을 표시한다.',
    '서버 상태 화면의 제목을 바꾼다.',
    '서버 점검 공지를 노출한다.',
    // 클라이언트 · 네트워크가 다른 뜻
    '클라이언트 회사 로고를 표시한다.',
    '네트워크 설정 메뉴의 아이콘을 바꾼다.',
  ])('만들지 않는다: %s', (text) => {
    expect(generates('api', text)).toBe(false);
  });

  it.each([
    // 리뷰 요구 positive
    '서버에 요청을 보내고 응답 데이터를 처리한다.',
    '클라이언트가 서버로 요청하고 응답 값을 표시한다.',
    '네트워크 요청 후 응답 결과를 저장한다.',
    'API 요청 후 응답 값을 표시한다.',
    'HTTP 요청 실패 시 상태 코드를 확인한다.',
    // 명시적 기술 용어
    '로그인 엔드포인트는 토큰을 돌려준다.',
    'REST 방식으로 목록을 받아온다.',
    'GraphQL 질의로 상품을 조회한다.',
    'status code 401이면 다시 로그인한다.',
    // 실제 통신 관계
    '서버 응답이 실패하면 오류를 보여준다.',
    '서버 요청이 성공하면 토큰을 응답한다.',
    '서버를 호출해 결과를 받아온다.',
    '클라이언트에서 요청한 값을 서버가 검증한다.',
    '서버와 통신이 끊기면 다시 시도한다.',
  ])('만든다: %s', (text) => {
    expect(generates('api', text)).toBe(true);
  });

  it('API 초안 문구는 요구사항에 없는 API · 경로 · 상태 코드를 지어내지 않는다', () => {
    const ctx = context('서버에 요청을 보내고 응답 데이터를 처리한다.');
    const analysis = analyzeTestDraftGeneration(ctx, { requirementIds: ['req-clue'], perspectives: ['api'] });
    const [testCase] = planTestDraftGeneration(ctx, analysis, toTestDraftDecisionInputs(analysis), { createId: (prefix) => `${prefix}-1`, now: '2026-10-05T00:00:00.000Z' }).testCases;
    expect(testCase.steps).toEqual(['요구사항에 적힌 요청을 보낸다.', '응답이 요구사항대로인지 확인한다.']);
    expect(testCase.expectedResult).toBe('요청에 요구사항대로 응답한다. (서버에 요청을 보내고 응답 데이터를 처리한다)');
    expect([...testCase.steps, testCase.expectedResult].join(' ')).not.toMatch(/API|\/|\b[1-5]\d\d\b/);
  });
});

describe('다른 관점은 바뀌지 않는다', () => {
  it.each([
    ['boundary', '비밀번호는 8자 이상이어야 한다.', true],
    ['boundary', '2026년 보고서를 다운로드한다.', false],
    ['state_change', '앱을 재실행해도 로그인 상태를 유지한다.', true],
    ['data_io', '입력한 내용을 서버에 저장한다.', true],
    ['data_io', '안내 문구를 보여준다.', false],
  ] as [TestPerspective, string, boolean][])('%s · %s → %s', (perspective, text, expected) => {
    expect(generates(perspective, text)).toBe(expected);
  });
});
