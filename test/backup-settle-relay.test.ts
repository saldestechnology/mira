import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { CREDS, docBytes, envFor, harness, type Harness } from './backup-harness';
import { freePort } from './free-port';
import { makePng } from './image-fixtures';
import { startRelayProcess } from './start-relay';

// docs/backups.md, When it runs. The relay as a child process next to the fake S3: a backup shortly after an edit
// (settle) with no interval run, and a bounded final backup when the relay is asked to stop. The stop is the IPC
// 'shutdown' message, which works on every system.

type Exit = { code: number | null; signal: NodeJS.Signals | null };
type Relay = { child: ChildProcess; port: number; base: string; exited: Promise<Exit>; out: () => string; err: () => string };

let h: Harness;
const relays: Relay[] = [];
const providers: WebsocketProvider[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(test: () => boolean | Promise<boolean>, ms: number, what: string) {
  const t0 = Date.now();
  while (!(await test())) {
    if (Date.now() - t0 > ms) throw new Error(what);
    await sleep(20);
  }
}

/** Open mode unless `env` turns accounts on. The relay's data directory is the harness's, so the test can put files in it and read them back. */
async function startRelay(env: Record<string, string> = {}, preload?: string): Promise<Relay> {
  const started = await startRelayProcess({
    spawnArgs: preload ? ['--import', pathToFileURL(preload).href] : [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    envFor: (port) => ({
      ...(process.env as Record<string, string>), PORT: String(port), DATA_DIR: h.dir, HOST: '127.0.0.1', TABULA_AUTH: 'off', TABULA_MAIL: 'file', TABULA_BASE_URL: `http://127.0.0.1:${port}`,
      // the first scheduled run is at least a minute away: a backup within seconds of an edit is not that one
      ...envFor(h.fake), ...env,
    }),
  });
  const child = started.proc;
  const exited = new Promise<Exit>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve({ code: child.exitCode, signal: child.signalCode });
    else child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const relay = { child, port: started.port, base: `http://127.0.0.1:${started.port}`, exited, out: started.output, err: started.output };
  relays.push(relay);
  return relay;
}

async function connect(port: number, room: string) {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/sync`, room, doc, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    disableBc: true,
  });
  providers.push(provider);
  await until(() => provider.wsconnected && provider.synced, 5000, 'could not connect');
  return doc;
}

/** An edit that has reached the relay (a second client sees it) but that is not in a file yet when the relay saves slowly. */
async function edit(relay: Relay, room: string, value: string) {
  const writer = await connect(relay.port, room);
  const watcher = await connect(relay.port, room);
  writer.getMap('objects').set('note', value);
  await until(() => watcher.getMap('objects').get('note') === value, 5000, 'the edit did not reach the relay');
}

const roomFile = (room: string) => path.join(h.dir, `${room}.yjs`);
function savedNote(room: string) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, fs.readFileSync(roomFile(room)));
  return doc.getMap('objects').get('note');
}

/** What the newest backup in the fake bucket holds, read with the key like a restore would. */
async function newestBackup() {
  const engine = h.engine();
  const [newest] = await engine.listManifests();
  if (!newest) return null;
  const manifest = await engine.readManifest(newest.name);
  const read = async (file: string) => {
    const entry = manifest.files.find((f: { path: string }) => f.path === file);
    return entry ? ((await engine.readObject(entry.objectId)) as Buffer) : null;
  };
  const noteOf = async (room: string) => {
    const bytes = await read(`${room}.yjs`);
    if (!bytes) return null;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, bytes);
    return doc.getMap('objects').get('note');
  };
  return { name: newest.name as string, paths: manifest.files.map((f: { path: string }) => f.path) as string[], read, noteOf };
}

const manifestPuts = () => h.fake.count('PUT', /manifests/);

/** Waits until a run that is going has made its last request (it reads the manifest back and prunes after the manifest is written). */
async function runEnded(relay: Relay, manifestName: string) {
  await until(() => relay.out().includes(`manifest ${manifestName}`), 10_000, 'the completed backup was not logged');
}

async function timedExit(relay: Relay, limitMs = 60_000) {
  relay.child.send({ type: 'shutdown' });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`relay did not exit: ${relay.err()}`)), limitMs);
  });
  try {
    return await Promise.race([relay.exited, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

afterEach(async () => {
  for (const p of providers.splice(0)) p.destroy();
  for (const r of relays.splice(0)) {
    if (r.child.exitCode === null && r.child.signalCode === null) {
      r.child.kill('SIGKILL');
      await r.exited;
    }
  }
  await h?.close();
});

describe('the settle backup of a running relay', { timeout: 60_000 }, () => {
  it('backs up an edit a few seconds after it, with no interval run', async () => {
    h = await harness({ seed: false });
    const relay = await startRelay({ TABULA_BACKUP_SETTLE_SECONDS: '1', SAVE_DEBOUNCE_MS: '50' });
    expect(relay.out()).toContain('(backups on)');
    expect(h.fake.log).toEqual([]);
    await edit(relay, 'settle-room', 'typed and left alone');
    await until(() => manifestPuts() >= 1, 20_000, 'no backup after the edit');
    expect((await newestBackup())!.paths).toContain('settle-room.yjs');
    expect(await (await newestBackup())!.noteOf('settle-room')).toBe('typed and left alone');
    // the relay is still running, so this was not the shutdown backup
    expect(relay.child.exitCode).toBeNull();
    expect(manifestPuts()).toBe(1);
  });

  it('backs up again after the next edit, and not in between', async () => {
    h = await harness({ seed: false });
    const relay = await startRelay({ TABULA_BACKUP_SETTLE_SECONDS: '1', SAVE_DEBOUNCE_MS: '50' });
    const writer = await connect(relay.port, 'twice-room');
    writer.getMap('objects').set('note', 'first');
    await until(() => manifestPuts() === 1, 20_000, 'no first backup');
    await runEnded(relay, (await newestBackup())!.name);
    const requests = h.fake.log.length;
    await sleep(2500);
    expect(h.fake.log).toHaveLength(requests);
    writer.getMap('objects').set('note', 'second');
    await until(() => manifestPuts() === 2, 20_000, 'no second backup');
    expect(await (await newestBackup())!.noteOf('twice-room')).toBe('second');
  });

  it('does not back up on its own when settling is off, and still does at shutdown', async () => {
    h = await harness({ seed: false });
    const relay = await startRelay({ TABULA_BACKUP_SETTLE_SECONDS: '0', SAVE_DEBOUNCE_MS: '50' });
    await edit(relay, 'quiet-room', 'typed with settling off');
    await until(() => fs.existsSync(roomFile('quiet-room')), 5000, 'the room was not saved');
    await sleep(2500);
    expect(h.fake.log).toEqual([]);
    const exit = await timedExit(relay);
    expect(exit).toEqual({ code: 0, signal: null });
    expect(manifestPuts()).toBe(1);
    expect(await (await newestBackup())!.noteOf('quiet-room')).toBe('typed with settling off');
  });

  it('backs up an image added in open mode', async () => {
    h = await harness({ seed: false });
    const relay = await startRelay({ TABULA_BACKUP_SETTLE_SECONDS: '1' });
    const res = await fetch(`${relay.base}/api/boards/pics/assets`, { method: 'POST', headers: { 'content-type': 'image/png', 'x-tabula': '1' }, body: new Uint8Array(makePng({ width: 4, height: 3 })) });
    expect(res.status).toBe(201);
    const { hash } = (await res.json()) as { hash: string };
    await until(() => manifestPuts() >= 1, 20_000, 'no backup after the upload');
    expect((await newestBackup())!.paths).toContain(`assets/${hash.slice(0, 2)}/${hash}`);
    // a refused upload is not a change
    await runEnded(relay, (await newestBackup())!.name);
    const requests = h.fake.log.length;
    const refused = await fetch(`${relay.base}/api/boards/pics/assets`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: new Uint8Array(makePng()) });
    expect(refused.status).toBe(403);
    await sleep(2500);
    expect(h.fake.log).toHaveLength(requests);
  });

  it('backs up a call of the accounts API that wrote, and the status says it was a settle run', async () => {
    h = await harness({ seed: false });
    const token = 'd'.repeat(48);
    const relay = await startRelay({
      TABULA_AUTH: 'on', TABULA_OWNER_EMAIL: 'owner@example.com', TABULA_CLOUD_TOKEN: token, TABULA_CLOUD_URL: 'http://127.0.0.1:1',
      TABULA_CLOUD_WORKSPACE_ID: 'ws_settle', TABULA_BACKUP_SETTLE_SECONDS: '1',
    });
    const status = async () => (await fetch(`${relay.base}/api/internal/backup-status`, { headers: { authorization: `Bearer ${token}` } })).json() as Promise<Record<string, unknown>>;
    const before = await status();
    expect(before).toMatchObject({ enabled: true, dirty: false, lastTrigger: null, settleSeconds: 1 });
    // a read changes nothing
    expect((await fetch(`${relay.base}/api/internal/usage`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    expect(await status()).toMatchObject({ dirty: false });

    const res = await fetch(`${relay.base}/api/internal/limits`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ banner: 'Hello' }) });
    expect(res.status).toBe(200);
    await until(async () => (await status()).lastTrigger === 'settle', 20_000, 'no settle backup after the call');
    const after = await status();
    expect(after).toMatchObject({ dirty: false, consecutiveFailures: 0, lastTrigger: 'settle' });
    expect(after.lastManifest).toEqual(expect.stringMatching(/\.json\.enc$/));
    // the schedule did not move
    expect(after.nextRunAt).toBe(before.nextRunAt);
    expect((await newestBackup())!.paths).toContain('directory.sqlite');
    expect(JSON.stringify(after)).not.toContain(CREDS.secretKey);
  });

  it('backs up a version of a board named in open mode', async () => {
    h = await harness({ seed: false });
    const relay = await startRelay({ TABULA_BACKUP_SETTLE_SECONDS: '1', SAVE_DEBOUNCE_MS: '50' });
    const writer = await connect(relay.port, 'versions-room');
    writer.getMap('objects').set('note', 'a board with history');
    await until(() => manifestPuts() === 1, 20_000, 'no backup after the edit');
    const before = await newestBackup();
    const indexBefore = (await before!.read('history/versions-room/index.json'))!.toString('utf8');
    const res = await fetch(`${relay.base}/api/boards/versions-room/versions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tabula': '1' }, body: JSON.stringify({ label: 'Before the workshop' }) });
    expect([200, 201]).toContain(res.status);
    await until(() => manifestPuts() === 2, 20_000, 'no backup after the version was named');
    const indexAfter = (await (await newestBackup())!.read('history/versions-room/index.json'))!.toString('utf8');
    expect(indexBefore).not.toContain('Before the workshop');
    expect(indexAfter).toContain('Before the workshop');
  });
});

describe('the final backup of a relay that is asked to stop', { timeout: 100_000 }, () => {
  it.each([false, true])('flushes edits accepted while backup.stop waits, with a blocked final write: %s', async (blocked) => {
    h = await harness({ seed: false });
    h.write('gate-room.yjs', docBytes('holds the backup open'));
    h.write('late-room.yjs', docBytes('before editing'));
    const preload = path.join(h.dir, 'hold-backup-read.mjs');
    fs.writeFileSync(preload, `
      import fs from 'node:fs/promises';
      const readFile = fs.readFile;
      fs.readFile = async function (file, ...options) {
        // the upload reads the staged copy the snapshot barrier made, after the writers were released
        if (String(file).includes('.backup-snapshot-') && String(file).endsWith('gate-room.yjs')) {
          process.send({ type: 'backup-read-blocked' });
          await new Promise(() => {});
        }
        return readFile.call(this, file, ...options);
      };
    `);
    const relay = await startRelay({ TABULA_BACKUP_SETTLE_SECONDS: '1', TABULA_BACKUP_SHUTDOWN_SECONDS: '0', SAVE_DEBOUNCE_MS: '30000' }, preload);
    let readBlocked = false;
    relay.child.on('message', (message: { type?: string }) => {
      if (message.type === 'backup-read-blocked') readBlocked = true;
    });
    const writer = await connect(relay.port, 'late-room');
    const watcher = await connect(relay.port, 'late-room');
    writer.getMap('objects').set('note', 'before shutdown');
    await until(() => watcher.getMap('objects').get('note') === 'before shutdown', 5000, 'the first edit did not sync');
    // Naming the live version triggers a backup without flushing the room's 30-second save timer.
    const named = await fetch(`${relay.base}/api/boards/late-room/versions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tabula': '1' }, body: JSON.stringify({ label: 'Start the backup' }) });
    expect(named.status).toBe(201);
    await until(() => readBlocked, 10_000, 'the backup did not reach the held read');
    const stoppedAt = Date.now();
    const exiting = timedExit(relay);
    await until(() => savedNote('late-room') === 'before shutdown', 5000, 'shutdown did not flush the first edit');
    if (blocked) {
      // A directory where the save writes its temporary file makes every save fail. A save that is writing right now owns the name for a moment.
      const tmp = `${roomFile('late-room')}.tmp`;
      for (let attempt = 0; ; attempt++) {
        try {
          fs.rmSync(tmp, { force: true });
          fs.mkdirSync(tmp);
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 50) throw err;
          await sleep(10);
        }
      }
    }
    writer.getMap('objects').set('note', 'during backup stop');
    await until(() => watcher.getMap('objects').get('note') === 'during backup stop', 5000, 'the edit during backup stop did not sync');
    const exit = await exiting;
    const ms = Date.now() - stoppedAt;
    expect(exit).toEqual({ code: blocked ? 1 : 0, signal: null });
    expect(savedNote('late-room')).toBe(blocked ? 'before shutdown' : 'during backup stop');
    // The held read never resolves: the existing two-second stop budget must still end shutdown.
    expect(ms).toBeGreaterThanOrEqual(1800);
    expect(ms).toBeLessThan(2000 + 2500);
  });

  it('backs up what was edited moments ago, before it exits', async () => {
    h = await harness({ seed: false });
    // the room is written 30 seconds after an edit and settling is an hour away: only the shutdown can save and back it up
    const relay = await startRelay({ TABULA_BACKUP_SETTLE_SECONDS: '3600', SAVE_DEBOUNCE_MS: '30000' });
    await edit(relay, 'final-room', 'typed just before the stop');
    expect(fs.existsSync(roomFile('final-room'))).toBe(false);
    expect(h.fake.log).toEqual([]);

    const exit = await timedExit(relay);
    expect(exit).toEqual({ code: 0, signal: null });
    expect(manifestPuts()).toBe(1);
    expect(savedNote('final-room')).toBe('typed just before the stop');
    expect(await (await newestBackup())!.noteOf('final-room')).toBe('typed just before the stop');
  });

  it('exits without a request to the bucket when nothing changed, with a room open', async () => {
    h = await harness({ seed: false });
    const seeded = docBytes('already saved and untouched');
    h.write('seeded.yjs', seeded);
    const relay = await startRelay({ TABULA_BACKUP_SETTLE_SECONDS: '3600' });
    const doc = await connect(relay.port, 'seeded');
    expect(doc.getMap('objects').get('note')).toBe('already saved and untouched');
    const exit = await timedExit(relay);
    expect(exit).toEqual({ code: 0, signal: null });
    expect(h.fake.log).toEqual([]);
  });

  it('exits without a request to the bucket when nothing was ever opened', async () => {
    h = await harness({ seed: false });
    const relay = await startRelay();
    const exit = await timedExit(relay);
    expect(exit).toEqual({ code: 0, signal: null });
    expect(h.fake.log).toEqual([]);
  });

  it('keeps to its budget when the bucket does not answer, and still saves the room', async () => {
    h = await harness({ seed: false });
    h.fake.rules.push({ hang: true, times: 999 });
    const relay = await startRelay({ TABULA_BACKUP_SETTLE_SECONDS: '3600', TABULA_BACKUP_SHUTDOWN_SECONDS: '1', SAVE_DEBOUNCE_MS: '30000' });
    await edit(relay, 'hung-room', 'typed while the bucket is down');
    const exit = await timedExit(relay);
    expect(exit).toEqual({ code: 0, signal: null });
    expect(h.fake.keys(/manifests/)).toEqual([]);
    expect(savedNote('hung-room')).toBe('typed while the bucket is down');
    expect(relay.err()).not.toContain('Error');
  });

  it('does not back up at shutdown when the shutdown backup is off', async () => {
    h = await harness({ seed: false });
    const relay = await startRelay({ TABULA_BACKUP_SETTLE_SECONDS: '3600', TABULA_BACKUP_SHUTDOWN_SECONDS: '0', SAVE_DEBOUNCE_MS: '30000' });
    await edit(relay, 'off-room', 'typed before a stop with no final backup');
    const exit = await timedExit(relay);
    expect(exit).toEqual({ code: 0, signal: null });
    expect(h.fake.log).toEqual([]);
    expect(savedNote('off-room')).toBe('typed before a stop with no final backup');
  });

  it('refuses a malformed setting at start without printing it', async () => {
    h = await harness({ seed: false });
    const bad = 'canary-setting-4c1e9d';
    const port = await freePort();
    const child = spawn(process.execPath, ['server/relay.mjs'], {
      env: { ...process.env, PORT: String(port), DATA_DIR: h.dir, HOST: '127.0.0.1', TABULA_AUTH: 'off', ...envFor(h.fake), TABULA_BACKUP_SETTLE_SECONDS: bad },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    child.stdout!.on('data', (d) => (text += d));
    child.stderr!.on('data', (d) => (text += d));
    const code = await new Promise<number | null>((resolve) => child.once('exit', (c) => resolve(c)));
    expect(code).not.toBe(0);
    expect(text).toContain('TABULA_BACKUP_SETTLE_SECONDS must be a whole number from 0 to 3600');
    expect(text).not.toContain(bad);
    expect(text).not.toContain(CREDS.secretKey);
  });
});
