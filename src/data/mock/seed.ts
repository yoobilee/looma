import type {
  Activity,
  CalendarEvent,
  Deliverable,
  Issue,
  KnowledgeTerm,
  Project,
  Requirement,
  ScratchItem,
  Task,
  TCTemplate,
  TestCase,
  TestResult,
  TestResultImport,
  TestResultValue,
} from '@/domain/types';

// 화면 확인용 예시 데이터. 실제 고객사·서비스 정보가 아니다.
// 날짜는 앱을 연 시점 기준으로 계산해 "오늘" 화면이 항상 의미 있게 보이도록 한다.

function at(dayOffset: number, hour: number, minute = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

export const PROJECT_A = 'proj-client-a-mobile';
export const PROJECT_B = 'proj-client-b-admin';
export const PROJECT_C = 'proj-internal-tools';

export function createSeed() {
  // 이미 일어난 오늘 활동은 고정 시각(at) 대신 상대 시각으로 만든다.
  // 고정 시각은 이른 아침(예: UTC 기준 CI)에 현재보다 미래가 되어 최근 활동 순서를 깨뜨린다.
  const memoCreatedAt = minutesAgo(144);
  const accessCompletedAt = minutesAgo(96);
  const envPinnedAt = minutesAgo(60);

  const projects: Project[] = [
    {
      id: PROJECT_A,
      name: '고객사 A 모바일 서비스 개편 QA',
      clientName: '고객사 A',
      serviceName: '모바일 앱',
      status: 'active',
      startDate: at(0, 0),
      endDate: at(19, 0),
      platforms: ['android', 'ios'],
      testScopes: ['functional', 'ui_ux', 'regression'],
      description: '산출물 기반으로 TC/TS를 설계하고, 변경 범위를 추적하는 프로젝트',
      tcTemplateId: 'tpl-client-a',
      currentStage: 'test_design',
    },
    {
      id: PROJECT_B,
      name: '고객사 B 관리자 Web QA',
      clientName: '고객사 B',
      serviceName: '관리자 웹',
      status: 'preparing',
      startDate: at(7, 0),
      endDate: at(28, 0),
      platforms: ['web'],
      testScopes: ['functional', 'compatibility', 'api'],
      description: '관리자 권한별 기능과 브라우저 호환성을 확인하는 프로젝트',
      currentStage: 'deliverables',
    },
    {
      id: PROJECT_C,
      name: '사내 도구 개선 검증',
      clientName: '사내',
      serviceName: '업무 도구',
      status: 'archived',
      startDate: at(-30, 0),
      endDate: at(-11, 0),
      platforms: ['web'],
      testScopes: ['functional'],
      currentStage: 'issues',
    },
  ];

  const tasks: Task[] = [
    {
      id: 'task-env-setup',
      title: '테스트 환경과 업무 도구 정리',
      status: 'in_progress',
      dueAt: at(0, 15, 0),
      projectId: PROJECT_A,
      notes: '오늘 확인한 계정, 테스트 환경, 사내 도구를 한 번에 정리합니다.\n반복해서 볼 내용만 기록으로 남기고, 임시 자료는 작업이 끝나면 비웁니다.',
      tags: ['온보딩'],
      repeat: 'none',
      createdAt: at(0, 9, 0),
      startedAt: minutesAgo(26),
    },
    {
      id: 'task-questions',
      title: '질문할 내용 한 번에 정리',
      status: 'planned',
      dueAt: at(0, 16, 0),
      projectId: PROJECT_A,
      tags: ['기능 QA'],
      repeat: 'none',
      createdAt: at(0, 9, 5),
    },
    {
      id: 'task-first-record',
      title: '첫 업무 기록 작성',
      status: 'planned',
      dueAt: at(0, 17, 20),
      tags: ['기록'],
      repeat: 'none',
      createdAt: at(0, 9, 10),
    },
    {
      id: 'task-tomorrow',
      title: '내일 확인할 항목 묶기',
      status: 'planned',
      dueAt: at(0, 17, 50),
      tags: ['정리'],
      repeat: 'weekdays',
      createdAt: at(0, 9, 12),
    },
    {
      id: 'task-glossary',
      title: '사내 용어 노트에 추가',
      status: 'planned',
      dueAt: at(0, 18, 0),
      tags: ['지식'],
      repeat: 'none',
      createdAt: at(0, 9, 15),
    },
    {
      id: 'task-figma-diff',
      title: 'Figma 변경 범위 확인',
      status: 'waiting',
      dueAt: at(1, 0, 0),
      projectId: PROJECT_A,
      notes: '디자이너 확인 후 진행',
      tags: ['기능 QA'],
      repeat: 'none',
      createdAt: at(-1, 14, 0),
    },
    {
      id: 'task-tc-review',
      title: 'TC 초안 검토',
      status: 'planned',
      dueAt: at(2, 0, 0),
      projectId: PROJECT_A,
      tags: ['기능 QA'],
      repeat: 'none',
      createdAt: at(-1, 15, 0),
    },
    {
      id: 'task-b-kickoff',
      title: '고객사 B 산출물 목록 받기',
      status: 'planned',
      dueAt: at(5, 10, 0),
      projectId: PROJECT_B,
      tags: ['준비'],
      repeat: 'none',
      createdAt: at(-2, 11, 0),
    },
    {
      id: 'task-test-accounts',
      title: '테스트 계정 목록 정리',
      status: 'planned',
      projectId: PROJECT_A,
      tags: ['온보딩'],
      repeat: 'none',
      createdAt: at(-1, 10, 0),
    },
    {
      id: 'task-access',
      title: '접근 권한 요청',
      status: 'done',
      dueAt: at(0, 10, 6),
      tags: ['온보딩'],
      repeat: 'none',
      createdAt: at(-1, 17, 0),
      completedAt: accessCompletedAt,
    },
  ];

  const deliverables: Deliverable[] = [
    {
      id: 'dlv-plan-pdf',
      projectId: PROJECT_A,
      type: 'pdf',
      title: '모바일_개편_기획_v1.4.pdf',
      fileRef: 'mock://모바일_개편_기획_v1.4.pdf',
      version: 'v1.4',
      summary: '38쪽',
      importedAt: at(-2, 10, 0),
      analyzedAt: at(-1, 11, 0),
    },
    {
      id: 'dlv-figma-auth',
      projectId: PROJECT_A,
      type: 'figma',
      title: 'Figma · 회원가입 / 로그인 플로우',
      sourceUrl: 'https://www.figma.com/',
      summary: 'Frame 8개',
      importedAt: at(-2, 10, 30),
      analyzedAt: at(-1, 11, 10),
    },
    {
      id: 'dlv-existing-tc',
      projectId: PROJECT_A,
      type: 'xlsx',
      title: '기존_TC_회원가입_v3.xlsx',
      fileRef: 'mock://기존_TC_회원가입_v3.xlsx',
      version: 'v3',
      summary: '고객사 Template 감지 완료',
      importedAt: at(-2, 11, 0),
      analyzedAt: at(-2, 11, 5),
    },
    {
      id: 'dlv-api-doc',
      projectId: PROJECT_A,
      type: 'docx',
      title: '인증_API_명세_v0.9.docx',
      fileRef: 'mock://인증_API_명세_v0.9.docx',
      version: 'v0.9',
      summary: '12쪽',
      importedAt: at(-1, 16, 0),
    },
    {
      id: 'dlv-staging-url',
      projectId: PROJECT_A,
      type: 'url',
      title: '스테이징 환경 안내',
      sourceUrl: 'https://qa.example.local/session/preview',
      importedAt: at(0, 10, 42),
    },
    {
      id: 'dlv-b-spec',
      projectId: PROJECT_B,
      type: 'pdf',
      title: '관리자_권한_정책_v0.3.pdf',
      fileRef: 'mock://관리자_권한_정책_v0.3.pdf',
      summary: '14쪽',
      importedAt: at(-3, 14, 0),
    },
    {
      id: 'dlv-b-browser',
      projectId: PROJECT_B,
      type: 'csv',
      title: '지원_브라우저_목록.csv',
      fileRef: 'mock://지원_브라우저_목록.csv',
      importedAt: at(-3, 14, 5),
    },
  ];

  const requirement = (
    id: string,
    feature: string,
    text: string,
    deliverableId: string,
    sourceLocator: string,
    sourceType: Requirement['sourceType'],
    isChange = false,
  ): Requirement => ({
    id,
    projectId: PROJECT_A,
    deliverableId,
    feature,
    text,
    sourceLocator,
    sourceType,
    needsConfirmation: sourceType === 'needs_confirmation',
    isChange,
    status: sourceType === 'source_explicit' ? 'reviewed' : 'draft',
  });

  const requirements: Requirement[] = [
    requirement('req-001', '회원가입', '이메일, 비밀번호, 약관 동의를 입력하면 가입할 수 있다.', 'dlv-plan-pdf', 'p.10', 'source_explicit'),
    requirement('req-002', '회원가입', '비밀번호는 영문과 숫자를 포함해 8자 이상이어야 한다.', 'dlv-plan-pdf', 'p.14', 'source_explicit', true),
    requirement('req-003', '회원가입', '이미 가입된 이메일로 가입하면 안내 문구를 보여준다.', 'dlv-plan-pdf', 'p.15', 'source_explicit'),
    requirement('req-004', '회원가입', '약관 재동의 조건이 모호함 — 개정 시점 기준인지 앱 업데이트 기준인지 명시 필요', 'dlv-figma-auth', '회원가입 Frame', 'needs_confirmation', true),
    requirement('req-005', '회원가입', '가입 도중 앱을 종료했다가 돌아온 경우 입력값 유지 여부 확인을 제안', 'dlv-plan-pdf', 'p.16', 'ai_suggestion'),
    requirement('req-006', '로그인', '이메일과 비밀번호로 로그인하고, 성공하면 홈으로 이동한다.', 'dlv-plan-pdf', 'p.19', 'source_explicit'),
    requirement('req-007', '로그인', '자동 로그인 선택 시 앱 재실행 후에도 로그인 상태를 유지한다.', 'dlv-figma-auth', '로그인 Frame 2', 'source_explicit', true),
    requirement('req-008', '로그인', '로그인 실패 횟수 제한이 기획서에 없음', 'dlv-plan-pdf', 'p.21', 'needs_confirmation'),
    requirement('req-009', '로그인', '계정 잠금 정책이 명시되지 않음', 'dlv-plan-pdf', 'p.21', 'needs_confirmation'),
    requirement('req-010', '비밀번호 재설정', '가입한 이메일로 재설정 링크를 보낸다.', 'dlv-plan-pdf', 'p.25', 'source_explicit'),
    requirement('req-011', '비밀번호 재설정', '재설정 링크 만료 시간 경과 후 접근 시 동작 확인을 제안', 'dlv-plan-pdf', 'p.27', 'ai_suggestion'),
    requirement('req-012', '비밀번호 재설정', '이전과 같은 비밀번호로 변경 가능한지 명시 필요', 'dlv-figma-auth', '재설정 Frame 1', 'needs_confirmation'),
  ];

  const templates: TCTemplate[] = [
    {
      id: 'tpl-client-a',
      projectId: PROJECT_A,
      name: '고객사 A TC 양식',
      columns: ['대분류', '중분류', '소분류', 'Pre-condition', 'Test Step', 'Expected Result', 'Android', 'iOS', 'Issue', '비고'],
      idRule: '기능코드-세 자리 번호 (예: SIGN-001)',
      depthRule: '대분류 › 중분류 › 소분류 3단계',
      styleHints: '"~시 ~ 가능" / "~시 ~ 노출" 형태의 짧은 명사형 문장',
      resultMappings: [
        { rawValue: 'P', result: 'pass' },
        { rawValue: 'F', result: 'fail' },
        { rawValue: 'B', result: 'blocked' },
        { rawValue: 'N/T', result: 'not_tested' },
      ],
    },
  ];

  const testCase = (
    id: string,
    externalId: string,
    category: TestCase['category'],
    depth: string[],
    title: string,
    expectedResult: string,
    sourceRefs: TestCase['sourceRefs'],
    generationType: TestCase['generationType'],
    reviewStatus: TestCase['reviewStatus'],
    duplicateOf?: string,
  ): TestCase => ({
    id,
    projectId: PROJECT_A,
    templateId: 'tpl-client-a',
    externalId,
    category,
    feature: depth[0],
    depth,
    title,
    precondition: '앱 최신 빌드 설치, 로그아웃 상태',
    steps: ['해당 화면으로 이동한다.', '조건에 맞는 값을 입력한다.', '확인 버튼을 누른다.'],
    expectedResult,
    sourceRefs,
    generationType,
    reviewStatus,
    duplicateOf,
    createdAt: at(-1, 13, 0),
    updatedAt: at(0, 11, 0),
  });

  const pdf = (locator: string) => [{ deliverableId: 'dlv-plan-pdf', locator }];
  const figma = (locator: string) => [{ deliverableId: 'dlv-figma-auth', locator }];

  const testCases: TestCase[] = [
    testCase('tc-001', 'SIGN-001', 'normal_flow', ['회원가입', '비밀번호', '유효값'], '유효한 비밀번호 입력 시 가입 가능', '가입 완료 화면 노출', pdf('p.14'), 'source_explicit', 'reviewed'),
    testCase('tc-002', 'SIGN-002', 'boundary', ['회원가입', '비밀번호', '길이'], '최소 길이 8자 입력', '가입 진행 가능', pdf('p.14'), 'source_explicit', 'draft'),
    testCase('tc-003', 'SIGN-003', 'boundary', ['회원가입', '비밀번호', '길이'], '7자 입력 시 오류 노출', '"8자 이상 입력" 안내 노출', pdf('p.14'), 'source_explicit', 'draft'),
    testCase('tc-004', 'SIGN-004', 'exception', ['회원가입', '비밀번호', '구성'], '영문 미포함 시 오류 노출', '"영문과 숫자를 포함" 안내 노출', pdf('p.14'), 'source_explicit', 'draft'),
    testCase('tc-005', 'SIGN-005', 'exception', ['회원가입', '이메일', '중복'], '가입된 이메일 입력 시 안내 노출', '"이미 가입된 이메일" 안내 노출', pdf('p.15'), 'source_explicit', 'reviewed'),
    testCase('tc-006', 'SIGN-006', 'state_change', ['회원가입', '입력 유지', '앱 종료'], '가입 중 앱 종료 후 재진입 시 입력값 유지 여부', '기획 확인 후 기대 결과 확정', pdf('p.16'), 'ai_suggestion', 'draft'),
    testCase('tc-007', 'SIGN-007', 'normal_flow', ['회원가입', '약관', '재동의'], '약관 개정 후 재동의 화면 노출', '확인 필요 — 재동의 조건 미정', figma('회원가입 Frame'), 'needs_confirmation', 'draft'),
    testCase('tc-008', 'LOGIN-001', 'normal_flow', ['로그인', '성공', '홈 이동'], '유효한 계정으로 로그인 시 홈 이동', '홈 화면 노출', pdf('p.19'), 'source_explicit', 'reviewed'),
    testCase('tc-009', 'LOGIN-002', 'state_change', ['로그인', '자동 로그인', '재실행'], '자동 로그인 선택 후 앱 재실행 시 로그인 유지', '로그인 상태로 홈 노출', figma('로그인 Frame 2'), 'source_explicit', 'draft'),
    testCase('tc-010', 'LOGIN-018', 'exception', ['로그인', '실패', '횟수'], '실패 횟수 정책 확인 필요', '확인 필요 — 제한 횟수 미정', pdf('p.21'), 'needs_confirmation', 'draft'),
    testCase('tc-011', 'LOGIN-019', 'exception', ['로그인', '실패', '계정 잠금'], '계정 잠금 관련 기존 TC 유사', '기존 TC 032와 비교 후 결정', pdf('p.21'), 'ai_suggestion', 'draft', '기존 TC 032'),
    testCase('tc-012', 'LOGIN-020', 'permission', ['로그인', '권한', '휴면 계정'], '휴면 계정으로 로그인 시 안내 노출', '휴면 해제 안내 화면 노출', pdf('p.22'), 'ai_suggestion', 'draft'),
    testCase('tc-013', 'PW-001', 'normal_flow', ['비밀번호 재설정', '메일 발송', '가입 이메일'], '가입한 이메일 입력 시 재설정 메일 발송', '"메일을 보냈어요" 안내 노출', pdf('p.25'), 'source_explicit', 'reviewed'),
    testCase('tc-014', 'PW-002', 'exception', ['비밀번호 재설정', '링크', '만료'], '만료된 재설정 링크 접근 시 안내 노출', '링크 만료 안내 노출', pdf('p.27'), 'ai_suggestion', 'draft'),
    testCase('tc-015', 'PW-003', 'data_io', ['비밀번호 재설정', '변경', '이전 비밀번호'], '이전과 같은 비밀번호로 변경 시 동작', '확인 필요 — 허용 여부 미정', figma('재설정 Frame 1'), 'needs_confirmation', 'draft'),
  ];

  // 고객사 Excel에서 수행한 결과 파일을 가져왔다고 가정한 데이터.
  // 외부 파일에는 Looma에서 만들지 않은 기존 TC도 함께 들어 있다.
  const featureCodes: { feature: string; code: string; count: number }[] = [
    { feature: '회원가입', code: 'SIGN', count: 40 },
    { feature: '로그인', code: 'LOGIN', count: 32 },
    { feature: '비밀번호 재설정', code: 'PW', count: 18 },
    { feature: '마이페이지', code: 'MY', count: 16 },
  ];

  // 재현 가능한 의사 난수 (시드 고정)
  function seededRandom(seed: number) {
    let value = seed;
    return () => {
      value = (value * 1664525 + 1013904223) % 4294967296;
      return value / 4294967296;
    };
  }

  function pickResult(random: () => number, weights: [TestResultValue, number][]): TestResultValue {
    const roll = random();
    let sum = 0;
    for (const [value, weight] of weights) {
      sum += weight;
      if (roll < sum) return value;
    }
    return weights[weights.length - 1][0];
  }

  const resultImports: TestResultImport[] = [
    {
      id: 'imp-a-1',
      projectId: PROJECT_A,
      round: 1,
      fileRef: '고객사A_TC_수행결과_1차.xlsx',
      importedAt: at(-3, 18, 0),
      mapping: templates[0].resultMappings,
    },
    {
      id: 'imp-a-2',
      projectId: PROJECT_A,
      round: 2,
      fileRef: '고객사A_TC_수행결과_2차.xlsx',
      importedAt: at(-1, 18, 30),
      mapping: templates[0].resultMappings,
    },
  ];

  const results: TestResult[] = [];
  const weightsByRound: Record<string, Record<string, [TestResultValue, number][]>> = {
    'imp-a-1': {
      회원가입: [['pass', 0.55], ['fail', 0.12], ['blocked', 0.05], ['not_tested', 0.28]],
      로그인: [['pass', 0.4], ['fail', 0.12], ['blocked', 0.08], ['not_tested', 0.4]],
      '비밀번호 재설정': [['pass', 0.3], ['fail', 0.05], ['blocked', 0.05], ['not_tested', 0.6]],
      마이페이지: [['pass', 0.2], ['not_tested', 0.8]],
    },
    'imp-a-2': {
      회원가입: [['pass', 0.8], ['fail', 0.08], ['blocked', 0.02], ['not_tested', 0.1]],
      로그인: [['pass', 0.62], ['fail', 0.12], ['blocked', 0.1], ['not_tested', 0.16]],
      '비밀번호 재설정': [['pass', 0.6], ['fail', 0.06], ['blocked', 0.04], ['not_tested', 0.3]],
      마이페이지: [['pass', 0.45], ['fail', 0.05], ['not_tested', 0.5]],
    },
  };

  for (const resultImport of resultImports) {
    const random = seededRandom(resultImport.round * 97);
    for (const { feature, code, count } of featureCodes) {
      for (let index = 1; index <= count; index += 1) {
        const externalId = `${code}-${String(index).padStart(3, '0')}`;
        const linked = testCases.find((item) => item.externalId === externalId);
        for (const platform of ['android', 'ios'] as const) {
          results.push({
            id: `${resultImport.id}-${externalId}-${platform}`,
            importId: resultImport.id,
            testCaseId: linked?.id,
            externalId,
            feature,
            title: linked?.title ?? `${feature} 기존 TC ${index}`,
            platform,
            result: pickResult(random, weightsByRound[resultImport.id][feature]),
          });
        }
      }
    }
  }

  // 화면 시안과 맞춘 대표 결과
  const override = (importId: string, externalId: string, platform: 'android' | 'ios', result: TestResultValue, extra: Partial<TestResult> = {}) => {
    const target = results.find((item) => item.importId === importId && item.externalId === externalId && item.platform === platform);
    if (target) Object.assign(target, { result, ...extra });
  };
  override('imp-a-2', 'SIGN-001', 'android', 'pass');
  override('imp-a-2', 'SIGN-001', 'ios', 'pass');
  override('imp-a-2', 'SIGN-002', 'android', 'pass');
  override('imp-a-2', 'SIGN-002', 'ios', 'fail', { issueId: 'issue-bug-014', note: 'iOS 문구 상이' });
  override('imp-a-2', 'LOGIN-018', 'android', 'blocked', { note: '기획 확인 대기' });
  override('imp-a-2', 'LOGIN-018', 'ios', 'blocked', { note: '기획 확인 대기' });
  override('imp-a-2', 'LOGIN-019', 'android', 'fail', { issueId: 'issue-bug-015' });
  override('imp-a-2', 'LOGIN-019', 'ios', 'not_tested');

  const issues: Issue[] = [
    {
      id: 'issue-bug-014',
      projectId: PROJECT_A,
      type: 'defect',
      externalKey: 'BUG-014',
      title: 'iOS 비밀번호 오류 문구가 기획과 다름',
      status: 'open',
      feature: '회원가입',
      testCaseId: 'tc-002',
      sourceRef: { deliverableId: 'dlv-plan-pdf', locator: 'p.14' },
      note: '재현됨',
      createdAt: at(-1, 17, 0),
    },
    {
      id: 'issue-bug-015',
      projectId: PROJECT_A,
      type: 'defect',
      externalKey: 'BUG-015',
      title: '로그인 5회 실패 후 계정 잠금 미동작',
      status: 'open',
      feature: '로그인',
      testCaseId: 'tc-011',
      sourceRef: { deliverableId: 'dlv-plan-pdf', locator: 'p.21' },
      note: '기획 확인 중',
      createdAt: at(-1, 17, 20),
    },
    {
      id: 'issue-bug-011',
      projectId: PROJECT_A,
      type: 'defect',
      externalKey: 'BUG-011',
      title: '회원가입 완료 후 홈 이동 정상',
      status: 'closed',
      feature: '회원가입',
      testCaseId: 'tc-001',
      note: '재수행 PASS',
      createdAt: at(-3, 15, 0),
    },
    {
      id: 'issue-q-login-limit',
      projectId: PROJECT_A,
      type: 'question',
      title: '로그인 실패 횟수 제한',
      status: 'waiting',
      feature: '로그인',
      testCaseId: 'tc-010',
      requirementId: 'req-008',
      sourceRef: { deliverableId: 'dlv-plan-pdf', locator: 'p.21' },
      note: '기획 미정',
      createdAt: at(-1, 12, 0),
    },
    {
      id: 'issue-q-lock-policy',
      projectId: PROJECT_A,
      type: 'question',
      title: '계정 잠금 정책',
      status: 'waiting',
      feature: '로그인',
      requirementId: 'req-009',
      sourceRef: { deliverableId: 'dlv-plan-pdf', locator: 'p.21' },
      note: '기획 미정',
      createdAt: at(-1, 12, 5),
    },
    {
      id: 'issue-q-terms',
      projectId: PROJECT_A,
      type: 'question',
      title: '약관 재동의 조건',
      status: 'checking',
      feature: '회원가입',
      testCaseId: 'tc-007',
      requirementId: 'req-004',
      sourceRef: { deliverableId: 'dlv-figma-auth', locator: '회원가입 Frame' },
      note: 'Figma와 기획서 불일치',
      createdAt: at(-1, 12, 10),
    },
    {
      id: 'issue-q-push',
      projectId: PROJECT_A,
      type: 'question',
      title: '푸시 알림 기본값',
      status: 'answered',
      feature: '마이페이지',
      note: '산출물 명시 없음 → 기본 켜짐으로 답변 받음',
      createdAt: at(-2, 12, 0),
    },
  ];

  const knowledge: KnowledgeTerm[] = [
    {
      id: 'term-regression',
      term: '회귀 테스트',
      explanation: '기존 기능이 변경 사항의 영향을 받지 않았는지 다시 확인하는 테스트.',
      workMeaning: '배포 후보 빌드마다 변경 기능과 연결된 주요 플로우를 다시 확인합니다.',
      examples: ['로그인 수정 후 회원가입·비밀번호 재설정 플로우 재확인'],
      relatedProjectIds: [PROJECT_A],
      relatedTerms: ['스모크 테스트', '영향도 분석'],
      tags: ['테스트 유형', '기본 용어', 'QA'],
      userNote: '프로젝트마다 회귀 범위와 수행 시점이 다를 수 있으므로 실제 고객사 기준을 우선.',
      aiDraftUsed: false,
      aiDraft: {
        explanation: '변경된 기능이 기존 기능에 예상치 못한 영향을 주지 않았는지 확인하는 테스트입니다.',
        relatedKeywords: ['재테스트', '스모크 테스트', '영향도 분석'],
        createdAt: at(-1, 9, 0),
      },
      updatedAt: at(-1, 9, 30),
    },
    {
      id: 'term-blocked',
      term: 'BLOCKED',
      explanation: '선행 조건이나 환경 문제 때문에 테스트를 진행할 수 없는 상태.',
      workMeaning: 'FAIL과 구분해서 기록하고, 막힌 이유(환경, 기획 미정, 선행 결함)를 비고에 남깁니다.',
      examples: ['테스트 서버 점검으로 로그인 불가', '정책 미정으로 기대 결과를 정할 수 없음'],
      relatedProjectIds: [PROJECT_A],
      relatedTerms: ['N/T'],
      tags: ['수행 결과', 'QA'],
      aiDraftUsed: false,
      updatedAt: at(-2, 10, 0),
    },
    {
      id: 'term-nt',
      term: 'N/T',
      explanation: 'Not Tested. 이번 차수에 수행하지 않은 항목.',
      workMeaning: '범위 제외인지 시간 부족인지 구분해서 다음 차수 계획에 반영합니다.',
      examples: [],
      relatedProjectIds: [PROJECT_A],
      relatedTerms: ['BLOCKED'],
      tags: ['수행 결과'],
      aiDraftUsed: false,
      updatedAt: at(-2, 10, 5),
    },
    {
      id: 'term-p90',
      term: 'P90',
      explanation: '응답 시간을 작은 순서로 늘어놓았을 때 90% 지점의 값.',
      workMeaning: '성능 테스트에서 평균보다 체감 지연을 더 잘 보여주는 지표로 씁니다.',
      examples: ['로그인 API P90 800ms 이하'],
      relatedProjectIds: [],
      relatedTerms: ['성능 테스트'],
      tags: ['성능'],
      aiDraftUsed: true,
      updatedAt: at(-5, 10, 0),
    },
    {
      id: 'term-scenario',
      term: '테스트 시나리오',
      explanation: '사용자 관점의 흐름 단위로 무엇을 확인할지 묶은 것. 여러 TC로 나뉜다.',
      examples: ['회원가입부터 첫 로그인까지'],
      relatedProjectIds: [PROJECT_A],
      relatedTerms: ['TC'],
      tags: ['설계'],
      aiDraftUsed: false,
      updatedAt: at(-4, 10, 0),
    },
    {
      id: 'term-severity',
      term: '결함 심각도',
      explanation: '결함이 서비스에 주는 영향의 크기. 우선순위와는 별도로 판단한다.',
      examples: [],
      relatedProjectIds: [],
      relatedTerms: ['우선순위'],
      tags: ['이슈'],
      aiDraftUsed: false,
      updatedAt: at(-6, 10, 0),
    },
    {
      id: 'term-smoke',
      term: '스모크 테스트',
      explanation: '빌드를 받자마자 핵심 기능이 동작하는지 빠르게 확인하는 테스트.',
      workMeaning: '본 수행 전에 진행해 빌드 반려 여부를 먼저 판단합니다.',
      examples: [],
      relatedProjectIds: [PROJECT_A],
      relatedTerms: ['회귀 테스트'],
      tags: ['테스트 유형'],
      aiDraftUsed: false,
      updatedAt: at(-7, 10, 0),
    },
  ];

  const scratch: ScratchItem[] = [
    {
      id: 'scr-alarm',
      type: 'text',
      title: '로그인 후 알림 설정 유지 여부 다시 확인',
      content: '로그인 후 알림 설정 유지 여부 다시 확인\n앱 재실행 뒤 설정값이 유지되는지 확인.',
      createdAt: minutesAgo(20),
      expiresAt: hoursFromNow(9),
      contextProjectId: PROJECT_A,
    },
    {
      id: 'scr-log',
      type: 'log',
      title: '응답 지연 로그 일부',
      content: '14:03:18 GET /session\n14:03:26 timeout\nretry=1',
      createdAt: minutesAgo(26),
      expiresAt: hoursFromNow(6),
      contextProjectId: PROJECT_A,
    },
    {
      id: 'scr-url',
      type: 'url',
      title: '테스트 환경 미리보기',
      content: 'https://qa.example.local/session/preview',
      createdAt: minutesAgo(41),
      expiresAt: hoursFromNow(3),
    },
    {
      id: 'scr-json',
      type: 'json',
      title: '로그인 응답 예시',
      content: '{\n  "code": "AUTH_LOCKED",\n  "remainingAttempts": 0\n}',
      createdAt: minutesAgo(95),
      expiresAt: hoursFromNow(1),
      contextProjectId: PROJECT_A,
    },
    {
      id: 'scr-pinned-env',
      type: 'url',
      title: '테스트 환경 주소',
      content: 'https://qa.example.local',
      createdAt: minutesAgo(72),
      pinnedAt: envPinnedAt,
      linkedType: 'record',
    },
  ];

  const activities: Activity[] = [
    { id: 'act-1', type: 'memo_created', title: '온보딩 안내 메모 작성', metadata: { detail: '메모' }, createdAt: memoCreatedAt },
    { id: 'act-2', type: 'task_completed', taskId: 'task-access', title: '접근 권한 요청 완료', metadata: { detail: '온보딩 업무' }, createdAt: accessCompletedAt },
    { id: 'act-3', type: 'scratch_pinned', title: '테스트 환경 주소를 기록에 고정', metadata: { detail: '임시 작업공간 → 기록' }, createdAt: envPinnedAt },
    { id: 'act-4', type: 'task_started', taskId: 'task-env-setup', projectId: PROJECT_A, title: '테스트 환경과 업무 도구 정리 시작', metadata: { detail: '업무 시작' }, createdAt: minutesAgo(26) },
    { id: 'act-5', type: 'memo_created', projectId: PROJECT_A, title: '알림 설정 확인 메모 추가', metadata: { detail: '현재 업무와 연결됨' }, createdAt: minutesAgo(20) },
    { id: 'act-6', type: 'results_uploaded', projectId: PROJECT_A, title: '2차 수행 결과 업로드', metadata: { detail: '고객사A_TC_수행결과_2차.xlsx' }, createdAt: at(-1, 18, 30) },
    { id: 'act-7', type: 'issue_created', projectId: PROJECT_A, title: 'BUG-015 등록', metadata: { detail: '로그인 5회 실패 후 계정 잠금 미동작' }, createdAt: at(-1, 17, 20) },
    { id: 'act-8', type: 'test_case_changed', projectId: PROJECT_A, title: 'TC 초안 15건 생성', metadata: { detail: '산출물 기반 · 검토 필요' }, createdAt: at(-1, 13, 0) },
    { id: 'act-9', type: 'requirements_analyzed', projectId: PROJECT_A, title: '기획서 v1.4 요구사항 분석', metadata: { detail: '기능 3 · 확인 필요 4' }, createdAt: at(-1, 11, 0) },
    { id: 'act-10', type: 'deliverable_added', projectId: PROJECT_A, title: '인증 API 명세 추가', metadata: { detail: 'DOCX' }, createdAt: at(-1, 16, 0) },
    { id: 'act-11', type: 'deliverable_added', projectId: PROJECT_A, title: '모바일 개편 기획서 v1.4 추가', metadata: { detail: 'PDF' }, createdAt: at(-2, 10, 0) },
    { id: 'act-12', type: 'deliverable_added', projectId: PROJECT_B, title: '관리자 권한 정책 추가', metadata: { detail: 'PDF' }, createdAt: at(-3, 14, 0) },
    { id: 'act-13', type: 'results_uploaded', projectId: PROJECT_A, title: '1차 수행 결과 업로드', metadata: { detail: '고객사A_TC_수행결과_1차.xlsx' }, createdAt: at(-3, 18, 0) },
    { id: 'act-14', type: 'knowledge_saved', title: '회귀 테스트 용어 정리', metadata: { detail: '업무 지식' }, createdAt: at(-1, 9, 30) },
  ];

  const calendarEvents: CalendarEvent[] = [
    { id: 'cal-1', title: '주간 QA 진행 공유', startAt: at(0, 16, 30), endAt: at(0, 17, 0), location: '회의실 3', sourceUrl: 'https://calendar.google.com/' },
    { id: 'cal-2', title: '기획 확인 미팅 — 로그인 정책', startAt: at(1, 10, 0), endAt: at(1, 10, 30), sourceUrl: 'https://calendar.google.com/' },
    { id: 'cal-3', title: '고객사 B 착수 회의', startAt: at(5, 14, 0), endAt: at(5, 15, 0), sourceUrl: 'https://calendar.google.com/' },
  ];

  return {
    projects,
    tasks,
    deliverables,
    requirements,
    templates,
    testCases,
    resultImports,
    results,
    issues,
    knowledge,
    scratch,
    activities,
    calendarEvents,
  };
}

export type SeedData = ReturnType<typeof createSeed>;
