import { BinanceProvider } from '../market/binance/provider';
import { MOCK_FUTURES_SYMBOLS, MOCK_STOCK_SYMBOLS, mockFuturesCalendar, MockProvider, mockUsCalendar } from '../market/mock/MockProvider';
import { ServerMarketRegistry, StaticMarketRegistry, type MarketRegistry } from '../market/registry';
import { MarketApi } from '../market/server/marketApi';
import { ServerMarketProvider } from '../market/server/ServerMarketProvider';
import { isTimeframeId } from '../market/timeframes';
import type { TimeframeId } from '../market/types';
import type { MarketSelection } from './Workspace';

/**
 * URL switches (useful for offline work and deterministic browser tests):
 *   ?market=us&symbol=AAPL&tf=1h   open a chart (market: 'binance' (default), 'us' or 'futures')
 *   ?provider=mock            synthetic data instead of the server (crypto-, US- and futures-like markets)
 *   &mockNow=<ms>             freeze the mock clock (fully reproducible bars)
 *   &mockLive=0               disable mock live updates
 *   ?provider=binance         crypto straight from Binance's public API (no server)
 *   &test=1                   expose window.__dac for browser automation (always on in dev)
 *   &sync=off                 no sync for this page load (drawings stay on the device)
 */
export function readParams(): URLSearchParams {
  return new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
}

export const MARKET_LABELS: Readonly<Record<string, string>> = { binance: 'Crypto', us: 'US stocks', futures: 'Futures' };

/** The markets this page load can chart and where their data comes from. */
export function createMarkets(params = readParams()): MarketRegistry {
  const mode = params.get('provider');
  if (mode === 'mock') {
    const fixedNow = Number(params.get('mockNow'));
    const now = Number.isFinite(fixedNow) && fixedNow > 0 ? () => fixedNow : undefined;
    const liveIntervalMs = params.get('mockLive') === '0' ? null : 1000;
    const historyBars = Number(params.get('mockHistory')) || undefined;
    return new StaticMarketRegistry([
      { id: 'binance', label: MARKET_LABELS.binance, provider: new MockProvider({ now, liveIntervalMs, historyBars }) },
      {
        id: 'us',
        label: MARKET_LABELS.us,
        provider: new MockProvider({ id: 'mock-us', now, liveIntervalMs, historyBars, calendar: mockUsCalendar(), symbols: MOCK_STOCK_SYMBOLS }),
      },
      {
        id: 'futures',
        label: MARKET_LABELS.futures,
        provider: new MockProvider({ id: 'mock-futures', now, liveIntervalMs, historyBars, calendar: mockFuturesCalendar(), symbols: MOCK_FUTURES_SYMBOLS }),
      },
    ]);
  }
  if (mode === 'binance') return new StaticMarketRegistry([{ id: 'binance', label: MARKET_LABELS.binance, provider: new BinanceProvider() }]);

  // The self-hosted server: it caches history and serves every market. Crypto live updates come
  // straight from Binance's stream (the fastest path), and Binance's public API stands in for
  // history when the server cannot be reached. Stocks and futures are polled from the server.
  const api = new MarketApi('');
  const binance = new BinanceProvider();
  return new ServerMarketRegistry(
    api,
    [
      { id: 'binance', label: MARKET_LABELS.binance, provider: new ServerMarketProvider({ api, market: 'binance', name: 'Binance Spot', live: binance, fallback: binance }), standalone: true },
      { id: 'us', label: MARKET_LABELS.us, provider: new ServerMarketProvider({ api, market: 'us', name: 'US stocks' }) },
      // Futures bars stay revisable for 10 minutes after Yahoo's delay (server/market/service.ts).
      { id: 'futures', label: MARKET_LABELS.futures, provider: new ServerMarketProvider({ api, market: 'futures', name: 'Futures', revisableMs: 10 * 60_000 }) },
    ],
    () => binance.dispose(),
  );
}

/** Sync server base URL: '' = this origin (the server also serves the app); null = sync off. */
export function readSyncServer(params = readParams()): string | null {
  const configured = (import.meta.env.VITE_SYNC_SERVER ?? '').trim();
  if (params.get('sync') === 'off' || configured === 'off') return null;
  return configured.replace(/\/+$/, '');
}

export function exposeTestHooks(params = readParams()): boolean {
  return import.meta.env.DEV || params.get('test') === '1';
}

const MARKET_KEY = 'dac.market.v2';
const LEGACY_MARKET_KEY = 'dac.market.v1';
export const DEFAULT_MARKET: MarketSelection = { market: 'binance', symbol: 'BTCUSDT', timeframe: '1h' };

export function loadMarket(params = readParams()): MarketSelection {
  const symbol = params.get('symbol');
  const tf = params.get('tf');
  // Tickers are upper case everywhere (the drawings' chart key too): ?symbol=aapl is AAPL.
  if (symbol && tf && isTimeframeId(tf)) return { market: params.get('market') || 'binance', symbol: symbol.toUpperCase(), timeframe: tf };
  try {
    const raw = localStorage.getItem(MARKET_KEY) ?? localStorage.getItem(LEGACY_MARKET_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { market?: unknown; symbol?: unknown; timeframe?: unknown };
      if (typeof parsed.symbol === 'string' && typeof parsed.timeframe === 'string' && isTimeframeId(parsed.timeframe)) {
        const market = typeof parsed.market === 'string' ? parsed.market : 'binance'; // v1 had crypto only
        return { market, symbol: parsed.symbol.toUpperCase(), timeframe: parsed.timeframe as TimeframeId };
      }
    }
  } catch {
    // storage unavailable (private mode) — fall through to defaults
  }
  return DEFAULT_MARKET;
}

export function saveMarket(m: MarketSelection): void {
  try {
    localStorage.setItem(MARKET_KEY, JSON.stringify(m));
  } catch {
    // ignore
  }
}

const RECENT_KEY = 'dac.recent.v1';
const RECENT_MAX = 12;

export interface RecentSymbol {
  readonly market: string;
  readonly symbol: string;
}

/** Symbols charted recently on this device, newest first. */
export function loadRecent(): RecentSymbol[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r): r is RecentSymbol => typeof r?.market === 'string' && typeof r?.symbol === 'string').slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

export function rememberRecent(r: RecentSymbol): void {
  try {
    const next = [r, ...loadRecent().filter((x) => x.market !== r.market || x.symbol !== r.symbol)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}
