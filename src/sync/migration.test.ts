import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Runs the real Supabase migration on Postgres (PGlite/WASM) with minimal stand-ins for the
 * Supabase `auth` schema, then exercises RLS and the write RPC as the `authenticated` role.
 */

const MIGRATION = readFileSync(fileURLToPath(new URL('../../supabase/migrations/20260924000000_drawings.sql', import.meta.url)), 'utf8');

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const DRAWING = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OP1 = 'b0000000-0000-4000-8000-000000000001';
const OP2 = 'b0000000-0000-4000-8000-000000000002';
const OP3 = 'b0000000-0000-4000-8000-000000000003';
const OP4 = 'b0000000-0000-4000-8000-000000000004';

interface ChangeResult {
  id: string;
  status: 'applied' | 'duplicate' | 'conflict' | 'rejected' | 'invalid';
  row: { rev: number; deleted: boolean; data: unknown } | null;
}

/**
 * A Postgres with the Supabase roles the migration relies on.
 * - `legacyGrants`: older Supabase projects grant the API roles every privilege on new tables
 *   by default (RLS alone restricts rows). The migration must stay secure there.
 * - Without it: new projects grant nothing automatically. The migration must still work there.
 */
async function createDb(legacyGrants: boolean): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(`
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
    $$;
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated;
    insert into auth.users (id) values ('${USER_A}'), ('${USER_B}');
  `);
  if (legacyGrants) await pg.exec(`alter default privileges in schema public grant all on tables to anon, authenticated;`);
  await pg.exec(MIGRATION);
  return pg;
}

let db: PGlite;

beforeAll(async () => {
  db = await createDb(true);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

async function as<T>(user: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec(`reset role; set role ${user ? 'authenticated' : 'anon'};`);
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [user ? JSON.stringify({ sub: user }) : '']);
  try {
    return await fn();
  } finally {
    await db.exec('reset role;');
  }
}

async function apply(user: string | null, changes: unknown[]): Promise<ChangeResult[]> {
  return as(user, async () => {
    const res = await db.query<{ r: ChangeResult[] }>('select public.apply_drawing_changes($1::jsonb) as r', [JSON.stringify(changes)]);
    return res.rows[0].r;
  });
}

function change(op: string, baseRev: number, data: unknown, deleted = false) {
  return { id: DRAWING, op_id: op, base_rev: baseRev, provider: 'binance', symbol: 'BTCUSDT', timeframe: '1h', kind: 'line', data, deleted };
}

describe('drawings migration (real Postgres via PGlite)', () => {
  it('creates a drawing and is idempotent under retries', async () => {
    const [created] = await apply(USER_A, [change(OP1, 0, { v: 1 })]);
    expect(created.status).toBe('applied');
    expect(created.row?.rev).toBe(1);
    const [retry] = await apply(USER_A, [change(OP1, 0, { v: 1 })]);
    expect(retry.status).toBe('duplicate');
    expect(retry.row?.rev).toBe(1);
    const count = await as(USER_A, () => db.query<{ n: number }>('select count(*)::int as n from public.drawings'));
    expect(count.rows[0].n).toBe(1);
  });

  it('applies updates against the current revision and rejects stale ones (compare-and-swap)', async () => {
    const [ok] = await apply(USER_A, [change(OP2, 1, { v: 2 })]);
    expect(ok.status).toBe('applied');
    expect(ok.row?.rev).toBe(2);
    const [stale] = await apply(USER_A, [change(OP3, 1, { v: 'stale' })]);
    expect(stale.status).toBe('conflict');
    expect(stale.row?.rev).toBe(2);
    expect(stale.row?.data).toEqual({ v: 2 });
  });

  it('tombstones deletions and keeps them readable for other devices', async () => {
    const [del] = await apply(USER_A, [change(OP4, 2, null, true)]);
    expect(del.status).toBe('applied');
    expect(del.row).toMatchObject({ rev: 3, deleted: true, data: { v: 2 } });
  });

  it("isolates users: B can neither read nor overwrite A's drawing", async () => {
    const seen = await as(USER_B, () => db.query('select * from public.drawings'));
    expect(seen.rows).toHaveLength(0);
    const [attempt] = await apply(USER_B, [change('c0000000-0000-4000-8000-000000000001', 3, { hacked: true })]);
    expect(attempt).toEqual({ id: DRAWING, status: 'rejected', row: null });
    const aRows = await as(USER_A, () => db.query<{ data: unknown }>('select data from public.drawings'));
    expect(aRows.rows[0].data).toEqual({ v: 2 });
  });

  it('denies direct table writes even where the project grants API roles everything (only the RPC may write)', async () => {
    await expect(
      as(USER_A, () =>
        db.query(
          `insert into public.drawings (id, user_id, provider, symbol, timeframe, kind, data) values ($1, $2, 'binance', 'BTCUSDT', '1h', 'ink', '{}')`,
          ['dddddddd-dddd-4ddd-8ddd-dddddddddddd', USER_A],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(as(USER_A, () => db.query(`update public.drawings set rev = 99 returning id`))).rejects.toThrow(/permission denied/);
    await expect(as(USER_A, () => db.query(`delete from public.drawings`))).rejects.toThrow(/permission denied/);
    await expect(as(null, () => db.query(`select id from public.drawings`))).rejects.toThrow(/permission denied/);
  });

  it("accepts an edit on top of the client's own unacknowledged op (lost response), not someone else's", async () => {
    const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const mk = (op: string, base: number, prev: string[], data: unknown) => ({
      id,
      op_id: op,
      base_rev: base,
      prev_op_ids: prev,
      provider: 'binance',
      symbol: 'BTCUSDT',
      timeframe: '1h',
      kind: 'line',
      data,
      deleted: false,
    });
    const opA = 'a1000000-0000-4000-8000-000000000001';
    const opB = 'a1000000-0000-4000-8000-000000000002';
    const opC = 'a1000000-0000-4000-8000-000000000003';
    // A was applied, but the client never heard back; it then edited again (B, still base 0).
    expect((await apply(USER_A, [mk(opA, 0, [], { v: 'a' })]))[0].status).toBe('applied');
    const [b] = await apply(USER_A, [mk(opB, 0, [opA], { v: 'b' })]);
    expect(b.status).toBe('applied');
    expect(b.row).toMatchObject({ rev: 2, data: { v: 'b' } });
    // Without the proof of authorship it is a genuine conflict.
    const [c] = await apply(USER_A, [mk(opC, 0, [], { v: 'c' })]);
    expect(c.status).toBe('conflict');
  });

  it('reports an oversized change as invalid without failing the rest of the batch', async () => {
    const big = { pts: 'x'.repeat(270_000) };
    const ok = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const bad = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd0';
    const results = await apply(USER_A, [
      { id: bad, op_id: 'e1000000-0000-4000-8000-000000000001', base_rev: 0, provider: 'binance', symbol: 'BTCUSDT', timeframe: '1h', kind: 'ink', data: big, deleted: false },
      { id: ok, op_id: 'e1000000-0000-4000-8000-000000000002', base_rev: 0, provider: 'binance', symbol: 'BTCUSDT', timeframe: '1h', kind: 'ink', data: { v: 1 }, deleted: false },
    ]);
    expect(results.map((r) => r.status)).toEqual(['invalid', 'applied']);
    const rows = await as(USER_A, () => db.query<{ id: string }>('select id from public.drawings where id = any($1::uuid[])', [[ok, bad]]));
    expect(rows.rows.map((r) => r.id)).toEqual([ok]);
  });

  it('refuses anonymous callers and malformed payloads', async () => {
    await expect(apply(null, [change('e0000000-0000-4000-8000-000000000001', 0, {})])).rejects.toThrow();
    await expect(as(USER_A, () => db.query(`select public.apply_drawing_changes('{}'::jsonb)`))).rejects.toThrow(/array/);
    const [bogus] = await apply(USER_A, [{ ...change('e0000000-0000-4000-8000-000000000002', 0, {}), id: 'f0000000-0000-4000-8000-000000000001', kind: 'bogus' }]);
    expect(bogus.status).toBe('invalid');
    const [badId] = await apply(USER_A, [{ ...change('e0000000-0000-4000-8000-000000000003', 0, {}), id: 'not-a-uuid' }]);
    expect(badId.status).toBe('invalid');
  });

  it('enforces the per-user quota of 100 000 rows (other users unaffected)', async () => {
    // Seed B with one row below the limit (as the table owner, bypassing the RPC).
    await db.exec(`
      insert into public.drawings (id, user_id, provider, symbol, timeframe, kind)
      select gen_random_uuid(), '${USER_B}', 'binance', 'BTCUSDT', '1h', 'ink' from generate_series(1, 99999);
    `);
    const mk = (id: string, op: string) => ({ id, op_id: op, base_rev: 0, provider: 'binance', symbol: 'BTCUSDT', timeframe: '1h', kind: 'ink', data: {}, deleted: false });
    const [last] = await apply(USER_B, [mk('f1000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001')]);
    expect(last.status).toBe('applied'); // exactly at the limit
    await expect(apply(USER_B, [mk('f1000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000002')])).rejects.toThrow(/quota/);
    const [other] = await apply(USER_A, [mk('f1000000-0000-4000-8000-000000000003', 'f2000000-0000-4000-8000-000000000003')]);
    expect(other.status).toBe('applied');
  }, 60_000);
});

describe('drawings migration on a new project (no automatic grants to API roles)', () => {
  it('lets a signed-in user read their own drawings (regression: reads failed with "permission denied")', async () => {
    const fresh = await createDb(false);
    try {
      const run = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
        await fresh.exec('reset role; set role authenticated;');
        await fresh.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: USER_A })]);
        try {
          return (await fresh.query<T>(sql, params)).rows;
        } finally {
          await fresh.exec('reset role;');
        }
      };
      const [written] = await run<{ r: ChangeResult[] }>('select public.apply_drawing_changes($1::jsonb) as r', [JSON.stringify([change(OP1, 0, { v: 1 })])]);
      expect(written.r[0].status).toBe('applied');
      const rows = await run<{ id: string; rev: number }>('select id, rev from public.drawings');
      expect(rows).toEqual([{ id: DRAWING, rev: 1 }]);
    } finally {
      await fresh.close();
    }
  }, 60_000);
});
