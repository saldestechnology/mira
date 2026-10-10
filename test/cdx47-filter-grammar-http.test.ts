import { afterAll, beforeAll, describe, expect, it, test, vi } from 'vitest';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHarness, type Account, type Body, type Res } from './mcp-harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const h = createHarness({ accounts: true, settings: { MCP: 'on', TRACKER: 'on' } });
let owner: Account;
let member: Account;
let parent: Body;
let alpha: Body;
let beta: Body;
let done: Body;
let canceled: Body;
let target: Body;
let project: Body;
let milestone: Body;

const api = (
  who: Account | undefined,
  method: string,
  pathName: string,
  body?: unknown,
): Promise<Res> => h.api(who?.cookie, method, pathName, body);

function assertStatus(result: Res, expected: number) {
  if (result.status !== expected) {
    throw new Error(`Expected HTTP ${expected}, received ${result.status}: ${JSON.stringify(result.body)}`);
  }
}

async function makeTicket(who: Account, title: string, fields: Record<string, unknown> = {}): Promise<Body> {
  const result = await api(who, 'POST', '/api/tracker/tickets', {
    title,
    idempotencyKey: h.unique('cdx47-filter-'),
    ...fields,
  });
  expect(result.status).toBe(201);
  return result.body.ticket;
}

function ticketPath(filters: string[] = [], query?: string): string {
  const params = new URLSearchParams();
  for (const filter of filters) params.append('filter', filter);
  if (query !== undefined) params.set('q', query);
  return `/api/tracker/tickets?${params.toString()}`;
}

async function ticketKeys(filters: string[] = []): Promise<string[]> {
  const result = await api(owner, 'GET', ticketPath(filters));
  expect(result.status).toBe(200);
  return result.body.tickets.map((ticket: Body) => ticket.key).sort();
}

function setTimes(rows: Array<{ id: string; at: number }>) {
  const db = new DatabaseSync(path.join(h.dir, 'directory.sqlite'));
  try {
    const update = db.prepare('UPDATE tickets SET created_at = ?, updated_at = ? WHERE id = ?');
    for (const row of rows) update.run(row.at, row.at, row.id);
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  await h.start();
  owner = await h.signInOwner();
  const teamId = (await h.newTeam(owner.cookie)).id;
  member = await h.joinTeam(owner.cookie, teamId);

  parent = await makeTicket(owner, 'CDX-47 parent');
  alpha = await makeTicket(owner, 'CDX-47 alpha', { state: 'in_progress', priority: 'high', parent: parent.key });
  beta = await makeTicket(member, 'CDX-47 beta', { state: 'todo', priority: 'low', assigneeId: member.user.id });
  done = await makeTicket(owner, 'CDX-47 done', { state: 'done', priority: 'none', assigneeId: owner.user.id });
  canceled = await makeTicket(owner, 'CDX-47 canceled', { state: 'cancelled', priority: 'urgent' });
  target = await makeTicket(owner, 'CDX-47 blocked target');

  const projectResult = await api(owner, 'POST', '/api/tracker/projects', { name: 'CDX-47 Atlas' });
  assertStatus(projectResult, 201);
  project = projectResult.body.project;
  const milestoneResult = await api(owner, 'POST', `/api/tracker/projects/${project.id}/milestones`, {
    name: 'CDX-47 Launch',
    due: '2026-11-01',
  });
  assertStatus(milestoneResult, 201);
  milestone = milestoneResult.body.milestone;

  const associated = await api(owner, 'PATCH', `/api/tracker/tickets/${alpha.key}`, {
    project: project.name,
    milestone: milestone.name,
  });
  assertStatus(associated, 200);

  const relation = await api(owner, 'POST', `/api/tracker/tickets/${alpha.key}/relations`, {
    relation: 'blocks',
    otherKey: target.key,
  });
  assertStatus(relation, 200);

  const boundary = Date.UTC(2026, 9, 10, 0, 0, 0);
  setTimes([
    { id: parent.id, at: boundary - 2 * 24 * 60 * 60 * 1000 },
    { id: alpha.id, at: boundary },
    { id: beta.id, at: boundary + 1 },
    { id: done.id, at: boundary - 1 },
    { id: canceled.id, at: boundary - 1 },
    { id: target.id, at: boundary + 2 },
  ]);
});

afterAll(async () => {
  await h.cleanup();
});

describe('tracker filter grammar over real HTTP', () => {
  it('applies negation, comma any-of values, creator, priority, and state category', async () => {
    expect(await ticketKeys(['-state:done,cancelled'])).toEqual([parent.key, alpha.key, beta.key, target.key].sort());
    expect(await ticketKeys(['priority:high,low'])).toEqual([alpha.key, beta.key].sort());
    expect(await ticketKeys(['creator:me'])).toEqual([parent.key, alpha.key, done.key, canceled.key, target.key].sort());
    expect(await ticketKeys([`creator:${member.email}`])).toEqual([beta.key]);
    expect(await ticketKeys(['category:started,unstarted'])).toEqual([parent.key, alpha.key, beta.key, target.key].sort());
  });

  it('compares created and updated timestamps at UTC day boundaries', async () => {
    const atOrAfterUtcMidnight = [alpha.key, beta.key, target.key].sort();
    const strictlyBeforeUtcMidnight = [parent.key, done.key, canceled.key].sort();
    expect(await ticketKeys(['created:after-2026-10-10'])).toEqual(atOrAfterUtcMidnight);
    expect(await ticketKeys(['created:before-2026-10-10'])).toEqual(strictlyBeforeUtcMidnight);
    expect(await ticketKeys(['updated:after-2026-10-10'])).toEqual(atOrAfterUtcMidnight);
    expect(await ticketKeys(['updated:before-2026-10-10'])).toEqual(strictlyBeforeUtcMidnight);
  });

  it('matches no-assignee, project and milestone names, parents, and blocking relations', async () => {
    expect(await ticketKeys(['assignee:none'])).toEqual([parent.key, alpha.key, canceled.key, target.key].sort());
    expect(await ticketKeys(['-assignee:none'])).toEqual([beta.key, done.key].sort());
    expect(await ticketKeys([`project:${project.name}`])).toEqual([alpha.key]);
    expect(await ticketKeys([`milestone:${milestone.name}`])).toEqual([alpha.key]);
    expect(await ticketKeys([`parent:${parent.key.toLowerCase()}`])).toEqual([alpha.key]);
    expect(await ticketKeys([`blocks:${target.key.toLowerCase()}`])).toEqual([alpha.key]);
    expect(await ticketKeys([`blocked-by:${alpha.key}`])).toEqual([target.key]);
  });

  it('runs the same compound grammar from a saved view', async () => {
    const filter = [
      '-state:done,cancelled',
      'priority:high,low',
      'creator:me',
      'category:started,unstarted',
      'created:after-2026-10-10',
      'updated:after-2026-10-10',
      'assignee:none',
      `project:${project.name}`,
      `milestone:${milestone.name}`,
      `parent:${parent.key}`,
      `blocks:${target.key}`,
    ];
    const created = await api(owner, 'POST', '/api/tracker/views', {
      name: 'CDX-47 compound grammar',
      filter,
    });
    expect(created.status).toBe(201);

    const result = await api(owner, 'GET', `/api/tracker/views/${created.body.view.id}/tickets`);
    expect(result.status).toBe(200);
    expect(result.body.tickets.map((ticket: Body) => ticket.key)).toEqual([alpha.key]);
  });

  it.each([
    ['a 21-value list', `priority:${Array.from({ length: 21 }, () => 'high').join(',')}`],
    ['Unicode', 'priority:🚀'],
    ['quote and escape syntax', String.raw`priority:"high\' OR 1=1--`],
    ['SQL metacharacters', "project:'); DROP TABLE tickets;--"],
    ['an invalid calendar date', 'created:after-2026-02-30'],
  ])('returns a clear 400 for hostile filter input: %s', async (_label, filter) => {
    const result = await api(owner, 'GET', ticketPath([filter]));
    expect(result.status).not.toBe(500);
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      error: 'invalid_filter',
      message: expect.stringContaining(filter),
      path: filter,
    });
  });

  it('keeps the tracker available after hostile filter values', async () => {
    const result = await api(owner, 'GET', ticketPath());
    expect(result.status).toBe(200);
    expect(result.body.tickets.map((ticket: Body) => ticket.key)).toContain(alpha.key);
  });

  it('returns a clear client error instead of 500 for a 10,000-character search', async () => {
    const result = await api(owner, 'GET', ticketPath([], 'x'.repeat(10_000)));
    expect(result.status).not.toBe(500);
    expect(result.status).toBe(413);
    expect(result.body).toMatchObject({
      error: 'limit_exceeded',
      message: expect.any(String),
      path: 'q',
    });
  });

});
