import { ticketAccess, recipientActor } from './access.mjs';
import { getDb, invalid } from './shared.mjs';
import { PRIORITIES } from './tickets.mjs';

const UNREAD_SCAN_LIMIT = 500;
const PAGE_BATCH = 100;

function parseObject(value) {
  try {
    const parsed = JSON.parse(value ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function userIdOf(user) {
  return typeof user === 'string' ? user : user?.id;
}

function clampLimit(value, fallback = 30) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(50, Math.floor(number)));
}

function decodeCursor(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(value)) throw invalid('before', 'Must be a valid inbox cursor');
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!decoded || !Number.isSafeInteger(decoded.createdAt) || typeof decoded.id !== 'string' || !decoded.id) {
      throw new Error('invalid cursor');
    }
    return { createdAt: decoded.createdAt, id: decoded.id };
  } catch {
    throw invalid('before', 'Must be a valid inbox cursor');
  }
}

function encodeCursor(item) {
  return Buffer.from(JSON.stringify({ createdAt: item.createdAt, id: item.id })).toString('base64url');
}

function flattened(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

function clipped(value, max) {
  const text = Array.from(flattened(value));
  return text.length > max ? `${text.slice(0, max - 1).join('')}…` : text.join('');
}

function commentPreview(db, commentId) {
  if (typeof commentId !== 'string' || !commentId) return null;
  const row = db.prepare('SELECT body, deleted_at FROM ticket_comments WHERE id = ?').get(commentId);
  if (!row || row.deleted_at != null) return null;
  const plain = String(row.body).replace(/@\{([^}]+)\}/gu, (_all, id) => {
    const person = db.prepare('SELECT name FROM users WHERE id = ?').get(id);
    return `@${person?.name ?? 'someone'}`;
  }).replace(/\s+/gu, ' ').trim();
  return clipped(plain, 140);
}

/** Read the ticket and event fields shared by inbox rows and outbox mail. */
export function notificationContent(db, row) {
  const ticket = db.prepare(
    `SELECT t.id, t.key, t.title, t.priority, t.due_date, t.archived_at,
            s.name AS state_name, s.category AS state_category, assignee.name AS assignee_name
       FROM tickets t
       JOIN ticket_states s ON s.id = t.state_id
       LEFT JOIN users assignee ON assignee.id = t.assignee_user_id
      WHERE t.id = ?`,
  ).get(row.ticket_id);
  if (!ticket) return null;

  const event = row.event_id == null ? null : db.prepare(
    `SELECT actor_type, actor_id, after_json, details_json
       FROM ticket_events WHERE id = ? AND ticket_id = ?`,
  ).get(row.event_id, row.ticket_id);
  const details = parseObject(event?.details_json);
  const after = parseObject(event?.after_json);
  let actor = null;
  if (event?.actor_type === 'user' && event.actor_id) {
    actor = db.prepare('SELECT name FROM users WHERE id = ?').get(event.actor_id)?.name ?? null;
  } else if (event?.actor_type === 'mcp_token' && typeof details.ownerUserId === 'string') {
    actor = db.prepare('SELECT name FROM users WHERE id = ?').get(details.ownerUserId)?.name ?? null;
  }

  let preview = null;
  if (row.kind === 'commented' || row.kind === 'mentioned') preview = commentPreview(db, details.commentId);

  let detail = null;
  if (row.kind === 'status_changed' && typeof after.state?.name === 'string') {
    detail = { state: after.state.name };
  } else if (row.kind === 'relation_changed' && typeof details.relatedKey === 'string' && typeof details.relation === 'string') {
    detail = { key: details.relatedKey, relation: details.relation };
  } else if (row.kind === 'integration_activity' && typeof details.text === 'string') {
    detail = { text: clipped(details.text, 120) };
  } else if (row.kind === 'due_soon' && typeof ticket.due_date === 'string') {
    detail = { dueDate: ticket.due_date };
  }

  return {
    ticket: {
      id: ticket.id,
      key: ticket.key,
      title: ticket.title,
      state: { name: ticket.state_name, category: ticket.state_category },
      assignee: ticket.assignee_name == null ? null : { name: ticket.assignee_name },
      priority: PRIORITIES[ticket.priority] ?? 'none',
      dueDate: ticket.due_date ?? null,
      archivedAt: ticket.archived_at ?? null,
    },
    actor,
    preview,
    detail,
  };
}

function currentUser(db, user) {
  const userId = userIdOf(user);
  if (typeof userId !== 'string' || !userId) return null;
  return db.prepare('SELECT id, role, disabled FROM users WHERE id = ?').get(userId) ?? null;
}

function mayRead(userRow, ticket, boardAccess) {
  try {
    ticketAccess(recipientActor(userRow), ticket, { boardAccess });
    return true;
  } catch {
    return false;
  }
}

function suppress(db, id) {
  db.prepare('UPDATE notifications SET suppressed_at = ? WHERE id = ? AND suppressed_at IS NULL').run(Date.now(), id);
}

function unreadCandidateCount(db, userId) {
  return db.prepare(
    `SELECT COUNT(*) AS count FROM (
       SELECT id FROM notifications
        WHERE user_id = ? AND read_at IS NULL AND suppressed_at IS NULL
        ORDER BY created_at DESC, id DESC LIMIT ?
     )`,
  ).get(userId, UNREAD_SCAN_LIMIT).count;
}

/** The current unread count, rechecking at most the newest 500 candidate rows for board-only users. */
/** @param {any} directory @param {any} user @param {{ boardAccess?: ((ticketId: string, userId: string) => string | null) | null }} [options] */
export function unreadCount(directory, user, { boardAccess = null } = {}) {
  const db = getDb({ directory });
  const userRow = currentUser(db, user);
  if (!userRow) return 0;
  const count = unreadCandidateCount(db, userRow.id);
  if (!count) return 0;
  if (!userRow.disabled && ['owner', 'admin', 'member', 'viewer'].includes(userRow.role)) return count;

  let visible = count;
  const rows = db.prepare(
    `SELECT n.id, n.ticket_id, t.id AS visible_ticket_id
       FROM (
         SELECT id, ticket_id, created_at FROM notifications
          WHERE user_id = ? AND read_at IS NULL AND suppressed_at IS NULL
          ORDER BY created_at DESC, id DESC LIMIT ?
       ) n
       JOIN tickets t ON t.id = n.ticket_id
      ORDER BY n.created_at DESC, n.id DESC`,
  ).all(userRow.id, UNREAD_SCAN_LIMIT);
  for (const row of rows) {
    if (mayRead(userRow, { id: row.visible_ticket_id }, boardAccess)) continue;
    suppress(db, row.id);
    visible--;
  }
  return Math.max(0, visible);
}

/** List one person's inbox, newest first, with an opaque keyset cursor. */
/** @param {{ directory: any, user: any, limit?: number, before?: string | null, unreadOnly?: boolean, boardAccess?: ((ticketId: string, userId: string) => string | null) | null }} options */
export function listNotifications({ directory, user, limit = 30, before = null, unreadOnly = false, boardAccess = null }) {
  const db = getDb({ directory });
  const userId = userIdOf(user);
  if (typeof userId !== 'string' || !userId) throw invalid('user', 'Must identify an inbox user');
  const cursor = decodeCursor(before);
  const pageLimit = clampLimit(limit);
  const userRow = currentUser(db, user);
  if (!userRow) return { items: [], nextCursor: null, unread: 0 };

  const items = [];
  let scanCursor = cursor;
  let exhausted = false;
  while (items.length <= pageLimit && !exhausted) {
    const rows = db.prepare(
      `SELECT n.id, n.ticket_id, n.event_id, n.kind, n.created_at, n.read_at,
              t.id AS visible_ticket_id
         FROM notifications n
         JOIN tickets t ON t.id = n.ticket_id
        WHERE n.user_id = ? AND n.suppressed_at IS NULL
          AND (? = 0 OR n.read_at IS NULL)
          AND (? IS NULL OR n.created_at < ? OR (n.created_at = ? AND n.id < ?))
        ORDER BY n.created_at DESC, n.id DESC LIMIT ?`,
    ).all(
      userId,
      unreadOnly ? 1 : 0,
      scanCursor?.createdAt ?? null,
      scanCursor?.createdAt ?? null,
      scanCursor?.createdAt ?? null,
      scanCursor?.id ?? null,
      PAGE_BATCH,
    );
    if (!rows.length) break;
    if (rows.length < PAGE_BATCH) exhausted = true;
    for (const row of rows) {
      scanCursor = { createdAt: row.created_at, id: row.id };
      if (!mayRead(userRow, { id: row.visible_ticket_id }, boardAccess)) {
        suppress(db, row.id);
        continue;
      }
      const content = notificationContent(db, row);
      if (!content) {
        suppress(db, row.id);
        continue;
      }
      items.push({
        id: row.id,
        kind: row.kind,
        createdAt: row.created_at,
        readAt: row.read_at ?? null,
        ticket: {
          key: content.ticket.key,
          title: content.ticket.title,
          state: content.ticket.state,
          assignee: content.ticket.assignee,
          priority: content.ticket.priority,
        },
        actor: content.actor == null ? null : { name: content.actor },
        preview: content.preview,
        detail: content.detail,
      });
      if (items.length > pageLimit) break;
    }
  }

  const hasMore = items.length > pageLimit;
  const page = items.slice(0, pageLimit);
  return {
    items: page,
    nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
    unread: unreadCount(directory, userRow.id, { boardAccess }),
  };
}

function nowValue(now) {
  const value = typeof now === 'function' ? now() : now;
  return Number.isSafeInteger(value) ? value : Date.now();
}

/** Mark only the caller's rows read and cancel any queued email for them. */
/** @param {{ directory: any, user: any, ids?: string[], all?: boolean, now?: number | (() => number) }} options */
export function markRead({ directory, user, ids = [], all = false, now = Date.now() }) {
  const db = getDb({ directory });
  const userId = userIdOf(user);
  if (typeof userId !== 'string' || !userId) throw invalid('user', 'Must identify an inbox user');
  const at = nowValue(now);
  if (all === true) {
    const result = db.prepare(
      'UPDATE notifications SET read_at = ?, next_email_at = NULL WHERE user_id = ? AND read_at IS NULL',
    ).run(at, userId);
    return { updated: Number(result.changes) };
  }
  if (!Array.isArray(ids)) throw invalid('ids', 'Must be an array of notification ids');
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
  let updated = 0;
  for (let start = 0; start < unique.length; start += 200) {
    const batch = unique.slice(start, start + 200);
    if (!batch.length) continue;
    const result = db.prepare(
      `UPDATE notifications SET read_at = ?, next_email_at = NULL
        WHERE user_id = ? AND read_at IS NULL AND id IN (${batch.map(() => '?').join(', ')})`,
    ).run(at, userId, ...batch);
    updated += Number(result.changes);
  }
  return { updated };
}
