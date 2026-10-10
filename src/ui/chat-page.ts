import './chat-page.css';
import type { ChatChannelEntry } from '../api';
import { authState, chatAvailable } from '../auth';
import { channelUnread, fetchChannels, hasUnlisted, onChatBadge, openChat, watchChat, type BoardChat } from '../chat';
import { h, icon } from './dom';
import { announce } from './announce';
import { mountConversation } from './chat';
import { badgeText, channelHash, channelLabel, channelMeta, defaultChannel, groupChannels, type ChannelKind } from './chat-logic';
import { openChatNotifications } from './chat-prefs';
import { accountMe, createTopbar } from './topbar';

/** Below this width the list and the conversation are two screens, as the side tray and the home page already break. */
const PHONE = '(max-width: 860px)';
/** The list is fetched again at most this often when counts say a channel is missing from it. */
const REFETCH_MS = 4000;

type Selected = { kind: ChannelKind; ref: string };

const keyOf = (kind: string, ref: string) => `${kind}/${ref}`;

/**
 * The Chat page (docs/chat.md, Interface): the channels this person can talk in on the left (the workspace, their
 * teams, boards with recent chat) with unread badges, and the open conversation on the right. On a phone the list is the
 * first screen and the conversation the second, with a back button. Returns what to call when the page is left.
 */
export function renderChatPage(root: HTMLElement, selected: { kind?: ChannelKind; ref?: string }): () => void {
  document.title = 'Chat - Tabula';
  const auth = authState();
  const me = accountMe(auth);
  const meId = me?.user.id ?? '';
  const meName = me?.user.name ?? 'You';
  const life = new AbortController();
  const phone = window.matchMedia?.(PHONE);

  let entries: ChatChannelEntry[] = [];
  let loaded = false;
  let failed = false;
  let current: Selected | null = selected.kind && selected.ref ? { kind: selected.kind, ref: selected.ref } : null;
  let convLife: AbortController | null = null;
  const rows = new Map<string, { el: HTMLAnchorElement; badge: HTMLElement; entry: ChatChannelEntry }>();

  // ---------------------------------------------------------------- the list
  const status = h('p', { class: 'chat-list-status', role: 'status' });
  const listBody = h('div', { class: 'chat-list-body' });
  const prefs = h('button', { class: 'chat-prefs', type: 'button', onclick: () => openChatNotifications() }, 'Notifications');
  const list = h('nav', { class: 'chat-list', 'aria-label': 'Chat channels' }, listBody, status, h('div', { class: 'chat-list-foot' }, prefs));

  // ---------------------------------------------------------------- the conversation
  const back = h('a', { class: 'chat-back', href: '#/chat' }, icon('prev', 16), h('span', null, 'All channels'));
  back.addEventListener('click', (e) => {
    e.preventDefault();
    leave();
  });
  const title = h('h2', { class: 'chat-conv-title', tabindex: '-1' });
  const sub = h('p', { class: 'chat-conv-sub' });
  const openBoard = h('a', { class: 'btn small chat-open-board', hidden: true }, 'Open board');
  const head = h('header', { class: 'chat-conv-head' }, back, h('div', { class: 'chat-conv-titles' }, title, sub), openBoard);
  const panel = h('div', { class: 'chat-page-panel chat-panel' });
  const empty = h('div', { class: 'chat-conv-empty' }, h('p', null, 'Pick a channel to read it.'));
  const conv = h('section', { class: 'chat-conv', 'aria-label': 'Conversation' }, head, panel, empty);

  const main = h('main', { class: 'chat-page' }, h('h1', { class: 'sr-only' }, 'Chat'), list, conv);
  root.replaceChildren(createTopbar('chat', me), main);

  // ---------------------------------------------------------------- list drawing
  function unreadOf(e: ChatChannelEntry) {
    return channelUnread(e.kind, e.ref);
  }

  function paintBadge(el: HTMLElement, c: { unread: number; mentions: number }) {
    el.textContent = c.unread ? badgeText(c.unread) : '';
    el.classList.toggle('show', c.unread > 0);
    el.classList.toggle('mention', c.mentions > 0);
  }

  function paintRows() {
    for (const { el, badge, entry } of rows.values()) {
      const c = unreadOf(entry);
      paintBadge(badge, c);
      el.setAttribute('aria-label', channelLabel(entry, c));
    }
  }

  function drawList() {
    rows.clear();
    const sections = groupChannels(entries);
    listBody.replaceChildren(...sections.map((s) => h('section', { class: 'chat-section', 'aria-label': s.title },
      h('h2', { class: 'chat-section-title' }, s.title),
      h('ul', { class: 'chat-rows' }, ...s.entries.map((e) => {
        const badge = h('span', { class: 'chat-row-badge', 'aria-hidden': 'true' });
        const name = h('span', { class: 'chat-row-name' });
        name.textContent = e.name;
        const meta = h('span', { class: 'chat-row-meta' });
        meta.textContent = channelMeta(e, Date.now());
        const el = h('a', { class: 'chat-row', href: channelHash(e.kind, e.ref) }, h('span', { class: 'chat-row-text' }, name, meta), badge);
        el.addEventListener('click', (ev) => {
          if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
          ev.preventDefault();
          select({ kind: e.kind, ref: e.ref }, { push: true, focus: true });
        });
        rows.set(keyOf(e.kind, e.ref), { el, badge, entry: e });
        return h('li', null, el);
      })))));
    paintRows();
    markCurrent();
    status.textContent = failed ? 'Could not load the channels. Check your connection.' : loaded && entries.length === 0 ? 'No chats yet. Team and workspace conversations appear here.' : '';
    status.hidden = !status.textContent;
  }

  function markCurrent() {
    for (const [key, r] of rows) {
      const on = current !== null && key === keyOf(current.kind, current.ref);
      r.el.classList.toggle('on', on);
      if (on) r.el.setAttribute('aria-current', 'true');
      else r.el.removeAttribute('aria-current');
    }
  }

  // ---------------------------------------------------------------- selecting
  function entryOf(s: Selected): ChatChannelEntry | undefined {
    return entries.find((e) => e.kind === s.kind && e.ref === s.ref);
  }

  function stopConversation() {
    convLife?.abort();
    convLife = null;
    panel.replaceChildren();
  }

  function showConversation(s: Selected, opts: { focus: boolean }) {
    stopConversation();
    const entry = entryOf(s);
    const name = entry?.name ?? (s.kind === 'workspace' ? 'Workspace' : s.kind === 'team' ? 'Team' : 'Board');
    title.textContent = name;
    sub.textContent = s.kind === 'workspace' ? 'Everyone in the workspace' : s.kind === 'team'
      ? `${entry?.member === false ? 'You can read this team without being a member' : 'Members of this team'}${entry?.archived ? ' · archived, read only' : ''}`
      : 'Everyone who can open this board';
    openBoard.hidden = s.kind !== 'board';
    if (s.kind === 'board') openBoard.setAttribute('href', `#/b/${s.ref}`);
    document.title = `${name} - Chat - Tabula`;
    conv.classList.add('open');
    list.classList.add('away');
    empty.hidden = true;
    head.hidden = false;
    panel.hidden = false;
    convLife = new AbortController();
    const chat: BoardChat = openChat(s.kind, s.ref, convLife.signal);
    const view = mountConversation({ chat, id: `${s.kind}-${s.ref}`, panel, signal: convLife.signal, meId, meName, workspace: s.kind === 'workspace' });
    view.setOpen(true);
    announce(`${name}, ${s.kind === 'board' ? 'board chat' : s.kind === 'team' ? 'team chat' : 'workspace chat'}`);
    if (opts.focus) {
      if (phone?.matches) title.focus({ preventScroll: true });
      else view.focusComposer();
    }
  }

  function showNothing() {
    stopConversation();
    document.title = 'Chat - Tabula';
    conv.classList.remove('open');
    list.classList.remove('away');
    head.hidden = true;
    panel.hidden = true;
    empty.hidden = false;
  }

  function select(s: Selected, opts: { push: boolean; focus: boolean }) {
    current = s;
    if (opts.push) history.pushState(null, '', channelHash(s.kind, s.ref));
    markCurrent();
    showConversation(s, { focus: opts.focus });
  }

  function leave() {
    current = null;
    history.pushState(null, '', '#/chat');
    markCurrent();
    showNothing();
    rows.values().next().value?.el.focus();
  }

  // ---------------------------------------------------------------- loading
  let lastFetch = 0;
  let refetchTimer: ReturnType<typeof setTimeout> | null = null;

  async function load(first: boolean) {
    lastFetch = Date.now();
    try {
      entries = await fetchChannels();
      failed = false;
    } catch {
      failed = true;
    }
    if (life.signal.aborted) return;
    loaded = true;
    drawList();
    if (!first) return;
    if (current) select(current, { push: false, focus: false });
    else if (!phone?.matches) {
      const sections = groupChannels(entries);
      const pick = defaultChannel(sections, unreadOf);
      if (pick) select({ kind: pick.kind, ref: pick.ref }, { push: false, focus: false });
      else showNothing();
    } else showNothing();
  }

  // a count for a channel that is not listed (a board that just had its first message): fetch the list again, not too often
  const offBadge = onChatBadge(() => {
    if (life.signal.aborted) return;
    paintRows();
    if (!loaded || refetchTimer || !hasUnlisted(new Set(entries.map((e) => keyOf(e.kind, e.ref))))) return;
    refetchTimer = setTimeout(() => {
      refetchTimer = null;
      if (!life.signal.aborted) void load(false);
    }, Math.max(0, REFETCH_MS - (Date.now() - lastFetch)));
  });
  life.signal.addEventListener('abort', offBadge, { once: true });

  showNothing();
  if (chatAvailable()) {
    watchChat(life.signal);
    void load(true);
  } else {
    status.textContent = 'Chat is not turned on for this workspace.';
  }

  return () => {
    life.abort();
    stopConversation();
    if (refetchTimer) clearTimeout(refetchTimer);
  };
}
