import { packAssets, unpackAssets, type PackedAsset } from './drift-assets';
import { sha256Hex, type ImportedAsset } from './images';
import type { ImageState } from './image-loader';
import { strToU8, strFromU8, unzipSync, zipSync, type Zippable } from 'fflate';
import * as Y from 'yjs';
import type { BoardApp } from './app';
import type { BaseObj, BoardMeta, Id, Obj, Poll, PollAnswer } from './types';
import { SCHEMA_VERSION, isBox, isConnector } from './types';
import type { FlowState, Store } from './store';
import { threadVisible, type Comments, type Thread } from './comments';
import { isWithheld, leaveOutWithheld, updateWithoutWithheld } from './private-select';
import { answerKey } from './polls';
import { cleanProposedBy } from './safe-obj';
import { SVG_DEFS, objectMarkup } from './markup';
import { cssUrl, fontIsAllowed, fontName, nearestWeight } from './fonts';
import { customStickyColors } from './palette';
import { cardRows, cardsCsvName, csvText } from './csv';
import { containerOf } from './containers';
import { listLabels } from './labels';
import { DEMO } from './demo';

const DEMO_IMPORT_COMPRESSED_LIMIT = 20 * 1024 * 1024;
const DEMO_IMPORT_UNCOMPRESSED_LIMIT = 100 * 1024 * 1024;
const FONT_FETCH_TIMEOUT_MS = 8000;
const FONT_CSS_LIMIT_BYTES = 256 * 1024;
const EMBEDDED_FONT_LIMIT_BYTES = 1_500_000;

export interface BoardJson {
  format: 'driftboard';
  schemaVersion: number;
  exportedAt: string;
  meta: BoardMeta;
  objects: Obj[];
  flow: FlowState;
  comments?: Thread[];
  polls?: Poll[];
  pollAnswers?: PollAnswer[];
  /** Says what this file leaves out, when it leaves something out. */
  note?: string;
}

/** The object with `proposedBy` in its one clean shape or not at all: a file never carries what a collaborator wrote there (TAB-160). */
export function withCleanProposedBy<T extends Obj>(o: T): T {
  if (!('proposedBy' in o)) return o;
  const { proposedBy, ...rest } = o as T & { proposedBy?: unknown };
  const clean = cleanProposedBy(proposedBy);
  return (clean ? { ...rest, proposedBy: clean } : rest) as T;
}

/**
 * `leaveOutWithheld` (a file someone hands on) leaves out the notes private writing hides from this person, with the threads
 * and connectors that name them; the board's own backup keeps everything.
 */
export function toJson(app: BoardApp, ids?: Id[], comments: Thread[] = app.conn.comments.list(), opts: { leaveOutWithheld?: boolean } = {}): BoardJson {
  const all = ids ? gatherForSnapshot(app, ids) : app.store.ordered();
  const selectedIds = ids ? new Set(all.map((o) => o.id)) : null;
  // A container's lanes and cards have no positions of their own, so the copy carries the laid-out ones.
  const objs = (opts.leaveOutWithheld ? leaveOutWithheld(all, app.flow) : all)
    .map((o) => {
      const clean = withCleanProposedBy(o.type === 'group' ? o : app.store.placed(o));
      if (!selectedIds || !clean.parent || selectedIds.has(clean.parent)) return clean;
      const detached = { ...clean };
      delete detached.parent;
      return detached;
    });
  if (opts.leaveOutWithheld) comments = threadsWithoutWithheld(app, comments);
  const json: BoardJson = {
    format: 'driftboard',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    meta: app.store.getMeta(),
    objects: objs,
    flow: app.store.getFlow(),
  };
  if (comments.length && !ids) json.comments = comments;
  // the readable snapshot names pictures by hash and does not carry them: a .drift file does (docs/images.md)
  if (objs.some((o) => o.type === 'image')) json.note = 'Images are referenced by their asset hash and their bytes are not included in this file. Export a .drift file to keep them.';
  if (!ids) {
    const { polls, answers } = app.flow.polls.snapshot();
    if (polls.length) json.polls = polls;
    if (answers.length) json.pollAnswers = answers;
  }
  return json;
}

/** The threads that are not about a note private writing hides from this person. */
function threadsWithoutWithheld(app: BoardApp, threads: Thread[]): Thread[] {
  return threads.filter((t) => threadVisible(t, (id) => app.store.get(id), (o) => app.flow.isHidden(o)));
}

/** The comments document with only `keep`'s threads: a file that leaves notes out does not carry what was said about them. */
function commentsWithout(app: BoardApp, keep: Thread[]): Uint8Array {
  const copy = new Y.Doc();
  try {
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(app.conn.comments.doc));
    const kept = new Set(keep.map((t) => t.id));
    const threads = copy.getMap('threads');
    copy.transact(() => {
      for (const id of Array.from(threads.keys())) if (!kept.has(id)) threads.delete(id);
    });
    return Y.encodeStateAsUpdate(copy);
  } finally {
    copy.destroy();
  }
}

/** `.drift` = zip of a readable snapshot plus the full CRDT state (history preserved). */
export async function toDrift(app: BoardApp, opts: { leaveOutWithheld?: boolean } = {}): Promise<Uint8Array> {
  const leave = opts.leaveOutWithheld === true;
  const withheld = leave ? [...app.store.cache.values()].filter((o) => isWithheld(o, app.flow)).map((o) => o.id) : [];
  const files: Zippable = {
    // Comments travel in comments.yjs, not in the readable snapshot.
    'board.json': strToU8(JSON.stringify(toJson(app, undefined, [], { leaveOutWithheld: leave }), null, 2)),
    'doc.yjs': updateWithoutWithheld(app.store.doc, withheld),
  };
  const threads = leave ? threadsWithoutWithheld(app, app.conn.comments.list()) : app.conn.comments.list();
  if (threads.length > 0) files['comments.yjs'] = leave ? commentsWithout(app, threads) : Y.encodeStateAsUpdate(app.conn.comments.doc);
  // the pictures, beside the board (docs/images.md): the file is the one format that round-trips a board completely
  const mimes = new Map<string, string>();
  for (const o of app.store.cache.values()) {
    const b = o as BaseObj;
    if (b.type === 'image' && typeof b.asset === 'string') mimes.set(b.asset, b.mime ?? 'image/png');
  }
  const packed: PackedAsset[] = [];
  for (const [key, mime] of mimes) {
    const blob = await app.images.blobOf(key);
    if (!blob) continue;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    packed.push({ key, mime, bytes, sha: await sha256Hex(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer) });
  }
  for (const [name, data] of Object.entries(packAssets(packed) ?? {})) files[name] = name.startsWith('assets/') ? [data, { level: 0 }] : data;
  return zipSync(files, { level: 6 });
}

export interface ImportedBoard { json: BoardJson; update?: Uint8Array; comments?: Uint8Array; /** The pictures of the file by the `asset` reference they stand for. */ assets?: Record<string, ImportedAsset> }

export async function readBoardFile(file: File): Promise<ImportedBoard> {
  if (DEMO && file.size > DEMO_IMPORT_COMPRESSED_LIMIT) {
    throw new Error('This board file exceeds the 20 MiB demo import limit.');
  }
  const buf = new Uint8Array(await file.arrayBuffer());
  // zip magic: PK\x03\x04
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    let compressedTotal = 0;
    let uncompressedTotal = 0;
    const files = unzipSync(buf, DEMO ? {
      filter: (entry) => {
        compressedTotal += entry.size;
        uncompressedTotal += entry.originalSize;
        if (compressedTotal > DEMO_IMPORT_COMPRESSED_LIMIT) {
          throw new Error('This board archive exceeds the 20 MiB demo import limit.');
        }
        if (uncompressedTotal > DEMO_IMPORT_UNCOMPRESSED_LIMIT) {
          throw new Error('This board archive expands beyond the 100 MiB demo import limit.');
        }
        return true;
      },
    } : undefined);
    const assets = unpackAssets(files);
    if (!files['board.json']) throw new Error('This file is not a Tabula board (board.json is missing).');
    return {
      json: validate(JSON.parse(strFromU8(files['board.json']))),
      update: files['doc.yjs'],
      comments: files['comments.yjs'],
      ...(Object.keys(assets).length ? { assets } : {}),
    };
  }
  return { json: validate(JSON.parse(strFromU8(buf))) };
}

/** The name a board gets when it is imported from a file: the one it was saved with, else the file's name. */
export function importedBoardName(imported: ImportedBoard, fileName: string): string {
  return imported.json.meta?.name || fileName.replace(/\.\w+$/, '');
}

/**
 * Puts an imported board into an empty one: the saved sync state if the file has it, else the readable snapshot.
 * `importedBy` is the account (or device) that imports the file: it owns the new board, so the file's comments are
 * marked imported by it. `null` restores this device's own backup copy, whose comments stay as they were.
 */
export function applyImported(target: { doc: Y.Doc; store: Store; comments: Comments }, imported: ImportedBoard, importedBy: string | null) {
  const { json, update, comments } = imported;
  if (update) Y.applyUpdate(target.doc, update);
  else {
    target.doc.transact(() => {
      for (const [k, v] of Object.entries(json.meta || {})) target.store.meta.set(k, k === 'stickyColors' ? customStickyColors(v) : v);
      for (const o of json.objects as Obj[]) target.store.create(o);
      for (const [k, v] of Object.entries(json.flow || {})) target.store.flow.set(k, v);
      for (const p of json.polls ?? []) target.store.polls.set(p.id, p);
      for (const a of json.pollAnswers ?? []) target.store.pollAnswers.set(answerKey(a.pollId, a.userId), a);
    });
  }
  if (importedBy === null) {
    // toDrift keeps comments in comments.yjs only, so a backup has no readable comments to fall back to.
    if (comments) Y.applyUpdate(target.comments.doc, comments);
  } else if (comments) target.comments.importUpdate(comments, importedBy);
  else if (json.comments) target.comments.importThreads(json.comments, importedBy);
}

function validate(j: unknown): BoardJson {
  const b = j as BoardJson;
  if (!b || b.format !== 'driftboard' || !Array.isArray(b.objects)) throw new Error('This file is not a Tabula board.');
  if (b.comments && !Array.isArray(b.comments)) throw new Error('This file is not a Tabula board.');
  if ((b.polls && !Array.isArray(b.polls)) || (b.pollAnswers && !Array.isArray(b.pollAnswers))) throw new Error('This file is not a Tabula board.');
  if (b.schemaVersion > SCHEMA_VERSION) throw new Error('This board was made with a newer version of Tabula. Update the app to open it.');
  return b;
}

type SaveFile = (data: Blob | Uint8Array | string, name: string) => void;
let nativeSave: SaveFile | null = null;

/** The desktop app replaces the browser download with a native Save dialog (`desktop.ts`). */
export function setNativeSave(save: SaveFile | null) {
  nativeSave = save;
}

export function download(data: Blob | Uint8Array | string, name: string, type = 'application/octet-stream') {
  if (nativeSave) {
    nativeSave(data, name);
    return;
  }
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const safeName = (s: string) => (s || 'board').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'board';

/**
 * The kanbans Cards as CSV takes (docs/kanban.md, Export and import): the ones given, else those of the selection (a
 * kanban, or the kanban of a selected lane or card), else every kanban on the board, in paint order.
 */
export function csvKanbans(app: BoardApp, ids?: readonly Id[]): Id[] {
  const all = app.store.shown().filter((o) => o.type === 'container' && app.store.containerLayout(o.id)).map((o) => o.id);
  const wanted = new Set((ids ?? app.selection).map((id) => containerOf(app.store, app.store.get(id))).filter((c): c is Id => !!c));
  const picked = all.filter((id) => wanted.has(id));
  return picked.length || ids ? picked : all;
}

/** Downloads the cards of kanbans as CSV. False (and nothing downloaded) when there is no kanban. */
export function downloadCardsCsv(app: BoardApp, ids?: readonly Id[]): boolean {
  const kanbans = csvKanbans(app, ids);
  if (!kanbans.length) return false;
  const rows = cardRows({
    get: (id) => app.store.get(id) as BaseObj | undefined,
    containerLayout: (id) => app.store.containerLayout(id),
    labels: listLabels(app.store),
    commentCount: (id) => app.r.commentCount(id),
  }, kanbans);
  const one = kanbans.length === 1 ? (app.store.get(kanbans[0]) as BaseObj).name ?? '' : null;
  download(csvText(rows), cardsCsvName(app.store.getMeta().name, one, safeName), 'text/csv;charset=utf-8');
  return true;
}

// ---------------------------------------------------------------- SVG / PNG

function usedFonts(objs: Obj[]): Map<string, Set<number>> {
  const m = new Map<string, Set<number>>([['satoshi', new Set([500])]]);
  for (const o of objs) {
    const b = o as BaseObj;
    if (!b.font || b.font === 'system') continue;
    if (!fontIsAllowed(b.font)) continue;
    const s = m.get(b.font) ?? new Set<number>();
    s.add(nearestWeight(b.font, b.fontWeight || 400));
    if (o.type === 'uml-class') s.add(nearestWeight(b.font, 700));
    m.set(b.font, s);
  }
  return m;
}

/** Exports are drawn on white, so theme variables are replaced by their fallbacks. */
export function resolveCssVars(svg: string): string {
  return svg.replace(/var\(--[\w-]+,\s*([^)]+)\)/g, (_, fallback: string) => fallback.trim());
}

const HEX6 = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const rgbOf = (c: string): [number, number, number] | null => {
  if (!HEX6.test(c)) return null;
  const h = c.length === 4 ? c.slice(1).split('').map((x) => x + x).join('') : c.slice(1);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
};
const hexOf = (rgb: number[]) => '#' + rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('').toUpperCase();

/**
 * Replaces `color-mix(in srgb, A p%, B)` by a plain colour, for the editors and renderers that do not know color-mix
 * (Inkscape, Illustrator, librsvg draw it black). Run after resolveCssVars, when A and B are hex colours or
 * `transparent`. Mixed with `transparent` gives A at p% opacity: as `fill-opacity` or `stroke-opacity` where the mix is
 * a fill or a stroke in a style, else A alone. Nested mixes are resolved from the inside out.
 */
export function resolveColorMix(svg: string): string {
  const MIX = /color-mix\(in srgb,\s*(#[0-9a-f]{3,6}|transparent)\s+(\d+(?:\.\d+)?)%,\s*(#[0-9a-f]{3,6}|transparent)\s*\)/gi;
  let out = svg;
  for (let i = 0; i < 8 && /color-mix\(/i.test(out); i++) {
    out = out.replace(MIX, (all, a: string, pct: string, b: string) => {
      const p = Math.min(100, Math.max(0, Number(pct))) / 100;
      const ca = rgbOf(a), cb = rgbOf(b);
      if (ca && cb) return hexOf(ca.map((v, k) => v * p + cb[k] * (1 - p)));
      if (ca && b.toLowerCase() === 'transparent') return `${hexOf(ca)}@${Math.round(p * 1000) / 1000}`;
      if (cb && a.toLowerCase() === 'transparent') return `${hexOf(cb)}@${Math.round((1 - p) * 1000) / 1000}`;
      return all;
    });
  }
  return out
    .replace(/(fill|stroke):(#[0-9A-F]{6})@([\d.]+)/g, '$1:$2;$1-opacity:$3')
    .replace(/(#[0-9A-F]{6})@[\d.]+/g, '$1');
}

/** The pictures of the image objects among `objs`, as data URLs by object id: what an export draws in place of a live link. */
export async function imageDataUrls(app: BoardApp, objs: Obj[]): Promise<Map<Id, string>> {
  const out = new Map<Id, string>();
  for (const o of objs) {
    if (o.type !== 'image') continue;
    const url = await app.images.dataUrl(o as BaseObj);
    if (url) out.set(o.id, url);
  }
  return out;
}

export function exportSvg(app: BoardApp, ids?: Id[], opts: { fontCss?: string; background?: boolean; images?: Map<Id, string> } = {}): { svg: string; w: number; h: number } {
  const objs = ids?.length ? gatherForExport(app, ids) : app.store.shown();
  const b = app.r.contentBounds(objs.map((o) => o.id)) ?? { x: 0, y: 0, w: 100, h: 100 };
  const pad = 40;
  const x = b.x - pad, y = b.y - pad - 10, w = b.w + pad * 2, h = b.h + pad * 2 + 10;
  // The ctx carries the canvas's own connector layout, whole-board even when only some objects are exported, so a
  // connector in the file ends where it does on the board, beside connectors that are not in it.
  const images = opts.images;
  const ctx = {
    ...app.r.ctx,
    editingId: null,
    // a file shows the board's content: full detail at any zoom, and nothing of a drag, an input or the editing chrome
    zoom: 1,
    dragging: undefined,
    dropLane: null,
    addingLane: null,
    editable: false,
    // a filter is a view, not content: dimmed cards export at full strength and the header has no Filter (docs/kanban.md)
    filterChips: undefined,
    dimmed: undefined,
    openControl: null,
    // an image is its data URL here, or a placeholder when its bytes were not found: never a link that only works on screen
    imageState: (o: BaseObj): ImageState => { const url = images?.get(o.id); return url ? { kind: 'ok', url } : { kind: 'failed', why: 'missing' }; },
  };
  const body = objs.map((o) => objectMarkup(app.store.placed(o), ctx)).join('\n');
  const style = opts.fontCss ?? '';
  const bg = opts.background === false ? '' : `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#FFFFFF"/>`;
  const svg = resolveColorMix(resolveCssVars(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${Math.ceil(w)}" height="${Math.ceil(h)}" viewBox="${x} ${y} ${w} ${h}"><defs>${SVG_DEFS}<style><![CDATA[
${style.replace(/]]>/g, '')}
]]></style></defs>${bg}${body}</svg>`));
  return { svg, w, h };
}

/** The SVG of the board (or of `ids`) with its pictures and available fonts inlined, so the file stands on its own. */
export async function exportSvgFile(app: BoardApp, ids?: Id[]): Promise<string> {
  const objs = ids?.length ? gatherForExport(app, ids) : app.store.shown();
  const fontCss = await inlineFontCss(objs);
  return exportSvg(app, ids, { fontCss, images: await imageDataUrls(app, objs) }).svg;
}

function gatherForExport(app: BoardApp, ids: Id[]): Obj[] {
  const set = new Set(ids);
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop()!;
    if (app.store.get(id)?.type === 'frame' || app.store.get(id)?.type === 'group') {
      for (const c of app.store.childrenOf(id)) if (!set.has(c.id)) { set.add(c.id); stack.push(c.id); }
    }
    for (const cid of app.store.containerLayout(id)?.order ?? []) set.add(cid);
  }
  // include connectors between exported items
  for (const o of app.store.cache.values()) {
    if (o.type !== 'connector' || set.has(o.id)) continue;
    const c = o as Extract<Obj, { type: 'connector' }>;
    const a = c.from.kind === 'free' || set.has(c.from.id);
    const z = c.to.kind === 'free' || set.has(c.to.id);
    if (a && z && (c.from.kind === 'bound' || c.to.kind === 'bound')) set.add(o.id);
  }
  // Hidden objects (TAB-198) are left out of pictures, as on the canvas; whole-board JSON and .drift keep them.
  return app.store.shown().filter((o) => set.has(o.id));
}

/** A selected JSON snapshot carries shown objects in the selected subtree, except notes private writing hides from this person. */
function gatherForSnapshot(app: BoardApp, ids: Id[]): Obj[] {
  const visible = new Map(app.store.shown()
    .filter((o) => !isWithheld(o, app.flow))
    .map((o) => [o.id, o]));
  const set = new Set(ids.filter((id) => visible.has(id)));
  const stack = [...set];
  while (stack.length) {
    const id = stack.pop()!;
    const type = visible.get(id)?.type;
    if (type !== 'frame' && type !== 'group' && type !== 'container' && type !== 'lane') continue;
    for (const child of app.store.childrenOf(id)) {
      if (child.parent !== id || set.has(child.id) || !visible.has(child.id)) continue;
      set.add(child.id);
      stack.push(child.id);
    }
  }
  for (const id of set) {
    const o = visible.get(id);
    if (isConnector(o) && [o.from, o.to].some((end) => end.kind === 'bound' && !set.has(end.id))) set.delete(id);
  }
  for (const o of visible.values()) {
    if (!isConnector(o) || set.has(o.id)) continue;
    const c = o as Extract<Obj, { type: 'connector' }>;
    if (c.from.kind === 'bound' && c.to.kind === 'bound' && set.has(c.from.id) && set.has(c.to.id)) set.add(o.id);
  }
  return app.store.ordered().filter((o) => set.has(o.id));
}

/** Fetch and consume a response within `ms`, so a slow font never stalls an export. */
async function fetchWithin<T>(url: string, read: (res: Response) => Promise<T>, ms = FONT_FETCH_TIMEOUT_MS, signal?: AbortSignal): Promise<T> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let rejectAbort!: (error: Error) => void;
  const aborted = signal ? new Promise<T>((_, reject) => { rejectAbort = reject; }) : null;
  const onAbort = () => {
    ctrl.abort();
    rejectAbort(new Error(`Font fetch deadline exceeded: ${url}`));
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timedOut = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error(`Font fetch timed out: ${url}`));
    }, ms);
  });
  try {
    const request = (async () => {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`Font fetch failed (${res.status}): ${url}`);
      return read(res);
    })();
    return await Promise.race([request, timedOut, ...(aborted ? [aborted] : [])]);
  } finally {
    clearTimeout(timer!);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function responseBytes(res: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = res.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    try { await res.body?.cancel(); } catch { /* the response may already be closed */ }
    throw new Error(`Font response exceeds ${maxBytes} bytes`);
  }
  if (!res.body) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error(`Font response exceeds ${maxBytes} bytes`);
    return bytes;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > maxBytes) {
        await reader.cancel();
        throw new Error(`Font response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* the stream may already be closed */ }
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function toDataUrl(url: string, maxBytes: number, signal: AbortSignal): Promise<{ dataUrl: string; bytes: number }> {
  return fetchWithin(url, async (res) => {
    const bytes = await responseBytes(res, maxBytes);
    if (!bytes.byteLength) throw new Error('Font response was empty');
    return { dataUrl: `data:font/woff2;base64,${bytesToBase64(bytes)}`, bytes: bytes.byteLength };
  }, FONT_FETCH_TIMEOUT_MS, signal);
}

function faceUsesWeight(face: string, weights: Set<number>): boolean {
  const declaration = face.match(/\bfont-weight\s*:\s*([^;}]+)/i)?.[1];
  const range = declaration?.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (range.length === 1) return weights.has(range[0]);
  if (range.length === 2) return [...weights].some((weight) => weight >= range[0] && weight <= range[1]);
  return false;
}

/**
 * Fonts referenced by a board, inlined as data URLs. Fonts are fetched only
 * while exporting; the SVG and PNG then work without a Fontshare request.
 */
async function inlineFontCss(objs: Obj[]): Promise<string> {
  const parts: string[] = [];
  let embeddedBytes = 0;
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(), FONT_FETCH_TIMEOUT_MS);
  try {
    for (const [slug, ws] of usedFonts(objs)) {
      if (deadline.signal.aborted || embeddedBytes >= EMBEDDED_FONT_LIMIT_BYTES) break;
      const url = cssUrl(slug, [...ws]);
      if (!url) continue;
      let css: string;
      try {
        css = await fetchWithin(url, async (res) => new TextDecoder().decode(await responseBytes(res, FONT_CSS_LIMIT_BYTES)), FONT_FETCH_TIMEOUT_MS, deadline.signal);
      } catch {
        continue; // offline, blocked or malformed response: use the system fallback
      }

      const name = fontName(slug).toLowerCase();
      const faces = css.match(/@font-face\s*{[^}]*}/gi) ?? [];
      for (const face of faces) {
        if (deadline.signal.aborted || embeddedBytes >= EMBEDDED_FONT_LIMIT_BYTES) break;
        const family = face.match(/\bfont-family\s*:\s*([^;}]+)/i)?.[1].trim().replace(/^(['"])(.*)\1$/, '$2');
        if (family?.toLowerCase() !== name || !faceUsesWeight(face, ws)) continue;
        const woff2 = face.match(/url\(\s*(['"]?)([^'")]+)\1\s*\)\s*format\(\s*(['"])woff2\3\s*\)/i);
        const src = face.match(/\bsrc\s*:[^;]*;?/i);
        if (!woff2 || !src) continue;
        let href: string;
        try {
          const parsed = new URL(woff2[2], url);
          if (parsed.protocol !== 'https:' || parsed.hostname !== 'cdn.fontshare.com') continue;
          href = parsed.href;
        } catch {
          continue;
        }
        try {
          const font = await toDataUrl(href, EMBEDDED_FONT_LIMIT_BYTES - embeddedBytes, deadline.signal);
          embeddedBytes += font.bytes;
          parts.push(face.replace(src[0], `src: url("${font.dataUrl}") format("woff2");`));
        } catch {
          /* a failed or over-cap face uses the system fallback */
        }
      }
    }
  } finally {
    clearTimeout(deadlineTimer);
  }
  return parts.join('\n');
}

export async function exportPng(app: BoardApp, ids?: Id[], scale = 2): Promise<Blob> {
  const objs = ids?.length ? gatherForExport(app, ids) : app.store.shown();
  const fontCss = await inlineFontCss(objs);
  const { svg, w, h } = exportSvg(app, ids, { fontCss, images: await imageDataUrls(app, objs) });
  const max = 16000;
  const s = Math.min(scale, max / w, max / h);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Could not render the board image.'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(w * s);
    canvas.height = Math.ceil(h * s);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Objects from an imported board, re-inserted into the current board with fresh ids. */
export function insertImported(app: BoardApp, json: BoardJson, assets?: Record<string, ImportedAsset>) {
  const objs = json.objects.filter((o) => o && typeof o.id === 'string' && typeof o.type === 'string');
  const boxes = objs.filter(isBox);
  if (!objs.length) return;
  const minX = Math.min(...boxes.map((o) => o.x)), minY = Math.min(...boxes.map((o) => o.y));
  const content = app.r.contentBounds();
  const target = content ? { x: content.x + content.w + 200, y: content.y } : app.r.viewport();
  const inserted = app.insertObjects(objs, { x: target.x - (isFinite(minX) ? minX : 0), y: target.y - (isFinite(minY) ? minY : 0) });
  if (assets && Object.keys(assets).length) void app.images.adopt(assets, new Set(inserted.map((o) => o.id)));
  const b = app.r.contentBounds(inserted.map((o) => o.id));
  if (b) app.r.flyTo(b);
}
