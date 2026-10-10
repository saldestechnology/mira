import { ApiError, api, type GuestJoin, type Me, type ServerBoard } from './api';
import { clearChatCache, clearUserChatCache, purgeOtherUsers } from './chat-cache';
import { createMeRefresher, meChanged, type MeRefreshDeps } from './cloud-logic';

export type AuthState =
  | { mode: 'unknown' }
  | { mode: 'open' }
  | { mode: 'guest'; guest: GuestSession }
  | { mode: 'signed-out' }
  | { mode: 'signed-in'; me: Me }
  | { mode: 'offline'; me: Me | null };

const ME_KEY = 'driftboard:me';
const BOARDS_KEY = 'driftboard:server-boards';
const GUEST_KEY = 'driftboard:guest-session';
const AUTH_SYNC_KEY = 'driftboard:auth-identity';
const AUTH_CHANNEL = 'driftboard:auth';
const SIGNED_OUT_MARKER = '\u0000signed-out';

export interface GuestSession extends GuestJoin {
  /** A terminal relay refusal or a locally observed expiry; retained so reloads stay view-only. */
  ended?: boolean;
}

let state: AuthState = { mode: 'unknown' };
let joinCodesEnabled = false;
const listeners = new Set<(s: AuthState) => void>();
let authRevision = 0;
let authChannel: BroadcastChannel | null = null;
let authSyncStarted = false;
let pendingRemoteIdentity: string | null | undefined;
let pendingChatReset: Promise<void> = Promise.resolve();
let resetChatForAuth: ((userId: string | null) => Promise<void>) | undefined;

/** Lets the chat store synchronously reset its in-memory state before auth switches identities. */
export function registerAuthChatReset(reset: (userId: string | null) => Promise<void>) {
  resetChatForAuth = reset;
}

export function authState(): AuthState {
  return state;
}

/** Whether the existing /api/me answer identifies this instance as hosted (docs/images.md). */
export function isHostedWorkspace(s: AuthState = state): boolean {
  return (s.mode === 'signed-in' || s.mode === 'offline') && s.me?.workspace !== undefined;
}

export function joinCodesAvailable(): boolean {
  return joinCodesEnabled;
}

function readGuestSession(): GuestSession | null {
  try {
    const raw = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(GUEST_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as GuestSession;
    if (!value || typeof value.boardId !== 'string' || typeof value.guestId !== 'string' || typeof value.name !== 'string'
      || (value.role !== 'editor' && value.role !== 'commenter') || !Number.isFinite(value.expiresAt)) return null;
    if (value.ended !== true && value.expiresAt <= Date.now()) {
      value.ended = true;
      try { sessionStorage.setItem(GUEST_KEY, JSON.stringify(value)); } catch { /* keep the terminal state in memory */ }
    }
    return value;
  } catch {
    return null;
  }
}

function clearGuestSession() {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(GUEST_KEY);
  } catch {
    /* storage is unavailable */
  }
}

export function onAuth(fn: (s: AuthState) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function commit(next: AuthState): AuthState {
  state = next;
  for (const fn of listeners) fn(next);
  return next;
}

function readStorage(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null) {
  try {
    if (typeof localStorage === 'undefined') return;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage is unavailable (private window, blocked site data): run without the cache */
  }
}

function userIdOf(s: AuthState = state): string | null {
  return (s.mode === 'signed-in' || s.mode === 'offline') && s.me?.user?.id ? s.me.user.id : null;
}

function cachedUserId(): string | null {
  const me = readJson<Me>(ME_KEY);
  return typeof me?.user?.id === 'string' && me.user.id.length ? me.user.id : null;
}

function clearIdentityMetadata() {
  writeStorage(ME_KEY, null);
  writeStorage(BOARDS_KEY, null);
  // the bytes of images are private to the signed-in person (docs/images.md); loaded on demand so auth stays light
  void import('./board-images').then((m) => m.clearAssetCache()).catch(() => undefined);
}

function clearUserChat(userId: string): Promise<void> {
  const clear = resetChatForAuth ? resetChatForAuth(userId) : clearUserChatCache(userId);
  return Promise.resolve(clear).catch(() => undefined);
}

function publishIdentity(userId: string | null) {
  const message = userId ?? SIGNED_OUT_MARKER;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      authChannel ??= new BroadcastChannel(AUTH_CHANNEL);
      authChannel.postMessage(message);
      // Node's implementation is useful in tests and should not keep a process alive by itself.
      (authChannel as BroadcastChannel & { unref?: () => void }).unref?.();
    }
  } catch {
    /* the storage event remains available when BroadcastChannel is blocked */
  }
  // This key contains only an account id or a sign-out marker; it is the fallback for browsers without BroadcastChannel.
  writeStorage(AUTH_SYNC_KEY, message);
}

function receiveIdentity(value: unknown) {
  if (value !== SIGNED_OUT_MARKER && (typeof value !== 'string' || !value.length)) return;
  const incoming = value === SIGNED_OUT_MARKER ? null : value as string;
  if (incoming === null) {
    if (state.mode === 'signed-out' && !cachedUserId()) return;
    authRevision++;
    pendingRemoteIdentity = undefined;
    clearGuestSession();
    forgetCaches();
    commit({ mode: 'signed-out' });
    return;
  }

  const previous = userIdOf() ?? cachedUserId();
  if (previous === incoming) return;
  if (previous === null && pendingRemoteIdentity === incoming) return;
  authRevision++;
  pendingRemoteIdentity = incoming;
  clearIdentityMetadata();
  if (previous) {
    const priorReset = pendingChatReset;
    pendingChatReset = Promise.all([priorReset.catch(() => undefined), clearUserChat(previous)]).then(() => undefined);
  }
  commit({ mode: 'unknown' });
  // The broadcast carries no profile or message data. Confirm the current session through /api/me before showing chat.
  void initAuth();
}

function ensureAuthSync() {
  if (authSyncStarted) return;
  authSyncStarted = true;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      authChannel = new BroadcastChannel(AUTH_CHANNEL);
      authChannel.onmessage = (event: MessageEvent<unknown>) => receiveIdentity(event.data);
      (authChannel as BroadcastChannel & { unref?: () => void }).unref?.();
    }
  } catch {
    authChannel = null;
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key === AUTH_SYNC_KEY && event.newValue !== null) receiveIdentity(event.newValue);
    });
  }
}

function readJson<T>(key: string): T | null {
  const raw = readStorage(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function forgetCaches() {
  clearIdentityMetadata();
  // chat's saved and unsent messages are the person's too (docs/chat.md, Offline); src/chat.ts forgets its memory itself
  void clearChatCache().catch(() => undefined);
}

/** What the server said about images (docs/images.md): true, false, or null while it has not answered (then adding one stays possible, on this device). */
let serverImages: boolean | null = null;

/** Open, image-free mode for the ephemeral landing-page demo. It makes no API request and writes no identity cache. */
export function setDemoMode(): AuthState {
  serverImages = false;
  return commit({ mode: 'open' });
}

/**
 * Whether the **Image** button should show. A server that answered and does not list `images` (off, or older than this
 * feature) hides it; a server that has not answered, or a board kept only on this device, keeps it.
 */
export function imagesAvailable(): boolean {
  const me = state.mode === 'signed-in' || state.mode === 'offline' ? state.me : null;
  return me ? me.images === true : serverImages !== false;
}

/**
 * Whether board chat shows (docs/chat.md): only for a signed-in person on a server that reports `chat: true`. Offline
 * with a cached /api/me counts too, so saved messages and the outbox stay reachable.
 */
export function chatAvailable(): boolean {
  const me = state.mode === 'signed-in' || state.mode === 'offline' ? state.me : null;
  return me?.chat === true;
}

/**
 * Another person is signed in in this tab than the one the saved lists, image bytes and chat messages on this device belong to
 * (a sign-in link opened in a tab that someone else left open): what the last one had is not for the next one to see.
 * Call it BEFORE the new identity is written.
 */
async function prepareUserCaches(me: Me) {
  await pendingChatReset.catch(() => undefined);
  const nextId = me.user.id;
  const previousIds = new Set([userIdOf(), cachedUserId()].filter((id): id is string => !!id && id !== nextId));
  if (previousIds.size) {
    clearIdentityMetadata();
    await Promise.all([...previousIds].map((id) => clearUserChat(id)));
  }
  // On boot, remove every other account's rows before auth commits and chat can open.
  await purgeOtherUsers(nextId).catch(() => undefined);
}

export async function initAuth(a: Pick<typeof api, 'config' | 'me'> = api): Promise<AuthState> {
  const revision = authRevision;
  let authEnabled: boolean;
  try {
    const config = await a.config();
    if (revision !== authRevision) return authState();
    authEnabled = config.authEnabled;
    joinCodesEnabled = config.joinCodes === true;
    serverImages = config.images === true;
  } catch {
    if (revision !== authRevision) return authState();
    const guest = readGuestSession();
    if (guest) return commit({ mode: 'guest', guest });
    const cached = readJson<Me>(ME_KEY);
    if (cached?.user?.id) await purgeOtherUsers(cached.user.id).catch(() => undefined);
    if (revision !== authRevision) return authState();
    return commit(cached ? { mode: 'offline', me: cached } : { mode: 'open' });
  }
  if (!authEnabled) {
    clearGuestSession();
    return commit({ mode: 'open' });
  }

  try {
    const me = await a.me();
    if (revision !== authRevision) return authState();
    await prepareUserCaches(me);
    if (revision !== authRevision) return authState();
    clearGuestSession();
    writeStorage(ME_KEY, JSON.stringify(me));
    if (pendingRemoteIdentity === me.user.id) pendingRemoteIdentity = undefined;
    publishIdentity(me.user.id);
    return commit({ mode: 'signed-in', me });
  } catch (err) {
    if (revision !== authRevision) return authState();
    const guest = readGuestSession();
    if (guest) {
      if (err instanceof ApiError && err.status === 401) {
        guest.ended = true;
        try { sessionStorage.setItem(GUEST_KEY, JSON.stringify(guest)); } catch { /* retain terminal state in memory */ }
      }
      return commit({ mode: 'guest', guest });
    }
    if (err instanceof ApiError && err.status === 401) {
      setSignedOut();
      return authState();
    }
    const cached = readJson<Me>(ME_KEY);
    if (cached?.user?.id) await purgeOtherUsers(cached.user.id).catch(() => undefined);
    if (revision !== authRevision) return authState();
    return commit({ mode: 'offline', me: cached });
  }
}

let current: ReturnType<typeof createMeRefresher> | null = null;

/**
 * Hosted workspaces (docs/cloud.md): the relay says the workspace changed (an open socket got a hint). Brings the next
 * /api/me forward without trusting the hint; the answer goes through the same path as the five minute refresh. Does
 * nothing before the refresher has started, in open mode and on servers without a control plane.
 */
export function refreshMeSoon() {
  current?.hint();
}

/**
 * Hosted workspaces (docs/cloud.md): while the tab is open, asks for /api/me every few minutes so a new banner or a
 * read-only switch shows up. Does nothing for anyone who is signed out or on a server without a control plane.
 */
export function startMeRefresh(overrides: Partial<MeRefreshDeps> = {}): () => void {
  const refresher = createMeRefresher({
    active: () => state.mode === 'signed-in' && state.me.workspace !== undefined,
    visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
    fetchMe: () => api.me(),
    apply: (me) => {
      if (state.mode === 'signed-in' && meChanged(state.me, me)) setSignedIn(me);
    },
    expired: setSignedOut,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    ...overrides,
  });
  current = refresher;
  const seen = () => {
    if (document.visibilityState === 'visible') refresher.resume();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', seen);
  return () => {
    refresher.stop();
    if (current === refresher) current = null;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', seen);
  };
}

export async function signOut(a: Pick<typeof api, 'logout'> = api): Promise<void> {
  try {
    await a.logout();
  } finally {
    setSignedOut();
  }
}

export function setSignedIn(me: Me): Promise<void> {
  authRevision++;
  const revision = authRevision;
  pendingRemoteIdentity = undefined;
  const currentId = userIdOf();
  const storedId = cachedUserId();
  if (currentId === me.user.id && (!storedId || storedId === me.user.id)) {
    clearGuestSession();
    writeStorage(ME_KEY, JSON.stringify(me));
    publishIdentity(me.user.id);
    commit({ mode: 'signed-in', me });
    return Promise.resolve();
  }
  return (async () => {
    await prepareUserCaches(me);
    if (revision !== authRevision) return;
    clearGuestSession();
    writeStorage(ME_KEY, JSON.stringify(me));
    publishIdentity(me.user.id);
    commit({ mode: 'signed-in', me });
  })();
}

export function setGuest(guest: GuestJoin) {
  authRevision++;
  pendingRemoteIdentity = undefined;
  forgetCaches();
  const session: GuestSession = { ...guest };
  delete session.ended;
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(GUEST_KEY, JSON.stringify(session));
  } catch {
    /* storage is unavailable: this tab can still open the joined board until it reloads */
  }
  publishIdentity(null);
  commit({ mode: 'guest', guest: session });
}

/** Mark only the guest session whose relay connection was refused; a later join has a different guestId. */
export function markGuestSessionEnded(expectedGuestId: string): boolean {
  if (state.mode !== 'guest' || state.guest.guestId !== expectedGuestId || state.guest.ended) return false;
  const guest: GuestSession = { ...state.guest, ended: true };
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(GUEST_KEY, JSON.stringify(guest));
  } catch { /* retain terminal state in memory */ }
  commit({ mode: 'guest', guest });
  return true;
}

export function leaveGuestSession() {
  authRevision++;
  pendingRemoteIdentity = undefined;
  clearGuestSession();
  forgetCaches();
  publishIdentity(null);
  commit({ mode: 'signed-out' });
}

export function setSignedOut() {
  leaveGuestSession();
}

export function cacheServerBoards(list: ServerBoard[]) {
  writeStorage(BOARDS_KEY, JSON.stringify(list));
}

export function cachedServerBoards(): ServerBoard[] {
  const list = readJson<ServerBoard[]>(BOARDS_KEY);
  return Array.isArray(list) ? [...list].sort((a, b) => b.updatedAt - a.updatedAt) : [];
}

ensureAuthSync();
