import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Store } from '../src/store';
import { objectMarkup, placeholderZoom } from '../src/markup';
import { FAILED_LABEL } from '../src/image-loader';
import { THEMES } from '../src/themes';
import { fontCss, measure } from '../src/text';
import { imagesLeftOut, toTemplateContent, validateContent } from '../src/custom-templates';
import type { BaseObj, Obj } from '../src/types';

// docs/images.md, Object model, Rendering and Templates.

const HASH = 'ab'.repeat(32);
const image = (extra: Partial<BaseObj> = {}): BaseObj => ({ id: 'img', type: 'image', x: 10, y: 20, w: 200, h: 100, rotation: 0, z: 'a0', asset: HASH, mime: 'image/png', nw: 400, nh: 200, ...extra });
const ctx = (state?: Parameters<NonNullable<Parameters<typeof objectMarkup>[1]['imageState']>>[0] extends BaseObj ? ReturnType<NonNullable<Parameters<typeof objectMarkup>[1]['imageState']>> : never) => ({
  get: () => undefined as Obj | undefined,
  ...(state ? { imageState: () => state } : {}),
});

describe('the image object', () => {
  it('goes through the store with its fields', () => {
    const store = new Store(new Y.Doc());
    store.transact(() => store.create(image({ alt: 'a cat' })));
    expect(store.get('img')).toMatchObject({ type: 'image', asset: HASH, mime: 'image/png', nw: 400, nh: 200, alt: 'a cat' });
    store.transact(() => store.update('img', { asset: 'cd'.repeat(32) }));
    expect((store.get('img') as BaseObj).asset).toBe('cd'.repeat(32));
  });
});

describe('image markup', () => {
  it('draws the pixels through <image>, never as markup, at the object size', () => {
    const svg = objectMarkup(image(), ctx({ kind: 'ok', url: 'blob:http://x/1' }));
    expect(svg).toContain('<image href="blob:http://x/1"');
    expect(svg).toContain('width="200" height="100"');
    expect(svg).toContain('preserveAspectRatio="none"');
    expect(svg).toContain('translate(10 20)');
  });

  it('escapes the URL and the alt text', () => {
    const svg = objectMarkup(image({ alt: '</title><script>alert(1)</script>' }), ctx({ kind: 'ok', url: 'blob:"><script>' }));
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;/title&gt;');
  });

  it('draws a placeholder that says why, with the pixel size', () => {
    const loading = objectMarkup(image(), ctx({ kind: 'loading' }));
    expect(loading).toContain('Loading');
    expect(loading).toContain('400 × 200');
    expect(loading).not.toContain('<image');
    expect(objectMarkup(image(), ctx({ kind: 'failed', why: 'not_uploaded' }))).toContain('Image not uploaded yet');
    expect(objectMarkup(image(), ctx({ kind: 'failed', why: 'denied' }))).toContain('No access to this image');
  });

  it('fits the lost-image label inside a 417 by 100 frame', () => {
    for (const width of [417, 80]) {
      const svg = objectMarkup(image({ w: width, h: 100 }), ctx({ kind: 'failed', why: 'lost' }));
      const lines = [...svg.matchAll(/<text\b[^>]*font-size="([^"]+)"[^>]*>(.*?)<\/text>/g)].map((match) => ({
        text: match[2], size: Number(match[1]),
      }));

      expect(lines.map((line) => line.text).join(' ')).toBe(`${FAILED_LABEL.lost} 400 × 200`);
      for (const line of lines) expect(measure(line.text, fontCss('satoshi', line.size, 600))).toBeLessThanOrEqual(width - 16);
    }
  });

  it('fits the hosted size label inside a 417 by 100 frame', () => {
    const svg = objectMarkup(image({ w: 417, h: 100 }), ctx({ kind: 'failed', why: 'toobig' }));
    const lines = [...svg.matchAll(/<text\b[^>]*font-size="([^"]+)"[^>]*>(.*?)<\/text>/g)].map((match) => ({
      text: match[2], size: Number(match[1]),
    }));
    expect(lines.map((line) => line.text).join(' ')).toBe(`${FAILED_LABEL.toobig} 400 × 200`);
    for (const line of lines) expect(measure(line.text, fontCss('satoshi', line.size, 600))).toBeLessThanOrEqual(401);
  });

  /** WCAG contrast of two sRGB colours given as #RRGGBB. */
  const luminance = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const mix = (a: string, b: string, share: number) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * share + parseInt(b.slice(i, i + 2), 16) * (1 - share)).toString(16).padStart(2, '0')).join('');
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  it('reads at 4.5:1 or better on its own fill in every theme, using the theme colours', () => {
    const svg = objectMarkup(image(), ctx({ kind: 'failed', why: 'toobig' }));
    // the label is the theme's ink at 85% over its paper; the box is its graphite at 12% over the paper
    expect(svg).toContain('fill:color-mix(in srgb, var(--ink, #18212B) 85%, var(--paper, #FFFFFF))');
    expect(svg).toContain('color-mix(in srgb, var(--graphite, #5B6672) 12%, var(--paper, #FFFFFF))');
    for (const theme of THEMES) {
      const { '--ink': ink, '--paper': paper, '--graphite': graphite } = theme.vars as Record<string, string>;
      const fill = mix(graphite, paper, 0.12);
      const text = mix(ink, paper, 0.85);
      expect([theme.id, contrast(text, fill) >= 4.5]).toEqual([theme.id, true]);
    }
  });

  it('never draws the label smaller than 12 px on screen, and grows it with the box', () => {
    const size = (svg: string) => Number(/<text\b[^>]*font-size="([^"]+)"/.exec(svg)![1]);
    const failed = { kind: 'failed', why: 'lost' } as const;
    for (const zoom of [0.25, 0.5, 1, 2]) {
      expect(size(objectMarkup(image({ w: 417, h: 100 }), { ...ctx(failed), zoom })) * zoom).toBeGreaterThanOrEqual(11.99);
    }
    expect(size(objectMarkup(image({ w: 704, h: 473 }), { ...ctx(failed), zoom: 1 }))).toBeGreaterThan(size(objectMarkup(image({ w: 417, h: 100 }), { ...ctx(failed), zoom: 1 })));
    expect(objectMarkup(image(), ctx(failed))).toContain('font-weight:600');
  });

  it('draws the label for a zoom step at or below the real zoom, so it is never under 12 px on screen', () => {
    for (const zoom of [0.11, 0.3, 0.55, 0.7, 0.99, 1, 1.3, 2.9, 4]) {
      const step = placeholderZoom(zoom);
      expect(step).toBeLessThanOrEqual(zoom + 1e-9);
      expect(step).toBeGreaterThan(zoom / 1.42);
    }
    expect(placeholderZoom(0)).toBe(1);
    expect(placeholderZoom(NaN)).toBe(1);
  });

  it('puts an image-off glyph above the label of a failed image, and not on a loading one', () => {
    expect(objectMarkup(image({ w: 417, h: 100 }), ctx({ kind: 'failed', why: 'toobig' }))).toContain('class="img-off"');
    expect(objectMarkup(image({ w: 704, h: 473 }), ctx({ kind: 'failed', why: 'lost' }))).toContain('class="img-off"');
    expect(objectMarkup(image(), ctx({ kind: 'loading' }))).not.toContain('img-off');
    // a wide, short box puts the glyph beside the words; one too small for both drops the glyph and keeps the words
    const wide = objectMarkup(image({ w: 417, h: 58 }), ctx({ kind: 'failed', why: 'toobig' }));
    expect(wide).toContain('img-off');
    expect(wide).toContain('400 × 200');
    const small = objectMarkup(image({ w: 120, h: 40 }), ctx({ kind: 'failed', why: 'toobig' }));
    expect(small).not.toContain('img-off');
  });

  it('draws the placeholder without a loader, as an export does', () => {
    expect(objectMarkup(image(), ctx())).toContain('Loading');
  });

  it('leaves out the text of a placeholder too small to hold it', () => {
    expect(objectMarkup(image({ w: 40, h: 30 }), ctx({ kind: 'loading' }))).not.toContain('<text');
  });

  it('uses theme colours for the placeholder, with fallbacks', () => {
    const svg = objectMarkup(image(), ctx({ kind: 'loading' }));
    expect(svg).toContain('var(--graphite');
    expect(svg).toContain('var(--rule');
  });
});

describe('templates and images', () => {
  const sticky: BaseObj = { id: 's', type: 'sticky', x: 0, y: 0, w: 160, h: 160, rotation: 0, z: 'a1', text: 'hi' };

  it('leaves images out of a saved template and counts them', () => {
    const objs: Obj[] = [sticky, image(), image({ id: 'img2' })];
    expect(imagesLeftOut(objs)).toBe(2);
    const content = toTemplateContent(objs, [], { includeSteps: false });
    expect(content.objects.map((o) => o.type)).toEqual(['sticky']);
  });

  it('refuses an image in template content, as the server does', () => {
    const content = toTemplateContent([sticky], [], { includeSteps: false });
    expect(() => validateContent(content)).not.toThrow();
    const bad = { ...content, objects: [...content.objects, { ...image(), id: 'o9', z: '9' }] };
    expect(() => validateContent(bad)).toThrow(/unknown type/);
  });
});
