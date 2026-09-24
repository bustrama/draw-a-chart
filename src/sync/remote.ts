import type { ChartKey } from '../drawing/model';
import type { ChangePayload, ChangeResult, PreviewMessage, RemoteRow } from './protocol';

export type { ChangePayload, ChangeResult, ChangeStatus, PreviewMessage, RemoteRow } from './protocol';

export type ChannelStatus = 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR';

/** Everything the sync engine needs from the backend (the sync server implements it; tests fake it). */
export interface RemoteApi {
  /**
   * The server database's generation as last reported (null = not known yet). When it differs
   * from the one this device last synced with, the server was restored or replaced.
   */
  readonly generation?: string | null;
  applyChanges(changes: readonly ChangePayload[]): Promise<ChangeResult[]>;
  /** Rows of one chart with updated_at >= since (ISO), ascending, at most `limit`. */
  pull(key: ChartKey, since: string | null, limit: number): Promise<RemoteRow[]>;
  /** Durable change feed for the user's rows. Returns an unsubscribe function. */
  subscribeChanges(userId: string, onRow: (row: RemoteRow) => void, onStatus: (status: ChannelStatus) => void): () => void;
  /** Ephemeral preview channel. `send` is a no-op until the channel is connected. */
  subscribePreviews?(userId: string, onMessage: (m: PreviewMessage) => void): { send(m: PreviewMessage): void; readonly ready: boolean; close(): void };
}
