import type { Priority } from './glyphs';

export type ListGroupBy = 'none' | 'state' | 'assignee' | 'project' | 'priority' | 'label' | 'milestone' | 'due-week';
export interface TrackerRow {
  key: string;
  title?: string;
  state?: string | { id?: string; key?: string; name: string };
  assignee?: null | string | { userId?: string; name: string };
  project?: null | string | { id?: string; name: string };
  priority?: Priority;
  due?: string | null;
  createdAt?: number;
  updatedAt?: number;
  [field: string]: unknown;
}

export interface ListFacet { key: string; label: string; count: number }
export type ListFacets = Partial<Record<ListGroupBy, readonly ListFacet[]>>;
export interface ListSort { field: 'key' | 'title' | 'priority' | 'due' | 'createdAt' | 'updatedAt'; direction: 'asc' | 'desc' }
export type ListSortPlan = ListSort | readonly ListSort[];
export interface ListGroupModel { id: string; label: string; count: number; collapsed: boolean; rows: TrackerRow[] }
export interface ListRenderModel {
  group: ListGroupBy;
  groups: ListGroupModel[];
  visibleRows: TrackerRow[];
  cursorKey: string | null;
  cursorIndex: number;
  selectedKeys: string[];
  anchorKey: string | null;
  allKeys: string[];
}
export interface BuildListModelOptions {
  pages: readonly (readonly TrackerRow[])[];
  facets?: ListFacets;
  group: ListGroupBy;
  sort?: ListSortPlan;
  collapsedGroups?: ReadonlySet<string> | readonly string[];
  cursorKey?: string | null;
  selectedKeys?: readonly string[];
  anchorKey?: string | null;
  previous?: ListRenderModel;
}

const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

function keyForGroup(row: TrackerRow, group: ListGroupBy): { key: string; label: string } {
  if (group === 'state') {
    const state = row.state;
    if (state && typeof state === 'object') return { key: state.id ?? state.key ?? state.name, label: state.name };
    return { key: String(state ?? 'none'), label: String(state ?? 'No state') };
  }
  if (group === 'assignee') {
    const assignee = row.assignee;
    if (assignee && typeof assignee === 'object') return { key: assignee.userId ?? assignee.name, label: assignee.name };
    if (typeof assignee === 'string') return { key: assignee, label: assignee };
    return { key: 'none', label: 'No one' };
  }
  if (group === 'project') {
    const project = row.project;
    if (project && typeof project === 'object') return { key: project.id ?? project.name, label: project.name };
    if (typeof project === 'string') return { key: project, label: project };
    return { key: 'none', label: 'No project' };
  }
  if (group === 'priority') {
    const priority = row.priority ?? 'none';
    return { key: priority, label: priority === 'none' ? 'No priority' : `${priority[0].toUpperCase()}${priority.slice(1)}` };
  }
  if (group === 'label') {
    const labels = Array.isArray(row.labels) ? row.labels as Array<{ id?: string; name?: string }> : [];
    const label = labels[0];
    return label ? { key: label.id ?? label.name ?? 'label', label: label.name ?? 'Label' } : { key: 'none', label: 'No label' };
  }
  if (group === 'milestone') {
    const milestone = row.milestone as null | { id?: string; name?: string } | undefined;
    return milestone ? { key: milestone.id ?? milestone.name ?? 'milestone', label: milestone.name ?? 'Milestone' } : { key: 'none', label: 'No milestone' };
  }
  if (group === 'due-week') {
    const due = typeof row.due === 'string' ? row.due : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return { key: 'none', label: 'No due date' };
    const date = new Date(`${due}T00:00:00Z`);
    const day = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - day + 3);
    const weekYear = date.getUTCFullYear();
    const firstThursday = new Date(Date.UTC(weekYear, 0, 4));
    const week = 1 + Math.round(((date.getTime() - firstThursday.getTime()) / 86400000 - ((firstThursday.getUTCDay() + 6) % 7) + 3) / 7);
    const key = `${weekYear}-W${String(week).padStart(2, '0')}`;
    return { key, label: key };
  }
  return { key: 'all', label: 'All issues' };
}

function scalar(row: TrackerRow, field: ListSort['field']): string | number {
  const value = row[field];
  if (field === 'priority') return PRIORITY_RANK[(value as Priority | undefined) ?? 'none'];
  if (field === 'due') return typeof value === 'string' && value ? value : '9999-99-99';
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return value.toLocaleLowerCase();
  return '';
}

function sortRows(rows: TrackerRow[], sort?: ListSortPlan): TrackerRow[] {
  if (!sort) return rows;
  const plan = Array.isArray(sort) ? sort : [sort];
  return rows.sort((a, b) => {
    for (const item of plan) {
      const av = scalar(a, item.field), bv = scalar(b, item.field);
      if (av === bv) continue;
      return (av < bv ? -1 : 1) * (item.direction === 'desc' ? -1 : 1);
    }
    return a.key.localeCompare(b.key);
  });
}

/** Builds grouped rows and reconciles cursor/selection from a refresh or appended server page. */
export function buildListModel(options: BuildListModelOptions): ListRenderModel {
  const rows = options.pages.flatMap((page) => page);
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const uniqueRows = [...byKey.values()];
  const facetMap = new Map((options.facets?.[options.group] ?? []).map((facet) => [facet.key, facet]));
  const buckets = new Map<string, { label: string; rows: TrackerRow[] }>();
  for (const row of uniqueRows) {
    const keys = options.group === 'label'
      ? ((Array.isArray(row.labels) ? row.labels as Array<{ id?: string; name?: string }> : [])
        .map((label) => ({ key: label.id ?? label.name ?? 'label', label: label.name ?? 'Label' }))
        .filter((value, index, values) => values.findIndex((candidate) => candidate.key === value.key) === index))
      : [];
    const memberships = keys.length ? keys : [keyForGroup(row, options.group)];
    for (const key of memberships) {
      const bucket = buckets.get(key.key) ?? { label: key.label, rows: [] };
      bucket.rows.push(row);
      buckets.set(key.key, bucket);
    }
  }
  const facetOrder = options.group === 'none' ? [{ key: 'all', label: 'All issues', count: uniqueRows.length }] : [...(options.facets?.[options.group] ?? [])];
  const descriptors = facetOrder.map((facet) => ({ key: facet.key, label: facet.label, count: facet.count }));
  for (const [key, bucket] of buckets) if (!descriptors.some((d) => d.key === key)) descriptors.push({ key, label: bucket.label, count: bucket.rows.length });
  const collapsed = new Set(options.collapsedGroups ?? []);
  const groups = descriptors.map((descriptor) => {
    const bucket = buckets.get(descriptor.key);
    const facet = facetMap.get(descriptor.key);
    return {
      id: descriptor.key,
      label: descriptor.label,
      count: facet?.count ?? descriptor.count,
      collapsed: collapsed.has(descriptor.key),
      rows: sortRows([...(bucket?.rows ?? [])], options.sort),
    };
  });
  const visibleRows = groups.flatMap((group) => group.collapsed ? [] : group.rows);
  const allKeys = uniqueRows.map((row) => row.key);
  const requestedCursor = options.cursorKey ?? options.previous?.cursorKey ?? null;
  let cursorKey = requestedCursor && visibleRows.some((row) => row.key === requestedCursor) ? requestedCursor : null;
  if (!cursorKey && visibleRows.length) {
    const oldIndex = options.previous?.cursorIndex ?? 0;
    cursorKey = visibleRows[Math.min(Math.max(0, oldIndex), visibleRows.length - 1)].key;
  }
  const selectedSource = options.selectedKeys ?? options.previous?.selectedKeys ?? [];
  const selectedKeys = [...new Set(selectedSource)].filter((key) => byKey.has(key));
  const anchorCandidate = options.anchorKey ?? options.previous?.anchorKey ?? null;
  const anchorKey = anchorCandidate && byKey.has(anchorCandidate) ? anchorCandidate : selectedKeys[0] ?? cursorKey;
  return {
    group: options.group,
    groups,
    visibleRows,
    cursorKey,
    cursorIndex: cursorKey ? visibleRows.findIndex((row) => row.key === cursorKey) : -1,
    selectedKeys,
    anchorKey,
    allKeys,
  };
}

export function moveCursor(model: ListRenderModel, delta: -1 | 1): ListRenderModel {
  if (!model.visibleRows.length) return { ...model, cursorKey: null, cursorIndex: -1 };
  const start = model.cursorIndex < 0 ? (delta > 0 ? -1 : model.visibleRows.length) : model.cursorIndex;
  const next = Math.max(0, Math.min(model.visibleRows.length - 1, start + delta));
  return { ...model, cursorKey: model.visibleRows[next].key, cursorIndex: next };
}

export function moveCursorTo(model: ListRenderModel, key: string): ListRenderModel {
  const cursorIndex = model.visibleRows.findIndex((row) => row.key === key);
  return cursorIndex < 0 ? model : { ...model, cursorKey: key, cursorIndex };
}

export function setGroupCollapsed(model: ListRenderModel, groupId: string, collapsed: boolean): ListRenderModel {
  const groups = model.groups.map((group) => group.id === groupId ? { ...group, collapsed } : group);
  const visibleRows = groups.flatMap((group) => group.collapsed ? [] : group.rows);
  let cursorKey = model.cursorKey && visibleRows.some((row) => row.key === model.cursorKey) ? model.cursorKey : null;
  if (!cursorKey && visibleRows.length) cursorKey = visibleRows[Math.min(Math.max(model.cursorIndex, 0), visibleRows.length - 1)].key;
  return {
    ...model,
    groups,
    visibleRows,
    cursorKey,
    cursorIndex: cursorKey ? visibleRows.findIndex((row) => row.key === cursorKey) : -1,
  };
}

export function toggleSelection(model: ListRenderModel, key = model.cursorKey): ListRenderModel {
  if (!key || !model.allKeys.includes(key)) return model;
  const next = new Set(model.selectedKeys);
  if (next.has(key)) next.delete(key); else next.add(key);
  return { ...model, selectedKeys: [...next], anchorKey: key };
}

export function extendSelection(model: ListRenderModel, key: string): ListRenderModel {
  const at = model.visibleRows.findIndex((row) => row.key === key);
  if (at < 0) return model;
  const anchorAt = model.visibleRows.findIndex((row) => row.key === model.anchorKey);
  const start = anchorAt < 0 ? model.cursorIndex : anchorAt;
  const lo = Math.min(Math.max(0, start), at), hi = Math.max(Math.max(0, start), at);
  const selectedKeys = [...new Set(model.visibleRows.slice(lo, hi + 1).map((row) => row.key))];
  return { ...model, selectedKeys, anchorKey: model.anchorKey ?? model.cursorKey };
}

export function selectAll(model: ListRenderModel): ListRenderModel {
  return { ...model, selectedKeys: [...new Set(model.visibleRows.map((row) => row.key))], anchorKey: model.cursorKey };
}

/** J/K on the ticket page stays inside the currently rendered list and stops at either end. */
export function adjacentTicket(rows: readonly TrackerRow[], currentKey: string, direction: -1 | 1): TrackerRow | null {
  const at = rows.findIndex((row) => row.key === currentKey);
  return at < 0 ? null : rows[at + direction] ?? null;
}
