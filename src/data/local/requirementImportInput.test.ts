import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { readImportFile } from '@/features/project-qa/imports/importFile';
import type { RequirementColumnMapping } from '@/domain/requirementImport';
import { toImportTable, type ImportTable } from '@/domain/testAssetImport';
import type { ImportRequirementsInput, PersistenceStatus, Repositories } from '../repositories/types';
import { createSeed, PROJECT_A } from '../mock/seed';
import type { AppData, StoredAppState } from './appData';
import { createLocalRepositories } from './localRepositories';
import { createMemoryStateStore } from './stateStore';

/*
 * 요구사항 가져오기 독립 리뷰 지적의 회귀 테스트.
 * - 근거 위치의 원본 행 번호: 따옴표 안 줄바꿈이 있는 CSV 뒤 행도 사람이 파일에서 찾는 줄 번호로 저장된다(XLSX는 기존 의미 그대로).
 * - 입력 모양: 열 매핑 길이 · 알 수 없는 필드 · 행의 칸 수를 저장소 경계에서 거부한다.
 * - 제외 목록: 지금 신규인 행의 제외만 받고, 그 밖의 값은 조용히 무시하지 않고 거부한다.
 * 모든 거부에서 요구사항 · 활동 · 저장 상태 · revision은 그대로다.
 */

const DELIVERABLE = 'dlv-plan-pdf-v15';
const MAPPING: RequirementColumnMapping = ['feature', 'text', 'locator', 'needsConfirmation'];
const NO_LOCATOR_MAPPING: RequirementColumnMapping = ['feature', 'text'];

const table = (rows: string[][]): ImportTable => toImportTable([['기능명', '요구사항', '페이지/위치', '확인 필요'], ...rows])!;

async function open() {
  const base = createMemoryStateStore();
  const repos = createLocalRepositories({ openStore: async () => base, createInitialData: createSeed });
  await repos.persistence.load();
  return { repos, base };
}

const ready = (repos: Repositories) => repos.persistence.getStatus() as Extract<PersistenceStatus, { state: 'ready' }>;
const stored = (store: ReturnType<typeof createMemoryStateStore>) => structuredClone(store.inspect().state as StoredAppState & { data: AppData });
const importActivities = async (repos: Repositories) => (await repos.activities.list({ projectId: PROJECT_A })).filter((item) => item.type === 'requirements_imported');

const input = (rows: string[][], overrides: Partial<ImportRequirementsInput> = {}): ImportRequirementsInput => ({
  projectId: PROJECT_A,
  deliverableId: DELIVERABLE,
  fileName: '요구사항.csv',
  table: table(rows),
  mapping: MAPPING,
  excludedRows: [],
  ...overrides,
});

// 2 신규 / 3 신규(위치 없음 · 확인 필요) / 4 오류(요구사항 없음) / 5 신규
const FILE_ROWS = [
  ['소셜 로그인', '카카오 계정으로 로그인할 수 있다.', 'p.21', 'N'],
  ['소셜 로그인', '애플 계정으로 로그인할 수 있다.', '', '필요'],
  ['소셜 로그인', '', 'p.23', 'N'],
  ['소셜 로그인', '네이버 계정으로 로그인할 수 있다.', 'p.24', 'N'],
];

/** 실제 파일 읽기 경로(readImportFile)로 표를 만든다. */
async function readTable(file: File, sheetName?: string): Promise<ImportTable> {
  const read = await readImportFile(file);
  if (!read.ok) throw new Error(read.message);
  const result = read.source.readTable(sheetName);
  if (!result.ok) throw new Error(result.message);
  return result.table;
}

const locatorsOf = (requirements: { sourceRefs: { locator: string }[] }[]) => requirements.map((item) => item.sourceRefs[0].locator);

describe('요구사항 근거 위치: 원본 행 번호', () => {
  it('따옴표 안 줄바꿈이 있는 CSV 뒤의 행은 실제 줄 번호로 근거 위치를 남긴다', async () => {
    const { repos } = await open();
    // 1 헤더 / 2~3 로그인 / 4 결제 / 5~7 검색 / 8 알림
    const text = '기능,요구사항\n로그인,"이메일로\n로그인한다."\n결제,카드로 결제한다.\n검색,"키워드로\n검색하고\n정렬한다."\n알림,푸시를 받는다.\n';
    const parsed = await readTable(new File([text], '요구사항.csv'));
    expect(parsed.rows.map((row) => row.rowNumber)).toEqual([2, 4, 5, 8]);
    const expected = ['요구사항 파일 2행', '요구사항 파일 4행', '요구사항 파일 5행', '요구사항 파일 8행'];
    const result = await repos.requirements.importFromTable(input([], { table: parsed, mapping: NO_LOCATOR_MAPPING }));
    expect(locatorsOf(result.requirements)).toEqual(expected);
    expect(locatorsOf(await repos.requirements.listByProject(PROJECT_A)).slice(-4)).toEqual(expected);
  });

  it('CRLF 파일도 LF와 같은 줄 번호이고, BOM · 빈 줄이 있어도 실제 줄을 가리킨다', async () => {
    const { repos } = await open();
    // 1 헤더 / 2~3 로그인 / 4 빈 줄(건너뜀) / 5 결제
    const lf = '﻿기능,요구사항\n로그인,"첫 줄\n둘째 줄"\n\n결제,결제한다.\n';
    const lfTable = await readTable(new File([lf], 'lf.csv'));
    const crlfTable = await readTable(new File([lf.replace(/\n/g, '\r\n')], 'crlf.csv'));
    expect(crlfTable.rows.map((row) => row.rowNumber)).toEqual(lfTable.rows.map((row) => row.rowNumber));
    const result = await repos.requirements.importFromTable(input([], { table: crlfTable, mapping: NO_LOCATOR_MAPPING }));
    expect(locatorsOf(result.requirements)).toEqual(['요구사항 파일 2행', '요구사항 파일 5행']);
  });

  it('출처 위치 열이 있으면 그 값이 우선이고 줄 번호는 비어 있는 칸에만 쓰인다', async () => {
    const { repos } = await open();
    const parsed = await readTable(new File(['기능,요구사항,출처\n로그인,"줄\n바꿈",p.3\n결제,결제한다.,\n'], '출처.csv'));
    const result = await repos.requirements.importFromTable(input([], { table: parsed, mapping: ['feature', 'text', 'locator'] }));
    expect(locatorsOf(result.requirements)).toEqual(['p.3', '요구사항 파일 4행']);
  });

  it('XLSX는 기존 행 번호 의미 그대로다: 헤더 1행 · 데이터 2행이면 "요구사항 파일 2행"', async () => {
    const { repos } = await open();
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['기능', '요구사항'], ['검색', '키워드로 검색한다.\n정렬한다.'], ['알림', '푸시를 받는다.']]), '요구사항');
    const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    const parsed = await readTable(new File([bytes], '요구사항.xlsx'), '요구사항');
    expect(parsed.rows.map((row) => row.rowNumber)).toEqual([2, 3]);
    const result = await repos.requirements.importFromTable(input([], { table: parsed, mapping: NO_LOCATOR_MAPPING }));
    expect(locatorsOf(result.requirements)).toEqual(['요구사항 파일 2행', '요구사항 파일 3행']);
  });

  it('TC · 수행 결과 가져오기도 같은 표를 쓰므로 CSV 행 번호가 원본 줄 번호다', async () => {
    const parsed = await readTable(new File(['TC ID,테스트 항목\nSIGN-001,"줄\n바꿈"\nSIGN-002,로그인\n'], 'tc.csv'));
    expect(parsed.rows.map((row) => [row.rowNumber, row.cells[0]])).toEqual([
      [2, 'SIGN-001'],
      [4, 'SIGN-002'],
    ]);
  });
});

describe('요구사항 가져오기 입력 검증(저장소 경계)', () => {
  async function expectRejected(change: Partial<ImportRequirementsInput>, message: string) {
    const { repos, base } = await open();
    const before = { state: stored(base), requirements: await repos.requirements.listByProject(PROJECT_A), activities: await repos.activities.list(), revision: ready(repos).revision };
    await expect(repos.requirements.importFromTable(input(FILE_ROWS, change))).rejects.toThrow(message);
    expect(stored(base)).toEqual(before.state);
    expect(await repos.requirements.listByProject(PROJECT_A)).toEqual(before.requirements);
    expect(await repos.activities.list()).toEqual(before.activities);
    expect(ready(repos).revision).toBe(before.revision);
  }

  it.each([
    ['짧은 매핑', ['feature'] as RequirementColumnMapping, '요구사항 열 매핑 정보가 파일 열과 맞지 않아요.'],
    ['긴 매핑(숨은 열)', ['feature', 'text', 'locator', 'needsConfirmation', 'locator'] as RequirementColumnMapping, '요구사항 열 매핑 정보가 파일 열과 맞지 않아요.'],
    ['빈 매핑', [] as RequirementColumnMapping, '요구사항 열 매핑 정보가 파일 열과 맞지 않아요.'],
    ['알 수 없는 필드', ['feature', 'hacked', 'locator', 'needsConfirmation'] as unknown as RequirementColumnMapping, '알 수 없는 연결 필드예요. (hacked)'],
  ])('%s → 거부하고 요구사항 · 활동 · 저장 상태 · revision이 그대로다', async (_, mapping, message) => {
    await expectRejected({ mapping }, message);
  });

  it('행의 칸 수가 헤더와 다르면(숨은 칸이 있는 행 + 긴 매핑 조합 포함) 거부한다', async () => {
    const wide: ImportTable = { headers: ['기능', '요구사항'], rows: [{ rowNumber: 2, cells: ['로그인', '로그인한다.', '숨은 칸'] }] };
    await expectRejected({ table: wide, mapping: ['feature', 'text'] }, '2행의 칸 수가 파일 열 수와 맞지 않아요.');
    await expectRejected({ table: wide, mapping: ['feature', 'text', 'locator'] }, '2행의 칸 수가 파일 열 수와 맞지 않아요.');
  });

  it('행 번호가 겹치면 거부한다', async () => {
    const duplicated: ImportTable = {
      headers: ['기능', '요구사항'],
      rows: [
        { rowNumber: 2, cells: ['a', 'aa'] },
        { rowNumber: 2, cells: ['b', 'bb'] },
      ],
    };
    await expectRejected({ table: duplicated, mapping: ['feature', 'text'] }, '행 번호가 올바르지 않아요. (2)');
  });

  it.each([
    ['없는 행', [999], '999행은 제외할 수 있는 요구사항 행이 아니에요.'],
    ['오류 행(요구사항 없음)', [4], '4행은 제외할 수 있는 요구사항 행이 아니에요.'],
    ['같은 행 두 번', [2, 2], '2행을 제외 목록에 두 번 넣었어요.'],
  ])('제외 목록: %s → 조용히 무시하지 않고 거부하며 아무것도 저장하지 않는다', async (_, excludedRows, message) => {
    await expectRejected({ excludedRows }, message);
  });

  it('제외 목록: 기존 요구사항과 중복인 행의 제외는 거부한다', async () => {
    const { repos } = await open();
    const [seeded] = await repos.requirements.listByProject(PROJECT_A);
    const rows = [
      [seeded.feature, seeded.text, 'p.1', 'N'],
      ['새 기능', '새 요구사항', 'p.2', 'N'],
    ];
    await expect(repos.requirements.importFromTable(input(rows, { excludedRows: [2] }))).rejects.toThrow('2행은 제외할 수 있는 요구사항 행이 아니에요.');
    expect(await importActivities(repos)).toEqual([]);
  });

  it('제외 목록: 지금도 신규인 행의 제외는 그대로 동작한다', async () => {
    const { repos } = await open();
    const result = await repos.requirements.importFromTable(input(FILE_ROWS, { excludedRows: [2] }));
    expect(result.requirements.map((item) => item.text)).toEqual(['애플 계정으로 로그인할 수 있다.', '네이버 계정으로 로그인할 수 있다.']);
    expect(result.summary).toEqual({ total: 4, created: 2, duplicate: 0, invalid: 1, excluded: 1 });
  });

  it('미리보기 뒤 같은 요구사항이 생기면: 제외했던 행은 오래된 판단이라 거부되고, 제외하지 않은 행은 다시 판정해 중복으로 건너뛴다', async () => {
    const { repos, base } = await open();
    // 미리보기 시점의 2행(카카오)은 신규였고 사용자가 제외했다. 그 뒤 같은 요구사항이 다른 가져오기로 생겼다.
    await repos.requirements.importFromTable(input([['소셜 로그인', '카카오 계정으로 로그인할 수 있다.', 'p.1', 'N']]));
    const before = { state: stored(base), activities: await repos.activities.list(), revision: ready(repos).revision };
    await expect(repos.requirements.importFromTable(input(FILE_ROWS, { excludedRows: [2] }))).rejects.toThrow('2행은 제외할 수 있는 요구사항 행이 아니에요.');
    expect(stored(base)).toEqual(before.state);
    expect(await repos.activities.list()).toEqual(before.activities);
    expect(ready(repos).revision).toBe(before.revision);
    // 제외하지 않았다면 중복이 된 2행은 만들지 않고 나머지만 만든다(기존 재판정 유지).
    const retry = await repos.requirements.importFromTable(input(FILE_ROWS));
    expect(retry.summary).toEqual({ total: 4, created: 2, duplicate: 1, invalid: 1, excluded: 0 });
  });
});
