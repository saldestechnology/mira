// One step in the stacking order (TAB-108): Bring forward and Send backward move the selection past the nearest object
// it overlaps, not to the very top or bottom. Pure functions over the objects in paint order; the store writes the keys.
//
// "Overlaps" is a question for the caller (it knows how big a connector or a frame title is); this module only asks it.
// Frames always paint below everything else whatever their key, so a step only ever compares an object with the objects
// of its own kind: a frame is stepped among frames, anything else among the rest. Groups are one sibling item; their
// derived rectangle is supplied by the caller's overlap function, and their members stay in their own sibling row.
import { generateNKeysBetween } from 'fractional-indexing';
import type { Id, Obj } from './types';

export interface ZPatch { id: Id; z: string }

const cmp = (a: Obj, b: Obj) => (a.z < b.z ? -1 : a.z > b.z ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** `list` ascending by key (ties by id), `selected` the ids to move. Returns the new keys, or null when nothing would change. */
function stepWithin(list: Obj[], selected: Set<Id>, direction: 1 | -1, overlaps: (a: Obj, b: Obj) => boolean): ZPatch[] | null {
  const mine = list.filter((o) => selected.has(o.id));
  if (!mine.length) return null;
  // the first object that is not being moved, past the selection in the direction of travel, and touches any of it
  const indexes = mine.map((o) => list.indexOf(o));
  const from = direction === 1 ? Math.max(...indexes) + 1 : Math.min(...indexes) - 1;
  let target = -1;
  for (let i = from; i >= 0 && i < list.length; i += direction) {
    const candidate = list[i];
    if (selected.has(candidate.id)) continue;
    if (mine.some((m) => overlaps(m, candidate))) {
      target = i;
      break;
    }
  }
  if (target === -1) return null;

  // the neighbours on the far side of the target (skipping what is being moved) bound the new keys
  const others = list.filter((o) => !selected.has(o.id));
  const at = others.indexOf(list[target]);
  const lo = direction === 1 ? others[at] : others[at - 1];
  const hi = direction === 1 ? others[at + 1] : others[at];
  const keys = betweenKeys(lo?.z ?? null, hi?.z ?? null, mine.length);
  if (keys) return mine.map((o, i) => ({ id: o.id, z: keys[i] }));

  // equal keys on both sides (an old board): write the whole row again, evenly spaced, in the order wanted
  const order = [...others];
  order.splice(direction === 1 ? at + 1 : at, 0, ...mine);
  const fresh = generateNKeysBetween(null, null, order.length);
  return order.map((o, i) => ({ id: o.id, z: fresh[i] })).filter((p) => list.find((o) => o.id === p.id)!.z !== p.z);
}

function betweenKeys(lo: string | null, hi: string | null, n: number): string[] | null {
  if (lo !== null && hi !== null && lo >= hi) return null;
  try {
    return generateNKeysBetween(lo, hi, n);
  } catch {
    return null;
  }
}

/**
 * The key changes that move `ids` one step forward (`1`) or backward (`-1`): past the nearest object that overlaps them, the
 * moved objects keeping their order among themselves. Null when nothing overlaps in that direction (already as far as a
 * step goes). `objects` is every object of the board, in any order.
 */
export function planStep(objects: Obj[], ids: Iterable<Id>, direction: 1 | -1, overlaps: (a: Obj, b: Obj) => boolean): ZPatch[] | null {
  const selected = new Set(ids);
  const sorted = [...objects].sort(cmp);
  const byId = new Map(sorted.map((o) => [o.id, o]));
  const patches: ZPatch[] = [];
  const buckets = new Map<Id | undefined, Map<boolean, Set<Id>>>();
  for (const id of selected) {
    const o = byId.get(id);
    if (!o) continue;
    const frame = o.type === 'frame' || o.type === 'tracker';
    let byKind = buckets.get(o.parent);
    if (!byKind) buckets.set(o.parent, (byKind = new Map()));
    let bucket = byKind.get(frame);
    if (!bucket) byKind.set(frame, (bucket = new Set()));
    bucket.add(id);
  }
  for (const [parent, byKind] of buckets) for (const [frame, bucket] of byKind) {
    const row = sorted.filter((o) => o.parent === parent && (o.type === 'frame' || o.type === 'tracker') === frame);
    const step = stepWithin(row, bucket, direction, overlaps);
    if (step) patches.push(...step);
  }
  return patches.length ? patches : null;
}
