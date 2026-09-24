/**
 * Cloud sync tests against a LOCAL Supabase stack (Docker, via the Supabase CLI; no account or
 * cloud project needed):
 *   npm run supabase:start     (first time: pulls the Supabase images)
 *   npm run e2e:supabase
 *   npm run supabase:stop
 * Starts its own Vite dev server on port 5175, configured with the local stack's URL and key
 * (these take precedence over any .env.local, which may point at a real project).
 */
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const PORT = 5175;
const ROOT = fileURLToPath(new URL('..', import.meta.url));

export interface LocalStack {
  readonly API_URL: string;
  readonly PUBLISHABLE_KEY: string;
  readonly SECRET_KEY: string;
}

/** Reads the running stack's URL and keys once (workers inherit them through the environment). */
function localStack(): LocalStack {
  const cached = process.env.DAC_SUPABASE_STACK;
  if (cached) return JSON.parse(cached) as LocalStack;
  let status: LocalStack;
  try {
    status = JSON.parse(execSync('npx supabase status -o json', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString()) as LocalStack;
  } catch {
    throw new Error('The local Supabase stack is not running. Start it with `npm run supabase:start` (requires Docker).');
  }
  const stack: LocalStack = { API_URL: status.API_URL, PUBLISHABLE_KEY: status.PUBLISHABLE_KEY, SECRET_KEY: status.SECRET_KEY };
  process.env.DAC_SUPABASE_STACK = JSON.stringify(stack);
  return stack;
}

const stack = localStack();

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.supabase.ts',
  // One backend shared by all tests; each test uses its own users, but runs are easier to read serially.
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 800 },
    hasTouch: true,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    cwd: ROOT,
    url: `http://localhost:${PORT}`,
    // Never reuse: a server started without the local stack's env would test local-only mode.
    reuseExistingServer: false,
    timeout: 90_000,
    env: { VITE_SUPABASE_URL: stack.API_URL, VITE_SUPABASE_PUBLISHABLE_KEY: stack.PUBLISHABLE_KEY },
  },
});
