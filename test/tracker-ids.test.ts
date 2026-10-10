import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDirectory } from '../server/directory.mjs';
import { allocateTicket } from '../server/tracker/ids.mjs';
import { createTicket, updateTicket } from '../server/tracker/tickets.mjs';

const dirs: any[] = [];
const roots: string[] = [];
const open = (file = ':memory:') => {
  const directory = openDirectory(file);
  dirs.push(directory);
  return directory;
};
const user = (directory: any) => directory.createUser({ email: 'owner@example.com', role: 'owner' });
const actorFor = (person: any) => ({ id: person.id, role: person.role, name: person.name });

afterEach(() => {
  for (const directory of dirs.splice(0)) directory.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('tracker key allocation', () => {
  it('serializes concurrent creates across directory connections', async () => {
    const root = fs.mkdtempSync(fileURLToPath(new URL('./tracker-ids-', import.meta.url)));
    roots.push(root);
    const file = path.join(root, 'directory.sqlite');
    const first = open(file);
    const second = open(file);
    const person = user(first);
    const actor = actorFor(person);
    const [a, b] = await Promise.all([
      Promise.resolve().then(() => createTicket({ directory: first, actor, title: 'First' })),
      Promise.resolve().then(() => createTicket({ directory: second, actor, title: 'Second' })),
    ]);
    expect([a.key, b.key].sort()).toEqual(['TAB-1', 'TAB-2']);
    expect(first.db.prepare('SELECT next_number FROM ticket_counters WHERE scope = ? AND prefix = ?').get('trk_default', 'TAB'))
      .toEqual({ next_number: 3 });
  });

  it('does not consume a number when the enclosing transaction rolls back', () => {
    const directory = open();
    const actor = actorFor(user(directory));
    expect(() => directory.transaction(() => {
      createTicket({ directory, actor, title: 'Rolled back' });
      throw new Error('force outer rollback');
    })).toThrow('force outer rollback');
    expect(directory.db.prepare('SELECT COUNT(*) AS n FROM tickets').get()).toEqual({ n: 0 });
    expect(directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_subscriptions').get()).toEqual({ n: 0 });
    expect(directory.db.prepare('SELECT COUNT(*) AS n FROM notifications').get()).toEqual({ n: 0 });
    expect(createTicket({ directory, actor, title: 'Committed' }).key).toBe('TAB-1');
  });

  it('returns the same ticket and event for a create retry with its idempotency key', () => {
    const directory = open();
    const actor = actorFor(user(directory));
    const input = { directory, actor, title: 'One retry only', idempotencyKey: 'retry-create-01' };
    const first = createTicket(input);
    const again = createTicket(input);
    expect(again).toEqual(first);
    expect(directory.db.prepare("SELECT COUNT(*) AS n FROM ticket_events WHERE event_type = 'created'").get()).toEqual({ n: 1 });
    expect(directory.db.prepare('SELECT next_number FROM ticket_counters WHERE scope = ? AND prefix = ?').get('trk_default', 'TAB'))
      .toEqual({ next_number: 2 });
  });

  it('never reuses a committed key after archive', () => {
    const directory = open();
    const actor = actorFor(user(directory));
    const first = createTicket({ directory, actor, title: 'Archive me' });
    updateTicket({ directory, actor, key: first.key, patch: { archived: true } });
    const second = createTicket({ directory, actor, title: 'Next key' });
    expect(first.key).toBe('TAB-1');
    expect(second.key).toBe('TAB-2');
    expect(directory.db.prepare("SELECT event_type FROM ticket_events WHERE ticket_id = ? ORDER BY id").all(first.id).map((row: any) => row.event_type))
      .toEqual(['created', 'archived']);
  });

  it('writes the ticket, first event, search row and field versions through allocation', () => {
    const directory = open();
    const actor = actorFor(user(directory));
    const result = allocateTicket({
      directory,
      actor,
      fields: {
        title: 'Allocated directly', description: '', stateId: 'st_todo', priority: 0,
        assigneeUserId: null, dueDate: null, parentTicketId: null, labels: [],
        eventAfter: { title: 'Allocated directly' }, versionedFields: ['title'],
      },
    });
    expect(result.key).toBe('TAB-1');
    expect(directory.db.prepare('SELECT event_type, schema_version FROM ticket_events WHERE ticket_id = ?').get(result.ticketId))
      .toEqual({ event_type: 'created', schema_version: 1 });
    expect(directory.db.prepare('SELECT field FROM ticket_field_versions WHERE ticket_id = ?').all(result.ticketId))
      .toEqual([{ field: 'title' }]);
    expect(directory.db.prepare('SELECT title FROM ticket_search WHERE ticket_id = ?').get(result.ticketId))
      .toEqual({ title: 'Allocated directly' });
  });
});
