import './demo';
import { DEMO, installDemoGuards } from './demo';
import './styles.css';
import { BoardApp } from './app';
import { deleteBoard, getUser, openBoard, scratchBoard } from './sync';
import { mountBoardUi } from './ui/board';
import { loadTemplate, mountTemplateEditor, templateLeaveGuard } from './ui/template-edit';
import { mountAccessBanner } from './ui/access';
import { mountNewerBanner } from './ui/newer-banner';
import { cardContentHeight } from './markup';
import { watchFeatureGate } from './feature-gate';
import { renderHome, type HomeNav } from './ui/home';
import { renderTemplates } from './ui/templates-page';
import { renderChatPage } from './ui/chat-page';
import { mountMentionNotices } from './ui/mention-notice';
import { mountTitleBadge } from './ui/title-badge';
import { offerTemplateUpload } from './ui/template-upload';
import { renderInvite, renderSignIn, renderVerify } from './ui/signin';
import { onceForLocation } from './nav-dedupe';
import { renderJoin } from './ui/join';
import { renderAdmin } from './ui/admin';
import { showRestoring } from './ui/restoring';
import { loadCatalogue } from './fonts';
import { CUSTOM_PREFIX, TEMPLATES, insertCustomTemplate, insertTemplate } from './templates';
import { getTemplate } from './template-store';
import { mayChange } from './template-share';
import type { CustomTemplate } from './custom-templates';
import { applyImported, type ImportedBoard } from './exporters';
import { toast } from './ui/common';
import { commentNoticeText } from './comments';
import { applyTheme, getStoredTheme } from './themes';
import { ApiError, api, onRestoring, type ServerBoard } from './api';
import { authState, cacheServerBoards, chatAvailable, cachedServerBoards, initAuth, isHostedWorkspace, joinCodesAvailable, onAuth, refreshMeSoon, setDemoMode, startMeRefresh, type AuthState } from './auth';
import { boardAccess, createUnlockWatcher, workspaceOf } from './cloud-logic';
import { applyConnectionAccess, denialForGuestSession, GUEST_ENDED_BANNER, guestAccessEnded, watchGuestAccess } from './guest-access';
import { createWorkspaceBanner } from './ui/workspace';
import { installTooltips } from './ui/tooltip';
import {
  dispatchTrackerRoute,
  navigateTrackerPath,
  needsSignIn,
  onTrackerRoute,
  resolveRoute,
  resolvedTrackerDestination,
  returnDestination,
  safeReturnDestination,
} from './route';
import { isDesktop } from './desktop-env';
import type { Desktop } from './desktop';
import { seedDemo } from './demo/seed';
import { mountDemoBanner } from './ui/demo-banner';
import type { User } from './types';
import { createTrackerStore, createHttpTrackerApi, type TrackerApi, type TrackerStore } from './tracker-data';
import { mountTrackerShell, trackerViewerState } from './tracker/ui/shell';
import type { TrackerView } from './tracker-types';
import './ui/touch.css';

// `demo.ts` is evaluated before these imports so its storage/network shims protect module initializers too.
if (DEMO) installDemoGuards();
applyTheme(getStoredTheme());
installTooltips();
// Any answer of the server that says a restore is running (503 restoring) puts the restoring screen up.
if (!DEMO) onRestoring(() => showRestoring());

const RETURN_KEY = 'driftboard:return';

const root = document.getElementById('app')!;
const trackerFoundationVisual = !DEMO && import.meta.env.MODE === 'visual' && new URLSearchParams(location.search).get('debug') === 'tracker-foundation';
const trackerMockVisual = !DEMO && import.meta.env.MODE === 'visual' && new URLSearchParams(location.search).has('debug') && new URLSearchParams(location.search).get('trackerMock') === '1';
const trackerBoardMockVisual = !DEMO && import.meta.env.MODE === 'visual' && new URLSearchParams(location.search).has('debug') && new URLSearchParams(location.search).get('trackerMock') === 'board';
let current: BoardApp | null = null;
let releaseBanner: (() => void) | null = null;
let releaseWorkspace: (() => void) | null = null;
let pending: { id: string; template?: string; custom?: CustomTemplate; imported?: ImportedBoard } | null = null;
let registering = false;
let desktop: Desktop | null = null;
let routeSeq = 0;
let currentBoardId: string | null = null;
let preservedBoardId: string | null = null;
let trackerRouteApi: TrackerApi | null = null;
let trackerRouteStore: TrackerStore | null = null;
/** What to call when the page on screen is left (the Chat page closes its conversation and its listeners). */
let leavePage: (() => void) | null = null;
let demoOpened = false;

const demoUser: User = { id: 'tabula-demo', name: 'Demo user', color: '#2F6FED' };

function saveReturn(hash: string) {
  const target = returnDestination(hash, location.pathname, location.search);
  if (!target) return;
  try {
    sessionStorage.setItem(RETURN_KEY, target);
  } catch {
    /* storage is unavailable: sign-in then lands on the home screen */
  }
}

function takeReturn(): string {
  let saved: string | null = null;
  try {
    saved = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
  } catch {
    /* storage is unavailable */
  }
  return (saved && safeReturnDestination(saved)) || '#/';
}

/** Leaves the sign-in screens: drops the emailed token from the address bar and goes where the user was headed. */
function finishSignIn() {
  const target = takeReturn();
  if (target.startsWith('/')) {
    location.replace(target);
    return;
  }
  history.replaceState(null, '', location.pathname + location.search);
  location.hash = target;
}

async function refreshBoardCache() {
  try {
    cacheServerBoards(await api.boards());
  } catch {
    /* the cached list stays as it was */
  }
}

const isNewBoard = (id: string, opts: { template?: string; imported?: ImportedBoard; teamId?: string }) =>
  Boolean(opts.teamId || opts.template || opts.imported) || !cachedServerBoards().some((b) => b.id === id);

function trackerEnabled(auth: AuthState): boolean {
  return (auth.mode === 'signed-in' || auth.mode === 'offline') && auth.me?.tracker === true;
}

function replaceResolvedTrackerPath(target: import('./tracker-route').TrackerPathRoute, resolvedKey: string | undefined) {
  if (!resolvedKey) return;
  const path = resolvedTrackerDestination(target, resolvedKey);
  if (path && path !== location.pathname + location.search) history.replaceState(null, '', path);
}

function registerTrackerRouteHost(): () => void {
  return onTrackerRoute(async (target) => {
    if (target.kind === 'board-position') return;
    const auth = authState();
    if (!trackerEnabled(auth) && !trackerBoardMockVisual) return;
    const me = auth.mode === 'signed-in' || auth.mode === 'offline' ? auth.me : null;
    if (!me && !trackerBoardMockVisual) return;

    const viewerId = me?.user.id ?? 'visual-user';
    if (!trackerRouteApi) {
      if (trackerBoardMockVisual) {
        const [mock, seed] = await Promise.all([import('./tracker-mock'), import('./tracker/ui/visual-seed')]);
        trackerRouteApi = mock.createMockTrackerApi(seed.createTrackerVisualSeed());
      } else trackerRouteApi = createHttpTrackerApi();
    }
    trackerRouteStore ??= createTrackerStore(trackerRouteApi);
    const store = trackerRouteStore;
    const view = target.kind === 'ticket' ? 'all' : target.view === 'views' ? 'all' : target.view;
    const viewId = target.kind === 'view' ? target.id : undefined;
    const key = target.kind === 'ticket' ? target.key : null;
    const state = trackerViewerState(store, viewerId, 'workspace', view as TrackerView);
    state.tab = view as TrackerView;
    state.viewId = viewId ?? null;
    state.ticketKey = key;

    const host = document.createElement('div');
    host.className = 'trk-route-root';
    document.body.appendChild(host);
    const shell = mountTrackerShell(host, {
      store, api: trackerRouteApi, viewerId, trackerId: 'workspace', windowId: 'workspace',
      initialTab: view as TrackerView, initialViewId: viewId, initialTicketKey: key ?? undefined,
      fullScreen: true, boardName: 'Tracker', layoutWidth: window.innerWidth,
      onFullscreenChange: (fullScreen) => { if (!fullScreen) history.back(); },
      onTabChange: (tab, nextViewId) => {
        navigateTrackerPath(nextViewId
          ? { kind: 'view', view: tab === 'projects' ? 'projects' : 'views', id: nextViewId }
          : { kind: 'view', view: tab }, 'replace');
      },
      onTicketChange: (nextKey) => {
        if (nextKey) navigateTrackerPath({ kind: 'ticket', key: nextKey });
        else history.back();
      },
    });
    let resolvedKey: string | undefined;
    if (key) {
      try {
        const detail = await store.loadTicket(key, true);
        resolvedKey = detail.resolvedKey ?? detail.ticket.key;
      } catch {
        // The mounted shell renders the same missing or inaccessible state as a ticket opened from its list.
      }
    }
    return { ...(resolvedKey ? { resolvedKey } : {}), dispose: () => { shell.destroy(); host.remove(); } };
  });
}

const nav: HomeNav = {
  open: async (id, opts = {}) => {
    if (registering) return;
    let custom: CustomTemplate | undefined;
    if (opts.template?.startsWith(CUSTOM_PREFIX)) {
      custom = await getTemplate(opts.template.slice(CUSTOM_PREFIX.length));
      if (!custom) {
        toast('That template is no longer available.');
        return;
      }
    }
    if (authState().mode === 'signed-in' && isNewBoard(id, opts)) {
      registering = true;
      try {
        await api.createBoard({
          id,
          title: custom?.name ?? TEMPLATES.find((t) => t.id === opts.template)?.name ?? 'Untitled board',
          teamId: opts.teamId,
        });
      } catch (err) {
        toast(err instanceof ApiError && err.status !== 0 ? err.message : 'Could not reach the server. Try again.');
        return;
      } finally {
        registering = false;
      }
      refreshBoardCache();
    }
    pending = { id, ...opts, custom };
    location.hash = `#/b/${id}`;
  },
};

/** The user's role on a board in accounts mode; the last known list decides when the server cannot be reached. */
async function boardRole(id: string, auth: AuthState): Promise<ServerBoard['role'] | undefined> {
  if (auth.mode === 'guest') return auth.guest.boardId === id ? auth.guest.role : undefined;
  if (auth.mode !== 'signed-in' && auth.mode !== 'offline') return undefined;
  let list = cachedServerBoards();
  if (auth.mode === 'signed-in') {
    try {
      list = await api.boards();
      cacheServerBoards(list);
    } catch {
      /* offline or session ended: the cached list decides, the relay will say if access is gone */
    }
  }
  return list.find((b) => b.id === id)?.role;
}

/** The user as the board shows them: in accounts mode the account's name on this device's identity. */
function boardUser(auth: AuthState) {
  if (auth.mode === 'guest') return { ...getUser(), id: auth.guest.guestId, name: auth.guest.name, guest: true };
  const me = auth.mode === 'signed-in' || auth.mode === 'offline' ? auth.me : null;
  return me ? { ...getUser(), name: me.user.name } : getUser();
}

/** Edit a saved template on a scratch board: in memory only, no relay room, not stored with the boards. */
async function routeTemplateEdit(id: string, auth: AuthState, seq: number) {
  root.className = 'board-root';
  root.replaceChildren(Object.assign(document.createElement('div'), { className: 'loading', textContent: 'Opening template…' }));
  const tpl = await getTemplate(id);
  if (seq !== routeSeq) return;
  if (!tpl) {
    toast('That template is no longer available.');
    location.replace('#/templates');
    return;
  }
  if (!mayChange(tpl)) {
    toast('You cannot change that template. Duplicate it to edit your own copy.', 6000);
    location.replace('#/templates');
    return;
  }
  const user = boardUser(auth);
  const conn = scratchBoard(`template-${tpl.id}`, user);
  loadTemplate(conn.store, tpl, user.id);
  root.replaceChildren();
  const app = new BoardApp(conn, user, root, isHostedWorkspace(auth));
  current = app;
  if (!DEMO && location.search.includes('debug')) (window as unknown as { __board: BoardApp }).__board = app;
  mountTemplateEditor(app, root, tpl);
}

let shownHash = location.hash;

/**
 * Whether a board missing from the person's list is a deleted one. Only workspace admins can open those, and only
 * while online; the relay refuses their writes either way, so the board opens read-only instead of silently
 * dropping edits.
 */
async function isDeletedBoard(id: string, auth: AuthState, role: ServerBoard['role'] | undefined): Promise<boolean> {
  if (role !== undefined || auth.mode !== 'signed-in') return false;
  if (auth.me.user.role !== 'owner' && auth.me.user.role !== 'admin') return false;
  try {
    return (await api.adminBoard(id)).deletedAt !== null;
  } catch {
    return false;
  }
}

async function route() {
  if (DEMO) {
    if (location.hash !== '#/b/demo') {
      history.replaceState(null, '', `${location.pathname}${location.search}#/b/demo`);
    }
    if (demoOpened) return;
    demoOpened = true;
    root.className = 'board-root demo-board';
    root.replaceChildren();
    const conn = scratchBoard('demo', demoUser, false);
    const app = new BoardApp(conn, demoUser, root);
    current = app;
    seedDemo(app);
    app.store.undo.clear();
    app.store.undo.stopCapturing();
    mountBoardUi(app, root, { home: () => undefined }, { demo: true });
    mountDemoBanner(root);
    return;
  }

  // Leaving the template editor with unsaved changes: put the editor's address back and let it ask first.
  const leaving = templateLeaveGuard();
  if (leaving && location.hash !== shownHash && !leaving(location.hash)) {
    history.replaceState(null, '', shownHash || '#/');
    return;
  }
  shownHash = location.hash;
  const seq = ++routeSeq;
  const auth = authState();
  const r = resolveRoute(location.hash, auth.mode, location.pathname, location.search);
  const trackerScreen = r.name === 'tracker' && (trackerEnabled(auth) || trackerBoardMockVisual);
  const keepTrackerStore = trackerScreen;
  const preserveBoard = trackerScreen && current !== null && currentBoardId !== null;
  const restoreBoard = r.name === 'board' && current !== null && currentBoardId === r.id && preservedBoardId === r.id;
  if (preserveBoard) {
    preservedBoardId = currentBoardId;
    leavePage?.();
    leavePage = null;
  } else if (restoreBoard) {
    leavePage?.();
    leavePage = null;
    preservedBoardId = null;
    trackerRouteStore?.destroy();
    trackerRouteStore = null;
    trackerRouteApi = null;
  } else {
    releaseBanner?.();
    releaseBanner = null;
    releaseWorkspace?.();
    releaseWorkspace = null;
    current?.destroy();
    current = null;
    currentBoardId = null;
    preservedBoardId = null;
    leavePage?.();
    leavePage = null;
    if (!keepTrackerStore) {
      trackerRouteStore?.destroy();
      trackerRouteStore = null;
      trackerRouteApi = null;
    }
  }
  if (auth.mode === 'guest' && (r.name !== 'board' || r.id !== auth.guest.boardId)) {
    location.replace(`/#/b/${encodeURIComponent(auth.guest.boardId)}`);
    return;
  }
  if (r.name === 'join' && !joinCodesAvailable()) {
    location.replace('/');
    return;
  }
  if (needsSignIn(r, auth.mode)) {
    saveReturn(location.hash);
    location.replace('#/signin');
    return;
  }

  // Tracker paths share the same public app shell as boards. Feature access is decided from /api/me, and ticket
  // existence/access is left to the tracker data call so the shell never distinguishes those cases.
  if (r.name === 'tracker' && !trackerEnabled(auth) && !trackerBoardMockVisual) {
    root.className = 'home-root';
    renderHome(root, nav, auth);
    return;
  }

  if (r.name === 'tracker') {
    if (!preserveBoard) {
      root.className = 'home-root';
      root.replaceChildren();
    }
    try {
      const handled = await dispatchTrackerRoute(r.target);
      if (seq !== routeSeq) {
        handled?.dispose?.();
        return;
      }
      leavePage = handled?.dispose ?? null;
      replaceResolvedTrackerPath(r.target, handled?.resolvedKey);
    } catch {
      // The registered tracker screen owns its loading and access errors; the route stays a safe empty shell.
    }
    return;
  }

  if (r.name === 'admin') {
    const me = auth.mode === 'signed-in' || auth.mode === 'offline' ? auth.me : null;
    if (!me || (me.user.role !== 'owner' && me.user.role !== 'admin')) {
      location.replace('#/');
      return;
    }
    root.className = 'admin-root';
    renderAdmin(root, r.tab, me);
    return;
  }

  if (r.name === 'chat') {
    if (!chatAvailable()) {
      location.replace('#/');
      return;
    }
    root.className = 'home-root';
    leavePage = renderChatPage(root, { kind: r.kind, ref: r.ref });
    return;
  }

  if (r.name === 'template-edit') {
    await routeTemplateEdit(r.id, auth, seq);
    return;
  }

  if (r.name !== 'board') {
    root.className = 'home-root';
    const view = document.createElement('div');
    view.style.display = 'contents';
    root.replaceChildren(view);
    const finish = () => {
      if (seq === routeSeq) finishSignIn();
    };
    if (r.name === 'signin') renderSignIn(view);
    else if (r.name === 'verify') renderVerify(view, r.token, finish);
    else if (r.name === 'invite') renderInvite(view, r.token, auth, finish);
    else if (r.name === 'join') renderJoin(view, r.code, (guest) => {
      history.replaceState(null, '', `/#/b/${encodeURIComponent(guest.boardId)}`);
      void route();
    });
    else if (r.name === 'templates') renderTemplates(view, nav, auth);
    else renderHome(view, nav, auth);
    if (r.name === 'home' || r.name === 'templates') void offerTemplateUpload();
    return;
  }

  if (restoreBoard) {
    if (r.trackerPosition && (trackerEnabled(auth) || auth.mode === 'guest')) {
      const target = { kind: 'board-position' as const, boardId: r.id, ...r.trackerPosition };
      try {
        const handled = await dispatchTrackerRoute(target);
        if (seq !== routeSeq) { handled?.dispose?.(); return; }
        replaceResolvedTrackerPath(target, handled?.resolvedKey);
      } catch {
        // The restored board stays usable if the tracker frame cannot open.
      }
    }
    return;
  }

  const id = r.id;
  const guestIdAtOpen = auth.mode === 'guest' ? auth.guest.guestId : null;
  root.className = 'board-root';
  root.replaceChildren(Object.assign(document.createElement('div'), { className: 'loading', textContent: 'Opening board…' }));
  const accounts = auth.mode === 'signed-in' || auth.mode === 'offline';
  const user = boardUser(auth);
  const [conn, role] = await Promise.all([openBoard(id, user), boardRole(id, auth)]);
  const deleted = await isDeletedBoard(id, auth, role);
  await desktop?.mergeBackup(conn);
  if (seq !== routeSeq) {
    conn.destroy();
    return;
  }
  // When a locked workspace becomes writable again the board reconnects, so what was typed while the relay dropped it is sent.
  const watchUnlock = createUnlockWatcher(() => conn.resync());
  // The role and, on a hosted workspace, the workspace's read-only switch decide together; a new /api/me re-decides.
  const denialForCurrentGuest = () => {
    const currentAuth = authState();
    return denialForGuestSession(guestIdAtOpen, currentAuth, conn.denied);
  };
  const applyAccess = () => {
    const currentAuth = authState();
    const workspace = workspaceOf(currentAuth);
    const access = boardAccess(role, workspace, deleted, conn.store.unsupportedFeatures().length > 0);
    applyConnectionAccess(conn, access, currentAuth, denialForCurrentGuest());
    watchUnlock(workspace);
  };
  applyAccess();
  const unwatchGuestAccess = watchGuestAccess(conn, guestIdAtOpen, applyAccess);
  // A feature this client lacks can arrive with a remote change, an import or a restore: the board turns read-only then too.
  // Watching starts before the import below, which writes the board's meta.
  const unwatchFeatures = watchFeatureGate(conn.store, applyAccess);
  const job = pending?.id === id ? pending : null;
  pending = null;

  if (job?.imported) {
    // The importer owns the new board, so the comments in the file are marked imported by the account (or device) that opens it.
    applyImported(conn, job.imported, auth.mode === 'signed-in' ? auth.me.user.id : user.id);
  }

  root.replaceChildren();
  const app = new BoardApp(conn, user, root, isHostedWorkspace(auth));
  app.role = role ?? null;
  app.deleted = deleted;
  current = app;
  currentBoardId = id;
  desktop?.watchBoard(app);
  // Inspection handle for automated tests and debugging (?debug in the URL). `__kanban` lets a seed store card heights
  // the way the app does (scripts/visual-check.mjs).
  if (!DEMO && location.search.includes('debug')) Object.assign(window, { __board: app, __kanban: { cardContentHeight } });
  // the pictures of an imported board file go to this board's asset store in the background
  if (job?.imported?.assets) void app.images.adopt(job.imported.assets);
  mountBoardUi(app, root, { home: () => (location.hash = '#/') }, { trackerId: r.trackerPosition?.trackerId, ticketKey: r.trackerPosition?.key, guestId: guestIdAtOpen ?? undefined });
  const banner = createWorkspaceBanner(
    (visible) => root.classList.toggle('has-banner', visible),
    () => guestAccessEnded(authState(), denialForCurrentGuest()) ? GUEST_ENDED_BANNER : null,
  );
  root.appendChild(banner.el);
  // the banner wraps at large text sizes; the editing chrome sits below its real height
  const bannerSize = new ResizeObserver(() => root.style.setProperty('--banner-h', `${Math.ceil(banner.el.getBoundingClientRect().height)}px`));
  bannerSize.observe(banner.el);
  const releaseNewer = mountNewerBanner(conn.store, root);
  // The relay says the read-only switch flipped: ask /api/me now instead of at the next five minute refresh.
  const unhint = conn.onWorkspaceHint(refreshMeSoon);
  // The relay undid one of this person's changes to the comments: say so, once per notice.
  const unnotice = conn.onCommentNotice((undone) => toast(commentNoticeText(undone)));
  releaseWorkspace = () => {
    unwatchFeatures();
    unwatchGuestAccess();
    releaseNewer();
    unhint();
    unnotice();
    banner.dispose();
    bannerSize.disconnect();
  };
  if (accounts) {
    releaseBanner = mountAccessBanner(conn, root, {
      onSignIn: () => {
        saveReturn(`#/b/${id}`);
        location.hash = '#/signin';
      },
      onRemoveLocal: async () => {
        await deleteBoard(id);
        location.hash = '#/';
      },
      onHome: () => {
        location.hash = '#/';
      },
    });
  }

  const custom = job?.custom;
  if (custom) {
    const fonts = custom.content.fonts;
    conn.store.setMeta({ name: custom.name, ...(fonts ? { headingFont: fonts.heading, bodyFont: fonts.body } : {}) });
    requestAnimationFrame(() => insertCustomTemplate(app, custom));
  } else if (job?.template) {
    const t = TEMPLATES.find((x) => x.id === job.template);
    if (t) {
      conn.store.setMeta({ name: t.name });
      requestAnimationFrame(() => insertTemplate(app, t));
    }
  }
  if (job?.imported) {
    requestAnimationFrame(() => app.zoomToFit());
    toast('Board opened from file');
  }

  if (r.trackerPosition && (trackerEnabled(auth) || auth.mode === 'guest')) {
    const target = { kind: 'board-position' as const, boardId: id, ...r.trackerPosition };
    try {
      const handled = await dispatchTrackerRoute(target);
      if (seq !== routeSeq) {
        handled?.dispose?.();
        return;
      }
      leavePage = handled?.dispose ?? null;
      replaceResolvedTrackerPath(target, handled?.resolvedKey);
    } catch {
      // The board stays usable if a tracker route handler cannot open its ticket.
    }
  }
}

async function boot() {
  if (DEMO) {
    setDemoMode();
    window.addEventListener('hashchange', route);
    route();
    return;
  }
  // Open mode (no accounts, or no server to ask) resolves at once and routes exactly as before.
  await initAuth();
  registerTrackerRouteHost();
  startMeRefresh();
  // the cards for mentions in channels you are not looking at, while chat is on for this person
  let stopMentions: (() => void) | null = null;
  let stopTitle: (() => void) | null = null;
  const syncMentions = () => {
    if (chatAvailable() && !stopMentions) {
      stopMentions = mountMentionNotices();
      stopTitle = mountTitleBadge();
    } else if (!chatAvailable() && stopMentions) {
      stopMentions();
      stopTitle?.();
      stopMentions = null;
      stopTitle = null;
    }
  };
  syncMentions();
  onAuth((s) => {
    if (needsSignIn(resolveRoute(location.hash, s.mode, location.pathname, location.search), s.mode)) {
      saveReturn(location.hash);
      location.replace('#/signin');
    }
    syncMentions();
  });
  if (!DEMO && isDesktop()) {
    try {
      desktop = await (await import('./desktop')).startDesktop(nav);
    } catch (e) {
      console.error('The desktop features did not start; carrying on as a plain web page.', e);
    }
  }
  // one navigation fires both hashchange and popstate: route once per location
  const once = onceForLocation(() => void route(), () => location.href);
  window.addEventListener('hashchange', once.handle);
  window.addEventListener('popstate', once.handle);
  once.handle();
}

if (trackerMockVisual) {
  root.className = 'trk-route-root';
  root.replaceChildren();
  void Promise.all([import('./tracker-mock'), import('./tracker/ui/visual-seed')]).then(([mock, seed]) => {
    const api = mock.createMockTrackerApi(seed.createTrackerVisualSeed());
    const store: TrackerStore = createTrackerStore(api);
    const shell = mountTrackerShell(root, {
      store, api, viewerId: 'visual-user', trackerId: 'tracker-demo', initialTab: 'all', fullScreen: true,
      onTabChange: (tab) => { navigateTrackerPath({ kind: 'view', view: tab }, 'replace'); },
      onTicketChange: (key) => {
        if (key) navigateTrackerPath({ kind: 'ticket', key });
        else history.back();
      },
    });
    Object.assign(window, { __trackerStore: store, __trackerShell: shell });
  });
} else if (trackerFoundationVisual) {
  void import('./tracker/ui/gallery').then(({ mountTrackerGallery }) => mountTrackerGallery(root));
} else {
  if (!DEMO) loadCatalogue();
  boot();
}

if (!DEMO && !trackerFoundationVisual && !trackerMockVisual && import.meta.env.PROD && 'serviceWorker' in navigator && !isDesktop() && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}
