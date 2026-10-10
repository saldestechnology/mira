// Rate limits of chat (docs/chat.md, "Limits"): the writes, and the reads of a conversation (metadata, unread, read markers and pages of messages). Sliding windows in memory, modelled on the MCP limiter in
// mcp.mjs: a request over any of its limits is refused and counts against none of them.

const MINUTE_MS = 60_000;
const MAX_KEYS = 50_000;
const SWEEP_MS = 60_000;

export const CHAT_LIMITS = Object.freeze({
  postPerChannel: { max: 20, windowMs: MINUTE_MS },
  postOverall: { max: 60, windowMs: MINUTE_MS },
  // "burst of 5": at most five sends in any two seconds, across channels (the minute windows set the steady rate)
  postBurst: { max: 5, windowMs: 2_000 },
  change: { max: 20, windowMs: MINUTE_MS },
  // the reads around a conversation: a channel's metadata is asked for once per opening of the tab, the unread summary
  // once per opening and page, a read marker at most every two seconds per tab (src/chat.ts); 60 a minute leaves room for
  // the headless visual check, which opens chat that often as one person
  channelInfo: { max: 60, windowMs: MINUTE_MS },
  unread: { max: 60, windowMs: MINUTE_MS },
  read: { max: 60, windowMs: MINUTE_MS },
  react: { max: 60, windowMs: MINUTE_MS },
  // a page of messages: one on opening a conversation and one for each time the person scrolls back for older ones
  history: { max: 120, windowMs: MINUTE_MS },
});

const TEST_CHAT_BURST_WINDOW_MAX_MS = 60 * 60_000;

/**
 * The API integration test may lengthen the burst window so runner pauses cannot expire it mid-test.
 * @param {Record<string, string | undefined>} [env]
 */
export function chatLimitsFromTestEnv(env = process.env) {
  const raw = env.TABULA_TEST_CHAT_BURST_WINDOW_MS?.trim();
  if (!raw) return CHAT_LIMITS;
  if (env.NODE_ENV !== 'test') throw new Error('TABULA_TEST_CHAT_BURST_WINDOW_MS is only available when NODE_ENV=test');
  const windowMs = Number(raw);
  if (!Number.isSafeInteger(windowMs) || windowMs < CHAT_LIMITS.postBurst.windowMs || windowMs > TEST_CHAT_BURST_WINDOW_MAX_MS) {
    throw new Error(`TABULA_TEST_CHAT_BURST_WINDOW_MS must be an integer between ${CHAT_LIMITS.postBurst.windowMs} and ${TEST_CHAT_BURST_WINDOW_MAX_MS}`);
  }
  return { ...CHAT_LIMITS, postBurst: { ...CHAT_LIMITS.postBurst, windowMs } };
}

/** One sliding window per key. `wait(key)` is 0 when a hit fits, else the seconds until it would. */
export function createWindow({ max, windowMs }, now = Date.now) {
  const hits = new Map();
  let lastSweep = 0;
  const recent = (key, t) => (hits.get(key) ?? []).filter((ts) => ts > t - windowMs);
  // a key in use goes to the back of the map, so the bound below forgets the key idle longest, never one that is busy
  const keep = (key, list) => {
    hits.delete(key);
    hits.set(key, list);
  };

  function sweep(t) {
    if (t - lastSweep < SWEEP_MS) return;
    lastSweep = t;
    for (const [key, list] of hits) if (!list.some((ts) => ts > t - windowMs)) hits.delete(key);
  }

  return {
    wait(key) {
      const t = now();
      const list = recent(key, t);
      if (list.length > 0) keep(key, list);
      if (list.length < max) return 0;
      return Math.max(1, Math.ceil((list[0] + windowMs - t) / 1000));
    },
    record(key) {
      const t = now();
      sweep(t);
      keep(key, [...recent(key, t), t]);
      if (hits.size > MAX_KEYS) hits.delete(hits.keys().next().value);
    },
  };
}

/** Checks every [window, key] pair first and records them all only when each one fits. Returns the seconds to wait, or 0. */
function hitAll(pairs) {
  const wait = Math.max(0, ...pairs.map(([w, key]) => w.wait(key)));
  if (wait === 0) for (const [w, key] of pairs) w.record(key);
  return wait;
}

/**
 * The limiters the chat routes use. Each method counts one request and answers 0, or the seconds the caller must wait
 * (then nothing was counted).
 * @param {{ now?: () => number, limits?: typeof CHAT_LIMITS }} [options]
 */
export function createChatLimits({ now = Date.now, limits = CHAT_LIMITS } = {}) {
  const perChannel = createWindow(limits.postPerChannel, now);
  const overall = createWindow(limits.postOverall, now);
  const burst = createWindow(limits.postBurst, now);
  const change = createWindow(limits.change, now);
  const channelInfo = createWindow(limits.channelInfo, now);
  const unread = createWindow(limits.unread, now);
  const read = createWindow(limits.read, now);
  const react = createWindow(limits.react, now);
  const history = createWindow(limits.history, now);
  return {
    /** A new message from `userId` in the channel `channel` ("kind/ref"). */
    post: (userId, channel) => hitAll([[perChannel, `${userId} ${channel}`], [overall, userId], [burst, userId]]),
    /** An edit or a delete by `userId`. */
    change: (userId) => hitAll([[change, userId]]),
    /** GET of a channel's metadata (access and people) by `userId`. */
    channelInfo: (userId) => hitAll([[channelInfo, userId]]),
    /** GET of the unread summary by `userId`. */
    unread: (userId) => hitAll([[unread, userId]]),
    /** PUT of a read marker by `userId`, in any channel. */
    read: (userId) => hitAll([[read, userId]]),
    /** A reaction switched on or off by `userId`. */
    react: (userId) => hitAll([[react, userId]]),
    /** GET of a page of messages by `userId`, in any channel. */
    history: (userId) => hitAll([[history, userId]]),
  };
}
