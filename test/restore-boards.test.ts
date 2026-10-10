import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApi } from '../server/api.mjs';
import { createAuth } from '../server/auth.mjs';
import { loadConfig } from '../server/config.mjs';
import { BOARDS_LISTED_MAX, RestoreError } from '../server/restore.mjs';
import { HOUR, MIN, T0, docBytes, harness, type Harness } from './backup-harness';
import { audits, backupNow, becomeB, forge, ownerOf, rig, seedA, sqliteBytes } from './restore-harness';

// docs/backups.md, "In the app": the boards inside one backup (GET /api/admin/backups/:name/boards, for the board
// picker) and the engine's status in the list (GET /api/admin/backups).

let h: Harness;
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
  await h?.close();
});

const names = (dir: string) => fs.readdirSync(dir).sort();

/** The directory of the workspace at the time of the backup, with one deleted board and one that was never saved. */
async function scenario() {
  h = await harness({ accounts: true });
  const world = seedA(h);
  h.directory!.deleteBoard('b2');
  h.directory!.createBoard({ id: 'unsaved', title: 'Never saved', ownerId: world.owner.id, teamId: null });
  const r = rig(h);
  const a = await backupNow(r.backup);
  h.clock.now += HOUR;
  becomeB(h);
  h.clock.now += MIN;
  return { ...r, ...world, manifest: a.manifest as string, actor: ownerOf(h) };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;

const list = (s: Scenario, manifest = s.manifest, actor = s.actor) => s.restore.listBoardsInBackup(manifest, actor);
const failure = async (promise: Promise<unknown>) => {
  const err = await promise.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(RestoreError);
  return err as RestoreError;
};

const SCHEMA = 'PRAGMA user_version = 1; CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL); CREATE TABLE boards (id TEXT PRIMARY KEY, title TEXT NOT NULL, team_id TEXT, updated_at INTEGER NOT NULL, deleted_at INTEGER)';

/** A backup whose database holds the given boards (title, team, updated, deleted) and whose rooms are the given ids. */
async function forgedBoards(rows: { id: string; title: string; team?: string | null; at?: number; deleted?: boolean }[], teams: [string, string][] = [], rooms: string[] = rows.map((r) => r.id), at = T0 + 20 * HOUR) {
  const database = await sqliteBytes((db) => {
    db.exec(SCHEMA);
    const team = db.prepare('INSERT INTO teams (id, name) VALUES (?, ?)');
    for (const [id, name] of teams) team.run(id, name);
    const board = db.prepare('INSERT INTO boards (id, title, team_id, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?)');
    for (const [i, row] of rows.entries()) board.run(row.id, row.title, row.team ?? null, row.at ?? i, row.deleted ? 5 : null);
  });
  return forge(h, [{ path: 'directory.sqlite', data: database }, ...rooms.map((id) => ({ path: `${id}.yjs`, data: docBytes(id) }))], { at });
}

describe('the boards of one backup', () => {
  it('lists the boards that have saved content, with their team and whether they were deleted', async () => {
    const s = await scenario();
    const result = await list(s);
    expect(result.truncated).toBe(false);
    // b3 exists only in the live workspace, 'unsaved' has no room file in the backup
    expect(result.boards.map((b: { id: string }) => b.id).sort()).toEqual(['b1', 'b2']);
    const byId = Object.fromEntries(result.boards.map((b: { id: string }) => [b.id, b]));
    expect(byId.b1).toEqual({ id: 'b1', title: 'Roadmap', teamId: s.team.id, teamName: 'Design', deleted: false });
    expect(byId.b2).toEqual({ id: 'b2', title: 'Retro', teamId: null, teamName: null, deleted: true });
    for (const board of result.boards) expect(Object.keys(board).sort()).toEqual(['deleted', 'id', 'teamId', 'teamName', 'title']);
  });

  it('lists the most recently edited first', async () => {
    const s = await scenario();
    const forged = await forgedBoards([
      { id: 'old', title: 'Old', at: 10 },
      { id: 'new', title: 'New', at: 30 },
      { id: 'mid', title: 'Mid', at: 20 },
    ]);
    expect((await list(s, forged.name)).boards.map((b: { id: string }) => b.id)).toEqual(['new', 'mid', 'old']);
  });

  it('leaves nothing in the data directory, and does not count as a restore', async () => {
    const s = await scenario();
    const before = names(h.dir);
    await list(s);
    expect(names(h.dir)).toEqual(before);
    expect(s.restore.status()).toMatchObject({ inProgress: null, maintenance: false, last: null });
    expect(audits(h.directory!, 50).filter((r) => r.action.startsWith('restore.'))).toEqual([]);
    expect(s.exits).toEqual([]);
  });

  it('reads only the database of the backup: no room file is downloaded', async () => {
    const s = await scenario();
    const manifest = await s.backup.readManifest(s.manifest);
    const wanted = manifest.files.find((f: { path: string }) => f.path === 'directory.sqlite')!.objectId;
    const asked: string[] = [];
    const backup = { ...s.backup, readObject: async (id: string) => (asked.push(id), s.backup.readObject(id)) };
    const r = rig(h, { backup });
    await r.restore.listBoardsInBackup(s.manifest, s.actor);
    expect(asked).toEqual([wanted]);
  });

  it('cleans up after itself when the database in the backup is damaged', async () => {
    const s = await scenario();
    const before = names(h.dir);
    const damaged = await sqliteBytes((db) => db.exec('PRAGMA user_version = 1; CREATE TABLE unrelated (a)'));
    const missingTable = forge(h, [{ path: 'directory.sqlite', data: damaged }, { path: 'b1.yjs', data: docBytes('x') }], { at: T0 + 21 * HOUR });
    expect((await failure(list(s, missingTable.name))).code).toBe('integrity_check_failed');
    const notSqlite = forge(h, [{ path: 'directory.sqlite', data: Buffer.from('plain text') }, { path: 'b1.yjs', data: docBytes('x') }], { at: T0 + 22 * HOUR });
    expect((await failure(list(s, notSqlite.name))).code).toBe('integrity_check_failed');
    const newer = await sqliteBytes((db) => db.exec('PRAGMA user_version = 9999'));
    const tooNew = forge(h, [{ path: 'directory.sqlite', data: newer }], { at: T0 + 23 * HOUR });
    expect((await failure(list(s, tooNew.name))).code).toBe('schema_too_new');
    const blank = await sqliteBytes((db) => db.exec('CREATE TABLE x (a)'));
    const notTabula = forge(h, [{ path: 'directory.sqlite', data: blank }], { at: T0 + 24 * HOUR });
    expect((await failure(list(s, notTabula.name))).code).toBe('invalid_backup');
    expect(names(h.dir)).toEqual(before);
  });

  it('removes the temporary copy when something fails after it was written', async () => {
    const s = await scenario();
    const before = names(h.dir);
    const real = fs.writeFileSync;
    const during: string[][] = [];
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(((...args: Parameters<typeof fs.writeFileSync>) => {
      real(...args);
      during.push(names(h.dir));
      throw Object.assign(new Error(`disk full at ${h.dir}`), { code: 'ENOSPC' });
    }) as typeof fs.writeFileSync);
    try {
      const err = await failure(list(s));
      expect(err.code).toBe('restore_failed');
      expect(err.message).not.toContain(h.dir);
      expect(err.message).not.toContain('ENOSPC');
    } finally {
      spy.mockRestore();
    }
    expect(during).toHaveLength(1);
    expect(during[0].filter((n) => /^\.restore-[0-9a-f]{16}$/.test(n))).toHaveLength(1);
    expect(names(h.dir)).toEqual(before);
    expect((await list(s)).boards).toHaveLength(2);
  });

  it('refuses a database that was tampered with, a wrong size, a path it should not hold and a key it does not have', async () => {
    const s = await scenario();
    const before = names(h.dir);
    const database = await sqliteBytes((db) => db.exec(SCHEMA));
    const flipped = forge(h, [{ path: 'directory.sqlite', data: database }], { at: T0 + 26 * HOUR });
    h.fake.objects.get(`tabula/objects/${flipped.entries[0].objectId}`)!.body[30] ^= 1;
    const tamper = await failure(list(s, flipped.name));
    expect(tamper.code).toBe('tamper');
    expect(tamper.message).not.toContain(flipped.entries[0].objectId);
    const sized = forge(h, [{ path: 'directory.sqlite', data: database }], {
      at: T0 + 27 * HOUR,
      damage: (body) => {
        body.files[0].size += 3;
        body.totals.bytes += 3;
      },
    });
    expect((await failure(list(s, sized.name))).code).toBe('size_mismatch');
    const stray = forge(h, [{ path: 'directory.sqlite', data: database }, { path: 'notes.txt', data: Buffer.from('x') }], { at: T0 + 28 * HOUR });
    expect((await failure(list(s, stray.name))).code).toBe('unexpected_file');
    const twice = forge(h, [{ path: 'directory.sqlite', data: database }, { path: 'b1.yjs', data: docBytes('a') }, { path: 'B1.yjs', data: docBytes('b') }], { at: T0 + 29 * HOUR });
    expect((await failure(list(s, twice.name))).code).toBe('duplicate_path');
    const none = forge(h, [{ path: 'b1.yjs', data: docBytes('a') }], { at: T0 + 30 * HOUR });
    expect((await failure(list(s, none.name))).code).toBe('no_directory');
    const other = forge(h, [{ path: 'directory.sqlite', data: database }], { at: T0 + 31 * HOUR, key: Buffer.alloc(32, 3) });
    expect((await failure(list(s, other.name))).code).toBe('unknown_key');
    h.fake.objects.delete(`tabula/objects/${flipped.entries[0].objectId}`);
    expect((await failure(list(s, flipped.name))).code).toBe('backup_incomplete');
    expect(names(h.dir)).toEqual(before);
  });

  it('refuses a name that is not a backup, and a backup that is not there', async () => {
    const s = await scenario();
    for (const name of ['', '../manifest', 'b1', 'restore', 3 as never, null as never]) {
      expect((await failure(list(s, name))).code, `${String(name)}`).toBe('bad_request');
    }
    expect((await failure(list(s, '20200101T000000Z.json.enc'))).code).toBe('manifest_not_found');
    expect((await failure(list(s, s.manifest, { id: undefined } as never))).code).toBe('forbidden');
    expect((await failure(list(s, s.manifest, null as never))).code).toBe('forbidden');
  });

  it('needs room for the database, like any restore object', async () => {
    const s = await scenario();
    const tight = rig(h, { statfs: async () => ({ bsize: 4096, blocks: 1000, bavail: 100 }) });
    const err = await failure(tight.restore.listBoardsInBackup(s.manifest, s.actor));
    expect(err).toMatchObject({ code: 'not_enough_space', extra: { free: 409600 } });
    expect(err.extra.needed).toBeGreaterThan(64 * 1024 * 1024);
  });

  // The cap is 500; the check uses a cap of 5, because forging two backups with over a thousand room files took more
  // than a minute on a Windows runner (CI on f3a6ee5) for the same code path.
  it('holds the real cap at 500', () => {
    expect(BOARDS_LISTED_MAX).toBe(500);
  });

  it('cuts the list at the cap and says so, keeping the most recently edited', async () => {
    const s = await scenario();
    const capped = rig(h, { boardsListedMax: 5 });
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `board${i}`, title: `Board ${i}`, at: i }));
    const exact = await forgedBoards(many(5), [], undefined, T0 + 40 * HOUR);
    const full = await capped.restore.listBoardsInBackup(exact.name, s.actor);
    expect(full.boards).toHaveLength(5);
    expect(full.truncated).toBe(false);
    const over = await forgedBoards(many(8), [], undefined, T0 + 41 * HOUR);
    const cut = await capped.restore.listBoardsInBackup(over.name, s.actor);
    expect(cut.boards).toHaveLength(5);
    expect(cut.truncated).toBe(true);
    // the newest are kept
    expect(cut.boards[0].id).toBe('board7');
    expect(cut.boards.at(-1).id).toBe('board3');
  });

  it('cleans titles and team names, and lists no board that cannot be restored', async () => {
    const s = await scenario();
    const forged = await forgedBoards(
      [
        { id: 'messy', title: '  Line one\nline\ttwo\u0001 \u2028 end  ', team: 't1', at: 9 },
        { id: 'blank', title: ' \n ', at: 8 },
        { id: 'long', title: 'x'.repeat(500), at: 7 },
        { id: 'emoji', title: `${'a'.repeat(199)}\u{1F600}`, at: 6 },
        { id: 'html', title: '<img src=x onerror=alert(1)>', team: 'gone', at: 5 },
        { id: 'weird id!', title: 'No room for this id', at: 4 },
        { id: 'norooms', title: 'Never saved', at: 3 },
      ],
      [['t1', `Team\u0007 one ${'y'.repeat(200)}`]],
      ['messy', 'blank', 'long', 'emoji', 'html'],
    );
    const result = await list(s, forged.name);
    const byId = Object.fromEntries(result.boards.map((b: { id: string }) => [b.id, b]));
    expect(Object.keys(byId).sort()).toEqual(['blank', 'emoji', 'html', 'long', 'messy']);
    expect(byId.messy.title).toBe('Line one line two end');
    expect(byId.blank.title).toBe('Untitled board');
    expect(byId.long.title).toHaveLength(200);
    expect(byId.emoji.title).toBe('a'.repeat(199));
    expect(byId.html.title).toBe('<img src=x onerror=alert(1)>');
    expect(byId.html).toMatchObject({ teamId: 'gone', teamName: null });
    expect(byId.messy.teamName).toMatch(/^Team one y+$/);
    expect(byId.messy.teamName.length).toBeLessThanOrEqual(80);
    for (const board of result.boards) expect(`${board.title}${board.teamName}`).not.toMatch(/\p{Cc}|[\u2028\u2029]/u);
  });

  it('shows no path, key, object id or secret', async () => {
    const s = await scenario();
    const manifest = await s.backup.readManifest(s.manifest);
    const json = JSON.stringify(await list(s));
    expect(json).not.toContain(h.dir);
    expect(json).not.toMatch(/AKIA|canary|secret|tabula\/objects|restore-|\.sqlite/i);
    for (const file of manifest.files as { objectId: string }[]) expect(json).not.toContain(file.objectId);
  });

  it('allows 20 reads a minute per person, then says when to try again', async () => {
    const s = await scenario();
    for (let i = 0; i < 20; i++) await list(s);
    const err = await failure(list(s));
    expect(err.code).toBe('rate_limited');
    expect(err.extra.retryAfter).toBe(60);
    // another owner is not held back by this one
    const other = h.directory!.createUser({ email: 'second-owner@example.com', name: 'Second', role: 'owner' })!;
    expect((await list(s, s.manifest, other)).boards).toHaveLength(2);
    h.clock.now += 30_000;
    expect((await failure(list(s))).extra.retryAfter).toBe(30);
    h.clock.now += 30_001;
    expect((await list(s)).boards).toHaveLength(2);
    // a refusal for a bad name does not use up the allowance of a good one
    expect(await failure(list(s, 'nope'))).toMatchObject({ code: 'bad_request' });
  });

  it('is not allowed while a restore is running', async () => {
    let open!: (v: { ok: boolean }) => void;
    let enterRun!: () => void;
    const held = new Promise<{ ok: boolean }>((resolve) => (open = resolve));
    const entered = new Promise<void>((resolve) => (enterRun = resolve));
    const s = await scenario();
    const r = rig(h, { backup: { ...h.engine(), runNow: () => { enterRun(); return held; } } });
    const whole = r.restore.restoreWorkspace({ manifest: s.manifest, confirm: 'RESTORE', actor: s.actor });
    await entered;
    expect((await failure(r.restore.listBoardsInBackup(s.manifest, s.actor))).code).toBe('restore_in_progress');
    open({ ok: false });
    await failure(whole);
    expect((await r.restore.listBoardsInBackup(s.manifest, s.actor)).boards).toHaveLength(2);
  });
});

// ------------------------------------------------------------------ over HTTP

type Options = { backups?: boolean; restoring?: () => boolean; status?: (s: Scenario) => Record<string, unknown> };

async function served({ backups = true, restoring = () => false, status }: Options = {}) {
  const s = await scenario();
  const d = h.directory!;
  d.createUser({ email: 'admin@example.com', name: 'Admin', role: 'admin' });
  d.createUser({ email: 'guest@example.com', name: 'Guest', role: 'guest' });
  const config = loadConfig({ PORT: '8787', TABULA_AUTH: 'on', TABULA_OWNER_EMAIL: 'owner@example.com', DATA_DIR: h.dir });
  const mailer = { async send() {} };
  const auth = createAuth({ directory: d, config, mailer });
  const api = createApi({
    directory: d, auth, config, roomExists: () => false, events: new EventEmitter(), mailer, restore: backups ? (s.restore as never) : null, maintenance: restoring,
    // as the relay builds it: the engine's status with the restore in it
    backupStatus: () => (status ? status(s) : { ...s.backup.status(), restore: s.restore.status() }) as never,
  });
  const server = http.createServer((req, res) => {
    void api.handle(req, res).then((handled: boolean) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookieOf = (email: string) => `${config.cookieName}=${d.createSession(d.getUserByEmail(email)!.id, { ttlMs: 30 * 86_400_000 }).token}`;
  const cookies = { owner: cookieOf('owner@example.com'), admin: cookieOf('admin@example.com'), member: cookieOf('member@example.com'), guest: cookieOf('guest@example.com') };
  async function call(urlPath: string, cookie: string | null = cookies.owner) {
    const res = await fetch(base + urlPath, { headers: cookie ? { cookie } : {} });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
  }
  return { ...s, call, cookies, config };
}

describe('GET /api/admin/backups/:name/boards', () => {
  it('is for the owner alone', async () => {
    const s = await served();
    const url = `/api/admin/backups/${s.manifest}/boards`;
    expect(await s.call(url, null)).toMatchObject({ status: 401, body: { error: 'unauthenticated' } });
    expect((await s.call(url, `${s.config.cookieName}=garbage`)).status).toBe(401);
    for (const who of ['admin', 'member', 'guest'] as const) {
      expect(await s.call(url, s.cookies[who]), `${who}`).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    }
    expect(audits(h.directory!, 50).filter((r) => r.action === 'backup.boards')).toEqual([]);
    expect(names(h.dir).filter((n) => n.startsWith('.restore-'))).toEqual([]);
  });

  it('answers backups_off to the owner when backups are not set up, and still 403 to others', async () => {
    const s = await served({ backups: false });
    const url = `/api/admin/backups/${s.manifest}/boards`;
    expect(await s.call(url)).toMatchObject({ status: 409, body: { error: 'backups_off' } });
    expect((await s.call(url, s.cookies.admin)).status).toBe(403);
  });

  it('lists the boards, uncached, and writes one audit row with a count and no title or id', async () => {
    const s = await served();
    const res = await s.call(`/api/admin/backups/${s.manifest}/boards`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body.truncated).toBe(false);
    expect(res.body.boards.map((b: { id: string }) => b.id).sort()).toEqual(['b1', 'b2']);
    const rows = audits(h.directory!, 100).filter((r) => r.action === 'backup.boards');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: s.owner.id, detail: { manifest: s.manifest, count: 2 } });
    expect(Object.keys(rows[0].detail).sort()).toEqual(['count', 'manifest']);
    const everything = JSON.stringify(audits(h.directory!, 200));
    for (const secret of ['Roadmap', 'Retro', 'Design', 'Never saved', '"b1"', '"b2"']) expect(everything, `${secret}`).not.toContain(secret);
  });

  it('maps the refusals', async () => {
    const s = await served();
    expect(await s.call('/api/admin/backups/20200101T000000Z.json.enc/boards')).toMatchObject({ status: 404, body: { error: 'manifest_not_found' } });
    expect(await s.call('/api/admin/backups/not-a-manifest/boards')).toMatchObject({ status: 400, body: { error: 'bad_request' } });
    expect((await s.call('/api/admin/backups/%2e%2e%2fmanifest/boards')).status).toBe(400);
    expect(audits(h.directory!, 100).filter((r) => r.action === 'backup.boards')).toEqual([]);
  });

  it('answers 429 with Retry-After after 20 reads in a minute', async () => {
    const s = await served();
    for (let i = 0; i < 20; i++) expect((await s.call(`/api/admin/backups/${s.manifest}/boards`)).status).toBe(200);
    const res = await s.call(`/api/admin/backups/${s.manifest}/boards`);
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: 'rate_limited' });
    expect(res.body).not.toHaveProperty('retryAfter');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('answers 503 restoring in maintenance mode', async () => {
    const s = await served({ restoring: () => true });
    const res = await s.call(`/api/admin/backups/${s.manifest}/boards`);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'restoring' });
  });

  it('gives a 422 with a plain reason for a damaged backup, and nothing is left behind', async () => {
    const s = await served();
    const before = names(h.dir);
    const notSqlite = forge(h, [{ path: 'directory.sqlite', data: Buffer.from('plain text') }], { at: T0 + 50 * HOUR });
    const res = await s.call(`/api/admin/backups/${notSqlite.name}/boards`);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: 'integrity_check_failed' });
    expect(JSON.stringify(res.body)).not.toContain(h.dir);
    expect(names(h.dir)).toEqual(before);
  });
});

describe('the engine status in GET /api/admin/backups', () => {
  const FIELDS = [
    'bytesStored', 'consecutiveFailures', 'deepCovered', 'deepDamaged', 'deepVerifiedAt', 'dirty', 'intervalMinutes', 'keyId', 'lastFailureAt', 'lastFailureError', 'lastSuccessAt', 'lastTrigger',
    'manifests', 'missingObjects', 'nextRunAt', 'objects', 'running', 'unrepairableObjects', 'verifiedAt', 'wrongSizeObjects',
  ];

  it('holds the sanitised fields of the backup status and nothing else', async () => {
    const s = await served();
    const { status, body } = await s.call('/api/admin/backups');
    expect(status).toBe(200);
    const shown = body.status;
    expect(Object.keys(shown).sort()).toEqual(FIELDS);
    expect(shown).toMatchObject({
      running: false, intervalMinutes: 60, keyId: s.backup.keyId, consecutiveFailures: 0, lastFailureAt: null, lastFailureError: null, nextRunAt: null, manifests: 1, dirty: false, lastTrigger: 'manual',
    });
    expect(shown.lastSuccessAt).toBe(T0);
    expect(shown.bytesStored).toBeGreaterThan(0);
    expect(shown.objects).toBeGreaterThan(0);
    expect(shown).toMatchObject({ verifiedAt: T0, missingObjects: 0, wrongSizeObjects: 0, unrepairableObjects: 0, deepVerifiedAt: null, deepDamaged: 0, deepCovered: 0 });
    for (const hidden of ['enabled', 'lastRunAt', 'lastError', 'lastManifest', 'prune', 'restore', 'deepChecked', 'deepSkipped', 'verifyChecked', 'deepCursor', 'deepSince', 'deepCycleOk']) expect(shown).not.toHaveProperty(hidden);
    expect(body.restore).toMatchObject({ inProgress: null });
    expect(JSON.stringify(shown)).not.toMatch(/AKIA|canary|secret/i);
  });

  it('is for the owner alone', async () => {
    const s = await served();
    expect((await s.call('/api/admin/backups', s.cookies.admin)).body).not.toHaveProperty('status');
    expect((await s.call('/api/admin/backups', null)).status).toBe(401);
  });

  it('shows a failed run in words that carry no credential', async () => {
    const s = await served();
    h.fake.rules.push({ method: 'PUT', status: 403, times: 999 });
    h.clock.now += HOUR;
    await s.backup.runNow();
    h.fake.rules.length = 0;
    const { body } = await s.call('/api/admin/backups');
    expect(body.status).toMatchObject({ consecutiveFailures: 1, lastFailureError: 'S3 PUT failed (status 403, AccessDenied)', lastSuccessAt: T0 });
    expect(body.status.lastFailureAt).toBe(T0 + 2 * HOUR + MIN);
    expect(JSON.stringify(body.status)).not.toMatch(/AKIA|canary|Signature/);
  });

  it('keeps every field present, as null, when the engine has reported nothing', async () => {
    const s = await served({ status: () => ({ enabled: true, lastError: 'x', prune: { at: 1 } }) });
    const { body } = await s.call('/api/admin/backups');
    expect(Object.keys(body.status).sort()).toEqual(FIELDS);
    for (const field of FIELDS) expect(body.status[field], `${field}`).toBeNull();
  });
});
