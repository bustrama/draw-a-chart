import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';
import { createSyncApp, type SyncApp } from './app.ts';
import { DrawingStore } from './store.ts';

/**
 * Serves the sync API from the Vite dev/preview server itself: same origin as the app, so
 * `npm run dev` is the whole stack (phones on the LAN included). The database is
 * `.data/dev.sqlite` unless SYNC_DEV_DB says otherwise (':memory:' for throwaway runs); it is
 * only opened on the first API request.
 */
export function syncDevServer(): Plugin {
  let store: DrawingStore | null = null;
  let app: SyncApp | null = null;
  const getApp = (): SyncApp => {
    if (!app) {
      const file = process.env.SYNC_DEV_DB || '.data/dev.sqlite';
      if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
      store = new DrawingStore(file);
      app = createSyncApp({ store, version: 'dev' });
    }
    return app;
  };
  const shutdown = () => {
    app?.close();
    store?.close();
    app = null;
    store = null;
  };
  const attach = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith('/api/')) return next();
      getApp()
        .handle(req, res)
        .then((handled) => (handled ? undefined : next()), next);
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
    apply: (_config, env) => env.command === 'serve' && !process.env.VITEST,
    configureServer: attach,
    configurePreviewServer: attach,
  };
}
