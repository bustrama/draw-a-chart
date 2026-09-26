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
 *   MARKET_DATA 'off' disables /api/market (the app then has no market data from this server)
 *   MARKET_DB_FILE   bar cache (default $DATA_DIR/market.sqlite; a cache: safe to delete, not backed up)
 *   APCA_API_KEY_ID, APCA_API_SECRET_KEY   Alpaca key for US stocks (a free paper-account key works)
 *   ALPACA_FEED delayed_sip (default: every exchange, 15 min late: the free plan), sip (real time,
 *               paid) or iex (one exchange, real time)
 *   ALPACA_TRADING_URL  trading API host for the calendar and asset list (default: by key type)
 *   REQUEST_LOG '1' logs one line per request (path, status, request kind, browser family, how long
 *               a login proxy's access token is valid; never tokens, cookies or identities)
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { marketOptionsFromEnv, startServer } from './http.ts';

const env = process.env;
const dbFile = env.DB_FILE || join(env.DATA_DIR || 'data', 'draw-a-chart.sqlite');
if (dbFile !== ':memory:') mkdirSync(dirname(dbFile), { recursive: true });
const staticDir = env.STATIC_DIR || 'dist';
if (!existsSync(join(staticDir, 'index.html'))) console.warn(`[draw-a-chart] ${staticDir}/index.html not found: serving the API only (run \`npm run build\`).`);
const market = marketOptionsFromEnv(env, join(env.DATA_DIR || 'data', 'market.sqlite'));
if (market && market.dbFile !== ':memory:') mkdirSync(dirname(market.dbFile), { recursive: true });
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const server = await startServer({
  port: intEnv('PORT', 8080),
  host: env.HOST || undefined,
  dbFile,
  staticDir,
  market,
  requestLog: env.REQUEST_LOG === '1',
  maxRows: intEnv('MAX_ROWS', 100_000),
  allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  version,
});
console.log(`[draw-a-chart] ${version} listening on port ${server.port} (database: ${dbFile})`);
console.log(
  market
    ? `[draw-a-chart] market data: crypto (Binance), ${market.alpaca ? `US stocks (Alpaca, ${market.alpaca.feed})` : 'no US stocks (set APCA_API_KEY_ID and APCA_API_SECRET_KEY)'}; cache ${market.dbFile}`
    : '[draw-a-chart] market data off (MARKET_DATA=off)',
);

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
