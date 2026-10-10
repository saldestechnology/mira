// The layers panel (TAB-198) as pure functions: what it lists, in which order, under which label, and the key writes a
// drag makes. The panel (src/ui/layers.ts) draws this and the store writes it.
//
// Order: the list is top first, which is the reverse of paint order. Frames always paint below everything else whatever
// their key (Store.ordered), so they come last; the rest come above them by key. An object whose `parent` is a frame (or a
// group, once docs/groups.md lands) is listed under that container, indented. Kanban cards and lanes are laid out by their
// container, not by key: they are listed under it in its layout order and cannot be dragged here.
//
// Node contract (docs/groups.md, "The layers panel"): a container node has `expandable`, `expanded` and `childCount`; its
// children follow it with `depth + 1`. Groups will be one more container type: `CONTAINERS` is the hook.
import { generateNKeysBetween } from 'fractional-indexing';
import type { Id, Obj } from './types';
import type { ZPatch } from './z-order';

/** Types whose `parent` children nest under them in the panel. Groups join here (docs/groups.md). */
export const CONTAINERS = new Set<string>(['frame', 'container', 'lane']);

export const TYPE_LABEL: Record<string, string> = {
  shape: 'Shape', sticky: 'Sticky note', text: 'Text', frame: 'Frame', tracker: 'Tracker', icon: 'Icon', image: 'Image', path: 'Drawing', connector: 'Connector',
  container: 'Board', lane: 'Lane', card: 'Card', group: 'Group',
  'uml-class': 'Class', 'uml-actor': 'Actor', 'uml-usecase': 'Use case', 'uml-lifeline': 'Lifeline', 'uml-note': 'Note',
  'uml-package': 'Package', 'uml-state': 'State', 'uml-initial': 'Initial node', 'uml-final': 'Final node', 'uml-component': 'Component',
};

export const NAME_MAX = 80;
const LABEL_MAX = 48;

export interface LayerNode {
  id: Id;
  type: string;
  label: string;
  /** 0 at the top level. */
  depth: number;
  parent: Id | null;
  locked: boolean;
  hidden: boolean;
  /** Reordered by drag or keys; false for items a container lays out. */
  movable: boolean;
  expandable: boolean;
  expanded: boolean;
  childCount: number;
}

/** What the panel needs from the board besides the objects. */
export interface LayerBoard {
  /** False for what this person may not see (another person's private note); such items are left out, as on the canvas. */
  visible: (o: Obj) => boolean;
  /** Whether a container lays the object out (kanban). */
  isLaidOut: (o: Obj) => boolean;
  /** A container's children in its layout order. */
  layoutOrder: (containerId: Id) => Id[];
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The item's name, else the first words of its text, else its type: "Sticky note", "Frame". */
export function layerLabel(o: Obj): string {
  const named = typeof (o as { name?: unknown }).name === 'string' ? oneLine((o as { name: string }).name) : '';
  if (named) return named.slice(0, NAME_MAX);
  const raw = (o as { text?: unknown }).text;
  const text = typeof raw === 'string' ? oneLine(raw) : '';
  if (text) return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text;
  return TYPE_LABEL[o.type] ?? 'Object';
}

/** A name as the field stores it: one line, at most 80 characters; empty clears it (the label falls back). */
export function cleanName(raw: string): string | undefined {
  const s = [...oneLine(raw)].slice(0, NAME_MAX).join('');
  return s || undefined;
}

const byZ = (a: Obj, b: Obj) => (a.z < b.z ? -1 : a.z > b.z ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const topFirst = (a: Obj, b: Obj) => -byZ(a, b);
export const isFrameClass = (o: { type: string }) => o.type === 'frame' || o.type === 'tracker';

/**
 * The panel's rows, top first, flattened: a container is followed by its children (unless collapsed). An object whose
 * parent is missing or invisible is listed at the top level.
 */
export function layerTree(objects: readonly Obj[], board: LayerBoard, collapsed: ReadonlySet<Id> = new Set()): LayerNode[] {
  const shown = objects.filter((o) => board.visible(o));
  const byId = new Map(shown.map((o) => [o.id, o]));
  const childrenOf = new Map<Id, Obj[]>();
  const roots: Obj[] = [];
  for (const o of shown) {
    const p = o.parent ? byId.get(o.parent) : undefined;
    if (p && CONTAINERS.has(p.type) && p.id !== o.id) {
      const list = childrenOf.get(p.id) ?? [];
      list.push(o);
      childrenOf.set(p.id, list);
    } else roots.push(o);
  }

  const sortSiblings = (list: Obj[], parent: Obj | null): Obj[] => {
    // a kanban board's lanes, and a lane's cards, in the board's layout order (left to right, top to bottom)
    const layoutRoot = parent?.type === 'container' ? parent.id : parent?.type === 'lane' ? parent.parent ?? null : null;
    if (layoutRoot) {
      const order = board.layoutOrder(layoutRoot);
      const laid = order.map((id) => list.find((o) => o.id === id)).filter((o): o is Obj => !!o);
      const rest = list.filter((o) => !order.includes(o.id)).sort(topFirst);
      return [...rest, ...laid];
    }
    return [...list.filter((o) => !isFrameClass(o)).sort(topFirst), ...list.filter(isFrameClass).sort(topFirst)];
  };

  const out: LayerNode[] = [];
  const seen = new Set<Id>();
  const walk = (o: Obj, depth: number) => {
    if (seen.has(o.id)) return;
    seen.add(o.id);
    const kids = childrenOf.get(o.id) ?? [];
    const expandable = CONTAINERS.has(o.type);
    const expanded = expandable && !collapsed.has(o.id);
    out.push({
      id: o.id, type: o.type, label: layerLabel(o), depth, parent: o.parent && byId.has(o.parent) ? o.parent : null,
      locked: o.locked === true, hidden: (o as { hidden?: unknown }).hidden === true, movable: !board.isLaidOut(o),
      expandable, expanded, childCount: kids.length,
    });
    if (expanded) for (const k of sortSiblings(kids, o)) walk(k, depth + 1);
  };
  for (const o of sortSiblings(roots, null)) walk(o, 0);
  return out;
}

/** How many objects this person could see are hidden (the panel's "N hidden"). */
export function hiddenCount(objects: readonly Obj[], board: Pick<LayerBoard, 'visible'>): number {
  return objects.filter((o) => board.visible(o) && (o as { hidden?: unknown }).hidden === true).length;
}

/**
 * The key write that puts `id` directly above (`'above'`) or below `target` in the list, which is directly above or below
 * it in paint order. Both must be of the same class (frames among frames, everything else among the rest) and movable.
 * Null when nothing would change or the move is not allowed. The key is placed between `target` and its neighbour in the
 * whole paint order of that class, so siblings in a frame keep their order relative to everything else too.
 */
export function moveNextTo(objects: readonly Obj[], id: Id, target: Id, where: 'above' | 'below', isLaidOut: (o: Obj) => boolean): ZPatch[] | null {
  if (id === target) return null;
  const moving = objects.find((o) => o.id === id);
  const anchor = objects.find((o) => o.id === target);
  if (!moving || !anchor || isLaidOut(moving) || isLaidOut(anchor) || isFrameClass(moving) !== isFrameClass(anchor)) return null;
  const line = objects.filter((o) => o.id !== id && isFrameClass(o) === isFrameClass(moving) && !isLaidOut(o)).sort(byZ);
  const at = line.findIndex((o) => o.id === target);
  const lo = where === 'above' ? line[at] : line[at - 1];
  const hi = where === 'above' ? line[at + 1] : line[at];
  // already in that place
  const current = [...line, moving].sort(byZ);
  const ci = current.findIndex((o) => o.id === id);
  if ((current[ci - 1]?.id ?? null) === (lo?.id ?? null) && (current[ci + 1]?.id ?? null) === (hi?.id ?? null)) return null;
  if (lo && hi && lo.z >= hi.z) {
    // equal keys (an old board): write the class again, evenly spaced, in the wanted order
    const order = [...line];
    order.splice(where === 'above' ? at + 1 : at, 0, moving);
    const fresh = generateNKeysBetween(null, null, order.length);
    return order.map((o, i) => ({ id: o.id, z: fresh[i] })).filter((p) => objects.find((o) => o.id === p.id)!.z !== p.z);
  }
  return [{ id, z: generateNKeysBetween(lo?.z ?? null, hi?.z ?? null, 1)[0] }];
}

/**
 * The keyboard equivalent of a drag: move `id` one row up (`-1`, towards the top of the list) or down among its siblings in
 * the panel. Null at the end of its siblings or when it cannot move.
 */
export function moveAmongSiblings(nodes: readonly LayerNode[], objects: readonly Obj[], id: Id, direction: -1 | 1, isLaidOut: (o: Obj) => boolean): ZPatch[] | null {
  const me = nodes.find((n) => n.id === id);
  if (!me || !me.movable) return null;
  const siblings = nodes.filter((n) => n.parent === me.parent && n.depth === me.depth && n.movable && isFrameClass(n) === isFrameClass(me));
  const i = siblings.findIndex((n) => n.id === id);
  const next = siblings[i + direction];
  if (!next) return null;
  // up the list is up the paint order
  return moveNextTo(objects, id, next.id, direction === -1 ? 'above' : 'below', isLaidOut);
}
