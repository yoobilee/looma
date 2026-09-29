import { describe, expect, it } from 'vitest';
import { deriveScratchTitle, detectScratchType } from './scratchDetection';

describe('임시 자료 종류 감지', () => {
  it('링크', () => {
    expect(detectScratchType('https://qa.example.local/session')).toBe('url');
    expect(detectScratchType('qa.example.local/preview')).toBe('url');
  });

  it('JSON은 실제로 파싱될 때만 JSON으로 본다', () => {
    expect(detectScratchType('{ "code": "AUTH_LOCKED" }')).toBe('json');
    expect(detectScratchType('{ 깨진 JSON }')).toBe('text');
  });

  it('시각이나 로그 레벨로 시작하는 줄이 많으면 로그로 본다', () => {
    expect(detectScratchType('14:03:18 GET /session\n14:03:26 timeout\nretry=1')).toBe('log');
    expect(detectScratchType('ERROR failed\nWARN retry')).toBe('log');
  });

  it('나머지는 텍스트', () => {
    expect(detectScratchType('로그인 후 알림 설정 유지 여부 확인')).toBe('text');
    expect(detectScratchType('   ')).toBe('text');
  });

  it('제목은 첫 줄을 40자로 자른다', () => {
    expect(deriveScratchTitle('첫 줄\n둘째 줄', 'text')).toBe('첫 줄');
    expect(deriveScratchTitle('가'.repeat(50), 'text')).toBe(`${'가'.repeat(40)}…`);
    expect(deriveScratchTitle('{}', 'json')).toBe('JSON 조각');
  });
});
