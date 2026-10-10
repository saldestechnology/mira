import './link-dialog.css';
import { closePopover } from '../../ui/common';
import { h } from '../../ui/dom';
import { focusFirst, focusIsIn, inertPage, restoreFocus, trapTab } from '../../ui/focus-scope';
import type { TrackerLinkKanbanResult, TrackerLinkSuggestion } from '../../tracker-types';
import { openPicker } from './picker';
import type { LinkDialogModel, LinkDialogModelState, LinkDialogStateOption } from './link-dialog-model';
import { stateGlyphElement } from './link-glyph-paths';
import type { LinkDialogContext } from './link-seam';

export interface MountLinkDialogOptions {
  model: LinkDialogModel;
  context: LinkDialogContext;
  onClose(): void;
  onLinked(result: TrackerLinkKanbanResult): void;
  /** Kept optional so the dialog also works with a model constructed directly by a caller. */
  suggestion?: TrackerLinkSuggestion;
  states?: LinkDialogStateOption[];
}

let dialogSequence = 0;

const ERROR_COPY: Record<NonNullable<LinkDialogModelState['errorCode']>, string> = {
  offline: 'Needs a connection to create tickets.',
  forbidden: 'Only board editors can link a kanban.',
  conflict: 'This board changed while you were linking. Check the lanes and try again.',
  other: "Couldn't link. Nothing was changed. Try again.",
};

const safeCount = (count: number) => Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;

function errorMessage(state: LinkDialogModelState): string | null {
  return state.errorCode ? ERROR_COPY[state.errorCode] : state.errors.general;
}

function laneStateLabel(laneId: string, state: LinkDialogModelState, statesByKey: Map<string, LinkDialogStateOption>): string {
  if (!Object.hasOwn(state.mapping, laneId)) return 'Choose a state';
  const key = state.mapping[laneId];
  return key === null ? 'Not linked' : statesByKey.get(key ?? '')?.name ?? 'Choose a state';
}

function countInLane(count: number): string {
  return `${count} ${count === 1 ? 'card' : 'cards'}`;
}

/** Mounts the lane mapping and review steps into a body-level portal host. */
export function mountLinkDialog(host: HTMLElement, opts: MountLinkDialogOptions): { destroy(): void; focus(): void } {
  const { model, context } = opts;
  const states = opts.states ?? context.store.snapshot().meta?.states ?? [];
  const statesByKey = new Map(states.map((state) => [state.key, state]));
  const initialMapping = { ...model.state.mapping };
  const existingCardCount = safeCount(opts.suggestion?.existingCardCount ?? context.kanban.cardCount);
  const id = ++dialogSequence;
  const titleId = `trk-link-title-${id}`;
  const opener = document.activeElement as HTMLElement | null;
  const backdrop = h('div', { class: 'modal-back trk trk-link-back' });
  const closeButton = h('button', {
    class: 'icon-btn trk-link-close', type: 'button', 'aria-label': 'Close', 'data-focus-id': 'close',
    onclick: () => close(),
  }, h('span', { class: 'trk-link-close-mark', 'aria-hidden': 'true' }, '×'));
  const heading = h('h2', { id: titleId }, 'Link to tracker');
  const subtitle = h('p', { class: 'trk-link-kanban-name' }, context.kanban.name);
  const header = h('div', { class: 'modal-head trk-link-head' }, h('div', { class: 'trk-link-heading' }, heading, subtitle), closeButton);
  const body = h('div', { class: 'modal-body trk-link-body' });
  const box = h('section', {
    class: 'modal tray trk-link-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1',
  }, header, body);
  backdrop.appendChild(box);
  if (host.parentNode !== document.body) document.body.appendChild(host);
  host.replaceChildren(backdrop);

  let closed = false;
  let step: 0 | 1 = 0;
  let stateSnapshot = model.state;
  let unsubscribe: () => void = () => {};
  let releasePage: () => void = () => {};

  const render = (state: LinkDialogModelState) => {
    if (closed) return;
    const focused = document.activeElement as HTMLElement | null;
    const focusId = box.contains(focused as Node) ? focused?.dataset.focusId : undefined;
    stateSnapshot = state;
    box.setAttribute('aria-busy', String(state.submitting));
    closeButton.disabled = state.submitting;

    const progress = h('ol', { class: 'trk-link-steps', 'aria-label': 'Link kanban steps' },
      h('li', { class: step === 0 ? 'is-current' : 'is-complete', 'aria-current': step === 0 ? 'step' : undefined },
        h('span', { class: 'trk-link-step-number', 'aria-hidden': 'true' }, '1'), h('span', null, 'Lanes')),
      h('li', { class: step === 1 ? 'is-current' : '', 'aria-current': step === 1 ? 'step' : undefined },
        h('span', { class: 'trk-link-step-number', 'aria-hidden': 'true' }, '2'), h('span', null, 'Review')),
    );

    const pane = step === 0 ? renderLanes(state) : renderReview(state);
    const error = errorMessage(state);
    const alert = error ? h('div', { class: 'trk-link-error', role: 'alert' },
      h('p', null, error),
      h('button', { class: 'btn trk-link-retry', type: 'button', disabled: state.submitting, 'data-focus-id': 'retry', onclick: () => { void submit(); } }, 'Retry'),
    ) : null;
    const actions = step === 0
      ? h('div', { class: 'trk-link-actions' },
        h('button', { class: 'btn', type: 'button', disabled: true, 'data-focus-id': 'back' }, 'Back'),
        h('button', {
          class: 'btn primary', type: 'button', disabled: !state.canSubmit, 'data-focus-id': 'next',
          onclick: () => { step = 1; render(model.state); },
        }, 'Next'),
      )
      : h('div', { class: 'trk-link-actions' },
        h('button', {
          class: 'btn', type: 'button', disabled: state.submitting, 'data-focus-id': 'back',
          onclick: () => { step = 0; render(model.state); },
        }, 'Back'),
        h('button', {
          class: 'btn primary', type: 'button', disabled: !state.canSubmit, 'aria-busy': state.submitting ? 'true' : 'false',
          'data-focus-id': state.submitting ? 'submit' : 'submit', onclick: () => { void submit(); },
        }, state.submitting ? 'Linking…' : state.createTickets && existingCardCount > 0 ? `Link and create ${existingCardCount} tickets` : 'Link'),
      );
    body.replaceChildren(progress, pane, h('div', { class: 'trk-link-footer' }, alert, actions));

    if (focusId) {
      const restoredId = focusId === 'next' ? 'submit' : focusId === 'submit' && !state.submitting && state.errorCode ? 'retry' : focusId;
      const nextFocus = Array.from(box.querySelectorAll<HTMLElement>('[data-focus-id]')).find((el) => el.dataset.focusId === restoredId);
      if (nextFocus && !(nextFocus as HTMLButtonElement).disabled) nextFocus.focus({ preventScroll: true });
      else if (state.submitting) box.focus({ preventScroll: true });
    } else if (focused === box && state.errorCode && !state.submitting) {
      box.querySelector<HTMLElement>('[data-focus-id="retry"]')?.focus({ preventScroll: true });
    }
  };

  const renderLanes = (state: LinkDialogModelState) => {
    const warningStates = states.filter((option) => !context.kanban.lanes.some((lane) => state.mapping[lane.id] === option.key));
    const rows = context.kanban.lanes.map((lane) => {
      const current = state.mapping[lane.id];
      const mappedName = laneStateLabel(lane.id, state, statesByKey);
      const unresolved = !Object.hasOwn(state.mapping, lane.id);
      const suggested = Object.hasOwn(initialMapping, lane.id) && initialMapping[lane.id] === current && typeof current === 'string';
      const error = state.errors.lanes[lane.id];
      const picker = h('button', {
        class: 'trk-link-state-picker', type: 'button', disabled: state.submitting, 'data-focus-id': `lane:${lane.id}`,
        'aria-label': `Set state for ${lane.name}`,
        'aria-describedby': error ? `trk-link-lane-error-${id}-${lane.id}` : undefined,
        onclick: () => { void pickState(lane.id); },
      },
        current && typeof current === 'string' && statesByKey.has(current)
          ? stateGlyphElement(statesByKey.get(current)!.category, current, statesByKey.get(current)!.name, 16)
          : null,
        h('span', { class: 'trk-link-state-label' }, mappedName),
        h('span', { class: 'trk-link-chevron', 'aria-hidden': 'true' }, '⌄'),
      );
      const markers = h('div', { class: 'trk-link-lane-markers' },
        suggested ? h('span', { class: 'trk-link-suggested' }, 'Suggested') : null,
        unresolved ? h('span', { class: 'trk-link-check-this' }, 'Check this') : null,
        current === null ? h('span', { class: 'trk-link-not-linked' }, 'Not linked') : null,
      );
      const row = h('div', { class: `trk-link-lane-row${error ? ' has-error' : ''}`, 'data-lane-id': lane.id },
        h('div', { class: 'trk-link-lane-copy' },
          h('div', { class: 'trk-link-lane-title' }, lane.name),
          h('div', { class: 'trk-link-lane-meta' }, countInLane(safeCount(lane.cardCount)), markers),
        ), picker,
      );
      if (error) row.appendChild(h('p', { id: `trk-link-lane-error-${id}-${lane.id}`, class: 'trk-link-lane-error', role: 'alert' }, error));
      return row;
    });
    const list = h('div', { class: 'trk-link-lanes', 'aria-label': 'Kanban lane mappings' }, ...rows);
    const warnings = warningStates.length ? h('div', { class: 'trk-link-warnings', 'aria-label': 'States with no lane' },
      ...warningStates.map((option) => h('p', { class: 'trk-link-warning' },
        h('span', { class: 'trk-link-warning-glyph', 'aria-hidden': 'true' }, '!'),
        h('span', null, `${option.name} has no lane: cards moved there in the tracker will leave the board`),
      )),
    ) : null;
    return h('div', { class: 'trk-link-pane trk-link-lanes-pane' },
      h('p', { class: 'trk-link-intro' }, 'Match each kanban lane to one tracker state.'), list, warnings,
    );
  };

  const renderReview = (state: LinkDialogModelState) => {
    const title = state.createTickets && existingCardCount > 0
      ? h('h3', { class: 'trk-link-review-title' }, `${existingCardCount} ${existingCardCount === 1 ? 'card will become a ticket' : 'cards will become tickets'}`, keyRangeText())
      : h('h3', { class: 'trk-link-review-title' }, 'Existing cards will stay as plain cards.');
    const summary = state.createTickets && existingCardCount > 0
      ? h('p', { class: 'trk-link-review-copy' }, 'Their state follows the lane.')
      : null;
    const tableRows = context.kanban.lanes.slice(0, 6).map((lane) => {
      const mapped = state.mapping[lane.id];
      const stateName = mapped === null ? 'Not linked' : typeof mapped === 'string' ? statesByKey.get(mapped)?.name ?? 'Not linked' : 'Not linked';
      return h('tr', null,
        h('th', { scope: 'row' }, lane.name), h('td', null, stateName), h('td', { class: 'trk-link-count-cell' }, String(safeCount(lane.cardCount))),
      );
    });
    const table = h('table', { class: 'trk-link-review-table' },
      h('caption', null, 'Lane mapping preview'),
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Lane'), h('th', { scope: 'col' }, 'State'), h('th', { scope: 'col' }, 'Cards'))),
      h('tbody', null, ...tableRows),
    );
    const checkbox = existingCardCount > 0
      ? h('div', { class: 'trk-link-create-option' },
        h('label', { class: 'trk-link-create-label', for: `trk-link-create-${id}` },
          h('input', {
            id: `trk-link-create-${id}`, type: 'checkbox', checked: state.createTickets, 'data-focus-id': 'create-tickets',
            disabled: state.submitting,
            onchange: (event: Event) => model.setCreateTickets((event.currentTarget as HTMLInputElement).checked),
          }),
          h('span', null, `Create tickets for the ${existingCardCount} existing cards`),
        ),
        h('p', { class: 'trk-link-helper' }, 'Unticked cards stay as plain cards on the board.'),
      ) : null;
    return h('div', { class: 'trk-link-pane trk-link-review-pane' },
      h('div', { class: 'trk-link-review-summary' }, title, summary),
      table, checkbox,
    );
  };

  function keyRangeText(): string {
    const suggestion = opts.suggestion as (TrackerLinkSuggestion & { firstKey?: string; lastKey?: string }) | undefined;
    const kanban = context.kanban as LinkDialogContext['kanban'] & { firstKey?: string; lastKey?: string };
    const first = suggestion?.firstKey ?? kanban.firstKey;
    const last = suggestion?.lastKey ?? kanban.lastKey;
    return first && last ? ` (${first} to ${last})` : '';
  }

  async function pickState(laneId: string): Promise<void> {
    const anchor = Array.from(box.querySelectorAll<HTMLButtonElement>('.trk-link-state-picker')).find((button) => button.closest('[data-lane-id]')?.getAttribute('data-lane-id') === laneId);
    if (!anchor) return;
    const lane = context.kanban.lanes.find((item) => item.id === laneId);
    if (!lane) return;
    const optionLabels = new Map<string, { state: LinkDialogStateOption; usage: string | null }>();
    const options: Array<{ value: string | null; label: string; disabled?: boolean }> = states.map((item) => {
      const use = model.describeStateUse(item.key);
      const otherLane = context.kanban.lanes.find((candidate) => candidate.id !== laneId && stateSnapshot.mapping[candidate.id] === item.key);
      const usage = otherLane ? `Used by ${otherLane.name}` : use && stateSnapshot.mapping[laneId] !== item.key ? use : null;
      const label = usage ? `${item.name} · ${usage}` : item.name;
      optionLabels.set(label, { state: item, usage });
      return { value: item.key, label, disabled: Boolean(otherLane) };
    });
    options.unshift({ value: null, label: 'Skip this lane', disabled: false });
    const selected = stateSnapshot.mapping[laneId];
    const result = openPicker(anchor, {
      label: `State for ${lane.name}`, value: typeof selected === 'string' ? selected : selected === null ? null : undefined,
      options,
    });
    const list = document.querySelector<HTMLElement>('.trk-pop .trk-picker-list');
    if (list) {
      const decorate = () => {
        for (const row of Array.from(list.querySelectorAll<HTMLElement>('.trk-picker-option'))) {
          if (row.dataset.linkGlyph) continue;
          const option = optionLabels.get(row.textContent ?? '');
          if (!option) continue;
          row.dataset.linkGlyph = 'true';
          row.replaceChildren(
            stateGlyphElement(option.state.category, option.state.key, option.state.name, 16),
            h('span', { class: 'trk-link-picker-name' }, option.state.name),
            ...(option.usage ? [h('span', { class: 'trk-link-picker-use' }, option.usage)] : []),
          );
        }
      };
      decorate();
      const observer = typeof MutationObserver === 'function' ? new MutationObserver(decorate) : null;
      observer?.observe(list, { childList: true });
      const choice = await result;
      observer?.disconnect();
      if (choice !== undefined) model.setMapping(laneId, choice as string | null);
      return;
    }
    const choice = await result;
    if (choice !== undefined) model.setMapping(laneId, choice as string | null);
  }

  async function submit(): Promise<void> {
    const result = await model.submit(context.store, { boardId: context.boardId, kanbanId: context.kanbanId });
    if (!result || closed) return;
    opts.onLinked(result);
    close();
  }

  function close(): void {
    if (closed) return;
    const giveBack = focusIsIn(backdrop) || Boolean(document.activeElement?.closest?.('.trk-pop'));
    closed = true;
    unsubscribe();
    closePopover();
    window.removeEventListener('keydown', onKey);
    backdrop.remove();
    releasePage();
    host.replaceChildren();
    if (giveBack) restoreFocus(opener);
    opts.onClose();
  }

  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Tab' && !document.activeElement?.closest?.('.popover')) {
      trapTab(event, box);
    }
  };
  const onBackdrop = (event: MouseEvent) => { if (event.target === backdrop) close(); };

  backdrop.addEventListener('click', onBackdrop);
  window.addEventListener('keydown', onKey);
  releasePage = inertPage(host);
  unsubscribe = model.subscribe(render);
  const firstControl = Array.from(box.querySelectorAll<HTMLElement>('[data-focus-id]')).find((el) => el.dataset.focusId?.startsWith('lane:'));
  focusFirst(box, firstControl);

  return {
    destroy: close,
    focus() {
      const first = Array.from(box.querySelectorAll<HTMLElement>('[data-focus-id]')).find((el) => el.dataset.focusId?.startsWith('lane:'));
      focusFirst(box, first);
    },
  };
}
