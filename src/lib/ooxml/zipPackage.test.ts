/// <reference types="node" />
import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildZip, centralHeader, concat, deflateRawSync, localHeader, nodeCrc32, record, u32le, type EntrySpec } from './__fixtures__/zipBuilder';
import { assertPackageContent, crc32, readZipDirectory, unzipPackage, ZIP_LIMITS, ZipPackageError } from './zipPackage';

/* 손상 · 변형된 ZIP은 __fixtures__/zipBuilder로 byte 단위로 만든다(Node zlib 기반, reader 코드와 독립). */

const text = (value: string) => strToU8(value);
/** 압축이 되는(Huffman 블록) 101 bytes. 압축되지 않는 내용이면 zlib이 저장 블록을 써서 재현 조건이 달라진다. */
const IMAGE = new Uint8Array(101).map((_, index) => [0x89, 0x50, 0x4e, 0x47][index % 4]);
const baseEntries = (): EntrySpec[] => [
  { name: '[Content_Types].xml', content: text('<Types/>') },
  { name: 'xl/media/image1.png', content: IMAGE },
  { name: 'docProps/', content: new Uint8Array(0), method: 0 },
  { name: 'xl/한글.xml', content: text('<a>값</a>'), local: { flags: 0x0800 }, central: { flags: 0x0800 } },
];
const withEntry = (index: number, change: Partial<EntrySpec>) => baseEntries().map((entry, at) => (at === index ? { ...entry, ...change } : entry));

/** 이 ZIP은 거부되어야 한다. 메시지 조각을 함께 확인한다. */
function rejects(bytes: Uint8Array, message: string | RegExp) {
  expect(() => unzipPackage(bytes)).toThrow(ZipPackageError);
  expect(() => unzipPackage(bytes)).toThrow(message);
}

describe('CRC32', () => {
  it('표준 확인값과 Node zlib 결과가 같다', () => {
    expect(crc32(text('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(IMAGE)).toBe(nodeCrc32(IMAGE));
  });
});

describe('정상 ZIP', () => {
  it('직접 만든 classic ZIP(DEFLATE · 저장 · 폴더 · UTF-8 이름)을 읽고 내용이 같다', () => {
    const bytes = buildZip({ entries: baseEntries() });
    // 만든 fixture가 다른 reader로도 정상인지 먼저 확인한다.
    expect(Object.keys(unzipSync(bytes))).toHaveLength(4);
    const pkg = unzipPackage(bytes);
    expect(pkg.names).toEqual(['[Content_Types].xml', 'xl/media/image1.png', 'docProps/', 'xl/한글.xml']);
    expect(pkg.entries.get('xl/media/image1.png')).toEqual(IMAGE);
    expect(pkg.entries.get('xl/한글.xml')).toEqual(text('<a>값</a>'));
  });

  it('fflate zipSync가 만든 ZIP을 읽는다(내보낸 파일 형식)', () => {
    const files = { 'a.xml': text('<a/>'), 'b/c.bin': IMAGE };
    const pkg = unzipPackage(zipSync(files, { level: 6 }));
    expect(Object.fromEntries(pkg.entries)).toEqual(files);
  });

  it('data descriptor(서명 있음 · 없음)를 쓰는 항목도 값이 모두 맞으면 읽는다', () => {
    const crc = nodeCrc32(IMAGE);
    const data = new Uint8Array(deflateRawSync(IMAGE));
    const deferred = { flags: 0x0008, crc: 0, compressedSize: 0, uncompressedSize: 0 };
    for (const after of [u32le(0x08074b50, crc, data.length, IMAGE.length), u32le(crc, data.length, IMAGE.length)]) {
      const bytes = buildZip({ entries: withEntry(1, { data, local: deferred, central: { flags: 0x0008 }, after }) });
      expect(unzipPackage(bytes).entries.get('xl/media/image1.png')).toEqual(IMAGE);
    }
  });
});

describe('A · 실제 DEFLATE 출력이 기록보다 큰 ZIP', () => {
  it('실제 101 bytes · 기록 3 bytes면 fflate unzipSync는 3 bytes로 잘라 성공하지만 Looma는 거부한다', () => {
    const truncatedCrc = nodeCrc32(IMAGE.subarray(0, 3));
    const sizes = { uncompressedSize: 3, crc: truncatedCrc };
    const bytes = buildZip({ entries: withEntry(1, { local: sizes, central: sizes }) });
    // 독립 리뷰 재현: 기존 방식(unzipSync + 길이 비교)은 잘린 결과를 정상으로 받는다.
    expect(unzipSync(bytes)['xl/media/image1.png']).toEqual(IMAGE.subarray(0, 3));
    rejects(bytes, '압축을 풀면 기록된 크기보다 커요: xl/media/image1.png');
  });

  it('작은 압축 데이터가 기록보다 훨씬 크게 풀리면(압축 폭탄) 바로 멈춘다', () => {
    const bomb = new Uint8Array(20 * 1024 * 1024);
    const sizes = { uncompressedSize: 10, crc: nodeCrc32(bomb.subarray(0, 10)) };
    const bytes = buildZip({ entries: [{ name: 'bomb.bin', content: bomb, local: sizes, central: sizes }] });
    const started = performance.now();
    rejects(bytes, '기록된 크기보다 커요');
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('실제 출력이 기록보다 작아도 거부한다', () => {
    const sizes = { uncompressedSize: 200 };
    rejects(buildZip({ entries: withEntry(1, { local: sizes, central: sizes }) }), '압축을 푼 크기가 기록과 달라요');
  });
});

describe('B · CRC', () => {
  it('푼 내용의 CRC가 기록과 다르면 거부한다', () => {
    const wrong = { crc: nodeCrc32(IMAGE) ^ 1 };
    rejects(buildZip({ entries: withEntry(1, { local: wrong, central: wrong }) }), 'CRC가 기록과 달라요: xl/media/image1.png');
    // 압축하지 않은 항목도 같다.
    rejects(buildZip({ entries: withEntry(1, { method: 0, local: wrong, central: wrong }) }), 'CRC가 기록과 달라요');
  });

  it('로컬 헤더와 중앙 디렉터리의 CRC가 다르면 거부한다', () => {
    rejects(buildZip({ entries: withEntry(1, { local: { crc: 1234 } }) }), '로컬 헤더와 목록의 크기 · CRC 기록이 달라요');
  });
});

describe('C · 로컬 헤더와 중앙 디렉터리의 크기 불일치', () => {
  it('압축 크기 · 원래 크기 중 하나라도 다르면 거부한다', () => {
    const data = new Uint8Array(deflateRawSync(IMAGE));
    rejects(buildZip({ entries: withEntry(1, { local: { compressedSize: data.length + 1 } }) }), '로컬 헤더와 목록의 크기 · CRC 기록이 달라요');
    rejects(buildZip({ entries: withEntry(1, { local: { uncompressedSize: 3 } }) }), '로컬 헤더와 목록의 크기 · CRC 기록이 달라요');
    rejects(buildZip({ entries: withEntry(1, { central: { uncompressedSize: 3 } }) }), '로컬 헤더와 목록의 크기 · CRC 기록이 달라요');
  });

  it('압축하지 않은 항목의 두 크기가 다르면 거부한다', () => {
    const sizes = { uncompressedSize: IMAGE.length + 1 };
    rejects(buildZip({ entries: withEntry(1, { method: 0, local: sizes, central: sizes }) }), '압축하지 않은 항목의 크기 기록이 서로 달라요');
  });

  it('data descriptor 값이 다르거나, 로컬 값이 일부만 0이면 거부한다', () => {
    const crc = nodeCrc32(IMAGE);
    const data = new Uint8Array(deflateRawSync(IMAGE));
    const deferred = { flags: 0x0008, crc: 0, compressedSize: 0, uncompressedSize: 0 };
    rejects(buildZip({ entries: withEntry(1, { data, local: deferred, central: { flags: 0x0008 }, after: u32le(0x08074b50, crc, data.length, 3) }) }), 'data descriptor가 목록 기록과 달라요');
    rejects(buildZip({ entries: withEntry(1, { data, local: { ...deferred, crc }, central: { flags: 0x0008 }, after: u32le(crc, data.length, IMAGE.length) }) }), '로컬 헤더와 목록의 크기 · CRC 기록이 달라요');
    // descriptor 표시 없이 로컬 값이 0이면 거부한다.
    rejects(buildZip({ entries: withEntry(1, { local: { crc: 0, compressedSize: 0, uncompressedSize: 0 } }) }), '로컬 헤더와 목록의 크기 · CRC 기록이 달라요');
  });
});

describe('D · 이름 · 표시 · 압축 방식 불일치', () => {
  it('로컬 헤더와 중앙 디렉터리의 이름이 다르면 거부한다', () => {
    rejects(buildZip({ entries: withEntry(1, { local: { name: text('xl/media/image2.png') } }) }), '로컬 헤더와 목록의 항목 이름이 달라요');
    rejects(buildZip({ entries: withEntry(1, { local: { name: text('xl/media/image1.pn') } }) }), '로컬 헤더와 목록의 항목 이름이 달라요');
  });

  it('표시(flags) · 압축 방식이 다르면 거부한다', () => {
    rejects(buildZip({ entries: withEntry(1, { local: { flags: 0x0800 } }) }), '로컬 헤더와 목록의 항목 표시가 달라요');
    rejects(buildZip({ entries: withEntry(1, { local: { method: 0 } }) }), '로컬 헤더와 목록의 압축 방식이 달라요');
  });

  it('암호화 · 알 수 없는 표시 · 지원하지 않는 압축 방식은 거부한다', () => {
    const flagged = (flags: number) => buildZip({ entries: withEntry(1, { local: { flags }, central: { flags } }) });
    rejects(flagged(0x0001), '암호가 걸린 파일');
    rejects(flagged(0x0040), '암호가 걸린 파일');
    rejects(flagged(0x0020), '알 수 없는 항목 표시');
    rejects(buildZip({ entries: withEntry(1, { method: 12 }) }), '지원하지 않는 압축 방식');
  });
});

describe('E · 항목 구간 겹침 · 빈틈', () => {
  it('다른 항목의 데이터 안에 숨은 로컬 헤더를 가리키면(겹침) 거부한다', () => {
    // 1번 항목(저장)의 내용 안에 2번 항목의 로컬 헤더 + 데이터를 넣고, 2번 항목 목록이 그 위치를 가리키게 한다.
    const innerName = text('xl/inner.xml');
    const innerContent = text('<inner/>');
    const inner = concat([localHeader({ flags: 0, method: 0, crc: nodeCrc32(innerContent), compressedSize: innerContent.length, uncompressedSize: innerContent.length, name: innerName }), innerContent]);
    const outerName = text('xl/outer.bin');
    const outer = concat([localHeader({ flags: 0, method: 0, crc: nodeCrc32(inner), compressedSize: inner.length, uncompressedSize: inner.length, name: outerName }), inner]);
    const innerOffset = 30 + outerName.length;
    const directory = concat([
      centralHeader({ flags: 0, method: 0, crc: nodeCrc32(inner), compressedSize: inner.length, uncompressedSize: inner.length, name: outerName, localOffset: 0, diskStart: 0 }),
      centralHeader({ flags: 0, method: 0, crc: nodeCrc32(innerContent), compressedSize: innerContent.length, uncompressedSize: innerContent.length, name: innerName, localOffset: innerOffset, diskStart: 0 }),
    ]);
    const end = record(22, (v) => {
      v.setUint32(0, 0x06054b50, true);
      v.setUint16(8, 2, true);
      v.setUint16(10, 2, true);
      v.setUint32(12, directory.length, true);
      v.setUint32(16, outer.length, true);
    });
    const bytes = concat([outer, directory, end]);
    // 다른 reader는 두 항목을 모두 정상으로 푼다.
    expect(unzipSync(bytes)['xl/inner.xml']).toEqual(innerContent);
    rejects(bytes, '항목의 데이터 구간이 겹쳐요');
  });

  it('항목 앞 · 사이 · 중앙 디렉터리 앞에 알 수 없는 데이터가 있으면 거부한다', () => {
    rejects(buildZip({ entries: withEntry(0, { before: text('MZ') }) }), '항목 사이에 알 수 없는 데이터가 있어요');
    rejects(buildZip({ entries: withEntry(2, { before: text('xx') }) }), '항목 사이에 알 수 없는 데이터가 있어요');
    rejects(buildZip({ entries: withEntry(3, { after: text('xx') }) }), '마지막 항목과 중앙 디렉터리 사이');
  });

  it('압축 데이터가 중앙 디렉터리를 침범하면 거부한다', () => {
    const data = new Uint8Array(deflateRawSync(text('<a>값</a>')));
    const sizes = { compressedSize: data.length + 40, flags: 0x0800 };
    rejects(buildZip({ entries: withEntry(3, { data, local: sizes, central: sizes }) }), '압축 데이터가 중앙 디렉터리를 침범해요');
  });
});

describe('F · 중앙 디렉터리 · 끝 기록(EOCD) 불일치', () => {
  it('중앙 디렉터리 크기 · 위치 · 항목 수가 맞지 않으면 거부한다', () => {
    const good = buildZip({ entries: baseEntries() });
    const directory = readZipDirectory(good);
    const size = good.length - 22 - directory[directory.length - 1].end;
    rejects(buildZip({ entries: baseEntries(), end: { size: size - 1 } }), '중앙 디렉터리 위치 · 크기가 끝 기록과 맞지 않아요');
    rejects(buildZip({ entries: baseEntries(), end: { size: size + 1 } }), '중앙 디렉터리 위치 · 크기가 끝 기록과 맞지 않아요');
    rejects(buildZip({ entries: baseEntries(), end: { offset: directory[directory.length - 1].end - 1 } }), /끝 기록과 맞지 않아요/);
    rejects(buildZip({ entries: baseEntries(), end: { entriesOnDisk: 3, totalEntries: 3 } }), '중앙 디렉터리 크기가 항목 목록과 맞지 않아요');
    rejects(buildZip({ entries: baseEntries(), end: { entriesOnDisk: 3 } }), '여러 파일로 나뉜 ZIP');
    rejects(buildZip({ entries: baseEntries(), beforeEnd: text('junk') }), '중앙 디렉터리 위치 · 크기가 끝 기록과 맞지 않아요');
  });

  it('EOCD 뒤에 데이터가 있거나 EOCD를 하나로 정할 수 없으면 거부한다', () => {
    rejects(buildZip({ entries: baseEntries(), trailing: text('tail') }), 'ZIP 끝 기록 뒤에 알 수 없는 데이터가 있어요');
    // 주석 안에 파일 끝에 닿는 가짜 EOCD를 넣는다.
    const fake = record(22, (v) => v.setUint32(0, 0x06054b50, true));
    rejects(buildZip({ entries: baseEntries(), comment: fake }), 'ZIP 끝 기록을 하나로 정할 수 없어요');
    // 평범한 주석은 허용한다.
    expect(unzipPackage(buildZip({ entries: baseEntries(), comment: text('made by test') })).names).toHaveLength(4);
  });

  it('항목이 없는 ZIP · ZIP이 아닌 파일은 거부한다', () => {
    rejects(buildZip({ entries: [] }), '항목이 없어요');
    rejects(new Uint8Array([1, 2, 3]), 'XLSX(ZIP) 구조를 찾을 수 없어요');
  });
});

describe('G · ZIP64', () => {
  const ZIP64 = '지원하지 않는 XLSX ZIP 구조예요. (ZIP64)';
  it('크기 · 위치 sentinel이 있으면 부분적으로 해석하지 않고 거부한다', () => {
    rejects(buildZip({ entries: withEntry(1, { central: { compressedSize: 0xffffffff } }) }), ZIP64);
    rejects(buildZip({ entries: withEntry(1, { central: { uncompressedSize: 0xffffffff } }) }), ZIP64);
    rejects(buildZip({ entries: withEntry(1, { central: { localOffset: 0xffffffff } }) }), ZIP64);
    rejects(buildZip({ entries: withEntry(1, { central: { diskStart: 0xffff } }) }), ZIP64);
    rejects(buildZip({ entries: withEntry(1, { local: { uncompressedSize: 0xffffffff } }) }), ZIP64);
    rejects(buildZip({ entries: baseEntries(), end: { entriesOnDisk: 0xffff, totalEntries: 0xffff } }), ZIP64);
    rejects(buildZip({ entries: baseEntries(), end: { offset: 0xffffffff } }), ZIP64);
    rejects(buildZip({ entries: baseEntries(), end: { size: 0xffffffff } }), ZIP64);
  });

  it('ZIP64 끝 기록 위치(locator)가 있으면 거부한다', () => {
    rejects(buildZip({ entries: baseEntries(), beforeEnd: concat([u32le(0x07064b50, 0), new Uint8Array(12)]) }), ZIP64);
  });
});

describe('H · 끊기거나 뒤에 데이터가 남은 압축 데이터', () => {
  it('압축 데이터가 중간에 끊기면(기록도 끊긴 크기) 거부한다', () => {
    const full = new Uint8Array(deflateRawSync(IMAGE));
    const data = full.subarray(0, full.length - 3);
    const sizes = { compressedSize: data.length };
    rejects(buildZip({ entries: withEntry(1, { data, local: sizes, central: sizes }) }), '압축 데이터가 손상되었거나 중간에 끊겼어요');
  });

  it('DEFLATE 스트림이 기록한 압축 크기보다 먼저 끝나면(뒤에 남는 데이터) 거부한다', () => {
    const data = concat([new Uint8Array(deflateRawSync(IMAGE)), text('hidden')]);
    const sizes = { compressedSize: data.length };
    rejects(buildZip({ entries: withEntry(1, { data, local: sizes, central: sizes }) }), '압축 데이터 뒤에 알 수 없는 데이터가 있어요');
    // 한 byte만 남아도 거부한다.
    const one = concat([new Uint8Array(deflateRawSync(IMAGE)), new Uint8Array([0])]);
    rejects(buildZip({ entries: withEntry(1, { data: one, local: { compressedSize: one.length }, central: { compressedSize: one.length } }) }), '압축 데이터 뒤에 알 수 없는 데이터가 있어요');
  });

  it('DEFLATE 항목의 압축 데이터가 비어 있거나 잘못된 블록이면 거부한다', () => {
    const empty = { compressedSize: 0, uncompressedSize: 0, crc: 0 };
    rejects(buildZip({ entries: withEntry(1, { data: new Uint8Array(0), content: new Uint8Array(0), local: empty, central: empty }) }), '압축 데이터가 비어 있어요');
    const invalid = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    rejects(buildZip({ entries: withEntry(1, { data: invalid, local: { compressedSize: 4 }, central: { compressedSize: 4 } }) }), '압축 데이터가 손상되었거나 중간에 끊겼어요');
  });
});

describe('다시 묶은 패키지 확인', () => {
  it('항목 내용 · 순서가 기대와 다르면 거부한다', () => {
    const expected = { names: ['a.xml', 'b.xml'], entries: new Map([['a.xml', text('<a/>')], ['b.xml', text('<b/>')]]) };
    const bytes = zipSync({ 'a.xml': text('<a/>'), 'b.xml': text('<b/>') });
    expect(() => assertPackageContent(bytes, expected)).not.toThrow();
    expect(() => assertPackageContent(bytes, { ...expected, entries: new Map([['a.xml', text('<a/>')], ['b.xml', text('<B/>')]]) })).toThrow('항목 내용이 기대와 달라요');
    expect(() => assertPackageContent(bytes, { ...expected, names: ['b.xml', 'a.xml'] })).toThrow('항목 목록이 원본과 달라요');
  });

  it('상한은 유지한다', () => {
    expect(ZIP_LIMITS).toEqual({ maxCompressedBytes: 5 * 1024 * 1024, maxEntries: 2000, maxEntryBytes: 32 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 });
  });
});
