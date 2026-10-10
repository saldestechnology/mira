/** Shared wire and store types for the tracker client. */

export type TrackerStateCategory = 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled';
export type TrackerPriority = 'none' | 'urgent' | 'high' | 'medium' | 'low';
export type TrackerView = 'inbox' | 'my' | 'all' | 'board' | 'projects';
export type TrackerRelationKind = 'blocks' | 'blocked_by' | 'relates_to' | 'duplicates' | 'duplicated_by';
export type TrackerErrorCode =
  | 'invalid_input' | 'invalid_filter' | 'not_found' | 'forbidden' | 'conflict' | 'read_only'
  | 'limit_exceeded' | 'rate_limited' | 'internal' | 'offline' | 'network'
  | 'invalid_mapping' | 'already_linked' | 'kanban_not_found' | 'board_forbidden';

export interface TrackerKanbanLink {
  id: string;
  boardId: string;
  kanbanId: string;
  trackerId: string;
  map: Record<string, string>;
  createdAt: number;
  ticketCount: number;
}

export interface TrackerLinkSuggestion {
  map: Record<string, string | null>;
  unmappedLanes: string[];
  existingCardCount: number;
}

export interface TrackerLinkKanbanInput {
  boardId: string;
  kanbanId: string;
  map: Record<string, string>;
  createTickets: boolean;
}

export interface TrackerLinkKanbanResult {
  link: TrackerKanbanLink;
  created: Array<{ cardId: string; key: string }>;
  skipped: Array<{ cardId: string; reason: string }>;
}

export interface TrackerState {
  id: string;
  key: string;
  name: string;
  category: TrackerStateCategory;
  position: number;
}

export interface TrackerLabel { id: string; name: string; color: string | null }
export interface TrackerMember { userId: string; name: string; initials?: string }

export interface TrackerMeta {
  enabled: boolean;
  trackerId: string;
  prefix: string;
  states: TrackerState[];
  labels: TrackerLabel[];
  members: TrackerMember[];
  me: { userId: string; canWrite: boolean; canDeleteAnyComment?: boolean };
  /** Slice 2 metadata is optional while older servers only expose core ticket fields. */
  projects?: TrackerProject[];
  milestones?: TrackerMilestone[];
  views?: TrackerSavedViewSummary[];
  canCreateLabels?: boolean;
}

export interface TrackerProject {
  id: string;
  name: string;
  description?: string;
  state?: string;
  owner?: { userId: string; name: string } | null;
  createdAt?: number;
  updatedAt?: number;
  archivedAt?: number | null;
  ticketCount?: number;
  doneCount?: number;
}

export interface TrackerMilestone {
  id: string;
  projectId: string;
  projectName?: string | null;
  name: string;
  description?: string;
  due: string | null;
  state?: string;
  createdAt?: number;
  updatedAt?: number;
  archivedAt?: number | null;
  ticketCount?: number;
  doneCount?: number;
}

export interface TrackerSavedViewSummary {
  id: string;
  name: string;
  shared: boolean;
  mine: boolean;
}

export interface TrackerSavedView extends TrackerSavedViewSummary {
  ownerUserId?: string;
  owner?: { userId: string; name: string };
  ownerName?: string;
  filter: string[];
  sort?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface TrackerProjectInput {
  name: string;
  description?: string;
  state?: string;
  ownerId?: string | null;
}

export interface TrackerProjectPatch {
  name?: string;
  description?: string;
  state?: string;
  ownerId?: string | null;
  archived?: boolean;
}

export interface TrackerMilestoneInput {
  name: string;
  description?: string;
  due: string;
  state?: string;
}

export interface TrackerMilestonePatch {
  name?: string;
  description?: string;
  due?: string | null;
  state?: string;
  archived?: boolean;
}

export interface TrackerSavedViewInput {
  name: string;
  filter: string[];
  shared?: boolean;
}

export interface TrackerSavedViewPatch {
  name?: string;
  filter?: string[];
  shared?: boolean;
}

export interface TrackerAssignee { userId: string; name: string }
export interface TrackerCreator {
  type: 'user' | 'mcp_token' | 'integration' | 'system';
  id: string | null;
  name: string;
}
export interface TrackerRelation { kind: TrackerRelationKind; key: string }

export type TrackerLink =
  | {
      id: string; kind: 'pr'; provider: 'github'; repo: string; number: number; title: string;
      state: 'draft' | 'open' | 'merged' | 'closed'; url: string;
      author: { login: string; name?: string; avatarUrl?: string }; branch?: string; at: string;
    }
  | {
      id: string; kind: 'commit'; provider: 'github'; repo: string; sha: string; title: string;
      url: string; author: { login: string; name?: string; avatarUrl?: string }; branch?: string; at: string;
    }
  | { id: string; kind: 'card'; boardId: string; kanbanId: string; cardId: string; at: string };

export interface TrackerTicket {
  id: string;
  key: string;
  trackerId: string;
  title: string;
  description: string;
  state: Pick<TrackerState, 'id' | 'key' | 'name' | 'category'>;
  priority: TrackerPriority;
  assignee: TrackerAssignee | null;
  creator: TrackerCreator;
  source?: 'app' | 'import' | 'mcp' | 'integration';
  labels: TrackerLabel[];
  project: { id: string; name: string } | null;
  milestone: { id: string; name: string; due: string | null } | null;
  estimate: number | null;
  due: string | null;
  parent: string | null;
  relations: TrackerRelation[];
  links: TrackerLink[];
  aliases: string[];
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  updatedSeq: number;
  /** Optional fields returned by the richer list API (slice 3b). */
  commentCount?: number;
  subIssueCount?: number;
  subIssueDone?: number;
  blocked?: boolean;
  prs?: TrackerLink[];
  snippet?: string;
}

export interface TrackerComment {
  id: string;
  ticketKey: string;
  author: { userId: string | null; name: string };
  body: string;
  clientId: string;
  createdAt: number;
  editedAt: number | null;
  deletedAt?: number | null;
  deleted?: boolean;
}

export interface TrackerEvent {
  id: number;
  ticketKey: string;
  eventType: string;
  at: number;
  actor: { id?: string | null; userId?: string | null; name?: string; type?: string; provider?: string } | null;
  field?: string;
  from?: unknown;
  to?: unknown;
  [key: string]: unknown;
}

export interface TrackerTicketDetail {
  ticket: TrackerTicket;
  comments: TrackerComment[];
  events: TrackerEvent[];
  subscribed: boolean;
  resolvedKey?: string;
}

export interface TrackerPage<T> { items: T[]; nextCursor: string | null }
export interface TrackerTicketListPage {
  tickets: TrackerTicket[];
  nextCursor: string | null;
  facets?: TrackerFacets;
}
export interface TrackerFacets {
  states?: Array<{ id: string; name: string; count: number }>;
  labels?: Array<{ id: string; name: string; color: string | null; count: number }>;
  assignees?: Array<{ userId: string; name: string; count: number }>;
  [name: string]: unknown;
}
export interface TrackerUpdatedTickets { tickets: TrackerTicket[]; seq: number }

export interface TrackerCreateInput {
  title: string;
  description?: string;
  state?: string;
  priority?: TrackerPriority;
  assignee?: string | null;
  labels?: string[];
  due?: string | null;
  parent?: string | null;
  idempotencyKey: string;
}
export interface TrackerPatch {
  title?: string;
  description?: string;
  state?: string;
  priority?: TrackerPriority;
  assignee?: string | null;
  labels?: string[];
  due?: string | null;
  parent?: string | null;
  project?: string | null;
  milestone?: string | null;
  archived?: boolean;
  ifUpdatedSeq?: number;
}
export interface TrackerBulkPatch extends Omit<TrackerPatch, 'ifUpdatedSeq'> {}
export interface TrackerBulkItemResult {
  key: string;
  ok: boolean;
  ticket?: TrackerTicket;
  before?: TrackerBulkPatch;
  error?: TrackerErrorCode | string | { error?: string; message?: string; path?: string };
}
export interface TrackerBulkResult {
  results: TrackerBulkItemResult[];
  batchId: string;
  before: Record<string, { patch: TrackerBulkPatch; updatedSeq: number }>;
}

export interface TrackerListQuery {
  filter?: string | string[];
  q?: string;
  limit?: number;
  cursor?: string;
  sort?: TrackerSort;
  group?: string | null;
  includeFacets?: boolean;
}
export type TrackerSortField = 'key' | 'title' | 'state' | 'priority' | 'assignee' | 'due' | 'createdAt' | 'updatedAt';
export interface TrackerSort { field: TrackerSortField; direction: 'asc' | 'desc' }

export interface TrackerCommentPage { comments: TrackerComment[]; nextCursor: string | null }
export interface TrackerEventPage { events: TrackerEvent[]; nextCursor: string | null }
export interface TrackerFeedEvent {
  id: number;
  ticketKey: string;
  eventType: string;
  at: number;
  actor: TrackerEvent['actor'];
}
export interface TrackerFeed { events: TrackerFeedEvent[]; seq: number }

export type TrackerNotificationKind =
  | 'assigned' | 'mentioned' | 'commented' | 'status_changed' | 'due_soon' | 'relation_changed' | 'integration_activity';
export type TrackerNotifyChoice = 'both' | 'app' | 'off';

export interface TrackerInboxItem {
  id: string;
  kind: TrackerNotificationKind;
  createdAt: number;
  readAt: number | null;
  ticket: {
    key: string;
    title: string;
    state: Pick<TrackerState, 'name' | 'category'>;
    assignee: { name: string } | null;
    priority: TrackerPriority;
  };
  actor: { name: string } | null;
  preview: string | null;
  detail: { state?: string; key?: string; relation?: string; text?: string; dueDate?: string } | null;
}
export interface TrackerInboxPage { items: TrackerInboxItem[]; nextCursor: string | null; unread: number }
export interface TrackerNotificationPrefs {
  kinds: TrackerNotificationKind[];
  prefs: Record<TrackerNotificationKind, TrackerNotifyChoice>;
}

export interface TrackerConflictActor { name: string; kind: string }

export class TrackerError extends Error {
  readonly code: TrackerErrorCode;
  readonly path?: string;
  readonly current?: TrackerTicket;
  readonly by?: TrackerConflictActor;
  readonly status?: number;

  constructor(
    code: TrackerErrorCode,
    message: string = code,
    details: { path?: string; current?: TrackerTicket; by?: TrackerConflictActor; status?: number } = {},
  ) {
    super(message);
    this.name = 'TrackerError';
    this.code = code;
    this.path = details.path;
    this.current = details.current;
    this.by = details.by;
    this.status = details.status;
  }
}
