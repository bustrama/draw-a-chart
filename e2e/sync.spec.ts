/**
 * Several devices syncing through the self-hosted server. Each test starts its own production
 * server (server/http.ts serving the built dist/, fresh database), so tests are isolated; each
 * browser context is one device (own IndexedDB, own live connection).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { startServer, type RunningServer } from '../server/http.ts';
import { drawings, Input, lerpPoints, openApp, paneBox } from './helpers';

interface Device {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly input: Input;
}

interface SyncStatus {
  state: string;
  pending: number;
  error: string | null;
}

const servers: RunningServer[] = [];
const contexts: BrowserContext[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function server(options: { port?: number; dbFile?: string } = {}): Promise<RunningServer> {
  const s = await startServer({ staticDir: 'dist', dbFile: ':memory:', log: () => undefined, ...options });
  servers.push(s);
  return s;
}

/** A separate browser profile (own IndexedDB, own live connection) = one device. */
async function openDevice(browser: Browser, s: RunningServer): Promise<Device> {
  const context = await browser.newContext({ baseURL: s.url, viewport: { width: 1280, height: 800 }, hasTouch: true });
  contexts.push(context);
  const page = await context.newPage();
  await openApp(page, '&test=1');
  // No sign-in: the device syncs as soon as the app has loaded.
  await expect(page.getByTestId('sync-button')).toHaveAttribute('data-sync-state', 'synced');
  await expect.poll(() => page.evaluate(() => (window as never as { __dacRuntime: { sync: { previewsReady: boolean } } }).__dacRuntime.sync.previewsReady)).toBe(true);
  return { context, page, input: await Input.create(page) };
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

function syncStatus(page: Page): Promise<SyncStatus> {
  return page.evaluate(() => (window as never as { __dacRuntime: { sync: { getStatus(): SyncStatus } } }).__dacRuntime.sync.getStatus());
}

function remotePreviews(page: Page): Promise<number> {
  return page.evaluate(() => (window as never as { __dac: { engine: { remotePreviews: Map<string, unknown> } } }).__dac.engine.remotePreviews.size);
}

/** What the server stored for the chart this page shows. */
async function serverRows(s: RunningServer, page: Page) {
  const key = await page.evaluate(() => (window as never as { __dac: { chartKey: { provider: string; symbol: string; timeframe: string } } }).__dac.chartKey);
  return s.store.pull('local', key, null, 100);
}

test.describe('sync through the self-hosted server', () => {
  test('a drawing made on one device appears on the other; erasing it there removes it here', async ({ browser }) => {
    const s = await server();
    const a = await openDevice(browser, s);
    const b = await openDevice(browser, s);

    await drawStroke(a, 0.4);
    const [drawn] = await drawings(a.page);
    await expect.poll(() => drawings(b.page)).toEqual([drawn]); // identical, not just "some drawing"
    expect(await serverRows(s, a.page)).toMatchObject([{ id: drawn.id, rev: 1, deleted: false }]);

    await b.page.getByTestId('tool-eraser').click();
    const box = await paneBox(b.page);
    await b.input.penStroke(lerpPoints({ x: box.x + box.width * 0.5, y: box.y + box.height * 0.2 }, { x: box.x + box.width * 0.5, y: box.y + box.height * 0.7 }, 20));
    await expect.poll(async () => (await drawings(a.page)).length).toBe(0);
    await expect.poll(() => serverRows(s, a.page)).toMatchObject([{ id: drawn.id, rev: 2, deleted: true }]);
  });

  test('a Wyckoff label stamped on one device appears on the other', async ({ browser }) => {
    const s = await server();
    const a = await openDevice(browser, s);
    const b = await openDevice(browser, s);
    await a.page.getByTestId('tool-stamp').click();
    await a.page.getByTestId('stamp-utad').click();
    const box = await paneBox(a.page);
    await a.input.penStroke([{ x: box.x + box.width * 0.6, y: box.y + box.height * 0.3 }]);
    const [stamp] = await drawings(a.page);
    expect(stamp).toMatchObject({ kind: 'stamp', label: 'UTAD' });
    await expect.poll(() => drawings(b.page)).toEqual([stamp]);
    expect(await serverRows(s, a.page)).toMatchObject([{ id: stamp.id, kind: 'stamp', rev: 1, deleted: false }]);
  });

  test('the stroke in progress is previewed live on the other device, then replaced by the saved drawing', async ({ browser }) => {
    const s = await server();
    const a = await openDevice(browser, s);
    const b = await openDevice(browser, s);
    const box = await paneBox(a.page);
    const pts = lerpPoints({ x: box.x + box.width * 0.3, y: box.y + box.height * 0.5 }, { x: box.x + box.width * 0.7, y: box.y + box.height * 0.55 }, 40, 6);

    await a.input.penDown(pts[0]);
    for (const p of pts.slice(1, 25)) await a.input.penMove(p);
    await expect.poll(() => remotePreviews(b.page)).toBe(1);
    expect(await drawings(b.page)).toHaveLength(0); // shown while drawing, not saved
    expect(await serverRows(s, a.page)).toHaveLength(0);

    for (const p of pts.slice(25)) await a.input.penMove(p);
    await a.input.penUp(pts[pts.length - 1]);
    await expect.poll(async () => (await drawings(b.page)).length).toBe(1);
    await expect.poll(() => remotePreviews(b.page)).toBe(0);
  });

  test('a device that opens the app later gets the existing drawings', async ({ browser }) => {
    const s = await server();
    const a = await openDevice(browser, s);
    await drawStroke(a, 0.4);
    await drawStroke(a, 0.6);
    await expect.poll(async () => (await syncStatus(a.page)).pending).toBe(0);
    const late = await openDevice(browser, s);
    await expect.poll(async () => (await drawings(late.page)).map((d) => d.id).sort()).toEqual((await drawings(a.page)).map((d) => d.id).sort());
  });

  test('changes made offline are queued and delivered when the device reconnects', async ({ browser }) => {
    const s = await server();
    const a = await openDevice(browser, s);
    const b = await openDevice(browser, s);

    await a.context.setOffline(true);
    await drawStroke(a, 0.5);
    await expect.poll(() => syncStatus(a.page)).toMatchObject({ state: 'offline', pending: 1 });
    await expect(a.page.getByTestId('pending-count')).toHaveText('1');
    await a.page.waitForTimeout(1_000);
    expect(await serverRows(s, a.page)).toHaveLength(0);
    expect(await drawings(b.page)).toHaveLength(0);

    await a.context.setOffline(false);
    await expect.poll(async () => (await drawings(b.page)).length).toBe(1);
    await expect.poll(() => syncStatus(a.page)).toMatchObject({ state: 'synced', pending: 0, error: null });
  });

  test('concurrent edits: the server version wins and both devices converge', async ({ browser }) => {
    const s = await server();
    const a = await openDevice(browser, s);
    const b = await openDevice(browser, s);
    await drawStroke(a, 0.4);
    const [drawn] = await drawings(a.page);
    await expect.poll(async () => (await drawings(b.page)).length).toBe(1);
    await expect.poll(() => syncStatus(a.page)).toMatchObject({ state: 'synced', pending: 0 });

    await a.context.setOffline(true);
    await recolor(a.page, drawn.id, '#ff6b6b'); // edited offline on A, based on rev 1
    await expect.poll(() => syncStatus(a.page)).toMatchObject({ pending: 1 });
    await recolor(b.page, drawn.id, '#4cc9f0'); // edited on B meanwhile: rev 2
    await expect.poll(async () => (await serverRows(s, b.page))[0]?.rev).toBe(2);

    await a.context.setOffline(false);
    await expect.poll(async () => (await drawings(a.page))[0]?.style.color).toBe('#4cc9f0');
    await expect.poll(() => syncStatus(a.page)).toMatchObject({ state: 'synced', pending: 0 });
    expect((await serverRows(s, a.page))[0]).toMatchObject({ rev: 2, data: { style: { color: '#4cc9f0' } } });
    expect((await drawings(b.page))[0].style.color).toBe('#4cc9f0');
  });

  test('a lost response followed by another edit is applied, not reported as a conflict', async ({ browser }) => {
    const s = await server();
    const a = await openDevice(browser, s);
    const bodies: Array<{ changes: Array<{ op_id: string; base_rev: number; prev_op_ids: string[] }> }> = [];
    let lostOp: string | null = null;
    await a.page.route('**/api/changes', async (route) => {
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
    await expect.poll(() => serverRows(s, a.page)).toMatchObject([{ id: drawn.id, rev: 1 }]);
    await expect.poll(async () => (await syncStatus(a.page)).state).toBe('error');

    await recolor(a.page, drawn.id, '#ff6b6b');
    await expect.poll(() => serverRows(s, a.page)).toMatchObject([{ id: drawn.id, rev: 2, data: { style: { color: '#ff6b6b' } } }]);
    await expect.poll(() => syncStatus(a.page)).toMatchObject({ state: 'synced', pending: 0, error: null });
    // The edit went out on its original base, carrying the lost op as proof of authorship.
    expect(bodies[bodies.length - 1].changes[0]).toMatchObject({ base_rev: 0, prev_op_ids: [lostOp] });
  });

  test('a server rebuilt with an empty database gets the drawings back from the devices', async ({ browser }) => {
    const first = await server();
    const a = await openDevice(browser, first);
    await drawStroke(a, 0.4);
    const [drawn] = await drawings(a.page);
    await expect.poll(async () => (await serverRows(first, a.page)).length).toBe(1);

    await first.close();
    const rebuilt = await server({ port: first.port }); // e.g. the Docker volume was lost
    await expect.poll(() => serverRows(rebuilt, a.page), { timeout: 20_000 }).toMatchObject([{ id: drawn.id, deleted: false }]);
    const newcomer = await openDevice(browser, rebuilt);
    await expect.poll(() => drawings(newcomer.page)).toEqual([drawn]);
  });

  test('an expired proxy login (e.g. Cloudflare Access) offers "Sign in again", which resumes syncing', async ({ browser }) => {
    const s = await server();
    const a = await openDevice(browser, s);
    // The login proxy now redirects every API call to its login page.
    await a.page.route('**/api/changes', (route) => route.fulfill({ status: 302, headers: { Location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login' } }));
    await drawStroke(a, 0.4);
    await expect.poll(async () => (await syncStatus(a.page)).error).toBe('The sync server needs a new login');
    await a.page.getByTestId('sync-button').click();
    const signIn = a.page.getByTestId('sync-login');
    await expect(signIn).toBeVisible();
    expect(await signIn.getAttribute('href')).toMatch(/^\/api\/login\?next=%2F%3Fprovider%3Dmock/);

    await a.page.unroute('**/api/changes'); // logged in again at the proxy
    await signIn.click(); // a real navigation: /api/login redirects straight back into the app
    await expect(a.page).toHaveURL(/\/\?provider=mock/);
    await expect(a.page.getByTestId('sync-button')).toHaveAttribute('data-sync-state', 'synced');
    await expect.poll(async () => (await serverRows(s, a.page)).length).toBe(1); // the queued drawing went through
  });

  test('devices reconnect by themselves after a server restart and catch up', async ({ browser }) => {
    const dir = mkdtempSync(join(tmpdir(), 'dac-e2e-'));
    dirs.push(dir);
    const dbFile = join(dir, 'drawings.sqlite');
    const first = await server({ dbFile });
    const a = await openDevice(browser, first);
    const b = await openDevice(browser, first);
    await drawStroke(a, 0.3);
    await expect.poll(async () => (await drawings(b.page)).length).toBe(1);

    await first.close(); // e.g. `docker compose restart`
    await expect.poll(async () => (await syncStatus(b.page)).state).not.toBe('synced');
    await drawStroke(a, 0.6); // queued while the server is down
    await expect.poll(async () => (await syncStatus(a.page)).pending).toBe(1);

    await server({ port: first.port, dbFile }); // same address, same data
    await expect.poll(async () => (await drawings(b.page)).length, { timeout: 20_000 }).toBe(2);
    await expect.poll(() => syncStatus(a.page), { timeout: 20_000 }).toMatchObject({ state: 'synced', pending: 0 });
  });
});
