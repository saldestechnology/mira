// Where the renderer gets the pixels of an image object from (docs/images.md, Rendering). One answer per object, ready
// to draw: a `blob:` URL when the bytes are here, otherwise why they are not. The bytes come from this device's cache
// first (an image just added, or one seen before), then from the board's asset route. Nothing here throws.
import type { BaseObj, Id } from './types';
import { assetUrl, imageFields, isHash, isPending } from './images';
import type { BlobCache } from './asset-store';
import { IMAGE_UPLOAD_MESSAGES } from './image-messages';

export type ImageState =
  | { kind: 'ok'; url: string }
  | { kind: 'loading' }
  /** Why there is nothing to draw: shown on the placeholder. */
  | { kind: 'failed'; why: 'not_uploaded' | 'lost' | 'toobig' | 'offline' | 'denied' | 'missing' | 'invalid' };

export const FAILED_LABEL: Record<Extract<ImageState, { kind: 'failed' }>['why'], string> = {
  not_uploaded: 'Image not uploaded yet',
  lost: 'Not uploaded: add this image again',
  toobig: IMAGE_UPLOAD_MESSAGES.tooBigLabel,
  offline: 'Offline',
  denied: 'No access to this image',
  missing: 'Image not found',
  invalid: 'Image can not be shown',
};

/** The path of a `Response` for a blob: what the loader needs from `fetch`. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'blob'>>;

export interface LoaderDeps {
  boardId: string;
  cache: BlobCache;
  fetchFn?: FetchFn;
  /** The local queue state for a pending asset, when this browser has an upload record. */
  uploadState?: (asset: string) => Promise<'queued' | 'lost' | 'refused' | 'toobig' | undefined>;
  /** Called with the ids of the objects whose answer changed, so the renderer redraws them. */
  changed: (ids: Id[]) => void;
  createUrl?: (blob: Blob) => string;
  revokeUrl?: (url: string) => void;
}

const RETRY_OFFLINE_MS = 15_000;

export class ImageLoader {
  private states = new Map<string, ImageState>();
  private waiting = new Map<string, Set<Id>>();
  private urls = new Set<string>();
  private retry = new Map<string, number>();
  private destroyed = false;
  private fetchFn: FetchFn;
  private createUrl: (blob: Blob) => string;
  private revokeUrl: (url: string) => void;

  constructor(private deps: LoaderDeps) {
    this.fetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init));
    this.createUrl = deps.createUrl ?? ((b) => URL.createObjectURL(b));
    this.revokeUrl = deps.revokeUrl ?? ((u) => URL.revokeObjectURL(u));
  }

  /** The answer for an image object right now. Starts loading when there is none. */
  state(o: BaseObj): ImageState {
    const f = imageFields(o);
    if (!f) return { kind: 'failed', why: 'invalid' };
    const known = this.states.get(f.asset);
    if (known) {
      if (known.kind === 'failed' && known.why === 'offline') this.maybeRetry(f.asset);
      return known;
    }
    let set = this.waiting.get(f.asset);
    if (!set) this.waiting.set(f.asset, (set = new Set()));
    set.add(o.id);
    const loading: ImageState = { kind: 'loading' };
    this.states.set(f.asset, loading);
    void this.load(f.asset);
    return loading;
  }

  /** Forget retryable failures so the next draw asks for the current queue state again. */
  retryFailed() {
    for (const [asset, s] of this.states) {
      if (s.kind === 'failed' && (s.why === 'offline' || s.why === 'denied' || s.why === 'not_uploaded' || s.why === 'lost' || s.why === 'toobig')) this.set(asset, undefined, true);
    }
  }

  /** The object that carried `pending:<id>` now carries a hash: its bytes are already here, so show them without a download. */
  alias(pendingKey: string, hash: string) {
    const s = this.states.get(pendingKey);
    if (s?.kind === 'ok') this.states.set(hash, s);
  }

  destroy() {
    this.destroyed = true;
    for (const u of this.urls) this.revokeUrl(u);
    this.urls.clear();
    this.states.clear();
    this.waiting.clear();
  }

  private maybeRetry(asset: string) {
    const last = this.retry.get(asset) ?? 0;
    if (Date.now() - last < RETRY_OFFLINE_MS) return;
    this.retry.set(asset, Date.now());
    this.set(asset, undefined, true);
  }

  private set(asset: string, state: ImageState | undefined, redraw = false) {
    if (this.destroyed) return;
    if (state) this.states.set(asset, state);
    else this.states.delete(asset);
    const ids = this.waiting.get(asset);
    if (ids?.size && (state || redraw)) this.deps.changed([...ids]);
  }

  private async load(asset: string): Promise<void> {
    try {
      const local = await this.deps.cache.get(asset);
      if (local) return this.ready(asset, local.blob);
      if (isPending(asset)) {
        let state: Awaited<ReturnType<NonNullable<LoaderDeps['uploadState']>>>;
        try {
          state = await this.deps.uploadState?.(asset);
        } catch {
          state = undefined;
        }
        return this.set(asset, { kind: 'failed', why: state === 'toobig' ? 'toobig' : state === 'lost' || state === 'refused' ? 'lost' : 'not_uploaded' });
      }
      if (!isHash(asset)) return this.set(asset, { kind: 'failed', why: 'invalid' });
      let res: Awaited<ReturnType<FetchFn>>;
      try {
        res = await this.fetchFn(assetUrl(this.deps.boardId, asset), { credentials: 'same-origin' });
      } catch {
        return this.set(asset, { kind: 'failed', why: 'offline' });
      }
      if (!res.ok) {
        const why = res.status === 401 || res.status === 403 ? 'denied' : res.status === 404 ? 'missing' : 'offline';
        return this.set(asset, { kind: 'failed', why });
      }
      const blob = await res.blob();
      await this.deps.cache.put({ key: asset, blob, mime: blob.type, width: 0, height: 0, boardId: this.deps.boardId, pending: false });
      this.ready(asset, blob);
    } catch {
      this.set(asset, { kind: 'failed', why: 'offline' });
    }
  }

  private ready(asset: string, blob: Blob) {
    if (this.destroyed) return;
    const url = this.createUrl(blob);
    this.urls.add(url);
    this.set(asset, { kind: 'ok', url });
  }
}
