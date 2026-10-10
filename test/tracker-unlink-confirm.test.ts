import { afterEach, describe, expect, it } from 'vitest';
import { confirmUnlink, installTrackerUnlinkConfirm } from '../src/tracker/ui/unlink-confirm';
import type { TrackerKanbanLink } from '../src/tracker-types';
import type { UnlinkConfirmContext } from '../src/tracker/ui/link-seam';
import { openRegisteredUnlinkConfirm } from '../src/tracker/ui/link-seam';
import { FakeElement, flush, need, textOf } from './fake-dom';
import { installTrackerUiBrowser, uiEvent } from './tracker-ui-test-helpers';

let browser: ReturnType<typeof installTrackerUiBrowser> | null = null;
afterEach(() => { browser?.uninstall(); browser = null; });

const action = (label: string) => browser!.document.querySelectorAll('button').find((button) => textOf(button) === label)!;

function link(id: string, count: number): TrackerKanbanLink {
  return {
    id, boardId: 'board-1', kanbanId: 'kanban-1', workflowId: 'workflow-1', mapping: [], map: {},
    cardCount: count, createdAt: 0, createdBy: 'user-me', ticketCount: count,
  };
}

describe('tracker unlink confirmation', () => {
  it('uses the plural copy and starts with Cancel focused, then resolves true or false', async () => {
    browser = installTrackerUiBrowser();
    let decision = confirmUnlink({ cardCount: 4 });
    expect(textOf(browser.document.body)).toContain('Unlink from tracker?');
    expect(textOf(browser.document.body)).toContain('The 4 cards stay on this board with their titles and lanes. The tickets stay in the tracker. The cards will no longer follow ticket changes.');
    expect(browser.document.activeElement).toBe(action('Cancel'));
    action('Unlink').click();
    await expect(decision).resolves.toBe(true);

    decision = confirmUnlink({ cardCount: 4 });
    action('Cancel').click();
    await expect(decision).resolves.toBe(false);
  });

  it('uses singular copy and Escape cancels', async () => {
    browser = installTrackerUiBrowser();
    const decision = confirmUnlink({ cardCount: 1 });
    expect(textOf(browser.document.body)).toContain('The card stays on this board with its title and lane. The ticket stays in the tracker. The card will no longer follow ticket changes.');
    browser.dispatchWindow(uiEvent('keydown', { key: 'Escape' }));
    await expect(decision).resolves.toBe(false);
  });

  it('unlinks after confirmation and reports success or failure with a toast', async () => {
    browser = installTrackerUiBrowser();
    const body = browser.document.createElement('div');
    browser.document.body.appendChild(body as unknown as FakeElement);
    const calls: string[] = [];
    const context: UnlinkConfirmContext = {
      boardId: 'board-1', kanbanId: 'kanban-1',
      link: link('link-1', 2),
      store: { unlinkKanban: async (id: string) => { calls.push(id); return { link: link('link-1', 2), unlinked: 2, projectionPending: false }; } } as never,
    };
    const uninstall = installTrackerUnlinkConfirm();
    try {
      expect(openRegisteredUnlinkConfirm(context)).toBe(true);
      action('Unlink').click();
      await flush();
      expect(calls).toEqual(['link-1']);
      expect(textOf(need(browser.document.body as unknown as FakeElement, '.toast'))).toBe('Unlinked. 2 cards are plain cards again.');
    } finally {
      uninstall();
    }
  });

  it('keeps the modal choice and shows the retry toast when unlinking fails', async () => {
    browser = installTrackerUiBrowser();
    const context: UnlinkConfirmContext = {
      boardId: 'board-1', kanbanId: 'kanban-1',
      link: link('link-2', 1),
      store: { unlinkKanban: async () => { throw new Error('offline'); } } as never,
    };
    const uninstall = installTrackerUnlinkConfirm();
    try {
      openRegisteredUnlinkConfirm(context);
      action('Unlink').click();
      await flush();
      expect(textOf(need(browser.document.body as unknown as FakeElement, '.toast'))).toBe("Couldn't unlink. Try again.");
    } finally {
      uninstall();
    }
  });
});
