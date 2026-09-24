import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from './http.ts';

let dir: string;
let server: RunningServer;

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), 'dac-static-'));
  dir = join(base, 'dist');
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>app</title>');
  writeFileSync(join(dir, 'sw.js'), 'self.addEventListener("fetch", () => {});');
  writeFileSync(join(dir, 'manifest.webmanifest'), '{"name":"Draw-a-Chart"}');
  writeFileSync(join(dir, 'assets', 'index-AbC123.js'), 'console.log(1);');
  writeFileSync(join(dir, 'pwa-192x192.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(dir, '.env'), 'SECRET=1');
  writeFileSync(join(base, 'outside.txt'), 'not public');
  server = await startServer({ host: '127.0.0.1', staticDir: dir, log: () => undefined });
});

afterAll(async () => {
  await server.close();
  rmSync(join(dir, '..'), { recursive: true, force: true });
});

/** Raw request, so paths like /../ reach the server unnormalized. */
function get(path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.port, path, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('static file serving', () => {
  it('serves the app shell, assets and the manifest with the right types and cache policy', async () => {
    const index = await get('/');
    expect(index.status).toBe(200);
    expect(index.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(index.headers['cache-control']).toBe('no-cache');
    const asset = await get('/assets/index-AbC123.js');
    expect(asset.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await get('/sw.js')).headers['cache-control']).toBe('no-cache');
    const manifest = await get('/manifest.webmanifest');
    expect(manifest.headers['content-type']).toBe('application/manifest+json; charset=utf-8');
    expect(manifest.headers['cache-control']).toBe('no-cache');
    expect((await get('/pwa-192x192.png')).headers['cache-control']).toBe('public, max-age=3600');
  });

  it('answers app routes with index.html but missing files with 404', async () => {
    const route = await get('/some/app/route');
    expect(route.status).toBe(200);
    expect(route.body).toContain('<title>app</title>');
    expect((await get('/assets/missing.js')).status).toBe(404);
  });

  it('never serves files outside the directory or dot-files', async () => {
    for (const path of ['/../outside.txt', '/%2e%2e/outside.txt', '/assets/..%2f..%2foutside.txt', '/..%5coutside.txt', '/.env', '/%00index.html']) {
      const res = await get(path);
      expect(res.body, path).not.toContain('not public');
      expect(res.body, path).not.toContain('SECRET');
      expect(res.status, path).toBe(404);
    }
  });

  it('revalidates with ETags and answers HEAD without a body', async () => {
    const first = await get('/sw.js');
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^W\//);
    expect((await get('/sw.js', { 'If-None-Match': etag })).status).toBe(304);
    const head = await get('/sw.js', {}, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe(String(first.body.length));
    expect(head.body).toBe('');
    expect((await get('/sw.js', {}, 'DELETE')).status).toBe(404);
  });

  it('leaves /api to the sync API', async () => {
    const res = await get('/api/health');
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
  });
});
