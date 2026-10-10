import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { startRelayProcess } from './start-relay';

// The relay runs as a child process in accounts mode, exactly as `npm start` would.

let PORT = 0;
let baseUrl = '';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-accounts-'));
const outbox = path.join(dataDir, 'outbox.jsonl');
const OWNER = 'owner@example.com';

type Body = any;
type Res = { status: number; body: Body; headers: Headers };
type Account = { cookie: string; user: Body; email: string };

let relay: ChildProcess;
let owner: Account;

type Server = { port: number; base: string; dir: string; proc: ChildProcess };

const startRelay = (dir = dataDir, env: Record<string, string> = {}) => startRelayProcess({
  envFor: (port) => ({
    ...(process.env as Record<string, string>),
    PORT: String(port),
    DATA_DIR: dir,
    HOST: '127.0.0.1',
    TABULA_AUTH: 'on',
    TABULA_OWNER_EMAIL: OWNER,
    TABULA_MAIL: 'file',
    TABULA_BASE_URL: `http://127.0.0.1:${port}`,
    TABULA_TRUST_PROXY: '1',
    ...env,
  }),
});

const stopRelay = (p: ChildProcess) =>
  new Promise<void>((r) => {
    if (p.exitCode !== null || p.signalCode !== null) return r();
    p.once('exit', () => r());
    p.kill('SIGTERM');
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const until = async (fn: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await sleep(20);
  }
};

const within = <T>(p: Promise<T>, ms = 4000) =>
  Promise.race([p, sleep(ms).then(() => Promise.reject(new Error('timed out')))]) as Promise<T>;

// ---------------------------------------------------------------- http helpers

let seq = 0;
const unique = (tag: string) => `${tag}${++seq}x${Math.random().toString(36).slice(2, 7)}`;
const emailOf = (tag: string) => `${unique(tag)}@example.com`;
let ipSeq = 0;
const nextIp = () => `10.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}.7`;

async function api(cookie: string | undefined, method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: {
      'x-tabula': '1',
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
}

type Mail = { to: string; subject: string; text: string };
const mailCount = () => (fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean).length : 0);
const mailsSince = (n: number): Mail[] =>
  fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean).slice(n).map((l) => JSON.parse(l));
const tokenOf = (mail: Mail) => decodeURIComponent(/token=([^\s&]+)/.exec(mail.text)![1]);

async function requestLink(email: string, invite?: string, ip = nextIp()) {
  const before = mailCount();
  const res = await api(undefined, 'POST', '/api/auth/request', { email, invite }, { 'x-forwarded-for': ip });
  return { res, mails: mailCount() > before ? mailsSince(before) : [] };
}

async function signIn(email: string, invite?: string): Promise<Account & { setCookie: string }> {
  const { res, mails } = await requestLink(email, invite);
  if (res.status !== 200 || mails.length !== 1) throw new Error(`no sign-in mail for ${email} (status ${res.status})`);
  const verify = await api(undefined, 'POST', '/api/auth/verify', { token: tokenOf(mails[0]) });
  if (verify.status !== 200) throw new Error(`verify failed with ${verify.status}`);
  const setCookie = verify.headers.getSetCookie()[0];
  return { cookie: /tabula_session=[^;]+/.exec(setCookie)![0], user: verify.body.user, email, setCookie };
}

async function newTeam(cookie: string, name = unique('Team')) {
  const res = await api(cookie, 'POST', '/api/teams', { name });
  if (res.status !== 201) throw new Error(`could not create a team (${res.status})`);
  return res.body as Body;
}

async function inviteToken(cookie: string, teamId: string, role: 'member' | 'admin' = 'member') {
  const res = await api(cookie, 'POST', `/api/teams/${teamId}/invites`, { role });
  if (res.status !== 201) throw new Error(`could not create an invite (${res.status})`);
  return res.body.token as string;
}

async function joinTeam(adminCookie: string, teamId: string, role: 'member' | 'admin' = 'member') {
  return signIn(emailOf('user'), await inviteToken(adminCookie, teamId, role));
}

async function newBoard(cookie: string, extra: Record<string, unknown> = {}) {
  const id = unique('board');
  const res = await api(cookie, 'POST', '/api/boards', { id, ...extra });
  if (res.status !== 201) throw new Error(`could not create a board (${res.status} ${JSON.stringify(res.body)})`);
  return id;
}

const roleOn = async (cookie: string, board: string) =>
  ((await api(cookie, 'GET', '/api/boards')).body as Body[]).find((b) => b.id === board)?.role ?? null;

// ---------------------------------------------------------------- websocket helpers

const wsHeaders = (cookie?: string): Record<string, string> => ({ Origin: baseUrl, ...(cookie ? { Cookie: cookie } : {}) });
const wsUrl = (board: string) => `ws://127.0.0.1:${PORT}/sync/${board}`;

const sockets = new Set<WebSocket>();
const providers = new Set<WebsocketProvider>();

afterEach(() => {
  for (const ws of sockets) ws.terminate();
  sockets.clear();
  for (const p of providers) p.destroy();
  providers.clear();
});

function rawSocket(board: string, cookie?: string, headers: Record<string, string> = wsHeaders(cookie), port = PORT) {
  const ws = new WebSocket(wsUrl(board).replace(`:${PORT}/`, `:${port}/`), { headers });
  sockets.add(ws);
  ws.on('error', () => {});
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  const joined = new Promise<void>((resolve) => ws.once('message', () => resolve()));
  const rejected = new Promise<number>((resolve) => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)));
  return { ws, closed, joined, rejected };
}

const updateFrame = () => {
  const doc = new Y.Doc();
  doc.getMap('objects').set('sneaky', 1);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(doc));
  return encoding.toUint8Array(enc);
};

const wsFor = (cookie: string) =>
  class extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols, { headers: wsHeaders(cookie) });
    }
  };

function connect(board: string, cookie: string) {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`ws://127.0.0.1:${PORT}/sync`, board, doc, {
    WebSocketPolyfill: wsFor(cookie) as unknown as typeof globalThis.WebSocket,
    disableBc: true,
  });
  providers.add(provider);
  return { doc, provider };
}

const synced = (c: ReturnType<typeof connect>) => until(() => c.provider.wsconnected && c.provider.synced);

const peers = (c: ReturnType<typeof connect>, name: string) =>
  [...c.provider.awareness.getStates().values()].some((s) => s.user?.name === name);

/** Awareness sent after a document edit reaches the other side after that edit would have, if it were allowed. */
async function flush(from: ReturnType<typeof connect>, to: ReturnType<typeof connect>) {
  const name = unique('marker');
  from.provider.awareness.setLocalStateField('user', { name });
  await until(() => peers(to, name));
}

// ---------------------------------------------------------------- the suite

describe('accounts mode server', () => {
  beforeAll(async () => {
    const started = await startRelay();
    PORT = started.port;
    baseUrl = `http://127.0.0.1:${PORT}`;
    relay = started.proc;
    owner = await signIn(OWNER);
  });

  afterAll(async () => {
    if (relay && relay.exitCode === null && relay.signalCode === null) await stopRelay(relay);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  describe('sign-in', () => {
    it('is public for config and health, and bootstraps the owner from TABULA_OWNER_EMAIL', async () => {
      expect((await api(undefined, 'GET', '/api/config')).body).toEqual({ authEnabled: true, images: true });
      const health = await api(undefined, 'GET', '/api/health');
      expect(health.body.ok).toBe(true);
      expect((await api(undefined, 'GET', '/api/me')).status).toBe(401);

      expect(owner.user.role).toBe('owner');
      expect(owner.user.email).toBe(OWNER);
      const me = await api(owner.cookie, 'GET', '/api/me');
      expect(me.body).toEqual({ user: owner.user, teams: [], images: true, chat: true });

      const second = await signIn(OWNER);
      expect(second.user.id).toBe(owner.user.id);
    });

    it('sets a host-only, HttpOnly, SameSite=Lax session cookie', async () => {
      const { setCookie } = await joinTeam(owner.cookie, (await newTeam(owner.cookie)).id);
      expect(setCookie).toMatch(/^tabula_session=[A-Za-z0-9_-]+;/);
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Lax');
      expect(setCookie).toContain('Path=/');
      expect(setCookie).toMatch(/Max-Age=\d+/);
      expect(setCookie).not.toMatch(/Domain/i);
    });

    it('answers unknown addresses with 200 and sends no mail', async () => {
      for (const email of [emailOf('stranger'), 'not-an-email']) {
        const { res, mails } = await requestLink(email);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
        expect(mails).toEqual([]);
      }
      expect((await api(undefined, 'POST', '/api/auth/request', { email: 42 })).status).toBe(400);
      expect((await api(undefined, 'POST', '/api/auth/request', {})).status).toBe(400);
    });

    it('does not let a non-owner without an invite in, and rejects bad tokens', async () => {
      const email = emailOf('nobody');
      const { mails } = await requestLink(email);
      expect(mails).toEqual([]);
      for (const token of ['nope', '', 5, undefined]) {
        const res = await api(undefined, 'POST', '/api/auth/verify', { token });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_token');
      }
      const { mails: withBadInvite } = await requestLink(email, 'not-a-real-invite');
      expect(withBadInvite).toEqual([]);
    });

    it('makes a sign-in token single use', async () => {
      const person = await joinTeam(owner.cookie, (await newTeam(owner.cookie)).id);
      const { mails } = await requestLink(person.email);
      const token = tokenOf(mails[0]);
      const first = await api(undefined, 'POST', '/api/auth/verify', { token });
      expect(first.status).toBe(200);
      const again = await api(undefined, 'POST', '/api/auth/verify', { token });
      expect(again.status).toBe(400);
      expect(again.body.error).toBe('invalid_token');
      expect(again.headers.get('set-cookie')).toBeNull();
    });

    it('rate limits sign-in requests per address and per client address, using the rightmost forwarded entry', async () => {
      const email = emailOf('limited');
      const ip = nextIp();
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push((await requestLink(email, undefined, ip)).res.status);
      expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
      const limited = await api(undefined, 'POST', '/api/auth/request', { email }, { 'x-forwarded-for': ip });
      expect(limited.body.error).toBe('rate_limited');

      // 20 requests from one proxy-reported client are fine even though the left entries differ;
      // the 21st is limited by the rightmost entry, whatever a client prepends.
      const client = nextIp();
      for (let i = 0; i < 20; i++) {
        const res = await api(undefined, 'POST', '/api/auth/request', { email: emailOf('flood') }, { 'x-forwarded-for': `9.9.9.${i}, ${client}` });
        expect(res.status).toBe(200);
      }
      const over = await api(undefined, 'POST', '/api/auth/request', { email: emailOf('flood') }, { 'x-forwarded-for': `1.2.3.4, ${client}` });
      expect(over.status).toBe(429);
    });

    it('requires the csrf header and a matching Origin on every state-changing request', async () => {
      const bare = await fetch(`${baseUrl}/api/teams`, {
        method: 'POST',
        headers: { cookie: owner.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'No header' }),
      });
      expect(bare.status).toBe(403);
      expect(((await bare.json()) as Body).error).toBe('csrf');

      const publicBare = await fetch(`${baseUrl}/api/auth/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: OWNER }),
      });
      expect(publicBare.status).toBe(403);

      const foreign = await api(owner.cookie, 'POST', '/api/teams', { name: 'Foreign' }, { origin: 'http://evil.example' });
      expect(foreign.status).toBe(403);
      expect(foreign.body.error).toBe('csrf');

      const same = await api(owner.cookie, 'POST', '/api/teams', { name: unique('Same origin') }, { origin: baseUrl });
      expect(same.status).toBe(201);
    });

    it('revokes the session on logout and every session on logout-all', async () => {
      const a = await joinTeam(owner.cookie, (await newTeam(owner.cookie)).id);
      const b = await signIn(a.email);
      expect((await api(a.cookie, 'POST', '/api/auth/logout')).status).toBe(204);
      expect((await api(a.cookie, 'GET', '/api/me')).status).toBe(401);
      expect((await api(b.cookie, 'GET', '/api/me')).status).toBe(200);
      const all = await api(b.cookie, 'POST', '/api/auth/logout-all');
      expect(all.status).toBe(204);
      expect(all.headers.get('set-cookie')).toMatch(/Max-Age=0/);
      expect((await api(b.cookie, 'GET', '/api/me')).status).toBe(401);
    });

    it('lets people change their own name, within limits', async () => {
      const team = await newTeam(owner.cookie);
      const me = await joinTeam(owner.cookie, team.id);
      const ok = await api(me.cookie, 'PATCH', '/api/me', { name: '  Ada Lovelace  ' });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ id: me.user.id, name: 'Ada Lovelace', role: 'member' });
      expect((await api(me.cookie, 'PATCH', '/api/me', { name: '' })).status).toBe(400);
      expect((await api(me.cookie, 'PATCH', '/api/me', { name: 'x'.repeat(81) })).status).toBe(400);
      expect((await api(me.cookie, 'PATCH', '/api/me', {})).status).toBe(400);
    });
  });

  describe('request handling', () => {
    it('keeps join-code routes and config hidden when the setting is off', async () => {
      expect((await api(owner.cookie, 'GET', '/api/config')).body).toEqual({ authEnabled: true, images: true });
      expect((await api(undefined, 'POST', '/api/join', { code: 'ABCD2345', name: 'Guest' })).status).toBe(404);
      expect((await api(owner.cookie, 'POST', '/api/boards/board123/join-codes', { role: 'editor' })).status).toBe(404);
      expect((await api(owner.cookie, 'GET', '/api/boards/board123/join-codes')).status).toBe(404);
    });

    it('answers every /api path in JSON, never with the app, and marks it uncacheable', async () => {
      const missing = await api(owner.cookie, 'GET', '/api/nope/at/all');
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual({ error: 'not_found', message: 'No such endpoint' });
      expect(missing.headers.get('content-type')).toContain('application/json');
      expect(missing.headers.get('cache-control')).toBe('no-store');
      expect(missing.headers.get('x-content-type-options')).toBe('nosniff');

      const ok = await api(owner.cookie, 'GET', '/api/me');
      expect(ok.headers.get('cache-control')).toBe('no-store');
      expect(ok.headers.get('x-content-type-options')).toBe('nosniff');

      const wrong = await api(owner.cookie, 'DELETE', '/api/me');
      expect(wrong.status).toBe(405);
      expect(wrong.headers.get('allow')).toContain('GET');

      const unauth = await api(undefined, 'GET', '/api/teams');
      expect(unauth.status).toBe(401);
      expect(unauth.body.error).toBe('unauthenticated');
    });

    it('limits and validates JSON bodies', async () => {
      const big = await api(owner.cookie, 'POST', '/api/teams', { name: 'x'.repeat(70 * 1024) });
      expect(big.status).toBe(413);

      const raw = (body: string) =>
        fetch(`${baseUrl}/api/teams`, { method: 'POST', headers: { 'x-tabula': '1', cookie: owner.cookie, 'content-type': 'application/json' }, body });
      expect((await raw('{nope')).status).toBe(400);
      expect((await raw('[1,2]')).status).toBe(400);
      expect((await raw('null')).status).toBe(400);
      expect((await raw('"text"')).status).toBe(400);

      const bad = await api(owner.cookie, 'GET', '/api/teams/%E0%A4%A');
      expect(bad.status).toBe(400);
      expect((await api(undefined, 'GET', '/api/health')).status).toBe(200);
    });
  });

  describe('teams and invites', () => {
    it('creates, lists, renames and archives teams', async () => {
      const team = await newTeam(owner.cookie);
      const member = await joinTeam(owner.cookie, team.id);
      const created = await api(member.cookie, 'POST', '/api/teams', { name: '  Design  ' });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ name: 'Design', role: 'admin', memberCount: 1, archived: false });
      const id = created.body.id as string;

      const list = (await api(member.cookie, 'GET', '/api/teams')).body as Body[];
      expect(list.map((t) => [t.name, t.role]).sort()).toEqual([[team.name, 'member'], ['Design', 'admin']].sort());

      const renamed = await api(member.cookie, 'PATCH', `/api/teams/${id}`, { name: 'Product design' });
      expect(renamed.status).toBe(200);
      expect(renamed.body.name).toBe('Product design');
      const archived = await api(member.cookie, 'PATCH', `/api/teams/${id}`, { archived: true });
      expect(archived.body.archived).toBe(true);
      const after = (await api(member.cookie, 'GET', '/api/teams')).body as Body[];
      expect(after.find((t) => t.id === id)).toMatchObject({ name: 'Product design', archived: true, role: 'admin' });

      for (const bad of [{ name: '' }, { name: '   ' }, { name: 'x'.repeat(81) }, { name: 'tab\there' }, { name: 5 }, { archived: 'yes' }, {}]) {
        expect((await api(member.cookie, 'PATCH', `/api/teams/${id}`, bad)).status).toBe(400);
      }
      expect((await api(member.cookie, 'POST', '/api/teams', {})).status).toBe(400);
      expect((await api(member.cookie, 'POST', '/api/teams', { name: 'y'.repeat(81) })).status).toBe(400);
    });

    it('hides teams from people who are not in them, but shows every team to workspace admins', async () => {
      const mine = await newTeam(owner.cookie);
      const a = await joinTeam(owner.cookie, mine.id);
      const secret = (await api(a.cookie, 'POST', '/api/teams', { name: unique('Secret') })).body as Body;
      const other = await newTeam(owner.cookie);
      const b = await joinTeam(owner.cookie, other.id);

      const seenByB = (await api(b.cookie, 'GET', '/api/teams')).body as Body[];
      expect(seenByB.map((t) => t.id)).not.toContain(secret.id);
      expect((await api(b.cookie, 'GET', `/api/teams/${secret.id}/members`)).status).toBe(404);
      expect((await api(b.cookie, 'PATCH', `/api/teams/${secret.id}`, { name: 'Mine now' })).status).toBe(404);
      expect((await api(b.cookie, 'POST', `/api/teams/${secret.id}/invites`, {})).status).toBe(404);
      expect((await api(b.cookie, 'GET', `/api/teams/${secret.id}/invites`)).status).toBe(404);

      const seenByOwner = (await api(owner.cookie, 'GET', '/api/teams')).body as Body[];
      expect(seenByOwner.find((t) => t.id === secret.id)).toMatchObject({ role: null, memberCount: 1 });
    });

    it('stops a member from managing a team they only belong to', async () => {
      const admin = await joinTeam(owner.cookie, (await newTeam(owner.cookie)).id);
      const team = (await api(admin.cookie, 'POST', '/api/teams', { name: unique('Crew') })).body as Body;
      const member = await signIn(emailOf('joiner'), await inviteToken(admin.cookie, team.id));
      const third = await signIn(emailOf('joiner'), await inviteToken(admin.cookie, team.id));

      expect((await api(member.cookie, 'PATCH', `/api/teams/${team.id}`, { name: 'Hijacked' })).status).toBe(403);
      expect((await api(member.cookie, 'PATCH', `/api/teams/${team.id}`, { archived: true })).status).toBe(403);
      expect((await api(member.cookie, 'POST', `/api/teams/${team.id}/invites`, {})).status).toBe(403);
      expect((await api(member.cookie, 'GET', `/api/teams/${team.id}/invites`)).status).toBe(403);
      expect((await api(member.cookie, 'PATCH', `/api/teams/${team.id}/members/${third.user.id}`, { role: 'admin' })).status).toBe(403);
      expect((await api(member.cookie, 'PATCH', `/api/teams/${team.id}/members/${member.user.id}`, { role: 'admin' })).status).toBe(403);
      expect((await api(member.cookie, 'DELETE', `/api/teams/${team.id}/members/${third.user.id}`)).status).toBe(403);

      const members = await api(member.cookie, 'GET', `/api/teams/${team.id}/members`);
      expect(members.status).toBe(200);
      expect((members.body as Body[]).map((m) => m.role).sort()).toEqual(['admin', 'member', 'member']);

      // anyone may leave, and a member who left can no longer see the team
      expect((await api(member.cookie, 'DELETE', `/api/teams/${team.id}/members/${member.user.id}`)).status).toBe(204);
      expect((await api(member.cookie, 'GET', `/api/teams/${team.id}/members`)).status).toBe(404);
    });

    it('never lets the last admin of a team leave or be demoted', async () => {
      const base = await newTeam(owner.cookie);
      const creator = await joinTeam(owner.cookie, base.id);
      const team = (await api(creator.cookie, 'POST', '/api/teams', { name: unique('Solo') })).body as Body;
      const mate = await signIn(emailOf('mate'), await inviteToken(creator.cookie, team.id));

      const leave = await api(creator.cookie, 'DELETE', `/api/teams/${team.id}/members/${creator.user.id}`);
      expect(leave.status).toBe(409);
      expect(leave.body.error).toBe('last_admin');
      const demote = await api(creator.cookie, 'PATCH', `/api/teams/${team.id}/members/${creator.user.id}`, { role: 'member' });
      expect(demote.status).toBe(409);
      expect((await api(owner.cookie, 'DELETE', `/api/teams/${team.id}/members/${creator.user.id}`)).status).toBe(409);

      const promoted = await api(creator.cookie, 'PATCH', `/api/teams/${team.id}/members/${mate.user.id}`, { role: 'admin' });
      expect(promoted.status).toBe(200);
      expect(promoted.body).toMatchObject({ userId: mate.user.id, role: 'admin' });
      expect((await api(creator.cookie, 'PATCH', `/api/teams/${team.id}/members/${mate.user.id}`, { role: 'owner' })).status).toBe(400);
      expect((await api(creator.cookie, 'PATCH', `/api/teams/${team.id}/members/${base.id}`, { role: 'member' })).status).toBe(404);
      expect((await api(creator.cookie, 'DELETE', `/api/teams/${team.id}/members/${creator.user.id}`)).status).toBe(204);
      const last = await api(mate.cookie, 'DELETE', `/api/teams/${team.id}/members/${mate.user.id}`);
      expect(last.status).toBe(409);
    });

    it('signs a new person in through an invite link and puts them in the team', async () => {
      const team = await newTeam(owner.cookie, 'Invite crew');
      const created = await api(owner.cookie, 'POST', `/api/teams/${team.id}/invites`, { role: 'member', days: 2 });
      expect(created.status).toBe(201);
      expect(created.body.url).toBe(`${baseUrl}/#/invite/${created.body.token}`);
      expect(created.body.expiresAt).toBeGreaterThan(Date.now() + 47 * 3600_000);
      expect(created.body.expiresAt).toBeLessThan(Date.now() + 49 * 3600_000);

      const preview = await api(undefined, 'GET', `/api/invites/${created.body.token}`);
      expect(preview.body).toEqual({ team: { id: team.id, name: 'Invite crew' }, role: 'member' });
      expect((await api(undefined, 'GET', '/api/invites/not-a-token')).status).toBe(404);

      const email = emailOf('newbie');
      expect((await requestLink(email)).mails).toEqual([]);
      const person = await signIn(email, created.body.token);
      expect(person.user.role).toBe('member');
      const me = await api(person.cookie, 'GET', '/api/me');
      expect(me.body.teams).toEqual([{ id: team.id, name: 'Invite crew', role: 'member' }]);

      const invites = await api(owner.cookie, 'GET', `/api/teams/${team.id}/invites`);
      expect(invites.body).toEqual([{ id: created.body.id, role: 'member', expiresAt: created.body.expiresAt, uses: 1, maxUses: null }]);
      expect(JSON.stringify(invites.body)).not.toContain(created.body.token);
    });

    it('validates invite options and keeps invites inside their team', async () => {
      const a = await newTeam(owner.cookie);
      const b = await newTeam(owner.cookie);
      for (const body of [{ days: 0 }, { days: 31 }, { days: 1.5 }, { days: '3' }, { role: 'owner' }, { role: 5 }]) {
        expect((await api(owner.cookie, 'POST', `/api/teams/${a.id}/invites`, body)).status).toBe(400);
      }
      expect((await api(owner.cookie, 'POST', `/api/teams/${a.id}/invites`, { days: 30 })).status).toBe(201);
      const invite = (await api(owner.cookie, 'POST', `/api/teams/${a.id}/invites`, {})).body as Body;

      expect((await api(owner.cookie, 'DELETE', `/api/teams/${b.id}/invites/${invite.id}`)).status).toBe(404);
      expect((await api(undefined, 'GET', `/api/invites/${invite.token}`)).status).toBe(200);

      expect((await api(owner.cookie, 'DELETE', `/api/teams/${a.id}/invites/${invite.id}`)).status).toBe(204);
      expect((await api(undefined, 'GET', `/api/invites/${invite.token}`)).status).toBe(404);
      expect((await requestLink(emailOf('late'), invite.token)).mails).toEqual([]);
      const list = (await api(owner.cookie, 'GET', `/api/teams/${a.id}/invites`)).body as Body[];
      expect(list.map((i) => i.id)).not.toContain(invite.id);
    });

    it('lets a signed-in person accept an invite, once, and promotes only when the invite grants admin', async () => {
      const home = await newTeam(owner.cookie);
      const target = await newTeam(owner.cookie, 'Target');
      const person = await joinTeam(owner.cookie, home.id);
      const memberInvite = (await api(owner.cookie, 'POST', `/api/teams/${target.id}/invites`, {})).body as Body;
      const adminInvite = (await api(owner.cookie, 'POST', `/api/teams/${target.id}/invites`, { role: 'admin' })).body as Body;

      expect((await api(undefined, 'POST', `/api/invites/${memberInvite.token}/accept`)).status).toBe(401);
      expect((await api(person.cookie, 'POST', '/api/invites/bogus/accept')).status).toBe(404);

      const joined = await api(person.cookie, 'POST', `/api/invites/${memberInvite.token}/accept`);
      expect(joined.body).toEqual({ team: { id: target.id, name: 'Target' }, role: 'member' });
      const usesOf = async (id: string) =>
        ((await api(owner.cookie, 'GET', `/api/teams/${target.id}/invites`)).body as Body[]).find((i) => i.id === id).uses;
      expect(await usesOf(memberInvite.id)).toBe(1);

      const again = await api(person.cookie, 'POST', `/api/invites/${memberInvite.token}/accept`);
      expect(again.status).toBe(200);
      expect(again.body.role).toBe('member');
      expect(await usesOf(memberInvite.id)).toBe(1);

      const promoted = await api(person.cookie, 'POST', `/api/invites/${adminInvite.token}/accept`);
      expect(promoted.body.role).toBe('admin');
      const downgrade = await api(person.cookie, 'POST', `/api/invites/${memberInvite.token}/accept`);
      expect(downgrade.body.role).toBe('admin');
      const teams = (await api(person.cookie, 'GET', '/api/teams')).body as Body[];
      expect(teams.map((t) => [t.name, t.role])).toContainEqual(['Target', 'admin']);
    });
  });

  describe('boards', () => {
    it('registers boards, refuses duplicates and bad ids, and lists the caller role', async () => {
      const team = await newTeam(owner.cookie);
      const ada = await joinTeam(owner.cookie, team.id);
      const bob = await joinTeam(owner.cookie, team.id);
      const id = unique('mine');

      const created = await api(ada.cookie, 'POST', '/api/boards', { id, title: '  My board  ' });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ id, title: 'My board', teamId: null, role: 'owner' });
      expect(typeof created.body.createdAt).toBe('number');

      for (const who of [ada, bob]) {
        const dup = await api(who.cookie, 'POST', '/api/boards', { id });
        expect(dup.status).toBe(409);
        expect(dup.body.error).toBe('exists');
      }
      for (const bad of [{ id: 'has space' }, { id: '' }, { id: 'a'.repeat(65) }, { id: 5 }, {}, { id: unique('x'), title: 'x'.repeat(201) }, { id: unique('x'), teamId: 5 }]) {
        expect((await api(ada.cookie, 'POST', '/api/boards', bad)).status).toBe(400);
      }

      expect(await roleOn(ada.cookie, id)).toBe('owner');
      expect(await roleOn(bob.cookie, id)).toBeNull();
      expect(await roleOn(owner.cookie, id)).toBe('owner');
    });

    it('tells each listed user who owns a board, including viewers it was shared with', async () => {
      const team = await newTeam(owner.cookie);
      const ada = await joinTeam(owner.cookie, team.id);
      const bob = await joinTeam(owner.cookie, team.id);
      const board = await newBoard(ada.cookie);
      expect((await api(ada.cookie, 'POST', `/api/boards/${board}/shares`, { principalType: 'user', principalId: bob.user.id, role: 'viewer' })).status).toBe(201);

      const entry = async (who: Account) => ((await api(who.cookie, 'GET', '/api/boards')).body as Body[]).find((b) => b.id === board);
      expect(await entry(bob)).toMatchObject({ ownerId: ada.user.id, role: 'viewer' });
      expect(await entry(ada)).toMatchObject({ ownerId: ada.user.id, role: 'owner' });
    });

    it('keeps team boards to team members and refuses boards in teams the caller is not in', async () => {
      const team = await newTeam(owner.cookie);
      const other = await newTeam(owner.cookie);
      const admin = await joinTeam(owner.cookie, team.id, 'admin');
      const member = await joinTeam(owner.cookie, team.id);
      const outsider = await joinTeam(owner.cookie, other.id);

      const board = await newBoard(member.cookie, { teamId: team.id });
      expect(await roleOn(member.cookie, board)).toBe('owner');
      expect(await roleOn(admin.cookie, board)).toBe('owner');
      expect(await roleOn(outsider.cookie, board)).toBeNull();

      const second = await newBoard(admin.cookie, { teamId: team.id });
      expect(await roleOn(member.cookie, second)).toBe('editor');
      expect(await roleOn(outsider.cookie, second)).toBeNull();

      for (const teamId of [team.id, 'no-such-team']) {
        const res = await api(outsider.cookie, 'POST', '/api/boards', { id: unique('b'), teamId });
        expect(res.status).toBe(403);
      }
      // even a workspace owner must belong to the team to put a board in it
      const adminsTeam = (await api(admin.cookie, 'POST', '/api/teams', { name: unique('Admins') })).body as Body;
      expect((await api(owner.cookie, 'POST', '/api/boards', { id: unique('b'), teamId: adminsTeam.id })).status).toBe(403);
      expect((await api(owner.cookie, 'POST', '/api/boards', { id: unique('b'), teamId: other.id })).status).toBe(201);
    });

    it('stops guests from creating teams or boards', async () => {
      const team = await newTeam(owner.cookie);
      const guest = await joinTeam(owner.cookie, team.id);
      const demote = await api(owner.cookie, 'PATCH', `/api/members/${guest.user.id}`, { role: 'guest' });
      expect(demote.status).toBe(200);
      expect((await api(guest.cookie, 'POST', '/api/teams', { name: 'Nope' })).status).toBe(403);
      expect((await api(guest.cookie, 'POST', '/api/boards', { id: unique('g') })).status).toBe(403);

      // team membership gives a guest nothing: only explicit shares do
      const board = await newBoard(owner.cookie, { teamId: team.id });
      expect(await roleOn(guest.cookie, board)).toBeNull();
      expect((await api(owner.cookie, 'POST', `/api/boards/${board}/shares`, { principalType: 'user', principalId: guest.user.id, role: 'viewer' })).status).toBe(201);
      expect(await roleOn(guest.cookie, board)).toBe('viewer');
    });

    it('lets only a workspace owner or admin adopt a room that already exists on disk', async () => {
      const team = await newTeam(owner.cookie);
      const member = await joinTeam(owner.cookie, team.id);
      const id = unique('legacy');
      fs.writeFileSync(path.join(dataDir, `${id}.yjs`), Y.encodeStateAsUpdate(new Y.Doc()));

      const refused = await api(member.cookie, 'POST', '/api/boards', { id });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe('needs_admin');
      expect(await roleOn(member.cookie, id)).toBeNull();

      const adopted = await api(owner.cookie, 'POST', '/api/boards', { id, title: 'Legacy' });
      expect(adopted.status).toBe(201);
      expect((await api(member.cookie, 'POST', '/api/boards', { id })).body.error).toBe('exists');

      const admin = await joinTeam(owner.cookie, team.id);
      await api(owner.cookie, 'PATCH', `/api/members/${admin.user.id}`, { role: 'admin' });
      const second = unique('legacy');
      fs.writeFileSync(path.join(dataDir, `${second}.yjs`), Y.encodeStateAsUpdate(new Y.Doc()));
      expect((await api(admin.cookie, 'POST', '/api/boards', { id: second })).status).toBe(201);
    });

    it('lets only the board owner rename, move, delete and share', async () => {
      const team = await newTeam(owner.cookie);
      const other = await newTeam(owner.cookie);
      const admin = await joinTeam(owner.cookie, team.id, 'admin');
      const creator = await joinTeam(owner.cookie, team.id);
      const editor = await joinTeam(owner.cookie, team.id);
      const stranger = await joinTeam(owner.cookie, other.id);
      const board = await newBoard(creator.cookie, { teamId: team.id });

      expect(await roleOn(editor.cookie, board)).toBe('editor');
      for (const who of [editor, stranger]) {
        const status = who === editor ? 403 : 404;
        expect((await api(who.cookie, 'PATCH', `/api/boards/${board}`, { title: 'Hijack' })).status).toBe(status);
        expect((await api(who.cookie, 'DELETE', `/api/boards/${board}`)).status).toBe(status);
        expect((await api(who.cookie, 'GET', `/api/boards/${board}/shares`)).status).toBe(status);
        expect((await api(who.cookie, 'POST', `/api/boards/${board}/shares`, { principalType: 'user', principalId: who.user.id, role: 'editor' })).status).toBe(status);
        expect((await api(who.cookie, 'DELETE', `/api/boards/${board}/shares/user/${who.user.id}`)).status).toBe(status);
      }

      const renamed = await api(creator.cookie, 'PATCH', `/api/boards/${board}`, { title: 'Roadmap' });
      expect(renamed.body).toMatchObject({ id: board, title: 'Roadmap', teamId: team.id, role: 'owner' });
      expect((await api(admin.cookie, 'PATCH', `/api/boards/${board}`, { title: 'Roadmap v2' })).body.title).toBe('Roadmap v2');

      expect((await api(creator.cookie, 'PATCH', `/api/boards/${board}`, { teamId: other.id })).status).toBe(403);
      expect((await api(creator.cookie, 'PATCH', `/api/boards/${board}`, { teamId: 5 })).status).toBe(400);
      expect((await api(creator.cookie, 'PATCH', `/api/boards/${board}`, {})).status).toBe(400);
      const personal = await api(creator.cookie, 'PATCH', `/api/boards/${board}`, { teamId: null });
      expect(personal.body).toMatchObject({ teamId: null, role: 'owner' });
      expect(await roleOn(editor.cookie, board)).toBeNull();
      const back = await api(creator.cookie, 'PATCH', `/api/boards/${board}`, { teamId: team.id });
      expect(back.body.teamId).toBe(team.id);
      expect(await roleOn(editor.cookie, board)).toBe('editor');

      expect((await api(creator.cookie, 'DELETE', `/api/boards/${board}`)).status).toBe(204);
      expect(await roleOn(creator.cookie, board)).toBeNull();
      expect(await roleOn(owner.cookie, board)).toBeNull();
      expect((await api(creator.cookie, 'PATCH', `/api/boards/${board}`, { title: 'Zombie' })).status).toBe(404);
      expect((await api(creator.cookie, 'POST', '/api/boards', { id: board })).body.error).toBe('exists');
    });

    it('shares boards with people and teams the sharer can see, and hides the rest', async () => {
      const mine = await newTeam(owner.cookie);
      const theirs = await newTeam(owner.cookie);
      const creator = await joinTeam(owner.cookie, mine.id);
      const mate = await joinTeam(owner.cookie, mine.id);
      const stranger = await joinTeam(owner.cookie, theirs.id);
      const board = await newBoard(creator.cookie);

      expect(await roleOn(mate.cookie, board)).toBeNull();
      const viewer = await api(creator.cookie, 'POST', `/api/boards/${board}/shares`, { principalType: 'user', principalId: mate.user.id, role: 'viewer' });
      expect(viewer.status).toBe(201);
      expect(viewer.body).toMatchObject({ principalType: 'user', principalId: mate.user.id, role: 'viewer' });
      expect(await roleOn(mate.cookie, board)).toBe('viewer');
      const commenter = await api(creator.cookie, 'POST', `/api/boards/${board}/shares`, { principalType: 'user', principalId: mate.user.id, role: 'commenter' });
      expect(commenter.status).toBe(201);
      expect(commenter.body).toMatchObject({ principalType: 'user', principalId: mate.user.id, role: 'commenter' });
      expect(await roleOn(mate.cookie, board)).toBe('commenter');
      expect(((await api(creator.cookie, 'GET', `/api/boards/${board}/shares`)).body as Body[]).map((s) => s.role)).toEqual(['commenter']);
      await api(creator.cookie, 'POST', `/api/boards/${board}/shares`, { principalType: 'user', principalId: mate.user.id, role: 'editor' });
      expect(await roleOn(mate.cookie, board)).toBe('editor');

      for (const body of [
        { principalType: 'user', principalId: stranger.user.id, role: 'viewer' },
        { principalType: 'team', principalId: theirs.id, role: 'viewer' },
        { principalType: 'team', principalId: 'no-such-team', role: 'viewer' },
        { principalType: 'user', principalId: 'no-such-user', role: 'viewer' },
      ]) {
        expect((await api(creator.cookie, 'POST', `/api/boards/${board}/shares`, body)).status).toBe(404);
      }
      for (const body of [
        { principalType: 'user', principalId: mate.user.id, role: 'owner' },
        { principalType: 'user', principalId: mate.user.id, role: 'admin' },
        { principalType: 'user', principalId: mate.user.id, role: 'Commenter' },
        { principalType: 'user', principalId: mate.user.id, role: ['commenter'] },
        { principalType: 'user', principalId: mate.user.id, role: '' },
        { principalType: 'group', principalId: mate.user.id, role: 'viewer' },
        { principalType: 'user', role: 'viewer' },
        { principalType: 'user', principalId: mate.user.id },
      ]) {
        expect((await api(creator.cookie, 'POST', `/api/boards/${board}/shares`, body)).status).toBe(400);
      }
      expect(await roleOn(mate.cookie, board)).toBe('editor');

      // a workspace owner may share with anyone; the board creator then does not learn about it
      expect((await api(owner.cookie, 'POST', `/api/boards/${board}/shares`, { principalType: 'team', principalId: theirs.id, role: 'viewer' })).status).toBe(201);
      expect(await roleOn(stranger.cookie, board)).toBe('viewer');
      const seenByCreator = (await api(creator.cookie, 'GET', `/api/boards/${board}/shares`)).body as Body[];
      expect(seenByCreator.map((s) => s.principalId)).toEqual([mate.user.id]);
      const seenByOwner = (await api(owner.cookie, 'GET', `/api/boards/${board}/shares`)).body as Body[];
      expect(seenByOwner.map((s) => s.principalId).sort()).toEqual([mate.user.id, theirs.id].sort());

      expect((await api(creator.cookie, 'DELETE', `/api/boards/${board}/shares/user/${mate.user.id}`)).status).toBe(204);
      expect(await roleOn(mate.cookie, board)).toBeNull();
      expect((await api(creator.cookie, 'DELETE', `/api/boards/${board}/shares/team/${theirs.id}`)).status).toBe(204);
      expect(await roleOn(stranger.cookie, board)).toBeNull();
      expect((await api(creator.cookie, 'DELETE', `/api/boards/${board}/shares/everyone/x`)).status).toBe(400);
    });

    it('gives a commenter no say over the board itself', async () => {
      const team = await newTeam(owner.cookie);
      const creator = await joinTeam(owner.cookie, team.id);
      const commenter = await joinTeam(owner.cookie, team.id);
      const board = await newBoard(creator.cookie);
      const grant = { principalType: 'user', principalId: commenter.user.id, role: 'commenter' };
      expect((await api(creator.cookie, 'POST', `/api/boards/${board}/shares`, grant)).status).toBe(201);

      const listed = ((await api(commenter.cookie, 'GET', '/api/boards')).body as Body[]).find((b) => b.id === board);
      expect(listed).toMatchObject({ role: 'commenter', ownerId: creator.user.id });
      expect((await api(commenter.cookie, 'PATCH', `/api/boards/${board}`, { title: 'Hijack' })).status).toBe(403);
      expect((await api(commenter.cookie, 'DELETE', `/api/boards/${board}`)).status).toBe(403);
      expect((await api(commenter.cookie, 'GET', `/api/boards/${board}/shares`)).status).toBe(403);
      expect((await api(commenter.cookie, 'POST', `/api/boards/${board}/shares`, { ...grant, role: 'editor' })).status).toBe(403);
      expect((await api(commenter.cookie, 'DELETE', `/api/boards/${board}/shares/user/${commenter.user.id}`)).status).toBe(403);
      expect(await roleOn(commenter.cookie, board)).toBe('commenter');
    });
  });

  describe('members', () => {
    it('shows the member list to workspace admins only', async () => {
      const team = await newTeam(owner.cookie, 'Listed');
      const person = await joinTeam(owner.cookie, team.id);
      expect((await api(person.cookie, 'GET', '/api/members')).status).toBe(403);
      expect((await api(person.cookie, 'PATCH', `/api/members/${person.user.id}`, { role: 'admin' })).status).toBe(403);
      expect((await api(person.cookie, 'DELETE', `/api/members/${owner.user.id}`)).status).toBe(403);

      const list = (await api(owner.cookie, 'GET', '/api/members')).body as Body[];
      expect(list.find((m) => m.id === person.user.id)).toMatchObject({
        email: person.email,
        role: 'member',
        disabled: false,
        teams: [{ id: team.id, name: 'Listed', role: 'member' }],
      });
    });

    it('protects owners: only an owner may change one or grant the role, and the last owner stays', async () => {
      const team = await newTeam(owner.cookie);
      const admin = await joinTeam(owner.cookie, team.id);
      const victim = await joinTeam(owner.cookie, team.id);
      expect((await api(owner.cookie, 'PATCH', `/api/members/${admin.user.id}`, { role: 'admin' })).status).toBe(200);

      expect((await api(admin.cookie, 'PATCH', `/api/members/${owner.user.id}`, { role: 'member' })).status).toBe(403);
      expect((await api(admin.cookie, 'PATCH', `/api/members/${owner.user.id}`, { disabled: true })).status).toBe(403);
      expect((await api(admin.cookie, 'PATCH', `/api/members/${victim.user.id}`, { role: 'owner' })).status).toBe(403);
      expect((await api(admin.cookie, 'PATCH', `/api/members/${admin.user.id}`, { role: 'owner' })).status).toBe(403);
      expect((await api(admin.cookie, 'DELETE', `/api/members/${owner.user.id}`)).status).toBe(403);

      expect((await api(owner.cookie, 'PATCH', `/api/members/${victim.user.id}`, { role: 'superuser' })).status).toBe(400);
      expect((await api(owner.cookie, 'PATCH', `/api/members/${victim.user.id}`, { disabled: 'yes' })).status).toBe(400);
      expect((await api(owner.cookie, 'PATCH', `/api/members/${victim.user.id}`, {})).status).toBe(400);
      expect((await api(owner.cookie, 'PATCH', '/api/members/nobody', { role: 'member' })).status).toBe(404);
    });

    it('never lets the last active owner be demoted, disabled or removed', async () => {
      const team = await newTeam(owner.cookie);
      const second = await joinTeam(owner.cookie, team.id);
      // Other tests keep exactly one owner, so the bootstrap owner is the last one here.
      for (const patch of [{ role: 'admin' }, { disabled: true }, { role: 'guest', disabled: true }]) {
        const res = await api(owner.cookie, 'PATCH', `/api/members/${owner.user.id}`, patch);
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('last_owner');
      }
      expect((await api(owner.cookie, 'DELETE', `/api/members/${owner.user.id}`)).status).toBe(409);
      expect((await api(owner.cookie, 'PATCH', `/api/members/${owner.user.id}`, { role: 'owner' })).status).toBe(200);

      // with a second owner the first may step down, and then the second is the last
      expect((await api(owner.cookie, 'PATCH', `/api/members/${second.user.id}`, { role: 'owner' })).status).toBe(200);
      expect((await api(second.cookie, 'PATCH', `/api/members/${owner.user.id}`, { role: 'admin' })).status).toBe(200);
      const stuck = await api(second.cookie, 'PATCH', `/api/members/${second.user.id}`, { role: 'member' });
      expect(stuck.status).toBe(409);
      expect((await api(second.cookie, 'DELETE', `/api/members/${second.user.id}`)).status).toBe(409);
      expect((await api(second.cookie, 'PATCH', `/api/members/${owner.user.id}`, { role: 'owner' })).status).toBe(200);
      expect((await api(second.cookie, 'PATCH', `/api/members/${second.user.id}`, { role: 'member' })).status).toBe(200);
      expect((await api(owner.cookie, 'GET', '/api/me')).body.user.role).toBe('owner');
    });

    it('disables and removes members, ending their sessions and sign-in', async () => {
      const team = await newTeam(owner.cookie);
      const a = await joinTeam(owner.cookie, team.id);
      const b = await joinTeam(owner.cookie, team.id);

      const off = await api(owner.cookie, 'PATCH', `/api/members/${a.user.id}`, { disabled: true });
      expect(off.body).toMatchObject({ id: a.user.id, disabled: true });
      expect((await api(a.cookie, 'GET', '/api/me')).status).toBe(401);
      expect((await requestLink(a.email)).mails).toEqual([]);
      const on = await api(owner.cookie, 'PATCH', `/api/members/${a.user.id}`, { disabled: false });
      expect(on.body.disabled).toBe(false);
      expect((await signIn(a.email)).user.id).toBe(a.user.id);

      expect((await api(owner.cookie, 'DELETE', `/api/members/${b.user.id}`)).status).toBe(204);
      expect((await api(b.cookie, 'GET', '/api/me')).status).toBe(401);
      expect((await requestLink(b.email)).mails).toEqual([]);
      const list = (await api(owner.cookie, 'GET', '/api/members')).body as Body[];
      expect(list.map((m) => m.id)).not.toContain(b.user.id);
      expect((await api(owner.cookie, 'DELETE', `/api/members/${b.user.id}`)).status).toBe(404);
    });
  });

  describe('relay', () => {
    it('closes unauthorised connections with 4401, 4404 and 4403 and rejects the wrong Origin', async () => {
      const team = await newTeam(owner.cookie);
      const other = await newTeam(owner.cookie);
      const member = await joinTeam(owner.cookie, team.id);
      const outsider = await joinTeam(owner.cookie, other.id);
      const board = await newBoard(member.cookie, { teamId: team.id });

      expect(await within(rawSocket(board).closed)).toBe(4401);
      expect(await within(rawSocket(board, 'tabula_session=not-a-session').closed)).toBe(4401);
      expect(await within(rawSocket(unique('ghost'), member.cookie).closed)).toBe(4404);
      expect(await within(rawSocket(unique('ghost'), owner.cookie).closed)).toBe(4404);
      expect(await within(rawSocket(board, outsider.cookie).closed)).toBe(4403);

      const ok = rawSocket(board, member.cookie);
      await within(ok.joined);
      expect(ok.ws.readyState).toBe(WebSocket.OPEN);

      // the Origin is checked before anything else, even for a valid session
      const wrongOrigins: Record<string, string>[] = [
        { Origin: 'http://evil.example', Cookie: member.cookie },
        { Origin: 'http://127.0.0.1:1', Cookie: member.cookie },
        { Cookie: member.cookie },
      ];
      for (const headers of wrongOrigins) {
        const refused = rawSocket(board, member.cookie, headers);
        expect(await within(refused.rejected)).toBe(403);
      }
    });

    it('answers deleted boards with 4404, except to workspace admins', async () => {
      const team = await newTeam(owner.cookie);
      const member = await joinTeam(owner.cookie, team.id);
      const board = await newBoard(member.cookie, { teamId: team.id });
      expect((await api(member.cookie, 'DELETE', `/api/boards/${board}`)).status).toBe(204);
      expect(await within(rawSocket(board, member.cookie).closed)).toBe(4404);
      const admin = rawSocket(board, owner.cookie);
      await within(admin.joined);
      expect(admin.ws.readyState).toBe(WebSocket.OPEN);
    });

    it('keeps a deleted board read-only for workspace admins until it is restored', async () => {
      const team = await newTeam(owner.cookie);
      const member = await joinTeam(owner.cookie, team.id);
      const board = await newBoard(member.cookie, { teamId: team.id });
      const before = connect(board, owner.cookie);
      await synced(before);
      expect((await api(member.cookie, 'DELETE', `/api/boards/${board}`)).status).toBe(204);

      // an admin who opens it now, and one who had it open, can read it but not change it
      const admin = connect(board, owner.cookie);
      await synced(admin);
      admin.doc.getMap('objects').set('whileDeleted', 1);
      before.doc.getMap('objects').set('alsoWhileDeleted', 1);
      await flush(admin, before);
      await flush(before, admin);
      const look = connect(board, owner.cookie);
      await synced(look);
      expect(look.doc.getMap('objects').has('whileDeleted')).toBe(false);
      expect(look.doc.getMap('objects').has('alsoWhileDeleted')).toBe(false);

      // restoring gives an open connection its write access back (one that wrote while it was deleted cannot
      // catch up: its later updates build on the dropped ones, which is why the app opens a deleted board read-only)
      expect((await api(owner.cookie, 'POST', `/api/admin/boards/${board}/restore`)).status).toBe(200);
      look.doc.getMap('objects').set('afterRestore', 1);
      const after = connect(board, member.cookie);
      await synced(after);
      await until(() => after.doc.getMap('objects').get('afterRestore') === 1);
    });

    it('names a board after its directory title when the board itself has no name', async () => {
      const titled = await newBoard(owner.cookie, { title: 'Planning' });
      const plain = await newBoard(owner.cookie);
      const a = connect(titled, owner.cookie);
      const b = connect(plain, owner.cookie);
      await synced(a);
      await synced(b);
      await until(() => a.doc.getMap('meta').get('name') === 'Planning');
      expect(b.doc.getMap('meta').has('name')).toBe(false); // an untitled board stays unnamed, as a new board in the app

      // a board that already has a name keeps it, and saving copies it to the directory
      a.doc.getMap('meta').set('name', 'Planning, week 2');
      const titleOf = async () => ((await api(owner.cookie, 'GET', '/api/boards')).body as { id: string; title: string }[])
        .find((x) => x.id === titled)?.title;
      for (let i = 0; i < 100 && (await titleOf()) !== 'Planning, week 2'; i++) await sleep(50);
      expect(await titleOf()).toBe('Planning, week 2');
      const again = connect(titled, owner.cookie);
      await synced(again);
      expect(again.doc.getMap('meta').get('name')).toBe('Planning, week 2');
    });

    it('renames the board itself when its title changes through the API', async () => {
      const board = await newBoard(owner.cookie, { title: 'Before' });
      const open = connect(board, owner.cookie);
      await synced(open);
      await until(() => open.doc.getMap('meta').get('name') === 'Before');
      expect((await api(owner.cookie, 'PATCH', `/api/boards/${board}`, { title: 'After' })).status).toBe(200);
      await until(() => open.doc.getMap('meta').get('name') === 'After');

      // with nobody connected the room is loaded, renamed and saved
      const closed = await newBoard(owner.cookie, { title: 'Quiet' });
      expect((await api(owner.cookie, 'PATCH', `/api/boards/${closed}`, { title: 'Renamed while closed' })).status).toBe(200);
      const later = connect(closed, owner.cookie);
      await synced(later);
      await until(() => later.doc.getMap('meta').get('name') === 'Renamed while closed');
    });

    it('never loads or creates a room for a connection it rejects', async () => {
      const team = await newTeam(owner.cookie);
      const other = await newTeam(owner.cookie);
      const member = await joinTeam(owner.cookie, team.id);
      const outsider = await joinTeam(owner.cookie, other.id);
      const board = await newBoard(member.cookie, { teamId: team.id });
      const ghost = unique('ghost');
      await sleep(100);
      const before = (await api(undefined, 'GET', '/api/health')).body;

      const attempts = [rawSocket(board), rawSocket(board, outsider.cookie), rawSocket(ghost, member.cookie), rawSocket(ghost)];
      for (const a of attempts) {
        a.ws.on('open', () => a.ws.send(updateFrame()));
      }
      expect(await within(Promise.all(attempts.map((a) => a.closed)))).toEqual([4401, 4403, 4404, 4401]);
      await sleep(1400); // longer than the relay's save debounce

      for (const name of [board, ghost]) expect(fs.existsSync(path.join(dataDir, `${name}.yjs`))).toBe(false);
      const after = (await api(undefined, 'GET', '/api/health')).body;
      expect(after.rooms).toBeLessThanOrEqual(before.rooms);
    });

    it('syncs edits between authorised members, with awareness', async () => {
      const team = await newTeam(owner.cookie);
      const a = await joinTeam(owner.cookie, team.id);
      const b = await joinTeam(owner.cookie, team.id);
      const board = await newBoard(a.cookie, { teamId: team.id });
      const ca = connect(board, a.cookie);
      const cb = connect(board, b.cookie);
      await synced(ca);
      await synced(cb);
      ca.doc.getMap('objects').set('x', 1);
      await until(() => cb.doc.getMap('objects').get('x') === 1);
      cb.doc.getMap('objects').set('y', 2);
      await until(() => ca.doc.getMap('objects').get('y') === 2);
      await flush(ca, cb);
      expect(cb.doc.getMap('objects').get('x')).toBe(1);
      expect(ca.doc.getMap('objects').get('y')).toBe(2);
    });

    it('copies the board name from the document into the directory when the room is saved', async () => {
      const team = await newTeam(owner.cookie);
      const member = await joinTeam(owner.cookie, team.id);
      const board = await newBoard(member.cookie, { title: 'Before' });
      const before = ((await api(member.cookie, 'GET', '/api/boards')).body as Body[]).find((b) => b.id === board);
      const c = connect(board, member.cookie);
      await synced(c);
      c.doc.getMap('meta').set('name', 'Named in the document');
      const read = async () => ((await api(member.cookie, 'GET', '/api/boards')).body as Body[]).find((b) => b.id === board);
      const deadline = Date.now() + 4000; // the relay saves a second after the last change
      let after = await read();
      while (after.title !== 'Named in the document' && Date.now() < deadline) {
        await sleep(100);
        after = await read();
      }
      expect(after.title).toBe('Named in the document');
      expect(after.updatedAt).toBeGreaterThan(before.updatedAt);
    });

    it('drops document updates from a viewer but lets edits and awareness through', async () => {
      const team = await newTeam(owner.cookie);
      const editor = await joinTeam(owner.cookie, team.id);
      const viewer = await joinTeam(owner.cookie, team.id);
      const board = await newBoard(editor.cookie);
      const share = await api(editor.cookie, 'POST', `/api/boards/${board}/shares`, { principalType: 'user', principalId: viewer.user.id, role: 'viewer' });
      expect(share.status).toBe(201);

      const ce = connect(board, editor.cookie);
      const cv = connect(board, viewer.cookie);
      await synced(ce);
      await synced(cv);

      ce.doc.getMap('objects').set('fromEditor', 'hello');
      await until(() => cv.doc.getMap('objects').get('fromEditor') === 'hello');

      cv.doc.getMap('objects').set('fromViewer', 'sneaky');
      cv.provider.awareness.setLocalStateField('user', { name: 'Vera the viewer' });
      await until(() => peers(ce, 'Vera the viewer'));
      expect(ce.doc.getMap('objects').has('fromViewer')).toBe(false);

      ce.doc.getMap('objects').set('after', 1);
      await until(() => cv.doc.getMap('objects').get('after') === 1);

      // a client that joins later gets the editor's data and never the viewer's
      const fresh = connect(board, editor.cookie);
      await synced(fresh);
      expect(fresh.doc.getMap('objects').get('fromEditor')).toBe('hello');
      expect(fresh.doc.getMap('objects').has('fromViewer')).toBe(false);
      expect(cv.doc.getMap('objects').has('fromViewer')).toBe(true);
    });

    it('turns an editor read-only without reconnecting when they are demoted', async () => {
      const team = await newTeam(owner.cookie);
      const owning = await joinTeam(owner.cookie, team.id);
      const guest = await joinTeam(owner.cookie, team.id);
      const board = await newBoard(owning.cookie);
      const grant = (role: string) =>
        api(owning.cookie, 'POST', `/api/boards/${board}/shares`, { principalType: 'user', principalId: guest.user.id, role });
      expect((await grant('editor')).status).toBe(201);

      const co = connect(board, owning.cookie);
      const cg = connect(board, guest.cookie);
      await synced(co);
      await synced(cg);
      const socketBefore = cg.provider.ws;

      cg.doc.getMap('objects').set('first', 1);
      await until(() => co.doc.getMap('objects').get('first') === 1);

      expect((await grant('viewer')).status).toBe(201);
      cg.doc.getMap('objects').set('second', 2);
      cg.provider.awareness.setLocalStateField('user', { name: 'Still here' });
      await until(() => peers(co, 'Still here'));
      expect(co.doc.getMap('objects').has('second')).toBe(false);
      expect(cg.provider.wsconnected).toBe(true);
      expect(cg.provider.ws).toBe(socketBefore);

      co.doc.getMap('objects').set('third', 3);
      await until(() => cg.doc.getMap('objects').get('third') === 3);
    });

    it('closes the socket with 4401 when its session is revoked', async () => {
      const team = await newTeam(owner.cookie);
      const member = await joinTeam(owner.cookie, team.id);
      const board = await newBoard(member.cookie);
      const second = await signIn(member.email);

      const one = rawSocket(board, member.cookie);
      const two = rawSocket(board, second.cookie);
      await within(one.joined);
      await within(two.joined);

      expect((await api(member.cookie, 'POST', '/api/auth/logout')).status).toBe(204);
      expect(await within(one.closed)).toBe(4401);
      expect(two.ws.readyState).toBe(WebSocket.OPEN);

      expect((await api(second.cookie, 'POST', '/api/auth/logout-all')).status).toBe(204);
      expect(await within(two.closed)).toBe(4401);
    });

    it('closes the socket with 4410 when team membership, a share or the board goes away', async () => {
      const team = await newTeam(owner.cookie);
      const admin = await joinTeam(owner.cookie, team.id, 'admin');
      const member = await joinTeam(owner.cookie, team.id);
      const teamBoard = await newBoard(admin.cookie, { teamId: team.id });
      const sharedBoard = await newBoard(admin.cookie);
      await api(admin.cookie, 'POST', `/api/boards/${sharedBoard}/shares`, { principalType: 'user', principalId: member.user.id, role: 'editor' });
      const deletedBoard = await newBoard(admin.cookie, { teamId: team.id });

      const viaTeam = rawSocket(teamBoard, member.cookie);
      const viaShare = rawSocket(sharedBoard, member.cookie);
      const viaDelete = rawSocket(deletedBoard, member.cookie);
      await within(Promise.all([viaTeam.joined, viaShare.joined, viaDelete.joined]));

      expect((await api(admin.cookie, 'DELETE', `/api/boards/${deletedBoard}`)).status).toBe(204);
      expect(await within(viaDelete.closed)).toBe(4410);
      expect((await api(admin.cookie, 'DELETE', `/api/boards/${sharedBoard}/shares/user/${member.user.id}`)).status).toBe(204);
      expect(await within(viaShare.closed)).toBe(4410);
      expect(viaTeam.ws.readyState).toBe(WebSocket.OPEN);
      expect((await api(admin.cookie, 'DELETE', `/api/teams/${team.id}/members/${member.user.id}`)).status).toBe(204);
      expect(await within(viaTeam.closed)).toBe(4410);
    });

    it('closes the socket with 4410 when a member is disabled or removed', async () => {
      const team = await newTeam(owner.cookie);
      const a = await joinTeam(owner.cookie, team.id);
      const b = await joinTeam(owner.cookie, team.id);
      const board = await newBoard(owner.cookie, { teamId: team.id });

      const sa = rawSocket(board, a.cookie);
      const sb = rawSocket(board, b.cookie);
      await within(Promise.all([sa.joined, sb.joined]));
      expect((await api(owner.cookie, 'PATCH', `/api/members/${a.user.id}`, { disabled: true })).status).toBe(200);
      expect(await within(sa.closed)).toBe(4410);
      expect((await api(owner.cookie, 'DELETE', `/api/members/${b.user.id}`)).status).toBe(204);
      expect(await within(sb.closed)).toBe(4410);
    });

    it('keeps a connection whose role merely changed, and closes one that lost every role', async () => {
      const team = await newTeam(owner.cookie);
      const admin = await joinTeam(owner.cookie, team.id, 'admin');
      const member = await joinTeam(owner.cookie, team.id);
      const board = await newBoard(admin.cookie, { teamId: team.id });
      const socket = rawSocket(board, member.cookie);
      await within(socket.joined);

      // becoming a team admin changes the role from editor to owner but keeps access
      expect((await api(admin.cookie, 'PATCH', `/api/teams/${team.id}/members/${member.user.id}`, { role: 'admin' })).status).toBe(200);
      await sleep(150);
      expect(socket.ws.readyState).toBe(WebSocket.OPEN);
      expect(await roleOn(member.cookie, board)).toBe('owner');

      expect((await api(admin.cookie, 'DELETE', `/api/teams/${team.id}/members/${member.user.id}`)).status).toBe(204);
      expect(await within(socket.closed)).toBe(4410);
    });
  });
});

describe('other server configurations', () => {
  const servers: Server[] = [];

  async function launch(env: Record<string, string>): Promise<Server> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-accounts-extra-'));
    const { port, proc } = await startRelay(dir, env);
    const server = { port, base: `http://127.0.0.1:${port}`, dir, proc };
    servers.push(server);
    return server;
  }

  afterAll(async () => {
    for (const s of servers) {
      if (s.proc.exitCode === null && s.proc.signalCode === null) await stopRelay(s.proc);
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  });

  it('leaves open mode alone: config says so, other /api paths are 404 JSON, and sockets need no cookie', async () => {
    const open = await launch({ TABULA_AUTH: 'off' });
    const config = await fetch(`${open.base}/api/config`);
    expect(await config.json()).toEqual({ authEnabled: false, images: true });
    expect(((await (await fetch(`${open.base}/api/health`)).json()) as Body).ok).toBe(true);

    for (const url of ['/api/me', '/api/teams', '/api/nothing']) {
      const res = await fetch(open.base + url);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(await res.json()).toEqual({ error: 'not_found' });
    }
    const post = await fetch(`${open.base}/api/auth/request`, { method: 'POST', headers: { 'x-tabula': '1' }, body: '{}' });
    expect(post.status).toBe(404);

    const bare = rawSocket(unique('open'), undefined, {}, open.port);
    await within(bare.joined);
    expect(bare.ws.readyState).toBe(WebSocket.OPEN);
    expect(fs.existsSync(path.join(open.dir, 'directory.sqlite'))).toBe(false);
  });

  it('extends a session cookie as it slides, and ignores X-Forwarded-For unless TABULA_TRUST_PROXY=1', async () => {
    const sessionMs = 24 * 60 * 60 * 1000;
    const sessionServer = await launch({ TABULA_SESSION_DAYS: '1', TABULA_TRUST_PROXY: '0' });
    const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(sessionServer.base + p, { method: 'POST', headers: { 'x-tabula': '1', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

    expect((await post('/api/auth/request', { email: OWNER })).status).toBe(200);
    const mail = JSON.parse(fs.readFileSync(path.join(sessionServer.dir, 'outbox.jsonl'), 'utf8').trim().split('\n').pop()!) as Mail;
    const verify = await post('/api/auth/verify', { token: tokenOf(mail) });
    expect(verify.status).toBe(200);
    const issued = verify.headers.getSetCookie()[0];
    const cookie = /tabula_session=[^;]+/.exec(issued)![0];

    const early = await fetch(`${sessionServer.base}/api/me`, { headers: { cookie } });
    expect(early.status).toBe(200);
    expect(early.headers.get('set-cookie')).toBeNull();

    // Put this session past its refresh threshold directly instead of waiting for the wall clock.
    const tokenHash = crypto.createHash('sha256').update(cookie.slice(cookie.indexOf('=') + 1)).digest('hex');
    const db = new DatabaseSync(path.join(sessionServer.dir, 'directory.sqlite'));
    try {
      const changed = db.prepare('UPDATE sessions SET last_seen = expires_at - ? WHERE token_hash = ?').run(sessionMs * 3, tokenHash);
      expect(changed.changes).toBe(1);
    } finally {
      db.close();
    }

    const later = await fetch(`${sessionServer.base}/api/me`, { headers: { cookie } });
    expect(later.status).toBe(200);
    const refreshed = later.headers.get('set-cookie')!;
    expect(refreshed.startsWith(`${cookie};`)).toBe(true);
    expect(refreshed).toMatch(/Max-Age=\d+/);
    expect(refreshed).toContain('HttpOnly');

    // every request below claims a different client address, but they all come from this machine:
    // with the sign-in above that is 20 requests, the most one address may make in an hour
    for (let i = 0; i < 19; i++) {
      const res = await post('/api/auth/request', { email: emailOf('flood') }, { 'x-forwarded-for': `10.20.30.${i}` });
      expect(res.status).toBe(200);
    }
    const over = await post('/api/auth/request', { email: emailOf('flood') }, { 'x-forwarded-for': '10.20.30.99' });
    expect(over.status).toBe(429);
  });
});
