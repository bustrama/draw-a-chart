import { existsSync, renameSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSyncApp, singleUser, type Identify } from './app.ts';
import { AlpacaUpstream, type AlpacaConfig, type AlpacaFeed } from './market/alpaca.ts';
import { createMarketApp, type MarketApp } from './market/api.ts';
import { BinanceUpstream } from './market/binance.ts';
import { BarCache } from './market/cache.ts';
import { accessToken, client, logRequest } from './requestLog.ts';
import { MarketService, type CryptoUpstream, type FuturesUpstream, type StockUpstream } from './market/service.ts';
import { YahooUpstream } from './market/yahoo.ts';
import { createStaticHandler } from './static.ts';
import { DrawingStore } from './store.ts';

export interface MarketOptions {
  /** SQLite file of the bar cache (':memory:' for a throwaway one). */
  readonly dbFile: string;
  /** Alpaca credentials for US stocks; null = no US market. */
  readonly alpaca?: AlpacaConfig | null;
  /** Futures from Yahoo Finance (default true). */
  readonly futures?: boolean;
  /** Stand-ins for the upstream providers (tests); null turns a market off. */
  readonly upstreams?: { readonly binance?: CryptoUpstream | null; readonly alpaca?: StockUpstream | null; readonly yahoo?: FuturesUpstream | null };
  readonly now?: () => number;
  /** Background work (default true): load symbol lists and the calendar at startup, keep futures history. */
  readonly warmUp?: boolean;
}

/** The futures archive (MarketService.archiveFutures) runs shortly after startup, then this often. */
const ARCHIVE_FIRST_MS = 2 * 60_000;
const ARCHIVE_EVERY_MS = 12 * 3_600_000;

export interface ServerOptions {
  /** 0 = any free port. */
  readonly port?: number;
  /** Bind address; default: all interfaces, IPv4 and IPv6. */
  readonly host?: string;
  /** SQLite file, or ':memory:' for a throwaway database. */
  readonly dbFile?: string;
  /** Built app to serve (Vite's dist/); null = API only. */
  readonly staticDir?: string | null;
  readonly identify?: Identify;
  /** Market data (/api/market/*); null or absent = off. */
  readonly market?: MarketOptions | null;
  readonly maxRows?: number;
  readonly maxBodyBytes?: number;
  readonly heartbeatMs?: number;
  readonly allowedOrigins?: readonly string[];
  readonly version?: string;
  /** One log line per request (debugging a login proxy such as Cloudflare Access). */
  readonly requestLog?: boolean;
  readonly log?: (message: string) => void;
}

export interface RunningServer {
  readonly port: number;
  /** http://<host>:<port> (localhost when bound to all interfaces). */
  readonly url: string;
  readonly store: DrawingStore;
  readonly market: MarketService | null;
  close(): Promise<void>;
}

/**
 * Market-data settings from the environment (see server/main.ts): MARKET_DATA=off, MARKET_DB_FILE,
 * APCA_API_KEY_ID + APCA_API_SECRET_KEY (US stocks), ALPACA_FEED, ALPACA_TRADING_URL, FUTURES_DATA=off.
 */
export function marketOptionsFromEnv(env: Readonly<Record<string, string | undefined>>, defaultDbFile: string): MarketOptions | null {
  if (env.MARKET_DATA === 'off') return null;
  const keyId = env.APCA_API_KEY_ID?.trim();
  const secretKey = env.APCA_API_SECRET_KEY?.trim();
  const feed = (env.ALPACA_FEED?.trim() || 'delayed_sip') as AlpacaFeed;
  if (!['delayed_sip', 'sip', 'iex'].includes(feed)) throw new Error(`ALPACA_FEED must be delayed_sip, sip or iex (got "${feed}")`);
  return {
    dbFile: env.MARKET_DB_FILE || defaultDbFile,
    alpaca: keyId && secretKey ? { keyId, secretKey, feed, tradingUrl: env.ALPACA_TRADING_URL?.trim() || undefined } : null,
    futures: env.FUTURES_DATA !== 'off',
  };
}

/** The market-data API: bar cache, upstream providers and routes. */
export function createMarket(options: MarketOptions, identify: Identify, log: (message: string) => void): { service: MarketService; app: MarketApp; close(): void } {
  const cache = openCache(options.dbFile, log);
  const upstreams = options.upstreams ?? {};
  const binance = upstreams.binance !== undefined ? upstreams.binance : new BinanceUpstream();
  const alpaca = upstreams.alpaca !== undefined ? upstreams.alpaca : options.alpaca ? new AlpacaUpstream(options.alpaca) : null;
  const yahoo = upstreams.yahoo !== undefined ? upstreams.yahoo : options.futures !== false ? new YahooUpstream() : null;
  const service = new MarketService({ cache, binance, alpaca, yahoo, now: options.now, log });
  const stopArchive = options.warmUp !== false && yahoo ? scheduleArchive(service, log) : () => undefined;
  if (options.warmUp !== false) service.warmUp();
  return {
    service,
    app: createMarketApp({ service, identify, log }),
    close: () => {
      stopArchive();
      cache.close();
    },
  };
}

/** Runs the futures archive in the background, one run at a time, until stopped. */
function scheduleArchive(service: MarketService, log: (message: string) => void): () => void {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const later = (ms: number) => {
    if (abort.signal.aborted) return;
    timer = setTimeout(run, ms);
    timer.unref();
  };
  const run = () => {
    timer = null;
    service
      .archiveFutures(abort.signal)
      .catch((err: unknown) => log(`[market] futures archive: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => later(ARCHIVE_EVERY_MS));
  };
  later(ARCHIVE_FIRST_MS);
  return () => {
    abort.abort();
    if (timer) clearTimeout(timer);
  };
}

/**
 * Opens the bar cache. One that cannot be opened (corrupt, or a newer schema after a rollback) is
 * moved aside to `<file>.unusable-<time>` with its write-ahead log, and an empty one started:
 * losing the cache must not stop the server (and drawing sync), and the futures history only it
 * keeps is not thrown away.
 */
function openCache(file: string, log: (message: string) => void): BarCache {
  try {
    return new BarCache(file);
  } catch (err) {
    if (file === ':memory:') throw err;
    const aside = `${file}.unusable-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    log(`[market] cache ${file} unusable (${err instanceof Error ? err.message : String(err)}): moved to ${aside}, starting an empty one`);
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(file + suffix)) renameSync(file + suffix, aside + suffix);
    return new BarCache(file);
  }
}

/** The whole self-hosted server: sync API + market data + WebSocket + the built app, on one port. */
export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const log = options.log ?? ((m: string) => console.log(m));
  const store = new DrawingStore(options.dbFile ?? ':memory:');
  const app = createSyncApp({
    store,
    identify: options.identify,
    maxRows: options.maxRows,
    maxBodyBytes: options.maxBodyBytes,
    heartbeatMs: options.heartbeatMs,
    allowedOrigins: options.allowedOrigins,
    version: options.version,
    log,
  });
  const market = options.market ? createMarket(options.market, options.identify ?? singleUser, log) : null;
  const serveStatic = options.staticDir ? createStaticHandler(options.staticDir) : null;

  const route = async (req: IncomingMessage, res: ServerResponse) => {
    if (options.requestLog) {
      const startedAt = performance.now();
      res.once('finish', () => logRequest(req, res, startedAt, log));
    }
    try {
      if (market && (await market.app.handle(req, res))) return;
      if (await app.handle(req, res)) return;
      if (serveStatic && (await serveStatic(req, res))) return;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    } catch (err) {
      log(`[http] ${req.method} ${req.url} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Internal error');
      else res.destroy();
    }
  };
  const server = createServer((req, res) => void route(req, res));
  server.on('upgrade', (req, socket, head) => {
    if (options.requestLog) {
      const jwt = req.headers['cf-access-jwt-assertion'];
      log(`[req] UPGRADE ${(req.url ?? '/').split('?')[0]} ${client(req.headers['user-agent'])} ${accessToken(typeof jwt === 'string' ? jwt : undefined)}`);
    }
    try {
      if (!app.upgrade(req, socket, head)) socket.destroy();
    } catch (err) {
      log(`[http] upgrade ${req.url} failed: ${err instanceof Error ? err.message : String(err)}`);
      socket.destroy();
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, options.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    app.close();
    store.close();
    market?.close();
    throw err;
  }
  const { port } = server.address() as AddressInfo;
  const host = options.host && options.host !== '0.0.0.0' && options.host !== '::' ? options.host : 'localhost';

  let closing: Promise<void> | null = null;
  return {
    port,
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    store,
    market: market?.service ?? null,
    close() {
      closing ??= new Promise<void>((resolve) => {
        app.close();
        server.close(() => {
          store.close();
          market?.close();
          resolve();
        });
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
