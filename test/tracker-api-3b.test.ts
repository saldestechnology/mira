import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHarness, type Account, type Body } from './mcp-harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLOUD_TOKEN = 'c'.repeat(48);
const h = createHarness({
  accounts: true,
  settings: { MCP: 'on', TRACKER: 'on' },
  dir: path.join(ROOT, `.tracker-api-3b-${process.pid}-${Date.now()}`),
});
let owner: Account;
let member: Account;
let guest: Account;

const api = (who: Account | undefined, method: string, pathName: string, body?: unknown, headers: Record<string, string> = {}) =>
  h.api(who?.cookie, method, pathName, body, headers);

function counts(directory: string) {
  const db = new DatabaseSync(path.join(directory, 'directory.sqlite'));
  try {
    return Object.fromEntries([
      'tickets', 'ticket_events', 'ticket_comments', 'ticket_subscriptions', 'labels', 'projects', 'milestones',
      'ticket_relations', 'saved_views', 'audit',
    ].map((table) => [table, Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n)]));
  } finally {
    db.close();
  }
}

function dbFor(directory: string, fn: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(path.join(directory, 'directory.sqlite'));
  try { fn(db); } finally { db.close(); }
}

async function makeTicket(who: Account, title: string) {
  const result = await api(who, 'POST', '/api/tracker/tickets', {
    title,
    idempotencyKey: h.unique('tracker-3b-create-'),
  });
  expect(result.status).toBe(201);
  return result.body.ticket as Body;
}

beforeAll(async () => {
  await h.start();
  owner = await h.signInOwner();
  const teamId = (await h.newTeam(owner.cookie)).id;
  member = await h.joinTeam(owner.cookie, teamId);
  guest = await h.joinTeam(owner.cookie, teamId);
  const changed = await api(owner, 'PATCH', `/api/members/${guest.user.id}`, { role: 'guest' });
  if (changed.status !== 200) throw new Error(`could not make a guest (${changed.status})`);
});

afterAll(async () => {
  await h.cleanup();
});

describe('tracker session API slice 3b', () => {
  it('serves labels, projects, milestones, saved views and the extended metadata', async () => {
    expect((await api(owner, 'GET', '/api/tracker/labels')).body).toEqual({ labels: [] });
    const label = await api(owner, 'POST', '/api/tracker/labels', { name: '3b Bug', color: '#AABBCC' });
    expect(label.status).toBe(201);
    expect(label.body.label).toMatchObject({ name: '3b Bug', color: '#AABBCC' });
    expect((await api(owner, 'GET', '/api/tracker/labels')).body.labels).toContainEqual(label.body.label);
    const duplicateLabel = await api(owner, 'POST', '/api/tracker/labels', { name: '3b Bug' });
    expect(duplicateLabel.status).toBe(409);
    expect(duplicateLabel.body).toMatchObject({ error: 'conflict', path: 'name' });

    const projectResult = await api(owner, 'POST', '/api/tracker/projects', {
      name: '3b Project', description: 'Project description', state: 'started', ownerId: member.user.id,
    });
    expect(projectResult.status).toBe(201);
    const project = projectResult.body.project;
    expect(project).toMatchObject({
      name: '3b Project', state: 'started', owner: { userId: member.user.id, name: member.user.name }, ticketCount: 0, doneCount: 0,
    });
    expect((await api(owner, 'GET', '/api/tracker/projects')).body.projects).toContainEqual(project);
    expect((await api(owner, 'GET', `/api/tracker/projects/${project.id}`)).body.project).toEqual(project);
    const invalidOwner = await api(owner, 'POST', '/api/tracker/projects', { name: 'Invalid owner', ownerId: 'missing-member-id' });
    expect(invalidOwner.status).toBe(400);
    expect(invalidOwner.body).toMatchObject({ error: 'invalid_input', path: 'ownerId' });

    const milestoneResult = await api(owner, 'POST', `/api/tracker/projects/${project.id}/milestones`, {
      name: '3b Milestone', description: 'Milestone description', due: '2026-11-01', state: 'started',
    });
    expect(milestoneResult.status).toBe(201);
    const milestone = milestoneResult.body.milestone;
    expect(milestone).toMatchObject({ projectId: project.id, name: '3b Milestone', due: '2026-11-01', ticketCount: 0, doneCount: 0 });
    expect((await api(owner, 'GET', `/api/tracker/projects/${project.id}/milestones`)).body.milestones).toContainEqual(milestone);

    const ticket = await makeTicket(owner, '3b project ticket');
    const assigned = await api(owner, 'PATCH', `/api/tracker/tickets/${ticket.key}`, {
      project: project.name, milestone: milestone.name, due: '2026-10-30',
    });
    expect(assigned.status).toBe(200);
    const done = await api(owner, 'PATCH', `/api/tracker/tickets/${ticket.key}`, { state: 'done' });
    expect(done.body.ticket.state.key).toBe('done');
    expect((await api(owner, 'GET', `/api/tracker/projects/${project.id}`)).body.project).toMatchObject({ ticketCount: 1, doneCount: 1 });
    expect((await api(owner, 'GET', `/api/tracker/projects/${project.id}/milestones`)).body.milestones[0])
      .toMatchObject({ ticketCount: 1, doneCount: 1 });

    const projectChanged = await api(owner, 'PATCH', `/api/tracker/projects/${project.id}`, { name: '3b Renamed', ownerId: 'me' });
    expect(projectChanged.status).toBe(200);
    expect(projectChanged.body.project).toMatchObject({ name: '3b Renamed', owner: { userId: owner.user.id } });
    const archivedProject = await api(owner, 'PATCH', `/api/tracker/projects/${project.id}`, { archived: true });
    expect(archivedProject.body.project.archivedAt).not.toBeNull();
    expect((await api(owner, 'GET', '/api/tracker/projects')).body.projects).not.toContainEqual(expect.objectContaining({ id: project.id }));
    expect((await api(owner, 'GET', '/api/tracker/projects?archived=1')).body.projects).toContainEqual(archivedProject.body.project);
    expect((await api(owner, 'PATCH', `/api/tracker/projects/${project.id}`, { archived: false })).body.project.archivedAt).toBeNull();

    const milestoneChanged = await api(owner, 'PATCH', `/api/tracker/milestones/${milestone.id}`, { name: '3b Milestone renamed', due: null, state: 'completed' });
    expect(milestoneChanged.status).toBe(200);
    expect(milestoneChanged.body.milestone).toMatchObject({ name: '3b Milestone renamed', due: null, state: 'completed' });
    expect((await api(owner, 'PATCH', `/api/tracker/milestones/${milestone.id}`, { archived: true })).body.milestone.archivedAt).not.toBeNull();
    expect((await api(owner, 'PATCH', `/api/tracker/milestones/${milestone.id}`, { archived: false })).body.milestone.archivedAt).toBeNull();

    const viewResult = await api(owner, 'POST', '/api/tracker/views', { name: '3b Shared view', filter: ['state:done'], shared: true });
    expect(viewResult.status).toBe(201);
    const view = viewResult.body.view;
    expect(view).toMatchObject({ owner: { userId: owner.user.id, name: owner.user.name }, ownerName: owner.user.name, mine: true, shared: true });
    expect((await api(member, 'GET', '/api/tracker/views')).body.views).toContainEqual(expect.objectContaining({ id: view.id, mine: false, ownerName: owner.user.name }));
    const run = await api(member, 'GET', `/api/tracker/views/${view.id}/tickets?limit=10`);
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ view: { id: view.id, mine: false }, tickets: [expect.objectContaining({ id: ticket.id, commentCount: 0 })], nextCursor: null });
    expect((await api(member, 'PATCH', `/api/tracker/views/${view.id}`, { name: 'Intrusion' })).status).toBe(403);
    expect((await api(member, 'DELETE', `/api/tracker/views/${view.id}`)).status).toBe(403);
    const renamedView = await api(owner, 'PATCH', `/api/tracker/views/${view.id}`, { name: '3b Private view', shared: false, filter: [] });
    expect(renamedView.status).toBe(200);
    expect(renamedView.body.view).toMatchObject({ name: '3b Private view', shared: false, mine: true });
    expect((await api(owner, 'GET', `/api/tracker/views/${view.id}/tickets`)).body.tickets.map((row: Body) => row.id)).toContain(ticket.id);
    expect((await api(member, 'GET', `/api/tracker/views/${view.id}/tickets`)).status).toBe(404);
    expect((await api(owner, 'DELETE', `/api/tracker/views/${view.id}`)).status).toBe(204);

    const meta = await api(owner, 'GET', '/api/tracker/meta');
    expect(meta.body).toMatchObject({
      projects: [expect.objectContaining({ id: project.id, name: '3b Renamed', state: 'started' })],
      milestones: [expect.objectContaining({ id: milestone.id, name: '3b Milestone renamed', projectId: project.id, due: null })],
      views: [],
      me: { userId: owner.user.id, canWrite: true, canCreate: true },
    });
  });

  it('adds and removes relations, returns conflicts with the current ticket, and provides archive aliases', async () => {
    const first = await makeTicket(owner, '3b relation first');
    const second = await makeTicket(owner, '3b relation second');
    const third = await makeTicket(owner, '3b relation third');
    const related = await api(owner, 'POST', `/api/tracker/tickets/${first.key}/relations`, { relation: 'blocks', otherKey: second.key });
    expect(related.status).toBe(200);
    expect(related.body.ticket.relations).toContainEqual({ kind: 'blocks', key: second.key });
    const cycle = await api(owner, 'POST', `/api/tracker/tickets/${second.key}/relations`, { relation: 'blocks', otherKey: first.key });
    expect(cycle.status).toBe(409);
    expect(cycle.body).toMatchObject({ error: 'conflict', ticket: { id: second.id } });
    const removed = await api(owner, 'DELETE', `/api/tracker/tickets/${first.key}/relations?relation=blocks&otherKey=${second.key}`);
    expect(removed.status).toBe(200);
    expect(removed.body.ticket.relations).toEqual([]);

    expect((await api(owner, 'POST', `/api/tracker/tickets/${first.key}/relations`, { relation: 'relates_to', otherKey: third.key })).status).toBe(200);
    const removedByBody = await api(owner, 'DELETE', `/api/tracker/tickets/${first.key}/relations`, { relation: 'relates_to', otherKey: third.key });
    expect(removedByBody.status).toBe(200);
    expect(removedByBody.body.ticket.relations).toEqual([]);

    const archived = await api(owner, 'POST', `/api/tracker/tickets/${first.key}/archive`);
    expect(archived.status).toBe(200);
    expect(archived.body.ticket.archivedAt).not.toBeNull();
    const restored = await api(owner, 'POST', `/api/tracker/tickets/${first.key}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body.ticket.archivedAt).toBeNull();
  });

  it('edits and soft-deletes comments under the author and admin rules and refreshes FTS', async () => {
    const ticket = await makeTicket(owner, '3b comment target');
    const comment = await api(member, 'POST', `/api/tracker/tickets/${ticket.key}/comments`, { body: 'oldcommenttoken text' });
    expect(comment.status).toBe(201);
    expect(comment.body.comment).toMatchObject({ actorType: 'user', edited: false, deleted: false });
    const forbiddenEdit = await api(owner, 'PATCH', `/api/tracker/tickets/${ticket.key}/comments/${comment.body.comment.id}`, { body: 'wrong editor' });
    expect(forbiddenEdit.status).toBe(403);

    const edited = await api(member, 'PATCH', `/api/tracker/tickets/${ticket.key}/comments/${comment.body.comment.id}`, { body: 'newcommenttoken text' });
    expect(edited.status).toBe(200);
    expect(edited.body.comment).toMatchObject({ body: 'newcommenttoken text', edited: true, deleted: false, actorType: 'user' });
    expect((await api(owner, 'GET', `/api/tracker/tickets?q=oldcommenttoken`)).body.tickets).toEqual([]);
    expect((await api(owner, 'GET', `/api/tracker/tickets?q=newcommenttoken`)).body.tickets.map((row: Body) => row.id)).toContain(ticket.id);

    const ownersComment = await api(owner, 'POST', `/api/tracker/tickets/${ticket.key}/comments`, { body: 'authordelete token' });
    expect((await api(member, 'DELETE', `/api/tracker/tickets/${ticket.key}/comments/${ownersComment.body.comment.id}`)).status).toBe(403);
    expect((await api(owner, 'DELETE', `/api/tracker/tickets/${ticket.key}/comments/${ownersComment.body.comment.id}`)).body.comment)
      .toMatchObject({ deleted: true, actorType: 'user' });

    const adminDelete = await api(member, 'POST', `/api/tracker/tickets/${ticket.key}/comments`, { body: 'admindelete token' });
    const deleted = await api(owner, 'DELETE', `/api/tracker/tickets/${ticket.key}/comments/${adminDelete.body.comment.id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.comment).toMatchObject({ deleted: true });
    expect(deleted.body.comment).not.toHaveProperty('body');
    expect((await api(owner, 'GET', `/api/tracker/tickets/${ticket.key}`)).body.comments)
      .toContainEqual(expect.objectContaining({ id: adminDelete.body.comment.id, deleted: true }));
    expect((await api(owner, 'GET', `/api/tracker/tickets?q=admindelete`)).body.tickets).toEqual([]);
    expect((await api(owner, 'GET', `/api/tracker/tickets/${ticket.key}`)).body.ticket.commentCount).toBe(1);
    const events = (await api(owner, 'GET', `/api/tracker/tickets/${ticket.key}`)).body.events;
    expect(events.map((event: Body) => event.eventType)).toEqual(expect.arrayContaining(['comment_edited', 'comment_deleted']));
    const editEvent = events.find((event: Body) => event.eventType === 'comment_edited');
    expect(editEvent.details).toMatchObject({ commentId: comment.body.comment.id, length: 20 });
    expect(JSON.stringify(events)).not.toContain('newcommenttoken');
  });

  it('applies bulk patches independently with a batch ID, changed-field before values, and row extras', async () => {
    const label = await api(owner, 'POST', '/api/tracker/labels', { name: '3b Bulk label' });
    const good = await makeTicket(owner, '3b bulk good');
    const second = await makeTicket(owner, '3b bulk second');
    const blocked = await makeTicket(owner, '3b bulk archived');
    await api(owner, 'POST', `/api/tracker/tickets/${blocked.key}/archive`);

    const bulk = await api(owner, 'POST', '/api/tracker/tickets/bulk', {
      keys: [good.key, blocked.key, second.key],
      patch: { state: 'done', priority: 'high', labelsAdd: [label.body.label.name], due: '2026-12-01' },
    });
    expect(bulk.status).toBe(200);
    expect(bulk.body.batchId).toEqual(expect.any(String));
    expect(bulk.body.results).toHaveLength(3);
    expect(bulk.body.results[0]).toMatchObject({
      key: good.key, ok: true, ticket: { state: { key: 'done' }, priority: 'high', due: '2026-12-01' },
      before: { state: 'todo', priority: 'none', labels: [], due: null },
    });
    expect(bulk.body.results[1]).toMatchObject({ key: blocked.key, ok: false, error: { error: 'conflict', path: 'patch.state' } });
    expect(bulk.body.results[2]).toMatchObject({ key: second.key, ok: true });
    dbFor(h.dir, (db) => {
      const event = db.prepare("SELECT details_json FROM ticket_events WHERE ticket_id = ? AND event_type = 'updated' ORDER BY id DESC LIMIT 1").get(good.id)! as Body;
      expect(JSON.parse(event.details_json)).toEqual({ batchId: bulk.body.batchId });
      expect(db.prepare("SELECT COUNT(*) AS n FROM ticket_events WHERE ticket_id IN (?, ?) AND json_extract(details_json, '$.batchId') = ?")
        .get(good.id, second.id, bulk.body.batchId)!.n).toBe(2);
    });

    const tooMany = await api(owner, 'POST', '/api/tracker/tickets/bulk', { keys: Array.from({ length: 51 }, (_, i) => `TAB-${i + 1}`), patch: { priority: 'low' } });
    expect(tooMany.status).toBe(413);
    expect(tooMany.body).toMatchObject({ error: 'limit_exceeded', path: 'keys' });
    const duplicate = await api(owner, 'POST', '/api/tracker/tickets/bulk', { keys: [good.key, good.key], patch: { priority: 'low' } });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body).toMatchObject({ error: 'invalid_input', path: 'keys' });
  });

  it('returns comment, child, blocked and PR row extras on detail and list results', async () => {
    const parent = await makeTicket(owner, '3b extras parent');
    const childOne = await makeTicket(owner, '3b extras child one');
    const childTwo = await makeTicket(owner, '3b extras child two');
    const blocker = await makeTicket(owner, '3b extras blocker');
    await api(owner, 'PATCH', `/api/tracker/tickets/${childOne.key}`, { parent: parent.key });
    await api(owner, 'PATCH', `/api/tracker/tickets/${childTwo.key}`, { parent: parent.key });
    await api(owner, 'POST', `/api/tracker/tickets/${childTwo.key}/transition`, { state: 'Cancelled' });
    await api(owner, 'POST', `/api/tracker/tickets/${parent.key}/comments`, { body: 'count this comment' });
    await api(owner, 'POST', `/api/tracker/tickets/${parent.key}/relations`, { relation: 'blocked_by', otherKey: blocker.key });

    const detail = await api(owner, 'GET', `/api/tracker/tickets/${parent.key}`);
    expect(detail.body.ticket).toMatchObject({ commentCount: 1, subIssueCount: 2, subIssueDone: 1, blocked: true, prs: null });
    const list = await api(owner, 'GET', '/api/tracker/tickets?limit=50');
    expect(list.body.tickets.find((row: Body) => row.id === parent.id)).toMatchObject({
      commentCount: 1, subIssueCount: 2, subIssueDone: 1, blocked: true, prs: null,
    });
    await api(owner, 'POST', `/api/tracker/tickets/${blocker.key}/transition`, { state: 'Done' });
    expect((await api(owner, 'GET', `/api/tracker/tickets/${parent.key}`)).body.ticket.blocked).toBe(false);
  });

  it('conceals every new endpoint from guests and when tracker routes are unavailable', async () => {
    const paths: [string, string, unknown?][] = [
      ['GET', '/api/tracker/labels'], ['POST', '/api/tracker/labels', { name: 'hidden' }],
      ['GET', '/api/tracker/projects'], ['POST', '/api/tracker/projects', { name: 'hidden' }],
      ['GET', '/api/tracker/projects/p'], ['PATCH', '/api/tracker/projects/p', { name: 'hidden' }],
      ['GET', '/api/tracker/projects/p/milestones'], ['POST', '/api/tracker/projects/p/milestones', { name: 'hidden', due: '2026-11-01' }],
      ['PATCH', '/api/tracker/milestones/m', { name: 'hidden' }],
      ['GET', '/api/tracker/views'], ['POST', '/api/tracker/views', { name: 'hidden', filter: [] }],
      ['PATCH', '/api/tracker/views/v', { name: 'hidden' }], ['DELETE', '/api/tracker/views/v'],
      ['GET', '/api/tracker/views/v/tickets'],
      ['POST', '/api/tracker/tickets/TAB-1/relations', { relation: 'blocks', otherKey: 'TAB-2' }],
      ['DELETE', '/api/tracker/tickets/TAB-1/relations?relation=blocks&otherKey=TAB-2'],
      ['PATCH', '/api/tracker/tickets/TAB-1/comments/c', { body: 'hidden' }],
      ['DELETE', '/api/tracker/tickets/TAB-1/comments/c'],
      ['POST', '/api/tracker/tickets/bulk', { keys: ['TAB-1'], patch: { priority: 'high' } }],
      ['POST', '/api/tracker/tickets/TAB-1/archive'], ['POST', '/api/tracker/tickets/TAB-1/restore'],
    ];
    for (const [method, route, body] of paths) {
      const guestResult = await api(guest, method, route, body);
      expect(guestResult.status, `guest ${method} ${route}`).toBe(404);
      expect(guestResult.body).toMatchObject({ error: 'not_found' });
    }

    const off = createHarness({ accounts: true, settings: { MCP: 'on' }, dir: path.join(ROOT, `.tracker-api-3b-off-${process.pid}-${Date.now()}`) });
    const open = createHarness({ settings: { TRACKER: 'on' }, dir: path.join(ROOT, `.tracker-api-3b-open-${process.pid}-${Date.now()}`) });
    try {
      await off.start();
      const signedIn = await off.signInOwner();
      await open.start();
      for (const [method, route, body] of paths) {
        expect((await off.api(signedIn.cookie, method, route, body)).status, `flag off ${method} ${route}`).toBe(404);
        expect((await open.api(undefined, method, route, body)).status, `open ${method} ${route}`).toBe(404);
      }
    } finally {
      await off.cleanup();
      await open.cleanup();
    }
  });

  it('blocks every new mutation in hosted read-only mode without changing SQLite rows', async () => {
    const cloud = createHarness({
      accounts: true,
      settings: {
        MCP: 'on', TRACKER: 'on', CLOUD_TOKEN,
        CLOUD_URL: 'http://127.0.0.1:9', CLOUD_WORKSPACE_ID: 'tracker-api-3b-readonly',
      },
      dir: path.join(ROOT, `.tracker-api-3b-readonly-${process.pid}-${Date.now()}`),
    });
    try {
      await cloud.start();
      const account = await cloud.signInOwner();
      const apiCloud = (method: string, route: string, body?: unknown, headers: Record<string, string> = {}) => cloud.api(account.cookie, method, route, body, headers);
      const ticket = (await apiCloud('POST', '/api/tracker/tickets', { title: 'Read-only baseline', idempotencyKey: 'tracker-3b-readonly-ticket' })).body.ticket;
      const other = (await apiCloud('POST', '/api/tracker/tickets', { title: 'Read-only relation', idempotencyKey: 'tracker-3b-readonly-other' })).body.ticket;
      const project = (await apiCloud('POST', '/api/tracker/projects', { name: 'Read-only project' })).body.project;
      const milestone = (await apiCloud('POST', `/api/tracker/projects/${project.id}/milestones`, { name: 'Read-only milestone', due: '2026-11-01' })).body.milestone;
      const view = (await apiCloud('POST', '/api/tracker/views', { name: 'Read-only view', filter: [] })).body.view;
      const comment = (await apiCloud('POST', `/api/tracker/tickets/${ticket.key}/comments`, { body: 'Read-only comment' })).body.comment;
      await apiCloud('POST', `/api/tracker/tickets/${ticket.key}/relations`, { relation: 'relates_to', otherKey: other.key });
      const limits = await cloud.api(undefined, 'PUT', '/api/internal/limits', { readOnly: true }, { authorization: `Bearer ${CLOUD_TOKEN}` });
      expect(limits.status).toBe(200);
      const before = counts(cloud.dir);

      const mutations: [string, string, unknown?][] = [
        ['POST', '/api/tracker/labels', { name: 'must not persist' }],
        ['POST', '/api/tracker/projects', { name: 'must not persist' }],
        ['PATCH', `/api/tracker/projects/${project.id}`, { name: 'must not persist' }],
        ['POST', `/api/tracker/projects/${project.id}/milestones`, { name: 'must not persist', due: '2026-12-01' }],
        ['PATCH', `/api/tracker/milestones/${milestone.id}`, { name: 'must not persist' }],
        ['POST', '/api/tracker/views', { name: 'must not persist', filter: [] }],
        ['PATCH', `/api/tracker/views/${view.id}`, { name: 'must not persist' }],
        ['DELETE', `/api/tracker/views/${view.id}`],
        ['POST', `/api/tracker/tickets/${ticket.key}/relations`, { relation: 'blocks', otherKey: other.key }],
        ['DELETE', `/api/tracker/tickets/${ticket.key}/relations`, { relation: 'relates_to', otherKey: other.key }],
        ['PATCH', `/api/tracker/tickets/${ticket.key}/comments/${comment.id}`, { body: 'must not persist' }],
        ['DELETE', `/api/tracker/tickets/${ticket.key}/comments/${comment.id}`],
        ['POST', '/api/tracker/tickets/bulk', { keys: [ticket.key], patch: { priority: 'high' } }],
        ['POST', `/api/tracker/tickets/${ticket.key}/archive`],
        ['POST', `/api/tracker/tickets/${ticket.key}/restore`],
      ];
      for (const [method, route, body] of mutations) {
        const result = await apiCloud(method, route, body);
        expect(result.status, `${method} ${route}`).toBe(403);
        expect(result.body.error).toBe('read_only');
      }
      expect(counts(cloud.dir)).toEqual(before);
    } finally {
      await cloud.cleanup();
    }
  });
  it('idempotent retries write no extra audit rows, and a too-long search names the q parameter', async () => {
    const key = h.unique('tracker-3b-audit-');
    const first = await api(owner, 'POST', '/api/tracker/tickets', { title: 'Audit once', idempotencyKey: key });
    expect(first.status).toBe(201);
    const afterCreate = counts(h.dir);
    const again = await api(owner, 'POST', '/api/tracker/tickets', { title: 'Audit once', idempotencyKey: key });
    expect(again.body.ticket.key).toBe(first.body.ticket.key);
    expect(counts(h.dir)).toEqual(afterCreate);

    const route = `/api/tracker/tickets/${first.body.ticket.key}/comments`;
    expect((await api(owner, 'POST', route, { body: 'once', clientId: 'audit-client-1' })).status).toBe(201);
    const afterComment = counts(h.dir);
    expect((await api(owner, 'POST', route, { body: 'once', clientId: 'audit-client-1' })).status).toBe(201);
    expect(counts(h.dir)).toEqual(afterComment);

    const long = await api(owner, 'GET', `/api/tracker/tickets?q=${'x'.repeat(600)}`);
    expect(long.status).toBe(413);
    expect(long.body.path).toBe('q');
  });
});
