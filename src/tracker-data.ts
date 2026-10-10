import {
  TrackerError,
  type TrackerBulkPatch,
  type TrackerBulkResult,
  type TrackerComment,
  type TrackerCommentPage,
  type TrackerConflictActor,
  type TrackerCreateInput,
  type TrackerCreateTicketForCardResult,
  type TrackerEventPage,
  type TrackerEvent,
  type TrackerFacets,
  type TrackerFeed,
  type TrackerInboxPage,
  type TrackerListQuery,
  type TrackerLabel,
  type TrackerKanbanLink,
  type TrackerLinkKanbanInput,
  type TrackerLinkKanbanResult,
  type TrackerLinkSuggestion,
  type TrackerMeta,
  type TrackerNotificationPrefs,
  type TrackerProject,
  type TrackerProjectInput,
  type TrackerProjectPatch,
  type TrackerMilestone,
  type TrackerMilestoneInput,
  type TrackerMilestonePatch,
  type TrackerNotificationKind,
  type TrackerNotifyChoice,
  type TrackerPatch,
  type TrackerPriority,
  type TrackerRelationKind,
  type TrackerSavedView,
  type TrackerSavedViewInput,
  type TrackerSavedViewPatch,
  type TrackerSort,
  type TrackerState,
  type TrackerStateCategory,
  type TrackerTicket,
  type TrackerTicketDetail,
  type TrackerTicketListPage,
  type TrackerUpdatedTickets,
  type TrackerUnlinkKanbanResult,
} from './tracker-types';
import type { TrackerErrorCode } from './tracker-types';

export * from './tracker-types';

export interface TrackerRequestOptions { signal?: AbortSignal }
export interface TrackerListOptions extends TrackerRequestOptions {}
export interface TrackerPageOptions extends TrackerRequestOptions { before?: string | number; limit?: number }
export interface TrackerInboxQuery { limit?: number; before?: string; unread?: boolean }
export type TrackerInboxReadInput = { ids: string[] } | { all: true };
export type TrackerNotificationPrefsUpdate = { prefs: Partial<Record<TrackerNotificationKind, TrackerNotifyChoice>> };
export interface TrackerBulkInput { keys: string[]; patch: TrackerBulkPatch }
export interface TrackerUpdateOptions { ifUpdatedSeq?: number }
export interface TrackerProjectListOptions extends TrackerRequestOptions { includeArchived?: boolean }
export interface TrackerSavedViewRunQuery { limit?: number; cursor?: string }
export interface TrackerSavedViewPage { tickets: TrackerTicket[]; nextCursor: string | null; view: TrackerSavedView }
export interface TrackerListLinksOptions extends TrackerRequestOptions { kanbanId?: string }
export interface TrackerLinkOptions extends TrackerListLinksOptions { force?: boolean }

/** Typed transport for every public tracker endpoint used by the app. */
export interface TrackerApi {
  meta(options?: TrackerRequestOptions): Promise<TrackerMeta>;
  createLabel(name: string, options?: TrackerRequestOptions): Promise<{ label: TrackerLabel }>;
  listProjects(options?: TrackerProjectListOptions): Promise<{ projects: TrackerProject[] }>;
  createProject(input: TrackerProjectInput, options?: TrackerRequestOptions): Promise<{ project: TrackerProject }>;
  updateProject(id: string, patch: TrackerProjectPatch, options?: TrackerRequestOptions): Promise<{ project: TrackerProject }>;
  listMilestones(projectId: string, options?: TrackerRequestOptions): Promise<{ milestones: TrackerMilestone[] }>;
  createMilestone(projectId: string, input: TrackerMilestoneInput, options?: TrackerRequestOptions): Promise<{ milestone: TrackerMilestone }>;
  updateMilestone(id: string, patch: TrackerMilestonePatch, options?: TrackerRequestOptions): Promise<{ milestone: TrackerMilestone }>;
  listViews(options?: TrackerRequestOptions): Promise<{ views: TrackerSavedView[] }>;
  runView(id: string, query?: TrackerSavedViewRunQuery, options?: TrackerRequestOptions): Promise<TrackerSavedViewPage>;
  createView(input: TrackerSavedViewInput, options?: TrackerRequestOptions): Promise<{ view: TrackerSavedView }>;
  updateView(id: string, patch: TrackerSavedViewPatch, options?: TrackerRequestOptions): Promise<{ view: TrackerSavedView }>;
  deleteView(id: string, options?: TrackerRequestOptions): Promise<void>;
  listTickets(query?: TrackerListQuery, options?: TrackerListOptions): Promise<TrackerTicketListPage>;
  listLinks(boardId: string, options?: TrackerListLinksOptions): Promise<{ links: TrackerKanbanLink[] }>;
  suggestLinkMapping(boardId: string, kanbanId: string, options?: TrackerRequestOptions): Promise<TrackerLinkSuggestion>;
  linkKanban(input: TrackerLinkKanbanInput, options?: TrackerRequestOptions): Promise<TrackerLinkKanbanResult>;
  unlinkKanban(id: string, options?: TrackerRequestOptions): Promise<TrackerUnlinkKanbanResult>;
  createTicketForCard(linkId: string, cardId: string, options?: TrackerRequestOptions): Promise<TrackerCreateTicketForCardResult>;
  ticketsUpdatedSince(seq: number, options?: TrackerRequestOptions): Promise<TrackerUpdatedTickets>;
  createTicket(input: TrackerCreateInput, options?: TrackerRequestOptions): Promise<{ ticket: TrackerTicket }>;
  getTicket(key: string, options?: TrackerRequestOptions): Promise<TrackerTicketDetail>;
  ticketComments(key: string, page?: TrackerPageOptions): Promise<TrackerCommentPage>;
  ticketEvents(key: string, page?: TrackerPageOptions): Promise<TrackerEventPage>;
  patchTicket(key: string, patch: TrackerPatch, options?: TrackerRequestOptions): Promise<{ ticket: TrackerTicket }>;
  transitionTicket(key: string, state: string, options?: TrackerRequestOptions): Promise<{ ticket: TrackerTicket }>;
  addComment(key: string, input: { body: string; clientId: string }, options?: TrackerRequestOptions): Promise<{ comment: TrackerComment; ticket: TrackerTicket }>;
  editComment(id: string, body: string, options?: TrackerRequestOptions): Promise<{ comment: TrackerComment }>;
  deleteComment(id: string, options?: TrackerRequestOptions): Promise<{ deleted: true } | void>;
  setSubscription(key: string, subscribed: boolean, options?: TrackerRequestOptions): Promise<{ subscribed: boolean }>;
  feed(since: number, options?: TrackerRequestOptions): Promise<TrackerFeed>;
  bulkTickets(input: TrackerBulkInput, options?: TrackerRequestOptions): Promise<TrackerBulkResult>;
  archiveTicket(key: string, options?: TrackerRequestOptions): Promise<{ ticket: TrackerTicket }>;
  restoreTicket(key: string, options?: TrackerRequestOptions): Promise<{ ticket: TrackerTicket }>;
  addRelation(key: string, relation: { kind: TrackerRelationKind; key: string }, options?: TrackerRequestOptions): Promise<{ ticket: TrackerTicket }>;
  removeRelation(key: string, relation: { kind: TrackerRelationKind; key: string }, options?: TrackerRequestOptions): Promise<{ ticket: TrackerTicket }>;
  inbox(query?: TrackerInboxQuery, options?: TrackerRequestOptions): Promise<TrackerInboxPage>;
  inboxUnread(options?: TrackerRequestOptions): Promise<{ unread: number }>;
  markInboxRead(input: TrackerInboxReadInput, options?: TrackerRequestOptions): Promise<{ updated: number; unread: number }>;
  notificationPrefs(options?: TrackerRequestOptions): Promise<TrackerNotificationPrefs>;
  updateNotificationPrefs(patch: TrackerNotificationPrefsUpdate, options?: TrackerRequestOptions): Promise<TrackerNotificationPrefs>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeTrackerKanbanLink(value: unknown): TrackerKanbanLink {
  const row = isRecord(value) ? value : {};
  const rawMapping = Array.isArray(row.mapping) ? row.mapping : [];
  const mapping = rawMapping.flatMap((item) => {
    if (!isRecord(item) || typeof item.laneId !== 'string' || typeof item.stateKey !== 'string') return [];
    return [{ laneId: item.laneId, stateKey: item.stateKey, stateId: typeof item.stateId === 'string' ? item.stateId : '' }];
  });
  const legacyMap = isRecord(row.map) ? row.map : {};
  const map = mapping.length
    ? Object.fromEntries(mapping.map(({ laneId, stateKey }) => [laneId, stateKey]))
    : Object.fromEntries(Object.entries(legacyMap).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const cardCount = Number(row.cardCount ?? row.ticketCount ?? 0);
  return {
    id: String(row.id ?? ''),
    boardId: String(row.boardId ?? ''),
    kanbanId: String(row.kanbanId ?? ''),
    workflowId: String(row.workflowId ?? ''),
    mapping,
    map,
    cardCount: Number.isFinite(cardCount) ? cardCount : 0,
    pendingProjections: Number.isFinite(Number(row.pendingProjections)) ? Math.max(0, Number(row.pendingProjections)) : 0,
    createdAt: Number(row.createdAt ?? 0),
    createdBy: String(row.createdBy ?? ''),
    ...(typeof row.removedAt === 'number' || row.removedAt === null ? { removedAt: row.removedAt } : {}),
    ticketCount: Number.isFinite(cardCount) ? cardCount : 0,
  };
}

function normalizeTrackerLinkSuggestion(value: unknown): TrackerLinkSuggestion {
  const row = isRecord(value) ? value : {};
  const mapping = isRecord(row.mapping) ? row.mapping : {};
  const lanes = Array.isArray(row.lanes) ? row.lanes : [];
  const laneMap = new Map<string, string | null>();
  for (const item of lanes) {
    if (isRecord(item) && typeof item.laneId === 'string') {
      laneMap.set(item.laneId, typeof item.stateKey === 'string' ? item.stateKey : null);
    }
  }
  const map = Object.keys(mapping).length
    ? Object.fromEntries(Object.entries(mapping).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : Object.fromEntries([...laneMap].filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const unmappedLanes = [...laneMap].filter(([, stateKey]) => stateKey === null).map(([laneId]) => laneId);
  const cardCount = Number(row.cardCount ?? row.existingCardCount ?? 0);
  return {
    map,
    unmappedLanes: unmappedLanes.length ? unmappedLanes : Object.entries(map).filter(([, stateKey]) => stateKey === null).map(([laneId]) => laneId),
    existingCardCount: Number.isFinite(cardCount) ? cardCount : 0,
    nextKey: typeof row.nextKey === 'string' ? row.nextKey : null,
    stateNotMapped: Array.isArray(row.stateNotMapped) ? row.stateNotMapped.filter((item): item is string => typeof item === 'string') : [],
  };
}

function normalizeTrackerLinkKanbanResult(value: unknown): TrackerLinkKanbanResult {
  const row = isRecord(value) ? value : {};
  const created = Array.isArray(row.created) ? row.created.flatMap((item) => {
    if (!isRecord(item) || typeof item.cardId !== 'string') return [];
    const ticket = isRecord(item.ticket) ? item.ticket : {};
    const key = typeof ticket.key === 'string' ? ticket.key : typeof item.key === 'string' ? item.key : null;
    return key ? [{ cardId: item.cardId, key }] : [];
  }) : [];
  const skipped = Array.isArray(row.skipped) ? row.skipped.flatMap((item) => {
    if (!isRecord(item) || typeof item.cardId !== 'string') return [];
    if (item.reason !== 'unmapped_lane' && item.reason !== 'already_linked' && item.reason !== 'empty_title') return [];
    return [{ cardId: item.cardId, reason: item.reason as TrackerLinkKanbanResult['skipped'][number]['reason'] }];
  }) : [];
  return {
    link: normalizeTrackerKanbanLink(row.link),
    created,
    skipped,
    projectionPending: row.projectionPending === true,
  };
}

function stableCardIdempotencyKey(linkId: string, cardId: string): string {
  let first = 2166136261;
  let second = 0x9e3779b9;
  for (const character of `${linkId}\u0000${cardId}`) {
    const code = character.charCodeAt(0);
    first = Math.imul(first ^ code, 16777619) >>> 0;
    second = Math.imul(second ^ (code + first), 2246822519) >>> 0;
  }
  return `card-${first.toString(36)}-${second.toString(36)}`;
}

function normalizeTrackerComment(value: unknown, ticketKey: string, clientId = ''): TrackerComment {
  const row = isRecord(value) ? value : {};
  const author = isRecord(row.author) ? row.author : {};
  return {
    ...row,
    id: String(row.id ?? ''),
    ticketKey: String(row.ticketKey ?? ticketKey),
    author: {
      userId: typeof author.userId === 'string' ? author.userId : typeof author.id === 'string' ? author.id : null,
      name: typeof author.name === 'string' ? author.name : 'Unknown',
    },
    body: typeof row.body === 'string' ? row.body : '',
    clientId: typeof row.clientId === 'string' ? row.clientId : clientId,
    createdAt: Number(row.createdAt ?? row.at ?? 0),
    editedAt: typeof row.editedAt === 'number' ? row.editedAt : null,
  } as TrackerComment;
}

function normalizeTrackerEvent(value: unknown): TrackerEvent {
  const row = isRecord(value) ? value : {};
  const before = isRecord(row.before) ? row.before : {};
  const after = isRecord(row.after) ? row.after : {};
  const details = isRecord(row.details) ? row.details : {};
  const changedFields = Object.keys(after);
  const inferredField = changedFields.length === 1 ? changedFields[0] : undefined;
  const field = typeof row.field === 'string' ? row.field : inferredField;
  const rawActor = isRecord(row.actor) ? row.actor : null;
  const actor = rawActor ? {
    ...rawActor,
    ...(typeof rawActor.id === 'string' && rawActor.userId === undefined ? { userId: rawActor.id } : {}),
  } : null;
  const relation = isRecord(row.relation) ? row.relation
    : typeof details.relationKind === 'string' || typeof details.relatedTicketKey === 'string'
      ? { kind: details.relationKind, key: details.relatedTicketKey }
      : undefined;
  return {
    ...row,
    id: Number(row.id ?? row.eventSeq ?? 0),
    at: Number(row.at ?? row.createdAt ?? 0),
    actor: actor as TrackerEvent['actor'],
    ...(field ? { field } : {}),
    ...(row.from !== undefined ? { from: row.from } : field && before[field] !== undefined ? { from: before[field] } : {}),
    ...(row.to !== undefined ? { to: row.to } : field && after[field] !== undefined ? { to: after[field] } : {}),
    ...(relation ? { relation } : {}),
  } as TrackerEvent;
}

function isErrorCode(value: unknown): value is TrackerErrorCode {
  return value === 'invalid_input' || value === 'invalid_filter' || value === 'not_found'
    || value === 'forbidden' || value === 'conflict' || value === 'read_only'
    || value === 'limit_exceeded' || value === 'rate_limited' || value === 'internal'
    || value === 'offline' || value === 'network' || value === 'invalid_mapping'
    || value === 'already_linked' || value === 'kanban_not_found' || value === 'board_forbidden';
}

function trackerHttpError(status: number, body: unknown): TrackerError {
  const fields = isRecord(body) ? body : {};
  const rawCode = fields.error;
  let code: TrackerErrorCode;
  if (isErrorCode(rawCode)) code = rawCode;
  else if (status === 404) code = 'not_found';
  else if (status === 403) code = 'forbidden';
  else if (status === 409) code = 'conflict';
  else if (status === 413) code = 'limit_exceeded';
  else if (status === 429) code = 'rate_limited';
  else if (status === 400 || status === 422) code = 'invalid_input';
  else code = 'internal';
  const message = typeof fields.message === 'string' ? fields.message : code;
  const path = typeof fields.path === 'string' ? fields.path : undefined;
  const current = isRecord(fields.ticket) ? fields.ticket as unknown as TrackerTicket : undefined;
  const rawBy = isRecord(fields.by) ? fields.by : isRecord(fields.actor) ? fields.actor : undefined;
  const byName = typeof rawBy?.name === 'string' ? rawBy.name
    : typeof rawBy?.userId === 'string' ? rawBy.userId
      : typeof rawBy?.id === 'string' ? rawBy.id : undefined;
  const by = rawBy && byName
    ? { name: byName, kind: typeof rawBy.kind === 'string' ? rawBy.kind : typeof rawBy.type === 'string' ? rawBy.type : 'user' }
    : undefined;
  return new TrackerError(code, message, { path, current, by, status });
}

function normalizeBulkBefore(value: unknown): TrackerBulkPatch | undefined {
  if (!isRecord(value)) return undefined;
  const patch = { ...value } as TrackerBulkPatch & { assigneeId?: string | null };
  if (Object.hasOwn(value, 'assigneeId')) patch.assignee = value.assigneeId as string | null;
  delete patch.assigneeId;
  return patch;
}

/** JSON transport matching src/api.ts same-origin and CSRF conventions. */
export function createHttpTrackerApi(fetchFn: typeof fetch = fetch): TrackerApi {
  async function request<T>(method: string, path: string, body?: unknown, options: TrackerRequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    const init: RequestInit = { method, credentials: 'same-origin', headers, signal: options.signal };
    if (method !== 'GET') headers['x-tabula'] = '1';
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await fetchFn(path, init);
    } catch (error) {
      if (error instanceof TrackerError) throw error;
      throw new TrackerError('network', error instanceof Error ? error.message : 'network');
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      if (!response.ok) throw trackerHttpError(response.status, undefined);
      throw new TrackerError('network', error instanceof Error ? error.message : 'network');
    }
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) as unknown : undefined;
    } catch {
      if (!response.ok) throw trackerHttpError(response.status, undefined);
      throw new TrackerError('internal', 'The tracker returned an invalid JSON response.', { status: response.status });
    }
    if (!response.ok) throw trackerHttpError(response.status, payload);
    return payload as T;
  }

  const segment = (value: string) => encodeURIComponent(value);
  const queryString = (entries: Array<[string, string | number | boolean | undefined]>) => {
    const params = new URLSearchParams();
    for (const [key, value] of entries) if (value !== undefined && value !== '') params.append(key, String(value));
    const result = params.toString();
    return result ? `?${result}` : '';
  };

  return {
    meta: (options) => request('GET', '/api/tracker/meta', undefined, options),
    createLabel: async (name, options) => {
      const result = await request<{ label: TrackerLabel }>('POST', '/api/tracker/labels', { name }, options);
      return result;
    },
    listProjects: (options = {}) => request('GET', `/api/tracker/projects${queryString([['archived', options.includeArchived ? 1 : undefined]])}`, undefined, options),
    createProject: (input, options) => request('POST', '/api/tracker/projects', input, options),
    updateProject: (id, patch, options) => request('PATCH', `/api/tracker/projects/${segment(id)}`, patch, options),
    listMilestones: (projectId, options) => request('GET', `/api/tracker/projects/${segment(projectId)}/milestones`, undefined, options),
    createMilestone: (projectId, input, options) => request('POST', `/api/tracker/projects/${segment(projectId)}/milestones`, input, options),
    updateMilestone: (id, patch, options) => request('PATCH', `/api/tracker/milestones/${segment(id)}`, patch, options),
    listViews: (options) => request('GET', '/api/tracker/views', undefined, options),
    runView: (id, query = {}, options) => request('GET', `/api/tracker/views/${segment(id)}/tickets${queryString([['limit', query.limit], ['cursor', query.cursor]])}`, undefined, options),
    createView: (input, options) => request('POST', '/api/tracker/views', input, options),
    updateView: (id, patch, options) => request('PATCH', `/api/tracker/views/${segment(id)}`, patch, options),
    deleteView: async (id, options) => { await request<void>('DELETE', `/api/tracker/views/${segment(id)}`, undefined, options); },
    listTickets: (query = {}, options) => {
      const filters = typeof query.filter === 'string' ? [query.filter] : query.filter ?? [];
      return request('GET', `/api/tracker/tickets${queryString([
        ...filters.map((filter): [string, string] => ['filter', filter]),
        ['q', query.q], ['limit', query.limit], ['cursor', query.cursor],
        ['sort', query.sort ? `${query.sort.field}:${query.sort.direction}` : undefined],
        ['group', query.group ?? undefined], ['facets', query.includeFacets ? 1 : undefined],
      ])}`, undefined, options);
    },
    listLinks: async (boardId, options) => {
      const result = await request<{ links: unknown[] }>('GET', `/api/tracker/links${queryString([['boardId', boardId], ['kanbanId', options?.kanbanId]])}`, undefined, options);
      return { links: result.links.map(normalizeTrackerKanbanLink) };
    },
    suggestLinkMapping: async (boardId, kanbanId, options) => {
      const result = await request<unknown>('GET', `/api/tracker/links/suggest${queryString([['boardId', boardId], ['kanbanId', kanbanId]])}`, undefined, options);
      return normalizeTrackerLinkSuggestion(result);
    },
    linkKanban: async (input, options) => normalizeTrackerLinkKanbanResult(await request<unknown>('POST', '/api/tracker/links', input, options)),
    unlinkKanban: async (id, options) => {
      const result = await request<{ link: unknown; unlinked: number; projectionPending?: boolean }>('DELETE', `/api/tracker/links/${segment(id)}`, undefined, options);
      return { link: normalizeTrackerKanbanLink(result.link), unlinked: Number(result.unlinked ?? 0), projectionPending: result.projectionPending === true };
    },
    createTicketForCard: async (linkId, cardId, options) => request<TrackerCreateTicketForCardResult>(
      'POST', `/api/tracker/links/${segment(linkId)}/cards`, { cardId, idempotencyKey: stableCardIdempotencyKey(linkId, cardId) }, options,
    ),
    ticketsUpdatedSince: (seq, options) => request('GET', `/api/tracker/tickets${queryString([['updatedSince', seq]])}`, undefined, options),
    createTicket: (input, options) => request('POST', '/api/tracker/tickets', input, options),
    getTicket: async (key, options) => {
      const result = await request<Omit<TrackerTicketDetail, 'comments' | 'events'> & { comments: unknown[]; events: unknown[] }>(
        'GET', `/api/tracker/tickets/${segment(key)}`, undefined, options,
      );
      return {
        ...result,
        comments: result.comments.map((comment) => normalizeTrackerComment(comment, result.ticket.key)),
        events: result.events.map(normalizeTrackerEvent),
      };
    },
    ticketComments: async (key, page = {}) => {
      const result = await request<{ comments: unknown[]; nextBefore?: string | null; nextCursor?: string | null }>(
        'GET', `/api/tracker/tickets/${segment(key)}/comments${queryString([['before', page.before], ['limit', page.limit]])}`, undefined, page,
      );
      return { comments: result.comments.map((comment) => normalizeTrackerComment(comment, key)), nextCursor: result.nextBefore ?? result.nextCursor ?? null };
    },
    ticketEvents: async (key, page = {}) => {
      const result = await request<{ events: unknown[]; nextBefore?: string | null; nextCursor?: string | null }>(
        'GET', `/api/tracker/tickets/${segment(key)}/events${queryString([['before', page.before], ['limit', page.limit]])}`, undefined, page,
      );
      return { events: result.events.map(normalizeTrackerEvent), nextCursor: result.nextBefore ?? result.nextCursor ?? null };
    },
    patchTicket: (key, patch, options) => request('PATCH', `/api/tracker/tickets/${segment(key)}`, patch, options),
    transitionTicket: (key, state, options) => request('POST', `/api/tracker/tickets/${segment(key)}/transition`, { state }, options),
    addComment: async (key, input, options) => {
      const result = await request<{ comment: unknown; ticket: TrackerTicket }>('POST', `/api/tracker/tickets/${segment(key)}/comments`, input, options);
      return { comment: normalizeTrackerComment(result.comment, result.ticket.key, input.clientId), ticket: result.ticket };
    },
    editComment: async (id, body, options) => {
      const result = await request<{ comment: unknown }>('PATCH', `/api/tracker/comments/${segment(id)}`, { body }, options);
      return { comment: normalizeTrackerComment(result.comment, '') };
    },
    deleteComment: (id, options) => request('DELETE', `/api/tracker/comments/${segment(id)}`, undefined, options),
    setSubscription: (key, subscribed, options) => request(subscribed ? 'PUT' : 'DELETE', `/api/tracker/tickets/${segment(key)}/subscription`, undefined, options),
    feed: (since, options) => request('GET', `/api/tracker/feed${queryString([['since', since]])}`, undefined, options),
    bulkTickets: async (input, options) => {
      const response = await request<{
        batchId: string;
        results: Array<TrackerBulkResult['results'][number] & { before?: unknown }>;
        before?: TrackerBulkResult['before'];
      }>(
        'POST', '/api/tracker/tickets/bulk', input, options,
      );
      const results = response.results.map((item) => ({
        ...item,
        ...(normalizeBulkBefore(item.before) ? { before: normalizeBulkBefore(item.before) } : {}),
      }));
      const before = response.before ?? Object.fromEntries(results.flatMap((item) => item.ok && item.before
        ? [[item.ticket?.key ?? item.key, { patch: item.before, updatedSeq: item.ticket?.updatedSeq ?? 0 }]]
        : []));
      return { ...response, results, before };
    },
    archiveTicket: (key, options) => request('POST', `/api/tracker/tickets/${segment(key)}/archive`, {}, options),
    restoreTicket: (key, options) => request('POST', `/api/tracker/tickets/${segment(key)}/restore`, {}, options),
    addRelation: (key, relation, options) => request('POST', `/api/tracker/tickets/${segment(key)}/relations`, { relation: relation.kind, otherKey: relation.key }, options),
    removeRelation: (key, relation, options) => request('DELETE', `/api/tracker/tickets/${segment(key)}/relations`, { relation: relation.kind, otherKey: relation.key }, options),
    inbox: (query = {}, options) => request('GET', `/api/tracker/inbox${queryString([
      ['limit', query.limit], ['before', query.before], ['unread', query.unread ? 1 : undefined],
    ])}`, undefined, options),
    inboxUnread: (options) => request('GET', '/api/tracker/inbox/unread', undefined, options),
    markInboxRead: (input, options) => request('POST', '/api/tracker/inbox/read', input, options),
    notificationPrefs: (options) => request('GET', '/api/tracker/notification-prefs', undefined, options),
    updateNotificationPrefs: (patch, options) => request('PUT', '/api/tracker/notification-prefs', patch, options),
  };
}

export interface ParsedTrackerFilter {
  assignee?: string;
  state: string[];
  label: string[];
  due?: string;
  archived?: boolean;
  invalid: string[];
}

/** Parses the supported search tokens while retaining unknown tokens for an error display. */
export function parseFilter(input: string | readonly string[] | undefined): ParsedTrackerFilter {
  const parts: readonly string[] = typeof input === 'string' ? input.split(/\s+/) : input ?? [];
  const tokens = parts.map((part: string) => part.trim()).filter(Boolean);
  const parsed: ParsedTrackerFilter = { state: [], label: [], invalid: [] };
  for (const token of tokens) {
    const separator = token.indexOf(':');
    if (separator < 1) { parsed.invalid.push(token); continue; }
    const name = token.slice(0, separator).toLowerCase();
    const value = token.slice(separator + 1);
    if (name === 'assignee' && value) parsed.assignee = value;
    else if (name === 'state' && value) parsed.state.push(value);
    else if (name === 'label' && value) parsed.label.push(value);
    else if (name === 'due' && value && (value === 'overdue' || value === 'today' || value === 'no-date'
      || (value.startsWith('before-') && isValidDueDate(value.slice(7))))) parsed.due = value;
    else if (name === 'is' && value === 'archived') parsed.archived = true;
    else parsed.invalid.push(token);
  }
  return parsed;
}

export function formatFilter(filter: Partial<ParsedTrackerFilter> | string | readonly string[] | undefined): string[] {
  if (filter === undefined) return [];
  if (typeof filter === 'string') return filter.split(/\s+/).filter(Boolean);
  if (Array.isArray(filter)) return [...filter] as string[];
  const fields = filter as Partial<ParsedTrackerFilter>;
  const tokens: string[] = [];
  if (fields.assignee) tokens.push(`assignee:${fields.assignee}`);
  for (const state of fields.state ?? []) tokens.push(`state:${state}`);
  for (const label of fields.label ?? []) tokens.push(`label:${label}`);
  if (fields.due) tokens.push(`due:${fields.due}`);
  if (fields.archived) tokens.push('is:archived');
  tokens.push(...(fields.invalid ?? []));
  return tokens;
}

const TICKET_KEY_RE = /^[A-Z]{2,5}-[1-9]\d*$/i;
export function isTicketKey(value: unknown): value is string {
  return typeof value === 'string' && TICKET_KEY_RE.test(value.trim());
}
export function ticketKeyFromText(value: string): string | null {
  const match = value.match(/\b[A-Z]{2,5}-[1-9]\d*\b/i);
  return match?.[0].toUpperCase() ?? null;
}

export function statesByCategory(states: readonly TrackerState[], category: TrackerStateCategory): TrackerState[] {
  return states.filter((state) => state.category === category).slice().sort((a, b) => a.position - b.position);
}
export function isStateInCategory(state: Pick<TrackerState, 'category'> | TrackerTicket['state'] | null | undefined, category: TrackerStateCategory): boolean {
  return state?.category === category;
}
export function isCompletedState(state: Pick<TrackerState, 'category'> | TrackerTicket['state'] | null | undefined): boolean {
  return isStateInCategory(state, 'completed');
}
export function isCancelledState(state: Pick<TrackerState, 'category'> | TrackerTicket['state'] | null | undefined): boolean {
  return isStateInCategory(state, 'canceled');
}

export const PRIORITY_NAMES: readonly TrackerPriority[] = ['none', 'urgent', 'high', 'medium', 'low'];
export function priorityToInt(priority: TrackerPriority): number { return PRIORITY_NAMES.indexOf(priority); }
export function priorityFromInt(priority: number): TrackerPriority {
  return PRIORITY_NAMES[Math.min(PRIORITY_NAMES.length - 1, Math.max(0, Math.trunc(priority)))] ?? 'none';
}

export function isValidDueDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
export function isDueDateOverdue(due: string | null | undefined, today: string): boolean {
  return Boolean(due && isValidDueDate(due) && isValidDueDate(today) && due < today);
}
export function dueDateStatus(due: string | null | undefined, today: string): 'none' | 'overdue' | 'today' | 'upcoming' {
  if (!due || !isValidDueDate(due) || !isValidDueDate(today)) return 'none';
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  return 'upcoming';
}

export interface FilterContext { me?: { userId: string } | string | null; today: string }
export function matchesFilters(ticket: TrackerTicket, filters: string | readonly string[] | ParsedTrackerFilter | undefined, ctx: FilterContext): boolean {
  const parsed = typeof filters === 'object' && filters !== null && !Array.isArray(filters)
    ? filters as ParsedTrackerFilter
    : parseFilter(filters as string | readonly string[] | undefined);
  if (parsed.invalid.length) return false;
  const isArchiveQuery = parsed.archived === true;
  if (isArchiveQuery ? ticket.archivedAt === null : ticket.archivedAt !== null) return false;
  if (parsed.assignee) {
    const wanted = parsed.assignee.toLocaleLowerCase();
    const me = typeof ctx.me === 'string' ? ctx.me : ctx.me?.userId;
    if (wanted === 'me') { if (!me || ticket.assignee?.userId !== me) return false; }
    else if (!ticket.assignee || ![ticket.assignee.userId, ticket.assignee.name].some((v) => v.toLocaleLowerCase() === wanted)) return false;
  }
  if (parsed.state.length && !parsed.state.some((wanted) => [ticket.state.id, ticket.state.key, ticket.state.name, ticket.state.category].some((value) => value.toLocaleLowerCase() === wanted.toLocaleLowerCase()))) return false;
  if (parsed.label.length && !parsed.label.every((wanted) => ticket.labels.some((label) => [label.id, label.name].some((value) => value.toLocaleLowerCase() === wanted.toLocaleLowerCase())))) return false;
  if (parsed.due === 'overdue' && !isDueDateOverdue(ticket.due, ctx.today)) return false;
  if (parsed.due === 'today' && ticket.due !== ctx.today) return false;
  if (parsed.due === 'no-date' && ticket.due !== null) return false;
  if (parsed.due?.startsWith('before-') && (!ticket.due || ticket.due >= parsed.due.slice(7))) return false;
  return true;
}

function compareText(a: string, b: string): number { return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }); }
export function compareTickets(a: TrackerTicket, b: TrackerTicket, sort: TrackerSort = { field: 'updatedAt', direction: 'desc' }): number {
  const sign = sort.direction === 'desc' ? -1 : 1;
  const field = sort.field;
  let cmp = 0;
  if (field === 'key' || field === 'title') cmp = compareText(a[field], b[field]);
  else if (field === 'priority') cmp = (priorityToInt(a.priority) - priorityToInt(b.priority));
  else if (field === 'assignee') cmp = compareText(a.assignee?.name ?? '', b.assignee?.name ?? '');
  else if (field === 'state') cmp = compareText(a.state.name, b.state.name);
  else if (field === 'due') cmp = compareText(a.due ?? '9999-99-99', b.due ?? '9999-99-99');
  else cmp = a[field] - b[field];
  return cmp === 0 ? compareText(a.key, b.key) : cmp * sign;
}

export function normalizeListQuery(query: TrackerListQuery = {}): string {
  const filters = formatFilter(query.filter).map((part) => part.trim().toLocaleLowerCase()).filter(Boolean).sort((a, b) => a.localeCompare(b));
  const sort = query.sort ? `${query.sort.field}:${query.sort.direction}` : 'updatedAt:desc';
  return JSON.stringify({ filters, q: (query.q ?? '').trim().toLocaleLowerCase(), sort, group: query.group?.trim().toLocaleLowerCase() ?? null });
}

export function cloneTrackerData<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneTrackerData(item)) as T;
  // An Error's message is not enumerable, so the generic copy below would lose it (server errors showed as "undefined" in the UI).
  if (value instanceof TrackerError) {
    return new TrackerError(value.code, value.message, {
      path: value.path,
      current: value.current ? cloneTrackerData(value.current) : undefined,
      by: value.by ? cloneTrackerData(value.by) : undefined,
      status: value.status,
    }) as T;
  }
  if (value && typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copy[key] = cloneTrackerData(item);
    return copy as T;
  }
  return value;
}

export interface TrackerStoreOptions {
  pollMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  isVisible?: () => boolean;
  isOnline?: () => boolean;
  /** Called with the error a watcher threw; the store logs it and carries on. */
  onListenerError?: (error: unknown) => void;
}

export interface TrackerTicketCache {
  ticket?: TrackerTicket;
  detail?: TrackerTicketDetail;
  loading: boolean;
  error?: TrackerError;
  conflict?: TrackerTicket;
  conflictBy?: TrackerConflictActor;
  pending: boolean;
  offlineQueued: boolean;
  subscribed?: boolean;
  commentsHasMore?: boolean;
  eventsHasMore?: boolean;
  commentsBefore?: string;
  eventsBefore?: string | number;
  loadingOlderActivity?: boolean;
}
export interface TrackerListCache {
  query: TrackerListQuery;
  key: string;
  tickets: TrackerTicket[];
  nextCursor: string | null;
  facets?: TrackerFacets;
  loading: boolean;
  loadingMore: boolean;
  error?: TrackerError;
}
export interface TrackerStoreSnapshot {
  meta?: TrackerMeta;
  metaLoading: boolean;
  metaError?: TrackerError;
  readOnly: boolean;
  tickets: Record<string, TrackerTicketCache>;
  lists: Record<string, TrackerListCache>;
  feedSeq: number;
}

export interface TrackerUndoBatch {
  batchId: string;
  before: TrackerBulkResult['before'];
}

export interface TrackerStore {
  subscribe(listener: (snapshot: TrackerStoreSnapshot) => void): () => void;
  snapshot(): TrackerStoreSnapshot;
  loadMeta(force?: boolean): Promise<TrackerMeta>;
  listLinks(boardId: string, options?: TrackerLinkOptions): Promise<TrackerKanbanLink[]>;
  suggestLinkMapping(boardId: string, kanbanId: string, options?: TrackerLinkOptions): Promise<TrackerLinkSuggestion>;
  linkKanban(input: TrackerLinkKanbanInput): Promise<TrackerLinkKanbanResult>;
  unlinkKanban(id: string): Promise<TrackerUnlinkKanbanResult>;
  createTicketForCard(linkId: string, cardId: string): Promise<TrackerCreateTicketForCardResult>;
  createLabel(name: string): Promise<TrackerLabel>;
  listProjects(options?: TrackerProjectListOptions): Promise<TrackerProject[]>;
  createProject(input: TrackerProjectInput): Promise<TrackerProject>;
  updateProject(id: string, patch: TrackerProjectPatch): Promise<TrackerProject>;
  listMilestones(projectId: string): Promise<TrackerMilestone[]>;
  createMilestone(projectId: string, input: TrackerMilestoneInput): Promise<TrackerMilestone>;
  updateMilestone(id: string, patch: TrackerMilestonePatch): Promise<TrackerMilestone>;
  listViews(): Promise<TrackerSavedView[]>;
  runView(id: string, query?: TrackerSavedViewRunQuery): Promise<TrackerSavedViewPage>;
  createView(input: TrackerSavedViewInput): Promise<TrackerSavedView>;
  updateView(id: string, patch: TrackerSavedViewPatch): Promise<TrackerSavedView>;
  deleteView(id: string): Promise<void>;
  loadList(query?: TrackerListQuery, options?: { force?: boolean }): Promise<TrackerListCache>;
  loadMore(query?: TrackerListQuery): Promise<TrackerListCache>;
  list(query?: TrackerListQuery): TrackerListCache;
  watchList(query: TrackerListQuery, listener: (state: TrackerListCache) => void): () => void;
  ticket(key: string): TrackerTicketCache;
  loadTicket(key: string, force?: boolean): Promise<TrackerTicketDetail>;
  loadOlderActivity(key: string): Promise<TrackerTicketDetail>;
  watchTicket(key: string, listener: (state: TrackerTicketCache) => void): () => void;
  createTicket(input: Omit<TrackerCreateInput, 'idempotencyKey'> & { idempotencyKey?: string }): Promise<TrackerTicket>;
  updateTicket(key: string, patch: Omit<TrackerPatch, 'ifUpdatedSeq'>, options?: TrackerUpdateOptions): Promise<TrackerTicket>;
  transitionTicket(key: string, state: string): Promise<TrackerTicket>;
  addComment(key: string, body: string, clientId?: string): Promise<TrackerComment>;
  editComment(key: string, id: string, body: string): Promise<TrackerComment>;
  deleteComment(key: string, id: string): Promise<void>;
  setSubscription(key: string, subscribed: boolean): Promise<boolean>;
  bulk(keys: string[], patch: TrackerBulkPatch): Promise<TrackerUndoBatch>;
  undo(batch: TrackerUndoBatch): Promise<TrackerBulkResult>;
  redo(batch: TrackerUndoBatch): Promise<TrackerBulkResult>;
  /** Replays this process-local queue after reconnect. V1 does not persist queued edits across reloads. */
  replayOfflineQueue(): Promise<void>;
  addRelation(key: string, relation: { kind: TrackerRelationKind; key: string }): Promise<TrackerTicket>;
  removeRelation(key: string, relation: { kind: TrackerRelationKind; key: string }): Promise<TrackerTicket>;
  destroy(): void;
}

export interface TrackerUndoStack {
  push(batch: TrackerUndoBatch): void;
  undo(): Promise<TrackerBulkResult | undefined>;
  redo(): Promise<TrackerBulkResult | undefined>;
  canUndo(): boolean;
  canRedo(): boolean;
}

interface QueuedEdit { kind: 'patch' | 'transition' | 'comment' | 'subscription'; value: unknown; baseSeq: number }

function asTrackerError(error: unknown): TrackerError {
  if (error instanceof TrackerError) return error;
  return new TrackerError('network', error instanceof Error ? error.message : 'network');
}

function cacheTicketKey(key: string): string { return key.trim().toUpperCase(); }
function emptyTicketCache(): TrackerTicketCache {
  return { loading: false, pending: false, offlineQueued: false };
}
function emptyListCache(query: TrackerListQuery, key: string): TrackerListCache {
  return { query: cloneTrackerData(query), key, tickets: [], nextCursor: null, loading: false, loadingMore: false };
}
interface TrackerLinksCacheEntry { links: TrackerKanbanLink[]; fetchedAt: number; pending?: Promise<TrackerKanbanLink[]> }
interface TrackerSuggestionCacheEntry { suggestion: TrackerLinkSuggestion; fetchedAt: number; pending?: Promise<TrackerLinkSuggestion> }
function makeLocalId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '');
  return `${prefix}-${random ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`}`;
}

function ticketWithPatch(ticket: TrackerTicket, patch: TrackerBulkPatch, meta: TrackerMeta | undefined, now: number): TrackerTicket {
  const next = cloneTrackerData(ticket);
  if (patch.title !== undefined) Object.assign(next, { title: patch.title });
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.state !== undefined) {
    const state = meta?.states.find((candidate) => candidate.id === patch.state
      || candidate.key.toLocaleLowerCase() === patch.state?.toLocaleLowerCase()
      || candidate.name.toLocaleLowerCase() === patch.state?.toLocaleLowerCase());
    if (state) next.state = { id: state.id, key: state.key, name: state.name, category: state.category };
  }
  if (patch.priority !== undefined) next.priority = patch.priority;
  if (patch.due !== undefined) next.due = patch.due;
  if (patch.parent !== undefined) next.parent = patch.parent;
  if (patch.project !== undefined) {
    next.project = patch.project === null ? null : cloneTrackerData(meta?.projects?.find((project) => project.id === patch.project || project.name.toLocaleLowerCase() === patch.project?.toLocaleLowerCase()) ?? next.project);
  }
  if (patch.milestone !== undefined) {
    next.milestone = patch.milestone === null ? null : cloneTrackerData(meta?.milestones?.find((milestone) => milestone.id === patch.milestone || milestone.name.toLocaleLowerCase() === patch.milestone?.toLocaleLowerCase()) ?? next.milestone);
  }
  if (patch.labels !== undefined) {
    next.labels = patch.labels.map((name) => meta?.labels.find((label) => label.id === name || label.name.toLocaleLowerCase() === name.toLocaleLowerCase()))
      .filter((label): label is NonNullable<typeof label> => Boolean(label))
      .map((label) => cloneTrackerData(label));
  }
  if (patch.assignee !== undefined) {
    if (patch.assignee === null || patch.assignee === '') next.assignee = null;
    else {
      const member = meta?.members.find((candidate) => candidate.userId === patch.assignee || candidate.name.toLocaleLowerCase() === patch.assignee?.toLocaleLowerCase());
      if (member) next.assignee = { userId: member.userId, name: member.name };
    }
  }
  if (patch.archived !== undefined) next.archivedAt = patch.archived ? (next.archivedAt ?? now) : null;
  next.updatedAt = now;
  return next;
}

function patchValuesBefore(ticket: TrackerTicket, patch: TrackerBulkPatch): TrackerBulkPatch {
  const before: TrackerBulkPatch = {};
  if ('title' in patch) Object.assign(before, { title: ticket.title });
  if ('description' in patch) before.description = ticket.description;
  if ('state' in patch) before.state = ticket.state.key;
  if ('priority' in patch) before.priority = ticket.priority;
  if ('assignee' in patch) before.assignee = ticket.assignee?.userId ?? null;
  if ('labels' in patch) before.labels = ticket.labels.map((label) => label.name);
  if ('due' in patch) before.due = ticket.due;
  if ('parent' in patch) before.parent = ticket.parent;
  if ('project' in patch) before.project = ticket.project?.id ?? null;
  if ('milestone' in patch) before.milestone = ticket.milestone?.id ?? null;
  if ('archived' in patch) before.archived = ticket.archivedAt !== null;
  return before;
}

/** Creates the framework-free reactive cache used by the tracker UI. */
export function createTrackerStore(api: TrackerApi, options: TrackerStoreOptions = {}): TrackerStore {
  const pollMs = Math.max(1, options.pollMs ?? 5000);
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback: () => void, delay: number) => setTimeout(callback, delay));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const isVisible = options.isVisible ?? (() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const isOnline = options.isOnline ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false);
  const generalListeners = new Set<(snapshot: TrackerStoreSnapshot) => void>();
  const ticketListeners = new Map<string, Set<(state: TrackerTicketCache) => void>>();
  const listListeners = new Map<string, Set<(state: TrackerListCache) => void>>();
  const ticketCaches = new Map<string, TrackerTicketCache>();
  const ticketLoadPromises = new Map<string, Promise<TrackerTicketDetail>>();
  const listCaches = new Map<string, TrackerListCache>();
  const loadedLists = new Set<string>();
  const linksCaches = new Map<string, TrackerLinksCacheEntry>();
  const linkSuggestionCaches = new Map<string, TrackerSuggestionCacheEntry>();
  const watchQueries = new Map<string, TrackerListQuery>();
  const offlineQueue = new Map<string, QueuedEdit[]>();
  const blockedQueue = new Set<string>();
  let meta: TrackerMeta | undefined;
  let metaLoading = false;
  let metaError: TrackerError | undefined;
  let readOnly = false;
  let feedSeq = 0;
  let timer: unknown;
  let timerScheduled = false;
  let pollErrors = 0;
  let destroyed = false;
  let replaying = false;
  const linkCacheTtlMs = 30_000;
  const maxLinkCacheBoards = 8;

  function snapshot(): TrackerStoreSnapshot {
    const tickets: Record<string, TrackerTicketCache> = {};
    const lists: Record<string, TrackerListCache> = {};
    for (const [key, value] of ticketCaches) tickets[key] = cloneTrackerData(value);
    for (const [key, value] of listCaches) lists[key] = cloneTrackerData(value);
    return { meta: meta ? cloneTrackerData(meta) : undefined, metaLoading, metaError, readOnly, tickets, lists, feedSeq };
  }

  /** A broken watcher must never abort the mutation or the poll that notified it: its error is reported and the others still run. */
  function deliver<T>(listener: (value: T) => void, value: T): void {
    try {
      listener(value);
    } catch (error) {
      try { options.onListenerError?.(error); } catch { /* the reporter itself must not throw into a mutation */ }
      if (typeof console !== 'undefined') console.error('tracker store listener failed', error);
    }
  }

  function notify(): void {
    const full = snapshot();
    for (const listener of generalListeners) deliver(listener, cloneTrackerData(full));
    for (const [key, listeners] of ticketListeners) {
      const state = ticketCaches.get(key) ?? emptyTicketCache();
      for (const listener of listeners) deliver(listener, cloneTrackerData(state));
    }
    for (const [key, listeners] of listListeners) {
      const state = listCaches.get(key) ?? emptyListCache({}, key);
      for (const listener of listeners) deliver(listener, cloneTrackerData(state));
    }
  }

  function ticketCache(key: string): TrackerTicketCache {
    const normalized = cacheTicketKey(key);
    let state = ticketCaches.get(normalized);
    if (!state) { state = emptyTicketCache(); ticketCaches.set(normalized, state); }
    return state;
  }

  function listCache(query: TrackerListQuery = {}): TrackerListCache {
    const key = normalizeListQuery(query);
    let state = listCaches.get(key);
    if (!state) { state = emptyListCache(query, key); listCaches.set(key, state); }
    return state;
  }

  function querySnippet(ticket: TrackerTicket, query: string): string | null {
    const terms = query.trim().split(/\s+/).filter(Boolean);
    const cached = ticketCaches.get(cacheTicketKey(ticket.key))?.detail?.comments ?? [];
    const source = [ticket.title, ticket.description, ...cached.filter((comment) => !comment.deleted).map((comment) => comment.body)]
      .find((text) => terms.every((term) => text.toLocaleLowerCase().includes(term.toLocaleLowerCase())));
    if (source === undefined) return null;
    let snippet = source.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    for (const term of terms.sort((a, b) => b.length - a.length)) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      snippet = snippet.replace(new RegExp(escaped, 'ig'), (matched) => `<mark>${matched}</mark>`);
    }
    return snippet;
  }

  function updateListRows(ticket: TrackerTicket): void {
    const today = new Date(now()).toISOString().slice(0, 10);
    for (const state of listCaches.values()) {
      const index = state.tickets.findIndex((row) => row.key === ticket.key);
      if (index < 0) continue;
      let row = cloneTrackerData(ticket);
      if (!matchesFilters(row, state.query.filter, { me: meta?.me.userId, today })) {
        state.tickets.splice(index, 1);
        continue;
      }
      if (state.query.q) {
        const snippet = querySnippet(row, state.query.q);
        if (snippet === null) { state.tickets.splice(index, 1); continue; }
        row.snippet = snippet;
      }
      state.tickets[index] = row;
      state.tickets.sort((a, b) => compareTickets(a, b, state.query.sort ?? { field: 'updatedAt', direction: 'desc' }));
    }
  }

  function saveTicket(ticket: TrackerTicket, options: { preserveLocal?: boolean } = {}): void {
    let shouldUpdateLists = true;
    for (const ref of new Set([ticket.key, ...(ticket.aliases ?? [])])) {
      const state = ticketCache(ref);
      if (options.preserveLocal && state.pending) { shouldUpdateLists = false; continue; }
      // A list or poll row is slim (no creator, labels, relations); it must not erase what a full ticket already told us.
      const known = state.ticket && state.ticket.id === ticket.id ? state.ticket : state.detail?.ticket;
      state.ticket = cloneTrackerData(known && !ticket.creator ? { ...known, ...ticket } : ticket);
    }
    if (shouldUpdateLists) updateListRows(ticket);
  }

  function setReadonlyFrom(error: TrackerError): void {
    if (error.code === 'read_only' && !readOnly) {
      readOnly = true;
      notify();
    }
  }

  function conflictActorFromDetail(detail: TrackerTicketDetail): TrackerConflictActor | undefined {
    const event = [...detail.events].sort((left, right) => left.id - right.id).at(-1);
    const actor = event?.actor;
    if (!actor) return undefined;
    const kind = actor.type ?? actor.provider ?? 'user';
    const actorId = actor.userId ?? actor.id;
    const member = actorId ? meta?.members.find((candidate) => candidate.userId === actorId) : undefined;
    const knownName = kind === 'mcp_token' ? 'MCP token'
      : kind === 'system' ? 'System'
        : kind === 'integration' ? 'Integration'
          : undefined;
    const name = actor.name ?? member?.name ?? knownName ?? actorId;
    return name ? { name, kind } : undefined;
  }

  async function enrichConflict(key: string, error: TrackerError): Promise<TrackerError> {
    if (error.code !== 'conflict' || (error.current && error.by)) return error;
    let current = error.current;
    let by: TrackerConflictActor | undefined = error.by;
    try {
      const detail = await api.getTicket(key);
      current ??= detail.ticket;
      if (!by) {
        if (!meta) { try { await loadMeta(); } catch { /* activity still provides the actor id and kind */ } }
        by = conflictActorFromDetail(detail);
      }
    } catch { /* retain the conflict even when activity cannot be refetched */ }
    return new TrackerError(error.code, error.message, { path: error.path, current, by, status: error.status });
  }

  function assertWritable(): void {
    if (readOnly || meta?.me.canWrite === false) {
      if (!readOnly) { readOnly = true; notify(); }
      throw new TrackerError('read_only', 'You do not have permission to change tracker tickets.');
    }
  }

  function watchedCount(): number {
    let count = 0;
    for (const listeners of ticketListeners.values()) count += listeners.size;
    for (const listeners of listListeners.values()) count += listeners.size;
    return count;
  }

  function stopPoll(): void {
    if (!timerScheduled) return;
    clearTimer(timer);
    timerScheduled = false;
    timer = undefined;
  }

  function schedulePoll(delay = pollMs): void {
    if (destroyed || timerScheduled || watchedCount() === 0) return;
    timerScheduled = true;
    timer = setTimer(() => {
      timerScheduled = false;
      timer = undefined;
      void poll();
    }, delay);
  }

  async function poll(): Promise<void> {
    if (destroyed || watchedCount() === 0) return;
    if (!isVisible()) { schedulePoll(pollMs); return; }
    try {
      // The first poll has no cursor: the server answers with the current seq and no events, so anything that changed between a watcher's
      // load and this answer would be missed. Refetch what is watched once instead of trusting the empty page.
      const bootstrap = feedSeq === 0;
      const page = await api.feed(feedSeq);
      feedSeq = Math.max(feedSeq, page.seq, ...page.events.map((event) => event.id));
      pollErrors = 0;
      const changedKeys = new Set(page.events.map((event) => cacheTicketKey(event.ticketKey)));
      if (bootstrap && page.seq > 0) for (const key of ticketListeners.keys()) changedKeys.add(key);
      for (const key of changedKeys) {
        if (ticketListeners.has(key)) void loadTicket(key, true).catch(() => undefined);
      }
      if (page.events.length > 0 || (bootstrap && page.seq > 0)) {
        for (const [key, query] of watchQueries) {
          if (listListeners.has(key)) void loadList(query, { force: true }).catch(() => undefined);
        }
      }
      notify();
      schedulePoll(pollMs);
    } catch {
      pollErrors += 1;
      const backoff = Math.min(pollMs * (2 ** Math.min(pollErrors, 6)), 60_000);
      schedulePoll(backoff);
    }
  }

  function startWatching(): void { schedulePoll(pollMs); }

  async function loadMeta(force = false): Promise<TrackerMeta> {
    if (meta && !force) return cloneTrackerData(meta);
    metaLoading = true;
    metaError = undefined;
    notify();
    try {
      meta = await api.meta();
      readOnly = !meta.me.canWrite;
      metaLoading = false;
      notify();
      return cloneTrackerData(meta);
    } catch (caught) {
      metaLoading = false;
      metaError = asTrackerError(caught);
      setReadonlyFrom(metaError);
      notify();
      throw metaError;
    }
  }

  function rememberLinks(boardId: string, entry: TrackerLinksCacheEntry): void {
    linksCaches.delete(boardId);
    linksCaches.set(boardId, entry);
    while (linksCaches.size > maxLinkCacheBoards) linksCaches.delete(linksCaches.keys().next().value as string);
  }

  function linkSuggestionCacheKey(boardId: string, kanbanId: string): string {
    return `${boardId}\u0000${kanbanId}`;
  }

  async function listLinks(boardId: string, linkOptions: TrackerLinkOptions = {}): Promise<TrackerKanbanLink[]> {
    if (!boardId) throw new TrackerError('invalid_input', 'Board id is required.', { path: 'boardId' });
    if (linkOptions.kanbanId) {
      try {
        const result = await api.listLinks(boardId, { kanbanId: linkOptions.kanbanId, signal: linkOptions.signal });
        return cloneTrackerData(result.links);
      } catch (caught) {
        const error = asTrackerError(caught);
        setReadonlyFrom(error);
        notify();
        throw error;
      }
    }
    const cached = linksCaches.get(boardId);
    if (!linkOptions.force && cached && now() - cached.fetchedAt < linkCacheTtlMs) {
      rememberLinks(boardId, cached);
      return cloneTrackerData(cached.links);
    }
    if (!linkOptions.force && cached?.pending) return cloneTrackerData(await cached.pending);
    const entry: TrackerLinksCacheEntry = cached ?? { links: [], fetchedAt: 0 };
    const request = api.listLinks(boardId, { signal: linkOptions.signal }).then((result) => {
      entry.links = cloneTrackerData(result.links);
      entry.fetchedAt = now();
      entry.pending = undefined;
      rememberLinks(boardId, entry);
      return cloneTrackerData(entry.links);
    }).catch((caught: unknown) => {
      entry.pending = undefined;
      const error = asTrackerError(caught);
      setReadonlyFrom(error);
      notify();
      throw error;
    });
    entry.pending = request;
    rememberLinks(boardId, entry);
    return cloneTrackerData(await request);
  }

  async function suggestLinkMapping(boardId: string, kanbanId: string, linkOptions: TrackerLinkOptions = {}): Promise<TrackerLinkSuggestion> {
    if (!boardId || !kanbanId) throw new TrackerError('invalid_input', 'Board and kanban ids are required.');
    const key = linkSuggestionCacheKey(boardId, kanbanId);
    const cached = linkSuggestionCaches.get(key);
    if (!linkOptions.force && cached && now() - cached.fetchedAt < linkCacheTtlMs) return cloneTrackerData(cached.suggestion);
    if (!linkOptions.force && cached?.pending) return cloneTrackerData(await cached.pending);
    const entry: TrackerSuggestionCacheEntry = cached ?? { suggestion: { map: {}, unmappedLanes: [], existingCardCount: 0, nextKey: null, stateNotMapped: [] }, fetchedAt: 0 };
    const request = api.suggestLinkMapping(boardId, kanbanId, { signal: linkOptions.signal }).then((result) => {
      entry.suggestion = cloneTrackerData(result);
      entry.fetchedAt = now();
      entry.pending = undefined;
      return cloneTrackerData(entry.suggestion);
    }).catch((caught: unknown) => {
      entry.pending = undefined;
      const error = asTrackerError(caught);
      setReadonlyFrom(error);
      notify();
      throw error;
    });
    entry.pending = request;
    linkSuggestionCaches.set(key, entry);
    while (linkSuggestionCaches.size > 100) linkSuggestionCaches.delete(linkSuggestionCaches.keys().next().value as string);
    return cloneTrackerData(await request);
  }

  /** After a link whose cards were not all written to the board at once: refresh the board's links until the server reports no pending projections (or about a minute passes). */
  const followingProjection = new Set<string>();
  function followProjection(boardId: string, attempt = 0): void {
    if (destroyed || attempt >= 30 || (attempt === 0 && followingProjection.has(boardId))) return;
    followingProjection.add(boardId);
    setTimer(() => {
      void listLinks(boardId, { force: true }).then((links) => {
        notify();
        if (links.some((link) => link.pendingProjections > 0)) followProjection(boardId, attempt + 1);
        else followingProjection.delete(boardId);
      }).catch(() => { followingProjection.delete(boardId); });
    }, 2000);
  }

  async function linkKanban(input: TrackerLinkKanbanInput): Promise<TrackerLinkKanbanResult> {
    if (!isOnline()) throw new TrackerError('offline', 'Kanbans can only be linked while online.');
    if (!meta) await loadMeta();
    assertWritable();
    try {
      const result = await api.linkKanban(cloneTrackerData(input));
      const cached = linksCaches.get(input.boardId);
      if (cached) {
        cached.links = [...cached.links.filter((item) => item.id !== result.link.id && item.kanbanId !== input.kanbanId), cloneTrackerData(result.link)];
        cached.fetchedAt = now();
        rememberLinks(input.boardId, cached);
      }
      linkSuggestionCaches.delete(linkSuggestionCacheKey(input.boardId, input.kanbanId));
      for (const key of listCaches.keys()) if (!watchQueries.has(key)) loadedLists.delete(key);
      for (const [key, query] of watchQueries) if (listListeners.has(key)) void loadList(query, { force: true }).catch(() => undefined);
      await Promise.all(result.created.map(({ key }) => loadTicket(key, true).catch(() => undefined)));
      if (result.projectionPending || result.link.pendingProjections > 0) followProjection(input.boardId);
      notify();
      return cloneTrackerData(result);
    } catch (caught) {
      const error = asTrackerError(caught);
      setReadonlyFrom(error);
      notify();
      throw error;
    }
  }

  async function unlinkKanban(id: string): Promise<TrackerUnlinkKanbanResult> {
    if (!isOnline()) throw new TrackerError('offline', 'Kanbans can only be unlinked while online.');
    if (!meta) await loadMeta();
    assertWritable();
    try {
      const result = await api.unlinkKanban(id);
      let found = false;
      for (const [boardId, cached] of linksCaches) {
        if (!cached.links.some((item) => item.id === id)) continue;
        found = true;
        cached.links = cached.links.filter((item) => item.id !== id);
        cached.fetchedAt = now();
        rememberLinks(boardId, cached);
      }
      if (!found) linksCaches.clear();
      for (const [key, state] of ticketCaches) if (state.detail) void loadTicket(key, true).catch(() => undefined);
      notify();
      return cloneTrackerData(result);
    } catch (caught) {
      const error = asTrackerError(caught);
      setReadonlyFrom(error);
      notify();
      throw error;
    }
  }

  async function createTicketForCard(linkId: string, cardId: string): Promise<TrackerCreateTicketForCardResult> {
    if (!isOnline()) throw new TrackerError('offline', 'A card can only be linked to the tracker while online.');
    if (!meta) await loadMeta();
    assertWritable();
    try {
      const result = await api.createTicketForCard(linkId, cardId);
      const boardIds = [...linksCaches].filter(([, cached]) => cached.links.some((item) => item.id === linkId)).map(([boardId]) => boardId);
      await Promise.all(boardIds.map(async (boardId) => {
        const cached = linksCaches.get(boardId);
        if (!cached) return;
        try {
          const fresh = await api.listLinks(boardId);
          cached.links = cloneTrackerData(fresh.links);
          cached.fetchedAt = now();
          rememberLinks(boardId, cached);
        } catch {
          cached.fetchedAt = 0;
        }
      }));
      for (const key of listCaches.keys()) if (!watchQueries.has(key)) loadedLists.delete(key);
      for (const [key, query] of watchQueries) if (listListeners.has(key)) void loadList(query, { force: true }).catch(() => undefined);
      await loadTicket(result.ticket.key, true).catch(() => undefined);
      notify();
      return cloneTrackerData(result);
    } catch (caught) {
      const error = asTrackerError(caught);
      setReadonlyFrom(error);
      notify();
      throw error;
    }
  }

  async function createLabel(name: string): Promise<TrackerLabel> {
    assertWritable();
    if (!meta) await loadMeta();
    if (meta?.canCreateLabels === false) throw new TrackerError('forbidden', 'You cannot create tracker labels.');
    try {
      const result = await api.createLabel(name);
      if (meta) meta = { ...meta, labels: [...meta.labels.filter((label) => label.id !== result.label.id), cloneTrackerData(result.label)] };
      notify();
      return cloneTrackerData(result.label);
    } catch (caught) {
      const error = asTrackerError(caught);
      setReadonlyFrom(error);
      throw error;
    }
  }

  function cacheProject(project: TrackerProject): void {
    if (!meta) return;
    const projects = meta.projects ?? [];
    const active = project.archivedAt == null;
    meta = {
      ...meta,
      projects: active
        ? [...projects.filter((item) => item.id !== project.id), cloneTrackerData(project)]
        : projects.filter((item) => item.id !== project.id),
    };
  }

  function cacheMilestone(milestone: TrackerMilestone): void {
    if (!meta) return;
    const milestones = meta.milestones ?? [];
    const active = milestone.archivedAt == null;
    meta = {
      ...meta,
      milestones: active
        ? [...milestones.filter((item) => item.id !== milestone.id), cloneTrackerData(milestone)]
        : milestones.filter((item) => item.id !== milestone.id),
    };
  }

  function cacheView(view: TrackerSavedView): void {
    if (!meta) return;
    const summary = { id: view.id, name: view.name, shared: view.shared, mine: view.mine };
    meta = { ...meta, views: [...(meta.views ?? []).filter((item) => item.id !== view.id), summary] };
  }

  async function listProjects(projectOptions: TrackerProjectListOptions = {}): Promise<TrackerProject[]> {
    if (!meta) await loadMeta();
    try {
      const result = await api.listProjects(projectOptions);
      if (meta && !projectOptions.includeArchived) meta = { ...meta, projects: cloneTrackerData(result.projects) };
      notify();
      return cloneTrackerData(result.projects);
    } catch (caught) {
      const error = asTrackerError(caught); setReadonlyFrom(error); throw error;
    }
  }

  async function createProject(input: TrackerProjectInput): Promise<TrackerProject> {
    assertWritable();
    if (!meta) await loadMeta();
    assertWritable();
    try {
      const result = await api.createProject(input);
      cacheProject(result.project);
      notify();
      return cloneTrackerData(result.project);
    } catch (caught) {
      const error = asTrackerError(caught); setReadonlyFrom(error); throw error;
    }
  }

  async function updateProject(id: string, patch: TrackerProjectPatch): Promise<TrackerProject> {
    assertWritable();
    if (!meta) await loadMeta();
    assertWritable();
    const previous = meta?.projects ? cloneTrackerData(meta.projects) : undefined;
    if (meta?.projects) {
      const project = meta.projects.find((item) => item.id === id);
      if (project) {
        const owner = patch.ownerId === null ? null : typeof patch.ownerId === 'string'
          ? meta.members.find((member) => member.userId === patch.ownerId || member.name.toLocaleLowerCase() === patch.ownerId?.toLocaleLowerCase())
          : undefined;
        cacheProject({
          ...project,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.state !== undefined ? { state: patch.state } : {}),
          ...(patch.ownerId !== undefined && (owner || patch.ownerId === null) ? { owner: owner ? { userId: owner.userId, name: owner.name } : null } : {}),
          ...(patch.archived !== undefined ? { archivedAt: patch.archived ? (project.archivedAt ?? now()) : null } : {}),
        });
        notify();
      }
    }
    try {
      const result = await api.updateProject(id, patch);
      cacheProject(result.project);
      notify();
      return cloneTrackerData(result.project);
    } catch (caught) {
      if (meta && previous) meta = { ...meta, projects: previous };
      const error = asTrackerError(caught); setReadonlyFrom(error); notify(); throw error;
    }
  }

  async function listMilestones(projectId: string): Promise<TrackerMilestone[]> {
    if (!meta) await loadMeta();
    try {
      const result = await api.listMilestones(projectId);
      if (meta) {
        const listed = new Set(result.milestones.map((milestone) => milestone.id));
        meta = {
          ...meta,
          milestones: [
            ...(meta.milestones ?? []).filter((milestone) => milestone.projectId !== projectId && !listed.has(milestone.id)),
            ...cloneTrackerData(result.milestones),
          ],
        };
      }
      notify();
      return cloneTrackerData(result.milestones);
    } catch (caught) {
      const error = asTrackerError(caught); setReadonlyFrom(error); throw error;
    }
  }

  async function createMilestone(projectId: string, input: TrackerMilestoneInput): Promise<TrackerMilestone> {
    assertWritable();
    if (!meta) await loadMeta();
    assertWritable();
    try {
      const result = await api.createMilestone(projectId, input);
      cacheMilestone(result.milestone);
      notify();
      return cloneTrackerData(result.milestone);
    } catch (caught) {
      const error = asTrackerError(caught); setReadonlyFrom(error); throw error;
    }
  }

  async function updateMilestone(id: string, patch: TrackerMilestonePatch): Promise<TrackerMilestone> {
    assertWritable();
    if (!meta) await loadMeta();
    assertWritable();
    const previous = meta?.milestones ? cloneTrackerData(meta.milestones) : undefined;
    if (meta?.milestones) {
      const milestone = meta.milestones.find((item) => item.id === id);
      if (milestone) {
        cacheMilestone({
          ...milestone,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.due !== undefined ? { due: patch.due } : {}),
          ...(patch.state !== undefined ? { state: patch.state } : {}),
          ...(patch.archived !== undefined ? { archivedAt: patch.archived ? (milestone.archivedAt ?? now()) : null } : {}),
        });
        notify();
      }
    }
    try {
      const result = await api.updateMilestone(id, patch);
      cacheMilestone(result.milestone);
      notify();
      return cloneTrackerData(result.milestone);
    } catch (caught) {
      if (meta && previous) meta = { ...meta, milestones: previous };
      const error = asTrackerError(caught); setReadonlyFrom(error); notify(); throw error;
    }
  }

  async function listViews(): Promise<TrackerSavedView[]> {
    if (!meta) await loadMeta();
    try {
      const result = await api.listViews();
      if (meta) meta = { ...meta, views: result.views.map(({ id, name, shared, mine }) => ({ id, name, shared, mine })) };
      notify();
      return cloneTrackerData(result.views);
    } catch (caught) {
      const error = asTrackerError(caught); setReadonlyFrom(error); throw error;
    }
  }

  async function runView(id: string, query: TrackerSavedViewRunQuery = {}): Promise<TrackerSavedViewPage> {
    if (!meta) await loadMeta();
    try {
      const result = await api.runView(id, query);
      cacheView(result.view);
      notify();
      return cloneTrackerData(result);
    } catch (caught) {
      const error = asTrackerError(caught); setReadonlyFrom(error); throw error;
    }
  }

  async function createView(input: TrackerSavedViewInput): Promise<TrackerSavedView> {
    assertWritable();
    if (!meta) await loadMeta();
    assertWritable();
    try {
      const result = await api.createView(input);
      cacheView(result.view);
      notify();
      return cloneTrackerData(result.view);
    } catch (caught) {
      const error = asTrackerError(caught); setReadonlyFrom(error); throw error;
    }
  }

  async function updateView(id: string, patch: TrackerSavedViewPatch): Promise<TrackerSavedView> {
    assertWritable();
    if (!meta) await loadMeta();
    assertWritable();
    const previous = meta?.views ? cloneTrackerData(meta.views) : undefined;
    if (meta?.views) {
      const view = meta.views.find((item) => item.id === id);
      if (view) {
        const optimistic = { ...view, ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.shared !== undefined ? { shared: patch.shared } : {}) };
        meta = { ...meta, views: [...meta.views.filter((item) => item.id !== id), optimistic] };
        notify();
      }
    }
    try {
      const result = await api.updateView(id, patch);
      cacheView(result.view);
      notify();
      return cloneTrackerData(result.view);
    } catch (caught) {
      if (meta && previous) meta = { ...meta, views: previous };
      const error = asTrackerError(caught); setReadonlyFrom(error); notify(); throw error;
    }
  }

  async function deleteView(id: string): Promise<void> {
    assertWritable();
    if (!meta) await loadMeta();
    assertWritable();
    const previous = meta?.views ? cloneTrackerData(meta.views) : undefined;
    if (meta?.views) {
      meta = { ...meta, views: meta.views.filter((view) => view.id !== id) };
      notify();
    }
    try {
      await api.deleteView(id);
      notify();
    } catch (caught) {
      if (meta && previous) meta = { ...meta, views: previous };
      const error = asTrackerError(caught); setReadonlyFrom(error); notify(); throw error;
    }
  }

  async function loadList(query: TrackerListQuery = {}, loadOptions: { force?: boolean } = {}): Promise<TrackerListCache> {
    const state = listCache(query);
    if ((loadedLists.has(state.key) || state.loading) && !loadOptions.force) return cloneTrackerData(state);
    state.loading = true;
    state.error = undefined;
    notify();
    try {
      const page: TrackerTicketListPage = await api.listTickets({ ...query, cursor: undefined });
      state.tickets = page.tickets.map((ticket) => {
        const cached = ticketCache(ticket.key);
        return cached.pending && cached.ticket ? cloneTrackerData(cached.ticket) : cloneTrackerData(ticket);
      });
      state.nextCursor = page.nextCursor;
      state.facets = page.facets ? cloneTrackerData(page.facets) : undefined;
      state.loading = false;
      state.loadingMore = false;
      loadedLists.add(state.key);
      for (const ticket of page.tickets) saveTicket(ticket, { preserveLocal: true });
      notify();
      return cloneTrackerData(state);
    } catch (caught) {
      state.loading = false;
      state.loadingMore = false;
      state.error = asTrackerError(caught);
      setReadonlyFrom(state.error);
      notify();
      throw state.error;
    }
  }

  async function loadMore(query: TrackerListQuery = {}): Promise<TrackerListCache> {
    const state = listCache(query);
    if (!state.nextCursor || state.loadingMore) return cloneTrackerData(state);
    state.loadingMore = true;
    state.error = undefined;
    notify();
    try {
      const page = await api.listTickets({ ...query, cursor: state.nextCursor });
      const seen = new Set(state.tickets.map((ticket) => ticket.key));
      state.tickets = [...state.tickets, ...page.tickets.filter((ticket) => !seen.has(ticket.key)).map((ticket) => {
        const cached = ticketCache(ticket.key);
        return cached.pending && cached.ticket ? cloneTrackerData(cached.ticket) : cloneTrackerData(ticket);
      })];
      state.nextCursor = page.nextCursor;
      state.facets = page.facets ? cloneTrackerData(page.facets) : state.facets;
      state.loadingMore = false;
      for (const ticket of page.tickets) saveTicket(ticket, { preserveLocal: true });
      notify();
      return cloneTrackerData(state);
    } catch (caught) {
      state.loadingMore = false;
      state.error = asTrackerError(caught);
      setReadonlyFrom(state.error);
      notify();
      throw state.error;
    }
  }

  async function loadTicketNow(key: string, force = false): Promise<TrackerTicketDetail> {
    const state = ticketCache(key);
    if (state.detail && !force) return cloneTrackerData(state.detail);
    const hadConflict = state.conflict !== undefined;
    state.loading = true;
    if (!hadConflict) state.error = undefined;
    notify();
    try {
      const detail = await api.getTicket(key);
      const previousDetail = state.detail;
      const previousCommentsHasMore = state.commentsHasMore;
      const previousEventsHasMore = state.eventsHasMore;
      const mergeActivity = <T extends { id: string | number; createdAt?: number; at?: number }>(
        previous: T[], latest: T[], time: (item: T) => number,
      ): T[] => {
        const rows = new Map<string | number, T>();
        for (const item of previous) rows.set(item.id, item);
        for (const item of latest) rows.set(item.id, item);
        return [...rows.values()].sort((left, right) => time(left) - time(right) || (
          typeof left.id === 'number' && typeof right.id === 'number' ? left.id - right.id : String(left.id).localeCompare(String(right.id))
        ));
      };
      const comments = previousDetail
        ? mergeActivity(previousDetail.comments, detail.comments, (comment) => comment.createdAt)
        : detail.comments;
      const events = previousDetail
        ? mergeActivity(previousDetail.events, detail.events, (event) => event.at)
        : detail.events;
      const pendingTicket = state.pending ? state.ticket : undefined;
      const pendingSubscription = state.pending ? state.subscribed : undefined;
      state.ticket = cloneTrackerData(pendingTicket ?? detail.ticket);
      state.detail = { ...cloneTrackerData(detail), comments: cloneTrackerData(comments), events: cloneTrackerData(events), ticket: cloneTrackerData(pendingTicket ?? detail.ticket) };
      state.commentsHasMore = previousDetail ? previousCommentsHasMore ?? detail.comments.length >= 50 : detail.comments.length >= 50;
      state.eventsHasMore = previousDetail ? previousEventsHasMore ?? detail.events.length >= 50 : detail.events.length >= 50;
      state.commentsBefore = state.commentsHasMore ? comments[0]?.id : undefined;
      state.eventsBefore = state.eventsHasMore ? events[0]?.id : undefined;
      state.subscribed = pendingSubscription ?? detail.subscribed;
      state.detail.subscribed = state.subscribed;
      state.loading = false;
      if (hadConflict) {
        state.conflict = cloneTrackerData(detail.ticket);
        state.conflictBy = state.conflictBy ?? conflictActorFromDetail(detail);
        state.error = new TrackerError('conflict', 'This ticket changed while you were editing it.', { current: detail.ticket, by: state.conflictBy });
      }
      saveTicket(detail.ticket, { preserveLocal: true });
      notify();
      return cloneTrackerData(state.detail);
    } catch (caught) {
      state.loading = false;
      state.error = asTrackerError(caught);
      if (state.error.code === 'not_found' || state.error.code === 'forbidden') {
        state.ticket = undefined;
        state.detail = undefined;
        state.subscribed = undefined;
        state.conflict = undefined;
        state.conflictBy = undefined;
      }
      setReadonlyFrom(state.error);
      notify();
      throw state.error;
    }
  }

  function loadTicket(key: string, force = false): Promise<TrackerTicketDetail> {
    const normalized = cacheTicketKey(key);
    const cached = ticketCache(normalized);
    if (cached.detail && !force) return Promise.resolve(cloneTrackerData(cached.detail));
    const pending = ticketLoadPromises.get(normalized);
    if (pending && !force) return pending.then(cloneTrackerData);
    const request = loadTicketNow(key, force);
    ticketLoadPromises.set(normalized, request);
    return request.finally(() => {
      if (ticketLoadPromises.get(normalized) === request) ticketLoadPromises.delete(normalized);
    });
  }

  async function loadOlderActivity(key: string): Promise<TrackerTicketDetail> {
    const state = ticketCache(key);
    if (!state.detail) await loadTicket(key);
    const current = state.detail;
    if (!current) return cloneTrackerData(await loadTicket(key));
    if (state.loadingOlderActivity) return cloneTrackerData(current);
    const commentsBefore = state.commentsHasMore === false ? undefined : state.commentsBefore ?? current.comments[0]?.id;
    const eventsBefore = state.eventsHasMore === false ? undefined : state.eventsBefore ?? current.events[0]?.id;
    if (commentsBefore === undefined && eventsBefore === undefined) return cloneTrackerData(current);
    state.loadingOlderActivity = true;
    notify();
    try {
      const [commentsPage, eventsPage] = await Promise.all([
        commentsBefore === undefined ? Promise.resolve(null) : api.ticketComments(key, { before: commentsBefore, limit: 50 }),
        eventsBefore === undefined ? Promise.resolve(null) : api.ticketEvents(key, { before: eventsBefore, limit: 50 }),
      ]);
      if (state.detail) {
        if (commentsPage) {
          const known = new Set(state.detail.comments.map((comment) => comment.id));
          state.detail.comments = [...commentsPage.comments.filter((comment) => !known.has(comment.id)), ...state.detail.comments];
          state.commentsBefore = commentsPage.nextCursor ?? undefined;
          state.commentsHasMore = commentsPage.nextCursor !== null;
        } else state.commentsHasMore = false;
        if (eventsPage) {
          const known = new Set(state.detail.events.map((event) => event.id));
          state.detail.events = [...eventsPage.events.filter((event) => !known.has(event.id)), ...state.detail.events];
          state.eventsBefore = eventsPage.nextCursor ?? undefined;
          state.eventsHasMore = eventsPage.nextCursor !== null;
        } else state.eventsHasMore = false;
      }
      state.loadingOlderActivity = false;
      notify();
      return cloneTrackerData(state.detail ?? current);
    } catch (caught) {
      state.loadingOlderActivity = false;
      state.error = asTrackerError(caught);
      notify();
      throw state.error;
    }
  }

  function updateCacheTicket(state: TrackerTicketCache, ticket: TrackerTicket): void {
    state.ticket = cloneTrackerData(ticket);
    if (state.detail) state.detail = { ...state.detail, ticket: cloneTrackerData(ticket) };
    updateListRows(ticket);
  }

  function enqueue(key: string, edit: QueuedEdit): void {
    const normalized = cacheTicketKey(key);
    const queue = offlineQueue.get(normalized) ?? [];
    queue.push(edit);
    offlineQueue.set(normalized, queue);
    const state = ticketCache(normalized);
    state.pending = true;
    state.offlineQueued = true;
    state.error = undefined;
    notify();
  }

  async function handleMutationFailure(key: string, state: TrackerTicketCache, prior: TrackerTicketCache, error: TrackerError): Promise<never> {
    const surfacedError = await enrichConflict(key, error);
    setReadonlyFrom(error);
    if (surfacedError.code === 'conflict') {
      const current = surfacedError.current;
      if (current) {
        updateCacheTicket(state, current);
        saveTicket(current);
        state.conflict = cloneTrackerData(current);
        state.conflictBy = surfacedError.by;
      } else {
        state.ticket = prior.ticket;
        state.detail = prior.detail;
        state.conflict = prior.ticket;
        state.conflictBy = surfacedError.by;
        if (prior.ticket) updateListRows(prior.ticket);
      }
      state.error = surfacedError;
      state.pending = false;
      state.offlineQueued = offlineQueue.has(cacheTicketKey(key));
      if (state.offlineQueued) blockedQueue.add(cacheTicketKey(key));
    } else {
      state.ticket = prior.ticket;
      state.detail = prior.detail;
      if (prior.ticket) updateListRows(prior.ticket);
      state.subscribed = prior.subscribed;
      state.conflict = prior.conflict;
      state.conflictBy = prior.conflictBy;
      state.pending = prior.pending;
      state.offlineQueued = prior.offlineQueued;
      state.error = surfacedError;
    }
    notify();
    throw surfacedError;
  }

  async function ensureCurrent(key: string): Promise<TrackerTicket> {
    const cached = ticketCache(key).ticket;
    if (cached) return cached;
    return (await loadTicket(key)).ticket;
  }

  async function createTicket(input: Omit<TrackerCreateInput, 'idempotencyKey'> & { idempotencyKey?: string }): Promise<TrackerTicket> {
    if (!isOnline()) throw new TrackerError('offline', 'New tickets can only be created while online.');
    assertWritable();
    try {
      const result = await api.createTicket({ ...input, idempotencyKey: input.idempotencyKey ?? makeLocalId('tracker-create') });
      saveTicket(result.ticket);
      ticketCache(result.ticket.key).pending = false;
      for (const [key, query] of watchQueries) {
        if (listListeners.has(key)) void loadList(query, { force: true }).catch(() => undefined);
      }
      for (const key of listCaches.keys()) if (!watchQueries.has(key)) loadedLists.delete(key);
      notify();
      return cloneTrackerData(result.ticket);
    } catch (caught) {
      const error = asTrackerError(caught);
      setReadonlyFrom(error);
      notify();
      throw error;
    }
  }

  async function updateTicket(key: string, patch: Omit<TrackerPatch, 'ifUpdatedSeq'>, updateOptions: TrackerUpdateOptions = {}): Promise<TrackerTicket> {
    assertWritable();
    if (patch.state !== undefined && !meta) await loadMeta();
    const current = await ensureCurrent(key);
    const state = ticketCache(key);
    const prior = cloneTrackerData(state);
    const ifUpdatedSeq = updateOptions.ifUpdatedSeq ?? current.updatedSeq;
    const optimistic = ticketWithPatch(current, patch, meta, now());
    updateCacheTicket(state, optimistic);
    state.pending = true;
    state.error = undefined;
    state.conflict = undefined;
    state.conflictBy = undefined;
    notify();
    if (!isOnline()) {
      enqueue(key, { kind: 'patch', value: cloneTrackerData(patch), baseSeq: ifUpdatedSeq });
      return cloneTrackerData(optimistic);
    }
    try {
      const result = await api.patchTicket(key, { ...patch, ifUpdatedSeq });
      updateCacheTicket(state, result.ticket);
      saveTicket(result.ticket);
      state.pending = false;
      state.offlineQueued = false;
      state.error = undefined;
      notify();
      return cloneTrackerData(result.ticket);
    } catch (caught) {
      return handleMutationFailure(key, state, prior, asTrackerError(caught));
    }
  }

  async function transitionTicket(key: string, stateName: string): Promise<TrackerTicket> {
    assertWritable();
    const current = await ensureCurrent(key);
    const state = ticketCache(key);
    const prior = cloneTrackerData(state);
    const target = meta?.states.find((candidate) => candidate.id === stateName || candidate.key.toLowerCase() === stateName.toLowerCase() || candidate.name.toLowerCase() === stateName.toLowerCase());
    const optimistic = cloneTrackerData(current);
    if (target) optimistic.state = { id: target.id, key: target.key, name: target.name, category: target.category };
    state.ticket = optimistic;
    if (state.detail) state.detail = { ...state.detail, ticket: cloneTrackerData(optimistic) };
    state.pending = true;
    state.error = undefined;
    state.conflict = undefined;
    state.conflictBy = undefined;
    notify();
    if (!isOnline()) {
      enqueue(key, { kind: 'transition', value: stateName, baseSeq: current.updatedSeq });
      return cloneTrackerData(optimistic);
    }
    try {
      const result = await api.transitionTicket(key, stateName);
      updateCacheTicket(state, result.ticket);
      saveTicket(result.ticket);
      state.pending = false;
      state.offlineQueued = false;
      notify();
      return cloneTrackerData(result.ticket);
    } catch (caught) {
      return handleMutationFailure(key, state, prior, asTrackerError(caught));
    }
  }

  async function addComment(key: string, body: string, clientId = makeLocalId('tracker-comment')): Promise<TrackerComment> {
    assertWritable();
    const current = await ensureCurrent(key);
    const state = ticketCache(key);
    const prior = cloneTrackerData(state);
    const optimistic: TrackerComment = {
      id: `pending:${clientId}`, ticketKey: current.key,
      author: { userId: meta?.me.userId ?? null, name: meta?.members.find((member) => member.userId === meta?.me.userId)?.name ?? 'You' },
      body, clientId, createdAt: now(), editedAt: null,
    };
    if (!state.detail) state.detail = { ticket: cloneTrackerData(current), comments: [], events: [], subscribed: state.subscribed ?? false };
    state.detail.comments = [...state.detail.comments, optimistic];
    state.pending = true;
    state.error = undefined;
    notify();
    if (!isOnline()) {
      enqueue(key, { kind: 'comment', value: { body, clientId, localId: optimistic.id }, baseSeq: current.updatedSeq });
      return cloneTrackerData(optimistic);
    }
    try {
      const result = await api.addComment(key, { body, clientId });
      updateCacheTicket(state, result.ticket);
      if (state.detail) {
        state.detail.comments = state.detail.comments.filter((comment) => comment.clientId !== clientId);
        state.detail.comments.push(cloneTrackerData(result.comment));
      }
      saveTicket(result.ticket);
      state.pending = false;
      state.offlineQueued = false;
      notify();
      return cloneTrackerData(result.comment);
    } catch (caught) {
      const error = asTrackerError(caught);
      if (state.detail) state.detail.comments = state.detail.comments.filter((comment) => comment.clientId !== clientId);
      return handleMutationFailure(key, state, prior, error);
    }
  }

  async function editComment(key: string, id: string, body: string): Promise<TrackerComment> {
    assertWritable();
    const state = ticketCache(key);
    if (!state.detail) await loadTicket(key);
    if (!state.detail) throw new TrackerError('not_found', `No ticket found for ${key}.`);
    const prior = cloneTrackerData(state.detail);
    const existing = state.detail.comments.find((comment) => comment.id === id);
    if (!existing) throw new TrackerError('not_found', `No comment found for ${id}.`);
    const optimistic = { ...existing, body, editedAt: now() };
    state.detail.comments = state.detail.comments.map((comment) => comment.id === id ? optimistic : comment);
    notify();
    try {
      const result = await api.editComment(id, body);
      if (state.detail) state.detail.comments = state.detail.comments.map((comment) => comment.id === id ? cloneTrackerData(result.comment) : comment);
      notify();
      return cloneTrackerData(result.comment);
    } catch (caught) {
      state.detail = prior;
      const error = asTrackerError(caught);
      setReadonlyFrom(error);
      notify();
      throw error;
    }
  }

  async function deleteComment(key: string, id: string): Promise<void> {
    assertWritable();
    const state = ticketCache(key);
    if (!state.detail) await loadTicket(key);
    if (!state.detail) throw new TrackerError('not_found', `No ticket found for ${key}.`);
    const prior = cloneTrackerData(state.detail);
    const existing = state.detail.comments.find((comment) => comment.id === id);
    if (!existing) throw new TrackerError('not_found', `No comment found for ${id}.`);
    state.detail.comments = state.detail.comments.map((comment) => comment.id === id
      ? { ...comment, body: '', deleted: true, deletedAt: now() }
      : comment);
    notify();
    try {
      await api.deleteComment(id);
      notify();
    } catch (caught) {
      state.detail = prior;
      const error = asTrackerError(caught);
      setReadonlyFrom(error);
      notify();
      throw error;
    }
  }

  async function setSubscription(key: string, subscribed: boolean): Promise<boolean> {
    assertWritable();
    const state = ticketCache(key);
    const prior = cloneTrackerData(state);
    state.subscribed = subscribed;
    if (state.detail) state.detail.subscribed = subscribed;
    state.pending = true;
    state.error = undefined;
    notify();
    if (!isOnline()) {
      enqueue(key, { kind: 'subscription', value: subscribed, baseSeq: state.ticket?.updatedSeq ?? 0 });
      return subscribed;
    }
    try {
      const result = await api.setSubscription(key, subscribed);
      state.subscribed = result.subscribed;
      if (state.detail) state.detail.subscribed = result.subscribed;
      state.pending = false;
      notify();
      return result.subscribed;
    } catch (caught) {
      return handleMutationFailure(key, state, prior, asTrackerError(caught));
    }
  }

  async function bulk(keys: string[], patch: TrackerBulkPatch): Promise<TrackerUndoBatch> {
    assertWritable();
    if (patch.state !== undefined && !meta) await loadMeta();
    assertWritable();
    const uniqueKeys = [...new Set(keys.map((key) => cacheTicketKey(key)))];
    const tickets = await Promise.all(uniqueKeys.map((key) => ensureCurrent(key)));
    const prior = new Map(uniqueKeys.map((key) => [key, cloneTrackerData(ticketCache(key))]));
    const before: TrackerBulkResult['before'] = {};
    uniqueKeys.forEach((key, index) => {
      before[key] = { patch: patchValuesBefore(tickets[index], patch), updatedSeq: tickets[index].updatedSeq };
      const state = ticketCache(key);
      updateCacheTicket(state, ticketWithPatch(tickets[index], patch, meta, now()));
      state.pending = true;
      state.error = undefined;
      state.conflict = undefined;
      state.conflictBy = undefined;
    });
    notify();
    if (!isOnline()) {
      uniqueKeys.forEach((key, index) => enqueue(key, { kind: 'patch', value: cloneTrackerData(patch), baseSeq: tickets[index].updatedSeq }));
      return { batchId: makeLocalId('offline-batch'), before };
    }
    try {
      const result = await api.bulkTickets({ keys: uniqueKeys, patch });
      const undoBefore: TrackerBulkResult['before'] = {};
      for (const item of result.results) {
        const state = ticketCache(item.key);
        if (item.ok && item.ticket) {
          updateCacheTicket(state, item.ticket);
          saveTicket(item.ticket);
          state.pending = false;
          state.offlineQueued = false;
          const localBefore = before[cacheTicketKey(item.key)];
          const priorPatch = item.before ?? result.before[cacheTicketKey(item.key)]?.patch ?? localBefore?.patch;
          if (localBefore && priorPatch && Object.keys(priorPatch).length > 0) {
            undoBefore[item.ticket.key] = { patch: cloneTrackerData(priorPatch), updatedSeq: localBefore.updatedSeq };
          }
        } else {
          const old = prior.get(cacheTicketKey(item.key));
          if (old) { state.ticket = old.ticket; state.detail = old.detail; if (old.ticket) updateListRows(old.ticket); }
          state.pending = false;
          const errorBody = isRecord(item.error) ? item.error : {};
          const rawCode = isRecord(item.error) ? item.error.error : item.error;
          state.error = new TrackerError(
            isErrorCode(rawCode) ? rawCode : 'internal',
            typeof errorBody.message === 'string' ? errorBody.message : String(rawCode ?? 'Bulk update failed.'),
            { path: typeof errorBody.path === 'string' ? errorBody.path : undefined, current: item.ticket },
          );
          setReadonlyFrom(state.error);
          if (state.error.code === 'conflict') {
            const conflict = await enrichConflict(item.ticket?.key ?? item.key, state.error);
            state.error = conflict;
            if (conflict.current) {
              updateCacheTicket(state, conflict.current);
              state.conflict = cloneTrackerData(conflict.current);
              state.conflictBy = conflict.by;
            }
          }
        }
      }
      notify();
      return { batchId: result.batchId, before: undoBefore };
    } catch (caught) {
      let error = asTrackerError(caught);
      if (error.code === 'conflict') error = await enrichConflict(error.current?.key ?? uniqueKeys[0] ?? '', error);
      for (const key of uniqueKeys) {
        const state = ticketCache(key);
        const old = prior.get(key);
        if (old) {
          state.ticket = old.ticket; state.detail = old.detail; state.subscribed = old.subscribed;
          if (old.ticket) updateListRows(old.ticket);
        }
        state.pending = false;
        state.error = error;
      }
      if (error.code === 'conflict' && error.current) {
        const state = ticketCache(error.current.key);
        updateCacheTicket(state, error.current);
        state.conflict = cloneTrackerData(error.current);
        state.conflictBy = error.by;
      }
      setReadonlyFrom(error);
      notify();
      throw error;
    }
  }

  async function applyHistoryBatch(batch: TrackerUndoBatch, action: 'undo' | 'redo'): Promise<TrackerBulkResult> {
    const entries = Object.entries(batch.before);
    const beforeNext: TrackerBulkResult['before'] = {};
    const results = await Promise.all(entries.map(async ([key, before]) => {
      try {
        const current = await ensureCurrent(key);
        const updated = await updateTicket(key, before.patch);
        const priorPatch = patchValuesBefore(current, before.patch);
        if (Object.keys(priorPatch).length > 0) {
          beforeNext[updated.key] = { patch: priorPatch, updatedSeq: current.updatedSeq };
        }
        return { key, ok: true, ticket: updated };
      } catch (caught) {
        const error = asTrackerError(caught);
        const state = ticketCache(key);
        setReadonlyFrom(error);
        if (error.code === 'conflict') {
          const conflict = await enrichConflict(key, error);
          if (conflict.current) {
            updateCacheTicket(state, conflict.current);
            state.conflict = cloneTrackerData(conflict.current);
            state.conflictBy = conflict.by;
          }
          state.error = conflict;
        } else {
          state.error = error;
        }
        state.pending = false;
        return { key, ok: false, error: error.code };
      }
    }));
    notify();
    return { batchId: `${action}:${batch.batchId}`, results, before: beforeNext };
  }

  async function undo(batch: TrackerUndoBatch): Promise<TrackerBulkResult> {
    return applyHistoryBatch(batch, 'undo');
  }

  async function redo(batch: TrackerUndoBatch): Promise<TrackerBulkResult> {
    return applyHistoryBatch(batch, 'redo');
  }

  async function replayOfflineQueue(): Promise<void> {
    if (!isOnline() || replaying || destroyed) return;
    replaying = true;
    try {
      for (const [key, queue] of offlineQueue) {
        if (blockedQueue.has(key) || queue.length === 0 || !isOnline()) continue;
        const state = ticketCache(key);
        let current = state.ticket;
        if (!current) {
          try { current = (await api.getTicket(key)).ticket; }
          catch (caught) { state.error = asTrackerError(caught); continue; }
        }
        let baseSeq = queue[0].baseSeq;
        let stop = false;
        while (queue.length > 0) {
          const edit = queue[0];
          if (!isOnline()) { stop = true; break; }
          try {
            let updated: TrackerTicket | undefined;
            if (edit.kind === 'patch') {
              updated = (await api.patchTicket(key, { ...(edit.value as TrackerBulkPatch), ifUpdatedSeq: baseSeq })).ticket;
            } else if (edit.kind === 'transition') {
              const fresh = (await api.getTicket(key)).ticket;
              if (fresh.updatedSeq !== baseSeq) throw new TrackerError('conflict', 'The ticket changed while this edit was offline.', { current: fresh });
              updated = (await api.transitionTicket(key, String(edit.value))).ticket;
            } else if (edit.kind === 'comment') {
              const comment = edit.value as { body: string; clientId: string; localId: string };
              const result = await api.addComment(key, { body: comment.body, clientId: comment.clientId });
              updated = result.ticket;
              if (state.detail) {
                state.detail.comments = state.detail.comments.filter((entry) => entry.id !== comment.localId && entry.clientId !== comment.clientId);
                state.detail.comments.push(cloneTrackerData(result.comment));
              }
            } else {
              state.subscribed = (await api.setSubscription(key, Boolean(edit.value))).subscribed;
              if (state.detail) state.detail.subscribed = state.subscribed;
            }
            if (updated) {
              current = updated;
              baseSeq = updated.updatedSeq;
              updateCacheTicket(state, updated);
              saveTicket(updated);
            }
            queue.shift();
            notify();
          } catch (caught) {
            let error = asTrackerError(caught);
            if (error.code === 'conflict') error = await enrichConflict(key, error);
            setReadonlyFrom(error);
            state.error = error;
            state.pending = false;
            if (error.code === 'conflict') {
              const latest = error.current;
              if (latest) {
                updateCacheTicket(state, latest);
                state.conflict = cloneTrackerData(latest);
                state.conflictBy = error.by;
                saveTicket(latest);
              }
              blockedQueue.add(key);
            }
            if (error.code !== 'network' && error.code !== 'offline') blockedQueue.add(key);
            stop = true;
            break;
          }
        }
        if (!stop && queue.length === 0) {
          offlineQueue.delete(key);
          state.pending = false;
          state.offlineQueued = false;
          state.error = undefined;
        } else {
          offlineQueue.set(key, queue);
          state.offlineQueued = queue.length > 0;
        }
        notify();
      }
    } finally {
      replaying = false;
    }
  }

  async function addRelation(key: string, relation: { kind: TrackerRelationKind; key: string }): Promise<TrackerTicket> {
    assertWritable();
    try {
      const result = await api.addRelation(key, relation);
      saveTicket(result.ticket);
      const state = ticketCache(key);
      updateCacheTicket(state, result.ticket);
      notify();
      return cloneTrackerData(result.ticket);
    } catch (caught) {
      let error = asTrackerError(caught);
      if (error.code === 'conflict') error = await enrichConflict(key, error);
      setReadonlyFrom(error); throw error;
    }
  }

  async function removeRelation(key: string, relation: { kind: TrackerRelationKind; key: string }): Promise<TrackerTicket> {
    assertWritable();
    try {
      const result = await api.removeRelation(key, relation);
      saveTicket(result.ticket);
      const state = ticketCache(key);
      updateCacheTicket(state, result.ticket);
      notify();
      return cloneTrackerData(result.ticket);
    } catch (caught) {
      let error = asTrackerError(caught);
      if (error.code === 'conflict') error = await enrichConflict(key, error);
      setReadonlyFrom(error); throw error;
    }
  }

  function watchTicket(key: string, listener: (state: TrackerTicketCache) => void): () => void {
    const normalized = cacheTicketKey(key);
    const listeners = ticketListeners.get(normalized) ?? new Set();
    listeners.add(listener);
    ticketListeners.set(normalized, listeners);
    deliver(listener, cloneTrackerData(ticketCache(normalized)));
    if (!ticketCache(normalized).detail) void loadTicket(key).catch(() => undefined);
    startWatching();
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) ticketListeners.delete(normalized);
      if (watchedCount() === 0) stopPoll();
    };
  }

  function watchList(query: TrackerListQuery, listener: (state: TrackerListCache) => void): () => void {
    const key = normalizeListQuery(query);
    const listeners = listListeners.get(key) ?? new Set();
    listeners.add(listener);
    listListeners.set(key, listeners);
    watchQueries.set(key, cloneTrackerData(query));
    deliver(listener, cloneTrackerData(listCache(query)));
    if (!loadedLists.has(key)) void loadList(query).catch(() => undefined);
    startWatching();
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) { listListeners.delete(key); watchQueries.delete(key); }
      if (watchedCount() === 0) stopPoll();
    };
  }

  const onlineListener = () => { void replayOfflineQueue(); };
  if (typeof window !== 'undefined') window.addEventListener('online', onlineListener);

  return {
    subscribe(listener) { generalListeners.add(listener); return () => generalListeners.delete(listener); },
    snapshot,
    loadMeta,
    listLinks,
    suggestLinkMapping,
    linkKanban,
    unlinkKanban,
    createTicketForCard,
    createLabel,
    listProjects,
    createProject,
    updateProject,
    listMilestones,
    createMilestone,
    updateMilestone,
    listViews,
    runView,
    createView,
    updateView,
    deleteView,
    loadList,
    loadMore,
    list(query = {}) { return cloneTrackerData(listCache(query)); },
    watchList,
    ticket(key) { return cloneTrackerData(ticketCache(key)); },
    loadTicket,
    loadOlderActivity,
    watchTicket,
    createTicket,
    updateTicket,
    transitionTicket,
    addComment,
    editComment,
    deleteComment,
    setSubscription,
    bulk,
    undo,
    redo,
    replayOfflineQueue,
    addRelation,
    removeRelation,
    destroy() {
      destroyed = true;
      stopPoll();
      if (typeof window !== 'undefined') window.removeEventListener('online', onlineListener);
      generalListeners.clear(); ticketListeners.clear(); listListeners.clear(); watchQueries.clear();
      offlineQueue.clear(); blockedQueue.clear(); linksCaches.clear(); linkSuggestionCaches.clear();
    },
  };
}

/** Keeps at most 50 successful tracker batches and coordinates their inverse batches. */
export function createUndoStack(store: Pick<TrackerStore, 'undo' | 'redo'>): TrackerUndoStack {
  const undoStack: TrackerUndoBatch[] = [];
  const redoStack: TrackerUndoBatch[] = [];
  const limit = 50;

  function pushBounded(stack: TrackerUndoBatch[], batch: TrackerUndoBatch): void {
    if (Object.keys(batch.before).length === 0) return;
    stack.push(cloneTrackerData(batch));
    if (stack.length > limit) stack.splice(0, stack.length - limit);
  }

  function keepFailed(batch: TrackerUndoBatch, result: TrackerBulkResult): void {
    const succeeded = new Set(result.results.filter((item) => item.ok).map((item) => cacheTicketKey(item.key)));
    const remaining = Object.fromEntries(Object.entries(batch.before).filter(([key]) => !succeeded.has(cacheTicketKey(key))));
    const top = undoStack.at(-1);
    if (top?.batchId === batch.batchId) {
      if (Object.keys(remaining).length) undoStack[undoStack.length - 1] = { ...batch, before: remaining };
      else undoStack.pop();
    }
    const inverse = Object.fromEntries(Object.entries(result.before).filter(([key]) => succeeded.has(cacheTicketKey(key))));
    if (Object.keys(inverse).length) pushBounded(redoStack, { batchId: result.batchId, before: inverse });
  }

  return {
    push(batch) {
      pushBounded(undoStack, batch);
      redoStack.length = 0;
    },
    async undo() {
      const batch = undoStack.at(-1);
      if (!batch) return undefined;
      const result = await store.undo(batch);
      keepFailed(batch, result);
      return result;
    },
    async redo() {
      const batch = redoStack.at(-1);
      if (!batch) return undefined;
      const result = await store.redo(batch);
      const succeeded = new Set(result.results.filter((item) => item.ok).map((item) => cacheTicketKey(item.key)));
      const remaining = Object.fromEntries(Object.entries(batch.before).filter(([key]) => !succeeded.has(cacheTicketKey(key))));
      if (redoStack.at(-1)?.batchId === batch.batchId) {
        if (Object.keys(remaining).length) redoStack[redoStack.length - 1] = { ...batch, before: remaining };
        else redoStack.pop();
      }
      const inverse = Object.fromEntries(Object.entries(result.before).filter(([key]) => succeeded.has(cacheTicketKey(key))));
      if (Object.keys(inverse).length) pushBounded(undoStack, { batchId: result.batchId, before: inverse });
      return result;
    },
    canUndo() { return undoStack.length > 0; },
    canRedo() { return redoStack.length > 0; },
  };
}

export interface TrackerKeyResolverOptions { now?: () => number }
export interface TrackerKeyResolver {
  resolveKeys(keys: readonly string[]): Promise<void>;
  destroy(): void;
}

const CHIP_KEY_RE = /^[A-Z]{2,5}-[1-9][0-9]{0,18}$/i;

/**
 * Resolve chip references using the existing per-ticket cache and detail endpoint. The REST API has no cheap batch
 * summary endpoint, so this helper keeps that contract unchanged: four concurrent requests, at most 100 unique keys
 * per call, and a 30-second negative cache for missing or unreadable tickets.
 */
export function createTrackerKeyResolver(
  store: Pick<TrackerStore, 'ticket' | 'loadTicket'>,
  options: TrackerKeyResolverOptions = {},
): TrackerKeyResolver {
  const now = options.now ?? Date.now;
  const negativeUntil = new Map<string, number>();
  const inFlight = new Map<string, Promise<void>>();
  const queue: Array<{ key: string; finish: () => void }> = [];
  let active = 0;
  let disposed = false;

  function drain(): void {
    while (!disposed && active < 4 && queue.length > 0) {
      const item = queue.shift()!;
      active += 1;
      void store.loadTicket(item.key).then(() => {
        negativeUntil.delete(item.key);
      }).catch(() => {
        negativeUntil.set(item.key, now() + 30_000);
        if (negativeUntil.size > 500) negativeUntil.delete(negativeUntil.keys().next().value!);
      }).finally(() => {
        active -= 1;
        inFlight.delete(item.key);
        item.finish();
        drain();
      });
    }
  }

  function resolveKeys(keys: readonly string[]): Promise<void> {
    if (disposed) return Promise.resolve();
    const unique = [...new Set(keys.filter((key): key is string => typeof key === 'string' && CHIP_KEY_RE.test(key.trim()))
      .map(cacheTicketKey))].slice(0, 100);
    const pending: Promise<void>[] = [];
    for (const key of unique) {
      const cached = store.ticket(key);
      if (cached.ticket || cached.detail || cached.loading) continue;
      const expiry = negativeUntil.get(key);
      if (expiry !== undefined) {
        if (expiry > now()) continue;
        negativeUntil.delete(key);
      }
      const existing = inFlight.get(key);
      if (existing) { pending.push(existing); continue; }
      let finish!: () => void;
      const task = new Promise<void>((resolve) => { finish = resolve; });
      inFlight.set(key, task);
      queue.push({ key, finish });
      pending.push(task);
    }
    drain();
    return Promise.all(pending).then(() => undefined);
  }

  return {
    resolveKeys,
    destroy() {
      disposed = true;
      for (const item of queue.splice(0)) {
        inFlight.delete(item.key);
        item.finish();
      }
      negativeUntil.clear();
    },
  };
}
