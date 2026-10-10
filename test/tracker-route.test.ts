import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildTrackerPath,
  canonicalTrackerPath,
  isTrackerTicketKey,
  parseTrackerPath,
  type TrackerPathRoute,
} from '../src/tracker-route';
import {
  dispatchTrackerRoute,
  navigateTrackerPath,
  needsSignIn,
  onTrackerRoute,
  resolveRoute,
  returnDestination,
  safeReturnDestination,
} from '../src/route';

const registrations: Array<() => void> = [];

afterEach(() => {
  for (const remove of registrations.splice(0)) remove();
  vi.unstubAllGlobals();
});

describe('tracker path routes', () => {
  it.each<TrackerPathRoute>([
    { kind: 'ticket', key: 'TAB-123' },
    { kind: 'view', view: 'inbox' },
    { kind: 'view', view: 'my' },
    { kind: 'view', view: 'board' },
    { kind: 'view', view: 'all' },
    { kind: 'view', view: 'projects' },
    { kind: 'view', view: 'projects', id: 'project_12' },
    { kind: 'view', view: 'views', id: 'saved-view' },
    { kind: 'board-position', boardId: 'board-1', trackerId: 'tracker_1' },
    { kind: 'board-position', boardId: 'board-1', trackerId: 'tracker_1', key: 'TAB-9' },
  ])('builds and parses %j', (route) => {
    const built = buildTrackerPath(route)!;
    const queryAt = built.indexOf('?');
    const parsed = parseTrackerPath(queryAt < 0 ? built : built.slice(0, queryAt), queryAt < 0 ? '' : built.slice(queryAt));
    expect(parsed).toEqual(route);
  });

  it('accepts one trailing slash and normalizes ticket-key case', () => {
    expect(parseTrackerPath('/t/tAb-123/', '')).toEqual({ kind: 'ticket', key: 'TAB-123' });
    expect(parseTrackerPath('/b/board_1/', '?tracker=trk-1&t=tab-123')).toEqual({
      kind: 'board-position', boardId: 'board_1', trackerId: 'trk-1', key: 'TAB-123',
    });
  });

  it.each([
    ['/t/TAB-0', ''], ['/t/TAB-01', ''], ['/t/A-1', ''], ['/t/TAB-' + '1'.repeat(20), ''],
    ['/t/TAB-1/edit', ''], ['/t/inbox/extra', ''], ['/t/projects//', ''], ['/t/projects/a/b', ''],
    ['/t/views/a.b', ''], ['/b/board?x', ''], ['/b/board', '?tracker=trk&t=TAB-1&t=TAB-2'],
    ['/b/board', '?tracker=bad%20id&t=TAB-1'], ['/b/board', '?tracker=trk&t=TAB-0'],
    ['/b/board', '?tracker=trk&other=1'], ['/b/board', '?tracker=trk&t=TAB-1&'],
    ['/b/' + 'b'.repeat(65), '?tracker=trk'], ['/t/TAB-1', '?bad=%'],
    ['/b/board', '?tracker=%E0%A4%A'], ['//evil.example/t/TAB-1', ''], ['/t/%2e%2e', ''],
  ])('rejects hostile or junk path %j', (pathname, search) => {
    expect(() => parseTrackerPath(pathname, search)).not.toThrow();
    expect(parseTrackerPath(pathname, search)).toBeNull();
  });

  it('rejects malformed builder input without throwing', () => {
    expect(isTrackerTicketKey('tab-123')).toBe(true);
    expect(buildTrackerPath({ kind: 'ticket', key: 'TAB-0' } as never)).toBeNull();
    expect(buildTrackerPath({ kind: 'view', view: 'views' } as never)).toBeNull();
    expect(buildTrackerPath({ kind: 'board-position', boardId: '../x', trackerId: 'tracker' } as never)).toBeNull();
  });
});

describe('tracker route gating and return paths', () => {
  it('sends anonymous deep links through sign-in and restores the validated path', () => {
    const direct = resolveRoute('', 'signed-out', '/t/tab-123', '');
    expect(direct).toEqual({ name: 'tracker', target: { kind: 'ticket', key: 'TAB-123' } });
    expect(needsSignIn(direct, 'signed-out')).toBe(true);
    expect(resolveRoute('#/signin', 'signed-out', '/t/tab-123', '')).toEqual({ name: 'signin' });
    expect(returnDestination('#/signin', '/t/tab-123', '')).toBe('/t/TAB-123');
    expect(safeReturnDestination('/t/TAB-123')).toBe('/t/TAB-123');
    expect(safeReturnDestination('//outside.example/t/TAB-123')).toBeNull();
    expect(safeReturnDestination('/t/TAB-123?other=1')).toBeNull();
  });

  it('lets explicit hash navigation leave a path deep link', () => {
    expect(resolveRoute('#/templates', 'signed-in', '/t/TAB-123')).toEqual({ name: 'templates' });
    expect(resolveRoute('#/', 'signed-in', '/t/TAB-123')).toEqual({ name: 'home' });
  });

  it('keeps board-position links gated and restores their path after sign-in', () => {
    const direct = resolveRoute('', 'signed-out', '/b/board-1', '?tracker=tracker-1&t=TAB-123');
    expect(direct).toEqual({
      name: 'board', id: 'board-1', trackerPosition: { trackerId: 'tracker-1', key: 'TAB-123' },
    });
    expect(needsSignIn(direct, 'signed-out')).toBe(true);
    expect(returnDestination('', '/b/board-1', '?tracker=tracker-1&t=tab-123'))
      .toBe('/b/board-1?tracker=tracker-1&t=TAB-123');
  });

  it('uses the store-resolved key to canonicalize ticket and board-position URLs', () => {
    expect(canonicalTrackerPath({ kind: 'ticket', key: 'OLD-7' }, 'TAB-123')).toBe('/t/TAB-123');
    expect(canonicalTrackerPath({ kind: 'board-position', boardId: 'b1', trackerId: 'tr1', key: 'OLD-7' }, 'TAB-123'))
      .toBe('/b/b1?tracker=tr1&t=TAB-123');
    expect(canonicalTrackerPath({ kind: 'ticket', key: 'OLD-7' }, 'not-a-key')).toBeNull();
  });

  it('exposes route events and returns alias resolution to the app router', async () => {
    registrations.push(onTrackerRoute((target) => target.kind === 'ticket' ? { resolvedKey: 'TAB-4' } : undefined));
    await expect(dispatchTrackerRoute({ kind: 'ticket', key: 'OLD-4' })).resolves.toEqual({ resolvedKey: 'TAB-4' });
  });

  it('pushes and replaces tracker paths through history and emits popstate for the router', () => {
    let current = '';
    const events: string[] = [];
    vi.stubGlobal('window', {
      history: {
        pushState: (_state: unknown, _title: string, path: string) => { current = path; },
        replaceState: (_state: unknown, _title: string, path: string) => { current = path; },
      },
      dispatchEvent: (event: Event) => { events.push(event.type); return true; },
    });
    expect(navigateTrackerPath({ kind: 'ticket', key: 'TAB-1' })).toBe(true);
    expect(current).toBe('/t/TAB-1');
    expect(navigateTrackerPath({ kind: 'view', view: 'inbox' }, 'replace')).toBe(true);
    expect(current).toBe('/t/inbox');
    expect(events).toEqual(['popstate', 'popstate']);
  });
});
