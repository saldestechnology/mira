import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApi } from '../server/api.mjs';
import { createAuth } from '../server/auth.mjs';
import { createCloud } from '../server/cloud.mjs';
import { loadConfig } from '../server/config.mjs';
import { HOUR, MIN, harness, type Harness } from './backup-harness';
import { audits, backupNow, becomeB, filesOf, rig, seedA, setting, type Rig } from './restore-harness';

// docs/backups.md, Restoring, and docs/admin.md. The owner-only routes in process, with the real restore engine.

const TOKEN = 'r'.repeat(48);
let h: Harness;
const servers: http.Server[] = [];
async function until(fn: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for deferred restore exit');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
  await h?.close();
});

type Options = { backups?: boolean; cloud?: boolean; restoring?: () => boolean; engine?: Record<string, unknown> | ((h: Harness) => Record<string, unknown>) };

async function setup({ backups = true, cloud: withCloud = false, restoring = () => false, engine = {} }: Options = {}) {
  h = await harness({ accounts: true });
  const world = seedA(h);
  const r: Rig = rig(h, typeof engine === 'function' ? engine(h) : engine);
  const a = await backupNow(h.engine());
  h.clock.now += HOUR;
  becomeB(h);
  h.clock.now += MIN;

  const d = h.directory!;
  d.createUser({ email: 'admin@example.com', name: 'Admin', role: 'admin' });
  d.createUser({ email: 'guest@example.com', name: 'Guest', role: 'guest' });
  const env = { PORT: '8787', TABULA_AUTH: 'on', TABULA_OWNER_EMAIL: 'owner@example.com', DATA_DIR: h.dir, ...(withCloud ? { TABULA_CLOUD_TOKEN: TOKEN, TABULA_CLOUD_URL: 'https://cloud.example.com', TABULA_CLOUD_WORKSPACE_ID: 'ws_restore' } : {}) };
  const config = loadConfig(env);
  const events = new EventEmitter();
  const cloud = createCloud({ config: config.cloud, directory: d, events, log: () => {} });
  const mailer = { async send() {} };
  const auth = createAuth({ directory: d, config, mailer, seatsAvailable: cloud?.seatsAvailable });
  const api = createApi({
    directory: d, auth, config, roomExists: () => false, events, cloud: cloud as never, mailer, restore: backups ? (r.restore as never) : null, maintenance: restoring,
    backupStatus: () => ({ enabled: true, restore: r.restore.status() }) as never,
  });

  let finished = 0;
  const server = http.createServer((req, res) => {
    res.on('finish', () => finished++);
    void api.handle(req, res).then((handled: boolean) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const cookieOf = (email: string) => `${config.cookieName}=${d.createSession(d.getUserByEmail(email)!.id, { ttlMs: 30 * 86_400_000 }).token}`;
  const cookies = { owner: cookieOf('owner@example.com'), admin: cookieOf('admin@example.com'), member: cookieOf('member@example.com'), guest: cookieOf('guest@example.com') };

  async function call(method: string, urlPath: string, init: { cookie?: string | null; body?: unknown; csrf?: boolean; token?: string } = {}) {
    const { cookie = cookies.owner, body, csrf = method !== 'GET', token } = init;
    const res = await fetch(base + urlPath, {
      method,
      headers: { ...(csrf ? { 'x-tabula': '1' } : {}), ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
  }
  return { ...r, ...world, manifest: a.manifest as string, call, cookies, config, cloud, finished: () => finished };
}

const ROUTES = (manifest: string): [string, string, unknown][] => [
  ['GET', '/api/admin/backups', undefined],
  ['GET', `/api/admin/backups/${manifest}`, undefined],
  ['POST', '/api/admin/backups/restore-board', { manifest, boardId: 'b1' }],
  ['POST', '/api/admin/backups/restore', { manifest, confirm: 'RESTORE' }],
];

describe('who may use the routes', () => {
  it('needs a session: 401 without one', async () => {
    const s = await setup();
    for (const [method, url, body] of ROUTES(s.manifest)) {
      const res = await s.call(method, url, { cookie: null, body });
      expect(res.status, `${method} ${url}`).toBe(401);
      expect(res.body).toMatchObject({ error: 'unauthenticated' });
    }
    expect((await s.call('GET', '/api/admin/backups', { cookie: `${s.config.cookieName}=garbage` })).status).toBe(401);
  });

  it('is for the owner alone: admins, members and guests get 403 and nothing happens', async () => {
    const s = await setup();
    for (const who of ['admin', 'member', 'guest'] as const) {
      for (const [method, url, body] of ROUTES(s.manifest)) {
        const res = await s.call(method, url, { cookie: s.cookies[who], body });
        expect(res.status, `${who} ${method} ${url}`).toBe(403);
        expect(res.body).toMatchObject({ error: 'forbidden' });
      }
    }
    expect(s.exits).toEqual([]);
    expect(h.directory!.listBoardsAdmin().map((b) => b.id).sort()).toEqual(['b1', 'b2', 'b3']);
    expect(audits(h.directory!, 50).filter((r) => r.action.startsWith('restore.') || r.action.startsWith('backup.list'))).toEqual([]);
  });

  it('needs the CSRF header on the POSTs, for every caller', async () => {
    const s = await setup();
    for (const [url, body] of [['/api/admin/backups/restore-board', { manifest: s.manifest, boardId: 'b1' }], ['/api/admin/backups/restore', { manifest: s.manifest, confirm: 'RESTORE' }]] as const) {
      const res = await s.call('POST', url, { body, csrf: false });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'csrf' });
      expect((await s.call('POST', url, { body, csrf: false, cookie: s.cookies.member })).body).toMatchObject({ error: 'csrf' });
    }
    expect(setting(h.directory!, 'fixture')).toBe('B');
    expect(s.exits).toEqual([]);
  });

  it('answers backups_off, for the owner only, when backups are not set up', async () => {
    const s = await setup({ backups: false });
    for (const [method, url, body] of ROUTES(s.manifest)) {
      const res = await s.call(method, url, { body });
      expect(res.status, `${method} ${url}`).toBe(409);
      expect(res.body).toMatchObject({ error: 'backups_off' });
      expect((await s.call(method, url, { body, cookie: s.cookies.admin })).status).toBe(403);
    }
  });
});

describe('listing and previewing', () => {
  it('lists the backups newest first with the restore status, and writes an audit row', async () => {
    const s = await setup();
    const res = await s.call('GET', '/api/admin/backups');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body.backups).toHaveLength(1);
    expect(res.body.backups[0]).toMatchObject({ name: s.manifest, readable: true, protected: false, keyId: s.backup.keyId });
    expect(Object.keys(res.body.backups[0]).sort()).toEqual(['bytes', 'createdAt', 'files', 'keyId', 'name', 'protected', 'protectedUntil', 'readable']);
    expect(res.body.restore).toMatchObject({ inProgress: null, last: null });
    expect(audits(h.directory!, 5).find((r) => r.action === 'backup.list')).toMatchObject({ actorId: s.owner.id });
  });

  it('previews one backup with the word to type and how long the old data is kept', async () => {
    const s = await setup();
    const res = await s.call('GET', `/api/admin/backups/${s.manifest}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: s.manifest, confirmWord: 'RESTORE', keepOldFor: '7 days', boards: 2, space: { enough: true } });
    expect(typeof res.body.reason).toBe('string');
    expect(audits(h.directory!, 5).find((r) => r.action === 'backup.preview')).toMatchObject({ detail: { manifest: s.manifest } });
    expect((await s.call('GET', '/api/admin/backups/not-a-manifest')).status).toBe(400);
    expect((await s.call('GET', '/api/admin/backups/restore')).status).toBe(400);
    expect((await s.call('GET', '/api/admin/backups/20200101T000000Z.json.enc')).body).toMatchObject({ error: 'manifest_not_found' });
  });
});

describe('restoring a board', () => {
  const post = (s: Awaited<ReturnType<typeof setup>>, body: unknown, cookie = s.cookies.owner) => s.call('POST', '/api/admin/backups/restore-board', { body, cookie });

  it('makes a copy and answers with where it is', async () => {
    const s = await setup();
    const res = await post(s, { manifest: s.manifest, boardId: 'b1' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, teamId: s.team.id, title: 'Restored: Roadmap 2026-10-08' });
    expect(h.directory!.getBoard(res.body.boardId)).toMatchObject({ ownerId: s.owner.id });
  });

  it('answers with the fallback message when the team is not usable', async () => {
    const s = await setup();
    h.directory!.removeTeamMember(s.team.id, s.owner.id);
    const res = await post(s, { manifest: s.manifest, boardId: 'b1' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ fallback: 'personal', teamId: null, message: 'The original team no longer exists or you cannot see it, so the copy is in your personal space.' });
  });

  it('maps the refusals to plain answers', async () => {
    const s = await setup();
    expect((await post(s, { manifest: s.manifest, boardId: 'nope' })).status).toBe(404);
    expect((await post(s, { manifest: s.manifest, boardId: 'nope' })).body).toMatchObject({ error: 'board_not_in_backup' });
    expect((await post(s, { manifest: s.manifest, boardId: '../b1' })).body).toMatchObject({ error: 'bad_request' });
    expect((await post(s, { manifest: 3, boardId: 'b1' })).status).toBe(400);
    expect((await post(s, { manifest: s.manifest })).status).toBe(400);
    expect((await post(s, { manifest: s.manifest, boardId: 'b1', extra: 1 })).body).toMatchObject({ error: 'bad_request', message: 'Unknown field: extra' });
    expect((await post(s, { manifest: '20200101T000000Z.json.enc', boardId: 'b1' })).status).toBe(404);
  });

  it('is limited to ten in ten minutes, with Retry-After', async () => {
    const s = await setup();
    for (let i = 0; i < 10; i++) expect((await post(s, { manifest: s.manifest, boardId: 'b2' })).status).toBe(200);
    const res = await post(s, { manifest: s.manifest, boardId: 'b2' });
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: 'rate_limited' });
    expect(res.headers.get('retry-after')).toBe('600');
    expect(res.body).not.toHaveProperty('retryAfter');
  });
});

describe('restoring the workspace', () => {
  const post = (s: Awaited<ReturnType<typeof setup>>, body: unknown, cookie = s.cookies.owner) => s.call('POST', '/api/admin/backups/restore', { body, cookie });

  it('needs the confirmation word, and refuses without it', async () => {
    const s = await setup();
    for (const confirm of ['restore', 'Restore', '', 'RESTORE ', 'yes']) {
      const res = await post(s, { manifest: s.manifest, confirm });
      expect(res.status, `${confirm}`).toBe(400);
      expect(res.body).toMatchObject({ error: 'confirmation_mismatch' });
    }
    expect((await post(s, { manifest: s.manifest })).status).toBe(400);
    expect((await post(s, { manifest: s.manifest, confirm: 'RESTORE', keepOldData: false })).body).toMatchObject({ error: 'bad_request', message: 'Unknown field: keepOldData' });
    expect(setting(h.directory!, 'fixture')).toBe('B');
    expect(s.exits).toEqual([]);
  });

  it('answers 202 first, and only then leaves with 75', async () => {
    const probe = { finished: () => 0, whenLeaving: -1, code: -1 };
    const s = await setup({ engine: { exit: (code: number) => Object.assign(probe, { whenLeaving: probe.finished(), code }) } });
    probe.finished = s.finished;
    const res = await post(s, { manifest: s.manifest, confirm: 'RESTORE' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true, restarting: true, keepOldFor: '7 days' });
    await until(() => probe.code === 75);
    expect(probe).toMatchObject({ code: 75 });
    expect(probe.whenLeaving).toBeGreaterThanOrEqual(1);
  });

  it('restores: the files are the backed up ones and the owner is signed out', async () => {
    const s = await setup();
    const res = await post(s, { manifest: s.manifest, confirm: 'RESTORE' });
    expect(res.status).toBe(202);
    expect(await s.exited).toBe(75);
    expect(fs.existsSync(`${h.dir}/b3.yjs`)).toBe(false);
    expect(filesOf(h.dir).get('b1.yjs')!.length).toBeGreaterThan(0);
    expect(fs.readdirSync(h.dir).filter((n) => n.startsWith('.pre-restore-'))).toHaveLength(1);
  });

  it('answers 409 to a second one while the first runs, and 429 when one was just tried', async () => {
    let open!: (v: { ok: boolean }) => void;
    let enterRun!: () => void;
    const held = new Promise<{ ok: boolean }>((resolve) => (open = resolve));
    const entered = new Promise<void>((resolve) => (enterRun = resolve));
    const s = await setup({ engine: (hh) => ({ backup: { ...hh.engine(), runNow: () => { enterRun(); return held; } } }) });
    const first = post(s, { manifest: s.manifest, confirm: 'RESTORE' });
    await entered;
    const second = await post(s, { manifest: s.manifest, confirm: 'RESTORE' });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: 'restore_in_progress' });
    expect((await s.call('POST', '/api/admin/backups/restore-board', { body: { manifest: s.manifest, boardId: 'b1' } })).status).toBe(409);
    open({ ok: false });
    const failed = await first;
    expect(failed.status).toBe(502);
    expect(failed.body).toMatchObject({ error: 'safety_backup_failed' });
    const again = await post(s, { manifest: s.manifest, confirm: 'RESTORE' });
    expect(again.status).toBe(429);
    expect(again.body).toMatchObject({ error: 'rate_limited' });
    expect(Number(again.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(s.exits).toEqual([]);
  });

  it('says what went wrong without a secret, and changes nothing, when the safety backup fails', async () => {
    const s = await setup();
    h.fake.rules.push({ method: 'PUT', status: 403, times: 999 });
    const res = await post(s, { manifest: s.manifest, confirm: 'RESTORE' });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ error: 'safety_backup_failed', detail: 'S3 PUT failed (status 403, AccessDenied)' });
    expect(JSON.stringify(res.body)).not.toMatch(/AKIA|canary|Signature/);
    expect(setting(h.directory!, 'fixture')).toBe('B');
    expect(s.exits).toEqual([]);
  });

  it('answers 507 with the space needed and free when the disk is too small', async () => {
    const s = await setup({ engine: { statfs: async () => ({ bsize: 4096, blocks: 1000, bavail: 100 }) } });
    const res = await post(s, { manifest: s.manifest, confirm: 'RESTORE' });
    expect(res.status).toBe(507);
    expect(res.body).toMatchObject({ error: 'not_enough_space', free: 409600 });
    expect(res.body.needed).toBeGreaterThan(64 * 1024 * 1024);
  });
});

describe('a hosted workspace that is read-only', () => {
  it('still lists, previews and restores the whole workspace, but refuses to add a board', async () => {
    const s = await setup({ cloud: true });
    s.cloud!.setLimits({ readOnly: true });
    expect((await s.call('PATCH', '/api/me', { body: { name: 'x' } })).status).toBe(402);
    expect((await s.call('GET', '/api/admin/backups')).status).toBe(200);
    expect((await s.call('GET', `/api/admin/backups/${s.manifest}`)).status).toBe(200);
    const board = await s.call('POST', '/api/admin/backups/restore-board', { body: { manifest: s.manifest, boardId: 'b1' } });
    expect(board.status).toBe(402);
    expect(board.body).toMatchObject({ error: 'read_only' });
    expect(roomsAdded()).toBe(0);
    const res = await s.call('POST', '/api/admin/backups/restore', { body: { manifest: s.manifest, confirm: 'RESTORE' } });
    expect(res.status).toBe(202);
    expect(await s.exited).toBe(75);
  });

  it('adds a board as usual when the workspace is writable', async () => {
    const s = await setup({ cloud: true });
    s.cloud!.setLimits({ readOnly: false }); // the state the test left in the settings was read-only
    const board = await s.call('POST', '/api/admin/backups/restore-board', { body: { manifest: s.manifest, boardId: 'b1' } });
    expect(board.status).toBe(200);
  });
});

const roomsAdded = () => fs.readdirSync(h.dir).filter((n) => /^[A-Za-z0-9_-]{9}\.yjs$/.test(n)).length;

describe('maintenance mode', () => {
  it('answers 503 restoring to everything but the backup status', async () => {
    const s = await setup({ cloud: true, restoring: () => true });
    for (const [method, url, body] of [
      ['GET', '/api/me', undefined], ['GET', '/api/boards', undefined], ['POST', '/api/boards', { id: 'x' }], ['GET', '/api/admin/backups', undefined],
      ['POST', '/api/admin/backups/restore', { manifest: s.manifest, confirm: 'RESTORE' }], ['POST', '/api/auth/request', { email: 'a@b.co' }], ['GET', '/api/config', undefined],
      ['GET', '/api/internal/usage', undefined], ['PUT', '/api/internal/limits', { readOnly: false }], ['GET', '/api/nothing-here', undefined],
    ] as [string, string, unknown][]) {
      const res = await s.call(method, url, { body, token: TOKEN });
      expect(res.status, `${method} ${url}`).toBe(503);
      expect(res.body).toMatchObject({ error: 'restoring' });
      expect(res.headers.get('retry-after')).toBe('30');
    }
    expect(s.exits).toEqual([]);
  });

  it('keeps answering the backup status, with the restore in it, to the control plane', async () => {
    const s = await setup({ cloud: true, restoring: () => true });
    const ok = await s.call('GET', '/api/internal/backup-status', { cookie: null, token: TOKEN });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ enabled: true, restore: { inProgress: null } });
    expect((await s.call('GET', '/api/internal/backup-status', { cookie: null })).status).toBe(401);
    expect((await s.call('POST', '/api/internal/backup-status', { cookie: null, token: TOKEN })).status).toBe(503);
  });

  it('is off otherwise', async () => {
    const s = await setup({ cloud: true });
    expect((await s.call('GET', '/api/me')).status).toBe(200);
  });
});
