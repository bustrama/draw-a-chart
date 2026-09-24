import type { ChartKey } from '../drawing/model';
import type { ChangesResponse, ClientMessage, PreviewMessage, PullResponse, RemoteRow, ServerMessage, SessionInfo } from './protocol';
import type { ChangePayload, ChangeResult, ChannelStatus, RemoteApi } from './remote';

/** An HTTP failure from the sync server, or from a proxy in front of it (status 0 = redirect). */
export class SyncServerError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * The error when a login proxy in front of the server (e.g. an expired Cloudflare Access session)
 * redirected a request. The sync panel offers "Sign in again" for exactly this message.
 */
export const LOGIN_REQUIRED = 'The sync server needs a new login';

/** Navigating here passes the login proxy (the service worker never answers /api/ itself). */
export function loginUrl(base = ''): string {
  const next = typeof location === 'undefined' ? '/' : `${location.pathname}${location.search}`;
  return `${base}/api/login?next=${encodeURIComponent(next)}`;
}

export interface LiveEnv {
  createSocket(url: string): WebSocket;
  /** window-like target for 'online', document-like for 'visibilitychange'. */
  readonly windowEvents?: EventTarget;
  readonly documentEvents?: EventTarget & { readonly visibilityState?: string };
}

export function browserLiveEnv(): LiveEnv {
  return { createSocket: (url) => new WebSocket(url), windowEvents: window, documentEvents: document };
}

/** A request that hangs (e.g. a half-open connection) must not block sync forever. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Reconnect delays double up to this. */
const MAX_RETRY_MS = 30_000;
/** A connection attempt that has not opened by then is abandoned and retried. */
const CONNECT_TIMEOUT_MS = 15_000;
/** The server sends a heartbeat every 25 s: this much silence means the connection is dead. */
const SILENCE_MS = 60_000;
/** Coming back to the app with nothing heard for this long: reconnect right away (iOS suspends sockets). */
const STALE_ON_RESUME_MS = 35_000;

interface LiveSubscriber {
  onRow?(row: RemoteRow): void;
  onPreview?(message: PreviewMessage): void;
  onStatus?(status: ChannelStatus): void;
}

/**
 * The self-hosted sync server (server/): HTTP for writes and pulls, one WebSocket for live rows
 * and previews. `base` is '' when the server also serves the app (same origin), else its URL.
 */
export class ServerRemote implements RemoteApi {
  private readonly base: string;
  private readonly live: LiveConnection;
  private serverGeneration: string | null = null;

  constructor(base: string, env: LiveEnv = browserLiveEnv()) {
    this.base = base.replace(/\/+$/, '');
    const origin = typeof location !== 'undefined' ? location.origin : 'http://localhost';
    const url = new URL(`${this.base}/api/live`, origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    this.live = new LiveConnection(url.toString(), env, (generation) => (this.serverGeneration = generation));
  }

  /** The server database's generation, as last reported by the server (null = not heard yet). */
  get generation(): string | null {
    return this.serverGeneration;
  }

  /** Who the server says this client is (no sign-in today: always the single local user). */
  async session(): Promise<SessionInfo> {
    const info = await this.request<SessionInfo>('GET', '/api/session');
    this.serverGeneration = info.generation;
    return info;
  }

  async applyChanges(changes: readonly ChangePayload[]): Promise<ChangeResult[]> {
    const response = await this.request<ChangesResponse>('POST', '/api/changes', { changes });
    return [...response.results];
  }

  async pull(key: ChartKey, since: string | null, limit: number): Promise<RemoteRow[]> {
    const query = new URLSearchParams({ provider: key.provider, symbol: key.symbol, timeframe: key.timeframe, limit: String(limit) });
    if (since) query.set('since', since);
    const response = await this.request<PullResponse>('GET', `/api/drawings?${query.toString()}`);
    return [...response.rows];
  }

  // The server identifies the caller from the request itself, never from a client-supplied id.
  subscribeChanges(_userId: string, onRow: (row: RemoteRow) => void, onStatus: (status: ChannelStatus) => void): () => void {
    return this.live.subscribe({ onRow, onStatus });
  }

  subscribePreviews(_userId: string, onMessage: (m: PreviewMessage) => void): { send(m: PreviewMessage): void; readonly ready: boolean; close(): void } {
    const live = this.live;
    const close = live.subscribe({ onPreview: onMessage });
    return {
      send: (m) => live.sendPreview(m),
      get ready() {
        return live.isOpen;
      },
      close,
    };
  }

  dispose(): void {
    this.live.dispose();
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        // A login proxy (e.g. an expired Cloudflare Access session) answers with a redirect to its
        // login page: report that instead of following it into a CORS failure.
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') throw new SyncServerError('The sync server did not answer in time', 0);
      throw err;
    }
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) throw new SyncServerError(LOGIN_REQUIRED, res.status);
    const text = await res.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // not JSON: e.g. a proxy's HTML error page
    }
    if (!res.ok) {
      const reason = typeof (payload as { error?: unknown } | null)?.error === 'string' ? (payload as { error: string }).error : null;
      throw new SyncServerError(reason ?? `Sync server unavailable (HTTP ${res.status})`, res.status);
    }
    if (payload === null) throw new SyncServerError('Unexpected answer from the sync server (not JSON)', res.status);
    return payload as T;
  }
}

/**
 * One WebSocket to /api/live, shared by the change feed and the previews. Reconnects forever.
 * Subscribers hear 'SUBSCRIBED' once the server's hello arrived (so its generation is known before
 * they resynchronize), and 'CLOSED' when the connection is lost.
 */
class LiveConnection {
  private socket: WebSocket | null = null;
  private open = false;
  private disposed = false;
  private reported: ChannelStatus | null = null;
  private lastMessageAt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 1_000;
  private readonly subs = new Set<LiveSubscriber>();
  private readonly url: string;
  private readonly env: LiveEnv;
  private readonly onHello: (generation: string) => void;

  constructor(url: string, env: LiveEnv, onHello: (generation: string) => void) {
    this.url = url;
    this.env = env;
    this.onHello = onHello;
    env.windowEvents?.addEventListener('online', this.reconnectNow);
    env.documentEvents?.addEventListener('visibilitychange', this.onVisibility);
  }

  get isOpen(): boolean {
    return this.open;
  }

  subscribe(sub: LiveSubscriber): () => void {
    this.subs.add(sub);
    if (this.reported === 'SUBSCRIBED') queueMicrotask(() => this.subs.has(sub) && sub.onStatus?.('SUBSCRIBED'));
    else this.connect();
    return () => {
      this.subs.delete(sub);
      if (this.subs.size === 0) this.disconnect();
    };
  }

  sendPreview(message: PreviewMessage): void {
    if (this.open) this.socket?.send(JSON.stringify({ type: 'preview', message } satisfies ClientMessage));
  }

  dispose(): void {
    this.disposed = true;
    this.env.windowEvents?.removeEventListener('online', this.reconnectNow);
    this.env.documentEvents?.removeEventListener('visibilitychange', this.onVisibility);
    this.subs.clear();
    this.disconnect();
  }

  private connect(): void {
    if (this.socket || this.disposed || this.subs.size === 0) return;
    this.clearRetry();
    let ws: WebSocket;
    try {
      ws = this.env.createSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = ws;
    this.arm(CONNECT_TIMEOUT_MS); // a connection that never opens must not block reconnects
    ws.onopen = () => {
      if (this.socket !== ws) return;
      this.open = true;
      this.heard();
    };
    ws.onmessage = (event: MessageEvent) => {
      if (this.socket !== ws) return;
      this.heard();
      if (typeof event.data === 'string') this.dispatch(event.data);
    };
    ws.onclose = () => {
      if (this.socket === ws) this.lost();
    };
  }

  private dispatch(data: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(data) as ServerMessage;
    } catch {
      return;
    }
    if (message.type === 'hello') {
      this.retryDelay = 1_000;
      this.onHello(message.generation);
      this.report('SUBSCRIBED');
    } else if (message.type === 'rows') {
      for (const sub of [...this.subs]) for (const row of message.rows) sub.onRow?.(row);
    } else if (message.type === 'preview') {
      for (const sub of [...this.subs]) sub.onPreview?.(message.message);
    }
  }

  /** The connection dropped, or went silent: tell subscribers once, then retry with backoff. */
  private lost(): void {
    const ws = this.socket;
    this.detach();
    ws?.close();
    this.report('CLOSED');
    this.scheduleRetry();
  }

  private disconnect(): void {
    this.clearRetry();
    const ws = this.socket;
    this.detach();
    ws?.close();
    this.reported = null;
  }

  private detach(): void {
    this.clearWatchdog();
    if (this.socket) this.socket.onopen = this.socket.onmessage = this.socket.onclose = null;
    this.socket = null;
    this.open = false;
  }

  private report(status: ChannelStatus): void {
    if (this.reported === status) return;
    this.reported = status;
    for (const sub of [...this.subs]) sub.onStatus?.(status);
  }

  private scheduleRetry(): void {
    if (this.disposed || this.subs.size === 0 || this.retryTimer) return;
    const delay = this.retryDelay * (0.75 + Math.random() * 0.5);
    this.retryDelay = Math.min(MAX_RETRY_MS, this.retryDelay * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private readonly reconnectNow = (): void => {
    if (this.socket || this.disposed || this.subs.size === 0) return;
    this.retryDelay = 1_000;
    this.connect();
  };

  private readonly onVisibility = (): void => {
    if (this.env.documentEvents?.visibilityState === 'hidden') return;
    // A socket that was suspended in the background can look open while it is dead.
    if (this.open && Date.now() - this.lastMessageAt > STALE_ON_RESUME_MS) this.lost();
    this.reconnectNow();
  };

  private heard(): void {
    this.lastMessageAt = Date.now();
    this.arm(SILENCE_MS);
  }

  private arm(ms: number): void {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => this.lost(), ms);
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}
