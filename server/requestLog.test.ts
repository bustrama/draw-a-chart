import { describe, expect, it } from 'vitest';
import { accessToken, client } from './requestLog.ts';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('request log', () => {
  it('reports how long an access token is valid, never the token', () => {
    const iat = Date.parse('2026-09-26T06:00:00Z') / 1000;
    const jwt = `${b64({ alg: 'RS256' })}.${b64({ iat, exp: iat + 24 * 3600, email: 'someone@example.com' })}.c2lnbmF0dXJl`;
    const text = accessToken(jwt);
    expect(text).toBe('access-token issued 2026-09-26T06:00Z valid 24.0h (until 2026-09-27T06:00Z)');
    expect(text).not.toContain(jwt.split('.')[1]);
    expect(text).not.toContain('someone');
    expect(accessToken(undefined)).toBe('no-access-token');
    expect(accessToken('garbage')).toBe('access-token unreadable');
  });

  it('names the browser family only', () => {
    expect(client('Mozilla/5.0 (Linux; Android 16; SM-S948B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36')).toBe('Android/Chrome');
    expect(client('Mozilla/5.0 (Linux; Android 16; SM-S948B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36')).toBe('Android/Samsung');
    expect(client('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15')).toBe('Apple/Safari');
    expect(client(undefined)).toBe('no-ua');
  });
});
