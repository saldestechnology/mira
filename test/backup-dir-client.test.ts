import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BackupError, parseListXml } from '../server/backup.mjs';
import { createDirClient } from '../server/backup-dir-client.mjs';

const roots: string[] = [];

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-backup-dir-client-'));
  roots.push(root);
  return { root, client: createDirClient({ dir: path.join(root, 'export') }) };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('the directory backup client', () => {
  it('puts, gets, heads, lists and deletes sealed bytes', async () => {
    const { client } = setup();
    expect(Object.keys(client).sort()).toEqual(['createReadStream', 'del', 'get', 'head', 'list', 'put']);
    const bytes = Buffer.from('sealed bytes');
    await client.put('tabula/objects/one', bytes);

    expect(await client.get('tabula/objects/one')).toEqual(bytes);
    expect(await client.head('tabula/objects/one')).toEqual({ size: bytes.length });
    expect(await client.head('tabula/objects/missing')).toBeNull();
    const listed = await client.list('tabula/objects/');
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ key: 'tabula/objects/one', size: bytes.length, lastModified: expect.any(Number) });
    expect(Object.keys(listed[0]).sort()).toEqual(['key', 'lastModified', 'size']);
    expect(parseListXml('<ListBucketResult><Contents><Key>tabula/objects/one</Key><LastModified>2026-10-08T10:00:00.000Z</LastModified><Size>12</Size></Contents></ListBucketResult>').contents[0]).toMatchObject({
      key: listed[0].key,
      size: listed[0].size,
      lastModified: expect.any(Number),
    });

    await client.del('tabula/objects/one');
    await client.del('tabula/objects/missing');
    expect(await client.head('tabula/objects/one')).toBeNull();
    const notFound = await client.get('tabula/objects/one').catch((err) => err);
    expect(notFound).toBeInstanceOf(BackupError);
    expect(notFound).toMatchObject({ code: 'not_found', message: 'The backup file is not in the bucket', status: 404 });
  });

  it('sorts recursive listings by key and omits its temporary files', async () => {
    const { client } = setup();
    await client.put('prefix/z/item', Buffer.from('z'));
    await client.put('prefix/a/item', Buffer.from('a'));
    const listed = await client.list('prefix/');
    expect(listed.map((item) => item.key)).toEqual(['prefix/a/item', 'prefix/z/item']);
  });

  it('does not replace an existing file or leave a partial file when a write fails', async () => {
    const { root, client } = setup();
    await client.put('prefix/file', Buffer.from('complete'));
    await expect(client.put('prefix/file', {} as never)).rejects.toBeInstanceOf(TypeError);
    expect(await client.get('prefix/file')).toEqual(Buffer.from('complete'));
    expect(await client.list('prefix/')).toHaveLength(1);
    expect(fs.readdirSync(path.join(root, 'export', 'prefix'))).toEqual(['file']);
  });

  it('refuses keys that can escape or do not name a single plain path', async () => {
    const { client } = setup();
    const invalid = ['', '../outside', 'a/../b', '/absolute', 'a\\b', 'a//b', 'a/', '.', './a', 'a/./b', 'a?b', 'é'];
    for (const key of invalid) {
      await expect(client.put(key, Buffer.from('x'))).rejects.toMatchObject({ name: 'BackupError', code: 'invalid_path' });
    }
  });

  it('refuses symlink path components', async () => {
    const { root, client } = setup();
    const outside = path.join(root, 'outside');
    const linked = path.join(root, 'export', 'tabula', 'objects');
    fs.mkdirSync(path.dirname(linked), { recursive: true });
    fs.mkdirSync(outside);
    try {
      fs.symlinkSync(outside, linked, 'dir');
    } catch (err) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes((err as NodeJS.ErrnoException).code ?? '')) return;
      throw err;
    }
    await expect(client.put('tabula/objects/escape', Buffer.from('x'))).rejects.toMatchObject({ name: 'BackupError', code: 'invalid_path' });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('refuses a file over maxBytes', async () => {
    const { client } = setup();
    await client.put('prefix/file', Buffer.from('too large'));
    await expect(client.get('prefix/file', { maxBytes: 3 })).rejects.toMatchObject({ name: 'BackupError', code: 'too_large' });
  });

  it.skipIf(process.platform === 'win32')('creates directories with mode 0700 and files with mode 0600', async () => {
    const { root, client } = setup();
    await client.put('prefix/nested/file', Buffer.from('bytes'));
    expect(fs.statSync(path.join(root, 'export')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(root, 'export', 'prefix')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(root, 'export', 'prefix', 'nested')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(root, 'export', 'prefix', 'nested', 'file')).mode & 0o777).toBe(0o600);
  });

  it('removes stale temporary files on a later put in the same directory', async () => {
    const { root, client } = setup();
    const parent = path.join(root, 'export', 'prefix');
    fs.mkdirSync(parent, { recursive: true });
    const stale = path.join(parent, '.old.tmp-0123456789abcdef');
    fs.writeFileSync(stale, 'unfinished');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);

    expect(await client.list('prefix/')).toEqual([]);
    await client.put('prefix/new', Buffer.from('done'));
    expect(fs.existsSync(stale)).toBe(false);
  });

  it('uses the backup stopped error for every method after abort', async () => {
    const { root } = setup();
    const controller = new AbortController();
    const stopped = createDirClient({ dir: path.join(root, 'not-created'), signal: controller.signal });
    controller.abort();
    const calls = [
      () => stopped.put('key', Buffer.alloc(0)),
      () => stopped.get('key'),
      () => stopped.head('key'),
      () => stopped.del('key'),
      () => stopped.list('prefix/'),
    ];
    for (const call of calls) {
      const err = await call().catch((failure) => failure);
      expect(err).toBeInstanceOf(BackupError);
      expect(err).toMatchObject({ code: 'aborted', message: 'The backup was stopped' });
    }
  });
});
