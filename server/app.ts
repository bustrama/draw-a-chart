import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { ChangesResponse, ErrorResponse, PreviewMessage, PullResponse, RemoteRow, ServerMessage, SessionInfo } from '../src/sync/protocol.ts';
import type { DrawingStore } from './store.ts';
import { parseChangesRequest, toPreviewMessage } from './validate.ts';

export interface Identity {
  readonly userId: string;
}

/**
 * Decides who is calling; null means "not signed in" (HTTP 401, WebSocket refused). May be async
 * (e.g. fetching signing keys). This is the single place to add authentication later, e.g. by
 * verifying the Cloudflare Access JWT in the `Cf-Access-Jwt-Assertion` header or a session cookie.
 * Live connections are only checked when they open; with expiring credentials, also close them
 * when the credentials expire.
 */
export type Identify = (req: IncomingMessage) => Identity | null | Promise<Identity | null>;

/** No sign-in: every caller is the one local user. */
export const singleUser: Identify = () => ({ userId: 'local' });

export interface SyncAppOptions {
  readonly store: DrawingStore;
  readonly identify?: Identify;
  /** Live (non-deleted) drawings per user: a guard against runaway clients. */
  readonly maxRows?: number;
  readonly maxBodyBytes?: number;
  /** Interval of WebSocket heartbeats; also how long a silent dead connection may linger. */
  readonly heartbeatMs?: number;
  /**
   * Extra origins allowed to open the live connection. The page's own origin always is (Origin
   * host = Host); list others if a proxy rewrites the Host header.
   */
  readonly allowedOrigins?: readonly string[];
  readonly version?: string;
  readonly log?: (message: string) => void;
}

export interface SyncApp {
  /** Handles `/api/*`. Resolves false for any other path (not handled). */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  /** Handles the `/api/live` WebSocket upgrade. Returns false for any other path. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  close(): void;
}

interface LiveConn {
  readonly ws: WebSocket;
  readonly userId: string;
  alive: boolean;
}

/** Previews are dropped (rows never are) for a connection that is this far behind. */
const PREVIEW_BACKLOG_BYTES = 1 << 20;
/** A connection this far behind on rows is dropped; the client reconnects and pulls. */
const ROWS_BACKLOG_BYTES = 16 << 20;

class HttpError extends Error {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  constructor(status: number, message: string, headers: Readonly<Record<string, string>> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

/**
 * The sync API, independent of how it is hosted: the production server (server/http.ts) and the
 * Vite dev server (server/vitePlugin.ts) both route requests into it.
 *
 * HTTP: GET /api/health, GET /api/session, POST /api/changes, GET /api/drawings, GET /api/login.
 * WebSocket /api/live: pushes changed rows to every device of the user and relays live
 * previews between them (see src/sync/protocol.ts).
 */
export function createSyncApp(options: SyncAppOptions): SyncApp {
  const { store } = options;
  const identify = options.identify ?? singleUser;
  const maxRows = options.maxRows ?? 100_000;
  const maxBodyBytes = options.maxBodyBytes ?? 16 << 20;
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const log = options.log ?? ((m: string) => console.log(m));
  const version = options.version ?? 'dev';

  const conns = new Map<string, Set<LiveConn>>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  const heartbeat = setInterval(() => {
    for (const set of conns.values()) {
      for (const conn of set) {
        if (!conn.alive) {
          conn.ws.terminate();
          continue;
        }
        conn.alive = false;
        conn.ws.ping();
        send(conn.ws, { type: 'ping' });
      }
    }
  }, options.heartbeatMs ?? 25_000);
  heartbeat.unref();

  function broadcastRows(userId: string, rows: readonly RemoteRow[]): void {
    if (rows.length === 0) return;
    const message = JSON.stringify({ type: 'rows', rows } satisfies ServerMessage);
    for (const conn of conns.get(userId) ?? []) {
      if (conn.ws.bufferedAmount > ROWS_BACKLOG_BYTES) conn.ws.terminate();
      else conn.ws.send(message);
    }
  }

  function relayPreview(from: LiveConn, message: PreviewMessage): void {
    const data = JSON.stringify({ type: 'preview', message } satisfies ServerMessage);
    for (const conn of conns.get(from.userId) ?? []) {
      if (conn !== from && conn.ws.bufferedAmount < PREVIEW_BACKLOG_BYTES) conn.ws.send(data);
    }
  }

  function attach(ws: WebSocket, userId: string): void {
    const conn: LiveConn = { ws, userId, alive: true };
    const set = conns.get(userId) ?? new Set<LiveConn>();
    conns.set(userId, set);
    set.add(conn);
    ws.on('pong', () => (conn.alive = true));
    ws.on('message', (data: RawData, isBinary: boolean) => {
      conn.alive = true;
      if (isBinary) return;
      try {
        const m = JSON.parse(data.toString()) as { type?: unknown; message?: unknown };
        const preview = m.type === 'preview' ? toPreviewMessage(m.message) : null;
        if (preview) relayPreview(conn, preview);
      } catch {
        // malformed message: ignore
      }
    });
    // 'close' and 'error' may both fire: only drop the map entry if it is still this set.
    const detach = () => {
      set.delete(conn);
      if (set.size === 0 && conns.get(userId) === set) conns.delete(userId);
    };
    ws.on('close', detach);
    ws.on('error', detach);
    send(ws, { type: 'hello', user: { id: userId }, generation: store.generation });
  }

  async function route(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<void> {
    switch (path) {
      case '/api/health': {
        allow(req, 'GET');
        const problem = store.checkWritable();
        return json(res, problem ? 503 : 200, problem ? { ok: false, version, error: problem } : { ok: true, version });
      }
      case '/api/session': {
        allow(req, 'GET');
        const who = await authenticate(req);
        return json(res, 200, { user: { id: who.userId }, auth: 'none', generation: store.generation } satisfies SessionInfo);
      }
      case '/api/login':
        // A navigation the app's service worker never answers from its cache, so a login proxy in
        // front of the server (e.g. an expired Cloudflare Access session) gets to show its login
        // page. Then straight back into the app.
        allow(req, 'GET');
        res.writeHead(302, { Location: sameOriginPath(url.searchParams.get('next')), 'Cache-Control': 'no-store' }).end();
        return;
      case '/api/changes': {
        allow(req, 'POST');
        const who = await authenticate(req);
        // application/json also makes a cross-site form or no-CORS POST impossible.
        if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'expected application/json');
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req, maxBodyBytes));
        } catch (err) {
          if (err instanceof HttpError) throw err;
          throw new HttpError(400, 'invalid JSON');
        }
        const parsed = parseChangesRequest(body);
        if (!parsed.ok) throw new HttpError(400, parsed.error);
        const outcome = store.apply(who.userId, parsed.changes, maxRows);
        json(res, 200, { results: outcome.results } satisfies ChangesResponse);
        broadcastRows(who.userId, outcome.changed);
        return;
      }
      case '/api/drawings': {
        allow(req, 'GET');
        const who = await authenticate(req);
        const provider = url.searchParams.get('provider');
        const symbol = url.searchParams.get('symbol');
        const timeframe = url.searchParams.get('timeframe');
        if (!provider || !symbol || !timeframe) throw new HttpError(400, 'provider, symbol and timeframe are required');
        const since = url.searchParams.get('since');
        const limit = Math.min(1_000, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '500', 10) || 500));
        return json(res, 200, { rows: store.pull(who.userId, { provider, symbol, timeframe }, since, limit) } satisfies PullResponse);
      }
      case '/api/live':
        throw new HttpError(426, 'WebSocket upgrade required');
      default:
        throw new HttpError(404, 'not found');
    }
  }

  async function authenticate(req: IncomingMessage): Promise<Identity> {
    const who = await identify(req);
    if (!who) throw new HttpError(401, 'not signed in');
    return who;
  }

  /** Browsers always send Origin on WebSocket handshakes: a page of another site must not read the live feed. */
  function originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true; // not a browser
    if (allowedOrigins.has(origin)) return true;
    let host: string;
    try {
      host = new URL(origin).host.toLowerCase();
    } catch {
      return false;
    }
    const forwarded = req.headers['x-forwarded-host'];
    return host === req.headers.host?.toLowerCase() || (typeof forwarded === 'string' && forwarded.split(',')[0].trim().toLowerCase() === host);
  }

  async function acceptLive(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (!originAllowed(req)) return refuse(socket, 403, 'Forbidden');
    let who: Identity | null;
    try {
      who = await identify(req);
    } catch (err) {
      log(`[sync] identify failed: ${err instanceof Error ? err.message : String(err)}`);
      return refuse(socket, 500, 'Internal Server Error');
    }
    if (!who) return refuse(socket, 401, 'Unauthorized');
    if (socket.destroyed) return;
    const { userId } = who;
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, userId));
  }

  return {
    async handle(req, res) {
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://localhost');
      } catch {
        return false;
      }
      const path = url.pathname;
      if (path !== '/api' && !path.startsWith('/api/')) return false;
      try {
        await route(req, res, path, url);
      } catch (err) {
        if (err instanceof HttpError) {
          for (const [name, value] of Object.entries(err.headers)) res.setHeader(name, value);
          json(res, err.status, { error: err.message } satisfies ErrorResponse);
        } else {
          log(`[sync] ${req.method} ${path} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
          if (!res.headersSent) json(res, 500, { error: 'internal error' } satisfies ErrorResponse);
          else res.destroy();
        }
      }
      return true;
    },

    upgrade(req, socket, head) {
      let path: string;
      try {
        path = new URL(req.url ?? '/', 'http://localhost').pathname;
      } catch {
        return false;
      }
      if (path !== '/api/live') return false;
      // Node attaches no 'error' listener to upgrade sockets: a reset would crash the process.
      socket.on('error', () => socket.destroy());
      void acceptLive(req, socket, head).catch(() => socket.destroy());
      return true;
    },

    close() {
      clearInterval(heartbeat);
      for (const set of conns.values()) for (const conn of set) conn.ws.close(1001, 'server shutting down');
      conns.clear();
      wss.close();
    },
  };
}

function allow(req: IncomingMessage, method: 'GET' | 'POST'): void {
  if (req.method === method || (method === 'GET' && req.method === 'HEAD')) return;
  throw new HttpError(405, 'method not allowed', { Allow: method === 'GET' ? 'GET, HEAD' : method });
}

/** A same-origin path to continue to (never another site: no open redirect). */
function sameOriginPath(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\') || next.startsWith('/api/')) return '/';
  return next;
}

function refuse(socket: Duplex, status: number, text: string): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

/** Reads a request body, refusing (413) more than `limit` bytes. */
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) {
    req.resume();
    return Promise.reject(new HttpError(413, `request too large (max ${limit} bytes)`));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) tooLarge = true;
      else if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => (tooLarge ? reject(new HttpError(413, `request too large (max ${limit} bytes)`)) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}
