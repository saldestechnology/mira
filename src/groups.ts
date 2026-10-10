import type { BaseObj, ConnectorObj, Group, Id, Obj, Point, Rect } from './types';
import { generateNKeysBetween } from 'fractional-indexing';
import { boxBounds, rectContains, unionRects } from './geometry';
import { isBox, isConnector } from './types';

export const GROUP_MAX_DEPTH = 8;
export const GROUP_MAX_MEMBERS = 500;
export const GROUP_MAX_PER_BOARD = 500;
export const GROUP_NAME_MAX = 80;

export type GetObject = (id: Id) => Obj | undefined;
export type ListChildren = (id: Id) => readonly Obj[];

export const isGroup = (o: Obj | undefined): o is Group => !!o && o.type === 'group';

function parentWalk(o: Obj, get: GetObject): { ancestors: Obj[]; repeated?: Obj } {
  const ancestors: Obj[] = [];
  const seen = new Set<Id>([o.id]);
  let current = o;
  while (current.parent) {
    const id = current.parent;
    const parent = get(id);
    if (!parent) break;
    if (seen.has(id)) return { ancestors, repeated: parent };
    ancestors.push(parent);
    seen.add(id);
    current = parent;
  }
  return { ancestors };
}

/** Parent objects, nearest first. Missing parents and repeated ids end the walk. */
export function ancestorsOf(o: Obj, get: GetObject): Obj[] {
  return parentWalk(o, get).ancestors;
}

/** The highest group in the object's parent chain, or the repeated group that closes a malformed cycle. */
export function outermostGroup(o: Obj, get: GetObject): Group | undefined {
  const walk = parentWalk(o, get);
  if (isGroup(walk.repeated)) return walk.repeated;
  const groups = [o, ...walk.ancestors].filter(isGroup);
  return groups.at(-1);
}

/** All descendants, including nested groups, in the order supplied by `childrenOf`. */
export function descendantsOf(id: Id, get: GetObject, childrenOf: ListChildren): Obj[] {
  const out: Obj[] = [];
  const seen = new Set<Id>([id]);
  const walk = (parentId: Id) => {
    for (const child of childrenOf(parentId)) {
      if (child.parent !== parentId || seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child);
      if (isGroup(child)) walk(child.id);
    }
  };
  if (get(id)) walk(id);
  return out;
}

/**
 * Plans the objects that travel when ids are copied. Groups carry their full subtree, and only connectors whose bound ends
 * stay inside that subtree travel with it. `all` supplies stable paint order for the returned ids.
 */
export function copyPlan(ids: readonly Id[], get: GetObject, childrenOf: ListChildren, all: readonly Obj[]): Id[] {
  const set = new Set(ids.filter((id) => !!get(id)));
  const stack = [...set];
  while (stack.length) {
    const id = stack.pop()!;
    if (!isGroup(get(id))) continue;
    for (const child of childrenOf(id)) {
      if (child.parent !== id || set.has(child.id)) continue;
      set.add(child.id);
      if (isGroup(child)) stack.push(child.id);
    }
  }

  for (const id of set) {
    const o = get(id);
    if (isConnector(o) && [o.from, o.to].some((end) => end.kind === 'bound' && !set.has(end.id))) set.delete(id);
  }
  for (const o of all) {
    if (!isConnector(o) || set.has(o.id)) continue;
    if (o.from.kind === 'bound' && o.to.kind === 'bound' && set.has(o.from.id) && set.has(o.to.id)) set.add(o.id);
  }
  return all.filter((o) => set.has(o.id)).map((o) => o.id);
}

/** The nearest frame ancestor, following parent links through any number of groups. */
export function frameOf(o: Obj, get: GetObject): BaseObj | undefined {
  return parentWalk(o, get).ancestors.find((parent): parent is BaseObj => parent.type === 'frame');
}

/** True when the object or one of its group ancestors is locked. */
export function effectiveLocked(o: Obj, get: GetObject): boolean {
  if (o.locked === true) return true;
  return ancestorsOf(o, get).some((parent) => isGroup(parent) && parent.locked === true);
}

/** Number of group levels containing this object, including the object itself when it is a group. */
export function groupDepth(o: Obj, get: GetObject): number {
  return [o, ...ancestorsOf(o, get)].filter(isGroup).length;
}

export function groupFitsLimits(input: { depth: number; members: number; groups: number; name?: string }): boolean {
  return input.depth >= 1 && input.depth <= GROUP_MAX_DEPTH && input.members >= 0 && input.members <= GROUP_MAX_MEMBERS &&
    input.groups >= 0 && input.groups <= GROUP_MAX_PER_BOARD && (input.name === undefined || input.name.length <= GROUP_NAME_MAX);
}

/** The object a click selects at this group level. Frames do not form a selection scope. */
export function pick(o: Obj | Id, scope: Id | null, get: GetObject): Obj | undefined {
  let current = typeof o === 'string' ? get(o) : o;
  if (!current) return undefined;
  const seen = new Set<Id>([current.id]);
  while (current.parent) {
    const parent = get(current.parent);
    if (!isGroup(parent) || seen.has(parent.id)) break;
    if (parent.id === scope) break;
    current = parent;
    seen.add(current.id);
  }
  return current;
}

/** Lifts ids to one scope so a selection never contains a group and one of its descendants. */
export function liftToScope(ids: Iterable<Id>, scope: Id | null, get: GetObject): Id[] {
  const lifted = new Set<Id>();
  for (const id of ids) {
    const o = get(id);
    const at = o && pick(o, scope, get);
    if (at) lifted.add(at.id);
  }
  return [...lifted];
}

/** Lifts changed or selected descendants to the visible items at the top group level. */
export function topLevelAncestors(ids: Iterable<Id>, get: GetObject): Id[] {
  return liftToScope(ids, null, get);
}

export interface GroupPlanHelpers {
  /** Every board object, used for board limits and connectors that may join the selection. */
  all: () => readonly Obj[];
  /** Derived geometry for a box or group. */
  bounds: (o: Obj) => Rect;
  /** The topmost frame at a point, using the same rule as the canvas. */
  frameAt: (p: Point) => BaseObj | undefined;
  /** An id source; called only for a successful plan. */
  newId: () => Id;
  /** An entered group becomes the new group's parent. At the top level the frameAt rule is used. */
  scope?: Id | null;
}

export interface GroupPlan {
  group: { id: Id; z: string; parent?: Id };
  /** Selected non-connector objects that become direct members. */
  members: Id[];
  skipped: { frames: number; other: number };
  /** Selected connectors and connectors whose two ends belong to selected objects. */
  connectors: Id[];
}

export type GroupPlanResult = ({ ok: true } & GroupPlan) | { ok: false; reason: string };

const zOrder = (a: Obj, b: Obj) => a.z < b.z ? -1 : a.z > b.z ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const sameParent = (a: Obj, b: Obj) => a.parent === b.parent;

/** Plans grouping at one selection level without writing to the document. */
export function groupPlan(ids: readonly Id[], get: GetObject, childrenOf: ListChildren, helpers: GroupPlanHelpers): GroupPlanResult {
  const uniqueIds = [...new Set(ids)];
  const selected = uniqueIds.map(get);
  if (!selected.length || selected.some((o) => !o)) return { ok: false, reason: 'The selection changed. Select the items again.' };
  const objects = selected as Obj[];
  let frames = 0, other = 0;
  const items: Obj[] = [];
  const chosenConnectors: Obj[] = [];
  for (const o of objects) {
    if (o.type === 'frame' || o.type === 'tracker') frames++;
    else if (o.parent && get(o.parent)?.type === 'lane') other++;
    else if (o.type === 'connector') chosenConnectors.push(o);
    else items.push(o);
  }

  const scope = helpers.scope ?? null;
  if (objects.some((o) => pick(o, scope, get)?.id !== o.id || (scope !== null && o.parent !== scope))) {
    return { ok: false, reason: 'Select items at the same group level.' };
  }

  const selectedIds = new Set(items.map((o) => o.id));
  const memberIds = new Set(selectedIds);
  for (const o of items) if (isGroup(o)) for (const child of descendantsOf(o.id, get, childrenOf)) memberIds.add(child.id);
  const itemBounds = items.map((o) => helpers.bounds(o));
  const bounds = unionRects(itemBounds);
  const endInside = (end: ConnectorObj['from']) => {
    if (end.kind === 'bound') return memberIds.has(end.id);
    return itemBounds.some((b) => rectContains(b, { x: end.x, y: end.y, w: 0, h: 0 }));
  };
  const validSelectedConnectors = chosenConnectors.filter((o) => {
    const inside = endInside((o as ConnectorObj).from) && endInside((o as ConnectorObj).to);
    if (!inside) other++;
    return inside;
  });
  const groupable = [...items, ...validSelectedConnectors];
  if (groupable.length < 2) return { ok: false, reason: 'Select at least two groupable items.' };

  const atSameScope = (o: Obj) => pick(o, scope, get)?.id === o.id && (scope === null || o.parent === scope);
  const connectors = new Set(validSelectedConnectors.map((o) => o.id));
  for (const o of helpers.all()) {
    if (!isConnector(o) || selectedIds.has(o.id) || !atSameScope(o)) continue;
    if (endInside(o.from) && endInside(o.to)) connectors.add(o.id);
  }
  const connectorIds = [...connectors];
  const directMembers = items.map((o) => o.id);
  if (directMembers.length + connectorIds.length > GROUP_MAX_MEMBERS) {
    return { ok: false, reason: `A group can contain at most ${GROUP_MAX_MEMBERS} items.` };
  }
  const depth = Math.max(...groupable.map((o) => groupDepth(o, get) + 1));
  const groups = helpers.all().filter(isGroup).length;
  if (!groupFitsLimits({ depth, members: directMembers.length + connectorIds.length, groups: groups + 1 })) {
    if (depth > GROUP_MAX_DEPTH) return { ok: false, reason: `Groups can be nested at most ${GROUP_MAX_DEPTH} levels.` };
    return { ok: false, reason: `A board can have at most ${GROUP_MAX_PER_BOARD} groups.` };
  }

  const top = groupable.reduce((a, b) => (a.z > b.z ? a : b));
  const parent = scope ?? (bounds ? helpers.frameAt({ x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 })?.id : undefined);
  return {
    ok: true,
    group: { id: helpers.newId(), z: top.z, ...(parent ? { parent } : {}) },
    members: directMembers,
    skipped: { frames, other },
    connectors: connectorIds,
  };
}

export interface UngroupMemberPlan { id: Id; z: string; parent?: Id }
export interface UngroupGroupPlan { id: Id; members: UngroupMemberPlan[] }
export interface UngroupPlan { groups: UngroupGroupPlan[] }

export interface UngroupPlanHelpers { all: () => readonly Obj[] }

/** Plans one-level ungrouping and replaces each group at its exact place among its siblings. */
export function ungroupPlan(ids: readonly Id[], get: GetObject, childrenOf: ListChildren, helpers: UngroupPlanHelpers): UngroupPlan {
  const all = helpers.all();
  const groups: UngroupGroupPlan[] = [];
  for (const id of new Set(ids)) {
    const group = get(id);
    if (!isGroup(group)) continue;
    const members = childrenOf(group.id).filter((o) => o.parent === group.id).sort(zOrder);
    const siblings = all.filter((o) => o.id !== group.id && sameParent(o, group)).sort(zOrder);
    const next = siblings.find((o) => zOrder(group, o) < 0 && o.z > group.z);
    const keys = members.length ? generateNKeysBetween(group.z, next?.z ?? null, members.length) : [];
    groups.push({
      id: group.id,
      members: members.map((o, i) => ({ id: o.id, z: keys[i], ...(group.parent ? { parent: group.parent } : {}) })),
    });
  }
  return { groups };
}

/** Union of visible leaf members; nested groups are walked and connectors and frames do not contribute. */
export function membersBounds(
  group: Group,
  get: GetObject,
  childrenOf: ListChildren,
  visible: (o: Obj) => boolean = () => true,
  boundsOf: (o: BaseObj) => Rect = boxBounds,
): Rect | null {
  const rects: Rect[] = [];
  const seen = new Set<Id>([group.id]);
  const walk = (parentId: Id) => {
    for (const child of childrenOf(parentId)) {
      if (child.parent !== parentId || seen.has(child.id)) continue;
      seen.add(child.id);
      if (!visible(child)) continue;
      if (isGroup(child)) {
        walk(child.id);
      } else if (isBox(child) && child.type !== 'frame' && child.type !== 'tracker') {
        rects.push(boundsOf(child));
      }
    }
  };
  if (get(group.id)) walk(group.id);
  return unionRects(rects);
}
