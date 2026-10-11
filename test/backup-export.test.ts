import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { createApi } from '../server/api.mjs';
import { createBackup, createScrubber, loadBackupConfig } from '../server/backup.mjs';
import { createDirClient } from '../server/backup-dir-client.mjs';
import { loadConfig } from '../server/config.mjs';
import { CREDS, KEY, T0, docBytes } from './backup-harness';

const TOKEN = 'outside-puller-token-123';
const TOKEN_SHA256 = crypto.createHash('sha256').update(TOKEN).digest('hex');
const roots: string[] = [];
const engines: { stop: () => Promise<void> }[] = [];

class FakeResponse extends Writable {
  headers: Record<string, string> = {};
  statusCode = 0;
  headersSent = false;
  chunks: Buffer[] = [];
  abortAfterFirstWrite: boolean;

  constructor({ abortAfterFirstWrite = false } = {}) {
    super();
    this.abortAfterFirstWrite = abortAfterFirstWrite;
  }

  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = String(value);
  }

  writeHead(status: number, headers: Record<string, string> = {}) {
    this.statusCode = status;
    Object.assign(this.headers, Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)])));
    this.headersSent = true;
    return this;
  }

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (!this.abortAfterFirstWrite) this.chunks.push(Buffer.from(chunk));
    if (this.abortAfterFirstWrite) {
      this.abortAfterFirstWrite = false;
      callback();
      this.destroy();
      return;
    }
    callback();
  }

  get body() {
    return Buffer.concat(this.chunks);
  }
}

function makeDirBackupConfig(extra: Record<string, string> = {}) {
  return loadBackupConfig({
    TABULA_BACKUP_TARGET: 'dir',
    TABULA_BACKUP_KEY: KEY.toString('base64'),
    TABULA_BACKUP_VERIFY_HOURS: '0',
    TABULA_BACKUP_SETTLE_SECONDS: '0',
    TABULA_BACKUP_SHUTDOWN_SECONDS: '0',
    TABULA_BACKUP_PULL_TOKEN_SHA256: TOKEN_SHA256,
    ...extra,
  }, () => {})!;
}

function makeS3BackupConfig(extra: Record<string, string> = {}) {
  return loadBackupConfig({
    TABULA_BACKUP_S3_ENDPOINT: 'https://s3.example.com',
    TABULA_BACKUP_BUCKET: CREDS.bucket,
    TABULA_BACKUP_ACCESS_KEY: CREDS.accessKey,
    TABULA_BACKUP_SECRET_KEY: CREDS.secretKey,
    TABULA_BACKUP_KEY: KEY.toString('base64'),
    TABULA_BACKUP_VERIFY_HOURS: '0',
    ...extra,
  }, () => {})!;
}

function setup({ backupConfig = makeDirBackupConfig(), cloud = null, now = () => T0, dataDir: selectedDataDir }: {
  backupConfig?: ReturnType<typeof loadBackupConfig>;
  cloud?: { limits: () => { readOnly: boolean } } | null;
  now?: () => number;
  dataDir?: string;
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-backup-export-'));
  roots.push(root);
  const dataDir = selectedDataDir ?? path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const exportDir = path.join(dataDir, 'backup-export');
  const directory = {};
  const config = loadConfig({
    PORT: '8787',
    TABULA_AUTH: 'on',
    TABULA_OWNER_EMAIL: 'owner@example.com',
    DATA_DIR: dataDir,
  });
  const mailer = { async send() {} };
  const validSessionCookie = `${config.cookieName}=valid-session-token`;
  const auth = {
    authenticate: vi.fn<(cookieHeader?: string) => { user: { id: string; role: string }; sessionId: string; setCookie: null } | null>((cookieHeader) => cookieHeader === validSessionCookie
      ? { user: { id: 'owner', role: 'owner' }, sessionId: 'session-id', setCookie: null }
      : null),
    authenticateGuest: vi.fn<() => null>(() => null),
    csrfOk: vi.fn<() => boolean>(() => true),
    sessionCookie: vi.fn<() => string>(() => ''),
    clearCookie: vi.fn<() => string>(() => ''),
    logout: vi.fn<() => void>(),
    logoutAll: vi.fn<() => void>(),
    requestLogin: vi.fn<() => void>(),
    verifyLogin: vi.fn<() => void>(),
  };
  const logs: string[] = [];
  const api = createApi({
    directory,
    auth,
    config,
    roomExists: () => false,
    events: new EventEmitter(),
    mailer,
    cloud,
    now,
    backupConfig,
    dataDir,
    log: (line: string) => { logs.push(line); },
  } as never);
  return { root, dataDir, exportDir, directory, config, auth, api, logs, validSessionCookie };
}

async function call(api: ReturnType<typeof createApi>, method: string, url: string, {
  headers = {}, body = '', abortAfterFirstWrite = false,
}: { headers?: Record<string, string>; body?: string; abortAfterFirstWrite?: boolean } = {}) {
  const req = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), {
    method,
    url,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
  });
  const res = new FakeResponse({ abortAfterFirstWrite });
  await api.handle(req as never, res as never);
  if (!res.writableFinished && !res.destroyed) await new Promise<void>((resolve) => res.once('finish', resolve));
  const parsedBody = res.headers['content-type']?.startsWith('application/json') && res.body.length
    ? JSON.parse(res.body.toString())
    : null;
  return {
    statusCode: res.statusCode,
    headers: res.headers,
    rawBody: res.body,
    body: parsedBody,
  };
}

const bearer = { headers: { authorization: `Bearer ${TOKEN}` } };
const objectUrl = (key: string) => `/api/backup-export/object?key=${encodeURIComponent(key)}`;
const listUrl = (query = 'prefix=tabula%2Fobjects%2F') => `/api/backup-export/list?${query}`;

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

describe('backup export configuration and registration', () => {
  it('validates, normalizes, and scrubs the optional hash without echoing invalid values', () => {
    const lower = makeDirBackupConfig({ TABULA_BACKUP_PULL_TOKEN_SHA256: 'ab'.repeat(32) });
    const upper = makeDirBackupConfig({ TABULA_BACKUP_PULL_TOKEN_SHA256: 'AB'.repeat(32) });
    expect(lower.pullTokenSha256).toBe('ab'.repeat(32));
    expect(upper.pullTokenSha256).toBe(lower.pullTokenSha256);
    expect(lower.secrets).toContain('ab'.repeat(32));
    expect(lower.secrets).toContain('AB'.repeat(32));
    expect(createScrubber(lower.secrets)('hash=' + 'AB'.repeat(32))).not.toContain('AB'.repeat(32));

    const unset = loadBackupConfig({ TABULA_BACKUP_TARGET: 'dir', TABULA_BACKUP_KEY: KEY.toString('base64') }, () => {})!;
    expect(unset.pullTokenSha256).toBeNull();

    const invalid = 'not-a-sha256-token';
    let message = '';
    try {
      makeDirBackupConfig({ TABULA_BACKUP_PULL_TOKEN_SHA256: invalid });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('TABULA_BACKUP_PULL_TOKEN_SHA256');
    expect(message).not.toContain(invalid);
    expect(() => loadBackupConfig({ TABULA_BACKUP_TARGET: 's3', TABULA_BACKUP_PULL_TOKEN_SHA256: TOKEN_SHA256 }, () => {}))
      .toThrow(/TABULA_BACKUP_PULL_TOKEN_SHA256.*TABULA_BACKUP_TARGET=dir/);
  });

  it('leaves the paths identical to unknown API paths unless target dir and a hash are configured', async () => {
    for (const backupConfig of [makeS3BackupConfig(), loadBackupConfig({
      TABULA_BACKUP_TARGET: 'dir', TABULA_BACKUP_KEY: KEY.toString('base64'),
    }, () => {})!]) {
      const ctx = setup({ backupConfig });
      const route = await call(ctx.api, 'GET', listUrl(), bearer);
      const unknown = await call(ctx.api, 'GET', '/api/no-such-route');
      expect(route.statusCode).toBe(404);
      expect(route.rawBody).toEqual(unknown.rawBody);
    }
  });
});

describe('public backup export routes', () => {
  it('returns one indistinguishable 401 for absent, malformed, and wrong bearers without reading cookies', async () => {
    const ctx = setup();
    const cookie = ctx.validSessionCookie;
    const answers = await Promise.all([
      call(ctx.api, 'GET', listUrl()),
      call(ctx.api, 'GET', listUrl(), { headers: { authorization: 'Bearer bad token' } }),
      call(ctx.api, 'GET', listUrl(), { headers: { authorization: 'Basic wrong' } }),
      call(ctx.api, 'GET', listUrl(), { headers: { authorization: 'Bearer wrong', cookie } }),
    ]);
    expect(answers.map((answer) => answer.statusCode)).toEqual([401, 401, 401, 401]);
    expect(answers.map((answer) => answer.rawBody.toString())).toEqual(Array(4).fill('{"error":"unauthorized"}'));
    expect(answers.every((answer) => answer.headers['www-authenticate'] === 'Bearer')).toBe(true);
    expect(answers[3].headers['set-cookie']).toBeUndefined();
    expect(ctx.auth.authenticate).not.toHaveBeenCalled();
    expect(ctx.auth.authenticateGuest).not.toHaveBeenCalled();
    expect(ctx.auth.csrfOk).not.toHaveBeenCalled();
  });

  it('paginates sorted keys with exclusive after, enforces prefix and key rules, and omits temporary files', async () => {
    const ctx = setup();
    const objects = path.join(ctx.exportDir, 'tabula', 'objects');
    fs.mkdirSync(objects, { recursive: true });
    for (let i = 1199; i >= 0; i--) {
      fs.writeFileSync(path.join(objects, `object-${String(i).padStart(4, '0')}`), Buffer.from([i % 251]));
    }
    fs.writeFileSync(path.join(objects, 'unfinished.tmp-0123456789abcdef'), 'temporary');

    const first = await call(ctx.api, 'GET', listUrl(), bearer);
    expect(first.statusCode).toBe(200);
    expect(first.body.keys).toHaveLength(1000);
    const firstKeys = first.body.keys.map((item: { key: string }) => item.key);
    expect(firstKeys).toEqual(firstKeys.toSorted());
    expect(first.body.next).toBe(first.body.keys.at(-1).key);
    expect(first.body.keys.some((item: { key: string }) => item.key.includes('.tmp-'))).toBe(false);

    const second = await call(ctx.api, 'GET', listUrl(`prefix=tabula%2Fobjects&after=${encodeURIComponent(first.body.next)}`), bearer);
    expect(second.body.keys).toHaveLength(200);
    expect(second.body.keys[0].key > first.body.next).toBe(true);
    expect(second.body.next).toBeNull();
    expect((await call(ctx.api, 'GET', listUrl('prefix=elsewhere%2Fobjects%2F'), bearer)).statusCode).toBe(400);
    expect((await call(ctx.api, 'GET', listUrl('prefix=tabula%2Fobjects%2F&after=tabula%2Fobjects%2F..%2Fbad'), bearer)).statusCode).toBe(400);
    expect((await call(ctx.api, 'GET', listUrl('prefix=tabula%2Fobjects%2F&after=bad%5Ckey'), bearer)).statusCode).toBe(400);
  });

  it('streams only validated objects, supplies size and safety headers, supports HEAD, and refuses symlinks and bodies', async () => {
    const ctx = setup();
    const files = createDirClient({ dir: ctx.exportDir });
    const key = 'tabula/objects/sealed-object';
    const sealed = Buffer.from([1, 2, 3, 4, 5, 6]);
    await files.put(key, sealed);

    const downloaded = await call(ctx.api, 'GET', objectUrl(key), bearer);
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.rawBody).toEqual(sealed);
    expect(downloaded.headers).toMatchObject({
      'content-type': 'application/octet-stream',
      'content-length': String(sealed.length),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    expect((await call(ctx.api, 'HEAD', objectUrl(key), bearer)).rawBody).toHaveLength(0);
    expect((await call(ctx.api, 'HEAD', objectUrl(key), bearer)).headers['content-length']).toBe(String(sealed.length));
    expect(await call(ctx.api, 'GET', objectUrl('tabula/objects/missing'), bearer)).toMatchObject({ statusCode: 404, body: { error: 'not_found' } });
    expect((await call(ctx.api, 'GET', objectUrl('tabula/objects/../outside'), bearer)).statusCode).toBe(400);
    expect((await call(ctx.api, 'GET', objectUrl('elsewhere/objects/outside'), bearer)).statusCode).toBe(400);

    const outside = path.join(ctx.root, 'outside');
    fs.writeFileSync(outside, 'outside');
    const link = path.join(ctx.exportDir, 'tabula', 'objects', 'linked-object');
    fs.symlinkSync(outside, link);
    expect((await call(ctx.api, 'GET', objectUrl('tabula/objects/linked-object'), bearer)).statusCode).toBe(400);

    const refusedBody = await call(ctx.api, 'GET', objectUrl(key), { headers: { ...bearer.headers, 'content-length': '4' }, body: 'data' });
    expect(refusedBody.statusCode).toBe(400);
    expect(ctx.logs.some((line) => line.includes(key))).toBe(false);
    expect(ctx.logs).toContain(`backup-export: object 200 ${sealed.length} bytes`);
  });

  it('uses a 120 request sliding window and returns retry-after without consuming the rejected call', async () => {
    const clock = { now: T0 };
    const ctx = setup({ now: () => clock.now });
    for (let i = 0; i < 120; i++) expect((await call(ctx.api, 'GET', listUrl(), bearer)).statusCode).toBe(200);
    const limited = await call(ctx.api, 'GET', listUrl(), bearer);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    clock.now += 60_001;
    expect((await call(ctx.api, 'GET', listUrl(), bearer)).statusCode).toBe(200);
  });

  it('applies the weighted object byte window and does not count an over-limit request', async () => {
    const clock = { now: T0 };
    const ctx = setup({ now: () => clock.now });
    for (let i = 0; i < 118; i++) expect((await call(ctx.api, 'GET', listUrl(), bearer)).statusCode).toBe(200);

    const objects = path.join(ctx.exportDir, 'tabula', 'objects');
    fs.mkdirSync(objects, { recursive: true });
    const createSparse = (name: string, size: number) => {
      const fd = fs.openSync(path.join(objects, name), 'w');
      fs.ftruncateSync(fd, size);
      fs.closeSync(fd);
    };
    createSparse('large-a', 300 * 1024 * 1024);
    createSparse('large-b', 101 * 1024 * 1024);
    const first = await call(ctx.api, 'GET', objectUrl('tabula/objects/large-a'), { ...bearer, abortAfterFirstWrite: true });
    expect(first.statusCode).toBe(200);
    const overBytes = await call(ctx.api, 'GET', objectUrl('tabula/objects/large-b'), { ...bearer, abortAfterFirstWrite: true });
    expect(overBytes.statusCode).toBe(429);
    expect(overBytes.headers['retry-after']).toBe('60');
    expect((await call(ctx.api, 'GET', listUrl(), bearer)).statusCode).toBe(200);
  });

  it('serves while cloud read-only is active and decrypts fetched engine output from a second directory client', async () => {
    const ctx = setup({ cloud: { limits: () => ({ readOnly: true }) } });
    const backupConfig = makeDirBackupConfig({ TABULA_BACKUP_DIR: ctx.exportDir });
    const clock = { now: T0 };
    const backup = createBackup({
      config: backupConfig,
      dataDir: ctx.dataDir,
      directory: null,
      now: () => clock.now,
      random: () => 0,
      backoffMs: [0],
      log: () => {},
    })!;
    engines.push(backup);
    const written = docBytes('sealed board from the engine');
    fs.writeFileSync(path.join(ctx.dataDir, 'b1.yjs'), written);
    const result = await backup.runNow();
    expect(result).toMatchObject({ ok: true, changed: true });
    if (!result.ok || !('manifest' in result) || typeof result.manifest !== 'string') throw new Error('backup did not finish');
    const manifest = await backup.readManifest(result.manifest);
    const board = manifest.files.find((file: { path: string }) => file.path === 'b1.yjs')!;
    const manifestKey = `tabula/manifests/${result.manifest}`;
    const objectKey = `tabula/objects/${board.objectId}`;

    const api = createApi({
      directory: ctx.directory,
      auth: ctx.auth,
      config: ctx.config,
      roomExists: () => false,
      events: new EventEmitter(),
      cloud: { limits: () => ({ readOnly: true }) },
      backupConfig,
      dataDir: ctx.dataDir,
      now: () => clock.now,
      log: (line: string) => { ctx.logs.push(line); },
      mailer: { async send() {} },
    } as never);
    const fetchedManifest = await call(api, 'GET', objectUrl(manifestKey), bearer);
    const fetchedObject = await call(api, 'GET', objectUrl(objectKey), bearer);
    expect(fetchedManifest.statusCode).toBe(200);
    expect(fetchedObject.statusCode).toBe(200);

    const secondDir = path.join(ctx.root, 'second-export');
    const secondClient = createDirClient({ dir: secondDir });
    await secondClient.put(manifestKey, fetchedManifest.rawBody);
    await secondClient.put(objectKey, fetchedObject.rawBody);
    const readerConfig = makeDirBackupConfig({ TABULA_BACKUP_DIR: secondDir, TABULA_BACKUP_PULL_TOKEN_SHA256: '' });
    const reader = createBackup({
      config: readerConfig,
      dataDir: ctx.dataDir,
      directory: null,
      now: () => clock.now,
      log: () => {},
    })!;
    engines.push(reader);
    expect((await reader.readManifest(result.manifest)).files).toContainEqual(board);
    expect(await reader.readObject(board.objectId)).toEqual(written);
  });
});
