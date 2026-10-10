import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHarness, type Account } from './mcp-harness';

const h = createHarness({
  accounts: true,
  settings: { TRACKER: 'on', MCP: 'on' },
  env: { NODE_ENV: 'test' },
});
let owner: Account;

beforeAll(async () => {
  await h.start();
  owner = await h.signInOwner();
});
afterAll(() => h.cleanup());

function withDirectory<T>(fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path.join(h.dir, 'directory.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return fn(db);
  } finally {
    db.close();
  }
}

function insertTicket(db: DatabaseSync, number: number, title = `Ticket ${number}`) {
  const id = crypto.randomUUID();
  const key = `TAB-${number}`;
  db.prepare(
    `INSERT INTO tickets
      (id, prefix, number, key, title, state_id, tracker_id, priority, created_at, updated_at, created_by_type, created_by_id, updated_seq, source)
     VALUES (?, 'TAB', ?, ?, ?, 'st_todo', 'trk_default', 0, 100, 100, 'user', ?, 0, 'test')`,
  ).run(id, number, key, title, owner.user.id);
  return { id, key, title };
}

function insertNotice(db: DatabaseSync, input: { id: string; userId: string; ticketId: string; createdAt: number; kind?: string }) {
  db.prepare(
    `INSERT INTO notifications
      (id, user_id, ticket_id, kind, dedupe_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.id, input.userId, input.ticketId, input.kind ?? 'assigned', `dedupe-${input.id}`, input.createdAt);
}

describe('tracker inbox REST routes', { timeout: 60_000 }, () => {
  it('requires a session and registers routes only when the tracker is enabled', async () => {
    const missing = await h.api(undefined, 'GET', '/api/tracker/inbox');
    expect(missing.status).toBe(401);
    const token = await h.newToken(owner.cookie, { scope: 'read', tracker: 'read' });
    const tokenOnly = await h.api(undefined, 'GET', '/api/tracker/inbox', undefined, { authorization: `Bearer ${token.token}` });
    expect(tokenOnly.status).toBe(401);

    const disabled = createHarness({ accounts: true, settings: { TRACKER: 'off' }, env: { NODE_ENV: 'test' } });
    try {
      await disabled.start();
      const account = await disabled.signInOwner();
      expect((await disabled.api(account.cookie, 'GET', '/api/tracker/inbox')).status).toBe(404);
    } finally {
      await disabled.cleanup();
    }
  });

  it('lists only the signed-in person\'s rows with bounded pages and unread counts', async () => {
    const other = await h.joinTeam(owner.cookie, (await h.newTeam(owner.cookie)).id);
    const seeded = withDirectory((db) => {
      db.exec('DELETE FROM notifications');
      const ticket = insertTicket(db, 901);
      const ownIds: string[] = [];
      for (let i = 0; i < 51; i++) {
        const id = `owner-notice-${i}`;
        insertNotice(db, { id, userId: owner.user.id, ticketId: ticket.id, createdAt: 1000 + i });
        ownIds.push(id);
      }
      const otherId = 'other-user-notice';
      insertNotice(db, { id: otherId, userId: other.user.id, ticketId: ticket.id, createdAt: 5000 });
      return { ticket, ownIds, otherId };
    });

    const first = await h.api(owner.cookie, 'GET', '/api/tracker/inbox?limit=500');
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(50);
    expect(first.body.unread).toBe(51);
    expect(first.body.items.some((row: any) => row.id === seeded.otherId)).toBe(false);
    const second = await h.api(owner.cookie, 'GET', `/api/tracker/inbox?before=${encodeURIComponent(first.body.nextCursor)}`);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
    expect((await h.api(owner.cookie, 'GET', '/api/tracker/inbox?unread=1&limit=50')).body.items).toHaveLength(50);
    expect((await h.api(owner.cookie, 'GET', '/api/tracker/inbox/unread')).body).toEqual({ unread: 51 });
    expect((await h.api(owner.cookie, 'GET', '/api/tracker/inbox?limit=not-a-number')).status).toBe(400);
  });

  it('requires CSRF, limits read ids, and marks only the caller\'s rows read', async () => {
    const other = await h.joinTeam(owner.cookie, (await h.newTeam(owner.cookie)).id);
    const seeded = withDirectory((db) => {
      db.exec('DELETE FROM notifications');
      const ticket = insertTicket(db, 902);
      insertNotice(db, { id: 'owner-read-row', userId: owner.user.id, ticketId: ticket.id, createdAt: 1000 });
      insertNotice(db, { id: 'other-read-row', userId: other.user.id, ticketId: ticket.id, createdAt: 1000 });
      return ticket;
    });
    const csrf = await fetch(`${h.base}/api/tracker/inbox/read`, {
      method: 'POST',
      headers: { cookie: owner.cookie, 'content-type': 'application/json', origin: h.base },
      body: JSON.stringify({ all: true }),
    });
    expect(csrf.status).toBe(403);
    expect((await csrf.json()).error).toBe('csrf');

    const tooMany = await h.api(owner.cookie, 'POST', '/api/tracker/inbox/read', { ids: Array.from({ length: 101 }, (_, i) => `id-${i}`) });
    expect(tooMany.status).toBe(400);
    const read = await h.api(owner.cookie, 'POST', '/api/tracker/inbox/read', { ids: ['owner-read-row', 'other-read-row'] });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ updated: 1, unread: 0 });
    const states = withDirectory((db) => ({
      own: db.prepare('SELECT read_at FROM notifications WHERE id = ?').get('owner-read-row')?.read_at,
      other: db.prepare('SELECT read_at FROM notifications WHERE id = ?').get('other-read-row')?.read_at,
    }));
    expect(states.own).not.toBeNull();
    expect(states.other).toBeNull();
    expect(seeded.key).toBe('TAB-902');
  });

  it('gets and updates preferences, converting bad kinds and choices to bad_request', async () => {
    const initial = await h.api(owner.cookie, 'GET', '/api/tracker/notification-prefs');
    expect(initial.status).toBe(200);
    expect(initial.body.kinds).toContain('integration_activity');
    expect(initial.body.prefs.assigned).toBe('both');

    const updated = await h.api(owner.cookie, 'PUT', '/api/tracker/notification-prefs', { prefs: { assigned: 'app', commented: 'off' } });
    expect(updated.status).toBe(200);
    expect(updated.body.prefs).toMatchObject({ assigned: 'app', commented: 'off' });
    const invalidKind = await h.api(owner.cookie, 'PUT', '/api/tracker/notification-prefs', { prefs: { unknown: 'off' } });
    expect(invalidKind.status).toBe(400);
    expect(invalidKind.body).toMatchObject({ error: 'bad_request', message: 'Unsupported notification kind' });
    const invalidChoice = await h.api(owner.cookie, 'PUT', '/api/tracker/notification-prefs', { prefs: { assigned: 'sometimes' } });
    expect(invalidChoice.status).toBe(400);
    expect(invalidChoice.body).toMatchObject({ error: 'bad_request', message: 'Must be one of both, app, off' });
  });
});
