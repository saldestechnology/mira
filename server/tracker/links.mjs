import crypto from 'node:crypto';
import { cleanCardTitle, cleanLaneName, sortedChildren } from '../../shared/containers.mjs';
import { ticketAccess } from './access.mjs';
import { createTicket, getTicket } from './tickets.mjs';
import {
  actorInfo, conflict, forbidden, getDb, invalid, limitExceeded, newId, notFound, stripInvisible,
} from './shared.mjs';
import { enqueueTicketProjection, enqueueTicketProjectionRemoval } from './projection.mjs';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LINK_KEY_MIN = 8;
const LINK_KEY_MAX = 64;
const MAX_MAPPING = 20;
const MAX_CREATE_CARDS = 500;
const TRACKER_ACCESS_CHECK = Object.freeze({ id: 'tracker-link-access-check' });

function id(value, path) {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw invalid(path, 'Must be an id');
  return value;
}

function record(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(path, 'Must be an object');
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw invalid(path, 'Must be a plain object');
  return value;
}

function idempotencyKey(value) {
  if (typeof value !== 'string' || Array.from(value).length < LINK_KEY_MIN || Array.from(value).length > LINK_KEY_MAX) {
    throw invalid('idempotencyKey', `Must be ${LINK_KEY_MIN} to ${LINK_KEY_MAX} characters`);
  }
  return value;
}

function canReadTracker(actor) {
  try {
    return ticketAccess(actor, TRACKER_ACCESS_CHECK);
  } catch {
    throw forbidden('Tracker read access is required.');
  }
}

function boardFor(directory, actor, boardId, { write = false } = {}) {
  const boardKey = id(boardId, 'boardId');
  const board = directory.getBoard(boardKey);
  const info = actorInfo(actor);
  const role = board && info.userId ? directory.boardRole(boardKey, info.userId) : null;
  if (info.role === 'guest') throw forbidden('Guest actors cannot use tracker links.');
  if (!board || role === null) throw notFound('Board not found');
  if (write) {
    if (!['owner', 'editor'].includes(role)) throw forbidden('Only a board owner or editor can link a kanban.');
    let access = 'read';
    try { access = ticketAccess(actor, TRACKER_ACCESS_CHECK); } catch { access = 'read'; }
    if (access !== 'write') throw forbidden('Tracker write access is required.');
  } else {
    canReadTracker(actor);
  }
  return { board, boardId: boardKey, role, info };
}

function rawObject(value, objectId) {
  if (value && typeof value.toJSON === 'function') return { ...value.toJSON(), id: objectId };
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value, id: objectId } : null;
}

function boardSnapshot(roomAccess, boardId, kanbanId) {
  if (!roomAccess || typeof roomAccess.read !== 'function') throw new TypeError('linked-kanban commands require roomAccess.read');
  return roomAccess.read(boardId, (doc) => {
    const all = [];
    doc.getMap('objects').forEach((value, objectId) => {
      const object = rawObject(value, objectId);
      if (object) all.push(object);
    });
    const byId = new Map(all.map((object) => [object.id, object]));
    const container = byId.get(kanbanId);
    if (container?.type !== 'container' || container.layout !== 'kanban') throw notFound('Kanban not found');
    const lanes = sortedChildren(all.filter((object) => object.type === 'lane' && object.parent === kanbanId));
    const laneIds = new Set(lanes.map((lane) => lane.id));
    const cards = all.filter((object) => object.type === 'card' && laneIds.has(object.parent));
    const labels = new Map();
    doc.getMap('labels').forEach((value, labelId) => {
      const label = rawObject(value, labelId);
      if (label && label.id === labelId && typeof label.name === 'string') labels.set(labelId, label);
    });
    const seen = new Set();
    for (const card of cards) {
      if (seen.has(card.id)) throw invalid('cardId', 'The kanban contains a duplicate card id');
      seen.add(card.id);
    }
    return { container, lanes, cards, labels };
  });
}

function workflowFor(db) {
  const workflow = db.prepare('SELECT id FROM ticket_workflows WHERE is_default = 1 ORDER BY id LIMIT 1').get();
  if (!workflow) throw new Error('Default ticket workflow seed is missing');
  return workflow.id;
}

function activeStates(db, workflowId) {
  return db.prepare(
    `SELECT id, state_key, name, category, position FROM ticket_states
      WHERE workflow_id = ? AND archived_at IS NULL ORDER BY position, id`,
  ).all(workflowId);
}

function validatedMapping(db, lanes, workflowId, raw) {
  const mapping = record(raw, 'mapping');
  const entries = Object.entries(mapping);
  if (entries.length > MAX_MAPPING) throw invalid('mapping', `A kanban can map at most ${MAX_MAPPING} lanes`);
  const laneIds = new Set(lanes.map((lane) => lane.id));
  const byKey = new Map(activeStates(db, workflowId).map((state) => [state.state_key.toLocaleLowerCase('en-US'), state]));
  const used = new Set();
  const pairs = [];
  const normalized = Object.create(null);
  for (const [laneId, stateKey] of entries) {
    const path = `mapping.${laneId.slice(0, 64)}`;
    if (!ID_RE.test(laneId) || !laneIds.has(laneId)) throw invalid(path, 'Must identify a lane in this kanban');
    if (typeof stateKey !== 'string' || !stateKey.trim()) throw invalid(path, 'Must identify an active tracker state key');
    const state = byKey.get(stateKey.trim().toLocaleLowerCase('en-US'));
    if (!state) throw invalid(path, 'Unknown or inactive tracker state key');
    if (used.has(state.id)) throw invalid(path, 'A tracker state can map to only one lane');
    used.add(state.id);
    normalized[laneId] = state.state_key;
    pairs.push({ laneId, stateKey: state.state_key, stateId: state.id });
  }
  return { normalized, pairs, byLane: new Map(pairs.map((pair) => [pair.laneId, pair])) };
}

function mappingRows(db, linkId) {
  return db.prepare(
    `SELECT m.lane_id, m.state_id, s.state_key FROM kanban_state_mappings m
       JOIN ticket_states s ON s.id = m.state_id WHERE m.kanban_link_id = ? ORDER BY m.lane_id`,
  ).all(linkId).map((row) => ({ laneId: row.lane_id, stateKey: row.state_key, stateId: row.state_id }));
}

function linkView(db, row, { cardCount } = {}) {
  const count = cardCount ?? Number(db.prepare(
    'SELECT COUNT(*) AS count FROM ticket_links WHERE board_id = ? AND kanban_id = ? AND removed_at IS NULL',
  ).get(row.board_id, row.kanban_id).count);
  return {
    id: row.id,
    boardId: row.board_id,
    kanbanId: row.kanban_id,
    workflowId: row.workflow_id,
    mapping: mappingRows(db, row.id),
    cardCount: count,
    createdAt: row.created_at,
    createdBy: row.created_by,
    ...(row.removed_at == null ? {} : { removedAt: row.removed_at }),
  };
}

function parseStoredResult(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function requestLabels(db, value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid('labels', 'Must be a list of label names');
  if (value.length > 20) throw invalid('labels', 'A ticket can have at most 20 labels');
  const seen = new Set();
  return value.map((raw, index) => {
    const path = `labels[${index}]`;
    if (typeof raw !== 'string' || !raw.trim() || Array.from(raw.trim()).length > 64) throw invalid(path, 'Must be a label name of at most 64 characters');
    const name = raw.trim();
    const folded = name.toLocaleLowerCase('en-US');
    if (seen.has(folded)) throw invalid(path, 'Label names must be unique');
    seen.add(folded);
    const label = db.prepare('SELECT name FROM labels WHERE name = ? COLLATE NOCASE AND archived_at IS NULL').get(name);
    if (!label) throw invalid(path, `Unknown label: ${name}`);
    return label.name;
  });
}

function requestProject(db, value) {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || !value.trim() || Array.from(value.trim()).length > 100) throw invalid('project', 'Must be an active project name or null');
  const project = db.prepare('SELECT name FROM projects WHERE name = ? COLLATE NOCASE AND archived_at IS NULL').get(value.trim());
  if (!project) throw invalid('project', 'No active project matches this name');
  return project.name;
}

function memberAssignee(db, card) {
  if (card.ownerKind === 'agent') return null;
  if (typeof card.ownerId === 'string' && card.ownerId) {
    return db.prepare("SELECT email FROM users WHERE id = ? AND role IN ('owner', 'admin', 'member') AND disabled = 0").get(card.ownerId)?.email ?? null;
  }
  if (typeof card.ownerName !== 'string' || !card.ownerName.trim()) return null;
  const rows = db.prepare(
    `SELECT email FROM users WHERE role IN ('owner', 'admin', 'member') AND disabled = 0
      AND (name = ? COLLATE NOCASE OR email = ? COLLATE NOCASE) ORDER BY id`,
  ).all(card.ownerName.trim(), card.ownerName.trim());
  return rows.length === 1 ? rows[0].email : null;
}

function cardLabelNames(card, boardLabels) {
  if (!Array.isArray(card.labels)) return [];
  const names = [];
  const seen = new Set();
  for (const labelId of card.labels) {
    if (typeof labelId !== 'string') continue;
    const label = boardLabels.get(labelId);
    if (!label) continue;
    const name = label.name.trim();
    const folded = name.toLocaleLowerCase('en-US');
    if (name && !seen.has(folded)) {
      seen.add(folded);
      names.push(name);
    }
  }
  return names;
}

function cardTicketInput(db, card, boardLabels, extras = []) {
  const title = cleanCardTitle(stripInvisible(typeof card.text === 'string' ? card.text : ''));
  const labels = cardLabelNames(card, boardLabels);
  const seen = new Set(labels.map((label) => label.toLocaleLowerCase('en-US')));
  for (const label of extras) {
    const folded = label.toLocaleLowerCase('en-US');
    if (!seen.has(folded)) { seen.add(folded); labels.push(label); }
  }
  if (labels.length > 20) throw limitExceeded('A card link can produce at most 20 ticket labels', 'labels');
  return {
    title,
    description: typeof card.desc === 'string' ? card.desc : '',
    assignee: memberAssignee(db, card),
    due: card.due ?? null,
    labels,
  };
}

function cardCreateIdempotencyKey(key, cardId) {
  return crypto.createHash('sha256').update(`${key}:${cardId}`).digest('base64url');
}

function makeTicketForCard({ directory, actor, db, boardId, kanbanId, lane, card, boardLabels, extraLabels = [], project, idempotencyKey: key, now }) {
  const input = cardTicketInput(db, card, boardLabels, extraLabels);
  const ticket = createTicket({
    directory, actor, title: input.title, description: input.description, state: lane.stateKey,
    assignee: input.assignee, labels: input.labels, due: input.due, project,
    source: 'tracker-link', idempotencyKey: cardCreateIdempotencyKey(key, card.id), now,
  });
  const info = actorInfo(actor);
  db.prepare(
    `INSERT INTO ticket_links
      (id, ticket_id, board_id, kanban_id, card_id, created_at, created_by_type, created_by_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(newId(), ticket.id, boardId, kanbanId, card.id, now, info.type, info.id);
  enqueueTicketProjection({ db, ticketId: ticket.id, eventSeq: ticket.updatedSeq, now });
  return getTicket({ directory, db, actor, key: ticket.key });
}

function cardAlreadyLinked(db, boardId, kanbanId, cardId) {
  return Boolean(db.prepare(
    `SELECT 1 FROM ticket_links WHERE board_id = ? AND kanban_id = ? AND card_id = ? AND removed_at IS NULL LIMIT 1`,
  ).get(boardId, kanbanId, cardId));
}

/** Link a board kanban and optionally make a ticket for every eligible existing card, atomically. */
export function linkKanban({
  directory, actor, boardId, kanbanId, mapping, createTickets = false, project, labels, idempotencyKey: rawKey,
  roomAccess, now = Date.now(),
} = {}) {
  const { boardId: boardKey, info } = boardFor(directory, actor, boardId, { write: true });
  const kanbanKey = id(kanbanId, 'kanbanId');
  const key = idempotencyKey(rawKey);
  if (typeof createTickets !== 'boolean') throw invalid('createTickets', 'Must be true or false');
  const db = getDb({ directory });
  const prior = db.prepare(
    `SELECT * FROM kanban_tracker_links WHERE board_id = ? AND created_by IS ? AND idempotency_key = ? ORDER BY created_at, id LIMIT 1`,
  ).get(boardKey, info.userId, key);
  if (prior) {
    if (prior.kanban_id !== kanbanKey) throw conflict('idempotencyKey was already used for another kanban', 'idempotencyKey');
    const stored = parseStoredResult(prior.idempotency_result_json);
    if (stored) return { ...stored, replayed: true };
    throw conflict('The idempotent link result is unavailable', 'idempotencyKey');
  }
  if (db.prepare('SELECT 1 FROM kanban_tracker_links WHERE board_id = ? AND kanban_id = ? AND removed_at IS NULL').get(boardKey, kanbanKey)) {
    throw conflict('This kanban is already linked', 'kanbanId');
  }
  const snapshot = boardSnapshot(roomAccess, boardKey, kanbanKey);
  const workflowId = workflowFor(db);
  const resolved = validatedMapping(db, snapshot.lanes, workflowId, mapping);
  const projectName = requestProject(db, project);
  const extraLabels = requestLabels(db, labels);

  const cardPlans = snapshot.cards.map((card) => {
    const lane = snapshot.lanes.find((item) => item.id === card.parent);
    const laneMapping = resolved.byLane.get(lane?.id);
    if (!laneMapping) return { card, reason: 'unmapped_lane' };
    if (cardAlreadyLinked(db, boardKey, kanbanKey, card.id) || card.extProvider === 'tabula' || card.tracker?.ticketId) {
      return { card, reason: 'already_linked', laneMapping };
    }
    const input = cardTicketInput(db, card, snapshot.labels, extraLabels);
    if (!input.title) return { card, reason: 'empty_title', laneMapping };
    return { card, laneMapping, input };
  });
  const eligible = cardPlans.filter((plan) => !plan.reason);
  if (createTickets && eligible.length > MAX_CREATE_CARDS) {
    throw limitExceeded(`At most ${MAX_CREATE_CARDS} cards can be linked with ticket creation at once`, 'createTickets');
  }
  const skipped = createTickets
    ? cardPlans.filter((plan) => plan.reason).map((plan) => ({ cardId: plan.card.id, reason: plan.reason }))
    : [];

  return directory.transaction(() => {
    if (db.prepare('SELECT 1 FROM kanban_tracker_links WHERE board_id = ? AND kanban_id = ? AND removed_at IS NULL').get(boardKey, kanbanKey)) {
      throw conflict('This kanban is already linked', 'kanbanId');
    }
    const linkId = newId();
    db.prepare(
      `INSERT INTO kanban_tracker_links
        (id, board_id, kanban_id, workflow_id, created_at, created_by, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(linkId, boardKey, kanbanKey, workflowId, now, info.userId, key);
    for (const pair of resolved.pairs) db.prepare(
      `INSERT INTO kanban_state_mappings (kanban_link_id, lane_id, state_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(linkId, pair.laneId, pair.stateId, now, now);

    const created = [];
    if (createTickets) {
      for (const plan of eligible) {
        const ticket = makeTicketForCard({
          directory, actor, db, boardId: boardKey, kanbanId: kanbanKey,
          lane: plan.laneMapping, card: plan.card, boardLabels: snapshot.labels,
          extraLabels, project: projectName, idempotencyKey: key, now,
        });
        created.push({ cardId: plan.card.id, ticket });
      }
    }
    const row = db.prepare('SELECT * FROM kanban_tracker_links WHERE id = ?').get(linkId);
    const result = {
      link: linkView(db, row, { cardCount: created.length }),
      created,
      skipped,
      projectionPending: true,
    };
    db.prepare('UPDATE kanban_tracker_links SET idempotency_result_json = ? WHERE id = ?').run(JSON.stringify(result), linkId);
    return result;
  });
}

/** Store the first response after its post-commit room projection attempt, so an idempotent retry replays it exactly. */
export function storeLinkIdempotencyResult({ directory, linkId, result } = {}) {
  directory.db.prepare('UPDATE kanban_tracker_links SET idempotency_result_json = ? WHERE id = ?')
    .run(JSON.stringify(result), linkId);
}

/** Soft-delete a link and durably queue cleanup for every projected card. */
export function unlinkKanban({ directory, actor, linkId, now = Date.now() } = {}) {
  const key = id(linkId, 'linkId');
  const db = getDb({ directory });
  const found = db.prepare('SELECT * FROM kanban_tracker_links WHERE id = ? AND removed_at IS NULL').get(key);
  if (!found) throw notFound('Kanban link not found');
  const { info } = boardFor(directory, actor, found.board_id, { write: true });
  const cardLinks = db.prepare(
    `SELECT id, ticket_id, board_id, kanban_id, card_id, last_projection_seq
       FROM ticket_links WHERE board_id = ? AND kanban_id = ? AND removed_at IS NULL ORDER BY card_id`,
  ).all(found.board_id, found.kanban_id);
  return directory.transaction(() => {
    const current = db.prepare('SELECT * FROM kanban_tracker_links WHERE id = ? AND removed_at IS NULL').get(key);
    if (!current) throw notFound('Kanban link not found');
    db.prepare('UPDATE kanban_tracker_links SET removed_at = ? WHERE id = ? AND removed_at IS NULL').run(now, key);
    db.prepare('UPDATE ticket_links SET removed_at = ? WHERE board_id = ? AND kanban_id = ? AND removed_at IS NULL')
      .run(now, current.board_id, current.kanban_id);
    for (const cardLink of cardLinks) enqueueTicketProjectionRemoval({ db, ticketLink: cardLink, now });
    const removed = db.prepare('SELECT * FROM kanban_tracker_links WHERE id = ?').get(key);
    return { link: linkView(db, removed, { cardCount: cardLinks.length }), unlinked: cardLinks.length, projectionPending: true, actorId: info.userId };
  });
}

/** List active links on a board. */
export function listLinks({ directory, actor, boardId, kanbanId } = {}) {
  const { boardId: boardKey } = boardFor(directory, actor, boardId);
  if (kanbanId !== undefined) id(kanbanId, 'kanbanId');
  const rows = directory.db.prepare(
    `SELECT * FROM kanban_tracker_links WHERE board_id = ? AND removed_at IS NULL
      AND (? IS NULL OR kanban_id = ?) ORDER BY created_at, id`,
  ).all(boardKey, kanbanId ?? null, kanbanId ?? null);
  return { links: rows.map((row) => linkView(directory.db, row)) };
}

function nextTicketKey(db) {
  const tracker = db.prepare('SELECT id, prefix FROM trackers ORDER BY created_at, id LIMIT 1').get();
  if (!tracker) throw new Error('Default tracker seed is missing');
  const counter = db.prepare('SELECT next_number FROM ticket_counters WHERE scope = ? AND prefix = ?').get(tracker.id, tracker.prefix);
  return `${tracker.prefix}-${counter?.next_number ?? 1}`;
}

/** Suggest lane mappings from exact names/keys first, then the To do/Doing/Done default stage mapping. */
export function suggestMapping({ directory, actor, boardId, kanbanId, roomAccess } = {}) {
  const { boardId: boardKey } = boardFor(directory, actor, boardId);
  const kanbanKey = id(kanbanId, 'kanbanId');
  if (directory.db.prepare('SELECT 1 FROM kanban_tracker_links WHERE board_id = ? AND kanban_id = ? AND removed_at IS NULL').get(boardKey, kanbanKey)) {
    throw conflict('This kanban is already linked', 'kanbanId');
  }
  const snapshot = boardSnapshot(roomAccess, boardKey, kanbanKey);
  const db = directory.db;
  const workflowId = workflowFor(db);
  const states = activeStates(db, workflowId);
  const used = new Set();
  const mapping = Object.create(null);
  const selected = new Map();
  const laneName = (lane) => cleanLaneName(stripInvisible(typeof lane.name === 'string' ? lane.name : '')).toLocaleLowerCase('en-US');

  for (const lane of snapshot.lanes) {
    const name = laneName(lane);
    const state = states.find((item) => !used.has(item.id)
      && (item.state_key.toLocaleLowerCase('en-US') === name || item.name.toLocaleLowerCase('en-US') === name));
    if (state) {
      used.add(state.id);
      mapping[lane.id] = state.state_key;
      selected.set(lane.id, state.state_key);
    }
  }
  const categoryForStage = { todo: 'unstarted', doing: 'started', done: 'completed' };
  for (const lane of snapshot.lanes) {
    if (selected.has(lane.id) || !Object.hasOwn(categoryForStage, lane.stage)) continue;
    const state = states.find((item) => !used.has(item.id) && item.category === categoryForStage[lane.stage]);
    if (!state) continue;
    used.add(state.id);
    mapping[lane.id] = state.state_key;
    selected.set(lane.id, state.state_key);
  }
  const stateNotMapped = states.filter((state) => !used.has(state.id)).map((state) => state.state_key);
  return {
    mapping,
    lanes: snapshot.lanes.map((lane) => ({
      laneId: lane.id,
      name: cleanLaneName(stripInvisible(typeof lane.name === 'string' ? lane.name : '')),
      stateKey: selected.get(lane.id) ?? null,
    })),
    stateNotMapped,
    nextKey: nextTicketKey(db),
    cardCount: snapshot.cards.length,
  };
}

function activeLink(directory, linkId) {
  const row = directory.db.prepare('SELECT * FROM kanban_tracker_links WHERE id = ? AND removed_at IS NULL').get(linkId);
  if (!row) throw notFound('Kanban link not found');
  return row;
}

function idempotentCardResult({ directory, actor, link, cardId, idempotencyKey: key }) {
  const info = actorInfo(actor);
  const row = directory.db.prepare(
    `SELECT t.key, t.id, e.idempotency_key, l.board_id, l.kanban_id, l.card_id
       FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id
       JOIN ticket_links l ON l.ticket_id = t.id
      WHERE e.source = 'tracker-card' AND e.actor_type = ? AND e.actor_id IS ?
        AND e.idempotency_key = ? AND e.event_type = 'created' ORDER BY e.id LIMIT 1`,
  ).get(info.type, info.id, key);
  if (!row) return null;
  if (row.board_id !== link.board_id || row.kanban_id !== link.kanban_id || row.card_id !== cardId) {
    throw conflict('idempotencyKey was already used for another card', 'idempotencyKey');
  }
  return { ticket: getTicket({ directory, actor, key: row.key }), cardId, replayed: true };
}

/** Create one ticket for a card added after linking. */
export function createTicketForCard({ directory, actor, linkId, cardId, idempotencyKey: rawKey, roomAccess, now = Date.now() } = {}) {
  const key = idempotencyKey(rawKey);
  const link = activeLink(directory, id(linkId, 'linkId'));
  const { info } = boardFor(directory, actor, link.board_id, { write: true });
  const cardKey = id(cardId, 'cardId');
  const replayed = idempotentCardResult({ directory, actor, link, cardId: cardKey, idempotencyKey: key });
  if (replayed) return replayed;
  const db = directory.db;
  if (cardAlreadyLinked(db, link.board_id, link.kanban_id, cardKey)) throw conflict('This card already has a ticket', 'cardId');
  const snapshot = boardSnapshot(roomAccess, link.board_id, link.kanban_id);
  const card = snapshot.cards.find((item) => item.id === cardKey);
  const lane = card ? snapshot.lanes.find((item) => item.id === card.parent) : null;
  if (!card || !lane) throw invalid('cardId', 'Must identify a card in this linked kanban');
  const laneMapping = db.prepare(
    `SELECT s.state_key FROM kanban_state_mappings m JOIN ticket_states s ON s.id = m.state_id
      WHERE m.kanban_link_id = ? AND m.lane_id = ? AND s.archived_at IS NULL`,
  ).get(link.id, lane.id);
  if (!laneMapping) throw invalid('cardId', 'The card lane is not mapped to a tracker state');
  const input = cardTicketInput(db, card, snapshot.labels);
  if (!input.title) throw invalid('cardId', 'The card needs a title before a ticket can be created');
  const ticket = directory.transaction(() => {
    const fresh = activeLink(directory, link.id);
    if (cardAlreadyLinked(db, fresh.board_id, fresh.kanban_id, cardKey)) throw conflict('This card already has a ticket', 'cardId');
    const created = createTicket({
      directory, actor, title: input.title, description: input.description, state: laneMapping.state_key,
      assignee: input.assignee, labels: input.labels, due: input.due,
      source: 'tracker-card', idempotencyKey: key, now,
    });
    db.prepare(
      `INSERT INTO ticket_links
        (id, ticket_id, board_id, kanban_id, card_id, created_at, created_by_type, created_by_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(newId(), created.id, fresh.board_id, fresh.kanban_id, cardKey, now, info.type, info.id);
    enqueueTicketProjection({ db, ticketId: created.id, eventSeq: created.updatedSeq, now });
    return getTicket({ directory, actor, key: created.key });
  });
  return { ticket, cardId: cardKey, replayed: false };
}
