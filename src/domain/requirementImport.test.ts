import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseCsv } from '@/lib/csv';
import { readImportFile } from '@/features/project-qa/imports/importFile';
import {
  analyzeRequirementImport,
  classifyRequirementCandidates,
  parseNeedsConfirmation,
  planRequirementImport,
  requirementColumnMappingProblems,
  requirementLocatorFallback,
  summarizeRequirementImport,
  suggestRequirementColumnMapping,
  RequirementImportError,
  type RequirementColumnMapping,
} from './requirementImport';
import { toImportTable, type ImportTable } from './testAssetImport';
import type { Requirement } from './types';

const table = (rows: string[][]): ImportTable => toImportTable(rows)!;
const csvTable = (text: string): ImportTable => toImportTable(parseCsv(text))!;

const MAPPING: RequirementColumnMapping = ['feature', 'text', 'locator', 'needsConfirmation'];
const HEADER = ['기능명', '요구사항', '페이지/위치', '확인 필요'];

const existing = (overrides: Partial<Requirement> = {}): Requirement => ({
  id: 'req-existing',
  projectId: 'proj-a',
  feature: '회원가입',
  text: '이메일로 가입할 수 있다.',
  sourceRefs: [{ deliverableId: 'dlv-1', locator: 'p.3' }],
  sourceType: 'source_explicit',
  needsConfirmation: false,
  lifecycle: 'active',
  status: 'confirmed',
  ...overrides,
});

let nextId = 0;
const options = { projectId: 'proj-a', deliverableId: 'dlv-new', createId: (prefix: string) => `${prefix}-${++nextId}` };

describe('열 매핑', () => {
  it('이름이 분명한 헤더만 연결하고 같은 필드는 첫 열만 연결한다', () => {
    expect(suggestRequirementColumnMapping(['기능명', '요구사항', '페이지/위치', '확인 필요', '비고'])).toEqual(['feature', 'text', 'locator', 'needsConfirmation', null]);
    expect(suggestRequirementColumnMapping(['Feature', ' REQUIREMENT ', 'page', 'Needs Confirmation'])).toEqual(['feature', 'text', 'locator', 'needsConfirmation']);
    expect(suggestRequirementColumnMapping(['기능', '기능명'])).toEqual(['feature', null]);
    expect(suggestRequirementColumnMapping(['ID', '상태'])).toEqual([null, null]);
  });

  it('기능 · 요구사항 열이 없거나 같은 필드에 열이 둘 이상이면 가져올 수 없다', () => {
    expect(requirementColumnMappingProblems(HEADER, MAPPING)).toEqual([]);
    expect(requirementColumnMappingProblems(HEADER, ['feature', null, null, null])).toEqual(["'요구사항' 열을 연결해 주세요."]);
    expect(requirementColumnMappingProblems(HEADER, [null, 'text', 'locator', null])).toEqual(["'기능' 열을 연결해 주세요."]);
    expect(requirementColumnMappingProblems(['a', 'b', 'c'], ['feature', 'feature', 'text'])).toEqual(["'기능'에 열이 둘 이상 연결됐어요. (a, b)"]);
    // 출처 위치 · 확인 필요는 선택이다.
    expect(requirementColumnMappingProblems(['a', 'b'], ['feature', 'text'])).toEqual([]);
  });
});

describe('확인 필요 값', () => {
  it.each([
    ['true', true],
    ['TRUE', true],
    ['Y', true],
    ['yes', true],
    ['1', true],
    ['필요', true],
    ['확인 필요', true],
    [' 확인필요 ', true],
    ['false', false],
    ['N', false],
    ['No', false],
    ['0', false],
    ['불필요', false],
    ['', false],
    ['   ', false],
    [undefined, false],
  ])('%j → %s', (value, expected) => {
    expect(parseNeedsConfirmation(value)).toBe(expected);
  });

  it.each(['maybe', '네', '2', '확인', '필요함', 'x'])('알 수 없는 값 %j는 false로 보지 않는다', (value) => {
    expect(parseNeedsConfirmation(value)).toBeUndefined();
  });
});

describe('CSV 판정', () => {
  const csv = [
    '기능명,요구사항,페이지/위치,확인 필요',
    '로그인,  이메일과 비밀번호로 로그인한다. ,p.3,N',
    '로그인,5회 실패하면 계정을 잠근다.,p.4,Y',
    ',기능이 없는 행,p.5,N',
    '로그인,,p.6,N',
    '로그인,알 수 없는 확인 값,p.7,아마도',
    '',
    '회원가입,이메일로 가입할 수 있다.,p.8,N',
    '로그인,이메일과 비밀번호로   로그인한다.,p.9,N',
    '소셜,카카오로 가입할 수 있다.,,',
  ].join('\n');

  it('앞뒤 공백을 지우고 행마다 신규 · 중복 · 오류로 판정하며, 빈 행은 건너뛰고 행 번호는 파일 그대로다', () => {
    const analysis = analyzeRequirementImport(csvTable(csv), MAPPING, [existing()]);
    expect(analysis.blankRows).toBe(1);
    expect(analysis.rows.map((row) => [row.candidate.rowNumber, row.kind])).toEqual([
      [2, 'create'],
      [3, 'create'],
      [4, 'invalid'],
      [5, 'invalid'],
      [6, 'invalid'],
      [8, 'duplicate'],
      [9, 'duplicate'],
      [10, 'create'],
    ]);
    expect(analysis.rows[0].candidate).toMatchObject({ feature: '로그인', text: '이메일과 비밀번호로 로그인한다.', locator: 'p.3', needsConfirmation: false });
    expect(analysis.rows[2].reasons).toEqual(['기능이 비어 있어요.']);
    expect(analysis.rows[3].reasons).toEqual(['요구사항이 비어 있어요.']);
    expect(analysis.rows[4].reasons).toEqual(['확인 필요 값을 해석할 수 없어요. (아마도)']);
    expect(analysis.rows[5].reasons).toEqual(['이미 있는 요구사항이에요.']);
    // 파일 안에서 먼저 나온 행과 공백 차이만 있는 행은 뒤의 행이 중복이다.
    expect(analysis.rows[6].reasons).toEqual(['파일의 2행과 같은 요구사항이에요.']);
    expect(summarizeRequirementImport(analysis)).toEqual({ total: 8, created: 3, duplicate: 2, invalid: 3, excluded: 0 });
  });

  it('제외한 신규 행은 신규에서 빼고 제외로 세며, 신규가 아닌 행을 제외해도 세지 않는다', () => {
    const analysis = analyzeRequirementImport(csvTable(csv), MAPPING, [existing()]);
    expect(summarizeRequirementImport(analysis, [3, 4, 8])).toEqual({ total: 8, created: 2, duplicate: 2, invalid: 3, excluded: 1 });
  });
});

describe('중복 판정', () => {
  const analyzeOne = (feature: string, text: string, existingItems: Requirement[]) =>
    analyzeRequirementImport(table([['기능', '요구사항'], [feature, text]]), ['feature', 'text'], existingItems).rows[0].kind;

  it('같은 기능 · 같은 내용만 중복이다(공백 · 유니코드 조합 차이는 무시)', () => {
    expect(analyzeOne('회원가입', '이메일로 가입할 수 있다.', [existing()])).toBe('duplicate');
    expect(analyzeOne(' 회원가입 ', '이메일로  가입할\n수 있다.', [existing()])).toBe('duplicate');
    expect(analyzeOne('회원가입'.normalize('NFD'), '이메일로 가입할 수 있다.'.normalize('NFD'), [existing()])).toBe('duplicate');
  });

  it('기능이 다르거나 비슷한 문장이거나 대소문자만 다르면 중복이 아니다(fuzzy 없음)', () => {
    expect(analyzeOne('로그인', '이메일로 가입할 수 있다.', [existing()])).toBe('create');
    expect(analyzeOne('회원가입', '이메일로 가입할 수 있다', [existing()])).toBe('create');
    expect(analyzeOne('회원가입', '이메일로 가입이 가능하다.', [existing()])).toBe('create');
    expect(analyzeOne('Login', 'Users can sign in.', [existing({ feature: 'login', text: 'users can sign in.' })])).toBe('create');
  });

  it('제거됨 요구사항과 같아도 중복이며 이유로 알린다', () => {
    const analysis = analyzeRequirementImport(table([['기능', '요구사항'], ['회원가입', '이메일로 가입할 수 있다.']]), ['feature', 'text'], [existing({ lifecycle: 'removed' })]);
    expect(analysis.rows[0]).toMatchObject({ kind: 'duplicate', reasons: ['제거됨 상태로 이미 있는 요구사항이에요.'] });
  });

  it('다른 프로젝트의 요구사항은 호출하는 쪽이 넘기지 않으므로 비교하지 않는다(기존 목록이 비교 대상의 전부)', () => {
    expect(analyzeOne('회원가입', '이메일로 가입할 수 있다.', [])).toBe('create');
  });
});

describe('XLSX 선택 시트', () => {
  async function open(sheets: Record<string, string[][]>) {
    const workbook = XLSX.utils.book_new();
    for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
    const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    const result = await readImportFile(new File([bytes], '요구사항.xlsx'));
    if (!result.ok) throw new Error(result.message);
    return result.source;
  }

  it('고른 시트의 표만 판정하고, 행 번호는 그 시트 기준이다', async () => {
    const source = await open({
      표지: [['문서', '요구사항 목록']],
      요구사항: [['기능', '요구사항', '출처'], ['로그인', '로그인할 수 있다.', 'p.1'], ['', '', ''], ['로그인', '로그아웃할 수 있다.', '']],
    });
    expect(source.sheetNames).toEqual(['표지', '요구사항']);
    const result = source.readTable('요구사항');
    if (!result.ok) throw new Error(result.message);
    const mapping = suggestRequirementColumnMapping(result.table.headers);
    expect(mapping).toEqual(['feature', 'text', 'locator']);
    const analysis = analyzeRequirementImport(result.table, mapping, []);
    expect(analysis.blankRows).toBe(1);
    expect(analysis.rows.map((row) => [row.candidate.rowNumber, row.kind, row.candidate.feature, row.candidate.locator])).toEqual([
      [2, 'create', '로그인', 'p.1'],
      [4, 'create', '로그인', undefined],
    ]);
  });
});

describe('생성 계획', () => {
  const analyze = (rows: string[][], items: Requirement[] = []) => analyzeRequirementImport(table([HEADER, ...rows]), MAPPING, items);

  it('신규 행만 draft · active · source_explicit 요구사항으로 만들고, 근거는 고른 산출물과 위치 하나다', () => {
    const analysis = analyze([
      ['로그인', '이메일로 로그인한다.', 'p.3', 'N'],
      ['로그인', '5회 실패하면 잠근다.', 'p.4', '확인 필요'],
      ['로그인', '', 'p.5', 'N'],
      ['회원가입', '이메일로 가입할 수 있다.', 'p.6', 'N'],
    ], [existing()]);
    const { requirements, summary } = planRequirementImport(analysis, [], options);
    expect(requirements).toHaveLength(2);
    expect(requirements[0]).toEqual({
      id: expect.stringMatching(/^req-/),
      projectId: 'proj-a',
      feature: '로그인',
      text: '이메일로 로그인한다.',
      sourceRefs: [{ deliverableId: 'dlv-new', locator: 'p.3' }],
      sourceType: 'source_explicit',
      needsConfirmation: false,
      lifecycle: 'active',
      status: 'draft',
    });
    expect(requirements[1]).toMatchObject({ needsConfirmation: true, sourceRefs: [{ deliverableId: 'dlv-new', locator: 'p.4' }] });
    expect(requirements[0]).not.toHaveProperty('confidence');
    expect(new Set(requirements.map((item) => item.id)).size).toBe(2);
    expect(summary).toEqual({ total: 4, created: 2, duplicate: 1, invalid: 1, excluded: 0 });
  });

  it('근거 위치가 비어 있거나 열이 없으면 원본 행 번호로 대신하고, 빈 위치는 저장하지 않는다', () => {
    const withBlank = planRequirementImport(analyze([['로그인', '로그인한다.', '  ', 'N']]), [], options);
    expect(withBlank.requirements[0].sourceRefs).toEqual([{ deliverableId: 'dlv-new', locator: requirementLocatorFallback(2) }]);
    expect(requirementLocatorFallback(12)).toBe('요구사항 파일 12행');
    const noColumn = analyzeRequirementImport(table([['기능', '요구사항'], ['a', 'b'], ['', ''], ['c', 'd']]), ['feature', 'text'], []);
    const plan = planRequirementImport(noColumn, [], options);
    expect(plan.requirements.map((item) => item.sourceRefs[0].locator)).toEqual(['요구사항 파일 2행', '요구사항 파일 4행']);
    expect(plan.requirements.every((item) => !item.needsConfirmation)).toBe(true);
  });

  it('사용자가 제외한 신규 행은 만들지 않고, 중복 · 오류 행은 제외 여부와 무관하게 만들지 않는다', () => {
    const analysis = analyze([['a', 'aa', '', 'N'], ['b', 'bb', '', 'N'], ['c', '', '', 'N']]);
    const plan = planRequirementImport(analysis, [3], options);
    expect(plan.requirements.map((item) => item.feature)).toEqual(['a']);
    expect(plan.summary).toEqual({ total: 3, created: 1, duplicate: 0, invalid: 1, excluded: 1 });
  });

  it('만들 요구사항이 없으면 던진다', () => {
    expect(() => planRequirementImport(analyze([['a', '', '', 'N']]), [], options)).toThrow(RequirementImportError);
    expect(() => planRequirementImport(analyze([['a', 'aa', '', 'N']]), [2], options)).toThrow('가져올 수 있는 새 요구사항이 없어요.');
    expect(() => planRequirementImport(analyze([['회원가입', '이메일로 가입할 수 있다.', '', 'N']], [existing()]), [], options)).toThrow(RequirementImportError);
  });

  it('입력(분석 · 기존 요구사항)을 바꾸지 않는다', () => {
    const items = [existing()];
    const before = structuredClone(items);
    const analysis = analyze([['a', 'aa', '', 'N']], items);
    const analysisBefore = structuredClone(analysis);
    planRequirementImport(analysis, [], options);
    expect(items).toEqual(before);
    expect(analysis).toEqual(analysisBefore);
  });
});

describe('후보 행 판정(다른 출처의 후보도 같은 규칙)', () => {
  it('파일이 아닌 곳에서 만든 후보 행도 같은 판정 · 계획을 거친다', () => {
    const rows = classifyRequirementCandidates(
      [
        { rowNumber: 1, feature: '검색', text: '키워드로 검색한다.', needsConfirmation: true, locator: 'AI 초안' },
        { rowNumber: 2, feature: '검색', text: '키워드로 검색한다.', needsConfirmation: true },
      ],
      [],
    );
    expect(rows.map((row) => row.kind)).toEqual(['create', 'duplicate']);
    const plan = planRequirementImport({ rows, blankRows: 0 }, [], options);
    expect(plan.requirements).toHaveLength(1);
    expect(plan.requirements[0]).toMatchObject({ needsConfirmation: true, sourceRefs: [{ locator: 'AI 초안' }] });
  });
});
