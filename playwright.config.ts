import { defineConfig, devices } from '@playwright/test';

const DEV_PORT = 5174;
const PREVIEW_PORT = 4175;

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  workers: 3,
  timeout: 45_000,
  expect: { timeout: 7_000 },
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
  },
  webServer: [
    {
      command: `npx vite --port ${DEV_PORT} --strictPort`,
      url: `http://localhost:${DEV_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
    },
    {
      // Production build for the PWA checks (service worker, manifest, offline shell).
      command: `npm run build && npx vite preview --port ${PREVIEW_PORT} --strictPort`,
      url: `http://localhost:${PREVIEW_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
  projects: [
    {
      name: 'chromium',
      testIgnore: ['**/pwa.spec.ts', '**/webkit.spec.ts'],
      // hasTouch enables touch emulation so CDP touch input produces real Touch/Pointer events.
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${DEV_PORT}`, viewport: { width: 1280, height: 800 }, hasTouch: true },
    },
    {
      // WebKit engine in an iPad Pro 11" landscape-like context (UA, DPR 2, touch).
      name: 'webkit-ipad',
      testMatch: '**/webkit.spec.ts',
      use: {
        ...devices['Desktop Safari'],
        baseURL: `http://localhost:${DEV_PORT}`,
        viewport: { width: 1194, height: 834 },
        deviceScaleFactor: 2,
        hasTouch: true,
        userAgent:
          'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      },
    },
    {
      name: 'pwa',
      testMatch: '**/pwa.spec.ts',
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${PREVIEW_PORT}` },
    },
  ],
});
