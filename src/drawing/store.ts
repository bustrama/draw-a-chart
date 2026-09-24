import { compareDrawings, type ChartKey, type Drawing } from './model';

export type Mutation = { readonly op: 'put'; readonly drawing: Drawing } | { readonly op: 'delete'; readonly id: string };

/** Who caused a change: the local user, a synced remote device, or an initial load. */
export type ChangeOrigin = 'local' | 'remote' | 'load';

export interface StoreChange {
  readonly origin: ChangeOrigin;
  /** Effective mutations only (no-ops are dropped). */
  readonly mutations: readonly Mutation[];
}

type Listener = (change: StoreChange) => void;

/** The drawings of one chart (provider + symbol + timeframe). */
export class DrawingStore {
  private readonly items = new Map<string, Drawing>();
  private sorted: Drawing[] | null = null;
  private rev = 0;
  private readonly listeners = new Set<Listener>();

  get version(): number {
    return this.rev;
  }

  get size(): number {
    return this.items.size;
  }

  get(id: string): Drawing | undefined {
    return this.items.get(id);
  }

  /** All drawings in paint order. The returned array is replaced (never mutated) on change. */
  all(): readonly Drawing[] {
    if (!this.sorted) this.sorted = [...this.items.values()].sort(compareDrawings);
    return this.sorted;
  }

  apply(mutations: readonly Mutation[], origin: ChangeOrigin): Mutation[] {
    const effective: Mutation[] = [];
    for (const m of mutations) {
      if (m.op === 'put') {
        if (this.items.get(m.drawing.id) === m.drawing) continue;
        this.items.set(m.drawing.id, m.drawing);
        effective.push(m);
      } else if (this.items.delete(m.id)) {
        effective.push(m);
      }
    }
    if (effective.length > 0) this.changed({ origin, mutations: effective });
    return effective;
  }

  /** Replaces the whole content (initial load); emits the difference. */
  replaceAll(drawings: readonly Drawing[], origin: ChangeOrigin = 'load'): void {
    const next = new Map(drawings.map((d) => [d.id, d]));
    const mutations: Mutation[] = [];
    for (const id of this.items.keys()) if (!next.has(id)) mutations.push({ op: 'delete', id });
    for (const d of drawings) if (this.items.get(d.id) !== d) mutations.push({ op: 'put', drawing: d });
    this.items.clear();
    for (const [id, d] of next) this.items.set(id, d);
    this.changed({ origin, mutations });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(change: StoreChange): void {
    this.sorted = null;
    this.rev++;
    for (const l of this.listeners) l(change);
  }
}

export interface Command {
  readonly label: string;
  readonly forward: readonly Mutation[];
  readonly backward: readonly Mutation[];
}

/** Undo/redo stacks of local commands. Remote changes are never recorded. */
export class History {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private readonly limit: number;

  constructor(limit = 300) {
    this.limit = limit;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  push(cmd: Command): void {
    this.undoStack.push(cmd);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  takeUndo(): Command | undefined {
    const cmd = this.undoStack.pop();
    if (cmd) this.redoStack.push(cmd);
    return cmd;
  }

  takeRedo(): Command | undefined {
    const cmd = this.redoStack.pop();
    if (cmd) this.undoStack.push(cmd);
    return cmd;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}

/** Store + history for one chart. All local edits go through `commit` so they are undoable. */
export class DrawingDocument {
  readonly key: ChartKey;
  readonly store = new DrawingStore();
  readonly history = new History();

  constructor(key: ChartKey) {
    this.key = key;
  }

  commit(label: string, forward: readonly Mutation[]): boolean {
    const backward = invert(this.store, forward);
    const applied = this.store.apply(forward, 'local');
    if (applied.length === 0) return false;
    this.history.push({ label, forward, backward });
    return true;
  }

  undo(): boolean {
    const cmd = this.history.takeUndo();
    if (!cmd) return false;
    this.store.apply(cmd.backward, 'local');
    return true;
  }

  redo(): boolean {
    const cmd = this.history.takeRedo();
    if (!cmd) return false;
    this.store.apply(cmd.forward, 'local');
    return true;
  }
}

/** Mutations that undo `forward` when applied to the store's current (pre-forward) state. */
export function invert(store: DrawingStore, forward: readonly Mutation[]): Mutation[] {
  const backward: Mutation[] = [];
  const seen = new Map<string, Drawing | undefined>();
  const before = (id: string): Drawing | undefined => (seen.has(id) ? seen.get(id) : store.get(id));
  for (const m of forward) {
    const id = m.op === 'put' ? m.drawing.id : m.id;
    const prev = before(id);
    if (m.op === 'put') {
      backward.push(prev ? { op: 'put', drawing: prev } : { op: 'delete', id });
      seen.set(id, m.drawing);
    } else {
      if (prev) backward.push({ op: 'put', drawing: prev });
      seen.set(id, undefined);
    }
  }
  return backward.reverse();
}
