import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../src/api';
import type { BoardChat, ChatView } from '../src/chat';
import { mountConversation } from '../src/ui/chat';
import { FakeElement, FakeEvent, installFakeBrowser, type FakeBrowser } from './fake-dom';

type ScrollLog = FakeElement & { scrollTop: number; scrollHeight: number; clientHeight: number };

const msg = (id: number): ChatMessage => ({
  id,
  kind: 'board',
  ref: 'b1',
  authorId: 'ana',
  authorName: 'Ana',
  clientId: 'client-' + id + '-xx',
  text: 'm' + id,
  replyTo: null,
  objectId: null,
  mentions: [],
  createdAt: Date.UTC(2025, 0, 10, 12, 0, id),
  editedAt: null,
  deleted: false,
  deletedBy: null,
});

let browser: FakeBrowser;
let view: ChatView;
let markRead: ReturnType<typeof vi.fn<() => void>>;
let loadOlder: ReturnType<typeof vi.fn<() => Promise<void>>>;
let offsetTopDescriptor: PropertyDescriptor | undefined;
let offsetHeightDescriptor: PropertyDescriptor | undefined;

function mount(messages: ChatMessage[]) {
  view = {
    meId: 'me',
    messages,
    pending: [],
    access: { write: true, moderate: false, role: 'member', readOnly: false },
    people: [],
    loading: false,
    loadingOlder: false,
    hasOlder: true,
    savedOnly: false,
    lost: false,
    online: true,
    signedOut: false,
    newAfter: null,
    unread: 0,
    mentions: 0,
    error: null,
  };
  markRead = vi.fn<() => void>();
  loadOlder = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const panel = browser.document.createElement('div') as unknown as FakeElement;
  const chat: BoardChat = {
    view: () => view,
    onChange: () => () => undefined,
    setVisible: () => undefined,
    loadOlder,
    send: () => undefined,
    retry: () => undefined,
    discard: () => undefined,
    edit: async () => undefined,
    remove: async () => undefined,
    react: async () => undefined,
    markRead,
  };
  const controller = new AbortController();
  const conv = mountConversation({
    chat,
    id: 'b1',
    panel: panel as unknown as HTMLElement,
    signal: controller.signal,
    meId: 'me',
    meName: 'Me',
  });
  const log = panel.querySelector('.chat-log') as ScrollLog;
  Object.defineProperty(log, 'scrollTop', { configurable: true, writable: true, value: 0 });
  Object.defineProperty(log, 'clientHeight', { configurable: true, value: 80 });
  Object.defineProperty(log, 'scrollHeight', {
    configurable: true,
    get: () => log.children.length * 40,
  });
  conv.setOpen(true);
  return { panel, log, conv, controller };
}

beforeEach(() => {
  browser = installFakeBrowser();
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => {
    fn();
    return 0;
  });
  offsetTopDescriptor = Object.getOwnPropertyDescriptor(FakeElement.prototype, 'offsetTop');
  offsetHeightDescriptor = Object.getOwnPropertyDescriptor(FakeElement.prototype, 'offsetHeight');
  Object.defineProperty(FakeElement.prototype, 'offsetTop', {
    configurable: true,
    get: function (this: FakeElement) {
      return this.parentNode ? Math.max(0, this.parentNode.children.indexOf(this)) * 40 : 0;
    },
  });
  Object.defineProperty(FakeElement.prototype, 'offsetHeight', { configurable: true, value: 40 });
});

afterEach(() => {
  if (offsetTopDescriptor) Object.defineProperty(FakeElement.prototype, 'offsetTop', offsetTopDescriptor);
  else Reflect.deleteProperty(FakeElement.prototype, 'offsetTop');
  if (offsetHeightDescriptor) Object.defineProperty(FakeElement.prototype, 'offsetHeight', offsetHeightDescriptor);
  else Reflect.deleteProperty(FakeElement.prototype, 'offsetHeight');
  browser.uninstall();
});

describe('chat scroll and read marking', () => {
  it('keeps the first visible message anchored when an older page is prepended', () => {
    const { log, conv, controller } = mount([10, 11, 12, 13, 14].map(msg));
    markRead.mockClear();
    log.scrollTop = 125;
    log.dispatchEvent(new FakeEvent('scroll'));

    const anchor = log.children.find((el) => el.dataset.key === 'm:12') as (FakeElement & { offsetTop: number }) | undefined;
    expect(anchor).toBeDefined();
    const visibleOffset = anchor!.offsetTop - log.scrollTop;
    expect(visibleOffset).toBe(35);
    expect(loadOlder).not.toHaveBeenCalled();

    view.messages = [msg(8), msg(9), ...view.messages];
    conv.refresh();

    const retained = log.children.find((el) => el.dataset.key === 'm:12') as (FakeElement & { offsetTop: number }) | undefined;
    expect(retained).toBe(anchor);
    expect(retained!.offsetTop - log.scrollTop).toBe(visibleOffset);
    expect(log.scrollTop).toBe(205);
    expect(markRead).not.toHaveBeenCalled();
    controller.abort();
  });

  it('marks the channel read when the open conversation scrolls to the bottom', () => {
    const { log, controller } = mount([1, 2, 3, 4, 5].map(msg));
    markRead.mockClear();
    log.scrollTop = log.scrollHeight - log.clientHeight - 10;
    log.dispatchEvent(new FakeEvent('scroll'));

    expect(markRead).toHaveBeenCalledTimes(1);
    controller.abort();
  });
});
