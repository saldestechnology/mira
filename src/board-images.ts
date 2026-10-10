// The image machinery of one open board: the loader the renderer asks, and the queue that sends pending images to the
// relay. Created by BoardApp; the add flow (src/ui/image-add.ts) uses the same cache and queue.
import type { BoardApp } from './app';
import type { BaseObj } from './types';
import { assetUrl, isHash, type ImportedAsset } from './images';
import { newId } from './store';
import { api } from './api';
import { createBlobCache, createUploadQueue, idbBackend, memoryBackend, type UploadQueue, type UploadRecord, type UploadResult } from './asset-store';
import { ImageLoader } from './image-loader';
import { IMAGE_UPLOAD_MESSAGES } from './image-messages';
import { toast } from './ui/common';
import { DEMO } from './demo';

/** One cache for the whole page: the bytes are the person's, not the board's. */
export const assetCache = createBlobCache(idbBackend());

/** Keeps the pictures of an opened board file on this device under their own references, so a board that is only on this device (the desktop app) shows them. */
export async function cacheImportedAssets(assets: Record<string, ImportedAsset> | undefined): Promise<void> {
  for (const [key, a] of Object.entries(assets ?? {})) {
    await assetCache.put({ key, blob: new Blob([a.bytes as BlobPart], { type: a.mime }), mime: a.mime, width: a.width, height: a.height, boardId: '', pending: false });
  }
}

/** Forget every stored image (signing out: the bytes are private to the signed-in person). */
export function clearAssetCache(): Promise<void> {
  return assetCache.clear();
}

export class BoardImages {
  readonly loader: ImageLoader;
  readonly queue: UploadQueue;
  private timer = 0;
  private cache = assetCache;

  constructor(private app: BoardApp) {
    const boardId = app.conn.id;
    this.cache = DEMO ? createBlobCache(memoryBackend()) : assetCache;
    this.loader = new ImageLoader({
      boardId,
      cache: this.cache,
      uploadState: (asset) => this.queue.state(asset),
      changed: (ids) => app.r.invalidateObjects(ids),
    });
    app.r.imageState = (o) => this.loader.state(o);
    let lostCount = 0;
    let lostFlushQueued = false;
    this.queue = createUploadQueue({
      cache: this.cache,
      upload: async (id, blob, mime): Promise<UploadResult> => {
        if (DEMO) throw new Error('Images are unavailable in the demo.');
        const info = await api.uploadAsset(id, blob, mime);
        return { hash: info.hash, mime: info.mime, width: info.width, height: info.height };
      },
      apply: (rec, result) => this.apply(rec, result),
      onRefused: (_rec, status) => {
        this.loader.retryFailed();
        const message = status === 413
          ? IMAGE_UPLOAD_MESSAGES.refused413(app.hostedWorkspace)
          : IMAGE_UPLOAD_MESSAGES.refused[status] ?? IMAGE_UPLOAD_MESSAGES.retryExhausted(status);
        toast(message, 6000);
      },
      onTooBig: () => {
        this.loader.retryFailed();
        toast(IMAGE_UPLOAD_MESSAGES.tooBig, 8000);
      },
      onLost: () => {
        this.loader.retryFailed();
        lostCount++;
        if (lostFlushQueued) return;
        lostFlushQueued = true;
        queueMicrotask(() => {
          const count = lostCount;
          lostCount = 0;
          lostFlushQueued = false;
          toast(IMAGE_UPLOAD_MESSAGES.lost(count), 8000);
        });
      },
      canApply: (id) => id === boardId && !app.readOnly,
      hostedWorkspace: app.hostedWorkspace,
    });
    const ready = this.queue.retryBlocked(boardId).catch(() => undefined);
    const run = () => void ready.then(() => this.queue.run(boardId));
    const off = app.conn.onStatus((s) => {
      if (s === 'live') {
        this.loader.retryFailed();
        run();
      }
    });
    const onOnline = () => {
      this.loader.retryFailed();
      run();
    };
    window.addEventListener('online', onOnline, { signal: app.lifetime.signal });
    this.timer = window.setInterval(run, 30_000);
    app.lifetime.signal.addEventListener('abort', () => {
      off();
      window.clearInterval(this.timer);
      this.loader.destroy();
    }, { once: true });
    run();
  }

  /** The bytes of a picture by its `asset` reference: this device's copy, else the relay's. Null when neither has them. */
  async blobOf(asset: string): Promise<Blob | null> {
    const local = (await this.cache.get(asset))?.blob;
    if (local) return local;
    if (DEMO) return null;
    if (!isHash(asset)) return null;
    try {
      const res = await fetch(assetUrl(this.app.conn.id, asset), { credentials: 'same-origin' });
      return res.ok ? await res.blob() : null;
    } catch {
      return null;
    }
  }

  /**
   * Pictures that came with an opened board file (docs/images.md): their bytes go in this device's cache under fresh
   * `pending:` keys, the objects that showed them are pointed at those keys (not an undo step), and the upload queue sends
   * them to this board. `only` limits it to objects just added to a board that already had others.
   */
  async adopt(assets: Record<string, ImportedAsset>, only?: Set<string>): Promise<void> {
    const store = this.app.store;
    const boardId = this.app.conn.id;
    const byKey = new Map<string, string[]>();
    for (const o of store.cache.values()) {
      if (o.type !== 'image' || (only && !only.has(o.id))) continue;
      const key = (o as BaseObj).asset;
      if (typeof key === 'string' && assets[key]) byKey.set(key, [...(byKey.get(key) ?? []), o.id]);
    }
    if (DEMO) {
      for (const [key, ids] of byKey) {
        const a = assets[key];
        await this.cache.put({ key, blob: new Blob([a.bytes as BlobPart], { type: a.mime }), mime: a.mime, width: a.width, height: a.height, boardId, pending: false });
        this.app.r.invalidateObjects(ids);
      }
      return;
    }
    for (const [key, ids] of byKey) {
      const a = assets[key];
      const pending = `pending:${newId()}`;
      await this.cache.put({ key: pending, blob: new Blob([a.bytes as BlobPart], { type: a.mime }), mime: a.mime, width: a.width, height: a.height, boardId, pending: true });
      store.transactAs(() => ids.forEach((id) => store.update(id, { asset: pending, mime: a.mime, nw: a.width, nh: a.height })), 'assets');
      await this.queue.enqueue({ id: pending, boardId, objectId: ids[0], hash: key });
      this.app.r.invalidateObjects(ids);
    }
    if (byKey.size) void this.queue.run(boardId);
  }

  /**
   * The picture of an image object as a data URL, for an export: the rasteriser behind PNG export cannot load a `blob:` or
   * a relay URL from inside an SVG. Null when the bytes are neither on this device nor on the relay.
   */
  async dataUrl(o: BaseObj): Promise<string | null> {
    const asset = (o as { asset?: string }).asset;
    if (typeof asset !== 'string') return null;
    const blob = await this.blobOf(asset);
    if (!blob) return null;
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(typeof r.result === 'string' ? r.result : null);
      r.onerror = () => resolve(null);
      r.readAsDataURL(blob);
    });
  }

  /** Writes the real hash into the image object. Not an undo step: undo should never bring the pending key back. */
  private apply(rec: UploadRecord, result: UploadResult): boolean {
    const store = this.app.store;
    // every object that carries the pending key: a duplicate, or the same picture imported twice, shares it
    const ids = [...store.cache.values()].filter((o) => o.type === 'image' && (o as BaseObj).asset === rec.id).map((o) => o.id);
    if (!ids.length) return false;
    store.transactAs(() => ids.forEach((id) => store.update(id, { asset: result.hash, mime: result.mime, nw: result.width, nh: result.height })), 'assets');
    this.loader.alias(rec.id, result.hash);
    this.app.r.invalidateObjects(ids);
    return true;
  }
}
