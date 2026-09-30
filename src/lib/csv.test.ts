import { describe, expect, it } from 'vitest';
import { decodeText, parseCsv } from './csv';

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

describe('decodeText', () => {
  it('UTF-8을 먼저 읽는다', () => {
    expect(decodeText(new TextEncoder().encode('대분류').buffer as ArrayBuffer)).toBe('대분류');
  });

  it('UTF-8이 아니면 EUC-KR로 읽는다', () => {
    // EUC-KR "가나"
    expect(decodeText(new Uint8Array([0xb0, 0xa1, 0xb3, 0xaa]).buffer)).toBe('가나');
  });
});
