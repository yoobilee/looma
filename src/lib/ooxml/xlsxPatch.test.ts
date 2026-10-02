/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { parseXml, XML_LIMITS, XmlParseError } from './xml';
import { columnLetters, patchXlsx, resolveWorksheet, type XlsxCellPatch, type XlsxRowAppend, type XlsxSheetLayout } from './xlsxPatch';
import { readZipDirectory, unzipPackage, ZIP_LIMITS } from './zipPackage';

/* ---------- fixture ---------- */

/** openpyxl로 만든 서식 많은 가상 파일. 시트 4개(표지 · TC · 숨김 · 결과), 헤더는 B2부터, inline string 셀. */
const richBytes = () => new Uint8Array(readFileSync(fileURLToPath(new URL('./__fixtures__/style-rich.xlsx', import.meta.url))));
const TC_LAYOUT: XlsxSheetLayout = {
  sheetName: 'TC',
  headerRowNumber: 2,
  headers: ['TC ID', '대분류', '테스트 항목', 'Pre-condition', 'Test Step', 'Expected Result', '고객사 메모', '공수', '공수 합계', '작성일'],
};
const TC_SHEET_PATH = 'xl/worksheets/sheet2.xml';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

interface PackageParts {
  /** sheetData 안의 2행부터 */
  rows?: string;
  /** sheetData 뒤(mergeCells 등) */
  tail?: string;
  /** 시트 XML 전체를 직접 줄 때 */
  sheetXml?: string;
  sheetBytes?: Uint8Array;
  sst?: string;
  workbookRels?: string;
  workbook?: string;
  packageRels?: string;
}

/** 헤더(A1 'TC ID', B1 '항목')가 있는 최소 패키지. 셀 형식 · 구조 실험에 쓴다. */
function makePackage(parts: PackageParts = {}): Uint8Array {
  const sheet =
    parts.sheetXml ??
    `${DECL}<worksheet xmlns="${MAIN}" xmlns:r="${REL}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>TC ID</t></is></c><c r="B1" t="inlineStr"><is><t>항목</t></is></c></row>${parts.rows ?? ''}</sheetData>${parts.tail ?? ''}</worksheet>`;
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`),
    '_rels/.rels': strToU8(parts.packageRels ?? `${DECL}<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(parts.workbook ?? `${DECL}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="TC" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(
      parts.workbookRels ??
        `${DECL}<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>${parts.sst ? `<Relationship Id="rId2" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>` : ''}</Relationships>`,
    ),
    'xl/worksheets/sheet1.xml': parts.sheetBytes ?? strToU8(sheet),
  };
  if (parts.sst) files['xl/sharedStrings.xml'] = strToU8(`${DECL}<sst xmlns="${MAIN}">${parts.sst}</sst>`);
  return zipSync(files);
}
const LAYOUT: XlsxSheetLayout = { sheetName: 'TC', headerRowNumber: 1, headers: ['TC ID', '항목'] };
const str = (ref: string, text: string, extra = '') => `<c r="${ref}"${extra} t="inlineStr"><is><t>${text}</t></is></c>`;
const row2 = (cells: string) => `<row r="2">${str('A2', 'SIGN-001')}${cells}</row>`;

/**
 * Excel처럼 sharedStrings를 쓰는 패키지. 일부러 sheet7.xml · x: 접두사 · 절대 경로 Target을 넣어
 * 경로를 짐작하거나 접두사를 가정하지 않는지 확인한다.
 */
function sharedStringPackage(options: { prefix?: string } = {}): Uint8Array {
  const p = options.prefix ? `${options.prefix}:` : '';
  const ns = options.prefix ? `xmlns:${options.prefix}` : 'xmlns';
  const files: Record<string, string> = {
    '[Content_Types].xml': `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet7.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels': `${DECL}<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `${DECL}<${p}workbook ${ns}="${MAIN}" xmlns:rel="${REL}"><${p}sheets><${p}sheet name="다른 시트" sheetId="1" rel:id="rIdOther"/><${p}sheet name="TC 목록" sheetId="2" rel:id="rIdTc"/></${p}sheets></${p}workbook>`,
    'xl/_rels/workbook.xml.rels': `${DECL}<Relationships xmlns="${PKG}"><Relationship Id="rIdTc" Type="${REL}/worksheet" Target="/xl/worksheets/sheet7.xml"/><Relationship Id="rIdOther" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rIdS" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rIdSt" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `${DECL}<styleSheet xmlns="${MAIN}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1"/></xf></cellXfs></styleSheet>`,
    'xl/sharedStrings.xml': `${DECL}<${p}sst ${ns}="${MAIN}" count="7" uniqueCount="7"><${p}si><${p}t>TC ID</${p}t></${p}si><${p}si><${p}t>테스트 항목</${p}t></${p}si><${p}si><${p}t>결과</${p}t></${p}si><${p}si><${p}t>SIGN-001</${p}t></${p}si><${p}si><${p}t>로그인 성공</${p}t></${p}si><${p}si><${p}t>P</${p}t></${p}si><${p}si><${p}r><${p}t>로그인</${p}t></${p}r><${p}r><${p}rPr><${p}b/></${p}rPr><${p}t xml:space="preserve"> 실패</${p}t></${p}r></${p}si></${p}sst>`,
    'xl/worksheets/sheet1.xml': `${DECL}<${p}worksheet ${ns}="${MAIN}"><${p}sheetData><${p}row r="1"><${p}c r="A1" t="s"><${p}v>3</${p}v></${p}c></${p}row></${p}sheetData></${p}worksheet>`,
    'xl/worksheets/sheet7.xml': `${DECL}\r\n<${p}worksheet ${ns}="${MAIN}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac"><${p}sheetData><${p}row r="1" spans="1:3" x14ac:dyDescent="0.25"><${p}c r="A1" s="1" t="s"><${p}v>0</${p}v></${p}c><${p}c r="B1" s="1" t="s"><${p}v>1</${p}v></${p}c><${p}c r="C1" s="1" t="s"><${p}v>2</${p}v></${p}c></${p}row><${p}row r="2" spans="1:3" ht="30" customHeight="1"><${p}c r="A2" t="s"><${p}v>3</${p}v></${p}c><${p}c r="B2" s="2" t="s"><${p}v>4</${p}v></${p}c><${p}c r="C2" s="2" t="s"><${p}v>5</${p}v></${p}c></${p}row><${p}row r="3"><${p}c r="A3" t="s"><${p}v>3</${p}v></${p}c><${p}c r="B3" t="s"><${p}v>6</${p}v></${p}c></${p}row></${p}sheetData><${p}mergeCells count="1"><${p}mergeCell ref="A5:B5"/></${p}mergeCells></${p}worksheet>`,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)])));
}
const SST_LAYOUT: XlsxSheetLayout = { sheetName: 'TC 목록', headerRowNumber: 1, headers: ['TC ID', '테스트 항목', '결과'] };

const patch = (rowNumber: number, columnIndex: number, previousValue: string, nextValue: string): XlsxCellPatch => ({ rowNumber, columnIndex, previousValue, nextValue, label: '테스트' });

function ok(result: ReturnType<typeof patchXlsx>) {
  if (!result.ok) throw new Error(result.problems.join('\n'));
  return result;
}
function problemsOf(result: ReturnType<typeof patchXlsx>): string[] {
  if (result.ok) throw new Error('실패해야 하는 내보내기가 성공했어요.');
  return result.problems;
}

/** SheetJS로 다시 읽은 시트의 셀 값(서식 반영 텍스트). 내보낸 파일이 다른 파서로도 읽히는지 확인한다. */
function sheetValues(bytes: Uint8Array, sheetName: string): Record<string, string> {
  const sheet = XLSX.read(bytes, { type: 'array', cellDates: true }).Sheets[sheetName];
  return Object.fromEntries(Object.keys(sheet).filter((key) => !key.startsWith('!')).map((key) => [key, String(sheet[key].w ?? sheet[key].v ?? '')]));
}

const entriesOf = (bytes: Uint8Array) => unzipSync(bytes);
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, index) => byte === b[index]);

/** 같은 길이의 항목 이름을 ZIP bytes 안에서 바꿔 친다(로컬 헤더 · 중앙 디렉터리 모두). */
function renameEntry(bytes: Uint8Array, from: string, to: string): Uint8Array {
  const a = strToU8(from);
  const b = strToU8(to);
  if (a.length !== b.length) throw new Error('이름 길이가 같아야 해요.');
  const out = bytes.slice();
  for (let index = 0; index <= out.length - a.length; index += 1) {
    if (a.every((byte, offset) => out[index + offset] === byte)) out.set(b, index);
  }
  return out;
}

/* ---------- XML parser ---------- */

describe('엄격한 XML parser', () => {
  it('원문 위치 · 접두사 · namespace · 엔티티를 읽는다', () => {
    const source = '<?xml version="1.0"?><x:a xmlns:x="urn:x" k=\'1 &amp; 2\'><x:b>&#54620;&lt;</x:b><![CDATA[<raw>]]><!-- c --><x:e/></x:a>';
    const root = parseXml(source);
    expect(root).toMatchObject({ name: 'x:a', prefix: 'x', localName: 'a', namespaceUri: 'urn:x' });
    expect(root.attributes[1]).toMatchObject({ name: 'k', value: '1 & 2' });
    const [b] = root.children.filter((child) => child.kind === 'element');
    expect(b.kind === 'element' && source.slice(b.start, b.end)).toBe('<x:b>&#54620;&lt;</x:b>');
  });

  const invalid: [string, string][] = [
    ['DTD · 엔티티 선언', '<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>'],
    ['잘못 닫힌 태그', '<a><b></a>'],
    ['정의되지 않은 엔티티', '<a>&nbsp;</a>'],
    ['닫히지 않은 요소', '<a>'],
    ['XML 1.0 제어 문자', '<a>\u0001</a>'],
    ['속성 값의 제어 문자', '<a b="\u0008"/>'],
    ['쓸 수 없는 숫자 참조(&#1;)', '<a>&#1;</a>'],
    ['쓸 수 없는 숫자 참조(surrogate)', '<a>&#xD800;</a>'],
    ['범위 밖 숫자 참조', '<a>&#x110000;</a>'],
    ['선언하지 않은 요소 접두사', '<a><x:b/></a>'],
    ['선언하지 않은 속성 접두사', '<a x:b="1"/>'],
    ['속성 사이 공백 없음', '<a b="1"c="2"/>'],
    ['namespace를 풀면 같은 속성', '<a xmlns:p="urn:x" xmlns:q="urn:x" p:b="1" q:b="2"/>'],
    ['주석 안의 --', '<a><!-- a -- b --></a>'],
    ['---> 로 끝나는 주석', '<a><!-- a ---></a>'],
    ['텍스트 안의 ]]>', '<a>x]]>y</a>'],
    ['잘못된 요소 이름', '<1a/>'],
    ['접두사가 둘인 이름', '<a:b:c xmlns:a="urn:x"/>'],
    ['잘못된 종료 태그', '<a></ a>'],
    ['최상위 요소 둘', '<a/><b/>'],
    ['문서 중간의 XML 선언', '<a><?xml version="1.0"?></a>'],
    ['빈 접두사 선언', '<a xmlns:p=""/>'],
    ['/ 뒤에 > 없음', '<a / >'],
  ];
  for (const [name, source] of invalid) {
    it(`거부: ${name}`, () => {
      expect(() => parseXml(source)).toThrow(XmlParseError);
    });
  }

  it('하위 요소가 접두사를 다시 선언해도 형제 요소의 namespace는 바뀌지 않는다', () => {
    const root = parseXml('<a xmlns:p="urn:1"><b xmlns:p="urn:2"><p:c/></b><p:d/></a>');
    const [b, d] = root.children.filter((child) => child.kind === 'element');
    const [c] = b.kind === 'element' ? b.children.filter((child) => child.kind === 'element') : [];
    expect([c, d].map((item) => item.kind === 'element' && item.namespaceUri)).toEqual(['urn:2', 'urn:1']);
  });

  it(`요소 깊이(${XML_LIMITS.maxDepth}단계) · 요소당 속성 수(${XML_LIMITS.maxAttributesPerElement}개) 상한을 넘으면 바로 거부한다`, () => {
    const nested = (depth: number) => '<a>'.repeat(depth) + '</a>'.repeat(depth);
    expect(() => parseXml(nested(XML_LIMITS.maxDepth))).not.toThrow();
    expect(() => parseXml(nested(XML_LIMITS.maxDepth + 1))).toThrow('너무 깊게 중첩');
    const withAttributes = (count: number) => `<a ${Array.from({ length: count }, (_, index) => `x${index}="1"`).join(' ')}/>`;
    expect(() => parseXml(withAttributes(XML_LIMITS.maxAttributesPerElement))).not.toThrow();
    expect(() => parseXml(withAttributes(XML_LIMITS.maxAttributesPerElement + 1))).toThrow('속성이 너무 많아요');
    const started = performance.now();
    expect(() => parseXml(withAttributes(24000))).toThrow('속성이 너무 많아요');
    expect(performance.now() - started).toBeLessThan(500);
  });
});

/* ---------- 시트 찾기 · 관계 ---------- */

describe('워크시트 찾기', () => {
  it('workbook · workbook rels로 시트 이름에 맞는 파트를 찾는다(sheet1.xml을 짐작하지 않는다)', () => {
    expect(resolveWorksheet(unzipPackage(richBytes()), 'TC').worksheetPath).toBe(TC_SHEET_PATH);
    expect(resolveWorksheet(unzipPackage(richBytes()), '결과').worksheetPath).toBe('xl/worksheets/sheet4.xml');
    expect(resolveWorksheet(unzipPackage(sharedStringPackage()), 'TC 목록')).toEqual({ worksheetPath: 'xl/worksheets/sheet7.xml', sharedStringsPath: 'xl/sharedStrings.xml' });
  });

  it('x: 접두사를 쓰는 패키지도 찾는다', () => {
    expect(resolveWorksheet(unzipPackage(sharedStringPackage({ prefix: 'x' })), 'TC 목록').worksheetPath).toBe('xl/worksheets/sheet7.xml');
  });

  it('없는 시트면 멈춘다', () => {
    expect(problemsOf(patchXlsx(richBytes(), { ...TC_LAYOUT, sheetName: '없는 시트' }, [patch(3, 2, '이메일 가입', 'x')]))).toEqual(["원본 파일에서 '없는 시트' 시트를 찾을 수 없어요."]);
  });

  const relCases: [string, PackageParts, string][] = [
    ['패키지 밖을 가리키는 경로', { workbookRels: `${DECL}<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/worksheet" Target="../../../worksheets/sheet1.xml"/></Relationships>` }, '패키지 밖'],
    ['scheme이 있는 경로', { workbookRels: `${DECL}<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/worksheet" Target="http://example.com/sheet1.xml"/></Relationships>` }, '지원하지 않는 경로'],
    ['같은 관계 ID', { workbookRels: `${DECL}<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/></Relationships>` }, '같은 관계 ID'],
    ['workbook namespace가 다름', { workbook: `${DECL}<workbook xmlns="urn:other" xmlns:r="${REL}"><sheets><sheet name="TC" sheetId="1" r:id="rId1"/></sheets></workbook>` }, 'workbook 파트의 형식'],
    ['관계 파트 namespace가 다름', { packageRels: `${DECL}<Relationships xmlns="urn:other"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>` }, '관계 파트가 아니에요'],
    ['officeDocument 관계가 둘', { packageRels: `${DECL}<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>` }, 'workbook 위치를 하나로'],
  ];
  for (const [name, parts, message] of relCases) {
    it(`관계 거부: ${name}`, () => {
      const result = patchXlsx(makePackage({ ...parts, rows: row2(str('B2', '항목')) }), LAYOUT, [patch(2, 1, '항목', '바뀜')]);
      expect(problemsOf(result).join(' ')).toContain(message);
    });
  }
});

/* ---------- 기존 문자열 셀 patch (서식 많은 fixture) ---------- */

describe('기존 문자열 셀 값 반영', () => {
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
    expect({ ...valuesAfter, D3: valuesBefore.D3 }).toEqual(valuesBefore);
  });

  it('다른 파트(styles · theme · workbook · rels · 다른 시트 · 숨긴 시트)는 내용 · 순서가 그대로다', () => {
    const original = entriesOf(richBytes());
    const exported = entriesOf(ok(patchXlsx(richBytes(), TC_LAYOUT, [patch(3, 2, '이메일 가입', '바뀜')])).bytes);
    expect(Object.keys(exported)).toEqual(Object.keys(original));
    for (const path of Object.keys(original)) {
      if (path !== TC_SHEET_PATH) expect(sameBytes(exported[path], original[path]), path).toBe(true);
    }
  });

  it('병합 · 열 너비 · 행 높이 · 숫자/날짜 서식은 바뀌지 않는다', () => {
    const result = ok(patchXlsx(richBytes(), TC_LAYOUT, [patch(3, 2, '이메일 가입', '바뀜'), patch(4, 4, '1. 약관을 연다.', '1. 약관을 연다.\n2. 동의한다.')]));
    const after = XLSX.read(result.bytes, { type: 'array', cellStyles: true, cellNF: true }).Sheets.TC;
    const before = XLSX.read(richBytes(), { type: 'array', cellStyles: true, cellNF: true }).Sheets.TC;
    expect(after['!merges']).toEqual(before['!merges']);
    expect(after['!cols']).toEqual(before['!cols']);
    expect(after['!rows']).toEqual(before['!rows']);
    expect(after.I3.z).toBe('#,##0.00');
    expect(after.K3.z).toBe(before.K3.z);
  });

  it('줄바꿈 · 한글 · 이모지 · XML 특수 문자 · 앞뒤 공백 · _xHHHH_ 모양 문자열을 그대로 쓴다', () => {
    const value = '  <a & b> "따옴표" \'홑\' 😀\n둘째 줄\n셋째 줄 _x000D_ 끝  ';
    const result = ok(patchXlsx(richBytes(), TC_LAYOUT, [patch(3, 5, '가입 완료', value)]));
    expect(sheetValues(result.bytes, 'TC').G3).toBe(value);
  });

  it('값을 비우면 셀 값만 지우고 스타일은 남긴다. 값이 없는 기존 셀(서식만 있는 셀)에는 쓸 수 있다', () => {
    const cleared = ok(patchXlsx(makePackage({ rows: row2(str('B2', '항목', ' s="2"')) }), LAYOUT, [patch(2, 1, '항목', '')]));
    expect(strFromU8(entriesOf(cleared.bytes)['xl/worksheets/sheet1.xml'])).toContain('<c r="B2" s="2"/>');
    const filled = ok(patchXlsx(makePackage({ rows: row2('<c r="B2" s="2"/>') }), LAYOUT, [patch(2, 1, '', '새 값')]));
    expect(strFromU8(entriesOf(filled.bytes)['xl/worksheets/sheet1.xml'])).toContain('<c r="B2" s="2" t="inlineStr"><is><t xml:space="preserve">새 값</t></is></c>');
  });

  it('바꿀 셀이 없거나 값이 이미 같으면 원본 bytes를 그대로 돌려준다', () => {
    const original = richBytes();
    expect(sameBytes(ok(patchXlsx(original, TC_LAYOUT, [])).bytes, original)).toBe(true);
    const same = ok(patchXlsx(original, TC_LAYOUT, [patch(3, 2, '이메일 가입', '이메일 가입')]));
    expect(same.changedCells).toEqual([]);
    expect(sameBytes(same.bytes, original)).toBe(true);
  });

  it('원본 bytes를 바꾸지 않는다', () => {
    const original = richBytes();
    const copy = original.slice();
    ok(patchXlsx(original, TC_LAYOUT, [patch(3, 2, '이메일 가입', '바뀜')]));
    expect(sameBytes(original, copy)).toBe(true);
  });

  for (const prefix of [undefined, 'x']) {
    it(`평문 공유 문자열 셀을 inline string으로 바꾸고 sharedStrings는 고치지 않는다${prefix ? ' (x: 접두사)' : ''}`, () => {
      const original = sharedStringPackage({ prefix });
      const result = ok(patchXlsx(original, SST_LAYOUT, [patch(2, 1, '로그인 성공', '로그인 실패 처리')]));
      const before = entriesOf(original);
      const after = entriesOf(result.bytes);
      expect(sameBytes(after['xl/sharedStrings.xml'], before['xl/sharedStrings.xml'])).toBe(true);
      expect(sameBytes(after['xl/worksheets/sheet1.xml'], before['xl/worksheets/sheet1.xml'])).toBe(true);
      const p = prefix ? `${prefix}:` : '';
      const xml = strFromU8(after['xl/worksheets/sheet7.xml']);
      expect(xml).toContain(`<${p}c r="B2" s="2" t="inlineStr"><${p}is><${p}t xml:space="preserve">로그인 실패 처리</${p}t></${p}is></${p}c>`);
      const head = (text: string) => text.slice(0, text.indexOf(`<${p}sheetData`));
      expect(head(xml)).toBe(head(strFromU8(before['xl/worksheets/sheet7.xml'])));
      expect(sheetValues(result.bytes, 'TC 목록').B2).toBe('로그인 실패 처리');
    });
  }

  it('별도 XML 검사기를 모든 읽은 파트와 고친 시트에 쓰고, 문제를 알리면 멈춘다', () => {
    const validateXml = vi.fn<(xml: string, part: string) => string | undefined>(() => undefined);
    ok(patchXlsx(sharedStringPackage(), SST_LAYOUT, [patch(2, 1, '로그인 성공', '바뀜')], { validateXml }));
    expect(validateXml.mock.calls.map(([, part]) => part)).toEqual(['_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet7.xml', 'xl/sharedStrings.xml', 'patched worksheet']);
    const rejecting = patchXlsx(sharedStringPackage(), SST_LAYOUT, [patch(2, 1, '로그인 성공', '바뀜')], { validateXml: (_xml, part) => (part === 'patched worksheet' ? '검사 실패' : undefined) });
    expect(problemsOf(rejecting)[0]).toContain('검사 실패');
  });
});

/* ---------- 독립 리뷰 후속: 지원하지 않는 대상은 전체를 멈춘다 ---------- */

describe('H1 · 셀이 없으면 만들지 않는다', () => {
  it('원본에 없는 셀은 거부한다(행 끝에 extLst가 있어도 새 셀을 끼워 넣지 않는다)', () => {
    const withExt = makePackage({ rows: `<row r="2">${str('A2', 'SIGN-001')}<extLst><ext uri="{test}"/></extLst></row>` });
    expect(problemsOf(patchXlsx(withExt, LAYOUT, [patch(2, 1, '', '새 값')]))[0]).toContain('B2(테스트): 원본 시트에 이 셀이 없어요');
    const fixture = patchXlsx(richBytes(), TC_LAYOUT, [patch(5, 3, '', '로그인 화면')]);
    expect(problemsOf(fixture)[0]).toContain('E5(테스트): 원본 시트에 이 셀이 없어요');
  });

  it('없는 행도 만들지 않는다', () => {
    expect(problemsOf(patchXlsx(richBytes(), TC_LAYOUT, [patch(40, 2, '', 'a')]))[0]).toContain('원본 시트에 이 셀이 없어요');
  });

  it('extLst가 있는 행의 기존 셀은 바꿀 수 있다', () => {
    const withExt = makePackage({ rows: `<row r="2">${str('A2', 'SIGN-001')}${str('B2', '항목')}<extLst><ext uri="{test}"/></extLst></row>` });
    expect(ok(patchXlsx(withExt, LAYOUT, [patch(2, 1, '항목', '바뀜')])).changedCells).toEqual(['B2']);
  });
});

describe('H2 · 수식과 수식 결과 범위', () => {
  const cases: [string, string, string][] = [
    ['일반 수식 셀', `<c r="B2" t="str"><f>A2&amp;"!"</f><v>SIGN-001!</v></c>`, '수식 셀'],
    ['접두사 붙은 self-closing 공유 수식(follower)', `<c r="B2"><x:f xmlns:x="${MAIN}" t="shared" si="0"/><v>3</v></c>`, '수식 셀'],
    ['배열 수식 anchor', `<c r="B2"><f t="array" ref="B2:B3">A2:A3</f><v>1</v></c>`, '수식 셀'],
  ];
  for (const [name, cell, message] of cases) {
    it(`거부: ${name}`, () => {
      expect(problemsOf(patchXlsx(makePackage({ rows: row2(cell) }), LAYOUT, [patch(2, 1, '', '바뀜')]))[0]).toContain(message);
    });
  }

  it('배열 수식 결과 범위 안의 셀(자기 수식 없음)도 거부한다', () => {
    const rows = `${row2(`<c r="B2"><f t="array" ref="B2:B3">A2:A3</f><v>1</v></c>`)}<row r="3">${str('A3', 'SIGN-002')}<c r="B3" t="inlineStr"><is><t>결과</t></is></c></row>`;
    const problems = problemsOf(patchXlsx(makePackage({ rows }), LAYOUT, [patch(3, 1, '결과', '바뀜')]));
    expect(problems[0]).toContain('B2:B3 수식 결과 범위');
  });

  it('공유 수식 범위(ref) 안의 셀도 거부한다', () => {
    const rows = `<row r="2">${str('A2', 'SIGN-001')}<c r="B2"><f t="shared" ref="B2:B4" si="0">A2</f><v>1</v></c></row><row r="3">${str('A3', 'SIGN-002')}<c r="B3"><f t="shared" si="0"/><v>2</v></c></row><row r="4">${str('A4', 'SIGN-003')}${str('B4', '문자열')}</row>`;
    expect(problemsOf(patchXlsx(makePackage({ rows }), LAYOUT, [patch(4, 1, '문자열', '바뀜')]))[0]).toContain('B2:B4 수식 결과 범위');
  });

  it('fixture의 수식 열(J3)도 거부하고 다른 셀과 함께여도 파일을 만들지 않는다', () => {
    const problems = problemsOf(patchXlsx(richBytes(), TC_LAYOUT, [patch(3, 2, '이메일 가입', '바뀜'), patch(3, 8, '', '3')]));
    expect(problems).toEqual([expect.stringContaining('J3(테스트): 수식 셀')]);
  });
});

describe('H3 · 병합된 셀', () => {
  it('병합 범위의 시작 셀과 나머지 셀 모두 거부하고, 병합 밖 셀은 바꾼다', () => {
    const rows = `${row2(str('B2', '병합'))}<row r="3">${str('A3', 'SIGN-002')}<c r="B3"/></row><row r="4">${str('A4', 'SIGN-003')}${str('B4', '밖')}</row>`;
    const pkg = makePackage({ rows, tail: '<mergeCells count="1"><mergeCell ref="B2:B3"/></mergeCells>' });
    expect(problemsOf(patchXlsx(pkg, LAYOUT, [patch(2, 1, '병합', 'x')]))[0]).toContain('병합된 셀(B2:B3)');
    expect(problemsOf(patchXlsx(pkg, LAYOUT, [patch(3, 1, '', 'x')]))[0]).toContain('병합된 셀(B2:B3)');
    expect(ok(patchXlsx(pkg, LAYOUT, [patch(4, 1, '밖', 'x')])).changedCells).toEqual(['B4']);
  });

  it('fixture의 병합 셀(H4:H5)도 거부한다', () => {
    expect(problemsOf(patchXlsx(richBytes(), TC_LAYOUT, [patch(4, 6, '병합 메모', 'x')]))[0]).toContain('병합된 셀(H4:H5)');
  });
});

describe('H4 · 문자열이 아닌 셀', () => {
  const cases: [string, string, string, string][] = [
    ['숫자 TC ID(t 없음)', '<c r="B2"><v>123</v></c>', '123', '숫자(또는 날짜)'],
    ['숫자(t="n")', '<c r="B2" t="n"><v>1.5</v></c>', '1.5', '숫자(또는 날짜)'],
    ['날짜 일련번호', '<c r="B2" s="5"><v>46295</v></c>', '46295', '숫자(또는 날짜)'],
    ['날짜(t="d")', '<c r="B2" t="d"><v>2026-09-30T00:00:00</v></c>', '2026-09-30T00:00:00', '숫자(또는 날짜)'],
    ['논리값', '<c r="B2" t="b"><v>1</v></c>', 'TRUE', '논리값'],
    ['오류 값', '<c r="B2" t="e"><v>#N/A</v></c>', '#N/A', '오류 값'],
    ['수식 없는 str', '<c r="B2" t="str"><v>x</v></c>', 'x', '수식 결과 문자열'],
    ['알 수 없는 형식', '<c r="B2" t="zz"><v>x</v></c>', 'x', '알 수 없는 셀 형식'],
    ['동적 배열 등 셀 메타데이터(cm)', '<c r="B2" cm="1" t="inlineStr"><is><t>x</t></is></c>', 'x', '셀 속성(cm)'],
    ['서식 있는 inline 문자열', '<c r="B2" t="inlineStr"><is><r><t>a</t></r><r><rPr><b/></rPr><t>b</t></r></is></c>', 'ab', '글자 단위 서식'],
  ];
  for (const [name, cell, previous, message] of cases) {
    it(`거부: ${name}`, () => {
      expect(problemsOf(patchXlsx(makePackage({ rows: row2(cell) }), LAYOUT, [patch(2, 1, previous, '바뀜')]))[0]).toContain(message);
    });
  }

  it('서식 있는 공유 문자열(rich text)도 거부한다', () => {
    expect(problemsOf(patchXlsx(sharedStringPackage(), SST_LAYOUT, [patch(3, 1, '로그인 실패', 'x')]))[0]).toContain('글자 단위 서식');
  });

  it('발음 텍스트(rPh)가 있으면 거부하고, 내용 없는 발음 설정(phoneticPr)만 있으면 평문으로 바꾼다', () => {
    const sst = (extra: string) => `<si><t>항목</t></si><si><t>값</t>${extra}</si>`;
    const rows = `<row r="2">${str('A2', 'SIGN-001')}<c r="B2" t="s"><v>1</v></c></row>`;
    const sheetXml = `${DECL}<worksheet xmlns="${MAIN}"><sheetData><row r="1">${str('A1', 'TC ID')}<c r="B1" t="s"><v>0</v></c></row>${rows}</sheetData></worksheet>`;
    const phonetic = makePackage({ sheetXml, sst: sst('<rPh sb="0" eb="1"><t>ガ</t></rPh><phoneticPr fontId="1"/>') });
    expect(problemsOf(patchXlsx(phonetic, LAYOUT, [patch(2, 1, '값', 'x')]))[0]).toContain('발음 정보');
    const setting = makePackage({ sheetXml, sst: sst('<phoneticPr fontId="1" type="noConversion"/>') });
    expect(ok(patchXlsx(setting, LAYOUT, [patch(2, 1, '값', 'x')])).changedCells).toEqual(['B2']);
  });

  it('fixture의 숫자 · 날짜 셀도 거부한다', () => {
    const problems = problemsOf(patchXlsx(richBytes(), TC_LAYOUT, [patch(3, 7, '1.5', 'x'), patch(3, 9, '2026-09-30', 'x')]));
    expect(problems).toEqual([expect.stringContaining('I3(테스트): 원본 셀 형식이 숫자'), expect.stringContaining('K3(테스트): 원본 셀 형식이 숫자')]);
  });
});

describe('M2 · 잘못되었거나 애매한 시트 구조', () => {
  it('행 번호가 겹치거나 순서가 어긋나면 거부한다', () => {
    const duplicateRow = makePackage({ rows: `${row2(str('B2', 'a'))}${row2(str('B2', 'b'))}` });
    expect(problemsOf(patchXlsx(duplicateRow, LAYOUT, [patch(2, 1, 'a', 'x')]))[0]).toContain('2행이 두 번 있거나');
  });

  it('같은 행에 같은 셀 주소가 두 번 있으면 마지막 셀을 쓰지 않고 거부한다', () => {
    const duplicateCell = makePackage({ rows: `<row r="2">${str('A2', 'SIGN-001')}${str('B2', 'a')}${str('B2', 'b')}</row>` });
    expect(problemsOf(patchXlsx(duplicateCell, LAYOUT, [patch(2, 1, 'b', 'x')]))[0]).toContain('B2 셀이 두 번 있거나');
  });

  it('주소(r)가 없는 셀 · 행 안의 알 수 없는 항목은 거부한다', () => {
    expect(problemsOf(patchXlsx(makePackage({ rows: `<row r="2"><c t="inlineStr"><is><t>a</t></is></c></row>` }), LAYOUT, [patch(2, 1, 'a', 'x')]))[0]).toContain('주소(r)가 없거나');
    expect(problemsOf(patchXlsx(makePackage({ rows: `<row r="2">${str('A2', 'a')}<foo/></row>` }), LAYOUT, [patch(2, 1, '', 'x')]))[0]).toContain('알 수 없는 항목');
  });

  it('올바르지 않은 UTF-8 시트는 대체 문자로 바꾸지 않고 거부한다', () => {
    const valid = strToU8(`${DECL}<worksheet xmlns="${MAIN}"><sheetData><row r="1">${str('A1', 'TC ID')}${str('B1', '항목')}</row>${row2(str('B2', 'ab'))}</sheetData></worksheet>`);
    const index = valid.findIndex((_, i) => valid[i] === 0x61 && valid[i + 1] === 0x62 && valid[i + 2] === 0x3c);
    const broken = valid.slice();
    broken[index] = 0xff;
    expect(problemsOf(patchXlsx(makePackage({ sheetBytes: broken }), LAYOUT, [patch(2, 1, 'ab', 'x')]))[0]).toContain('올바른 UTF-8이 아니에요');
  });

  it('잘못된 XML 시트는 거부한다(제어 문자 · 선언 안 된 접두사)', () => {
    const control = makePackage({ rows: row2(`<c r="B2" t="inlineStr"><is><t>a\u0001</t></is></c>`) });
    expect(problemsOf(patchXlsx(control, LAYOUT, [patch(2, 1, 'a', 'x')]))[0]).toContain('쓸 수 없는 문자');
    const prefix = makePackage({ rows: row2(`<c r="B2" t="inlineStr" y:z="1"><is><t>a</t></is></c>`) });
    expect(problemsOf(patchXlsx(prefix, LAYOUT, [patch(2, 1, 'a', 'x')]))[0]).toContain('선언하지 않은 namespace');
  });
});

describe('그 밖의 검증', () => {
  it('헤더 · 셀 원래 값이 가져올 때와 다르거나, 같은 셀을 두 번 바꾸거나, 쓸 수 없는 문자면 멈춘다', () => {
    expect(problemsOf(patchXlsx(richBytes(), { ...TC_LAYOUT, headers: ['TC ID', '기능', ...TC_LAYOUT.headers.slice(2)] }, [patch(3, 2, '이메일 가입', 'x')]))[0]).toContain('C2 헤더가 가져올 때와 달라요');
    expect(problemsOf(patchXlsx(richBytes(), TC_LAYOUT, [patch(3, 2, '다른 값', 'x')]))[0]).toContain('셀 값이 가져올 때와 달라요');
    expect(problemsOf(patchXlsx(richBytes(), TC_LAYOUT, [patch(3, 2, '이메일 가입', 'a'), patch(3, 2, '이메일 가입', 'b')]))[0]).toContain('같은 셀을 두 번');
    expect(problemsOf(patchXlsx(richBytes(), TC_LAYOUT, [patch(3, 2, '이메일 가입', 'a\u0001b')]))[0]).toContain('제어 문자');
  });

  it('문제가 여럿이면 모두 알려 준다', () => {
    expect(problemsOf(patchXlsx(richBytes(), TC_LAYOUT, [patch(3, 2, '다른 값', 'x'), patch(3, 8, '', '1'), patch(40, 2, '', 'a')]))).toHaveLength(3);
  });

  it('열 번호를 A · Z · AA · XFD로 바꾼다', () => {
    expect([0, 25, 26, 701, 702, 16383].map(columnLetters)).toEqual(['A', 'Z', 'AA', 'ZZ', 'AAA', 'XFD']);
  });
});

/* ---------- ZIP ---------- */

describe('ZIP 패키지 방어', () => {
  it('ZIP이 아니거나 압축 파일이 상한보다 크면 멈춘다', () => {
    expect(problemsOf(patchXlsx(new Uint8Array([1, 2, 3]), TC_LAYOUT, [patch(3, 2, 'a', 'b')]))[0]).toContain('ZIP');
    const big = new Uint8Array(ZIP_LIMITS.maxCompressedBytes + 1);
    expect(problemsOf(patchXlsx(big, TC_LAYOUT, [patch(3, 2, 'a', 'b')]))[0]).toContain('5MB 이하');
  });

  it('항목 수 · 항목 크기 · 전체 크기 상한을 넘으면 압축을 풀지 않는다', () => {
    const bytes = makePackage({ rows: row2(str('B2', 'a')) });
    expect(() => unzipPackage(bytes, { ...ZIP_LIMITS, maxEntries: 3 })).toThrow('항목이 너무 많아요');
    expect(() => unzipPackage(bytes, { ...ZIP_LIMITS, maxEntryBytes: 100 })).toThrow('너무 큰 항목');
    expect(() => unzipPackage(bytes, { ...ZIP_LIMITS, maxTotalBytes: 500 })).toThrow('파일이 너무 커요');
  });

  it('워크시트 파트가 상한보다 크면 멈춘다', () => {
    const huge = makePackage({ rows: row2(str('B2', 'a'.repeat(17 * 1024 * 1024))) });
    expect(problemsOf(patchXlsx(huge, LAYOUT, [patch(2, 1, 'x', 'y')]))[0]).toContain('파트가 너무 커요');
  });

  it('같은 이름의 항목이 두 번 있으면(대소문자 무시) 거부한다', () => {
    const base = zipSync({ 'xl/one.xml': strToU8('<a/>'), 'xl/two.xml': strToU8('<b/>') });
    expect(() => readZipDirectory(renameEntry(base, 'xl/two.xml', 'xl/one.xml'))).toThrow('같은 이름의 항목');
    expect(() => readZipDirectory(renameEntry(base, 'xl/two.xml', 'xl/ONE.xml'))).toThrow('같은 이름의 항목');
    expect(() => unzipPackage(renameEntry(base, 'xl/two.xml', 'xl/one.xml'))).toThrow('같은 이름의 항목');
  });

  it('__proto__ · .. · 역슬래시 · Windows 드라이브 경로 같은 이름의 항목은 거부한다', () => {
    const base = zipSync({ 'xl/abcdefghi': strToU8('x'), 'a/bb/c.xml': strToU8('y') });
    expect(() => readZipDirectory(renameEntry(base, 'xl/abcdefghi', 'xl/__proto__'))).toThrow('지원하지 않는 항목 이름');
    expect(() => readZipDirectory(renameEntry(base, 'a/bb/c.xml', 'a/../c.xml'))).toThrow('지원하지 않는 항목 이름');
    expect(() => readZipDirectory(renameEntry(base, 'a/bb/c.xml', '/a/b/c.xml'))).toThrow('지원하지 않는 항목 이름');
    expect(() => readZipDirectory(zipSync({ 'q\\.xml': strToU8('z') }))).toThrow('지원하지 않는 항목 이름');
    expect(() => readZipDirectory(renameEntry(base, 'a/bb/c.xml', 'C:/root.xm'))).toThrow('지원하지 않는 항목 이름');
    expect(() => readZipDirectory(renameEntry(base, 'a/bb/c.xml', 'c:root.xml'))).toThrow('지원하지 않는 항목 이름');
    // 첫 경로 조각이 아닌 곳의 콜론은 드라이브 경로가 아니다.
    expect(readZipDirectory(renameEntry(base, 'a/bb/c.xml', 'a/b:/c.xml')).map((entry) => entry.name)).toContain('a/b:/c.xml');
  });
});

/* ---------- 신규 행 이어 붙이기 ---------- */

/**
 * openpyxl로 만든 단순 TC 시트(__fixtures__/make_append_fixtures.py). 헤더 A1:J1, TC 2~4행, 열마다 다른 스타일(s=2 · 3 · 4),
 * 4행 높이 36, 틀 고정, 표지 시트에 TC 시트를 참조하는 수식이 있다. 변형 fixture는 표 · 자동 필터 · 병합 · 조건부 서식 · 데이터 유효성이 있다.
 */
const appendFixture = (name: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}.xlsx`, import.meta.url))));
const APPEND_SHEET = 'xl/worksheets/sheet2.xml';
const APPEND_LAYOUT: XlsxSheetLayout = {
  sheetName: 'TC',
  headerRowNumber: 1,
  headers: ['TC ID', '테스트 관점', '대분류', '중분류', '테스트 항목', 'Pre-condition', 'Test Step', 'Expected Result', '결과', '비고'],
};
const newRow = (rowNumber: number, values: string[]): XlsxRowAppend => ({ rowNumber, values, label: values[0] || '새 행' });
const ROW_A = ['MEM-010', '정상 흐름', '회원가입', '소셜', '카카오 가입', '카카오 앱 설치', '1. 카카오로 시작을 누른다.\n2. 동의한다.', '가입 완료', '', ''];
const ROW_B = ['MEM-011', '예외', '회원가입', '소셜', '카카오 취소', '', '1. 취소를 누른다.', '가입 화면 유지', '', ''];
const ROW_C = ['MEM-012', '경계값', '회원가입', '비밀번호', '비밀번호 64자', '', '', '가입 진행', '', ''];

/** 시트 XML만 고친 변형 패키지(나머지 파트는 fixture 그대로) */
function withSheet(name: string, edit: (xml: string) => string): Uint8Array {
  const files = unzipSync(appendFixture(name));
  const before = strFromU8(files[APPEND_SHEET]);
  const after = edit(before);
  if (after === before) throw new Error('변형할 원문을 찾지 못했어요.');
  files[APPEND_SHEET] = strToU8(after);
  return zipSync(files);
}
const sheetXmlOf = (bytes: Uint8Array) => strFromU8(unzipSync(bytes)[APPEND_SHEET]);
function blockedProblems(result: ReturnType<typeof patchXlsx>): string[] {
  if (result.ok || !result.appendBlocked) throw new Error(`행 추가가 구조 문제로 막혀야 해요. ${JSON.stringify(result.ok ? result.appendedRows : result.problems)}`);
  return result.problems;
}
function changedParts(a: Uint8Array, b: Uint8Array): string[] {
  const before = entriesOf(a);
  const after = entriesOf(b);
  return Object.keys(before).filter((path) => !after[path] || !sameBytes(before[path], after[path]));
}

describe('신규 행 이어 붙이기', () => {
  it('신규 행 1개를 마지막 TC 행 바로 아래에 붙이고, 시트 XML의 나머지 원문은 dimension만 빼고 그대로다', () => {
    const original = appendFixture('append-base');
    const before = sheetXmlOf(original);
    const result = ok(patchXlsx(original, APPEND_LAYOUT, [], {}, [newRow(5, ROW_A)]));
    expect(result.appendedRows).toEqual([5]);
    expect(result.changedCells).toEqual([]);
    expect(changedParts(original, result.bytes)).toEqual([APPEND_SHEET]);

    const after = sheetXmlOf(result.bytes);
    const inserted = after.slice(after.indexOf('<row r="5"'), after.indexOf('</sheetData>'));
    // 새 행 · dimension만 다르다(열 너비 · 틀 고정 · 다른 행 · 여백 등은 원문 그대로).
    expect(after.replace(inserted, '').replace('<dimension ref="A1:J5"/>', '<dimension ref="A1:J4"/>')).toBe(before);
    expect(after).toContain('<dimension ref="A1:J5"/>');
    // 인접한 4행의 행 속성(높이)과 열별 셀 스타일을 복제한다. 값이 빈 칸은 스타일만 있는 셀이다.
    expect(inserted.startsWith('<row r="5" ht="36" customHeight="1">')).toBe(true);
    expect([...inserted.matchAll(/<c r="([A-Z]+)5"( s="\d+")?/g)].map((match) => `${match[1]}${match[2] ?? ''}`)).toEqual([
      'A s="2"',
      'B s="2"',
      'C s="2"',
      'D s="2"',
      'E s="2"',
      'F s="2"',
      'G s="2"',
      'H s="2"',
      'I s="3"',
      'J s="4"',
    ]);
    expect(inserted).toContain('<c r="I5" s="3"/><c r="J5" s="4"/>');

    // 다른 파서(SheetJS)로 다시 읽으면 열마다 계획한 값이 있다.
    const values = sheetValues(result.bytes, 'TC');
    ROW_A.forEach((value, index) => expect(values[`${columnLetters(index)}5`] ?? '', columnLetters(index)).toBe(value));
    expect(values.A4).toBe('MEM-003');
  });

  it('신규 행 여러 개를 연속으로 붙이고 dimension을 마지막 새 행까지 넓힌다', () => {
    const result = ok(patchXlsx(appendFixture('append-base'), APPEND_LAYOUT, [], {}, [newRow(5, ROW_A), newRow(6, ROW_B), newRow(7, ROW_C)]));
    expect(result.appendedRows).toEqual([5, 6, 7]);
    const xml = sheetXmlOf(result.bytes);
    expect(xml).toContain('<dimension ref="A1:J7"/>');
    expect([...xml.matchAll(/<row r="(\d+)"/g)].map((match) => Number(match[1]))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const values = sheetValues(result.bytes, 'TC');
    expect([values.A5, values.A6, values.A7, values.E6, values.H7]).toEqual(['MEM-010', 'MEM-011', 'MEM-012', '카카오 취소', '가입 진행']);
    // 빈 값은 셀 값을 만들지 않는다(F6 Pre-condition, G7 Test Step).
    expect(values.F6 ?? '').toBe('');
    expect(values.G7 ?? '').toBe('');
    expect(xml).toContain('<c r="F6" s="2"/>');
  });

  it('기존 행 셀 수정과 새 행 추가를 한 번에 처리한다', () => {
    const result = ok(patchXlsx(appendFixture('append-base'), APPEND_LAYOUT, [patch(2, 4, '이메일 가입', '이메일로 가입')], {}, [newRow(5, ROW_A)]));
    expect(result.changedCells).toEqual(['E2']);
    expect(result.appendedRows).toEqual([5]);
    const values = sheetValues(result.bytes, 'TC');
    expect([values.E2, values.E5]).toEqual(['이메일로 가입', '카카오 가입']);
  });

  it('줄바꿈 · 한글 · 이모지 · XML 특수 문자 · 앞뒤 공백 · _xHHHH_ 모양 문자열을 그대로 쓴다', () => {
    const tricky = ' <약관> & "동의" 😀\n2줄 _x0041_ ';
    const result = ok(patchXlsx(appendFixture('append-base'), APPEND_LAYOUT, [], {}, [newRow(5, ['MEM-010', '', '', '', tricky, '', '', 'CRLF\r\n줄', '', ''])]));
    const values = sheetValues(result.bytes, 'TC');
    expect(values.E5).toBe(tricky);
    expect(values.H5).toBe('CRLF\n줄');
  });

  it('표지 시트의 수식 · styles · workbook 등 다른 파트는 byte 단위로 그대로고 원본 bytes도 바꾸지 않는다', () => {
    const original = appendFixture('append-base');
    const copy = original.slice();
    const result = ok(patchXlsx(original, APPEND_LAYOUT, [], {}, [newRow(5, ROW_A)]));
    expect(sameBytes(original, copy)).toBe(true);
    const before = entriesOf(original);
    const after = entriesOf(result.bytes);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    for (const path of Object.keys(before)) if (path !== APPEND_SHEET) expect(sameBytes(after[path], before[path]), path).toBe(true);
    expect(strFromU8(after['xl/worksheets/sheet1.xml'])).toContain('<f>COUNTA(TC!A2:A100)</f>');
  });

  it('새 행까지 이미 덮는 데이터 유효성(I2:I1000)은 그대로 두고 행을 붙인다', () => {
    const result = ok(patchXlsx(appendFixture('append-dv'), APPEND_LAYOUT, [], {}, [newRow(5, ROW_A)]));
    expect(result.appendedRows).toEqual([5]);
    expect(sheetXmlOf(result.bytes)).toContain('sqref="I2:I1000"');
  });

  const blockedFixtures: [string, string, string][] = [
    ['Excel 표(tableParts)', 'append-table', 'tableParts'],
    ['자동 필터(autoFilter)', 'append-autofilter', 'autoFilter'],
    ['인접 행에 걸친 병합(J3:J4)', 'append-merged', '병합된 셀(J3:J4)'],
    ['새 행을 덮지 않는 조건부 서식(I2:I4)', 'append-cf', '조건부 서식 범위(I2:I4)'],
  ];
  for (const [name, fixture, expected] of blockedFixtures) {
    it(`행을 붙이지 않는다: ${name}`, () => {
      expect(blockedProblems(patchXlsx(appendFixture(fixture), APPEND_LAYOUT, [], {}, [newRow(5, ROW_A)])).join('\n')).toContain(expected);
    });
  }

  const blockedEdits: [string, (xml: string) => string, string][] = [
    ['TC 목록 아래의 값 없는 서식 행', (xml) => xml.replace('</sheetData>', '<row r="6" ht="20" customHeight="1"/></sheetData>'), '다른 행(값 없는 서식 행 포함)'],
    ['새 행 위치로 이어지는 병합', (xml) => xml.replace('<pageMargins', '<mergeCells count="1"><mergeCell ref="J4:J6"/></mergeCells><pageMargins'), '병합된 셀(J4:J6)'],
    ['공유 수식', (xml) => xml.replace('</row><row r="3">', '<c r="K2"><f t="shared" ref="K2:K3" si="0">A2</f><v></v></c></row><row r="3">'), '공유 · 배열 수식'],
    ['인접 행의 수식 셀', (xml) => xml.replace('<c r="J4" s="4" t="n"></c>', '<c r="J4" s="4"><f>I4</f><v></v></c>'), '수식 셀(J4)'],
    ['숨긴 인접 행', (xml) => xml.replace('<row r="4" ht="36" customHeight="1">', '<row r="4" ht="36" customHeight="1" hidden="1">'), '숨김 또는 그룹'],
    ['그림(drawing)', (xml) => xml.replace('</worksheet>', '<drawing xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId9"/></worksheet>'), 'drawing'],
    ['확장 영역(extLst)', (xml) => xml.replace('</worksheet>', '<extLst><ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}"/></extLst></worksheet>'), 'extLst'],
    ['읽을 수 없는 dimension', (xml) => xml.replace('<dimension ref="A1:J4"/>', '<dimension ref="A1:J4:K9"/>'), 'dimension'],
    ['읽을 수 없는 조건부 서식 범위', (xml) => xml.replace('<pageMargins', '<conditionalFormatting sqref="I2:"><cfRule type="expression" priority="1"><formula>TRUE</formula></cfRule></conditionalFormatting><pageMargins'), '조건부 서식 범위를 읽을 수 없어요'],
    ['복제할 수 없는 셀 속성(cm)', (xml) => xml.replace('<c r="E4" s="2"', '<c r="E4" s="2" cm="1"'), '복제할 수 없는 속성(cm)'],
  ];
  for (const [name, edit, expected] of blockedEdits) {
    it(`행을 붙이지 않는다: ${name}`, () => {
      expect(blockedProblems(patchXlsx(withSheet('append-base', edit), APPEND_LAYOUT, [], {}, [newRow(5, ROW_A)])).join('\n')).toContain(expected);
    });
  }

  it('열 전체 범위의 데이터 유효성(I:I)은 새 행을 덮으므로 행을 붙인다', () => {
    const bytes = withSheet('append-base', (xml) => xml.replace('<pageMargins', '<dataValidations count="1"><dataValidation type="list" sqref="I:I"><formula1>"P,F"</formula1></dataValidation></dataValidations><pageMargins'));
    expect(ok(patchXlsx(bytes, APPEND_LAYOUT, [], {}, [newRow(5, ROW_A)])).appendedRows).toEqual([5]);
  });

  it('새 행 위치가 마지막 TC 행 바로 아래가 아니면 붙이지 않는다', () => {
    expect(blockedProblems(patchXlsx(appendFixture('append-base'), APPEND_LAYOUT, [], {}, [newRow(6, ROW_A)])).join('\n')).toContain('위치와 서식을 확정할 수 없어요');
    expect(blockedProblems(patchXlsx(appendFixture('append-base'), APPEND_LAYOUT, [], {}, [newRow(4, ROW_A)])).join('\n')).toContain('위치를 확정할 수 없어요');
    expect(blockedProblems(patchXlsx(appendFixture('append-base'), APPEND_LAYOUT, [], {}, [newRow(5, ROW_A), newRow(7, ROW_B)])).join('\n')).toContain('이어지지 않아요');
  });

  it('PR #24 fixture(병합 H4:H5 · 수식 J열)에는 행을 붙이지 않는다', () => {
    const problems = blockedProblems(patchXlsx(richBytes(), TC_LAYOUT, [], {}, [newRow(6, ['signup-009', '회원가입', '새 항목', '', '', '결과', '', '', '', ''])])).join('\n');
    expect(problems).toContain('수식 셀(J5)');
    expect(problems).toContain('병합된 셀(H4:H5)');
  });

  it('기존 셀 patch 문제는 행 추가 문제보다 먼저 내보내기 전체를 멈춘다', () => {
    const result = patchXlsx(appendFixture('append-table'), APPEND_LAYOUT, [patch(2, 4, '다른 값', 'x')], {}, [newRow(5, ROW_A)]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.appendBlocked).toBeFalsy();
    expect(problemsOf(result)[0]).toContain('셀 값이 가져올 때와 달라요');
  });

  it('새 행 값에 쓸 수 없는 제어 문자가 있거나 셀 글자 수 상한을 넘으면 구조 문제가 아니라 내보내기 전체를 멈춘다', () => {
    const control = patchXlsx(appendFixture('append-base'), APPEND_LAYOUT, [], {}, [newRow(5, ['MEM-010', '', '', '', 'a\u0001b', '', '', '', '', ''])]);
    expect(!control.ok && control.appendBlocked).toBeFalsy();
    expect(problemsOf(control)[0]).toContain('제어 문자');
    const long = patchXlsx(appendFixture('append-base'), APPEND_LAYOUT, [], {}, [newRow(5, ['MEM-010', '', '', '', 'a'.repeat(32768), '', '', '', '', ''])]);
    expect(problemsOf(long)[0]).toContain('32767자');
  });

  it('별도 XML 검사기를 새 행을 붙인 시트에도 쓴다', () => {
    const validateXml = vi.fn((_xml: string, part: string) => (part === 'patched worksheet' ? '검사기 거부' : undefined));
    expect(problemsOf(patchXlsx(appendFixture('append-base'), APPEND_LAYOUT, [], { validateXml }, [newRow(5, ROW_A)]))[0]).toContain('검사기 거부');
  });
});
