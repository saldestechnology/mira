import { requireTicketRead, requireTicketWrite } from './access.mjs';
import { appendTicketEvent } from './events.mjs';
import { getTicket } from './tickets.mjs';
import { enqueueTicketProjection } from './projection.mjs';
import {
  actorInfo, conflict, getDb, inTransaction, invalid, limitExceeded, newId, notFound, requireWritable,
} from './shared.mjs';

const RELATIONS = new Set(['blocks', 'blocked_by', 'relates_to', 'duplicates', 'duplicated_by']);
const INVERSE = Object.freeze({ blocks: 'blocked_by', blocked_by: 'blocks', relates_to: 'relates_to', duplicates: 'duplicated_by', duplicated_by: 'duplicates' });
const RELATION_LIMIT = 100;

function ticketRow(db, reference, path) {
  if (typeof reference !== 'string' || !reference.trim()) throw notFound('Ticket not found', path);
  const row = db.prepare(
    'SELECT id, key, archived_at FROM tickets WHERE key = ? COLLATE NOCASE OR id = ? LIMIT 1',
  ).get(reference.trim(), reference.trim());
  if (!row) throw notFound('Ticket not found', path);
  return row;
}

function canonicalRelation(ticket, other, kind) {
  if (kind === 'blocked_by') return { from: other, to: ticket, kind: 'blocks' };
  if (kind === 'duplicated_by') return { from: other, to: ticket, kind: 'duplicates' };
  if (kind === 'relates_to') {
    return ticket.id.localeCompare(other.id) <= 0
      ? { from: ticket, to: other, kind }
      : { from: other, to: ticket, kind };
  }
  return { from: ticket, to: other, kind };
}

function relationExists(db, relation) {
  return db.prepare(
    'SELECT id FROM ticket_relations WHERE ticket_id = ? AND related_ticket_id = ? AND kind = ?',
  ).get(relation.from.id, relation.to.id, relation.kind) ?? null;
}

function relationForPair(db, firstId, secondId) {
  return db.prepare(
    `SELECT id, ticket_id, related_ticket_id, kind FROM ticket_relations
      WHERE (ticket_id = ? AND related_ticket_id = ?) OR (ticket_id = ? AND related_ticket_id = ?) LIMIT 1`,
  ).get(firstId, secondId, secondId, firstId) ?? null;
}

function wouldCreateBlockCycle(db, from, to) {
  return Boolean(db.prepare(
    `WITH RECURSIVE blocked(id) AS (
       SELECT related_ticket_id FROM ticket_relations WHERE ticket_id = ? AND kind = 'blocks'
       UNION
       SELECT r.related_ticket_id FROM ticket_relations r JOIN blocked b ON r.ticket_id = b.id WHERE r.kind = 'blocks'
     ) SELECT 1 FROM blocked WHERE id = ? LIMIT 1`,
  ).get(to.id, from.id));
}

function relationCount(db, ticketId) {
  return Number(db.prepare(
    'SELECT COUNT(*) AS n FROM ticket_relations WHERE ticket_id = ? OR related_ticket_id = ?',
  ).get(ticketId, ticketId).n);
}

function markRelationsChanged(db, ticket, actor, source, eventType, relatedKey, relationKind, now) {
  const info = actorInfo(actor);
  const seq = appendTicketEvent({
    db,
    ticketId: ticket.id,
    eventType,
    actor,
    source,
    createdAt: now,
    details: { relatedTicketKey: relatedKey, relationKind },
  });
  db.prepare('UPDATE tickets SET updated_at = ?, updated_seq = ? WHERE id = ?').run(now, seq, ticket.id);
  enqueueTicketProjection({ db, ticketId: ticket.id, eventSeq: seq, now });
  db.prepare(
    `INSERT INTO ticket_field_versions (ticket_id, field, event_seq, actor_type, actor_id)
     VALUES (?, 'relations', ?, ?, ?)
     ON CONFLICT(ticket_id, field) DO UPDATE SET event_seq = excluded.event_seq, actor_type = excluded.actor_type, actor_id = excluded.actor_id`,
  ).run(ticket.id, seq, info.type, info.id);
}

/** @param {any} options */
export function relateTickets({ directory, db: dbArg, actor, key, relation, otherKey, remove = false, source = 'app', readOnly = () => false, now = Date.now() } = {}) {
  requireWritable(readOnly);
  if (typeof relation !== 'string' || !RELATIONS.has(relation)) throw invalid('relation', `Must be one of ${[...RELATIONS].join(', ')}`);
  if (typeof remove !== 'boolean') throw invalid('remove', 'Must be true or false');
  const db = getDb({ directory, db: dbArg });
  return inTransaction({ directory, db }, () => {
    const ticket = ticketRow(db, key, 'key');
    requireTicketRead(actor, ticket);
    requireTicketWrite(actor, ticket);
    const other = ticketRow(db, otherKey, 'otherKey');
    requireTicketRead(actor, other);
    requireTicketWrite(actor, other);
    if (ticket.id === other.id) throw invalid('otherKey', 'A ticket cannot be related to itself');

    const normalized = canonicalRelation(ticket, other, relation);
    const existing = relationExists(db, normalized);
    if (remove) {
      if (!existing) return { ticket: getTicket({ directory, db, actor, key: ticket.key }) };
      db.prepare('DELETE FROM ticket_relations WHERE id = ?').run(existing.id);
      markRelationsChanged(db, ticket, actor, source, 'unrelated', other.key, relation, now);
      markRelationsChanged(db, other, actor, source, 'unrelated', ticket.key, INVERSE[relation], now);
      return { ticket: getTicket({ directory, db, actor, key: ticket.key }) };
    }
    if (existing) return { ticket: getTicket({ directory, db, actor, key: ticket.key }) };
    if (relationForPair(db, ticket.id, other.id)) throw conflict('These tickets already have a relation', 'relation');
    if (normalized.kind === 'blocks' && wouldCreateBlockCycle(db, normalized.from, normalized.to)) {
      throw conflict('This blocks relation would create a cycle', 'relation');
    }
    if (relationCount(db, ticket.id) >= RELATION_LIMIT || relationCount(db, other.id) >= RELATION_LIMIT) {
      throw limitExceeded(`A ticket can have at most ${RELATION_LIMIT} relations`, 'relation');
    }

    const info = actorInfo(actor);
    db.prepare(
      `INSERT INTO ticket_relations (id, ticket_id, related_ticket_id, kind, created_at, created_by_type, created_by_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(newId(), normalized.from.id, normalized.to.id, normalized.kind, now, info.type, info.id);
    markRelationsChanged(db, ticket, actor, source, 'related', other.key, relation, now);
    markRelationsChanged(db, other, actor, source, 'related', ticket.key, INVERSE[relation], now);
    return { ticket: getTicket({ directory, db, actor, key: ticket.key }) };
  });
}

export const TICKET_RELATION_KINDS = Object.freeze([...RELATIONS]);
export const RELATION_LIMITS = Object.freeze({ perTicket: RELATION_LIMIT });
