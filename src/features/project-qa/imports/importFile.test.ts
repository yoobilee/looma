import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { createSeed } from '@/data/mock/seed';
import { analyzeResultImport, suggestResultColumnMapping } from '@/domain/testResultImport';
import { analyzeTestAssetImport, suggestColumnMapping, toImportTable, type ImportTable } from '@/domain/testAssetImport';
import { parseCsv } from '@/lib/csv';
import { readImportFile, type ImportFileSource } from './importFile';

/* ---------- fixture: 테스트가 직접 만드는 작은 XLSX (실제 고객사 정보 없음) ---------- */

type Cells = Record<string, XLSX.CellObject | undefined>;

/** 행 배열을 문자열 셀 시트로 만든다. 빈 문자열 셀은 만들지 않는다. */
function textSheet(rows: string[][]): XLSX.WorkSheet {
  return XLSX.utils.aoa_to_sheet(rows.map((row) => row.map((cell) => (cell === '' ? null : cell))));
}

/** 셀을 직접 지정한 시트. 날짜 · 수식처럼 값 종류를 고정해야 할 때 쓴다. */
function cellSheet(cells: Cells, ref: string): XLSX.WorkSheet {
  return { '!ref': ref, ...cells };
}

interface SheetFixture {
  name: string;
  sheet: XLSX.WorkSheet;
  hidden?: 0 | 1 | 2;
}

function xlsxFile(fileName: string, sheets: SheetFixture[]): File {
  const workbook = XLSX.utils.book_new();
  for (const { name, sheet } of sheets) XLSX.utils.book_append_sheet(workbook, sheet, name);
  workbook.Workbook = { Sheets: sheets.map((item) => ({ Hidden: item.hidden ?? 0 })) };
  const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new File([bytes], fileName);
}

const oneSheet = (rows: string[][], fileName = 'tc.xlsx') => xlsxFile(fileName, [{ name: 'TC', sheet: textSheet(rows) }]);

async function open(file: File): Promise<ImportFileSource> {
  const result = await readImportFile(file);
  if (!result.ok) throw new Error(`열지 못했어요: ${result.message}`);
  return result.source;
}

async function tableOf(file: File, sheetName?: string): Promise<ImportTable> {
  const source = await open(file);
  const result = source.readTable(sheetName ?? source.sheetNames[0]);
  if (!result.ok) throw new Error(`표로 읽지 못했어요: ${result.message}`);
  return result.table;
}

async function failureOf(file: File, sheetName?: string): Promise<string> {
  const result = await readImportFile(file);
  if (!result.ok) return result.message;
  const table = result.source.readTable(sheetName ?? result.source.sheetNames[0]);
  if (table.ok) throw new Error('실패해야 하는 파일이 읽혔어요.');
  return table.message;
}

const csvFile = (text: string, fileName = 'tc.csv') => new File([text], fileName);

/* ---------- CSV: 기존 동작 그대로 ---------- */

describe('CSV 가져오기 (기존 동작)', () => {
  it('CSV는 시트 선택 없이 기존 parseCsv · toImportTable 결과와 같은 표가 된다', async () => {
    const text = 'TC ID,테스트 항목\r\nSIGN-001,"줄바꿈\n있는 셀"\r\n\r\nSIGN-002,로그인\r\n';
    const source = await open(csvFile(text));
    expect(source.format).toBe('csv');
    expect(source.sheetNames).toEqual([]);
    expect(await tableOf(csvFile(text))).toEqual(toImportTable(parseCsv(text)));
  });

  it('내용이 없거나 헤더만 있는 CSV는 이유를 알려 준다', async () => {
    expect(await failureOf(csvFile('\n\n'))).toBe('파일에 내용이 없어요.');
    expect(await failureOf(csvFile('TC ID,결과\n'))).toBe('헤더 아래에 데이터 행이 없어요.');
  });
});

/* ---------- 지원 형식과 오류 ---------- */

describe('지원 형식 · 오류', () => {
  it('.xls · .xlsm · .ods와 그 밖의 확장자는 사유를 알려 주고 읽지 않는다', async () => {
    for (const name of ['a.xls', 'a.xlsm', 'a.ods']) {
      const result = await readImportFile(new File(['x'], name));
      expect(result).toMatchObject({ ok: false });
      expect(result.ok === false && result.message).toContain('지원하지 않아요');
    }
    for (const name of ['a.txt', 'a.pdf', 'noextension']) {
      const result = await readImportFile(new File(['x'], name));
      expect(result).toEqual({ ok: false, message: 'CSV와 XLSX 파일만 가져올 수 있어요.' });
    }
  });

  it('확장자 대소문자는 구분하지 않는다', async () => {
    expect((await open(oneSheet([['A'], ['1']], 'TC.XLSX'))).format).toBe('xlsx');
    expect((await open(csvFile('A\n1', 'TC.CSV'))).format).toBe('csv');
  });

  it('XLSX가 아닌데 .xlsx로 끝나는 파일과 손상된 파일은 읽지 않고 안내한다', async () => {
    const reading = 'XLSX 파일을 읽지 못했어요. 암호가 걸려 있거나 손상된 파일일 수 있어요.';
    expect(await readImportFile(csvFile('TC ID,결과\nSIGN-001,P', 'renamed.xlsx'))).toEqual({ ok: false, message: reading });
    const zipHeaderOnly = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4])], 'broken.xlsx');
    expect(await readImportFile(zipHeaderOnly)).toEqual({ ok: false, message: reading });
  });

  it('5MB를 넘는 파일은 읽지 않는다', async () => {
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.xlsx');
    expect(await readImportFile(big)).toEqual({ ok: false, message: '5MB 이하 파일만 가져올 수 있어요.' });
  });

  it('빈 시트 · 헤더만 있는 시트 · 시트를 고르지 않은 경우를 구분해 안내한다', async () => {
    const file = xlsxFile('x.xlsx', [
      { name: '빈 시트', sheet: cellSheet({}, 'A1') },
      { name: '헤더만', sheet: textSheet([['TC ID', '결과']]) },
      { name: '정상', sheet: textSheet([['TC ID', '결과'], ['SIGN-001', 'P']]) },
    ]);
    expect(await failureOf(file, '빈 시트')).toBe('선택한 시트에 내용이 없어요.');
    expect(await failureOf(file, '헤더만')).toBe('헤더 아래에 데이터 행이 없어요.');
    const source = await open(file);
    expect(source.readTable()).toEqual({ ok: false, message: '가져올 시트를 선택해 주세요.' });
    expect(source.readTable('없는 시트')).toEqual({ ok: false, message: '가져올 시트를 선택해 주세요.' });
  });
});

/* ---------- 시트 ---------- */

describe('XLSX 시트', () => {
  it('보이는 시트가 하나면 시트 목록은 그 하나뿐이다', async () => {
    const source = await open(oneSheet([['A'], ['1']]));
    expect(source.format).toBe('xlsx');
    expect(source.sheetNames).toEqual(['TC']);
  });

  it('보이는 시트가 둘 이상이면 워크북 순서를 유지하고, 시트를 바꾸면 다른 표를 돌려준다', async () => {
    const file = xlsxFile('multi.xlsx', [
      { name: '표지', sheet: textSheet([['버전'], ['v1']]) },
      { name: 'TC', sheet: textSheet([['TC ID', '테스트 항목'], ['SIGN-001', '로그인']]) },
      { name: '결과', sheet: textSheet([['TC ID', '결과', '비고'], ['SIGN-001', 'P', ''], ['SIGN-002', 'F', '재현']]) },
    ]);
    const source = await open(file);
    expect(source.sheetNames).toEqual(['표지', 'TC', '결과']);

    const tc = await tableOf(file, 'TC');
    const result = await tableOf(file, '결과');
    expect(tc.headers).toEqual(['TC ID', '테스트 항목']);
    expect(tc.rows).toHaveLength(1);
    expect(result.headers).toEqual(['TC ID', '결과', '비고']);
    expect(result.rows).toHaveLength(2);
  });

  it('숨김 · 매우 숨김 시트는 목록에서 뺀다', async () => {
    const file = xlsxFile('hidden.xlsx', [
      { name: '보임1', sheet: textSheet([['A'], ['1']]) },
      { name: '숨김', sheet: textSheet([['A'], ['2']]), hidden: 1 },
      { name: '매우 숨김', sheet: textSheet([['A'], ['3']]), hidden: 2 },
      { name: '보임2', sheet: textSheet([['A'], ['4']]) },
    ]);
    expect((await open(file)).sheetNames).toEqual(['보임1', '보임2']);
    // 숨긴 시트는 이름을 알아도 읽지 않는다.
    expect((await open(file)).readTable('숨김')).toEqual({ ok: false, message: '가져올 시트를 선택해 주세요.' });
  });

  it('보이는 시트가 하나도 없으면 오류로 안내한다', async () => {
    const file = xlsxFile('allhidden.xlsx', [
      { name: 'A', sheet: textSheet([['A'], ['1']]), hidden: 1 },
      { name: 'B', sheet: textSheet([['A'], ['1']]), hidden: 2 },
    ]);
    expect(await readImportFile(file)).toEqual({ ok: false, message: '사용할 수 있는 시트가 없어요. 숨겨진 시트만 있거나 시트가 비어 있어요.' });
  });
});

/* ---------- 셀 값 ---------- */

describe('XLSX 셀 값', () => {
  it('문자열 · 빈 셀 · 한글과 이모지 · 긴 문자열을 그대로 넘긴다', async () => {
    const long = '가'.repeat(10_000);
    const table = await tableOf(oneSheet([['TC ID', '테스트 항목', '비고'], ['SIGN-001', '로그인 😀 성공', ''], ['', long, '메모']]));
    expect(table.headers).toEqual(['TC ID', '테스트 항목', '비고']);
    expect(table.rows[0].cells).toEqual(['SIGN-001', '로그인 😀 성공', '']);
    expect(table.rows[1].cells).toEqual(['', long, '메모']);
  });

  it('셀 안의 줄바꿈과 앞뒤 공백은 그대로 둔다(정리는 가져오기 도메인이 한다)', async () => {
    const table = await tableOf(oneSheet([['단계'], ['1. 열기\n2. 입력\n\n3. 확인'], ['  공백  ']]));
    expect(table.rows[0].cells[0]).toBe('1. 열기\n2. 입력\n\n3. 확인');
    expect(table.rows[1].cells[0]).toBe('  공백  ');
  });

  it('문자열로 저장된 TC ID "00123"은 앞의 0을 유지한다', async () => {
    const table = await tableOf(oneSheet([['TC ID'], ['00123'], ['007']]));
    expect(table.rows.map((row) => row.cells[0])).toEqual(['00123', '007']);
  });

  it('숫자 셀은 Excel에 보이는 표기로 읽고, 없는 앞자리 0을 만들지 않는다', async () => {
    const table = await tableOf(
      xlsxFile('n.xlsx', [
        {
          name: 'N',
          sheet: cellSheet(
            {
              A1: { t: 's', v: '값' },
              A2: { t: 'n', v: 123 },
              A3: { t: 'n', v: 12.5 },
              A4: { t: 'n', v: 7, z: '000' }, // 서식으로 007로 보이는 숫자
              A5: { t: 'n', v: 1234.5, z: '#,##0.00' },
              A6: { t: 'n', v: 0.25, z: '0%' },
            },
            'A1:A6',
          ),
        },
      ]),
    );
    expect(table.rows.map((row) => row.cells[0])).toEqual(['123', '12.5', '007', '1,234.50', '25%']);
  });

  it('boolean은 TRUE / FALSE', async () => {
    const table = await tableOf(
      xlsxFile('b.xlsx', [{ name: 'B', sheet: cellSheet({ A1: { t: 's', v: '값' }, A2: { t: 'b', v: true }, A3: { t: 'b', v: false } }, 'A1:A3') }]),
    );
    expect(table.rows.map((row) => row.cells[0])).toEqual(['TRUE', 'FALSE']);
  });

  it('날짜는 시리얼 번호가 아니라 읽을 수 있는 날짜 문자열로 읽는다', async () => {
    const table = await tableOf(
      xlsxFile('d.xlsx', [
        {
          name: 'D',
          sheet: cellSheet(
            {
              A1: { t: 's', v: '일자' },
              A2: { t: 'n', v: 46295, z: 'yyyy-mm-dd' }, // 2026-09-30
              A3: { t: 'n', v: 46295, z: 'm/d/yy' },
              A4: { t: 'n', v: 46295.5625, z: 'yyyy-mm-dd hh:mm' }, // 13:30
              A5: { t: 'n', v: 0.5, z: 'hh:mm' }, // 시각만
            },
            'A1:A5',
          ),
        },
      ]),
    );
    expect(table.rows.map((row) => row.cells[0])).toEqual(['2026-09-30', '2026-09-30', '2026-09-30 13:30', '12:00']);
  });

  it('수식은 저장된 계산 결과를 읽고, 계산 결과가 없으면 비워 두며 알린다', async () => {
    const file = xlsxFile('f.xlsx', [
      {
        name: 'F',
        sheet: cellSheet(
          {
            A1: { t: 's', v: '값' },
            A2: { t: 'n', f: 'SUM(1,2)', v: 3 },
            A3: { t: 'n', f: 'A2*2' }, // 계산 결과가 저장되지 않은 수식
            A4: { t: 's', f: 'CONCAT("a","b")', v: 'ab' },
          },
          'A1:A4',
        ),
      },
    ]);
    const source = await open(file);
    const result = source.readTable('F');
    expect(result.ok && result.table.rows.map((row) => row.cells[0])).toEqual(['3', '', 'ab']);
    expect(result.ok && result.notes).toHaveLength(1);
    expect(result.ok && result.notes[0]).toContain('수식 1칸');
  });

  it('병합 셀의 값을 다른 칸에 복제하지 않는다', async () => {
    const sheet = textSheet([['기능', '항목'], ['로그인', 'A'], ['', 'B'], ['', 'C']]);
    sheet['!merges'] = [{ s: { r: 1, c: 0 }, e: { r: 3, c: 0 } }];
    const table = await tableOf(xlsxFile('m.xlsx', [{ name: 'M', sheet }]));
    expect(table.rows.map((row) => row.cells)).toEqual([['로그인', 'A'], ['', 'B'], ['', 'C']]);
  });
});

/* ---------- 표 구조 ---------- */

describe('XLSX → ImportTable', () => {
  it('완전히 빈 행도 CSV처럼 데이터 행으로 남기고, 맨 끝의 빈 행은 만들지 않는다', async () => {
    const sheet = textSheet([['TC ID', '결과'], ['SIGN-001', 'P'], ['', ''], ['SIGN-002', 'F']]);
    const table = await tableOf(xlsxFile('blank.xlsx', [{ name: 'S', sheet }]));
    expect(table.rows.map((row) => [row.rowNumber, row.cells])).toEqual([
      [2, ['SIGN-001', 'P']],
      [3, ['', '']],
      [4, ['SIGN-002', 'F']],
    ]);
  });

  it('위쪽 빈 행과 왼쪽 빈 열을 건너뛰어도 행 번호는 시트의 행 번호와 같다', async () => {
    const file = xlsxFile('offset.xlsx', [
      {
        name: 'S',
        sheet: cellSheet(
          {
            B3: { t: 's', v: 'TC ID' },
            C3: { t: 's', v: '결과' },
            B4: { t: 's', v: 'SIGN-001' },
            C4: { t: 's', v: 'P' },
            B6: { t: 's', v: 'SIGN-002' },
          },
          'B3:C6',
        ),
      },
    ]);
    const table = await tableOf(file);
    expect(table.headers).toEqual(['TC ID', '결과']);
    expect(table.rows.map((row) => [row.rowNumber, row.cells])).toEqual([
      [4, ['SIGN-001', 'P']],
      [5, ['', '']],
      [6, ['SIGN-002', '']],
    ]);
  });

  it('값이 없는 서식 전용 셀이 범위를 부풀리지 않는다', async () => {
    const sheet = textSheet([['A', 'B'], ['1', '2']]);
    sheet.C500 = { t: 'z' };
    sheet['!ref'] = 'A1:C500';
    const table = await tableOf(xlsxFile('stub.xlsx', [{ name: 'S', sheet }]));
    expect(table.headers).toEqual(['A', 'B']);
    expect(table.rows).toHaveLength(1);
  });

  it('이름 없는 헤더 칸은 CSV처럼 "열 N"이 된다', async () => {
    const sheet = textSheet([['TC ID', '', '결과'], ['SIGN-001', 'x', 'P']]);
    expect((await tableOf(xlsxFile('h.xlsx', [{ name: 'S', sheet }]))).headers).toEqual(['TC ID', '열 2', '결과']);
  });
});

/* ---------- 기존 가져오기 분석으로 이어지는지 ---------- */

describe('XLSX와 CSV는 같은 ImportTable이 된다', () => {
  const rows = [
    ['TC ID', '대분류', '테스트 항목', 'Pre-condition', 'Expected Result'],
    ['SIGN-001', '회원가입', '이메일로 가입', '앱 설치', '가입 완료'],
    ['', '회원가입', '약관 동의', '', '다음 단계로 이동'],
  ];
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const asCsv = (data: string[][]) => data.map((row) => row.map(quote).join(',')).join('\r\n');

  it('논리 데이터가 같으면 CSV와 XLSX의 ImportTable이 같다', async () => {
    const fromCsv = await tableOf(csvFile(asCsv(rows)));
    const fromXlsx = await tableOf(oneSheet(rows));
    expect(fromXlsx).toEqual(fromCsv);
  });

  it('XLSX TC 파일이 기존 TC 가져오기 분석에 그대로 들어간다', async () => {
    const seed = createSeed();
    const existing = seed.testCases.filter((item) => item.projectId === 'proj-client-a-mobile');
    const table = await tableOf(oneSheet(rows));
    const mapping = suggestColumnMapping(table.headers);
    const analysisFromXlsx = analyzeTestAssetImport(table, mapping, existing);
    const analysisFromCsv = analyzeTestAssetImport(await tableOf(csvFile(asCsv(rows))), mapping, existing);

    expect(analysisFromXlsx.fileProblems).toEqual([]);
    expect(analysisFromXlsx.rows).toHaveLength(2);
    expect(analysisFromXlsx).toEqual(analysisFromCsv);
  });

  it('XLSX 수행 결과 파일이 기존 수행 결과 분석에 그대로 들어간다', async () => {
    const seed = createSeed();
    const testCases = seed.testCases.filter((item) => item.projectId === 'proj-client-a-mobile');
    const resultRows = [
      ['TC ID', '결과'],
      ['SIGN-001', 'P'],
      ['SIGN-002', 'F'],
      ['NEW-404', 'OK'],
    ];
    const table = await tableOf(oneSheet(resultRows, 'result.xlsx'));
    const mapping = suggestResultColumnMapping(table.headers);
    const fromXlsx = analyzeResultImport(table, mapping, testCases, seed.templates[0].resultMappings);
    const fromCsv = analyzeResultImport(await tableOf(csvFile(asCsv(resultRows), 'result.csv')), mapping, testCases, seed.templates[0].resultMappings);

    expect(fromXlsx.rows.map((item) => item.kind)).toEqual(['matched', 'matched', 'unmatched']);
    expect(fromXlsx).toEqual(fromCsv);
  });
});
