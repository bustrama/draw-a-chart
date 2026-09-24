import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRuntime, type Runtime } from './app/runtime';
import { exposeTestHooks, loadMarket, saveMarket } from './app/runtimeConfig';
import type { MarketSelection, Workspace } from './app/Workspace';
import type { EngineState } from './drawing/DrawingEngine';
import { ScreenshotButton } from './ui/ScreenshotButton';
import { SyncButton } from './ui/SyncButton';
import { Toolbar } from './ui/Toolbar';
import { TopBar } from './ui/TopBar';
import { UpdatePrompt } from './ui/UpdatePrompt';

declare global {
  interface Window {
    __dac?: Workspace;
    __dacRuntime?: Runtime;
  }
}

const IDLE_ENGINE: EngineState = {
  tool: 'pen',
  color: '#ffd166',
  width: 2.5,
  mouseDraw: false,
  handwriting: true,
  canUndo: false,
  canRedo: false,
  selectionCount: 0,
  strokeActive: false,
  drawingCount: 0,
};

const noopSubscribe = () => () => undefined;

export default function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [market, setMarket] = useState<MarketSelection>(() => loadMarket());
  const initialMarket = useRef(market);
  const finePointer = useMemo(() => typeof matchMedia !== 'undefined' && matchMedia('(any-pointer: fine)').matches, []);
  const workspace = runtime?.workspace ?? null;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // One lifecycle for provider, persistence, sync and chart (StrictMode mounts twice in dev).
    const rt = createRuntime(host, initialMarket.current);
    setRuntime(rt);
    if (exposeTestHooks()) {
      window.__dac = rt.workspace;
      window.__dacRuntime = rt;
    }
    return () => {
      if (window.__dacRuntime === rt) {
        delete window.__dac;
        delete window.__dacRuntime;
      }
      rt.dispose();
      setRuntime(null);
    };
  }, []);

  useEffect(() => {
    workspace?.setMarket(market);
    saveMarket(market);
  }, [workspace, market]);

  const engine = workspace?.engine;
  const state = useSyncExternalStore(engine?.subscribe ?? noopSubscribe, engine?.getState ?? (() => IDLE_ENGINE));
  const status = useSyncExternalStore(workspace?.subscribe ?? noopSubscribe, workspace?.getStatus ?? (() => null));

  useKeyboardShortcuts(workspace);

  const feed = status?.feed;
  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-ink-950 pt-[env(safe-area-inset-top)]">
      <TopBar
        symbols={runtime?.provider.symbols() ?? []}
        symbol={market.symbol}
        timeframe={market.timeframe}
        live={feed?.live ?? 'idle'}
        loading={!feed?.initialLoaded}
        onSymbol={(symbol) => setMarket((m) => ({ ...m, symbol }))}
        onTimeframe={(timeframe) => setMarket((m) => ({ ...m, timeframe }))}
        right={
          <>
            <ScreenshotButton workspace={workspace} />
            <SyncButton sync={runtime?.sync ?? null} session={runtime?.session ?? null} />
          </>
        }
      />
      <div className="flex min-h-0 flex-1 portrait:flex-col-reverse">
        <Toolbar
          state={state}
          finePointer={finePointer}
          onTool={(t) => engine?.setTool(t)}
          onColor={(c) => engine?.setColor(c)}
          onWidth={(w) => engine?.setWidth(w)}
          onUndo={() => engine?.undo()}
          onRedo={() => engine?.redo()}
          onDelete={() => engine?.deleteSelection()}
          onMouseDraw={(on) => engine?.setMouseDraw(on)}
          onHandwriting={(on) => engine?.setHandwriting(on)}
          onResetView={() => workspace?.chart.resetView()}
        />
        <main className="relative min-h-0 min-w-0 flex-1">
          <div
            ref={hostRef}
            className={`chart-host absolute inset-0 ${state.mouseDraw ? 'cursor-crosshair' : ''}`}
            data-testid="chart-host"
          />
          {feed?.error && !feed.initialLoaded && (
            <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
              <div className="rounded-md border border-down/40 bg-ink-900/95 px-3 py-1.5 text-xs text-ink-200">
                Market data unavailable: {feed.error}. Retrying…
              </div>
            </div>
          )}
          <UpdatePrompt />
        </main>
      </div>
    </div>
  );
}

function useKeyboardShortcuts(workspace: Workspace | null) {
  useEffect(() => {
    if (!workspace) return;
    const { engine, router } = workspace;
    const isTextEntry = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTextEntry(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      // A focused <select> keeps its own letter/arrow navigation but not app shortcuts with modifiers.
      if (!mod && e.target instanceof HTMLSelectElement) return;
      if (mod && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) engine.redo();
        else engine.undo();
      } else if (mod && key === 'y') {
        e.preventDefault();
        engine.redo();
      } else if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        engine.deleteSelection();
      } else if (e.key === 'Escape') {
        engine.clearSelection();
      } else if (!mod && !e.altKey) {
        if (key === 'p') engine.setTool('pen');
        else if (key === 'e') engine.setTool('eraser');
        else if (key === 's' || key === 'v') engine.setTool('select');
        else if (key === 'd') engine.setMouseDraw(!engine.getState().mouseDraw);
        else if (e.code === 'Space') {
          e.preventDefault();
          router.setTemporaryNavigate(true);
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') router.setTemporaryNavigate(false);
    };
    // A key-up missed while the window was in the background must not leave Space "held".
    const onBlur = () => router.setTemporaryNavigate(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [workspace]);
}
