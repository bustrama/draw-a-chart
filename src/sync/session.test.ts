import { afterEach, describe, expect, it } from 'vitest';
import type { SessionInfo } from './protocol';
import { SyncServerError } from './serverRemote';
import { SyncSession } from './session';

class MemoryStorage {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

/** Scripted server: each call takes the next outcome (an Error is thrown). */
function source(...outcomes: Array<SessionInfo | Error>) {
  return {
    calls: 0,
    session(): Promise<SessionInfo> {
      const next = outcomes[Math.min(this.calls++, outcomes.length - 1)];
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
}

const LOCAL: SessionInfo = { user: { id: 'local' }, auth: 'none', generation: 'g1' };
const sessions: SyncSession[] = [];
afterEach(() => sessions.splice(0).forEach((s) => s.dispose()));

async function settled(session: SyncSession): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  sessions.push(session);
}

describe('SyncSession', () => {
  it('learns the user from the server and caches it', async () => {
    const storage = new MemoryStorage();
    const session = new SyncSession(source(LOCAL), storage);
    expect(session.getState()).toEqual({ status: 'unknown', userId: null, error: null });
    session.start();
    await settled(session);
    expect(session.getState()).toEqual({ status: 'ready', userId: 'local', error: null });
    expect(storage.data.get('dac-sync-user')).toBe('local');
  });

  it('starts from the cached user while the server is unreachable, then confirms it', async () => {
    const storage = new MemoryStorage();
    storage.setItem('dac-sync-user', 'local');
    const src = source(new TypeError('Failed to fetch'), LOCAL);
    const session = new SyncSession(src, storage);
    expect(session.getState().userId).toBe('local'); // queued edits keep their owner offline
    session.start();
    await settled(session);
    expect(session.getState()).toEqual({ status: 'ready', userId: 'local', error: 'Failed to fetch' });
    session.refresh(); // e.g. the network came back
    await settled(session);
    expect(session.getState()).toEqual({ status: 'ready', userId: 'local', error: null });
  });

  it('is unreachable without a cache, and signed out when the server refuses (future auth)', async () => {
    const storage = new MemoryStorage();
    const unreachable = new SyncSession(source(new TypeError('Failed to fetch')), storage);
    unreachable.start();
    await settled(unreachable);
    expect(unreachable.getState().status).toBe('unreachable');

    storage.setItem('dac-sync-user', 'local');
    const refused = new SyncSession(source(new SyncServerError('not signed in', 401)), storage);
    refused.start();
    await settled(refused);
    expect(refused.getState()).toEqual({ status: 'signed-out', userId: null, error: 'not signed in' });
    expect(storage.data.has('dac-sync-user')).toBe(false);
  });
});
