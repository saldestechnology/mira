import { describe, expect, it } from 'vitest';
import {
  HOSTED_UPLOAD_LIMIT_BYTES, HOSTED_UPLOAD_TARGET_BYTES, LARGE_PNG_BYTES, MAX_FILE_BYTES, MAX_STORED_SIDE, assetUrl, detectKind, imageFields, isHash, isPending, layoutBounds, layoutRow,
  looksLikeSvg, pickEncoding, placedSize, planEncoding, pngHasAlpha, refusalMessage, scaleDown, shrinkLadder, svgSize,
} from '../src/images';
import { makeGif, makeJpeg, makePng, makeWebp } from './image-fixtures';

// docs/images.md: what a file is, what happens to it before it is uploaded, where it goes on the board.

const utf8 = (s: string) => new TextEncoder().encode(s);

describe('detectKind', () => {
  it('knows the four raster types by their bytes and SVG by its start', () => {
    expect(detectKind(makePng())).toBe('image/png');
    expect(detectKind(makeJpeg())).toBe('image/jpeg');
    expect(detectKind(makeGif())).toBe('image/gif');
    expect(detectKind(makeWebp())).toBe('image/webp');
    expect(detectKind(utf8('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'))).toBe('image/svg+xml');
    expect(detectKind(utf8('﻿  <?xml version="1.0"?>\n<!-- made by hand -->\n<svg viewBox="0 0 1 1"/>'))).toBe('image/svg+xml');
  });

  it('knows nothing else, whatever the name or declared type', () => {
    expect(detectKind(utf8('<html><svg></svg></html>'))).toBeNull();
    expect(detectKind(utf8('%PDF-1.7 and some more text to be long enough'))).toBeNull();
    expect(detectKind(utf8('plain text'))).toBeNull();
    expect(detectKind(new Uint8Array())).toBeNull();
    expect(looksLikeSvg(utf8('<svgfoo></svgfoo>'))).toBe(false);
  });
});

describe('refusalMessage', () => {
  it('names the file and says why in one sentence', () => {
    expect(refusalMessage({ name: 'photo.heic', reason: 'unsupported' })).toBe("photo.heic can't be added: only PNG, JPEG, GIF, WebP and SVG are supported.");
    expect(refusalMessage({ name: 'big.png', reason: 'too_large' })).toContain('larger than 10 MB');
    expect(refusalMessage({ name: 'x.png', reason: 'too_many_pixels' })).toContain('too many pixels');
    expect(refusalMessage({ name: 'a.gif', reason: 'gif_too_big' })).toContain('animated GIF');
    expect(refusalMessage({ name: 'a.png', reason: 'empty' })).toContain('empty');
    expect(refusalMessage({ name: 'a.png', reason: 'unreadable' })).toContain('could not be read');
  });

  it('shortens a long name', () => {
    const msg = refusalMessage({ name: `${'n'.repeat(100)}.png`, reason: 'unsupported' });
    expect(msg.startsWith(`${'n'.repeat(57)}...`)).toBe(true);
  });
});

describe('scaleDown and planEncoding', () => {
  it('scales the longest side down to 2560 and never up', () => {
    expect(scaleDown(5120, 2560)).toEqual({ width: 2560, height: 1280, scaled: true });
    expect(scaleDown(3000, 4000)).toEqual({ width: 1920, height: 2560, scaled: true });
    expect(scaleDown(800, 600)).toEqual({ width: 800, height: 600, scaled: false });
    expect(scaleDown(2560, 100)).toEqual({ width: 2560, height: 100, scaled: false });
    expect(scaleDown(100000, 1)).toEqual({ width: 2560, height: 1, scaled: true });
  });

  it('re-encodes JPEG and WebP as themselves', () => {
    expect(planEncoding({ type: 'image/jpeg', width: 4000, height: 3000, bytes: 3e6, hasAlpha: false }))
      .toEqual({ width: 2560, height: 1920, scaled: true, candidates: [{ type: 'image/jpeg', quality: 0.85 }] });
    expect(planEncoding({ type: 'image/webp', width: 100, height: 100, bytes: 1000, hasAlpha: true }).candidates).toEqual([{ type: 'image/webp', quality: 0.85 }]);
  });

  it('keeps a PNG a PNG, and also tries JPEG for a large opaque one only', () => {
    const base = { type: 'image/png' as const, width: 800, height: 600 };
    expect(planEncoding({ ...base, bytes: 1000, hasAlpha: false }).candidates).toEqual([{ type: 'image/png' }]);
    expect(planEncoding({ ...base, bytes: LARGE_PNG_BYTES, hasAlpha: true }).candidates).toEqual([{ type: 'image/png' }]);
    expect(planEncoding({ ...base, bytes: LARGE_PNG_BYTES, hasAlpha: false }).candidates).toEqual([{ type: 'image/png' }, { type: 'image/jpeg', quality: 0.85 }]);
  });

  it('passes a GIF through untouched', () => {
    expect(planEncoding({ type: 'image/gif', width: 300, height: 200, bytes: 5000, hasAlpha: true })).toEqual({ width: 300, height: 200, scaled: false, candidates: [] });
  });
});

describe('pickEncoding', () => {
  const png = { type: 'image/png' as const, bytes: 1_000_000, scaled: false };

  it('takes JPEG for a PNG only when it is at least 3 times smaller', () => {
    expect(pickEncoding(png, [{ type: 'image/png', size: 900_000 }, { type: 'image/jpeg', size: 300_000 }])).toBe('image/jpeg');
    expect(pickEncoding(png, [{ type: 'image/png', size: 900_000 }, { type: 'image/jpeg', size: 400_000 }])).toBe('image/png');
  });

  it('keeps the original when the re-encode is not smaller, unless the image was scaled', () => {
    expect(pickEncoding({ type: 'image/jpeg', bytes: 500, scaled: false }, [{ type: 'image/jpeg', size: 800 }])).toBe('original');
    expect(pickEncoding({ type: 'image/jpeg', bytes: 500, scaled: true }, [{ type: 'image/jpeg', size: 800 }])).toBe('image/jpeg');
    expect(pickEncoding({ type: 'image/jpeg', bytes: 500, scaled: false }, [{ type: 'image/jpeg', size: 400 }])).toBe('image/jpeg');
  });

  it('falls back to the original when nothing encoded', () => {
    expect(pickEncoding(png, [])).toBe('original');
  });
});

describe('shrinkLadder', () => {
  it('lowers JPEG and WebP quality before stepping the longest side down to 640 px', () => {
    for (const type of ['image/jpeg', 'image/webp'] as const) {
      const steps = shrinkLadder({ type, hasAlpha: false, width: 1200, height: 600, bytes: 950_000, target: 900_000 });
      expect(steps.slice(0, 4)).toEqual([0.8, 0.7, 0.6, 0.5].map((quality) => ({ type, width: 1200, height: 600, quality })));
      const sides = [1200, 1020, 867, 737, 640];
      expect([...new Set(steps.map((step) => step.width))]).toEqual(sides);
      for (const width of sides) expect(steps.filter((step) => step.width === width).map((step) => step.quality)).toEqual([0.8, 0.7, 0.6, 0.5]);
      expect(steps.at(-1)).toMatchObject({ type, width: 640, quality: 0.5 });
    }
  });

  it('tries an opaque PNG as JPEG at the planned size, then uses the smaller JPEG ladder', () => {
    const steps = shrinkLadder({ type: 'image/png', hasAlpha: false, width: 1200, height: 600, bytes: 950_000, target: 900_000 });
    expect(steps.slice(0, 3)).toEqual([0.85, 0.75, 0.65].map((quality) => ({ type: 'image/jpeg', width: 1200, height: 600, quality })));
    expect(steps.slice(3, 7)).toEqual([0.8, 0.7, 0.6, 0.5].map((quality) => ({ type: 'image/jpeg', width: 1020, height: 510, quality })));
  });

  it('shrinks a PNG with alpha by size only, and never re-encodes a GIF', () => {
    const alpha = shrinkLadder({ type: 'image/png', hasAlpha: true, width: 1200, height: 600, bytes: 950_000, target: 900_000 });
    expect(alpha).toEqual([
      { type: 'image/png', width: 1020, height: 510 },
      { type: 'image/png', width: 867, height: 434 },
      { type: 'image/png', width: 737, height: 369 },
      { type: 'image/png', width: 640, height: 320 },
    ]);
    expect(shrinkLadder({ type: 'image/gif', hasAlpha: true, width: 1200, height: 600, bytes: 950_000, target: 900_000 })).toEqual([]);
    expect(shrinkLadder({ type: 'image/jpeg', hasAlpha: false, width: 1200, height: 600, bytes: 800_000, target: 900_000 })).toEqual([]);
  });
});

describe('placement', () => {
  const view = { w: 1000, h: 600 };

  it('keeps a small image at its size and scales a big one to 60% of the shorter side', () => {
    expect(placedSize(200, 100, view)).toEqual({ w: 200, h: 100 });
    expect(placedSize(2000, 1000, view)).toEqual({ w: 360, h: 180 });
    expect(placedSize(1000, 2000, view)).toEqual({ w: 180, h: 360 });
  });

  it('never goes above 1200 or below 24', () => {
    expect(placedSize(5000, 5000, { w: 10000, h: 10000 })).toEqual({ w: 1200, h: 1200 });
    expect(placedSize(10, 10, view)).toEqual({ w: 24, h: 24 });
    const thin = placedSize(2000, 4, view);
    expect(Math.min(thin.w, thin.h)).toBeGreaterThanOrEqual(24);
  });

  it('lays images out left to right with a gap and wraps', () => {
    const sizes = [{ w: 100, h: 50 }, { w: 100, h: 80 }, { w: 100, h: 40 }];
    expect(layoutRow(sizes, { x: 0, y: 0 }, 1000)).toEqual([{ x: 0, y: 0 }, { x: 124, y: 0 }, { x: 248, y: 0 }]);
    expect(layoutRow(sizes, { x: 10, y: 20 }, 260)).toEqual([{ x: 10, y: 20 }, { x: 134, y: 20 }, { x: 10, y: 124 }]);
  });

  it('puts a single image wider than the row on its own row', () => {
    expect(layoutRow([{ w: 500, h: 10 }, { w: 500, h: 10 }], { x: 0, y: 0 }, 100)).toEqual([{ x: 0, y: 0 }, { x: 0, y: 34 }]);
    expect(layoutRow([], { x: 0, y: 0 }, 100)).toEqual([]);
  });

  it('measures the block', () => {
    const sizes = [{ w: 100, h: 50 }, { w: 100, h: 80 }];
    expect(layoutBounds(sizes, layoutRow(sizes, { x: 5, y: 5 }, 1000))).toEqual({ x: 5, y: 5, w: 224, h: 80 });
    expect(layoutBounds([], [])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe('references', () => {
  const hash = 'ab'.repeat(32);

  it('tells a hash from a pending key', () => {
    expect(isHash(hash)).toBe(true);
    expect(isHash(hash.toUpperCase())).toBe(false);
    expect(isHash(`${hash}0`)).toBe(false);
    expect(isPending('pending:abc')).toBe(true);
    expect(isPending(hash)).toBe(false);
    expect(isPending(undefined)).toBe(false);
  });

  it('builds the URL of an asset from the board and the hash, encoded', () => {
    expect(assetUrl('board-1', hash)).toBe(`/api/boards/board-1/assets/${hash}`);
    expect(assetUrl('a/b c', hash)).toBe(`/api/boards/a%2Fb%20c/assets/${hash}`);
  });

  it('accepts a good image object and refuses what a hostile document could hold', () => {
    expect(imageFields({ asset: hash, mime: 'image/png', nw: 10, nh: 5, alt: 'a cat' })).toEqual({ asset: hash, mime: 'image/png', nw: 10, nh: 5, alt: 'a cat' });
    expect(imageFields({ asset: 'pending:x', mime: 'image/gif', nw: 1, nh: 1 })).toEqual({ asset: 'pending:x', mime: 'image/gif', nw: 1, nh: 1 });
    expect(imageFields({ asset: '../../etc/passwd', mime: 'image/png', nw: 1, nh: 1 })).toBeNull();
    expect(imageFields({ asset: hash, mime: 'image/svg+xml', nw: 1, nh: 1 })).toBeNull();
    expect(imageFields({ asset: hash, mime: 'text/html', nw: 1, nh: 1 })).toBeNull();
    expect(imageFields({ asset: hash, mime: 'image/png', nw: 0, nh: 1 })).toBeNull();
    expect(imageFields({ asset: hash, mime: 'image/png', nw: Number.NaN, nh: 1 })).toBeNull();
    expect(imageFields({ asset: undefined, mime: 'image/png', nw: 1, nh: 1 })).toBeNull();
  });
});

describe('svgSize', () => {
  it('reads width and height, else the viewBox, else 300 x 150', () => {
    expect(svgSize('<svg width="120" height="80"></svg>')).toEqual({ width: 120, height: 80 });
    expect(svgSize('<svg width="120px" height="80px" viewBox="0 0 1 1"></svg>')).toEqual({ width: 120, height: 80 });
    expect(svgSize('<svg viewBox="0 0 640 480"></svg>')).toEqual({ width: 640, height: 480 });
    expect(svgSize('<svg width="200" viewBox="0 0 100 50"></svg>')).toEqual({ width: 200, height: 100 });
    expect(svgSize('<svg viewBox="-10 -10 40 20" height="10"></svg>')).toEqual({ width: 20, height: 10 });
    expect(svgSize('<svg></svg>')).toEqual({ width: 300, height: 150 });
    expect(svgSize('not svg at all')).toEqual({ width: 300, height: 150 });
  });
});

describe('pngHasAlpha', () => {
  it('is true for an alpha colour type or a transparency chunk before the data', () => {
    expect(pngHasAlpha(makePng())).toBe(true); // the fixtures are RGBA
    const rgb = Buffer.from(makePng());
    rgb[25] = 2;
    expect(pngHasAlpha(rgb)).toBe(false);
    const palette = Buffer.concat([rgb.subarray(0, 33), Buffer.from('....tRNS....IDAT')]);
    palette[25] = 3;
    expect(pngHasAlpha(palette)).toBe(true);
    expect(pngHasAlpha(new Uint8Array(10))).toBe(true);
  });
});

describe('limits', () => {
  it('match the spec', () => {
    expect(MAX_STORED_SIDE).toBe(2560);
    expect(MAX_FILE_BYTES).toBe(10 * 1024 * 1024);
    expect(HOSTED_UPLOAD_TARGET_BYTES).toBe(900_000);
    expect(HOSTED_UPLOAD_LIMIT_BYTES).toBe(1_000_000);
  });
});
