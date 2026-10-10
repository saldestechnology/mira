import { describe, expect, it } from 'vitest';
import {
  TrackerError,
  createHttpTrackerApi,
  dueDateStatus,
  formatFilter,
  isTicketKey,
  matchesFilters,
  parseFilter,
  priorityFromInt,
  priorityToInt,
  statesByCategory,
  ticketKeyFromText,
  type TrackerTicket,
  type TrackerInboxItem,
  type TrackerNotificationKind,
  type TrackerNotificationPrefs,
} from '../src/tracker-data';
import { createMockTrackerApi } from '../src/tracker-mock';

function ticket(overrides: Partial<TrackerTicket> = {}): TrackerTicket {
  return {
    id: 'ticket-1', key: 'TAB-1', trackerId: 'tracker-demo', title: 'Fix the tracker', description: '',
    state: { id: 'state-todo', key: 'todo', name: 'To do', category: 'unstarted' }, priority: 'none',
    assignee: { userId: 'user-me', name: 'You' }, creator: { type: 'user', id: 'user-me', name: 'You' },
    labels: [{ id: 'label-ui', name: 'UI', color: '#fff' }], project: null, milestone: null, estimate: null,
    due: '2026-10-09', parent: null, relations: [], links: [], aliases: [], archivedAt: null,
    createdAt: 1, updatedAt: 2, updatedSeq: 3, ...overrides,
  };
}

describe('tracker HTTP client', () => {
  it('uses same-origin JSON and the write CSRF header and supports caller abort signals', async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const fetchFn: typeof fetch = async (input, init = {}) => {
      calls.push({ path: String(input), init });
      return new Response(JSON.stringify({ ticket: ticket() }), { status: 201, headers: { 'content-type': 'application/json' } });
    };
    const api = createHttpTrackerApi(fetchFn);
    const controller = new AbortController();
    await api.createTicket({ title: 'Fix it', idempotencyKey: 'create-key-123' }, { signal: controller.signal });
    expect(calls[0].path).toBe('/api/tracker/tickets');
    expect(calls[0].init.credentials).toBe('same-origin');
    expect(new Headers(calls[0].init.headers).get('x-tabula')).toBe('1');
    expect(new Headers(calls[0].init.headers).get('content-type')).toBe('application/json');
    expect(calls[0].init.signal).toBe(controller.signal);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ title: 'Fix it', idempotencyKey: 'create-key-123' });

    await api.listTickets({ filter: ['assignee:me', 'state:done'], q: 'crash', limit: 10 });
    const query = new URL(calls[1].path, 'https://tabula.test').searchParams;
    expect(query.getAll('filter')).toEqual(['assignee:me', 'state:done']);
    expect(query.get('q')).toBe('crash');
    expect(new Headers(calls[1].init.headers).has('x-tabula')).toBe(false);
  });

  it('maps HTTP codes, error fields, conflict tickets, malformed JSON, and network failures', async () => {
    const respond = (status: number, body: unknown): typeof fetch => async () => new Response(JSON.stringify(body), { status });
    const notFound = createHttpTrackerApi(respond(404, { error: 'other', message: 'missing' }));
    await expect(notFound.getTicket('TAB-1')).rejects.toMatchObject({ name: 'TrackerError', code: 'not_found', status: 404 });

    const current = ticket({ title: 'server title', updatedSeq: 9 });
    const conflictApi = createHttpTrackerApi(respond(409, {
      error: 'conflict', message: 'stale edit', path: 'title', ticket: current, by: { name: 'Ada Lovelace', kind: 'user' },
    }));
    const conflictError = await conflictApi.patchTicket(current.key, { title: 'local' }).then(() => null, (error: unknown) => error);
    expect(conflictError).toBeInstanceOf(TrackerError);
    expect(conflictError).toMatchObject({ code: 'conflict', message: 'stale edit', path: 'title', current, by: { name: 'Ada Lovelace', kind: 'user' } });

    const readOnlyApi = createHttpTrackerApi(respond(403, { error: 'read_only', message: 'Workspace is locked.' }));
    await expect(readOnlyApi.createTicket({ title: 'No', idempotencyKey: 'create-key-123' }))
      .rejects.toMatchObject({ code: 'read_only', message: 'Workspace is locked.' });

    const invalidJson = createHttpTrackerApi(async () => new Response('{', { status: 200 }));
    await expect(invalidJson.meta()).rejects.toMatchObject({ code: 'internal' });
    const network = createHttpTrackerApi(async () => { throw new Error('offline'); });
    await expect(network.meta()).rejects.toMatchObject({ code: 'network', message: 'offline' });
  });

  it('uses the REST routes and payload shapes for projects, milestones, relations, bulk, and saved views', async () => {
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    const project = { id: 'project-1', name: 'Payments', state: 'started', archivedAt: null };
    const milestone = { id: 'milestone-1', projectId: 'project-1', name: 'Launch', due: '2026-11-01', archivedAt: null };
    const view = { id: 'view-1', name: 'Open work', filter: ['state:todo'], shared: false, mine: true };
    const fetchFn: typeof fetch = async (input, init = {}) => {
      const path = String(input);
      const method = String(init.method ?? 'GET');
      calls.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const payload = path.startsWith('/api/tracker/tickets/bulk')
        ? { batchId: 'batch-1', results: [{ key: 'TAB-1', ok: true, ticket: ticket(), before: { state: 'todo', assigneeId: 'user-me' } }] }
        : path === '/api/tracker/projects?archived=1' ? { projects: [project] }
          : path === '/api/tracker/projects' ? { project }
            : path.endsWith('/milestones') && method === 'GET' ? { milestones: [milestone] }
              : path.endsWith('/milestones') ? { milestone }
                : path === '/api/tracker/views' && method === 'GET' ? { views: [view] }
                  : path.endsWith('/tickets') ? { tickets: [ticket()], nextCursor: null, view }
                    : path.endsWith('/tickets/TAB-1/relations') ? { ticket: ticket() }
                      : path.includes('/projects/') ? { project }
                        : path.includes('/milestones/') ? { milestone }
                          : path.includes('/views/') ? { view } : {};
      return new Response(method === 'DELETE' ? null : JSON.stringify(payload), { status: method === 'DELETE' ? 204 : 200 });
    };
    const api = createHttpTrackerApi(fetchFn);

    expect((await api.listProjects({ includeArchived: true })).projects).toEqual([project]);
    await api.createProject({ name: 'Payments', ownerId: 'me' });
    await api.updateProject('project/1', { state: 'started', ownerId: null });
    expect((await api.listMilestones('project/1')).milestones).toEqual([milestone]);
    await api.createMilestone('project/1', { name: 'Launch', due: '2026-11-01' });
    await api.updateMilestone('milestone/1', { due: null });
    await api.addRelation('TAB-1', { kind: 'blocks', key: 'TAB-2' });
    await api.removeRelation('TAB-1', { kind: 'blocks', key: 'TAB-2' });
    const bulk = await api.bulkTickets({ keys: ['TAB-1'], patch: { state: 'done' } });
    expect(bulk.before['TAB-1'].patch).toEqual({ state: 'todo', assignee: 'user-me' });
    expect((await api.listViews()).views).toEqual([view]);
    expect((await api.runView('view/1', { limit: 5, cursor: 'next' })).view).toEqual(view);
    await api.createView({ name: 'Open work', filter: ['state:todo'] });
    await api.updateView('view/1', { shared: true });
    await api.deleteView('view/1');

    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /api/tracker/projects?archived=1',
      'POST /api/tracker/projects',
      'PATCH /api/tracker/projects/project%2F1',
      'GET /api/tracker/projects/project%2F1/milestones',
      'POST /api/tracker/projects/project%2F1/milestones',
      'PATCH /api/tracker/milestones/milestone%2F1',
      'POST /api/tracker/tickets/TAB-1/relations',
      'DELETE /api/tracker/tickets/TAB-1/relations',
      'POST /api/tracker/tickets/bulk',
      'GET /api/tracker/views',
      'GET /api/tracker/views/view%2F1/tickets?limit=5&cursor=next',
      'POST /api/tracker/views',
      'PATCH /api/tracker/views/view%2F1',
      'DELETE /api/tracker/views/view%2F1',
    ]);
    expect(calls[1].body).toEqual({ name: 'Payments', ownerId: 'me' });
    expect(calls[4].body).toEqual({ name: 'Launch', due: '2026-11-01' });
    expect(calls[6].body).toEqual({ relation: 'blocks', otherKey: 'TAB-2' });
    expect(calls[8].body).toEqual({ keys: ['TAB-1'], patch: { state: 'done' } });
    expect(calls[11].body).toEqual({ name: 'Open work', filter: ['state:todo'] });
  });

  it('uses the server inbox and notification preference wire shapes', async () => {
    const kinds: TrackerNotificationKind[] = [
      'assigned', 'mentioned', 'commented', 'status_changed', 'due_soon', 'relation_changed', 'integration_activity',
    ];
    const item: TrackerInboxItem = {
      id: 'notice-1', kind: 'assigned', createdAt: 123, readAt: null,
      ticket: {
        key: 'TAB-12', title: 'Review the inbox', state: { name: 'In progress', category: 'started' },
        assignee: { name: 'Mara' }, priority: 'high',
      },
      actor: null, preview: null, detail: null,
    };
    const preferences: TrackerNotificationPrefs = {
      kinds,
      prefs: {
        assigned: 'both', mentioned: 'both', commented: 'app', status_changed: 'app', due_soon: 'both',
        relation_changed: 'app', integration_activity: 'app',
      },
    };
    const replies: unknown[] = [
      { items: [item], nextCursor: 'opaque-cursor', unread: 2 },
      { unread: 2 },
      { updated: 1, unread: 1 },
      preferences,
      { ...preferences, prefs: { ...preferences.prefs, assigned: 'off' } },
    ];
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const api = createHttpTrackerApi(async (input, init = {}) => {
      calls.push({ path: String(input), init });
      return new Response(JSON.stringify(replies[calls.length - 1]), { status: 200 });
    });
    const controller = new AbortController();
    const page = await api.inbox({ limit: 30, before: 'cursor-1', unread: true }, { signal: controller.signal });
    expect(page).toEqual({ items: [item], nextCursor: 'opaque-cursor', unread: 2 });
    const query = new URL(calls[0].path, 'https://tabula.test').searchParams;
    expect([...query.entries()]).toEqual([['limit', '30'], ['before', 'cursor-1'], ['unread', '1']]);
    expect(calls[0].init.signal).toBe(controller.signal);

    expect(await api.inboxUnread()).toEqual({ unread: 2 });
    expect(await api.markInboxRead({ ids: ['notice-1'] })).toEqual({ updated: 1, unread: 1 });
    expect(await api.notificationPrefs()).toEqual(preferences);
    const updated = await api.updateNotificationPrefs({ prefs: { assigned: 'off' } });
    expect(updated.prefs.assigned).toBe('off');
    expect(JSON.parse(String(calls[4].init.body))).toEqual({ prefs: { assigned: 'off' } });
  });
});

describe('tracker mock API', () => {
  it('allocates never-reused keys, honors idempotency, detects stale writes, and archives/restores', async () => {
    let now = Date.UTC(2026, 9, 10);
    const api = createMockTrackerApi({ now: () => now });
    const input = { title: 'A first ticket', idempotencyKey: 'stable-create-001' };
    const first = (await api.createTicket(input)).ticket;
    expect(first.key).toBe('TAB-1');
    expect((await api.createTicket(input)).ticket.key).toBe(first.key);
    const edited = (await api.patchTicket(first.key, { title: 'Changed', ifUpdatedSeq: first.updatedSeq })).ticket;
    expect(edited.title).toBe('Changed');
    await expect(api.patchTicket(first.key, { title: 'stale', ifUpdatedSeq: first.updatedSeq }))
      .rejects.toMatchObject({ code: 'conflict', current: edited, by: { name: 'You', kind: 'user' } });
    now += 1000;
    const archived = (await api.archiveTicket(first.key)).ticket;
    expect(archived.archivedAt).toBe(now);
    const ordinary = await api.listTickets();
    expect(ordinary.tickets).toEqual([]);
    expect((await api.listTickets({ filter: 'is:archived' })).tickets[0].key).toBe('TAB-1');
    const restored = (await api.restoreTicket(first.key)).ticket;
    expect(restored.archivedAt).toBeNull();
    const second = (await api.createTicket({ title: 'Next', idempotencyKey: 'stable-create-002' })).ticket;
    expect(second.key).toBe('TAB-2');
    expect((await api.feed(0)).seq).toBeGreaterThan(first.updatedSeq);
  });

  it('supports filter basics, safe literal mark snippets, comments, subscriptions, and bulk before data', async () => {
    const base = ticket();
    const api = createMockTrackerApi({ tickets: [base], now: () => Date.UTC(2026, 9, 10) });
    const dueRows = await api.listTickets({ filter: 'due:overdue' });
    expect(dueRows.tickets.map((item) => item.key)).toEqual(['TAB-1']);
    const searched = await api.listTickets({ q: 'tracker' });
    expect(searched.tickets[0].snippet).toContain('<mark>tracker</mark>');
    expect((await api.listTickets({ filter: 'state:done' })).tickets).toEqual([]);

    const comment = await api.addComment('TAB-1', { body: 'A note', clientId: 'comment-client-01' });
    expect(comment.ticket.updatedSeq).toBeGreaterThan(base.updatedSeq);
    expect((await api.addComment('TAB-1', { body: 'duplicate retry', clientId: 'comment-client-01' })).comment.id).toBe(comment.comment.id);
    expect(await api.setSubscription('TAB-1', true)).toEqual({ subscribed: true });
    expect((await api.getTicket('TAB-1')).subscribed).toBe(true);
    const bulk = await api.bulkTickets({ keys: ['TAB-1'], patch: { priority: 'high' } });
    expect(bulk.results[0]).toMatchObject({ ok: true, ticket: { priority: 'high' } });
    expect(bulk.before['TAB-1']).toMatchObject({ patch: { priority: 'none' } });
    expect((await api.feed(0)).events.map((event) => event.eventType)).toContain('ticket.commented');
  });
});

describe('tracker pure helpers', () => {
  it('parses and formats filters, extracts keys, maps priorities, states, and due dates', () => {
    const parsed = parseFilter(['assignee:me', 'state:done', 'label:UI', 'due:overdue', 'is:archived']);
    expect(formatFilter(parsed)).toEqual(['assignee:me', 'state:done', 'label:UI', 'due:overdue', 'is:archived']);
    expect(ticketKeyFromText('See tab-128 for details')).toBe('TAB-128');
    expect(isTicketKey('TAB-128')).toBe(true);
    expect(isTicketKey('TAB-0')).toBe(false);
    expect(priorityFromInt(priorityToInt('high'))).toBe('high');
    expect(statesByCategory([{ id: 'done', key: 'done', name: 'Done', category: 'completed', position: 2 }], 'completed')).toHaveLength(1);
    expect(dueDateStatus('2026-10-09', '2026-10-10')).toBe('overdue');
    expect(matchesFilters(ticket(), ['assignee:me', 'label:UI', 'due:overdue'], { me: 'user-me', today: '2026-10-10' })).toBe(true);
  });
});

describe('cloning a TrackerError', () => {
  it('keeps the message, code, path, status, current ticket and conflict actor', async () => {
    const { cloneTrackerData, TrackerError } = await import('../src/tracker-data');
    const error = new TrackerError('conflict', 'This ticket changed.', { path: 'title', status: 409, by: { name: 'Olive', kind: 'user' } });
    const copy = cloneTrackerData(error);
    expect(copy).toBeInstanceOf(TrackerError);
    expect(copy).not.toBe(error);
    expect(copy.message).toBe('This ticket changed.');
    expect(copy).toMatchObject({ code: 'conflict', path: 'title', status: 409, by: { name: 'Olive', kind: 'user' } });
  });
});
