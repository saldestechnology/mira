import { afterEach, describe, expect, it } from 'vitest';
import { openDirectory } from '../server/directory.mjs';
import { OpsError } from '../server/board-ops.mjs';
import { createTicket } from '../server/tracker/tickets.mjs';
import { isSubscribed, subscribeTicket, unsubscribeTicket } from '../server/tracker/subscriptions.mjs';

const opened: ReturnType<typeof openDirectory>[] = [];
const open = () => {
  const directory = openDirectory(':memory:');
  opened.push(directory);
  return directory;
};

function caught(fn: () => unknown) {
  try { fn(); } catch (error) { return error; }
  throw new Error('expected the operation to throw');
}

afterEach(() => {
  for (const directory of opened.splice(0)) directory.close();
});

describe('tracker subscriptions', () => {
  it('is idempotent, belongs to the signed-in user, and creates no ticket events', () => {
    const directory = open();
    const owner = directory.createUser({ email: 'owner@example.com', name: 'Owner', role: 'owner' })!;
    const member = directory.createUser({ email: 'member@example.com', name: 'Member', role: 'member' })!;
    const actor = { type: 'user', userId: owner.id, user: owner };
    const ticket = createTicket({ directory, actor, title: 'Subscription target' });
    // creating a ticket subscribes its creator (notifications); these tests start from nobody subscribed
    expect(isSubscribed({ directory, actor, key: ticket.key })).toBe(true);
    directory.db.prepare('DELETE FROM ticket_subscriptions').run();
    const eventsBefore = directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_events').get()!.n;

    expect(isSubscribed({ directory, actor, key: ticket.key })).toBe(false);
    expect(subscribeTicket({ directory, actor, key: ticket.key })).toBe(true);
    expect(subscribeTicket({ directory, actor, key: ticket.key })).toBe(true);
    expect(isSubscribed({ directory, actor, key: ticket.key })).toBe(true);
    expect(directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_subscriptions WHERE ticket_id = ?').get(ticket.id)!.n).toBe(1);
    expect(directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_events').get()!.n).toBe(eventsBefore);

    expect(unsubscribeTicket({ directory, actor, key: ticket.key })).toBe(false);
    expect(unsubscribeTicket({ directory, actor, key: ticket.key })).toBe(false);
    expect(isSubscribed({ directory, actor, key: ticket.key })).toBe(false);
    expect(directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_subscriptions WHERE ticket_id = ?').get(ticket.id)!.n).toBe(0);
    expect(directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_events').get()!.n).toBe(eventsBefore);

    expect(caught(() => subscribeTicket({ directory, actor: { type: 'user', userId: owner.id, user: member }, key: ticket.key })))
      .toMatchObject({ code: 'invalid_input' });
  });

  it('requires ticket read access and refuses writes while the workspace is read-only', () => {
    const directory = open();
    const owner = directory.createUser({ email: 'owner@example.com', name: 'Owner', role: 'owner' })!;
    const guest = directory.createUser({ email: 'guest@example.com', name: 'Guest', role: 'guest' })!;
    const actor = { type: 'user', userId: owner.id, user: owner };
    const ticket = createTicket({ directory, actor, title: 'Subscription permissions' });
    directory.db.prepare('DELETE FROM ticket_subscriptions').run();
    const guestActor = { type: 'user', userId: guest.id, user: guest };

    const denied = caught(() => subscribeTicket({ directory, actor: guestActor, key: ticket.key }));
    expect(denied).toBeInstanceOf(OpsError);
    expect(denied).toMatchObject({ code: 'not_found' });
    expect(caught(() => unsubscribeTicket({ directory, actor, key: ticket.key, readOnly: true })))
      .toMatchObject({ code: 'read_only' });
    expect(isSubscribed({ directory, actor, key: ticket.key })).toBe(false);
    expect(directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_subscriptions').get()!.n).toBe(0);
  });
});
