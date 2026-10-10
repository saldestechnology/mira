import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { ApiError, type GuestJoin } from '../src/api';
import { authState, initAuth, markGuestSessionEnded, setGuest, setSignedIn, setSignedOut } from '../src/auth';
import { resolveRoute } from '../src/route';
import { THEMES } from '../src/themes';
import { BoardApp } from '../src/app';
import { boardAccess } from '../src/cloud-logic';
import { Comments } from '../src/comments';
import {
  applyConnectionAccess, denialForGuestSession, GUEST_ENDED_BANNER, GUEST_ENDED_SYNC_LABEL, GUEST_ENDED_SYNC_TIP,
  guestAccessEnded, watchGuestAccess,
} from '../src/guest-access';
import { Renderer } from '../src/render';
import { Store } from '../src/store';
import { createWorkspaceBanner } from '../src/ui/workspace';
import { installFakeBrowser, type FakeNode } from './fake-dom';

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const GUEST_KEY = 'driftboard:guest-session';
const themeRgb = (color: string) => color.match(/[\da-f]{2}/gi)!.map((part) => Number.parseInt(part, 16));
const themeMix = (first: string, second: string, amount: number) => themeRgb(first).map((channel, index) => channel * amount + themeRgb(second)[index] * (1 - amount));
const themeLuminance = (color: number[]) => {
  const linear = (part: number) => { const value = part / 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * linear(color[0]) + 0.7152 * linear(color[1]) + 0.0722 * linear(color[2]);
};
const themeContrast = (first: number[], second: number[]) => {
  const a = themeLuminance(first), b = themeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};
const activeGuest = (guestId = 'guest_1', expiresAt = Date.now() + 60_000): GuestJoin => ({
  boardId: 'b1', guestId, name: 'Visitor', role: 'editor', expiresAt,
});

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

class FakeEl {
  dataset: Record<string, string> = {};
  style = { setProperty() {} };
  classList = { add() {}, remove() {}, toggle() {} };
  className = '';
  nextSibling = null;
  firstChild = null;
  innerHTML = '';
  append() {}
  appendChild() {}
  insertBefore() {}
  remove() {}
  setAttribute() {}
  setPointerCapture() {}
  querySelector() { return new FakeEl(); }
  getBoundingClientRect() { return { width: 1600, height: 1200, left: 0, top: 0 }; }
  getContext() { return null; }
}

type AppHarness = BoardApp & Record<string, unknown>;

function boardHarness(store: Store, comments: Comments) {
  const r = new Renderer(store, new FakeEl() as unknown as HTMLElement);
  r.setCamera({ x: 0, y: 0, zoom: 1 });
  const app = Object.create(BoardApp.prototype) as AppHarness;
  Object.assign(app, {
    store, r, selection: [], scope: null, tool: { kind: 'select' }, drag: null, longPress: null, pendingFrame: 0, queuedFn: null,
    kbMoving: null, cursorTimer: 1, listeners: new Map(), spaceDown: false,
    lastPointer: { x: 240, y: 180 }, clipboard: [], user: { id: 'guest_1', name: 'Visitor', color: '#326DD3' },
    notify() {}, announce() {}, emit() {},
    conn: { comments, awareness: { setLocalStateField() {}, getStates: () => new Map(), clientID: 1 } },
    editor: { active: false, commit() {}, start() {} },
    cardInput: { active: false, start() {}, stop() {} },
    flow: { handleClick: () => false, isHidden: () => false, isVoting: () => false, activeStep: () => null },
    isPinching: () => false,
  });
  return app;
}

beforeEach(() => {
  vi.stubGlobal('document', { createElement: () => new FakeEl(), createElementNS: () => new FakeEl(), activeElement: null });
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('window', { setTimeout, clearTimeout });
});

afterEach(() => {
  setSignedOut();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('guest expiry and relay refusal', () => {
  it('keeps the denied status above AA contrast in every dark theme', () => {
    for (const theme of THEMES.filter((candidate) => candidate.scheme === 'dark')) {
      const foreground = themeMix(theme.vars['--danger'], theme.vars['--tray-text'], 0.70);
      const background = themeMix(theme.vars['--tray-text'], theme.vars['--canvas'], 0.08);
      expect(themeContrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('keeps an expired guest terminal across an offline reload', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const session = storage();
    session.setItem(GUEST_KEY, JSON.stringify(activeGuest('guest_1', NOW - 1)));
    vi.stubGlobal('sessionStorage', session);
    vi.stubGlobal('localStorage', storage());

    const result = await initAuth({ config: async () => { throw new Error('offline'); }, me: async () => ({}) as never });

    expect(result).toMatchObject({ mode: 'guest', guest: { boardId: 'b1', guestId: 'guest_1', ended: true } });
    expect(JSON.parse(session.getItem(GUEST_KEY) ?? 'null')).toMatchObject({ ended: true });
    expect(guestAccessEnded(result, null, NOW)).toBe(true);
  });

  it('keeps a valid guest editable after a transient identity refresh failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const session = storage();
    session.setItem(GUEST_KEY, JSON.stringify(activeGuest()));
    vi.stubGlobal('sessionStorage', session);
    vi.stubGlobal('localStorage', storage());

    const result = await initAuth({ config: async () => ({ authEnabled: true }) as never, me: async () => { throw new Error('temporary failure'); } });

    expect(result).toMatchObject({ mode: 'guest', guest: { guestId: 'guest_1' } });
    expect((result.mode === 'guest' && result.guest.ended) ?? false).toBe(false);
    expect(guestAccessEnded(result, null, NOW)).toBe(false);
  });

  it('keeps a terminal guest when the identity refresh fails with a server error', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const session = storage();
    session.setItem(GUEST_KEY, JSON.stringify({ ...activeGuest(), ended: true }));
    vi.stubGlobal('sessionStorage', session);
    vi.stubGlobal('localStorage', storage());

    const result = await initAuth({ config: async () => ({ authEnabled: true }) as never, me: async () => { throw new ApiError(500, 'internal', 'internal'); } });

    expect(result).toMatchObject({ mode: 'guest', guest: { guestId: 'guest_1', ended: true } });
  });

  it.each([false, true])('clears a stored guest and opens the board when auth is disabled (ended: %s)', async (ended) => {
    const session = storage();
    session.setItem(GUEST_KEY, JSON.stringify({ ...activeGuest(), ...(ended ? { ended: true } : {}) }));
    vi.stubGlobal('sessionStorage', session);
    vi.stubGlobal('localStorage', storage());

    const result = await initAuth({ config: async () => ({ authEnabled: false }) as never, me: async () => ({}) as never });

    expect(result).toEqual({ mode: 'open' });
    expect(session.getItem(GUEST_KEY)).toBeNull();
  });

  it('makes an unauthorized guest refresh terminal instead of dropping guest identity', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const session = storage();
    session.setItem(GUEST_KEY, JSON.stringify(activeGuest()));
    vi.stubGlobal('sessionStorage', session);
    vi.stubGlobal('localStorage', storage());

    const result = await initAuth({ config: async () => ({ authEnabled: true }) as never, me: async () => { throw new ApiError(401, 'unauthenticated', 'ended'); } });

    expect(result).toMatchObject({ mode: 'guest', guest: { guestId: 'guest_1', ended: true } });
    expect(guestAccessEnded(result, null, NOW)).toBe(true);
  });

  it('persists a relay removal and restores that terminal guest after an offline reload', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const session = storage();
    vi.stubGlobal('sessionStorage', session);
    vi.stubGlobal('localStorage', storage());
    setGuest(activeGuest('guest_revoked', NOW + 60_000));

    expect(markGuestSessionEnded('guest_revoked')).toBe(true);
    const result = await initAuth({ config: async () => { throw new Error('offline'); }, me: async () => ({}) as never });

    expect(result).toMatchObject({ mode: 'guest', guest: { guestId: 'guest_revoked', ended: true } });
    expect(JSON.parse(session.getItem(GUEST_KEY) ?? 'null')).toMatchObject({ guestId: 'guest_revoked', ended: true });
  });

  it('keeps a revoked guest read-only after reload when the identity request returns 401', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const session = storage();
    session.setItem(GUEST_KEY, JSON.stringify({ ...activeGuest('guest_revoked'), ended: true }));
    vi.stubGlobal('sessionStorage', session);
    vi.stubGlobal('localStorage', storage());

    const result = await initAuth({
      config: async () => ({ authEnabled: true }) as never,
      me: async () => { throw new ApiError(401, 'unauthenticated', 'ended'); },
    });
    const store = new Store(new Y.Doc());
    const comments = new Comments(new Y.Doc());

    applyConnectionAccess({ store, comments }, boardAccess('editor', null), result, null, NOW);

    expect(result).toMatchObject({ mode: 'guest', guest: { guestId: 'guest_revoked', ended: true } });
    expect(store.readOnly).toBe(true);
    expect(comments.readOnly()).toBe(true);
  });

  it.each(['unauthenticated', 'no_access', 'access_removed'] as const)('classifies a known guest after a %s denial only', (reason) => {
    const guest = { mode: 'guest' as const, guest: activeGuest() };
    expect(guestAccessEnded(guest, reason)).toBe(true);
    expect(guestAccessEnded({ mode: 'open' }, reason)).toBe(false);
  });

  it('does not carry an old connection denial into a successful new guest join', () => {
    const first = activeGuest('guest_1');
    const second = activeGuest('guest_2');
    setGuest(first);
    expect(markGuestSessionEnded(first.guestId)).toBe(true);
    setGuest(second);

    expect(authState()).toMatchObject({ mode: 'guest', guest: { guestId: 'guest_2' } });
    expect(denialForGuestSession(first.guestId, authState(), 'access_removed')).toBeNull();
    expect(guestAccessEnded(authState(), denialForGuestSession(first.guestId, authState(), 'access_removed'))).toBe(false);
    expect(markGuestSessionEnded(first.guestId)).toBe(false);
  });

  it('keeps signed-in board access unchanged when the relay refuses a connection', () => {
    setSignedIn({ user: { id: 'u1', email: 'u@example.test', name: 'User', role: 'member' }, teams: [] });
    const access = applyConnectionAccess(
      { store: new Store(new Y.Doc()), comments: new Comments(new Y.Doc()) },
      boardAccess('editor', null), authState(), 'access_removed', NOW,
    );
    expect(access).toMatchObject({ storeReadOnly: false, commentsReadOnly: false });
  });

  it('locks the live board and comments on access_removed before attempted edits can change either Y.Doc', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal('localStorage', storage());
    const guest = activeGuest('guest_1', NOW + 60_000);
    setGuest(guest);
    const boardDoc = new Y.Doc();
    const commentsDoc = new Y.Doc();
    const store = new Store(boardDoc);
    const comments = new Comments(commentsDoc);
    store.transact(() => store.create({
      id: 'seed', type: 'shape', kind: 'rect', x: 10, y: 20, w: 100, h: 60, rotation: 0, z: 'a0',
    }));
    store.undo.clear();
    const app = boardHarness(store, comments);
    const boardBefore = Y.encodeStateVector(boardDoc);
    const commentsBefore = Y.encodeStateVector(commentsDoc);
    const boardUpdates = vi.fn<() => void>();
    const commentUpdates = vi.fn<() => void>();
    boardDoc.on('update', boardUpdates);
    commentsDoc.on('update', commentUpdates);
    let denied: 'access_removed' | null = null;
    const denialListener: { fn: ((reason: 'access_removed') => void) | null } = { fn: null };
    const conn = { onDenied: (fn: (reason: 'access_removed') => void) => {
      denialListener.fn = (reason) => { denied = reason; fn(reason); };
      return () => { denialListener.fn = null; };
    } };
    const apply = () => applyConnectionAccess(
      { store, comments }, boardAccess('editor', null), authState(), denialForGuestSession(guest.guestId, authState(), denied), NOW,
    );
    const unwatch = watchGuestAccess(conn, guest.guestId, apply);
    const initialAccess = apply();
    expect(initialAccess.storeReadOnly).toBe(false);
    expect(store.readOnly).toBe(false);
    denialListener.fn?.('access_removed');
    expect(store.readOnly).toBe(true);
    expect(comments.readOnly()).toBe(true);
    app.pasteText('must not be added');
    app.setTool({ kind: 'sticky' });
    store.setMeta({ name: 'must not be saved' });
    store.transact(() => store.update('seed', { x: 999 }));
    const thread = comments.addThread({ id: 'guest_1', name: 'Visitor', color: '#326DD3' }, { x: 40, y: 40 }, 'must not be posted');

    expect(store.readOnly).toBe(true);
    expect(comments.readOnly()).toBe(true);
    expect(app.tool).toEqual({ kind: 'select' });
    expect(store.cache.size).toBe(1);
    expect(store.get('seed')?.x).toBe(10);
    expect(store.getMeta().name).toBe('Untitled board');
    expect(thread).toBeNull();
    expect(boardUpdates).not.toHaveBeenCalled();
    expect(commentUpdates).not.toHaveBeenCalled();
    expect(Y.encodeStateVector(boardDoc)).toEqual(boardBefore);
    expect(Y.encodeStateVector(commentsDoc)).toEqual(commentsBefore);
    expect(authState()).toMatchObject({ mode: 'guest', guest: { guestId: 'guest_1', ended: true } });
    unwatch();
  });

  it('marks a guest terminal at local expiry without waiting for relay status', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const guest = activeGuest('guest_timer', NOW + 1_000);
    setGuest(guest);
    const conn = { onDenied: (_fn: (reason: 'access_removed') => void) => () => {} };
    const unwatch = watchGuestAccess(conn, guest.guestId, vi.fn<() => void>());

    expect(guestAccessEnded(authState(), null)).toBe(false);
    vi.advanceTimersByTime(1_000);

    expect(authState()).toMatchObject({ mode: 'guest', guest: { guestId: 'guest_timer', ended: true } });
    expect(guestAccessEnded(authState(), null)).toBe(true);
    unwatch();
  });

  it('reconciles expiry immediately when a suspended tab receives focus', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const guest = activeGuest('guest_focus', NOW + 1_000);
    setGuest(guest);
    const focusListener: { fn: (() => void) | null } = { fn: null };
    vi.stubGlobal('window', {
      setTimeout, clearTimeout,
      addEventListener: (_name: string, fn: () => void) => { focusListener.fn = fn; },
      removeEventListener: () => { focusListener.fn = null; },
    });
    const conn = { onDenied: (_fn: (reason: 'access_removed') => void) => () => {} };
    const unwatch = watchGuestAccess(conn, guest.guestId, vi.fn());
    vi.setSystemTime(NOW + 1_000);

    focusListener.fn?.();

    expect(authState()).toMatchObject({ mode: 'guest', guest: { guestId: 'guest_focus', ended: true } });
    unwatch();
  });

  it('shows the exact view-only banner when the guest session becomes terminal', () => {
    const browser = installFakeBrowser();
    try {
      setGuest(activeGuest());
      const { el, dispose } = createWorkspaceBanner(undefined, () => guestAccessEnded(authState(), null) ? GUEST_ENDED_BANNER : null);
      browser.mount().appendChild(el as unknown as FakeNode);
      expect(el.hidden).toBe(true);

      markGuestSessionEnded('guest_1');

      expect(el.hidden).toBe(false);
      expect(el.textContent).toBe('This join link has expired. You can still look around, but not edit. Sign in');
      expect([GUEST_ENDED_SYNC_LABEL, GUEST_ENDED_SYNC_TIP]).toEqual([
        'Join link expired', 'This join link has expired or was revoked. Comments are read only.',
      ]);
      dispose();
    } finally {
      browser.uninstall();
    }
  });

  it('provides a sign-in path from a terminal guest banner after an identity 401', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const browser = installFakeBrowser();
    const session = storage();
    session.setItem(GUEST_KEY, JSON.stringify({ ...activeGuest(), ended: true }));
    vi.stubGlobal('sessionStorage', session);
    vi.stubGlobal('localStorage', storage());
    try {
      await initAuth({
        config: async () => ({ authEnabled: true }) as never,
        me: async () => { throw new ApiError(401, 'unauthenticated', 'ended'); },
      });
      const { el, dispose } = createWorkspaceBanner(undefined, () => guestAccessEnded(authState(), null, NOW) ? GUEST_ENDED_BANNER : null);
      browser.mount().appendChild(el as unknown as FakeNode);

      expect(el.hidden).toBe(false);
      expect(el.textContent).toContain(GUEST_ENDED_BANNER);
      expect(el.querySelector('a.workspace-banner-signin')?.getAttribute('href')).toBe('#/signin');
      const link = el.querySelector<HTMLAnchorElement>('a.workspace-banner-signin');
      expect(link?.textContent).toBe('Sign in');
      expect(link?.tagName).toBe('A');
      expect(authState().mode).toBe('guest');
      link?.click();
      expect(authState()).toEqual({ mode: 'signed-out' });
      expect(session.getItem(GUEST_KEY)).toBeNull();
      expect(browser.location.hash).toBe('#/signin');
      expect(resolveRoute(browser.location.hash, authState().mode)).toEqual({ name: 'signin' });
      dispose();
    } finally {
      browser.uninstall();
    }
  });
});
