import { afterAll, afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';
import { SimulatedCrash } from '../server/restore.mjs';
import { CREDS, HOUR, KEY, MIN, harness, type Harness } from './backup-harness';
import { backedUp, backupNow, becomeB, CONFIRM, filesOf, ownerOf, raw, rig, seedA } from './restore-harness';
import { createRelayKit, sleep, until } from './drill/drill-kit';

// docs/backups.md, Restoring. The relay as a child process, exactly as `npm start` runs it, next to the fake S3: a whole
// restore over HTTP, the maintenance window, the exit code, the start that follows, and recovery from a swap that was cut off.

const CLOUD_TOKEN = 'q'.repeat(48);
let h: Harness | undefined;
// launch (server/relay.mjs as a child, started within RELAY_START_MS) and client live in test/drill/drill-kit.ts
const kit = createRelayKit(CLOUD_TOKEN);
const { launch, client } = kit;

afterEach(async () => {
  kit.closeClients();
  await kit.killAll();
  await h?.close();
  h = undefined;
});
afterAll(() => kit.killAll());

const backupEnv = (url: string) => ({
  TABULA_BACKUP_S3_ENDPOINT: url, TABULA_BACKUP_BUCKET: CREDS.bucket, TABULA_BACKUP_ACCESS_KEY: CREDS.accessKey,
  TABULA_BACKUP_SECRET_KEY: CREDS.secretKey, TABULA_BACKUP_KEY: KEY.toString('base64'),
  TABULA_CLOUD_TOKEN: CLOUD_TOKEN, TABULA_CLOUD_URL: 'http://127.0.0.1:1', TABULA_CLOUD_WORKSPACE_ID: 'ws_restore',
});

/** State A is backed up and state B is on disk, with nothing running. The data directory is the relay's. */
async function prepare() {
  h = await harness({ accounts: true });
  seedA(h);
  const r = rig(h);
  const a = await backupNow(h.engine());
  const stateA = await backedUp(h, r.backup, a.manifest as string);
  h.clock.now += HOUR;
  becomeB(h);
  const stateB = filesOf(h.dir);
  const actor = ownerOf(h);
  h.directory!.close();
  return { ...r, manifest: a.manifest as string, stateA, stateB, dir: h.dir, actor };
}

describe('the relay restoring a workspace', () => {
  it('aborts before maintenance when a final room save fails, keeping later edits available for retry', async () => {
    const s = await prepare();
    const relay = await launch(s.dir, { ...backupEnv(h!.fake.url), SAVE_DEBOUNCE_MS: '30000', SAVE_RETRY_MS: '200' });
    const c = client(relay, s.dir);
    const cookie = await c.signIn('owner@example.com');
    const editor = c.connect('b1', cookie);
    const watcher = c.connect('b1', cookie);
    await until(() => editor.provider.synced && watcher.provider.synced);
    const blocker = path.join(s.dir, 'b1.yjs.tmp');
    fs.rmSync(blocker, { force: true });
    fs.mkdirSync(blocker);
    // The safety backup precedes staging. One retried download leaves time for an edit that only the final save can keep.
    let staging = false;
    h!.fake.rules.push({ method: 'GET', times: 1, status: 503, key: {
      test(key: string) {
        if (!key.includes('/objects/') || !relay.out().includes('the live data is backed up')) return false;
        staging = true;
        return true;
      },
    } as RegExp });
    const restoring = c.api(cookie, 'POST', '/api/admin/backups/restore', { manifest: s.manifest, confirm: CONFIRM });
    // The safety backup (which now takes the snapshot barrier) comes first; 8 s was too short on a loaded CI runner. A real hang still fails, with the relay's output.
    await until(() => staging, 45_000).catch((err) => {
      throw new Error(`${err.message}: the restore never reached staging. Relay output: ${relay.out().slice(-1500)}`);
    });
    editor.doc.getMap('objects').set('last-edit', 'after the safety backup');
    await until(() => watcher.doc.getMap('objects').get('last-edit') === 'after the safety backup');
    const res = await restoring;
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'restore_failed' });
    expect(relay.proc.exitCode).toBeNull();
    expect((await c.api(cookie, 'GET', '/api/me')).status).toBe(200);
    expect(editor.closes).toEqual([]);
    expect(fs.readdirSync(s.dir).some((f) => f.startsWith('.pre-restore-'))).toBe(false);
    fs.rmdirSync(blocker);
    await until(() => {
      const saved = new Y.Doc();
      try {
        Y.applyUpdate(saved, fs.readFileSync(path.join(s.dir, 'b1.yjs')));
        return saved.getMap('objects').get('last-edit') === 'after the safety backup';
      } finally {
        saved.destroy();
      }
    }, 30_000); // the failed save is retried every SAVE_RETRY_MS (5 s by default), so the unblocked save can take that long
    expect((await raw<{ value: string }>(s.dir, "SELECT value FROM settings WHERE key = 'fixture'"))[0].value).toBe('B');
  }, 60_000);

  it('shuts everything down for the swap, leaves with 75, and starts again on the restored data', async () => {
    const s = await prepare();
    // the disk is given, never read: how long the old data is kept must not depend on the machine the test runs on
    const first = await launch(s.dir, { ...backupEnv(h!.fake.url), TABULA_TEST_RESTORE_EXIT_DELAY_MS: '2500', ROOM_UNLOAD_MS: '300', TABULA_TEST_RESTORE_DISK_USED: '0.4' });
    expect(first.out()).toContain('(backups on)');
    const c = client(first, s.dir);
    const cookie = await c.signIn('owner@example.com');

    // someone is editing a board: the room has changes that are not on disk yet
    const editor = c.connect('b1', cookie);
    const observer = c.connect('b1', cookie);
    await until(() => editor.provider.wsconnected && editor.provider.synced);
    await until(() => observer.provider.wsconnected && observer.provider.synced);
    editor.doc.getMap('objects').set('live-edit', 'typed while the restore starts');
    await until(() => observer.doc.getMap('objects').get('live-edit') === 'typed while the restore starts');
    const watcher = c.connect('b2', cookie);
    await until(() => watcher.provider.wsconnected && watcher.provider.synced);

    const list = await c.api(cookie, 'GET', '/api/admin/backups');
    expect(list.status).toBe(200);
    expect(list.body.backups.map((b: { name: string }) => b.name)).toContain(s.manifest);

    const res = await c.api(cookie, 'POST', '/api/admin/backups/restore', { manifest: s.manifest, confirm: CONFIRM });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true, restarting: true, keepOldFor: '7 days' });

    // the window between the response and the exit: maintenance mode
    await until(() => editor.closes.length > 0 && observer.closes.length > 0 && watcher.closes.length > 0);
    expect(editor.closes).toContain(4503);
    expect(observer.closes).toContain(4503);
    expect(watcher.closes).toContain(4503);
    const late = c.listen('b1', cookie);
    await until(() => late.length > 0);
    expect(late).toEqual([4503]);
    for (const [method, url] of [['GET', '/api/boards'], ['GET', '/api/me'], ['GET', '/api/admin/backups']] as const) {
      const denied = await c.api(cookie, method, url);
      expect(denied.status, `${url}`).toBe(503);
      expect(denied.body).toMatchObject({ error: 'restoring' });
    }
    expect((await fetch(`${first.base}/mcp`, { method: 'POST' })).status).toBe(503);
    const health = await (await fetch(`${first.base}/api/health`)).json();
    expect(health).toMatchObject({ ok: true, restoring: true });
    const status = await c.internal('/api/internal/backup-status');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ enabled: true, restore: { maintenance: true, inProgress: 'workspace' } });

    // the rooms' unload timers (300 ms here) fire in the window and would save the old documents into the restored data
    expect(await first.exited).toBe(75);
    const now = filesOf(s.dir);
    expect([...now.keys()].sort()).toEqual([...s.stateA.keys()].sort());
    for (const [file, bytes] of s.stateA) expect(now.get(file)!.equals(bytes), `${file}`).toBe(true);
    expect((await raw<{ value: string }>(s.dir, "SELECT value FROM settings WHERE key = 'fixture'"))[0].value).toBe('A');

    // the old data has what was typed a moment before: the rooms were saved first
    const [oldName] = fs.readdirSync(s.dir).filter((n) => n.startsWith('.pre-restore-'));
    const old = new Y.Doc();
    Y.applyUpdate(old, fs.readFileSync(path.join(s.dir, oldName, 'b1.yjs')));
    expect(old.getMap('objects').get('live-edit')).toBe('typed while the restore starts');
    expect(old.getMap('objects').get('note')).toBe('B: board one');

    // the start that follows: recovery completes quietly, nobody is signed in, the status says what happened
    const second = await launch(s.dir, backupEnv(h!.fake.url));
    expect(second.out()).toContain('completed a restore');
    expect(fs.existsSync(path.join(s.dir, 'restore.json'))).toBe(false);
    const c2 = client(second, s.dir);
    expect((await c2.api(cookie, 'GET', '/api/me')).status).toBe(401);
    expect((await c2.api(cookie, 'GET', '/api/admin/backups')).status).toBe(401);
    const again = await c2.signIn('owner@example.com');
    const boards = await c2.api(again, 'GET', '/api/boards');
    expect(boards.body.map((b: { id: string }) => b.id).sort()).toEqual(['b1', 'b2']);
    const after = await c2.internal('/api/internal/backup-status');
    expect(after.body).toMatchObject({ enabled: true, restore: { maintenance: false, inProgress: null, last: { kind: 'workspace', result: 'done', manifest: s.manifest } } });
    const list2 = await c2.api(again, 'GET', '/api/admin/backups');
    expect(list2.body.restore.oldData).toHaveLength(1);
    expect(list2.body.restore.protectedBackups.length).toBe(2);
    for (const secret of [CREDS.secretKey, CREDS.accessKey, KEY.toString('hex'), KEY.toString('base64')]) {
      expect(first.out() + first.err() + second.out() + second.err()).not.toContain(secret);
      expect(JSON.stringify([after.body, list2.body])).not.toContain(secret);
    }
  }, 60_000);

  it('keeps the old data only until the next backup when the disk it is given is nearly full, and for 7 days when it is not', async () => {
    const s = await prepare();
    const full = await launch(s.dir, { ...backupEnv(h!.fake.url), TABULA_TEST_RESTORE_DISK_USED: '0.95' });
    const c = client(full, s.dir);
    const cookie = await c.signIn('owner@example.com');
    const preview = await c.api(cookie, 'GET', `/api/admin/backups/${s.manifest}`);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ keepOldFor: 'until the next successful backup (at least 24 h)', space: { enough: true } });
    expect(preview.body.reason).toContain('95%');
    const res = await c.api(cookie, 'POST', '/api/admin/backups/restore', { manifest: s.manifest, confirm: CONFIRM });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true, restarting: true, keepOldFor: 'until the next successful backup (at least 24 h)' });
    expect(await full.exited).toBe(75);

    const roomy = await launch(s.dir, { ...backupEnv(h!.fake.url), TABULA_TEST_RESTORE_DISK_USED: '0.2' });
    const c2 = client(roomy, s.dir);
    const cookie2 = await c2.signIn('owner@example.com');
    const list = await c2.api(cookie2, 'GET', '/api/admin/backups');
    expect(list.status).toBe(200);
    const again = await c2.api(cookie2, 'GET', `/api/admin/backups/${s.manifest}`);
    expect(again.body).toMatchObject({ keepOldFor: '7 days' });
    expect(again.body.reason).toContain('7 days');
  });

  it('does not accept a restore that is not confirmed, and the server keeps running', async () => {
    const s = await prepare();
    const relay = await launch(s.dir, backupEnv(h!.fake.url));
    const c = client(relay, s.dir);
    const cookie = await c.signIn('owner@example.com');
    const res = await c.api(cookie, 'POST', '/api/admin/backups/restore', { manifest: s.manifest, confirm: 'no' });
    expect(res.status).toBe(400);
    expect((await c.api(cookie, 'GET', '/api/me')).status).toBe(200);
    await sleep(200);
    expect(relay.proc.exitCode).toBeNull();
  }, 30_000);
});

describe('the relay after a swap that was cut off', () => {
  async function crashedAt(point: string) {
    const s = await prepare();
    h!.directory!.close();
    const { openDirectory } = await import('../server/directory.mjs');
    const directory = openDirectory(path.join(s.dir, 'directory.sqlite'));
    const { createRestore } = await import('../server/restore.mjs');
    const engine = createRestore({
      backup: h!.engine({ directory }), directory, config: h!.config(), dataDir: s.dir, now: () => h!.clock.now, sleep: async () => {}, log: () => {}, exit: () => {},
      statfs: async () => ({ bsize: 4096, blocks: 1_000_000, bavail: 900_000 }),
      crashAt: (p: string) => {
        if (p === point) throw new SimulatedCrash(p);
      },
    })!;
    h!.clock.now += MIN;
    await expect(engine.restoreWorkspace({ manifest: s.manifest, confirm: CONFIRM, actor: s.actor })).rejects.toBeInstanceOf(SimulatedCrash);
    directory.close();
    return s;
  }

  it('undoes a swap that was cut off before the new files were all in place, and says so', async () => {
    const s = await crashedAt('moved-new-2');
    expect(fs.existsSync(path.join(s.dir, 'restore.json'))).toBe(true);
    const relay = await launch(s.dir, backupEnv(h!.fake.url));
    expect(relay.out()).toContain('was undone');
    expect(fs.existsSync(path.join(s.dir, 'restore.json'))).toBe(false);
    expect(fs.readdirSync(s.dir).filter((n) => n.startsWith('.pre-restore-') || n.startsWith('.restore-'))).toEqual([]);
    const now = filesOf(s.dir);
    for (const [file, bytes] of s.stateB) expect(now.get(file)!.equals(bytes), `${file}`).toBe(true);
    const c = client(relay, s.dir);
    const cookie = await c.signIn('owner@example.com');
    expect((await c.api(cookie, 'GET', '/api/boards')).body.map((b: { id: string }) => b.id).sort()).toEqual(['b1', 'b2', 'b3']);
    const status = await c.internal('/api/internal/backup-status');
    expect(status.body.restore.last).toMatchObject({ kind: 'workspace', result: 'failed', error: 'interrupted', manifest: s.manifest });
    expect((await c.api(cookie, 'GET', '/api/admin/audit?action=restore.')).body.entries.map((e: { action: string }) => e.action)).toContain('restore.failed');
  }, 30_000);

  it('finishes a swap that was cut off after the last file moved into place', async () => {
    const s = await crashedAt('journal-moved-new');
    const relay = await launch(s.dir, backupEnv(h!.fake.url));
    expect(relay.out()).toContain('finished a restore');
    const now = filesOf(s.dir);
    expect([...now.keys()].sort()).toEqual([...s.stateA.keys()].sort());
    const c = client(relay, s.dir);
    const cookie = await c.signIn('owner@example.com');
    expect((await c.api(cookie, 'GET', '/api/boards')).body.map((b: { id: string }) => b.id).sort()).toEqual(['b1', 'b2']);
    expect((await c.internal('/api/internal/backup-status')).body.restore.last).toMatchObject({ result: 'done' });
  }, 30_000);

  it('refuses to start on a journal it cannot read, and touches nothing', async () => {
    const s = await prepare();
    fs.writeFileSync(path.join(s.dir, 'restore.json'), '{ this is not a journal');
    const before = fs.readdirSync(s.dir).sort();
    const relay = await launch(s.dir, backupEnv(h!.fake.url), { waitForStart: false });
    expect(await relay.exited).toBe(1);
    expect(relay.err()).toContain('restore journal');
    expect(relay.err()).toContain('will not start');
    expect(relay.out()).not.toContain('Tabula relay');
    expect(fs.readdirSync(s.dir).sort()).toEqual(before);
    for (const secret of [CREDS.secretKey, KEY.toString('hex')]) expect(relay.err()).not.toContain(secret);
  }, 30_000);
});
