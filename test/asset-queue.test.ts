import { describe, expect, it, vi } from 'vitest';
import { BLOB_CACHE_BYTES, backoffMs, createBlobCache, createUploadQueue, evictionPlan, memoryBackend, type UploadRecord, type UploadResult } from '../src/asset-store';

// docs/images.md, Offline and the upload queue: pending images reach the server, in order, with backoff, and a deleted
// object drops its record. The storage is injected, as icon-offline does.

const blob = (n: number, type = 'image/png') => new Blob([new Uint8Array(n)], { type });
const RESULT: UploadResult = { hash: 'a'.repeat(64), mime: 'image/png', width: 4, height: 3 };

function setup(over: Partial<Parameters<typeof createUploadQueue>[0]> = {}) {
  let t = 1000;
  const backend = memoryBackend();
  const cache = createBlobCache(backend, { now: () => t });
  const upload = vi.fn<(boardId: string, blob: Blob, mime: string) => Promise<UploadResult>>(async () => RESULT);
  const apply = vi.fn<(rec: UploadRecord, res: UploadResult) => boolean>(() => true);
  const onRefused = vi.fn<(rec: UploadRecord, status: number, code: string) => void>();
  const onTooBig = vi.fn<(rec: UploadRecord) => void>();
  const onLost = vi.fn<(rec: UploadRecord) => void>();
  const queue = createUploadQueue({ cache, upload, apply, onRefused, onTooBig, onLost, now: () => t, ...over });
  const add = async (id: string, objectId = `o-${id}`, boardId = 'b1', bytes = 10) => {
    await cache.put({ key: `pending:${id}`, blob: blob(bytes), mime: 'image/png', width: 4, height: 3, boardId, pending: true });
    await queue.enqueue({ id: `pending:${id}`, boardId, objectId, hash: 'h', bytes });
    t += 1;
  };
  return { backend, cache, queue, upload, apply, onRefused, onTooBig, onLost, add, tick: (ms: number) => (t += ms) };
}

describe('the upload queue', () => {
  it('uploads a pending image, writes the hash into its object and moves the bytes to the hash', async () => {
    const s = setup();
    await s.add('1');
    await s.queue.run('b1');
    expect(s.upload).toHaveBeenCalledWith('b1', expect.any(Blob), 'image/png');
    expect(s.apply).toHaveBeenCalledWith(expect.objectContaining({ id: 'pending:1', objectId: 'o-1' }), RESULT);
    expect(await s.queue.pending()).toBe(0);
    expect(await s.backend.getBlob('pending:1')).toBeUndefined();
    expect(await s.backend.getBlob(RESULT.hash)).toMatchObject({ pending: false, key: RESULT.hash });
  });

  it('sends three at a time', async () => {
    let running = 0;
    let peak = 0;
    let release!: () => void;
    let threeStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const firstBatch = new Promise<void>((resolve) => { threeStarted = resolve; });
    const s = setup({
      upload: async () => {
        running += 1;
        peak = Math.max(peak, running);
        if (running === 3) threeStarted();
        await gate;
        running -= 1;
        return RESULT;
      },
    });
    for (const id of ['1', '2', '3', '4', '5']) await s.add(id);
    const pass = s.queue.run();
    await firstBatch;
    expect(peak).toBe(3);
    release();
    await pass;
    expect(await s.queue.pending()).toBe(0);
  });

  it('sends the oldest first', async () => {
    const applied: string[] = [];
    const s = setup({ parallel: 1, apply: (rec) => { applied.push(rec.objectId); return true; } });
    for (const id of ['3', '1', '2']) await s.add(id);
    await s.queue.run();
    expect(applied).toEqual(['o-3', 'o-1', 'o-2']);
  });

  it('keeps a failed upload for later with a growing delay', async () => {
    const s = setup({ upload: async () => { throw Object.assign(new Error('offline'), { status: 0 }); } });
    await s.add('1');
    await s.queue.run();
    const [rec] = await s.backend.listUploads();
    expect(rec.tries).toBe(0);
    expect(rec.backoffTries).toBe(1);
    expect(rec.nextAt).toBe(1001 + backoffMs(0));
    await s.queue.run(); // not due yet: nothing is tried
    expect((await s.backend.listUploads())[0].backoffTries).toBe(1);
    s.tick(backoffMs(0) + 5);
    await s.queue.run();
    expect((await s.backend.listUploads())[0]).toMatchObject({ tries: 0, backoffTries: 2 });
    expect(backoffMs(0)).toBe(1000);
    expect(backoffMs(3)).toBe(8000);
    expect(backoffMs(50)).toBe(60_000);
  });

  it.each([400, 402, 403, 404, 413])('keeps a %i refusal blocked until the board is reopened, then retries once', async (status) => {
    let attempts = 0;
    const s = setup({ upload: async () => {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error('no'), { status, code: 'x' });
      return RESULT;
    } });
    await s.add('1');
    await s.queue.run();
    expect(await s.queue.pending()).toBe(1);
    expect(await s.queue.state('pending:1')).toBe('refused');
    expect(await s.backend.listUploads()).toEqual([expect.objectContaining({ id: 'pending:1', refused: status, notified: true })]);
    expect(s.onRefused).toHaveBeenCalledWith(expect.objectContaining({ id: 'pending:1' }), status, 'x');
    expect(s.onRefused).toHaveBeenCalledTimes(1);
    expect(await s.backend.getBlob('pending:1')).toBeDefined();

    await s.queue.run('b1');
    expect(attempts).toBe(1);
    expect(s.onRefused).toHaveBeenCalledTimes(1);

    await s.queue.retryBlocked('b1');
    expect(await s.queue.state('pending:1')).toBe('queued');
    const [retryable] = await s.backend.listUploads();
    expect(retryable).not.toHaveProperty('refused');
    expect(retryable).not.toHaveProperty('notified');
    await s.queue.run('b1');
    expect(attempts).toBe(2);
    expect(await s.queue.pending()).toBe(0);
    expect(await s.backend.getBlob('pending:1')).toBeUndefined();
    expect(await s.backend.getBlob(RESULT.hash)).toMatchObject({ key: RESULT.hash, pending: false });
  });

  it.each([0, 401, 429, 500, 502])('keeps the record on a %i', async (status) => {
    const s = setup({ upload: async () => { throw Object.assign(new Error('later'), { status }); } });
    await s.add('1');
    await s.queue.run();
    expect(await s.queue.pending()).toBe(1);
    expect(s.onRefused).not.toHaveBeenCalled();
  });

  it('blocks a hosted image over 1 MB after three server failures until the board is reopened', async () => {
    let attempts = 0;
    const s = setup({ hostedWorkspace: true, upload: async () => {
      attempts++;
      throw Object.assign(new Error('redirect'), { status: 307 });
    } });
    await s.add('large', 'o-large', 'b1', 1_200_000);

    for (let i = 0; i < 3; i++) {
      await s.queue.run('b1');
      s.tick(100_000);
    }

    expect(attempts).toBe(3);
    expect(await s.queue.state('pending:large')).toBe('toobig');
    expect(await s.backend.listUploads()).toEqual([expect.objectContaining({
      id: 'pending:large', bytes: 1_200_000, tries: 3, refused: 413, sizeBlocked: true, notified: true,
    })]);
    expect(await s.backend.getBlob('pending:large')).toBeDefined();
    expect(s.onTooBig).toHaveBeenCalledTimes(1);
    expect(s.onTooBig).toHaveBeenCalledWith(expect.objectContaining({ sizeBlocked: true }));
    expect(s.onRefused).not.toHaveBeenCalled();

    await s.queue.run('b1');
    expect(attempts).toBe(3);
    await s.queue.retryBlocked('b1');
    expect(await s.queue.state('pending:large')).toBe('queued');
    await s.queue.run('b1');
    expect(attempts).toBe(4);
    expect(s.onTooBig).toHaveBeenCalledTimes(1);
  });

  it('counts a big hosted upload that fails with no answer while online, so it is not retried silently forever', async () => {
    let attempts = 0;
    const s = setup({ hostedWorkspace: true, upload: async () => {
      attempts++;
      throw Object.assign(new Error('reset'), { status: 0 });
    } });
    await s.add('large', 'o-large', 'b1', 1_200_000);
    for (let i = 0; i < 3; i++) {
      await s.queue.run('b1');
      s.tick(100_000);
    }
    expect(attempts).toBe(3);
    expect(await s.queue.state('pending:large')).toBe('toobig');
    expect(s.onTooBig).toHaveBeenCalledTimes(1);
  });

  it('never counts a no-answer failure of a small image, or of a big one while the browser is offline', async () => {
    const small = setup({ hostedWorkspace: true, upload: async () => { throw Object.assign(new Error('reset'), { status: 0 }); } });
    await small.add('small', 'o-small', 'b1', 400_000);
    for (let i = 0; i < 6; i++) {
      await small.queue.run('b1');
      small.tick(100_000);
    }
    expect(await small.queue.state('pending:small')).toBe('queued');
    expect(small.onTooBig).not.toHaveBeenCalled();
    expect(small.onRefused).not.toHaveBeenCalled();

    vi.stubGlobal('navigator', { onLine: false });
    try {
      const big = setup({ hostedWorkspace: true, upload: async () => { throw Object.assign(new Error('offline'), { status: 0 }); } });
      await big.add('large', 'o-large', 'b1', 1_200_000);
      for (let i = 0; i < 4; i++) {
        await big.queue.run('b1');
        big.tick(100_000);
      }
      expect(await big.queue.state('pending:large')).toBe('queued');
      expect(big.onTooBig).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses the generic retry limit for a large self-hosted upload', async () => {
    let attempts = 0;
    const s = setup({ upload: async () => {
      attempts++;
      throw Object.assign(new Error('gateway'), { status: 502 });
    } });
    await s.add('large', 'o-large', 'b1', 1_200_000);
    for (let i = 0; i < 3; i++) {
      await s.queue.run('b1');
      s.tick(100_000);
    }
    expect(await s.queue.state('pending:large')).toBe('queued');
    expect(s.onTooBig).not.toHaveBeenCalled();
    for (let i = 0; i < 2; i++) {
      await s.queue.run('b1');
      s.tick(100_000);
    }
    expect(attempts).toBe(5);
    expect(await s.queue.state('pending:large')).toBe('refused');
    expect(s.onRefused).toHaveBeenCalledWith(expect.objectContaining({ refused: 502 }), 502, '');
  });

  it('keeps a smaller upload retrying until its fifth server failure, then reports the last status once', async () => {
    let attempts = 0;
    const s = setup({ hostedWorkspace: true, upload: async () => {
      attempts++;
      throw Object.assign(new Error('redirect'), { status: 307 });
    } });
    await s.add('small', 'o-small', 'b1', 400_000);

    for (let i = 0; i < 4; i++) {
      await s.queue.run('b1');
      s.tick(100_000);
    }
    expect(await s.queue.state('pending:small')).toBe('queued');
    expect(s.onRefused).not.toHaveBeenCalled();

    await s.queue.run('b1');
    expect(attempts).toBe(5);
    expect(await s.queue.state('pending:small')).toBe('refused');
    expect(await s.backend.listUploads()).toEqual([expect.objectContaining({
      id: 'pending:small', tries: 5, refused: 307, notified: true,
    })]);
    expect(s.onRefused).toHaveBeenCalledTimes(1);
    expect(s.onRefused).toHaveBeenCalledWith(expect.objectContaining({ id: 'pending:small' }), 307, '');
    await s.queue.run('b1');
    expect(attempts).toBe(5);
    expect(s.onRefused).toHaveBeenCalledTimes(1);
  });

  it('never counts offline status 0 toward either refusal threshold', async () => {
    let largeAttempts = 0;
    const large = setup({ hostedWorkspace: true, upload: async () => {
      largeAttempts++;
      throw Object.assign(new Error('offline'), { status: largeAttempts <= 5 ? 0 : 307 });
    } });
    await large.add('large', 'o-large', 'b1', 1_200_000);
    // offline: a no-answer failure is not the server's (online, a big hosted upload that gets no answer does count)
    vi.stubGlobal('navigator', { onLine: false });
    for (let i = 0; i < 5; i++) {
      await large.queue.run('b1');
      large.tick(100_000);
    }
    vi.unstubAllGlobals();
    expect(await large.backend.listUploads()).toEqual([expect.objectContaining({ tries: 0, backoffTries: 5 })]);
    expect(large.onTooBig).not.toHaveBeenCalled();
    for (let i = 0; i < 2; i++) {
      await large.queue.run('b1');
      large.tick(100_000);
    }
    expect(await large.queue.state('pending:large')).toBe('queued');
    await large.queue.run('b1');
    expect(await large.queue.state('pending:large')).toBe('toobig');

    let smallAttempts = 0;
    const small = setup({ hostedWorkspace: true, upload: async () => {
      smallAttempts++;
      throw Object.assign(new Error('offline'), { status: smallAttempts <= 5 ? 0 : 502 });
    } });
    await small.add('small', 'o-small', 'b1', 400_000);
    for (let i = 0; i < 5; i++) {
      await small.queue.run('b1');
      small.tick(100_000);
    }
    for (let i = 0; i < 4; i++) {
      await small.queue.run('b1');
      small.tick(100_000);
    }
    expect(await small.queue.state('pending:small')).toBe('queued');
    expect(small.onRefused).not.toHaveBeenCalled();
    await small.queue.run('b1');
    expect(await small.queue.state('pending:small')).toBe('refused');
    expect(small.onRefused).toHaveBeenCalledTimes(1);
    expect(small.onRefused).toHaveBeenCalledWith(expect.objectContaining({ tries: 5 }), 502, '');
  });

  it('drops the record and the bytes when the object is gone', async () => {
    const s = setup({ apply: () => false });
    await s.add('1');
    await s.queue.run();
    expect(await s.queue.pending()).toBe(0);
    expect(await s.backend.getBlob('pending:1')).toBeUndefined();
    expect(await s.backend.getBlob(RESULT.hash)).toBeUndefined();
  });

  it('keeps a missing-blob record marked lost and reports it only once', async () => {
    const s = setup();
    const deleteUpload = vi.spyOn(s.backend, 'deleteUpload');
    expect(await s.queue.state('pending:ghost')).toBeUndefined();
    await s.queue.enqueue({ id: 'pending:ghost', boardId: 'b1', objectId: 'o', hash: 'h' });
    await s.queue.run();
    expect(await s.queue.pending()).toBe(1);
    expect(await s.queue.state('pending:ghost')).toBe('lost');
    expect(await s.backend.listUploads()).toEqual([expect.objectContaining({ id: 'pending:ghost', lost: true, notified: true })]);
    expect(s.onLost).toHaveBeenCalledTimes(1);
    expect(s.upload).not.toHaveBeenCalled();
    await s.queue.run();
    expect(s.onLost).toHaveBeenCalledTimes(1);
    expect(deleteUpload).not.toHaveBeenCalled();
    await s.queue.retryBlocked();
    await s.queue.run();
    expect(await s.queue.state('pending:ghost')).toBe('lost');
    expect(s.onLost).toHaveBeenCalledTimes(1);
  });

  it('reports every newly lost record together at the end of a pass', async () => {
    const s = setup();
    await s.queue.enqueue({ id: 'pending:first', boardId: 'b1', objectId: 'o1', hash: 'h1' });
    await s.queue.enqueue({ id: 'pending:second', boardId: 'b1', objectId: 'o2', hash: 'h2' });

    await s.queue.run('b1');

    expect(s.onLost.mock.calls.map(([rec]) => rec.id)).toEqual(['pending:first', 'pending:second']);
  });

  it('leaves uploads for a board that cannot be applied untouched', async () => {
    const s = setup({ canApply: (id) => id === 'b1' });
    await s.queue.enqueue({ id: 'pending:closed', boardId: 'b2', objectId: 'o', hash: 'h' });
    await s.backend.putUpload({ id: 'pending:refused', boardId: 'b2', objectId: 'o', hash: 'h', tries: 0, nextAt: 0, at: 0, refused: 403, notified: true });
    await s.queue.retryBlocked();
    await s.queue.run();
    expect(await s.queue.state('pending:closed')).toBe('queued');
    expect(await s.queue.state('pending:refused')).toBe('refused');
    expect(await s.queue.pending('b2')).toBe(2);
    expect(s.onLost).not.toHaveBeenCalled();
  });

  it('works on one board at a time and only on a board that can be written now', async () => {
    const s = setup({ canApply: (id) => id === 'b1' });
    await s.add('1', 'o1', 'b1');
    await s.add('2', 'o2', 'b2');
    await s.queue.run();
    expect(s.upload).toHaveBeenCalledTimes(1);
    expect(await s.queue.pending('b2')).toBe(1);
    expect(await s.queue.pending('b1')).toBe(0);
    const only = setup();
    await only.add('1', 'o1', 'b1');
    await only.add('2', 'o2', 'b2');
    await only.queue.run('b2');
    expect(only.upload).toHaveBeenCalledTimes(1);
    expect(await only.queue.pending('b1')).toBe(1);
  });

  it('does not start the same record twice when runs overlap', async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const uploadStarted = new Promise<void>((resolve) => { started = resolve; });
    const s = setup({ upload: async () => { started(); await gate; return RESULT; } });
    await s.add('1');
    const first = s.queue.run();
    await uploadStarted;
    const second = s.queue.run();
    release();
    await Promise.all([first, second]);
    expect(s.apply).toHaveBeenCalledTimes(1);
    expect(await s.queue.pending()).toBe(0);
  });

  it('can forget an upload', async () => {
    const s = setup();
    await s.add('1');
    await s.queue.drop('pending:1');
    expect(await s.queue.pending()).toBe(0);
  });
});

describe('the blob cache', () => {
  const rec = (key: string, size: number, pending = false) => ({ key, blob: blob(size), mime: 'image/png', width: 1, height: 1, boardId: 'b', pending });

  it('plans which entries to drop: oldest first, never one still to be uploaded', () => {
    const records = [
      { key: 'a', at: 1, pending: false }, { key: 'b', at: 2, pending: true }, { key: 'c', at: 3, pending: false }, { key: 'd', at: 4, pending: false },
    ];
    const sizes = new Map([['a', 50], ['b', 50], ['c', 50], ['d', 50]]);
    expect(evictionPlan(records, sizes, 200)).toEqual([]);
    expect(evictionPlan(records, sizes, 120)).toEqual(['a', 'c']);
    expect(evictionPlan(records, sizes, 0)).toEqual(['a', 'c', 'd']);
    expect(BLOB_CACHE_BYTES).toBe(200 * 1024 * 1024);
  });

  it('evicts on put and marks a use on get', async () => {
    let t = 0;
    const cache = createBlobCache(memoryBackend(), { cap: 25, now: () => ++t });
    await cache.put(rec('old', 10));
    await cache.put(rec('keep', 10));
    await cache.get('old'); // used more recently than 'keep'
    await cache.put(rec('new', 10));
    expect(await cache.backend.getBlob('keep')).toBeUndefined();
    expect(await cache.backend.getBlob('old')).toBeDefined();
    expect(await cache.backend.getBlob('new')).toBeDefined();
  });

  it('rekeys pending bytes to their hash and can be cleared', async () => {
    const cache = createBlobCache(memoryBackend());
    await cache.put(rec('pending:1', 5, true));
    await cache.rekey('pending:1', 'h1');
    expect(await cache.backend.getBlob('pending:1')).toBeUndefined();
    expect(await cache.backend.getBlob('h1')).toMatchObject({ key: 'h1', pending: false });
    await cache.rekey('missing', 'h2');
    await cache.clear();
    expect(await cache.backend.listBlobs()).toEqual([]);
  });
});
