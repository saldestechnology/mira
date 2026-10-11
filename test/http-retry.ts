// Real-HTTP tests talk to a relay child process through Node's global fetch (undici), which keeps idle sockets for reuse.
// A test that blocks its event loop (a synchronous seed, a heavy build) can outlive the server's keep-alive timeout, and the
// next request then reuses a socket the server already closed: `fetch failed`, caused by ECONNRESET. That showed up three
// times in one day on Windows CI, each time on the first request after a heavy step (docs/chat-api-flake.md).
//
// installHttpRetry wraps fetch so that (1) requests ask for `connection: close`, so no idle socket is ever reused, and
// (2) a GET or HEAD that still fails with a reset socket is tried ONCE more, with a line in the test output so a retry is
// never silent. Other methods, other errors and a second failure are not touched: a real failure still fails the test.

const RESET_CODES = new Set(['ECONNRESET', 'UND_ERR_SOCKET']);

export function isResetError(err: unknown): boolean {
  for (let e = err as { code?: string; cause?: unknown } | undefined, depth = 0; e && depth < 4; e = e.cause as typeof e, depth++) {
    if (typeof e.code === 'string' && RESET_CODES.has(e.code)) return true;
  }
  return false;
}

type Fetch = typeof fetch;

export function withHttpRetry(base: Fetch, warn: (line: string) => void = (line) => console.warn(line)): Fetch {
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let next = init;
    if (typeof input === 'string' || input instanceof URL) {
      const headers = new Headers(init?.headers);
      if (!headers.has('connection')) headers.set('connection', 'close');
      next = { ...init, headers };
    }
    const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    try {
      return await base(input, next);
    } catch (err) {
      const safe = (method === 'GET' || method === 'HEAD') && !init?.body && !(input instanceof Request);
      if (!safe || !isResetError(err)) throw err;
      warn(`[http-retry] ${method} ${String(input instanceof URL ? input.href : input)} failed with a reset socket (${(err as { cause?: { code?: string } }).cause?.code ?? 'reset'}); retrying once`);
      return base(input, next);
    }
  }) as Fetch;
  return wrapped;
}

let installed = false;

/** Wraps the global fetch once per test file worker. */
export function installHttpRetry(): void {
  if (installed || typeof globalThis.fetch !== 'function') return;
  installed = true;
  globalThis.fetch = withHttpRetry(globalThis.fetch.bind(globalThis));
}
