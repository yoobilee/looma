import { zipSync } from 'fflate';
import { Inflate } from 'pako';

/*
 * XLSX(ZIP) 패키지를 안전하게 열고 다시 묶는다. 범용 ZIP 도구가 아니라 원본 고객사 파일을 고치기 전의 문이다.
 * 정상적인 classic ZIP만 받는다. 구조가 조금이라도 모호하거나 기록과 실제가 다르면 추측 · 복구하지 않고 거부한다.
 * - 끝 기록(EOCD) · 중앙 디렉터리 · 로컬 헤더를 직접 읽어 서로 맞춰 본다(이름 · 압축 방식 · 표시 · 크기 · CRC · 위치).
 * - 항목들은 파일 처음부터 중앙 디렉터리 앞까지 빈틈 · 겹침 없이 이어져야 한다. EOCD 뒤에 다른 데이터가 있으면 안 된다.
 * - 압축은 zlib inflate를 그대로 옮긴 pako로 푼다. zlib이 거부하는 DEFLATE 스트림(stored block LEN/NLEN 불일치,
 *   잘못된 Huffman 표 · 거리 등)을 똑같이 거부한다. fflate Inflate는 이런 검사 일부를 하지 않아 손상된 스트림도 풀어 준다.
 * - 실제로 나온 bytes를 직접 센다. 결과 배열 길이만 믿지 않고, 기록보다 많이 나오면 그 자리에서 멈춘다.
 * - 압축 데이터는 기록한 크기에서 정확히 끝나야 하고, 푼 내용의 CRC32가 기록과 같아야 한다.
 * - ZIP64(sentinel 값 · ZIP64 extra field) · 여러 디스크 · 암호화 · 지원하지 않는 압축 방식 · 알 수 없는 표시(flag)는 거부한다.
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
  /** 0: 저장(압축 없음), 8: DEFLATE */
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  /** 압축 데이터가 시작하는 위치 */
  dataStart: number;
  /** 로컬 헤더부터 압축 데이터(있으면 data descriptor)까지 차지하는 구간의 끝 */
  end: number;
}

const SIGNATURE = {
  localHeader: 0x04034b50,
  centralHeader: 0x02014b50,
  endOfCentralDirectory: 0x06054b50,
  zip64Locator: 0x07064b50,
  dataDescriptor: 0x08074b50,
};
const FLAG = {
  encrypted: 0x0001,
  dataDescriptor: 0x0008,
  strongEncryption: 0x0040,
  utf8Name: 0x0800,
  encryptedDirectory: 0x2000,
};
/** 허용하는 표시: DEFLATE 압축 옵션(1 · 2), data descriptor(3), UTF-8 이름(11). 그 밖의 표시는 거부한다. */
const ALLOWED_FLAGS = 0x0002 | 0x0004 | FLAG.dataDescriptor | FLAG.utf8Name;
const ZIP64_EXTRA_ID = 0x0001;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const END_RECORD_SIZE = 22;
/** 한 번에 꺼내는 압축 해제 결과 크기. 기록보다 많이 나온 것은 그 조각을 꺼낸 직후 알아챈다(압축 폭탄도 여기서 멈춘다). */
const INFLATE_CHUNK_BYTES = 16 * 1024;

const MB = (bytes: number) => `${Math.round(bytes / 1024 / 1024)}MB`;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const broken = (detail: string) => new ZipPackageError(`XLSX(ZIP) 구조가 올바르지 않아 내보낼 수 없어요. (${detail})`);
const unsupported = (detail: string) => new ZipPackageError(`지원하지 않는 XLSX ZIP 구조예요. (${detail})`);

/* ---------- CRC32 ---------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) crc = CRC_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/* ---------- 목록 읽기 ---------- */

/** 패키지 안 경로로 쓸 수 있는 이름인가. 폴더 항목(끝이 /)은 허용한다. */
function validEntryName(name: string): boolean {
  // 절대 경로(/ · Windows 드라이브 C:)와 \ 구분자는 패키지 안 경로가 아니다.
  if (name === '' || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.includes('\\')) return false;
  const segments = (name.endsWith('/') ? name.slice(0, -1) : name).split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..' && segment !== '__proto__');
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

/** 파일 범위를 벗어나는 위치는 읽기 전에 거부한다(DataView 예외 대신 분명한 오류). */
function reader(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const inside = (offset: number, size: number) => {
    if (offset < 0 || offset + size > bytes.length) throw broken('기록된 위치가 파일 밖이에요');
  };
  return {
    u16: (offset: number) => {
      inside(offset, 2);
      return view.getUint16(offset, true);
    },
    u32: (offset: number) => {
      inside(offset, 4);
      return view.getUint32(offset, true);
    },
  };
}

/**
 * extra field 기록을 차례로 읽는다. ZIP64 정보(0x0001)는 classic 값이 sentinel이 아니어도 거부한다(값을 해석하는 reader마다 다르게 읽을 수 있다).
 * 기록이 extra 영역에 딱 맞지 않으면 그 안에 무엇이 숨었는지 알 수 없으므로 거부한다.
 */
function checkExtraFields(u16: (offset: number) => number, start: number, length: number, name: string) {
  const end = start + length;
  for (let at = start; at < end; ) {
    if (at + 4 > end) throw broken(`항목의 extra field 구조가 올바르지 않아요: ${name}`);
    if (u16(at) === ZIP64_EXTRA_ID) throw unsupported('ZIP64');
    at += 4 + u16(at + 2);
    if (at > end) throw broken(`항목의 extra field 구조가 올바르지 않아요: ${name}`);
  }
}

/** 끝 기록(EOCD)을 찾는다. 주석까지 포함해 파일 끝에 정확히 닿는 기록이 하나뿐이어야 한다. */
function findEndRecord(bytes: Uint8Array, u16: (offset: number) => number, u32: (offset: number) => number): number {
  const candidates: number[] = [];
  let signatureSeen = false;
  const lowest = Math.max(0, bytes.length - END_RECORD_SIZE - 0xffff);
  for (let offset = bytes.length - END_RECORD_SIZE; offset >= lowest; offset -= 1) {
    if (u32(offset) !== SIGNATURE.endOfCentralDirectory) continue;
    signatureSeen = true;
    if (offset + END_RECORD_SIZE + u16(offset + 20) === bytes.length) candidates.push(offset);
  }
  if (candidates.length === 0) throw signatureSeen ? broken('ZIP 끝 기록 뒤에 알 수 없는 데이터가 있어요') : new ZipPackageError('XLSX(ZIP) 구조를 찾을 수 없어요.');
  if (candidates.length > 1) throw broken('ZIP 끝 기록을 하나로 정할 수 없어요');
  return candidates[0];
}

/**
 * EOCD · 중앙 디렉터리 · 로컬 헤더를 읽고 서로 맞춰 본다. 압축은 풀지 않는다.
 * 하나라도 다르거나 모호하면 ZipPackageError를 던진다.
 */
export function readZipDirectory(bytes: Uint8Array, limits = ZIP_LIMITS): ZipEntryInfo[] {
  const { u16, u32 } = reader(bytes);
  const eocd = findEndRecord(bytes, u16, u32);
  if (eocd >= 20 && u32(eocd - 20) === SIGNATURE.zip64Locator) throw unsupported('ZIP64');
  const disk = u16(eocd + 4);
  const directoryDisk = u16(eocd + 6);
  const entriesOnDisk = u16(eocd + 8);
  const totalEntries = u16(eocd + 10);
  const directorySize = u32(eocd + 12);
  const directoryOffset = u32(eocd + 16);
  if ([disk, directoryDisk, entriesOnDisk, totalEntries].includes(0xffff) || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw unsupported('ZIP64');
  if (disk !== 0 || directoryDisk !== 0 || entriesOnDisk !== totalEntries) throw unsupported('여러 파일로 나뉜 ZIP');
  // 중앙 디렉터리는 EOCD 바로 앞에서 끝나야 한다(사이에 ZIP64 기록 · 알 수 없는 데이터가 없어야 한다).
  if (directoryOffset + directorySize !== eocd) throw broken('중앙 디렉터리 위치 · 크기가 끝 기록과 맞지 않아요');
  if (totalEntries === 0) throw broken('항목이 없어요');
  if (totalEntries > limits.maxEntries) throw new ZipPackageError(`XLSX 안의 항목이 너무 많아요(${totalEntries}개, 최대 ${limits.maxEntries}개).`);

  const entries: ZipEntryInfo[] = [];
  const seen = new Set<string>();
  let total = 0;
  let offset = directoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + CENTRAL_HEADER_SIZE > eocd || u32(offset) !== SIGNATURE.centralHeader) throw broken('중앙 디렉터리 항목을 읽을 수 없어요');
    const flags = u16(offset + 8);
    const method = u16(offset + 10);
    const crc = u32(offset + 16);
    const compressedSize = u32(offset + 20);
    const uncompressedSize = u32(offset + 24);
    const nameLength = u16(offset + 28);
    const extraLength = u16(offset + 30);
    const commentLength = u16(offset + 32);
    const diskStart = u16(offset + 34);
    const localHeaderOffset = u32(offset + 42);
    const nameBytes = bytes.subarray(offset + CENTRAL_HEADER_SIZE, offset + CENTRAL_HEADER_SIZE + nameLength);
    offset += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;
    if (offset > eocd) throw broken('중앙 디렉터리 항목이 목록 밖으로 넘어가요');

    if (flags & (FLAG.encrypted | FLAG.strongEncryption | FLAG.encryptedDirectory)) throw new ZipPackageError('암호가 걸린 파일은 지원하지 않아요.');
    if (flags & ~ALLOWED_FLAGS) throw unsupported(`알 수 없는 항목 표시 0x${flags.toString(16)}`);
    if (method !== 0 && method !== 8) throw new ZipPackageError('지원하지 않는 압축 방식의 항목이 있어요.');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff || diskStart === 0xffff) throw unsupported('ZIP64');
    if (diskStart !== 0) throw unsupported('여러 파일로 나뉜 ZIP');
    // 이름 인코딩 표시(UTF-8)가 없으면 ASCII 이름만 받는다. 해석이 갈리는 이름으로 항목을 찾지 않는다.
    if (!(flags & FLAG.utf8Name) && nameBytes.some((byte) => byte > 0x7f)) throw new ZipPackageError('인코딩을 알 수 없는 항목 이름이 있어요.');
    let name: string;
    try {
      name = utf8.decode(nameBytes);
    } catch {
      throw new ZipPackageError('항목 이름이 올바른 UTF-8이 아니에요.');
    }
    if (!validEntryName(name)) throw new ZipPackageError(`지원하지 않는 항목 이름이 있어요. (${name})`);
    checkExtraFields(u16, offset - extraLength - commentLength, extraLength, name);
    // OPC 파트 이름은 대소문자를 구분하지 않는다.
    const key = name.toLowerCase();
    if (seen.has(key)) throw new ZipPackageError(`같은 이름의 항목이 두 번 있어요. (${name})`);
    seen.add(key);
    if (uncompressedSize > limits.maxEntryBytes) throw new ZipPackageError(`압축을 풀면 너무 큰 항목이 있어요(${name}, 최대 ${MB(limits.maxEntryBytes)}).`);
    total += uncompressedSize;
    if (total > limits.maxTotalBytes) throw new ZipPackageError(`압축을 풀면 파일이 너무 커요(최대 ${MB(limits.maxTotalBytes)}).`);
    if (method === 0 && compressedSize !== uncompressedSize) throw broken(`압축하지 않은 항목의 크기 기록이 서로 달라요: ${name}`);
    if (method === 8 && compressedSize === 0) throw broken(`압축 데이터가 비어 있어요: ${name}`);

    // 로컬 헤더가 중앙 디렉터리 기록과 같은지 확인한다.
    const local = localHeaderOffset;
    if (local + LOCAL_HEADER_SIZE > directoryOffset || u32(local) !== SIGNATURE.localHeader) throw broken(`로컬 헤더를 찾을 수 없어요: ${name}`);
    if (u16(local + 6) !== flags) throw broken(`로컬 헤더와 목록의 항목 표시가 달라요: ${name}`);
    if (u16(local + 8) !== method) throw broken(`로컬 헤더와 목록의 압축 방식이 달라요: ${name}`);
    const localCrc = u32(local + 14);
    const localCompressed = u32(local + 18);
    const localUncompressed = u32(local + 22);
    const localNameLength = u16(local + 26);
    const localExtraLength = u16(local + 28);
    if (localCompressed === 0xffffffff || localUncompressed === 0xffffffff) throw unsupported('ZIP64');
    if (localNameLength !== nameLength || !sameBytes(bytes.subarray(local + LOCAL_HEADER_SIZE, local + LOCAL_HEADER_SIZE + localNameLength), nameBytes)) {
      throw broken(`로컬 헤더와 목록의 항목 이름이 달라요: ${name}`);
    }
    const localValues = [localCrc, localCompressed, localUncompressed];
    const centralValues = [crc, compressedSize, uncompressedSize];
    const matchesCentral = localValues.every((value, at) => value === centralValues[at]);
    // data descriptor를 쓰는 항목은 로컬 헤더 값이 모두 0일 수 있다. 일부만 0이거나 다른 값이면 거부한다.
    const deferred = (flags & FLAG.dataDescriptor) !== 0 && localValues.every((value) => value === 0);
    if (!matchesCentral && !deferred) throw broken(`로컬 헤더와 목록의 크기 · CRC 기록이 달라요: ${name}`);

    const dataStart = local + LOCAL_HEADER_SIZE + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > directoryOffset) throw broken(`압축 데이터가 중앙 디렉터리를 침범해요: ${name}`);
    checkExtraFields(u16, local + LOCAL_HEADER_SIZE + localNameLength, localExtraLength, name);
    let end = dataEnd;
    if (flags & FLAG.dataDescriptor) {
      const descriptorMatches = (at: number) => at + 12 <= directoryOffset && u32(at) === crc && u32(at + 4) === compressedSize && u32(at + 8) === uncompressedSize;
      if (dataEnd + 4 <= directoryOffset && u32(dataEnd) === SIGNATURE.dataDescriptor && descriptorMatches(dataEnd + 4)) end = dataEnd + 16;
      else if (descriptorMatches(dataEnd)) end = dataEnd + 12;
      else throw broken(`data descriptor가 목록 기록과 달라요: ${name}`);
    }
    entries.push({ name, method, crc32: crc, compressedSize, uncompressedSize, localHeaderOffset, dataStart, end });
  }
  if (offset !== eocd) throw broken('중앙 디렉터리 크기가 항목 목록과 맞지 않아요');

  // 항목은 파일 처음부터 중앙 디렉터리 앞까지 겹치거나 비지 않고 이어져야 한다.
  let expected = 0;
  for (const entry of [...entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset)) {
    if (entry.localHeaderOffset < expected) throw broken(`항목의 데이터 구간이 겹쳐요: ${entry.name}`);
    if (entry.localHeaderOffset > expected) throw broken(`항목 사이에 알 수 없는 데이터가 있어요: ${entry.name}`);
    expected = entry.end;
  }
  if (expected !== directoryOffset) throw broken('마지막 항목과 중앙 디렉터리 사이에 알 수 없는 데이터가 있어요');
  return entries;
}

/* ---------- 압축 풀기 ---------- */

/** pako Inflate의 zlib 스트림 상태. 타입 선언에는 없지만 pako 2 Inflate 객체의 필드다. */
type InflateWithStream = Inflate & { strm: { avail_in: number } };

/**
 * DEFLATE 데이터를 풀어 실제로 나온 bytes를 센다. 기록한 크기보다 하나라도 많아지면 그 자리에서 멈춘다.
 * 스트림은 zlib 기준으로 올바르게 끝나야 하고(손상 · 끊김 거부), 끝난 뒤 남는 압축 데이터가 없어야 한다.
 */
export function inflateExactly(data: Uint8Array, expectedSize: number, name: string): Uint8Array {
  const out = new Uint8Array(expectedSize);
  let written = 0;
  let status: number | undefined;
  const inflater = new Inflate({ raw: true, chunkSize: INFLATE_CHUNK_BYTES }) as InflateWithStream;
  inflater.onData = (chunk) => {
    const bytes = chunk as Uint8Array;
    if (written + bytes.length > expectedSize) throw broken(`압축을 풀면 기록된 크기보다 커요: ${name}`);
    out.set(bytes, written);
    written += bytes.length;
  };
  // 스트림이 끝나거나(0) zlib이 거부할 때(0이 아닌 값)만 불린다. 입력이 모자라 끝나지 않으면 불리지 않는다.
  inflater.onEnd = (code) => {
    status = code;
  };
  try {
    inflater.push(data, true);
  } catch (error) {
    if (error instanceof ZipPackageError) throw error;
    throw broken(`압축 데이터가 손상되었거나 중간에 끊겼어요: ${name}`);
  }
  if (status !== 0) throw broken(`압축 데이터가 손상되었거나 중간에 끊겼어요: ${name}`);
  if (inflater.strm.avail_in !== 0) throw broken(`압축 데이터 뒤에 알 수 없는 데이터가 있어요: ${name}`);
  if (written !== expectedSize) throw broken(`압축을 푼 크기가 기록과 달라요: ${name}`);
  return out;
}

function extractEntry(bytes: Uint8Array, entry: ZipEntryInfo): Uint8Array {
  const data = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  const content = entry.method === 0 ? data.slice() : inflateExactly(data, entry.uncompressedSize, entry.name);
  if (crc32(content) !== entry.crc32) throw broken(`CRC가 기록과 달라요: ${entry.name}`);
  return content;
}

export interface ZipPackage {
  /** 원본 ZIP의 항목 순서 */
  names: string[];
  entries: Map<string, Uint8Array>;
}

/** 구조 · 크기를 먼저 확인한 뒤 항목마다 풀어 실제 크기 · CRC를 확인한다. */
export function unzipPackage(bytes: Uint8Array, limits = ZIP_LIMITS): ZipPackage {
  if (bytes.length > limits.maxCompressedBytes) throw new ZipPackageError(`${MB(limits.maxCompressedBytes)} 이하 파일만 내보낼 수 있어요.`);
  const listed = readZipDirectory(bytes, limits);
  const entries = new Map<string, Uint8Array>();
  for (const entry of listed) entries.set(entry.name, extractEntry(bytes, entry));
  return { names: listed.map((entry) => entry.name), entries };
}

/** 원본 순서대로 다시 묶는다. */
export function zipPackage({ names, entries }: ZipPackage): Uint8Array {
  return zipSync(Object.fromEntries(names.map((name) => [name, entries.get(name)!])), { level: 6 });
}

/**
 * 다시 묶은 bytes를 같은 엄격한 reader로 열어, 항목 순서와 모든 항목 내용이 기대와 byte 단위로 같은지 확인한다.
 * 다시 묶은 파일은 원본보다 조금 커질 수 있어 압축 파일 크기 상한은 적용하지 않는다.
 */
export function assertPackageContent(bytes: Uint8Array, expected: ZipPackage, limits = ZIP_LIMITS): void {
  const actual = unzipPackage(bytes, { ...limits, maxCompressedBytes: Number.POSITIVE_INFINITY });
  if (actual.names.length !== expected.names.length || actual.names.some((name, index) => name !== expected.names[index])) {
    throw new ZipPackageError('다시 묶은 XLSX의 항목 목록이 원본과 달라요.');
  }
  for (const name of expected.names) {
    if (!sameBytes(actual.entries.get(name)!, expected.entries.get(name)!)) throw new ZipPackageError(`다시 묶은 XLSX의 항목 내용이 기대와 달라요. (${name})`);
  }
}
