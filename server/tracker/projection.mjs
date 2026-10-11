import { applyPlan, planRemoveTrackerProjection, planTrackerContainerLink, planTrackerProjection } from '../board-ops.mjs';
import { getDb } from './shared.mjs';

const PROJECTION_BATCH = 500;
const MAX_BACKOFF_MS = 5 * 60_000;
const DEFAULT_RETRY_INTERVAL_MS = 1000;

function labelsFor(db, ticketId) {
  return db.prepare(
    `SELECT l.id, l.name, l.color FROM ticket_labels tl JOIN labels l ON l.id = tl.label_id
      WHERE tl.ticket_id = ? AND l.archived_at IS NULL ORDER BY l.name COLLATE NOCASE, l.id`,
  ).all(ticketId).map((row) => ({ id: row.id, name: row.name, color: row.color ?? null }));
}

function ticketProjection(db, ticketId, eventSeq) {
  const row = db.prepare(
    `SELECT t.id, t.key, t.tracker_id, t.title, t.state_id, t.priority, t.assignee_user_id, t.due_date,
            s.state_key, s.name AS state_name, s.category AS state_category, u.name AS assignee_name
       FROM tickets t JOIN ticket_states s ON s.id = t.state_id
       LEFT JOIN users u ON u.id = t.assignee_user_id WHERE t.id = ?`,
  ).get(ticketId);
  if (!row) return null;
  return {
    ticketId: row.id,
    ticketKey: row.key,
    title: row.title,
    state: { id: row.state_id, key: row.state_key, name: row.state_name, category: row.state_category },
    assignee: row.assignee_user_id && row.assignee_name
      ? { userId: row.assignee_user_id, name: row.assignee_name }
      : null,
    labels: labelsFor(db, ticketId),
    priority: ['none', 'urgent', 'high', 'medium', 'low'][row.priority] ?? 'none',
    due: row.due_date ?? null,
    projectionSeq: eventSeq,
    trackerId: row.tracker_id,
    stateId: row.state_id,
  };
}

function mapFor(db, linkId) {
  return Object.fromEntries(db.prepare(
    `SELECT m.lane_id, s.state_key FROM kanban_state_mappings m
       JOIN ticket_states s ON s.id = m.state_id WHERE m.kanban_link_id = ? ORDER BY m.lane_id`,
  ).all(linkId).map((row) => [row.lane_id, row.state_key]));
}

const SERVER_CARD_FIELDS = ['extProvider', 'extKey', 'extUrl', 'trackerId', 'tracker', 'ext', 'trackerUnmappedState'];
const TABULA_CARD_FIELDS = ['trackerId', 'tracker', 'trackerUnmappedState'];

function jsonValue(value) {
  return value && typeof value.toJSON === 'function' ? value.toJSON() : value;
}

function sameJson(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => sameJson(item, b[index]));
  }
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  return aKeys.length === bKeys.length && aKeys.every((key, index) => key === bKeys[index] && sameJson(a[key], b[key]));
}

function activeTrackerLinks(db, boardId) {
  return db.prepare(
    `SELECT l.kanban_id, l.card_id, l.ticket_id, kl.id AS kanban_link_id,
            t.tracker_id, t.updated_seq
       FROM ticket_links l
       JOIN kanban_tracker_links kl ON kl.board_id = l.board_id AND kl.kanban_id = l.kanban_id AND kl.removed_at IS NULL
       JOIN tickets t ON t.id = l.ticket_id
      WHERE l.board_id = ? AND l.removed_at IS NULL ORDER BY l.kanban_id, l.card_id`,
  ).all(boardId);
}

function activeKanbanLinks(db, boardId) {
  const trackerId = db.prepare('SELECT id FROM trackers ORDER BY created_at, id LIMIT 1').get()?.id;
  if (!trackerId) return [];
  return db.prepare(
    `SELECT id, kanban_id FROM kanban_tracker_links
      WHERE board_id = ? AND removed_at IS NULL ORDER BY kanban_id`,
  ).all(boardId).map((link) => ({ ...link, trackerId, map: mapFor(db, link.id) }));
}

function projectionForLink(db, link, baseUrl) {
  const projection = ticketProjection(db, link.ticket_id, Number(link.updated_seq));
  if (!projection) return null;
  const targetLaneId = db.prepare(
    'SELECT lane_id FROM kanban_state_mappings WHERE kanban_link_id = ? AND state_id = ?',
  ).get(link.kanban_link_id, projection.stateId)?.lane_id ?? null;
  return {
    values: {
      extProvider: 'tabula',
      extKey: projection.ticketKey,
      extUrl: `${String(baseUrl).replace(/\/+$/u, '')}/t/${encodeURIComponent(projection.ticketKey)}`,
      trackerId: projection.trackerId,
      tracker: {
        ticketId: projection.ticketId,
        ticketKey: projection.ticketKey,
        title: projection.title,
        state: projection.state,
        assignee: projection.assignee,
        labels: projection.labels,
        priority: projection.priority,
        due: projection.due,
        projectionSeq: projection.projectionSeq,
      },
      trackerUnmappedState: targetLaneId === null,
    },
  };
}

/**
 * Strip or restore tracker-owned board fields against the SQL link tables. `objectIds` narrows live relay repairs to
 * objects touched by the client update; omitting it scans only objects already carrying tracker fields and active links.
 * @param {any} [input]
 */
export function reconcileTrackerProjection({
  directory, roomAccess, boardId, baseUrl = 'http://localhost', now = Date.now(), objectIds = null, origin = null,
} = {}) {
  if (origin === 'tracker-guard' || (typeof origin === 'string' && origin.startsWith('tracker-sync'))) {
    return { changed: 0, stripped: 0, repaired: 0, skipped: true };
  }
  if (!directory || !roomAccess || typeof roomAccess.write !== 'function' || typeof boardId !== 'string') {
    return { changed: 0, stripped: 0, repaired: 0, skipped: true };
  }

  const db = getDb({ directory });
  const kanbans = activeKanbanLinks(db, boardId);
  const links = activeTrackerLinks(db, boardId);
  const linkedCards = new Map(links.map((link) => [`${link.kanban_id}\u0000${link.card_id}`, link]));
  const linksByCard = new Map(links.map((link) => [link.card_id, link]));
  const linkedContainers = new Set(kanbans.map((link) => link.kanban_id));
  const onlyIds = objectIds ? new Set(objectIds) : null;
  let stripped = 0;
  let repaired = 0;
  let changed = 0;

  roomAccess.write(boardId, 'tracker-guard', (doc) => {
    const objects = doc.getMap('objects');
    const candidates = new Set(onlyIds ?? []);
    if (!onlyIds) {
      objects.forEach((value, id) => {
        const json = jsonValue(value);
        if (!json || typeof json !== 'object') return;
        if ((json.type === 'card' && SERVER_CARD_FIELDS.some((field) => Object.hasOwn(json, field)))
          || (json.type === 'container' && Object.hasOwn(json, 'ext'))) candidates.add(String(id));
      });
      for (const link of links) candidates.add(link.card_id);
      for (const link of kanbans) candidates.add(link.kanban_id);
    }

    for (const id of candidates) {
      const object = objects.get(id);
      if (!object || typeof object.get !== 'function' || typeof object.set !== 'function' || typeof object.delete !== 'function') continue;
      const json = jsonValue(object);
      if (!json || typeof json !== 'object') continue;

      if (json.type === 'container') {
        if (linkedContainers.has(id)) continue;
        const ext = jsonValue(object.get('ext'));
        if (object.has('ext') && (!ext || typeof ext !== 'object' || ext.provider === 'tabula' || typeof ext.provider !== 'string')) {
          object.delete('ext');
          object.set('updatedAt', now);
          changed++;
          stripped++;
        }
        continue;
      }

      if (json.type !== 'card') continue;
      const lane = jsonValue(objects.get(json.parent));
      const link = linkedCards.get(`${lane?.parent ?? ''}\u0000${id}`) ?? linksByCard.get(id);
      if (link) {
        const projection = projectionForLink(db, link, baseUrl);
        if (!projection) continue;
        let cardChanged = false;
        const foreignProvider = typeof json.extProvider === 'string' && json.extProvider !== 'tabula';
        const values = foreignProvider
          ? Object.fromEntries(TABULA_CARD_FIELDS.map((field) => [field, projection.values[field]]))
          : projection.values;
        for (const [field, value] of Object.entries(values)) {
          if (sameJson(json[field], value)) continue;
          object.set(field, value);
          cardChanged = true;
        }
        if (cardChanged) {
          object.set('updatedAt', now);
          changed++;
          repaired++;
        }
        continue;
      }

      const foreignProvider = typeof json.extProvider === 'string' && json.extProvider !== 'tabula';
      const fields = foreignProvider ? TABULA_CARD_FIELDS : SERVER_CARD_FIELDS;
      let cardChanged = false;
      for (const field of fields) {
        if (!object.has(field)) continue;
        object.delete(field);
        cardChanged = true;
      }
      if (cardChanged) {
        object.set('updatedAt', now);
        changed++;
        stripped++;
      }
    }

    for (const link of kanbans) {
      const expected = { provider: 'tabula', tracker: link.trackerId, map: link.map };
      const container = objects.get(link.kanban_id);
      if (!container || typeof container.get !== 'function' || typeof container.set !== 'function') continue;
      const current = jsonValue(container.get('ext'));
      if (current && typeof current === 'object' && typeof current.provider === 'string' && current.provider !== 'tabula') continue;
      if (sameJson(current, expected)) continue;
      container.set('ext', expected);
      container.set('updatedAt', now);
      changed++;
      repaired++;
    }
  });

  return { changed, stripped, repaired, skipped: false };
}

/**
 * Enqueue a snapshot for every active card link. Call inside the same directory transaction as its ticket event.
 * @param {any} [input]
 */
export function enqueueTicketProjection({ db: dbArg, ticketId, eventSeq, now = Date.now() } = {}) {
  const db = getDb({ db: dbArg });
  const projection = ticketProjection(db, ticketId, eventSeq);
  if (!projection) return 0;
  const links = db.prepare(
    `SELECT l.id AS ticket_link_id, l.board_id, l.kanban_id, l.card_id, kl.id AS kanban_link_id
       FROM ticket_links l JOIN kanban_tracker_links kl
         ON kl.board_id = l.board_id AND kl.kanban_id = l.kanban_id AND kl.removed_at IS NULL
      WHERE l.ticket_id = ? AND l.removed_at IS NULL ORDER BY l.board_id, l.kanban_id, l.card_id`,
  ).all(ticketId);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO ticket_projection_outbox
      (ticket_id, board_id, kanban_id, card_id, event_seq, operation, projection_json, created_at, next_attempt_at)
     VALUES (?, ?, ?, ?, ?, 'upsert', ?, ?, ?)`,
  );
  for (const link of links) {
    const map = mapFor(db, link.kanban_link_id);
    const targetLaneId = db.prepare(
      'SELECT lane_id FROM kanban_state_mappings WHERE kanban_link_id = ? AND state_id = ?',
    ).get(link.kanban_link_id, projection.stateId)?.lane_id ?? null;
    const payload = {
      trackerId: projection.trackerId,
      map,
      targetLaneId,
      projection: {
        ticketId: projection.ticketId,
        ticketKey: projection.ticketKey,
        title: projection.title,
        state: projection.state,
        assignee: projection.assignee,
        labels: projection.labels,
        priority: projection.priority,
        due: projection.due,
        projectionSeq: projection.projectionSeq,
      },
    };
    insert.run(ticketId, link.board_id, link.kanban_id, link.card_id, eventSeq, JSON.stringify(payload), now, now);
  }
  return links.length;
}

/**
 * Replace the latest projection event with a durable remove; older pending snapshots cannot re-add the card.
 * @param {any} [input]
 */
export function enqueueTicketProjectionRemoval({ db: dbArg, ticketLink, now = Date.now() } = {}) {
  const db = getDb({ db: dbArg });
  const rows = db.prepare(
    `SELECT id, event_seq FROM ticket_projection_outbox
      WHERE board_id = ? AND kanban_id = ? AND card_id = ? AND ticket_id = ? ORDER BY event_seq DESC, id DESC`,
  ).all(ticketLink.board_id, ticketLink.kanban_id, ticketLink.card_id, ticketLink.ticket_id);
  const eventSeq = Number(rows[0]?.event_seq ?? ticketLink.last_projection_seq ?? 0);
  if (rows.length) {
    db.prepare(
      `UPDATE ticket_projection_outbox SET applied_at = ?, last_error_code = NULL
        WHERE board_id = ? AND kanban_id = ? AND card_id = ? AND ticket_id = ? AND applied_at IS NULL`,
    ).run(now, ticketLink.board_id, ticketLink.kanban_id, ticketLink.card_id, ticketLink.ticket_id);
    db.prepare(
      `UPDATE ticket_projection_outbox SET operation = 'remove', projection_json = NULL, created_at = ?,
             attempts = 0, next_attempt_at = ?, applied_at = NULL, last_error_code = NULL
        WHERE id = ?`,
    ).run(now, now, rows[0].id);
  } else {
    db.prepare(
      `INSERT INTO ticket_projection_outbox
        (ticket_id, board_id, kanban_id, card_id, event_seq, operation, projection_json, created_at, next_attempt_at)
       VALUES (?, ?, ?, ?, ?, 'remove', NULL, ?, ?)`,
    ).run(ticketLink.ticket_id, ticketLink.board_id, ticketLink.kanban_id, ticketLink.card_id, eventSeq, now, now);
  }
  return eventSeq;
}

/** @param {any} [input] */
export function writeTrackerContainerLink({ roomAccess, boardId, kanbanId, trackerId, map, now = Date.now() } = {}) {
  return roomAccess.write(boardId, 'tracker-sync:link', (doc) => applyPlan(doc, planTrackerContainerLink(doc, {
    containerId: kanbanId, trackerId, map, now,
  })));
}

/** @param {any} [input] */
export function writeTrackerContainerUnlink({ roomAccess, boardId, kanbanId, now = Date.now() } = {}) {
  return roomAccess.write(boardId, 'tracker-sync:unlink', (doc) => applyPlan(doc, planRemoveTrackerProjection(doc, {
    containerId: kanbanId, cardIds: [], now,
  })));
}

function errorCode(error) {
  return typeof error?.code === 'string' && /^[a-z_]{1,40}$/.test(error.code) ? error.code : 'projection_failed';
}

function pendingCount(db, filters) {
  const clauses = ['applied_at IS NULL'];
  const values = [];
  if (filters.boardId) { clauses.push('board_id = ?'); values.push(filters.boardId); }
  if (filters.ticketId) { clauses.push('ticket_id = ?'); values.push(filters.ticketId); }
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ticket_projection_outbox WHERE ${clauses.join(' AND ')}`).get(...values).count);
}

function markApplied(directory, row, now) {
  directory.transaction(() => {
    directory.db.prepare('UPDATE ticket_projection_outbox SET applied_at = ?, last_error_code = NULL WHERE id = ? AND applied_at IS NULL')
      .run(now, row.id);
    directory.db.prepare(
      `UPDATE ticket_links SET last_projection_seq = MAX(last_projection_seq, ?)
        WHERE ticket_id = ? AND board_id = ? AND kanban_id = ? AND card_id = ?`,
    ).run(row.event_seq, row.ticket_id, row.board_id, row.kanban_id, row.card_id);
  });
}

function deferRetry(directory, row, now, error) {
  const attempts = Number(row.attempts) + 1;
  const delay = Math.min(MAX_BACKOFF_MS, 1000 * (2 ** Math.min(attempts - 1, 8)));
  directory.transaction(() => {
    directory.db.prepare(
      `UPDATE ticket_projection_outbox SET attempts = ?, next_attempt_at = ?, last_error_code = ? WHERE id = ? AND applied_at IS NULL`,
    ).run(attempts, now + delay, errorCode(error), row.id);
  });
}

/**
 * Apply due projection work via pure board planners and the relay's serialized room write path.
 * @param {any} [input]
 */
export function drainTicketProjection({ directory, roomAccess, boardId = null, ticketId = null, baseUrl = 'http://localhost', now = Date.now(), limit = PROJECTION_BATCH } = {}) {
  const db = getDb({ directory });
  if (!roomAccess || typeof roomAccess.write !== 'function') return { applied: 0, projectionPending: pendingCount(db, { boardId, ticketId }) > 0 };
  const clauses = ['applied_at IS NULL', 'next_attempt_at <= ?'];
  const values = [now];
  if (boardId) { clauses.push('board_id = ?'); values.push(boardId); }
  if (ticketId) { clauses.push('ticket_id = ?'); values.push(ticketId); }
  const rows = db.prepare(
    `SELECT id, ticket_id, board_id, kanban_id, card_id, event_seq, operation, projection_json, attempts
       FROM ticket_projection_outbox WHERE ${clauses.join(' AND ')} ORDER BY board_id, event_seq, id LIMIT ?`,
  ).all(...values, limit);
  let applied = 0;
  for (const row of rows) {
    try {
      const active = db.prepare(
        `SELECT l.ticket_id, l.last_projection_seq FROM ticket_links l
           JOIN kanban_tracker_links k ON k.board_id = l.board_id AND k.kanban_id = l.kanban_id
          WHERE l.board_id = ? AND l.kanban_id = ? AND l.card_id = ? AND l.removed_at IS NULL AND k.removed_at IS NULL`,
      ).get(row.board_id, row.kanban_id, row.card_id);
      if (row.operation === 'upsert' && (!active || active.ticket_id !== row.ticket_id || Number(active.last_projection_seq) >= Number(row.event_seq))) {
        markApplied(directory, row, now);
        applied++;
        continue;
      }
      if (row.operation === 'remove' && active && active.ticket_id !== row.ticket_id) {
        markApplied(directory, row, now);
        applied++;
        continue;
      }

      if (row.operation === 'remove') {
        roomAccess.write(row.board_id, `tracker-sync:${row.event_seq}`, (doc) => applyPlan(doc, planRemoveTrackerProjection(doc, {
          containerId: row.kanban_id, cardIds: [row.card_id], now,
        })));
      } else {
        let payload;
        try { payload = JSON.parse(row.projection_json); } catch { throw Object.assign(new Error('Invalid stored projection'), { code: 'invalid_projection' }); }
        const ticketKey = payload?.projection?.ticketKey;
        const extUrl = `${String(baseUrl).replace(/\/+$/u, '')}/t/${encodeURIComponent(ticketKey)}`;
        roomAccess.write(row.board_id, `tracker-sync:${row.event_seq}`, (doc) => applyPlan(doc, planTrackerProjection(doc, {
          containerId: row.kanban_id,
          cardId: row.card_id,
          trackerId: payload.trackerId,
          map: payload.map,
          extUrl,
          projection: payload.projection,
          targetLaneId: payload.targetLaneId,
          now,
        })));
      }
      markApplied(directory, row, now);
      applied++;
    } catch (error) {
      deferRetry(directory, row, now, error);
    }
  }
  return { applied, projectionPending: pendingCount(db, { boardId, ticketId }) > 0 };
}

/**
 * Reconcile the board's container copy on every room load, then drain due card projections.
 * @param {any} [input]
 */
export function retryTrackerProjectionOnRoomLoad({ directory, roomAccess, boardId, baseUrl = 'http://localhost', now = Date.now() } = {}) {
  let guardFailed = false;
  try { reconcileTrackerProjection({ directory, roomAccess, boardId, baseUrl, now }); }
  catch { guardFailed = true; }
  const drained = drainTicketProjection({ directory, roomAccess, boardId, baseUrl, now });
  return { ...drained, projectionPending: drained.projectionPending || guardFailed };
}

/**
 * Periodically retry due SQL-to-room projections while the relay is running.
 * @param {any} [input]
 */
export function createTrackerProjectionWorker({
  directory, roomAccess, baseUrl = 'http://localhost', now = Date.now, intervalMs = DEFAULT_RETRY_INTERVAL_MS,
  timers = true, log = () => {},
} = {}) {
  let timer = null;
  let ticking = false;

  function tick() {
    if (ticking) return { applied: 0, projectionPending: true, skipped: true };
    ticking = true;
    try {
      return drainTicketProjection({ directory, roomAccess, baseUrl, now: now() });
    } catch (error) {
      try { log('tracker projection worker failed', error?.message); } catch { /* logging cannot stop the worker */ }
      return { applied: 0, projectionPending: true };
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (!timers || timer) return;
    void tick();
    timer = setInterval(() => void tick(), Math.max(1, intervalMs));
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { tick, start, stop };
}
