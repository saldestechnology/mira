import { afterEach, describe, expect, it, vi } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import * as Y from 'yjs';
import { Store } from '../src/store';
import type { BoardApp } from '../src/app';
import { addCard, newKanban } from '../src/containers';
import { installFakeBrowser, type FakeBrowser } from './fake-dom';

type FetchResponder = (url: string) => Promise<Response>;

let browser: FakeBrowser | undefined;
let release: (() => void) | undefined;

afterEach(() => {
  release?.();
  release = undefined;
  browser?.uninstall();
  browser = undefined;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.restoreAllMocks();
});

async function setup(respond: FetchResponder) {
  browser = installFakeBrowser();
  const head = browser.document.createElement('head');
  browser.document.documentElement.insertBefore(head, browser.document.body);
  Object.assign(browser.document, { head });
  Object.assign(browser.location, { href: 'https://demo.test/demo/', origin: 'https://demo.test', pathname: '/demo/' });
  vi.stubEnv('VITE_DEMO', '1');
  vi.stubEnv('BASE_URL', '/demo/');
  const nativeFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>((input) => respond(String(input)));
  vi.stubGlobal('fetch', nativeFetch);

  const demo = await import('../src/demo');
  release = demo.installDemoGuards();
  const exporters = await import('../src/exporters');
  return { demo, exporters, nativeFetch };
}

function appWithFonts(fonts: { slug: string; weight: number }[]): BoardApp {
  const store = new Store(new Y.Doc());
  fonts.forEach(({ slug, weight }, index) => store.create({
    id: `font-${index}`, type: 'text', x: index * 320, y: 0, w: 300, h: 48, rotation: 0, z: String(index),
    createdBy: 'visitor', font: slug, fontWeight: weight, text: 'Offline export', fontSize: 18,
  }));
  return {
    store,
    r: { contentBounds: () => ({ x: 0, y: 0, w: 640, h: 100 }), ctx: { get: (id: string) => store.getPlaced(id) } },
  } as unknown as BoardApp;
}

function appWithNestedGroup(): BoardApp {
  const store = new Store(new Y.Doc());
  store.transact(() => {
    store.create({ id: 'frame', type: 'frame', x: 0, y: 0, w: 500, h: 400, rotation: 0, z: 'a0', name: 'Sprint' });
    store.create({ id: 'outer', type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a1', parent: 'frame' });
    store.create({ id: 'inner', type: 'group', x: 0, y: 0, w: 0, h: 0, rotation: 0, z: 'a2', parent: 'outer' });
    store.create({ id: 'member', type: 'sticky', x: 20, y: 30, w: 100, h: 100, rotation: 0, z: 'a1', parent: 'inner', text: 'Nested member' });
    store.create({ id: 'other', type: 'sticky', x: 180, y: 30, w: 100, h: 100, rotation: 0, z: 'a2', parent: 'outer', text: 'Other member', hidden: true });
    store.create({ id: 'internal-line', type: 'connector', z: 'a3', parent: 'outer', from: { kind: 'bound', id: 'member', anchor: 'auto' }, to: { kind: 'bound', id: 'other', anchor: 'auto' }, route: 'straight', startHead: 'none', endHead: 'arrow' });
    store.create({ id: 'outside-line', type: 'connector', z: 'a4', from: { kind: 'bound', id: 'member', anchor: 'auto' }, to: { kind: 'bound', id: 'outside', anchor: 'auto' }, route: 'straight', startHead: 'none', endHead: 'arrow' });
    store.create({ id: 'outside', type: 'sticky', x: 350, y: 30, w: 100, h: 100, rotation: 0, z: 'a5', text: 'Outside' });
  });
  return {
    store,
    conn: { comments: { list: () => [] } },
    flow: { isHidden: () => false, polls: { snapshot: () => ({ polls: [], answers: [] }) } },
    images: { blobOf: async () => null },
    r: {
      contentBounds: () => ({ x: 0, y: 0, w: 500, h: 400 }),
      ctx: { get: (id: string) => store.getPlaced(id), layout: () => new Map() },
    },
  } as unknown as BoardApp;
}

function face(slug: string, family: string, weight: number) {
  const path = `https://cdn.fontshare.com/fonts/${slug}-${weight}.woff2`;
  return `@font-face { font-family: '${family}'; font-style: normal; font-weight: ${weight}; src: url('${path}') format('woff2'); }`;
}

const smallFont = () => new Response(new Uint8Array([0, 1, 2, 255]), { headers: { 'content-type': 'font/woff2' } });

describe('SVG font export', () => {
  it('embeds data-URI faces for used weights and makes no Fontshare import', async () => {
    const css = [face('satoshi', 'Satoshi', 400), face('satoshi', 'Satoshi', 500), face('satoshi', 'Satoshi', 700)].join('\n');
    const { demo, exporters, nativeFetch } = await setup(async (url) => {
      if (url.startsWith('https://api.fontshare.com/')) return new Response(css);
      if (url.startsWith('https://cdn.fontshare.com/')) return smallFont();
      throw new Error(`Unexpected request: ${url}`);
    });

    const svg = await exporters.exportSvgFile(appWithFonts([{ slug: 'satoshi', weight: 400 }]));
    const urls = nativeFetch.mock.calls.map(([input]) => String(input));
    expect(svg).toContain('@font-face');
    expect(svg).toContain('src: url("data:font/woff2;base64,');
    expect(svg).not.toMatch(/@import\s+url\(https:\/\//i);
    expect(urls.filter((url) => url.includes('cdn.fontshare.com'))).toEqual([
      'https://cdn.fontshare.com/fonts/satoshi-400.woff2',
      'https://cdn.fontshare.com/fonts/satoshi-500.woff2',
    ]);
    expect(demo.demoGuardReport()).toEqual({ blocked: 0, attempts: [] });
  });

  it('exports a valid SVG without a font when the font request fails', async () => {
    const { exporters, nativeFetch } = await setup(async (url) => {
      if (url.startsWith('https://api.fontshare.com/')) return new Response(face('satoshi', 'Satoshi', 500));
      throw new Error('offline');
    });

    const svg = await exporters.exportSvgFile(appWithFonts([{ slug: 'satoshi', weight: 500 }]));
    expect(svg).toMatch(/^<svg\b[\s\S]*<\/svg>$/);
    expect(svg).not.toContain('@font-face');
    expect(svg).not.toMatch(/@import\s+url\(https:\/\//i);
    expect(nativeFetch).toHaveBeenCalledTimes(2);
  });

  it('stops embedding at the combined 1.5 MB raw font cap', async () => {
    const css = [face('satoshi', 'Satoshi', 500), face('general-sans', 'General Sans', 500)].join('\n');
    const bytes = new Uint8Array(800_000);
    const { exporters, nativeFetch } = await setup(async (url) => {
      if (url.startsWith('https://api.fontshare.com/')) return new Response(css);
      if (url.startsWith('https://cdn.fontshare.com/')) {
        return new Response(bytes, { headers: { 'content-type': 'font/woff2', 'content-length': String(bytes.byteLength) } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const svg = await exporters.exportSvgFile(appWithFonts([{ slug: 'general-sans', weight: 500 }]));
    expect(svg.match(/data:font\/woff2;base64,/g)).toHaveLength(1);
    expect(svg).not.toMatch(/@import\s+url\(https:\/\//i);
    expect(nativeFetch.mock.calls.map(([input]) => String(input)).filter((url) => url.includes('cdn.fontshare.com'))).toEqual([
      'https://cdn.fontshare.com/fonts/satoshi-500.woff2',
      'https://cdn.fontshare.com/fonts/general-sans-500.woff2',
    ]);
  });

  it('returns without waiting for a font server that never responds', async () => {
    vi.useFakeTimers();
    const { exporters } = await setup(async (url) => {
      if (url.startsWith('https://api.fontshare.com/')) return new Response(face('satoshi', 'Satoshi', 500));
      return new Promise<Response>(() => undefined);
    });

    const result = exporters.exportSvgFile(appWithFonts([{ slug: 'satoshi', weight: 500 }]));
    await vi.advanceTimersByTimeAsync(8001);
    const svg = await result;
    expect(svg).toMatch(/^<svg\b[\s\S]*<\/svg>$/);
    expect(svg).not.toContain('@font-face');
  });
});

describe('PNG card links', () => {
  it('rasterizes the visible link icon and returns no clickable SVG anchor', async () => {
    const css = face('satoshi', 'Satoshi', 500);
    const { exporters } = await setup(async (url) => {
      if (url.startsWith('https://api.fontshare.com/')) return new Response(css);
      if (url.startsWith('https://cdn.fontshare.com/')) return smallFont();
      throw new Error(`Unexpected request: ${url}`);
    });
    const store = new Store(new Y.Doc());
    const { container, lanes } = newKanban({ x: 0, y: 0 }, { z: 'a0', createdBy: 'visitor', bodyFont: 'satoshi', headingFont: 'satoshi' });
    store.transact(() => [container, ...lanes].forEach((o) => store.create(o)));
    const id = addCard(store, lanes[0].id, 'Open design', { createdBy: 'visitor', font: 'satoshi' })!;
    store.transact(() => store.update(id, { link: 'https://example.com/design' }));
    const app = {
      store,
      r: {
        contentBounds: () => ({ x: 0, y: 0, w: 1000, h: 500 }),
        ctx: { get: (objectId: string) => store.getPlaced(objectId), containerLayout: (objectId: string) => store.containerLayout(objectId), label: (labelId: string) => store.labels.get(labelId) },
      },
    } as unknown as BoardApp;

    let sourceBlob: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => { sourceBlob = blob as Blob; return 'blob:kanban-svg'; });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    class ImageStub {
      decoding = '';
      onload?: () => void;
      onerror?: () => void;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', ImageStub);
    const drawImage = vi.fn<CanvasRenderingContext2D['drawImage']>();
    const canvasContext = { drawImage, measureText: (text: string) => ({ width: text.length * 7 }), font: '' };
    const canvas = {
      width: 0, height: 0,
      getContext: () => canvasContext,
      toBlob: (callback: BlobCallback | null, type?: string) => callback?.(new Blob(['raster pixels'], { type })),
    };
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => tag === 'canvas' ? canvas as unknown as HTMLCanvasElement : createElement(tag));

    const png = await exporters.exportPng(app, [container.id], 1);
    expect(png.type).toBe('image/png');
    expect(await png.text()).not.toContain('<a');
    expect(drawImage).toHaveBeenCalledOnce();
    expect(sourceBlob?.type).toBe('image/svg+xml');
    const intermediateSvg = await sourceBlob!.text();
    expect(intermediateSvg).toContain('data-card-link="true"');
    expect(intermediateSvg).toContain('href="https://example.com/design"');
    expect(intermediateSvg).toContain('M10 13.5l4-4M8.5 15.5l-1 1a3 3 0 01-4.2-4.2l3-3a3 3 0 014.2 0');
  });

  it('carries flipped object markup through PNG rasterization', async () => {
    const { exporters } = await setup(async () => { throw new Error('offline'); });
    const store = new Store(new Y.Doc());
    store.create({ id: 'flipped', type: 'shape', kind: 'arrow-right', x: 0, y: 0, w: 80, h: 60, rotation: 0, z: 'a0', flipX: true, text: 'Readable' });
    const app = {
      store,
      r: { contentBounds: () => ({ x: 0, y: 0, w: 80, h: 60 }), ctx: { get: (id: string) => store.getPlaced(id) } },
    } as unknown as BoardApp;
    let sourceSvg: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => { sourceSvg = blob as Blob; return 'blob:flipped-svg'; });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    class ImageStub {
      decoding = '';
      onload?: () => void;
      onerror?: () => void;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', ImageStub);
    const canvasContext = { drawImage: vi.fn<CanvasRenderingContext2D['drawImage']>(), measureText: (text: string) => ({ width: text.length * 7 }), font: '' };
    const canvas = {
      width: 0, height: 0,
      getContext: () => canvasContext,
      toBlob: (callback: BlobCallback | null, type?: string) => callback?.(new Blob(['png pixels'], { type })),
    };
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => tag === 'canvas' ? canvas as unknown as HTMLCanvasElement : createElement(tag));

    const png = await exporters.exportPng(app, ['flipped'], 1);
    expect(png.type).toBe('image/png');
    expect(await sourceSvg?.text()).toContain('transform="translate(40 30) scale(-1 1) translate(-40 -30)"');
    expect(await sourceSvg?.text()).toContain('>Reada</tspan>');
    expect(await sourceSvg?.text()).toContain('>ble</tspan>');
  });
});

describe('group export gathering', () => {
  it('carries visible nested group members through selected exports and preserves the full .drift board', async () => {
    const { exporters } = await setup(async () => { throw new Error('unexpected font request'); });
    const app = appWithNestedGroup();
    const selected = exporters.toJson(app, ['outer'], [], { leaveOutWithheld: false }).objects;
    expect(selected.map((o) => o.id)).toEqual(['outer', 'inner', 'member']);
    expect(selected.map((o) => o.id)).not.toContain('frame');
    expect(selected.find((o) => o.id === 'outer')).not.toHaveProperty('parent');
    expect(selected.map((o) => o.id)).not.toContain('outside-line');
    expect(selected.find((o) => o.id === 'member')?.parent).toBe('inner');

    const svg = exporters.exportSvg(app, ['outer']).svg;
    expect(svg).toContain('Nested');
    expect(svg).not.toContain('Other');
    expect(svg).not.toContain('Outside');

    let sourceSvg: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      if (blob instanceof Blob) sourceSvg = blob;
      return 'blob:group-export';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    class TestImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      decoding = '';
      set src(_value: string) { this.onload?.(); }
    }
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage() {} }),
      toBlob: (done: BlobCallback) => done(new Blob(['png'], { type: 'image/png' })),
    };
    vi.stubGlobal('Image', TestImage);
    vi.stubGlobal('document', { createElement: () => canvas });
    const png = await exporters.exportPng(app, ['outer']);
    expect(png.type).toBe('image/png');
    expect(await sourceSvg?.text()).toContain('Nested');

    const packed = await exporters.toDrift(app, { leaveOutWithheld: true });
    const files = unzipSync(packed);
    const board = JSON.parse(strFromU8(files['board.json'])) as { objects: { id: string; parent?: string }[] };
    expect(board.objects.map((o) => o.id)).toEqual(expect.arrayContaining(['outer', 'inner', 'member', 'other', 'internal-line']));
    expect(board.objects.find((o) => o.id === 'member')?.parent).toBe('inner');
    const doc = new Y.Doc();
    Y.applyUpdate(doc, files['doc.yjs']);
    expect(new Store(doc).childrenOf('inner').map((o) => o.id)).toContain('member');
    doc.destroy();
  });
});
