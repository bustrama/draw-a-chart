import { chartKeyString, DRAWING_KINDS, type ChartKey } from '../drawing/model';
import { uuid } from '../lib/ids';
import { SERVER_GENERATION, type LocalDrawingDb, type OutboxEntry, type RemoteRow } from './localDb';
import type { PersistentDocuments } from './PersistentDocuments';
import type { ChangePayload, ChangeResult, ChannelStatus, PreviewMessage, RemoteApi } from './remote';

export type SyncState = 'local-only' | 'signed-out' | 'connecting' | 'syncing' | 'synced' | 'offline' | 'error';

export interface SyncStatus {
  readonly state: SyncState;
  /** Local changes not yet confirmed by the server (for the current user / signed-out edits). */
  readonly pending: number;
  readonly error: string | null;
  readonly lastSyncedAt: number | null;
}

export interface SyncEnv {
  isOnline(): boolean;
  /** window-like target for 'online'/'offline', document-like for 'visibilitychange'. */
  readonly windowEvents?: EventTarget;
  readonly documentEvents?: EventTarget & { readonly visibilityState?: string };
}

export interface SyncHooks {
  onPreview?(message: PreviewMessage): void;
}

const BATCH = 50;
const PAGE = 500;
/** Pull overlap: tolerates commit-order skew between transactions (rows are merged idempotently). */
const PULL_OVERLAP_MS = 120_000;

/**
 * Meta key of a chart's pull cursor. A version skips rows of drawing kinds it does not know, yet
 * moves its cursor past them, so each set of kinds keeps its own cursors: after an update that
 * adds a kind, the first pull of every chart is a full one, and a tab still running the older
 * version (same IndexedDB) cannot move the newer version's cursors. Every key starts with
 * `cursor:`, which a server generation change clears (`resetForServer`).
 */
export function pullCursorKey(user: string, key: ChartKey): string {
  return `cursor:${DRAWING_KINDS.join('+')}:${user}:${chartKeyString(key)}`;
}

/**
 * Local-first sync. The local database is the source of truth for the UI; this engine
 * (1) sends queued changes through the compare-and-swap RPC, (2) pulls rows changed on other
 * devices, (3) applies realtime row changes, and (4) relays ephemeral live previews.
 * Every step is idempotent, so retries after failures or reconnects are always safe.
 */
export class SyncEngine {
  private userId: string | null = null;
  private readonly inFlight = new Set<string>();
  private flushing: Promise<void> | null = null;
  private flushQueued = false;
  /** Last flush failed (network/server/invalid data): a successful pull must not hide that. */
  private flushError: string | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 2_000;
  private unsubscribeChanges: (() => void) | null = null;
  private previews: { send(m: PreviewMessage): void; readonly ready: boolean; close(): void } | null = null;
  private activeChart: ChartKey | null = null;
  private generationCheck: Promise<void> | null = null;
  private status: SyncStatus;
  private readonly listeners = new Set<() => void>();
  readonly deviceId = uuid();
  private disposed = false;
  private readonly db: LocalDrawingDb;
  private readonly docs: PersistentDocuments;
  private readonly remote: RemoteApi | null;
  private readonly env: SyncEnv;
  private readonly hooks: SyncHooks;

  constructor(db: LocalDrawingDb, docs: PersistentDocuments, remote: RemoteApi | null, env: SyncEnv, hooks: SyncHooks = {}) {
    this.db = db;
    this.docs = docs;
    this.remote = remote;
    this.env = env;
    this.hooks = hooks;
    this.status = { state: remote ? 'signed-out' : 'local-only', pending: 0, error: null, lastSyncedAt: null };
    env.windowEvents?.addEventListener('online', this.onOnline);
    env.windowEvents?.addEventListener('offline', this.onOffline);
    env.documentEvents?.addEventListener('visibilitychange', this.onVisibility);
    void this.refreshPending();
  }

  getStatus = (): SyncStatus => this.status;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Ids currently being sent. */
  getInFlight = (): ReadonlySet<string> => this.inFlight;

  get currentUser(): string | null {
    return this.userId;
  }

  /** Whether live previews can be sent right now (user known and the live connection open). */
  get previewsReady(): boolean {
    return this.previews?.ready === true;
  }

  setUser(userId: string | null): void {
    if (this.disposed || userId === this.userId) return;
    this.teardownUser();
    this.userId = userId;
    if (!this.remote) {
      this.patch({ state: 'local-only' });
      return;
    }
    if (!userId) {
      this.patch({ state: 'signed-out', error: null });
      void this.refreshPending();
      return;
    }
    this.patch({ state: 'connecting', error: null });
    this.unsubscribeChanges = this.remote.subscribeChanges(
      userId,
      (row) => void this.onRemoteRow(row),
      (status) => this.onChannelStatus(status),
    );
    this.previews =
      this.remote.subscribePreviews?.(userId, (m) => {
        if (m.device !== this.deviceId) this.hooks.onPreview?.(m);
      }) ?? null;
    void this.syncNow();
  }

  setActiveChart(key: ChartKey): void {
    this.activeChart = key;
    if (this.userId) void this.pull(key);
  }

  /** Local changes were written: send them soon (debounced to batch quick successive edits). */
  requestFlush(): void {
    if (!this.userId || !this.remote) {
      void this.refreshPending();
      return;
    }
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.flush();
    }, 250);
  }

  async syncNow(): Promise<void> {
    await this.flush();
    if (this.activeChart) await this.pull(this.activeChart);
  }

  sendPreview(message: Omit<PreviewMessage, 'device'>): void {
    if (this.previews?.ready) this.previews.send({ ...message, device: this.deviceId });
  }

  /** Surfaces a local persistence failure (e.g. storage unavailable) in the sync status. */
  reportError(err: unknown): void {
    this.patch({ state: 'error', error: `Local storage: ${errorMessage(err)}` });
  }

  dispose(): void {
    this.disposed = true;
    this.teardownUser();
    this.env.windowEvents?.removeEventListener('online', this.onOnline);
    this.env.windowEvents?.removeEventListener('offline', this.onOffline);
    this.env.documentEvents?.removeEventListener('visibilitychange', this.onVisibility);
    this.listeners.clear();
  }

  // ---- sending ---------------------------------------------------------------------------------

  flush(): Promise<void> {
    if (!this.remote || !this.userId || this.disposed) return Promise.resolve();
    if (this.flushing) {
      this.flushQueued = true;
      return this.flushing;
    }
    this.flushing = this.doFlush().finally(() => {
      this.flushing = null;
      if (this.flushQueued) {
        this.flushQueued = false;
        void this.flush();
      }
    });
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    const remote = this.remote;
    const user = this.userId;
    if (!remote || !user) return;
    let invalid = 0;
    let lastInvalid = '';
    let sent = 0;
    try {
      await this.ensureGeneration();
      for (let round = 0; round < 100; round++) {
        await this.docs.flushWrites();
        const batch = (await this.db.pendingFor(user, BATCH)).filter((e) => !this.inFlight.has(e.id));
        if (batch.length === 0) break;
        sent += batch.length;
        this.patch({ state: 'syncing' });
        for (const e of batch) this.inFlight.add(e.id);
        try {
          // Persist "sent" first: if the answer is lost, later edits carry these op ids along.
          await this.db.markSent(batch, user);
          const results: ChangeResult[] = await remote.applyChanges(batch.map(toPayload));
          if (this.userId !== user) return; // signed out meanwhile
          const byId = new Map(results.map((r) => [r.id, r]));
          for (const e of batch) {
            const r = byId.get(e.id);
            if (!r) continue;
            if (r.status === 'invalid') {
              invalid++;
              lastInvalid = r.error ?? 'rejected by the server';
            }
            this.docs.applyRemote(await this.db.acknowledge(e, r.status, r.row));
          }
        } finally {
          for (const e of batch) this.inFlight.delete(e.id);
        }
      }
      this.retryDelay = 2_000;
      if (invalid > 0) {
        this.flushError = `${invalid} drawing${invalid === 1 ? '' : 's'} could not be synced (${lastInvalid}); kept on this device`;
      } else if (sent > 0) {
        this.flushError = null; // a clean send clears an earlier problem; an empty flush does not
      }
      await this.refreshPending({ state: this.flushError ? 'error' : 'synced', error: this.flushError, lastSyncedAt: Date.now() });
    } catch (err) {
      this.flushError = errorMessage(err);
      await this.refreshPending({ state: this.env.isOnline() ? 'error' : 'offline', error: this.flushError });
      this.scheduleRetry();
    }
  }

  // ---- receiving -------------------------------------------------------------------------------

  private async pull(key: ChartKey): Promise<void> {
    const remote = this.remote;
    const user = this.userId;
    if (!remote || !user) return;
    const cursorKey = pullCursorKey(user, key);
    try {
      await this.ensureGeneration();
      let cursor = (await this.db.getMeta<string>(cursorKey)) ?? null;
      let since = cursor ? new Date(Date.parse(cursor) - PULL_OVERLAP_MS).toISOString() : null;
      for (let page = 0; page < 100; page++) {
        const rows = await remote.pull(key, since, PAGE);
        if (this.userId !== user) return;
        if (rows.length > 0) this.docs.applyRemote(await this.db.mergeRemote(rows));
        const last = rows[rows.length - 1]?.updated_at;
        if (last && (!cursor || last > cursor)) cursor = last;
        if (rows.length < PAGE || !last || last === since) break;
        since = last; // rows at exactly this timestamp are re-read; merging is idempotent
      }
      if (cursor) await this.db.setMeta(cursorKey, cursor);
      if (this.status.state !== 'syncing') {
        // A successful pull says nothing about sending: keep a flush error visible.
        await this.refreshPending({ state: this.flushError ? 'error' : 'synced', error: this.flushError, lastSyncedAt: Date.now() });
      }
    } catch (err) {
      await this.refreshPending({ state: this.env.isOnline() ? 'error' : 'offline', error: errorMessage(err) });
      this.scheduleRetry();
    }
  }

  private async onRemoteRow(row: RemoteRow): Promise<void> {
    try {
      this.docs.applyRemote(await this.db.mergeRemote([row]));
    } catch (err) {
      this.patch({ error: errorMessage(err) });
    }
  }

  private onChannelStatus(status: ChannelStatus): void {
    if (status === 'SUBSCRIBED') {
      // Postgres Changes has no replay: whatever happened while (re)joining must be pulled.
      void this.syncNow();
    } else if (this.userId) {
      this.patch({ state: this.env.isOnline() ? 'connecting' : 'offline' });
    }
  }

  // ---- server generation -----------------------------------------------------------------------

  /**
   * Before talking to the server: if its database is not the one this device last synced with
   * (restored from a backup, or replaced), requeue everything this device has (see
   * LocalDrawingDb.resetForServer). Memoized so concurrent flush and pull reset only once.
   */
  private ensureGeneration(): Promise<void> {
    this.generationCheck ??= this.checkGeneration().finally(() => (this.generationCheck = null));
    return this.generationCheck;
  }

  private async checkGeneration(): Promise<void> {
    const generation = this.remote?.generation;
    if (!generation || !this.userId) return; // not heard from the server yet
    const known = await this.db.getMeta<string>(SERVER_GENERATION);
    if (known === generation) return;
    if (known === undefined) {
      await this.db.setMeta(SERVER_GENERATION, generation); // first contact: nothing to reset
      return;
    }
    await this.db.resetForServer(generation, this.userId);
    await this.refreshPending();
  }

  // ---- lifecycle -------------------------------------------------------------------------------

  private readonly onOnline = (): void => {
    if (this.userId) void this.syncNow();
  };

  private readonly onOffline = (): void => {
    if (this.userId) this.patch({ state: 'offline' });
  };

  private readonly onVisibility = (): void => {
    if (this.env.documentEvents?.visibilityState !== 'hidden' && this.userId) void this.syncNow();
  };

  private scheduleRetry(): void {
    if (this.retryTimer || this.disposed) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(60_000, this.retryDelay * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.syncNow();
    }, delay);
  }

  private teardownUser(): void {
    this.unsubscribeChanges?.();
    this.unsubscribeChanges = null;
    this.previews?.close();
    this.previews = null;
    if (this.debounce) clearTimeout(this.debounce);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.debounce = null;
    this.retryTimer = null;
    this.retryDelay = 2_000;
    this.flushError = null;
    // Anything still marked in flight belongs to the previous session; its outbox entries stay
    // queued (with their op ids) and are retried idempotently later.
    this.inFlight.clear();
  }

  private async refreshPending(patch: Partial<SyncStatus> = {}): Promise<void> {
    let pending = this.status.pending;
    try {
      pending = await this.db.pendingCount(this.remote ? this.userId : undefined);
    } catch {
      // keep previous count
    }
    this.patch({ ...patch, pending });
  }

  private patch(patch: Partial<SyncStatus>): void {
    const next = { ...this.status, ...patch };
    if (
      next.state === this.status.state &&
      next.pending === this.status.pending &&
      next.error === this.status.error &&
      next.lastSyncedAt === this.status.lastSyncedAt
    ) {
      return;
    }
    this.status = next;
    for (const l of this.listeners) l();
  }
}

function toPayload(e: OutboxEntry): ChangePayload {
  return {
    id: e.id,
    op_id: e.opId,
    base_rev: e.baseRev,
    prev_op_ids: e.prevOpIds,
    provider: e.key.provider,
    symbol: e.key.symbol,
    timeframe: e.key.timeframe,
    kind: e.kind,
    data: e.drawing,
    deleted: e.deleted,
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}
