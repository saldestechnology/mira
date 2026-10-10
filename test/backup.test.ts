import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as Y from 'yjs';
import { BackupError, createKeyring, deriveKeys, formatManifestName, loadBackupConfig, parseManifestName, seal, unseal } from '../server/backup.mjs';
import { createSnapshotBarrier } from '../server/snapshot-barrier.mjs';
import {
  DAY, HOUR, KEY, KEY_OTHER, KEY_PREVIOUS, MIN, T0, VERSION_A, VERSION_B, VERSION_C, docBytes, envFor, harness, type Harness,
} from './backup-harness';

// docs/backups.md. The engine against an in-memory S3 that checks every signature. The clock is injected, so retention
// and the one hour grace of the cleanup are exact.

const OBJECTS = /^tabula\/objects\//;
const MANIFESTS = /^tabula\/manifests\//;
let h: Harness;
const scratch: string[] = [];

afterEach(async () => {
  await h?.close();
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const objectPuts = () => h.fake.count('PUT', OBJECTS);
const manifestPuts = () => h.fake.count('PUT', MANIFESTS);
const manifestKeys = () => h.fake.keys(MANIFESTS);
const rooted = (key: string) => key.replace(/^tabula\/(objects|manifests)\//, '');

describe.each([
  ['without a directory (open mode)', false],
  ['with the accounts directory', true],
] as const)('a backup %s', (_name, accounts) => {
  it('backs up the rooms and history, and the database in accounts mode, and reads them back byte for byte', async () => {
    h = await harness({ accounts });
    const engine = h.engine();
    expect(await engine.runNow()).toMatchObject({ ok: true, changed: true, files: h.expectedPaths().length });

    const listed = await engine.listManifests();
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe('20261008T193000Z.json.enc');
    const manifest = await engine.readManifest(listed[0].name);
    expect(manifest.files.map((f: { path: string }) => f.path)).toEqual(h.expectedPaths());
    expect(manifest).toMatchObject({ version: 1, keyId: engine.keyId, createdAt: '2026-10-08T19:30:00.000Z' });
    expect(manifest.snapshotBarrier).toMatchObject({ completed: true, snapshotSeq: 1, startedAt: T0, endedAt: T0 });
    expect(manifest.appVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(manifest.totals.files).toBe(manifest.files.length);

    const files = manifest.files as { path: string; size: number; objectId: string }[];
    for (const f of files) expect((await engine.readObject(f.objectId)).length).toBe(f.size);
    for (const f of files.filter((x) => x.path !== 'directory.sqlite')) {
      expect((await engine.readObject(f.objectId)).equals(fs.readFileSync(h.file(f.path)))).toBe(true);
    }
  });

  it('leaves out temporary files, the outbox, write-ahead files, stray files and versions the index does not list', async () => {
    h = await harness({ accounts });
    const engine = h.engine();
    await engine.runNow();
    const manifest = await engine.readManifest((await engine.listManifests())[0].name);
    const paths = manifest.files.map((f: { path: string }) => f.path);
    for (const leftOut of ['b1.yjs.tmp', 'outbox.jsonl', 'notes.txt', 'directory.sqlite-wal', 'directory.sqlite-shm', 'history/b1/ORPHANORPHANORPH.yjs.gz', 'history/b1/leftover.tmp']) {
      expect(paths).not.toContain(leftOut);
    }
    expect(paths.some((p: string) => p.includes('corrupt') || p.includes('not a board') || p.endsWith('.tmp'))).toBe(false);
  });

  it('stores ciphertext under names that tell nothing', async () => {
    h = await harness({ accounts });
    await h.engine().runNow();
    const objects = h.fake.keys(OBJECTS);
    expect(objects).toHaveLength(h.expectedPaths().length);
    for (const key of objects) expect(key).toMatch(/^tabula\/objects\/[0-9a-f]{64}$/);
    expect(manifestKeys()).toEqual(['tabula/manifests/20261008T193000Z.json.enc']);
    expect(h.fake.keys().length).toBe(objects.length + 1);
    const everything = Buffer.concat([...h.fake.objects.values()].map((o) => o.body));
    for (const secret of ['version a bytes', 'version b bytes', 'board one', 'comments of one', 'b1.yjs', 'history', 'tabula-backup', '"files"', 'SQLite format 3']) {
      expect(everything.includes(secret)).toBe(false);
    }
    for (const o of h.fake.objects.values()) expect(o.body[0]).toBe(1);
  });

  it('uploads every object before it writes the manifest', async () => {
    h = await harness({ accounts });
    await h.engine().runNow();
    const puts = h.fake.log.filter((l) => l.method === 'PUT');
    expect(puts.at(-1)!.key).toMatch(MANIFESTS);
    expect(puts.slice(0, -1).every((l) => OBJECTS.test(l.key))).toBe(true);
    const manifestAt = h.fake.log.findIndex((l) => l.method === 'PUT' && MANIFESTS.test(l.key));
    const heads = h.fake.log.map((l, i) => (l.method === 'HEAD' ? i : -1)).filter((i) => i >= 0);
    expect(heads).toHaveLength(objectPuts());
    expect(heads.every((i) => i < manifestAt)).toBe(true);
    expect(h.fake.log.at(-1)!.method).toBe('GET');
  });

  it('a later run uploads only what changed', async () => {
    h = await harness({ accounts });
    const engine = h.engine();
    await engine.runNow();
    const before = objectPuts();
    h.write('b2.yjs', docBytes('board two, edited'));
    h.clock.now += 2 * HOUR;
    expect(await engine.runNow()).toMatchObject({ ok: true, changed: true, uploaded: 1 });
    expect(objectPuts() - before).toBe(1);
    expect(manifestPuts()).toBe(2);
    expect(h.fake.keys(OBJECTS)).toHaveLength(h.expectedPaths().length + 1);
    const [newest, older] = await engine.listManifests();
    expect(newest.name).toBe('20261008T213000Z.json.enc');
    const a = await engine.readManifest(newest.name);
    const b = await engine.readManifest(older.name);
    expect(a.snapshotBarrier!.snapshotSeq).toBe(b.snapshotBarrier!.snapshotSeq + 1);
    const differing = a.files.filter((f: { path: string; objectId: string }, i: number) => f.objectId !== b.files[i].objectId);
    expect(differing.map((f: { path: string }) => f.path)).toEqual(['b2.yjs']);
  });

  it('keeps an open room and the directory database at one point when a writer arrives between their copies', async () => {
    const barrier = createSnapshotBarrier({ maxHoldMs: 5000, now: () => h.clock.now });
    h = await harness({ accounts: true, snapshotBarrier: barrier });
    h.directory!.setSetting('snapshot.marker', 'before');
    const doc = new Y.Doc();
    doc.getMap('markers').set('snapshot', 'before');
    let queued: Promise<unknown> | null = null;
    const engine = h.engine({
      snapshotBarrier: barrier,
      boardState: (room: string) => {
        if (room === 'b1' && queued === null) {
          // snapshotFiles asks for the room only after its directory.sqlite copy has completed.
          h.directory!.setSetting('snapshot.marker', 'after');
          queued = barrier.runWriter(() => {
            doc.getMap('markers').set('snapshot', 'after');
          });
        }
        return room === 'b1' ? Y.encodeStateAsUpdate(doc) : null;
      },
    });

    const result = await engine.runNow();
    expect(result).toMatchObject({ ok: true, changed: true });
    const manifestName = (result as { manifest?: string }).manifest;
    if (result.ok !== true || typeof manifestName !== 'string') throw new Error('the snapshot backup did not create a manifest');
    if (!queued) throw new Error('the room snapshot did not start the concurrent writer');
    await queued;

    const manifest = await engine.readManifest(manifestName);
    const directoryEntry = manifest.files.find((file: { path: string }) => file.path === 'directory.sqlite');
    const boardEntry = manifest.files.find((file: { path: string }) => file.path === 'b1.yjs');
    expect(directoryEntry).toBeTruthy();
    expect(boardEntry).toBeTruthy();
    const databaseFile = h.file('snapshot-point.sqlite');
    fs.writeFileSync(databaseFile, await engine.readObject(directoryEntry.objectId));
    const snapshotDb = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      expect(snapshotDb.prepare('SELECT value FROM settings WHERE key = ?').get('snapshot.marker')).toMatchObject({ value: 'before' });
    } finally {
      snapshotDb.close();
    }
    const room = new Y.Doc();
    Y.applyUpdate(room, await engine.readObject(boardEntry.objectId));
    expect(room.getMap('markers').get('snapshot')).toBe('before');
    expect(h.directory!.getSetting('snapshot.marker')).toBe('after');
    expect(doc.getMap('markers').get('snapshot')).toBe('after');
    doc.destroy();
    room.destroy();
  });

  it('a new file, a deleted file and a new history version show up', async () => {
    h = await harness({ accounts });
    const engine = h.engine();
    await engine.runNow();
    h.write('b3.yjs', docBytes('board three'));
    fs.rmSync(h.file('b2.yjs'));
    h.write(`history/b1/${VERSION_C}.yjs.gz`, Buffer.from('version c'));
    h.write('history/b1/index.json', h.index([VERSION_A, VERSION_B, VERSION_C]));
    h.clock.now += 10 * MIN;
    await engine.runNow();
    const manifest = await engine.readManifest((await engine.listManifests())[0].name);
    const paths = manifest.files.map((f: { path: string }) => f.path);
    expect(paths).toContain('b3.yjs');
    expect(paths).toContain(`history/b1/${VERSION_C}.yjs.gz`);
    expect(paths).not.toContain('b2.yjs');
  });

  it('an unchanged run writes no manifest and still records the success', async () => {
    h = await harness({ accounts });
    const engine = h.engine();
    await engine.runNow();
    const first = engine.status();
    const puts = h.fake.count('PUT');
    h.clock.now += 30 * MIN;
    expect(await engine.runNow()).toMatchObject({ ok: true, changed: false, manifest: '20261008T193000Z.json.enc', uploaded: 0 });
    expect(h.fake.count('PUT')).toBe(puts);
    expect(manifestKeys()).toHaveLength(1);
    const status = engine.status();
    expect(status.lastSuccessAt).toBe(T0 + 30 * MIN);
    expect(first.lastSuccessAt).toBe(T0);
    expect(status.lastSuccessAt).toBeGreaterThan(T0);
    expect(status.lastManifest).toBe('20261008T193000Z.json.enc');
    expect(status.consecutiveFailures).toBe(0);
    h.clock.now += 30 * MIN;
    expect(await engine.runNow()).toMatchObject({ ok: true, changed: false });
    expect(manifestKeys()).toHaveLength(1);
  });

  it('a restarted engine asks about the objects it does not know once and uploads nothing', async () => {
    h = await harness({ accounts });
    await h.engine().runNow();
    const files = h.expectedPaths().length;
    const heads = h.fake.count('HEAD');
    const puts = h.fake.count('PUT');
    h.clock.now += HOUR;
    const restarted = h.engine();
    expect(await restarted.runNow()).toMatchObject({ ok: true, changed: false, uploaded: 0 });
    expect(h.fake.count('HEAD') - heads).toBe(files);
    expect(h.fake.count('PUT')).toBe(puts);
    h.clock.now += HOUR;
    await restarted.runNow();
    expect(h.fake.count('HEAD') - heads).toBe(files);
  });

  it('puts back an object that vanished from the bucket, without a new manifest', async () => {
    h = await harness({ accounts });
    await h.engine().runNow();
    const [victim] = h.fake.keys(OBJECTS);
    h.fake.objects.delete(victim);
    h.clock.now += HOUR;
    expect(await h.engine().runNow()).toMatchObject({ ok: true, changed: false, uploaded: 1 });
    expect(h.fake.objects.has(victim)).toBe(true);
    expect(manifestKeys()).toHaveLength(1);
  });

  it('puts back an object that has the wrong size', async () => {
    h = await harness({ accounts });
    await h.engine().runNow();
    const [victim] = h.fake.keys(OBJECTS);
    const good = h.fake.objects.get(victim)!.body;
    h.fake.objects.set(victim, { body: good.subarray(0, good.length - 3), lastModified: T0 });
    h.clock.now += HOUR;
    expect(await h.engine().runNow()).toMatchObject({ ok: true, uploaded: 1 });
    expect(h.fake.objects.get(victim)!.body.length).toBe(good.length);
  });

  it('files with the same content share one object', async () => {
    h = await harness({ accounts });
    h.write('b4.yjs', fs.readFileSync(h.file('b1.yjs')));
    const engine = h.engine();
    await engine.runNow();
    expect(h.fake.keys(OBJECTS)).toHaveLength(h.expectedPaths().length);
    const manifest = await engine.readManifest((await engine.listManifests())[0].name);
    const ids = manifest.files.filter((f: { path: string }) => f.path === 'b1.yjs' || f.path === 'b4.yjs').map((f: { objectId: string }) => f.objectId);
    expect(ids[0]).toBe(ids[1]);
  });

  it('survives a bucket with many objects (paged listings)', async () => {
    h = await harness({ accounts, pageSize: 2 });
    const engine = h.engine();
    await engine.runNow();
    h.clock.now += 3 * HOUR;
    h.write('b2.yjs', docBytes('changed'));
    expect(await engine.runNow()).toMatchObject({ ok: true });
    expect((await engine.listManifests()).length).toBe(2);
    expect(h.fake.badSignatures).toEqual([]);
  });

  it('an empty data directory is a valid backup', async () => {
    h = await harness({ accounts, seed: false });
    const engine = h.engine();
    expect(await engine.runNow()).toMatchObject({ ok: true, changed: true, files: accounts ? 1 : 0 });
    expect(await engine.runNow()).toMatchObject({ ok: true, changed: false });
  });
});

describe('the database copy', () => {
  it('opens, has the rows, and carries none of the engine\'s own', async () => {
    h = await harness({ accounts: true });
    const engine = h.engine();
    await engine.runNow();
    h.clock.now += HOUR;
    await engine.runNow();
    h.directory!.audit(null, 'backup.run', { files: 1 });
    expect(h.directory!.getSetting('backup.status')).toContain('lastSuccessAt');

    const manifest = await engine.readManifest((await engine.listManifests())[0].name);
    const entry = manifest.files.find((f: { path: string }) => f.path === 'directory.sqlite');
    const plain: Buffer = await engine.readObject(entry.objectId);
    expect(plain.toString('latin1', 0, 15)).toBe('SQLite format 3');
    const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-restored-')), 'directory.sqlite');
    scratch.push(path.dirname(copy));
    fs.writeFileSync(copy, plain);
    const db = new DatabaseSync(copy);
    expect((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(2);
    expect((db.prepare("SELECT email FROM users WHERE role = 'owner'").get() as { email: string }).email).toBe('owner@example.com');
    expect(db.prepare("SELECT value FROM settings WHERE key = 'backup.status'").get()).toBeUndefined();
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action LIKE 'backup.%'").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'test.seed'").get() as { n: number }).n).toBe(1);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBeGreaterThan(0);
    expect((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok');
    db.close();
  });

  it('is consistent while the server keeps writing', async () => {
    h = await harness({ accounts: true });
    const engine = h.engine();
    let stop = false;
    const writer = (async () => {
      let i = 0;
      while (!stop) {
        h.directory!.createUser({ email: `u${i++}@example.com`, name: 'U', role: 'member' });
        await new Promise((r) => setImmediate(r));
      }
    })();
    for (let i = 0; i < 3; i++) {
      h.clock.now += HOUR;
      expect(await engine.runNow()).toMatchObject({ ok: true });
    }
    stop = true;
    await writer;
    const manifest = await engine.readManifest((await engine.listManifests())[0].name);
    const plain: Buffer = await engine.readObject(manifest.files.find((f: { path: string }) => f.path === 'directory.sqlite').objectId);
    const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-restored-')), 'd.sqlite');
    scratch.push(path.dirname(copy));
    fs.writeFileSync(copy, plain);
    const db = new DatabaseSync(copy);
    expect((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok');
    expect((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBeGreaterThanOrEqual(2);
    db.close();
  });

  it('leaves no temporary copy behind, and removes one an earlier crash left', async () => {
    h = await harness({ accounts: true });
    expect(fs.existsSync(h.file('directory.sqlite.backup-0000000000000000.tmp'))).toBe(true);
    await h.engine().runNow();
    expect(fs.readdirSync(h.dir).filter((n) => n.startsWith('directory.sqlite.backup-'))).toEqual([]);
  });

  it('removes its temporary copy when the run fails', async () => {
    h = await harness({ accounts: true });
    h.fake.rules.push({ method: 'PUT', status: 403, times: 99 });
    expect(await h.engine().runNow()).toMatchObject({ ok: false });
    expect(fs.readdirSync(h.dir).filter((n) => n.startsWith('directory.sqlite.backup-'))).toEqual([]);
  });

  it('is skipped when there is no database (open mode)', async () => {
    h = await harness({ accounts: false });
    const engine = h.engine();
    await engine.runNow();
    const manifest = await engine.readManifest((await engine.listManifests())[0].name);
    expect(manifest.files.map((f: { path: string }) => f.path)).not.toContain('directory.sqlite');
  });

  it('is still taken in open mode when an old database is there', async () => {
    h = await harness({ accounts: false });
    const { openDirectory } = await import('../server/directory.mjs');
    openDirectory(h.file('directory.sqlite')).close();
    const engine = h.engine();
    await engine.runNow();
    const manifest = await engine.readManifest((await engine.listManifests())[0].name);
    expect(manifest.files.map((f: { path: string }) => f.path)).toContain('directory.sqlite');
  });
});

describe('the state of open rooms and the consistency of history', () => {
  it('takes an open room from the hook, and the file for every other room', async () => {
    h = await harness();
    const live = docBytes('typed a second ago, not saved yet');
    const asked: string[] = [];
    const engine = h.engine({
      boardState: (room: string) => {
        asked.push(room);
        return room === 'b1' ? new Uint8Array(live) : null;
      },
    });
    await engine.runNow();
    expect(asked.sort()).toEqual(['b1', 'b1~comments', 'b2']);
    const manifest = await engine.readManifest((await engine.listManifests())[0].name);
    const read = async (p: string) => engine.readObject(manifest.files.find((f: { path: string }) => f.path === p).objectId);
    expect((await read('b1.yjs')).equals(live)).toBe(true);
    expect((await read('b2.yjs')).equals(fs.readFileSync(h.file('b2.yjs')))).toBe(true);
    expect((await read('b1~comments.yjs')).equals(fs.readFileSync(h.file('b1~comments.yjs')))).toBe(true);
  });

  it('falls back to the file when the hook fails', async () => {
    h = await harness();
    const engine = h.engine({ boardState: () => { throw new Error('room exploded'); } });
    expect(await engine.runNow()).toMatchObject({ ok: true });
    const manifest = await engine.readManifest((await engine.listManifests())[0].name);
    expect(manifest.files.map((f: { path: string }) => f.path)).toContain('b1.yjs');
    expect(h.logs.join('\n')).toContain('using its file');
  });

  it('does not back up a room that has no file yet', async () => {
    h = await harness();
    const engine = h.engine({ boardState: (room: string) => (room === 'brand-new' ? docBytes('x') : null) });
    await engine.runNow();
    const manifest = await engine.readManifest((await engine.listManifests())[0].name);
    expect(manifest.files.map((f: { path: string }) => f.path)).not.toContain('brand-new.yjs');
  });

  it('keeps an unchanged live room unchanged', async () => {
    h = await harness();
    const live = docBytes('steady');
    const engine = h.engine({ boardState: (room: string) => (room === 'b1' ? new Uint8Array(live) : null) });
    await engine.runNow();
    h.clock.now += HOUR;
    expect(await engine.runNow()).toMatchObject({ ok: true, changed: false });
  });

  it('stores an index that lists only the versions it stored', async () => {
    h = await harness();
    fs.rmSync(h.file(`history/b1/${VERSION_B}.yjs.gz`));
    const engine = h.engine();
    await engine.runNow();
    const manifest = await engine.readManifest((await engine.listManifests())[0].name);
    const paths = manifest.files.map((f: { path: string }) => f.path);
    expect(paths).toContain(`history/b1/${VERSION_A}.yjs.gz`);
    expect(paths).not.toContain(`history/b1/${VERSION_B}.yjs.gz`);
    const stored = JSON.parse((await engine.readObject(manifest.files.find((f: { path: string }) => f.path === 'history/b1/index.json').objectId)).toString());
    expect(stored.v).toBe(1);
    expect(stored.versions.map((v: { id: string }) => v.id)).toEqual([VERSION_A]);
  });

  it('stores an index that is complete exactly as it is', async () => {
    h = await harness();
    const engine = h.engine();
    await engine.runNow();
    const manifest = await engine.readManifest((await engine.listManifests())[0].name);
    const stored = await engine.readObject(manifest.files.find((f: { path: string }) => f.path === 'history/b1/index.json').objectId);
    expect(stored.equals(fs.readFileSync(h.file('history/b1/index.json')))).toBe(true);
  });

  it('leaves a board\'s history out when its index is unreadable, and carries on', async () => {
    h = await harness();
    h.write('history/b1/index.json', '{ this is not json');
    h.write('history/b2/index.json', h.index([VERSION_C]));
    h.write(`history/b2/${VERSION_C}.yjs.gz`, 'c');
    const engine = h.engine();
    expect(await engine.runNow()).toMatchObject({ ok: true });
    const manifest = await engine.readManifest((await engine.listManifests())[0].name);
    const paths = manifest.files.map((f: { path: string }) => f.path);
    expect(paths.some((p: string) => p.startsWith('history/b1/'))).toBe(false);
    expect(paths).toContain(`history/b2/${VERSION_C}.yjs.gz`);
  });

  it('a history file that vanishes between the listing and the read is left out', async () => {
    h = await harness();
    const engine = h.engine({
      boardState: () => {
        fs.rmSync(h.file(`history/b1/${VERSION_A}.yjs.gz`), { force: true });
        return null;
      },
    });
    expect(await engine.runNow()).toMatchObject({ ok: true });
    const manifest = await engine.readManifest((await engine.listManifests())[0].name);
    expect(manifest.files.map((f: { path: string }) => f.path)).not.toContain(`history/b1/${VERSION_A}.yjs.gz`);
  });

  it('does not follow a link out of the data directory', async () => {
    h = await harness();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-outside-'));
    scratch.push(outside);
    fs.writeFileSync(path.join(outside, 'secret.yjs'), 'outside data');
    try {
      fs.symlinkSync(path.join(outside, 'secret.yjs'), h.file('link.yjs'));
      fs.symlinkSync(outside, h.file('history/linked'));
    } catch {
      return;
    }
    const engine = h.engine();
    await engine.runNow();
    const manifest = await engine.readManifest((await engine.listManifests())[0].name);
    const paths = manifest.files.map((f: { path: string }) => f.path);
    expect(paths).not.toContain('link.yjs');
    expect(paths.some((p: string) => p.startsWith('history/linked'))).toBe(false);
  });

  it('fails a run with a file above the limit, naming the file and the limit', async () => {
    h = await harness();
    h.write('big.yjs', Buffer.alloc(3000, 1));
    const engine = h.engine({ maxFileBytes: 2000 });
    const result = await engine.runNow();
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toBe('big.yjs is 3000 bytes, more than the 2000 bytes a backup file may be');
    expect(manifestKeys()).toEqual([]);
    expect(engine.status()).toMatchObject({ consecutiveFailures: 1, lastError: result.error });
  });

  it('applies the limit to the database copy too', async () => {
    h = await harness({ accounts: true });
    const result = await h.engine({ maxFileBytes: 20_000 }).runNow();
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/^directory\.sqlite is \d+ bytes, more than the 20000 bytes/);
  });
});

describe('a run that fails', () => {
  it('writes no manifest when the manifest upload fails, shows the failure, and the next run succeeds', async () => {
    h = await harness({ accounts: true });
    const engine = h.engine();
    h.fake.rules.push({ method: 'PUT', key: MANIFESTS, status: 500, times: 99 });
    const failed = await engine.runNow();
    expect(failed).toMatchObject({ ok: false });
    expect(manifestKeys()).toEqual([]);
    expect(h.fake.keys(OBJECTS)).toHaveLength(h.expectedPaths().length);
    expect(await engine.listManifests()).toEqual([]);
    expect(engine.status()).toMatchObject({
      lastSuccessAt: null, lastRunAt: T0, lastError: 'S3 PUT failed (status 500, InternalError)', lastFailureAt: T0,
      lastFailureError: 'S3 PUT failed (status 500, InternalError)', consecutiveFailures: 1, lastManifest: null,
    });
    expect(JSON.parse(String(h.directory!.getSetting('backup.status')))).toMatchObject({ consecutiveFailures: 1, lastSuccessAt: null });
    expect(h.directory!.listAudit(5)[0]).toMatchObject({ action: 'backup.failed', actorId: null, detail: { error: 'S3 PUT failed (status 500, InternalError)' } });

    h.fake.rules.length = 0;
    h.clock.now += 10 * MIN;
    const objectsBefore = objectPuts();
    expect(await engine.runNow()).toMatchObject({ ok: true, changed: true, uploaded: 0 });
    expect(objectPuts()).toBe(objectsBefore);
    expect(manifestKeys()).toHaveLength(1);
    expect(engine.status()).toMatchObject({
      lastSuccessAt: T0 + 10 * MIN, lastError: null, consecutiveFailures: 0, lastFailureAt: T0, lastFailureError: 'S3 PUT failed (status 500, InternalError)',
    });
  });

  it('counts consecutive failures and keeps the last success', async () => {
    h = await harness();
    const engine = h.engine();
    await engine.runNow();
    h.fake.rules.push({ method: 'GET', key: /^$/, status: 403, times: 99 });
    for (let i = 1; i <= 3; i++) {
      h.clock.now += HOUR;
      expect(await engine.runNow()).toMatchObject({ ok: false });
      expect(engine.status().consecutiveFailures).toBe(i);
    }
    expect(engine.status()).toMatchObject({ lastSuccessAt: T0, lastFailureAt: T0 + 3 * HOUR, lastError: 'S3 GET failed (status 403, AccessDenied)' });
  });

  it('retries a 500 on an object and still succeeds', async () => {
    h = await harness();
    h.fake.rules.push({ method: 'PUT', key: OBJECTS, status: 500, times: 2 });
    expect(await h.engine().runNow()).toMatchObject({ ok: true });
    expect(h.fake.count('PUT', OBJECTS)).toBe(h.expectedPaths().length + 2);
  });

  it('does not retry a 403', async () => {
    h = await harness();
    h.fake.rules.push({ method: 'PUT', status: 403, times: 99 });
    expect(await h.engine().runNow()).toMatchObject({ ok: false, error: 'S3 PUT failed (status 403, AccessDenied)' });
    expect(h.fake.count('PUT')).toBe(1);
  });

  it('fails when the bucket cannot be reached', async () => {
    h = await harness();
    await h.fake.close();
    const result = await h.engine().runNow();
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/^S3 GET could not reach the storage provider/);
  });

  it('fails the run, and removes the manifest, when it cannot be read back intact', async () => {
    h = await harness();
    const real = globalThis.fetch;
    const engine = h.engine({
      fetch: async (url: string, init: RequestInit) => {
        const res = await real(url, init);
        if (init.method === 'GET' && /\/manifests\/2/.test(url)) {
          const body = Buffer.from(await res.arrayBuffer());
          body[body.length - 20] ^= 1;
          return new Response(body, { status: 200 });
        }
        return res;
      },
    });
    const result = await engine.runNow();
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/manifest could not be read back/);
    expect(manifestKeys()).toEqual([]);
    expect(engine.status()).toMatchObject({ lastSuccessAt: null, consecutiveFailures: 1 });
  });

  it('fails the run, writing no manifest, when an uploaded object is not in the bucket', async () => {
    h = await harness();
    const real = globalThis.fetch;
    const engine = h.engine({
      fetch: async (url: string, init: RequestInit) =>
        init.method === 'HEAD' && /\/objects\//.test(url) ? new Response(null, { status: 404 }) : real(url, init),
    });
    const result = await engine.runNow();
    expect(result).toMatchObject({ ok: false, error: 'An uploaded backup object could not be found again in the bucket' });
    expect(manifestKeys()).toEqual([]);
  });

  it('turns an exception from anywhere into a failed run, never a thrown one', async () => {
    h = await harness({ accounts: true });
    const bad = h.engine({ boardState: () => { throw new Error('boom'); }, fetch: async () => { throw new TypeError('fetch failed'); } });
    await expect(bad.runNow()).resolves.toMatchObject({ ok: false });
    const worse = h.engine({ dataDir: path.join(h.dir, 'does-not-exist') });
    await expect(worse.runNow()).resolves.toMatchObject({ ok: false });
    expect(h.logs.some((l) => l.startsWith('backup: failed:'))).toBe(true);
  });

  it('an audit or status write that fails does not fail the backup', async () => {
    h = await harness();
    const broken = {
      getSetting: () => null,
      setSetting: () => { throw new Error('database is locked'); },
      audit: () => { throw new Error('database is locked'); },
    };
    const engine = h.engine({ directory: broken });
    expect(await engine.runNow()).toMatchObject({ ok: true });
    expect(engine.status().lastSuccessAt).toBe(T0);
    expect(h.logs.join('\n')).toContain('could not store the status');
  });
});

describe('status and audit', () => {
  it('reports a first run, and the same after a restart', async () => {
    h = await harness({ accounts: true });
    const engine = h.engine();
    expect(engine.status()).toMatchObject({ enabled: true, running: false, lastSuccessAt: null, lastRunAt: null, consecutiveFailures: 0, manifests: 0, nextRunAt: null });
    await engine.runNow();
    const status = engine.status();
    expect(status).toMatchObject({
      enabled: true, running: false, keyId: engine.keyId, intervalMinutes: 60, lastSuccessAt: T0, lastRunAt: T0, lastError: null,
      lastFailureAt: null, lastFailureError: null, consecutiveFailures: 0, lastManifest: '20261008T193000Z.json.enc', manifests: 1,
      objects: h.expectedPaths().length,
    });
    const manifest = await engine.readManifest(status.lastManifest);
    const stored = (await Promise.all(manifest.files.map((f: { objectId: string }) => engine.readObject(f.objectId)))).reduce((sum: number, b: Buffer) => sum + b.length + 33, 0);
    expect(status.bytesStored).toBe(stored);

    const restarted = h.engine();
    expect(restarted.status()).toMatchObject({ lastSuccessAt: T0, lastManifest: '20261008T193000Z.json.enc', bytesStored: status.bytesStored, manifests: 1 });
  });

  it('counts the bytes of a shared object once', async () => {
    h = await harness();
    h.write('b4.yjs', fs.readFileSync(h.file('b1.yjs')));
    const engine = h.engine();
    await engine.runNow();
    const manifest = await engine.readManifest((await engine.listManifests())[0].name);
    const unique = new Map(manifest.files.map((f: { objectId: string; size: number }) => [f.objectId, f.size]));
    expect(engine.status().bytesStored).toBe([...unique.values()].reduce((a: number, b) => a + (b as number) + 33, 0));
  });

  it('reports running while a run is in progress', async () => {
    h = await harness();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const real = globalThis.fetch;
    const engine = h.engine({ fetch: async (url: string, init: RequestInit) => { await gate; return real(url, init); } });
    const pending = engine.runNow();
    expect(engine.status().running).toBe(true);
    release();
    await pending;
    expect(engine.status().running).toBe(false);
  });

  it('writes an audit row for a run that did something, with counts only and no actor', async () => {
    h = await harness({ accounts: true });
    const engine = h.engine();
    await engine.runNow();
    const rows = h.directory!.listAudit(10).filter((r) => r.action === 'backup.run');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: null, detail: { changed: true, files: h.expectedPaths().length, uploaded: h.expectedPaths().length, skipped: 0 } });
    for (const value of Object.values(rows[0].detail)) expect(typeof value === 'number' || typeof value === 'boolean').toBe(true);
  });

  it('leaves a run that found nothing to do out of the audit log, but still records it in the status', async () => {
    h = await harness({ accounts: true });
    const engine = h.engine();
    await engine.runNow();
    const first = engine.status().lastSuccessAt;
    h.clock.now += HOUR;
    await engine.runNow();
    h.clock.now += HOUR;
    await engine.runNow();
    expect(h.directory!.listAudit(20).filter((r) => r.action === 'backup.run')).toHaveLength(1);
    expect(engine.status().lastSuccessAt).toBe(first! + 2 * HOUR);
  });

  it('audits a quiet run once it deleted something', async () => {
    h = await harness({ accounts: true, env: { TABULA_BACKUP_KEEP_HOURLY_HOURS: '0', TABULA_BACKUP_KEEP_DAILY_DAYS: '1' } });
    const engine = h.engine();
    await engine.runNow();
    h.write('b2.yjs', docBytes('edit'));
    h.clock.now += 2 * HOUR;
    await engine.runNow();
    h.clock.now += 3 * DAY;
    await engine.runNow();
    const rows = h.directory!.listAudit(20).filter((r) => r.action === 'backup.run');
    expect(rows.some((r) => (r.detail.manifestsDeleted as number) > 0 || (r.detail.objectsDeleted as number) > 0)).toBe(true);
  });

  it('keeps the status in memory without a directory', async () => {
    h = await harness();
    const engine = h.engine();
    await engine.runNow();
    expect(engine.status().lastSuccessAt).toBe(T0);
  });

  it('reads a damaged stored status as an empty one', async () => {
    h = await harness({ accounts: true });
    h.directory!.setSetting('backup.status', '{"lastSuccessAt": "yesterday", "consecutiveFailures": -4, "lastManifest": "../x", "prune": 7}');
    expect(h.engine().status()).toMatchObject({ lastSuccessAt: null, consecutiveFailures: 0, lastManifest: null, prune: null });
    h.directory!.setSetting('backup.status', 'nonsense');
    expect(h.engine().status().lastSuccessAt).toBeNull();
  });
});

describe('retention in a running backup', () => {
  const hoursOfRuns = async (engine: ReturnType<Harness['engine']>, hours: number, every: number) => {
    for (let at = 0; at <= hours; at += every) {
      h.write('b2.yjs', docBytes(`edit ${at}`));
      h.clock.now = T0 + at * HOUR;
      expect(await engine.runNow()).toMatchObject({ ok: true, changed: true });
    }
  };
  const nameAt = (hoursAfterStart: number) => formatManifestName(T0 + hoursAfterStart * HOUR);

  it('add-on tier: the newest per hour for 48 hours and the newest per day for 30 days', async () => {
    h = await harness({ env: { TABULA_BACKUP_KEEP_HOURLY_HOURS: '6', TABULA_BACKUP_KEEP_DAILY_DAYS: '2' } });
    const engine = h.engine();
    await hoursOfRuns(engine, 72, 3);
    const now = T0 + 72 * HOUR;
    const kept = (await engine.listManifests()).map((m: { name: string }) => parseManifestName(m.name) as number);
    const expected = new Set<number>([now]);
    const all: number[] = [];
    for (let at = 0; at <= 72; at += 3) all.push(T0 + at * HOUR);
    const newestBy = (bucket: (t: number) => number, within: number) => {
      const best = new Map<number, number>();
      for (const t of all) if (now - t <= within) best.set(bucket(t), Math.max(best.get(bucket(t)) ?? 0, t));
      return [...best.values()];
    };
    for (const t of newestBy((x) => Math.floor(x / HOUR), 6 * HOUR)) expected.add(t);
    for (const t of newestBy((x) => Math.floor(x / DAY), 2 * DAY)) expected.add(t);
    expect(kept.sort()).toEqual([...expected].sort());
    expect(kept.length).toBeLessThan(25);
    expect(manifestKeys().map(rooted)).toEqual([...expected].sort().map((t) => formatManifestName(t)));
  });

  it('basic tier: no hourly points, a week of days (hourly 0, daily 7, runs every 12 hours)', async () => {
    h = await harness({ env: { TABULA_BACKUP_KEEP_HOURLY_HOURS: '0', TABULA_BACKUP_KEEP_DAILY_DAYS: '7', TABULA_BACKUP_INTERVAL_MINUTES: '1440' } });
    const engine = h.engine();
    expect(engine.status().intervalMinutes).toBe(1440);
    await hoursOfRuns(engine, 12 * 24, 12);
    const now = T0 + 12 * 24 * HOUR;
    const kept = (await engine.listManifests()).map((m: { name: string }) => parseManifestName(m.name) as number).sort();
    const days = new Map<number, number>();
    for (let at = 0; at <= 12 * 24; at += 12) {
      const t = T0 + at * HOUR;
      if (now - t <= 7 * DAY) days.set(Math.floor(t / DAY), Math.max(days.get(Math.floor(t / DAY)) ?? 0, t));
    }
    expect(kept).toEqual([...new Set([...days.values(), now])].sort());
    expect(kept.length).toBeLessThanOrEqual(9);
    expect(kept.length).toBeGreaterThanOrEqual(7);
    expect(nameAt(0) in Object.fromEntries(kept.map((t: number) => [formatManifestName(t), 1]))).toBe(false);
  });

  it('always keeps the newest, even with both windows at zero', async () => {
    h = await harness({ env: { TABULA_BACKUP_KEEP_HOURLY_HOURS: '0', TABULA_BACKUP_KEEP_DAILY_DAYS: '0' } });
    const engine = h.engine();
    await hoursOfRuns(engine, 10, 2);
    expect((await engine.listManifests()).map((m: { name: string }) => m.name)).toEqual([nameAt(10)]);
  });
});

describe('cleaning up objects', () => {
  const orphan = (age: number, id = crypto.randomBytes(32).toString('hex')) => {
    const key = `tabula/objects/${id}`;
    h.fake.objects.set(key, { body: Buffer.from('orphan'), lastModified: h.clock.now - age });
    return key;
  };

  it('deletes objects nothing refers to once they are older than an hour, and keeps the rest', async () => {
    h = await harness({ accounts: true });
    const engine = h.engine();
    await engine.runNow();
    const referenced = h.fake.keys(OBJECTS);
    h.clock.now += 10 * MIN;
    const old = orphan(2 * HOUR);
    const edge = orphan(HOUR);
    const recent = orphan(59 * MIN);
    const fresh = orphan(0);
    await engine.runNow();
    expect(h.fake.objects.has(old)).toBe(false);
    expect(h.fake.objects.has(edge)).toBe(true);
    expect(h.fake.objects.has(recent)).toBe(true);
    expect(h.fake.objects.has(fresh)).toBe(true);
    for (const key of referenced) expect(h.fake.objects.has(key)).toBe(true);
    expect(engine.status().prune).toMatchObject({ objectsDeleted: 1, manifestsDeleted: 0, gcSkipped: null, error: null });
    h.clock.now += 10 * MIN;
    await engine.runNow();
    expect(h.fake.objects.has(edge)).toBe(false);
    expect(h.fake.objects.has(recent)).toBe(false);
    expect(h.fake.objects.has(fresh)).toBe(true);
  });

  it('keeps the objects an older kept manifest still needs', async () => {
    h = await harness();
    const engine = h.engine();
    const original = fs.readFileSync(h.file('b2.yjs'));
    await engine.runNow();
    const first = await engine.readManifest((await engine.listManifests())[0].name);
    const oldB2 = first.files.find((f: { path: string }) => f.path === 'b2.yjs').objectId;
    h.write('b2.yjs', docBytes('second'));
    h.clock.now += 3 * HOUR;
    await engine.runNow();
    h.fake.objects.get(`tabula/objects/${oldB2}`)!.lastModified = T0 - 10 * DAY;
    h.clock.now += 3 * HOUR;
    h.write('b2.yjs', docBytes('third'));
    await engine.runNow();
    expect((await engine.listManifests()).length).toBe(3);
    expect(h.fake.objects.has(`tabula/objects/${oldB2}`)).toBe(true);
    expect((await engine.readObject(oldB2)).equals(original)).toBe(true);
  });

  it('deletes the objects of a manifest once the manifest ages out', async () => {
    h = await harness({ env: { TABULA_BACKUP_KEEP_HOURLY_HOURS: '0', TABULA_BACKUP_KEEP_DAILY_DAYS: '0' } });
    const engine = h.engine();
    await engine.runNow();
    const oldB2 = (await engine.readManifest((await engine.listManifests())[0].name)).files.find((f: { path: string }) => f.path === 'b2.yjs').objectId;
    h.write('b2.yjs', docBytes('second'));
    h.clock.now += 3 * HOUR;
    await engine.runNow();
    expect(await engine.listManifests()).toHaveLength(1);
    expect(h.fake.objects.has(`tabula/objects/${oldB2}`)).toBe(false);
    expect(engine.status().prune).toMatchObject({ manifestsDeleted: 1, objectsDeleted: 1 });
    const manifest = await engine.readManifest((await engine.listManifests())[0].name);
    for (const f of manifest.files as { objectId: string }[]) await engine.readObject(f.objectId);
  });

  it('never touches keys that are not objects of ours', async () => {
    h = await harness();
    const engine = h.engine();
    const strays = ['tabula/objects/README', `tabula/objects/${'A'.repeat(64)}`, `tabula/objects/${'a'.repeat(63)}`, `tabula/objects/sub/${'a'.repeat(64)}`, 'tabula/other/x', `other-prefix/objects/${'a'.repeat(64)}`, 'tabula/manifests/notes.txt'];
    for (const key of strays) h.fake.objects.set(key, { body: Buffer.from('keep me'), lastModified: T0 - 10 * DAY });
    await engine.runNow();
    h.clock.now += 2 * HOUR;
    await engine.runNow();
    for (const key of strays) expect(h.fake.objects.has(key)).toBe(true);
  });

  it('skips the cleanup, and says so, when a kept manifest cannot be read', async () => {
    h = await harness();
    const engine = h.engine();
    await engine.runNow();
    h.write('b2.yjs', docBytes('second'));
    h.clock.now += 3 * HOUR;
    await engine.runNow();
    const [newest, older] = await engine.listManifests();
    const key = `tabula/manifests/${older.name}`;
    const good = Buffer.from(h.fake.objects.get(key)!.body);
    const damaged = Buffer.from(good);
    damaged[40] ^= 1;
    h.fake.objects.set(key, { body: damaged, lastModified: T0 });
    const old = orphan(5 * HOUR);
    h.clock.now += 3 * HOUR;
    h.write('b2.yjs', docBytes('third'));
    expect(await engine.runNow()).toMatchObject({ ok: true });
    expect(h.fake.objects.has(old)).toBe(true);
    expect(engine.status().prune).toMatchObject({ gcSkipped: 'unreadable_manifest', objectsDeleted: 0 });
    expect(engine.status().lastSuccessAt).toBe(h.clock.now);
    expect(h.logs.join('\n')).toContain('no objects are deleted this time');
    void newest;

    h.fake.objects.set(key, { body: good, lastModified: T0 });
    h.clock.now += 3 * HOUR;
    await engine.runNow();
    expect(h.fake.objects.has(old)).toBe(false);
    expect(engine.status().prune).toMatchObject({ gcSkipped: null });
  });

  it('skips the cleanup when the manifest listing does not show the manifest it just wrote', async () => {
    h = await harness();
    const real = globalThis.fetch;
    let written = false;
    const engine = h.engine({
      fetch: async (url: string, init: RequestInit) => {
        if (init.method === 'PUT' && /\/manifests\//.test(url)) written = true;
        if (written && init.method === 'GET' && /prefix=tabula%2Fmanifests%2F/.test(url)) {
          return new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>', { status: 200 });
        }
        return real(url, init);
      },
    });
    const old = orphan(5 * HOUR);
    expect(await engine.runNow()).toMatchObject({ ok: true });
    expect(h.fake.objects.has(old)).toBe(true);
    expect(engine.status().prune).toMatchObject({ gcSkipped: 'inconsistent_listing', objectsDeleted: 0, manifestsDeleted: 0 });
  });

  it('a failing cleanup is reported but the backup is still a success', async () => {
    h = await harness({ env: { TABULA_BACKUP_KEEP_HOURLY_HOURS: '0', TABULA_BACKUP_KEEP_DAILY_DAYS: '0' } });
    const engine = h.engine();
    await engine.runNow();
    h.clock.now += HOUR;
    h.write('b2.yjs', docBytes('second'));
    h.fake.rules.push({ method: 'DELETE', status: 403, times: 99 });
    expect(await engine.runNow()).toMatchObject({ ok: true, changed: true });
    expect(engine.status()).toMatchObject({ lastSuccessAt: T0 + HOUR, consecutiveFailures: 0, lastError: null });
    expect(engine.status().prune).toMatchObject({ error: 'S3 DELETE failed (status 403, AccessDenied)' });
  });
});

describe('reading a backup', () => {
  const setup = async () => {
    h = await harness();
    const engine = h.engine();
    await engine.runNow();
    const manifestName = (await engine.listManifests())[0].name;
    const manifest = await engine.readManifest(manifestName);
    const entry = (p: string) => manifest.files.find((f: { path: string }) => f.path === p);
    return { engine, manifestName, manifest, entry };
  };
  const failure = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (err) {
      return err as BackupError;
    }
    throw new Error('expected a failure');
  };
  const objectKey = (id: string) => `tabula/objects/${id}`;

  it('lists manifests newest first', async () => {
    const { engine } = await setup();
    for (const hours of [1, 2, 3]) {
      h.write('b2.yjs', docBytes(`v${hours}`));
      await h.runAt(engine, T0 + hours * 3 * HOUR);
    }
    const names = (await engine.listManifests()).map((m: { name: string }) => m.name);
    expect(names).toEqual([...names].sort().reverse());
    expect(names).toHaveLength(4);
    expect((await engine.listManifests())[0]).toMatchObject({ size: expect.any(Number), lastModified: expect.any(Number) });
  });

  it('a flipped bit in an object is a tamper error', async () => {
    const { engine, entry } = await setup();
    const id = entry('b1.yjs').objectId;
    const stored = Buffer.from(h.fake.objects.get(objectKey(id))!.body);
    stored[stored.length - 30] ^= 4;
    h.fake.objects.set(objectKey(id), { body: stored, lastModified: T0 });
    expect(await failure(engine.readObject(id))).toMatchObject({ name: 'BackupError', code: 'tamper' });
  });

  it('an object swapped for another object is a tamper error', async () => {
    const { engine, entry } = await setup();
    const a = entry('b1.yjs').objectId;
    const b = entry('b2.yjs').objectId;
    h.fake.objects.set(objectKey(a), { body: h.fake.objects.get(objectKey(b))!.body, lastModified: T0 });
    expect(await failure(engine.readObject(a))).toMatchObject({ code: 'tamper' });
    expect((await engine.readObject(b)).equals(fs.readFileSync(h.file('b2.yjs')))).toBe(true);
  });

  it('a truncated object is an error, however short', async () => {
    const { engine, entry } = await setup();
    const id = entry('b1.yjs').objectId;
    const stored = Buffer.from(h.fake.objects.get(objectKey(id))!.body);
    h.fake.objects.set(objectKey(id), { body: stored.subarray(0, stored.length - 5), lastModified: T0 });
    expect(await failure(engine.readObject(id))).toMatchObject({ code: 'tamper' });
    h.fake.objects.set(objectKey(id), { body: stored.subarray(0, 12), lastModified: T0 });
    expect(await failure(engine.readObject(id))).toMatchObject({ code: 'bad_format' });
    h.fake.objects.set(objectKey(id), { body: Buffer.alloc(0), lastModified: T0 });
    expect(await failure(engine.readObject(id))).toMatchObject({ code: 'bad_format' });
  });

  it('a wrong key cannot read objects or manifests', async () => {
    const { engine, manifestName, entry } = await setup();
    const wrong = h.engine({ config: loadWith({ TABULA_BACKUP_KEY: KEY_OTHER.toString('hex') }) });
    expect(await failure(wrong.readManifest(manifestName))).toMatchObject({ name: 'BackupError', code: 'unknown_key' });
    expect(await failure(wrong.readObject(entry('b1.yjs').objectId))).toMatchObject({ code: 'unknown_key' });
    expect(wrong.keyId).not.toBe(engine.keyId);
  });

  it('a manifest copied over another manifest is a tamper error', async () => {
    const { engine } = await setup();
    h.write('b2.yjs', docBytes('v2'));
    await h.runAt(engine, T0 + 3 * HOUR);
    const [newer, older] = (await engine.listManifests()).map((m: { name: string }) => m.name);
    const olderKey = `tabula/manifests/${older}`;
    h.fake.objects.set(olderKey, { body: h.fake.objects.get(`tabula/manifests/${newer}`)!.body, lastModified: T0 });
    expect(await failure(engine.readManifest(older))).toMatchObject({ code: 'tamper' });
    expect((await engine.readManifest(newer)).files.length).toBeGreaterThan(0);
  });

  it('a manifest with a flipped bit or cut short is an error', async () => {
    const { engine, manifestName } = await setup();
    const key = `tabula/manifests/${manifestName}`;
    const good = Buffer.from(h.fake.objects.get(key)!.body);
    const flipped = Buffer.from(good);
    flipped[good.length - 3] ^= 1;
    h.fake.objects.set(key, { body: flipped, lastModified: T0 });
    expect(await failure(engine.readManifest(manifestName))).toMatchObject({ code: 'tamper' });
    h.fake.objects.set(key, { body: good.subarray(0, 20), lastModified: T0 });
    expect(await failure(engine.readManifest(manifestName))).toMatchObject({ code: 'bad_format' });
  });

  it('an object that decrypts but is not what its name says is a content error', async () => {
    const { engine, entry } = await setup();
    const id = entry('b1.yjs').objectId;
    const keys = deriveKeys(KEY);
    h.fake.objects.set(objectKey(id), { body: seal(Buffer.from('forged by someone with the key'), `obj:${id}`, keys), lastModified: T0 });
    expect(await failure(engine.readObject(id))).toMatchObject({ code: 'content_mismatch' });
  });

  it('checks the hash a caller expects', async () => {
    const { engine, entry } = await setup();
    const id = entry('b1.yjs').objectId;
    expect((await engine.readObject(id, { expectedPlaintextHmac: id })).length).toBeGreaterThan(0);
    expect(await failure(engine.readObject(id, { expectedPlaintextHmac: 'f'.repeat(64) }))).toMatchObject({ code: 'content_mismatch' });
  });

  it('answers for an object or manifest that is not there, and for names that are not names', async () => {
    const { engine } = await setup();
    expect(await failure(engine.readObject('a'.repeat(64)))).toMatchObject({ code: 'not_found' });
    expect(await failure(engine.readManifest('20200101T000000Z.json.enc'))).toMatchObject({ code: 'not_found' });
    for (const bad of ['../manifests/x', 'x', '', 'a'.repeat(63), `${'a'.repeat(63)}/`, '../../etc/passwd']) {
      expect(await failure(engine.readObject(bad))).toMatchObject({ name: 'BackupError' });
    }
    for (const bad of ['../20261008T193000Z.json.enc', '20261008T193000Z', 'latest', '', '20261008T193000Z.json.enc/..']) {
      expect(await failure(engine.readManifest(bad))).toMatchObject({ code: 'invalid_manifest' });
    }
  });

  describe('a manifest whose contents are wrong', () => {
    const plant = async (mutate: (body: any) => void, totalsToo = true) => {
      const { engine, manifestName } = await setup();
      const keys = deriveKeys(KEY);
      const name = '20261009T000000Z.json.enc';
      const body = JSON.parse((await sealedBody(manifestName)).toString());
      mutate(body);
      if (totalsToo && Array.isArray(body.files)) body.totals = { files: body.files.length, bytes: body.files.reduce((s: number, f: any) => s + (Number.isSafeInteger(f.size) ? f.size : 0), 0) };
      h.fake.objects.set(`tabula/manifests/${name}`, { body: seal(Buffer.from(JSON.stringify(body)), `manifest:${name}`, keys), lastModified: T0 });
      return { engine, name };
    };
    const sealedBody = async (manifestName: string) => {
      const keys = createKeyring([KEY]);
      return unseal(h.fake.objects.get(`tabula/manifests/${manifestName}`)!.body, `manifest:${manifestName}`, keys).plaintext;
    };

    it.each([
      ['a parent directory', '../x'], ['a nested parent directory', 'a/../../x'], ['an absolute path', '/etc/passwd'], ['a backslash', 'a\\b'],
      ['a Windows drive', 'C:/x'], ['a dot segment', './x'], ['an empty segment', 'a//b'], ['an empty path', ''],
    ])('refuses %s as a path', async (_name, bad) => {
      const { engine, name } = await plant((body) => { body.files[0].path = bad; });
      expect(await failure(engine.readManifest(name))).toMatchObject({ name: 'BackupError', code: 'invalid_path' });
    });

    it('refuses a path that is not a string', async () => {
      const { engine, name } = await plant((body) => { body.files[0].path = 5; });
      expect(await failure(engine.readManifest(name))).toMatchObject({ code: 'invalid_path' });
    });

    it.each([
      ['the same path twice', (b: any) => { b.files[1].path = b.files[0].path; }],
      ['an object id that is not a hash', (b: any) => { b.files[0].objectId = '../objects/x'; }],
      ['an object id in capitals', (b: any) => { b.files[0].objectId = b.files[0].objectId.toUpperCase(); }],
      ['a negative size', (b: any) => { b.files[0].size = -1; }],
      ['a size that is not a number', (b: any) => { b.files[0].size = '10'; }],
      ['another version', (b: any) => { b.version = 2; }],
      ['a different key id', (b: any) => { b.keyId = '00000000'; }],
      ['an incomplete snapshot barrier', (b: any) => { b.snapshotBarrier = { snapshotSeq: 1, startedAt: T0, endedAt: T0 }; }],
      ['no file list', (b: any) => { b.files = 'all of them'; }],
      ['a file entry that is not an object', (b: any) => { b.files[0] = 'b1.yjs'; }],
    ])('refuses %s', async (_name, mutate) => {
      const { engine, name } = await plant(mutate);
      expect(await failure(engine.readManifest(name))).toMatchObject({ name: 'BackupError', code: 'invalid_manifest' });
    });

    it('refuses totals that do not add up', async () => {
      const { engine, name } = await plant((b) => { b.totals = { files: 1, bytes: 1 }; }, false);
      expect(await failure(engine.readManifest(name))).toMatchObject({ code: 'invalid_manifest' });
    });

    it('refuses text that is not JSON', async () => {
      const { engine } = await setup();
      const name = '20261009T000000Z.json.enc';
      h.fake.objects.set(`tabula/manifests/${name}`, { body: seal(Buffer.from('not json'), `manifest:${name}`, deriveKeys(KEY)), lastModified: T0 });
      expect(await failure(engine.readManifest(name))).toMatchObject({ code: 'invalid_manifest' });
    });
  });
});

describe('key rotation', () => {
  const OLD = { TABULA_BACKUP_KEY: KEY_PREVIOUS.toString('hex') };
  const NEW = (extra: Record<string, string> = {}) => ({ TABULA_BACKUP_KEY: KEY.toString('hex'), TABULA_BACKUP_KEY_PREVIOUS: KEY_PREVIOUS.toString('hex'), ...extra });

  it('writes with the new key, uploads everything again, and still reads what the old key wrote', async () => {
    h = await harness({ env: OLD });
    const before = h.engine();
    await before.runNow();
    const oldManifest = await before.readManifest((await before.listManifests())[0].name);
    const oldObjects = h.fake.keys(OBJECTS);
    const files = h.expectedPaths().length;

    h.clock.now += 3 * HOUR;
    const after = h.engine({ config: loadWith(NEW()) });
    expect(after.keyId).not.toBe(before.keyId);
    expect(await after.runNow()).toMatchObject({ ok: true, changed: true, uploaded: files });
    const [newest] = await after.listManifests();
    const manifest = await after.readManifest(newest.name);
    expect(manifest.keyId).toBe(after.keyId);
    expect(manifest.files.map((f: { objectId: string }) => f.objectId).some((id: string) => oldManifest.files.some((o: { objectId: string }) => o.objectId === id))).toBe(false);
    expect(h.fake.keys(OBJECTS)).toHaveLength(oldObjects.length + files);

    for (const f of oldManifest.files as { objectId: string; path: string }[]) {
      expect((await after.readObject(f.objectId)).length).toBeGreaterThan(0);
    }
    expect((await after.readManifest(oldManifest.name)).keyId).toBe(before.keyId);
    for (const key of h.fake.keys(OBJECTS)) {
      expect(h.fake.objects.get(key)!.body.subarray(1, 5).toString('hex')).toBeOneOf([before.keyId, after.keyId]);
    }
  });

  it('an unchanged workspace is unchanged again after the first run with the new key', async () => {
    h = await harness({ env: OLD });
    await h.engine().runNow();
    h.clock.now += 3 * HOUR;
    const after = h.engine({ config: loadWith(NEW()) });
    await after.runNow();
    h.clock.now += 3 * HOUR;
    expect(await after.runNow()).toMatchObject({ ok: true, changed: false });
  });

  it('old objects go once the manifests of the old key age out', async () => {
    const retention = { TABULA_BACKUP_KEEP_HOURLY_HOURS: '0', TABULA_BACKUP_KEEP_DAILY_DAYS: '2' };
    h = await harness({ env: { ...OLD, ...retention } });
    await h.engine().runNow();
    const oldObjects = h.fake.keys(OBJECTS);
    h.clock.now += 25 * HOUR;
    const after = h.engine({ config: loadWith(NEW(retention)) });
    await after.runNow();
    expect(await after.listManifests()).toHaveLength(2);
    for (const key of oldObjects) expect(h.fake.objects.has(key)).toBe(true);
    h.clock.now += 3 * DAY;
    expect(await after.runNow()).toMatchObject({ ok: true, changed: false });
    expect(await after.listManifests()).toHaveLength(1);
    for (const key of oldObjects) expect(h.fake.objects.has(key)).toBe(false);
    expect(h.fake.keys(OBJECTS)).toHaveLength(h.expectedPaths().length);
  });

  it('without the old key the old manifests are unknown-key errors and nothing is deleted behind them', async () => {
    h = await harness({ env: OLD });
    const before = h.engine();
    await before.runNow();
    const oldName = (await before.listManifests())[0].name;
    h.clock.now += 3 * HOUR;
    const forgetful = h.engine({ config: loadWith({ TABULA_BACKUP_KEY: KEY.toString('hex') }) });
    await forgetful.runNow();
    await expect(forgetful.readManifest(oldName)).rejects.toMatchObject({ code: 'unknown_key' });
    const orphaned = `tabula/objects/${'ab'.repeat(32)}`;
    h.fake.objects.set(orphaned, { body: Buffer.from('x'), lastModified: T0 - 5 * DAY });
    h.clock.now += 3 * HOUR;
    h.write('b2.yjs', docBytes('changed again'));
    expect(await forgetful.runNow()).toMatchObject({ ok: true });
    expect(forgetful.status().prune).toMatchObject({ gcSkipped: 'unreadable_manifest' });
    expect(h.fake.objects.has(orphaned)).toBe(true);
  });

  it('a newest manifest of a key that is gone is treated as no previous backup', async () => {
    h = await harness({ env: OLD });
    await h.engine().runNow();
    const files = h.expectedPaths().length;
    h.clock.now += 3 * HOUR;
    const other = h.engine({ config: loadWith({ TABULA_BACKUP_KEY: KEY.toString('hex') }) });
    expect(await other.runNow()).toMatchObject({ ok: true, changed: true, uploaded: files });
    expect(h.logs.join('\n')).toContain('could not be read (unknown_key); everything is uploaded again');
  });
});

describe('a damaged previous manifest', () => {
  it('is treated as no previous backup: everything is uploaded again and a new manifest follows', async () => {
    h = await harness();
    const engine = h.engine();
    await engine.runNow();
    const [name] = (await engine.listManifests()).map((m: { name: string }) => m.name);
    const key = `tabula/manifests/${name}`;
    const damaged = Buffer.from(h.fake.objects.get(key)!.body);
    damaged[30] ^= 1;
    h.fake.objects.set(key, { body: damaged, lastModified: T0 });
    const files = h.expectedPaths().length;
    const before = objectPuts();
    h.clock.now += 3 * HOUR;
    expect(await h.engine().runNow()).toMatchObject({ ok: true, changed: true, uploaded: files });
    expect(objectPuts() - before).toBe(files);
    expect(h.logs.join('\n')).toContain('could not be read (tamper)');
    expect((await engine.listManifests()).length).toBe(2);
    await engine.readManifest((await engine.listManifests())[0].name);
  });

  it('is not taken for a reason to upload everything when the bucket is merely unreachable', async () => {
    h = await harness();
    const engine = h.engine();
    await engine.runNow();
    const puts = objectPuts();
    h.clock.now += HOUR;
    h.fake.rules.push({ method: 'GET', key: /^tabula\/manifests\/2/, status: 503, times: 99 });
    expect(await h.engine().runNow()).toMatchObject({ ok: false });
    expect(objectPuts()).toBe(puts);
  });
});

describe('runs never overlap', () => {
  it('a second run while one is in progress is skipped', async () => {
    h = await harness();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const real = globalThis.fetch;
    const engine = h.engine({ fetch: async (url: string, init: RequestInit) => { await gate; return real(url, init); } });
    const first = engine.runNow();
    expect(await engine.runNow()).toEqual({ ok: false, skipped: 'running' });
    expect(await engine.runNow()).toEqual({ ok: false, skipped: 'running' });
    release();
    expect(await first).toMatchObject({ ok: true });
    expect(manifestPuts()).toBe(1);
    expect(await engine.runNow()).toMatchObject({ ok: true, changed: false });
  });
});

function loadWith(extra: Record<string, string>) {
  return loadBackupConfig({ ...envFor(h.fake), ...extra }, () => {});
}
