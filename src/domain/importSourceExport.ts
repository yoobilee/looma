import { isXmlSafeText } from '@/lib/ooxml/xml';
import { resultImportFieldLabel, testAssetImportFieldLabel, testCaseStatusLabel, testPerspectiveLabel, testResultLabel } from './labels';
import { analyzeTestAssetImport, compositeKey, contentChanges, parseImportRow, type AnalyzedImportRow, type ColumnMapping, type ImportTable, type ImportTableRow, type TestAssetImportField } from './testAssetImport';
import { platformResultFields, resultValueKey, type ResultColumnMapping } from './testResultImport';
import type { ImportSourceArtifact, ImportSourceSnapshot, TestAssetImportSession, TestCase, TestCaseStatus, TestResult, TestResultImport } from './types';

/*
 * 원본 형식 내보내기 계획. 가져온 원본 파일의 기존 행 · 셀을 대상으로, 지금 Looma 값과 다른 셀의 새 값을 정한다.
 * 파일 형식(XLSX XML)은 모른다. 모든 검증을 통과해야만 계획을 돌려주고, 하나라도 문제가 있으면 문제만 돌려준다.
 * - 행은 고객사 TC ID로 다시 찾지 않는다. 가져올 때 남긴 행 출처(TC: importSource, 결과: sourceRowNumber)만 쓴다.
 * - 가져올 때 매핑하지 않은 열은 바꾸지 않는다.
 * - 새 행은 TC 내보내기에서 요청했을 때만, Looma에서 만든 TC(importSource 없음)를 그 가져오기의 원본 표 끝에 이어 붙인다(appends).
 *   넣을 수 없는 TC는 추측하지 않고 이유와 함께 skipped로 돌려준다. 고객사 TC ID는 만들지 않는다(없으면 빈 칸).
 * - 만든 파일은 다시 읽어 verifySourceExportOutput으로 확인한다. 계획 단계의 확인만으로 끝내지 않는다.
 */

export interface SourceCellPatch {
  rowNumber: number;
  /** 가져온 표의 열 순서(0부터) */
  columnIndex: number;
  field: string;
  fieldLabel: string;
  entityId: string;
  previousValue: string;
  nextValue: string;
}

export interface SourceExportLayout {
  sheetName: string;
  headerRowNumber: number;
  headers: string[];
}

/** 원본 표 끝에 이어 붙일 새 행. cells는 가져온 표의 열 순서대로의 값이다(매핑하지 않은 열은 빈 값). */
export interface SourceRowAppend {
  rowNumber: number;
  entityId: string;
  label: string;
  cells: string[];
  /** 파일에 TC ID 열이 있지만 TC에 고객사 TC ID가 없어 그 칸을 비워 둔 행 */
  missingExternalId: boolean;
}

/** 내보내기 대상이었지만 파일에 넣지 않은 항목과 이유 */
export interface SourceExportSkip {
  entityId: string;
  label: string;
  reason: string;
}

export interface ReadySourceExportPlan {
  ok: true;
  artifactId: string;
  fileName: string;
  layout: SourceExportLayout;
  patches: SourceCellPatch[];
  appends: SourceRowAppend[];
  skipped: SourceExportSkip[];
  notices: string[];
  /** 가져올 때의 표. 내보낸 파일을 다시 읽은 표와 비교한다. */
  snapshot: ImportSourceSnapshot;
  /** 내보낸 파일을 다시 읽은 행(기존 행 · 붙인 새 행)이 지금 Looma 값(TC · 결과)과 같은지 확인한다. 문제를 돌려준다. */
  verifyEntities: (rows: ReadonlyMap<number, ImportTableRow>, appends: SourceRowAppend[]) => string[];
}

export type SourceExportPlan = ReadySourceExportPlan | { ok: false; problems: string[] };

export const SOURCE_EXPORT_UNAVAILABLE = '원본 형식을 유지한 XLSX 내보내기를 사용할 수 없어요.';

interface SourceRecord {
  artifactId?: string;
  sourceSnapshot?: ImportSourceSnapshot;
}

/** 원본 · snapshot · 열 매핑이 내보내기에 쓸 수 있는 상태인지 확인한다. */
function readySource(record: SourceRecord, artifact: ImportSourceArtifact | undefined, mapping: unknown[] | undefined) {
  const problems: string[] = [];
  if (!record.artifactId) return { problems: [`${SOURCE_EXPORT_UNAVAILABLE} 원본 파일을 보관하지 않은 가져오기예요.`] };
  if (!artifact) return { problems: [`${SOURCE_EXPORT_UNAVAILABLE} 원본 파일 기록을 찾을 수 없어요.`] };
  if (artifact.format !== 'xlsx') return { problems: [`${SOURCE_EXPORT_UNAVAILABLE} CSV로 가져온 기록이에요.`] };
  const snapshot = record.sourceSnapshot;
  if (!snapshot) problems.push(`${SOURCE_EXPORT_UNAVAILABLE} 가져올 때의 표 구조(snapshot)가 없어요.`);
  if (!mapping) problems.push(`${SOURCE_EXPORT_UNAVAILABLE} 가져올 때의 열 매핑이 없어요.`);
  if (!snapshot || !mapping) return { problems };
  if (snapshot.format !== 'xlsx') problems.push('표 구조(snapshot)가 XLSX에서 읽은 것이 아니에요.');
  if (!snapshot.sheetName) problems.push('가져온 시트 이름이 기록되어 있지 않아요.');
  else if (artifact.selectedSheetName && artifact.selectedSheetName !== snapshot.sheetName) {
    problems.push(`원본 파일 기록의 시트(${artifact.selectedSheetName})와 표 구조의 시트(${snapshot.sheetName})가 달라요.`);
  }
  if (mapping.length !== snapshot.headers.length) problems.push('열 매핑과 표 구조의 열 수가 달라요.');
  if (snapshot.rows.length === 0) problems.push('가져온 데이터 행이 없어요.');
  if (problems.length > 0) return { problems };
  const layout: SourceExportLayout = { sheetName: snapshot.sheetName!, headerRowNumber: snapshot.rows[0].rowNumber - 1, headers: [...snapshot.headers] };
  return { problems, snapshot, layout, artifactId: artifact.id };
}

const rowsByNumber = (snapshot: ImportSourceSnapshot) => new Map(snapshot.rows.map((row) => [row.rowNumber, row]));

/* ---------- TC ---------- */

const depthIndex: Partial<Record<TestAssetImportField, number>> = { depth1: 0, depth2: 1, depth3: 2 };

/** TC 값을 원본 열 하나에 쓸 문자열로 바꾼다. Test Step은 가져올 때와 같은 "번호. 내용" 줄로 쓴다. */
function renderTestCaseField(testCase: TestCase, field: TestAssetImportField): string {
  switch (field) {
    case 'externalId':
      return testCase.externalId ?? '';
    case 'category':
      return testPerspectiveLabel[testCase.category];
    case 'feature':
      return testCase.feature;
    case 'depth1':
    case 'depth2':
    case 'depth3':
      return testCase.depth[depthIndex[field]!] ?? '';
    case 'title':
      return testCase.title;
    case 'precondition':
      return testCase.precondition ?? '';
    case 'steps':
      return testCase.steps.map((step, index) => `${index + 1}. ${step}`).join('\n');
    case 'expectedResult':
      return testCase.expectedResult;
  }
}

const sameText = (a: string | undefined, b: string | undefined) => (a ?? '').normalize('NFC').trim() === (b ?? '').normalize('NFC').trim();

/** 이 열이 TC의 어떤 변경을 담는가. 기능 열이 없으면 대분류 열이 기능도 담는다. */
function fieldTouched(field: TestAssetImportField, changed: Set<string>, mapping: ColumnMapping): boolean {
  if (field === 'externalId') return changed.has('externalId');
  if (field === 'depth1') return changed.has('depth') || (changed.has('feature') && !mapping.includes('feature'));
  if (field === 'depth2' || field === 'depth3') return changed.has('depth');
  return changed.has(field);
}

/** 이 TC를 파일에서 다시 읽은 행(row)이 지금 TC와 다른 필드. 비어 있으면 같은 뜻이다. */
function differentFields(row: ImportTableRow, testCase: TestCase, mapping: ColumnMapping, fields: Set<TestAssetImportField>): string[] {
  const reparsed = parseImportRow(row, mapping);
  const different = Object.keys(contentChanges(reparsed, testCase, fields));
  if (fields.has('externalId') && !sameText(reparsed.externalId, testCase.externalId)) different.push('externalId');
  return different;
}

export interface TestAssetSourceExportOptions {
  /** Looma에서 만든 TC(importSource 없음)를 이 가져오기의 원본 표 끝에 새 행으로 붙인다. 기본은 기존 행만 고친다. */
  appendNewTestCases?: boolean;
}

/** Excel 셀 하나에 넣을 수 있는 최대 글자 수 */
const MAX_CELL_TEXT = 32767;

/** 고객사 파일에 새 행으로 넣을 수 있는 TC 상태. 검토를 마치지 않은 TC는 넣지 않는다. */
const APPENDABLE_STATUSES: TestCaseStatus[] = ['reviewed', 'active'];

const testCaseLabel = (testCase: TestCase) => `${testCase.externalId ?? 'TC ID 없음'} · ${testCase.title}`;

/** 내보낸 파일을 다시 가져올 때 이 행이 그 TC와 정확히 하나로 이어지지 않는 이유. 이어지면 undefined. */
function reimportProblem(item: AnalyzedImportRow | undefined, testCase: TestCase, byId: ReadonlyMap<string, TestCase>): string | undefined {
  if (!item) return '다시 가져올 때 이 행을 읽을 수 없어요.';
  if (item.kind === 'exact_match' && item.targetId === testCase.id) return undefined;
  const prefix = '다시 가져오면 이 TC와 정확히 이어지지 않아요.';
  switch (item.kind) {
    case 'invalid':
      return `${prefix} 오류 행이 돼요. (${item.issues.filter((issue) => issue.level === 'error').map((issue) => issue.message).join(' ')})`;
    case 'new':
      return `${prefix} 고객사 TC ID가 없는 행은 기능 · 테스트 항목 · Pre-condition · Expected Result로 TC를 찾는데, 이 파일에 쓰이는 값(매핑한 열)만으로는 지금 TC와 같지 않아요(매핑하지 않은 열의 값 등).`;
    case 'conflict':
      if (item.conflictReason === 'shared_target') return `${prefix} 파일의 다른 행도 같은 TC를 가리켜요(파일에 쓰이는 값이 같은 행).`;
      if (item.conflictReason === 'ambiguous_content') return `${prefix} 파일에 쓰이는 값 기준으로 같은 내용의 TC가 여럿이라 어느 TC인지 정할 수 없어요.`;
      if (item.conflictReason === 'ambiguous_external_id') return `${prefix} 같은 고객사 TC ID를 쓰는 TC가 여럿이에요.`;
      return `${prefix} 고객사 TC ID와 내용이 서로 다른 TC를 가리켜요.`;
    default: {
      const other = item.targetId ? byId.get(item.targetId) : undefined;
      return `${prefix} 다른 TC(${other ? testCaseLabel(other) : item.targetId})와 이어져요.`;
    }
  }
}

/**
 * Looma에서 만든 TC를 원본 표 끝에 붙일 새 행으로 바꾼다. 하나라도 확신할 수 없는 TC는 넣지 않고 이유를 남긴다.
 * 대상 파일은 사용자가 내보내기를 실행한 이 가져오기의 원본 하나다. 다른 파일로 나누거나 대상을 추측하지 않는다.
 * - 고객사 TC ID가 있으면 그 값을 쓰고, 없으면 TC ID 칸을 비운다. 번호를 만들거나 Looma 내부 ID를 대신 쓰지 않는다.
 * - TC ID가 있으면 원본 파일 · 프로젝트에서 그 ID가 겹치지 않아야 한다.
 * - 새 행을 가져오기 규칙으로 다시 읽어 지금 TC와 같은 뜻이고 다시 가져올 수 있는 행이어야 한다.
 * - 고객사 TC ID 없이 쓰는 행은 파일에 쓰일 값을 다시 읽은 내용 기준(compositeKey)이 원본 행과 같으면 넣지 않는다.
 * - 마지막으로 내보낼 표 전체(기존 행 + 새 행, 실제로 파일에 쓰일 값)를 가져오기 분석(analyzeTestAssetImport)에 그대로 넣어,
 *   새 행마다 그 TC와 정확히 하나로 exact_match되는지 확인한다. 매핑하지 않은 열 때문에 값이 빠지거나, 원본 행 · 다른 TC ·
 *   다른 새 행과 파일에 쓰이는 값이 겹쳐 다시 가져올 때 구별할 수 없는 TC는 모두 넣지 않는다(겹친 쪽도 함께 뺀다).
 */
function planNewTestCaseRows(
  candidates: TestCase[],
  projectTestCases: TestCase[],
  snapshot: ImportSourceSnapshot,
  outputRows: ImportTableRow[],
  mapping: ColumnMapping,
  fields: Set<TestAssetImportField>,
): { appends: SourceRowAppend[]; skipped: SourceExportSkip[] } {
  const skipped: SourceExportSkip[] = [];
  const skip = (testCase: TestCase, reason: string) => skipped.push({ entityId: testCase.id, label: testCaseLabel(testCase), reason });

  // 새 행은 표 마지막 행 바로 아래에 둔다. 그 행이 TC 행(다시 가져올 수 있는 행)이 아니면(합계 · 메모 · 표 밖의 값 등) 위치를 추측하지 않는다.
  const lastRow = snapshot.rows[snapshot.rows.length - 1];
  const lastParsed = parseImportRow(lastRow, mapping);
  const placementProblem =
    !lastParsed.title || !lastParsed.expectedResult || !lastParsed.feature
      ? `원본 표의 마지막 행(${lastRow.rowNumber}행)이 TC 행이 아니라(빈 칸 · 합계 · 메모 등) 새 행을 추가할 위치를 확정할 수 없어요.`
      : undefined;

  // 프로젝트 안에서 고객사 TC ID는 한 TC만 쓴다(가져오기와 같은 규칙). 다른 파일에 연결된 TC도 센다.
  const externalIdCount = new Map<string, number>();
  for (const testCase of projectTestCases) {
    const id = testCase.externalId?.normalize('NFC').trim();
    if (id) externalIdCount.set(id, (externalIdCount.get(id) ?? 0) + 1);
  }

  // 고객사 TC ID 없이 다시 가져오면 행은 가져오기와 같은 내용 기준(compositeKey)으로 TC를 찾는다. 기존 행도 파일에 쓰일 값을 다시 읽은 값으로 비교한다.
  const outputKeys = outputRows.map((row) => ({ rowNumber: row.rowNumber, key: compositeKey(parseImportRow(row, mapping)) }));

  let drafts: { testCase: TestCase; cells: string[]; missingExternalId: boolean }[] = [];
  for (const testCase of candidates) {
    if (testCase.status === 'deprecated') {
      skip(testCase, '폐기된 TC예요.');
      continue;
    }
    if (testCase.duplicateOf) {
      skip(testCase, '다른 TC의 중복으로 표시된 TC예요.');
      continue;
    }
    if (!APPENDABLE_STATUSES.includes(testCase.status)) {
      skip(testCase, `검토를 마치지 않은 TC예요(${testCaseStatusLabel[testCase.status]}). 검토 완료 또는 사용 중으로 바꾼 뒤 다시 내보내 주세요.`);
      continue;
    }
    if (placementProblem) {
      skip(testCase, placementProblem);
      continue;
    }
    const externalId = testCase.externalId?.normalize('NFC').trim();
    if (fields.has('externalId') && externalId) {
      const sameId = snapshot.rows.find((row) => sameText(row.cells[mapping.indexOf('externalId')], externalId));
      if (sameId) {
        skip(testCase, `원본 파일 ${sameId.rowNumber}행에 같은 고객사 TC ID(${externalId})가 이미 있어요.`);
        continue;
      }
      if ((externalIdCount.get(externalId) ?? 0) > 1) {
        skip(testCase, `프로젝트의 다른 TC와 고객사 TC ID(${externalId})가 같아요.`);
        continue;
      }
    }

    // 파일에는 줄바꿈을 LF로 쓴다(patcher와 같다). 다시 읽은 값과 정확히 비교할 수 있게 미리 맞춘다.
    const cells = mapping.map((field) => (field ? renderTestCaseField(testCase, field).replace(/\r\n?/g, '\n') : ''));
    if (cells.some((cell) => !isXmlSafeText(cell))) {
      skip(testCase, '파일에 쓸 수 없는 제어 문자가 있어요.');
      continue;
    }
    if (cells.some((cell) => cell.length > MAX_CELL_TEXT)) {
      skip(testCase, `셀 하나에 넣을 수 있는 글자 수(${MAX_CELL_TEXT}자)를 넘는 값이 있어요.`);
      continue;
    }
    const row: ImportTableRow = { rowNumber: 0, cells };
    const reparsed = parseImportRow(row, mapping);
    if (!reparsed.title || !reparsed.expectedResult || !reparsed.feature) {
      skip(testCase, '테스트 항목 · Expected Result · 기능(대분류) 중 빈 값이 있어 다시 가져올 수 없는 행이 돼요.');
      continue;
    }
    const different = differentFields(row, testCase, mapping, fields);
    if (different.length > 0) {
      skip(testCase, `지금 TC 값을 원본 열 구조로 정확히 옮길 수 없어요. (${different.join(', ')})`);
      continue;
    }
    if (!reparsed.externalId) {
      const key = compositeKey(reparsed);
      const sameRow = outputKeys.find((item) => item.key === key);
      if (sameRow) {
        skip(testCase, `원본 파일 ${sameRow.rowNumber}행과 파일에 쓰이는 기능 · 테스트 항목 · Pre-condition · Expected Result가 같아요. 고객사 TC ID 없이는 다시 가져올 때 구별할 수 없어요.`);
        continue;
      }
    }
    drafts.push({ testCase, cells, missingExternalId: fields.has('externalId') && !externalId });
  }

  // 내보낼 표 전체를 다시 가져오기 분석에 넣고, 정확히 이어지지 않는 새 행을 뺀다. 뺀 뒤 행 번호가 바뀌므로 모두 이어질 때까지 다시 본다.
  const byId = new Map(projectTestCases.map((testCase) => [testCase.id, testCase]));
  const firstNewRow = lastRow.rowNumber + 1;
  while (drafts.length > 0) {
    const table: ImportTable = { headers: [...snapshot.headers], rows: [...outputRows, ...drafts.map((draft, index) => ({ rowNumber: firstNewRow + index, cells: [...draft.cells] }))] };
    const analysis = analyzeTestAssetImport(table, mapping, projectTestCases);
    const byRow = new Map(analysis.rows.map((item) => [item.row.rowNumber, item]));
    const problems = drafts.map((draft, index) => reimportProblem(byRow.get(firstNewRow + index), draft.testCase, byId));
    if (problems.every((problem) => problem === undefined)) break;
    drafts.forEach((draft, index) => problems[index] && skip(draft.testCase, problems[index]));
    drafts = drafts.filter((_, index) => problems[index] === undefined);
  }

  const appends = drafts.map(({ testCase, cells, missingExternalId }, index) => ({ rowNumber: firstNewRow + index, entityId: testCase.id, label: testCaseLabel(testCase), cells, missingExternalId }));
  return { appends, skipped };
}

/**
 * TC 가져오기 원본의 내보내기 계획. 기존 행은 이 가져오기에서 만들거나 바꾼 TC(importSource가 이 기록을 가리키는 TC)만 고친다.
 * 바뀐 칸은 가져오기와 같은 비교 규칙(contentChanges)으로 고르고, 고친 행을 다시 읽었을 때 지금 TC와 같아지는지 확인한다.
 * appendNewTestCases를 켜면 Looma에서 만든 TC를 표 끝에 새 행으로 붙인다(planNewTestCaseRows).
 */
export function planTestAssetSourceExport(
  session: TestAssetImportSession,
  artifact: ImportSourceArtifact | undefined,
  projectTestCases: TestCase[],
  options: TestAssetSourceExportOptions = {},
): SourceExportPlan {
  const mapping = session.columnMapping;
  const ready = readySource(session, artifact, mapping);
  if (ready.problems.length > 0 || !ready.snapshot || !mapping) return { ok: false, problems: ready.problems };

  const fields = new Set(mapping.filter((field): field is TestAssetImportField => !!field));
  const rows = rowsByNumber(ready.snapshot);
  const linked = projectTestCases.filter((testCase) => testCase.importSource?.sessionId === session.id);
  const problems: string[] = [];
  const patches: SourceCellPatch[] = [];
  const claimedRows = new Map<number, string>();

  for (const testCase of linked) {
    const rowNumber = testCase.importSource!.rowNumber;
    const label = `${rowNumber}행(${testCase.externalId ?? testCase.title})`;
    const owner = claimedRows.get(rowNumber);
    if (owner) {
      problems.push(`${label}: 다른 TC(${owner})도 같은 원본 행을 가리켜요.`);
      continue;
    }
    claimedRows.set(rowNumber, testCase.externalId ?? testCase.id);
    const row = rows.get(rowNumber);
    if (!row) {
      problems.push(`${label}: 가져온 표에 이 행이 없어요.`);
      continue;
    }

    const original = parseImportRow(row, mapping);
    const changed = new Set<string>(Object.keys(contentChanges(original, testCase, fields)));
    if (fields.has('externalId') && !sameText(original.externalId, testCase.externalId)) changed.add('externalId');
    if (changed.size === 0) continue;

    const cells = [...row.cells];
    const rowPatches: SourceCellPatch[] = [];
    mapping.forEach((field, columnIndex) => {
      if (!field || !fieldTouched(field, changed, mapping)) return;
      const previousValue = row.cells[columnIndex] ?? '';
      const nextValue = renderTestCaseField(testCase, field);
      // 보이는 내용이 같으면 원본 표기(번호 형식 · 공백 등)를 그대로 둔다.
      if (field === 'steps' ? sameSteps(previousValue, testCase.steps) : sameText(previousValue, nextValue)) return;
      cells[columnIndex] = nextValue;
      rowPatches.push({ rowNumber, columnIndex, field, fieldLabel: testAssetImportFieldLabel[field], entityId: testCase.id, previousValue, nextValue });
    });

    // 고친 행을 가져오기 규칙으로 다시 읽어 지금 TC와 같아야 한다. 다르면 열 구조로 정확히 옮길 수 없는 값이다.
    const patchedRow: ImportTableRow = { rowNumber, cells };
    const reparsed = parseImportRow(patchedRow, mapping);
    const remaining = Object.keys(contentChanges(reparsed, testCase, fields));
    if (fields.has('externalId') && !sameText(reparsed.externalId, testCase.externalId)) remaining.push('externalId');
    if (remaining.length > 0) {
      problems.push(`${label}: 지금 TC 값을 원본 열 구조로 정확히 옮길 수 없어요. (${remaining.join(', ')})`);
      continue;
    }
    patches.push(...rowPatches);
  }

  if (problems.length > 0) return { ok: false, problems };
  const notLinked = projectTestCases.filter((testCase) => testCase.importSource?.sessionId !== session.id);
  const newCases = options.appendNewTestCases ? notLinked.filter((testCase) => !testCase.importSource) : [];
  const otherImports = notLinked.length - newCases.length;
  const notices = !options.appendNewTestCases
    ? notLinked.length > 0
      ? [`이 파일의 행과 연결되지 않은 TC ${notLinked.length}건(신규 TC 등)은 포함되지 않아요.`]
      : []
    : [
        ...(newCases.length === 0 ? ['새 행으로 추가할 Looma 신규 TC(가져온 파일과 연결되지 않은 TC)가 없어요.'] : []),
        ...(otherImports > 0 ? [`다른 가져오기 파일의 행과 연결된 TC ${otherImports}건은 포함되지 않아요.`] : []),
      ];
  const ordered = [...newCases].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  // 새 행을 다시 가져오기로 확인할 때는 기존 행도 이번에 고친 값으로 본다(실제로 파일에 쓰일 표).
  const outputRows = ready.snapshot.rows.map((row) => {
    const cells = [...row.cells];
    for (const patch of patches) if (patch.rowNumber === row.rowNumber) cells[patch.columnIndex] = patch.nextValue;
    return { rowNumber: row.rowNumber, cells };
  });
  const { appends, skipped } = ordered.length > 0 ? planNewTestCaseRows(ordered, projectTestCases, ready.snapshot, outputRows, mapping, fields) : { appends: [], skipped: [] };

  const byId = new Map(projectTestCases.map((testCase) => [testCase.id, testCase]));
  const verifyEntities = (outputRows: ReadonlyMap<number, ImportTableRow>, appended: SourceRowAppend[]) => [
    ...linked.flatMap((testCase) => {
      const rowNumber = testCase.importSource!.rowNumber;
      const row = outputRows.get(rowNumber);
      if (!row) return [`${rowNumber}행: 내보낸 파일에서 이 행을 다시 읽을 수 없어요.`];
      const different = differentFields(row, testCase, mapping, fields);
      return different.length > 0 ? [`${rowNumber}행(${testCase.externalId ?? testCase.title}): 내보낸 파일을 다시 읽은 값이 지금 TC와 달라요. (${different.join(', ')})`] : [];
    }),
    ...appended.flatMap((append) => {
      const testCase = byId.get(append.entityId);
      const row = outputRows.get(append.rowNumber);
      if (!testCase || !row) return [`${append.rowNumber}행(${append.label}): 내보낸 파일에서 새 행을 다시 읽을 수 없어요.`];
      const different = differentFields(row, testCase, mapping, fields);
      return different.length > 0 ? [`${append.rowNumber}행(${append.label}): 새 행을 다시 읽은 값이 지금 TC와 달라요. (${different.join(', ')})`] : [];
    }),
  ];
  return { ok: true, artifactId: ready.artifactId!, fileName: session.fileName, layout: ready.layout!, patches, appends, skipped, notices, snapshot: ready.snapshot, verifyEntities };
}

/** 시트 구조 때문에 새 행을 붙일 수 없을 때, 붙이려던 항목을 이유와 함께 skipped로 옮긴 계획 */
export function withoutAppends(plan: ReadySourceExportPlan, reasons: string[]): ReadySourceExportPlan {
  const reason = reasons.join(' ');
  return { ...plan, appends: [], skipped: [...plan.skipped, ...plan.appends.map(({ entityId, label }) => ({ entityId, label, reason }))] };
}

function sameSteps(cell: string, steps: string[]): boolean {
  const parsed = parseImportRow({ rowNumber: 0, cells: [cell] }, ['steps']).steps ?? [];
  return parsed.length === steps.length && parsed.every((step, index) => sameText(step, steps[index]));
}

/* ---------- 수행 결과 ---------- */

/** 결과를 읽은 열. 결과 열이 하나면 그 열, 플랫폼별 결과 열이면 결과의 플랫폼 열이다. */
function resultColumn(mapping: ResultColumnMapping, result: TestResult): number {
  if (mapping.includes('result')) return mapping.indexOf('result');
  return result.platform ? mapping.indexOf(platformResultFields[result.platform]) : -1;
}

/**
 * 수행 결과 원본의 내보내기 계획. 결과 열만 바꾸고, 원본 결과 표기를 되도록 유지한다.
 * 1) 원본 셀의 표기가 지금 결과와 같은 뜻이면 그대로 둔다.
 * 2) 다르면 이 차수에서 그 결과를 나타낸 표기가 정확히 하나일 때만 그 표기를 쓴다.
 * 3) 표기가 없거나 여러 개면 추측하지 않고 멈춘다.
 */
export function planResultSourceExport(resultImport: TestResultImport, artifact: ImportSourceArtifact | undefined, results: TestResult[]): SourceExportPlan {
  const mapping = resultImport.resultColumnMapping;
  const ready = readySource(resultImport, artifact, mapping);
  if (ready.problems.length > 0 || !ready.snapshot || !mapping) return { ok: false, problems: ready.problems };

  const rows = rowsByNumber(ready.snapshot);
  const meaningByKey = new Map(resultImport.mapping.map((item) => [resultValueKey(item.rawValue), item.result]));
  const problems: string[] = [];
  const patches: SourceCellPatch[] = [];
  const claimed = new Map<string, string>();

  const ownResults = results.filter((item) => item.importId === resultImport.id);
  for (const result of ownResults) {
    const label = `${result.sourceRowNumber ?? '?'}행(${result.externalId ?? result.title}${result.platform ? ` · ${result.platform}` : ''})`;
    if (!result.sourceRowNumber) {
      problems.push(`${label}: 결과를 읽은 원본 행이 기록되어 있지 않아요.`);
      continue;
    }
    const row = rows.get(result.sourceRowNumber);
    const columnIndex = resultColumn(mapping, result);
    if (!row || columnIndex < 0) {
      problems.push(`${label}: 가져온 표에서 이 결과의 칸을 찾을 수 없어요.`);
      continue;
    }
    const target = `${result.sourceRowNumber}:${columnIndex}`;
    if (claimed.has(target)) {
      problems.push(`${label}: 다른 결과(${claimed.get(target)})와 같은 칸을 가리켜요.`);
      continue;
    }
    claimed.set(target, result.id);

    const previousValue = row.cells[columnIndex] ?? '';
    if (meaningByKey.get(resultValueKey(previousValue)) === result.result) continue;
    const candidates = [...new Set(resultImport.mapping.filter((item) => item.result === result.result).map((item) => item.rawValue))];
    if (candidates.length !== 1) {
      problems.push(
        candidates.length === 0
          ? `${label}: 이 차수 파일에 ${testResultLabel[result.result]} 결과를 나타낸 표기가 없어 어떤 값을 쓸지 정할 수 없어요.`
          : `${label}: ${testResultLabel[result.result]} 결과의 표기가 여럿(${candidates.join(', ')})이라 어떤 값을 쓸지 정할 수 없어요.`,
      );
      continue;
    }
    const field = mapping[columnIndex]!;
    patches.push({ rowNumber: result.sourceRowNumber, columnIndex, field, fieldLabel: resultImportFieldLabel[field], entityId: result.id, previousValue, nextValue: candidates[0] });
  }

  if (problems.length > 0) return { ok: false, problems };
  const verifyEntities = (outputRows: ReadonlyMap<number, ImportTableRow>) =>
    ownResults.flatMap((result) => {
      const cell = outputRows.get(result.sourceRowNumber!)?.cells[resultColumn(mapping, result)];
      return meaningByKey.get(resultValueKey(cell ?? '')) === result.result
        ? []
        : [`${result.sourceRowNumber}행(${result.externalId ?? result.title}): 내보낸 파일을 다시 읽은 결과가 지금 결과(${testResultLabel[result.result]})와 달라요.`];
    });
  return { ok: true, artifactId: ready.artifactId!, fileName: resultImport.fileRef, layout: ready.layout!, patches, appends: [], skipped: [], notices: [], snapshot: ready.snapshot, verifyEntities };
}

/**
 * 내보낸 파일을 가져오기와 같은 reader로 다시 읽은 표가 기대와 같은지 확인한다.
 * - 바꾼 칸은 계획한 새 값과 정확히 같아야 한다(줄바꿈 · 공백 포함).
 * - 바꾸지 않은 칸 · 헤더 · 행 구성은 가져올 때의 표와 정확히 같아야 한다.
 * - 붙인 새 행은 가져올 때의 표 바로 뒤에 계획한 값 그대로 있어야 한다.
 * - 다시 읽은 행이 지금 TC · 결과와 같은 뜻이어야 한다.
 * 하나라도 다르면 그 파일을 내려주지 않는다.
 */
export function verifySourceExportOutput(plan: ReadySourceExportPlan, output: ImportTable | undefined): string[] {
  if (!output) return ['내보낸 파일에서 표를 다시 읽을 수 없어요.'];
  const problems: string[] = [];
  const { snapshot } = plan;
  if (JSON.stringify(output.headers) !== JSON.stringify(snapshot.headers)) problems.push('내보낸 파일의 헤더가 가져올 때와 달라요.');
  const outputRows = new Map(output.rows.map((row) => [row.rowNumber, row]));
  const expected = new Map(snapshot.rows.map((row) => [row.rowNumber, [...row.cells]]));
  for (const patch of plan.patches) expected.get(patch.rowNumber)![patch.columnIndex] = patch.nextValue;
  const changedCell = new Set(plan.patches.map((patch) => `${patch.rowNumber}:${patch.columnIndex}`));
  const appendedRow = new Set(plan.appends.map((append) => append.rowNumber));
  for (const append of plan.appends) expected.set(append.rowNumber, [...append.cells]);
  if (output.rows.length !== expected.size || output.rows.some((row) => !expected.has(row.rowNumber))) problems.push('내보낸 파일의 행 구성이 계획과 달라요.');
  for (const [rowNumber, cells] of expected) {
    const actual = outputRows.get(rowNumber)?.cells;
    if (!actual) continue;
    cells.forEach((value, column) => {
      if (actual[column] === value) return;
      const label = snapshot.headers[column];
      problems.push(
        appendedRow.has(rowNumber)
          ? `${rowNumber}행 ${label}: 새 행에 쓰인 값이 계획한 값과 달라요.`
          : changedCell.has(`${rowNumber}:${column}`)
            ? `${rowNumber}행 ${label}: 내보낸 파일에 쓰인 값이 계획한 값과 달라요(줄바꿈 · 공백 등이 바뀌었을 수 있어요).`
            : `${rowNumber}행 ${label}: 바꾸지 않은 칸의 값이 달라졌어요.`,
      );
    });
  }
  if (problems.length > 0) return problems;
  return plan.verifyEntities(outputRows, plan.appends);
}

/** 원본 이름 뒤에 _Looma를 붙인다. 확장자는 유지한다. 예: 고객사_TC.xlsx → 고객사_TC_Looma.xlsx */
export function sourceExportFileName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? `${fileName.slice(0, dot)}_Looma${fileName.slice(dot)}` : `${fileName}_Looma.xlsx`;
}
