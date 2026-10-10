import { ticketAccess } from './access.mjs';
import { OpsError, actorInfo, newId } from './shared.mjs';
import {
  addTicketRowExtras, commentTicket, createLabel, createTicket, deleteTicketComment, editTicketComment, findTicketByIdempotency,
  getTicket, listLabels, listStates, listTickets, searchTickets, transitionTicket, updateTicket,
} from './tickets.mjs';
import { isSubscribed, subscribeTicket, unsubscribeTicket } from './subscriptions.mjs';
import { relateTickets } from './relations.mjs';
import { createMilestone, createProject, listMilestones, listProjects, updateMilestone, updateProject } from './projects.mjs';
import { createSavedView, deleteSavedView, getSavedView, listSavedViews, updateSavedView } from './views.mjs';

const ACCESS_CHECK = Object.freeze({ id: 'tracker-access-check' });
const COMMENT_PAGE = 50;
const EVENT_PAGE = 50;
const MAX_DETAIL_PAGE = 100;

const actorFor = (user) => ({ type: 'user', userId: user.id, user });
const querySingle = (query, name) => {
  const values = query.getAll(name);
  if (values.length > 1) throw new OpsError('invalid_input', 'Must be supplied once', name);
  return values[0];
};

function allowFields(body, allowed) {
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new OpsError('invalid_input', 'Unsupported field', key);
  }
}

function positiveLimit(query, fallback = 20, max = 50) {
  const raw = querySingle(query, 'limit');
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new OpsError('invalid_input', `Must be 1 to ${max}`, 'limit');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new OpsError('invalid_input', `Must be 1 to ${max}`, 'limit');
  }
  if (value > max) throw new OpsError('limit_exceeded', `Must be 1 to ${max}`, 'limit');
  return value;
}

function integerQuery(query, name) {
  const raw = querySingle(query, name);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new OpsError('invalid_input', 'Must be a non-negative whole number', name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new OpsError('invalid_input', 'Must be a non-negative whole number', name);
  return value;
}

function ticketReference(directory, value) {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > 128) {
    throw new OpsError('invalid_input', 'Must be a ticket key or alias', 'key');
  }
  const key = value.trim();
  const direct = directory.db.prepare('SELECT key FROM tickets WHERE key = ? COLLATE NOCASE').get(key);
  if (direct) return { key: direct.key };
  const alias = directory.db.prepare(
    `SELECT t.key FROM ticket_aliases a JOIN tickets t ON t.id = a.ticket_id
      WHERE lower(a.external_id) = lower(?) OR lower(COALESCE(a.display_key, '')) = lower(?)
      ORDER BY a.provider, a.external_id LIMIT 1`,
  ).get(key, key);
  if (!alias) throw new OpsError('not_found', 'Ticket not found');
  return { key: alias.key, resolvedKey: alias.key };
}

function knownTicketId(directory, value) {
  const direct = directory.db.prepare('SELECT id FROM tickets WHERE key = ? COLLATE NOCASE').get(value);
  if (direct) return direct.id;
  return directory.db.prepare(
    `SELECT t.id FROM ticket_aliases a JOIN tickets t ON t.id = a.ticket_id
      WHERE lower(a.external_id) = lower(?) OR lower(COALESCE(a.display_key, '')) = lower(?)
      ORDER BY a.provider, a.external_id LIMIT 1`,
  ).get(value, value)?.id ?? null;
}

function commentActorType(value) {
  if (value === 'mcp_token') return 'agent';
  return ['user', 'integration', 'import', 'system'].includes(value) ? value : 'system';
}

function commentView(row) {
  const deleted = row.deletedAt != null || row.deleted_at != null;
  const editedAt = row.editedAt ?? row.edited_at;
  return {
    id: row.id,
    author: row.author,
    ...(deleted ? {} : { body: row.body }),
    createdAt: row.createdAt ?? row.created_at,
    edited: editedAt != null,
    deleted,
    actorType: commentActorType(row.actorType ?? row.actor_type),
  };
}

function parseJson(value) {
  try { return value == null ? null : JSON.parse(value); } catch { return null; }
}

function eventView(row) {
  return {
    eventSeq: row.id,
    eventType: row.event_type,
    schemaVersion: row.schema_version,
    actor: { type: row.actor_type, id: row.actor_id },
    source: row.source,
    createdAt: row.created_at,
    before: parseJson(row.before_json),
    after: parseJson(row.after_json),
    details: parseJson(row.details_json),
  };
}

function commentPage(directory, ticketId, { before, limit = COMMENT_PAGE } = {}) {
  const db = directory.db;
  let beforeRow = null;
  if (before !== undefined) {
    if (typeof before !== 'string' || !before || before.length > 128) {
      throw new OpsError('invalid_input', 'Must be a comment id', 'before');
    }
    beforeRow = db.prepare(
      'SELECT id, created_at FROM ticket_comments WHERE id = ? AND ticket_id = ?',
    ).get(before, ticketId);
    if (!beforeRow) throw new OpsError('invalid_input', 'Must identify a comment on this ticket', 'before');
  }
  const rows = db.prepare(
    `SELECT id, author_snapshot AS author, body, actor_type AS actorType, created_at AS createdAt,
            edited_at AS editedAt, deleted_at AS deletedAt FROM ticket_comments
      WHERE ticket_id = ?
        AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
      ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(ticketId, beforeRow?.created_at ?? null, beforeRow?.created_at ?? null, beforeRow?.created_at ?? null, beforeRow?.id ?? null, limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const nextBefore = hasMore ? page.at(-1)?.id ?? null : null;
  return {
    items: page.reverse().map(commentView),
    nextBefore,
  };
}

function eventPage(directory, ticketId, { before, limit = EVENT_PAGE } = {}) {
  const db = directory.db;
  let beforeId = null;
  if (before !== undefined) {
    if (!/^\d+$/.test(before)) throw new OpsError('invalid_input', 'Must be an event id', 'before');
    beforeId = Number(before);
    if (!Number.isSafeInteger(beforeId) || beforeId < 1) throw new OpsError('invalid_input', 'Must be an event id', 'before');
    if (!db.prepare('SELECT 1 FROM ticket_events WHERE id = ? AND ticket_id = ?').get(beforeId, ticketId)) {
      throw new OpsError('invalid_input', 'Must identify an event on this ticket', 'before');
    }
  }
  const rows = db.prepare(
    `SELECT id, event_type, schema_version, actor_type, actor_id, source, created_at,
            before_json, after_json, details_json FROM ticket_events
      WHERE ticket_id = ? AND (? IS NULL OR id < ?)
      ORDER BY id DESC LIMIT ?`,
  ).all(ticketId, beforeId, beforeId, limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const nextBefore = hasMore ? String(page.at(-1)?.id ?? '') || null : null;
  return {
    items: page.reverse().map(eventView),
    nextBefore,
  };
}

function assigneeForId(directory, value, path = 'assigneeId') {
  if (value === null) return null;
  if (typeof value !== 'string' || !value) throw new OpsError('invalid_input', 'Must be an active workspace member id or null', path);
  const member = directory.db.prepare(
    "SELECT email FROM users WHERE id = ? AND role IN ('owner', 'admin', 'member') AND disabled = 0",
  ).get(value);
  if (!member) throw new OpsError('invalid_input', 'Must identify an active workspace member', path);
  return member.email;
}

function normalizeAssignee(directory, body, path = '') {
  const hasName = Object.hasOwn(body, 'assignee');
  const hasId = Object.hasOwn(body, 'assigneeId');
  if (hasName && hasId) throw new OpsError('invalid_input', 'Use either assignee or assigneeId, not both', `${path}assigneeId`);
  const normalized = { ...body };
  if (hasId) {
    normalized.assignee = assigneeForId(directory, body.assigneeId, `${path}assigneeId`);
    delete normalized.assigneeId;
  }
  return normalized;
}

function initials(name) {
  const parts = String(name ?? '').trim().split(/\s+/u).filter(Boolean);
  if (!parts.length) return '?';
  const raw = parts.length === 1 ? Array.from(parts[0])[0] : `${Array.from(parts[0])[0]}${Array.from(parts.at(-1))[0]}`;
  return Array.from(raw.toLocaleUpperCase()).slice(0, 2).join('');
}

function actorName(db, row) {
  if (row.actor_type === 'user') {
    return db.prepare('SELECT name FROM users WHERE id = ?').get(row.actor_id)?.name ?? 'Former member';
  }
  if (row.actor_type === 'mcp_token') {
    const ownerUserId = parseJson(row.details_json)?.ownerUserId;
    return ownerUserId ? db.prepare('SELECT name FROM users WHERE id = ?').get(ownerUserId)?.name ?? 'MCP token' : 'MCP token';
  }
  if (row.actor_type === 'system') return 'System';
  return 'Integration';
}

function withCurrentTicketOnConflict(directory, actor, key, action) {
  try {
    return action();
  } catch (error) {
    if (error instanceof OpsError && error.code === 'conflict') {
      try {
        error.ticket = addTicketRowExtras({ directory, tickets: [getTicket({ directory, actor, key })] })[0];
      } catch { /* keep the original conflict */ }
    }
    throw error;
  }
}

function pageWithExtras(directory, tickets) {
  return addTicketRowExtras({ directory, tickets });
}

function ownerForSession(directory, value, path = 'ownerId') {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !value.trim()) throw new OpsError('invalid_input', 'Must be an active member id or "me"', path);
  if (value.trim().toLowerCase() === 'me') return 'me';
  const owner = directory.db.prepare(
    "SELECT email FROM users WHERE id = ? AND role IN ('owner', 'admin', 'member') AND disabled = 0",
  ).get(value.trim());
  if (!owner) throw new OpsError('invalid_input', 'Must identify an active workspace member', path);
  return owner.email;
}

function countsForResources(directory, rows, field) {
  if (!rows.length) return new Map();
  const column = field === 'project' ? 'project_id' : 'milestone_id';
  const ids = [...new Set(rows.map((row) => row.id))];
  const placeholders = ids.map(() => '?').join(', ');
  const counts = directory.db.prepare(
    `SELECT t.${column} AS resource_id, COUNT(*) AS ticket_count,
            SUM(CASE WHEN state.category IN ('completed', 'canceled') THEN 1 ELSE 0 END) AS done_count
       FROM tickets t JOIN ticket_states state ON state.id = t.state_id
      WHERE t.${column} IN (${placeholders}) GROUP BY t.${column}`,
  ).all(...ids);
  return new Map(counts.map((row) => [row.resource_id, {
    ticketCount: Number(row.ticket_count),
    doneCount: Number(row.done_count),
  }]));
}

function projectWithCounts(directory, project) {
  const counts = countsForResources(directory, [project], 'project').get(project.id) ?? { ticketCount: 0, doneCount: 0 };
  return { ...project, ...counts };
}

function milestoneWithCounts(directory, milestone) {
  const counts = countsForResources(directory, [milestone], 'milestone').get(milestone.id) ?? { ticketCount: 0, doneCount: 0 };
  return { ...milestone, ...counts };
}

function viewsForApi(directory, actor) {
  const views = listSavedViews({ directory, actor });
  if (!views.length) return [];
  const ownerIds = [...new Set(views.map((view) => view.ownerUserId).filter(Boolean))];
  const placeholders = ownerIds.map(() => '?').join(', ');
  const names = ownerIds.length
    ? directory.db.prepare(`SELECT id, name FROM users WHERE id IN (${placeholders})`).all(...ownerIds)
    : [];
  const byId = new Map(names.map((row) => [row.id, row.name]));
  const userId = actorInfo(actor).userId;
  return views.map((view) => ({
    ...view,
    owner: { userId: view.ownerUserId, name: byId.get(view.ownerUserId) ?? 'Former member' },
    ownerName: byId.get(view.ownerUserId) ?? 'Former member',
    mine: view.ownerUserId === userId,
  }));
}

function errorShape(error) {
  return {
    error: error.code,
    message: error.message,
    ...(error.path ? { path: error.path } : {}),
  };
}

function normalizedNames(values, path) {
  if (!Array.isArray(values)) throw new OpsError('invalid_input', 'Must be a list of label names', path);
  if (values.length > 20) throw new OpsError('limit_exceeded', 'A ticket can have at most 20 labels', path);
  const output = [];
  const seen = new Set();
  values.forEach((value, index) => {
    if (typeof value !== 'string' || !value.trim()) throw new OpsError('invalid_input', 'Must be a label name', `${path}[${index}]`);
    const name = value.trim();
    const folded = name.toLocaleLowerCase('en-US');
    if (seen.has(folded)) throw new OpsError('invalid_input', 'Label names must be unique', `${path}[${index}]`);
    seen.add(folded);
    output.push(name);
  });
  return output;
}

function feedEvents(directory, actor, since) {
  const db = directory.db;
  const seq = Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS seq FROM ticket_events').get().seq);
  if (since === undefined || since === 0) return { events: [], seq };

  const events = [];
  let cursor = since;
  while (events.length < 201) {
    const rows = db.prepare(
      `SELECT e.id, e.ticket_id, e.event_type, e.actor_type, e.actor_id, e.created_at,
              e.details_json, t.key AS ticket_key
         FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id
        WHERE e.id > ? ORDER BY e.id LIMIT 256`,
    ).all(cursor);
    if (!rows.length) break;
    for (const row of rows) {
      cursor = Number(row.id);
      try {
        ticketAccess(actor, { id: row.ticket_id });
      } catch {
        continue;
      }
      events.push({
        id: Number(row.id),
        ticketKey: row.ticket_key,
        eventType: row.event_type,
        at: row.created_at,
        actor: { type: row.actor_type, id: row.actor_id, name: actorName(db, row) },
      });
      if (events.length >= 201) break;
    }
    if (rows.length < 256) break;
  }
  return { events: events.slice(0, 200), seq };
}

/** @param {any} options */
export function createTrackerRoutes({ directory, compile, audit, cloud = null, now = Date.now } = {}) {
  const currentReadOnly = () => cloud?.limits().readOnly === true;
  const routes = [];

  routes.push(compile('GET', 'tracker/meta', { tracker: true }, ({ user }) => {
    const actor = actorFor(user);
    const tracker = directory.db.prepare('SELECT id, prefix FROM trackers ORDER BY created_at, id LIMIT 1').get();
    const states = listStates({ directory, actor }).map(({ id, key, name, category, position }) => ({ id, key, name, category, position }));
    const labels = listLabels({ directory, actor }).map(({ id, name, color }) => ({ id, name, color }));
    const members = directory.db.prepare(
      "SELECT id, name FROM users WHERE role IN ('owner', 'admin', 'member') AND disabled = 0 ORDER BY name COLLATE NOCASE, id",
    ).all().map((member) => ({ userId: member.id, name: member.name, initials: initials(member.name) }));
    const canWrite = ticketAccess(actor, ACCESS_CHECK) === 'write' && !currentReadOnly();
    const projects = listProjects({ directory, actor }).map(({ id, name, state }) => ({ id, name, state }));
    const milestones = directory.db.prepare(
      `SELECT m.id, m.name, m.project_id, m.due_at FROM milestones m
       JOIN projects p ON p.id = m.project_id
       WHERE m.archived_at IS NULL AND p.archived_at IS NULL
       ORDER BY p.name COLLATE NOCASE, m.due_at, m.name COLLATE NOCASE, m.id`,
    ).all().map((milestone) => ({
      id: milestone.id,
      name: milestone.name,
      projectId: milestone.project_id,
      due: milestone.due_at == null ? null : new Date(milestone.due_at).toISOString().slice(0, 10),
    }));
    return [200, {
      enabled: true,
      trackerId: tracker?.id ?? null,
      prefix: tracker?.prefix ?? null,
      states,
      labels,
      members,
      projects,
      milestones,
      views: viewsForApi(directory, actor).map(({ id, name, shared, mine }) => ({ id, name, shared, mine })),
      me: { userId: user.id, canWrite, canCreate: canWrite },
    }];
  }));

  routes.push(compile('GET', 'tracker/labels', { tracker: true }, ({ user }) => [200, {
    labels: listLabels({ directory, actor: actorFor(user) }),
  }]));

  routes.push(compile('POST', 'tracker/labels', { tracker: true, trackerMutation: true, body: true }, ({ user, body }) => {
    allowFields(body, new Set(['name', 'color']));
    const actor = actorFor(user);
    const label = directory.transaction(() => {
      const created = createLabel({ directory, actor, name: body.name, color: body.color, readOnly: currentReadOnly, now: now() });
      audit(user, 'tracker.label.create', { labelId: created.id });
      return created;
    });
    return [201, { label }];
  }));

  routes.push(compile('GET', 'tracker/projects', { tracker: true }, ({ user, query }) => {
    const archived = querySingle(query, 'archived');
    if (archived !== undefined && archived !== '0' && archived !== '1') {
      throw new OpsError('invalid_input', 'Must be 0 or 1', 'archived');
    }
    const projects = listProjects({ directory, actor: actorFor(user), includeArchived: archived === '1' });
    const counts = countsForResources(directory, projects, 'project');
    return [200, { projects: projects.map((project) => ({ ...project, ...(counts.get(project.id) ?? { ticketCount: 0, doneCount: 0 }) })) }];
  }));

  routes.push(compile('POST', 'tracker/projects', { tracker: true, trackerMutation: true, body: true }, ({ user, body }) => {
    allowFields(body, new Set(['name', 'description', 'state', 'ownerId']));
    const actor = actorFor(user);
    const project = directory.transaction(() => {
      const created = createProject({
        directory, actor, name: body.name, description: body.description, state: body.state,
        owner: ownerForSession(directory, body.ownerId), readOnly: currentReadOnly, now: now(),
      });
      audit(user, 'tracker.project.create', { projectId: created.id });
      return created;
    });
    return [201, { project: projectWithCounts(directory, project) }];
  }));

  routes.push(compile('GET', 'tracker/projects/:id', { tracker: true }, ({ user, params }) => {
    const actor = actorFor(user);
    const project = listProjects({ directory, actor, includeArchived: true }).find((item) => item.id === params.id);
    if (!project) throw new OpsError('not_found', 'Project not found', 'projectId');
    return [200, { project: projectWithCounts(directory, project) }];
  }));

  routes.push(compile('PATCH', 'tracker/projects/:id', { tracker: true, trackerMutation: true, body: true }, ({ user, params, body }) => {
    allowFields(body, new Set(['name', 'description', 'state', 'ownerId', 'archived']));
    const patch = Object.fromEntries(['name', 'description', 'state', 'archived']
      .filter((field) => Object.hasOwn(body, field)).map((field) => [field, body[field]]));
    if (Object.hasOwn(body, 'ownerId')) patch.owner = ownerForSession(directory, body.ownerId, 'ownerId');
    const actor = actorFor(user);
    const project = directory.transaction(() => {
      const changed = updateProject({ directory, actor, projectId: params.id, patch, readOnly: currentReadOnly, now: now() });
      audit(user, 'tracker.project.update', { projectId: changed.id });
      return changed;
    });
    return [200, { project: projectWithCounts(directory, project) }];
  }));

  routes.push(compile('GET', 'tracker/projects/:id/milestones', { tracker: true }, ({ user, params }) => {
    const milestones = listMilestones({ directory, actor: actorFor(user), projectId: params.id });
    const counts = countsForResources(directory, milestones, 'milestone');
    return [200, { milestones: milestones.map((milestone) => ({ ...milestone, ...(counts.get(milestone.id) ?? { ticketCount: 0, doneCount: 0 }) })) }];
  }));

  routes.push(compile('POST', 'tracker/projects/:id/milestones', { tracker: true, trackerMutation: true, body: true }, ({ user, params, body }) => {
    allowFields(body, new Set(['name', 'description', 'due', 'state']));
    const actor = actorFor(user);
    const milestone = directory.transaction(() => {
      const created = createMilestone({
        directory, actor, projectId: params.id, name: body.name, description: body.description,
        due: body.due, state: body.state, readOnly: currentReadOnly, now: now(),
      });
      audit(user, 'tracker.milestone.create', { milestoneId: created.id, projectId: created.projectId });
      return created;
    });
    return [201, { milestone: milestoneWithCounts(directory, milestone) }];
  }));

  routes.push(compile('PATCH', 'tracker/milestones/:id', { tracker: true, trackerMutation: true, body: true }, ({ user, params, body }) => {
    allowFields(body, new Set(['name', 'description', 'due', 'state', 'archived']));
    const patch = Object.fromEntries(['name', 'description', 'due', 'state', 'archived']
      .filter((field) => Object.hasOwn(body, field)).map((field) => [field, body[field]]));
    const actor = actorFor(user);
    const milestone = directory.transaction(() => {
      const changed = updateMilestone({ directory, actor, milestoneId: params.id, patch, readOnly: currentReadOnly, now: now() });
      audit(user, 'tracker.milestone.update', { milestoneId: changed.id, projectId: changed.projectId });
      return changed;
    });
    return [200, { milestone: milestoneWithCounts(directory, milestone) }];
  }));

  routes.push(compile('GET', 'tracker/views', { tracker: true }, ({ user }) => [200, {
    views: viewsForApi(directory, actorFor(user)),
  }]));

  routes.push(compile('POST', 'tracker/views', { tracker: true, trackerMutation: true, body: true }, ({ user, body }) => {
    allowFields(body, new Set(['name', 'filter', 'shared']));
    if (!Object.hasOwn(body, 'filter')) throw new OpsError('invalid_input', 'Must be a list of filter tokens', 'filter');
    const actor = actorFor(user);
    const view = directory.transaction(() => {
      const created = createSavedView({
        directory, actor, name: body.name, filter: body.filter, shared: body.shared ?? false,
        readOnly: currentReadOnly, now: now(),
      });
      audit(user, 'tracker.view.create', { viewId: created.id });
      return created;
    });
    return [201, { view: viewsForApi(directory, actor).find((item) => item.id === view.id) }];
  }));

  routes.push(compile('GET', 'tracker/views/:id/tickets', { tracker: true }, ({ user, params, query }) => {
    const actor = actorFor(user);
    const result = getSavedView({
      directory, actor, viewId: params.id, limit: positiveLimit(query), cursor: querySingle(query, 'cursor') ?? null, now: now(),
    });
    const view = viewsForApi(directory, actor).find((item) => item.id === params.id) ?? result.view;
    return [200, { tickets: pageWithExtras(directory, result.tickets), nextCursor: result.nextCursor, view }];
  }));

  routes.push(compile('PATCH', 'tracker/views/:id', { tracker: true, trackerMutation: true, body: true }, ({ user, params, body }) => {
    allowFields(body, new Set(['name', 'filter', 'shared']));
    const patch = Object.fromEntries(['name', 'filter', 'shared'].filter((field) => Object.hasOwn(body, field)).map((field) => [field, body[field]]));
    const actor = actorFor(user);
    const view = directory.transaction(() => {
      const changed = updateSavedView({ directory, actor, viewId: params.id, patch, readOnly: currentReadOnly, now: now() });
      audit(user, 'tracker.view.update', { viewId: changed.id });
      return changed;
    });
    return [200, { view: viewsForApi(directory, actor).find((item) => item.id === view.id) }];
  }));

  routes.push(compile('DELETE', 'tracker/views/:id', { tracker: true, trackerMutation: true }, ({ user, params }) => {
    const actor = actorFor(user);
    directory.transaction(() => {
      const deleted = deleteSavedView({ directory, actor, viewId: params.id, readOnly: currentReadOnly });
      audit(user, 'tracker.view.delete', { viewId: deleted.id });
    });
    return [204];
  }));

  routes.push(compile('GET', 'tracker/tickets', { tracker: true }, ({ user, query }) => {
    const actor = actorFor(user);
    const updatedSince = integerQuery(query, 'updatedSince');
    if (updatedSince !== undefined) {
      const seq = Number(directory.db.prepare('SELECT COALESCE(MAX(updated_seq), 0) AS seq FROM tickets').get().seq);
      const rows = directory.db.prepare(
        'SELECT key FROM tickets WHERE updated_seq > ? ORDER BY updated_seq, id LIMIT 201',
      ).all(updatedSince);
      const more = rows.length > 200;
      const tickets = pageWithExtras(directory, rows.slice(0, 200).map((row) => getTicket({ directory, actor, key: row.key })));
      return [200, { tickets, seq, ...(more ? { more: true } : {}) }];
    }
    const rawQuery = querySingle(query, 'q');
    const limit = positiveLimit(query);
    const cursor = querySingle(query, 'cursor') ?? null;
    const options = { directory, actor, filters: query.getAll('filter'), limit, cursor, now: now() };
    let result;
    try {
      result = rawQuery === undefined ? listTickets(options) : searchTickets({ ...options, query: rawQuery });
    } catch (error) {
      if (error instanceof OpsError && error.path === 'query') error.path = 'q';
      throw error;
    }
      return [200, { tickets: pageWithExtras(directory, result.entries), nextCursor: result.next }];
  }));

  routes.push(compile('POST', 'tracker/tickets', { tracker: true, trackerMutation: true, body: true }, ({ user, body }) => {
    allowFields(body, new Set(['title', 'description', 'state', 'priority', 'assignee', 'assigneeId', 'labels', 'due', 'parent', 'idempotencyKey']));
    if (typeof body.idempotencyKey !== 'string' || Array.from(body.idempotencyKey).length < 8 || Array.from(body.idempotencyKey).length > 64) {
      throw new OpsError('invalid_input', 'Must be 8 to 64 characters', 'idempotencyKey');
    }
    const input = normalizeAssignee(directory, body);
    const ticket = directory.transaction(() => {
      const replay = findTicketByIdempotency({ directory, actor: actorFor(user), idempotencyKey: body.idempotencyKey, source: 'api' });
      const created = createTicket({
        ...input, directory, actor: actorFor(user), source: 'api', readOnly: currentReadOnly, now: now(),
      });
      if (!replay) audit(user, 'tracker.ticket.create', { ticketId: created.id });
      return pageWithExtras(directory, [created])[0];
    });
    return [201, { ticket }];
  }));

  routes.push(compile('GET', 'tracker/tickets/:key', { tracker: true }, ({ user, params }) => {
    const actor = actorFor(user);
    const ref = ticketReference(directory, params.key);
    const ticket = pageWithExtras(directory, [getTicket({ directory, actor, key: ref.key })])[0];
    const comments = commentPage(directory, ticket.id).items;
    const events = eventPage(directory, ticket.id).items;
    return [200, {
      ticket,
      comments,
      events,
      subscribed: isSubscribed({ directory, actor, key: ticket.key }),
      ...(ref.resolvedKey ? { resolvedKey: ref.resolvedKey } : {}),
    }];
  }));

  routes.push(compile('GET', 'tracker/tickets/:key/comments', { tracker: true }, ({ user, params, query }) => {
    const actor = actorFor(user);
    const { key } = ticketReference(directory, params.key);
    const ticket = getTicket({ directory, actor, key });
    const page = commentPage(directory, ticket.id, { before: querySingle(query, 'before'), limit: positiveLimit(query, COMMENT_PAGE, MAX_DETAIL_PAGE) });
    return [200, { comments: page.items, nextBefore: page.nextBefore }];
  }));

  routes.push(compile('GET', 'tracker/tickets/:key/events', { tracker: true }, ({ user, params, query }) => {
    const actor = actorFor(user);
    const { key } = ticketReference(directory, params.key);
    const ticket = getTicket({ directory, actor, key });
    const page = eventPage(directory, ticket.id, { before: querySingle(query, 'before'), limit: positiveLimit(query, EVENT_PAGE, MAX_DETAIL_PAGE) });
    return [200, { events: page.items, nextBefore: page.nextBefore }];
  }));

  routes.push(compile('PATCH', 'tracker/tickets/:key', { tracker: true, trackerMutation: true, body: true }, ({ user, params, body }) => {
    const allowed = new Set(['title', 'description', 'state', 'priority', 'assignee', 'assigneeId', 'labels', 'due', 'parent', 'project', 'milestone', 'archived', 'ifUpdatedSeq']);
    allowFields(body, allowed);
    const normalized = normalizeAssignee(directory, body);
    const { key } = ticketReference(directory, params.key);
    const patch = Object.fromEntries(
      ['title', 'description', 'state', 'priority', 'assignee', 'labels', 'due', 'parent', 'project', 'milestone', 'archived']
        .filter((field) => Object.hasOwn(normalized, field)).map((field) => [field, normalized[field]]),
    );
    const actor = actorFor(user);
    const ticket = withCurrentTicketOnConflict(directory, actor, key, () => directory.transaction(() => {
        const updated = updateTicket({
          directory, actor, key, patch, ifUpdatedSeq: body.ifUpdatedSeq,
          source: 'api', readOnly: currentReadOnly, now: now(),
        });
        audit(user, 'tracker.ticket.update', { ticketId: updated.id });
        return pageWithExtras(directory, [updated])[0];
      }));
      return [200, { ticket }];
  }));

  routes.push(compile('POST', 'tracker/tickets/:key/transition', { tracker: true, trackerMutation: true, body: true }, ({ user, params, body }) => {
    allowFields(body, new Set(['state']));
    const { key } = ticketReference(directory, params.key);
    const actor = actorFor(user);
    const ticket = withCurrentTicketOnConflict(directory, actor, key, () => directory.transaction(() => {
      const changed = transitionTicket({ directory, actor, key, state: body.state, source: 'api', readOnly: currentReadOnly, now: now() });
      audit(user, 'tracker.ticket.transition', { ticketId: changed.id });
      return pageWithExtras(directory, [changed])[0];
    }));
    return [200, { ticket }];
  }));

  routes.push(compile('POST', 'tracker/tickets/:key/comments', { tracker: true, trackerMutation: true, body: true }, ({ user, params, body }) => {
    allowFields(body, new Set(['body', 'clientId']));
    const { key } = ticketReference(directory, params.key);
    const actor = actorFor(user);
    const result = withCurrentTicketOnConflict(directory, actor, key, () => directory.transaction(() => {
      const comment = commentTicket({ directory, actor, key, body: body.body, clientId: body.clientId, source: 'api', readOnly: currentReadOnly, now: now() });
      const ticket = getTicket({ directory, actor, key });
      if (!comment.replayed) audit(user, 'tracker.ticket.comment', { ticketId: ticket.id, commentId: comment.id });
      return {
        comment: commentView({
          id: comment.id, author: comment.author, body: comment.body, createdAt: comment.createdAt,
          actorType: comment.actorType, editedAt: null, deletedAt: null,
        }),
        ticket: pageWithExtras(directory, [ticket])[0],
      };
    }));
    return [201, result];
  }));

  routes.push(compile('PATCH', 'tracker/tickets/:key/comments/:id', { tracker: true, trackerMutation: true, body: true }, ({ user, params, body }) => {
    allowFields(body, new Set(['body']));
    const { key } = ticketReference(directory, params.key);
    const actor = actorFor(user);
    const result = withCurrentTicketOnConflict(directory, actor, key, () => directory.transaction(() => {
      const comment = editTicketComment({
        directory, actor, key, commentId: params.id, body: body.body,
        source: 'api', readOnly: currentReadOnly, now: now(),
      });
      const ticket = getTicket({ directory, actor, key });
      audit(user, 'tracker.ticket.comment.edit', { ticketId: ticket.id, commentId: comment.id });
      return { comment: commentView({
        id: comment.id, author: comment.author, body: comment.body, createdAt: comment.createdAt,
        actorType: comment.actorType, editedAt: comment.editedAt, deletedAt: comment.deletedAt,
      }), ticket: pageWithExtras(directory, [ticket])[0] };
    }));
    return [200, result];
  }));

  routes.push(compile('DELETE', 'tracker/tickets/:key/comments/:id', { tracker: true, trackerMutation: true }, ({ user, params }) => {
    const { key } = ticketReference(directory, params.key);
    const actor = actorFor(user);
    const result = withCurrentTicketOnConflict(directory, actor, key, () => directory.transaction(() => {
      const comment = deleteTicketComment({
        directory, actor, key, commentId: params.id, source: 'api', readOnly: currentReadOnly, now: now(),
      });
      const ticket = getTicket({ directory, actor, key });
      audit(user, 'tracker.ticket.comment.delete', { ticketId: ticket.id, commentId: comment.id });
      return { comment: commentView({
        id: comment.id, author: comment.author, body: comment.body, createdAt: comment.createdAt,
        actorType: comment.actorType, editedAt: comment.editedAt, deletedAt: comment.deletedAt,
      }), ticket: pageWithExtras(directory, [ticket])[0] };
    }));
    return [200, result];
  }));

  routes.push(compile('POST', 'tracker/tickets/:key/relations', { tracker: true, trackerMutation: true, body: true }, ({ user, params, body }) => {
    allowFields(body, new Set(['relation', 'otherKey']));
    if (typeof body.relation !== 'string') throw new OpsError('invalid_input', 'Must be a relation kind', 'relation');
    if (typeof body.otherKey !== 'string' || !body.otherKey.trim()) throw new OpsError('invalid_input', 'Must be a ticket key or alias', 'otherKey');
    const { key } = ticketReference(directory, params.key);
    const actor = actorFor(user);
    const result = withCurrentTicketOnConflict(directory, actor, key, () => directory.transaction(() => {
      const changed = relateTickets({
        directory, actor, key, relation: body.relation, otherKey: body.otherKey,
        source: 'api', readOnly: currentReadOnly, now: now(),
      });
      audit(user, 'tracker.ticket.relate', { ticketId: changed.ticket.id });
      return changed;
    }));
    return [200, { ticket: pageWithExtras(directory, [result.ticket])[0] }];
  }));

  routes.push(compile('DELETE', 'tracker/tickets/:key/relations', { tracker: true, trackerMutation: true, body: true }, ({ user, params, body, query }) => {
    allowFields(body, new Set(['relation', 'otherKey']));
    const queryRelation = querySingle(query, 'relation');
    const queryOtherKey = querySingle(query, 'otherKey');
    if (body.relation !== undefined && queryRelation !== undefined && body.relation !== queryRelation) {
      throw new OpsError('invalid_input', 'Body and query values must match', 'relation');
    }
    if (body.otherKey !== undefined && queryOtherKey !== undefined && body.otherKey !== queryOtherKey) {
      throw new OpsError('invalid_input', 'Body and query values must match', 'otherKey');
    }
    const relation = body.relation ?? queryRelation;
    const otherKey = body.otherKey ?? queryOtherKey;
    if (typeof relation !== 'string') throw new OpsError('invalid_input', 'Must be a relation kind', 'relation');
    if (typeof otherKey !== 'string' || !otherKey.trim()) throw new OpsError('invalid_input', 'Must be a ticket key or alias', 'otherKey');
    const { key } = ticketReference(directory, params.key);
    const actor = actorFor(user);
    const result = withCurrentTicketOnConflict(directory, actor, key, () => directory.transaction(() => {
      const changed = relateTickets({
        directory, actor, key, relation, otherKey, remove: true,
        source: 'api', readOnly: currentReadOnly, now: now(),
      });
      audit(user, 'tracker.ticket.unrelate', { ticketId: changed.ticket.id });
      return changed;
    }));
    return [200, { ticket: pageWithExtras(directory, [result.ticket])[0] }];
  }));

  routes.push(compile('POST', 'tracker/tickets/:key/archive', { tracker: true, trackerMutation: true }, ({ user, params }) => {
    const { key } = ticketReference(directory, params.key);
    const actor = actorFor(user);
    const ticket = withCurrentTicketOnConflict(directory, actor, key, () => directory.transaction(() => {
      const changed = updateTicket({ directory, actor, key, patch: { archived: true }, source: 'api', readOnly: currentReadOnly, now: now() });
      audit(user, 'tracker.ticket.archive', { ticketId: changed.id });
      return pageWithExtras(directory, [changed])[0];
    }));
    return [200, { ticket }];
  }));

  routes.push(compile('POST', 'tracker/tickets/:key/restore', { tracker: true, trackerMutation: true }, ({ user, params }) => {
    const { key } = ticketReference(directory, params.key);
    const actor = actorFor(user);
    const ticket = withCurrentTicketOnConflict(directory, actor, key, () => directory.transaction(() => {
      const changed = updateTicket({ directory, actor, key, patch: { archived: false }, source: 'api', readOnly: currentReadOnly, now: now() });
      audit(user, 'tracker.ticket.restore', { ticketId: changed.id });
      return pageWithExtras(directory, [changed])[0];
    }));
    return [200, { ticket }];
  }));

  routes.push(compile('POST', 'tracker/tickets/bulk', { tracker: true, trackerMutation: true, body: true }, ({ user, body }) => {
    allowFields(body, new Set(['keys', 'patch']));
    if (!Array.isArray(body.keys)) throw new OpsError('invalid_input', 'Must be a list of ticket keys', 'keys');
    if (body.keys.length > 50) throw new OpsError('limit_exceeded', 'A bulk update can include at most 50 tickets', 'keys');
    if (body.keys.some((key) => typeof key !== 'string' || !key.trim() || Array.from(key).length > 128)) {
      throw new OpsError('invalid_input', 'Each key must be a ticket key or alias', 'keys');
    }
    const seenKeys = new Set();
    const seenIds = new Set();
    for (const key of body.keys) {
      const folded = key.trim().toLocaleLowerCase('en-US');
      if (seenKeys.has(folded)) throw new OpsError('invalid_input', 'Ticket keys must be unique', 'keys');
      seenKeys.add(folded);
      const ticketId = knownTicketId(directory, key.trim());
      if (ticketId && seenIds.has(ticketId)) throw new OpsError('invalid_input', 'Ticket keys must be unique', 'keys');
      if (ticketId) seenIds.add(ticketId);
    }
    if (!body.patch || typeof body.patch !== 'object' || Array.isArray(body.patch)) {
      throw new OpsError('invalid_input', 'Must be an object', 'patch');
    }
    const allowed = new Set(['state', 'priority', 'assignee', 'assigneeId', 'labels', 'labelsAdd', 'labelsRemove', 'project', 'milestone', 'due', 'archived']);
    for (const field of Object.keys(body.patch)) {
      if (!allowed.has(field)) throw new OpsError('invalid_input', 'Unsupported field', `patch.${field}`);
    }
    if (Object.hasOwn(body.patch, 'assignee') && Object.hasOwn(body.patch, 'assigneeId')) {
      throw new OpsError('invalid_input', 'Use either assignee or assigneeId, not both', 'patch.assigneeId');
    }
    const rawPatch = { ...body.patch };
    if (Object.hasOwn(rawPatch, 'labels')) rawPatch.labels = normalizedNames(rawPatch.labels, 'patch.labels');
    if (Object.hasOwn(rawPatch, 'labelsAdd')) rawPatch.labelsAdd = normalizedNames(rawPatch.labelsAdd, 'patch.labelsAdd');
    if (Object.hasOwn(rawPatch, 'labelsRemove')) rawPatch.labelsRemove = normalizedNames(rawPatch.labelsRemove, 'patch.labelsRemove');
    const normalized = normalizeAssignee(directory, rawPatch, 'patch.');
    const patch = Object.fromEntries(Object.entries(normalized)
      .filter(([field]) => !['labelsAdd', 'labelsRemove'].includes(field)));
    const actor = actorFor(user);
    const batchId = newId();
    const results = [];
    for (const requestedKey of body.keys) {
      try {
        const result = directory.transaction(() => {
          const { key } = ticketReference(directory, requestedKey);
          const beforeTicket = getTicket({ directory, actor, key });
          const ticketPatch = { ...patch };
          if (Object.hasOwn(rawPatch, 'labels') || Object.hasOwn(rawPatch, 'labelsAdd') || Object.hasOwn(rawPatch, 'labelsRemove')) {
            let labels = Object.hasOwn(rawPatch, 'labels')
              ? [...rawPatch.labels]
              : beforeTicket.labels.map((label) => label.name);
            const names = new Map(labels.map((name) => [name.toLocaleLowerCase('en-US'), name]));
            for (const name of rawPatch.labelsAdd ?? []) names.set(name.toLocaleLowerCase('en-US'), name);
            for (const name of rawPatch.labelsRemove ?? []) names.delete(name.toLocaleLowerCase('en-US'));
            ticketPatch.labels = [...names.values()];
          }
          const updated = updateTicket({
            directory, actor, key, patch: ticketPatch, source: 'api', readOnly: currentReadOnly,
            now: now(), details: { batchId },
          });
          const before = {};
          if (Object.hasOwn(ticketPatch, 'state') && beforeTicket.state.key !== updated.state.key) before.state = beforeTicket.state.key;
          if (Object.hasOwn(ticketPatch, 'priority') && beforeTicket.priority !== updated.priority) before.priority = beforeTicket.priority;
          if (Object.hasOwn(ticketPatch, 'assignee') && beforeTicket.assignee?.userId !== updated.assignee?.userId) {
            before.assigneeId = beforeTicket.assignee?.userId ?? null;
          }
          if (Object.hasOwn(ticketPatch, 'labels') && JSON.stringify(beforeTicket.labels.map((label) => label.name)) !== JSON.stringify(updated.labels.map((label) => label.name))) {
            before.labels = beforeTicket.labels.map((label) => label.name);
          }
          if ((Object.hasOwn(ticketPatch, 'project') || Object.hasOwn(ticketPatch, 'milestone'))
            && beforeTicket.project?.id !== updated.project?.id) before.project = beforeTicket.project?.name ?? null;
          if ((Object.hasOwn(ticketPatch, 'project') || Object.hasOwn(ticketPatch, 'milestone'))
            && beforeTicket.milestone?.id !== updated.milestone?.id) before.milestone = beforeTicket.milestone?.name ?? null;
          if (Object.hasOwn(ticketPatch, 'due') && beforeTicket.due !== updated.due) before.due = beforeTicket.due;
          if (Object.hasOwn(ticketPatch, 'archived') && (beforeTicket.archivedAt != null) !== (updated.archivedAt != null)) before.archived = beforeTicket.archivedAt != null;
          if (Object.keys(before).length) audit(user, 'tracker.ticket.bulk', { batchId, ticketId: updated.id });
          return { ticket: pageWithExtras(directory, [updated])[0], before };
        });
        results.push({ key: requestedKey, ok: true, ticket: result.ticket, before: result.before });
      } catch (error) {
        if (!(error instanceof OpsError)) throw error;
        const failed = { key: requestedKey, ok: false, error: errorShape(error) };
        if (error.code === 'conflict') {
          try {
            const { key } = ticketReference(directory, requestedKey);
            failed.ticket = pageWithExtras(directory, [getTicket({ directory, actor, key })])[0];
          } catch { /* keep the conflict without exposing a ticket the actor cannot read */ }
        }
        results.push(failed);
      }
    }
    return [200, { batchId, results }];
  }));

  routes.push(compile('PUT', 'tracker/tickets/:key/subscription', { tracker: true, trackerMutation: true }, ({ user, params }) => {
    const { key } = ticketReference(directory, params.key);
    const actor = actorFor(user);
    const subscribed = directory.transaction(() => {
      const wasSubscribed = isSubscribed({ directory, actor, key });
      subscribeTicket({ directory, actor, key, now: now(), readOnly: currentReadOnly });
      if (!wasSubscribed) audit(user, 'tracker.ticket.subscribe', { ticketId: getTicket({ directory, actor, key }).id });
      return true;
    });
    return [200, { subscribed }];
  }));

  routes.push(compile('DELETE', 'tracker/tickets/:key/subscription', { tracker: true, trackerMutation: true }, ({ user, params }) => {
    const { key } = ticketReference(directory, params.key);
    const actor = actorFor(user);
    const subscribed = directory.transaction(() => {
      const wasSubscribed = isSubscribed({ directory, actor, key });
      unsubscribeTicket({ directory, actor, key, readOnly: currentReadOnly });
      if (wasSubscribed) audit(user, 'tracker.ticket.unsubscribe', { ticketId: getTicket({ directory, actor, key }).id });
      return false;
    });
    return [200, { subscribed }];
  }));

  routes.push(compile('GET', 'tracker/feed', { tracker: true }, ({ user, query }) => {
    const since = integerQuery(query, 'since');
    return [200, feedEvents(directory, actorFor(user), since)];
  }));

  return routes;
}
