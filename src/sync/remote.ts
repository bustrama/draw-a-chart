import type { ChartKey, StrokeStyle } from '../drawing/model';
import type { RemoteRow } from './localDb';

/** One change sent to `apply_drawing_changes` (see supabase/migrations). */
export interface ChangePayload {
  readonly id: string;
  readonly op_id: string;
  readonly base_rev: number;
  /** Earlier op ids of this client for the drawing that were sent but never acknowledged. */
  readonly prev_op_ids: readonly string[];
  readonly provider: string;
  readonly symbol: string;
  readonly timeframe: string;
  readonly kind: string;
  readonly data: unknown;
  readonly deleted: boolean;
}

export type ChangeStatus = 'applied' | 'duplicate' | 'conflict' | 'rejected' | 'invalid';

export interface ChangeResult {
  readonly id: string;
  readonly status: ChangeStatus;
  readonly row: RemoteRow | null;
  /** Server-side reason for 'invalid'. */
  readonly error?: string;
}

export type ChannelStatus = 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR';

/** Ephemeral live preview of a stroke in progress on another device. */
export interface PreviewMessage {
  readonly chart: string;
  readonly id: string;
  readonly style: StrokeStyle;
  /** [time, price, pressure] triples. Empty when `end` is set. */
  readonly pts: readonly number[];
  /**
   * 'commit': the stroke was committed (keep the ghost until the durable drawing arrives);
   * 'discard': the stroke was abandoned (remove the ghost now); null while drawing.
   */
  readonly end: 'commit' | 'discard' | null;
  readonly device: string;
}

/** Everything the sync engine needs from the backend (Supabase implements it; tests fake it). */
export interface RemoteApi {
  applyChanges(changes: readonly ChangePayload[]): Promise<ChangeResult[]>;
  /** Rows of one chart with updated_at > since (ISO), ascending, at most `limit`. */
  pull(key: ChartKey, since: string | null, limit: number): Promise<RemoteRow[]>;
  /** Durable change feed for the user's rows. Returns an unsubscribe function. */
  subscribeChanges(userId: string, onRow: (row: RemoteRow) => void, onStatus: (status: ChannelStatus) => void): () => void;
  /** Ephemeral preview channel. `send` is a no-op until the channel is joined. */
  subscribePreviews?(userId: string, onMessage: (m: PreviewMessage) => void): { send(m: PreviewMessage): void; readonly ready: boolean; close(): void };
}
