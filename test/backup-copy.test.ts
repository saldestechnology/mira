import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { waitForCopy } from '../server/backup.mjs';
import { COPY_JOB, copyDatabase } from '../server/backup-copy-worker.mjs';
import { CREDS, HOUR, KEY, harness, type Engine, type Harness } from './backup-harness';

// docs/backups.md, When it runs. The two SQLite steps of the database copy (VACUUM INTO, then the second pass on the
// copy) run in a worker thread, so the event loop of the server is not held while a large database is copied.

let h: Harness;
const scratch: string[] = [];
afterEach(async () => {
  await h?.close();
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const WORKER_FILE = new URL('../server/backup-copy-worker.mjs', import.meta.url);
const STATUS_KEY = 'backup.status';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!test()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await sleep(5);
  }
}
const temps = () => fs.readdirSync(h.dir).filter((n) => n.includes('.backup-') && !n.startsWith('.backup-snapshot-'));
const snapshotDirs = () => fs.readdirSync(h.dir).filter((n) => n.startsWith('.backup-snapshot-'));
const scratchDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-copy-'));
  scratch.push(dir);
  return dir;
};

/** Rows that stay in the copy: about `megabytes` of audit log, written in one transaction. */
function pad(megabytes: number) {
  const db = new DatabaseSync(h.file('directory.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(
      `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${megabytes * 100})
       INSERT INTO audit (ts, actor_id, action, detail) SELECT x, NULL, 'test.pad', '{"pad":"' || hex(randomblob(5000)) || '"}' FROM c`,
    );
  } finally {
    db.close();
  }
}

const realWorker = (source: string, tmp: string) =>
  new Worker(WORKER_FILE, { workerData: { job: COPY_JOB, source, tmp, statusKey: STATUS_KEY }, env: {}, execArgv: ['--disable-warning=ExperimentalWarning'] });

class FakeWorker extends EventEmitter {
  terminated = 0;
  constructor(
    readonly file: URL,
    readonly options: { workerData: { source: string; tmp: string; statusKey: string; job: string }; env?: unknown; execArgv?: string[] },
    script: (worker: FakeWorker) => void,
  ) {
    super();
    setImmediate(() => script(this));
  }
  terminate() {
    this.terminated++;
    return Promise.resolve(1);
  }
}
/** A worker factory whose workers never open a database: `script` plays what the thread would do. */
function fakeWorkers(script: (worker: FakeWorker) => void) {
  const made: FakeWorker[] = [];
  return {
    made,
    factory: (file: URL, options: FakeWorker['options']) => {
      const worker = new FakeWorker(file, options, script);
      made.push(worker);
      return worker;
    },
  };
}
const PAYLOAD = Buffer.from('not a database, written by a fake worker');
const answers = (worker: FakeWorker) => {
  fs.writeFileSync(worker.options.workerData.tmp, PAYLOAD);
  worker.emit('message', { ok: true });
  worker.emit('exit', 0);
};

const databaseObject = async (engine: Engine) => {
  const manifest = await engine.readManifest((await engine.listManifests())[0].name);
  return manifest.files.find((f: { path: string }) => f.path === 'directory.sqlite') as { objectId: string; size: number };
};

describe('the copy of a database', () => {
  it('is byte for byte what the in-thread copy gives, for the directory and for a database without the engine\'s tables', async () => {
    h = await harness({ accounts: true });
    h.directory!.setSetting(STATUS_KEY, JSON.stringify({ lastSuccessAt: 1 }));
    h.directory!.audit(null, 'backup.run', { files: 1 });
    h.directory!.audit(null, 'backup.failed', { error: 'x' });
    pad(1);
    const dir = scratchDir();
    const chat = path.join(dir, 'chat.sqlite');
    const db = new DatabaseSync(chat);
    db.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO messages (body) VALUES ('hello'), ('world')");
    db.close();

    for (const source of [h.file('directory.sqlite'), chat]) {
      const inThread = path.join(dir, `in-thread-${path.basename(source)}`);
      const inWorker = path.join(dir, `in-worker-${path.basename(source)}`);
      await copyDatabase(source, inThread, STATUS_KEY);
      await waitForCopy(realWorker(source, inWorker));
      expect(fs.readFileSync(inWorker).equals(fs.readFileSync(inThread))).toBe(true);
      expect(fs.statSync(inWorker).size).toBeGreaterThan(0);
    }

    const copy = new DatabaseSync(path.join(dir, 'in-worker-directory.sqlite'), { readOnly: true });
    expect(copy.prepare('SELECT value FROM settings WHERE key = ?').get(STATUS_KEY)).toBeUndefined();
    expect((copy.prepare("SELECT COUNT(*) AS n FROM audit WHERE action LIKE 'backup.%'").get() as { n: number }).n).toBe(0);
    expect((copy.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'test.pad'").get() as { n: number }).n).toBe(100);
    copy.close();
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('-journal') || n.endsWith('-wal') || n.endsWith('-shm'))).toEqual([]);
  });

  it('is the same backup as one taken in the main thread: the next run finds nothing changed', async () => {
    h = await harness({ accounts: true });
    const logsBefore = h.logs.length;
    const first = h.engine();
    expect(await first.runNow()).toMatchObject({ ok: true, changed: true });
    const before = await databaseObject(first);

    h.clock.now += HOUR;
    const inThread = h.engine({
      workerFactory: () => {
        throw new Error('no threads here');
      },
    });
    expect(await inThread.runNow()).toMatchObject({ ok: true, changed: false, uploaded: 0 });
    expect((await databaseObject(inThread)).objectId).toBe(before.objectId);
    expect(h.logs.slice(logsBefore).filter((l) => l.includes('copying in the main thread'))).toHaveLength(1);
    expect(temps()).toEqual([]);

    h.clock.now += HOUR;
    expect(await h.engine().runNow()).toMatchObject({ ok: true, changed: false, uploaded: 0 });
  });

  it('runs in the thread the factory makes, and the main thread never opens the database to copy it', async () => {
    h = await harness({ accounts: true });
    const { made, factory } = fakeWorkers(answers);
    const engine = h.engine({ workerFactory: factory });
    expect(await engine.runNow()).toMatchObject({ ok: true });
    expect(made).toHaveLength(1);
    const { workerData, ...options } = made[0].options;
    expect(made[0].file.pathname.endsWith('/server/backup-copy-worker.mjs')).toBe(true);
    expect(workerData).toMatchObject({ job: COPY_JOB, statusKey: STATUS_KEY, source: h.file('directory.sqlite') });
    expect(path.dirname(workerData.tmp)).toBe(h.dir);
    expect(path.basename(workerData.tmp)).toMatch(/^directory\.sqlite\.backup-[0-9a-f]{16}\.tmp$/);
    // None of this process's environment goes to the thread, and none of the secrets.
    expect(options.env).toEqual({});
    expect(JSON.stringify({ workerData, options })).not.toContain(CREDS.secretKey);
    expect(JSON.stringify({ workerData, options })).not.toContain(KEY.toString('base64'));
    // What was stored is what the thread wrote: the main thread did not copy the database itself.
    const entry = await databaseObject(engine);
    expect((await engine.readObject(entry.objectId)).equals(PAYLOAD)).toBe(true);
    expect(entry.size).toBe(PAYLOAD.length);
    expect(temps()).toEqual([]);
  });

  it('copies the chat database through a thread as well, one thread for each database', async () => {
    h = await harness({ accounts: true });
    const chat = new DatabaseSync(h.file('chat.sqlite'));
    chat.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO messages (body) VALUES ('hi')");
    chat.close();
    const { made, factory } = fakeWorkers(answers);
    expect(await h.engine({ workerFactory: factory }).runNow()).toMatchObject({ ok: true });
    expect(made.map((w) => path.basename(w.options.workerData.source))).toEqual(['directory.sqlite', 'chat.sqlite']);
  });

  it('keeps the application\'s own thread free while a database of about 20 MB is copied', async () => {
    // The snapshot barrier abandons a copy that outlasts its hold limit (5 s by default); a slow Windows runner copies 40 MB in
    // about that time. This test is about the main thread staying free, not about the hold, so it gets the largest limit.
    h = await harness({ accounts: true, env: { TABULA_BACKUP_SNAPSHOT_MAX_HOLD_SECONDS: '60' } });
    pad(40);
    expect(fs.statSync(h.file('directory.sqlite')).size).toBeGreaterThan(39 * 1024 * 1024);
    const copying = { from: 0, to: 0 };
    const engine = h.engine({
      workerFactory: (_file: URL, options: { workerData: { source: string; tmp: string } }) => {
        const worker = realWorker(options.workerData.source, options.workerData.tmp);
        copying.from = performance.now();
        worker.once('message', () => (copying.to = performance.now()));
        return worker;
      },
    });
    const ticks: number[] = [];
    const timer = setInterval(() => ticks.push(performance.now()), 10);
    const result = await engine.runNow();
    clearInterval(timer);
    if (!result.ok) throw new Error(`the run failed: ${JSON.stringify(result)}`);
    expect(result).toMatchObject({ ok: true, changed: true });
    const length = copying.to - copying.from;
    const during = ticks.filter((t) => t >= copying.from && t <= copying.to);
    // A copy this size gives the 10 ms interval a chance to run; the assertion tests for any main-thread work during it.
    expect(length).toBeGreaterThan(0);
    expect(during.length).toBeGreaterThanOrEqual(1);
    expect((await databaseObject(engine)).size).toBeGreaterThan(39 * 1024 * 1024);
  });
});

describe('a copy that fails or is stopped', () => {
  const FAILED = (text: string) => ({ ok: false, error: expect.stringContaining(text) });

  it('turns the answer of a database that is not SQLite into the error the main thread gave, with no path in it', async () => {
    h = await harness();
    h.write('directory.sqlite', 'plain text, not a database '.repeat(40));
    const viaWorker = await h.engine().runNow();
    expect(viaWorker).toMatchObject(FAILED('ERR_SQLITE_ERROR: file is not a database'));
    expect(temps()).toEqual([]);

    const viaMainThread = await h.engine({
      workerFactory: () => {
        throw new Error('no threads here');
      },
    }).runNow();
    expect(viaMainThread.error).toBe(viaWorker.error);
    expect(viaWorker.error).not.toContain(h.dir);
    expect(temps()).toEqual([]);
    expect(h.fake.keys(/manifests/)).toEqual([]);
    expect(h.logs.some((l) => l.startsWith('backup: failed:'))).toBe(true);
  });

  it('gives the same rejection for a database that is not there, from a thread and from the main thread', async () => {
    h = await harness();
    const dir = scratchDir();
    const missing = path.join(dir, 'no', 'such', 'directory.sqlite');
    const tmp = path.join(dir, 'copy.tmp');
    const failure = (done: Promise<unknown>) =>
      done.then(
        () => {
          throw new Error('expected a failure');
        },
        (err) => err as Error & { code: string },
      );
    const inMain = await failure(copyDatabase(missing, tmp, STATUS_KEY));
    const inThread = await failure(waitForCopy(realWorker(missing, tmp)));
    expect(inMain).toBeInstanceOf(Error);
    expect(inThread).toBeInstanceOf(Error);
    expect(inThread.code).toBe('ERR_SQLITE_ERROR');
    expect([inThread.code, inThread.message]).toEqual([inMain.code, inMain.message]);
    expect(inThread.message).toBe('unable to open database file');
    expect(inThread.message).not.toContain(dir);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it.each([
    ['a failure that SQLite reports', (w: FakeWorker) => w.emit('message', { ok: false, code: 'ERR_SQLITE_ERROR', detail: 'disk I/O error' }), 'ERR_SQLITE_ERROR: disk I/O error'],
    ['a failure with only a code', (w: FakeWorker) => w.emit('message', { ok: false, code: 'ENOSPC' }), 'ENOSPC: The database copy failed'],
    ['a code that is not a code', (w: FakeWorker) => w.emit('message', { ok: false, code: '/etc/secret path', detail: { x: 1 } }), 'ERROR: The database copy failed'],
    ['a thread that crashes', (w: FakeWorker) => w.emit('error', new Error(`boom in /secret/${CREDS.secretKey}`)), 'ERROR: The database copy worker failed'],
    ['a thread that stops without an answer', (w: FakeWorker) => w.emit('exit', 3), 'ERR_WORKER_EXIT: The database copy worker stopped without an answer (exit code 3)'],
  ])('fails the run, and leaves no temporary file, on %s', async (_name, then, expected) => {
    h = await harness({ accounts: true });
    const { factory } = fakeWorkers((worker) => {
      fs.writeFileSync(worker.options.workerData.tmp, 'half a copy');
      fs.writeFileSync(`${worker.options.workerData.tmp}-journal`, 'half a journal');
      then(worker);
    });
    const result = await h.engine({ workerFactory: factory }).runNow();
    expect(result).toMatchObject({ ok: false, error: expected });
    expect(result.error).not.toContain('/secret');
    expect(result.error).not.toContain(CREDS.secretKey);
    expect(temps()).toEqual([]);
    expect(h.fake.keys(/manifests/)).toEqual([]);
  });

  it('terminates the thread and removes the temporary copy when the engine is stopped during the copy', async () => {
    h = await harness({ accounts: true });
    const { made, factory } = fakeWorkers((worker) => fs.writeFileSync(worker.options.workerData.tmp, 'half a copy'));
    const engine = h.engine({ workerFactory: factory });
    const run = engine.runNow();
    await until(() => made.length === 1 && temps().length === 1);
    await expect(engine.stop()).resolves.toBeUndefined();
    expect(await run).toMatchObject({ ok: false, aborted: true });
    expect(made[0].terminated).toBe(1);
    expect(temps()).toEqual([]);
    expect(snapshotDirs()).toEqual([]);
    expect(h.fake.keys(/manifests/)).toEqual([]);
    expect(engine.status().lastError).toBeNull();
  });

  it('stops a real thread at once, and no copy is left behind once it is gone', async () => {
    h = await harness({ accounts: true });
    pad(5);
    const workers: { exited: Promise<number>; answers: number }[] = [];
    const engine: Engine = h.engine({
      workerFactory: (_file: URL, options: { workerData: { source: string; tmp: string } }) => {
        const worker = realWorker(options.workerData.source, options.workerData.tmp);
        const seen = { exited: new Promise<number>((resolve) => worker.once('exit', resolve)), answers: 0 };
        worker.on('message', () => seen.answers++);
        workers.push(seen);
        queueMicrotask(() => void engine.stop());
        return worker;
      },
    });
    expect(await engine.runNow()).toMatchObject({ ok: false, aborted: true });
    expect(workers).toHaveLength(1);
    // A thread that was left to finish would copy the database and say so; this one is gone before it can.
    await workers[0].exited;
    expect(workers[0].answers).toBe(0);
    expect(temps()).toEqual([]);
    expect(h.fake.keys(/manifests/)).toEqual([]);
  });

  it('stops a real thread that is in the middle of the copy, and what it leaves is removed once it is gone', async () => {
    h = await harness({ accounts: true });
    pad(20);
    const seen: { exited: Promise<number>; answers: number }[] = [];
    const engine: Engine = h.engine({
      workerFactory: (_file: URL, options: { workerData: { source: string; tmp: string } }) => {
        const worker = realWorker(options.workerData.source, options.workerData.tmp);
        const one = { exited: new Promise<number>((resolve) => worker.once('exit', resolve)), answers: 0 };
        worker.on('message', () => one.answers++);
        seen.push(one);
        return worker;
      },
    });
    const run = engine.runNow();
    await until(() => temps().length > 0);
    await engine.stop();
    expect(await run).toMatchObject({ ok: false, aborted: true });
    await seen[0].exited;
    await until(() => temps().length === 0);
    expect(seen[0].answers).toBe(0);
    expect(temps()).toEqual([]);
    expect(h.fake.keys(/manifests/)).toEqual([]);
  });

  it('falls back to the main thread, with one log line for each copy, when a thread cannot be made', async () => {
    h = await harness({ accounts: true });
    const chat = new DatabaseSync(h.file('chat.sqlite'));
    chat.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO messages (body) VALUES ('hi')");
    chat.close();
    let tries = 0;
    const engine = h.engine({
      workerFactory: () => {
        tries++;
        throw Object.assign(new Error(`cannot start ${CREDS.secretKey}`), { code: 'ERR_WORKER_INIT_FAILED' });
      },
    });
    expect(await engine.runNow()).toMatchObject({ ok: true, changed: true });
    expect(tries).toBe(2);
    const lines = h.logs.filter((l) => l.includes('copying in the main thread'));
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).not.toContain(CREDS.secretKey);
    const manifest = await engine.readManifest((await engine.listManifests())[0].name);
    const entry = manifest.files.find((f: { path: string }) => f.path === 'directory.sqlite');
    expect((await engine.readObject(entry.objectId)).toString('latin1', 0, 15)).toBe('SQLite format 3');
    expect(temps()).toEqual([]);
  });
});

describe('waiting for the copy', () => {
  const worker = () => new FakeWorker(WORKER_FILE, { workerData: { source: 's', tmp: 't', statusKey: 'k', job: COPY_JOB } }, () => {});

  it('does not throw an error event that comes after the answer', async () => {
    const w = worker();
    const done = waitForCopy(w);
    w.emit('message', { ok: true });
    await done;
    expect(() => w.emit('error', new Error('late'))).not.toThrow();
    expect(() => w.emit('exit', 1)).not.toThrow();
  });

  it('answers once: the first of the message, the error and the exit counts', async () => {
    const w = worker();
    const done = waitForCopy(w);
    w.emit('message', { ok: false, code: 'ERR_SQLITE_ERROR', detail: 'database is locked' });
    w.emit('message', { ok: true });
    w.emit('exit', 0);
    await expect(done).rejects.toMatchObject({ code: 'ERR_SQLITE_ERROR', message: 'database is locked' });
  });

  it('on abort terminates the thread, rejects at once and cleans up when the thread is gone', async () => {
    const w = worker();
    const controller = new AbortController();
    const order: string[] = [];
    let gone: () => void = () => {};
    w.terminate = () => {
      order.push('terminate');
      return new Promise<number>((resolve) => (gone = () => resolve(1)));
    };
    const done = waitForCopy(w, { signal: controller.signal, cleanup: () => order.push('cleanup') });
    controller.abort();
    await expect(done).rejects.toMatchObject({ code: 'aborted' });
    expect(order).toEqual(['terminate']);
    gone();
    await until(() => order.length === 2);
    expect(order).toEqual(['terminate', 'cleanup']);
  });

  it('rejects at once when the signal is already aborted, and when terminate throws', async () => {
    const w = worker();
    w.terminate = () => {
      throw new Error('already gone');
    };
    const controller = new AbortController();
    controller.abort();
    let cleaned = false;
    await expect(waitForCopy(w, { signal: controller.signal, cleanup: () => (cleaned = true) })).rejects.toMatchObject({ code: 'aborted' });
    await until(() => cleaned);
  });

  it('is not started again by a second run while the first is in the copy', async () => {
    h = await harness({ accounts: true });
    const { made, factory } = fakeWorkers(() => {});
    const engine = h.engine({ workerFactory: factory });
    const first = engine.runNow();
    await until(() => made.length === 1);
    expect(await engine.runNow()).toMatchObject({ ok: false, skipped: 'running' });
    expect(made).toHaveLength(1);
    await engine.stop();
    expect(await first).toMatchObject({ aborted: true });
  });
});
