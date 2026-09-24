import { describe, expect, it } from 'vitest';
import { BinanceStreamClient, type StreamSubscriber } from './stream';
import { FakeSocket, ManualClock } from '../testing/fakes';

function setup(baseUrls = ['wss://a', 'wss://b']) {
  const clock = new ManualClock(1_000_000);
  const sockets: FakeSocket[] = [];
  const client = new BinanceStreamClient({
    baseUrls,
    clock,
    random: () => 0.5,
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
  });
  return { clock, sockets, client, last: () => sockets[sockets.length - 1] };
}

function recorder(): StreamSubscriber & { data: unknown[]; resyncs: number; statuses: string[] } {
  const r = {
    data: [] as unknown[],
    resyncs: 0,
    statuses: [] as string[],
    onData: (d: unknown) => r.data.push(d),
    onResync: () => {
      r.resyncs++;
    },
    onStatus: (s: string) => r.statuses.push(s),
  };
  return r;
}

describe('BinanceStreamClient', () => {
  it('connects with the subscribed stream in the URL and routes messages', () => {
    const { client, last } = setup();
    const rec = recorder();
    client.subscribe('btcusdt@kline_1m', rec);
    expect(last().url).toBe('wss://a/stream?streams=btcusdt@kline_1m');
    last().open();
    expect(client.currentStatus).toBe('live');
    last().receive({ stream: 'btcusdt@kline_1m', data: { e: 'kline', x: 1 } });
    last().receive({ stream: 'ethusdt@kline_1m', data: { e: 'kline', x: 2 } });
    expect(rec.data).toEqual([{ e: 'kline', x: 1 }]);
    expect(rec.resyncs).toBe(0);
  });

  it('uses SUBSCRIBE/UNSUBSCRIBE on the open socket, paced', () => {
    const { client, last, clock } = setup();
    client.subscribe('btcusdt@kline_1m', recorder());
    last().open();
    const unsub = client.subscribe('ethusdt@kline_1h', recorder());
    expect(JSON.parse(last().sent[0])).toMatchObject({ method: 'SUBSCRIBE', params: ['ethusdt@kline_1h'] });
    unsub();
    expect(last().sent).toHaveLength(1); // paced: second message waits
    clock.advance(250);
    expect(JSON.parse(last().sent[1])).toMatchObject({ method: 'UNSUBSCRIBE', params: ['ethusdt@kline_1h'] });
  });

  it('closes the socket after the linger period when nothing is subscribed', () => {
    const { client, last, clock } = setup();
    const unsub = client.subscribe('btcusdt@kline_1m', recorder());
    last().open();
    unsub();
    clock.advance(9_999);
    expect(last().closedByClient).toBe(false);
    clock.advance(1);
    expect(last().closedByClient).toBe(true);
    expect(client.currentStatus).toBe('idle');
  });

  it('reconnects after a drop with backoff and asks subscribers to resync', () => {
    const { client, sockets, last, clock } = setup();
    const rec = recorder();
    client.subscribe('btcusdt@kline_1m', rec);
    last().open();
    last().drop();
    expect(client.currentStatus).toBe('reconnecting');
    expect(sockets).toHaveLength(1);
    clock.advance(1_000); // base 1s, jitter 0.5 -> 750ms
    expect(sockets).toHaveLength(2);
    last().open();
    expect(rec.resyncs).toBe(1);
    expect(client.currentStatus).toBe('live');
  });

  it('rotates to the next host when a connection never opens', () => {
    const { client, sockets, last, clock } = setup();
    client.subscribe('btcusdt@kline_1m', recorder());
    last().drop();
    clock.advance(1_000);
    expect(sockets[1].url.startsWith('wss://b/')).toBe(true);
  });

  it('restarts a silent connection', () => {
    const { client, sockets, last, clock } = setup();
    const rec = recorder();
    client.subscribe('btcusdt@kline_1m', rec);
    last().open();
    clock.advance(36_000);
    expect(sockets).toHaveLength(2);
    expect(sockets[0].closedByClient).toBe(true);
    last().open();
    expect(rec.resyncs).toBe(1);
  });

  it('restarts on serverShutdown events', () => {
    const { client, sockets, last } = setup();
    client.subscribe('btcusdt@kline_1m', recorder());
    last().open();
    last().receive({ stream: '!serverShutdown', data: { e: 'serverShutdown', E: 1 } });
    expect(sockets).toHaveLength(2);
  });

  it('does nothing further after dispose', () => {
    const { client, sockets, last, clock } = setup();
    client.subscribe('btcusdt@kline_1m', recorder());
    last().open();
    client.dispose();
    clock.advance(120_000);
    expect(sockets).toHaveLength(1);
    expect(clock.pendingTimers).toBe(0);
  });
});
