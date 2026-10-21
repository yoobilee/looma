import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * 비밀이 브라우저 쪽으로 새어 나가는 구조를 정적으로 막는다.
 * - 브라우저 번들(src)이 서버 전용 환경변수 이름을 읽거나 VITE_ 접두사로 노출하지 않는다.
 * - 브라우저 코드(src)가 서버 함수 코드(api)를 가져오지 않는다. 공유는 src/shared의 순수 계약 파일로만 한다.
 * - src/shared는 서버 코드와 환경에 의존하지 않는다.
 */

const root = join(import.meta.dirname, '..', '..');
const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__fixtures__' ? [] : sourceFiles(path);
    return /\.(ts|tsx|css)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });

const read = (path: string) => readFileSync(path, 'utf8');
const srcFiles = sourceFiles(join(root, 'src'));

describe('비밀 노출 방지', () => {
  it('브라우저 코드(src)는 API 키 · 접근 코드 환경변수를 읽지 않는다', () => {
    for (const path of srcFiles) {
      const text = read(path);
      // 변수 이름을 안내 문구로 적는 것은 괜찮고, 값을 읽는 코드가 없어야 한다.
      expect(text, relative(root, path)).not.toMatch(/process\.env/);
      expect(text, relative(root, path)).not.toMatch(/import\.meta\.env\.\w*(GROQ|OPENAI|API_KEY|ACCESS_CODE|SECRET|TOKEN)/);
      expect(text, relative(root, path)).not.toMatch(/import\.meta\.env\[/);
    }
  });

  it('VITE_ 접두사로 노출되는 키 · 접근 코드 환경변수가 어디에도 없다', () => {
    const files = [...srcFiles, join(root, 'vercel.json'), join(root, '.env.example'), join(root, 'index.html'), ...sourceFiles(join(root, 'api'))];
    for (const path of files) expect(read(path), relative(root, path)).not.toMatch(/VITE_[A-Z0-9_]*(GROQ|OPENAI|API_KEY|ACCESS_CODE|SECRET|TOKEN)/);
  });

  it('브라우저 코드(src)는 서버 함수 코드(api)를 가져오지 않는다', () => {
    for (const path of srcFiles) expect(read(path), relative(root, path)).not.toMatch(/from\s+['"][^'"]*\bapi\//);
  });

  it('공유 계약(src/shared)은 import가 없는 순수 파일이다', () => {
    for (const path of srcFiles.filter((file) => relative(root, file).replaceAll('\\', '/').startsWith('src/shared/'))) {
      expect(read(path), relative(root, path)).not.toMatch(/^\s*import\s/m);
      expect(read(path), relative(root, path)).not.toMatch(/process\.|node:/);
    }
  });

  it('.env.example에는 값이 없고 실제 키처럼 보이는 문자열이 없다', () => {
    const lines = read(join(root, '.env.example')).split('\n').filter((line) => /^[A-Z_]+=/.test(line));
    expect(lines.map((line) => line.trim())).toEqual(['GROQ_API_KEY=', 'LOOMA_AI_ACCESS_CODE=']);
  });

  it('서버 코드는 환경변수 값을 로그로 내보내지 않는다', () => {
    // 로그 문자열에 끼워 넣는 값은 오류 분류 · 상태 코드 · 예외 이름뿐이어야 한다.
    const allowed = ['error.code', 'error.status', "error instanceof Error ? error.name : 'error'"];
    let calls = 0;
    for (const path of sourceFiles(join(root, 'api')).filter((file) => !/test\./.test(file))) {
      const text = read(path);
      for (const call of text.match(/console\.\w+\([^;]*\);/g) ?? []) {
        calls += 1;
        expect(call, relative(root, path)).toMatch(/^console\.error\(`/);
        for (const [, expression] of call.matchAll(/\$\{([^}]*)\}/g)) expect(allowed, `${relative(root, path)}: ${call}`).toContain(expression);
      }
    }
    expect(calls).toBeGreaterThan(0);
  });
});
