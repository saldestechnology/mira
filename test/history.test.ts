import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import * as Y from 'yjs';
import { ApiError, createApi, type Version } from '../src/api';
import {
  applyRestore, canDelete, canRename, canSeeHistory, createStateCache, dayLabel, filterVersions, groupByDay, historyOffline,
  isHiddenNow, objectDeltas, openSnapshot, planRestore, restoreBlock, summaryText, versionTitle,
} from '../src/history';
import { LOCAL, Store } from '../src/store';
import type { BaseObj, Obj } from '../src/types';
import { SCHEMA_VERSION } from '../src/types';
import { restoreSuccessToast } from '../src/ui/history';
import { CSRF_HEADER, csrfOk } from '../server/auth.mjs';
import { HistoryError, LIMITS, createHistory, pruneIds } from '../server/history.mjs';

// docs/history.md. First the pure client logic, then the server module with an injected clock.

describe('history restore toast', () => {
  it.each([
    ['MacIntel', 'Version restored. Press ⌘Z to undo.'],
    ['Win32', 'Version restored. Press Ctrl+Z to undo.'],
  ])('formats the undo hint for %s', (platform, expected) => {
    expect(restoreSuccessToast(platform)).toBe(expected);
  });
});


const box = (id: string, extra: Partial<BaseObj> = {}): BaseObj => ({
  id, type: 'shape', kind: 'rect', x: 0, y: 0, w: 100, h: 60, rotation: 0, z: 'a0', updatedAt: 1, ...extra,
});

const none = () => false;

function boardOf(objs: Obj[], meta: Record<string, unknown> = {}): Store {
  const store = new Store(new Y.Doc());
  store.doc.transact(() => {
    for (const o of objs) store.create(o);
    for (const [k, v] of Object.entries(meta)) store.meta.set(k, v);
  });
  return store;
}

const stateOf = (store: Store) => Y.encodeStateAsUpdate(store.doc);
const objectsOf = (store: Store) => JSON.parse(JSON.stringify(Object.fromEntries(store.cache)));
const metaOf = (store: Store) => store.meta.toJSON();

function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
}

describe('restore', () => {
  /** A live board that has moved on since `snapshot` was taken. */
  function scenario() {
    const live = boardOf([
      box('a', { text: 'hello', points: [1, 2, 3] as unknown as number[], fill: '#fff' }),
      box('b', { x: 10 }),
      { id: 'c', type: 'connector', z: 'a1', route: 'elbow', startHead: 'none', endHead: 'arrow', from: { kind: 'bound', id: 'a', anchor: 'auto' }, to: { kind: 'free', x: 5, y: 6 }, updatedAt: 1 },
    ], { name: 'Roadmap', schemaVersion: SCHEMA_VERSION, gridType: 'dots', gridSize: 24, snap: true });
    live.undo.clear();
    const snapshotBytes = stateOf(live);
    live.undo.stopCapturing();

    live.transact(() => {
      live.objects.get('a')!.set('text', 'changed');
      live.objects.get('a')!.delete('points');
      live.objects.get('a')!.set('fill', '#000');
      live.objects.delete('b');
      live.create(box('d', { x: 99 }));
      live.objects.get('c')!.set('to', { kind: 'bound', id: 'd', anchor: 'left' });
      live.meta.set('name', 'Roadmap v2');
      live.meta.set('gridType', 'lines');
      live.meta.set('gridSize', 48);
    });
    live.undo.stopCapturing();
    return { live, snapshotBytes, snap: openSnapshot(snapshotBytes) };
  }

  it('makes the live objects equal the snapshot: create, delete, change, remove a field, nested values, connector ends', () => {
    const { live, snap } = scenario();
    const plan = planRestore(live, snap.store, { isHidden: none });
    expect(plan.summary).toEqual({ added: 1, removed: 1, changed: 2, meta: true });
    expect(plan.empty).toBe(false);

    applyRestore(live, plan);
    expect(objectsOf(live)).toEqual(objectsOf(snap.store));
    expect(live.objects.get('a')!.has('points')).toBe(true);
    expect(live.objects.has('b')).toBe(true);
    expect(live.objects.has('d')).toBe(false);
    expect(live.cache.get('c')).toEqual(snap.store.cache.get('c'));
  });

  it('restores the board settings but keeps the title and the schema version', () => {
    const { live, snap } = scenario();
    applyRestore(live, planRestore(live, snap.store, { isHidden: none }));
    expect(live.meta.get('name')).toBe('Roadmap v2');
    expect(live.meta.get('gridType')).toBe('dots');
    expect(live.meta.get('gridSize')).toBe(24);
    expect(live.meta.get('schemaVersion')).toBe(SCHEMA_VERSION);
  });

  it('treats an updatedAt-only difference as no change, and copies updatedAt for an object that did change', () => {
    const live = boardOf([box('a', { updatedAt: 5 }), box('b', { updatedAt: 5, text: 'old' })]);
    const snap = openSnapshot(stateOf(boardOf([box('a', { updatedAt: 99 }), box('b', { updatedAt: 77, text: 'new' })])));
    const plan = planRestore(live, snap.store, { isHidden: none });
    expect(plan.change.map((c) => c.id)).toEqual(['b']);
    applyRestore(live, plan);
    expect(live.cache.get('a')!.updatedAt).toBe(5);
    expect(live.cache.get('b')!.updatedAt).toBe(77);
    expect((live.cache.get('b') as BaseObj).text).toBe('new');
  });

  it('is empty when the snapshot already matches, runs no transaction and leaves the undo stack alone', () => {
    const live = boardOf([box('a'), box('b')]);
    live.undo.clear();
    const snap = openSnapshot(stateOf(live));
    let updates = 0;
    live.doc.on('update', () => updates++);
    const plan = planRestore(live, snap.store, { isHidden: none });
    expect(plan.empty).toBe(true);
    applyRestore(live, plan);
    expect(updates).toBe(0);
    expect(live.undo.undoStack.length).toBe(0);
  });

  it('is one undo step in the tab that did it, even after a remote peer edited in between', () => {
    const { live, snap } = scenario();
    const peer = new Y.Doc();
    Y.applyUpdate(peer, stateOf(live));
    peer.transact(() => (peer.getMap('objects').get('a') as Y.Map<unknown>).set('stroke', '#f00'), 'remote');
    Y.applyUpdate(live.doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(live.doc)));
    const before = objectsOf(live);
    const metaBefore = metaOf(live);

    const depth = live.undo.undoStack.length;
    applyRestore(live, planRestore(live, snap.store, { isHidden: none }));
    expect(live.undo.undoStack.length).toBe(depth + 1);
    expect(objectsOf(live)).not.toEqual(before);

    live.undo.undo();
    expect(objectsOf(live)).toEqual(before);
    expect(metaOf(live)).toEqual(metaBefore);
  });

  it('syncs as an ordinary update: a second peer converges, concurrent edits included', () => {
    const { live, snap } = scenario();
    const peer = new Y.Doc();
    sync(peer, live.doc);
    peer.transact(() => (peer.getMap('objects').get('a') as Y.Map<unknown>).set('stroke', '#0f0'), 'remote');

    applyRestore(live, planRestore(live, snap.store, { isHidden: none }));
    sync(peer, live.doc);
    expect(JSON.stringify(peer.getMap('objects').toJSON())).toBe(JSON.stringify(live.doc.getMap('objects').toJSON()));
    expect(peer.getMap('objects').has('b')).toBe(true);
    expect(peer.getMap('objects').has('d')).toBe(false);
  });

  it('leaves the session (flow, votes) and the title alone', () => {
    const live = boardOf([box('a')], { name: 'Now' });
    const snapDoc = boardOf([box('a'), box('z')], { name: 'Then' });
    snapDoc.setFlow({ active: 4, reveal: true });
    snapDoc.doc.transact(() => snapDoc.votes.set('v1', { itemId: 'a', userId: 'u', stepId: 's' }));
    live.setFlow({ active: 1, reveal: false });
    const snap = openSnapshot(stateOf(snapDoc));

    applyRestore(live, planRestore(live, snap.store, { isHidden: none }));
    expect(live.getFlow().active).toBe(1);
    expect(live.getFlow().reveal).toBe(false);
    expect(live.votes.size).toBe(0);
    expect(live.meta.get('name')).toBe('Now');
    expect(live.cache.has('z')).toBe(true);
  });

  it('neither deletes nor resurrects notes that private writing hides', () => {
    const hidden = (id: string): BaseObj => box(id, { type: 'sticky', createdBy: 'someone-else', privateStep: 'step1' });
    const live = boardOf([box('keep'), hidden('mine-hidden-1')]);
    const snap = openSnapshot(stateOf(boardOf([box('keep'), hidden('hidden-2')])));
    const isHidden = (o: Obj) => isHiddenNow(o, 'me', false);

    const plan = planRestore(live, snap.store, { isHidden });
    expect(plan.empty).toBe(true);
    applyRestore(live, plan);
    expect(live.cache.has('mine-hidden-1')).toBe(true);
    expect(live.cache.has('hidden-2')).toBe(false);

    // revealed, they are ordinary notes again
    const revealed = planRestore(live, snap.store, { isHidden: (o) => isHiddenNow(o, 'me', true) });
    expect(revealed.summary).toMatchObject({ added: 1, removed: 1 });
  });

  it('runs nothing in a read-only store', () => {
    const { live, snap } = scenario();
    const plan = planRestore(live, snap.store, { isHidden: none });
    const before = objectsOf(live);
    live.setReadOnly(true);
    applyRestore(live, plan);
    expect(objectsOf(live)).toEqual(before);
  });

  it('is refused for a read-only workspace or store, a running session and a newer schema', () => {
    const ok = { readOnly: false, workspaceReadOnly: false, sessionActive: false, snapshotSchema: SCHEMA_VERSION };
    expect(restoreBlock(ok)).toBeNull();
    expect(restoreBlock({ ...ok, readOnly: true })?.reason).toBe('read-only');
    expect(restoreBlock({ ...ok, readOnly: true, workspaceReadOnly: true })?.reason).toBe('workspace-read-only');
    expect(restoreBlock({ ...ok, sessionActive: true })?.reason).toBe('session');
    expect(restoreBlock({ ...ok, snapshotSchema: SCHEMA_VERSION + 1 })?.reason).toBe('newer-schema');
    expect(restoreBlock({ ...ok, snapshotSchema: SCHEMA_VERSION - 1 })).toBeNull();
    for (const reason of ['read-only', 'session', 'newer-schema'] as const) {
      expect(restoreBlock({ ...ok, readOnly: reason === 'read-only', sessionActive: reason === 'session', snapshotSchema: reason === 'newer-schema' ? 99 : 1 })?.message).toMatch(/\S/);
    }
  });

  it('reads the schema version of a snapshot', () => {
    const doc = new Y.Doc();
    doc.getMap('meta').set('schemaVersion', SCHEMA_VERSION + 3);
    expect(openSnapshot(Y.encodeStateAsUpdate(doc)).schemaVersion).toBe(SCHEMA_VERSION + 3);
    expect(openSnapshot(Y.encodeStateAsUpdate(new Y.Doc())).schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('opens a snapshot without touching the live document, as a read-only store', () => {
    const live = boardOf([box('a')]);
    let updates = 0;
    live.doc.on('update', () => updates++);
    const snap = openSnapshot(stateOf(boardOf([box('x'), box('y')])));
    expect(snap.store.cache.size).toBe(2);
    expect(snap.store.readOnly).toBe(true);
    let ran = false;
    snap.store.transact(() => {
      ran = true;
    });
    expect(ran).toBe(false);
    expect(updates).toBe(0);
    expect(live.cache.size).toBe(1);
    expect(snap.doc).not.toBe(live.doc);
  });

  it('describes what a restore does', () => {
    expect(summaryText({ added: 4, changed: 7, removed: 12, meta: false })).toBe('Restoring adds 4, changes 7, removes 12 items');
    expect(summaryText({ added: 1, changed: 0, removed: 0, meta: false })).toBe('Restoring adds 1 item');
    expect(summaryText({ added: 0, changed: 2, removed: 0, meta: true })).toBe('Restoring changes 2 items and the board settings');
    expect(summaryText({ added: 0, changed: 0, removed: 0, meta: true })).toBe('Restoring changes the board settings');
    expect(summaryText({ added: 0, changed: 0, removed: 0, meta: false })).toBe('Restoring changes nothing');
  });

  it('uses the Store origin, so the restore is undoable by the same UndoManager as any edit', () => {
    const live = boardOf([box('a')]);
    live.undo.clear();
    const origins: unknown[] = [];
    live.doc.on('afterTransaction', (tr: Y.Transaction) => origins.push(tr.origin));
    const snap = openSnapshot(stateOf(boardOf([box('a', { text: 'then' })])));
    applyRestore(live, planRestore(live, snap.store, { isHidden: none }));
    expect(origins).toContain(LOCAL);
  });
});

describe('private writing rule', () => {
  const sticky = (extra: Partial<BaseObj> = {}): BaseObj => box('n', { type: 'sticky', ...extra });

  it('hides another person’s private sticky until the live board reveals it', () => {
    const note = sticky({ privateStep: 's1', createdBy: 'ana' });
    expect(isHiddenNow(note, 'bo', false)).toBe(true);
    expect(isHiddenNow(note, 'bo', true)).toBe(false);
  });

  it('never hides your own note, an ordinary note or something that is not a sticky', () => {
    expect(isHiddenNow(sticky({ privateStep: 's1', createdBy: 'bo' }), 'bo', false)).toBe(false);
    expect(isHiddenNow(sticky({ createdBy: 'ana' }), 'bo', false)).toBe(false);
    expect(isHiddenNow(box('r', { privateStep: 's1', createdBy: 'ana' }), 'bo', false)).toBe(false);
  });
});

describe('who may do what', () => {
  const v = (extra: Partial<Version> = {}): Version => ({
    id: 'v1', createdAt: 1, kind: 'auto', label: null, by: null, byName: null, objects: 3, bytes: 10, from: null, ...extra,
  });

  it('shows history to owners, editors and open mode only', () => {
    expect(canSeeHistory('owner')).toBe(true);
    expect(canSeeHistory('editor')).toBe(true);
    expect(canSeeHistory(null)).toBe(true);
    expect(canSeeHistory('commenter')).toBe(false);
    expect(canSeeHistory('viewer')).toBe(false);
  });

  it('lets any editor name an unnamed version, but only the creator or the owner rename a named one', () => {
    const named = v({ kind: 'named', label: 'Final', by: 'ana' });
    expect(canRename(v(), { role: 'editor', userId: 'bo' })).toBe(true);
    expect(canRename(named, { role: 'editor', userId: 'ana' })).toBe(true);
    expect(canRename(named, { role: 'editor', userId: 'bo' })).toBe(false);
    expect(canRename(named, { role: 'owner', userId: 'bo' })).toBe(true);
    expect(canRename(named, { role: null, userId: null })).toBe(true);
    expect(canRename(v(), { role: 'viewer', userId: 'bo' })).toBe(false);
  });

  it('lets the owner delete any version and an editor only a named version they created', () => {
    const named = v({ kind: 'named', label: 'Final', by: 'ana' });
    expect(canDelete(v(), { role: 'owner', userId: 'bo' })).toBe(true);
    expect(canDelete(v(), { role: 'editor', userId: 'ana' })).toBe(false);
    expect(canDelete(named, { role: 'editor', userId: 'ana' })).toBe(true);
    expect(canDelete(named, { role: 'editor', userId: 'bo' })).toBe(false);
    expect(canDelete(v(), { role: null, userId: null })).toBe(true);
    expect(canDelete(named, { role: 'commenter', userId: 'ana' })).toBe(false);
  });

  it('needs the relay that serves the app', () => {
    expect(historyOffline('auto', 'wss://example.com/sync')).toBe(false);
    expect(historyOffline('off', null)).toBe(true);
    expect(historyOffline('wss://other.example.com/sync', 'wss://other.example.com/sync')).toBe(true);
    expect(historyOffline('auto', null)).toBe(true);
  });
});

describe('the list', () => {
  const at = (id: string, createdAt: number, extra: Partial<Version> = {}): Version => ({
    id, createdAt, kind: 'auto', label: null, by: null, byName: null, objects: 10, bytes: 1, from: null, ...extra,
  });

  it('words each kind of version', () => {
    expect(versionTitle(at('a', 1))).toBe('Automatic version');
    expect(versionTitle(at('a', 1, { kind: 'pre-restore' }))).toBe('Before restore');
    expect(versionTitle(at('a', 1, { kind: 'restore' }))).toBe('Restored a version');
    expect(versionTitle(at('a', 1, { kind: 'named', label: 'Kick-off' }))).toBe('Kick-off');
  });

  it('filters to named versions', () => {
    const list = [at('a', 3), at('b', 2, { kind: 'named', label: 'x' }), at('c', 1)];
    expect(filterVersions(list, 'all')).toHaveLength(3);
    expect(filterVersions(list, 'named').map((x) => x.id)).toEqual(['b']);
  });

  it('shows how many objects each version has more or fewer than the one before it', () => {
    const list = [at('a', 3, { objects: 4 }), at('b', 2, { objects: 212 }), at('c', 1, { objects: 200 })];
    expect([...objectDeltas(list)]).toEqual([['a', -208], ['b', 12], ['c', null]]);
  });

  it('groups by day under Today and Yesterday headings', () => {
    const now = new Date(2026, 5, 15, 12, 0).getTime();
    const hour = 3_600_000;
    const list = [at('a', now - hour), at('b', now - 2 * hour), at('c', now - 26 * hour), at('d', now - 10 * 24 * hour)];
    const groups = groupByDay(list, now);
    expect(groups.map((g) => g.label).slice(0, 2)).toEqual(['Today', 'Yesterday']);
    expect(groups[0].items.map((x) => x.id)).toEqual(['a', 'b']);
    expect(groups).toHaveLength(3);
    expect(dayLabel(now, now)).toBe('Today');
    expect(dayLabel(now - 24 * hour, now)).toBe('Yesterday');
  });

  it('keeps the last few downloaded states, least recently used first out', () => {
    const cache = createStateCache(2);
    cache.set('a', new Uint8Array([1]));
    cache.set('b', new Uint8Array([2]));
    expect(cache.get('a')).toBeDefined();
    cache.set('c', new Uint8Array([3]));
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });
});

describe('the API client', () => {
  type Call = { url: string; init: RequestInit };
  function client(reply: (call: Call) => Response) {
    const calls: Call[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), init: init ?? {} };
      calls.push(call);
      return reply(call);
    }) as typeof fetch;
    return { api: createApi(fetchFn), calls };
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const headersOf = (c: Call) => c.init.headers as Record<string, string>;

  it('lists, saves, names, deletes and begins a restore on the board’s version routes', async () => {
    const version = { id: 'v1', createdAt: 1, kind: 'named', label: 'x', by: null, byName: null, objects: 1, bytes: 1, from: null };
    const { api, calls } = client((c) => (c.init.method === 'DELETE' ? new Response(null, { status: 204 }) : json(c.url.endsWith('versions') && c.init.method === 'GET' ? { versions: [version] } : c.url.endsWith('begin-restore') ? { preRestore: null } : version)));
    expect((await api.versions('b 1')).versions).toHaveLength(1);
    await api.saveVersion('b1', 'Kick-off', 'Ana');
    await api.nameVersion('b1', 'v1', 'Final');
    await api.deleteVersion('b1', 'v1');
    expect(await api.beginRestore('b1', 'v1')).toEqual({ preRestore: null });

    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'GET /api/boards/b%201/versions',
      'POST /api/boards/b1/versions',
      'PATCH /api/boards/b1/versions/v1',
      'DELETE /api/boards/b1/versions/v1',
      'POST /api/boards/b1/versions/v1/begin-restore',
    ]);
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ label: 'Kick-off', by: 'Ana' });
    // only the state-changing calls carry the CSRF header
    expect(Object.values(headersOf(calls[0]))).not.toContain('1');
    for (const c of calls.slice(1)) expect(Object.values(headersOf(c))).toContain('1');
  });

  it('downloads a version’s state as bytes, with the shared error mapping', async () => {
    const { api, calls } = client((c) => (c.url.includes('/missing/') ? json({ error: 'not_found', message: 'Version not found' }, 404) : new Response(new Uint8Array([1, 2, 3]))));
    expect([...(await api.versionState('b1', 'v1'))]).toEqual([1, 2, 3]);
    expect(calls[0].url).toBe('/api/boards/b1/versions/v1/state');
    expect(Object.values(headersOf(calls[0]))).not.toContain('1');
    await expect(api.versionState('b1', 'missing')).rejects.toMatchObject({ status: 404, code: 'not_found', message: 'Version not found' });
  });

  it('reports a network failure as ApiError network', async () => {
    const api = createApi((() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch);
    await expect(api.versionState('b1', 'v1')).rejects.toBeInstanceOf(ApiError);
    await expect(api.versionState('b1', 'v1')).rejects.toMatchObject({ code: 'network' });
  });
});

describe('the CSRF rule is shared', () => {
  const req = (method: string, headers: Record<string, string> = {}) => ({ method, headers });

  it('exports the rule createAuth uses, with the header name as a constant', () => {
    expect(csrfOk(req('GET'))).toBe(true);
    expect(csrfOk(req('POST'))).toBe(false);
    expect(csrfOk(req('POST', { [CSRF_HEADER]: '1' }))).toBe(true);
    expect(csrfOk(req('POST', { [CSRF_HEADER]: '1', origin: 'http://evil.example', host: 'app.example' }))).toBe(false);
    expect(csrfOk(req('DELETE', { [CSRF_HEADER]: '1', origin: 'http://app.example', host: 'app.example' }))).toBe(true);
  });
});

// ---------------------------------------------------------------- the server module

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MIN = 60_000;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// A fake room, like the relay's Room as far as history looks at it.
type FakeRoom = { name: string; kind: 'board' | 'comments'; doc: Y.Doc; conns: Map<unknown, unknown>; historyPrevious?: unknown };

function serverSetup(limits: Record<string, number> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-'));
  dirs.push(dir);
  const clock = { now: Date.now() };
  const states = new Map<string, Uint8Array>();
  const history = createHistory({ dataDir: dir, boardState: (id: string) => states.get(id) ?? null, now: () => clock.now, log: () => {}, sweepMs: 0, limits });
  const rooms = new Map<string, FakeRoom>();

  const room = (name = 'board1', kind: 'board' | 'comments' = 'board'): FakeRoom => {
    let r = rooms.get(name);
    if (!r) {
      r = { name, kind, doc: new Y.Doc(), conns: new Map([[1, new Set()]]) };
      rooms.set(name, r);
    }
    return r;
  };
  const objects = (r: FakeRoom) => r.doc.getMap('objects') as Y.Map<Y.Map<unknown>>;
  const add = (r: FakeRoom, from: number, count: number) =>
    r.doc.transact(() => {
      for (let i = from; i < from + count; i++) objects(r).set(`o${i}`, new Y.Map(Object.entries({ id: `o${i}`, type: 'shape', text: `note ${i}` })));
    });
  const remove = (r: FakeRoom, from: number, count: number) =>
    r.doc.transact(() => {
      for (let i = from; i < from + count; i++) objects(r).delete(`o${i}`);
    });
  /** What Room.save() does: encode, store the file's bytes, tell history. */
  const save = (r: FakeRoom) => {
    const bytes = Y.encodeStateAsUpdate(r.doc);
    states.set(r.name, bytes);
    history.onSave(r, bytes);
  };
  const list = (board = 'board1'): Version[] => history.actions.list(board).versions;
  const files = (board = 'board1') => {
    const d = path.join(dir, 'history', board);
    return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.yjs.gz')).sort() : [];
  };
  const index = (board = 'board1') => JSON.parse(fs.readFileSync(path.join(dir, 'history', board, 'index.json'), 'utf8'));
  const advance = (ms: number) => {
    clock.now += ms;
  };
  const objectCountOf = (board: string, versionId: string) => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, zlib.gunzipSync(history.actions.state(board, versionId)));
    return doc.getMap('objects').size;
  };
  return { dir, clock, states, history, room, add, remove, save, list, files, index, advance, objectCountOf, objects };
}

const owner = { id: 'u-owner', name: 'Olive', owner: true };
const ana = { id: 'u-ana', name: 'Ana', owner: false };
const bo = { id: 'u-bo', name: 'Bo', owner: false };

describe('automatic versions', () => {
  it('writes a version at the first save of a board that has something on it, and none for an empty board', () => {
    const s = serverSetup();
    const r = s.room();
    s.save(r);
    expect(s.list()).toEqual([]);
    s.add(r, 0, 5);
    s.save(r);
    const [v] = s.list();
    expect(v).toMatchObject({ kind: 'auto', objects: 5, label: null, by: null, from: null });
    expect(s.files()).toHaveLength(1);
    expect(s.index().v).toBe(1);
    expect(s.objectCountOf('board1', v.id)).toBe(5);
  });

  it('never snapshots a comments room', () => {
    const s = serverSetup();
    const r = s.room('board1~comments', 'comments');
    s.add(r, 0, 5);
    s.save(r);
    expect(fs.existsSync(path.join(s.dir, 'history'))).toBe(false);
  });

  it('writes nothing when the state has not changed, even after the interval', () => {
    const s = serverSetup();
    const r = s.room();
    s.add(r, 0, 5);
    s.save(r);
    s.advance(LIMITS.intervalMs + MIN);
    s.save(r);
    expect(s.list()).toHaveLength(1);
  });

  it('counts a delete-only change as a change, although the Yjs state vector does not move', () => {
    const s = serverSetup();
    const r = s.room();
    s.add(r, 0, 20);
    s.save(r);
    const vector = Y.encodeStateVector(r.doc);
    s.advance(LIMITS.intervalMs + MIN);
    s.remove(r, 0, 1);
    expect(Y.encodeStateVector(r.doc)).toEqual(vector);
    s.save(r);
    expect(s.list()).toHaveLength(2);
    expect(s.list()[0].objects).toBe(19);
  });

  it('waits for the interval between automatic versions', () => {
    const s = serverSetup();
    const r = s.room();
    s.add(r, 0, 5);
    s.save(r);
    s.advance(5 * MIN);
    s.add(r, 5, 1);
    s.save(r);
    expect(s.list()).toHaveLength(1);
    s.advance(5 * MIN + 1000);
    s.save(r);
    expect(s.list()).toHaveLength(2);
    expect(s.list()[0].objects).toBe(6);
  });

  it('writes a version when everyone has left, but not within a minute of the newest one', () => {
    const s = serverSetup();
    const r = s.room();
    s.add(r, 0, 5);
    s.save(r);
    s.add(r, 5, 1);
    s.advance(30_000);
    r.conns.clear();
    s.save(r);
    expect(s.list()).toHaveLength(1);
    s.advance(31_000);
    s.save(r);
    expect(s.list()).toHaveLength(2);

    // with somebody still connected the same gap writes nothing
    const t = s.room('board2');
    s.add(t, 0, 5);
    s.save(t);
    s.add(t, 5, 1);
    s.advance(2 * MIN);
    s.save(t);
    expect(s.list('board2')).toHaveLength(1);
  });

  it('keeps the board as it was just before a large deletion', () => {
    const s = serverSetup();
    const r = s.room();
    s.add(r, 0, 40);
    s.save(r);
    s.advance(MIN);
    s.add(r, 40, 10);
    s.save(r);
    expect(s.list()).toHaveLength(1);
    s.advance(MIN);
    s.remove(r, 0, 40);
    s.save(r);
    const versions = s.list();
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({ kind: 'auto', objects: 50 });
    expect(s.objectCountOf('board1', versions[0].id)).toBe(50);
  });

  it('leaves a small deletion alone', () => {
    const s = serverSetup();
    const r = s.room();
    s.add(r, 0, 50);
    s.save(r);
    s.advance(MIN);
    s.remove(r, 0, 9);
    s.save(r);
    s.advance(MIN);
    s.remove(r, 9, 10);
    s.save(r);
    expect(s.list()).toHaveLength(1);
  });

  it('survives a snapshot that cannot be written', () => {
    const s = serverSetup();
    const r = s.room('board1');
    s.add(r, 0, 5);
    fs.writeFileSync(path.join(s.dir, 'history'), 'a file where the directory should be');
    expect(() => s.save(r)).not.toThrow();
  });
});

describe('named versions and restores', () => {
  it('names the newest version instead of storing a copy when the content is the same', () => {
    const s = serverSetup();
    const r = s.room();
    s.add(r, 0, 5);
    s.save(r);
    const result = s.history.actions.create('board1', ana, { label: 'Kick-off' });
    expect(result.created).toBe(false);
    expect(result.version).toMatchObject({ kind: 'named', label: 'Kick-off', by: ana.id, byName: 'Ana' });
    expect(s.files()).toHaveLength(1);
    expect(s.list()).toHaveLength(1);

    // the newest is named now, so naming the same content again stores a second entry
    const again = s.history.actions.create('board1', bo, { label: 'Second' });
    expect(again.created).toBe(true);
    expect(s.list()).toHaveLength(2);
    expect(s.files()).toHaveLength(2);
  });

  it('saves a named version of the room as it is now, from the live room or the file', () => {
    const s = serverSetup();
    const r = s.room();
    s.add(r, 0, 7);
    s.save(r);
    s.advance(MIN);
    s.add(r, 7, 3);
    s.states.set('board1', Y.encodeStateAsUpdate(r.doc));
    const { version, created } = s.history.actions.create('board1', ana, { label: 'Ten' });
    expect(created).toBe(true);
    expect(version.objects).toBe(10);
    expect(s.objectCountOf('board1', version.id)).toBe(10);
  });

  it('refuses a bad label, an empty board and more than the limit of named versions', () => {
    const s = serverSetup({ maxNamed: 2 });
    expect(() => s.history.actions.create('board1', ana, { label: 'x' })).toThrow(expect.objectContaining({ status: 409, code: 'empty' }));
    const r = s.room();
    s.add(r, 0, 3);
    s.save(r);
    for (const label of ['', '   ', 'a\nb', 'x'.repeat(81), 42, undefined]) {
      expect(() => s.history.actions.create('board1', ana, { label })).toThrow(expect.objectContaining({ status: 400 }));
    }
    s.history.actions.create('board1', ana, { label: 'One' });
    s.advance(MIN);
    s.add(r, 3, 1);
    s.states.set('board1', Y.encodeStateAsUpdate(r.doc));
    s.history.actions.create('board1', ana, { label: 'Two' });
    s.advance(MIN);
    s.add(r, 4, 1);
    s.states.set('board1', Y.encodeStateAsUpdate(r.doc));
    expect(() => s.history.actions.create('board1', ana, { label: 'Three' })).toThrow(expect.objectContaining({ status: 409, code: 'limit' }));
    const unnamed = s.history.actions.beginRestore('board1', s.list()[0].id, ana).preRestore!;
    expect(() => s.history.actions.rename('board1', unnamed.id, ana, { label: 'Three' })).toThrow(expect.objectContaining({ code: 'limit' }));
  });

  it('lets any editor name an unnamed version, only its creator or the owner rename a named one', () => {
    const s = serverSetup();
    const r = s.room();
    s.add(r, 0, 3);
    s.save(r);
    const id = s.list()[0].id;
    expect(s.history.actions.rename('board1', id, ana, { label: 'Mine' })).toMatchObject({ kind: 'named', label: 'Mine', by: ana.id });
    expect(() => s.history.actions.rename('board1', id, bo, { label: 'Not yours' })).toThrow(expect.objectContaining({ status: 403 }));
    expect(s.history.actions.rename('board1', id, ana, { label: 'Still mine' }).label).toBe('Still mine');
    expect(s.history.actions.rename('board1', id, owner, { label: 'Owner’s call' })).toMatchObject({ label: 'Owner’s call', by: ana.id });
  });

  it('lets the owner delete any version and an editor only a named version they created', () => {
    const s = serverSetup();
    const r = s.room();
    s.add(r, 0, 3);
    s.save(r);
    const auto = s.list()[0].id;
    expect(() => s.history.actions.remove('board1', auto, ana)).toThrow(expect.objectContaining({ status: 403 }));
    s.history.actions.rename('board1', auto, ana, { label: 'Mine' });
    expect(() => s.history.actions.remove('board1', auto, bo)).toThrow(expect.objectContaining({ status: 403 }));
    s.history.actions.remove('board1', auto, ana);
    expect(s.list()).toEqual([]);
    expect(s.files()).toEqual([]);

    s.advance(LIMITS.intervalMs + MIN);
    s.add(r, 3, 1);
    s.save(r);
    s.history.actions.remove('board1', s.list()[0].id, owner);
    expect(s.list()).toEqual([]);
  });

  it('does not know a version of another board, or an id that is not one', () => {
    const s = serverSetup();
    const r = s.room();
    s.add(r, 0, 3);
    s.save(r);
    const id = s.list()[0].id;
    expect(() => s.history.actions.state('board2', id)).toThrow(expect.objectContaining({ status: 404 }));
    for (const bad of ['../../etc/passwd', '..', 'short', `${id}x`, '', undefined, 7]) {
      expect(() => s.history.actions.state('board1', bad as string)).toThrow(HistoryError);
      expect(() => s.history.actions.rename('board1', bad as string, owner, { label: 'x' })).toThrow(HistoryError);
      expect(() => s.history.actions.remove('board1', bad as string, owner)).toThrow(HistoryError);
    }
  });

  it('refuses board ids that would leave the history directory', () => {
    const s = serverSetup();
    for (const bad of ['../x', 'a/b', '..', '', 'a'.repeat(65), 'a b']) {
      expect(() => s.history.actions.list(bad)).toThrow(HistoryError);
    }
    expect(fs.existsSync(path.join(s.dir, 'history'))).toBe(false);
  });

  it('serves the stored state as gzip of the room state', () => {
    const s = serverSetup();
    const r = s.room();
    s.add(r, 0, 4);
    s.save(r);
    const gz = s.history.actions.state('board1', s.list()[0].id);
    expect(Buffer.from(zlib.gunzipSync(gz))).toEqual(Buffer.from(Y.encodeStateAsUpdate(r.doc)));
  });

  it('begin-restore saves the board as it is, then the next saved change becomes a restore version', () => {
    const s = serverSetup();
    const r = s.room();
    s.add(r, 0, 10);
    s.save(r);
    const target = s.list()[0].id;
    s.advance(2 * MIN);
    s.add(r, 10, 2);
    s.states.set('board1', Y.encodeStateAsUpdate(r.doc));

    const { preRestore, versionId } = s.history.actions.beginRestore('board1', target, ana);
    expect(versionId).toBe(target);
    expect(preRestore).toMatchObject({ kind: 'pre-restore', objects: 12, from: target, by: ana.id });
    expect(s.objectCountOf('board1', preRestore!.id)).toBe(12);

    // the restoring client's edit arrives and is saved
    s.advance(1000);
    s.remove(r, 0, 3);
    s.save(r);
    const newest = s.list()[0];
    expect(newest).toMatchObject({ kind: 'restore', from: target, by: ana.id, objects: 9 });
    expect(s.list().map((v) => v.kind)).toEqual(['restore', 'pre-restore', 'auto']);

    // only the first saved change after it is a restore version
    s.advance(1000);
    s.remove(r, 3, 1);
    s.save(r);
    expect(s.list()).toHaveLength(3);
  });

  it('turns an identical newest automatic version into the pre-restore version instead of copying it', () => {
    const s = serverSetup();
    const r = s.room();
    s.add(r, 0, 4);
    s.save(r);
    const target = s.list()[0].id;
    const { preRestore } = s.history.actions.beginRestore('board1', target, ana);
    expect(preRestore!.id).toBe(target);
    expect(s.list()).toHaveLength(1);
    expect(s.list()[0].kind).toBe('pre-restore');
    expect(s.files()).toHaveLength(1);
  });

  it('forgets a restore whose edit never arrives', () => {
    const s = serverSetup();
    const r = s.room();
    s.add(r, 0, 5);
    s.save(r);
    s.history.actions.beginRestore('board1', s.list()[0].id, ana);
    s.advance(LIMITS.restorePendingMs + 1000);
    s.add(r, 5, 1);
    s.save(r);
    expect(s.list().map((v) => v.kind)).not.toContain('restore');
  });

  it('has nothing to save before a restore on a board without a saved state', () => {
    const s = serverSetup();
    const r = s.room();
    s.add(r, 0, 5);
    s.save(r);
    const id = s.list()[0].id;
    s.states.delete('board1');
    expect(s.history.actions.beginRestore('board1', id, ana).preRestore).toBeNull();
  });
});

describe('retention', () => {
  const entry = (id: string, ageMs: number, kind: string, now: number, bytes = 10) => ({
    id, createdAt: now - ageMs, kind, label: null, by: null, byName: null, objects: 1, bytes, hash: id, from: null,
  });
  // an hour boundary a bit in the past, so that buckets are easy to place
  const now = Math.floor(Date.now() / DAY) * DAY + 12 * HOUR;
  const ids = (set: Set<string>) => [...set].sort();

  it('keeps every automatic version for a day, then the newest per hour for a week, then the newest per day for a month', () => {
    const entries = [
      entry('old', 31 * DAY, 'auto', now),
      entry('d1', 20 * DAY + 5 * HOUR, 'auto', now), // same UTC day as d2
      entry('d2', 20 * DAY + 2 * HOUR, 'auto', now),
      entry('h1', 3 * DAY + 50 * MIN, 'auto', now), // same UTC hour as h2
      entry('h2', 3 * DAY + 20 * MIN, 'auto', now),
      entry('a1', 23 * HOUR, 'auto', now),
      entry('a2', 22 * HOUR + 49 * MIN, 'auto', now),
      entry('new', 5 * MIN, 'auto', now),
    ].sort((a, b) => a.createdAt - b.createdAt);
    const dropped = ids(pruneIds(entries, now));
    expect(dropped).toContain('old');
    expect(dropped.filter((d) => d.startsWith('d'))).toHaveLength(1);
    expect(dropped.filter((d) => d.startsWith('h'))).toHaveLength(1);
    expect(dropped).not.toContain('a1');
    expect(dropped).not.toContain('a2');
    expect(dropped).not.toContain('new');
    expect(dropped).toHaveLength(3);
  });

  it('thins at 23 hours (kept), 25 hours, 8 days and 31 days', () => {
    // two versions in the same hour (25 hours ago), two on the same day (8 days ago)
    const hourOf = Math.floor((now - 25 * HOUR) / HOUR) * HOUR;
    const dayOf = Math.floor((now - 8 * DAY) / DAY) * DAY;
    const mk = (id: string, createdAt: number) => ({ ...entry(id, 0, 'auto', now), createdAt });
    const entries = [
      mk('t31', now - 31 * DAY),
      mk('t8a', dayOf + 2 * HOUR),
      mk('t8b', dayOf + 20 * HOUR),
      mk('t25a', hourOf + 5 * MIN),
      mk('t25b', hourOf + 40 * MIN),
      mk('t23', now - 23 * HOUR),
      mk('t0', now),
    ].sort((a, b) => a.createdAt - b.createdAt);
    expect(ids(pruneIds(entries, now))).toEqual(['t25a', 't31', 't8a']);
  });

  it('keeps named versions forever and pre-restore and restore versions for 30 days', () => {
    const entries = [
      entry('named', 90 * DAY, 'named', now),
      entry('pre-old', 31 * DAY, 'pre-restore', now),
      entry('pre-ok', 29 * DAY, 'pre-restore', now),
      entry('res-old', 40 * DAY, 'restore', now),
      entry('res-ok', 10 * DAY, 'restore', now),
      entry('res-ok-2', 10 * DAY - HOUR, 'restore', now),
    ].sort((a, b) => a.createdAt - b.createdAt);
    expect(ids(pruneIds(entries, now))).toEqual(['pre-old', 'res-old']);
  });

  it('never prunes the newest version, even an old one', () => {
    expect(ids(pruneIds([entry('only', 90 * DAY, 'auto', now)], now))).toEqual([]);
    expect(ids(pruneIds([entry('older', 100 * DAY, 'auto', now), entry('only', 90 * DAY, 'auto', now)], now))).toEqual(['older']);
  });

  it('stays within the byte budget: oldest automatic first, then restores, never the newest or a named version', () => {
    const limits = { ...LIMITS, budgetBytes: 100 };
    const entries = [
      entry('named', 5 * HOUR, 'named', now, 500),
      entry('pre', 4 * HOUR, 'pre-restore', now, 40),
      entry('a1', 3 * HOUR, 'auto', now, 40),
      entry('a2', 2 * HOUR, 'auto', now, 40),
      entry('a3', 1 * HOUR, 'auto', now, 40),
      entry('newest', 0, 'auto', now, 40),
    ].sort((a, b) => a.createdAt - b.createdAt);
    expect(ids(pruneIds(entries, now, limits))).toEqual(['a1', 'a2', 'a3']);
    const small = { ...LIMITS, budgetBytes: 10 };
    expect(ids(pruneIds(entries, now, small))).toEqual(['a1', 'a2', 'a3', 'pre']);
  });

  it('deletes the files of pruned versions when a new version is written', () => {
    const s = serverSetup();
    const r = s.room();
    s.add(r, 0, 5);
    s.save(r);
    const first = s.list()[0].id;
    s.advance(40 * DAY);
    s.add(r, 5, 1);
    s.save(r);
    expect(s.list().map((v) => v.id)).not.toContain(first);
    expect(s.files()).toHaveLength(1);
    expect(s.files()).not.toContain(`${first}.yjs.gz`);
  });

  it('sweeps every board: thins by age and removes version files no index names, but only old ones', () => {
    const s = serverSetup();
    const r = s.room();
    s.add(r, 0, 5);
    s.save(r);
    const kept = s.list()[0].id;
    const dir = path.join(s.dir, 'history', 'board1');
    const stale = path.join(dir, `${'S'.repeat(16)}.yjs.gz`);
    const fresh = path.join(dir, `${'F'.repeat(16)}.yjs.gz`);
    const tmp = path.join(dir, 'index.json.tmp');
    for (const f of [stale, fresh, tmp]) fs.writeFileSync(f, 'x');
    const old = new Date(Date.now() - 2 * HOUR);
    fs.utimesSync(stale, old, old);
    fs.utimesSync(tmp, old, old);

    s.history.sweep();
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(tmp)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(path.join(dir, `${kept}.yjs.gz`))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'index.json'))).toBe(true);

    // a month later the only version is still the newest, so it stays
    s.advance(60 * DAY);
    s.history.sweep();
    expect(s.list()).toHaveLength(1);
  });

  it('sets an unreadable index aside and starts that board over', () => {
    const s = serverSetup();
    const r = s.room();
    s.add(r, 0, 5);
    s.save(r);
    const dir = path.join(s.dir, 'history', 'board1');
    fs.writeFileSync(path.join(dir, 'index.json'), '{ not json');

    // a second history instance, as after a restart
    const after = createHistory({ dataDir: s.dir, boardState: () => null, now: () => s.clock.now, log: () => {}, sweepMs: 0 });
    expect(after.actions.list('board1').versions).toEqual([]);
    expect(fs.readdirSync(dir).some((f) => f.startsWith('index.json.corrupt-'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'index.json'))).toBe(false);
  });

  it('drops index entries it does not understand and keeps the rest', () => {
    const s = serverSetup();
    const r = s.room();
    s.add(r, 0, 5);
    s.save(r);
    const dir = path.join(s.dir, 'history', 'board1');
    const good = s.index().versions[0];
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ v: 1, versions: [good, { id: '../../x', createdAt: 1, kind: 'auto', hash: 'h' }, { id: 'A'.repeat(16), createdAt: 'x', kind: 'auto', hash: 'h' }, null, { ...good, id: 'B'.repeat(16), kind: 'weird' }] }));
    const after = createHistory({ dataDir: s.dir, boardState: () => null, now: () => s.clock.now, log: () => {}, sweepMs: 0 });
    expect(after.actions.list('board1').versions.map((v: Version) => v.id)).toEqual([good.id]);
  });
});
