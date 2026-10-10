import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { CSRF_HEADER } from '../server/auth.mjs';
import { startRelayProcess } from './start-relay';

// docs/history.md. The relay runs as a child process exactly as `npm start` would: once in open mode,
// once in accounts mode and once as a hosted workspace that can be made read-only.

const OWNER = 'owner@example.com';
const TOKEN = 'h'.repeat(48);

type Body = any;
type Res = { status: number; body: Body; headers: Headers };
type Account = { cookie: string; user: Body; email: string };
type Server = { port: number; base: string; dir: string; proc: ChildProcess };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(fn: () => boolean | Promise<boolean>, ms = 8000) {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await sleep(40);
  }
}

const servers: Server[] = [];

const stopRelay = (p: ChildProcess) =>
  new Promise<void>((r) => {
    if (p.exitCode !== null || p.signalCode !== null) return r();
    p.once('exit', () => r());
    p.kill('SIGTERM');
  });

async function launch(env: Record<string, string> = {}): Promise<Server> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-relay-'));
  const accounts = env.TABULA_AUTH === 'on';
  const { port, proc } = await startRelayProcess({
    envFor: (port) => ({
      ...(process.env as Record<string, string>),
      PORT: String(port),
      DATA_DIR: dir,
      HOST: '127.0.0.1',
      ...(accounts ? { TABULA_OWNER_EMAIL: OWNER, TABULA_MAIL: 'file', TABULA_BASE_URL: `http://127.0.0.1:${port}`, TABULA_TRUST_PROXY: '1' } : {}),
      ...env,
    }),
  });
  const server = { port, base: `http://127.0.0.1:${port}`, dir, proc };
  servers.push(server);
  return server;
}

afterAll(async () => {
  for (const s of servers) {
    await stopRelay(s.proc);
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

const providers = new Set<WebsocketProvider>();
afterEach(() => {
  for (const p of providers) p.destroy();
  providers.clear();
});

// ---------------------------------------------------------------- http

let seq = 0;
const unique = (tag: string) => `${tag}${++seq}x${Math.random().toString(36).slice(2, 7)}`;
let ipSeq = 0;
const nextIp = () => `10.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}.9`;

async function call(s: Server, cookie: string | undefined, method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const res = await fetch(s.base + urlPath, {
    method,
    headers: {
      [CSRF_HEADER]: '1',
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Body;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

const versionsUrl = (board: string) => `/api/boards/${board}/versions`;
const list = async (s: Server, cookie: string | undefined, board: string) => (await call(s, cookie, 'GET', versionsUrl(board))).body.versions as Body[];

async function stateOf(s: Server, cookie: string | undefined, board: string, id: string) {
  const res = await fetch(`${s.base}${versionsUrl(board)}/${id}/state`, { headers: cookie ? { cookie } : {} });
  const doc = new Y.Doc();
  if (res.ok) Y.applyUpdate(doc, new Uint8Array(await res.arrayBuffer()));
  return { res, doc };
}

function savedObjectCount(s: Server, board: string): number | null {
  const file = path.join(s.dir, `${board}.yjs`);
  if (!fs.existsSync(file)) return null;
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, fs.readFileSync(file));
    return doc.getMap('objects').size;
  } finally {
    doc.destroy();
  }
}

// ---------------------------------------------------------------- websocket

const wsFor = (s: Server, cookie?: string) =>
  class extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols, { headers: { Origin: s.base, ...(cookie ? { Cookie: cookie } : {}) } });
    }
  };

function connect(s: Server, board: string, cookie?: string) {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`ws://127.0.0.1:${s.port}/sync`, board, doc, {
    WebSocketPolyfill: wsFor(s, cookie) as unknown as typeof globalThis.WebSocket,
    disableBc: true,
  });
  providers.add(provider);
  return { doc, provider, objects: doc.getMap('objects') as Y.Map<unknown> };
}

const synced = (c: ReturnType<typeof connect>) => until(() => c.provider.wsconnected && c.provider.synced);

function put(c: ReturnType<typeof connect>, from: number, count: number) {
  c.doc.transact(() => {
    for (let i = from; i < from + count; i++) c.objects.set(`o${i}`, new Y.Map(Object.entries({ id: `o${i}`, type: 'shape', text: `note ${i}` })));
  });
}

// ---------------------------------------------------------------- open mode

describe('version history in open mode', { timeout: 40_000 }, () => {
  let s: Server;
  beforeAll(async () => {
    s = await launch({ TABULA_AUTH: 'off' });
  });

  it('writes a version when a board is first saved, and serves the list and the state without a session', async () => {
    const board = unique('open');
    const c = connect(s, board);
    await synced(c);
    put(c, 0, 6);
    await until(async () => (await list(s, undefined, board)).length === 1);

    const [v] = await list(s, undefined, board);
    expect(v).toMatchObject({ kind: 'auto', objects: 6, label: null, by: null, from: null });
    expect(Object.keys(v).sort()).toEqual(['by', 'byName', 'bytes', 'createdAt', 'from', 'id', 'kind', 'label', 'objects'].sort());

    const { res, doc } = await stateOf(s, undefined, board, v.id);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(doc.getMap('objects').size).toBe(6);
    expect(fs.existsSync(path.join(s.dir, 'history', board, 'index.json'))).toBe(true);
  });

  it('saves, names, renames and deletes named versions, asking for the same CSRF check as the accounts API', async () => {
    const board = unique('open');
    const c = connect(s, board);
    await synced(c);
    put(c, 0, 3);
    await until(async () => (await list(s, undefined, board)).length === 1);

    // no header, or a page from another site: refused
    expect((await call(s, undefined, 'POST', versionsUrl(board), { label: 'x' }, { [CSRF_HEADER]: '' })).status).toBe(403);
    const foreign = await call(s, undefined, 'POST', versionsUrl(board), { label: 'x' }, { origin: 'http://evil.example' });
    expect(foreign).toMatchObject({ status: 403, body: { error: 'csrf' } });
    expect((await list(s, undefined, board)).filter((x) => x.kind === 'named')).toHaveLength(0);

    // the newest version has this content: it gets the name (200), not a copy
    const first = await call(s, undefined, 'POST', versionsUrl(board), { label: 'Kick-off', by: 'Ana' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ kind: 'named', label: 'Kick-off', byName: 'Ana' });
    expect(await list(s, undefined, board)).toHaveLength(1);

    put(c, 3, 2);
    await until(async () => (await call(s, undefined, 'GET', `/api/boards/${board}/versions`)).status === 200);
    const second = await call(s, undefined, 'POST', versionsUrl(board), { label: 'Five notes' });
    expect(second.status).toBe(201);
    expect(second.body.objects).toBe(5);

    const bad = await call(s, undefined, 'POST', versionsUrl(board), { label: '  ' });
    expect(bad).toMatchObject({ status: 400, body: { error: 'bad_request' } });

    const renamed = await call(s, undefined, 'PATCH', `${versionsUrl(board)}/${second.body.id}`, { label: 'Final' });
    expect(renamed.body.label).toBe('Final');
    expect((await call(s, undefined, 'DELETE', `${versionsUrl(board)}/${second.body.id}`)).status).toBe(204);
    expect((await call(s, undefined, 'DELETE', `${versionsUrl(board)}/${second.body.id}`)).status).toBe(404);
    expect((await call(s, undefined, 'DELETE', `${versionsUrl(board)}/${first.body.id}`, undefined, { [CSRF_HEADER]: '' })).status).toBe(403);
    expect((await list(s, undefined, board)).map((x) => x.label)).toEqual(['Kick-off']);
  });

  it('begins a restore: the board as it is becomes a version, and the restoring edit becomes a restore version', async () => {
    const board = unique('open');
    const c = connect(s, board);
    await synced(c);
    put(c, 0, 6);
    await until(async () => (await list(s, undefined, board)).length === 1);
    const target = (await list(s, undefined, board))[0];

    put(c, 6, 4);
    await until(() => savedObjectCount(s, board) === 10, 20_000); // the interval keeps it from being another automatic version
    const begun = await call(s, undefined, 'POST', `${versionsUrl(board)}/${target.id}/begin-restore`, {});
    expect(begun.status).toBe(200);
    expect(begun.body.preRestore).toMatchObject({ kind: 'pre-restore', objects: 10, from: target.id });
    const pre = await stateOf(s, undefined, board, begun.body.preRestore.id);
    expect(pre.doc.getMap('objects').size).toBe(10);

    // the client now applies the difference as an ordinary edit
    c.doc.transact(() => {
      for (let i = 6; i < 10; i++) c.objects.delete(`o${i}`);
    });
    await until(async () => (await list(s, undefined, board)).some((x) => x.kind === 'restore'));
    const restored = (await list(s, undefined, board)).find((x) => x.kind === 'restore');
    expect(restored).toMatchObject({ from: target.id, objects: 6 });
  });

  it('lists nothing for a board that was never saved and creates nothing for it', async () => {
    const board = unique('ghost');
    expect(await list(s, undefined, board)).toEqual([]);
    expect(fs.existsSync(path.join(s.dir, 'history', board))).toBe(false);
    const empty = await call(s, undefined, 'POST', versionsUrl(board), { label: 'x' });
    expect(empty).toMatchObject({ status: 409, body: { error: 'empty' } });
  });

  it('keeps every other /api path a 404 and answers a wrong method on the version routes with 405', async () => {
    for (const p of ['/api/boards', '/api/me', '/api/boards/abc/shares', '/api/boards/abc/versions/short', '/api/boards/abc/versions/AAAAAAAAAAAAAAAA/other', '/api/boards/abc/versionsx']) {
      expect((await call(s, undefined, 'GET', p)).status).toBe(404);
    }
    expect((await call(s, undefined, 'PUT', versionsUrl('abc'), {})).status).toBe(405);
    expect((await call(s, undefined, 'DELETE', versionsUrl('abc'))).status).toBe(405);
    expect((await call(s, undefined, 'GET', '/api/config')).body).toEqual({ authEnabled: false, images: true });
  });

  it('never snapshots the comments room', async () => {
    const board = unique('open');
    const c = connect(s, `${board}~comments`);
    await synced(c);
    c.doc.getMap('threads').set('t1', new Y.Map(Object.entries({ id: 't1', text: 'hello' })));
    await until(() => fs.existsSync(path.join(s.dir, `${board}~comments.yjs`)));
    expect(fs.existsSync(path.join(s.dir, 'history', board))).toBe(false);
    expect(fs.existsSync(path.join(s.dir, 'history', `${board}~comments`))).toBe(false);
  });
});

// ---------------------------------------------------------------- accounts mode

let seed = 0;
const mailLines = (s: Server) => {
  const file = path.join(s.dir, 'outbox.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

async function signIn(s: Server, email: string, invite?: string): Promise<Account> {
  const before = mailLines(s).length;
  const req = await call(s, undefined, 'POST', '/api/auth/request', { email, invite }, { 'x-forwarded-for': nextIp() });
  if (req.status !== 200) throw new Error(`sign-in request failed (${req.status})`);
  const mail = mailLines(s).slice(before).pop();
  const token = decodeURIComponent(/token=([^\s&]+)/.exec(mail.text)![1]);
  const verify = await call(s, undefined, 'POST', '/api/auth/verify', { token });
  if (verify.status !== 200) throw new Error(`verify failed (${verify.status})`);
  return { cookie: verify.headers.getSetCookie()[0].split(';')[0], user: verify.body.user, email };
}

async function teamMember(s: Server, admin: Account, teamId: string): Promise<Account> {
  const invite = await call(s, admin.cookie, 'POST', `/api/teams/${teamId}/invites`, { role: 'member' });
  return signIn(s, `member${++seed}-${unique('m')}@example.com`, invite.body.token);
}

describe('version history in accounts mode', { timeout: 60_000 }, () => {
  let s: Server;
  let owner: Account;
  let editor: Account;
  let editor2: Account;
  let outsider: Account;
  let viewer: Account;
  let commenter: Account;
  let teamId: string;
  let board: string;
  let guestBoard: string;
  let otherBoard: string;

  /** A board with something on it and its first automatic version; in the team unless told otherwise. */
  async function freshBoard(inTeam = true): Promise<string> {
    const id = unique('hist');
    const created = await call(s, owner.cookie, 'POST', '/api/boards', { id, ...(inTeam ? { teamId } : {}) });
    expect(created.status).toBe(201);
    const c = connect(s, id, owner.cookie);
    await synced(c);
    put(c, 0, 5);
    await until(async () => (await list(s, owner.cookie, id)).length === 1);
    return id;
  }

  beforeAll(async () => {
    s = await launch({ TABULA_AUTH: 'on' });
    owner = await signIn(s, OWNER);
    teamId = (await call(s, owner.cookie, 'POST', '/api/teams', { name: 'Design' })).body.id;
    const elsewhere = (await call(s, owner.cookie, 'POST', '/api/teams', { name: 'Elsewhere' })).body.id;
    editor = await teamMember(s, owner, teamId);
    editor2 = await teamMember(s, owner, teamId);
    outsider = await teamMember(s, owner, elsewhere);
    viewer = await teamMember(s, owner, elsewhere);
    commenter = await teamMember(s, owner, elsewhere);

    board = await freshBoard();
    otherBoard = await freshBoard();
    // viewer and commenter belong to another team, so they only have what is shared with them
    guestBoard = await freshBoard(false);
    const share = (who: Account, role: string) => call(s, owner.cookie, 'POST', `/api/boards/${guestBoard}/shares`, { principalType: 'user', principalId: who.user.id, role });
    for (const [who, role] of [[viewer, 'viewer'], [commenter, 'commenter'], [editor, 'editor']] as const) {
      if ((await share(who, role)).status !== 201) throw new Error(`could not share the board as ${role}`);
    }
  });

  it('needs a session and a board the person can open', async () => {
    expect((await call(s, undefined, 'GET', versionsUrl(board))).status).toBe(401);
    expect((await call(s, undefined, 'POST', versionsUrl(board), { label: 'x' })).status).toBe(401);
    expect((await call(s, outsider.cookie, 'GET', versionsUrl(board))).status).toBe(404);
    expect((await call(s, owner.cookie, 'GET', versionsUrl('nosuchboard'))).status).toBe(404);
    expect((await call(s, owner.cookie, 'GET', versionsUrl('unregistered'))).status).toBe(404);
  });

  it('shows history to owners and editors only', async () => {
    for (const who of [owner, editor, editor2]) {
      const res = await call(s, who.cookie, 'GET', versionsUrl(board));
      expect(res.status).toBe(200);
      expect(res.body.versions).toHaveLength(1);
    }
    expect((await call(s, editor.cookie, 'GET', versionsUrl(guestBoard))).status).toBe(200);

    const id = (await list(s, owner.cookie, guestBoard))[0].id;
    for (const who of [viewer, commenter]) {
      expect((await call(s, who.cookie, 'GET', '/api/boards')).body.find((b: Body) => b.id === guestBoard).role).toMatch(/viewer|commenter/);
      const refused = await call(s, who.cookie, 'GET', versionsUrl(guestBoard));
      expect(refused).toMatchObject({ status: 403, body: { error: 'forbidden' } });
      for (const [method, p, body] of [
        ['POST', versionsUrl(guestBoard), { label: 'x' }],
        ['GET', `${versionsUrl(guestBoard)}/${id}/state`, undefined],
        ['PATCH', `${versionsUrl(guestBoard)}/${id}`, { label: 'x' }],
        ['DELETE', `${versionsUrl(guestBoard)}/${id}`, undefined],
        ['POST', `${versionsUrl(guestBoard)}/${id}/begin-restore`, {}],
      ] as const) {
        expect((await call(s, who.cookie, method, p, body)).status, `${method} ${p}`).toBe(403);
      }
    }
    expect(await list(s, owner.cookie, guestBoard)).toHaveLength(1);
  });

  it('refuses a state-changing call without the CSRF header', async () => {
    const res = await call(s, owner.cookie, 'POST', versionsUrl(board), { label: 'x' }, { [CSRF_HEADER]: '' });
    expect(res).toMatchObject({ status: 403, body: { error: 'csrf' } });
  });

  it('serves a version’s state, gzip on the wire, equal to the room at that moment', async () => {
    const [v] = await list(s, editor.cookie, board);
    const { res, doc } = await stateOf(s, editor.cookie, board, v.id);
    expect(res.status).toBe(200);
    expect(doc.getMap('objects').size).toBe(5);

    // a client that does not take gzip gets the inflated bytes
    const plain = await fetch(`${s.base}${versionsUrl(board)}/${v.id}/state`, { headers: { cookie: editor.cookie, 'accept-encoding': 'identity' } });
    const bytes = new Uint8Array(await plain.arrayBuffer());
    expect(plain.headers.get('content-encoding')).toBeNull();
    const check = new Y.Doc();
    Y.applyUpdate(check, bytes);
    expect(check.getMap('objects').size).toBe(5);
  });

  it('keeps a version id of another board out of reach', async () => {
    const [v] = await list(s, owner.cookie, otherBoard);
    expect((await call(s, owner.cookie, 'GET', `${versionsUrl(board)}/${v.id}/state`)).status).toBe(404);
    expect((await call(s, owner.cookie, 'PATCH', `${versionsUrl(board)}/${v.id}`, { label: 'x' })).status).toBe(404);
    expect((await call(s, owner.cookie, 'DELETE', `${versionsUrl(board)}/${v.id}`)).status).toBe(404);
    expect((await call(s, owner.cookie, 'POST', `${versionsUrl(board)}/${v.id}/begin-restore`, {})).status).toBe(404);
    expect((await call(s, owner.cookie, 'GET', `${versionsUrl(board)}/not-a-version-id/state`)).status).toBe(404);
    expect(await list(s, owner.cookie, otherBoard)).toHaveLength(1);
  });

  it('lets an editor rename and delete only the named versions they created, and the owner any', async () => {
    const id = await freshBoard();
    const auto = (await list(s, owner.cookie, id))[0];

    // an automatic version: any editor can name it, nobody but the owner deletes it
    expect((await call(s, editor2.cookie, 'DELETE', `${versionsUrl(id)}/${auto.id}`)).status).toBe(403);
    const named = await call(s, editor.cookie, 'POST', versionsUrl(id), { label: 'Editor one' });
    expect(named.status).toBe(200); // same content as the newest version: it is named, not copied
    expect(named.body).toMatchObject({ id: auto.id, kind: 'named', by: editor.user.id, byName: editor.user.name });

    expect((await call(s, editor2.cookie, 'PATCH', `${versionsUrl(id)}/${auto.id}`, { label: 'Hijacked' })).status).toBe(403);
    expect((await call(s, editor2.cookie, 'DELETE', `${versionsUrl(id)}/${auto.id}`)).status).toBe(403);
    expect((await call(s, editor.cookie, 'PATCH', `${versionsUrl(id)}/${auto.id}`, { label: 'Editor renamed' })).body.label).toBe('Editor renamed');
    const byOwner = await call(s, owner.cookie, 'PATCH', `${versionsUrl(id)}/${auto.id}`, { label: 'Owner renamed' });
    expect(byOwner.body).toMatchObject({ label: 'Owner renamed', by: editor.user.id });

    // the creator can still delete it; so can the owner
    expect((await call(s, editor.cookie, 'DELETE', `${versionsUrl(id)}/${auto.id}`)).status).toBe(204);
    expect(await list(s, owner.cookie, id)).toEqual([]);

    const again = await call(s, owner.cookie, 'POST', versionsUrl(id), { label: 'Owner one' });
    expect(again.status).toBe(201);
    expect((await call(s, editor.cookie, 'DELETE', `${versionsUrl(id)}/${again.body.id}`)).status).toBe(403);
    expect((await call(s, owner.cookie, 'DELETE', `${versionsUrl(id)}/${again.body.id}`)).status).toBe(204);
  });

  it('writes audit rows for create, rename, delete and restore, and none for automatic versions', async () => {
    const id = await freshBoard();
    const created = await call(s, owner.cookie, 'POST', versionsUrl(id), { label: 'Audited' });
    expect(created.status).toBe(200);
    await call(s, owner.cookie, 'PATCH', `${versionsUrl(id)}/${created.body.id}`, { label: 'Audited again' });
    const begun = await call(s, owner.cookie, 'POST', `${versionsUrl(id)}/${created.body.id}/begin-restore`, {});
    expect(begun.status).toBe(200);
    await call(s, owner.cookie, 'DELETE', `${versionsUrl(id)}/${created.body.id}`);

    const audit = await call(s, owner.cookie, 'GET', '/api/admin/audit?action=board.version&limit=200');
    const rows = (audit.body.entries as Body[]).filter((e) => e.detail.boardId === id);
    expect(rows.map((e) => e.action).sort()).toEqual(['board.version.create', 'board.version.delete', 'board.version.rename', 'board.version.restore']);
    expect(rows.find((e) => e.action === 'board.version.create')!.detail).toMatchObject({ versionId: created.body.id, label: 'Audited' });
    expect(rows.find((e) => e.action === 'board.version.restore')!.detail).toMatchObject({ versionId: created.body.id });
    expect(rows.every((e) => e.actorId === owner.user.id)).toBe(true);
    // every board here has an automatic version, and none of them wrote a row of its own
    expect((audit.body.entries as Body[]).every((e) => /^board\.version\.(create|rename|delete|restore)$/.test(e.action))).toBe(true);
  });

  it('records the restore a person began, and the edit that follows becomes a restore version', async () => {
    const target = (await list(s, owner.cookie, board))[0];
    const c = connect(s, board, editor.cookie);
    await synced(c);
    put(c, 5, 3);
    await until(() => savedObjectCount(s, board) === 8, 20_000);
    const begun = await call(s, editor.cookie, 'POST', `${versionsUrl(board)}/${target.id}/begin-restore`, {});
    expect(begun.body.preRestore).toMatchObject({ kind: 'pre-restore', objects: 8, by: editor.user.id, from: target.id });
    c.doc.transact(() => {
      for (let i = 5; i < 8; i++) c.objects.delete(`o${i}`);
    });
    await until(async () => (await list(s, owner.cookie, board)).some((x) => x.kind === 'restore'));
    const restore = (await list(s, owner.cookie, board)).find((x) => x.kind === 'restore');
    expect(restore).toMatchObject({ from: target.id, by: editor.user.id, objects: 5 });
  });

  it('answers 404 for a deleted board', async () => {
    const gone = await freshBoard(false);
    expect((await call(s, owner.cookie, 'DELETE', `/api/boards/${gone}`)).status).toBe(204);
    expect((await call(s, owner.cookie, 'GET', versionsUrl(gone))).status).toBe(404);
  });
});

// ---------------------------------------------------------------- a hosted workspace that turns read-only

describe('version history in a read-only hosted workspace', { timeout: 60_000 }, () => {
  it('still lists and previews, and answers every change with 402', async () => {
    const s = await launch({
      TABULA_AUTH: 'on',
      TABULA_CLOUD_TOKEN: TOKEN,
      TABULA_CLOUD_URL: 'http://127.0.0.1:9',
      TABULA_CLOUD_WORKSPACE_ID: 'ws_history',
    });
    const owner = await signIn(s, OWNER);
    const board = unique('ro');
    expect((await call(s, owner.cookie, 'POST', '/api/boards', { id: board })).status).toBe(201);
    const c = connect(s, board, owner.cookie);
    await synced(c);
    put(c, 0, 4);
    await until(async () => (await list(s, owner.cookie, board)).length === 1);
    const [v] = await list(s, owner.cookie, board);

    const lock = await call(s, undefined, 'PUT', '/api/internal/limits', { readOnly: true }, { authorization: `Bearer ${TOKEN}` });
    expect(lock.status).toBe(200);

    expect((await call(s, owner.cookie, 'GET', versionsUrl(board))).status).toBe(200);
    expect((await stateOf(s, owner.cookie, board, v.id)).doc.getMap('objects').size).toBe(4);
    for (const [method, p, body] of [
      ['POST', versionsUrl(board), { label: 'x' }],
      ['PATCH', `${versionsUrl(board)}/${v.id}`, { label: 'x' }],
      ['DELETE', `${versionsUrl(board)}/${v.id}`, undefined],
      ['POST', `${versionsUrl(board)}/${v.id}/begin-restore`, {}],
    ] as const) {
      const res = await call(s, owner.cookie, method, p, body);
      expect(res.status, `${method} ${p}`).toBe(402);
      expect(res.body.error).toBe('read_only');
    }
    expect((await list(s, owner.cookie, board))[0].kind).toBe('auto');
  });
});
