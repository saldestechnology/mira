import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { startRelayProcess } from './start-relay';

// Every board has a sibling comments room (`<boardId>~comments`). The relay runs as a child process,
// once in open mode and once in accounts mode, exactly as `npm start` would.

let OPEN_PORT = 0;
let ACCOUNTS_PORT = 0;
const OWNER = 'owner@example.com';

type Body = any;
type Res = { status: number; body: Body; headers: Headers };
type Account = { cookie: string; user: Body; email: string };

const stopRelay = (p: ChildProcess) =>
  new Promise<void>((r) => {
    if (p.exitCode !== null || p.signalCode !== null) return r();
    p.once('exit', () => r());
    p.kill('SIGTERM');
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const until = async (fn: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await sleep(20);
  }
};

const within = <T>(p: Promise<T>, ms = 4000) =>
  Promise.race([p, sleep(ms).then(() => Promise.reject(new Error('timed out')))]) as Promise<T>;

const ping = (ws: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('pong', onPong);
      reject(new Error('timed out waiting for WebSocket pong'));
    }, 4000);
    const onPong = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.once('pong', onPong);
    try {
      ws.ping();
    } catch (error) {
      clearTimeout(timer);
      ws.off('pong', onPong);
      reject(error);
    }
  });

const updateFrame = () => {
  const doc = new Y.Doc();
  doc.getMap('objects').set('sneaky', 1);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(doc));
  return encoding.toUint8Array(enc);
};

const awarenessFrame = (name: string) => {
  const awareness = new awarenessProtocol.Awareness(new Y.Doc());
  awareness.setLocalState({ user: { name } });
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 1);
  encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID]));
  return encoding.toUint8Array(enc);
};

const COMMENTS = '~comments';
const SAVE_WINDOW_MS = 1400; // longer than the relay's save debounce

/** A comment thread as the relay accepts it: anything else in the threads map is taken out again. */
const threadValue = (id: string) => {
  const m = new Y.Map<unknown>([['id', id], ['createdAt', 1], ['text', 'hi'], ['anchor', { x: 0, y: 0 }], ['resolved', false]]);
  m.set('replies', new Y.Map());
  return m;
};

// ---------------------------------------------------------------- open mode

describe('comments rooms in open mode', { timeout: 20_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-comments-open-'));
  let relay: ChildProcess;
  const providers = new Set<WebsocketProvider>();

  beforeAll(async () => {
    const started = await startRelayProcess({
      envFor: (port) => ({ ...(process.env as Record<string, string>), PORT: String(port), DATA_DIR: dir, HOST: '127.0.0.1', TABULA_AUTH: 'off' }),
    });
    OPEN_PORT = started.port;
    relay = started.proc;
  });
  afterEach(() => {
    for (const p of providers) p.destroy();
    providers.clear();
  });
  afterAll(async () => {
    if (relay && relay.exitCode === null && relay.signalCode === null) await stopRelay(relay);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const client = (room: string) => {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(`ws://127.0.0.1:${OPEN_PORT}/sync`, room, doc, {
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
      disableBc: true,
    });
    providers.add(provider);
    return { doc, provider };
  };
  const synced = (c: ReturnType<typeof client>) => until(() => c.provider.wsconnected && c.provider.synced);

  /** 'open' when the relay accepts the room name, otherwise the HTTP status of the refusal. */
  const probe = (name: string) =>
    new Promise<'open' | number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${OPEN_PORT}/sync/${name}`);
      ws.on('open', () => {
        ws.terminate();
        resolve('open');
      });
      ws.on('unexpected-response', (req, res) => {
        req.destroy();
        resolve(res.statusCode ?? 0);
      });
      ws.on('error', () => {});
    });

  const id64 = 'a'.repeat(64);

  it('accepts a board id with or without the comments suffix', async () => {
    for (const name of ['abc', `abc${COMMENTS}`, 'A_b-9', `A_b-9${COMMENTS}`, 'a', id64, `${id64}${COMMENTS}`, 'abc%7Ecomments']) {
      expect(await within(probe(name))).toBe('open');
    }
  });

  it('answers 400 to every other room name', async () => {
    const bad = [
      'x~other',
      '~comments',
      'a~comments~comments',
      'abc~',
      'abc~comments~',
      'abc~Comments',
      'abc~COMMENTS',
      'abc~commentsx',
      'abc~comments%0A',
      'abc~comments%20',
      'abc%7Ecomments%7Ecomments',
      `${id64}a`,
      `${id64}a${COMMENTS}`,
      'a.b',
      'a%2Fb',
      '..%2Fetc',
      '%2e%2e',
      '%E0%A4%A',
    ];
    for (const name of bad) expect(await within(probe(name))).toBe(400);
  });

  it('relays and persists a comments room separately from its board room', async () => {
    const board = 'open-board-1';
    const a = client(`${board}${COMMENTS}`);
    const b = client(`${board}${COMMENTS}`);
    const onBoard = client(board);
    const otherOnBoard = client(board);
    await Promise.all([a, b, onBoard, otherOnBoard].map(synced));

    const thread = new Y.Map<unknown>([['text', 'first!']]);
    a.doc.getMap('threads').set('t1', thread);
    await until(() => b.doc.getMap('threads').has('t1'));
    expect(((b.doc.getMap('threads').get('t1')) as Y.Map<unknown>).get('text')).toBe('first!');

    // the board room is a different document: the same writer rules apply (everyone) but nothing crosses over
    onBoard.doc.getMap('objects').set('x', 1);
    await until(() => otherOnBoard.doc.getMap('objects').has('x'));
    expect(onBoard.doc.getMap('threads').has('t1')).toBe(false);
    expect(b.doc.getMap('objects').has('x')).toBe(false);

    const commentsFile = path.join(dir, `${board}${COMMENTS}.yjs`);
    const boardFile = path.join(dir, `${board}.yjs`);
    const saved = () => {
      if (!fs.existsSync(commentsFile) || !fs.existsSync(boardFile)) return false;
      const doc = new Y.Doc();
      Y.applyUpdate(doc, fs.readFileSync(commentsFile));
      return doc.getMap('threads').has('t1');
    };
    await until(saved);

    const fromComments = new Y.Doc();
    Y.applyUpdate(fromComments, fs.readFileSync(commentsFile));
    expect(fromComments.getMap('objects').has('x')).toBe(false);
    const fromBoard = new Y.Doc();
    Y.applyUpdate(fromBoard, fs.readFileSync(boardFile));
    expect(fromBoard.getMap('objects').has('x')).toBe(true);
    expect(fromBoard.getMap('threads').has('t1')).toBe(false);

    // a later joiner catches up from the saved comments room
    const late = client(`${board}${COMMENTS}`);
    await until(() => late.doc.getMap('threads').has('t1'));
  });

  it('keeps a comments room on disk without ever creating the board room file', async () => {
    const board = 'open-board-2';
    const a = client(`${board}${COMMENTS}`);
    await synced(a);
    a.doc.getMap('threads').set('t1', 1);
    // Wait for the save rather than a fixed window: a slow Windows runner can take longer than the debounce.
    await until(() => fs.existsSync(path.join(dir, `${board}${COMMENTS}.yjs`)));
    expect(fs.existsSync(path.join(dir, `${board}.yjs`))).toBe(false);
  });
});

// ---------------------------------------------------------------- accounts mode

describe('comments rooms in accounts mode', { timeout: 30_000 }, () => {
  let baseUrl = '';
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-comments-accounts-'));
  const outbox = path.join(dataDir, 'outbox.jsonl');
  let relay: ChildProcess;
  let owner: Account;

  let seq = 0;
  const unique = (tag: string) => `${tag}${++seq}x${Math.random().toString(36).slice(2, 7)}`;
  const emailOf = (tag: string) => `${unique(tag)}@example.com`;
  let ipSeq = 0;
  const nextIp = () => `10.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}.9`;

  async function api(cookie: string | undefined, method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const res = await fetch(baseUrl + urlPath, {
      method,
      headers: {
        'x-tabula': '1',
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
  }

  type Mail = { to: string; subject: string; text: string };
  const mailCount = () => (fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean).length : 0);
  const mailsSince = (n: number): Mail[] =>
    fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean).slice(n).map((l) => JSON.parse(l));
  const tokenOf = (mail: Mail) => decodeURIComponent(/token=([^\s&]+)/.exec(mail.text)![1]);

  async function signIn(email: string, invite?: string): Promise<Account> {
    const before = mailCount();
    const res = await api(undefined, 'POST', '/api/auth/request', { email, invite }, { 'x-forwarded-for': nextIp() });
    const mails = mailCount() > before ? mailsSince(before) : [];
    if (res.status !== 200 || mails.length !== 1) throw new Error(`no sign-in mail for ${email} (status ${res.status})`);
    const verify = await api(undefined, 'POST', '/api/auth/verify', { token: tokenOf(mails[0]) });
    if (verify.status !== 200) throw new Error(`verify failed with ${verify.status}`);
    const cookie = /tabula_session=[^;]+/.exec(verify.headers.getSetCookie()[0])![0];
    return { cookie, user: verify.body.user, email };
  }

  async function newTeam(cookie: string) {
    const res = await api(cookie, 'POST', '/api/teams', { name: unique('Team') });
    if (res.status !== 201) throw new Error(`could not create a team (${res.status})`);
    return res.body as Body;
  }

  async function joinTeam(adminCookie: string, teamId: string) {
    const invite = await api(adminCookie, 'POST', `/api/teams/${teamId}/invites`, { role: 'member' });
    if (invite.status !== 201) throw new Error(`could not create an invite (${invite.status})`);
    return signIn(emailOf('user'), invite.body.token);
  }

  async function newBoard(cookie: string, extra: Record<string, unknown> = {}) {
    const id = unique('board');
    const res = await api(cookie, 'POST', '/api/boards', { id, ...extra });
    if (res.status !== 201) throw new Error(`could not create a board (${res.status} ${JSON.stringify(res.body)})`);
    return id;
  }

  const share = (cookie: string, board: string, userId: string, role: string) =>
    api(cookie, 'POST', `/api/boards/${board}/shares`, { principalType: 'user', principalId: userId, role });

  const boardView = async (cookie: string, board: string) =>
    ((await api(cookie, 'GET', '/api/boards')).body as Body[]).find((b) => b.id === board);

  // ------------------------------------------------------------ websocket helpers

  const wsHeaders = (cookie?: string): Record<string, string> => ({ Origin: baseUrl, ...(cookie ? { Cookie: cookie } : {}) });

  const sockets = new Set<WebSocket>();
  const providers = new Set<WebsocketProvider>();

  afterEach(() => {
    for (const ws of sockets) ws.terminate();
    sockets.clear();
    for (const p of providers) p.destroy();
    providers.clear();
  });

  function rawSocket(room: string, cookie?: string, headers: Record<string, string> = wsHeaders(cookie)) {
    const ws = new WebSocket(`ws://127.0.0.1:${ACCOUNTS_PORT}/sync/${room}`, { headers });
    sockets.add(ws);
    ws.on('error', () => {});
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    const joined = new Promise<void>((resolve) => ws.once('message', () => resolve()));
    const rejected = new Promise<number>((resolve) => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)));
    return { ws, closed, joined, rejected };
  }

  const wsFor = (cookie: string) =>
    class extends WebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols, { headers: wsHeaders(cookie) });
      }
    };

  /** `prepare` edits the document before the provider connects, so the edit travels in the client's sync step 2. */
  function connect(room: string, cookie: string, prepare?: (doc: Y.Doc) => void) {
    const doc = new Y.Doc();
    prepare?.(doc);
    const provider = new WebsocketProvider(`ws://127.0.0.1:${ACCOUNTS_PORT}/sync`, room, doc, {
      WebSocketPolyfill: wsFor(cookie) as unknown as typeof globalThis.WebSocket,
      disableBc: true,
    });
    providers.add(provider);
    return { doc, provider };
  }
  type Conn = ReturnType<typeof connect>;

  const synced = (c: Conn) => until(() => c.provider.wsconnected && c.provider.synced);
  const peers = (c: Conn, name: string) => [...c.provider.awareness.getStates().values()].some((s) => s.user?.name === name);

  /** Awareness sent after a document edit travels behind it on the same socket: once it has arrived, the edit has too, if it was let through. */
  async function flush(from: Conn, to: Conn) {
    const name = unique('marker');
    from.provider.awareness.setLocalStateField('user', { name });
    await until(() => peers(to, name));
  }

  /** `from` writes `key` into `map`; resolves to whether `to` received it. */
  async function lands(from: Conn, to: Conn, map: string, key: string) {
    from.doc.getMap(map).set(key, map === 'threads' ? threadValue(key) : 1);
    await flush(from, to);
    return to.doc.getMap(map).has(key);
  }

  type Pair = { board: Conn; comments: Conn };
  const pair = (board: string, cookie: string, prepare?: { board?: (d: Y.Doc) => void; comments?: (d: Y.Doc) => void }): Pair => ({
    board: connect(board, cookie, prepare?.board),
    comments: connect(`${board}${COMMENTS}`, cookie, prepare?.comments),
  });
  const pairSynced = (p: Pair) => Promise.all([synced(p.board), synced(p.comments)]);

  const roomFile = (room: string) => path.join(dataDir, `${room}.yjs`);
  const fileHas = (room: string, map: string, key: string) => {
    if (!fs.existsSync(roomFile(room))) return false;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, fs.readFileSync(roomFile(room)));
    return doc.getMap(map).has(key);
  };

  /** A personal board owned by `creator`; `person(role)` makes a new user and shares the board with them in that role. */
  async function setup() {
    const team = await newTeam(owner.cookie);
    const creator = await joinTeam(owner.cookie, team.id);
    const board = await newBoard(creator.cookie);
    const person = async (role: 'editor' | 'commenter' | 'viewer') => {
      const who = await joinTeam(owner.cookie, team.id);
      const res = await share(creator.cookie, board, who.user.id, role);
      if (res.status !== 201) throw new Error(`could not share (${res.status})`);
      return who;
    };
    return { team, creator, board, person };
  }

  beforeAll(async () => {
    const started = await startRelayProcess({
      envFor: (port) => ({
        ...(process.env as Record<string, string>),
        PORT: String(port),
        DATA_DIR: dataDir,
        HOST: '127.0.0.1',
        TABULA_AUTH: 'on',
        TABULA_OWNER_EMAIL: OWNER,
        TABULA_MAIL: 'file',
        TABULA_BASE_URL: `http://127.0.0.1:${port}`,
        TABULA_TRUST_PROXY: '1',
      }),
    });
    ACCOUNTS_PORT = started.port;
    baseUrl = `http://127.0.0.1:${ACCOUNTS_PORT}`;
    relay = started.proc;
    owner = await signIn(OWNER);
  });

  afterAll(async () => {
    if (relay && relay.exitCode === null && relay.signalCode === null) await stopRelay(relay);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------ who may write what

  it('lets owners and editors write both rooms', async () => {
    const { creator, board, person } = await setup();
    const editor = await person('editor');
    const other = await person('editor');
    const cc = pair(board, creator.cookie);
    const ce = pair(board, editor.cookie);
    const co = pair(board, other.cookie);
    await Promise.all([cc, ce, co].map(pairSynced));

    expect(await lands(ce.board, co.board, 'objects', 'fromEditor')).toBe(true);
    expect(await lands(ce.comments, co.comments, 'threads', 'editorThread')).toBe(true);
    expect(await lands(cc.board, ce.board, 'objects', 'fromOwner')).toBe(true);
    expect(await lands(cc.comments, ce.comments, 'threads', 'ownerThread')).toBe(true);

    // nothing crosses between the two documents
    expect(co.board.doc.getMap('threads').size).toBe(0);
    expect(co.comments.doc.getMap('objects').size).toBe(0);

    await until(() => fileHas(board, 'objects', 'fromEditor') && fileHas(`${board}${COMMENTS}`, 'threads', 'editorThread'));
    expect(fileHas(board, 'threads', 'editorThread')).toBe(false);
    expect(fileHas(`${board}${COMMENTS}`, 'objects', 'fromEditor')).toBe(false);
  });

  it('lets a commenter read the board and write only the comments room', async () => {
    const { creator, board, person } = await setup();
    const commenter = await person('commenter');
    const editor = await person('editor');
    const ce = pair(board, editor.cookie);
    // edits made before connecting travel in the client's sync step 2, which is dropped for the board room too
    const cc = pair(board, commenter.cookie, {
      board: (d) => d.getMap('objects').set('offlineBoardEdit', 1),
      comments: (d) => d.getMap('threads').set('offlineThread', threadValue('offlineThread')),
    });
    await Promise.all([pairSynced(ce), pairSynced(cc)]);

    // reading works in both rooms (this also proves the commenter's socket is processing messages)
    expect(await lands(ce.board, cc.board, 'objects', 'fromEditor')).toBe(true);
    expect(await lands(ce.comments, cc.comments, 'threads', 'editorThread')).toBe(true);

    // the commenter's board writes never reach the editor ...
    expect(await lands(cc.board, ce.board, 'objects', 'sneakyFromProvider')).toBe(false);
    expect(ce.board.doc.getMap('objects').has('offlineBoardEdit')).toBe(false);
    // ... not even a whole object or the board name
    cc.board.doc.getMap('meta').set('name', 'Renamed by a commenter');
    cc.board.doc.getMap('objects').set('shape', new Y.Map([['x', 1]]));
    cc.board.doc.getMap('objects').delete('fromEditor');
    await flush(cc.board, ce.board);
    expect(ce.board.doc.getMap('meta').has('name')).toBe(false);
    expect(ce.board.doc.getMap('objects').has('shape')).toBe(false);
    expect(ce.board.doc.getMap('objects').get('fromEditor')).toBe(1);

    // ... but the comments writes do, including the one made before connecting
    expect(await lands(cc.comments, ce.comments, 'threads', 'commenterThread')).toBe(true);
    expect(ce.comments.doc.getMap('threads').has('offlineThread')).toBe(true);

    // a raw update frame to the board room is dropped as well, on a socket that stays open (the awareness frame behind it is the barrier)
    const raw = rawSocket(board, commenter.cookie);
    await within(raw.joined);
    const rawName = unique('raw');
    raw.ws.send(updateFrame());
    raw.ws.send(awarenessFrame(rawName));
    await until(() => peers(ce.board, rawName));
    expect(raw.ws.readyState).toBe(WebSocket.OPEN);
    expect(ce.board.doc.getMap('objects').has('sneaky')).toBe(false);

    // a fresh joiner gets the editor's board and everyone's comments, and none of the dropped board edits
    const fresh = pair(board, creator.cookie);
    await pairSynced(fresh);
    expect(fresh.board.doc.getMap('objects').get('fromEditor')).toBe(1);
    expect(fresh.board.doc.getMap('objects').has('sneaky')).toBe(false);
    expect(fresh.board.doc.getMap('objects').has('sneakyFromProvider')).toBe(false);
    expect(fresh.board.doc.getMap('objects').has('offlineBoardEdit')).toBe(false);
    expect(fresh.board.doc.getMap('objects').has('shape')).toBe(false);
    expect(fresh.board.doc.getMap('meta').has('name')).toBe(false);
    expect(fresh.comments.doc.getMap('threads').has('commenterThread')).toBe(true);
    expect(fresh.comments.doc.getMap('threads').has('offlineThread')).toBe(true);

    await until(() => fileHas(`${board}${COMMENTS}`, 'threads', 'commenterThread') && fileHas(board, 'objects', 'fromEditor'));
    expect(fileHas(board, 'objects', 'sneaky')).toBe(false);
    expect(fileHas(board, 'objects', 'sneakyFromProvider')).toBe(false);
    expect(fileHas(board, 'objects', 'shape')).toBe(false);
  });

  it('lets a viewer read both rooms and write neither, while their awareness still flows', async () => {
    const { board, person } = await setup();
    const viewer = await person('viewer');
    const editor = await person('editor');
    const ce = pair(board, editor.cookie);
    const cv = pair(board, viewer.cookie, {
      board: (d) => d.getMap('objects').set('offlineBoardEdit', 1),
      comments: (d) => d.getMap('threads').set('offlineThread', threadValue('offlineThread')),
    });
    await Promise.all([pairSynced(ce), pairSynced(cv)]);

    expect(await lands(ce.board, cv.board, 'objects', 'fromEditor')).toBe(true);
    expect(await lands(ce.comments, cv.comments, 'threads', 'editorThread')).toBe(true);

    // awareness from a viewer reaches the editor in both rooms (lands() would throw if it did not)
    expect(await lands(cv.board, ce.board, 'objects', 'sneakyFromProvider')).toBe(false);
    expect(await lands(cv.comments, ce.comments, 'threads', 'sneakyThread')).toBe(false);
    expect(ce.board.doc.getMap('objects').has('offlineBoardEdit')).toBe(false);
    expect(ce.comments.doc.getMap('threads').has('offlineThread')).toBe(false);

    // the editor can still write, and the viewer still receives it
    expect(await lands(ce.board, cv.board, 'objects', 'after')).toBe(true);
    expect(await lands(ce.comments, cv.comments, 'threads', 'afterThread')).toBe(true);
    expect(cv.board.provider.wsconnected && cv.comments.provider.wsconnected).toBe(true);

    await sleep(SAVE_WINDOW_MS);
    expect(fileHas(board, 'objects', 'sneakyFromProvider')).toBe(false);
    expect(fileHas(`${board}${COMMENTS}`, 'threads', 'sneakyThread')).toBe(false);
    expect(fileHas(`${board}${COMMENTS}`, 'threads', 'offlineThread')).toBe(false);
  });

  // A write that is dropped leaves a gap in that client's edits, so later edits of the same document are held back by the
  // relay's Yjs until the client reconnects and re-syncs. These two tests therefore only write where the new role allows it.

  it('turns an editor into a commenter and then a viewer in both rooms without reconnecting', async () => {
    const { creator, board, person } = await setup();
    const guest = await person('editor');
    const co = pair(board, creator.cookie);
    const cg = pair(board, guest.cookie);
    await Promise.all([pairSynced(co), pairSynced(cg)]);
    const socketsBefore = [cg.board.provider.ws, cg.comments.provider.ws];
    const regrant = async (role: string) => expect((await share(creator.cookie, board, guest.user.id, role)).status).toBe(201);
    const landed = async (tag: string) => [
      await lands(cg.board, co.board, 'objects', tag),
      await lands(cg.comments, co.comments, 'threads', tag),
    ];

    expect(await landed('asEditor')).toEqual([true, true]);
    await regrant('commenter');
    expect(await landed('asCommenter')).toEqual([false, true]);
    await regrant('viewer');
    expect(await landed('asViewer')).toEqual([false, false]);

    // the very same sockets all along, still receiving, and nothing that was dropped shows up later
    expect(cg.board.provider.ws).toBe(socketsBefore[0]);
    expect(cg.comments.provider.ws).toBe(socketsBefore[1]);
    expect(cg.board.provider.wsconnected && cg.comments.provider.wsconnected).toBe(true);
    expect(await lands(co.comments, cg.comments, 'threads', 'fromOwner')).toBe(true);
    const fresh = pair(board, creator.cookie);
    await pairSynced(fresh);
    expect([...fresh.board.doc.getMap('objects').keys()]).toEqual(['asEditor']);
    expect([...fresh.comments.doc.getMap('threads').keys()].sort()).toEqual(['asCommenter', 'asEditor', 'fromOwner']);
  });

  it('turns a viewer into a commenter and then an editor in both rooms without reconnecting', async () => {
    const { creator, board, person } = await setup();
    const guest = await person('viewer');
    const co = pair(board, creator.cookie);
    const cg = pair(board, guest.cookie);
    await Promise.all([pairSynced(co), pairSynced(cg)]);
    const socketsBefore = [cg.board.provider.ws, cg.comments.provider.ws];
    const regrant = async (role: string) => expect((await share(creator.cookie, board, guest.user.id, role)).status).toBe(201);

    await regrant('commenter');
    expect(await lands(cg.comments, co.comments, 'threads', 'asCommenter')).toBe(true);
    await regrant('editor');
    expect(await lands(cg.board, co.board, 'objects', 'asEditor')).toBe(true);
    expect(await lands(cg.comments, co.comments, 'threads', 'asEditor')).toBe(true);

    expect(cg.board.provider.ws).toBe(socketsBefore[0]);
    expect(cg.comments.provider.ws).toBe(socketsBefore[1]);
  });

  it('does not let a commenter rename the board by writing a name into the comments document', async () => {
    const { board, person, creator } = await setup();
    const commenter = await person('commenter');
    const before = await boardView(creator.cookie, board);
    const cc = pair(board, commenter.cookie);
    const watcher = pair(board, creator.cookie);
    await Promise.all([pairSynced(cc), pairSynced(watcher)]);

    cc.comments.doc.getMap('meta').set('name', 'Hijacked title');
    expect(await lands(cc.comments, watcher.comments, 'threads', 'aThread')).toBe(true);
    await until(() => fileHas(`${board}${COMMENTS}`, 'threads', 'aThread'));

    const after = await boardView(creator.cookie, board);
    expect(after.title).toBe(before.title);
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  // ------------------------------------------------------------ who may join

  it('closes unauthorised connections to a comments room with 4401, 4403 and 4404 and creates no room file', async () => {
    const { creator, board, person } = await setup();
    const commenter = await person('commenter');
    const otherTeam = await newTeam(owner.cookie);
    const outsider = await joinTeam(owner.cookie, otherTeam.id);
    const deleted = await newBoard(creator.cookie);
    expect((await api(creator.cookie, 'DELETE', `/api/boards/${deleted}`)).status).toBe(204);
    const ghost = unique('ghost');
    const rooms = [board, deleted, ghost].map((b) => `${b}${COMMENTS}`);
    const before = (await api(undefined, 'GET', '/api/health')).body;

    const attempts = [
      rawSocket(rooms[0]),
      rawSocket(rooms[0], 'tabula_session=not-a-session'),
      rawSocket(rooms[0], outsider.cookie),
      rawSocket(rooms[1], commenter.cookie),
      rawSocket(rooms[2], outsider.cookie),
      rawSocket(rooms[2], owner.cookie),
      rawSocket(rooms[2]),
    ];
    for (const a of attempts) a.ws.on('open', () => a.ws.send(updateFrame()));
    expect(await within(Promise.all(attempts.map((a) => a.closed)))).toEqual([4401, 4401, 4403, 4404, 4404, 4404, 4401]);

    // the Origin is checked before anything else, for the comments room too
    const wrongOrigins: Record<string, string>[] = [
      { Origin: 'http://evil.example', Cookie: creator.cookie },
      { Origin: 'http://127.0.0.1:1', Cookie: creator.cookie },
      { Cookie: creator.cookie },
    ];
    for (const headers of wrongOrigins) {
      expect(await within(rawSocket(rooms[0], creator.cookie, headers).rejected)).toBe(403);
    }

    await sleep(SAVE_WINDOW_MS);
    for (const room of rooms) expect(fs.existsSync(roomFile(room))).toBe(false);
    for (const b of [board, deleted, ghost]) expect(fs.existsSync(roomFile(b))).toBe(false);
    expect((await api(undefined, 'GET', '/api/health')).body.rooms).toBeLessThanOrEqual(before.rooms);
  });

  it('lets only a workspace admin into the comments room of a deleted board', async () => {
    const { creator, board } = await setup();
    expect((await api(creator.cookie, 'DELETE', `/api/boards/${board}`)).status).toBe(204);
    expect(await within(rawSocket(`${board}${COMMENTS}`, creator.cookie).closed)).toBe(4404);
    const admin = rawSocket(`${board}${COMMENTS}`, owner.cookie);
    await within(admin.joined);
    expect(admin.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('keeps access to one board from opening the comments of another', async () => {
    const mine = await setup();
    const theirs = await setup();
    const commenter = await mine.person('commenter');
    expect(await within(rawSocket(`${theirs.board}${COMMENTS}`, commenter.cookie).closed)).toBe(4403);
    const ok = rawSocket(`${mine.board}${COMMENTS}`, commenter.cookie);
    await within(ok.joined);
    expect(ok.ws.readyState).toBe(WebSocket.OPEN);
  });

  // ------------------------------------------------------------ access changes and sessions

  it('closes the sockets of both rooms with 4410 when access goes away, and only those of that board', async () => {
    const { team, creator, board, person } = await setup();
    const second = await newBoard(creator.cookie);
    const member = await person('commenter');
    expect((await share(creator.cookie, second, member.user.id, 'viewer')).status).toBe(201);

    const open = () => ({
      board: rawSocket(board, member.cookie),
      comments: rawSocket(`${board}${COMMENTS}`, member.cookie),
      secondBoard: rawSocket(second, member.cookie),
      secondComments: rawSocket(`${second}${COMMENTS}`, member.cookie),
    });
    const s = open();
    await within(Promise.all(Object.values(s).map((x) => x.joined)));

    expect((await api(creator.cookie, 'DELETE', `/api/boards/${board}/shares/user/${member.user.id}`)).status).toBe(204);
    expect(await within(Promise.all([s.board.closed, s.comments.closed]))).toEqual([4410, 4410]);
    await Promise.all([ping(s.secondBoard.ws), ping(s.secondComments.ws)]);
    expect(s.secondBoard.ws.readyState).toBe(WebSocket.OPEN);
    expect(s.secondComments.ws.readyState).toBe(WebSocket.OPEN);

    // a deleted board, a removed team membership and a disabled user close both rooms alike
    const teamBoard = await newBoard(creator.cookie, { teamId: team.id });
    const viaTeam = [rawSocket(teamBoard, member.cookie), rawSocket(`${teamBoard}${COMMENTS}`, member.cookie)];
    await within(Promise.all(viaTeam.map((x) => x.joined)));
    expect((await api(owner.cookie, 'DELETE', `/api/teams/${team.id}/members/${member.user.id}`)).status).toBe(204);
    expect(await within(Promise.all(viaTeam.map((x) => x.closed)))).toEqual([4410, 4410]);

    expect((await api(creator.cookie, 'DELETE', `/api/boards/${second}`)).status).toBe(204);
    expect(await within(Promise.all([s.secondBoard.closed, s.secondComments.closed]))).toEqual([4410, 4410]);

    const again = [rawSocket(board, creator.cookie), rawSocket(`${board}${COMMENTS}`, creator.cookie)];
    await within(Promise.all(again.map((x) => x.joined)));
    expect((await api(owner.cookie, 'PATCH', `/api/members/${creator.user.id}`, { disabled: true })).status).toBe(200);
    expect(await within(Promise.all(again.map((x) => x.closed)))).toEqual([4410, 4410]);
  });

  it('closes the sockets of both rooms with 4401 when the session is revoked', async () => {
    const { board, person } = await setup();
    const member = await person('commenter');
    const other = await signIn(member.email);
    const first = [rawSocket(board, member.cookie), rawSocket(`${board}${COMMENTS}`, member.cookie)];
    const second = [rawSocket(board, other.cookie), rawSocket(`${board}${COMMENTS}`, other.cookie)];
    await within(Promise.all([...first, ...second].map((x) => x.joined)));

    expect((await api(member.cookie, 'POST', '/api/auth/logout')).status).toBe(204);
    expect(await within(Promise.all(first.map((x) => x.closed)))).toEqual([4401, 4401]);
    expect(second.every((x) => x.ws.readyState === WebSocket.OPEN)).toBe(true);
  });

  // ------------------------------------------------------------ adoption

  it('treats a leftover comments file like a leftover board file when registering a board', async () => {
    const id = unique('adopt');
    fs.writeFileSync(roomFile(`${id}${COMMENTS}`), Y.encodeStateAsUpdate(new Y.Doc()));
    const team = await newTeam(owner.cookie);
    const member = await joinTeam(owner.cookie, team.id);

    const refused = await api(member.cookie, 'POST', '/api/boards', { id });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('needs_admin');
    const adopted = await api(owner.cookie, 'POST', '/api/boards', { id });
    expect(adopted.status).toBe(201);

    const fresh = await api(member.cookie, 'POST', '/api/boards', { id: unique('fresh') });
    expect(fresh.status).toBe(201);
  });

  it('refuses to register an id that is a comments room name', async () => {
    const res = await api(owner.cookie, 'POST', '/api/boards', { id: `${unique('x')}${COMMENTS}` });
    expect(res.status).toBe(400);
  });
});
