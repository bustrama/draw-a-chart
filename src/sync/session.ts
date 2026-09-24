import type { SessionInfo } from './protocol';
import { SyncServerError } from './serverRemote';

/**
 * - unknown: never reached the server and nothing cached yet;
 * - ready: the user is known (from the server, or cached while it is unreachable);
 * - signed-out: the server refused (401/403); only possible once the server has sign-in;
 * - unreachable: never reached the server and nothing cached.
 */
export type SessionStatus = 'unknown' | 'ready' | 'signed-out' | 'unreachable';

export interface SessionState {
  readonly status: SessionStatus;
  readonly userId: string | null;
  /** Last problem reaching the server (kept while a cached identity is used). */
  readonly error: string | null;
}

interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const CACHE_KEY = 'dac-sync-user';
const MAX_RETRY_MS = 60_000;

/**
 * Who this device is on the sync server. The server has no sign-in today and answers with its
 * single user; the answer is cached, so a start without the server (offline, server down) still
 * attributes queued edits to that user and sends them once it is reachable.
 */
export class SyncSession {
  private state: SessionState;
  private readonly listeners = new Set<() => void>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 2_000;
  private checking = false;
  private disposed = false;
  private readonly source: { session(): Promise<SessionInfo> };
  private readonly storage: KeyValueStore | null;

  constructor(source: { session(): Promise<SessionInfo> }, storage: KeyValueStore | null = browserStorage()) {
    this.source = source;
    this.storage = storage;
    const cached = read(storage);
    this.state = { status: cached ? 'ready' : 'unknown', userId: cached, error: null };
  }

  getState = (): SessionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    void this.check();
  }

  /** Ask again now (e.g. the network came back), instead of waiting for the next retry. */
  refresh(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryDelay = 2_000;
    void this.check();
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.listeners.clear();
  }

  private async check(): Promise<void> {
    if (this.checking || this.disposed) return;
    this.checking = true;
    try {
      const info = await this.source.session();
      if (this.disposed) return;
      this.retryDelay = 2_000;
      write(this.storage, info.user.id);
      this.patch({ status: 'ready', userId: info.user.id, error: null });
    } catch (err) {
      if (this.disposed) return;
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof SyncServerError && (err.status === 401 || err.status === 403)) {
        write(this.storage, null);
        this.patch({ status: 'signed-out', userId: null, error: message });
        return;
      }
      this.patch({ status: this.state.userId ? 'ready' : 'unreachable', error: message });
      this.scheduleRetry();
    } finally {
      this.checking = false;
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.disposed) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(MAX_RETRY_MS, this.retryDelay * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.check();
    }, delay);
  }

  private patch(p: Partial<SessionState>): void {
    const next = { ...this.state, ...p };
    if (next.status === this.state.status && next.userId === this.state.userId && next.error === this.state.error) return;
    this.state = next;
    for (const l of [...this.listeners]) l();
  }
}

function browserStorage(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // storage blocked (e.g. some private modes)
  }
}

function read(storage: KeyValueStore | null): string | null {
  try {
    return storage?.getItem(CACHE_KEY) ?? null;
  } catch {
    return null;
  }
}

function write(storage: KeyValueStore | null, userId: string | null): void {
  try {
    if (userId) storage?.setItem(CACHE_KEY, userId);
    else storage?.removeItem(CACHE_KEY);
  } catch {
    // cache only
  }
}
