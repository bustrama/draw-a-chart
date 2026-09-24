/**
 * Cloud sync against a real Supabase stack running locally (see e2e/supabase.config.ts).
 * Two browser contexts act as two devices of the same user; Node-side Supabase clients check what
 * the server stored and what another account can reach.
 */
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { drawings, Input, lerpPoints, openApp, paneBox } from './helpers';

const stack = JSON.parse(process.env.DAC_SUPABASE_STACK ?? '{}') as { API_URL: string; PUBLISHABLE_KEY: string; SECRET_KEY: string };
/** Server-side admin client (secret key): creates/deletes test users and reads what was stored. */
const admin = createClient(stack.API_URL, stack.SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

interface TestUser {
  readonly id: string;
  readonly email: string;
  readonly password: string;
}

interface Device {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly input: Input;
}

interface ServerRow {
  readonly id: string;
  readonly rev: number;
  readonly deleted: boolean;
  readonly data: Record<string, unknown>;
}

const users: string[] = [];
const contexts: BrowserContext[] = [];
const clients: SupabaseClient[] = [];

test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
  for (const c of clients.splice(0)) await c.removeAllChannels();
  // Deleting a user cascades to their drawings.
  for (const id of users.splice(0)) await admin.auth.admin.deleteUser(id);
});

async function createUser(): Promise<TestUser> {
  const email = `sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = 'correct-horse-battery';
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw error ?? new Error('user was not created');
  users.push(data.user.id);
  return { id: data.user.id, email, password };
}

/** A separate browser profile (own IndexedDB, own session) = one device. */
async function openDevice(browser: Browser, testInfo: TestInfo, user: TestUser): Promise<Device> {
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL, viewport: { width: 1280, height: 800 }, hasTouch: true });
  contexts.push(context);
  const page = await context.newPage();
  await openApp(page);
  await signIn(page, user);
  return { context, page, input: await Input.create(page) };
}

/** Signs in through the account panel and waits until sync and the preview channel are live. */
async function signIn(page: Page, user: TestUser): Promise<void> {
  await page.getByTestId('account-button').click();
  const form = page.getByTestId('sign-in-form');
  await form.getByPlaceholder('Email').fill(user.email);
  await form.getByPlaceholder('Password').fill(user.password);
  await form.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('account-button')).toHaveAttribute('data-sync-state', 'synced');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => (window as never as { __dacRuntime: { sync: { previewsReady: boolean } } }).__dacRuntime.sync.previewsReady)).toBe(true);
}

async function drawStroke(device: Device, fy: number): Promise<void> {
  const b = await paneBox(device.page);
  await device.input.penStroke(lerpPoints({ x: b.x + b.width * 0.3, y: b.y + b.height * fy }, { x: b.x + b.width * 0.7, y: b.y + b.height * (fy + 0.05) }, 30, 6));
}

/** Same code path as a palette recolor: a local edit committed to the chart's document. */
async function recolor(page: Page, id: string, color: string): Promise<void> {
  await page.evaluate(
    ([drawingId, c]) => {
      const doc = (window as never as { __dac: { engine: { document: { store: { get(id: string): { style: object } }; commit(label: string, muts: unknown[]): void } } } }).__dac.engine.document;
      const d = doc.store.get(drawingId);
      doc.commit('recolor', [{ op: 'put', drawing: { ...d, style: { ...d.style, color: c } } }]);
    },
    [id, color] as const,
  );
}

function syncStatus(page: Page): Promise<{ state: string; pending: number; error: string | null }> {
  return page.evaluate(() => (window as never as { __dacRuntime: { sync: { getStatus(): { state: string; pending: number; error: string | null } } } }).__dacRuntime.sync.getStatus());
}

function remotePreviews(page: Page): Promise<number> {
  return page.evaluate(() => (window as never as { __dac: { engine: { remotePreviews: Map<string, unknown> } } }).__dac.engine.remotePreviews.size);
}

async function serverRows(userId: string): Promise<ServerRow[]> {
  const { data, error } = await admin.from('drawings').select('id, rev, deleted, data').eq('user_id', userId).order('created_at');
  if (error) throw error;
  return data as ServerRow[];
}

async function userClient(user: TestUser): Promise<SupabaseClient> {
  const client = createClient(stack.API_URL, stack.PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw error;
  clients.push(client);
  return client;
}

function subscribeStatus(channel: RealtimeChannel, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('NO_RESPONSE'), timeoutMs);
    channel.subscribe((status) => {
      clearTimeout(timer);
      resolve(status);
    });
  });
}

function change(id: string, data: Record<string, unknown> = { v: 1 }) {
  return { id, op_id: crypto.randomUUID(), base_rev: 0, prev_op_ids: [], provider: 'binance', symbol: 'BTCUSDT', timeframe: '1h', kind: 'line', data, deleted: false };
}

test.describe('cloud sync (local Supabase)', () => {
  test('a drawing made on one device appears on the other; erasing it there removes it here', async ({ browser }, testInfo) => {
    const user = await createUser();
    const a = await openDevice(browser, testInfo, user);
    const b = await openDevice(browser, testInfo, user);

    await drawStroke(a, 0.4);
    const [drawn] = await drawings(a.page);
    await expect.poll(() => drawings(b.page)).toEqual([drawn]); // identical, not just "some drawing"
    expect(await serverRows(user.id)).toMatchObject([{ id: drawn.id, rev: 1, deleted: false }]);

    await b.page.getByTestId('tool-eraser').click();
    const box = await paneBox(b.page);
    await b.input.penStroke(lerpPoints({ x: box.x + box.width * 0.5, y: box.y + box.height * 0.2 }, { x: box.x + box.width * 0.5, y: box.y + box.height * 0.7 }, 20));
    await expect.poll(async () => (await drawings(a.page)).length).toBe(0);
    await expect.poll(() => serverRows(user.id)).toMatchObject([{ id: drawn.id, rev: 2, deleted: true }]);
  });

  test('the stroke in progress is previewed live on the other device, then replaced by the saved drawing', async ({ browser }, testInfo) => {
    const user = await createUser();
    const a = await openDevice(browser, testInfo, user);
    const b = await openDevice(browser, testInfo, user);
    const box = await paneBox(a.page);
    const pts = lerpPoints({ x: box.x + box.width * 0.3, y: box.y + box.height * 0.5 }, { x: box.x + box.width * 0.7, y: box.y + box.height * 0.55 }, 40, 6);

    await a.input.penDown(pts[0]);
    for (const p of pts.slice(1, 25)) await a.input.penMove(p);
    await expect.poll(() => remotePreviews(b.page)).toBe(1);
    expect(await drawings(b.page)).toHaveLength(0); // shown while drawing, not saved
    expect(await serverRows(user.id)).toHaveLength(0);

    for (const p of pts.slice(25)) await a.input.penMove(p);
    await a.input.penUp(pts[pts.length - 1]);
    await expect.poll(async () => (await drawings(b.page)).length).toBe(1);
    await expect.poll(() => remotePreviews(b.page)).toBe(0);
  });

  test('changes made offline are queued and delivered when the device reconnects', async ({ browser }, testInfo) => {
    const user = await createUser();
    const a = await openDevice(browser, testInfo, user);
    const b = await openDevice(browser, testInfo, user);

    await a.context.setOffline(true);
    await drawStroke(a, 0.5);
    await expect.poll(() => syncStatus(a.page)).toMatchObject({ state: 'offline', pending: 1 });
    await expect(a.page.getByTestId('pending-count')).toHaveText('1');
    await a.page.waitForTimeout(1_000);
    expect(await serverRows(user.id)).toHaveLength(0);
    expect(await drawings(b.page)).toHaveLength(0);

    await a.context.setOffline(false);
    await expect.poll(async () => (await drawings(b.page)).length).toBe(1);
    await expect.poll(() => syncStatus(a.page)).toMatchObject({ state: 'synced', pending: 0, error: null });
  });

  test('concurrent edits: the server version wins and both devices converge', async ({ browser }, testInfo) => {
    const user = await createUser();
    const a = await openDevice(browser, testInfo, user);
    const b = await openDevice(browser, testInfo, user);
    await drawStroke(a, 0.4);
    const [drawn] = await drawings(a.page);
    await expect.poll(async () => (await drawings(b.page)).length).toBe(1);
    await expect.poll(() => syncStatus(a.page)).toMatchObject({ state: 'synced', pending: 0 });

    await a.context.setOffline(true);
    await recolor(a.page, drawn.id, '#ff6b6b'); // edited offline on A, based on rev 1
    await expect.poll(() => syncStatus(a.page)).toMatchObject({ pending: 1 });
    await recolor(b.page, drawn.id, '#4cc9f0'); // edited on B meanwhile: rev 2
    await expect.poll(async () => (await serverRows(user.id))[0]?.rev).toBe(2);

    await a.context.setOffline(false);
    await expect.poll(async () => (await drawings(a.page))[0]?.style.color).toBe('#4cc9f0');
    await expect.poll(() => syncStatus(a.page)).toMatchObject({ state: 'synced', pending: 0 });
    expect((await serverRows(user.id))[0]).toMatchObject({ rev: 2, data: { style: { color: '#4cc9f0' } } });
    expect((await drawings(b.page))[0].style.color).toBe('#4cc9f0');
  });

  test('a lost response followed by another edit is applied, not reported as a conflict', async ({ browser }, testInfo) => {
    const user = await createUser();
    const a = await openDevice(browser, testInfo, user);
    const bodies: Array<{ changes: Array<{ op_id: string; base_rev: number; prev_op_ids: string[] }> }> = [];
    let lostOp: string | null = null;
    await a.page.route('**/rest/v1/rpc/apply_drawing_changes', async (route) => {
      const body = route.request().postDataJSON() as (typeof bodies)[number];
      bodies.push(body);
      const ops = body.changes.map((c) => c.op_id);
      if (lostOp === null) {
        lostOp = ops[0];
        await route.fetch(); // the server applies the change...
        await route.abort('connectionreset'); // ...but its answer never arrives
      } else if (ops.includes(lostOp)) {
        await route.abort('connectionreset'); // a plain retry would get lost too
      } else {
        await route.continue();
      }
    });

    await drawStroke(a, 0.4);
    const [drawn] = await drawings(a.page);
    await expect.poll(() => serverRows(user.id)).toMatchObject([{ id: drawn.id, rev: 1 }]);
    await expect.poll(async () => (await syncStatus(a.page)).state).toBe('error');

    await recolor(a.page, drawn.id, '#ff6b6b');
    await expect.poll(() => serverRows(user.id)).toMatchObject([{ id: drawn.id, rev: 2, data: { style: { color: '#ff6b6b' } } }]);
    await expect.poll(() => syncStatus(a.page)).toMatchObject({ state: 'synced', pending: 0, error: null });
    // The edit went out on its original base, carrying the lost op as proof of authorship.
    expect(bodies[bodies.length - 1].changes[0]).toMatchObject({ base_rev: 0, prev_op_ids: [lostOp] });
  });

  test('signing out affects only that device; the other stays signed in and keeps syncing', async ({ browser }, testInfo) => {
    const user = await createUser();
    const a = await openDevice(browser, testInfo, user);
    const b = await openDevice(browser, testInfo, user);
    await drawStroke(a, 0.4);
    await expect.poll(async () => (await drawings(b.page)).length).toBe(1);

    await a.page.getByTestId('account-button').click();
    await a.page.getByRole('button', { name: 'Sign out' }).click();
    await expect(a.page.getByTestId('account-button')).toHaveAttribute('data-sync-state', 'signed-out');
    expect(await drawings(a.page)).toHaveLength(1); // kept on this device

    // A global sign-out would have revoked B's refresh token as well.
    const refreshError = await b.page.evaluate(async () => {
      const auth = (window as never as { __dacRuntime: { auth: { client: SupabaseClient } } }).__dacRuntime.auth.client.auth;
      const { error } = await auth.refreshSession();
      return error ? error.message : null;
    });
    expect(refreshError).toBeNull();
    await drawStroke(b, 0.6);
    await expect.poll(async () => (await serverRows(user.id)).length).toBe(2);
    await expect(b.page.getByTestId('account-button')).toHaveAttribute('data-sync-state', 'synced');
  });

  test("another account can neither read nor overwrite this account's drawings", async () => {
    const owner = await createUser();
    const other = await createUser();
    const ownerClient = await userClient(owner);
    const otherClient = await userClient(other);
    const id = crypto.randomUUID();
    const created = await ownerClient.rpc('apply_drawing_changes', { changes: [change(id)] });
    expect(created.error).toBeNull();
    expect(created.data).toMatchObject([{ id, status: 'applied' }]);

    const seen = await otherClient.from('drawings').select('id');
    expect(seen.error).toBeNull();
    expect(seen.data).toEqual([]);
    const direct = await otherClient.from('drawings').insert({ id: crypto.randomUUID(), user_id: other.id, provider: 'binance', symbol: 'BTCUSDT', timeframe: '1h', kind: 'ink', data: {} });
    expect(direct.error?.code).toBe('42501'); // permission denied: writes only through the RPC
    const hijack = await otherClient.rpc('apply_drawing_changes', { changes: [change(id, { hacked: true })] });
    expect(hijack.data).toMatchObject([{ id, status: 'rejected', row: null }]);
    expect((await serverRows(owner.id))[0].data).toEqual({ v: 1 });
  });

  test("another account can neither listen to nor inject into this account's live previews", async () => {
    const owner = await createUser();
    const other = await createUser();
    const topic = `preview:${owner.id}`;
    const received: string[] = [];
    const listener = (await userClient(owner))
      .channel(topic, { config: { private: true } })
      .on('broadcast', { event: 'stroke' }, ({ payload }) => received.push(String(payload.id)));
    expect(await subscribeStatus(listener)).toBe('SUBSCRIBED');

    const intruderSaw: string[] = [];
    const intruder = (await userClient(other))
      .channel(topic, { config: { private: true } })
      .on('broadcast', { event: 'stroke' }, ({ payload }) => intruderSaw.push(String(payload.id)));
    expect(await subscribeStatus(intruder)).toBe('CHANNEL_ERROR');

    // The owner can send over the socket and over HTTP; the intruder's HTTP send must not arrive.
    const sender = (await userClient(owner)).channel(topic, { config: { private: true } });
    expect(await subscribeStatus(sender)).toBe('SUBSCRIBED');
    await sender.send({ type: 'broadcast', event: 'stroke', payload: { id: 'owner-socket' } });
    expect(await (await userClient(owner)).channel(topic, { config: { private: true } }).httpSend('stroke', { id: 'owner-http' })).toEqual({ success: true });
    const injected = await (await userClient(other))
      .channel(topic, { config: { private: true } })
      .httpSend('stroke', { id: 'intruder-http' })
      .then(
        (r) => (r.success ? 'delivered' : `refused (${r.status} ${r.error})`),
        (err: unknown) => `refused (${err instanceof Error ? err.message : String(err)})`,
      );
    expect(injected).toMatch(/^refused/);

    await expect.poll(() => [...received].sort()).toEqual(['owner-http', 'owner-socket']);
    await new Promise((r) => setTimeout(r, 1_000));
    expect([...received].sort()).toEqual(['owner-http', 'owner-socket']);
    expect(intruderSaw).toEqual([]);
  });
});
