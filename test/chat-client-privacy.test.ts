import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type ChatMessage, type Me } from '../src/api';

const cacheRig = vi.hoisted(() => {
  const channels = new Map<string, unknown>();
  const outbox = new Map<string, { userId: string; item: unknown }>();
  const key = (userId: string, id: string) => `${userId}\u0000${id}`;
  return {
    channels,
    outbox,
    readChannel: vi.fn<(userId: string, id: string) => Promise<unknown>>(async (userId, id) => channels.get(key(userId, id))),
    writeChannel: vi.fn<(userId: string, entry: { key: string }) => Promise<void>>(async (userId, entry) => {
      channels.set(key(userId, entry.key), { ...entry, userId });
    }),
    readOutbox: vi.fn<(userId: string) => Promise<unknown[]>>(async (userId) =>
      [...outbox.values()].filter((row) => row.userId === userId).map((row) => row.item)),
    putOutbox: vi.fn<(userId: string, item: { clientId: string }) => Promise<void>>(async (userId, item) => {
      outbox.set(key(userId, item.clientId), { userId, item });
    }),
    deleteOutbox: vi.fn<(userId: string, clientId: string) => Promise<void>>(async (userId, clientId) => { outbox.delete(key(userId, clientId)); }),
    clearChatCache: vi.fn<() => Promise<void>>(async () => { channels.clear(); outbox.clear(); }),
    clearUserChatCache: vi.fn<(userId: string) => Promise<void>>(async (userId) => {
      for (const [k, row] of channels) if ((row as { userId?: string }).userId === userId) channels.delete(k);
      for (const [k, row] of outbox) if (row.userId === userId) outbox.delete(k);
    }),
    purgeOtherUsers: vi.fn<(userId: string) => Promise<void>>(async (userId) => {
      for (const [k, row] of channels) if ((row as { userId?: string }).userId !== userId) channels.delete(k);
      for (const [k, row] of outbox) if (row.userId !== userId) outbox.delete(k);
    }),
  };
});

vi.mock('../src/chat-cache', () => ({
  readChannel: cacheRig.readChannel,
  writeChannel: cacheRig.writeChannel,
  readOutbox: cacheRig.readOutbox,
  putOutbox: cacheRig.putOutbox,
  deleteOutbox: cacheRig.deleteOutbox,
  clearChatCache: cacheRig.clearChatCache,
  clearUserChatCache: cacheRig.clearUserChatCache,
  purgeOtherUsers: cacheRig.purgeOtherUsers,
}));

import { authState, initAuth, onAuth, setDemoMode, setSignedIn } from '../src/auth';
import { openChat, resetChat, totalUnread, watchChat, type BoardChat } from '../src/chat';
import type { OutboxItem } from '../src/ui/chat-logic';

class FakeSocket {
  static all: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(public url: string) { FakeSocket.all.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  say(frame: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

type ChatPage = Awaited<ReturnType<typeof api.chatMessages>>;
type PageHandler = (call: number, kind: string, ref: string, opts?: { before?: number; limit?: number }) => Promise<ChatPage>;

const me = (id: string): Me => ({
  user: { id, email: `${id}@example.test`, name: id, role: 'member' }, teams: [], chat: true,
});

const message = (id: number, text = `message ${id}`, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id, kind: 'workspace', ref: 'main', authorId: 'ana', authorName: 'Ana', clientId: `client-${id}-xx`, text,
  replyTo: null, objectId: null, mentions: [], createdAt: id, editedAt: null, deleted: false, deletedBy: null, ...extra,
});

const info = (kind: string, ref: string) => ({
  kind, ref, access: { write: true, moderate: false, role: 'member', readOnly: false }, people: [],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

let life: AbortController;
let pageCalls: number;
let pageHandler: PageHandler;
let pageWaiters: { count: number; resolve: () => void }[];

function whenPageCalls(count: number): Promise<void> {
  if (pageCalls >= count) return Promise.resolve();
  return new Promise((resolve) => pageWaiters.push({ count, resolve }));
}

function waitForLoad(chat: BoardChat): Promise<void> {
  let started = false;
  return new Promise((resolve) => {
    let off: () => void = () => {};
    off = chat.onChange(() => {
      if (chat.view().loading) started = true;
      else if (started) {
        off();
        resolve();
      }
    });
  });
}

function nextChange(chat: BoardChat): Promise<void> {
  return new Promise((resolve) => {
    let off: () => void = () => {};
    off = chat.onChange(() => {
      off();
      resolve();
    });
  });
}

function lastSocket() { return FakeSocket.all[FakeSocket.all.length - 1]; }

beforeEach(async () => {
  FakeSocket.all = [];
  pageCalls = 0;
  pageWaiters = [];
  pageHandler = async () => ({ messages: [], next: null });
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('location', { protocol: 'https:', host: 'tabula.example' });
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('localStorage', storage());
  vi.stubGlobal('sessionStorage', storage());
  cacheRig.channels.clear();
  cacheRig.outbox.clear();
  cacheRig.readChannel.mockClear();
  cacheRig.writeChannel.mockClear();
  cacheRig.readOutbox.mockReset().mockImplementation(async (userId: string) =>
    [...cacheRig.outbox.values()].filter((row) => row.userId === userId).map((row) => row.item));
  cacheRig.putOutbox.mockClear();
  cacheRig.deleteOutbox.mockClear();
  cacheRig.clearChatCache.mockClear();
  cacheRig.clearUserChatCache.mockClear();
  cacheRig.purgeOtherUsers.mockClear();
  vi.spyOn(api, 'config').mockResolvedValue({ authEnabled: true } as never);
  vi.spyOn(api, 'me').mockResolvedValue(me('user-a'));
  vi.spyOn(api, 'chatChannel').mockImplementation(async (kind, ref) => info(kind, ref));
  vi.spyOn(api, 'chatMessages').mockImplementation((kind, ref, opts) => {
    pageCalls++;
    const waiters = pageWaiters.filter((waiter) => pageCalls >= waiter.count);
    pageWaiters = pageWaiters.filter((waiter) => pageCalls < waiter.count);
    for (const waiter of waiters) waiter.resolve();
    return pageHandler(pageCalls, kind, ref, opts);
  });
  vi.spyOn(api, 'chatUnread').mockResolvedValue({ channels: [] });
  vi.spyOn(api, 'chatSend').mockResolvedValue({ message: message(99) });
  await initAuth({
    config: async () => ({ authEnabled: true }) as never,
    me: async () => me('user-a'),
  });
  life = new AbortController();
});

afterEach(async () => {
  life.abort();
  await resetChat();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('chat account privacy', () => {
  it('does not expose cached A messages to B at boot and purges A cache rows', async () => {
    setDemoMode();
    const cachedA = message(1, 'private A text');
    const aOutbox: OutboxItem = {
      clientId: 'draft-a-123', kind: 'workspace', ref: 'main', text: 'private A draft', replyTo: null, objectId: null,
      createdLocal: 1, state: 'queued',
    };
    cacheRig.channels.set('user-a\u0000workspace/main', { userId: 'user-a', key: 'workspace/main', messages: [cachedA], savedAt: 1 });
    cacheRig.channels.set('user-c\u0000team/t1', { userId: 'user-c', key: 'team/t1', messages: [message(3, 'private C text')], savedAt: 1 });
    cacheRig.outbox.set('user-a\u0000draft-a-123', { userId: 'user-a', item: aOutbox });
    cacheRig.outbox.set('user-c\u0000draft-c-123', { userId: 'user-c', item: { ...aOutbox, clientId: 'draft-c-123' } });
    (localStorage as unknown as ReturnType<typeof storage>).setItem('driftboard:me', JSON.stringify(me('user-a')));

    const pendingPage = deferred<ChatPage>();
    pageHandler = async () => pendingPage.promise;
    const apiMe = vi.spyOn(api, 'me').mockResolvedValue(me('user-b'));
    await initAuth({
      config: async () => ({ authEnabled: true }) as never,
      me: async () => apiMe(),
    });
    expect(cacheRig.purgeOtherUsers).toHaveBeenCalledWith('user-b');
    expect([...cacheRig.channels.values()].some((row) => (row as { userId: string }).userId === 'user-a')).toBe(false);
    expect([...cacheRig.channels.values()].some((row) => (row as { userId: string }).userId !== 'user-b')).toBe(false);
    expect([...cacheRig.outbox.values()].some((row) => row.userId === 'user-a')).toBe(false);
    expect([...cacheRig.outbox.values()].some((row) => row.userId !== 'user-b')).toBe(false);

    const chat = openChat('workspace', 'main', life.signal);
    const seen: string[] = [];
    chat.onChange(() => seen.push(chat.view().messages.map((item) => item.text).join('|')));
    const loaded = waitForLoad(chat);
    chat.setVisible(true);
    await whenPageCalls(1);
    expect(cacheRig.readChannel).toHaveBeenCalledWith('user-b', 'workspace/main');
    expect(chat.view().messages.map((item) => item.text)).not.toContain('private A text');
    pendingPage.resolve({ messages: [message(2, 'B text')], next: null });
    await loaded;
    expect(seen.join('\n')).not.toContain('private A text');
    expect(chat.view().messages.map((item) => item.text)).toEqual(['B text']);
  });

  it('resets the open tab on account-change and sign-out broadcasts', async () => {
    expect(typeof BroadcastChannel).toBe('function');
    const apiMe = vi.spyOn(api, 'me').mockResolvedValue(me('user-b'));
    const outbound = deferred<unknown>();
    const identityObserver = new BroadcastChannel('driftboard:auth');
    identityObserver.onmessage = (event) => outbound.resolve(event.data);
    setSignedIn(me('user-a'));
    expect(await outbound.promise).toBe('user-a');
    identityObserver.close();
    watchChat(life.signal);
    const socket = lastSocket();
    socket.open();
    socket.say({ t: 'hello', readOnly: false, channels: [{ kind: 'workspace', ref: 'main', unread: 5, mentions: 1, lastId: 9 }] });
    expect(totalUnread()).toEqual({ unread: 5, mentions: 1 });
    const sawUnknown = new Promise<void>((resolve) => {
      const off = onAuth((state) => {
        if (state.mode === 'unknown') {
          off();
          resolve();
        }
      });
    });
    const confirmed = new Promise<void>((resolve) => {
      const off = onAuth((state) => {
        if (state.mode === 'signed-in' && state.me.user.id === 'user-b') {
          off();
          resolve();
        }
      });
    });
    const otherTab = new BroadcastChannel('driftboard:auth');
    otherTab.postMessage('user-b');
    await sawUnknown;
    await confirmed;
    expect(socket.readyState).toBe(3);
    expect(FakeSocket.all).toHaveLength(2);
    expect(totalUnread()).toEqual({ unread: 0, mentions: 0 });
    expect(apiMe).toHaveBeenCalled();
    const userBSocket = lastSocket();
    const sawSignedOut = new Promise<void>((resolve) => {
      const off = onAuth((state) => {
        if (state.mode === 'signed-out') {
          off();
          resolve();
        }
      });
    });
    otherTab.postMessage('\u0000signed-out');
    await sawSignedOut;
    otherTab.close();
    expect(userBSocket.readyState).toBe(3);
    expect(authState().mode).toBe('signed-out');
  });

  it('discards an outbox read that finishes after reset and does not send A drafts as B', async () => {
    const read = deferred<OutboxItem[]>();
    cacheRig.readOutbox.mockReturnValue(read.promise);
    openChat('workspace', 'main', life.signal);
    expect(cacheRig.readOutbox).toHaveBeenCalledWith('user-a');
    await resetChat('user-a');
    setSignedIn(me('user-b'));
    read.resolve([{
      clientId: 'draft-a-123', kind: 'workspace', ref: 'main', text: 'private A draft', replyTo: null, objectId: null,
      createdLocal: 1, state: 'queued',
    }]);
    await read.promise;
    await Promise.resolve();
    expect(api.chatSend).not.toHaveBeenCalled();
  });

  it('drops cached messages below the retained-history boundary during reconnect catch-up', async () => {
    pageHandler = async (call) => call === 1
      ? { messages: [message(1), message(2)], next: null }
      : { messages: [message(9)], next: null };
    const chat = openChat('workspace', 'main', life.signal);
    const loaded = waitForLoad(chat);
    chat.setVisible(true);
    await whenPageCalls(1);
    await loaded;
    const socket = lastSocket();
    socket.open();
    socket.say({ t: 'hello', readOnly: false, channels: [] });
    const pendingCatchUp = deferred<ChatPage>();
    pageHandler = async () => pendingCatchUp.promise;
    socket.say({ t: 'hello', readOnly: false, channels: [] });
    await whenPageCalls(2);
    const caughtUp = nextChange(chat);
    pendingCatchUp.resolve({ messages: [message(9)], next: null });
    await caughtUp;
    expect(chat.view().messages.map((item) => item.id)).toEqual([9]);
  });

  it('keeps a delete that arrives while the newest page is loading', async () => {
    const pendingPage = deferred<ChatPage>();
    pageHandler = async () => pendingPage.promise;
    const chat = openChat('workspace', 'main', life.signal);
    const loaded = waitForLoad(chat);
    chat.setVisible(true);
    await whenPageCalls(1);
    const socket = lastSocket();
    socket.open();
    socket.say({ t: 'hello', readOnly: false, channels: [] });
    socket.say({ t: 'delete', kind: 'workspace', ref: 'main', id: 1, by: 'moderator' });
    pendingPage.resolve({ messages: [message(1, 'stale live text')], next: null });
    await loaded;
    expect(chat.view().messages).toMatchObject([{ id: 1, text: '', deleted: true, deletedBy: 'moderator' }]);
  });

  it('serializes overlapping newest-page loads without losing a live message', async () => {
    const deferredPages: ReturnType<typeof deferred<ChatPage>>[] = [];
    pageHandler = async (call) => {
      if (call === 1) return { messages: [message(1)], next: null };
      const pending = deferred<ChatPage>();
      deferredPages.push(pending);
      return pending.promise;
    };
    const chat = openChat('workspace', 'main', life.signal);
    const initial = waitForLoad(chat);
    chat.setVisible(true);
    await whenPageCalls(1);
    await initial;
    await Promise.resolve();
    const socket = lastSocket();
    socket.open();
    socket.say({ t: 'hello', readOnly: false, channels: [] });
    chat.setVisible(false);
    chat.setVisible(true);
    chat.setVisible(false);
    chat.setVisible(true);
    socket.say({ t: 'message', kind: 'workspace', ref: 'main', message: message(9, 'live during both opens') });
    const expectedLastPage = deferredPages.length === 1 ? 5 : 6;
    const settled = new Promise<void>((resolve) => {
      let off: () => void = () => {};
      off = chat.onChange(() => {
        if (chat.view().messages.some((item) => item.id === expectedLastPage)) {
          off();
          resolve();
        }
      });
    });
    deferredPages.forEach((pending, index) => pending.resolve({ messages: [message(5 + index)], next: null }));
    await settled;
    expect(pageCalls).toBe(2);
    expect(chat.view().messages.some((item) => item.id === 9)).toBe(true);
  });

  it('keeps live frames received during a wide paginated catch-up', async () => {
    // The catch-up pages need gates so the live frame arrives while pagination is active.
    const pages: ReturnType<typeof deferred<ChatPage>>[] = [];
    pageHandler = async (call) => {
      if (call === 1) return { messages: [message(1)], next: null };
      const pending = deferred<ChatPage>();
      pages.push(pending);
      return pending.promise;
    };
    const chat = openChat('workspace', 'main', life.signal);
    const initial = waitForLoad(chat);
    chat.setVisible(true);
    await whenPageCalls(1);
    await initial;
    const socket = lastSocket();
    socket.open();
    socket.say({ t: 'hello', readOnly: false, channels: [] });
    socket.say({ t: 'hello', readOnly: false, channels: [] });
    await whenPageCalls(2);
    socket.say({ t: 'message', kind: 'workspace', ref: 'main', message: message(500, 'live during wide catch-up') });
    for (let index = 0; index < 5; index++) {
      await whenPageCalls(index + 2);
      const finished = index === 4 ? nextChange(chat) : null;
      pages[index].resolve({ messages: [message(100 - index * 10)], next: 90 - index * 10 });
      if (index < 4) await whenPageCalls(index + 3);
      else await finished;
    }
    expect(chat.view().messages.some((item) => item.id === 500)).toBe(true);
  });
});
