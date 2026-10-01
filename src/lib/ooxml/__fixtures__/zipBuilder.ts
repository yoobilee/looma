/// <reference types="node" />
import { crc32 as nodeCrc32, deflateRawSync } from 'node:zlib';
import { strToU8 } from 'fflate';

/*
 * 테스트용 ZIP을 byte 단위로 직접 만든다. Looma reader 코드를 쓰지 않고 Node zlib(deflateRawSync · crc32)로 만들어
 * 검증 코드를 그대로 흉내 내는 테스트가 되지 않게 한다. 기본값은 정상 classic ZIP이고, 필드 하나씩 바꿔 손상 파일을 만든다.
 */

export interface HeaderFields {
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  name: Uint8Array;
  /** extra field 영역(기본: 없음) */
  extra?: Uint8Array;
}

export interface EntrySpec {
  name: string;
  content: Uint8Array;
  method?: number;
  /** 압축 데이터를 직접 줄 때(기본: method 8이면 deflateRawSync(content)) */
  data?: Uint8Array;
  local?: Partial<HeaderFields>;
  central?: Partial<HeaderFields> & { localOffset?: number; diskStart?: number };
  /** 압축 데이터 바로 뒤에 붙일 bytes(data descriptor 등) */
  after?: Uint8Array;
  /** 로컬 헤더 앞에 끼울 bytes */
  before?: Uint8Array;
}

export interface ZipSpec {
  entries: EntrySpec[];
  end?: Partial<{ disk: number; directoryDisk: number; entriesOnDisk: number; totalEntries: number; size: number; offset: number }>;
  /** 중앙 디렉터리와 EOCD 사이에 끼울 bytes */
  beforeEnd?: Uint8Array;
  comment?: Uint8Array;
  trailing?: Uint8Array;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function record(size: number, write: (view: DataView) => void, tail: Uint8Array[] = []): Uint8Array {
  const head = new Uint8Array(size);
  write(new DataView(head.buffer));
  return concat([head, ...tail]);
}

export const localHeader = (f: HeaderFields) =>
  record(
    30,
    (v) => {
      v.setUint32(0, 0x04034b50, true);
      v.setUint16(4, 20, true);
      v.setUint16(6, f.flags, true);
      v.setUint16(8, f.method, true);
      v.setUint16(12, 0x21, true);
      v.setUint32(14, f.crc, true);
      v.setUint32(18, f.compressedSize, true);
      v.setUint32(22, f.uncompressedSize, true);
      v.setUint16(26, f.name.length, true);
      v.setUint16(28, f.extra?.length ?? 0, true);
    },
    [f.name, f.extra ?? new Uint8Array(0)],
  );

export const centralHeader = (f: HeaderFields & { localOffset: number; diskStart: number }) =>
  record(
    46,
    (v) => {
      v.setUint32(0, 0x02014b50, true);
      v.setUint16(4, 20, true);
      v.setUint16(6, 20, true);
      v.setUint16(8, f.flags, true);
      v.setUint16(10, f.method, true);
      v.setUint16(14, 0x21, true);
      v.setUint32(16, f.crc, true);
      v.setUint32(20, f.compressedSize, true);
      v.setUint32(24, f.uncompressedSize, true);
      v.setUint16(28, f.name.length, true);
      v.setUint16(30, f.extra?.length ?? 0, true);
      v.setUint16(34, f.diskStart, true);
      v.setUint32(42, f.localOffset, true);
    },
    [f.name, f.extra ?? new Uint8Array(0)],
  );

export const u32le = (...values: number[]) => record(values.length * 4, (v) => values.forEach((value, index) => v.setUint32(index * 4, value, true)));

export function buildZip(spec: ZipSpec): Uint8Array {
  const parts: Uint8Array[] = [];
  let position = 0;
  const push = (part: Uint8Array) => {
    parts.push(part);
    position += part.length;
  };
  const central: Uint8Array[] = [];
  for (const entry of spec.entries) {
    const method = entry.method ?? 8;
    const data = entry.data ?? (method === 8 ? new Uint8Array(deflateRawSync(entry.content)) : entry.content);
    const base: HeaderFields = { flags: 0, method, crc: nodeCrc32(entry.content), compressedSize: data.length, uncompressedSize: entry.content.length, name: strToU8(entry.name) };
    if (entry.before) push(entry.before);
    const localOffset = position;
    push(localHeader({ ...base, ...entry.local }));
    push(data);
    if (entry.after) push(entry.after);
    central.push(centralHeader({ ...base, localOffset, diskStart: 0, ...entry.central }));
  }
  const offset = position;
  central.forEach(push);
  const size = position - offset;
  if (spec.beforeEnd) push(spec.beforeEnd);
  const comment = spec.comment ?? new Uint8Array(0);
  const end = { disk: 0, directoryDisk: 0, entriesOnDisk: spec.entries.length, totalEntries: spec.entries.length, size, offset, ...spec.end };
  push(
    record(
      22,
      (v) => {
        v.setUint32(0, 0x06054b50, true);
        v.setUint16(4, end.disk, true);
        v.setUint16(6, end.directoryDisk, true);
        v.setUint16(8, end.entriesOnDisk, true);
        v.setUint16(10, end.totalEntries, true);
        v.setUint32(12, end.size, true);
        v.setUint32(16, end.offset, true);
        v.setUint16(20, comment.length, true);
      },
      [comment],
    ),
  );
  if (spec.trailing) push(spec.trailing);
  return concat(parts);
}


/** 정상 ZIP의 항목 내용 그대로, 원하는 항목만 바꿔 다시 만든다. */
export function rebuildZip(files: Record<string, Uint8Array>, change: (name: string, entry: EntrySpec) => EntrySpec = (_, entry) => entry, extra: EntrySpec[] = []): Uint8Array {
  return buildZip({ entries: [...Object.entries(files).map(([name, content]) => change(name, { name, content })), ...extra] });
}

export { nodeCrc32, deflateRawSync };
