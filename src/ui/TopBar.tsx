import type { ReactNode } from 'react';
import type { LiveStatus, SymbolInfo, TimeframeId } from '../market/types';
import { TIMEFRAMES } from '../market/timeframes';

interface TopBarProps {
  readonly symbols: readonly SymbolInfo[];
  readonly symbol: string;
  readonly timeframe: TimeframeId;
  readonly live: LiveStatus;
  readonly loading: boolean;
  readonly onSymbol: (symbol: string) => void;
  readonly onTimeframe: (tf: TimeframeId) => void;
  readonly right?: ReactNode;
}

const LIVE_LABEL: Record<LiveStatus, { text: string; color: string }> = {
  idle: { text: 'Idle', color: 'bg-ink-400' },
  connecting: { text: 'Connecting', color: 'bg-amber-400' },
  live: { text: 'Live', color: 'bg-up' },
  reconnecting: { text: 'Reconnecting', color: 'bg-amber-400' },
  offline: { text: 'Offline', color: 'bg-down' },
  error: { text: 'Error', color: 'bg-down' },
};

export function TopBar(props: TopBarProps) {
  const live = LIVE_LABEL[props.live];
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-ink-800 bg-ink-900 pr-[max(0.5rem,env(safe-area-inset-right))] pl-[max(0.5rem,env(safe-area-inset-left))] text-sm">
      <label className="relative shrink-0">
        <span className="sr-only">Symbol</span>
        <select
          className="ui-control h-8 appearance-none rounded-md border border-ink-700 bg-ink-850 pr-7 pl-2.5 font-semibold tracking-wide text-ink-100"
          value={props.symbol}
          onChange={(e) => {
            props.onSymbol(e.target.value);
            e.target.blur(); // return keyboard shortcuts to the app
          }}
          data-testid="symbol-select"
        >
          {props.symbols.map((s) => (
            <option key={s.symbol} value={s.symbol}>
              {s.base}/{s.quote}
            </option>
          ))}
        </select>
        <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[10px] text-ink-400">▼</span>
      </label>

      <nav className="scrollbar-none flex h-8 min-w-0 shrink items-center overflow-x-auto rounded-md border border-ink-700 bg-ink-850 p-0.5" aria-label="Timeframe">
        {TIMEFRAMES.map((tf) => {
          const active = tf.id === props.timeframe;
          return (
            <button
              key={tf.id}
              type="button"
              className={`ui-control h-full min-w-9 shrink-0 rounded px-1.5 text-[13px] tabular-nums transition-colors ${
                active ? 'bg-ink-700 font-semibold text-ink-100' : 'text-ink-300 hover:text-ink-100'
              }`}
              aria-pressed={active}
              onClick={() => props.onTimeframe(tf.id)}
              data-testid={`tf-${tf.id}`}
            >
              {tf.label}
            </button>
          );
        })}
      </nav>

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <span className="flex items-center gap-1.5 px-1.5 text-xs text-ink-300" data-testid="live-status" data-status={props.live}>
          <span className={`inline-block h-2 w-2 rounded-full ${live.color} ${props.loading ? 'animate-pulse' : ''}`} />
          <span className="hidden sm:inline">{props.loading ? 'Loading' : live.text}</span>
        </span>
        {props.right}
      </div>
    </header>
  );
}
