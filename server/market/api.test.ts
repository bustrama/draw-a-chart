import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { BarsResponse, SymbolResponse } from '../../src/market/protocol.ts';
import { startServer, type RunningServer } from '../http.ts';
import type { Bar } from './cache.ts';
import type { CryptoUpstream } from './service.ts';
import { UpstreamError } from './upstream.ts';

const H = 3_600_000;
const NOW = Date.parse('2026-09-25T18:30:10Z');

class FakeCrypto implements CryptoUpstream {
  calls = 0;
  fail = false;
  async klines(_symbol: string, _interval: string, from: number, to: number): Promise<Bar[]> {
    this.calls++;
    if (this.fail) throw new UpstreamError('Binance', 503, 'HTTP 503');
    const out: Bar[] = [];
    for (let t = Math.ceil(from / H) * H; t <= Math.min(to, Math.floor(NOW / H) * H); t += H) out.push({ t, o: 1, h: 2, l: 0.5, c: 1.5, v: 7 });
    return out;
  }
  async symbols() {
    return [{ symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', tickSize: '0.01000000' }];
  }
}

const servers: RunningServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function server(crypto = new FakeCrypto(), identifyAs: string | null = 'local'): Promise<RunningServer> {
  const s = await startServer({
    host: '127.0.0.1',
    identify: () => (identifyAs ? { userId: identifyAs } : null),
    log: () => undefined,
    market: { dbFile: ':memory:', upstreams: { binance: crypto, alpaca: null }, now: () => NOW, warmUp: false },
  });
  servers.push(s);
  return s;
}

const get = (s: RunningServer, path: string, init?: RequestInit) => fetch(s.url + path, init);

describe('market API', () => {
  it('serves bars as compact arrays with a closed flag', async () => {
    const s = await server();
    const res = await get(s, '/api/market/bars?market=binance&symbol=btcusdt&tf=1h&limit=3');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-market-api')).toBe('1');
    const body = (await res.json()) as BarsResponse;
    expect(body.bars).toEqual([
      [Date.parse('2026-09-25T16:00:00Z'), 1, 2, 0.5, 1.5, 7, 1],
      [Date.parse('2026-09-25T17:00:00Z'), 1, 2, 0.5, 1.5, 7, 1],
      [Date.parse('2026-09-25T18:00:00Z'), 1, 2, 0.5, 1.5, 7, 0],
    ]);
  });

  it('describes symbols and lists the markets', async () => {
    const s = await server();
    const symbol = (await (await get(s, '/api/market/symbol?market=binance&symbol=BTCUSDT')).json()) as SymbolResponse;
    expect(symbol.symbol).toMatchObject({ symbol: 'BTCUSDT', pricePrecision: 2, sessions: false });
    expect(await (await get(s, '/api/market/markets')).json()).toEqual({
      markets: [
        { id: 'binance', label: 'Crypto', available: true },
        { id: 'us', label: 'US stocks', available: false },
      ],
    });
    expect((await get(s, '/api/market/search?q=btc')).status).toBe(200);
  });

  it('rejects malformed requests before touching the upstream', async () => {
    const crypto = new FakeCrypto();
    const s = await server(crypto);
    const cases: Array<[string, number]> = [
      ['/api/market/bars?market=binance&symbol=BTCUSDT&tf=2h&limit=10', 400],
      ['/api/market/bars?market=binance&symbol=BTCUSDT&tf=1h&limit=0', 400],
      ['/api/market/bars?market=binance&symbol=BTCUSDT&tf=1h&limit=99999', 400],
      ['/api/market/bars?market=binance&symbol=BTCUSDT&tf=1h&limit=10&start=abc', 400],
      ['/api/market/bars?market=binance&symbol=BTCUSDT&tf=1h&limit=10&end=12', 400],
      ['/api/market/bars?market=binance&symbol=BTC%2FUSDT&tf=1h&limit=10', 400],
      ['/api/market/bars?market=binance&tf=1h&limit=10', 400],
      ['/api/market/bars?market=binance&symbol=NOPE&tf=1h&limit=10', 404],
      ['/api/market/bars?market=forex&symbol=EURUSD&tf=1h&limit=10', 404],
      ['/api/market/bars?market=us&symbol=AAPL&tf=1h&limit=10', 503],
      ['/api/market/calendar?market=binance', 404], // crypto trades around the clock
      ['/api/market/calendar?market=us', 503], // no Alpaca key
      ['/api/market/nothing', 404],
    ];
    for (const [path, status] of cases) {
      const res = await get(s, path);
      expect(res.status, path).toBe(status);
      expect(res.headers.get('x-market-api'), path).toBe('1'); // errors are marked too
    }
    expect((await get(s, '/api/market/markets', { method: 'POST' })).status).toBe(405);
    expect(crypto.calls).toBe(0);
  });

  it('answers 502 when the upstream fails', async () => {
    const crypto = new FakeCrypto();
    crypto.fail = true;
    const s = await server(crypto);
    const res = await get(s, '/api/market/bars?market=binance&symbol=BTCUSDT&tf=1h&limit=3');
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain('Binance');
  });

  it('checks the caller like the sync API', async () => {
    const s = await server(new FakeCrypto(), null);
    expect((await get(s, '/api/market/markets')).status).toBe(401);
  });

  it('leaves other API paths to the sync API', async () => {
    const s = await server();
    const res = await get(s, '/api/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-market-api')).toBeNull();
  });

  it('replaces a bar cache it cannot open instead of failing to start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dac-market-'));
    const file = join(dir, 'market.sqlite');
    const db = new DatabaseSync(file);
    db.exec('pragma user_version = 99'); // e.g. written by a newer version before a rollback
    db.close();
    const logs: string[] = [];
    const s = await startServer({ host: '127.0.0.1', log: (m) => logs.push(m), market: { dbFile: file, upstreams: { binance: new FakeCrypto(), alpaca: null }, now: () => NOW, warmUp: false } });
    servers.push(s);
    expect((await get(s, '/api/market/bars?market=binance&symbol=BTCUSDT&tf=1h&limit=3')).status).toBe(200);
    expect(logs.some((l) => l.includes('unusable'))).toBe(true);
    await s.close();
    servers.splice(servers.indexOf(s), 1);
    rmSync(dir, { recursive: true, force: true });
  });
});
