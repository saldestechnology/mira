import { ticketAccess, recipientActor } from './access.mjs';
import { getNotifyPrefs, NOTIFICATION_KINDS } from './notify.mjs';
import { notificationContent } from './inbox.mjs';
import { noticeMail } from './notice-mail.mjs';
import { getDb, newId, validCalendarDate } from './shared.mjs';

const DEFAULT_INTERVAL_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;
const EMAIL_CAP_PER_DAY = 20;
const EMAIL_BACKOFF = Object.freeze([60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000]);
const draining = new WeakSet();

function timeValue(now) {
  const value = typeof now === 'function' ? now() : now;
  if (!Number.isSafeInteger(value)) throw new TypeError('now must be a safe integer timestamp or a clock function');
  return value;
}

function rowLimit(value, fallback, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.min(maximum, Math.floor(number))) : fallback;
}

function userRow(directory, userId) {
  return directory.getUser(userId);
}

function clearNextEmail(db, id) {
  db.prepare('UPDATE notifications SET next_email_at = NULL WHERE id = ? AND emailed_at IS NULL').run(id);
}

function suppress(db, id, now) {
  db.prepare(
    'UPDATE notifications SET suppressed_at = ?, next_email_at = NULL WHERE id = ? AND suppressed_at IS NULL',
  ).run(now, id);
}

function errorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{2,40}$/u.test(error.code) ? error.code : 'ERROR';
}

function mailValue(value, max) {
  return Array.from(String(value ?? '').replace(/\s+/gu, ' ').trim()).slice(0, max).join('');
}

/** Drain due, unread notification emails. A per-directory guard prevents duplicate work inside this process. */
/** @param {{ directory: any, mailer: { send: Function }, baseUrl: string, now?: number | (() => number), log?: Function, limit?: number, boardAccess?: ((ticketId: string, userId: string) => string | null) | null }} options */
export async function drainEmailOutbox({ directory, mailer, baseUrl, now = Date.now, log = () => {}, limit = 20, boardAccess = null }) {
  if (!directory || (typeof directory !== 'object' && typeof directory !== 'function')) throw new TypeError('directory is required');
  if (draining.has(directory)) return { sent: 0, failed: 0, skipped: 1 };
  draining.add(directory);
  const result = { sent: 0, failed: 0, skipped: 0 };
  try {
    const db = getDb({ directory });
    const at = timeValue(now);
    const candidates = db.prepare(
      `SELECT id, user_id, ticket_id, event_id, kind, email_attempts
         FROM notifications
        WHERE next_email_at IS NOT NULL AND next_email_at <= ?
          AND emailed_at IS NULL AND suppressed_at IS NULL AND read_at IS NULL
        ORDER BY next_email_at, created_at, id LIMIT ?`,
    ).all(at, rowLimit(limit, 20, 100));

    for (const candidate of candidates) {
      const row = db.prepare(
        `SELECT id, user_id, ticket_id, event_id, kind, email_attempts
           FROM notifications
          WHERE id = ? AND next_email_at IS NOT NULL AND next_email_at <= ?
            AND emailed_at IS NULL AND suppressed_at IS NULL AND read_at IS NULL`,
      ).get(candidate.id, at);
      if (!row) {
        result.skipped++;
        continue;
      }
      const user = userRow(directory, row.user_id);
      if (!user || user.disabled || !user.email) {
        clearNextEmail(db, row.id);
        result.skipped++;
        continue;
      }
      const prefs = getNotifyPrefs(directory, row.user_id);
      if (!NOTIFICATION_KINDS.includes(row.kind) || prefs[row.kind] !== 'both') {
        clearNextEmail(db, row.id);
        result.skipped++;
        continue;
      }

      const content = notificationContent(db, row);
      if (!content) {
        clearNextEmail(db, row.id);
        result.skipped++;
        continue;
      }
      try {
        ticketAccess(recipientActor(user), content.ticket, { boardAccess });
      } catch {
        suppress(db, row.id, at);
        result.skipped++;
        continue;
      }
      const attempts = Number(db.prepare('SELECT email_attempts FROM notifications WHERE id = ?').get(row.id)?.email_attempts ?? row.email_attempts ?? 0);
      if (attempts >= EMAIL_BACKOFF.length) {
        clearNextEmail(db, row.id);
        result.skipped++;
        continue;
      }
      const mailedRecently = db.prepare(
        'SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND emailed_at > ?',
      ).get(row.user_id, at - DAY_MS).count;
      if (mailedRecently >= EMAIL_CAP_PER_DAY) {
        clearNextEmail(db, row.id);
        result.skipped++;
        continue;
      }

      const fresh = db.prepare(
        `SELECT read_at, suppressed_at, emailed_at, next_email_at
           FROM notifications WHERE id = ?`,
      ).get(row.id);
      if (!fresh || fresh.read_at != null || fresh.suppressed_at != null || fresh.emailed_at != null || fresh.next_email_at == null) {
        result.skipped++;
        continue;
      }
      const key = mailValue(content.ticket.key, 64);
      const title = mailValue(content.ticket.title, 200);
      const actor = content.actor == null ? null : mailValue(content.actor, 80) || null;
      const preview = content.preview == null ? null : mailValue(content.preview, 140) || null;
      const link = `${String(baseUrl ?? '').replace(/\/+$/u, '')}/t/${key}`;
      const mail = noticeMail({
        kind: row.kind,
        key,
        title,
        actor,
        preview,
        link,
      });
      try {
        await mailer.send({
          to: user.email,
          subject: mail.subject,
          text: mail.text,
          template: 'ticket-notice',
          params: {
            link,
            kind: row.kind,
            key,
            title,
            actor,
            preview,
          },
        });
        db.prepare(
          `UPDATE notifications SET emailed_at = ?, next_email_at = NULL
            WHERE id = ? AND emailed_at IS NULL AND suppressed_at IS NULL AND read_at IS NULL`,
        ).run(at, row.id);
        result.sent++;
      } catch (error) {
        const code = errorCode(error);
        const nextAttempt = attempts + 1;
        const retryAt = nextAttempt >= EMAIL_BACKOFF.length ? null : at + EMAIL_BACKOFF[nextAttempt - 1];
        db.prepare(
          `UPDATE notifications
              SET email_attempts = ?, last_email_error_code = ?,
                  next_email_at = CASE WHEN read_at IS NULL AND suppressed_at IS NULL THEN ? ELSE NULL END
            WHERE id = ? AND emailed_at IS NULL`,
        ).run(nextAttempt, code, retryAt, row.id);
        try { log('tracker: could not send notification email:', code); } catch { /* logging cannot stall the outbox */ }
        result.failed++;
      }
    }
    return result;
  } finally {
    draining.delete(directory);
  }
}

/** Create due-soon notices for assigned, active tickets in the seven-days-behind through tomorrow UTC window. */
/** @param {{ directory: any, now: number | (() => number), boardAccess?: ((ticketId: string, userId: string) => string | null) | null }} options */
export function scanDueSoon({ directory, now, boardAccess = null }) {
  const db = getDb({ directory });
  const at = timeValue(now);
  const from = new Date(at - 7 * DAY_MS).toISOString().slice(0, 10);
  const through = new Date(at + DAY_MS).toISOString().slice(0, 10);
  const tickets = db.prepare(
    `SELECT t.id, t.key, t.due_date, t.assignee_user_id, t.archived_at, s.category
       FROM tickets t
       JOIN ticket_states s ON s.id = t.state_id
       JOIN users assignee ON assignee.id = t.assignee_user_id AND assignee.disabled = 0
      WHERE t.archived_at IS NULL AND t.assignee_user_id IS NOT NULL
        AND s.category NOT IN ('completed', 'canceled')
        AND t.due_date >= ? AND t.due_date <= ?
        AND COALESCE((SELECT value FROM user_prefs WHERE user_id = t.assignee_user_id AND key = 'tracker.notify.due_soon'), '') <> 'off'
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
           WHERE n.user_id = t.assignee_user_id AND n.ticket_id = t.id AND n.kind = 'due_soon'
             AND n.dedupe_key = 'due:' || t.id || ':' || t.due_date
        )
      ORDER BY t.due_date, t.id LIMIT 500`,
  ).all(from, through);
  let created = 0;
  for (const ticket of tickets) {
    if (!validCalendarDate(ticket.due_date)) continue;
    const user = userRow(directory, ticket.assignee_user_id);
    if (!user || user.disabled) continue;
    const choice = getNotifyPrefs(directory, user.id).due_soon;
    if (choice === 'off') continue;
    try {
      ticketAccess(recipientActor(user), ticket, { boardAccess });
    } catch {
      continue;
    }
    const result = db.prepare(
      `INSERT OR IGNORE INTO notifications
        (id, user_id, ticket_id, event_id, kind, dedupe_key, created_at, next_email_at)
       VALUES (?, ?, ?, NULL, 'due_soon', ?, ?, ?)`,
    ).run(newId(), user.id, ticket.id, `due:${ticket.id}:${ticket.due_date}`, at, choice === 'both' ? at : null);
    created += Number(result.changes);
  }
  return created;
}

function safeLog(log, error) {
  const message = String(error?.message ?? error ?? 'unknown error')
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(/\b(?:sk|rk|whsec|tok|key)[_-][A-Za-z0-9_-]{8,}\b/giu, '[redacted]')
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/giu, '$1[redacted]@')
    .replace(/[\r\n\t]+/gu, ' ')
    .slice(0, 500);
  try { log('tracker: tick failed:', message); } catch { /* logging cannot make a tick fail */ }
}

/** A durable, bounded notification tick. Timers are disabled in unit tests. */
/** @param {{ directory: any, mailer: { send: Function }, baseUrl: string, log?: Function, now?: number | (() => number), boardAccess?: ((ticketId: string, userId: string) => string | null) | null, intervalMs?: number, timers?: boolean }} options */
export function createTrackerNotifier({
  directory,
  mailer,
  baseUrl,
  log = () => {},
  now = Date.now,
  boardAccess = null,
  intervalMs = DEFAULT_INTERVAL_MS,
  timers = true,
}) {
  let timer = null;
  let ticking = false;

  async function tick() {
    if (ticking) return { created: 0, sent: 0, failed: 0, skipped: 1 };
    ticking = true;
    const result = { created: 0, sent: 0, failed: 0, skipped: 0 };
    try {
      try {
        result.created = scanDueSoon({ directory, now: timeValue(now), boardAccess });
      } catch (error) {
        safeLog(log, error);
      }
      try {
        const drained = await drainEmailOutbox({ directory, mailer, baseUrl, now, log, boardAccess });
        result.sent += drained.sent;
        result.failed += drained.failed;
        result.skipped += drained.skipped;
      } catch (error) {
        safeLog(log, error);
      }
      return result;
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (!timers || timer) return;
    void tick();
    timer = setInterval(() => void tick(), intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { tick, start, stop };
}

/** A test-only hook may shorten the normal tick, and cannot be set outside NODE_ENV=test. */
export function trackerTickMsFromTestEnv(env = process.env) {
  const raw = env.TABULA_TRACKER_TICK_MS?.trim();
  if (!raw) return DEFAULT_INTERVAL_MS;
  if (env.NODE_ENV !== 'test') throw new Error('TABULA_TRACKER_TICK_MS is only available when NODE_ENV=test');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_INTERVAL_MS) {
    throw new Error(`TABULA_TRACKER_TICK_MS must be an integer between 1 and ${DEFAULT_INTERVAL_MS}`);
  }
  return value;
}
