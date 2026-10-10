import { appendTicketEvent } from './events.mjs';
import { fanOut } from './notify.mjs';
import { actorInfo, getDb, inTransaction, newId, requireWritable } from './shared.mjs';
import { refreshTicketSearch } from './search.mjs';

/** Allocate and create a ticket atomically. A rolled back call leaves the counter unchanged. */
/** @param {any} options */
export function allocateTicket({
  directory,
  db: dbArg,
  actor,
  fields,
  source = 'app',
  idempotencyKey = null,
  readOnly = () => false,
  now = Date.now(),
} = {}) {
  requireWritable(readOnly);
  const db = getDb({ directory, db: dbArg });
  const info = actorInfo(actor);
  return inTransaction({ directory, db }, () => {
    if (idempotencyKey !== null) {
      const prior = db.prepare(
        `SELECT ticket_id FROM ticket_events
          WHERE source = ? AND actor_type = ? AND actor_id IS ? AND idempotency_key = ? AND event_type = 'created'
          ORDER BY id LIMIT 1`,
      ).get(source, info.type, info.id, idempotencyKey);
      if (prior) {
        const ticket = db.prepare('SELECT id, key, updated_seq FROM tickets WHERE id = ?').get(prior.ticket_id);
        if (ticket) return { ticketId: ticket.id, key: ticket.key, updatedSeq: ticket.updated_seq, duplicate: true };
      }
    }

    const tracker = db.prepare('SELECT id, prefix FROM trackers WHERE id = ?').get('trk_default');
    if (!tracker) throw new Error('Default tracker seed is missing');
    let counter = db.prepare('SELECT next_number FROM ticket_counters WHERE scope = ? AND prefix = ?').get(tracker.id, tracker.prefix);
    if (!counter) {
      db.prepare('INSERT INTO ticket_counters (scope, prefix, next_number, updated_at) VALUES (?, ?, 1, ?)')
        .run(tracker.id, tracker.prefix, now);
      counter = { next_number: 1 };
    }
    const number = Number(counter.next_number);
    const key = `${tracker.prefix}-${number}`;
    db.prepare('UPDATE ticket_counters SET next_number = ?, updated_at = ? WHERE scope = ? AND prefix = ?')
      .run(number + 1, now, tracker.id, tracker.prefix);

    const ticketId = newId();
    db.prepare(
      `INSERT INTO tickets
        (id, prefix, number, key, title, description, state_id, tracker_id, priority, parent_ticket_id,
         assignee_user_id, project_id, milestone_id, due_date, created_at, updated_at, created_by_type, created_by_id, updated_seq, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(
      ticketId,
      tracker.prefix,
      number,
      key,
      fields.title,
      fields.description,
      fields.stateId,
      tracker.id,
      fields.priority,
      fields.parentTicketId,
      fields.assigneeUserId,
      fields.projectId ?? null,
      fields.milestoneId ?? null,
      fields.dueDate,
      now,
      now,
      info.type,
      info.id,
      source,
    );
    for (const label of fields.labels ?? []) {
      db.prepare('INSERT INTO ticket_labels (ticket_id, label_id, created_at) VALUES (?, ?, ?)')
        .run(ticketId, label.id, now);
    }
    const eventSeq = appendTicketEvent({
      db,
      ticketId,
      eventType: 'created',
      actor,
      source,
      idempotencyKey,
      createdAt: now,
      after: fields.eventAfter,
    });
    fanOut({ db, ticketId, eventId: eventSeq, eventType: 'created', actor, createdAt: now });
    db.prepare('UPDATE tickets SET updated_seq = ? WHERE id = ?').run(eventSeq, ticketId);
    for (const field of fields.versionedFields ?? ['title', 'description', 'state', 'priority', 'assignee', 'labels', 'due', 'parent', 'project', 'milestone']) {
      db.prepare(
        `INSERT INTO ticket_field_versions (ticket_id, field, event_seq, actor_type, actor_id)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(ticketId, field, eventSeq, info.type, info.id);
    }
    refreshTicketSearch(db, ticketId);
    return { ticketId, key, updatedSeq: eventSeq, duplicate: false };
  });
}
