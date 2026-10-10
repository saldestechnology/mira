import { afterEach, describe, expect, it } from 'vitest';
import { openTrackerLinkDialog, installTrackerLinkDialog } from '../src/tracker/ui/link-dialog-open';
import { hasRegisteredLinkDialog, openRegisteredLinkDialog } from '../src/tracker/ui/link-seam';
import type { LinkDialogContext } from '../src/tracker/ui/link-seam';
import { FakeElement, flush, need } from './fake-dom';
import { installTrackerUiBrowser, uiEvent } from './tracker-ui-test-helpers';

let browser: ReturnType<typeof installTrackerUiBrowser> | null = null;
afterEach(() => { browser?.uninstall(); browser = null; });

function context(): LinkDialogContext {
  const states = [{ id: 'state-todo', key: 'todo', name: 'To do', category: 'unstarted' as const, position: 0 }];
  const calls: unknown[][] = [];
  const store = {
    snapshot: () => ({ meta: { states } }),
    suggestLinkMapping: async (...args: unknown[]) => {
      calls.push(args);
      return { map: { lane: 'todo' }, unmappedLanes: [], existingCardCount: 0 };
    },
    linkKanban: async () => { throw new Error('not used in this test'); },
  };
  return {
    boardId: 'board-1', kanbanId: 'kanban-1', store: store as never,
    kanban: { name: 'Sprint retro', cardCount: 0, lanes: [{ id: 'lane', name: 'Doing', cardCount: 0 }] },
  };
}

describe('tracker link dialog registration', () => {
  it('loads states and suggestions through the store and resolves when the portal closes', async () => {
    browser = installTrackerUiBrowser();
    const unregister = installTrackerLinkDialog();
    const value = context();
    try {
      expect(hasRegisteredLinkDialog()).toBe(true);
      expect(openRegisteredLinkDialog(value)).toBe(true);
      await flush();
      const host = need(browser.document.body as unknown as FakeElement, '.trk-link-dialog-host');
      expect(host.querySelector('.trk-link-modal')).not.toBeNull();
      expect(host.textContent).toContain('Suggested');
      const opened = openTrackerLinkDialog(value);
      browser.dispatchWindow(uiEvent('keydown', { key: 'Escape' }));
      await expect(opened).resolves.toBeUndefined();
      await flush();
      expect(browser.document.querySelector('.trk-link-dialog-host')).toBeNull();
    } finally {
      unregister();
    }
    expect(hasRegisteredLinkDialog()).toBe(false);
  });
});
