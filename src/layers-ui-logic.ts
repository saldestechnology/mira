// The layers panel's decisions as pure functions (TAB-198): what a click selects, what a key does, where a drag may drop,
// what the controls are called. The panel (src/ui/layers.ts) draws the rows and carries these out.
import { TYPE_LABEL, cleanName, isFrameClass, type LayerNode } from './layers';
import type { Id } from './types';
import type { ICONS } from './ui/dom';

export type IconName = keyof typeof ICONS;

/** Pixels the pointer must travel before a press on a row becomes a drag. */
export const DRAG_START = 4;

export const pastDragStart = (dx: number, dy: number): boolean => Math.hypot(dx, dy) >= DRAG_START;

// ---------------------------------------------------------------- collapsed containers, per board and per device

export const collapsedKey = (boardId: string): string => `driftboard:layers-collapsed:${boardId}`;

export function parseCollapsed(raw: string | null): Set<Id> {
  if (!raw) return new Set();
  try {
    const value: unknown = JSON.parse(raw);
    return new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

export const serializeCollapsed = (collapsed: ReadonlySet<Id>): string => JSON.stringify([...collapsed]);

// ---------------------------------------------------------------- words and glyphs

/** The header's count: null when nothing is hidden. */
export const hiddenText = (n: number): string | null => (n > 0 ? `${n} hidden` : null);

/** The type's name and the row's label, as "Sticky note: Ideas"; just "Frame" when the label is the type's own name. */
export function subject(node: Pick<LayerNode, 'type' | 'label'>): string {
  const type = TYPE_LABEL[node.type] ?? 'Object';
  return node.label === type ? type : `${type}: ${node.label}`;
}

/** What a screen reader says for the row: the subject and its state. */
export function rowName(node: Pick<LayerNode, 'type' | 'label' | 'hidden' | 'locked'>): string {
  return [subject(node), node.hidden && 'hidden', node.locked && 'locked'].filter(Boolean).join(', ');
}

/** The word a toggle's tooltip shows: what pressing it does ("Hide", "Show", "Lock", "Unlock"). */
export function toggleVerb(what: 'hide' | 'lock', node: Pick<LayerNode, 'hidden' | 'locked'>): string {
  return what === 'hide' ? (node.hidden ? 'Show' : 'Hide') : node.locked ? 'Unlock' : 'Lock';
}

/** The toggle's accessible name, "Hide Sticky note: Ideas". It stays the same when pressed: aria-pressed says whether it is on. */
export function toggleLabel(what: 'hide' | 'lock', node: Pick<LayerNode, 'type' | 'label'>): string {
  return `${what === 'hide' ? 'Hide' : 'Lock'} ${subject(node)}`;
}

/** The glyph for an object type; a shape shows its kind when it is an ellipse or a diamond. */
export function typeGlyph(type: string, kind?: string): IconName {
  switch (type) {
    case 'sticky': case 'card': return 'sticky';
    case 'text': return 'text';
    case 'frame': case 'tracker': return 'frame';
    case 'icon': return 'icons';
    case 'image': return 'image';
    case 'path': return 'pen';
    case 'connector': return 'connector';
    case 'container': return 'templates';
    case 'group': return 'shapes';
    case 'shape': return kind === 'ellipse' ? 'ellipse' : kind === 'diamond' ? 'diamond' : 'rect';
    default: return type.startsWith('uml-') ? 'uml' : 'rect';
  }
}

/** Position of each row among the rows with the same parent, for aria-posinset and aria-setsize. */
export function siblingSlots(nodes: readonly LayerNode[]): Map<Id, { pos: number; size: number }> {
  const count = new Map<Id | null, number>();
  for (const n of nodes) count.set(n.parent, (count.get(n.parent) ?? 0) + 1);
  const seen = new Map<Id | null, number>();
  const out = new Map<Id, { pos: number; size: number }>();
  for (const n of nodes) {
    const pos = (seen.get(n.parent) ?? 0) + 1;
    seen.set(n.parent, pos);
    out.set(n.id, { pos, size: count.get(n.parent) ?? 1 });
  }
  return out;
}

// ---------------------------------------------------------------- selecting

/** The canvas cannot select a hidden or a locked object, so its row only takes focus. */
export const isSelectable = (node: Pick<LayerNode, 'hidden' | 'locked'>): boolean => !node.hidden && !node.locked;

/**
 * The selection a click on a row asks for: just that object, or with `additive` (Shift, Ctrl or Cmd) added to the selection or
 * taken out of it. Null when the row cannot be selected: the selection stays as it is.
 */
export function clickSelection(current: readonly Id[], node: Pick<LayerNode, 'id' | 'hidden' | 'locked'>, additive: boolean): Id[] | null {
  if (!isSelectable(node)) return null;
  if (!additive) return [node.id];
  return current.includes(node.id) ? current.filter((id) => id !== node.id) : [...current, node.id];
}

// ---------------------------------------------------------------- renaming

/**
 * What to write when a rename ends. `explicit` is the name the object has (undefined when its label comes from its text or
 * type), `shown` the label the field started with, `raw` what is in it now. Leaving the label as it was writes nothing, so
 * opening and closing the field does not turn a derived label into a stored name or add an undo step.
 */
export function renameChange(explicit: string | undefined, shown: string, raw: string): { write: boolean; name?: string } {
  const next = cleanName(raw);
  if (next === cleanName(explicit ?? '')) return { write: false };
  if (explicit === undefined && next === cleanName(shown)) return { write: false };
  return { write: true, name: next };
}

// ---------------------------------------------------------------- keys

export interface Mods { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean }

export type KeyIntent =
  | 'prev' | 'next' | 'first' | 'last' | 'right' | 'left'
  | 'select' | 'selectMore' | 'rename' | 'hide' | 'lock' | 'moveUp' | 'moveDown';

/**
 * What a key does on a focused row. Null for keys the panel leaves alone, so Tab moves on and Ctrl/Cmd+Z still undoes.
 * Alt+ArrowUp and Alt+ArrowDown move the row among its siblings.
 */
export function keyIntent(key: string, mods: Mods): KeyIntent | null {
  if (mods.ctrl || mods.meta) return null;
  if (mods.alt) return key === 'ArrowUp' ? 'moveUp' : key === 'ArrowDown' ? 'moveDown' : null;
  switch (key) {
    case 'ArrowUp': return 'prev';
    case 'ArrowDown': return 'next';
    case 'ArrowRight': return 'right';
    case 'ArrowLeft': return 'left';
    case 'Home': return 'first';
    case 'End': return 'last';
    case 'Enter': case ' ': return mods.shift ? 'selectMore' : 'select';
    case 'F2': return 'rename';
    default: break;
  }
  const k = key.toLowerCase();
  return k === 'h' && !mods.shift ? 'hide' : k === 'l' ? 'lock' : null;
}

export type Navigation = { focus: Id } | { expand: Id } | { collapse: Id };

/**
 * Where focus goes, or what opens or closes, for a movement key on row `id`. ArrowRight opens a closed container and then
 * enters it; ArrowLeft closes an open one and then goes to the parent. Null when nothing happens (the end of the list).
 */
export function navigate(nodes: readonly LayerNode[], id: Id, intent: 'prev' | 'next' | 'first' | 'last' | 'right' | 'left'): Navigation | null {
  const at = nodes.findIndex((n) => n.id === id);
  if (at < 0 || !nodes.length) return null;
  const me = nodes[at];
  const focus = (n: LayerNode | undefined): Navigation | null => (n && n.id !== id ? { focus: n.id } : null);
  switch (intent) {
    case 'prev': return focus(nodes[at - 1]);
    case 'next': return focus(nodes[at + 1]);
    case 'first': return focus(nodes[0]);
    case 'last': return focus(nodes[nodes.length - 1]);
    case 'right':
      if (!me.expandable) return null;
      if (!me.expanded) return { expand: id };
      return focus(nodes[at + 1]?.parent === id ? nodes[at + 1] : undefined);
    case 'left':
      if (me.expandable && me.expanded) return { collapse: id };
      return focus(nodes.find((n) => n.id === me.parent));
  }
}

// ---------------------------------------------------------------- dragging

/** Whether a press on this row may start a drag. */
export const canDrag = (node: Pick<LayerNode, 'movable'>, readOnly: boolean): boolean => node.movable && !readOnly;

export interface Drop { target: Id; where: 'above' | 'below' }

/**
 * Where dropping the dragged row would put it, given the row the pointer is over and how far down that row it is (0 top,
 * 1 bottom). Only a movable row of the same parent and the same kind (frames among frames) is a target, and not the spot the
 * row already has; everything else gives null and shows no line.
 */
export function dropTarget(nodes: readonly LayerNode[], dragId: Id, overId: Id, fraction: number): Drop | null {
  const me = nodes.find((n) => n.id === dragId);
  const over = nodes.find((n) => n.id === overId);
  if (!me || !over || !me.movable || !over.movable || me.id === over.id) return null;
  if (me.parent !== over.parent || isFrameClass(me) !== isFrameClass(over)) return null;
  const where = fraction < 0.5 ? 'above' : 'below';
  const siblings = nodes.filter((n) => n.parent === me.parent && n.movable && isFrameClass(n) === isFrameClass(me));
  const mine = siblings.findIndex((n) => n.id === me.id);
  const theirs = siblings.findIndex((n) => n.id === over.id);
  if ((where === 'above' && theirs === mine + 1) || (where === 'below' && theirs === mine - 1)) return null;
  return { target: over.id, where };
}

/**
 * The row edge the insertion line sits on. Above a row it is that row's top; below one it is the bottom of the last row
 * under it, since a container's children are listed beneath it.
 */
export function lineEdge(nodes: readonly LayerNode[], drop: Drop): { row: Id; edge: 'top' | 'bottom' } {
  if (drop.where === 'above') return { row: drop.target, edge: 'top' };
  const at = nodes.findIndex((n) => n.id === drop.target);
  let last = at;
  while (at >= 0 && nodes[last + 1] && nodes[last + 1].depth > nodes[at].depth) last++;
  return { row: nodes[last]?.id ?? drop.target, edge: 'bottom' };
}
