import type { ChartKey } from '../../drawing/model';
import type { RemoteRow } from '../localDb';
import type { ChangePayload, ChangeResult, ChannelStatus, PreviewMessage, RemoteApi } from '../remote';

interface Row extends RemoteRow {
  readonly user_id: string;
  readonly last_op_id: string;
}

/** Same limit as the server (server/validate.ts LIMITS.maxDataBytes). */
const MAX_DATA_BYTES = 262_144;

/**
 * In-memory stand-in for the sync server with the same write semantics as server/store.ts, plus
 * failure injection (network down, lost responses, requests held in flight).
 */
export class FakeBackend {
  readonly rows = new Map<string, Row>();
  /** The database generation (changes on replace/restore, like server/restore.ts). */
  generation = 'gen-1';
  private generations = 1;
  /** Next N applyChanges calls fail before touching data (network down). */
  failCalls = 0;
  /** Next N applyChanges calls apply the changes but the response is lost. */
  loseResponses = 0;
  calls = 0;
  /** When set, applyChanges waits for this promise before processing (holds a request in flight). */
  gate: Promise<void> | null = null;
  private tick = 0;
  private readonly changeSubs = new Set<{ userId: string; onRow(row: RemoteRow): void }>();
  private readonly previewSubs = new Set<{ userId: string; onMessage(m: PreviewMessage): void }>();

  /** A new, empty database (e.g. the server's volume was lost). */
  replace(): void {
    this.rows.clear();
    this.generation = `gen-${++this.generations}`;
  }

  snapshot(): Map<string, Row> {
    return new Map(this.rows);
  }

  /** Back to a snapshot, as server/restore.ts does with a backup: new generation. */
  restore(snapshot: Map<string, Row>): void {
    this.rows.clear();
    for (const [id, row] of snapshot) this.rows.set(id, row);
    this.generation = `gen-${++this.generations}`;
  }

  api(userId: string): RemoteApi {
    const currentGeneration = () => this.generation;
    return {
      get generation() {
        return currentGeneration();
      },
      applyChanges: async (changes) => {
        if (this.gate) await this.gate;
        return this.applyChanges(userId, changes);
      },
      pull: async (key, since, limit) => this.pull(userId, key, since, limit),
      subscribeChanges: (uid, onRow, onStatus) => {
        const sub = { userId: uid, onRow };
        this.changeSubs.add(sub);
        setTimeout(() => onStatus('SUBSCRIBED' as ChannelStatus), 0);
        return () => this.changeSubs.delete(sub);
      },
      subscribePreviews: (uid, onMessage) => {
        const sub = { userId: uid, onMessage };
        this.previewSubs.add(sub);
        return {
          ready: true,
          send: (m) => {
            for (const s of this.previewSubs) if (s.userId === uid) setTimeout(() => s.onMessage(m), 0);
          },
          close: () => this.previewSubs.delete(sub),
        };
      },
    };
  }

  private applyChanges(userId: string, changes: readonly ChangePayload[]): ChangeResult[] {
    this.calls++;
    if (this.failCalls > 0) {
      this.failCalls--;
      throw new Error('network error');
    }
    const results: ChangeResult[] = [];
    const changed: Row[] = [];
    for (const c of changes) {
      if (JSON.stringify(c.data ?? {}).length >= MAX_DATA_BYTES) {
        results.push({ id: c.id, status: 'invalid', row: null, error: 'violates check constraint "drawings_data_check"' });
        continue;
      }
      const cur = this.rows.get(c.id);
      if (!cur) {
        const row: Row = {
          id: c.id,
          user_id: userId,
          provider: c.provider,
          symbol: c.symbol,
          timeframe: c.timeframe,
          kind: c.kind,
          data: c.data ?? {},
          deleted: c.deleted,
          rev: 1,
          last_op_id: c.op_id,
          updated_at: this.now(),
        };
        this.rows.set(c.id, row);
        changed.push(row);
        results.push({ id: c.id, status: 'applied', row: publicRow(row) });
      } else if (cur.user_id !== userId) {
        results.push({ id: c.id, status: 'rejected', row: null });
      } else if (cur.last_op_id === c.op_id) {
        results.push({ id: c.id, status: 'duplicate', row: publicRow(cur) });
      } else if (cur.rev === c.base_rev || c.prev_op_ids.includes(cur.last_op_id)) {
        const row: Row = {
          ...cur,
          kind: c.kind ?? cur.kind,
          data: c.deleted ? cur.data : (c.data ?? cur.data),
          deleted: c.deleted,
          rev: cur.rev + 1,
          last_op_id: c.op_id,
          updated_at: this.now(),
        };
        this.rows.set(c.id, row);
        changed.push(row);
        results.push({ id: c.id, status: 'applied', row: publicRow(row) });
      } else {
        results.push({ id: c.id, status: 'conflict', row: publicRow(cur) });
      }
    }
    for (const row of changed) {
      for (const s of this.changeSubs) if (s.userId === row.user_id) setTimeout(() => s.onRow(publicRow(row)), 0);
    }
    if (this.loseResponses > 0) {
      this.loseResponses--;
      throw new Error('response lost');
    }
    return results;
  }

  private pull(userId: string, key: ChartKey, since: string | null, limit: number): RemoteRow[] {
    return [...this.rows.values()]
      .filter((r) => r.user_id === userId && r.provider === key.provider && r.symbol === key.symbol && r.timeframe === key.timeframe)
      .filter((r) => since === null || r.updated_at >= since)
      .sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0))
      .slice(0, limit)
      .map(publicRow);
  }

  private now(): string {
    return new Date(Date.UTC(2026, 0, 1) + ++this.tick * 1000).toISOString();
  }
}

function publicRow(r: Row): RemoteRow {
  return {
    id: r.id,
    provider: r.provider,
    symbol: r.symbol,
    timeframe: r.timeframe,
    kind: r.kind,
    data: r.data,
    deleted: r.deleted,
    rev: r.rev,
    updated_at: r.updated_at,
  };
}
