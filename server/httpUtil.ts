import type { IncomingMessage, ServerResponse } from 'node:http';

/** An error answered with its status and `{ error: message }`. */
export class HttpError extends Error {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  constructor(status: number, message: string, headers: Readonly<Record<string, string>> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

export function allow(req: IncomingMessage, method: 'GET' | 'POST'): void {
  if (req.method === method || (method === 'GET' && req.method === 'HEAD')) return;
  throw new HttpError(405, 'method not allowed', { Allow: method === 'GET' ? 'GET, HEAD' : method });
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}
