# Claude Code 시작 프롬프트 — Looma

현재 저장소의 기존 starter pack, 프로젝트 규칙, design skill, coding convention을 먼저 읽고 그 규칙을 최우선으로 따르세요.

이번 작업은 한국어 전용 개인 업무 도우미 웹앱 `Looma`의 초기 구현입니다.

## 먼저 읽을 자료

1. 저장소 내부 starter pack / project-init / design 관련 규칙
2. `LOOMA_IMPLEMENTATION_SPEC.md`
3. Penpot에서 확정한 Looma 화면
   - Today / Desktop
   - Work / Desktop
   - Projects / Desktop
   - Project QA / Desktop
   - Requirements Analysis / Desktop
   - Test Design / Desktop
   - Test Execution / Desktop
   - Issues & Questions / Desktop
   - Records / Desktop
   - Work Knowledge / Desktop

Penpot은 정적 visual source다.
실제 glass, ambient background, hover, transition은 브라우저 구현에서 더 자연스럽게 표현한다.

## 중요한 변경사항

Penpot의 `Test Execution` 화면을 그대로 구현하지 마세요.

실제 사용 방식:
- TC 수행은 주로 고객사 Excel/기존 양식에서 수동으로 진행
- 수행 완료 파일을 Looma에 다시 업로드
- Looma는 결과를 요약하고 분석

따라서 구현 명칭과 역할은:
`Test Execution` → `수행 결과 / Result Dashboard`

초기에는 mock data로 결과 대시보드 UI만 구현해도 됩니다.

## 제품 핵심 흐름

프로젝트:
산출물
→ 요구사항 분석
→ 테스트 설계
→ 수행 결과
→ 이슈 / 확인사항
→ 기록

산출물 후보:
PDF / XLSX / CSV / DOCX / 이미지 / URL / Figma

TC 설계 진입점:
1. 산출물 기반 생성
2. 기존 TC 기반 설계
3. 프로젝트 설명 기반 TC Template 생성

AI는 초안만 만들고 자동 확정하지 않습니다.

## 디자인

- Light mode 기본
- Dark mode 토글
- 한국어 전용
- Sky Blue `#4D8EF7`
- Soft Coral `#F28B7B`
- Pearl/Lilac `#FBFAFF`
- Ink `#151821`
- Line `#E4E8EF`
- 플로팅 사이드바
- glass는 sidebar/search/popover 위주
- 메인 카드에는 glass 남용 금지
- 하나의 은은한 Sky Blue → Pearl/Lilac → Soft Coral ambient field
- 과한 cyan/purple AI SaaS, grid, glow 금지
- 동일한 둥근 카드가 모든 요소를 차지하지 않도록 시각적 리듬 유지

## 이번 작업 범위

아직 실제 AI, Google Calendar, Figma API, 파일 parsing까지 연결하지 마세요.
먼저 app shell과 UI 구조를 안정화합니다.

### 구현 순서

1. 기존 저장소 구조 분석
2. 현재 starter pack 규칙에 맞는 feature/component 구조 제안
3. design token 정리
4. app shell + floating sidebar
5. routing
6. Today
7. Work
8. Projects
9. Project QA
10. Requirements Analysis
11. Test Design
12. Result Dashboard
13. Issues / Questions
14. Records
15. Work Knowledge
16. Scratch
17. mock data / mock domain models 연결
18. responsive / dark mode / reduced motion

## 데이터 구조

`LOOMA_IMPLEMENTATION_SPEC.md`의 데이터 모델을 참고하되,
현재 저장소 기술 스택과 기존 규칙에 맞게 타입을 정리하세요.

초기 구현에서는 mock repository/data layer를 사용하고,
나중에 실제 backend / integration으로 교체하기 쉽도록 UI와 data access를 분리하세요.

## 작업 방식

- 한 번에 모든 코드를 무작정 작성하지 말고 먼저 저장소를 분석하세요.
- 기존 starter pack에 정의된 구조가 있다면 새 구조를 임의로 만들지 마세요.
- 이미 있는 공통 component/token을 우선 재사용하세요.
- 큰 변경 전에는 계획과 대상 파일을 간단히 정리하세요.
- 구현 과정에서 Penpot과 spec이 충돌하면 spec의 기능 정의를 우선하고, 시각적 방향은 Penpot을 우선하세요.
- TC/QA 도메인 용어를 일반 Todo 앱 용어로 임의 치환하지 마세요.
- 영어 UI 텍스트를 추가하지 마세요.
- 임시 작업공간은 부가 위젯이 아니라 Looma의 핵심 기능으로 취급하세요.

## 완료 기준

초기 UI 구현이 끝났을 때:
- 모든 주요 route 접근 가능
- Light/Dark mode 동작
- floating sidebar 유지
- mock data로 실제 사용 흐름 확인 가능
- Project QA 내부 흐름 연결
- Result Dashboard가 직접 TC 수행 UI로 구현되지 않음
- responsive에서 정보 위계 유지
- prefers-reduced-motion 지원
- build / lint / existing test 통과

먼저 저장소를 분석하고, 구현 계획과 파일 구조를 제안한 뒤 작업을 시작하세요.
