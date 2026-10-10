import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import * as Y from 'yjs';
import { createBackup, loadBackupConfig } from '../../server/backup.mjs';
import { CREDS, KEY, KEY_OTHER, envFor } from '../backup-harness';
import { startFakeS3, type FakeS3 } from '../backup-fake-s3';
import { CONFIRM, filesOf } from '../restore-harness';
import { makePng } from '../image-fixtures';
import { createRelayKit, sleep, until, type Relay } from './drill-kit';

// TAB-94, the ops runbook section 8, rehearsed locally: `npm run drill:local` (scripts/drill-local.mjs) runs this file
// and prints a checklist of the runbook boxes from the test titles. Each title starts with its box id in brackets.
// Every relay is server/relay.mjs as `npm start` runs it (drill-kit.ts, within RELAY_START_MS), with backups to the fake
// S3 of the backup tests and a fake control plane; the disk is the stub TABULA_TEST_RESTORE_DISK_USED. The boxes run in
// order on one workspace and depend on each other; a box that fails makes the ones after it fail too.

const CLOUD_TOKEN = 'd'.repeat(48);
const WORKSPACE = 'ws_drill';
const KEY_NEW = crypto.createHash('sha256').update('drill rotated key').digest();
const OWNER = 'owner@example.com';
const MEMBER = 'member@example.com';
const ADMIN = 'admin@example.com';
const TEAM = 'Kestrel Design Team';
const TEAM_GONE = 'Osprey Field Team';
const B1 = 'kestrelRoadmapBoard';
const B2 = 'kestrelPictureBoard';
const B3 = 'ospreyPlanBoard';
const TITLES = { [B1]: 'Kestrel Roadmap 2027', [B2]: 'Kestrel Moodboard', [B3]: 'Osprey Field Plan' };
const NOTE = 'Kestrel quarterly goals';
const COMMENT = 'Kestrel comment on the goals';
const CHAT = 'Kestrel chat before the drill';
const VERSION_LABEL = 'Kestrel milestone';
const FALLBACK = 'The original team no longer exists or you cannot see it, so the copy is in your personal space.';
const PICTURE = makePng({ width: 9, height: 7 });
const PICTURE_HASH = crypto.createHash('sha256').update(PICTURE).digest('hex');

const kit = createRelayKit(CLOUD_TOKEN);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-drill-'));
const mainDir = path.join(scratch, 'data');
fs.mkdirSync(mainDir);
const fakes: FakeS3[] = [];
let fake: FakeS3;
let controlPlane: http.Server;
let controlUrl = '';

/** What the runner puts into the drill record: measured here, on this machine. */
const measured: Record<string, unknown> = {};
function note(key: string, value: unknown) {
  measured[key] = value;
  if (process.env.DRILL_REPORT_FILE) fs.writeFileSync(process.env.DRILL_REPORT_FILE, JSON.stringify(measured, null, 2));
}

beforeAll(async () => {
  controlPlane = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => controlPlane.listen(0, '127.0.0.1', resolve));
  controlUrl = `http://127.0.0.1:${(controlPlane.address() as AddressInfo).port}`;
  fake = await startFakeS3({ creds: CREDS });
  fakes.push(fake);
});

afterAll(async () => {
  kit.closeClients();
  await kit.killAll();
  for (const f of fakes) await f.close();
  await new Promise<void>((resolve) => controlPlane.close(() => resolve()));
  fs.rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------- helpers

const keyEnv = (key: Buffer, previous?: Buffer) => ({ TABULA_BACKUP_KEY: key.toString('base64'), ...(previous ? { TABULA_BACKUP_KEY_PREVIOUS: previous.toString('base64') } : {}) });
let currentKeys = keyEnv(KEY);

/** A hosted workspace with backups, chat and a Fly volume id, as in production; settle 1 s so a backup follows each change. */
const relayEnv = (bucket: FakeS3, extra: Record<string, string> = {}) => ({
  TABULA_CLOUD_TOKEN: CLOUD_TOKEN, TABULA_CLOUD_URL: controlUrl, TABULA_CLOUD_WORKSPACE_ID: WORKSPACE,
  TABULA_CHAT: 'on', TABULA_FLY_VOLUME_ID: 'vol_drill_1',
  ...envFor(bucket), ...currentKeys, TABULA_BACKUP_SETTLE_SECONDS: '1',
  TABULA_TEST_RESTORE_EXIT_DELAY_MS: '2500', TABULA_TEST_RESTORE_DISK_USED: '0.2',
  ...extra,
});

const start = (dir: string, env: Record<string, string>) => kit.launch(dir, env, { clean: true });

/** Reads the bucket the way a restore does, with the given keys (the newest first). */
function reader(bucket: FakeS3, keys: Buffer[] = [KEY_NEW, KEY]) {
  const config = loadBackupConfig(envFor(bucket, { TABULA_BACKUP_KEY: keys[0].toString('base64'), ...(keys.length > 1 ? { TABULA_BACKUP_KEY_PREVIOUS: keys.slice(1).map((k) => k.toString('base64')).join(',') } : {}) }), () => {})!;
  const dir = fs.mkdtempSync(path.join(scratch, 'reader-'));
  return createBackup({ config, dataDir: dir, directory: null, log: () => {} })!;
}
const manifestsOf = (bucket: FakeS3) => bucket.keys(/\/manifests\//).map((k) => k.split('/').pop()!).sort();
const newestOf = (bucket: FakeS3) => manifestsOf(bucket).at(-1)!;

/** The files of a manifest other than the databases, decrypted: relative path to bytes. */
async function contentOf(bucket: FakeS3, name: string) {
  const r = reader(bucket);
  const manifest = await r.readManifest(name);
  const out = new Map<string, Buffer>();
  for (const f of manifest.files as { path: string; objectId: string }[]) {
    if (f.path.endsWith('.sqlite')) continue;
    out.set(f.path, Buffer.from(await r.readObject(f.objectId)));
  }
  return { manifest, files: out };
}

/** The room files, history and pictures in a data directory. */
function liveFiles(dir: string) {
  const out = filesOf(dir);
  const assets = path.join(dir, 'assets');
  if (fs.existsSync(assets)) for (const sub of fs.readdirSync(assets)) for (const f of fs.readdirSync(path.join(assets, sub))) out.set(`assets/${sub}/${f}`, fs.readFileSync(path.join(assets, sub, f)));
  return out;
}

const docOf = (bytes: Buffer) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  return doc;
};

type Client = ReturnType<typeof kit.client>;

/** Waits until a backup run that started after `since` has succeeded and nothing is waiting to be backed up. */
async function backedUpSince(c: Client, since: number, ms = 20_000) {
  let last: any;
  await until(async () => {
    last = (await c.internal('/api/internal/backup-status')).body;
    return last.lastSuccessAt >= since && !last.running && !last.dirty;
  }, ms);
  return last;
}

/** A change through the API (a chat message), which marks the workspace changed like any write. */
let chatSeq = 0;
const change = (c: Client, cookie: string) => c.api(cookie, 'POST', `/api/chat/board/${B1}/messages`, { text: `drill change ${++chatSeq}`, clientId: `drillchange${String(chatSeq).padStart(4, '0')}` });

async function cloneBucket(from: FakeS3) {
  const clone = await startFakeS3({ creds: CREDS });
  fakes.push(clone);
  for (const [k, v] of from.objects) clone.objects.set(k, { body: Buffer.from(v.body), lastModified: v.lastModified });
  return clone;
}

function freshDir(name: string) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const entries = async (c: Client, cookie: string, action: string) => (await c.api(cookie, 'GET', `/api/admin/audit?limit=200&action=${action}`)).body.entries as { action: string; detail: any }[];

// ---------------------------------------------------------------- the drill

const s: {
  relay?: Relay; c?: Client; owner?: string; member?: string; admin?: string; ownerId?: string; teamId?: string;
  first?: string; afterShutdown?: string; withOsprey?: string; wholeReply?: any; disasterNewest?: string;
} = {};

describe('local restore drill (runbook section 8)', () => {
  it('[setup.seed] a workspace with every kind of data: people, a team, boards, a comment, a picture, a named version, chat', async () => {
    s.relay = await start(mainDir, relayEnv(fake));
    const c = (s.c = kit.client(s.relay, mainDir));
    s.owner = await c.signIn(OWNER);
    s.ownerId = (await c.api(s.owner, 'GET', '/api/me')).body.user?.id ?? (await c.api(s.owner, 'GET', '/api/me')).body.id;
    expect(s.ownerId).toBeTruthy();
    const team = await c.api(s.owner, 'POST', '/api/teams', { name: TEAM });
    expect(team.status).toBe(201);
    s.teamId = team.body.id;
    for (const [email, key] of [[MEMBER, 'member'], [ADMIN, 'admin']] as const) {
      const invite = await c.api(s.owner, 'POST', `/api/teams/${s.teamId}/invites`, { role: 'member' });
      expect(invite.status).toBe(201);
      s[key] = await c.signIn(email, invite.body.token);
    }
    const members = (await c.api(s.owner, 'GET', '/api/members')).body as { id: string; email: string }[];
    const adminId = members.find((m) => m.email === ADMIN)!.id;
    expect((await c.api(s.owner, 'PATCH', `/api/members/${adminId}`, { role: 'admin' })).status).toBe(200);

    expect((await c.api(s.owner, 'POST', '/api/boards', { id: B1, title: TITLES[B1], teamId: s.teamId })).status).toBe(201);
    expect((await c.api(s.owner, 'POST', '/api/boards', { id: B2, title: TITLES[B2] })).status).toBe(201);
    const up = await fetch(`${s.relay.base}/api/boards/${B2}/assets`, { method: 'POST', headers: { 'x-tabula': '1', cookie: s.owner, 'content-type': 'image/png' }, body: PICTURE });
    expect(up.status).toBe(201);

    const me = (await c.api(s.owner, 'GET', '/api/me')).body;
    const board = c.connect(B1, s.owner);
    const comments = c.connect(`${B1}~comments`, s.owner);
    const picture = c.connect(B2, s.owner);
    await until(() => [board, comments, picture].every((x) => x.provider.wsconnected && x.provider.synced));
    board.doc.getMap('objects').set('o1', new Y.Map(Object.entries({ id: 'o1', type: 'note', text: NOTE, x: 0, y: 0, w: 200, h: 100 })));
    const thread = new Y.Map<unknown>([['id', 't1'], ['createdAt', Date.now()], ['authorId', me.user?.id ?? me.id], ['authorName', me.user?.name ?? me.name], ['authorColor', '#123'], ['text', COMMENT], ['anchor', { x: 0, y: 0 }], ['resolved', false]]);
    thread.set('replies', new Y.Map());
    comments.doc.getMap('threads').set('t1', thread);
    picture.doc.getMap('objects').set('i1', new Y.Map(Object.entries({ id: 'i1', type: 'image', asset: PICTURE_HASH, mime: 'image/png', nw: 9, nh: 7, x: 0, y: 0, w: 90, h: 70 })));
    await until(() => [B1, `${B1}~comments`, B2].every((r) => fs.existsSync(path.join(mainDir, `${r}.yjs`))), 10_000);
    const version = await c.api(s.owner, 'POST', `/api/boards/${B1}/versions`, { label: VERSION_LABEL });
    expect([200, 201]).toContain(version.status);
    expect(version.body.label).toBe(VERSION_LABEL);
    expect((await c.api(s.owner, 'POST', `/api/chat/board/${B1}/messages`, { text: CHAT, clientId: 'drillseedchat01' })).status).toBe(201);
    kit.closeClients();
  });

  it('[8.2.backup-runs] a backup runs by itself: success, no failures, an audit row, and keys that say nothing', async () => {
    const c = s.c!;
    const t0 = Date.now();
    const status = await backedUpSince(c, 0, 30_000);
    expect(status).toMatchObject({ enabled: true, consecutiveFailures: 0, lastError: null });
    s.first = status.lastManifest;
    note('firstBackupAfterSeedMs', Date.now() - t0);
    expect((await entries(c, s.owner!, 'backup.run')).length).toBeGreaterThan(0);

    const { manifest } = await contentOf(fake, s.first!);
    const paths = manifest.files.map((f: { path: string }) => f.path);
    for (const p of ['directory.sqlite', 'chat.sqlite', `${B1}.yjs`, `${B1}~comments.yjs`, `${B2}.yjs`, `assets/${PICTURE_HASH.slice(0, 2)}/${PICTURE_HASH}`, `history/${B1}/index.json`]) expect(paths, `${p}`).toContain(p);
    expect(paths.some((p: string) => p.startsWith(`history/${B1}/`) && p.endsWith('.yjs.gz'))).toBe(true);

    const keys = fake.keys();
    expect(keys.every((k) => /^tabula\/(objects\/[0-9a-f]{64}|manifests\/\d{8}T\d{6}Z\.json\.enc)$/.test(k)), `${keys.join('\n')}`).toBe(true);
    const telling = [TEAM, ...Object.values(TITLES), B1, B2, PICTURE_HASH, PICTURE_HASH.slice(0, 16), 'directory', 'chat', 'sqlite', '.yjs', 'history', 'assets', 'comments', OWNER, MEMBER, ADMIN, 'Kestrel'];
    for (const word of telling) expect(keys.filter((k) => k.toLowerCase().includes(word.toLowerCase())), `${word}`).toEqual([]);
  });

  it('[8.2.backup-shutdown] an edit, then a graceful stop: the edit is in the bucket', async () => {
    const c = s.c!;
    const board = c.connect(B1, s.owner!);
    await until(() => board.provider.wsconnected && board.provider.synced);
    const witness = c.connect(B1, s.owner!);
    await until(() => witness.provider.wsconnected && witness.provider.synced);
    board.doc.getMap('objects').set('o2', 'typed just before the stop');
    await until(() => witness.doc.getMap('objects').get('o2') === 'typed just before the stop');
    const before = manifestsOf(fake);
    expect(await kit.stop(s.relay!)).toBe(0);
    kit.closeClients();
    const added = manifestsOf(fake).filter((m) => !before.includes(m));
    expect(added).toHaveLength(1);
    s.afterShutdown = added[0];
    const { files } = await contentOf(fake, s.afterShutdown);
    expect(docOf(files.get(`${B1}.yjs`)!).getMap('objects').get('o2')).toBe('typed just before the stop');
    s.relay = await start(mainDir, relayEnv(fake));
    s.c = kit.client(s.relay, mainDir);
  });

  it('[8.2.access] a workspace admin who is not the owner is refused on every backup route', async () => {
    const c = s.c!;
    expect((await c.api(s.admin!, 'GET', '/api/me')).body.user).toMatchObject({ email: ADMIN, role: 'admin' });
    const source = fs.readFileSync(path.join(process.cwd(), 'server', 'api.mjs'), 'utf8');
    const routes = [...source.matchAll(/compile\('([A-Z]+)', '(admin\/backups[^']*)'/g)].map((m) => [m[1], m[2]] as const);
    expect(routes.length).toBe(5);
    for (const [method, route] of routes) {
      const url = `/api/${route.replace(':name', s.afterShutdown!)}`;
      const body = method === 'GET' ? undefined : route.endsWith('restore-board') ? { manifest: s.afterShutdown, boardId: B1 } : { manifest: s.afterShutdown, confirm: CONFIRM };
      const res = await c.api(s.admin!, method, url, body);
      expect(res.status, `${method} ${url}`).toBe(403);
    }
    expect(s.relay!.proc.exitCode).toBeNull();
  });

  it('[8.2.board-copy] a board as a copy: a new board with its content, comment and picture; the live board untouched', async () => {
    const c = s.c!;
    const source = (await backedUpSince(c, 0)).lastManifest as string;
    const live = fs.readFileSync(path.join(mainDir, `${B1}.yjs`));
    const inside = await c.api(s.owner!, 'GET', `/api/admin/backups/${source}/boards`);
    expect(inside.status).toBe(200);
    expect(JSON.stringify(inside.body)).toContain(B1);
    const copy = await c.api(s.owner!, 'POST', '/api/admin/backups/restore-board', { manifest: source, boardId: B1 });
    expect(copy.status).toBe(200);
    expect(copy.body).toMatchObject({ ok: true, teamId: s.teamId });
    const id = copy.body.boardId;
    expect(docOf(fs.readFileSync(path.join(mainDir, `${id}.yjs`))).getMap('objects').get('o1')).toBeTruthy();
    expect((docOf(fs.readFileSync(path.join(mainDir, `${id}.yjs`))).getMap('objects').get('o1') as Y.Map<string>).get('text')).toBe(NOTE);
    expect((docOf(fs.readFileSync(path.join(mainDir, `${id}~comments.yjs`))).getMap('threads').get('t1') as Y.Map<string>).get('text')).toBe(COMMENT);
    const pic = await c.api(s.owner!, 'POST', '/api/admin/backups/restore-board', { manifest: source, boardId: B2 });
    expect(pic.status).toBe(200);
    const img = await fetch(`${s.relay!.base}/api/boards/${pic.body.boardId}/assets/${PICTURE_HASH}`, { headers: { cookie: s.owner! } });
    expect(img.status).toBe(200);
    expect(Buffer.from(await img.arrayBuffer()).equals(PICTURE)).toBe(true);
    expect(fs.readFileSync(path.join(mainDir, `${B1}.yjs`)).equals(live)).toBe(true);
    const boards = (await c.api(s.owner!, 'GET', '/api/boards')).body as { id: string; title: string }[];
    expect(boards.find((b) => b.id === B1)?.title).toBe(TITLES[B1]);
    expect(boards.map((b) => b.id)).toEqual(expect.arrayContaining([id, pic.body.boardId]));
  });

  it('[8.2.restore-whole] a whole restore: 202, maintenance, exit 75, a fresh start on the backup\'s data, everyone signed out', async () => {
    let c = s.c!;
    const target = (await backedUpSince(c, 0)).lastManifest as string;
    const expected = await contentOf(fake, target);
    const boardsA = ((await c.api(s.owner!, 'GET', '/api/boards')).body as { id: string }[]).map((b) => b.id).sort();
    // What changes after that backup is not backed up before the restore (settle 3600 s here): retention keeps one
    // backup per hour, so with settle 1 s the backup to go back to would be pruned by the next run within the hour.
    // A new team with a board in it, and an edit: the safety backup the restore takes holds them.
    expect(await kit.stop(s.relay!)).toBe(0);
    s.relay = await start(mainDir, relayEnv(fake, { TABULA_BACKUP_SETTLE_SECONDS: '3600' }));
    c = s.c = kit.client(s.relay, mainDir);
    const gone = await c.api(s.owner!, 'POST', '/api/teams', { name: TEAM_GONE });
    expect((await c.api(s.owner!, 'POST', '/api/boards', { id: B3, title: TITLES[B3], teamId: gone.body.id })).status).toBe(201);
    const osprey = c.connect(B3, s.owner!);
    await until(() => osprey.provider.wsconnected && osprey.provider.synced);
    osprey.doc.getMap('objects').set('p1', 'Osprey content');
    await until(() => fs.existsSync(path.join(mainDir, `${B3}.yjs`)), 10_000);
    kit.closeClients();
    expect(newestOf(fake)).toBe(target);
    const preview = await c.api(s.owner!, 'GET', `/api/admin/backups/${target}`);
    expect(preview.body).toMatchObject({ keepOldFor: '7 days' });
    const editor = c.connect(B1, s.owner!);
    const watcher = c.connect(B3, s.owner!);
    await until(() => [editor, watcher].every((x) => x.provider.wsconnected && x.provider.synced));
    const before = manifestsOf(fake);

    const t0 = Date.now();
    const res = await c.api(s.owner!, 'POST', '/api/admin/backups/restore', { manifest: target, confirm: CONFIRM });
    expect(res.status).toBe(202);
    s.wholeReply = res.body;
    expect(res.body).toEqual({ ok: true, restarting: true, keepOldFor: '7 days' });
    await until(() => editor.closes.length > 0 && watcher.closes.length > 0);
    expect(editor.closes).toContain(4503);
    expect(watcher.closes).toContain(4503);
    const denied = await c.api(s.owner!, 'GET', '/api/boards');
    expect(denied.status).toBe(503);
    expect(denied.body).toMatchObject({ error: 'restoring' });
    expect(await (await fetch(`${s.relay!.base}/api/health`)).json()).toMatchObject({ restoring: true });
    expect(await s.relay!.exited).toBe(75);
    kit.closeClients();

    s.relay = await start(mainDir, relayEnv(fake));
    note('wholeRestoreSeconds', Math.round((Date.now() - t0) / 100) / 10);
    expect(s.relay.out()).toContain('completed a restore');
    c = s.c = kit.client(s.relay, mainDir);
    for (const old of [s.owner!, s.member!, s.admin!]) expect((await c.api(old, 'GET', '/api/me')).status).toBe(401);
    s.owner = await c.signIn(OWNER);
    s.member = await c.signIn(MEMBER);
    s.admin = await c.signIn(ADMIN);

    const now = liveFiles(mainDir);
    expect([...now.keys()].sort()).toEqual([...expected.files.keys()].sort());
    for (const [file, bytes] of expected.files) expect(now.get(file)!.equals(bytes), `${file}`).toBe(true);
    const boards = (await c.api(s.owner, 'GET', '/api/boards')).body as { id: string }[];
    expect(boards.map((b) => b.id).sort()).toEqual(boardsA);
    expect(boardsA).not.toContain(B3);
    const chat = await c.api(s.owner, 'GET', `/api/chat/board/${B1}/messages`);
    expect(JSON.stringify(chat.body)).toContain(CHAT);
    expect(fs.readdirSync(mainDir).filter((n) => n.startsWith('.pre-restore-'))).toHaveLength(1);
    const actions = (await entries(c, s.owner, 'restore.')).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['restore.started', 'restore.done']));

    const safety = manifestsOf(fake).filter((m) => !before.includes(m));
    expect(safety).toHaveLength(1);
    s.withOsprey = safety[0];
    const list = (await c.api(s.owner, 'GET', '/api/admin/backups')).body;
    expect(list.restore.protectedBackups).toEqual(expect.arrayContaining([safety[0], target].map((n) => expect.objectContaining({ manifest: n }))));
    // a run with its prune: the safety backup stays
    const t = Date.now();
    await change(c, s.owner);
    await backedUpSince(c, t);
    expect(manifestsOf(fake)).toContain(safety[0]);
  });

  it('[8.2.board-copy] the deleted-team case: the copy lands in the owner\'s personal space with the message', async () => {
    const c = s.c!;
    // the restore went back to before the Osprey team: the backup that has its board names a team that is gone
    expect(((await c.api(s.owner!, 'GET', '/api/teams')).body as { name: string }[]).map((t) => t.name)).not.toContain(TEAM_GONE);
    const copy = await c.api(s.owner!, 'POST', '/api/admin/backups/restore-board', { manifest: s.withOsprey, boardId: B3 });
    expect(copy.status).toBe(200);
    expect(copy.body).toMatchObject({ ok: true, teamId: null, fallback: 'personal', message: FALLBACK });
    const boards = (await c.api(s.owner!, 'GET', '/api/boards')).body as { id: string; teamId: string | null }[];
    expect(boards.find((b) => b.id === copy.body.boardId)).toMatchObject({ teamId: null });
    await backedUpSince(c, Date.now());
  });

  it('[8.2.retention] the old data: 7 days with room on the disk, until the next successful backup when it is nearly full', async () => {
    expect(s.wholeReply).toMatchObject({ keepOldFor: '7 days' });
    // the other branch on a copy of the workspace and of the bucket, so the main drill keeps its one restore per ten minutes
    expect(await kit.stop(s.relay!)).toBe(0);
    const dir = path.join(scratch, 'retention');
    fs.cpSync(mainDir, dir, { recursive: true });
    for (const n of fs.readdirSync(dir).filter((x) => x.startsWith('.pre-restore-'))) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
    const bucket = await cloneBucket(fake);
    const full = await start(dir, relayEnv(bucket, { TABULA_TEST_RESTORE_DISK_USED: '0.95' }));
    const c = kit.client(full, dir);
    const cookie = await c.signIn(OWNER);
    const target = newestOf(bucket);
    const preview = await c.api(cookie, 'GET', `/api/admin/backups/${target}`);
    expect(preview.body).toMatchObject({ keepOldFor: 'until the next successful backup (at least 24 h)' });
    expect(preview.body.reason).toContain('95%');
    const res = await c.api(cookie, 'POST', '/api/admin/backups/restore', { manifest: target, confirm: CONFIRM });
    expect(res.body).toEqual({ ok: true, restarting: true, keepOldFor: 'until the next successful backup (at least 24 h)' });
    expect(await full.exited).toBe(75);
    s.relay = await start(mainDir, relayEnv(fake));
    s.c = kit.client(s.relay, mainDir);
  });

  it('[8.2.verify-repair] an object missing from the bucket: the next prune reports it, the run after puts it back', async () => {
    const c = s.c!;
    // a run in this process first, so the object is one it has seen and does not ask about again
    let t = Date.now();
    await change(c, s.owner!);
    const first = await backedUpSince(c, t);
    const { manifest } = await contentOf(fake, first.lastManifest);
    const picture = manifest.files.find((f: { path: string }) => f.path.startsWith('assets/'))!;
    const key = `tabula/objects/${picture.objectId}`;
    expect(fake.objects.has(key)).toBe(true);
    fake.objects.delete(key);

    t = Date.now();
    await change(c, s.owner!);
    const reported = await backedUpSince(c, t);
    expect(reported.missingObjects).toBeGreaterThanOrEqual(1);
    expect(fake.objects.has(key)).toBe(false);

    t = Date.now();
    await change(c, s.owner!);
    const repaired = await backedUpSince(c, t);
    expect(repaired.missingObjects).toBe(0);
    expect(fake.objects.has(key)).toBe(true);
    const rows = await entries(c, s.owner!, 'backup.run');
    expect(rows[0].detail.repaired).toBeGreaterThanOrEqual(1);
  });

  it('[8.2.disaster] the data directory is lost: an empty server on the same bucket and key restores the newest backup', async () => {
    let c = s.c!;
    await backedUpSince(c, 0);
    expect(await kit.stop(s.relay!)).toBe(0);
    const newest = (s.disasterNewest = newestOf(fake));
    const expected = await contentOf(fake, newest);
    for (const n of fs.readdirSync(mainDir)) fs.rmSync(path.join(mainDir, n), { recursive: true, force: true });

    // settle as in production (120 s): signing in on the empty server must not make an empty backup the newest
    const empty = await start(mainDir, relayEnv(fake, { TABULA_BACKUP_SETTLE_SECONDS: '120' }));
    c = kit.client(empty, mainDir);
    const cookie = await c.signIn(OWNER);
    const list = (await c.api(cookie, 'GET', '/api/admin/backups')).body;
    expect(list.backups[0]).toMatchObject({ name: newest, readable: true });
    const t0 = Date.now();
    note('dataAgeAtRestoreSeconds', Math.round((t0 - (list.backups[0].createdAt as number)) / 1000));
    const res = await c.api(cookie, 'POST', '/api/admin/backups/restore', { manifest: newest, confirm: CONFIRM });
    expect(res.status).toBe(202);
    expect(await empty.exited).toBe(75);

    s.relay = await start(mainDir, relayEnv(fake));
    note('disasterRestoreSeconds', Math.round((Date.now() - t0) / 100) / 10);
    expect(s.relay.out()).toContain('completed a restore');
    c = s.c = kit.client(s.relay, mainDir);
    expect((await c.api(cookie, 'GET', '/api/me')).status).toBe(401);
    s.owner = await c.signIn(OWNER);
    const me = (await c.api(s.owner, 'GET', '/api/me')).body;
    expect(me.user?.id ?? me.id).toBe(s.ownerId);
    const now = liveFiles(mainDir);
    expect([...now.keys()].sort()).toEqual([...expected.files.keys()].sort());
    for (const [file, bytes] of expected.files) expect(now.get(file)!.equals(bytes), `${file}`).toBe(true);
    const boards = (await c.api(s.owner, 'GET', '/api/boards')).body as { id: string }[];
    expect(boards.map((b) => b.id)).toEqual(expect.arrayContaining([B1, B2]));
    expect(JSON.stringify((await c.api(s.owner, 'GET', `/api/chat/board/${B1}/messages`)).body)).toContain(CHAT);
    expect(fs.readdirSync(mainDir).filter((n) => n.startsWith('.pre-restore-'))).toHaveLength(1);
    expect((await entries(c, s.owner, 'restore.')).map((e) => e.action)).toEqual(expect.arrayContaining(['restore.started', 'restore.done']));
  });

  it('[8.2.wrong-key] another key: every backup is unreadable with the reason, and nothing is restored', async () => {
    const dir = freshDir('wrong-key');
    const bucket = await cloneBucket(fake);
    const relay = await start(dir, relayEnv(bucket, { ...keyEnv(KEY_OTHER), TABULA_BACKUP_SETTLE_SECONDS: '120', TABULA_BACKUP_SHUTDOWN_SECONDS: '0' }));
    const c = kit.client(relay, dir);
    const cookie = await c.signIn(OWNER);
    const list = (await c.api(cookie, 'GET', '/api/admin/backups')).body;
    expect(list.backups.length).toBe(manifestsOf(bucket).length);
    expect(list.backups.length).toBeGreaterThan(0);
    for (const b of list.backups) expect(b).toMatchObject({ readable: false, error: 'unknown_key' });
    const before = liveFiles(dir);
    const res = await c.api(cookie, 'POST', '/api/admin/backups/restore', { manifest: list.backups[0].name, confirm: CONFIRM });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('unknown_key');
    expect((await c.api(cookie, 'GET', '/api/me')).status).toBe(200);
    await sleep(300);
    expect(relay.proc.exitCode).toBeNull();
    expect(liveFiles(dir)).toEqual(before);
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('.pre-restore-') || n.startsWith('.restore-'))).toEqual([]);
    await kit.stop(relay);
  });

  it('[8.2.damaged] one byte of one stored object flipped: the restore refuses before changing anything, and says why', async () => {
    const dir = freshDir('damaged');
    const bucket = await cloneBucket(fake);
    // the backup the disaster restore used (protected for 7 days): the newest one now may be the empty server's safety backup
    const target = s.disasterNewest!;
    const { manifest } = await contentOf(bucket, target);
    const room = manifest.files.find((f: { path: string }) => f.path === `${B1}.yjs`)!;
    const stored = bucket.objects.get(`tabula/objects/${room.objectId}`)!;
    stored.body[Math.floor(stored.body.length / 2)] ^= 0x01;
    const relay = await start(dir, relayEnv(bucket, { TABULA_BACKUP_SETTLE_SECONDS: '120' }));
    const c = kit.client(relay, dir);
    const cookie = await c.signIn(OWNER);
    const before = liveFiles(dir);
    const res = await c.api(cookie, 'POST', '/api/admin/backups/restore', { manifest: target, confirm: CONFIRM });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('tamper');
    expect(res.body.message).toMatch(/\w+/);
    expect((await c.api(cookie, 'GET', '/api/me')).status).toBe(200);
    await sleep(300);
    expect(relay.proc.exitCode).toBeNull();
    expect(liveFiles(dir)).toEqual(before);
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('.pre-restore-') || n.startsWith('.restore-'))).toEqual([]);
    expect((await entries(c, cookie, 'restore.failed')).length).toBeGreaterThan(0);
    note('damagedMessage', res.body.message);
    await kit.stop(relay);
  });

  it('[8.2.key-rotation] KEY and KEY_PREVIOUS: a new key id, everything uploaded again, old backups readable and usable', async () => {
    let c = s.c!;
    const oldKeyId = (await c.internal('/api/internal/backup-status')).body.keyId;
    expect(await kit.stop(s.relay!)).toBe(0);
    currentKeys = keyEnv(KEY_NEW, KEY);
    s.relay = await start(mainDir, relayEnv(fake));
    c = s.c = kit.client(s.relay, mainDir);
    s.owner = await c.signIn(OWNER);
    const status = (await c.internal('/api/internal/backup-status')).body;
    expect(status.keyId).not.toBe(oldKeyId);
    const puts = fake.count('PUT', /\/objects\//);
    const t = Date.now();
    await change(c, s.owner);
    const after = await backedUpSince(c, t);
    const { manifest } = await contentOf(fake, after.lastManifest);
    expect(manifest.keyId).toBe(status.keyId);
    const unique = new Set(manifest.files.map((f: { objectId: string }) => f.objectId));
    expect(fake.count('PUT', /\/objects\//) - puts).toBe(unique.size);
    const list = (await c.api(s.owner, 'GET', '/api/admin/backups')).body.backups as { name: string; readable: boolean; keyId: string }[];
    expect(list.filter((b) => !b.readable)).toEqual([]);
    const olds = list.filter((b) => b.keyId === oldKeyId);
    // the backup the disaster restore used is protected, so an old-key backup with the boards in it is still there
    const old = s.disasterNewest!;
    expect(olds.map((b) => b.name)).toContain(old);
    const copy = await c.api(s.owner, 'POST', '/api/admin/backups/restore-board', { manifest: old, boardId: B1 });
    expect(copy.status).toBe(200);
    expect(copy.body).toMatchObject({ ok: true });
  });

  it('[8.1.adopt-copy] a copy of the data directory on a new Fly volume id is adopted as a restored copy', async () => {
    let c = s.c!;
    await backedUpSince(c, 0);
    const cookie = s.owner!;
    expect(await kit.stop(s.relay!)).toBe(0);
    const dir = path.join(scratch, 'volume-copy');
    fs.cpSync(mainDir, dir, { recursive: true });
    s.relay = await start(dir, relayEnv(fake, { TABULA_FLY_VOLUME_ID: 'vol_drill_2' }));
    expect(s.relay.out()).toContain('(restored-copy)');
    c = s.c = kit.client(s.relay, dir);
    expect((await c.api(cookie, 'GET', '/api/me')).status).toBe(401);
    s.owner = await c.signIn(OWNER);
    const from = { workspaceId: WORKSPACE, flyVolumeId: 'vol_drill_1' };
    const to = { workspaceId: WORKSPACE, flyVolumeId: 'vol_drill_2' };
    expect(await entries(c, s.owner, 'volume.adopt')).toEqual([expect.objectContaining({ action: 'volume.adopt', detail: { from, to, reason: 'restored-copy' } })]);
    const vol = (await c.internal('/api/internal/volume')).body;
    expect(vol).toMatchObject({ workspaceId: WORKSPACE, flyVolumeId: 'vol_drill_2', lastAdoption: { from, to, reason: 'restored-copy' } });
  });

  it('[8.2.no-secret] no key, S3 secret or request signature in any log, the audit log or the status', async () => {
    const c = s.c!;
    const audit = (await c.api(s.owner!, 'GET', '/api/admin/audit?limit=200')).body;
    const status = (await c.internal('/api/internal/backup-status')).body;
    const listing = (await c.api(s.owner!, 'GET', '/api/admin/backups')).body;
    const logs = kit.outputs.map((o) => o.out() + o.err()).join('\n');
    expect(kit.outputs.length).toBeGreaterThan(8);
    const secrets = [CREDS.secretKey, ...[KEY, KEY_NEW, KEY_OTHER].flatMap((k) => [k.toString('hex'), k.toString('base64'), k.toString('base64url')]), ...fakes.flatMap((f) => f.signatures)];
    expect(fakes.flatMap((f) => f.signatures).length).toBeGreaterThan(10);
    const searched = { logs, audit: JSON.stringify(audit), status: JSON.stringify(status), listing: JSON.stringify(listing) };
    for (const [where, text] of Object.entries(searched)) for (const secret of secrets) expect(text.includes(secret), `${where} holds a secret`).toBe(false);
    note('logBytesSearched', logs.length);
  });
});
