import { defineConfig, devices } from '@playwright/test';

/** Screenshot capture for manual visual review (not a test gate). */
export default defineConfig({
  testDir: '.',
  testMatch: ['visual.capture.ts', 'perf.capture.ts'],
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  webServer: {
    command: 'npx vite --port 5174 --strictPort',
    cwd: '..',
    url: 'http://localhost:5174',
    reuseExistingServer: true,
    timeout: 90_000,
  },
  use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:5174', hasTouch: true },
});
