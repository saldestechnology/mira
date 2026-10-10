import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store } from '../src/store';
import { toJson } from '../src/exporters';
import type { BoardApp } from '../src/app';

function board() {
  const store = new Store(new Y.Doc());
  store.transact(() => {
    store.create({ id: 'frame', type: 'frame', x: 0, y: 0, w: 500, h: 400, rotation: 0, z: 'a0', name: 'Sprint' });
    store.create({ id: 'group', type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a1', parent: 'frame' });
    store.create({ id: 'one', type: 'sticky', x: 20, y: 30, w: 100, h: 100, rotation: 0, z: 'a2', parent: 'group', text: 'One' });
    store.create({ id: 'two', type: 'sticky', x: 140, y: 30, w: 100, h: 100, rotation: 0, z: 'a3', parent: 'group', text: 'Two' });
    store.create({ id: 'private', type: 'sticky', x: 260, y: 30, w: 100, h: 100, rotation: 0, z: 'a4', parent: 'group', text: 'Private', privateStep: 'writing', createdBy: 'someone-else' });
    store.create({ id: 'layer-hidden', type: 'sticky', x: 380, y: 30, w: 100, h: 100, rotation: 0, z: 'a5', parent: 'group', text: 'Layer hidden', hidden: true });
    store.create({ id: 'outside', type: 'sticky', x: 520, y: 30, w: 100, h: 100, rotation: 0, z: 'a6', text: 'Outside' });
    store.create({ id: 'internal-line', type: 'connector', z: 'a7', parent: 'frame', from: { kind: 'bound', id: 'one', anchor: 'auto' }, to: { kind: 'bound', id: 'two', anchor: 'auto' }, route: 'straight', startHead: 'none', endHead: 'arrow' });
    store.create({ id: 'outside-line', type: 'connector', z: 'a8', parent: 'group', from: { kind: 'bound', id: 'one', anchor: 'auto' }, to: { kind: 'bound', id: 'outside', anchor: 'auto' }, route: 'straight', startHead: 'none', endHead: 'arrow' });
  });
  const app = {
    store,
    conn: { comments: { list: () => [] } },
    flow: {
      isHidden: (o: { type: string; privateStep?: string; createdBy?: string }) =>
        o.type === 'sticky' && !!o.privateStep && o.createdBy !== 'viewer',
      polls: { snapshot: () => ({ polls: [], answers: [] }) },
    },
  } as unknown as BoardApp;
  return { app, store };
}

const snapshot = (app: BoardApp, ids: string[]) => toJson(app, ids, []).objects;

describe('selected JSON snapshots', () => {
  it('omits ancestor frames and clears parent ids that are outside the snapshot', () => {
    const { app } = board();

    const objects = snapshot(app, ['group']);
    const byId = new Map(objects.map((o) => [o.id, o]));

    expect([...byId.keys()]).toEqual(['group', 'one', 'two', 'internal-line']);
    expect(byId.get('group')).not.toHaveProperty('parent');
    expect(byId.get('internal-line')).not.toHaveProperty('parent');
    expect(byId.get('one')?.parent).toBe('group');
    expect(objects.every((o) => !o.parent || byId.has(o.parent))).toBe(true);
  });

  it('omits layer-hidden objects and private notes hidden from this person', () => {
    const { app } = board();

    const ids = snapshot(app, ['group']).map((o) => o.id);

    expect(ids).toContain('one');
    expect(ids).not.toContain('private');
    expect(ids).not.toContain('layer-hidden');
  });

  it('keeps connectors between exported members and omits connectors to outside objects', () => {
    const { app } = board();

    const ids = snapshot(app, ['group']).map((o) => o.id);

    expect(ids).toContain('internal-line');
    expect(ids).not.toContain('outside-line');
    expect(ids).not.toContain('outside');
  });

  it('keeps explicitly selected connectors with free ends when their bound ends are included', () => {
    const { app, store } = board();
    store.transact(() => {
      store.create({ id: 'free-line', type: 'connector', z: 'b0', from: { kind: 'free', x: 0, y: 0 }, to: { kind: 'free', x: 40, y: 40 }, route: 'straight', startHead: 'none', endHead: 'arrow' });
      store.create({ id: 'mixed-line', type: 'connector', z: 'b1', from: { kind: 'bound', id: 'one', anchor: 'auto' }, to: { kind: 'free', x: 80, y: 40 }, route: 'straight', startHead: 'none', endHead: 'arrow' });
    });

    expect(snapshot(app, ['free-line']).map((o) => o.id)).toEqual(['free-line']);
    expect(snapshot(app, ['one', 'mixed-line']).map((o) => o.id)).toEqual(expect.arrayContaining(['one', 'mixed-line']));
  });

  it('keeps whole-board JSON behavior unchanged', () => {
    const { app } = board();

    const ids = toJson(app, undefined, []).objects.map((o) => o.id);

    expect(ids).toContain('frame');
    expect(ids).toContain('private');
    expect(ids).toContain('layer-hidden');
  });
});
