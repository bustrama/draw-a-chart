import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * One line per request (REQUEST_LOG=1), for debugging a login proxy in front of the server
 * (e.g. Cloudflare Access): which requests reach the server, as what kind of request, and how long
 * the proxy's access token is valid. Never logs the token, cookies, or any identity.
 */
export function logRequest(req: IncomingMessage, res: ServerResponse, startedAt: number, log: (message: string) => void): void {
  const path = (req.url ?? '/').split('?')[0];
  if (path.startsWith('/assets/')) return; // hashed bundles: noise
  const ms = Math.round(performance.now() - startedAt);
  const kind = `${header(req, 'sec-fetch-mode') ?? '-'}/${header(req, 'sec-fetch-dest') ?? '-'}`;
  log(`[req] ${req.method} ${path} ${res.statusCode} ${ms}ms ${kind} ${client(header(req, 'user-agent'))} ${accessToken(header(req, 'cf-access-jwt-assertion'))}`);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/** Browser family only (e.g. "Android/Chrome/app"), enough to tell the devices apart. */
export function client(ua: string | undefined): string {
  if (!ua) return 'no-ua';
  const os = /iPad|iPhone|Macintosh/.test(ua) ? 'Apple' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : 'other';
  const browser = /SamsungBrowser/.test(ua) ? 'Samsung' : /EdgA?\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'other';
  return `${os}/${browser}${/; wv\)/.test(ua) ? '/webview' : ''}`;
}

/** When the proxy's access token was issued and how long it is valid; never the token itself. */
export function accessToken(jwt: string | undefined): string {
  if (!jwt) return 'no-access-token';
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as { iat?: unknown; exp?: unknown };
    const iat = typeof payload.iat === 'number' ? payload.iat : null;
    const exp = typeof payload.exp === 'number' ? payload.exp : null;
    if (iat === null || exp === null) return 'access-token without iat/exp';
    const iso = (s: number) => new Date(s * 1000).toISOString().slice(0, 16) + 'Z';
    return `access-token issued ${iso(iat)} valid ${((exp - iat) / 3600).toFixed(1)}h (until ${iso(exp)})`;
  } catch {
    return 'access-token unreadable';
  }
}
