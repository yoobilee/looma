/** 로컬 저장소 실패 종류. 화면은 kind로 안내를 고르고, message는 그대로 사용자에게 보여 줄 수 있다. */
export type PersistenceErrorKind =
  | 'unavailable'
  | 'conflict'
  | 'quota'
  | 'write_failed'
  | 'read_failed'
  | 'artifact_missing'
  | 'artifact_corrupt'
  | 'artifact_duplicate';

const messages: Record<PersistenceErrorKind, string> = {
  unavailable: '이 브라우저에서 로컬 저장소(IndexedDB)를 사용할 수 없어요. 개인 정보 보호 모드이거나 사이트 데이터 저장이 막혀 있을 수 있어요.',
  conflict: '다른 탭에서 Looma 데이터가 변경되어 이 변경을 저장하지 않았어요. 최신 데이터를 불러온 뒤 다시 시도해 주세요.',
  quota: '브라우저 저장 공간이 부족해 저장하지 못했어요. 이 변경은 반영되지 않았어요.',
  write_failed: '로컬 저장소에 저장하지 못했어요. 이 변경은 반영되지 않았어요.',
  read_failed: '로컬 저장소를 읽지 못했어요.',
  artifact_missing: '가져온 원본 파일을 로컬 저장소에서 찾을 수 없어요.',
  artifact_corrupt: '가져온 원본 파일이 기록과 달라요. 저장된 파일이 손상되었을 수 있어요.',
  artifact_duplicate: '같은 ID의 원본 파일이 이미 있어 이 가져오기를 저장하지 않았어요. 기존 원본 파일은 그대로예요. 다시 시도해 주세요.',
};

export class PersistenceError extends Error {
  readonly kind: PersistenceErrorKind;

  constructor(kind: PersistenceErrorKind, message = messages[kind]) {
    super(message);
    this.name = 'PersistenceError';
    this.kind = kind;
  }
}

/** 저장소 구현이 던진 오류를 화면에 보여 줄 수 있는 PersistenceError로 바꾼다. 원본 오류 내용(파일 내용 등)은 메시지에 넣지 않는다. */
export function toPersistenceError(error: unknown, fallback: PersistenceErrorKind): PersistenceError {
  if (error instanceof PersistenceError) return error;
  if (error instanceof DOMException && error.name === 'QuotaExceededError') return new PersistenceError('quota');
  // 원본 파일은 add로만 넣는다. 같은 key가 이미 있으면 ConstraintError로 transaction 전체가 취소된다.
  if (error instanceof DOMException && error.name === 'ConstraintError') return new PersistenceError('artifact_duplicate');
  return new PersistenceError(fallback);
}
