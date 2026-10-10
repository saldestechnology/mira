// The pure side of images on a board (docs/images.md): what a file is, what to do with it before it is uploaded, where it
// goes on the board and where its bytes are served from. No DOM, no storage; the browser parts are in
// src/ui/image-add.ts, src/asset-store.ts and src/image-loader.ts.
//
// The type and size checks are the server's own functions (server/image-header.mjs), so a file the browser lets through is
// one the relay will read the same way.
import { IMAGE_TYPES, MAX_PIXELS, MAX_SIDE, gifFrames, readImageInfo, sizeOk, sniffType } from '../server/image-header.mjs';
import type { BaseObj, Rect } from './types';

export { IMAGE_TYPES, MAX_PIXELS, MAX_SIDE, gifFrames, readImageInfo, sizeOk, sniffType };

/** Longest side of a stored image. A larger one is scaled down before it is uploaded. */
export const MAX_STORED_SIDE = 2560;
/** The file cap of the server (TABULA_ASSET_MAX_BYTES); the browser stops before it uploads what would be refused. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Hosted workspaces aim below Fly's request replay limit so normal uploads have headroom. */
export const HOSTED_UPLOAD_TARGET_BYTES = 900_000;
/** The request body limit for hosted workspaces behind Fly's replaying edge. */
export const HOSTED_UPLOAD_LIMIT_BYTES = 1_000_000;
/** Files added by one paste, drop or pick. */
export const MAX_FILES_PER_ACTION = 10;
/** Opaque PNGs at least this large are also tried as JPEG. */
export const LARGE_PNG_BYTES = 300 * 1024;

export type StoredType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
export type FileKind = StoredType | 'image/svg+xml';

/** A picture that came with an opened board file: the bytes and what the header says about them. */
export interface ImportedAsset { bytes: Uint8Array; mime: string; width: number; height: number }

export const SUPPORTED_LABEL = 'PNG, JPEG, GIF, WebP and SVG';

export interface Refusal { name: string; reason: 'unsupported' | 'too_large' | 'too_many_pixels' | 'unreadable' | 'gif_too_big' | 'empty' }

/** The message of a refused file: one sentence, the name first, never blocking the other files of the same action. */
export function refusalMessage({ name, reason }: Refusal): string {
  const label = name.length > 60 ? `${name.slice(0, 57)}...` : name;
  switch (reason) {
    case 'unsupported': return `${label} can't be added: only ${SUPPORTED_LABEL} are supported.`;
    case 'too_large': return `${label} can't be added: it is larger than ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB.`;
    case 'too_many_pixels': return `${label} can't be added: it has too many pixels (at most 36 megapixels and ${MAX_SIDE} px on a side).`;
    case 'gif_too_big': return `${label} can't be added: an animated GIF has to be under ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB and ${MAX_STORED_SIDE} px on a side.`;
    case 'empty': return `${label} can't be added: the file is empty.`;
    default: return `${label} can't be added: the file could not be read.`;
  }
}

/** True for the start of an SVG document: an optional byte order mark and whitespace, an XML declaration or comment, then `<svg`. */
export function looksLikeSvg(head: Uint8Array): boolean {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(head.subarray(0, 1024)).replace(/^﻿/, '');
  return /^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(text);
}

/** What a file is, by its bytes and not by its name or declared type (a pasted screenshot has no name). */
export function detectKind(head: Uint8Array): FileKind | null {
  const type = sniffType(head);
  if (type) return type as StoredType;
  return looksLikeSvg(head) ? 'image/svg+xml' : null;
}

export interface Plan {
  /** Size of the re-encoded image, at most MAX_STORED_SIDE on the longest side. */
  width: number;
  height: number;
  scaled: boolean;
  /** Encodings to try, in order. An empty list means the file goes up as it is. */
  candidates: { type: 'image/png' | 'image/jpeg' | 'image/webp'; quality?: number }[];
}

/** The size after scaling the longest side down to `limit`. Never up. Both sides stay at least 1. */
export function scaleDown(width: number, height: number, limit = MAX_STORED_SIDE): { width: number; height: number; scaled: boolean } {
  const longest = Math.max(width, height);
  if (longest <= limit) return { width, height, scaled: false };
  const s = limit / longest;
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)), scaled: true };
}

/**
 * What to do with a decoded raster image before it is uploaded (docs/images.md, Downscaling). The canvas re-encode writes
 * no metadata and applies the EXIF rotation. A GIF is never re-encoded (it would lose its frames).
 */
export function planEncoding(input: { type: StoredType; width: number; height: number; bytes: number; hasAlpha: boolean }): Plan {
  const { width, height, scaled } = scaleDown(input.width, input.height);
  const base = { width, height, scaled };
  if (input.type === 'image/gif') return { ...base, width: input.width, height: input.height, scaled: false, candidates: [] };
  if (input.type === 'image/jpeg') return { ...base, candidates: [{ type: 'image/jpeg', quality: 0.85 }] };
  if (input.type === 'image/webp') return { ...base, candidates: [{ type: 'image/webp', quality: 0.85 }] };
  // PNG: stays PNG; a large opaque one (a photo saved as PNG) is also tried as JPEG
  const candidates: Plan['candidates'] = [{ type: 'image/png' }];
  if (!input.hasAlpha && input.bytes >= LARGE_PNG_BYTES) candidates.push({ type: 'image/jpeg', quality: 0.85 });
  return { ...base, candidates };
}

export interface ShrinkStep {
  type: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
  quality?: number;
}

/**
 * Encodings to try after the normal plan is still over `target`. `bytes` is the normal plan result size; `width` and
 * `height` are its planned dimensions. The caller stops at the first result under target and keeps the smallest result.
 */
export function shrinkLadder(input: { type: StoredType; hasAlpha: boolean; width: number; height: number; bytes: number; target: number }): ShrinkStep[] {
  const { type, hasAlpha, width, height, bytes, target } = input;
  if (bytes <= target || type === 'image/gif') return [];

  const qualities = [0.8, 0.7, 0.6, 0.5];
  const smaller: { width: number; height: number }[] = [];
  let side = Math.max(width, height);
  while (side > 640) {
    side = Math.max(640, Math.round(side * 0.85));
    const next = scaleDown(width, height, side);
    smaller.push({ width: next.width, height: next.height });
  }
  const atSize = (size: { width: number; height: number }, mime: ShrinkStep['type'], qs: number[]) =>
    qs.map((quality) => ({ type: mime, width: size.width, height: size.height, quality }));

  if (type === 'image/jpeg' || type === 'image/webp') {
    return [
      ...atSize({ width, height }, type, qualities),
      ...smaller.flatMap((size) => atSize(size, type, qualities)),
    ];
  }
  if (hasAlpha) return smaller.map((size) => ({ type: 'image/png', width: size.width, height: size.height }));
  return [
    ...atSize({ width, height }, 'image/jpeg', [0.85, 0.75, 0.65]),
    ...smaller.flatMap((size) => atSize(size, 'image/jpeg', qualities)),
  ];
}

/**
 * Which result to upload: `'original'` or one of the tried types. `results` are the sizes of the encodings that worked.
 * A JPEG replaces a PNG only when it is at least 3 times smaller. A result larger than the original is dropped in favour of
 * the original unless the image was scaled (then its pixels are what the person asked for).
 */
export function pickEncoding(input: { type: StoredType; bytes: number; scaled: boolean }, results: { type: string; size: number }[]): 'original' | string {
  const same = results.find((r) => r.type === input.type);
  const jpeg = input.type === 'image/png' ? results.find((r) => r.type === 'image/jpeg') : undefined;
  if (jpeg && same && jpeg.size * 3 <= same.size) return jpeg.type;
  if (jpeg && !same && jpeg.size * 3 <= input.bytes) return jpeg.type;
  if (!same) return 'original';
  if (!input.scaled && same.size >= input.bytes) return 'original';
  return same.type;
}

// ---------------------------------------------------------------- placement

export const MIN_SIDE = 24;
export const MAX_PLACED_SIDE = 1200;
export const ROW_GAP = 24;

/** The size an added image has on the board: its natural size, at most 60% of the view's shorter side and 1200 units, at least 24. */
export function placedSize(nw: number, nh: number, view: { w: number; h: number }): { w: number; h: number } {
  const cap = Math.min(MAX_PLACED_SIDE, 0.6 * Math.min(view.w, view.h));
  const s = Math.min(1, cap / Math.max(nw, nh));
  let w = nw * s;
  let h = nh * s;
  const small = Math.min(w, h);
  if (small < MIN_SIDE) {
    const up = MIN_SIDE / small;
    w *= up;
    h *= up;
  }
  return { w: Math.round(w), h: Math.round(h) };
}

/** Top-left corners for several images laid out left to right from `origin`, wrapping when a row would leave `maxWidth`. */
export function layoutRow(sizes: { w: number; h: number }[], origin: { x: number; y: number }, maxWidth: number, gap = ROW_GAP): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  let x = origin.x;
  let y = origin.y;
  let rowHeight = 0;
  for (const size of sizes) {
    if (x > origin.x && x + size.w > origin.x + maxWidth) {
      x = origin.x;
      y += rowHeight + gap;
      rowHeight = 0;
    }
    out.push({ x, y });
    x += size.w + gap;
    rowHeight = Math.max(rowHeight, size.h);
  }
  return out;
}

/** The block of a row layout as a rectangle, to centre it on the view. */
export function layoutBounds(sizes: { w: number; h: number }[], spots: { x: number; y: number }[]): Rect {
  if (!sizes.length) return { x: 0, y: 0, w: 0, h: 0 };
  const x = Math.min(...spots.map((p) => p.x));
  const y = Math.min(...spots.map((p) => p.y));
  const r = Math.max(...spots.map((p, i) => p.x + sizes[i].w));
  const b = Math.max(...spots.map((p, i) => p.y + sizes[i].h));
  return { x, y, w: r - x, h: b - y };
}

// ---------------------------------------------------------------- references

export const PENDING_PREFIX = 'pending:';
export const HASH_RE = /^[0-9a-f]{64}$/;

export const isPending = (asset: unknown): asset is string => typeof asset === 'string' && asset.startsWith(PENDING_PREFIX);
export const isHash = (asset: unknown): asset is string => typeof asset === 'string' && HASH_RE.test(asset);

/** Where the bytes of an uploaded asset are served from. Same origin, so the session cookie goes along. */
export const assetUrl = (boardId: string, hash: string) => `/api/boards/${encodeURIComponent(boardId)}/assets/${hash}`;

export interface ImageFields {
  asset: string;
  mime: StoredType;
  nw: number;
  nh: number;
  alt?: string;
}

/** The fields of an `image` object, checked as they come out of a document (an older or hostile client may write anything). */
export function imageFields(o: Pick<BaseObj, 'asset' | 'mime' | 'nw' | 'nh' | 'alt'>): ImageFields | null {
  const { asset, mime, nw, nh } = o;
  if (!isHash(asset) && !isPending(asset)) return null;
  if (!IMAGE_TYPES.includes(mime as string)) return null;
  if (typeof nw !== 'number' || typeof nh !== 'number' || !(nw > 0) || !(nh > 0)) return null;
  return { asset, mime: mime as StoredType, nw, nh, ...(typeof o.alt === 'string' ? { alt: o.alt } : {}) };
}

/** True when a PNG can have transparency: an alpha colour type, or a palette or grey image with a transparency chunk. */
export function pngHasAlpha(head: Uint8Array): boolean {
  if (head.length < 26) return true;
  const colorType = head[25];
  if (colorType === 4 || colorType === 6) return true;
  // palette (3), grey (0) and truecolour (2) carry transparency in a tRNS chunk before the image data
  const text = new TextDecoder('latin1').decode(head.subarray(0, Math.min(head.length, 65536)));
  const idat = text.indexOf('IDAT');
  const trns = text.indexOf('tRNS');
  return trns !== -1 && (idat === -1 || trns < idat);
}

/** The pixel size an SVG document says it has: width and height, else its viewBox, else a browser's default of 300 x 150. */
export function svgSize(text: string): { width: number; height: number } {
  const root = /<svg\b[^>]*>/i.exec(text)?.[0] ?? '';
  const num = (name: string) => {
    const m = new RegExp(`\\s${name}\\s*=\\s*["']\\s*([0-9.]+)\\s*(px)?\\s*["']`, 'i').exec(root);
    return m ? Number(m[1]) : NaN;
  };
  const w = num('width');
  const h = num('height');
  if (w > 0 && h > 0) return { width: Math.round(w), height: Math.round(h) };
  const vb = /viewBox\s*=\s*["']\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*["']/i.exec(root);
  if (vb && Number(vb[1]) > 0 && Number(vb[2]) > 0) {
    const vw = Number(vb[1]);
    const vh = Number(vb[2]);
    if (w > 0) return { width: Math.round(w), height: Math.max(1, Math.round((w * vh) / vw)) };
    if (h > 0) return { width: Math.max(1, Math.round((h * vw) / vh)), height: Math.round(h) };
    return { width: Math.round(vw), height: Math.round(vh) };
  }
  return { width: 300, height: 150 };
}

/** A SHA-256 as 64 hex characters. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
