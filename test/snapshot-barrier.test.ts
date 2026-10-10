import { describe, expect, it, vi } from 'vitest';
import { openDirectory } from '../server/directory.mjs';
import { createSnapshotBarrier, testCaptureDelayMs } from '../server/snapshot-barrier.mjs';

describe('the snapshot write barrier', () => {
  it('holds writers until capture finishes, then applies each queued write in order', async () => {
    const barrier = createSnapshotBarrier({ maxHoldMs: 5000 });
    let enterCapture!: () => void;
    let finishCapture!: () => void;
    const captureStarted = new Promise<void>((resolve) => { enterCapture = resolve; });
    const captureGate = new Promise<void>((resolve) => { finishCapture = resolve; });
    const steps: string[] = [];
    const snapshot = barrier.withSnapshot({
      prepare: () => { steps.push('prepare'); },
      capture: async () => {
        steps.push('capture');
        enterCapture();
        await captureGate;
        return 'captured';
      },
    });
    await captureStarted;

    const applied: number[] = [];
    const first = barrier.runWriter(() => applied.push(1));
    const second = barrier.runWriter(() => applied.push(2));
    expect(applied).toEqual([]);

    finishCapture();
    await expect(snapshot).resolves.toMatchObject({ value: 'captured' });
    await Promise.all([first, second]);
    expect(applied).toEqual([1, 2]);
    expect(steps).toEqual(['prepare', 'capture']);
    expect(barrier.active).toBe(false);
  });

  it('lets an admitted async writer finish its directory writes while the barrier drains it', async () => {
    const barrier = createSnapshotBarrier({ maxHoldMs: 5000 });
    const directory = openDirectory(':memory:', { snapshotBarrier: barrier });
    let enterWriter!: () => void;
    let finishWriter!: () => void;
    const writerEntered = new Promise<void>((resolve) => { enterWriter = resolve; });
    const writerGate = new Promise<void>((resolve) => { finishWriter = resolve; });
    try {
      const writer = barrier.runWriter(async () => {
        enterWriter();
        await writerGate;
        expect(barrier.writesAllowed).toBe(true);
        directory.setSetting('snapshot.point', 'writer-finished');
      });
      await writerEntered;

      const snapshot = barrier.withSnapshot({ capture: () => directory.getSetting('snapshot.point') });
      expect(barrier.active).toBe(true);
      finishWriter();

      await expect(snapshot).resolves.toMatchObject({ value: 'writer-finished' });
      await writer;
      expect(directory.getSetting('snapshot.point')).toBe('writer-finished');
    } finally {
      directory.close();
    }
  });

  it('aborts a capture at the hold limit and releases queued writers', async () => {
    vi.useFakeTimers();
    try {
      const barrier = createSnapshotBarrier({ maxHoldMs: 100 });
      let captureStarted!: () => void;
      const started = new Promise<void>((resolve) => { captureStarted = resolve; });
      const snapshot = barrier.withSnapshot({
        capture: ({ signal }) => {
          captureStarted();
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      });
      const settledSnapshot = snapshot.then(
        () => ({ error: null as unknown }),
        (error: unknown) => ({ error }),
      );
      await started;

      let applied = false;
      const writer = barrier.runWriter(() => { applied = true; });
      expect(applied).toBe(false);
      await vi.advanceTimersByTimeAsync(100);

      await expect(settledSnapshot).resolves.toMatchObject({ error: expect.objectContaining({ code: 'snapshot_timeout' }) });
      await writer;
      expect(applied).toBe(true);
      expect(barrier.active).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('stopping a snapshot', () => {
  it('releases the writers at once when the outer signal aborts, even if the copy ignores its abort signal', async () => {
    const barrier = createSnapshotBarrier({ maxHoldMs: 60_000 });
    const stop = new AbortController();
    const order: string[] = [];
    const snapshot = barrier.withSnapshot({ signal: stop.signal, capture: () => new Promise(() => {}) }).catch((err) => order.push(`snapshot:${err.name}`));
    await Promise.resolve();
    expect(barrier.active).toBe(true);
    const writer = barrier.runWriter(() => order.push('write'));
    expect(order).toEqual([]);
    stop.abort();
    await snapshot;
    await writer;
    expect(barrier.active).toBe(false);
    expect(order).toContain('write');
  });
});

describe('the test-only capture delay', () => {
  it('is zero when unset', () => {
    expect(testCaptureDelayMs({})).toBe(0);
    expect(testCaptureDelayMs({ NODE_ENV: 'production', TABULA_TEST_SNAPSHOT_CAPTURE_DELAY_MS: '  ' })).toBe(0);
  });

  it('refuses to work unless NODE_ENV is test', () => {
    expect(() => testCaptureDelayMs({ TABULA_TEST_SNAPSHOT_CAPTURE_DELAY_MS: '500' })).toThrow('only available when NODE_ENV=test');
    expect(() => testCaptureDelayMs({ NODE_ENV: 'production', TABULA_TEST_SNAPSHOT_CAPTURE_DELAY_MS: '500' })).toThrow('only available when NODE_ENV=test');
  });

  it('accepts a whole number of milliseconds under test and rejects anything else', () => {
    expect(testCaptureDelayMs({ NODE_ENV: 'test', TABULA_TEST_SNAPSHOT_CAPTURE_DELAY_MS: '500' })).toBe(500);
    for (const bad of ['0', '-1', '1.5', 'abc', '60001']) {
      expect(() => testCaptureDelayMs({ NODE_ENV: 'test', TABULA_TEST_SNAPSHOT_CAPTURE_DELAY_MS: bad })).toThrow('must be an integer');
    }
  });
});
