import './kanban.css';
import './card-dialog.css';
import type { BoardApp, KanbanMenuKind } from '../app';
import type { BaseObj, Id, Rect } from '../types';
import { LABEL_COLORS, LIMITS, kanbanColor } from '../../shared/containers';
import { listLabels } from '../labels';
import { downloadCardsCsv } from '../exporters';
import { kanbanSwatch } from '../markup';
import { popover } from './common';
import { keepKeys } from './card-dialog';
import { h, icon } from './dom';
import { DUE_BUCKETS, STAGES, laneMoveIndex, matchText, parseWip, type DueBucket, type KanbanFilter } from './kanban-logic';
import { authState } from '../auth';
import { canShowTrackerLinkAction, canShowTrackerUnlinkAction, hasRegisteredLinkDialog, hasRegisteredUnlinkConfirm } from '../tracker/ui/link-seam';

// The kanban menus (docs/kanban.md, slice 4): a lane's ⋯ (rename, colour, stage, WIP limit, move, delete), the kanban's
// ⋯ (rename, add lane, labels, lock, delete) and the Filter popover. Chrome, so tray tokens as the other menus. The menus
// are for editors; the Filter popover is for everyone, and writes nothing to the board. Every write goes through
// BoardApp (src/containers.ts underneath), so each pick is one undo step and a refusal is a toast.

/** A colour's name for the menu: a palette key capitalised, a checked colour as it is, 'None' for nothing. */
const colourName = (key: string | null | undefined) => (key ? key[0].toUpperCase() + key.slice(1) : 'None');

/** A one pixel anchor over a rectangle of the page, `width` wide from its right edge, for a popover to sit under. */
function anchorAt(at: Rect, width: number): HTMLElement {
  const left = Math.max(8, Math.round(at.x + at.w - width));
  const el = h('span', { style: `position:fixed;left:${left}px;top:${Math.round(at.y)}px;width:1px;height:${Math.max(1, Math.round(at.h))}px;pointer-events:none`, 'aria-hidden': 'true' });
  document.body.appendChild(el);
  return el;
}

export interface ItemOpts {
  danger?: boolean;
  disabled?: boolean;
  /** For a choice among several: menuitemradio with aria-checked. */
  checked?: boolean;
  /** Opens a sub-list: a chevron at the end. */
  sub?: boolean;
  /** A palette key: its swatch before the label. */
  swatch?: string | null;
  hint?: string;
  title?: string;
}

/** A menu row of the kanban menus (also the list sheet's row menu, src/ui/container-sheet.ts). */
export function item(label: string, onPick: () => void, o: ItemOpts = {}): HTMLButtonElement {
  let sw: HTMLElement | null = null;
  if (o.swatch !== undefined) {
    sw = h('span', { class: 'k-chip-swatch', 'aria-hidden': 'true' });
    const c = o.swatch ? kanbanSwatch(o.swatch) : null;
    if (c) sw.style.setProperty('--c', c);
    else sw.classList.add('none');
  }
  return h('button', {
    class: `menu-item${o.danger ? ' danger' : ''}`, type: 'button', role: o.checked === undefined ? 'menuitem' : 'menuitemradio',
    'aria-checked': o.checked === undefined ? undefined : String(o.checked), 'aria-haspopup': o.sub ? 'true' : undefined,
    disabled: o.disabled, 'data-tip': o.title, onclick: onPick,
  },
  sw, h('span', { class: 'k-mi-label' }, label),
  o.checked ? h('span', { class: 'menu-hint k-mi-check', 'aria-hidden': 'true' }, icon('check', 14)) : null,
  o.hint ? h('span', { class: 'menu-hint' }, o.hint) : null,
  o.sub ? h('span', { class: 'menu-hint k-mi-sub', 'aria-hidden': 'true' }, icon('chevron', 14)) : null);
}

/** How long the filter waits after a key or a board change before it redraws and recounts. */
export const FILTER_DEBOUNCE = 150;

export const sep = () => h('hr', { class: 'menu-sep', role: 'separator' });

/** Opens one of the kanban menus against a rectangle of the page (BoardApp.openKanbanMenu). */
export function openKanbanMenu(app: BoardApp, kind: KanbanMenuKind, id: Id, at: Rect) {
  if (kind === 'lane') return openLaneMenu(app, id, at);
  if (kind === 'container') return openContainerMenu(app, id, at);
  return openFilterPopover(app, id, at);
}

/** A menu whose content can change page (the lane menu's Colour, Stage and WIP limit) while it stays open. */
function menuPopover(app: BoardApp, id: Id, kindOpen: 'menu' | 'filter', at: Rect, width: number, label: string, cls = '') {
  const anchor = anchorAt(at, width);
  const menu = h('div', { class: `menu k-menu ${cls}`, role: 'menu', 'aria-label': label, style: `width:${width}px` });
  keepKeys(menu);
  // the menu goes when its lane or kanban does, or when the board turns read-only under an editor's menu
  const gone = () => {
    if (!app.store.get(id) || (kindOpen === 'menu' && app.readOnly)) pop.close();
  };
  // and when this person's role changes under it (an editor made a viewer keeps only the filter)
  const cleanups: (() => void)[] = [app.store.onChange(gone), app.on('readonly', gone)];
  const pop = popover(anchor, menu, {
    side: 'bottom', className: 'k-pop', label, onClose: () => {
      anchor.remove();
      cleanups.forEach((f) => f());
      app.setKanbanMenuOpen(null);
    },
  });
  app.setKanbanMenuOpen({ id, kind: kindOpen });
  /** Shows a page of the menu and focuses its first button. */
  const show = (...children: (HTMLElement | null)[]) => {
    menu.replaceChildren(...children.filter((c): c is HTMLElement => !!c));
    pop.place();
    menu.querySelector<HTMLElement>('button:not(:disabled), input')?.focus();
  };
  /** Runs a pick and closes the menu. */
  const pick = (fn: () => void) => () => {
    pop.close();
    fn();
  };
  return { menu, pop, show, pick, onClose: (fn: () => void) => cleanups.push(fn) };
}

/** The lane ⋯ menu (docs/kanban.md, Lanes): editors only. */
export function openLaneMenu(app: BoardApp, laneId: Id, at: Rect) {
  const lane0 = app.store.get(laneId);
  if (app.readOnly || lane0?.type !== 'lane') return;
  const name = (lane0 as BaseObj).name || 'Lane';
  const { show, pick } = menuPopover(app, laneId, 'menu', at, 240, `${name} lane menu`);
  const lane = () => app.store.get(laneId) as BaseObj;
  const back = (title: string) => h('button', { class: 'menu-item k-mi-back', type: 'button', onclick: () => main() }, h('span', { class: 'k-mi-sub', 'aria-hidden': 'true' }, icon('chevron', 14)), h('span', null, title));

  const main = () => {
    const l = lane();
    const layout = l.parent ? app.store.containerLayout(l.parent) : null;
    const lanes = layout?.lanes ?? [];
    const stage = STAGES.find((s) => s.key === l.stage)?.label ?? 'None';
    const wip = l.wip ? `${l.wip}${l.wipMode === 'block' ? ' · block' : ''}` : 'None';
    show(
      item('Rename', pick(() => app.renameKanbanPart(laneId))),
      // a fill another client wrote may be none, transparent or not a colour at all: kanbanColor says what is drawn
      item('Colour', () => colours(), { sub: true, hint: colourName(kanbanColor(l.fill)) }),
      item('Stage', () => stages(), { sub: true, hint: stage }),
      item('WIP limit', () => wipPage(), { sub: true, hint: wip }),
      sep(),
      item('Move left', pick(() => app.moveLaneFromMenu(laneId, 'left')), { disabled: laneMoveIndex(lanes, laneId, 'left') === null }),
      item('Move right', pick(() => app.moveLaneFromMenu(laneId, 'right')), { disabled: laneMoveIndex(lanes, laneId, 'right') === null }),
      sep(),
      item('Delete lane', pick(() => app.deleteLane(laneId, false)), { danger: true, title: lanes.length > 1 ? 'Its cards move to the next lane' : 'Its cards go with it' }),
      item('Delete lane and its cards', pick(() => app.deleteLane(laneId, true)), { danger: true }),
    );
  };

  const colours = () => {
    const cur = kanbanColor(lane().fill);
    show(
      back('Colour'),
      sep(),
      item('None', pick(() => app.editLaneFromMenu(laneId, { fill: null })), { checked: !cur, swatch: null }),
      ...LABEL_COLORS.map((key) => item(colourName(key), pick(() => app.editLaneFromMenu(laneId, { fill: key })), { checked: cur === key, swatch: key })),
    );
  };

  const stages = () => {
    const cur = lane().stage;
    show(
      back('Stage'),
      sep(),
      item('None', pick(() => app.editLaneFromMenu(laneId, { stage: null })), { checked: !cur }),
      ...STAGES.map((s) => item(s.label, pick(() => app.editLaneFromMenu(laneId, { stage: s.key })), { checked: cur === s.key })),
      h('p', { class: 'k-mi-note' }, 'Done turns off overdue for the lane’s cards.'),
    );
  };

  const wipPage = () => {
    const l = lane();
    let mode: 'warn' | 'block' = l.wipMode === 'block' ? 'block' : 'warn';
    const input = h('input', { class: 'input k-wip-input', type: 'text', inputmode: 'numeric', maxlength: '2', value: l.wip ? String(l.wip) : '', 'aria-label': 'Most cards in this lane, 1 to 99', placeholder: '1 to 99' });
    const err = h('p', { class: 'k-mi-note k-mi-error', role: 'alert', hidden: true });
    const modes = h('div', { class: 'k-seg', role: 'radiogroup', 'aria-label': 'When the lane is full' });
    const modeBtn = (m: 'warn' | 'block', text: string) => {
      const b = h('button', {
        class: `k-chip${m === mode ? ' on' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(m === mode),
        onclick: () => {
          mode = m;
          for (const x of modes.children) {
            const on = x === b;
            x.classList.toggle('on', on);
            x.setAttribute('aria-checked', String(on));
          }
        },
      }, text);
      return b;
    };
    modes.append(modeBtn('warn', 'Warn'), modeBtn('block', 'Block'));
    const apply = () => {
      const v = parseWip(input.value);
      if (v === null) {
        err.textContent = `A limit is a whole number from ${LIMITS.wipMin} to ${LIMITS.wipMax}.`;
        err.hidden = false;
        input.focus();
        return;
      }
      pick(() => app.editLaneFromMenu(laneId, v === '' ? { wip: null } : { wip: v, wipMode: mode }))();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        apply();
      }
    });
    show(
      back('WIP limit'),
      sep(),
      h('div', { class: 'k-mi-form' },
        h('label', { class: 'k-pop-h' }, 'Most cards', input),
        h('div', { class: 'k-pop-h' }, 'When full'),
        modes,
        h('p', { class: 'k-mi-note' }, 'Warn marks the count when the lane is over. Block refuses drops into a full lane, on each screen; two people dropping at once can still both get in.'),
        err,
        h('div', { class: 'k-mi-actions' },
          l.wip ? h('button', { class: 'btn', type: 'button', onclick: pick(() => app.editLaneFromMenu(laneId, { wip: null })) }, 'Clear limit') : null,
          h('button', { class: 'btn primary', type: 'button', onclick: apply }, 'Set'),
        ),
      ),
    );
  };

  main();
}

/** The kanban's ⋯ menu (docs/kanban.md, Visual design: container menu). Editors only. */
export function openContainerMenu(app: BoardApp, id: Id, at: Rect) {
  const c = app.store.get(id);
  if (app.readOnly || c?.type !== 'container') return;
  const auth = authState();
  const trackerEnabled = (auth.mode === 'signed-in' || auth.mode === 'offline') && auth.me?.tracker === true;
  const linked = c.ext?.provider === 'tabula';
  const showLink = canShowTrackerLinkAction({ trackerEnabled, linked, registered: hasRegisteredLinkDialog(), ready: app.linkTrackerKanban !== null });
  const showUnlink = canShowTrackerUnlinkAction({ trackerEnabled, linked, registered: hasRegisteredUnlinkConfirm(), ready: app.unlinkTrackerKanban !== null });
  const { show, pick } = menuPopover(app, id, 'menu', at, 240, 'Kanban menu');
  show(
    item('Rename', pick(() => app.renameKanbanPart(id))),
    item('Add lane', pick(() => app.addLaneTo(id))),
    item('Labels…', pick(() => app.openLabels?.())),
    item('Export cards (CSV)', pick(() => downloadCardsCsv(app, [id]))),
    item('Open as list', pick(() => app.openKanbanList(id))),
    showLink || showUnlink ? sep() : null,
    showLink ? item('Link to tracker…', pick(() => app.linkTrackerKanban?.(id))) : null,
    showUnlink ? item('Unlink from tracker…', pick(() => app.unlinkTrackerKanban?.(id))) : null,
    sep(),
    item(c.locked ? 'Unlock' : 'Lock', pick(() => app.toggleKanbanLock(id))),
    item('Delete kanban', pick(() => app.deleteKanban(id)), { danger: true }),
  );
}

/**
 * The Filter popover (docs/kanban.md, Filters): Mine, labels (any of), due, text, the match count and Clear. For
 * everyone, viewers included; it changes only this viewer's view (BoardApp.setKanbanFilter), never the board.
 */
export function openFilterPopover(app: BoardApp, id: Id, at: Rect) {
  if (app.store.get(id)?.type !== 'container') return;
  const { menu, pop, onClose } = menuPopover(app, id, 'filter', at, 320, 'Filter cards', 'k-filter-pop');
  menu.removeAttribute('role');
  const get = () => app.kanbanFilter(id);
  const set = (patch: Partial<KanbanFilter>) => app.setKanbanFilter(id, { ...get(), ...patch });
  const toggle = <T>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const chip = (text: string, on: () => boolean, onClick: () => void, swatch?: string, ico?: Parameters<typeof icon>[0]) => {
    let sw: HTMLElement | null = null;
    if (swatch) {
      sw = h('span', { class: 'k-chip-swatch', 'aria-hidden': 'true' });
      const c = kanbanSwatch(swatch);
      if (c) sw.style.setProperty('--c', c);
    }
    const b = h('button', { class: 'k-chip', type: 'button', onclick: onClick }, ico ? icon(ico, 14) : null, sw, h('span', { class: 'k-chip-name' }, text));
    sync.push(() => {
      b.classList.toggle('on', on());
      b.setAttribute('aria-pressed', String(on()));
    });
    return b;
  };
  const sync: (() => void)[] = [];
  const section = (title: string, aside: string | null, ...body: (HTMLElement | null)[]) =>
    h('div', { class: 'k-pop-sec' }, h('div', { class: 'k-pop-h' }, h('span', null, title), aside ? h('span', { class: 'k-pop-aside' }, aside) : null), ...body);

  const labels = listLabels(app.store);
  const text = h('input', { class: 'input', type: 'search', placeholder: 'Title or description', 'aria-label': 'Filter by words in the title or description', maxlength: '200', value: get().text });
  // typing redraws the kanban after a pause, not on every key: a board can hold 2,000 cards (FILTER_DEBOUNCE)
  let typing = 0;
  const flushText = () => {
    if (!typing) return;
    clearTimeout(typing);
    typing = 0;
    set({ text: text.value });
  };
  text.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => {
      typing = 0;
      set({ text: text.value });
    }, FILTER_DEBOUNCE) as unknown as number;
  });
  const count = h('span', { class: 'k-pop-count', role: 'status', 'aria-live': 'polite' });
  sync.push(() => {
    const n = app.filterCounts(id);
    count.textContent = matchText(get(), n.matching, n.total);
    if (document.activeElement !== text) text.value = get().text;
  });
  menu.append(
    section('Quick filters', null, h('div', { class: 'k-seg' },
      chip('Mine', () => get().mine, () => set({ mine: !get().mine }), undefined, 'user'),
      chip('Overdue', () => get().due.includes('overdue'), () => set({ due: toggle(get().due, 'overdue') }), undefined, 'calendar'),
    )),
    section('Labels', labels.length ? 'Any of' : null, labels.length
      ? h('div', { class: 'k-seg' }, ...labels.map((l) => chip(l.name, () => get().labels.includes(l.id), () => set({ labels: toggle(get().labels, l.id) }), l.color)))
      : h('p', { class: 'k-empty' }, 'This board has no labels yet.')),
    section('Due', 'Any of', h('div', { class: 'k-seg' }, ...DUE_BUCKETS.map((b) => chip(b.label, () => get().due.includes(b.key), () => set({ due: toggle(get().due, b.key as DueBucket) }))))),
    section('Text', null, text),
    h('div', { class: 'k-pop-foot' }, count, h('button', { class: 'k-linkbtn', type: 'button', onclick: () => {
      clearTimeout(typing);
      typing = 0;
      set({ mine: false, labels: [], due: [], text: '' });
      text.value = '';
    } }, 'Clear')),
  );
  const refresh = () => sync.forEach((f) => f());
  refresh();
  onClose(app.on('filter', refresh));
  // board changes (anyone's) recount after a pause too
  let counting = 0;
  onClose(app.store.onChange(() => {
    clearTimeout(counting);
    counting = setTimeout(() => {
      counting = 0;
      refresh();
    }, FILTER_DEBOUNCE) as unknown as number;
  }));
  onClose(() => {
    clearTimeout(counting);
    flushText();
  });
  pop.place();
  (menu.querySelector('button') as HTMLButtonElement | null)?.focus();
}
