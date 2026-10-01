/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseXml, XmlParseError } from './xml';
import { columnLetters, patchXlsx, resolveWorksheet, type XlsxCellPatch, type XlsxSheetLayout } from './xlsxPatch';

/* ---------- fixture ---------- */

/** openpyxl로 만든 서식 많은 가상 파일. 시트 4개(표지 · TC · 숨김 · 결과), 헤더는 B2부터, inline string 셀. */
const richBytes = () => new Uint8Array(readFileSync(fileURLToPath(new URL('./__fixtures__/style-rich.xlsx', import.meta.url))));
const TC_LAYOUT: XlsxSheetLayout = {
  sheetName: 'TC',
  headerRowNumber: 2,
  headers: ['TC ID', '대분류', '테스트 항목', 'Pre-condition', 'Test Step', 'Expected Result', '고객사 메모', '공수', '공수 합계', '작성일'],
};
const TC_SHEET_PATH = 'xl/worksheets/sheet2.xml';

/**
 * Excel처럼 sharedStrings를 쓰는 최소 패키지. 일부러 sheet7.xml · x: 접두사 · rich text · 발음(rPh)을 넣어
 * 경로를 짐작하거나 접두사를 가정하지 않는지 확인한다.
 */
function sharedStringPackage(options: { prefix?: string } = {}): Uint8Array {
  const p = options.prefix ? `${options.prefix}:` : '';
  const ns = options.prefix ? `xmlns:${options.prefix}` : 'xmlns';
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const files: Record<string, string> = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet7.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><${p}workbook ${ns}="${main}" xmlns:rel="${rel}"><${p}sheets><${p}sheet name="다른 시트" sheetId="1" rel:id="rIdOther"/><${p}sheet name="TC 목록" sheetId="2" rel:id="rIdTc"/></${p}sheets></${p}workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdTc" Type="${rel}/worksheet" Target="/xl/worksheets/sheet7.xml"/><Relationship Id="rIdOther" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rIdS" Type="${rel}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rIdSt" Type="${rel}/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${main}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1"/></xf></cellXfs></styleSheet>`,
    'xl/sharedStrings.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><${p}sst ${ns}="${main}" count="6" uniqueCount="6"><${p}si><${p}t>TC ID</${p}t></${p}si><${p}si><${p}t>테스트 항목</${p}t></${p}si><${p}si><${p}t>결과</${p}t></${p}si><${p}si><${p}t>SIGN-001</${p}t></${p}si><${p}si><${p}r><${p}t>로그인</${p}t></${p}r><${p}r><${p}rPr><${p}b/></${p}rPr><${p}t xml:space="preserve"> 성공</${p}t></${p}r><${p}rPh sb="0" eb="1"><${p}t>ロ</${p}t></${p}rPh></${p}si><${p}si><${p}t>P</${p}t></${p}si></${p}sst>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><${p}worksheet ${ns}="${main}"><${p}sheetData><${p}row r="1"><${p}c r="A1" t="s"><${p}v>3</${p}v></${p}c></${p}row></${p}sheetData></${p}worksheet>`,
    'xl/worksheets/sheet7.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<${p}worksheet ${ns}="${main}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac"><${p}cols><${p}col min="3" max="3" width="20" style="2" customWidth="1"/></${p}cols><${p}sheetData><${p}row r="1" spans="1:3" x14ac:dyDescent="0.25"><${p}c r="A1" s="1" t="s"><${p}v>0</${p}v></${p}c><${p}c r="B1" s="1" t="s"><${p}v>1</${p}v></${p}c><${p}c r="C1" s="1" t="s"><${p}v>2</${p}v></${p}c></${p}row><${p}row r="2" spans="1:3" ht="30" customHeight="1"><${p}c r="A2" t="s"><${p}v>3</${p}v></${p}c><${p}c r="B2" s="2" t="s"><${p}v>4</${p}v></${p}c></${p}row><${p}row r="3"><${p}c r="A3"><${p}v>42</${p}v></${p}c><${p}c r="B3" t="str"><${p}f>A3&amp;"!"</${p}f><${p}v>42!</${p}v></${p}c><${p}c r="C3" t="s"><${p}v>5</${p}v></${p}c></${p}row></${p}sheetData><${p}mergeCells count="1"><${p}mergeCell ref="A5:B5"/></${p}mergeCells></${p}worksheet>`,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)])));
}
const SST_LAYOUT: XlsxSheetLayout = { sheetName: 'TC 목록', headerRowNumber: 1, headers: ['TC ID', '테스트 항목', '결과'] };

const patch = (rowNumber: number, columnIndex: number, previousValue: string, nextValue: string): XlsxCellPatch => ({ rowNumber, columnIndex, previousValue, nextValue, label: '테스트' });

function ok(result: ReturnType<typeof patchXlsx>) {
  if (!result.ok) throw new Error(result.problems.join('\n'));
  return result;
}

/** SheetJS로 다시 읽은 시트의 셀 값(서식 반영 텍스트). 내보낸 파일이 다른 파서로도 읽히는지 확인한다. */
function sheetValues(bytes: Uint8Array, sheetName: string): Record<string, string> {
  const sheet = XLSX.read(bytes, { type: 'array', cellDates: true }).Sheets[sheetName];
  return Object.fromEntries(Object.keys(sheet).filter((key) => !key.startsWith('!')).map((key) => [key, String(sheet[key].w ?? sheet[key].v ?? '')]));
}

const entriesOf = (bytes: Uint8Array) => unzipSync(bytes);
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, index) => byte === b[index]);

/* ---------- XML parser ---------- */

describe('최소 XML parser', () => {
  it('원문 위치 · 접두사 · namespace · 엔티티를 읽는다', () => {
    const source = '<?xml version="1.0"?><x:a xmlns:x="urn:x" k=\'1 &amp; 2\'><x:b>&#54620;&lt;</x:b><![CDATA[<raw>]]><!-- c --><x:e/></x:a>';
    const root = parseXml(source);
    expect(root).toMatchObject({ name: 'x:a', prefix: 'x', localName: 'a' });
    expect(root.namespaces.get('x')).toBe('urn:x');
    expect(root.attributes[1]).toMatchObject({ name: 'k', value: '1 & 2' });
    const [b] = root.children.filter((child) => child.kind === 'element');
    expect(b.kind === 'element' && source.slice(b.start, b.end)).toBe('<x:b>&#54620;&lt;</x:b>');
  });

  it('DTD · 잘못 닫힌 태그 · 정의되지 않은 엔티티는 거부한다', () => {
    expect(() => parseXml('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>')).toThrow(XmlParseError);
    expect(() => parseXml('<a><b></a>')).toThrow(XmlParseError);
    expect(() => parseXml('<a>&nbsp;</a>')).toThrow(XmlParseError);
    expect(() => parseXml('<a>')).toThrow(XmlParseError);
  });
});

/* ---------- 시트 찾기 ---------- */

describe('워크시트 찾기', () => {
  it('workbook · workbook rels로 시트 이름에 맞는 파트를 찾는다(sheet1.xml을 짐작하지 않는다)', () => {
    expect(resolveWorksheet(entriesOf(richBytes()), 'TC').worksheetPath).toBe(TC_SHEET_PATH);
    expect(resolveWorksheet(entriesOf(richBytes()), '결과').worksheetPath).toBe('xl/worksheets/sheet4.xml');
    const shared = resolveWorksheet(entriesOf(sharedStringPackage()), 'TC 목록');
    expect(shared).toEqual({ worksheetPath: 'xl/worksheets/sheet7.xml', sharedStringsPath: 'xl/sharedStrings.xml' });
  });

  it('x: 접두사를 쓰는 패키지도 찾는다', () => {
    expect(resolveWorksheet(entriesOf(sharedStringPackage({ prefix: 'x' })), 'TC 목록').worksheetPath).toBe('xl/worksheets/sheet7.xml');
  });

  it('없는 시트면 멈춘다', () => {
    const result = patchXlsx(richBytes(), { ...TC_LAYOUT, sheetName: '없는 시트' }, [patch(3, 2, '이메일 가입', 'x')]);
    expect(result).toEqual({ ok: false, problems: ["원본 파일에서 '없는 시트' 시트를 찾을 수 없어요."] });
  });

  it('ZIP이 아니면 멈춘다', () => {
    expect(patchXlsx(new Uint8Array([1, 2, 3]), TC_LAYOUT, [patch(3, 2, 'a', 'b')])).toMatchObject({ ok: false });
  });
});

/* ---------- 셀 patch (서식 많은 fixture) ---------- */

describe('기존 셀 값 반영', () => {
  it('바꾼 셀만 값이 바뀌고 스타일 id(s)는 그대로다. 시트 XML의 나머지 원문도 그대로다', () => {
    const original = richBytes();
    const result = ok(patchXlsx(original, TC_LAYOUT, [patch(3, 2, '이메일 가입', '이메일로 가입')]));
    expect(result.changedCells).toEqual(['D3']);

    const before = strFromU8(entriesOf(original)[TC_SHEET_PATH]);
    const after = strFromU8(entriesOf(result.bytes)[TC_SHEET_PATH]);
    const oldCell = /<c r="D3"[^>]*>.*?<\/c>/s.exec(before)![0];
    const newCell = /<c r="D3"[^>]*>.*?<\/c>/s.exec(after)![0];
    expect(oldCell).toMatch(/ s="3"/);
    expect(newCell).toBe('<c r="D3" s="3" t="inlineStr"><is><t xml:space="preserve">이메일로 가입</t></is></c>');
    expect(after).toBe(before.replace(oldCell, newCell));

    const valuesBefore = sheetValues(original, 'TC');
    const valuesAfter = sheetValues(result.bytes, 'TC');
    expect(valuesAfter.D3).toBe('이메일로 가입');
    expect({ ...valuesAfter, D3: valuesBefore.D3 }).toEqual(valuesBefore);
  });

  it('다른 파트(styles · theme · workbook · rels · 다른 시트 · 숨긴 시트)는 내용이 그대로다', () => {
    const original = entriesOf(richBytes());
    const exported = entriesOf(ok(patchXlsx(richBytes(), TC_LAYOUT, [patch(3, 2, '이메일 가입', '바뀜')])).bytes);
    expect(Object.keys(exported).sort()).toEqual(Object.keys(original).sort());
    for (const path of Object.keys(original)) {
      if (path === TC_SHEET_PATH) continue;
      expect(sameBytes(exported[path], original[path]), path).toBe(true);
    }
  });

  it('병합 · 열 너비 · 행 높이 · 숫자/날짜 서식 셀은 바뀌지 않는다', () => {
    const result = ok(patchXlsx(richBytes(), TC_LAYOUT, [patch(3, 2, '이메일 가입', '바뀜'), patch(4, 4, '1. 약관을 연다.','1. 약관을 연다.\n2. 동의한다.')]));
    const after = XLSX.read(result.bytes, { type: 'array', cellStyles: true, cellNF: true }).Sheets.TC;
    const before = XLSX.read(richBytes(), { type: 'array', cellStyles: true, cellNF: true }).Sheets.TC;
    expect(after['!merges']).toEqual(before['!merges']);
    expect(after['!cols']).toEqual(before['!cols']);
    expect(after['!rows']).toEqual(before['!rows']);
    expect(after.I3.z).toBe('#,##0.00');
    expect(after.K3.z).toBe(before.K3.z);
  });

  it('줄바꿈 · 한글 · 이모지 · XML 특수 문자 · 앞뒤 공백 · _xHHHH_ 모양 문자열을 그대로 쓴다', () => {
    const value = '  <a & b> "따옴표" \'홑\' 😀\n둘째 줄\r\n셋째 줄 _x000D_ 끝  ';
    const result = ok(patchXlsx(richBytes(), TC_LAYOUT, [patch(3, 5, '가입 완료', value)]));
    expect(sheetValues(result.bytes, 'TC').G3).toBe(value.replace(/\r\n/g, '\n'));
  });

  it('가져올 때 비어 있던(셀이 없던) 칸에도 값을 쓸 수 있다', () => {
    const result = ok(patchXlsx(richBytes(), TC_LAYOUT, [patch(5, 3, '', '로그인 화면')]));
    expect(result.changedCells).toEqual(['E5']);
    expect(sheetValues(result.bytes, 'TC').E5).toBe('로그인 화면');
    // 새 셀은 같은 행의 셀 순서를 지킨다(H5는 병합 영역이라 원본에 스타일만 있는 셀로 있다).
    const xml = strFromU8(entriesOf(result.bytes)[TC_SHEET_PATH]);
    const row5 = /<row r="5".*?<\/row>/s.exec(xml)![0];
    expect([...row5.matchAll(/<c r="([A-Z]+)5"/g)].map((match) => match[1])).toEqual(['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']);
  });

  it('값을 비우면 셀 값만 지우고 스타일은 남긴다', () => {
    const result = ok(patchXlsx(richBytes(), TC_LAYOUT, [patch(4, 3, '가입 화면', '')]));
    const xml = strFromU8(entriesOf(result.bytes)[TC_SHEET_PATH]);
    expect(/<c r="E4"[^>]*\/>/.exec(xml)![0]).toBe('<c r="E4" s="3"/>');
    expect(sheetValues(result.bytes, 'TC').E4 ?? '').toBe('');
  });

  it('바꿀 셀이 없으면 원본 bytes를 그대로 돌려준다', () => {
    const original = richBytes();
    const result = ok(patchXlsx(original, TC_LAYOUT, []));
    expect(sameBytes(result.bytes, original)).toBe(true);
    expect(result.bytes).not.toBe(original);
  });

  it('원본 bytes를 바꾸지 않는다', () => {
    const original = richBytes();
    const copy = original.slice();
    ok(patchXlsx(original, TC_LAYOUT, [patch(3, 2, '이메일 가입', '바뀜')]));
    expect(sameBytes(original, copy)).toBe(true);
  });
});

/* ---------- shared string 패키지 ---------- */

describe('shared string · 접두사 패키지', () => {
  for (const prefix of [undefined, 'x']) {
    it(`shared string 셀을 inline string으로 바꾸고 sharedStrings는 고치지 않는다${prefix ? ' (x: 접두사)' : ''}`, () => {
      const original = sharedStringPackage({ prefix });
      const result = ok(patchXlsx(original, SST_LAYOUT, [patch(2, 1, '로그인 성공', '로그인 실패 처리')]));
      const before = entriesOf(original);
      const after = entriesOf(result.bytes);
      expect(sameBytes(after['xl/sharedStrings.xml'], before['xl/sharedStrings.xml'])).toBe(true);
      expect(sameBytes(after['xl/worksheets/sheet1.xml'], before['xl/worksheets/sheet1.xml'])).toBe(true);
      const xml = strFromU8(after['xl/worksheets/sheet7.xml']);
      const p = prefix ? `${prefix}:` : '';
      expect(xml).toContain(`<${p}c r="B2" s="2" t="inlineStr"><${p}is><${p}t xml:space="preserve">로그인 실패 처리</${p}t></${p}is></${p}c>`);
      // XML 선언 · namespace 선언 · mc:Ignorable 등 시트 머리글은 원문 그대로다.
      const head = (text: string) => text.slice(0, text.indexOf('<' + p + 'sheetData'));
      expect(head(xml)).toBe(head(strFromU8(before['xl/worksheets/sheet7.xml'])));
      expect(sheetValues(result.bytes, 'TC 목록').B2).toBe('로그인 실패 처리');
      expect(sheetValues(result.bytes, '다른 시트').A1).toBe('SIGN-001');
    });
  }

  it('rich text shared string은 발음 표시를 빼고 이어 붙인 값으로 비교한다', () => {
    const result = patchXlsx(sharedStringPackage(), SST_LAYOUT, [patch(2, 1, '로그인 성공ロ', 'x')]);
    expect(result).toMatchObject({ ok: false });
    expect(ok(patchXlsx(sharedStringPackage(), SST_LAYOUT, [patch(2, 1, '로그인 성공', 'x')])).changedCells).toEqual(['B2']);
  });

  it('새 셀은 열 서식(style)을 이어받는다', () => {
    const result = ok(patchXlsx(sharedStringPackage(), SST_LAYOUT, [patch(2, 2, '', 'P')]));
    expect(strFromU8(entriesOf(result.bytes)['xl/worksheets/sheet7.xml'])).toContain('<c r="C2" s="2" t="inlineStr">');
  });
});

/* ---------- 거부 ---------- */

describe('검증 실패 시 파일을 만들지 않는다', () => {
  it('수식 셀은 바꾸지 않고 전체를 멈춘다', () => {
    const fromFixture = patchXlsx(richBytes(), TC_LAYOUT, [patch(3, 2, '이메일 가입', '바뀜'), patch(3, 8, '', '3')]);
    expect(fromFixture.ok).toBe(false);
    expect(!fromFixture.ok && fromFixture.problems).toEqual([expect.stringContaining('J3(테스트): 수식 셀이라')]);
    const cached = patchXlsx(sharedStringPackage(), SST_LAYOUT, [patch(3, 1, '42!', '바뀜')]);
    expect(!cached.ok && cached.problems[0]).toContain('B3(테스트): 수식 셀이라');
  });

  it('헤더가 가져올 때와 다르면 멈춘다(열 위치를 믿을 수 없다)', () => {
    const result = patchXlsx(richBytes(), { ...TC_LAYOUT, headers: ['TC ID', '기능', ...TC_LAYOUT.headers.slice(2)] }, [patch(3, 2, '이메일 가입', 'x')]);
    expect(!result.ok && result.problems).toEqual([expect.stringContaining('C2 헤더가 가져올 때와 달라요')]);
  });

  it('셀 값이 가져올 때와 다르면 멈춘다(다른 파일일 수 있다)', () => {
    const result = patchXlsx(richBytes(), TC_LAYOUT, [patch(3, 2, '다른 값', 'x')]);
    expect(!result.ok && result.problems[0]).toContain('셀 값이 가져올 때와 달라요');
  });

  it('같은 셀을 두 번 바꾸거나, 행이 없거나, 파일에 쓸 수 없는 문자면 멈춘다', () => {
    const duplicate = patchXlsx(richBytes(), TC_LAYOUT, [patch(3, 2, '이메일 가입', 'a'), patch(3, 2, '이메일 가입', 'b')]);
    expect(!duplicate.ok && duplicate.problems[0]).toContain('같은 셀을 두 번');
    const missingRow = patchXlsx(richBytes(), TC_LAYOUT, [patch(40, 2, '', 'a')]);
    expect(!missingRow.ok && missingRow.problems[0]).toContain('40행을 찾을 수 없어요');
    const control = patchXlsx(richBytes(), TC_LAYOUT, [patch(3, 2, '이메일 가입', 'a\u0001b')]);
    expect(!control.ok && control.problems[0]).toContain('제어 문자');
  });

  it('문제가 여럿이면 모두 알려 준다', () => {
    const result = patchXlsx(richBytes(), TC_LAYOUT, [patch(3, 2, '다른 값', 'x'), patch(3, 8, '', '1'), patch(40, 2, '', 'a')]);
    expect(!result.ok && result.problems).toHaveLength(3);
  });
});

describe('열 주소', () => {
  it('0부터 센 열 번호를 A · Z · AA · XFD로 바꾼다', () => {
    expect([0, 25, 26, 701, 702, 16383].map(columnLetters)).toEqual(['A', 'Z', 'AA', 'ZZ', 'AAA', 'XFD']);
  });
});
