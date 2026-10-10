import type { TrackerInboxItem, TrackerNotificationKind, TrackerNotifyChoice } from '../../tracker-types';

export interface InboxDayGroup {
  label: string;
  items: TrackerInboxItem[];
}

export interface InboxSelectionModel {
  ids: string[];
  cursor: string | null;
  selected: Set<string>;
  anchor: string | null;
}

const RELATION_LABELS: Record<string, string> = {
  blocked_by: 'blocked by',
  blocks: 'blocks',
  relates_to: 'related to',
  duplicates: 'duplicates',
  duplicated_by: 'duplicated by',
  cloned_from: 'cloned from',
};

const KIND_LABELS: Record<TrackerNotificationKind, string> = {
  assigned: 'Assigned to me',
  mentioned: 'Mentions',
  commented: 'Comments',
  status_changed: 'Status changes',
  relation_changed: 'Relations',
  due_soon: 'Due soon',
  integration_activity: 'Integration activity',
};

const CHOICE_LABELS: Record<TrackerNotifyChoice, string> = {
  both: 'In Tabula and email',
  app: 'In Tabula only',
  off: 'Off',
};

/** A concise, stable description of why a notification is in the inbox. */
export function reasonLine(item: TrackerInboxItem): string {
  const actor = item.actor?.name?.trim();
  switch (item.kind) {
    case 'assigned': return actor ? `${actor} assigned you` : 'Assigned to you';
    case 'mentioned': return actor ? `${actor} mentioned you` : 'Mentioned you';
    case 'commented': return actor ? `${actor} commented` : 'New comment';
    case 'status_changed': return item.detail?.state?.trim() ? `Moved to ${item.detail.state}` : 'Status changed';
    case 'relation_changed': {
      const relation = item.detail?.relation ? RELATION_LABELS[item.detail.relation] : undefined;
      return relation && item.detail?.key?.trim() ? `Now ${relation} ${item.detail.key}` : 'Relation changed';
    }
    case 'integration_activity': return item.detail?.text?.trim() || 'New activity';
    case 'due_soon': return item.detail?.dueDate?.trim() ? `Due ${item.detail.dueDate}` : 'Due soon';
  }
  return 'New activity';
}

function localDay(timestamp: number, offsetMinutes: number): string {
  const offset = Number.isFinite(offsetMinutes) ? offsetMinutes : 0;
  return new Date(timestamp + offset * 60_000).toISOString().slice(0, 10);
}

function labelForDay(day: string, today: string, yesterday: string): string {
  if (day === today) return 'Today';
  if (day === yesterday) return 'Yesterday';
  const date = new Date(`${day}T00:00:00.000Z`);
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${weekdays[date.getUTCDay()]} ${date.getUTCDate()} ${months[date.getUTCMonth()]}`;
}

/** Groups notices by the viewer's calendar day. `offsetMinutes` is minutes east of UTC. */
export function groupByDay(items: readonly TrackerInboxItem[], now: number, offsetMinutes: number): InboxDayGroup[] {
  const today = localDay(now, offsetMinutes);
  const yesterday = new Date(`${today}T00:00:00.000Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayKey = yesterday.toISOString().slice(0, 10);
  const sorted = [...items].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  const groups = new Map<string, TrackerInboxItem[]>();
  for (const item of sorted) {
    const day = localDay(item.createdAt, offsetMinutes);
    const group = groups.get(day) ?? [];
    group.push(item);
    groups.set(day, group);
  }
  return [...groups].map(([day, rows]) => ({ label: labelForDay(day, today, yesterdayKey), items: rows }));
}

function uniqueIds(ids: readonly string[]): string[] { return [...new Set(ids)]; }

export function createInboxSelection(ids: readonly string[] = [], cursor: string | null = null): InboxSelectionModel {
  const ordered = uniqueIds(ids);
  return {
    ids: ordered,
    cursor: cursor && ordered.includes(cursor) ? cursor : ordered[0] ?? null,
    selected: new Set(),
    anchor: null,
  };
}

/** Keeps the cursor and selection attached to notice ids across a refresh or page append. */
export function reconcileInboxSelection(model: InboxSelectionModel, ids: readonly string[]): InboxSelectionModel {
  const ordered = uniqueIds(ids);
  const oldIndex = model.cursor === null ? 0 : model.ids.indexOf(model.cursor);
  const cursor = model.cursor && ordered.includes(model.cursor)
    ? model.cursor
    : ordered.length ? ordered[Math.min(Math.max(oldIndex, 0), ordered.length - 1)] : null;
  const selected = new Set([...model.selected].filter((id) => ordered.includes(id)));
  const anchor = model.anchor && ordered.includes(model.anchor) ? model.anchor : [...selected][0] ?? cursor;
  return { ids: ordered, cursor, selected, anchor };
}

function withRange(model: InboxSelectionModel, cursor: string, anchor: string): InboxSelectionModel {
  const from = model.ids.indexOf(anchor);
  const to = model.ids.indexOf(cursor);
  if (from < 0 || to < 0) return { ...model, cursor };
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  return { ...model, cursor, anchor, selected: new Set(model.ids.slice(start, end + 1)) };
}

export function moveInboxCursor(model: InboxSelectionModel, delta: -1 | 1, extend = false): InboxSelectionModel {
  if (!model.ids.length) return { ...model, cursor: null };
  const at = model.cursor === null ? (delta > 0 ? -1 : model.ids.length) : model.ids.indexOf(model.cursor);
  const cursor = model.ids[Math.max(0, Math.min(model.ids.length - 1, at + delta))];
  if (!extend) return { ...model, cursor };
  return withRange(model, cursor, model.anchor ?? model.cursor ?? cursor);
}

export function moveInboxCursorToEdge(model: InboxSelectionModel, edge: 'first' | 'last', extend = false): InboxSelectionModel {
  if (!model.ids.length) return { ...model, cursor: null };
  const cursor = edge === 'first' ? model.ids[0] : model.ids[model.ids.length - 1];
  if (!extend) return { ...model, cursor };
  return withRange(model, cursor, model.anchor ?? model.cursor ?? cursor);
}

export function extendInboxSelection(model: InboxSelectionModel, cursor: string): InboxSelectionModel {
  if (!model.ids.includes(cursor)) return model;
  return withRange(model, cursor, model.anchor ?? model.cursor ?? cursor);
}

export function toggleInboxSelection(model: InboxSelectionModel, id = model.cursor): InboxSelectionModel {
  if (!id || !model.ids.includes(id)) return model;
  const selected = new Set(model.selected);
  if (selected.has(id)) selected.delete(id); else selected.add(id);
  return { ...model, cursor: id, anchor: id, selected };
}

export function selectAllInbox(model: InboxSelectionModel): InboxSelectionModel {
  return { ...model, selected: new Set(model.ids), anchor: model.cursor ?? model.ids[0] ?? null };
}

export function clearInboxSelection(model: InboxSelectionModel): InboxSelectionModel {
  return { ...model, selected: new Set(), anchor: null };
}

export function kindLabel(kind: TrackerNotificationKind): string { return KIND_LABELS[kind]; }
export function choiceLabel(choice: TrackerNotifyChoice): string { return CHOICE_LABELS[choice]; }
