import { ticketAccess, requireTicketRead, requireTicketWrite } from './access.mjs';
import { appendTicketEvent } from './events.mjs';
import { fanOut } from './notify.mjs';
import { allocateTicket } from './ids.mjs';
import { listTickets, refreshTicketSearch, searchTickets } from './search.mjs';
import {
  actorInfo, cleanText, codePointLength, conflict, forbidden, getDb, inTransaction, invalid, limitExceeded,
  newId, notFound, requireWritable, validCalendarDate,
} from './shared.mjs';

export const PRIORITIES = Object.freeze(['none', 'urgent', 'high', 'medium', 'low']);
const PRIORITY_VALUE = new Map(PRIORITIES.map((name, value) => [name, value]));
const TRACKER_TICKET = Object.freeze({ id: 'tracker-access-check' });

function requireTrackerRead(actor) {
  ticketAccess(actor, TRACKER_TICKET);
}

function requireTrackerWrite(actor) {
  if (ticketAccess(actor, TRACKER_TICKET) !== 'write') throw forbidden('This tracker is read-only for this actor.');
}

function ticketRow(db, reference) {
  if (typeof reference !== 'string' || !reference.trim()) return null;
  return db.prepare(
    `SELECT t.*, s.state_key, s.name AS state_name, s.category AS state_category
       FROM tickets t JOIN ticket_states s ON s.id = t.state_id
      WHERE t.key = ? COLLATE NOCASE OR t.id = ? LIMIT 1`,
  ).get(reference.trim(), reference.trim()) ?? null;
}

function labelRows(db, ticketId) {
  return db.prepare(
    `SELECT l.id, l.name, l.color FROM ticket_labels tl JOIN labels l ON l.id = tl.label_id
      WHERE tl.ticket_id = ? AND l.archived_at IS NULL ORDER BY l.name COLLATE NOCASE, l.id`,
  ).all(ticketId).map((row) => ({ id: row.id, name: row.name, color: row.color ?? null }));
}

function aliases(db, ticketId) {
  return db.prepare(
    'SELECT COALESCE(display_key, external_id) AS value FROM ticket_aliases WHERE ticket_id = ? ORDER BY provider, external_id',
  ).all(ticketId).map((row) => row.value);
}

function creatorInfo(db, row) {
  if (row.created_by_type === 'user') {
    const user = row.created_by_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(row.created_by_id) : null;
    return { type: 'user', id: row.created_by_id ?? null, name: user?.name ?? 'Former member' };
  }
  if (row.created_by_type === 'mcp_token') {
    const event = db.prepare("SELECT details_json FROM ticket_events WHERE ticket_id = ? AND event_type = 'created' ORDER BY id LIMIT 1").get(row.id);
    let ownerUserId = null;
    try { ownerUserId = JSON.parse(event?.details_json ?? '{}').ownerUserId ?? null; } catch { /* use generic label for legacy data */ }
    const owner = ownerUserId ? db.prepare('SELECT name FROM users WHERE id = ?').get(ownerUserId) : null;
    return { type: 'mcp_token', id: row.created_by_id ?? null, name: owner?.name ?? 'MCP token' };
  }
  return { type: 'system', id: row.created_by_id ?? null, name: 'System' };
}

function relationRows(db, actor, ticketId) {
  return db.prepare(
    `SELECT r.kind, r.ticket_id, r.related_ticket_id,
            source.key AS source_key, target.key AS target_key,
            source.id AS source_id, target.id AS target_id
       FROM ticket_relations r
       JOIN tickets source ON source.id = r.ticket_id
       JOIN tickets target ON target.id = r.related_ticket_id
      WHERE (r.ticket_id = ? OR r.related_ticket_id = ?)
        AND r.kind IN ('blocks', 'relates_to', 'duplicates')
      ORDER BY r.created_at, r.id`,
  ).all(ticketId, ticketId).flatMap((row) => {
    const currentIsSource = row.ticket_id === ticketId;
    const other = currentIsSource
      ? { id: row.target_id, key: row.target_key }
      : { id: row.source_id, key: row.source_key };
    try {
      ticketAccess(actor, { id: other.id });
    } catch {
      return [];
    }
    const kind = row.kind === 'relates_to'
      ? 'relates_to'
      : row.kind === 'blocks'
        ? (currentIsSource ? 'blocks' : 'blocked_by')
        : (currentIsSource ? 'duplicates' : 'duplicated_by');
    return [{ kind, key: other.key }];
  });
}

function ticketJson(db, row, actor) {
  const assignee = row.assignee_user_id
    ? db.prepare('SELECT name FROM users WHERE id = ?').get(row.assignee_user_id)
    : null;
  const parent = row.parent_ticket_id
    ? db.prepare('SELECT key FROM tickets WHERE id = ?').get(row.parent_ticket_id)
    : null;
  const project = row.project_id
    ? db.prepare('SELECT id, name FROM projects WHERE id = ?').get(row.project_id)
    : null;
  const milestone = row.milestone_id
    ? db.prepare('SELECT id, name, due_at FROM milestones WHERE id = ?').get(row.milestone_id)
    : null;
  return {
    id: row.id,
    key: row.key,
    trackerId: row.tracker_id,
    title: row.title,
    description: row.description,
    state: { id: row.state_id, key: row.state_key, name: row.state_name, category: row.state_category },
    priority: PRIORITIES[row.priority] ?? 'none',
    assignee: assignee ? { userId: row.assignee_user_id, name: assignee.name } : null,
    creator: creatorInfo(db, row),
    labels: labelRows(db, row.id),
    project: project ? { id: project.id, name: project.name } : null,
    milestone: milestone ? {
      id: milestone.id,
      name: milestone.name,
      due: milestone.due_at == null ? null : new Date(milestone.due_at).toISOString().slice(0, 10),
    } : null,
    estimate: row.estimate == null ? null : row.estimate,
    due: row.due_date ?? null,
    parent: parent?.key ?? null,
    relations: relationRows(db, actor, row.id),
    links: [],
    aliases: aliases(db, row.id),
    archivedAt: row.archived_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedSeq: row.updated_seq,
  };
}

function visibleRow(db, actor, reference) {
  const row = ticketRow(db, reference);
  requireTicketRead(actor, row);
  return row;
}

function idempotentTicket(db, actor, source, key) {
  if (key == null) return null;
  const info = actorInfo(actor);
  const row = db.prepare(
    `SELECT t.* FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id
      WHERE e.source = ? AND e.actor_type = ? AND e.actor_id IS ? AND e.idempotency_key = ? AND e.event_type = 'created'
      ORDER BY e.id LIMIT 1`,
  ).get(source, info.type, info.id, key);
  return row ?? null;
}

function validIdempotencyKey(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || codePointLength(value) < 8 || codePointLength(value) > 64) {
    throw invalid('idempotencyKey', 'Must be 8 to 64 characters');
  }
  return value;
}

/** Read-only check used by MCP dispatch so idempotent creates do not consume the create quota. */
/** @param {any} options */
export function findTicketByIdempotency({ directory, db: dbArg, actor, idempotencyKey, source = 'app' } = {}) {
  if (typeof idempotencyKey !== 'string' || codePointLength(idempotencyKey) < 8 || codePointLength(idempotencyKey) > 64) return false;
  const db = getDb({ directory, db: dbArg });
  return Boolean(idempotentTicket(db, actor, source, idempotencyKey));
}

function resolveAssignee(db, actor, value, path) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw invalid(path, 'Use "me", a member name, or an email address');
  const name = cleanText(value, { path, min: 1, max: 200 });
  const info = actorInfo(actor);
  if (name.toLowerCase() === 'me') {
    if (!info.userId) throw invalid(path, 'The current actor has no member account');
    const self = db.prepare("SELECT id FROM users WHERE id = ? AND role IN ('owner', 'admin', 'member') AND disabled = 0").get(info.userId);
    if (!self) throw invalid(path, 'The current actor is not an active workspace member');
    return self.id;
  }
  const matches = db.prepare(
    `SELECT id FROM users WHERE role IN ('owner', 'admin', 'member') AND disabled = 0
      AND (name = ? COLLATE NOCASE OR email = ? COLLATE NOCASE) ORDER BY id`,
  ).all(name, name);
  if (matches.length > 1) throw invalid(path, 'Member name is ambiguous; use an email address');
  if (matches.length === 1) return matches[0].id;
  if (db.prepare('SELECT 1 FROM users WHERE id = ?').get(name)) throw invalid(path, 'Pass a member name or email, not a user id');
  throw invalid(path, 'No active workspace member matches this name or email');
}

function resolveProject(db, value, path = 'project') {
  if (value === undefined || value === null) return null;
  const name = cleanText(value, { path, min: 1, max: 100 });
  const project = db.prepare('SELECT id, name FROM projects WHERE name = ? COLLATE NOCASE AND archived_at IS NULL').get(name);
  if (!project) throw invalid(path, 'No active project matches this name');
  return project;
}

function resolveMilestone(db, value, project, path = 'milestone') {
  if (value === undefined || value === null) return null;
  const name = cleanText(value, { path, min: 1, max: 100 });
  const matches = project
    ? db.prepare(
      `SELECT m.id, m.name, m.project_id, p.name AS project_name
         FROM milestones m JOIN projects p ON p.id = m.project_id
        WHERE m.project_id = ? AND m.name = ? COLLATE NOCASE
          AND m.archived_at IS NULL AND p.archived_at IS NULL`,
    ).all(project.id, name)
    : db.prepare(
      `SELECT m.id, m.name, m.project_id, p.name AS project_name
         FROM milestones m JOIN projects p ON p.id = m.project_id
        WHERE m.name = ? COLLATE NOCASE AND m.archived_at IS NULL AND p.archived_at IS NULL`,
    ).all(name);
  if (matches.length > 1) throw invalid(path, 'Milestone name is ambiguous; specify its project');
  if (matches.length === 1) return matches[0];
  throw invalid(path, project ? 'No active milestone in this project matches the name' : 'No active milestone matches this name');
}

function resolveProjectAndMilestone(db, projectValue, milestoneValue, { projectProvided = false, milestoneProvided = false } = {}) {
  let project = projectProvided ? resolveProject(db, projectValue) : null;
  let milestone = milestoneProvided ? resolveMilestone(db, milestoneValue, project) : null;
  if (milestone && !project) {
    project = db.prepare('SELECT id, name FROM projects WHERE id = ? AND archived_at IS NULL').get(milestone.project_id) ?? null;
    if (!project) throw invalid('milestone', 'Milestone project is archived or unavailable');
  }
  if (project && milestone && project.id !== milestone.project_id) {
    throw invalid('milestone', 'Milestone must belong to the selected project');
  }
  return { project, milestone };
}

function resolveLabels(db, values, path = 'labels') {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw invalid(path, 'Must be a list of label names');
  if (values.length > 20) throw limitExceeded('A ticket can have at most 20 labels', path);
  const names = values.map((value, index) => cleanText(value, { path: `${path}[${index}]`, min: 1, max: 64 }));
  const folded = new Set();
  const rows = [];
  names.forEach((name, index) => {
    const key = name.toLocaleLowerCase('en-US');
    if (folded.has(key)) throw invalid(`${path}[${index}]`, 'Label names must be unique');
    folded.add(key);
    const row = db.prepare('SELECT id, name, color FROM labels WHERE name = ? COLLATE NOCASE AND archived_at IS NULL').get(name);
    if (!row) throw invalid(`${path}[${index}]`, `Unknown label: ${name}`);
    rows.push(row);
  });
  return rows;
}

function resolveParent(db, reference, ticketId = null, path = 'parent') {
  if (reference === undefined || reference === null || reference === '') return null;
  if (typeof reference !== 'string') throw invalid(path, 'Use a ticket key');
  const key = cleanText(reference, { path, min: 1, max: 40 });
  const parent = db.prepare('SELECT id, key FROM tickets WHERE key = ? COLLATE NOCASE').get(key);
  if (!parent) throw invalid(path, 'No ticket matches this key');
  if (ticketId && parent.id === ticketId) throw invalid(path, 'A ticket cannot be its own parent');
  if (ticketId) {
    const cycle = db.prepare(
      `WITH RECURSIVE descendants(id) AS (
        SELECT id FROM tickets WHERE id = ?
        UNION ALL SELECT t.id FROM tickets t JOIN descendants d ON t.parent_ticket_id = d.id
      ) SELECT 1 FROM descendants WHERE id = ? LIMIT 1`,
    ).get(ticketId, parent.id);
    if (cycle) throw invalid(path, 'Parent would create a cycle');
  }
  return parent;
}

function priorityValue(value, path = 'priority') {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !PRIORITY_VALUE.has(value)) throw invalid(path, `Must be one of ${PRIORITIES.join(', ')}`);
  return PRIORITY_VALUE.get(value);
}

function dueValue(value, path = 'due') {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (!validCalendarDate(value)) throw invalid(path, 'Must be a calendar-valid YYYY-MM-DD date');
  return value;
}

function stateByReference(db, reference) {
  if (typeof reference !== 'string' || !reference.trim()) return null;
  return db.prepare(
    `SELECT id, state_key, name, category FROM ticket_states
      WHERE workflow_id = 'wf_default' AND archived_at IS NULL
        AND (state_key = ? COLLATE NOCASE OR name = ? COLLATE NOCASE)
      ORDER BY is_default DESC, position LIMIT 1`,
  ).get(reference.trim(), reference.trim()) ?? null;
}

/** @param {any} options */
export function createTicket({
  directory,
  db: dbArg,
  actor,
  title,
  description = '',
  state: stateReference,
  priority = 'none',
  assignee = null,
  labels = [],
  due = null,
  parent = null,
  project,
  milestone,
  idempotencyKey: rawKey = null,
  source = 'app',
  readOnly = () => false,
  now = Date.now(),
} = {}) {
  requireWritable(readOnly);
  requireTrackerWrite(actor);
  const db = getDb({ directory, db: dbArg });
  const idempotencyKey = validIdempotencyKey(rawKey);
  const prior = idempotentTicket(db, actor, source, idempotencyKey);
  if (prior) {
    requireTicketRead(actor, prior);
    return ticketJson(db, ticketRow(db, prior.id), actor);
  }
  const cleanTitle = cleanText(title, { path: 'title', min: 1, max: 200, singleLine: true });
  const cleanDescription = cleanText(description, { path: 'description', max: 20_000, trim: false });
  const priorityInt = priorityValue(priority);
  const assigneeUserId = resolveAssignee(db, actor, assignee, 'assignee');
  const labelRowsResolved = resolveLabels(db, labels);
  if (labelRowsResolved.length > 20) throw limitExceeded('A ticket can have at most 20 labels', 'labels');
  const dueDate = dueValue(due);
  const parentRow = resolveParent(db, parent);
  const associations = resolveProjectAndMilestone(db, project, milestone, {
    projectProvided: project !== undefined && project !== null,
    milestoneProvided: milestone !== undefined && milestone !== null,
  });
  const state = stateReference === undefined
    ? db.prepare("SELECT id, state_key FROM ticket_states WHERE workflow_id = 'wf_default' AND is_default = 1 AND archived_at IS NULL").get()
    : stateByReference(db, stateReference);
  if (!state) {
    if (stateReference !== undefined) throw invalid('state', 'No active workflow state matches this name or key');
    throw new Error('Default ticket state seed is missing');
  }
  const fieldValues = {
    title: cleanTitle,
    description: cleanDescription,
    state: state.state_key,
    priority: PRIORITIES[priorityInt],
    assignee: assigneeUserId,
    labels: labelRowsResolved.map((label) => label.name),
    due: dueDate,
    parent: parentRow?.key ?? null,
    project: associations.project?.id ?? null,
    milestone: associations.milestone?.id ?? null,
  };
  const allocated = allocateTicket({
    directory,
    db,
    actor,
    source,
    idempotencyKey,
    readOnly,
    now,
    fields: {
      title: cleanTitle,
      description: cleanDescription,
      stateId: state.id,
      priority: priorityInt,
      assigneeUserId,
      labels: labelRowsResolved,
      dueDate,
      parentTicketId: parentRow?.id ?? null,
      projectId: associations.project?.id ?? null,
      milestoneId: associations.milestone?.id ?? null,
      eventAfter: fieldValues,
    },
  });
  const row = ticketRow(db, allocated.ticketId ?? allocated.key);
  requireTicketRead(actor, row);
  return ticketJson(db, row, actor);
}

/** @param {any} options */
export function getTicket({ directory, db: dbArg, actor, key } = {}) {
  const db = getDb({ directory, db: dbArg });
  const row = visibleRow(db, actor, key);
  return ticketJson(db, row, actor);
}

/** Add list/detail counts with one query for the ticket ids in a page. */
/** @param {any} options */
export function addTicketRowExtras({ directory, db: dbArg, tickets = [] } = {}) {
  if (!Array.isArray(tickets) || !tickets.length) return tickets;
  const db = getDb({ directory, db: dbArg });
  const ids = [...new Set(tickets.map((ticket) => ticket?.id).filter((id) => typeof id === 'string' && id))];
  if (!ids.length) return tickets;
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT t.id,
            (SELECT COUNT(*) FROM ticket_comments c WHERE c.ticket_id = t.id AND c.deleted_at IS NULL) AS comment_count,
            (SELECT COUNT(*) FROM tickets child WHERE child.parent_ticket_id = t.id) AS sub_issue_count,
            (SELECT COUNT(*) FROM tickets child JOIN ticket_states state ON state.id = child.state_id
              WHERE child.parent_ticket_id = t.id AND state.category IN ('completed', 'canceled')) AS sub_issue_done,
            EXISTS (
              SELECT 1 FROM ticket_relations relation
              JOIN tickets blocker ON blocker.id = relation.ticket_id
              JOIN ticket_states state ON state.id = blocker.state_id
              WHERE relation.related_ticket_id = t.id AND relation.kind = 'blocks'
                AND state.category NOT IN ('completed', 'canceled')
            ) AS blocked
       FROM tickets t WHERE t.id IN (${placeholders})`,
  ).all(...ids);
  const byId = new Map(rows.map((row) => [row.id, {
    commentCount: Number(row.comment_count),
    subIssueCount: Number(row.sub_issue_count),
    subIssueDone: Number(row.sub_issue_done),
    blocked: Boolean(row.blocked),
    prs: null,
  }]));
  return tickets.map((ticket) => ({ ...ticket, ...byId.get(ticket.id) }));
}

export { listTickets, searchTickets };

function updateSql(db, ticketId, columns, now) {
  if (!columns.length) return;
  const assignments = columns.map((entry) => `${entry.column} = ?`).join(', ');
  db.prepare(`UPDATE tickets SET ${assignments}, updated_at = ? WHERE id = ?`)
    .run(...columns.map((entry) => entry.value), now, ticketId);
}

function currentLabelNames(db, ticketId) {
  return labelRows(db, ticketId).map((label) => label.name);
}

function currentFieldValue(db, row, field) {
  switch (field) {
    case 'title': return row.title;
    case 'description': return row.description;
    case 'priority': return PRIORITIES[row.priority] ?? 'none';
    case 'assignee': return row.assignee_user_id ?? null;
    case 'labels': return currentLabelNames(db, row.id);
    case 'due': return row.due_date ?? null;
    case 'parent': return row.parent_ticket_id ? db.prepare('SELECT key FROM tickets WHERE id = ?').get(row.parent_ticket_id)?.key ?? null : null;
    case 'project': return row.project_id ?? null;
    case 'milestone': return row.milestone_id ?? null;
    case 'archived': return row.archived_at !== null && row.archived_at !== undefined;
    default: return undefined;
  }
}

/** @param {any} options */
export function updateTicket({
  directory,
  db: dbArg,
  actor,
  key,
  patch,
  ifUpdatedSeq,
  source = 'app',
  readOnly = () => false,
  now = Date.now(),
  details = {},
} = {}) {
  requireWritable(readOnly);
  const db = getDb({ directory, db: dbArg });
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalid('patch', 'Must be an object');
  const allowed = new Set(['title', 'description', 'state', 'priority', 'assignee', 'labels', 'due', 'parent', 'archived', 'project', 'milestone']);
  for (const field of Object.keys(patch)) if (!allowed.has(field)) throw invalid(`patch.${field}`, 'Unsupported ticket field');
  if (patch.archived !== undefined && typeof patch.archived !== 'boolean') throw invalid('patch.archived', 'Must be true or false');
  if (ifUpdatedSeq !== undefined && (!Number.isInteger(ifUpdatedSeq) || ifUpdatedSeq < 0)) throw invalid('ifUpdatedSeq', 'Must be a non-negative event sequence');

  return inTransaction({ directory, db }, () => {
    const row = visibleRow(db, actor, key);
    requireTicketWrite(actor, row);
    const before = {};
    const after = {};
    const columns = [];
    const changed = [];
    const set = (field, column, value) => {
      const previous = currentFieldValue(db, row, field);
      if (Array.isArray(previous) && Array.isArray(value)
        ? previous.length === value.length && previous.every((item, i) => item.toLocaleLowerCase('en-US') === value[i].toLocaleLowerCase('en-US'))
        : previous === value) return;
      before[field] = previous;
      after[field] = value;
      changed.push(field);
      if (column) columns.push({ column, value });
    };

    if (patch.project !== undefined || patch.milestone !== undefined) {
      let projectRow = row.project_id
        ? db.prepare('SELECT id, name FROM projects WHERE id = ?').get(row.project_id) ?? null
        : null;
      let projectId = row.project_id ?? null;
      let milestoneId = row.milestone_id ?? null;
      const projectChangedByRequest = patch.project !== undefined;
      if (projectChangedByRequest) {
        projectRow = resolveProject(db, patch.project, 'patch.project');
        projectId = projectRow?.id ?? null;
      }
      if (patch.milestone !== undefined) {
        if (patch.milestone === null) {
          milestoneId = null;
        } else {
          const milestoneRow = resolveMilestone(db, patch.milestone, projectRow, 'patch.milestone');
          if (!projectRow) {
            projectRow = db.prepare('SELECT id, name FROM projects WHERE id = ? AND archived_at IS NULL').get(milestoneRow.project_id) ?? null;
            if (!projectRow) throw invalid('patch.milestone', 'Milestone project is archived or unavailable');
            projectId = projectRow.id;
          }
          milestoneId = milestoneRow.id;
        }
      } else if (projectChangedByRequest && milestoneId && projectId !== row.project_id) {
        if (!projectId || !db.prepare(
          'SELECT 1 FROM milestones WHERE id = ? AND project_id = ? AND archived_at IS NULL',
        ).get(milestoneId, projectId)) {
          throw invalid('patch.milestone', 'Set a milestone in the new project or clear the current milestone');
        }
      }
      if (projectId !== row.project_id) set('project', 'project_id', projectId);
      if (milestoneId !== row.milestone_id) set('milestone', 'milestone_id', milestoneId);
    }

    if (patch.title !== undefined) set('title', 'title', cleanText(patch.title, { path: 'patch.title', min: 1, max: 200, singleLine: true }));
    if (patch.description !== undefined) set('description', 'description', cleanText(patch.description, { path: 'patch.description', max: 20_000, trim: false }));
    if (patch.priority !== undefined) {
      const nextPriority = priorityValue(patch.priority, 'patch.priority');
      if (row.priority !== nextPriority) {
        before.priority = PRIORITIES[row.priority] ?? 'none';
        after.priority = PRIORITIES[nextPriority];
        changed.push('priority');
        columns.push({ column: 'priority', value: nextPriority });
      }
    }
    if (patch.state !== undefined) {
      if (row.archived_at !== null) throw conflict('Archived tickets cannot be transitioned', 'patch.state');
      const target = stateByReference(db, patch.state);
      if (!target) throw invalid('patch.state', 'No active workflow state matches this name or key');
      if (target.id !== row.state_id) {
        before.state = { id: row.state_id, key: row.state_key, name: row.state_name, category: row.state_category };
        after.state = { id: target.id, key: target.state_key, name: target.name, category: target.category };
        changed.push('state');
        columns.push({ column: 'state_id', value: target.id });
      }
    }
    if (patch.assignee !== undefined) set('assignee', 'assignee_user_id', resolveAssignee(db, actor, patch.assignee, 'patch.assignee'));
    if (patch.labels !== undefined) {
      const resolved = resolveLabels(db, patch.labels, 'patch.labels');
      const names = resolved.map((label) => label.name);
      const previous = currentLabelNames(db, row.id);
      if (!(previous.length === names.length && previous.every((name, index) => name.toLowerCase() === names[index].toLowerCase()))) {
        before.labels = previous;
        after.labels = names;
        changed.push('labels');
        columns.push({ column: '__labels', value: resolved });
      }
    }
    if (patch.due !== undefined) set('due', 'due_date', dueValue(patch.due, 'patch.due'));
    if (patch.parent !== undefined) {
      const parentRow = resolveParent(db, patch.parent, row.id, 'patch.parent');
      const oldParentKey = currentFieldValue(db, row, 'parent');
      const nextParentKey = parentRow?.key ?? null;
      if (oldParentKey !== nextParentKey) {
        before.parent = oldParentKey;
        after.parent = nextParentKey;
        changed.push('parent');
        columns.push({ column: 'parent_ticket_id', value: parentRow?.id ?? null });
      }
    }
    if (patch.archived !== undefined) {
      const wasArchived = row.archived_at !== null && row.archived_at !== undefined;
      if (patch.archived !== wasArchived) {
        before.archived = wasArchived;
        after.archived = patch.archived;
        changed.push('archived');
        columns.push({ column: 'archived_at', value: patch.archived ? now : null });
      }
    }
    if (!changed.length) return ticketJson(db, row, actor);
    if (ifUpdatedSeq !== undefined && row.updated_seq !== ifUpdatedSeq) {
      throw conflict(`Ticket changed since sequence ${ifUpdatedSeq}; current sequence is ${row.updated_seq}`, 'ifUpdatedSeq');
    }
    const realColumns = columns.filter((entry) => entry.column !== '__labels');
    updateSql(db, row.id, realColumns, now);
    const labelChange = columns.find((entry) => entry.column === '__labels');
    if (labelChange) {
      db.prepare('DELETE FROM ticket_labels WHERE ticket_id = ?').run(row.id);
      for (const label of labelChange.value) db.prepare('INSERT INTO ticket_labels (ticket_id, label_id, created_at) VALUES (?, ?, ?)').run(row.id, label.id, now);
    }
    const eventType = after.archived === true ? 'archived' : after.archived === false ? 'restored' : 'updated';
    const seq = appendTicketEvent({ db, ticketId: row.id, eventType, actor, source, createdAt: now, before, after, details });
    fanOut({ db, ticketId: row.id, eventId: seq, eventType, actor, createdAt: now });
    db.prepare('UPDATE tickets SET updated_seq = ? WHERE id = ?').run(seq, row.id);
    const info = actorInfo(actor);
    for (const field of changed) db.prepare(
      `INSERT INTO ticket_field_versions (ticket_id, field, event_seq, actor_type, actor_id)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(ticket_id, field) DO UPDATE SET
         event_seq = excluded.event_seq, actor_type = excluded.actor_type, actor_id = excluded.actor_id`,
    ).run(row.id, field, seq, info.type, info.id);
    refreshTicketSearch(db, row.id);
    return ticketJson(db, ticketRow(db, row.id), actor);
  });
}

/** @param {any} options */
export function transitionTicket({ directory, db: dbArg, actor, key, state: targetState, ifUpdatedSeq, source = 'app', readOnly = () => false, now = Date.now() } = {}) {
  requireWritable(readOnly);
  const db = getDb({ directory, db: dbArg });
  if (typeof targetState !== 'string' || !targetState.trim()) throw invalid('state', 'Must be a state name or key');
  if (ifUpdatedSeq !== undefined && (!Number.isInteger(ifUpdatedSeq) || ifUpdatedSeq < 0)) throw invalid('ifUpdatedSeq', 'Must be a non-negative event sequence');
  return inTransaction({ directory, db }, () => {
    const row = visibleRow(db, actor, key);
    requireTicketWrite(actor, row);
    if (row.archived_at !== null) throw conflict('Archived tickets cannot be transitioned');
    const target = stateByReference(db, targetState);
    if (!target) throw invalid('state', 'No active workflow state matches this name or key');
    if (target.id === row.state_id) return ticketJson(db, row, actor);
    if (ifUpdatedSeq !== undefined && row.updated_seq !== ifUpdatedSeq) {
      throw conflict(`Ticket changed since sequence ${ifUpdatedSeq}; current sequence is ${row.updated_seq}`, 'ifUpdatedSeq');
    }
    const before = { state: { id: row.state_id, key: row.state_key, name: row.state_name, category: row.state_category } };
    const after = { state: { id: target.id, key: target.state_key, name: target.name, category: target.category } };
    db.prepare('UPDATE tickets SET state_id = ?, updated_at = ? WHERE id = ?').run(target.id, now, row.id);
    const seq = appendTicketEvent({ db, ticketId: row.id, eventType: 'transitioned', actor, source, createdAt: now, before, after });
    fanOut({ db, ticketId: row.id, eventId: seq, eventType: 'transitioned', actor, createdAt: now });
    db.prepare('UPDATE tickets SET updated_seq = ? WHERE id = ?').run(seq, row.id);
    const info = actorInfo(actor);
    db.prepare(
      `INSERT INTO ticket_field_versions (ticket_id, field, event_seq, actor_type, actor_id) VALUES (?, 'state', ?, ?, ?)
       ON CONFLICT(ticket_id, field) DO UPDATE SET event_seq = excluded.event_seq, actor_type = excluded.actor_type, actor_id = excluded.actor_id`,
    ).run(row.id, seq, info.type, info.id);
    refreshTicketSearch(db, row.id);
    return ticketJson(db, ticketRow(db, row.id), actor);
  });
}

/** @param {any} options */
export function commentTicket({ directory, db: dbArg, actor, key, body, clientId: rawClientId = null, source = 'app', readOnly = () => false, now = Date.now() } = {}) {
  requireWritable(readOnly);
  const db = getDb({ directory, db: dbArg });
  const row = visibleRow(db, actor, key);
  requireTicketWrite(actor, row);
  if (row.archived_at !== null) throw conflict('Archived tickets cannot receive comments');
  if (rawClientId !== null && (typeof rawClientId !== 'string' || codePointLength(rawClientId) < 1 || codePointLength(rawClientId) > 128)) {
    throw invalid('clientId', 'Must be 1 to 128 characters');
  }
  const cleanBody = cleanText(body, { path: 'body', min: 1, max: 20_000, trim: false });
  if (!cleanBody.trim()) throw invalid('body', 'Comment cannot be empty');
  const info = actorInfo(actor);
  const author = info.userName ?? (info.userId ? db.prepare('SELECT name FROM users WHERE id = ?').get(info.userId)?.name : null) ?? 'Workspace member';
  const commentId = newId();
  const result = inTransaction({ directory, db }, () => {
    const fresh = ticketRow(db, row.id);
    requireTicketWrite(actor, fresh);
    if (fresh.archived_at !== null) throw conflict('Archived tickets cannot receive comments');
    const info = actorInfo(actor);
    if (rawClientId !== null) {
      const prior = db.prepare(
        `SELECT id, ticket_id, actor_type, actor_id, author_snapshot, body, created_at
           FROM ticket_comments WHERE actor_type = ? AND actor_id IS ? AND client_id = ?`,
      ).get(info.type, info.id, rawClientId);
      if (prior) {
        if (prior.ticket_id !== row.id) throw conflict('clientId was already used for another ticket', 'clientId');
        return { id: prior.id, ticketId: prior.ticket_id, actorType: prior.actor_type, actorId: prior.actor_id, author: prior.author_snapshot, body: prior.body, createdAt: prior.created_at, replayed: true };
      }
    }
    db.prepare(
      `INSERT INTO ticket_comments (id, ticket_id, actor_type, actor_id, author_snapshot, body, created_at, client_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(commentId, row.id, info.type, info.id, author, cleanBody, now, rawClientId);
    const seq = appendTicketEvent({
      db,
      ticketId: row.id,
      eventType: 'commented',
      actor,
      source,
      createdAt: now,
      details: { commentId, length: codePointLength(cleanBody) },
    });
    fanOut({ db, ticketId: row.id, eventId: seq, eventType: 'commented', actor, createdAt: now });
    db.prepare('UPDATE tickets SET updated_at = ?, updated_seq = ? WHERE id = ?').run(now, seq, row.id);
    refreshTicketSearch(db, row.id);
    return { id: commentId, ticketId: row.id, actorType: info.type, actorId: info.id, author, body: cleanBody, createdAt: now };
  });
  return result;
}

function commentRow(db, ticketId, commentId) {
  if (typeof commentId !== 'string' || !commentId.trim()) return null;
  return db.prepare(
    `SELECT id, ticket_id, actor_type, actor_id, author_snapshot, body, created_at, edited_at, deleted_at
       FROM ticket_comments WHERE id = ? AND ticket_id = ?`,
  ).get(commentId.trim(), ticketId) ?? null;
}

function commentResult(row) {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    author: row.author_snapshot,
    ...(row.deleted_at == null ? { body: row.body } : {}),
    createdAt: row.created_at,
    editedAt: row.edited_at ?? null,
    deletedAt: row.deleted_at ?? null,
    edited: row.edited_at != null,
    deleted: row.deleted_at != null,
  };
}

/** @param {any} options */
export function editTicketComment({ directory, db: dbArg, actor, key, commentId, body, source = 'app', readOnly = () => false, now = Date.now() } = {}) {
  requireWritable(readOnly);
  const db = getDb({ directory, db: dbArg });
  const ticket = visibleRow(db, actor, key);
  requireTicketWrite(actor, ticket);
  const cleanBody = cleanText(body, { path: 'body', min: 1, max: 20_000, trim: false });
  if (!cleanBody.trim()) throw invalid('body', 'Comment cannot be empty');
  const info = actorInfo(actor);
  return inTransaction({ directory, db }, () => {
    const freshTicket = ticketRow(db, ticket.id);
    requireTicketWrite(actor, freshTicket);
    const row = commentRow(db, ticket.id, commentId);
    if (!row) throw notFound('Comment not found', 'commentId');
    if (row.deleted_at != null) throw conflict('Deleted comments cannot be edited', 'commentId');
    if (row.actor_type !== info.type || row.actor_id !== info.id) throw forbidden('Only the comment author can edit it.');
    if (row.body === cleanBody) return commentResult(row);
    db.prepare('UPDATE ticket_comments SET body = ?, edited_at = ? WHERE id = ?').run(cleanBody, now, row.id);
    const seq = appendTicketEvent({
      db, ticketId: ticket.id, eventType: 'comment_edited', actor, source, createdAt: now,
      details: { commentId: row.id, length: codePointLength(cleanBody) },
    });
    db.prepare('UPDATE tickets SET updated_at = ?, updated_seq = ? WHERE id = ?').run(now, seq, ticket.id);
    refreshTicketSearch(db, ticket.id);
    return commentResult(commentRow(db, ticket.id, row.id));
  });
}

/** @param {any} options */
export function deleteTicketComment({ directory, db: dbArg, actor, key, commentId, source = 'app', readOnly = () => false, now = Date.now() } = {}) {
  requireWritable(readOnly);
  const db = getDb({ directory, db: dbArg });
  const ticket = visibleRow(db, actor, key);
  requireTicketWrite(actor, ticket);
  const info = actorInfo(actor);
  return inTransaction({ directory, db }, () => {
    const freshTicket = ticketRow(db, ticket.id);
    requireTicketWrite(actor, freshTicket);
    const row = commentRow(db, ticket.id, commentId);
    if (!row) throw notFound('Comment not found', 'commentId');
    if (row.actor_type !== info.type || row.actor_id !== info.id) {
      if (!['owner', 'admin'].includes(info.role)) throw forbidden('Only the comment author or a workspace owner or admin can delete it.');
    }
    if (row.deleted_at != null) return commentResult(row);
    db.prepare('UPDATE ticket_comments SET body = \'\', deleted_at = ? WHERE id = ?').run(now, row.id);
    const seq = appendTicketEvent({
      db, ticketId: ticket.id, eventType: 'comment_deleted', actor, source, createdAt: now,
      details: { commentId: row.id },
    });
    db.prepare('UPDATE tickets SET updated_at = ?, updated_seq = ? WHERE id = ?').run(now, seq, ticket.id);
    refreshTicketSearch(db, ticket.id);
    return commentResult(commentRow(db, ticket.id, row.id));
  });
}

/** @param {any} options */
export function listStates({ directory, db: dbArg, actor } = {}) {
  requireTrackerRead(actor);
  const db = getDb({ directory, db: dbArg });
  return db.prepare(
    `SELECT id, state_key AS key, name, category, position, is_default AS isDefault
       FROM ticket_states WHERE workflow_id = 'wf_default' AND archived_at IS NULL ORDER BY position, id`,
  ).all().map((row) => ({ ...row, isDefault: Boolean(row.isDefault) }));
}

/** @param {any} options */
export function listLabels({ directory, db: dbArg, actor } = {}) {
  requireTrackerRead(actor);
  const db = getDb({ directory, db: dbArg });
  return db.prepare('SELECT id, name, color, created_at AS createdAt FROM labels WHERE archived_at IS NULL ORDER BY name COLLATE NOCASE, id')
    .all().map((row) => ({ id: row.id, name: row.name, color: row.color ?? null, createdAt: row.createdAt }));
}

/** @param {any} options */
export function createLabel({ directory, db: dbArg, actor, name, color = null, readOnly = () => false, now = Date.now() } = {}) {
  requireWritable(readOnly);
  requireTrackerWrite(actor);
  const db = getDb({ directory, db: dbArg });
  const cleanName = cleanText(name, { path: 'name', min: 1, max: 64 });
  if (color !== null && (typeof color !== 'string' || !/^#[\da-fA-F]{6}$/.test(color))) throw invalid('color', 'Must be a six-digit hex color or null');
  return inTransaction({ directory, db }, () => {
    if (db.prepare('SELECT 1 FROM labels WHERE name = ? COLLATE NOCASE AND archived_at IS NULL').get(cleanName)) {
      throw conflict('A label with this name already exists', 'name');
    }
    const id = newId();
    const info = actorInfo(actor);
    db.prepare('INSERT INTO labels (id, name, color, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(id, cleanName, color, now, info.userId);
    return { id, name: cleanName, color, createdAt: now };
  });
}

export const TRACKER_LIMITS = Object.freeze({ titleCodePoints: 200, markdownCodePoints: 20_000, labelsPerTicket: 20, priorities: PRIORITIES });
