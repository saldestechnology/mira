import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { addCard, newKanban } from '../src/containers';
import { openCardDialog } from '../src/ui/card-dialog';
import { Store } from '../src/store';
import type { BaseObj } from '../src/types';
import { uiEvent, installTrackerUiBrowser } from './tracker-ui-test-helpers';
import { FakeElement, type FakeBrowser, textOf } from './fake-dom';

let browser: FakeBrowser | undefined;
afterEach(() => {
  browser?.uninstall();
  browser = undefined;
  vi.useRealTimers();
});

describe('linked card dialog title', () => {
  it('keeps the projected title read-only and opens its ticket through navigateTrackerPath', () => {
    browser = installTrackerUiBrowser();
    const store = new Store(new Y.Doc());
    const { container, lanes } = newKanban({ x: 0, y: 0 }, { z: 'a0', createdBy: 'user-me' });
    store.transact(() => [container, ...lanes].forEach((object) => store.create(object)));
    const cardId = addCard(store, lanes[0].id, 'Canvas title', { createdBy: 'user-me' })!;
    const cardMap = store.objects.get(cardId)!;
    store.doc.transact(() => {
      cardMap.set('extProvider', 'tabula');
      cardMap.set('extKey', 'TAB-123');
      cardMap.set('trackerId', 'tracker-demo');
      cardMap.set('tracker', { ticketId: 'ticket-123', title: 'Server title', state: { id: 'state-todo', key: 'todo', name: 'To do', category: 'unstarted' } });
    }, 'server');
    const pushState = vi.fn<(data: unknown, unused: string, url?: string | URL | null) => void>();
    const dispatchEvent = vi.fn<(event: Event) => boolean>();
    const fakeWindow = window as unknown as { history: { pushState: typeof pushState }; dispatchEvent: typeof dispatchEvent };
    fakeWindow.history = { pushState };
    fakeWindow.dispatchEvent = dispatchEvent;
    const app = {
      store,
      get readOnly() { return store.readOnly; },
      comments: { readOnly: () => false, onReadOnly: () => () => {} },
      canOpenCard: () => true,
      on: () => () => {},
      user: { id: 'user-me', name: 'Test User', color: '#326DD3' },
      participants: () => [],
      notify: vi.fn<() => void>(),
      commentOnCard: vi.fn<() => void>(),
      turnIntoStickies: vi.fn<() => void>(),
      setSelection: vi.fn<() => void>(),
      deleteSelection: vi.fn<() => void>(),
    };

    const dialog = openCardDialog(app as never, cardId)!;
    const title = browser.document.body.querySelector('input[aria-label="Title"]') as FakeElement;
    expect(title.readOnly).toBe(true);
    expect(title.value).toBe('Server title');
    title.value = 'Attempted edit';
    title.dispatchEvent(uiEvent('input'));
    title.dispatchEvent(uiEvent('change'));
    expect((store.get(cardId) as BaseObj).text).toBe('Canvas title');

    const ticketLink = browser.document.body.querySelector('a.k-open-tracker') as FakeElement;
    expect(textOf(ticketLink)).toBe('Open TAB-123');
    expect(ticketLink.href).toBe('/t/TAB-123');
    ticketLink.click();
    expect(pushState).toHaveBeenCalledWith(null, '', '/t/TAB-123');
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    dialog.close();
  });
});
