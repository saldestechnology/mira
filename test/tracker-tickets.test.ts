import { afterEach, describe, expect, it } from 'vitest';
import { openDirectory } from '../server/directory.mjs';
import { OpsError } from '../server/board-ops.mjs';
import { allocateTicket } from '../server/tracker/ids.mjs';
import {
  commentTicket, createLabel, createTicket, findTicketByIdempotency, getTicket, listLabels, listStates, listTickets, searchTickets,
  transitionTicket, updateTicket,
} from '../server/tracker/tickets.mjs';

const opened: any[] = [];
const open = (): any => {
  const directory: any = openDirectory(':memory:');
  opened.push(directory);
  return directory;
};
function fixture() {
  const directory = open();
  const owner = directory.createUser({ email: 'owner@example.com', name: 'Owner', role: 'owner' });
  const actor = { id: owner.id, role: owner.role, name: owner.name };
  return { directory, owner, actor };
}
function caught(fn: () => unknown) {
  try { fn(); } catch (error) { return error as OpsError; }
  throw new Error('expected an OpsError');
}
function expectCode(fn: () => unknown, code: string) {
  const error = caught(fn);
  expect(error).toBeInstanceOf(OpsError);
  expect(error.code).toBe(code);
  return error;
}

afterEach(() => {
  for (const directory of opened.splice(0)) directory.close();
});

describe('tracker ticket commands', () => {
  it('supports states, labels, ticket creation, get, list and search with the frozen JSON shape', () => {
    const { directory, actor } = fixture();
    expect(listStates({ directory, actor })).toEqual([
      { id: 'st_todo', key: 'todo', name: 'To do', category: 'unstarted', position: 0, isDefault: true },
      { id: 'st_in_progress', key: 'in_progress', name: 'In progress', category: 'started', position: 1, isDefault: false },
      { id: 'st_in_review', key: 'in_review', name: 'In review', category: 'started', position: 2, isDefault: false },
      { id: 'st_done', key: 'done', name: 'Done', category: 'completed', position: 3, isDefault: false },
      { id: 'st_cancelled', key: 'cancelled', name: 'Cancelled', category: 'canceled', position: 4, isDefault: false },
    ]);
    const bug = createLabel({ directory, actor, name: 'Bug', color: '#AABBCC', now: 10 });
    expect(listLabels({ directory, actor })).toEqual([bug]);
    const ticket = createTicket({ directory, actor, title: 'A plain title', description: 'Markdown **body**', labels: ['bug'], now: 20 });
    expect(ticket).toMatchObject({
      key: 'TAB-1', trackerId: 'trk_default', title: 'A plain title', description: 'Markdown **body**',
      state: { id: 'st_todo', key: 'todo', name: 'To do', category: 'unstarted' }, priority: 'none',
      assignee: null, creator: { type: 'user', id: actor.id, name: 'Owner' }, labels: [{ id: bug.id, name: 'Bug', color: '#AABBCC' }],
      project: null, milestone: null, estimate: null, due: null, parent: null, relations: [], links: [], aliases: [], archivedAt: null,
      createdAt: 20, updatedAt: 20,
    });
    expect(Object.keys(ticket).sort()).toEqual([
      'aliases', 'archivedAt', 'assignee', 'createdAt', 'creator', 'description', 'due', 'estimate', 'id', 'key', 'labels',
      'links', 'milestone', 'parent', 'priority', 'project', 'relations', 'state', 'title', 'trackerId', 'updatedAt', 'updatedSeq',
    ].sort());
    expect(getTicket({ directory, actor, key: ticket.key })).toEqual(ticket);
    expect(searchTickets({ directory, actor, query: 'plain' }).entries[0]).toMatchObject({ key: ticket.key, title: ticket.title, project: null, due: null });
    expect(listTickets({ directory, actor }).entries.map((item: any) => item.key)).toEqual([ticket.key]);
  });

  it('looks up an MCP idempotency key for its token without writing', () => {
    const { directory, owner } = fixture();
    const actor = {
      type: 'mcp_token', tokenId: 'lookup-token', ownerUserId: owner.id,
      user: { id: owner.id, role: 'owner' }, tracker: 'write',
    };
    const key = 'mcp-create-key';
    const ticket = createTicket({ directory, actor, source: 'mcp', idempotencyKey: key, title: 'Idempotent ticket' });
    const count = directory.db.prepare('SELECT COUNT(*) AS n FROM tickets').get()!.n;

    expect(findTicketByIdempotency({ directory, actor, source: 'mcp', idempotencyKey: key })).toBe(true);
    expect(findTicketByIdempotency({
      directory, actor: { ...actor, tokenId: 'another-token' }, source: 'mcp', idempotencyKey: key,
    })).toBe(false);
    expect(directory.db.prepare('SELECT COUNT(*) AS n FROM tickets').get()!.n).toBe(count);
    expect(ticket.title).toBe('Idempotent ticket');
  });

  it('updates fields, transitions, comments, archives, restores, versions and event records', () => {
    const { directory, owner, actor } = fixture();
    const label = createLabel({ directory, actor, name: 'Urgent fix' });
    const parent = createTicket({ directory, actor, title: 'Parent task', now: 100 });
    const child = createTicket({ directory, actor, title: 'Child task', now: 200 });
    const updated = updateTicket({
      directory, actor, key: child.key, ifUpdatedSeq: child.updatedSeq, now: 300,
      patch: { title: 'Updated child', description: 'Detailed **description**', priority: 'high', assignee: 'me', labels: ['urgent fix'], due: '2026-10-31', parent: parent.key },
    });
    expect(updated).toMatchObject({
      title: 'Updated child', description: 'Detailed **description**', priority: 'high',
      assignee: { userId: owner.id, name: owner.name }, labels: [{ id: label.id, name: label.name }], due: '2026-10-31', parent: parent.key,
    });
    expect(directory.db.prepare('SELECT field, event_seq FROM ticket_field_versions WHERE ticket_id = ? ORDER BY field').all(child.id))
      .toEqual(['assignee', 'description', 'due', 'labels', 'milestone', 'parent', 'priority', 'project', 'state', 'title'].map((field) => ({
        field, event_seq: field === 'state' || field === 'milestone' || field === 'project' ? child.updatedSeq : updated.updatedSeq,
      })));

    const transitioned = transitionTicket({ directory, actor, key: child.key, state: 'In review', ifUpdatedSeq: updated.updatedSeq, now: 400 });
    expect(transitioned.state).toMatchObject({ key: 'in_review', name: 'In review', category: 'started' });
    const comment = commentTicket({ directory, actor, key: child.key, body: 'A separate comment **body**', now: 500 });
    expect(comment).toMatchObject({ ticketId: child.id, actorType: 'user', actorId: owner.id, author: 'Owner', body: 'A separate comment **body**', createdAt: 500 });
    expect(getTicket({ directory, actor, key: child.key })).not.toHaveProperty('comments');
    const archived = updateTicket({ directory, actor, key: child.key, patch: { archived: true }, now: 600 });
    expect(archived.archivedAt).toBe(600);
    const restored = updateTicket({ directory, actor, key: child.key, patch: { archived: false }, now: 700 });
    expect(restored.archivedAt).toBeNull();

    const events = directory.db.prepare('SELECT event_type, schema_version, before_json, after_json, details_json FROM ticket_events WHERE ticket_id = ? ORDER BY id').all(child.id);
    expect(events.map((event: any) => event.event_type)).toEqual(['created', 'updated', 'transitioned', 'commented', 'archived', 'restored']);
    expect(events.every((event: any) => event.schema_version === 1)).toBe(true);
    expect(JSON.parse(events[1].before_json)).toEqual({
      title: 'Child task', description: '', priority: 'none', assignee: null, labels: [], due: null, parent: null,
    });
    expect(JSON.parse(events[1].after_json)).toEqual({
      title: 'Updated child', description: 'Detailed **description**', priority: 'high', assignee: owner.id,
      labels: ['Urgent fix'], due: '2026-10-31', parent: parent.key,
    });
    expect(JSON.parse(events[3].details_json)).toEqual({ commentId: comment.id, length: 27 });
    expect(events[3].details_json).not.toContain(comment.body);
    expect(Object.keys(JSON.parse(events[1].before_json))).not.toContain('state');
    expect(Object.keys(JSON.parse(events[1].after_json))).not.toContain('secret');
  });

  it('detects stale ifUpdatedSeq writes and resolves assignees only by me, member name or email', () => {
    const { directory, actor } = fixture();
    const alice = directory.createUser({ email: 'alice@example.com', name: 'Alex', role: 'member' });
    const ticket = createTicket({ directory, actor, title: 'Conflict target' });
    const newer = updateTicket({ directory, actor, key: ticket.key, patch: { title: 'Newer title' } });
    expectCode(() => updateTicket({ directory, actor, key: ticket.key, patch: { description: 'stale' }, ifUpdatedSeq: ticket.updatedSeq }), 'conflict');
    expectCode(() => createTicket({ directory, actor, title: 'By id', assignee: alice.id }), 'invalid_input');
    expect(createTicket({ directory, actor, title: 'Unique name', assignee: 'Alex' }).assignee).toMatchObject({ userId: alice.id });
    const alex2 = directory.createUser({ email: 'alex2@example.com', name: 'Alex', role: 'member' });
    expect(alex2.id).not.toBe(alice.id);
    expectCode(() => createTicket({ directory, actor, title: 'Ambiguous after second member', assignee: 'Alex' }), 'invalid_input');
    expect(createTicket({ directory, actor, title: 'By email', assignee: 'alice@example.com' }).assignee).toMatchObject({ userId: alice.id, name: 'Alex' });
    expect(createTicket({ directory, actor, title: 'By me', assignee: 'me' }).assignee).toMatchObject({ userId: actor.id });
    expect(newer.title).toBe('Newer title');
  });

  it('enforces label uniqueness and per-ticket count, parent keys and priority storage', () => {
    const { directory, actor } = fixture();
    const first = createLabel({ directory, actor, name: 'CaseSensitive' });
    expectCode(() => createLabel({ directory, actor, name: 'casesensitive' }), 'conflict');
    expectCode(() => createTicket({ directory, actor, title: 'Unknown label', labels: ['missing'] }), 'invalid_input');
    expectCode(() => createTicket({ directory, actor, title: 'Repeated label', labels: ['CaseSensitive', 'casesensitive'] }), 'invalid_input');
    expectCode(() => createTicket({ directory, actor, title: 'Too many labels', labels: Array.from({ length: 21 }, () => 'CaseSensitive') }), 'limit_exceeded');
    const parent = createTicket({ directory, actor, title: 'Parent' });
    const child = createTicket({ directory, actor, title: 'Child', parent: parent.key });
    expect(child.parent).toBe(parent.key);
    expectCode(() => updateTicket({ directory, actor, key: parent.key, patch: { parent: child.key } }), 'invalid_input');
    expectCode(() => createTicket({ directory, actor, title: 'Bad due', due: '2026-02-30' }), 'invalid_input');
    expectCode(() => createTicket({ directory, actor, title: 'Bad project', project: 'roadmap' } as any), 'invalid_input');
    const priorities = ['none', 'urgent', 'high', 'medium', 'low'];
    priorities.forEach((priority, index) => {
      const ticket = createTicket({ directory, actor, title: `Priority ${priority}`, priority });
      expect(ticket.priority).toBe(priority);
      expect(directory.db.prepare('SELECT priority FROM tickets WHERE id = ?').get(ticket.id).priority).toBe(index);
    });
    expect(first.name).toBe('CaseSensitive');
  });

  it('strips invisible characters from titles, Markdown and comments and rejects multiline titles', () => {
    const { directory, actor } = fixture();
    const ticket = createTicket({
      directory, actor, title: 'visible\u200b title\u202e', description: 'line 1\u200b\nline 2',
    });
    expect(ticket.title).toBe('visible title');
    expect(ticket.description).toBe('line 1\nline 2');
    const comment = commentTicket({ directory, actor, key: ticket.key, body: 'safe\u200b comment\u202e' });
    expect(comment.body).toBe('safe comment');
    expectCode(() => createTicket({ directory, actor, title: 'two\nlines' }), 'invalid_input');
    expectCode(() => createTicket({ directory, actor, title: '😀'.repeat(201) }), 'invalid_input');
    expectCode(() => createTicket({ directory, actor, description: 'x'.repeat(20_001), title: 'Long body' }), 'invalid_input');
  });

  it('records MCP token id and owner id without putting comment text into event details', () => {
    const { directory, owner } = fixture();
    const actor = { type: 'mcp_token', id: 'token-id-1', user: { id: owner.id, role: 'owner', name: owner.name }, tracker: 'write' };
    const ticket = createTicket({ directory, actor, title: 'MCP ticket' });
    const created = directory.db.prepare("SELECT actor_type, actor_id, details_json FROM ticket_events WHERE ticket_id = ? AND event_type = 'created'").get(ticket.id);
    expect(created).toMatchObject({ actor_type: 'mcp_token', actor_id: 'token-id-1' });
    expect(JSON.parse(created.details_json)).toEqual({ ownerUserId: owner.id });
    commentTicket({ directory, actor, key: ticket.key, body: 'sensitive-looking text' });
    const event = directory.db.prepare("SELECT actor_type, actor_id, details_json FROM ticket_events WHERE ticket_id = ? AND event_type = 'commented'").get(ticket.id);
    expect(event).toMatchObject({ actor_type: 'mcp_token', actor_id: 'token-id-1' });
    expect(JSON.parse(event.details_json)).toMatchObject({ ownerUserId: owner.id, length: 22 });
    expect(event.details_json).not.toContain('sensitive-looking text');
  });

  it('blocks every exposed mutation in read-only mode before any database write', () => {
    const { directory, actor } = fixture();
    const existing = createTicket({ directory, actor, title: 'Read only target' });
    const before = {
      tickets: directory.db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n,
      events: directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_events').get().n,
      comments: directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_comments').get().n,
      labels: directory.db.prepare('SELECT COUNT(*) AS n FROM labels').get().n,
      subscriptions: directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_subscriptions').get().n,
      notifications: directory.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n,
      versions: directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_field_versions').get().n,
      counter: directory.db.prepare('SELECT next_number FROM ticket_counters WHERE scope = ? AND prefix = ?').get('trk_default', 'TAB').next_number,
      search: directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_search').get().n,
    };
    const readOnly = () => true;
    expectCode(() => createTicket({ directory, actor, title: 'Blocked', readOnly }), 'read_only');
    expectCode(() => allocateTicket({ directory, actor, readOnly, fields: {} as any }), 'read_only');
    expectCode(() => updateTicket({ directory, actor, key: existing.key, patch: { title: 'Blocked' }, readOnly }), 'read_only');
    expectCode(() => transitionTicket({ directory, actor, key: existing.key, state: 'done', readOnly }), 'read_only');
    expectCode(() => commentTicket({ directory, actor, key: existing.key, body: 'Blocked', readOnly }), 'read_only');
    expectCode(() => createLabel({ directory, actor, name: 'Blocked', readOnly }), 'read_only');
    expect({
      tickets: directory.db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n,
      events: directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_events').get().n,
      comments: directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_comments').get().n,
      labels: directory.db.prepare('SELECT COUNT(*) AS n FROM labels').get().n,
      subscriptions: directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_subscriptions').get().n,
      notifications: directory.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n,
      versions: directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_field_versions').get().n,
      counter: directory.db.prepare('SELECT next_number FROM ticket_counters WHERE scope = ? AND prefix = ?').get('trk_default', 'TAB').next_number,
      search: directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_search').get().n,
    }).toEqual(before);
  });
});
