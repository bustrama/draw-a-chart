import { createReadStream, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Serves the built app (Vite's dist/). Unknown extension-less paths get index.html (the app's
 * own routes). Cache policy, which also applies to Cloudflare's edge cache:
 * - assets/* and workbox-*.js have content hashes in their names: cached for a year;
 * - index.html, sw.js and the manifest must reach devices as soon as they change: revalidated;
 * - everything else (icons): one hour.
 * Resolves false when there is nothing to serve (the caller answers 404).
 */
export function createStaticHandler(dir: string): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const root = resolve(dir);
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      return false;
    }
    // No NUL bytes, no dot-files, and nothing outside the root (after `..` is resolved).
    if (pathname.includes('\0') || pathname.split(/[/\\]/).some((part) => part.startsWith('.') && part !== '')) return false;
    let file = resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(root + sep)) return false;

    let info = await fileStat(file);
    if (info?.isDirectory()) {
      file = join(file, 'index.html');
      info = await fileStat(file);
    }
    if (!info?.isFile() && extname(pathname) === '') {
      file = join(root, 'index.html');
      info = await fileStat(file);
    }
    if (!info?.isFile()) return false;

    const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', cachePolicy(relative(root, file).split(sep).join('/')));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304).end();
      return true;
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': info.size });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    await new Promise<void>((done) => {
      const stream = createReadStream(file);
      stream.on('error', () => {
        res.destroy();
        done();
      });
      stream.on('end', done);
      stream.pipe(res);
    });
    return true;
  };
}

function cachePolicy(path: string): string {
  if (path.startsWith('assets/') || /^workbox-[\w-]+\.js$/.test(path)) return 'public, max-age=31536000, immutable';
  if (path === 'index.html' || path === 'sw.js' || path.endsWith('.webmanifest')) return 'no-cache';
  return 'public, max-age=3600';
}

async function fileStat(file: string): Promise<Stats | null> {
  try {
    return await stat(file);
  } catch {
    return null;
  }
}
