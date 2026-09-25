import { rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSyncApp, singleUser, type Identify } from './app.ts';
import { AlpacaUpstream, type AlpacaConfig, type AlpacaFeed } from './market/alpaca.ts';
import { createMarketApp, type MarketApp } from './market/api.ts';
import { BinanceUpstream } from './market/binance.ts';
import { BarCache } from './market/cache.ts';
import { MarketService, type CryptoUpstream, type StockUpstream } from './market/service.ts';
import { createStaticHandler } from './static.ts';
import { DrawingStore } from './store.ts';

export interface MarketOptions {
  /** SQLite file of the bar cache (':memory:' for a throwaway one). */
  readonly dbFile: string;
  /** Alpaca credentials for US stocks; null = no US market. */
  readonly alpaca?: AlpacaConfig | null;
  /** Stand-ins for the upstream providers (tests); null turns a market off. */
  readonly upstreams?: { readonly binance?: CryptoUpstream | null; readonly alpaca?: StockUpstream | null };
  readonly now?: () => number;
  /** Load symbol lists and the calendar at startup (default true). */
  readonly warmUp?: boolean;
}

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
 * APCA_API_KEY_ID + APCA_API_SECRET_KEY (US stocks), ALPACA_FEED, ALPACA_TRADING_URL.
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
  };
}

/** The market-data API: bar cache, upstream providers and routes. */
export function createMarket(options: MarketOptions, identify: Identify, log: (message: string) => void): { service: MarketService; app: MarketApp; close(): void } {
  const cache = openCache(options.dbFile, log);
  const upstreams = options.upstreams ?? {};
  const binance = upstreams.binance !== undefined ? upstreams.binance : new BinanceUpstream();
  const alpaca = upstreams.alpaca !== undefined ? upstreams.alpaca : options.alpaca ? new AlpacaUpstream(options.alpaca) : null;
  const service = new MarketService({ cache, binance, alpaca, now: options.now, log });
  if (options.warmUp !== false) service.warmUp();
  return { service, app: createMarketApp({ service, identify, log }), close: () => cache.close() };
}

/**
 * Opens the bar cache; one that cannot be opened (corrupt, or a newer schema after a rollback) is
 * replaced by a new one. It is only a cache: losing it must not stop the server (and drawing sync).
 */
function openCache(file: string, log: (message: string) => void): BarCache {
  try {
    return new BarCache(file);
  } catch (err) {
    if (file === ':memory:') throw err;
    log(`[market] cache ${file} unusable (${err instanceof Error ? err.message : String(err)}): starting an empty one`);
    for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
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
