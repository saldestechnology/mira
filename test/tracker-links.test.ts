import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { objectMarkup } from '../src/markup';
import { createTrackerStore, createHttpTrackerApi, TrackerError, type TrackerKanbanLink, type TrackerLinkKanbanInput, type TrackerLinkKanbanResult, type TrackerStore } from '../src/tracker-data';
import { createMockTrackerApi, type TrackerMockKanban } from '../src/tracker-mock';
import { canShowTrackerLinkAction, canShowTrackerUnlinkAction, hasRegisteredLinkDialog, hasRegisteredUnlinkConfirm, openRegisteredLinkDialog, openRegisteredUnlinkConfirm, registerLinkDialog, registerUnlinkConfirm, type LinkDialogContext, type UnlinkConfirmContext } from '../src/tracker/ui/link-seam';
import { bindLinkDialogModel, createLinkDialogModel } from '../src/tracker/ui/link-dialog-model';
import { safeObj } from '../src/safe-obj';
import { Store } from '../src/store';
import type { BaseObj } from '../src/types';

const lanes = [
  { id: 'lane-todo', name: 'To do' },
  { id: 'lane-review', name: 'In review' },
];
const states = [
  { id: 'state-todo', key: 'todo', name: 'To do', category: 'unstarted' as const },
  { id: 'state-review', key: 'in_review', name: 'In review', category: 'started' as const },
];
const suggestion = { map: { 'lane-todo': 'todo', 'lane-review': null }, unmappedLanes: ['lane-review'], existingCardCount: 2, nextKey: 'TAB-1', stateNotMapped: ['in_review'] };

function linkInput(overrides: Partial<TrackerLinkKanbanInput> = {}): TrackerLinkKanbanInput {
  return {
    boardId: 'board-1', kanbanId: 'kanban-1', mapping: { 'lane-todo': 'todo' }, createTickets: false,
    idempotencyKey: 'link-request-01', ...overrides,
  };
}

function uiLink(overrides: Partial<TrackerKanbanLink> = {}): TrackerKanbanLink {
  const mapping = [{ laneId: 'lane-1', stateKey: 'todo', stateId: 'state-todo' }];
  return {
    id: 'link-1', boardId: 'board-1', kanbanId: 'kanban-1', workflowId: 'workflow-1', mapping,
    map: { 'lane-1': 'todo' }, cardCount: 0, createdAt: 1, createdBy: 'user-me', ticketCount: 0, ...overrides,
  };
}

function mockKanban(): TrackerMockKanban {
  return {
    boardId: 'board-1', kanbanId: 'kanban-1',
    lanes: [
      { id: 'lane-todo', name: 'To do', stage: 'todo' },
      { id: 'lane-doing', name: 'Doing', stage: 'doing' },
      { id: 'lane-parked', name: 'Parked' },
    ],
    cards: [
      { id: 'card-1', laneId: 'lane-todo', title: 'Plan release', due: '2026-11-02' },
      { id: 'card-2', laneId: 'lane-doing', title: 'Check build', ownerId: 'user-me' },
      { id: 'card-3', laneId: 'lane-parked', title: 'Someday' },
    ],
  };
}

describe('tracker link dialog model', () => {
  it('binds submit to a store, reports created keys, and folds failures into errorCode', async () => {
    const result = { link: { id: 'l1' }, created: [{ cardId: 'c1', key: 'TAB-5' }, { cardId: 'c2', key: 'TAB-6' }], skipped: [] } as unknown as TrackerLinkKanbanResult;
    const linkKanban = vi.fn<(input: unknown) => Promise<TrackerLinkKanbanResult>>().mockResolvedValueOnce(result).mockRejectedValueOnce(new TrackerError('forbidden', 'Only board editors can link a kanban.')).mockRejectedValueOnce(new TrackerError('network', 'offline'));
    const model = createLinkDialogModel({ lanes, states, suggestion, existingCardCount: 2 });
    model.setMapping('lane-review', 'in_review');
    const bound = bindLinkDialogModel(model, { linkKanban }, { boardId: 'board-1', kanbanId: 'kanban-1' });
    await expect(bound.submit()).resolves.toEqual({ created: 2, firstKey: 'TAB-5', lastKey: 'TAB-6' });
    expect(bound.state).toMatchObject({ errorCode: null, submitting: false });
    expect(await bound.submit()).toBeNull();
    expect(bound.state).toMatchObject({ errorCode: 'forbidden', submitting: false });
    expect(bound.state.errors.general).toContain('Only board editors');
    expect(await bound.submit()).toBeNull();
    expect(bound.state.errorCode).toBe('offline');
  });

  it('requires a decision for an unmatched lane and allows an explicit skip', () => {
    const model = createLinkDialogModel({ lanes, states, suggestion, existingCardCount: 2 });
    expect(model.state).toMatchObject({ mapping: { 'lane-todo': 'todo' }, createTickets: true, canSubmit: false, skippedLanes: [] });
    expect(model.describeStateUse('todo')).toBe('Used by To do');
    expect(model.describeStateUse('in_review')).toBeNull();
    model.setMapping('lane-review', null);
    expect(model.state).toMatchObject({ canSubmit: true, skippedLanes: ['lane-review'] });
  });

  it('enforces one lane per state, sets create defaults, and lets the user change the choice', () => {
    const model = createLinkDialogModel({ lanes, states, suggestion, existingCardCount: 2 });
    model.setMapping('lane-review', 'todo');
    expect(model.state.canSubmit).toBe(false);
    expect(model.state.errors.lanes['lane-review']).toContain('already used by To do');
    model.setMapping('lane-review', 'in_review');
    expect(model.state.canSubmit).toBe(true);
    expect(model.state.errors.lanes).toEqual({});
    model.setCreateTickets(false);
    expect(model.state.createTickets).toBe(false);

    const empty = createLinkDialogModel({ lanes, states, suggestion: { map: {}, unmappedLanes: [], existingCardCount: 0, nextKey: null, stateNotMapped: [] }, existingCardCount: 0 });
    expect(empty.state.createTickets).toBe(false);
    expect(empty.state.canSubmit).toBe(false);
  });

  it('submits only mapped lanes and maps API errors to the affected lane', async () => {
    const model = createLinkDialogModel({ lanes, states, suggestion, existingCardCount: 2 });
    model.setMapping('lane-review', null);
    const link: TrackerKanbanLink = {
      ...uiLink({ map: { 'lane-todo': 'todo' }, mapping: [{ laneId: 'lane-todo', stateKey: 'todo', stateId: 'state-todo' }], cardCount: 1, ticketCount: 1 }),
    };
    const result: TrackerLinkKanbanResult = { link, created: [{ cardId: 'card-1', key: 'TAB-1' }], skipped: [{ cardId: 'card-2', reason: 'unmapped_lane' }], projectionPending: false };
    const linkKanban = vi.fn<(input: TrackerLinkKanbanInput) => Promise<TrackerLinkKanbanResult>>(async () => result);
    const store = { linkKanban } as Pick<TrackerStore, 'linkKanban'>;
    await expect(model.submit(store, { boardId: 'board-1', kanbanId: 'kanban-1' })).resolves.toEqual(result);
    expect(linkKanban).toHaveBeenCalledWith(expect.objectContaining({ boardId: 'board-1', kanbanId: 'kanban-1', mapping: { 'lane-todo': 'todo' }, createTickets: true }));
    const submitted = linkKanban.mock.calls[0][0];
    expect(submitted.idempotencyKey.length).toBeGreaterThanOrEqual(8);
    expect(submitted.idempotencyKey.length).toBeLessThanOrEqual(64);

    const failed = createLinkDialogModel({ lanes, states, suggestion, existingCardCount: 2 });
    failed.setMapping('lane-review', 'in_review');
    const rejectingStore = { linkKanban: vi.fn<() => Promise<TrackerLinkKanbanResult>>(async () => { throw new TrackerError('invalid_input', 'State no longer exists.', { path: 'mapping.lane-review' }); }) } as Pick<TrackerStore, 'linkKanban'>;
    await expect(failed.submit(rejectingStore, { boardId: 'board-1', kanbanId: 'kanban-1' })).resolves.toBeNull();
    expect(failed.state.errors).toEqual({ lanes: { 'lane-review': 'State no longer exists.' }, general: null });
    expect(failed.state.canSubmit).toBe(false);
  });

  it('reuses a valid idempotency key when the same dialog submission is retried', async () => {
    const model = createLinkDialogModel({ lanes, states, suggestion, existingCardCount: 2 });
    model.setMapping('lane-review', 'in_review');
    const result = { link: uiLink(), created: [], skipped: [], projectionPending: false } satisfies TrackerLinkKanbanResult;
    const inputs: TrackerLinkKanbanInput[] = [];
    const store = {
      async linkKanban(input: TrackerLinkKanbanInput) {
        inputs.push(input);
        if (inputs.length === 1) throw new TrackerError('network', 'Connection lost.');
        return result;
      },
    } as Pick<TrackerStore, 'linkKanban'>;
    await expect(model.submit(store, { boardId: 'board-1', kanbanId: 'kanban-1' })).resolves.toBeNull();
    await expect(model.submit(store, { boardId: 'board-1', kanbanId: 'kanban-1' })).resolves.toEqual(result);
    expect(inputs[0].idempotencyKey).toMatch(/^link-.{8,}$/u);
    expect(inputs[0].idempotencyKey.length).toBeLessThanOrEqual(64);
    expect(inputs[1].idempotencyKey).toBe(inputs[0].idempotencyKey);
  });

  it('folds the linked-kanban conflict and the 500-card limit into the dialog error state', async () => {
    const conflict = createLinkDialogModel({ lanes, states, suggestion, existingCardCount: 2 });
    conflict.setMapping('lane-review', 'in_review');
    const conflictStore = { linkKanban: async () => { throw new TrackerError('conflict', 'This kanban is already linked.', { path: 'kanbanId', status: 409 }); } } as Pick<TrackerStore, 'linkKanban'>;
    await expect(conflict.submit(conflictStore, { boardId: 'board-1', kanbanId: 'kanban-1' })).resolves.toBeNull();
    expect(conflict.state).toMatchObject({ errorCode: 'conflict', errors: { general: 'This kanban is already linked.' } });

    const limited = createLinkDialogModel({ lanes, states, suggestion, existingCardCount: 2 });
    limited.setMapping('lane-review', 'in_review');
    const limitedStore = { linkKanban: async () => { throw new TrackerError('limit_exceeded', 'Link without creating tickets, then create per card.', { path: 'createTickets', status: 413 }); } } as Pick<TrackerStore, 'linkKanban'>;
    await expect(limited.submit(limitedStore, { boardId: 'board-1', kanbanId: 'kanban-1' })).resolves.toBeNull();
    expect(limited.state).toMatchObject({ errorCode: 'other', showServerMessage: true, errors: { general: 'Link without creating tickets, then create per card.' } });
  });
});

describe('tracker link mock and store', () => {
  it('normalizes suggestions, validates mappings, returns contract skip reasons, replays idempotently, and unlinks once', async () => {
    const kanban = mockKanban();
    kanban.cards.push(
      { id: 'card-empty', laneId: 'lane-todo', title: '' },
      { id: 'card-linked', laneId: 'lane-doing', title: 'Already tracked', linkedTicketKey: 'TAB-99' },
    );
    const api = createMockTrackerApi({ kanbans: [kanban], now: () => Date.UTC(2026, 9, 10) });
    const suggested = await api.suggestLinkMapping('board-1', 'kanban-1');
    expect(suggested).toMatchObject({
      map: { 'lane-todo': 'todo', 'lane-doing': 'in_progress' },
      unmappedLanes: ['lane-parked'], existingCardCount: 5,
      stateNotMapped: ['in_review', 'done', 'cancelled'], nextKey: 'TAB-1',
    });
    await expect(api.linkKanban(linkInput({ mapping: { 'lane-todo': 'todo', 'lane-doing': 'todo' }, createTickets: true })))
      .rejects.toMatchObject({ code: 'invalid_input', path: 'mapping.lane-doing' });

    const input = linkInput({ mapping: { 'lane-todo': 'todo', 'lane-doing': 'in_progress' }, createTickets: true, idempotencyKey: 'link-create-01' });
    const linked = await api.linkKanban(input);
    expect(linked.created.map((item) => item.key)).toEqual(['TAB-1', 'TAB-2']);
    expect(linked.link).toMatchObject({ cardCount: 2, ticketCount: 2, map: input.mapping, workflowId: 'workflow-default' });
    expect(linked.skipped).toEqual([
      { cardId: 'card-3', reason: 'unmapped_lane' },
      { cardId: 'card-empty', reason: 'empty_title' },
      { cardId: 'card-linked', reason: 'already_linked' },
    ]);
    expect(linked.projectionPending).toBe(false);
    expect(await api.linkKanban(input)).toEqual(linked);
    expect((await api.listLinks('board-1')).links).toEqual([linked.link]);
    await expect(api.linkKanban(linkInput({ idempotencyKey: 'link-create-02' }))).rejects.toMatchObject({ code: 'conflict', path: 'kanbanId' });
    expect(await api.unlinkKanban(linked.link.id)).toMatchObject({ link: { id: linked.link.id, removedAt: expect.any(Number) }, unlinked: 2, projectionPending: false });
    await expect(api.unlinkKanban(linked.link.id)).rejects.toMatchObject({ code: 'not_found', status: 404 });
    expect((await api.listLinks('board-1')).links).toEqual([]);
    expect((await api.listTickets()).tickets.map((ticket) => ticket.key)).toEqual(['TAB-1', 'TAB-2']);
  });

  it('creates a ticket for a later card and enforces the 500-ticket batch limit', async () => {
    const api = createMockTrackerApi({ kanbans: [mockKanban()] });
    const linked = await api.linkKanban(linkInput({ mapping: { 'lane-todo': 'todo', 'lane-doing': 'in_progress' }, createTickets: false }));
    const created = await api.createTicketForCard(linked.link.id, 'card-1');
    expect(created).toMatchObject({ cardId: 'card-1', ticket: { key: 'TAB-1', state: { key: 'todo' } }, projectionPending: false });
    expect((await api.listLinks('board-1')).links[0]).toMatchObject({ cardCount: 1, ticketCount: 1 });
    await expect(api.createTicketForCard(linked.link.id, 'card-1')).rejects.toMatchObject({ code: 'conflict', status: 409 });
    await expect(api.createTicketForCard(linked.link.id, 'card-3')).rejects.toMatchObject({ code: 'invalid_input', path: 'cardId' });

    const largeKanban = mockKanban();
    largeKanban.cards = Array.from({ length: 501 }, (_, index) => ({ id: `card-${index}`, laneId: 'lane-todo', title: `Card ${index}` }));
    const limitedApi = createMockTrackerApi({ kanbans: [largeKanban] });
    await expect(limitedApi.linkKanban(linkInput({ createTickets: true, idempotencyKey: 'link-over-limit' })))
      .rejects.toMatchObject({ code: 'limit_exceeded', path: 'createTickets', status: 413 });
    expect((await limitedApi.listLinks('board-1')).links).toEqual([]);
  });

  it('caches links per board, refreshes created ticket caches, and marks the store read-only', async () => {
    const api = createMockTrackerApi({ kanbans: [mockKanban()] });
    const listLinks = vi.spyOn(api, 'listLinks');
    const store = createTrackerStore(api, { now: () => 1000, isOnline: () => true });
    await store.listLinks('board-1');
    await store.listLinks('board-1');
    expect(listLinks).toHaveBeenCalledTimes(1);
    const linked = await store.linkKanban(linkInput({ mapping: { 'lane-todo': 'todo' }, createTickets: true }));
    expect(store.ticket(linked.created[0].key).detail?.ticket.key).toBe(linked.created[0].key);
    expect((await store.listLinks('board-1')).map((item) => item.id)).toEqual([linked.link.id]);
    await store.unlinkKanban(linked.link.id);
    expect(await store.listLinks('board-1')).toEqual([]);
    store.destroy();

    const readOnlyApi = createMockTrackerApi({ kanbans: [mockKanban()], meta: {
      enabled: true, trackerId: 'tracker-demo', prefix: 'TAB', states: [
        { id: 'state-todo', key: 'todo', name: 'To do', category: 'unstarted', position: 0 },
        { id: 'state-review', key: 'in_review', name: 'In review', category: 'started', position: 1 },
      ], labels: [], members: [], me: { userId: 'reader', canWrite: false },
    } });
    const readOnlyStore = createTrackerStore(readOnlyApi, { isOnline: () => true });
    await expect(readOnlyStore.linkKanban(linkInput({ mapping: {}, createTickets: false }))).rejects.toMatchObject({ code: 'read_only' });
    expect(readOnlyStore.snapshot().readOnly).toBe(true);
    readOnlyStore.destroy();
  });

  it('creates a later card ticket through the store and refreshes its ticket and link count', async () => {
    const api = createMockTrackerApi({ kanbans: [mockKanban()] });
    const store = createTrackerStore(api, { isOnline: () => true });
    const linked = await store.linkKanban(linkInput({ mapping: { 'lane-todo': 'todo', 'lane-doing': 'in_progress' }, createTickets: false }));
    const result = await store.createTicketForCard(linked.link.id, 'card-1');
    expect(store.ticket(result.ticket.key).detail?.ticket.key).toBe(result.ticket.key);
    expect(await store.listLinks('board-1')).toMatchObject([{ id: linked.link.id, cardCount: 1, ticketCount: 1 }]);
    store.destroy();
  });
});

describe('tracker link HTTP API', () => {
  it('normalizes contract links and suggestions and uses the link, unlink, and per-card routes', async () => {
    const wireLink = {
      id: 'link-1', boardId: 'board-1', kanbanId: 'kanban-1', workflowId: 'workflow-1',
      mapping: [{ laneId: 'lane-1', stateKey: 'todo', stateId: 'state-todo' }], cardCount: 1, createdAt: 1, createdBy: 'user-me',
    };
    const link = uiLink({ mapping: wireLink.mapping, map: { 'lane-1': 'todo' }, cardCount: 1, ticketCount: 1 });
    const body = { boardId: 'board-1', kanbanId: 'kanban-1', mapping: { 'lane-1': 'todo' }, createTickets: true, project: 'Launch', labels: ['design'], idempotencyKey: 'link-request-01' };
    const replies: unknown[] = [
      { links: [wireLink] },
      { links: [wireLink] },
      {
        mapping: { 'lane-1': 'todo', 'lane-2': null },
        lanes: [{ laneId: 'lane-1', name: 'To do', stateKey: 'todo' }, { laneId: 'lane-2', name: 'Review', stateKey: null }],
        stateNotMapped: ['done'], nextKey: 'TAB-5', cardCount: 3,
      },
      { link: wireLink, created: [{ cardId: 'card-1', ticket: { key: 'TAB-5' } }], skipped: [{ cardId: 'card-2', reason: 'empty_title' }], projectionPending: true },
      { link: { ...wireLink, removedAt: 4 }, unlinked: 1, projectionPending: false },
      { ticket: { key: 'TAB-9' }, cardId: 'card/9', projectionPending: true },
    ];
    const calls: Array<{ path: string; method: string; body?: unknown; headers: Headers }> = [];
    const api = createHttpTrackerApi(async (input, init = {}) => {
      calls.push({ path: String(input), method: String(init.method ?? 'GET'), body: init.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init.headers) });
      return new Response(JSON.stringify(replies[calls.length - 1]), { status: calls.length === 4 || calls.length === 6 ? 201 : 200 });
    });
    expect(await api.listLinks('board & one')).toEqual({ links: [link] });
    await api.listLinks('board-1', { kanbanId: 'kanban-1' });
    const suggested = await api.suggestLinkMapping('board-1', 'kanban/1');
    expect(suggested).toEqual({ map: { 'lane-1': 'todo' }, unmappedLanes: ['lane-2'], existingCardCount: 3, nextKey: 'TAB-5', stateNotMapped: ['done'] });
    const linked = await api.linkKanban(body);
    expect(linked).toMatchObject({ created: [{ cardId: 'card-1', key: 'TAB-5' }], skipped: [{ cardId: 'card-2', reason: 'empty_title' }], projectionPending: true });
    const unlinked = await api.unlinkKanban('link/1');
    expect(unlinked).toMatchObject({ link: { id: 'link-1', removedAt: 4, ticketCount: 1 }, unlinked: 1, projectionPending: false });
    const cardTicket = await api.createTicketForCard('link/1', 'card/9');
    expect(cardTicket).toMatchObject({ ticket: { key: 'TAB-9' }, cardId: 'card/9', projectionPending: true });
    expect(calls.map(({ method, path }) => `${method} ${path.split('?')[0]}`)).toEqual([
      'GET /api/tracker/links', 'GET /api/tracker/links', 'GET /api/tracker/links/suggest', 'POST /api/tracker/links',
      'DELETE /api/tracker/links/link%2F1', 'POST /api/tracker/links/link%2F1/cards',
    ]);
    expect(new URL(calls[0].path, 'https://tabula.test').searchParams.get('boardId')).toBe('board & one');
    expect(new URL(calls[1].path, 'https://tabula.test').searchParams.get('kanbanId')).toBe('kanban-1');
    expect(new URL(calls[2].path, 'https://tabula.test').searchParams.get('kanbanId')).toBe('kanban/1');
    expect(calls[3].body).toEqual(body);
    expect(calls[3].headers.get('x-tabula')).toBe('1');
    expect(calls[5].body).toMatchObject({ cardId: 'card/9', idempotencyKey: expect.any(String) });
    expect((calls[5].body as { idempotencyKey: string }).idempotencyKey.length).toBeGreaterThanOrEqual(8);
    expect((calls[5].body as { idempotencyKey: string }).idempotencyKey.length).toBeLessThanOrEqual(64);

    const invalid = createHttpTrackerApi(async () => new Response(JSON.stringify({ error: 'invalid_input', message: 'Map changed.', path: 'mapping.lane-1' }), { status: 400 }));
    await expect(invalid.linkKanban(body)).rejects.toMatchObject({ code: 'invalid_input', path: 'mapping.lane-1', message: 'Map changed.' });
    const conflict = createHttpTrackerApi(async () => new Response(JSON.stringify({ error: 'conflict', message: 'Already linked.', path: 'kanbanId' }), { status: 409 }));
    await expect(conflict.linkKanban(body)).rejects.toMatchObject({ code: 'conflict', path: 'kanbanId' });
    const limited = createHttpTrackerApi(async () => new Response(JSON.stringify({ error: 'limit_exceeded', message: 'Too many cards.', path: 'createTickets' }), { status: 413 }));
    await expect(limited.linkKanban(body)).rejects.toMatchObject({ code: 'limit_exceeded', path: 'createTickets', status: 413 });
  });
});

describe('linked card projection and entry gating', () => {
  it('accepts sanitized tracker projection from the document and blocks ordinary client writes', () => {
    const store = new Store(new Y.Doc());
    const card = { id: 'card-1', type: 'card', x: 0, y: 0, w: 220, h: 72, rotation: 0, z: 'a0', text: 'plain' } as BaseObj;
    const container = { id: 'kanban-1', type: 'container', layout: 'kanban', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a1' } as BaseObj;
    store.transact(() => { store.create(card); store.create(container); });
    expect(store.get(card.id)).not.toHaveProperty('extKey');
    expect(store.get(container.id)).not.toHaveProperty('ext');
    const cardMap = store.objects.get(card.id)!;
    const containerMap = store.objects.get(container.id)!;
    store.doc.transact(() => {
      cardMap.set('extProvider', 'tabula');
      cardMap.set('extKey', 'TAB-23');
      cardMap.set('extUrl', 'https://tracker.example/t/TAB-23');
      cardMap.set('trackerId', 'tracker-1');
      cardMap.set('tracker', { ticketId: 'ticket-23', title: 'Server title', state: { key: 'todo', name: 'To do', category: 'unstarted' } });
      containerMap.set('ext', { provider: 'tabula', tracker: 'tracker-1', map: { 'lane-1': 'todo', 'bad lane': 'unsafe' } });
    }, 'server');
    const projectedCard = safeObj(store.get(card.id)! as BaseObj) as BaseObj & { tracker?: { title?: string; state?: { key?: string; name?: string } } };
    const projectedContainer = safeObj(store.get(container.id)! as BaseObj);
    expect(projectedCard).toMatchObject({ extProvider: 'tabula', extKey: 'TAB-23', extUrl: 'https://tracker.example/t/TAB-23', trackerId: 'tracker-1' });
    expect(projectedCard.tracker).toMatchObject({ title: 'Server title', state: { key: 'todo', name: 'To do' } });
    expect(projectedContainer.ext).toEqual({ provider: 'tabula', tracker: 'tracker-1', map: { 'lane-1': 'todo' } });
    store.transact(() => {
      store.update(card.id, { extKey: 'TAB-999', extUrl: 'https://attacker.example', trackerId: 'attacker', tracker: { ticketId: 'forged' } });
      store.update(container.id, { ext: { provider: 'tabula', tracker: 'attacker', map: {} } });
    });
    expect(store.get(card.id)).toMatchObject({ extKey: 'TAB-23', trackerId: 'tracker-1' });
    expect((store.get(container.id) as BaseObj).ext).toEqual({ provider: 'tabula', tracker: 'tracker-1', map: { 'lane-1': 'todo', 'bad lane': 'unsafe' } });
  });

  it('draws escaped tracker key, title, state badge, and unmapped marker', () => {
    const container = {
      id: 'kanban', type: 'container', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a0', layout: 'kanban',
      ext: { provider: 'tabula', tracker: 'tracker-1', map: { 'lane-1': 'todo', 'lane-2': 'in_review' } },
    } as BaseObj;
    const lane = { id: 'lane-1', type: 'lane', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a1', parent: 'kanban', rank: 'a0@kanban' } as BaseObj;
    const card = {
      id: 'card-1', type: 'card', x: 0, y: 0, w: 250, h: 100, rotation: 0, z: 'a2', parent: 'lane-1', rank: 'a0@lane-1',
      text: 'stale title', extProvider: 'tabula', extKey: 'TAB-23', trackerId: 'tracker-1',
      tracker: { ticketId: 'ticket-23', title: 'Fix <script> & login', state: { id: 'state-review', key: 'in_review', name: 'Review <img>&', category: 'started' } },
    } as BaseObj;
    const objects = new Map([[container.id, container], [lane.id, lane]]);
    const markup = objectMarkup(card, { get: (id) => objects.get(id) });
    expect(markup).toContain('TAB-23');
    expect(markup).toContain('Fix &lt;script&gt; &amp; login');
    expect(markup).toContain('Review &lt;img&gt;&amp;');
    expect(markup).toContain('Unmapped state');
    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('<img>');
  });

  it('shows link actions only when tracker access, the relevant registration, and an app handler exist', () => {
    const base = { trackerEnabled: true, linked: false, registered: false, ready: true };
    expect(canShowTrackerLinkAction(base)).toBe(false);
    expect(canShowTrackerLinkAction({ ...base, registered: true })).toBe(true);
    expect(canShowTrackerLinkAction({ ...base, trackerEnabled: false, registered: true })).toBe(false);
    expect(canShowTrackerLinkAction({ ...base, linked: true, registered: true })).toBe(false);
    expect(canShowTrackerUnlinkAction({ ...base, linked: true, registered: true })).toBe(true);
    expect(canShowTrackerUnlinkAction({ ...base, linked: true, registered: true, ready: false })).toBe(false);

    const linkOpen = vi.fn<(context: LinkDialogContext) => void>();
    const unlinkOpen = vi.fn<(context: UnlinkConfirmContext) => void>();
    const stopLink = registerLinkDialog(linkOpen);
    const stopUnlink = registerUnlinkConfirm(unlinkOpen);
    expect(hasRegisteredLinkDialog()).toBe(true);
    expect(hasRegisteredUnlinkConfirm()).toBe(true);
    const seamBase = { boardId: 'board-1', kanbanId: 'kanban-1', store: {} as never };
    const context = { ...seamBase, kanban: { name: 'Kanban', lanes: [], cardCount: 0 } };
    expect(openRegisteredLinkDialog(context)).toBe(true);
    const link = uiLink({ map: {}, mapping: [] });
    expect(openRegisteredUnlinkConfirm({ ...seamBase, link })).toBe(true);
    expect(linkOpen).toHaveBeenCalledWith(context);
    expect(unlinkOpen).toHaveBeenCalledWith({ ...seamBase, link });
    stopLink();
    stopUnlink();
    expect(hasRegisteredLinkDialog()).toBe(false);
    expect(hasRegisteredUnlinkConfirm()).toBe(false);
  });
});
