import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSyncApp, type Identify } from './app.ts';
import { createStaticHandler } from './static.ts';
import { DrawingStore } from './store.ts';

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
  close(): Promise<void>;
}

/** The whole self-hosted server: sync API + WebSocket + the built app, on one port. */
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
  const serveStatic = options.staticDir ? createStaticHandler(options.staticDir) : null;

  const route = async (req: IncomingMessage, res: ServerResponse) => {
    try {
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
    throw err;
  }
  const { port } = server.address() as AddressInfo;
  const host = options.host && options.host !== '0.0.0.0' && options.host !== '::' ? options.host : 'localhost';

  let closing: Promise<void> | null = null;
  return {
    port,
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    store,
    close() {
      closing ??= new Promise<void>((resolve) => {
        app.close();
        server.close(() => {
          store.close();
          resolve();
        });
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
