import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrackerError, type TrackerKanbanLink, type TrackerLinkKanbanInput, type TrackerLinkKanbanResult, type TrackerState } from '../src/tracker-types';
import { createLinkDialogModel } from '../src/tracker/ui/link-dialog-model';
import { mountLinkDialog } from '../src/tracker/ui/link-dialog';
import type { LinkDialogContext } from '../src/tracker/ui/link-seam';
import { FakeElement, flush, need, textOf } from './fake-dom';
import { installTrackerUiBrowser, uiEvent } from './tracker-ui-test-helpers';

let browser: ReturnType<typeof installTrackerUiBrowser> | null = null;
afterEach(() => {
  browser?.uninstall();
  browser = null;
  vi.useRealTimers();
});

const states: TrackerState[] = [
  { id: 'state-todo', key: 'todo', name: 'To do', category: 'unstarted', position: 0 },
  { id: 'state-doing', key: 'in_progress', name: 'In progress', category: 'started', position: 1 },
  { id: 'state-done', key: 'done', name: 'Done', category: 'completed', position: 2 },
  { id: 'state-cancelled', key: 'cancelled', name: 'Cancelled', category: 'canceled', position: 3 },
];

function fixture(options: {
  lanes?: Array<{ id: string; name: string; cardCount: number }>;
  cardCount?: number;
  suggestionMap?: Record<string, string | null>;
  linkKanban?: (input: TrackerLinkKanbanInput) => Promise<TrackerLinkKanbanResult>;
} = {}) {
  const lanes = options.lanes ?? [
    { id: 'doing', name: 'Doing', cardCount: 11 },
    { id: 'check', name: 'Check this', cardCount: 7 },
  ];
  const cardCount = options.cardCount ?? 18;
  const context: LinkDialogContext = {
    boardId: 'board-1', kanbanId: 'kanban-1',
    kanban: { name: 'Sprint retro', lanes, cardCount },
    store: { linkKanban: options.linkKanban ?? (async () => result()) } as never,
  };
  const model = createLinkDialogModel({
    lanes: lanes.map(({ id, name }) => ({ id, name })),
    states: states.map(({ id, key, name, category }) => ({ id, key, name, category })),
    suggestion: { map: options.suggestionMap ?? { doing: 'in_progress' }, unmappedLanes: [], existingCardCount: cardCount, nextKey: 'TAB-1', stateNotMapped: ['done'] },
    existingCardCount: cardCount,
  });
  const host = browser!.document.createElement('div');
  browser!.document.body.appendChild(host as unknown as FakeElement);
  const linked: TrackerLinkKanbanResult[] = [];
  const controller = mountLinkDialog(host as unknown as HTMLElement, {
    model,
    context,
    states: states.map(({ id, key, name, category }) => ({ id, key, name, category })),
    onClose: () => undefined,
    onLinked: (value) => linked.push(value),
  });
  return { context, model, host: host as unknown as FakeElement, linked, controller };
}

function result(): TrackerLinkKanbanResult {
  const link: TrackerKanbanLink = {
    id: 'link-1', boardId: 'board-1', kanbanId: 'kanban-1', workflowId: 'workflow-1',
    mapping: [{ laneId: 'doing', stateKey: 'in_progress', stateId: 'state-doing' }], map: { doing: 'in_progress' },
    cardCount: 18, pendingProjections: 0, createdAt: 0, createdBy: 'user-me', ticketCount: 18,
  };
  return {
    link, created: [], skipped: [], projectionPending: false,
  };
}

const button = (host: FakeElement, label: string) => host.querySelectorAll('button').find((item) => textOf(item) === label || item.getAttribute('aria-label') === label)!;

describe('tracker link dialog', () => {
  it('starts on lanes, shows suggestions and warnings, and refuses a state already used by Doing', async () => {
    browser = installTrackerUiBrowser();
    const { host, model } = fixture();
    expect(textOf(host)).toContain('1Lanes');
    expect(textOf(host)).toContain('2Review');
    expect(textOf(host)).toContain('Suggested');
    expect(textOf(host)).toContain('Check this');
    expect(textOf(host)).toContain('Done has no lane: cards moved there in the tracker will leave the board');
    expect(button(host, 'Next').disabled).toBe(true);

    button(host, 'Set state for Check this').click();
    const used = browser.document.querySelectorAll('[role="option"]').find((option) => textOf(option).includes('In progress'))!;
    expect(used.getAttribute('aria-disabled')).toBe('true');
    used.click();
    await flush();
    expect(model.state.mapping.check).toBeUndefined();
    expect(browser.document.querySelector('[role="listbox"]')).not.toBeNull();

    const skip = browser.document.querySelectorAll('[role="option"]').find((option) => textOf(option) === 'Skip this lane')!;
    skip.click();
    await flush();
    expect(model.state.mapping.check).toBeNull();
    expect(textOf(host)).toContain('Not linked');
    button(host, 'Next').click();
    expect(textOf(host)).toContain('18 cards will become tickets');
    expect(host.querySelectorAll('tbody tr')).toHaveLength(2);
    button(host, 'Back').click();
    expect(textOf(host)).toContain('1Lanes');
  });

  it('defaults the existing-card checkbox on, hides it at zero, and labels the count', () => {
    browser = installTrackerUiBrowser();
    const { host, controller } = fixture({ lanes: [{ id: 'doing', name: 'Doing', cardCount: 18 }] });
    button(host, 'Next').click();
    const checkbox = need(host, 'input[type="checkbox"]');
    expect(checkbox.checked).toBe(true);
    expect(textOf(host)).toContain('Create tickets for the 18 existing cards');
    expect(textOf(host)).toContain('Unticked cards stay as plain cards on the board.');
    checkbox.checked = false;
    checkbox.dispatchEvent(uiEvent('change'));
    expect(need(host, 'input[type="checkbox"]').checked).toBe(false);
    expect(textOf(host)).toContain('Existing cards will stay as plain cards.');
    controller.destroy();

    const zero = fixture({ lanes: [{ id: 'doing', name: 'Doing', cardCount: 0 }], cardCount: 0 });
    button(zero.host, 'Next').click();
    expect(zero.host.querySelector('input[type="checkbox"]')).toBeNull();
    zero.controller.destroy();
  });

  it('keeps the Link button busy and disabled during submit, then reports the result', async () => {
    browser = installTrackerUiBrowser();
    let finish: ((value: TrackerLinkKanbanResult) => void) | undefined;
    const pending = new Promise<TrackerLinkKanbanResult>((resolve) => { finish = resolve; });
    const { host, linked } = fixture({ lanes: [{ id: 'doing', name: 'Doing', cardCount: 18 }], linkKanban: () => pending });
    button(host, 'Next').click();
    const link = button(host, 'Link and create 18 tickets');
    link.click();
    const busy = button(host, 'Linking…');
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(button(host, 'Back').disabled).toBe(true);
    expect(button(host, 'Close').disabled).toBe(true);
    expect(need(host, 'input[type="checkbox"]').disabled).toBe(true);
    finish!(result());
    await flush();
    expect(linked).toHaveLength(1);
    expect(host.querySelector('.trk-link-back')).toBeNull();
  });

  it.each([
    ['offline', 'Needs a connection to create tickets.'],
    ['forbidden', 'Only board editors can link a kanban.'],
    ['conflict', 'This board changed while you were linking. Check the lanes and try again.'],
    ['internal', "Couldn't link. Nothing was changed. Try again."],
  ] as const)('keeps choices after a %s failure and offers Retry', async (code, message) => {
    browser = installTrackerUiBrowser();
    const { host, model } = fixture({
      lanes: [{ id: 'doing', name: 'Doing', cardCount: 18 }],
      linkKanban: async () => { throw new TrackerError(code, 'server detail'); },
    });
    button(host, 'Next').click();
    button(host, 'Link and create 18 tickets').click();
    await flush();
    expect(textOf(need(host, '[role="alert"]'))).toContain(message);
    expect(button(host, 'Retry')).toBeDefined();
    expect(model.state.createTickets).toBe(true);
    expect(model.state.mapping.doing).toBe('in_progress');
  });

  it('shows the server guidance when creating tickets exceeds the 500-card limit', async () => {
    browser = installTrackerUiBrowser();
    const guidance = 'Link without creating tickets, then create per card.';
    const { host } = fixture({
      lanes: [{ id: 'doing', name: 'Doing', cardCount: 18 }],
      linkKanban: async () => { throw new TrackerError('limit_exceeded', guidance, { path: 'createTickets', status: 413 }); },
    });
    button(host, 'Next').click();
    button(host, 'Link and create 18 tickets').click();
    await flush();
    expect(textOf(need(host, '[role="alert"]'))).toContain(guidance);
  });

  it('closes on Escape, traps focus, and treats hostile lane names as text', () => {
    browser = installTrackerUiBrowser();
    const opener = browser.document.createElement('button');
    browser.document.body.appendChild(opener as unknown as FakeElement);
    opener.focus();
    const hostile = '<img onerror="alert(1)">';
    const { host } = fixture({ lanes: [{ id: 'hostile', name: hostile, cardCount: 1 }], suggestionMap: {} });
    expect(host.querySelector('img')).toBeNull();
    expect(textOf(host)).toContain(hostile);
    const first = button(host, `Set state for ${hostile}`);
    expect(browser.document.activeElement).toBe(first);
    const close = button(host, 'Close');
    close.focus();
    const tab = uiEvent('keydown', { key: 'Tab', shiftKey: true });
    browser.dispatchWindow(tab);
    expect(tab.defaultPrevented).toBe(true);
    browser.dispatchWindow(uiEvent('keydown', { key: 'Escape' }));
    expect(host.querySelector('.trk-link-back')).toBeNull();
    expect(browser.document.activeElement).toBe(opener);
  });
});
