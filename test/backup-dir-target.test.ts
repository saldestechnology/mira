import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createApi } from '../server/api.mjs';
import { createAuth } from '../server/auth.mjs';
import { clearRunState, createBackup, loadBackupConfig } from '../server/backup.mjs';
import { createDirClient } from '../server/backup-dir-client.mjs';
import { loadConfig } from '../server/config.mjs';
import { openDirectory } from '../server/directory.mjs';
import { CONFIRM_WORD, createRestore } from '../server/restore.mjs';
import { CREDS, KEY, T0, docBytes } from './backup-harness';

const roots: string[] = [];
const engines: { stop: () => Promise<void> }[] = [];
const directories: { close: () => void }[] = [];

async function adminBackupList(api: ReturnType<typeof createApi>, cookie: string) {
  const req = Object.assign(Readable.from([]), {
    method: 'GET',
    url: '/api/admin/backups',
    headers: { cookie },
    socket: { remoteAddress: '127.0.0.1' },
  });
  const headers: Record<string, string> = {};
  let statusCode = 0;
  let body = '';
  const res = {
    headersSent: false,
    setHeader(name: string, value: string) { headers[name] = value; },
    writeHead(status: number, extra: Record<string, string> = {}) {
      statusCode = status;
      Object.assign(headers, extra);
      this.headersSent = true;
    },
    end(data?: string | Buffer) { body = data?.toString() ?? ''; },
  };
  await api.handle(req as never, res as never);
  return { statusCode, headers, body: JSON.parse(body) };
}

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  for (const directory of directories.splice(0)) directory.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

function config(extra: Record<string, string> = {}) {
  return loadBackupConfig({
    TABULA_BACKUP_TARGET: 'dir',
    TABULA_BACKUP_KEY: KEY.toString('base64'),
    TABULA_BACKUP_VERIFY_HOURS: '0',
    TABULA_BACKUP_KEEP_HOURLY_HOURS: '0',
    TABULA_BACKUP_KEEP_DAILY_DAYS: '0',
    TABULA_BACKUP_SNAPSHOT_MAX_HOLD_SECONDS: '60',
    ...extra,
  }, () => {});
}

describe('backup target configuration', () => {
  it('needs only the key for a directory target and ignores S3 settings', () => {
    const loaded = loadBackupConfig({
      TABULA_BACKUP_TARGET: 'dir',
      TABULA_BACKUP_KEY: KEY.toString('base64'),
      TABULA_BACKUP_S3_ENDPOINT: 'not a URL',
      TABULA_BACKUP_BUCKET: 'bad bucket',
      TABULA_BACKUP_ACCESS_KEY: 'bad access key',
      TABULA_BACKUP_SECRET_KEY: 'bad secret key',
    }, () => {});
    expect(loaded).toMatchObject({ target: 'dir', dir: null, prefix: 'tabula' });
    expect(loaded?.endpoint).toBeUndefined();
    expect(loaded?.bucket).toBeUndefined();
    expect(loaded!.secrets).toContain(KEY.toString('hex'));
  });

  it('refuses an unknown target and a relative directory', () => {
    expect(() => loadBackupConfig({ TABULA_BACKUP_TARGET: 'disk' }, () => {})).toThrow(/TABULA_BACKUP_TARGET/);
    expect(() => config({ TABULA_BACKUP_DIR: 'relative/export' })).toThrow(/TABULA_BACKUP_DIR/);
    expect(config({ TABULA_BACKUP_DIR: path.join(os.tmpdir(), 'backup-export') })?.dir).toBe(path.join(os.tmpdir(), 'backup-export'));
  });

  it('keeps the S3 target and its required fields as the default', () => {
    const loaded = loadBackupConfig({
      TABULA_BACKUP_S3_ENDPOINT: 'https://s3.example.com',
      TABULA_BACKUP_BUCKET: CREDS.bucket,
      TABULA_BACKUP_ACCESS_KEY: CREDS.accessKey,
      TABULA_BACKUP_SECRET_KEY: CREDS.secretKey,
      TABULA_BACKUP_KEY: KEY.toString('base64'),
    }, () => {});
    expect(loaded).toMatchObject({ target: 's3', endpoint: 'https://s3.example.com', bucket: CREDS.bucket, dir: undefined, pathStyle: true });
  });
});

describe('the directory backup target', () => {
  it('writes incrementally, prunes, restores from the export, and leaves it on the data volume', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-backup-dir-target-'));
    roots.push(root);
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir);
    const exportDir = path.join(dataDir, 'backup-export');
    const directory = openDirectory(path.join(dataDir, 'directory.sqlite'));
    directories.push(directory);
    const owner = directory.createUser({ email: 'owner@example.com', name: 'Owner', role: 'owner' })!;
    // the copy of the directory leaves out the engine's own audit rows; with none at all the first copy has no audit sequence and the second one has
    // (an engine detail that is the same for every target), so start with one of ours
    directory.audit(owner.id, 'test.seed', {});
    const loaded = config()!;
    const clock = { now: T0 };
    const log: string[] = [];
    const backup = createBackup({ config: loaded, dataDir, directory, now: () => clock.now, log: (line: string) => log.push(line), random: () => 0, backoffMs: [0] })!;
    engines.push(backup);
    const files = createDirClient({ dir: exportDir });
    // docBytes draws a new client id every call, so keep what was written to compare with what is read back
    const written = new Map<string, Buffer>();
    const writeBoard = (text: string) => {
      const bytes = docBytes(text);
      written.set(text, bytes);
      fs.writeFileSync(path.join(dataDir, 'b1.yjs'), bytes);
    };
    writeBoard('first');

    const first = await backup.runNow();
    expect(first).toMatchObject({ ok: true, changed: true, uploaded: 2 });
    if (!first.ok || !('manifest' in first) || typeof first.manifest !== 'string') throw new Error('the first directory backup did not finish');
    const firstName = first.manifest;
    const firstManifest = await backup.readManifest(firstName);
    expect(firstManifest.files.map((file: { path: string }) => file.path).sort()).toEqual(['b1.yjs', 'directory.sqlite']);
    expect(firstManifest.files.some((file: { path: string }) => file.path.startsWith('backup-export/'))).toBe(false);
    const firstObjects = await files.list('tabula/objects/');
    expect(firstObjects).toHaveLength(2);
    expect(await files.head(`tabula/manifests/${firstName}`)).not.toBeNull();
    const originalBoard = firstManifest.files.find((file: { path: string }) => file.path === 'b1.yjs')!;
    expect(await backup.readObject(originalBoard.objectId)).toEqual(written.get('first'));

    clock.now += 60_000;
    const unchanged = await backup.runNow();
    expect(unchanged).toMatchObject({ ok: true, changed: false, uploaded: 0, manifest: firstName });
    expect(await files.list('tabula/manifests/')).toHaveLength(1);
    expect((await files.list('tabula/objects/')).map((item) => item.key)).toEqual(firstObjects.map((item) => item.key));
    expect(fs.existsSync(exportDir)).toBe(true);

    const oldObject = path.join(exportDir, 'tabula', 'objects', originalBoard.objectId);
    const staleAt = new Date(clock.now - 2 * 60 * 60 * 1000);
    fs.utimesSync(oldObject, staleAt, staleAt);
    writeBoard('changed');
    clock.now = T0 + 2 * 60 * 60 * 1000;
    const changed = await backup.runNow();
    expect(changed).toMatchObject({ ok: true, changed: true, uploaded: 1 });
    if (!changed.ok || !('manifest' in changed) || typeof changed.manifest !== 'string') throw new Error('the changed directory backup did not finish');
    const changedName = changed.manifest;
    expect(backup.status()).toMatchObject({ target: 'dir', enabled: true });
    expect(backup.status()).not.toHaveProperty('bucket');
    expect(backup.status()).not.toHaveProperty('endpoint');
    expect(await files.head(`tabula/manifests/${firstName}`)).toBeNull();
    expect(await files.head(`tabula/objects/${originalBoard.objectId}`)).toBeNull();
    const newest = await backup.readManifest(changedName);
    const changedBoard = newest.files.find((file: { path: string }) => file.path === 'b1.yjs')!;
    expect(await backup.readObject(changedBoard.objectId)).toEqual(written.get('changed'));
    expect((await files.list('tabula/manifests/')).map((item) => item.key)).toEqual([`tabula/manifests/${changedName}`]);

    expect(clearRunState({ dataDir, directory })).toBe(0);
    expect(fs.existsSync(path.join(exportDir, 'tabula', 'manifests', changedName))).toBe(true);
    writeBoard('live after backup');
    const exits: number[] = [];
    const restore = createRestore({
      backup,
      directory,
      config: loaded,
      dataDir,
      now: () => clock.now,
      sleep: async () => {},
      statfs: async () => ({ bsize: 4096, blocks: 1_000_000, bavail: 900_000 }),
      hooks: { closeDirectory: () => {} },
      setTimeout: (fn: () => void) => { fn(); return 1; },
      clearTimeout: () => {},
      exit: (code: number) => exits.push(code),
      log: () => {},
    })!;
    const serverConfig = loadConfig({ PORT: '8787', TABULA_AUTH: 'on', TABULA_OWNER_EMAIL: 'owner@example.com', DATA_DIR: dataDir });
    const mailer = { async send() {} };
    const auth = createAuth({ directory, config: serverConfig, mailer });
    const api = createApi({
      directory,
      auth,
      config: serverConfig,
      roomExists: () => false,
      events: new EventEmitter(),
      mailer,
      restore: restore as never,
      backupStatus: () => ({ ...backup.status(), restore: restore.status() }),
    });
    const session = directory.createSession(owner.id, { ttlMs: 30 * 86_400_000, now: clock.now });
    const listed = await adminBackupList(api, `${serverConfig.cookieName}=${session.token}`);
    expect(listed.statusCode).toBe(200);
    expect(listed.body.status).toMatchObject({ target: 'dir' });
    expect(listed.body.status).not.toHaveProperty('bucket');

    const restored = await restore.restoreWorkspace({ manifest: changedName, confirm: CONFIRM_WORD, actor: owner });
    expect(restored).toMatchObject({ ok: true, restarting: true });
    expect(exits).toEqual([75]);
    expect(fs.existsSync(exportDir)).toBe(true);
    expect(fs.readFileSync(path.join(dataDir, 'b1.yjs'))).toEqual(written.get('changed'));
    expect((await files.list('tabula/manifests/')).length).toBeGreaterThan(0);
    expect(log).toEqual(expect.arrayContaining([expect.stringContaining('ok:')]));
    restore.stop();
  });
});
