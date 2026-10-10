import type { TrackerApi } from '../../tracker-data';

export interface UnreadPollerOptions {
  api: Pick<TrackerApi, 'inboxUnread'>;
  intervalMs?: number;
  onChange: (unread: number) => void;
  setInterval?: (callback: () => void, delay: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  isVisible?: () => boolean;
}

export interface UnreadPoller {
  start(): void;
  stop(): void;
  poll(): Promise<void>;
  value(): number;
}

/** Polls the unread count. Call poll() on initial mount and when visibility returns. */
export function createUnreadPoller({
  api,
  intervalMs = 60_000,
  onChange,
  setInterval: setIntervalFn = (callback, delay) => globalThis.setInterval(callback, delay),
  clearInterval: clearIntervalFn = (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
  isVisible,
}: UnreadPollerOptions): UnreadPoller {
  let timer: unknown;
  let running = false;
  let unread = 0;
  let hasValue = false;
  let inFlight: Promise<void> | null = null;

  const poll = (): Promise<void> => {
    if (inFlight) return inFlight;
    if (isVisible && !isVisible()) return Promise.resolve();
    const request = Promise.resolve()
      .then(() => api.inboxUnread())
      .then((result) => {
        const next = Number.isFinite(result.unread) ? Math.max(0, Math.floor(result.unread)) : 0;
        if (!hasValue || next !== unread) {
          unread = next;
          hasValue = true;
          onChange(unread);
        }
      })
      .catch(() => undefined)
      .finally(() => { inFlight = null; });
    inFlight = request;
    return request;
  };

  return {
    start() {
      if (running) return;
      running = true;
      timer = setIntervalFn(() => { void poll(); }, Math.max(1, intervalMs));
    },
    stop() {
      if (!running) return;
      running = false;
      clearIntervalFn(timer);
      timer = undefined;
    },
    poll,
    value: () => unread,
  };
}
