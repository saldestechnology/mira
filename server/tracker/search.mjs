import { ticketAccess } from './access.mjs';
import { actorInfo, getDb, invalid, limitExceeded, OpsError, utcStartOfDay, validCalendarDate } from './shared.mjs';

const COMMENT_COUNT_LIMIT = 10_000;
const INDEX_BYTES_LIMIT = 64 * 1024;
const PAGE_MAX = 50;
const PRIORITY_VALUES = new Map(['none', 'urgent', 'high', 'medium', 'low'].map((name, value) => [name, value]));
const LIST_FILTERS = new Set(['state', 'label', 'assignee', 'creator', 'priority', 'category', 'project', 'milestone']);

/**
 * The FTS snippet marks matches with control characters 1 and 2 (ticket text can never contain them: input is refused or
 * cleaned). Everything else is HTML-escaped, then the markers become the only tags the snippet can hold: <mark>…</mark>.
 */
export function markedSnippet(raw) {
  if (typeof raw !== 'string') return raw ?? null;
  const escaped = raw.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  return escaped.replaceAll('\u0001', '<mark>').replaceAll('\u0002', '</mark>');
}

export function buildFtsQuery(query) {
  const terms = query.match(/[\p{L}\p{M}\p{N}_]+/gu) ?? [];
  return terms.map((term, index) => {
    const quoted = `"${term.replaceAll('"', '""')}"`;
    return index === terms.length - 1 && Array.from(term).length >= 2 ? `${quoted}*` : quoted;
  }).join(' AND ');
}

function titleFtsQuery(query) {
  const terms = query.match(/[\p{L}\p{M}\p{N}_]+/gu) ?? [];
  return terms.length ? `title : (${terms.map((term, index) => {
    const quoted = `"${term.replaceAll('"', '""')}"`;
    return index === terms.length - 1 && Array.from(term).length >= 2 ? `${quoted}*` : quoted;
  }).join(' AND ')})` : '';
}

function boundedText(value, maxBytes) {
  let bytes = 0;
  let out = '';
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    out += character;
  }
  return out;
}

function fitComments(db, ticketId, maxBytes) {
  const rows = db.prepare(
    `SELECT body FROM ticket_comments WHERE ticket_id = ? AND deleted_at IS NULL
      ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(ticketId, COMMENT_COUNT_LIMIT);
  const selected = [];
  let bytes = 0;
  for (const row of rows) {
    const body = String(row.body);
    const size = Buffer.byteLength(body, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    selected.push(body);
  }
  return selected.reverse().join('\n\n');
}

/** Rebuild one FTS row from canonical ticket data; invoke in the source mutation transaction. */
export function refreshTicketSearch(dbOrContext, ticketId) {
  const db = getDb(dbOrContext?.db || dbOrContext?.directory
    ? { db: dbOrContext.db, directory: dbOrContext.directory }
    : { db: dbOrContext });
  const ticket = db.prepare('SELECT id, key, title, description FROM tickets WHERE id = ?').get(ticketId);
  db.prepare('DELETE FROM ticket_search WHERE ticket_id = ?').run(ticketId);
  if (!ticket) return;
  const aliases = db.prepare(
    'SELECT external_id, display_key FROM ticket_aliases WHERE ticket_id = ? ORDER BY provider, external_id',
  ).all(ticketId);
  const aliasText = aliases.flatMap((row) => [row.display_key, row.external_id]).filter(Boolean).join(' ');
  let remaining = INDEX_BYTES_LIMIT;
  const title = boundedText(ticket.title, remaining);
  remaining -= Buffer.byteLength(title, 'utf8');
  const identifiers = boundedText(ticket.key, remaining);
  remaining -= Buffer.byteLength(identifiers, 'utf8');
  const description = boundedText(ticket.description, remaining);
  remaining -= Buffer.byteLength(description, 'utf8');
  const indexedAliases = boundedText(aliasText, remaining);
  remaining -= Buffer.byteLength(indexedAliases, 'utf8');
  db.prepare(
    `INSERT INTO ticket_search (ticket_id, title, description, comments, identifiers, aliases)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(ticketId, title, description, fitComments(db, ticketId, remaining), identifiers, indexedAliases);
}

function invalidFilter(token, message = `Invalid filter: ${token}`) {
  throw new OpsError('invalid_filter', message, token);
}

function resolveMember(db, value, filterToken, field) {
  const rows = db.prepare(
    `SELECT id FROM users WHERE disabled = 0 AND role IN ('owner', 'admin', 'member')
      AND (name = ? COLLATE NOCASE OR email = ? COLLATE NOCASE) ORDER BY id`,
  ).all(value, value);
  if (rows.length > 1) invalidFilter(filterToken, `Ambiguous ${field} filter: ${filterToken}`);
  return rows[0]?.id ?? null;
}

function filterValues(field, value, token) {
  if (!LIST_FILTERS.has(field) && value.includes(',')) invalidFilter(token);
  const values = LIST_FILTERS.has(field) ? value.split(',').map((item) => item.trim()) : [value];
  if (values.length > 20 || values.some((item) => !item)) invalidFilter(token);
  return values;
}

function addPredicate(clauses, params, expression, values, negated) {
  clauses.push(negated ? `NOT COALESCE((${expression}), 0)` : `(${expression})`);
  params.push(...values);
}

function resolveFilterKey(db, actor, value, token) {
  const row = db.prepare('SELECT id FROM tickets WHERE key = ? COLLATE NOCASE').get(value);
  if (!row) invalidFilter(token);
  try {
    ticketAccess(actor, row);
  } catch {
    invalidFilter(token);
  }
  return row.id;
}

function dateValue(value, prefix, token) {
  if (!value.toLowerCase().startsWith(prefix)) invalidFilter(token);
  const date = value.slice(prefix.length);
  if (!validCalendarDate(date)) invalidFilter(token);
  return date;
}

function utcWeek(now) {
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  const first = start.toISOString().slice(0, 10);
  start.setUTCDate(start.getUTCDate() + 6);
  return [first, start.toISOString().slice(0, 10)];
}

function addParsedFilter(db, actor, token, now, clauses, params, canSee) {
  const negated = token.startsWith('-');
  const filterToken = negated ? token.slice(1) : token;
  const colon = filterToken.indexOf(':');
  if (colon < 1) invalidFilter(token);
  const field = filterToken.slice(0, colon).toLowerCase();
  const value = filterToken.slice(colon + 1).trim();
  if (!value && field !== 'is') invalidFilter(token);
  const values = filterValues(field, value, token);
  switch (field) {
    case 'assignee': {
      if (!canSee) {
        addPredicate(clauses, params, '0 = 1', [], negated);
        return;
      }
      const userIds = [];
      let includesNone = false;
      for (const item of values) {
        const normalized = item.toLowerCase();
        if (normalized === 'none') {
          includesNone = true;
          continue;
        }
        let userId;
        if (normalized === 'me') userId = actorInfo(actor).userId;
        else {
          if (item.length > 200) invalidFilter(token);
          userId = resolveMember(db, item, token, 'assignee');
        }
        if (userId && !userIds.includes(userId)) userIds.push(userId);
      }
      const matches = [];
      const matchParams = [];
      if (includesNone) matches.push('t.assignee_user_id IS NULL');
      if (userIds.length) {
        matches.push(`t.assignee_user_id IN (${userIds.map(() => '?').join(', ')})`);
        matchParams.push(...userIds);
      }
      addPredicate(clauses, params, matches.length ? matches.join(' OR ') : '0 = 1', matchParams, negated);
      return;
    }
    case 'state': {
      const matches = values.map(() => '(fs.state_key = ? COLLATE NOCASE OR fs.name = ? COLLATE NOCASE)').join(' OR ');
      addPredicate(clauses, params, `EXISTS (
        SELECT 1 FROM ticket_states fs WHERE fs.id = t.state_id AND fs.archived_at IS NULL
          AND (${matches})
      )`, values.flatMap((item) => [item, item]), negated);
      return;
    }
    case 'label': {
      const matches = values.map(() => 'fLabel.name = ? COLLATE NOCASE').join(' OR ');
      addPredicate(clauses, params, `EXISTS (
        SELECT 1 FROM ticket_labels fl JOIN labels fLabel ON fLabel.id = fl.label_id
        WHERE fl.ticket_id = t.id AND fLabel.archived_at IS NULL AND (${matches})
      )`, values, negated);
      return;
    }
    case 'creator': {
      const matches = [];
      const matchParams = [];
      for (const item of values) {
        const normalized = item.toLowerCase();
        if (normalized === 'agent') matches.push("t.created_by_type = 'mcp_token'");
        else if (normalized === 'integration') matches.push("t.created_by_type = 'integration'");
        else if (normalized === 'import') matches.push("(t.source = 'linear-import' OR t.created_by_type = 'import')");
        else if (normalized === 'system') matches.push("t.created_by_type = 'system'");
        else {
          const userId = normalized === 'me' ? actorInfo(actor).userId : resolveMember(db, item, token, 'creator');
          if (userId) {
            matches.push("(t.created_by_type = 'user' AND t.created_by_id = ?)");
            matchParams.push(userId);
          }
        }
      }
      addPredicate(clauses, params, matches.length ? matches.join(' OR ') : '0 = 1', matchParams, negated);
      return;
    }
    case 'priority': {
      const priorities = values.map((item) => PRIORITY_VALUES.get(item.toLowerCase()));
      if (priorities.some((priority) => priority === undefined)) invalidFilter(token);
      addPredicate(clauses, params, `t.priority IN (${priorities.map(() => '?').join(', ')})`, priorities, negated);
      return;
    }
    case 'category': {
      const categories = values.map((item) => item.toLowerCase());
      if (categories.some((category) => !['backlog', 'unstarted', 'started', 'completed', 'canceled'].includes(category))) invalidFilter(token);
      addPredicate(clauses, params, `fs.category IN (${categories.map(() => '?').join(', ')})`, categories, negated);
      return;
    }
    case 'project':
    case 'milestone': {
      const includesNone = values.some((item) => item.toLowerCase() === 'none');
      const names = values.filter((item) => item.toLowerCase() !== 'none');
      const matches = [];
      const matchParams = [];
      if (includesNone) matches.push(field === 'project' ? 't.project_id IS NULL' : 't.milestone_id IS NULL');
      for (const name of names) {
        const table = field === 'project' ? 'projects' : 'milestones';
        const ticketColumn = field === 'project' ? 'project_id' : 'milestone_id';
        const found = db.prepare(`SELECT 1 FROM ${table} WHERE name = ? COLLATE NOCASE LIMIT 1`).get(name);
        if (!found) invalidFilter(token);
        matches.push(`EXISTS (SELECT 1 FROM ${table} fp WHERE fp.id = t.${ticketColumn} AND fp.name = ? COLLATE NOCASE)`);
        matchParams.push(name);
      }
      addPredicate(clauses, params, matches.length ? matches.join(' OR ') : '0 = 1', matchParams, negated);
      return;
    }
    case 'due': {
      const today = new Date(now).toISOString().slice(0, 10);
      const normalized = value.toLowerCase();
      if (normalized === 'none') {
        addPredicate(clauses, params, 't.due_date IS NULL', [], negated);
        return;
      }
      if (normalized === 'overdue') {
        addPredicate(clauses, params, `t.due_date < ? AND t.archived_at IS NULL AND fs.category NOT IN ('completed', 'canceled')`, [today], negated);
        return;
      }
      if (normalized === 'today') {
        addPredicate(clauses, params, 't.due_date = ?', [today], negated);
        return;
      }
      if (normalized === 'this-week') {
        const [first, last] = utcWeek(now);
        addPredicate(clauses, params, 't.due_date >= ? AND t.due_date <= ?', [first, last], negated);
        return;
      }
      if (normalized.startsWith('before-')) {
        const date = dateValue(value, 'before-', token);
        addPredicate(clauses, params, 't.due_date < ?', [date], negated);
        return;
      }
      if (normalized.startsWith('after-')) {
        const date = dateValue(value, 'after-', token);
        addPredicate(clauses, params, 't.due_date >= ?', [date], negated);
        return;
      }
      invalidFilter(token);
      break;
    }
    case 'updated':
    case 'created': {
      const normalized = value.toLowerCase();
      let date;
      if (normalized.startsWith('after-')) date = dateValue(value, 'after-', token);
      else if (field === 'updated' && normalized.startsWith('before-')) date = dateValue(value, 'before-', token);
      else if (field === 'created' && normalized.startsWith('before-')) date = dateValue(value, 'before-', token);
      else invalidFilter(token);
      const lowerBound = normalized.startsWith('after-');
      const column = field === 'updated' ? 't.updated_at' : 't.created_at';
      addPredicate(clauses, params, `${column} ${lowerBound ? '>=' : '<'} ?`, [utcStartOfDay(date)], negated);
      return;
    }
    case 'has': {
      const normalized = value.toLowerCase();
      let expression;
      if (normalized === 'link') expression = '0 = 1';
      else if (normalized === 'relation') expression = 'EXISTS (SELECT 1 FROM ticket_relations hr WHERE hr.ticket_id = t.id OR hr.related_ticket_id = t.id)';
      else if (normalized === 'parent') expression = 't.parent_ticket_id IS NOT NULL';
      else if (normalized === 'sub') expression = 'EXISTS (SELECT 1 FROM tickets child WHERE child.parent_ticket_id = t.id)';
      else invalidFilter(token);
      addPredicate(clauses, params, expression, [], negated);
      return;
    }
    case 'is': {
      const normalized = value.toLowerCase();
      let expression;
      if (normalized === 'archived') expression = 't.archived_at IS NOT NULL';
      else if (normalized === 'blocked') expression = `EXISTS (
        SELECT 1 FROM ticket_relations br JOIN tickets blocker ON blocker.id = br.ticket_id
        JOIN ticket_states blocker_state ON blocker_state.id = blocker.state_id
        WHERE br.related_ticket_id = t.id AND br.kind = 'blocks'
          AND blocker_state.category NOT IN ('completed', 'canceled')
      )`;
      else if (normalized === 'blocking') expression = `EXISTS (
        SELECT 1 FROM ticket_relations br JOIN tickets blocked ON blocked.id = br.related_ticket_id
        JOIN ticket_states blocked_state ON blocked_state.id = blocked.state_id
        WHERE br.ticket_id = t.id AND br.kind = 'blocks'
          AND blocked_state.category NOT IN ('completed', 'canceled')
      )`;
      else invalidFilter(token);
      addPredicate(clauses, params, expression, [], negated);
      return;
    }
    case 'parent':
    case 'blocks':
    case 'blocked-by':
    case 'relates':
    case 'duplicates':
    case 'duplicated-by': {
      const relatedId = resolveFilterKey(db, actor, value, token);
      let expression;
      if (field === 'parent') expression = 't.parent_ticket_id = ?';
      else if (field === 'blocks') expression = "EXISTS (SELECT 1 FROM ticket_relations rr WHERE rr.ticket_id = t.id AND rr.related_ticket_id = ? AND rr.kind = 'blocks')";
      else if (field === 'blocked-by') expression = "EXISTS (SELECT 1 FROM ticket_relations rr WHERE rr.ticket_id = ? AND rr.related_ticket_id = t.id AND rr.kind = 'blocks')";
      else if (field === 'relates') expression = "EXISTS (SELECT 1 FROM ticket_relations rr WHERE ((rr.ticket_id = t.id AND rr.related_ticket_id = ?) OR (rr.related_ticket_id = t.id AND rr.ticket_id = ?)) AND rr.kind = 'relates_to')";
      else if (field === 'duplicates') expression = "EXISTS (SELECT 1 FROM ticket_relations rr WHERE rr.ticket_id = t.id AND rr.related_ticket_id = ? AND rr.kind = 'duplicates')";
      else expression = "EXISTS (SELECT 1 FROM ticket_relations rr WHERE rr.ticket_id = ? AND rr.related_ticket_id = t.id AND rr.kind = 'duplicates')";
      const keyParams = field === 'relates' ? [relatedId, relatedId] : [relatedId];
      addPredicate(clauses, params, expression, keyParams, negated);
      return;
    }
    default:
      invalidFilter(token);
  }
}

function visible(actor) {
  try {
    ticketAccess(actor, { id: 'visibility-check' });
    return true;
  } catch {
    return false;
  }
}

function parseCursor(cursor, query, filters) {
  if (cursor == null) return null;
  if (typeof cursor !== 'string' || cursor.length > 2048) throw invalid('cursor', 'Invalid cursor');
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (value.query !== query || JSON.stringify(value.filters) !== JSON.stringify(filters) ||
      !Number.isInteger(value.rank) || value.rank < 0 || value.rank > 4 ||
      !Number.isFinite(value.updatedAt) || typeof value.id !== 'string') throw new Error('bad cursor');
    return value;
  } catch {
    throw invalid('cursor', 'Invalid or mismatched cursor');
  }
}

function makeCursor(row, query, filters) {
  return Buffer.from(JSON.stringify({ query, filters, rank: row.rank_bucket, updatedAt: row.updated_at, id: row.id })).toString('base64url');
}

function likePrefix(value) {
  return `${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function makeRankedCte({ query, filters, actor, db, now, useFts }) {
  const termsQuery = buildFtsQuery(query);
  const titleQuery = titleFtsQuery(query);
  const rawQuery = query.trim();
  const canSee = visible(actor);
  const clauses = [canSee ? '1 = 1' : '0 = 1'];
  const filterParams = [];
  for (const token of filters) addParsedFilter(db, actor, token, now, clauses, filterParams, canSee);
  if (!filters.some((filter) => filter.toLowerCase() === 'is:archived')) clauses.push('t.archived_at IS NULL');
  const rank = useFts ? `CASE
    WHEN lower(t.key) = lower(?) OR EXISTS (
      SELECT 1 FROM ticket_aliases exactAlias WHERE exactAlias.ticket_id = t.id
        AND (lower(exactAlias.external_id) = lower(?) OR lower(COALESCE(exactAlias.display_key, '')) = lower(?))
    ) THEN 0
    WHEN lower(t.title) LIKE lower(?) ESCAPE '\\' THEN 1
    WHEN title_matches.rowid IS NOT NULL THEN 2
    ELSE 3 END` : '0';
  const rankParams = useFts ? [rawQuery, rawQuery, rawQuery, likePrefix(rawQuery)] : [];
  const ftsCtes = useFts
    ? 'matched AS (SELECT rowid, ticket_id FROM ticket_search WHERE ticket_search MATCH ?), title_matches AS (SELECT rowid FROM ticket_search WHERE ticket_search MATCH ?),'
    : '';
  const ftsParams = useFts ? [termsQuery, titleQuery] : [];
  const joins = useFts ? 'JOIN matched ON matched.ticket_id = t.id JOIN ticket_search ON ticket_search.rowid = matched.rowid LEFT JOIN title_matches ON title_matches.rowid = matched.rowid' : '';
  const sql = `WITH ${ftsCtes} ranked AS (
    SELECT t.id, t.key, t.title, t.description, t.state_id, t.assignee_user_id, t.project_id, t.milestone_id,
      t.due_date, t.created_at, t.updated_at, t.updated_seq, t.archived_at,
      fs.state_key, fs.name AS state_name, fs.category, au.name AS assignee_name,
      ${rank} AS rank_bucket${useFts ? ', ticket_search.rowid AS search_rowid' : ', NULL AS search_rowid'}
    FROM tickets t
    JOIN ticket_states fs ON fs.id = t.state_id
    LEFT JOIN users au ON au.id = t.assignee_user_id
    ${joins}
    WHERE ${clauses.join(' AND ')}
  )`;
  return { sql, params: [...ftsParams, ...rankParams, ...filterParams], rawQuery, termsQuery, useFts };
}

/** @param {any} options */
function runTicketSearch({ directory, db: dbArg, actor, query = '', filters = [], limit = 20, cursor = null, now = Date.now() } = {}, allowEmptyQuery = false) {
  const db = getDb({ directory, db: dbArg });
  if (typeof query !== 'string') throw invalid('query', 'Must be text');
  if (Array.from(query).length > 512) throw limitExceeded('Search query is limited to 512 characters', 'query');
  if (!Array.isArray(filters) || filters.some((filter) => typeof filter !== 'string')) throw invalid('filters', 'Filters must be a list of text tokens');
  if (filters.length > 20) throw limitExceeded('Search allows at most 20 filters', 'filters');
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) throw invalid('limit', `Must be 1 to ${PAGE_MAX}`);
  const normalizedQuery = query.trim();
  const normalizedFilters = filters.map((filter) => filter.trim());
  const terms = buildFtsQuery(normalizedQuery);
  if (!terms && !allowEmptyQuery) throw invalid('query', 'Enter something to search for');
  const cte = makeRankedCte({ query: normalizedQuery, filters: normalizedFilters, actor, db, now, useFts: Boolean(terms) });
  const parsedCursor = parseCursor(cursor, normalizedQuery, normalizedFilters);
  const total = Number(db.prepare(`${cte.sql} SELECT COUNT(*) AS n FROM ranked`).get(...cte.params).n);

  const pageConditions = [];
  const pageParams = [];
  if (cte.useFts) {
    pageConditions.push('ticket_search MATCH ?');
    pageParams.push(cte.termsQuery);
  }
  if (parsedCursor) {
    pageConditions.push('(rank_bucket > ? OR (rank_bucket = ? AND (updated_at < ? OR (updated_at = ? AND id > ?))))');
    pageParams.push(parsedCursor.rank, parsedCursor.rank, parsedCursor.updatedAt, parsedCursor.updatedAt, parsedCursor.id);
  }
  const pageClause = pageConditions.length ? `WHERE ${pageConditions.join(' AND ')}` : '';
  const rows = db.prepare(
    `${cte.sql}
     SELECT ranked.*, ${cte.useFts ? "snippet(ticket_search, -1, char(1), char(2), '…', 16)" : 'NULL'} AS snippet
     FROM ranked ${cte.useFts ? 'JOIN ticket_search ON ticket_search.rowid = ranked.search_rowid' : ''}
     ${pageClause}
     ORDER BY rank_bucket ASC, updated_at DESC, id ASC LIMIT ?`,
  ).all(...cte.params, ...pageParams, limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    entries: page.map((row) => ({
      id: row.id,
      key: row.key,
      title: row.title,
      state: { key: row.state_key, name: row.state_name, category: row.category },
      assignee: row.assignee_user_id ? { userId: row.assignee_user_id, name: row.assignee_name } : null,
      project: null,
      due: row.due_date,
      archivedAt: row.archived_at,
      updatedAt: row.updated_at,
      updatedSeq: row.updated_seq,
      snippet: markedSnippet(row.snippet),
    })),
    total,
    next: hasMore && page.length ? makeCursor(page[page.length - 1], normalizedQuery, normalizedFilters) : null,
  };
}

/** @param {any} options */
export function searchTickets(options = {}) {
  return runTicketSearch(options);
}

/** @param {any} options */
export function listTickets(options = {}) {
  return runTicketSearch({ ...options, query: '' }, true);
}

export const SEARCH_LIMITS = Object.freeze({ queryCodePoints: 512, filters: 20, page: PAGE_MAX, comments: COMMENT_COUNT_LIMIT, textBytes: INDEX_BYTES_LIMIT });
