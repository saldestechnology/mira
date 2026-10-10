// Board chat on the client (docs/chat.md): the REST calls, the one /chat socket of this tab, the outbox and the
// offline copy. src/ui/chat.ts draws it; src/ui/chat-logic.ts holds the rules that need no I/O.
//
// The socket is one per tab, opened when a board with chat opens and kept across boards (the hub allows ten per
// person), and closed on sign-out. A board's channel is subscribed only while its Chat tab is open; with the tab
// closed the badge comes from the `hello` summary and the `unread` frames, which carry counts and never text.

import { ApiError, api, type ChatChannelEntry, type ChatChannelInfo, type ChatMessage } from './api';
import { authState, chatAvailable, onAuth } from './auth';
import * as cache from './chat-cache';
import {
  CACHE_PER_CHANNEL, KEEP_IN_LIST, PAGE, applyDelete, backoffMs, classifyFailure, countUnread, delivered, enqueue, mergeMessages,
  newClientId, newestId, nextToSend, oldestId, outboxItem, parseMention, removeItem, revive, trimOldest, updateItem, withReactions,
  type ChatAccess, type MentionNotice, type OutboxItem,
} from './ui/chat-logic';

export type ChatKind = 'board' | 'team' | 'workspace';
const KINDS: readonly ChatKind[] = ['board', 'team', 'workspace'];
const PING_MS = 25_000;
const PONG_WAIT_MS = 10_000;
const READ_THROTTLE_MS = 2000;
/** After a reconnect, pages fetched backwards to close the gap before the list starts over from the newest page. */
const CATCH_UP_PAGES = 5;
/** Too many sockets of this person (4429): try again much later. */
const CROWDED_MS = 60_000;

export interface ChatView {
  meId: string;
  messages: ChatMessage[];
  /** This person's unsent messages in this channel. */
  pending: OutboxItem[];
  access: ChatAccess | null;
  people: ChatChannelInfo['people'];
  loading: boolean;
  loadingOlder: boolean;
  hasOlder: boolean;
  /** The server could not be reached; the list is the copy saved in this browser. */
  savedOnly: boolean;
  /** Access to the channel was lost while it was open. */
  lost: boolean;
  /** The socket and the API can be reached: edits and deletes are possible. */
  online: boolean;
  signedOut: boolean;
  /** The read marker when the tab was opened: the "New messages" line goes after it. */
  newAfter: number | null;
  unread: number;
  mentions: number;
  error: string | null;
}

interface Channel {
  key: string;
  kind: ChatKind;
  ref: string;
  messages: ChatMessage[];
  next: number | null;
  info: ChatChannelInfo | null;
  lastRead: number | null;
  newAfter: number | null;
  loading: boolean;
  /** Socket frames to reconcile after a newest page or catch-up finishes. */
  arrived: Map<number, Arrival>;
  loadTask: Promise<void> | null;
  catchingUp: boolean;
  loadingOlder: boolean;
  savedOnly: boolean;
  fetchOk: boolean;
  lost: boolean;
  error: string | null;
  visible: boolean;
  readPut: number;
  readTimer: ReturnType<typeof setTimeout> | null;
  listeners: Set<() => void>;
}

interface Arrival {
  message?: ChatMessage;
  deletedBy?: 'author' | 'moderator';
  reactions?: { emoji: string; userIds: string[] }[];
}

type SocketState = 'idle' | 'connecting' | 'open' | 'stopped';

let socket: WebSocket | null = null;
let socketState: SocketState = 'idle';
let attempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let pongTimer: ReturnType<typeof setTimeout> | null = null;
let signedOut = false;
let workspaceReadOnly = false;
const unread = new Map<string, { unread: number; mentions: number; lastId?: number }>();
const channels = new Map<string, Channel>();
const badgeListeners = new Set<() => void>();
const mentionListeners = new Set<(n: MentionNotice) => void>();
let outbox: OutboxItem[] = [];
let outboxLoad: Promise<void> | null = null;
let flushing = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushAttempt = 0;
/** Bumped by resetChat, so an answer that arrives after sign-out changes nothing. */
let generation = 0;
let windowHooked = false;
/** Pages that want the badges without a channel open (the Boards page, the Chat page): the socket stays up for them. */
let watchers = 0;
/** A hello after an earlier one means a reconnect: open channels catch up on what was said meanwhile. */
let helloSeen = false;

const keyOf = (kind: string, ref: string) => `${kind}/${ref}`;
const isKind = (k: unknown): k is ChatKind => typeof k === 'string' && (KINDS as readonly string[]).includes(k);

function meId(): string {
  const auth = authState();
  return (auth.mode === 'signed-in' || auth.mode === 'offline') && auth.me ? auth.me.user.id : '';
}

function rememberArrival(ch: Channel, id: number, patch: Arrival) {
  const arrival = ch.arrived.get(id) ?? {};
  if (patch.message) {
    arrival.message = arrival.message ? mergeMessages([arrival.message], [patch.message])[0] : patch.message;
  }
  if (patch.deletedBy) arrival.deletedBy = patch.deletedBy;
  if (patch.reactions) arrival.reactions = patch.reactions;
  ch.arrived.set(id, arrival);
}

function reconcileArrivals(messages: ChatMessage[], arrived: Map<number, Arrival>): ChatMessage[] {
  let result = mergeMessages(messages, [...arrived.values()].flatMap((a) => a.message ? [a.message] : []));
  for (const [id, arrival] of arrived) {
    if (arrival.deletedBy) result = applyDelete(result, id, arrival.deletedBy);
    if (arrival.reactions) result = withReactions(result, id, arrival.reactions);
  }
  return result;
}

const browserOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;

function emit(ch?: Channel) {
  const targets = ch ? [ch] : [...channels.values()];
  for (const c of targets) for (const fn of Array.from(c.listeners)) fn();
  for (const fn of Array.from(badgeListeners)) fn();
}

// ---------------------------------------------------------------- socket

function socketUrl(): string | null {
  if (typeof location === 'undefined' || (location.protocol !== 'http:' && location.protocol !== 'https:')) return null;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/chat`;
}

function sendFrame(frame: Record<string, unknown>) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
}

function stopTimers() {
  if (pingTimer) clearInterval(pingTimer);
  if (pongTimer) clearTimeout(pongTimer);
  pingTimer = null;
  pongTimer = null;
}

function scheduleReconnect(ms: number) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, ms);
}

function hookWindow() {
  if (windowHooked || typeof window === 'undefined') return;
  windowHooked = true;
  window.addEventListener('online', () => {
    if (socketState === 'idle' && (channels.size || watchers)) {
      attempt = 0;
      connect();
    }
    void flush();
  });
  window.addEventListener('offline', () => emit());
}

function connect() {
  if (socketState !== 'idle' || !chatAvailable() || typeof WebSocket === 'undefined') return;
  const url = socketUrl();
  if (!url) return;
  hookWindow();
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    scheduleReconnect(backoffMs(attempt++));
    return;
  }
  socket = ws;
  socketState = 'connecting';
  ws.onopen = () => {
    if (socket !== ws) return;
    pingTimer = setInterval(() => {
      sendFrame({ t: 'ping' });
      if (!pongTimer) pongTimer = setTimeout(() => ws.close(), PONG_WAIT_MS);
    }, PING_MS);
  };
  ws.onmessage = (e) => {
    if (socket !== ws || typeof e.data !== 'string') return;
    let frame: unknown;
    try {
      frame = JSON.parse(e.data);
    } catch {
      return;
    }
    if (frame && typeof frame === 'object') onFrame(frame as Record<string, unknown>);
  };
  ws.onclose = (e) => {
    if (socket !== ws) return;
    socket = null;
    stopTimers();
    socketState = 'idle';
    if (e.code === 4401) {
      socketState = 'stopped';
      signedOut = true;
    } else if (channels.size || watchers) {
      scheduleReconnect(e.code === 4429 ? CROWDED_MS : backoffMs(attempt++));
    }
    emit();
  };
}

function onFrame(f: Record<string, unknown>) {
  const t = f.t;
  if (t === 'pong') {
    if (pongTimer) clearTimeout(pongTimer);
    pongTimer = null;
    return;
  }
  if (t === 'hello') {
    socketState = 'open';
    attempt = 0;
    const reconnect = helloSeen;
    helloSeen = true;
    signedOut = false;
    workspaceReadOnly = f.readOnly === true;
    unread.clear();
    for (const c of Array.isArray(f.channels) ? f.channels : []) {
      if (c && isKind(c.kind) && typeof c.ref === 'string') unread.set(keyOf(c.kind, c.ref), { unread: Number(c.unread) || 0, mentions: Number(c.mentions) || 0, lastId: Number(c.lastId) || 0 });
    }
    for (const ch of channels.values()) {
      if (ch.info) ch.info = { ...ch.info, access: withReadOnly(ch.info.access, workspaceReadOnly) };
      if (!ch.visible) continue;
      sendFrame({ t: 'sub', kind: ch.kind, ref: ch.ref });
      if (ch.loading) continue;
      if (!ch.fetchOk) void load(ch);
      else if (reconnect) void catchUp(ch);
    }
    void flush();
    emit();
    return;
  }
  if (!isKind(f.kind) || typeof f.ref !== 'string') return;
  const key = keyOf(f.kind, f.ref);
  const ch = channels.get(key);
  if (t === 'mention') {
    const notice = parseMention(f);
    if (notice) for (const fn of Array.from(mentionListeners)) fn(notice);
    return;
  }
  if (t === 'unread') {
    unread.set(key, { ...unread.get(key), unread: Number(f.unread) || 0, mentions: Number(f.mentions) || 0 });
    emit();
    return;
  }
  if (t === 'read') {
    const lastId = Number(f.lastId) || 0;
    unread.set(key, { unread: 0, mentions: 0, lastId });
    if (ch) ch.lastRead = Math.max(ch.lastRead ?? 0, lastId);
    emit();
    return;
  }
  if (!ch) return;
  if ((t === 'message' || t === 'edit') && isMessage(f.message)) {
    if (!ch.visible) return;
    if (ch.loading || ch.catchingUp) rememberArrival(ch, f.message.id, { message: f.message });
    ch.messages = keepBounded(ch, mergeMessages(ch.messages, [f.message]));
    settleDelivered([f.message]);
    saveChannel(ch);
    emit(ch);
  } else if (t === 'reaction' && typeof f.id === 'number' && Array.isArray(f.reactions)) {
    const reactions = f.reactions as { emoji: string; userIds: string[] }[];
    if (ch.loading || ch.catchingUp) rememberArrival(ch, f.id, { reactions });
    ch.messages = withReactions(ch.messages, f.id, reactions);
    saveChannel(ch);
    emit(ch);
  } else if (t === 'delete' && typeof f.id === 'number') {
    const deletedBy = f.by === 'moderator' ? 'moderator' : 'author';
    if (ch.loading || ch.catchingUp) rememberArrival(ch, f.id, { deletedBy });
    ch.messages = applyDelete(ch.messages, f.id, deletedBy);
    saveChannel(ch);
    emit(ch);
  } else if (t === 'closed' || (t === 'denied' && f.reason !== 'too_many')) {
    ch.lost = true;
    emit(ch);
  } else if (t === 'readonly') {
    workspaceReadOnly = f.on === true;
    for (const c of channels.values()) {
      if (c.info) c.info = { ...c.info, access: withReadOnly(c.info.access, workspaceReadOnly) };
      if (!workspaceReadOnly && c.visible) void refreshInfo(c);
    }
    emit();
  }
}

/** A read-only workspace refuses writes and moderation; reading goes on. Lifting it needs the server's answer again. */
function withReadOnly(access: ChatChannelInfo['access'], on: boolean): ChatChannelInfo['access'] {
  return on ? { ...access, readOnly: true, write: false, moderate: false } : access;
}

const isMessage = (m: unknown): m is ChatMessage =>
  !!m && typeof m === 'object' && typeof (m as ChatMessage).id === 'number' && typeof (m as ChatMessage).text === 'string';

// ---------------------------------------------------------------- loading

function keepBounded(ch: Channel, list: ChatMessage[]): ChatMessage[] {
  if (list.length <= KEEP_IN_LIST) return list;
  const kept = trimOldest(list);
  ch.next = oldestId(kept);
  return kept;
}

function saveChannel(ch: Channel) {
  const userId = meId();
  if (!ch.fetchOk || !userId) return;
  void cache.writeChannel(userId, { key: ch.key, messages: ch.messages.slice(-CACHE_PER_CHANNEL), savedAt: Date.now() });
}

async function refreshInfo(ch: Channel) {
  const gen = generation;
  try {
    const info = await api.chatChannel(ch.kind, ch.ref);
    if (gen !== generation) return;
    ch.info = { ...info, access: withReadOnly(info.access, workspaceReadOnly || info.access.readOnly) };
    ch.lost = false;
  } catch (err) {
    if (gen !== generation) return;
    if (err instanceof ApiError && err.status === 404) ch.lost = true;
  }
  emit(ch);
}

/** Opening the tab: the saved copy for the confirmed account, then the channel and newest page. */
function load(ch: Channel): Promise<void> {
  if (ch.loadTask) return ch.loadTask;
  const task = loadChannel(ch);
  ch.loadTask = task;
  void task.then(() => {
    if (ch.loadTask === task) ch.loadTask = null;
  }, () => {
    if (ch.loadTask === task) ch.loadTask = null;
  });
  return task;
}

async function loadChannel(ch: Channel) {
  const gen = generation;
  const userId = meId();
  ch.loading = true;
  ch.arrived = new Map();
  ch.error = null;
  emit(ch);
  try {
    if (!userId) return;
    if (!ch.messages.length) {
      const saved = await cache.readChannel(userId, ch.key);
      if (gen !== generation || userId !== meId()) return;
      if (saved && !ch.messages.length) ch.messages = saved.messages;
      emit(ch);
    }
    const [info, page, summary] = await Promise.all([
      api.chatChannel(ch.kind, ch.ref),
      api.chatMessages(ch.kind, ch.ref, { limit: PAGE }),
      api.chatUnread().catch(() => null),
    ]);
    if (gen !== generation || userId !== meId()) return;
    ch.info = { ...info, access: withReadOnly(info.access, workspaceReadOnly || info.access.readOnly) };
    // Saved history is provisional until this account's server answers. Keep socket arrivals and discard anything purged there.
    ch.messages = reconcileArrivals(page.messages, ch.arrived);
    ch.arrived.clear();
    ch.next = page.next;
    ch.fetchOk = true;
    ch.savedOnly = false;
    ch.lost = false;
    const entry = summary?.channels.find((c) => c.kind === ch.kind && c.ref === ch.ref);
    if (entry) unread.set(ch.key, { unread: entry.unread, mentions: entry.mentions, lastId: entry.lastId });
    else unread.set(ch.key, { unread: 0, mentions: 0, lastId: newestId(ch.messages) });
    ch.lastRead = entry ? entry.lastId : newestId(ch.messages);
    if (ch.newAfter === null && entry && entry.unread > 0) ch.newAfter = entry.lastId;
    settleDelivered(ch.messages);
    saveChannel(ch);
  } catch (err) {
    if (gen !== generation || userId !== meId()) return;
    ch.fetchOk = false;
    if (err instanceof ApiError && err.status === 429) {
      // asked too often (the server limits these reads per person): try again when it says, still loading meanwhile
      const wait = typeof err.facts.retryAfter === 'number' ? err.facts.retryAfter : 5;
      setTimeout(() => {
        if (gen === generation && ch.visible && !ch.fetchOk && !ch.loading) void load(ch);
      }, Math.max(1, wait) * 1000);
      ch.savedOnly = ch.messages.length > 0;
    } else if (err instanceof ApiError && err.status === 404) ch.lost = true;
    else if (err instanceof ApiError && err.status === 401) signedOut = true;
    else ch.savedOnly = true;
    if (ch.savedOnly && !ch.messages.length) ch.error = 'Chat could not be reached and nothing is saved on this device yet.';
  } finally {
    if (gen === generation) {
      ch.loading = false;
      emit(ch);
    }
  }
}

/** After a reconnect: everything after the last known id, merged by id, so nothing said meanwhile is missing. */
async function catchUp(ch: Channel) {
  if (ch.loading || ch.catchingUp) return;
  const gen = generation;
  const userId = meId();
  if (!userId) return;
  const known = newestId(ch.messages);
  ch.catchingUp = true;
  ch.arrived = new Map();
  try {
    let fetched: ChatMessage[] = [];
    let next: number | null = null;
    let before: number | undefined;
    for (let i = 0; i < CATCH_UP_PAGES; i++) {
      const page = await api.chatMessages(ch.kind, ch.ref, { limit: PAGE, before });
      if (gen !== generation || userId !== meId()) return;
      fetched = mergeMessages(fetched, page.messages);
      next = page.next;
      if (!page.messages.length || next === null || oldestId(page.messages) <= known + 1) break;
      before = oldestId(page.messages);
    }
    const authoritative = next === null || fetched.length === 0;
    const closed = authoritative || oldestId(fetched) <= known + 1;
    let reconciled: ChatMessage[];
    if (closed) {
      // Reaching the retained-history boundary makes this page set authoritative: old cached ids may have been purged.
      reconciled = authoritative ? fetched : mergeMessages(ch.messages, fetched);
    } else {
      // the gap is too wide to fill: start over from the newest pages
      reconciled = fetched;
      ch.next = next;
    }
    ch.messages = keepBounded(ch, reconcileArrivals(reconciled, ch.arrived));
    ch.arrived.clear();
    ch.fetchOk = true;
    ch.savedOnly = false;
    settleDelivered(ch.messages);
    saveChannel(ch);
  } catch {
    if (gen !== generation) return;
  } finally {
    if (gen === generation) {
      ch.catchingUp = false;
      ch.arrived.clear();
    }
  }
  if (gen === generation && userId === meId()) emit(ch);
}

// ---------------------------------------------------------------- outbox

function persist(item: OutboxItem | undefined) {
  const userId = meId();
  if (item && userId) void cache.putOutbox(userId, item);
}

function setItem(clientId: string, patch: Partial<OutboxItem>) {
  outbox = updateItem(outbox, clientId, patch);
  persist(outbox.find((o) => o.clientId === clientId));
}

function dropItem(clientId: string) {
  outbox = removeItem(outbox, clientId);
  const userId = meId();
  if (userId) void cache.deleteOutbox(userId, clientId);
}

/** Messages the server has: their outbox entries go (a send whose answer was lost shows up as a frame or in a page). */
function settleDelivered(messages: ChatMessage[]) {
  for (const item of delivered(outbox, messages, meId())) {
    if (item.state !== 'sending') dropItem(item.clientId);
  }
}

function ensureOutbox(): Promise<void> {
  const gen = generation;
  const userId = meId();
  if (!userId) return Promise.resolve();
  outboxLoad ??= cache.readOutbox(userId).then((saved) => {
    if (gen !== generation || userId !== meId()) return;
    const merged = revive(saved).reduce((list, item) => enqueue(list, item), outbox);
    outbox = merged;
    emit();
    void flush();
  });
  return outboxLoad;
}

function scheduleFlush(ms: number) {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, ms);
}

/** Sends the outbox oldest first, one at a time. A refusal for good stays with its reason; anything else waits. */
async function flush() {
  if (flushing || !browserOnline()) return;
  const userId = meId();
  if (!userId) return;
  flushing = true;
  const gen = generation;
  try {
    for (;;) {
      if (gen !== generation || userId !== meId() || !browserOnline()) break;
      const item = nextToSend(outbox, Date.now());
      if (!item) break;
      setItem(item.clientId, { state: 'sending', reason: undefined, waitUntil: undefined });
      emit();
      try {
        const { message } = await api.chatSend(item.kind, item.ref, { clientId: item.clientId, text: item.text, replyTo: item.replyTo, objectId: item.objectId });
        if (gen !== generation) break;
        dropItem(item.clientId);
        flushAttempt = 0;
        const ch = channels.get(`${item.kind}/${item.ref}`);
        if (ch?.visible) ch.messages = keepBounded(ch, mergeMessages(ch.messages, [message]));
        if (ch) saveChannel(ch);
        emit();
      } catch (err) {
        if (gen !== generation) break;
        const failure = err instanceof ApiError ? classifyFailure(err.status, err.code, typeof err.facts.retryAfter === 'number' ? err.facts.retryAfter : undefined) : classifyFailure(0, 'network');
        if (failure.kind === 'permanent') {
          setItem(item.clientId, { state: 'blocked', reason: failure.reason });
          emit();
          continue;
        }
        if (failure.kind === 'wait') {
          setItem(item.clientId, { state: 'queued', reason: 'Slow down a moment', waitUntil: Date.now() + failure.ms });
          scheduleFlush(failure.ms);
        } else if (failure.kind === 'signed-out') {
          signedOut = true;
          setItem(item.clientId, { state: 'failed', reason: 'sign in again to send it' });
        } else {
          setItem(item.clientId, { state: 'failed', reason: undefined });
          scheduleFlush(backoffMs(flushAttempt++));
        }
        emit();
        break;
      }
    }
  } finally {
    if (gen === generation) flushing = false;
  }
}

// ---------------------------------------------------------------- the badge without an open tab

/** Unread and mentions of one board's chat, for its button. */
export function boardUnread(boardId: string): { unread: number; mentions: number } {
  return channelUnread('board', boardId);
}

/** Unread and mentions of any channel, from what is open or from the counts the server sent. */
export function channelUnread(kind: ChatKind, ref: string): { unread: number; mentions: number } {
  const key = keyOf(kind, ref);
  const ch = channels.get(key);
  if (ch?.visible && ch.fetchOk && ch.lastRead !== null) {
    const me = meId();
    const after = ch.messages.filter((m) => m.id > (ch.lastRead ?? 0) && !m.deleted && m.authorId !== me);
    return { unread: after.length, mentions: after.filter((m) => m.mentions.some((p) => p.id === me)).length };
  }
  const entry = unread.get(key);
  return { unread: entry?.unread ?? 0, mentions: entry?.mentions ?? 0 };
}

// ---------------------------------------------------------------- one board's chat

export interface BoardChat {
  view(): ChatView;
  onChange(fn: () => void): () => void;
  /** The Chat tab opened or closed: subscribe and load, or unsubscribe. */
  setVisible(visible: boolean): void;
  loadOlder(): Promise<void>;
  send(text: string, replyTo: number | null, objectId?: string | null): void;
  retry(clientId: string): void;
  discard(clientId: string): void;
  edit(id: number, text: string): Promise<void>;
  remove(id: number): Promise<void>;
  /** Turns this person's reaction on a message on or off. */
  react(id: number, emoji: string, on: boolean): Promise<void>;
  /** The newest message is on screen: move the read marker there (at most every two seconds). */
  markRead(): void;
}

export function openBoardChat(boardId: string, signal: AbortSignal): BoardChat {
  return openChat('board', boardId, signal);
}

/** One channel of any kind: the same store, subscription, outbox and read marker as board chat. */
export function openChat(kind: ChatKind, ref: string, signal: AbortSignal): BoardChat {
  const key = keyOf(kind, ref);
  const ch: Channel = channels.get(key) ?? {
    key, kind, ref, messages: [], next: null, info: null, lastRead: null, newAfter: null, loading: false, arrived: new Map(), loadTask: null,
    catchingUp: false, loadingOlder: false,
    savedOnly: false, fetchOk: false, lost: false, error: null, visible: false, readPut: 0, readTimer: null, listeners: new Set(),
  };
  channels.set(key, ch);
  void ensureOutbox();
  connect();

  signal.addEventListener('abort', () => {
    if (ch.visible) sendFrame({ t: 'unsub', kind: ch.kind, ref: ch.ref });
    ch.visible = false;
    if (ch.readTimer) clearTimeout(ch.readTimer);
    ch.listeners.clear();
    channels.delete(key);
  }, { once: true });

  const online = () => browserOnline() && !signedOut && (socketState === 'open' || ch.fetchOk);

  function putRead() {
    ch.readTimer = null;
    if (!ch.visible || !ch.fetchOk) return;
    const newest = newestId(ch.messages);
    if (newest <= (ch.lastRead ?? 0) && (unread.get(key)?.unread ?? 0) === 0) return;
    ch.readPut = Date.now();
    ch.lastRead = Math.max(ch.lastRead ?? 0, newest);
    unread.set(key, { unread: 0, mentions: 0, lastId: ch.lastRead });
    emit(ch);
    api.chatRead(ch.kind, ch.ref, newest).catch(() => undefined);
  }

  return {
    view() {
      const me = meId();
      const counts = channelUnread(kind, ref);
      return {
        meId: me,
        messages: ch.messages,
        pending: outbox.filter((o) => o.kind === ch.kind && o.ref === ch.ref),
        access: ch.info?.access ?? null,
        people: ch.info?.people ?? [],
        loading: ch.loading,
        loadingOlder: ch.loadingOlder,
        hasOlder: ch.next !== null,
        savedOnly: ch.savedOnly,
        lost: ch.lost,
        online: online(),
        signedOut,
        newAfter: ch.newAfter,
        unread: ch.visible ? countUnread(ch.messages, ch.lastRead ?? newestId(ch.messages), me) : counts.unread,
        mentions: counts.mentions,
        error: ch.error,
      };
    },
    onChange(fn) {
      ch.listeners.add(fn);
      return () => ch.listeners.delete(fn);
    },
    setVisible(visible) {
      if (visible === ch.visible) return;
      ch.visible = visible;
      if (visible) {
        connect();
        sendFrame({ t: 'sub', kind: ch.kind, ref: ch.ref });
        void load(ch);
      } else {
        sendFrame({ t: 'unsub', kind: ch.kind, ref: ch.ref });
        ch.newAfter = null;
        if (ch.readTimer) clearTimeout(ch.readTimer);
        ch.readTimer = null;
        emit(ch);
      }
    },
    async loadOlder() {
      if (ch.loadingOlder || ch.next === null || !ch.fetchOk) return;
      const gen = generation;
      ch.loadingOlder = true;
      emit(ch);
      try {
        const page = await api.chatMessages(ch.kind, ch.ref, { limit: PAGE, before: oldestId(ch.messages) || undefined });
        if (gen !== generation) return;
        ch.messages = mergeMessages(ch.messages, page.messages);
        ch.next = page.next;
      } catch {
        /* the list stays as it is; scrolling up again tries again */
      } finally {
        if (gen === generation) {
          ch.loadingOlder = false;
          emit(ch);
        }
      }
    },
    send(text, replyTo, objectId = null) {
      const item = outboxItem({ clientId: newClientId(), kind: ch.kind, ref: ch.ref, text, replyTo, objectId, createdLocal: Date.now() });
      outbox = enqueue(outbox, item);
      persist(item);
      emit();
      void flush();
    },
    retry(clientId) {
      setItem(clientId, { state: 'queued', reason: undefined, waitUntil: undefined });
      flushAttempt = 0;
      emit();
      void flush();
    },
    discard(clientId) {
      const item = outbox.find((o) => o.clientId === clientId);
      if (!item || item.state === 'sending') return;
      dropItem(clientId);
      emit();
    },
    async edit(id, text) {
      const { message } = await api.chatEdit(id, text);
      ch.messages = mergeMessages(ch.messages, [message]);
      saveChannel(ch);
      emit(ch);
    },
    async remove(id) {
      await api.chatDelete(id);
      const by = ch.messages.find((m) => m.id === id)?.authorId === meId() ? 'author' : 'moderator';
      ch.messages = applyDelete(ch.messages, id, by);
      saveChannel(ch);
      emit(ch);
    },
    async react(id, emoji, on) {
      const { reactions } = await api.chatReact(id, emoji, on);
      ch.messages = withReactions(ch.messages, id, reactions);
      saveChannel(ch);
      emit(ch);
    },
    markRead() {
      if (!ch.visible || ch.readTimer) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const wait = READ_THROTTLE_MS - (Date.now() - ch.readPut);
      if (wait > 0) ch.readTimer = setTimeout(putRead, wait);
      else putRead();
    },
  };
}

/** The sum of unread messages and mentions over every channel this tab knows of, for the top bar's Chat link. */
export function totalUnread(): { unread: number; mentions: number } {
  const keys = new Set([...unread.keys(), ...channels.keys()]);
  let u = 0;
  let m = 0;
  for (const key of keys) {
    const slash = key.indexOf('/');
    const kind = key.slice(0, slash);
    if (!isKind(kind)) continue;
    const c = channelUnread(kind, key.slice(slash + 1));
    u += c.unread;
    m += c.mentions;
  }
  return { unread: u, mentions: m };
}

/** Whether a channel with unread messages is missing from `listed` (keys `kind/ref`): a page showing the list should refetch it. */
export function hasUnlisted(listed: ReadonlySet<string>): boolean {
  for (const [key, c] of unread) if (c.unread > 0 && !listed.has(key)) return true;
  return false;
}

/**
 * Keeps the socket up while a page that shows badges is open, so the counts arrive without a channel being open. The
 * page calls it once with its own signal. Without chat (open mode, the feature off) it does nothing.
 */
export function watchChat(signal: AbortSignal): void {
  if (!chatAvailable() || signal.aborted) return;
  watchers++;
  connect();
  signal.addEventListener('abort', () => {
    watchers = Math.max(0, watchers - 1);
  }, { once: true });
}

/**
 * The channel list of the Chat page. The counts it carries become what the badges show for channels that are not open
 * (the page's own open channel keeps counting from its messages), so the list, the top bar and the board rows agree.
 */
export async function fetchChannels(): Promise<ChatChannelEntry[]> {
  const gen = generation;
  const { channels: list } = await api.chatChannels();
  if (gen !== generation) return [];
  for (const c of list) {
    const key = keyOf(c.kind, c.ref);
    if (channels.get(key)?.visible) continue;
    unread.set(key, { unread: c.unread, mentions: c.mentions, lastId: c.lastId });
  }
  emit();
  return list;
}

/** A mention notice from the server (the app is open and the channel is not): the cards listen. Returns the way to stop. */
export function onMention(fn: (n: MentionNotice) => void): () => void {
  mentionListeners.add(fn);
  return () => mentionListeners.delete(fn);
}

/** Badge changes for any channel (the Chat button listens while its tab is closed). */
export function onChatBadge(fn: () => void): () => void {
  badgeListeners.add(fn);
  return () => badgeListeners.delete(fn);
}

/** Reset on sign-out or account change. An account id clears just its saved rows; no id clears the full browser cache. */
export function resetChat(userIdToClear?: string | null): Promise<void> {
  generation++;
  const ws = socket;
  socket = null;
  socketState = 'idle';
  stopTimers();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (flushTimer) clearTimeout(flushTimer);
  reconnectTimer = null;
  flushTimer = null;
  try {
    ws?.close(1000, 'signed out');
  } catch {
    /* already closed */
  }
  attempt = 0;
  flushAttempt = 0;
  helloSeen = false;
  signedOut = authState().mode === 'signed-out';
  workspaceReadOnly = false;
  unread.clear();
  for (const ch of channels.values()) {
    ch.messages = [];
    ch.info = null;
    ch.next = null;
    ch.loading = false;
    ch.loadTask = null;
    ch.catchingUp = false;
    ch.arrived.clear();
    ch.loadingOlder = false;
    ch.fetchOk = false;
    ch.savedOnly = false;
    ch.lost = false;
    ch.lastRead = null;
    ch.newAfter = null;
    ch.error = null;
    ch.readPut = 0;
    if (ch.readTimer) clearTimeout(ch.readTimer);
    ch.readTimer = null;
  }
  outbox = [];
  outboxLoad = null;
  flushing = false;
  emit();
  return userIdToClear ? cache.clearUserChatCache(userIdToClear) : cache.clearChatCache();
}

// Signing out anywhere in the app ends chat in this tab (auth.ts deletes the saved copy), and so does another person signing in:
// a socket the server bound to the first person's session would keep delivering their private messages to the second.
let chatUserId: string | null = null;
function reconnectVisibleChat() {
  if (chatAvailable() && (watchers > 0 || [...channels.values()].some((ch) => ch.visible))) connect();
}

onAuth((state) => {
  const nextId = (state.mode === 'signed-in' || state.mode === 'offline') && state.me ? state.me.user.id : null;
  if (!nextId) {
    const previousId = chatUserId;
    chatUserId = null;
    if (previousId && state.mode !== 'signed-out' && state.mode !== 'guest' && state.mode !== 'open') void resetChat(previousId);
    else if (state.mode === 'signed-out' || state.mode === 'guest' || state.mode === 'open') void resetChat();
    return;
  }
  if (chatUserId !== null && chatUserId !== nextId) {
    void resetChat(chatUserId);
    chatUserId = nextId;
    reconnectVisibleChat();
    return;
  }
  chatUserId = nextId;
  reconnectVisibleChat();
});
