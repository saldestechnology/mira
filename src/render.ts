import type { BaseObj, GridType, Id, Obj, Point, Rect } from './types';
import { isBox, isConnector } from './types';
import { isConnectable } from './connectable';
import { isContainerType, validLabel } from '../shared/containers';
import { lowDetail, type FilterChip } from './ui/kanban-logic';
import type { Store } from './store';
import type { ImageState } from './image-loader';
import { boxBounds, buildConnectorLayout, center, connectorGeom, movedConnectors, objBounds, rectsIntersect, rotate, sideAnchor, type ConnectorLayout } from './geometry';
import { SVG_DEFS, objectMarkup, placeholderZoom, type MarkupCtx } from './markup';
import { clearMeasureCache, escapeXml } from './text';
import { onFontLoaded } from './fonts';
import { USER_COLORS, WIRE } from './palette';
import { safeColor } from '../shared/colors';
import { safeObj } from './safe-obj';
import { ancestorsOf, isGroup } from './groups';
import { PIN_R, pinCenter, pinPath, type PinView } from './pins';
import type { GapMark, Guide, SizeMark } from './guides';

const SVGNS = 'http://www.w3.org/2000/svg';
const SELECTION_WIRE = 'var(--wire)';
const SELECTION_HANDLE_FILL = 'var(--selection-handle-fill)';
const SELECTION_HANDLE_STROKE = 'var(--selection-handle-stroke)';

export interface Camera { x: number; y: number; zoom: number }

export function pinMarkup(p: PinView, at: Point, px: (v: number) => number): string {
  const R = px(PIN_R);
  const c = pinCenter({ x: 0, y: 0 }, R);
  const color = safeColor(p.color, USER_COLORS[0]);
  let body: string;
  if (p.draft) body = `<path d="${pinPath(R)}" fill="${color}" stroke="#18212B" stroke-width="${px(1.5)}" stroke-dasharray="${px(3)} ${px(2)}"/>`;
  else if (p.resolved) body = `<path d="${pinPath(R)}" fill="${color}" fill-opacity="0.35" stroke="${color}" stroke-width="${px(1.5)}"/>`;
  else body = `<path d="${pinPath(R)}" fill="${color}" stroke="#fff" stroke-width="${px(1.5)}"/>`;
  // A faded pin is pale, so its label takes the dark ink for contrast.
  const ink = p.draft || p.resolved ? '#18212B' : '#fff';
  const ring = p.selected ? `<circle cx="${c.x}" cy="${c.y}" r="${px(PIN_R + 3)}" fill="none" stroke="${WIRE}" stroke-width="${px(2)}"/>` : '';
  const label = `<text x="${c.x}" y="${c.y + px(4)}" font-size="${px(11)}" font-weight="700" fill="${ink}" text-anchor="middle" font-family="Switzer, system-ui, sans-serif">${escapeXml(p.label)}</text>`;
  let badge = '';
  if (p.count > 1) {
    const bx = c.x + R * Math.SQRT1_2, by = c.y - R * Math.SQRT1_2;
    badge = `<circle cx="${bx}" cy="${by}" r="${px(7)}" fill="#18212B"/><text x="${bx}" y="${by + px(3.2)}" font-size="${px(9)}" font-weight="700" fill="#fff" text-anchor="middle" font-family="Switzer, system-ui, sans-serif">${p.count}</text>`;
  }
  const x = typeof at.x === 'number' && Number.isFinite(at.x) ? at.x : 0;
  const y = typeof at.y === 'number' && Number.isFinite(at.y) ? at.y : 0;
  return `<g transform="translate(${x} ${y})">${ring}${body}${label}${badge}</g>`;
}

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rot' | 'from' | 'to';

export interface Handle { id: HandleId; p: Point }

export interface RemoteSel { ids: Id[]; color: string }

export interface Overlay {
  selection: Id[];
  enteredGroup: Id | null;
  hover: Id | null;
  lockedHover: Id | null;
  anchorsFor: Id | null;
  anchorHot: string | null;     // `${id}:${side}` under the pointer
  marquee: Rect | null;
  guides: Guide[];
  preview: string;              // world-space markup of an object being drawn
  remote: RemoteSel[];
  votes: Map<Id, { mine: number; total: number | null }>;
  votable: Set<Id>;             // what a dot may go on in the running vote, ringed faintly for the people voting (TAB-232)
  dropTarget: Id | null;        // frame highlighted while dragging into it
  ai: string;                   // world-space markup of the AI previews on the board (ghosts), above the objects and below selections
  kanban: KanbanOverlay | null; // card drag and keyboard move marks (docs/kanban.md)
}

/** What a kanban card drag or keyboard move draws over the board, in world coordinates. */
export interface KanbanOverlay {
  /** The 2px drop line with square ends. */
  line?: Rect | null;
  /** A lane dragged by its header: where it came from (a dashed outline) and the vertical drop line between lanes. */
  laneFrom?: Rect | null;
  laneLine?: Rect | null;
  /** A card being moved by keyboard: a ring 4px out and the "Moving" tag. */
  moving?: Rect | null;
  /** A block lane that refuses the cards dragged over it: its body outlined in dashed danger, and the "Full" label at `at`. */
  full?: { body: Rect; at: Point; text: string } | null;
}

/** Kanban state the drawing of lanes and cards depends on (docs/kanban.md, Dragging and Adding a card). */
export interface KanbanDrawState {
  dragging: ReadonlySet<Id>;
  dropLane: Id | null;
  addingLane: Id | null;
  /** The kanban control whose menu or popover is open (docs/kanban.md, slice 4), drawn pressed. */
  open?: { id: Id; kind: 'menu' | 'filter' } | null;
}

export const emptyOverlay = (): Overlay => ({
  selection: [], enteredGroup: null, hover: null, lockedHover: null, anchorsFor: null, anchorHot: null, marquee: null,
  guides: [], preview: '', remote: [], votes: new Map(), votable: new Set(), dropTarget: null, ai: '', kanban: null,
});

/**
 * The ring round an item a dot may go on (TAB-238): the theme's ink at 70% over a halo in the canvas colour, so it reads on every theme (Matrix included) and over busy content.
 * Every length goes through `px`, so the line is as thick and as dashed at 11% zoom as at 100%.
 */
export function votableOutline(b: { x: number; y: number; w: number; h: number }, px: (v: number) => number): string {
  const rect = (grow: number) => `x="${b.x - px(grow)}" y="${b.y - px(grow)}" width="${b.w + px(grow * 2)}" height="${b.h + px(grow * 2)}" rx="${px(6)}" fill="none"`;
  return `<rect ${rect(3)} stroke="var(--canvas, #EEF1F4)" stroke-opacity="0.8" stroke-width="${px(4)}" pointer-events="none"/>` +
    `<rect ${rect(3)} stroke="var(--canvas-ink, #18212B)" stroke-opacity="0.7" stroke-width="${px(2)}" stroke-dasharray="${px(5)} ${px(3)}" pointer-events="none"/>`;
}

const GUIDE = 'var(--guide, #D6247F)';

/** A number for an attribute: guides and gaps are measured from stored geometry, which may not be numbers (TAB-203). */
const fin = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Gap or size bracket with end ticks and a canvas-coloured label pill. */
function gapMarkup(raw: GapMark | SizeMark, px: (v: number) => number, prefix = ''): string {
  const g = { ...raw, from: fin(raw.from), to: fin(raw.to), at: fin(raw.at), label: escapeXml(`${prefix}${String(raw.label)}`) };
  const horizontal = g.axis === 'x';
  const mid = (g.from + g.to) / 2;
  const tick = px(4);
  const a = horizontal ? { x: g.from, y: g.at } : { x: g.at, y: g.from };
  const b = horizontal ? { x: g.to, y: g.at } : { x: g.at, y: g.to };
  const ticks = horizontal
    ? `M${a.x} ${a.y - tick}V${a.y + tick}M${b.x} ${b.y - tick}V${b.y + tick}`
    : `M${a.x - tick} ${a.y}H${a.x + tick}M${b.x - tick} ${b.y}H${b.x + tick}`;
  const c = horizontal ? { x: mid, y: g.at } : { x: g.at, y: mid };
  const w = px(12 + g.label.length * 7), h = px(16);
  return `<g><path d="M${a.x} ${a.y}L${b.x} ${b.y}${ticks}" stroke="${GUIDE}" stroke-width="${px(1)}" fill="none"/>` +
    `<rect x="${c.x - w / 2}" y="${c.y - h / 2}" width="${w}" height="${h}" rx="${px(8)}" fill="var(--canvas, #EEF1F4)" stroke="${GUIDE}" stroke-width="${px(1)}"/>` +
    `<text x="${c.x}" y="${c.y + px(4)}" font-size="${px(11)}" font-weight="600" fill="var(--canvas-ink, #18212B)" text-anchor="middle" font-family="Switzer, system-ui, sans-serif">${g.label}</text></g>`;
}

/** Equal-size brackets use a leading equals sign to distinguish them from gap distances. */
function sizeMarkup(raw: SizeMark, px: (v: number) => number): string {
  return gapMarkup(raw, px, '= ');
}

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 32;

/** Handles for a single selected object, in world coordinates. */
export function handlesFor(o: Obj, get: (id: string) => Obj | undefined, zoom: number, layout?: ConnectorLayout): Handle[] {
  if (o.type === 'group') return [];
  if (isConnector(o)) {
    const g = connectorGeom(get, o, layout);
    return g ? [{ id: 'from', p: g.start }, { id: 'to', p: g.end }] : [];
  }
  // a container's size, and where its lanes and cards are, come from its layout: there is nothing to resize or turn
  if (o.locked || o.type === 'path' || isContainerType(o.type)) return [];
  const c = center(o);
  const r = o.rotation || 0;
  const L = (x: number, y: number) => rotate({ x: o.x + x, y: o.y + y }, c, r);
  const all: Handle[] = [
    { id: 'nw', p: L(0, 0) }, { id: 'n', p: L(o.w / 2, 0) }, { id: 'ne', p: L(o.w, 0) },
    { id: 'e', p: L(o.w, o.h / 2) }, { id: 'se', p: L(o.w, o.h) }, { id: 's', p: L(o.w / 2, o.h) },
    { id: 'sw', p: L(0, o.h) }, { id: 'w', p: L(0, o.h / 2) },
  ];
  let hs = all;
  // a text: the sides change the wrap width, the corners scale the type (src/text-resize.ts); its height follows its lines
  if (o.type === 'text') hs = all.filter((h) => h.id === 'e' || h.id === 'w' || h.id.length === 2);
  if (o.type === 'uml-initial' || o.type === 'uml-final') hs = all.filter((h) => h.id.length === 2);
  if (o.type !== 'frame' && o.type !== 'tracker' && o.type !== 'uml-lifeline' && o.type !== 'uml-package') {
    hs = [...hs, { id: 'rot', p: L(o.w / 2, -24 / zoom) }];
  }
  return hs;
}

export class Renderer {
  readonly root: HTMLDivElement;
  readonly svg: SVGSVGElement;
  readonly world: SVGGElement;
  private objLayer: SVGGElement;
  private groupDimLayer: SVGGElement;
  private groupDimPath: SVGPathElement;
  private overlayLayer: SVGGElement;
  private ghostLayer: SVGGElement;
  private gridRect: SVGRectElement;
  private gridDefs: SVGDefsElement;
  readonly cursorLayer: HTMLDivElement;

  cam: Camera = { x: -200, y: -120, zoom: 1 };
  overlay: Overlay = emptyOverlay();
  pins: PinView[] = [];
  private promotedPinIds = new Set<string>();
  private pinListeners = new Set<() => void>();
  editingId: string | null = null;
  isHidden: (o: BaseObj) => boolean = () => false;
  /** What there is to draw for an image object (src/image-loader.ts); until set, an image shows its placeholder. */
  imageState: (o: BaseObj) => ImageState = () => ({ kind: 'loading' });
  /** Read-only boards show the selection outline but no handles, since they cannot be dragged. */
  readOnly = false;
  gridType: GridType = 'dots';
  gridSize = 24;
  /** The person colour of a card's owner when this viewer knows the owner; set by the app. */
  ownerColor: (o: BaseObj) => string | undefined = () => undefined;
  /** How many comments an object has, for the count on a card; set by the app. */
  commentCount: (id: Id) => number = () => 0;
  /**
   * This viewer's filter chips on a kanban, and whether it dims a card; set by the app (docs/kanban.md, Filters). Null,
   * as in a renderer that is not the board's own (the version preview), draws no Filter button.
   */
  filterChips: (containerId: Id) => FilterChip[] | null = () => null;
  dimmed: (card: BaseObj) => boolean = () => false;
  private kanbanState: KanbanDrawState = { dragging: new Set(), dropLane: null, addingLane: null };
  // the container each drawn lane or card belonged to, so a card that leaves a lane redraws the lane it left
  private kanbanOf = new Map<Id, Id>();
  // where each lane and card was last drawn, for the 120 ms tween when the layout moves it
  private drawnAt = new Map<Id, Point>();

  private els = new Map<Id, SVGGElement>();
  private dirty = new Set<Id>();
  private allDirty = true;
  private boundsCache = new Map<Id, Rect | null>();
  private layoutCache: ConnectorLayout | null = null;
  private lastLayout: ConnectorLayout | null = null;
  private frameQueued = false;
  private destroyed = false;
  private stopFonts: () => void = () => {};
  private resizeObserver: ResizeObserver;
  private overlayDirty = true;
  private camDirty = true;
  private cameraListeners = new Set<() => void>();
  readonly ctx: MarkupCtx;
  /** An object as drawn, read through safeObj (src/safe-obj.ts). */
  private readonly safeGet = (id: string): Obj | undefined => {
    const o = this.store.getPlaced(id);
    return o && safeObj(o);
  };

  constructor(private store: Store, parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'board-surface';
    // the board's main landmark (the canvas is its only content; there is no skip link until the canvas has tab stops of its own)
    this.root.setAttribute('role', 'main');
    this.svg = document.createElementNS(SVGNS, 'svg') as SVGSVGElement;
    this.svg.classList.add('canvas');
    this.svg.setAttribute('role', 'application');
    this.svg.setAttribute('aria-label', 'Whiteboard canvas');
    this.svg.innerHTML = `<defs>${SVG_DEFS}</defs><defs class="grid-defs"></defs><rect class="grid-bg" x="0" y="0" width="100%" height="100%" fill="url(#grid-pattern)"/><g class="world"><g class="objects"></g><g class="group-dim-layer"></g><g class="overlay"></g><g class="k-ghost-layer"></g></g>`;
    this.gridDefs = this.svg.querySelector('.grid-defs')!;
    this.gridRect = this.svg.querySelector('.grid-bg')!;
    this.world = this.svg.querySelector('.world')!;
    this.objLayer = this.svg.querySelector('.objects')!;
    this.groupDimLayer = this.svg.querySelector('.group-dim-layer')!;
    this.groupDimPath = document.createElementNS(SVGNS, 'path') as SVGPathElement;
    this.groupDimPath.setAttribute('class', 'group-dim-wash');
    this.groupDimPath.setAttribute('fill', 'var(--group-dim)');
    this.groupDimPath.setAttribute('fill-rule', 'evenodd');
    this.groupDimPath.setAttribute('pointer-events', 'none');
    this.groupDimLayer.appendChild(this.groupDimPath);
    this.overlayLayer = this.svg.querySelector('.overlay')!;
    this.ghostLayer = this.svg.querySelector('.k-ghost-layer')!;
    this.cursorLayer = document.createElement('div');
    this.cursorLayer.className = 'cursor-layer';
    this.root.append(this.svg, this.cursorLayer);
    parent.appendChild(this.root);

    this.ctx = {
      get: (id) => this.store.getPlaced(id),
      isHidden: (o) => this.isHidden(o),
      imageState: (o) => this.imageState(o),
      editingId: null,
      layout: () => this.connectorLayout(),
      containerLayout: (id) => this.store.containerLayout(id),
      dragging: (id) => this.kanbanState.dragging.has(id),
      // a value under another label's key is not that label (src/labels.ts)
      label: (id) => { const l = validLabel(this.store.labels.get(id)); return l && l.id === id ? l : undefined; },
      ownerColor: (o) => this.ownerColor(o),
      commentCount: (id) => this.commentCount(id),
      filterChips: (id) => this.filterChips(id),
      dimmed: (o) => this.dimmed(o),
    };
    // live values, read at each draw (an export spreads the ctx and so takes them as they are then)
    Object.defineProperties(this.ctx, {
      zoom: { get: () => this.cam.zoom, enumerable: true },
      dropLane: { get: () => this.kanbanState.dropLane, enumerable: true },
      addingLane: { get: () => this.kanbanState.addingLane, enumerable: true },
      openControl: { get: () => this.kanbanState.open ?? null, enumerable: true },
      editable: { get: () => !this.readOnly, enumerable: true },
    });

    store.onChange((changed) => {
      this.layoutCache = null;
      for (const id of changed) {
        this.markDirty(id);
        for (const c of store.connectorsOf(id)) this.markDirty(c.id);
        this.markKanban(id);
      }
      this.overlayDirty = true;
      this.schedule();
    });
    this.stopFonts = onFontLoaded(() => {
      clearMeasureCache();
      this.invalidateAll();
    });
    this.resizeObserver = new ResizeObserver(() => {
      this.camDirty = true;
      this.schedule();
    });
    this.resizeObserver.observe(this.root);
  }

  /** For renderers that are not the board's own (the version preview): stop listening and leave the page. */
  destroy() {
    this.destroyed = true;
    this.stopFonts();
    this.resizeObserver.disconnect();
    this.cameraListeners.clear();
    this.pinListeners.clear();
    this.root.remove();
  }

  markDirty(id: Id) {
    this.dirty.add(id);
    this.boundsCache.delete(id);
  }

  /**
   * A change inside a kanban changes what its lanes and its header say (counts, the add-card row, "No cards"), not only
   * the rectangles the store reports as moved: redraw the container and its lanes, now and where the object was before.
   */
  private markKanban(id: Id) {
    const o = this.store.get(id);
    const before = this.kanbanOf.get(id);
    let now: Id | undefined;
    if (o?.type === 'container') now = o.id;
    else if (o?.type === 'lane') now = o.parent;
    else if (o?.type === 'card') {
      const lane = this.store.get(o.parent);
      now = lane?.type === 'lane' ? lane.parent : undefined;
    }
    if (now) this.kanbanOf.set(id, now);
    else this.kanbanOf.delete(id);
    for (const cid of new Set([before, now])) {
      if (!cid) continue;
      this.markDirty(cid);
      for (const lane of this.store.containerLayout(cid)?.lanes ?? []) this.markDirty(lane);
    }
    // a lane's cards draw from its fields too (a done stage changes their due chips): redraw them with it
    if (o?.type === 'lane' && now) for (const card of this.store.containerLayout(now)?.cards.get(o.id) ?? []) this.markDirty(card);
  }

  /** Redraws a kanban with its lanes and cards: this viewer's filter on it changed (nothing in the board did). */
  invalidateKanban(containerId: Id) {
    const layout = this.store.containerLayout(containerId);
    this.markDirty(containerId);
    for (const id of layout?.order ?? []) this.markDirty(id);
    this.schedule();
  }

  /** Changes what a drag or the inline add-card input shows in the board's own drawing, redrawing only what it touches. */
  setKanbanState(patch: Partial<KanbanDrawState>) {
    const prev = this.kanbanState;
    const next = { ...prev, ...patch };
    for (const id of new Set([...prev.dragging, ...next.dragging])) if (prev.dragging.has(id) !== next.dragging.has(id)) this.markDirty(id);
    for (const id of [prev.dropLane, next.dropLane, prev.addingLane, next.addingLane, prev.open?.id, next.open?.id]) if (id) this.markDirty(id);
    this.kanbanState = next;
    this.schedule();
  }

  /**
   * The card under the pointer while it is dragged: `markup` in the card's own coordinates, placed at `at`. Its own layer,
   * so that the lift plays once when it appears and moving it is one attribute. Null removes it.
   */
  setGhost(markup: string | null, at?: Point) {
    if (markup === null) {
      delete this.ghostLayer.dataset.markup;
      this.ghostLayer.innerHTML = '';
      this.ghostLayer.removeAttribute('transform');
      return;
    }
    if (this.ghostLayer.dataset.markup !== markup) {
      this.ghostLayer.dataset.markup = markup;
      this.ghostLayer.innerHTML = `<g class="k-ghost" aria-hidden="true">${markup}</g>`;
    }
    if (at) this.ghostLayer.setAttribute('transform', `translate(${at.x} ${at.y})`);
  }

  /** Moves the drag ghost so that its top-left is at `at`. */
  moveGhost(at: Point) {
    this.ghostLayer.setAttribute('transform', `translate(${at.x} ${at.y})`);
  }

  /** Redraws these objects at the next frame (an image whose bytes arrived). */
  invalidateObjects(ids: Iterable<Id>) {
    for (const id of ids) this.markDirty(id);
    this.schedule();
  }

  invalidateAll() {
    this.allDirty = true;
    this.layoutCache = null;
    this.boundsCache.clear();
    this.overlayDirty = true;
    this.schedule();
  }

  onCamera(fn: () => void) {
    this.cameraListeners.add(fn);
    return () => this.cameraListeners.delete(fn);
  }

  setCamera(c: Partial<Camera>) {
    const low = lowDetail(this.cam.zoom);
    const step = placeholderZoom(this.cam.zoom);
    this.cam = { ...this.cam, ...c };
    this.cam.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.cam.zoom));
    // a kanban draws differently below zoom 0.4, so crossing it redraws what is on screen of every kanban
    if (lowDetail(this.cam.zoom) !== low) {
      for (const id of this.els.keys()) if (isContainerType(this.store.get(id)?.type ?? '')) this.markDirty(id);
    }
    // a placeholder's label keeps 12 px on screen, so it is drawn again when the zoom moves to another step
    if (placeholderZoom(this.cam.zoom) !== step) {
      for (const id of this.els.keys()) {
        const o = this.store.get(id);
        if (o?.type === 'image' && this.imageState(o).kind !== 'ok') this.markDirty(id);
      }
    }
    this.camDirty = true;
    this.overlayDirty = true;
    this.schedule();
    this.cameraListeners.forEach((l) => l());
  }

  setOverlay(patch: Partial<Overlay>) {
    Object.assign(this.overlay, patch);
    this.overlayDirty = true;
    this.schedule();
  }

  setPins(pins: PinView[]) {
    this.pins = pins;
    this.overlayDirty = true;
    this.schedule();
    for (const listener of this.pinListeners) listener();
  }

  onPins(listener: () => void): () => void {
    this.pinListeners.add(listener);
    return () => this.pinListeners.delete(listener);
  }

  setPromotedPinIds(ids: Iterable<string>) {
    const next = new Set(ids);
    if (next.size === this.promotedPinIds.size && [...next].every((id) => this.promotedPinIds.has(id))) return;
    this.promotedPinIds = next;
    this.overlayDirty = true;
    this.schedule();
  }

  setEditing(id: string | null) {
    const prev = this.editingId;
    this.editingId = id;
    this.ctx.editingId = id;
    if (prev) this.markDirty(prev);
    if (id) this.markDirty(id);
    this.overlayDirty = true;
    this.schedule();
  }

  size() {
    const r = this.root.getBoundingClientRect();
    return { w: r.width || 1, h: r.height || 1, left: r.left, top: r.top };
  }

  toWorld(sx: number, sy: number): Point {
    return { x: sx / this.cam.zoom + this.cam.x, y: sy / this.cam.zoom + this.cam.y };
  }

  toScreen(p: Point): Point {
    return { x: (p.x - this.cam.x) * this.cam.zoom, y: (p.y - this.cam.y) * this.cam.zoom };
  }

  /** Client (event) coordinates to world coordinates. */
  clientToWorld(cx: number, cy: number): Point {
    const s = this.size();
    return this.toWorld(cx - s.left, cy - s.top);
  }

  viewport(): Rect {
    const s = this.size();
    return { x: this.cam.x, y: this.cam.y, w: s.w / this.cam.zoom, h: s.h / this.cam.zoom };
  }

  zoomAt(screen: Point, factor: number) {
    const before = this.toWorld(screen.x, screen.y);
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.cam.zoom * factor));
    this.setCamera({ zoom, x: before.x - screen.x / zoom, y: before.y - screen.y / zoom });
  }

  /** Screen area covered by floating chrome; fitting keeps content clear of it. */
  insets = { top: 64, right: 16, bottom: 72, left: 80 };

  private fitCam(r: Rect, pad: number, maxZoom: number): Camera {
    const s = this.size();
    const i = this.insets;
    const aw = Math.max(80, s.w - i.left - i.right - pad * 2);
    const ah = Math.max(80, s.h - i.top - i.bottom - pad * 2);
    const zoom = Math.min(maxZoom, Math.max(MIN_ZOOM, Math.min(aw / Math.max(r.w, 1), ah / Math.max(r.h, 1))));
    const cx = i.left + pad + aw / 2, cy = i.top + pad + ah / 2;
    return { zoom, x: r.x + r.w / 2 - cx / zoom, y: r.y + r.h / 2 - cy / zoom };
  }

  /** Fit a world rect into view with padding (screen px). */
  fit(r: Rect, pad = 80, maxZoom = 2) {
    this.setCamera(this.fitCam(r, pad, maxZoom));
  }

  /** Smoothly animate the camera to fit a rect. */
  flyTo(r: Rect, pad = 80, maxZoom = 1.5) {
    this.flyToCamera(this.fitCam(r, pad, maxZoom));
  }

  /** Smoothly centre the view on a world point at a zoom level. */
  flyToCenter(p: Point, zoom: number) {
    const s = this.size();
    this.flyToCamera({ zoom, x: p.x - s.w / 2 / zoom, y: p.y - s.h / 2 / zoom });
  }

  flyToCamera(target: Camera) {
    const start = { ...this.cam };
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return this.setCamera(target);
    const t0 = performance.now(), dur = 420;
    const s = this.size();
    const cx0 = start.x + s.w / 2 / start.zoom, cy0 = start.y + s.h / 2 / start.zoom;
    const cx1 = target.x + s.w / 2 / target.zoom, cy1 = target.y + s.h / 2 / target.zoom;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / dur);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      // interpolate zoom geometrically for a natural feel
      const zoom = start.zoom * Math.pow(target.zoom / start.zoom, e);
      const cx = cx0 + (cx1 - cx0) * e, cy = cy0 + (cy1 - cy0) * e;
      this.setCamera({ zoom, x: cx - s.w / 2 / zoom, y: cy - s.h / 2 / zoom });
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /**
   * Where each connector end sits among the ends on the same side of its shape. Built on first use after a store change
   * and reused until the next one, so drawing, hit-testing and handles all read the same layout.
   */
  connectorLayout(): ConnectorLayout {
    if (!this.layoutCache) {
      const next = buildConnectorLayout(this.safeGet, this.store.shown().filter(isConnector).map(safeObj));
      // A connector that joins, leaves or reorders a side moves the others on it, even though they did not change.
      if (this.lastLayout) for (const id of movedConnectors(this.lastLayout, next)) this.markDirty(id);
      this.layoutCache = this.lastLayout = next;
    }
    return this.layoutCache;
  }

  bounds(o: Obj): Rect | null {
    this.connectorLayout(); // first, so connectors whose slot moved lose their cached bounds
    if (this.boundsCache.has(o.id)) return this.boundsCache.get(o.id)!;
    const b = objBounds(this.safeGet, safeObj(this.store.placed(o)), this.connectorLayout(), (obj) => this.store.geometry(obj));
    this.boundsCache.set(o.id, b);
    return b;
  }

  contentBounds(ids?: Iterable<Id>): Rect | null {
    let rs: Rect[] = [];
    const list = ids ? [...ids].map((id) => this.store.get(id)).filter(Boolean) as Obj[] : this.store.shown();
    for (const o of list) {
      const b = this.bounds(o);
      if (b) rs.push(b);
    }
    if (!rs.length) return null;
    const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y));
    const x1 = Math.max(...rs.map((r) => r.x + r.w)), y1 = Math.max(...rs.map((r) => r.y + r.h));
    rs = [];
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  schedule() {
    if (this.frameQueued || this.destroyed) return;
    this.frameQueued = true;
    requestAnimationFrame(() => {
      this.frameQueued = false;
      if (!this.destroyed) this.flush();
    });
  }

  /** Render synchronously (used before export or measuring). */
  flush() {
    if (this.camDirty) this.applyCamera();
    this.renderObjects();
    if (this.overlayDirty) this.renderOverlay();
  }

  private applyCamera() {
    const { x, y, zoom } = this.cam;
    this.world.setAttribute('transform', `matrix(${zoom} 0 0 ${zoom} ${-x * zoom} ${-y * zoom})`);
    this.renderGrid();
    this.camDirty = false;
    this.root.style.setProperty('--zoom', String(zoom));
  }

  private renderGrid() {
    const { x, y, zoom } = this.cam;
    if (this.gridType === 'none') {
      this.gridRect.setAttribute('fill', 'transparent');
      return;
    }
    this.gridRect.setAttribute('fill', 'url(#grid-pattern)');
    // the grid size is board data any collaborator writes: anything but a positive number would never leave the loops below
    let step = typeof this.gridSize === 'number' && Number.isFinite(this.gridSize) && this.gridSize > 0 ? this.gridSize : 24;
    while (step * zoom < 10) step *= 5;
    while (step * zoom > 100 && step / 5 >= 1) step /= 5;
    const s = step * zoom;
    const ox = -x * zoom, oy = -y * zoom;
    const mod = (a: number, m: number) => ((a % m) + m) % m;
    if (this.gridType === 'dots') {
      const r = Math.min(1.6, Math.max(0.8, s / 22));
      this.gridDefs.innerHTML = `<pattern id="grid-pattern" width="${s}" height="${s}" patternUnits="userSpaceOnUse" x="${mod(ox - s / 2, s)}" y="${mod(oy - s / 2, s)}"><circle cx="${s / 2}" cy="${s / 2}" r="${r}" fill="var(--grid-dot)"/></pattern>`;
    } else if (this.gridType === 'lines') {
      const S = s * 5;
      this.gridDefs.innerHTML =
        `<pattern id="grid-minor" width="${s}" height="${s}" patternUnits="userSpaceOnUse" x="${mod(ox, s)}" y="${mod(oy, s)}"><path d="M0 0H${s}M0 0V${s}" fill="none" stroke="var(--grid-line)" stroke-width="1"/></pattern>` +
        `<pattern id="grid-pattern" width="${S}" height="${S}" patternUnits="userSpaceOnUse" x="${mod(ox, S)}" y="${mod(oy, S)}"><rect width="${S}" height="${S}" fill="url(#grid-minor)"/><path d="M0 0H${S}M0 0V${S}" fill="none" stroke="var(--grid-major)" stroke-width="1"/></pattern>`;
    } else {
      const W = s * Math.sqrt(3), H = s;
      this.gridDefs.innerHTML = `<pattern id="grid-pattern" width="${W}" height="${H}" patternUnits="userSpaceOnUse" x="${mod(ox, W)}" y="${mod(oy, H)}"><path d="M0 0L${W} ${H}M0 ${H}L${W} 0M0 0V${H}" fill="none" stroke="var(--grid-line)" stroke-width="1"/></pattern>`;
    }
  }

  private renderObjects() {
    const vp = this.viewport();
    const margin = 200 / this.cam.zoom;
    const view = { x: vp.x - margin, y: vp.y - margin, w: vp.w + margin * 2, h: vp.h + margin * 2 };
    // hidden objects (TAB-198) are not drawn: their nodes go like any culled one
    const ordered = this.store.shown();
    const visible = new Set<Id>();
    let prev: SVGGElement | null = null;
    // containers that moved since the last draw: what they lay out moves with them, without a tween
    const shifted = new Set<Id>();
    for (const raw of ordered) {
      if (raw.type === 'group') continue;
      const o = this.store.placed(raw);
      const b = this.bounds(o);
      if (!b || !rectsIntersect(b, view)) continue;
      visible.add(o.id);
      let el = this.els.get(o.id);
      const fresh = !el;
      if (!el) {
        el = document.createElementNS(SVGNS, 'g') as SVGGElement;
        el.dataset.id = o.id;
        this.els.set(o.id, el);
      }
      if (fresh || this.allDirty || this.dirty.has(o.id)) {
        el.innerHTML = objectMarkup(o, this.ctx);
        if (isContainerType(o.type)) this.tween(el, o, fresh, shifted);
      }
      // keep DOM order equal to paint order
      const expectedNext: ChildNode | null = prev ? prev.nextSibling : this.objLayer.firstChild;
      if (expectedNext !== el) this.objLayer.insertBefore(el, expectedNext);
      prev = el;
    }
    for (const [id, el] of this.els) {
      if (!visible.has(id)) {
        el.remove();
        this.els.delete(id);
        this.drawnAt.delete(id);
      }
    }
    this.dirty.clear();
    this.allDirty = false;
  }

  /**
   * The 120 ms tween of a lane or card the layout moved, from where it was drawn to where it is now (docs/kanban.md,
   * Rendering). Not for what is drawn for the first time, not when its container moved (a container drag moves its
   * contents with it), and never with reduced motion.
   */
  private tween(el: SVGGElement, o: Obj, fresh: boolean, shifted: Set<Id>) {
    const was = this.drawnAt.get(o.id);
    const now = { x: (o as BaseObj).x, y: (o as BaseObj).y };
    this.drawnAt.set(o.id, now);
    if (o.type === 'container') {
      if (was && (was.x !== now.x || was.y !== now.y)) shifted.add(o.id);
      return;
    }
    if (fresh || !was || (was.x === now.x && was.y === now.y)) return;
    const box = this.kanbanOf.get(o.id);
    if (box && shifted.has(box)) return;
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    el.style.transition = 'none';
    el.style.transform = `translate(${was.x - now.x}px, ${was.y - now.y}px)`;
    requestAnimationFrame(() => {
      el.style.transition = 'transform 120ms ease-out';
      el.style.transform = '';
    });
  }

  private renderOverlay() {
    this.overlayDirty = false;
    const z = this.cam.zoom;
    const px = (v: number) => v / z;
    // overlays write object geometry into attributes too: read objects through safeObj (src/safe-obj.ts, TAB-203)
    const get = this.safeGet;
    const ov = this.overlay;
    let out = ov.ai;

    const entered = ov.enteredGroup ? get(ov.enteredGroup) : undefined;
    const enteredBounds = entered?.type === 'group' ? this.bounds(entered) : null;
    if (entered?.type === 'group' && enteredBounds) {
      const v = this.viewport();
      const memberBounds = this.store.descendantsOf(entered.id)
        .filter((member) => member.type !== 'group' && member.type !== 'frame' && member.type !== 'tracker' && isBox(member) && this.store.isShown(member) && !this.isHidden(member))
        .map((member) => this.bounds(member))
        .filter((bounds): bounds is Rect => !!bounds);
      const cutouts = memberBounds.map((b) => `M${b.x} ${b.y}h${b.w}v${b.h}h-${b.w}z`).join(' ');
      this.groupDimPath.setAttribute('d', `M${v.x} ${v.y}h${v.w}v${v.h}h-${v.w}z ${cutouts}`);
      this.groupDimPath.setAttribute('class', 'group-dim-wash active');
      out += this.groupOutline(enteredBounds, px, 'var(--group-line)', 1.5, [6, 4], true);
    } else {
      this.groupDimPath.setAttribute('class', 'group-dim-wash');
    }

    // remote selections
    for (const r of ov.remote) {
      for (const id of r.ids) {
        const o = get(id);
        const b = o && this.bounds(o);
        if (b) out += `<rect x="${b.x - px(3)}" y="${b.y - px(3)}" width="${b.w + px(6)}" height="${b.h + px(6)}" fill="none" stroke="${safeColor(r.color, USER_COLORS[0])}" stroke-width="${px(1.5)}" stroke-dasharray="${px(4)} ${px(3)}" rx="${px(3)}"/>`;
      }
    }

    if (ov.dropTarget) {
      const f = get(ov.dropTarget);
      if (isBox(f)) out += `<rect x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" rx="6" fill="${WIRE}" fill-opacity="0.04" stroke="${WIRE}" stroke-width="${px(2)}"/>`;
    }

    // hover outline
    if (ov.hover && !ov.selection.includes(ov.hover)) {
      const o = get(ov.hover);
      if (o?.type === 'group') {
        const b = this.bounds(o);
        if (b) out += this.groupOutline(b, px, 'var(--group-hover)', 1.5, undefined, true);
      } else if (o) out += this.outline(o, px(1.5), 1, 'var(--group-hover)');
    }
    if (ov.lockedHover) {
      const candidate = get(ov.lockedHover);
      const lockedGroups = candidate ? [candidate, ...ancestorsOf(candidate, get)].filter((o) => isGroup(o) && o.locked) : [];
      const locked = lockedGroups.at(-1) ?? (candidate?.locked ? candidate : undefined);
      const b = locked && this.bounds(locked);
      if (locked && b) {
        if (locked.type === 'group') out += this.groupOutline(b, px, 'var(--group-locked)', 1.5);
        out += this.lockBadge(b, px, locked.type === 'group');
      }
    }

    // selection
    const sel = ov.selection.map(get).filter(Boolean) as Obj[];
    const selectedGroup = sel.length === 1 && sel[0].type === 'group' ? sel[0] : undefined;
    if (selectedGroup) {
      const b = this.bounds(selectedGroup);
      if (b) {
        for (const member of this.store.childrenOf(selectedGroup.id)) {
          if (member.parent === selectedGroup.id) out += this.groupMemberOutline(member, px);
        }
        out += this.groupOutline(b, px, 'var(--group-line)', 1.5, undefined, true);
        // TODO(slice 3): add the whole-group transform handles around this solid box.
      }
    } else {
      // a dragged card's slot is its dashed placeholder, with no selection outline over it
      for (const o of sel) if (!this.kanbanState.dragging.has(o.id)) out += this.outline(o, px(1.5), 1);
      if (sel.length > 1) {
        const b = this.contentBounds(ov.selection);
        if (b) out += `<rect x="${b.x - px(6)}" y="${b.y - px(6)}" width="${b.w + px(12)}" height="${b.h + px(12)}" fill="none" stroke="${SELECTION_WIRE}" stroke-width="${px(1)}" stroke-dasharray="${px(5)} ${px(4)}"/>`;
      }
    }
    if (!selectedGroup && sel.length === 1 && sel[0].id !== this.editingId && !this.readOnly) {
      const o = sel[0];
      const hs = handlesFor(o, get, z, this.connectorLayout());
      const rot = hs.find((h) => h.id === 'rot');
      if (rot && isBox(o)) {
        const top = rotate({ x: o.x + o.w / 2, y: o.y }, center(o), o.rotation || 0);
        out += `<path d="M${top.x} ${top.y}L${rot.p.x} ${rot.p.y}" stroke="${SELECTION_WIRE}" stroke-width="${px(1)}"/>`;
      }
      // on a touch screen the handles are drawn larger (a finger also reaches further to them: app.ts handleAt)
      const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
      const half = px(coarse ? 8 : 4.5);
      for (const h of hs) {
        if (h.id === 'rot') out += `<circle cx="${h.p.x}" cy="${h.p.y}" r="${px(coarse ? 8 : 5)}" fill="${SELECTION_HANDLE_FILL}" stroke="${SELECTION_HANDLE_STROKE}" stroke-width="${px(1.5)}"/>`;
        else if (h.id === 'from' || h.id === 'to') out += `<circle cx="${h.p.x}" cy="${h.p.y}" r="${px(coarse ? 8 : 5.5)}" fill="${SELECTION_HANDLE_FILL}" stroke="${SELECTION_HANDLE_STROKE}" stroke-width="${px(2)}"/>`;
        else out += `<rect x="${h.p.x - half}" y="${h.p.y - half}" width="${half * 2}" height="${half * 2}" rx="${px(2)}" fill="${SELECTION_HANDLE_FILL}" stroke="${SELECTION_HANDLE_STROKE}" stroke-width="${px(1.5)}"/>`;
      }
    }

    // connection anchors on hover
    if (ov.anchorsFor) {
      const o = get(ov.anchorsFor);
      if (isConnectable(o)) {
        for (const side of ['top', 'right', 'bottom', 'left'] as const) {
          const a = sideAnchor(o, side);
          const hot = ov.anchorHot === `${o.id}:${side}`;
          const p = { x: a.p.x + a.dir.x * px(14), y: a.p.y + a.dir.y * px(14) };
          out += `<circle class="anchor" cx="${p.x}" cy="${p.y}" r="${px(hot ? 7 : 5)}" fill="${hot ? SELECTION_WIRE : SELECTION_HANDLE_FILL}" stroke="${SELECTION_WIRE}" stroke-width="${px(1.5)}"/>`;
        }
      }
    }

    // snap guides and equal-gap brackets
    for (const g of ov.guides) out += g.kind === 'line'
      ? `<path d="M${fin(g.x1)} ${fin(g.y1)}L${fin(g.x2)} ${fin(g.y2)}" stroke="${GUIDE}" stroke-width="${px(1)}"/>`
      : g.kind === 'gap' ? gapMarkup(g, px) : sizeMarkup(g, px);

    // drawing preview
    if (ov.preview) out += `<g opacity="0.85">${ov.preview}</g>`;

    // marquee
    if (ov.marquee) {
      const m = ov.marquee;
      out += `<rect x="${m.x}" y="${m.y}" width="${m.w}" height="${m.h}" fill="${WIRE}" fill-opacity="0.06" stroke="${WIRE}" stroke-width="${px(1)}"/>`;
    }

    // what can be voted on, while a vote runs
    for (const id of ov.votable) {
      const o = get(id);
      if (!isBox(o)) continue;
      const b = boxBounds(o);
      out += votableOutline(b, px);
    }

    // vote badges
    for (const [id, v] of ov.votes) {
      const o = get(id);
      if (!isBox(o)) continue;
      const b = boxBounds(o);
      let x = b.x + b.w - px(10);
      const y = b.y + px(10);
      if (v.total !== null && v.total > 0) {
        const label = String(v.total);
        const w = px(14 + label.length * 7);
        out += `<g><rect x="${x - w + px(4)}" y="${y - px(10)}" width="${w}" height="${px(20)}" rx="${px(10)}" fill="#18212B"/><text x="${x - w / 2 + px(4)}" y="${y + px(4.5)}" font-size="${px(12)}" font-weight="700" fill="#FFD23F" text-anchor="middle" font-family="Switzer, system-ui, sans-serif">${label}</text></g>`;
        x -= w + px(4);
      }
      if (v.mine > 0 && v.mine <= 4) {
        for (let i = 0; i < v.mine; i++) {
          out += `<circle cx="${x - i * px(14)}" cy="${y}" r="${px(5.5)}" fill="${WIRE}" stroke="#fff" stroke-width="${px(1.5)}"/>`;
        }
      } else if (v.mine > 4) {
        // Many dots from one person: one pill with a count instead of a long row.
        const label = `${v.mine}`;
        const w = px(26 + label.length * 7);
        out += `<g><rect x="${x - w + px(5.5)}" y="${y - px(9)}" width="${w}" height="${px(18)}" rx="${px(9)}" fill="${WIRE}" stroke="#fff" stroke-width="${px(1.5)}"/>` +
          `<circle cx="${x - w + px(15)}" cy="${y}" r="${px(3.5)}" fill="#fff"/>` +
          `<text x="${x - w + px(22)}" y="${y + px(4.2)}" font-size="${px(12)}" font-weight="700" fill="#fff" font-family="Switzer, system-ui, sans-serif">${label}</text></g>`;
      }
    }

    // kanban: the drop line (2px canvas ink, 8px square ends) and the keyboard move ring and tag
    const k = ov.kanban;
    if (k?.line) {
      const l = k.line;
      const e = px(8);
      out += `<g style="fill:var(--canvas-ink, #18212B)"><rect x="${l.x}" y="${l.y + l.h / 2 - px(1)}" width="${l.w}" height="${px(2)}"/>` +
        `<rect x="${l.x - e / 2}" y="${l.y + l.h / 2 - e / 2}" width="${e}" height="${e}"/><rect x="${l.x + l.w - e / 2}" y="${l.y + l.h / 2 - e / 2}" width="${e}" height="${e}"/></g>`;
    }
    if (k?.laneFrom) {
      const f = k.laneFrom;
      out += `<rect x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" style="fill:none;stroke:var(--canvas-ink, #18212B)" stroke-width="${px(2)}" stroke-dasharray="${px(6)} ${px(4)}"/>`;
    }
    if (k?.laneLine) {
      const l = k.laneLine;
      const e = px(8);
      out += `<g style="fill:var(--canvas-ink, #18212B)"><rect x="${l.x + l.w / 2 - px(1)}" y="${l.y}" width="${px(2)}" height="${l.h}"/>` +
        `<rect x="${l.x + l.w / 2 - e / 2}" y="${l.y - e / 2}" width="${e}" height="${e}"/><rect x="${l.x + l.w / 2 - e / 2}" y="${l.y + l.h - e / 2}" width="${e}" height="${e}"/></g>`;
    }
    if (k?.full) {
      // a block lane at its limit: no drop line, its body outlined in dashed danger and "Full · n / n" (Visual design, States)
      const b = k.full.body;
      out += `<rect x="${b.x + px(1)}" y="${b.y + px(1)}" width="${Math.max(0, b.w - px(2))}" height="${Math.max(0, b.h - px(2))}" style="fill:none;stroke:var(--danger, #D41E24)" stroke-width="${px(2)}" stroke-dasharray="${px(6)} ${px(4)}"/>`;
      const text = k.full.text.toUpperCase();
      const tw = px(text.length * 6.9 + 16);
      out += `<g class="k-full-tag"><rect x="${k.full.at.x - tw / 2}" y="${k.full.at.y}" width="${tw}" height="${px(20)}" style="fill:var(--danger, #D41E24)"/>` +
        `<text x="${k.full.at.x}" y="${k.full.at.y + px(14)}" text-anchor="middle" font-size="${px(11)}" font-weight="600" letter-spacing="${px(0.66)}" style="fill:var(--paper, #FFFFFF)" font-family="Switzer, system-ui, sans-serif">${escapeXml(text)}</text></g>`;
    }
    if (k?.moving) {
      const m = k.moving;
      const g = px(4) + px(1);
      out += `<rect x="${m.x - g}" y="${m.y - g}" width="${m.w + 2 * g}" height="${m.h + 2 * g}" style="fill:none;stroke:var(--canvas-ink, #18212B)" stroke-width="${px(2)}"/>`;
      const text = 'MOVING · ALT + ARROWS';
      const tw = px(text.length * 6.9 + 16);
      // right of the card, or left of it when the view ends there, or above it when neither side has room
      const vp = this.viewport();
      let tx = m.x + m.w + px(8), ty = m.y + m.h / 2 - px(10);
      if (tx + tw > vp.x + vp.w - px(16)) tx = m.x - px(8) - tw;
      if (tx < vp.x + px(16)) {
        tx = Math.max(vp.x, m.x);
        ty = m.y - g - px(24);
      }
      out += `<g class="k-moving-tag"><rect x="${tx}" y="${ty}" width="${tw}" height="${px(20)}" style="fill:var(--signal, #FFD23F)"/>` +
        `<text x="${tx + px(8)}" y="${ty + px(14)}" font-size="${px(11)}" font-weight="600" letter-spacing="${px(0.66)}" style="fill:var(--on-signal, #18212B)" font-family="Switzer, system-ui, sans-serif">${text}</text></g>`;
    }

    // Pins last, so they sit above selections and handles; promoted pins live in the chrome pin layer.
    for (const p of this.pins) if (!this.promotedPinIds.has(p.id)) out += pinMarkup(p, p, px);

    this.overlayLayer.innerHTML = out;
  }

  private groupOutline(b: Rect, px: (v: number) => number, stroke: string, width: number, dash?: [number, number], casing = false) {
    const grow = px(6);
    const dashAttr = dash ? ` stroke-dasharray="${px(dash[0])} ${px(dash[1])}"` : '';
    const rect = `x="${b.x - grow}" y="${b.y - grow}" width="${b.w + grow * 2}" height="${b.h + grow * 2}" fill="none"`;
    const underlay = casing ? `<rect ${rect} stroke="var(--canvas)" stroke-opacity="0.8" stroke-width="${px(2)}" pointer-events="none"/>` : '';
    return underlay + `<rect ${rect} stroke="${stroke}" stroke-width="${px(width)}"${dashAttr} pointer-events="none"/>`;
  }

  private groupMemberOutline(raw: Obj, px: (v: number) => number) {
    if (!this.store.isShown(raw)) return '';
    if (isConnector(raw)) {
      const hiddenEnd = [raw.from, raw.to].some((end) => {
        if (end.kind !== 'bound') return false;
        const target = this.store.get(end.id);
        return !!target && isBox(target) && this.isHidden(target);
      });
      if (hiddenEnd) return '';
      const g = connectorGeom(this.safeGet, safeObj(raw), this.connectorLayout());
      return g ? `<path d="${g.d}" fill="none" stroke="var(--group-member-line)" stroke-width="${px(1)}" pointer-events="none"/>` : '';
    }
    if (isBox(raw) && this.isHidden(raw)) return '';
    if (raw.type === 'group') {
      const b = this.bounds(raw);
      return b ? `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="none" stroke="var(--group-member-line)" stroke-width="${px(1)}" pointer-events="none"/>` : '';
    }
    const o = safeObj(this.store.placed(raw));
    const c = center(o);
    const deg = ((o.rotation || 0) * 180) / Math.PI;
    if (o.type === 'path') {
      const b = boxBounds(o);
      return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="none" stroke="var(--group-member-line)" stroke-width="${px(1)}" pointer-events="none"/>`;
    }
    return `<rect x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" transform="rotate(${deg} ${c.x} ${c.y})" fill="none" stroke="var(--group-member-line)" stroke-width="${px(1)}" pointer-events="none"/>`;
  }

  private lockBadge(b: Rect, px: (v: number) => number, padded: boolean) {
    const right = b.x + b.w + (padded ? px(6) : 0);
    const top = b.y - (padded ? px(6) : 0);
    return `<g transform="translate(${right} ${top})"><circle r="${px(11)}" fill="var(--group-chip-bg)" stroke="var(--group-chip-ink)" stroke-width="${px(1.5)}"/><g transform="translate(${-px(7)} ${-px(7)}) scale(${px(14) / 24})" fill="none" stroke="var(--group-chip-ink)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10.5" width="14" height="10" rx="1.5"/><path d="M8 10.5V7.5a4 4 0 018 0v3"/></g></g>`;
  }

  private outline(raw: Obj, sw: number, opacity: number, stroke = SELECTION_WIRE) {
    const o = safeObj(raw);
    if (isConnector(o)) {
      const g = connectorGeom(this.safeGet, safeObj(o), this.connectorLayout());
      if (!g) return '';
      return `<path d="${g.d}" fill="none" stroke="${stroke}" stroke-width="${sw * 2.5}" stroke-opacity="${0.25 * opacity}"/>`;
    }
    const b = o;
    const c = center(b);
    const deg = ((b.rotation || 0) * 180) / Math.PI;
    if (b.type === 'path') {
      const r = boxBounds(b);
      return `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="none" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}"/>`;
    }
    return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" transform="rotate(${deg} ${c.x} ${c.y})" fill="none" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}"/>`;
  }
}
