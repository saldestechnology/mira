import { requireTicketRead } from './access.mjs';
import { actorInfo, getDb, inTransaction, invalid, requireWritable } from './shared.mjs';

function userIdFor(actor) {
  const info = actorInfo(actor);
  if (info.type !== 'user' || !info.userId || info.id !== info.userId) {
    throw invalid('actor', 'Subscriptions belong to the signed-in user');
  }
  return info.userId;
}

function ticketFor(db, actor, key) {
  const row = typeof key === 'string' && key.trim()
    ? db.prepare('SELECT id FROM tickets WHERE key = ? COLLATE NOCASE OR id = ? LIMIT 1').get(key.trim(), key.trim())
    : null;
  requireTicketRead(actor, row);
  return row;
}

/** @param {any} options */
export function isSubscribed({ directory, db: dbArg, actor, key } = {}) {
  const db = getDb({ directory, db: dbArg });
  const userId = userIdFor(actor);
  const ticket = ticketFor(db, actor, key);
  return Boolean(db.prepare('SELECT 1 FROM ticket_subscriptions WHERE ticket_id = ? AND user_id = ?').get(ticket.id, userId));
}

/** @param {any} options */
export function subscribeTicket({ directory, db: dbArg, actor, key, now = Date.now(), readOnly = () => false } = {}) {
  requireWritable(readOnly);
  const db = getDb({ directory, db: dbArg });
  const userId = userIdFor(actor);
  const ticket = ticketFor(db, actor, key);
  inTransaction({ directory, db }, () => {
    db.prepare(
      "INSERT OR IGNORE INTO ticket_subscriptions (ticket_id, user_id, reason, created_at) VALUES (?, ?, 'manual', ?)",
    ).run(ticket.id, userId, now);
  });
  return true;
}

/** @param {any} options */
export function unsubscribeTicket({ directory, db: dbArg, actor, key, readOnly = () => false } = {}) {
  requireWritable(readOnly);
  const db = getDb({ directory, db: dbArg });
  const userId = userIdFor(actor);
  const ticket = ticketFor(db, actor, key);
  inTransaction({ directory, db }, () => {
    db.prepare('DELETE FROM ticket_subscriptions WHERE ticket_id = ? AND user_id = ?').run(ticket.id, userId);
  });
  return false;
}
