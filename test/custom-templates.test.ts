import { describe, expect, it } from 'vitest';
import type { BaseObj, ConnectorObj, Obj, Step } from '../src/types';
import { isBox, isConnector } from '../src/types';
import {
  MAX_TEMPLATE_BYTES, MAX_TEMPLATE_OBJECTS, instantiate, remapObjects, toTemplateContent, validateContent,
  type TemplateContent,
} from '../src/custom-templates';

const box = (id: string, x: number, y: number, extra: Partial<BaseObj> = {}): BaseObj => ({
  id, type: 'sticky', x, y, w: 100, h: 80, rotation: 0, z: `z${id}`, text: id, ...extra,
});
const conn = (id: string, from: ConnectorObj['from'], to: ConnectorObj['to'], extra: Partial<ConnectorObj> = {}): ConnectorObj => ({
  id, type: 'connector', z: `z${id}`, from, to, route: 'straight', startHead: 'none', endHead: 'arrow', ...extra,
});
const step = (id: string, extra: Partial<Step> = {}): Step => ({ id, title: id, instructions: '', mode: 'write', ...extra });

const byId = (objs: Obj[]) => new Map(objs.map((o) => [o.id, o]));

// A frame with two children, a connector between the children, a connector to a
// shape outside the selection, and a free-floating connector.
function fixture() {
  const objs: Obj[] = [
    box('f', 300, 200, { type: 'frame', name: 'Frame', w: 600, h: 400 }),
    box('a', 340, 260, { parent: 'f', createdBy: 'u1', updatedAt: 5, locked: true, privateStep: 'st9' }),
    box('b', 600, 400, { parent: 'f', rotation: 0 }),
    conn('c1', { kind: 'bound', id: 'a', anchor: 'right' }, { kind: 'bound', id: 'b', anchor: 'auto' }, { createdBy: 'u1', updatedAt: 6 }),
    conn('c2', { kind: 'bound', id: 'b', anchor: 'auto' }, { kind: 'bound', id: 'out', anchor: 'left' }),
    conn('c3', { kind: 'free', x: 350, y: 650 }, { kind: 'free', x: 500, y: 700 }),
  ];
  const outside = box('out', 1000, 300, { w: 60, h: 60 });
  const steps = [
    step('s1', { frameId: 'f', mode: 'cluster', durationSec: 120 }),
    step('s2'),
    step('s3', { frameId: 'elsewhere' }),
  ];
  return { objs, outside, steps };
}

describe('remapObjects', () => {
  const none = () => null;

  it('gives new ids, offsets boxes and remaps parents and bound ends', () => {
    const { objs } = fixture();
    const map = new Map(objs.map((o) => [o.id, `n-${o.id}`]));
    const out = byId(remapObjects(objs, map, { x: 10, y: -5 }, none));
    expect([...out.keys()]).toEqual(['n-f', 'n-a', 'n-b', 'n-c1', 'n-c2', 'n-c3']);
    const a = out.get('n-a') as BaseObj;
    expect([a.x, a.y, a.parent]).toEqual([350, 255, 'n-f']);
    const c1 = out.get('n-c1') as ConnectorObj;
    expect(c1.from).toEqual({ kind: 'bound', id: 'n-a', anchor: 'right' });
    expect(c1.to).toEqual({ kind: 'bound', id: 'n-b', anchor: 'auto' });
    const c3 = out.get('n-c3') as ConnectorObj;
    expect(c3.from).toEqual({ kind: 'free', x: 360, y: 645 });
  });

  it('turns an end bound outside the list into a free end at the resolved point, or the origin', () => {
    const { objs } = fixture();
    const map = new Map(objs.map((o) => [o.id, `n-${o.id}`]));
    const seen: string[] = [];
    const at = byId(remapObjects(objs, map, { x: 10, y: 20 }, (id) => (seen.push(id), { x: 1030, y: 330 })));
    expect(seen).toEqual(['out']);
    expect((at.get('n-c2') as ConnectorObj).to).toEqual({ kind: 'free', x: 1040, y: 350 });
    const lost = byId(remapObjects(objs, map, { x: 10, y: 20 }, none));
    expect((lost.get('n-c2') as ConnectorObj).to).toEqual({ kind: 'free', x: 10, y: 20 });
  });

  it('drops a parent that is not in the id map and removes privateStep', () => {
    const lone = box('a', 0, 0, { parent: 'gone', privateStep: 's' });
    const [out] = remapObjects([lone], new Map([['a', 'x']]), { x: 0, y: 0 }, none) as BaseObj[];
    expect(out.parent).toBeUndefined();
    expect(out.privateStep).toBeUndefined();
  });

  it('leaves z and createdBy to the caller and does not touch its input', () => {
    const { objs } = fixture();
    const before = structuredClone(objs);
    const map = new Map(objs.map((o) => [o.id, `n-${o.id}`]));
    const out = remapObjects(objs, map, { x: 40, y: 40 }, none);
    expect(objs).toEqual(before);
    expect(out.map((o) => o.z)).toEqual(objs.map((o) => o.z));
    expect(out.map((o) => o.createdBy)).toEqual(objs.map((o) => o.createdBy));
  });
});

describe('toTemplateContent', () => {
  const lookup = (outside: Obj) => (id: string) => (id === outside.id ? outside : undefined);

  it('moves the bounds to the origin and keeps relative geometry', () => {
    const { objs, outside, steps } = fixture();
    const c = toTemplateContent(objs, steps, { includeSteps: true }, lookup(outside));
    expect(c.bounds).toEqual({ x: 0, y: 0, w: 730, h: 500 });
    const out = byId(c.objects);
    const f = out.get('o1') as BaseObj;
    const a = out.get('o2') as BaseObj;
    const b = out.get('o3') as BaseObj;
    expect([f.x, f.y, f.w, f.h]).toEqual([0, 0, 600, 400]);
    expect([a.x - f.x, a.y - f.y]).toEqual([40, 60]);
    expect([b.x - f.x, b.y - f.y]).toEqual([300, 200]);
    expect((out.get('o6') as ConnectorObj).from).toEqual({ kind: 'free', x: 50, y: 450 });
    expect((out.get('o6') as ConnectorObj).to).toEqual({ kind: 'free', x: 200, y: 500 });
  });

  it('re-keys ids and keeps parent links and connector bindings', () => {
    const { objs, outside, steps } = fixture();
    const c = toTemplateContent(objs, steps, { includeSteps: true }, lookup(outside));
    expect(c.objects.map((o) => o.id)).toEqual(['o1', 'o2', 'o3', 'o4', 'o5', 'o6']);
    expect((c.objects[1] as BaseObj).parent).toBe('o1');
    expect((c.objects[2] as BaseObj).parent).toBe('o1');
    const c1 = c.objects[3] as ConnectorObj;
    expect(c1.from).toEqual({ kind: 'bound', id: 'o2', anchor: 'right' });
    expect(c1.to).toEqual({ kind: 'bound', id: 'o3', anchor: 'auto' });
  });

  it('turns a connector end that points outside the set into a free end at the target centre', () => {
    const { objs, outside, steps } = fixture();
    const c = toTemplateContent(objs, steps, { includeSteps: true }, lookup(outside));
    const c2 = c.objects[4] as ConnectorObj;
    expect(c2.from).toMatchObject({ kind: 'bound', id: 'o3' });
    // outside centre (1030, 330) minus the selection origin (300, 200)
    expect(c2.to).toEqual({ kind: 'free', x: 730, y: 130 });
  });

  it('counts the free end left by an outside target when working out the bounds', () => {
    const { objs } = fixture();
    const corner = box('out', 0, 0, { w: 60, h: 60 });
    const c = toTemplateContent(objs, [], { includeSteps: false }, lookup(corner));
    expect(c.bounds).toEqual({ x: 0, y: 0, w: 870, h: 670 });
    expect(c.objects[0]).toMatchObject({ x: 270, y: 170 });
    expect((c.objects[4] as ConnectorObj).to).toEqual({ kind: 'free', x: 0, y: 0 });
  });

  it('falls back to the board origin for an outside end it cannot find', () => {
    const objs = [box('a', -20, -20), conn('c', { kind: 'bound', id: 'a', anchor: 'auto' }, { kind: 'bound', id: 'gone', anchor: 'auto' })];
    const c = toTemplateContent(objs, [], { includeSteps: false });
    expect(c.bounds).toEqual({ x: 0, y: 0, w: 100, h: 80 });
    expect((c.objects[1] as ConnectorObj).to).toEqual({ kind: 'free', x: 20, y: 20 });
  });

  it('drops private and session fields and leaves no undefined keys', () => {
    const { objs, outside, steps } = fixture();
    const c = toTemplateContent(objs, steps, { includeSteps: true }, lookup(outside));
    for (const o of c.objects) {
      expect(o.createdBy).toBeUndefined();
      expect(o.updatedAt).toBeUndefined();
      expect(o.locked).toBeUndefined();
      expect('privateStep' in o).toBe(false);
    }
    expect('parent' in c.objects[0]).toBe(false);
    expect(JSON.parse(JSON.stringify(c))).toEqual(c);
    expect(Object.values(c.objects[1]).every((v) => v !== undefined)).toBe(true);
  });

  it('renumbers z as zero-padded strings in the order given', () => {
    const objs: Obj[] = Array.from({ length: 12 }, (_, i) => box(`n${i}`, i * 10, 0, { z: i % 2 ? 'a5' : 'Zz' }));
    const c = toTemplateContent(objs, [], { includeSteps: false });
    const zs = c.objects.map((o) => o.z);
    expect(zs).toEqual(['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']);
    expect([...zs].sort()).toEqual(zs);
  });

  it('keeps steps tied to a saved frame, and frameless ones only when asked', () => {
    const { objs, outside, steps } = fixture();
    const without = toTemplateContent(objs, steps, { includeSteps: false }, lookup(outside));
    expect(without.steps).toEqual([{ id: 's1', title: 's1', instructions: '', mode: 'cluster', frameId: 'o1', durationSec: 120 }]);
    const withAll = toTemplateContent(objs, steps, { includeSteps: true }, lookup(outside));
    expect(withAll.steps.map((s) => [s.id, s.frameId])).toEqual([['s1', 'o1'], ['s2', undefined]]);
    expect('frameId' in withAll.steps[1]).toBe(false);
  });

  it('limits steps to the frames in frameIds when given', () => {
    const { objs, steps } = fixture();
    const c = toTemplateContent(objs, steps, { includeSteps: false, frameIds: new Set(['a']) });
    expect(c.steps).toEqual([]);
  });

  it('does not save poll or one-click steps', () => {
    const { objs } = fixture();
    const steps = [step('p', { mode: 'poll', pollId: 'poll1' }), step('q', { mode: 'vote', quick: true }), step('w')];
    const c = toTemplateContent(objs, steps, { includeSteps: true });
    expect(c.steps.map((s) => s.title)).toEqual(['w']);
  });

  it('records the fonts only when given, and does not touch its input', () => {
    const { objs, steps } = fixture();
    const before = structuredClone({ objs, steps });
    expect('fonts' in toTemplateContent(objs, steps, { includeSteps: true })).toBe(false);
    const c = toTemplateContent(objs, steps, { includeSteps: true, fonts: { heading: 'h', body: 'b' } });
    expect(c.fonts).toEqual({ heading: 'h', body: 'b' });
    expect({ objs, steps }).toEqual(before);
  });

  it('handles an empty selection', () => {
    expect(toTemplateContent([], [], { includeSteps: true })).toEqual({ objects: [], steps: [], bounds: { x: 0, y: 0, w: 0, h: 0 } });
  });
});

describe('instantiate', () => {
  const content = (): TemplateContent => {
    const { objs, outside, steps } = fixture();
    return toTemplateContent(objs, steps, { includeSteps: true }, (id) => (id === outside.id ? outside : undefined));
  };

  it('places the content at the origin with fresh ids and the creator set', () => {
    const c = content();
    const { objects } = instantiate(c, { x: 1000, y: 500 }, 'me');
    expect(objects).toHaveLength(c.objects.length);
    expect(objects.every((o) => o.createdBy === 'me')).toBe(true);
    const f = objects[0] as BaseObj;
    expect([f.x, f.y]).toEqual([1000, 500]);
    const a = objects[1] as BaseObj;
    expect([a.x, a.y, a.parent]).toEqual([1040, 560, f.id]);
    const c1 = objects[3] as ConnectorObj;
    expect(c1.from).toMatchObject({ kind: 'bound', id: a.id });
    expect(c1.to).toMatchObject({ kind: 'bound', id: objects[2].id });
    expect((objects[5] as ConnectorObj).from).toEqual({ kind: 'free', x: 1050, y: 950 });
  });

  it('gives different ids on every call and never reuses the local ones', () => {
    const c = content();
    const one = instantiate(c, { x: 0, y: 0 }, 'me');
    const two = instantiate(c, { x: 0, y: 0 }, 'me');
    const ids = [...one.objects, ...two.objects, ...one.steps, ...two.steps].map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some((id) => /^[os]\d+$/.test(id))).toBe(false);
  });

  it('links each step to the new frame and leaves the content untouched', () => {
    const c = content();
    const before = structuredClone(c);
    const { objects, steps } = instantiate(c, { x: 5, y: 5 }, 'me');
    expect(c).toEqual(before);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ title: 's1', mode: 'cluster', durationSec: 120, frameId: objects[0].id });
    expect('frameId' in steps[1]).toBe(false);
  });

  it('keeps the z order of the content for the caller to replace', () => {
    const c = content();
    expect(instantiate(c, { x: 0, y: 0 }, 'me').objects.map((o) => o.z)).toEqual(c.objects.map((o) => o.z));
  });

  it('round-trips geometry, parents, bindings and step frames', () => {
    const { objs, steps } = fixture();
    const inside = toTemplateContent(objs.slice(0, 4), steps, { includeSteps: false });
    const { objects, steps: out } = instantiate(inside, { x: 300, y: 200 }, 'u1');
    expect(objects).toHaveLength(4);
    const src = objs.slice(0, 4);
    const geometry = (list: Obj[]) => list.map((o) => (isBox(o) ? [o.type, o.x, o.y, o.w, o.h] : [o.type]));
    const parents = (list: Obj[]) => list.map((o) => (isBox(o) && o.parent ? list.findIndex((p) => p.id === o.parent) : -1));
    expect(geometry(objects)).toEqual(geometry(src));
    expect(parents(objects)).toEqual(parents(src));
    const c1 = objects[3];
    expect(isConnector(c1) && [c1.from, c1.to]).toEqual([
      { kind: 'bound', id: objects[1].id, anchor: 'right' },
      { kind: 'bound', id: objects[2].id, anchor: 'auto' },
    ]);
    expect(out.map((s) => s.frameId)).toEqual([objects[0].id]);
  });
});

describe('validateContent', () => {
  const good = (): TemplateContent => ({
    objects: [
      box('o1', 0, 0, { type: 'frame', name: 'F', z: '1' }),
      box('o2', 10, 10, { parent: 'o1', z: '2' }),
      conn('o3', { kind: 'bound', id: 'o2', anchor: 'auto' }, { kind: 'free', x: 5, y: 5 }, { z: '3' }),
    ],
    steps: [step('s1', { frameId: 'o1' })],
    bounds: { x: 0, y: 0, w: 110, h: 90 },
    fonts: { heading: 'a', body: 'b' },
  });
  const run = (c: unknown) => () => validateContent(c);

  it('accepts what toTemplateContent produces', () => {
    const { objs, outside, steps } = fixture();
    const c = toTemplateContent(objs, steps, { includeSteps: true, fonts: { heading: 'h', body: 'b' } }, (id) => (id === outside.id ? outside : undefined));
    expect(validateContent(JSON.parse(JSON.stringify(c)))).toEqual(c);
    expect(validateContent(good())).toEqual(good());
  });

  it('rejects content that is not an object', () => {
    for (const bad of [null, undefined, 'x', 3, [], [good()]]) expect(run(bad)).toThrow(/must be an object/);
  });

  it('rejects objects that are not an array', () => {
    expect(run({ ...good(), objects: {} })).toThrow(/list of objects/);
    expect(run({ ...good(), objects: undefined })).toThrow(/list of objects/);
  });

  it('rejects more than the object limit', () => {
    const many = Array.from({ length: MAX_TEMPLATE_OBJECTS + 1 }, (_, i) => box(`n${i}`, 0, 0));
    expect(run({ ...good(), objects: many })).toThrow(/at most 2000 objects/);
    const atLimit = Array.from({ length: MAX_TEMPLATE_OBJECTS }, (_, i) => box(`n${i}`, 0, 0));
    expect(validateContent({ ...good(), objects: atLimit, steps: [] }).objects).toHaveLength(MAX_TEMPLATE_OBJECTS);
  });

  it('rejects more than 1 MB of JSON', () => {
    const big = box('o1', 0, 0, { text: 'x'.repeat(MAX_TEMPLATE_BYTES) });
    expect(run({ ...good(), objects: [big], steps: [] })).toThrow(/at most 1 MB/);
  });

  it('counts bytes, not characters', () => {
    const big = box('o1', 0, 0, { text: 'é'.repeat(MAX_TEMPLATE_BYTES / 2) });
    expect(run({ ...good(), objects: [big], steps: [] })).toThrow(/at most 1 MB/);
  });

  it('rejects duplicate ids', () => {
    const c = good();
    c.objects.push(box('o2', 0, 0));
    expect(run(c)).toThrow(/share the id "o2"/);
  });

  it('rejects an unknown type', () => {
    const c = good();
    (c.objects[1] as { type: string }).type = 'widget';
    expect(run(c)).toThrow(/unknown type/);
    (c.objects[1] as { type: string }).type = 'constructor';
    expect(run(c)).toThrow(/unknown type/);
    (c.objects[1] as { type: string }).type = 'tracker';
    expect(run(c)).toThrow(/Templates cannot contain tracker frames/);
  });

  it('rejects a parent that is not in the template', () => {
    const c = good();
    (c.objects[1] as BaseObj).parent = 'nope';
    expect(run(c)).toThrow(/parent that is not in the template/);
  });

  it('rejects a connector end that points at a missing object', () => {
    const c = good();
    (c.objects[2] as ConnectorObj).to = { kind: 'bound', id: 'nope', anchor: 'auto' };
    expect(run(c)).toThrow(/attached to a missing object/);
  });

  it('rejects a step that points at a missing frame', () => {
    const c = good();
    c.steps[0].frameId = 'nope';
    expect(run(c)).toThrow(/frame that is not in the template/);
  });

  it('rejects a malformed connector end, steps, bounds and fonts', () => {
    const c = good();
    (c.objects[2] as unknown as { from: unknown }).from = { kind: 'free', x: 'a' };
    expect(run(c)).toThrow(/without a position/);
    expect(run({ ...good(), steps: undefined })).toThrow(/list of steps/);
    expect(run({ ...good(), steps: [step('s1', { mode: 'poll', pollId: 'p' })] })).toThrow(/poll/);
    expect(run({ ...good(), steps: [{ ...step('s1'), mode: 'dance' }] })).toThrow(/unknown mode/);
    expect(run({ ...good(), bounds: undefined })).toThrow(/bounds/);
    expect(run({ ...good(), fonts: { heading: 1 } })).toThrow(/fonts/);
    const nan = good();
    (nan.objects[1] as BaseObj).w = NaN;
    expect(run(nan)).toThrow(/invalid position or size/);
  });

  it('re-sanitises icon bodies without touching the input', () => {
    const c = good();
    const icon = box('o4', 0, 0, { type: 'icon', body: '<path d="M0 0"/><script>alert(1)</script><g onclick="x()"/>', viewBox: [0, 0, 24, 24], z: '4' });
    c.objects.push(icon);
    const out = validateContent(c);
    const body = (out.objects[3] as BaseObj).body!;
    expect(body).toContain('<path d="M0 0"/>');
    expect(body).not.toMatch(/script|onclick/);
    expect(icon.body).toContain('<script>');
  });
});
