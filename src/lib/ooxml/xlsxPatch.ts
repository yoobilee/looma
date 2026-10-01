import { strToU8 } from 'fflate';
import { attribute, attributeNs, childElements, escapeXmlText, isXmlSafeText, parseXml, textContent, XmlParseError, type XmlElement } from './xml';
import { assertPackageContent, unzipPackage, zipPackage, ZipPackageError, type ZipPackage } from './zipPackage';

/*
 * 원본 XLSX 패키지에서 한 워크시트의 "기존 문자열 셀" 값만 바꾼다. 범용 OOXML 편집기가 아니다.
 * 지원: 이미 있는 셀 · 문자열 셀(공유 문자열 · inline string) 또는 값이 없는 셀 · 병합 · 수식 범위 밖.
 * 지원하지 않는 구조(셀 없음, 숫자 · 날짜 · 논리 · 오류 셀, 서식 있는 텍스트, 병합, 수식 · 배열 · 공유 수식 범위,
 * 잘못되었거나 애매한 OOXML)는 추측하지 않고 내보내기 전체를 멈춘다. 부분 결과 파일은 만들지 않는다.
 * - 다른 파트(styles · theme · sharedStrings · 다른 시트 · 그림 · rels · workbook)는 내용 그대로 다시 묶는다.
 * - 워크시트 XML도 바꿀 셀의 원문 구간만 교체한다. 셀의 스타일(s)은 유지한다.
 */

const MAIN_NS = ['http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'http://purl.oclc.org/ooxml/spreadsheetml/main'];
const RELATIONSHIP_NS = ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships'];
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const relType = (name: string) => RELATIONSHIP_NS.map((namespace) => `${namespace}/${name}`);
const REL_TYPES = {
  officeDocument: relType('officeDocument'),
  worksheet: relType('worksheet'),
  sharedStrings: relType('sharedStrings'),
};

/** 워크시트 · 공유 문자열 파트 상한. 개인 QA 파일에 넉넉한 값이다. */
export const XLSX_PART_LIMITS = {
  worksheetBytes: 16 * 1024 * 1024,
  sharedStringsBytes: 16 * 1024 * 1024,
};

/** 표의 몇 번째 열(0부터)을 바꾸는지. 열 위치는 시트에서 헤더 행을 찾아 정한다. */
export interface XlsxCellPatch {
  rowNumber: number;
  columnIndex: number;
  /** 가져올 때 이 셀에 있던 값. 시트의 현재 값과 다르면 다른 파일로 보고 멈춘다. */
  previousValue: string;
  nextValue: string;
  /** 안내에 쓰는 이름 (예: 테스트 항목) */
  label: string;
}

export interface XlsxSheetLayout {
  sheetName: string;
  headerRowNumber: number;
  /** 가져올 때 읽은 헤더. 시트의 실제 헤더와 같아야 열 위치를 믿을 수 있다. */
  headers: string[];
}

/** 같은 XML을 이 파서와 별개로 검사한다(브라우저 DOMParser 등). 문제가 있으면 설명을 돌려준다. */
export type XmlValidator = (xml: string, partName: string) => string | undefined;

export interface PatchOptions {
  validateXml?: XmlValidator;
}

export type XlsxPatchResult = { ok: true; bytes: Uint8Array; changedCells: string[] } | { ok: false; problems: string[] };

class PatchProblems extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('\n'));
  }
}
const stop = (message: string): never => {
  throw new PatchProblems([message]);
};

/* ---------- 파트 읽기 ---------- */

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

interface Part {
  text: string;
  hasBom: boolean;
  root: XmlElement;
}

/** UTF-8로만 읽는다. 잘못된 바이트를 대체 문자로 바꿔 원문을 바꾸지 않도록 fatal로 읽는다. */
function readPart(pkg: ZipPackage, path: string, options: PatchOptions, maxBytes?: number): Part {
  const bytes = pkg.entries.get(path);
  if (!bytes) stop(`XLSX 안에 ${path} 파트가 없어요.`);
  if (maxBytes !== undefined && bytes!.length > maxBytes) stop(`${path} 파트가 너무 커요(최대 ${Math.round(maxBytes / 1024 / 1024)}MB).`);
  const hasBom = UTF8_BOM.every((byte, index) => bytes![index] === byte);
  let text: string;
  try {
    text = strictUtf8.decode(hasBom ? bytes!.subarray(3) : bytes!);
  } catch {
    return stop(`${path}가 올바른 UTF-8이 아니에요.`);
  }
  const declaration = /^<\?xml[^>]*encoding=["']([^"']+)["']/i.exec(text);
  if (declaration && declaration[1].toLowerCase() !== 'utf-8') stop(`${path}의 ${declaration[1]} 인코딩은 지원하지 않아요.`);
  let root: XmlElement;
  try {
    root = parseXml(text);
  } catch (error) {
    return stop(`${path}를 읽을 수 없어요. ${error instanceof XmlParseError ? error.message : ''}`.trim());
  }
  const problem = options.validateXml?.(text, path);
  if (problem) stop(`${path}: ${problem}`);
  return { text, hasBom, root };
}

const isMain = (element: XmlElement, localName: string) => element.localName === localName && MAIN_NS.includes(element.namespaceUri);
const mainChildren = (element: XmlElement, localName: string) => childElements(element).filter((child) => isMain(child, localName));

/* ---------- 관계(rels) ---------- */

const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '');
const relsPathOf = (partPath: string) => `${dirOf(partPath)}_rels/${partPath.slice(dirOf(partPath).length)}.rels`;

/** rels의 Target을 패키지 안 경로로 바꾼다. 패키지 밖으로 나가거나 해석이 애매한 경로는 거부한다. */
function resolveTarget(baseDir: string, target: string, relsPath: string): string {
  if (target === '' || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || /[\\?#%]/.test(target)) stop(`${relsPath}에 지원하지 않는 경로(${target})가 있어요.`);
  const joined = target.startsWith('/') ? target.slice(1) : baseDir + target;
  const parts: string[] = [];
  for (const part of joined.split('/')) {
    if (part === '') stop(`${relsPath}의 경로(${target})가 올바르지 않아요.`);
    if (part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) stop(`${relsPath}의 경로(${target})가 패키지 밖을 가리켜요.`);
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

interface Relationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

function readRelationships(pkg: ZipPackage, relsPath: string, baseDir: string, options: PatchOptions): Relationship[] {
  const { root } = readPart(pkg, relsPath, options);
  if (root.localName !== 'Relationships' || root.namespaceUri !== PACKAGE_REL_NS) stop(`${relsPath}가 관계 파트가 아니에요.`);
  const ids = new Set<string>();
  return childElements(root).map((item) => {
    if (item.localName !== 'Relationship' || item.namespaceUri !== PACKAGE_REL_NS) return stop(`${relsPath}에 알 수 없는 항목이 있어요.`);
    const id = attribute(item, 'Id');
    const type = attribute(item, 'Type');
    const target = attribute(item, 'Target');
    const mode = attribute(item, 'TargetMode');
    if (!id || !type || target === undefined) return stop(`${relsPath}에 필수 값이 빠진 관계가 있어요.`);
    if (ids.has(id)) return stop(`${relsPath}에 같은 관계 ID(${id})가 두 번 있어요.`);
    ids.add(id);
    if (mode !== undefined && mode !== 'Internal' && mode !== 'External') return stop(`${relsPath}의 TargetMode(${mode})가 올바르지 않아요.`);
    const external = mode === 'External';
    return { id, type, target: external ? target : resolveTarget(baseDir, target, relsPath), external };
  });
}

interface ResolvedSheet {
  worksheetPath: string;
  sharedStringsPath?: string;
}

/** _rels/.rels → workbook → workbook rels → 시트 이름으로 워크시트 파트를 찾는다. 경로를 짐작하지 않는다. */
export function resolveWorksheet(pkg: ZipPackage, sheetName: string, options: PatchOptions = {}): ResolvedSheet {
  const packageRels = readRelationships(pkg, '_rels/.rels', '', options);
  const workbookRels = packageRels.filter((item) => REL_TYPES.officeDocument.includes(item.type));
  if (workbookRels.length !== 1 || workbookRels[0].external) stop('XLSX의 workbook 위치를 하나로 정할 수 없어요.');
  const workbookPath = workbookRels[0].target;
  const { root: workbook } = readPart(pkg, workbookPath, options);
  if (!isMain(workbook, 'workbook')) stop('workbook 파트의 형식이 올바르지 않아요.');
  const rels = readRelationships(pkg, relsPathOf(workbookPath), dirOf(workbookPath), options);

  const sheetGroups = mainChildren(workbook, 'sheets');
  if (sheetGroups.length !== 1) stop('workbook의 시트 목록을 읽을 수 없어요.');
  const matches = mainChildren(sheetGroups[0], 'sheet').filter((item) => attribute(item, 'name') === sheetName);
  if (matches.length !== 1) stop(`원본 파일에서 '${sheetName}' 시트를 찾을 수 없어요.`);
  const relationshipId = attributeNs(matches[0], RELATIONSHIP_NS, 'id');
  const sheetRel = rels.find((item) => item.id === relationshipId);
  if (!sheetRel || sheetRel.external || !REL_TYPES.worksheet.includes(sheetRel.type)) stop(`'${sheetName}'은 값을 바꿀 수 있는 워크시트가 아니에요.`);
  if (!pkg.entries.has(sheetRel!.target)) stop(`'${sheetName}' 시트 파트(${sheetRel!.target})가 패키지에 없어요.`);

  const sharedRels = rels.filter((item) => REL_TYPES.sharedStrings.includes(item.type));
  if (sharedRels.length > 1 || sharedRels.some((item) => item.external)) stop('공유 문자열 파트를 하나로 정할 수 없어요.');
  const sharedStringsPath = sharedRels[0]?.target;
  if (sharedStringsPath && !pkg.entries.has(sharedStringsPath)) stop(`공유 문자열 파트(${sharedStringsPath})가 패키지에 없어요.`);
  return { worksheetPath: sheetRel!.target, ...(sharedStringsPath && { sharedStringsPath }) };
}

/* ---------- 셀 주소 · 범위 ---------- */

const MAX_ROW = 1048576;
const MAX_COLUMN = 16384;

export function columnLetters(index: number): string {
  let value = index + 1;
  let letters = '';
  while (value > 0) {
    const rest = (value - 1) % 26;
    letters = String.fromCharCode(65 + rest) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

function parseCellRef(ref: string): { column: number; row: number } | undefined {
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(ref);
  if (!match) return undefined;
  const column = [...match[1]].reduce((sum, char) => sum * 26 + (char.charCodeAt(0) - 64), 0) - 1;
  const row = Number(match[2]);
  return column < MAX_COLUMN && row <= MAX_ROW ? { column, row } : undefined;
}

interface Range {
  ref: string;
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** "A1" 또는 "A1:C3" */
function parseRange(ref: string): Range | undefined {
  const [first, second, extra] = ref.split(':');
  if (extra !== undefined) return undefined;
  const a = parseCellRef(first);
  const b = second === undefined ? a : parseCellRef(second);
  if (!a || !b) return undefined;
  return { ref, top: Math.min(a.row, b.row), bottom: Math.max(a.row, b.row), left: Math.min(a.column, b.column), right: Math.max(a.column, b.column) };
}

const inRange = (range: Range, row: number, column: number) => row >= range.top && row <= range.bottom && column >= range.left && column <= range.right;

/* ---------- 셀 값 ---------- */

/** OOXML 문자열의 _xHHHH_ 표기를 푼다(Excel이 제어 문자를 저장하는 방식). */
const decodeOoxmlEscapes = (text: string) => text.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
/** 값에 있는 _xHHHH_ 모양 문자열이 제어 문자로 풀리지 않도록 앞의 _를 _x005F_로 적는다. */
const encodeOoxmlEscapes = (text: string) => text.replace(/_(x[0-9A-Fa-f]{4}_)/g, '_x005F_$1');
const normalizeNewlines = (text: string) => text.replace(/\r\n?/g, '\n');

interface SharedString {
  text: string;
  /** 글자 단위 서식(r) · 발음 텍스트(rPh) 등 평문이 아닌 문자열 */
  rich: boolean;
}

/**
 * 평문 문자열인가: t 하나와, 있어도 보이는 내용이 없는 발음 설정(phoneticPr)만 있다.
 * 발음 설정은 inline string으로 바꿀 때 빠지지만 발음 텍스트(rPh)가 없으면 화면에 보이는 차이가 없다.
 */
const isPlainString = (children: XmlElement[]) =>
  children.filter((child) => isMain(child, 't')).length === 1 && children.every((child) => isMain(child, 't') || isMain(child, 'phoneticPr'));

function readSharedStrings(root: XmlElement | undefined): SharedString[] {
  if (!root) return [];
  if (!isMain(root, 'sst')) stop('공유 문자열 파트의 형식이 올바르지 않아요.');
  return childElements(root).map((item) => {
    if (!isMain(item, 'si')) return stop('공유 문자열 파트에 알 수 없는 항목이 있어요.');
    // 발음 표시(rPh)는 셀에 보이는 값이 아니므로 뺀다.
    return { text: decodeOoxmlEscapes(textContent(item, ['rPh'])), rich: !isPlainString(childElements(item)) };
  });
}

/**
 * 셀이 지금 무엇인가. string만 값을 바꿀 수 있다.
 * empty: 값이 없는 셀(서식만 있는 셀) / string: 평문 공유 문자열 · inline string / unsupported: 그 밖의 모든 셀
 */
type CellState = { kind: 'empty' } | { kind: 'string'; text: string } | { kind: 'unsupported'; reason: string; text?: string };

const ALLOWED_CELL_ATTRIBUTES = new Set(['r', 's', 't']);

function classifyCell(cell: XmlElement, sharedStrings: () => SharedString[]): CellState {
  const type = attribute(cell, 't');
  const children = childElements(cell);
  const value = children.find((child) => isMain(child, 'v'));
  const inline = children.find((child) => isMain(child, 'is'));
  const raw = value ? textContent(value) : undefined;
  if (children.some((child) => isMain(child, 'f'))) return { kind: 'unsupported', reason: '수식 셀이에요', text: raw };
  const unknownChild = children.find((child) => !isMain(child, 'v') && !isMain(child, 'is'));
  if (unknownChild) return { kind: 'unsupported', reason: `지원하지 않는 셀 구조(${unknownChild.localName})예요` };
  const unknownAttribute = cell.attributes.find((item) => !ALLOWED_CELL_ATTRIBUTES.has(item.name));
  if (unknownAttribute) return { kind: 'unsupported', reason: `지원하지 않는 셀 속성(${unknownAttribute.name})이 있어요` };

  switch (type) {
    case undefined:
      if (!value && !inline) return { kind: 'empty' };
      if (inline) return { kind: 'unsupported', reason: '셀 형식이 올바르지 않아요' };
      return { kind: 'unsupported', reason: '원본 셀 형식이 숫자(또는 날짜)라 내보낼 수 없어요', text: raw };
    case 's': {
      if (inline || raw === undefined || !/^(0|[1-9][0-9]*)$/.test(raw)) return { kind: 'unsupported', reason: '공유 문자열 셀 형식이 올바르지 않아요' };
      const shared = sharedStrings()[Number(raw)];
      if (!shared) return { kind: 'unsupported', reason: '공유 문자열을 찾을 수 없어요' };
      if (shared.rich) return { kind: 'unsupported', reason: '글자 단위 서식이나 발음 정보가 있는 텍스트라 바꾸면 서식이 사라져요', text: shared.text };
      return { kind: 'string', text: shared.text };
    }
    case 'inlineStr': {
      if (value || !inline) return { kind: 'unsupported', reason: 'inline 문자열 셀 형식이 올바르지 않아요' };
      const parts = childElements(inline);
      if (parts.length === 0) return { kind: 'string', text: '' };
      if (!isPlainString(parts)) return { kind: 'unsupported', reason: '글자 단위 서식이나 발음 정보가 있는 텍스트라 바꾸면 서식이 사라져요', text: textContent(inline, ['rPh']) };
      return { kind: 'string', text: decodeOoxmlEscapes(textContent(parts.find((part) => isMain(part, 't'))!)) };
    }
    case 'n':
    case 'd':
      return { kind: 'unsupported', reason: '원본 셀 형식이 숫자(또는 날짜)라 내보낼 수 없어요', text: raw };
    case 'b':
      return { kind: 'unsupported', reason: '원본 셀 형식이 논리값(TRUE/FALSE)이라 내보낼 수 없어요', text: raw };
    case 'e':
      return { kind: 'unsupported', reason: '원본 셀이 오류 값이라 내보낼 수 없어요', text: raw };
    case 'str':
      return { kind: 'unsupported', reason: '수식 결과 문자열 셀이라 내보낼 수 없어요', text: raw };
    default:
      return { kind: 'unsupported', reason: `알 수 없는 셀 형식(t="${type}")이에요` };
  }
}

/** 헤더 · 표 시작 열을 찾을 때 쓰는 보이는 값. 문자열이 아닌 셀은 원문 값을 쓴다. */
function visibleText(state: CellState): string {
  if (state.kind === 'empty') return '';
  return state.text ?? '';
}

/* ---------- 워크시트 patch ---------- */

interface Edit {
  start: number;
  end: number;
  text: string;
}

function cellXml(cell: XmlElement, source: string, value: string): string {
  const qualified = (local: string) => (cell.prefix ? `${cell.prefix}:${local}` : local);
  // 원래 속성 원문(r · s)을 그대로 쓰고 값 종류(t)만 바꾼다.
  const attributesText = cell.attributes
    .filter((item) => item.name !== 't')
    .map((item) => ` ${source.slice(item.rawStart, item.rawEnd)}`)
    .join('');
  if (value === '') return `<${qualified('c')}${attributesText}/>`;
  const text = escapeXmlText(encodeOoxmlEscapes(value));
  return `<${qualified('c')}${attributesText} t="inlineStr"><${qualified('is')}><${qualified('t')} xml:space="preserve">${text}</${qualified('t')}></${qualified('is')}></${qualified('c')}>`;
}

interface SheetCell {
  cell: XmlElement;
  column: number;
}

/** 시트 구조를 읽어 확인한다. 행 · 셀 주소가 없거나 겹치거나 순서가 어긋나면 거부한다. */
function readSheetStructure(worksheet: XmlElement, sheetName: string) {
  if (!isMain(worksheet, 'worksheet')) stop(`'${sheetName}' 시트 파트의 형식이 올바르지 않아요.`);
  const sheetDataList = mainChildren(worksheet, 'sheetData');
  if (sheetDataList.length !== 1) stop(`'${sheetName}' 시트의 데이터 영역을 하나로 정할 수 없어요.`);

  const rows = new Map<number, Map<number, SheetCell>>();
  const formulaRanges: Range[] = [];
  const formulaCells = new Set<string>();
  let previousRow = 0;
  for (const row of childElements(sheetDataList[0])) {
    if (!isMain(row, 'row')) stop(`'${sheetName}' 시트 데이터에 알 수 없는 항목(${row.localName})이 있어요.`);
    const rowNumber = Number(attribute(row, 'r'));
    if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > MAX_ROW) stop(`'${sheetName}' 시트에 주소(r)가 없거나 올바르지 않은 행이 있어요.`);
    if (rowNumber <= previousRow) stop(`'${sheetName}' 시트에 ${rowNumber}행이 두 번 있거나 순서가 어긋나 있어요.`);
    previousRow = rowNumber;
    const cells = new Map<number, SheetCell>();
    let previousColumn = -1;
    const children = childElements(row);
    children.forEach((cell, index) => {
      // 행 끝의 extLst는 허용한다(값을 넣지 않으므로 위치를 건드리지 않는다).
      if (isMain(cell, 'extLst') && index === children.length - 1) return;
      if (!isMain(cell, 'c')) stop(`${rowNumber}행에 알 수 없는 항목(${cell.localName})이 있어요.`);
      const ref = attribute(cell, 'r');
      const position = ref ? parseCellRef(ref) : undefined;
      if (!ref || !position || position.row !== rowNumber) stop(`${rowNumber}행에 주소(r)가 없거나 맞지 않는 셀이 있어요.`);
      if (position!.column <= previousColumn) stop(`${ref} 셀이 두 번 있거나 순서가 어긋나 있어요.`);
      previousColumn = position!.column;
      cells.set(position!.column, { cell, column: position!.column });
      // 수식 · 배열 수식 · 공유 수식 · 데이터 표가 차지하는 범위를 모은다.
      const formula = childElements(cell).find((child) => isMain(child, 'f'));
      if (formula) {
        formulaCells.add(ref!);
        const formulaRef = attribute(formula, 'ref');
        if (formulaRef !== undefined) {
          const range = parseRange(formulaRef);
          if (!range) stop(`${ref} 수식의 범위(${formulaRef})를 읽을 수 없어요.`);
          formulaRanges.push(range!);
        }
      }
    });
    rows.set(rowNumber, cells);
  }

  const mergeRanges: Range[] = [];
  for (const group of mainChildren(worksheet, 'mergeCells')) {
    for (const merge of childElements(group)) {
      const ref = isMain(merge, 'mergeCell') ? attribute(merge, 'ref') : undefined;
      const range = ref ? parseRange(ref) : undefined;
      if (!range) stop(`'${sheetName}' 시트의 병합 범위를 읽을 수 없어요.`);
      mergeRanges.push(range!);
    }
  }
  return { rows, formulaRanges, formulaCells, mergeRanges };
}

export interface PatchWorksheetResult {
  xml: string;
  changedCells: string[];
}

/** 워크시트 XML에 셀 값을 반영한다. 문제가 하나라도 있으면 PatchProblems를 던진다. */
export function patchWorksheetXml(source: string, layout: XlsxSheetLayout, patches: XlsxCellPatch[], sharedStrings: () => SharedString[], options: PatchOptions = {}): PatchWorksheetResult {
  let worksheet: XmlElement;
  try {
    worksheet = parseXml(source);
  } catch (error) {
    return stop(`'${layout.sheetName}' 시트 XML을 읽을 수 없어요. ${error instanceof Error ? error.message : ''}`.trim());
  }
  const { rows, formulaRanges, formulaCells, mergeRanges } = readSheetStructure(worksheet, layout.sheetName);

  // 가져올 때(SheetJS)처럼 값이 있는 셀 중 가장 왼쪽 열을 표의 첫 열로 본다.
  let firstColumn = Number.POSITIVE_INFINITY;
  for (const cells of rows.values()) {
    for (const { cell, column } of cells.values()) {
      if (column < firstColumn && visibleText(classifyCell(cell, sharedStrings)) !== '') firstColumn = column;
    }
  }
  if (!Number.isFinite(firstColumn)) stop(`'${layout.sheetName}' 시트에 값이 없어요.`);

  const problems: string[] = [];

  // 헤더가 가져올 때와 같아야 열 위치를 믿을 수 있다.
  layout.headers.forEach((header, index) => {
    const column = firstColumn + index;
    const found = rows.get(layout.headerRowNumber)?.get(column);
    const text = found ? normalizeNewlines(visibleText(classifyCell(found.cell, sharedStrings))).trim() : '';
    if (text === header || (header === `열 ${index + 1}` && text === '')) return;
    problems.push(`${columnLetters(column)}${layout.headerRowNumber} 헤더가 가져올 때와 달라요. (가져올 때 '${header}', 지금 '${text}')`);
  });

  const edits: Edit[] = [];
  const changedCells: string[] = [];
  const seen = new Set<string>();

  for (const patch of patches) {
    const column = firstColumn + patch.columnIndex;
    const ref = `${columnLetters(column)}${patch.rowNumber}`;
    const where = `${ref}(${patch.label})`;
    if (seen.has(ref)) {
      problems.push(`${where}: 같은 셀을 두 번 바꾸려고 해요.`);
      continue;
    }
    seen.add(ref);
    const value = normalizeNewlines(patch.nextValue);
    if (!isXmlSafeText(value)) {
      problems.push(`${where}: 파일에 쓸 수 없는 제어 문자가 있어요.`);
      continue;
    }
    const found = rows.get(patch.rowNumber)?.get(column);
    if (!found) {
      // 새 셀 · 새 행은 만들지 않는다(행 안의 위치를 추측하면 파일이 열리지 않을 수 있다).
      problems.push(`${where}: 원본 시트에 이 셀이 없어요. 이번 버전은 원본에 이미 있는 셀만 바꿀 수 있어요.`);
      continue;
    }
    const merged = mergeRanges.find((range) => inRange(range, patch.rowNumber, column));
    if (merged) {
      problems.push(`${where}: 병합된 셀(${merged.ref})이라 값을 바꾸지 않아요.`);
      continue;
    }
    const formulaRange = formulaRanges.find((range) => inRange(range, patch.rowNumber, column));
    if (formulaCells.has(ref) || formulaRange) {
      problems.push(`${where}: 수식 셀${formulaRange && !formulaCells.has(ref) ? `(${formulaRange.ref} 수식 결과 범위)` : ''}이라 값을 바꾸지 않아요. 수식을 지우거나 덮어쓰지 않도록 내보내기를 멈췄어요.`);
      continue;
    }
    const state = classifyCell(found.cell, sharedStrings);
    if (state.kind === 'unsupported') {
      problems.push(`${where}: ${state.reason}.`);
      continue;
    }
    const currentText = state.kind === 'empty' ? '' : normalizeNewlines(state.text);
    if (currentText !== normalizeNewlines(patch.previousValue)) {
      problems.push(`${where}: 셀 값이 가져올 때와 달라요. 다른 파일이거나 가져온 뒤 바뀐 파일일 수 있어요.`);
      continue;
    }
    if (currentText === value) continue;
    edits.push({ start: found.cell.start, end: found.cell.end, text: cellXml(found.cell, source, value) });
    changedCells.push(ref);
  }

  if (problems.length > 0) throw new PatchProblems(problems);

  let xml = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) xml = xml.slice(0, edit.start) + edit.text + xml.slice(edit.end);

  // 고친 XML이 여전히 올바른지 다시 확인한다(가능하면 별도 검사기로도 본다).
  try {
    parseXml(xml);
  } catch (error) {
    stop(`고친 시트 XML이 올바르지 않아 내보내기를 멈췄어요. ${error instanceof Error ? error.message : ''}`.trim());
  }
  const problem = options.validateXml?.(xml, 'patched worksheet');
  if (problem) stop(`고친 시트 XML이 올바르지 않아 내보내기를 멈췄어요. ${problem}`);
  return { xml, changedCells: changedCells.sort() };
}

/**
 * 원본 XLSX bytes에 셀 값을 반영한 새 XLSX bytes를 만든다. 원본 bytes는 바꾸지 않는다.
 * 실제로 고친 셀이 없으면 원본 bytes를 그대로(복사본으로) 돌려준다. changedCells가 비어 있어도
 * 계획한 값이 파일에 들어갔다는 뜻은 아니므로, 호출하는 쪽은 결과 bytes를 다시 읽어 확인해야 한다.
 */
export function patchXlsx(original: Uint8Array, layout: XlsxSheetLayout, patches: XlsxCellPatch[], options: PatchOptions = {}): XlsxPatchResult {
  try {
    // 바꿀 셀이 없어도 원본 패키지가 정상적인 classic ZIP인지 먼저 확인한다(원본을 그대로 내줄 때도 같다).
    const pkg = unzipPackage(original);
    if (patches.length === 0) return { ok: true, bytes: original.slice(), changedCells: [] };
    const resolved = resolveWorksheet(pkg, layout.sheetName, options);
    const worksheet = readPart(pkg, resolved.worksheetPath, options, XLSX_PART_LIMITS.worksheetBytes);
    let shared: SharedString[] | undefined;
    const sharedStrings = () =>
      (shared ??= readSharedStrings(resolved.sharedStringsPath ? readPart(pkg, resolved.sharedStringsPath, options, XLSX_PART_LIMITS.sharedStringsBytes).root : undefined));
    const { xml, changedCells } = patchWorksheetXml(worksheet.text, layout, patches, sharedStrings, options);
    if (changedCells.length === 0) return { ok: true, bytes: original.slice(), changedCells };

    const encoded = strToU8(xml);
    const entries = new Map(pkg.entries);
    entries.set(resolved.worksheetPath, worksheet.hasBom ? concat(Uint8Array.from(UTF8_BOM), encoded) : encoded);
    const patched = { names: pkg.names, entries };
    const bytes = zipPackage(patched);
    // 다시 묶은 파일을 같은 엄격한 reader로 열어, 고친 시트 말고 모든 파트가 원본 내용과 byte 단위로 같은지 확인한다.
    assertPackageContent(bytes, patched);
    return { ok: true, bytes, changedCells };
  } catch (error) {
    if (error instanceof PatchProblems) return { ok: false, problems: error.problems };
    if (error instanceof ZipPackageError) return { ok: false, problems: [error.message] };
    throw error;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
