import fs from 'node:fs';
import path from 'node:path';
import { appendTicketEvent } from './events.mjs';
import { requireTicketWrite } from './access.mjs';
import { allocateTicket } from './ids.mjs';
import { refreshTicketSearch } from './search.mjs';
import { actorInfo, getDb, inTransaction, newId, requireWritable, validCalendarDate } from './shared.mjs';

const SNAPSHOT_VERSION = 1;
const MAX_ISSUES = 100_000;
const MAX_COMMENTS = 1_000_000;
const MAX_RELATIONS = 1_000_000;
const MAX_LABELS = 10_000;
const MAX_TEXT = 20_000;
const MAX_TOTAL_TEXT_BYTES = 128 * 1024 * 1024;
const BATCH_SIZE = 100;
const TRACKER = Object.freeze({ id: 'tracker-access-check' });
const PRIORITY_NAME = Object.freeze({ 0: 'none', 1: 'urgent', 2: 'high', 3: 'medium', 4: 'low' });
const DEFAULT_STATE = Object.freeze({
  todo: { id: 'st_todo', name: 'To do', category: 'unstarted' },
  in_progress: { id: 'st_in_progress', name: 'In progress', category: 'started' },
  in_review: { id: 'st_in_review', name: 'In review', category: 'started' },
  done: { id: 'st_done', name: 'Done', category: 'completed' },
  cancelled: { id: 'st_cancelled', name: 'Cancelled', category: 'canceled' },
});
const UPDATE_FIELDS = new Set(['title', 'description', 'state', 'priority', 'assignee', 'labels', 'due']);
const FIELD_COLUMN = Object.freeze({ title: 'title', description: 'description', state: 'state_id', priority: 'priority', assignee: 'assignee_user_id', due: 'due_date' });

function fail(message, code = 'invalid_snapshot') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function cleanString(value, name, max, { nullable = false, trim = false } = {}) {
  if (value == null && nullable) return null;
  if (typeof value !== 'string') throw fail(`${name} must be text.`);
  const result = trim ? value.trim() : value;
  if (Array.from(result).length > max) throw fail(`${name} exceeds the supported size.`);
  return result;
}

function isoValue(value, name, nullable = true) {
  if ((value == null || value === '') && nullable) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw fail(`${name} must be an ISO timestamp.`);
  return new Date(Date.parse(value)).toISOString();
}

function idValue(value, name, nullable = false) {
  if (value == null && nullable) return null;
  if (typeof value !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu.test(value)) {
    throw fail(`${name} must be a UUID.`);
  }
  return value;
}

function normEmail(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLocaleLowerCase('en-US') : null;
}

function normName(value) {
  return String(value ?? '').trim().toLocaleLowerCase('en-US');
}

function normalizeLabels(value) {
  if (!Array.isArray(value)) throw fail('Issue labels must be a list.');
  if (value.length > 100) throw fail('An issue has too many labels.');
  return value.map((label) => {
    if (typeof label === 'string') return { id: label, name: label, color: null };
    if (!label || typeof label !== 'object') throw fail('A label is invalid.');
    return {
      id: typeof label.id === 'string' ? label.id : label.name,
      name: cleanString(label.name, 'label name', 64, { trim: true }),
      color: cleanString(label.color, 'label color', 32, { nullable: true, trim: true }),
    };
  });
}

function normalizeComment(comment) {
  if (!comment || typeof comment !== 'object') throw fail('A comment is invalid.');
  return {
    id: idValue(comment.id, 'comment id'),
    body: cleanString(comment.body ?? '', 'comment body', MAX_TEXT),
    createdAt: isoValue(comment.createdAt, 'comment createdAt', false),
    editedAt: isoValue(comment.editedAt, 'comment editedAt'),
    authorName: cleanString(comment.authorName, 'comment authorName', 200, { nullable: true, trim: true }),
    authorEmail: cleanString(comment.authorEmail, 'comment authorEmail', 320, { nullable: true, trim: true }),
    parentId: idValue(comment.parentId, 'comment parentId', true),
  };
}

function normalizeRelation(relation) {
  if (!relation || typeof relation !== 'object') throw fail('An issue relation is invalid.');
  return {
    id: relation.id == null ? null : idValue(relation.id, 'relation id'),
    type: cleanString(relation.type, 'relation type', 80, { trim: true }),
    relatedIssueId: idValue(relation.relatedIssueId, 'related issue id'),
  };
}

function normalizeAttachment(attachment) {
  if (!attachment || typeof attachment !== 'object') throw fail('An attachment is invalid.');
  let url;
  try {
    const parsed = new URL(attachment.url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
    url = parsed.toString();
  } catch { throw fail('An attachment URL is invalid.'); }
  return { url, title: cleanString(attachment.title ?? '', 'attachment title', 500) };
}

/** Normalize and validate a fetched or recorded snapshot before planning or writing. */
export function normalizeSnapshot(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('Snapshot must be an object.');
  if (input.version !== SNAPSHOT_VERSION) throw fail('Unknown Linear snapshot version.');
  const issueInput = input.issues;
  if (!Array.isArray(issueInput) || issueInput.length > MAX_ISSUES) throw fail('Snapshot issue count exceeds the supported limit.');
  const collections = ['teams', 'users', 'states', 'labels', 'projects', 'cycles', 'milestones'];
  for (const name of collections) if (input[name] != null && !Array.isArray(input[name])) throw fail(`Snapshot ${name} must be a list.`);
  const collectionLimits = { teams: 1_000, users: 100_000, states: 10_000, labels: MAX_LABELS, projects: 100_000, cycles: 100_000, milestones: 100_000 };
  for (const name of collections) if ((input[name]?.length ?? 0) > collectionLimits[name]) throw fail(`Snapshot ${name} count exceeds the supported limit.`);
  const teams = (input.teams ?? []).map((row) => ({
    id: idValue(row.id, 'team id'), key: cleanString(row.key, 'team key', 20, { trim: true }),
    name: cleanString(row.name, 'team name', 200), private: Boolean(row.private), archivedAt: isoValue(row.archivedAt, 'team archivedAt'),
  }));
  const users = (input.users ?? []).map((row) => ({
    id: idValue(row.id, 'user id'), name: cleanString(row.name ?? '', 'user name', 200),
    email: cleanString(row.email, 'user email', 320, { nullable: true, trim: true }), active: Boolean(row.active),
  }));
  const states = (input.states ?? []).map((row) => ({
    id: idValue(row.id, 'state id'), name: cleanString(row.name, 'state name', 200),
    type: cleanString(row.type, 'state type', 80, { trim: true }).toLocaleLowerCase('en-US'), idTeam: idValue(row.teamId, 'state teamId', true),
  }));
  const labels = (input.labels ?? []).map((row) => ({
    id: idValue(row.id, 'label id'), name: cleanString(row.name, 'label name', 64, { trim: true }),
    color: cleanString(row.color, 'label color', 32, { nullable: true, trim: true }), archivedAt: isoValue(row.archivedAt, 'label archivedAt'),
  }));
  if (labels.length > MAX_LABELS) throw fail('Snapshot label count exceeds the supported limit.');
  const projects = (input.projects ?? []).map((row) => ({
    id: idValue(row.id, 'project id'), name: cleanString(row.name, 'project name', 200),
    description: cleanString(row.description ?? '', 'project description', MAX_TEXT), state: cleanString(row.state ?? 'started', 'project state', 40),
    teamIds: Array.isArray(row.teamIds) ? row.teamIds.map((id) => idValue(id, 'project teamId')) : [],
    createdAt: isoValue(row.createdAt, 'project createdAt'), updatedAt: isoValue(row.updatedAt, 'project updatedAt'), archivedAt: isoValue(row.archivedAt, 'project archivedAt'),
  }));
  const cycles = (input.cycles ?? []).map((row) => ({
    id: idValue(row.id, 'cycle id'), name: cleanString(row.name, 'cycle name', 200), description: cleanString(row.description ?? '', 'cycle description', MAX_TEXT),
    teamId: idValue(row.teamId, 'cycle teamId', true), startsAt: isoValue(row.startsAt, 'cycle startsAt'), endsAt: isoValue(row.endsAt, 'cycle endsAt'),
    completedAt: isoValue(row.completedAt, 'cycle completedAt'), archivedAt: isoValue(row.archivedAt, 'cycle archivedAt'),
  }));
  const milestones = (input.milestones ?? []).map((row) => ({
    id: idValue(row.id, 'milestone id'), name: cleanString(row.name, 'milestone name', 200), description: cleanString(row.description ?? '', 'milestone description', MAX_TEXT),
    projectId: idValue(row.projectId, 'milestone projectId', true), targetDate: row.targetDate == null ? null : String(row.targetDate),
    createdAt: isoValue(row.createdAt, 'milestone createdAt'), updatedAt: isoValue(row.updatedAt, 'milestone updatedAt'), archivedAt: isoValue(row.archivedAt, 'milestone archivedAt'),
  }));
  const issues = issueInput.map((row) => {
    if (!row || typeof row !== 'object') throw fail('An issue is invalid.');
    const state = row.state;
    if (!state || typeof state !== 'object') throw fail('An issue state is invalid.');
    const dueDate = row.dueDate == null ? null : String(row.dueDate);
    if (dueDate != null && !validCalendarDate(dueDate)) throw fail('An issue dueDate is invalid.');
    if (!Number.isInteger(Number(row.number)) || Number(row.number) < 1) throw fail('An issue number is invalid.');
    const comments = Array.isArray(row.comments) ? row.comments.map(normalizeComment) : [];
    if (comments.length > 10_000) throw fail('An issue has too many comments.');
    if (row.labels?.length > 20) throw fail('An issue has too many labels.');
    const commentIds = new Set(comments.map((comment) => comment.id));
    if (commentIds.size !== comments.length) {
      throw fail('Snapshot contains an invalid comment thread.');
    }
    const relations = Array.isArray(row.relations) ? row.relations.map(normalizeRelation) : [];
    const attachments = Array.isArray(row.attachments) ? row.attachments.map(normalizeAttachment) : [];
    if (relations.length > 1_000 || attachments.length > 100) throw fail('An issue has too many relations or attachments.');
    const priority = row.priority == null ? null : Number(row.priority);
    const estimate = row.estimate == null ? null : Number(row.estimate);
    if (priority != null && !Number.isFinite(priority)) throw fail('An issue priority is invalid.');
    if (estimate != null && !Number.isFinite(estimate)) throw fail('An issue estimate is invalid.');
    const identifier = cleanString(row.identifier, 'issue identifier', 40, { trim: true });
    const title = cleanString(row.title, 'issue title', 200, { trim: true });
    const teamKey = cleanString(row.teamKey, 'team key', 20, { trim: true }).toUpperCase();
    if (!identifier || !title || !teamKey) throw fail('Issue identifier, title, and team key are required.');
    return {
      id: idValue(row.id, 'issue id'), identifier,
      number: Number(row.number), teamKey,
      teamId: idValue(row.teamId, 'issue teamId', true), teamPrivate: Boolean(row.teamPrivate),
      title, description: cleanString(row.description ?? '', 'issue description', MAX_TEXT),
      priority, estimate,
      state: { id: idValue(state.id, 'issue state id'), name: cleanString(state.name, 'issue state name', 200), type: cleanString(state.type, 'issue state type', 80, { trim: true }).toLocaleLowerCase('en-US') },
      assigneeEmail: cleanString(row.assigneeEmail, 'assignee email', 320, { nullable: true, trim: true }),
      creatorEmail: cleanString(row.creatorEmail, 'creator email', 320, { nullable: true, trim: true }),
      labels: normalizeLabels(row.labels ?? []), projectId: idValue(row.projectId, 'project id', true), cycleId: idValue(row.cycleId, 'cycle id', true),
      milestoneId: idValue(row.milestoneId, 'milestone id', true), parentId: idValue(row.parentId, 'parent issue id', true), dueDate,
      createdAt: isoValue(row.createdAt, 'issue createdAt', false), updatedAt: isoValue(row.updatedAt, 'issue updatedAt', false),
      archivedAt: isoValue(row.archivedAt, 'issue archivedAt'), completedAt: isoValue(row.completedAt, 'issue completedAt'), canceledAt: isoValue(row.canceledAt, 'issue canceledAt'),
      url: cleanString(row.url ?? '', 'issue URL', 2_000), comments, relations, attachments,
    };
  });
  if (issues.reduce((sum, issue) => sum + issue.comments.length, 0) > MAX_COMMENTS) throw fail('Snapshot comment count exceeds the supported limit.');
  if (issues.reduce((sum, issue) => sum + issue.relations.length, 0) > MAX_RELATIONS) throw fail('Snapshot relation count exceeds the supported limit.');
  const issueIds = new Set();
  const issueKeys = new Set();
  const commentIds = new Set();
  for (const issue of issues) {
    if (issueIds.has(issue.id) || issueKeys.has(issue.identifier.toLocaleLowerCase('en-US'))) throw fail('Snapshot contains duplicate issue aliases.');
    issueIds.add(issue.id);
    issueKeys.add(issue.identifier.toLocaleLowerCase('en-US'));
    for (const comment of issue.comments) {
      if (commentIds.has(comment.id)) throw fail('Snapshot contains duplicate comment IDs.');
      commentIds.add(comment.id);
    }
  }
  for (const issue of issues) if (issue.parentId === issue.id) throw fail('Snapshot contains a self-parent issue.');
  const issuesById = new Map(issues.map((issue) => [issue.id, issue]));
  const visiting = new Set();
  const visited = new Set();
  function visitParent(issueId) {
    if (visited.has(issueId)) return;
    if (visiting.has(issueId)) throw fail('Snapshot contains a parent cycle.');
    visiting.add(issueId);
    const parentId = issuesById.get(issueId)?.parentId;
    if (parentId && issuesById.has(parentId)) visitParent(parentId);
    visiting.delete(issueId);
    visited.add(issueId);
  }
  for (const issue of issues) visitParent(issue.id);
  const textValues = [
    ...teams.flatMap((row) => [row.key, row.name]), ...users.flatMap((row) => [row.name, row.email ?? '']),
    ...states.map((row) => row.name), ...labels.map((row) => row.name),
    ...projects.flatMap((row) => [row.name, row.description]), ...cycles.flatMap((row) => [row.name, row.description]),
    ...milestones.flatMap((row) => [row.name, row.description]),
    ...issues.flatMap((row) => [row.identifier, row.title, row.description, ...row.comments.flatMap((comment) => [comment.body, comment.authorName ?? '', comment.authorEmail ?? '']), ...row.attachments.flatMap((attachment) => [attachment.url, attachment.title])]),
  ];
  if (textValues.reduce((size, value) => size + Buffer.byteLength(value, 'utf8'), 0) > MAX_TOTAL_TEXT_BYTES) {
    throw fail('Snapshot text exceeds the supported total size.');
  }
  return {
    version: SNAPSHOT_VERSION, fetchedAt: isoValue(input.fetchedAt, 'snapshot fetchedAt', false), teams, users, states, labels, projects, cycles, milestones, issues,
    deletedComments: Array.isArray(input.deletedComments) ? input.deletedComments.map((row) => ({ issueId: idValue(row.issueId, 'deleted comment issue id'), id: idValue(row.id, 'deleted comment id') })) : [],
  };
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function fieldExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function resolveState(issue) {
  const type = issue.state.type;
  let key;
  if (type === 'completed') key = 'done';
  else if (type === 'canceled' || type === 'cancelled') key = 'cancelled';
  else if (type === 'started') key = /review/i.test(issue.state.name) ? 'in_review' : 'in_progress';
  else key = 'todo';
  return { key, ...DEFAULT_STATE[key] };
}

function stateIsNonDefault(issue, target) {
  return issue.state.name.trim().toLocaleLowerCase('en-US') !== target.name.toLocaleLowerCase('en-US');
}

function formatKey(issue) {
  return issue.identifier || `${issue.teamKey}-${issue.number}`;
}

function userMatch(db, email) {
  const normalized = normEmail(email);
  if (!normalized) return null;
  const matches = db.prepare("SELECT id FROM users WHERE role IN ('owner', 'admin', 'member') AND disabled = 0 AND lower(trim(email)) = ? ORDER BY id").all(normalized);
  return matches.length === 1 ? matches[0].id : null;
}

function addLoss(report, category, key, extra = {}) {
  const row = report[category] ?? { count: 0, keys: [], ...extra };
  row.count++;
  row.keys.push(key);
  report[category] = row;
}

function uniqueKeys(rows) {
  return [...new Set(rows)].sort((a, b) => a.localeCompare(b));
}

function numberingPlan(db, snapshot, options, importedById) {
  const tracker = db.prepare('SELECT id, prefix FROM trackers WHERE id = ?').get('trk_default');
  if (!tracker) throw fail('Default tracker seed is missing.', 'database');
  const newIssues = snapshot.issues.filter((issue) => !importedById.has(issue.id));
  const sourceNumbers = new Set();
  let collision = false;
  for (const issue of newIssues) {
    if (sourceNumbers.has(issue.number)) collision = true;
    sourceNumbers.add(issue.number);
    if (db.prepare('SELECT 1 FROM tickets WHERE prefix = ? AND number = ?').get(tracker.prefix, issue.number)) collision = true;
  }
  const qualifies = snapshot.issues.every((issue) => issue.teamKey === tracker.prefix) && !collision;
  const requested = options.numbering ?? 'auto';
  if (!['auto', 'keep', 'allocate'].includes(requested)) throw fail('numbering must be keep or allocate.');
  if (requested === 'keep' && !qualifies) throw fail('keep numbering would collide or use a different team prefix.', 'numbering');
  return { strategy: requested === 'allocate' ? 'allocate' : requested === 'keep' || qualifies ? 'keep' : 'allocate', prefix: tracker.prefix, trackerId: tracker.id, qualifies };
}

function makeReport(db, snapshot, options, tables) {
  const archivedByState = {};
  let archived = 0;
  for (const issue of snapshot.issues) {
    if (!issue.archivedAt) continue;
    archived++;
    archivedByState[issue.state.name] = (archivedByState[issue.state.name] ?? 0) + 1;
  }
  const active = snapshot.issues.length - archived;
  const importedById = new Map();
  const keyOwner = new Map();
  for (const issue of snapshot.issues) {
    const byId = db.prepare("SELECT ticket_id FROM ticket_aliases WHERE provider = 'linear' AND external_id = ?").get(issue.id);
    const byKey = db.prepare("SELECT ticket_id FROM ticket_aliases WHERE provider = 'linear-key' AND external_id = ? COLLATE NOCASE").get(issue.identifier);
    if (byId) importedById.set(issue.id, byId.ticket_id);
    if (byKey) keyOwner.set(issue.identifier.toLocaleLowerCase('en-US'), byKey.ticket_id);
  }
  const duplicateAliases = [];
  for (const issue of snapshot.issues) {
    const idAlias = db.prepare("SELECT ticket_id FROM ticket_aliases WHERE provider = 'linear' AND external_id = ?").get(issue.id);
    const keyAlias = db.prepare("SELECT ticket_id FROM ticket_aliases WHERE provider = 'linear-key' AND external_id = ? COLLATE NOCASE").get(issue.identifier);
    if ((idAlias && keyAlias && idAlias.ticket_id !== keyAlias.ticket_id) || (keyAlias && !idAlias)) duplicateAliases.push(formatKey(issue));
  }
  const numbering = numberingPlan(db, snapshot, options, importedById);
  const stateGroups = new Map();
  const unknownPriorities = [];
  const unmatchedGroups = new Map();
  const loss = Object.fromEntries([
    'workflowStates', 'cycles', 'projects', 'milestones', 'relations', 'unsupportedRelationTypes',
    'privateTeams', 'deletedComments', 'attachments', 'unmatchedUsers', 'reactions', 'estimates',
  ].map((category) => [category, { count: 0, keys: [] }]));
  let comments = 0;
  let attachments = 0;
  const attachmentUrls = [];
  const labelRecords = new Map();
  const labelConflictKeys = new Set();
  const labelConflictNames = new Map();
  const databaseLabels = new Map(db.prepare('SELECT name, color FROM labels WHERE archived_at IS NULL').all().map((row) => [normName(row.name), row]));
  function recordLabel(label, issueKey = null) {
    const normalized = normName(label.name);
    const known = labelRecords.get(normalized) ?? { name: label.name, colors: new Set(), keys: new Set() };
    if (issueKey && labelConflictNames.has(normalized)) labelConflictNames.get(normalized).keys.add(issueKey);
    if (label.color) {
      if (known.colors.size && !known.colors.has(label.color.toLowerCase())) {
        const conflict = labelConflictNames.get(normalized) ?? { name: known.name, keys: new Set() };
        if (issueKey) conflict.keys.add(issueKey);
        labelConflictNames.set(normalized, conflict);
      }
      known.colors.add(label.color.toLowerCase());
      const existing = databaseLabels.get(normalized);
      if (existing?.color && existing.color.toLowerCase() !== label.color.toLowerCase()) {
        const conflict = labelConflictNames.get(normalized) ?? { name: known.name, keys: new Set() };
        if (issueKey) conflict.keys.add(issueKey);
        labelConflictNames.set(normalized, conflict);
      }
    }
    if (issueKey) known.keys.add(issueKey);
    labelRecords.set(normalized, known);
  }
  for (const label of snapshot.labels) recordLabel(label);
  const unmatchedIssueKeys = new Set();
  for (const issue of snapshot.issues) {
    const key = formatKey(issue);
    const state = resolveState(issue);
    const group = stateGroups.get(`${issue.state.type}\0${issue.state.name}\0${state.key}`) ?? { linearType: issue.state.type, linearName: issue.state.name, target: state.key, keys: [] };
    group.keys.push(key);
    stateGroups.set(`${issue.state.type}\0${issue.state.name}\0${state.key}`, group);
    if (stateIsNonDefault(issue, state)) addLoss(loss, 'workflowStates', key, { states: [] });
    if (!Number.isInteger(issue.priority) || issue.priority < 0 || issue.priority > 4) unknownPriorities.push(key);
    const email = normEmail(issue.assigneeEmail);
    if (email && !userMatch(db, email)) {
      const entry = unmatchedGroups.get(email) ?? { count: 0, keys: [] };
      entry.count++;
      entry.keys.push(key);
      unmatchedGroups.set(email, entry);
      unmatchedIssueKeys.add(key);
    }
    if (issue.teamPrivate) addLoss(loss, 'privateTeams', key);
    if (issue.estimate != null && !fieldExists(db, 'tickets', 'estimate')) addLoss(loss, 'estimates', key);
    if (issue.projectId && !tables.projects) addLoss(loss, 'projects', key);
    if (issue.milestoneId && !tables.milestones) addLoss(loss, 'milestones', key);
    if (issue.cycleId) addLoss(loss, 'cycles', key);
    if (issue.relations.length && !tables.ticket_relations) addLoss(loss, 'relations', key);
    for (const relation of issue.relations) if (!['blocks', 'blocked', 'blocked_by', 'related', 'duplicate', 'duplicates', 'duplicated_by'].includes(relation.type.toLowerCase())) {
      addLoss(loss, 'unsupportedRelationTypes', key);
    }
    comments += issue.comments.length;
    attachments += issue.attachments.length;
    for (const attachment of issue.attachments) attachmentUrls.push({ key, url: attachment.url });
    for (const label of issue.labels) recordLabel(label, key);
  }
  const estimatedIssues = snapshot.issues.filter((issue) => issue.estimate != null);
  const estimateColumn = fieldExists(db, 'tickets', 'estimate');
  loss.estimates = {
    count: estimateColumn ? 0 : estimatedIssues.length,
    keys: estimateColumn ? [] : uniqueKeys(estimatedIssues.map(formatKey)),
    preserved: estimateColumn,
    preservedCount: estimateColumn ? estimatedIssues.length : 0,
    preservedKeys: estimateColumn ? uniqueKeys(estimatedIssues.map(formatKey)) : [],
  };
  loss.attachments = { count: attachments, keys: uniqueKeys(attachmentUrls.map((row) => row.key)), sourceUrls: attachmentUrls };
  for (const deleted of snapshot.deletedComments) {
    const issue = snapshot.issues.find((row) => row.id === deleted.issueId);
    if (issue) addLoss(loss, 'deletedComments', formatKey(issue));
  }
  loss.reactions = { count: null, keys: [], status: 'not included in the Linear snapshot query' };
  for (const name of Object.keys(loss)) loss[name].keys = uniqueKeys(loss[name].keys);
  for (const conflict of labelConflictNames.values()) for (const key of conflict.keys) labelConflictKeys.add(key);
  const stateMapping = [...stateGroups.values()].map((row) => ({ ...row, keys: uniqueKeys(row.keys) })).sort((a, b) => a.linearName.localeCompare(b.linearName));
  const report = {
    version: 1,
    fetchedAt: snapshot.fetchedAt,
    counts: { issues: snapshot.issues.length, active, archived, archivedByState, comments, attachments },
    numbering: { strategy: numbering.strategy, prefix: numbering.prefix, qualifiesForKeep: numbering.qualifies },
    stateMapping,
    priorityMap: { linear: { 0: 'none', 1: 'urgent', 2: 'high', 3: 'medium', 4: 'low' }, unknownPriorityKeys: uniqueKeys(unknownPriorities) },
    users: { matchedIssues: snapshot.issues.filter((issue) => issue.assigneeEmail && userMatch(db, issue.assigneeEmail)).length, unmatched: [...unmatchedGroups.values()].map((row) => ({ match: 'unmatched', count: row.count, keys: uniqueKeys(row.keys) })) },
    labels: {
      distinctNormalized: labelRecords.size,
      colorConflictKeys: uniqueKeys([...labelConflictKeys]),
      colorConflicts: [...labelConflictNames.values()].map((row) => ({ name: row.name, keys: uniqueKeys([...row.keys]) })),
    },
    duplicateAliases: uniqueKeys(duplicateAliases),
    comments: { total: comments },
    attachments: { total: attachments, sourceUrls: attachmentUrls },
    lossReport: loss,
    archiveChoice: 'Linear archived issues in completed or canceled states remain normal Done/Cancelled tickets; archived_at is set only for archived non-completed, non-canceled issues.',
    tables,
    plan: {
      create: snapshot.issues.filter((issue) => !importedById.has(issue.id)).length,
      alreadyImported: importedById.size,
      update: options.mode === 'update' ? importedById.size : 0,
      issueKeys: snapshot.issues.map(formatKey),
    },
  };
  loss.unmatchedUsers = { count: unmatchedIssueKeys.size, keys: uniqueKeys([...unmatchedIssueKeys]) };
  return { report, numbering, importedById };
}

/** Build a no-write import plan and privacy-safe report. */
/** @param {any} options @returns {any} */
export function planImport({ db: dbArg, snapshot: rawSnapshot, options = {} } = {}) {
  const db = getDb({ db: dbArg });
  const snapshot = normalizeSnapshot(rawSnapshot);
  const tables = Object.fromEntries(['projects', 'milestones', 'ticket_relations'].map((name) => [name, tableExists(db, name)]));
  const planned = makeReport(db, snapshot, options, tables);
  return {
    plan: {
      ...planned.report.plan,
      numbering: planned.numbering.strategy,
      batchCount: Math.ceil(snapshot.issues.length / BATCH_SIZE),
      batches: snapshot.issues.length === 0 ? [] : Array.from({ length: Math.ceil(snapshot.issues.length / BATCH_SIZE) }, (_, index) => ({ number: index + 1, count: Math.min(BATCH_SIZE, snapshot.issues.length - index * BATCH_SIZE) })),
    },
    report: planned.report,
  };
}

function millis(value) {
  return Date.parse(value);
}

function ensureCounter(db, trackerId, prefix, now) {
  let row = db.prepare('SELECT next_number FROM ticket_counters WHERE scope = ? AND prefix = ?').get(trackerId, prefix);
  const max = Number(db.prepare('SELECT COALESCE(MAX(number), 0) AS value FROM tickets WHERE prefix = ?').get(prefix).value);
  if (!row) {
    db.prepare('INSERT INTO ticket_counters (scope, prefix, next_number, updated_at) VALUES (?, ?, ?, ?)').run(trackerId, prefix, max + 1, now);
    return max + 1;
  }
  const next = Math.max(Number(row.next_number), max + 1);
  if (next !== Number(row.next_number)) db.prepare('UPDATE ticket_counters SET next_number = ?, updated_at = ? WHERE scope = ? AND prefix = ?').run(next, now, trackerId, prefix);
  return next;
}

function emailToUser(db, email) {
  return userMatch(db, email);
}

function importedState(issue) {
  return resolveState(issue);
}

function normalizedRelationKind(type) {
  switch (String(type).toLowerCase()) {
    case 'blocks': return 'blocks';
    case 'blocked':
    case 'blocked_by': return 'blocked_by';
    case 'duplicate':
    case 'duplicates': return 'duplicates';
    case 'duplicated_by': return 'duplicated_by';
    default: return 'relates_to';
  }
}

function defaultActorWrite(actor) {
  try { requireTicketWrite(actor, TRACKER); } catch { throw fail('The actor is not authorized to write tracker tickets.', 'forbidden'); }
}

function sourceAlias(db, issueId) {
  return db.prepare("SELECT ticket_id FROM ticket_aliases WHERE provider = 'linear' AND external_id = ?").get(issueId)?.ticket_id ?? null;
}

function ensureLabel(db, label, now, createdBy) {
  const existing = db.prepare('SELECT id, name, color FROM labels WHERE archived_at IS NULL ORDER BY id').all()
    .find((row) => normName(row.name) === normName(label.name));
  if (existing) return existing.id;
  const id = newId();
  db.prepare('INSERT INTO labels (id, name, color, created_at, created_by) VALUES (?, ?, ?, ?, ?)').run(id, label.name, label.color, now, createdBy);
  return id;
}

function importLabelCatalog(db, snapshot, now, createdBy) {
  const seen = new Set();
  for (const label of snapshot.labels) {
    const normalized = normName(label.name);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (label.archivedAt) continue;
    ensureLabel(db, label, now, createdBy);
  }
}

function labelsForIssue(db, issue, now, createdBy) {
  const unique = new Map();
  for (const label of issue.labels) {
    const normalized = normName(label.name);
    if (!unique.has(normalized)) unique.set(normalized, label);
  }
  return [...unique.values()].map((label) => ensureLabel(db, label, now, createdBy));
}

const PROJECT_STATES = { backlog: 'planned', planned: 'planned', started: 'started', paused: 'paused', completed: 'completed', canceled: 'canceled', cancelled: 'canceled' };
const MAX_ACTIVE_PROJECTS = 200;
const MAX_MILESTONES_PER_PROJECT = 50;
const MAX_RELATIONS_PER_TICKET = 100;

/**
 * Projects and milestones follow the slice 2 rules: states planned|started|paused|completed|canceled, active names unique ignoring
 * case (a clash gets a numeric suffix), at most 200 active projects and 50 milestones per project, and a milestone always has a
 * project. Cycles are never imported (no cycles in v1); they stay in the loss report.
 */
function insertProjectRows(db, snapshot, now, withProjects, withMilestones) {
  const stats = { projects: 0, renamedProjects: 0, skippedProjects: 0, milestones: 0, skippedMilestones: 0 };
  if (!withProjects) return stats;
  const activeNames = new Set(db.prepare('SELECT name FROM projects WHERE archived_at IS NULL').all().map((row) => String(row.name).toLowerCase()));
  let active = Number(db.prepare('SELECT COUNT(*) AS n FROM projects WHERE archived_at IS NULL').get().n);
  for (const project of snapshot.projects) {
    if (db.prepare('SELECT 1 FROM projects WHERE id = ?').get(project.id)) continue;
    const archivedAt = project.archivedAt ? millis(project.archivedAt) : null;
    if (archivedAt === null && active >= MAX_ACTIVE_PROJECTS) { stats.skippedProjects++; continue; }
    let name = project.name;
    if (archivedAt === null) {
      let n = 1;
      while (activeNames.has(name.toLowerCase())) name = `${project.name} (${++n})`;
      if (name !== project.name) stats.renamedProjects++;
      activeNames.add(name.toLowerCase());
      active++;
    }
    db.prepare(`INSERT INTO projects (id, name, description, state, owner_user_id, created_at, updated_at, archived_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`)
      .run(project.id, name, project.description, PROJECT_STATES[String(project.state ?? '').toLowerCase()] ?? 'started', millis(project.createdAt) || now, millis(project.updatedAt) || now, archivedAt);
    stats.projects++;
  }
  if (withMilestones) {
    for (const milestone of snapshot.milestones) {
      if (db.prepare('SELECT 1 FROM milestones WHERE id = ?').get(milestone.id)) continue;
      const project = milestone.projectId ? db.prepare('SELECT id FROM projects WHERE id = ?').get(milestone.projectId) : null;
      const count = project ? Number(db.prepare('SELECT COUNT(*) AS n FROM milestones WHERE project_id = ? AND archived_at IS NULL').get(project.id).n) : 0;
      if (!project || (!milestone.archivedAt && count >= MAX_MILESTONES_PER_PROJECT)) { stats.skippedMilestones++; continue; }
      const targetDate = milestone.targetDate && validCalendarDate(milestone.targetDate) ? Date.parse(`${milestone.targetDate}T00:00:00.000Z`) : null;
      db.prepare(`INSERT INTO milestones (id, project_id, name, description, start_at, due_at, state, created_at, updated_at, archived_at)
        VALUES (?, ?, ?, ?, NULL, ?, 'started', ?, ?, ?)`)
        .run(milestone.id, project.id, milestone.name, milestone.description, targetDate, millis(milestone.createdAt) || now, millis(milestone.updatedAt) || now, milestone.archivedAt ? millis(milestone.archivedAt) : null);
      stats.milestones++;
    }
  }
  return stats;
}

/** The project and milestone a ticket may carry: both must exist, and the milestone must belong to the project. */
function ticketAssignment(db, projectId, milestoneId) {
  const project = projectId && tableExists(db, 'projects') ? db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId) : null;
  const milestone = project && milestoneId && tableExists(db, 'milestones')
    ? db.prepare('SELECT id FROM milestones WHERE id = ? AND project_id = ?').get(milestoneId, project.id) : null;
  return { projectId: project?.id ?? null, milestoneId: milestone?.id ?? null };
}

function addTicketAliases(db, issue, ticketId) {
  db.prepare(`INSERT INTO ticket_aliases (id, ticket_id, provider, external_id, display_key, url, created_at)
    VALUES (?, ?, 'linear', ?, ?, ?, ?)`).run(newId(), ticketId, issue.id, issue.identifier, issue.url || null, millis(issue.createdAt));
  db.prepare(`INSERT INTO ticket_aliases (id, ticket_id, provider, external_id, display_key, url, created_at)
    VALUES (?, ?, 'linear-key', ?, ?, ?, ?)`).run(newId(), ticketId, issue.identifier, issue.identifier, issue.url || null, millis(issue.createdAt));
}

function nestedAllocatorDirectory(db) {
  return {
    db,
    transaction(fn) {
      db.exec('SAVEPOINT linear_ticket_allocator');
      try {
        const result = fn();
        db.exec('RELEASE SAVEPOINT linear_ticket_allocator');
        return result;
      } catch (error) {
        db.exec('ROLLBACK TO SAVEPOINT linear_ticket_allocator');
        db.exec('RELEASE SAVEPOINT linear_ticket_allocator');
        throw error;
      }
    },
  };
}

function createAllocatedTicketRows(db, issue, numbering, actor, projectAvailable, milestoneAvailable, options) {
  const state = importedState(issue);
  const labels = labelsForIssue(db, issue, millis(issue.createdAt), actorInfo(actor).userId);
  const allocation = allocateTicket({
    directory: nestedAllocatorDirectory(db),
    db,
    actor: { type: 'system' },
    source: 'linear-import',
    idempotencyKey: `linear:${issue.id}`,
    now: millis(issue.createdAt),
    fields: {
      title: issue.title,
      description: issue.description,
      stateId: state.id,
      priority: Number.isInteger(issue.priority) && issue.priority >= 0 && issue.priority <= 4 ? issue.priority : 0,
      parentTicketId: null,
      assigneeUserId: emailToUser(db, issue.assigneeEmail),
      dueDate: issue.dueDate,
      labels: labels.map((id) => ({ id })),
    },
  });
  if (!allocation.ticketId) throw fail('The shared ticket allocator did not return a ticket.');
  const isDone = issue.state.type === 'completed' || Boolean(issue.completedAt);
  const isCanceled = ['canceled', 'cancelled'].includes(issue.state.type) || Boolean(issue.canceledAt);
  const archivedAt = issue.archivedAt && !isDone && !isCanceled ? millis(issue.archivedAt) : null;
  const { projectId, milestoneId } = ticketAssignment(db, projectAvailable ? issue.projectId : null, milestoneAvailable ? issue.milestoneId : null);
  db.prepare('UPDATE tickets SET estimate = ?, project_id = ?, milestone_id = ?, archived_at = ?, updated_at = ? WHERE id = ?')
    .run(issue.estimate, projectId, milestoneId, archivedAt, millis(issue.updatedAt), allocation.ticketId);
  addTicketAliases(db, issue, allocation.ticketId);
  refreshTicketSearch(db, allocation.ticketId);
  writeComments(db, issue, allocation.ticketId, millis(issue.createdAt), options.delta === true);
  return { ticketId: allocation.ticketId, key: allocation.key, eventSeq: allocation.updatedSeq };
}

function createKeptTicketRows(db, issue, numbering, now, actor, projectAvailable, milestoneAvailable, options) {
  const tracker = db.prepare('SELECT prefix FROM trackers WHERE id = ?').get(numbering.trackerId);
  const number = issue.number;
  const key = `${tracker.prefix}-${number}`;
  const state = importedState(issue);
  const assignee = emailToUser(db, issue.assigneeEmail);
  const labels = labelsForIssue(db, issue, millis(issue.createdAt), actorInfo(actor).userId);
  const isDone = issue.state.type === 'completed' || Boolean(issue.completedAt);
  const isCanceled = ['canceled', 'cancelled'].includes(issue.state.type) || Boolean(issue.canceledAt);
  const archivedAt = issue.archivedAt && !isDone && !isCanceled ? millis(issue.archivedAt) : null;
  const { projectId, milestoneId } = ticketAssignment(db, projectAvailable ? issue.projectId : null, milestoneAvailable ? issue.milestoneId : null);
  const ticketId = newId();
  db.prepare(`INSERT INTO tickets
    (id, prefix, number, key, title, description, state_id, tracker_id, priority, estimate, parent_ticket_id,
     assignee_user_id, project_id, milestone_id, due_date, archived_at, created_at, updated_at, created_by_type, created_by_id, updated_seq, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'system', NULL, 0, 'linear-import')`)
    .run(ticketId, tracker.prefix, number, key, issue.title, issue.description, state.id, numbering.trackerId,
      Number.isInteger(issue.priority) && issue.priority >= 0 && issue.priority <= 4 ? issue.priority : 0,
      issue.estimate, assignee, projectId, milestoneId, issue.dueDate, archivedAt, millis(issue.createdAt), millis(issue.updatedAt));
  for (const labelId of labels) db.prepare('INSERT INTO ticket_labels (ticket_id, label_id, created_at) VALUES (?, ?, ?)').run(ticketId, labelId, millis(issue.createdAt));
  const eventSeq = appendTicketEvent({ db, ticketId, eventType: 'created', actor: { type: 'system' }, source: 'linear-import', idempotencyKey: `linear:${issue.id}`, createdAt: millis(issue.createdAt) });
  db.prepare('UPDATE tickets SET updated_seq = ? WHERE id = ?').run(eventSeq, ticketId);
  for (const field of ['title', 'description', 'state', 'priority', 'assignee', 'labels', 'due', 'parent']) {
    db.prepare('INSERT OR REPLACE INTO ticket_field_versions (ticket_id, field, event_seq, actor_type, actor_id) VALUES (?, ?, ?, ?, NULL)')
      .run(ticketId, field, eventSeq, 'system');
  }
  addTicketAliases(db, issue, ticketId);
  refreshTicketSearch(db, ticketId);
  writeComments(db, issue, ticketId, millis(issue.createdAt), options.delta === true);
  return { ticketId, key, eventSeq };
}

function commentSort(comments) {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const done = new Set();
  const visiting = new Set();
  const ordered = [];
  function visit(comment) {
    if (done.has(comment.id)) return;
    if (visiting.has(comment.id)) throw fail('Snapshot contains a comment thread cycle.');
    visiting.add(comment.id);
    const parent = comment.parentId ? byId.get(comment.parentId) : null;
    if (parent) visit(parent);
    visiting.delete(comment.id);
    done.add(comment.id);
    ordered.push(comment);
  }
  for (const comment of comments) visit(comment);
  return ordered;
}

function writeComments(db, issue, ticketId, fallbackTime, appendNew) {
  const idBySource = new Map();
  for (const row of db.prepare("SELECT id, client_id FROM ticket_comments WHERE ticket_id = ? AND client_id LIKE 'linear:%'").all(ticketId)) idBySource.set(row.client_id.slice('linear:'.length), row.id);
  for (const comment of commentSort(issue.comments)) {
    const clientId = `linear:${comment.id}`;
    const existing = db.prepare('SELECT id FROM ticket_comments WHERE actor_type = ? AND actor_id IS NULL AND client_id = ?').get('system', clientId);
    if (existing) {
      idBySource.set(comment.id, existing.id);
      if (!appendNew) continue;
    }
    const id = existing?.id ?? `linear-comment-${comment.id}`;
    const parentId = comment.parentId ? idBySource.get(comment.parentId) ?? null : null;
    const author = comment.authorName && comment.authorEmail ? `${comment.authorName} <${comment.authorEmail}>`
      : comment.authorName || comment.authorEmail || 'Linear user';
    if (!existing) {
      db.prepare(`INSERT INTO ticket_comments (id, ticket_id, parent_id, actor_type, actor_id, author_snapshot, body, created_at, edited_at, deleted_at, client_id)
        VALUES (?, ?, ?, 'system', NULL, ?, ?, ?, ?, NULL, ?)`)
        .run(id, ticketId, parentId, author, comment.body, millis(comment.createdAt) || fallbackTime, comment.editedAt ? millis(comment.editedAt) : null, clientId);
      idBySource.set(comment.id, id);
    }
  }
  refreshTicketSearch(db, ticketId);
}

function changedForIssue(db, ticketId, importEventSeq, field) {
  const row = db.prepare('SELECT event_seq FROM ticket_field_versions WHERE ticket_id = ? AND field = ?').get(ticketId, field);
  if (!row || Number(row.event_seq) <= importEventSeq) return false;
  const event = db.prepare('SELECT source FROM ticket_events WHERE id = ? AND ticket_id = ?').get(row.event_seq, ticketId);
  return event?.source !== 'linear-import';
}

function updateExisting(db, issue, ticketId, fields, now, actor) {
  const created = db.prepare("SELECT id FROM ticket_events WHERE ticket_id = ? AND event_type = 'created' AND source = 'linear-import' ORDER BY id LIMIT 1").get(ticketId);
  const importEventSeq = Number(created?.id ?? 0);
  const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!row) return { changed: [], conflicts: [] };
  const conflicts = [];
  const applied = [];
  const before = {};
  const after = {};
  const values = {};
  const state = importedState(issue);
  const next = {
    title: issue.title,
    description: issue.description,
    state: state.id,
    priority: Number.isInteger(issue.priority) && issue.priority >= 0 && issue.priority <= 4 ? issue.priority : 0,
    assignee: emailToUser(db, issue.assigneeEmail),
    labels: fields.includes('labels') ? labelsForIssue(db, issue, now, actorInfo(actor).userId) : [],
    due: issue.dueDate,
  };
  const currentLabels = db.prepare(`SELECT l.name FROM ticket_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.ticket_id = ? ORDER BY lower(l.name), l.name`).all(ticketId).map((label) => label.name);
  const targetLabelNames = issue.labels
    .map((label) => label.name)
    .filter((name, index, rows) => rows.findIndex((rowName) => normName(rowName) === normName(name)) === index);
  for (const field of fields) {
    const sourceValue = field === 'labels' ? currentLabels : field === 'state' ? row.state_id : field === 'priority' ? Number(row.priority)
      : field === 'assignee' ? row.assignee_user_id ?? null : field === 'due' ? row.due_date ?? null : row[field];
    const nextValue = field === 'labels' ? targetLabelNames : next[field];
    const equalLabels = field === 'labels' && sourceValue.length === nextValue.length && sourceValue.every((label, index) => normName(label) === normName(nextValue[index]));
    if (field !== 'labels' && JSON.stringify(sourceValue) === JSON.stringify(nextValue) || equalLabels) continue;
    if (changedForIssue(db, ticketId, importEventSeq, field)) {
      conflicts.push(field);
      continue;
    }
    const oldValue = sourceValue;
    before[field] = field === 'priority' ? PRIORITY_NAME[oldValue] : oldValue;
    after[field] = field === 'priority' ? PRIORITY_NAME[nextValue] : field === 'assignee' ? nextValue : field === 'labels'
      ? nextValue
      : field === 'state' ? state.key : field === 'due' ? nextValue : nextValue;
    values[field] = field === 'labels' ? next.labels : nextValue;
    applied.push(field);
  }
  if (applied.length) {
    for (const field of applied) {
      if (field === 'labels') {
        db.prepare('DELETE FROM ticket_labels WHERE ticket_id = ?').run(ticketId);
        for (const labelId of values.labels) db.prepare('INSERT INTO ticket_labels (ticket_id, label_id, created_at) VALUES (?, ?, ?)').run(ticketId, labelId, now);
      } else {
        db.prepare(`UPDATE tickets SET ${FIELD_COLUMN[field]} = ? WHERE id = ?`).run(values[field], ticketId);
      }
    }
    const isTransition = applied.includes('state');
    const seq = appendTicketEvent({
      db, ticketId, eventType: isTransition ? 'transitioned' : 'updated', actor: { type: 'system' }, source: 'linear-import',
      idempotencyKey: `linear-u:${issue.id}:${millis(issue.updatedAt)}`, createdAt: millis(issue.updatedAt), before, after,
    });
    db.prepare('UPDATE tickets SET updated_at = ?, updated_seq = ? WHERE id = ?').run(millis(issue.updatedAt), seq, ticketId);
    for (const field of applied) {
      db.prepare('INSERT OR REPLACE INTO ticket_field_versions (ticket_id, field, event_seq, actor_type, actor_id) VALUES (?, ?, ?, ?, NULL)')
        .run(ticketId, field, seq, 'system');
    }
    refreshTicketSearch(db, ticketId);
  }
  return { changed: applied, conflicts };
}

function addParentLinks(db, rows) {
  for (const row of rows) {
    const childExternalId = row.aliases.find((alias) => alias.provider === 'linear')?.externalId;
    if (!row.parentId || !childExternalId) continue;
    const childId = sourceAlias(db, childExternalId);
    const parentId = sourceAlias(db, row.parentId);
    if (!childId || !parentId || childId === parentId) continue;
    const existing = db.prepare('SELECT parent_ticket_id FROM tickets WHERE id = ?').get(childId);
    if (!existing?.parent_ticket_id) db.prepare('UPDATE tickets SET parent_ticket_id = ? WHERE id = ?').run(parentId, childId);
  }
}

function relationReaches(db, fromId, targetId) {
  return Boolean(db.prepare(`WITH RECURSIVE reach(id) AS (
      SELECT related_ticket_id FROM ticket_relations WHERE ticket_id = ? AND kind = 'blocks'
      UNION
      SELECT r.related_ticket_id FROM ticket_relations r JOIN reach ON r.ticket_id = reach.id WHERE r.kind = 'blocks')
    SELECT 1 FROM reach WHERE id = ? LIMIT 1`).get(fromId, targetId));
}

/**
 * One row per pair, as relations.mjs stores them: blocked_by is blocks with the ends swapped, duplicated_by is duplicates swapped,
 * relates_to is symmetric and stored once. A blocks cycle or a ticket over its limit of 100 relations is skipped and counted.
 */
function addRelations(db, rows) {
  const stats = { written: 0, existing: 0, skippedCycle: 0, skippedLimit: 0, missingTarget: 0 };
  if (!tableExists(db, 'ticket_relations')) return stats;
  const count = (id) => Number(db.prepare('SELECT COUNT(*) AS n FROM ticket_relations WHERE ticket_id = ? OR related_ticket_id = ?').get(id, id).n);
  for (const row of rows) {
    const externalId = row.aliases.find((alias) => alias.provider === 'linear')?.externalId;
    const ticketId = externalId ? sourceAlias(db, externalId) : null;
    if (!ticketId) continue;
    for (const relation of row.relations) {
      const otherId = sourceAlias(db, relation.relatedIssueId);
      if (!otherId) { stats.missingTarget++; continue; }
      if (otherId === ticketId) continue;
      const kind = normalizedRelationKind(relation.type);
      let from = ticketId, to = otherId, stored = kind;
      if (kind === 'blocked_by') { from = otherId; to = ticketId; stored = 'blocks'; }
      else if (kind === 'duplicated_by') { from = otherId; to = ticketId; stored = 'duplicates'; }
      const exists = db.prepare('SELECT 1 FROM ticket_relations WHERE ticket_id = ? AND related_ticket_id = ? AND kind = ?');
      if (exists.get(from, to, stored) || (stored === 'relates_to' && exists.get(to, from, stored))) { stats.existing++; continue; }
      if (stored === 'blocks' && relationReaches(db, to, from)) { stats.skippedCycle++; continue; }
      if (count(from) >= MAX_RELATIONS_PER_TICKET || count(to) >= MAX_RELATIONS_PER_TICKET) { stats.skippedLimit++; continue; }
      db.prepare(`INSERT INTO ticket_relations (id, ticket_id, related_ticket_id, kind, created_at, created_by_type, created_by_id)
        VALUES (?, ?, ?, ?, ?, 'system', NULL)`)
        .run(newId(), from, to, stored, Date.now());
      stats.written++;
    }
  }
  return stats;
}

function preservedRows(db, snapshot) {
  return snapshot.issues.flatMap((issue) => {
    const ticketId = sourceAlias(db, issue.id);
    if (!ticketId) return [];
    return [{
      key: formatKey(issue),
      ticketId,
      aliases: [{ provider: 'linear', externalId: issue.id }, { provider: 'linear-key', externalId: issue.identifier }],
      relations: issue.relations.map((relation) => ({ type: relation.type, relatedIssueId: relation.relatedIssueId })),
      projectId: issue.projectId,
      cycleId: issue.cycleId,
      milestoneId: issue.milestoneId,
      estimate: issue.estimate,
      parentId: issue.parentId,
    }];
  });
}

function sanitizePreservedRow(row) {
  if (!row || typeof row !== 'object' || !Array.isArray(row.aliases)) return null;
  return {
    key: String(row.key ?? ''),
    ticketId: String(row.ticketId ?? ''),
    aliases: row.aliases.filter((alias) => ['linear', 'linear-key'].includes(alias.provider) && typeof alias.externalId === 'string')
      .map((alias) => ({ provider: alias.provider, externalId: alias.externalId })),
    relations: Array.isArray(row.relations) ? row.relations.filter((relation) => typeof relation.type === 'string' && typeof relation.relatedIssueId === 'string')
      .map((relation) => ({ type: relation.type, relatedIssueId: relation.relatedIssueId })) : [],
    projectId: row.projectId ?? null,
    cycleId: row.cycleId ?? null,
    milestoneId: row.milestoneId ?? null,
    estimate: row.estimate ?? null,
    parentId: row.parentId ?? null,
  };
}

function readPreserved(out) {
  if (!out) return [];
  const file = path.join(out, 'preserved.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => {
    try { return sanitizePreservedRow(JSON.parse(line)); } catch { throw fail('The preserved sidecar is invalid.', 'preserved_read_failed'); }
  }).filter(Boolean);
}

function mergePreserved(db, priorRows, currentRows) {
  const byIssue = new Map();
  for (const row of priorRows) {
    const externalId = row.aliases.find((alias) => alias.provider === 'linear')?.externalId;
    if (externalId && sourceAlias(db, externalId)) byIssue.set(externalId, row);
  }
  for (const row of currentRows) {
    const externalId = row.aliases.find((alias) => alias.provider === 'linear')?.externalId;
    if (externalId && sourceAlias(db, externalId)) byIssue.set(externalId, row);
  }
  return [...byIssue.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function backfillPreservedAssignments(db, rows, tables) {
  for (const row of rows) {
    const externalId = row.aliases.find((alias) => alias.provider === 'linear')?.externalId;
    const ticketId = externalId ? sourceAlias(db, externalId) : null;
    if (!ticketId) continue;
    const { projectId, milestoneId } = ticketAssignment(db, tables.projects ? row.projectId : null, tables.milestones ? row.milestoneId : null);
    const assignments = [];
    if (tables.projects && projectId) assignments.push(['project_id', projectId]);
    if (tables.milestones && milestoneId) assignments.push(['milestone_id', milestoneId]);
    if (row.estimate != null && fieldExists(db, 'tickets', 'estimate')) assignments.push(['estimate', row.estimate]);
    for (const [column, value] of assignments) db.prepare(`UPDATE tickets SET ${column} = ? WHERE id = ? AND ${column} IS NULL`).run(value, ticketId);
    if (row.parentId) {
      const parentId = sourceAlias(db, row.parentId);
      if (parentId && parentId !== ticketId) db.prepare('UPDATE tickets SET parent_ticket_id = ? WHERE id = ? AND parent_ticket_id IS NULL').run(parentId, ticketId);
    }
  }
}

function writePreserved(out, rows) {
  if (!out) return;
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const target = path.join(out, 'preserved.jsonl');
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), { mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, target);
  fs.chmodSync(target, 0o600);
}

/** Apply an import in atomic 100-issue batches. */
/** @param {any} options @returns {any} */
export function applyImport({ db: dbArg, snapshot: rawSnapshot, actor, options = {} } = {}) {
  const db = getDb({ db: dbArg });
  try {
    requireWritable(options.readOnly ?? false);
    defaultActorWrite(actor);
  } catch (error) {
    return { ok: false, errorCode: error.code ?? 'forbidden', created: 0, updated: 0, conflicts: [], batches: 0 };
  }
  let snapshot;
  try { snapshot = normalizeSnapshot(rawSnapshot); } catch (error) {
    return { ok: false, errorCode: error.code ?? 'invalid_snapshot', created: 0, updated: 0, conflicts: [], batches: 0 };
  }
  const mode = options.mode ?? 'create';
  const delta = options.delta === true;
  if (!['create', 'update'].includes(mode)) return { ok: false, errorCode: 'invalid_mode', created: 0, updated: 0, conflicts: [], batches: 0 };
  const fields = [...new Set(options.fields ?? [])];
  if (fields.some((field) => !UPDATE_FIELDS.has(field))) return { ok: false, errorCode: 'invalid_fields', created: 0, updated: 0, conflicts: [], batches: 0 };
  const tables = Object.fromEntries(['projects', 'milestones', 'ticket_relations'].map((name) => [name, tableExists(db, name)]));
  let planned;
  try { planned = makeReport(db, snapshot, { ...options, mode }, tables); } catch (error) {
    return { ok: false, errorCode: error.code ?? 'plan_failed', created: 0, updated: 0, conflicts: [], batches: 0 };
  }
  if (planned.report.duplicateAliases.length) return { ok: false, errorCode: 'duplicate_alias', created: 0, updated: 0, conflicts: [], batches: 0, report: planned.report };
  let priorPreserved;
  try { priorPreserved = readPreserved(options.out); } catch (error) {
    return { ok: false, errorCode: error.code ?? 'preserved_read_failed', created: 0, updated: 0, conflicts: [], batches: 0 };
  }
  let preserved = priorPreserved;
  let created = 0;
  let updated = 0;
  let batches = 0;
  const conflicts = [];
  const results = [];
  let projectStats = null;
  let relationStats = null;
  const allIssues = planned.numbering.strategy === 'allocate'
    ? [...snapshot.issues].sort((a, b) => millis(a.createdAt) - millis(b.createdAt) || a.number - b.number || a.id.localeCompare(b.id))
    : [...snapshot.issues];
  for (let offset = 0; offset < allIssues.length; offset += BATCH_SIZE) {
    const batch = allIssues.slice(offset, offset + BATCH_SIZE);
    batches++;
    const batchStats = { created: 0, updated: 0, conflicts: [] };
    try {
      const made = inTransaction({ db }, () => {
        const tracker = db.prepare('SELECT id, prefix FROM trackers WHERE id = ?').get('trk_default');
        const now = Date.now();
        ensureCounter(db, tracker.id, tracker.prefix, now);
        if (offset === 0) {
          projectStats = insertProjectRows(db, snapshot, now, tables.projects, tables.milestones);
          importLabelCatalog(db, snapshot, now, actorInfo(actor).userId);
        }
        const batchResults = [];
        for (const issue of batch) {
          const existing = sourceAlias(db, issue.id);
          if (existing) {
            if (mode === 'update' && fields.length) {
              const update = updateExisting(db, issue, existing, fields, millis(issue.updatedAt), actor);
              batchStats.conflicts.push(...update.conflicts.map((field) => ({ key: formatKey(issue), field })));
              if (update.changed.length) batchStats.updated++;
            }
            if (delta) writeComments(db, issue, existing, millis(issue.createdAt), true);
            batchResults.push({ action: existing ? 'existing' : 'created', key: formatKey(issue) });
            continue;
          }
          const ticket = planned.numbering.strategy === 'allocate'
            ? createAllocatedTicketRows(db, issue, planned.numbering, actor, tables.projects, tables.milestones, { delta })
            : createKeptTicketRows(db, issue, planned.numbering, Date.now(), actor, tables.projects, tables.milestones, { delta });
          batchStats.created++;
          batchResults.push({ action: 'created', key: ticket.key });
        }
        if (planned.numbering.strategy === 'keep' && batchResults.some((row) => row.action === 'created')) {
          const maxNumber = Math.max(...batch.filter((issue) => rowIsCreated(batchResults, issue)).map((issue) => issue.number));
          const floor = Math.max(Number(db.prepare('SELECT next_number FROM ticket_counters WHERE scope = ? AND prefix = ?').get(tracker.id, tracker.prefix)?.next_number ?? 1), maxNumber + 1);
          db.prepare('UPDATE ticket_counters SET next_number = ?, updated_at = ? WHERE scope = ? AND prefix = ?').run(floor, Date.now(), tracker.id, tracker.prefix);
        }
        return batchResults;
      });
      created += batchStats.created;
      updated += batchStats.updated;
      conflicts.push(...batchStats.conflicts);
      results.push(...made);
    } catch {
      try {
        preserved = mergePreserved(db, priorPreserved, preservedRows(db, snapshot));
        writePreserved(options.out, preserved);
      } catch { /* preserve earlier committed batches when possible */ }
      return {
        ok: false, errorCode: 'batch_failed', failedBatch: batches, created, updated, conflicts, batches,
        report: planned.report,
      };
    }
  }
  try {
    inTransaction({ db }, () => {
      const lateProjects = insertProjectRows(db, snapshot, Date.now(), tables.projects, tables.milestones);
      if (!projectStats || lateProjects.projects || lateProjects.milestones) projectStats = projectStats ? Object.fromEntries(Object.entries(projectStats).map(([k, v]) => [k, v + lateProjects[k]])) : lateProjects;
      importLabelCatalog(db, snapshot, Date.now(), actorInfo(actor).userId);
      preserved = mergePreserved(db, priorPreserved, preservedRows(db, snapshot));
      backfillPreservedAssignments(db, preserved, tables);
      addParentLinks(db, preserved);
      relationStats = addRelations(db, preserved);
      for (const issue of snapshot.issues) {
        const ticketId = sourceAlias(db, issue.id);
        if (ticketId) refreshTicketSearch(db, ticketId);
      }
    });
  } catch {
    try {
      preserved = mergePreserved(db, priorPreserved, preservedRows(db, snapshot));
      writePreserved(options.out, preserved);
    } catch { /* preserve committed tickets when possible */ }
    return { ok: false, errorCode: 'backfill_failed', created, updated, conflicts, batches, report: planned.report };
  }
  try { writePreserved(options.out, preserved); } catch {
    return { ok: false, errorCode: 'preserved_write_failed', created, updated, conflicts, batches, report: planned.report };
  }
  return { ok: true, created, updated, conflicts, batches, results, projects: projectStats, relations: relationStats, report: planned.report };
}

function rowIsCreated(batchResults, issue) {
  return batchResults.some((row) => row.key === formatKey(issue) && row.action === 'created');
}

export { BATCH_SIZE, SNAPSHOT_VERSION };
