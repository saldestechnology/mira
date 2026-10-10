import { afterEach, describe, expect, it } from 'vitest';
import { harness } from './backup-harness';

let h: Awaited<ReturnType<typeof harness>> | undefined;

afterEach(async () => {
  await h?.close();
});

describe('the backup test harness', () => {
  it('gives every backup test the largest snapshot hold, so a loaded runner cannot abandon a copy', async () => {
    h = await harness();
    expect(h.config().snapshotMaxHoldSeconds).toBe(60);
  });

  it('keeps a hold a test names for itself', async () => {
    h = await harness({ env: { TABULA_BACKUP_SNAPSHOT_MAX_HOLD_SECONDS: '5' } });
    expect(h.config().snapshotMaxHoldSeconds).toBe(5);
  });
});
