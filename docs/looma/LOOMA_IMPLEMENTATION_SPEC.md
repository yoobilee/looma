# Looma 구현 기준서

## 1. 제품 정의

Looma는 개인 업무 관리와 QA 프로젝트 실무를 연결하는 한국어 전용 개인 업무 도우미 웹앱이다.

핵심 목표:
- 오늘 해야 할 업무와 일정을 빠르게 파악
- 프로젝트별 산출물, 요구사항, TC/TS 설계 흐름 관리
- 임시 자료를 빠르게 저장하고 필요한 위치로 연결
- 실제 수행 결과는 외부 TC/Excel을 기준으로 가져와 요약
- 프로젝트별 업무 용어와 참고 지식을 축적
- AI는 초안/분석을 돕되, 사람 검토 없이 요구사항이나 TC를 확정하지 않음

비목표:
- Jira/Notion 수준의 범용 협업 툴
- Looma 안에서 직접 모든 TC를 수행하는 테스트 실행 도구
- 고객사 보안 정책을 우회하는 파일 이동 기능
- 산출물에 없는 내용을 사실처럼 자동 확정하는 AI

---

## 2. 디자인 기준

### 기본 방향
- Light mode 기본, Dark mode 선택
- 한국어 전용
- 안정적인 현대 웹앱 75% + 선도적인 디자인 포인트 25%
- 동일한 둥근 카드 반복은 피하되 카드/Bento 자체를 금지하지 않음
- 플로팅 사이드바 유지
- 배경은 Sky Blue → Pearl/Lilac → Soft Coral의 하나의 연속적인 ambient field
- 과한 glow, grid, neon cyan/purple AI SaaS 표현 금지

### 핵심 색상
- Primary Sky Blue: #4D8EF7
- Soft Coral: #F28B7B
- Pearl/Lilac Bridge: #FBFAFF
- Ink: #151821
- Muted: #6E7682
- Soft text: #9CA4AE
- Line: #E4E8EF

### Glass 사용
Glass는 다음에 제한:
- Floating sidebar
- Search
- 작은 floating control
- popover / modal control layer

Glass를 사용하지 않는 곳:
- Hero 본문
- 일반 업무 카드
- 프로젝트 본문
- TC table
- 기록/지식 본문

### Motion
- ambient background: 24–36초 단위의 매우 느린 움직임
- 이동폭 1–3%
- prefers-reduced-motion에서는 정지
- hover/transition은 짧고 절제

---

## 3. 정보 구조

사이드바:
1. 오늘
2. 업무
3. 프로젝트
4. 기록
5. 업무 지식
6. 임시함
7. 테마 / 설정

프로젝트 내부 흐름:
1. 산출물
2. 요구사항 분석
3. 테스트 설계
4. 수행 결과
5. 이슈 / 확인사항
6. 기록

주의:
Penpot의 현재 `Test Execution` 화면은 구현 시 `수행 결과`로 변경한다.
Looma 내부에서 TC를 직접 수행하는 방식이 기본이 아니다.

---

## 4. 페이지별 역할

### Today
목적:
하루 종일 켜두는 실행 중심 화면.

표시:
- 현재 진행 중 업무
- 오늘 할 일
- 다음 일정
- 최근 활동
- 임시 작업공간

Google Calendar:
- 1차 구현은 read-only 연결
- Today에는 오늘/다음 일정만 표시
- 일정 클릭 시 원본 Google Calendar 일정으로 이동
- Looma 자체 캘린더를 별도로 만들지 않음
- 이후 필요 시 일정 생성/수정 확장

실용 정보 우선:
- 남은 업무 수
- 다음 일정
- 진행 중 업무
- 임시 자료 수

추상적인 생산성 점수는 우선순위가 낮다.

### Work
목적:
모든 개인 업무의 전체 목록.

기본 생성:
- 제목만 입력하면 생성 가능

선택 필드:
- 날짜/시간
- 프로젝트
- 메모
- 반복

상태:
- 예정
- 진행 중
- 대기
- 완료

필터:
- 오늘
- 이번 주
- 기한 없음
- 프로젝트
- 상태
- 태그

### Projects
목적:
아웃소싱 QA 투입 프로젝트 목록.

카드 정보 예:
- 프로젝트명
- 고객사/서비스
- 상태
- 기간
- 플랫폼
- 테스트 범위
- 산출물 수
- TC 수
- Template 설정 여부
- 현재 진행 단계

### Project QA
프로젝트 작업의 중심 화면.

기본 정보:
- 프로젝트명
- 고객사 / 서비스
- 기간
- 플랫폼
- 테스트 범위
- 상태

테스트 범위 예:
- 기능
- UI/UX
- 회귀
- API
- 성능
- 호환성

API/성능 등은 프로젝트마다 선택적으로 노출한다.

### Deliverables / 산출물
지원 대상:
- PDF
- XLSX
- CSV
- DOCX
- 이미지
- URL
- Figma

역할:
- 산출물 저장
- AI 요구사항 분석 시작점
- 기능/변경 범위 추출
- TC 생성의 근거

Figma:
- 가능한 경우 OAuth/API 기반 연결
- 전체 파일보다 Page/Frame 범위 선택을 우선
- 대안: PDF export 또는 Frame 이미지
- 사용자에게 접근 권한이 있는 자료만 사용

### Requirements Analysis / 요구사항 분석
AI가 먼저 해야 할 일:
- 기능 단위 분리
- 요구사항 추출
- 변경 내용 식별
- 모호하거나 누락된 조건 식별
- 테스트 범위 후보 제시

AI가 하면 안 되는 일:
- 산출물에 없는 정책을 사실처럼 생성
- 모호한 요구사항을 임의로 확정

표시 구분:
- 산출물 직접 명시
- AI 제안
- 확인 필요

### Test Design / 테스트 설계
TC/TS 생성 진입점 3가지:

1. 산출물에서 생성
2. 기존 TC를 기반으로 이어서 설계
3. 프로젝트 설명으로 TC 양식 생성

#### 기존 TC 기반
업로드한 XLSX/CSV에서 감지:
- 컬럼 구조
- ID 규칙
- Depth 구조
- 작성 문체
- 결과 컬럼
- 상태값
- Android/iOS 구분
- 비고/Issue 구조

고객사 Template으로 저장 가능.

옵션:
- 컬럼 구조 유지
- ID 규칙 유지
- Depth 구성 참고
- 기존 TC 문장 스타일 참고
- 중복 검사

#### AI TC 생성
흐름:
산출물 → 기능 분석 → 범위 선택 → TC Draft 생성 → 사람 검토 → 확정

TC마다 반드시:
- 근거 산출물
- 페이지/Frame/셀 등 가능한 출처 위치
- 생성 유형
  - 산출물 직접 근거
  - AI 테스트 관점 제안
  - 확인 필요

초기 테스트 관점:
- 정상 흐름
- 예외
- 경계값
- 권한
- 상태 변화
- 데이터 조회/저장

프로젝트 선택에 따라:
- API
- 성능
- 호환성

AI 출력은 구조화된 JSON Schema를 사용하고 UI 데이터로 변환한다.

### Result Dashboard / 수행 결과
실제 검증은 Excel 등 외부 고객사 양식에서 수행하는 것을 기본으로 한다.

흐름:
Looma TC Draft
→ 고객사 양식 XLSX Export
→ Excel 등에서 수동 수행
→ 수행 완료 파일 Looma Upload
→ 결과 분석/요약

표시:
- 전체 TC
- PASS
- FAIL
- BLOCKED
- N/T 또는 미수행
- 플랫폼별 결과
- 기능별 결과
- 실패/미수행 집중 영역
- 연결 Issue
- 재수행 필요 항목
- 차수별 비교

상태 매핑:
고객사별 상태값 차이를 사용자가 한 번 확인한다.
예:
- P → PASS
- F → FAIL
- N/T → 미수행
- OK → PASS
- NG → FAIL

### Issues & Questions
두 종류를 분리:
- 결함/Issue
- 기획/정책 확인사항

확인사항은 AI 요구사항 분석에서 자동 후보 생성 가능.

각 항목은 연결:
- 프로젝트
- 기능
- TC
- 산출물 근거

### Records
목적:
"내가 언제 무엇을 했는가"를 자동으로 남김.

자동 기록 후보:
- 업무 생성/시작/완료
- 메모 생성
- 임시 자료 고정
- 산출물 추가
- 요구사항 분석
- TC 생성/수정
- 수행 결과 업로드
- Issue 등록
- 프로젝트 변경

일/주 단위 AI 요약은 이후 추가 가능.

프로젝트 내부 기록:
- 해당 프로젝트만 필터된 활동 기록

전역 Records:
- 모든 프로젝트와 개인 업무 기록

### Work Knowledge
Worky의 업무용어/용어집 개념을 Looma에 맞게 확장.

기본 단위:
- 용어
- 쉬운 설명
- 업무에서의 의미
- 예시
- 관련 프로젝트
- 관련 용어
- 태그
- 사용자 메모

AI:
용어 입력 → 설명/예시/관련 키워드 초안 → 사용자 검토 → 저장

AI가 고객사 고유 용어를 임의로 확정하지 않도록 한다.

### Scratch / 임시 작업공간
지원:
- 텍스트
- 이미지
- URL
- 로그
- JSON
- 일반 임시 자료

기본 상태:
- 휘발성
- 만료 시각/남은 시간은 약하게 표시

고정:
- 업무에 연결
- 프로젝트에 연결
- 기록으로 저장
- 업무 지식에 저장

전역에서도 접근 가능하고 Project/Task 맥락에서도 접근 가능.

---

## 5. 핵심 데이터 모델 초안

### User
- id
- locale
- theme
- calendarConnection

### Task
- id
- title
- status
- dueAt
- projectId?
- notes?
- tags[]
- createdAt
- completedAt?

### Project
- id
- name
- clientName?
- serviceName?
- status
- startDate?
- endDate?
- platforms[]
- testScopes[]
- description?
- tcTemplateId?

### Deliverable
- id
- projectId
- type
- title
- sourceUrl?
- fileRef?
- version?
- importedAt
- analyzedAt?

### Requirement
- id
- projectId
- deliverableId
- feature
- text
- sourceLocator
- sourceType
- confidence?
- needsConfirmation
- status

### TCTemplate
- id
- projectId?
- name
- columns[]
- idRule?
- depthRule?
- styleHints?
- resultMappings?

### TestCase
- id
- projectId
- templateId?
- externalId?
- category
- feature
- depth[]
- precondition?
- steps[]
- expectedResult
- sourceRefs[]
- generationType
- reviewStatus
- duplicateOf?
- createdAt
- updatedAt

### TestResultImport
- id
- projectId
- fileRef
- importedAt
- mapping
- summary

### TestResult
- id
- importId
- testCaseId?
- externalId?
- platform?
- result
- issueId?
- note?

### Issue
- id
- projectId
- testCaseId?
- type
- title
- status
- sourceRef?
- note?

### KnowledgeTerm
- id
- term
- explanation
- workMeaning?
- examples[]
- relatedProjectIds[]
- relatedTerms[]
- tags[]
- userNote?
- aiDraftUsed

### ScratchItem
- id
- type
- content
- createdAt
- expiresAt?
- pinnedAt?
- linkedType?
- linkedId?

### Activity
- id
- projectId?
- taskId?
- type
- title
- metadata
- createdAt

---

## 6. AI 동작 원칙

1. AI는 초안을 만든다.
2. AI가 만든 요구사항/TC는 기본 Draft 상태다.
3. 출처가 있으면 반드시 연결한다.
4. 산출물에 직접 없는 내용은 `AI 제안`으로 표시한다.
5. 불명확한 내용은 `확인 필요`로 표시한다.
6. 기존 TC와 유사하면 신규 생성보다 중복/수정 후보를 우선 제안한다.
7. 고객사 Template을 우선한다.
8. 사용자가 검토하지 않은 AI 결과를 자동 확정하지 않는다.

---

## 7. 1차 구현 범위

### 반드시 구현
- App shell / floating sidebar
- Light/Dark theme
- Today
- Work
- Projects
- Project QA
- Deliverable 등록 UI
- Requirements Analysis 기본 구조
- Test Design 기본 구조
- Existing TC Template import UI
- Result Dashboard 구조
- Issues / Questions
- Records
- Work Knowledge
- Scratch
- 기본 검색 UI

### Mock 또는 local data로 먼저 구현 가능
- Google Calendar
- Figma
- AI
- 파일 파싱
- XLSX import/export
- result mapping

UI와 도메인 모델이 안정된 뒤 실제 integration을 붙인다.

---

## 8. 2차 구현 후보

- Google Calendar OAuth + read-only
- Figma OAuth/API
- PDF/DOCX/XLSX parsing
- AI 요구사항 분석
- AI TC 생성
- TC Template 자동 감지
- TC XLSX export
- 수행 결과 XLSX import
- 결과 대시보드
- 업무 지식 AI 보조
- 일/주 기록 AI 요약

---

## 9. 구현 우선순위

1. App shell + design tokens
2. Today / Work / Projects
3. Project QA shell
4. Requirements Analysis
5. Test Design
6. Result Dashboard
7. Issues / Questions
8. Records
9. Work Knowledge
10. Scratch
11. Integrations
12. AI

화면을 먼저 안정시키고, 그 뒤 parsing/integration/AI를 붙인다.

---

## 10. 현재 Penpot 관련 주의사항

현재 Penpot 화면들은 구현 방향을 정하기 위한 visual source다.

- Today: 현재 시안 유지
- Projects: QA 관점으로 개편된 배치팩 기준
- Project QA 이후: 배치팩 기준
- Test Execution: 구현 시 `수행 결과` Dashboard로 변경
- 실제 CSS glass / shadow / ambient motion은 Penpot보다 HTML 구현을 우선
- Penpot의 정적 한계를 이유로 구현까지 단순화하지 않는다.
