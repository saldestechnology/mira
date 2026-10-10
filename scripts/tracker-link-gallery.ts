import './tracker-link-gallery.css';
import '../src/tracker/ui/tracker.css';
import { h } from '../src/ui/dom';
import { THEMES } from '../src/themes';
import { TrackerError, type TrackerState } from '../src/tracker-types';
import type { TrackerStore } from '../src/tracker-data';
import { createLinkDialogModel } from '../src/tracker/ui/link-dialog-model';
import { mountLinkDialog } from '../src/tracker/ui/link-dialog';
import type { LinkDialogContext } from '../src/tracker/ui/link-seam';
import { confirmUnlink } from '../src/tracker/ui/unlink-confirm';
import { linkedCardHeaderMarkup, unmappedLaneChipMarkup, unmappedStateChipMarkup } from '../src/tracker/ui/linked-card-style';

declare global {
  interface Window {
    __trackerLinkGalleryReady?: boolean;
    __trackerLinkGallery?: { confirm?: Promise<boolean>; model?: ReturnType<typeof createLinkDialogModel> };
  }
}

const params = new URLSearchParams(location.search);
const stateName = params.get('state') ?? 'link-dialog-lanes';
const themeId = params.get('theme') ?? 'default';
const theme = THEMES.find((item) => item.id === themeId) ?? THEMES[0];
document.documentElement.dataset.theme = theme.id;
for (const [name, value] of Object.entries(theme.vars)) document.documentElement.style.setProperty(name, value);

const gallery = document.querySelector<HTMLElement>('#gallery')!;
gallery.replaceChildren(
  h('header', { class: 'trk-link-gallery-head' },
    h('h1', null, 'Tracker · canvas linking'),
    h('p', null, `${theme.name} theme · ${stateName}`),
  ),
);

const states: TrackerState[] = [
  { id: 'state-todo', key: 'todo', name: 'To do', category: 'unstarted', position: 0 },
  { id: 'state-doing', key: 'in_progress', name: 'In progress', category: 'started', position: 1 },
  { id: 'state-done', key: 'done', name: 'Done', category: 'completed', position: 2 },
  { id: 'state-cancelled', key: 'cancelled', name: 'Cancelled', category: 'canceled', position: 3 },
];
const lanes = [
  { id: 'doing', name: 'Doing', cardCount: 11 },
  { id: 'check', name: 'Check this', cardCount: 7 },
];
const suggestion = { map: { doing: 'in_progress' }, unmappedLanes: ['check'], existingCardCount: 18 };
const errorVariant = params.get('error') === 'offline' ? 'offline' : 'server';

function contextFor(code?: 'offline' | 'internal') {
  const store = {
    snapshot: () => ({ meta: { states } }),
    linkKanban: async () => {
      if (code) throw new TrackerError(code, code === 'offline' ? 'No connection.' : 'Server unavailable.');
      return {
        link: { id: 'link-1', boardId: 'board-1', kanbanId: 'kanban-1', trackerId: 'tracker-1', map: {}, createdAt: 0, ticketCount: 18 },
        created: [], skipped: [],
      };
    },
  };
  return {
    boardId: 'board-1', kanbanId: 'kanban-1',
    kanban: { name: 'Sprint retro', lanes, cardCount: 18 },
    store: store as unknown as TrackerStore,
  } satisfies LinkDialogContext;
}

function modelFor(code?: 'offline' | 'internal') {
  const model = createLinkDialogModel({
    lanes: lanes.map(({ id, name }) => ({ id, name })),
    states: states.map(({ id, key, name, category }) => ({ id, key, name, category })),
    suggestion,
    existingCardCount: 18,
  });
  if (stateName !== 'link-dialog-lanes') model.setMapping('check', 'todo');
  const context = contextFor(code);
  const host = document.createElement('div');
  host.className = 'trk-link-dialog-host';
  document.body.appendChild(host);
  mountLinkDialog(host, {
    model,
    context,
    states: states.map(({ id, key, name, category }) => ({ id, key, name, category })),
    suggestion,
    onClose: () => host.remove(),
    onLinked: () => undefined,
  });
  window.__trackerLinkGallery = { model };
  return { model, host };
}

function clickButton(host: HTMLElement, label: string): void {
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
  button?.focus();
  button?.click();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let frame = 0; frame < 300; frame++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  throw new Error(`Tracker link gallery did not reach ${stateName}`);
}

function openLinkDialog(): void {
  const errorCode = stateName === 'link-dialog-error' ? errorVariant === 'offline' ? 'offline' : 'internal' : undefined;
  const { host } = modelFor(errorCode);
  if (stateName === 'link-dialog-lanes') {
    requestAnimationFrame(() => {
      const check = [...host.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === 'Set state for Check this');
      check?.click();
      requestAnimationFrame(() => host.querySelector<HTMLElement>('.trk-link-state-picker')?.focus({ preventScroll: true }));
    });
  }
  if (stateName === 'link-dialog-review') {
    clickButton(host, 'Next');
  }
  if (stateName === 'link-dialog-error') {
    clickButton(host, 'Next');
    clickButton(host, 'Link and create 18 tickets');
  }
}

function svgCard(name: string, width: number, content: string, caption: string): HTMLElement {
  const viewWidth = Math.max(200, width);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${viewWidth} 68`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', name);
  svg.innerHTML = `<rect x="0.5" y="0.5" width="${viewWidth - 1}" height="67" fill="var(--paper)" stroke="var(--rule)"/>${content}`;
  const row = h('section', { class: 'trk-link-gallery-board-row' }, h('h2', null, name), svg, h('p', { class: 'trk-link-gallery-caption' }, caption));
  return row;
}

function openChipsGallery(): void {
  gallery.appendChild(h('section', { class: 'trk-link-gallery-strip', 'aria-label': 'Linked card header variants' },
    svgCard('Normal', 280, linkedCardHeaderMarkup({ key: 'TAB-124', state: { key: 'in_progress', name: 'In progress', category: 'started' }, laneStateKey: 'in_progress', width: 280, zoom: 1 }), 'Key and ink marker.'),
    svgCard('Done', 280, linkedCardHeaderMarkup({ key: 'TAB-125', state: { key: 'done', name: 'Done', category: 'completed' }, laneStateKey: 'todo', width: 280, zoom: 1 }), 'Completed state glyph.'),
    svgCard('Canceled', 280, linkedCardHeaderMarkup({ key: 'TAB-126', state: { key: 'cancelled', name: 'Cancelled', category: 'canceled' }, laneStateKey: 'todo', width: 280, zoom: 1 }), 'Canceled state glyph.'),
    svgCard('Blocked', 280, linkedCardHeaderMarkup({ key: 'TAB-127', state: { key: 'in_progress', name: 'In progress', category: 'started' }, laneStateKey: 'in_progress', width: 280, zoom: 1, blocked: true }), 'Blocked marker with text.'),
    svgCard('Offline', 280, linkedCardHeaderMarkup({ key: 'TAB-128', state: { key: 'in_progress', name: 'In progress', category: 'started' }, laneStateKey: 'in_progress', width: 280, zoom: 1, offline: true }), 'Cloud-off glyph.'),
    svgCard('Unmapped state', 160, unmappedStateChipMarkup({ width: 150 }), 'State has no lane.'),
    svgCard('Narrow lane', 200, linkedCardHeaderMarkup({ key: 'TAB-129', state: { key: 'done', name: 'Done', category: 'completed' }, laneStateKey: 'todo', width: 200, zoom: 1, priority: 'high' }), 'Compressed lane keeps its state cue.'),
    svgCard('Low zoom', 280, linkedCardHeaderMarkup({ key: 'TAB-130', state: { key: 'done', name: 'Done', category: 'completed' }, laneStateKey: 'todo', width: 280, zoom: 0.7 }), 'State name drops below the text threshold.'),
    svgCard('Not linked lane', 120, unmappedLaneChipMarkup(), 'Lane has not been mapped.'),
  ));
}

if (stateName.startsWith('link-dialog-')) openLinkDialog();
else if (stateName === 'unlink-confirm') {
  window.__trackerLinkGallery = { confirm: confirmUnlink({ cardCount: 18 }) };
} else if (stateName === 'linked-card-chips') openChipsGallery();

void (async () => {
  await document.fonts.ready;
  if (stateName === 'link-dialog-error') await waitFor(() => Boolean(gallery.parentElement?.querySelector('[role="alert"]')));
  window.__trackerLinkGalleryReady = true;
})();
