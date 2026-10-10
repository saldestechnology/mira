import { describe, expect, it, vi } from 'vitest';
import { createBlobCache, memoryBackend } from '../src/asset-store';
import { FAILED_LABEL, ImageLoader, type FetchFn, type LoaderDeps } from '../src/image-loader';
import type { BaseObj } from '../src/types';

// docs/images.md, Rendering: one answer per image object, from this device first, then from the board's asset route.

const HASH = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);
const img = (asset: string, id = 'o1', extra: Partial<BaseObj> = {}): BaseObj => ({ id, type: 'image', x: 0, y: 0, w: 10, h: 10, rotation: 0, z: 'a', asset, mime: 'image/png', nw: 10, nh: 10, ...extra });
const settle = () => new Promise((r) => setTimeout(r, 0));

function setup(fetchFn?: FetchFn, uploadState?: LoaderDeps['uploadState']) {
  const cache = createBlobCache(memoryBackend());
  const changed = vi.fn<(ids: string[]) => void>();
  let n = 0;
  const loader = new ImageLoader({ boardId: 'board 1', cache, fetchFn, uploadState, changed, createUrl: () => `blob:test/${++n}`, revokeUrl: () => undefined });
  return { cache, changed, loader };
}
const reply = (status: number, type = 'image/png'): FetchFn => async () => ({ ok: status >= 200 && status < 300, status, blob: async () => new Blob([new Uint8Array(4)], { type }) });

describe('ImageLoader', () => {
  it('says loading first and then draws the bytes it fetched, once', async () => {
    const fetchFn = vi.fn<FetchFn>(reply(200));
    const { loader, changed, cache } = setup(fetchFn);
    expect(loader.state(img(HASH))).toEqual({ kind: 'loading' });
    expect(loader.state(img(HASH))).toEqual({ kind: 'loading' });
    await settle();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(`/api/boards/board%201/assets/${HASH}`, { credentials: 'same-origin' });
    expect(loader.state(img(HASH))).toEqual({ kind: 'ok', url: 'blob:test/1' });
    expect(changed).toHaveBeenCalledWith(['o1']);
    expect(await cache.backend.getBlob(HASH)).toBeDefined(); // kept for the next visit and for offline
  });

  it('draws from this device without asking the network', async () => {
    const fetchFn = vi.fn<FetchFn>(reply(200));
    const { loader, cache } = setup(fetchFn);
    await cache.put({ key: HASH, blob: new Blob([new Uint8Array(4)]), mime: 'image/png', width: 1, height: 1, boardId: 'board 1', pending: false });
    loader.state(img(HASH));
    await settle();
    expect(loader.state(img(HASH)).kind).toBe('ok');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('shows a pending image from its local bytes, and says so when they are not on this device', async () => {
    const { loader, cache } = setup(vi.fn<FetchFn>(reply(200)));
    await cache.put({ key: 'pending:1', blob: new Blob([new Uint8Array(4)]), mime: 'image/png', width: 1, height: 1, boardId: 'board 1', pending: true });
    loader.state(img('pending:1', 'a'));
    loader.state(img('pending:2', 'b'));
    await settle();
    expect(loader.state(img('pending:1', 'a')).kind).toBe('ok');
    expect(loader.state(img('pending:2', 'b'))).toEqual({ kind: 'failed', why: 'not_uploaded' });
  });

  it('keeps local bytes visible when the queue reports a hosted size block', async () => {
    const uploadState = vi.fn<NonNullable<LoaderDeps['uploadState']>>(async () => 'toobig');
    const { loader, cache } = setup(undefined, uploadState);
    await cache.put({ key: 'pending:large', blob: new Blob([new Uint8Array(4)]), mime: 'image/png', width: 1, height: 1, boardId: 'b1', pending: true });

    loader.state(img('pending:large'));
    await vi.waitFor(() => expect(loader.state(img('pending:large'))).toEqual({ kind: 'ok', url: 'blob:test/1' }), { timeout: 20_000 });
    expect(uploadState).not.toHaveBeenCalled();
  });

  it.each(['lost', 'refused'] as const)('shows the lost label for a pending image whose queue state is %s', async (state) => {
    const uploadState = vi.fn<NonNullable<LoaderDeps['uploadState']>>(async () => state);
    const { loader } = setup(undefined, uploadState);
    const object = img(`pending:${state}`);

    loader.state(object);
    await vi.waitFor(() => expect(loader.state(object)).toEqual({ kind: 'failed', why: 'lost' }), { timeout: 20_000 });
    expect(uploadState).toHaveBeenCalledWith(`pending:${state}`);
    expect(FAILED_LABEL.lost).toBe('Not uploaded: add this image again');
  });

  it('shows and retries a pending image blocked by the hosted size limit', async () => {
    let state: 'toobig' | undefined = 'toobig';
    const uploadState = vi.fn<NonNullable<LoaderDeps['uploadState']>>(async () => state);
    const { loader, changed } = setup(undefined, uploadState);
    const object = img('pending:large');

    loader.state(object);
    await vi.waitFor(() => expect(loader.state(object)).toEqual({ kind: 'failed', why: 'toobig' }), { timeout: 20_000 });
    expect(FAILED_LABEL.toobig).toBe('Not uploaded: over 1 MB');
    state = undefined;
    loader.retryFailed();
    expect(changed).toHaveBeenLastCalledWith(['o1']);
    loader.state(object);
    await vi.waitFor(() => expect(loader.state(object)).toEqual({ kind: 'failed', why: 'not_uploaded' }), { timeout: 20_000 });
  });

  it('forgets a lost state when retryFailed is called', async () => {
    let state: 'lost' | undefined = 'lost';
    const uploadState = vi.fn<NonNullable<LoaderDeps['uploadState']>>(async () => state);
    const { loader, changed } = setup(undefined, uploadState);
    const object = img('pending:retry');

    loader.state(object);
    await vi.waitFor(() => expect(loader.state(object)).toEqual({ kind: 'failed', why: 'lost' }), { timeout: 20_000 });
    state = undefined;
    loader.retryFailed();
    expect(changed).toHaveBeenLastCalledWith(['o1']);
    loader.state(object);
    await vi.waitFor(() => expect(loader.state(object)).toEqual({ kind: 'failed', why: 'not_uploaded' }), { timeout: 20_000 });
  });

  it.each([
    [404, 'missing'],
    [403, 'denied'],
    [401, 'denied'],
    [500, 'offline'],
  ])('maps a %i to %s', async (status, why) => {
    const { loader } = setup(reply(status));
    loader.state(img(HASH));
    await settle();
    expect(loader.state(img(HASH))).toEqual({ kind: 'failed', why });
  });

  it('says offline when the request fails, and asks again after retryFailed', async () => {
    let online = false;
    const fetchFn: FetchFn = async (url, init) => {
      if (!online) throw new TypeError('network');
      return reply(200)(url, init);
    };
    const { loader, changed } = setup(fetchFn);
    loader.state(img(HASH));
    await settle();
    expect(loader.state(img(HASH))).toEqual({ kind: 'failed', why: 'offline' });
    online = true;
    loader.retryFailed();
    expect(changed).toHaveBeenLastCalledWith(['o1']);
    loader.state(img(HASH));
    await settle();
    expect(loader.state(img(HASH)).kind).toBe('ok');
  });

  it('never fetches something that is not a hash or a pending key, and refuses a broken object', async () => {
    const fetchFn = vi.fn<FetchFn>(reply(200));
    const { loader } = setup(fetchFn);
    expect(loader.state(img('../../etc/passwd'))).toEqual({ kind: 'failed', why: 'invalid' });
    expect(loader.state(img(HASH, 'x', { mime: 'text/html' }))).toEqual({ kind: 'failed', why: 'invalid' });
    expect(loader.state(img(HASH, 'y', { nw: 0 }))).toEqual({ kind: 'failed', why: 'invalid' });
    await settle();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('serves a hash from the pending bytes once the upload has finished', async () => {
    const { loader, cache } = setup(vi.fn<FetchFn>(reply(404)));
    await cache.put({ key: 'pending:1', blob: new Blob([new Uint8Array(4)]), mime: 'image/png', width: 1, height: 1, boardId: 'board 1', pending: true });
    loader.state(img('pending:1'));
    await settle();
    loader.alias('pending:1', OTHER);
    expect(loader.state(img(OTHER))).toEqual({ kind: 'ok', url: 'blob:test/1' });
  });

  it('answers failed for every label it can show', () => {
    for (const why of Object.keys(FAILED_LABEL)) expect(FAILED_LABEL[why as keyof typeof FAILED_LABEL].length).toBeGreaterThan(3);
  });

  it('stops calling back after destroy', async () => {
    const { loader, changed } = setup(reply(200));
    loader.state(img(HASH));
    loader.destroy();
    await settle();
    expect(changed).not.toHaveBeenCalled();
  });
});
