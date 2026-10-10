import { afterEach, describe, expect, it } from 'vitest';
import { OpsError } from '../server/board-ops.mjs';
import { openDirectory } from '../server/directory.mjs';
import { requireTicketRead, requireTicketWrite, ticketAccess } from '../server/tracker/access.mjs';
import { fanOut, getNotifyPrefs, NOTIFICATION_KINDS, setNotifyPrefs } from '../server/tracker/notify.mjs';
import { commentTicket, createTicket, transitionTicket, updateTicket } from '../server/tracker/tickets.mjs';

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

function member(directory: any, name: string, role = 'member') {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/gu, '-');
  return directory.createUser({ email: `${slug}@example.com`, name, role });
}

function notifications(directory: any, ticketId: string) {
  return directory.db.prepare(
    `SELECT user_id, event_id, kind, dedupe_key, created_at, next_email_at
       FROM notifications WHERE ticket_id = ? ORDER BY event_id, user_id`,
  ).all(ticketId);
}

function emitEvent(directory: any, ticketId: string, eventType: string, actor: any, createdAt: number) {
  return directory.transaction(() => {
    const actorType = actor?.type ?? 'user';
    const actorId = actorType === 'mcp_token' ? actor.id : actor?.id ?? null;
    const result = directory.db.prepare(
      `INSERT INTO ticket_events
        (ticket_id, event_type, schema_version, actor_type, actor_id, source, created_at, details_json)
       VALUES (?, ?, 1, ?, ?, 'app', ?, '{}')`,
    ).run(ticketId, eventType, actorType, actorId, createdAt);
    const eventId = Number(result.lastInsertRowid);
    fanOut({ db: directory.db, ticketId, eventId, eventType, actor, createdAt });
    return eventId;
  });
}

function caught(fn: () => unknown) {
  try { fn(); } catch (error) { return error as OpsError; }
  throw new Error('expected an OpsError');
}

afterEach(() => {
  for (const directory of opened.splice(0)) directory.close();
});

describe('tracker notification fan-out', () => {
  it('routes each supported event to the specified recipients and ignores archive and unknown events', () => {
    const { directory, owner, actor } = fixture();
    const initialAssignee = member(directory, 'Initial Assignee');
    const nextAssignee = member(directory, 'Next Assignee');
    const watcher = member(directory, 'Watcher');
    const mentioned = member(directory, 'Mentioned');
    const ticket = createTicket({ directory, actor, title: 'Notification matrix', assignee: initialAssignee.name, now: 100 });

    expect(notifications(directory, ticket.id).map((row: any) => [row.user_id, row.kind])).toEqual([
      [initialAssignee.id, 'assigned'],
    ]);

    updateTicket({ directory, actor, key: ticket.key, patch: { assignee: nextAssignee.name }, now: 200 });
    const updateRow = notifications(directory, ticket.id).find((row: any) => row.kind === 'assigned' && row.user_id === nextAssignee.id);
    expect(updateRow).toMatchObject({ created_at: 200, next_email_at: 120_200 });
    expect(notifications(directory, ticket.id).some((row: any) => row.event_id === updateRow.event_id && row.user_id === initialAssignee.id)).toBe(false);

    directory.db.prepare(
      `INSERT INTO ticket_subscriptions (ticket_id, user_id, reason, created_at)
       VALUES (?, ?, 'manual', 150), (?, ?, 'manual', 150)`,
    ).run(ticket.id, watcher.id, ticket.id, mentioned.id);
    transitionTicket({ directory, actor, key: ticket.key, state: 'In progress', now: 300 });
    const transitionRows = notifications(directory, ticket.id).filter((row: any) => row.kind === 'status_changed');
    expect(transitionRows.map((row: any) => row.user_id).sort()).toEqual([initialAssignee.id, nextAssignee.id, watcher.id, mentioned.id].sort());
    expect(transitionRows.every((row: any) => row.next_email_at === null)).toBe(true);

    const comment = commentTicket({
      directory,
      actor: { id: watcher.id, role: 'member', name: watcher.name },
      key: ticket.key,
      body: `Hello @{${mentioned.id}} @{missing-user} @{${mentioned.id}} @{${watcher.id}}`,
      now: 400,
    });
    const commentRows = notifications(directory, ticket.id).filter((row: any) => row.event_id !== null && row.created_at === 400);
    expect(commentRows.filter((row: any) => row.kind === 'commented').map((row: any) => row.user_id).sort())
      .toEqual([initialAssignee.id, nextAssignee.id, owner.id].sort());
    expect(commentRows.filter((row: any) => row.kind === 'mentioned').map((row: any) => row.user_id)).toEqual([mentioned.id]);
    expect(commentRows.some((row: any) => row.user_id === watcher.id)).toBe(false);
    expect(commentRows).toHaveLength(4);
    expect(comment.body).toContain(`@{${mentioned.id}}`);

    const beforeArchive = notifications(directory, ticket.id).length;
    updateTicket({ directory, actor, key: ticket.key, patch: { archived: true }, now: 500 });
    updateTicket({ directory, actor, key: ticket.key, patch: { archived: false }, now: 600 });
    emitEvent(directory, ticket.id, 'related', actor, 700);
    emitEvent(directory, ticket.id, 'unrelated', actor, 800);
    emitEvent(directory, ticket.id, 'unrecognized_event', actor, 900);
    const rowsAfter = notifications(directory, ticket.id);
    expect(rowsAfter.length).toBe(beforeArchive + 8);
    expect(rowsAfter.filter((row: any) => row.created_at === 700).every((row: any) => row.kind === 'relation_changed')).toBe(true);
    expect(rowsAfter.filter((row: any) => row.created_at === 800).every((row: any) => row.kind === 'relation_changed')).toBe(true);
    expect(rowsAfter.some((row: any) => row.created_at === 500 || row.created_at === 600 || row.created_at === 900)).toBe(false);
  });

  it('excludes the acting user, including an MCP token owner who subscribes by commenting', () => {
    const { directory, owner, actor } = fixture();
    const watcher = member(directory, 'Watcher');
    const ticket = createTicket({ directory, actor, title: 'MCP self exclusion', now: 100 });
    directory.db.prepare(
      `INSERT INTO ticket_subscriptions (ticket_id, user_id, reason, created_at) VALUES (?, ?, 'manual', 100)`,
    ).run(ticket.id, watcher.id);
    const tokenActor = {
      type: 'mcp_token', id: 'token-1', user: { id: owner.id, role: 'owner', name: owner.name }, tracker: 'write',
    };
    commentTicket({ directory, actor: tokenActor, key: ticket.key, body: 'A token comment', now: 200 });
    const event = directory.db.prepare("SELECT id FROM ticket_events WHERE ticket_id = ? AND event_type = 'commented'").get(ticket.id);
    const rows = notifications(directory, ticket.id).filter((row: any) => row.event_id === event.id);
    expect(rows.map((row: any) => row.user_id)).toEqual([watcher.id]);
    expect(directory.db.prepare('SELECT reason FROM ticket_subscriptions WHERE ticket_id = ? AND user_id = ?').get(ticket.id, owner.id).reason)
      .toBe('creator');
  });

  it('skips disabled users and recipients without ticket read access', () => {
    const { directory, actor } = fixture();
    const disabled = member(directory, 'Disabled');
    const guest = member(directory, 'Guest', 'guest');
    const ticket = createTicket({ directory, actor, title: 'Access checks', now: 100 });
    directory.db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(disabled.id);
    directory.db.prepare(
      `INSERT INTO ticket_subscriptions (ticket_id, user_id, reason, created_at)
       VALUES (?, ?, 'manual', 100), (?, ?, 'manual', 100)`,
    ).run(ticket.id, disabled.id, ticket.id, guest.id);
    transitionTicket({ directory, actor, key: ticket.key, state: 'In progress', now: 200 });
    expect(notifications(directory, ticket.id)).toEqual([]);
  });

  it('rolls notifications back when a later write in the mutation transaction fails', () => {
    const { directory, actor } = fixture();
    const assignee = member(directory, 'Rollback Assignee');
    const ticket = createTicket({ directory, actor, title: 'Rollback', now: 100 });
    const eventCount = directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_events').get().n;
    directory.db.exec(`
      CREATE TRIGGER fail_ticket_field_version
      BEFORE INSERT ON ticket_field_versions
      BEGIN SELECT RAISE(ABORT, 'forced mutation failure'); END;
    `);

    expect(() => updateTicket({ directory, actor, key: ticket.key, patch: { assignee: assignee.name }, now: 200 }))
      .toThrow('forced mutation failure');
    expect(directory.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n).toBe(0);
    expect(directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_events').get().n).toBe(eventCount);
    expect(directory.db.prepare('SELECT assignee_user_id FROM tickets WHERE id = ?').get(ticket.id).assignee_user_id).toBeNull();
    expect(directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_subscriptions WHERE ticket_id = ? AND user_id = ?')
      .get(ticket.id, assignee.id).n).toBe(0);
  });

  it('caps notifications at 200 recipients for one event', () => {
    const { directory, owner, actor } = fixture();
    const watchers = Array.from({ length: 205 }, (_, index) => member(directory, `Watcher ${index}`));
    const ticket = createTicket({ directory, actor, title: 'Recipient cap', now: 100 });
    const insert = directory.db.prepare(
      `INSERT INTO ticket_subscriptions (ticket_id, user_id, reason, created_at) VALUES (?, ?, 'manual', 100)`,
    );
    for (const watcher of watchers) insert.run(ticket.id, watcher.id);
    directory.db.prepare('DELETE FROM ticket_subscriptions WHERE ticket_id = ? AND user_id = ?').run(ticket.id, owner.id);

    transitionTicket({ directory, actor, key: ticket.key, state: 'In progress', now: 200 });
    const eventId = directory.db.prepare("SELECT id FROM ticket_events WHERE ticket_id = ? AND event_type = 'transitioned'").get(ticket.id).id;
    expect(directory.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE event_id = ?').get(eventId).n).toBe(200);
  });

  it('keeps one row per person and event, choosing mentioned over the general comment notice', () => {
    const { directory, owner, actor } = fixture();
    const commenter = member(directory, 'Commenter');
    const mentioned = member(directory, 'Mentioned Subscriber');
    const ticket = createTicket({ directory, actor, title: 'Priority', now: 100 });
    directory.db.prepare(
      `INSERT INTO ticket_subscriptions (ticket_id, user_id, reason, created_at) VALUES (?, ?, 'manual', 100)`,
    ).run(ticket.id, mentioned.id);
    commentTicket({
      directory,
      actor: { id: commenter.id, role: 'member', name: commenter.name },
      key: ticket.key,
      body: `Please see @{${mentioned.id}}`,
      now: 200,
    });
    const row = directory.db.prepare('SELECT user_id, kind, dedupe_key FROM notifications WHERE user_id = ? AND created_at = 200')
      .get(mentioned.id);
    expect(row).toMatchObject({ user_id: mentioned.id, kind: 'mentioned' });
    expect(row.dedupe_key).toMatch(/^ev:\d+$/u);
    expect(directory.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND created_at = 200').get(mentioned.id).n).toBe(1);
    expect(directory.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND created_at = 200').get(owner.id).n).toBe(1);
  });
});

describe('tracker notification preferences', () => {
  it('fills all defaults, stores only patched keys, and applies both, app, and off delivery choices', () => {
    const { directory, actor } = fixture();
    const both = member(directory, 'Both');
    const app = member(directory, 'App');
    const off = member(directory, 'Off');
    expect(getNotifyPrefs(directory, both.id)).toEqual({
      assigned: 'both', mentioned: 'both', commented: 'app', status_changed: 'app', due_soon: 'both',
      relation_changed: 'app', integration_activity: 'app',
    });
    setNotifyPrefs(directory, app.id, { assigned: 'app' });
    setNotifyPrefs(directory, off.id, { assigned: 'off' });
    expect(getNotifyPrefs(directory, app.id).assigned).toBe('app');
    expect(getNotifyPrefs(directory, app.id).mentioned).toBe('both');

    const created = [both, app, off].map((user, index) => createTicket({
      directory, actor, title: `Preference ${index}`, assignee: user.name, now: 1_000 + index,
    }));
    const rows = created.map((ticket) => directory.db.prepare('SELECT user_id, next_email_at FROM notifications WHERE ticket_id = ?').get(ticket.id));
    expect(rows[0]).toMatchObject({ user_id: both.id, next_email_at: 121_000 });
    expect(rows[1]).toMatchObject({ user_id: app.id, next_email_at: null });
    expect(rows[2]).toBeUndefined();

    directory.setPref(both.id, 'tracker.notify.assigned', 'invalid-stored-value');
    expect(getNotifyPrefs(directory, both.id).assigned).toBe('both');
    expect(NOTIFICATION_KINDS).toHaveLength(7);
  });

  it('rejects unknown kinds and invalid choices with invalid_input OpsErrors', () => {
    const { directory, owner } = fixture();
    for (const patch of [{ unknown: 'off' }, { assigned: 'sometimes' }, null]) {
      const error = caught(() => setNotifyPrefs(directory, owner.id, patch as any));
      expect(error).toBeInstanceOf(OpsError);
      expect(error.code).toBe('invalid_input');
      expect(error).not.toBeInstanceOf(TypeError);
    }
  });

  it('auto-subscribes creators, assignees, commenters, and mentioned users with the corresponding reason', () => {
    const { directory, owner, actor } = fixture();
    const initialAssignee = member(directory, 'Initial');
    const nextAssignee = member(directory, 'Next');
    const commenter = member(directory, 'Commenter');
    const mentioned = member(directory, 'Mentioned');
    const ticket = createTicket({ directory, actor, title: 'Subscriptions', assignee: initialAssignee.name, now: 100 });
    updateTicket({ directory, actor, key: ticket.key, patch: { assignee: nextAssignee.name }, now: 200 });
    commentTicket({
      directory,
      actor: { id: commenter.id, role: 'member', name: commenter.name },
      key: ticket.key,
      body: `Hello @{${mentioned.id}}`,
      now: 300,
    });
    const reasons = new Map(directory.db.prepare(
      'SELECT user_id, reason FROM ticket_subscriptions WHERE ticket_id = ?',
    ).all(ticket.id).map((row: any) => [row.user_id, row.reason]));
    expect(reasons).toEqual(new Map([
      [owner.id, 'creator'], [initialAssignee.id, 'assignee'], [nextAssignee.id, 'assignee'],
      [commenter.id, 'commenter'], [mentioned.id, 'mentioned'],
    ]));
  });
});

describe('ticket access for board-only users', () => {
  const ticket = { id: 'ticket-1', key: 'TAB-1' };

  it.each(['read', 'write'])('grants a guest read access when a linked board grants %s', (role) => {
    const calls: unknown[][] = [];
    const boardAccess = (ticketId: string, userId: string) => {
      calls.push([ticketId, userId]);
      return role;
    };
    expect(ticketAccess({ id: 'u-guest', role: 'guest' }, ticket, { boardAccess })).toBe('read');
    expect(calls).toEqual([[ticket.id, 'u-guest']]);
  });

  it('conceals missing board access and preserves workspace viewer and MCP behavior', () => {
    const guest = { id: 'u-guest', role: 'guest' };
    expect(() => ticketAccess(guest, ticket, { boardAccess: () => null })).toThrow(OpsError);
    expect(() => ticketAccess(guest, ticket, {})).toThrow(OpsError);
    expect(() => ticketAccess(guest, ticket)).toThrow(OpsError);
    expect(ticketAccess({ id: 'u-none', role: null }, ticket, { boardAccess: () => 'read' })).toBe('read');
    expect(ticketAccess({ id: 'u-viewer', workspaceRole: 'viewer' }, ticket, { boardAccess: () => 'write' })).toBe('read');
    expect(ticketAccess({
      type: 'mcp_token', id: 'token-1', user: { id: 'u-member', role: 'member' }, tracker: 'read',
    }, ticket, { boardAccess: () => 'write' })).toBe('read');
    expect(() => requireTicketRead(guest, ticket, { boardAccess: () => 'write' })).not.toThrow();
    expect(() => requireTicketWrite(guest, ticket, { boardAccess: () => 'write' })).toThrow(OpsError);
  });

  it('does not notify a guest subscriber when fan-out has no board access resolver', () => {
    const { directory, actor } = fixture();
    const guest = member(directory, 'Guest', 'guest');
    const ticketRecord = createTicket({ directory, actor, title: 'Guest notice', now: 100 });
    directory.db.prepare(
      `INSERT INTO ticket_subscriptions (ticket_id, user_id, reason, created_at) VALUES (?, ?, 'manual', 100)`,
    ).run(ticketRecord.id, guest.id);
    transitionTicket({ directory, actor, key: ticketRecord.key, state: 'In progress', now: 200 });
    expect(directory.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?').get(guest.id).n).toBe(0);
  });
});
