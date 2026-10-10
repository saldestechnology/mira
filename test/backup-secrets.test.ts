import { afterEach, describe, expect, it } from 'vitest';
import { createBackup, deriveKeys, loadBackupConfig } from '../server/backup.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { RestoreError } from '../server/restore.mjs';
import { CREDS, HOUR, KEY, KEY_OTHER, KEY_PREVIOUS, MIN, VERSION_A, docBytes, envFor, harness, type Harness } from './backup-harness';
import { CONFIRM, backupNow, becomeB, databaseOf, forge, ownerOf, rig, seedA } from './restore-harness';

// docs/backups.md. The canary test: recognisable secrets go in, every way the engine can fail is provoked, and the
// logs, the status, the stored status, the audit rows, the results, the thrown errors and the bucket are searched
// for them. Nothing the engine says may contain the key, the secret key, the access key, a signature, an
// Authorization header or credentials in the endpoint.

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const spellings = (key: Buffer) => [
  key.toString('hex'), key.toString('hex').toUpperCase(), key.toString('base64'), key.toString('base64').replace(/=+$/, ''), key.toString('base64url'),
];
const ENDPOINT_USER = 'CANARYUSER';
const ENDPOINT_PASSWORD = 'CANARYPASSWORD7788';

describe('nothing the engine says contains a secret', () => {
  it('through successes, S3 errors, tampering, thrown exceptions and a hostile storage provider', async () => {
    h = await harness({ accounts: true, env: { TABULA_BACKUP_KEY_PREVIOUS: KEY_PREVIOUS.toString('hex') } });
    const real = globalThis.fetch;
    const authorizations: string[] = [];
    const outputs: string[] = [];
    const record = (label: string, value: unknown) => {
      outputs.push(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value, value instanceof Error ? Object.getOwnPropertyNames(value) : undefined)}`);
    };
    const everything = [...spellings(KEY), ...spellings(KEY_PREVIOUS), CREDS.secretKey, CREDS.accessKey];
    const hostile = `key=${spellings(KEY).join(' ')} previous=${spellings(KEY_PREVIOUS).join(' ')} secret=${CREDS.secretKey} access=${CREDS.accessKey}`;

    // How the storage provider and the network misbehave right now.
    let behaviour: 'normal' | 'hostile-error' | 'throws' | 'corrupt-manifest' = 'normal';
    const wrapped = async (url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>)?.authorization;
      if (auth) authorizations.push(auth);
      if (behaviour === 'throws') {
        throw Object.assign(new TypeError(`fetch failed ${hostile} ${auth}`), { cause: Object.assign(new Error(hostile), { code: 'ECONNRESET' }) });
      }
      if (behaviour === 'hostile-error' && init.method !== 'HEAD') {
        return new Response(`<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>${hostile}</Message><RequestId>${auth}</RequestId><HostId>${hostile}</HostId></Error>`, { status: 403 });
      }
      if (behaviour === 'corrupt-manifest' && init.method === 'GET' && /\/manifests\/2/.test(url)) {
        const body = Buffer.from(await (await real(url, init)).arrayBuffer());
        body[body.length - 9] ^= 1;
        return new Response(body, { status: 200 });
      }
      return real(url, init);
    };

    // A directory that can be made to fail with the secrets in its error messages.
    let directoryBroken = false;
    const directory = {
      getSetting: (key: string) => h.directory!.getSetting(key),
      setSetting: (key: string, value: unknown) => {
        if (directoryBroken) throw new Error(`database says ${hostile}`);
        h.directory!.setSetting(key, value);
      },
      audit: (actor: string | null, action: string, detail: Record<string, unknown>) => {
        if (directoryBroken) throw new Error(`audit says ${hostile}`);
        h.directory!.audit(actor, action, detail);
      },
    };
    let roomsBroken = false;
    const engine = h.engine({
      fetch: wrapped,
      directory,
      boardState: () => {
        if (roomsBroken) throw new Error(`room says ${hostile}`);
        return null;
      },
    });
    const snapshot = (label: string) => {
      record(`${label} status`, engine.status());
      record(`${label} stored status`, String(h.directory!.getSetting('backup.status')));
    };

    // 1. successes
    record('first run', await engine.runNow());
    h.clock.now += HOUR;
    record('unchanged run', await engine.runNow());
    snapshot('after success');

    // 2. S3 errors, with and without the secrets in the provider's own words
    h.fake.rules.push({ method: 'PUT', status: 403, times: 99 });
    h.write('b2.yjs', docBytes('a change that cannot be uploaded'));
    h.clock.now += HOUR;
    record('403', await engine.runNow());
    h.fake.rules.length = 0;
    h.fake.rules.push({ method: 'PUT', status: 500, times: 99 });
    h.clock.now += HOUR;
    record('500', await engine.runNow());
    h.fake.rules.length = 0;
    behaviour = 'hostile-error';
    h.clock.now += HOUR;
    record('hostile error body', await engine.runNow());
    snapshot('after S3 errors');

    // 3. exceptions: the network, the rooms, the directory
    behaviour = 'throws';
    h.clock.now += HOUR;
    record('network exception', await engine.runNow());
    behaviour = 'normal';
    roomsBroken = true;
    h.clock.now += HOUR;
    record('room hook throws', await engine.runNow());
    roomsBroken = false;
    directoryBroken = true;
    h.write('b2.yjs', docBytes('another change'));
    h.clock.now += HOUR;
    record('directory throws', await engine.runNow());
    directoryBroken = false;
    snapshot('after exceptions');

    // 4. tampering: a damaged previous manifest, and a manifest that reads back wrong
    const [newest] = await engine.listManifests();
    const stored = h.fake.objects.get(`tabula/manifests/${newest.name}`)!;
    const original = Buffer.from(stored.body);
    stored.body[40] ^= 1;
    h.write('b2.yjs', docBytes('a change after the damage'));
    h.clock.now += HOUR;
    record('damaged previous manifest', await engine.runNow());
    h.fake.objects.set(`tabula/manifests/${newest.name}`, { body: original, lastModified: stored.lastModified });
    behaviour = 'corrupt-manifest';
    h.write('b2.yjs', docBytes('a change that reads back wrong'));
    h.clock.now += HOUR;
    record('read-back tampering', await engine.runNow());
    behaviour = 'normal';
    h.clock.now += HOUR;
    record('recovery', await engine.runNow());
    snapshot('after tampering');

    // 5. the read side: wrong key, tampered objects, bad manifests
    const manifestName = (await engine.listManifests())[0].name;
    const manifest = await engine.readManifest(manifestName);
    const wrongKey = h.engine({ config: loadBackupConfig({ ...envFor(h.fake), TABULA_BACKUP_KEY: KEY_OTHER.toString('hex') }, () => {}), fetch: wrapped });
    for (const attempt of [
      () => wrongKey.readManifest(manifestName),
      () => wrongKey.readObject(manifest.files[0].objectId),
      () => engine.readObject('0'.repeat(64)),
      () => engine.readObject('not an id'),
      () => engine.readManifest('../../etc/passwd'),
    ]) {
      try {
        await attempt();
        throw new Error('expected a failure');
      } catch (err) {
        record('read error', err as Error);
      }
    }
    const objectKey = `tabula/objects/${manifest.files[0].objectId}`;
    const body = Buffer.from(h.fake.objects.get(objectKey)!.body);
    body[body.length - 20] ^= 1;
    h.fake.objects.set(objectKey, { body, lastModified: 0 });
    await engine.readObject(manifest.files[0].objectId).catch((err) => record('tampered object', err));

    // 6. credentials in the endpoint, which the configuration refuses but a hand-made one might carry
    const base = h.config()!;
    const withUserInfo = Object.create(base, { endpoint: { value: h.fake.url.replace('http://', `http://${ENDPOINT_USER}:${ENDPOINT_PASSWORD}@`) } });
    const userInfoEngine = createBackup({ config: withUserInfo, dataDir: h.dir, directory, log: (...a: unknown[]) => h.logs.push(a.join(' ')), now: () => h.clock.now, backoffMs: [0] })!;
    record('endpoint with credentials', await userInfoEngine.runNow());
    snapshot('endpoint with credentials');
    await userInfoEngine.stop();
    for (const refused of [`http://${ENDPOINT_USER}:${ENDPOINT_PASSWORD}@127.0.0.1:9000`, `https://${ENDPOINT_USER}:${ENDPOINT_PASSWORD}@s3.example.com`]) {
      try {
        loadBackupConfig({ ...envFor(h.fake), TABULA_BACKUP_S3_ENDPOINT: refused }, () => {});
        throw new Error('expected a refusal');
      } catch (err) {
        record('config error', err as Error);
      }
    }

    // What the engine said, in every place it says anything.
    record('logs', h.logs.join('\n'));
    record('audit', h.directory!.listAudit(500));
    record('stored status', String(h.directory!.getSetting('backup.status')));
    record('status', engine.status());
    record('bucket keys', [...h.fake.objects.keys()]);
    const text = outputs.join('\n');

    // The test is only worth something if the secrets were really in use and the failures really happened.
    expect(authorizations.length).toBeGreaterThan(40);
    for (const a of authorizations) expect(a).toContain(`Credential=${CREDS.accessKey}/`);
    expect(h.logs.filter((l) => l.startsWith('backup: failed:')).length).toBeGreaterThanOrEqual(5);
    expect(h.directory!.listAudit(500).filter((r) => r.action === 'backup.failed').length).toBeGreaterThanOrEqual(5);
    expect(text).toContain('S3 PUT failed (status 403, AccessDenied)');
    expect(text).toContain('S3 PUT failed (status 500, InternalError)');
    expect(text).toContain('could not reach the storage provider (ECONNRESET)');
    expect(text).toContain('unknown_key');
    expect(text.length).toBeGreaterThan(5000);

    const signatures = authorizations.map((a) => /Signature=([0-9a-f]{64})/.exec(a)![1]);
    const keys = deriveKeys(KEY);
    const forbidden = [
      ...everything, ...signatures, ...authorizations, keys.encKey.toString('hex'), keys.nameKey.toString('hex'),
      'X-Amz-Signature', 'x-amz-signature', 'Signature=', 'AWS4-HMAC-SHA256', 'Credential=', ENDPOINT_USER, ENDPOINT_PASSWORD,
    ];
    for (const secret of forbidden) {
      expect(text.includes(secret), `output contains ${secret.slice(0, 12)}...`).toBe(false);
    }
    expect(Buffer.concat([...h.fake.objects.values()].map((o) => o.body)).includes(KEY)).toBe(false);
    expect(Buffer.concat([...h.fake.objects.values()].map((o) => o.body)).includes(keys.encKey)).toBe(false);
    expect(text).not.toMatch(/[0-9a-f]{64}.*Signature/);
  });

  it('a status that was stored with a secret in it is cleaned when it is read', async () => {
    h = await harness({ accounts: true });
    h.directory!.setSetting('backup.status', JSON.stringify({ lastError: `leaked ${CREDS.secretKey}`, lastFailureError: `leaked ${KEY.toString('hex')}`, consecutiveFailures: 2 }));
    const status = JSON.stringify(h.engine().status());
    expect(status).not.toContain(CREDS.secretKey);
    expect(status).not.toContain(KEY.toString('hex'));
    expect(status).toContain('"consecutiveFailures":2');
  });

  it('the files of a data directory never appear in an error', async () => {
    h = await harness();
    h.write('big.yjs', Buffer.alloc(5000, 'S'));
    const result = await h.engine({ maxFileBytes: 100 }).runNow();
    expect(result.error).not.toContain('SSSS');
    expect(result.error).toContain('big.yjs');
  });

  it('a board id in a history path is only ever written as part of a path', async () => {
    h = await harness();
    h.write(`history/b1/${VERSION_A}.yjs.gz`, 'v');
    const engine = h.engine();
    await engine.runNow();
    const manifest = await engine.readManifest((await engine.listManifests())[0].name);
    for (const f of manifest.files as { path: string }[]) expect(f.path).toMatch(/^[A-Za-z0-9_~./-]+$/);
  });
});

describe('nothing the restore says contains a secret', () => {
  it('through failures at every stage, hostile storage answers, tampering, board copies and a restore that succeeds', async () => {
    h = await harness({ accounts: true, env: { TABULA_BACKUP_KEY_PREVIOUS: KEY_PREVIOUS.toString('hex') } });
    seedA(h);
    const real = globalThis.fetch;
    const authorizations: string[] = [];
    const outputs: string[] = [];
    const record = (label: string, value: unknown) => {
      outputs.push(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value, value instanceof Error ? Object.getOwnPropertyNames(value) : undefined)}`);
    };
    const hostile = `key=${spellings(KEY).join(' ')} previous=${spellings(KEY_PREVIOUS).join(' ')} secret=${CREDS.secretKey} access=${CREDS.accessKey}`;
    let behaviour: 'normal' | 'hostile-error' | 'hostile-put' | 'throws' = 'normal';
    const wrapped = async (url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>)?.authorization;
      if (auth) authorizations.push(auth);
      if (behaviour === 'throws') throw Object.assign(new TypeError(`fetch failed ${hostile} ${auth}`), { cause: Object.assign(new Error(hostile), { code: 'ECONNRESET' }) });
      if ((behaviour === 'hostile-error' && init.method !== 'HEAD') || (behaviour === 'hostile-put' && init.method === 'PUT')) {
        return new Response(`<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>${hostile}</Message><RequestId>${auth}</RequestId></Error>`, { status: 403 });
      }
      return real(url, init);
    };
    const r = rig(h, { backup: h.engine({ fetch: wrapped }) });
    const first = await backupNow(h.engine());
    h.clock.now += HOUR;
    becomeB(h);
    h.clock.now += MIN;
    const actor = ownerOf(h);
    const attempt = async (label: string, fn: () => Promise<unknown>) => {
      const failure = await fn().then(
        (done) => {
          record(label, done as object);
          return null;
        },
        (err) => err as RestoreError,
      );
      expect(failure === null || failure instanceof RestoreError, `${label} failed with something else`).toBe(true);
      if (failure) record(label, { message: failure.message, code: failure.code, extra: failure.extra });
      h.clock.now += 11 * MIN;
    };
    const whole = (manifest: string) => () => r.restore.restoreWorkspace({ manifest, confirm: CONFIRM, actor });
    const board = (manifest: string, boardId = 'b1') => () => r.restore.restoreBoardCopy({ manifest, boardId, actor });

    // 1. the stages of a whole restore that fail
    behaviour = 'hostile-put';
    await attempt('safety backup with a hostile answer', whole(first.manifest));
    behaviour = 'hostile-error';
    await attempt('manifest with a hostile answer', whole(first.manifest));
    await attempt('listing with a hostile answer', () => r.restore.listBackups());
    await attempt('preview with a hostile answer', () => r.restore.previewManifest(first.manifest));
    behaviour = 'throws';
    await attempt('network exception', whole(first.manifest));
    await attempt('board copy over a broken network', board(first.manifest));
    behaviour = 'normal';
    await attempt('statfs', async () => rig(h, { statfs: async () => Promise.reject(new Error(hostile)) }).restore.restoreWorkspace({ manifest: first.manifest, confirm: CONFIRM, actor }));
    await attempt('wrong confirmation', async () => r.restore.restoreWorkspace({ manifest: first.manifest, confirm: hostile, actor }));
    await attempt('bad manifest name', async () => r.restore.restoreWorkspace({ manifest: hostile, confirm: CONFIRM, actor }));

    // 2. what is in the bucket is wrong
    const database = await databaseOf(h);
    const files = [{ path: 'directory.sqlite', data: database }, { path: 'b1.yjs', data: docBytes('CANARY-BOARD-CONTENT-ONE') }, { path: 'b2.yjs', data: docBytes('CANARY-BOARD-CONTENT-TWO') }];
    const tampered = forge(h, files, { at: Date.UTC(2026, 9, 9) });
    const stored = h.fake.objects.get(`tabula/objects/${tampered.entries[1].objectId}`)!;
    stored.body[stored.body.length - 20] ^= 1;
    await attempt('flipped bit', whole(tampered.name));
    await attempt('flipped bit in a board copy', board(tampered.name));
    const stranger = forge(h, files, { at: Date.UTC(2026, 9, 10), key: KEY_OTHER });
    await attempt('another key', whole(stranger.name));
    await attempt('another key, preview', () => r.restore.previewManifest(stranger.name));
    const missing = forge(h, files, { at: Date.UTC(2026, 9, 11) });
    h.fake.objects.delete(`tabula/objects/${missing.entries[2].objectId}`);
    await attempt('missing object', whole(missing.name));
    const wrongPath = forge(h, [...files, { path: 'notes.txt', data: Buffer.from('x') }], { at: Date.UTC(2026, 9, 12) });
    await attempt('unexpected file', whole(wrongPath.name));
    const garbage = forge(h, [{ path: 'directory.sqlite', data: Buffer.from('CANARY-NOT-SQLITE') }, files[1]], { at: Date.UTC(2026, 9, 13) });
    await attempt('database that is not a database', whole(garbage.name));
    await attempt('board copy from it', board(garbage.name));

    // 3. board copies that work, and one that cannot be found
    await attempt('board copy', board(first.manifest));
    await attempt('board copy of a board that is not there', board(first.manifest, 'nope'));

    // 4. the restore that succeeds, then everything it left behind
    await attempt('restore', whole(first.manifest));
    expect(await r.exited).toBe(75);

    record('logs', h.logs.join('\n'));
    record('status', r.restore.status());
    record('journal', fs.readFileSync(path.join(h.dir, 'restore.json'), 'utf8'));
    record('names in the directory', fs.readdirSync(h.dir));
    const { openDirectory } = await import('../server/directory.mjs');
    const restored = openDirectory(path.join(h.dir, 'directory.sqlite'));
    try {
      record('audit of the restored workspace', restored.listAudit(500));
      record('settings of the restored workspace', ['restore.status', 'restore.keep', 'backup.protected'].map((k) => restored.getSetting(k)));
    } finally {
      restored.close();
    }
    const text = outputs.join('\n');

    // The test is only worth something if the secrets were in use and the failures really happened.
    expect(authorizations.length).toBeGreaterThan(30);
    for (const a of authorizations) expect(a).toContain(`Credential=${CREDS.accessKey}/`);
    expect(text).toContain('safety_backup_failed');
    expect(text).toContain('S3 PUT failed (status 403, AccessDenied)');
    expect(text).toContain('tamper');
    expect(text).toContain('unknown_key');
    expect(text).toContain('unexpected_file');
    expect(text).toContain('backup_incomplete');
    expect(text).toContain('integrity_check_failed');
    expect(text).toContain('board_not_in_backup');
    expect(text).toContain('restore.done');
    expect(text.length).toBeGreaterThan(5000);

    const signatures = authorizations.map((a) => /Signature=([0-9a-f]{64})/.exec(a)![1]);
    const keys = deriveKeys(KEY);
    const objectIds = [...tampered.entries, ...missing.entries, ...stranger.entries.map(() => ({ objectId: '' }))].map((e) => e.objectId).filter(Boolean);
    const forbidden = [
      ...spellings(KEY), ...spellings(KEY_PREVIOUS), ...spellings(KEY_OTHER), CREDS.secretKey, CREDS.accessKey, ...signatures, ...authorizations,
      keys.encKey.toString('hex'), keys.nameKey.toString('hex'), 'X-Amz-Signature', 'Signature=', 'AWS4-HMAC-SHA256', 'Credential=', ...objectIds,
      `127.0.0.1:${new URL(h.fake.url).port}`, 'tabula/objects/', 'tabula/manifests/',
    ];
    for (const secret of forbidden) expect(text.includes(secret), `output contains ${secret.slice(0, 14)}...`).toBe(false);
    expect(text).not.toMatch(/[0-9a-f]{64}/);
    for (const content of ['CANARY-NOT-SQLITE', 'CANARY-BOARD-CONTENT', 'A: board one', 'B: board one', 'A: comments of one']) expect(text).not.toContain(content);
  });
});
