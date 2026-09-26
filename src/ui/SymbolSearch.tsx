import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { loadRecent, MARKET_LABELS } from '../app/runtimeConfig';
import type { MarketRegistry, SymbolMatch } from '../market/registry';
import type { SymbolInfo } from '../market/types';
import { Popover } from './Popover';

export interface SymbolChoice {
  readonly market: string;
  readonly symbol: string;
}

interface Props {
  readonly markets: MarketRegistry | null;
  readonly market: string;
  readonly symbol: string;
  /** Details of the charted symbol once loaded (pair/name, data delay). */
  readonly info: SymbolInfo | null;
  readonly onSelect: (choice: SymbolChoice) => void;
}

/** Offered when nothing is typed, after the recently charted symbols. */
const SUGGESTED: readonly SymbolChoice[] = [
  { market: 'binance', symbol: 'BTCUSDT' },
  { market: 'binance', symbol: 'ETHUSDT' },
  { market: 'futures', symbol: 'ES' },
  { market: 'futures', symbol: 'NQ' },
  { market: 'us', symbol: 'SPY' },
  { market: 'us', symbol: 'QQQ' },
  { market: 'us', symbol: 'AAPL' },
  { market: 'us', symbol: 'NVDA' },
];

const SEARCH_DELAY_MS = 150;

/** Symbol button for the top bar; opens a search across all markets. */
export function SymbolSearch({ markets, market, symbol, info, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const pair = info && info.quote && info.base !== info.symbol ? `${info.base}/${info.quote}` : symbol;
  const marketLabel = MARKET_LABELS[market] ?? market;
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={!markets}
        title={info?.name ? `${info.name} · ${marketLabel}` : marketLabel}
        aria-label={`Symbol ${symbol} (${marketLabel}). Change symbol`}
        aria-expanded={open}
        data-testid="symbol-select"
        className={`ui-control flex h-8 items-center gap-1.5 rounded-md border border-ink-700 bg-ink-850 pr-2 pl-2.5 ${open ? 'bg-ink-700' : 'hover:bg-ink-800'}`}
      >
        <span className="font-semibold tracking-wide text-ink-100">{pair}</span>
        <span className="hidden text-[11px] text-ink-400 sm:inline">{market === 'us' ? 'US' : marketLabel}</span>
        <span className="text-[10px] text-ink-400">▼</span>
      </button>
      {open && markets && (
        <SearchPanel
          markets={markets}
          onClose={() => setOpen(false)}
          onSelect={(choice) => {
            setOpen(false);
            onSelect(choice);
          }}
        />
      )}
    </div>
  );
}

function SearchPanel({ markets, onClose, onSelect }: { markets: MarketRegistry; onClose: () => void; onSelect: (c: SymbolChoice) => void }) {
  const [query, setQuery] = useState('');
  /** The answer to the last query searched (results for a query still being typed are not shown). */
  const [found, setFound] = useState<{ query: string; results: SymbolMatch[]; failed: boolean } | null>(null);
  const [active, setActive] = useState(0);
  const q = query.trim();
  const inputRef = useRef<HTMLInputElement>(null);

  // Nothing typed: recently charted symbols, then suggestions, for the markets available here.
  const idle = useMemo<SymbolMatch[]>(() => {
    const seen = new Set<string>();
    const out: SymbolMatch[] = [];
    for (const c of [...loadRecent(), ...SUGGESTED]) {
      const key = `${c.market}:${c.symbol}`;
      if (seen.has(key) || !markets.available(c.market)) continue;
      seen.add(key);
      out.push({ market: c.market, symbol: c.symbol, name: '', detail: MARKET_LABELS[c.market] ?? c.market });
    }
    return out;
  }, [markets]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!q) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      markets.search(q, abort.signal).then(
        (results) => {
          if (!abort.signal.aborted) setFound({ query: q, results, failed: false });
        },
        () => {
          if (!abort.signal.aborted) setFound({ query: q, results: [], failed: true });
        },
      );
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [q, markets]);

  const current = q && found?.query === q ? found : null;
  const results = current?.results ?? null;
  const searching = q !== '' && !current;
  const list = results ?? (q ? [] : idle);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(list.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      const pick = list[active];
      if (pick) onSelect({ market: pick.market, symbol: pick.symbol });
    }
  };

  return (
    <Popover onClose={onClose} align="left" className="w-80" testId="symbol-search">
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        placeholder="Search: BTC, ES, AAPL…"
        aria-label="Search symbols"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        className="ui-control h-9 w-full rounded-md border border-ink-700 bg-ink-950 px-2.5 text-ink-100 placeholder:text-ink-400"
        data-testid="symbol-search-input"
      />
      <div className="mt-1.5 max-h-[min(60vh,22rem)] overflow-y-auto" role="listbox" aria-label="Symbols">
        {!results && list.length > 0 && <div className="px-2 pt-1 pb-0.5 text-[11px] tracking-wide text-ink-400 uppercase">Recent and suggested</div>}
        {list.map((r, i) => (
          <button
            key={`${r.market}:${r.symbol}`}
            type="button"
            role="option"
            aria-selected={i === active}
            onPointerEnter={() => setActive(i)}
            onClick={() => onSelect({ market: r.market, symbol: r.symbol })}
            data-testid={`symbol-option-${r.market}-${r.symbol}`}
            className={`ui-control flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left ${i === active ? 'bg-ink-700' : ''}`}
          >
            <span className="shrink-0 font-semibold text-ink-100">{r.symbol}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-ink-300">{r.name}</span>
            <span className="shrink-0 text-[11px] text-ink-400">{r.detail}</span>
          </button>
        ))}
        {current && results?.length === 0 && (
          <div className="px-2 py-3 text-xs text-ink-300">{current.failed ? 'Search is unavailable right now.' : `No symbols match “${q}”.`}</div>
        )}
        {searching && <div className="px-2 py-3 text-xs text-ink-400">Searching…</div>}
      </div>
    </Popover>
  );
}
