import type { AuthState } from './auth';
import {
  buildTrackerPath,
  canonicalTrackerPath,
  parseTrackerPath,
  type TrackerPathRoute,
} from './tracker-route';

export const ADMIN_TABS = ['overview', 'members', 'teams', 'boards', 'sessions', 'tokens', 'ai', 'chat', 'backups', 'settings', 'audit'] as const;
export type AdminTab = (typeof ADMIN_TABS)[number];

export type Route =
  | { name: 'home' }
  | { name: 'templates' }
  | { name: 'template-edit'; id: string }
  | { name: 'board'; id: string; trackerPosition?: { trackerId: string; key?: string } }
  | { name: 'tracker'; target: Exclude<TrackerPathRoute, { kind: 'board-position' }> }
  | { name: 'signin' }
  | { name: 'verify'; token: string }
  | { name: 'invite'; token: string }
  | { name: 'join'; code: string }
  | { name: 'admin'; tab: AdminTab }
  | { name: 'chat'; kind?: 'board' | 'team' | 'workspace'; ref?: string };

const HOME: Route = { name: 'home' };

/** An unknown or missing tab is the overview. */
function adminTab(segment: string | undefined): AdminTab {
  return ADMIN_TABS.find((t) => t === segment) ?? 'overview';
}

/** Sign-in, emailed-link and invite screens: reachable without a session. */
function isAuthRoute(route: Route): boolean {
  return route.name === 'signin' || route.name === 'verify' || route.name === 'invite' || route.name === 'join';
}

/** Maps a location hash to a route. Anything unrecognised is the home screen, as it always was. */
export function parseRoute(hash: string): Route {
  const board = hash.match(/^#\/b\/([A-Za-z0-9_-]{1,64})$/);
  if (board) return { name: 'board', id: board[1] };
  const edit = hash.match(/^#\/t\/([A-Za-z0-9_-]{1,64})\/edit$/);
  if (edit) return { name: 'template-edit', id: edit[1] };
  const invite = hash.match(/^#\/invite\/([A-Za-z0-9_-]+)$/);
  if (invite) return { name: 'invite', token: invite[1] };
  const join = hash.match(/^#\/join(?:\?(.*))?$/);
  if (join) return { name: 'join', code: new URLSearchParams(join[1] ?? '').get('c') ?? '' };
  if (hash === '#/signin') return { name: 'signin' };
  if (hash === '#/templates') return { name: 'templates' };
  const admin = hash.match(/^#\/admin(?:\/([^/]*))?$/);
  if (admin) return { name: 'admin', tab: adminTab(admin[1]) };
  const chat = hash.match(/^#\/chat(?:\/(board|team|workspace)\/([A-Za-z0-9_-]{1,64}))?$/);
  if (chat) return chat[1] ? { name: 'chat', kind: chat[1] as 'board' | 'team' | 'workspace', ref: chat[2] } : { name: 'chat' };
  const verify = hash.match(/^#\/signin\/verify(?:\?(.*))?$/);
  if (verify) {
    const token = new URLSearchParams(verify[1] ?? '').get('token');
    return token ? { name: 'verify', token } : { name: 'signin' };
  }
  return HOME;
}

/** The route to render: open mode has no accounts, so the account screens fall back to home like any unknown hash. */
export function resolveRoute(hash: string, mode: AuthState['mode'], pathname = '', search = ''): Route {
  const hashRoute = parseRoute(hash);
  const trackerPath = parseTrackerPath(pathname, search);
  let route: Route;
  const hashWins = hash !== '' && hash !== '#' && (hashRoute.name !== 'home' || hash === '#/');
  if (hashWins) {
    // A hash navigation made after loading a path deep link must be able to leave that path.
    route = hashRoute;
  } else if (pathname === '/join') {
    route = { name: 'join', code: new URLSearchParams(search).get('c') ?? '' };
  } else if (trackerPath?.kind === 'board-position') {
    route = { name: 'board', id: trackerPath.boardId, trackerPosition: { trackerId: trackerPath.trackerId, key: trackerPath.key } };
  } else if (trackerPath) {
    route = { name: 'tracker', target: trackerPath };
  } else {
    const directBoard = pathname.match(/^\/b\/([A-Za-z0-9_-]{1,64})\/?$/);
    route = directBoard && search === '' && hashRoute.name === 'home'
      ? { name: 'board', id: directBoard[1] }
      : hashRoute;
  }
  return mode === 'open' && (isAuthRoute(route) || route.name === 'admin' || route.name === 'chat') ? HOME : route;
}

/** Only a server that has accounts turned on and no signed-in user gates routes. */
export function needsSignIn(route: Route, mode: AuthState['mode']): boolean {
  return mode === 'signed-out' && !isAuthRoute(route);
}

/** The hash worth coming back to after signing in. Only boards: the other routes are the gate itself or home. */
export function returnHash(hash: string): string | null {
  return parseRoute(hash).name === 'board' ? hash : null;
}

/** The destination worth restoring after sign-in, as a path for deep links or a hash for legacy app routes. */
export function returnDestination(hash: string, pathname = '', search = ''): string | null {
  const trackerPath = parseTrackerPath(pathname, search);
  if (trackerPath) return buildTrackerPath(trackerPath);
  const directBoard = pathname.match(/^\/b\/([A-Za-z0-9_-]{1,64})\/?$/);
  if (directBoard && search === '') return '/b/' + directBoard[1];
  return returnHash(hash);
}

/** Validate a stored sign-in destination before navigating to it. */
export function safeReturnDestination(value: string): string | null {
  if (typeof value !== 'string') return null;
  if (value.startsWith('#/')) return returnHash(value);
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\0#]/.test(value)) return null;
  const queryAt = value.indexOf('?');
  const pathname = queryAt < 0 ? value : value.slice(0, queryAt);
  const search = queryAt < 0 ? '' : value.slice(queryAt);
  const trackerPath = parseTrackerPath(pathname, search);
  if (trackerPath) return buildTrackerPath(trackerPath);
  const directBoard = pathname.match(/^\/b\/([A-Za-z0-9_-]{1,64})\/?$/);
  return directBoard && search === '' ? '/b/' + directBoard[1] : null;
}

/** Use this when pushing or replacing tracker paths in-app; native Back/Forward is handled by main.ts popstate. */
export function navigateTrackerPath(target: TrackerPathRoute, mode: 'push' | 'replace' = 'push'): boolean {
  const path = buildTrackerPath(target);
  if (!path || typeof window === 'undefined') return false;
  if (mode === 'replace') window.history.replaceState(null, '', path);
  else window.history.pushState(null, '', path);
  window.dispatchEvent(new Event('popstate'));
  return true;
}

export type TrackerRouteResult = { resolvedKey?: string; dispose?: () => void };
export type TrackerRouteHandler = (target: TrackerPathRoute) => void | TrackerRouteResult | Promise<void | TrackerRouteResult>;

const trackerRouteHandlers = new Set<TrackerRouteHandler>();

/** Register the full-screen tracker route handler. Its result may report a store-resolved canonical ticket key. */
export function onTrackerRoute(handler: TrackerRouteHandler): () => void {
  trackerRouteHandlers.add(handler);
  return () => trackerRouteHandlers.delete(handler);
}

/** Notify tracker handlers and collect the first canonical key plus their route cleanup functions. */
export async function dispatchTrackerRoute(target: TrackerPathRoute): Promise<TrackerRouteResult | undefined> {
  let resolvedKey: string | undefined;
  const cleanups: Array<() => void> = [];
  for (const handler of trackerRouteHandlers) {
    const result = await handler(target);
    if (!result) continue;
    if (result.dispose) cleanups.push(result.dispose);
    if (resolvedKey === undefined && typeof result.resolvedKey === 'string') resolvedKey = result.resolvedKey;
  }
  if (resolvedKey === undefined && cleanups.length === 0) return undefined;
  return {
    ...(resolvedKey === undefined ? {} : { resolvedKey }),
    ...(cleanups.length === 0 ? {} : { dispose: () => { for (const cleanup of cleanups) cleanup(); } }),
  };
}

/** Build the replacement URL after the store resolves a canonical ticket key (including on a board-position link). */
export function resolvedTrackerDestination(target: TrackerPathRoute, resolvedKey: string): string | null {
  return canonicalTrackerPath(target, resolvedKey);
}
