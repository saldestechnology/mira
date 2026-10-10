import { describe, expect, it } from 'vitest';
import {
  TrackerError,
  createUndoStack,
  createTrackerKeyResolver,
  createTrackerStore,
  type TrackerTicket,
} from '../src/tracker-data';
import { createMockTrackerApi } from '../src/tracker-mock';
import { canonicalTrackerPath } from '../src/tracker-route';

function ticket(overrides: Partial<TrackerTicket> = {}): TrackerTicket {
  return {
    id: 'ticket-1', key: 'TAB-1', trackerId: 'tracker-demo', title: 'Original title', description: '',
    state: { id: 'state-todo', key: 'todo', name: 'To do', category: 'unstarted' }, priority: 'none',
    assignee: null, creator: { type: 'user', id: 'user-me', name: 'You' }, labels: [], project: null,
    milestone: null, estimate: null, due: null, parent: null, relations: [], links: [], aliases: [],
    archivedAt: null, createdAt: 1, updatedAt: 2, updatedSeq: 3, ...overrides,
  };
}

function timerRig() {
  let next = 0;
  const tasks = new Map<number, { callback: () => void; delay: number }>();
  return {
    tasks,
    setTimer(callback: () => void, delay: number) { const id = ++next; tasks.set(id, { callback, delay }); return id; },
    clearTimer(handle: unknown) { tasks.delete(handle as number); },
    fireNext() {
      const [id, task] = tasks.entries().next().value as [number, { callback: () => void; delay: number }];
      tasks.delete(id);
      task.callback();
      return task.delay;
    },
  };
}

async function flushMicrotasks() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

describe('tracker store writes', () => {
  it('passes an explicit optimistic concurrency sequence and defaults to the cached sequence', async () => {
    const api = createMockTrackerApi({ tickets: [ticket()] });
    const calls: Array<{ title?: string; ifUpdatedSeq?: number }> = [];
    api.patchTicket = async (_key, patch) => {
      calls.push(patch);
      return { ticket: ticket({ title: patch.title ?? 'Original title', updatedSeq: calls.length + 3 }) };
    };
    const store = createTrackerStore(api);
    await store.loadTicket('TAB-1');
    await store.updateTicket('TAB-1', { title: 'Explicit token' }, { ifUpdatedSeq: 1 });
    await store.updateTicket('TAB-1', { title: 'Default token' });
    expect(calls).toEqual([
      { title: 'Explicit token', ifUpdatedSeq: 1 },
      { title: 'Default token', ifUpdatedSeq: 4 },
    ]);
    store.destroy();
  });

  it('adds the latest event actor to a conflict after refetching ticket activity', async () => {
    const baseMeta = await createMockTrackerApi().meta();
    baseMeta.members.push({ userId: 'user-ada', name: 'Ada Lovelace' });
    const current = ticket({ title: 'Remote title', updatedSeq: 8 });
    const api = createMockTrackerApi({
      meta: baseMeta,
      tickets: [current],
      events: [{ id: 8, ticketKey: current.key, eventType: 'ticket.updated', at: 8, actor: { id: 'user-ada', type: 'user' } }],
    });
    api.patchTicket = async () => { throw new TrackerError('conflict', 'Stale', { current }); };
    const store = createTrackerStore(api);
    await store.loadTicket(current.key);
    const error = await store.updateTicket(current.key, { title: 'Local title' }).then(() => null, (caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'conflict', current, by: { name: 'Ada Lovelace', kind: 'user' } });
    expect(store.ticket(current.key)).toMatchObject({ conflict: current, conflictBy: { name: 'Ada Lovelace', kind: 'user' } });
    store.destroy();
  });

  it('shows an optimistic edit and restores the prior row after a failed request', async () => {
    const api = createMockTrackerApi({ tickets: [ticket()] });
    const store = createTrackerStore(api);
    await store.loadList();
    let markStarted!: () => void;
    let rejectRequest!: (error: Error) => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    api.patchTicket = async () => {
      markStarted();
      return new Promise((_resolve, reject) => { rejectRequest = reject; });
    };
    const edit = store.updateTicket('TAB-1', { title: 'Optimistic title' });
    await started;
    expect(store.ticket('TAB-1').ticket?.title).toBe('Optimistic title');
    expect(store.list().tickets[0].title).toBe('Optimistic title');
    expect(store.ticket('TAB-1').pending).toBe(true);
    rejectRequest(new TrackerError('forbidden', 'Denied'));
    await expect(edit).rejects.toMatchObject({ code: 'forbidden' });
    expect(store.ticket('TAB-1').ticket?.title).toBe('Original title');
    expect(store.list().tickets[0].title).toBe('Original title');
    expect(store.ticket('TAB-1').pending).toBe(false);
    store.destroy();
  });

  it('re-bases a conflict from the server and exposes the current ticket to the UI', async () => {
    const current = ticket({ title: 'Remote edit', updatedSeq: 8 });
    const api = createMockTrackerApi({ tickets: [ticket()] });
    const store = createTrackerStore(api);
    await store.loadList();
    api.patchTicket = async () => { throw new TrackerError('conflict', 'Stale', { current }); };
    await expect(store.updateTicket('TAB-1', { title: 'Local edit' })).rejects.toMatchObject({ code: 'conflict' });
    expect(store.ticket('TAB-1')).toMatchObject({ ticket: current, conflict: current, error: { code: 'conflict' }, pending: false });
    store.destroy();
  });

  it('keeps one feed timer for all watchers and stops it after the last unsubscribe', async () => {
    const api = createMockTrackerApi({ tickets: [ticket()] });
    const timers = timerRig();
    const store = createTrackerStore(api, { pollMs: 5000, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
    await store.loadTicket('TAB-1');
    await store.loadList();
    const unwatchTicket = store.watchTicket('TAB-1', () => undefined);
    const unwatchList = store.watchList({}, () => undefined);
    expect(timers.tasks.size).toBe(1);
    unwatchTicket();
    expect(timers.tasks.size).toBe(1);
    unwatchList();
    expect(timers.tasks.size).toBe(0);
    store.destroy();
  });

  it('refetches watched tickets on the first poll, so a change made between the load and that poll is not missed', async () => {
    const api = createMockTrackerApi({ tickets: [ticket()] });
    const timers = timerRig();
    const store = createTrackerStore(api, { pollMs: 5000, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
    await store.loadTicket('TAB-1');
    store.watchTicket('TAB-1', () => undefined);
    // someone else comments after this page loaded and before its first poll
    await api.addComment('TAB-1', { body: 'from the other page', clientId: 'bootstrap-comment-01' });
    expect(store.ticket('TAB-1').detail?.comments.map((comment) => comment.body)).not.toContain('from the other page');
    timers.fireNext();
    await flushMicrotasks();
    expect(store.ticket('TAB-1').detail?.comments.map((comment) => comment.body)).toContain('from the other page');
    store.destroy();
  });

  it('caches normalized list queries, paging, and facets', async () => {
    const seeded = [
      ticket({ id: 't1', key: 'TAB-1', updatedSeq: 1 }),
      ticket({ id: 't2', key: 'TAB-2', updatedSeq: 2, updatedAt: 3 }),
      ticket({ id: 't3', key: 'TAB-3', updatedSeq: 3, updatedAt: 4 }),
    ];
    const api = createMockTrackerApi({ tickets: seeded });
    const store = createTrackerStore(api);
    const query = { filter: ['state:todo'], limit: 2, includeFacets: true };
    const first = await store.loadList(query);
    expect(first.tickets).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    expect(first.facets?.states).toMatchObject([{ id: 'state-todo', count: 3 }]);
    const second = await store.loadMore(query);
    expect(second.tickets).toHaveLength(3);
    expect(store.list({ filter: ['STATE:TODO'], limit: 2, includeFacets: true }).tickets).toHaveLength(3);
    store.destroy();
  });

  it('backs off feed polling after failures and resets to pollMs after a successful poll', async () => {
    const api = createMockTrackerApi({ tickets: [ticket()] });
    const timers = timerRig();
    let feedCalls = 0;
    const originalFeed = api.feed;
    api.feed = async (since, options) => {
      feedCalls += 1;
      if (feedCalls === 1) throw new Error('temporarily unavailable');
      return originalFeed(since, options);
    };
    const store = createTrackerStore(api, { pollMs: 10, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
    await store.loadTicket('TAB-1');
    const unwatch = store.watchTicket('TAB-1', () => undefined);
    expect(timers.fireNext()).toBe(10);
    await flushMicrotasks();
    expect(feedCalls).toBe(1);
    expect([...timers.tasks.values()].map((task) => task.delay)).toEqual([20]);
    expect(timers.fireNext()).toBe(20);
    await flushMicrotasks();
    expect(feedCalls).toBe(2);
    expect([...timers.tasks.values()].map((task) => task.delay)).toEqual([10]);
    unwatch();
    store.destroy();
  });

  it('rejects create immediately offline and replays an existing-ticket edit after reconnect', async () => {
    const api = createMockTrackerApi({ tickets: [ticket()] });
    let online = false;
    const store = createTrackerStore(api, { isOnline: () => online });
    await store.loadList();
    await expect(store.createTicket({ title: 'Offline create' })).rejects.toMatchObject({ code: 'offline' });
    expect((await api.listTickets()).tickets).toHaveLength(1);

    const optimistic = await store.updateTicket('TAB-1', { title: 'Queued offline edit' });
    expect(optimistic.title).toBe('Queued offline edit');
    expect(store.ticket('TAB-1')).toMatchObject({ offlineQueued: true, pending: true });
    online = true;
    await store.replayOfflineQueue();
    expect((await api.getTicket('TAB-1')).ticket.title).toBe('Queued offline edit');
    expect(store.ticket('TAB-1')).toMatchObject({ offlineQueued: false, pending: false });
    store.destroy();
  });

  it('applies bulk edits optimistically and undoes them with the current sequence', async () => {
    const second = ticket({ id: 'ticket-2', key: 'TAB-2', title: 'Second ticket', updatedSeq: 4 });
    const api = createMockTrackerApi({ tickets: [ticket(), second] });
    const store = createTrackerStore(api);
    await store.loadList();
    const batch = await store.bulk(['TAB-1', 'TAB-2'], { priority: 'high' });
    expect(store.ticket('TAB-1').ticket?.priority).toBe('high');
    expect(store.ticket('TAB-2').ticket?.priority).toBe('high');
    const undone = await store.undo(batch);
    expect(undone.results.every((result) => result.ok)).toBe(true);
    expect((await api.getTicket('TAB-1')).ticket.priority).toBe('none');
    expect((await api.getTicket('TAB-2')).ticket.priority).toBe('none');
    store.destroy();
  });

  it('bulk patches state as one undo batch and the bounded stack redoes successful edits', async () => {
    const second = ticket({ id: 'ticket-2', key: 'TAB-2', title: 'Second ticket', updatedSeq: 4 });
    const api = createMockTrackerApi({ tickets: [ticket(), second], now: () => 100 });
    const store = createTrackerStore(api, { now: () => 100 });
    const stack = createUndoStack(store);
    const batch = await store.bulk(['TAB-1', 'TAB-2'], { state: 'done' });
    expect(Object.keys(batch.before)).toEqual(['TAB-1', 'TAB-2']);
    expect(batch.before['TAB-1'].patch).toEqual({ state: 'todo' });
    expect(batch.before['TAB-2'].patch).toEqual({ state: 'todo' });
    stack.push(batch);
    expect(stack.canUndo()).toBe(true);
    expect(stack.canRedo()).toBe(false);
    const undone = await stack.undo();
    expect(undone?.results.every((result) => result.ok)).toBe(true);
    expect(store.ticket('TAB-1').ticket?.state.key).toBe('todo');
    expect(store.ticket('TAB-2').ticket?.state.key).toBe('todo');
    expect(stack.canUndo()).toBe(false);
    expect(stack.canRedo()).toBe(true);
    const redone = await stack.redo();
    expect(redone?.results.every((result) => result.ok)).toBe(true);
    expect(store.ticket('TAB-1').ticket?.state.key).toBe('done');
    expect(store.ticket('TAB-2').ticket?.state.key).toBe('done');
    expect(stack.canRedo()).toBe(false);
    expect(stack.canUndo()).toBe(true);
    store.destroy();
  });

  it('retains a conflicted batch on the undo stack for resolution and caps history at 50 batches', async () => {
    const api = createMockTrackerApi({ tickets: [ticket()] });
    const store = createTrackerStore(api);
    const stack = createUndoStack(store);
    const batch = await store.bulk(['TAB-1'], { priority: 'high' });
    stack.push(batch);
    api.patchTicket = async () => { throw new TrackerError('conflict', 'Remote edit', { current: ticket({ priority: 'urgent', updatedSeq: 20 }) }); };
    const result = await stack.undo();
    expect(result?.results[0]).toMatchObject({ ok: false, error: 'conflict' });
    expect(stack.canUndo()).toBe(true);
    expect(stack.canRedo()).toBe(false);
    store.destroy();

    const seen: string[] = [];
    const fakeStack = createUndoStack({
      async undo(item) { seen.push(item.batchId); return { batchId: item.batchId, results: Object.keys(item.before).map((key) => ({ key, ok: true })), before: {} }; },
      async redo(item) { return { batchId: item.batchId, results: Object.keys(item.before).map((key) => ({ key, ok: true })), before: {} }; },
    });
    for (let index = 0; index <= 50; index += 1) {
      fakeStack.push({ batchId: String(index), before: { [`TAB-${index + 1}`]: { patch: { title: String(index) }, updatedSeq: index } } });
    }
    for (let index = 0; index < 51; index += 1) await fakeStack.undo();
    expect(seen).toHaveLength(50);
    expect(seen[0]).toBe('50');
    expect(seen.at(-1)).toBe('1');
    expect(fakeStack.canUndo()).toBe(false);
  });

  it('adds and updates projects, milestones, and saved views in the metadata cache', async () => {
    const api = createMockTrackerApi({ tickets: [ticket()], now: () => 100 });
    const store = createTrackerStore(api, { now: () => 100 });
    await store.loadMeta();
    const project = await store.createProject({ name: 'Payments', state: 'planned', ownerId: 'me' });
    expect(store.snapshot().meta?.projects).toContainEqual(expect.objectContaining({ id: project.id, name: 'Payments' }));
    const milestone = await store.createMilestone(project.id, { name: 'Launch', due: '2026-11-01' });
    expect(store.snapshot().meta?.milestones).toContainEqual(expect.objectContaining({ id: milestone.id, projectId: project.id }));
    await store.updateProject(project.id, { name: 'Payments v2', state: 'started' });
    await store.updateMilestone(milestone.id, { due: null, state: 'started' });
    expect((await store.listProjects()).map((item) => item.name)).toContain('Payments v2');
    expect((await store.listMilestones(project.id))[0]).toMatchObject({ id: milestone.id, due: null, state: 'started' });

    const view = await store.createView({ name: 'Todo', filter: ['state:todo'] });
    expect(store.snapshot().meta?.views).toContainEqual({ id: view.id, name: 'Todo', shared: false, mine: true });
    expect((await store.listViews()).map((item) => item.id)).toContain(view.id);
    expect((await store.runView(view.id)).tickets).toHaveLength(1);
    await store.updateView(view.id, { name: 'Current todo', shared: true });
    expect(store.snapshot().meta?.views).toContainEqual({ id: view.id, name: 'Current todo', shared: true, mine: true });
    await store.deleteView(view.id);
    expect(store.snapshot().meta?.views).not.toContainEqual(expect.objectContaining({ id: view.id }));
    store.destroy();
  });

  it('honors meta and server read-only responses and disables later writers', async () => {
    const writableMeta = await createMockTrackerApi().meta();
    const readonlyMeta = { ...writableMeta, me: { userId: 'user-me', canWrite: false } };
    const api = createMockTrackerApi({ meta: readonlyMeta, tickets: [ticket()] });
    const store = createTrackerStore(api);
    await store.loadMeta();
    await store.loadList();
    await expect(store.updateTicket('TAB-1', { title: 'Denied' })).rejects.toMatchObject({ code: 'read_only' });
    expect(store.snapshot().readOnly).toBe(true);
    store.destroy();

    const writableApi = createMockTrackerApi({ tickets: [ticket()] });
    const serverLocked = createTrackerStore(writableApi);
    await serverLocked.loadList();
    writableApi.patchTicket = async () => { throw new TrackerError('read_only', 'Workspace locked'); };
    await expect(serverLocked.updateTicket('TAB-1', { title: 'Denied' })).rejects.toMatchObject({ code: 'read_only' });
    expect(serverLocked.snapshot().readOnly).toBe(true);
    serverLocked.destroy();
  });

  it('resolves chip keys with at most four concurrent ticket calls', async () => {
    const api = createMockTrackerApi();
    let active = 0;
    let maximum = 0;
    api.getTicket = async (key) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      return { ticket: ticket({ id: key, key }), comments: [], events: [], subscribed: false };
    };
    const store = createTrackerStore(api);
    const resolver = createTrackerKeyResolver(store);
    await resolver.resolveKeys(['TAB-1', 'TAB-2', 'TAB-3', 'TAB-4', 'TAB-5', 'TAB-6']);
    expect(maximum).toBe(4);
    expect(store.ticket('TAB-6').ticket?.key).toBe('TAB-6');
    resolver.destroy();
    store.destroy();
  });

  it('negatively caches missing chip keys for 30 seconds', async () => {
    const api = createMockTrackerApi();
    let calls = 0;
    let now = 100;
    api.getTicket = async () => {
      calls += 1;
      throw new TrackerError('not_found', 'Not found', { status: 404 });
    };
    const store = createTrackerStore(api);
    const resolver = createTrackerKeyResolver(store, { now: () => now });
    await resolver.resolveKeys(['TAB-999']);
    await resolver.resolveKeys(['TAB-999']);
    expect(calls).toBe(1);
    now += 30_001;
    await resolver.resolveKeys(['TAB-999']);
    expect(calls).toBe(2);
    expect(store.ticket('TAB-999').ticket).toBeUndefined();
    resolver.destroy();
    store.destroy();
  });

  it('uses the ticket store resolvedKey to build a canonical alias URL', async () => {
    const canonical = ticket({ aliases: ['OLD-9'] });
    const api = createMockTrackerApi({ tickets: [canonical] });
    const store = createTrackerStore(api);
    const detail = await store.loadTicket('old-9');
    expect(detail.resolvedKey).toBe('TAB-1');
    expect(store.ticket('OLD-9').ticket?.key).toBe('TAB-1');
    expect(canonicalTrackerPath({ kind: 'ticket', key: 'OLD-9' }, detail.resolvedKey!)).toBe('/t/TAB-1');
    store.destroy();
  });
});

describe('a watcher that throws', () => {
  it('does not abort the mutation that notified it, and the other watchers still run', async () => {
    const api = createMockTrackerApi({ now: () => 1_000 });
    const errors: unknown[] = [];
    const store = createTrackerStore(api, { pollMs: 60_000, onListenerError: (error) => errors.push(error) });
    await store.loadMeta();
    const created = await store.createTicket({ title: 'Watchers', idempotencyKey: 'watcher-ticket-01' });
    await store.loadTicket(created.key);
    const seen: string[] = [];
    store.watchTicket(created.key, () => { throw new Error('broken watcher'); });
    store.watchTicket(created.key, (state) => seen.push(state.detail?.comments.map((comment) => comment.body).join(',') ?? ''));
    const comment = await store.addComment(created.key, 'still posted', 'watcher-comment-01');
    expect(comment.body).toBe('still posted');
    expect(seen.at(-1)).toContain('still posted');
    expect(errors.length).toBeGreaterThan(0);
    store.destroy();
  });
});
