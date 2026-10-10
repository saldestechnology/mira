import { afterEach, describe, expect, it } from 'vitest';
import { openDirectory } from '../server/directory.mjs';
import { listNotifications, markRead, unreadCount } from '../server/tracker/inbox.mjs';
import { createTicket } from '../server/tracker/tickets.mjs';

const opened: any[] = [];
const open = (): any => {
  const directory: any = openDirectory(':memory:');
  opened.push(directory);
  return directory;
};

function fixture() {
  const directory = open();
  const owner = directory.createUser({ email: 'owner@example.com', name: 'Owner', role: 'owner' });
  const member = directory.createUser({ email: 'member@example.com', name: 'Mara Member', role: 'member' });
  const actor = { id: owner.id, role: owner.role, name: owner.name };
  return { directory, owner, member, actor };
}

function ticket(directory: any, actor: any, fields: Record<string, unknown> = {}) {
  return createTicket({ directory, actor, title: 'Inbox ticket', now: 100, ...fields });
}

function notice(directory: any, userId: string, ticketId: string, kind: string, createdAt: number, options: any = {}) {
  let eventId = null;
  if (options.event) {
    const event = options.event;
    const inserted = directory.db.prepare(
      `INSERT INTO ticket_events
        (ticket_id, event_type, schema_version, actor_type, actor_id, source, created_at, after_json, details_json)
       VALUES (?, ?, 1, ?, ?, 'test', ?, ?, ?)`,
    ).run(
      ticketId,
      event.type ?? 'updated',
      event.actorType ?? 'user',
      event.actorId ?? null,
      createdAt,
      JSON.stringify(event.after ?? {}),
      JSON.stringify(event.details ?? {}),
    );
    eventId = Number(inserted.lastInsertRowid);
    if (event.comment) {
      directory.db.prepare(
        `INSERT INTO ticket_comments (id, ticket_id, actor_type, actor_id, author_snapshot, body, created_at)
         VALUES (?, ?, 'user', ?, 'Owner', ?, ?)`,
      ).run(event.comment.id, ticketId, event.actorId ?? null, event.comment.body, createdAt);
    }
  }
  const id = options.id ?? `notice-${userId}-${kind}-${createdAt}`;
  directory.db.prepare(
    `INSERT INTO notifications
      (id, user_id, ticket_id, event_id, kind, dedupe_key, created_at, read_at, next_email_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, ticketId, eventId, kind, `dedupe-${id}`, createdAt, options.readAt ?? null, options.nextEmailAt ?? null);
  return id;
}

afterEach(() => {
  for (const directory of opened.splice(0)) directory.close();
});

describe('tracker inbox reads', () => {
  it('returns newest first with ticket summary, priority, actor, and kind details', () => {
    const { directory, owner, member, actor } = fixture();
    const ticketRecord = ticket(directory, actor, { priority: 'high', due: '2026-10-11' });
    directory.db.prepare('UPDATE tickets SET assignee_user_id = ? WHERE id = ?').run(member.id, ticketRecord.id);
    directory.db.prepare('UPDATE tickets SET archived_at = 700 WHERE id = ?').run(ticketRecord.id);
    const statusId = notice(directory, member.id, ticketRecord.id, 'status_changed', 300, {
      id: 'status-row', event: { type: 'transitioned', actorId: owner.id, after: { state: { name: 'In review' } } },
    });
    notice(directory, member.id, ticketRecord.id, 'relation_changed', 400, {
      id: 'relation-row', event: { type: 'related', actorId: owner.id, details: { relatedKey: 'TAB-42', relation: 'blocked_by' } },
    });
    notice(directory, member.id, ticketRecord.id, 'integration_activity', 500, {
      id: 'integration-row', event: { type: 'link.pr_merged', actorType: 'system', details: { text: `Merged ${'x'.repeat(130)}` } },
    });
    notice(directory, member.id, ticketRecord.id, 'due_soon', 600, { id: 'due-row' });

    const page = listNotifications({ directory, user: member, limit: 10 });
    expect(page.items.map((item: any) => item.id)).toEqual(['due-row', 'integration-row', 'relation-row', statusId]);
    expect(page.items[0]).toMatchObject({
      kind: 'due_soon',
      ticket: {
        key: ticketRecord.key,
        title: 'Inbox ticket',
        state: { name: 'To do', category: 'unstarted' },
        assignee: { name: member.name },
        priority: 'high',
      },
      actor: null,
      preview: null,
      detail: { dueDate: '2026-10-11' },
    });
    expect((page.items[1].detail as any).text).toHaveLength(120);
    expect(page.items[2].detail).toEqual({ key: 'TAB-42', relation: 'blocked_by' });
    expect(page.items[3].detail).toEqual({ state: 'In review' });
    expect(page.items[3].actor).toEqual({ name: owner.name });
    expect(page.items[0].ticket).not.toHaveProperty('archivedAt');
    expect(page.items).toHaveLength(4);
  });

  it('pages by the opaque (created_at, id) cursor and clamps limits to 1 through 50', () => {
    const { directory, member, actor } = fixture();
    const ticketRecord = ticket(directory, actor);
    for (let i = 0; i < 53; i++) notice(directory, member.id, ticketRecord.id, 'assigned', 1000 + Math.floor(i / 3), { id: `n-${String(i).padStart(2, '0')}` });

    const first = listNotifications({ directory, user: member, limit: 1000 });
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    const cursor = first.nextCursor;
    if (!cursor) throw new Error('expected a next cursor');
    const second = listNotifications({ directory, user: member, limit: 50, before: cursor });
    expect(second.items).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item: any) => item.id)).size).toBe(53);
    expect(listNotifications({ directory, user: member, limit: 0 }).items).toHaveLength(1);
    expect(() => listNotifications({ directory, user: member, before: 'bad cursor' })).toThrow(/valid inbox cursor/u);
  });

  it('filters unread rows and provides actor names for users and MCP owners, with no system actor', () => {
    const { directory, owner, member, actor } = fixture();
    const ticketRecord = ticket(directory, actor);
    notice(directory, member.id, ticketRecord.id, 'commented', 100, {
      id: 'user-actor', event: { actorId: owner.id }, readAt: 10,
    });
    notice(directory, member.id, ticketRecord.id, 'assigned', 200, {
      id: 'mcp-actor', event: { actorType: 'mcp_token', actorId: 'token-1', details: { ownerUserId: owner.id } },
    });
    notice(directory, member.id, ticketRecord.id, 'status_changed', 300, {
      id: 'system-actor', event: { actorType: 'system', details: {} },
    });
    const page = listNotifications({ directory, user: member, unreadOnly: true });
    expect(page.items.map((item: any) => item.id)).toEqual(['system-actor', 'mcp-actor']);
    expect(page.items[1].actor).toEqual({ name: owner.name });
    expect(page.items[0].actor).toBeNull();
    expect(page.unread).toBe(2);
    expect(unreadCount(directory, member)).toBe(2);
  });

  it('shows flattened comment previews only for comments and mentions', () => {
    const { directory, owner, member, actor } = fixture();
    const ticketRecord = ticket(directory, actor);
    const body = `First line\nsecond line @{${member.id}} ${'x'.repeat(150)}`;
    notice(directory, member.id, ticketRecord.id, 'commented', 100, {
      id: 'commented-row', event: { actorId: owner.id, details: { commentId: 'commented-id' }, comment: { id: 'commented-id', body } },
    });
    notice(directory, member.id, ticketRecord.id, 'mentioned', 200, {
      id: 'mentioned-row', event: { actorId: owner.id, details: { commentId: 'mentioned-id' }, comment: { id: 'mentioned-id', body } },
    });
    notice(directory, member.id, ticketRecord.id, 'assigned', 300, { id: 'no-preview' });
    const rows = listNotifications({ directory, user: member }).items;
    expect(rows[0].preview).toBeNull();
    expect(rows[1].preview).toContain('First line second line @Mara Member');
    expect((rows[1].preview as string).length).toBe(140);
    expect(rows[2].preview as string).toContain('@Mara Member');
  });

  it('suppresses and hides notices after ticket access is lost, including from unread counts', () => {
    const { directory, actor } = fixture();
    const guest = directory.createUser({ email: 'guest@example.com', name: 'Guest', role: 'guest' });
    const ticketRecord = ticket(directory, actor);
    const id = notice(directory, guest.id, ticketRecord.id, 'assigned', 500);
    const boardAccess = () => null;
    expect(unreadCount(directory, guest, { boardAccess })).toBe(0);
    expect(directory.db.prepare('SELECT suppressed_at FROM notifications WHERE id = ?').get(id).suppressed_at).not.toBeNull();
    expect(listNotifications({ directory, user: guest, boardAccess }).items).toEqual([]);
  });

  it('marks only the caller\'s rows read and clears queued email timestamps', () => {
    const { directory, owner, member, actor } = fixture();
    const other = directory.createUser({ email: 'other@example.com', name: 'Other', role: 'member' });
    const ticketRecord = ticket(directory, actor);
    const own = notice(directory, member.id, ticketRecord.id, 'assigned', 100, { id: 'own-row', nextEmailAt: 50 });
    const theirs = notice(directory, other.id, ticketRecord.id, 'assigned', 100, { id: 'other-row', nextEmailAt: 50 });
    const ids: string[] = [own, theirs];
    expect(markRead({ directory, user: member, ids, now: 900 })).toEqual({ updated: 1 });
    expect(directory.db.prepare('SELECT read_at, next_email_at FROM notifications WHERE id = ?').get(own)).toEqual({ read_at: 900, next_email_at: null });
    expect(directory.db.prepare('SELECT read_at, next_email_at FROM notifications WHERE id = ?').get(theirs)).toEqual({ read_at: null, next_email_at: 50 });
    expect(markRead({ directory, user: member, all: true, now: 901 })).toEqual({ updated: 0 });
    expect(owner.id).not.toBe(member.id);
  });
});
