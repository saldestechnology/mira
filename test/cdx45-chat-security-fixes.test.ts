import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type ChatMessage } from '../src/api';
import { initAuth, setSignedIn, setSignedOut } from '../src/auth';
import { openChat, resetChat, totalUnread, watchChat } from '../src/chat';

const cache = vi.hoisted(() => ({
  readChannel: vi.fn<(key: string) => Promise<{ key: string; messages: unknown[]; savedAt: number } | undefined>>(async () => undefined),
  writeChannel: vi.fn<(entry: { key: string; messages: unknown[]; savedAt: number }) => Promise<void>>(async () => {}),
  readOutbox: vi.fn<() => Promise<unknown[]>>(async () => []),
  putOutbox: vi.fn<(item: unknown) => Promise<void>>(async () => {}),
  deleteOutbox: vi.fn<(clientId: string) => Promise<void>>(async () => {}),
  clearChatCache: vi.fn<() => Promise<void>>(async () => {}),
}));
vi.mock('../src/chat-cache', () => cache);

class FakeSocket {
  static all: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(public url: string) { FakeSocket.all.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  open() { this.readyState = 1; this.onopen?.(); }
  say(frame: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

const message = (id: number, kind: string, ref: string): ChatMessage => ({
  id, kind, ref, authorId: 'ana', authorName: 'Ana', clientId: `client-${id}-xx`, text: `m${id}`,
  replyTo: null, objectId: null, mentions: [], createdAt: id, editedAt: null, deleted: false, deletedBy: null,
});
const person = (id: string) => ({ user: { id, email: `${id}@example.test`, name: id, role: 'member' }, teams: [], chat: true });
const lastSocket = () => FakeSocket.all[FakeSocket.all.length - 1];
let life: AbortController;
let storage: Map<string, string>;
let beforeIdentityWrite: ((id: string) => void) | undefined;

beforeEach(async () => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  storage = new Map();
  beforeIdentityWrite = undefined;
  cache.readChannel.mockReset().mockResolvedValue(undefined);
  cache.writeChannel.mockReset().mockResolvedValue(undefined);
  cache.readOutbox.mockReset().mockResolvedValue([]);
  cache.putOutbox.mockReset().mockResolvedValue(undefined);
  cache.deleteOutbox.mockReset().mockResolvedValue(undefined);
  cache.clearChatCache.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('location', { protocol: 'https:', host: 'tabula.example', hash: '' });
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (key === 'driftboard:me') beforeIdentityWrite?.((JSON.parse(value) as { user: { id: string } }).user.id);
      storage.set(key, value);
    },
    removeItem: (key: string) => { storage.delete(key); },
  });
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  await initAuth({ config: async () => ({ authEnabled: true }) as never, me: async () => person('a') as never });
  life = new AbortController();
});

afterEach(async () => {
  life.abort();
  cache.clearChatCache.mockResolvedValue(undefined);
  await resetChat();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function readyA() {
  vi.spyOn(api, 'chatChannel').mockResolvedValue({
    kind: 'team', ref: 't1', access: { write: true, moderate: false, role: 'member', readOnly: false }, people: [],
  });
  vi.spyOn(api, 'chatUnread').mockResolvedValue({ channels: [{ kind: 'team', ref: 't1', lastId: 1, unread: 3, mentions: 1 }] });
  vi.spyOn(api, 'chatMessages').mockResolvedValue({ messages: [message(1, 'team', 't1'), message(2, 'team', 't1')], next: null });
  watchChat(life.signal);
  const ws = lastSocket();
  ws.open();
  ws.say({ t: 'hello', readOnly: false, channels: [{ kind: 'team', ref: 't1', unread: 3, mentions: 1, lastId: 1 }] });
  const chat = openChat('team', 't1', life.signal);
  chat.setVisible(true);
  await vi.advanceTimersByTimeAsync(10);
  vi.stubGlobal('navigator', { onLine: false });
  chat.send('pending A message', null);
  return { chat, ws };
}

function gateCacheDeletion() {
  let completed = false;
  const releases: (() => void)[] = [];
  cache.clearChatCache.mockImplementation(() => new Promise<void>((resolve) => {
    releases.push(() => { completed = true; resolve(); });
  }));
  return { releases, isComplete: () => completed };
}

describe('account changes clear private chat state', () => {
  it.fails('clears socket, memory, outbox, unread and IndexedDB before setSignedIn stores B', async () => {
    // Account switch ordering defect: src/auth.ts:146-173 stores B before src/chat.ts:782-790 resets A's chat; the reset starts cache deletion without awaiting it.
    // Fix: await the account-change chat reset and cache deletion before persisting B.
    const { chat, ws } = await readyA();
    const deletion = gateCacheDeletion();
    let atWrite: unknown;
    beforeIdentityWrite = (id) => {
      if (id === 'b') atWrite = {
        socketClosed: ws.readyState === 3,
        messages: chat.view().messages,
        pending: chat.view().pending,
        unread: totalUnread(),
        indexedDbCleared: deletion.isComplete(),
      };
    };
    setSignedIn(person('b') as never);
    for (const release of deletion.releases) release();
    ws.say({ t: 'message', kind: 'team', ref: 't1', message: message(99, 'team', 't1') });
    ws.say({ t: 'unread', kind: 'team', ref: 't1', unread: 9, mentions: 4 });
    expect(chat.view().messages).toEqual([]);
    expect(chat.view().pending).toEqual([]);
    expect(totalUnread()).toEqual({ unread: 0, mentions: 0 });
    expect(atWrite).toEqual({ socketClosed: true, messages: [], pending: [], unread: { unread: 0, mentions: 0 }, indexedDbCleared: true });
  });

  it.fails('clears socket, memory, outbox, unread and IndexedDB before initAuth stores B', async () => {
    // Account refresh ordering defect: src/auth.ts:146-173 stores B before src/chat.ts:782-790 resets A's chat and awaits cache deletion.
    // Fix: await the account-change reset before writing B to localStorage.
    const { chat, ws } = await readyA();
    const deletion = gateCacheDeletion();
    let atWrite: unknown;
    beforeIdentityWrite = (id) => {
      if (id === 'b') atWrite = {
        socketClosed: ws.readyState === 3,
        messages: chat.view().messages,
        pending: chat.view().pending,
        unread: totalUnread(),
        indexedDbCleared: deletion.isComplete(),
      };
    };
    await initAuth({ config: async () => ({ authEnabled: true }) as never, me: async () => person('b') as never });
    for (const release of deletion.releases) release();
    ws.say({ t: 'message', kind: 'team', ref: 't1', message: message(99, 'team', 't1') });
    expect(chat.view().messages).toEqual([]);
    expect(totalUnread()).toEqual({ unread: 0, mentions: 0 });
    expect(atWrite).toEqual({ socketClosed: true, messages: [], pending: [], unread: { unread: 0, mentions: 0 }, indexedDbCleared: true });
  });

  it('ignores late A frames after setSignedIn switches to B', async () => {
    const { chat, ws } = await readyA();
    setSignedIn(person('b') as never);
    ws.say({ t: 'message', kind: 'team', ref: 't1', message: message(99, 'team', 't1') });
    ws.say({ t: 'unread', kind: 'team', ref: 't1', unread: 9, mentions: 4 });
    expect(chat.view().messages).toEqual([]);
    expect(chat.view().pending).toEqual([]);
    expect(totalUnread()).toEqual({ unread: 0, mentions: 0 });
  });

  it('ignores late A frames after initAuth switches to B', async () => {
    const { chat, ws } = await readyA();
    await initAuth({ config: async () => ({ authEnabled: true }) as never, me: async () => person('b') as never });
    ws.say({ t: 'message', kind: 'team', ref: 't1', message: message(99, 'team', 't1') });
    ws.say({ t: 'unread', kind: 'team', ref: 't1', unread: 9, mentions: 4 });
    expect(chat.view().messages).toEqual([]);
    expect(totalUnread()).toEqual({ unread: 0, mentions: 0 });
  });

  it('keeps the existing socket and private state when the same person signs in again', async () => {
    const { chat, ws } = await readyA();
    setSignedIn(person('a') as never);
    await vi.advanceTimersByTimeAsync(5);
    expect(FakeSocket.all).toHaveLength(1);
    expect(ws.readyState).toBe(1);
    expect(chat.view().messages.map((item) => item.id)).toEqual([1, 2]);
    expect(chat.view().pending).toHaveLength(1);
    expect(totalUnread()).toEqual({ unread: 1, mentions: 0 });
  });

  it('clears A when the user signs out and immediately signs in as B', async () => {
    const { chat, ws } = await readyA();
    setSignedOut();
    setSignedIn(person('b') as never);
    expect(ws.readyState).toBe(3);
    expect(chat.view().messages).toEqual([]);
    expect(chat.view().pending).toEqual([]);
    expect(totalUnread()).toEqual({ unread: 0, mentions: 0 });
    ws.say({ t: 'message', kind: 'team', ref: 't1', message: message(99, 'team', 't1') });
    expect(chat.view().messages).toEqual([]);
  });

  it.fails('does not show person A cached chat to person B after a fresh session boots', async () => {
    // CDX-44 P1: fresh auth starts unknown and misses A's persisted identity (src/auth.ts:146-173); chat cache keys are not user-scoped (src/chat-cache.ts:9-14,64-72), and src/chat.ts:318-366 displays cached rows on server failure.
    // Fix: compare the persisted identity at boot and clear or user-scope chat cache before B can read it.
    const privateMessage = { ...message(77, 'workspace', 'main'), authorId: 'a', text: 'A-private-cached-chat' };
    let savedAChannel: { key: string; messages: unknown[]; savedAt: number } | undefined = {
      key: 'workspace/main', messages: [privateMessage], savedAt: Date.now(),
    };
    storage.set('driftboard:me', JSON.stringify(person('a')));
    cache.readChannel.mockImplementation(async (key) => key === 'workspace/main' ? savedAChannel : undefined);
    cache.clearChatCache.mockImplementation(async () => { savedAChannel = undefined; });

    vi.resetModules();
    const freshAuth = await import('../src/auth');
    const freshApi = await import('../src/api');
    const freshChat = await import('../src/chat');
    const freshLife = new AbortController();
    try {
      await freshAuth.initAuth({ config: async () => ({ authEnabled: true }) as never, me: async () => person('b') as never });
      vi.spyOn(freshApi.api, 'chatChannel').mockRejectedValue(new Error('offline'));
      vi.spyOn(freshApi.api, 'chatMessages').mockRejectedValue(new Error('offline'));
      vi.spyOn(freshApi.api, 'chatUnread').mockResolvedValue({ channels: [] });
      freshChat.watchChat(freshLife.signal);
      const chat = freshChat.openChat('workspace', 'main', freshLife.signal);
      chat.setVisible(true);
      await vi.advanceTimersByTimeAsync(10);
      expect(chat.view().messages.some((item) => item.text === 'A-private-cached-chat')).toBe(false);
    } finally {
      freshLife.abort();
      await freshChat.resetChat();
    }
  });

  it.fails('does not restore or send A outbox data when its read finishes after resetChat', async () => {
    // CDX-44 P2: src/chat.ts:432-439 merges an old outbox read after src/chat.ts:748-777 resets it; flush then sends under B's current generation (src/chat.ts:451-464; src/api.ts:609-613).
    // Fix: bind outbox reads to the generation/user that started them and discard stale completions.
    let finishRead!: (items: unknown[]) => void;
    cache.readOutbox.mockImplementation(() => new Promise((resolve) => { finishRead = resolve; }));
    const { chat } = await readyA();
    const aDraft = chat.view().pending[0];
    expect(aDraft).toBeDefined();

    await resetChat();
    setSignedIn(person('b') as never);
    vi.stubGlobal('navigator', { onLine: true });
    const send = vi.spyOn(api, 'chatSend').mockImplementation(() => new Promise(() => {}));
    finishRead([aDraft]);
    await vi.advanceTimersByTimeAsync(1);

    expect({ pending: chat.view().pending, sends: send.mock.calls }).toEqual({ pending: [], sends: [] });
  });
});

describe('purged chat history and concurrent loads', () => {
  async function readyHistory(page: ChatMessage[]) {
    vi.spyOn(api, 'chatChannel').mockResolvedValue({
      kind: 'workspace', ref: 'main', access: { write: true, moderate: false, role: 'member', readOnly: false }, people: [],
    });
    vi.spyOn(api, 'chatUnread').mockResolvedValue({ channels: [] });
    vi.spyOn(api, 'chatMessages').mockResolvedValue({ messages: page, next: null });
    watchChat(life.signal);
    const ws = lastSocket();
    ws.open();
    ws.say({ t: 'hello', readOnly: false, channels: [] });
    const chat = openChat('workspace', 'main', life.signal);
    chat.setVisible(true);
    await vi.advanceTimersByTimeAsync(10);
    return { chat, ws };
  }

  it('persists an empty snapshot after the server purges all history', async () => {
    const { chat } = await readyHistory([message(1, 'workspace', 'main'), message(2, 'workspace', 'main')]);
    chat.setVisible(false);
    cache.writeChannel.mockClear();
    vi.spyOn(api, 'chatMessages').mockResolvedValue({ messages: [], next: null });
    chat.setVisible(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(chat.view().messages).toEqual([]);
    expect(cache.writeChannel).toHaveBeenCalledWith(expect.objectContaining({ messages: [] }));
  });

  it('keeps only a live frame that arrived while the page was on its way', async () => {
    const { chat, ws } = await readyHistory([message(1, 'workspace', 'main'), message(2, 'workspace', 'main')]);
    chat.setVisible(false);
    let answer!: (value: { messages: ChatMessage[]; next: number | null }) => void;
    vi.spyOn(api, 'chatMessages').mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    cache.writeChannel.mockClear();
    chat.setVisible(true);
    await vi.advanceTimersByTimeAsync(5);
    ws.say({ t: 'message', kind: 'workspace', ref: 'main', message: message(9, 'workspace', 'main') });
    answer({ messages: [message(5, 'workspace', 'main')], next: null });
    await vi.advanceTimersByTimeAsync(5);
    expect(chat.view().messages.map((item) => item.id)).toEqual([5, 9]);
    expect(cache.writeChannel).toHaveBeenLastCalledWith(expect.objectContaining({ messages: [message(5, 'workspace', 'main'), message(9, 'workspace', 'main')] }));
  });

  it('drops a previously cached frame that is absent from the server page', async () => {
    const { chat } = await readyHistory([message(1, 'workspace', 'main'), message(2, 'workspace', 'main')]);
    chat.setVisible(false);
    vi.spyOn(api, 'chatMessages').mockResolvedValue({ messages: [message(2, 'workspace', 'main')], next: null });
    chat.setVisible(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(chat.view().messages.map((item) => item.id)).toEqual([2]);
  });

  it.fails('does not let an older concurrent page overwrite the newer page or a live frame', async () => {
    // CDX-44 P2: overlapping newest loads lose pages and live frames through the shared arrivals set (src/chat.ts:601-608, 318-322, 338-342).
    // Fix: serialize newest loads or give each request its own arrival snapshot and apply order.
    const { chat, ws } = await readyHistory([message(1, 'workspace', 'main')]);
    chat.setVisible(false);
    const answers: ((value: { messages: ChatMessage[]; next: number | null }) => void)[] = [];
    vi.spyOn(api, 'chatMessages').mockImplementation(() => new Promise((resolve) => { answers.push(resolve); }));
    chat.setVisible(true);
    await vi.advanceTimersByTimeAsync(5);
    chat.setVisible(false);
    chat.setVisible(true);
    await vi.advanceTimersByTimeAsync(5);
    ws.say({ t: 'message', kind: 'workspace', ref: 'main', message: message(30, 'workspace', 'main') });
    answers[1]({ messages: [message(20, 'workspace', 'main')], next: null });
    await vi.advanceTimersByTimeAsync(5);
    answers[0]({ messages: [message(10, 'workspace', 'main')], next: null });
    await vi.advanceTimersByTimeAsync(5);
    expect(chat.view().messages.map((item) => item.id)).toEqual([20, 30]);
  });

  it.fails('catches up after reconnect when the channel page was already loading', async () => {
    // Reconnect during load drops catch-up: hello skips the active load (src/chat.ts:209-226), and load completion does not schedule it (src/chat.ts:368-370).
    // Fix: remember reconnects during load and run catchUp after the current page settles.
    const { chat, ws } = await readyHistory([message(1, 'workspace', 'main')]);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    chat.setVisible(false);
    let pageAnswer!: (value: { messages: ChatMessage[]; next: number | null }) => void;
    const messages = vi.spyOn(api, 'chatMessages').mockImplementationOnce(() => new Promise((resolve) => { pageAnswer = resolve; }))
      .mockResolvedValue({ messages: [message(9, 'workspace', 'main')], next: null });
    messages.mockClear();
    chat.setVisible(true);
    await vi.advanceTimersByTimeAsync(5);
    ws.onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(500);
    const reconnect = lastSocket();
    reconnect.open();
    reconnect.say({ t: 'hello', readOnly: false, channels: [] });
    pageAnswer({ messages: [message(1, 'workspace', 'main')], next: null });
    await vi.advanceTimersByTimeAsync(10);
    expect(messages).toHaveBeenCalledTimes(2);
    expect(chat.view().messages.map((item) => item.id)).toContain(9);
  });

  it.fails('removes purged messages during reconnect catch-up', async () => {
    // CDX-44 P2: reconnect catch-up merges an empty server page with stale in-memory history and persists it (src/chat.ts:375-402).
    // Fix: apply the successful catch-up response as the retention source, preserving only frames received during that request.
    const { chat, ws } = await readyHistory([message(1, 'workspace', 'main'), message(2, 'workspace', 'main')]);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.spyOn(api, 'chatMessages').mockResolvedValue({ messages: [], next: null });
    cache.writeChannel.mockClear();
    ws.readyState = 3;
    ws.onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(500);
    const reconnect = lastSocket();
    reconnect.open();
    reconnect.say({ t: 'hello', readOnly: false, channels: [] });
    await vi.advanceTimersByTimeAsync(10);
    expect(chat.view().messages).toEqual([]);
    expect(cache.writeChannel).toHaveBeenLastCalledWith(expect.objectContaining({ messages: [] }));
  });

  it.fails('preserves a delete frame received while an older page is loading', async () => {
    // CDX-44 P2: delete frames do not enter the load arrival set (src/chat.ts:253-267), so the older page restores the deleted row (src/chat.ts:318-342).
    // Fix: track delete tombstones received during a load and apply them after merging the page.
    const { chat, ws } = await readyHistory([message(1, 'workspace', 'main'), message(2, 'workspace', 'main')]);
    chat.setVisible(false);
    let pageAnswer!: (value: { messages: ChatMessage[]; next: number | null }) => void;
    vi.spyOn(api, 'chatMessages').mockReturnValue(new Promise((resolve) => { pageAnswer = resolve; }));
    chat.setVisible(true);
    await vi.advanceTimersByTimeAsync(5);
    ws.say({ t: 'delete', kind: 'workspace', ref: 'main', id: 1, by: 'moderator' });
    pageAnswer({ messages: [message(1, 'workspace', 'main'), message(2, 'workspace', 'main')], next: null });
    await vi.advanceTimersByTimeAsync(5);
    expect(chat.view().messages.find((item) => item.id === 1)?.deleted).toBe(true);
  });

  it.fails('preserves live frames during a wide reconnect catch-up', async () => {
    // CDX-44 P2: the wide-gap branch replaces the channel with paginated results and drops live frames (src/chat.ts:375-398).
    // Fix: snapshot and merge frames received during pagination after replacing the stale history.
    const { chat, ws } = await readyHistory([message(1, 'workspace', 'main')]);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const answers: ((value: { messages: ChatMessage[]; next: number | null }) => void)[] = [];
    vi.spyOn(api, 'chatMessages').mockImplementation(() => new Promise((resolve) => { answers.push(resolve); }));
    ws.readyState = 3;
    ws.onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(500);
    const reconnect = lastSocket();
    reconnect.open();
    reconnect.say({ t: 'hello', readOnly: false, channels: [] });
    await vi.advanceTimersByTimeAsync(1);
    expect(answers).toHaveLength(1);
    answers[0]({ messages: [message(60, 'workspace', 'main')], next: 50 });
    await vi.advanceTimersByTimeAsync(1);
    expect(answers).toHaveLength(2);
    reconnect.say({ t: 'message', kind: 'workspace', ref: 'main', message: message(100, 'workspace', 'main') });
    const pages = [50, 40, 30, 20].map((id, index) => ({
      messages: [message(id, 'workspace', 'main')], next: [40, 30, 20, 10][index],
    }));
    for (const page of pages) {
      answers[answers.length - 1](page);
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(answers).toHaveLength(5);
    expect(chat.view().messages.map((item) => item.id)).toContain(100);
  });
});
