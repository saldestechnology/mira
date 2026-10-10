import { planStep } from './z-order';
import { gatherCopyObjects, gatherObjects, isWithheld, selectableIds } from './private-select';
import { BoardImages } from './board-images';
import type { BaseObj, ConnectorObj, End, Group, Id, Obj, ObjType, Point, Rect, ShapeKind, UmlRelation, User } from './types';
import { isConnectable } from './connectable';
import { isBox, isConnector } from './types';
import type { BoardConn } from './sync';
import type { Anchor, Comments, Thread } from './comments';
import { anchorFor, anchorPosition, threadVisible } from './comments';
import { pinAt, pinViews } from './pins';
import type { BoardRole } from './api';
import type { Store } from './store';
import { newId } from './store';
import { Renderer, handlesFor, type HandleId } from './render';
import {
  boxBounds, center, connectorGeom, distToPolyline, hitBox, objBounds, pointInRect, rectContains, rectOfPoints, rectsIntersect,
  freeSpotInDirection, neighborInDirection, rotate, sideAnchor, snapTo, toLocal,
} from './geometry';
import { cardBody, kanbanHeaderControls, objectMarkup, styleOf, textHeight } from './markup';
import { cornerBox, cornerFactor, isCorner, keyResize, scaledText, type Corner, type TextKey } from './text-resize';
import {
  addLane, addLaneRefusal, moveLaneRefusal, laneReorderRefusal, moveLaneTo, editLane, laneDeleteIds, laneEditRefusal, moveLane, structureRefusal, wipRefusal, type LanePatch,
  cardsToStickies, containerOf, laneOf, dropLoose, kanbanFromStickies, mayConvertSticky, moveCards, moveRefusal, movingOrder, newKanban, newKanbanSize, planKanbanDelete, stickiesToCards,
} from './containers';
import { CardInput } from './ui/kanban';
import {
  dropLine, keyboardMove, laneCards, laneDropIndex, laneDropLine, lowDetail, laneRegionAt, laneTargetAt, moveAnnouncement, type LaneTarget, type MoveKey,
  EMPTY_FILTER, addRow, cardMatches, cleanFilter, filterChips, filterParts, filterStorageKey, inRect, localToday, wipFullLabel, withoutChip,
  type FilterChip, type FilterViewer, type KanbanFilter,
} from './ui/kanban-logic';
import { listLabels } from './labels';
import { KANBAN, wipCheck } from '../shared/containers';
import { remapObjects } from './custom-templates';
import { guidesCover, referenceRects, snapMove, snapResize, snapResizeLocked, startGuides, type Guide, type GuideSession } from './guides';
import { defaultSize as shapeDefaultSize } from './shapes';
import { RELATIONS, classHeight, type UmlElementDef } from './uml';
import { CANVAS_INK, STICKY_COLORS, customStickyColors, normalizeHex, parseHex, personColor } from './palette';
import { safeColor } from '../shared/colors';
import { TOOL_KEYS } from './shortcuts';
import { guestMark } from './ui/guest-mark';
import { escapeAction } from './ui/escape-priority';
import { watchCardHeights } from './card-height-heal';
import { flipDisabledReason, planFlip, type FlipAxis } from './flip';
import { fontCss, measure } from './text';
import { OBJECT_TEXT_MAX } from '../shared/text-limits.mjs';

const STICKY_COLOR_KEY = 'driftboard:sticky-color';
const isCardLinkTarget = (target: EventTarget | null) => {
  const el = target as unknown as { closest?: (selector: string) => unknown } | null;
  return !!el?.closest?.('[data-card-link]');
};
function loadStickyColor(): string {
  try {
    const c = localStorage.getItem(STICKY_COLOR_KEY);
    if (c && parseHex(c)) return normalizeHex(c);
  } catch { /* storage unavailable */ }
  return STICKY_COLORS[0].fill;
}
import { ensureFont } from './fonts';
import { Flow } from './flow';
import { TextEditor } from './editor';
import { StyleEdit } from './style-edit';
import { ancestorsOf, descendantsOf, effectiveLocked, groupPlan, isGroup, liftToScope, pick, topLevelAncestors, ungroupPlan } from './groups';

export type Tool =
  | { kind: 'select' }
  | { kind: 'hand' }
  | { kind: 'sticky' }
  | { kind: 'text' }
  | { kind: 'shape'; shape: ShapeKind }
  | { kind: 'connector'; relation?: UmlRelation }
  | { kind: 'pen' }
  | { kind: 'frame' }
  | { kind: 'kanban' }
  | { kind: 'comment' }
  | { kind: 'uml'; def: UmlElementDef };

type Drag =
  | { mode: 'pan'; sx: number; sy: number; cx: number; cy: number }
  | { mode: 'move'; start: Point; ids: Id[]; orig: Map<Id, Obj>; bounds: Rect; moved: boolean; guides?: GuideSession }
  | { mode: 'resize'; id: Id; handle: HandleId; o0: BaseObj; guides?: GuideSession }
  | { mode: 'rotate'; id: Id; c: Point; a0: number; r0: number }
  | { mode: 'marquee'; start: Point; base: Id[]; moved: boolean }
  | { mode: 'create'; start: Point; tool: Tool }
  | { mode: 'connect'; from: End; relation?: UmlRelation; moved: boolean }
  | { mode: 'endpoint'; id: Id; end: 'from' | 'to' }
  | { mode: 'pen'; pts: Point[] }
  // cards dragged as a ghost: nothing is written until the drop (docs/kanban.md, Decisions 4)
  // (`armed`: a touch long press started it, so it lifts at once, docs/kanban.md, Phone and touch)
  // a lane dragged by its header to another place among its kanban's lanes: nothing is written until the drop
  | { mode: 'lane'; start: Point; lane: Id; container: Id; moved: boolean; to: number | null }
  | { mode: 'cards'; start: Point; ids: Id[]; lead: Id; grab: Point; moved: boolean; target: LaneTarget | null; frame: Id | null; armed?: boolean };

/** The field the card dialog starts on. */
export type CardFocus = 'title' | 'owner' | 'due' | 'link' | 'labels';
/** The kanban menus (docs/kanban.md, slice 4): a lane's ⋯, the container's ⋯, and the Filter popover. */
export type KanbanMenuKind = 'lane' | 'container' | 'filter';
/** A control on a kanban's header, or its add-lane +. */
type KanbanControl = { kind: 'menu' } | { kind: 'filter' } | { kind: 'chip'; key: string } | { kind: 'addLane' };

type Events = 'selection' | 'tool' | 'flow' | 'meta' | 'objects' | 'status' | 'presence' | 'drag' | 'editing' | 'readonly' | 'comments' | 'filter' | 'vote-skip';

/** The phone layout's breakpoint (styles.css, `max-width: 860px`): where a kanban opens as a list on a double tap. */
const phoneWidth = () => typeof matchMedia === 'function' && matchMedia('(max-width: 860px)').matches;

const CONNECTABLE = isConnectable;

const COMMENTS_VISIBLE_KEY = 'driftboard:comments-visible';
function loadCommentsVisible(): boolean {
  try {
    return localStorage.getItem(COMMENTS_VISIBLE_KEY) !== '0';
  } catch {
    return true;
  }
}

export class BoardApp {
  readonly store: Store;
  readonly r: Renderer;
  readonly flow: Flow;
  readonly editor: TextEditor;
  /** The inline "+ Add card" input (docs/kanban.md, Cards). */
  readonly cardInput: CardInput;
  /** The card a keyboard move is on: it shows the ring and the "Moving" tag until the selection changes. */
  private kbMoving: Id | null = null;
  /** Live previews from the properties panel; see style-edit.ts. */
  readonly styleEdit: StyleEdit;
  tool: Tool = { kind: 'select' };
  selection: Id[] = [];
  /** Group entered on this device; it is view state and is never synced. */
  scope: Id | null = null;
  /** Shows a short toast; the UI assigns it. */
  notify: (msg: string) => void = () => {};
  /** Tells screen readers what just changed on the board; the UI assigns it (src/ui/announce.ts). */
  announce: (msg: string) => void = () => {};
  /** Colour of the next sticky note; remembered on this device. */
  private _stickyColor = loadStickyColor();
  get stickyColor() {
    return this._stickyColor;
  }
  set stickyColor(c: string) {
    // it is drawn as an inline style on the sticky button; a picked colour can come from a stored object (TAB-203)
    c = safeColor(c, STICKY_COLORS[0].fill);
    this._stickyColor = c;
    try {
      localStorage.setItem(STICKY_COLOR_KEY, c);
    } catch { /* storage unavailable */ }
    this.emit('tool');
  }

  /** Remember a custom sticky colour on the board so everyone can reuse it. */
  addStickyColor(c: string) {
    const hex = normalizeHex(c);
    if (!parseHex(hex) || STICKY_COLORS.some((s) => s.fill.toUpperCase() === hex)) return;
    const cur = this.store.getMeta().stickyColors.filter((x) => x.toUpperCase() !== hex);
    this.store.setMeta({ stickyColors: [hex, ...cur].slice(0, 12) });
  }

  /** Default colours followed by the board's custom ones. */
  stickyPalette(): { name: string; value: string; custom?: boolean }[] {
    return [
      ...STICKY_COLORS.map((c) => ({ name: c.name, value: c.fill })),
      // collaborators write this list; only plain hex colours are offered (they become inline styles, TAB-203)
      ...customStickyColors(this.store.getMeta().stickyColors).map((c) => ({ name: `Custom ${c}`, value: c, custom: true })),
    ];
  }
  connectorDefaults: Partial<ConnectorObj> = { route: 'elbow', startHead: 'none', endHead: 'arrow' };
  private drag: Drag | null = null;
  /** A press being held: it unlocks a locked object, or (`fire`) does something else when it completes. */
  private longPress: { id: Id; x: number; y: number; timer: number; ring: HTMLElement; fire?: () => void } | null = null;
  private spaceDown = false;
  private listeners = new Map<Events, Set<() => void>>();
  private lastPointer: Point = { x: 0, y: 0 };
  /** The right button was dragged since it went down: the view moved, so its contextmenu is not a click. */
  private panned = false;
  private clipboard: Obj[] = [];
  private cursorTimer = 0;
  private pendingFrame = 0;
  /** Aborted when the board closes; removes window listeners. */
  readonly lifetime = new AbortController();
  private disposers: (() => void)[] = [];
  /** Where the pixels of image objects come from and how new ones reach the relay (src/board-images.ts). */
  readonly images: BoardImages;
  /** Set by the board UI: opens the card dialog (src/ui/card-dialog.ts), focused on one of its fields. */
  openCard: ((id: Id, focus?: CardFocus) => void) | null = null;
  /** Set by the board UI: opens the Labels dialog (src/ui/labels-dialog.ts). */
  openLabels: (() => void) | null = null;
  /**
   * Set by the board UI: opens a kanban's lane menu, its container menu or its filter popover against a rectangle in
   * page coordinates (src/ui/kanban-menus.ts).
   */
  openKanbanMenu: ((kind: KanbanMenuKind, id: Id, at: Rect) => void) | null = null;
  /** Set by the board UI: opens a kanban as a list (src/ui/container-sheet.ts), on one of its lanes. */
  openSheet: ((containerId: Id, laneId?: Id) => void) | null = null;
  /** Set by the board UI while the workspace tracker is enabled: opens the registered kanban link flow. */
  linkTrackerKanban: ((containerId: Id) => void) | null = null;
  /** Set by the board UI while the workspace tracker is enabled: opens the registered unlink confirmation. */
  unlinkTrackerKanban: ((containerId: Id) => void) | null = null;
  /** Set by the board UI: opens the object menu at a screen position. */
  openObjectMenu: ((x: number, y: number) => void) | null = null;
  /** Set by the board UI: closes its open library drawer or Comments/Chat tray when Escape reaches it. */
  closeEscapeDrawer: (() => boolean) | null = null;
  /** Set by the board UI: gets image files pasted from the clipboard. */
  onImageFiles: ((files: File[]) => void) | null = null;

  constructor(readonly conn: BoardConn, readonly user: User, parent: HTMLElement, readonly hostedWorkspace = false) {
    this.store = conn.store;
    this.r = new Renderer(this.store, parent);
    this.r.readOnly = this.readOnly;
    this.flow = new Flow(this);
    this.editor = new TextEditor(this);
    this.cardInput = new CardInput(this);
    this.r.ownerColor = (o) => {
      const p = o.ownerId ? this.participants().find((x) => x.user.id === o.ownerId) : undefined;
      return p ? personColor(p.user.color) : undefined;
    };
    this.r.filterChips = (id) => this.filterChipsOf(id);
    this.disposers.push(this.watchLabels());
    this.r.dimmed = (o) => this.isDimmed(o);
    this.r.commentCount = (id) => this.comments.list().filter((t) => t.anchor.obj === id && !t.resolved).reduce((n, t) => n + 1 + t.replies.length, 0);
    this.styleEdit = new StyleEdit(this.store, () => this.selectedLeaves(), (o, patch) => this.writeStyle(o, patch));
    this.r.isHidden = (o) => this.flow.isHidden(o);
    this.images = new BoardImages(this);
    this.store.undo.on('stack-item-popped', (e) => this.handleUndoStackPopped(e.type));

    const meta = this.store.getMeta();
    this.r.gridType = meta.gridType;
    this.r.gridSize = meta.gridSize;
    this.store.meta.observe(() => {
      const m = this.store.getMeta();
      this.r.gridType = m.gridType;
      this.r.gridSize = m.gridSize;
      this.r.setCamera({});
      this.emit('meta');
    });

    this.store.onChange((changed) => {
      // drop deleted, locked and hidden objects from the selection (someone else may have hidden one)
      const before = this.selection.join('\0');
      const oldScope = this.scope;
      this.selection = this.selectionAtScope(this.selection.filter((id) => {
        const o = this.store.get(id);
        return !!o && !effectiveLocked(o, (parent) => this.store.get(parent));
      }));
      if (this.selection.join('\0') !== before || this.scope !== oldScope) this.emitSelection();
      for (const id of changed) {
        const o = this.store.get(id);
        if (o && 'font' in o && o.font) ensureFont(o.font, [o.fontWeight || 400, 700]);
      }
      this.refreshPins();
      if (this.kbMoving) this.showMoving(this.kbMoving);
      this.emit('objects');
    });

    this.store.onReadOnly((v) => {
      this.r.readOnly = v;
      if (v) {
        this.cancelLongPress();
        this.editor.commit();
        this.cardInput.stop();
        this.cancelCardDrag();
        this.store.undo.clear();
        if (this.drag && this.drag.mode !== 'pan') {
          this.drag = null;
          this.r.setOverlay({ marquee: null, preview: '', guides: [], dropTarget: null, anchorsFor: null });
        }
        this.setTool(this.tool);
      }
      // lanes offer "+ Add card" to editors only
      this.r.invalidateAll();
      this.emit('readonly');
      this.emitSelection();
    });
    this.disposers.push(this.watchCardHeights());

    this.bindPointer();
    this.bindKeys();
    this.bindPresence();
    this.loadBoardFonts();
    conn.onStatus(() => this.emit('status'));
    let ownersSig = '';
    const redrawCards = () => this.r.invalidateObjects([...this.store.cache.values()].filter((o) => o.type === 'card').map((o) => o.id));
    this.disposers.push(
      this.comments.onChange(() => { this.refreshPins(); redrawCards(); }),
      // an owner badge takes the colour of a person in the room: redraw when who is here changes, not on every cursor move
      this.on('presence', () => {
        const sig = this.participants().map((x) => `${x.user.id}:${x.user.color}`).sort().join('|');
        if (sig === ownersSig) return;
        ownersSig = sig;
        if ([...this.store.cache.values()].some((o) => o.type === 'card' && (o as BaseObj).ownerId)) redrawCards();
      }),
      this.on('flow', () => this.refreshPins()),
      this.on('comments', () => this.refreshPins()),
    );

    // Start centred on existing content.
    requestAnimationFrame(() => {
      const b = this.r.contentBounds();
      if (b) this.r.fit(b, 120, 1);
      else this.r.setCamera({ x: -this.r.size().w / 2, y: -this.r.size().h / 2, zoom: 1 });
    });
    this.refreshPins();
  }

  private handleUndoStackPopped(type: 'undo' | 'redo') {
    this.announce(type === 'undo' ? 'Undone' : 'Redone');
    this.resetScopeSelection(this.store.takeUndoChanged());
  }

  /** Repairs browser-measured card heights after remote edits and when this board opens. */
  private watchCardHeights(): () => void {
    return watchCardHeights({
      store: this.store,
      role: () => this.role,
      busy: () => Boolean(this.drag || this.editor.active || this.cardInput.active),
      hidden: (card) => !this.store.isShown(card)
        || this.flow.isHidden(card)
        || Boolean(card.privateStep && !this.store.getFlow().reveal),
    });
  }

  // ---------------------------------------------------------------- events

  on(ev: Events, fn: () => void) {
    let s = this.listeners.get(ev);
    if (!s) this.listeners.set(ev, (s = new Set()));
    s.add(fn);
    return () => s!.delete(fn);
  }

  emit(ev: Events) {
    this.listeners.get(ev)?.forEach((f) => f());
  }

  private emitSelection() {
    if (this.kbMoving && (this.selection.length !== 1 || this.selection[0] !== this.kbMoving)) this.clearMoving();
    this.r.setOverlay({ selection: this.selection, enteredGroup: this.scope });
    this.conn.awareness.setLocalStateField('sel', this.selection);
    this.emit('selection');
  }

  setSelection(ids: Id[]) {
    this.selection = this.selectionAtScope(ids);
    this.emitSelection();
  }

  private selectionAtScope(ids: Iterable<Id>): Id[] {
    // Never select a private note or an object hidden with the Layers panel's eye.
    const visible = selectableIds(this.store, this.flow, ids);
    let at: Id | null = this.scope && isGroup(this.store.get(this.scope)) ? this.scope : null;
    const seen = new Set<Id>();
    for (;;) {
      if (at && seen.has(at)) at = null;
      if (at) seen.add(at);
      const lifted = liftToScope(visible, at, (id) => this.store.get(id));
      if (at === null || lifted.every((id) => this.store.get(id)?.parent === at)) {
        this.scope = at;
        return lifted;
      }
      // A click on a sibling in the parent group leaves just this level; a selection outside that too keeps climbing.
      const parent = this.store.get(at)?.parent;
      at = parent && isGroup(this.store.get(parent)) ? parent : null;
    }
  }

  selected(): Obj[] {
    return this.selection.map((id) => this.store.get(id)).filter(Boolean) as Obj[];
  }

  /** Non-group descendants used by style and text controls; arrange actions keep using selected(). */
  selectedLeaves(): Obj[] {
    const leaves: Id[] = [];
    for (const o of this.selected()) {
      if (isGroup(o)) leaves.push(...descendantsOf(o.id, (id) => this.store.get(id), (id) => this.store.childrenOf(id)).filter((x) => !isGroup(x)).map((x) => x.id));
      else leaves.push(o.id);
    }
    return selectableIds(this.store, this.flow, leaves).map((id) => this.store.get(id))
      .filter((o): o is Obj => !!o && !effectiveLocked(o, (id) => this.store.get(id)));
  }

  /** Enters one group level and clears the selection until the caller selects a member. */
  enterGroup(id: Id): boolean {
    if (!isGroup(this.store.get(id))) return false;
    this.scope = id;
    this.selection = [];
    this.emitSelection();
    return true;
  }

  /** Leaves one level and selects the group that was just open. */
  leaveGroup(): void {
    if (!this.scope) return;
    const group = this.store.get(this.scope);
    if (!isGroup(group)) {
      this.scope = null;
      this.setSelection([]);
      return;
    }
    const parent = group.parent ? this.store.get(group.parent) : undefined;
    this.scope = isGroup(parent) ? parent.id : null;
    this.selection = [group.id];
    this.emitSelection();
  }

  /** Used by history, paste and AI apply: a changed descendant selects its top-level group. */
  resetScopeSelection(ids: Iterable<Id>): void {
    this.scope = null;
    this.setSelection(topLevelAncestors(ids, (id) => this.store.get(id)));
  }

  private itemsAtScope(): Obj[] {
    const shown = this.store.shown();
    if (this.scope) return this.store.childrenOf(this.scope).filter((o) => o.parent === this.scope && shown.some((s) => s.id === o.id));
    return topLevelAncestors(shown.map((o) => o.id), (id) => this.store.get(id)).map((id) => this.store.get(id)).filter((o): o is Obj => !!o);
  }

  private visibleAtMarquee(o: Obj, rect: Rect): boolean {
    if (effectiveLocked(o, (id) => this.store.get(id)) || !this.store.isShown(o) || isWithheld(o, this.flow) || this.isDimmed(o)) return false;
    const bounds = this.r.bounds(o);
    return !!bounds && rectsIntersect(rect, bounds);
  }

  private marqueeTouches(o: Obj, rect: Rect): boolean {
    if (!isGroup(o)) return this.visibleAtMarquee(o, rect);
    return descendantsOf(o.id, (id) => this.store.get(id), (id) => this.store.childrenOf(id))
      .some((member) => !isGroup(member) && this.visibleAtMarquee(member, rect));
  }

  /** The object a long press unlocks: the outermost locked group, or the locked object itself. */
  private lockedGroupTarget(o: Obj): Obj | undefined {
    return [o, ...ancestorsOf(o, (id) => this.store.get(id))]
      .filter((candidate) => isGroup(candidate) && candidate.locked).at(-1);
  }

  private lockedTarget(o: Obj): Obj | undefined {
    return this.lockedGroupTarget(o) ?? (o.locked ? o : undefined);
  }

  private planGroupSelection(idSource: () => Id) {
    return groupPlan(this.selection, (id) => this.store.get(id), (id) => this.store.childrenOf(id), {
      all: () => [...this.store.cache.values()],
      bounds: (o) => this.store.geometry(o),
      frameAt: (p) => this.frameAt(p),
      newId: idSource,
      scope: this.scope,
    });
  }

  /** A disabled reason for the Group action, or null when the selection can be grouped. */
  groupReason(): string | null {
    if (this.readOnly) return 'This board is read-only.';
    const plan = this.planGroupSelection(() => '__group_plan__');
    return plan.ok ? null : plan.reason;
  }

  canGroupSelection(): boolean {
    return this.groupReason() === null;
  }

  canUngroupSelection(): boolean {
    return !this.readOnly && this.selection.length > 0 && this.selected().every(isGroup);
  }

  /** Creates one group and reparents the selected objects and eligible connectors in one undo step. */
  groupSelection(): boolean {
    if (this.readOnly) return false;
    const result = this.planGroupSelection(newId);
    if (!result.ok) {
      this.notify(result.reason);
      return false;
    }
    const { group, members, connectors, skipped } = result;
    const created: Group = {
      id: group.id, type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0,
      z: group.z, ...(group.parent ? { parent: group.parent } : {}),
      createdBy: this.user.id, updatedAt: Date.now(),
    };
    this.store.undo.stopCapturing();
    this.store.transact(() => {
      this.store.create(created);
      for (const id of [...members, ...connectors]) this.store.update(id, { parent: group.id });
    });
    this.store.undo.stopCapturing();
    const omitted = [
      skipped.frames ? `${skipped.frames} frame${skipped.frames === 1 ? '' : 's'}` : '',
      skipped.other ? `${skipped.other} item${skipped.other === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    if (omitted.length) this.notify(`${omitted.join(' and ')} left out of the group.`);
    this.setSelection([group.id]);
    this.announce(`Grouped ${members.length + connectors.length} items`);
    return true;
  }

  /** Frees the selected groups' direct members at the groups' former z positions in one undo step. */
  ungroupSelection(): boolean {
    if (this.readOnly || !this.canUngroupSelection()) return false;
    const plan = ungroupPlan(this.selection, (id) => this.store.get(id), (id) => this.store.childrenOf(id), {
      all: () => [...this.store.cache.values()],
    });
    if (!plan.groups.length) return false;
    const ids = plan.groups.flatMap((g) => g.members.map((m) => m.id));
    this.store.undo.stopCapturing();
    this.store.transact(() => {
      for (const item of plan.groups) {
        for (const member of item.members) this.store.update(member.id, { parent: member.parent, z: member.z });
        this.store.remove([item.id]);
      }
    });
    this.store.undo.stopCapturing();
    this.setSelection(ids);
    this.announce('Ungrouped');
    return true;
  }

  get dragging(): boolean {
    const d = this.drag;
    return !!d && (d.mode === 'resize' || d.mode === 'rotate' || d.mode === 'endpoint' || ((d.mode === 'move' || d.mode === 'cards' || d.mode === 'lane') && d.moved));
  }

  get readOnly(): boolean {
    return this.store.readOnly;
  }

  // ---------------------------------------------------------------- comments (see docs/comments.md)

  /** Opens or closes the board's chat (the M key); null where chat is not available. Set by the board UI. */
  toggleChat: (() => void) | null = null;
  /** The user's role on this board in accounts mode; null in open mode. Set by the router. */
  role: BoardRole | null = null;
  /** A deleted board that a workspace admin opened: read-only until it is restored. Set by the router. */
  deleted = false;

  get comments(): Comments {
    return this.conn.comments;
  }

  /** Set by the comments UI: opens a thread (`threadId`) or the composer for a new one (`anchor`) near `screen`. */
  onOpenComment: ((target: { threadId?: string; anchor?: Anchor; screen: Point }) => void) | null = null;

  private _openThreadId: string | null = null;
  private _commentsVisible = loadCommentsVisible();
  private draftPoint: Point | null = null;

  get openThreadId(): string | null {
    return this._openThreadId;
  }

  openThread(id: string | null) {
    if (this._openThreadId === id) return;
    this._openThreadId = id;
    this.emit('comments');
  }

  closeThread() {
    this.openThread(null);
  }

  get commentsVisible(): boolean {
    return this._commentsVisible;
  }

  setCommentsVisible(v: boolean) {
    if (v === this._commentsVisible) return;
    this._commentsVisible = v;
    try {
      localStorage.setItem(COMMENTS_VISIBLE_KEY, v ? '1' : '0');
    } catch { /* storage unavailable */ }
    this.emit('comments');
  }

  /** Threads whose pin may be shown: not anchored to something private writing hides. */
  visibleThreads(): Thread[] {
    const get = (id: string) => this.store.getPlaced(id);
    // a pin on a hidden object (TAB-198) goes with it, as on a private note
    return this.comments.list().filter((t) => threadVisible(t, get, (o) => this.flow.isHidden(o) || !this.store.isShown(o)));
  }

  /** Shows a draft pin at `anchor` while its composer is open; null clears it. */
  setDraftPin(anchor: Anchor | null) {
    this.draftPoint = anchor ? anchorPosition(anchor, (id) => this.store.getPlaced(id)) : null;
    this.refreshPins();
  }

  /** Centres the camera on a thread's pin, keeping the zoom (at least 1). */
  flyToThread(id: string) {
    const t = this.visibleThreads().find((x) => x.id === id);
    if (!t) return;
    this.r.flyToCenter(anchorPosition(t.anchor, (oid) => this.store.getPlaced(oid)), Math.max(1, this.zoom));
  }

  private refreshPins() {
    this.r.setPins(pinViews({
      threads: this.visibleThreads(),
      get: (id) => this.store.getPlaced(id),
      openId: this.openThreadId,
      draft: this.draftPoint,
      visible: this.commentsVisible,
    }));
  }

  /** On a read-only board only select and hand (and, where comments are writable, the comment tool) are allowed; anything else falls back to select. */
  setTool(t: Tool) {
    // Select and hand always work; the comment tool needs a writable comments document (commenters have a read-only board); everything else needs a writable board.
    const allowed = t.kind === 'select' || t.kind === 'hand' || (t.kind === 'comment' ? !this.comments.readOnly() : !this.readOnly);
    const next: Tool = allowed ? t : { kind: 'select' };
    this.cancelLongPress();
    this.tool = next;
    this.r.root.dataset.tool = next.kind;
    this.r.setOverlay({ anchorsFor: null, anchorHot: null });
    this.emit('tool');
  }

  // ---------------------------------------------------------------- helpers

  private loadBoardFonts() {
    const want = new Map<string, Set<number>>();
    const meta = this.store.getMeta();
    for (const slug of [meta.bodyFont, meta.headingFont, 'satoshi']) want.set(slug, new Set([400, 500, 700]));
    for (const o of this.store.cache.values()) {
      if ('font' in o && o.font) {
        const s = want.get(o.font) ?? new Set<number>();
        s.add(o.fontWeight || 400);
        s.add(700);
        want.set(o.font, s);
      }
    }
    for (const [slug, ws] of want) ensureFont(slug, [...ws]);
  }

  get zoom() {
    return this.r.cam.zoom;
  }

  /** Topmost object under a world point. */
  hit(p: Point, opts: { skip?: Set<Id>; connectors?: boolean; frames?: boolean; locked?: boolean } = {}): Obj | undefined {
    const tol = 5 / this.zoom;
    // what is hidden (TAB-198) is not there to hit, select, snap to or drop into
    const ord = this.store.shown();
    for (let i = ord.length - 1; i >= 0; i--) {
      const o = ord[i];
      if (o.type === 'group') continue;
      if (effectiveLocked(o, (id) => this.store.get(id)) && !opts.locked) continue;
      if (opts.skip?.has(o.id)) continue;
      const b = this.r.bounds(o);
      if (!b || p.x < b.x - tol * 3 || p.y < b.y - tol * 3 || p.x > b.x + b.w + tol * 3 || p.y > b.y + b.h + tol * 3) continue;
      if (isConnector(o)) {
        if (opts.connectors === false) continue;
        const g = connectorGeom((id) => this.store.getPlaced(id), o, this.r.connectorLayout());
        if (g && distToPolyline(p, g.pts) <= tol + 3 / this.zoom) return o;
        if (g && o.label && Math.hypot(p.x - g.mid.x, p.y - g.mid.y) < 16 / this.zoom) return o;
        continue;
      }
      if ((o.type === 'frame' || o.type === 'tracker') && opts.frames === false) continue;
      // lanes and cards sit 8 apart and 16 apart: no slack around them, or the one below takes clicks meant for its neighbour
      if (hitBox(this.store.placed(o), p, this.store.isLaidOut(o) ? 0 : tol)) return o;
    }
    return undefined;
  }

  /** Topmost frame whose body contains the point (for parenting). */
  frameAt(p: Point, skip?: Set<Id>): BaseObj | undefined {
    const ord = this.store.shown();
    for (let i = ord.length - 1; i >= 0; i--) {
      const o = ord[i];
      if (o.type === 'frame' && !skip?.has(o.id) && isBox(o) && pointInRect(p, boxBounds(o))) return o;
    }
    return undefined;
  }

  private snapOn(e?: { altKey: boolean }) {
    return this.store.getMeta().snap && !e?.altKey && this.store.getMeta().gridType !== 'none';
  }

  private grid() {
    return this.store.getMeta().gridSize;
  }

  /** Defaults for a new object of a type. */
  makeObj(type: ObjType, rect: Rect, extra: Partial<BaseObj> = {}): BaseObj {
    const meta = this.store.getMeta();
    const o: BaseObj = {
      id: newId(), type, x: rect.x, y: rect.y, w: rect.w, h: rect.h, rotation: 0,
      z: this.store.topZ(), createdBy: this.user.id, updatedAt: Date.now(),
      font: meta.bodyFont,
      ...extra,
    };
    if (type === 'sticky') {
      o.fill = extra.fill ?? this.stickyColor;
      const step = this.flow.activeStep();
      if (step?.mode === 'private-write' && !this.store.getFlow().reveal) o.privateStep = step.id;
    }
    if (type === 'frame') o.font = meta.headingFont;
    if (type !== 'frame' && type !== 'tracker') {
      const f = this.frameAt(center(o));
      if (f) o.parent = f.id;
    }
    return o;
  }

  createObject(o: Obj, select = true) {
    this.store.undo.stopCapturing();
    this.store.transact(() => this.store.create(o));
    if (select) this.setSelection([o.id]);
  }

  /** Place an object centred on the current viewport (used by library panels). */
  placeAtCenter(type: ObjType, w: number, h: number, extra: Partial<BaseObj> = {}) {
    const vp = this.r.viewport();
    let x = vp.x + vp.w / 2 - w / 2, y = vp.y + vp.h / 2 - h / 2;
    if (this.snapOn()) {
      x = snapTo(x, this.grid());
      y = snapTo(y, this.grid());
    }
    const o = this.makeObj(type, { x, y, w, h }, extra);
    this.createObject(o);
    return o;
  }

  placeAt(type: ObjType, p: Point, w: number, h: number, extra: Partial<BaseObj> = {}) {
    let x = p.x - w / 2, y = p.y - h / 2;
    if (this.snapOn()) {
      x = snapTo(x, this.grid());
      y = snapTo(y, this.grid());
    }
    const o = this.makeObj(type, { x, y, w, h }, extra);
    this.createObject(o);
    return o;
  }

  // ---------------------------------------------------------------- pointer

  private bindPointer() {
    const svg = this.r.svg;
    svg.addEventListener('pointerdown', (e) => this.onDown(e));
    svg.addEventListener('pointermove', (e) => this.onMove(e));
    svg.addEventListener('pointerup', (e) => this.onUp(e));
    // a cancelled pointer (the system took it, a palm, a lost capture) drops nothing: a card drag is given up
    svg.addEventListener('pointercancel', (e) => this.onCancel(e));
    svg.addEventListener('dblclick', (e) => this.onDblClick(e));
    svg.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    svg.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.onContextMenu(e);
    });
    svg.addEventListener('pointerleave', () => this.r.setOverlay({ hover: null, lockedHover: null }));

    // Touch pinch-zoom (two pointers).
    const touches = new Map<number, Point>();
    let pinch: { d: number; mid: Point } | null = null;
    svg.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        const [a, b] = [...touches.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
        this.cancelLongPress();
        this.cancelCardDrag();
        this.drag = null;
        this.emit('drag');
        this.r.setOverlay({ marquee: null, preview: '' });
      }
    });
    svg.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && touches.size === 2) {
        const [a, b] = [...touches.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const s = this.r.size();
        this.r.setCamera({ x: this.r.cam.x - (mid.x - pinch.mid.x) / this.zoom, y: this.r.cam.y - (mid.y - pinch.mid.y) / this.zoom });
        this.r.zoomAt({ x: mid.x - s.left, y: mid.y - s.top }, d / pinch.d);
        pinch = { d, mid };
      }
    });
    const end = (e: PointerEvent) => {
      touches.delete(e.pointerId);
      if (touches.size < 2) pinch = null;
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    this.isPinching = () => pinch !== null;
  }

  private isPinching: () => boolean = () => false;

  private worldOf(e: { clientX: number; clientY: number }) {
    return this.r.clientToWorld(e.clientX, e.clientY);
  }

  private handleAt(p: Point, touch = false): { id: Id; h: HandleId } | null {
    if (this.readOnly || this.selection.length !== 1) return null;
    const o = this.store.getPlaced(this.selection[0]);
    if (!o) return null;
    // a finger needs a larger target than a pointer: handles are drawn larger on a touch screen too (render.ts)
    const tol = (touch ? 22 : 8) / this.zoom;
    for (const h of handlesFor(o, (id) => this.store.getPlaced(id), this.zoom, this.r.connectorLayout())) {
      if (Math.abs(h.p.x - p.x) <= tol && Math.abs(h.p.y - p.y) <= tol) return { id: o.id, h: h.id };
    }
    return null;
  }

  /** Whether `p` is on the shape `id` or in the ring around it where its connection dots are. */
  private nearAnchors(id: Id, p: Point): boolean {
    const o = this.store.getPlaced(id);
    if (!CONNECTABLE(o) || effectiveLocked(o, (parent) => this.store.get(parent))) return false;
    const l = toLocal(o, p);
    const m = 26 / this.zoom; // the dots are 14px out with a 9px reach
    return l.x >= -m && l.x <= o.w + m && l.y >= -m && l.y <= o.h + m;
  }

  private anchorAt(p: Point): { id: Id; side: 'top' | 'right' | 'bottom' | 'left' } | null {
    if (this.readOnly) return null;
    const id = this.r.overlay.anchorsFor;
    const o = id ? this.store.getPlaced(id) : undefined;
    if (!CONNECTABLE(o) || effectiveLocked(o, (parent) => this.store.get(parent))) return null;
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      const a = sideAnchor(o, side);
      const q = { x: a.p.x + (a.dir.x * 14) / this.zoom, y: a.p.y + (a.dir.y * 14) / this.zoom };
      if (Math.hypot(q.x - p.x, q.y - p.y) <= 9 / this.zoom) return { id: o.id, side };
    }
    return null;
  }

  private armLongPress(id: Id, e: PointerEvent, fire?: () => void) {
    if (this.readOnly) return;
    this.cancelLongPress();
    const ring = document.createElement('div');
    ring.className = 'lp-ring';
    ring.setAttribute('aria-hidden', 'true');
    ring.style.left = `${e.clientX}px`;
    ring.style.top = `${e.clientY}px`;
    ring.innerHTML = '<svg width="28" height="28" viewBox="0 0 28 28"><circle cx="14" cy="14" r="11" fill="none" stroke="rgba(24,33,43,.18)" stroke-width="3"/><circle class="lp-arc" cx="14" cy="14" r="11" fill="none" stroke="#18212B" stroke-width="3" stroke-linecap="round" transform="rotate(-90 14 14)"/></svg>';
    this.r.root.append(ring);
    const timer = window.setTimeout(() => this.fireLongPress(), 600);
    this.longPress = { id, x: e.clientX, y: e.clientY, timer, ring, fire };
  }

  private cancelLongPress() {
    const lp = this.longPress;
    if (!lp) return;
    clearTimeout(lp.timer);
    lp.ring.remove();
    this.longPress = null;
  }

  private fireLongPress() {
    const lp = this.longPress;
    if (!lp) return;
    this.cancelLongPress();
    if (lp.fire) return lp.fire();
    this.drag = null;
    this.r.setOverlay({ marquee: null });
    this.store.undo.stopCapturing();
    this.store.transact(() => this.store.update(lp.id, { locked: undefined }));
    this.setSelection([lp.id]);
    this.notify('Unlocked');
  }

  private onDown(e: PointerEvent) {
    // The inline SVG link owns pointer activation; let the browser open it without starting a card drag or selection.
    if (isCardLinkTarget(e.target)) return;
    // another pointer going down (a pinch, a second device) gives up a lane drag, overlay and all
    if (this.drag?.mode === 'lane') this.cancelCardDrag();
    this.cancelLongPress();
    if (this.editor.active) this.editor.commit();
    this.clearMoving();
    if (e.pointerType === 'touch' && this.isPinching()) return;
    (document.activeElement as HTMLElement | null)?.blur?.();
    const p = this.worldOf(e);
    this.r.svg.setPointerCapture(e.pointerId);

    if (e.button === 1 || e.button === 2 || this.spaceDown || this.tool.kind === 'hand') {
      this.panned = false;
      this.drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, cx: this.r.cam.x, cy: this.r.cam.y };
      this.r.root.classList.add('panning');
      return;
    }
    if (e.button !== 0) return;
    this.store.undo.stopCapturing();

    // Pins open their thread before anything else: locked objects, read-only boards and voting included
    if (this.tool.kind === 'select' || this.tool.kind === 'comment') {
      const pin = pinAt(this.r.pins, p, this.zoom);
      if (pin) {
        this.setDraftPin(null);
        this.openThread(pin);
        this.onOpenComment?.({ threadId: pin, screen: { x: e.clientX, y: e.clientY } });
        return;
      }
    }

    // Handles of the current selection (the comment tool never starts a drag)
    const hh = this.tool.kind === 'comment' ? undefined : this.handleAt(p, e.pointerType === 'touch');
    if (hh) {
      const o = this.store.getPlaced(hh.id)!;
      if (hh.h === 'from' || hh.h === 'to') this.drag = { mode: 'endpoint', id: o.id, end: hh.h };
      else if (hh.h === 'rot' && isBox(o)) {
        const c = center(o);
        this.drag = { mode: 'rotate', id: o.id, c, a0: Math.atan2(p.y - c.y, p.x - c.x), r0: o.rotation || 0 };
      } else if (isBox(o)) this.drag = { mode: 'resize', id: o.id, handle: hh.h, o0: { ...o } };
      this.emit('drag');
      return;
    }

    // Connection dots
    const an = this.anchorAt(p);
    if (an && (this.tool.kind === 'select' || this.tool.kind === 'connector')) {
      this.drag = { mode: 'connect', from: { kind: 'bound', id: an.id, anchor: 'auto' }, relation: this.tool.kind === 'connector' ? this.tool.relation : undefined, moved: false };
      return;
    }

    const t = this.tool;
    switch (t.kind) {
      case 'select': {
        const top = this.hit(p, { locked: true });
        const lockedTarget = top && this.lockedTarget(top);
        const lockedGroup = top && this.lockedGroupTarget(top);
        // a kanban's Filter, its chips, its ⋯ and its +, and a lane's ⋯: a click, never a drag (locked kanbans included,
        // so their menu can unlock them; viewers and commenters get Filter and the chips only)
        if (!lockedGroup && !e.shiftKey && top?.type === 'container') {
          const ctl = this.kanbanControlAt(top.id, p);
          if (ctl) {
            e.preventDefault();
            this.setSelection(ctl.kind === 'menu' ? [top.id] : this.selection);
            this.runKanbanControl(top.id, ctl);
            return;
          }
        }
        if (!lockedGroup && !e.shiftKey && !this.readOnly && top?.type === 'lane' && this.laneRegion(top.id, p) === 'menu') {
          e.preventDefault();
          this.setSelection([top.id]);
          this.openLaneMenu(top.id);
          return;
        }
        const removeVote = this.flow.shouldRemoveDots?.(e.shiftKey) ?? e.shiftKey;
        if (!this.readOnly && top && this.flow.handleClick(top, removeVote)) return;   // voting still works on locked notes
        const hit = lockedTarget ? this.hit(p) : top;               // an unlocked object under a locked one still gets the click
        if (!hit) {
          this.drag = { mode: 'marquee', start: p, base: e.shiftKey ? [...this.selection] : [], moved: false };
          if (!e.shiftKey && !this.scope) this.setSelection([]);
          if (lockedTarget) this.armLongPress(lockedTarget.id, e);
          return;
        }
        if (lockedTarget) this.armLongPress(lockedTarget.id, e);
        // a lane's "+ Add card" row opens the inline input (editors only; viewers do not see the row)
        if (!this.readOnly && !e.shiftKey && hit.type === 'lane' && this.laneRegion(hit.id, p) === 'add') {
          // no mousedown after this pointerdown, so the browser does not move focus away from the input it opens
          e.preventDefault();
          this.setSelection([]);
          this.cardInput.start(hit.id);
          return;
        }
        const selectedId = pick(hit, this.scope, (id) => this.store.get(id))?.id ?? hit.id;
        if (e.shiftKey) {
          const s = new Set(this.selection);
          if (s.has(selectedId)) s.delete(selectedId);
          else s.add(selectedId);
          this.setSelection([...s]);
        } else if (!this.selection.includes(selectedId)) {
          this.setSelection([selectedId]);
        }
        if (this.selection.includes(selectedId) && !this.readOnly) {
          // Whole-group transforms are slice 3; it remains selectable and enterable here, but does not start a drag yet.
          if (this.selection.some((id) => isGroup(this.store.get(id)))) return;
          // on a touch screen a card lifts after a long press (600 ms), so a finger that only taps or scrolls moves nothing
          if (hit.type === 'card' && e.pointerType === 'touch' && !hit.locked) this.armLongPress(hit.id, e, () => this.liftCard(hit.id, p));
          else if (hit.type === 'card') this.beginCardDrag(hit.id, p);
          // a lane's header takes it to another place among the lanes (a finger there pans; touch has Move left and right)
          else if (hit.type === 'lane' && !e.shiftKey && e.pointerType !== 'touch' && this.laneRegion(hit.id, p) === 'header' && this.beginLaneDrag(hit.id, p)) return;
          else this.beginMove(p);
        }
        return;
      }
      case 'connector': {
        const hit = this.hit(p, { connectors: false, frames: false });
        const from: End = CONNECTABLE(hit) ? { kind: 'bound', id: hit.id, anchor: 'auto' } : { kind: 'free', ...this.snapPoint(p, e) };
        this.drag = { mode: 'connect', from, relation: t.relation, moved: false };
        return;
      }
      case 'comment': {
        if (this.comments.readOnly()) return;
        const obj = this.hit(p, { locked: true });
        // a hidden object would take its thread out of sight as soon as it was posted, so the pin stays free
        const target = isBox(obj) && obj.type !== 'path' && !this.flow.isHidden(obj) ? this.store.placed(obj) : undefined;
        const anchor = anchorFor(p, target);
        this.closeThread();
        this.setDraftPin(anchor);
        this.onOpenComment?.({ anchor, screen: { x: e.clientX, y: e.clientY } });
        this.setTool({ kind: 'select' });
        return;
      }
      case 'pen':
        this.drag = { mode: 'pen', pts: [p] };
        return;
      default:
        this.drag = { mode: 'create', start: this.snapPoint(p, e), tool: t };
    }
  }

  private snapPoint(p: Point, e?: { altKey: boolean }): Point {
    if (!this.snapOn(e)) return p;
    const g = this.grid();
    return { x: snapTo(p.x, g), y: snapTo(p.y, g) };
  }

  private beginMove(p: Point) {
    // what a container lays out moves with the container, never by its own x and y
    const ids = new Set(this.selection.filter((id) => { const o = this.store.get(id); return !o?.locked && !(o && this.store.isLaidOut(o)); }));
    // frames carry their children (and nested frames theirs)
    const stack = [...ids];
    while (stack.length) {
      const id = stack.pop()!;
      const parent = this.store.get(id);
      if (parent?.type !== 'frame' && parent?.type !== 'group') continue;
      for (const c of this.store.childrenOf(id)) {
        if (c.locked || ids.has(c.id) || this.store.isLaidOut(c)) continue;
        if (c.type !== 'group') ids.add(c.id);
        stack.push(c.id);
      }
    }
    const orig = new Map<Id, Obj>();
    for (const id of ids) orig.set(id, structuredClone(this.store.getPlaced(id)!));
    const bounds = this.r.contentBounds(this.selection) ?? { x: p.x, y: p.y, w: 0, h: 0 };
    this.drag = { mode: 'move', start: p, ids: [...ids], orig, bounds, moved: false };
  }

  // ---------------------------------------------------------------- kanban (docs/kanban.md, slice 2)


  /** Where in a lane a world point is: its ⋯ (editors), its header, its add-card row, or the rest of its body. */
  private laneRegion(laneId: Id, p: Point): 'menu' | 'header' | 'add' | 'body' | null {
    const lane = this.store.getPlaced(laneId);
    const layout = lane?.parent ? this.store.containerLayout(lane.parent) : null;
    if (!lane || !layout || !layout.rects.has(laneId)) return null;
    const region = laneRegionAt(lane as BaseObj, laneCards(layout, laneId), p, !this.readOnly && !lowDetail(this.zoom));
    // below zoom 0.4 the add-card row is not drawn, so it is not there to click either
    return region === 'add' && lowDetail(this.zoom) ? 'body' : region;
  }

  /** A new kanban with To do, Doing and Done, its top-left at `at`, with the add-card input open in its first lane. */
  createKanban(at: Point) {
    if (this.readOnly) return null;
    const meta = this.store.getMeta();
    const size = newKanbanSize();
    const frame = this.frameAt({ x: at.x + size.w / 2, y: at.y + size.h / 2 });
    const { container, lanes } = newKanban(at, { z: this.store.topZ(), createdBy: this.user.id, headingFont: meta.headingFont, bodyFont: meta.bodyFont, parent: frame?.id });
    this.store.undo.stopCapturing();
    this.store.transact(() => [container, ...lanes].forEach((o) => this.store.create(o)));
    this.store.undo.stopCapturing();
    this.setTool({ kind: 'select' });
    this.setSelection([container.id]);
    // the spec's "one empty card in edit mode": the add-card input, so that nothing is left behind when it is not used
    this.cardInput.start(lanes[0].id);
    return container.id;
  }

  /** The lane a point is over, topmost kanban first, with the insertion index among its cards that are not `moving`. */
  private laneTarget(p: Point, moving: ReadonlySet<Id> = new Set()): LaneTarget | null {
    const containers = this.store.ordered().filter((o) => o.type === 'container').flatMap((o) => {
      const layout = this.store.containerLayout(o.id);
      return layout ? [{ id: o.id, layout }] : [];
    });
    return laneTargetAt(containers, p, moving);
  }

  // ---------------------------------------------------------------- lanes, menus and filters (docs/kanban.md, slice 4)

  /**
   * Which control of a kanban's header a world point is on (the drawing and this read the same rectangles,
   * `kanbanHeaderControls`), or its add-lane +. None below zoom 0.4, where they are not drawn. Filter and the chips are
   * for everyone (viewers filter too); the ⋯ and the + for editors only.
   */
  private kanbanControlAt(containerId: Id, p: Point): KanbanControl | null {
    const o = this.store.getPlaced(containerId) as BaseObj | undefined;
    if (o?.type !== 'container' || lowDetail(this.zoom)) return null;
    const layout = this.store.containerLayout(containerId);
    if (!this.readOnly && layout && inRect(layout.addLane, p)) return { kind: 'addLane' };
    const local = { x: p.x - o.x, y: p.y - o.y };
    if (local.y > KANBAN.containerHeader) return null;
    const c = kanbanHeaderControls(o, this.filterChipsOf(containerId), !this.readOnly);
    if (c.menu && inRect(c.menu, local)) return { kind: 'menu' };
    if (c.filter && inRect(c.filter.rect, local)) return { kind: 'filter' };
    const chip = c.chips.find((x) => inRect(x.remove, local));
    return chip ? { kind: 'chip', key: chip.key } : null;
  }

  /** A rectangle of the board (world units) in page coordinates, for placing a menu against it. */
  private pageRect(r: Rect): Rect {
    const a = this.r.toScreen({ x: r.x, y: r.y });
    const b = this.r.toScreen({ x: r.x + r.w, y: r.y + r.h });
    const box = this.r.svg.getBoundingClientRect();
    return { x: box.left + a.x, y: box.top + a.y, w: b.x - a.x, h: b.y - a.y };
  }

  /** Runs a header control or the add-lane +. */
  private runKanbanControl(containerId: Id, ctl: KanbanControl) {
    if (ctl.kind === 'addLane') {
      this.addLaneTo(containerId);
      return;
    }
    if (ctl.kind === 'chip') {
      this.setKanbanFilter(containerId, withoutChip(this.kanbanFilter(containerId), ctl.key));
      return;
    }
    const o = this.store.getPlaced(containerId) as BaseObj;
    const c = kanbanHeaderControls(o, this.filterChipsOf(containerId), !this.readOnly);
    const r = ctl.kind === 'menu' ? c.menu : c.filter?.rect;
    if (r) this.openKanbanMenu?.(ctl.kind === 'menu' ? 'container' : 'filter', containerId, this.pageRect({ x: o.x + r.x, y: o.y + r.y, w: r.w, h: r.h }));
  }

  /** Opens a lane's ⋯ menu (editors only). */
  openLaneMenu(laneId: Id) {
    const lane = this.store.getPlaced(laneId);
    if (this.readOnly || lane?.type !== 'lane') return;
    const m = { x: lane.x + lane.w - 36, y: lane.y + 12, w: 28, h: 28 };
    this.openKanbanMenu?.('lane', laneId, this.pageRect(m));
  }

  /** Opens a kanban's Filter popover or its ⋯ menu from outside its header (the quick-action bar). */
  openContainerControl(containerId: Id, kind: 'menu' | 'filter') {
    if (this.store.get(containerId)?.type !== 'container' || (kind === 'menu' && this.readOnly)) return;
    const o = this.store.getPlaced(containerId) as BaseObj;
    const c = kanbanHeaderControls(o, this.filterChipsOf(containerId), !this.readOnly);
    const r = (kind === 'menu' ? c.menu : c.filter?.rect) ?? { x: o.w - 44, y: 8, w: 32, h: 32 };
    this.openKanbanMenu?.(kind === 'menu' ? 'container' : 'filter', containerId, this.pageRect({ x: o.x + r.x, y: o.y + r.y, w: r.w, h: r.h }));
  }

  /**
   * Opens a kanban as a list (docs/kanban.md, Phone and touch): its lanes as tabs, the cards of one as rows. For everyone
   * who can see the board; what the rows offer follows the role. Returns whether it opened.
   */
  openKanbanList(containerId: Id, laneId?: Id): boolean {
    if (this.store.get(containerId)?.type !== 'container' || !this.store.containerLayout(containerId) || !this.openSheet) return false;
    this.cardInput.stop();
    this.cancelCardDrag();
    this.openSheet(containerId, laneId);
    return true;
  }

  /** Draws a kanban control pressed while its menu or popover is open, and not when it closes. */
  setKanbanMenuOpen(open: { id: Id; kind: 'menu' | 'filter' } | null) {
    this.r.setKanbanState({ open });
  }

  /** Edits a lane from its menu: one undo step, or a message saying why not. */
  editLaneFromMenu(laneId: Id, patch: LanePatch): boolean {
    const refused = laneEditRefusal(this.store, laneId);
    if (refused) {
      this.notify(refused);
      return false;
    }
    return editLane(this.store, laneId, patch);
  }

  /** Renames a lane or a kanban in place, with the name editor (as a double-click on its name does). */
  renameKanbanPart(id: Id) {
    const o = this.store.get(id);
    if (this.readOnly || (o?.type !== 'lane' && o?.type !== 'container')) return;
    if (o.locked) return this.notify(o.type === 'lane' ? 'This lane is locked. Unlock it to change it.' : 'This kanban is locked. Unlock it to rename it.');
    this.setSelection([id]);
    this.editor.start(id);
  }

  /** Move left or Move right from a lane's menu: one undo step, announced. */
  moveLaneFromMenu(laneId: Id, dir: 'left' | 'right'): boolean {
    const lane = this.store.get(laneId) as BaseObj | undefined;
    if (lane?.type !== 'lane' || !lane.parent) return false;
    const refused = moveLaneRefusal(this.store, laneId, dir);
    if (refused) {
      this.notify(refused);
      return false;
    }
    if (!moveLane(this.store, laneId, dir)) return false;
    const lanes = this.store.containerLayout(lane.parent)?.lanes ?? [];
    this.announce(`Moved ${lane.name || 'lane'} to position ${lanes.indexOf(laneId) + 1} of ${lanes.length}`);
    return true;
  }

  /** Adds a lane after the last one and opens its name for typing. One undo step for the lane. */
  addLaneTo(containerId: Id): Id | null {
    const refused = addLaneRefusal(this.store, containerId);
    if (refused) {
      this.notify(refused);
      return null;
    }
    const id = addLane(this.store, containerId, { createdBy: this.user.id, font: this.store.getMeta().bodyFont });
    if (!id) return null;
    this.announce('Added a lane');
    this.cardInput.stop();
    this.setSelection([id]);
    this.editor.start(id);
    return id;
  }

  /**
   * Deletes a lane from its menu: alone (its cards move to the lane on its left, or its right for the first lane, as the
   * Delete key does) or with its cards. One undo step, or a message saying why not.
   */
  deleteLane(laneId: Id, withCards: boolean): boolean {
    const r = laneDeleteIds(this.store, laneId, withCards);
    if ('refused' in r) {
      this.notify(r.refused);
      return false;
    }
    return this.deleteObjects(r.ids);
  }

  /** Deletes a kanban with its lanes and cards from its menu. One undo step, or a message saying why not. */
  deleteKanban(containerId: Id): boolean {
    const refused = structureRefusal(this.store, containerId);
    if (refused) {
      this.notify(refused);
      return false;
    }
    return this.deleteObjects([containerId]);
  }

  /** Locks or unlocks a kanban from its menu. */
  toggleKanbanLock(containerId: Id) {
    const o = this.store.get(containerId);
    if (this.readOnly || o?.type !== 'container') return;
    const was = !!o.locked;
    this.setLocked(containerId, !was);
    this.notify(was ? 'Unlocked.' : 'Locked. Its cards still move; its lanes stay as they are.');
    this.r.invalidateKanban(containerId);
  }

  // Filters are this viewer's own: kept in memory and in this browser, never in the board (docs/kanban.md, Filters).
  // `filters` holds each filter as it was set or read back; what is used is that filter without labels the board no
  // longer has, worked out once per labels change (a board may have 2,000 cards, and each draw asks about each one).
  private filterCache?: Map<Id, KanbanFilter>;
  private get filters(): Map<Id, KanbanFilter> {
    return (this.filterCache ??= new Map());
  }
  private filterUsed?: Map<Id, { version: number; raw: KanbanFilter; f: KanbanFilter }>;
  private labelsVersion?: number;
  private filterMemo?: { version: number; at: number; today: string; viewer: FilterViewer; known: Set<Id>; names: Map<Id, string> };

  /** The board's labels, the viewer and today, for filtering: read once per labels change (and today once a minute). */
  private filterContext() {
    const version = this.labelsVersion ?? 0;
    const now = Date.now();
    const m = this.filterMemo;
    if (m && m.version === version && now - m.at < 60_000) return m;
    const labels = listLabels(this.store);
    this.filterMemo = {
      version, at: now, today: localToday(), viewer: this.filterViewer(),
      known: new Set(labels.map((l) => l.id)), names: new Map(labels.map((l) => [l.id, l.name])),
    };
    return this.filterMemo;
  }

  /**
   * Board labels changed (here, or from someone else, or by undo): filters that named a label that is gone drop it, in
   * this browser's storage too, and every filtered kanban redraws its chips and dimming.
   */
  private onLabelsChanged() {
    this.labelsVersion = (this.labelsVersion ?? 0) + 1;
    const { known } = this.filterContext();
    for (const [cid, raw] of this.filters) {
      if (!filterParts(raw)) continue;
      // a board still loading has no labels yet: nothing is dropped from storage until it has some
      if (known.size && raw.labels.some((id) => !known.has(id))) this.saveFilter(cid, cleanFilter(raw, known));
      this.r.invalidateKanban(cid);
    }
    this.emit('filter');
  }

  /** Starts following the board's labels for filters (the constructor calls it). */
  watchLabels() {
    const fn = () => this.onLabelsChanged();
    this.store.labels.observe(fn);
    return () => this.store.labels.unobserve(fn);
  }

  private filterKey(containerId: Id) {
    return filterStorageKey(this.conn?.id ?? '', containerId);
  }

  private rawFilter(containerId: Id): KanbanFilter {
    let f = this.filters.get(containerId);
    if (!f) {
      let raw: string | null = null;
      try {
        raw = localStorage.getItem(this.filterKey(containerId));
      } catch { /* storage that cannot be read: no saved filter */ }
      try {
        f = raw ? cleanFilter(JSON.parse(raw)) : EMPTY_FILTER;
      } catch {
        f = EMPTY_FILTER;
      }
      this.filters.set(containerId, f);
    }
    return f;
  }

  /** This viewer's filter on a kanban (the empty filter when there is none), without labels the board does not have. */
  kanbanFilter(containerId: Id): KanbanFilter {
    const ctx = this.filterContext();
    const used = (this.filterUsed ??= new Map());
    const raw = this.rawFilter(containerId);
    const hit = used.get(containerId);
    if (hit && hit.version === ctx.version && hit.raw === raw) return hit.f;
    const f = raw.labels.length ? cleanFilter(raw, ctx.known) : raw;
    used.set(containerId, { version: ctx.version, raw, f });
    return f;
  }

  private saveFilter(containerId: Id, f: KanbanFilter) {
    this.filters.set(containerId, f);
    try {
      if (filterParts(f)) localStorage.setItem(this.filterKey(containerId), JSON.stringify(f));
      else localStorage.removeItem(this.filterKey(containerId));
    } catch { /* storage that cannot be written: the filter lasts until the page closes */ }
  }

  /** Sets this viewer's filter on a kanban and redraws it. Nothing is written to the board. */
  setKanbanFilter(containerId: Id, f: KanbanFilter) {
    this.saveFilter(containerId, cleanFilter(f, this.filterContext().known));
    this.r.invalidateKanban(containerId);
    this.emit('filter');
  }

  /** Who "Mine" means (docs/kanban.md, Owners). */
  private filterViewer(): FilterViewer {
    return { id: this.user.id, name: this.user.name, accounts: this.role !== null && this.role !== undefined };
  }

  /** The header's chips for this viewer's filter on a kanban. */
  filterChipsOf(containerId: Id): FilterChip[] {
    const f = this.kanbanFilter(containerId);
    if (!filterParts(f)) return [];
    const { names } = this.filterContext();
    return filterChips(f, (id) => names.get(id));
  }

  /** Whether this viewer's filter on a card's kanban leaves it out (it is drawn at 35% and a marquee skips it). */
  isDimmed(card: Obj): boolean {
    if (card.type !== 'card' || !card.parent) return false;
    const lane = this.store.get(card.parent) as BaseObj | undefined;
    if (lane?.type !== 'lane' || !lane.parent) return false;
    const f = this.kanbanFilter(lane.parent);
    if (!filterParts(f)) return false;
    const ctx = this.filterContext();
    return !cardMatches(card as BaseObj, f, { viewer: ctx.viewer, today: ctx.today, done: lane.stage === 'done', known: ctx.known });
  }

  /** How many of a kanban's cards this viewer's filter matches, of how many ("2 of 9 match"). */
  filterCounts(containerId: Id): { matching: number; total: number } {
    const layout = this.store.containerLayout(containerId);
    let matching = 0, total = 0;
    for (const ids of layout?.cards.values() ?? []) {
      for (const id of ids) {
        total++;
        const o = this.store.get(id);
        if (o && !this.isDimmed(o)) matching++;
      }
    }
    return { matching, total };
  }

  /**
   * While cards are dragged over a block lane that would refuse them: its body outlined and "Full · n / n" under its
   * last card (docs/kanban.md, Visual design, States). Null when the lane takes them.
   */
  private fullLaneMark(t: LaneTarget, ids: Id[]): { body: Rect; at: Point; text: string } | null {
    if (!wipRefusal(this.store, ids, t.id)) return null;
    const lane = this.store.get(t.id) as BaseObj;
    const layout = this.store.containerLayout(t.container);
    const r = layout?.rects.get(t.id);
    if (!layout || !r) return null;
    const shown = layout.cards.get(t.id) ?? [];
    const v = wipCheck(lane, shown.map((id) => ({ id })), ids);
    const row = addRow(r, laneCards(layout, t.id));
    return {
      body: { x: r.x, y: r.y + KANBAN.header, w: r.w, h: r.h - KANBAN.header },
      at: { x: r.x + r.w / 2, y: row.y + row.h + 8 },
      text: wipFullLabel(shown.length, v.limit ?? shown.length),
    };
  }

  // ---------------------------------------------------------------- cards (docs/kanban.md, slice 3)

  /** Who may open the card dialog: editors, and commenters read-only (docs/kanban.md, Permissions). Viewers may not. */
  canOpenCard(): boolean {
    return !this.readOnly || !this.comments.readOnly();
  }

  /** Opens the card dialog for a card, when this person may. Returns whether it opened. */
  openCardDialog(id: Id, focus?: CardFocus): boolean {
    if (this.store.get(id)?.type !== 'card' || !this.canOpenCard() || !this.openCard) return false;
    this.cardInput.stop();
    this.openCard(id, focus);
    return true;
  }

  /**
   * Turns the selected stickies (or `ids`) into cards in place (docs/kanban.md, Sticky to card and back): one that sits
   * over a lane joins it where it is, the others become loose cards. One undo step.
   */
  turnIntoCards(ids: Id[] = this.selection): boolean {
    if (this.readOnly) return false;
    const stickies = ids.filter((id) => this.convertible(id));
    if (!stickies.length) return false;
    const r = stickiesToCards(this.store, stickies, (o) => this.cardTargetOf(o.id), this.user.id);
    if (r.refused) {
      this.notify(r.refused);
      return false;
    }
    if (!r.done.length) return false;
    this.announce(r.done.length === 1 ? 'Turned into a card' : `Turned ${r.done.length} stickies into cards`);
    this.setSelection(r.done);
    return true;
  }

  /** The lane a sticky would join as a card: the one under its middle, at that place among its cards. */
  private cardTargetOf(id: Id): { lane: Id; index: number } | null {
    const o = this.store.get(id);
    if (!o) return null;
    const b = this.store.geometry(o);
    const t = this.laneTarget({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
    return t ? { lane: t.id, index: t.index } : null;
  }

  /** A sticky this person may turn into a card: not someone else's unrevealed private note (mayConvertSticky). */
  private convertible(id: Id): boolean {
    const o = this.store.get(id);
    return o?.type === 'sticky' && mayConvertSticky(o as BaseObj, this.user.id);
  }

  /** Whether Turn into card does anything for the selection. */
  canTurnIntoCards(ids: Id[] = this.selection): boolean {
    if (this.readOnly) return false;
    return ids.some((id) => this.convertible(id));
  }

  /** Turns the selected cards (or `ids`) back into stickies where they are drawn. One undo step. */
  turnIntoStickies(ids: Id[] = this.selection): boolean {
    if (this.readOnly) return false;
    const done = cardsToStickies(this.store, ids, (p, skip) => this.frameAt(p, skip)?.id, this.store.getMeta().stickyColors);
    if (!done.length) return false;
    this.announce(done.length === 1 ? 'Turned into a sticky note' : `Turned ${done.length} cards into sticky notes`);
    this.setSelection(done);
    return true;
  }

  /** The K key: stickies in the selection become cards; a selection of cards only becomes stickies. */
  private toggleCards() {
    const sel = this.selected();
    if (sel.some((o) => o.type === 'sticky')) this.turnIntoCards();
    else if (sel.length && sel.every((o) => o.type === 'card')) this.turnIntoStickies();
  }

  /** A kanban from the selected stickies, with them as cards in its first lane in reading order. One undo step. */
  makeKanbanFromSelection(): Id | null {
    if (this.readOnly) return null;
    const meta = this.store.getMeta();
    const stickies = this.selection.filter((id) => this.convertible(id));
    if (!stickies.length) return null;
    const first = this.store.get(stickies[0]) as BaseObj;
    const r = kanbanFromStickies(this.store, stickies, { z: this.store.topZ(), createdBy: this.user.id, headingFont: meta.headingFont, bodyFont: meta.bodyFont, parent: first.parent && this.store.get(first.parent)?.type === 'frame' ? first.parent : undefined });
    if (r.refused) this.notify(r.refused);
    if (!r.id) return null;
    this.announce(`Made a kanban with ${stickies.length} ${stickies.length === 1 ? 'card' : 'cards'}`);
    this.setSelection([r.id]);
    return r.id;
  }

  /** Opens the composer for a new comment pinned to a card's top right corner, which follows the card wherever it is drawn. */
  commentOnCard(id: Id): boolean {
    const card = this.store.getPlaced(id);
    if (card?.type !== 'card' || this.comments.readOnly()) return false;
    const b = card as BaseObj;
    const at = { x: b.x + b.w - 14, y: b.y + 14 };
    const anchor = anchorFor(at, b);
    this.closeThread();
    this.setDraftPin(anchor);
    const s = this.r.toScreen(at);
    const box = this.r.svg.getBoundingClientRect();
    this.onOpenComment?.({ anchor, screen: { x: box.left + s.x, y: box.top + s.y } });
    return true;
  }

  /**
   * Stickies dropped on a lane become cards there (docs/kanban.md, Sticky to card and back), as their own undo step
   * after the move. Only selected stickies count, not the children of a frame that moved with it.
   */
  private dropStickiesInLane(ids: Id[], p: Point) {
    const stickies = ids.filter((id) => this.selection.includes(id) && this.convertible(id));
    if (!stickies.length) return;
    const t = this.laneTarget(p);
    if (!t) return;
    const order = [...stickies].sort((a, b) => { const ra = this.store.geometry(this.store.get(a)!), rb = this.store.geometry(this.store.get(b)!); return ra.y - rb.y || ra.x - rb.x; });
    const r = stickiesToCards(this.store, order, () => ({ lane: t.id, index: t.index }), this.user.id);
    if (r.refused) return this.notify(r.refused);
    if (!r.done.length) return;
    const lane = this.store.get(t.id) as BaseObj | undefined;
    const list = this.store.containerLayout(t.container)?.cards.get(t.id) ?? [];
    this.announce(moveAnnouncement(lane?.name ?? '', list.indexOf(r.done[0]) + 1, list.length));
    this.setSelection(r.done);
  }

  /** While stickies are moved over a lane: the drop line where they would land as cards. */
  private showStickyDrop(ids: Id[], p: Point): boolean {
    const stickies = ids.filter((id) => this.selection.includes(id) && this.convertible(id));
    const t = stickies.length ? this.laneTarget(p) : null;
    const was = this.r.overlay.kanban?.line || this.r.overlay.kanban?.full;
    if (!t) {
      if (was) this.clearStickyDrop();
      return false;
    }
    // a full block lane refuses them as cards: it says so, with no drop line (docs/kanban.md, WIP limits)
    const full = this.fullLaneMark(t, stickies);
    const layout = this.store.containerLayout(t.container)!;
    const line = full ? null : dropLine(layout.rects.get(t.id)!, laneCards(layout, t.id), t.index);
    this.r.setKanbanState({ dropLane: full ? null : t.id });
    this.r.setOverlay({ kanban: { ...this.r.overlay.kanban, line, full } });
    return true;
  }

  private clearStickyDrop() {
    this.r.setKanbanState({ dropLane: null });
    this.r.setOverlay({ kanban: this.r.overlay.kanban?.moving ? { moving: this.r.overlay.kanban.moving } : null });
  }

  /** Cards that a drag starting on `id` takes: the selected cards that are not locked, or just `id`. */
  private beginCardDrag(id: Id, p: Point) {
    const ids = this.selection.filter((x) => { const o = this.store.get(x); return o?.type === 'card' && !o.locked; });
    if (!ids.includes(id)) return;
    const lead = this.store.getPlaced(id) as BaseObj;
    this.drag = { mode: 'cards', start: p, ids: movingOrder(this.store, ids), lead: id, grab: { x: p.x - lead.x, y: p.y - lead.y }, moved: false, target: null, frame: null };
  }

  /** Starts dragging a lane by its header. False when it cannot be moved (locked, in a locked kanban, or alone). */
  private beginLaneDrag(laneId: Id, p: Point): boolean {
    const lane = this.store.get(laneId);
    const layout = lane?.parent ? this.store.containerLayout(lane.parent) : null;
    if (!lane?.parent || !layout || layout.lanes.length < 2 || laneReorderRefusal(this.store, laneId, null)) return false;
    this.drag = { mode: 'lane', start: p, lane: laneId, container: lane.parent, moved: false, to: null };
    return true;
  }

  private doLaneDrag(d: Extract<Drag, { mode: 'lane' }>, p: Point) {
    if (!d.moved && Math.hypot(p.x - d.start.x, p.y - d.start.y) * this.zoom < 3) return;
    const layout = this.store.containerLayout(d.container);
    if (!layout || !layout.rects.has(d.lane)) return this.cancelCardDrag();
    if (!d.moved) {
      d.moved = true;
      this.emit('drag');
      this.cardInput.stop();
      this.r.setOverlay({ hover: null, anchorsFor: null, anchorHot: null });
    }
    d.to = laneDropIndex(layout.lanes, layout.rects, d.lane, p.x);
    this.r.setOverlay({ kanban: { laneFrom: layout.rects.get(d.lane)!, laneLine: laneDropLine(layout.lanes, layout.rects, d.lane, d.to) } });
  }

  private finishLaneDrag(d: Extract<Drag, { mode: 'lane' }>, p: Point) {
    this.r.setOverlay({ kanban: null });
    if (!d.moved) return;
    // the place is read again from the lanes as they are now and where the pointer is now: lanes may have come or gone, or the view moved, since the last move
    const layout = this.store.containerLayout(d.container);
    if (!layout || !layout.rects.has(d.lane)) return;
    const to = laneDropIndex(layout.lanes, layout.rects, d.lane, p.x);
    const lane = this.store.get(d.lane) as BaseObj | undefined;
    const refused = laneReorderRefusal(this.store, d.lane, to);
    if (refused) return this.notify(refused);
    if (!moveLaneTo(this.store, d.lane, to)) return;
    const lanes = this.store.containerLayout(d.container)?.lanes ?? [];
    this.announce(`Moved ${lane?.name || 'lane'} to position ${lanes.indexOf(d.lane) + 1} of ${lanes.length}`);
  }

  /** A card drag started by a long press on a touch screen: the ghost lifts where the finger is, before it moves. */
  private liftCard(id: Id, p: Point) {
    if (this.readOnly || this.drag) return;
    this.beginCardDrag(id, p);
    const d = this.drag as Drag | null;
    if (d?.mode !== 'cards') return;
    d.armed = true;
    this.doCardDrag(d, p);
  }

  private doCardDrag(d: Extract<Drag, { mode: 'cards' }>, p: Point) {
    if (!d.moved && !d.armed && Math.hypot(p.x - d.start.x, p.y - d.start.y) * this.zoom < 3) return;
    if (!d.moved) {
      d.moved = true;
      this.emit('drag');
      this.cardInput.stop();
      this.r.setKanbanState({ dragging: new Set(d.ids) });
      this.r.setOverlay({ hover: null, anchorsFor: null, anchorHot: null });
      const lead = this.store.getPlaced(d.lead) as BaseObj;
      this.r.setGhost(cardBody(lead, { ...this.r.ctx, editingId: null, dragging: undefined }, 'ghost'));
    }
    this.r.moveGhost({ x: p.x - d.grab.x, y: p.y - d.grab.y });
    const moving = new Set(d.ids);
    const t = this.laneTarget(p, moving);
    d.target = t;
    let line = null;
    // a block lane that would refuse them shows it is full, and no drop line (docs/kanban.md, WIP limits)
    const full = t ? this.fullLaneMark(t, d.ids) : null;
    if (t && !full) {
      const layout = this.store.containerLayout(t.container)!;
      line = dropLine(layout.rects.get(t.id)!, laneCards(layout, t.id, moving), t.index);
    }
    // off every kanban the cards would land loose, in the frame under them if any
    const lead = this.store.getPlaced(d.lead) as BaseObj;
    d.frame = t ? null : this.frameAt({ x: p.x - d.grab.x + lead.w / 2, y: p.y - d.grab.y + lead.h / 2 })?.id ?? null;
    this.r.setKanbanState({ dropLane: t && !full ? t.id : null });
    this.r.setOverlay({ kanban: line || full ? { line, full } : null, dropTarget: d.frame });
  }

  private finishCardDrag(d: Extract<Drag, { mode: 'cards' }>, p: Point) {
    const ids = d.ids;
    const lead = this.store.getPlaced(d.lead) as BaseObj | undefined;
    this.endCardDrag();
    if (!d.moved) {
      // plain click on an already-selected card inside a multi-selection selects just it
      if (this.selection.length > 1) this.setSelection([d.lead]);
      return;
    }
    const t = d.target;
    if (t) {
      const lane = this.store.get(t.id) as BaseObj | undefined;
      const refused = moveRefusal(this.store, ids, t.id);
      if (refused) return this.notify(refused);
      if (moveCards(this.store, ids, t.id, t.index)) {
        const order = this.store.containerLayout(t.container)?.cards.get(t.id) ?? [];
        this.announce(moveAnnouncement(lane?.name ?? '', order.indexOf(ids[0]) + 1, order.length));
      }
      return;
    }
    if (!lead) return;
    // each card keeps its place relative to the one under the pointer
    const at = { x: p.x - d.grab.x, y: p.y - d.grab.y };
    const places = ids.map((id) => {
      const o = this.store.getPlaced(id) as BaseObj;
      const x = at.x + (o.x - lead.x), y = at.y + (o.y - lead.y);
      return { id, x, y, w: o.w, h: o.h, parent: this.frameAt({ x: x + o.w / 2, y: y + o.h / 2 })?.id };
    });
    dropLoose(this.store, places);
  }

  /** Takes the ghost, the drop line and the placeholders away. */
  private endCardDrag() {
    this.r.setGhost(null);
    this.r.setKanbanState({ dragging: new Set(), dropLane: null });
    this.r.setOverlay({ kanban: this.r.overlay.kanban?.moving ? { moving: this.r.overlay.kanban.moving } : null, dropTarget: null });
  }

  /** A card drag that is given up (Esc, a pinch, the board turning read-only): nothing is written. */
  private cancelCardDrag() {
    if (this.drag?.mode === 'lane') {
      this.drag = null;
      this.r.setOverlay({ kanban: null });
      this.emit('drag');
      return;
    }
    if (this.drag?.mode !== 'cards') return;
    this.drag = null;
    this.endCardDrag();
    this.emit('drag');
  }

  /**
   * Alt+arrow on one selected card in a lane: up and down within the lane, left and right to the neighbouring lane. One
   * transaction and one undo step per press, announced in the live region. False when the selection is not such a card.
   */
  private keyboardCardMove(key: MoveKey): boolean {
    if (this.selection.length !== 1) return false;
    const card = this.store.get(this.selection[0]);
    if (card?.type !== 'card' || !this.store.isLaidOut(card)) return false;
    if (card.locked) return true;
    const cid = containerOf(this.store, card) ?? this.containerShowing(card.id);
    const layout = cid ? this.store.containerLayout(cid) : null;
    const move = layout ? keyboardMove(layout, card.id, key) : null;
    // a move within the lane is never refused; into a full block lane it is, with the same message as a drop
    const refused = move ? moveRefusal(this.store, [card.id], move.lane) : null;
    if (refused) this.notify(refused);
    else if (move && moveCards(this.store, [card.id], move.lane, move.index)) {
      this.announce(moveAnnouncement((this.store.get(move.lane) as BaseObj | undefined)?.name ?? '', move.position, move.total));
    }
    this.showMoving(card.id);
    return true;
  }

  /** The container whose layout shows a card (a card whose lane is gone is shown in another container's first lane). */
  private containerShowing(id: Id): Id | null {
    for (const o of this.store.ordered()) if (o.type === 'container' && this.store.containerLayout(o.id)?.rects.has(id)) return o.id;
    return null;
  }

  /** The keyboard-move ring and the "Moving" tag on a card. */
  private showMoving(id: Id) {
    const o = this.store.getPlaced(id);
    if (!o || o.type !== 'card' || !this.store.isLaidOut(o)) return this.clearMoving();
    this.kbMoving = id;
    const b = o as BaseObj;
    this.r.setOverlay({ kanban: { ...this.r.overlay.kanban, moving: { x: b.x, y: b.y, w: b.w, h: b.h } } });
  }

  private clearMoving() {
    if (!this.kbMoving) return;
    this.kbMoving = null;
    this.r.setOverlay({ kanban: this.r.overlay.kanban?.line ? { line: this.r.overlay.kanban.line } : null });
  }

  private onMove(e: PointerEvent) {
    const lp = this.longPress;
    if (lp && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 5) this.cancelLongPress();
    const p = this.worldOf(e);
    this.lastPointer = p;
    this.broadcastCursor(p);
    if (e.pointerType === 'touch' && this.isPinching()) return;
    const d = this.drag;
    if (!d) return this.updateHover(p);

    switch (d.mode) {
      case 'pan':
        if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 4) this.panned = true;
        this.r.setCamera({ x: d.cx - (e.clientX - d.sx) / this.zoom, y: d.cy - (e.clientY - d.sy) / this.zoom });
        return;
      case 'move':
        return this.doMove(d, p, e);
      case 'cards':
        return this.doCardDrag(d, p);
      case 'lane':
        return this.doLaneDrag(d, p);
      case 'resize':
        return this.doResize(d, p, e);
      case 'rotate': {
        let a = d.r0 + Math.atan2(p.y - d.c.y, p.x - d.c.x) - d.a0;
        if (e.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
        this.queue(() => this.store.transact(() => this.store.update(d.id, { rotation: a })));
        return;
      }
      case 'marquee': {
        if (Math.hypot(p.x - d.start.x, p.y - d.start.y) * this.zoom < 3) return;
        d.moved = true;
        const m = rectOfPoints([d.start, p]);
        const inside = this.itemsAtScope().filter((o) => !effectiveLocked(o, (id) => this.store.get(id)) && this.marqueeTouches(o, m));
        this.r.setOverlay({ marquee: m });
        this.selection = this.selectionAtScope([...d.base, ...inside.map((o) => o.id)]);
        this.r.setOverlay({ selection: this.selection });
        return;
      }
      case 'create': {
        const q = this.snapPoint(p, e);
        const rect = rectOfPoints([d.start, q]);
        if (rect.w < 4 && rect.h < 4) return;
        const preview = this.previewObj(d.tool, rect, e.shiftKey);
        this.r.setOverlay({ preview: preview ? objectMarkup(preview, this.r.ctx) : '' });
        return;
      }
      case 'connect': {
        d.moved = true;
        const target = this.hit(p, { connectors: false, frames: false });
        const fromId = d.from.kind === 'bound' ? d.from.id : null;
        const to: End = CONNECTABLE(target) && target.id !== fromId ? { kind: 'bound', id: target.id, anchor: 'auto' } : { kind: 'free', ...p };
        const c = this.connectorFrom(d.from, to, d.relation);
        this.r.setOverlay({ preview: objectMarkup(c, this.r.ctx), anchorsFor: to.kind === 'bound' ? to.id : null, anchorHot: null });
        return;
      }
      case 'endpoint': {
        const c = this.store.get(d.id);
        if (!isConnector(c)) return;
        const other = d.end === 'from' ? c.to : c.from;
        const otherId = other.kind === 'bound' ? other.id : null;
        const target = this.hit(p, { connectors: false, frames: false, skip: new Set([c.id]) });
        const end: End = CONNECTABLE(target) && target.id !== otherId ? { kind: 'bound', id: target.id, anchor: 'auto' } : { kind: 'free', ...this.snapPoint(p, e) };
        this.r.setOverlay({ anchorsFor: end.kind === 'bound' ? end.id : null });
        this.queue(() => this.store.transact(() => this.store.update(c.id, { [d.end]: end })));
        return;
      }
      case 'pen': {
        const last = d.pts[d.pts.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) < 2 / this.zoom) return;
        d.pts.push(p);
        const pseudo = this.penObj(d.pts);
        this.r.setOverlay({ preview: objectMarkup(pseudo, this.r.ctx) });
        return;
      }
    }
  }

  /** Coalesce store writes during drags to one per animation frame. */
  private queuedFn: (() => void) | null = null;
  private queue(fn: () => void) {
    this.queuedFn = fn;
    if (this.pendingFrame) return;
    this.pendingFrame = requestAnimationFrame(() => {
      this.pendingFrame = 0;
      const f = this.queuedFn;
      this.queuedFn = null;
      f?.();
    });
  }
  private flushQueue() {
    if (this.pendingFrame) cancelAnimationFrame(this.pendingFrame);
    this.pendingFrame = 0;
    const f = this.queuedFn;
    this.queuedFn = null;
    f?.();
  }

  private updateHover(p: Point) {
    const t = this.tool.kind;
    const top = t === 'select' || t === 'connector' ? this.hit(p, { locked: true }) : undefined;
    const voting = this.flow.isVoting();
    const lockedTarget = top && this.lockedTarget(top);
    const live = lockedTarget && !voting ? this.hit(p) : top;
    const lockedAncestor = top && !voting ? this.lockedGroupTarget(top) : undefined;
    const lockedTop = lockedAncestor ?? (!live && lockedTarget ? lockedTarget : undefined);
    const anchorHost = !lockedAncestor && !this.readOnly && CONNECTABLE(live) && !effectiveLocked(live, (id) => this.store.get(id)) && !voting ? live.id : null;
    // Keep anchors visible while the pointer is on one of them, or still close to the shape that shows them. The
    // dots sit just outside the edge, often on a connector that already leaves that side; hovering that connector
    // on the way to the dot must not hide them, or a second connector could never start there.
    const an = this.anchorAt(p);
    const shown = this.r.overlay.anchorsFor;
    const stay = !anchorHost && shown !== null && this.nearAnchors(shown, p) ? shown : null;
    const anchorsFor = an ? an.id : anchorHost ?? stay;
    const overPin = (t === 'select' || t === 'comment') && pinAt(this.r.pins, p, this.zoom) !== null;
    const hh = t === 'comment' ? undefined : this.handleAt(p);
    let cursor = '';
    if (overPin) cursor = 'pointer';
    else if (hh) cursor = hh.h === 'rot' ? 'grab' : hh.h === 'from' || hh.h === 'to' ? 'move' : resizeCursor(hh.h, this.store.get(hh.id));
    else if (an) cursor = 'crosshair';
    else if (lockedAncestor) cursor = '';
    else if (t === 'select' && top?.type === 'container' && this.kanbanControlAt(top.id, p)) cursor = 'pointer';
    else if (t === 'select' && top?.type === 'lane' && !this.readOnly && this.laneRegion(top.id, p) === 'menu') cursor = 'pointer';
    else if (live?.type === 'lane' && t === 'select' && !this.readOnly && this.laneRegion(live.id, p) === 'add') cursor = 'pointer';
    else if (live && t === 'select' && !this.readOnly) cursor = this.flow.isVoting() && (live.type === 'sticky' || live.type === 'shape') ? 'pointer' : 'move';
    else if (lockedTop && t === 'select' && !this.readOnly && this.flow.isVoting() && (lockedTop.type === 'sticky' || lockedTop.type === 'shape')) cursor = 'pointer';
    this.r.svg.style.cursor = cursor;
    const hovered = lockedAncestor ? undefined : live && t === 'select' && !voting ? pick(live, this.scope, (id) => this.store.get(id)) : live;
    this.r.setOverlay({ hover: hovered?.id ?? null, anchorsFor, anchorHot: an ? `${an.id}:${an.side}` : null, lockedHover: lockedTop?.id ?? null });
  }

  private doMove(d: Extract<Drag, { mode: 'move' }>, p: Point, e: PointerEvent) {
    let dx = p.x - d.start.x, dy = p.y - d.start.y;
    if (!d.moved && Math.hypot(dx, dy) * this.zoom < 3) return;
    const first = !d.moved;
    d.moved = true;
    if (first) this.emit('drag');
    const guides: Guide[] = [];
    if (!e.altKey) {
      const b = d.bounds;
      const vp = this.r.viewport();
      if (!d.guides || !guidesCover(d.guides, vp)) {
        const movers = [...d.orig.values()].filter(isBox).map(boxBounds);
        d.guides = startGuides(referenceRects(this.store.shown().map((o) => this.store.placed(o)), new Set(d.ids), (o) => this.flow.isHidden(o), (o) => this.store.geometry(o)), movers, vp);
      }
      const sn = snapMove(d.guides, dx, dy, this.zoom);
      if (sn.dx !== null) dx += sn.dx;
      else if (this.snapOn(e)) dx = snapTo(b.x + dx, this.grid()) - b.x;
      if (sn.dy !== null) dy += sn.dy;
      else if (this.snapOn(e)) dy = snapTo(b.y + dy, this.grid()) - b.y;
      guides.push(...sn.guides, ...sn.gaps);
    }
    // over a lane, selected stickies would become cards there: the drop line says where, and no frame is the target
    const overLane = this.showStickyDrop(d.ids, p);
    const frame = !overLane && d.ids.length && this.store.get(d.ids[0])?.type !== 'frame'
      ? this.frameAt({ x: d.bounds.x + d.bounds.w / 2 + dx, y: d.bounds.y + d.bounds.h / 2 + dy }, new Set(d.ids))
      : undefined;
    this.r.setOverlay({ guides, dropTarget: frame?.id ?? null });
    this.queue(() =>
      this.store.transact(() => {
        for (const [id, o] of d.orig) {
          if (isConnector(o)) {
            const patch: Partial<ConnectorObj> = {};
            if (o.from.kind === 'free') patch.from = { kind: 'free', x: o.from.x + dx, y: o.from.y + dy };
            if (o.to.kind === 'free') patch.to = { kind: 'free', x: o.to.x + dx, y: o.to.y + dy };
            this.store.update(id, patch);
          } else {
            this.store.update(id, { x: o.x + dx, y: o.y + dy });
          }
        }
      }),
    );
  }

  /** A corner of a text: scales its type and its width together, the opposite corner staying where it is (src/text-resize.ts). */
  private doTextScale(d: Extract<Drag, { mode: 'resize' }>, p: Point) {
    const o0 = d.o0;
    const corner = d.handle as Corner;
    const { fontSize, w } = scaledText(o0, cornerFactor(o0, corner, toLocal(o0, p)));
    const h = textHeight({ ...o0, fontSize, w });
    const box = cornerBox(o0, corner, w, h);
    const c = rotate({ x: o0.x + (box.l + box.r) / 2, y: o0.y + (box.t + box.b) / 2 }, center(o0), o0.rotation || 0);
    this.r.setOverlay({ guides: [] });
    this.queue(() => this.store.transact(() => this.store.update(d.id, { x: c.x - w / 2, y: c.y - h / 2, w, h, fontSize })));
  }

  private doResize(d: Extract<Drag, { mode: 'resize' }>, p: Point, e: PointerEvent) {
    if (d.o0.type === 'text' && isCorner(d.handle)) return this.doTextScale(d, p);
    const o0 = d.o0;
    const lp = toLocal(o0, p);
    let l = 0, t = 0, r = o0.w, b = o0.h;
    const h = d.handle;
    if (h.includes('w')) l = lp.x;
    if (h.includes('e')) r = lp.x;
    if (h.includes('n')) t = lp.y;
    if (h.includes('s')) b = lp.y;
    const keepAspect = (e.shiftKey || o0.type === 'icon' || o0.type === 'image' || o0.type === 'uml-actor') && h.length === 2;
    if (keepAspect) {
      const ratio = o0.w / Math.max(o0.h, 1);
      const w = Math.abs(r - l), hh = Math.abs(b - t);
      if (w / ratio > hh) {
        const nh = w / ratio;
        if (h.includes('n')) t = b - nh; else b = t + nh;
      } else {
        const nw = hh * ratio;
        if (h.includes('w')) l = r - nw; else r = l + nw;
      }
    }
    let sx: number | null = null, sy: number | null = null;
    const guides: Guide[] = [];
    if (!e.altKey && !o0.rotation) {
      const vp = this.r.viewport();
      if (!d.guides || !guidesCover(d.guides, vp)) {
        d.guides = startGuides(referenceRects(this.store.shown().map((o) => this.store.placed(o)), new Set([d.id]), (o) => this.flow.isHidden(o), (o) => this.store.geometry(o)), [], vp);
      }
      const proposed = { x: o0.x + l, y: o0.y + t, w: r - l, h: b - t };
      if (keepAspect) {
        const ratio = o0.w / Math.max(o0.h, 1);
        const sn = snapResizeLocked(d.guides, proposed, h, this.zoom, ratio);
        l = sn.rect.x - o0.x;
        t = sn.rect.y - o0.y;
        r = l + sn.rect.w;
        b = t + sn.rect.h;
        guides.push(...sn.guides, ...sn.gaps, ...sn.sizes);
      } else {
        const sn = snapResize(d.guides, proposed, h, this.zoom);
        sx = sn.dx;
        sy = sn.dy;
        if (sx !== null) { if (h.includes('w')) l += sx; else r += sx; }
        if (sy !== null) { if (h.includes('n')) t += sy; else b += sy; }
        guides.push(...sn.guides, ...sn.gaps, ...sn.sizes);
      }
    }
    this.r.setOverlay({ guides });
    if (this.snapOn(e) && !o0.rotation && !keepAspect) {
      const g = this.grid();
      if (h.includes('w') && sx === null) l = snapTo(o0.x + l, g) - o0.x;
      if (h.includes('e') && sx === null) r = snapTo(o0.x + r, g) - o0.x;
      if (h.includes('n') && sy === null) t = snapTo(o0.y + t, g) - o0.y;
      if (h.includes('s') && sy === null) b = snapTo(o0.y + b, g) - o0.y;
    }
    const minW = o0.type === 'tracker' ? 480 : 8;
    const minH = o0.type === 'tracker' ? 360 : 8;
    if (r - l < minW) {
      if (h.includes('w')) l = r - minW;
      else r = l + minW;
    }
    if (b - t < minH) {
      if (h.includes('n')) t = b - minH;
      else b = t + minH;
    }
    const w = r - l, hh = b - t;
    const c0 = center(o0);
    const cLocal = { x: o0.x + (l + r) / 2, y: o0.y + (t + b) / 2 };
    const c = rotate(cLocal, c0, o0.rotation || 0);
    const patch: Partial<BaseObj> = { x: c.x - w / 2, y: c.y - hh / 2, w, h: hh };
    if (o0.type === 'text') {
      patch.h = textHeight({ ...o0, w });
      patch.y = o0.y;
    }
    if (o0.type === 'path' && o0.points) {
      const sx = w / Math.max(o0.w, 1), sy = hh / Math.max(o0.h, 1);
      patch.points = o0.points.map((v, i) => (i % 2 === 0 ? v * sx : v * sy));
    }
    this.queue(() => this.store.transact(() => this.store.update(d.id, patch)));
  }

  private onCancel(e: PointerEvent) {
    if (this.drag?.mode === 'cards' || this.drag?.mode === 'lane') return this.cancelCardDrag();
    this.onUp(e);
  }

  private onUp(e: PointerEvent) {
    this.cancelLongPress();
    const d = this.drag;
    this.drag = null;
    this.r.root.classList.remove('panning');
    if (!d) return;
    this.flushQueue();
    this.emit('drag');
    const p = this.worldOf(e);
    switch (d.mode) {
      case 'move':
        if (d.moved) {
          this.clearStickyDrop();
          this.reparent(d.ids);
          this.store.undo.stopCapturing();
          this.dropStickiesInLane(d.ids, p);
        }
        else if (!e.shiftKey) {
          // plain click on an already-selected item inside a multi-selection selects just it
          const hit = this.hit(p);
          if (hit && this.selection.length > 1) this.setSelection([hit.id]);
        }
        break;
      case 'cards':
        this.finishCardDrag(d, p);
        break;
      case 'lane':
        this.finishLaneDrag(d, p);
        break;
      case 'marquee':
        if (!d.moved && this.scope) this.leaveGroup();
        else this.emitSelection();
        break;
      case 'create':
        this.finishCreate(d, p, e);
        break;
      case 'connect': {
        const target = this.hit(p, { connectors: false, frames: false });
        const fromId = d.from.kind === 'bound' ? d.from.id : null;
        const dist = d.from.kind === 'free' ? Math.hypot(p.x - d.from.x, p.y - d.from.y) * this.zoom : 99;
        if (!d.moved || dist < 6) {
          if (d.from.kind === 'bound' && !d.moved) {
            // click on an anchor: quick-create a connected copy of the shape
            this.quickConnect(d.from.id, this.anchorSideAt(p));
          }
          break;
        }
        const to: End = CONNECTABLE(target) && target.id !== fromId ? { kind: 'bound', id: target.id, anchor: 'auto' } : { kind: 'free', ...this.snapPoint(p, e) };
        const c = this.connectorFrom(d.from, to, d.relation);
        this.createObject(c);
        if (this.tool.kind === 'connector') this.setTool({ kind: 'select' });
        break;
      }
      case 'pen':
        if (d.pts.length > 1) this.createObject(this.penObj(d.pts), false);
        break;
      case 'endpoint':
      case 'resize':
      case 'rotate':
        break;
    }
    this.store.undo.stopCapturing();
    this.r.setOverlay({ marquee: null, preview: '', guides: [], dropTarget: null });
  }

  private anchorSideAt(p: Point) {
    return this.anchorAt(p)?.side ?? 'right';
  }

  /**
   * Clicking a connection dot connects the shape to its neighbour on that side, if there is one; otherwise it creates
   * a copy of the shape there, connected. A neighbour that is already connected to it is only selected.
   */
  private quickConnect(id: Id, side: 'top' | 'right' | 'bottom' | 'left') {
    const src = this.store.get(id);
    if (!isBox(src)) return;
    const candidates = this.store.shown().filter((o): o is BaseObj => CONNECTABLE(o) && !this.flow.isHidden(o));
    const next = neighborInDirection(src, side, candidates);
    if (next) {
      const linked = this.store.connectorsOf(src.id).some((c) =>
        (c.from.kind === 'bound' && c.from.id === next.id) || (c.to.kind === 'bound' && c.to.id === next.id));
      if (!linked) {
        this.store.undo.stopCapturing();
        this.store.transact(() => this.store.create(this.connectorFrom({ kind: 'bound', id: src.id, anchor: 'auto' }, { kind: 'bound', id: next.id, anchor: 'auto' })));
      }
      this.setSelection([next.id]);
      return;
    }
    const spot = freeSpotInDirection(src, side, candidates);
    const copy: BaseObj = { ...structuredClone(src), id: newId(), x: spot.x, y: spot.y, z: this.store.topZ(), createdBy: this.user.id, text: src.type === 'uml-class' ? 'NewClass' : '' };
    if (copy.type === 'uml-class') { copy.attributes = []; copy.operations = []; copy.h = classHeight(copy); }
    delete copy.privateStep;
    const c = this.connectorFrom({ kind: 'bound', id: src.id, anchor: 'auto' }, { kind: 'bound', id: copy.id, anchor: 'auto' });
    this.store.undo.stopCapturing();
    this.store.transact(() => {
      this.store.create(copy);
      this.store.create(c);
    });
    this.setSelection([copy.id]);
    if (copy.type !== 'uml-class') this.editor.start(copy.id);
  }

  connectorFrom(from: End, to: End, relation?: UmlRelation): ConnectorObj {
    const rel = relation ? RELATIONS[relation] : null;
    return {
      id: newId(), type: 'connector', z: this.store.topZ(), from, to,
      route: this.connectorDefaults.route ?? 'elbow',
      startHead: rel ? rel.startHead : this.connectorDefaults.startHead ?? 'none',
      endHead: rel ? rel.endHead : this.connectorDefaults.endHead ?? 'arrow',
      dash: rel ? rel.dash : this.connectorDefaults.dash,
      stroke: this.connectorDefaults.stroke,
      strokeWidth: this.connectorDefaults.strokeWidth,
      relation, createdBy: this.user.id, updatedAt: Date.now(),
    };
  }

  private penObj(pts: Point[]): BaseObj {
    const b = rectOfPoints(pts);
    const flat: number[] = [];
    for (const q of pts) flat.push(Math.round((q.x - b.x) * 10) / 10, Math.round((q.y - b.y) * 10) / 10);
    return this.makeObj('path', { x: b.x, y: b.y, w: Math.max(b.w, 1), h: Math.max(b.h, 1) }, { points: flat, stroke: this.penColor, strokeWidth: this.penWidth });
  }
  penColor = CANVAS_INK;
  penWidth = 3;

  private defaultSize(t: Tool): { w: number; h: number } {
    switch (t.kind) {
      case 'sticky': return { w: 192, h: 192 };
      case 'text': return { w: 240, h: 28 };
      case 'frame': return { w: 960, h: 600 };
      case 'shape': return shapeDefaultSize(t.shape);
      case 'uml': return { w: t.def.w, h: t.def.h };
      default: return { w: 160, h: 100 };
    }
  }

  private previewObj(t: Tool, rect: Rect, square: boolean): BaseObj | null {
    if (square) rect = { ...rect, w: Math.max(rect.w, rect.h), h: Math.max(rect.w, rect.h) };
    switch (t.kind) {
      case 'sticky': return this.makeObj('sticky', rect);
      case 'text': return this.makeObj('text', { ...rect, h: Math.max(rect.h, 28) });
      case 'frame': return this.makeObj('frame', rect, { name: 'Frame' });
      case 'shape': return this.makeObj('shape', rect, { kind: t.shape });
      case 'uml': return this.makeObj(t.def.type, rect, structuredClone(t.def.defaults || {}));
      default: return null;
    }
  }

  private finishCreate(d: Extract<Drag, { mode: 'create' }>, p: Point, e: PointerEvent) {
    const q = this.snapPoint(p, e);
    let rect = rectOfPoints([d.start, q]);
    const dragged = rect.w * this.zoom > 8 || rect.h * this.zoom > 8;
    if (d.tool.kind === 'kanban') {
      // its size comes from its lanes: a drag only says where its corner goes, a click where its middle goes
      const size = newKanbanSize();
      let at = dragged ? { x: d.start.x, y: d.start.y } : { x: d.start.x - size.w / 2, y: d.start.y - size.h / 2 };
      if (this.snapOn(e)) at = { x: snapTo(at.x, this.grid()), y: snapTo(at.y, this.grid()) };
      this.createKanban(at);
      return;
    }
    if (!dragged) {
      const s = this.defaultSize(d.tool);
      rect = { x: d.start.x - s.w / 2, y: d.start.y - s.h / 2, ...s };
      if (this.snapOn(e)) rect = { ...rect, x: snapTo(rect.x, this.grid()), y: snapTo(rect.y, this.grid()) };
    }
    const o = this.previewObj(d.tool, rect, e.shiftKey);
    if (!o) return;
    if (o.type === 'frame') {
      o.name = `Frame ${[...this.store.cache.values()].filter((x) => x.type === 'frame').length + 1}`;
      o.z = this.store.bottomZ();
    }
    if (o.type === 'uml-class') o.h = Math.max(o.h, classHeight(o));
    this.createObject(o);
    if (o.type === 'frame') this.adoptInto(o);
    this.setTool({ kind: 'select' });
    if (o.type === 'sticky' || o.type === 'text' || o.type === 'shape') this.editor.start(o.id);
  }

  /** A new frame drawn over existing objects takes them as children. */
  private adoptInto(frame: BaseObj) {
    const fb = boxBounds(frame);
    this.store.transact(() => {
      for (const o of this.store.cache.values()) {
        if (o.id === frame.id || o.type === 'frame' || o.locked || isConnector(o) || this.store.isLaidOut(o)) continue;
        if (o.parent && this.store.get(o.parent)?.type === 'group') continue;
        if (o.type === 'group') {
          if (rectContains(fb, boxBounds(this.store.placed(o) as BaseObj))) this.store.update(o.id, { parent: frame.id });
          continue;
        }
        if (!isBox(o)) continue;
        if (rectContains(fb, boxBounds(this.store.placed(o)))) this.store.update(o.id, { parent: frame.id });
      }
    });
  }

  private reparent(ids: Id[]) {
    this.store.transact(() => {
      for (const id of ids) {
        const o = this.store.get(id);
        if (!o || o.type === 'frame' || this.store.isLaidOut(o)) continue;
        if (o.parent && this.store.get(o.parent)?.type === 'group') continue;
        if (o.type !== 'group' && !isBox(o)) continue;
        // children that moved together with their frame keep their parent
        if (o.parent && ids.includes(o.parent)) continue;
        const f = this.frameAt(center(this.store.placed(o)), new Set([id]));
        if ((f?.id ?? undefined) !== o.parent) this.store.update(id, { parent: f?.id });
      }
    });
  }

  private onDblClick(e: MouseEvent) {
    if (isCardLinkTarget(e.target)) return;
    // During a dot vote, the two pointer clicks already cast votes; double-click must not also enter a group or edit.
    if (this.flow.isVoting()) return;
    const p = this.worldOf(e);
    // a double click on a pin must not edit the object underneath or add a text box
    if ((this.tool.kind === 'select' || this.tool.kind === 'comment') && pinAt(this.r.pins, p, this.zoom)) return;
    const top = this.hit(p, { locked: true });
    const lockedGroup = top && this.lockedGroupTarget(top);
    // a double click on a kanban's controls is two clicks on them, never a rename or a new card
    if (!lockedGroup && top?.type === 'container' && this.kanbanControlAt(top.id, p)) return;
    if (!lockedGroup && top?.type === 'lane' && this.laneRegion(top.id, p) === 'menu') return;
    // at phone width a double tap on a kanban opens it as a list, on the lane tapped (docs/kanban.md, Phone and touch)
    if (!lockedGroup && phoneWidth() && top && this.openSheet) {
      const cid = containerOf(this.store, top) ?? (top.type === 'card' ? this.containerShowing(top.id) : null);
      if (cid) {
        const lane = top.type === 'lane' ? top.id : top.type === 'card' ? laneOf(this.store, top.id) ?? undefined : undefined;
        this.openKanbanList(cid, lane);
        return;
      }
    }
    if (top && this.lockedTarget(top) && !this.hit(p)) return;
    const hit = this.hit(p);
    if (hit) {
      const selected = pick(hit, this.scope, (id) => this.store.get(id));
      if (isGroup(selected) && selected.id !== this.scope) {
        this.enterGroup(selected.id);
        const member = pick(hit, selected.id, (id) => this.store.get(id));
        if (member) this.setSelection([member.id]);
        return;
      }
    }
    if (this.readOnly) {
      if (hit) this.setSelection([hit.id]);
      // commenters read a card in its dialog, read-only (docs/kanban.md, Permissions)
      if (hit?.type === 'card') this.openCardDialog(hit.id);
      return;
    }
    if (hit?.type === 'lane' && this.laneRegion(hit.id, p) !== 'header') {
      // empty lane space adds a card; the header renames the lane
      this.cardInput.start(hit.id);
      return;
    }
    // the card dialog is the one editor of a card (docs/kanban.md, Cards)
    if (hit?.type === 'card') {
      this.setSelection([hit.id]);
      this.openCardDialog(hit.id);
      return;
    }
    if (hit) {
      if (hit.type === 'frame' || hit.type === 'tracker' || hit.type === 'icon' || hit.type === 'image' || hit.type === 'path' || hit.type === 'uml-initial' || hit.type === 'uml-final') {
        if (hit.type === 'frame') this.editor.start(hit.id);
        return;
      }
      if (this.flow.isHidden(hit as BaseObj)) return;
      this.setSelection([hit.id]);
      this.editor.start(hit.id);
      return;
    }
    if (this.tool.kind !== 'select') return;
    const o = this.makeObj('text', { x: p.x, y: p.y - 14, w: 240, h: 28 });
    this.createObject(o);
    this.editor.start(o.id);
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const s = this.r.size();
    const sp = { x: e.clientX - s.left, y: e.clientY - s.top };
    if (e.ctrlKey || e.metaKey) {
      const k = e.deltaMode === 1 ? 0.05 : 0.0025;
      this.r.zoomAt(sp, Math.exp(-e.deltaY * k * (e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 50 ? 3 : 1)));
    } else {
      const k = e.deltaMode === 1 ? 16 : 1;
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
      this.r.setCamera({ x: this.r.cam.x + (dx * k) / this.zoom, y: this.r.cam.y + (dy * k) / this.zoom });
    }
    if (this.editor.active) this.editor.reposition();
  }

  // ---------------------------------------------------------------- keyboard

  private bindKeys() {
    const signal = this.lifetime.signal;
    window.addEventListener('keydown', (e) => {
      const tgt = e.target as HTMLElement;
      const typing = !!tgt?.closest?.('[data-card-link]') || (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.tagName === 'SELECT' || tgt.isContentEditable));
      const k = e.key.toLowerCase();
      if (k === 'escape') {
        const action = escapeAction({
          key: e.key,
          defaultPrevented: e.defaultPrevented,
          overlayOpen: !!document.querySelector('.popover, .modal-back'),
          dragging: !!this.drag || !!this.longPress,
          groupOpen: !!this.scope,
          drawerOpen: document.querySelector<HTMLElement>('.drawer.show, .side-tray.show')?.dataset.tab ?? null,
        });
        if (action === 'overlay' || action === 'none') return;
        if (action === 'drag') {
          this.cancelLongPress();
          this.cancelCardDrag();
          if (this.drag) { this.drag = null; this.r.setOverlay({ marquee: null, preview: '', guides: [] }); }
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
        if (action === 'group') {
          this.leaveGroup();
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
        if (action === 'drawer' && this.closeEscapeDrawer?.()) {
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
      }
      if (e.code === 'Space' && !typing) {
        if (!this.spaceDown) {
          this.spaceDown = true;
          this.r.root.classList.add('space');
        }
        e.preventDefault();
        return;
      }
      if (typing) return;
      const mod = e.metaKey || e.ctrlKey;
      const ro = this.readOnly;
      if (e.shiftKey && !e.altKey && !mod && (k === 'h' || k === 'v')) {
        e.preventDefault();
        if (!ro) this.flipSelection(k === 'h' ? 'horizontal' : 'vertical');
        return;
      }
      if (mod && k === 'g') {
        e.preventDefault();
        if (!ro) {
          if (e.shiftKey) this.ungroupSelection();
          else this.groupSelection();
        }
        return;
      }
      if (mod && k === 'z') {
        e.preventDefault();
        if (ro) return;
        if (e.shiftKey) this.store.undo.redo();
        else this.store.undo.undo();
        return;
      }
      if (mod && k === 'y') { e.preventDefault(); if (!ro) this.store.undo.redo(); return; }
      if (mod && k === 'a') {
        e.preventDefault();
        this.setSelection(this.itemsAtScope().filter((o) => !effectiveLocked(o, (id) => this.store.get(id))).map((o) => o.id));
        return;
      }
      if (mod && k === ']') { e.preventDefault(); if (!ro) this.bringForward(); return; }
      if (mod && k === '[') { e.preventDefault(); if (!ro) this.sendBackward(); return; }
      if (mod && k === 'd') { e.preventDefault(); if (!ro) this.duplicate(); return; }
      if (mod && k === 'c') { this.copy(); return; }
      if (mod && k === 'x') { if (!ro) { this.copy(); this.deleteSelection(); } return; }
      if (mod && (k === '=' || k === '+')) { e.preventDefault(); this.zoomBy(1.25); return; }
      if (mod && k === '-') { e.preventDefault(); this.zoomBy(0.8); return; }
      if (mod) return;
      if (e.shiftKey && e.code === 'Digit1') return this.zoomToFit();
      if (e.shiftKey && e.code === 'Digit2') return this.zoomToSelection();
      if (e.shiftKey && e.code === 'Digit0') return this.zoomTo(1);
      if (k === 'delete' || k === 'backspace') { e.preventDefault(); if (!ro) this.deleteSelection(); return; }
      if (k === 'escape') {
        this.cancelLongPress();
        this.cancelCardDrag();
        if (this.drag) { this.drag = null; this.r.setOverlay({ marquee: null, preview: '', guides: [] }); }
        if (this.scope) this.leaveGroup();
        else this.setSelection([]);
        this.closeThread();
        this.setDraftPin(null);
        this.setTool({ kind: 'select' });
        return;
      }
      if (k === 'enter' && this.selection.length === 1) {
        e.preventDefault();
        const type = this.store.get(this.selection[0])?.type;
        if (type === 'card') this.openCardDialog(this.selection[0]);
        // a kanban opens as a list, for every role: the keyboard route to its cards (docs/kanban.md, Phone and touch)
        else if (type === 'container' && this.openKanbanList(this.selection[0])) return;
        else if (!ro) this.editor.start(this.selection[0]);
        return;
      }
      if (k.startsWith('arrow') && this.selection.length) {
        e.preventDefault();
        if (ro) return;
        // Alt+arrows move a card in its lane or to the next lane (docs/kanban.md, Cards)
        if (e.altKey && this.keyboardCardMove(k.slice(5) as MoveKey)) return;
        // Alt+Shift+arrows resize a selected text: left and right the wrap width, up and down the type (src/text-resize.ts)
        if (e.altKey && e.shiftKey && this.resizeTextByKey(k.slice(5) as TextKey)) return;
        const step = e.shiftKey ? this.grid() : 1;
        const dx = k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0;
        const dy = k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0;
        this.nudge(dx, dy);
        return;
      }
      if (k === ']') { if (!ro) this.bringToFront(); return; }
      if (k === '[') { if (!ro) this.sendToBack(); return; }
      // stickies to cards and back (docs/kanban.md, Sticky to card and back)
      if (k === 'k' && !e.altKey) { if (!ro) this.toggleCards(); return; }
      // board chat (docs/chat.md): set by the board UI only where chat is available, for every role
      if (k === 'm' && !e.altKey && this.toggleChat) { e.preventDefault(); this.toggleChat(); return; }
      // commenters have a read-only board but may still use the comment tool; setTool checks the comments document
      if (TOOL_KEYS[k] && (!ro || k === 'v' || k === 'h' || k === 'c')) this.setTool(TOOL_KEYS[k]);
    }, { signal });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceDown = false;
        this.r.root.classList.remove('space');
      }
    }, { signal });
    window.addEventListener('blur', () => this.cancelLongPress(), { signal });
    window.addEventListener('paste', (e) => {
      const tgt = e.target as HTMLElement;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) return;
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (files.length && this.onImageFiles) {
        e.preventDefault();
        this.onImageFiles(files);
        return;
      }
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (!text) return;
      e.preventDefault();
      this.pasteText(text);
    }, { signal });
  }

  zoomBy(f: number) {
    const s = this.r.size();
    this.r.zoomAt({ x: s.w / 2, y: s.h / 2 }, f);
  }
  zoomTo(z: number) {
    const s = this.r.size();
    this.r.zoomAt({ x: s.w / 2, y: s.h / 2 }, z / this.zoom);
  }
  zoomToFit() {
    const b = this.r.contentBounds();
    if (b) this.r.flyTo(b, 80, 2);
  }
  /**
   * Takes the view to one object and selects it, for a chat message that points at it. Does nothing for an object that is
   * not there, hidden or hidden from this person; says whether it went.
   */
  flyToObject(id: Id): boolean {
    const o = this.store.get(id);
    if (!o || !this.store.isShown(o) || this.flow.isHidden(o as BaseObj)) return false;
    const b = this.r.contentBounds([id]);
    if (!b) return false;
    this.r.flyTo(b, 120, 3);
    if (!o.locked) this.setSelection([id]);
    return true;
  }

  zoomToSelection() {
    const b = this.r.contentBounds(this.selection);
    if (b) this.r.flyTo(b, 120, 3);
  }

  // ---------------------------------------------------------------- commands

  /** Why a mirror command is disabled, also used by both menus to show the same explanation. */
  flipReason(_axis: FlipAxis): string | null {
    return flipDisabledReason(this.selected(), this.selectedLeaves(), this.readOnly);
  }

  /** Mirrors the selected leaves about their overall bounds as one undoable board edit. */
  flipSelection(axis: FlipAxis): boolean {
    if (this.readOnly) return false;
    const reason = this.flipReason(axis);
    if (reason) {
      this.notify(reason);
      return false;
    }
    const bounds = this.r.contentBounds(this.selection);
    if (!bounds) return false;
    const about = center(bounds);
    const participants = this.selectedLeaves().filter((o) => !effectiveLocked(o, (id) => this.store.get(id)));
    const visibleConnectors = this.store.shown().filter((o): o is ConnectorObj => isConnector(o) &&
      !effectiveLocked(o, (id) => this.store.get(id)) && !this.flow.isHidden(o as BaseObj));
    const patches = planFlip(participants, visibleConnectors, axis, about);
    if (!patches.length) return false;
    this.store.undo.stopCapturing();
    this.store.transact(() => patches.forEach(({ id, patch }) => this.store.update(id, patch)));
    this.store.undo.stopCapturing();
    this.announce(axis === 'horizontal' ? 'Flipped horizontally' : 'Flipped vertically');
    return true;
  }

  /** Alt+Shift+arrow on selected texts: one undo step, announced. False when the selection holds no text to resize. */
  private resizeTextByKey(key: TextKey): boolean {
    const texts = this.selected().filter((o): o is BaseObj => o.type === 'text' && !o.locked);
    if (!texts.length || texts.length !== this.selection.length) return false;
    const patches = texts.map((o) => ({ o, patch: keyResize(o, key) })).filter((x) => x.patch !== null);
    if (!patches.length) return true;
    this.store.undo.stopCapturing();
    this.store.transact(() => patches.forEach(({ o, patch }) => this.store.update(o.id, patch!)));
    this.store.undo.stopCapturing();
    const first = this.store.get(patches[0].o.id) as BaseObj;
    this.announce(key === 'left' || key === 'right' ? `Text width ${Math.round(first.w)}` : `Text size ${styleOf(first).fontSize}`);
    return true;
  }

  nudge(dx: number, dy: number) {
    this.store.transact(() => {
      for (const o of this.selected()) {
        if (o.locked || this.store.isLaidOut(o)) continue;
        if (isConnector(o)) {
          const patch: Partial<ConnectorObj> = {};
          if (o.from.kind === 'free') patch.from = { ...o.from, x: o.from.x + dx, y: o.from.y + dy };
          if (o.to.kind === 'free') patch.to = { ...o.to, x: o.to.x + dx, y: o.to.y + dy };
          this.store.update(o.id, patch);
        } else {
          this.store.update(o.id, { x: o.x + dx, y: o.y + dy });
          if (o.type === 'frame') {
            for (const id of this.gather([o.id]).map((x) => x.id)) {
              const c = this.store.get(id);
              if (c && c.id !== o.id && isBox(c) && !c.locked && !this.selection.includes(c.id)) this.store.update(c.id, { x: c.x + dx, y: c.y + dy });
            }
          }
        }
      }
    });
  }

  deleteSelection() {
    if (this.deleteObjects(this.selection.filter((id) => !this.store.get(id)?.locked))) this.setSelection([]);
  }

  /**
   * Deletes objects (unlocked ones; the caller leaves out locked ones) in one undo step. A kanban goes with its lanes and
   * cards, a lane's cards move to its neighbour unless they are deleted too; locks inside kanbans are respected
   * (containers.ts, planKanbanDelete). Returns whether anything was deleted.
   */
  deleteObjects(list: Id[]): boolean {
    if (this.readOnly) return false;
    const selected = new Set(list);
    const selectedGroups = list.filter((id) => this.store.get(id)?.type === 'group');
    const gathered = this.gather(list);
    const visible = new Set(gathered.map((o) => o.id));
    const groupSubtree = new Set<Id>();
    const preserve = new Set<Id>();
    const selectedGroupIds = new Set(selectedGroups);
    const pending = [...selectedGroups];
    const expanded = new Set<Id>();
    while (pending.length) {
      const parent = pending.pop()!;
      if (expanded.has(parent)) continue;
      expanded.add(parent);
      groupSubtree.add(parent);
      for (const child of this.store.childrenOf(parent)) {
        if (groupSubtree.has(child.id)) continue;
        groupSubtree.add(child.id);
        if (child.type === 'group' || child.type === 'frame' || child.type === 'container' || child.type === 'lane') pending.push(child.id);
      }
    }
    for (const childId of groupSubtree) {
      if (selectedGroupIds.has(childId)) continue;
      if (visible.has(childId)) selected.add(childId);
      else {
        // Objects omitted by private-selection gathering stay on the board when the group is removed.
        selected.delete(childId);
        preserve.add(childId);
      }
    }
    // A copied connector that joins a group member to another selected object travels with the cut too.
    for (const o of gathered) {
      if (!isConnector(o)) continue;
      const touchesGroup = [o.from, o.to].some((end) => end.kind === 'bound' && groupSubtree.has(end.id));
      if (touchesGroup) selected.add(o.id);
    }
    const plan = planKanbanDelete(this.store, [...selected]);
    if ('refused' in plan) {
      this.notify(plan.refused);
      return false;
    }
    const { ids, relocate } = plan;
    if (!ids.size) return false;
    const moved = new Set(relocate.map((r) => r.id));
    const objectsBefore = this.store.cache.size;
    this.store.undo.stopCapturing();
    this.store.transact(() => {
      // Keep objects omitted by private-selection gathering outside the removed group subtree. Climb past every
      // object being deleted so nested selected groups and containers cannot take them with them.
      for (const id of preserve) {
        const object = this.store.get(id);
        if (!object?.parent) continue;
        let parent: Id | undefined = object.parent;
        const seen = new Set<Id>([id]);
        while (parent && ids.has(parent) && !seen.has(parent)) {
          seen.add(parent);
          parent = this.store.get(parent)?.parent;
        }
        if (object.parent !== parent) this.store.update(id, { parent });
      }
      // the cards of a deleted lane move to the end of its neighbour first (docs/kanban.md, Concurrent edits)
      for (const p of relocate) this.store.update(p.id, { parent: p.parent, rank: p.rank });
      // Connectors attached to deleted shapes keep their line: bound ends become free.
      for (const id of ids) {
        for (const c of this.store.connectorsOf(id)) {
          if (ids.has(c.id)) continue;
          const g = connectorGeom((x) => this.store.getPlaced(x), c, this.r.connectorLayout());
          if (!g) continue;
          const patch: Partial<ConnectorObj> = {};
          if (c.from.kind === 'bound' && ids.has(c.from.id)) patch.from = { kind: 'free', x: g.start.x, y: g.start.y };
          if (c.to.kind === 'bound' && ids.has(c.to.id)) patch.to = { kind: 'free', x: g.end.x, y: g.end.y };
          this.store.update(c.id, patch);
        }
        // children of deleted frames stay on the board
        if (this.store.get(id)?.type === 'frame') {
          for (const ch of this.store.childrenOf(id)) if (!ids.has(ch.id) && !moved.has(ch.id) && !preserve.has(ch.id)) this.store.update(ch.id, { parent: undefined });
        }
      }
      this.store.remove(ids);
    });
    this.store.undo.stopCapturing();
    const deleted = objectsBefore - this.store.cache.size;
    this.announce(deleted === 1 ? 'Deleted 1 object' : `Deleted ${deleted} objects`);
    this.setSelection(this.selection.filter((id) => !ids.has(id)));
    return true;
  }

  /** Selected objects plus what travels with them, as a portable list; never a note private writing hides from this person. */
  gather(ids: Id[]): Obj[] {
    return gatherObjects(this.store, this.flow, ids);
  }

  copy() {
    if (!this.selection.length) return;
    this.clipboard = gatherCopyObjects(this.store, this.flow, this.selection);
    const payload = JSON.stringify({ driftboard: 1, objects: this.clipboard });
    navigator.clipboard?.writeText(payload).catch(() => undefined);
  }

  duplicate() {
    if (!this.selection.length) return;
    this.insertObjects(gatherCopyObjects(this.store, this.flow, this.selection), { x: 24, y: 24 });
  }

  /** Insert copies of objects with fresh ids, remapping parents and bindings. */
  insertObjects(objs: Obj[], offset: Point) {
    if (!objs.length) return [];
    const map = new Map<Id, Id>();
    for (const o of objs) map.set(o.id, newId());
    const out = remapObjects(objs, map, offset, (id) => {
      const src = this.store.get(id);
      return src && isBox(src) ? center(src) : null;
    });
    const zs = this.store.topZs(objs.length);
    out.forEach((o, i) => {
      o.z = zs[i];
      o.createdBy = this.user.id;
    });
    this.store.undo.stopCapturing();
    this.store.transact(() => out.forEach((o) => this.store.create(o)));
    this.store.undo.stopCapturing();
    this.announce(out.length === 1 ? 'Added 1 object' : `Added ${out.length} objects`);
    this.resetScopeSelection(out.filter((o) => !o.parent || !map.has(o.parent!)).map((o) => o.id).filter((id) => {
      const o = this.store.get(id);
      return o && (!isConnector(o) || out.length === 1);
    }));
    return out;
  }

  pasteText(text: string) {
    if (this.readOnly) return;
    try {
      const data = JSON.parse(text);
      if (data?.driftboard && Array.isArray(data.objects)) {
        const objs = data.objects as Obj[];
        const b = rectOfPoints(objs.filter(isBox).flatMap((o) => [{ x: o.x, y: o.y }, { x: o.x + o.w, y: o.y + o.h }]));
        const target = this.lastPointer;
        const inView = pointInRect(target, this.r.viewport());
        const at = inView ? target : center(this.r.viewport());
        this.insertObjects(objs, { x: at.x - (b.x + b.w / 2), y: at.y - (b.y + b.h / 2) });
        return;
      }
    } catch { /* not JSON */ }
    if (this.clipboard.length && text === JSON.stringify({ driftboard: 1, objects: this.clipboard })) return;
    // Preserve the clipboard's line breaks, removing only empty lines at either end.
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const normalized = lines.join('\n');
    if (!normalized) return;

    // The board operation validator uses UTF-16 length; stop at a code point boundary so a pasted emoji stays intact.
    let length = 0;
    const kept: string[] = [];
    for (const char of normalized) {
      if (length + char.length > OBJECT_TEXT_MAX) break;
      kept.push(char);
      length += char.length;
    }
    const content = kept.join('');
    if (normalized.length > OBJECT_TEXT_MAX) this.notify(`Pasted text was cut to ${OBJECT_TEXT_MAX.toLocaleString('en-US')} characters.`);
    if (!content.trim()) return;

    const at = pointInRect(this.lastPointer, this.r.viewport()) ? this.lastPointer : center(this.r.viewport());
    const font = this.store.getMeta().bodyFont;
    const css = fontCss(font, 20, 400);
    const naturalWidth = Math.max(...content.split('\n').map((line) => measure(line.trimEnd(), css)));
    const w = Math.min(360, Math.max(8, Math.ceil(naturalWidth)));
    const probe = { id: '', type: 'text', x: 0, y: 0, w, h: 0, rotation: 0, z: '', text: content, font } as BaseObj;
    const h = textHeight(probe);
    // makeObj applies the same frame parenting as the Text tool; centring the box makes its centre the paste point.
    const o = this.makeObj('text', { x: at.x - w / 2, y: at.y - h / 2, w, h }, { text: content });
    this.createObject(o);
  }

  pasteInternal() {
    if (this.clipboard.length) this.pasteText(JSON.stringify({ driftboard: 1, objects: this.clipboard }));
  }

  /** A right-click: selects what is under the pointer (unless it is already selected) and asks the UI for its menu. */
  private onContextMenu(e: MouseEvent) {
    // a right-button press starts a pan: it is a click for a menu only when the view did not move
    if (this.readOnly || this.panned || (this.drag && this.drag.mode !== 'pan')) return;
    const hit = this.hit(this.r.clientToWorld(e.clientX, e.clientY));
    if (!hit) return;
    if (!this.selection.includes(hit.id)) this.setSelection([hit.id]);
    if (this.drag?.mode === 'pan') {
      this.drag = null;
      this.r.root.classList.remove('panning');
    }
    this.openObjectMenu?.(e.clientX, e.clientY);
  }

  /** One step forward: past the nearest object the selection overlaps (TAB-108). */
  bringForward() {
    const moved = this.restack(planStep(this.store.ordered(), this.selection, 1, (a, b) => this.overlap(a, b)));
    if (moved) this.announce('Brought forward');
    return moved;
  }

  /** One step backward: below the nearest object the selection overlaps. */
  sendBackward() {
    const moved = this.restack(planStep(this.store.ordered(), this.selection, -1, (a, b) => this.overlap(a, b)));
    if (moved) this.announce('Sent backward');
    return moved;
  }

  private overlap(a: Obj, b: Obj): boolean {
    const layout = this.r.connectorLayout();
    const geometry = (o: Obj) => this.store.geometry(o);
    const ra = objBounds((id) => this.store.get(id), a, layout, geometry);
    const rb = objBounds((id) => this.store.get(id), b, layout, geometry);
    return !!ra && !!rb && rectsIntersect(ra, rb);
  }

  bringToFront() {
    if (!this.selection.length) return;
    this.store.undo.stopCapturing();
    this.store.bringToFront(this.selection);
    this.store.undo.stopCapturing();
    if (this.selection.length) this.announce('Brought to front');
  }

  sendToBack() {
    if (!this.selection.length) return;
    this.store.undo.stopCapturing();
    this.store.sendToBack(this.selection);
    this.store.undo.stopCapturing();
    if (this.selection.length) this.announce('Sent to back');
  }

  updateSelected(patch: Record<string, unknown>, filter?: (o: Obj) => boolean) {
    this.store.undo.stopCapturing();
    this.store.transact(() => {
      for (const o of this.selected()) {
        if (filter && !filter(o)) continue;
        this.writeStyle(o, patch);
      }
    });
  }

  updateSelectedLeaves(patch: Record<string, unknown>, filter?: (o: Obj) => boolean) {
    this.store.undo.stopCapturing();
    this.store.transact(() => {
      for (const o of this.selectedLeaves()) {
        if (filter && !filter(o)) continue;
        this.writeStyle(o, patch);
      }
    });
  }

  /** One object's style change, with the size it implies: a text box's height, a class's header. */
  private writeStyle(o: Obj, patch: Record<string, unknown>) {
    this.store.update(o.id, patch);
    if (o.type === 'text' && ('fontSize' in patch || 'font' in patch || 'fontWeight' in patch)) {
      this.store.update(o.id, { h: textHeight({ ...o, ...patch } as BaseObj) });
    }
    if (o.type === 'uml-class' && 'stereotype' in patch) {
      this.store.update(o.id, { h: classHeight({ ...o, ...patch } as BaseObj) });
    }
  }

  align(mode: 'left' | 'centerH' | 'right' | 'top' | 'middleV' | 'bottom') {
    const boxes = this.selected().filter(isBox).filter((o) => !this.store.isLaidOut(o));
    if (boxes.length < 2) return;
    const b = this.r.contentBounds(boxes.map((o) => o.id))!;
    this.store.transact(() => {
      for (const o of boxes) {
        const ob = boxBounds(this.store.placed(o));
        let dx = 0, dy = 0;
        if (mode === 'left') dx = b.x - ob.x;
        if (mode === 'right') dx = b.x + b.w - (ob.x + ob.w);
        if (mode === 'centerH') dx = b.x + b.w / 2 - (ob.x + ob.w / 2);
        if (mode === 'top') dy = b.y - ob.y;
        if (mode === 'bottom') dy = b.y + b.h - (ob.y + ob.h);
        if (mode === 'middleV') dy = b.y + b.h / 2 - (ob.y + ob.h / 2);
        this.store.update(o.id, { x: o.x + dx, y: o.y + dy });
      }
    });
  }

  distribute(axis: 'h' | 'v') {
    const boxes = this.selected().filter(isBox).filter((o) => !this.store.isLaidOut(o));
    if (boxes.length < 3) return;
    const key = axis === 'h' ? 'x' : 'y';
    const size = axis === 'h' ? 'w' : 'h';
    const bounds = (o: BaseObj) => boxBounds(this.store.placed(o));
    const sorted = [...boxes].sort((a, b) => bounds(a)[key] - bounds(b)[key]);
    const first = bounds(sorted[0]), last = bounds(sorted[sorted.length - 1]);
    const total = sorted.reduce((s, o) => s + bounds(o)[size], 0);
    const gap = (last[key] + last[size] - first[key] - total) / (sorted.length - 1);
    let cur = first[key];
    this.store.transact(() => {
      for (const o of sorted) {
        const ob = bounds(o);
        this.store.update(o.id, { [key]: o[key] + (cur - ob[key]) });
        cur += ob[size] + gap;
      }
    });
  }

  toggleLock() {
    if (!this.selection.length) return;
    const lock = !this.selected().every((o) => o.locked);
    this.updateSelected({ locked: lock || undefined });
    this.store.undo.stopCapturing();
    if (lock) {
      this.setSelection([]);
      this.notify('Locked. Long-press to unlock.');
    }
  }

  // ---------------------------------------------------------------- layers (TAB-198)

  /** Hides or shows objects for everyone, as one undo step. A hidden object leaves the selection. */
  setHidden(ids: Iterable<Id>, hidden: boolean) {
    if (this.readOnly) return;
    const list = [...ids].filter((id) => this.store.get(id));
    if (!list.length) return;
    this.store.undo.stopCapturing();
    this.store.transact(() => list.forEach((id) => this.store.update(id, { hidden: hidden || undefined })));
    if (hidden) this.setSelection(this.selection.filter((id) => !list.includes(id)));
  }

  /** Locks or unlocks one object, as the panel's lock toggle does (the selection's own toggle is toggleLock). */
  setLocked(id: Id, locked: boolean) {
    if (this.readOnly || !this.store.get(id)) return;
    this.store.undo.stopCapturing();
    this.store.transact(() => this.store.update(id, { locked: locked || undefined }));
    this.store.undo.stopCapturing();
    if (locked) this.setSelection(this.selection.filter((s) => s !== id));
  }

  /** The name the layers panel shows (a frame's title); undefined clears it. */
  rename(id: Id, name: string | undefined) {
    if (this.readOnly || !this.store.get(id)) return;
    this.store.undo.stopCapturing();
    this.store.transact(() => this.store.update(id, { name }));
  }

  /** Writes stacking keys from the layers panel as one undo step. */
  restack(patches: { id: Id; z: string }[] | null): boolean {
    this.store.undo.stopCapturing();
    const changed = this.store.restack(patches);
    this.store.undo.stopCapturing();
    return changed;
  }

  // ---------------------------------------------------------------- presence

  private bindPresence() {
    const aw = this.conn.awareness;
    const render = () => {
      const remote: { ids: Id[]; color: string }[] = [];
      const cursors: { id: number; name: string; guest: boolean; color: string; p: Point }[] = [];
      aw.getStates().forEach((st, clientId) => {
        if (clientId === aw.clientID || !st.user) return;
        if (Array.isArray(st.sel) && st.sel.length) remote.push({ ids: st.sel, color: personColor(st.user.color) });
        if (st.cursor) cursors.push({ id: clientId, name: st.user.name, guest: st.user.guest === true, color: personColor(st.user.color), p: st.cursor });
      });
      this.r.setOverlay({ remote });
      this.renderCursors(cursors);
      this.emit('presence');
    };
    aw.on('change', render);
    this.r.onCamera(render);
  }

  private cursorEls = new Map<number, HTMLDivElement>();
  private renderCursors(cs: { id: number; name: string; guest: boolean; color: string; p: Point }[]) {
    const seen = new Set<number>();
    for (const c of cs) {
      seen.add(c.id);
      let el = this.cursorEls.get(c.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'remote-cursor';
        el.innerHTML = `<svg width="18" height="18" viewBox="0 0 18 18"><path d="M2 1.5l13 6-5.6 1.6L7 15z" fill="currentColor" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
        const label = document.createElement('div');
        label.className = 'remote-cursor-label';
        const name = document.createElement('span');
        name.className = 'remote-cursor-name';
        label.appendChild(name);
        el.appendChild(label);
        this.r.cursorLayer.appendChild(el);
        this.cursorEls.set(c.id, el);
      }
      el.style.color = c.color;
      const label = el.querySelector('.remote-cursor-label')!;
      const name = label.querySelector('.remote-cursor-name') as HTMLSpanElement;
      name.textContent = c.name;
      name.style.background = c.color;
      let guestBadge = label.querySelector('.remote-cursor-guest') as HTMLSpanElement | null;
      if (c.guest && !guestBadge) {
        guestBadge = guestMark('comment-badge comment-guest remote-cursor-guest') as HTMLSpanElement;
        label.appendChild(guestBadge);
      } else if (!c.guest) {
        guestBadge?.remove();
      }
      const s = this.r.toScreen(c.p);
      el.style.transform = `translate(${s.x}px, ${s.y}px)`;
    }
    for (const [id, el] of this.cursorEls) if (!seen.has(id)) { el.remove(); this.cursorEls.delete(id); }
  }

  private broadcastCursor(p: Point) {
    if (this.cursorTimer) return;
    this.cursorTimer = window.setTimeout(() => {
      this.cursorTimer = 0;
      this.conn.awareness.setLocalStateField('cursor', { x: Math.round(this.lastPointer.x), y: Math.round(this.lastPointer.y) });
    }, 50);
    void p;
  }

  /** Remote participants currently in the room. */
  participants(): { clientId: number; user: User; isMe: boolean }[] {
    const out: { clientId: number; user: User; isMe: boolean }[] = [];
    this.conn.awareness.getStates().forEach((st, id) => {
      if (st.user) out.push({ clientId: id, user: { ...st.user, color: personColor(st.user.color) }, isMe: id === this.conn.awareness.clientID });
    });
    return out;
  }

  followUser(clientId: number) {
    const st = this.conn.awareness.getStates().get(clientId);
    if (st?.cursor) this.r.flyToCenter(st.cursor, this.zoom);
  }

  onDestroy(fn: () => void) {
    this.disposers.push(fn);
  }

  destroy() {
    this.cancelLongPress();
    this.lifetime.abort();
    this.disposers.forEach((f) => f());
    this.editor.commit();
    this.conn.destroy();
    this.r.root.remove();
  }
}

function resizeCursor(h: HandleId, o: Obj | undefined): string {
  const base: Record<string, number> = { n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315 };
  const deg = (base[h] ?? 0) + (((o as BaseObj)?.rotation || 0) * 180) / Math.PI;
  const k = ((Math.round(deg / 45) % 8) + 8) % 8;
  return ['ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize'][k];
}
