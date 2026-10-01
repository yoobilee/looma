import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import {
  attribute,
  attributeNs,
  childElements,
  escapeXmlText,
  firstChild,
  isXmlSafeText,
  parseXml,
  textContent,
  XmlParseError,
  type XmlElement,
} from './xml';

/*
 * 원본 XLSX 패키지에서 한 워크시트의 기존 셀 값만 바꾼다.
 * - 원본 ZIP의 다른 파트(styles · theme · sharedStrings · 다른 시트 · 그림 · rels · workbook)는 내용 그대로 다시 묶는다.
 * - 워크시트 XML도 바꿀 셀의 원문 구간만 교체한다. 셀의 스타일(s) 등 다른 속성은 유지한다.
 * - sharedStrings는 고치지 않는다. 바꾼 셀은 inline string으로 쓴다.
 * - 수식 셀 · 예상과 다른 셀이 하나라도 있으면 파일을 만들지 않는다(부분 결과 없음).
 */

const RELATIONSHIP_NS = ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships'];
const REL_TYPE = {
  officeDocument: '/officeDocument',
  worksheet: '/worksheet',
  sharedStrings: '/sharedStrings',
};

/** 표의 몇 번째 열(0부터)을 바꾸는지. 열 위치는 시트에서 헤더 행을 찾아 정한다. */
export interface XlsxCellPatch {
  rowNumber: number;
  columnIndex: number;
  /** 가져올 때 이 셀에 있던 값. 시트의 현재 값과 다르면 다른 파일로 보고 멈춘다. */
  previousValue: string;
  nextValue: string;
  /** 안내에 쓰는 이름 (예: 12행 · 테스트 항목) */
  label: string;
}

export interface XlsxSheetLayout {
  sheetName: string;
  headerRowNumber: number;
  /** 가져올 때 읽은 헤더. 시트의 실제 헤더와 같아야 열 위치를 믿을 수 있다. */
  headers: string[];
}

export type XlsxPatchResult = { ok: true; bytes: Uint8Array; changedCells: string[] } | { ok: false; problems: string[] };

class PatchProblems extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('\n'));
  }
}

/* ---------- 경로 · 관계 ---------- */

const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '');

/** rels의 Target을 패키지 안 경로로 바꾼다. */
function resolveTarget(baseDir: string, target: string): string {
  const joined = target.startsWith('/') ? target.slice(1) : baseDir + target;
  const parts: string[] = [];
  for (const part of joined.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.' && part !== '') parts.push(part);
  }
  return parts.join('/');
}

const relsPathOf = (partPath: string) => `${dirOf(partPath)}_rels/${partPath.slice(dirOf(partPath).length)}.rels`;

interface Relationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

function readRelationships(xml: XmlElement, baseDir: string): Relationship[] {
  return childElements(xml, 'Relationship').map((item) => ({
    id: attribute(item, 'Id') ?? '',
    type: attribute(item, 'Type') ?? '',
    target: resolveTarget(baseDir, attribute(item, 'Target') ?? ''),
    external: attribute(item, 'TargetMode') === 'External',
  }));
}

/* ---------- 셀 주소 · 값 ---------- */

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
  const match = /^([A-Z]{1,3})([1-9][0-9]*)$/.exec(ref);
  if (!match) return undefined;
  const column = [...match[1]].reduce((sum, char) => sum * 26 + (char.charCodeAt(0) - 64), 0) - 1;
  return { column, row: Number(match[2]) };
}

/** OOXML 문자열의 _xHHHH_ 표기를 푼다(Excel이 제어 문자를 저장하는 방식). */
const decodeOoxmlEscapes = (text: string) => text.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

/** 값에 있는 _xHHHH_ 모양 문자열이 제어 문자로 풀리지 않도록 앞의 _를 _x005F_로 적는다. */
const encodeOoxmlEscapes = (text: string) => text.replace(/_(x[0-9A-Fa-f]{4}_)/g, '_x005F_$1');

const normalizeNewlines = (text: string) => text.replace(/\r\n?/g, '\n');

type CellValue = { kind: 'string'; text: string } | { kind: 'other'; text: string } | { kind: 'empty' };

function readCellValue(cell: XmlElement, sharedStrings: () => string[]): CellValue {
  const type = attribute(cell, 't');
  const valueElement = firstChild(cell, 'v');
  const raw = valueElement ? textContent(valueElement) : undefined;
  if (type === 'inlineStr') {
    const inline = firstChild(cell, 'is');
    const text = inline ? decodeOoxmlEscapes(textContent(inline, ['rPh'])) : '';
    return text === '' ? { kind: 'empty' } : { kind: 'string', text };
  }
  if (raw === undefined || raw === '') return { kind: 'empty' };
  if (type === 's') {
    const text = sharedStrings()[Number(raw)];
    if (text === undefined) throw new PatchProblems([`${attribute(cell, 'r')} 셀의 공유 문자열을 찾을 수 없어요.`]);
    return text === '' ? { kind: 'empty' } : { kind: 'string', text };
  }
  if (type === 'str') return { kind: 'string', text: decodeOoxmlEscapes(raw) };
  return { kind: 'other', text: raw };
}

/* ---------- 패키지 ---------- */

function readPart(entries: Record<string, Uint8Array>, path: string): string {
  const bytes = entries[path];
  if (!bytes) throw new PatchProblems([`XLSX 안에 ${path} 파트가 없어요.`]);
  return strFromU8(bytes);
}

function parsePart(entries: Record<string, Uint8Array>, path: string): XmlElement {
  try {
    return parseXml(readPart(entries, path));
  } catch (error) {
    if (error instanceof XmlParseError) throw new PatchProblems([`${path}를 읽을 수 없어요. ${error.message}`]);
    throw error;
  }
}

interface ResolvedSheet {
  worksheetPath: string;
  sharedStringsPath?: string;
}

/** _rels/.rels → workbook → workbook rels → 시트 이름으로 워크시트 파트를 찾는다. 경로를 짐작하지 않는다. */
export function resolveWorksheet(entries: Record<string, Uint8Array>, sheetName: string): ResolvedSheet {
  const packageRels = readRelationships(parsePart(entries, '_rels/.rels'), '');
  const workbookRel = packageRels.find((item) => item.type.endsWith(REL_TYPE.officeDocument) && !item.external);
  if (!workbookRel) throw new PatchProblems(['XLSX의 workbook 위치를 찾을 수 없어요.']);
  const workbookPath = workbookRel.target;
  const workbook = parsePart(entries, workbookPath);
  const workbookRels = readRelationships(parsePart(entries, relsPathOf(workbookPath)), dirOf(workbookPath));

  const sheetGroup = firstChild(workbook, 'sheets');
  const sheets = sheetGroup ? childElements(sheetGroup, 'sheet') : [];
  const matches = sheets.filter((item) => attribute(item, 'name') === sheetName);
  if (matches.length !== 1) throw new PatchProblems([`원본 파일에서 '${sheetName}' 시트를 찾을 수 없어요.`]);
  const relationshipId = attributeNs(matches[0], RELATIONSHIP_NS, 'id');
  const sheetRel = workbookRels.find((item) => item.id === relationshipId);
  if (!sheetRel || sheetRel.external || !sheetRel.type.endsWith(REL_TYPE.worksheet)) throw new PatchProblems([`'${sheetName}'은 값을 바꿀 수 있는 워크시트가 아니에요.`]);
  if (!entries[sheetRel.target]) throw new PatchProblems([`'${sheetName}' 시트 파트(${sheetRel.target})가 패키지에 없어요.`]);

  const sharedRel = workbookRels.find((item) => item.type.endsWith(REL_TYPE.sharedStrings) && !item.external);
  return { worksheetPath: sheetRel.target, ...(sharedRel && entries[sharedRel.target] && { sharedStringsPath: sharedRel.target }) };
}

function readSharedStrings(entries: Record<string, Uint8Array>, path: string | undefined): string[] {
  if (!path) return [];
  const root = parsePart(entries, path);
  // 발음 표시(rPh)는 셀에 보이는 값이 아니므로 뺀다.
  return childElements(root, 'si').map((item) => decodeOoxmlEscapes(textContent(item, ['rPh'])));
}

/* ---------- 워크시트 patch ---------- */

interface Edit {
  start: number;
  end: number;
  text: string;
}

function cellXml(prefix: string, attributesText: string, value: string): string {
  const qualified = (local: string) => (prefix ? `${prefix}:${local}` : local);
  if (value === '') return `<${qualified('c')}${attributesText}/>`;
  const text = escapeXmlText(encodeOoxmlEscapes(value));
  return `<${qualified('c')}${attributesText} t="inlineStr"><${qualified('is')}><${qualified('t')} xml:space="preserve">${text}</${qualified('t')}></${qualified('is')}></${qualified('c')}>`;
}

/** 시작 태그의 속성 원문을 그대로 쓰되 t(값 종류)는 뺀다. 스타일(s) 등은 유지된다. */
function attributesWithoutType(source: string, cell: XmlElement): string {
  return cell.attributes
    .filter((item) => item.name !== 't')
    .map((item) => ` ${source.slice(item.rawStart, item.rawEnd)}`)
    .join('');
}

/** 새로 만드는 셀의 스타일: 행 서식이 있으면 행, 없으면 열 서식을 따른다. */
function inheritedStyle(worksheet: XmlElement, row: XmlElement, column: number): string | undefined {
  const rowStyle = attribute(row, 's');
  const customFormat = attribute(row, 'customFormat');
  if (rowStyle && (customFormat === '1' || customFormat === 'true')) return rowStyle;
  const cols = firstChild(worksheet, 'cols');
  const col = cols && childElements(cols, 'col').find((item) => Number(attribute(item, 'min')) <= column + 1 && column + 1 <= Number(attribute(item, 'max')));
  return col ? attribute(col, 'style') : undefined;
}

export interface PatchWorksheetResult {
  xml: string;
  changedCells: string[];
}

/** 워크시트 XML에 셀 값을 반영한다. 문제가 하나라도 있으면 PatchProblems를 던진다. */
export function patchWorksheetXml(source: string, layout: XlsxSheetLayout, patches: XlsxCellPatch[], sharedStrings: () => string[]): PatchWorksheetResult {
  let worksheet: XmlElement;
  try {
    worksheet = parseXml(source);
  } catch (error) {
    throw new PatchProblems([`'${layout.sheetName}' 시트 XML을 읽을 수 없어요. ${error instanceof Error ? error.message : ''}`.trim()]);
  }
  const sheetData = firstChild(worksheet, 'sheetData');
  if (!sheetData) throw new PatchProblems([`'${layout.sheetName}' 시트에 데이터가 없어요.`]);

  const rows = new Map<number, XmlElement>();
  const cells = new Map<string, { cell: XmlElement; row: XmlElement; column: number }>();
  let firstColumn = Number.POSITIVE_INFINITY;
  for (const row of childElements(sheetData, 'row')) {
    const rowNumber = Number(attribute(row, 'r'));
    if (!Number.isInteger(rowNumber) || rowNumber < 1) throw new PatchProblems(['행 번호(r)가 없는 행이 있어 지원하지 않는 시트 구조예요.']);
    rows.set(rowNumber, row);
    for (const cell of childElements(row, 'c')) {
      const ref = attribute(cell, 'r');
      const position = ref ? parseCellRef(ref) : undefined;
      if (!ref || !position || position.row !== rowNumber) throw new PatchProblems([`${rowNumber}행에 주소(r)가 없거나 맞지 않는 셀이 있어 지원하지 않는 시트 구조예요.`]);
      cells.set(ref, { cell, row, column: position.column });
      // 가져올 때(SheetJS)처럼 값이 있는 셀 중 가장 왼쪽 열을 표의 첫 열로 본다.
      if (readCellValue(cell, sharedStrings).kind !== 'empty') firstColumn = Math.min(firstColumn, position.column);
    }
  }
  if (!Number.isFinite(firstColumn)) throw new PatchProblems([`'${layout.sheetName}' 시트에 값이 없어요.`]);

  const problems: string[] = [];

  // 헤더가 가져올 때와 같아야 열 위치를 믿을 수 있다.
  layout.headers.forEach((header, index) => {
    const ref = `${columnLetters(firstColumn + index)}${layout.headerRowNumber}`;
    const found = cells.get(ref);
    const value = found ? readCellValue(found.cell, sharedStrings) : ({ kind: 'empty' } as const);
    const text = value.kind === 'empty' ? '' : normalizeNewlines(value.text).trim();
    const generated = header === `열 ${index + 1}`;
    if (text === header || (generated && text === '')) return;
    problems.push(`${ref} 헤더가 가져올 때와 달라요. (가져올 때 '${header}', 지금 '${text}')`);
  });

  const edits: Edit[] = [];
  const insertions = new Map<XmlElement, { column: number; xml: string }[]>();
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
    const row = rows.get(patch.rowNumber);
    if (!row) {
      problems.push(`${where}: 원본 시트에서 ${patch.rowNumber}행을 찾을 수 없어요.`);
      continue;
    }
    const found = cells.get(ref);
    if (!found) {
      if (patch.previousValue.trim() !== '') {
        problems.push(`${where}: 가져올 때 값이 있던 셀이 원본 시트에 없어요.`);
        continue;
      }
      if (value === '') continue;
      const style = inheritedStyle(worksheet, row, column);
      const xml = cellXml(row.prefix, ` r="${ref}"${style ? ` s="${style}"` : ''}`, value);
      insertions.set(row, [...(insertions.get(row) ?? []), { column, xml }]);
      changedCells.push(ref);
      continue;
    }
    const { cell } = found;
    if (firstChild(cell, 'f')) {
      problems.push(`${where}: 수식 셀이라 값을 바꾸지 않아요. 수식을 지우거나 덮어쓰지 않도록 내보내기를 멈췄어요.`);
      continue;
    }
    const unexpected = childElements(cell).filter((child) => child.localName !== 'v' && child.localName !== 'is');
    if (unexpected.length > 0) {
      problems.push(`${where}: 지원하지 않는 셀 구조(${unexpected[0].localName})예요.`);
      continue;
    }
    const current = readCellValue(cell, sharedStrings);
    const currentText = current.kind === 'empty' ? '' : normalizeNewlines(current.text);
    if (current.kind !== 'other' && currentText !== normalizeNewlines(patch.previousValue)) {
      problems.push(`${where}: 셀 값이 가져올 때와 달라요. 다른 파일이거나 가져온 뒤 바뀐 파일일 수 있어요.`);
      continue;
    }
    edits.push({ start: cell.start, end: cell.end, text: cellXml(cell.prefix, attributesWithoutType(source, cell), value) });
    changedCells.push(ref);
  }

  if (problems.length > 0) throw new PatchProblems(problems);

  // 없던 셀은 열 순서에 맞는 자리에 넣는다.
  for (const [row, added] of insertions) {
    const existing = childElements(row, 'c').map((cell) => ({ cell, column: parseCellRef(attribute(cell, 'r')!)!.column }));
    const byPosition = new Map<number, string[]>();
    for (const item of added.sort((a, b) => a.column - b.column)) {
      const next = existing.find((entry) => entry.column > item.column);
      const position = next ? next.cell.start : row.selfClosing ? -1 : row.closeStart;
      byPosition.set(position, [...(byPosition.get(position) ?? []), item.xml]);
    }
    for (const [position, xmls] of byPosition) {
      if (position >= 0) {
        edits.push({ start: position, end: position, text: xmls.join('') });
        continue;
      }
      // <row .../> 를 <row ...>새 셀</row> 로 바꾼다.
      const openTag = source.slice(row.start, row.end).replace(/\s*\/>$/, '>');
      edits.push({ start: row.start, end: row.end, text: `${openTag}${xmls.join('')}</${row.name}>` });
    }
  }

  let xml = source;
  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) xml = xml.slice(0, edit.start) + edit.text + xml.slice(edit.end);

  // 고친 XML이 여전히 올바른지 다시 읽어 확인한다.
  try {
    parseXml(xml);
  } catch (error) {
    throw new PatchProblems([`고친 시트 XML이 올바르지 않아 내보내기를 멈췄어요. ${error instanceof Error ? error.message : ''}`.trim()]);
  }
  return { xml, changedCells: changedCells.sort() };
}

const UTF8_BOM = [0xef, 0xbb, 0xbf];

/**
 * 원본 XLSX bytes에 셀 값을 반영한 새 XLSX bytes를 만든다. 원본 bytes는 바꾸지 않는다.
 * 바꿀 셀이 없으면 원본 bytes를 그대로(복사본으로) 돌려준다.
 */
export function patchXlsx(original: Uint8Array, layout: XlsxSheetLayout, patches: XlsxCellPatch[]): XlsxPatchResult {
  if (patches.length === 0) return { ok: true, bytes: original.slice(), changedCells: [] };
  try {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(original);
    } catch {
      return { ok: false, problems: ['원본 XLSX 패키지를 열 수 없어요. 손상되었거나 암호가 걸린 파일일 수 있어요.'] };
    }
    const resolved = resolveWorksheet(entries, layout.sheetName);
    const worksheetBytes = entries[resolved.worksheetPath];
    const hasBom = UTF8_BOM.every((byte, index) => worksheetBytes[index] === byte);
    const source = strFromU8(hasBom ? worksheetBytes.subarray(3) : worksheetBytes);
    const declaration = /^<\?xml[^>]*encoding=["']([^"']+)["']/i.exec(source);
    if (declaration && declaration[1].toLowerCase() !== 'utf-8') return { ok: false, problems: [`${declaration[1]} 인코딩 시트는 지원하지 않아요.`] };

    let shared: string[] | undefined;
    const sharedStrings = () => (shared ??= readSharedStrings(entries, resolved.sharedStringsPath));
    const { xml, changedCells } = patchWorksheetXml(source, layout, patches, sharedStrings);

    const encoded = strToU8(xml);
    const files: Zippable = {};
    for (const [path, bytes] of Object.entries(entries)) {
      files[path] = path === resolved.worksheetPath ? (hasBom ? concat(Uint8Array.from(UTF8_BOM), encoded) : encoded) : bytes;
    }
    return { ok: true, bytes: zipSync(files, { level: 6 }), changedCells };
  } catch (error) {
    if (error instanceof PatchProblems) return { ok: false, problems: error.problems };
    throw error;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
