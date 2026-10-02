import { playwright } from '@vitest/browser-playwright';
import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

// 앱 빌드 설정(vite.config.ts)은 그대로 두고 테스트 설정만 더한다.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      projects: [
        // 도메인 로직 · 메모리 저장소 단위 테스트(Node)
        { extends: true, test: { name: 'unit', include: ['src/**/*.test.{ts,tsx}'], exclude: ['src/**/*.browser.test.{ts,tsx}'] } },
        // 실제 브라우저(Chromium headless)에서만 확인할 수 있는 동작. 지금은 IndexedDB transaction 회귀.
        {
          extends: true,
          test: {
            name: 'browser',
            include: ['src/**/*.browser.test.{ts,tsx}'],
            // 테스트 DB 정리(연결 닫힘 대기)가 멈추면 오래 기다리지 않고 실패한다.
            hookTimeout: 5000,
            browser: { enabled: true, provider: playwright(), headless: true, instances: [{ browser: 'chromium' }] },
          },
        },
      ],
    },
  }),
);
