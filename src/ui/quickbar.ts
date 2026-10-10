import type { BoardApp } from '../app';
import type { Align, BaseObj, ConnectorObj, Obj, Route, VAlign } from '../types';
import { isBox, isConnector } from '../types';
import { h, icon } from './dom';
import { closePopover, field, popover, segmented, swatches } from './common';
import { FILLS, STROKES, TEXT_COLORS, colorName } from '../palette';
import { stickyColorField } from './colors';
import { SHAPE_GROUPS, SHAPE_KINDS, shapePreviewSvg } from '../shapes';
import { DEFAULTS, styleOf } from '../markup';
import { safeColor } from '../../shared/colors';
import { downloadCardsCsv } from '../exporters';
import { HAS_FILL, HAS_STROKE, HAS_TEXT } from './props';
import type { mountProps } from './props';
import { trackMore } from './scroll-cue';
import { clampX, clearOfDock, dockTopOf, GROUP_BAR_GAP, placeBar, type Box } from './quickbar-layout';

// the phone layout of styles.css, where the rail runs the full height
const isPhone = () => typeof matchMedia === 'function' && matchMedia('(max-width: 860px)').matches;
import { connectorGeom } from '../geometry';
import { reactionPicker } from './stickers';
import { aiBarFor, glyph, onAiBarChange } from './ai-bar';
import { openSaveTemplate } from './save-template';
import { groupActionForSelection, groupChipAvoidBox, groupChipText } from './group-ui-logic';
import { authState, onAuth } from '../auth';
import { canSaveTemplate } from './share-logic';
import { canShowTrackerLinkAction, canShowTrackerUnlinkAction, hasRegisteredLinkDialog, hasRegisteredUnlinkConfirm, onTrackerLinkSeamChange } from '../tracker/ui/link-seam';

type IconName = Parameters<typeof icon>[0];

const isSticky = (o: Obj) => o.type === 'sticky';
const isVAligned = (o: Obj) => o.type === 'shape' || o.type === 'sticky';
// Boxes without a rotate handle; every other single box gets a rotate handle above it, so the bar lifts clear of it.
const NO_ROTATE = ['frame', 'uml-lifeline', 'uml-package', 'path'];

/** Floating quick actions above the selection. Rebuilds only on selection and meta changes, so open pickers survive. */
export function mountQuickbar(app: BoardApp, parent: HTMLElement, props: ReturnType<typeof mountProps>, opts: { demo?: boolean } = {}) {
  const bar = h('div', { class: 'tray quickbar', role: 'region', 'aria-label': 'Quick actions' });
  parent.appendChild(bar);
  let below = false;
  let shown = false;
  let paints: (() => void)[] = [];
  let lock: HTMLButtonElement | undefined;
  let more: HTMLButtonElement | undefined;

  const visible = () => app.selection.length > 0 && app.tool.kind === 'select' && !app.dragging && !app.editor.active && !app.readOnly;

  function sync() {
    const show = visible();
    bar.classList.toggle('show', show);
    if (!show) {
      if (shown) closePopover();
      shown = false;
      return;
    }
    shown = true;
    position();
  }

  /** Which edge of a bar that scrolls has more behind it (TAB-239): the CSS fades that edge out. */
  const cue = trackMore(bar);
  function position() {
    const b = app.r.contentBounds(app.selection);
    if (!b) return;
    const a = app.r.toScreen({ x: b.x, y: b.y });
    const z = app.r.toScreen({ x: b.x + b.w, y: b.y + b.h });
    const sel = app.selected();
    const lift = sel.length === 1 && isBox(sel[0]) && !sel[0].locked && !NO_ROTATE.includes(sel[0].type) ? 28 : 0;
    // Below the top bars, and above the properties panel when a phone docks it to the bottom edge.
    const top = parseFloat(getComputedStyle(bar).getPropertyValue('--panel-top')) || 72;
    const dock = dockTopOf(props.el.classList.contains('show') ? props.el.getBoundingClientRect() : null, top);
    const view = { w: window.innerWidth, h: dock ?? window.innerHeight };
    const selectedGroup = sel.length === 1 && sel[0].type === 'group';
    const gap = selectedGroup ? GROUP_BAR_GAP : undefined;
    // on a phone the bar starts right of the rail, so it is placed (and checked against the chip) from there
    const style = getComputedStyle(bar);
    const safeLeft = parseFloat(style.getPropertyValue('--safe-left')) || 0;
    const safeRight = parseFloat(style.getPropertyValue('--safe-right')) || 0;
    const safeBottom = parseFloat(style.getPropertyValue('--safe-bottom')) || 0;
    const railClear = isPhone() ? parseFloat(style.getPropertyValue('--rail-clear')) || 76 : 12 + safeLeft;
    const right = 12 + safeRight;
    const bottom = 12 + safeBottom;
    const p = placeBar({ x: a.x, y: a.y, w: z.x - a.x, h: z.y - a.y }, { w: bar.offsetWidth, h: bar.offsetHeight }, view, lift, undefined, top, gap, [...connectorBoxes(), ...aiBarBox(), ...sessionBoxes(), ...groupChipBoxes(a, top)], railClear, right, bottom);
    // a tall selection leaves no free room above or below it: the bar then sits on the selection, above the session bar, never over it
    const sessionTop = Math.min(Infinity, ...sessionBoxes().map((b) => b.y));
    const y = Math.max(top, Math.min(clearOfDock(p.y, bar.offsetHeight, dock, top), sessionTop - 12 - bar.offsetHeight));
    bar.style.transform = `translate(${clampX(p.x, bar.offsetWidth, view.w, railClear, right)}px, ${y}px)`;
    below = p.below;
    cue();
  }

  /** A selected group's name chip (TAB-106): the bar clears it, flipping below the group when above would cover it. */
  function groupChipBoxes(corner: { x: number; y: number }, topInset: number): Box[] {
    const sel = app.selected();
    const group = sel.length === 1 && sel[0].type === 'group' ? sel[0] : null;
    if (!group) return [];
    const text = groupChipText((group as { name?: unknown }).name, app.store.childrenOf(group.id).filter((c) => c.parent === group.id).length);
    const viewport = parent.getBoundingClientRect();
    const chip = parent.querySelector<HTMLElement>('.group-chip:not(.group-path-chip)');
    const box = groupChipAvoidBox(corner.x, corner.y, text, app.zoom, {
      viewport: { width: viewport.width || window.innerWidth, height: viewport.height || window.innerHeight },
      topInset,
      width: chip?.offsetWidth || undefined,
    });
    return box ? [box] : [];
  }

  /** The session bar and the poll card sit over the board's foot: the bar flips above the selection instead of landing under them. */
  function sessionBoxes(): Box[] {
    const origin = parent.getBoundingClientRect();
    return [...parent.querySelectorAll<HTMLElement>('.flowbar.show, .poll-card:not([hidden])')].map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };
    });
  }

  /** The AI bar (or its button) is one more thing the quick bar keeps off: it flips above the selection instead of landing under it. */
  function aiBarBox(): Box[] {
    const r = aiBarFor(app)?.rect();
    if (!r) return [];
    const origin = parent.getBoundingClientRect();
    return [{ x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height }];
  }

  /** Screen boxes around each segment of the connectors attached to the selection, with room for arrowheads. */
  function connectorBoxes(): Box[] {
    const get = (id: string) => app.store.getPlaced(id);
    const ids = new Set<string>();
    for (const o of app.selected()) for (const c of app.store.connectorsOf(o.id)) ids.add(c.id);
    const out: Box[] = [];
    const pad = 8;
    for (const id of ids) {
      const c = app.store.get(id);
      const g = isConnector(c) ? connectorGeom(get, c, app.r.connectorLayout()) : null;
      if (!g) continue;
      const pts = g.pts.map((p) => app.r.toScreen(p));
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        out.push({ x: Math.min(a.x, b.x) - pad, y: Math.min(a.y, b.y) - pad, w: Math.abs(a.x - b.x) + 2 * pad, h: Math.abs(a.y - b.y) + 2 * pad });
      }
    }
    return out;
  }

  function refreshStates() {
    const sel = app.selected();
    if (lock) {
      const locked = sel.length > 0 && sel.every((o) => o.locked);
      lock.replaceChildren(icon(locked ? 'unlock' : 'lock', 18));
      lock.setAttribute('aria-label', locked ? 'Unlock' : 'Lock');
    }
    if (more) {
      more.classList.toggle('on', props.isOpen());
      more.setAttribute('aria-pressed', String(props.isOpen()));
    }
    paints.forEach((f) => f());
  }

  function refresh() {
    if (shown) position();
    refreshStates();
  }

  function open(anchor: HTMLElement, content: HTMLElement) {
    popover(anchor, content, { side: below ? 'bottom' : 'top', className: 'qb-pop' });
  }

  const styleValue = (key: 'fill' | 'stroke') => (): string => {
    const o = app.selectedLeaves()[0];
    // styleOf resolves the stored colour through the colour grammar: it becomes a custom property below (TAB-203)
    if (!o) return 'none';
    if (key === 'stroke' && o.type === 'icon') return safeColor((o as BaseObj).textColor, styleOf(o).stroke);
    return styleOf(o)[key];
  };
  const stickyFill = () => safeColor((app.selectedLeaves()[0] as BaseObj | undefined)?.fill, DEFAULTS.sticky.fill);

  function swatch(label: string, current: () => string, content: () => HTMLElement) {
    const chip = h('span', { class: 'qb-chip' });
    const b: HTMLButtonElement = h('button', { class: 'icon-btn qb-swatch', 'aria-label': label, 'aria-haspopup': 'dialog', onclick: () => open(b, content()) }, chip);
    const paint = () => {
      const v = current();
      b.style.setProperty('--c', v);
      chip.classList.toggle('none', v === 'none');
    };
    paint();
    paints.push(paint);
    return b;
  }

  function closeOnTouchRadioPick(content: HTMLElement) {
    let touchPointer = false;
    content.addEventListener('pointerdown', (event) => { touchPointer = event.pointerType === 'touch'; });
    content.addEventListener('pointercancel', () => { touchPointer = false; });
    content.addEventListener('click', (event) => {
      if (!(event.target as HTMLElement | null)?.closest('[role="radio"]')) {
        touchPointer = false;
        return;
      }
      const pointerType = (event as PointerEvent).pointerType;
      const touchPick = pointerType === 'touch' || ((pointerType !== 'mouse' && pointerType !== 'pen') && touchPointer);
      touchPointer = false;
      if (touchPick) closePopover();
    });
    return content;
  }

  function menu(name: IconName, label: string, content: () => HTMLElement) {
    const b: HTMLButtonElement = h('button', { class: 'icon-btn', 'aria-label': label, 'aria-haspopup': 'dialog', onclick: () => open(b, content()) }, icon(name, 18));
    return b;
  }

  function moreActions() {
    const flipItem = (axis: 'horizontal' | 'vertical') => {
      const horizontal = axis === 'horizontal';
      const reason = app.flipReason(axis);
      const label = horizontal ? 'Flip horizontal' : 'Flip vertical';
      return h('button', {
        class: 'menu-item', type: 'button', role: 'menuitem', disabled: reason !== null,
        'aria-keyshortcuts': horizontal ? 'Shift+H' : 'Shift+V',
        'data-tip': reason ?? label,
        'data-tip-key': horizontal ? 'shift+h' : 'shift+v',
        onclick: () => { closePopover(); app.flipSelection(axis); },
      }, icon(horizontal ? 'flipHorizontal' : 'flipVertical', 18), h('span', null, label), h('span', { class: 'menu-hint' }, horizontal ? 'Shift+H' : 'Shift+V'));
    };
    return h('div', { class: 'menu qb-action-menu', role: 'menu', 'aria-label': 'More actions' },
      flipItem('horizontal'), flipItem('vertical'),
    );
  }

  function action(name: IconName, label: string, onClick: () => void, cls = '', key?: string) {
    return h('button', { class: `icon-btn${cls ? ` ${cls}` : ''}`, 'aria-label': label, 'data-tip-key': key, onclick: onClick }, icon(name, 18));
  }

  /**
   * Kanban entries (docs/kanban.md, States): a card gets Open as the primary action, then Owner, Due and Labels (each
   * opens the card dialog on that field) and Turn into sticky; stickies get Turn into card and, two or more, Make kanban;
   * a kanban gets its Labels.
   */
  function kanbanActions(sel: Obj[]): HTMLElement[] {
    const out: HTMLElement[] = [];
    const cards = sel.filter((o) => o.type === 'card');
    const stickies = sel.filter(isSticky);
    if (cards.length === 1 && sel.length === 1) {
      const id = cards[0].id;
      out.push(
        h('button', { class: 'icon-btn qb-text on', type: 'button', 'aria-label': 'Open card', 'data-tip-key': 'enter', onclick: () => app.openCardDialog(id) }, 'Open'),
        action('user', 'Owner', () => app.openCardDialog(id, 'owner')),
        action('calendar', 'Due date', () => app.openCardDialog(id, 'due')),
        action('tag', 'Labels', () => app.openCardDialog(id, 'labels')),
      );
    }
    if (cards.length && cards.length === sel.length) out.push(action('sticky', cards.length === 1 ? 'Turn into sticky' : 'Turn into stickies', () => app.turnIntoStickies(), '', 'k'));
    if (stickies.length && app.canTurnIntoCards()) out.push(action('card', stickies.length === 1 ? 'Turn into card' : 'Turn into cards', () => app.turnIntoCards(), '', 'k'));
    if (stickies.length >= 2 && !app.readOnly) out.push(action('kanban', 'Make kanban from selection', () => app.makeKanbanFromSelection()));
    if (sel.length === 1 && sel[0].type === 'container') {
      const id = sel[0].id;
      const auth = authState();
      const trackerEnabled = (auth.mode === 'signed-in' || auth.mode === 'offline') && auth.me?.tracker === true;
      const linked = sel[0].ext?.provider === 'tabula';
      // slice 4: Add lane and Filter, as the design's quick-action bar for a kanban, and its ⋯ menu (the bar's own ⋯ is
      // the properties panel)
      // slice 5: Open as list, the primary action on a phone (docs/kanban.md, Visual design, Phone)
      out.push(isPhone()
        ? h('button', { class: 'icon-btn qb-text on', type: 'button', 'aria-label': 'Open as list', onclick: () => app.openKanbanList(id) }, 'Open as list')
        : action('kanban', 'Open as list', () => app.openKanbanList(id)));
      out.push(
        action('plus', 'Add lane', () => app.addLaneTo(id)),
        action('filter', 'Filter cards', () => app.openContainerControl(id, 'filter')),
        action('tag', 'Labels', () => app.openLabels?.()),
        action('download', 'Export cards (CSV)', () => downloadCardsCsv(app, [id])),
        action('menu', 'Kanban menu', () => app.openContainerControl(id, 'menu')),
      );
      if (canShowTrackerLinkAction({ trackerEnabled, linked, registered: hasRegisteredLinkDialog(), ready: app.linkTrackerKanban !== null && !app.readOnly })) {
        out.push(action('link', 'Link to tracker', () => app.linkTrackerKanban?.(id)));
      }
      if (canShowTrackerUnlinkAction({ trackerEnabled, linked, registered: hasRegisteredUnlinkConfirm(), ready: app.unlinkTrackerKanban !== null && !app.readOnly })) {
        out.push(action('link', 'Unlink from tracker', () => app.unlinkTrackerKanban?.(id)));
      }
    }
    if (sel.length === 1 && sel[0].type === 'lane') {
      const id = sel[0].id;
      out.push(action('menu', 'Lane menu', () => app.openLaneMenu(id)));
    }
    return out;
  }

  function build() {
    paints = [];
    lock = undefined;
    more = undefined;
    const sel = app.selected();
    const styleSel = app.selectedLeaves();
    if (!sel.length) {
      bar.replaceChildren();
      return;
    }
    const first = sel[0];
    const same = sel.every((o) => o.type === first.type);
    const styleFirst = styleSel[0] ?? first;
    const styleSame = styleSel.length > 0 && styleSel.every((o) => o.type === styleFirst.type);
    const boxes = sel.filter(isBox).length;
    const groups: HTMLElement[][] = [];
    groups.push(kanbanActions(sel));

    const style: HTMLElement[] = [];
    if (styleSame && styleFirst.type === 'sticky') {
      style.push(swatch('Colour', stickyFill, () => {
        const picker = stickyColorField(app, stickyFill(), (v) => {
          app.stickyColor = v;
          app.updateSelectedLeaves({ fill: v }, isSticky);
        }, {
          onLive: (v) => app.store.transact(() => app.selectedLeaves().filter(isSticky).forEach((o) => app.store.update(o.id, { fill: v }))),
          size: 'lg',
          label: 'Sticky note colour',
        });
        return field('Colour', closeOnTouchRadioPick(picker));
      }));
    }
    if (same && first.type === 'shape') {
      style.push(menu('shapes', 'Shape', () => {
        const cur = (app.selected()[0] as BaseObj).kind;
        return h('div', null, ...SHAPE_GROUPS.flatMap(([group, label]) => [
          h('div', { class: 'list-label' }, label),
          h('div', { class: 'qb-shapes' }, ...SHAPE_KINDS.filter((k) => k.group === group).map((k) => h('button', {
            class: k.kind === cur ? 'on' : '', 'data-tip': k.label, 'aria-label': k.label, html: shapePreviewSvg(k.kind, { w: 36, h: 28 }, 3),
            onclick: () => app.updateSelected({ kind: k.kind }, (o) => o.type === 'shape'),
          }))),
        ]));
      }));
    }
    if (styleSel.some(HAS_FILL)) {
      style.push(swatch('Fill', styleValue('fill'), () => field('Fill', swatches(FILLS, styleValue('fill')(), (v) => app.updateSelectedLeaves({ fill: v }, HAS_FILL), { label: 'Fill colour' }))));
    }
    if (styleSel.some(HAS_STROKE)) {
      const label = styleSel.every((o) => o.type === 'icon') ? 'Colour' : 'Line';
      style.push(swatch(label, styleValue('stroke'), () => field(label, swatches(STROKES, styleValue('stroke')(), (v) => {
        app.store.undo.stopCapturing();
        app.store.transact(() => app.selectedLeaves().filter(HAS_STROKE).forEach((o) => app.store.update(o.id, o.type === 'icon' ? { textColor: v } : { stroke: v })));
        app.store.undo.stopCapturing();
      }, { label: 'Line colour' }))));
    }
    if (sel.every(isConnector)) {
      style.push(menu('connector', 'Route', () => field('Route', segmented<Route>([
        { value: 'straight', label: 'Straight' }, { value: 'elbow', label: 'Elbow' }, { value: 'curved', label: 'Curved' },
      ], (app.selected()[0] as ConnectorObj).route, (v) => {
        app.updateSelected({ route: v }, isConnector);
        app.connectorDefaults.route = v;
      }, 'Connector route'))));
    }
    groups.push(style);

    // Images (docs/images.md): back to the natural size, and a description for screen readers and the summary
    const pictures = sel.filter((o): o is BaseObj => o.type === 'image');
    const picture: HTMLElement[] = [];
    if (pictures.length) {
      picture.push(h('button', {
        class: 'icon-btn qb-text', 'aria-label': 'Actual size', 'data-tip': 'Reset to the natural size',
        onclick: () => app.store.transact(() => pictures.forEach((o) => {
          if (o.nw && o.nh) app.store.update(o.id, { x: Math.round(o.x + o.w / 2 - o.nw / 2), y: Math.round(o.y + o.h / 2 - o.nh / 2), w: o.nw, h: o.nh });
        })),
      }, '100%'));
      if (pictures.length === 1) {
        picture.push(menu('text', 'Alt text', () => {
          const input = h('input', { class: 'input', maxlength: 300, value: pictures[0].alt ?? '', 'aria-label': 'Alt text', placeholder: 'Describe the picture', autocomplete: 'off' });
          const save = () => app.updateSelected({ alt: input.value.trim() || undefined }, (o) => o.type === 'image');
          input.addEventListener('change', save);
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing) {
              save();
              closePopover();
            }
          });
          return field('Alt text', input);
        }));
      }
    }
    groups.push(picture);

    const text: HTMLElement[] = [];
    if (styleSel.some(HAS_TEXT)) {
      text.push(menu('text', 'Text', () => {
        const s = styleOf(app.selectedLeaves()[0]);
        const parts: HTMLElement[] = [field('Align', segmented<Align>([
          { value: 'left', label: 'Align left', icon: icon('alignLeft', 16) },
          { value: 'center', label: 'Align centre', icon: icon('alignCenterH', 16) },
          { value: 'right', label: 'Align right', icon: icon('alignRight', 16) },
        ], s.align, (v) => app.updateSelectedLeaves({ align: v }, HAS_TEXT), 'Text alignment'))];
        if (app.selectedLeaves().some(isVAligned)) {
          parts.push(field('Vertical', segmented<VAlign>([
            { value: 'top', label: 'Align top', icon: icon('alignTop', 16) },
            { value: 'middle', label: 'Align middle', icon: icon('alignMiddleV', 16) },
            { value: 'bottom', label: 'Align bottom', icon: icon('alignBottom', 16) },
          ], s.valign, (v) => app.updateSelectedLeaves({ valign: v }, isVAligned), 'Vertical alignment')));
        }
        parts.push(field('Text colour', swatches(TEXT_COLORS.map((c) => ({ name: colorName(c), value: c })), s.textColor, (v) => app.updateSelectedLeaves({ textColor: v }, HAS_TEXT), { label: 'Text colour' })));
        return h('div', null, ...parts);
      }));
    }
    groups.push(text);

    const groupActions: HTMLElement[] = [];
    const groupAction = groupActionForSelection(sel);
    if (groupAction === 'group') {
      const groupReason = app.groupReason();
      groupActions.push(h('button', {
        class: 'icon-btn qb-text group-action', type: 'button', 'aria-label': 'Group', 'data-tip': groupReason ?? 'Group', 'data-tip-key': 'mod+g',
        disabled: groupReason !== null, onclick: () => app.groupSelection(),
      }, icon('group', 20), 'Group'));
    } else if (groupAction === 'ungroup') {
      const canUngroup = app.canUngroupSelection();
      groupActions.push(h('button', {
        class: 'icon-btn qb-text group-action', type: 'button', 'aria-label': 'Ungroup', 'data-tip': canUngroup ? 'Ungroup' : 'Select a group to ungroup', 'data-tip-key': 'mod+shift+g',
        disabled: !canUngroup, onclick: () => app.ungroupSelection(),
      }, icon('ungroup', 20), 'Ungroup'));
    }
    groups.push(groupActions);

    const arrange: HTMLElement[] = [];
    if (boxes >= 2) {
      arrange.push(menu('alignLeft', 'Align', () => {
        const n = app.selected().filter(isBox).length;
        return h('div', { class: 'qb-align' },
          action('alignLeft', 'Align left edges', () => app.align('left')),
          action('alignCenterH', 'Align centres horizontally', () => app.align('centerH')),
          action('alignRight', 'Align right edges', () => app.align('right')),
          action('alignTop', 'Align top edges', () => app.align('top')),
          action('alignMiddleV', 'Align centres vertically', () => app.align('middleV')),
          action('alignBottom', 'Align bottom edges', () => app.align('bottom')),
          n >= 3 ? action('distributeH', 'Distribute horizontally', () => app.distribute('h')) : null,
          n >= 3 ? action('distributeV', 'Distribute vertically', () => app.distribute('v')) : null,
        );
      }));
    }
    // opens the AI bar with Cluster armed on these stickies; it runs nothing
    if (aiBarFor(app) && sel.filter(isSticky).length >= 2) {
      arrange.push(h('button', {
        class: 'icon-btn', type: 'button', 'aria-label': 'Cluster with AI', 'data-tip': 'Cluster with AI',
        onclick: () => aiBarFor(app)?.open({ arm: 'cluster', context: 'selection' }),
      }, glyph('spark', 18)));
    }
    groups.push(arrange);
    groups.push([menu('stickers', 'React with a sticker', () => reactionPicker(app))]);

    lock = h('button', { class: 'icon-btn', onclick: () => app.toggleLock() });
    let actions: HTMLButtonElement;
    actions = h('button', { class: 'icon-btn', 'aria-label': 'More actions', 'aria-haspopup': 'menu', onclick: () => open(actions, moreActions()) }, icon('dots', 18));
    more = h('button', { class: 'icon-btn', 'aria-label': 'More properties', onclick: () => props.toggle() }, icon('properties', 18));
    groups.push([
      lock,
      action('dup', 'Duplicate', () => app.duplicate(), '', 'mod+d'),
      ...(opts.demo || !canSaveTemplate(authState().mode) ? [] : [action('templates', 'Save as template', () => openSaveTemplate(app, [...app.selection]))]),
      action('trash', 'Delete', () => app.deleteSelection(), 'danger', 'delete'),
    ]);
    groups.push([actions, more]);

    const parts = groups.filter((g) => g.length).flatMap((g, i) => (i ? [h('span', { class: 'qb-sep', 'aria-hidden': 'true' }), ...g] : g));
    bar.replaceChildren(...parts);
    refreshStates();
  }

  app.on('selection', () => {
    closePopover();
    build();
    sync();
  });
  app.on('meta', () => {
    build();
    sync();
  });
  app.on('objects', refresh);
  app.r.onCamera(() => { closePopover(); refresh(); });
  app.on('drag', sync);
  app.on('editing', sync);
  app.on('tool', sync);
  app.on('readonly', sync);
  props.onToggle(build);
  // a bare test app has no lifetime; the real one always does
  app.lifetime?.signal.addEventListener('abort', onAuth(() => { build(); sync(); }), { once: true });
  app.lifetime?.signal.addEventListener('abort', onTrackerLinkSeamChange(() => { build(); sync(); }), { once: true });
  // the AI bar mounting adds or takes away Cluster; its moving makes the quick bar find its place again
  onAiBarChange(app, (why) => {
    if (why === 'layout') {
      if (shown) position();
      return;
    }
    build();
    sync();
  });
  // the panel's top moves when it opens, closes or is rebuilt at another height, and the bar keeps clear of it
  new ResizeObserver(() => { if (shown) position(); }).observe(props.el);
  // the session bar and poll card come, go and change height: the quick bar keeps clear of them
  const sessionWatch = new ResizeObserver(() => { if (shown) position(); });
  const watchSession = () => parent.querySelectorAll('.flowbar, .poll-card').forEach((el) => sessionWatch.observe(el));
  watchSession();
  if (typeof MutationObserver === 'function') {
    new MutationObserver(() => {
      watchSession();
      if (shown) position();
    }).observe(parent, { subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  }

  build();
  sync();
}
