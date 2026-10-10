import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { BoardApp } from '../src/app';
import { objBounds } from '../src/geometry';
import { Store } from '../src/store';
import type { BaseObj, Id, Obj } from '../src/types';
import { FakeElement, installFakeBrowser, type FakeBrowser } from './fake-dom';

type Harness = BoardApp & Record<string, unknown>;
const note = (id: Id, z: string, x: number): BaseObj => ({
  id, type: 'sticky', x, y: 20, w: 30, h: 30, rotation: 0, z, text: id, fill: '#FFF3A3',
});
const group = (id: Id, z: string, members: Id[], parent?: Id, locked = false): Obj[] => [
  { id, type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z, parent, ...(locked ? { locked: true } : {}) },
  ...members.map((member, i) => ({ ...note(member, `a${i + 1}`, i * 60), parent: id })),
];

let browser: FakeBrowser;
let handlers: Map<string, ((event: unknown) => void)[]>;

beforeEach(() => {
  browser = installFakeBrowser();
  handlers = new Map();
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: (event: unknown) => void) => handlers.set(type, [...(handlers.get(type) ?? []), fn]),
    removeEventListener() {},
    setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
    innerWidth: 1024,
    innerHeight: 768,
  });
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  vi.useRealTimers();
  browser.uninstall();
});

function harness(store = new Store(new Y.Doc())) {
  const app = Object.create(BoardApp.prototype) as Harness;
  const hit = vi.fn<(...args: unknown[]) => Obj | undefined>(() => store.get('a'));
  const flow = { handleClick: vi.fn<(o: Obj) => boolean>((_o) => false), isHidden: () => false, isVoting: vi.fn<() => boolean>(() => false), activeStep: () => null };
  const svg = browser.document.createElement('svg') as FakeElement & { setPointerCapture: (id: number) => void };
  svg.setPointerCapture = vi.fn<(id: number) => void>();
  const overlay = { anchorsFor: null, selection: [], enteredGroup: null, kanban: null };
  Object.assign(app, {
    store, selection: [], scope: null, tool: { kind: 'select' }, drag: null, longPress: null, kbMoving: null,
    listeners: new Map(), spaceDown: false, lastPointer: { x: 0, y: 0 }, pendingFrame: 0, queuedFn: null,
    lifetime: new AbortController(), user: { id: 'me', name: 'Me', color: 'blue' },
    conn: { awareness: { setLocalStateField() {} } }, flow,
    r: {
      cam: { x: 0, y: 0, zoom: 1 }, svg, root: { classList: { add() {}, remove() {} }, dataset: {}, append() {} },
      overlay, pins: [], setOverlay(patch: object) { Object.assign(overlay, patch); },
      clientToWorld: (x: number, y: number) => ({ x, y }),
      viewport: () => ({ x: 0, y: 0, w: 1000, h: 800 }),
    },
    editor: { active: false, commit() {}, start() {} },
    notify: vi.fn<(...args: unknown[]) => void>(), announce: vi.fn<(...args: unknown[]) => void>(), emit() {},
    closeThread: vi.fn<(...args: unknown[]) => void>(), setDraftPin: vi.fn<(...args: unknown[]) => void>(), setTool: vi.fn<(...args: unknown[]) => void>(),
    isPinching: () => false,
    hit,
    frameAt: () => undefined,
  });
  return { app, store, hit, flow };
}

function useRealHit(app: Harness, store: Store) {
  app.hit = BoardApp.prototype.hit.bind(app);
  Object.assign(app.r, {
    bounds: (o: Obj) => objBounds((id) => store.getPlaced(id), store.getPlaced(o.id) ?? o),
    contentBounds: (ids: Iterable<Id>) => {
      const id = [...ids][0];
      const o = id ? store.getPlaced(id) : undefined;
      return o ? objBounds((parent) => store.getPlaced(parent), o) : null;
    },
    connectorLayout: () => new Map(),
  });
}

const pointer = (x: number, y: number, pointerType: 'mouse' | 'touch' = 'mouse') => ({
  clientX: x, clientY: y, pointerId: 1, pointerType, button: 0, shiftKey: false, altKey: false, preventDefault() {},
});
const longPressId = (app: Harness) => (app as unknown as { longPress?: { id: Id } | null }).longPress?.id;

const call = (app: Harness, name: string, ...args: unknown[]) => (app[name] as (...xs: unknown[]) => unknown).apply(app, args);
const clipboardOf = (app: Harness) => Reflect.get(app, 'clipboard') as Obj[];
const key = (event: Partial<KeyboardEvent>) => ({
  key: '', code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, target: browser.document.body,
  preventDefault: vi.fn<() => void>(), stopImmediatePropagation: vi.fn<() => void>(), ...event,
});
const keydown = (event: Partial<KeyboardEvent>) => handlers.get('keydown')?.forEach((fn) => fn(key(event)));
const objects = (store: Store) => [...store.cache.values()].map((o) => structuredClone(o)).sort((a, b) => a.id.localeCompare(b.id));
const sync = (a: Store, b: Store) => {
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)));
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)));
};

describe('group app commands and scope', () => {
  it('closes the Templates drawer through shared Escape priority and returns focus to its rail button', () => {
    const { app } = harness();
    const drawer = browser.document.createElement('aside');
    drawer.className = 'drawer show';
    drawer.dataset.tab = 'templates';
    const templatesButton = browser.document.createElement('button');
    templatesButton.dataset.drawer = 'templates';
    browser.document.body.appendChild(drawer);
    browser.document.body.appendChild(templatesButton);
    app.closeEscapeDrawer = vi.fn<() => boolean>(() => {
      drawer.classList.remove('show');
      templatesButton.focus();
      return true;
    });
    call(app, 'bindKeys');

    const event = key({ key: 'Escape' });
    handlers.get('keydown')?.forEach((fn) => fn(event));

    expect(drawer.classList.contains('show')).toBe(false);
    expect(browser.document.activeElement).toBe(templatesButton);
    expect(app.closeEscapeDrawer).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
  });

  it('groups and ungroups from Ctrl/Cmd+G in one undo step each, restoring the exact document state', () => {
    const store = new Store(new Y.Doc());
    store.transact(() => { store.create(note('a', 'a1', 10)); store.create(note('b', 'a8', 80)); });
    store.undo.clear();
    const before = objects(store);
    const { app } = harness(store);
    app.selection = ['a', 'b'];
    call(app, 'bindKeys');

    keydown({ key: 'g', code: 'KeyG', ctrlKey: true });
    const grouped = objects(store);
    const groupId = app.selection[0];
    expect(store.get(groupId)?.type).toBe('group');
    expect((app.announce as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toBe('Grouped 2 items');
    expect(store.undo.undoStack).toHaveLength(1);

    keydown({ key: 'g', code: 'KeyG', ctrlKey: true, shiftKey: true });
    expect(store.get(groupId)).toBeUndefined();
    expect(store.get('a')?.parent).toBeUndefined();
    expect(store.get('b')?.parent).toBeUndefined();
    expect(store.undo.undoStack).toHaveLength(2);

    store.undo.undo();
    expect(objects(store)).toEqual(grouped);
    store.undo.undo();
    expect(objects(store)).toEqual(before);
  });

  it('click selects the group, double-click enters it, and Escape leaves to the parent level', () => {
    const store = new Store(new Y.Doc());
    store.transact(() => group('g', 'a1', ['a', 'b']).forEach((o) => store.create(o)));
    const { app, hit } = harness(store);
    hit.mockImplementation(() => store.get('a'));
    call(app, 'bindKeys');

    const p = { clientX: 10, clientY: 10, pointerId: 1, pointerType: 'mouse', button: 0, shiftKey: false, altKey: false, preventDefault() {} };
    call(app, 'onDown', p);
    expect(app.selection).toEqual(['g']);
    expect(app.scope).toBeNull();

    call(app, 'onDblClick', { clientX: 10, clientY: 10 });
    expect(app.scope).toBe('g');
    expect(app.selection).toEqual(['a']);

    keydown({ key: 'Escape', code: 'Escape' });
    expect(app.scope).toBeNull();
    expect(app.selection).toEqual(['g']);

    call(app, 'enterGroup', 'g');
    hit.mockReturnValue(undefined);
    const emptyClick = { clientX: 400, clientY: 400, pointerId: 2, pointerType: 'mouse', button: 0, shiftKey: false, altKey: false, preventDefault() {} };
    call(app, 'onDown', emptyClick);
    call(app, 'onUp', emptyClick);
    expect(app.scope).toBeNull();
    expect(app.selection).toEqual(['g']);
  });

  it('leaves only the current group when empty canvas is clicked from a nested scope', () => {
    const store = new Store(new Y.Doc());
    store.transact(() => {
      store.create({ id: 'outer', type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a1' });
      store.create({ id: 'inner', type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a2', parent: 'outer' });
      store.create({ ...note('leaf', 'a1', 10), parent: 'inner' });
    });
    const { app, hit } = harness(store);
    app.enterGroup('outer');
    app.enterGroup('inner');
    hit.mockReturnValue(undefined);
    const emptyClick = { clientX: 400, clientY: 400, pointerId: 2, pointerType: 'mouse', button: 0, shiftKey: false, altKey: false, preventDefault() {} };
    call(app, 'onDown', emptyClick);
    call(app, 'onUp', emptyClick);
    expect(app.scope).toBe('outer');
    expect(app.selection).toEqual(['inner']);
  });

  it('keeps dot-vote clicks on the hit member rather than lifting them to its group', () => {
    const store = new Store(new Y.Doc());
    store.transact(() => group('g', 'a1', ['a', 'b']).forEach((o) => store.create(o)));
    const { app, hit, flow } = harness(store);
    hit.mockImplementation(() => store.get('a'));
    flow.handleClick.mockReturnValue(true);
    call(app, 'onDown', { clientX: 10, clientY: 10, pointerId: 1, pointerType: 'mouse', button: 0, shiftKey: false, altKey: false, preventDefault() {} });
    expect(flow.handleClick.mock.calls[0][0]?.id).toBe('a');
    expect(app.selection).toEqual([]);
  });

  it('does not enter a group on the double-click event after vote clicks', () => {
    const store = new Store(new Y.Doc());
    store.transact(() => group('g', 'a1', ['a', 'b']).forEach((o) => store.create(o)));
    const { app, hit, flow } = harness(store);
    hit.mockImplementation(() => store.get('a'));
    flow.isVoting.mockReturnValue(true);
    flow.handleClick.mockReturnValue(true);
    const click = { clientX: 10, clientY: 10, pointerId: 1, pointerType: 'mouse', button: 0, shiftKey: false, altKey: false, preventDefault() {} };
    call(app, 'onDown', click);
    call(app, 'onDown', click);
    call(app, 'onDblClick', { clientX: 10, clientY: 10 });
    expect(flow.handleClick).toHaveBeenCalledTimes(2);
    expect(flow.handleClick.mock.calls.map(([o]) => o.id)).toEqual(['a', 'a']);
    expect(app.scope).toBeNull();
    expect(app.selection).toEqual([]);
  });

  it('disables ungroup when a non-group is included in the selection', () => {
    const store = new Store(new Y.Doc());
    store.transact(() => {
      group('g', 'a1', ['a', 'b']).forEach((o) => store.create(o));
      store.create(note('loose', 'a9', 240));
    });
    const { app } = harness(store);
    app.selection = ['g', 'loose'];
    const before = objects(store);
    expect(app.canUngroupSelection()).toBe(false);
    expect(app.ungroupSelection()).toBe(false);
    expect(objects(store)).toEqual(before);
  });

  it('copies and duplicates a nested group subtree, remapping parents and internal connectors', () => {
    const store = new Store(new Y.Doc());
    store.transact(() => {
      store.create({ id: 'outer', type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a1' });
      store.create({ id: 'inner', type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a2', parent: 'outer' });
      store.create({ ...note('a', 'a1', 10), parent: 'inner' });
      store.create({ ...note('b', 'a3', 70), parent: 'outer' });
      store.create({ id: 'inside', type: 'connector', z: 'a4', parent: 'outer', from: { kind: 'bound', id: 'a', anchor: 'auto' }, to: { kind: 'bound', id: 'b', anchor: 'auto' }, route: 'straight', startHead: 'none', endHead: 'arrow' });
      store.create({ id: 'outside-line', type: 'connector', z: 'a5', parent: 'outer', from: { kind: 'bound', id: 'a', anchor: 'auto' }, to: { kind: 'bound', id: 'outside', anchor: 'auto' }, route: 'straight', startHead: 'none', endHead: 'arrow' });
      store.create(note('outside', 'a6', 300));
    });
    store.undo.clear();
    const before = objects(store);
    const { app } = harness(store);
    app.setSelection(['outer']);
    call(app, 'bindKeys');

    keydown({ key: 'c', code: 'KeyC', ctrlKey: true });
    const clipboard = clipboardOf(app);
    expect(clipboard.map((o) => o.id)).toEqual(expect.arrayContaining(['outer', 'inner', 'a', 'b', 'inside']));
    expect(clipboard.map((o) => o.id)).not.toContain('outside-line');
    expect(clipboard.filter((o) => o.type === 'group')).toHaveLength(2);

    keydown({ key: 'd', code: 'KeyD', ctrlKey: true });
    expect(store.undo.undoStack).toHaveLength(1);
    expect(app.selection).toHaveLength(1);
    const copiedRoot = store.get(app.selection[0])!;
    expect(copiedRoot.type).toBe('group');
    expect(copiedRoot.id).not.toBe('outer');
    const copiedInner = store.childrenOf(copiedRoot.id).find((o) => o.type === 'group')!;
    const copiedA = store.childrenOf(copiedInner.id).find((o) => o.type === 'sticky')!;
    const copiedB = store.childrenOf(copiedRoot.id).find((o) => o.type === 'sticky')!;
    const copiedLine = [...store.cache.values()].find((o) => o.type === 'connector' && o.id !== 'inside' && o.id !== 'outside-line')!;
    expect(copiedInner.parent).toBe(copiedRoot.id);
    expect(copiedA.parent).toBe(copiedInner.id);
    expect(copiedB.parent).toBe(copiedRoot.id);
    expect(copiedLine.parent).toBe(copiedRoot.id);
    expect(copiedLine).toMatchObject({ from: { kind: 'bound', id: copiedA.id }, to: { kind: 'bound', id: copiedB.id } });
    expect([...store.cache.values()].filter((o) => o.type === 'connector')).toHaveLength(3);

    const duplicated = objects(store);
    store.undo.undo();
    expect(objects(store)).toEqual(before);
    store.undo.redo();
    expect(objects(store)).toEqual(duplicated);
    store.undo.undo();
    expect(objects(store)).toEqual(before);
    store.undo.redo();
    expect(objects(store)).toEqual(duplicated);
  });

  it('pastes a copied nested group from the clipboard JSON onto another board in one undo step', () => {
    const source = new Store(new Y.Doc());
    source.transact(() => {
      source.create({ id: 'group', type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a1' });
      source.create({ id: 'nested', type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a2', parent: 'group' });
      source.create({ ...note('leaf', 'a1', 20), parent: 'nested' });
    });
    const sourceApp = harness(source).app;
    sourceApp.setSelection(['group']);
    sourceApp.copy();
    const payload = JSON.stringify({ driftboard: 1, objects: clipboardOf(sourceApp) });

    const target = new Store(new Y.Doc());
    target.undo.clear();
    const { app } = harness(target);
    app.pasteText(payload);
    expect(target.undo.undoStack).toHaveLength(1);
    expect(app.selection).toHaveLength(1);
    const pastedRoot = target.get(app.selection[0])!;
    expect(pastedRoot.type).toBe('group');
    expect(pastedRoot.id).not.toBe('group');
    const pastedNested = target.childrenOf(pastedRoot.id).find((o) => o.type === 'group')!;
    const pastedLeaf = target.childrenOf(pastedNested.id)[0];
    expect(pastedLeaf.parent).toBe(pastedNested.id);
    expect(pastedLeaf).toMatchObject({ x: -15, y: -15 });
    const after = objects(target);
    target.undo.undo();
    expect(objects(target)).toEqual([]);
    target.undo.redo();
    expect(objects(target)).toEqual(after);
    target.undo.undo();
    expect(objects(target)).toEqual([]);
    target.undo.redo();
    expect(objects(target)).toEqual(after);
  });

  it('cuts a group by copying its subtree and deleting it as one undoable action', () => {
    const store = new Store(new Y.Doc());
    store.transact(() => group('g', 'a1', ['a', 'b']).forEach((o) => store.create(o)));
    store.undo.clear();
    const before = objects(store);
    const { app } = harness(store);
    app.setSelection(['g']);
    call(app, 'bindKeys');
    keydown({ key: 'x', code: 'KeyX', ctrlKey: true });

    expect(objects(store)).toEqual([]);
    expect(clipboardOf(app).map((o) => o.id)).toEqual(expect.arrayContaining(['g', 'a', 'b']));
    expect(store.undo.undoStack).toHaveLength(1);
    store.undo.undo();
    expect(objects(store)).toEqual(before);
    store.undo.redo();
    expect(objects(store)).toEqual([]);
    store.undo.undo();
    expect(objects(store)).toEqual(before);
    store.undo.redo();
    expect(objects(store)).toEqual([]);
  });

  it('locks only a selected group and leaves its members’ own lock flags through undo and redo', () => {
    const store = new Store(new Y.Doc());
    store.transact(() => {
      store.create({ id: 'g', type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a1' });
      store.create({ ...note('own-locked', 'a1', 10), parent: 'g', locked: true });
      store.create({ ...note('unlocked', 'a2', 50), parent: 'g' });
    });
    store.undo.clear();
    const { app } = harness(store);
    app.setSelection(['g']);
    app.toggleLock();
    expect(store.get('g')?.locked).toBe(true);
    expect(store.get('own-locked')?.locked).toBe(true);
    expect(store.get('unlocked')?.locked).toBeUndefined();
    const locked = objects(store);
    store.undo.undo();
    expect(store.get('g')?.locked).toBeUndefined();
    expect(store.get('own-locked')?.locked).toBe(true);
    store.undo.redo();
    expect(objects(store)).toEqual(locked);

    app.setLocked('g', false);
    expect(store.get('g')?.locked).toBeUndefined();
    expect(store.get('own-locked')?.locked).toBe(true);
    expect(store.get('unlocked')?.locked).toBeUndefined();
    const unlocked = objects(store);
    store.undo.undo();
    expect(objects(store)).toEqual(locked);
    store.undo.redo();
    expect(objects(store)).toEqual(unlocked);
    store.undo.undo();
    expect(objects(store)).toEqual(locked);
    store.undo.redo();
    expect(objects(store)).toEqual(unlocked);
  });

  it('select-all skips locked groups at the board level and in an entered group', () => {
    const store = new Store(new Y.Doc());
    store.transact(() => {
      group('locked', 'a1', ['locked-leaf'], undefined, true).forEach((o) => store.create(o));
      store.create({ id: 'open', type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a3' });
      store.create({ id: 'nested-locked', type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a4', parent: 'open', locked: true });
      store.create({ ...note('nested-leaf', 'a1', 10), parent: 'nested-locked' });
      store.create({ ...note('open-leaf', 'a5', 50), parent: 'open' });
      store.create(note('outside', 'a6', 100));
    });
    const { app } = harness(store);
    call(app, 'bindKeys');
    keydown({ key: 'a', code: 'KeyA', ctrlKey: true });
    expect(app.selection).toEqual(expect.arrayContaining(['open', 'outside']));
    expect(app.selection).not.toContain('locked');

    app.enterGroup('open');
    keydown({ key: 'a', code: 'KeyA', ctrlKey: true });
    expect(app.selection).toEqual(['open-leaf']);
  });

  it('stacks a group as one derived-rectangle sibling and reorders members inside its scope', () => {
    const store = new Store(new Y.Doc());
    store.transact(() => {
      store.create({ id: 'g', type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a1' });
      store.create({ ...note('member', 'a2', 10), parent: 'g' });
      store.create(note('sibling', 'a3', 20));
    });
    store.undo.clear();
    const { app } = harness(store);
    useRealHit(app, store);
    const memberZ = store.get('member')?.z;
    app.setSelection(['g']);
    expect(app.bringForward()).toBe(true);
    expect(store.get('g')!.z > store.get('sibling')!.z).toBe(true);
    expect(store.get('member')?.z).toBe(memberZ);
    const groupZ = store.get('g')?.z;
    const stacked = objects(store);
    store.undo.undo();
    expect(store.get('g')?.z).toBe('a1');
    store.undo.redo();
    expect(objects(store)).toEqual(stacked);
    store.undo.undo();
    expect(store.get('g')?.z).toBe('a1');
    store.undo.redo();
    expect(objects(store)).toEqual(stacked);
    app.enterGroup('g');
    app.setSelection(['member']);
    expect(app.bringForward()).toBe(false);
    expect(store.get('g')?.z).toBe(groupZ);

    const nested = new Store(new Y.Doc());
    nested.transact(() => {
      nested.create({ id: 'scope', type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a1' });
      nested.create({ ...note('first', 'a2', 0), parent: 'scope' });
      nested.create({ ...note('second', 'a3', 10), parent: 'scope' });
    });
    nested.undo.clear();
    const innerApp = harness(nested).app;
    useRealHit(innerApp, nested);
    const scopeZ = nested.get('scope')?.z;
    innerApp.enterGroup('scope');
    innerApp.setSelection(['first']);
    expect(innerApp.bringForward()).toBe(true);
    expect(nested.get('first')!.z > nested.get('second')!.z).toBe(true);
    expect(nested.get('scope')?.z).toBe(scopeZ);
  });

  it.each(['mouse', 'touch'] as const)('%s passes through a locked group to an unlocked object beneath it', (pointerType) => {
    const store = new Store(new Y.Doc());
    store.transact(() => {
      store.create(note('under', 'a0', 10));
      group('locked-group', 'a3', ['member'], undefined, true).forEach((o) => store.create(o));
    });
    const { app } = harness(store);
    useRealHit(app, store);

    const down = pointer(10, 25, pointerType);
    call(app, 'onDown', down);
    expect(app.selection).toEqual(['under']);
    expect(longPressId(app)).toBe('locked-group');
    call(app, 'onUp', down);
    expect(store.get('locked-group')?.locked).toBe(true);
  });

  it.each(['mouse', 'touch'] as const)('%s passes through an individually locked group member', (pointerType) => {
    const store = new Store(new Y.Doc());
    store.transact(() => {
      store.create(note('under', 'a0', 10));
      group('unlocked-group', 'a3', ['member']).forEach((o) => store.create(o));
      store.update('member', { locked: true });
    });
    const { app } = harness(store);
    useRealHit(app, store);

    const down = pointer(10, 25, pointerType);
    call(app, 'onDown', down);
    expect(app.selection).toEqual(['under']);
    expect(longPressId(app)).toBe('member');
    call(app, 'onUp', down);
    expect(store.get('member')?.locked).toBe(true);
  });

  it('marquee skips locked groups and locked members while still selecting an unlocked object underneath', () => {
    const store = new Store(new Y.Doc());
    store.transact(() => {
      store.create(note('under', 'a0', 10));
      group('locked-group', 'a3', ['locked-child'], undefined, true).forEach((o) => store.create(o));
      store.create({ id: 'open-group', type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a4' });
      store.create({ ...note('locked-member', 'a4', 120), parent: 'open-group', locked: true });
      store.create({ ...note('outside', 'a5', 220), parent: 'open-group' });
    });
    const { app } = harness(store);
    useRealHit(app, store);

    const start = pointer(0, 0);
    call(app, 'onDown', start);
    call(app, 'onMove', pointer(160, 70));
    expect(app.selection).toEqual(['under']);
    call(app, 'onUp', pointer(160, 70));
  });

  it.each(['mouse', 'touch'] as const)('%s and marquee pass through a locked nested group under an unlocked group', (pointerType) => {
    const store = new Store(new Y.Doc());
    store.transact(() => {
      store.create(note('under', 'a0', 10));
      store.create({ id: 'outer', type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a4' });
      store.create({ id: 'inner', type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a3', parent: 'outer', locked: true });
      store.create({ ...note('member', 'a2', 0), parent: 'inner' });
    });
    const { app } = harness(store);
    useRealHit(app, store);

    const down = pointer(10, 25, pointerType);
    call(app, 'onDown', down);
    expect(app.selection).toEqual(['under']);
    expect(longPressId(app)).toBe('inner');
    call(app, 'onUp', down);

    call(app, 'onDown', pointer(0, 0));
    call(app, 'onMove', pointer(160, 70));
    expect(app.selection).toEqual(['under']);
    call(app, 'onUp', pointer(160, 70));
  });

  it('a 600 ms long press unlocks the outermost locked group and preserves a nested lock', async () => {
    vi.useFakeTimers();
    const store = new Store(new Y.Doc());
    store.transact(() => {
      store.create({ id: 'outer', type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a1', locked: true });
      store.create({ id: 'inner', type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a2', parent: 'outer', locked: true });
      store.create({ ...note('member', 'a3', 10), parent: 'inner' });
    });
    const { app } = harness(store);
    useRealHit(app, store);

    call(app, 'onDown', pointer(10, 25, 'touch'));
    expect(longPressId(app)).toBe('outer');
    await vi.advanceTimersByTimeAsync(600);
    expect(store.get('outer')?.locked).toBeUndefined();
    expect(store.get('inner')?.locked).toBe(true);
  });

  it('a 600 ms long press still unlocks a member that has its own lock', async () => {
    vi.useFakeTimers();
    const store = new Store(new Y.Doc());
    store.transact(() => store.create({ ...note('member', 'a1', 10), locked: true }));
    const { app } = harness(store);
    useRealHit(app, store);

    call(app, 'onDown', pointer(10, 25, 'touch'));
    expect(longPressId(app)).toBe('member');
    await vi.advanceTimersByTimeAsync(600);
    expect(store.get('member')?.locked).toBeUndefined();
  });

  it('releasing before the long-press threshold leaves the lock in place', () => {
    vi.useFakeTimers();
    const store = new Store(new Y.Doc());
    store.transact(() => store.create({ ...note('member', 'a1', 10), locked: true }));
    const { app } = harness(store);
    useRealHit(app, store);

    const down = pointer(10, 25, 'touch');
    call(app, 'onDown', down);
    call(app, 'onUp', down);
    vi.advanceTimersByTime(599);
    expect(store.get('member')?.locked).toBe(true);
  });

  it('leaves to the nearest parent scope when selecting a sibling outside the entered group', () => {
    const store = new Store(new Y.Doc());
    store.transact(() => {
      store.create({ id: 'outer', type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a1' });
      store.create({ id: 'inner', type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a2', parent: 'outer' });
      store.create({ ...note('leaf', 'a1', 10), parent: 'inner' });
      store.create({ ...note('sibling', 'a3', 80), parent: 'outer' });
    });
    const { app } = harness(store);
    app.enterGroup('outer');
    app.enterGroup('inner');
    app.setSelection(['sibling']);
    expect(app.scope).toBe('outer');
    expect(app.selection).toEqual(['sibling']);
  });
});

describe('group operations across two Y.Docs', () => {
  it('merges grouping against deleting a member', () => {
    const left = new Store(new Y.Doc()), right = new Store(new Y.Doc());
    left.transact(() => { left.create(note('a', 'a1', 10)); left.create(note('b', 'a8', 80)); });
    Y.applyUpdate(right.doc, Y.encodeStateAsUpdate(left.doc));
    const { app } = harness(left);
    app.selection = ['a', 'b'];
    expect(app.groupSelection()).toBe(true);
    right.transact(() => right.remove(['b']));
    sync(left, right);
    const groupId = app.selection[0];
    for (const store of [left, right]) {
      expect(store.get('b')).toBeUndefined();
      expect(store.childrenOf(groupId).map((o) => o.id)).toEqual(['a']);
    }
  });

  it('merges ungrouping against moving a member', () => {
    const left = new Store(new Y.Doc()), right = new Store(new Y.Doc());
    left.transact(() => group('g', 'a4', ['a', 'b']).forEach((o) => left.create(o)));
    Y.applyUpdate(right.doc, Y.encodeStateAsUpdate(left.doc));
    const { app } = harness(left);
    app.selection = ['g'];
    expect(app.ungroupSelection()).toBe(true);
    right.transact(() => right.update('a', { x: 222 }));
    sync(left, right);
    for (const store of [left, right]) {
      expect(store.get('g')).toBeUndefined();
      expect(store.get('a')?.x).toBe(222);
      expect(store.get('a')?.parent).toBeUndefined();
    }
  });

  it('keeps a local group duplicate intact when another Y.Doc deletes an original member', () => {
    const left = new Store(new Y.Doc()), right = new Store(new Y.Doc());
    left.transact(() => group('g', 'a1', ['a', 'b']).forEach((o) => left.create(o)));
    Y.applyUpdate(right.doc, Y.encodeStateAsUpdate(left.doc));
    const { app } = harness(left);
    app.setSelection(['g']);
    app.duplicate();
    const copyId = app.selection[0];

    right.transact(() => right.remove(['a']));
    sync(left, right);
    for (const store of [left, right]) {
      expect(store.get('a')).toBeUndefined();
      expect(store.childrenOf('g').map((o) => o.id)).toEqual(['b']);
      expect(store.childrenOf(copyId)).toHaveLength(2);
      expect(store.childrenOf(copyId).every((o) => o.id !== 'a')).toBe(true);
    }
  });
});
