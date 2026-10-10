import { MIGRATIONS } from '../server/directory.mjs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHarness, type Account, type Body } from './mcp-harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const TICKET_TOOLS = [
  'create_ticket', 'get_ticket', 'list_tickets', 'search_tickets', 'update_ticket', 'transition_ticket',
  'comment_ticket', 'list_ticket_states', 'list_ticket_labels', 'create_ticket_label',
  'relate_tickets', 'list_saved_views', 'get_saved_view', 'create_saved_view', 'update_saved_view', 'delete_saved_view',
  'list_projects', 'create_project', 'update_project', 'list_milestones', 'create_milestone', 'update_milestone',
].sort();
const TICKET_READ_TOOLS = [
  'get_ticket', 'list_tickets', 'search_tickets', 'list_ticket_states', 'list_ticket_labels',
  'list_saved_views', 'get_saved_view', 'list_projects', 'list_milestones',
].sort();
const CLOUD_TOKEN = 'c'.repeat(48);

const h = createHarness({ accounts: true, settings: { MCP: 'on', TRACKER: 'on' } });
let owner: Account;
let member: Account;
let guest: Account;
let teamId: string;
let baseline: { token: string; id: string };
let baselineTicket: Body;
const issued: { cookie: string; id: string }[] = [];

async function makeToken(account: Account, tracker?: 'read' | 'write' | null) {
  const body = { name: `tracker ${Math.random().toString(36).slice(2)}`, scope: 'read', ...(tracker === undefined ? {} : { tracker }) };
  const made = await h.api(account.cookie, 'POST', '/api/me/tokens', body);
  expect(made.status).toBe(201);
  issued.push({ cookie: account.cookie, id: made.body.id });
  return made.body as { id: string; token: string; tracker: string | null };
}

function ticketCounts(directory: string) {
  const db = new DatabaseSync(path.join(directory, 'directory.sqlite'));
  try {
    return {
      tickets: db.prepare('SELECT COUNT(*) AS n FROM tickets').get()!.n,
      events: db.prepare('SELECT COUNT(*) AS n FROM ticket_events').get()!.n,
      comments: db.prepare('SELECT COUNT(*) AS n FROM ticket_comments').get()!.n,
      labels: db.prepare('SELECT COUNT(*) AS n FROM labels').get()!.n,
      ticketLabels: db.prepare('SELECT COUNT(*) AS n FROM ticket_labels').get()!.n,
      subscriptions: db.prepare('SELECT COUNT(*) AS n FROM ticket_subscriptions').get()!.n,
      notifications: db.prepare('SELECT COUNT(*) AS n FROM notifications').get()!.n,
      versions: db.prepare('SELECT COUNT(*) AS n FROM ticket_field_versions').get()!.n,
      searchRows: db.prepare('SELECT COUNT(*) AS n FROM ticket_search').get()!.n,
      projects: db.prepare('SELECT COUNT(*) AS n FROM projects').get()!.n,
      milestones: db.prepare('SELECT COUNT(*) AS n FROM milestones').get()!.n,
      relations: db.prepare('SELECT COUNT(*) AS n FROM ticket_relations').get()!.n,
      savedViews: db.prepare('SELECT COUNT(*) AS n FROM saved_views').get()!.n,
      nextNumber: db.prepare("SELECT next_number AS n FROM ticket_counters WHERE scope = 'trk_default' AND prefix = 'TAB'").get()!.n,
    };
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  await h.start();
  owner = await h.signInOwner();
  teamId = (await h.newTeam(owner.cookie)).id;
  member = await h.joinTeam(owner.cookie, teamId);
  guest = await h.joinTeam(owner.cookie, teamId);
  const guestRole = await h.api(owner.cookie, 'PATCH', `/api/members/${guest.user.id}`, { role: 'guest' });
  if (guestRole.status !== 200) throw new Error(`could not make a guest (${guestRole.status})`);
  baseline = await makeToken(owner, 'write');
  const made = await h.tool(baseline.token, 'create_ticket', { title: 'Tracker baseline', idempotencyKey: 'baseline-ticket-key' });
  if (made.error) throw new Error(`could not create baseline ticket (${made.error})`);
  baselineTicket = made.data.ticket;
});

afterEach(async () => {
  for (const token of issued.splice(0)) await h.api(token.cookie, 'DELETE', `/api/me/tokens/${token.id}`);
});

afterAll(async () => {
  await h.cleanup();
});

describe('MCP tracker capability', () => {
  it('lists token capability in self and admin views and hides tools without it', async () => {
    const without = await makeToken(owner);
    expect(without.tracker).toBeNull();
    const read = await makeToken(owner, 'read');
    const write = await makeToken(owner, 'write');

    const own = await h.api(owner.cookie, 'GET', '/api/me/tokens');
    expect(own.body.find((token: Body) => token.id === read.id).tracker).toBe('read');
    const admin = await h.api(owner.cookie, 'GET', '/api/admin/tokens');
    expect(admin.body.find((token: Body) => token.id === write.id).tracker).toBe('write');

    const names = async (token: string) => (await h.call(token, 'tools/list')).body.result.tools.map((tool: Body) => tool.name).sort();
    expect((await names(without.token)).filter((name: string) => TICKET_TOOLS.includes(name))).toEqual([]);
    expect((await names(read.token)).filter((name: string) => TICKET_TOOLS.includes(name))).toEqual(TICKET_READ_TOOLS);
    expect((await names(write.token)).filter((name: string) => TICKET_TOOLS.includes(name))).toEqual(TICKET_TOOLS);

    const hidden = await h.call(without.token, 'tools/call', { name: 'list_ticket_states', arguments: {} });
    const missing = await h.call(without.token, 'tools/call', { name: 'tool_that_does_not_exist', arguments: {} });
    expect(hidden.body.error).toEqual(missing.body.error);
    expect(hidden.body.error).toMatchObject({ code: -32602, message: 'Unknown tool' });
  });

  it('supports ticket CRUD, search, workflow, labels, idempotency, history and fenced text', async () => {
    const writer = await makeToken(owner, 'write');
    const states = await h.tool(writer.token, 'list_ticket_states');
    expect(states.data.states.map((state: Body) => state.name)).toEqual(['To do', 'In progress', 'In review', 'Done', 'Cancelled']);
    expect(states.data).toMatchObject({ cleaned: false, truncated: false });

    const madeLabel = await h.tool(writer.token, 'create_ticket_label', { name: 'Bug', color: '#D02020' });
    expect(madeLabel.error).toBeUndefined();
    const labelId = madeLabel.data.label.id;
    expect((await h.tool(writer.token, 'list_ticket_labels')).data.labels).toContainEqual(expect.objectContaining({ id: labelId, name: 'Bug' }));

    const project = await h.tool(writer.token, 'create_project', { name: 'Platform', owner: 'me', state: 'started', description: 'Project description' });
    expect(project.error).toBeUndefined();
    expect(project.data.project).toMatchObject({ name: 'Platform', state: 'started', owner: { userId: owner.user.id } });
    expect(project.text).toContain('[board-content nonce=');
    expect(project.data).toMatchObject({ cleaned: false, truncated: false });
    const milestone = await h.tool(writer.token, 'create_milestone', {
      projectId: project.data.project.id, name: 'Release 1', due: '2099-04-01', state: 'planned',
    });
    expect(milestone.error).toBeUndefined();
    expect((await h.tool(writer.token, 'list_projects')).data.projects).toContainEqual(expect.objectContaining({ id: project.data.project.id }));
    expect((await h.tool(writer.token, 'list_milestones', { projectId: project.data.project.id })).data.milestones)
      .toContainEqual(expect.objectContaining({ id: milestone.data.milestone.id, due: '2099-04-01' }));

    const root = await h.tool(writer.token, 'create_ticket', {
      title: 'Private title for audit test', description: 'Parent description', state: 'in_progress', priority: 'urgent',
      assignee: 'me', labels: ['Bug'], due: '2099-02-03', project: 'platform', milestone: 'release 1', idempotencyKey: 'root-ticket-idem',
    });
    expect(root.error).toBeUndefined();
    expect(root.data.ticket).toMatchObject({ title: 'Private title for audit test', state: { key: 'in_progress', name: 'In progress' }, priority: 'urgent', due: '2099-02-03', project: { id: project.data.project.id, name: 'Platform' }, milestone: { id: milestone.data.milestone.id, name: 'Release 1', due: '2099-04-01' }, labels: [expect.objectContaining({ id: labelId, name: 'Bug' })] });
    const retried = await h.tool(writer.token, 'create_ticket', { title: 'ignored on retry', idempotencyKey: 'root-ticket-idem' });
    expect(retried.data.ticket.id).toBe(root.data.ticket.id);
    expect(retried.data.ticket.key).toBe(root.data.ticket.key);

    const child = await h.tool(writer.token, 'create_ticket', {
      title: 'Search needle child', description: 'Child description', parent: root.data.ticket.key,
      labels: ['Bug'], idempotencyKey: 'child-ticket-idem',
    });
    expect(child.error).toBeUndefined();
    expect(child.data.ticket.parent).toBe(root.data.ticket.key);
    const list = await h.tool(writer.token, 'list_tickets', { filter: ['state:In progress'], limit: 50 });
    expect(list.data.tickets.some((ticket: Body) => ticket.id === root.data.ticket.id)).toBe(true);
    expect(list.data.nextCursor).toBeNull();
    const search = await h.tool(writer.token, 'search_tickets', { query: 'needle', filter: ['label:Bug'] });
    expect(search.data.tickets.map((ticket: Body) => ticket.id)).toContain(child.data.ticket.id);
    expect((await h.tool(writer.token, 'list_tickets', { filter: ['nonsense:value'] })).error).toBe('invalid_filter');

    const updated = await h.tool(writer.token, 'update_ticket', {
      key: child.data.ticket.key, title: 'Search needle updated', assignee: 'me', due: '2099-03-04',
      project: 'Platform', milestone: 'Release 1', ifUpdatedSeq: child.data.ticket.updatedSeq,
    });
    expect(updated.error).toBeUndefined();
    expect(updated.data.ticket).toMatchObject({ title: 'Search needle updated', due: '2099-03-04', assignee: { userId: owner.user.id }, project: { name: 'Platform' }, milestone: { name: 'Release 1' } });
    const stale = await h.tool(writer.token, 'update_ticket', {
      key: child.data.ticket.key, title: 'stale update', ifUpdatedSeq: child.data.ticket.updatedSeq,
    });
    expect(stale.error).toBe('conflict');

    const transitioned = await h.tool(writer.token, 'transition_ticket', { key: child.data.ticket.key, state: 'Done' });
    expect(transitioned.data.ticket.state.name).toBe('Done');
    const linked = await h.tool(writer.token, 'relate_tickets', { key: root.data.ticket.key, relation: 'blocks', otherKey: child.data.ticket.key });
    expect(linked.error).toBeUndefined();
    expect(linked.data.ticket.relations).toContainEqual({ kind: 'blocks', key: child.data.ticket.key });
    await h.tool(writer.token, 'relate_tickets', { key: child.data.ticket.key, relation: 'blocked_by', otherKey: root.data.ticket.key });
    const relatedDb = new DatabaseSync(path.join(h.dir, 'directory.sqlite'));
    try {
      expect(relatedDb.prepare('SELECT COUNT(*) AS n FROM ticket_relations').get()!.n).toBe(1);
      expect(relatedDb.prepare("SELECT COUNT(*) AS n FROM ticket_events WHERE event_type = 'related'").get()!.n).toBe(2);
    } finally { relatedDb.close(); }

    const saved = await h.tool(writer.token, 'create_saved_view', { name: 'Done tickets', filter: ['state:done'], shared: true });
    expect(saved.error).toBeUndefined();
    expect((await h.tool(writer.token, 'list_saved_views')).data.views).toContainEqual(expect.objectContaining({ id: saved.data.view.id, shared: true }));
    const savedRun = await h.tool(writer.token, 'get_saved_view', { viewId: saved.data.view.id, limit: 50 });
    expect(savedRun.data.tickets.map((ticket: Body) => ticket.id)).toContain(child.data.ticket.id);
    const savedUpdate = await h.tool(writer.token, 'update_saved_view', { viewId: saved.data.view.id, name: 'Renamed view', shared: false });
    expect(savedUpdate.data.view.name).toBe('Renamed view');
    expect((await h.tool(writer.token, 'delete_saved_view', { viewId: saved.data.view.id })).data.deleted).toBe(true);

    const changedProject = await h.tool(writer.token, 'update_project', { projectId: project.data.project.id, state: 'paused' });
    expect(changedProject.data.project.state).toBe('paused');
    const changedMilestone = await h.tool(writer.token, 'update_milestone', { milestoneId: milestone.data.milestone.id, state: 'started' });
    expect(changedMilestone.data.milestone.state).toBe('started');

    const comment = await h.tool(writer.token, 'comment_ticket', { key: child.data.ticket.key, body: 'A private comment', clientId: 'comment-client-1' });
    expect(comment.error).toBeUndefined();
    const commentRetry = await h.tool(writer.token, 'comment_ticket', { key: child.data.ticket.key, body: 'ignored on retry', clientId: 'comment-client-1' });
    expect(commentRetry.data.comment.id).toBe(comment.data.comment.id);

    const detail = await h.tool(writer.token, 'get_ticket', { key: child.data.ticket.key });
    expect(detail.error).toBeUndefined();
    expect(detail.data.ticket).toMatchObject({ id: child.data.ticket.id, state: { name: 'Done' }, parent: root.data.ticket.key });
    expect(detail.data.comments).toEqual([expect.objectContaining({ id: comment.data.comment.id, body: 'A private comment' })]);
    expect(detail.data.events.map((event: Body) => event.eventType)).toEqual(expect.arrayContaining(['created', 'updated', 'transitioned', 'commented']));
    expect(detail.text).toContain('[board-content nonce=');
    expect(detail.data).toMatchObject({ cleaned: false, truncated: false });

    const db = new DatabaseSync(path.join(h.dir, 'directory.sqlite'));
    try {
      const createdEvent = db.prepare("SELECT actor_type, actor_id, details_json FROM ticket_events WHERE ticket_id = ? AND event_type = 'created'").get(root.data.ticket.id) as Body;
      expect(createdEvent).toMatchObject({ actor_type: 'mcp_token', actor_id: writer.id });
      expect(JSON.parse(createdEvent.details_json)).toMatchObject({ ownerUserId: owner.user.id });
      expect(db.prepare('SELECT actor_type, actor_id, COUNT(*) AS n FROM ticket_comments WHERE ticket_id = ? GROUP BY actor_type, actor_id').get(child.data.ticket.id)).toMatchObject({ actor_type: 'mcp_token', actor_id: writer.id, n: 1 });
    } finally {
      db.close();
    }

    const audit = await h.api(owner.cookie, 'GET', '/api/admin/audit?limit=100&action=mcp.create_ticket');
    const ticketAudit = audit.body.entries.find((entry: Body) => entry.detail.ids?.includes(root.data.ticket.id));
    expect(ticketAudit).toMatchObject({ actorId: owner.user.id, action: 'mcp.create_ticket', detail: { tokenId: writer.id, room: 'tracker', ids: [root.data.ticket.id] } });
    expect(JSON.stringify(ticketAudit.detail)).not.toContain('Private title for audit test');
    expect(JSON.stringify(ticketAudit.detail)).not.toContain('Parent description');

    // Simulate legacy/imported text that bypassed command validation: MCP output removes invisible code points and clips long text.
    const raw = new DatabaseSync(path.join(h.dir, 'directory.sqlite'));
    try {
      raw.prepare('UPDATE tickets SET title = ?, description = ? WHERE id = ?').run('Injected\u200B title', 'x'.repeat(20_500), child.data.ticket.id);
    } finally {
      raw.close();
    }
    const fenced = await h.tool(writer.token, 'get_ticket', { key: child.data.ticket.key });
    expect(fenced.text).toContain('[board-content nonce=');
    expect(fenced.data.ticket.title).toBe('Injected title');
    expect(fenced.data.ticket.description.length).toBeLessThan(20_500);
    expect(fenced.data).toMatchObject({ cleaned: true, truncated: true });
  });

  it('rejects empty and punctuation-only search queries with the query path', async () => {
    const reader = await makeToken(member, 'read');
    for (const query of ['', '... ---']) {
      const result = await h.tool(reader.token, 'search_tickets', { query });
      expect(result.error).toBe('invalid_input');
      expect(result.data).toMatchObject({ message: 'Enter something to search for', path: 'query' });
    }
  });

  it('returns not_found for every ticket operation by a guest owner with a tracker capability', async () => {
    const guestToken = await makeToken(guest, 'write');
    const memberRead = await makeToken(member, 'read');
    const absent = await h.tool(memberRead.token, 'get_ticket', { key: 'TAB-999999' });
    const concealed = await h.tool(guestToken.token, 'get_ticket', { key: baselineTicket.key });
    expect(concealed.text).toBe(absent.text);
    const names = (await h.call(guestToken.token, 'tools/list')).body.result.tools.map((tool: Body) => tool.name);
    expect(names).toEqual(expect.arrayContaining(TICKET_TOOLS));
    const attempts: [string, Record<string, unknown>][] = [
      ['get_ticket', { key: baselineTicket.key }],
      ['list_tickets', {}],
      ['search_tickets', { query: 'baseline' }],
      ['list_ticket_states', {}],
      ['list_ticket_labels', {}],
      ['create_ticket', { title: 'hidden', idempotencyKey: 'guest-create-key' }],
      ['update_ticket', { key: baselineTicket.key, title: 'hidden update' }],
      ['transition_ticket', { key: baselineTicket.key, state: 'Done' }],
      ['comment_ticket', { key: baselineTicket.key, body: 'hidden comment' }],
      ['create_ticket_label', { name: 'Hidden' }],
      ['relate_tickets', { key: baselineTicket.key, relation: 'relates_to', otherKey: baselineTicket.key }],
      ['list_saved_views', {}],
      ['get_saved_view', { viewId: 'hidden-view' }],
      ['create_saved_view', { name: 'Hidden' }],
      ['update_saved_view', { viewId: 'hidden-view', name: 'Hidden' }],
      ['delete_saved_view', { viewId: 'hidden-view' }],
      ['list_projects', {}],
      ['create_project', { name: 'Hidden' }],
      ['update_project', { projectId: 'hidden-project', name: 'Hidden' }],
      ['list_milestones', { projectId: 'hidden-project' }],
      ['create_milestone', { projectId: 'hidden-project', name: 'Hidden', due: '2099-01-01' }],
      ['update_milestone', { milestoneId: 'hidden-milestone', name: 'Hidden' }],
    ];
    for (const [name, args] of attempts) expect((await h.tool(guestToken.token, name, args)).error).toBe('not_found');
  });

  it('does not charge idempotent create retries against the 10 per minute cap', async () => {
    const writer = await makeToken(member, 'write');
    let firstId = '';
    for (let i = 0; i < 10; i++) {
      const made = await h.tool(writer.token, 'create_ticket', { title: `Rate cap ${i}`, idempotencyKey: `rate-cap-${i}-key` });
      expect(made.error).toBeUndefined();
      if (i === 0) firstId = made.data.ticket.id;
    }
    const retry = await h.tool(writer.token, 'create_ticket', { title: 'Ignored retry title', idempotencyKey: 'rate-cap-0-key' });
    expect(retry.error).toBeUndefined();
    expect(retry.data.ticket.id).toBe(firstId);
    const limited = await h.call(writer.token, 'tools/call', { name: 'create_ticket', arguments: { title: 'Rate cap extra' } });
    expect(limited.status).toBe(429);
    expect(limited.body.error.data).toMatchObject({ error: 'rate_limited' });
    expect(limited.body.error.data.retryAfterSec).toBeGreaterThan(0);
  });
});

describe('tracker disabled and open mode', () => {
  it('leaves ticket tools unknown when the flag is off and in open mode, while migrations still run', async () => {
    const disabled = createHarness({ accounts: true, settings: { MCP: 'on' } });
    try {
      await disabled.start();
      const signedIn = await disabled.signInOwner();
      const rejected = await disabled.api(signedIn.cookie, 'POST', '/api/me/tokens', { name: 'not enabled', scope: 'read', tracker: 'read' });
      expect(rejected.status).toBe(400);
      expect(rejected.body.message).toBe('The tracker is not turned on');
      const ordinary = await disabled.newToken(signedIn.cookie, { scope: 'read' });
      const before = ticketCounts(disabled.dir);
      const names = (await disabled.call(ordinary.token, 'tools/list')).body.result.tools.map((tool: Body) => tool.name);
      expect(names).not.toEqual(expect.arrayContaining(TICKET_TOOLS));
      const hidden = await disabled.call(ordinary.token, 'tools/call', { name: 'create_ticket', arguments: { title: 'no write' } });
      const missing = await disabled.call(ordinary.token, 'tools/call', { name: 'tool_that_does_not_exist', arguments: {} });
      expect(hidden.body.error).toEqual(missing.body.error);
      const after = ticketCounts(disabled.dir);
      expect(after).toEqual(before);
      const version = new DatabaseSync(path.join(disabled.dir, 'directory.sqlite'));
      try { expect(version.prepare('PRAGMA user_version').get()!.user_version).toBe(MIGRATIONS.length); } finally { version.close(); }
    } finally {
      await disabled.cleanup();
    }

    const shared = 'o'.repeat(48);
    const open = createHarness({ settings: { MCP: 'on', MCP_TOKEN: shared, TRACKER: 'on' } });
    try {
      await open.start();
      const names = (await open.call(shared, 'tools/list')).body.result.tools.map((tool: Body) => tool.name);
      expect(names).not.toEqual(expect.arrayContaining(TICKET_TOOLS));
      const hidden = await open.call(shared, 'tools/call', { name: 'create_ticket', arguments: { title: 'open no write' } });
      const missing = await open.call(shared, 'tools/call', { name: 'tool_that_does_not_exist', arguments: {} });
      expect(hidden.body.error).toEqual(missing.body.error);
    } finally {
      await open.cleanup();
    }
  });
});

describe('read-only hosted tracker', () => {
  it('refuses every mutation before writes and keeps ticket reads available', async () => {
    const cloud = createHarness({
      accounts: true,
      settings: { MCP: 'on', TRACKER: 'on', CLOUD_TOKEN, CLOUD_URL: 'http://127.0.0.1:9', CLOUD_WORKSPACE_ID: 'tracker-readonly' },
    });
    try {
      await cloud.start();
      const cloudOwner = await cloud.signInOwner();
      const writer = await cloud.newToken(cloudOwner.cookie, { scope: 'read', tracker: 'write' });
      const baseline = await cloud.tool(writer.token, 'create_ticket', { title: 'Read-only baseline', idempotencyKey: 'readonly-baseline' });
      expect(baseline.error).toBeUndefined();
      const project = await cloud.tool(writer.token, 'create_project', { name: 'Read-only project' });
      const milestone = await cloud.tool(writer.token, 'create_milestone', { projectId: project.data.project.id, name: 'Read-only milestone', due: '2099-01-01' });
      const view = await cloud.tool(writer.token, 'create_saved_view', { name: 'Read-only view', filter: [] });
      const limits = await cloud.api(undefined, 'PUT', '/api/internal/limits', { readOnly: true }, { authorization: `Bearer ${CLOUD_TOKEN}` });
      expect(limits.status).toBe(200);
      const before = ticketCounts(cloud.dir);
      const attempts: [string, Record<string, unknown>][] = [
        ['create_ticket', { title: 'must not persist' }],
        ['update_ticket', { key: baseline.data.ticket.key, title: 'must not persist' }],
        ['transition_ticket', { key: baseline.data.ticket.key, state: 'Done' }],
        ['comment_ticket', { key: baseline.data.ticket.key, body: 'must not persist' }],
        ['create_ticket_label', { name: 'must not persist' }],
        ['relate_tickets', { key: baseline.data.ticket.key, relation: 'relates_to', otherKey: baseline.data.ticket.key }],
        ['create_project', { name: 'must not persist' }],
        ['update_project', { projectId: project.data.project.id, name: 'must not persist' }],
        ['create_milestone', { projectId: project.data.project.id, name: 'must not persist', due: '2099-01-01' }],
        ['update_milestone', { milestoneId: milestone.data.milestone.id, name: 'must not persist' }],
        ['create_saved_view', { name: 'must not persist', filter: [] }],
        ['update_saved_view', { viewId: view.data.view.id, name: 'must not persist' }],
        ['delete_saved_view', { viewId: view.data.view.id }],
      ];
      for (const [name, args] of attempts) {
        const result = await cloud.tool(writer.token, name, args);
        expect(result.error).toBe('read_only');
      }
      expect((await cloud.tool(writer.token, 'list_ticket_states')).error).toBeUndefined();
      expect((await cloud.tool(writer.token, 'list_tickets')).error).toBeUndefined();
      expect(ticketCounts(cloud.dir)).toEqual(before);
    } finally {
      await cloud.cleanup();
    }
  });
});
