// Adding pictures to the board: paste, drop or the Image button all end here (docs/images.md, Adding an image).
// Each file is checked by its bytes, decoded, scaled down, stripped of metadata by the canvas re-encode, hashed and put in
// the local cache with a `pending:` key; the object is created at once and the upload queue sends the bytes. One undo
// step for the whole action, and one refused file never stops the others.
import type { BoardApp } from '../app';
import type { BaseObj, Point } from '../types';
import { newId } from '../store';
import { assetCache } from '../board-images';
import {
  HOSTED_UPLOAD_LIMIT_BYTES, HOSTED_UPLOAD_TARGET_BYTES, MAX_FILES_PER_ACTION, MAX_FILE_BYTES, PENDING_PREFIX, detectKind,
  layoutBounds, layoutRow, pickEncoding, placedSize, planEncoding, pngHasAlpha, readImageInfo, refusalMessage, scaleDown,
  sha256Hex, shrinkLadder, sizeOk, svgSize, type FileKind, type Refusal, type StoredType,
} from '../images';
import { MAX_STORED_SIDE } from '../images';
import { IMAGE_UPLOAD_MESSAGES } from '../image-messages';
import { toast } from './common';

/** Raw files over this are refused before they are read: the browser has to hold the decoded pixels too. */
const MAX_RAW_BYTES = 50 * 1024 * 1024;
const HEAD_BYTES = 256 * 1024;

export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml,.png,.jpg,.jpeg,.gif,.webp,.svg';

interface Prepared {
  blob: Blob;
  mime: StoredType;
  width: number;
  height: number;
  hash: string;
}

class Refused extends Error {
  constructor(readonly reason: Refusal['reason']) {
    super(reason);
  }
}

type Surface = { ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D; encode: (type: string, quality?: number) => Promise<Blob | null>; canvas: HTMLCanvasElement | OffscreenCanvas };

interface EncodedImage { blob: Blob; mime: StoredType; width: number; height: number }

function surface(width: number, height: number): Surface {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (ctx) return { ctx, canvas, encode: (type, quality) => canvas.convertToBlob({ type, quality }).catch(() => null) };
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Refused('unreadable');
  return { ctx, canvas, encode: (type, quality) => new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality)) };
}

/** Draws `source` at the target size, halving step by step above 2x so a big photo does not alias. */
function drawScaled(source: ImageBitmap | HTMLImageElement, sw: number, sh: number, width: number, height: number): Surface {
  let from: ImageBitmap | HTMLImageElement | Surface['canvas'] = source;
  let w = sw;
  let h = sh;
  while (w / 2 >= width && h / 2 >= height) {
    const step = surface(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)));
    step.ctx.imageSmoothingQuality = 'high';
    step.ctx.drawImage(from as CanvasImageSource, 0, 0, step.canvas.width, step.canvas.height);
    from = step.canvas;
    w = step.canvas.width;
    h = step.canvas.height;
  }
  const out = surface(width, height);
  out.ctx.imageSmoothingQuality = 'high';
  out.ctx.drawImage(from as CanvasImageSource, 0, 0, width, height);
  return out;
}

async function shrinkHosted(source: ImageBitmap | HTMLImageElement, input: {
  hostedWorkspace: boolean;
  type: StoredType;
  hasAlpha: boolean;
  sourceWidth: number;
  sourceHeight: number;
  plannedWidth: number;
  plannedHeight: number;
  image: EncodedImage;
}): Promise<EncodedImage> {
  let best = input.image;
  if (!input.hostedWorkspace || best.blob.size <= HOSTED_UPLOAD_TARGET_BYTES) return best;
  const ladder = shrinkLadder({
    type: input.type,
    hasAlpha: input.hasAlpha,
    width: input.plannedWidth,
    height: input.plannedHeight,
    bytes: best.blob.size,
    target: HOSTED_UPLOAD_TARGET_BYTES,
  });
  for (const step of ladder) {
    const s = drawScaled(source, input.sourceWidth, input.sourceHeight, step.width, step.height);
    const blob = await s.encode(step.type, step.quality);
    if (!blob || blob.type !== step.type) continue;
    if (blob.size < best.blob.size) best = { blob, mime: step.type, width: step.width, height: step.height };
    if (blob.size <= HOSTED_UPLOAD_TARGET_BYTES) {
      best = { blob, mime: step.type, width: step.width, height: step.height };
      break;
    }
  }
  return best;
}

async function rasterise(file: Blob, kind: FileKind, head: Uint8Array, hostedWorkspace: boolean): Promise<Prepared> {
  const type = kind as StoredType;
  const info = readImageInfo(head, type);
  if (!info) throw new Refused('unreadable');
  if (!sizeOk(info.width, info.height)) throw new Refused('too_many_pixels');

  if (type === 'image/gif') {
    // not re-encoded: a canvas would keep only the first frame
    if (file.size > MAX_FILE_BYTES || Math.max(info.width, info.height) > MAX_STORED_SIDE) throw new Refused('gif_too_big');
    const buf = await file.arrayBuffer();
    return { blob: new Blob([buf], { type }), mime: type, width: info.width, height: info.height, hash: await sha256Hex(buf) };
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Refused('unreadable');
  }
  try {
    const hasAlpha = type === 'image/png' ? pngHasAlpha(head) : type !== 'image/jpeg';
    const plan = planEncoding({ type, width: bitmap.width, height: bitmap.height, bytes: file.size, hasAlpha });
    const results: { type: string; size: number; blob: Blob }[] = [];
    for (const c of plan.candidates) {
      const s = drawScaled(bitmap, bitmap.width, bitmap.height, plan.width, plan.height);
      const blob = await s.encode(c.type, c.quality);
      if (blob && blob.type === c.type) results.push({ type: c.type, size: blob.size, blob });
    }
    const pick = pickEncoding({ type, bytes: file.size, scaled: plan.scaled }, results);
    const chosen = results.find((r) => r.type === pick);
    const encoded = await shrinkHosted(bitmap, {
      hostedWorkspace,
      type,
      hasAlpha,
      sourceWidth: bitmap.width,
      sourceHeight: bitmap.height,
      plannedWidth: plan.width,
      plannedHeight: plan.height,
      image: chosen
        ? { blob: chosen.blob, mime: chosen.type as StoredType, width: plan.width, height: plan.height }
        : { blob: file, mime: type, width: bitmap.width, height: bitmap.height },
    });
    return finish(encoded.blob, encoded.mime, encoded.width, encoded.height);
  } finally {
    bitmap.close();
  }
}

async function finish(blob: Blob, mime: StoredType, width: number, height: number): Promise<Prepared> {
  const typed = blob.type === mime ? blob : new Blob([blob], { type: mime });
  if (typed.size > MAX_FILE_BYTES) throw new Refused('too_large');
  return { blob: typed, mime, width, height, hash: await sha256Hex(await typed.arrayBuffer()) };
}

/** SVG is not stored (docs/images.md, Decided): it is drawn once on a canvas and kept as a PNG. */
async function rasteriseSvg(file: Blob, hostedWorkspace: boolean): Promise<Prepared> {
  const text = await file.text();
  const natural = svgSize(text);
  const { width, height } = scaleDown(natural.width, natural.height);
  if (!sizeOk(width, height)) throw new Refused('too_many_pixels');
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.width = width;
    img.height = height;
    img.src = url;
    try {
      await img.decode();
    } catch {
      throw new Refused('unreadable');
    }
    const s = surface(width, height);
    s.ctx.drawImage(img, 0, 0, width, height);
    const blob = await s.encode('image/png');
    if (!blob) throw new Refused('unreadable');
    const encoded = await shrinkHosted(img, {
      hostedWorkspace,
      type: 'image/png',
      hasAlpha: true,
      sourceWidth: width,
      sourceHeight: height,
      plannedWidth: width,
      plannedHeight: height,
      image: { blob, mime: 'image/png', width, height },
    });
    return finish(encoded.blob, encoded.mime, encoded.width, encoded.height);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function prepare(file: File | Blob, hostedWorkspace: boolean): Promise<Prepared> {
  if (file.size === 0) throw new Refused('empty');
  if (file.size > MAX_RAW_BYTES) throw new Refused('too_large');
  const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
  const kind = detectKind(head);
  if (!kind) throw new Refused('unsupported');
  if (kind === 'image/svg+xml') return rasteriseSvg(file, hostedWorkspace);
  return rasterise(file, kind, head, hostedWorkspace);
}

const nameOf = (f: File | Blob, i: number) => ('name' in f && f.name ? f.name : `Pasted image ${i + 1}`);

/**
 * Adds the files to the board as image objects, laid out left to right from `at` (or the middle of the view). Returns how
 * many went in. Refusals are toasted one by one; nothing blocks the files after a refused one.
 */
export async function addImages(app: BoardApp, files: (File | Blob)[], at?: Point): Promise<number> {
  if (app.readOnly) {
    toast("You can't add images to a board you can only view.");
    return 0;
  }
  const list = files.slice(0, MAX_FILES_PER_ACTION);
  if (files.length > list.length) toast(`Only the first ${MAX_FILES_PER_ACTION} images were added.`);
  const view = app.r.viewport();
  const prepared: { id: string; key: string; p: Prepared; size: { w: number; h: number } }[] = [];
  for (const [i, file] of list.entries()) {
    try {
      const p = await prepare(file, app.hostedWorkspace);
      prepared.push({ id: newId(), key: `${PENDING_PREFIX}${newId()}`, p, size: placedSize(p.width, p.height, view) });
    } catch (err) {
      toast(refusalMessage({ name: nameOf(file, i), reason: err instanceof Refused ? err.reason : 'unreadable' }), 6000);
    }
  }
  if (!prepared.length) return 0;
  const overLimit = app.hostedWorkspace ? prepared.filter(({ p }) => p.blob.size > HOSTED_UPLOAD_LIMIT_BYTES).length : 0;
  if (overLimit) toast(IMAGE_UPLOAD_MESSAGES.actionOverLimit(overLimit), 8000);

  const boardId = app.conn.id;
  for (const { id, key, p } of prepared) {
    await assetCache.put({ key, blob: p.blob, mime: p.mime, width: p.width, height: p.height, boardId, pending: true });
    await app.images.queue.enqueue({ id: key, boardId, objectId: id, hash: p.hash, bytes: p.blob.size });
  }

  const sizes = prepared.map((x) => x.size);
  const centre = at ?? { x: view.x + view.w / 2, y: view.y + view.h / 2 };
  const spots = layoutRow(sizes, { x: 0, y: 0 }, Math.max(view.w * 0.9, sizes[0].w));
  const block = layoutBounds(sizes, spots);
  const origin = { x: Math.round(centre.x - block.w / 2), y: Math.round(centre.y - block.h / 2) };
  const zs = app.store.topZs(prepared.length);
  const objs: BaseObj[] = prepared.map((x, i) => ({
    id: x.id, type: 'image', x: origin.x + spots[i].x, y: origin.y + spots[i].y, w: x.size.w, h: x.size.h, rotation: 0, z: zs[i],
    asset: x.key, mime: x.p.mime, nw: x.p.width, nh: x.p.height, createdBy: app.user.id, updatedAt: Date.now(),
  }));
  app.store.undo.stopCapturing();
  app.store.transact(() => objs.forEach((o) => app.store.create(o)));
  app.setSelection(objs.map((o) => o.id));
  void app.images.queue.run(boardId);
  return objs.length;
}

/** The hidden file input behind the Image button. */
export function pickImages(app: BoardApp): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = IMAGE_ACCEPT;
  input.multiple = true;
  input.addEventListener('change', () => {
    const files = [...(input.files ?? [])];
    if (files.length) void addImages(app, files);
  });
  input.click();
}
