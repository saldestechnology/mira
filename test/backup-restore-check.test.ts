import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDirClient } from '../server/backup-dir-client.mjs';
import { deriveKeys, formatManifestName, objectIdOf, seal } from '../server/backup.mjs';
import { main as restoreMain, restoreCheck, structureCheck } from '../deploy/backup-puller/restore-check.mjs';

const runRestoreMain: (options: any) => Promise<number> = restoreMain;
const runRestoreCheck: (options: any) => Promise<any> = restoreCheck;
const runStructureCheck: (options: any) => Promise<any> = structureCheck;

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const now = () => NOW;
const master = Buffer.from('ab'.repeat(32), 'hex');
let tempRoot: string;
let store: string;
let client: ReturnType<typeof createDirClient>;
let manifest: string;
let objectId: string;
let plaintext: Buffer;

async function seedStore() {
  const keys = deriveKeys(master);
  plaintext = Buffer.from('standalone restore checker reads real Tabula ciphertext');
  objectId = objectIdOf(plaintext, keys);
  manifest = formatManifestName(NOW);
  const body = Buffer.from(JSON.stringify({
    version: 1,
    keyId: keys.keyId,
    createdAt: new Date(NOW).toISOString(),
    appVersion: 'test',
    files: [{ path: 'directory.sqlite', size: plaintext.length, objectId }],
    totals: { files: 1, bytes: plaintext.length },
  }));
  await client.put(`tabula/objects/${objectId}`, seal(plaintext, `obj:${objectId}`, keys));
  await client.put(`tabula/manifests/${manifest}`, seal(body, `manifest:${manifest}`, keys));
}

beforeEach(async () => {
  tempRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tabula-restore-check-'));
  store = path.join(tempRoot, 'studio');
  client = createDirClient({ dir: store });
  await seedStore();
});

afterEach(async () => {
  await fs.promises.rm(tempRoot, { recursive: true, force: true });
});

describe('standalone restore check against engine-sealed files', () => {
  it('decrypts the newest real manifest and every referenced object', async () => {
    const result = await runRestoreCheck({ store, key: master, now });
    expect(result).toEqual({ ok: true, manifest, files: 1, bytes: plaintext.length, problems: [] });
  });

  it('fails on a flipped ciphertext byte', async () => {
    const key = `tabula/objects/${objectId}`;
    const sealed = await client.get(key);
    if (!sealed) throw new Error('seeded object missing');
    sealed[20] ^= 0x01;
    await client.put(key, sealed);
    const result = await runRestoreCheck({ store, key: master, now });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(['directory.sqlite:integrity_error']);
  });

  it('fails when given the wrong key', async () => {
    const result = await runRestoreCheck({ store, key: Buffer.alloc(32, 0x33), now });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(['unknown_key']);
  });

  it('reports a missing referenced object', async () => {
    await client.del(`tabula/objects/${objectId}`);
    const result = await runRestoreCheck({ store, key: master, now });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(['directory.sqlite:object_missing']);
  });

  it('reads the key from the named environment variable and prints one JSON summary line', async () => {
    const output: string[] = [];
    const code = await runRestoreMain({
      argv: ['--store', store, '--key-env', 'LOCAL_RESTORE_KEY'],
      env: { LOCAL_RESTORE_KEY: master.toString('hex') },
      now,
      write: (line: string) => output.push(line),
    });
    expect(code).toBe(0);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0])).toEqual({ ok: true, manifest, files: 1, bytes: plaintext.length, problems: [] });
    expect(output[0]).not.toContain(master.toString('hex'));
  });

  it('checks sealed names, header lengths and manifest age without a key', async () => {
    const good = await runStructureCheck({ store, now, maxAgeHours: 26 });
    expect(good.ok).toBe(true);
    expect(good.manifest).toBe(manifest);
    expect(good.files).toBe(1);
    expect(good.bytes).toBeGreaterThan(plaintext.length);

    const oldManifest = formatManifestName(NOW - 27 * 60 * 60 * 1000);
    const keys = deriveKeys(master);
    const oldBody = Buffer.from(JSON.stringify({ version: 1, keyId: keys.keyId, createdAt: new Date(NOW).toISOString(), files: [], totals: { files: 0, bytes: 0 } }));
    await client.put(`tabula/manifests/${oldManifest}`, seal(oldBody, `manifest:${oldManifest}`, keys));
    await client.del(`tabula/manifests/${manifest}`);
    const old = await runStructureCheck({ store, now, maxAgeHours: 26 });
    expect(old.ok).toBe(false);
    expect(old.problems).toContain('manifest_too_old');
  });
});
