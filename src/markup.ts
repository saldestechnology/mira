// Pure SVG markup for board objects. Used by the live renderer and by SVG/PNG export.

import type { BaseObj, ConnectorObj, Obj, Point, VAlign } from './types';
import { sanitizeSvg } from '../shared/svg-safety';
import { FAILED_LABEL, type ImageState } from './image-loader';
import { isConnector } from './types';
import { connectorGeom, pathPoints, type ConnectorLayout } from './geometry';
import { headMarkup, shapeDecor, shapePath, textBox } from './shapes';
import { escapeXml, fitText, fontCss, measure, wrap } from './text';
import { fontFamily } from './fonts';
import { CLASS_HEADER, CLASS_LINE, RELATIONS, memberToString } from './uml';
import { CANVAS_INK, INK, PAPER, STICKY_COLORS, inkOn } from './palette';
import { scopeSvgIds } from './stickers';
import { hasLayout, isSafeHttpUrl, kanbanColor, validLabel, type ContainerLayout, type Rect } from '../shared/containers';
import type { Label } from './types';
import { safeColor } from '../shared/colors';
import { safeObj } from './safe-obj';
import { renderTrackerFrame } from './tracker-frame';
import { linkedCardHeaderMarkup, unmappedStateChipMarkup } from './tracker/ui/linked-card-style';
import type { TrackerPriority, TrackerStateCategory } from './tracker-types';
import { CARD, addRow, cardHeight, dueChip, emptyBox, initials, laneCount, laneMenuRect, localToday, lowDetail, wipFullMessage, type FilterChip } from './ui/kanban-logic';

export interface MarkupCtx {
  get: (id: string) => Obj | undefined;
  /** True when a sticky is hidden from this viewer (private writing, not yet revealed). */
  isHidden?: (o: BaseObj) => boolean;
  /** Object whose label is being edited (label is not drawn). */
  editingId?: string | null;
  /** Where each connector end sits among the ends on the same side of its shape; called only when a connector is drawn. */
  layout?: () => ConnectorLayout;
  /** What there is to draw for an image object: its pixels, or why not yet (src/image-loader.ts). Without it an image draws as its placeholder. */
  imageState?: (o: BaseObj) => ImageState;
  // Kanban (docs/kanban.md). All optional: without them a kanban draws at full detail, with nothing in progress.
  /** The layout of a container, for lane counts and where a lane's add-card row is. */
  containerLayout?: (id: string) => ContainerLayout | null;
  /** The camera zoom: below 0.4 a kanban draws in low detail. */
  zoom?: number;
  /** Cards being dragged here: their slot is a dashed placeholder (the layout does not move while dragging). */
  dragging?: (id: string) => boolean;
  /** The lane a dragged card is over: its "No cards" reads "Drop here". */
  dropLane?: string | null;
  /** Whether lanes offer "+ Add card" (editors only). */
  editable?: boolean;
  /** The lane whose add-card row is the inline input (drawn by the page, not here). */
  addingLane?: string | null;
  /** A board label by id (the `labels` map). */
  label?: (id: string) => Label | undefined;
  /** The person colour for a card's owner, when the owner is someone this viewer knows. */
  ownerColor?: (card: BaseObj) => string | undefined;
  /** Comments on an object, for the count on a card. */
  commentCount?: (id: string) => number;
  /** The viewer's date as YYYY-MM-DD, for due chips; today when absent. */
  today?: string;
  /**
   * This viewer's active filter on a kanban, as the header's chips. Without it (an export) the header draws no Filter
   * button and no chips: a filter is a view, not content (docs/kanban.md, Export).
   */
  filterChips?: (containerId: string) => FilterChip[] | null;
  /** Whether this viewer's filter dims a card to 35% (docs/kanban.md, Filters). Without it nothing is dimmed. */
  dimmed?: (card: BaseObj) => boolean;
  /** The kanban control whose menu or popover is open, drawn pressed. */
  openControl?: { id: string; kind: 'menu' | 'filter' } | null;
}

const n = (v: number) => Math.round(v * 100) / 100;

export const DEFAULTS = {
  shape: { fill: '#FFFFFF', stroke: INK, strokeWidth: 2, textColor: INK, fontSize: 16, fontWeight: 500, align: 'center' as const, valign: 'middle' as const },
  sticky: { fill: '#FFE16B', stroke: 'none', strokeWidth: 0, textColor: '#1D1A12', fontSize: 20, fontWeight: 500, align: 'center' as const, valign: 'middle' as const },
  text: { fill: 'none', stroke: 'none', strokeWidth: 0, textColor: CANVAS_INK, fontSize: 20, fontWeight: 400, align: 'left' as const, valign: 'top' as const },
  frame: { fill: '#FFFFFF', stroke: 'var(--canvas-rule, #C9D1DA)', strokeWidth: 1, textColor: 'var(--graphite, #5B6672)', fontSize: 14, fontWeight: 600, align: 'left' as const, valign: 'top' as const },
  uml: { fill: '#FFFFFF', stroke: INK, strokeWidth: 1.5, textColor: INK, fontSize: 14, fontWeight: 400, align: 'center' as const, valign: 'middle' as const },
  path: { fill: 'none', stroke: CANVAS_INK, strokeWidth: 3, textColor: CANVAS_INK, fontSize: 16, fontWeight: 400, align: 'center' as const, valign: 'middle' as const },
  icon: { fill: 'none', stroke: CANVAS_INK, strokeWidth: 0, textColor: CANVAS_INK, fontSize: 16, fontWeight: 400, align: 'center' as const, valign: 'middle' as const },
};

export function defaultsFor(o: Obj) {
  if (o.type === 'sticky') return DEFAULTS.sticky;
  if (o.type === 'text') return DEFAULTS.text;
  if (o.type === 'frame') return DEFAULTS.frame;
  if (o.type === 'tracker') return DEFAULTS.frame;
  if (o.type === 'path') return DEFAULTS.path;
  if (o.type === 'icon') return DEFAULTS.icon;
  if (o.type.startsWith('uml-')) return DEFAULTS.uml;
  return DEFAULTS.shape;
}

/** A stored number, or the default when what is stored is not a finite number (it is written into attributes). */
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * Fully resolved style for an object. Every colour goes through safeColor (shared/colors.mjs, TAB-203) and every number
 * is a finite number: what is stored can be written by any collaborator, template, import or tool, and all of it ends
 * up in attributes, so a value outside the grammar is drawn as the type's default.
 */
export function styleOf(o: Obj) {
  const d = defaultsFor(o);
  const b = o as BaseObj;
  const fill = safeColor(b.fill, d.fill);
  return {
    fill,
    stroke: safeColor(o.stroke, d.stroke),
    strokeWidth: num(o.strokeWidth, d.strokeWidth),
    dash: o.dash ?? 'solid',
    opacity: num(o.opacity, 1),
    font: b.font ?? 'satoshi',
    fontWeight: num(b.fontWeight, d.fontWeight),
    fontSize: num(b.fontSize, d.fontSize),
    textColor: safeColor(b.textColor, o.type === 'sticky' ? inkOn(fill) : d.textColor),
    align: b.align ?? d.align,
    valign: b.valign ?? d.valign,
  };
}

export const dashArray = (dash: string | undefined, sw: number) =>
  dash === 'dashed' ? `${sw * 4} ${sw * 3}` : dash === 'dotted' ? `0.1 ${sw * 2.5}` : '';

function strokeAttrs(stroke: string, sw: number, dash: string | undefined) {
  if (stroke === 'none' || sw <= 0) return 'stroke="none"';
  const da = dashArray(dash, sw);
  return `stroke="${escapeXml(stroke)}" stroke-width="${sw}"${da ? ` stroke-dasharray="${da}"` : ''}${dash === 'dotted' ? ' stroke-linecap="round"' : ''} stroke-linejoin="round"`;
}

/** Wrapped lines of a text in a box, and the y of the first line's top edge. Shared by the renderer and the editor. */
export function layoutText(
  text: string, box: { x: number; y: number; w: number; h: number },
  s: ReturnType<typeof styleOf>, opts: { valign?: VAlign; shrink?: boolean } = {},
): { lines: string[]; size: number; lineHeight: number; height: number; top: number } {
  const { lines, size, lineHeight, height } = opts.shrink
    ? fitText(text, s.font, s.fontWeight, s.fontSize, box.w, box.h)
    : (() => {
        const lh = n(s.fontSize * 1.3);
        const ls = wrap(text, fontCss(s.font, s.fontSize, s.fontWeight), box.w);
        return { lines: ls, size: s.fontSize, lineHeight: lh, height: ls.length * lh };
      })();
  const v = opts.valign ?? 'middle';
  const top = v === 'top' ? box.y : v === 'bottom' ? box.y + box.h - height : box.y + (box.h - height) / 2;
  return { lines, size, lineHeight, height, top };
}

export function textBlock(
  text: string, box: { x: number; y: number; w: number; h: number },
  s: ReturnType<typeof styleOf>, opts: { valign?: VAlign; shrink?: boolean; italic?: boolean } = {},
): string {
  if (!text) return '';
  const { lines, size, lineHeight, top } = layoutText(text, box, s, opts);
  const anchor = s.align === 'left' ? 'start' : s.align === 'right' ? 'end' : 'middle';
  const x = s.align === 'left' ? box.x : s.align === 'right' ? box.x + box.w : box.x + box.w / 2;
  const tspans = lines
    .map((l, i) => `<tspan x="${n(x)}" y="${n(top + i * lineHeight + lineHeight / 2 + size * 0.35)}">${escapeXml(l) || ' '}</tspan>`)
    .join('');
  return `<text font-family="${escapeXml(fontFamily(s.font))}" font-size="${size}" font-weight="${s.fontWeight}"${opts.italic ? ' font-style="italic"' : ''} fill="${escapeXml(s.textColor)}" text-anchor="${anchor}" xml:space="preserve">${tspans}</text>`;
}

/** Height a text object needs for its content at its current width. */
export function textHeight(o: BaseObj): number {
  const s = styleOf(o);
  const lines = wrap(o.text || ' ', fontCss(s.font, s.fontSize, s.fontWeight), o.w);
  return Math.max(s.fontSize * 1.3, lines.length * s.fontSize * 1.3);
}

function wrapG(o: BaseObj, inner: string, opacity: number) {
  const rot = o.rotation ? ` rotate(${n((o.rotation * 180) / Math.PI)} ${n(o.w / 2)} ${n(o.h / 2)})` : '';
  const op = opacity < 1 ? ` opacity="${opacity}"` : '';
  return `<g transform="translate(${n(o.x)} ${n(o.y)})${rot}"${op}>${inner}</g>`;
}

/** Mirrors geometry in the local box frame. The parent's existing rotation is applied after this transform. */
function mirroredContent(o: BaseObj, geometry: string): string {
  if (o.flipX !== true && o.flipY !== true) return geometry;
  const cx = n(o.w / 2), cy = n(o.h / 2);
  return `<g transform="translate(${cx} ${cy}) scale(${o.flipX === true ? -1 : 1} ${o.flipY === true ? -1 : 1}) translate(${n(-o.w / 2)} ${n(-o.h / 2)})">${geometry}</g>`;
}

// Icon and sticker bodies arrive from Iconify, from collaborators' boards and from files: the shared policy
// (shared/svg-safety.mjs, the same one the server holds templates to) leaves out anything that runs or loads from outside.
const iconBodyCache = new Map<string, string>();
export function sanitizeSvgBody(body: string): string {
  const hit = iconBodyCache.get(body);
  if (hit !== undefined) return hit;
  const out = sanitizeSvg(body);
  if (iconBodyCache.size > 2000) iconBodyCache.clear();
  iconBodyCache.set(body, out);
  return out;
}

function shapeMarkup(o: BaseObj, ctx: MarkupCtx) {
  const s = styleOf(o);
  const kind = o.kind || 'rect';
  const fill = s.fill === 'none' ? 'none' : escapeXml(s.fill);
  let geometry = `<path d="${shapePath(kind, o.w, o.h)}" fill="${fill}" ${strokeAttrs(s.stroke, s.strokeWidth, s.dash)}/>`;
  const decor = shapeDecor(kind, o.w, o.h);
  if (decor) geometry += `<path d="${decor}" fill="none" ${strokeAttrs(s.stroke, s.strokeWidth, 'solid')}/>`;
  const label = ctx.editingId !== o.id ? textBlock(o.text || '', labelBox(o), s, { shrink: true, valign: s.valign }) : '';
  return wrapG(o, mirroredContent(o, geometry) + label, s.opacity);
}

/** Size of a sticky note's folded corner. */
export const curlSize = (w: number, h: number) => Math.max(10, Math.min(w, h) * 0.15);

/** The box a shape's or sticky's label is laid out in, in object-local coordinates. */
export function labelBox(o: BaseObj) {
  if (o.type === 'sticky') return { x: 14, y: 14, w: Math.max(1, o.w - 28), h: Math.max(1, o.h - 28 - curlSize(o.w, o.h) * 0.35) };
  return textBox(o.kind || 'rect', o.w, o.h);
}

/**
 * A sticky note with its bottom-right corner folded over: the note's edge
 * curves along the crease, the flap lies on the front (lit toward its tip,
 * shaded at the crease) and casts a soft shadow on the paper.
 */
function stickyMarkup(o: BaseObj, ctx: MarkupCtx) {
  const s = styleOf(o);
  const hidden = ctx.isHidden?.(o);
  const w = o.w, h = o.h, k = curlSize(w, h);
  const fill = escapeXml(s.fill);
  // crease from (w, h-k) to (w-k, h), bowed slightly toward the corner
  const crease = `C${n(w - k * 0.22)} ${n(h - k * 0.62)} ${n(w - k * 0.62)} ${n(h - k * 0.22)} ${n(w - k)} ${n(h)}`;
  const body = `M0 0H${n(w)}V${n(h - k)}${crease}H0Z`;
  // the folded flap: the corner reflected over the crease, its edges curling a little
  const tip = { x: w - k * 0.94, y: h - k * 0.94 };
  const flap = `M${n(w)} ${n(h - k)}${crease}Q${n(w - k * 1.04)} ${n(h - k * 0.5)} ${n(tip.x)} ${n(tip.y)}Q${n(w - k * 0.5)} ${n(h - k * 1.04)} ${n(w)} ${n(h - k)}Z`;
  let inner =
    `<path d="${body}" fill="${fill}" filter="url(#sticky-shadow)"/>` +
    `<path d="${body}" fill="url(#sticky-sheen)"/>` +
    // soft shadow the flap casts on the note
    `<path d="${flap}" transform="translate(${n(-k * 0.07)} ${n(-k * 0.07)})" fill="#000" fill-opacity="0.2" filter="url(#sticky-curl-shadow)"/>` +
    `<path d="${flap}" fill="${fill}"/>` +
    `<path d="${flap}" fill="url(#sticky-flap)"/>`;
  const ink = s.textColor;
  if (hidden) {
    const faint = ink === '#FFFFFF' ? 'rgba(255,255,255,.35)' : 'rgba(0,0,0,.18)';
    inner += `<path d="M14 ${n(h / 2 - 8)}h${n(w - 28)}M14 ${n(h / 2 + 4)}h${n(w * 0.5)}" stroke="${faint}" stroke-width="6" stroke-linecap="round"/>`;
    inner += `<text x="${n((w - k) / 2)}" y="${n(h - 14)}" font-family="${escapeXml(fontFamily('satoshi'))}" font-size="11" fill="${ink === '#FFFFFF' ? 'rgba(255,255,255,.7)' : 'rgba(0,0,0,.5)'}" text-anchor="middle">Hidden until reveal</text>`;
  } else if (ctx.editingId !== o.id) {
    inner += textBlock(o.text || '', labelBox(o), s, { shrink: true, valign: s.valign });
  }
  return wrapG(o, inner, s.opacity);
}

function textMarkup(o: BaseObj, ctx: MarkupCtx) {
  const s = styleOf(o);
  if (ctx.editingId === o.id) return wrapG(o, '', 1);
  return wrapG(o, textBlock(o.text || '', { x: 0, y: 0, w: o.w, h: o.h }, s, { valign: 'top' }), s.opacity);
}

function frameMarkup(o: BaseObj) {
  const s = styleOf(o);
  const fill = s.fill === 'none' ? 'none' : escapeXml(s.fill);
  const name = escapeXml(o.name || 'Frame');
  return wrapG(
    o,
    `<rect x="0" y="0" width="${n(o.w)}" height="${n(o.h)}" rx="6" fill="${fill}" ${strokeAttrs(s.stroke, s.strokeWidth, s.dash)}/>` +
      `<text x="2" y="-10" font-family="${escapeXml(fontFamily(s.font))}" font-size="${s.fontSize}" font-weight="${s.fontWeight}" fill="${escapeXml(s.textColor)}">${name}</text>`,
    s.opacity,
  );
}

// ---------------------------------------------------------------- kanban (docs/kanban.md, Visual design)

// Colours are theme variables with the Default theme as fallback (an export replaces each by its fallback), always in a
// style attribute: presentation attributes take neither var() nor color-mix().
const K = {
  canvas: 'var(--canvas, #EEF1F4)',
  canvasInk: CANVAS_INK,
  rule: 'var(--canvas-rule, #C9D1DA)',
  paper: 'var(--paper, #FFFFFF)',
  ink: 'var(--ink, #18212B)',
  danger: 'var(--danger, #D41E24)',
  stickyInk: 'var(--sticky-ink, #1D1A12)',
  lane: 'color-mix(in srgb, var(--canvas-ink, #18212B) 5%, var(--canvas, #EEF1F4))',
  meta: 'color-mix(in srgb, var(--canvas-ink, #18212B) 82%, var(--canvas, #EEF1F4))',
  cardMeta: 'color-mix(in srgb, var(--ink, #18212B) 72%, var(--paper, #FFFFFF))',
  linked: 'var(--canvas-ink, #18212B)',
  linkedBadge: 'color-mix(in srgb, var(--canvas-ink, #18212B) 8%, var(--paper, #FFFFFF))',
  linkedBadgeInk: 'var(--ink, #18212B)',
  unmappedBadge: 'color-mix(in srgb, var(--signal, #FFD23F) 24%, var(--paper, #FFFFFF))',
  canceledBadge: 'color-mix(in srgb, var(--danger, #D41E24) 15%, var(--paper, #FFFFFF))',
  edge: 'color-mix(in srgb, var(--canvas-ink, #18212B) 28%, transparent)',
  dash: 'color-mix(in srgb, var(--canvas-ink, #18212B) 40%, transparent)',
};

/**
 * A sticky swatch by its palette key (`blue`), the same in every theme, or a hex colour. Anything else is not drawn: the
 * value goes into a style attribute, where a stored string could otherwise add CSS of its own.
 */
function swatch(key: string | undefined): string | undefined {
  const c = kanbanColor(key);
  if (!c) return undefined;
  const s = STICKY_COLORS.find((x) => x.name.toLowerCase() === c);
  return s ? `var(--s-${c}, ${s.fill})` : c;
}
/** The CSS colour of a label or card accent, for the dialogs: the same swatch the board draws, or nothing. */
export const kanbanSwatch = swatch;

const fillStyle = (c: string) => `style="fill:${escapeXml(c)}"`;
const strokeStyle = (c: string) => `style="fill:none;stroke:${escapeXml(c)}"`;

/** 11px uppercase label text, as `.lbl` in the design. */
const LBL = { size: 11, weight: 600, spacing: 0.66 };
const lblWidth = (text: string, slug: string | undefined) => measure(text.toUpperCase(), fontCss(slug, LBL.size, LBL.weight)) + text.length * LBL.spacing;

function label(text: string, x: number, y: number, color: string, slug: string | undefined, anchor: 'start' | 'middle' | 'end' = 'start') {
  return `<text x="${n(x)}" y="${n(y)}" font-family="${escapeXml(fontFamily(slug))}" font-size="${LBL.size}" font-weight="${LBL.weight}" letter-spacing="${LBL.spacing}" text-anchor="${anchor}" ${fillStyle(color)}>${escapeXml(text.toUpperCase())}</text>`;
}

/** A 24-grid stroke icon (src/ui/dom.ts) scaled to `size` at (x, y). */
function kIcon(path: string, x: number, y: number, size: number, color: string) {
  return `<g transform="translate(${n(x)} ${n(y)}) scale(${n(size / 24)})" style="fill:none;stroke:${escapeXml(color)}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${path}</g>`;
}
const ICON_PLUS = '<path d="M12 5v14M5 12h14"/>';
const ICON_CHECK = '<path d="M5 12.5l4.5 4.5L19 7.5"/>';
const ICON_LOCK = '<rect x="5" y="10.5" width="14" height="10" rx="1.5"/><path d="M8 10.5V7.5a4 4 0 018 0v3"/>';
const ICON_FILTER = '<path d="M4 6h16M7 12h10M10 18h4"/>';
const ICON_CLOSE = '<path d="M6 6l12 12M18 6L6 18"/>';
const ICON_IMAGE_OFF = '<path d="M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><circle cx="8.5" cy="9.5" r="1.4"/><path d="M3 17l5-5 4 4 3-3 6 6"/><path d="M3 3l18 18"/>';
const ICON_DOTS = '<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>';
const ICON_COMMENT = '<path d="M5.5 5h13A1.5 1.5 0 0120 6.5v8a1.5 1.5 0 01-1.5 1.5H10.5L6.5 19.5V16h-1A1.5 1.5 0 014 14.5v-8A1.5 1.5 0 015.5 5z"/>';
const ICON_LINK = '<path d="M10 13.5l4-4M8.5 15.5l-1 1a3 3 0 01-4.2-4.2l3-3a3 3 0 014.2 0M15.5 8.5l1-1a3 3 0 014.2 4.2l-3 3a3 3 0 01-4.2 0"/>';

/** `text` cut to fit `max` pixels, with an ellipsis when it had to be cut. */
function clip(text: string, font: string, max: number): string {
  if (measure(text, font) <= max) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(text.slice(0, mid).trimEnd() + '…', font) <= max) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + '…';
}

const cardFont = (o: BaseObj) => fontCss(o.font, CARD.titleSize, 500);
const cardPadLeft = (o: BaseObj) => (o.fill ? CARD.padAccent : CARD.padX);
type CardTrackerProjection = { title?: string; state?: { key?: string; name?: string; category?: string } };
const cardProjection = (o: BaseObj): CardTrackerProjection | undefined => (o as BaseObj & { tracker?: CardTrackerProjection }).tracker;
const cardTitle = (o: BaseObj) => o.extProvider === 'tabula' ? cardProjection(o)?.title ?? o.text ?? '' : o.text ?? '';

/** The title lines a card draws at width `w`: its first line of text, wrapped, at most three, the last cut with an ellipsis. */
export function cardTitleLines(o: BaseObj, w: number): string[] {
  const font = cardFont(o);
  const max = w - cardPadLeft(o) - CARD.padX - (isSafeHttpUrl(o.link) ? 24 : 0);
  const title = cardTitle(o).split('\n')[0].trim();
  const lines = wrap(title || ' ', font, max);
  if (lines.length <= CARD.titleLines) return lines;
  const kept = lines.slice(0, CARD.titleLines);
  kept[CARD.titleLines - 1] = clip(`${kept[CARD.titleLines - 1]} ${lines[CARD.titleLines]}`, font, max);
  return kept;
}

const hasMeta = (o: BaseObj) => !!(o.due || o.ownerName || o.ownerId);

/** The height a card needs at width `w`, which its writer stores as `h` (docs/kanban.md, Layout: nothing measures on read). */
export function cardContentHeight(o: BaseObj, w: number): number {
  return cardHeight({ lines: cardTitleLines(o, w).length, labels: !!o.labels?.length, meta: hasMeta(o) })
    + (o.extProvider === 'tabula' ? CARD.titleLine : 0);
}

export interface HeaderControls {
  /** The left edge of the leftmost control (the name and the meta stop before it). */
  left: number;
  /** The ⋯ button (editors only). */
  menu: Rect | null;
  /** The Filter button, with its text ("Filter" or "Filter · 2"); null where there is no filter (an export). */
  filter: { rect: Rect; text: string; on: boolean } | null;
  /** The active filter chips that fit, each with its remove button. */
  chips: { key: string; text: string; rect: Rect; remove: Rect }[];
}

/**
 * Where a kanban header's controls sit, in the container's own coordinates (docs/kanban.md, Visual design: Filter 32
 * high, chips 32 high with a 30px remove button, ⋯ 32 square, 8 apart, 12 from the right edge). The drawing and the hit
 * test both read it, so they cannot disagree. Chips that do not fit in the right half are left out (the Filter button
 * still counts them).
 */
export function kanbanHeaderControls(o: BaseObj, chips: FilterChip[] | null, editable: boolean): HeaderControls {
  const y = 8, size = 32;
  let x = o.w - 12;
  let menu: Rect | null = null;
  if (editable) {
    x -= size;
    menu = { x, y, w: size, h: size };
    x -= 8;
  }
  let filter: HeaderControls['filter'] = null;
  const placed: HeaderControls['chips'] = [];
  if (chips) {
    const text = chips.length ? `Filter · ${chips.length}` : 'Filter';
    const fw = 10 + 16 + 6 + lblWidth(text, o.font) + 10;
    x -= fw;
    filter = { rect: { x, y, w: fw, h: size }, text, on: chips.length > 0 };
    const widths = chips.map((c) => 8 + lblWidth(c.text, o.font) + 2 + 30);
    const room = x - 8 - o.w / 2;
    let count = chips.length;
    while (count && widths.slice(0, count).reduce((a, b) => a + b + 8, 0) > room) count--;
    let cx = x - 8 - widths.slice(0, count).reduce((a, b) => a + b + 8, 0) + 8;
    for (let i = 0; i < count; i++) {
      const rect = { x: cx, y, w: widths[i], h: size };
      placed.push({ key: chips[i].key, text: chips[i].text, rect, remove: { x: cx + widths[i] - 31, y: y + 1, w: 30, h: 30 } });
      cx += widths[i] + 8;
    }
    if (count) x = placed[0].rect.x;
  }
  return { left: x, menu, filter, chips: placed };
}

function headerControlsMarkup(o: BaseObj, c: HeaderControls, open: MarkupCtx['openControl']) {
  let out = '';
  for (const chip of c.chips) {
    const r = chip.rect;
    out += `<g class="k-fchip"><rect x="${n(r.x + 0.5)}" y="${n(r.y + 0.5)}" width="${n(r.w - 1)}" height="${n(r.h - 1)}" ${strokeStyle(K.canvasInk)} stroke-width="1"/>`;
    out += label(chip.text, r.x + 8, r.y + 20, K.canvasInk, o.font);
    out += kIcon(ICON_CLOSE, chip.remove.x + 9, chip.remove.y + 9, 12, K.canvasInk) + '</g>';
  }
  if (c.filter) {
    const { rect: r, text, on } = c.filter;
    const pressed = on || (open?.id === o.id && open.kind === 'filter');
    const ink = on ? 'var(--on-signal, #18212B)' : pressed ? K.canvas : K.canvasInk;
    out += `<g class="k-filter">`;
    out += on ? `<rect x="${n(r.x)}" y="${n(r.y)}" width="${n(r.w)}" height="${n(r.h)}" ${fillStyle('var(--signal, #FFD23F)')}/>`
      : pressed ? `<rect x="${n(r.x)}" y="${n(r.y)}" width="${n(r.w)}" height="${n(r.h)}" ${fillStyle(K.canvasInk)}/>`
      : `<rect x="${n(r.x + 0.5)}" y="${n(r.y + 0.5)}" width="${n(r.w - 1)}" height="${n(r.h - 1)}" ${strokeStyle(K.canvasInk)} stroke-width="1"/>`;
    out += kIcon(ICON_FILTER, r.x + 10, r.y + 8, 16, ink) + label(text, r.x + 32, r.y + 20, ink, o.font) + '</g>';
  }
  if (c.menu) {
    const r = c.menu;
    const pressed = open?.id === o.id && open.kind === 'menu';
    if (pressed) out += `<rect x="${n(r.x)}" y="${n(r.y)}" width="${n(r.w)}" height="${n(r.h)}" ${fillStyle(K.canvasInk)}/>`;
    out += `<g class="k-menu" ${fillStyle(pressed ? K.canvas : K.canvasInk)} transform="translate(${n(r.x + 6)} ${n(r.y + 6)}) scale(${n(20 / 24)})">${ICON_DOTS}</g>`;
  }
  return out;
}

function kanbanContainerMarkup(o: BaseObj, ctx: MarkupCtx) {
  const w = o.w, h = o.h;
  const low = lowDetail(ctx.zoom ?? 1);
  const name = o.name || 'Kanban';
  let inner = `<rect x="0.5" y="0.5" width="${n(Math.max(0, w - 1))}" height="${n(Math.max(0, h - 1))}" style="fill:${K.canvas};stroke:${K.rule}" stroke-width="1"/>`;
  inner += `<rect x="0" y="46" width="${n(w)}" height="2" ${fillStyle(K.canvasInk)}/>`;
  // the header's controls and the add-lane +, at full detail only (below 0.4 they would be a few pixels across)
  const controls = low ? null : kanbanHeaderControls(o, ctx.filterChips?.(o.id) ?? null, !!ctx.editable);
  const layout = ctx.containerLayout?.(o.id);
  if (controls) inner += headerControlsMarkup(o, controls, ctx.openControl);
  if (!low && ctx.editable && layout?.addLane) {
    const a = layout.addLane;
    const ax = a.x - o.x, ay = a.y - o.y;
    inner += `<g class="k-addlane"><title>Add lane</title><rect x="${n(ax + 0.5)}" y="${n(ay + 0.5)}" width="${n(a.w - 1)}" height="${n(a.h - 1)}" ${strokeStyle(K.canvasInk)} stroke-width="1"/>${kIcon(ICON_PLUS, ax + 6, ay + 6, 20, K.canvasInk)}</g>`;
  }
  if (ctx.editingId === o.id) return wrapG(o, inner, 1);
  const size = low ? 40 : 17;
  const font = fontCss(o.font, size, 700);
  const right = controls ? controls.left - 12 : w - 12;
  const nameText = clip(name, font, Math.max(24, right - 12));
  inner += `<text x="12" y="${low ? 38 : 30}" font-family="${escapeXml(fontFamily(o.font))}" font-size="${size}" font-weight="700" letter-spacing="${low ? -0.4 : -0.17}" ${fillStyle(K.canvasInk)}>${escapeXml(nameText)}</text>`;
  if (!low && layout) {
    const lanes = layout.lanes.length;
    const cards = [...layout.cards.values()].reduce((s, ids) => s + ids.length, 0);
    const meta = `${lanes} ${lanes === 1 ? 'lane' : 'lanes'} · ${cards} ${cards === 1 ? 'card' : 'cards'}`;
    const x = 12 + measure(nameText, font) + 12;
    if (x + lblWidth(meta, o.font) < right) inner += label(meta, x, 28.5, K.meta, o.font);
  }
  return wrapG(o, inner, 1);
}

function laneMarkup(o: BaseObj, ctx: MarkupCtx) {
  const w = o.w, h = o.h;
  const low = lowDetail(ctx.zoom ?? 1);
  const accent = swatch(o.fill);
  const layout = o.parent ? ctx.containerLayout?.(o.parent) : null;
  const ids = layout?.cards.get(o.id) ?? [];
  const count = laneCount(o, ids.length);
  const body = accent ? `color-mix(in srgb, ${accent} 10%, ${K.lane})` : K.lane;
  let inner = `<rect x="0" y="0" width="${n(w)}" height="${n(h)}" ${fillStyle(body)}/>`;
  if (accent) inner += `<rect x="0" y="0" width="${n(w)}" height="4" ${fillStyle(accent)}/>`;
  if (!low && count.state === 'over') inner += `<rect x="0" y="46" width="${n(w)}" height="2" ${fillStyle(K.danger)}/>`;
  const fam = escapeXml(fontFamily(o.font));
  if (low) {
    const font = fontCss(o.font, 28, 600);
    if (ctx.editingId !== o.id) inner += `<text x="12" y="38" font-family="${fam}" font-size="28" font-weight="600" ${fillStyle(K.canvasInk)}>${escapeXml(clip(o.name || 'Lane', font, w - 24))}</text>`;
    return wrapG(o, inner, 1);
  }
  // the ⋯ menu (editors only), then the count right-aligned before it, as a danger chip when over the limit
  const mid = 26;
  const countW = lblWidth(count.text, o.font) + (count.block ? 16 : 0);
  let right = w - 12;
  if (ctx.editable) {
    const m = laneMenuRect({ x: 0, y: 0, w, h });
    const pressed = ctx.openControl?.id === o.id;
    if (pressed) inner += `<rect x="${n(m.x)}" y="${n(m.y)}" width="${m.w}" height="${m.h}" ${fillStyle(K.canvasInk)}/>`;
    inner += `<g class="k-menu" ${fillStyle(pressed ? K.canvas : K.canvasInk)} transform="translate(${n(m.x + 5)} ${n(m.y + 5)}) scale(${n(18 / 24)})">${ICON_DOTS}</g>`;
    right = m.x - 8;
  }
  if (count.state === 'over') {
    inner += `<rect x="${n(right - countW - 6)}" y="${mid - 10}" width="${n(countW + 12)}" height="20" ${fillStyle(K.danger)}/>`;
  }
  const countColor = count.state === 'over' ? K.paper : count.state === 'at' ? K.canvasInk : K.meta;
  inner += `<g><title>${escapeXml(count.title)}</title>${label(count.text, right, mid + 4, countColor, o.font, 'end')}`;
  if (count.block) inner += kIcon(ICON_LOCK, right - countW, mid - 6, 12, countColor);
  inner += '</g>';
  // the name, then the done stage marker after it
  const stage = o.stage === 'done' ? 'Done' : '';
  const stageW = stage ? 14 + 2 + lblWidth(stage, o.font) : 0;
  const nameFont = fontCss(o.font, 14, 600);
  const room = right - countW - (count.state === 'over' ? 12 : 0) - 8 - 12 - (stage ? stageW + 8 : 0);
  const nameText = clip(o.name || 'Lane', nameFont, Math.max(24, room));
  if (ctx.editingId !== o.id) inner += `<text x="12" y="${mid + 5}" font-family="${fam}" font-size="14" font-weight="600" ${fillStyle(K.canvasInk)}>${escapeXml(nameText)}</text>`;
  if (stage) {
    const x = 12 + measure(nameText, nameFont) + 8;
    inner += `<g><title>Stage: done</title>${kIcon(ICON_CHECK, x, mid - 7, 14, K.meta)}${label(stage, x + 16, mid + 4, K.meta, o.font)}</g>`;
  }
  // the body: an empty lane's dashed box, and the add-card row after the last card
  const local = { x: 0, y: 0, w, h };
  const cards = layout ? ids.map((id) => layout.rects.get(id)!).map((r) => ({ ...r, x: r.x - o.x, y: r.y - o.y })) : [];
  const dropping = ctx.dropLane === o.id;
  if (!cards.length || (dropping && cards.every((_, i) => ctx.dragging?.(ids[i])))) {
    const b = emptyBox(local);
    inner += `<rect x="${n(b.x + 0.5)}" y="${n(b.y + 0.5)}" width="${n(b.w - 1)}" height="${n(b.h - 1)}" ${strokeStyle(K.dash)} stroke-width="1" stroke-dasharray="4 3"/>`;
    inner += label(dropping ? 'Drop here' : 'No cards', b.x + b.w / 2, b.y + b.h / 2 + 4, K.meta, o.font, 'middle');
  }
  if (ctx.editable && ctx.addingLane !== o.id) {
    const r = addRow(local, cards);
    const cy = r.y + r.h / 2;
    // a full block lane takes no new card: the row is disabled, with a lock and the limit in its tooltip (Slice 4 notes)
    const full = count.block && count.state !== '';
    inner += full
      ? `<g class="k-add k-add-full" opacity="0.5"><title>${escapeXml(wipFullMessage(o.name, ids.length, o.wip!))}</title>${kIcon(ICON_LOCK, r.x + 8, cy - 8, 16, K.meta)}<text x="${n(r.x + 30)}" y="${n(cy + 4.5)}" font-family="${fam}" font-size="13" font-weight="500" ${fillStyle(K.meta)}>Add card</text></g>`
      : `<g class="k-add">${kIcon(ICON_PLUS, r.x + 8, cy - 8, 16, K.meta)}<text x="${n(r.x + 30)}" y="${n(cy + 4.5)}" font-family="${fam}" font-size="13" font-weight="500" ${fillStyle(K.meta)}>Add card</text></g>`;
  }
  return wrapG(o, inner, 1);
}

function cardMarkup(o: BaseObj, ctx: MarkupCtx) {
  const w = o.w, h = o.h;
  if (ctx.dragging?.(o.id)) {
    // the slot it leaves: a dashed hairline of the same size, nothing inside
    return wrapG(o, `<rect x="0.5" y="0.5" width="${n(w - 1)}" height="${n(h - 1)}" style="fill:none;stroke:color-mix(in srgb, var(--canvas-ink, #18212B) 55%, transparent)" stroke-width="1" stroke-dasharray="4 3"/>`, 1);
  }
  // a card this viewer's filter does not match draws at 35%: dimmed, never hidden, so the layout stays shared
  return wrapG(o, cardBody(o, ctx), ctx.dimmed?.(o) ? 0.35 : 1);
}

/** A card's drawing in its own coordinates, without the group that places it: the board draws it, and so does the drag ghost. */
export function cardBody(o: BaseObj, ctx: MarkupCtx, edge: 'hairline' | 'ghost' = 'hairline'): string {
  const w = o.w, h = o.h;
  const low = lowDetail(ctx.zoom ?? 1);
  const accent = swatch(o.fill);
  const padL = cardPadLeft(o);
  let inner = `<rect x="0" y="0" width="${n(w)}" height="${n(h)}" ${fillStyle(K.paper)}/>`;
  if (accent) inner += `<rect x="0" y="0" width="${CARD.accent}" height="${n(h)}" ${fillStyle(accent)}/>`;
  const linked = o.extProvider === 'tabula';
  inner += edge === 'ghost'
    ? `<rect x="1" y="1" width="${n(w - 2)}" height="${n(h - 2)}" ${strokeStyle(K.canvasInk)} stroke-width="2"/>`
    : `<rect x="0.5" y="0.5" width="${n(w - 1)}" height="${n(h - 1)}" ${strokeStyle(K.edge)} stroke-width="1"/>`;
  if (isSafeHttpUrl(o.link) && edge === 'hairline') {
    const hit = 24;
    const x = w - CARD.padX - hit, y = CARD.padY - 4;
    const title = cardTitle(o).trim() || 'Untitled card';
    inner += `<a class="k-card-link" data-card-link="true" href="${escapeXml(o.link!)}" target="_blank" rel="noopener noreferrer" tabindex="0" aria-label="Open link: ${escapeXml(title)}">` +
      `<rect class="k-card-link-focus" x="${n(x)}" y="${n(y)}" width="${hit}" height="${hit}" fill="var(--paper)" fill-opacity="0.001" pointer-events="all"/>` +
      `<rect class="k-card-link-focus-ring" x="${n(x)}" y="${n(y)}" width="${hit}" height="${hit}" fill="none" stroke="none"/>` +
      `<title>Open link: ${escapeXml(title)}</title>${kIcon(ICON_LINK, x + 5, y + 5, 14, K.meta)}</a>`;
  }
  const fam = escapeXml(fontFamily(o.font));
  const lines = cardTitleLines(o, w);
  let y = CARD.padY;
  let unmappedChip = false;
  if (linked) {
    const projection = cardProjection(o);
    const state = projection?.state;
    const lane = o.parent ? ctx.get(o.parent) : undefined;
    const container = lane?.parent ? ctx.get(lane.parent) : undefined;
    const map = container?.type === 'container' ? (container as BaseObj & { ext?: { map?: Record<string, string> } }).ext?.map : undefined;
    const laneStateKey = lane?.type === 'lane' ? map?.[lane.id] : undefined;
    unmappedChip = Boolean(state?.name && lane?.type === 'lane' && (!laneStateKey || laneStateKey !== state.key));
    inner += linkedCardHeaderMarkup({
      key: o.extKey ?? '',
      state: state?.name ? { key: state.key ?? '', name: state.name, category: (state.category ?? 'unstarted') as TrackerStateCategory } : null,
      laneStateKey,
      width: w,
      height: h,
      zoom: ctx.zoom ?? 1,
      priority: (projection as { priority?: TrackerPriority } | undefined)?.priority,
    });
    y += CARD.titleLine;
  }
  if (ctx.editingId !== o.id) {
    if (low) {
      lines.forEach((_, i) => (inner += `<rect x="${padL}" y="${n(y + i * CARD.titleLine + 3)}" width="${n((w - padL - CARD.padX) * (i === lines.length - 1 && lines.length > 1 ? 0.6 : 0.8))}" height="12" ${fillStyle(K.cardMeta)}/>`));
    } else {
      inner += `<text font-family="${fam}" font-size="${CARD.titleSize}" font-weight="500" ${fillStyle(K.ink)} xml:space="preserve">` +
        lines.map((l, i) => `<tspan x="${padL}" y="${n(y + i * CARD.titleLine + 13.5)}">${escapeXml(l) || ' '}</tspan>`).join('') + '</text>';
    }
  }
  y += Math.min(Math.max(lines.length, 1), CARD.titleLines) * CARD.titleLine;
  if (unmappedChip && h - y >= 30) inner += `<g transform="translate(12 ${n(h - 30)})">${unmappedStateChipMarkup({ width: 100 })}</g>`;
  // labels: at most three chips, then +n; names are never clipped
  if (o.labels?.length) {
    y += CARD.rowGap;
    const known = o.labels.map((id) => validLabel(ctx.label?.(id))).filter((l): l is Label => !!l);
    let x = padL;
    known.slice(0, 3).forEach((l) => {
      const text = l.name.toUpperCase();
      const tw = measure(text, fontCss(o.font, LBL.size, LBL.weight)) + text.length * 0.44 + 10;
      inner += `<g><title>${escapeXml(l.name)}</title><rect x="${n(x)}" y="${n(y)}" width="${n(tw)}" height="16" ${fillStyle(swatch(l.color) ?? K.cardMeta)}/>`;
      if (!low) inner += `<text x="${n(x + 5)}" y="${n(y + 12)}" font-family="${fam}" font-size="11" font-weight="600" letter-spacing="0.44" ${fillStyle(K.stickyInk)}>${escapeXml(text)}</text>`;
      inner += '</g>';
      x += tw + 4;
    });
    if (known.length > 3 && !low) inner += label(`+${known.length - 3}`, x, y + 12, K.cardMeta, o.font);
    y += CARD.labelRow;
  }
  // meta row: due, then the comment count and the owner on the right
  if (hasMeta(o)) {
    y += CARD.rowGap;
    if (!low) {
      const cy = y + CARD.metaRow / 2;
      const lane = o.parent ? ctx.get(o.parent) : undefined;
      const due = dueChip(o.due, ctx.today ?? localToday(), (lane as BaseObj | undefined)?.stage === 'done');
      if (due) {
        const tw = lblWidth(due.text, o.font);
        const titles = { normal: 'Due', soon: 'Due soon', overdue: 'Overdue', done: 'Done' };
        let chip = `<title>${titles[due.kind]}</title>`;
        if (due.kind === 'overdue') chip += `<rect x="${padL}" y="${n(cy - 10)}" width="${n(tw + 10)}" height="20" ${fillStyle(K.danger)}/>` + label(due.text, padL + 5, cy + 4, K.paper, o.font);
        else if (due.kind === 'soon') chip += `<rect x="${padL + 0.5}" y="${n(cy - 9.5)}" width="${n(tw + 9)}" height="19" ${strokeStyle(K.ink)} stroke-width="1"/>` + label(due.text, padL + 5, cy + 4, K.ink, o.font);
        else if (due.kind === 'done') chip += kIcon(ICON_CHECK, padL, cy - 7, 14, K.cardMeta) + label(due.text, padL + 17, cy + 4, K.cardMeta, o.font);
        else chip += label(due.text, padL, cy + 4, K.cardMeta, o.font);
        inner += `<g>${chip}</g>`;
      }
      let right = w - CARD.padX;
      if (o.ownerName || o.ownerId) {
        const ring = kanbanColor(ctx.ownerColor?.(o)) ?? undefined;
        const agent = o.ownerKind === 'agent';
        const x = right - 24;
        const agentPoints = `${n(x + 6)},${n(cy - 11)} ${n(x + 18)},${n(cy - 11)} ${n(x + 23)},${n(cy - 6)} ${n(x + 23)},${n(cy + 6)} ${n(x + 18)},${n(cy + 11)} ${n(x + 6)},${n(cy + 11)} ${n(x + 1)},${n(cy + 6)} ${n(x + 1)},${n(cy - 6)}`;
        inner += `<g data-owner-kind="${agent ? 'agent' : 'person'}"><title>${escapeXml(o.ownerName || 'Owner')}${agent ? ' (agent)' : ring ? '' : ' (no account)'}</title>`;
        if (agent) {
          inner += `<polygon points="${agentPoints}" ${fillStyle(K.paper)}/>`;
          inner += ring
            ? `<polygon points="${agentPoints}" ${strokeStyle(ring)} stroke-width="2"/>`
            : `<polygon points="${agentPoints}" ${strokeStyle(K.cardMeta)} stroke-width="1"/>`;
        } else {
          inner += `<rect x="${n(x)}" y="${n(cy - 12)}" width="24" height="24" ${fillStyle(K.paper)}/>`;
          inner += ring
            ? `<rect x="${n(x + 1)}" y="${n(cy - 11)}" width="22" height="22" ${strokeStyle(ring)} stroke-width="2"/>`
            : `<rect x="${n(x + 0.5)}" y="${n(cy - 11.5)}" width="23" height="23" ${strokeStyle(K.cardMeta)} stroke-width="1"/>`;
        }
        inner += `<text x="${n(x + 12)}" y="${n(cy + 3.5)}" font-family="${fam}" font-size="10" font-weight="700" letter-spacing="0.2" text-anchor="middle" ${fillStyle(K.ink)}>${escapeXml(initials(o.ownerName))}</text></g>`;
        right = x - 6;
      }
      const comments = ctx.commentCount?.(o.id) ?? 0;
      if (comments > 0) {
        const text = String(comments);
        const tw = lblWidth(text, o.font);
        inner += `<g><title>${comments} ${comments === 1 ? 'comment' : 'comments'}</title>${kIcon(ICON_COMMENT, right - tw - 16, cy - 7, 14, K.cardMeta)}${label(text, right, cy + 4, K.cardMeta, o.font, 'end')}</g>`;
      }
    }
  }
  return inner;
}

/** A container this client cannot lay out: a hairline box with its name and a note, never edited from here. */
function unknownContainerMarkup(o: BaseObj) {
  const text = (y: number, body: string) => `<text x="8" y="${y}" font-family="${escapeXml(fontFamily('satoshi'))}" font-size="13" ${fillStyle(K.canvasInk)}>${escapeXml(body)}</text>`;
  const label = o.type === 'container' ? o.name || 'Container' : o.type === 'lane' ? o.name || 'Lane' : (o.text ?? '').split('\n')[0] || 'Card';
  const note = o.type === 'container' ? text(38, 'Needs a newer Tabula') : '';
  return wrapG(o, `<rect x="0" y="0" width="${n(o.w)}" height="${n(o.h)}" ${strokeStyle(K.rule)} stroke-width="1"/>` + text(20, label) + note, 1);
}

/**
 * A container, a lane or a card. A known layout draws the kanban; a container whose layout is unknown, and a lane or card
 * that no layout places (its container is gone or unknown), draw as a hairline box with a name. A loose card (no lane)
 * draws as a card.
 */
function containerMarkup(o: BaseObj, ctx: MarkupCtx) {
  if (o.type === 'container') return hasLayout(o.layout) ? kanbanContainerMarkup(o, ctx) : unknownContainerMarkup(o);
  if (o.type === 'card') {
    // a card in a lane that no known layout places is not drawn as a card at a stale position
    const lane = o.parent ? ctx.get(o.parent) : undefined;
    const box = lane?.type === 'lane' && lane.parent ? ctx.get(lane.parent) : undefined;
    if (lane?.type === 'lane' && !(box?.type === 'container' && hasLayout((box as BaseObj).layout))) return unknownContainerMarkup(o);
    return cardMarkup(o, ctx);
  }
  const container = o.parent ? ctx.get(o.parent) : undefined;
  return container?.type === 'container' && hasLayout((container as BaseObj).layout) ? laneMarkup(o, ctx) : unknownContainerMarkup(o);
}

/**
 * The zoom a failed image's placeholder is drawn for: the largest half-octave step at or below the camera zoom, so the label
 * (12 px on screen at that zoom) is never under 12 px at the real one, and the placeholder is redrawn only when the step changes.
 */
export const placeholderZoom = (zoom: number): number => (zoom > 0 && Number.isFinite(zoom) ? 2 ** (Math.floor(Math.log2(zoom) * 2) / 2) : 1);

/** An image: its pixels through `<image>` (never as markup, so nothing in the file can run), or a placeholder that says why not. */
function imageMarkup(o: BaseObj, ctx: MarkupCtx) {
  const state: ImageState = ctx.imageState?.(o) ?? { kind: 'loading' };
  const w = n(o.w);
  const h = n(o.h);
  const title = o.alt ? `<title>${escapeXml(o.alt)}</title>` : '';
  if (state.kind === 'ok') {
    const image = `<image href="${escapeXml(state.url)}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none"/>`;
    return wrapG(o, title + mirroredContent(o, image), 1);
  }
  const label = state.kind === 'loading' ? 'Loading' : FAILED_LABEL[state.why];
  const size = o.nw && o.nh ? `${Math.round(o.nw)} × ${Math.round(o.nh)}` : '';
  // The label is what a person has to act on, so it reads at 4.5:1 on its own fill in every theme (ink at 85% over the paper), is
  // never smaller than 12 px on screen whatever the zoom, and grows with the box. An "image off" glyph above it carries the meaning
  // when the words are small. The glyph is dropped before the dimensions line when the box is too short for both.
  const zoom = placeholderZoom(ctx.zoom ?? 1);
  const floor = 12 / zoom;
  const fs = Math.max(floor, Math.min(28, o.w / 14, o.h / 5));
  const glyph = state.kind === 'failed' ? 20 / zoom : 0;
  const gap = glyph ? 6 / zoom : 0;
  const lines = [label, size].filter(Boolean).join('\n');
  const fit = (width: number, height: number) => fitText(lines, 'satoshi', 600, fs, Math.max(1, width), Math.max(1, height), floor);
  // The glyph goes above the label; in a box too short for both it goes beside it; in one too small for either it is left out.
  let place: 'above' | 'beside' | 'none' = 'none';
  let layout = fit(o.w - 16, o.h - 16);
  if (glyph > 0) {
    const stacked = fit(o.w - 16, o.h - 16 - glyph - gap);
    if (stacked.height + glyph + gap <= o.h - 8) {
      place = 'above';
      layout = stacked;
    } else {
      const side = fit(o.w - 16 - glyph - gap, o.h - 16);
      if (side.height <= o.h - 8 && Math.max(...side.lines.map((t) => measure(t, fontCss('satoshi', side.size, 600)))) + glyph + gap <= o.w - 16) {
        place = 'beside';
        layout = side;
      }
    }
  }
  const ink = 'color-mix(in srgb, var(--ink, #18212B) 85%, var(--paper, #FFFFFF))';
  const textStyle = `fill:${ink};font-family:var(--ui, 'Instrument Sans', ui-sans-serif, system-ui, sans-serif);font-weight:600`;
  const widest = Math.max(0, ...layout.lines.map((t) => measure(t, fontCss('satoshi', layout.size, 600))));
  let textX = o.w / 2;
  let textTop = (o.h - layout.height) / 2;
  let glyphX = 0;
  let glyphY = 0;
  if (place === 'above') {
    const block = layout.height + glyph + gap;
    glyphY = (o.h - block) / 2;
    glyphX = o.w / 2 - glyph / 2;
    textTop = glyphY + glyph + gap;
  } else if (place === 'beside') {
    const left = (o.w - (glyph + gap + widest)) / 2;
    glyphX = left;
    glyphY = (o.h - glyph) / 2;
    textX = left + glyph + gap + widest / 2;
  }
  const showText = o.w >= 80 && o.h >= 40;
  const text = showText
    ? layout.lines.map((t, i) => `<text x="${n(textX)}" y="${n(textTop + (i + 0.5) * layout.lineHeight)}" text-anchor="middle" dominant-baseline="middle" font-size="${n(layout.size)}" style="${textStyle}">${escapeXml(t)}</text>`).join('')
    : '';
  const icon = showText && place !== 'none'
    ? `<g class="img-off" transform="translate(${n(glyphX)} ${n(glyphY)}) scale(${n(glyph / 24)})" style="fill:none;stroke:${ink}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${ICON_IMAGE_OFF}</g>`
    : '';
  const box = `<rect x="0" y="0" width="${w}" height="${h}" style="fill:color-mix(in srgb, var(--graphite, #5B6672) 12%, var(--paper, #FFFFFF));stroke:var(--rule, #D5DBE2)" stroke-width="1" stroke-dasharray="4 3"/>`;
  return wrapG(o, title + mirroredContent(o, box) + icon + text, 1);
}

function iconMarkup(o: BaseObj) {
  const s = styleOf(o);
  const vb = (o.viewBox || [0, 0, 24, 24]).map(n);
  // The icon's colour lands in a style attribute as well, so only the colour grammar may reach it (TAB-203).
  const color = safeColor((o as BaseObj).textColor ?? s.stroke, CANVAS_INK);
  const body = scopeSvgIds(sanitizeSvgBody(o.body || ''), o.id);
  return wrapG(
    o,
    mirroredContent(o, `<svg x="0" y="0" width="${n(o.w)}" height="${n(o.h)}" viewBox="${vb.join(' ')}" color="${escapeXml(color)}" style="color:${escapeXml(color)}" overflow="visible">${body}</svg>`),
    s.opacity,
  );
}

export function smoothPath(pts: Point[]): string {
  if (!pts.length) return '';
  if (pts.length < 3) return 'M' + pts.map((p) => `${n(p.x)} ${n(p.y)}`).join('L');
  let d = `M${n(pts[0].x)} ${n(pts[0].y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
    d += `Q${n(pts[i].x)} ${n(pts[i].y)} ${n(mx)} ${n(my)}`;
  }
  const last = pts[pts.length - 1];
  return d + `L${n(last.x)} ${n(last.y)}`;
}

function pathMarkup(o: BaseObj) {
  const s = styleOf(o);
  const local = pathPoints(o).map((p) => ({ x: p.x - o.x, y: p.y - o.y }));
  const geometry = `<path d="${smoothPath(local)}" fill="none" stroke="${escapeXml(s.stroke)}" stroke-width="${s.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`;
  return wrapG(
    o,
    mirroredContent(o, geometry),
    s.opacity,
  );
}

function connectorMarkup(c: ConnectorObj, ctx: MarkupCtx): string {
  const g = connectorGeom(ctx.get, c, ctx.layout?.());
  if (!g) return '';
  const color = safeColor(c.stroke, CANVAS_INK);
  const sw = num(c.strokeWidth, 2);
  const sh = headMarkup(c.startHead, g.start, g.startDir, color, sw);
  const eh = headMarkup(c.endHead, g.end, g.endDir, color, sw);
  // Pull the line back so it ends at each head's base.
  let d = g.d;
  if (sh.inset || eh.inset) {
    const s0 = { x: g.start.x - g.startDir.x * sh.inset, y: g.start.y - g.startDir.y * sh.inset };
    const e0 = { x: g.end.x - g.endDir.x * eh.inset, y: g.end.y - g.endDir.y * eh.inset };
    if (c.route === 'curved') {
      d = d.replace(/^M[^C]+/, `M${n(s0.x)} ${n(s0.y)}`).replace(/ [-\d.e]+ [-\d.e]+$/, ` ${n(e0.x)} ${n(e0.y)}`);
    } else {
      const pts = [...g.pts];
      pts[0] = s0;
      pts[pts.length - 1] = e0;
      d = 'M' + pts.map((p) => `${n(p.x)} ${n(p.y)}`).join('L');
    }
  }
  let out = `<path d="${d}" fill="none" ${strokeAttrs(color, sw, c.dash)} stroke-linecap="round"/>` + sh.svg + eh.svg;
  const label = c.label || (c.relation ? RELATIONS[c.relation].text : '') || '';
  if (label && ctx.editingId !== c.id) {
    const { lines, w, h } = labelPill(label);
    out += `<rect x="${n(g.mid.x - w / 2)}" y="${n(g.mid.y - h / 2)}" width="${n(w)}" height="${n(h)}" rx="4" fill="${PAPER}"/>`;
    out += `<text font-family="${escapeXml(fontFamily('satoshi'))}" font-size="13" font-weight="500" fill="${escapeXml(color === 'none' || color === CANVAS_INK ? INK : color)}" text-anchor="middle">` +
      lines.map((l, i) => `<tspan x="${n(g.mid.x)}" y="${n(g.mid.y - h / 2 + 3 + 17 * i + 13)}">${escapeXml(l)}</tspan>`).join('') + '</text>';
  }
  const opacity = num(c.opacity, 1);
  const op = opacity < 1 ? ` opacity="${opacity}"` : '';
  return `<g${op}>${out}</g>`;
}

/** Text metrics of a connector label: 13px, 17px lines, wrapped at 220. */
export const LABEL_FONT = { size: 13, weight: 500, line: 17, padX: 6, padY: 3, wrap: 220 } as const;

/**
 * The paper pill behind a connector label, sized to its text. The label editor uses the same size, so typing a
 * label looks like the label it becomes.
 */
export function labelPill(label: string): { lines: string[]; w: number; h: number } {
  const font = fontCss('satoshi', LABEL_FONT.size, LABEL_FONT.weight);
  const lines = wrap(label, font, LABEL_FONT.wrap);
  const w = Math.max(...lines.map((l) => measure(l, font))) + 2 * LABEL_FONT.padX;
  const h = lines.length * LABEL_FONT.line + 2 * LABEL_FONT.padY;
  return { lines, w, h };
}

// ---------------------------------------------------------------- UML

function umlMarkup(o: BaseObj, ctx: MarkupCtx): string {
  const s = styleOf(o);
  const fill = s.fill === 'none' ? 'none' : escapeXml(s.fill);
  const st = strokeAttrs(s.stroke, s.strokeWidth, s.dash);
  const fam = escapeXml(fontFamily(s.font));
  const ink = escapeXml(s.textColor);
  const editing = ctx.editingId === o.id;
  const label = (text: string, x: number, y: number, o: { size?: number; weight?: number; italic?: boolean; opacity?: number } = {}) =>
    `<text x="${n(x)}" y="${n(y)}" font-family="${fam}" font-size="${o.size ?? s.fontSize}" fill="${ink}" text-anchor="middle"` +
    `${o.weight ? ` font-weight="${o.weight}"` : ''}${o.italic ? ' font-style="italic"' : ''}${o.opacity !== undefined ? ` fill-opacity="${o.opacity}"` : ''}>${escapeXml(text)}</text>`;
  let geometry = '';
  let labels = '';
  switch (o.type) {
    case 'uml-class': {
      const hh = CLASS_HEADER(o);
      geometry += `<rect x="0" y="0" width="${n(o.w)}" height="${n(o.h)}" fill="${fill}" ${st}/>`;
      geometry += `<path d="M0 ${hh}H${n(o.w)}" ${st}/>`;
      const attrs = o.attributes || [];
      const ops = o.operations || [];
      const sepY = hh + 10 + Math.max(1, attrs.length) * CLASS_LINE;
      geometry += `<path d="M0 ${n(sepY)}H${n(o.w)}" ${st}/>`;
      if (!editing) {
        const isAbstract = o.stereotype === 'abstract';
        if (o.stereotype && o.stereotype !== 'abstract') {
          labels += label(`«${o.stereotype}»`, o.w / 2, 18, { size: 12, opacity: 0.75 });
        }
        const nameY = o.stereotype && o.stereotype !== 'abstract' ? 36 : hh / 2 + 5;
        labels += label(o.text || 'Class', o.w / 2, isAbstract ? hh / 2 + 5 : nameY, { weight: 700, italic: isAbstract });
        const member = (m: (typeof attrs)[number], y: number) =>
          `<text x="10" y="${n(y)}" font-family="${fam}" font-size="${s.fontSize - 1}" fill="${ink}"${m.isStatic ? ' text-decoration="underline"' : ''}${m.isAbstract ? ' font-style="italic"' : ''}>${escapeXml(memberToString(m))}</text>`;
        attrs.forEach((m, i) => (labels += member(m, hh + 8 + CLASS_LINE * i + 12)));
        ops.forEach((m, i) => (labels += member(m, sepY + 8 + CLASS_LINE * i + 12)));
      }
      break;
    }
    case 'uml-actor': {
      const cx = o.w / 2, headR = Math.min(o.w * 0.2, o.h * 0.1);
      const bodyTop = headR * 2 + 4, bodyBottom = o.h * 0.58, legBottom = o.h * 0.78;
      geometry += `<circle cx="${n(cx)}" cy="${n(headR + 2)}" r="${n(headR)}" fill="${fill}" ${st}/>`;
      geometry += `<path d="M${n(cx)} ${n(bodyTop)}V${n(bodyBottom)}M${n(o.w * 0.12)} ${n(o.h * 0.36)}H${n(o.w * 0.88)}M${n(cx)} ${n(bodyBottom)}L${n(o.w * 0.15)} ${n(legBottom)}M${n(cx)} ${n(bodyBottom)}L${n(o.w * 0.85)} ${n(legBottom)}" fill="none" ${st}/>`;
      if (!editing) labels += label(o.text || 'Actor', cx, o.h - 4);
      break;
    }
    case 'uml-usecase':
      geometry += `<ellipse cx="${n(o.w / 2)}" cy="${n(o.h / 2)}" rx="${n(o.w / 2)}" ry="${n(o.h / 2)}" fill="${fill}" ${st}/>`;
      if (!editing) labels += textBlock(o.text || '', { x: o.w * 0.15, y: o.h * 0.15, w: o.w * 0.7, h: o.h * 0.7 }, s, { shrink: true });
      break;
    case 'uml-lifeline': {
      const hh = 44;
      geometry += `<rect x="0" y="0" width="${n(o.w)}" height="${hh}" fill="${fill}" ${st}/>`;
      geometry += `<path d="M${n(o.w / 2)} ${hh}V${n(o.h)}" ${strokeAttrs(s.stroke, s.strokeWidth, 'dashed')}/>`;
      if (!editing) labels += textBlock(o.text || '', { x: 6, y: 4, w: o.w - 12, h: hh - 8 }, { ...s, fontWeight: 600 }, { shrink: true });
      break;
    }
    case 'uml-note': {
      const k = 14;
      geometry += `<path d="M0 0H${n(o.w - k)}L${n(o.w)} ${k}V${n(o.h)}H0Z" fill="${fill === '#FFFFFF' ? '#FFFBE6' : fill}" ${st}/>`;
      geometry += `<path d="M${n(o.w - k)} 0V${k}H${n(o.w)}" fill="none" ${st}/>`;
      if (!editing) labels += textBlock(o.text || '', { x: 10, y: 10, w: o.w - 28, h: o.h - 20 }, { ...s, align: 'left' }, { valign: 'top' });
      break;
    }
    case 'uml-package': {
      const tabW = Math.min(o.w * 0.45, Math.max(80, measure(o.text || '', fontCss(s.font, s.fontSize, 600)) + 24));
      geometry += `<path d="M0 0H${n(tabW)}V24H0Z" fill="${fill}" ${st}/>`;
      geometry += `<rect x="0" y="24" width="${n(o.w)}" height="${n(Math.max(0, o.h - 24))}" fill="${fill === '#FFFFFF' ? 'none' : fill}" ${st}/>`;
      if (!editing) labels += `<text x="10" y="17" font-family="${fam}" font-size="${s.fontSize - 1}" font-weight="600" fill="${ink}">${escapeXml(o.text || 'package')}</text>`;
      break;
    }
    case 'uml-state':
      geometry += `<rect x="0" y="0" width="${n(o.w)}" height="${n(o.h)}" rx="${n(Math.min(18, o.h / 2))}" fill="${fill}" ${st}/>`;
      if (!editing) labels += textBlock(o.text || '', { x: 10, y: 6, w: o.w - 20, h: o.h - 12 }, s, { shrink: true });
      break;
    case 'uml-initial':
      geometry += `<circle cx="${n(o.w / 2)}" cy="${n(o.h / 2)}" r="${n(Math.min(o.w, o.h) / 2)}" fill="${escapeXml(s.stroke === 'none' ? INK : s.stroke)}"/>`;
      break;
    case 'uml-final': {
      const r0 = Math.min(o.w, o.h) / 2;
      geometry += `<circle cx="${n(o.w / 2)}" cy="${n(o.h / 2)}" r="${n(r0 - 1)}" fill="${fill}" ${st}/>`;
      geometry += `<circle cx="${n(o.w / 2)}" cy="${n(o.h / 2)}" r="${n(r0 * 0.6)}" fill="${escapeXml(s.stroke === 'none' ? INK : s.stroke)}"/>`;
      break;
    }
    case 'uml-component': {
      geometry += `<rect x="0" y="0" width="${n(o.w)}" height="${n(o.h)}" fill="${fill}" ${st}/>`;
      const ix = o.w - 30;
      geometry += `<rect x="${n(ix)}" y="8" width="18" height="22" fill="${fill}" ${strokeAttrs(s.stroke, 1.25, 'solid')}/>`;
      geometry += `<rect x="${n(ix - 5)}" y="12" width="10" height="5" fill="${fill}" ${strokeAttrs(s.stroke, 1.25, 'solid')}/><rect x="${n(ix - 5)}" y="21" width="10" height="5" fill="${fill}" ${strokeAttrs(s.stroke, 1.25, 'solid')}/>`;
      if (!editing) labels += textBlock(`«component»\n${o.text || ''}`, { x: 10, y: 8, w: o.w - 50, h: o.h - 16 }, s, { shrink: true });
      break;
    }
  }
  return wrapG(o, mirroredContent(o, geometry) + labels, s.opacity);
}

/**
 * SVG markup for one object in world coordinates. The object, and every object a connector reads through `ctx.get`, is
 * read through safeObj first (src/safe-obj.ts, TAB-203): stored data reaches attributes here, and an exported SVG
 * opened on its own has no CSP to stop an attribute that broke out.
 */
export function objectMarkup(raw: Obj, rawCtx: MarkupCtx): string {
  const o = safeObj(raw);
  const ctx: MarkupCtx = { ...rawCtx, get: (id) => { const x = rawCtx.get(id); return x && safeObj(x); } };
  if (isConnector(o)) return connectorMarkup(o, ctx);
  switch (o.type) {
    case 'group': return '';
    case 'shape': return shapeMarkup(o, ctx);
    case 'sticky': return stickyMarkup(o, ctx);
    case 'text': return textMarkup(o, ctx);
    case 'frame': return frameMarkup(o);
    case 'tracker': return wrapG(o, renderTrackerFrame(o), styleOf(o).opacity);
    case 'icon': return iconMarkup(o);
    case 'image': return imageMarkup(o, ctx);
    case 'path': return pathMarkup(o);
    case 'container':
    case 'lane':
    case 'card': return containerMarkup(o, ctx);
    default:
      if (o.type.startsWith('uml-')) return umlMarkup(o, ctx);
      return '';
  }
}

export const SVG_DEFS =
  `<filter id="sticky-shadow" x="-10%" y="-10%" width="130%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="2.4" flood-color="#18212B" flood-opacity="0.16"/></filter>` +
  // adhesive strip slightly darker at the top, paper catching light lower down
  `<linearGradient id="sticky-sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0.05"/><stop offset="0.2" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#FFF" stop-opacity="0.06"/></linearGradient>` +
  `<filter id="sticky-curl-shadow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="1.8"/></filter>` +
  // folded flap: shaded at the crease (bottom right), lit toward its tip
  `<linearGradient id="sticky-flap" x1="1" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#000" stop-opacity="0.14"/><stop offset="0.4" stop-color="#FFF" stop-opacity="0.18"/><stop offset="1" stop-color="#FFF" stop-opacity="0.55"/></linearGradient>`;
