import { describe, expect, it } from 'vitest';
import { createMockTrackerApi } from '../src/tracker-mock';
import { createUnreadPoller } from '../src/tracker/ui/unread-poller';

describe('tracker unread poller', () => {
  it('notifies only when the unread count changes and keeps its last value after errors', async () => {
    const api = createMockTrackerApi();
    let count = 2;
    api.inboxUnread = async () => ({ unread: count });
    const changes: number[] = [];
    const poller = createUnreadPoller({ api, onChange: (value) => changes.push(value) });

    await poller.poll();
    expect(poller.value()).toBe(2);
    await poller.poll();
    count = 3;
    await poller.poll();
    expect(changes).toEqual([2, 3]);

    api.inboxUnread = async () => { throw new Error('network unavailable'); };
    await expect(poller.poll()).resolves.toBeUndefined();
    expect(poller.value()).toBe(3);
    expect(changes).toEqual([2, 3]);
  });

  it('does not overlap requests and shares the in-flight poll promise', async () => {
    const api = createMockTrackerApi();
    let finish: ((value: { unread: number }) => void) | undefined;
    let requests = 0;
    api.inboxUnread = () => {
      requests++;
      return new Promise((resolve) => { finish = resolve; });
    };
    const poller = createUnreadPoller({ api, onChange: () => undefined });
    const first = poller.poll();
    const second = poller.poll();
    expect(second).toBe(first);
    await Promise.resolve();
    expect(requests).toBe(1);
    finish?.({ unread: 1 });
    await Promise.all([first, second]);
    expect(requests).toBe(1);
    const third = poller.poll();
    await Promise.resolve();
    expect(requests).toBe(2);
    finish?.({ unread: 2 });
    await third;
  });

  it('uses injected timers and lets the owner poll at startup and when visibility returns', async () => {
    const api = createMockTrackerApi();
    let requests = 0;
    api.inboxUnread = async () => { requests++; return { unread: requests }; };
    let tick: (() => void) | undefined;
    let cleared: unknown;
    let visible = false;
    const changes: number[] = [];
    const poller = createUnreadPoller({
      api,
      intervalMs: 10_000,
      onChange: (value) => changes.push(value),
      setInterval: (callback, delay) => {
        expect(delay).toBe(10_000);
        tick = callback;
        return 'timer';
      },
      clearInterval: (handle) => { cleared = handle; },
      isVisible: () => visible,
    });
    poller.start();
    expect(requests).toBe(0);
    await poller.poll();
    expect(requests).toBe(0);
    visible = true;
    await poller.poll();
    expect(requests).toBe(1);
    tick?.();
    await poller.poll();
    expect(requests).toBe(2);
    poller.stop();
    expect(cleared).toBe('timer');
    expect(changes).toEqual([1, 2]);
  });
});
