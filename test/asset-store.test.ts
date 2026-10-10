import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOVE_TRACKER_MIGRATION } from './tracker-rewind';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { AssetError, ASSETS_MIGRATION, HASH_RE, assetHeaders, createAssetIndex, createAssetStore, createJsonAssetIndex, createUploadLimiter, readBytes } from '../server/assets.mjs';
import { parseSize } from '../server/config.mjs';
import { MIGRATIONS, openDirectory } from '../server/directory.mjs';
import { createBlobCache, memoryBackend } from '../src/asset-store';
import { SECRET, containsSecret, makeGif, makeJpeg, makePng, makeWebp } from './image-fixtures';

// docs/images.md, Assets and Quota: the store, both forms of its index, the limiter and the body reader.

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-store-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const sqliteIndex = () => {
  const db = new DatabaseSync(':memory:');
  db.exec(ASSETS_MIGRATION);
  return createAssetIndex({
    get: (sql: string, ...args: unknown[]) => db.prepare(sql).get(...(args as never[])) as never,
    all: (sql: string, ...args: unknown[]) => db.prepare(sql).all(...(args as never[])) as never,
    run: (sql: string, ...args: unknown[]) => db.prepare(sql).run(...(args as never[])) as never,
  });
};
const LIMITS = { maxBytes: 10 * 1024 * 1024, boardQuota: 1024 * 1024, totalQuota: 0 };
const forms = [
  ['the directory table', () => sqliteIndex()],
  ['the JSON file of open mode', () => createJsonAssetIndex(path.join(dir, 'assets'))],
] as const;

describe.each(forms)('the store over %s', (_name, makeIndex) => {
  const store = (limits = LIMITS) => createAssetStore({ dir: path.join(dir, 'assets'), index: makeIndex(), limits });

  it('stores stripped bytes under their own hash and returns the row', () => {
    const s = store();
    const dirty = makeJpeg({ exif: true, comment: true });
    const { row, created } = s.put({ boardId: 'b1', bytes: dirty, declaredType: 'image/jpeg', userId: 'u1' });
    expect(created).toBe(true);
    expect(HASH_RE.test(row.hash)).toBe(true);
    expect(row).toMatchObject({ boardId: 'b1', mime: 'image/jpeg', width: 4, height: 3, createdBy: 'u1' });
    const file = path.join(dir, 'assets', row.hash.slice(0, 2), row.hash);
    const onDisk = fs.readFileSync(file);
    expect(sha(onDisk)).toBe(row.hash);
    expect(row.bytes).toBe(onDisk.length);
    expect(containsSecret(onDisk)).toBe(false);
    expect(onDisk.includes(Buffer.from(SECRET))).toBe(false);
    expect(fs.readdirSync(path.join(dir, 'assets', 'tmp'))).toEqual([]);
  });

  it('stores the same content once for a board and answers created: false the second time', () => {
    const s = store();
    const png = makePng();
    const first = s.put({ boardId: 'b1', bytes: png, declaredType: 'image/png' });
    const again = s.put({ boardId: 'b1', bytes: png, declaredType: 'image/png' });
    expect(again.created).toBe(false);
    expect(again.row.hash).toBe(first.row.hash);
    expect(s.boardBytes('b1')).toBe(first.row.bytes);
  });

  it('shares one file between boards but gives each its own row and its own count', () => {
    const s = store();
    const png = makePng();
    const a = s.put({ boardId: 'b1', bytes: png, declaredType: 'image/png' }).row;
    const b = s.put({ boardId: 'b2', bytes: png, declaredType: 'image/png' }).row;
    expect(a.hash).toBe(b.hash);
    expect(s.boardBytes('b2')).toBe(b.bytes);
    expect(fs.readdirSync(path.join(dir, 'assets', a.hash.slice(0, 2))).filter((n) => n === a.hash)).toHaveLength(1);
  });

  it('reads only through a board that owns a row', () => {
    const s = store();
    const { row } = s.put({ boardId: 'b1', bytes: makeGif(), declaredType: 'image/gif' });
    expect(s.read('b1', row.hash)?.bytes.length).toBe(row.bytes);
    expect(s.read('b2', row.hash)).toBeNull();
    expect(s.stat('b2', row.hash)).toBeNull();
    expect(s.read('b1', '../../etc/passwd')).toBeNull();
    expect(s.read('b1', row.hash.toUpperCase())).toBeNull();
    expect(s.read('b1', row.hash.slice(1))).toBeNull();
  });

  it('claims content for a board when the caller can read a board that owns it, and not otherwise', () => {
    const s = store();
    const { row } = s.put({ boardId: 'b1', bytes: makeWebp(), declaredType: 'image/webp' });
    expect(s.claim({ boardId: 'b2', hash: row.hash, mayReadFrom: () => false })).toBeNull();
    expect(s.read('b2', row.hash)).toBeNull();
    const claimed = s.claim({ boardId: 'b2', hash: row.hash, mayReadFrom: (id: string) => id === 'b1', userId: 'u2' });
    expect(claimed?.created).toBe(true);
    expect(claimed?.row).toMatchObject({ boardId: 'b2', hash: row.hash, mime: 'image/webp', createdBy: 'u2' });
    expect(s.read('b2', row.hash)).not.toBeNull();
    expect(s.claim({ boardId: 'b2', hash: row.hash, mayReadFrom: () => false })?.created).toBe(false);
    expect(s.claim({ boardId: 'b3', hash: 'z'.repeat(64), mayReadFrom: () => true })).toBeNull();
    expect(s.claim({ boardId: 'b3', hash: 'a'.repeat(64), mayReadFrom: () => true })).toBeNull();
  });

  it('refuses a claim that would pass the quota', () => {
    const png = makePng();
    const size = createAssetStore({ dir: path.join(dir, 'x'), index: sqliteIndex(), limits: LIMITS }).put({ boardId: 'q', bytes: png, declaredType: 'image/png' }).row.bytes;
    const s = store({ ...LIMITS, boardQuota: size + 10 });
    const { row } = s.put({ boardId: 'b1', bytes: png, declaredType: 'image/png' });
    s.put({ boardId: 'b2', bytes: makePng({ width: 9 }), declaredType: 'image/png' });
    expect(() => s.claim({ boardId: 'b2', hash: row.hash, mayReadFrom: () => true })).toThrow(expect.objectContaining({ status: 402, code: 'storage_full' }));
  });

  it('enforces the per-board quota and the instance quota, counting a repeat as free', () => {
    const one = makePng({ width: 4 });
    const two = makePng({ width: 5 });
    const size = createAssetStore({ dir: path.join(dir, 'probe'), index: sqliteIndex(), limits: LIMITS }).put({ boardId: 'probe', bytes: one, declaredType: 'image/png' }).row.bytes;
    const s = store({ ...LIMITS, boardQuota: size + size / 2 });
    s.put({ boardId: 'b1', bytes: one, declaredType: 'image/png' });
    expect(s.put({ boardId: 'b1', bytes: one, declaredType: 'image/png' }).created).toBe(false);
    expect(() => s.put({ boardId: 'b1', bytes: two, declaredType: 'image/png' })).toThrow(expect.objectContaining({ status: 402, code: 'storage_full' }));
  });

  it.each([
    ['an empty upload', Buffer.alloc(0), 'image/png', 400, 'bad_image'],
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml', 400, 'unsupported_type'],
    ['HTML', Buffer.from('<html></html>'), 'text/html', 400, 'unsupported_type'],
    ['no declared type', makePng(), undefined, 400, 'unsupported_type'],
    ['a JPEG declared as PNG', makeJpeg(), 'image/png', 400, 'bad_image'],
    ['text declared as PNG', Buffer.from('this is not an image, said the file'), 'image/png', 400, 'bad_image'],
    ['a PNG with a broken checksum', makePng({ badCrc: true }), 'image/png', 400, 'bad_image'],
    ['a truncated JPEG', makeJpeg({ truncate: true }), 'image/jpeg', 400, 'bad_image'],
    ['a huge claimed size', makePng({ width: 40000, height: 40000 }), 'image/png', 413, 'too_many_pixels'],
    ['a zero width', makePng({ width: 0 }), 'image/png', 413, 'too_many_pixels'],
  ])('refuses %s', (_label, bytes, type, status, code) => {
    expect(() => store().put({ boardId: 'b1', bytes, declaredType: type })).toThrow(expect.objectContaining({ status, code }));
    expect(fs.existsSync(path.join(dir, 'assets', 'tmp')) ? fs.readdirSync(path.join(dir, 'assets', 'tmp')) : []).toEqual([]);
  });

  it('refuses a file over the byte cap before looking inside it', () => {
    expect(() => store({ ...LIMITS, maxBytes: 50 }).put({ boardId: 'b1', bytes: makePng(), declaredType: 'image/png' })).toThrow(expect.objectContaining({ status: 413, code: 'payload_too_large' }));
  });

  it('accepts a declared type with parameters and capitals', () => {
    expect(store().put({ boardId: 'b1', bytes: makePng(), declaredType: 'Image/PNG; charset=binary' }).created).toBe(true);
  });
});

describe('the instance quota', () => {
  it('counts each distinct file once across boards', () => {
    const one = makePng({ width: 4 });
    const size = createAssetStore({ dir: path.join(dir, 'probe'), index: sqliteIndex(), limits: LIMITS }).put({ boardId: 'p', bytes: one, declaredType: 'image/png' }).row.bytes;
    const capped = createAssetStore({ dir: path.join(dir, 'assets'), index: sqliteIndex(), limits: { ...LIMITS, totalQuota: size * 2 + 20 } });
    capped.put({ boardId: 'c1', bytes: one, declaredType: 'image/png' });
    expect(capped.put({ boardId: 'c2', bytes: one, declaredType: 'image/png' }).created).toBe(true); // the same file again: free
    capped.put({ boardId: 'c2', bytes: makePng({ width: 6 }), declaredType: 'image/png' });
    expect(() => capped.put({ boardId: 'c3', bytes: makePng({ width: 7 }), declaredType: 'image/png' })).toThrow(expect.objectContaining({ status: 402, code: 'storage_full' }));
  });
});

describe('the JSON index of open mode', () => {
  it('survives a restart and ignores an unreadable file', () => {
    const where = path.join(dir, 'assets');
    const s = createAssetStore({ dir: where, index: createJsonAssetIndex(where), limits: LIMITS });
    const { row } = s.put({ boardId: 'b1', bytes: makePng(), declaredType: 'image/png' });
    const again = createAssetStore({ dir: where, index: createJsonAssetIndex(where), limits: LIMITS });
    expect(again.read('b1', row.hash)?.row).toEqual(row);
    fs.writeFileSync(path.join(where, 'index.json'), '{not json');
    const broken = createAssetStore({ dir: where, index: createJsonAssetIndex(where), limits: LIMITS });
    expect(broken.read('b1', row.hash)).toBeNull();
    expect(broken.put({ boardId: 'b1', bytes: makePng(), declaredType: 'image/png' }).created).toBe(true);
  });
});

describe('createUploadLimiter', () => {
  it('allows 60 uploads and 20 MB a minute per key, then starts again', () => {
    let t = 1_000_000;
    const limiter = createUploadLimiter({ now: () => t });
    for (let i = 0; i < 60; i++) expect(limiter.take('u1', 10)).toBe(true);
    expect(limiter.take('u1', 10)).toBe(false);
    expect(limiter.take('u2', 10)).toBe(true);
    t += 60_000;
    expect(limiter.take('u1', 10)).toBe(true);
    expect(limiter.take('u1', 25 * 1024 * 1024)).toBe(false);
    expect(limiter.take('u1', 10 * 1024 * 1024)).toBe(true);
    expect(limiter.take('u1', 11 * 1024 * 1024)).toBe(false);
  });

  it('counts nothing for a refused upload', () => {
    const limiter = createUploadLimiter({ perMinute: 2, bytesPerMinute: 100 });
    expect(limiter.take('k', 90)).toBe(true);
    expect(limiter.take('k', 20)).toBe(false);
    expect(limiter.take('k', 10)).toBe(true);
    expect(limiter.take('k', 1)).toBe(false);
  });
});

describe('assetHeaders', () => {
  it('has the headers of the spec and never a name from the upload', () => {
    const headers = assetHeaders({ hash: 'a'.repeat(64), mime: 'image/png', bytes: 123 });
    expect(headers).toEqual({
      'content-type': 'image/png',
      'content-length': 123,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'content-disposition': 'inline; filename="image"',
      'cross-origin-resource-policy': 'same-origin',
      'referrer-policy': 'no-referrer',
      'cache-control': 'private, max-age=31536000, immutable',
      etag: `"${'a'.repeat(64)}"`,
    });
  });
});

describe('readBytes', () => {
  const request = (chunks: Buffer[], headers: Record<string, string> = {}) => Object.assign(Readable.from(chunks), { headers });

  it('reads a body within the limit', async () => {
    const body = await readBytes(request([Buffer.from('abc'), Buffer.from('def')]), 10);
    expect(body.toString()).toBe('abcdef');
  });

  it('refuses a declared length over the limit without reading it', async () => {
    await expect(readBytes(request([Buffer.from('x')], { 'content-length': '999' }), 10)).rejects.toMatchObject({ status: 413, code: 'payload_too_large' });
  });

  it('stops a body that grows past the limit', async () => {
    await expect(readBytes(request([Buffer.alloc(6), Buffer.alloc(6)]), 10)).rejects.toBeInstanceOf(AssetError);
  });
});

describe('parseSize', () => {
  it('reads bytes with an optional K, M or G', () => {
    expect(parseSize('1024', 'X')).toBe(1024);
    expect(parseSize('10M', 'X')).toBe(10 * 1024 * 1024);
    expect(parseSize('2g', 'X')).toBe(2 * 1024 ** 3);
    expect(parseSize('64 KB', 'X')).toBe(65536);
    expect(parseSize('0', 'X')).toBe(0);
  });

  it('refuses anything else', () => {
    for (const bad of ['', 'ten', '-1', '1.5M', '10 megabytes', '1e6']) expect(() => parseSize(bad, 'TABULA_X')).toThrow(/TABULA_X/);
  });
});

describe('the assets table of the directory', () => {
  it('is a migration of its own and is added to a directory that was written before it', () => {
    const at = MIGRATIONS.indexOf(ASSETS_MIGRATION);
    expect(at).toBeGreaterThan(-1);
    const file = path.join(dir, 'directory.sqlite');
    const d = openDirectory(file);
    d.setSetting('kept', 'yes');
    d.putAsset({ boardId: 'board1', hash: 'a'.repeat(64), mime: 'image/png', bytes: 10, width: 1, height: 1, createdBy: null, createdAt: 5 });
    d.close();
    const raw = new DatabaseSync(file);
    // an older directory has neither of these tables and no model column on its AI keys
    raw.exec(`${REMOVE_TRACKER_MIGRATION} DROP TABLE guest_sessions; DROP TABLE join_codes; DROP TABLE user_prefs; DROP TABLE assets; ALTER TABLE ai_keys DROP COLUMN model; PRAGMA user_version = ${at}`);
    raw.close();
    const again = openDirectory(file);
    expect(again.getSetting('kept')).toBe('yes');
    expect(again.getAsset('board1', 'a'.repeat(64))).toBeNull();
    again.putAsset({ boardId: 'board1', hash: 'b'.repeat(64), mime: 'image/gif', bytes: 20, width: 2, height: 2, createdBy: null, createdAt: 6 });
    expect(again.boardAssetBytes('board1')).toBe(20);
    expect(again.assetBoards('b'.repeat(64))).toEqual(['board1']);
    again.close();
  });

  it('is shared by two boards that hold one file: the instance total counts it once', () => {
    const d = openDirectory(':memory:');
    for (const id of ['b1', 'b2']) d.putAsset({ boardId: id, hash: 'c'.repeat(64), mime: 'image/png', bytes: 100, width: 1, height: 1, createdBy: null, createdAt: 1 });
    expect(d.boardAssetBytes('b1')).toBe(100);
    expect(d.assetsTotalBytes()).toBe(100);
    d.close();
  });
});

describe('the browser blob cache', () => {
  it('requests persistent storage once on the first pending put, without waiting for it', async () => {
    let finish!: (granted: boolean) => void;
    const persist = vi.fn<() => Promise<boolean>>(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const cache = createBlobCache(memoryBackend(), { persist });
    const blob = new Blob([new Uint8Array(4)], { type: 'image/png' });

    await cache.put({ key: 'hash', blob, mime: 'image/png', width: 1, height: 1, boardId: 'b1', pending: false });
    expect(persist).not.toHaveBeenCalled();
    await cache.put({ key: 'pending:1', blob, mime: 'image/png', width: 1, height: 1, boardId: 'b1', pending: true });
    await cache.put({ key: 'pending:2', blob, mime: 'image/png', width: 1, height: 1, boardId: 'b1', pending: true });
    expect(persist).toHaveBeenCalledTimes(1);
    finish(true);
  });

  it('keeps pending bytes over the cap when the persistence request rejects', async () => {
    const cache = createBlobCache(memoryBackend(), { cap: 0, persist: async () => { throw new Error('denied'); } });
    const blob = new Blob([new Uint8Array(4)], { type: 'image/png' });

    await expect(cache.put({ key: 'pending:1', blob, mime: 'image/png', width: 1, height: 1, boardId: 'b1', pending: true })).resolves.toBeUndefined();
    expect(await cache.backend.getBlob('pending:1')).toBeDefined();
  });
});
