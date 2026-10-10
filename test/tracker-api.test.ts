import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHarness, type Account, type Body } from './mcp-harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const CLOUD_TOKEN = 'c'.repeat(48);
const h = createHarness({ accounts: true, settings: { MCP: 'on', TRACKER: 'on' } });
let owner: Account;
let member: Account;
let guest: Account;
let baseline: Body;

const api = (who: Account | undefined, method: string, pathName: string, body?: unknown, headers: Record<string, string> = {}) =>
  h.api(who?.cookie, method, pathName, body, headers);

function counts(directory: string) {
  const db = new DatabaseSync(path.join(directory, 'directory.sqlite'));
  try {
    return {
      tickets: Number(db.prepare('SELECT COUNT(*) AS n FROM tickets').get()!.n),
      events: Number(db.prepare('SELECT COUNT(*) AS n FROM ticket_events').get()!.n),
      comments: Number(db.prepare('SELECT COUNT(*) AS n FROM ticket_comments').get()!.n),
      subscriptions: Number(db.prepare('SELECT COUNT(*) AS n FROM ticket_subscriptions').get()!.n),
      audit: Number(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action LIKE 'tracker.ticket.%'").get()!.n),
    };
  } finally {
    db.close();
  }
}

function dbFor(directory: string, fn: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(path.join(directory, 'directory.sqlite'));
  try { fn(db); } finally { db.close(); }
}

beforeAll(async () => {
  await h.start();
  owner = await h.signInOwner();
  const teamId = (await h.newTeam(owner.cookie)).id;
  member = await h.joinTeam(owner.cookie, teamId);
  guest = await h.joinTeam(owner.cookie, teamId);
  const changed = await api(owner, 'PATCH', `/api/members/${guest.user.id}`, { role: 'guest' });
  if (changed.status !== 200) throw new Error(`could not make a guest (${changed.status})`);
  const made = await api(owner, 'POST', '/api/tracker/tickets', {
    title: 'Tracker API baseline', idempotencyKey: 'tracker-api-baseline',
  });
  if (made.status !== 201) throw new Error(`could not create tracker baseline (${made.status})`);
  baseline = made.body.ticket;
});

afterAll(async () => {
  await h.cleanup();
});

describe('tracker session API', () => {
  it('uses the session and CSRF checks and exposes tracker capability only to members', async () => {
    expect((await api(undefined, 'GET', '/api/tracker/meta')).status).toBe(401);
    // reads follow the API convention (no CSRF header needed); a mutation without the header is refused
    expect((await api(owner, 'GET', '/api/tracker/meta', undefined, { 'x-tabula': '', 'x-mira': '' })).status).toBe(200);
    const missingCsrf = await api(owner, 'POST', '/api/tracker/tickets', { title: 'No header', idempotencyKey: 'no-header-key' }, { 'x-tabula': '', 'x-mira': '' });
    expect(missingCsrf.status).toBe(403);
    expect(missingCsrf.body).toMatchObject({ error: 'csrf' });

    const ownerMe = await api(owner, 'GET', '/api/me');
    expect(ownerMe.body.tracker).toBe(true);
    const guestMe = await api(guest, 'GET', '/api/me');
    expect(Object.hasOwn(guestMe.body, 'tracker')).toBe(false);
    expect((await api(guest, 'GET', '/api/tracker/meta')).status).toBe(404);
    expect((await api(guest, 'GET', '/api/tracker/meta')).status).toBe(404);
  });

  it('returns metadata with member names and initials but no email addresses', async () => {
    const meta = await api(owner, 'GET', '/api/tracker/meta');
    expect(meta.status).toBe(200);
    expect(meta.body).toMatchObject({ enabled: true, trackerId: 'trk_default', prefix: 'TAB', me: { userId: owner.user.id, canWrite: true } });
    expect(meta.body.states[0]).toMatchObject({ id: 'st_todo', key: 'todo', name: 'To do', category: 'unstarted', position: 0 });
    expect(meta.body.labels).toEqual([]);
    expect(meta.body.members).toContainEqual({ userId: owner.user.id, name: owner.user.name, initials: expect.any(String) });
    expect(meta.body.members.every((row: Body) => Object.keys(row).sort().join(',') === 'initials,name,userId')).toBe(true);
    expect(JSON.stringify(meta.body)).not.toContain('@');
  });

  it('creates, lists, searches, updates, transitions, comments on, and reads tickets', async () => {
    const labelId = 'tracker-api-label';
    dbFor(h.dir, (db) => {
      db.prepare('INSERT INTO labels (id, name, color, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
        .run(labelId, 'API Bug', '#D02020', Date.now(), owner.user.id);
    });
    const created = await api(owner, 'POST', '/api/tracker/tickets', {
      title: 'Searchable API ticket', description: 'A body needle.', priority: 'high', assigneeId: member.user.id,
      labels: ['API Bug'], due: '2026-11-01', idempotencyKey: 'tracker-api-create-001',
    });
    expect(created.status).toBe(201);
    expect(created.body.ticket).toMatchObject({
      title: 'Searchable API ticket',
      priority: 'high',
      assignee: { userId: member.user.id, name: member.user.name },
      labels: [{ id: labelId, name: 'API Bug', color: '#D02020' }],
      due: '2026-11-01',
      state: { id: 'st_todo', key: 'todo', name: 'To do', category: 'unstarted' },
      project: null,
      milestone: null,
      relations: [],
      links: [],
      aliases: [],
    });
    const ticket = created.body.ticket;
    const retry = await api(owner, 'POST', '/api/tracker/tickets', {
      title: 'Retry body ignored', idempotencyKey: 'tracker-api-create-001',
    });
    expect(retry.status).toBe(201);
    expect(retry.body.ticket.id).toBe(ticket.id);

    const listed = await api(owner, 'GET', '/api/tracker/tickets?filter=label%3AAPI%20Bug&limit=10');
    expect(listed.status).toBe(200);
    expect(listed.body.tickets.map((item: Body) => item.id)).toContain(ticket.id);
    expect(listed.body.nextCursor).toBeNull();
    const searched = await api(owner, 'GET', '/api/tracker/tickets?q=needle&filter=label%3AAPI%20Bug');
    expect(searched.body.tickets[0]).toMatchObject({ id: ticket.id, snippet: expect.stringContaining('<mark>needle</mark>') });

    const comment = await api(owner, 'POST', `/api/tracker/tickets/${ticket.key}/comments`, { body: 'A comment from the API', clientId: 'api-comment-001' });
    expect(comment.status).toBe(201);
    expect(comment.body.comment).toMatchObject({ author: owner.user.name, body: 'A comment from the API' });
    expect(comment.body.ticket.id).toBe(ticket.id);

    const changed = await api(owner, 'PATCH', `/api/tracker/tickets/${ticket.key}`, {
      title: 'Updated API ticket', assigneeId: owner.user.id, ifUpdatedSeq: comment.body.ticket.updatedSeq,
    });
    expect(changed.status).toBe(200);
    expect(changed.body.ticket).toMatchObject({ title: 'Updated API ticket', assignee: { userId: owner.user.id } });

    const stale = await api(owner, 'PATCH', `/api/tracker/tickets/${ticket.key}`, {
      title: 'Stale API ticket', ifUpdatedSeq: ticket.updatedSeq,
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: 'conflict', ticket: { id: ticket.id, title: 'Updated API ticket' } });

    const transitioned = await api(owner, 'POST', `/api/tracker/tickets/${ticket.key}/transition`, { state: 'Done' });
    expect(transitioned.status).toBe(200);
    expect(transitioned.body.ticket.state).toMatchObject({ key: 'done', name: 'Done', category: 'completed' });

    const detail = await api(owner, 'GET', `/api/tracker/tickets/${ticket.key.toLowerCase()}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ ticket: { id: ticket.id, title: 'Updated API ticket' }, subscribed: true });
    expect(detail.body.comments).toEqual([expect.objectContaining({ id: comment.body.comment.id, body: 'A comment from the API' })]);
    expect(detail.body.events.map((event: Body) => event.eventType)).toEqual(expect.arrayContaining(['created', 'updated', 'transitioned', 'commented']));
  });

  it('validates inputs, maps command errors, and resolves aliases to canonical keys', async () => {
    const invalidTitle = await api(owner, 'POST', '/api/tracker/tickets', { title: '', idempotencyKey: 'invalid-title-key' });
    expect(invalidTitle.status).toBe(400);
    expect(invalidTitle.body).toMatchObject({ error: 'invalid_input', path: 'title' });
    const missingIdem = await api(owner, 'POST', '/api/tracker/tickets', { title: 'Missing key' });
    expect(missingIdem.status).toBe(400);
    expect(missingIdem.body.path).toBe('idempotencyKey');
    const unknownMember = await api(owner, 'POST', '/api/tracker/tickets', {
      title: 'Bad assignee', assigneeId: guest.user.id, idempotencyKey: 'bad-assignee-id-001',
    });
    expect(unknownMember.status).toBe(400);
    expect(unknownMember.body).toMatchObject({ error: 'invalid_input', path: 'assigneeId' });
    const twoAssignees = await api(owner, 'POST', '/api/tracker/tickets', {
      title: 'Two assignees', assignee: 'me', assigneeId: owner.user.id, idempotencyKey: 'two-assignees-001',
    });
    expect(twoAssignees.body).toMatchObject({ error: 'invalid_input', path: 'assigneeId' });

    const invalidFilter = await api(owner, 'GET', '/api/tracker/tickets?filter=unknown%3Avalue');
    expect(invalidFilter.status).toBe(400);
    expect(invalidFilter.body).toMatchObject({ error: 'invalid_filter', path: 'unknown:value' });
    const longSearch = await api(owner, 'GET', `/api/tracker/tickets?q=${'x'.repeat(513)}`);
    expect(longSearch.status).toBe(413);
    expect(longSearch.body.error).toBe('limit_exceeded');
    const missingTicket = await api(owner, 'GET', '/api/tracker/tickets/TAB-999999');
    expect(missingTicket.status).toBe(404);
    expect(missingTicket.body.error).toBe('not_found');

    const alias = 'imported-legacy-id';
    dbFor(h.dir, (db) => {
      db.prepare(
        `INSERT INTO ticket_aliases (id, ticket_id, provider, external_id, display_key, created_at)
         VALUES (?, ?, 'import', ?, ?, ?)`,
      ).run('tracker-api-alias-row', baseline.id, alias, 'LEGACY-17', Date.now());
    });
    const resolved = await api(owner, 'GET', `/api/tracker/tickets/${alias}`);
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({ ticket: { key: baseline.key }, resolvedKey: baseline.key });
    const canonical = await api(owner, 'GET', `/api/tracker/tickets/${baseline.key}`);
    expect(Object.hasOwn(canonical.body, 'resolvedKey')).toBe(false);
  });

  it('pages older comments and events with stable cursors', async () => {
    const key = baseline.key;
    dbFor(h.dir, (db) => {
      const insert = db.prepare(
        `INSERT INTO ticket_comments (id, ticket_id, actor_type, actor_id, author_snapshot, body, created_at)
         VALUES (?, ?, 'user', ?, 'Owner', ?, ?)`,
      );
      for (let index = 1; index <= 3; index++) insert.run(`tracker-api-comment-${index}`, baseline.id, owner.user.id, `Older ${index}`, index);
    });
    const comments = await api(owner, 'GET', `/api/tracker/tickets/${key}/comments?before=tracker-api-comment-3&limit=1`);
    expect(comments.body).toMatchObject({
      comments: [{ id: 'tracker-api-comment-2', body: 'Older 2' }],
      nextBefore: 'tracker-api-comment-2',
    });
    const previousComments = await api(owner, 'GET', `/api/tracker/tickets/${key}/comments?before=${comments.body.nextBefore}&limit=1`);
    expect(previousComments.body).toMatchObject({ comments: [{ id: 'tracker-api-comment-1' }], nextBefore: null });

    for (let index = 1; index <= 3; index++) {
      const changed = await api(owner, 'PATCH', `/api/tracker/tickets/${key}`, { title: `Pagination event ${index}` });
      expect(changed.status).toBe(200);
    }
    const eventIds: number[] = [];
    dbFor(h.dir, (db) => {
      const rows = db.prepare('SELECT id FROM ticket_events WHERE ticket_id = ? ORDER BY id').all(baseline.id) as Body[];
      eventIds.push(...rows.map((row) => Number(row.id)));
    });
    expect(eventIds.length).toBeGreaterThan(0);
    const page = await api(owner, 'GET', `/api/tracker/tickets/${key}/events?before=${eventIds.at(-1)}&limit=1`);
    expect(page.body.events).toHaveLength(1);
    expect(Number(page.body.events[0].eventSeq)).toBe(eventIds.at(-2));
    expect(page.body.nextBefore).toBe(String(eventIds.at(-2)));
    const previous = await api(owner, 'GET', `/api/tracker/tickets/${key}/events?before=${page.body.nextBefore}&limit=1`);
    expect(Number(previous.body.events[0].eventSeq)).toBe(eventIds.at(-3));
  });

  it('keeps subscriptions private, idempotent, and out of the ticket event stream', async () => {
    const beforeEvents = counts(h.dir).events;
    expect((await api(owner, 'PUT', `/api/tracker/tickets/${baseline.key}/subscription`)).body).toEqual({ subscribed: true });
    expect((await api(owner, 'PUT', `/api/tracker/tickets/${baseline.key}/subscription`)).body).toEqual({ subscribed: true });
    const detail = await api(owner, 'GET', `/api/tracker/tickets/${baseline.key}`);
    expect(detail.body.subscribed).toBe(true);
    const memberDetail = await api(member, 'GET', `/api/tracker/tickets/${baseline.key}`);
    expect(memberDetail.body.subscribed).toBe(false);
    dbFor(h.dir, (db) => {
      expect(db.prepare('SELECT user_id FROM ticket_subscriptions WHERE ticket_id = ?').all(baseline.id)).toEqual([{ user_id: owner.user.id }]);
    });
    expect(counts(h.dir).events).toBe(beforeEvents);
    expect((await api(owner, 'DELETE', `/api/tracker/tickets/${baseline.key}/subscription`)).body).toEqual({ subscribed: false });
    expect((await api(owner, 'DELETE', `/api/tracker/tickets/${baseline.key}/subscription`)).body).toEqual({ subscribed: false });
  });

  it('limits tracker mutations to 60 per user per minute', async () => {
    const teamId = (await h.newTeam(owner.cookie)).id;
    const limited = await h.joinTeam(owner.cookie, teamId);
    for (let index = 0; index < 60; index++) {
      const result = await api(limited, 'POST', '/api/tracker/tickets', {
        title: `Rate cap ${index}`, idempotencyKey: `tracker-rate-${index}-key`,
      });
      expect(result.status, `mutation ${index + 1}`).toBe(201);
    }
    const rejected = await api(limited, 'POST', '/api/tracker/tickets', {
      title: 'Rate cap overflow', idempotencyKey: 'tracker-rate-overflow',
    });
    expect(rejected.status).toBe(429);
    expect(rejected.body.error).toBe('rate_limited');
    expect(Number(rejected.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('returns the bootstrap feed cursor and pages ordered event IDs with a 200-event cap', async () => {
    const bootstrap = await api(owner, 'GET', '/api/tracker/feed');
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.body.events).toEqual([]);
    const baseSeq = Number(bootstrap.body.seq);
    dbFor(h.dir, (db) => {
      const insert = db.prepare(
        `INSERT INTO ticket_events (ticket_id, event_type, schema_version, actor_type, actor_id, source, created_at, details_json)
         VALUES (?, 'updated', 1, 'user', ?, 'api-test', ?, '{}')`,
      );
      for (let index = 1; index <= 205; index++) insert.run(baseline.id, owner.user.id, index);
    });
    const first = await api(owner, 'GET', `/api/tracker/feed?since=${baseSeq}`);
    expect(first.body.events).toHaveLength(200);
    expect(first.body.seq).toBeGreaterThan(first.body.events.at(-1).id);
    expect(first.body.events[0].id).toBeLessThan(first.body.events.at(-1).id);
    expect(first.body.events[0]).toMatchObject({ ticketKey: baseline.key, eventType: 'updated', actor: { type: 'user', id: owner.user.id, name: owner.user.name } });
    const last = first.body.events.at(-1).id;
    const second = await api(owner, 'GET', `/api/tracker/feed?since=${last}`);
    expect(second.body.events).toHaveLength(5);
    expect(second.body.events[0].id).toBeGreaterThan(last);
    expect(second.body.more).toBeUndefined();
  });

  it('polls changed tickets oldest first and reports the 200-ticket cap', async () => {
    const seedStart = 20_000;
    const seedCount = 205;
    dbFor(h.dir, (db) => {
      const insert = db.prepare(
        `INSERT INTO tickets (id, prefix, number, key, title, state_id, tracker_id, created_at, updated_at,
                             created_by_type, created_by_id, updated_seq, source)
         VALUES (?, 'TAB', ?, ?, ?, 'st_todo', 'trk_default', 1, 1, 'user', ?, ?, 'api-test')`,
      );
      for (let index = 0; index < seedCount; index++) {
        insert.run(`tracker-api-seed-${index}`, seedStart + index, `TAB-${seedStart + index}`, `Seed ${index}`, owner.user.id, 50_000 + index);
      }
    });
    const first = await api(owner, 'GET', '/api/tracker/tickets?updatedSince=49999');
    expect(first.status).toBe(200);
    expect(first.body.tickets).toHaveLength(200);
    expect(first.body.tickets[0].updatedSeq).toBe(50_000);
    expect(first.body.tickets.at(-1).updatedSeq).toBe(50_199);
    expect(first.body).toMatchObject({ seq: 50_204, more: true });
    const next = await api(owner, 'GET', '/api/tracker/tickets?updatedSince=50199');
    expect(next.body.tickets).toHaveLength(5);
    expect(next.body.tickets[0].updatedSeq).toBe(50_200);
  });
});

describe('tracker REST feature gates and hosted read-only mode', () => {
  it('returns the ordinary not-found response for every route with the flag off and in open mode', async () => {
    const off = createHarness({ accounts: true, settings: { MCP: 'on' } });
    const open = createHarness({ settings: { TRACKER: 'on' } });
    const calls: [string, string, unknown?][] = [
      ['GET', '/api/tracker/meta'],
      ['GET', '/api/tracker/tickets'],
      ['POST', '/api/tracker/tickets', { title: 'hidden', idempotencyKey: 'hidden-ticket-key' }],
      ['GET', '/api/tracker/tickets/TAB-1'],
      ['GET', '/api/tracker/tickets/TAB-1/comments'],
      ['GET', '/api/tracker/tickets/TAB-1/events'],
      ['PATCH', '/api/tracker/tickets/TAB-1', { title: 'hidden' }],
      ['POST', '/api/tracker/tickets/TAB-1/transition', { state: 'Done' }],
      ['POST', '/api/tracker/tickets/TAB-1/comments', { body: 'hidden' }],
      ['PUT', '/api/tracker/tickets/TAB-1/subscription'],
      ['DELETE', '/api/tracker/tickets/TAB-1/subscription'],
      ['GET', '/api/tracker/feed'],
    ];
    try {
      await off.start();
      const signedIn = await off.signInOwner();
      for (const [method, route, body] of calls) {
        const result = await off.api(signedIn.cookie, method, route, body);
        expect(result.status, `${method} ${route}`).toBe(404);
        expect(result.body).toEqual({ error: 'not_found', message: 'No such endpoint' });
      }

      await open.start();
      for (const [method, route, body] of calls) {
        const result = await open.api(undefined, method, route, body);
        expect(result.status, `${method} ${route}`).toBe(404);
      }
    } finally {
      await off.cleanup();
      await open.cleanup();
    }
  });

  it('hides every tracker endpoint from workspace guests', async () => {
    const calls: [string, string, unknown?][] = [
      ['GET', '/api/tracker/meta'], ['GET', '/api/tracker/tickets'],
      ['POST', '/api/tracker/tickets', { title: 'hidden', idempotencyKey: 'guest-hidden-ticket' }],
      ['GET', `/api/tracker/tickets/${baseline.key}`],
      ['GET', `/api/tracker/tickets/${baseline.key}/comments`],
      ['GET', `/api/tracker/tickets/${baseline.key}/events`],
      ['PATCH', `/api/tracker/tickets/${baseline.key}`, { title: 'hidden' }],
      ['POST', `/api/tracker/tickets/${baseline.key}/transition`, { state: 'Done' }],
      ['POST', `/api/tracker/tickets/${baseline.key}/comments`, { body: 'hidden' }],
      ['PUT', `/api/tracker/tickets/${baseline.key}/subscription`],
      ['DELETE', `/api/tracker/tickets/${baseline.key}/subscription`],
      ['GET', '/api/tracker/feed'],
    ];
    for (const [method, route, body] of calls) {
      const result = await api(guest, method, route, body);
      expect(result.status, `${method} ${route}`).toBe(404);
      expect(result.body).toMatchObject({ error: 'not_found' });
    }
  });

  it('allows reads but blocks every mutation before writing when the cloud workspace is read-only', async () => {
    const cloud = createHarness({
      accounts: true,
      settings: { MCP: 'on', TRACKER: 'on', CLOUD_TOKEN, CLOUD_URL: 'http://127.0.0.1:9', CLOUD_WORKSPACE_ID: 'tracker-api-readonly' },
    });
    try {
      await cloud.start();
      const account = await cloud.signInOwner();
      const made = await cloud.api(account.cookie, 'POST', '/api/tracker/tickets', { title: 'Read-only ticket', idempotencyKey: 'readonly-api-ticket-1' });
      expect(made.status).toBe(201);
      const enabled = await cloud.api(undefined, 'PUT', '/api/internal/limits', { readOnly: true }, { authorization: `Bearer ${CLOUD_TOKEN}` });
      expect(enabled.status).toBe(200);
      const before = counts(cloud.dir);

      expect((await cloud.api(account.cookie, 'GET', '/api/tracker/meta')).status).toBe(200);
      expect((await cloud.api(account.cookie, 'GET', `/api/tracker/tickets/${made.body.ticket.key}`)).status).toBe(200);
      const mutations: [string, string, unknown?][] = [
        ['POST', '/api/tracker/tickets', { title: 'Must not persist', idempotencyKey: 'readonly-api-ticket-2' }],
        ['PATCH', `/api/tracker/tickets/${made.body.ticket.key}`, { title: 'Must not persist' }],
        ['POST', `/api/tracker/tickets/${made.body.ticket.key}/transition`, { state: 'Done' }],
        ['POST', `/api/tracker/tickets/${made.body.ticket.key}/comments`, { body: 'Must not persist' }],
        ['PUT', `/api/tracker/tickets/${made.body.ticket.key}/subscription`],
        ['DELETE', `/api/tracker/tickets/${made.body.ticket.key}/subscription`],
      ];
      for (const [method, route, body] of mutations) {
        const result = await cloud.api(account.cookie, method, route, body);
        expect(result.status, `${method} ${route}`).toBe(403);
        expect(result.body.error).toBe('read_only');
      }
      expect(counts(cloud.dir)).toEqual(before);
    } finally {
      await cloud.cleanup();
    }
  });
});
