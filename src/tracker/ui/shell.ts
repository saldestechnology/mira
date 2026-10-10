import './tracker.css';
import { closePopover, dialog, popover, toast } from '../../ui/common';
import { h } from '../../ui/dom';
import { TrackerError, type TrackerFacets, type TrackerListQuery, type TrackerMeta, type TrackerPriority, type TrackerSortField, type TrackerState, type TrackerTicket, type TrackerView } from '../../tracker-types';
import type { TrackerApi, TrackerStore } from '../../tracker-data';
import { build, parse, type FilterChip } from './filter';
import { createFilterBar, type FilterBarController } from './filter-bar';
import { avatar, keyChip, labelChip, relativeTime, dueChip } from './primitives';
import { priorityGlyph, priorityLabel, stateGlyph } from './glyphs';
import { buildListModel, moveCursor, moveCursorTo, selectAll, toggleSelection, extendSelection, type ListFacets, type ListGroupBy, type ListRenderModel, type ListSortPlan, type TrackerRow } from './list-model';
import { buildCommandItems, openCommandBox, type CommandItem } from './command-box';
import { resolveKey, SHORTCUTS, type KeyboardLayer, type TrackerAction } from './keys';
import { openPicker, type PickerResult } from './picker';
import { openNewIssueDialog } from './new-issue';
import { publishTrackerSnapshot } from './frame-snapshot';
import { mountTicketPage } from './ticket-page';
import { mountInbox } from './inbox';
import { renderSnippet } from './snippet';
import { trackerErrorField } from './error-path';
import { buildTrackerPath } from '../../tracker-route';

const TABS: ReadonlyArray<{ id: TrackerView; label: string; glyph: string }> = [
  { id: 'inbox', label: 'Inbox', glyph: '◉' },
  { id: 'my', label: 'My issues', glyph: '◎' },
  { id: 'all', label: 'All issues', glyph: '≡' },
  { id: 'board', label: 'Board', glyph: '▦' },
  { id: 'projects', label: 'Projects', glyph: '▤' },
];
const GROUPS: Array<{ value: ListGroupBy; label: string }> = [
  { value: 'none', label: 'No grouping' }, { value: 'state', label: 'State' }, { value: 'assignee', label: 'Assignee' },
  { value: 'project', label: 'Project' }, { value: 'priority', label: 'Priority' }, { value: 'label', label: 'Label' },
  { value: 'milestone', label: 'Milestone' }, { value: 'due-week', label: 'Due week' },
];
const SORTS: Array<{ value: TrackerSortField; label: string }> = [
  { value: 'updatedAt', label: 'Updated' }, { value: 'createdAt', label: 'Created' }, { value: 'priority', label: 'Priority' },
  { value: 'due', label: 'Due date' }, { value: 'title', label: 'Title' }, { value: 'key', label: 'Key' },
];
const REQUIRED_COLUMNS = ['priority', 'key', 'state', 'title', 'assignee'] as const;
const OPTIONAL_COLUMNS = ['project', 'due', 'updated'] as const;
type Column = typeof REQUIRED_COLUMNS[number] | typeof OPTIONAL_COLUMNS[number];
type TrackerSort = { field: TrackerSortField; direction: 'asc' | 'desc' };

export interface TrackerViewerState {
  tab: TrackerView;
  viewId: string | null;
  filter: string[];
  queryText: string;
  group: ListGroupBy;
  sort: TrackerSort;
  allSort: TrackerSort;
  mySort: TrackerSort;
  density: 'comfortable' | 'compact';
  columns: Set<Column>;
  collapsedGroups: Set<string>;
  cursorKey: string | null;
  selectedKeys: string[];
  anchorKey: string | null;
  scrollTop: number;
  ticketKey: string | null;
  mySubtab: 'active' | 'created';
}

const viewerStates = new WeakMap<TrackerStore, Map<string, TrackerViewerState>>();

/** Tabs, filters, cursor, and layout belong to this viewer's tracker window. */
export function trackerViewerState(store: TrackerStore, viewerId: string, trackerId = 'default', defaultTab: TrackerView = 'inbox'): TrackerViewerState {
  let byViewer = viewerStates.get(store);
  if (!byViewer) { byViewer = new Map(); viewerStates.set(store, byViewer); }
  const stateKey = `${trackerId}:${viewerId}`;
  const existing = byViewer.get(stateKey);
  if (existing) return existing;
  const state: TrackerViewerState = {
    tab: defaultTab, viewId: null, filter: [], queryText: '', group: 'state',
    sort: defaultTab === 'my' ? { field: 'priority', direction: 'asc' } : { field: 'updatedAt', direction: 'desc' },
    allSort: { field: 'updatedAt', direction: 'desc' }, mySort: { field: 'priority', direction: 'asc' },
    density: 'comfortable', columns: new Set<Column>([...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS]), collapsedGroups: new Set(),
    cursorKey: null, selectedKeys: [], anchorKey: null, scrollTop: 0, ticketKey: null, mySubtab: 'active',
  };
  byViewer.set(stateKey, state);
  return state;
}

export function visibleColumns(width: number, chosen: ReadonlySet<Column>): Column[] {
  const columns: Column[] = [...REQUIRED_COLUMNS];
  if (width >= 800 && chosen.has('project')) columns.push('project');
  if (width >= 920 && chosen.has('due')) columns.push('due');
  if (width >= 1080 && chosen.has('updated')) columns.push('updated');
  return columns;
}

export function facetsForGroup(group: ListGroupBy, facets?: TrackerFacets): ListFacets | undefined {
  if (!facets) return undefined;
  if (group === 'state' && facets.states) return { state: facets.states.map((item) => ({ key: item.id, label: item.name, count: item.count })) };
  if (group === 'label' && facets.labels) return { label: facets.labels.map((item) => ({ key: item.id, label: item.name, count: item.count })) };
  if (group === 'assignee' && facets.assignees) return { assignee: facets.assignees.map((item) => ({ key: item.userId, label: item.name, count: item.count })) };
  return undefined;
}

export interface TrackerShellOptions {
  store: TrackerStore;
  api: TrackerApi;
  viewerId: string;
  trackerId: string;
  windowId?: string;
  initialTab?: TrackerView;
  initialViewId?: string;
  initialTicketKey?: string;
  fullScreen?: boolean;
  boardName?: string;
  layoutWidth?: number;
  readOnly?: boolean;
  onFullscreenChange?: (fullScreen: boolean) => void;
  onTicketChange?: (key: string | null) => void;
  onTabChange?: (tab: TrackerView, viewId?: string) => void;
  onWorkExit?: () => void;
  onCreated?: (key: string) => void;
  onSnapshot?: () => void;
  active?: () => boolean;
}

export interface TrackerShellController {
  el: HTMLElement;
  focus(): void;
  setFullscreen(value: boolean): void;
  setTicket(key: string | null): void;
  updateLayout(width: number): void;
  destroy(): void;
  state: TrackerViewerState;
}

function isTextTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return !!element && (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable || Boolean(element.closest('[contenteditable="true"]')));
}

function stableQuery(state: TrackerViewerState): TrackerListQuery {
  // The REST list route currently accepts filters, q and limit. Grouping, facets and sorting are applied locally.
  const filters = state.tab === 'my' && state.mySubtab === 'active' ? ['assignee:me', ...state.filter] : [...state.filter];
  return {
    filter: filters, q: state.queryText.trim() || undefined, limit: 50,
  };
}

/** The server's list endpoint returns a compact projection; fill fields used by the shared row UI. */
function ticketFromListRow(row: TrackerRow, meta: TrackerMeta, trackerId: string): TrackerTicket {
  const partial = row as unknown as Partial<TrackerTicket>;
  const listedState = partial.state as Partial<TrackerTicket['state']> | undefined;
  const stateReference = listedState?.id ?? listedState?.key ?? listedState?.name;
  const canonicalState = meta.states.find((item) => item.id === stateReference || item.key === stateReference || item.name === stateReference);
  const categories = ['backlog', 'unstarted', 'started', 'completed', 'canceled'] as const;
  const category = listedState?.category;
  const priorities: readonly TrackerPriority[] = ['none', 'urgent', 'high', 'medium', 'low'];
  const updatedAt = typeof partial.updatedAt === 'number' && Number.isFinite(partial.updatedAt) ? partial.updatedAt : 0;
  const labels = Array.isArray(partial.labels) ? partial.labels.filter((label) => label && typeof label.name === 'string') : [];
  const assignee = partial.assignee && typeof partial.assignee.userId === 'string' && typeof partial.assignee.name === 'string'
    ? partial.assignee : null;
  const project = partial.project && typeof partial.project.id === 'string' && typeof partial.project.name === 'string'
    ? partial.project : null;
  const milestone = partial.milestone && typeof partial.milestone.id === 'string' && typeof partial.milestone.name === 'string'
    ? partial.milestone : null;
  return {
    ...partial,
    id: typeof partial.id === 'string' ? partial.id : `list:${row.key}`,
    key: row.key,
    trackerId: typeof partial.trackerId === 'string' ? partial.trackerId : trackerId,
    title: typeof partial.title === 'string' ? partial.title : row.key,
    description: typeof partial.description === 'string' ? partial.description : '',
    state: {
      id: typeof listedState?.id === 'string' ? listedState.id : canonicalState?.id ?? stateReference ?? 'unknown',
      key: typeof listedState?.key === 'string' ? listedState.key : canonicalState?.key ?? stateReference ?? 'unknown',
      name: typeof listedState?.name === 'string' ? listedState.name : canonicalState?.name ?? String(stateReference ?? 'Unknown state'),
      category: categories.includes(category as (typeof categories)[number]) ? category as TrackerTicket['state']['category'] : canonicalState?.category ?? 'unstarted',
    },
    priority: priorities.includes(partial.priority as TrackerPriority) ? partial.priority! : 'none',
    assignee,
    creator: partial.creator ?? { type: 'system', id: null, name: 'System' },
    labels,
    project,
    milestone,
    estimate: typeof partial.estimate === 'number' ? partial.estimate : null,
    due: typeof partial.due === 'string' ? partial.due : null,
    parent: typeof partial.parent === 'string' ? partial.parent : null,
    relations: Array.isArray(partial.relations) ? partial.relations : [],
    links: Array.isArray(partial.links) ? partial.links : [],
    aliases: Array.isArray(partial.aliases) ? partial.aliases : [],
    archivedAt: typeof partial.archivedAt === 'number' ? partial.archivedAt : null,
    createdAt: typeof partial.createdAt === 'number' ? partial.createdAt : updatedAt,
    updatedAt,
    updatedSeq: typeof partial.updatedSeq === 'number' ? partial.updatedSeq : 0,
  };
}

function valueFor(ticket: TrackerTicket, field: string): string {
  if (field === 'state') return ticket.state.name;
  if (field === 'assignee') return ticket.assignee?.name ?? 'No one';
  if (field === 'priority') return priorityLabel(ticket.priority);
  if (field === 'labels') return ticket.labels.map((label) => label.name).join(', ') || 'No labels';
  if (field === 'due') return ticket.due ?? 'No due date';
  if (field === 'project') return ticket.project?.name ?? 'No project';
  return 'current value';
}

export function mountTrackerShell(parent: HTMLElement, options: TrackerShellOptions): TrackerShellController {
  const state = trackerViewerState(options.store, options.viewerId, options.windowId ?? options.trackerId, options.initialTab);
  state.viewId = options.initialViewId ?? state.viewId;
  state.ticketKey = options.initialTicketKey ?? state.ticketKey;
  let fullScreen = options.fullScreen === true;
  let meta = options.store.snapshot().meta;
  let readOnly = options.readOnly === true || options.store.snapshot().readOnly || meta?.me.canWrite === false;
  let currentCache = options.store.list(stableQuery(state));
  let listModel: ListRenderModel | null = null;
  let stopList: (() => void) | null = null;
  let stopBoard: Array<() => void> = [];
  let stopStore: (() => void) | null = null;
  let stopKeyListener: (() => void) | null = null;
  let debounce: number | undefined;
  let unreadCount = 0;
  let inboxController: ReturnType<typeof mountInbox> | null = null;
  let ticketPageController: ReturnType<typeof mountTicketPage> | null = null;
  let boardLaneStrip: HTMLElement | null = null;
  let boardLanesHost: HTMLElement | null = null;
  let boardErrorHost: HTMLElement | null = null;
  let boardLaneKey: string | null = null;
  const boardCaches = new Map<string, { state: TrackerState; query: TrackerListQuery; cache: ReturnType<TrackerStore['list']> }>();
  let listRenderHost: HTMLElement | null = null;
  let resultsHost: HTMLElement | null = null;
  let errorHost: HTMLElement | null = null;
  let skeletonHost: HTMLElement | null = null;
  let filterController: FilterBarController | null = null;
  let lastUndoAction: (() => Promise<unknown>) | null = null;
  let pendingSequence: { key: 'g'; expiresAt: number } | null = null;
  let layoutWidth = options.layoutWidth ?? (fullScreen ? window.innerWidth : 1440);
  let destroyed = false;
  let ticketError = '';

  const root = h('section', { class: 'trk trk-shell', tabindex: '0', 'aria-label': 'Tracker', 'data-fullscreen': String(fullScreen) });
  const fullscreenStrip = h('div', { class: 'trk-fullscreen-strip', hidden: !fullScreen },
    h('span', { class: 'trk-board-name' }, options.boardName ?? 'Tracker'),
    h('button', { class: 'trk-small-button', type: 'button', onclick: () => setFullscreen(false) }, 'Back to board'),
  );
  const tabs = h('nav', { class: 'trk-tabs', role: 'tablist', 'aria-label': 'Tracker sections' });
  const commandButton = h('button', { class: 'trk-command-trigger', type: 'button', 'aria-label': 'Open command box, Command or Control K' }, '⌘K');
  const newButton = h('button', { class: 'trk-primary-button trk-new-trigger', type: 'button' }, '+ New issue');
  const fullscreenButton = h('button', { class: 'trk-icon-button', type: 'button', 'aria-label': fullScreen ? 'Back to board' : 'Open full screen' }, fullScreen ? '↙' : '↗');
  const offlineLine = h('div', { class: 'trk-offline-line', role: 'status', hidden: typeof navigator === 'undefined' || navigator.onLine !== false },
    h('span', null, 'Offline. Changes are saved here and will sync.'),
    h('span', { class: 'trk-offline-create-reason' }, 'Needs a connection to get a ticket number.'),
  );
  const errorBanner = h('div', { class: 'trk-error-banner', role: 'alert', hidden: true });
  const content = h('div', { class: 'trk-content' });
  const live = h('div', { class: 'trk-live-region', 'aria-live': 'polite', 'aria-atomic': 'true' });
  root.append(fullscreenStrip, h('header', { class: 'trk-header' }, tabs,
    h('div', { class: 'trk-header-actions' }, commandButton, newButton, fullscreenButton)),
  offlineLine, errorBanner, content, live);
  parent.appendChild(root);
  root.dataset.width = String(layoutWidth);

  const announce = (message: string) => { live.textContent = message; };
  const destroyInbox = () => {
    inboxController?.destroy();
    inboxController = null;
  };
  const destroyTicketPage = () => {
    ticketPageController?.destroy();
    ticketPageController = null;
  };
  const runUndo = async () => {
    const undo = lastUndoAction;
    if (!undo) return;
    lastUndoAction = null;
    try { await undo(); announce('Change undone'); toast('Change undone'); }
    catch { toast('The change could not be undone.'); }
  };
  const active = () => !destroyed && (options.active?.() ?? (root === document.activeElement || root.contains(document.activeElement) || fullScreen));
  const updateActions = () => {
    readOnly = options.readOnly === true || options.store.snapshot().readOnly || meta?.me.canWrite === false;
    newButton.hidden = readOnly;
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    offlineLine.hidden = !offline;
    newButton.disabled = offline;
    if (offline) newButton.setAttribute('aria-description', 'Needs a connection to get a ticket number.');
    else newButton.removeAttribute('aria-description');
  };

  const switchTab = (tab: TrackerView) => {
    if (state.tab === 'my') state.mySort = { ...state.sort };
    else if (state.tab === 'all') state.allSort = { ...state.sort };
    state.tab = tab;
    if (tab === 'my') state.sort = { ...state.mySort };
    else if (tab === 'all') state.sort = { ...state.allSort };
    state.viewId = null;
    state.ticketKey = null;
    options.onTabChange?.(tab);
    renderPage();
  };
  const setMySubtab = (subtab: 'active' | 'created') => {
    if (state.mySubtab === subtab) return;
    state.mySubtab = subtab;
    state.selectedKeys = [];
    state.cursorKey = null;
    state.anchorKey = null;
    renderPage();
  };

  const showError = (message: string) => {
    errorBanner.replaceChildren(h('span', null, message), h('button', { class: 'trk-small-button', type: 'button', onclick: () => {
      errorBanner.hidden = true;
      void options.store.loadMeta(true).catch((error: unknown) => showError(error instanceof Error ? error.message : 'Could not load tracker data.'));
      if (state.tab === 'all' || state.tab === 'my') watchQuery();
      else if (state.tab === 'board') startBoardWatch();
    } }, 'Retry'));
    errorBanner.hidden = false;
  };

  const showListError = (message: string) => {
    if (!errorHost || !root.contains(errorHost)) { showError(message); return; }
    const target = errorHost;
    const displayMessage = message.startsWith('Could not load') ? message : `Could not load issues. ${message}`;
    target.replaceChildren(h('span', null, displayMessage), h('button', {
      class: 'trk-small-button', type: 'button', onclick: () => {
        target.hidden = true;
        void options.store.loadList(stableQuery(state), { force: true }).catch((error: unknown) =>
          showListError(error instanceof Error ? error.message : 'Could not load issues.'));
      },
    }, 'Retry'));
    target.hidden = false;
    if (skeletonHost) skeletonHost.hidden = true;
    if (listRenderHost) listRenderHost.replaceChildren();
    if (resultsHost) resultsHost.textContent = 'Issues unavailable';
  };

  const renderTabs = () => {
    tabs.replaceChildren(...TABS.map((tab) => h('button', {
      class: `trk-tab${state.tab === tab.id ? ' active' : ''}`, type: 'button', role: 'tab',
      'aria-selected': String(state.tab === tab.id), 'aria-label': tab.id === 'inbox' ? `${tab.label}, ${unreadCount} unread` : tab.label,
      onclick: () => switchTab(tab.id),
    }, h('span', { class: 'trk-tab-glyph', 'aria-hidden': 'true' }, tab.glyph), h('span', { class: 'trk-tab-name' }, tab.label),
    tab.id === 'inbox' ? h('span', { class: 'trk-unread-count', 'aria-label': `${unreadCount} unread` }, String(unreadCount)) : null)));
    root.dataset.width = String(layoutWidth);
    root.classList.toggle('trk-narrow-frame', layoutWidth < 720);
  };

  const renderMenu = (anchor: HTMLElement, label: string, values: readonly { value: string; label: string }[], current: string,
    choose: (value: string) => void) => {
    void openPicker<string>(anchor, { label, options: values.map((item) => ({ value: item.value, label: item.label })), value: current })
      .then((value: PickerResult<string>) => { if (typeof value === 'string') choose(value); });
  };

  const getMeta = (): TrackerMeta | undefined => meta ?? options.store.snapshot().meta;
  const listFacets = (cache: typeof currentCache): ListFacets | undefined => facetsForGroup(state.group, cache.facets);
  const stopBoardWatch = () => { stopBoard.forEach((stop) => stop()); stopBoard = []; boardCaches.clear(); };
  const showBoardError = (message: string, query?: TrackerListQuery) => {
    const host = boardErrorHost;
    if (!host) { showListError(message); return; }
    host.replaceChildren(h('span', null, message), h('button', {
      class: 'trk-small-button', type: 'button', onclick: () => {
        if (!query) { host.hidden = true; showError(message); return; }
        void options.store.loadList(query, { force: true }).catch((error: unknown) =>
          showBoardError(error instanceof Error ? error.message : 'Could not load board issues.', query));
      },
    }, 'Retry'));
    host.hidden = false;
  };

  const startWatch = () => {
    stopList?.();
    if (!meta || (state.tab !== 'all' && state.tab !== 'my') || (state.ticketKey && !(fullScreen && layoutWidth > 1100))) return;
    const query = stableQuery(state);
    currentCache = options.store.list(query);
    stopList = options.store.watchList(query, (cache) => {
      currentCache = cache;
      try {
        filterController?.setError(cache.error?.code === 'invalid_filter' ? cache.error.message : null);
        drawRows(cache);
        publishCurrentSnapshot();
      } catch (error) {
        showListError(error instanceof Error ? error.message : 'Could not render issues.');
      }
    });
  };

  const rowButton = (text: string, label: string, action: () => void, className = 'trk-cell-button'): HTMLButtonElement =>
    h('button', { class: className, type: 'button', 'aria-label': label, onclick: (event: Event) => { event.stopPropagation(); action(); } }, text);

  const recordUndo = (message: string, undo: () => Promise<unknown>) => {
    lastUndoAction = undo;
    toast(message, 8000, { label: 'Undo', keyId: 'mod+z', onClick: () => void runUndo() });
  };

  const editOne = async (ticket: TrackerTicket, field: 'state' | 'assignee' | 'priority' | 'labels' | 'due' | 'project', anchor: HTMLElement) => {
    if (readOnly) return;
    const info = getMeta();
    if (!info) return;
    try {
      if (field === 'state') {
        const picked = await openPicker<string>(anchor, { label: 'State', options: info.states.map((item) => ({ value: item.key, label: item.name })), value: ticket.state.key });
        if (typeof picked === 'string' && picked !== ticket.state.key) {
          const next = await options.store.transitionTicket(ticket.key, picked);
          recordUndo('State changed', () => options.store.transitionTicket(ticket.key, ticket.state.key));
          announce(`${next.key} moved to ${next.state.name}`);
        }
      } else if (field === 'assignee') {
        const picked = await openPicker<string>(anchor, { label: 'Assignee', options: info.members.map((item) => ({ value: item.name, label: item.name })), value: ticket.assignee?.name ?? null });
        if ((picked === null || typeof picked === 'string') && picked !== (ticket.assignee?.name ?? null)) {
          await options.store.updateTicket(ticket.key, { assignee: picked });
          recordUndo('Assignee changed', () => options.store.updateTicket(ticket.key, { assignee: ticket.assignee?.name ?? null }));
          announce(`${ticket.key} assigned to ${picked === null ? 'no one' : picked}`);
        }
      } else if (field === 'priority') {
        const priorities: TrackerPriority[] = ['urgent', 'high', 'medium', 'low', 'none'];
        const picked = await openPicker<TrackerPriority>(anchor, { label: 'Priority', options: priorities.map((value) => ({ value, label: priorityLabel(value) })), value: ticket.priority });
        if (typeof picked === 'string' && picked !== ticket.priority) {
          await options.store.updateTicket(ticket.key, { priority: picked });
          recordUndo('Priority changed', () => options.store.updateTicket(ticket.key, { priority: ticket.priority }));
        }
      } else if (field === 'labels') {
        const picked = await openPicker<string>(anchor, { label: 'Labels', multi: true, selected: ticket.labels.map((label) => label.name), options: info.labels.map((item) => ({ value: item.name, label: item.name })) });
        if (Array.isArray(picked)) {
          const labels = picked.filter((value): value is string => typeof value === 'string');
          await options.store.updateTicket(ticket.key, { labels });
          recordUndo('Labels changed', () => options.store.updateTicket(ticket.key, { labels: ticket.labels.map((label) => label.name) }));
        }
      } else if (field === 'due') {
        const today = new Date().toISOString().slice(0, 10);
        const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
        const picked = await openPicker<string>(anchor, { label: 'Due date', value: ticket.due, options: [{ value: today, label: `Today · ${today}` }, { value: tomorrow, label: `Tomorrow · ${tomorrow}` }] });
        if ((picked === null || typeof picked === 'string') && picked !== ticket.due) {
          await options.store.updateTicket(ticket.key, { due: picked });
          recordUndo('Due date changed', () => options.store.updateTicket(ticket.key, { due: ticket.due }));
        }
      } else {
        const projects = [...new Map(currentCache.tickets.flatMap((row) => row.project ? [[row.project.name, row.project.name] as const] : [])).entries()]
          .map(([name, label]) => ({ value: name, label }));
        if (!projects.length) { toast('Projects are not available yet.'); return; }
        const picked = await openPicker<string>(anchor, { label: 'Project', options: projects, value: ticket.project?.name ?? null });
        if (picked !== undefined) toast('Project updates are not available in the tracker store yet.');
      }
    } catch (caught) {
      if (caught instanceof TrackerError && caught.code === 'conflict') {
        const current = caught.current ? valueFor(caught.current, field) : valueFor(ticket, field);
        toast(`Mara changed this at the same time. Current value kept: ${current}`, 5000);
      } else {
        const path = caught instanceof TrackerError ? trackerErrorField(caught.path) : null;
        if (path === field) anchor.setAttribute('aria-invalid', 'true');
        toast(caught instanceof Error ? caught.message : 'The issue could not be updated.');
      }
    }
  };

  const doBulk = async (patch: { state?: string; assignee?: string | null; priority?: TrackerPriority; labels?: string[]; due?: string | null; archived?: boolean }, anchor?: HTMLElement) => {
    if (readOnly || !state.selectedKeys.length) return;
    try {
      let undoBatch: Awaited<ReturnType<TrackerStore['bulk']>> | undefined;
      if (patch.state) {
        // The current bulk store contract has no state field; transition one ticket at a time until that API lands.
        const before = state.selectedKeys.map((key) => [key, currentCache.tickets.find((ticket) => ticket.key === key)?.state.key] as const);
        const transitioned: string[] = [];
        try {
          for (const key of state.selectedKeys) {
            await options.store.transitionTicket(key, patch.state);
            transitioned.push(key);
          }
        } catch (error) {
          for (const [key, previousState] of before) {
            if (transitioned.includes(key) && previousState) await options.store.transitionTicket(key, previousState).catch(() => undefined);
          }
          throw error;
        }
        lastUndoAction = async () => { for (const [key, previousState] of before) if (previousState) await options.store.transitionTicket(key, previousState); };
      } else {
        undoBatch = await options.store.bulk(state.selectedKeys, patch);
        const batch = undoBatch;
        lastUndoAction = () => options.store.undo(batch);
        const count = state.selectedKeys.length;
        toast(patch.archived ? `${count} issues archived` : `${count} issues updated`, 8000, { label: 'Undo', keyId: 'mod+z', onClick: () => void runUndo() });
      }
      if (patch.state) toast(`${state.selectedKeys.length} issues updated`, 8000, { label: 'Undo', keyId: 'mod+z', onClick: () => void runUndo() });
      state.selectedKeys = [];
      announce('Selection cleared');
      drawRows(currentCache);
      updateSelectionBar();
    } catch (caught) {
      const path = caught instanceof TrackerError ? trackerErrorField(caught.path) : null;
      if (anchor && path) anchor.setAttribute('aria-invalid', 'true');
      toast(caught instanceof Error ? caught.message : 'The selected issues could not be updated.');
    }
  };

  const bulkPicker = (anchor: HTMLElement, field: 'state' | 'assignee' | 'priority' | 'labels' | 'due') => {
    const info = getMeta();
    if (!info || !state.selectedKeys.length) return;
    if (field === 'state') renderMenu(anchor, 'State', info.states.map((item) => ({ value: item.key, label: item.name })), '', (value) => void doBulk({ state: value }, anchor));
    else if (field === 'assignee') renderMenu(anchor, 'Assignee', [{ value: '__none', label: 'No one' }, ...info.members.map((item) => ({ value: item.name, label: item.name }))], '', (value) => void doBulk({ assignee: value === '__none' ? null : value }, anchor));
    else if (field === 'priority') renderMenu(anchor, 'Priority', ['urgent', 'high', 'medium', 'low', 'none'].map((value) => ({ value, label: priorityLabel(value as TrackerPriority) })), '', (value) => void doBulk({ priority: value as TrackerPriority }, anchor));
    else if (field === 'labels') renderMenu(anchor, 'Labels', info.labels.map((item) => ({ value: item.name, label: item.name })), '', (value) => void doBulk({ labels: [value] }, anchor));
    else renderMenu(anchor, 'Due date', [{ value: '__none', label: 'No date' }, { value: new Date().toISOString().slice(0, 10), label: 'Today' }], '', (value) => void doBulk({ due: value === '__none' ? null : value }, anchor));
  };

  const issuesForView = (cache: typeof currentCache): TrackerTicket[] => {
    const tickets = cache.tickets.map((row) => ticketFromListRow(row as unknown as TrackerRow, meta!, options.trackerId));
    if (state.tab !== 'my') return tickets;
    const me = getMeta()?.me.userId;
    if (!me) return [];
    if (state.mySubtab === 'created') return tickets.filter((ticket) => ticket.creator.type === 'user' && ticket.creator.id === me);
    return tickets.filter((ticket) => ticket.assignee?.userId === me && ticket.state.category !== 'completed' && ticket.state.category !== 'canceled');
  };
  const facetsForIssues = (cache: typeof currentCache, tickets: readonly TrackerTicket[]): ListFacets | undefined => {
    if (state.tab !== 'my' || state.group !== 'state' || !meta) return listFacets(cache);
    return { state: meta.states.slice().sort((a, b) => a.position - b.position).map((item) => ({
      key: item.id, label: item.name, count: tickets.filter((ticket) => ticket.state.key === item.key).length,
    })) };
  };
  const lockedFilterChips = (): FilterChip[] => state.tab === 'my'
    ? state.mySubtab === 'active'
      ? [{ field: 'assignee', value: 'me', locked: true }]
      : [{ field: 'creator', value: 'me', locked: true }]
    : [];

  const renderRows = (cache: typeof currentCache) => {
    if (!listRenderHost || !resultsHost || !skeletonHost || !errorHost) return;
    if (!meta) {
      skeletonHost.hidden = false;
      listRenderHost.replaceChildren();
      resultsHost.textContent = '';
      return;
    }
    const tickets = issuesForView(cache);
    const primarySort = state.sort.field === 'updatedAt' || state.sort.field === 'createdAt' || state.sort.field === 'priority' || state.sort.field === 'due' || state.sort.field === 'title' || state.sort.field === 'key'
      ? state.sort.field : 'updatedAt';
    const sortPlan: ListSortPlan = state.tab === 'my'
      ? [{ field: primarySort, direction: state.sort.direction }, ...(primarySort === 'due' ? [] : [{ field: 'due' as const, direction: 'asc' as const }])]
      : { field: primarySort, direction: state.sort.direction };
    filterController?.setError(cache.error?.code === 'invalid_filter' ? cache.error.message : null);
    if (cache.error) {
      showListError(cache.error.message || 'Could not load issues.');
      const searchInput = filterController?.el.querySelector<HTMLInputElement>('.trk-filter-input');
      if (searchInput) {
        if (trackerErrorField(cache.error.path) === 'search') searchInput.setAttribute('aria-invalid', 'true');
        else searchInput.removeAttribute('aria-invalid');
      }
      skeletonHost.hidden = true;
      return;
    }
    errorHost.hidden = true;
    listModel = buildListModel({
      pages: [tickets as unknown as TrackerRow[]], facets: facetsForIssues(cache, tickets), group: state.group, sort: sortPlan,
      collapsedGroups: state.collapsedGroups, cursorKey: state.cursorKey, selectedKeys: state.selectedKeys, anchorKey: state.anchorKey,
    });
    state.cursorKey = listModel.cursorKey;
    state.selectedKeys = listModel.selectedKeys;
    state.anchorKey = listModel.anchorKey;
    skeletonHost.hidden = !(cache.loading && cache.tickets.length === 0);
    const searchInput = filterController?.el.querySelector<HTMLInputElement>('.trk-filter-input');
    searchInput?.removeAttribute('aria-invalid');
    const filterActive = state.filter.length > 0 || Boolean(state.queryText.trim());
    if (!cache.loading && tickets.length === 0) {
      const myEmpty = state.tab === 'my' && !filterActive && !cache.nextCursor;
      const emptyMessage = state.tab === 'my' && !filterActive && cache.nextCursor
        ? 'No matching issues on this page.'
        : myEmpty
          ? state.mySubtab === 'active' ? 'Nothing assigned to you.' : 'Nothing created by you yet.'
        : filterActive ? 'No issues match.' : 'No issues yet.';
      listRenderHost.replaceChildren(h('div', { class: 'trk-empty-state' },
        h('h2', null, emptyMessage),
        cache.nextCursor ? h('button', { class: 'trk-load-more', type: 'button', disabled: cache.loadingMore, onclick: () => void options.store.loadMore(stableQuery(state)).catch((error: unknown) => showListError(error instanceof Error ? error.message : 'Could not load more issues.')) }, cache.loadingMore ? 'Loading…' : 'Load more') : null,
        filterActive
          ? h('button', { class: 'trk-small-button', type: 'button', onclick: () => { state.filter = []; state.queryText = ''; filterController?.setChips(lockedFilterChips()); if (filterController) filterController.focusSearch(); watchQuery(); } }, 'Clear filters')
          : (!readOnly ? h('button', { class: 'trk-primary-button', type: 'button', onclick: () => openCreate() }, '+ New issue') : null),
      ));
      resultsHost.textContent = '0 issues';
      return;
    }
    const columns = visibleColumns(layoutWidth, state.columns);
    const model = listModel;
    const selected = state.selectedKeys.length;
    const header = h('div', { class: 'trk-grid-header', role: 'row', style: { gridTemplateColumns: columns.map((column) => `var(--trk-${column}-width)`).join(' ') } },
      ...columns.map((column) => h('div', { role: 'columnheader', class: `trk-col-${column}` }, column === 'updated' ? 'Updated' : column[0].toUpperCase() + column.slice(1))),
    );
    const rows: Node[] = [header];
    const now = Date.now();
    for (const group of model.groups) {
      if (state.group !== 'none') {
        const groupTicket = group.rows[0] as unknown as TrackerTicket | undefined;
        const headerButton = h('button', {
          class: 'trk-group-heading', type: 'button', 'aria-expanded': String(!group.collapsed),
          onclick: () => {
            state.collapsedGroups = new Set(state.collapsedGroups);
            if (group.collapsed) state.collapsedGroups.delete(group.id);
            else state.collapsedGroups.add(group.id);
            state.cursorKey = model.cursorKey;
            drawRows(cache);
          },
        }, groupTicket && state.group === 'state' ? stateGlyph(groupTicket.state.category, groupTicket.state.key) : null,
        h('span', null, group.label), h('span', { class: 'trk-muted' }, String(group.count)));
        rows.push(h('div', { class: 'trk-group-row', role: 'rowheader' }, headerButton));
      }
      if (group.collapsed) continue;
      for (const raw of group.rows) {
        const ticket = ticketFromListRow(raw, meta, options.trackerId);
        const selectedHere = state.selectedKeys.includes(ticket.key);
        const cursor = state.cursorKey === ticket.key;
        const cells: Node[] = [];
        for (const column of columns) {
          if (column === 'priority') cells.push(h('div', { class: 'trk-cell trk-col-priority', role: 'gridcell' },
            readOnly ? priorityGlyph(ticket.priority) : h('button', { class: 'trk-glyph-button', type: 'button', 'aria-label': `${priorityLabel(ticket.priority)} for ${ticket.key}`, onclick: (event: Event) => { event.stopPropagation(); void editOne(ticket, 'priority', event.currentTarget as HTMLElement); } }, priorityGlyph(ticket.priority)),
          ));
          else if (column === 'key') cells.push(h('div', { class: 'trk-cell trk-col-key', role: 'gridcell' }, keyChip(ticket.key)));
          else if (column === 'state') cells.push(h('div', { class: 'trk-cell trk-col-state', role: 'gridcell' },
            readOnly ? h('span', { class: 'trk-state-value' }, stateGlyph(ticket.state.category, ticket.state.key), h('span', null, ticket.state.name))
              : h('button', { class: 'trk-cell-button trk-state-value', type: 'button', 'aria-label': `State: ${ticket.state.name}`, onclick: (event: Event) => { event.stopPropagation(); void editOne(ticket, 'state', event.currentTarget as HTMLElement); } }, stateGlyph(ticket.state.category, ticket.state.key), h('span', null, ticket.state.name)),
          ));
          else if (column === 'title') cells.push(h('div', { class: 'trk-cell trk-col-title', role: 'gridcell' },
            h('button', { class: 'trk-title-link', type: 'button', onclick: (event: Event) => { event.stopPropagation(); openTicket(ticket.key); } }, ticket.title),
            state.queryText.trim() && ticket.snippet ? h('span', { class: 'trk-search-snippet' }, renderSnippet(ticket.snippet)) : null,
            ...ticket.labels.slice(0, 2).map((label) => labelChip(label.name, label.color)),
            ticket.subIssueCount ? h('span', { class: 'trk-sub-count', 'aria-label': `${ticket.subIssueDone ?? 0} of ${ticket.subIssueCount} sub-issues complete` }, `${ticket.subIssueDone ?? 0}/${ticket.subIssueCount}`) : null,
          ));
          else if (column === 'project') cells.push(h('div', { class: 'trk-cell trk-col-project', role: 'gridcell' }, ticket.project?.name ?? '—'));
          else if (column === 'assignee') cells.push(h('div', { class: 'trk-cell trk-col-assignee', role: 'gridcell' }, ticket.assignee
            ? (readOnly ? ticket.assignee.name : rowButton(ticket.assignee.name.slice(0, 2).toUpperCase(), `Assignee: ${ticket.assignee.name}`, () => void editOne(ticket, 'assignee', document.activeElement as HTMLElement), 'trk-avatar-button'))
            : (readOnly ? '—' : rowButton('—', 'Assign issue', () => void editOne(ticket, 'assignee', document.activeElement as HTMLElement), 'trk-avatar-button')),
          ));
          else if (column === 'due') cells.push(h('div', { class: 'trk-cell trk-col-due', role: 'gridcell' },
            readOnly ? dueChip(ticket.due, now) : rowButton(ticket.due ?? '—', ticket.due ? `Due ${ticket.due}` : 'Set due date', () => void editOne(ticket, 'due', document.activeElement as HTMLElement)),
          ));
          else cells.push(h('div', { class: 'trk-cell trk-col-updated', role: 'gridcell' }, relativeTime(now, new Date(ticket.updatedAt).toISOString())));
        }
        const row = h('div', {
          class: `trk-list-row${cursor ? ' is-cursor' : ''}${selectedHere ? ' is-selected' : ''}`,
          role: 'row', tabindex: '-1', 'aria-selected': String(selectedHere), 'data-cursor': String(cursor), 'data-key': ticket.key,
          style: { gridTemplateColumns: columns.map((column) => `var(--trk-${column}-width)`).join(' ') },
          onclick: () => { state.cursorKey = ticket.key; openTicket(ticket.key); },
          onfocus: () => { state.cursorKey = ticket.key; },
        }, ...cells);
        if (!readOnly) {
          const select = h('button', { class: 'trk-row-select', type: 'button', 'aria-label': `${selectedHere ? 'Deselect' : 'Select'} ${ticket.key}`, 'aria-pressed': String(selectedHere), onclick: (event: Event) => { event.stopPropagation(); state.selectedKeys = toggleSelection(model, ticket.key).selectedKeys; state.anchorKey = ticket.key; announce(`${state.selectedKeys.length} selected`); updateSelectionBar(); drawRows(cache); } }, selectedHere ? '✓' : '');
          row.prepend(select);
        }
        rows.push(row);
      }
    }
    listRenderHost.replaceChildren(...rows);
    listRenderHost.setAttribute('aria-rowcount', String(model.visibleRows.length));
    if (cache.nextCursor) listRenderHost.appendChild(h('button', { class: 'trk-load-more', type: 'button', disabled: cache.loadingMore, onclick: () => void options.store.loadMore(stableQuery(state)).catch((error: unknown) => showListError(error instanceof Error ? error.message : 'Could not load more issues.')) }, cache.loadingMore ? 'Loading…' : 'Load more'));
    const facets = facetsForIssues(cache, tickets)?.[state.group];
    const total = state.tab === 'my' ? tickets.length : facets?.reduce((sum, facet) => sum + facet.count, 0) ?? tickets.length;
    resultsHost.textContent = cache.nextCursor ? `${total}+ issues` : `${total} ${total === 1 ? 'issue' : 'issues'}`;
    announce(selected ? `${selected} selected` : '');
  };

  const drawRows = (cache: typeof currentCache) => {
    try { renderRows(cache); }
    catch (error) { showListError(error instanceof Error ? error.message : 'Could not render issues.'); }
  };

  const publishCurrentSnapshot = () => {
    const tickets = currentCache.tickets.slice(0, 12);
    const facets = facetsForGroup(state.group, currentCache.facets)?.[state.group];
    const count = facets?.reduce((sum, facet) => sum + facet.count, 0) ?? currentCache.tickets.length;
    publishTrackerSnapshot(options.trackerId, state.tab, tickets, count);
    options.onSnapshot?.();
  };

  const makeAllIssues = () => {
    const viewCapability = typeof (options.store as TrackerStore & { views?: unknown }).views === 'function' ||
      Array.isArray((getMeta() as (TrackerMeta & { views?: unknown[] }) | undefined)?.views);
    const availableViews = (getMeta() as (TrackerMeta & { views?: Array<{ id?: string; name?: string }> }) | undefined)?.views ?? [];
    const currentViewName = availableViews.find((view) => view.id === state.viewId)?.name ?? (state.tab === 'my' ? 'My issues' : 'All issues');
    const viewMenu = viewCapability
      ? h('button', { class: 'trk-view-name', type: 'button', onclick: () => toast('Saved views are not available yet.') }, currentViewName)
      : h('span', { class: 'trk-view-name' }, currentViewName);
    const groupButton = h('button', { class: 'trk-view-button', type: 'button' }, `Group: ${GROUPS.find((item) => item.value === state.group)?.label ?? 'State'}`);
    const sortLabel = () => state.tab === 'my' && state.sort.field === 'priority' && state.sort.direction === 'asc'
      ? 'Priority ↑, then due ↑'
      : `${SORTS.find((item) => item.value === state.sort.field)?.label ?? 'Updated'} ${state.sort.direction === 'desc' ? '↓' : '↑'}`;
    const sortButton = h('button', { class: 'trk-view-button', type: 'button' }, `Sort: ${sortLabel()}`);
    const displayButton = h('button', { class: 'trk-view-button', type: 'button' }, 'Display');
    const count = h('span', { class: 'trk-results-count', 'aria-live': 'polite' });
    const selectionBar = h('div', { class: 'trk-selection-bar', hidden: true });
    const viewBar = h('div', { class: 'trk-view-bar' }, viewMenu, groupButton, sortButton, displayButton, count);
    filterController = createFilterBar({
      initial: [...lockedFilterChips(), ...parse(state.filter)], meta: getMeta(),
      onChange: (chips: readonly FilterChip[]) => {
        try {
          state.filter = build(chips.filter((chip) => !chip.locked));
          filterController?.setError(null);
          state.selectedKeys = [];
          watchQuery();
        } catch (error) {
          filterController?.setError(error instanceof Error ? error.message : 'Invalid filter.');
        }
      },
      onSearch: (query: string) => {
        state.queryText = query;
        if (debounce !== undefined) clearTimeout(debounce);
        debounce = window.setTimeout(() => watchQuery(), 180);
      },
    });
    filterController.el.classList.add('trk-filter-host');
    const search = filterController.el.querySelector<HTMLInputElement>('.trk-filter-input');
    if (search) search.value = state.queryText;
    const table = h('div', { class: `trk-list-grid trk-density-${state.density}`, role: 'grid', 'aria-label': state.tab === 'my' ? 'My issues' : 'All issues' });
    const skeleton = h('div', { class: 'trk-skeleton-list', hidden: true, 'aria-hidden': 'true' }, ...Array.from({ length: 8 }, () => h('div', { class: 'trk-skeleton-row' }, h('i'), h('i'), h('i'), h('i'))));
    const error = h('div', { class: 'trk-list-error', role: 'alert', hidden: true });
    const host = h('div', { class: 'trk-list-host' }, error, skeleton, table);
    listRenderHost = table;
    resultsHost = count;
    skeletonHost = skeleton;
    errorHost = error;
    groupButton.addEventListener('click', () => renderMenu(groupButton, 'Group issues by', GROUPS.map((item) => ({ value: item.value, label: item.label })), state.group, (value) => {
      state.group = value as ListGroupBy;
      groupButton.textContent = `Group: ${GROUPS.find((item) => item.value === state.group)?.label}`;
      watchQuery();
    }));
    sortButton.addEventListener('click', () => renderMenu(sortButton, 'Sort issues by', SORTS.map((item) => ({ value: item.value, label: item.label })), state.sort.field, (value) => {
      state.sort = { field: value as TrackerSortField, direction: state.sort.direction === 'asc' ? 'desc' : 'asc' };
      if (state.tab === 'my') state.mySort = { ...state.sort };
      else state.allSort = { ...state.sort };
      sortButton.textContent = `Sort: ${sortLabel()}`;
      watchQuery();
    }));
    displayButton.addEventListener('click', () => {
      const panel = h('div', { class: 'trk-display-menu' }, h('strong', null, 'Density'));
      for (const density of ['comfortable', 'compact'] as const) panel.appendChild(h('button', { class: 'trk-display-option', type: 'button', 'aria-pressed': String(state.density === density), onclick: () => { state.density = density; table.className = `trk-list-grid trk-density-${density}`; closePopover(); } }, density[0].toUpperCase() + density.slice(1)));
      panel.appendChild(h('strong', null, 'Columns'));
      for (const column of OPTIONAL_COLUMNS) {
        const checkbox = h('input', { type: 'checkbox', checked: state.columns.has(column), 'aria-label': `${column} column`, onchange: () => { if (checkbox.checked) state.columns.add(column); else state.columns.delete(column); drawRows(currentCache); } });
        panel.appendChild(h('label', { class: 'trk-display-check' }, checkbox, column[0].toUpperCase() + column.slice(1)));
      }
      popover(displayButton, panel, { className: 'trk trk-pop trk-display-pop', label: 'Display issues' });
    });
    const updateSelectionBar = () => {
      const selectionCount = state.selectedKeys.length;
      selectionBar.hidden = selectionCount === 0;
      viewBar.hidden = selectionCount > 0;
      if (!selectionCount) return;
      selectionBar.replaceChildren(h('strong', null, `${selectionCount} selected`),
        ...(['state', 'assignee', 'priority', 'labels', 'due'] as const).map((field) => {
          const b = h('button', { class: 'trk-small-button', type: 'button' }, field[0].toUpperCase() + field.slice(1));
          b.addEventListener('click', () => bulkPicker(b, field));
          return b;
        }),
        h('button', { class: 'trk-small-button', type: 'button', onclick: () => void doBulk({ archived: true }) }, 'Archive'),
        h('button', { class: 'trk-small-button', type: 'button', onclick: () => { state.selectedKeys = []; drawRows(currentCache); updateSelectionBar(); } }, 'Clear selection'),
      );
    };
    listRenderHost.addEventListener('click', () => updateSelectionBar());
    const viewBarHost = h('div', { class: 'trk-list-tools' }, selectionBar, viewBar);
    const subtabBar = state.tab === 'my' ? h('div', { class: 'trk-my-subtabs', role: 'tablist', 'aria-label': 'My issue views' },
      ...([['active', 'Active'], ['created', 'Created by me']] as const).map(([key, label]) => h('button', {
        class: `trk-my-subtab${state.mySubtab === key ? ' active' : ''}`, type: 'button', role: 'tab',
        'aria-selected': String(state.mySubtab === key), onclick: () => setMySubtab(key),
      }, label)),
    ) : null;
    const tab = h('section', { class: `trk-all-issues${state.tab === 'my' ? ' trk-my-issues' : ''}` }, subtabBar, viewBarHost, filterController.el, host);
    return { tab, updateSelectionBar };
  };

  let updateSelectionBar = () => {};
  const openCreate = (defaultState?: string) => {
    const info = getMeta();
    if (!info || readOnly) return;
    openNewIssueDialog({ store: options.store, meta: info, viewerId: options.viewerId, trackerId: options.trackerId,
      defaultState: defaultState ?? (state.group === 'state' ? state.cursorKey ? options.store.list(stableQuery(state)).tickets.find((item) => item.key === state.cursorKey)?.state.key : undefined : undefined),
      offline: typeof navigator !== 'undefined' && navigator.onLine === false,
      onCreated: (key) => { options.onCreated?.(key); startWatch(); announce(`${key} created`); },
    });
  };

  function openTicket(key: string) {
    setTicket(key);
  }

  const ticketPageHost = (mode: 'page' | 'peek', key: string) => {
    const host = h('div', { class: 'trk-ticket-page-host' });
    ticketPageController = mountTicketPage(host, {
      store: options.store, key, mode,
      onClose: () => setTicket(null),
      onNavigate: (next) => setTicket(next),
      me: getMeta()?.me ?? { userId: options.viewerId, canWrite: !readOnly },
    });
    return host;
  };

  const renderTicket = () => {
    const key = state.ticketKey!;
    const canPeek = (state.tab === 'all' || state.tab === 'my') && fullScreen && layoutWidth > 1100;
    if (!canPeek) stopList?.();
    const cached = options.store.list(stableQuery(state)).tickets.find((ticket) => ticket.key === state.ticketKey);
    const ticketState = options.store.ticket(key);
    const ticket = cached ?? ticketState.ticket;
    if (!ticket && !ticketError) void options.store.loadTicket(key, true).then((detail) => {
      if (state.ticketKey === detail.ticket.key) renderPage();
    }).catch(() => { ticketError = `${state.ticketKey} doesn't exist, or you don't have access.`; renderPage(); });
    if (ticketError) {
      content.replaceChildren(h('section', { class: 'trk-ticket-stub' }, h('h1', null, ticketError), h('button', { class: 'trk-small-button', type: 'button', onclick: () => setTicket(null) }, 'Go to All issues')));
      return;
    }
    if (!ticket) {
      content.replaceChildren(h('section', { class: 'trk-ticket-loading', role: 'status' }, `Loading ${key}…`));
      return;
    }
    if (canPeek) {
      const all = makeAllIssues();
      const page = ticketPageHost('peek', ticket.key);
      content.replaceChildren(h('div', { class: 'trk-peek-layout' },
        h('div', { class: 'trk-peek-list' }, all.tab),
        h('aside', { class: 'trk-peek-panel', 'aria-label': `Ticket ${ticket.key}` }, page),
      ));
      startWatch();
      all.updateSelectionBar();
      drawRows(currentCache);
      return;
    }
    content.replaceChildren(ticketPageHost('page', ticket.key));
  };

  const boardStates = () => (getMeta()?.states ?? []).filter((item) => item.category !== 'canceled').slice().sort((a, b) => a.position - b.position);
  const boardQuery = (item: TrackerState): TrackerListQuery => ({ filter: [`state:${item.key}`], limit: 50 });
  const refreshBoard = async () => {
    const queries = [...boardCaches.values()].map((entry) => entry.query);
    await Promise.all(queries.map((query) => options.store.loadList(query, { force: true })));
  };
  const moveBoardTicket = async (ticket: TrackerTicket, stateKey: string, anchor?: HTMLElement) => {
    if (readOnly || ticket.state.key === stateKey) return;
    const previous = ticket.state.key;
    try {
      const moved = await options.store.transitionTicket(ticket.key, stateKey);
      await refreshBoard();
      recordUndo('State changed', async () => {
        await options.store.transitionTicket(ticket.key, previous);
        await refreshBoard();
      });
      announce(`${moved.key} moved to ${moved.state.name}`);
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'The issue could not be moved.');
      if (anchor) anchor.focus({ preventScroll: true });
    }
  };
  const moveBoardByStep = (ticket: TrackerTicket, direction: -1 | 1, anchor?: HTMLElement) => {
    const lanes = boardStates();
    const at = lanes.findIndex((item) => item.key === ticket.state.key);
    const target = lanes[at + direction];
    if (target) void moveBoardTicket(ticket, target.key, anchor);
  };
  const renderBoardContents = () => {
    if (!boardLaneStrip || !boardLanesHost || !meta) return;
    const lanes = boardStates();
    const phone = layoutWidth <= 600 || (typeof window !== 'undefined' && window.innerWidth <= 600);
    if (!lanes.some((item) => item.key === boardLaneKey)) boardLaneKey = lanes[0]?.key ?? null;
    const countFor = (item: TrackerState) => boardCaches.get(item.key)?.cache.tickets.length ?? 0;
    boardLaneStrip.hidden = !phone;
    boardLaneStrip.replaceChildren(...(phone ? lanes.map((item) => h('button', {
      class: `trk-board-state-tab${item.key === boardLaneKey ? ' active' : ''}`, type: 'button', role: 'tab',
      'aria-selected': String(item.key === boardLaneKey), 'aria-label': `${item.name}, ${countFor(item)} issues`,
      onclick: () => { boardLaneKey = item.key; renderBoardContents(); },
    }, stateGlyph(item.category, item.key), h('span', null, item.name), h('span', { class: 'trk-board-lane-count' }, String(countFor(item))))) : []));
    const visibleLanes = phone ? lanes.filter((item) => item.key === boardLaneKey) : lanes;
    boardLanesHost.classList.toggle('is-phone-lane', phone);
    boardLanesHost.replaceChildren(...visibleLanes.map((item) => {
      const entry = boardCaches.get(item.key);
      const cache = entry?.cache ?? options.store.list(boardQuery(item));
      const count = `${cache.tickets.length}${cache.nextCursor ? '+' : ''}`;
      const normalized = cache.tickets.map((row) => ticketFromListRow(row as unknown as TrackerRow, meta!, options.trackerId));
      const sortedRows = buildListModel({
        pages: [normalized as unknown as TrackerRow[]], group: 'none', sort: { field: 'priority', direction: 'asc' },
      }).visibleRows;
      const tickets = sortedRows.map((row) => ticketFromListRow(row, meta!, options.trackerId));
      const header = h('header', { class: 'trk-board-lane-header' },
        stateGlyph(item.category, item.key), h('h2', null, item.name), h('span', { class: 'trk-board-lane-count' }, count),
        readOnly ? null : h('button', {
          class: 'trk-board-add', type: 'button', 'aria-label': `New issue in ${item.name}`,
          onclick: () => openCreate(item.key),
        }, '+'),
      );
      const cards = tickets.map((ticket) => {
        const moveButton = h('button', {
          class: 'trk-board-move', type: 'button', 'aria-label': `Move ${ticket.key} to…`,
          onclick: async (event: Event) => {
            event.stopPropagation();
            const anchor = event.currentTarget as HTMLElement;
            const picked = await openPicker<string>(anchor, {
              label: `Move ${ticket.key} to`, options: meta!.states.map((stateOption) => ({ value: stateOption.key, label: stateOption.name })), value: ticket.state.key,
            });
            if (typeof picked === 'string') void moveBoardTicket(ticket, picked, anchor);
          },
        }, 'Move to…');
        const labels = ticket.labels.slice(0, 2).map((label) => labelChip(label.name, label.color));
        if (ticket.labels.length > 2) labels.push(h('span', { class: 'trk-board-label-count' }, `+${ticket.labels.length - 2}`));
        const card = h('article', {
          class: 'trk-board-card', tabindex: '0', 'data-key': ticket.key,
          'aria-label': `${ticket.key}: ${ticket.title}`,
          onclick: (event: Event) => { if (!(event.target as HTMLElement | null)?.closest('button')) openTicket(ticket.key); },
          onkeydown: (event: KeyboardEvent) => {
            if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); moveBoardByStep(ticket, -1, event.currentTarget as HTMLElement); }
            else if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); moveBoardByStep(ticket, 1, event.currentTarget as HTMLElement); }
            else if ((event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) { event.preventDefault(); openTicket(ticket.key); }
          },
        },
          h('div', { class: 'trk-board-card-top' }, keyChip(ticket.key), moveButton),
          h('button', { class: 'trk-board-card-title', type: 'button', onclick: (event: Event) => { event.stopPropagation(); openTicket(ticket.key); } }, ticket.title),
          h('div', { class: 'trk-board-card-meta' },
            h('span', { class: 'trk-board-priority', 'aria-label': priorityLabel(ticket.priority) }, priorityGlyph(ticket.priority)),
            ticket.assignee ? avatar({ kind: 'person', name: ticket.assignee.name }) : null,
            dueChip(ticket.due, Date.now()),
          ),
          labels.length ? h('div', { class: 'trk-board-labels' }, ...labels) : null,
        );
        return card;
      });
      const laneBody = h('div', { class: 'trk-board-lane-cards' }, ...cards,
        cache.nextCursor ? h('button', {
          class: 'trk-load-more', type: 'button', disabled: cache.loadingMore,
          onclick: () => void options.store.loadMore(entry?.query ?? boardQuery(item)).catch((error: unknown) => showBoardError(error instanceof Error ? error.message : 'Could not load more issues.', entry?.query ?? boardQuery(item))),
        }, cache.loadingMore ? 'Loading…' : 'Load more') : null,
      );
      return h('section', { class: 'trk-board-lane', 'data-state': item.key, 'aria-label': `${item.name}, ${cache.tickets.length} issues` }, header, laneBody);
    }));
    if (boardErrorHost) {
      const entry = [...boardCaches.values()].find((value) => value.cache.error);
      boardErrorHost.hidden = !entry?.cache.error;
      if (entry?.cache.error) {
        boardErrorHost.replaceChildren(h('span', null, entry.cache.error.message), h('button', {
          class: 'trk-small-button', type: 'button', onclick: () => void options.store.loadList(entry.query, { force: true }).catch((error: unknown) =>
            showBoardError(error instanceof Error ? error.message : 'Could not load board issues.', entry.query)),
        }, 'Retry'));
      } else boardErrorHost.replaceChildren();
    }
  };
  const startBoardWatch = () => {
    stopList?.();
    stopBoardWatch();
    if (state.tab !== 'board' || !meta) return;
    for (const item of boardStates()) {
      const query = boardQuery(item);
      boardCaches.set(item.key, { state: item, query, cache: options.store.list(query) });
      stopBoard.push(options.store.watchList(query, (cache) => {
        boardCaches.set(item.key, { state: item, query, cache });
        try { renderBoardContents(); }
        catch (error) { showBoardError(error instanceof Error ? error.message : 'Could not render board issues.', query); }
      }));
    }
    renderBoardContents();
  };
  const renderBoardPage = () => {
    boardErrorHost = h('div', { class: 'trk-board-error', role: 'alert', hidden: true });
    boardLaneStrip = h('nav', { class: 'trk-board-state-strip', role: 'tablist', 'aria-label': 'Board states' });
    boardLanesHost = h('div', { class: 'trk-board-lanes' });
    const board = h('section', { class: 'trk-board-view', 'aria-label': 'Tracker board' },
      h('header', { class: 'trk-board-viewbar' }, h('strong', null, 'Board')),
      boardErrorHost, boardLaneStrip, boardLanesHost,
    );
    content.replaceChildren(board);
    startBoardWatch();
  };

  function renderPage() {
    if (destroyed) return;
    stopBoardWatch();
    destroyInbox();
    destroyTicketPage();
    renderTabs();
    updateActions();
    if (state.ticketKey) { renderTicket(); return; }
    if (state.tab === 'all' || state.tab === 'my') {
      const all = makeAllIssues();
      updateSelectionBar = all.updateSelectionBar;
      content.replaceChildren(all.tab);
      startWatch();
      all.updateSelectionBar();
      drawRows(currentCache);
      return;
    }
    stopList?.();
    listRenderHost = null;
    filterController = null;
    if (state.tab === 'inbox') {
      const host = h('div', { class: 'trk-inbox-host' });
      content.replaceChildren(host);
      inboxController = mountInbox(host, {
        api: options.api,
        onOpenTicket: (key) => openTicket(key),
        onUnreadChange: (count) => {
          unreadCount = Math.max(0, Math.floor(count));
          renderTabs();
        },
      });
      publishCurrentSnapshot();
      return;
    }
    if (state.tab === 'board') {
      renderBoardPage();
      publishCurrentSnapshot();
      return;
    }
    content.replaceChildren(h('section', { class: 'trk-coming-next trk-projects-empty' }, h('h1', null, 'Projects are coming next.')));
    publishCurrentSnapshot();
  }

  function watchQuery() {
    if ((state.tab !== 'all' && state.tab !== 'my') || (state.ticketKey && !(fullScreen && layoutWidth > 1100)) || destroyed) return;
    startWatch();
  }

  function setFullscreen(value: boolean) {
    fullScreen = value;
    if (value) layoutWidth = window.innerWidth;
    else if (options.layoutWidth !== undefined) layoutWidth = options.layoutWidth;
    root.dataset.fullscreen = String(value);
    fullscreenStrip.hidden = !value;
    fullscreenButton.textContent = value ? '↙' : '↗';
    fullscreenButton.setAttribute('aria-label', value ? 'Back to board' : 'Open full screen');
    renderPage();
    options.onFullscreenChange?.(value);
  }

  function setTicket(key: string | null) {
    state.ticketKey = key;
    ticketError = '';
    options.onTicketChange?.(key);
    renderPage();
  }

  const openCommand = () => {
    const items = buildCommandItems();
    openCommandBox(commandButton, {
      items,
      searchTickets: async (query): Promise<CommandItem[]> => {
        const cache = await options.store.loadList({ q: query, limit: 10 });
        return cache.tickets.map((ticket) => ({ id: `ticket:${ticket.key}`, kind: 'ticket', label: `${ticket.key} ${ticket.title}`, key: ticket.key, hint: ticket.state.name, snippet: ticket.snippet }));
      },
      onSelect: (item) => {
        if (item.kind === 'tab') switchTab(item.id.slice(4) as TrackerView);
        else if (item.kind === 'ticket' && item.key) openTicket(item.key);
      },
    });
  };

  const showShortcuts = () => {
    const body = h('div', { class: 'trk-shortcuts' }, ...SHORTCUTS.map((row) => h('div', { class: 'trk-shortcut-row' }, h('kbd', null, row.keys), h('span', null, row.description))));
    dialog('Keyboard shortcuts', body, [], { className: 'trk-shortcuts-back' });
  };

  const dispatch = (action: TrackerAction) => {
    if (action.type === 'sequence-pending') pendingSequence = { key: action.key, expiresAt: action.expiresAt };
    else if (action.type === 'switch-tab') switchTab(action.tab);
    else if (action.type === 'command-box') openCommand();
    else if (action.type === 'create') openCreate();
    else if (action.type === 'expand') setFullscreen(!fullScreen);
    else if (action.type === 'open-filter') filterController?.open();
    else if (action.type === 'focus-search') filterController?.focusSearch();
    else if (action.type === 'shortcut-sheet') showShortcuts();
    else if (action.type === 'move-cursor' && listModel) {
      listModel = moveCursor(listModel, action.delta);
      if (action.extend && listModel.cursorKey) listModel = extendSelection(listModel, listModel.cursorKey);
      state.cursorKey = listModel.cursorKey; state.selectedKeys = listModel.selectedKeys; state.anchorKey = listModel.anchorKey;
      drawRows(currentCache); updateSelectionBar();
      const row = root.querySelector<HTMLElement>(`[data-key="${CSS.escape(state.cursorKey ?? '')}"]`);
      row?.scrollIntoView({ block: 'nearest' });
      row?.focus({ preventScroll: true });
      const ticket = listModel.visibleRows.find((item) => item.key === state.cursorKey);
      announce(ticket ? `${ticket.key}, ${ticket.title}` : 'No issue selected');
    } else if (action.type === 'move-to-edge' && listModel?.visibleRows.length) {
      const row = action.edge === 'first' ? listModel.visibleRows[0] : listModel.visibleRows.at(-1)!;
      state.cursorKey = row.key; listModel = moveCursorTo(listModel, row.key); drawRows(currentCache);
    } else if (action.type === 'page') {
      if (action.direction > 0) void options.store.loadMore(stableQuery(state)).catch((error: unknown) => showListError(error instanceof Error ? error.message : 'Could not load more issues.'));
      else listRenderHost?.scrollTo({ top: 0 });
    } else if (action.type === 'toggle-selection' && listModel) {
      listModel = toggleSelection(listModel); state.selectedKeys = listModel.selectedKeys; state.anchorKey = listModel.anchorKey;
      updateSelectionBar(); drawRows(currentCache); announce(`${state.selectedKeys.length} selected`);
    } else if (action.type === 'select-all' && listModel) {
      listModel = selectAll(listModel); state.selectedKeys = listModel.selectedKeys; state.anchorKey = listModel.anchorKey;
      updateSelectionBar(); drawRows(currentCache); announce(`${state.selectedKeys.length} selected`);
    } else if (action.type === 'group' && listModel && listModel.groups.length) {
      const group = listModel.groups.find((candidate) => candidate.rows.some((row) => row.key === state.cursorKey)) ?? listModel.groups[0];
      if (group) {
        state.collapsedGroups = new Set(state.collapsedGroups);
        if (action.direction < 0) state.collapsedGroups.add(group.id);
        else state.collapsedGroups.delete(group.id);
        drawRows(currentCache);
      }
    } else if ((action.type === 'open-ticket' || action.type === 'peek') && state.cursorKey) openTicket(state.cursorKey);
    else if ((action.type === 'copy-link' || action.type === 'copy-key') && state.cursorKey) {
      const path = buildTrackerPath({ kind: 'ticket', key: state.cursorKey });
      const value = action.type === 'copy-key' ? state.cursorKey : `${location.origin}${path ?? '/t/' + encodeURIComponent(state.cursorKey)}`;
      const clipboard = navigator.clipboard;
      if (!clipboard) toast('Clipboard access is not available.');
      else void clipboard.writeText(value).then(() => toast(action.type === 'copy-key' ? 'Ticket key copied' : 'Ticket link copied'))
        .catch(() => toast('Could not copy the ticket link.'));
    }
    else if (action.type === 'open-picker' && listModel && state.cursorKey) {
      const ticket = currentCache.tickets.find((item) => item.key === state.cursorKey);
      const anchor = root.querySelector<HTMLElement>(`[data-key="${CSS.escape(state.cursorKey)}"]`);
      if (ticket && anchor) void editOne(ticket, action.field, anchor);
    } else if (action.type === 'archive') {
      if (!state.selectedKeys.length && state.cursorKey) state.selectedKeys = [state.cursorKey];
      void doBulk({ archived: true });
    }
    else if (action.type === 'undo' && lastUndoAction) void runUndo();
    else if (action.type === 'redo') toast('Redo is not available yet.');
    else if (action.type === 'escape') {
      const layer = action.layer;
      if (layer === 'picker') closePopover();
      else if (layer === 'filter') filterController?.close();
      else if (layer === 'ticket') setTicket(null);
      else if (layer === 'fullscreen') setFullscreen(false);
      else if (layer === 'work') options.onWorkExit?.();
    }
  };

  const onKey = (event: KeyboardEvent) => {
    if (!active()) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('[role="dialog"][aria-modal="true"]')) return;
    if (!fullScreen && !root.contains(target) && !target?.closest('.trk-pop')) return;
    if (state.tab === 'my' && !isTextTarget(event.target) && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (event.key === '[' || event.key === ']')) {
      event.preventDefault();
      setMySubtab(event.key === '[' ? 'active' : 'created');
      return;
    }
    const layers: KeyboardLayer[] = [];
    if (!fullScreen) layers.push('work');
    if (fullScreen) layers.push('fullscreen');
    if (state.ticketKey) layers.push('ticket');
    if (filterController?.suggestionsOpen()) layers.push('filter');
    if (document.querySelector('.trk-pop')) layers.push('picker');
    const focusOwner = isTextTarget(event.target) ? 'text' : target?.closest('.trk-pop') ? 'picker' : 'tracker';
    const resolved = resolveKey({ active: true, focusOwner, pickerOpen: document.querySelector('.trk-pop') !== null, layers, pendingSequence }, event);
    pendingSequence = resolved.pendingSequence ?? null;
    if (resolved.action) dispatch(resolved.action);
  };
  document.addEventListener('keydown', onKey, true);
  stopKeyListener = () => document.removeEventListener('keydown', onKey, true);

  commandButton.addEventListener('click', openCommand);
  newButton.addEventListener('click', () => openCreate());
  fullscreenButton.addEventListener('click', () => setFullscreen(!fullScreen));
  stopStore = options.store.subscribe((snapshot) => {
    meta = snapshot.meta ?? meta;
    if (snapshot.metaError) showError(snapshot.metaError.message);
    updateActions();
    if (snapshot.meta && (state.tab === 'all' || state.tab === 'my') && !state.ticketKey && !stopList) startWatch();
    if (snapshot.meta && state.tab === 'board' && !state.ticketKey && stopBoard.length === 0) startBoardWatch();
    if (!snapshot.metaLoading && !meta && !snapshot.metaError) showError('Tracker information could not be loaded.');
  });
  const onOnline = () => updateActions();
  const onWindowResize = () => {
    if (!fullScreen) return;
    layoutWidth = window.innerWidth;
    if (state.ticketKey) renderPage();
    else if (state.tab === 'board') renderBoardContents();
    else { renderTabs(); drawRows(currentCache); }
  };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOnline);
  window.addEventListener('resize', onWindowResize);
  void options.store.loadMeta().then((loaded) => {
    meta = loaded;
    updateActions();
    if (state.tab === 'all' || state.tab === 'my') startWatch();
    else if (state.tab === 'board') startBoardWatch();
  }).catch((error: unknown) => showError(error instanceof Error ? error.message : 'Could not load tracker information.'));
  renderPage();

  return {
    el: root,
    focus() { root.focus({ preventScroll: true }); },
    setFullscreen,
    setTicket,
    updateLayout(width) { layoutWidth = width; if (state.ticketKey) renderPage(); else if (state.tab === 'board') renderBoardContents(); else { renderTabs(); drawRows(currentCache); } },
    state,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopList?.(); stopBoardWatch(); stopStore?.(); stopKeyListener?.();
      destroyInbox(); destroyTicketPage();
      if (debounce !== undefined) clearTimeout(debounce);
      window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOnline);
      window.removeEventListener('resize', onWindowResize);
      root.remove();
    },
  };
}
