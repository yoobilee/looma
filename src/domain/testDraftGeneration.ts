import { testPerspectiveLabel } from './labels';
import type { Deliverable, Project, Requirement, SourceRef, TCTemplate, TestCase, TestCaseGenerationType, TestCondition, TestPerspective } from './types';

/*
 * 요구사항 기반 TC 초안 생성 — AI 없이 요구사항과 사용자가 고른 테스트 관점에서 TestCondition · TestCase 초안을 만든다.
 *
 *   요구사항 + 관점 ─ 후보 생산자(지금은 규칙 기반) ─▶ TestDraftCandidate[] ─ 분석(중복 · 오류 · 조건 재사용) ─▶ 사용자 검토 · 판단 ─▶ 저장 계획
 *
 * 후보 생산자만 갈아 끼울 수 있다. 나중에 AI가 같은 TestDraftCandidate를 만들면 analyzeTestDraftCandidates부터 그대로 쓴다.
 * 규칙 기반 생산자는 요구사항에 없는 구체값(화면 문구 · 버튼 이름 · API 경로 · 상태 코드 · 시간 · 브라우저 버전)을 만들지 않는다.
 * 단서가 있는 관점(경계값 · 권한 · 상태 변화 · 데이터 · API · 성능)은 요구사항 문장에 그 단서가 있을 때만 후보를 만든다.
 *
 * 저장은 사용자가 본 미리보기와 같은 후보만 한다: 후보마다 지문(fingerprint)을 만들고, 저장할 때 현재 데이터로 다시 분석해 지문이 모두 같을 때만 반영한다.
 * 중복 후보는 사용자가 판단해야 한다(기존 TC와 연결 · 별도 신규 · 제외). 기존 TC는 연결을 고른 경우에만, 요구사항 · 조건 · 근거 연결만 더하고 내용은 바꾸지 않는다.
 * 모든 계산은 입력을 바꾸지 않는다.
 */

export class TestDraftGenerationError extends Error {}

/** 미리보기 뒤에 요구사항 · 기존 TC가 바뀌어 사용자가 본 후보와 달라졌다. */
export class StaleTestDraftPreviewError extends TestDraftGenerationError {}

export const STALE_TEST_DRAFT_PREVIEW_MESSAGE = '요구사항이나 기존 TC가 바뀌어 미리보기를 다시 확인해 주세요.';

/* ---------- 후보 ---------- */

/** 요구사항 하나(또는 여럿)와 관점 하나에서 나온 TC 초안 후보. 파일 · 규칙 · AI 어디서 만들었는지는 모른다. */
export interface TestDraftCandidate {
  /** 후보를 가리키는 값. 같은 관점 · 같은 요구사항 조합은 같은 key다. */
  key: string;
  perspective: TestPerspective;
  /** 근거 요구사항. 여럿이 한 후보에 이어질 수 있다. 분석할 때 중복을 없애고 정렬한다. */
  requirementIds: string[];
  /** 요구사항에서 물려받은 근거 유형. 확인 필요면 검토 완료로 표시할 수 없다. */
  generationType: TestCaseGenerationType;
  condition: { feature: string; title: string };
  testCase: { feature: string; depth: string[]; title: string; precondition?: string; steps: string[]; expectedResult: string };
}

/** 요구사항 ID 집합. 중복은 한 번만 세고 순서는 정렬로 고정한다(입력은 바꾸지 않는다). */
const normalizeIds = (ids: string[]) => [...new Set(ids)].sort();

export const testDraftCandidateKey = (perspective: TestPerspective, requirementIds: string[]) => `${perspective}|${normalizeIds(requirementIds).join(',')}`;

export interface TestDraftContext {
  project: Pick<Project, 'id' | 'platforms' | 'testScopes' | 'tcTemplateId'>;
  requirements: Requirement[];
  deliverables: Deliverable[];
  testConditions: TestCondition[];
  testCases: TestCase[];
  /** 프로젝트가 쓰는 TC 양식(있다면). 새 TC에 양식 ID를 붙이기 전에 실제로 쓸 수 있는지 확인한다. */
  templates: Pick<TCTemplate, 'id' | 'projectId'>[];
}

export interface TestDraftRequest {
  requirementIds: string[];
  perspectives: TestPerspective[];
}

/** 프로젝트 테스트 범위를 골랐을 때만 쓸 수 있는 관점 */
const scopeDrivenPerspectives = ['api', 'performance', 'compatibility'] as const;
const knownPerspectives = Object.keys(testPerspectiveLabel) as TestPerspective[];

/** 생성 대상이 될 수 있는 요구사항: 이 프로젝트의 요구사항이고 제거되지 않았다. 검토 상태(draft 등)는 보지 않는다. */
export const isTestDraftEligible = (requirement: Requirement, projectId: string) => requirement.projectId === projectId && requirement.lifecycle !== 'removed';

/** 관점이 이 프로젝트에서 쓸 수 있는지 */
export function isPerspectiveAvailable(perspective: TestPerspective, project: Pick<Project, 'testScopes'>): boolean {
  return !(scopeDrivenPerspectives as readonly string[]).includes(perspective) || project.testScopes.includes(perspective as 'api' | 'performance' | 'compatibility');
}

/**
 * 프로젝트의 TC 양식을 새 TC에 붙일 수 있는가. 양식이 없는 프로젝트는 양식 없이 만든다.
 * 있다면 실제로 존재해야 하고, 이 프로젝트 전용이거나 프로젝트가 정해지지 않은 공용 양식이어야 한다(다른 프로젝트 전용 양식은 쓰지 않는다).
 */
export function validateDraftTemplate(context: Pick<TestDraftContext, 'project' | 'templates'>): void {
  const id = context.project.tcTemplateId;
  if (!id) return;
  const template = context.templates.find((item) => item.id === id);
  if (!template) throw new TestDraftGenerationError(`프로젝트의 TC 양식을 찾을 수 없어요. (${id})`);
  if (template.projectId !== undefined && template.projectId !== context.project.id) throw new TestDraftGenerationError(`다른 프로젝트의 TC 양식은 쓸 수 없어요. (${id})`);
}

function validateRequest(context: TestDraftContext, request: TestDraftRequest): Requirement[] {
  if (request.requirementIds.length === 0) throw new TestDraftGenerationError('초안을 만들 요구사항을 하나 이상 골라 주세요.');
  if (request.perspectives.length === 0) throw new TestDraftGenerationError('테스트 관점을 하나 이상 골라 주세요.');
  const seenPerspectives = new Set<string>();
  for (const perspective of request.perspectives) {
    if (!knownPerspectives.includes(perspective)) throw new TestDraftGenerationError(`알 수 없는 테스트 관점이에요. (${String(perspective)})`);
    if (seenPerspectives.has(perspective)) throw new TestDraftGenerationError(`같은 테스트 관점을 두 번 골랐어요. (${testPerspectiveLabel[perspective]})`);
    seenPerspectives.add(perspective);
    if (!isPerspectiveAvailable(perspective, context.project)) throw new TestDraftGenerationError(`이 프로젝트의 테스트 범위에 없는 관점이에요. (${testPerspectiveLabel[perspective]})`);
  }
  const byId = new Map(context.requirements.map((item) => [item.id, item]));
  const seenRequirements = new Set<string>();
  return request.requirementIds.map((id) => {
    if (seenRequirements.has(id)) throw new TestDraftGenerationError(`같은 요구사항을 두 번 골랐어요. (${id})`);
    seenRequirements.add(id);
    const requirement = byId.get(id);
    if (!requirement || requirement.projectId !== context.project.id) throw new TestDraftGenerationError(`이 프로젝트에서 요구사항을 찾을 수 없어요. (${id})`);
    if (requirement.lifecycle === 'removed') throw new TestDraftGenerationError(`제거된 요구사항으로는 초안을 만들 수 없어요. (${id})`);
    return requirement;
  });
}

/* ---------- 규칙 기반 후보 생산자 ---------- */

const clean = (value: string) => value.normalize('NFC').replace(/\s+/g, ' ').trim();
/** 문장 끝의 마침표를 뺀 요구사항 문장 */
const sentence = (requirement: Requirement) => clean(requirement.text).replace(/[.。]+$/, '');

/**
 * 요구사항 문장에 이 관점의 단서가 있는가. 단서가 없는 관점은 억지로 만들지 않는다.
 * 일반적인 낱말 하나(숫자 · 차단 · 요청 · 입력 · 변경 · 관리자 · 응답)만으로는 단서로 보지 않고, 그 관점의 뜻이 분명한 표현이나 뜻의 조합을 요구한다.
 */
type Clue = RegExp | ((text: string) => boolean);

// 권한 · API 단서는 낱말이 문장 어딘가에 있는지(문장 전체 AND)도, 몇 글자 안에 함께 있는지도 아니라 낱말 사이의 문법 관계로 본다.
// 거리만 보면 "관리자가 주문을 승인하지 않으면 취소된다"(일반 조건) · "관리자는 공지를 작성하고 사용자는 수정할 수 없다"(주체가 바뀜) ·
// "서버 요청 목록"(복합명사)처럼 관계없는 낱말이 우연히 조건을 채운다. 그래서 확실한 문형만 단서로 본다.
// - 주체 바로 뒤에 조사가 붙고 그 뒤가 띄어져야 주체다("관리자 페이지" · "운영자가이드"의 관리자 · 운영자는 주체가 아니다).
// - 주체와 동작 사이에는 목적어 · 장소 하나만 올 수 있다. 다른 주체(은/는/이/가 · 에게 · 에서)나 다른 구절(-고 · -면 · -한)이 끼면 잇지 않는다.
// - 동작은 동사로 쓰여야 한다("접근 기록" · "요청서" · "통신 여부"처럼 명사의 일부이면 동작이 아니다).
// - 권한 동작은 그 구절의 서술어여야 한다("운영자만 수정한 문서"처럼 뒤 명사를 꾸미는 관형절이면 권한 서술이 아니다).
// 애매하면 만들지 않는다(정확도 우선). 놓친 조합은 미리보기에 이유와 함께 보인다.

/** 앞에 다른 글자가 붙지 않은 낱말의 시작("옵서버"의 서버는 통신 주체가 아니다) */
const WORD_START = '(?<![가-힣A-Za-z0-9])';
/** 뒤에 다른 글자가 붙지 않은 낱말의 끝 */
const WORD_END = '(?![가-힣A-Za-z0-9])';
/**
 * 꾸밈 낱말이 조사(은/는/이/가/을/를/에/에게/에서/만/도/와/과/로)나 어미(-고 · -며 · -면 · -한 · -된 · -할 · -던 · -아서)로 끝나면 새 주체 · 대상 · 구절이 시작된 것이라 잇지 않는다.
 * 같은 글자로 끝나는 흔한 명사(화면 · 문서 · 재고 · 권한 · 한도 · 경로 · 길이)는 조사 · 어미가 아니라 명사로 본다.
 */
const PHRASE_BOUNDARY = [
  '은|는|을|를|에|게|만|와|과|며|된|할|던|가',
  '(?<![길높깊넓])이',
  '(?:에|[아어여해와워져])서',
  '(?<![속한정온강빈용])도',
  '(?<![경자도])로',
  '(?<![재광공참])고',
  '(?<![화장측정표전후])면',
  '(?<![권기제])한',
].join('|');
const MODIFIER = `(?:(?![가-힣A-Za-z0-9]*(?:${PHRASE_BOUNDARY})\\s)[가-힣A-Za-z0-9]+\\s+)`;
/**
 * 주체와 동작 사이에 올 수 있는 목적어 · 장소(없어도 된다). 각각 꾸밈 명사 두 개까지 + 을/를/에/에게로 끝나는 명사이고 두 개까지 온다.
 * 예: "주문 내역을" · "결제 화면에" · "클라이언트에 토큰을". 은/는/이/가가 붙은 낱말(새 주체)은 올 수 없다.
 */
const OBJECT = `(?:${MODIFIER}{0,2}[가-힣A-Za-z0-9]+(?:을|를|에게|에)\\s+){0,2}`;
/**
 * 동작이 구절을 끝맺는다: "없다" · "않는다" · "불가." · "않도록 한다".
 * "않으면" · "없는 경우" · "못한 사용자" · "없고"처럼 조건 · 꾸밈 · 연결 어미이면 제한이 아니라 다른 동작의 조건이나 일부다.
 */
const CLAUSE_END = '(?:[가-힣]*(?:다|음|함|됨|요)|[가-힣]*(?:게|도록)\\s+[가-힣]*다)?(?=\\s*(?:[,.;:!?·\\n]|$))';

/** 권한을 직접 말하는 표현(단독으로 강한 단서): 권한이 있다/없다 · 권한 필요 · 접근 권한 · 권한에 따라 · 권한별 · 권한 제한 · 접근 제어 */
const permissionExplicit = /접근\s*권한|권한\s*[이을가]?\s*(?:있|없|필요)|권한에\s*따라|권한별|권한\s*제한|접근\s*제어/;

/** 권한 주체 */
const ROLE = '(?:관리자|운영자|비회원|일반\\s*사용자|비로그인(?:\\s*사용자)?|로그인하지\\s*않은\\s*사용자|로그인한\\s*사용자)(?:\\s*역할)?';
/** 권한으로 제한되는 동작 */
const ACTION = '(?:접근|사용|이용|수정|조회|열람|삭제|등록|노출|진입|다운로드|업로드|변경|구매|주문|작성|승인|취소|편집|읽기|쓰기)';

// 아래 술어는 모두 CLAUSE_END와 함께 쓴다. 동작이 그 구절의 서술어여야 하고,
// "수정한 문서" · "등록된 항목"(관형절) · "접근하면" · "접근할 수 있는 경우"(조건)처럼 뒤 명사나 다른 동작에 걸리면 권한 서술이 아니다.

/** 동작을 하는 형태: "수정할" · "수정 할" · "수정을 할"(명사 + 을/를 + 하다) · "조회만 할"(동작의 범위를 그 동작으로 한정) */
const ACTION_DO = `${ACTION}(?:(?:을|를|만)\\s*|\\s*)`;
/**
 * 할 수 있다 · 할 수 없다 · 하지 못한다: 그 주체가 그 동작을 할 수 있는지를 말한다(권한 서술).
 * "승인을 하지 않는다" · "등록을 하고"처럼 할 수 있음을 말하지 않는 일반 업무 서술은 아니다.
 */
const CAPABILITY = `${ACTION_DO}(?:할\\s*수\\s*(?:있|없)|하지\\s*못)`;
/** 그 주체에게만 허용되는 서술: 할 수 있다 · 수정을 할 수 있다 · 가능하다 · 노출한다 · 접근을 허용한다 */
const ALLOWED = `(?:${ACTION_DO}할\\s*수\\s*있|${ACTION}(?:(?:이|은|는)?\\s*가능|하|한|합|되|된|됩|(?:을|를|이|가)?\\s*(?:허용|허가)(?:하|한|합|되|된|됩)))`;
/** 할 수 없다 · 하지 못한다 · 불가 · 제한된다: 그 주체가 할 수 없게 막는다 */
const ABLE_DENIED = '(?:할\\s*수\\s*없|하지\\s*못|(?:은|는|이|가)?\\s*불가|(?:이|가)?\\s*제한)';
/** 하지 않는다 · 되지 않는다: 시스템이 그 주체에게 하지 않는다. 주체가 스스로 하지 않는 일반 동작("관리자가 승인하지 않는다")과 구분하려고 "주체에게는"에만 쓴다. */
const PLAIN_DENIED = '(?:하|되)지\\s*않';
/**
 * 접근을 허용한다 · 편집을 허용하지 않는다: 시스템이 그 주체에게 허락하거나 막는다. 주체에게 허용 · 허가하는 것 자체가 권한 서술이라 동작 낱말을 가리지 않는다.
 * 허락하는 쪽이 주체일 수 있어("관리자가 접근을 허용한다") "주체에게"에만 쓴다.
 */
const GRANTED = `${MODIFIER}{0,2}[가-힣A-Za-z0-9]+(?:을|를|이|가)?\\s*(?:허용|허가)(?:하|한|합|되|된|됩)(?:지\\s*(?:않|못))?`;
/** 권한 서술이 구절을 끝맺거나, "할 수 있고 · 할 수 없으며"처럼 대등하게 이어진다(조건 · 관형이 아니다). "하지 못하고"는 사건일 수 있어 이어짐으로 보지 않는다. */
const PERMISSION_END = `(?:${CLAUSE_END}|(?<=있|없)(?:고|으며)(?=\\s*,?\\s))`;

const permissionRelation = new RegExp(
  [
    // 주체만 · 주체에게만 · 주체 역할에만 + (목적어) + 허용 서술. 만이 주체에 바로 붙어야 한다("로고만"은 대상 한정이다).
    `${ROLE}(?:만|에만|에게만)\\s+${OBJECT}${ALLOWED}${PERMISSION_END}`,
    // 주체는 · 주체가 · 주체에게는 + (목적어) + 할 수 없다 · 불가 · 제한
    `${ROLE}(?:은|는|이|가|에게는)\\s+${OBJECT}${ACTION}${ABLE_DENIED}${PERMISSION_END}`,
    // 주체는 · 주체가 + (목적어) + 할 수 있다 · 할 수 없다 · 승인을 할 수 없다 · 조회만 할 수 있다: 그 주체의 동작 범위를 말한다.
    // 한 문장에 여러 주체가 있으면("관리자는 수정할 수 있고 일반 사용자는 조회만 할 수 있다") 각 구절을 따로 본다.
    `${ROLE}(?:은|는|이|가)\\s+${OBJECT}${CAPABILITY}${PERMISSION_END}`,
    // 주체에게는 + (목적어) + 하지 않는다
    `${ROLE}에게는\\s+${OBJECT}${ACTION}${PLAIN_DENIED}${CLAUSE_END}`,
    // 주체에게 · 주체에게만 · 주체에게는 + (목적어) + 접근을 허용한다 · 허용하지 않는다
    `${ROLE}(?:에게|에게만|에게는|에만)\\s+${OBJECT}${GRANTED}${CLAUSE_END}`,
  ].join('|'),
);

/**
 * API를 직접 말하는 기술 용어(단독으로 강한 단서).
 * 한국어 "상태 코드" · "응답 상태 코드"만으로는 주문 · 배송 · 설문 응답 · 고객 응답 상태 코드 같은 업무 값일 수 있어 단서로 보지 않는다.
 * status code와, 기술 응답임이 드러난 상태 코드(apiStatusCode)만 쓴다. HTTP · API 상태 코드는 HTTP · API로 이미 잡힌다.
 */
const apiExplicit = /엔드포인트|endpoint|\bhttp\b|\brest\b|graphql|status\s*code|request.{0,30}response/i;

/** 사람 · 조직을 뜻하는 명사. "API 담당자" · "API 운영 조직"의 API는 업무 이름이지 기술 사용이 아니다. */
const PERSON_OR_TEAM = '(?:담당|팀|조직|부서|매니저|책임자|관리자|운영자|개발자|기획자|파트너|협력사|업체)';
/** API와 사람 · 조직 명사 사이에 올 수 있는 꾸밈 낱말(운영 · 개발 · 교육 · 문서 등). 통신 낱말이 끼면("API 호출 실패 담당자") 기술 사용이 섞인 것이라 꾸밈으로 보지 않는다. */
const BUSINESS_WORD = '(?!호출|요청|응답|연결|통신|전송|수신|실패|오류|에러|상태|코드|키|토큰|서버)[가-힣A-Za-z]+';
/**
 * API를 기술로 쓴다: API 낱말이 있고 그것이 사람 · 조직 명사를 꾸미지 않는다. 문장 안의 API 하나하나를 따로 본다
 * ("API 담당자가 API 호출 실패 로그를 확인한다"는 뒤의 API가 기술 사용이다).
 */
const apiTechnical = new RegExp(`\\bapi\\b(?!(?:\\s*${BUSINESS_WORD}){0,2}\\s*${PERSON_OR_TEAM})`, 'i');

/** 통신 주체. 앞뒤에 다른 글자가 붙은 복합어("옵서버" · "서버실")는 아니다. */
const NETWORK = `${WORD_START}(?:서버|네트워크)`;
/** 클라이언트는 고객사라는 업무 뜻도 있어 더 좁게 본다(apiCommunication 참고). */
const CLIENT = `${WORD_START}클라이언트`;
/** 통신 동작이 동사로 쓰였다: "요청한다" · "응답하면" · "호출해" · "통신한다". "요청서" · "요청사항" · "통신 여부"처럼 명사의 일부이면 동작이 아니다. */
const COMM_VERB = '(?:요청|응답|호출|통신)(?:하|한|할|합|해|했|되|된|됩)';
/** 요청 · 응답을 주고받는다: "요청을 보낸다" · "결제 요청을 보낸다" · "응답을 받는다" · "응답이 오면" */
const COMM_EXCHANGE = `${MODIFIER}{0,2}(?:요청|응답)(?:을|를|이|가)\\s*(?:보내|보낸|보냅|전송|받|수신|송신|전달|오|온|와)`;
/** 통신 낱말이 사건으로 쓰였다: "서버 응답이 실패하면" · "네트워크 요청 후" · "서버 요청 실패". "서버 요청 화면" · "네트워크 통신 설정"처럼 다른 명사를 꾸미면 아니다. */
const COMM_EVENT = `(?:요청|응답|호출|통신)(?:(?:이|가|을|를|은|는|에)${WORD_END}|\\s+(?:(?:후|시|중)(?:에|에는)?${WORD_END}|실패|성공|결과|값|데이터|오류))`;

/** 서버 · 네트워크를 상대로 하는 통신 동작: 요청 · 응답 · 호출 · 통신 + 데이터를 보내고 받는 전송 · 송신 · 수신. 앞에 다시 · 즉시 같은 부사가 올 수 있다. */
const NETWORK_ACTION = `(?:(?:다시|즉시|먼저|바로)\\s+)?(?:${COMM_VERB}|(?:전송|송신|수신)(?:하|한|할|합|해|했|되|된|됩)|${COMM_EXCHANGE})`;

/** 서버 · 네트워크와 통신 동작의 관계 */
const networkCommunication = new RegExp(
  [
    // 서버에 요청을 보낸다 · 서버로 요청한다 · 서버에 데이터를 다시 요청한다 · 네트워크로 데이터를 전송한다
    `${NETWORK}(?:에|로|으로|에게)\\s+${OBJECT}${NETWORK_ACTION}`,
    // 서버에서 응답을 받는다 · 서버로부터 응답을 받는다
    `${NETWORK}(?:에서|로부터)\\s+${OBJECT}${NETWORK_ACTION}`,
    // 서버에서 받은 응답 · 서버로부터 온 데이터: 서버가 출처인 통신 결과
    `${NETWORK}(?:에서|로부터)\\s+(?:받은|온|돌아온|내려온)\\s+(?:응답|데이터|값|결과)(?:을|를|이|가|은|는|에|의)?${WORD_END}`,
    // 서버가 응답한다 · 서버가 요청을 보낸다
    `${NETWORK}(?:이|가|은|는)\\s+${OBJECT}${NETWORK_ACTION}`,
    // 서버를 호출한다
    `${NETWORK}(?:을|를)\\s+호출(?:하|한|할|합|해|했)`,
    // 서버와 통신한다 · 서버와 통신이 끊기면
    `${NETWORK}(?:와|과)\\s+(?:${COMM_VERB}|${COMM_EVENT})`,
    // 서버 응답이 실패하면 · 네트워크 요청 후
    `${NETWORK}\\s+${COMM_EVENT}`,
  ].join('|'),
);
/**
 * 클라이언트와 통신 동작의 관계. 클라이언트는 "클라이언트가 요청한 시안"처럼 고객사의 업무 요청일 수 있어 더 좁게 본다.
 * 문장 어딘가에 서버 · 네트워크 낱말이 있는지(문장 전체 AND)는 보지 않는다("클라이언트가 요청한 명함에 서버 이름을 표시한다").
 * 클라이언트가 서버에 요청하는 문장은 서버 쪽 관계(networkCommunication)로 잡힌다.
 */
const clientCommunication = new RegExp(
  [
    // 클라이언트가 요청한다: 통신 동작이 구절을 끝맺는다
    `${CLIENT}(?:이|가|에서)\\s+${COMM_VERB}${CLAUSE_END}`,
    // 클라이언트가 요청하면 서버가 · 클라이언트에서 요청한 값을 서버가: 클라이언트의 요청을 바로 다음 구절의 서버가 받아 처리한다.
    // 서버에 주체 조사가 붙어야 한다("서버 이름" · "서버 담당자"처럼 다른 명사를 꾸미면 아니다). 관형절은 업무 요청과 헷갈려 "클라이언트에서"에만 쓴다.
    `${CLIENT}(?:이|가|에서)\\s+(?:요청|전송|호출)(?:하면|되면|한\\s+뒤|한\\s+후|할\\s+때),?\\s+${NETWORK}(?:이|가|은|는|에서)${WORD_END}`,
    `${CLIENT}에서\\s+(?:요청|전송|호출)한\\s+[가-힣A-Za-z0-9]+(?:을|를|은|는|이|가)\\s+${NETWORK}(?:이|가|은|는|에서)${WORD_END}`,
  ].join('|'),
);

/**
 * 기술 응답의 상태 코드: "서버 응답 상태 코드" · "서버 응답의 상태 코드", 또는 구절 맨 앞의 "응답 상태 코드"가 HTTP 상태 값(100~599)과 비교될 때.
 * "설문 응답 상태 코드"처럼 업무 명사가 응답을 꾸미거나 값이 업무 값(DONE · READY)이면 아니다.
 */
const apiStatusCode = new RegExp(`${NETWORK}\\s*응답(?:의)?\\s*상태\\s*코드|(?:^|[,.;:!?·]\\s*)응답(?:의)?\\s*상태\\s*코드(?:가|는|이)?\\s*[1-5]\\d\\d(?!\\d)`);

/** 실패 뒤 다시 하는 동작: 실패 시 · 실패하면 · 실패한 경우 · 실패 후 + 다시 · 재 */
const RETRY_AFTER_FAILURE = '\\s*(?:이|가|에)?\\s*실패(?:\\s*시|하면|한\\s*경우|할\\s*때|\\s*후)?,?\\s+(?:다시\\s*|재)';
/**
 * 실패한 통신을 다시 하는 관계: "요청 실패 시 다시 호출한다" · "호출 실패 시 다시 요청한다" · "호출에 실패하면 재요청한다".
 * 요청 · 호출이 구절 맨 앞에 있어야 하고(앞에 업무 명사가 꾸미는 "휴가 요청 실패"는 아니다) 둘 중 하나는 호출이어야 한다("요청 실패 시 다시 요청한다"는 업무 요청일 수 있다).
 */
const apiRetry = new RegExp(`(?:^|[,.;:!?·]\\s*)(?:호출${RETRY_AFTER_FAILURE}(?:호출|요청|전송)|요청${RETRY_AFTER_FAILURE}호출)(?:하|한|합|해|했|된|됩)`);

/** 통신 관계 */
const apiCommunication = (text: string) => networkCommunication.test(text) || clientCommunication.test(text) || apiStatusCode.test(text) || apiRetry.test(text);

const clues: Partial<Record<TestPerspective, Clue>> = {
  // 숫자만으로는 부족하다(연도 · 버전 · 번호). 한계를 뜻하는 말이 있거나 숫자 바로 뒤에 이상 · 이하 · 초과 · 미만 · 이내가 와야 한다.
  boundary: /최소|최대|\d[\d,.]*\s*[가-힣A-Za-z%]{0,3}\s*(?:이상|이하|초과|미만|이내)|길이|자리|범위|\d+\s*개\s*까지|\d+\s*[~∼]\s*\d+/,
  permission: (text) => permissionExplicit.test(text) || permissionRelation.test(text),
  // "변경" · "종료"처럼 일반적인 말은 뺐다. 상태가 이어지거나 바뀌는 것을 뜻하는 표현만 쓴다.
  state_change: /유지|전환|재실행|재시작|재접속|재진입|복원|만료|상태\s*(?:변화|변경)|상태가\s*바뀌|종료\s*(?:후|했다가|한\s*뒤)/,
  // "입력" · "수정" · "보냄"은 뺐다. 데이터를 저장 · 조회 · 주고받는 것을 뜻하는 표현만 쓴다.
  data_io: /저장|조회|불러오|업로드|다운로드|내보내기|가져오기|등록|삭제|전송|데이터|반영되/,
  api: (text) => apiExplicit.test(text) || apiTechnical.test(text) || apiCommunication(text),
  // 숫자만으로는 부족하다. 성능 · 시간 · 처리량을 뜻하는 표현이 있어야 한다.
  performance: /성능|지연|latency|throughput|\btps\b|동시\s*(?:사용자|접속)|\d+\s*(?:ms|밀리초|초)\s*(?:이내|이하|안에|미만)|(?:응답|처리|로딩)\s*시간/i,
};

const hasClue = (clue: Clue, text: string) => (typeof clue === 'function' ? clue(text) : clue.test(text));

/** 경계값 단서 중 숫자가 붙은 표현(예: 8자). 단계에 그대로 옮겨 적는다. */
const numericClues = (text: string) => [...new Set(clean(text).match(/\d+(?:[.,]\d+)?\s?[가-힣A-Za-z%]*/g) ?? [])].map((value) => value.trim());

const generationTypeOf = (requirements: Requirement[]): TestCaseGenerationType => {
  // 확인 필요 표시는 근거 유형보다 우선한다. 사용자가 불명확하다고 표시한 요구사항으로 검토 가능한 TC를 만들지 않는다.
  if (requirements.some((item) => item.needsConfirmation || item.sourceType === 'needs_confirmation')) return 'needs_confirmation';
  if (requirements.some((item) => item.sourceType === 'ai_suggestion')) return 'ai_suggestion';
  return 'source_explicit';
};

interface Draft {
  conditionTitle: string;
  title: string;
  steps: string[];
  expected: string;
}

const platformName: Record<Project['platforms'][number], string> = { android: 'Android', ios: 'iOS', web: 'Web', desktop: 'Desktop' };

/** 관점별 일반 초안. 요구사항 문장만 인용하고 문구 · 값 · 절차를 새로 지어내지 않는다. */
function draftFor(perspective: TestPerspective, requirement: Requirement, project: TestDraftContext['project']): Draft | { skip: string } {
  const text = sentence(requirement);
  const label = testPerspectiveLabel[perspective];
  const pending = generationTypeOf([requirement]) === 'needs_confirmation';
  const expect = (behavior: string) => (pending ? `확인 필요 — 요구사항 확정 후 기대 결과를 정해요. (${text})` : `${behavior} (${text})`);
  const base = { conditionTitle: `${label} · ${text}`, title: `${text} · ${label} 확인` };
  const clue = clues[perspective];
  if (clue && !hasClue(clue, requirement.text)) return { skip: `요구사항에 ${label} 단서가 없어 만들지 않았어요.` };

  switch (perspective) {
    case 'normal_flow':
      return { ...base, steps: ['요구사항과 관련된 기능 화면으로 이동한다.', '요구사항에 적힌 조건으로 동작을 수행한다.', '결과를 확인한다.'], expected: expect('요구사항대로 동작한다.') };
    case 'exception':
      return {
        ...base,
        steps: ['요구사항의 정상 조건을 벗어나는 입력이나 상황을 만든다.', '동작을 수행한다.', '요구사항에 정의된 예외 처리 결과를 확인한다.'],
        expected: expect('요구사항에 정의된 예외 처리가 수행된다.'),
      };
    case 'boundary': {
      const values = numericClues(requirement.text);
      return {
        ...base,
        steps: [
          values.length > 0 ? `요구사항에 적힌 기준값(${values.join(', ')})을 확인한다.` : '요구사항에 적힌 기준값을 확인한다.',
          '기준값 안쪽과 바깥쪽 값으로 각각 동작을 수행한다.',
          '경계에서 결과가 달라지는지 확인한다.',
        ],
        expected: expect('기준값 경계에서 요구사항대로 동작한다.'),
      };
    }
    case 'permission':
      return { ...base, steps: ['요구사항에 적힌 권한 조건을 확인한다.', '권한이 있는 경우와 없는 경우 각각 동작을 수행한다.', '결과를 확인한다.'], expected: expect('권한에 따라 요구사항대로 동작한다.') };
    case 'state_change':
      return { ...base, steps: ['요구사항과 관련된 상태를 만든다.', '요구사항에 적힌 상태 변화 동작을 수행한다.', '변화 뒤 상태를 확인한다.'], expected: expect('상태 변화가 요구사항대로 반영된다.') };
    case 'data_io':
      return {
        ...base,
        steps: ['요구사항과 관련된 데이터를 입력하거나 조회한다.', '동작을 수행한다.', '데이터가 요구사항대로 저장 · 반영 · 표시되는지 확인한다.'],
        expected: expect('데이터가 요구사항대로 처리된다.'),
      };
    case 'api':
      return { ...base, steps: ['요구사항에 적힌 요청을 보낸다.', '응답이 요구사항대로인지 확인한다.'], expected: expect('요청에 요구사항대로 응답한다.') };
    case 'performance':
      return { ...base, steps: ['요구사항에 적힌 성능 기준을 확인한다.', '같은 조건에서 동작을 수행하며 측정한다.', '측정 결과를 요구사항 기준과 비교한다.'], expected: expect('성능이 요구사항 기준을 만족한다.') };
    case 'compatibility': {
      if (project.platforms.length === 0) return { skip: '프로젝트에 플랫폼이 없어 만들지 않았어요.' };
      return {
        ...base,
        steps: [...project.platforms.map((platform) => `${platformName[platform]}에서 요구사항과 관련된 동작을 수행한다.`), '플랫폼별 결과를 비교한다.'],
        expected: expect('모든 대상 플랫폼에서 요구사항대로 동작한다.'),
      };
    }
  }
}

export interface SkippedTestDraft {
  requirementId: string;
  perspective: TestPerspective;
  reason: string;
}

export interface RuleBasedTestDrafts {
  candidates: TestDraftCandidate[];
  skipped: SkippedTestDraft[];
}

/** 규칙 기반 후보 생산자. 같은 입력이면 같은 후보를 같은 순서(요구사항 순서 → 관점 순서)로 만든다. */
export function produceRuleBasedTestDrafts(context: TestDraftContext, request: TestDraftRequest): RuleBasedTestDrafts {
  const requirements = validateRequest(context, request);
  const candidates: TestDraftCandidate[] = [];
  const skipped: SkippedTestDraft[] = [];
  for (const requirement of requirements) {
    for (const perspective of request.perspectives) {
      const draft = draftFor(perspective, requirement, context.project);
      if ('skip' in draft) {
        skipped.push({ requirementId: requirement.id, perspective, reason: draft.skip });
        continue;
      }
      candidates.push({
        key: testDraftCandidateKey(perspective, [requirement.id]),
        perspective,
        requirementIds: [requirement.id],
        generationType: generationTypeOf([requirement]),
        condition: { feature: requirement.feature, title: draft.conditionTitle },
        testCase: { feature: requirement.feature, depth: [requirement.feature, testPerspectiveLabel[perspective]], title: draft.title, steps: draft.steps, expectedResult: draft.expected },
      });
    }
  }
  return { candidates, skipped };
}

/* ---------- 분석 ---------- */

/** create: 새 TC 초안으로 만들 수 있음 / duplicate: 같은 내용의 TC가 이미 있거나 앞선 후보와 같음(사용자가 판단) / invalid: 만들 수 없는 후보 */
export type TestDraftKind = 'create' | 'duplicate' | 'invalid';

export const testDraftKindOrder: TestDraftKind[] = ['create', 'duplicate', 'invalid'];

/**
 * 후보마다 사용자가 내리는 판단. 저장하지 않는 미리보기 · 저장 입력용 값이다.
 * create: 새 TC로 만듦 / link_existing: 같은 내용의 기존(또는 앞선) TC에 요구사항 · 조건 · 근거 연결만 더함 /
 * create_separate: 중복이어도 별도 새 TC로 만듦 / excluded: 아무것도 하지 않음 / pending: 아직 판단하지 않음(저장할 수 없다).
 */
export type TestDraftDecision = 'create' | 'link_existing' | 'create_separate' | 'excluded' | 'pending';

/**
 * 중복의 비교 대상. existing은 이미 있는 TC(linked: 이 후보의 요구사항이 이미 그 TC에 연결됨 · needsConfirmation: 그 TC가 확인 필요 TC임), batch는 이번에 만드는 앞선 후보다.
 */
export type TestDraftDuplicateTarget = { type: 'existing'; id: string; label: string; linked: boolean; needsConfirmation: boolean; snapshot: string } | { type: 'batch'; key: string };

/** 확인 필요 후보를 확인 필요가 아닌 기존 TC에 연결하면 기존 TC의 뜻(근거 유형 · 검토 가능 여부)이 조용히 바뀌므로 연결하지 않는다. */
const linkWouldWeakenConfirmation = (row: Pick<AnalyzedTestDraft, 'needsConfirmation' | 'duplicateTarget'>) =>
  row.needsConfirmation && row.duplicateTarget?.type === 'existing' && !row.duplicateTarget.needsConfirmation;

export interface AnalyzedTestDraft {
  candidate: TestDraftCandidate;
  kind: TestDraftKind;
  reasons: string[];
  /** 확인 필요 요구사항에서 온 후보(검토 완료로 표시할 수 없다) */
  needsConfirmation: boolean;
  /** create에서 이미 있는 같은 테스트 조건을 다시 쓰면 그 ID */
  reusedConditionId?: string;
  duplicateTarget?: TestDraftDuplicateTarget;
  /** 연결 요구사항의 근거를 합친 것(산출물 + 위치 기준 중복 없음) */
  sourceRefs: SourceRef[];
  /** 사용자가 본 후보 · 판정 · 비교 대상을 나타내는 값. 저장할 때 현재 데이터로 다시 계산해 같을 때만 반영한다. */
  fingerprint: string;
}

export interface TestDraftAnalysis {
  rows: AnalyzedTestDraft[];
  skipped: SkippedTestDraft[];
  /** 요청한 요구사항 수 · 관점 수 */
  requirementCount: number;
  perspectiveCount: number;
}

const conditionIdentity = (requirementIds: string[], feature: string, title: string) => `${normalizeIds(requirementIds).join(',')}\u0000${clean(feature)}\u0000${clean(title)}`;
const testCaseIdentity = (category: string, feature: string, title: string, steps: string[], expected: string) =>
  [category, clean(feature), clean(title), steps.map(clean).join('\u0001'), clean(expected)].join('\u0000');

/** 결정적인 문자열 해시(cyrb53). 난수 · 시간 · 브라우저 암호 API 없이 같은 입력이면 항상 같은 값이다. */
function hash53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/**
 * 비교 대상 기존 TC에서 판단의 의미에 영향을 주는 값의 지문. 설계 내용(구분 · 기능 · Depth · 제목 · 사전 조건 · 절차 · 기대 결과) · 연결(요구사항 · 조건 · 근거) ·
 * 출처(근거 유형 · origin · 양식 · 고객사 ID · 중복 표시) · 상태 · revision을 모두 담는다. 생성 · 수정 시각과 가져오기 위치처럼 판단과 무관한 운영 값만 뺀다.
 * revision만으로는 모든 변경이 잡힌다는 보장이 없어(상태 변경은 revision을 올리지 않는다) 내용을 함께 담는다.
 */
function testCaseSnapshot(testCase: TestCase): string {
  return hash53(
    JSON.stringify([
      testCase.id,
      testCase.revision,
      testCase.status,
      testCase.category,
      testCase.feature,
      testCase.depth,
      testCase.title,
      testCase.precondition ?? null,
      testCase.steps,
      testCase.expectedResult,
      testCase.generationType,
      testCase.origin,
      testCase.templateId ?? null,
      testCase.externalId ?? null,
      testCase.duplicateOf ?? null,
      testCase.requirementIds,
      testCase.testConditionIds,
      testCase.sourceRefs.map((ref) => [ref.deliverableId, ref.locator]),
    ]),
  );
}

/**
 * 후보의 근거 요구사항이 지금 뜻하는 것. 후보 내용 · 확인 필요 여부 · 근거에 영향을 주는 값(프로젝트 · 기능 · 문장 · 근거 유형 · 확인 필요 · 수명 · 근거 위치)만 담는다.
 * 검토 상태(draft 등)는 생성에 쓰지 않아 뺀다. 문장 · 기능은 공백 · 유니코드 정규화만 무시하고, 근거 위치는 중복을 없애 정렬해 순서만 바뀐 것은 같다고 본다.
 * 찾을 수 없는 요구사항은 ID와 null로 남긴다(그 후보는 오류다).
 */
function requirementsSnapshot(requirementIds: string[], requirementById: ReadonlyMap<string, Requirement>): unknown {
  return requirementIds.map((id) => {
    const requirement = requirementById.get(id);
    if (!requirement) return [id, null];
    const refs = [...new Set(requirement.sourceRefs.map((ref) => JSON.stringify([ref.deliverableId, ref.locator])))].sort();
    return [id, requirement.projectId, clean(requirement.feature), clean(requirement.text), requirement.sourceType, requirement.needsConfirmation, requirement.lifecycle, refs];
  });
}

/**
 * 저장 결과를 정하는 모든 값을 담은 지문. 필드 순서가 고정된 배열을 직렬화해 안정적이다.
 * 후보 내용 · 근거 · 판정 · 비교 대상 외에 새 TC에 붙을 양식(templateId)과 테스트 조건을 다시 쓰는지(재사용 ID · 상태)도 담는다.
 * 후보가 기대는 근거 요구사항의 현재 의미(requirementsSnapshot)도 담는다. 외부(AI 등) 생산자가 같은 후보를 그대로 다시 보내도, 요구사항이 바뀌었으면 오래된 미리보기다.
 * 이 값이 하나라도 달라지면 사용자가 본 미리보기와 저장될 결과가 다르다.
 */
function fingerprintOf(
  row: Omit<AnalyzedTestDraft, 'fingerprint'>,
  targetState: unknown,
  save: { templateId: string | null; reusedConditionStatus: string | null; requirements: unknown },
): string {
  const { candidate: c } = row;
  return hash53(
    JSON.stringify([
      'v3',
      save.requirements,
      c.key,
      c.perspective,
      c.requirementIds,
      c.generationType,
      c.condition.feature,
      c.condition.title,
      c.testCase.feature,
      c.testCase.depth,
      c.testCase.title,
      c.testCase.precondition ?? null,
      c.testCase.steps,
      c.testCase.expectedResult,
      // 근거는 집합이다. 요구사항의 근거 순서만 바뀐 것은 같은 미리보기로 본다.
      row.sourceRefs.map((ref) => JSON.stringify([ref.deliverableId, ref.locator])).sort(),
      row.kind,
      row.reasons,
      row.needsConfirmation,
      save.templateId,
      row.reusedConditionId ?? null,
      save.reusedConditionStatus,
      targetState,
    ]),
  );
}

/** 근거 유형의 신뢰 순서. 클수록 검토가 더 필요하다. 기존 TC 가져오기는 출처를 나타낼 뿐이라 산출물 직접 근거와 같게 본다. */
const generationTypeRank: Record<TestCaseGenerationType, number> = { source_explicit: 0, imported_existing: 0, ai_suggestion: 1, needs_confirmation: 2 };

/**
 * 후보의 근거 유형을 연결 요구사항(저장된 원본) 기준으로 다시 정한다. 생산자(규칙 · AI)가 보낸 값은 믿지 않는다.
 * 요구사항 쪽이 더 검토가 필요하면 그 값으로 올리고, 생산자가 더 조심스럽게 보낸 값(예: 확인 필요)은 낮추지 않는다.
 * 확인 필요로 올라간 후보의 기대 결과가 확인 필요를 말하지 않으면 앞에 붙여, 확정된 기대 결과처럼 보이지 않게 한다.
 */
function withCanonicalGenerationType(candidate: TestDraftCandidate, requirements: Requirement[]): TestDraftCandidate {
  const canonical = generationTypeOf(requirements);
  if (generationTypeRank[canonical] <= generationTypeRank[candidate.generationType]) return candidate;
  if (canonical !== 'needs_confirmation' || candidate.testCase.expectedResult.startsWith('확인 필요')) return { ...candidate, generationType: canonical };
  return { ...candidate, generationType: canonical, testCase: { ...candidate.testCase, expectedResult: `확인 필요 — ${candidate.testCase.expectedResult}` } };
}

/**
 * 후보를 판정한다. 후보가 어디서 왔든 같은 규칙이다.
 * 근거 유형은 생산자가 보낸 값이 아니라 연결 요구사항 기준으로 다시 정한다(withCanonicalGenerationType). 확인 필요 요구사항의 후보는 항상 확인 필요다.
 * - 같은 프로젝트의 요구사항이 아니거나 제거된 요구사항이거나 근거 산출물이 이 프로젝트에 없으면 오류(invalid)다.
 * - 구분 · 기능 · 제목 · 절차 · 기대 결과가 정확히 같은(공백 · 유니코드 정규화만 무시) 기존 TC(폐기 제외)나 앞선 후보가 있으면 중복이다. 비슷한 것은 같다고 보지 않는다.
 *   중복은 자동으로 버리지 않고 사용자가 판단한다. 비교 대상(기존 TC 또는 앞선 후보)과, 기존 TC에 이 후보의 요구사항이 이미 연결돼 있는지를 함께 돌려준다.
 * - 같은 프로젝트 · 같은 요구사항 집합 · 같은 기능 · 같은 제목의 테스트 조건이 이미 있으면(폐기 제외) 새로 만들지 않고 다시 쓴다.
 *   이 판정은 신규 · 중복 · 오류 어느 후보에서나 같이 하고(TC 중복 판정과는 별개다) 지문에 들어간다.
 * 양식(템플릿)을 쓸 수 없으면 후보를 판정하기 전에 던진다. 입력 후보는 바꾸지 않고 요구사항 ID는 중복을 없애 정렬한 복사본으로 판정한다.
 */
export function analyzeTestDraftCandidates(
  context: TestDraftContext,
  candidates: TestDraftCandidate[],
  skipped: SkippedTestDraft[],
  counts: { requirementCount: number; perspectiveCount: number },
): TestDraftAnalysis {
  validateDraftTemplate(context);
  const templateId = context.project.tcTemplateId ?? null;
  const requirementById = new Map(context.requirements.filter((item) => item.projectId === context.project.id).map((item) => [item.id, item]));
  const deliverableIds = new Set(context.deliverables.filter((item) => item.projectId === context.project.id).map((item) => item.id));
  const existingTestCases = new Map<string, TestCase>();
  for (const testCase of context.testCases) {
    if (testCase.projectId !== context.project.id || testCase.status === 'deprecated') continue;
    const identity = testCaseIdentity(testCase.category, testCase.feature, testCase.title, testCase.steps, testCase.expectedResult);
    if (!existingTestCases.has(identity)) existingTestCases.set(identity, testCase);
  }
  const existingConditions = new Map<string, TestCondition>();
  for (const condition of context.testConditions) {
    if (condition.projectId !== context.project.id || condition.status === 'deprecated') continue;
    const identity = conditionIdentity(condition.requirementIds, condition.feature, condition.title);
    if (!existingConditions.has(identity)) existingConditions.set(identity, condition);
  }

  const seenKeys = new Set<string>();
  const firstKeyByIdentity = new Map<string, string>();
  const fingerprintByKey = new Map<string, string>();
  const rows = candidates.map((input): AnalyzedTestDraft => {
    const requirementIds = normalizeIds(input.requirementIds);
    const linked = requirementIds.map((id) => requirementById.get(id));
    const candidate = withCanonicalGenerationType({ ...input, requirementIds }, linked.filter((item): item is Requirement => !!item));
    if (seenKeys.has(candidate.key)) throw new TestDraftGenerationError(`같은 후보가 두 번 있어요. (${candidate.key})`);
    seenKeys.add(candidate.key);
    const needsConfirmation = candidate.generationType === 'needs_confirmation';
    // 테스트 조건을 다시 쓰는지는 TC 판정과 별개로 어느 후보에서나 정한다.
    const reused = existingConditions.get(conditionIdentity(candidate.requirementIds, candidate.condition.feature, candidate.condition.title));
    const condition = { ...(reused && { reusedConditionId: reused.id }) };
    const save = { templateId, reusedConditionStatus: reused?.status ?? null, requirements: requirementsSnapshot(candidate.requirementIds, requirementById) };
    const reasons: string[] = [];
    if (candidate.requirementIds.length === 0) reasons.push('근거 요구사항이 없어요.');
    linked.forEach((requirement, index) => {
      if (!requirement) reasons.push(`이 프로젝트에서 요구사항을 찾을 수 없어요. (${candidate.requirementIds[index]})`);
      else if (requirement.lifecycle === 'removed') reasons.push(`제거된 요구사항이에요. (${requirement.id})`);
    });
    const requirements = linked.filter((item): item is Requirement => !!item);
    const sourceRefs: SourceRef[] = [];
    const seenRefs = new Set<string>();
    for (const requirement of requirements) {
      for (const ref of requirement.sourceRefs) {
        if (!deliverableIds.has(ref.deliverableId)) {
          reasons.push(`근거 산출물을 찾을 수 없어요. (${ref.deliverableId})`);
          continue;
        }
        const refIdentity = `${ref.deliverableId}\u0000${ref.locator}`;
        if (seenRefs.has(refIdentity)) continue;
        seenRefs.add(refIdentity);
        sourceRefs.push({ deliverableId: ref.deliverableId, locator: ref.locator });
      }
    }
    if (reasons.length > 0) {
      const row = { candidate, kind: 'invalid' as const, reasons: [...new Set(reasons)], needsConfirmation, ...condition, sourceRefs: [] };
      return { ...row, fingerprint: fingerprintOf(row, null, save) };
    }

    const identity = testCaseIdentity(candidate.perspective, candidate.testCase.feature, candidate.testCase.title, candidate.testCase.steps, candidate.testCase.expectedResult);
    const existing = existingTestCases.get(identity);
    if (existing) {
      const alreadyLinked = candidate.requirementIds.every((id) => existing.requirementIds.includes(id));
      const snapshot = testCaseSnapshot(existing);
      const targetNeedsConfirmation = existing.generationType === 'needs_confirmation';
      const reasons = [alreadyLinked ? '같은 내용의 TC가 이미 있고 이 요구사항이 연결돼 있어요.' : '같은 내용의 TC가 이미 있어요. 이 요구사항은 그 TC에 연결돼 있지 않아요.'];
      if (needsConfirmation && !targetNeedsConfirmation && !alreadyLinked) reasons.push('확인 필요 요구사항이라 확인 필요가 아닌 기존 TC에는 연결할 수 없어요. 별도 신규로 만들거나 제외해 주세요.');
      const row = {
        candidate,
        kind: 'duplicate' as const,
        reasons,
        needsConfirmation,
        duplicateTarget: { type: 'existing' as const, id: existing.id, label: existing.externalId ?? existing.id, linked: alreadyLinked, needsConfirmation: targetNeedsConfirmation, snapshot },
        ...condition,
        sourceRefs,
      };
      return { ...row, fingerprint: fingerprintOf(row, ['existing', existing.id, alreadyLinked, snapshot], save) };
    }
    const firstKey = firstKeyByIdentity.get(identity);
    if (firstKey !== undefined) {
      const row = {
        candidate,
        kind: 'duplicate' as const,
        reasons: ['이번에 만드는 다른 후보와 같은 내용이에요. 이 요구사항은 그 후보의 TC에 연결되지 않아요.'],
        needsConfirmation,
        duplicateTarget: { type: 'batch' as const, key: firstKey },
        ...condition,
        sourceRefs,
      };
      return { ...row, fingerprint: fingerprintOf(row, ['batch', firstKey, fingerprintByKey.get(firstKey) ?? null], save) };
    }
    firstKeyByIdentity.set(identity, candidate.key);
    const row = { candidate, kind: 'create' as const, reasons: [], needsConfirmation, ...condition, sourceRefs };
    const fingerprint = fingerprintOf(row, null, save);
    fingerprintByKey.set(candidate.key, fingerprint);
    return { ...row, fingerprint };
  });
  return { rows, skipped, ...counts };
}

/** 규칙 기반 생산자 + 분석. 화면 미리보기와 저장소가 같은 함수를 쓴다. */
export function analyzeTestDraftGeneration(context: TestDraftContext, request: TestDraftRequest): TestDraftAnalysis {
  const { candidates, skipped } = produceRuleBasedTestDrafts(context, request);
  return analyzeTestDraftCandidates(context, candidates, skipped, { requirementCount: request.requirementIds.length, perspectiveCount: request.perspectives.length });
}

/* ---------- 판단 ---------- */

/** 판단을 고르지 않았을 때의 값. 중복은 사용자가 정해야 하므로 pending이고, 이미 연결된 중복 · 오류 후보는 할 일이 없어 excluded다. */
export function defaultTestDraftDecision(row: AnalyzedTestDraft): TestDraftDecision {
  if (row.kind === 'create') return 'create';
  if (row.kind === 'duplicate' && !(row.duplicateTarget?.type === 'existing' && row.duplicateTarget.linked)) return 'pending';
  return 'excluded';
}

/**
 * 후보가 고를 수 있는 판단. pending은 고르는 값이 아니라 판단 전 상태라 넣지 않는다.
 * 확인 필요 후보는 확인 필요가 아닌 기존 TC에 연결할 수 없다(별도 신규 · 제외만). 이번에 만드는 앞선 후보에는 연결할 수 있고, 그 새 TC가 확인 필요로 올라간다.
 */
export function testDraftDecisionOptions(row: AnalyzedTestDraft): TestDraftDecision[] {
  if (row.kind === 'create') return ['create', 'excluded'];
  if (row.kind === 'invalid') return [];
  const alreadyLinked = row.duplicateTarget?.type === 'existing' && row.duplicateTarget.linked;
  return alreadyLinked || linkWouldWeakenConfirmation(row) ? ['create_separate', 'excluded'] : ['link_existing', 'create_separate', 'excluded'];
}

/**
 * 사용자가 고른 판단(chosen)을 모든 후보의 유효한 판단으로 바꾼다. 고르지 않았거나 고를 수 없는 값이면 기본값이다.
 * 이번에 만드는 앞선 후보에 연결하기로 했는데 그 후보를 만들지 않게 되면 연결할 곳이 없으므로 다시 pending으로 돌린다.
 */
export function resolveTestDraftDecisions(analysis: TestDraftAnalysis, chosen: Readonly<Record<string, TestDraftDecision>> = {}): Record<string, TestDraftDecision> {
  const resolved: Record<string, TestDraftDecision> = {};
  for (const row of analysis.rows) {
    const value = chosen[row.candidate.key];
    resolved[row.candidate.key] = value !== undefined && testDraftDecisionOptions(row).includes(value) ? value : defaultTestDraftDecision(row);
  }
  for (const row of analysis.rows) {
    const target = row.duplicateTarget;
    if (resolved[row.candidate.key] === 'link_existing' && target?.type === 'batch' && resolved[target.key] !== 'create') resolved[row.candidate.key] = 'pending';
  }
  return resolved;
}

export interface TestDraftSummary {
  requirementCount: number;
  perspectiveCount: number;
  /** 새로 만드는 TC(신규 + 중복이지만 별도 신규) */
  created: number;
  /** created 중 중복이지만 별도 신규로 만드는 것 */
  separate: number;
  /** 같은 내용의 기존 TC에 요구사항을 연결하는 것 */
  linked: number;
  /** 같은 배치의 앞선 후보로 이번에 만드는 새 TC에 요구사항을 연결하는 것(기존 TC가 아니다) */
  linkedToNew: number;
  /** created 중 확인 필요 요구사항에서 온 것 */
  needsConfirmation: number;
  /** 중복 후보 전체 */
  duplicate: number;
  /** 중복 후보 중 아무것도 하지 않는 것(이미 연결됨 · 제외) */
  duplicateSkipped: number;
  /** 아직 판단하지 않은 중복 */
  pending: number;
  invalid: number;
  /** 만들 수 있었지만 사용자가 뺀 신규 후보 */
  excluded: number;
  /** 단서가 없어 후보를 만들지 않은 조합 */
  skipped: number;
}

export function summarizeTestDraftAnalysis(analysis: TestDraftAnalysis, decisions: Readonly<Record<string, TestDraftDecision>> = {}): TestDraftSummary {
  const resolved = resolveTestDraftDecisions(analysis, decisions);
  const rowsWith = (...values: TestDraftDecision[]) => analysis.rows.filter((row) => values.includes(resolved[row.candidate.key]));
  const creating = rowsWith('create', 'create_separate');
  const duplicates = analysis.rows.filter((row) => row.kind === 'duplicate');
  return {
    requirementCount: analysis.requirementCount,
    perspectiveCount: analysis.perspectiveCount,
    created: creating.length,
    separate: rowsWith('create_separate').length,
    linked: rowsWith('link_existing').filter((row) => row.duplicateTarget?.type === 'existing').length,
    linkedToNew: rowsWith('link_existing').filter((row) => row.duplicateTarget?.type === 'batch').length,
    // 확인 필요 후보가 앞선 후보에 연결되면 그 새 TC도 확인 필요가 된다.
    needsConfirmation: creating.filter(
      (row) =>
        row.needsConfirmation ||
        rowsWith('link_existing').some((other) => other.needsConfirmation && other.duplicateTarget?.type === 'batch' && other.duplicateTarget.key === row.candidate.key),
    ).length,
    duplicate: duplicates.length,
    duplicateSkipped: duplicates.filter((row) => resolved[row.candidate.key] === 'excluded').length,
    pending: duplicates.filter((row) => resolved[row.candidate.key] === 'pending').length,
    invalid: analysis.rows.filter((row) => row.kind === 'invalid').length,
    excluded: analysis.rows.filter((row) => row.kind === 'create' && resolved[row.candidate.key] === 'excluded').length,
    skipped: analysis.skipped.length,
  };
}

/* ---------- 저장 계획 ---------- */

/** 저장 입력의 후보 하나. 미리보기에서 본 후보(key · fingerprint)와 사용자의 판단이다. */
export interface TestDraftDecisionInput {
  key: string;
  fingerprint: string;
  decision: TestDraftDecision;
}

/** 분석과 판단으로 저장 입력을 만든다. 모든 후보를 빠짐없이 담는다. */
export function toTestDraftDecisionInputs(analysis: TestDraftAnalysis, decisions: Readonly<Record<string, TestDraftDecision>> = {}): TestDraftDecisionInput[] {
  const resolved = resolveTestDraftDecisions(analysis, decisions);
  return analysis.rows.map((row) => ({ key: row.candidate.key, fingerprint: row.fingerprint, decision: resolved[row.candidate.key] }));
}

export interface TestDraftPlanOptions {
  createId: (prefix: string) => string;
  /** 새로 만들거나 바꾸는 모든 항목의 시각 */
  now: string;
}

export interface TestDraftPlan {
  testConditions: TestCondition[];
  /** 새로 만드는 TC */
  testCases: TestCase[];
  /** 기존 TC에 요구사항 · 조건 · 근거 연결만 더한 결과(내용은 그대로). 연결한 기존 TC만 담긴다. */
  updatedTestCases: TestCase[];
  summary: TestDraftSummary;
  /** 새 테스트 조건 수와 다시 쓴 수 */
  conditionsCreated: number;
  conditionsReused: number;
}

const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
const unionRefs = (a: SourceRef[], b: SourceRef[]): SourceRef[] => {
  const seen = new Set<string>();
  return [...a, ...b].filter((ref) => {
    const identity = `${ref.deliverableId}\u0000${ref.locator}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
};

/**
 * 저장할 항목을 계산한다(저장하지 않는다). 순서: 지문 확인 → 판단 확인 → 양식 확인(분석에서 이미 함) → 계획. 하나라도 어긋나면 아무것도 만들지 않고 던진다.
 * - 입력의 후보는 분석한 후보와 정확히 같아야 한다(빠짐 · 더함 · 두 번 · 지문 불일치는 모두 오래된 미리보기로 거부).
 * - 신규는 create · excluded, 중복은 link_existing · create_separate · excluded만 받고 pending이 하나라도 있으면 거부한다. 이미 연결된 중복은 link_existing을 받지 않는다.
 * - link_existing은 기존 TC의 요구사항 · 테스트 조건 · 근거 연결만 합집합으로 더하고 내용 · 상태 · 출처 · 고객사 ID는 바꾸지 않는다.
 *   연결로 설계 연결이 바뀐 기존 TC는 변경 영향 분석과 같은 규칙(요구사항 · 조건 · 근거는 설계 내용)으로 revision을 1 올리고 updatedAt을 갱신한다.
 *   이번에 만드는 앞선 후보에 연결하면 그 새 TC에 더하며 revision은 그대로(1)다.
 * - 새 TC는 초안 · revision 1이고 고객사 ID를 만들지 않는다. origin은 manual(규칙 기반이며 AI가 아님)이고 근거 유형은 요구사항에서 물려받는다.
 *   같은 배치의 뒤 후보가 연결되면 합쳐진 후보 · 요구사항 중 가장 엄격한 근거 유형으로 올린다(확인 필요 > AI 제안 > 직접 근거).
 * - 확인 필요 요구사항을 확인 필요가 아닌 기존 TC에 새로 연결하는 계획은 거부한다(기존 TC의 근거 유형 · 상태는 바꾸지 않는다).
 * 만들거나 연결할 것이 하나도 없으면 던진다.
 */
export function planTestDraftGeneration(context: TestDraftContext, analysis: TestDraftAnalysis, inputs: readonly TestDraftDecisionInput[], options: TestDraftPlanOptions): TestDraftPlan {
  const rowByKey = new Map(analysis.rows.map((row) => [row.candidate.key, row]));
  const seen = new Set<string>();
  for (const input of inputs) {
    const row = rowByKey.get(input.key);
    if (seen.has(input.key) || !row || row.fingerprint !== input.fingerprint) throw new StaleTestDraftPreviewError(STALE_TEST_DRAFT_PREVIEW_MESSAGE);
    seen.add(input.key);
  }
  if (analysis.rows.some((row) => !seen.has(row.candidate.key))) throw new StaleTestDraftPreviewError(STALE_TEST_DRAFT_PREVIEW_MESSAGE);

  const decisionByKey = new Map(inputs.map((input) => [input.key, input.decision]));
  let pending = 0;
  for (const row of analysis.rows) {
    const decision = decisionByKey.get(row.candidate.key)!;
    if (decision === 'pending' && row.kind === 'duplicate') {
      pending += 1;
      continue;
    }
    if (!testDraftDecisionOptions(row).includes(decision) && !(row.kind === 'invalid' && decision === 'excluded')) {
      throw new TestDraftGenerationError(`이 후보에는 쓸 수 없는 판단이에요. (${row.candidate.key}: ${decision})`);
    }
  }
  if (pending > 0) throw new TestDraftGenerationError(`판단하지 않은 중복이 ${pending}건 있어요.`);

  const newConditions = new Map<string, TestCondition>();
  const testConditions: TestCondition[] = [];
  let conditionsReused = 0;
  const conditionIdFor = (row: AnalyzedTestDraft): string => {
    const identity = conditionIdentity(row.candidate.requirementIds, row.candidate.condition.feature, row.candidate.condition.title);
    // 다시 쓸 조건은 분석에서 모든 후보(신규 · 중복 · 오류)에 대해 이미 정했고 지문에 들어 있다. 여기서 다시 찾지 않는다.
    const reused = row.reusedConditionId;
    if (reused) {
      conditionsReused += 1;
      return reused;
    }
    let condition = newConditions.get(identity);
    if (condition) {
      conditionsReused += 1;
      return condition.id;
    }
    condition = {
      id: options.createId('cond'),
      projectId: context.project.id,
      requirementIds: [...row.candidate.requirementIds],
      feature: row.candidate.condition.feature,
      title: row.candidate.condition.title,
      // 확인 필요 요구사항의 조건은 정리가 끝나지 않았다.
      status: row.needsConfirmation ? 'needs_review' : 'active',
      createdAt: options.now,
      updatedAt: options.now,
    };
    newConditions.set(identity, condition);
    testConditions.push(condition);
    return condition.id;
  };

  const testCases: TestCase[] = [];
  const newByKey = new Map<string, TestCase>();
  for (const row of analysis.rows) {
    const decision = decisionByKey.get(row.candidate.key)!;
    if (decision !== 'create' && decision !== 'create_separate') continue;
    const { candidate } = row;
    const testCase: TestCase = {
      id: options.createId('tc'),
      projectId: context.project.id,
      ...(context.project.tcTemplateId && { templateId: context.project.tcTemplateId }),
      // 고객사 TC ID는 Looma가 만들지 않는다.
      category: candidate.perspective,
      feature: candidate.testCase.feature,
      depth: [...candidate.testCase.depth],
      title: candidate.testCase.title,
      ...(candidate.testCase.precondition && { precondition: candidate.testCase.precondition }),
      steps: [...candidate.testCase.steps],
      expectedResult: candidate.testCase.expectedResult,
      requirementIds: [...candidate.requirementIds],
      testConditionIds: [conditionIdFor(row)],
      sourceRefs: structuredClone(row.sourceRefs),
      generationType: candidate.generationType,
      origin: 'manual',
      status: 'draft',
      revision: 1,
      createdAt: options.now,
      updatedAt: options.now,
    };
    testCases.push(testCase);
    newByKey.set(candidate.key, testCase);
  }

  // 연결: 기존 TC는 연결만 더하고, 이번에 만드는 앞선 후보의 TC에는 그 새 TC에 더한다.
  const existingById = new Map(context.testCases.filter((item) => item.projectId === context.project.id).map((item) => [item.id, item]));
  const linkedExisting = new Map<string, TestCase>();
  for (const row of analysis.rows) {
    if (decisionByKey.get(row.candidate.key) !== 'link_existing') continue;
    const target = row.duplicateTarget!;
    const conditionId = conditionIdFor(row);
    const add = (testCase: TestCase): TestCase => ({
      ...testCase,
      requirementIds: union(testCase.requirementIds, row.candidate.requirementIds),
      testConditionIds: union(testCase.testConditionIds, [conditionId]),
      sourceRefs: unionRefs(testCase.sourceRefs, row.sourceRefs),
    });
    if (target.type === 'batch') {
      const created = newByKey.get(target.key);
      if (!created) throw new TestDraftGenerationError(`연결할 TC가 만들어지지 않아요. 앞선 후보를 제외했는지 확인해 주세요. (${row.candidate.key})`);
      Object.assign(created, add(created));
      continue;
    }
    const existing = existingById.get(target.id);
    // 비교 대상이 미리보기 때와 같은 TC(같은 프로젝트 · 폐기되지 않음 · 같은 내용 · 판단에 영향을 주는 값이 모두 같음)인지 지문과 별개로 다시 확인한다.
    const sameTarget =
      !!existing &&
      existing.status !== 'deprecated' &&
      testCaseIdentity(existing.category, existing.feature, existing.title, existing.steps, existing.expectedResult) ===
        testCaseIdentity(row.candidate.perspective, row.candidate.testCase.feature, row.candidate.testCase.title, row.candidate.testCase.steps, row.candidate.testCase.expectedResult) &&
      testCaseSnapshot(existing) === target.snapshot;
    if (!sameTarget) throw new StaleTestDraftPreviewError(STALE_TEST_DRAFT_PREVIEW_MESSAGE);
    linkedExisting.set(target.id, add(linkedExisting.get(target.id) ?? existing));
  }
  const updatedTestCases: TestCase[] = [];
  for (const [id, merged] of linkedExisting) {
    const original = existingById.get(id)!;
    const changed = ['requirementIds', 'testConditionIds', 'sourceRefs'].some((field) => JSON.stringify(original[field as 'requirementIds']) !== JSON.stringify(merged[field as 'requirementIds']));
    if (changed) updatedTestCases.push({ ...merged, revision: original.revision + 1, updatedAt: options.now });
  }

  // 근거 유형 불변식: 최종 TC에 연결된 요구사항이 확인 필요면 그 TC는 확인 필요다. 화면 판단 · 생산자 값과 별개로 저장 직전에 다시 확인한다.
  const requirementById = new Map(context.requirements.filter((item) => item.projectId === context.project.id).map((item) => [item.id, item]));
  const canonicalTypeOf = (requirementIds: string[]) => generationTypeOf(requirementIds.map((id) => requirementById.get(id)).filter((item): item is Requirement => !!item));
  const stricter = (a: TestCaseGenerationType, b: TestCaseGenerationType) => (generationTypeRank[b] > generationTypeRank[a] ? b : a);
  // 이번에 만드는 TC는 하나로 합쳐진 후보(만든 후보 + 연결한 뒤 후보)와 연결 요구사항 중 가장 엄격한 근거 유형으로 올린다.
  for (const row of analysis.rows) {
    const target = row.duplicateTarget;
    if (decisionByKey.get(row.candidate.key) !== 'link_existing' || target?.type !== 'batch') continue;
    const created = newByKey.get(target.key)!;
    created.generationType = stricter(created.generationType, row.candidate.generationType);
  }
  for (const testCase of testCases) {
    const canonical = canonicalTypeOf(testCase.requirementIds);
    // 확인 필요 요구사항에 이어진 TC의 기대 결과가 확인 필요를 말하지 않으면 확정된 기대 결과처럼 보이므로 만들지 않는다(분석에서 이미 붙였어야 한다).
    if (canonical === 'needs_confirmation' && !testCase.expectedResult.startsWith('확인 필요')) {
      throw new TestDraftGenerationError(`확인 필요 요구사항에 이어진 TC의 기대 결과가 확인 필요를 말하지 않아요. 미리보기를 다시 확인해 주세요. (${testCase.title})`);
    }
    testCase.generationType = stricter(testCase.generationType, canonical);
  }
  // 기존 TC는 뜻을 바꾸지 않는다. 확인 필요가 아닌 기존 TC에 확인 필요 요구사항을 새로 연결하는 계획은 만들지 않는다(fail-closed).
  for (const [id, merged] of linkedExisting) {
    const original = existingById.get(id)!;
    const added = merged.requirementIds.filter((requirementId) => !original.requirementIds.includes(requirementId));
    if (original.generationType !== 'needs_confirmation' && canonicalTypeOf(added) === 'needs_confirmation') {
      throw new TestDraftGenerationError(`확인 필요 요구사항은 확인 필요가 아닌 기존 TC에 연결할 수 없어요. (${original.externalId ?? original.id})`);
    }
  }

  // 새 TC도 연결도 없으면(모두 이미 연결됨 · 제외) 아무것도 저장하지 않는다.
  if (testCases.length === 0 && updatedTestCases.length === 0) throw new TestDraftGenerationError('새로 반영할 TC 초안 또는 연결이 없어요.');
  const decisions = Object.fromEntries(inputs.map((input) => [input.key, input.decision]));
  return { testConditions, testCases, updatedTestCases, summary: summarizeTestDraftAnalysis(analysis, decisions), conditionsCreated: testConditions.length, conditionsReused };
}

/**
 * 활동 기록 · 완료 안내에 쓰는 요약 문구. 기존 TC에 연결한 것과 이번에 만드는 TC에 연결한 것(같은 배치의 중복)은 나눠 센다:
 * 뒤의 것은 아직 저장 전의 새 TC라 "기존 TC"가 아니다.
 */
export const testDraftSummaryText = (plan: Pick<TestDraftPlan, 'summary' | 'conditionsCreated' | 'conditionsReused'>) =>
  `요구사항 ${plan.summary.requirementCount} · 관점 ${plan.summary.perspectiveCount} · 신규 TC ${plan.summary.created}(별도 신규 ${plan.summary.separate}) · 기존 TC 연결 ${plan.summary.linked} · 생성 TC 연결 ${plan.summary.linkedToNew} · 테스트 조건 신규 ${plan.conditionsCreated} · 재사용 ${plan.conditionsReused} · 중복 제외 ${plan.summary.duplicateSkipped} · 제외 ${plan.summary.excluded}`;
