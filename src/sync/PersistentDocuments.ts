import type { DocumentSource } from '../drawing/documents';
import { chartKeyString, parseDrawing, type ChartKey } from '../drawing/model';
import { DrawingDocument, type Mutation } from '../drawing/store';
import type { LocalDrawingDb, RemoteChanges } from './localDb';

export interface PersistenceHooks {
  /** User the next local edits belong to (null while signed out). */
  currentOwner?(): string | null;
  /** A local change was durably written (sync should flush). */
  onLocalWrite?(key: ChartKey): void;
  onError?(err: unknown): void;
}

interface TabMessage {
  readonly chart: string;
  readonly mutations: readonly Mutation[];
}

/**
 * Drawing documents backed by IndexedDB. Local edits are written (with their outbox entry)
 * in the order they happen; loads never clobber strokes drawn before the load finished.
 *
 * Several tabs/windows (e.g. an installed PWA window plus a browser tab) share one database:
 * every change a tab persists or merges is announced on a BroadcastChannel so the others update
 * their open documents instead of silently diverging.
 */
export class PersistentDocuments implements DocumentSource {
  private readonly docs = new Map<string, DrawingDocument>();
  private readonly loads = new Map<string, Promise<void>>();
  private writes: Promise<void> = Promise.resolve();
  private readonly db: LocalDrawingDb;
  private readonly hooks: PersistenceHooks;
  private readonly channel: BroadcastChannel | null;

  constructor(db: LocalDrawingDb, hooks: PersistenceHooks = {}) {
    this.db = db;
    this.hooks = hooks;
    this.channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`dac-drawings:${db.name}`) : null;
    if (this.channel) this.channel.onmessage = (ev: MessageEvent<unknown>) => this.onTabMessage(ev.data);
  }

  open(key: ChartKey): DrawingDocument {
    const k = chartKeyString(key);
    const existing = this.docs.get(k);
    if (existing) return existing;
    const doc = new DrawingDocument(key);
    this.docs.set(k, doc);
    doc.store.subscribe((change) => {
      if (change.origin === 'local') this.enqueueWrite(key, change.mutations);
    });
    const load = this.db
      .loadChart(k)
      .then((drawings) => {
        // Only add what is not already there (the user may have drawn while loading).
        const puts: Mutation[] = drawings.filter((d) => !doc.store.get(d.id)).map((drawing) => ({ op: 'put', drawing }));
        doc.store.apply(puts, 'load');
      })
      .catch((err) => this.hooks.onError?.(err));
    this.loads.set(k, load);
    return doc;
  }

  whenLoaded(key: ChartKey): Promise<void> {
    return this.loads.get(chartKeyString(key)) ?? Promise.resolve();
  }

  /** Applies merged server changes to open documents and tells the other tabs. */
  applyRemote(changes: RemoteChanges): void {
    for (const [chart, mutations] of changes) {
      this.docs.get(chart)?.store.apply(mutations, 'remote');
      this.announce(chart, mutations);
    }
  }

  /** Resolves when every local edit so far has been written. */
  flushWrites(): Promise<void> {
    return this.writes;
  }

  dispose(): void {
    this.channel?.close();
  }

  private enqueueWrite(key: ChartKey, mutations: readonly Mutation[]): void {
    const owner = this.hooks.currentOwner?.() ?? null;
    this.writes = this.writes
      .then(() => this.db.applyLocal(key, mutations, owner))
      .then(() => {
        this.announce(chartKeyString(key), mutations);
        this.hooks.onLocalWrite?.(key);
      })
      .catch((err) => this.hooks.onError?.(err));
  }

  private announce(chart: string, mutations: readonly Mutation[]): void {
    if (!this.channel || mutations.length === 0) return;
    try {
      this.channel.postMessage({ chart, mutations } satisfies TabMessage);
    } catch (err) {
      this.hooks.onError?.(err);
    }
  }

  private onTabMessage(data: unknown): void {
    if (typeof data !== 'object' || data === null) return;
    const { chart, mutations } = data as Partial<TabMessage>;
    if (typeof chart !== 'string' || !Array.isArray(mutations)) return;
    const doc = this.docs.get(chart);
    if (!doc) return; // not open here; it will be loaded from IndexedDB when opened
    const valid: Mutation[] = [];
    for (const m of mutations as unknown[]) {
      const mm = m as { op?: unknown; id?: unknown; drawing?: unknown };
      if (mm.op === 'delete' && typeof mm.id === 'string') valid.push({ op: 'delete', id: mm.id });
      else if (mm.op === 'put') {
        const d = parseDrawing(mm.drawing);
        if (d) valid.push({ op: 'put', drawing: d });
      }
    }
    // Already persisted by the other tab: apply without writing or recording undo history.
    doc.store.apply(valid, 'remote');
  }
}
