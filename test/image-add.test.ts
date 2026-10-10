import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addImages } from '../src/ui/image-add';
import type { BoardApp } from '../src/app';
import type { BaseObj } from '../src/types';
import { toast } from '../src/ui/common';
import { makeGif, makePng } from './image-fixtures';

const mocks = vi.hoisted(() => ({
  assetPut: vi.fn<(record: { key: string; blob: Blob; mime: string }) => Promise<void>>(async () => {}),
  toasts: vi.fn<(...args: unknown[]) => void>(),
}));

vi.mock('../src/board-images', () => ({ assetCache: { put: mocks.assetPut } }));
vi.mock('../src/ui/common', () => ({ toast: mocks.toasts }));

type EncodeCall = { width: number; height: number; type: string; quality?: number };
let calls: EncodeCall[];
let decoded: { width: number; height: number };
let encodedSize: (call: EncodeCall) => number;

class FakeOffscreenCanvas {
  constructor(readonly width: number, readonly height: number) {}

  getContext() {
    return { imageSmoothingQuality: 'low', drawImage: () => undefined };
  }

  async convertToBlob({ type, quality }: { type: string; quality?: number }): Promise<Blob> {
    const call = { width: this.width, height: this.height, type, quality };
    calls.push(call);
    return new Blob([new Uint8Array(encodedSize(call))], { type });
  }
}

function app(hostedWorkspace: boolean) {
  const added: BaseObj[] = [];
  const enqueued: unknown[] = [];
  const target = {
    hostedWorkspace,
    readOnly: false,
    r: { viewport: () => ({ x: 0, y: 0, w: 1000, h: 600 }) },
    conn: { id: 'b1' },
    user: { id: 'u1' },
    images: { queue: { enqueue: async (record: unknown) => { enqueued.push(record); }, run: async () => {} } },
    store: {
      undo: { stopCapturing: () => undefined },
      topZs: (count: number) => Array.from({ length: count }, (_, index) => `z${index}`),
      transact: (fn: () => void) => fn(),
      create: (object: BaseObj) => added.push(object),
    },
    setSelection: () => undefined,
  } as unknown as BoardApp;
  return { app: target, added, enqueued };
}

function pngFile(bytes: number, opaque: boolean): Blob {
  const header = Buffer.from(makePng());
  if (opaque) header[25] = 2;
  return new Blob([header, new Uint8Array(bytes - header.length)], { type: 'image/png' });
}

describe('hosted image preparation', () => {
  beforeEach(() => {
    calls = [];
    decoded = { width: 2000, height: 1400 };
    encodedSize = () => 1_500_000;
    mocks.assetPut.mockClear();
    mocks.toasts.mockClear();
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    vi.stubGlobal('createImageBitmap', async () => ({ ...decoded, close: () => undefined }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it('takes an opaque 2.5 MB PNG under 900 KB through its JPEG step', async () => {
    encodedSize = ({ type, quality }) => type === 'image/jpeg' && quality === 0.85 ? 800_000 : 1_500_000;
    const { app: target, added, enqueued } = app(true);

    expect(await addImages(target, [pngFile(2_500_000, true)])).toBe(1);

    expect(added[0]).toMatchObject({ type: 'image', mime: 'image/jpeg', nw: 2000, nh: 1400 });
    expect(mocks.assetPut).toHaveBeenCalledWith(expect.objectContaining({ blob: expect.any(Blob), mime: 'image/jpeg' }));
    const cached = mocks.assetPut.mock.calls[0][0];
    expect(cached.blob.size).toBe(800_000);
    expect(enqueued).toEqual([expect.objectContaining({ bytes: 800_000 })]);
    expect(calls.filter((call) => call.type === 'image/jpeg')).toHaveLength(2); // the normal plan and the ladder
    expect(mocks.toasts).not.toHaveBeenCalled();
  });

  it('shrinks a transparent PNG by reducing its dimensions', async () => {
    encodedSize = ({ width }) => width > 1000 ? 1_500_000 : 800_000;
    const { app: target, added } = app(true);

    expect(await addImages(target, [pngFile(2_500_000, false)])).toBe(1);

    expect(added[0]).toMatchObject({ type: 'image', mime: 'image/png' });
    expect(added[0].nw).toBeLessThan(2000);
    expect(mocks.assetPut.mock.calls[0][0].blob.size).toBe(800_000);
    expect(calls.some((call) => call.width < 2000)).toBe(true);
    expect(calls.every((call) => call.type === 'image/png')).toBe(true);
  });

  it.each([1, 2])('adds %i oversized GIF(s) untouched and shows one action warning', async (count) => {
    const gif = () => new Blob([makeGif(), new Uint8Array(1_200_000)], { type: 'image/gif' });
    const { app: target, added, enqueued } = app(true);

    expect(await addImages(target, Array.from({ length: count }, gif))).toBe(count);

    expect(added[0].mime).toBe('image/gif');
    expect(mocks.assetPut.mock.calls.every(([record]) => record.blob.size === 1_200_000 + makeGif().length)).toBe(true);
    expect(enqueued).toHaveLength(count);
    expect(enqueued).toEqual(Array.from({ length: count }, () => expect.objectContaining({ bytes: 1_200_000 + makeGif().length })));
    expect(calls).toEqual([]);
    expect(mocks.toasts).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(
      count === 1
        ? '1 image is over 1 MB and may not upload to this workspace yet. Use a smaller image.'
        : '2 images are over 1 MB and may not upload to this workspace yet. Use smaller images.',
      8000,
    );
  });

  it('keeps the normal plan on a self-hosted instance without running the ladder', async () => {
    encodedSize = ({ type, quality }) => type === 'image/jpeg' && quality === 0.85 ? 800_000 : 1_500_000;
    const { app: target, added, enqueued } = app(false);

    expect(await addImages(target, [pngFile(2_500_000, true)])).toBe(1);

    expect(added[0]).toMatchObject({ type: 'image', mime: 'image/png' });
    expect(mocks.assetPut.mock.calls[0][0].blob.size).toBe(1_500_000);
    expect(enqueued).toEqual([expect.objectContaining({ bytes: 1_500_000 })]);
    expect(calls).toHaveLength(2);
    expect(mocks.toasts).not.toHaveBeenCalled();
  });
});
