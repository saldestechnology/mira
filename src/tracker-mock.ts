import { TrackerError } from './tracker-types';
import type { TrackerApi, TrackerBulkInput, TrackerInboxReadInput, TrackerNotificationPrefsUpdate } from './tracker-data';
import {
  type TrackerBulkPatch,
  type TrackerBulkResult,
  type TrackerComment,
  type TrackerCreateInput,
  type TrackerEvent,
  type TrackerFeed,
  type TrackerFeedEvent,
  type TrackerInboxItem,
  type TrackerKanbanLink,
  type TrackerLinkKanbanInput,
  type TrackerLinkKanbanResult,
  type TrackerLinkSuggestion,
  type TrackerListQuery,
  type TrackerMeta,
  type TrackerNotificationKind,
  type TrackerNotifyChoice,
  type TrackerNotificationPrefs,
  type TrackerProject,
  type TrackerProjectInput,
  type TrackerProjectPatch,
  type TrackerMilestone,
  type TrackerMilestoneInput,
  type TrackerMilestonePatch,
  type TrackerPatch,
  type TrackerPriority,
  type TrackerRelationKind,
  type TrackerSavedView,
  type TrackerSavedViewInput,
  type TrackerSavedViewPatch,
  type TrackerState,
  type TrackerTicket,
  type TrackerTicketDetail,
} from './tracker-types';

export interface TrackerMockSeed {
  meta?: TrackerMeta;
  tickets?: TrackerTicket[];
  comments?: Record<string, TrackerComment[]>;
  events?: TrackerEvent[];
  inbox?: TrackerInboxItem[];
  now?: () => number;
  notificationPrefs?: TrackerNotificationPrefs;
  kanbans?: TrackerMockKanban[];
  forbiddenBoards?: string[];
}

export interface TrackerMockKanban {
  boardId: string;
  kanbanId: string;
  lanes: Array<{ id: string; name: string; stage?: 'todo' | 'doing' | 'done' }>;
  cards: Array<{
    id: string; laneId: string; title: string; description?: string; ownerId?: string; ownerName?: string;
    due?: string; labels?: string[]; linkedTicketKey?: string;
  }>;
}

const DEFAULT_STATES: TrackerState[] = [
  { id: 'state-todo', key: 'todo', name: 'To do', category: 'unstarted', position: 0 },
  { id: 'state-in-progress', key: 'in_progress', name: 'In progress', category: 'started', position: 1 },
  { id: 'state-in-review', key: 'in_review', name: 'In review', category: 'started', position: 2 },
  { id: 'state-done', key: 'done', name: 'Done', category: 'completed', position: 3 },
  { id: 'state-cancelled', key: 'cancelled', name: 'Cancelled', category: 'canceled', position: 4 },
];

function copy<T>(value: T): T {
  if (Array.isArray(value)) return value.map(copy) as T;
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) result[key] = copy(item);
    return result as T;
  }
  return value;
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(y, m - 1, d);
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function compare(a: string, b: string): number { return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }); }
function escapeSnippet(text: string): string { return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }

const NOTIFICATION_KINDS: TrackerNotificationKind[] = [
  'assigned', 'mentioned', 'commented', 'status_changed', 'due_soon', 'relation_changed', 'integration_activity',
];
const DEFAULT_NOTIFICATION_PREFS: Record<TrackerNotificationKind, TrackerNotifyChoice> = {
  assigned: 'both', mentioned: 'both', commented: 'app', status_changed: 'app', due_soon: 'both',
  relation_changed: 'app', integration_activity: 'app',
};

function encodeInboxCursor(item: TrackerInboxItem): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ createdAt: item.createdAt, id: item.id }));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeInboxCursor(value: string): { createdAt: number; id: string } {
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(base64 + '='.repeat((4 - base64.length % 4) % 4));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (decoded && typeof decoded === 'object' && 'createdAt' in decoded && 'id' in decoded
      && typeof decoded.createdAt === 'number' && Number.isSafeInteger(decoded.createdAt)
      && typeof decoded.id === 'string' && decoded.id) {
      return { createdAt: decoded.createdAt, id: decoded.id };
    }
  } catch { /* A malformed cursor is reported below. */ }
  throw new TrackerError('invalid_input', 'Must be a valid inbox cursor', { path: 'before' });
}

/** A stateful, server-shaped API for demos and deterministic client tests. */
export function createMockTrackerApi(seed: TrackerMockSeed = {}): TrackerApi {
  const now = seed.now ?? Date.now;
  const meta: TrackerMeta = copy(seed.meta ?? {
    enabled: true,
    trackerId: 'tracker-demo',
    prefix: 'TAB',
    states: DEFAULT_STATES,
    labels: [],
    members: [{ userId: 'user-me', name: 'You', initials: 'YO' }],
    me: { userId: 'user-me', canWrite: true },
  });
  const tickets = new Map<string, TrackerTicket>();
  const comments = new Map<string, TrackerComment[]>();
  const events = new Map<number, TrackerEvent>();
  const subscriptions = new Set<string>();
  const idempotentCreates = new Map<string, string>();
  const idempotentLinkCreates = new Map<string, TrackerLinkKanbanResult>();
  const idempotentComments = new Map<string, string>();
  let seq = 0;
  let nextNumber = 1;
  let serial = 0;
  let batchSerial = 0;
  let preferences: TrackerNotificationPrefs = copy(seed.notificationPrefs ?? {
    kinds: NOTIFICATION_KINDS,
    prefs: DEFAULT_NOTIFICATION_PREFS,
  });
  const inboxItems = copy(seed.inbox ?? []);
  const projects = new Map<string, TrackerProject>((meta.projects ?? []).map((project) => [project.id, copy(project)]));
  const milestones = new Map<string, TrackerMilestone>((meta.milestones ?? []).map((milestone) => [milestone.id, copy(milestone)]));
  const views = new Map<string, TrackerSavedView>((meta.views ?? []).map((view) => [view.id, {
    ...copy(view), filter: [], ownerUserId: view.mine ? meta.me.userId : undefined,
    owner: view.mine ? { userId: meta.me.userId, name: meta.members.find((member) => member.userId === meta.me.userId)?.name ?? 'You' } : undefined,
  }]));
  const kanbans = new Map((seed.kanbans ?? []).map((kanban) => [`${kanban.boardId}\u0000${kanban.kanbanId}`, copy(kanban)]));
  const forbiddenBoards = new Set(seed.forbiddenBoards ?? []);
  const links = new Map<string, { link: TrackerKanbanLink; cardIds: string[] }>();
  const actor = () => ({ userId: meta.me.userId, name: meta.members.find((member) => member.userId === meta.me.userId)?.name ?? 'You' });
  const newId = (kind: string) => `${kind}-${(++serial).toString(36)}`;
  const ensureWritable = () => {
    if (!meta.me.canWrite) throw new TrackerError('read_only', 'This tracker is read-only.');
  };
  const resolveTicket = (reference: string): TrackerTicket => {
    const needle = reference.trim().toLocaleUpperCase();
    const ticket = [...tickets.values()].find((item) => item.key.toLocaleUpperCase() === needle || item.id === reference || item.aliases.some((alias) => alias.toLocaleUpperCase() === needle));
    if (!ticket) throw new TrackerError('not_found', `No ticket found for ${reference}.`, { status: 404 });
    return ticket;
  };
  const resolveState = (reference: string): TrackerState => {
    const state = meta.states.find((item) => item.id === reference || item.key.toLocaleLowerCase() === reference.toLocaleLowerCase() || item.name.toLocaleLowerCase() === reference.toLocaleLowerCase());
    if (!state) throw new TrackerError('invalid_input', `No state matches ${reference}.`, { path: 'state' });
    return state;
  };
  const stateValue = (state: TrackerState): TrackerTicket['state'] => ({ id: state.id, key: state.key, name: state.name, category: state.category });
  const boardKanbanKey = (boardId: string, kanbanId: string) => `${boardId}\u0000${kanbanId}`;
  const assertBoardAllowed = (boardId: string) => {
    if (forbiddenBoards.has(boardId)) throw new TrackerError('board_forbidden', 'You cannot link kanbans on this board.', { status: 403 });
  };
  const findKanban = (boardId: string, kanbanId: string): TrackerMockKanban => {
    assertBoardAllowed(boardId);
    const kanban = kanbans.get(boardKanbanKey(boardId, kanbanId));
    if (!kanban) throw new TrackerError('kanban_not_found', 'The kanban no longer exists.', { status: 404 });
    return kanban;
  };

  function syncResourceMeta(): void {
    meta.projects = [...projects.values()].filter((project) => project.archivedAt == null).map(copy);
    meta.milestones = [...milestones.values()].filter((milestone) => milestone.archivedAt == null).map(copy);
    meta.views = [...views.values()].map(({ id, name, shared, mine }) => ({ id, name, shared, mine }));
  }

  function latestActor(ticket: TrackerTicket): { name: string; kind: string } | undefined {
    const latest = [...events.values()].filter((event) => event.ticketKey === ticket.key).sort((a, b) => a.id - b.id).at(-1);
    const actor = latest?.actor;
    if (!actor) return undefined;
    return { name: actor.name ?? actor.userId ?? 'Unknown', kind: actor.type ?? 'user' };
  }

  function projectCounts(project: TrackerProject): TrackerProject {
    const rows = [...tickets.values()].filter((ticket) => ticket.project?.id === project.id);
    return { ...copy(project), ticketCount: rows.length, doneCount: rows.filter((ticket) => ['completed', 'canceled'].includes(ticket.state.category)).length };
  }

  function milestoneCounts(milestone: TrackerMilestone): TrackerMilestone {
    const rows = [...tickets.values()].filter((ticket) => ticket.milestone?.id === milestone.id);
    return { ...copy(milestone), ticketCount: rows.length, doneCount: rows.filter((ticket) => ['completed', 'canceled'].includes(ticket.state.category)).length };
  }

  for (const ticket of seed.tickets ?? []) {
    tickets.set(ticket.key.toLocaleUpperCase(), copy(ticket));
    const match = ticket.key.match(/^[A-Z]{2,5}-(\d+)$/i);
    if (match) nextNumber = Math.max(nextNumber, Number(match[1]) + 1);
    seq = Math.max(seq, ticket.updatedSeq);
  }
  for (const [key, rows] of Object.entries(seed.comments ?? {})) comments.set(key.toLocaleUpperCase(), copy(rows));
  for (const event of seed.events ?? []) events.set(event.id, copy(event));
  for (const event of seed.events ?? []) seq = Math.max(seq, event.id);
  for (const ticket of seed.tickets ?? []) seq = Math.max(seq, ticket.updatedSeq);

  function addEvent(ticket: TrackerTicket, eventType: string, fields: Partial<TrackerEvent> = {}): TrackerEvent {
    seq += 1;
    const event: TrackerEvent = { id: seq, ticketKey: ticket.key, eventType, at: now(), actor: actor(), ...copy(fields) };
    events.set(event.id, event);
    ticket.updatedAt = event.at;
    ticket.updatedSeq = seq;
    return event;
  }

  function createTicketFromCard(card: TrackerMockKanban['cards'][number], state: TrackerState, project: TrackerProject | null = null, extraLabels: TrackerTicket['labels'] = []): TrackerTicket {
    const title = card.title.trim();
    const owner = card.ownerId ? meta.members.find((member) => member.userId === card.ownerId)
      : card.ownerName ? meta.members.find((member) => member.name.toLocaleLowerCase() === card.ownerName!.toLocaleLowerCase()) : undefined;
    const assignee = owner ? { userId: owner.userId, name: owner.name } : null;
    const ticket: TrackerTicket = {
      id: newId('ticket'), key: `${meta.prefix}-${nextNumber++}`, trackerId: meta.trackerId,
      title, description: card.description ?? '', state: stateValue(state), priority: 'none', assignee,
      creator: { type: 'user', id: meta.me.userId, name: actor().name },
      labels: [...new Map([...labelValues(card.labels), ...copy(extraLabels)].map((label) => [label.id, label])).values()],
      project: project ? { id: project.id, name: project.name } : null, milestone: null, estimate: null, due: card.due ?? null, parent: null,
      relations: [], links: [], aliases: [], archivedAt: null, createdAt: now(), updatedAt: now(), updatedSeq: 0,
    };
    tickets.set(ticket.key.toLocaleUpperCase(), ticket);
    addEvent(ticket, 'ticket.created');
    subscriptions.add(ticket.key.toLocaleUpperCase());
    return ticket;
  }

  function labelValues(values: string[] | undefined): TrackerTicket['labels'] {
    if (values === undefined) return [];
    return values.map((value) => {
      const label = meta.labels.find((item) => item.id === value || item.name.toLocaleLowerCase() === value.toLocaleLowerCase());
      if (!label) throw new TrackerError('invalid_input', `Unknown label: ${value}`, { path: 'labels' });
      return copy(label);
    });
  }

  function assigneeValue(value: string | null | undefined): TrackerTicket['assignee'] {
    if (value === undefined) return null;
    if (value === null || value === '') return null;
    const needle = value.toLocaleLowerCase();
    const member = meta.members.find((item) => item.userId === value || item.name.toLocaleLowerCase() === needle)
      ?? (needle === 'me' ? meta.members.find((item) => item.userId === meta.me.userId) : undefined);
    if (!member) throw new TrackerError('invalid_input', `Unknown member: ${value}`, { path: 'assignee' });
    return { userId: member.userId, name: member.name };
  }

  function applyPatch(ticket: TrackerTicket, patch: TrackerPatch | TrackerBulkPatch): TrackerTicket {
    if (ticket.archivedAt !== null && patch.archived !== false) throw new TrackerError('read_only', 'Restore an archived ticket before editing it.');
    if (patch.title !== undefined) {
      if (!patch.title.trim() || patch.title.includes('\n') || Array.from(patch.title).length > 200) throw new TrackerError('invalid_input', 'Title must be one line with 1 to 200 code points.', { path: 'title' });
      Object.assign(ticket, { title: patch.title.trim() });
    }
    if (patch.description !== undefined) ticket.description = patch.description;
    if (patch.state !== undefined) ticket.state = stateValue(resolveState(patch.state));
    if (patch.priority !== undefined) {
      if (!['none', 'urgent', 'high', 'medium', 'low'].includes(patch.priority)) throw new TrackerError('invalid_input', 'Unknown priority.', { path: 'priority' });
      ticket.priority = patch.priority as TrackerPriority;
    }
    if (patch.assignee !== undefined) ticket.assignee = assigneeValue(patch.assignee);
    if (patch.labels !== undefined) ticket.labels = labelValues(patch.labels);
    if (patch.due !== undefined) {
      if (patch.due !== null && !isValidDate(patch.due)) throw new TrackerError('invalid_input', 'Due must be a valid YYYY-MM-DD date.', { path: 'due' });
      ticket.due = patch.due;
    }
    if (patch.parent !== undefined) {
      if (patch.parent !== null) resolveTicket(patch.parent);
      ticket.parent = patch.parent;
    }
    if (patch.project !== undefined) {
      const project = patch.project === null ? null : meta.projects?.find((item) => item.id === patch.project || item.name.toLocaleLowerCase() === patch.project?.toLocaleLowerCase());
      if (patch.project !== null && !project) throw new TrackerError('invalid_input', `Unknown project: ${patch.project}`, { path: 'project' });
      ticket.project = project ? { id: project.id, name: project.name } : null;
    }
    if (patch.milestone !== undefined) {
      const milestone = patch.milestone === null ? null : meta.milestones?.find((item) => item.id === patch.milestone || item.name.toLocaleLowerCase() === patch.milestone?.toLocaleLowerCase());
      if (patch.milestone !== null && !milestone) throw new TrackerError('invalid_input', `Unknown milestone: ${patch.milestone}`, { path: 'milestone' });
      ticket.milestone = milestone ? { id: milestone.id, name: milestone.name, due: milestone.due } : null;
    }
    if (patch.archived !== undefined) ticket.archivedAt = patch.archived ? (ticket.archivedAt ?? now()) : null;
    return ticket;
  }

  function patchValueBefore(ticket: TrackerTicket, patch: TrackerBulkPatch): TrackerBulkPatch {
    const before: TrackerBulkPatch = {};
    if ('title' in patch) Object.assign(before, { title: ticket.title });
    if ('description' in patch) before.description = ticket.description;
    if ('state' in patch) before.state = ticket.state.key;
    if ('priority' in patch) before.priority = ticket.priority;
    if ('assignee' in patch) before.assignee = ticket.assignee?.userId ?? null;
    if ('labels' in patch) before.labels = ticket.labels.map((label) => label.id);
    if ('due' in patch) before.due = ticket.due;
    if ('parent' in patch) before.parent = ticket.parent;
    if ('project' in patch) before.project = ticket.project?.id ?? null;
    if ('milestone' in patch) before.milestone = ticket.milestone?.id ?? null;
    if ('archived' in patch) before.archived = ticket.archivedAt !== null;
    return before;
  }

  function searchSnippet(ticket: TrackerTicket, query: string): string | null {
    const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const haystacks = [ticket.title, ticket.description];
    const commentRows = comments.get(ticket.key.toLocaleUpperCase()) ?? [];
    haystacks.push(...commentRows.filter((row) => !row.deleted).map((row) => row.body));
    const source = haystacks.find((text) => words.every((word) => text.toLocaleLowerCase().includes(word)));
    if (source === undefined) return null;
    let snippet = escapeSnippet(source.length > 300 ? source.slice(0, 300) : source);
    for (const word of words.sort((a, b) => b.length - a.length)) {
      const safeWord = escapeSnippet(word);
      const regex = new RegExp(safeWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
      snippet = snippet.replace(regex, (match) => `<mark>${match}</mark>`);
    }
    return snippet;
  }

  function filterMatches(ticket: TrackerTicket, filters: string[], today: string): boolean {
    const archivedOnly = filters.includes('is:archived');
    if (archivedOnly ? ticket.archivedAt === null : ticket.archivedAt !== null) return false;
    for (const token of filters) {
      const divider = token.indexOf(':');
      if (divider < 1) throw new TrackerError('invalid_filter', 'Filter tokens must use name:value.', { path: token });
      const name = token.slice(0, divider).toLowerCase();
      const value = token.slice(divider + 1);
      if (!value) throw new TrackerError('invalid_filter', 'Filter value is required.', { path: token });
      if (name === 'is' && value === 'archived') continue;
      if (name === 'assignee') {
        const wanted = value.toLocaleLowerCase();
        if (wanted === 'me') { if (ticket.assignee?.userId !== meta.me.userId) return false; }
        else if (!ticket.assignee || (ticket.assignee.userId.toLocaleLowerCase() !== wanted && ticket.assignee.name.toLocaleLowerCase() !== wanted)) return false;
      } else if (name === 'state') {
        if (![ticket.state.id, ticket.state.key, ticket.state.name, ticket.state.category].some((part) => part.toLocaleLowerCase() === value.toLocaleLowerCase())) return false;
      } else if (name === 'label') {
        if (!ticket.labels.some((label) => label.id.toLocaleLowerCase() === value.toLocaleLowerCase() || label.name.toLocaleLowerCase() === value.toLocaleLowerCase())) return false;
      } else if (name === 'due' && value === 'overdue') {
        if (!ticket.due || ticket.due >= today) return false;
      } else if (name === 'due' && value === 'today') {
        if (ticket.due !== today) return false;
      } else if (name === 'due' && value === 'no-date') {
        if (ticket.due !== null) return false;
      } else if (name === 'due' && value.startsWith('before-')) {
        const date = value.slice(7);
        if (!isValidDate(date)) throw new TrackerError('invalid_filter', 'Expected a valid date.', { path: token });
        if (!ticket.due || ticket.due >= date) return false;
      } else throw new TrackerError('invalid_filter', `Unsupported filter ${token}.`, { path: token });
    }
    return true;
  }

  function compareTicket(a: TrackerTicket, b: TrackerTicket, sort: NonNullable<TrackerListQuery['sort']>): number {
    const direction = sort.direction === 'desc' ? -1 : 1;
    let result = 0;
    switch (sort.field) {
      case 'key': result = compare(a.key, b.key); break;
      case 'title': result = compare(a.title, b.title); break;
      case 'state': result = compare(a.state.name, b.state.name); break;
      case 'priority': result = ['none', 'urgent', 'high', 'medium', 'low'].indexOf(a.priority) - ['none', 'urgent', 'high', 'medium', 'low'].indexOf(b.priority); break;
      case 'assignee': result = compare(a.assignee?.name ?? '', b.assignee?.name ?? ''); break;
      case 'due': result = compare(a.due ?? '9999-99-99', b.due ?? '9999-99-99'); break;
      case 'createdAt': result = a.createdAt - b.createdAt; break;
      case 'updatedAt': result = a.updatedAt - b.updatedAt; break;
    }
    return result === 0 ? compare(a.key, b.key) : result * direction;
  }

  function ticketList(query: TrackerListQuery = {}): TrackerTicket[] {
    const rawFilters = typeof query.filter === 'string' ? [query.filter] : query.filter ?? [];
    const today = new Date(now()).toISOString().slice(0, 10);
    let result = [...tickets.values()].filter((ticket) => filterMatches(ticket, rawFilters, today));
    const search = query.q?.trim();
    if (search) {
      result = result.flatMap((ticket) => {
        const snippet = searchSnippet(ticket, search);
        return snippet === null ? [] : [{ ...ticket, snippet }];
      });
    }
    return result.sort((a, b) => compareTicket(a, b, query.sort ?? { field: 'updatedAt', direction: 'desc' }));
  }

  function makeFacets(rows: TrackerTicket[]) {
    const stateCounts = new Map<string, { id: string; name: string; count: number }>();
    const labelCounts = new Map<string, { id: string; name: string; color: string | null; count: number }>();
    const assigneeCounts = new Map<string, { userId: string; name: string; count: number }>();
    for (const ticket of rows) {
      const state = stateCounts.get(ticket.state.id) ?? { id: ticket.state.id, name: ticket.state.name, count: 0 };
      state.count += 1; stateCounts.set(state.id, state);
      for (const label of ticket.labels) {
        const item = labelCounts.get(label.id) ?? { ...label, count: 0 };
        item.count += 1; labelCounts.set(item.id, item);
      }
      if (ticket.assignee) {
        const item = assigneeCounts.get(ticket.assignee.userId) ?? { ...ticket.assignee, count: 0 };
        item.count += 1; assigneeCounts.set(item.userId, item);
      }
    }
    return {
      states: [...stateCounts.values()], labels: [...labelCounts.values()], assignees: [...assigneeCounts.values()],
    };
  }

  function getTicketDetail(reference: string): TrackerTicketDetail {
    const ticket = resolveTicket(reference);
    const commentsForTicket = comments.get(ticket.key.toLocaleUpperCase()) ?? [];
    const ticketEvents = [...events.values()].filter((event) => event.ticketKey === ticket.key).sort((a, b) => a.id - b.id);
    return {
      ticket: copy(ticket), comments: copy(commentsForTicket.slice(-50)), events: copy(ticketEvents.slice(-50)),
      subscribed: subscriptions.has(ticket.key.toLocaleUpperCase()),
      ...(reference.trim().toLocaleUpperCase() !== ticket.key.toLocaleUpperCase() ? { resolvedKey: ticket.key } : {}),
    };
  }

  function pageOffset(before: string | number | undefined): number {
    if (before === undefined) return 0;
    const offset = Number(before);
    return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  }

  return {
    async meta() { syncResourceMeta(); return copy(meta); },
    async createLabel(name: string) {
      ensureWritable();
      const cleanName = name.trim();
      if (!cleanName || Array.from(cleanName).length > 64) throw new TrackerError('invalid_input', 'Label name must be 1 to 64 characters.', { path: 'name' });
      if (meta.labels.some((label) => label.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase())) {
        throw new TrackerError('conflict', 'A label with this name already exists.', { path: 'name' });
      }
      const label = { id: newId('label'), name: cleanName, color: null };
      meta.labels.push(label);
      return { label: copy(label) };
    },
    async listProjects(options = {}) {
      const rows = [...projects.values()].filter((project) => options.includeArchived || project.archivedAt == null)
        .sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id)).map(projectCounts);
      return { projects: copy(rows) };
    },
    async createProject(input: TrackerProjectInput) {
      ensureWritable();
      const name = input.name.trim();
      if (!name || Array.from(name).length > 100) throw new TrackerError('invalid_input', 'Project name must be 1 to 100 characters.', { path: 'name' });
      if ([...projects.values()].some((project) => project.archivedAt == null && project.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        throw new TrackerError('conflict', 'An active project with this name already exists.', { path: 'name' });
      }
      const ownerRef = input.ownerId;
      const ownerMember = ownerRef === undefined || ownerRef === null || ownerRef === '' ? undefined
        : ownerRef.toLocaleLowerCase() === 'me' ? meta.members.find((member) => member.userId === meta.me.userId)
          : meta.members.find((member) => member.userId === ownerRef || member.name.toLocaleLowerCase() === ownerRef.toLocaleLowerCase());
      if (ownerRef && !ownerMember) throw new TrackerError('invalid_input', 'No active workspace member matches this owner.', { path: 'ownerId' });
      const state = input.state ?? 'planned';
      if (!['planned', 'started', 'paused', 'completed', 'canceled'].includes(state)) throw new TrackerError('invalid_input', 'Unknown project state.', { path: 'state' });
      const project: TrackerProject = {
        id: newId('project'), name, description: input.description ?? '', state,
        owner: ownerMember ? { userId: ownerMember.userId, name: ownerMember.name } : null,
        createdAt: now(), updatedAt: now(), archivedAt: null,
      };
      projects.set(project.id, project);
      syncResourceMeta();
      return { project: projectCounts(project) };
    },
    async updateProject(id: string, patch: TrackerProjectPatch) {
      ensureWritable();
      const current = projects.get(id);
      if (!current) throw new TrackerError('not_found', 'Project not found.', { status: 404 });
      const name = patch.name?.trim() ?? current.name;
      if (!name || Array.from(name).length > 100) throw new TrackerError('invalid_input', 'Project name must be 1 to 100 characters.', { path: 'name' });
      if ([...projects.values()].some((project) => project.id !== id && project.archivedAt == null && name.toLocaleLowerCase() === project.name.toLocaleLowerCase())) {
        throw new TrackerError('conflict', 'An active project with this name already exists.', { path: 'name' });
      }
      const ownerMember = patch.ownerId === undefined ? undefined
        : patch.ownerId === null || patch.ownerId === '' ? null
          : patch.ownerId.toLocaleLowerCase() === 'me' ? meta.members.find((member) => member.userId === meta.me.userId)
            : meta.members.find((member) => member.userId === patch.ownerId || member.name.toLocaleLowerCase() === patch.ownerId?.toLocaleLowerCase());
      if (patch.ownerId && !ownerMember) throw new TrackerError('invalid_input', 'No active workspace member matches this owner.', { path: 'ownerId' });
      if (patch.state !== undefined && !['planned', 'started', 'paused', 'completed', 'canceled'].includes(patch.state)) {
        throw new TrackerError('invalid_input', 'Unknown project state.', { path: 'state' });
      }
      const project: TrackerProject = {
        ...current, name,
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.state !== undefined ? { state: patch.state } : {}),
        ...(patch.ownerId !== undefined ? { owner: ownerMember ? { userId: ownerMember.userId, name: ownerMember.name } : null } : {}),
        ...(patch.archived !== undefined ? { archivedAt: patch.archived ? (current.archivedAt ?? now()) : null } : {}),
        updatedAt: now(),
      };
      projects.set(id, project);
      syncResourceMeta();
      return { project: projectCounts(project) };
    },
    async listMilestones(projectId: string) {
      if (!projects.has(projectId) || projects.get(projectId)?.archivedAt != null) throw new TrackerError('not_found', 'Project not found.', { status: 404 });
      const rows = [...milestones.values()].filter((milestone) => milestone.projectId === projectId && milestone.archivedAt == null)
        .sort((a, b) => compare(a.due ?? '', b.due ?? '') || compare(a.name, b.name)).map(milestoneCounts);
      return { milestones: copy(rows) };
    },
    async createMilestone(projectId: string, input: TrackerMilestoneInput) {
      ensureWritable();
      const project = projects.get(projectId);
      if (!project || project.archivedAt != null) throw new TrackerError('not_found', 'Project not found.', { status: 404 });
      const name = input.name.trim();
      if (!name || Array.from(name).length > 100) throw new TrackerError('invalid_input', 'Milestone name must be 1 to 100 characters.', { path: 'name' });
      if (!isValidDate(input.due)) throw new TrackerError('invalid_input', 'Due must be a valid YYYY-MM-DD date.', { path: 'due' });
      const state = input.state ?? 'planned';
      if (!['planned', 'started', 'completed'].includes(state)) throw new TrackerError('invalid_input', 'Unknown milestone state.', { path: 'state' });
      const milestone: TrackerMilestone = {
        id: newId('milestone'), projectId, projectName: project.name, name,
        description: input.description ?? '', due: input.due, state,
        createdAt: now(), updatedAt: now(), archivedAt: null,
      };
      milestones.set(milestone.id, milestone);
      syncResourceMeta();
      return { milestone: milestoneCounts(milestone) };
    },
    async updateMilestone(id: string, patch: TrackerMilestonePatch) {
      ensureWritable();
      const current = milestones.get(id);
      if (!current) throw new TrackerError('not_found', 'Milestone not found.', { status: 404 });
      const name = patch.name?.trim() ?? current.name;
      if (!name || Array.from(name).length > 100) throw new TrackerError('invalid_input', 'Milestone name must be 1 to 100 characters.', { path: 'name' });
      if (patch.due !== undefined && patch.due !== null && !isValidDate(patch.due)) throw new TrackerError('invalid_input', 'Due must be a valid YYYY-MM-DD date.', { path: 'due' });
      if (patch.state !== undefined && !['planned', 'started', 'completed'].includes(patch.state)) throw new TrackerError('invalid_input', 'Unknown milestone state.', { path: 'state' });
      const milestone: TrackerMilestone = {
        ...current, name,
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.due !== undefined ? { due: patch.due } : {}),
        ...(patch.state !== undefined ? { state: patch.state } : {}),
        ...(patch.archived !== undefined ? { archivedAt: patch.archived ? (current.archivedAt ?? now()) : null } : {}),
        updatedAt: now(),
      };
      milestones.set(id, milestone);
      syncResourceMeta();
      return { milestone: milestoneCounts(milestone) };
    },
    async listViews() {
      return { views: copy([...views.values()].filter((view) => view.mine || view.shared).sort((a, b) => compare(a.name, b.name))) };
    },
    async runView(id: string, query = {}) {
      const view = views.get(id);
      if (!view || (!view.mine && !view.shared)) throw new TrackerError('not_found', 'Saved view not found.', { status: 404 });
      const all = ticketList({ filter: view.filter, sort: { field: 'updatedAt', direction: 'desc' } });
      const limit = Math.max(1, Math.min(50, Math.trunc(query.limit ?? 20)));
      const offset = pageOffset(query.cursor);
      const ticketRows = all.slice(offset, offset + limit).map(copy);
      return { tickets: ticketRows, nextCursor: offset + limit < all.length ? String(offset + limit) : null, view: copy(view) };
    },
    async createView(input: TrackerSavedViewInput) {
      ensureWritable();
      const name = input.name.trim();
      if (!name || Array.from(name).length > 80) throw new TrackerError('invalid_input', 'View name must be 1 to 80 characters.', { path: 'name' });
      if (!Array.isArray(input.filter) || input.filter.some((token) => typeof token !== 'string')) throw new TrackerError('invalid_input', 'Filter must be a list of tokens.', { path: 'filter' });
      ticketList({ filter: input.filter });
      const view: TrackerSavedView = {
        id: newId('view'), ownerUserId: meta.me.userId, owner: { userId: meta.me.userId, name: actor().name },
        ownerName: actor().name, name, filter: copy(input.filter), sort: 'updated_desc', shared: input.shared ?? false,
        mine: true, createdAt: now(), updatedAt: now(),
      };
      views.set(view.id, view); syncResourceMeta();
      return { view: copy(view) };
    },
    async updateView(id: string, patch: TrackerSavedViewPatch) {
      ensureWritable();
      const current = views.get(id);
      if (!current || !current.mine) throw new TrackerError(current ? 'forbidden' : 'not_found', current ? 'Only the owner can update a saved view.' : 'Saved view not found.', { status: current ? 403 : 404 });
      const name = patch.name?.trim() ?? current.name;
      if (!name || Array.from(name).length > 80) throw new TrackerError('invalid_input', 'View name must be 1 to 80 characters.', { path: 'name' });
      if (patch.filter) ticketList({ filter: patch.filter });
      const view = {
        ...current, name,
        ...(patch.filter !== undefined ? { filter: copy(patch.filter) } : {}),
        ...(patch.shared !== undefined ? { shared: patch.shared } : {}),
        updatedAt: now(),
      };
      views.set(id, view); syncResourceMeta();
      return { view: copy(view) };
    },
    async deleteView(id: string) {
      ensureWritable();
      const current = views.get(id);
      if (!current || !current.mine) throw new TrackerError(current ? 'forbidden' : 'not_found', current ? 'Only the owner can delete a saved view.' : 'Saved view not found.', { status: current ? 403 : 404 });
      views.delete(id); syncResourceMeta();
    },
    async listTickets(query = {}) {
      const all = ticketList(query);
      const limit = Math.max(1, Math.min(100, Math.trunc(query.limit ?? 50)));
      const offset = pageOffset(query.cursor);
      const page = all.slice(offset, offset + limit).map(copy);
      const facets = query.includeFacets ? makeFacets(all) : undefined;
      return { tickets: page, nextCursor: offset + limit < all.length ? String(offset + limit) : null, ...(facets ? { facets } : {}) };
    },
    async listLinks(boardId, options) {
      assertBoardAllowed(boardId);
      return { links: copy([...links.values()].filter(({ link }) => link.boardId === boardId && (!options?.kanbanId || link.kanbanId === options.kanbanId)).map(({ link }) => link)) };
    },
    async suggestLinkMapping(boardId, kanbanId) {
      const kanban = findKanban(boardId, kanbanId);
      const categoryForStage = { todo: 'unstarted', doing: 'started', done: 'completed' } as const;
      const normalName = (value: string) => value.toLocaleLowerCase();
      const used = new Set<string>();
      const map: TrackerLinkSuggestion['map'] = {};
      const unmappedLanes: string[] = [];
      for (const lane of kanban.lanes) {
        const category = lane.stage ? categoryForStage[lane.stage] : undefined;
        const state = meta.states.find((candidate) => !used.has(candidate.key)
          && (normalName(candidate.name) === normalName(lane.name) || normalName(candidate.key) === normalName(lane.name)))
          ?? (category ? meta.states.find((candidate) => !used.has(candidate.key) && candidate.category === category) : undefined);
        if (state) {
          map[lane.id] = state.key;
          used.add(state.key);
        } else {
          unmappedLanes.push(lane.id);
        }
      }
      return {
        map,
        unmappedLanes,
        existingCardCount: kanban.cards.length,
        nextKey: `${meta.prefix}-${nextNumber}`,
        stateNotMapped: meta.states.filter((state) => !used.has(state.key)).map((state) => state.key),
      };
    },
    async linkKanban(input: TrackerLinkKanbanInput): Promise<TrackerLinkKanbanResult> {
      ensureWritable();
      if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 64) {
        throw new TrackerError('invalid_input', 'Idempotency key must be 8 to 64 characters.', { path: 'idempotencyKey', status: 400 });
      }
      const replay = idempotentLinkCreates.get(input.idempotencyKey);
      if (replay) return copy(replay);
      const kanban = findKanban(input.boardId, input.kanbanId);
      if ([...links.values()].some(({ link }) => link.boardId === input.boardId && link.kanbanId === input.kanbanId)) {
        throw new TrackerError('conflict', 'This kanban is already linked to a tracker.', { path: 'kanbanId', status: 409 });
      }
      const stateByLane = new Map<string, TrackerState>();
      const usedStates = new Set<string>();
      const laneIds = new Set(kanban.lanes.map((lane) => lane.id));
      for (const [laneId, stateKey] of Object.entries(input.mapping)) {
        if (!laneIds.has(laneId)) throw new TrackerError('invalid_input', 'The lane no longer exists.', { path: `mapping.${laneId}`, status: 400 });
        if (typeof stateKey !== 'string') throw new TrackerError('invalid_input', 'Choose a tracker state for this lane.', { path: `mapping.${laneId}`, status: 400 });
        const state = meta.states.find((candidate) => candidate.key.toLocaleLowerCase() === stateKey.toLocaleLowerCase());
        if (!state) throw new TrackerError('invalid_input', `Unknown tracker state: ${stateKey}.`, { path: `mapping.${laneId}`, status: 400 });
        if (usedStates.has(state.key)) throw new TrackerError('invalid_input', 'A tracker state can be used by only one lane.', { path: `mapping.${laneId}`, status: 400 });
        stateByLane.set(laneId, state);
        usedStates.add(state.key);
      }
      const project = input.project == null ? null : (meta.projects ?? []).find((item) => item.name.toLocaleLowerCase() === input.project?.toLocaleLowerCase()) ?? null;
      if (input.project != null && !project) throw new TrackerError('invalid_input', `Unknown project: ${input.project}`, { path: 'project', status: 400 });
      const extraLabels = labelValues(input.labels);
      if (input.createTickets) {
        const cardsToCreate = kanban.cards.filter((card) => !card.linkedTicketKey && stateByLane.has(card.laneId) && card.title.trim());
        if (cardsToCreate.length > 500) throw new TrackerError('limit_exceeded', 'Create at most 500 tickets at once.', { path: 'createTickets', status: 413 });
        for (const card of cardsToCreate) {
          const title = card.title.trim();
          if (Array.from(title).length > 200) throw new TrackerError('invalid_input', 'Title must be one line with 1 to 200 code points.', { path: card.id });
          if (card.due !== undefined && !isValidDate(card.due)) throw new TrackerError('invalid_input', 'Due must be a valid YYYY-MM-DD date.', { path: card.id });
          labelValues(card.labels);
        }
      }
      const linkId = newId('kanban-link');
      const created: TrackerLinkKanbanResult['created'] = [];
      const skipped: TrackerLinkKanbanResult['skipped'] = [];
      const linkedCardIds: string[] = [];
      if (input.createTickets) {
        for (const card of kanban.cards) {
          const state = stateByLane.get(card.laneId);
          if (card.linkedTicketKey) {
            skipped.push({ cardId: card.id, reason: 'already_linked' });
          } else if (!state) {
            skipped.push({ cardId: card.id, reason: 'unmapped_lane' });
          } else if (!card.title.trim()) {
            skipped.push({ cardId: card.id, reason: 'empty_title' });
          } else {
            const ticket = createTicketFromCard(card, state, project, extraLabels);
            ticket.links.push({ id: newId('card-link'), kind: 'card', boardId: input.boardId, kanbanId: input.kanbanId, cardId: card.id, linkId, at: new Date(now()).toISOString() });
            card.linkedTicketKey = ticket.key;
            created.push({ cardId: card.id, key: ticket.key });
            linkedCardIds.push(card.id);
          }
        }
      }
      const mapping = [...stateByLane].map(([laneId, state]) => ({ laneId, stateKey: state.key, stateId: state.id }));
      const cardCount = created.length;
      const link: TrackerKanbanLink = {
        id: linkId, boardId: input.boardId, kanbanId: input.kanbanId, workflowId: 'workflow-default', mapping,
        map: Object.fromEntries(mapping.map(({ laneId, stateKey }) => [laneId, stateKey])),
        cardCount, createdAt: now(), createdBy: meta.me.userId, ticketCount: cardCount,
      };
      links.set(link.id, { link, cardIds: linkedCardIds });
      const result: TrackerLinkKanbanResult = { link: copy(link), created: copy(created), skipped: copy(skipped), projectionPending: false };
      idempotentLinkCreates.set(input.idempotencyKey, copy(result));
      return result;
    },
    async unlinkKanban(id) {
      ensureWritable();
      const record = links.get(id);
      if (!record) throw new TrackerError('not_found', 'This kanban link no longer exists.', { status: 404 });
      assertBoardAllowed(record.link.boardId);
      links.delete(id);
      const kanban = kanbans.get(boardKanbanKey(record.link.boardId, record.link.kanbanId));
      for (const card of kanban?.cards ?? []) if (record.cardIds.includes(card.id)) delete card.linkedTicketKey;
      for (const ticket of tickets.values()) {
        ticket.links = ticket.links.filter((item) => item.kind !== 'card' || item.linkId !== id);
      }
      return { link: { ...copy(record.link), removedAt: now() }, unlinked: record.cardIds.length, projectionPending: false };
    },
    async createTicketForCard(linkId, cardId) {
      ensureWritable();
      const record = links.get(linkId);
      if (!record) throw new TrackerError('not_found', 'This kanban link no longer exists.', { status: 404 });
      assertBoardAllowed(record.link.boardId);
      const kanban = findKanban(record.link.boardId, record.link.kanbanId);
      const card = kanban.cards.find((item) => item.id === cardId);
      if (!card) throw new TrackerError('invalid_input', 'The card is not on this kanban.', { path: 'cardId', status: 400 });
      if (card.linkedTicketKey || record.cardIds.includes(cardId)) throw new TrackerError('conflict', 'This card is already linked to a ticket.', { status: 409 });
      const stateKey = record.link.map[card.laneId];
      const state = stateKey ? meta.states.find((item) => item.key === stateKey) : undefined;
      if (!state) throw new TrackerError('invalid_input', 'The card lane is not mapped to a tracker state.', { path: 'cardId', status: 400 });
      if (!card.title.trim()) throw new TrackerError('invalid_input', 'A ticket title is required for this card.', { path: 'cardId', status: 400 });
      if (Array.from(card.title.trim()).length > 200) throw new TrackerError('invalid_input', 'Title must be one line with 1 to 200 code points.', { path: 'cardId', status: 400 });
      if (card.due !== undefined && !isValidDate(card.due)) throw new TrackerError('invalid_input', 'Due must be a valid YYYY-MM-DD date.', { path: 'cardId', status: 400 });
      const ticket = createTicketFromCard(card, state);
      ticket.links.push({ id: newId('card-link'), kind: 'card', boardId: record.link.boardId, kanbanId: record.link.kanbanId, cardId, linkId, at: new Date(now()).toISOString() });
      card.linkedTicketKey = ticket.key;
      record.cardIds.push(cardId);
      record.link.cardCount += 1;
      record.link.ticketCount = record.link.cardCount;
      return { ticket: copy(ticket), cardId, projectionPending: false };
    },
    async ticketsUpdatedSince(since) {
      return { tickets: [...tickets.values()].filter((ticket) => ticket.updatedSeq > since).map(copy), seq };
    },
    async createTicket(input: TrackerCreateInput) {
      ensureWritable();
      const priorKey = idempotentCreates.get(input.idempotencyKey);
      if (priorKey) return { ticket: copy(resolveTicket(priorKey)) };
      if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 64) {
        throw new TrackerError('invalid_input', 'Idempotency key must be 8 to 64 characters.', { path: 'idempotencyKey' });
      }
      if (typeof input.title !== 'string' || !input.title.trim() || input.title.includes('\n') || Array.from(input.title.trim()).length > 200) {
        throw new TrackerError('invalid_input', 'Title must be one line with 1 to 200 code points.', { path: 'title' });
      }
      const state = input.state ? resolveState(input.state) : meta.states.find((item) => item.key === 'todo') ?? meta.states[0];
      if (!state) throw new TrackerError('internal', 'No states are configured.');
      const due = input.due ?? null;
      if (due !== null && !isValidDate(due)) throw new TrackerError('invalid_input', 'Due must be a valid YYYY-MM-DD date.', { path: 'due' });
      const ticket: TrackerTicket = {
        id: newId('ticket'), key: `${meta.prefix}-${nextNumber++}`, trackerId: meta.trackerId,
        title: input.title.trim(), description: input.description ?? '', state: stateValue(state),
        priority: input.priority ?? 'none', assignee: assigneeValue(input.assignee),
        creator: { type: 'user', id: meta.me.userId, name: actor().name }, labels: labelValues(input.labels),
        project: null, milestone: null, estimate: null, due, parent: input.parent ?? null,
        relations: [], links: [], aliases: [], archivedAt: null, createdAt: now(), updatedAt: now(), updatedSeq: 0,
      };
      if (ticket.parent) resolveTicket(ticket.parent);
      tickets.set(ticket.key.toLocaleUpperCase(), ticket);
      addEvent(ticket, 'ticket.created');
      idempotentCreates.set(input.idempotencyKey, ticket.key);
      subscriptions.add(ticket.key.toLocaleUpperCase());
      return { ticket: copy(ticket) };
    },
    async getTicket(key) { return getTicketDetail(key); },
    async ticketComments(key, page = {}) {
      const ticket = resolveTicket(key);
      const rows = comments.get(ticket.key.toLocaleUpperCase()) ?? [];
      const limit = Math.max(1, Math.min(100, Math.trunc(page.limit ?? 50)));
      const found = page.before === undefined ? rows.length : rows.findIndex((comment) => comment.id === String(page.before));
      const end = Math.max(0, found < 0 ? rows.length : found);
      const start = Math.max(0, end - limit);
      const selected = rows.slice(start, end);
      return { comments: copy(selected), nextCursor: start > 0 ? rows[start].id : null };
    },
    async ticketEvents(key, page = {}) {
      const ticket = resolveTicket(key);
      const rows = [...events.values()].filter((event) => event.ticketKey === ticket.key).sort((a, b) => a.id - b.id);
      const limit = Math.max(1, Math.min(100, Math.trunc(page.limit ?? 50)));
      const found = page.before === undefined ? rows.length : rows.findIndex((event) => event.id === Number(page.before));
      const end = Math.max(0, found < 0 ? rows.length : found);
      const start = Math.max(0, end - limit);
      const selected = rows.slice(start, end);
      return { events: copy(selected), nextCursor: start > 0 ? String(rows[start].id) : null };
    },
    async patchTicket(key, patch) {
      ensureWritable();
      const ticket = resolveTicket(key);
      if (patch.ifUpdatedSeq !== undefined && patch.ifUpdatedSeq !== ticket.updatedSeq) {
        throw new TrackerError('conflict', 'The ticket changed since it was loaded.', {
          current: copy(ticket), by: latestActor(ticket), status: 409,
        });
      }
      const before = copy(ticket);
      applyPatch(ticket, patch);
      addEvent(ticket, patch.archived === true && before.archivedAt === null ? 'ticket.archived' : patch.archived === false && before.archivedAt !== null ? 'ticket.restored' : 'ticket.updated', { from: before, to: copy(ticket) });
      return { ticket: copy(ticket) };
    },
    async transitionTicket(key, stateName) {
      ensureWritable();
      const ticket = resolveTicket(key);
      if (ticket.archivedAt !== null) throw new TrackerError('read_only', 'Restore an archived ticket before editing it.');
      const target = resolveState(stateName);
      const before = copy(ticket.state);
      ticket.state = stateValue(target);
      addEvent(ticket, 'ticket.state_changed', { from: before, to: copy(ticket.state) });
      return { ticket: copy(ticket) };
    },
    async addComment(key, input) {
      ensureWritable();
      const ticket = resolveTicket(key);
      if (ticket.archivedAt !== null) throw new TrackerError('read_only', 'Restore an archived ticket before commenting.');
      const existingId = idempotentComments.get(input.clientId);
      if (existingId) {
        const existing = [...comments.values()].flat().find((comment) => comment.id === existingId);
        if (existing) return { comment: copy(existing), ticket: copy(ticket) };
      }
      if (typeof input.body !== 'string' || !input.body.trim()) throw new TrackerError('invalid_input', 'Comment body is required.', { path: 'body' });
      const comment: TrackerComment = {
        id: newId('comment'), ticketKey: ticket.key, author: { userId: meta.me.userId, name: actor().name },
        body: input.body, clientId: input.clientId, createdAt: now(), editedAt: null,
      };
      const rows = comments.get(ticket.key.toLocaleUpperCase()) ?? [];
      rows.push(comment); comments.set(ticket.key.toLocaleUpperCase(), rows);
      idempotentComments.set(input.clientId, comment.id);
      addEvent(ticket, 'ticket.commented', { commentId: comment.id });
      subscriptions.add(ticket.key.toLocaleUpperCase());
      return { comment: copy(comment), ticket: copy(ticket) };
    },
    async editComment(id, body) {
      ensureWritable();
      const comment = [...comments.values()].flat().find((row) => row.id === id);
      if (!comment) throw new TrackerError('not_found', `No comment found for ${id}.`, { status: 404 });
      if (comment.author.userId !== meta.me.userId) throw new TrackerError('forbidden', 'Only the author may edit this comment.');
      if (!body.trim()) throw new TrackerError('invalid_input', 'Comment body is required.', { path: 'body' });
      comment.body = body; comment.editedAt = now();
      const ticket = resolveTicket(comment.ticketKey); addEvent(ticket, 'ticket.comment_edited', { commentId: comment.id });
      return { comment: copy(comment) };
    },
    async deleteComment(id) {
      ensureWritable();
      const comment = [...comments.values()].flat().find((row) => row.id === id);
      if (!comment) throw new TrackerError('not_found', `No comment found for ${id}.`, { status: 404 });
      if (comment.author.userId !== meta.me.userId) throw new TrackerError('forbidden', 'Only the author may delete this comment.');
      comment.body = ''; comment.deleted = true; comment.deletedAt = now();
      const ticket = resolveTicket(comment.ticketKey); addEvent(ticket, 'ticket.comment_deleted', { commentId: comment.id });
      return { deleted: true };
    },
    async setSubscription(key, subscribed) {
      ensureWritable();
      const ticket = resolveTicket(key);
      if (subscribed) subscriptions.add(ticket.key.toLocaleUpperCase()); else subscriptions.delete(ticket.key.toLocaleUpperCase());
      return { subscribed };
    },
    async feed(since): Promise<TrackerFeed> {
      const feedEvents: TrackerFeedEvent[] = [...events.values()].filter((event) => event.id > since).sort((a, b) => a.id - b.id)
        .map((event) => ({ id: event.id, ticketKey: event.ticketKey, eventType: event.eventType, at: event.at, actor: copy(event.actor) }));
      return { events: feedEvents, seq };
    },
    async bulkTickets(input: TrackerBulkInput): Promise<TrackerBulkResult> {
      ensureWritable();
      const before: TrackerBulkResult['before'] = {};
      const results: TrackerBulkResult['results'] = [];
      for (const key of input.keys) {
        try {
          const ticket = resolveTicket(key);
          before[ticket.key] = { patch: patchValueBefore(ticket, input.patch), updatedSeq: ticket.updatedSeq };
          applyPatch(ticket, input.patch);
          addEvent(ticket, 'ticket.updated', { to: copy(input.patch) });
          results.push({ key: ticket.key, ok: true, ticket: copy(ticket), before: copy(before[ticket.key].patch) });
        } catch (error) {
          results.push({ key, ok: false, error: error instanceof TrackerError ? error.code : 'internal' });
        }
      }
      return { results, batchId: `batch-${++batchSerial}`, before };
    },
    async archiveTicket(key) {
      ensureWritable();
      const ticket = resolveTicket(key);
      const before = copy(ticket);
      applyPatch(ticket, { archived: true });
      addEvent(ticket, 'ticket.archived', { from: before.archivedAt, to: ticket.archivedAt });
      return { ticket: copy(ticket) };
    },
    async restoreTicket(key) {
      ensureWritable();
      const ticket = resolveTicket(key);
      const before = copy(ticket);
      applyPatch(ticket, { archived: false });
      addEvent(ticket, 'ticket.restored', { from: before.archivedAt, to: ticket.archivedAt });
      return { ticket: copy(ticket) };
    },
    async addRelation(key, relation) {
      ensureWritable();
      const ticket = resolveTicket(key);
      resolveTicket(relation.key);
      if (!ticket.relations.some((item) => item.kind === relation.kind && item.key === relation.key)) ticket.relations.push(copy(relation));
      addEvent(ticket, 'ticket.related', { relation: copy(relation) });
      return { ticket: copy(ticket) };
    },
    async removeRelation(key, relation: { kind: TrackerRelationKind; key: string }) {
      ensureWritable();
      const ticket = resolveTicket(key);
      ticket.relations = ticket.relations.filter((item) => item.kind !== relation.kind || item.key !== relation.key);
      addEvent(ticket, 'ticket.unrelated', { relation: copy(relation) });
      return { ticket: copy(ticket) };
    },
    async inbox(query = {}) {
      const requestedLimit = query.limit ?? 30;
      const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(50, Math.floor(requestedLimit))) : 30;
      const cursor = query.before ? decodeInboxCursor(query.before) : null;
      const unread = inboxItems.reduce((count, item) => count + (item.readAt === null ? 1 : 0), 0);
      const items = inboxItems
        .filter((item) => !query.unread || item.readAt === null)
        .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
      const start = cursor
        ? items.findIndex((item) => item.createdAt < cursor.createdAt || (item.createdAt === cursor.createdAt && item.id.localeCompare(cursor.id) < 0))
        : 0;
      const offset = start < 0 ? items.length : start;
      const page = items.slice(offset, offset + limit);
      return {
        items: copy(page),
        nextCursor: offset + limit < items.length && page.length ? encodeInboxCursor(page[page.length - 1]) : null,
        unread,
      };
    },
    async inboxUnread() {
      return { unread: inboxItems.reduce((count, item) => count + (item.readAt === null ? 1 : 0), 0) };
    },
    async markInboxRead(input: TrackerInboxReadInput) {
      if ('all' in input && input.all) {
        const pending = inboxItems.filter((item) => item.readAt === null);
        const at = now();
        for (const item of pending) item.readAt = at;
        return { updated: pending.length, unread: inboxItems.filter((item) => item.readAt === null).length };
      }
      const requestedIds = 'ids' in input ? input.ids : [];
      if (requestedIds.length > 100) throw new TrackerError('invalid_input', 'ids must be an array of up to 100 notification ids');
      const ids = [...new Set(requestedIds)];
      const wanted = new Set(ids);
      const pending = inboxItems.filter((item) => wanted.has(item.id) && item.readAt === null);
      const at = now();
      for (const item of pending) item.readAt = at;
      return { updated: pending.length, unread: inboxItems.filter((item) => item.readAt === null).length };
    },
    async notificationPrefs() { return copy(preferences); },
    async updateNotificationPrefs(patch: TrackerNotificationPrefsUpdate) {
      preferences = { ...preferences, prefs: { ...preferences.prefs, ...copy(patch.prefs) } };
      return copy(preferences);
    },
  };
}
