import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ChartKey } from '../drawing/model';
import type { RemoteRow } from './localDb';
import type { ChangePayload, ChangeResult, ChannelStatus, PreviewMessage, RemoteApi } from './remote';

export interface SupabaseConfig {
  readonly url: string;
  readonly key: string;
}

/** Reads Supabase settings from Vite env; null when not configured (app runs local-only). */
export function readSupabaseConfig(): SupabaseConfig | null {
  const url = import.meta.env.VITE_SUPABASE_URL?.trim();
  const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY)?.trim();
  if (!url || !key) return null;
  return { url, key };
}

/**
 * One client per runtime. A shared per-page client is not safe here: realtime-js hands out an
 * existing channel for the same topic even while it is being torn down, so a runtime recreated
 * while signed in (e.g. by a dev-mode remount) could inherit a dying channel. In development,
 * React StrictMode creates a second runtime, so supabase-js logs "Multiple GoTrueClient
 * instances"; the disposed runtime stops its client's auto-refresh, leaving one active client.
 */
export function createSupabase(config: SupabaseConfig): SupabaseClient {
  return createClient(config.url, config.key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // Email + password only: no OAuth/magic-link redirects to parse (iOS Home Screen apps
      // have storage isolated from Safari, so redirect-based flows don't work there).
      detectSessionInUrl: false,
    },
  });
}

const COLUMNS = 'id, provider, symbol, timeframe, kind, data, deleted, rev, updated_at';

/** RemoteApi backed by Supabase: RPC for writes, PostgREST for pulls, Realtime for push. */
export class SupabaseRemote implements RemoteApi {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async applyChanges(changes: readonly ChangePayload[]): Promise<ChangeResult[]> {
    const { data, error } = await this.client.rpc('apply_drawing_changes', { changes });
    if (error) throw error;
    return (Array.isArray(data) ? data : []) as ChangeResult[];
  }

  async pull(key: ChartKey, since: string | null, limit: number): Promise<RemoteRow[]> {
    let query = this.client
      .from('drawings')
      .select(COLUMNS)
      .eq('provider', key.provider)
      .eq('symbol', key.symbol)
      .eq('timeframe', key.timeframe)
      .order('updated_at', { ascending: true })
      .limit(limit);
    if (since) query = query.gte('updated_at', since);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as RemoteRow[];
  }

  subscribeChanges(userId: string, onRow: (row: RemoteRow) => void, onStatus: (status: ChannelStatus) => void): () => void {
    const channel = this.client
      .channel(`drawings-changes:${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'drawings', filter: `user_id=eq.${userId}` }, (payload) => {
        const row = payload.new as Partial<RemoteRow> | undefined;
        if (row && typeof row.id === 'string' && typeof row.rev === 'number') onRow(row as RemoteRow);
      })
      .subscribe((status) => onStatus(status as ChannelStatus));
    return () => {
      void this.client.removeChannel(channel);
    };
  }

  subscribePreviews(userId: string, onMessage: (m: PreviewMessage) => void): { send(m: PreviewMessage): void; readonly ready: boolean; close(): void } {
    let joined = false;
    const channel = this.client
      .channel(`preview:${userId}`, { config: { private: true, broadcast: { self: false, ack: false } } })
      .on('broadcast', { event: 'stroke' }, ({ payload }) => onMessage(payload as PreviewMessage))
      .subscribe((status) => {
        joined = status === 'SUBSCRIBED';
      });
    return {
      get ready() {
        return joined;
      },
      send: (m) => {
        // Only over the socket: an unjoined channel would fall back to one HTTP request per send.
        if (joined) void channel.send({ type: 'broadcast', event: 'stroke', payload: m });
      },
      close: () => {
        joined = false;
        void this.client.removeChannel(channel);
      },
    };
  }
}
