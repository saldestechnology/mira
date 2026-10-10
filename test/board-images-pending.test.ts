import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardImages } from '../src/board-images';
import type { QueueDeps, UploadRecord } from '../src/asset-store';
import type { BoardApp } from '../src/app';
import type { BaseObj } from '../src/types';
import { toast } from '../src/ui/common';

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  deps: undefined as unknown,
  queue: {
    run: vi.fn<(boardId?: string) => Promise<void>>(async () => {}),
    retryBlocked: vi.fn<(boardId?: string) => Promise<void>>(async () => {}),
    state: vi.fn<(asset: string) => Promise<'queued' | 'lost' | 'refused' | 'toobig' | undefined>>(async () => undefined),
    enqueue: vi.fn<(rec: unknown) => Promise<void>>(async () => {}),
    pending: vi.fn<(boardId?: string) => Promise<number>>(async () => 0),
    drop: vi.fn<(id: string) => Promise<void>>(async () => {}),
  },
}));

vi.mock('../src/asset-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/asset-store')>();
  return {
    ...actual,
    createUploadQueue: vi.fn<(deps: unknown) => typeof mocks.queue>((deps) => {
      mocks.deps = deps;
      return mocks.queue;
    }),
  };
});

vi.mock('../src/ui/common', () => ({ toast: vi.fn<(...args: unknown[]) => void>() }));

function makeApp(hostedWorkspace = false) {
  const lifetime = new AbortController();
  const app = {
    conn: { id: 'b1', onStatus: vi.fn<(listener: (status: string) => void) => () => void>(() => () => {}) },
    r: { invalidateObjects: vi.fn<(ids: string[]) => void>(), imageState: undefined },
    readOnly: false,
    hostedWorkspace,
    lifetime,
    store: { cache: new Map() },
  } as unknown as BoardApp;
  return { app, lifetime };
}

describe('BoardImages pending uploads', () => {
  beforeEach(() => {
    mocks.order.length = 0;
    mocks.deps = undefined;
    mocks.queue.run.mockReset().mockImplementation(async (boardId) => { mocks.order.push(`run:${boardId}`); });
    mocks.queue.retryBlocked.mockReset().mockImplementation(async (boardId) => { mocks.order.push(`retry:${boardId}`); });
    mocks.queue.state.mockReset().mockResolvedValue(undefined);
    mocks.queue.enqueue.mockReset().mockResolvedValue(undefined);
    mocks.queue.pending.mockReset().mockResolvedValue(0);
    mocks.queue.drop.mockReset().mockResolvedValue(undefined);
    vi.mocked(toast).mockClear();
    vi.stubGlobal('window', {
      addEventListener: vi.fn<(...args: unknown[]) => void>(),
      setInterval: vi.fn<(...args: unknown[]) => number>(() => 1),
      clearInterval: vi.fn<(...args: unknown[]) => void>(),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('makes refused records retryable before the first queue pass', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mocks.queue.retryBlocked.mockImplementation(async (boardId) => {
      mocks.order.push(`retry:${boardId}`);
      await gate;
      mocks.order.push('retry-ready');
    });
    const { app, lifetime } = makeApp();

    new BoardImages(app);
    expect(mocks.order).toEqual(['retry:b1']);
    release();
    await vi.waitFor(() => expect(mocks.order).toEqual(['retry:b1', 'retry-ready', 'run:b1']));
    lifetime.abort();
  });

  it('shows one combined toast for the lost images reported by a pass', async () => {
    const { app, lifetime } = makeApp();
    new BoardImages(app);
    const onLost = (mocks.deps as QueueDeps).onLost;
    const record = (id: string): UploadRecord => ({ id, boardId: 'b1', objectId: `o-${id}`, hash: 'h', tries: 0, nextAt: 0, at: 0, lost: true, notified: true });

    onLost?.(record('pending:1'));
    onLost?.(record('pending:2'));
    await Promise.resolve();

    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('2 images could not be uploaded because this browser no longer has them. Add them again.', 8000);
    onLost?.(record('pending:3'));
    await Promise.resolve();
    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenLastCalledWith('An image could not be uploaded because this browser no longer has it. Add it again.', 8000);
    lifetime.abort();
  });

  it('uses the hosted size notice and distinguishes real 413s from repeated retry failures', async () => {
    const { app, lifetime } = makeApp(true);
    new BoardImages(app);
    const deps = mocks.deps as QueueDeps;
    expect(deps.hostedWorkspace).toBe(true);
    deps.onTooBig?.({ id: 'pending:large', boardId: 'b1', objectId: 'o1', hash: 'h', tries: 3, nextAt: 0, at: 0, sizeBlocked: true, refused: 413, notified: true });
    expect(toast).toHaveBeenLastCalledWith('This image is over 1 MB, which is the upload limit for now. Use a smaller image.', 8000);
    deps.onRefused?.({ id: 'pending:redirect', boardId: 'b1', objectId: 'o2', hash: 'h', tries: 5, nextAt: 0, at: 0 }, 307, '');
    expect(toast).toHaveBeenLastCalledWith('An image could not be uploaded (error 307). It will be tried again when you open this board.', 6000);
    deps.onRefused?.({ id: 'pending:large', boardId: 'b1', objectId: 'o3', hash: 'h', tries: 0, nextAt: 0, at: 0 }, 413, 'payload_too_large');
    expect(toast).toHaveBeenLastCalledWith('This image is over 1 MB, which is the upload limit for now. Use a smaller image.', 6000);
    lifetime.abort();
  });

  it('keeps the server-size message on a self-hosted 413', async () => {
    const { app, lifetime } = makeApp(false);
    new BoardImages(app);
    const deps = mocks.deps as QueueDeps;
    expect(deps.hostedWorkspace).toBe(false);
    deps.onRefused?.({ id: 'pending:large', boardId: 'b1', objectId: 'o1', hash: 'h', tries: 0, nextAt: 0, at: 0 }, 413, 'payload_too_large');
    expect(toast).toHaveBeenCalledWith('An image you added is too large for this server.', 6000);
    lifetime.abort();
  });

  it('passes the local queue state to the image loader', async () => {
    mocks.queue.state.mockResolvedValue('refused');
    const { app, lifetime } = makeApp();
    new BoardImages(app);
    const object: BaseObj = { id: 'o1', type: 'image', x: 0, y: 0, w: 417, h: 100, rotation: 0, z: 'a', asset: 'pending:1', mime: 'image/png', nw: 417, nh: 100 };
    const imageState = (app.r as unknown as { imageState: (o: BaseObj) => { kind: string; why?: string } }).imageState;

    expect(imageState(object)).toEqual({ kind: 'loading' });
    await vi.waitFor(() => expect(imageState(object)).toEqual({ kind: 'failed', why: 'lost' }));
    expect(mocks.queue.state).toHaveBeenCalledWith('pending:1');
    lifetime.abort();
  });
});
