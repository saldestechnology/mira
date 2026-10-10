import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { featuresOf } from '../shared/containers';
import { boardAccess } from '../src/cloud-logic';
import { remapObjects } from '../src/custom-templates';
import { applyRestore, planRestore } from '../src/history';
import { objectMarkup } from '../src/markup';
import { exportSvg, toDrift, toJson } from '../src/exporters';
import { handlesFor } from '../src/render';
import { safeObj } from '../src/safe-obj';
import { Store } from '../src/store';
import { createTrackerFrame, TRACKER_FRAME_DEFAULT_SIZE } from '../src/tracker-frame';
import type { BaseObj } from '../src/types';
import { strFromU8, unzipSync } from 'fflate';

function trackerApp(store: Store) {
  return {
    store,
    r: {
      contentBounds: () => ({ x: 0, y: 0, w: 1280, h: 800 }),
      ctx: { get: (id: string) => store.getPlaced(id) },
    },
    conn: { comments: { list: () => [] } },
    flow: { isHidden: () => false, polls: { snapshot: () => ({ polls: [], answers: [] }) } },
    images: { blobOf: async () => null },
  };
}

describe('tracker frame object', () => {
  it('survives a Yjs round trip with navigation fields and uses the default frame size', () => {
    const store = new Store(new Y.Doc());
    const frame = createTrackerFrame(store, { x: 24, y: 48 })!;
    expect(frame).toMatchObject({
      type: 'tracker', x: 24, y: 48, ...TRACKER_FRAME_DEFAULT_SIZE, rotation: 0, view: 'inbox',
    });
    expect(frame.trackerId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);

    const copyDoc = new Y.Doc();
    Y.applyUpdate(copyDoc, Y.encodeStateAsUpdate(store.doc));
    const copy = new Store(copyDoc).get(frame.id);
    expect(copy).toMatchObject({
      type: 'tracker', trackerId: frame.trackerId, view: 'inbox',
    });
  });

  it('validates navigation fields and ignores invalid strings', () => {
    const safe = safeObj({
      id: 'tracker', type: 'tracker', x: 0, y: 0, w: 300, h: 200, rotation: 1, z: 'a0',
      trackerId: 'x'.repeat(65), view: 'milestones', viewId: 'view with spaces', focusKey: 'TAB/12',
    } as unknown as BaseObj);
    expect(safe).not.toHaveProperty('trackerId');
    expect(safe).not.toHaveProperty('view');
    expect(safe).not.toHaveProperty('viewId');
    expect(safe).not.toHaveProperty('focusKey');
    expect(safe).toMatchObject({ w: 480, h: 360, rotation: 0 });
  });

  it('writes the tracker feature marker atomically and makes later frames share the workspace tracker', () => {
    const store = new Store(new Y.Doc());
    let objectTransaction: Y.Transaction | undefined;
    let metaTransaction: Y.Transaction | undefined;
    store.objects.observe((event) => { objectTransaction = event.transaction; });
    store.meta.observe((event) => { metaTransaction = event.transaction; });

    const first = createTrackerFrame(store, { x: 0, y: 0 })!;
    expect(objectTransaction).toBe(metaTransaction);
    expect(store.meta.get('feature:tracker')).toBe(true);
    expect(store.unsupportedFeatures()).toEqual([]);

    const second = createTrackerFrame(store, { x: 1400, y: 0 })!;
    expect(second.id).not.toBe(first.id);
    expect(second.trackerId).toBe(first.trackerId);
    const pasted = remapObjects([first], new Map([[first.id, 'pasted']]), { x: 40, y: 40 }, () => null)[0] as BaseObj;
    store.transact(() => store.create(pasted));
    expect(store.get('pasted')).toMatchObject({ type: 'tracker', trackerId: first.trackerId, view: 'inbox' });
  });

  it('keeps old clients read-only when they encounter the tracker marker', () => {
    const store = new Store(new Y.Doc());
    const featuresKnownByOldClient = new Set(['containers']);
    const applyOldGate = () => {
      const unknown = featuresOf(store.meta.toJSON()).some((feature) => !featuresKnownByOldClient.has(feature));
      store.setReadOnly(boardAccess('owner', null, false, unknown).storeReadOnly);
    };
    store.meta.observe(applyOldGate);
    applyOldGate();
    expect(store.readOnly).toBe(false);

    createTrackerFrame(store, { x: 0, y: 0 });
    expect(store.readOnly).toBe(true);
  });

  it('restores navigation-state changes and remains resizable without a rotation handle', () => {
    const live = new Store(new Y.Doc());
    const snap = new Store(new Y.Doc());
    const base = {
      id: 'tracker', type: 'tracker', x: 0, y: 0, w: 1280, h: 800, rotation: 0, z: 'a0', trackerId: 'workspace',
    } as BaseObj;
    live.transact(() => live.create({ ...base, view: 'inbox', focusKey: 'TAB-1' }));
    snap.transact(() => snap.create({ ...base, view: 'my', viewId: 'saved', focusKey: 'TAB-2' }));
    const plan = planRestore(live, snap, { isHidden: () => false });
    expect(plan.summary.changed).toBe(1);
    expect(plan.change[0].set).toMatchObject({ view: 'my', viewId: 'saved', focusKey: 'TAB-2' });
    applyRestore(live, plan);
    expect(live.get('tracker')).toMatchObject({ view: 'my', viewId: 'saved', focusKey: 'TAB-2' });

    live.transact(() => live.update('tracker', { w: 100, h: 100, rotation: 0.5 }));
    expect(live.get('tracker')).toMatchObject({ w: 480, h: 360, rotation: 0 });
    const handles = handlesFor(live.get('tracker')!, () => undefined, 1).map((handle) => handle.id);
    expect(handles).toContain('se');
    expect(handles).not.toContain('rot');
  });

  it('exports a static placeholder and carries navigation fields in JSON and .drift files', async () => {
    const store = new Store(new Y.Doc());
    const frame = createTrackerFrame(store, { x: 0, y: 0 })!;
    store.transact(() => store.update(frame.id, { focusKey: 'TAB-42', view: 'all', viewId: 'saved-view' }));
    const app = trackerApp(store);

    const svg = exportSvg(app as never).svg;
    expect(svg).toContain('Tracker');
    expect(svg).toContain('TAB');
    expect(svg).toContain('Open this frame to work with workspace tickets.');
    expect(svg).not.toContain('TAB-42');
    expect(objectMarkup(frame, { get: () => undefined })).toContain('stroke-width="1"');

    expect(toJson(app as never, [frame.id], []).objects[0]).toMatchObject({
      type: 'tracker', trackerId: frame.trackerId, view: 'all', viewId: 'saved-view', focusKey: 'TAB-42',
    });
    const archive = unzipSync(await toDrift(app as never));
    const board = JSON.parse(strFromU8(archive['board.json'])) as { objects: BaseObj[] };
    expect(board.objects[0]).toMatchObject({
      type: 'tracker', trackerId: frame.trackerId, view: 'all', viewId: 'saved-view', focusKey: 'TAB-42',
    });
    const restored = new Store(new Y.Doc());
    Y.applyUpdate(restored.doc, archive['doc.yjs']);
    expect(restored.get(frame.id)).toMatchObject({
      trackerId: frame.trackerId, view: 'all', viewId: 'saved-view', focusKey: 'TAB-42',
    });
  });
});
