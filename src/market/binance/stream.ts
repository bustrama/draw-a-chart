import type { LiveStatus } from '../types';

/** Subset of the WebSocket API we depend on (lets tests inject a fake). */
export interface StreamSocket {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type SocketFactory = (url: string) => StreamSocket;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

/** Minimal event-target surface for window/document lifecycle signals. */
export interface LifecycleEvents {
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

export interface StreamClientOptions {
  /** e.g. ['wss://data-stream.binance.vision', 'wss://stream.binance.com:9443'] */
  readonly baseUrls: readonly string[];
  readonly createSocket?: SocketFactory;
  readonly clock?: Clock;
  readonly random?: () => number;
  /** Force a reconnect after this long without any message. BTC/ETH klines update every ~2 s. */
  readonly silenceTimeoutMs?: number;
  /** Binance closes connections after 24 h; rotate before that. */
  readonly maxLifetimeMs?: number;
  /** Keep an idle socket open briefly so quick symbol/timeframe switches reuse it. */
  readonly lingerMs?: number;
  /** Spacing of client->server messages (Binance allows at most 5 per second). */
  readonly sendSpacingMs?: number;
  /** window-like target for 'online'/'offline'; document-like target for 'visibilitychange'. */
  readonly windowEvents?: LifecycleEvents;
  readonly documentEvents?: LifecycleEvents & { readonly visibilityState?: string };
}

export interface StreamSubscriber {
  onData(data: unknown): void;
  /** The connection re-opened after an interruption: data may have been missed. */
  onResync?(): void;
  onStatus?(status: LiveStatus): void;
}

interface SubscriberEntry {
  readonly sub: StreamSubscriber;
  /** Whether this subscriber has already been live once (so a later open means "resync"). */
  seenOpen: boolean;
}

const OPEN = 1;
const SHUTDOWN_STREAM = '!serverShutdown';

const defaultClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/**
 * One multiplexed connection to Binance combined streams (`/stream?streams=a/b`).
 * - Desired streams are part of the URL on every (re)connect; changes while connected are
 *   applied with SUBSCRIBE/UNSUBSCRIBE (paced below Binance's 5 msg/s limit).
 * - Reconnects with exponential backoff + jitter and rotates hosts after failures.
 * - A silence watchdog, 23 h rotation, `serverShutdown` events, `online` and
 *   `visibilitychange` all trigger reconnects. Every re-open fires `onResync` so feeds
 *   backfill whatever they missed.
 */
export class BinanceStreamClient {
  private readonly o: Required<Omit<StreamClientOptions, 'windowEvents' | 'documentEvents'>>;
  private readonly windowEvents?: LifecycleEvents;
  private readonly documentEvents?: LifecycleEvents & { readonly visibilityState?: string };
  private readonly streams = new Map<string, Set<SubscriberEntry>>();
  private socket: StreamSocket | null = null;
  /** Streams the current socket is (or will be) subscribed to. */
  private socketStreams = new Set<string>();
  private status: LiveStatus = 'idle';
  private attempt = 0;
  private hostIndex = 0;
  private openedAt = 0;
  private lastMessageAt = 0;
  private reconnectTimer: unknown = null;
  private lingerTimer: unknown = null;
  private watchdogTimer: unknown = null;
  private sendTimer: unknown = null;
  private readonly outbox: string[] = [];
  private nextSendAt = 0;
  private requestId = 1;
  private disposed = false;

  constructor(options: StreamClientOptions) {
    if (options.baseUrls.length === 0) throw new Error('at least one base URL is required');
    this.o = {
      baseUrls: options.baseUrls,
      createSocket: options.createSocket ?? ((url) => new WebSocket(url) as unknown as StreamSocket),
      clock: options.clock ?? defaultClock,
      random: options.random ?? Math.random,
      silenceTimeoutMs: options.silenceTimeoutMs ?? 30_000,
      maxLifetimeMs: options.maxLifetimeMs ?? 23 * 3_600_000,
      lingerMs: options.lingerMs ?? 10_000,
      sendSpacingMs: options.sendSpacingMs ?? 250,
    };
    this.windowEvents = options.windowEvents;
    this.documentEvents = options.documentEvents;
    this.windowEvents?.addEventListener('online', this.onOnline);
    this.windowEvents?.addEventListener('offline', this.onOffline);
    this.documentEvents?.addEventListener('visibilitychange', this.onVisibility);
  }

  get currentStatus(): LiveStatus {
    return this.status;
  }

  subscribe(stream: string, sub: StreamSubscriber): () => void {
    if (this.disposed) throw new Error('stream client disposed');
    const entry: SubscriberEntry = { sub, seenOpen: this.isOpen() };
    let set = this.streams.get(stream);
    if (!set) {
      set = new Set();
      this.streams.set(stream, set);
    }
    set.add(entry);
    this.cancelLinger();
    sub.onStatus?.(this.status);
    this.ensureConnected();
    return () => {
      const s = this.streams.get(stream);
      if (!s || !s.delete(entry)) return;
      if (s.size === 0) this.streams.delete(stream);
      if (this.streams.size === 0) this.scheduleLinger();
      else this.reconcile();
    };
  }

  dispose(): void {
    this.disposed = true;
    this.windowEvents?.removeEventListener('online', this.onOnline);
    this.windowEvents?.removeEventListener('offline', this.onOffline);
    this.documentEvents?.removeEventListener('visibilitychange', this.onVisibility);
    this.streams.clear();
    this.clearTimer('reconnectTimer');
    this.clearTimer('lingerTimer');
    this.closeSocket('dispose');
    this.setStatus('idle');
  }

  // ---- connection lifecycle -------------------------------------------------------------

  private isOpen(): boolean {
    return this.socket !== null && this.socket.readyState === OPEN;
  }

  private ensureConnected(): void {
    if (this.disposed || this.streams.size === 0) return;
    if (this.socket) {
      if (this.isOpen()) this.reconcile();
      return; // still connecting: onopen reconciles
    }
    if (this.reconnectTimer !== null) return; // backoff pending
    this.connect();
  }

  private connect(): void {
    this.clearTimer('reconnectTimer');
    if (this.disposed || this.streams.size === 0) return;
    const desired = [...this.streams.keys()];
    const base = this.o.baseUrls[this.hostIndex % this.o.baseUrls.length];
    const url = `${base}/stream?streams=${desired.join('/')}`;
    this.setStatus(this.attempt > 0 ? 'reconnecting' : 'connecting');
    let socket: StreamSocket;
    try {
      socket = this.o.createSocket(url);
    } catch {
      this.scheduleReconnect(false);
      return;
    }
    this.socket = socket;
    this.socketStreams = new Set(desired);
    this.outbox.length = 0;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.openedAt = this.o.clock.now();
      this.lastMessageAt = this.openedAt;
      this.setStatus('live');
      this.startWatchdog();
      for (const set of this.streams.values()) {
        for (const entry of set) {
          if (entry.seenOpen) entry.sub.onResync?.();
          entry.seenOpen = true;
        }
      }
      this.reconcile();
    };
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      this.lastMessageAt = this.o.clock.now();
      this.handleMessage(ev.data);
    };
    socket.onerror = () => {
      // onclose always follows; nothing to do here.
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      const wasOpenFor = this.openedAt > 0 ? this.o.clock.now() - this.openedAt : 0;
      this.socket = null;
      this.openedAt = 0;
      this.stopWatchdog();
      this.clearTimer('sendTimer');
      this.outbox.length = 0;
      if (this.disposed || this.streams.size === 0) {
        this.setStatus('idle');
        return;
      }
      // A connection that was healthy for a while gets an immediate-ish retry.
      if (wasOpenFor >= 60_000) this.attempt = 0;
      this.scheduleReconnect(wasOpenFor === 0);
    };
  }

  private scheduleReconnect(neverOpened: boolean): void {
    if (this.disposed) return;
    if (neverOpened) this.hostIndex++;
    const base = Math.min(60_000, 1_000 * 2 ** this.attempt);
    const delay = base / 2 + this.o.random() * (base / 2);
    this.attempt++;
    this.setStatus(isOffline(this.windowEvents) ? 'offline' : 'reconnecting');
    this.clearTimer('reconnectTimer');
    this.reconnectTimer = this.o.clock.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** Drops the current socket and reconnects right away (used for rotation and recovery). */
  private restart(): void {
    this.clearTimer('reconnectTimer');
    this.attempt = 0;
    const had = this.socket;
    this.closeSocket('restart');
    if (had || this.streams.size > 0) this.connect();
  }

  private closeSocket(reason: string): void {
    const socket = this.socket;
    this.socket = null;
    this.openedAt = 0;
    this.stopWatchdog();
    this.clearTimer('sendTimer');
    this.outbox.length = 0;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      try {
        socket.close(1000, reason);
      } catch {
        // ignore
      }
    }
  }

  private scheduleLinger(): void {
    this.cancelLinger();
    this.lingerTimer = this.o.clock.setTimeout(() => {
      this.lingerTimer = null;
      if (this.streams.size === 0) {
        this.clearTimer('reconnectTimer');
        this.closeSocket('idle');
        this.attempt = 0;
        this.setStatus('idle');
      }
    }, this.o.lingerMs);
  }

  private cancelLinger(): void {
    this.clearTimer('lingerTimer');
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    const tick = (): void => {
      this.watchdogTimer = null;
      if (!this.isOpen()) return;
      const now = this.o.clock.now();
      if (now - this.lastMessageAt > this.o.silenceTimeoutMs || now - this.openedAt > this.o.maxLifetimeMs) {
        this.restart();
        return;
      }
      this.watchdogTimer = this.o.clock.setTimeout(tick, 5_000);
    };
    this.watchdogTimer = this.o.clock.setTimeout(tick, 5_000);
  }

  private stopWatchdog(): void {
    this.clearTimer('watchdogTimer');
  }

  // ---- messages ---------------------------------------------------------------------------

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as { stream?: unknown; data?: unknown; id?: unknown };
    if (typeof m.stream === 'string') {
      const data = m.data as { e?: unknown } | undefined;
      if (m.stream === SHUTDOWN_STREAM || data?.e === 'serverShutdown') {
        this.restart();
        return;
      }
      const set = this.streams.get(m.stream);
      if (!set) return;
      for (const entry of [...set]) entry.sub.onData(m.data);
    }
    // Responses to SUBSCRIBE/UNSUBSCRIBE ({ result: null, id }) need no handling.
  }

  /** Brings the socket's subscriptions in line with the desired set. */
  private reconcile(): void {
    if (!this.isOpen()) return;
    const add: string[] = [];
    const remove: string[] = [];
    for (const s of this.streams.keys()) if (!this.socketStreams.has(s)) add.push(s);
    for (const s of this.socketStreams) if (!this.streams.has(s)) remove.push(s);
    if (remove.length > 0) {
      for (const s of remove) this.socketStreams.delete(s);
      this.queueSend({ method: 'UNSUBSCRIBE', params: remove, id: this.requestId++ });
    }
    if (add.length > 0) {
      for (const s of add) this.socketStreams.add(s);
      this.queueSend({ method: 'SUBSCRIBE', params: add, id: this.requestId++ });
    }
  }

  private queueSend(message: object): void {
    this.outbox.push(JSON.stringify(message));
    this.flushOutbox();
  }

  private flushOutbox(): void {
    if (this.sendTimer !== null) return;
    const now = this.o.clock.now();
    if (now < this.nextSendAt) {
      this.sendTimer = this.o.clock.setTimeout(() => {
        this.sendTimer = null;
        this.flushOutbox();
      }, this.nextSendAt - now);
      return;
    }
    const next = this.outbox.shift();
    if (next === undefined || !this.isOpen() || !this.socket) return;
    this.socket.send(next);
    this.nextSendAt = now + this.o.sendSpacingMs;
    if (this.outbox.length > 0) this.flushOutbox();
  }

  // ---- lifecycle signals ------------------------------------------------------------------

  private readonly onOnline = (): void => {
    if (this.streams.size === 0) return;
    if (!this.socket) {
      this.attempt = 0;
      this.connect();
    }
  };

  private readonly onOffline = (): void => {
    if (this.streams.size > 0 && !this.isOpen()) this.setStatus('offline');
  };

  private readonly onVisibility = (): void => {
    if (this.documentEvents?.visibilityState === 'hidden' || this.streams.size === 0) return;
    if (!this.socket) {
      this.attempt = 0;
      this.connect();
      return;
    }
    // Mobile browsers often suspend backgrounded sockets without closing them.
    if (this.isOpen() && this.o.clock.now() - this.lastMessageAt > 10_000) this.restart();
  };

  // ---- helpers ------------------------------------------------------------------------------

  private setStatus(status: LiveStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const set of this.streams.values()) for (const entry of set) entry.sub.onStatus?.(status);
  }

  private clearTimer(name: 'reconnectTimer' | 'lingerTimer' | 'watchdogTimer' | 'sendTimer'): void {
    const id = this[name];
    if (id !== null) {
      this.o.clock.clearTimeout(id);
      this[name] = null;
    }
  }
}

function isOffline(events: LifecycleEvents | undefined): boolean {
  const nav = (events as { navigator?: { onLine?: boolean } } | undefined)?.navigator;
  return nav?.onLine === false;
}
