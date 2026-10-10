import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApi, type Me, type ServerBoard } from '../src/api';
import {
  authState,
  cacheServerBoards,
  cachedServerBoards,
  initAuth,
  isHostedWorkspace,
  onAuth,
  setSignedIn,
  signOut,
  type AuthState,
} from '../src/auth';

type Call = { url: string; init: RequestInit };
type Reply = (call: Call) => Response | Promise<Response>;

function recorder(reply: Reply) {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return reply(call);
  }) as typeof fetch;
  return { fetchFn, calls };
}

type Route = () => Response | Promise<Response>;

function serve(routes: Record<string, Route>) {
  return recorder(({ url }) => {
    const route = routes[url];
    return route ? route() : json({ error: 'not_found' }, 404);
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function headersOf(call: Call): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

const networkDown = () => Promise.reject(new TypeError('Failed to fetch'));

const me: Me = {
  user: { id: 'u1', email: 'ana@example.com', name: 'Ana', role: 'member' },
  teams: [{ id: 't1', name: 'Design', role: 'admin' }],
};

function board(id: string, updatedAt: number): ServerBoard {
  return { id, title: id, teamId: null, ownerId: 'u1', role: 'owner', createdAt: 0, updatedAt };
}

const store = new Map<string, string>();
const storageStub = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    store.set(key, String(value));
  },
  removeItem: (key: string) => {
    store.delete(key);
  },
  clear: () => {
    store.clear();
  },
};

beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', storageStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api client requests', () => {
  it('sends mutating calls with the CSRF header, JSON body and same-origin credentials', async () => {
    const { fetchFn, calls } = recorder(() => json({ id: 't2', name: 'Ops', role: 'admin', memberCount: 1, archived: false }, 201));
    const team = await createApi(fetchFn).createTeam('Ops');
    const call = calls[0];
    expect(call.url).toBe('/api/teams');
    expect(call.init.method).toBe('POST');
    expect(call.init.credentials).toBe('same-origin');
    expect(headersOf(call)).toMatchObject({ 'x-tabula': '1', 'content-type': 'application/json', accept: 'application/json' });
    expect(JSON.parse(String(call.init.body))).toEqual({ name: 'Ops' });
    expect(team.name).toBe('Ops');
  });

  it('sends GETs without a body, CSRF header or content type', async () => {
    const { fetchFn, calls } = recorder(() => json([]));
    await createApi(fetchFn).teams();
    const call = calls[0];
    expect(call.init.method).toBe('GET');
    expect(call.init.credentials).toBe('same-origin');
    expect(call.init.body).toBeUndefined();
    expect(headersOf(call)['x-tabula']).toBeUndefined();
    expect(headersOf(call)['content-type']).toBeUndefined();
    expect(headersOf(call).accept).toBe('application/json');
  });

  it('sends bodiless mutations with the CSRF header and no content type', async () => {
    const { fetchFn, calls } = recorder(() => new Response(null, { status: 204 }));
    await expect(createApi(fetchFn).logout()).resolves.toBeUndefined();
    const call = calls[0];
    expect(call.init.method).toBe('POST');
    expect(call.init.body).toBeUndefined();
    expect(headersOf(call)['x-tabula']).toBe('1');
    expect(headersOf(call)['content-type']).toBeUndefined();
  });

  it('omits undefined optional fields from the request body', async () => {
    const { fetchFn, calls } = recorder(() => json({ ok: true }));
    await createApi(fetchFn).requestLogin('ana@example.com');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ email: 'ana@example.com' });
  });

  it('maps every endpoint to the documented method and path', async () => {
    const { fetchFn, calls } = recorder(() => json({}));
    const client = createApi(fetchFn);
    await client.config();
    await client.me();
    await client.updateMe('Ana');
    await client.requestLogin('ana@example.com', 'inv');
    await client.verifyLogin('tok');
    await client.logout();
    await client.logoutAll();
    await client.teams();
    await client.createTeam('Ops');
    await client.updateTeam('t1', { archived: true });
    await client.teamMembers('t1');
    await client.setTeamRole('t1', 'u1', 'admin');
    await client.removeTeamMember('t1', 'u1');
    await client.createInvite('t1', { days: 7 });
    await client.listInvites('t1');
    await client.revokeInvite('t1', 'i1');
    await client.invitePreview('tok');
    await client.boards();
    await client.createBoard({ id: 'b1' });
    await client.updateBoard('b1', { title: 'x' });
    await client.deleteBoard('b1');
    await client.shares('b1');
    await client.share('b1', { principalType: 'team', principalId: 't1', role: 'editor' });
    await client.unshare('b1', 'team', 't1');
    await client.members();
    await client.updateMember('u1', { disabled: true });
    await client.removeMember('u1');
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'GET /api/config',
      'GET /api/me',
      'PATCH /api/me',
      'POST /api/auth/request',
      'POST /api/auth/verify',
      'POST /api/auth/logout',
      'POST /api/auth/logout-all',
      'GET /api/teams',
      'POST /api/teams',
      'PATCH /api/teams/t1',
      'GET /api/teams/t1/members',
      'PATCH /api/teams/t1/members/u1',
      'DELETE /api/teams/t1/members/u1',
      'POST /api/teams/t1/invites',
      'GET /api/teams/t1/invites',
      'DELETE /api/teams/t1/invites/i1',
      'GET /api/invites/tok',
      'GET /api/boards',
      'POST /api/boards',
      'PATCH /api/boards/b1',
      'DELETE /api/boards/b1',
      'GET /api/boards/b1/shares',
      'POST /api/boards/b1/shares',
      'DELETE /api/boards/b1/shares/team/t1',
      'GET /api/members',
      'PATCH /api/members/u1',
      'DELETE /api/members/u1',
    ]);
  });

  it('encodes every path segment', async () => {
    const { fetchFn, calls } = recorder(() => json({}));
    const client = createApi(fetchFn);
    await client.deleteBoard('a/b c');
    await client.invitePreview('tok/en+1 x');
    await client.unshare('b1', 'user', 'x/y?z');
    expect(calls.map((c) => c.url)).toEqual([
      '/api/boards/a%2Fb%20c',
      '/api/invites/tok%2Fen%2B1%20x',
      '/api/boards/b1/shares/user/x%2Fy%3Fz',
    ]);
  });

  it('resolves 204 responses to undefined', async () => {
    const { fetchFn } = recorder(() => new Response(null, { status: 204 }));
    await expect(createApi(fetchFn).removeMember('u1')).resolves.toBeUndefined();
  });

  it('resolves an empty success body to undefined', async () => {
    const { fetchFn } = recorder(() => new Response(null, { status: 201 }));
    await expect(createApi(fetchFn).share('b1', { principalType: 'user', principalId: 'u1', role: 'viewer' })).resolves.toBeUndefined();
  });
});

describe('api client errors', () => {
  it('turns a JSON error body into ApiError with its code and message', async () => {
    const { fetchFn } = recorder(() => json({ error: 'forbidden', message: 'Not your team' }, 403));
    const client = createApi(fetchFn);
    await expect(client.updateTeam('t1', { name: 'x' })).rejects.toBeInstanceOf(ApiError);
    await expect(client.updateTeam('t1', { name: 'x' })).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
      message: 'Not your team',
    });
  });

  it('uses the code as the message when the body has none', async () => {
    const { fetchFn } = recorder(() => json({ error: 'not_found' }, 404));
    await expect(createApi(fetchFn).boards()).rejects.toMatchObject({ status: 404, code: 'not_found', message: 'not_found' });
  });

  it('does not crash on a non-JSON error body', async () => {
    const { fetchFn } = recorder(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    await expect(createApi(fetchFn).boards()).rejects.toMatchObject({ status: 502, code: 'unknown', message: 'unknown' });
  });

  it('turns a non-JSON success body into ApiError instead of resolving', async () => {
    const { fetchFn } = recorder(() => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    await expect(createApi(fetchFn).config()).rejects.toMatchObject({ status: 200, code: 'unknown' });
  });

  it('turns a rejected fetch into a network error with status 0', async () => {
    const { fetchFn } = recorder(networkDown);
    await expect(createApi(fetchFn).boards()).rejects.toBeInstanceOf(ApiError);
    await expect(createApi(fetchFn).boards()).rejects.toMatchObject({ status: 0, code: 'network' });
  });

  it.each([307, 308, 502, 504])('preserves upload failure status %i without following a redirect', async (status) => {
    let init: RequestInit | undefined;
    const fetchFn = (async (_input: RequestInfo | URL, request?: RequestInit) => {
      init = request;
      return new Response(null, { status });
    }) as typeof fetch;

    await expect(createApi(fetchFn).uploadAsset('b1', new Blob([new Uint8Array([1])]), 'image/png'))
      .rejects.toMatchObject({ status });
    expect(init?.redirect).toBe('manual');
  });

  it('turns an opaque upload redirect into a numeric retryable error', async () => {
    const response = new Response(null, { status: 200 });
    Object.defineProperty(response, 'type', { value: 'opaqueredirect' });
    const fetchFn = (async () => response) as typeof fetch;

    await expect(createApi(fetchFn).uploadAsset('b1', new Blob([new Uint8Array([1])]), 'image/png'))
      .rejects.toMatchObject({ status: 307, code: 'redirect' });
  });
});

describe('initAuth', () => {
  it('derives hosted mode from the existing /api/me workspace field', () => {
    const workspace = { readOnly: false, banner: null, seatLimit: 4, seatsUsed: 2 };
    expect(isHostedWorkspace({ mode: 'open' })).toBe(false);
    expect(isHostedWorkspace({ mode: 'signed-in', me })).toBe(false);
    expect(isHostedWorkspace({ mode: 'signed-in', me: { ...me, workspace } })).toBe(true);
    expect(isHostedWorkspace({ mode: 'offline', me: { ...me, workspace } })).toBe(true);
    expect(isHostedWorkspace({ mode: 'offline', me: null })).toBe(false);
  });

  it('stays in open mode without calling me when accounts are off', async () => {
    const { fetchFn, calls } = serve({ '/api/config': () => json({ authEnabled: false }) });
    expect(await initAuth(createApi(fetchFn))).toEqual({ mode: 'open' });
    expect(calls.map((c) => c.url)).toEqual(['/api/config']);
  });

  it('signs in and caches the account when the session is valid', async () => {
    const { fetchFn } = serve({
      '/api/config': () => json({ authEnabled: true }),
      '/api/me': () => json(me),
    });
    expect(await initAuth(createApi(fetchFn))).toEqual({ mode: 'signed-in', me });
    expect(JSON.parse(store.get('driftboard:me') ?? 'null')).toEqual(me);
  });

  it('goes signed out on 401 and drops the cached account', async () => {
    store.set('driftboard:me', JSON.stringify(me));
    const { fetchFn } = serve({
      '/api/config': () => json({ authEnabled: true }),
      '/api/me': () => json({ error: 'unauthenticated' }, 401),
    });
    expect(await initAuth(createApi(fetchFn))).toEqual({ mode: 'signed-out' });
    expect(store.has('driftboard:me')).toBe(false);
  });

  it('is offline with the cached account on a server error', async () => {
    store.set('driftboard:me', JSON.stringify(me));
    const { fetchFn } = serve({
      '/api/config': () => json({ authEnabled: true }),
      '/api/me': () => json({ error: 'internal' }, 500),
    });
    expect(await initAuth(createApi(fetchFn))).toEqual({ mode: 'offline', me });
  });

  it('is offline with the cached account after a network failure', async () => {
    store.set('driftboard:me', JSON.stringify(me));
    const { fetchFn } = serve({
      '/api/config': () => json({ authEnabled: true }),
      '/api/me': networkDown,
    });
    expect(await initAuth(createApi(fetchFn))).toEqual({ mode: 'offline', me });
  });

  it('is offline without an account when there is no cache and the server errors', async () => {
    const { fetchFn } = serve({
      '/api/config': () => json({ authEnabled: true }),
      '/api/me': () => json({ error: 'internal' }, 500),
    });
    expect(await initAuth(createApi(fetchFn))).toEqual({ mode: 'offline', me: null });
  });

  const htmlPage: Route = () =>
    new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  const configFailures: [string, Route][] = [
    ['404', () => json({ error: 'not_found' }, 404)],
    ['HTML 200', htmlPage],
    ['network failure', networkDown],
  ];

  it.each(configFailures)('opens the app when config fails (%s) and nothing is cached', async (_name, route) => {
    const { fetchFn, calls } = serve({ '/api/config': route });
    expect(await initAuth(createApi(fetchFn))).toEqual({ mode: 'open' });
    expect(calls.map((c) => c.url)).toEqual(['/api/config']);
  });

  it.each(configFailures)('uses the cached account when config fails (%s)', async (_name, route) => {
    store.set('driftboard:me', JSON.stringify(me));
    const { fetchFn, calls } = serve({ '/api/config': route });
    expect(await initAuth(createApi(fetchFn))).toEqual({ mode: 'offline', me });
    expect(calls.map((c) => c.url)).toEqual(['/api/config']);
  });
});

describe('auth state', () => {
  it('notifies listeners until they unsubscribe', () => {
    const seen: AuthState[] = [];
    const stop = onAuth((s) => {
      seen.push(s);
    });
    setSignedIn(me);
    stop();
    setSignedIn(me);
    expect(seen).toEqual([{ mode: 'signed-in', me }]);
    expect(authState()).toEqual({ mode: 'signed-in', me });
  });

  it('signOut logs out on the server and clears the cached account and boards', async () => {
    setSignedIn(me);
    cacheServerBoards([board('b1', 1)]);
    const { fetchFn, calls } = serve({ '/api/auth/logout': () => new Response(null, { status: 204 }) });
    await signOut(createApi(fetchFn));
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual(['POST /api/auth/logout']);
    expect(authState()).toEqual({ mode: 'signed-out' });
    expect(store.has('driftboard:me')).toBe(false);
    expect(cachedServerBoards()).toEqual([]);
  });
});

describe('server board cache', () => {
  it('returns cached boards newest-updated first', () => {
    cacheServerBoards([board('old', 1), board('new', 5)]);
    expect(cachedServerBoards().map((b) => b.id)).toEqual(['new', 'old']);
  });

  it('returns no boards when the cache is corrupt', () => {
    store.set('driftboard:server-boards', '{not json');
    expect(cachedServerBoards()).toEqual([]);
  });

  it('keeps working when storage throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    vi.stubGlobal('localStorage', broken);
    expect(() => cacheServerBoards([board('b1', 1)])).not.toThrow();
    expect(cachedServerBoards()).toEqual([]);
  });
});
