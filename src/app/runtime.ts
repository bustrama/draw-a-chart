import { MemoryDocumentSource, type DocumentSource } from '../drawing/documents';
import type { StrokeProgress } from '../drawing/DrawingEngine';
import { chartKeyString } from '../drawing/model';
import type { MarketDataProvider } from '../market/types';
import { LocalDrawingDb } from '../sync/localDb';
import { PersistentDocuments } from '../sync/PersistentDocuments';
import { ServerRemote } from '../sync/serverRemote';
import { SyncSession } from '../sync/session';
import { SyncEngine } from '../sync/SyncEngine';
import { createProvider, readSyncServer } from './runtimeConfig';
import { Workspace, type MarketSelection } from './Workspace';

export interface Runtime {
  readonly provider: MarketDataProvider;
  readonly workspace: Workspace;
  readonly sync: SyncEngine | null;
  /** Identity on the sync server; null when sync is off. */
  readonly session: SyncSession | null;
  dispose(): void;
}

const PREVIEW_INTERVAL_MS = 90;
const PREVIEW_MAX_POINTS = 400;

/**
 * Builds the whole app runtime around a chart host element:
 * market data provider, local-first drawing persistence (IndexedDB), sync with the self-hosted
 * server (unless turned off), live stroke previews, and the chart workspace.
 */
export function createRuntime(host: HTMLElement, market: MarketSelection): Runtime {
  const provider = createProvider();
  const syncServer = readSyncServer();
  const remote = syncServer === null ? null : new ServerRemote(syncServer);
  const session = remote ? new SyncSession(remote) : null;

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
      remote,
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

  // Every device of the (single, for now) user syncs as soon as the server says who it is.
  const applyUser = () => sync?.setUser(session?.getState().userId ?? null);
  const unsubscribeSession = session?.subscribe(applyUser);
  applyUser();
  session?.start();
  const refreshSession = () => session?.refresh();
  window.addEventListener('online', refreshSession);

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
    session,
    dispose() {
      if (trailing) clearTimeout(trailing);
      window.removeEventListener('online', refreshSession);
      unsubscribeSession?.();
      unsubscribeWorkspace();
      ws.dispose();
      provider.dispose?.();
      sync?.dispose();
      persistent?.dispose();
      session?.dispose();
      remote?.dispose();
      void db?.close();
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
