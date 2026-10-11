// The container model (docs/kanban.md): fractional ranks, ordering, derived layout and the WIP check. Pure functions
// with no I/O and no DOM, imported by the browser (src/store.ts) and by the MCP server (server/board-ops.mjs), so both
// give the same answer. shared/containers.d.ts carries the types for TypeScript; the Dockerfile copies this folder.

import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { safeColor } from './colors.mjs';

/**
 * @typedef {{ x: number, y: number, w: number, h: number }} Rect
 * @typedef {{ id: string, parent?: string, rank?: string, updatedAt?: number }} Ranked
 * @typedef {{ id: string, parent: string, rank: string }} RankPatch
 * @typedef {{ layout: string, w: number, h: number, rects: Map<string, Rect>, lanes: string[], cards: Map<string, string[]>, order: string[], addLane: Rect }} ContainerLayout
 */

export const CONTAINER_TYPES = Object.freeze(['container', 'lane', 'card']);
export const isContainerType = (type) => CONTAINER_TYPES.includes(type);

/** Card owner kinds, shared by the browser, the MCP reader and the MCP writer. */
export const OWNER_KINDS = Object.freeze(['person', 'agent']);
/** Lane stages, shared by the browser and the MCP tools. */
export const STAGES = Object.freeze(['todo', 'doing', 'done']);
/** The lanes the app puts in a new kanban. */
export const DEFAULT_KANBAN_LANES = Object.freeze([
  Object.freeze({ name: 'To do', stage: STAGES[0] }),
  Object.freeze({ name: 'Doing', stage: STAGES[1] }),
  Object.freeze({ name: 'Done', stage: STAGES[2] }),
]);
export const CARD_LINK_MAX = 2000;
export const OWNER_NAME_MAX = 80;

/** Collapse whitespace and trim a card title. Line breaks are whitespace and become spaces. */
export function cleanCardTitle(value) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

/** Collapse whitespace and trim an owner name. */
export function cleanOwnerName(value) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

/** Count Unicode code points, matching the user-visible title and owner-name limits. */
export function codePointLength(value) {
  return [...value].length;
}

/** A single explicit, visible HTTP(S) URL of at most 2,000 characters; credentials and deceptive userinfo are refused. */
export function isSafeHttpUrl(value) {
  if (typeof value !== 'string' || !value || value.length > CARD_LINK_MAX || /[\p{White_Space}\p{Cc}\p{Cf}\\]/u.test(value)) return false;
  if (!/^https?:\/\/[^/?#]+/i.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** A real calendar date in YYYY-MM-DD format, limited to years 1900 through 2200. */
export function isDueDate(value) {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Board features this code understands. A board that lists another one opens read-only (docs/kanban.md, Version skew). */
export const FEATURES = Object.freeze({ containers: 'containers', tracker: 'tracker' });
export const KNOWN_FEATURES = Object.freeze(Object.values(FEATURES));

/**
 * A feature is one key of the board's meta map, `feature:<name>` = true, so two clients that add different features at
 * the same moment both keep theirs (one array under one key would keep only the last write).
 */
export const FEATURE_PREFIX = 'feature:';
export const featureKey = (name) => `${FEATURE_PREFIX}${name}`;
/** The meta keys that say what the board needs: never part of a board setting that history restores or removes. */
export const isFeatureKey = (key) => key === 'features' || key.startsWith(FEATURE_PREFIX);

/**
 * The features a board's meta (as plain JSON) lists, sorted. A `feature:` key counts unless it is false or empty. The
 * first form was a `features` array; it is still read, and anything else under that key is listed as `features` so
 * that it is unknown. Reading fails closed: what cannot be understood is a feature this code does not know.
 */
export function featuresOf(meta) {
  if (!meta || typeof meta !== 'object') return [];
  const names = new Set();
  for (const [key, value] of Object.entries(meta)) {
    if (key.startsWith(FEATURE_PREFIX) && value !== false && value !== null && value !== undefined) names.add(key.slice(FEATURE_PREFIX.length));
  }
  const legacy = meta.features;
  if (Array.isArray(legacy)) for (const f of legacy) names.add(typeof f === 'string' ? f : 'features');
  else if (legacy !== undefined && legacy !== null) names.add('features');
  return [...names].sort();
}

/** The features in a board's meta that this code does not know. */
export function unknownFeatures(meta) {
  return featuresOf(meta).filter((f) => !KNOWN_FEATURES.includes(f));
}

export const LIMITS = Object.freeze({
  containers: 50,
  lanes: 20,
  cardsPerLane: 500,
  cards: 2000,
  title: 200,
  description: 4000,
  labels: 30,
  labelsPerCard: 10,
  labelName: 40,
  laneName: 60,
  containerName: 80,
  laneWMin: 200,
  laneWMax: 480,
  wipMin: 1,
  wipMax: 99,
});

/** A label name as stored by the app: whitespace collapsed, trimmed and capped at 40 Unicode code points. */
export function cleanLabelName(value) {
  return typeof value === 'string' ? [...value.replace(/\s+/g, ' ').trim()].slice(0, LIMITS.labelName).join('').trim() : '';
}

/** A lane name as stored by the app: whitespace collapsed, trimmed and capped at 60 characters. */
export function cleanLaneName(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, LIMITS.laneName).trim() : '';
}

/** Whether a normalized label name is already used, ignoring case and optionally the label being renamed. */
export function labelNameTaken(labels, name, exceptId = null) {
  const normalized = cleanLabelName(name).toLowerCase();
  if (!normalized) return false;
  for (const label of labels) {
    if (label?.id !== exceptId && typeof label?.name === 'string' && cleanLabelName(label.name).toLowerCase() === normalized) return true;
  }
  return false;
}

/** A lane stage accepted by the board UI and MCP. */
export const isLaneStage = (value) => STAGES.includes(value);

/** A WIP limit accepted by the lane editor. */
export const isWipLimit = (value) => Number.isInteger(value) && value >= LIMITS.wipMin && value <= LIMITS.wipMax;

/** A label colour accepted by the board UI, canonicalized by the shared safe colour grammar. */
export const validLabelColor = (value) => kanbanColor(value, null);

/** Palette keys for board labels: the sticky swatches (a test keeps them equal to src/palette.ts), coloured by theme tokens. */
export const LABEL_COLORS = Object.freeze(['yellow', 'orange', 'pink', 'violet', 'blue', 'teal', 'green', 'grey']);

/**
 * A lane's or card's `fill`, a label's `color` or an owner's colour as the kanban may draw it: a palette key (any case,
 * given back in lower case, drawn as its sticky swatch) or a colour `safeColor` accepts in canonical form; anything else,
 * and `none` or `transparent` (which would hide a lane or a chip), gives `fallback`. The value ends up in a style
 * attribute, so this is the one check for every one of them, at render and wherever they are read or written.
 * @param {unknown} value
 * @param {string | null} [fallback] a palette key or null
 * @returns {string | null}
 */
export function kanbanColor(value, fallback = null) {
  if (typeof value === 'string' && LABEL_COLORS.includes(value.toLowerCase())) return value.toLowerCase();
  const c = safeColor(value, null);
  return c === null || c === 'none' || c === 'transparent' ? fallback : c;
}

/** The colour a label without a usable one shows. */
export const LABEL_DEFAULT_COLOR = 'grey';

/**
 * A board label as it may be used, or null: an id and a name of at most 40 Unicode code points; a colour that `kanbanColor`
 * refuses becomes the default one. Anything read from the `labels` map goes through this first, since any client can write that map.
 * @returns {{ id: string, name: string, color: string, order: number } | null}
 */
export function validLabel(value) {
  if (!value || typeof value !== 'object') return null;
  const { id, name, color, order } = value;
  if (typeof id !== 'string' || !id || typeof name !== 'string' || codePointLength(name) > LIMITS.labelName) return null;
  return { id, name, color: kanbanColor(color, LABEL_DEFAULT_COLOR), order: Number.isFinite(order) ? order : 0 };
}

// ---------------------------------------------------------------- ranks

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function validKey(key) {
  if (!/^[A-Za-z][0-9A-Za-z]*$/.test(key)) return false;
  try {
    generateKeyBetween(key, null);
    return true;
  } catch {
    return false;
  }
}

/**
 * A stored rank is `<key>@<parentId>`. Ids and keys never contain `@`, so the first one splits them. Null when the
 * value is not a rank at all.
 */
export function splitRank(rank) {
  if (typeof rank !== 'string') return null;
  const at = rank.indexOf('@');
  if (at < 1 || at === rank.length - 1) return null;
  const key = rank.slice(0, at);
  return validKey(key) ? { key, parent: rank.slice(at + 1) } : null;
}

/** The key of a stored rank, of a bare key, or null for nothing or garbage. */
function keyOf(rank) {
  if (rank === null || rank === undefined) return null;
  const split = splitRank(rank);
  if (split) return split.key;
  return typeof rank === 'string' && validKey(rank) ? rank : null;
}

/** A key between two neighbours, written as a rank for `parentId`. Either neighbour may be a stored rank, a bare key or nothing. */
export function rankBetween(prev, next, parentId) {
  return `${generateKeyBetween(keyOf(prev), keyOf(next))}@${parentId}`;
}

/** `n` ascending ranks between two neighbours, for moving several children at once. */
export function ranksBetween(prev, next, n, parentId) {
  return generateNKeysBetween(keyOf(prev), keyOf(next), n).map((key) => `${key}@${parentId}`);
}

/**
 * True when the rank does not agree with the parent: no rank, a rank that is not one, or a suffix naming another
 * parent. That is what two people moving one card at the same moment can leave behind (docs/kanban.md, Concurrent edits).
 */
export function isMixedRank(child) {
  const split = splitRank(child.rank);
  return !split || split.parent !== child.parent;
}

/** Children in display order: by key, then id. Children with a mixed rank go last, by `updatedAt` then id. */
export function sortedChildren(children) {
  const good = [];
  const mixed = [];
  for (const child of children) {
    if (isMixedRank(child)) mixed.push(child);
    else good.push({ child, key: splitRank(child.rank).key });
  }
  good.sort((a, b) => byText(a.key, b.key) || byText(a.child.id, b.child.id));
  mixed.sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0) || byText(a.id, b.id));
  return [...good.map((g) => g.child), ...mixed];
}

/**
 * Children in the order a parent shows them: its own by rank, then the strays attributed to it (cards whose lane is
 * gone), also by rank.
 */
function displayOrder(children, parentId) {
  const own = [];
  const strays = [];
  for (const child of children) (child.parent === parentId ? own : strays).push(child);
  return [...sortedChildren(own), ...sortedChildren(strays)];
}

/**
 * Whether the children of one parent need fresh keys before something is inserted: a mixed rank, two equal keys or,
 * when `parentId` is given, a child that names another parent (a stray that has to be adopted).
 */
export function needsNormalising(children, parentId) {
  let last = null;
  for (const child of sortedChildren(children)) {
    if (isMixedRank(child) || (parentId !== undefined && child.parent !== parentId)) return true;
    const key = splitRank(child.rank).key;
    if (key === last) return true;
    last = key;
  }
  return false;
}

/** Fresh, evenly spaced ranks for all children of one parent, in their display order. Also gives each the parent. */
export function normaliseRanks(children, parentId) {
  const sorted = displayOrder(children, parentId);
  const keys = generateNKeysBetween(null, null, sorted.length);
  return sorted.map((child, i) => ({ id: child.id, parent: parentId, rank: `${keys[i]}@${parentId}` }));
}

/**
 * Where `count` children go when they are inserted at `index` among `children` (the children of the target parent,
 * leaving out the ones being moved). Returns their ranks and, when the target needed it, the patches that normalise
 * the existing children first. The writer applies both in one transaction.
 * @returns {{ ranks: string[], repairs: RankPatch[] }}
 */
export function planInsert(children, parentId, index, count = 1) {
  let list = displayOrder(children, parentId);
  let repairs = [];
  if (needsNormalising(children, parentId)) {
    repairs = normaliseRanks(children, parentId);
    const ranks = new Map(repairs.map((p) => [p.id, p.rank]));
    list = list.map((c) => ({ ...c, parent: parentId, rank: ranks.get(c.id) }));
  }
  const at = Math.min(Math.max(Math.trunc(index) || 0, 0), list.length);
  return { ranks: ranksBetween(list[at - 1]?.rank ?? null, list[at]?.rank ?? null, count, parentId), repairs };
}

// ---------------------------------------------------------------- layout

/**
 * Kanban constants, in CSS pixels at zoom 1. The first group is the spec's (docs/kanban.md, Layout); the second is the
 * visual design's (Visual design, Anatomy).
 */
export const KANBAN = Object.freeze({
  laneW: 280,
  laneGap: 16,
  pad: 12,
  header: 48,
  cardGap: 8,
  minBody: 160,
  // the container's header band, with its 2px rule inside the 48
  containerHeader: 48,
  // between a lane's edge and its cards, on all four sides
  lanePad: 8,
  // under the tallest lane's last card; every lane is as tall as the tallest plus this
  dropZone: 56,
  // the column with the add-lane button, right of the last lane
  addLaneGap: 8,
  addLaneW: 32,
  // the dashed "No cards" box in an empty lane
  emptyLane: 56,
  // a card whose stored height is missing
  cardH: 72,
});

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function cardHeight(card) {
  return finite(card.h) && card.h > 0 ? card.h : KANBAN.cardH;
}

function laneWidth(container) {
  const w = finite(container.laneW) ? container.laneW : KANBAN.laneW;
  return Math.min(Math.max(w, LIMITS.laneWMin), LIMITS.laneWMax);
}

/**
 * Below the container header, lanes run left to right by rank and cards stack top to bottom by rank. The container is as
 * wide as its lanes and the add-lane column, and as tall as the header plus its tallest lane plus a drop zone; every
 * lane has that height. A card's height is its stored `h`, so no client measures text. Cards whose parent is not one of
 * `lanes` go to the end of the first lane.
 */
function layoutKanban(container, lanes, cards) {
  const { laneGap, pad, header, cardGap, minBody, containerHeader, lanePad, dropZone, addLaneGap, addLaneW } = KANBAN;
  const cx = finite(container.x) ? container.x : 0;
  const cy = finite(container.y) ? container.y : 0;
  const laneW = laneWidth(container);
  const ordered = sortedChildren(lanes);
  const laneIds = new Set(ordered.map((l) => l.id));

  const perLane = new Map(ordered.map((l) => [l.id, []]));
  const strays = [];
  for (const card of cards) (laneIds.has(card.parent) ? perLane.get(card.parent) : strays).push(card);
  const stacks = ordered.map((l) => sortedChildren(perLane.get(l.id)));
  if (stacks.length) stacks[0].push(...sortedChildren(strays));

  let body = minBody;
  for (const stack of stacks) {
    const content = stack.reduce((sum, c) => sum + cardHeight(c) + cardGap, 0);
    body = Math.max(body, lanePad + content + dropZone + lanePad);
  }
  const laneH = header + body;
  const count = Math.max(ordered.length, 1);
  const lanesW = count * laneW + (count - 1) * laneGap;
  const w = pad + lanesW + addLaneGap + addLaneW + pad;
  const h = containerHeader + pad + laneH + pad;
  const top = cy + containerHeader + pad;

  const rects = new Map([[container.id, { x: cx, y: cy, w, h }]]);
  const cardIds = new Map();
  const order = [];
  ordered.forEach((lane, i) => {
    rects.set(lane.id, { x: cx + pad + i * (laneW + laneGap), y: top, w: laneW, h: laneH });
    order.push(lane.id);
  });
  ordered.forEach((lane, i) => {
    const lx = cx + pad + i * (laneW + laneGap);
    let y = top + header + lanePad;
    const ids = [];
    for (const card of stacks[i]) {
      const ch = cardHeight(card);
      rects.set(card.id, { x: lx + lanePad, y, w: laneW - lanePad * 2, h: ch });
      y += ch + cardGap;
      ids.push(card.id);
    }
    cardIds.set(lane.id, ids);
    order.push(...ids);
  });
  const addLane = { x: cx + pad + lanesW + addLaneGap, y: top + (header - addLaneW) / 2, w: addLaneW, h: addLaneW };
  return { layout: 'kanban', w, h, rects, lanes: ordered.map((l) => l.id), cards: cardIds, order, addLane };
}

/** A layout is a function plus an entry here; a container whose `layout` is not listed is not laid out. */
const LAYOUTS = { kanban: layoutKanban };

export const hasLayout = (name) => typeof name === 'string' && Object.hasOwn(LAYOUTS, name);

/**
 * The rectangle of a container and of everything in it, from stored fields only. `lanes` are its lane children and
 * `cards` the cards in those lanes plus any card the caller attributes to this container (see orphanHome). Null when the
 * layout is unknown. The result is a pure function of its input, whatever order the input comes in.
 * @returns {ContainerLayout | null}
 */
export function layoutContainer(container, lanes, cards) {
  return hasLayout(container.layout) ? LAYOUTS[container.layout](container, lanes, cards) : null;
}

/**
 * Cards whose lane has been deleted have nothing in the document that links them to a container, so they are shown in
 * the first lane of one container for everybody: the one lowest in paint order that has a known layout. Null when there is none.
 */
export function orphanHome(containers) {
  let home = null;
  for (const c of containers) {
    if (!hasLayout(c.layout)) continue;
    const z = typeof c.z === 'string' ? c.z : '';
    if (home === null || z < home.z || (z === home.z && c.id < home.id)) home = { id: c.id, z };
  }
  return home ? home.id : null;
}

/**
 * Every container's layout for a whole list of board objects, for readers that have no Store (the MCP server). Also the
 * reference the Store's incremental layout is tested against.
 * @returns {{ layouts: Map<string, ContainerLayout>, rects: Map<string, Rect> }}
 */
export function layoutAll(objects) {
  const byId = new Map();
  const childrenOf = new Map();
  for (const o of objects) {
    byId.set(o.id, o);
    if (typeof o.parent === 'string') {
      const list = childrenOf.get(o.parent);
      if (list) list.push(o);
      else childrenOf.set(o.parent, [o]);
    }
  }
  const containers = [...byId.values()].filter((o) => o.type === 'container');
  const home = orphanHome(containers);
  const strays = [...byId.values()].filter((o) => o.type === 'card' && typeof o.parent === 'string' && !byId.has(o.parent));

  const layouts = new Map();
  const rects = new Map();
  for (const container of containers) {
    // a hidden lane or card leaves the layout, as in the Store (TAB-198)
    const lanes = (childrenOf.get(container.id) ?? []).filter((o) => o.type === 'lane' && o.hidden !== true);
    const cards = lanes.flatMap((l) => (childrenOf.get(l.id) ?? []).filter((o) => o.type === 'card' && o.hidden !== true));
    if (container.id === home) cards.push(...strays.filter((o) => o.hidden !== true));
    const layout = layoutContainer(container, lanes, cards);
    if (!layout) continue;
    layouts.set(container.id, layout);
    for (const [id, r] of layout.rects) rects.set(id, r);
  }
  return { layouts, rects };
}

// ---------------------------------------------------------------- WIP

/**
 * Whether `moving` may be dropped into `lane`, which holds `cards`. Only cards arriving from elsewhere count, so moving
 * within the lane or out of an over-full lane is never refused. The limit is a client-side courtesy: two people who each
 * drop one card into the last free place both succeed (docs/kanban.md, WIP limits).
 * @returns {{ ok: boolean, over: boolean, count: number, limit: number | null, mode: 'warn' | 'block' }}
 */
export function wipCheck(lane, cards, moving) {
  const limit = Number.isInteger(lane.wip) && lane.wip >= LIMITS.wipMin && lane.wip <= LIMITS.wipMax ? lane.wip : null;
  const mode = lane.wipMode === 'block' ? 'block' : 'warn';
  const here = new Set(cards.map((c) => c.id));
  const incoming = new Set([...moving].filter((id) => !here.has(id))).size;
  const count = here.size + incoming;
  const over = limit !== null && count > limit;
  return { ok: !(over && mode === 'block' && incoming > 0), over, count, limit, mode };
}

// ---------------------------------------------------------------- templates (docs/kanban.md, Templates)

/**
 * Card fields a template never carries: it names no people or agents, no due dates or card links, and tracker links are
 * reserved. Saving a template strips them; a template that has them anyway is refused.
 */
export const TEMPLATE_STRIPPED = Object.freeze([
  'ownerId', 'ownerName', 'ownerKind', 'due', 'link', 'extProvider', 'extKey', 'extUrl', 'trackerId', 'tracker', 'ext', 'trackerUnmappedState',
]);

const TEMPLATE_ID = /^[A-Za-z0-9_-]{1,64}$/;
// on one line: no control character and no line or paragraph separator
const LINE_BREAK = /\p{Cc}|[\u2028\u2029]/u;
/** A control character other than tab, line feed and carriage return. */
const hasControl = (v) => [...v].some((ch) => {
  const cp = ch.codePointAt(0);
  return cp <= 0x08 || cp === 0x0b || cp === 0x0c || (cp >= 0x0e && cp <= 0x1f) || (cp >= 0x7f && cp <= 0x9f);
});

class TemplateKanbanError extends Error {}
const refuse = (message) => {
  throw new TemplateKanbanError(message);
};

function line(v, what, max, min = 1, length = (value) => value.length) {
  if (typeof v !== 'string' || v.trim().length < min || length(v) > max || LINE_BREAK.test(v)) refuse(`${what} must be text of ${min ? `1 to ${max}` : `at most ${max}`} characters, on one line.`);
  return v;
}

function intIn(v, what, min, max) {
  if (!Number.isInteger(v) || v < min || v > max) refuse(`${what} must be a whole number from ${min} to ${max}.`);
  return v;
}

/**
 * A template's label list (docs/kanban.md, Templates: a small list merged by name into the board's labels when the
 * template is used), checked and rebuilt: at most 30, each an id, a name of 1 to 40 Unicode code points on one line and a
 * colour `kanbanColor` accepts. Throws an Error naming what is wrong.
 * @returns {{ id: string, name: string, color: string }[]}
 */
export function templateLabels(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) refuse('content.labels must be a list.');
  if (list.length > LIMITS.labels) refuse(`A template can hold at most ${LIMITS.labels} labels.`);
  const ids = new Set();
  return list.map((l, i) => {
    const what = `Label ${i + 1}`;
    if (!l || typeof l !== 'object' || Array.isArray(l)) refuse(`${what} is not an object.`);
    if (typeof l.id !== 'string' || !TEMPLATE_ID.test(l.id)) refuse(`${what} needs an id of 1 to 64 letters, digits, - or _.`);
    if (ids.has(l.id)) refuse('Two labels share an id.');
    ids.add(l.id);
    const color = kanbanColor(l.color);
    if (color === null) refuse(`${what} has a colour the board cannot draw.`);
    return { id: l.id, name: line(l.name, `${what} name`, LIMITS.labelName, 1, codePointLength), color };
  });
}

/**
 * The kanban fields of a container, lane or card in a template, checked one by one and rebuilt (docs/kanban.md,
 * Templates): a container's layout, name and lane width; a lane's name, rank, stage, colour and WIP limit; a card's
 * title (one line, at most 200), description (at most 4,000), colour, rank and labels (ids from the template's own label
 * list, at most 10). A lane sits in a container of the template and a card in a lane of it or nowhere; a rank is a real
 * key that names its parent. Owners, due dates and the reserved tracker fields are refused. Colours go through
 * `kanbanColor`. `types` maps the template's ids to types. Throws an Error naming what is wrong.
 * @param {Record<string, unknown>} o
 * @param {string} what how the object is named in a message, e.g. `Object 3`
 * @param {{ types: Map<string, string>, labels: Set<string> }} ctx
 * @returns {Record<string, unknown>} only the kanban fields to keep (the common ones are the caller's)
 */
export function templateKanbanFields(o, what, ctx) {
  for (const key of TEMPLATE_STRIPPED) if (o[key] !== undefined) refuse(`${what} has ${key === 'due' ? 'a due date' : key.startsWith('owner') ? 'an owner' : `a ${key}`}, which a template cannot hold.`);
  const parentType = typeof o.parent === 'string' ? ctx.types.get(o.parent) : undefined;
  const out = {};
  if (o.fill !== undefined) {
    const fill = kanbanColor(o.fill);
    if (fill === null) refuse(`${what} has a colour the board cannot draw.`);
    out.fill = fill;
  }
  const rank = () => {
    const split = splitRank(o.rank);
    if (!split || split.parent !== o.parent) refuse(`${what} has a rank that does not name its parent.`);
    out.rank = o.rank;
  };
  if (o.type === 'container') {
    if (o.parent !== undefined && parentType !== 'frame' && parentType !== 'group') refuse(`${what} is a kanban whose parent is not a frame or group in the template.`);
    if (!hasLayout(o.layout)) refuse(`${what} has a layout this Tabula does not know.`);
    out.layout = o.layout;
    if (o.name !== undefined) out.name = line(o.name, `${what} name`, LIMITS.containerName, 0);
    if (o.laneW !== undefined) out.laneW = intIn(o.laneW, `${what} lane width`, LIMITS.laneWMin, LIMITS.laneWMax);
    if (o.rank !== undefined) refuse(`${what} is a kanban, which has no rank.`);
  } else if (o.type === 'lane') {
    if (parentType !== 'container') refuse(`${what} is a lane that is not in a kanban of the template.`);
    rank();
    if (o.name !== undefined) out.name = line(o.name, `${what} name`, LIMITS.laneName, 0);
    if (o.stage !== undefined) {
      if (o.stage !== 'todo' && o.stage !== 'doing' && o.stage !== 'done') refuse(`${what} stage is not one of todo, doing, done.`);
      out.stage = o.stage;
    }
    if (o.wip !== undefined) out.wip = intIn(o.wip, `${what} WIP limit`, LIMITS.wipMin, LIMITS.wipMax);
    if (o.wipMode !== undefined) {
      if (o.wipMode !== 'warn' && o.wipMode !== 'block') refuse(`${what} WIP mode is not one of warn, block.`);
      if (out.wip === undefined) refuse(`${what} has a WIP mode but no limit.`);
      out.wipMode = o.wipMode;
    }
  } else if (o.type === 'card') {
    if (o.parent !== undefined) {
      if (parentType === 'group') {
        if (o.rank !== undefined) refuse(`${what} is a grouped card, which has no rank.`);
      } else {
        if (parentType !== 'lane') refuse(`${what} is a card whose parent is not a lane or group in the template.`);
        rank();
      }
    } else if (o.rank !== undefined) refuse(`${what} is a loose card, which has no rank.`);
    if (o.text !== undefined) out.text = line(o.text, `${what} title`, LIMITS.title, 0);
    if (o.desc !== undefined) {
      if (typeof o.desc !== 'string' || o.desc.length > LIMITS.description || hasControl(o.desc)) refuse(`${what} description must be text of at most ${LIMITS.description} characters.`);
      out.desc = o.desc;
    }
    if (o.labels !== undefined) {
      if (!Array.isArray(o.labels) || o.labels.length > LIMITS.labelsPerCard) refuse(`${what} labels must be a list of at most ${LIMITS.labelsPerCard}.`);
      if (new Set(o.labels).size !== o.labels.length) refuse(`${what} has a label twice.`);
      for (const id of o.labels) if (typeof id !== 'string' || !ctx.labels.has(id)) refuse(`${what} has a label that is not in the template.`);
      out.labels = [...o.labels];
    }
  } else refuse(`${what} is not a kanban part.`);
  return out;
}

/**
 * The kanban limits over a whole template (docs/kanban.md, Limits): kanbans per board, lanes per kanban, cards per lane
 * and in all. Throws an Error naming the limit.
 * @param {Iterable<{ type: string, parent?: unknown }>} objects
 */
export function checkTemplateKanbanLimits(objects) {
  const per = new Map();
  let containers = 0, cards = 0;
  for (const o of objects) {
    if (o.type === 'container') containers++;
    if (o.type === 'card') cards++;
    if ((o.type === 'lane' || o.type === 'card') && typeof o.parent === 'string') per.set(o.parent, (per.get(o.parent) ?? 0) + 1);
  }
  if (containers > LIMITS.containers) refuse(`A template can hold at most ${LIMITS.containers} kanbans.`);
  if (cards > LIMITS.cards) refuse(`A template can hold at most ${LIMITS.cards} cards.`);
  for (const o of objects) {
    const n = per.get(o.id) ?? 0;
    if (o.type === 'container' && n > LIMITS.lanes) refuse(`A kanban holds at most ${LIMITS.lanes} lanes.`);
    if (o.type === 'lane' && n > LIMITS.cardsPerLane) refuse(`A lane holds at most ${LIMITS.cardsPerLane} cards.`);
  }
}
