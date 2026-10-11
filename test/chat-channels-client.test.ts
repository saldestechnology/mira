import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type ChatChannelEntry, type ChatMessage } from '../src/api';
import { initAuth, setSignedIn } from '../src/auth';
import {
  channelUnread, fetchChannels, hasUnlisted, onChatBadge, onMention, openChat, resetChat, totalUnread, watchChat,
} from '../src/chat';

// docs/chat.md, Unread and the Chat page: the client store keeps counts for every kind of channel from the socket's hello
// and unread frames, keeps the socket up for pages that only show badges, and opens team and workspace channels on the
// same code as board chat. A fake WebSocket stands in for the relay.

class FakeSocket {
  static all: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  say(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const channel = (kind: ChatChannelEntry['kind'], ref: string, extra: Partial<ChatChannelEntry> = {}): ChatChannelEntry =>
  ({ kind, ref, name: ref, write: true, unread: 0, mentions: 0, lastId: 0, lastAt: null, ...extra });
const message = (id: number, kind: string, ref: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id, kind, ref, authorId: 'ana', authorName: 'Ana', clientId: `client-${id}-xx`, text: `m${id}`, replyTo: null, objectId: null, mentions: [],
  createdAt: id, editedAt: null, deleted: false, deletedBy: null, ...extra,
});

const lastSocket = () => FakeSocket.all[FakeSocket.all.length - 1];
let life: AbortController;

beforeEach(async () => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('location', { protocol: 'https:', host: 'tabula.example', hash: '' });
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  await initAuth({
    config: async () => ({ authEnabled: true }) as never,
    me: async () => ({ user: { id: 'me', email: 'me@example.test', name: 'Me', role: 'member' }, teams: [], chat: true }) as never,
  });
  life = new AbortController();
});
afterEach(async () => {
  life.abort();
  await resetChat();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('counts for every kind of channel', () => {
  it('start from the hello summary and add up across board, team and workspace', () => {
    watchChat(life.signal);
    const ws = lastSocket();
    ws.open();
    ws.say({ t: 'hello', readOnly: false, channels: [
      { kind: 'board', ref: 'b1', unread: 2, mentions: 1, lastId: 5 },
      { kind: 'team', ref: 't1', unread: 3, mentions: 0, lastId: 9 },
      { kind: 'workspace', ref: 'main', unread: 4, mentions: 0, lastId: 2 },
    ] });
    expect(channelUnread('board', 'b1')).toEqual({ unread: 2, mentions: 1 });
    expect(channelUnread('team', 't1')).toEqual({ unread: 3, mentions: 0 });
    expect(channelUnread('workspace', 'main')).toEqual({ unread: 4, mentions: 0 });
    expect(channelUnread('team', 'other')).toEqual({ unread: 0, mentions: 0 });
    expect(totalUnread()).toEqual({ unread: 9, mentions: 1 });
  });

  it('follow unread and read frames, and ignore frames of a kind it does not know', () => {
    watchChat(life.signal);
    const ws = lastSocket();
    ws.open();
    ws.say({ t: 'hello', readOnly: false, channels: [] });
    ws.say({ t: 'unread', kind: 'team', ref: 't1', unread: 2, mentions: 1 });
    ws.say({ t: 'unread', kind: 'room', ref: 'x', unread: 9, mentions: 9 });
    expect(totalUnread()).toEqual({ unread: 2, mentions: 1 });
    ws.say({ t: 'read', kind: 'team', ref: 't1', lastId: 12 });
    expect(totalUnread()).toEqual({ unread: 0, mentions: 0 });
  });

  it('tell listeners when a count changes', () => {
    watchChat(life.signal);
    const ws = lastSocket();
    ws.open();
    const seen = vi.fn<() => void>();
    const off = onChatBadge(seen);
    ws.say({ t: 'hello', readOnly: false, channels: [] });
    seen.mockClear();
    ws.say({ t: 'unread', kind: 'workspace', ref: 'main', unread: 1, mentions: 0 });
    expect(seen).toHaveBeenCalled();
    off();
  });

  it('say when a channel with unread messages is missing from a list', () => {
    watchChat(life.signal);
    const ws = lastSocket();
    ws.open();
    ws.say({ t: 'hello', readOnly: false, channels: [{ kind: 'board', ref: 'b2', unread: 1, mentions: 0, lastId: 1 }] });
    expect(hasUnlisted(new Set(['team/t1']))).toBe(true);
    expect(hasUnlisted(new Set(['board/b2']))).toBe(false);
    ws.say({ t: 'read', kind: 'board', ref: 'b2', lastId: 1 });
    expect(hasUnlisted(new Set())).toBe(false);
  });
});

describe('keeping the socket up for a page of badges', () => {
  it('opens one socket for a watching page and reconnects after it drops', () => {
    watchChat(life.signal);
    expect(FakeSocket.all).toHaveLength(1);
    expect(lastSocket().url).toBe('wss://tabula.example/chat');
    lastSocket().open();
    lastSocket().onclose?.({ code: 1006 });
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all.length).toBeGreaterThan(1);
  });

  it('does not reconnect once nobody is watching and no channel is open', () => {
    watchChat(life.signal);
    lastSocket().open();
    life.abort();
    lastSocket().onclose?.({ code: 1006 });
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('does nothing where chat is not on', async () => {
    await initAuth({ config: async () => ({ authEnabled: true }) as never, me: async () => ({ user: { id: 'me', email: 'e', name: 'Me', role: 'member' }, teams: [] }) as never });
    watchChat(life.signal);
    expect(FakeSocket.all).toHaveLength(0);
  });
});

describe('fetching the channel list', () => {
  it('returns the list and lets its counts show for channels that are not open', async () => {
    vi.spyOn(api, 'chatChannels').mockResolvedValue({ channels: [
      channel('workspace', 'main', { unread: 2, lastId: 7 }),
      channel('team', 't1', { unread: 1, mentions: 1, lastId: 3 }),
    ] });
    const list = await fetchChannels();
    expect(list.map((c) => c.ref)).toEqual(['main', 't1']);
    expect(channelUnread('workspace', 'main')).toEqual({ unread: 2, mentions: 0 });
    expect(totalUnread()).toEqual({ unread: 3, mentions: 1 });
  });

  it('is empty after sign-out while an answer is on its way', async () => {
    let resolve!: (v: { channels: ChatChannelEntry[] }) => void;
    vi.spyOn(api, 'chatChannels').mockReturnValue(new Promise((r) => (resolve = r)));
    const pending = fetchChannels();
    await resetChat();
    resolve({ channels: [channel('team', 't1', { unread: 5 })] });
    expect(await pending).toEqual([]);
    expect(totalUnread()).toEqual({ unread: 0, mentions: 0 });
  });
});

describe('opening a team or workspace channel', () => {
  async function opened(kind: 'team' | 'workspace', ref: string) {
    vi.spyOn(api, 'chatChannel').mockResolvedValue({ kind, ref, access: { write: true, moderate: false, role: 'member', readOnly: false }, people: [{ id: 'ana', name: 'Ana' }] });
    vi.spyOn(api, 'chatMessages').mockResolvedValue({ messages: [message(1, kind, ref), message(2, kind, ref)], next: null });
    vi.spyOn(api, 'chatUnread').mockResolvedValue({ channels: [{ kind, ref, lastId: 1, unread: 1, mentions: 0 }] });
    const chat = openChat(kind, ref, life.signal);
    chat.setVisible(true);
    await vi.advanceTimersByTimeAsync(10);
    return chat;
  }

  it('subscribes with its own kind and loads it through the same calls as board chat', async () => {
    const chat = await opened('team', 't1');
    const ws = lastSocket();
    ws.open();
    ws.say({ t: 'hello', readOnly: false, channels: [] });
    expect(ws.sent).toContainEqual({ t: 'sub', kind: 'team', ref: 't1' });
    expect(api.chatMessages).toHaveBeenCalledWith('team', 't1', expect.anything());
    const view = chat.view();
    expect(view.messages.map((m) => m.id)).toEqual([1, 2]);
    expect(view.access).toMatchObject({ write: true });
    expect(view.unread).toBe(1);
  });

  it('takes live messages of its own channel and not those of another with the same ref', async () => {
    const chat = await opened('workspace', 'main');
    const ws = lastSocket();
    ws.open();
    ws.say({ t: 'hello', readOnly: false, channels: [] });
    ws.say({ t: 'message', kind: 'workspace', ref: 'main', message: message(3, 'workspace', 'main') });
    ws.say({ t: 'message', kind: 'team', ref: 'main', message: message(4, 'team', 'main') });
    expect(chat.view().messages.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it('sends the unsubscribe frame with its kind when it closes', async () => {
    const chat = await opened('team', 't9');
    const ws = lastSocket();
    ws.open();
    ws.say({ t: 'hello', readOnly: false, channels: [] });
    chat.setVisible(false);
    expect(ws.sent).toContainEqual({ t: 'unsub', kind: 'team', ref: 't9' });
  });
});

describe('reactions and mention notices', () => {
  async function opened(kind: 'team' | 'workspace' | 'board', ref: string) {
    vi.spyOn(api, 'chatChannel').mockResolvedValue({ kind, ref, access: { write: true, moderate: false, role: 'member', readOnly: false }, people: [] });
    vi.spyOn(api, 'chatMessages').mockResolvedValue({ messages: [message(1, kind, ref), message(2, kind, ref, { reactions: [{ emoji: '👍', userIds: ['ana'] }] })], next: null });
    vi.spyOn(api, 'chatUnread').mockResolvedValue({ channels: [] });
    const chat = openChat(kind, ref, life.signal);
    chat.setVisible(true);
    await vi.advanceTimersByTimeAsync(10);
    const ws = lastSocket();
    ws.open();
    ws.say({ t: 'hello', readOnly: false, channels: [] });
    return { chat, ws };
  }

  it('apply a reaction frame to the message in the open channel', async () => {
    const { chat, ws } = await opened('team', 't1');
    ws.say({ t: 'reaction', kind: 'team', ref: 't1', id: 1, emoji: '🎉', userId: 'ben', on: true, reactions: [{ emoji: '🎉', userIds: ['ben'] }] });
    expect(chat.view().messages.find((m) => m.id === 1)!.reactions).toEqual([{ emoji: '🎉', userIds: ['ben'] }]);
    expect(chat.view().messages.find((m) => m.id === 2)!.reactions).toEqual([{ emoji: '👍', userIds: ['ana'] }]);
  });

  it('ignore a reaction frame for another channel or without its list', async () => {
    const { chat, ws } = await opened('team', 't1');
    ws.say({ t: 'reaction', kind: 'team', ref: 'other', id: 1, emoji: '🎉', userId: 'ben', on: true, reactions: [{ emoji: '🎉', userIds: ['ben'] }] });
    ws.say({ t: 'reaction', kind: 'team', ref: 't1', id: 1, emoji: '🎉', userId: 'ben', on: true });
    expect(chat.view().messages.find((m) => m.id === 1)!.reactions).toBeUndefined();
  });

  it('send a reaction and keep what the server answers', async () => {
    const { chat } = await opened('team', 't1');
    const react = vi.spyOn(api, 'chatReact').mockResolvedValue({ id: 1, reactions: [{ emoji: '✅', userIds: ['me'] }] });
    await chat.react(1, '✅', true);
    expect(react).toHaveBeenCalledWith(1, '✅', true);
    expect(chat.view().messages.find((m) => m.id === 1)!.reactions).toEqual([{ emoji: '✅', userIds: ['me'] }]);
  });

  it('hand a mention frame to the listeners, for any channel, and stop when they let go', async () => {
    watchChat(life.signal);
    const ws = lastSocket();
    ws.open();
    ws.say({ t: 'hello', readOnly: false, channels: [] });
    const seen: unknown[] = [];
    const off = onMention((n) => seen.push(n));
    ws.say({ t: 'mention', kind: 'workspace', ref: 'main', id: 4, from: { id: 'ana', name: 'Ana' }, channel: 'Workspace', text: 'hello @Me' });
    ws.say({ t: 'mention', kind: 'room', ref: 'x', id: 4, from: { name: 'Ana' }, channel: 'x', text: 'bad kind' });
    ws.say({ t: 'mention', kind: 'team', ref: 't1', id: 'no', from: { name: 'Ana' }, channel: 'x', text: 'bad id' });
    expect(seen).toEqual([{ kind: 'workspace', ref: 'main', id: 4, from: 'Ana', channel: 'Workspace', text: 'hello @Me' }]);
    off();
    ws.say({ t: 'mention', kind: 'team', ref: 't1', id: 5, from: { name: 'Ana' }, channel: 'Design', text: 'later' });
    expect(seen).toHaveLength(1);
  });
});

describe('what is kept in this tab when the history or the person changes', () => {
  const ready = async (kind: 'team' | 'workspace', ref: string, page: ChatMessage[]) => {
    vi.spyOn(api, 'chatChannel').mockResolvedValue({ kind, ref, access: { write: true, moderate: false, role: 'member', readOnly: false }, people: [] });
    vi.spyOn(api, 'chatUnread').mockResolvedValue({ channels: [] });
    vi.spyOn(api, 'chatMessages').mockResolvedValue({ messages: page, next: null });
    const chat = openChat(kind, ref, life.signal);
    chat.setVisible(true);
    await vi.advanceTimersByTimeAsync(10);
    return chat;
  };

  it('drops what retention or erasure removed: an empty successful page empties the saved copy', async () => {
    const chat = await ready('workspace', 'main', [message(1, 'workspace', 'main'), message(2, 'workspace', 'main')]);
    expect(chat.view().messages.map((m) => m.id)).toEqual([1, 2]);
    chat.setVisible(false);
    vi.spyOn(api, 'chatMessages').mockResolvedValue({ messages: [], next: null });
    chat.setVisible(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(chat.view().messages).toEqual([]);
  });

  it('keeps a message that arrived on the socket while the page was on its way, and nothing else saved', async () => {
    const chat = await ready('workspace', 'main', [message(1, 'workspace', 'main'), message(2, 'workspace', 'main')]);
    const ws = lastSocket();
    ws.open();
    ws.say({ t: 'hello', readOnly: false, channels: [] });
    chat.setVisible(false);
    let answer!: (v: { messages: ChatMessage[]; next: number | null }) => void;
    vi.spyOn(api, 'chatMessages').mockReturnValue(new Promise((r) => (answer = r)));
    chat.setVisible(true);
    await vi.advanceTimersByTimeAsync(5);
    ws.say({ t: 'message', kind: 'workspace', ref: 'main', message: message(9, 'workspace', 'main') });
    answer({ messages: [message(5, 'workspace', 'main')], next: null });
    await vi.advanceTimersByTimeAsync(5);
    expect(chat.view().messages.map((m) => m.id)).toEqual([5, 9]);
  });

  it('closes the socket and forgets the first person when another one signs in in the same tab', async () => {
    watchChat(life.signal);
    const first = lastSocket();
    first.open();
    first.say({ t: 'hello', readOnly: false, channels: [{ kind: 'team', ref: 't1', unread: 3, mentions: 1, lastId: 9 }] });
    expect(totalUnread()).toEqual({ unread: 3, mentions: 1 });
    setSignedIn({ user: { id: 'someone-else', email: 'else@example.test', name: 'Else', role: 'member' }, teams: [], chat: true } as never);
    await vi.advanceTimersByTimeAsync(5);
    expect(first.readyState).toBe(3);
    expect(totalUnread()).toEqual({ unread: 0, mentions: 0 });
  });

  it('keeps the socket when the same person signs in again', async () => {
    watchChat(life.signal);
    const first = lastSocket();
    first.open();
    first.say({ t: 'hello', readOnly: false, channels: [{ kind: 'team', ref: 't1', unread: 3, mentions: 1, lastId: 9 }] });
    setSignedIn({ user: { id: 'me', email: 'me@example.test', name: 'Me', role: 'member' }, teams: [], chat: true } as never);
    await vi.advanceTimersByTimeAsync(5);
    expect(first.readyState).toBe(1);
    expect(totalUnread()).toEqual({ unread: 3, mentions: 1 });
  });
});
