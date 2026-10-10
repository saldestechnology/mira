/** URL routes owned by the tracker. This module has no browser or network dependencies. */

export type TrackerPathRoute =
  | { kind: 'ticket'; key: string }
  | { kind: 'view'; view: 'inbox' | 'my' | 'board' | 'all' | 'projects' | 'views'; id?: string }
  | { kind: 'board-position'; boardId: string; trackerId: string; key?: string };

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KEY_RE = /^[A-Za-z]{2,5}-[1-9][0-9]{0,18}$/i;
const TABS = new Set(['inbox', 'my', 'board', 'all', 'projects']);

export function isTrackerTicketKey(value: unknown): value is string {
  return typeof value === 'string' && KEY_RE.test(value);
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

function parseSearch(search: string): URLSearchParams | null {
  if (typeof search !== 'string' || /%(?![0-9a-f]{2})/i.test(search)) return null;
  if (search !== '' && (search === '?' || !search.startsWith('?'))) return null;
  if (search !== '') {
    const parts = search.slice(1).split('&');
    if (parts.some((part) => !part || !part.includes('='))) return null;
    try {
      for (const part of parts) {
        const separator = part.indexOf('=');
        if (part.slice(0, separator) !== 'tracker' && part.slice(0, separator) !== 't') return null;
        decodeURIComponent(part.slice(separator + 1).replaceAll('+', ' '));
      }
    } catch {
      return null;
    }
  }
  return new URLSearchParams(search.slice(1));
}

/** Parse a tracker or tracker-position URL. Invalid and hostile inputs return null. */
export function parseTrackerPath(pathname: string, search: string): TrackerPathRoute | null {
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || /[?#\\\0]/.test(pathname)) return null;
  const params = parseSearch(search);
  if (!params) return null;
  const queryCount = [...params].length;
  const path = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (path.endsWith('/')) return null;

  if (path === '/t/inbox' || path === '/t/my' || path === '/t/board' || path === '/t/all' || path === '/t/projects') {
    if (queryCount !== 0) return null;
    return { kind: 'view', view: path.slice('/t/'.length) as 'inbox' | 'my' | 'board' | 'all' | 'projects' };
  }

  const ticket = path.match(/^\/t\/([A-Za-z]{2,5}-[1-9][0-9]{0,18})$/i);
  if (ticket) {
    if (queryCount !== 0) return null;
    return { kind: 'ticket', key: ticket[1].toUpperCase() };
  }

  const project = path.match(/^\/t\/projects\/([A-Za-z0-9_-]{1,64})$/);
  if (project) {
    if (queryCount !== 0) return null;
    return { kind: 'view', view: 'projects', id: project[1] };
  }

  const savedView = path.match(/^\/t\/views\/([A-Za-z0-9_-]{1,64})$/);
  if (savedView) {
    if (queryCount !== 0) return null;
    return { kind: 'view', view: 'views', id: savedView[1] };
  }

  const board = path.match(/^\/b\/([A-Za-z0-9_-]{1,64})$/);
  if (!board) return null;
  const trackerIds = params.getAll('tracker');
  const keys = params.getAll('t');
  if (queryCount !== trackerIds.length + keys.length || trackerIds.length !== 1 || keys.length > 1) return null;
  const trackerId = trackerIds[0];
  const key = keys[0];
  if (!validId(trackerId) || (key !== undefined && !isTrackerTicketKey(key))) return null;
  return {
    kind: 'board-position',
    boardId: board[1],
    trackerId,
    ...(key === undefined ? {} : { key: key.toUpperCase() }),
  };
}

/** Build a canonical path; invalid route objects return null and never throw. */
export function buildTrackerPath(route: TrackerPathRoute): string | null {
  if (!route || typeof route !== 'object') return null;
  if (route.kind === 'ticket') return isTrackerTicketKey(route.key) ? '/t/' + route.key.toUpperCase() : null;
  if (route.kind === 'board-position') {
    if (!validId(route.boardId) || !validId(route.trackerId)
      || (route.key !== undefined && !isTrackerTicketKey(route.key))) return null;
    return '/b/' + route.boardId + '?tracker=' + encodeURIComponent(route.trackerId)
      + (route.key === undefined ? '' : '&t=' + encodeURIComponent(route.key.toUpperCase()));
  }
  if (route.kind !== 'view') return null;
  if (route.view === 'views') return validId(route.id) ? '/t/views/' + route.id : null;
  if (route.view === 'projects') {
    if (route.id !== undefined && !validId(route.id)) return null;
    return '/t/projects' + (route.id === undefined ? '' : '/' + route.id);
  }
  if (TABS.has(route.view) && route.id === undefined) return '/t/' + route.view;
  return null;
}

/** Replace an alias in a ticket or board-position route with the server's resolved canonical key. */
export function canonicalTrackerPath(route: TrackerPathRoute, resolvedKey: string): string | null {
  if (!isTrackerTicketKey(resolvedKey)) return null;
  if (route.kind === 'ticket') return buildTrackerPath({ kind: 'ticket', key: resolvedKey.toUpperCase() });
  if (route.kind === 'board-position' && route.key !== undefined) {
    return buildTrackerPath({ ...route, key: resolvedKey.toUpperCase() });
  }
  return null;
}
