import fs from 'node:fs';
import path from 'node:path';

const GRAPHQL_URL = 'https://api.linear.app/graphql';
const PAGE_SIZE = 100;
const MAX_RETRIES = 5;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 30_000;
const VERSION = 1;
const secrets = new Set();

const CONNECTIONS = Object.freeze({
  teams: { field: 'teams', type: 'Team', selection: 'id key name private archivedAt' },
  users: { field: 'users', type: 'User', selection: 'id name email active' },
  states: { field: 'workflowStates', type: 'WorkflowState', selection: 'id name type team { id }' },
  labels: { field: 'issueLabels', type: 'IssueLabel', selection: 'id name color archivedAt team { id }' },
  projects: { field: 'projects', type: 'Project', selection: 'id name description state createdAt updatedAt archivedAt teams { nodes { id } }' },
  cycles: { field: 'cycles', type: 'Cycle', selection: 'id name description startsAt endsAt completedAt archivedAt team { id }' },
  milestones: { field: 'projectMilestones', type: 'ProjectMilestone', selection: 'id name description targetDate project { id } createdAt updatedAt archivedAt' },
  issues: { field: 'issues', type: 'Issue', selection: 'id identifier number title description priority estimate state { id name type } assignee { id name email } creator { id name email } labels { nodes { id name color } } project { id } cycle { id } projectMilestone { id } parent { id } dueDate createdAt updatedAt archivedAt completedAt canceledAt url team { id key name private }' },
  comments: { field: 'comments', type: 'Comment', selection: 'id body createdAt updatedAt deletedAt: archivedAt user { id name email } parent { id } issue { id }' },
  relations: { field: 'issueRelations', type: 'IssueRelation', selection: 'id type issue { id } relatedIssue { id }' },
  attachments: { field: 'attachments', type: 'Attachment', selection: 'id url title issue { id }' },
});

function rememberSecret(secret) {
  if (typeof secret === 'string' && secret) secrets.add(secret);
}

function scrubString(value) {
  let result = String(value);
  for (const secret of secrets) result = result.replaceAll(secret, '[REDACTED]');
  return result;
}

function scrubValue(value) {
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [scrubString(key), scrubValue(child)]));
  }
  return value;
}

/** The only function that reads LINEAR_API_KEY. */
async function defaultTransport({ query, variables, operationName }) {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) throw new Error('LINEAR_API_KEY is required in the environment.');
  rememberSecret(apiKey);
  try {
    const response = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: apiKey },
      body: JSON.stringify({ query, variables, operationName }),
    });
    let body;
    try { body = await response.json(); } catch { body = {}; }
    return { status: response.status, headers: response.headers, body: scrubValue(body) };
  } catch {
    throw new Error('Linear transport failed.');
  }
}

function header(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const key = Object.keys(headers).find((entry) => entry.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}

function headerDelay(headers) {
  const retryAfter = header(headers, 'retry-after');
  if (retryAfter != null && Number.isFinite(Number(retryAfter))) return Math.max(0, Number(retryAfter) * 1000);
  const retryAfterMs = header(headers, 'retry-after-ms');
  if (retryAfterMs != null && Number.isFinite(Number(retryAfterMs))) return Math.max(0, Number(retryAfterMs));
  const reset = header(headers, 'x-ratelimit-requests-reset') ?? header(headers, 'x-ratelimit-reset');
  if (reset != null) {
    const number = Number(reset);
    if (Number.isFinite(number)) return Math.max(0, (number < 1e12 ? number * 1000 : number) - Date.now());
    const date = Date.parse(String(reset));
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return null;
}

function sleepFor(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function responseParts(result) {
  if (result && typeof result.json === 'function' && typeof result.status === 'number') {
    let body;
    try { body = await result.json(); } catch { body = {}; }
    return { status: result.status, headers: result.headers, body: scrubValue(body) };
  }
  if (result && typeof result === 'object' && ('body' in result || 'data' in result) && 'status' in result) {
    return { status: Number(result.status), headers: result.headers, body: scrubValue(result.body ?? result.data ?? {}) };
  }
  return { status: 200, headers: result?.headers ?? null, body: scrubValue(result ?? {}) };
}

function safeRecord(record, request, response) {
  const safeRequest = scrubValue({ operationName: request.operationName, query: request.query, variables: request.variables });
  const safeHeaders = {};
  for (const name of ['retry-after', 'retry-after-ms', 'x-ratelimit-requests-remaining', 'x-ratelimit-requests-reset', 'x-ratelimit-reset']) {
    const value = header(response.headers, name);
    if (value != null) safeHeaders[name] = scrubString(value);
  }
  const safeResponse = scrubValue({ status: response.status, headers: safeHeaders, body: response.body });
  if (typeof record === 'function') return record(safeRequest, safeResponse);
  if (typeof record !== 'string') return undefined;
  fs.mkdirSync(record, { recursive: true, mode: 0o700 });
  const files = fs.readdirSync(record).filter((name) => /^\d{6}\.json$/.test(name)).sort();
  const file = path.join(record, `${String(files.length + 1).padStart(6, '0')}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ request: safeRequest, response: safeResponse }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(file, 0o600);
  return undefined;
}

function collectionResponse(body, name) {
  const errors = body?.errors;
  if (Array.isArray(errors) && errors.length) throw new Error(`Linear GraphQL query failed for ${name}.`);
  const connection = body?.data?.[CONNECTIONS[name].field];
  if (!connection) throw new Error(`Linear GraphQL response omitted ${name}.`);
  const nodes = Array.isArray(connection.nodes) ? connection.nodes : Array.isArray(connection.edges)
    ? connection.edges.map((edge) => edge.node).filter(Boolean) : null;
  if (!nodes || !connection.pageInfo) throw new Error(`Linear GraphQL response has an invalid ${name} connection.`);
  return { nodes, pageInfo: connection.pageInfo };
}

function makeQuery(name, since) {
  const { field, selection } = CONNECTIONS[name];
  const hasSince = since && ['issues', 'comments'].includes(name);
  const filterArg = !hasSince ? '' : name === 'comments'
    ? ', filter: { or: [{ createdAt: { gt: $since } }, { updatedAt: { gt: $since } }] }'
    : ', filter: { updatedAt: { gt: $since } }';
  const sinceDecl = hasSince ? ', $since: DateTime!' : '';
  const query = `query Linear${name[0].toUpperCase()}${name.slice(1)}($first: Int!, $after: String, $includeArchived: Boolean!${sinceDecl}) { ${field}(first: $first, after: $after, includeArchived: $includeArchived${filterArg}) { nodes { ${selection} } pageInfo { endCursor hasNextPage } } }`;
  return { query };
}

function countObject(collections) {
  return Object.fromEntries(Object.entries(collections).map(([key, values]) => [key, values.length]));
}

function appendUnique(target, nodes) {
  const seen = new Set(target.map((node) => node?.id).filter(Boolean));
  for (const node of nodes) {
    if (node?.id && seen.has(node.id)) continue;
    if (node?.id) seen.add(node.id);
    target.push(node);
  }
}

/**
 * Fetches all source collections. Checkpoint metadata contains only cursors and counts; the optional `partial`
 * argument passed to onCheckpoint is separate data for a mode-0600 resume file.
 * @param {{transport?: Function, since?: string, onCheckpoint?: Function, resume?: any, record?: string|Function,
 *   sleep?: Function, random?: Function, maxRetries?: number}} [options]
 */
export async function fetchSnapshot({
  transport = defaultTransport,
  since,
  onCheckpoint,
  resume,
  record,
  sleep = sleepFor,
  random = Math.random,
  maxRetries = MAX_RETRIES,
} = {}) {
  if (since != null && (!Number.isFinite(Date.parse(since)) || typeof since !== 'string')) throw new Error('since must be an ISO timestamp.');
  const checkpoint = resume?.checkpoint ?? resume ?? {};
  const collections = Object.fromEntries(Object.keys(CONNECTIONS).map((name) => [name, []]));
  for (const [name, items] of Object.entries(resume?.partial ?? {})) if (collections[name] && Array.isArray(items)) appendUnique(collections[name], items);
  const cursors = { ...checkpoint.cursors };
  const completed = { ...checkpoint.completed };
  const fetchedAt = resume?.fetchedAt ?? new Date().toISOString();

  async function requestPage(request, resource) {
    let attempt = 0;
    while (true) {
      let parts;
      try {
        parts = await responseParts(await transport(request));
      } catch {
        if (attempt >= maxRetries) throw new Error(`Linear request failed for ${resource}.`);
        const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
        try { await sleep(backoff + Math.floor(random() * 251)); } catch { throw new Error('Linear retry wait failed.'); }
        attempt++;
        continue;
      }
      try { await safeRecord(record, request, parts); } catch { throw new Error('Linear response recording failed.'); }
      if (parts.status === 429 || parts.status >= 500 && parts.status <= 599) {
        if (attempt >= maxRetries) throw new Error(`Linear request failed for ${resource} (HTTP ${parts.status}).`);
        const retry = headerDelay(parts.headers);
        const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
        try { await sleep(Math.max(retry ?? 0, backoff) + Math.floor(random() * 251)); } catch { throw new Error('Linear retry wait failed.'); }
        attempt++;
        continue;
      }
      if (parts.status < 200 || parts.status >= 300) throw new Error(`Linear request failed for ${resource} (HTTP ${parts.status}).`);
      if (Number(header(parts.headers, 'x-ratelimit-requests-remaining')) === 0) {
        const delay = headerDelay(parts.headers);
        if (delay != null && delay > 0) await sleep(delay);
      }
      return parts.body;
    }
  }

  for (const name of Object.keys(CONNECTIONS)) {
    if (completed[name]) continue;
    const { query } = makeQuery(name, since);
    let after = cursors[name] ?? null;
    while (true) {
      const variables = { first: PAGE_SIZE, after, includeArchived: true };
      if (since && ['issues', 'comments'].includes(name)) variables.since = since;
      const request = { query, variables, operationName: `Linear${name[0].toUpperCase()}${name.slice(1)}` };
      const body = await requestPage(request, name);
      const { nodes, pageInfo } = collectionResponse(body, name);
      appendUnique(collections[name], nodes);
      after = pageInfo.endCursor ?? null;
      const hasNextPage = pageInfo.hasNextPage === true;
      if (hasNextPage && !after) throw new Error(`Linear ${name} pagination omitted its cursor.`);
      cursors[name] = hasNextPage ? after : null;
      completed[name] = !hasNextPage;
      const progress = {
        version: VERSION,
        since: since ?? null,
        cursors: { ...cursors },
        completed: { ...completed },
        counts: countObject(collections),
      };
      if (typeof onCheckpoint === 'function') {
        try { await onCheckpoint(progress, structuredClone(collections), fetchedAt); } catch { throw new Error('Linear checkpoint write failed.'); }
      }
      if (!hasNextPage) break;
    }
  }

  if (since) {
    const knownIssueIds = new Set(collections.issues.map((issue) => issue.id));
    const commentIssueIds = [...new Set(collections.comments.map((comment) => comment.issue?.id).filter(Boolean))];
    const missingIds = commentIssueIds.filter((id) => !knownIssueIds.has(id));
    for (let offset = 0; offset < missingIds.length; offset += PAGE_SIZE) {
      const ids = missingIds.slice(offset, offset + PAGE_SIZE);
      const request = {
        operationName: 'LinearCommentIssueDetails',
        query: `query LinearCommentIssueDetails($filter: IssueFilter!, $first: Int!, $after: String, $includeArchived: Boolean!) { issues(first: $first, after: $after, includeArchived: $includeArchived, filter: $filter) { nodes { ${CONNECTIONS.issues.selection} } pageInfo { endCursor hasNextPage } } }`,
        variables: { filter: { id: { in: ids } }, first: PAGE_SIZE, after: null, includeArchived: true },
      };
      const body = await requestPage(request, 'comment issue details');
      const connection = body?.data?.issues;
      const nodes = Array.isArray(connection?.nodes) ? connection.nodes : Array.isArray(connection?.edges)
        ? connection.edges.map((edge) => edge.node).filter(Boolean) : null;
      if (!nodes || !connection.pageInfo || connection.pageInfo.hasNextPage) throw new Error('Linear comment issue detail response is invalid.');
      appendUnique(collections.issues, nodes);
      for (const row of nodes) knownIssueIds.add(row.id);
      if (typeof onCheckpoint === 'function') {
        try {
          await onCheckpoint({
            version: VERSION, since, cursors: { ...cursors, commentIssueDetails: null },
            completed: { ...completed, commentIssueDetails: offset + PAGE_SIZE >= missingIds.length },
            counts: countObject(collections),
          }, structuredClone(collections), fetchedAt);
        } catch { throw new Error('Linear checkpoint write failed.'); }
      }
    }
  }

  return normalizeLinearCollections(collections, fetchedAt);
}

function iso(value, nullable = true) {
  if (value == null || value === '') return nullable ? null : undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function entityId(value) {
  return typeof value === 'string' ? value : value?.id ?? null;
}

function edgeNodes(value) {
  return Array.isArray(value?.nodes) ? value.nodes : Array.isArray(value) ? value : [];
}

function normalizeLinearCollections(raw, fetchedAt) {
  const teams = raw.teams.map((row) => ({ id: row.id, key: row.key, name: row.name, private: Boolean(row.private), archivedAt: iso(row.archivedAt) }));
  const users = raw.users.map((row) => ({ id: row.id, name: row.name ?? '', email: row.email ?? null, active: Boolean(row.active) }));
  const states = raw.states.map((row) => ({ id: row.id, name: row.name, type: row.type, teamId: entityId(row.team) }));
  const labels = raw.labels.map((row) => ({ id: row.id, name: row.name, color: row.color ?? null, teamId: entityId(row.team), archivedAt: iso(row.archivedAt) }));
  const projects = raw.projects.map((row) => ({
    id: row.id, name: row.name, description: row.description ?? '', state: row.state ?? 'started',
    teamIds: edgeNodes(row.teams).map((team) => team.id), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt), archivedAt: iso(row.archivedAt),
  }));
  const cycles = raw.cycles.map((row) => ({
    id: row.id, name: row.name, description: row.description ?? '', teamId: entityId(row.team),
    startsAt: iso(row.startsAt), endsAt: iso(row.endsAt), completedAt: iso(row.completedAt), archivedAt: iso(row.archivedAt),
  }));
  const milestones = raw.milestones.map((row) => ({
    id: row.id, name: row.name, description: row.description ?? '', projectId: entityId(row.project), targetDate: row.targetDate ?? null,
    createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt), archivedAt: iso(row.archivedAt),
  }));
  const commentsByIssue = new Map();
  for (const row of raw.comments) {
    const issueId = entityId(row.issue);
    if (!issueId) continue;
    const createdAt = iso(row.createdAt);
    const updatedAt = iso(row.updatedAt);
    const list = commentsByIssue.get(issueId) ?? [];
    list.push({
      id: row.id, body: row.body ?? '', createdAt, editedAt: updatedAt && updatedAt !== createdAt ? updatedAt : null,
      authorName: row.user?.name ?? null, authorEmail: row.user?.email ?? null, parentId: entityId(row.parent), deletedAt: iso(row.deletedAt),
    });
    commentsByIssue.set(issueId, list);
  }
  const relationsByIssue = new Map();
  for (const row of raw.relations) {
    const issueId = entityId(row.issue);
    const relatedIssueId = entityId(row.relatedIssue);
    if (!issueId || !relatedIssueId) continue;
    const list = relationsByIssue.get(issueId) ?? [];
    list.push({ id: row.id, type: row.type, relatedIssueId });
    relationsByIssue.set(issueId, list);
  }
  const attachmentsByIssue = new Map();
  for (const row of raw.attachments) {
    const issueId = entityId(row.issue);
    if (!issueId) continue;
    const list = attachmentsByIssue.get(issueId) ?? [];
    list.push({ url: row.url ?? '', title: row.title ?? '' });
    attachmentsByIssue.set(issueId, list);
  }
  const issues = raw.issues.map((row) => ({
    id: row.id, identifier: row.identifier, number: Number(row.number), teamKey: row.team?.key ?? '',
    teamId: entityId(row.team), teamPrivate: Boolean(row.team?.private),
    title: row.title ?? '', description: row.description ?? '', priority: row.priority ?? null, estimate: row.estimate ?? null,
    state: row.state ? { id: row.state.id, name: row.state.name, type: row.state.type } : { id: '', name: '', type: 'unstarted' },
    assigneeEmail: row.assignee?.email ?? null, creatorEmail: row.creator?.email ?? null,
    labels: edgeNodes(row.labels).map((label) => ({ id: label.id, name: label.name, color: label.color ?? null })),
    projectId: entityId(row.project), cycleId: entityId(row.cycle), milestoneId: entityId(row.projectMilestone), parentId: entityId(row.parent),
    dueDate: row.dueDate ?? null, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt), archivedAt: iso(row.archivedAt),
    completedAt: iso(row.completedAt), canceledAt: iso(row.canceledAt), url: row.url ?? '',
    comments: (commentsByIssue.get(row.id) ?? []).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
    relations: relationsByIssue.get(row.id) ?? [], attachments: attachmentsByIssue.get(row.id) ?? [],
  }));
  const deletedComments = [...commentsByIssue.entries()].flatMap(([issueId, comments]) => comments.filter((comment) => comment.deletedAt).map((comment) => ({ issueId, id: comment.id })));
  for (const issue of issues) {
    issue.comments = issue.comments.filter((comment) => !comment.deletedAt).map((comment) => {
      const copy = { ...comment };
      delete copy.deletedAt;
      return copy;
    });
  }
  return { version: VERSION, fetchedAt: iso(fetchedAt, false) ?? new Date().toISOString(), teams, users, states, labels, projects, cycles, milestones, issues, deletedComments };
}

/** Read JSON fixture files written by the optional recorder. */
export function createReplayTransport(directory) {
  const files = fs.readdirSync(directory).filter((name) => /^\d{6}\.json$/.test(name)).sort();
  let index = 0;
  return async (request) => {
    const file = files[index++];
    if (!file) throw new Error('Replay fixture exhausted.');
    const saved = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
    if (saved.request?.operationName !== request.operationName) throw new Error(`Replay fixture mismatch at request ${index}.`);
    return saved.response;
  };
}

export { GRAPHQL_URL, PAGE_SIZE };
