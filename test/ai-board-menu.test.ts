import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiBarShown } from '../src/ui/ai-bar';
import { control, installFakeBrowser, textOf, type FakeBrowser, type FakeElement } from './fake-dom';

const mocks = vi.hoisted(() => ({
  props: vi.fn<(...args: unknown[]) => unknown>(),
  library: vi.fn<(...args: unknown[]) => unknown>(),
  role: 'member' as 'member' | 'admin' | 'owner',
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
vi.mock('../src/ui/side-tray', () => ({ mountSideTray: vi.fn<() => Record<string, never>>(() => ({})) }));
vi.mock('../src/ui/comments', () => ({ mountComments: vi.fn<() => { button: HTMLElement }>(() => ({ button: document.createElement('button') })) }));
vi.mock('../src/ui/group-ui', () => ({ mountGroupUI: vi.fn<(...args: unknown[]) => void>() }));
vi.mock('../src/ui/focus', () => ({ mountFocus: vi.fn<(...args: unknown[]) => void>(), mutedCount: vi.fn<() => number>(() => 0), openMuted: vi.fn<(...args: unknown[]) => void>() }));
vi.mock('../src/ui/flowbar', () => ({ mountFlowBar: vi.fn<(...args: unknown[]) => void>(), openVoteSetup: vi.fn<(...args: unknown[]) => void>(), startVote: vi.fn<(...args: unknown[]) => void>() }));
vi.mock('../src/ui/panel-top', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ui/panel-top')>()),
  trackPanelTop: vi.fn<(...args: unknown[]) => void>(),
}));
vi.mock('../src/auth', () => ({
  authState: () => ({ mode: 'signed-in', me: { user: { id: 'u1', name: 'Johan', email: 'johan@example.test', role: mocks.role }, mcp: null, chat: null } }),
  chatAvailable: () => false,
  imagesAvailable: () => false,
  onAuth: () => () => undefined,
  setSignedIn: vi.fn<(...args: unknown[]) => void>(),
  setSignedOut: vi.fn<(...args: unknown[]) => void>(),
  signOut: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
}));
vi.mock('../src/cloud-logic', () => ({ boardAccess: () => ({ badge: null }), workspaceOf: () => null }));

let browser: FakeBrowser | undefined;

afterEach(() => {
  browser?.uninstall();
  browser = undefined;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function prepareBoard(role: 'member' | 'admin' | 'owner') {
  browser = installFakeBrowser();
  const root = browser.mount();
  const cursorLayer = browser.document.createElement('div');
  root.appendChild(cursorLayer);
  mocks.role = role;
  vi.stubGlobal('devicePixelRatio', 1);
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 1; });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  mocks.props.mockImplementation(() => {
    const el = document.createElement('aside');
    return { el, toggle: vi.fn<() => void>(), isOpen: () => false, onToggle: () => undefined };
  });
  mocks.library.mockImplementation(() => ({ tab: null, open: vi.fn<(...args: unknown[]) => void>(), onChange: vi.fn<(...args: unknown[]) => void>() }));

  const listeners = new Map<string, (() => void)[]>();
  const app = {
    store: {
      getMeta: () => ({ name: 'Test board', gridType: 'dots', gridSize: 24 }),
      setMeta: vi.fn<(...args: unknown[]) => void>(),
      cache: new Map(), get: () => undefined, shown: () => [], onReadOnly: () => () => undefined,
    },
    conn: { id: 'board', status: 'live', denied: null, onAiRuns: () => () => undefined },
    participants: (): { clientId: number; user: { id: string; name: string; color: string; guest?: boolean }; isMe: boolean }[] => [],
    on: (event: string, fn: () => void) => { listeners.set(event, [...(listeners.get(event) ?? []), fn]); return () => undefined; },
    r: { root, cursorLayer, onCamera: () => () => undefined, contentBounds: () => null, svg: { addEventListener: () => undefined, removeEventListener: () => undefined, contains: () => false } },
    flow: { isVoting: () => false },
    tool: { kind: 'select' }, selection: [] as string[], selected: () => [], selectedLeaves: () => [],
    dragging: false, editor: { active: false }, readOnly: false, onDestroy: () => undefined,
    comments: { readOnly: () => false, onReadOnly: () => () => undefined },
    lifetime: { signal: new AbortController().signal }, role, deleted: false, commentsVisible: false, toggleChat: null,
    user: { id: 'u1', name: 'Johan', color: '#2F6FED' },
  };
  const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
    enabled: true, features: ['generate', 'summarise', 'cluster'], keySource: null, provider: null, model: 'claude-haiku-5-5',
    personalKeys: false, hasSecret: true, myKey: null, credits: false,
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  const emit = (event: string) => listeners.get(event)?.forEach((listener) => listener());
  return { root, app, fetchMock, emit };
}

describe('board AI entry points without a key or credits', () => {
  it('adapts the presence avatar cap from phones to wide screens while retaining the viewer and naming the remainder', async () => {
    const { root, app, emit } = prepareBoard('member');
    const guestsAndPeople = Array.from({ length: 11 }, (_, index) => ({
      clientId: index + 1,
      user: { id: `person-${index + 1}`, name: index === 1 ? 'Guest' : `Person ${index + 1}`, color: '#D64545', ...(index === 1 ? { guest: true } : {}) },
      isMe: false,
    }));
    app.participants = () => [...guestsAndPeople, { clientId: 100, user: { id: 'u1', name: 'Johan', color: '#2F6FED' }, isMe: true }];
    const visualWindow = window as unknown as { innerWidth: number };
    visualWindow.innerWidth = 390;
    const { mountBoardUi } = await import('../src/ui/board');
    mountBoardUi(app as never, root as unknown as HTMLElement, { home: () => undefined });

    const allAvatars = () => root.querySelectorAll('.people .avatar') as FakeElement[];
    const peopleAvatars = () => allAvatars().filter((avatar) => !avatar.className.split(/\s+/).includes('more'));
    const overflow = () => allAvatars().find((avatar) => avatar.className.split(/\s+/).includes('more'));
    const tray = root.querySelector('.top-right') as FakeElement;
    let sixAvatarsFit = false;
    Object.defineProperties(tray, {
      clientWidth: { configurable: true, get: () => visualWindow.innerWidth - 24 },
      scrollWidth: { configurable: true, get: () => visualWindow.innerWidth - 24 + (sixAvatarsFit ? 0 : 2) },
      getBoundingClientRect: { configurable: true, value: () => ({ left: 12, top: 72, right: visualWindow.innerWidth - 12, bottom: 120, width: visualWindow.innerWidth - 24, height: 48 }) },
    });
    const expectPresence = (limit: number, remainder: number) => {
      expect(peopleAvatars().length).toBe(limit);
      expect(peopleAvatars()[0].getAttribute('aria-label')).toContain('(you)');
      expect(overflow()?.textContent).toBe(`+${remainder}`);
      expect(overflow()?.getAttribute('aria-label')).toBe(`${remainder} more people here`);
    };

    for (const [width, limit] of [[320, 1], [360, 1], [379, 1], [380, 2], [390, 2], [479, 2], [480, 3], [500, 3], [1199, 3], [1200, 3], [1440, 3]] as const) {
      visualWindow.innerWidth = width;
      emit('presence');
      expectPresence(limit, 12 - limit);
    }

    sixAvatarsFit = true;
    visualWindow.innerWidth = 500;
    emit('presence');
    expectPresence(6, 6);
    expect(Boolean(peopleAvatars()[2].querySelector('.avatar-guest'))).toBe(true);
  });

  it.each(['member', 'admin', 'owner'] as const)('shows no AI controls or menu entry to a %s', async (role) => {
    const { root, app, fetchMock } = prepareBoard(role);
    const { mountBoardUi } = await import('../src/ui/board');
    mountBoardUi(app as never, root as unknown as HTMLElement, { home: () => undefined });
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input) === '/api/ai/config')).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(root.querySelector('.aibar')).toBeNull();
    expect(root.querySelector('.aibar-fab')).toBeNull();
    expect(aiBarShown()).toBe(false);
    const hint = root.querySelector('.empty-hint') as FakeElement | null;
    expect(hint?.querySelector('.ailive-generate')?.hidden).toBe(true);

    control(root, 'Menu').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const menu = browser!.document.body.querySelector('.menu') as FakeElement | null;
    expect(menu).not.toBeNull();
    expect(textOf(menu)).not.toContain('Set up AI');
    expect(menu!.querySelectorAll('.menu-item').some((item) => /Set up AI|Summarise/.test(textOf(item)))).toBe(false);
    const shortcuts = menu!.querySelectorAll('.menu-item').find((item) => textOf(item) === 'Keyboard shortcuts');
    expect(shortcuts).toBeDefined();
    shortcuts!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const dialog = browser!.document.body.querySelector('[role="dialog"]') as FakeElement | null;
    expect(textOf(dialog)).not.toContain('Ask AI');
  });

  it('puts the User guide first in the menu, as a quiet accent on the same button', async () => {
    const { root, app } = prepareBoard('member');
    const { mountBoardUi } = await import('../src/ui/board');
    mountBoardUi(app as never, root as unknown as HTMLElement, { home: () => undefined });
    await new Promise((resolve) => setTimeout(resolve, 0));
    control(root, 'Menu').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const menu = browser!.document.body.querySelector('.menu') as FakeElement;
    const items = menu.querySelectorAll('.menu-item');
    expect(textOf(items[0])).toContain('User guide');
    expect(items[0].className).toContain('guide-item');
    expect(items[0].tagName.toLowerCase()).toBe('button');
    // nothing before it, not even the account block
    expect(menu.children[0]).toBe(items[0]);
    expect(items.filter((item) => textOf(item).includes('User guide'))).toHaveLength(1);
  });
});
