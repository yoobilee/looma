import { resultImportFieldLabel, testAssetImportFieldLabel, testPerspectiveLabel, testResultLabel } from './labels';
import { contentChanges, parseImportRow, type ColumnMapping, type ImportTable, type ImportTableRow, type TestAssetImportField } from './testAssetImport';
import { platformResultFields, resultValueKey, type ResultColumnMapping } from './testResultImport';
import type { ImportSourceArtifact, ImportSourceSnapshot, TestAssetImportSession, TestCase, TestResult, TestResultImport } from './types';

/*
 * 원본 형식 내보내기 계획. 가져온 원본 파일의 기존 행 · 셀만 대상으로, 지금 Looma 값과 다른 셀의 새 값을 정한다.
 * 파일 형식(XLSX XML)은 모른다. 모든 검증을 통과해야만 계획을 돌려주고, 하나라도 문제가 있으면 문제만 돌려준다.
 * - 행은 고객사 TC ID로 다시 찾지 않는다. 가져올 때 남긴 행 출처(TC: importSource, 결과: sourceRowNumber)만 쓴다.
 * - 가져올 때 매핑하지 않은 열은 바꾸지 않는다. 새 행은 만들지 않는다.
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

export interface ReadySourceExportPlan {
  ok: true;
  artifactId: string;
  fileName: string;
  layout: SourceExportLayout;
  patches: SourceCellPatch[];
  notices: string[];
  /** 가져올 때의 표. 내보낸 파일을 다시 읽은 표와 비교한다. */
  snapshot: ImportSourceSnapshot;
  /** 내보낸 파일을 다시 읽은 행이 지금 Looma 값(TC · 결과)과 같은지 확인한다. 문제를 돌려준다. */
  verifyEntities: (rows: ReadonlyMap<number, ImportTableRow>) => string[];
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

/**
 * TC 가져오기 원본의 내보내기 계획. 이 가져오기에서 만들거나 바꾼 TC(importSource가 이 기록을 가리키는 TC)만 대상이다.
 * 바뀐 칸은 가져오기와 같은 비교 규칙(contentChanges)으로 고르고, 고친 행을 다시 읽었을 때 지금 TC와 같아지는지 확인한다.
 */
export function planTestAssetSourceExport(session: TestAssetImportSession, artifact: ImportSourceArtifact | undefined, projectTestCases: TestCase[]): SourceExportPlan {
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
  const notLinked = projectTestCases.filter((testCase) => testCase.importSource?.sessionId !== session.id).length;
  const notices = notLinked > 0 ? [`이 파일의 행과 연결되지 않은 TC ${notLinked}건(신규 TC 등)은 포함되지 않아요.`] : [];
  const verifyEntities = (outputRows: ReadonlyMap<number, ImportTableRow>) =>
    linked.flatMap((testCase) => {
      const rowNumber = testCase.importSource!.rowNumber;
      const row = outputRows.get(rowNumber);
      if (!row) return [`${rowNumber}행: 내보낸 파일에서 이 행을 다시 읽을 수 없어요.`];
      const reparsed = parseImportRow(row, mapping);
      const different = Object.keys(contentChanges(reparsed, testCase, fields));
      if (fields.has('externalId') && !sameText(reparsed.externalId, testCase.externalId)) different.push('externalId');
      return different.length > 0 ? [`${rowNumber}행(${testCase.externalId ?? testCase.title}): 내보낸 파일을 다시 읽은 값이 지금 TC와 달라요. (${different.join(', ')})`] : [];
    });
  return { ok: true, artifactId: ready.artifactId!, fileName: session.fileName, layout: ready.layout!, patches, notices, snapshot: ready.snapshot, verifyEntities };
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
  return { ok: true, artifactId: ready.artifactId!, fileName: resultImport.fileRef, layout: ready.layout!, patches, notices: [], snapshot: ready.snapshot, verifyEntities };
}

/**
 * 내보낸 파일을 가져오기와 같은 reader로 다시 읽은 표가 기대와 같은지 확인한다.
 * - 바꾼 칸은 계획한 새 값과 정확히 같아야 한다(줄바꿈 · 공백 포함).
 * - 바꾸지 않은 칸 · 헤더 · 행 구성은 가져올 때의 표와 정확히 같아야 한다.
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
  if (output.rows.length !== snapshot.rows.length || output.rows.some((row) => !expected.has(row.rowNumber))) problems.push('내보낸 파일의 행 구성이 가져올 때와 달라요.');
  for (const [rowNumber, cells] of expected) {
    const actual = outputRows.get(rowNumber)?.cells;
    if (!actual) continue;
    cells.forEach((value, column) => {
      if (actual[column] === value) return;
      const label = snapshot.headers[column];
      problems.push(
        changedCell.has(`${rowNumber}:${column}`)
          ? `${rowNumber}행 ${label}: 내보낸 파일에 쓰인 값이 계획한 값과 달라요(줄바꿈 · 공백 등이 바뀌었을 수 있어요).`
          : `${rowNumber}행 ${label}: 바꾸지 않은 칸의 값이 달라졌어요.`,
      );
    });
  }
  if (problems.length > 0) return problems;
  return plan.verifyEntities(outputRows);
}

/** 원본 이름 뒤에 _Looma를 붙인다. 확장자는 유지한다. 예: 고객사_TC.xlsx → 고객사_TC_Looma.xlsx */
export function sourceExportFileName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? `${fileName.slice(0, dot)}_Looma${fileName.slice(dot)}` : `${fileName}_Looma.xlsx`;
}
