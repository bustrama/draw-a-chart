import { MemoryDocumentSource, type DocumentSource } from '../drawing/documents';
import type { StrokeProgress } from '../drawing/DrawingEngine';
import { chartKeyString } from '../drawing/model';
import type { MarketDataProvider } from '../market/types';
import { AuthStore } from '../sync/auth';
import { LocalDrawingDb } from '../sync/localDb';
import { PersistentDocuments } from '../sync/PersistentDocuments';
import { createSupabase, readSupabaseConfig, SupabaseRemote } from '../sync/supabaseRemote';
import { SyncEngine } from '../sync/SyncEngine';
import { createProvider } from './runtimeConfig';
import { Workspace, type MarketSelection } from './Workspace';

export interface Runtime {
  readonly provider: MarketDataProvider;
  readonly workspace: Workspace;
  readonly sync: SyncEngine | null;
  readonly auth: AuthStore;
  dispose(): void;
}

const PREVIEW_INTERVAL_MS = 90;
const PREVIEW_MAX_POINTS = 400;

/**
 * Builds the whole app runtime around a chart host element:
 * market data provider, local-first drawing persistence (IndexedDB), optional Supabase
 * sync/auth, live stroke previews, and the chart workspace.
 */
export function createRuntime(host: HTMLElement, market: MarketSelection): Runtime {
  const provider = createProvider();
  const supabaseConfig = readSupabaseConfig();
  const client = supabaseConfig ? createSupabase(supabaseConfig) : null;
  const auth = new AuthStore(client);

  let workspace: Workspace | null = null;
  let db: LocalDrawingDb | null = null;
  let persistent: PersistentDocuments | null = null;
  let sync: SyncEngine | null = null;
  let documents: DocumentSource;

  if (typeof indexedDB !== 'undefined') {
    db = new LocalDrawingDb();
    persistent = new PersistentDocuments(db, {
      currentOwner: () => sync?.currentUser ?? null,
      onLocalWrite: () => sync?.requestFlush(),
      onError: (err) => {
        console.error('[persistence]', err);
        sync?.reportError(err);
      },
    });
    documents = persistent;
    sync = new SyncEngine(
      db,
      persistent,
      client ? new SupabaseRemote(client) : null,
      { isOnline: () => navigator.onLine, windowEvents: window, documentEvents: document },
      {
        onPreview: (m) => {
          const ws = workspace;
          if (!ws || m.chart !== chartKeyString(ws.chartKey)) return;
          if (m.end) ws.engine.endRemotePreview(m.id, m.end);
          else ws.engine.setRemotePreview({ id: m.id, style: m.style, pts: m.pts, updatedAt: Date.now() });
        },
      },
    );
  } else {
    documents = new MemoryDocumentSource();
  }

  // Live previews of the stroke in progress: throttled, downsampled, built only when sent.
  let lastPreviewAt = 0;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  let latest: StrokeProgress | null = null;
  const send = (p: StrokeProgress, end: 'commit' | 'discard' | null) => {
    const ws = workspace;
    if (!sync || !ws) return;
    sync.sendPreview({ chart: chartKeyString(ws.chartKey), id: p.id, style: p.style, pts: end ? [] : downsample(p.points()), end });
  };

  workspace = new Workspace({
    host,
    provider,
    market,
    documents,
    engineHooks: {
      wantsProgress: () => sync?.previewsReady === true,
      onStrokeProgress: (progress, end) => {
        if (end) {
          if (trailing) clearTimeout(trailing);
          trailing = null;
          latest = null;
          send(progress, end);
          return;
        }
        latest = progress;
        const now = performance.now();
        if (now - lastPreviewAt >= PREVIEW_INTERVAL_MS) {
          lastPreviewAt = now;
          send(progress, null);
        } else if (!trailing) {
          trailing = setTimeout(() => {
            trailing = null;
            lastPreviewAt = performance.now();
            if (latest) send(latest, null);
          }, PREVIEW_INTERVAL_MS);
        }
      },
    },
  });
  const ws = workspace;

  const applyUser = () => sync?.setUser(auth.getState().user?.id ?? null);
  const unsubscribeAuth = auth.subscribe(applyUser);
  applyUser();

  let lastChart = '';
  const onWorkspace = () => {
    const key = chartKeyString(ws.chartKey);
    if (key !== lastChart) {
      lastChart = key;
      sync?.setActiveChart(ws.chartKey);
    }
  };
  const unsubscribeWorkspace = ws.subscribe(onWorkspace);
  onWorkspace();

  return {
    provider,
    workspace: ws,
    sync,
    auth,
    dispose() {
      if (trailing) clearTimeout(trailing);
      unsubscribeAuth();
      unsubscribeWorkspace();
      ws.dispose();
      provider.dispose?.();
      sync?.dispose();
      persistent?.dispose();
      auth.dispose();
      void db?.close();
      if (client) {
        void client.removeAllChannels();
        // A disposed runtime's client must not keep refreshing the session in the background.
        void client.auth.stopAutoRefresh();
      }
    },
  };
}

function downsample(pts: number[]): number[] {
  const n = pts.length / 3;
  if (n <= PREVIEW_MAX_POINTS) return pts;
  const step = n / PREVIEW_MAX_POINTS;
  const out: number[] = [];
  for (let i = 0; i < PREVIEW_MAX_POINTS; i++) {
    const k = Math.floor(i * step) * 3;
    out.push(pts[k], pts[k + 1], pts[k + 2]);
  }
  out.push(pts[pts.length - 3], pts[pts.length - 2], pts[pts.length - 1]);
  return out;
}
