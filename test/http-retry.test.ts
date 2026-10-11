import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { isResetError, withHttpRetry } from './http-retry';

let server: http.Server | undefined;
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise((resolve) => server!.close(resolve));
  server = undefined;
});

async function serve(handler: http.RequestListener) {
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('the test fetch wrapper', () => {
  it('asks the server to close the connection after each request', async () => {
    const seen: (string | undefined)[] = [];
    const base = await serve((req, res) => { seen.push(req.headers.connection); res.end('ok'); });
    const fetcher = withHttpRetry(fetch, () => {});
    await (await fetcher(`${base}/a`)).text();
    await (await fetcher(`${base}/b`, { headers: { connection: 'keep-alive' } })).text();
    expect(seen).toEqual(['close', 'keep-alive']);
  });

  const reset = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });

  it('retries a GET once after a reset socket and says so', async () => {
    let calls = 0;
    const base = (async () => {
      calls++;
      if (calls === 1) throw reset();
      return new Response('second');
    }) as typeof fetch;
    const lines: string[] = [];
    const res = await withHttpRetry(base, (line) => lines.push(line))('http://relay.test/x');
    expect(await res.text()).toBe('second');
    expect(calls).toBe(2);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[http-retry] GET http://relay.test/x');
  });

  it('does not retry a POST, a non-reset error, or a second reset', async () => {
    let calls = 0;
    const lines: string[] = [];
    const resetting = withHttpRetry((async () => { calls++; throw reset(); }) as typeof fetch, (line) => lines.push(line));
    await expect(resetting('http://relay.test/post', { method: 'POST', body: 'x' })).rejects.toThrow('fetch failed');
    expect(calls).toBe(1);
    calls = 0;
    await expect(resetting('http://relay.test/get')).rejects.toThrow('fetch failed');
    expect(calls).toBe(2);
    expect(lines).toHaveLength(1);
    let other = 0;
    const failing = withHttpRetry((async () => { other++; throw new TypeError('bad url'); }) as typeof fetch, () => {});
    await expect(failing('http://x.invalid/')).rejects.toThrow('bad url');
    expect(other).toBe(1);
  });

  it('recognises reset codes on the error or its cause', () => {
    expect(isResetError(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('r'), { code: 'ECONNRESET' }) }))).toBe(true);
    expect(isResetError(Object.assign(new Error('s'), { code: 'UND_ERR_SOCKET' }))).toBe(true);
    expect(isResetError(new Error('other'))).toBe(false);
  });
});
