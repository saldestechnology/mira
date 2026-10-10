import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockTrackerApi } from '../src/tracker-mock';
import type { TrackerInboxItem, TrackerNotificationKind } from '../src/tracker-types';
import { mountInbox } from '../src/tracker/ui/inbox';
import { FakeElement, control, flush, need, textOf } from './fake-dom';
import { installTrackerUiBrowser, uiEvent } from './tracker-ui-test-helpers';

let uiBrowser: ReturnType<typeof installTrackerUiBrowser> | null = null;
afterEach(() => {
  uiBrowser?.uninstall();
  uiBrowser = null;
  vi.useRealTimers();
});

function inboxNotice(id: string, key: string, createdAt: number, kind: TrackerNotificationKind = 'assigned', readAt: number | null = null): TrackerInboxItem {
  return {
    id, kind, createdAt, readAt,
    ticket: {
      key, title: 'Review the tracker inbox', state: { name: 'In progress', category: 'started' },
      assignee: { name: 'Mara' }, priority: 'high',
    },
    actor: { name: 'Mara' }, preview: null, detail: kind === 'status_changed' ? { state: 'In review' } : null,
  };
}

function inboxFixture(rows: TrackerInboxItem[], now = Date.UTC(2026, 9, 10, 12)) {
  const api = createMockTrackerApi({ inbox: rows, now: () => now });
  const host = uiBrowser!.document.createElement('div') as unknown as HTMLElement;
  uiBrowser!.document.body.appendChild(host as unknown as FakeElement);
  const unread: number[] = [];
  const openedTickets: string[] = [];
  const controller = mountInbox(host, {
    api,
    now: () => now,
    onOpenTicket: (key) => openedTickets.push(key),
    onUnreadChange: (count) => unread.push(count),
  });
  return { api, host: host as unknown as FakeElement, controller, unread, openedTickets };
}


describe('tracker inbox UI', () => {
  it('renders day groups, notification details, unread labels and priority glyphs', async () => {
    uiBrowser = installTrackerUiBrowser();
    const now = Date.UTC(2026, 9, 10, 12);
    const today = inboxNotice('today', 'TAB-12', now - 60_000, 'commented');
    today.ticket.priority = 'high';
    const yesterday = inboxNotice('yesterday', 'TAB-13', now - 26 * 60 * 60_000, 'status_changed');
    yesterday.ticket.priority = 'none';
    yesterday.detail = { state: 'In review' };
    const { host } = inboxFixture([today, yesterday], now);
    await flush();

    const list = need(host, '[role="listbox"]');
    expect(list.getAttribute('aria-multiselectable')).toBe('true');
    expect(host.querySelectorAll('.trk-inbox-day-title').map((heading) => heading.textContent)).toEqual(['Today', 'Yesterday']);
    const rows = host.querySelectorAll('[role="option"]');
    expect(rows.map((row) => row.dataset.inboxId)).toEqual(['today', 'yesterday']);
    expect(rows[0].querySelector('.trk-inbox-unread-dot')?.textContent).toBe('Unread');
    expect(Boolean(rows[0].querySelector('.trk-state-glyph'))).toBe(true);
    expect(Boolean(rows[0].querySelector('.trk-priority-glyph'))).toBe(true);
    expect(Boolean(rows[1].querySelector('.trk-priority-glyph'))).toBe(false);
    expect(textOf(rows[0])).toContain('Mara commented');
    expect(textOf(rows[1])).toContain('Moved to In review');
  });

  it('handles cursor keys, selection, Enter and global shortcuts without swallowing them', async () => {
    uiBrowser = installTrackerUiBrowser();
    const now = Date.UTC(2026, 9, 10, 12);
    const rows = [1, 2, 3].map((index) => inboxNotice('notice-' + index, 'TAB-12', now - index * 1000));
    const { host, openedTickets, unread } = inboxFixture(rows, now);
    await flush();
    const list = need(host, '[role="listbox"]');
    let first = host.querySelector('[data-inbox-id="notice-1"]')!;
    first.dispatchEvent(uiEvent('keydown', { key: 'j' }));
    expect(host.querySelector('[data-inbox-id="notice-2"]')?.getAttribute('tabindex')).toBe('0');
    host.querySelector('[data-inbox-id="notice-2"]')!.dispatchEvent(uiEvent('keydown', { key: 'k' }));
    expect(host.querySelector('[data-inbox-id="notice-1"]')?.getAttribute('tabindex')).toBe('0');

    first = host.querySelector('[data-inbox-id="notice-1"]')!;
    first.dispatchEvent(uiEvent('keydown', { key: 'x' }));
    expect(host.querySelector('[data-inbox-id="notice-1"]')?.getAttribute('aria-selected')).toBe('true');
    host.querySelector('[data-inbox-id="notice-1"]')!.dispatchEvent(uiEvent('keydown', { key: 'ArrowDown', shiftKey: true }));
    expect(host.querySelector('[data-inbox-id="notice-2"]')?.getAttribute('aria-selected')).toBe('true');
    list.dispatchEvent(uiEvent('keydown', { key: 'a', ctrlKey: true }));
    expect(host.querySelectorAll('[aria-selected="true"]')).toHaveLength(3);

    host.querySelector('[data-inbox-id="notice-2"]')!.dispatchEvent(uiEvent('keydown', { key: 'Enter' }));
    await flush();
    expect(openedTickets).toEqual(['TAB-12']);
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(unread).toEqual([3, 2]);

    list.dispatchEvent(uiEvent('keydown', { key: 'e', shiftKey: true }));
    await flush();
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe('Marked 2 notices done');
    expect(unread).toEqual([3, 2, 0]);

    for (const key of ['g', 'c', 'f', 'k']) {
      const event = uiEvent('keydown', { key, ctrlKey: key === 'k' });
      list.dispatchEvent(event);
      expect(event.propagationStopped).toBe(false);
    }
  });

  it('removes notices optimistically, restores their positions on failure and retries', async () => {
    uiBrowser = installTrackerUiBrowser();
    const now = Date.UTC(2026, 9, 10, 12);
    const { api, host, unread } = inboxFixture([
      inboxNotice('notice-1', 'TAB-1', now - 1_000),
      inboxNotice('notice-2', 'TAB-2', now - 2_000),
      inboxNotice('notice-3', 'TAB-3', now - 3_000),
    ], now);
    await flush();
    let attempts = 0;
    const mark = api.markInboxRead.bind(api);
    api.markInboxRead = async (input, options) => {
      attempts++;
      if (attempts === 1) throw new Error('temporary failure');
      return mark(input, options);
    };

    host.querySelector('[data-inbox-id="notice-1"]')!.focus();
    host.querySelector('[data-inbox-id="notice-1"]')!.dispatchEvent(uiEvent('keydown', { key: 'e' }));
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect((uiBrowser.document.activeElement as unknown as FakeElement).dataset.inboxId).toBe('notice-2');
    await flush();
    expect(host.querySelectorAll('[role="option"]').map((row) => row.dataset.inboxId)).toEqual(['notice-1', 'notice-2', 'notice-3']);
    expect(textOf(need(host, '.trk-inbox-action-error'))).toContain('Could not mark notices done.');
    expect((uiBrowser.document.activeElement as unknown as FakeElement).dataset.inboxId).toBe('notice-1');

    control(host, 'Retry').click();
    await flush();
    expect(host.querySelectorAll('[role="option"]').map((row) => row.dataset.inboxId)).toEqual(['notice-2', 'notice-3']);
    expect(unread).toEqual([3, 2]);
    expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe('Marked TAB-1 done');
  });

  it('marks all read and toggles read rows into and out of the list', async () => {
    uiBrowser = installTrackerUiBrowser();
    const now = Date.UTC(2026, 9, 10, 12);
    const { api, host, unread } = inboxFixture([
      inboxNotice('unread', 'TAB-1', now - 1000),
      inboxNotice('read', 'TAB-2', now - 2000, 'mentioned', now - 1000),
    ], now);
    await flush();
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(1);
    control(host, 'Show read notices').click();
    await flush();
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(host.querySelector('[data-inbox-id="read"]')?.classList.contains('is-read')).toBe(true);
    expect(host.querySelector('[data-inbox-id="read"] .trk-inbox-unread-dot')?.textContent).toBe('');
    expect(need(host, '.trk-inbox-show-read').getAttribute('aria-pressed')).toBe('true');

    const inputs: Array<{ ids: string[] } | { all: true }> = [];
    const mark = api.markInboxRead.bind(api);
    api.markInboxRead = async (input, options) => {
      inputs.push(input);
      return mark(input, options);
    };
    control(host, 'Mark all read').click();
    await flush();
    expect(inputs).toEqual([{ all: true }]);
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(host.querySelectorAll('.is-read')).toHaveLength(2);
    expect(unread.at(-1)).toBe(0);
  });

  it('merges a refreshed first page while keeping the cursor on the same notice id', async () => {
    uiBrowser = installTrackerUiBrowser();
    const now = Date.UTC(2026, 9, 10, 12);
    const { api, host, controller, unread } = inboxFixture([
      inboxNotice('notice-1', 'TAB-1', now - 1000),
      inboxNotice('notice-2', 'TAB-2', now - 2000),
    ], now);
    await flush();
    host.querySelector('[data-inbox-id="notice-1"]')!.dispatchEvent(uiEvent('keydown', { key: 'j' }));
    const page = await api.inbox({ limit: 30, unread: true });
    api.inbox = async () => ({
      items: [inboxNotice('notice-new', 'TAB-3', now), page.items[0]],
      nextCursor: null,
      unread: 3,
    });
    await controller.refresh();
    expect(host.querySelectorAll('[role="option"]').map((row) => row.dataset.inboxId)).toEqual(['notice-new', 'notice-1', 'notice-2']);
    expect(host.querySelector('[data-inbox-id="notice-2"]')?.getAttribute('tabindex')).toBe('0');
    expect(unread).toEqual([2, 3]);
  });

  it('loads more with the button and when keyboard focus reaches the final loaded notice', async () => {
    uiBrowser = installTrackerUiBrowser();
    const now = Date.UTC(2026, 9, 10, 12);
    const rows = Array.from({ length: 61 }, (_, index) => inboxNotice('notice-' + index, 'TAB-' + (index + 1), now - index * 1000));
    const { host, unread } = inboxFixture(rows, now);
    await flush();
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(30);
    control(host, 'Load more').click();
    await flush();
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(60);
    need(host, '[role="listbox"]').dispatchEvent(uiEvent('keydown', { key: 'End' }));
    await flush();
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(61);
    expect(unread).toEqual([61, 61, 61]);
  });

  it('shows a three-row skeleton, empty copy, load errors with retry, and offline status', async () => {
    uiBrowser = installTrackerUiBrowser();
    const pendingApi = createMockTrackerApi();
    let signal: AbortSignal | undefined;
    pendingApi.inbox = (_query, options) => {
      signal = options?.signal;
      return new Promise(() => undefined);
    };
    const pendingHost = uiBrowser.document.createElement('div');
    uiBrowser.document.body.appendChild(pendingHost);
    const pending = mountInbox(pendingHost as unknown as HTMLElement, { api: pendingApi, onOpenTicket: () => undefined, onUnreadChange: () => undefined });
    expect(pendingHost.querySelectorAll('.trk-inbox-skeleton-row')).toHaveLength(3);
    expect(need(pendingHost, '[role="listbox"]').getAttribute('aria-busy')).toBe('true');
    pending.destroy();
    expect(signal?.aborted).toBe(true);
    expect(pendingHost.children).toHaveLength(0);

    const empty = inboxFixture([]);
    await flush();
    expect(textOf(need(empty.host, '.trk-inbox-empty'))).toContain('Nothing needs you.');
    expect(textOf(need(empty.host, '.trk-inbox-empty'))).toContain('Tickets that are assigned to you or mention you land here.');
    empty.controller.destroy();

    const errorApi = createMockTrackerApi({ inbox: [inboxNotice('retry', 'TAB-9', 100)] });
    const original = errorApi.inbox.bind(errorApi);
    let loads = 0;
    errorApi.inbox = async (query, options) => {
      loads++;
      if (loads === 1) throw new Error('offline');
      return original(query, options);
    };
    const errorHost = uiBrowser.document.createElement('div');
    uiBrowser.document.body.appendChild(errorHost);
    mountInbox(errorHost as unknown as HTMLElement, { api: errorApi, onOpenTicket: () => undefined, onUnreadChange: () => undefined });
    await flush();
    expect(textOf(need(errorHost, '.trk-inbox-error'))).toContain('Could not load your inbox.');
    control(errorHost, 'Retry').click();
    await flush();
    expect(errorHost.querySelectorAll('[role="option"]')).toHaveLength(1);

    vi.stubGlobal('navigator', { onLine: false });
    const offline = inboxFixture([inboxNotice('offline', 'TAB-8', 100)]);
    await flush();
    expect(need(offline.host, '.trk-inbox-offline').hidden).toBe(false);
    vi.stubGlobal('navigator', { onLine: true });
    uiBrowser.dispatchWindow(uiEvent('online'));
    await flush();
    expect(need(offline.host, '.trk-inbox-offline').hidden).toBe(true);
  });

  it('opens preferences lazily and removes online listeners on destroy', async () => {
    uiBrowser = installTrackerUiBrowser();
    const rows = [inboxNotice('notice', 'TAB-12', 100)];
    const { api, host, controller } = inboxFixture(rows);
    await flush();
    const settings = control(host, 'Notification settings');
    expect(host.querySelector('.trk-prefs')).toBeNull();
    settings.click();
    await flush();
    expect(host.querySelector('.trk-prefs')).not.toBeNull();
    expect(settings.getAttribute('aria-expanded')).toBe('true');

    let loads = 0;
    const original = api.inbox.bind(api);
    api.inbox = async (query, options) => { loads++; return original(query, options); };
    controller.destroy();
    uiBrowser.dispatchWindow(uiEvent('online'));
    await flush();
    expect(loads).toBe(0);
    expect(host.children).toHaveLength(0);
  });
});
