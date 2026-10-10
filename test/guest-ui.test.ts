import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Y from 'yjs';
import { BoardApp } from '../src/app';
import { Comments, type Author } from '../src/comments';
import type { BoardApp as BoardAppType } from '../src/app';
import { control, FakeElement, installFakeBrowser, need, textOf, type FakeBrowser } from './fake-dom';

const mocks = vi.hoisted(() => ({
  props: vi.fn<(...args: unknown[]) => unknown>(),
  library: vi.fn<(...args: unknown[]) => unknown>(),
  role: 'member' as 'member' | 'admin' | 'owner',
  authMode: 'signed-in' as 'signed-in' | 'guest',
}));

vi.mock('../src/ui/props', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ui/props')>()),
  mountProps: (...args: unknown[]) => mocks.props(...args),
}));
vi.mock('../src/ui/library', () => ({
  mountLibrary: (...args: unknown[]) => mocks.library(...args),
  openMermaidImport: vi.fn<(...args: unknown[]) => void>(),
}));
vi.mock('../src/ui/layers', () => ({ bindLayersKey: vi.fn<(...args: unknown[]) => void>() }));
vi.mock('../src/ui/comments', () => ({ mountComments: vi.fn<() => { button: HTMLButtonElement }>(() => ({ button: document.createElement('button') })) }));
vi.mock('../src/ui/group-ui', () => ({ mountGroupUI: vi.fn<(...args: unknown[]) => void>() }));
vi.mock('../src/ui/focus', () => ({ mountFocus: vi.fn<(...args: unknown[]) => void>(), mutedCount: vi.fn<() => number>(() => 0), openMuted: vi.fn<(...args: unknown[]) => void>() }));
vi.mock('../src/ui/flowbar', () => ({ mountFlowBar: vi.fn<(...args: unknown[]) => void>(), openVoteSetup: vi.fn<(...args: unknown[]) => void>(), startVote: vi.fn<(...args: unknown[]) => void>() }));
vi.mock('../src/ui/panel-top', () => ({ trackPanelTop: vi.fn<(...args: unknown[]) => void>() }));
vi.mock('../src/auth', () => ({
  authState: () => mocks.authMode === 'guest'
    ? { mode: 'guest', guest: { boardId: 'board', guestId: 'guest_1', name: 'Johan', role: 'editor', expiresAt: Date.now() + 60_000 } }
    : { mode: 'signed-in', me: { user: { id: 'u1', name: 'Johan', email: 'johan@example.test', role: mocks.role }, mcp: null, chat: null } },
  chatAvailable: () => false,
  imagesAvailable: () => false,
  onAuth: () => () => undefined,
  setSignedIn: vi.fn<(...args: unknown[]) => void>(),
  setSignedOut: vi.fn<(...args: unknown[]) => void>(),
  signOut: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
}));
vi.mock('../src/cloud-logic', () => ({ boardAccess: () => ({ badge: null }), workspaceOf: () => null }));

let browser: FakeBrowser | undefined;
const cleanups: (() => void)[] = [];

beforeEach(() => {
  browser = installFakeBrowser();
  vi.stubGlobal('Element', FakeElement);
  vi.stubGlobal('devicePixelRatio', 1);
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 1; });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  mocks.role = 'member';
  mocks.authMode = 'signed-in';
  mocks.props.mockImplementation(() => {
    const el = document.createElement('aside');
    return { el, toggle: vi.fn<() => void>(), isOpen: () => false, onToggle: () => undefined };
  });
  mocks.library.mockImplementation(() => ({ tab: null, open: vi.fn<(...args: unknown[]) => void>(), onChange: vi.fn<(...args: unknown[]) => void>() }));
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  browser?.uninstall();
  browser = undefined;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function prepareBoard(authMode: 'signed-in' | 'guest') {
  mocks.authMode = authMode;
  const root = browser!.mount();
  const cursorLayer = browser!.document.createElement('div');
  root.appendChild(cursorLayer);
  const listeners = new Map<string, (() => void)[]>();
  const app = {
    store: {
      getMeta: () => ({ name: 'Test board', gridType: 'dots', gridSize: 24 }),
      setMeta: vi.fn<(...args: unknown[]) => void>(),
      cache: new Map(), get: () => undefined, shown: () => [], onReadOnly: () => () => undefined,
    },
    conn: { id: 'board', status: 'live', denied: null, onAiRuns: () => () => undefined },
    participants: () => [],
    on: (event: string, fn: () => void) => { listeners.set(event, [...(listeners.get(event) ?? []), fn]); return () => undefined; },
    r: { root, cursorLayer, onCamera: () => () => undefined, contentBounds: () => null, svg: { addEventListener: () => undefined, removeEventListener: () => undefined, contains: () => false } },
    flow: { isVoting: () => false },
    tool: { kind: 'select' }, selection: [] as string[], selected: () => [], selectedLeaves: () => [],
    dragging: false, editor: { active: false }, readOnly: false, onDestroy: () => undefined,
    comments: { readOnly: () => false, onReadOnly: () => () => undefined },
    lifetime: { signal: new AbortController().signal }, role: 'member', deleted: false, commentsVisible: false, toggleChat: null,
    user: { id: authMode === 'guest' ? 'guest_1' : 'u1', name: 'Johan', color: '#2F6FED' },
  };
  const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
    enabled: true, features: [], keySource: null, provider: null, model: 'test', personalKeys: false, hasSecret: false, myKey: null, credits: false,
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  return { root, app, fetchMock };
}

describe('guest board UI', () => {
  it.each([
    { authMode: 'guest' as const, visible: false },
    { authMode: 'signed-in' as const, visible: true },
  ])('shows profile and template menu actions only when available to a $authMode user', async ({ authMode, visible }) => {
    const { root, app } = prepareBoard(authMode);
    const { mountBoardUi } = await import('../src/ui/board');
    mountBoardUi(app as never, root as unknown as HTMLElement, { home: () => undefined });

    const shareButton = root.querySelectorAll('button').find((button) => textOf(button) === 'Share');
    expect(!!shareButton).toBe(visible);
    control(root, 'Menu').click();
    const menu = browser!.document.body.querySelector('.menu') as FakeElement | null;
    expect(menu).not.toBeNull();
    const labels = menu!.querySelectorAll('.menu-item').map(textOf);
    expect(labels.some((label) => label.includes('Your name and colour'))).toBe(visible);
    expect(labels.some((label) => label.includes('Save board as template'))).toBe(visible);
  });

  it('marks guest cursor labels with the shared Guest badge and leaves member labels unmarked', () => {
    const cursorLayer = browser!.document.createElement('div');
    browser!.document.body.appendChild(cursorLayer);
    type Cursor = { id: number; name: string; guest: boolean; color: string; p: { x: number; y: number } };
    type Harness = BoardAppType & { cursorEls: Map<number, HTMLDivElement> };
    const app = Object.assign(Object.create(BoardApp.prototype) as Harness, {
      cursorEls: new Map<number, HTMLDivElement>(),
      r: { cursorLayer, toScreen: (p: { x: number; y: number }) => ({ x: p.x, y: p.y }) },
    });
    const render = Reflect.get(BoardApp.prototype, 'renderCursors') as (this: Harness, cursors: Cursor[]) => void;
    render.call(app, [
      { id: 2, name: 'Sam', guest: true, color: '#2F6FED', p: { x: 10, y: 20 } },
      { id: 3, name: 'Sam', guest: false, color: '#D64545', p: { x: 30, y: 40 } },
    ]);

    const cursors = cursorLayer.querySelectorAll('.remote-cursor');
    expect(cursors).toHaveLength(2);
    const guest = cursors.find((el) => el.querySelector('.remote-cursor-name')?.textContent === 'Sam'
      && el.querySelector('.comment-guest') !== null)!;
    const member = cursors.find((el) => el.style.color === '#D64545')!;
    expect(need(guest, '.remote-cursor-name').textContent).toBe('Sam');
    expect(need(guest, '.remote-cursor-guest').textContent).toBe('Guest');
    expect(member.querySelector('.comment-guest')).toBeNull();
  });

  it('keeps remote cursor label presentation in CSS', () => {
    const cursorLayer = browser!.document.createElement('div');
    browser!.document.body.appendChild(cursorLayer);
    type Cursor = { id: number; name: string; guest: boolean; color: string; p: { x: number; y: number } };
    type Harness = BoardAppType & { cursorEls: Map<number, HTMLDivElement> };
    const app = Object.assign(Object.create(BoardApp.prototype) as Harness, {
      cursorEls: new Map<number, HTMLDivElement>(),
      r: { cursorLayer, toScreen: (p: { x: number; y: number }) => ({ x: p.x, y: p.y }) },
    });
    const render = Reflect.get(BoardApp.prototype, 'renderCursors') as (this: Harness, cursors: Cursor[]) => void;
    render.call(app, [
      { id: 2, name: 'Sam', guest: true, color: '#2F6FED', p: { x: 10, y: 20 } },
      { id: 3, name: 'Alex', guest: false, color: '#D64545', p: { x: 30, y: 40 } },
    ]);

    const guest = cursorLayer.querySelectorAll('.remote-cursor').find((el) => el.style.color === '#2F6FED')!;
    const label = need(guest, '.remote-cursor-label');
    const name = need(label, '.remote-cursor-name');
    const badge = need(label, '.remote-cursor-guest');
    const member = cursorLayer.querySelectorAll('.remote-cursor').find((el) => el.style.color === '#D64545')!;

    expect(label.className).toBe('remote-cursor-label');
    expect(name.className).toBe('remote-cursor-name');
    expect(badge.classList.contains('comment-badge')).toBe(true);
    expect(badge.classList.contains('comment-guest')).toBe(true);
    expect(Object.keys(label.style)).toEqual([]);
    expect(Object.keys(name.style)).toEqual(['background']);
    expect(Object.keys(badge.style)).toEqual([]);
    expect(Object.keys(guest.style).sort()).toEqual(['color', 'transform']);
    for (const element of [label, name, badge]) {
      expect(element.style.margin).toBeUndefined();
      expect(element.style.borderRadius).toBeUndefined();
      expect(element.style.fontSize).toBeUndefined();
    }
    expect(label.style.display).toBeUndefined();
    expect(label.style.alignItems).toBeUndefined();
    expect(label.style.gap).toBeUndefined();
    expect(name.style.background).toBe('#2F6FED');
    expect(badge.style.color).toBeUndefined();
    expect(guest.style.color).toBe('#2F6FED');
    expect(member.style.color).toBe('#D64545');

    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    expect(css).toMatch(/@media \(forced-colors: active\) \{[^}]*\.remote-cursor-name, \.remote-cursor-guest, \.comment-avatar[^}]*forced-color-adjust: none;/);
  });

  it('marks guest comments in the tray even when a member has the same name', async () => {
    mocks.authMode = 'signed-in';
    const actual = await vi.importActual<typeof import('../src/ui/comments')>('../src/ui/comments');
    const { mountSideTray } = await import('../src/ui/side-tray');
    const chromeElement = browser!.document.createElement('div');
    browser!.document.body.appendChild(chromeElement);
    const chrome = chromeElement as unknown as HTMLElement;
    const comments = new Comments(new Y.Doc());
    const guestAuthor: Author = { id: 'guest_session123', name: 'Visual QA', color: '#2F6FED' };
    const memberAuthor: Author = { id: 'user_456', name: 'Visual QA', color: '#D64545' };
    comments.addThread(guestAuthor, { x: 100, y: 100 }, 'Guest root');
    comments.addThread(memberAuthor, { x: 200, y: 200 }, 'Member root');
    const app = {
      user: { id: 'viewer', name: 'Viewer', color: '#D64545' },
      role: 'owner', comments,
      r: { onCamera: () => () => undefined },
      openThreadId: null,
      onOpenComment: null as BoardAppType['onOpenComment'],
      visibleThreads: () => comments.list(), flyToThread: () => undefined,
      openThread: () => undefined, closeThread: () => undefined, setDraftPin: () => undefined,
      on: () => () => undefined,
    } as unknown as BoardAppType;
    const tray = mountSideTray(chrome);
    actual.mountComments(app, chrome, tray);
    tray.show('comments');
    cleanups.push(() => comments.doc.destroy());

    const rows = Array.from(tray.slot('comments').querySelectorAll('.comment-row'));
    const guestRow = rows.find((row) => row.textContent?.includes('Guest root'))!;
    const memberRow = rows.find((row) => row.textContent?.includes('Member root'))!;
    expect(guestRow.querySelector('.comment-guest')?.textContent).toBe('Guest');
    expect(memberRow.querySelector('.comment-guest')).toBeNull();
  });

  it('sets the guest identity flag before publishing the local board user', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    expect(main).toMatch(/if \(auth\.mode === 'guest'\) return \{\s*\.\.\.getUser\(\),\s*id: auth\.guest\.guestId,\s*name: auth\.guest\.name,\s*guest: true\s*\}/);
  });
});
