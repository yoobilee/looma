import { repositories, type Repositories } from '@/data';
import { PersistenceError } from '@/data/persistenceError';
import {
  planResultSourceExport,
  planTestAssetSourceExport,
  sourceExportFileName,
  verifySourceExportOutput,
  withoutAppends,
  type ReadySourceExportPlan,
  type SourceExportPlan,
  type SourceExportSkip,
} from '@/domain/importSourceExport';
import { toImportTable } from '@/domain/testAssetImport';
import type { XmlValidator } from '@/lib/ooxml/xlsxPatch';
import { openXlsxWorkbook } from '../imports/xlsxSheet';

/*
 * 원본 형식 내보내기 실행. 브라우저 로컬 저장소에 보관한 원본 XLSX bytes에 계획한 셀 값만 반영해 새 파일을 만든다.
 * 원본 bytes · 저장소는 바꾸지 않는다. SheetJS로 다시 쓰지 않으며, 원본이 없으면 다른 방식으로 대신 만들지 않는다.
 * 내려줄 파일은 바꾼 셀이 없어도 항상 가져오기와 같은 reader로 다시 읽어 확인한 뒤에만 돌려준다.
 */

export type SourceExportOutcome =
  | {
      ok: true;
      fileName: string;
      bytes: Uint8Array;
      changedCells: string[];
      /** 표 끝에 붙인 새 행 */
      appendedRows: { rowNumber: number; label: string }[];
      /** 새 행으로 붙이려 했지만 넣지 않은 TC와 이유 */
      skipped: SourceExportSkip[];
      notices: string[];
    }
  | { ok: false; problems: string[] };

export interface SourceExportOptions {
  repos?: Repositories;
  /** TC 내보내기에서 Looma에서 만든 TC를 표 끝에 새 행으로 붙인다. 기본은 기존 행만 고친다. */
  appendNewTestCases?: boolean;
  /** 직접 만든 파서와 별도로 XML을 검사한다. 기본은 브라우저 DOMParser(있을 때). */
  validateXml?: XmlValidator;
}

async function defaultValidator(): Promise<XmlValidator | undefined> {
  const { createDomXmlValidator } = await import('@/lib/ooxml/domXmlValidator');
  return createDomXmlValidator();
}

async function build(planned: SourceExportPlan, options: SourceExportOptions): Promise<SourceExportOutcome> {
  if (!planned.ok) return planned;
  let plan = planned;
  const repos = options.repos ?? repositories;
  let original: Uint8Array | undefined;
  try {
    original = await repos.importSources.getBytes(plan.artifactId);
  } catch (error) {
    return { ok: false, problems: [error instanceof PersistenceError ? error.message : '원본 파일을 읽지 못했어요.'] };
  }
  if (!original) return { ok: false, problems: ['원본 파일을 찾을 수 없어요.'] };

  // ZIP 처리는 내보낼 때만 불러온다.
  const { patchXlsx } = await import('@/lib/ooxml/xlsxPatch');
  const validateXml = 'validateXml' in options ? options.validateXml : await defaultValidator();
  const cellPatches = plan.patches.map((patch) => ({
    rowNumber: patch.rowNumber,
    columnIndex: patch.columnIndex,
    previousValue: patch.previousValue,
    nextValue: patch.nextValue,
    label: patch.fieldLabel,
  }));
  const rowAppends = (current: ReadySourceExportPlan) => current.appends.map((append) => ({ rowNumber: append.rowNumber, values: append.cells, label: append.label }));
  let result = patchXlsx(original, plan.layout, cellPatches, { validateXml }, rowAppends(plan));
  // 시트 구조 때문에 새 행만 붙일 수 없으면, 새 행 없이 기존 행만 고친 파일을 만들고 넣지 못한 TC와 이유를 알린다.
  if (!result.ok && result.appendBlocked && plan.appends.length > 0) {
    plan = withoutAppends(plan, result.problems);
    result = patchXlsx(original, plan.layout, cellPatches, { validateXml }, rowAppends(plan));
  }
  if (!result.ok) return { ok: false, problems: result.problems };

  // 내려줄 bytes는 항상 가져오기와 같은 reader로 다시 읽어 실제 결과를 확인한다. 하나라도 다르면 파일을 내려주지 않는다.
  // 실제로 고친 셀 수(changedCells)로 확인을 건너뛰지 않는다. 계획한 변경이 있어도 patcher가 원본과 같다고 보고
  // 셀을 고치지 않을 수 있고(예: 단독 CR), 그때 원본 bytes를 그대로 내주면 계획한 값이 파일에 없다.
  let problems: string[];
  try {
    const workbook = await openXlsxWorkbook(result.bytes.slice().buffer);
    problems = verifySourceExportOutput(plan, toImportTable(workbook.readSheet(plan.layout.sheetName).records));
  } catch {
    problems = ['내보낸 파일을 다시 읽을 수 없어요.'];
  }
  if (problems.length > 0) return { ok: false, problems: ['내보낸 파일을 다시 읽어 확인했더니 기대와 달라 내려주지 않았어요.', ...problems] };
  return {
    ok: true,
    fileName: sourceExportFileName(plan.fileName),
    bytes: result.bytes,
    changedCells: result.changedCells,
    appendedRows: plan.appends.map(({ rowNumber, label }) => ({ rowNumber, label })),
    skipped: plan.skipped,
    notices: plan.notices,
  };
}

export async function exportTestAssetSource(projectId: string, sessionId: string, options: SourceExportOptions = {}): Promise<SourceExportOutcome> {
  const repos = options.repos ?? repositories;
  const sessions = await repos.testAssetImports.listByProject(projectId);
  const session = sessions.find((item) => item.id === sessionId);
  if (!session) return { ok: false, problems: ['가져오기 기록을 찾을 수 없어요.'] };
  const artifact = session.artifactId ? await repos.importSources.get(session.artifactId) : undefined;
  const testCases = await repos.testCases.listByProject(projectId);
  // 목록 순서에 기대지 않고 가져온 시각으로 가장 최근 가져오기를 정한다. 같은 시각의 다른 가져오기가 있으면 최근으로 보지 않는다.
  const isLatestImport = sessions.every((item) => item.id === session.id || item.importedAt < session.importedAt);
  return build(planTestAssetSourceExport(session, artifact, testCases, { appendNewTestCases: options.appendNewTestCases, isLatestImport }), options);
}

export async function exportResultSource(projectId: string, importId: string, options: SourceExportOptions = {}): Promise<SourceExportOutcome> {
  const repos = options.repos ?? repositories;
  const resultImport = (await repos.testResults.listImports(projectId)).find((item) => item.id === importId);
  if (!resultImport) return { ok: false, problems: ['수행 결과 차수를 찾을 수 없어요.'] };
  const artifact = resultImport.artifactId ? await repos.importSources.get(resultImport.artifactId) : undefined;
  const results = await repos.testResults.listResults(importId);
  return build(planResultSourceExport(resultImport, artifact, results), options);
}
