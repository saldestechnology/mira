// Custom templates: a saved snapshot of objects and session steps, stored as data.
// Everything here is pure (no DOM, no Yjs) so it runs in the browser, the server and tests.

import type { End, Id, Obj, ObjType, Point, Rect, Step, StepMode } from './types';
import { isBox, isConnector } from './types';
import { boxBounds, center, rectOfPoints } from './geometry';
import { sanitizeSvgBody } from './markup';
import { newId } from './store';
import { isSafeColor } from '../shared/colors';
import { TEMPLATE_STRIPPED, checkTemplateKanbanLimits, isContainerType, splitRank, templateKanbanFields, templateLabels } from '../shared/containers';
import { STICKY_COLORS } from './palette';
import { OBJ_ENUMS, cleanProposedBy } from './safe-obj';
import { GROUP_MAX_DEPTH, GROUP_MAX_MEMBERS, GROUP_MAX_PER_BOARD, GROUP_NAME_MAX } from './groups';

export const MAX_TEMPLATE_OBJECTS = 2000;
export const MAX_TEMPLATE_BYTES = 1_000_000;

/** A label a template carries for its cards; merged by name into the board's labels when it is used (docs/kanban.md, Templates). */
export interface TemplateLabel {
  id: string;
  name: string;
  color: string;
}

export interface TemplateContent {
  objects: Obj[];
  steps: Step[];
  bounds: Rect;
  fonts?: { heading: string; body: string };
  /** The labels its cards use (docs/kanban.md, Templates). */
  labels?: TemplateLabel[];
}

export type TemplateScope = 'personal' | 'team' | 'workspace';

export interface CustomTemplate {
  id: string;
  version: 1;
  name: string;
  category: string;
  description: string;
  content: TemplateContent;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** Accounts mode only: who the template is shared with. Templates kept in the browser have none of these. */
  scope?: TemplateScope;
  teamId?: string | null;
  teamName?: string | null;
  ownerName?: string | null;
  /** Whether the person may rename, edit and delete it; absent means yes. */
  canChange?: boolean;
}

/**
 * Copies of `objs` with new ids from `idMap`, shifted by `offset`. Bound connector ends
 * and parents that point outside the list are dealt with as insertObjects always has:
 * a connector end becomes a free end at `resolveOutside(id)` (the origin when that is
 * null), a parent is dropped. Session-private marks are removed. z and createdBy are
 * left for the caller to set.
 */
export function remapObjects(
  objs: Obj[],
  idMap: Map<Id, Id>,
  offset: Point,
  resolveOutside: (id: Id) => Point | null,
): Obj[] {
  return objs.map((o) => {
    const c = structuredClone(o) as Obj;
    c.id = idMap.get(o.id)!;
    c.parent = c.parent ? idMap.get(c.parent) : undefined;
    if (isConnector(c)) {
      const fix = (e: End): End => {
        if (e.kind === 'free') return { kind: 'free', x: e.x + offset.x, y: e.y + offset.y };
        const nid = idMap.get(e.id);
        if (nid) return { ...e, id: nid };
        const pt = resolveOutside(e.id) ?? { x: 0, y: 0 };
        return { kind: 'free', x: pt.x + offset.x, y: pt.y + offset.y };
      };
      c.from = fix(c.from);
      c.to = fix(c.to);
    } else {
      c.x += offset.x;
      c.y += offset.y;
      delete c.privateStep;
      // a rank names its parent (docs/kanban.md, Ranks): it follows the new id, and goes with a parent left behind
      if (c.rank !== undefined) {
        const split = splitRank(c.rank);
        if (split && c.parent) c.rank = `${split.key}@${c.parent}`;
        else delete c.rank;
      }
      // a copy, a paste or a template can come from a file or another board: proposedBy goes on only in its one clean shape (TAB-160)
      const clean = cleanProposedBy(c.proposedBy);
      if (clean) c.proposedBy = clean;
      else delete c.proposedBy;
    }
    return c;
  });
}

export interface ToTemplateOptions {
  fonts?: { heading: string; body: string };
  /** The board's labels: the ones the cards use go into the template. */
  labels?: readonly TemplateLabel[];
  /** Keep session steps that have no frame (steps tied to a saved frame are always kept). */
  includeSteps: boolean;
  /** Frames whose steps may be kept; defaults to every object in the selection. */
  frameIds?: Set<Id>;
}

/** `objs` without what Layers hides (TAB-198), what is inside a hidden frame or kanban, and connectors bound to either: a template never un-hides them. */
function leaveOutHidden(objs: Obj[]): Obj[] {
  const byId = new Map(objs.map((o) => [o.id, o]));
  const hidden = (o: Obj): boolean => {
    for (let p: Obj | undefined = o, n = 0; p && n < 64; p = p.parent ? byId.get(p.parent) : undefined, n++) if (p.hidden === true) return true;
    return false;
  };
  const out = new Set(objs.filter(hidden).map((o) => o.id));
  if (!out.size) return objs;
  return objs.filter((o) => !out.has(o.id) && !(isConnector(o) && [o.from, o.to].some((e) => e.kind === 'bound' && out.has(e.id))));
}

/**
 * Normalise a gathered selection into template content. `objs` must already hold
 * frame children and inner connectors (BoardApp.gather) in paint order; that order
 * becomes the z order. `lookup` finds objects outside the selection, so connector ends
 * that point at them become free ends at the target's centre. Poll and one-click
 * (quick) steps are not saved, since the poll itself is not part of a template.
 */
export function toTemplateContent(
  objs: Obj[],
  steps: Step[],
  opts: ToTemplateOptions,
  lookup?: (id: Id) => Obj | undefined,
): TemplateContent {
  objs = leaveOutHidden(objs.filter((o) => o.type !== 'image'));
  const idMap = new Map<Id, Id>();
  objs.forEach((o, i) => idMap.set(o.id, `o${i + 1}`));
  const resolveOutside = (id: Id): Point | null => {
    const src = lookup?.(id);
    return src && isBox(src) ? center(src) : null;
  };

  const pts: Point[] = [];
  for (const o of objs) {
    if (isConnector(o)) {
      for (const e of [o.from, o.to]) {
        if (e.kind === 'free') pts.push({ x: e.x, y: e.y });
        else if (!idMap.has(e.id)) {
          // An end whose target no longer exists has no position worth fitting the bounds to.
          const pt = resolveOutside(e.id);
          if (pt) pts.push(pt);
        }
      }
    } else {
      const b = boxBounds(o);
      pts.push({ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y + b.h });
    }
  }
  const b = rectOfPoints(pts);

  const digits = String(objs.length).length;
  // the labels the cards use, as l1, l2, … (docs/kanban.md, Templates)
  const labelIds = new Map<Id, string>();
  const boardLabels = new Map((opts.labels ?? []).map((l) => [l.id, l]));
  for (const o of objs) {
    if (o.type !== 'card') continue;
    for (const id of o.labels ?? []) if (boardLabels.has(id) && !labelIds.has(id)) labelIds.set(id, `l${labelIds.size + 1}`);
  }
  const objects = remapObjects(objs, idMap, { x: -b.x, y: -b.y }, resolveOutside).map((o, i) => {
    delete o.locked;
    delete o.hidden;
    delete (o as { proposedBy?: unknown }).proposedBy;
    delete o.createdBy;
    delete o.updatedAt;
    // a shared template names no people and no dates (docs/kanban.md, Templates); labels stay, renumbered
    for (const key of TEMPLATE_STRIPPED) delete (o as unknown as Record<string, unknown>)[key];
    // a sticky that was once a card keeps its card fields for turning back; a template does not (docs/kanban.md)
    if (o.type !== 'card') for (const key of ['desc', 'labels'] as const) delete (o as unknown as Record<string, unknown>)[key];
    if (o.type === 'card' && o.labels) {
      const kept = o.labels.map((id) => labelIds.get(id)).filter((id): id is string => !!id);
      if (kept.length) o.labels = kept;
      else delete o.labels;
    }
    if (o.parent === undefined) delete o.parent;
    o.z = String(i + 1).padStart(digits, '0');
    return o;
  });

  const frames = opts.frameIds ?? new Set(idMap.keys());
  const kept = steps.filter((s) => {
    if (s.quick || s.pollId) return false;
    return s.frameId ? frames.has(s.frameId) && idMap.has(s.frameId) : opts.includeSteps;
  });
  const outSteps = kept.map((s, i): Step => {
    const c: Step = { ...s, id: `s${i + 1}` };
    if (s.frameId) c.frameId = idMap.get(s.frameId);
    return c;
  });

  const labels = [...labelIds].map(([id, nid]) => { const l = boardLabels.get(id)!; return { id: nid, name: l.name, color: l.color }; });
  return {
    objects,
    steps: outSteps,
    bounds: { x: 0, y: 0, w: b.w, h: b.h },
    ...(opts.fonts ? { fonts: { heading: opts.fonts.heading, body: opts.fonts.body } } : {}),
    ...(labels.length ? { labels } : {}),
  };
}

/** Fresh objects and steps from template content, with its top-left corner at `origin`. z is left to the caller. */
export function instantiate(content: TemplateContent, origin: Point, userId: string): { objects: Obj[]; steps: Step[] } {
  const idMap = new Map<Id, Id>();
  for (const o of content.objects) idMap.set(o.id, newId());
  const objects = remapObjects(content.objects, idMap, origin, () => null);
  for (const o of objects) {
    o.createdBy = userId;
    // template content can come from a file: a stored proposedBy is never carried onto a new board (TAB-160)
    delete (o as { proposedBy?: unknown }).proposedBy;
  }
  const steps = content.steps.map((s): Step => {
    const c: Step = { ...s, id: newId() };
    const frameId = s.frameId ? idMap.get(s.frameId) : undefined;
    if (frameId) c.frameId = frameId;
    else delete c.frameId;
    return c;
  });
  return { objects, steps };
}

const OBJ_TYPES: Record<ObjType, true> = {
  shape: true, sticky: true, text: true, frame: true, tracker: true, group: true, icon: true, image: true, path: true, connector: true, container: true, lane: true, card: true,
  'uml-class': true, 'uml-actor': true, 'uml-usecase': true, 'uml-lifeline': true, 'uml-note': true,
  'uml-package': true, 'uml-state': true, 'uml-initial': true, 'uml-final': true, 'uml-component': true,
};
// A template never holds an image: its bytes are readable only through the board that has them (docs/images.md, Templates).
const TYPE_NAMES = new Set<string>(Object.keys(OBJ_TYPES).filter((t) => t !== 'image' && t !== 'tracker'));

/** How many of these objects a template would leave out because they are images. */
export const imagesLeftOut = (objs: Obj[]) => objs.filter((o) => o.type === 'image').length;

const STEP_MODES: Record<StepMode, true> = {
  write: true, 'private-write': true, cluster: true, vote: true, discuss: true, poll: true,
};
const MODE_NAMES = new Set<string>(Object.keys(STEP_MODES));

function fail(message: string): never {
  throw new Error(message);
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Check untrusted template content (from a file or a client) and return a safe copy. Throws a readable Error. */
export function validateContent(c: unknown): TemplateContent {
  if (!isRecord(c)) fail('Template content must be an object.');
  const { objects: list, steps, bounds, fonts, labels: labelList } = c;
  if (!Array.isArray(list)) fail('Template content needs a list of objects.');
  if (list.length > MAX_TEMPLATE_OBJECTS) {
    fail(`A template can hold at most ${MAX_TEMPLATE_OBJECTS} objects; this one has ${list.length}.`);
  }
  let json: string;
  try {
    json = JSON.stringify(c);
  } catch {
    return fail('Template content is not valid JSON data.');
  }
  if (new TextEncoder().encode(json).byteLength > MAX_TEMPLATE_BYTES) {
    fail(`A template can be at most ${MAX_TEMPLATE_BYTES / 1_000_000} MB of data.`);
  }

  const ids = new Set<Id>();
  for (const [i, o] of list.entries()) {
    if (!isRecord(o)) fail(`Object ${i + 1} is not an object.`);
    if (o.type === 'tracker') fail('Templates cannot contain tracker frames.');
    if (typeof o.id !== 'string' || !o.id) fail(`Object ${i + 1} has no id.`);
    if (ids.has(o.id)) fail(`Two objects share the id "${o.id}".`);
    ids.add(o.id);
    if (typeof o.type !== 'string' || !TYPE_NAMES.has(o.type)) fail(`Object "${o.id}" has an unknown type.`);
    if (typeof o.z !== 'string') fail(`Object "${o.id}" has no z order.`);
    // the board's one colour grammar (shared/colors.mjs, TAB-203), as the server checks it
    for (const key of ['flipX', 'flipY']) {
      if (o[key] !== undefined && typeof o[key] !== 'boolean') fail(`Object "${o.id}" has an invalid ${key}; it must be a boolean.`);
    }
    if (o.type === 'connector' && (o.flipX !== undefined || o.flipY !== undefined)) fail(`Connector "${o.id}" cannot have flip flags.`);
    for (const [key, values] of Object.entries(OBJ_ENUMS)) {
      if (o[key] !== undefined && !(typeof o[key] === 'string' && values.has(o[key]))) fail(`Object "${o.id}" has an unknown ${key}.`);
    }
    // (a kanban container's, lane's or card's fill may also be a palette key such as `yellow`, docs/kanban.md)
    for (const key of ['fill', 'stroke', 'textColor']) {
      const v = o[key];
      if (v === undefined || isSafeColor(v)) continue;
      if (key === 'fill' && isContainerType(o.type) && typeof v === 'string' && STICKY_COLORS.some((c) => c.name.toLowerCase() === v.toLowerCase())) continue;
      fail(`Object "${o.id}" has a ${key} that is not a colour the board can draw.`);
    }
  }

  const known = (id: unknown) => typeof id === 'string' && ids.has(id);
  // kanbans: every field checked one by one, the same rules as the server's (shared/containers.mjs)
  const labels = templateLabels(labelList);
  const kanbanCtx = { types: new Map(list.map((o: Record<string, unknown>) => [o.id as string, o.type as string])), labels: new Set(labels.map((l) => l.id)) };
  checkTemplateKanbanLimits(list as { id: string; type: string; parent?: unknown }[]);
  const objects = list.map((o: Record<string, unknown>, i: number) => {
    if (o.type === 'connector') {
      for (const side of ['from', 'to'] as const) {
        const e = o[side];
        if (!isRecord(e)) fail(`Connector "${o.id}" is missing its ${side} end.`);
        if (e.kind === 'free') {
          if (!isNum(e.x) || !isNum(e.y)) fail(`Connector "${o.id}" has a ${side} end without a position.`);
        } else if (e.kind === 'bound') {
          if (!known(e.id)) fail(`Connector "${o.id}" is attached to a missing object.`);
        } else {
          fail(`Connector "${o.id}" has an invalid ${side} end.`);
        }
      }
      return o;
    }
    if (!isNum(o.x) || !isNum(o.y) || !isNum(o.w) || !isNum(o.h)) fail(`Object "${o.id}" has an invalid position or size.`);
    // what reaches SVG attributes is checked as the server checks it (TAB-203)
    if (o.viewBox !== undefined && !(Array.isArray(o.viewBox) && o.viewBox.length === 4 && o.viewBox.every(isNum))) fail(`Object "${o.id}" has an invalid viewBox.`);
    if (o.points !== undefined && !(Array.isArray(o.points) && o.points.length % 2 === 0 && o.points.every(isNum))) fail(`Object "${o.id}" has invalid points.`);
    if (o.parent !== undefined && !known(o.parent)) fail(`Object "${o.id}" has a parent that is not in the template.`);
    if (isContainerType(o.type as string)) {
      // rebuilt from what is accepted: the common fields and the checked kanban ones
      const out: Record<string, unknown> = { id: o.id, type: o.type, x: o.x, y: o.y, w: o.w, h: o.h, rotation: isNum(o.rotation) ? o.rotation : 0, z: o.z };
      if (typeof o.flipX === 'boolean') out.flipX = o.flipX;
      if (typeof o.flipY === 'boolean') out.flipY = o.flipY;
      if (o.parent !== undefined) out.parent = o.parent;
      if (typeof o.font === 'string') out.font = o.font;
      return Object.assign(out, templateKanbanFields(o, `Object ${i + 1}`, kanbanCtx));
    }
    if (o.type === 'group') {
      if (Object.hasOwn(o, 'locked')) fail(`Group "${o.id}" cannot have a locked flag in a template.`);
      if (o.name !== undefined && (typeof o.name !== 'string' || o.name.length > GROUP_NAME_MAX)) fail(`Group "${o.id}" name must be at most ${GROUP_NAME_MAX} characters.`);
      return {
        id: o.id, type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: o.z,
        ...(typeof o.parent === 'string' ? { parent: o.parent } : {}),
        ...(typeof o.name === 'string' ? { name: o.name } : {}),
      };
    }
    if (o.parent !== undefined && isContainerType(kanbanCtx.types.get(o.parent as string) ?? '')) fail(`Object "${o.id}" is inside a kanban, where only lanes and cards go.`);
    if (o.type === 'icon' && o.body !== undefined) {
      if (typeof o.body !== 'string') fail(`Icon "${o.id}" has an invalid body.`);
      return { ...o, body: sanitizeSvgBody(o.body) };
    }
    return o;
  });

  const objectById = new Map(objects.map((o: Record<string, unknown>) => [o.id as string, o]));
  const groupCount = objects.filter((o: Record<string, unknown>) => o.type === 'group').length;
  if (groupCount > GROUP_MAX_PER_BOARD) fail(`A template can hold at most ${GROUP_MAX_PER_BOARD} groups.`);
  const directMembers = new Map<Id, number>();
  for (const o of objects as Record<string, unknown>[]) {
    if (o.parent === undefined) continue;
    if (typeof o.parent !== 'string' || !objectById.has(o.parent)) fail(`Object "${o.id}" has a parent that is not in the template.`);
    const parent = objectById.get(o.parent)!;
    if (o.type === 'connector' && parent.type === 'frame') delete o.parent;
    if (parent.type === 'group') directMembers.set(parent.id as Id, (directMembers.get(parent.id as Id) ?? 0) + 1);
    if (parent.type === 'group' && (o.type === 'frame' || o.type === 'lane')) fail(`Object "${o.id}" cannot be inside a group.`);
    if (!isContainerType(o.type as string) && o.type !== 'connector' && parent.type !== 'frame' && parent.type !== 'group' && !(o.type === 'card' && parent.type === 'lane')) {
      fail(`Object "${o.id}" has a parent that is not a frame or group in the template.`);
    }
    if (o.type === 'connector' && parent.type !== 'frame' && parent.type !== 'group') fail(`Connector "${o.id}" has a parent that is not a frame or group in the template.`);
  }
  for (const [id, count] of directMembers) if (count > GROUP_MAX_MEMBERS) fail(`Group "${id}" can hold at most ${GROUP_MAX_MEMBERS} direct members.`);
  for (const start of objects as Record<string, unknown>[]) {
    let cursor: Record<string, unknown> | undefined = start;
    const seen = new Set<string>();
    let depth = 0;
    while (cursor?.parent) {
      if (seen.has(cursor.id as string)) fail('Template objects cannot have a parent cycle.');
      seen.add(cursor.id as string);
      cursor = objectById.get(cursor.parent as string);
      if (cursor?.type === 'group') depth++;
    }
    if (start.type === 'group' && depth + 1 > GROUP_MAX_DEPTH) fail(`Groups can be nested at most ${GROUP_MAX_DEPTH} levels.`);
  }

  if (!Array.isArray(steps)) fail('Template content needs a list of steps.');
  const stepIds = new Set<Id>();
  for (const [i, s] of steps.entries()) {
    if (!isRecord(s)) fail(`Step ${i + 1} is not an object.`);
    if (typeof s.id !== 'string' || !s.id) fail(`Step ${i + 1} has no id.`);
    if (stepIds.has(s.id)) fail(`Two steps share the id "${s.id}".`);
    stepIds.add(s.id);
    if (typeof s.title !== 'string' || typeof s.instructions !== 'string') fail(`Step ${i + 1} needs a title and instructions.`);
    if (typeof s.mode !== 'string' || !MODE_NAMES.has(s.mode)) fail(`Step ${i + 1} has an unknown mode.`);
    if (s.pollId !== undefined) fail(`Step ${i + 1} refers to a poll, which a template cannot hold.`);
    if (s.frameId !== undefined && !known(s.frameId)) fail(`Step ${i + 1} points at a frame that is not in the template.`);
  }

  if (!isRecord(bounds) || !isNum(bounds.x) || !isNum(bounds.y) || !isNum(bounds.w) || !isNum(bounds.h)) {
    fail('Template content needs bounds.');
  }
  if (fonts !== undefined && (!isRecord(fonts) || typeof fonts.heading !== 'string' || typeof fonts.body !== 'string')) {
    fail('Template fonts must name a heading and a body font.');
  }

  return {
    objects: objects as unknown as Obj[],
    steps: steps as unknown as Step[],
    bounds: { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h },
    ...(isRecord(fonts) ? { fonts: { heading: fonts.heading as string, body: fonts.body as string } } : {}),
    ...(labels.length ? { labels } : {}),
  };
}
