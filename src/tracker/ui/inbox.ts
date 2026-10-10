import type { TrackerApi } from '../../tracker-data';
import type { TrackerInboxItem } from '../../tracker-types';
import { h } from '../../ui/dom';
import { priorityGlyph, stateGlyph } from './glyphs';
import {
  clearInboxSelection, createInboxSelection, groupByDay, moveInboxCursor, moveInboxCursorToEdge,
  reasonLine, reconcileInboxSelection, selectAllInbox, toggleInboxSelection,
  type InboxSelectionModel,
} from './inbox-model';
import { keyChip, relativeTime } from './primitives';
import { mountNotificationPrefs, type NotificationPrefsController } from './notification-prefs';
import './inbox.css';

export interface InboxDependencies {
  api: TrackerApi;
  onOpenTicket(key: string): void;
  onUnreadChange(n: number): void;
  now?: () => number;
}

export interface InboxController {
  refresh(): Promise<void>;
  focus(): void;
  destroy(): void;
}

let inboxInstance = 0;

/** Mounts the personal notification inbox into a tracker-owned host. */
export function mountInbox(host: HTMLElement, deps: InboxDependencies): InboxController {
  const instance = ++inboxInstance;
  const now = deps.now ?? Date.now;
  const root = h('section', { class: 'trk trk-inbox', 'aria-label': 'Inbox' });
  const heading = h('h1', { class: 'trk-inbox-title' }, 'Inbox');
  const markAll = h('button', { class: 'trk-inbox-button', type: 'button', onclick: () => { void markRead([], true, false); } }, 'Mark all read');
  const showReadButton = h('button', {
    class: 'trk-inbox-button trk-inbox-show-read', type: 'button', 'aria-pressed': 'false',
    onclick: () => toggleReadRows(),
  }, 'Show read');
  const prefsButton = h('button', {
    class: 'trk-inbox-button', type: 'button', 'aria-expanded': 'false', 'aria-controls': `trk-inbox-prefs-${instance}`,
    onclick: () => togglePrefs(),
  }, 'Notification settings');
  const header = h('header', { class: 'trk-inbox-header' }, heading,
    h('div', { class: 'trk-inbox-actions' }, markAll, showReadButton, prefsButton),
  );
  const offlineLine = h('p', { class: 'trk-inbox-offline', role: 'status', hidden: true }, 'You are offline. Showing what was loaded.');
  const prefsHost = h('div', { class: 'trk-inbox-prefs', id: `trk-inbox-prefs-${instance}`, hidden: true });
  const list = h('div', {
    class: 'trk-inbox-list', role: 'listbox', 'aria-label': 'Inbox notices', 'aria-multiselectable': 'true', tabindex: '0',
    onkeydown: (event: KeyboardEvent) => handleKeydown(event),
  });
  const emptyState = h('div', { class: 'trk-inbox-empty', hidden: true },
    h('h2', { class: 'trk-inbox-empty-title' }, 'Nothing needs you.'),
    h('p', { class: 'trk-inbox-empty-copy' }, 'Tickets that are assigned to you or mention you land here.'),
  );
  const live = h('div', { class: 'trk-inbox-sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const loadError = h('div', { class: 'trk-inbox-error', role: 'alert', hidden: true });
  const markError = h('div', { class: 'trk-inbox-action-error', role: 'alert', hidden: true });
  const loadMore = h('button', { class: 'trk-inbox-load-more', type: 'button', hidden: true, onclick: () => { void loadNextPage(); } }, 'Load more');
  root.append(header, offlineLine, prefsHost, markError, loadError, list, emptyState, loadMore, live);
  host.replaceChildren(root);

  let showRead = false;
  let prefsOpen = false;
  let prefsController: NotificationPrefsController | null = null;
  let items: TrackerInboxItem[] = [];
  let nextCursor: string | null = null;
  let loadedOnce = false;
  let loading = false;
  let loadingMore = false;
  let loadErrorKind: 'first' | 'more' | null = null;
  let unreadCount: number | null = null;
  let marking = false;
  let markFailure: { ids: string[]; all: boolean } | null = null;
  let selection: InboxSelectionModel = createInboxSelection();
  let destroyed = false;
  let firstController: AbortController | null = null;
  let moreController: AbortController | null = null;
  const markControllers = new Set<AbortController>();

  function isOnline(): boolean { return typeof navigator === 'undefined' || navigator.onLine !== false; }
  function visibleItems(): TrackerInboxItem[] { return showRead ? items : items.filter((item) => item.readAt === null); }
  function focusCursor(): void {
    const row = Array.from(list.querySelectorAll<HTMLElement>('[role="option"]')).find((option) => option.dataset.inboxId === selection.cursor);
    (row ?? list).focus();
  }

  function setUnreadCount(value: number): void {
    unreadCount = value;
    markAll.disabled = marking || value === 0;
  }

  function renderRow(item: TrackerInboxItem): HTMLElement {
    const unread = item.readAt === null;
    const timestamp = new Date(item.createdAt).toISOString();
    const selected = selection.selected.has(item.id);
    const row = h('div', {
      class: `trk-inbox-row${unread ? ' is-unread' : ' is-read'}`,
      role: 'option', 'aria-selected': String(selected),
      tabindex: selection.cursor === item.id ? '0' : '-1',
      'data-inbox-id': item.id,
      id: `trk-inbox-${instance}-row-${items.findIndex((candidate) => candidate.id === item.id)}`,
      onclick: () => {
        selection = { ...selection, cursor: item.id };
        renderList(true);
        openItem(item);
      },
    },
    h('span', { class: 'trk-inbox-unread-dot', 'aria-hidden': unread ? undefined : 'true' }, unread ? h('span', { class: 'trk-inbox-sr-only' }, 'Unread') : null),
    keyChip(item.ticket.key),
    stateGlyph(item.ticket.state.category, item.ticket.state.name),
    h('div', { class: 'trk-inbox-copy' },
      h('span', { class: 'trk-inbox-row-title' }, item.ticket.title),
      h('span', { class: 'trk-inbox-reason' }, reasonLine(item)),
    ),
    item.ticket.priority === 'urgent' || item.ticket.priority === 'high' ? priorityGlyph(item.ticket.priority) : null,
    relativeTime(now(), timestamp),
    );
    return row;
  }

  function renderSkeleton(): HTMLElement[] {
    return Array.from({ length: 3 }, () => h('div', { class: 'trk-inbox-skeleton-row', 'aria-hidden': 'true' },
      h('span', null), h('span', null), h('span', null), h('span', null),
    ));
  }

  function renderList(restoreFocus = false): void {
    if (destroyed) return;
    const priorId = (document.activeElement as HTMLElement | null)?.dataset?.inboxId;
    const rows = visibleItems();
    selection = reconcileInboxSelection(selection, rows.map((item) => item.id));
    const waiting = loading || loadingMore;
    list.setAttribute('aria-busy', String(waiting));
    list.setAttribute('tabindex', rows.length ? '-1' : '0');
    if (!loadedOnce && loading && !rows.length) {
      list.replaceChildren(...renderSkeleton());
    } else {
      const groups = groupByDay(rows, now(), -new Date(now()).getTimezoneOffset());
      list.replaceChildren(...groups.map((group) => h('section', {
        class: 'trk-inbox-day', role: 'group', 'aria-label': group.label,
      },
      h('h2', { class: 'trk-inbox-day-title' }, group.label),
      ...group.items.map(renderRow),
      )));
    }
    emptyState.hidden = !loadedOnce || loading || rows.length > 0 || loadErrorKind === 'first';
    if (loadErrorKind) {
      loadError.hidden = false;
      loadError.replaceChildren(
        h('span', null, loadErrorKind === 'more' ? 'Could not load more notices.' : 'Could not load your inbox.'),
        h('button', { class: 'trk-inbox-retry', type: 'button', onclick: () => {
          if (loadErrorKind === 'more') void loadNextPage(); else void refresh();
        } }, 'Retry'),
      );
    } else {
      loadError.hidden = true;
      loadError.replaceChildren();
    }
    loadMore.hidden = !nextCursor || loadingMore || loadErrorKind === 'more';
    loadMore.disabled = loadingMore;
    loadMore.textContent = 'Load more';
    showReadButton.textContent = showRead ? 'Hide read' : 'Show read';
    showReadButton.setAttribute('aria-pressed', String(showRead));
    showReadButton.setAttribute('aria-label', showRead ? 'Hide read notices' : 'Show read notices');
    offlineLine.hidden = isOnline();
    markAll.disabled = marking || unreadCount === 0;
    if (restoreFocus && (priorId || selection.cursor)) focusCursor();
  }

  function announce(text: string): void { live.textContent = text; }

  function togglePrefs(): void {
    prefsOpen = !prefsOpen;
    prefsHost.hidden = !prefsOpen;
    prefsButton.setAttribute('aria-expanded', String(prefsOpen));
    if (prefsOpen && !prefsController) prefsController = mountNotificationPrefs(prefsHost, {
      api: deps.api,
      announce,
    });
  }

  function toggleReadRows(): void {
    showRead = !showRead;
    items = [];
    nextCursor = null;
    loadedOnce = false;
    loadErrorKind = null;
    selection = createInboxSelection();
    void refresh();
  }

  function compareItems(a: TrackerInboxItem, b: TrackerInboxItem): number {
    return b.createdAt - a.createdAt || b.id.localeCompare(a.id);
  }

  async function refresh(): Promise<void> {
    if (destroyed) return;
    firstController?.abort();
    moreController?.abort();
    moreController = null;
    loadingMore = false;
    const controller = new AbortController();
    firstController = controller;
    const oldItems = items;
    loading = true;
    loadErrorKind = null;
    renderList();
    try {
      const page = await deps.api.inbox({ limit: 30, unread: !showRead }, { signal: controller.signal });
      if (destroyed || controller.signal.aborted) return;
      const merged = new Map<string, TrackerInboxItem>(oldItems.map((item) => [item.id, item]));
      for (const item of page.items) merged.set(item.id, item);
      items = [...merged.values()].sort(compareItems);
      nextCursor = page.nextCursor;
      loadedOnce = true;
      loading = false;
      loadErrorKind = null;
      setUnreadCount(page.unread);
      deps.onUnreadChange(page.unread);
      renderList(true);
    } catch {
      if (destroyed || controller.signal.aborted) return;
      loading = false;
      loadedOnce = true;
      loadErrorKind = 'first';
      renderList();
    } finally {
      if (firstController === controller) firstController = null;
    }
  }

  async function loadNextPage(): Promise<void> {
    if (destroyed || loadingMore || !nextCursor) return;
    firstController?.abort();
    const cursor = nextCursor;
    const controller = new AbortController();
    moreController = controller;
    loadingMore = true;
    loadErrorKind = null;
    renderList();
    try {
      const page = await deps.api.inbox({ limit: 30, before: cursor, unread: !showRead }, { signal: controller.signal });
      if (destroyed || controller.signal.aborted) return;
      const merged = new Map(items.map((item) => [item.id, item]));
      for (const item of page.items) merged.set(item.id, item);
      items = [...merged.values()].sort(compareItems);
      nextCursor = page.nextCursor;
      loadingMore = false;
      loadErrorKind = null;
      setUnreadCount(page.unread);
      deps.onUnreadChange(page.unread);
      renderList(true);
    } catch {
      if (destroyed || controller.signal.aborted) return;
      loadingMore = false;
      loadErrorKind = 'more';
      renderList();
    } finally {
      if (moreController === controller) moreController = null;
    }
  }

  async function markRead(ids: string[], all: boolean, keepFocus: boolean): Promise<void> {
    if (destroyed || marking) return;
    const targetIds = all
      ? items.filter((item) => item.readAt === null).map((item) => item.id)
      : ids;
    const unreadIds = new Set(items.filter((item) => targetIds.includes(item.id) && item.readAt === null).map((item) => item.id));
    if (!all && unreadIds.size === 0) return;
    const previousItems = items;
    const previousSelection = { ...selection, ids: [...selection.ids], selected: new Set(selection.selected) };
    const readAt = now();
    if (showRead) {
      items = items.map((item) => unreadIds.has(item.id) ? { ...item, readAt } : item);
    } else {
      items = items.filter((item) => !unreadIds.has(item.id));
      if (all) nextCursor = null;
    }
    selection = reconcileInboxSelection(selection, visibleItems().map((item) => item.id));
    marking = true;
    markFailure = null;
    markError.hidden = true;
    markError.replaceChildren();
    renderList(keepFocus);

    const controller = new AbortController();
    markControllers.add(controller);
    try {
      let result: { updated: number; unread: number };
      if (all) {
        result = await deps.api.markInboxRead({ all: true }, { signal: controller.signal });
      } else {
        const batches: string[][] = [];
        const allIds = [...unreadIds];
        for (let start = 0; start < allIds.length; start += 100) batches.push(allIds.slice(start, start + 100));
        result = { updated: 0, unread: unreadCount ?? 0 };
        for (const batch of batches) {
          result = await deps.api.markInboxRead({ ids: batch }, { signal: controller.signal });
        }
      }
      if (destroyed || controller.signal.aborted) return;
      marking = false;
      markFailure = null;
      setUnreadCount(result.unread);
      deps.onUnreadChange(result.unread);
      const count = unreadIds.size;
      if (all) announce('Marked all notices done');
      else if (count === 1) {
        const marked = previousItems.find((item) => unreadIds.has(item.id));
        announce(`Marked ${marked?.ticket.key ?? 'notice'} done`);
      } else announce(`Marked ${count} notices done`);
      renderList(keepFocus);
    } catch {
      if (destroyed || controller.signal.aborted) return;
      items = previousItems;
      selection = previousSelection;
      marking = false;
      markFailure = { ids: [...ids], all };
      markError.hidden = false;
      markError.replaceChildren(
        h('span', null, 'Could not mark notices done.'),
        h('button', { class: 'trk-inbox-retry', type: 'button', onclick: () => {
          const failure = markFailure;
          if (failure) void markRead(failure.ids, failure.all, keepFocus);
        } }, 'Retry'),
      );
      renderList(keepFocus);
    } finally {
      markControllers.delete(controller);
    }
  }

  function openItem(item: TrackerInboxItem): void {
    deps.onOpenTicket(item.ticket.key);
    if (item.readAt === null) void markRead([item.id], false, true);
  }

  function moveCursor(delta: -1 | 1, extend: boolean): void {
    selection = moveInboxCursor(selection, delta, extend);
    renderList(true);
    if (selection.cursor && selection.cursor === visibleItems().at(-1)?.id && nextCursor) void loadNextPage();
  }

  function handleKeydown(event: KeyboardEvent): void {
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const modified = event.metaKey || event.ctrlKey || event.altKey;
    const handle = (action: () => void) => {
      event.preventDefault();
      event.stopPropagation();
      action();
    };
    if (!modified && (key === 'ArrowDown' || key === 'j') && (!event.shiftKey || key === 'ArrowDown')) {
      handle(() => moveCursor(1, event.shiftKey && key === 'ArrowDown'));
    } else if (!modified && (key === 'ArrowUp' || key === 'k') && (!event.shiftKey || key === 'ArrowUp')) {
      handle(() => moveCursor(-1, event.shiftKey && key === 'ArrowUp'));
    } else if (!modified && (key === 'Home' || key === 'End')) {
      handle(() => {
        selection = moveInboxCursorToEdge(selection, key === 'Home' ? 'first' : 'last', event.shiftKey);
        renderList(true);
        if (key === 'End' && selection.cursor === visibleItems().at(-1)?.id && nextCursor) void loadNextPage();
      });
    } else if (!modified && key === 'Enter') {
      handle(() => {
        const item = items.find((candidate) => candidate.id === selection.cursor);
        if (item) openItem(item);
      });
    } else if (!modified && key === 'e') {
      handle(() => {
        const ids = selection.selected.size ? [...selection.selected] : event.shiftKey ? [] : selection.cursor ? [selection.cursor] : [];
        if (ids.length || !event.shiftKey) void markRead(ids, false, true);
      });
    } else if (!modified && key === 'x') {
      handle(() => {
        selection = toggleInboxSelection(selection);
        renderList(true);
        announce(`${selection.selected.size} selected`);
      });
    } else if (!event.altKey && (event.metaKey || event.ctrlKey) && key === 'a' && !event.shiftKey) {
      handle(() => {
        selection = selectAllInbox(selection);
        renderList(true);
        announce(`${selection.selected.size} selected`);
      });
    } else if (!modified && key === 'Escape' && selection.selected.size > 0) {
      handle(() => {
        selection = clearInboxSelection(selection);
        renderList(true);
        announce('Selection cleared');
      });
    }
  }

  function onOnline(): void {
    renderList();
    void refresh();
  }
  function onOffline(): void { renderList(); }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
  }

  void refresh();
  return {
    refresh,
    focus: focusCursor,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      firstController?.abort();
      moreController?.abort();
      for (const controller of markControllers) controller.abort();
      markControllers.clear();
      prefsController?.destroy();
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
      }
      host.replaceChildren();
    },
  };
}
