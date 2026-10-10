import { describe, expect, it } from 'vitest';
import { createMockTrackerApi } from '../src/tracker-mock';
import type { TrackerInboxItem, TrackerNotificationKind, TrackerNotificationPrefs } from '../src/tracker-types';

function notice(id: string, createdAt: number, readAt: number | null = null, kind: TrackerNotificationKind = 'assigned'): TrackerInboxItem {
  return {
    id, kind, createdAt, readAt,
    ticket: {
      key: 'TAB-12', title: 'Same ticket, different notice', state: { name: 'To do', category: 'unstarted' },
      assignee: null, priority: 'none',
    },
    actor: null, preview: null, detail: null,
  };
}

const prefs: TrackerNotificationPrefs = {
  kinds: ['assigned', 'mentioned', 'commented', 'status_changed', 'due_soon', 'relation_changed', 'integration_activity'],
  prefs: {
    assigned: 'both', mentioned: 'both', commented: 'app', status_changed: 'app', due_soon: 'both',
    relation_changed: 'app', integration_activity: 'app',
  },
};

describe('tracker mock inbox and notification preferences', () => {
  it('seeds a mutable inbox, sorts and pages with cursors, and filters unread rows', async () => {
    const seeded = [
      notice('notice-1', 100), notice('notice-2', 100, 50), notice('notice-3', 90),
      notice('notice-4', 80, 40), notice('notice-5', 70), notice('notice-6', 60),
    ];
    const api = createMockTrackerApi({ inbox: seeded, now: () => 500 });
    const first = await api.inbox({ limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual(['notice-2', 'notice-1']);
    expect(first.nextCursor).toBeTruthy();
    expect(first.unread).toBe(4);
    const second = await api.inbox({ limit: 2, before: first.nextCursor! });
    expect(second.items.map((item) => item.id)).toEqual(['notice-3', 'notice-4']);
    expect(second.nextCursor).toBeTruthy();

    const unread = await api.inbox({ unread: true, limit: 10 });
    expect(unread.items.map((item) => item.id)).toEqual(['notice-1', 'notice-3', 'notice-5', 'notice-6']);
    expect(unread.unread).toBe(4);
    expect(await api.inboxUnread()).toEqual({ unread: 4 });
    expect(seeded[0].readAt).toBeNull();
  });

  it('marks ids once, marks all remaining rows, and returns current unread counts', async () => {
    const api = createMockTrackerApi({
      inbox: [notice('notice-a', 30), notice('notice-b', 20), notice('notice-c', 10, 9)],
      now: () => 500,
    });
    expect(await api.markInboxRead({ ids: ['notice-a', 'notice-a', 'missing'] })).toEqual({ updated: 1, unread: 1 });
    expect(await api.markInboxRead({ ids: ['notice-a'] })).toEqual({ updated: 0, unread: 1 });
    expect(await api.markInboxRead({ all: true })).toEqual({ updated: 1, unread: 0 });
    expect((await api.inbox({ unread: true })).items).toEqual([]);
    expect(await api.inboxUnread()).toEqual({ unread: 0 });
  });

  it('clamps pages to fifty and applies preference patches without losing other kinds', async () => {
    const api = createMockTrackerApi({
      inbox: Array.from({ length: 55 }, (_, index) => notice('notice-' + index, 1000 - index)),
      notificationPrefs: prefs,
    });
    const page = await api.inbox({ limit: 100 });
    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).toBeTruthy();
    expect((await api.inbox({ before: page.nextCursor! })).items).toHaveLength(5);

    const updated = await api.updateNotificationPrefs({ prefs: { assigned: 'off', integration_activity: 'both' } });
    expect(updated.kinds).toEqual(prefs.kinds);
    expect(updated.prefs).toEqual({ ...prefs.prefs, assigned: 'off', integration_activity: 'both' });
    expect((await api.notificationPrefs()).prefs.assigned).toBe('off');
  });
});
