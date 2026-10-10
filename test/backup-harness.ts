import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { createBackup, loadBackupConfig } from '../server/backup.mjs';
import { openDirectory } from '../server/directory.mjs';
import type { createSnapshotBarrier } from '../server/snapshot-barrier.mjs';
import { startFakeS3, type FakeS3 } from './backup-fake-s3';

// Shared by the backup engine tests: a data directory like the relay's, a fake S3, a clock the test moves, and the
// recognisable credentials the leak tests search for.

export const CREDS = { accessKey: 'AKIACANARYACCESS0001', secretKey: 'canary/secret+key/9f2b7c1d4e8a5033b6d0aa17', region: 'auto', bucket: 'test-bucket' };
export const KEY = crypto.createHash('sha256').update('canary master key').digest();
export const KEY_PREVIOUS = crypto.createHash('sha256').update('canary previous key').digest();
export const KEY_OTHER = crypto.createHash('sha256').update('canary another key').digest();
export const T0 = Date.UTC(2026, 9, 8, 19, 30, 0);
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const VERSION_A = 'AAAAAAAAAAAAAAAA';
export const VERSION_B = 'BBBBBBBBBBBBBBBB';
export const VERSION_C = 'CCCCCCCCCCCCCCCC';

export type Dir = ReturnType<typeof openDirectory>;
export type Engine = NonNullable<ReturnType<typeof createBackup>>;

export const docBytes = (text: string) => {
  const doc = new Y.Doc();
  doc.getMap('objects').set('note', text);
  const bytes = Buffer.from(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  return bytes;
};

export const envFor = (fake: FakeS3, extra: Record<string, string> = {}): Record<string, string> => ({
  TABULA_BACKUP_S3_ENDPOINT: fake.url,
  TABULA_BACKUP_BUCKET: CREDS.bucket,
  TABULA_BACKUP_ACCESS_KEY: CREDS.accessKey,
  TABULA_BACKUP_SECRET_KEY: CREDS.secretKey,
  TABULA_BACKUP_KEY: KEY.toString('base64'),
  ...extra,
});

export type Harness = Awaited<ReturnType<typeof harness>>;

export async function harness({ accounts = false, env = {}, pageSize = 1000, seed = true, snapshotBarrier = null }: { accounts?: boolean; env?: Record<string, string>; pageSize?: number; seed?: boolean; snapshotBarrier?: ReturnType<typeof createSnapshotBarrier> | null } = {}) {
  const clock = { now: T0 };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-backup-'));
  const fake = await startFakeS3({ creds: CREDS, clock: () => clock.now, pageSize });
  const logs: string[] = [];
  const engines: Engine[] = [];
  const directory: Dir | null = accounts ? openDirectory(path.join(dir, 'directory.sqlite'), { snapshotBarrier }) : null;
  if (directory) {
    directory.createUser({ email: 'owner@example.com', name: 'Owner', role: 'owner' });
    directory.createUser({ email: 'member@example.com', name: 'Member', role: 'member' });
    directory.audit(null, 'test.seed', { n: 1 });
  }

  const file = (rel: string) => path.join(dir, rel);
  const write = (rel: string, data: Buffer | string) => {
    fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
    fs.writeFileSync(file(rel), data);
  };
  const config = () => {
    const loaded = loadBackupConfig(envFor(fake, env), () => {})!;
    // The snapshot barrier abandons a copy that outlasts its hold (5 s by default) and the run then fails. A loaded CI runner can
    // take that long for a run of these tests, so every backup test gets the largest hold unless it names its own.
    if (env.TABULA_BACKUP_SNAPSHOT_MAX_HOLD_SECONDS === undefined) loaded.snapshotMaxHoldSeconds = 60;
    return loaded;
  };

  const index = (ids: string[]) =>
    Buffer.from(JSON.stringify({ v: 1, versions: ids.map((id, i) => ({ id, createdAt: 1000 + i, kind: 'auto', label: null, by: null, byName: null, objects: 1, bytes: 10, hash: `h${i}`, from: null })) }));

  if (seed) {
    write('b1.yjs', docBytes('board one'));
    write('b1~comments.yjs', docBytes('comments of one'));
    write('b2.yjs', docBytes('board two'));
    write(`history/b1/${VERSION_A}.yjs.gz`, Buffer.from('version a bytes'));
    write(`history/b1/${VERSION_B}.yjs.gz`, Buffer.from('version b bytes'));
    write('history/b1/index.json', index([VERSION_A, VERSION_B]));
    // Things that must never be backed up.
    write('b1.yjs.tmp', 'half written');
    write('outbox.jsonl', '{"to":"someone@example.com","text":"sign-in link"}\n');
    write('notes.txt', 'not data of ours');
    write('history/b1/index.json.corrupt-1700000000000', 'old');
    write('history/b1/ORPHANORPHANORPH.yjs.gz', 'unlisted version');
    write('history/b1/leftover.tmp', 'x');
    write('history/not a board/index.json', '{}');
    write('directory.sqlite.backup-0000000000000000.tmp', 'stale copy of an earlier crashed run');
  }

  const expectedPaths = () =>
    [
      ...(accounts ? ['directory.sqlite'] : []),
      'b1.yjs', 'b1~comments.yjs', 'b2.yjs',
      `history/b1/${VERSION_A}.yjs.gz`, `history/b1/${VERSION_B}.yjs.gz`, 'history/b1/index.json',
    ].sort();

  function engine(options: Record<string, unknown> = {}): Engine {
    const made = createBackup({
      config: (options.config as never) ?? config(),
      dataDir: dir,
      directory,
      log: (...args: unknown[]) => logs.push(args.join(' ')),
      now: () => clock.now,
      backoffMs: [0, 0, 0],
      random: () => 0,
      ...options,
    }) as Engine;
    engines.push(made);
    return made;
  }

  /** Moves the clock and runs a backup. */
  async function runAt(e: Engine, at: number) {
    clock.now = at;
    return e.runNow();
  }

  async function close() {
    await Promise.all(engines.map((e) => e.stop()));
    directory?.close();
    await fake.close();
    // A worker that was just stopped can still hold its temporary copy for a moment on Windows (EBUSY).
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }

  return { clock, dir, fake, logs, directory, file, write, config, engine, expectedPaths, runAt, close, index };
}
