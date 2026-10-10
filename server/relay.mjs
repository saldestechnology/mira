#!/usr/bin/env node
// Tabula relay: serves the built app and relays Yjs sync + awareness
// messages between everyone in a board room. It keeps each room's document on
// disk so someone joining later catches up even if the author is offline.
//
//   PORT=8787 DATA_DIR=./data node server/relay.mjs
//
// The wire protocol is the standard y-websocket protocol, so any y-websocket
// client can connect to ws://host:PORT/sync/<boardId>. Every board also has a
// sibling comments room, ws://host:PORT/sync/<boardId>~comments (docs/comments.md).
//
// With TABULA_AUTH=on (accounts mode, docs/accounts.md) the relay also serves the
// HTTP API and decides who may join which room before it touches the room.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { loadConfig } from './config.mjs';
import { withLegacyEnv } from './env.mjs';
import { createHistory } from './history.mjs';
import { createBackup, loadBackupConfig } from './backup.mjs';
import { createSnapshotBarrier } from './snapshot-barrier.mjs';
import { RestoreError, createRestore, recoverOnStart } from './restore.mjs';
import { VolumeError, applyVolume, planVolume, volumeReport } from './volume.mjs';
import { saveDelay, saveMaxWaitMs } from './save-delay.mjs';
import { renameSyncRetry } from './fs-retry.mjs';
import { createCommentGuard } from './comment-authz.mjs';
import { scrubText } from './ai/errors.mjs';
import { openAiConfig } from './ai/routes.mjs';
import { createOpenRun } from './ai/run.mjs';
import { createLiveRuns } from './ai/live.mjs';
import { createAssetStore, createJsonAssetIndex, createUploadLimiter } from './assets.mjs';
import { createAssetGc } from './assets-gc.mjs';
import { createAssetHandlers, createOpenAssetRoutes } from './asset-routes.mjs';
import { clientIpOf } from './client-ip.mjs';
import { createSourceGate } from './source-policy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// settings (and secrets such as TABULA_SMTP_URL) may live in a .env file next to where the server starts; real environment variables win
if (process.env.TABULA_SKIP_DOTENV !== '1') {
  try { process.loadEnvFile(); } catch { /* no .env file */ }
}
const env = withLegacyEnv();
const config = loadConfig(env);
// Off-site backups (docs/backups.md): null unless TABULA_BACKUP_* is set; half a configuration stops the start here.
const backupConfig = loadBackupConfig(env);
const snapshotBarrier = backupConfig
  ? createSnapshotBarrier({ maxHoldMs: backupConfig.snapshotMaxHoldSeconds * 1000 })
  : null;
const PORT = config.port;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = config.dataDir;
const DIST = path.resolve(process.env.DIST_DIR || path.join(here, '..', 'dist'));
const ROOM_RE = /^([A-Za-z0-9_-]{1,64})(~comments)?$/;
const SAVE_DEBOUNCE_MS = Number(process.env.SAVE_DEBOUNCE_MS) > 0 ? Number(process.env.SAVE_DEBOUNCE_MS) : 1000;
const SAVE_MAX_WAIT_MS = saveMaxWaitMs(); // 30 s; the test-only TABULA_TEST_SAVE_MAX_WAIT_MS can only shorten it (server/save-delay.mjs)
// After a failed write (disk full, permissions), the next attempt. A finite value from 0.25 s to 60 s: a tiny one would spin the retry log,
// an infinite one would never retry.
const SAVE_RETRY_MS = Math.min(60_000, Math.max(250, Number(process.env.SAVE_RETRY_MS) > 0 ? Number(process.env.SAVE_RETRY_MS) : 5_000));
const DEFAULT_TITLE = 'Untitled board'; // the directory's title for a board created without one
const UNLOAD_AFTER_MS = Number(process.env.ROOM_UNLOAD_MS) > 0 ? Number(process.env.ROOM_UNLOAD_MS) : 60_000;
const PING_MS = 30_000;
const ROLE_RECHECK_MS = 5_000;

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
// Not a y-websocket type (it uses 0 sync, 1 awareness, 2 auth, 3 query awareness). Relay to client only: a hosted
// workspace's read-only switch flipped (docs/cloud.md). Room.onMessage ignores it from a client like any unknown type.
const MSG_WORKSPACE = 4;
// Relay to client only, on a comments room: a change from this client was undone because its author rules forbid it
// (docs/comment-authz.md). Payload: JSON { undone: ('edit'|'delete'|'resolve'|'author'|'other')[] }.
const MSG_COMMENT_NOTICE = 5;
// Relay to client only, on a board room: the board's live AI runs (docs/ai.md, "Live runs"). Payload: JSON
// { kind: 'snapshot', runs } on joining, then { kind: 'patch', run } per change, each shaped for that socket's person.
const MSG_AI_RUNS = 6;
const AI_SWEEP_MS = 30_000;

const CLOSE_UNAUTHENTICATED = 4401;
const CLOSE_FORBIDDEN = 4403;
const GUEST_PRESENCE_COLORS = ['#326DD3', '#D3332D', '#1B8151', '#A06A00', '#7B58DB', '#CE2C7D', '#1C7C85', '#B9501C'];
const GUEST_AWARENESS_STRING_LIMIT = 256;

function cleanAwarenessString(value, limit = GUEST_AWARENESS_STRING_LIMIT) {
  return [...value.slice(0, limit * 4).normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, '')].slice(0, limit).join('');
}

function cleanGuestAwarenessValue(value, depth = 0) {
  if (typeof value === 'string') return cleanAwarenessString(value);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (depth >= 8) return null;
  if (Array.isArray(value)) return value.slice(0, 128).map((entry) => cleanGuestAwarenessValue(entry, depth + 1));
  if (typeof value === 'object') {
    const safe = Object.create(null);
    let count = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (count++ >= 128) break;
      const cleanKey = cleanAwarenessString(key, 64);
      if (cleanKey) safe[cleanKey] = cleanGuestAwarenessValue(value[key], depth + 1);
    }
    return safe;
  }
  return null;
}

function guestPresenceColor(userId) {
  const index = crypto.createHash('sha256').update(userId).digest()[0] % GUEST_PRESENCE_COLORS.length;
  return GUEST_PRESENCE_COLORS[index];
}

function cleanGuestAwarenessState(state, ws) {
  if (state === null) return null;
  const cleaned = cleanGuestAwarenessValue(state);
  const safe = cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned) ? cleaned : Object.create(null);
  const name = cleanAwarenessString(typeof ws.userName === 'string' ? ws.userName : 'Guest', 40).trim() || 'Guest';
  safe.user = { id: ws.userId, name, color: ws.userColor ?? guestPresenceColor(ws.userId), guest: true };
  return safe;
}
const CLOSE_NOT_FOUND = 4404;
const CLOSE_ACCESS_REMOVED = 4410;
// The workspace is being restored from a backup (docs/backups.md, Restoring): sent to every open socket, and to every
// socket that connects, until the server restarts on the restored data.
const CLOSE_RESTORING = 4503;

fs.mkdirSync(DATA_DIR, { recursive: true });

const log = (...a) => {
  if (process.env.QUIET !== '1') console.log(new Date().toISOString(), ...a);
};

// An interrupted restore is finished or undone before anything opens the data directory (docs/backups.md). A journal
// that cannot be trusted stops the start: guessing could mix old and new data.
let recovery = { action: 'none' };
try {
  recovery = recoverOnStart({ dataDir: DATA_DIR, log });
} catch (err) {
  console.error(err instanceof RestoreError ? err.message : `The restore recovery failed (${err?.code ?? 'error'}), so the server will not start.`);
  process.exit(1);
}

// Whose data this volume is (docs/backups.md, Volumes and restores). Decided right after the restore recovery, which
// may have just swapped the data in, and before anything opens the data: a volume of another workspace is refused
// here, before its database is read. Carried out by settleVolume() below, once the directory is open.
const STARTED_AT = Date.now();
let volumePlan;
try {
  volumePlan = planVolume({ dataDir: DATA_DIR, env, workspaceId: config.cloud?.workspaceId ?? null });
  if (volumePlan.action === 'error') throw new VolumeError(volumePlan.message);
} catch (err) {
  console.error(err instanceof VolumeError ? err.message : `The volume marker (volume.json) could not be read (${err?.code ?? 'error'}), so the server will not start.`);
  process.exit(1);
}
let volumeAdopted = false;
// Adopting needs the directory (sessions, audit) and comes before the cloud hooks, the backups and the listener: a
// failed step stops the start, nothing half adopted is served.
function settleVolume(dir) {
  try {
    volumeAdopted = applyVolume({ dataDir: DATA_DIR, plan: volumePlan, directory: dir, log });
  } catch (err) {
    console.error(err instanceof VolumeError ? err.message : `Adopting this volume failed (${err?.code ?? err?.message ?? 'error'}), so the server will not start.`);
    dir?.close();
    process.exit(1);
  }
}

// A restore has taken the server over: `maintenance` answers 503 and refuses sockets, `roomsFrozen` stops every save, so
// nothing the old rooms hold can be written into the restored data.
let maintenance = false;
let roomsFrozen = false;

// A room name is `<boardId>` or `<boardId>~comments` (the `~` cannot occur in a board id).
function parseRoom(name) {
  const m = typeof name === 'string' ? ROOM_RE.exec(name) : null;
  return m ? { boardId: m[1], kind: m[2] ? 'comments' : 'board' } : null;
}

// Who may write which room. Anything not listed here (an unknown role or kind) may not write, and nobody writes
// while a hosted workspace is read-only, or to a deleted board (workspace admins may still open one, to look before
// restoring it).
function canWriteRoom(role, kind, deleted = false) {
  if (deleted || cloud?.limits().readOnly) return false;
  if (kind === 'board') return role === 'owner' || role === 'editor';
  if (kind === 'comments') return role === 'owner' || role === 'editor' || role === 'commenter';
  return false;
}

// Leftover comments mean the id was used before, so adopting such a board is as sensitive as adopting its board file.
const roomExists = (id) => fs.existsSync(path.join(DATA_DIR, `${id}.yjs`)) || fs.existsSync(path.join(DATA_DIR, `${id}~comments.yjs`));

// Version history (docs/history.md), in both modes. The state of a board room: the live room, else its file.
function boardState(id) {
  const room = rooms.get(id);
  if (room) return Y.encodeStateAsUpdate(room.doc);
  try {
    return fs.readFileSync(path.join(DATA_DIR, `${id}.yjs`));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}
const history = createHistory({ dataDir: DATA_DIR, boardState, log });

// Live AI runs, shared by the run routes of both modes and the board rooms below.
const aiLive = createLiveRuns();

// Accounts mode only. The modules are loaded lazily so open mode never touches node:sqlite.
const events = new EventEmitter();
let directory = null;
let auth = null;
let api = null;
let cloud = null;
let buildApi = null;
// Team chat (docs/chat.md), accounts mode, on unless TABULA_CHAT=off. chat.sqlite is opened on first use.
let chat = null;
let chatHub = null;
let chatStore = null;
let chatRetention = null;
let chatNotifier = null;
let trackerNotifier = null;
let joinCodeService = null;
if (config.authEnabled) {
  const [{ openDirectory }, { createMailer }, { createAuth }, { createApi }, { createCloud }] = await Promise.all([
    import('./directory.mjs'),
    import('./mailer.mjs'),
    import('./auth.mjs'),
    import('./api.mjs'),
    import('./cloud.mjs'),
  ]);
  directory = openDirectory(path.join(DATA_DIR, 'directory.sqlite'), { snapshotBarrier });
  settleVolume(directory);
  if (config.joinCodes) {
    const { createJoinCodeService, loadJoinCodeSecret } = await import('./join-codes.mjs');
    joinCodeService = createJoinCodeService({ directory, secret: loadJoinCodeSecret(DATA_DIR) });
  }
  // Hosted workspaces (docs/cloud.md): null unless TABULA_CLOUD_* is set, and then every hook below is inert.
  cloud = createCloud({ config: config.cloud, directory, events });
  auth = createAuth({ directory, config, mailer: createMailer(config), seatsAvailable: cloud?.seatsAvailable });
  buildApi = createApi; // created below, once the restore engine exists
  if (config.chat) {
    const [{ openChat, readChatSettings }, { boundAccess }, { createChatHub }, { unreadSummary }, { createChatRetention }, { createChatNotifier, mailAfterMsFromEnv }, { createChatLimits, chatLimitsFromTestEnv }] = await Promise.all([
      import('./chat.mjs'),
      import('./chat-access.mjs'),
      import('./chat-hub.mjs'),
      import('./chat-routes.mjs'),
      import('./chat-retention.mjs'),
      import('./chat-notify.mjs'),
      import('./chat-limits.mjs'),
    ]);
    const store = () => {
      if (maintenance) throw new Error('the workspace is being restored');
      return (chatStore ??= openChat(path.join(DATA_DIR, 'chat.sqlite')));
    };
    const access = boundAccess({ directory, cloud, settings: () => readChatSettings(directory) });
    chatHub = createChatHub({
      auth,
      directory,
      access,
      summary: (user) => unreadSummary({ directory, store, user, access }),
      channelUnread: (userId, kind, ref) => store().channelUnread(userId, kind, ref),
      events,
      readOnly: cloud?.limits().readOnly === true,
      log,
    });
    // Not documented, and only under NODE_ENV=test (chat-notify.mjs)
    const mailAfterMs = mailAfterMsFromEnv(env);
    chatNotifier = createChatNotifier({ directory, store, hub: chatHub, mailer: createMailer(config), access, baseUrl: config.baseUrl, log, mailAfterMs });
    chat = { store, access, hub: chatHub, notifier: chatNotifier, limits: createChatLimits({ limits: chatLimitsFromTestEnv(env) }) };
    // A removed member's messages stay without an account behind them (docs/chat.md, Removing and erasing people)
    events.on('user-removed', ({ userId } = {}) => {
      if (maintenance || typeof userId !== 'string') return;
      try {
        store().anonymiseAuthor(userId);
      } catch (err) {
        log('chat: could not anonymise a removed member:', err?.message);
      }
    });
    chatRetention = createChatRetention({ directory, store, paused: () => maintenance, runWriter: (fn) => snapshotBarrier ? snapshotBarrier.runWriter(fn) : fn(), log });
    chatRetention.start();
  }
  if (config.tracker) {
    const { createTrackerNotifier, trackerTickMsFromTestEnv } = await import('./tracker/outbox.mjs');
    const { boardAccessForDirectory } = await import('./tracker/access.mjs');
    trackerNotifier = createTrackerNotifier({
      directory,
      mailer: createMailer(config),
      baseUrl: config.baseUrl,
      log,
      boardAccess: boardAccessForDirectory(directory),
      intervalMs: trackerTickMsFromTestEnv(env),
    });
    trackerNotifier.start();
  }
} else if (env.TABULA_CLOUD_TOKEN || env.TABULA_CLOUD_URL || env.TABULA_CLOUD_WORKSPACE_ID) {
  console.error('TABULA_CLOUD_* is ignored: hosted workspace mode needs TABULA_AUTH=on');
}
if (!config.authEnabled) settleVolume(null);

// Backups need the directory (accounts mode only) and, like liveStats, are asked for per request, so they are created below.
function backupStatus() {
  return backup ? { ...backup.status(), ...(restore ? { restore: restore.status() } : {}) } : { enabled: false };
}
// The state of a room that is open, including what is not saved yet; any other room the backup reads from its file.
const openRoomState = (name) => {
  const room = rooms.get(name);
  return room ? Y.encodeStateAsUpdate(room.doc) : null;
};
const backup = createBackup({
  config: backupConfig,
  dataDir: DATA_DIR,
  directory,
  boardState: openRoomState,
  snapshotBarrier,
  prepareSnapshot: saveAllRooms,
  log,
});

// Not documented: the relay tests give the restore engine a disk that is this full (0 to 1) instead of the real one, so the
// retention they check (7 days, or until the next backup when the volume would pass 80%) does not depend on the machine.
function testDisk(value) {
  const used = Number(value);
  if (value === undefined || value === '' || !Number.isFinite(used) || used < 0 || used > 1) return {};
  return { statfs: async () => ({ bsize: 4096, blocks: 1_000_000, bavail: Math.round(1_000_000 * (1 - used)) }) };
}

// Restore (docs/backups.md, Restoring): null without backups or accounts. The hooks are what only the relay can do.
const restore = createRestore({
  backup,
  directory,
  config: backupConfig,
  dataDir: DATA_DIR,
  log,
  hooks: { saveRooms: saveAllRooms, enterMaintenance },
  exit: (code) => process.exit(code),
  // not documented: the relay tests keep the process in maintenance mode for a while after the answer, to look at it
  exitDelayMs: Number(process.env.TABULA_TEST_RESTORE_EXIT_DELAY_MS) > 0 ? Number(process.env.TABULA_TEST_RESTORE_EXIT_DELAY_MS) : 0,
  ...testDisk(process.env.TABULA_TEST_RESTORE_DISK_USED),
});
// Images on a board (docs/images.md): the files are shared by both modes; the index of who may read which is the directory
// database with accounts and a small JSON file without.
const clientIp = (req) => clientIpOf(req, config);
const assets = config.assets
  ? (() => {
      const dir = path.join(DATA_DIR, 'assets');
      const index = directory ?? createJsonAssetIndex(dir);
      const store = createAssetStore({ dir, index, limits: config.assets });
      return { store, index, dir, handlers: createAssetHandlers({ store, limiter: createUploadLimiter() }) };
    })()
  : null;
// A picture's file is kept while any live room or retained version of a board refers to it (docs/images.md, History and
// garbage collection). Daily, and a couple of minutes after start; the timers do not keep the process alive.
if (assets) {
  const gc = createAssetGc({
    index: assets.index,
    pathOf: assets.store.pathOf,
    assetsDir: assets.dir,
    dataDir: DATA_DIR,
    readLive: (id) => boardState(id),
    log,
  });
  const sweep = () => {
    const collect = () => {
      try {
        const summary = gc.run();
        if (directory && (summary.rows || summary.files)) directory.audit(null, 'assets.gc', { rows: summary.rows, bytes: summary.bytes, files: summary.files });
      } catch (err) {
        log('asset gc failed', scrubText(err?.message));
      }
    };
    if (snapshotBarrier) void snapshotBarrier.runWriter(collect);
    else collect();
  };
  setTimeout(sweep, Number(process.env.TABULA_TEST_ASSET_GC_DELAY_MS) > 0 ? Number(process.env.TABULA_TEST_ASSET_GC_DELAY_MS) : 2 * 60 * 1000).unref();
  setInterval(sweep, 24 * 60 * 60 * 1000).unref();
}
const openAssets = assets && !directory ? createOpenAssetRoutes({ handlers: assets.handlers, clientIp }) : null;

if (buildApi) {
  // canWriteRoom is hoisted; roomAccess is a const further down, so it is reached through a function (like liveStats)
  api = buildApi({ directory, auth, config, roomExists, events, liveStats, cloud, history, backupStatus, volumeStatus: () => volumeReport(volumePlan.marker, STARTED_AT), startedAt: STARTED_AT, onChange: () => backup?.noteChange(), restore, maintenance: () => maintenance, ai: { canWriteRoom, readRoom: (name, fn) => roomAccess.read(name, fn), live: aiLive }, assets, chat, joinCodeService, snapshotBarrier });
}

// ---------------------------------------------------------------- rooms

/** @type {Map<string, Room>} */
const rooms = new Map();

snapshotBarrier?.onRelease(() => {
  for (const room of rooms.values()) room.releaseDeferredMessages();
});

// Hoisted on purpose: the API is created above this line and asks for it per request. /api/health reports the same numbers.
function liveStats() {
  return { rooms: rooms.size, connections: [...rooms.values()].reduce((n, r) => n + r.conns.size, 0) };
}

// Every open room to its file; the one place both shutdown and a restore do it.
function saveAllRooms() {
  if (roomsFrozen) return true;
  let saved = true;
  for (const r of rooms.values()) if (!r.save()) saved = false;
  return saved;
}

// The restore engine just saved every room synchronously. Close sockets and freeze rooms before yielding, so no
// edits can arrive between that save and the freeze. The restore engine stops the backups and closes the database next.
async function enterMaintenance() {
  maintenance = true;
  for (const ws of wss.clients) {
    ws.removeAllListeners('message');
    ws.denied = true; // the role check that runs every second leaves it alone
    ws.close(CLOSE_RESTORING, 'restoring');
  }
  // Chat sockets go too, and chat.sqlite is closed so the restore can move it (Windows will not move an open file).
  chatHub?.closeAll(CLOSE_RESTORING, 'restoring');
  chatHub?.stop();
  chatRetention?.stop();
  chatNotifier?.stop();
  trackerNotifier?.stop();
  closeChat();
  roomsFrozen = true;
  for (const room of rooms.values()) {
    clearTimeout(room.saveTimer);
    clearTimeout(room.unloadTimer);
    room.saveTimer = null;
    room.unloadTimer = null;
    room.doc.destroy();
  }
  rooms.clear();
  // The live AI runs belong to rooms that are gone. A provider call still out finds its run dropped and changes nothing;
  // nothing else of the AI path survives, because the API answers 503 and the sockets are closed.
  aiLive.dropAll();
  cloud?.close();
  history.close();
}

class Room {
  constructor(name) {
    this.name = name;
    this.kind = parseRoom(name).kind;
    this.file = path.join(DATA_DIR, `${name}.yjs`);
    this.doc = new Y.Doc({ gc: true });
    /** @type {Map<import('ws').WebSocket, Set<number>>} */
    this.conns = new Map();
    this.saveTimer = null;
    this.unloadTimer = null;
    this.dirty = false;
    this.firstUnsavedAt = null;
    this.pendingBarrierSave = false;
    /** @type {Array<{ ws: import('ws').WebSocket, data: Buffer }>} */
    this.deferredMessages = [];

    try {
      let saved;
      try {
        saved = fs.readFileSync(this.file);
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
      if (saved) Y.applyUpdate(this.doc, saved);
    } catch (err) {
      // Keep unreadable state in place: an empty replacement would hide it from backups and image retention.
      this.doc.destroy();
      throw err;
    }
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalState(null);

    /** While a guarded message runs, updates wait here and go out as one, so nobody sees a forbidden change. */
    this.held = null;
    this.doc.on('update', (update) => {
      this.dirty = true;
      if (this.held) this.held.push(update);
      else this.broadcastUpdate(update);
      this.scheduleSave();
    });
    // Accounts mode: the relay checks comment authorship on every write to a comments room.
    this.guard = directory && this.kind === 'comments'
      ? createCommentGuard(this.doc, { isAccount: (id) => directory.getUser(id) !== null })
      : null;

    this.awareness.on('update', ({ added, updated, removed }, conn) => {
      const changed = added.concat(updated, removed);
      if (conn && this.conns.has(conn)) {
        const ids = this.conns.get(conn);
        added.forEach((id) => ids.add(id));
        removed.forEach((id) => ids.delete(id));
      }
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      this.broadcast(encoding.toUint8Array(enc));
    });
  }

  broadcast(msg) {
    for (const ws of this.conns.keys()) send(ws, msg);
  }

  broadcastUpdate(update) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    this.broadcast(encoding.toUint8Array(enc));
  }

  /** Applies a comments-room sync message as the socket's user, then corrects what their rules forbid. */
  guarded(ws, apply) {
    const user = directory.getUser(ws.userId);
    const actor = { id: ws.userId, role: ws.role, name: user?.name ?? ws.userName ?? '' };
    this.held = [];
    let undone = [];
    try {
      undone = this.guard.run(actor, apply);
    } finally {
      const held = this.held;
      this.held = null;
      if (held.length) this.broadcastUpdate(held.length === 1 ? held[0] : Y.mergeUpdates(held));
    }
    if (undone.length) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_COMMENT_NOTICE);
      encoding.writeVarString(enc, JSON.stringify({ undone }));
      send(ws, encoding.toUint8Array(enc));
    }
  }

  // A debounce, but never later than SAVE_MAX_WAIT_MS after the first change that is still unsaved.
  scheduleSave() {
    clearTimeout(this.saveTimer);
    const now = Date.now();
    this.firstUnsavedAt ??= now;
    const delay = saveDelay({ now, firstUnsavedAt: this.firstUnsavedAt, debounceMs: SAVE_DEBOUNCE_MS, maxWaitMs: SAVE_MAX_WAIT_MS });
    this.saveTimer = setTimeout(() => this.save(), delay);
  }

  /** Writes the room to its file. False when the write failed: the edits stay in memory and the save is tried again. */
  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (roomsFrozen) return true;
    if (snapshotBarrier?.active && !snapshotBarrier.writesAllowed) {
      // Not a failure: the snapshot barrier holds writes for a moment and the save runs again when it is released.
      this.pendingBarrierSave = true;
      return true;
    }
    this.pendingBarrierSave = false;
    const tmp = `${this.file}.tmp`;
    const bytes = Y.encodeStateAsUpdate(this.doc);
    try {
      fs.writeFileSync(tmp, bytes);
      renameSyncRetry(tmp, this.file);
    } catch (err) {
      // A full or failing disk must not throw out of a timer: that would end the process and every room's unsaved edits.
      log(`room ${this.name}: could not save, will retry in ${SAVE_RETRY_MS / 1000} s`, err?.code ?? err?.message);
      this.firstUnsavedAt ??= Date.now();
      if (!this.saveTimer && !roomsFrozen) this.saveTimer = setTimeout(() => this.save(), SAVE_RETRY_MS);
      return false;
    }
    this.firstUnsavedAt = null;
    // `changed`: something was edited since the last save. A save that only rewrites the same state (a room that is
    // unloaded, the save at shutdown) is not a change for the backups.
    const changed = this.dirty;
    this.dirty = false;
    if (directory && this.kind === 'board' && changed) {
      try {
        const title = this.doc.getMap('meta').get('name');
        directory.touchBoard(this.name, typeof title === 'string' && title.trim() ? { title } : {});
      } catch (err) {
        log(`room ${this.name}: could not update the directory`, err?.message);
      }
    }
    history.onSave(this, bytes);
    if (changed) backup?.noteChange();
    return true;
  }

  join(ws) {
    clearTimeout(this.unloadTimer);
    this.conns.set(ws, new Set());

    // Start the sync handshake: send our state vector.
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    send(ws, encoding.toUint8Array(enc));

    const states = this.awareness.getStates();
    if (states.size > 0) {
      const a = encoding.createEncoder();
      encoding.writeVarUint(a, MSG_AWARENESS);
      encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()]));
      send(ws, encoding.toUint8Array(a));
    }
    // only when there are runs: a client starts with none, and an app older than the message logs each one it gets
    const snapshot = this.kind === 'board' ? aiLive.snapshotFor(this.name, aiViewer(ws)) : null;
    if (snapshot?.runs.length) sendAiRuns(ws, snapshot);
  }

  leave(ws) {
    const ids = this.conns.get(ws);
    this.conns.delete(ws);
    if (ids?.size) awarenessProtocol.removeAwarenessStates(this.awareness, [...ids], null);
    if (this.conns.size === 0) {
      if (this.saveTimer) this.save();
      this.releaseIfIdle();
    }
  }

  // Starts the unload timer when nobody is connected. A room opened for an MCP edit would otherwise stay in memory.
  releaseIfIdle() {
    if (this.conns.size !== 0) return;
    clearTimeout(this.unloadTimer);
    this.unloadTimer = setTimeout(() => {
      if (this.conns.size === 0) {
        if (!this.save()) {
          this.releaseIfIdle();
          return;
        }
        this.doc.destroy();
        rooms.delete(this.name);
        if (this.kind === 'board') aiLive.dropBoard(this.name);
        log(`room ${this.name}: unloaded`);
      }
    }, UNLOAD_AFTER_MS);
  }
  /**
   * A board named through POST or PATCH /api/boards (outside the app) has its title only in the directory, and the
   * board would open as "Untitled board". A board document without a name takes the
   * directory's title; one with a name keeps it (saving copies it to the directory, as before).
   */
  nameFromDirectory() {
    if (!directory || this.kind !== 'board') return;
    const title = directory.getBoard(this.name)?.title;
    const meta = this.doc.getMap('meta');
    if (typeof title === 'string' && title !== DEFAULT_TITLE && !meta.has('name')) this.setName(title);
  }

  setName(title) {
    const meta = this.doc.getMap('meta');
    if (meta.get('name') !== title) this.doc.transact(() => meta.set('name', title), 'relay');
  }


  onMessage(ws, data) {
    if (snapshotBarrier?.active && !snapshotBarrier.writesAllowed && ws.canWrite === true) {
      try {
        const peek = decoding.createDecoder(new Uint8Array(data));
        if (decoding.readVarUint(peek) === MSG_SYNC && decoding.peekVarUint(peek) !== syncProtocol.messageYjsSyncStep1) {
          // Queue client state updates while the disk copies are made. State-vector reads and awareness still flow, and
          // the open socket stays connected. Replaying the frame after release lets the normal debounced save run.
          this.deferredMessages.push({ ws, data: Buffer.from(new Uint8Array(data)) });
          return;
        }
      } catch {
        // The usual handler below logs malformed frames; do not turn a bad frame into an unbounded queued write.
      }
    }
    try {
      const dec = decoding.createDecoder(new Uint8Array(data));
      const type = decoding.readVarUint(dec);
      if (type === MSG_SYNC) {
        // A connection that may not write this room can still ask for the state (step 1): step 2 and updates are dropped.
        if (ws.canWrite !== true && decoding.peekVarUint(dec) !== syncProtocol.messageYjsSyncStep1) return;
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        const apply = () => syncProtocol.readSyncMessage(dec, enc, this.doc, ws);
        // A state vector (step 1) changes nothing, so only step 2 and updates go through the guard.
        if (this.guard && ws.userId && decoding.peekVarUint(dec) !== syncProtocol.messageYjsSyncStep1) this.guarded(ws, apply);
        else apply();
        if (encoding.length(enc) > 1) send(ws, encoding.toUint8Array(enc));
      } else if (type === MSG_AWARENESS) {
        const update = decoding.readVarUint8Array(dec);
        const safeUpdate = ws.guest
          ? awarenessProtocol.modifyAwarenessUpdate(update, (state) => cleanGuestAwarenessState(state, ws))
          : update;
        awarenessProtocol.applyAwarenessUpdate(this.awareness, safeUpdate, ws);
      }
    } catch (err) {
      log(`room ${this.name}: bad message`, err?.message);
    }
  }

  releaseDeferredMessages() {
    const queued = this.deferredMessages;
    this.deferredMessages = [];
    for (const { ws, data } of queued) this.onMessage(ws, data);
    if (this.pendingBarrierSave) this.scheduleSave();
  }
}

/** The room for a new socket, or null when it cannot be opened (its file cannot be read): the socket is closed. */
function openRoom(ws, name) {
  try {
    return getRoom(name);
  } catch (err) {
    log(`room ${name}: could not open`, err?.message);
    ws.close(1011, 'internal_error');
    return null;
  }
}

function getRoom(name) {
  if (roomsFrozen) throw new Error('the workspace is being restored');
  let r = rooms.get(name);
  if (!r) {
    r = new Room(name);
    rooms.set(name, r);
    log(`room ${name}: loaded`);
    r.nameFromDirectory();
  }
  return r;
}

// MCP (docs/mcp.md) edits the live room documents through this, never the files. `read` loads nothing into memory
// (a room that is open is read in place, otherwise the file is decoded into a throwaway document); `write` applies
// fn inside one transaction on the room's own doc, so the update listener broadcasts it to every socket and saves it.
// Callers have authorised the board before they get here: getRoom() creates the room file for an unknown name.
const roomAccess = {
  exists: (name) => rooms.has(name) || fs.existsSync(path.join(DATA_DIR, `${name}.yjs`)),
  read(name, fn) {
    const open = rooms.get(name);
    if (open) return fn(open.doc);
    const doc = new Y.Doc({ gc: true });
    try {
      const file = path.join(DATA_DIR, `${name}.yjs`);
      if (fs.existsSync(file)) Y.applyUpdate(doc, fs.readFileSync(file));
      return fn(doc);
    } finally {
      doc.destroy();
    }
  },
  write(name, origin, fn) {
    const room = getRoom(name);
    try {
      let result;
      room.doc.transact(() => {
        result = fn(room.doc);
      }, origin);
      return result;
    } finally {
      room.releaseIfIdle();
    }
  },
};

// AI features in open mode (docs/ai.md): the operator's key, counted per client address. Accounts mode has the route in api.mjs.
const openAiRun = config.authEnabled ? null : createOpenRun({ config, canWriteRoom, readRoom: (name, fn) => roomAccess.read(name, fn), roomExists: (name) => roomAccess.exists(name), live: aiLive, log });

// Who a socket's person is to the AI policy. Open mode has no roles or names: everyone edits and nobody is the runner.
const aiViewer = (ws) => (config.authEnabled ? { role: ws.denied ? null : ws.role, userId: ws.userId } : { role: 'owner', userId: null });

function sendAiRuns(ws, payload) {
  if (!payload) return;
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_AI_RUNS);
  encoding.writeVarString(enc, JSON.stringify(payload));
  send(ws, encoding.toUint8Array(enc));
}

// Each socket gets its own copy, shaped by policy.mjs for its person; nobody is sent what they may not see.
aiLive.onChange(({ boardId, run }) => {
  const room = rooms.get(boardId);
  if (!room) return;
  for (const ws of room.conns.keys()) sendAiRuns(ws, aiLive.patchFor(run, aiViewer(ws)));
});
setInterval(() => aiLive.sweep(), AI_SWEEP_MS).unref();

let mcp = null;
if (config.mcp) {
  const { createMcp } = await import('./mcp.mjs');
  mcp = createMcp({ config, directory, cloud, canWriteRoom, roomAccess, log, snapshotBarrier });
}

function workspaceHint(readOnly) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_WORKSPACE);
  encoding.writeVarString(enc, JSON.stringify({ readOnly }));
  return encoding.toUint8Array(enc);
}

function send(ws, msg) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(msg, (err) => {
    if (err) ws.close();
  });
}

// ---------------------------------------------------------------- http

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.map': 'application/json',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

// TABULA_DEV_ALLOW_FRAMING=1 drops frame-ancestors so a page can show this app in an iframe at a chosen width
// (scripts/visual-check.mjs --frameable, docs/visual-check.md). It removes the clickjacking protection: never set it on
// a server people use.
const ALLOW_FRAMING = env.TABULA_DEV_ALLOW_FRAMING === '1';
if (ALLOW_FRAMING) console.warn('TABULA_DEV_ALLOW_FRAMING=1: any page can frame this app. Use it for local visual checks only, never on a server people use.');

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://api.fontshare.com",
  "font-src 'self' data: https://cdn.fontshare.com",
  "img-src 'self' data: blob: https://api.iconify.design https://api.simplesvg.com https://api.unisvg.com",
  "connect-src 'self' ws: wss: https://api.fontshare.com https://cdn.fontshare.com https://api.iconify.design https://api.simplesvg.com https://api.unisvg.com",
  "worker-src 'self'",
  "base-uri 'none'",
  ...(ALLOW_FRAMING ? [] : ["frame-ancestors 'none'"]),
].join('; ');

const DOCS = path.join(DIST, 'docs');

function sendFile(res, file, status, cache) {
  const ext = path.extname(file);
  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': cache,
  };
  if (ext === '.html') headers['content-security-policy'] = CSP;
  res.writeHead(status, headers);
  fs.createReadStream(file).pipe(res);
}

// The user guide: files are resolved inside dist/docs only and never fall back to the app shell.
function serveDocs(req, res, url) {
  const decoded = decodeURIComponent(url.pathname);
  const notFound = () => {
    const page = path.join(DOCS, '404.html');
    if (fs.existsSync(page)) sendFile(res, page, 404, 'no-cache');
    else res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
  };
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some((seg) => seg === '..' || seg === '.')) {
    res.writeHead(404).end();
    return;
  }
  const rel = decoded.slice('/docs'.length).replace(/^\/+|\/+$/g, '');
  const ext = path.extname(rel);
  const file = path.resolve(DOCS, rel === '' ? 'index.html' : ext ? rel : path.join(rel, 'index.html'));
  if (!file.startsWith(DOCS + path.sep)) {
    res.writeHead(404).end();
    return;
  }
  const isFile = fs.existsSync(file) && fs.statSync(file).isFile();
  if (!isFile || file === path.join(DOCS, '404.html')) {
    if (!ext || ext === '.html') notFound();
    else res.writeHead(404).end();
    return;
  }
  sendFile(res, file, 200, 'no-cache');
}

// The icon sets built by scripts/build-icons.mjs (docs/icons-selfhost.md). Files are stored as <name>.gz and sent
// under the name without .gz. A missing file is a real 404: the single-page app's index.html must never stand in
// for an icon file, or a client could not tell "not hosted" from "offline" and a cache would keep an HTML page.
const ICONS_DIR = path.join(DIST, 'icons');
const HASHED_ICON = /\.[0-9a-f]{8}\.json$/;

const acceptsGzip = (header) => {
  for (const part of String(header || '').split(',')) {
    const [coding, ...params] = part.trim().toLowerCase().split(';');
    if (coding !== 'gzip' && coding !== '*') continue;
    const q = params.map((x) => x.trim()).find((x) => x.startsWith('q='));
    return !q || Number(q.slice(2)) > 0;
  }
  return false;
};

function serveIcons(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }
  const file = path.resolve(ICONS_DIR, decodeURIComponent(url.pathname).slice('/icons/'.length));
  // checked before any file system call, so a path outside the icons folder is never even looked at
  if (!file.startsWith(ICONS_DIR + path.sep) || file.endsWith('.gz') || file.includes('\0')) return sendJson(res, 404, { error: 'not_found' });
  const isFile = (f) => fs.existsSync(f) && fs.statSync(f).isFile();
  const zipped = isFile(`${file}.gz`);
  const source = zipped ? `${file}.gz` : file;
  if (!isFile(source)) return sendJson(res, 404, { error: 'not_found' });
  const gzip = zipped && acceptsGzip(req.headers['accept-encoding']);
  const headers = {
    'content-type': file.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'application/json',
    'cache-control': HASHED_ICON.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    vary: 'Accept-Encoding',
  };
  if (gzip) headers['content-encoding'] = 'gzip';
  if (gzip || !zipped) headers['content-length'] = fs.statSync(source).size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  const body = fs.createReadStream(source).on('error', () => res.destroy());
  if (zipped && !gzip) body.pipe(zlib.createGunzip()).on('error', () => res.destroy()).pipe(res);
  else body.pipe(res);
}

function serveStatic(req, res, url) {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('The app has not been built yet. Run `npm run build`, then restart the relay. (In development, open the Vite URL instead.)');
    return;
  }
  if (url.pathname === '/docs' || url.pathname.startsWith('/docs/')) {
    serveDocs(req, res, url);
    return;
  }
  let rel = decodeURIComponent(url.pathname);
  let file = path.resolve(DIST, '.' + rel);
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  const appRoute = url.pathname === '/t' || url.pathname.startsWith('/t/')
    || url.pathname === '/b' || url.pathname.startsWith('/b/');
  if (appRoute || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  const ext = path.extname(file);
  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
  if (ext === '.html') headers['content-security-policy'] = CSP;
  headers['cache-control'] = rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

const NO_STORE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', ...NO_STORE });
  res.end(JSON.stringify(body));
}

// Open mode has no api.mjs to notice a write: its image and version-history routes tell the backups themselves.
function noteOpenWrite(req, res) {
  const method = String(req.method).toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && res.statusCode < 400) backup?.noteChange();
}

async function onRequest(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    const runOpenWriter = (fn) => {
      const method = String(req.method).toUpperCase();
      return snapshotBarrier && !['GET', 'HEAD', 'OPTIONS'].includes(method) ? snapshotBarrier.runWriter(fn) : fn();
    };
    // TAB-103: with TABULA_SOURCE_POLICY=proxy only loopback and Fly's proxy range may talk to this instance. The health
    // check is left open, because the platform's own check may not come from either.
    if (!sourceGate.allows(req.socket.remoteAddress) && !(req.method === 'GET' && url.pathname === '/api/health')) {
      sourceGate.refused(req.socket.remoteAddress);
      req.socket.destroy();
      return;
    }
    if (url.pathname === '/mcp' && auth?.authenticateGuest(req.headers.cookie)) {
      sendJson(res, 403, { error: 'forbidden', message: 'This guest session is limited to one board' });
    } else if (url.pathname === '/mcp' && maintenance) {
      res.setHeader('retry-after', '30');
      sendJson(res, 503, { error: 'restoring' });
    } else if (url.pathname === '/mcp') {
      // Never the single-page app: /mcp is either the endpoint or a 404.
      if (mcp) await mcp.handle(req, res);
      else sendJson(res, 404, { error: 'not_found' });
    } else if (url.pathname === '/api/health' && auth?.authenticateGuest(req.headers.cookie)) {
      sendJson(res, 403, { error: 'forbidden', message: 'This guest session is limited to one board' });
    } else if (url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, ...liveStats(), ...(maintenance ? { restoring: true } : {}) });
    } else if (url.pathname.startsWith('/api/')) {
      // Anything under /api/ is answered here and never falls through to the single-page app.
      if (api) {
        if (!(await api.handle(req, res))) sendJson(res, 404, { error: 'not_found' });
      } else if (url.pathname === '/api/config') {
        sendJson(res, 200, { authEnabled: false, ...(assets ? { images: true } : {}) });
      } else if (url.pathname === '/api/ai/config' && req.method === 'GET') {
        sendJson(res, 200, openAiConfig(config));
      } else if (url.pathname === '/api/ai/run' && req.method === 'POST') {
        await openAiRun.handle(req, res); // streams for minutes and writes through the room: no barrier lease
      } else if (/^\/api\/ai\/runs\/[A-Za-z0-9_-]{1,64}\/resolve$/.test(url.pathname) && req.method === 'POST') {
        await runOpenWriter(() => openAiRun.resolve(req, res, url.pathname.split('/')[4]));
      } else if (openAssets && (await runOpenWriter(() => openAssets(req, res, url)))) {
        // answered: an image upload or download of open mode
        noteOpenWrite(req, res);
      } else if (await runOpenWriter(() => history.handleOpen(req, res))) {
        noteOpenWrite(req, res);
      } else {
        sendJson(res, 404, { error: 'not_found' });
      }
    } else if (url.pathname.startsWith('/icons/')) {
      serveIcons(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (err) {
    log('request failed', req.method, scrubText(err?.message));
    if (res.headersSent) res.end();
    else if (err instanceof URIError || err instanceof TypeError) res.writeHead(400).end();
    else res.writeHead(500).end();
  }
}

const sourceGate = createSourceGate(config.sourcePolicy, { log });
const server = http.createServer(onRequest);
const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
// The /chat socket (docs/chat.md): small JSON frames only, so a much smaller limit than the Yjs rooms.
const chatWss = chatHub ? new WebSocketServer({ noServer: true, maxPayload: (await import('./chat-hub.mjs')).MAX_CLIENT_FRAME }) : null;

function closeChat() {
  const store = chatStore;
  chatStore = null;
  try {
    store?.close();
  } catch (err) {
    log('chat: could not close the database', err?.message);
  }
}

// ---------------------------------------------------------------- accounts: who is connected

const isWorkspaceAdmin = (user) => user.role === 'owner' || user.role === 'admin';

/** @type {Map<string, Set<import('ws').WebSocket>>} */
const userSockets = new Map();

function track(ws) {
  let set = userSockets.get(ws.userId);
  if (!set) userSockets.set(ws.userId, (set = new Set()));
  set.add(ws);
}

function untrack(ws) {
  const set = userSockets.get(ws.userId);
  set?.delete(ws);
  if (set?.size === 0) userSockets.delete(ws.userId);
}

const socketsOf = (userId) => [...(userSockets.get(userId) ?? [])];
const allSockets = () => [...userSockets.values()].flatMap((set) => [...set]);

// Runs before the room is touched: an unauthorised connection must never load or create a room file.
function authorise(req, board) {
  const session = auth.authenticate(req.headers.cookie);
  if (!session) return { code: CLOSE_UNAUTHENTICATED, reason: 'unauthenticated' };
  if (session.guest) {
    if (session.boardId !== board) return { code: CLOSE_FORBIDDEN, reason: 'no_access' };
    return { session, role: session.boardRole, deleted: false };
  }
  const row = directory.getBoard(board);
  if (!row || (row.deletedAt != null && !isWorkspaceAdmin(session.user))) return { code: CLOSE_NOT_FOUND, reason: 'board_not_found' };
  const role = directory.boardRole(board, session.user.id);
  if (role === null) return { code: CLOSE_FORBIDDEN, reason: 'no_access' };
  return { session, role, deleted: row.deletedAt != null };
}

function deny(ws, code, reason) {
  ws.denied = true;
  ws.role = null;
  ws.canWrite = false;
  if (ws.guestExpiryTimer) clearTimeout(ws.guestExpiryTimer);
  ws.guestExpiryTimer = null;
  ws.close(code, reason);
}

function armGuestExpiry(ws) {
  if (!ws.guest || ws.denied) return;
  const remaining = ws.sessionExpiresAt - Date.now();
  ws.guestExpiryTimer = setTimeout(() => {
    ws.guestExpiryTimer = null;
    if (ws.readyState !== ws.OPEN) return;
    if (ws.sessionExpiresAt > Date.now()) return armGuestExpiry(ws);
    refresh(ws, true);
    if (!ws.denied) armGuestExpiry(ws);
  }, Math.max(0, remaining));
  ws.guestExpiryTimer.unref?.();
}

// Re-resolves the role of one connection. `force` skips the 5 second throttle (access changes and revocations).
function refresh(ws, force) {
  if (ws.denied) return;
  const now = Date.now();
  if (!force && now - ws.checkedAt < ROLE_RECHECK_MS) return;
  ws.checkedAt = now;
  try {
    if (ws.guest) {
      const guest = auth.authenticateGuest(ws.cookie);
      if (!guest || guest.sessionId !== ws.sessionId || guest.boardId !== ws.boardId) return deny(ws, CLOSE_ACCESS_REMOVED, 'access_removed');
      ws.sessionExpiresAt = guest.expiresAt;
      ws.role = guest.boardRole;
      ws.userName = guest.user.name;
      ws.userColor = guestPresenceColor(guest.user.id);
      ws.deleted = false;
      ws.canWrite = canWriteRoom(guest.boardRole, ws.roomKind, false);
      return;
    }
    const role = directory.boardRole(ws.boardId, ws.userId);
    if (role === null) return deny(ws, CLOSE_ACCESS_REMOVED, 'access_removed');
    if (ws.sessionRevoked) return deny(ws, CLOSE_UNAUTHENTICATED, 'unauthenticated');
    if (now >= ws.sessionExpiresAt) {
      // The expiry slides while the person uses the app elsewhere, so ask before giving up on it.
      const session = auth.authenticate(ws.cookie);
      if (!session || session.sessionId !== ws.sessionId) return deny(ws, CLOSE_UNAUTHENTICATED, 'unauthenticated');
      ws.sessionExpiresAt = session.expiresAt;
    }
    ws.role = role;
    ws.deleted = directory.getBoard(ws.boardId)?.deletedAt != null;
    ws.canWrite = canWriteRoom(role, ws.roomKind, ws.deleted);
  } catch (err) {
    log(`room ${ws.roomName}: could not resolve a role`, err?.message);
    deny(ws, 1011, 'internal_error');
  }
}

if (config.authEnabled) {
  events.on('access-changed', ({ userId, boardId } = {}) => {
    for (const ws of userId ? socketsOf(userId) : allSockets()) {
      if (!boardId || ws.boardId === boardId) refresh(ws, true);
    }
  });
  events.on('session-revoked', ({ userId, sessionId } = {}) => {
    for (const ws of socketsOf(userId)) {
      if (sessionId && ws.sessionId !== sessionId) continue;
      ws.sessionRevoked = true;
      refresh(ws, true);
    }
  });
  // PATCH /api/boards/:id renamed it: the board itself shows the new name, and the next save keeps it.
  events.on('board-renamed', ({ boardId, title } = {}) => {
    if (typeof boardId !== 'string' || typeof title !== 'string' || !parseRoom(boardId)) return;
    try {
      const room = getRoom(boardId);
      room.setName(title);
      room.releaseIfIdle();
    } catch (err) {
      log(`room ${boardId}: could not rename`, err?.message);
    }
  });
  events.on('user-removed', ({ userId } = {}) => {
    for (const ws of socketsOf(userId)) refresh(ws, true);
  });
  // A workspace that turns read-only (or back) applies to sockets that are already open, and only a flip of that switch
  // (not a banner, a seat limit or a repeated value) tells the clients, who then ask /api/me what is true. `send` skips
  // a socket that is closing, such as one the refresh just denied.
  let knownReadOnly = cloud?.limits().readOnly === true;
  events.on('limits-changed', ({ readOnly } = {}) => {
    const flipped = (readOnly === true) !== knownReadOnly;
    knownReadOnly = readOnly === true;
    const hint = flipped ? workspaceHint(knownReadOnly) : null;
    for (const ws of allSockets()) {
      refresh(ws, true);
      if (hint) send(ws, hint);
    }
  });
  setInterval(() => {
    for (const ws of allSockets()) refresh(ws, false);
  }, 1000);
}

server.on('upgrade', (req, socket, head) => {
  if (!sourceGate.allows(socket.remoteAddress)) {
    sourceGate.refused(socket.remoteAddress);
    socket.destroy();
    return;
  }
  // Before anything else: a page on another origin (for example a sibling workspace subdomain) must not ride the cookie.
  if (config.authEnabled && req.headers.origin !== config.origin) {
    socket.on('error', () => socket.destroy());
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  let pathname = null;
  try {
    pathname = new URL(req.url, 'http://x').pathname;
  } catch {
    pathname = null;
  }
  if (pathname === '/chat') {
    if (!chatWss) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    if (auth?.authenticateGuest(req.headers.cookie)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    chatWss.handleUpgrade(req, socket, head, (ws) => {
      if (maintenance) {
        ws.close(CLOSE_RESTORING, 'restoring');
        return;
      }
      try {
        chatHub.connect(ws, req);
      } catch (err) {
        log('chat: could not open a socket', err?.message);
        ws.close(1011, 'internal_error');
      }
    });
    return;
  }
  let name = null;
  try {
    const m = new URL(req.url, 'http://x').pathname.match(/^\/sync\/([^/]+)$/);
    name = m && decodeURIComponent(m[1]);
  } catch {
    name = null;
  }
  const parsed = parseRoom(name);
  if (!parsed) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.binaryType = 'arraybuffer';
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('error', () => ws.close());

    if (maintenance) {
      ws.close(CLOSE_RESTORING, 'restoring');
      return;
    }

    if (!config.authEnabled) {
      ws.canWrite = true;
      const room = openRoom(ws, name);
      if (!room) return;
      ws.on('message', (data) => room.onMessage(ws, data));
      ws.on('close', () => room.leave(ws));
      room.join(ws);
      return;
    }

    let verdict;
    try {
      verdict = authorise(req, parsed.boardId);
    } catch (err) {
      log(`room ${name}: could not authorise`, err?.message);
      verdict = { code: 1011, reason: 'internal_error' };
    }
    if (!verdict.session) {
      ws.close(verdict.code, verdict.reason);
      return;
    }

    ws.userId = verdict.session.user.id;
    ws.userName = verdict.session.user.name;
    ws.sessionId = verdict.session.sessionId;
    ws.sessionExpiresAt = verdict.session.expiresAt;
    ws.cookie = req.headers.cookie;
    ws.boardId = parsed.boardId;
    ws.roomName = name;
    ws.roomKind = parsed.kind;
    ws.role = verdict.role;
    ws.guest = verdict.session.guest === true;
    ws.userColor = ws.guest ? guestPresenceColor(ws.userId) : null;
    ws.deleted = verdict.deleted;
    ws.canWrite = canWriteRoom(verdict.role, parsed.kind, verdict.deleted);
    ws.checkedAt = Date.now();
    ws.sessionRevoked = false;
    ws.denied = false;
    const room = openRoom(ws, name);
    if (!room) return;
    track(ws);
    if (ws.guest) armGuestExpiry(ws);
    ws.on('message', (data) => {
      refresh(ws, false);
      if (!ws.denied) room.onMessage(ws, data);
    });
    ws.on('close', () => {
      if (ws.guestExpiryTimer) clearTimeout(ws.guestExpiryTimer);
      ws.guestExpiryTimer = null;
      untrack(ws);
      room.leave(ws);
    });
    room.join(ws);
  });
});

const pinger = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, PING_MS);

// The rooms are saved first, so the files include the state the final backup starts with. Then the backup gets
// TABULA_BACKUP_SHUTDOWN_SECONDS to finish a run in progress and to back up what changed since the last one (a restore
// holds maintenance and stops the backups itself). Whatever is still running after that is told to stop and given a
// moment to let go of the database before it is closed; both waits are short, so a supervisor's kill timeout is not reached.
const BACKUP_STOP_WAIT_MS = 2000;
async function stopRelay() {
  clearInterval(pinger);
  cloud?.close();
  // A snapshot hold must never turn a shutdown save into a deferred one: the process is about to exit.
  const saveNow = () => (snapshotBarrier ? snapshotBarrier.allowWrites(saveAllRooms) : saveAllRooms());
  let saved = saveNow();
  if (backup && !maintenance && backupConfig.shutdownSeconds > 0) {
    await backup.finish({ budgetMs: backupConfig.shutdownSeconds * 1000 });
  }
  const stopping = backup?.stop();
  restore?.stop();
  chatHub?.stop();
  chatRetention?.stop();
  chatNotifier?.stop();
  trackerNotifier?.stop();
  if (stopping) {
    await Promise.race([stopping, new Promise((resolve) => setTimeout(resolve, BACKUP_STOP_WAIT_MS))]);
    // Edits can arrive during either backup wait. Nothing may yield between this final save and exit.
    saved = saveNow();
  }
  history.close();
  closeChat();
  directory?.close();
  process.exit(saved ? 0 : 1);
}
// Every way in shares one run, so a second signal while it winds down changes nothing.
let shuttingDown = null;
const shutdown = () => (shuttingDown ??= stopRelay());
// SIGINT is what Ctrl+C and service wrappers send on Windows; SIGBREAK (Ctrl+Break) and SIGHUP (console closed)
// are the others it can deliver. Windows cannot catch a kill, so those are the only graceful routes there.
// SIGBREAK is never raised on other systems, and listening for it there does nothing.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(signal, shutdown);
// A parent that started the relay with an IPC channel (the tests, a Node service wrapper) can ask for the same
// shutdown on every system, because Node cannot send a console Ctrl event to a child on Windows.
if (process.send) {
  process.on('message', (message) => {
    if (message?.type === 'shutdown') shutdown();
  });
}

server.listen(PORT, HOST, () => {
  backup?.start();
  restore?.start();
  // The people in a restored workspace (or on an adopted copy) are not the ones the control plane last heard about.
  if (recovery.action === 'completed' || volumeAdopted) events.emit('usage-changed');
  log(`Tabula relay on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (data: ${DATA_DIR})${config.authEnabled ? '  (accounts mode)' : ''}${cloud ? '  (hosted workspace)' : ''}${backup ? '  (backups on)' : ''}`);
});
