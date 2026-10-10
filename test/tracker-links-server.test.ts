import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { openDirectory } from '../server/directory.mjs';
import { createTicketForCard, linkKanban, listLinks, suggestMapping, unlinkKanban } from '../server/tracker/links.mjs';
import {
  createTrackerProjectionWorker, drainTicketProjection, retryTrackerProjectionOnRoomLoad,
  writeTrackerContainerLink, writeTrackerContainerUnlink,
} from '../server/tracker/projection.mjs';
import { transitionTicket } from '../server/tracker/tickets.mjs';

const objs = (doc: { getMap(name: string): unknown }): any => doc.getMap('objects');

const directories: ReturnType<typeof openDirectory>[] = [];
const documents: Y.Doc[] = [];
const owner = { type: 'user', userId: 'owner-u', user: { id: 'owner-u', role: 'member', name: 'Owner' } };
const viewer = { type: 'user', userId: 'viewer-u', user: { id: 'viewer-u', role: 'member', name: 'Viewer' } };
const guest = { type: 'user', userId: 'guest-u', user: { id: 'guest-u', role: 'guest', name: 'Guest' } };
const outsider = { type: 'user', userId: 'outside-u', user: { id: 'outside-u', role: 'member', name: 'Outside' } };
const mapping = { 'lane-todo': 'todo', 'lane-done': 'done' };

afterEach(() => {
  for (const doc of documents.splice(0)) doc.destroy();
  for (const directory of directories.splice(0)) directory.close();
});

function put(doc: Y.Doc, id: string, type: string, fields: Record<string, unknown> = {}) {
  objs(doc).set(id, new Y.Map(Object.entries({ id, type, ...fields })));
}

function fixture(cards = 2) {
  const directory = openDirectory(':memory:');
  directories.push(directory);
  for (const [id, role, name] of [
    ['owner-u', 'member', 'Owner'], ['member-u', 'member', 'Member'], ['viewer-u', 'member', 'Viewer'], ['guest-u', 'guest', 'Guest'], ['outside-u', 'member', 'Outside'],
  ]) {
    directory.db.prepare('INSERT INTO users (id, email, name, role, disabled, created_at) VALUES (?, ?, ?, ?, 0, 1)')
      .run(id, `${id}@example.test`, name, role);
  }
  directory.createBoard({ id: 'board-1', title: 'Board', ownerId: 'owner-u' });
  directory.shareBoard('board-1', { principalType: 'user', principalId: 'viewer-u', role: 'viewer' });
  directory.shareBoard('board-1', { principalType: 'user', principalId: 'guest-u', role: 'editor' });
  directory.db.prepare('INSERT INTO labels (id, name, color, created_at) VALUES (?, ?, ?, ?)').run('label-extra', 'Extra', '#AABBCC', 1);
  directory.db.prepare('INSERT INTO labels (id, name, color, created_at) VALUES (?, ?, ?, ?)').run('label-design', 'Design', '#112233', 1);
  directory.db.prepare('INSERT INTO projects (id, name, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('project-1', 'Pilot', 'started', 1, 1);
  const doc = new Y.Doc();
  documents.push(doc);
  put(doc, 'kanban-1', 'container', { layout: 'kanban' });
  put(doc, 'lane-todo', 'lane', { parent: 'kanban-1', name: 'To do', stage: 'todo', rank: 'a0@kanban-1' });
  put(doc, 'lane-done', 'lane', { parent: 'kanban-1', name: 'Done', stage: 'done', rank: 'a1@kanban-1' });
  put(doc, 'lane-free', 'lane', { parent: 'kanban-1', name: 'Someday', rank: 'a2@kanban-1' });
  for (let i = 0; i < cards; i++) {
    const id = `card-${i + 1}`;
    const parent = i === 1 ? 'lane-free' : 'lane-todo';
    put(doc, id, 'card', {
      parent, rank: `a${i}@${parent}`, text: `Plan ${i + 1}`, desc: 'Details', due: '2026-11-01',
      ownerId: 'member-u', labels: ['board-design'],
    });
  }
  doc.getMap('labels').set('board-design', new Y.Map([
    ['id', 'board-design'], ['name', 'Design'], ['color', '#112233'],
  ]));
  const roomAccess = {
    read: (_boardId: string, fn: (value: Y.Doc) => unknown) => fn(doc),
    write: (_boardId: string, _origin: string, fn: (value: Y.Doc) => unknown) => {
      let result: unknown;
      doc.transact(() => { result = fn(doc); }, 'tracker-test');
      return result;
    },
  };
  return { directory, doc, roomAccess };
}

function makeLink(fx: ReturnType<typeof fixture>, options: Record<string, unknown> = {}) {
  return linkKanban({
    directory: fx.directory, actor: owner, boardId: 'board-1', kanbanId: 'kanban-1',
    mapping, createTickets: true, project: 'Pilot', labels: ['Extra'],
    idempotencyKey: 'link-server-test-123', roomAccess: fx.roomAccess, now: 100, ...options,
  });
}

describe('tracker link commands', () => {
  it('creates tickets in the link transaction, replays idempotently, and projects later SQL state changes', () => {
    const fx = fixture();
    const result = makeLink(fx);
    expect(result.created).toHaveLength(1);
    expect(result.created[0].ticket).toMatchObject({
      key: 'TAB-1', title: 'Plan 1', description: 'Details', due: '2026-11-01', state: { key: 'todo' },
      assignee: { userId: 'member-u' }, project: { name: 'Pilot' },
      labels: [expect.objectContaining({ name: 'Design' }), expect.objectContaining({ name: 'Extra' })],
      links: [{ kind: 'card', boardId: 'board-1', kanbanId: 'kanban-1', cardId: 'card-1' }],
    });
    expect(result.skipped).toEqual([{ cardId: 'card-2', reason: 'unmapped_lane' }]);
    expect(fx.directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_projection_outbox').get()).toEqual({ n: 1 });
    const replay = makeLink(fx, { now: 200 });
    expect(replay).toMatchObject({ replayed: true, link: { id: result.link.id } });
    expect(fx.directory.db.prepare('SELECT COUNT(*) AS n FROM tickets').get()).toEqual({ n: 1 });

    expect(retryTrackerProjectionOnRoomLoad({ directory: fx.directory, roomAccess: fx.roomAccess, boardId: 'board-1', now: 100 }))
      .toMatchObject({ applied: 1, projectionPending: false });
    const changed = transitionTicket({ directory: fx.directory, actor: owner, key: 'TAB-1', state: 'done', source: 'test', now: 120 });
    expect(drainTicketProjection({ directory: fx.directory, roomAccess: fx.roomAccess, boardId: 'board-1', now: 120 }))
      .toMatchObject({ applied: 1, projectionPending: false });
    expect(objs(fx.doc).get('card-1')?.toJSON()).toMatchObject({
      parent: 'lane-done', extProvider: 'tabula', extKey: 'TAB-1',
      tracker: { state: { key: 'done' }, projectionSeq: changed.updatedSeq },
    });
    expect(listLinks({ directory: fx.directory, actor: viewer, boardId: 'board-1' }).links).toHaveLength(1);
  });

  it('rejects foreign lanes, duplicate state mappings, huge mappings, unknown states, and 501-card batches', () => {
    const fx = fixture();
    const base = { directory: fx.directory, actor: owner, boardId: 'board-1', kanbanId: 'kanban-1', roomAccess: fx.roomAccess };
    expect(() => linkKanban({ ...base, mapping: { foreign: 'todo' }, idempotencyKey: 'invalid-lane-123' }))
      .toThrow(expect.objectContaining({ code: 'invalid_input', path: 'mapping.foreign' }));
    expect(() => linkKanban({ ...base, mapping: { 'lane-todo': 'todo', 'lane-done': 'todo' }, idempotencyKey: 'duplicate-state-123' }))
      .toThrow(expect.objectContaining({ code: 'invalid_input', path: 'mapping.lane-done' }));
    expect(() => linkKanban({ ...base, mapping: { 'lane-todo': 'missing' }, idempotencyKey: 'unknown-state-123' }))
      .toThrow(expect.objectContaining({ code: 'invalid_input', path: 'mapping.lane-todo' }));
    const huge = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`lane-${i}`, 'todo']));
    expect(() => linkKanban({ ...base, mapping: huge, idempotencyKey: 'large-mapping-123' }))
      .toThrow(expect.objectContaining({ code: 'invalid_input', path: 'mapping' }));
    expect(fx.directory.db.prepare('SELECT COUNT(*) AS n FROM kanban_tracker_links').get()).toEqual({ n: 0 });

    const large = fixture(501);
    large.doc.transact(() => {
      for (let i = 1; i <= 501; i++) {
        const card = objs(large.doc).get(`card-${i}`);
        card?.set('parent', 'lane-todo');
        card?.set('rank', `a${i}@lane-todo`);
      }
    });
    expect(() => makeLink(large, { idempotencyKey: 'large-card-batch-123' }))
      .toThrow(expect.objectContaining({ code: 'limit_exceeded', path: 'createTickets' }));
    expect(large.directory.db.prepare('SELECT COUNT(*) AS n FROM kanban_tracker_links').get()).toEqual({ n: 0 });
  });

  it('requires board write access, forbids guests, and hides boards from non-members', () => {
    const fx = fixture();
    expect(() => linkKanban({
      directory: fx.directory, actor: viewer, boardId: 'board-1', kanbanId: 'kanban-1',
      mapping, idempotencyKey: 'viewer-request-123', roomAccess: fx.roomAccess,
    })).toThrow(expect.objectContaining({ code: 'forbidden' }));
    expect(() => listLinks({ directory: fx.directory, actor: guest, boardId: 'board-1' }))
      .toThrow(expect.objectContaining({ code: 'forbidden' }));
    expect(() => listLinks({ directory: fx.directory, actor: outsider, boardId: 'board-1' }))
      .toThrow(expect.objectContaining({ code: 'not_found' }));
  });

  it('creates one ticket for a later card and unlinks projection fields while retaining the ticket', () => {
    const fx = fixture(1);
    const link = makeLink(fx, { createTickets: false });
    put(fx.doc, 'card-late', 'card', { parent: 'lane-done', rank: 'a9@lane-done', text: 'Late card' });
    const created = createTicketForCard({
      directory: fx.directory, actor: owner, linkId: link.link.id, cardId: 'card-late',
      idempotencyKey: 'new-card-ticket-123', roomAccess: fx.roomAccess, now: 110,
    });
    expect(created.ticket).toMatchObject({ key: 'TAB-1', state: { key: 'done' } });
    expect(createTicketForCard({
      directory: fx.directory, actor: owner, linkId: link.link.id, cardId: 'card-late',
      idempotencyKey: 'new-card-ticket-123', roomAccess: fx.roomAccess, now: 120,
    })).toMatchObject({ replayed: true, ticket: { key: 'TAB-1' } });

    writeTrackerContainerLink({ roomAccess: fx.roomAccess, boardId: 'board-1', kanbanId: 'kanban-1', trackerId: 'trk_default', map: mapping, now: 110 });
    drainTicketProjection({ directory: fx.directory, roomAccess: fx.roomAccess, boardId: 'board-1', now: 110 });
    const removed = unlinkKanban({ directory: fx.directory, actor: owner, linkId: link.link.id, now: 200 });
    writeTrackerContainerUnlink({ roomAccess: fx.roomAccess, boardId: 'board-1', kanbanId: 'kanban-1', now: 200 });
    expect(drainTicketProjection({ directory: fx.directory, roomAccess: fx.roomAccess, boardId: 'board-1', now: 200 }))
      .toMatchObject({ projectionPending: false });
    expect(removed.unlinked).toBe(1);
    expect(fx.directory.db.prepare('SELECT COUNT(*) AS n FROM tickets').get()).toEqual({ n: 1 });
    expect(objs(fx.doc).get('kanban-1')?.toJSON()).not.toHaveProperty('ext');
    expect(objs(fx.doc).get('card-late')?.toJSON()).not.toHaveProperty('tracker');
    expect(objs(fx.doc).get('card-late')?.toJSON()).toMatchObject({ text: 'Late card', parent: 'lane-done' });

    const relinked = linkKanban({
      directory: fx.directory, actor: owner, boardId: 'board-1', kanbanId: 'kanban-1', mapping,
      createTickets: false, idempotencyKey: 'relink-card-key-123', roomAccess: fx.roomAccess, now: 210,
    });
    expect(createTicketForCard({
      directory: fx.directory, actor: owner, linkId: relinked.link.id, cardId: 'card-late',
      idempotencyKey: 'new-card-ticket-123', roomAccess: fx.roomAccess, now: 220,
    })).toMatchObject({ replayed: true, ticket: { key: 'TAB-1' } });
    expect(fx.directory.db.prepare('SELECT COUNT(*) AS n FROM tickets').get()).toEqual({ n: 1 });
  });

  it('backs off a failed room write and suggests unique state mappings', () => {
    const fx = fixture(1);
    makeLink(fx);
    let fail = true;
    const roomAccess = {
      ...fx.roomAccess,
      write: (boardId: string, origin: string, fn: (doc: Y.Doc) => unknown) => {
        if (fail) throw Object.assign(new Error('write failed'), { code: 'disk_full' });
        return fx.roomAccess.write(boardId, origin, fn);
      },
    };
    expect(drainTicketProjection({ directory: fx.directory, roomAccess, boardId: 'board-1', now: 100 }))
      .toMatchObject({ projectionPending: true });
    expect(fx.directory.db.prepare('SELECT attempts, next_attempt_at, last_error_code FROM ticket_projection_outbox').get())
      .toEqual({ attempts: 1, next_attempt_at: 1100, last_error_code: 'disk_full' });
    fail = false;
    const worker = createTrackerProjectionWorker({
      directory: fx.directory, roomAccess, now: () => 1100, timers: false,
    });
    expect(worker.tick())
      .toMatchObject({ projectionPending: false });
    expect(() => suggestMapping({ directory: fx.directory, actor: owner, boardId: 'board-1', kanbanId: 'kanban-1', roomAccess: fx.roomAccess }))
      .toThrow(/already linked/);
    const fresh = fixture(1);
    expect(suggestMapping({ directory: fresh.directory, actor: owner, boardId: 'board-1', kanbanId: 'kanban-1', roomAccess: fresh.roomAccess }))
      .toMatchObject({ mapping: { 'lane-todo': 'todo', 'lane-done': 'done' }, nextKey: 'TAB-1', cardCount: 1 });
  });
});
