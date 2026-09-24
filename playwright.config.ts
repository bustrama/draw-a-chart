import { defineConfig, devices } from '@playwright/test';

const DEV_PORT = 5174;
const PROD_PORT = 4175;

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
      // Dev server with sync off: parallel tests must not see each other's drawings.
      command: `npx vite --port ${DEV_PORT} --strictPort`,
      url: `http://localhost:${DEV_PORT}`,
      env: { VITE_SYNC_SERVER: 'off', SYNC_DEV_DB: ':memory:' },
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
    },
    {
      // The production server (what the Docker image runs) with a fresh build. The sync tests
      // start their own instances of it on the same dist/.
      command: 'npm run build && node server/main.ts',
      url: `http://localhost:${PROD_PORT}/api/health`,
      env: { PORT: String(PROD_PORT), DB_FILE: ':memory:', STATIC_DIR: 'dist' },
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
  projects: [
    {
      name: 'chromium',
      testIgnore: ['**/pwa.spec.ts', '**/webkit.spec.ts', '**/sync.spec.ts'],
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
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${PROD_PORT}` },
    },
    {
      // Several devices syncing through the production server (each test starts its own).
      name: 'sync',
      testMatch: '**/sync.spec.ts',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, hasTouch: true },
    },
  ],
});
