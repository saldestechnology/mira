import { afterEach, describe, expect, it } from 'vitest';
import { openDirectory } from '../server/directory.mjs';
import { OpsError } from '../server/tracker/shared.mjs';
import {
  commentTicket, createTicket, deleteTicketComment, editTicketComment, searchTickets,
} from '../server/tracker/tickets.mjs';

const opened: ReturnType<typeof openDirectory>[] = [];

function fixture() {
  const directory = openDirectory(':memory:');
  opened.push(directory);
  const owner = directory.createUser({ email: 'owner@example.com', name: 'Owner', role: 'owner' })!;
  const member = directory.createUser({ email: 'member@example.com', name: 'Member', role: 'member' })!;
  const actor = (user: { id: string }) => ({ type: 'user', userId: user.id, user });
  return { directory, owner, member, ownerActor: actor(owner), memberActor: actor(member) };
}

function expectCode(run: () => unknown, code: string) {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OpsError);
  expect((caught as OpsError).code).toBe(code);
  return caught;
}

afterEach(() => {
  for (const directory of opened.splice(0)) directory.close();
});

describe('tracker comment edit and delete commands', () => {
  it('edits only by the author, records an ID and length, and refreshes comment search text', () => {
    const { directory, ownerActor, memberActor } = fixture();
    const ticket = createTicket({ directory, actor: ownerActor, title: 'Comment search target' });
    const comment = commentTicket({ directory, actor: memberActor, key: ticket.key, body: 'originalmarker body', now: 20 });

    expect(searchTickets({ directory, actor: ownerActor, query: 'originalmarker' }).total).toBe(1);
    expectCode(() => editTicketComment({
      directory, actor: ownerActor, key: ticket.key, commentId: comment.id, body: 'wrong author edit',
    }), 'forbidden');

    const edited = editTicketComment({
      directory, actor: memberActor, key: ticket.key, commentId: comment.id, body: 'updatedmarker body', now: 30,
    });
    expect(edited).toMatchObject({ id: comment.id, edited: true, deleted: false, body: 'updatedmarker body', editedAt: 30 });
    expect(searchTickets({ directory, actor: ownerActor, query: 'originalmarker' }).total).toBe(0);
    expect(searchTickets({ directory, actor: ownerActor, query: 'updatedmarker' }).total).toBe(1);

    const event = directory.db.prepare(
      "SELECT event_type, details_json FROM ticket_events WHERE ticket_id = ? AND event_type = 'comment_edited'",
    ).get(ticket.id) as { event_type: string; details_json: string } | undefined;
    expect(event).toBeDefined();
    expect(event!.event_type).toBe('comment_edited');
    expect(JSON.parse(event!.details_json)).toEqual({ commentId: comment.id, length: 18 });
    expect(event!.details_json).not.toContain('updatedmarker');
  });

  it('allows comment authors and workspace admins to soft-delete and removes deleted text from search', () => {
    const { directory, ownerActor, memberActor } = fixture();
    const ticket = createTicket({ directory, actor: ownerActor, title: 'Comment delete target' });
    const comment = commentTicket({ directory, actor: memberActor, key: ticket.key, body: 'deletemarker body', now: 20 });

    expectCode(() => deleteTicketComment({
      directory, actor: { ...ownerActor, user: { ...ownerActor.user, role: 'member' } },
      key: ticket.key, commentId: comment.id,
    }), 'forbidden');

    const deleted = deleteTicketComment({
      directory, actor: ownerActor, key: ticket.key, commentId: comment.id, now: 40,
    });
    expect(deleted).toMatchObject({ id: comment.id, edited: false, deleted: true, deletedAt: 40 });
    expect(deleted).not.toHaveProperty('body');
    expect(directory.db.prepare('SELECT body, deleted_at FROM ticket_comments WHERE id = ?').get(comment.id))
      .toEqual({ body: '', deleted_at: 40 });
    expect(searchTickets({ directory, actor: ownerActor, query: 'deletemarker' }).total).toBe(0);

    const event = directory.db.prepare(
      "SELECT event_type, details_json FROM ticket_events WHERE ticket_id = ? AND event_type = 'comment_deleted'",
    ).get(ticket.id) as { event_type: string; details_json: string } | undefined;
    expect(event).toBeDefined();
    expect(event!.event_type).toBe('comment_deleted');
    expect(JSON.parse(event!.details_json)).toEqual({ commentId: comment.id });
    expect(event!.details_json).not.toContain('deletemarker');

    const ownComment = commentTicket({ directory, actor: memberActor, key: ticket.key, body: 'author delete' });
    expect(deleteTicketComment({
      directory, actor: memberActor, key: ticket.key, commentId: ownComment.id, now: 50,
    })).toMatchObject({ id: ownComment.id, deleted: true, deletedAt: 50 });
  });
});
