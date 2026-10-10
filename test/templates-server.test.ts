import { migrationSql } from '../server/schema.mjs';
import fs from 'node:fs';
import { CLEAN_SVG, HOSTILE_SVG } from './svg-payloads';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { MAX_TEMPLATE_BYTES, MAX_TEMPLATE_OBJECTS, validateContent } from '../src/custom-templates';
import { builtinToCustom } from '../src/template-file';
import { CATEGORIES, CUSTOM_CATEGORY, TEMPLATES } from '../src/templates';
import { LIMITS, OBJ_TYPES, OpsError, applyPlan, planUseTemplate } from '../server/board-ops.mjs';
import { MIGRATIONS, openDirectory } from '../server/directory.mjs';
import {
  MAX_TEMPLATE_BYTES as SERVER_MAX_BYTES, MAX_TEMPLATE_OBJECTS as SERVER_MAX_OBJECTS, TEMPLATE_CATEGORIES,
  TEMPLATE_OBJ_TYPES, TEMPLATE_RELATIONS, TEMPLATE_STEP_MODES, TemplateInputError, copyName, parseTemplateBody, svgProblem,
  templateAccess, validateTemplateContent,
} from '../server/templates.mjs';

const source = (file: string) => fs.readFileSync(new URL(file, import.meta.url), 'utf8');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A value with the name of the case it belongs to, so a failure in a loop says which one. */
const at = (label: unknown, value: unknown) => ({ label, value });

const sticky = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'sticky', x: 0, y: 0, w: 160, h: 160, rotation: 0, z: '1', text: id, ...extra });
const frame = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'frame', x: 0, y: 0, w: 400, h: 300, rotation: 0, z: '0', name: id, ...extra });
const icon = (body: unknown, extra: Record<string, unknown> = {}) => ({
  id: 'i1', type: 'icon', x: 0, y: 0, w: 64, h: 64, rotation: 0, z: '1', ref: 'x:y', body, viewBox: [0, 0, 24, 24], ...extra,
});
const content = (objects: unknown[], extra: Record<string, unknown> = {}) => ({
  objects, steps: [], bounds: { x: 0, y: 0, w: 400, h: 300 }, ...extra,
});
const problem = (c: unknown): string | null => {
  try {
    validateTemplateContent(c);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
};

describe('constants that mirror the client', () => {
  it('lists the same categories as the app: the built-in ones plus Custom', () => {
    expect([...TEMPLATE_CATEGORIES]).toEqual([...CATEGORIES, CUSTOM_CATEGORY]);
  });

  it('lists the same object types as ObjType', () => {
    const types = source('../src/types.ts');
    const base = /export type ObjType = ([^;]+);/.exec(types)![1];
    const uml = /export type UmlType =([^;]+);/.exec(types)![1];
    const names = [...base.matchAll(/'([^']+)'/g), ...uml.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    // a template never holds an image: its assets belong to the board it came from (docs/images.md, Templates)
    expect([...TEMPLATE_OBJ_TYPES].sort()).toEqual(names.filter((n) => n !== 'image' && n !== 'tracker').sort());
    expect(names).toContain('image');
    expect(OBJ_TYPES).toContain('image');
    expect(names).toContain('tracker');
    expect(OBJ_TYPES).toContain('tracker');
  });

  it('lists the same relations as UmlRelation, and the step modes of StepMode but poll', () => {
    const types = source('../src/types.ts');
    const relations = [...(/export type UmlRelation =([^;]+);/.exec(types)![1]).matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect([...TEMPLATE_RELATIONS].sort()).toEqual(relations.sort());
    const modes = [...(/export type StepMode = ([^;]+);/.exec(types)![1]).matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect([...TEMPLATE_STEP_MODES].sort()).toEqual(modes.filter((m) => m !== 'poll').sort());
  });

  it('has the same size limits as the client', () => {
    expect(SERVER_MAX_BYTES).toBe(MAX_TEMPLATE_BYTES);
    expect(SERVER_MAX_OBJECTS).toBe(MAX_TEMPLATE_OBJECTS);
  });
});

describe('content that is accepted', () => {
  it('preserves boolean flip flags through both template validators and rejects other values', () => {
    const input = content([sticky('flipped', { flipX: true, flipY: false })]);
    expect(validateTemplateContent(input).content.objects[0]).toMatchObject({ flipX: true, flipY: false });
    expect(validateContent(input).objects[0]).toMatchObject({ flipX: true, flipY: false });
    expect(() => validateTemplateContent(content([sticky('bad', { flipX: 'yes' })]))).toThrow(/flipX.*boolean/i);
    expect(() => validateContent(content([sticky('bad', { flipY: 1 })]))).toThrow(/flipY.*boolean/i);
    expect(() => validateContent(content([{ ...sticky('wire'), type: 'connector', flipX: true }]))).toThrow(/connector.*flip flags/i);
  });

  it('keeps every built-in template as it is, and the client accepts what comes out', () => {
    for (const def of TEMPLATES) {
      const made = builtinToCustom(def, 'u1').content;
      const { content: stored, objectCount, stepCount } = validateTemplateContent(made);
      expect(at(def.name, stored)).toEqual(at(def.name, made));
      expect(objectCount).toBe(made.objects.length);
      expect(stepCount).toBe(made.steps.length);
      expect(() => validateContent(stored)).not.toThrow();
    }
  });

  it('rebuilds the content from the accepted fields only', () => {
    const { content: stored } = validateTemplateContent({
      ...content([
        frame('f1', { privateStep: 's1', locked: true, createdBy: 'someone', updatedAt: 5, onclick: 'alert(1)', __proto__: { polluted: true } }),
        sticky('s1', { parent: 'f1', evil: '<script>', kind: 'rect', body: '<script>x</script>', points: [1, 2] }),
        { id: 'c1', type: 'connector', z: '3', from: { kind: 'bound', id: 's1', anchor: 'left', extra: 1 }, to: { kind: 'free', x: 5, y: 6 }, x: 1, parent: 'f1', locked: true },
      ], { fonts: { heading: 'cabinet-grotesk', body: 'satoshi', extra: 1 }, tracking: 'x' }),
      topLevel: true,
    });
    expect(Object.keys(stored).sort()).toEqual(['bounds', 'fonts', 'objects', 'steps']);
    expect(stored.fonts).toEqual({ heading: 'cabinet-grotesk', body: 'satoshi' });
    const [f1, s1, c1] = stored.objects as Record<string, unknown>[];
    expect(Object.keys(f1).sort()).toEqual(['h', 'id', 'name', 'rotation', 'type', 'w', 'x', 'y', 'z']);
    expect(s1).toEqual({ id: 's1', type: 'sticky', x: 0, y: 0, w: 160, h: 160, rotation: 0, z: '1', text: 's1', parent: 'f1' });
    expect(c1).toEqual({
      id: 'c1', type: 'connector', z: '3', from: { kind: 'bound', id: 's1', anchor: 'left' }, to: { kind: 'free', x: 5, y: 6 },
      route: 'elbow', startHead: 'none', endHead: 'arrow',
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses MCP card owners, dates and links before rebuilding a server template', () => {
    const card = {
      id: 'c1', type: 'card', parent: 'l1', rank: 'a0@l1', x: 12, y: 48, w: 264, h: 72, rotation: 0, z: '3', text: 'Token-owned work',
      ownerId: 'token-secret', ownerName: 'Build bot', ownerKind: 'agent', due: '2026-10-10', link: 'https://example.com/private-plan',
    };
    expect(() => validateTemplateContent(content([
      { id: 'k1', type: 'container', layout: 'kanban', name: 'Roadmap', x: 0, y: 0, w: 900, h: 400, rotation: 0, z: '1' },
      { id: 'l1', type: 'lane', parent: 'k1', rank: 'a0@k1', name: 'To do', stage: 'todo', x: 12, y: 48, w: 280, h: 300, rotation: 0, z: '2' },
      card,
    ]))).toThrow(/an owner/);
  });

  it('accepts steps that point at frames, a template with nothing in it and 2,000 objects', () => {
    const steps = [
      { id: 's1', title: 'Write', instructions: 'Add notes', mode: 'private-write', frameId: 'f1', durationSec: 300 },
      { id: 's2', title: 'Vote', instructions: '', mode: 'vote', votesPerPerson: 3 },
    ];
    expect(validateTemplateContent(content([frame('f1')], { steps })).stepCount).toBe(2);
    expect(validateTemplateContent(content([])).objectCount).toBe(0);
    const many = Array.from({ length: SERVER_MAX_OBJECTS }, (_, i) => sticky(`o${i}`));
    expect(validateTemplateContent(content(many)).objectCount).toBe(SERVER_MAX_OBJECTS);
  });

  it('checks group depth without rescanning the full object list for each parent', () => {
    const frames = Array.from({ length: 1500 }, (_, i) => frame(`f${i}`, i ? { parent: `f${i - 1}` } : {}));
    const groupCount = 2;
    const objects: Record<string, unknown>[] = [
      ...frames,
      ...Array.from({ length: groupCount }, (_, i) => ({ id: `g${i}`, type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: '2', parent: 'f1499' })),
    ];
    let idReads = 0;
    // The validator copies inputs with list.map; instrument the copied ids so find, filter, and loops all count.
    const mapObjects = objects.map.bind(objects);
    Object.defineProperty(objects, 'map', {
      value: (callback: (value: Record<string, unknown>, index: number, array: Record<string, unknown>[]) => unknown, thisArg?: unknown) => {
        const mapped = mapObjects(callback, thisArg) as unknown[];
        for (const value of mapped) {
          if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'id')) continue;
          let id = (value as { id: unknown }).id;
          Object.defineProperty(value, 'id', {
            configurable: true,
            enumerable: true,
            get() {
              idReads++;
              return id;
            },
            set(next: unknown) {
              id = next;
            },
          });
        }
        return mapped;
      },
    });

    expect(validateTemplateContent(content(objects)).objectCount).toBe(frames.length + groupCount);
    expect(idReads).toBeGreaterThan(objects.length);
    // A scan for each parent step in this 1,500-frame chain reads millions of ids. Count reads, not one array method.
    expect(idReads).toBeLessThanOrEqual(objects.length * 5);
  });

  it('accepts the colours the board writes', () => {
    for (const fill of ['#FFE16B', '#fff', '#11223344', 'none', 'transparent', 'var(--canvas-ink, #18212B)']) {
      expect(at(fill, problem(content([sticky('s1', { fill, textColor: fill, stroke: fill })])))).toEqual(at(fill, null));
    }
  });

  // TAB-203: one colour grammar (shared/colors.mjs). The board never writes these, and the renderer would draw them as
  // the default, so a template that holds them is refused rather than stored.
  it('refuses colours outside the board grammar', () => {
    for (const fill of ['rgb(1, 2, 3)', 'color-mix(in srgb, red 50%, blue)', 'red', 'var(--x)', 'var(--x, red)']) {
      expect(at(fill, problem(content([sticky('s1', { fill })])))).toEqual(at(fill, expect.stringContaining('fill is not a colour')));
    }
  });
});

describe('content that is refused', () => {
  it('needs the right shape', () => {
    for (const bad of [null, [], 'x', 5]) expect(problem(bad)).toMatch('content must be an object');
    expect(problem({ steps: [], bounds: {} })).toMatch('content.objects');
    expect(problem({ objects: [], bounds: {} })).toMatch('content.steps');
    expect(problem({ objects: [], steps: [] })).toMatch('content.bounds');
    expect(problem(content([], { bounds: { x: 0, y: 0, w: 'big', h: 1 } }))).toMatch('bounds width');
    expect(problem(content([], { fonts: { heading: 'x' } }))).toMatch('content.fonts');
    expect(problem(content([], { fonts: { heading: '<b>', body: 'x' } }))).toMatch('content.fonts');
  });

  it('caps the number of objects and steps, and the size', () => {
    expect(problem(content(Array.from({ length: SERVER_MAX_OBJECTS + 1 }, (_, i) => sticky(`o${i}`))))).toMatch('2000 objects');
    expect(problem(content([], { steps: Array.from({ length: 101 }, (_, i) => ({ id: `s${i}`, title: 't', instructions: '', mode: 'write' })) }))).toMatch('at most 100 steps');
    const heavy = Array.from({ length: 100 }, (_, i) => sticky(`o${i}`, { text: 'x'.repeat(15_000) }));
    expect(problem(content(heavy))).toMatch('1 MB');
  });

  it('needs unique ids and known types', () => {
    expect(problem(content([sticky('a'), sticky('a')]))).toMatch('shares its id');
    expect(problem(content([sticky('')]))).toMatch('needs an id');
    expect(problem(content([sticky('x'.repeat(65))]))).toMatch('needs an id');
    expect(problem(content([sticky('a b')]))).toMatch('needs an id');
    expect(problem(content([{ ...sticky('a'), id: 5 }]))).toMatch('needs an id');
    expect(problem(content([sticky('a', { type: 'script' })]))).toMatch('unknown type');
    expect(problem(content([sticky('a', { type: undefined })]))).toMatch('unknown type');
    expect(problem(content([sticky('a', { type: '__proto__' })]))).toMatch('unknown type');
    expect(problem(content([{
      id: 'tracker', type: 'tracker', x: 0, y: 0, w: 1280, h: 800, rotation: 0, z: '1', trackerId: 'workspace', view: 'inbox',
    }]))).toMatch('Templates cannot contain tracker frames');
    expect(problem(content(['text']))).toMatch('not an object');
  });

  it('needs finite numbers', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, '5', null, 1e12]) {
      expect(problem(content([sticky('a', { x: value })]))).toMatch('x must be a number');
    }
    expect(problem(content([sticky('a', { w: -1 })]))).toMatch('width must be a number');
    expect(problem(content([sticky('a', { y: undefined })]))).toMatch('y must be a number');
    expect(problem(content([sticky('a', { opacity: 2 })]))).toMatch('opacity');
    expect(problem(content([sticky('a', { fontSize: Number.NaN })]))).toMatch('fontSize');
    expect(problem(content([icon('<path d="M0 0"/>', { viewBox: [0, 0, Number.NaN, 24] })]))).toMatch('viewBox');
    expect(problem(content([{ id: 'p', type: 'path', x: 0, y: 0, w: 1, h: 1, z: '1', points: [1, 2, 3] }]))).toMatch('points');
    expect(problem(content([{ id: 'c', type: 'connector', z: '1', from: { kind: 'free', x: Number.NaN, y: 0 }, to: { kind: 'free', x: 0, y: 0 } }]))).toMatch('from end x');
  });

  it('needs every reference to resolve inside the template', () => {
    expect(problem(content([sticky('a', { parent: 'nope' })]))).toMatch('parent that is not a frame');
    expect(problem(content([sticky('a'), sticky('b', { parent: 'a' })]))).toMatch('parent that is not a frame');
    expect(problem(content([frame('f', { parent: 'f' })]))).toMatch('in a loop');
    expect(problem(content([frame('f', { parent: 'g' }), frame('g', { parent: 'f' })]))).toMatch('in a loop');
    const c = (from: unknown, to: unknown) => content([sticky('a'), { id: 'c', type: 'connector', z: '2', from, to }]);
    expect(problem(c({ kind: 'bound', id: 'nope' }, { kind: 'free', x: 0, y: 0 }))).toMatch('not in the template');
    expect(problem(c({ kind: 'free', x: 0, y: 0 }, { kind: 'bound', id: 'c' }))).toMatch('another connector');
    expect(problem(c({ kind: 'free', x: 0, y: 0 }, { kind: 'sideways' }))).toMatch('invalid to end');
    expect(problem(c({ kind: 'free', x: 0, y: 0 }, null))).toMatch('no to end');
    expect(problem(c({ kind: 'bound', id: 'a', anchor: 'middle' }, { kind: 'free', x: 0, y: 0 }))).toMatch('anchor');
    const step = (frameId: unknown) => content([sticky('a'), frame('f')], { steps: [{ id: 's', title: 't', instructions: '', mode: 'write', frameId }] });
    expect(problem(step('nope'))).toMatch('frame that is not in the template');
    expect(problem(step(7))).toMatch('frame that is not in the template');
    expect(() => validateTemplateContent(step('f'))).not.toThrow();
  });

  it('refuses steps a template cannot hold', () => {
    const step = (extra: Record<string, unknown>) => content([], { steps: [{ id: 's', title: 't', instructions: '', mode: 'write', ...extra }] });
    expect(problem(step({ mode: 'poll' }))).toMatch('poll');
    expect(problem(step({ pollId: 'p1' }))).toMatch('poll');
    expect(problem(step({ quick: true }))).toMatch('quick');
    expect(problem(step({ mode: 'party' }))).toMatch('mode');
    expect(problem(step({ title: 5 }))).toMatch('title');
    expect(problem(step({ id: 'a b' }))).toMatch('id');
    expect(problem(content([], { steps: [{ id: 's', title: 't', instructions: '', mode: 'write' }, { id: 's', title: 't', instructions: '', mode: 'write' }] }))).toMatch('share an id');
    expect(problem(step({ durationSec: -1 }))).toMatch('durationSec');
  });

  it('refuses values the board could not draw safely', () => {
    for (const fill of ['url(https://evil.example/x.svg#a)', 'URL (#a)', 'red; background: url(x)', 'x'.repeat(101), '<b>', '"', 5, '', 'javascript:alert(1)', 'image-set(x)', 'image(//evil.example/a.png)', 'cross-fade(red, blue)', 'element(#a)', 'paint(x)']) {
      expect(problem(content([sticky('a', { fill })]))).toMatch('fill is not a colour');
    }
    expect(problem(content([sticky('a', { textColor: 'url(#x)' })]))).toMatch('textColor');
    expect(problem(content([sticky('a', { stroke: 'url(#x)' })]))).toMatch('stroke');
    expect(problem(content([sticky('a', { font: '"><script>' })]))).toMatch('font');
    expect(problem(content([sticky('a', { align: 'justify' })]))).toMatch('align');
    expect(problem(content([sticky('a', { text: 'a\u0000b' })]))).toMatch('text');
    expect(problem(content([sticky('a', { text: 'x'.repeat(20_001) })]))).toMatch('text');
    expect(problem(content([{ id: 's', type: 'shape', x: 0, y: 0, w: 1, h: 1, z: '1', kind: 'blob' }]))).toMatch('kind');
    expect(problem(content([{ id: 'c', type: 'connector', z: '1', from: { kind: 'free', x: 0, y: 0 }, to: { kind: 'free', x: 0, y: 0 }, route: 'zigzag' }]))).toMatch('route');
    expect(problem(content([{ id: 'c', type: 'connector', z: '1', from: { kind: 'free', x: 0, y: 0 }, to: { kind: 'free', x: 0, y: 0 }, relation: 'friends' }]))).toMatch('relation');
    expect(problem(content([{ id: 'u', type: 'uml-class', x: 0, y: 0, w: 1, h: 1, z: '1', attributes: [{ name: 5 }] }]))).toMatch('attribute 1 name');
    expect(problem(content([{ id: 'u', type: 'uml-class', x: 0, y: 0, w: 1, h: 1, z: '1', operations: 'x' }]))).toMatch('operation');
  });

  it('refuses unsafe SVG in an icon or a sticker, naming the object and the reason', () => {
    expect(problem(content([sticky('a'), icon('<script>alert(1)</script>', { id: 'i2' })]))).toMatch(/Object 2 has an SVG body that is not allowed: it uses <script>/);
    expect(problem(content([icon('<path d="M0 0" onload="x()"/>', { sticker: true })]))).toMatch(/event handler/);
    expect(problem(content([icon(5)]))).toMatch('not allowed');
    expect(problem(content([icon('<path d="M0 0"/>'.repeat(10_000))]))).toMatch('longer than');
  });

  it('keeps `body` for icons alone', () => {
    const { content: stored } = validateTemplateContent(content([sticky('a', { body: '<script>x</script>' }), icon('<path d="M0 0"/>')]));
    expect(stored.objects[0]).not.toHaveProperty('body');
    expect(stored.objects[1]).toHaveProperty('body', '<path d="M0 0"/>');
  });
});

describe('SVG bodies', () => {
  const clean = CLEAN_SVG;
  it.each(clean.map((b) => [b]))('accepts plain drawing: %s', (body) => {
    expect(svgProblem(body)).toBeNull();
  });

  const hostile = HOSTILE_SVG;
  it.each(hostile)('refuses %s', (_name, body) => {
    expect(svgProblem(body)).toEqual(expect.any(String));
  });

  it('does not take long to refuse a body built to make a regular expression struggle', () => {
    const started = Date.now();
    for (const body of ['<g ' + 'a '.repeat(20_000), '<g ' + 'a="b" '.repeat(10_000) + '<', `<g ${'a'.repeat(50_000)}`, '<'.repeat(50_000), `<g a="${'x'.repeat(90_000)}`]) {
      expect(svgProblem(body)).toEqual(expect.any(String));
    }
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('the fields around the content', () => {
  const body = (extra: Record<string, unknown> = {}) => ({ name: 'Retro', category: 'Retrospective', content: content([sticky('a')]), ...extra });
  const refused = (b: Record<string, unknown>, message: RegExp | string, create = true) => expect(() => parseTemplateBody(b, { create })).toThrow(message);

  it('fills in the defaults on a create and trims text', () => {
    const parsed = parseTemplateBody(body({ name: '  Retro  ', description: ' Why ' }), { create: true });
    expect(parsed).toMatchObject({ name: 'Retro', category: 'Retrospective', description: 'Why', scope: 'personal' });
    expect(parsed.validated.objectCount).toBe(1);
    expect(parseTemplateBody(body(), { create: true }).description).toBe('');
    expect(parseTemplateBody(body({ scope: 'workspace', teamId: null }), { create: true }).scope).toBe('workspace');
  });

  it('knows its limits', () => {
    refused(body({ name: '' }), 'name');
    refused(body({ name: '   ' }), 'name');
    refused(body({ name: 'x'.repeat(81) }), 'name');
    refused(body({ name: 'a\nb' }), 'name');
    refused(body({ name: 5 }), 'name');
    refused(body({ description: 'x'.repeat(281) }), 'description');
    refused(body({ description: 5 }), 'description');
    refused(body({ category: 'Whatever' }), 'category');
    refused(body({ category: undefined }), 'category');
    refused(body({ scope: 'planet' }), 'scope');
    refused(body({ scope: 'team' }), 'teamId is required');
    refused(body({ scope: 'team', teamId: '' }), 'teamId');
    refused(body({ scope: 'personal', teamId: 't1' }), 'only applies');
    refused(body({ scope: 'workspace', teamId: 't1' }), 'only applies');
    refused(body({ content: undefined }), 'content must be an object');
    refused(body({ owner: 'me' }), 'Unknown field: owner');
    refused(body({ ['x'.repeat(100)]: 1 }), /Unknown field: x{40}$/);
    expect(parseTemplateBody(body({ description: 'two\nlines' }), { create: true }).description).toBe('two\nlines');
  });

  it('accepts every fixed category, nothing else', () => {
    for (const category of TEMPLATE_CATEGORIES) expect(parseTemplateBody(body({ category }), { create: true }).category).toBe(category);
    refused(body({ category: 'retrospective' }), 'category');
  });

  it('takes any of the fields on an update, and nothing at all is a refusal', () => {
    expect(parseTemplateBody({ name: 'New' }, { create: false })).toEqual({ name: 'New' });
    expect(parseTemplateBody({ scope: 'team', teamId: 't1' }, { create: false })).toEqual({ scope: 'team', teamId: 't1' });
    expect(Object.keys(parseTemplateBody({ content: content([]) }, { create: false }))).toEqual(['validated']);
    refused({}, 'Nothing to change', false);
    refused({ name: '' }, 'name', false);
    refused({ scope: 'team' }, 'teamId is required', false);
  });

  it('reports a content problem as a TemplateInputError', () => {
    expect(() => parseTemplateBody(body({ content: { objects: 1 } }), { create: true })).toThrow(TemplateInputError);
  });

  it('names a copy so that it stays within the name limit', () => {
    expect(copyName('Retro')).toBe('Retro (copy)');
    expect(copyName('x'.repeat(80))).toHaveLength(80);
    expect(copyName('x'.repeat(80)).endsWith(' (copy)')).toBe(true);
  });
});

// ---------------------------------------------------------------- the directory

let n = 0;
const person = (d: ReturnType<typeof openDirectory>, role: 'owner' | 'admin' | 'member' | 'guest' = 'member') =>
  d.createUser({ email: `person${++n}@example.com`, role })!;
const stored = (extra: Record<string, unknown> = {}) => validateTemplateContent(content([sticky('a')], extra));
const make = (d: ReturnType<typeof openDirectory>, ownerId: string | null, scope: 'personal' | 'team' | 'workspace', teamId: string | null = null, name = `T${++n}`) =>
  d.createTemplate({ ownerId, scope, teamId, name, category: 'Custom', description: '', validated: stored() });

describe('templates in the directory', () => {
  it('adds the table to a directory that already has the earlier ones, and keeps what was there', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'templates-test-'));
    dirs.push(dir);
    const file = path.join(dir, 'directory.sqlite');
    const old = new DatabaseSync(file);
    for (const migration of MIGRATIONS.slice(0, 5)) old.exec(migrationSql(migration));
    old.exec('PRAGMA user_version = 5');
    old.prepare("INSERT INTO users (id, email, name, role, disabled, created_at) VALUES ('u1', 'a@example.com', 'Ana', 'member', 0, 1)").run();
    old.close();
    const d = openDirectory(file);
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(6);
    expect(d.getUser('u1')?.email).toBe('a@example.com');
    const id = make(d, 'u1', 'personal');
    expect(d.listTemplatesFor({ id: 'u1', role: 'member' }).map((t: { id: string }) => t.id)).toEqual([id]);
    d.close();
    const raw = new DatabaseSync(file);
    expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
    raw.close();
  });

  it('stores the checked content with its counts, and lists metadata without it', () => {
    const d = openDirectory(':memory:');
    const u = person(d);
    const validated = validateTemplateContent(content([sticky('a'), sticky('b')], { steps: [{ id: 's', title: 't', instructions: '', mode: 'write' }] }));
    const id = d.createTemplate({ ownerId: u.id, scope: 'personal', name: 'Mine', category: 'Risk', description: 'About', validated });
    const [listed] = d.listTemplatesFor(u);
    expect(listed).toMatchObject({
      id, name: 'Mine', category: 'Risk', description: 'About', scope: 'personal', teamId: null, ownerId: u.id, ownerName: u.name,
      objectCount: 2, stepCount: 1, canChange: true,
    });
    expect(listed).not.toHaveProperty('content');
    expect(JSON.parse(d.getTemplateContent(id))).toEqual(validated.content);
    expect(d.getTemplateFor(u, id)).toEqual(listed);
    d.close();
  });

  it('refuses a team template without a team and a personal one with one', () => {
    const d = openDirectory(':memory:');
    const u = person(d);
    const team = d.createTeam({ name: 'Design', creatorId: u.id })!;
    const raw = (scope: string, teamId: string | null) => () =>
      (d as unknown as { createTemplate: (a: unknown) => void }).createTemplate({ ownerId: u.id, scope, teamId, name: 'x', category: 'Custom', validated: stored() });
    expect(raw('team', null)).toThrow('constraint');
    expect(() => d.createTemplate({ ownerId: u.id, scope: 'planet', teamId: null, name: 'x', category: 'Custom', validated: stored() })).toThrow('constraint');
    // a personal template ignores a team id rather than keeping it
    const id = raw('personal', team.id);
    expect(id).not.toThrow();
    expect(d.listTemplatesFor(u)[0].teamId).toBeNull();
    d.close();
  });

  describe('who can see and change what', () => {
    const world = () => {
      const d = openDirectory(':memory:');
      const owner = person(d, 'owner');
      const admin = person(d, 'admin');
      const lead = person(d); // admin of team A
      const alice = person(d); // member of team A, owns the templates
      const bob = person(d); // member of team A
      const carol = person(d); // member of team B only
      const gus = person(d, 'guest'); // guest in team A
      const outsider = person(d);
      const a = d.createTeam({ name: 'A', creatorId: lead.id })!;
      const b = d.createTeam({ name: 'B', creatorId: carol.id })!;
      d.addTeamMember(a.id, alice.id, 'member');
      d.addTeamMember(a.id, bob.id, 'member');
      d.addTeamMember(a.id, gus.id, 'member');
      const mine = make(d, alice.id, 'personal');
      const inA = make(d, alice.id, 'team', a.id);
      const inB = make(d, carol.id, 'team', b.id);
      const everyone = make(d, admin.id, 'workspace');
      return { d, owner, admin, lead, alice, bob, carol, gus, outsider, a, b, mine, inA, inB, everyone };
    };
    const sees = (w: ReturnType<typeof world>, user: { id: string; role: string }) => w.d.listTemplatesFor(user).map((t: { id: string }) => t.id).sort();
    const can = (w: ReturnType<typeof world>, user: { id: string; role: string }, id: string) => w.d.getTemplateFor(user, id)?.canChange;

    it('lists a personal template to its owner alone', () => {
      const w = world();
      expect(sees(w, w.alice)).toEqual([w.mine, w.inA, w.everyone].sort());
      for (const other of [w.bob, w.carol, w.lead, w.outsider, w.gus, w.owner, w.admin]) expect(sees(w, other)).not.toContain(w.mine);
      expect(w.d.getTemplateFor(w.bob, w.mine)).toBeNull();
      expect(w.d.getTemplateFor(w.admin, w.mine)).toBeNull();
      w.d.close();
    });

    it('lists a team template to the team, its guests and workspace owners and admins', () => {
      const w = world();
      for (const member of [w.alice, w.bob, w.lead, w.gus, w.owner, w.admin]) expect(at(member.id, sees(w, member).includes(w.inA))).toEqual(at(member.id, true));
      for (const other of [w.carol, w.outsider]) expect(sees(w, other)).not.toContain(w.inA);
      expect(sees(w, w.carol)).toContain(w.inB);
      expect(w.d.getTemplateFor(w.outsider, w.inA)).toBeNull();
      w.d.close();
    });

    it('lists a workspace template to everyone but guests', () => {
      const w = world();
      for (const member of [w.alice, w.bob, w.lead, w.carol, w.outsider, w.owner, w.admin]) expect(sees(w, member)).toContain(w.everyone);
      expect(sees(w, w.gus)).toEqual([w.inA]);
      expect(w.d.getTemplateFor(w.gus, w.everyone)).toBeNull();
      w.d.close();
    });

    it('lets the owner, a team admin and workspace owners and admins change a team template, and nobody else', () => {
      const w = world();
      expect(can(w, w.alice, w.inA)).toBe(true);
      expect(can(w, w.lead, w.inA)).toBe(true);
      expect(can(w, w.owner, w.inA)).toBe(true);
      expect(can(w, w.admin, w.inA)).toBe(true);
      expect(can(w, w.bob, w.inA)).toBe(false);
      expect(can(w, w.gus, w.inA)).toBe(false);
      w.d.close();
    });

    it('lets only workspace owners and admins change a workspace template, its author as a member included', () => {
      const w = world();
      expect(can(w, w.admin, w.everyone)).toBe(true);
      expect(can(w, w.owner, w.everyone)).toBe(true);
      for (const other of [w.alice, w.lead, w.carol]) expect(can(w, other, w.everyone)).toBe(false);
      w.d.updateUser(w.admin.id, { role: 'member' });
      expect(can(w, { ...w.admin, role: 'member' }, w.everyone)).toBe(false);
      w.d.close();
    });

    it('stops the owner from changing a team template after they leave the team, and keeps it with the team', () => {
      const w = world();
      w.d.removeTeamMember(w.a.id, w.alice.id);
      expect(w.d.getTemplateFor(w.alice, w.inA)).toBeNull();
      expect(w.d.getTemplateFor(w.bob, w.inA)).toMatchObject({ name: expect.any(String), ownerId: w.alice.id, canChange: false });
      expect(can(w, w.lead, w.inA)).toBe(true);
      w.d.close();
    });

    it('hides a deleted template everywhere and counts only the live ones', () => {
      const w = world();
      expect(w.d.countTemplatesOwnedBy(w.alice.id)).toBe(2);
      expect(w.d.deleteTemplate(w.inA)).toBe(true);
      expect(w.d.deleteTemplate(w.inA)).toBe(false);
      for (const user of [w.alice, w.bob, w.lead, w.owner, w.admin]) {
        expect(sees(w, user)).not.toContain(w.inA);
        expect(w.d.getTemplateFor(user, w.inA)).toBeNull();
      }
      expect(w.d.getTemplateContent(w.inA)).toBeNull();
      expect(w.d.updateTemplate(w.inA, { name: 'Back' })).toBe(false);
      expect(w.d.countTemplatesOwnedBy(w.alice.id)).toBe(1);
      w.d.close();
    });

    it('moves a template between scopes and teams, and clears the team when it leaves', () => {
      const w = world();
      expect(w.d.updateTemplate(w.mine, { scope: 'team', teamId: w.a.id })).toBe(true);
      expect(w.d.getTemplateFor(w.bob, w.mine)).toMatchObject({ scope: 'team', teamId: w.a.id, teamName: 'A' });
      expect(w.d.updateTemplate(w.mine, { scope: 'workspace' })).toBe(true);
      expect(w.d.getTemplateFor(w.carol, w.mine)).toMatchObject({ scope: 'workspace', teamId: null, teamName: null });
      expect(w.d.updateTemplate(w.mine, { name: 'Renamed', category: 'Risk', description: 'd', validated: stored() })).toBe(true);
      expect(w.d.getTemplateFor(w.alice, w.mine)).toMatchObject({ name: 'Renamed', category: 'Risk', description: 'd', scope: 'workspace' });
      w.d.close();
    });

    it('keeps team and workspace templates, ownerless, when their owner is removed, and shows the personal ones to admins only', () => {
      const w = world();
      const gone = make(w.d, w.alice.id, 'personal', null, 'Gone');
      expect(() => w.d.removeUser(w.alice.id)).not.toThrow();
      expect(w.d.getTemplateFor(w.bob, w.inA)).toMatchObject({ ownerId: null, ownerName: null, canChange: false });
      expect(w.d.getTemplateFor(w.lead, w.inA)).toMatchObject({ canChange: true });
      expect(w.d.getTemplateFor(w.bob, gone)).toBeNull();
      expect(w.d.getTemplateFor(w.lead, gone)).toBeNull();
      expect(w.d.getTemplateFor(w.admin, gone)).toMatchObject({ ownerId: null, scope: 'personal', canChange: true });
      expect(w.d.getTemplateFor(w.owner, w.mine)).toMatchObject({ canChange: true });
      w.d.close();
    });

    it('answers access questions the same way as the queries', () => {
      const row = { owner_id: 'u1', scope: 'team' };
      expect(templateAccess(row, { id: 'u1', role: 'member' }, 'member')).toEqual({ read: true, change: true });
      expect(templateAccess(row, { id: 'u1', role: 'member' }, null)).toEqual({ read: false, change: false });
      expect(templateAccess(row, { id: 'u2', role: 'member' }, 'admin')).toEqual({ read: true, change: true });
      expect(templateAccess(row, { id: 'u2', role: 'member' }, 'member')).toEqual({ read: true, change: false });
      expect(templateAccess({ owner_id: 'u1', scope: 'bogus' }, { id: 'u2', role: 'admin' }, 'admin')).toEqual({ read: false, change: false });
    });
  });
});

describe('placing a template on a board', () => {
  const tpl = validateTemplateContent(content([frame('f'), sticky('s', { parent: 'f' })])).content;

  it('plans new ids, a shifted position and z keys above the board, and applies as one change', () => {
    const doc = new Y.Doc();
    const objects = doc.getMap('objects');
    objects.set('old', new Y.Map(Object.entries({ id: 'old', type: 'sticky', x: 10, y: 20, w: 100, h: 50, z: 'a0' })));
    const plan = planUseTemplate(doc, tpl, { createdBy: 'u1', now: 5 });
    expect(plan.result).toMatchObject({ created: 2, origin: { x: 190, y: 20 }, objectCount: 3, stepsSkipped: 0 });
    applyPlan(doc, plan);
    const made = [...objects].filter(([id]) => id !== 'old').map(([id, m]) => ({ ...(m as Y.Map<unknown>).toJSON(), id })) as Record<string, any>[];
    expect(made).toHaveLength(2);
    expect(made.every((o) => o.id !== 'f' && o.id !== 's' && o.createdBy === 'u1' && o.updatedAt === 5 && o.z > 'a0')).toBe(true);
    const frameOf = made.find((o) => o.type === 'frame')!;
    expect(made.find((o) => o.type === 'sticky')).toMatchObject({ parent: frameOf.id, x: 190, y: 20 });
  });

  it('refuses a board that would hold too many objects, and plans nothing', () => {
    const doc = new Y.Doc();
    const objects = doc.getMap('objects');
    for (let i = 0; i < LIMITS.boardObjects - 1; i++) objects.set(`o${i}`, new Y.Map(Object.entries({ id: `o${i}`, type: 'sticky', x: 0, y: 0, w: 1, h: 1, z: 'a' })));
    expect(() => planUseTemplate(doc, tpl, { createdBy: 'u1' })).toThrow(OpsError);
    expect(objects.size).toBe(LIMITS.boardObjects - 1);
  });
});
