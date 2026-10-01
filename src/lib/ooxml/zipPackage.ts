import { unzipSync, zipSync } from 'fflate';

/*
 * XLSX(ZIP) 패키지를 안전하게 열고 다시 묶는다. 범용 ZIP 도구가 아니라 원본 고객사 파일을 고치기 전의 문이다.
 * fflate가 이름을 객체 키로 쓰기 때문에 같은 이름 · __proto__ 같은 이름은 항목이 덮이거나 사라질 수 있다.
 * 그래서 압축을 풀기 전에 ZIP 중앙 디렉터리를 직접 읽어 이름 · 크기 · 개수를 확인하고, 푼 뒤에도 같은지 다시 맞춰 본다.
 */

export class ZipPackageError extends Error {}

/** 개인 QA 업무 파일 규모에 넉넉하지만 압축 해제로 메모리가 터지지 않을 만큼의 상한 */
export const ZIP_LIMITS = {
  /** 가져오기와 같은 원본 파일 상한 */
  maxCompressedBytes: 5 * 1024 * 1024,
  maxEntries: 2000,
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
};

export interface ZipEntryInfo {
  name: string;
  uncompressedSize: number;
}

const MB = (bytes: number) => `${Math.round(bytes / 1024 / 1024)}MB`;
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** 패키지 안 경로로 쓸 수 있는 이름인가. 폴더 항목(끝이 /)은 허용한다. */
function validEntryName(name: string): boolean {
  if (name === '' || name.startsWith('/') || name.includes('\\')) return false;
  const segments = (name.endsWith('/') ? name.slice(0, -1) : name).split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..' && segment !== '__proto__');
}

/** ZIP 끝의 중앙 디렉터리를 읽는다. ZIP64 · 여러 디스크 · 암호화 · 지원하지 않는 압축 방식은 거부한다. */
export function readCentralDirectory(bytes: Uint8Array, limits = ZIP_LIMITS): ZipEntryInfo[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minEnd = Math.max(0, bytes.length - 22 - 0xffff);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= minEnd; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new ZipPackageError('XLSX(ZIP) 구조를 찾을 수 없어요.');
  const disk = view.getUint16(eocd + 4, true);
  const cdDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const totalEntries = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (totalEntries === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new ZipPackageError('ZIP64 형식은 지원하지 않아요.');
  if (disk !== 0 || cdDisk !== 0 || entriesOnDisk !== totalEntries) throw new ZipPackageError('여러 파일로 나뉜 ZIP은 지원하지 않아요.');
  if (cdOffset + cdSize > eocd) throw new ZipPackageError('XLSX(ZIP) 구조가 올바르지 않아요.');
  if (totalEntries > limits.maxEntries) throw new ZipPackageError(`XLSX 안의 항목이 너무 많아요(${totalEntries}개, 최대 ${limits.maxEntries}개).`);

  const entries: ZipEntryInfo[] = [];
  const seen = new Set<string>();
  let total = 0;
  let offset = cdOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > eocd || view.getUint32(offset, true) !== 0x02014b50) throw new ZipPackageError('XLSX(ZIP) 목록을 읽을 수 없어요.');
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (offset > eocd) throw new ZipPackageError('XLSX(ZIP) 목록을 읽을 수 없어요.');

    if (flags & 0x1) throw new ZipPackageError('암호가 걸린 파일은 지원하지 않아요.');
    if (method !== 0 && method !== 8) throw new ZipPackageError('지원하지 않는 압축 방식의 항목이 있어요.');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) throw new ZipPackageError('ZIP64 형식은 지원하지 않아요.');
    // 이름 인코딩 표시(UTF-8)가 없으면 ASCII 이름만 받는다. 해석이 갈리는 이름으로 항목을 찾지 않는다.
    if (!(flags & 0x800) && nameBytes.some((byte) => byte > 0x7f)) throw new ZipPackageError('인코딩을 알 수 없는 항목 이름이 있어요.');
    let name: string;
    try {
      name = utf8.decode(nameBytes);
    } catch {
      throw new ZipPackageError('항목 이름이 올바른 UTF-8이 아니에요.');
    }
    if (!validEntryName(name)) throw new ZipPackageError(`지원하지 않는 항목 이름이 있어요. (${name})`);
    // OPC 파트 이름은 대소문자를 구분하지 않는다.
    const key = name.toLowerCase();
    if (seen.has(key)) throw new ZipPackageError(`같은 이름의 항목이 두 번 있어요. (${name})`);
    seen.add(key);
    if (uncompressedSize > limits.maxEntryBytes) throw new ZipPackageError(`압축을 풀면 너무 큰 항목이 있어요(${name}, 최대 ${MB(limits.maxEntryBytes)}).`);
    total += uncompressedSize;
    if (total > limits.maxTotalBytes) throw new ZipPackageError(`압축을 풀면 파일이 너무 커요(최대 ${MB(limits.maxTotalBytes)}).`);
    entries.push({ name, uncompressedSize });
  }
  return entries;
}

export interface ZipPackage {
  /** 원본 ZIP의 항목 순서 */
  names: string[];
  entries: Map<string, Uint8Array>;
}

/** 크기 · 이름을 먼저 확인한 뒤 푼다. 푼 결과가 목록과 다르면(덮인 항목, 실제 크기 다름) 거부한다. */
export function unzipPackage(bytes: Uint8Array, limits = ZIP_LIMITS): ZipPackage {
  if (bytes.length > limits.maxCompressedBytes) throw new ZipPackageError(`${MB(limits.maxCompressedBytes)} 이하 파일만 내보낼 수 있어요.`);
  const listed = readCentralDirectory(bytes, limits);
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new ZipPackageError('XLSX(ZIP) 압축을 풀 수 없어요. 손상된 파일일 수 있어요.');
  }
  if (Object.keys(files).length !== listed.length) throw new ZipPackageError('XLSX(ZIP) 항목 목록과 실제 항목이 달라요.');
  const entries = new Map<string, Uint8Array>();
  for (const { name, uncompressedSize } of listed) {
    if (!Object.prototype.hasOwnProperty.call(files, name)) throw new ZipPackageError(`XLSX(ZIP) 항목을 읽을 수 없어요. (${name})`);
    const data = files[name];
    if (data.length !== uncompressedSize) throw new ZipPackageError(`XLSX(ZIP) 항목 크기가 기록과 달라요. (${name})`);
    entries.set(name, data);
  }
  return { names: listed.map((entry) => entry.name), entries };
}

/** 원본 순서대로 다시 묶는다. */
export function zipPackage({ names, entries }: ZipPackage): Uint8Array {
  return zipSync(Object.fromEntries(names.map((name) => [name, entries.get(name)!])), { level: 6 });
}
