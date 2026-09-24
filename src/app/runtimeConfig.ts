import { BinanceProvider } from '../market/binance/provider';
import { MockProvider } from '../market/mock/MockProvider';
import type { MarketDataProvider, TimeframeId } from '../market/types';
import { isTimeframeId } from '../market/timeframes';
import type { MarketSelection } from './Workspace';

/**
 * URL switches (useful for offline work and deterministic browser tests):
 *   ?provider=mock            synthetic data instead of Binance
 *   &mockNow=<ms>             freeze the mock clock (fully reproducible bars)
 *   &mockLive=0               disable mock live updates
 *   &test=1                   expose window.__dac for browser automation (always on in dev)
 *   &sync=off                 no sync for this page load (drawings stay on the device)
 */
export function readParams(): URLSearchParams {
  return new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
}

export function createProvider(params = readParams()): MarketDataProvider {
  if (params.get('provider') === 'mock') {
    const fixedNow = Number(params.get('mockNow'));
    const now = Number.isFinite(fixedNow) && fixedNow > 0 ? () => fixedNow : undefined;
    const live = params.get('mockLive') === '0' ? null : 1000;
    const historyBars = Number(params.get('mockHistory')) || undefined;
    return new MockProvider({ now, liveIntervalMs: live, historyBars });
  }
  return new BinanceProvider();
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

const MARKET_KEY = 'dac.market.v1';

export function loadMarket(params = readParams()): MarketSelection {
  const symbol = params.get('symbol');
  const tf = params.get('tf');
  if (symbol && tf && isTimeframeId(tf)) return { symbol, timeframe: tf };
  try {
    const raw = localStorage.getItem(MARKET_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { symbol?: unknown; timeframe?: unknown };
      if (typeof parsed.symbol === 'string' && typeof parsed.timeframe === 'string' && isTimeframeId(parsed.timeframe)) {
        return { symbol: parsed.symbol, timeframe: parsed.timeframe as TimeframeId };
      }
    }
  } catch {
    // storage unavailable (private mode) — fall through to defaults
  }
  return { symbol: 'BTCUSDT', timeframe: '1h' };
}

export function saveMarket(m: MarketSelection): void {
  try {
    localStorage.setItem(MARKET_KEY, JSON.stringify(m));
  } catch {
    // ignore
  }
}
