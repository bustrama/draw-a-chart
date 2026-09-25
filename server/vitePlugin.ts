import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';
import { createSyncApp, singleUser, type SyncApp } from './app.ts';
import { createMarket, marketOptionsFromEnv } from './http.ts';
import { DrawingStore } from './store.ts';

type Market = ReturnType<typeof createMarket>;

/**
 * Serves the sync API and the market-data API from the Vite dev/preview server itself: same
 * origin as the app, so `npm run dev` is the whole stack (phones on the LAN included).
 * - Drawings: `.data/dev.sqlite` unless SYNC_DEV_DB says otherwise (':memory:' for throwaway runs).
 * - Market data: `.data/market.sqlite` unless MARKET_DB_FILE says otherwise; US stocks need
 *   APCA_API_KEY_ID and APCA_API_SECRET_KEY (e.g. in `.env`); MARKET_DATA=off turns it off.
 * Both are only opened on the first API request.
 */
export function syncDevServer(env: Readonly<Record<string, string | undefined>> = process.env): Plugin {
  let store: DrawingStore | null = null;
  let app: SyncApp | null = null;
  let market: Market | null | undefined;
  const getApp = (): SyncApp => {
    if (!app) {
      const file = env.SYNC_DEV_DB || '.data/dev.sqlite';
      if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
      store = new DrawingStore(file);
      app = createSyncApp({ store, version: 'dev' });
    }
    return app;
  };
  const getMarket = (log: (message: string) => void): Market | null => {
    if (market === undefined) {
      const options = marketOptionsFromEnv(env, '.data/market.sqlite');
      if (options && options.dbFile !== ':memory:') mkdirSync(dirname(options.dbFile), { recursive: true });
      market = options ? createMarket(options, singleUser, log) : null;
    }
    return market;
  };
  const shutdown = () => {
    app?.close();
    store?.close();
    market?.close();
    app = null;
    store = null;
    market = undefined;
  };
  const attach = (server: ViteDevServer | PreviewServer) => {
    const log = (message: string) => server.config.logger.info(message);
    server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith('/api/')) return next();
      const marketApp = req.url.startsWith('/api/market') ? getMarket(log)?.app : null;
      (marketApp ? marketApp.handle(req, res) : getApp().handle(req, res)).then((handled) => (handled ? undefined : next()), next);
    });
    // Vite's own HMR socket shares this server; it ignores upgrades that are not its protocol.
    server.httpServer?.on('upgrade', (req, socket, head) => {
      if (!req.url?.startsWith('/api/live')) return;
      try {
        getApp().upgrade(req, socket, head);
      } catch (err) {
        server.config.logger.error(`[sync] ${err instanceof Error ? err.message : String(err)}`);
        socket.destroy();
      }
    });
    server.httpServer?.on('close', shutdown);
  };
  return {
    name: 'draw-a-chart:sync-dev-server',
    apply: (_config, viteEnv) => viteEnv.command === 'serve' && !process.env.VITEST,
    configureServer: attach,
    configurePreviewServer: attach,
  };
}
