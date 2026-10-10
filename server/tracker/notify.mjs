import { ticketAccess, recipientActor } from './access.mjs';
import { getDb, invalid, newId } from './shared.mjs';

/** @typedef {'assigned' | 'mentioned' | 'commented' | 'status_changed' | 'due_soon' | 'relation_changed' | 'integration_activity'} NotificationKind */
/** @typedef {'both' | 'app' | 'off'} NotifyChoice */

export const NOTIFICATION_KINDS = Object.freeze([
  'assigned', 'mentioned', 'commented', 'status_changed', 'due_soon', 'relation_changed', 'integration_activity',
]);
export const NOTIFY_CHOICES = Object.freeze(['both', 'app', 'off']);
export const DEFAULT_NOTIFY = Object.freeze({
  assigned: 'both',
  mentioned: 'both',
  commented: 'app',
  status_changed: 'app',
  due_soon: 'both',
  relation_changed: 'app',
  integration_activity: 'app',
});

const NOTIFY_PREF_PREFIX = 'tracker.notify.';
const EMAIL_GRACE_MS = 120_000;
const RECIPIENT_LIMIT = 200;
const KIND_PRIORITY = Object.freeze({ mentioned: 4, assigned: 3, commented: 2, status_changed: 2, relation_changed: 2 });

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(value ?? '{}');
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** @returns {Record<NotificationKind, NotifyChoice>} */
export function getNotifyPrefs(directory, userId) {
  const result = /** @type {Record<NotificationKind, NotifyChoice>} */ ({});
  for (const kind of NOTIFICATION_KINDS) {
    const stored = directory.getPref(userId, `${NOTIFY_PREF_PREFIX}${kind}`);
    result[kind] = NOTIFY_CHOICES.includes(stored) ? stored : DEFAULT_NOTIFY[kind];
  }
  return result;
}

export function setNotifyPrefs(directory, userId, patch) {
  if (!isObject(patch)) throw invalid('patch', 'Must be an object of notification preferences');
  const entries = Object.entries(patch);
  for (const [kind, choice] of entries) {
    if (!NOTIFICATION_KINDS.includes(kind)) throw invalid(`patch.${kind}`, 'Unsupported notification kind');
    if (!NOTIFY_CHOICES.includes(choice)) throw invalid(`patch.${kind}`, `Must be one of ${NOTIFY_CHOICES.join(', ')}`);
  }
  for (const [kind, choice] of entries) directory.setPref(userId, `${NOTIFY_PREF_PREFIX}${kind}`, choice);
}

function actorUserId(actor) {
  const type = actor?.type ?? actor?.actorType ?? 'user';
  const principal = actor?.user ?? actor?.owner ?? actor?.representedUser ?? actor;
  if (type === 'mcp_token') return actor?.ownerUserId ?? principal?.id ?? actor?.userId ?? null;
  if (type === 'user') return principal?.id ?? actor?.userId ?? null;
  return actor?.userId ?? null;
}

function addKind(recipients, userId, kind) {
  if (!userId) return;
  const current = recipients.get(userId);
  if (!current || KIND_PRIORITY[kind] > KIND_PRIORITY[current]) recipients.set(userId, kind);
}

function mentionedUserIds(db, ticketId, details) {
  if (typeof details.commentId !== 'string') return [];
  const comment = db.prepare('SELECT body FROM ticket_comments WHERE id = ? AND ticket_id = ?').get(details.commentId, ticketId);
  if (!comment) return [];
  const ids = [];
  const seen = new Set();
  for (const match of comment.body.matchAll(/@\{([^}]+)\}/gu)) {
    const userId = match[1];
    if (!seen.has(userId)) {
      seen.add(userId);
      ids.push(userId);
    }
  }
  return ids;
}

function rowsForUsers(db, userIds) {
  const uniqueIds = [...new Set(userIds.filter(Boolean))];
  const rows = [];
  for (let start = 0; start < uniqueIds.length; start += 200) {
    const batch = uniqueIds.slice(start, start + 200);
    if (!batch.length) continue;
    const placeholders = batch.map(() => '?').join(', ');
    rows.push(...db.prepare(
      `SELECT id, role, disabled FROM users WHERE id IN (${placeholders})`,
    ).all(...batch));
  }
  return new Map(rows.map((row) => [row.id, row]));
}

function subscribe(db, ticketId, userId, reason, createdAt) {
  if (!userId) return;
  db.prepare(
    `INSERT OR IGNORE INTO ticket_subscriptions (ticket_id, user_id, reason, created_at)
     SELECT ?, id, ?, ? FROM users WHERE id = ? AND disabled = 0`,
  ).run(ticketId, reason, createdAt, userId);
}

function notifyChoice(db, userId, kind) {
  const row = db.prepare('SELECT value FROM user_prefs WHERE user_id = ? AND key = ?')
    .get(userId, `${NOTIFY_PREF_PREFIX}${kind}`);
  return NOTIFY_CHOICES.includes(row?.value) ? row.value : DEFAULT_NOTIFY[kind];
}

function eventRecipients({ db, eventType, before, after, ticket, details, ticketId }) {
  const recipients = new Map();
  let sharedKind = null;
  if (eventType === 'created') {
    addKind(recipients, ticket.assignee_user_id, 'assigned');
  } else if (eventType === 'updated') {
    if (after.assignee && after.assignee !== before.assignee) addKind(recipients, after.assignee, 'assigned');
  } else if (eventType === 'transitioned') {
    sharedKind = 'status_changed';
  } else if (eventType === 'commented') {
    sharedKind = 'commented';
  } else if (eventType === 'related' || eventType === 'unrelated') {
    sharedKind = 'relation_changed';
  } else {
    return { recipients, mentionedIds: [] };
  }

  if (sharedKind) {
    for (const row of db.prepare(
      'SELECT user_id FROM ticket_subscriptions WHERE ticket_id = ? ORDER BY user_id LIMIT ?',
    ).all(ticketId, RECIPIENT_LIMIT)) addKind(recipients, row.user_id, sharedKind);
    if (ticket.created_by_type === 'user') addKind(recipients, ticket.created_by_id, sharedKind);
    addKind(recipients, ticket.assignee_user_id, sharedKind);
  }

  const mentionedIds = eventType === 'commented' ? mentionedUserIds(db, ticketId, details) : [];
  for (const userId of mentionedIds) addKind(recipients, userId, 'mentioned');
  return { recipients, mentionedIds };
}

/**
 * Insert in-app notices and durable email work for one ticket event, inside its mutation transaction. `boardAccess` is the
 * resolver ticketAccess uses for board-only people (the linked boards a ticket is on); until tickets can be linked to boards
 * nothing supplies it, so a board-only person gets no notice.
 */
export function fanOut({ db: dbArg, ticketId, eventId, eventType, actor, createdAt, boardAccess = null }) {
  const db = getDb({ db: dbArg });
  const event = db.prepare(
    `SELECT id, ticket_id, event_type, actor_type, actor_id, created_at, before_json, after_json, details_json
       FROM ticket_events WHERE id = ? AND ticket_id = ?`,
  ).get(eventId, ticketId);
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!event || !ticket) return;

  const before = parseObject(event.before_json);
  const after = parseObject(event.after_json);
  const details = parseObject(event.details_json);
  const actualEventType = event.event_type ?? eventType;
  const actorId = actorUserId(actor);
  const mentionedIds = actualEventType === 'commented' ? mentionedUserIds(db, ticketId, details) : [];

  if (actualEventType === 'created' && ticket.created_by_type === 'user') {
    subscribe(db, ticketId, ticket.created_by_id, 'creator', createdAt);
  }
  if (actualEventType === 'created' && ticket.assignee_user_id) {
    subscribe(db, ticketId, ticket.assignee_user_id, 'assignee', createdAt);
  }
  if (actualEventType === 'updated' && after.assignee && after.assignee !== before.assignee) {
    subscribe(db, ticketId, after.assignee, 'assignee', createdAt);
  }
  if (actualEventType === 'commented') {
    subscribe(db, ticketId, actorId, 'commenter', createdAt);
    for (const userId of mentionedIds) subscribe(db, ticketId, userId, 'mentioned', createdAt);
  }

  const { recipients } = eventRecipients({ db, eventType: actualEventType, before, after, ticket, details, ticketId });
  recipients.delete(actorId);
  const sortedRecipients = [...recipients.entries()]
    .sort(([idA, kindA], [idB, kindB]) => KIND_PRIORITY[kindB] - KIND_PRIORITY[kindA] || idA.localeCompare(idB))
    .slice(0, RECIPIENT_LIMIT);
  const userRows = rowsForUsers(db, sortedRecipients.map(([userId]) => userId));

  for (const [userId, kind] of sortedRecipients) {
    const user = userRows.get(userId);
    if (!user || user.disabled) continue;
    try {
      ticketAccess(recipientActor(user), ticket, { boardAccess });
    } catch {
      continue;
    }
    const preference = notifyChoice(db, userId, kind);
    if (preference === 'off') continue;
    db.prepare(
      `INSERT OR IGNORE INTO notifications
        (id, user_id, ticket_id, event_id, kind, dedupe_key, created_at, next_email_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId(), userId, ticketId, eventId, kind, `ev:${eventId}`, createdAt,
      preference === 'both' ? createdAt + EMAIL_GRACE_MS : null,
    );
  }
}
