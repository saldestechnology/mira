import { migrationSql } from '../server/schema.mjs';
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { MIGRATIONS } from '../server/directory.mjs';
import { objectIdOf, deriveKeys, seal } from '../server/backup.mjs';
import { RestoreError } from '../server/restore.mjs';
import { HOUR, KEY, MIN, T0, VERSION_A, docBytes, harness, type Harness } from './backup-harness';
import { audits, backedUp, backupNow, becomeB, CONFIRM, databaseOf, filesOf, filled, forge, ownerOf, rig, seedA, setting, sqliteBytes } from './restore-harness';

// docs/backups.md, Restoring, "Checking the backup before anything is touched". Every way a backup can be wrong must
// end in a refusal that leaves the live data exactly as it was.

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function scenario() {
  h = await harness({ accounts: true });
  seedA(h);
  const r = rig(h);
  const a = await backupNow(r.backup);
  const stateA = await backedUp(h, r.backup, a.manifest as string);
  const database = await databaseOf(h);
  h.clock.now += HOUR;
  becomeB(h);
  const stateB = filesOf(h.dir);
  h.clock.now += MIN;
  return { ...r, manifest: a.manifest as string, stateA, stateB, database, actor: ownerOf(h) };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;

/** A manifest of A's files with `change` applied to the list of files before it is forged. */
function forgeFrom(s: Scenario, change: (files: { path: string; data: Buffer }[]) => { path: string; data: Buffer }[], options: Parameters<typeof forge>[2] = {}) {
  const files = [{ path: 'directory.sqlite', data: s.database }, ...[...s.stateA].map(([p, data]) => ({ path: p, data }))];
  return forge(h, change(files), { at: T0 + 10 * HOUR, ...options });
}

const code = async (promise: Promise<unknown>) => {
  const err = await promise.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(RestoreError);
  return err as RestoreError;
};

/** Nothing live changed, nothing is left behind, and the failure is on record. */
function expectRefused(s: Scenario, error: string, manifest: string) {
  const now = filesOf(h.dir);
  expect(now.size).toBe(s.stateB.size);
  for (const [file, bytes] of s.stateB) expect(now.get(file)!.equals(bytes), `${file}`).toBe(true);
  expect(setting(h.directory!, 'fixture')).toBe('B');
  expect(h.directory!.listActiveSessions().length).toBeGreaterThan(0);
  expect(fs.readdirSync(h.dir).filter((n) => n.startsWith('.restore-') || n.startsWith('.pre-restore-') || n.startsWith('restore.json'))).toEqual([]);
  expect(s.exits).toEqual([]);
  expect(JSON.parse(setting(h.directory!, 'restore.status')!)).toMatchObject({ kind: 'workspace', result: 'failed', error, manifest });
  expect(audits(h.directory!, 10).find((r) => r.action === 'restore.failed')).toMatchObject({ detail: { kind: 'workspace', manifest, error } });
}

const go = (s: Scenario, manifest: string) => s.restore.restoreWorkspace({ manifest, confirm: CONFIRM, actor: s.actor });

describe('a backup that has been tampered with is refused', () => {
  it('a flipped bit in a file', async () => {
    const s = await scenario();
    const forged = forgeFrom(s, (f) => f);
    const target = forged.entries.find((e) => e.path === 'b1.yjs')!;
    const stored = h.fake.objects.get(`tabula/objects/${target.objectId}`)!;
    stored.body[stored.body.length - 20] ^= 1;
    const err = await code(go(s, forged.name));
    expect(err.code).toBe('tamper');
    expect(err.message).toMatch(/\(file \d+ of \d+\)$/);
    expectRefused(s, 'tamper', forged.name);
  });

  it('an object swapped for another one that is valid under its own name', async () => {
    const s = await scenario();
    const forged = forgeFrom(s, (f) => f);
    const one = forged.entries.find((e) => e.path === 'b1.yjs')!;
    const two = forged.entries.find((e) => e.path === 'b2.yjs')!;
    h.fake.objects.set(`tabula/objects/${one.objectId}`, { ...h.fake.objects.get(`tabula/objects/${two.objectId}`)! });
    expect((await code(go(s, forged.name))).code).toBe('tamper');
    expectRefused(s, 'tamper', forged.name);
  });

  it('an object that decrypts but is not what its name says', async () => {
    const s = await scenario();
    const keys = deriveKeys(KEY);
    const liar = Buffer.from('some other contents');
    const forged = forgeFrom(s, (f) => f);
    const target = forged.entries.find((e) => e.path === 'b2.yjs')!;
    h.fake.put(`tabula/objects/${target.objectId}`, seal(liar, `obj:${target.objectId}`, keys));
    expect(objectIdOf(liar, keys)).not.toBe(target.objectId);
    expect((await code(go(s, forged.name))).code).toBe('content_mismatch');
    expectRefused(s, 'content_mismatch', forged.name);
  });

  it('a file whose size is not the size in the manifest', async () => {
    const s = await scenario();
    const forged = forgeFrom(s, (f) => f, {
      damage: (body) => {
        const entry = body.files.find((e: { path: string }) => e.path === 'b1.yjs');
        entry.size += 1;
        body.totals.bytes += 1;
      },
    });
    expect((await code(go(s, forged.name))).code).toBe('size_mismatch');
    expectRefused(s, 'size_mismatch', forged.name);
  });

  it('a file that is missing from the bucket', async () => {
    const s = await scenario();
    const forged = forgeFrom(s, (f) => f);
    h.fake.objects.delete(`tabula/objects/${forged.entries.find((e) => e.path === 'b2.yjs')!.objectId}`);
    expect((await code(go(s, forged.name))).code).toBe('backup_incomplete');
    expectRefused(s, 'backup_incomplete', forged.name);
  });

  it('a manifest that was damaged, or sealed with another key', async () => {
    const s = await scenario();
    const damaged = forgeFrom(s, (f) => f, { at: T0 + 11 * HOUR });
    const stored = h.fake.objects.get(`tabula/manifests/${damaged.name}`)!;
    stored.body[stored.body.length - 5] ^= 1;
    expect((await code(go(s, damaged.name))).code).toBe('tamper');
    expectRefused(s, 'tamper', damaged.name);

    const stranger = forgeFrom(s, (f) => f, { at: T0 + 12 * HOUR, key: Buffer.alloc(32, 5) });
    s.restore.status();
    h.clock.now += 11 * MIN;
    expect((await code(go(s, stranger.name))).code).toBe('unknown_key');
    expect(setting(h.directory!, 'fixture')).toBe('B');
  });

  it('a manifest copied over another manifest (the name is part of what is sealed)', async () => {
    const s = await scenario();
    const one = forgeFrom(s, (f) => f, { at: T0 + 13 * HOUR });
    const two = forgeFrom(s, (f) => f, { at: T0 + 14 * HOUR });
    h.fake.objects.set(`tabula/manifests/${two.name}`, { ...h.fake.objects.get(`tabula/manifests/${one.name}`)! });
    expect((await code(go(s, two.name))).code).toBe('tamper');
    expectRefused(s, 'tamper', two.name);
  });
});

describe('a manifest that lists files it should not is refused', () => {
  const bad: [string, string, string][] = [
    ['a path that climbs out of the directory', '../evil.yjs', 'invalid_path'],
    ['a path that climbs out of history', 'history/../../evil.yjs', 'invalid_path'],
    ['an absolute path', '/etc/passwd', 'invalid_path'],
    ['a path with a backslash', 'history\\b1\\index.json', 'invalid_path'],
    ['a drive letter', 'C:/evil.yjs', 'invalid_path'],
    ['a file Tabula does not write', 'notes.txt', 'unexpected_file'],
    ['the database side files', 'directory.sqlite-wal', 'unexpected_file'],
    ['a temporary file', 'b1.yjs.tmp', 'unexpected_file'],
    ['a folder inside a folder', 'deep/dir/b1.yjs', 'unexpected_file'],
    ['a history file with a bad version name', 'history/b1/x.yjs.gz', 'unexpected_file'],
    ['a history folder with a bad board name', 'history/not a board/index.json', 'unexpected_file'],
    ['a hidden file', '.restore-0123456789abcdef', 'unexpected_file'],
    ['a second database', 'history/b1/directory.sqlite', 'unexpected_file'],
  ];

  it.each(bad)('%s', async (_what, rel, error) => {
    const s = await scenario();
    const forged = forgeFrom(s, (f) => [...f, { path: rel, data: Buffer.from('evil') }]);
    const err = await code(go(s, forged.name));
    expect(err.code).toBe(error);
    expect(err.message).not.toContain(rel.slice(0, 6));
    expectRefused(s, error, forged.name);
  });

  it('the same file twice, also under another spelling of the case', async () => {
    const s = await scenario();
    const twice = forgeFrom(s, (f) => [...f, f.find((x) => x.path === 'b1.yjs')!]);
    expect((await code(go(s, twice.name))).code).toBe('invalid_manifest');
    expectRefused(s, 'invalid_manifest', twice.name);
    h.clock.now += 11 * MIN;
    const cased = forgeFrom(s, (f) => [...f, { path: 'B1.yjs', data: docBytes('other case') }], { at: T0 + 20 * HOUR });
    expect((await code(go(s, cased.name))).code).toBe('duplicate_path');
    expect(setting(h.directory!, 'fixture')).toBe('B');
  });

  it('leaves the whole tree exactly as it was, and nothing next to it', async () => {
    const s = await scenario();
    const tree = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true, recursive: true })
        .filter((e) => !e.name.startsWith('directory.sqlite'))
        .map((e) => `${e.parentPath.slice(dir.length)}/${e.name}`)
        .sort();
    const before = tree(h.dir);
    // The places a forged path could escape to. The parent is shared with other tests running at the same time, so the test
    // looks for the forged file itself, not for a change in how many entries the parent has.
    const escapes = [path.join(path.dirname(h.dir), 'evil.yjs'), path.join(path.dirname(path.dirname(h.dir)), 'evil.yjs'), '/tmp/evil.yjs'];
    const existedBefore = escapes.map((file) => fs.existsSync(file));
    for (const [i, rel] of ['../evil.yjs', '../../evil.yjs', 'history/../../evil.yjs', '/tmp/evil.yjs'].entries()) {
      h.clock.now += 11 * MIN;
      const forged = forgeFrom(s, (f) => [...f, { path: rel, data: Buffer.from('evil') }], { at: T0 + (30 + i) * HOUR });
      await code(go(s, forged.name));
    }
    expect(tree(h.dir)).toEqual(before);
    expect(escapes.map((file) => fs.existsSync(file))).toEqual(existedBefore);
  });
});

describe('a database that cannot be used is refused', () => {
  const withDatabase = async (s: Scenario, data: Buffer, at: number) => forgeFrom(s, (f) => f.map((x) => (x.path === 'directory.sqlite' ? { ...x, data } : x)), { at });

  it('a schema written by a newer Tabula', async () => {
    const s = await scenario();
    const newer = await sqliteBytes((db) => {
      for (const entry of MIGRATIONS) db.exec(migrationSql(entry));
      db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    });
    const forged = await withDatabase(s, newer, T0 + 10 * HOUR);
    const err = await code(go(s, forged.name));
    expect(err.code).toBe('schema_too_new');
    expect(err.message).toContain(`schema ${MIGRATIONS.length + 1}`);
    expectRefused(s, 'schema_too_new', forged.name);
  });

  it('a database that fails its integrity check', async () => {
    const s = await scenario();
    const damaged = Buffer.from(s.database);
    // wipe pages in the middle of the file: it still opens, but its content is gone
    damaged.fill(0xff, 4096 * 2, 4096 * 6);
    const forged = await withDatabase(s, damaged, T0 + 10 * HOUR);
    expect((await code(go(s, forged.name))).code).toBe('integrity_check_failed');
    expectRefused(s, 'integrity_check_failed', forged.name);
  });

  it('a truncated database and a file that is not a database', async () => {
    const s = await scenario();
    for (const [i, data] of [s.database.subarray(0, 5000), Buffer.from('this is not sqlite at all, not even close'), Buffer.alloc(0)].entries()) {
      h.clock.now += 11 * MIN;
      const forged = await withDatabase(s, Buffer.from(data), T0 + (10 + i) * HOUR);
      const err = await code(go(s, forged.name));
      expect(['integrity_check_failed', 'invalid_backup']).toContain(err.code);
      expect(fs.readdirSync(h.dir).filter((n) => n.startsWith('.restore-'))).toEqual([]);
    }
    expect(setting(h.directory!, 'fixture')).toBe('B');
  });

  it('a database with no schema version', async () => {
    const s = await scenario();
    const empty = await sqliteBytes((db) => db.exec('CREATE TABLE t (a)'));
    const forged = await withDatabase(s, empty, T0 + 10 * HOUR);
    expect((await code(go(s, forged.name))).code).toBe('invalid_backup');
    expectRefused(s, 'invalid_backup', forged.name);
  });

  it('a database whose owners are all disabled, which nobody could sign in to', async () => {
    const s = await scenario();
    const locked = await sqliteBytes((db) => {
      for (const entry of MIGRATIONS) db.exec(migrationSql(entry));
      db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
      db.exec("INSERT INTO users (id, email, name, role, disabled, created_at) VALUES ('u1', 'owner@example.com', 'Owner', 'owner', 1, 1)");
    });
    const forged = await withDatabase(s, locked, T0 + 10 * HOUR);
    expect((await code(go(s, forged.name))).code).toBe('no_active_owner');
    expectRefused(s, 'no_active_owner', forged.name);
  });

  it('an older schema is fine and is migrated before the swap', async () => {
    const s = await scenario();
    const older = await sqliteBytes((db) => {
      for (let i = 0; i < 4; i++) db.exec(migrationSql(MIGRATIONS[i]));
      db.exec('PRAGMA user_version = 4');
      db.exec("INSERT INTO users (id, email, name, role, disabled, created_at) VALUES ('u1', 'owner@example.com', 'Owner', 'owner', 0, 1)");
    });
    const forged = await withDatabase(s, older, T0 + 10 * HOUR);
    await go(s, forged.name);
    expect(await s.exited).toBe(75);
    const { openDirectory } = await import('../server/directory.mjs');
    const restored = openDirectory(`${h.dir}/directory.sqlite`);
    try {
      expect(restored.getUserByEmail('owner@example.com')).not.toBeNull();
    } finally {
      restored.close();
    }
  });
});

describe('documents that cannot be read are refused', () => {
  const bad: [string, string, (f: { path: string; data: Buffer }[]) => { path: string; data: Buffer }[]][] = [
    ['a room that is not a Yjs document', 'invalid_backup', (f) => f.map((x) => (x.path === 'b2.yjs' ? { ...x, data: Buffer.from('not a yjs document at all') } : x))],
    ['an empty room file', 'invalid_backup', (f) => f.map((x) => (x.path === 'b2.yjs' ? { ...x, data: Buffer.alloc(0) } : x))],
    ['a comments room that is broken', 'invalid_backup', (f) => f.map((x) => (x.path === 'b1~comments.yjs' ? { ...x, data: Buffer.from('xxxxxxxx') } : x))],
    ['a history index that is not JSON', 'invalid_backup', (f) => f.map((x) => (x.path === 'history/b1/index.json' ? { ...x, data: Buffer.from('{nope') } : x))],
    ['a history index of the wrong shape', 'invalid_backup', (f) => f.map((x) => (x.path === 'history/b1/index.json' ? { ...x, data: Buffer.from('{"v":2,"versions":[]}') } : x))],
    ['a history version that is not gzip', 'invalid_backup', (f) => f.map((x) => (x.path === `history/b1/${VERSION_A}.yjs.gz` ? { ...x, data: Buffer.from('plain text') } : x))],
    ['a history version that is gzip of something else', 'invalid_backup', (f) => f.map((x) => (x.path === `history/b1/${VERSION_A}.yjs.gz` ? { ...x, data: zlib.gzipSync('not yjs') } : x))],
  ];
  it.each(bad)('%s', async (_what, error, change) => {
    const s = await scenario();
    const forged = forgeFrom(s, change);
    const err = await code(go(s, forged.name));
    expect(err.code).toBe(error);
    expect(err.message).toMatch(/\(file \d+ of \d+\)$/);
    expectRefused(s, error, forged.name);
  });
});

describe('disk space', () => {
  it('refuses before downloading anything when there is not room for two copies, saying how much is needed', async () => {
    const s = await scenario();
    const tight = rig(h, { statfs: async () => ({ bsize: 4096, blocks: 1000, bavail: 100 }) });
    const gets = h.fake.count('GET', /\/objects\//);
    const err = await code(tight.restore.restoreWorkspace({ manifest: s.manifest, confirm: CONFIRM, actor: s.actor }));
    expect(err.code).toBe('not_enough_space');
    expect(err.extra.free).toBe(4096 * 100);
    expect(err.extra.needed).toBeGreaterThan(64 * 1024 * 1024);
    expect(h.fake.count('GET', /\/objects\//)).toBe(gets);
    expect(fs.readdirSync(h.dir).filter((n) => n.startsWith('.restore-'))).toEqual([]);
    expect(tight.exits).toEqual([]);
    expect(setting(h.directory!, 'fixture')).toBe('B');
    expect(filesOf(h.dir).size).toBe(s.stateB.size);
  });

  it('counts twice the size of the backup plus a margin', async () => {
    const s = await scenario();
    const total = (await s.backup.readManifest(s.manifest)).totals.bytes;
    const needed = 2 * total + 64 * 1024 * 1024;
    const exactly = rig(h, { statfs: async () => ({ bsize: 1, blocks: needed * 4, bavail: needed - 1 }) });
    const err = await code(exactly.restore.restoreWorkspace({ manifest: s.manifest, confirm: CONFIRM, actor: s.actor }));
    expect(err.extra).toEqual({ needed, free: needed - 1 });
    h.clock.now += 11 * MIN;
    const enough = rig(h, { statfs: async () => ({ bsize: 1, blocks: needed * 4, bavail: needed }) });
    await enough.restore.restoreWorkspace({ manifest: s.manifest, confirm: CONFIRM, actor: s.actor });
    expect(await enough.exited).toBe(75);
  });

  it('refuses when the free space cannot be told', async () => {
    const s = await scenario();
    for (const statfs of [async () => Promise.reject(new Error('no statfs here')), async () => ({ bsize: 0, blocks: 0, bavail: 0 }), async () => ({ bsize: 'x', blocks: 1, bavail: 1 })]) {
      h.clock.now += 11 * MIN;
      const r = rig(h, { statfs });
      expect((await code(r.restore.restoreWorkspace({ manifest: s.manifest, confirm: CONFIRM, actor: s.actor }))).code).toBe('space_unknown');
      expect(r.exits).toEqual([]);
    }
    expect(setting(h.directory!, 'fixture')).toBe('B');
  });

  it('keeps the old data only until the next backup when the disk is more than 80% full after the download', async () => {
    const s = await scenario();
    const full = rig(h, { statfs: filled(0.85) });
    const result = await full.restore.restoreWorkspace({ manifest: s.manifest, confirm: CONFIRM, actor: s.actor });
    expect(result.keepOldFor).toBe('until the next successful backup (at least 24 h)');
    expect(result.reason).toMatch(/85% full/);
    await full.exited;
    const { openDirectory } = await import('../server/directory.mjs');
    const restored = openDirectory(`${h.dir}/directory.sqlite`);
    try {
      const keep = JSON.parse(setting(restored, 'restore.keep')!);
      expect(Object.values(keep)).toEqual([{ at: T0 + HOUR + MIN, mode: 'next-backup' }]);
      expect(JSON.parse(setting(restored, 'restore.status')!).keepOldFor).toBe('until the next successful backup (at least 24 h)');
    } finally {
      restored.close();
    }
  });
});
