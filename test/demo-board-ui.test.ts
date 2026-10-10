import { afterEach, describe, expect, it, vi } from 'vitest';
import { control, installFakeBrowser, textOf, type FakeBrowser, type FakeElement } from './fake-dom';

const mocks = vi.hoisted(() => ({
  props: vi.fn<(...args: unknown[]) => unknown>(),
  library: vi.fn<(...args: unknown[]) => unknown>(),
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
vi.mock('../src/ui/panel-top', () => ({ trackPanelTop: vi.fn<(...args: unknown[]) => void>() }));
vi.mock('../src/auth', () => ({
  authState: () => ({ mode: 'open' }),
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

describe('demo board UI', () => {
  it('mounts the real menu and quickbar without workspace-only actions', async () => {
    browser = installFakeBrowser();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('devicePixelRatio', 1);
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 1; });
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });

    mocks.props.mockImplementation(() => {
      const el = document.createElement('aside');
      const listeners: (() => void)[] = [];
      return {
        el,
        toggle: vi.fn<() => void>(),
        isOpen: () => false,
        onToggle: (fn: () => void) => { listeners.push(fn); },
      };
    });
    let libraryTab: string | null = null;
    let libraryDrawer: FakeElement | null = null;
    const libraryListeners: ((tab: string | null) => void)[] = [];
    const openLibrary = vi.fn<(tab: string | null) => void>((tab) => {
      libraryTab = tab;
      if (libraryDrawer) {
        libraryDrawer.dataset.tab = tab ?? '';
        libraryDrawer.classList.toggle('show', !!tab);
      }
      libraryListeners.forEach((fn) => fn(tab));
    });
    mocks.library.mockImplementation((_app, parent) => {
      libraryDrawer = browser!.document.createElement('aside') as FakeElement;
      libraryDrawer.className = 'drawer tray';
      (parent as FakeElement).appendChild(libraryDrawer);
      return {
        get tab() { return libraryTab; },
        open: openLibrary,
        onChange: vi.fn<(fn: (tab: string | null) => void) => void>((fn) => { libraryListeners.push(fn); }),
      };
    });
    const currentDrawer = () => libraryDrawer as unknown as FakeElement;

    const listeners = new Map<string, (() => void)[]>();
    const obj = { id: 'sample-lane', type: 'lane' };
    const app = {
      store: {
        getMeta: () => ({ name: 'Demo board', gridType: 'dots', gridSize: 24 }),
        setMeta: vi.fn<(...args: unknown[]) => void>(),
        cache: new Map(),
        get: () => undefined,
        shown: () => [],
      },
      conn: { id: 'demo', status: 'local', denied: null },
      participants: () => [],
      on: (event: string, fn: () => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), fn]);
        return () => undefined;
      },
      r: { onCamera: () => () => undefined, contentBounds: () => null, svg: { addEventListener: () => undefined, removeEventListener: () => undefined, contains: () => false } },
      flow: { isVoting: () => false },
      tool: { kind: 'select' },
      selection: [] as string[],
      selected: (): { id: string; type: string }[] => [],
      selectedLeaves: () => [],
      dragging: false,
      editor: { active: false },
      readOnly: false,
      onDestroy: () => undefined,
      comments: { readOnly: () => false, onReadOnly: () => () => undefined },
      lifetime: { signal: new AbortController().signal },
      role: null,
      deleted: false,
      commentsVisible: false,
      toggleChat: null,
    };

    const { mountBoardUi } = await import('../src/ui/board');
    const root = browser.mount();
    mountBoardUi(app as never, root as unknown as HTMLElement, { home: () => undefined }, { demo: true });

    const menuButton = control(root, 'Menu');
    menuButton.click();
    const menu = browser.document.body.querySelector('.menu') as FakeElement | null;
    expect(menu).not.toBeNull();
    const menuText = textOf(menu);
    expect(menuText).not.toContain('User guide');
    expect(menuText).not.toContain('Save board as template');
    expect(menuText).not.toContain('Set up AI');
    for (const feature of ['Share', 'Chat', 'History']) {
      const row = menu?.querySelector(`[data-workspace-feature="${feature}"]`);
      expect(row).not.toBeNull();
      expect(textOf(row)).toContain('Available in a workspace');
    }
    const layerButton = menu!.querySelectorAll('button').find((button) => textOf(button).startsWith('Layers'));
    expect(layerButton).toBeDefined();
    layerButton!.click();

    app.selection = [obj.id];
    app.selected = () => [obj];
    for (const listener of listeners.get('selection') ?? []) listener();
    const quickbar = root.querySelector('.quickbar');
    expect(quickbar).not.toBeNull();
    expect(textOf(quickbar)).not.toContain('Save as template');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(root.querySelector('.aibar')).toBeNull();
    expect(root.querySelector('.aibar-fab')).toBeNull();
    expect(root.querySelector('.ailive')).toBeNull();
    expect(fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.includes('/api/ai/config'))).toEqual([]);

    const templatesButton = control(root, 'Templates and team exercises');
    templatesButton.click();
    const drawer = currentDrawer();
    expect(drawer.classList.contains('show')).toBe(true);
    expect(drawer.dataset.tab).toBe('templates');
    const closeEscapeDrawer = Reflect.get(app, 'closeEscapeDrawer') as (() => boolean) | null;
    expect(closeEscapeDrawer?.()).toBe(true);
    expect(drawer.classList.contains('show')).toBe(false);
    expect(browser.document.activeElement).toBe(templatesButton);
  });
});
