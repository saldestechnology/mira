import { migrationSql } from '../server/schema.mjs';
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from '../server/directory.mjs';
import { RestoreError } from '../server/restore.mjs';
import { DAY, HOUR, MIN, T0, docBytes, harness, type Harness } from './backup-harness';
import { audits, backedUp, backupNow, becomeB, CONFIRM, databaseOf, filesOf, filled, forge, ownerOf, raw, reopen, rig, seedA, setting, sqliteBytes } from './restore-harness';

// docs/backups.md, Restoring. The whole-workspace restore against the fake S3 with the real backup engine.

let h: Harness;

// Step timings, printed only for a test that had a slow step (2 s or more), so a slow CI runner shows where the time went
// (the first Windows run that timed out had no way of saying). Nothing here changes what a test checks.
const laps: { label: string; ms: number }[] = [];
async function lap<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
  const started = performance.now();
  try {
    return await fn();
  } finally {
    laps.push({ label, ms: Math.round(performance.now() - started) });
  }
}

afterEach(async (context) => {
  const slow = laps.some((l) => l.ms >= 2000);
  const closing = performance.now();
  await h?.close();
  laps.push({ label: 'close the harness', ms: Math.round(performance.now() - closing) });
  if (slow || laps.some((l) => l.ms >= 2000)) console.error(`[restore-engine timing] ${context.task.name}: ${laps.map((l) => `${l.label} ${l.ms}ms`).join(', ')}`);
  laps.length = 0;
});

const expectCode = async (promise: Promise<unknown>, code: string) => {
  const err = await promise.then(
    () => null,
    (e) => e,
  );
  expect(err, `expected a RestoreError ${code}`).toBeInstanceOf(RestoreError);
  expect((err as RestoreError).code).toBe(code);
  return err as RestoreError;
};

const oldDirs = (dir: string) => fs.readdirSync(dir).filter((n) => /^\.pre-restore-\d+$/.test(n));
const stagingDirs = (dir: string) => fs.readdirSync(dir).filter((n) => n.startsWith('.restore-'));

/** State A backed up, state B live, the restore engine ready. */
async function scenario() {
  h = await lap('harness', () => harness({ accounts: true }));
  await lap('seed state A', () => seedA(h));
  const r = rig(h);
  const a = await lap('first backup', () => backupNow(r.backup));
  expect(a.ok).toBe(true);
  const stateA = await lap('read state A back', () => backedUp(h, r.backup, a.manifest as string));
  h.clock.now += HOUR;
  await lap('become state B', () => becomeB(h));
  const stateB = filesOf(h.dir);
  h.clock.now += MIN;
  return { ...r, manifest: a.manifest as string, stateA, stateB, actor: ownerOf(h) };
}

describe('listing and previewing backups', () => {
  it('lists the manifests newest first with what is in them, and which are protected', async () => {
    h = await harness({ accounts: true });
    seedA(h);
    const r = rig(h);
    const first = await backupNow(r.backup);
    h.clock.now += HOUR;
    becomeB(h);
    const second = await backupNow(r.backup);
    h.directory!.setSetting('backup.protected', JSON.stringify({ [first.manifest!]: h.clock.now + DAY }));

    const { backups, truncated } = await r.restore.listBackups();
    expect(truncated).toBe(false);
    expect(backups.map((b: { name: string }) => b.name)).toEqual([second.manifest, first.manifest]);
    expect(backups[0]).toMatchObject({ readable: true, protected: false, protectedUntil: null, createdAt: T0 + HOUR, keyId: r.backup.keyId });
    expect(backups[0].files).toBeGreaterThan(5);
    expect(backups[0].bytes).toBeGreaterThan(0);
    expect(backups[1]).toMatchObject({ protected: true, protectedUntil: h.clock.now + DAY, createdAt: T0 });
  });

  it('lists a backup it cannot read, with the reason, and carries on', async () => {
    h = await harness({ accounts: true });
    seedA(h);
    const r = rig(h);
    const good = await backupNow(r.backup);
    const stranger = forge(h, [{ path: 'directory.sqlite', data: Buffer.from('x') }], { at: T0 + 2 * HOUR, key: Buffer.alloc(32, 7) });
    const { backups } = await r.restore.listBackups();
    expect(backups.map((b: { name: string }) => b.name)).toEqual([stranger.name, good.manifest]);
    expect(backups[0]).toMatchObject({ readable: false, error: 'unknown_key' });
    expect(backups[1].readable).toBe(true);
    expect(JSON.stringify(backups)).not.toContain('objectId');
  });

  it('previews a backup: what is in it, the confirmation word, how long the old data is kept and whether there is room', async () => {
    const s = await scenario();
    const preview = await s.restore.previewManifest(s.manifest);
    expect(preview).toMatchObject({
      name: s.manifest, createdAt: T0, keyId: s.backup.keyId, boards: 2, protected: false, confirmWord: CONFIRM,
      keepOldFor: '7 days', space: { enough: true },
    });
    expect(preview.files).toBe(s.stateA.size + 1);
    expect(preview.reason).toMatch(/room/);
    expect(preview.space.needed).toBeGreaterThan(64 * 1024 * 1024);
  });

  it('says in the preview that the old data is kept only until the next backup when the disk would be over 80% full', async () => {
    const s = await scenario();
    const tight = rig(h, { statfs: filled(0.85) });
    const preview = await tight.restore.previewManifest(s.manifest);
    expect(preview.keepOldFor).toBe('until the next successful backup (at least 24 h)');
    expect(preview.reason).toMatch(/85% full/);
    const edge = await rig(h, { statfs: filled(0.79) }).restore.previewManifest(s.manifest);
    expect(edge.keepOldFor).toBe('7 days');
  });

  it('refuses a name that is not a manifest, a manifest that is not there, and a backup sealed with another key', async () => {
    const s = await scenario();
    await expectCode(s.restore.previewManifest('../../etc/passwd'), 'bad_request');
    await expectCode(s.restore.previewManifest('20200101T000000Z.json.enc'), 'manifest_not_found');
    const stranger = forge(h, [{ path: 'directory.sqlite', data: Buffer.from('x') }], { at: T0 + 3 * HOUR, key: Buffer.alloc(32, 9) });
    const err = await expectCode(s.restore.previewManifest(stranger.name), 'unknown_key');
    expect(err.message).toContain('TABULA_BACKUP_KEY_PREVIOUS');
  });

  it('refuses a backup without a workspace database (made without accounts)', async () => {
    const s = await scenario();
    const open = forge(h, [{ path: 'b1.yjs', data: docBytes('x') }], { at: T0 + 4 * HOUR });
    const err = await expectCode(s.restore.previewManifest(open.name), 'no_directory');
    expect(err.message).toMatch(/without accounts/);
  });
});

describe('whole restore credential invalidation', () => {
  it('does not revive backed-up join codes or guest cookies revoked after the backup', async () => {
    h = await harness({ accounts: true });
    seedA(h);
    const directory = h.directory!;
    const owner = ownerOf(h);
    const code = directory.createJoinCode({
      boardId: 'b1', createdBy: owner.id, codeHash: 'c'.repeat(64), role: 'editor',
      createdAt: h.clock.now, expiresAt: h.clock.now + DAY, maxUses: 10,
    })!;
    const guestTokenHash = 'd'.repeat(64);
    directory.createGuestSession(code.id, { tokenHash: guestTokenHash, name: 'Old guest', now: h.clock.now });
    const engines = rig(h);
    const saved = await backupNow(engines.backup);
    expect(saved.ok).toBe(true);

    h.clock.now += HOUR;
    becomeB(h);
    directory.revokeJoinCode(code.id, h.clock.now);
    expect(directory.getGuestSession(guestTokenHash, h.clock.now)).toBeNull();
    await engines.restore.restoreWorkspace({ manifest: saved.manifest, confirm: CONFIRM, actor: owner });

    const restored = reopen(h);
    try {
      expect(restored.getGuestSession(guestTokenHash, h.clock.now)).toBeNull();
      expect(restored.getJoinCode(code.id)?.revokedAt).not.toBeNull();
      expect(await raw(h.dir, 'SELECT COUNT(*) AS n FROM guest_sessions')).toEqual([{ n: 0 }]);
    } finally {
      restored.close();
    }
  });
});

describe('a whole restore', () => {
  it('restores a legacy manifest with no barrier fields and logs that it is legacy', async () => {
    h = await harness({ accounts: true });
    seedA(h);
    const database = await databaseOf(h);
    const legacy = forge(h, [
      { path: 'directory.sqlite', data: database },
      ...[...filesOf(h.dir)].filter(([file]) => /^[^/]+\.yjs$/.test(file)).map(([file, data]) => ({ path: file, data })),
    ], { at: T0 + HOUR });
    const r = rig(h);

    const result = await r.restore.restoreWorkspace({ manifest: legacy.name, confirm: CONFIRM, actor: ownerOf(h) });
    expect(result).toMatchObject({ ok: true, restarting: true });
    expect(await r.exited).toBe(75);
    expect(h.logs.some((line: string) => String(line).includes(`legacy manifest ${legacy.name} has no snapshot barrier record; accepting it`))).toBe(true);
    const restored = reopen(h);
    try {
      expect(setting(restored, 'fixture')).toBe('A');
      expect(restored.getBoard('b1')).toMatchObject({ title: 'Roadmap' });
    } finally {
      restored.close();
    }
  });

  it('puts the backed up state back, ends every session, keeps the old data aside and leaves with code 75', async () => {
    const s = await scenario();
    expect(ownerOf(h)).toBeTruthy();
    expect(h.directory!.listActiveSessions().length).toBeGreaterThan(0);

    const result = await s.restore.restoreWorkspace({ manifest: s.manifest, confirm: CONFIRM, actor: s.actor });
    expect(result).toMatchObject({ ok: true, restarting: true, keepOldFor: '7 days' });
    expect(await s.exited).toBe(75);
    expect(s.exits).toEqual([75]);

    // the files are the backed up files, byte for byte, and nothing of B is left
    const now = filesOf(h.dir);
    expect([...now.keys()].sort()).toEqual([...s.stateA.keys()].sort());
    for (const [file, bytes] of s.stateA) expect(now.get(file)!.equals(bytes), `${file}`).toBe(true);
    expect(fs.existsSync(path.join(h.dir, 'b3.yjs'))).toBe(false);
    expect(fs.existsSync(path.join(h.dir, 'history/b3'))).toBe(false);

    // the database has the rows of A and nobody is signed in
    const restored = reopen(h);
    try {
      expect(setting(restored, 'fixture')).toBe('A');
      expect(restored.getBoard('b1')).toMatchObject({ title: 'Roadmap' });
      expect(restored.getBoard('b3')).toBeNull();
      expect(restored.listUsers().map((u) => u.email).sort()).toEqual(['member@example.com', 'owner@example.com']);
      expect(restored.listActiveSessions()).toEqual([]);
    } finally {
      restored.close();
    }

    // the old state is in .pre-restore-<ms>, whole
    const [old] = oldDirs(h.dir);
    expect(oldDirs(h.dir)).toHaveLength(1);
    expect(old).toBe(`.pre-restore-${T0 + HOUR + MIN}`);
    for (const [file, bytes] of s.stateB) expect(fs.readFileSync(path.join(h.dir, old, file)).equals(bytes), `${file}`).toBe(true);
    expect(fs.existsSync(path.join(h.dir, old, 'directory.sqlite'))).toBe(true);

    // no staging directory, and the journal says it is done
    expect(stagingDirs(h.dir)).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(h.dir, 'restore.json'), 'utf8'))).toMatchObject({ phase: 'done', manifest: s.manifest, oldDir: old });
  });

  it('writes the restore into the restored database: audit row, status, protection, retention, hosted limits of the live workspace', async () => {
    const s = await scenario();
    const safety = await (async () => {
      await s.restore.restoreWorkspace({ manifest: s.manifest, confirm: CONFIRM, actor: s.actor });
      return JSON.parse(fs.readFileSync(path.join(h.dir, 'restore.json'), 'utf8'));
    })();
    const restored = reopen(h);
    try {
      const rows = audits(restored, 500).filter((r) => r.action.startsWith('restore.') || r.action.startsWith('backup.'));
      expect(rows.map((r) => r.action)).toEqual(['restore.done']);
      expect(rows[0]).toMatchObject({ actorId: s.actor.id, detail: { kind: 'workspace', manifest: s.manifest, sessionsRemoved: 2, keepOldFor: '7 days' } });
      expect(rows[0].detail.files).toBeGreaterThan(5);

      expect(JSON.parse(setting(restored, 'restore.status')!)).toMatchObject({ kind: 'workspace', result: 'done', manifest: s.manifest, at: T0 + HOUR + MIN });
      expect(setting(restored, 'backup.status')).toBeNull();
      // the safety backup and the backup that was restored are protected for 7 days; the protection survived the swap
      const kept = JSON.parse(setting(restored, 'backup.protected')!);
      const protectedNames = Object.keys(kept);
      const safetyName = protectedNames.find((n) => n !== s.manifest)!;
      expect(protectedNames.sort()).toEqual([s.manifest, safetyName].sort());
      expect(safetyName).toBeTruthy();
      expect(kept[safetyName]).toBe(T0 + HOUR + MIN + 7 * DAY);
      expect(kept[s.manifest]).toBe(T0 + HOUR + MIN + 7 * DAY);
      expect(JSON.parse(setting(restored, 'restore.keep')!)).toEqual({ [safety.oldDir]: { at: T0 + HOUR + MIN, mode: 'days' } });
      // the hosted workspace's limits are the live ones (B), not the ones in the backup
      expect(JSON.parse(setting(restored, 'cloud.limits')!)).toMatchObject({ seatLimit: 9, readOnly: false, banner: 'from B' });
    } finally {
      restored.close();
    }
  });

  it('revokes the access tokens and invite links the backup held, so nothing revoked since the backup works again', async () => {
    const s = await scenario();
    await s.restore.restoreWorkspace({ manifest: s.manifest, confirm: CONFIRM, actor: s.actor });
    expect(await raw(h.dir, 'SELECT COUNT(*) AS n FROM access_tokens WHERE revoked_at IS NULL')).toEqual([{ n: 0 }]);
    expect(await raw(h.dir, 'SELECT COUNT(*) AS n FROM access_tokens')).toEqual([{ n: 1 }]);
    expect(await raw(h.dir, 'SELECT COUNT(*) AS n FROM invites WHERE revoked = 0')).toEqual([{ n: 0 }]);
    expect(await raw(h.dir, 'SELECT COUNT(*) AS n FROM invites')).toEqual([{ n: 1 }]);
    expect(await raw(h.dir, 'SELECT COUNT(*) AS n FROM login_tokens')).toEqual([{ n: 0 }]);
    expect(await raw(h.dir, 'SELECT COUNT(*) AS n FROM sessions')).toEqual([{ n: 0 }]);
  });

  it('drops the backup status and the engine audit rows of a database that carried them', async () => {
    const s = await scenario();
    // a backup whose database holds the engine's own traces (an older engine, or a hand made copy)
    const live = h.directory!;
    live.setSetting('backup.status', JSON.stringify({ lastSuccessAt: 1 }));
    live.audit(null, 'backup.run', { files: 1 });
    live.audit(null, 'backup.failed', { error: 'x' });
    const traced = await (async () => {
      const { DatabaseSync } = await import('node:sqlite');
      const copy = path.join(h.dir, 'traced.sqlite');
      const db = new DatabaseSync(path.join(h.dir, 'directory.sqlite'));
      db.prepare('VACUUM INTO ?').run(copy);
      db.close();
      const bytes = fs.readFileSync(copy);
      fs.rmSync(copy);
      return bytes;
    })();
    const files = [...s.stateA].map(([p, data]) => ({ path: p, data }));
    const forged = forge(h, [...files, { path: 'directory.sqlite', data: traced }], { at: T0 + 5 * HOUR });
    await s.restore.restoreWorkspace({ manifest: forged.name, confirm: CONFIRM, actor: s.actor });
    const restored = reopen(h);
    try {
      expect(setting(restored, 'backup.status')).toBeNull();
      expect(audits(restored, 500).filter((r) => r.action === 'backup.run' || r.action === 'backup.failed')).toEqual([]);
    } finally {
      restored.close();
    }
  });

  it('leaves unrelated files alone (the mail outbox, notes) and restores an older schema, migrating it', async () => {
    const s = await scenario();
    const older = await sqliteBytes((db) => {
      for (let i = 0; i < 3; i++) db.exec(migrationSql(MIGRATIONS[i]));
      db.exec('PRAGMA user_version = 3');
      db.exec("INSERT INTO users (id, email, name, role, disabled, created_at) VALUES ('u1', 'owner@example.com', 'Owner', 'owner', 0, 1)");
      db.exec("INSERT INTO settings (key, value) VALUES ('fixture', 'old schema')");
    });
    const forged = await lap('forge an older-schema backup', () => forge(h, [{ path: 'directory.sqlite', data: older }, { path: 'b9.yjs', data: docBytes('nine') }], { at: T0 + 6 * HOUR }));
    await lap('restore it', () => s.restore.restoreWorkspace({ manifest: forged.name, confirm: CONFIRM, actor: s.actor }));
    expect(fs.readFileSync(path.join(h.dir, 'notes.txt'), 'utf8')).toBe('not data of ours');
    expect(fs.existsSync(path.join(h.dir, 'outbox.jsonl'))).toBe(true);
    const restored = await lap('reopen the restored database', () => reopen(h));
    try {
      expect(setting(restored, 'fixture')).toBe('old schema');
      expect(restored.getUserByEmail('owner@example.com')).not.toBeNull();
    } finally {
      restored.close();
    }
    expect([...filesOf(h.dir).keys()]).toEqual(['b9.yjs']);
  });

  it('refuses without the confirmation word, with a bad name, without an actor, and changes nothing', async () => {
    // Every one of these is refused before anything is read, so no backup has to exist: only the live data to compare with.
    h = await lap('harness', () => harness({ accounts: true }));
    await lap('seed', () => seedA(h));
    const r = rig(h);
    const manifest = `${new Date(T0).toISOString().replace(/[-:]|\.\d{3}/g, '')}.json.enc`;
    const actor = ownerOf(h);
    const before = filesOf(h.dir);
    await expectCode(r.restore.restoreWorkspace({ manifest, confirm: 'restore', actor }), 'confirmation_mismatch');
    await expectCode(r.restore.restoreWorkspace({ manifest, confirm: '', actor }), 'confirmation_mismatch');
    await expectCode(r.restore.restoreWorkspace({ manifest: 'nope', confirm: CONFIRM, actor }), 'bad_request');
    await expectCode(r.restore.restoreWorkspace({ manifest, confirm: CONFIRM, actor: undefined as never }), 'forbidden');
    expect(filesOf(h.dir)).toEqual(before);
    expect(oldDirs(h.dir)).toEqual([]);
    expect(r.exits).toEqual([]);
    expect(fs.existsSync(path.join(h.dir, 'restore.json'))).toBe(false);
  });
});
