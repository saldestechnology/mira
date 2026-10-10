import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../src/api';
import type { BoardChat, ChatView } from '../src/chat';
import { WORKSPACE_WELCOME, mountConversation } from '../src/ui/chat';
import { FakeElement, installFakeBrowser, textOf, type FakeBrowser } from './fake-dom';

// docs/chat.md: an empty workspace channel shows a centred block of three short lines (no picture) and the message box takes
// focus; any other empty channel keeps the one-line hint. Drawn into the fake DOM over a stub channel.

const msg = (id: number): ChatMessage => ({
  id, kind: 'workspace', ref: 'main', authorId: 'ana', authorName: 'Ana', clientId: `client-${id}-xx`, text: `m${id}`, replyTo: null, objectId: null, mentions: [],
  createdAt: 1_700_000_000_000 + id, editedAt: null, deleted: false, deletedBy: null,
});

let browser: FakeBrowser;
let view: ChatView;

const chat = (): BoardChat => ({
  view: () => view,
  onChange: () => () => undefined,
  setVisible: () => undefined,
  loadOlder: async () => undefined,
  send: () => undefined,
  retry: () => undefined,
  discard: () => undefined,
  edit: async () => undefined,
  remove: async () => undefined,
  react: async () => undefined,
  markRead: () => undefined,
});

function mount(messages: ChatMessage[], workspace: boolean, write = true) {
  view = {
    meId: 'me', messages, pending: [], access: { write, moderate: false, role: 'member', readOnly: false }, people: [], loading: false,
    loadingOlder: false, hasOlder: false, savedOnly: false, lost: false, online: true, signedOut: false, newAfter: null, unread: 0, mentions: 0, error: null,
  };
  const panel = browser.document.createElement('div') as unknown as FakeElement;
  const conv = mountConversation({ chat: chat(), id: 'workspace-main', panel: panel as unknown as HTMLElement, signal: new AbortController().signal, meId: 'me', meName: 'Me', workspace });
  conv.setOpen(true);
  return panel;
}

beforeEach(() => {
  browser = installFakeBrowser();
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { fn(); return 0; });
  vi.stubGlobal('window', { setTimeout, clearTimeout, addEventListener: () => undefined, removeEventListener: () => undefined, innerWidth: 1024, innerHeight: 800, matchMedia: () => ({ matches: false }) });
});
afterEach(() => {
  vi.unstubAllGlobals();
  browser.uninstall();
});

describe('the empty workspace channel', () => {
  it('shows the three short lines, centred, and focuses the message box', () => {
    const panel = mount([], true);
    const older = panel.querySelector('.chat-older')!;
    expect(older.classList.contains('chat-welcome')).toBe(true);
    expect(panel.querySelector('.chat-log')!.classList.contains('has-welcome')).toBe(true);
    expect(textOf(older.querySelector('.chat-welcome-title')!)).toBe('Workspace chat');
    expect(textOf(older)).toBe(`${WORKSPACE_WELCOME.title}${WORKSPACE_WELCOME.lines.join('')}`);
    expect(WORKSPACE_WELCOME.lines).toEqual(['Everyone in this workspace can read this channel.', 'Say hello.']);
    expect(browser.document.activeElement).toBe(panel.querySelector('textarea.chat-input'));
    expect(panel.querySelector('img, svg')).toBeNull();
  });

  it('is not shown in another channel, or once there are messages', () => {
    const other = mount([], false);
    expect(other.querySelector('.chat-older')!.classList.contains('chat-welcome')).toBe(false);
    expect(textOf(other.querySelector('.chat-older')!)).toBe('No messages yet. Say hello.');
    const busy = mount([msg(1)], true);
    expect(busy.querySelector('.chat-older')!.classList.contains('chat-welcome')).toBe(false);
    expect(busy.querySelector('.chat-log')!.classList.contains('has-welcome')).toBe(false);
  });
});

describe('the Chat page with no channel picked', () => {
  const css = readFileSync(new URL('../src/ui/chat-page.css', import.meta.url), 'utf8');
  const pageSource = readFileSync(new URL('../src/ui/chat-page.ts', import.meta.url), 'utf8');

  it('says it in the tray text colour, centred, as bold as the welcome heading, with theme variables only', () => {
    const box = /\.chat-conv-empty\s*\{([^}]*)\}/.exec(css)![1];
    expect(box).toContain('color: var(--tray-text)');
    expect(box).toContain('text-align: center');
    expect(box).toContain('place-items: center');
    const line = /\.chat-conv-empty p\s*\{([^}]*)\}/.exec(css)![1];
    expect(line).toMatch(/font-weight:\s*700/);
    expect(box + line).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(/);
    expect(pageSource).toContain("'Pick a channel to read it.'");
  });
});
