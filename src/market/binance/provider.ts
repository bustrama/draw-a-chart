import { clockFor, getTimeframe } from '../timeframes';
import type { CandleRequest, Candle, LiveCandleListener, MarketDataProvider, PreparedChart, SymbolInfo, TimeframeId } from '../types';
import { klineStreamName, parseStreamKline } from './normalize';
import { BinanceRestClient, type RestClientOptions } from './rest';
import { BinanceStreamClient, type StreamClientOptions } from './stream';

export const BINANCE_REST_URLS = [
  // Market-data-only host (documented for public data), then the general API hosts.
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api-gcp.binance.com',
] as const;

export const BINANCE_STREAM_URLS = [
  'wss://data-stream.binance.vision',
  'wss://stream.binance.com:9443',
  'wss://stream.binance.com:443',
] as const;

const SYMBOLS: readonly SymbolInfo[] = [
  { symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', pricePrecision: 2, minMove: 0.01 },
  { symbol: 'ETHUSDT', base: 'ETH', quote: 'USDT', pricePrecision: 2, minMove: 0.01 },
];

export interface BinanceProviderOptions {
  readonly rest?: Partial<RestClientOptions>;
  readonly stream?: Partial<StreamClientOptions>;
}

/** Known pairs, else a pair with two decimals (the server provider knows every pair's tick size). */
export function binanceSymbolInfo(symbol: string): SymbolInfo {
  return SYMBOLS.find((s) => s.symbol === symbol) ?? { symbol, base: symbol, quote: '', pricePrecision: 2, minMove: 0.01 };
}

/** Binance Spot public market data (no keys, no trading). */
export class BinanceProvider implements MarketDataProvider {
  readonly id = 'binance';
  readonly name = 'Binance Spot';
  readonly maxCandlesPerRequest = 1000;
  private readonly rest: BinanceRestClient;
  private readonly stream: BinanceStreamClient;

  constructor(options: BinanceProviderOptions = {}) {
    this.rest = new BinanceRestClient({ baseUrls: BINANCE_REST_URLS, ...options.rest });
    this.stream = new BinanceStreamClient({
      baseUrls: BINANCE_STREAM_URLS,
      windowEvents: typeof window !== 'undefined' ? window : undefined,
      documentEvents: typeof document !== 'undefined' ? document : undefined,
      ...options.stream,
    });
  }

  symbols(): readonly SymbolInfo[] {
    return SYMBOLS;
  }

  async prepare(symbol: string, timeframe: TimeframeId): Promise<PreparedChart> {
    return { info: binanceSymbolInfo(symbol), clock: clockFor(getTimeframe(timeframe)) };
  }

  fetchCandles(req: CandleRequest): Promise<Candle[]> {
    return this.rest.fetchKlines({ ...req, limit: Math.min(req.limit, this.maxCandlesPerRequest) });
  }

  subscribeCandles(symbol: string, timeframe: TimeframeId, listener: LiveCandleListener): () => void {
    const interval = timeframe; // Binance interval ids match ours for all supported timeframes.
    return this.stream.subscribe(klineStreamName(symbol, interval), {
      onData: (data) => {
        const parsed = parseStreamKline(data);
        if (parsed && parsed.symbol === symbol && parsed.interval === interval) listener.onCandle(parsed.candle);
      },
      onResync: () => listener.onResync?.(),
      onStatus: (s) => listener.onStatus?.(s),
    });
  }

  dispose(): void {
    this.stream.dispose();
  }
}
