import { describe, expect, it } from 'vitest';
import { CHAT_LIMITS, chatLimitsFromTestEnv, createChatLimits, createWindow } from '../server/chat-limits.mjs';

// docs/chat.md, "Limits": sliding windows in memory. The clock is a number the test moves. The 429 the routes answer
// with is checked over the relay in chat-api.test.ts.

const clock = () => {
  const c = { now: 1_000_000 };
  return { c, now: () => c.now };
};

describe('a sliding window', () => {
  it('allows max hits, then says how long to wait, and counts nothing it refused', () => {
    const { c, now } = clock();
    const w = createWindow({ max: 3, windowMs: 10_000 }, now);
    for (let i = 0; i < 3; i++) {
      expect(w.wait('k')).toBe(0);
      w.record('k');
      c.now += 1000;
    }
    // hits at 0, 1 and 2 s; now at 3 s: the first leaves the window at 10 s
    expect(w.wait('k')).toBe(7);
    c.now += 6_999;
    expect(w.wait('k')).toBe(1);
    c.now += 1;
    expect(w.wait('k')).toBe(0);
  });

  it('keeps a busy key when the map is full, and forgets the key idle longest', () => {
    const { c, now } = clock();
    const w = createWindow({ max: 1, windowMs: 60_000 }, now);
    w.record('busy');
    for (let i = 0; i < 49_999; i++) w.record(`k${i}`);
    c.now += 1000;
    // still at its limit: asking again counts as use, so 'busy' is no longer the oldest key
    expect(w.wait('busy')).toBeGreaterThan(0);
    w.record('fresh');
    expect(w.wait('busy')).toBeGreaterThan(0);
    expect(w.wait('k0')).toBe(0);
  });

  it('slides rather than resetting', () => {
    const { c, now } = clock();
    const w = createWindow({ max: 2, windowMs: 10_000 }, now);
    w.record('k');
    c.now += 6_000;
    w.record('k');
    c.now += 5_000; // the first hit is out, the second is still in
    expect(w.wait('k')).toBe(0);
    w.record('k');
    expect(w.wait('k')).toBeGreaterThan(0);
  });

  it('keeps keys apart', () => {
    const { now } = clock();
    const w = createWindow({ max: 1, windowMs: 10_000 }, now);
    w.record('a');
    expect(w.wait('a')).toBeGreaterThan(0);
    expect(w.wait('b')).toBe(0);
  });
});

describe('the chat limits', () => {
  it('only lengthens the burst window for the chat API test relay', () => {
    expect(chatLimitsFromTestEnv({})).toBe(CHAT_LIMITS);
    expect(chatLimitsFromTestEnv({ NODE_ENV: 'test', TABULA_TEST_CHAT_BURST_WINDOW_MS: '600000' }).postBurst).toEqual({ max: 5, windowMs: 600_000 });
    expect(() => chatLimitsFromTestEnv({ NODE_ENV: 'production', TABULA_TEST_CHAT_BURST_WINDOW_MS: '600000' })).toThrow(/only available when NODE_ENV=test/);
    for (const value of ['1999', '3600001', '1.5', 'nope']) {
      expect(() => chatLimitsFromTestEnv({ NODE_ENV: 'test', TABULA_TEST_CHAT_BURST_WINDOW_MS: value })).toThrow(/must be an integer/);
    }
  });

  it('allow a burst of five messages, then ask the sender to wait', () => {
    const { now } = clock();
    const limits = createChatLimits({ now });
    for (let i = 0; i < CHAT_LIMITS.postBurst.max; i++) expect(limits.post('ana', 'board/b1')).toBe(0);
    expect(limits.post('ana', 'board/b1')).toBe(2);
    expect(limits.post('ana', 'board/b2')).toBe(2);
    // other people are not affected
    expect(limits.post('ben', 'board/b1')).toBe(0);
  });

  it('allow 20 messages a minute in one channel', () => {
    const { c, now } = clock();
    const limits = createChatLimits({ now });
    for (let i = 0; i < 20; i++) {
      expect(limits.post('ana', 'board/b1')).toBe(0);
      c.now += 2_000; // slower than the burst limit
    }
    // the first of the 20 was 40 s ago: it leaves the window 20 s from now
    expect(limits.post('ana', 'board/b1')).toBe(20);
    expect(limits.post('ana', 'board/b2')).toBe(0);
  });

  it('allow 60 messages a minute across channels', () => {
    const { c, now } = clock();
    const limits = createChatLimits({ now });
    for (let i = 0; i < 60; i++) {
      expect(limits.post('ana', `board/b${i % 4}`)).toBe(0);
      c.now += 900; // under the burst limit, 15 per channel
    }
    expect(limits.post('ana', 'board/b9')).toBeGreaterThan(0);
  });

  it('refuse without counting, so a refused message does not lengthen the wait', () => {
    const { c, now } = clock();
    const limits = createChatLimits({ now });
    for (let i = 0; i < 5; i++) limits.post('ana', 'board/b1');
    for (let i = 0; i < 50; i++) expect(limits.post('ana', 'board/b1')).toBeGreaterThan(0);
    c.now += 2_000;
    expect(limits.post('ana', 'board/b1')).toBe(0);
  });

  it('a refusal by one window counts against none of the others', () => {
    const { c, now } = clock();
    const limits = createChatLimits({ now, limits: { ...CHAT_LIMITS, postPerChannel: { max: 1, windowMs: 60_000 } } });
    expect(limits.post('ana', 'board/b1')).toBe(0);
    for (let i = 0; i < 10; i++) expect(limits.post('ana', 'board/b1')).toBeGreaterThan(0);
    c.now += 2_000;
    // had the refused ones counted toward the burst window, this would wait
    for (let i = 0; i < 4; i++) expect(limits.post('ana', `board/other${i}`)).toBe(0);
  });

  it('keeps an active channel count when another window refuses the request and the map fills up', () => {
    const { c, now } = clock();
    const limits = createChatLimits({ now, limits: {
      ...CHAT_LIMITS,
      postPerChannel: { max: 2, windowMs: 60_000 },
      postBurst: { max: 1, windowMs: 2_000 },
    } });
    expect(limits.post('ana', 'board/b1')).toBe(0);
    for (let i = 0; i < 49_999; i++) limits.post(`person${i}`, 'board/b1');
    expect(limits.post('ana', 'board/b1')).toBe(2);
    expect(limits.post('fresh', 'board/b1')).toBe(0);
    c.now += 2_000;
    expect(limits.post('ana', 'board/b1')).toBe(0);
    c.now += 2_000;
    expect(limits.post('ana', 'board/b1')).toBe(56);
  });

  it('allow 20 edits and deletes a minute', () => {
    const { c, now } = clock();
    const limits = createChatLimits({ now });
    for (let i = 0; i < 20; i++) expect(limits.change('ana')).toBe(0);
    expect(limits.change('ana')).toBe(60);
    expect(limits.change('ben')).toBe(0);
    c.now += 60_000;
    expect(limits.change('ana')).toBe(0);
  });

  it('keep edits apart from new messages', () => {
    const { now } = clock();
    const limits = createChatLimits({ now });
    for (let i = 0; i < 20; i++) limits.change('ana');
    expect(limits.post('ana', 'board/b1')).toBe(0);
  });

  it.each<['channelInfo' | 'unread' | 'read' | 'history', number]>([['channelInfo', 60], ['unread', 60], ['read', 60], ['history', 120]])(
    'allow %s %i times a minute per person, then ask to wait, each on its own',
    (name, max) => {
      const { c, now } = clock();
      const limits = createChatLimits({ now });
      expect(CHAT_LIMITS[name]).toEqual({ max, windowMs: 60_000 });
      for (let i = 0; i < max; i++) {
        expect(limits[name]('ana')).toBe(0);
        c.now += 100;
      }
      expect(limits[name]('ana')).toBeGreaterThan(0);
      expect(limits[name]('ben')).toBe(0);
      // the other reads, the posts and the edits are counted apart
      for (const other of (['channelInfo', 'unread', 'read'] as const).filter((n) => n !== name)) expect(limits[other]('ana')).toBe(0);
      expect(limits.post('ana', 'board/b1')).toBe(0);
      expect(limits.change('ana')).toBe(0);
      c.now += 60_000;
      expect(limits[name]('ana')).toBe(0);
    },
  );
});
