import { describe, expect, it } from 'vitest';
import { toImportTable } from '@/domain/testAssetImport';
import { decodeText, parseCsv, parseCsvRecords } from './csv';

describe('parseCsv', () => {
  it('쉼표 · 줄 단위로 나누고 마지막 줄바꿈 뒤에는 빈 행을 만들지 않는다', () => {
    expect(parseCsv('a,b,c\n1,2,3\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('따옴표 안의 쉼표 · 줄바꿈 · 이중 따옴표를 값으로 읽는다', () => {
    expect(parseCsv('id,step\r\nSIGN-001,"1. 이동한다.\r\n2. ""확인"", 누른다."\r\n')).toEqual([
      ['id', 'step'],
      ['SIGN-001', '1. 이동한다.\r\n2. "확인", 누른다.'],
    ]);
  });

  it('BOM을 빼고, 빈 셀과 빈 행을 그대로 둔다', () => {
    expect(parseCsv('﻿a,b\n,\n\nx,')).toEqual([['a', 'b'], ['', ''], [''], ['x', '']]);
  });
});

describe('parseCsvRecords: 원본 시작 줄 번호', () => {
  const linesOf = (text: string) => parseCsvRecords(text).map((record) => record.line);

  it('일반 CSV는 레코드 순서가 줄 번호다(LF · CRLF · 홑 CR · 마지막 줄바꿈 유무와 무관)', () => {
    expect(linesOf('a,b\n1,2\n3,4')).toEqual([1, 2, 3]);
    expect(linesOf('a,b\n1,2\n3,4\n')).toEqual([1, 2, 3]);
    expect(linesOf('a,b\r\n1,2\r\n3,4\r\n')).toEqual([1, 2, 3]);
    expect(linesOf('a,b\r1,2\r3,4')).toEqual([1, 2, 3]);
  });

  it('따옴표 안 줄바꿈이 있는 레코드는 여러 줄을 차지하고 다음 레코드는 그 뒤 줄에서 시작한다', () => {
    // 1 헤더 / 2~3 로그인 / 4 결제
    expect(linesOf('기능,요구사항\n로그인,"첫 줄\n둘째 줄"\n결제,결제 요구사항')).toEqual([1, 2, 4]);
    // 2~4 세 줄 레코드 다음은 5
    expect(linesOf('a,b\nx,"1\n2\n3"\ny,z\nw,v')).toEqual([1, 2, 5, 6]);
    // 한 레코드의 여러 따옴표 셀이 각각 줄바꿈을 가질 때: 2~4행 레코드 다음은 5
    expect(linesOf('a,b\n"1\n2","3\n4"\nlast,x')).toEqual([1, 2, 5]);
  });

  it('CRLF는 한 줄로 센다: 따옴표 안팎 모두 LF와 같은 줄 번호다', () => {
    const lf = '기능,요구사항\n로그인,"첫 줄\n둘째 줄"\n결제,x\n';
    const crlf = '기능,요구사항\r\n로그인,"첫 줄\r\n둘째 줄"\r\n결제,x\r\n';
    expect(linesOf(lf)).toEqual([1, 2, 4]);
    expect(linesOf(crlf)).toEqual(linesOf(lf));
    // 따옴표 안 홑 CR도 한 줄이다.
    expect(linesOf('a,b\nx,"1\r2"\ny,z')).toEqual([1, 2, 4]);
  });

  it('이중 따옴표 이스케이프와 줄바꿈이 함께 있어도 줄 번호가 어긋나지 않는다', () => {
    // 1 헤더 / 2~3 / 4~5 / 6
    expect(linesOf('a,b\nx,"그는 ""안녕""\n이라고 했다"\ny,"""\n"""\nz,w')).toEqual([1, 2, 4, 6]);
    expect(parseCsv('a,b\nx,"""\n"""')[1]).toEqual(['x', '"\n"']);
  });

  it('빈 줄은 빈 레코드로 남아 자기 줄 번호를 갖고, 뒤 레코드는 실제 줄 번호를 유지한다', () => {
    expect(linesOf('a,b\n\nx,y\n\n\nz,w\n')).toEqual([1, 2, 3, 4, 5, 6]);
    expect(parseCsv('a,b\n\nx,y')).toEqual([['a', 'b'], [''], ['x', 'y']]);
    // 따옴표 안 빈 줄은 레코드를 늘리지 않지만 줄 수에는 들어간다.
    expect(linesOf('a,b\nx,"1\n\n2"\ny,z')).toEqual([1, 2, 5]);
  });

  it('BOM은 줄 번호에 영향이 없고, 위쪽 빈 줄이 있으면 헤더도 그 줄 번호를 갖는다', () => {
    expect(linesOf('﻿a,b\n1,2')).toEqual([1, 2]);
    expect(linesOf('\n\na,b\n1,2')).toEqual([1, 2, 3, 4]);
  });

  it('parseCsv와 같은 셀을 돌려준다', () => {
    const text = 'id,step\r\nSIGN-001,"1. 이동한다.\r\n2. ""확인"", 누른다."\r\n\r\nx,';
    expect(parseCsvRecords(text).map((record) => record.cells)).toEqual(parseCsv(text));
  });
});

describe('toImportTable: CSV 원본 줄 번호', () => {
  const tableOf = (text: string) => {
    const records = parseCsvRecords(text);
    return toImportTable(
      records.map((record) => record.cells),
      records.map((record) => record.line),
    )!;
  };

  it('헤더 1행 · 데이터 2행 · 3행이면 행 번호 2, 3이다', () => {
    expect(tableOf('기능,요구사항\na,b\nc,d').rows.map((row) => row.rowNumber)).toEqual([2, 3]);
  });

  it('줄바꿈 셀 뒤의 행은 실제 줄 번호를 갖는다(2~3행 레코드 다음은 4행)', () => {
    expect(tableOf('기능,요구사항\n로그인,"첫 줄\n둘째 줄"\n결제,결제 요구사항').rows.map((row) => row.rowNumber)).toEqual([2, 4]);
    expect(tableOf('기능,요구사항\r\n로그인,"첫 줄\r\n둘째 줄"\r\n결제,결제 요구사항\r\n').rows.map((row) => row.rowNumber)).toEqual([2, 4]);
  });

  it('줄 번호를 주지 않으면(XLSX) 레코드 순서가 행 번호인 기존 의미 그대로다', () => {
    expect(toImportTable([['a', 'b'], ['1', '2'], ['3', '4']])!.rows.map((row) => row.rowNumber)).toEqual([2, 3]);
    expect(toImportTable([[''], ['a', 'b'], ['1', '2']])!.rows.map((row) => row.rowNumber)).toEqual([3]);
  });
});

describe('decodeText', () => {
  it('UTF-8을 먼저 읽는다', () => {
    expect(decodeText(new TextEncoder().encode('대분류').buffer as ArrayBuffer)).toBe('대분류');
  });

  it('UTF-8이 아니면 EUC-KR로 읽는다', () => {
    // EUC-KR "가나"
    expect(decodeText(new Uint8Array([0xb0, 0xa1, 0xb3, 0xaa]).buffer)).toBe('가나');
  });
});
