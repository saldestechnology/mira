import * as Y from 'yjs';
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { FEATURES, featureKey, isContainerType, layoutContainer, orphanHome, unknownFeatures, type ContainerLayout } from '../shared/containers';
import type { BaseObj, BoardMeta, ConnectorObj, Group, Id, Label, Obj, Poll, PollAnswer, Rect, Step, Timer, Vote } from './types';
import { SCHEMA_VERSION, isConnector } from './types';
import { boxBounds } from './geometry';
import { descendantsOf as walkDescendants, frameOf as findFrame, isGroup, membersBounds } from './groups';
import { cleanColor } from '../shared/colors';
import { customStickyColors } from './palette';

/** Transaction origin for edits made on this device; only these are undoable. */
export const LOCAL = 'local';

export type ChangeListener = (changed: Set<Id>, origin?: unknown, fields?: ReadonlyMap<Id, ReadonlySet<string>>) => void;

/** Object fields that hold a colour: what is written to them is checked against shared/colors.mjs (TAB-203). */
export const COLOR_FIELDS: ReadonlySet<string> = new Set(['fill', 'stroke', 'textColor']);
/** Boolean flags on an object: a value that is not true or false is not written (TAB-198, TAB-203). */
const FLAG_FIELDS: ReadonlySet<string> = new Set(['hidden', 'locked', 'flipX', 'flipY']);
const BOX_FLAG_FIELDS: ReadonlySet<string> = new Set(['flipX', 'flipY']);
const TRACKER_CARD_PROJECTION_FIELDS = new Set(['extProvider', 'extKey', 'extUrl', 'trackerId', 'tracker', 'trackerUnmappedState']);

export const DEFAULT_META: BoardMeta = {
  name: 'Untitled board',
  schemaVersion: SCHEMA_VERSION,
  gridType: 'dots',
  gridSize: 24,
  snap: true,
  headingFont: 'cabinet-grotesk',
  bodyFont: 'satoshi',
  stickyColors: [],
};

export interface FlowState {
  steps: Step[];
  active: number;          // -1 when no session is running
  timer: Timer | null;
  reveal: boolean;
  focus: { x: number; y: number; zoom: number; ts: number; by: string } | null;
  stepStartedAt: number;
  /** Vote step whose dots stay on the board after the session ends. */
  results: Id | null;
}

/** Ids whose rectangle differs between two layouts of one container. With no earlier layout to compare, all of them. */
function movedBetween(before: ContainerLayout | null | undefined, after: ContainerLayout | null): Id[] {
  const out: Id[] = [];
  for (const [id, r] of after?.rects ?? []) {
    const was = before?.rects.get(id);
    if (!was || was.x !== r.x || was.y !== r.y || was.w !== r.w || was.h !== r.h) out.push(id);
  }
  for (const id of before?.rects.keys() ?? []) if (!after?.rects.has(id)) out.push(id);
  return out;
}

const cmpZ = (a: Obj, b: Obj) => (a.z < b.z ? -1 : a.z > b.z ? 1 : a.id < b.id ? -1 : 1);
const isFrameLike = (o: Obj) => o.type === 'frame' || o.type === 'tracker';
const EMPTY_GROUP_CLEANUP = Symbol('empty-group-cleanup');

/**
 * Wraps one board's Y.Doc. Keeps a plain-object cache of every board object so
 * rendering and hit-testing never touch Yjs types directly.
 */
export class Store {
  readonly doc: Y.Doc;
  readonly objects: Y.Map<Y.Map<unknown>>;
  readonly meta: Y.Map<unknown>;
  readonly flow: Y.Map<unknown>;
  readonly votes: Y.Map<Vote>;
  readonly polls: Y.Map<Poll>;
  readonly pollAnswers: Y.Map<PollAnswer>;
  /** A poll's changing fields, one key each (`${pollId}:revealed`), so concurrent changes merge. See polls.ts. */
  readonly pollState: Y.Map<unknown>;
  /** Board-wide labels for cards (docs/kanban.md), whole value per label. */
  readonly labels: Y.Map<Label>;
  readonly cache = new Map<Id, Obj>();
  readonly undo: Y.UndoManager;

  private listeners = new Set<ChangeListener>();
  private readOnlyListeners = new Set<(v: boolean) => void>();
  /** Object ids touched by the current undo/redo transaction; consumed by the app's stack-item handler. */
  private undoChangedIds = new Set<Id>();
  /** Cleanup work is keyed to object transactions so ordinary edits do not scan the board. */
  private emptyGroupCleanupHints = new WeakMap<Y.Transaction, { scan: boolean; groups: Set<Id> }>();
  /** Local structural writes clean up in their undoable transaction; don't repeat the scan after it closes. */
  private locallyCleanedEmptyGroupTransactions = new WeakSet<Y.Transaction>();
  private _readOnly = false;
  private orderDirty = true;
  private orderCache: Obj[] = [];
  private shownCache: Obj[] | null = null;
  private boundIndex = new Map<Id, Set<Id>>(); // shape id -> connector ids
  private childIndex = new Map<Id, Set<Id>>(); // parent id -> child ids
  private groupBoundsCache = new Map<Id, Rect | null>();
  private geometryVisible: (o: Obj) => boolean = () => true;
  private containerIds = new Set<Id>();
  // Derived geometry (docs/kanban.md): one layout per container, dropped when something inside it changes.
  private layouts = new Map<Id, ContainerLayout | null>();
  private placedCache = new WeakMap<Obj, { rect: Rect; obj: Obj }>();
  // Cards whose lane is gone have no container of their own, so they go to one home for everybody (see orphanHome).
  private orphanIds: Id[] = [];
  private orphanHome: Id | null = null;
  private orphanSig = '';

  constructor(doc: Y.Doc) {
    this.doc = doc;
    this.objects = doc.getMap('objects');
    this.meta = doc.getMap('meta');
    this.flow = doc.getMap('flow');
    this.votes = doc.getMap('votes');
    this.polls = doc.getMap('polls');
    this.pollAnswers = doc.getMap('pollAnswers');
    this.pollState = doc.getMap('pollState');
    this.labels = doc.getMap('labels');

    this.objects.forEach((m, id) => this.cache.set(id, this.cachedObject(m.toJSON() as Obj)));
    this.rebuildBoundIndex();
    this.rebuildChildIndex();
    this.refreshOrphans();

    this.objects.observeDeep((events, transaction) => {
      const changed = new Set<Id>();
      const changedFields = new Map<Id, Set<string>>();
      const noteFields = (id: Id, fields: Iterable<string>) => {
        let set = changedFields.get(id);
        if (!set) changedFields.set(id, (set = new Set()));
        for (const field of fields) set.add(field);
      };
      let scanForEmptyGroups = false;
      const createdGroups = new Set<Id>();
      for (const e of events) {
        if (e.target === this.objects) {
          for (const [id, change] of e.changes.keys) {
            changed.add(id);
            // Root-map changes create or remove an object; treat them as more than a derived height write.
            noteFields(id, ['*']);
            if (change.action === 'delete') scanForEmptyGroups = true;
            if (change.action === 'add' || change.action === 'update') {
              if (this.objects.get(id)?.get('type') === 'group') createdGroups.add(id);
            }
          }
        } else if (e.path.length > 0) {
          const id = String(e.path[0]);
          changed.add(id);
          noteFields(id, [...e.changes.keys.keys()].map(String));
          if (transaction.changed.get(e.target)?.has('parent')) scanForEmptyGroups = true;
        }
      }
      if (scanForEmptyGroups || createdGroups.size) {
        const hint = this.emptyGroupCleanupHints.get(transaction) ?? { scan: false, groups: new Set<Id>() };
        hint.scan ||= scanForEmptyGroups;
        createdGroups.forEach((id) => hint.groups.add(id));
        this.emptyGroupCleanupHints.set(transaction, hint);
      }
      // Keep only direct object-map changes here. The `changed` set below is also expanded with derived group and
      // layout changes for rendering, which are not part of the objects written by undo/redo.
      if (transaction.origin === this.undo) {
        for (const id of changed) this.undoChangedIds.add(id);
      }
      const edits: [Obj | undefined, Obj | undefined][] = [];
      for (const id of changed) {
        const prev = this.cache.get(id);
        if (isConnector(prev)) this.unindexConnector(prev);
        this.unindexChild(prev);
        if (prev?.type === 'container') this.containerIds.delete(id);
        const m = this.objects.get(id);
        let next: Obj | undefined;
        if (m) {
          next = this.cachedObject(m.toJSON() as Obj);
          this.cache.set(id, next);
          if (isConnector(next)) this.indexConnector(next);
          this.indexChild(next);
          if (next.type === 'container') this.containerIds.add(id);
        } else {
          this.cache.delete(id);
        }
        edits.push([prev, next]);
      }
      for (const [before, after] of edits) {
        this.invalidateGroupAncestors(before, changed);
        this.invalidateGroupAncestors(after, changed);
      }
      // What moved or resized because of its container is reported as changed too, so drawing and bounds follow.
      for (const [cid, before] of this.dropLayouts(edits)) {
        const after = this.containerLayout(cid);
        // no layout to compare with (a container removed before it was ever laid out): everything inside is reported
        const moved = before === undefined && !after ? this.membersOf(cid) : movedBetween(before, after);
        for (const id of moved) changed.add(id);
      }
      this.orderDirty = true;
      this.shownCache = null;
      this.listeners.forEach((l) => l(changed, transaction.origin, changedFields));
    });

    // Only deletions and parent changes can empty an existing group. Local Store.remove and update calls handle those
    // in their own transaction; this catches empty groups from remote merges. A newly created group is checked as a
    // candidate so the long-standing empty-group creation cleanup does not require a board-wide scan.
    this.doc.on('afterTransaction', (transaction) => {
      if (transaction.origin === EMPTY_GROUP_CLEANUP) return;
      const hint = this.emptyGroupCleanupHints.get(transaction);
      if (!hint) return;
      if (hint.scan) {
        if (this.locallyCleanedEmptyGroupTransactions.has(transaction)) {
          if (hint.groups.size) {
            this.doc.transact(() => this.removeEmptyGroupCandidates(hint.groups), EMPTY_GROUP_CLEANUP);
          }
          return;
        }
        const empty = this.emptyGroupIds();
        if (empty.length) this.doc.transact(() => this.removeEmptyGroups(empty), EMPTY_GROUP_CLEANUP);
      } else if (hint.groups.size) {
        this.doc.transact(() => this.removeEmptyGroupCandidates(hint.groups), EMPTY_GROUP_CLEANUP);
      }
    });

    this.undo = new Y.UndoManager([this.objects, this.meta, this.labels], {
      trackedOrigins: new Set([LOCAL]),
      captureTimeout: 350,
    });
    // Also clear on an undo/redo transaction with no object observer events (for example meta-only and labels-only).
    this.doc.on('beforeTransaction', (transaction) => {
      if (transaction.origin === this.undo) this.undoChangedIds.clear();
    });
  }

  /** Returns and clears the object ids changed by the latest undo/redo transaction. */
  takeUndoChanged(): Set<Id> {
    const changed = new Set(this.undoChangedIds);
    this.undoChangedIds.clear();
    return changed;
  }

  onChange(l: ChangeListener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  get readOnly(): boolean {
    return this._readOnly;
  }

  setReadOnly(v: boolean) {
    if (v === this._readOnly) return;
    this._readOnly = v;
    this.readOnlyListeners.forEach((l) => l(v));
  }

  onReadOnly(fn: (v: boolean) => void): () => void {
    this.readOnlyListeners.add(fn);
    return () => {
      this.readOnlyListeners.delete(fn);
    };
  }

  /** Every local write goes through transact or transactAs, so a read-only store cannot write. */
  transact(fn: () => void) {
    this.transactAs(fn, LOCAL);
  }

  transactAs(fn: () => void, origin: string) {
    if (this._readOnly) return;
    this.doc.transact(fn, origin);
  }

  get(id: Id | undefined): Obj | undefined {
    return id ? this.cache.get(id) : undefined;
  }

  /**
   * All objects in paint order: frames first, then by z. A container is painted as a unit at its own z (the container,
   * its lanes, then each lane's cards), so what is laid out inside it has no z of its own.
   */
  ordered(): Obj[] {
    if (this.orderDirty) {
      const all = [...this.cache.values()];
      const frames = all.filter(isFrameLike).sort(cmpZ);
      const rest = all.filter((o) => !isFrameLike(o) && !this.isLaidOut(o)).sort(cmpZ);
      const out: Obj[] = [...frames];
      const seen = new Set<Id>(frames.map((o) => o.id));
      const append = (o: Obj) => {
        if (seen.has(o.id) || isFrameLike(o) || this.isLaidOut(o)) return;
        seen.add(o.id);
        out.push(o);
        if (isGroup(o)) {
          for (const child of this.childrenOf(o.id).filter((c) => c.parent === o.id).sort(cmpZ)) append(child);
        } else if (o.type === 'container') {
          for (const id of this.containerLayout(o.id)?.order ?? []) {
            const child = this.cache.get(id);
            if (child && !seen.has(child.id)) {
              seen.add(child.id);
              out.push(child);
            }
          }
        }
      };
      for (const o of rest) {
        const parent = o.parent ? this.cache.get(o.parent) : undefined;
        if (!isGroup(parent)) append(o);
      }
      // A malformed parent cycle has no root. Start its first group by z, then stop when an id repeats.
      for (const o of rest.filter(isGroup)) append(o);
      for (const o of rest) append(o);
      this.orderCache = out;
      this.orderDirty = false;
    }
    return this.orderCache;
  }

  /**
   * Whether an object is drawn (TAB-198): not hidden, not inside a hidden frame or container, and for a connector, neither
   * bound end hidden, so no line is left pointing at nothing. Hidden is for everyone and is not private.
   */
  isShown(o: Obj): boolean {
    if (!this.objectVisible(o)) return false;
    if (isGroup(o) && !this.groupBounds(o)) return false;
    if (isConnector(o)) {
      for (const end of [o.from, o.to]) {
        if (end.kind !== 'bound') continue;
        const at = this.cache.get(end.id);
        if (at && at.type !== 'connector' && !this.isShown(at)) return false;
      }
    }
    return true;
  }

  private objectVisible(o: Obj): boolean {
    if (o.hidden === true) return false;
    const seen = new Set<Id>([o.id]);
    for (let p = o.parent ? this.cache.get(o.parent) : undefined; p && !seen.has(p.id); p = p.parent ? this.cache.get(p.parent) : undefined) {
      if (p.hidden === true) return false;
      seen.add(p.id);
    }
    return true;
  }

  /** `ordered()` without what is hidden: what the canvas draws, hits, selects, snaps to and exports. */
  shown(): Obj[] {
    this.shownCache ??= this.ordered().filter((o) => this.isShown(o));
    return this.shownCache;
  }

  topZ(): string {
    const ord = this.ordered();
    let max: string | null = null;
    for (const o of ord) if (max === null || o.z > max) max = o.z;
    return generateKeyBetween(max, null);
  }

  /** `n` ascending keys above everything on the board. */
  topZs(n: number): string[] {
    let max: string | null = null;
    for (const o of this.cache.values()) if (max === null || o.z > max) max = o.z;
    return generateNKeysBetween(max, null, n);
  }

  bottomZ(): string {
    let min: string | null = null;
    for (const o of this.cache.values()) if (min === null || o.z < min) min = o.z;
    return generateKeyBetween(null, min);
  }

  /** `n` ascending keys below everything on the board. */
  bottomZs(n: number): string[] {
    let min: string | null = null;
    for (const o of this.cache.values()) if (min === null || o.z < min) min = o.z;
    return generateNKeysBetween(null, min, n);
  }

  /** Writes new stacking keys in one step (one undo step). Returns whether anything was written. */
  restack(patches: { id: Id; z: string }[] | null): boolean {
    if (!patches?.length || this._readOnly) return false;
    this.transact(() => patches.forEach((p) => this.update(p.id, { z: p.z })));
    return true;
  }

  /** Put the given objects above everything else, keeping their order among themselves. */
  bringToFront(ids: Iterable<Id>) {
    const set = new Set(ids);
    const sel = this.ordered().filter((o) => set.has(o.id) && !this.isLaidOut(o));
    if (!sel.length) return;
    const zs = this.topZs(sel.length);
    this.transact(() => sel.forEach((o, i) => this.update(o.id, { z: zs[i] })));
  }

  /** Put the given objects below everything else, keeping their order among themselves. */
  sendToBack(ids: Iterable<Id>) {
    const set = new Set(ids);
    const sel = this.ordered().filter((o) => set.has(o.id) && !this.isLaidOut(o));
    if (!sel.length) return;
    const zs = this.bottomZs(sel.length);
    this.transact(() => sel.forEach((o, i) => this.update(o.id, { z: zs[i] })));
  }

  create(o: Obj) {
    const stored = isGroup(o) ? { ...o, x: 0, y: 0, w: 0, h: 0, rotation: 0 }
      : o.type === 'tracker' ? { ...o, w: Math.max(480, Number.isFinite(o.w) ? o.w : 0), h: Math.max(360, Number.isFinite(o.h) ? o.h : 0), rotation: 0 }
      : o;
    // a colour outside the grammar is left out, so the object takes its type's default (TAB-203). A kanban container,
    // lane or card keeps what it has: its fill may be a palette key, which its own drawing checks (kanbanColor).
    const checked = (k: string) => COLOR_FIELDS.has(k) && !isContainerType(stored.type);
    // a flag such as `hidden` (TAB-198) is a boolean or absent; anything else is left out rather than read as truthy
    const entries = Object.entries(stored)
      .filter(([k, v]) => v !== undefined
        && !(stored.type === 'card' && TRACKER_CARD_PROJECTION_FIELDS.has(k))
        && k !== 'ext'
        && k !== 'tracker'
        && (!checked(k) || cleanColor(v) !== null)
        && (!FLAG_FIELDS.has(k) || typeof v === 'boolean')
        && (!BOX_FLAG_FIELDS.has(k) || (!isConnector(stored) && !isGroup(stored))))
      .map(([k, v]): [string, unknown] => [k, checked(k) ? cleanColor(v) : v]);
    this.objects.set(o.id, new Y.Map(entries));
    if (isContainerType(o.type)) this.needFeature(FEATURES.containers);
    if (o.type === 'tracker') this.needFeature(FEATURES.tracker);
  }

  update(id: Id, patch: Partial<Obj> | Record<string, unknown>) {
    const m = this.objects.get(id);
    if (!m) return;
    const group = m.get('type') === 'group';
    let wroteField = false;
    let parentChanged = false;
    for (const [k, raw] of Object.entries(patch)) {
      const currentType = m.get('type');
      const type = (patch as Record<string, unknown>).type ?? currentType;
      if ((currentType === 'card' || type === 'card') && TRACKER_CARD_PROJECTION_FIELDS.has(k)) continue;
      if (k === 'ext' || k === 'tracker') continue;
      if (group && ['x', 'y', 'w', 'h', 'rotation'].includes(k)) continue;
      if (BOX_FLAG_FIELDS.has(k) && (type === 'connector' || type === 'group')) continue;
      if (type === 'tracker' && k === 'rotation') continue;
      if (raw === undefined) {
        if (m.has(k)) { m.delete(k); wroteField = true; if (k === 'parent') parentChanged = true; }
        continue;
      }
      // a colour outside the grammar is not written; the object keeps the colour it has (TAB-203; kanban types as in create)
      const v = type === 'tracker' && (k === 'w' || k === 'h') && typeof raw === 'number' && Number.isFinite(raw)
        ? Math.max(k === 'w' ? 480 : 360, raw)
        : COLOR_FIELDS.has(k) && !(typeof type === 'string' && isContainerType(type)) ? cleanColor(raw) : raw;
      if (v === null) continue;
      if (FLAG_FIELDS.has(k) && typeof v !== 'boolean') continue;
      const cur = m.get(k);
      if (typeof v === 'object' ? JSON.stringify(cur) !== JSON.stringify(v) : cur !== v) {
        m.set(k, v);
        wroteField = true;
        if (k === 'parent') parentChanged = true;
      }
    }
    if (m.get('type') === 'tracker') {
      for (const [key, min] of [['w', 480], ['h', 360]] as const) {
        const value = m.get(key);
        if (typeof value === 'number' && Number.isFinite(value) && value < min) { m.set(key, min); wroteField = true; }
      }
      if (m.get('rotation') !== 0) { m.set('rotation', 0); wroteField = true; }
    }
    if (m.size && (!group || wroteField)) m.set('updatedAt', Date.now());
    const type = (patch as Record<string, unknown>).type;
    if (typeof type === 'string' && isContainerType(type)) this.needFeature(FEATURES.containers);
    if (type === 'tracker') this.needFeature(FEATURES.tracker);
    if (parentChanged) {
      const transaction = this.doc._transaction;
      if (transaction) this.locallyCleanedEmptyGroupTransactions.add(transaction);
      this.removeEmptyGroups();
    }
  }

  remove(ids: Iterable<Id>) {
    const transaction = this.doc._transaction;
    if (transaction) this.locallyCleanedEmptyGroupTransactions.add(transaction);
    for (const id of ids) this.objects.delete(id);
    this.removeEmptyGroups();
  }

  /** Removes structurally empty groups, including ancestors made empty by removing nested groups. */
  private removeEmptyGroups(firstPass = this.emptyGroupIds()): Id[] {
    const removed: Id[] = [];
    let empty = firstPass;
    for (;;) {
      if (!empty.length) return removed;
      for (const id of empty) {
        if (this.objects.has(id)) {
          this.objects.delete(id);
          removed.push(id);
        }
      }
      empty = this.emptyGroupIds();
    }
  }

  /** Checks newly created groups and any ancestors they leave empty, without scanning unrelated groups. */
  private removeEmptyGroupCandidates(candidates: Iterable<Id>): Id[] {
    const childCounts = new Map<Id, number>();
    const childCount = (id: Id) => childCounts.get(id) ?? this.childIndex.get(id)?.size ?? 0;
    const pending = [...candidates];
    const removed: Id[] = [];
    while (pending.length) {
      const id = pending.pop()!;
      const group = this.objects.get(id);
      if (group?.get('type') !== 'group' || childCount(id) > 0) continue;
      const parent = group.get('parent');
      this.objects.delete(id);
      removed.push(id);
      if (typeof parent === 'string') {
        const remaining = Math.max(0, childCount(parent) - 1);
        // Preserve zero while the observer's childIndex still contains the just-deleted child.
        childCounts.set(parent, remaining);
        if (remaining === 0 && this.objects.get(parent)?.get('type') === 'group') pending.push(parent);
      }
    }
    return removed;
  }

  /** Direct children count even when they are hidden; groups are removed only when structurally empty. */
  private emptyGroupIds(): Id[] {
    const groups = new Set<Id>();
    const parentsWithChildren = new Set<Id>();
    this.objects.forEach((object, id) => {
      if (object.get('type') === 'group') groups.add(id);
      const parent = object.get('parent');
      if (typeof parent === 'string') parentsWithChildren.add(parent);
    });
    return [...groups].filter((id) => !parentsWithChildren.has(id));
  }

  /** Connectors whose ends are bound to the given object. */
  connectorsOf(id: Id): ConnectorObj[] {
    const set = this.boundIndex.get(id);
    if (!set) return [];
    const out: ConnectorObj[] = [];
    for (const cid of set) {
      const c = this.cache.get(cid);
      if (isConnector(c)) out.push(c);
    }
    return out;
  }

  childrenOf(parentId: Id): Obj[] {
    const out: Obj[] = [];
    for (const id of this.childIndex.get(parentId) ?? []) {
      const o = this.cache.get(id);
      if (o) out.push(o);
    }
    return out;
  }

  descendantsOf(id: Id): Obj[] {
    return walkDescendants(id, (childId) => this.cache.get(childId), (parentId) => this.childrenOf(parentId));
  }

  frameOf(o: Obj): BaseObj | undefined {
    return findFrame(o, (id) => this.cache.get(id));
  }

  /** Refreshes group geometry after private-note visibility changes with the active flow step. */
  invalidateGeometryVisibility() {
    this.groupBoundsCache.clear();
    this.shownCache = null;
  }

  setGeometryVisibility(predicate: (o: Obj) => boolean) {
    this.geometryVisible = predicate;
    this.invalidateGeometryVisibility();
  }

  /** The layout of a container and everything in it; null when it is not a container or its layout is unknown. */
  containerLayout(id: Id): ContainerLayout | null {
    const c = this.cache.get(id);
    if (c?.type !== 'container') return null;
    let layout = this.layouts.get(id);
    if (layout === undefined) {
      // a hidden lane or card (TAB-198) leaves the layout, so the board closes up around it
      const lanes = this.childrenOf(id).filter((o) => o.type === 'lane' && o.hidden !== true);
      const cards = lanes.flatMap((l) => this.childrenOf(l.id).filter((o) => o.type === 'card' && o.hidden !== true));
      if (this.orphanHome === id) for (const oid of this.orphanIds) if (this.cache.get(oid)!.hidden !== true) cards.push(this.cache.get(oid)!);
      layout = layoutContainer(c, lanes, cards);
      this.layouts.set(id, layout);
    }
    return layout;
  }

  /** The layout that places this object, if one does. */
  private layoutOf(o: Obj): ContainerLayout | null {
    if (o.type === 'container') return this.containerLayout(o.id);
    if (o.type === 'lane') return o.parent ? this.containerLayout(o.parent) : null;
    if (o.type !== 'card' || o.parent === undefined) return null;
    const parent = this.cache.get(o.parent);
    if (parent) return parent.type === 'lane' && parent.parent ? this.containerLayout(parent.parent) : null;
    return this.orphanHome ? this.containerLayout(this.orphanHome) : null;
  }

  /** Whether the object's rectangle comes from a container's layout, so its stored x, y, w and h are not read. */
  isLaidOut(o: Obj): boolean {
    return (o.type === 'lane' || o.type === 'card') && !!this.layoutOf(o)?.rects.has(o.id);
  }

  /** Where the object is: derived for a container's size and for what is laid out in it, stored for everything else. */
  geometry(o: Obj): Rect {
    if (isGroup(o)) return this.groupBounds(o) ?? { x: 0, y: 0, w: 0, h: 0 };
    const r = isContainerType(o.type) ? this.layoutOf(o)?.rects.get(o.id) : undefined;
    return r ?? { x: o.x ?? 0, y: o.y ?? 0, w: o.w ?? 0, h: o.h ?? 0 };
  }

  /** The object as it is drawn: itself, or for a container and what it lays out a copy with the derived rectangle. */
  placed<T extends Obj>(o: T): T {
    if (isGroup(o)) {
      const rect = this.groupBounds(o);
      return { ...o, ...(rect ?? { x: 0, y: 0, w: 0, h: 0 }), rotation: 0 } as T;
    }
    if (!isContainerType(o.type)) return o;
    const rect = this.layoutOf(o)?.rects.get(o.id);
    if (!rect) return o;
    const hit = this.placedCache.get(o);
    if (hit?.rect === rect) return hit.obj as T;
    const obj = { ...o, ...rect, rotation: 0 };
    const entry = { rect, obj };
    this.placedCache.set(o, entry);
    this.placedCache.set(obj, entry);
    return obj;
  }

  getPlaced(id: Id | undefined): Obj | undefined {
    const o = this.get(id);
    return o && this.placed(o);
  }

  /** Board features this client does not know: when there are any, the board must not be edited from here. */
  unsupportedFeatures(): string[] {
    return unknownFeatures(this.meta.toJSON());
  }

  private needFeature(name: string) {
    const key = featureKey(name);
    if (this.meta.get(key) !== true) this.meta.set(key, true);
  }

  /**
   * Lists `containers` as needed if the board holds a container, lane or card. For writers that change objects without
   * `create` and `update`, such as a restore; the flag is only ever added, never taken away.
   */
  syncFeatures() {
    let containers = false;
    let tracker = false;
    for (const m of this.objects.values()) {
      const type = String(m.get('type'));
      if (isContainerType(type)) containers = true;
      if (type === 'tracker') tracker = true;
    }
    if (containers) this.needFeature(FEATURES.containers);
    if (tracker) this.needFeature(FEATURES.tracker);
  }

  getMeta(): BoardMeta {
    const raw = this.meta.toJSON() as Partial<BoardMeta>;
    return { ...DEFAULT_META, ...raw };
  }

  setMeta(patch: Partial<BoardMeta>) {
    this.transact(() => {
      for (const [k, v] of Object.entries(patch)) this.meta.set(k, k === 'stickyColors' ? customStickyColors(v) : v);
    });
  }

  getFlow(): FlowState {
    const f = this.flow.toJSON() as Partial<FlowState>;
    return {
      steps: f.steps ?? [],
      active: f.active ?? -1,
      timer: f.timer ?? null,
      reveal: f.reveal ?? false,
      focus: f.focus ?? null,
      stepStartedAt: f.stepStartedAt ?? 0,
      results: f.results ?? null,
    };
  }

  setFlow(patch: Partial<FlowState>) {
    // Flow changes are session control, not content: they are not undoable.
    this.transactAs(() => {
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) this.flow.delete(k);
        else this.flow.set(k, v);
      }
    }, 'flow');
  }

  private rebuildBoundIndex() {
    this.boundIndex.clear();
    for (const o of this.cache.values()) if (isConnector(o)) this.indexConnector(o);
  }

  private rebuildChildIndex() {
    this.childIndex.clear();
    this.containerIds.clear();
    for (const o of this.cache.values()) {
      this.indexChild(o);
      if (o.type === 'container') this.containerIds.add(o.id);
    }
  }

  private cachedObject(o: Obj): Obj {
    return isGroup(o) ? { ...o, x: 0, y: 0, w: 0, h: 0, rotation: 0 } : o;
  }

  private groupBounds(group: Group): Rect | null {
    if (this.groupBoundsCache.has(group.id)) return this.groupBoundsCache.get(group.id)!;
    const bounds = membersBounds(
      group,
      (id) => this.cache.get(id),
      (id) => this.childrenOf(id),
      (o) => this.geometryVisible(o) && this.objectVisible(o),
      (o) => boxBounds(this.placed(o) as BaseObj),
    );
    this.groupBoundsCache.set(group.id, bounds);
    return bounds;
  }

  private invalidateGroupAncestors(o: Obj | undefined, changed: Set<Id>) {
    if (!o) return;
    const seen = new Set<Id>([o.id]);
    if (isGroup(o)) {
      this.groupBoundsCache.delete(o.id);
      changed.add(o.id);
    }
    let parentId = o.parent;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = this.cache.get(parentId);
      if (!parent) break;
      if (isGroup(parent)) {
        this.groupBoundsCache.delete(parent.id);
        changed.add(parent.id);
      }
      parentId = parent.parent;
    }
  }

  private indexChild(o: Obj) {
    if (typeof o.parent !== 'string') return;
    let s = this.childIndex.get(o.parent);
    if (!s) this.childIndex.set(o.parent, (s = new Set()));
    s.add(o.id);
  }

  private unindexChild(o: Obj | undefined) {
    if (typeof o?.parent !== 'string') return;
    const s = this.childIndex.get(o.parent);
    if (!s) return;
    s.delete(o.id);
    if (!s.size) this.childIndex.delete(o.parent);
  }

  /** The lanes of a container and their cards, by parent, whether or not the container still exists. */
  private membersOf(id: Id): Id[] {
    const out: Id[] = [];
    for (const lane of this.childrenOf(id)) {
      out.push(lane.id);
      for (const card of this.childrenOf(lane.id)) out.push(card.id);
    }
    return out;
  }

  /** Forgets the layout of every container something inside changed in, and returns those containers with the layout they had. */
  private dropLayouts(edits: [Obj | undefined, Obj | undefined][]): Map<Id, ContainerLayout | null | undefined> {
    const affected = new Map<Id, ContainerLayout | null | undefined>();
    let all = false;
    // `container`: the edit itself was a container, new, changed or deleted, whatever the cache holds for it now
    const drop = (id: Id | undefined, container = false) => {
      if (id === undefined) return;
      if (!affected.has(id) && (container || this.cache.get(id)?.type === 'container')) affected.set(id, this.layouts.get(id));
      this.layouts.delete(id);
    };
    let structure = false;
    for (const edit of edits) {
      for (const o of edit) {
        if (!o || !isContainerType(o.type)) continue;
        structure = true;
        if (o.type === 'container') drop(o.id, true);
        else if (o.type === 'lane') drop(o.parent);
        else {
          const lane = o.parent === undefined ? undefined : this.cache.get(o.parent);
          if (lane?.type === 'lane') drop(lane.parent);
          else if (o.parent !== undefined && !lane) all = true;
        }
      }
    }
    if (structure && this.refreshOrphans()) all = true;
    if (!all) return affected;
    for (const id of this.containerIds) if (!affected.has(id)) affected.set(id, this.layouts.get(id));
    this.layouts.clear();
    return affected;
  }

  /** Recomputes which cards have lost their lane; true when that changed what any container shows. */
  private refreshOrphans(): boolean {
    const ids: Id[] = [];
    for (const [parent, kids] of this.childIndex) {
      if (this.cache.has(parent)) continue;
      for (const id of kids) if (this.cache.get(id)?.type === 'card') ids.push(id);
    }
    ids.sort();
    const home = orphanHome([...this.containerIds].map((id) => this.cache.get(id)!));
    const sig = `${home ?? ''}|${ids.join(',')}`;
    if (sig === this.orphanSig) return false;
    this.orphanSig = sig;
    this.orphanIds = ids;
    this.orphanHome = home;
    return true;
  }

  private indexConnector(c: ConnectorObj) {
    for (const end of [c.from, c.to]) {
      if (end?.kind === 'bound') {
        let s = this.boundIndex.get(end.id);
        if (!s) this.boundIndex.set(end.id, (s = new Set()));
        s.add(c.id);
      }
    }
  }

  private unindexConnector(c: ConnectorObj) {
    for (const end of [c.from, c.to]) {
      if (end?.kind === 'bound') this.boundIndex.get(end.id)?.delete(c.id);
    }
  }
}

export function newId(): Id {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-_'[b & 63]).join('');
}
