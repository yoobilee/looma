import { repositories, type Repositories } from '@/data';
import { PersistenceError } from '@/data/persistenceError';
import { planResultSourceExport, planTestAssetSourceExport, sourceExportFileName, type SourceExportPlan } from '@/domain/importSourceExport';

/*
 * 원본 형식 내보내기 실행. 브라우저 로컬 저장소에 보관한 원본 XLSX bytes에 계획한 셀 값만 반영해 새 파일을 만든다.
 * 원본 bytes · 저장소는 바꾸지 않는다. SheetJS로 다시 쓰지 않으며, 원본이 없으면 다른 방식으로 대신 만들지 않는다.
 */

export type SourceExportOutcome =
  | { ok: true; fileName: string; bytes: Uint8Array; changedCells: string[]; notices: string[] }
  | { ok: false; problems: string[] };

async function build(plan: SourceExportPlan, repos: Repositories): Promise<SourceExportOutcome> {
  if (!plan.ok) return plan;
  let original: Uint8Array | undefined;
  try {
    original = await repos.importSources.getBytes(plan.artifactId);
  } catch (error) {
    return { ok: false, problems: [error instanceof PersistenceError ? error.message : '원본 파일을 읽지 못했어요.'] };
  }
  if (!original) return { ok: false, problems: ['원본 파일을 찾을 수 없어요.'] };

  // ZIP 처리는 내보낼 때만 불러온다.
  const { patchXlsx } = await import('@/lib/ooxml/xlsxPatch');
  const result = patchXlsx(
    original,
    plan.layout,
    plan.patches.map((patch) => ({
      rowNumber: patch.rowNumber,
      columnIndex: patch.columnIndex,
      previousValue: patch.previousValue,
      nextValue: patch.nextValue,
      label: patch.fieldLabel,
    })),
  );
  if (!result.ok) return result;
  return { ok: true, fileName: sourceExportFileName(plan.fileName), bytes: result.bytes, changedCells: result.changedCells, notices: plan.notices };
}

export async function exportTestAssetSource(projectId: string, sessionId: string, repos: Repositories = repositories): Promise<SourceExportOutcome> {
  const session = (await repos.testAssetImports.listByProject(projectId)).find((item) => item.id === sessionId);
  if (!session) return { ok: false, problems: ['가져오기 기록을 찾을 수 없어요.'] };
  const artifact = session.artifactId ? await repos.importSources.get(session.artifactId) : undefined;
  const testCases = await repos.testCases.listByProject(projectId);
  return build(planTestAssetSourceExport(session, artifact, testCases), repos);
}

export async function exportResultSource(projectId: string, importId: string, repos: Repositories = repositories): Promise<SourceExportOutcome> {
  const resultImport = (await repos.testResults.listImports(projectId)).find((item) => item.id === importId);
  if (!resultImport) return { ok: false, problems: ['수행 결과 차수를 찾을 수 없어요.'] };
  const artifact = resultImport.artifactId ? await repos.importSources.get(resultImport.artifactId) : undefined;
  const results = await repos.testResults.listResults(importId);
  return build(planResultSourceExport(resultImport, artifact, results), repos);
}
