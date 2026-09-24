/**
 * Production entry point (the Docker image runs `node server/main.ts`; Node strips the types).
 *
 * Environment:
 *   PORT        HTTP port (default 8080)
 *   HOST        bind address (default: all interfaces)
 *   DATA_DIR    where the database lives (default ./data; /data in Docker)
 *   DB_FILE     database file (default $DATA_DIR/draw-a-chart.sqlite; ':memory:' for tests)
 *   STATIC_DIR  built app to serve (default ./dist)
 *   MAX_ROWS    live drawings per user (default 100000)
 *   ALLOWED_ORIGINS  comma-separated extra origins allowed to open the live connection (only
 *               needed when a proxy rewrites the Host header)
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { startServer } from './http.ts';

const env = process.env;
const dbFile = env.DB_FILE || join(env.DATA_DIR || 'data', 'draw-a-chart.sqlite');
if (dbFile !== ':memory:') mkdirSync(dirname(dbFile), { recursive: true });
const staticDir = env.STATIC_DIR || 'dist';
if (!existsSync(join(staticDir, 'index.html'))) console.warn(`[draw-a-chart] ${staticDir}/index.html not found: serving the API only (run \`npm run build\`).`);
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const server = await startServer({
  port: intEnv('PORT', 8080),
  host: env.HOST || undefined,
  dbFile,
  staticDir,
  maxRows: intEnv('MAX_ROWS', 100_000),
  allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  version,
});
console.log(`[draw-a-chart] ${version} listening on port ${server.port} (database: ${dbFile})`);

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(`[draw-a-chart] ${signal}: shutting down`);
    void server.close().then(() => process.exit(0));
  });
}

function intEnv(name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative integer (got "${raw}")`);
  return value;
}
