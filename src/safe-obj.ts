// A stored object in a shape the markup can trust (TAB-203). Board objects are Yjs data that any collaborator, file,
// template or tool can write, and much of each one ends up in SVG attributes on the canvas and in exported files: an
// exported SVG opened on its own has no CSP, so a stored `viewBox` of `0" onload="…` would run there. Everything that
// draws an object (src/markup.ts, the renderer's overlays, exports, thumbnails) reads it through `safeObj`: numbers are
// finite numbers, enumerations are one of their values, text is a string, a connector end is a free point or a bound id
// with a known anchor. What does not fit is dropped (the type's default applies) or replaced by a neutral value. Colours
// are left to `styleOf` (shared/colors.mjs), which knows each type's default.

import type { Obj, ProposedBy } from './types';
import { HEADS, SHAPE_KINDS } from './shapes';
import { RELATIONS } from './uml';
import { OWNER_KINDS, STAGES, isSafeHttpUrl } from '../shared/containers';

export { CARD_LINK_MAX, isSafeHttpUrl } from '../shared/containers';

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const KINDS = new Set<string>(SHAPE_KINDS.map((k) => k.kind));
const HEAD_SET = new Set<string>(HEADS.map((h) => h.head));
const ROUTES = new Set(['straight', 'elbow', 'curved']);
const DASHES = new Set(['solid', 'dashed', 'dotted']);
const ALIGNS = new Set(['left', 'center', 'right']);
const VALIGNS = new Set(['top', 'middle', 'bottom']);
const ANCHORS = new Set(['auto', 'top', 'right', 'bottom', 'left']);
const STAGE_SET = new Set<string>(STAGES);
const WIP_MODES = new Set(['warn', 'block']);
const OWNER_KIND_SET = new Set<string>(OWNER_KINDS);
const VISIBILITY = new Set(['+', '-', '#', '~', '']);
const TRACKER_VIEWS = new Set(['inbox', 'my', 'all', 'board', 'projects']);
const TRACKER_CATEGORIES = new Set(['backlog', 'unstarted', 'started', 'completed', 'canceled']);
/** Every enumerated object field and its values; the template file check (src/custom-templates.ts) uses it too. */
export const OBJ_ENUMS: Readonly<Record<string, ReadonlySet<string>>> = {
  kind: KINDS, route: ROUTES, startHead: HEAD_SET, endHead: HEAD_SET, dash: DASHES, align: ALIGNS, valign: VALIGNS,
  stage: STAGE_SET, wipMode: WIP_MODES, ownerKind: OWNER_KIND_SET, relation: new Set(Object.keys(RELATIONS)), view: TRACKER_VIEWS,
};

/** A font is a Fontshare slug or `system`; it is used in a font-family attribute and a CSS font shorthand. */
const FONT_RE = /^[a-z0-9-]{1,64}$/;

/** Fields that every box has: a non-finite value becomes 0. */
const REQUIRED_NUMBERS = ['x', 'y', 'w', 'h', 'rotation'];
/** Optional numbers: a non-finite value is dropped, so the default applies. */
const OPTIONAL_NUMBERS = ['strokeWidth', 'opacity', 'fontSize', 'fontWeight', 'nw', 'nh', 'laneW', 'wip', 'updatedAt'];
/** Free text, drawn only as escaped text content or an escaped attribute: anything but a string is dropped. */
const TEXTS = ['text', 'name', 'label', 'stereotype', 'alt', 'desc', 'ownerName', 'ownerId', 'due', 'link', 'body', 'ref', 'asset', 'mime', 'parent', 'layout', 'rank', 'createdBy', 'privateStep', 'z', 'trackerId', 'viewId', 'focusKey'];
/** Enumerations and their sets: a value outside the set is dropped. */
const ENUMS: [string, Set<string>][] = [
  ['dash', DASHES], ['align', ALIGNS], ['valign', VALIGNS], ['stage', STAGE_SET], ['wipMode', WIP_MODES], ['ownerKind', OWNER_KIND_SET],
  ['relation', new Set(Object.keys(RELATIONS))], ['view', TRACKER_VIEWS],
];

function end(e: unknown): { kind: 'free'; x: number; y: number } | { kind: 'bound'; id: string; anchor: 'auto' | 'top' | 'right' | 'bottom' | 'left' } {
  const r = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
  if (r.kind === 'bound' && typeof r.id === 'string') {
    return { kind: 'bound', id: r.id, anchor: (typeof r.anchor === 'string' && ANCHORS.has(r.anchor) ? r.anchor : 'auto') as 'auto' };
  }
  return { kind: 'free', x: finite(r.x) ? r.x : 0, y: finite(r.y) ? r.y : 0 };
}

function members(v: unknown) {
  if (!Array.isArray(v)) return [];
  return v
    .filter((m) => m && typeof m === 'object')
    .map((m: Record<string, unknown>) => ({
      visibility: typeof m.visibility === 'string' && VISIBILITY.has(m.visibility) ? m.visibility : '',
      name: typeof m.name === 'string' ? m.name : '',
      type: typeof m.type === 'string' ? m.type : '',
      ...(m.isStatic === true ? { isStatic: true } : {}),
      ...(m.isAbstract === true ? { isAbstract: true } : {}),
    }));
}

const PROPOSED_FEATURES = new Set(['generate', 'summarise', 'cluster']);
const PERSON_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TRACKER_FIELD_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TRACKER_KEY_RE = /^[A-Za-z]{2,5}-[1-9][0-9]{0,18}$/i;
export const PROPOSED_NAME_MAX = 40;

/** Removes control, zero-width, bidirectional and tag characters, the ones that change how text reads but are not seen. Tabs and line breaks stay, for the caller's whitespace collapse. */
function visibleText(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) {
      out += ch;
      continue;
    }
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x2028 && cp <= 0x202e) || (cp >= 0x2060 && cp <= 0x2069) || cp === 0xfeff || (cp >= 0xe0000 && cp <= 0xe007f)) continue;
    out += ch;
  }
  return out;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cleanTrackerProjection(value: unknown): Record<string, unknown> | undefined {
  if (!record(value)) return undefined;
  const ticketId = typeof value.ticketId === 'string' && TRACKER_FIELD_RE.test(value.ticketId) ? value.ticketId : undefined;
  if (!ticketId) return undefined;
  const title = typeof value.title === 'string' ? [...visibleText(value.title).replace(/\s+/g, ' ').trim()].slice(0, 200).join('') : '';
  const state = record(value.state) ? value.state : {};
  const cleanState = typeof state.name === 'string' && typeof state.category === 'string' && TRACKER_CATEGORIES.has(state.category)
    ? {
      ...(typeof state.id === 'string' && TRACKER_FIELD_RE.test(state.id) ? { id: state.id } : {}),
      ...(typeof state.key === 'string' && TRACKER_FIELD_RE.test(state.key) ? { key: state.key } : {}),
      name: [...visibleText(state.name).replace(/\s+/g, ' ').trim()].slice(0, 80).join(''),
      category: state.category,
    }
    : undefined;
  return { ticketId, title, ...(cleanState ? { state: cleanState } : {}) };
}

function cleanContainerTrackerExt(value: unknown): Record<string, unknown> | undefined {
  if (!record(value) || value.provider !== 'tabula' || typeof value.tracker !== 'string' || !TRACKER_FIELD_RE.test(value.tracker)
    || !record(value.map)) return undefined;
  const map: Record<string, string> = {};
  for (const [laneId, stateKey] of Object.entries(value.map)) {
    if (!TRACKER_FIELD_RE.test(laneId) || typeof stateKey !== 'string' || !TRACKER_FIELD_RE.test(stateKey)) continue;
    map[laneId] = stateKey;
  }
  return { provider: 'tabula', tracker: value.tracker, map };
}

/**
 * A stored `proposedBy` (TAB-160) in its one allowed shape, or undefined. Like every stored field it can come from any
 * collaborator, file or tool: the feature must be one of the three, the id a plain id, the name one line of at most 40
 * visible characters, shown as text only. Anything else in it is dropped.
 */
export function cleanProposedBy(v: unknown): ProposedBy | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r.feature !== 'string' || !PROPOSED_FEATURES.has(r.feature)) return undefined;
  const by = r.by && typeof r.by === 'object' && !Array.isArray(r.by) ? (r.by as Record<string, unknown>) : {};
  const id = typeof by.id === 'string' && PERSON_ID_RE.test(by.id) ? by.id : null;
  const raw = typeof by.name === 'string' ? visibleText(by.name).replace(/\s+/g, ' ').trim() : '';
  const name = raw ? [...raw].slice(0, PROPOSED_NAME_MAX).join('').trim() || null : null;
  return { feature: r.feature as ProposedBy['feature'], by: { id, name } };
}

/**
 * `o` with every field the markup reads in a type-safe form (see the top of this file). A fresh shallow copy each time
 * (not memoised: some callers build an object and change it before drawing it again).
 */
export function safeObj<T extends Obj>(o: T): T {
  if (!o || typeof o !== 'object') return o;
  const out = { ...o } as Record<string, unknown>;
  out.id = typeof o.id === 'string' ? o.id : String(o.id ?? '');
  if (o.type === 'connector') {
    out.from = end(out.from);
    out.to = end(out.to);
    out.route = typeof out.route === 'string' && ROUTES.has(out.route) ? out.route : 'straight';
    for (const k of ['startHead', 'endHead']) out[k] = typeof out[k] === 'string' && HEAD_SET.has(out[k] as string) ? out[k] : 'none';
  } else {
    for (const k of REQUIRED_NUMBERS) out[k] = finite(out[k]) ? out[k] : 0;
  }
  if (o.type === 'connector') for (const k of REQUIRED_NUMBERS) if (k in out && !finite(out[k])) delete out[k];
  for (const k of OPTIONAL_NUMBERS) if (k in out && !finite(out[k])) delete out[k];
  for (const k of TEXTS) if (k in out && typeof out[k] !== 'string') delete out[k];
  for (const [k, set] of ENUMS) if (k in out && !(typeof out[k] === 'string' && set.has(out[k] as string))) delete out[k];
  for (const k of ['trackerId', 'viewId', 'focusKey']) if (k in out && !(typeof out[k] === 'string' && TRACKER_FIELD_RE.test(out[k] as string))) delete out[k];
  if (o.type === 'card') {
    if (out.extProvider !== 'tabula') delete out.extProvider;
    if (typeof out.extKey !== 'string' || !TRACKER_KEY_RE.test(out.extKey)) delete out.extKey;
    if (typeof out.extUrl !== 'string' || !isSafeHttpUrl(out.extUrl)) delete out.extUrl;
    const projection = cleanTrackerProjection(out.tracker);
    if (projection) out.tracker = projection;
    else delete out.tracker;
  } else {
    delete out.extProvider;
    delete out.extKey;
    delete out.extUrl;
    delete out.tracker;
  }
  if (o.type === 'container') {
    const ext = cleanContainerTrackerExt(out.ext);
    if (ext) out.ext = ext;
    else delete out.ext;
  } else delete out.ext;
  if ('link' in out && !isSafeHttpUrl(out.link)) delete out.link;
  if ('kind' in out && !(typeof out.kind === 'string' && KINDS.has(out.kind))) out.kind = 'rect';
  if ('font' in out && !(typeof out.font === 'string' && FONT_RE.test(out.font))) delete out.font;
  if ('points' in out) out.points = Array.isArray(out.points) && out.points.every(finite) ? out.points : [];
  if ('viewBox' in out && !(Array.isArray(out.viewBox) && out.viewBox.length === 4 && out.viewBox.every(finite))) delete out.viewBox;
  if ('attributes' in out) out.attributes = members(out.attributes);
  if ('operations' in out) out.operations = members(out.operations);
  if ('labels' in out && !(Array.isArray(out.labels) && out.labels.every((l) => typeof l === 'string'))) delete out.labels;
  for (const k of ['locked', 'sticker', 'hidden', 'flipX', 'flipY']) if (k in out && typeof out[k] !== 'boolean') delete out[k];
  if (o.type === 'connector' || o.type === 'group') {
    delete out.flipX;
    delete out.flipY;
  }
  if (o.type === 'tracker') out.rotation = 0;
  if (o.type === 'tracker') {
    out.w = Math.max(480, out.w as number);
    out.h = Math.max(360, out.h as number);
  }
  if (o.type === 'card') {
    if (!out.ownerId && !out.ownerName) delete out.ownerKind;
    // Free-text owners are people. A racing kind-only write must not make one look like a token-owned agent.
    else if (out.ownerKind === 'agent' && !out.ownerId) delete out.ownerKind;
  }
  if ('proposedBy' in out) {
    const clean = cleanProposedBy(out.proposedBy);
    if (clean) out.proposedBy = clean;
    else delete out.proposedBy;
  }
  return out as unknown as T;
}
