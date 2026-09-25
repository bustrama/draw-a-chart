import type { SymbolMatch } from './protocol';
import { MarketApiError, type MarketApi } from './server/marketApi';
import type { MarketDataProvider } from './types';

export type { SymbolMatch };

/** A market the app can chart: its id is the selection key and the drawings' namespace. */
export interface MarketEntry {
  readonly id: string;
  readonly label: string;
  readonly provider: MarketDataProvider;
  /** Works without the market-data server too (crypto falls back to Binance directly). */
  readonly standalone?: boolean;
}

/** The markets available to this app instance, and symbol search across them. */
export interface MarketRegistry {
  readonly markets: readonly MarketEntry[];
  provider(market: string): MarketDataProvider | null;
  /** False once it is known that this page load cannot chart the market (e.g. no US key on the server). */
  available(market: string): boolean;
  /** Symbols matching `query`, best first (the server's search when available). */
  search(query: string, signal?: AbortSignal): Promise<SymbolMatch[]>;
  dispose(): void;
}

/** Matches from the symbols the providers know locally (offline, mock and direct modes). */
export function searchLocal(markets: readonly MarketEntry[], query: string): SymbolMatch[] {
  const q = query.trim().toUpperCase();
  const out: { m: SymbolMatch; rank: number }[] = [];
  for (const entry of markets) {
    for (const s of entry.provider.symbols()) {
      const name = s.name ?? `${s.base}/${s.quote}`;
      const rank = !q ? 2 : s.symbol === q ? 0 : s.symbol.startsWith(q) ? 1 : name.toUpperCase().includes(q) ? 2 : -1;
      if (rank >= 0) out.push({ m: { market: entry.id, symbol: s.symbol, name, detail: entry.label }, rank });
    }
  }
  return out.sort((a, b) => a.rank - b.rank).map((x) => x.m);
}

export class StaticMarketRegistry implements MarketRegistry {
  readonly markets: readonly MarketEntry[];

  constructor(markets: readonly MarketEntry[]) {
    this.markets = markets;
  }

  provider(market: string): MarketDataProvider | null {
    return this.markets.find((m) => m.id === market)?.provider ?? null;
  }

  available(market: string): boolean {
    return this.provider(market) !== null;
  }

  async search(query: string): Promise<SymbolMatch[]> {
    return searchLocal(this.markets, query);
  }

  dispose(): void {
    for (const m of this.markets) m.provider.dispose?.();
  }
}

/**
 * Markets served by the self-hosted server: search goes to the server (locally known symbols if it
 * fails), and markets the server cannot serve are hidden from search and suggestions.
 */
export class ServerMarketRegistry extends StaticMarketRegistry {
  private readonly api: MarketApi;
  private readonly extraDispose: () => void;
  private readonly unavailable = new Set<string>();

  constructor(api: MarketApi, markets: readonly MarketEntry[], dispose: () => void = () => undefined) {
    super(markets);
    this.api = api;
    this.extraDispose = dispose;
    api.markets().then(
      (list) => {
        for (const m of list) if (!m.available && !markets.find((e) => e.id === m.id)?.standalone) this.unavailable.add(m.id);
      },
      (err: unknown) => {
        // No market-data API at all (e.g. turned off): only standalone markets work.
        if (err instanceof MarketApiError && err.kind === 'absent') for (const m of markets) if (!m.standalone) this.unavailable.add(m.id);
      },
    );
  }

  override available(market: string): boolean {
    return super.available(market) && !this.unavailable.has(market);
  }

  override async search(query: string, signal?: AbortSignal): Promise<SymbolMatch[]> {
    try {
      const results = await this.api.search(query, signal);
      return results.filter((r) => this.available(r.market));
    } catch (err) {
      if (signal?.aborted) throw err;
      return searchLocal(this.markets, query);
    }
  }

  override dispose(): void {
    super.dispose();
    this.extraDispose();
  }
}
