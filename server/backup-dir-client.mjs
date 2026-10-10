import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BackupError } from './backup-error.mjs';

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const TEMP_RE = /\.tmp-[0-9a-f]{16}$/;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const aborted = () => new BackupError('aborted', 'The backup was stopped');
const missing = () => new BackupError('not_found', 'The backup file is not in the bucket', { status: 404 });
const tooLarge = () => new BackupError('too_large', 'The storage provider sent more data than expected');
const invalidPath = () => new BackupError('invalid_path', 'The backup key is not a plain relative path');
const isMissing = (err) => err?.code === 'ENOENT';

function checkAbort(signal) {
  if (signal?.aborted) throw aborted();
}

function rethrow(err, signal) {
  if (signal?.aborted || err?.name === 'AbortError') throw aborted();
  throw err;
}

function partsOf(value, { prefix = false } = {}) {
  if (typeof value !== 'string') throw invalidPath();
  if (prefix && value === '') return [];
  if (
    value.length === 0 || value.startsWith('/') || value.includes('\\') || value.includes('..') ||
    !/^[A-Za-z0-9._/-]+$/.test(value)
  ) throw invalidPath();
  const parts = value.split('/');
  if (prefix && parts.at(-1) === '') parts.pop();
  if (parts.length === 0 || parts.some((part) => !part || part === '.' || part === '..')) throw invalidPath();
  return parts;
}

function unsafePath() {
  return new BackupError('invalid_path', 'The backup path contains a symbolic link or is not a directory');
}

/** The local target stores the same sealed bytes as S3, with a file for every key. */
/** @param {{ dir: string, signal?: AbortSignal | null }} options */
export function createDirClient({ dir, signal = null }) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new TypeError('dir must be an absolute path');
  const root = path.resolve(dir);

  function ensureRoot(create) {
    checkAbort(signal);
    try {
      fs.lstatSync(root);
    } catch (err) {
      if (!isMissing(err) || !create) {
        if (isMissing(err)) return false;
        rethrow(err, signal);
      }
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    }
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafePath();
    return true;
  }

  function inspect(key, { createParents = false, prefix = false } = {}) {
    const parts = partsOf(key, { prefix });
    if (!ensureRoot(createParents)) return null;
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      checkAbort(signal);
      const next = path.join(current, parts[i]);
      let stat;
      try {
        stat = fs.lstatSync(next);
      } catch (err) {
        if (!isMissing(err)) rethrow(err, signal);
        if (!createParents || i === parts.length - 1) return { file: next, parent: current, stat: null };
        try {
          fs.mkdirSync(next, { mode: 0o700 });
        } catch (mkdirError) {
          if (mkdirError?.code !== 'EEXIST') rethrow(mkdirError, signal);
        }
        stat = fs.lstatSync(next);
      }
      if (stat.isSymbolicLink()) throw unsafePath();
      if (i < parts.length - 1 && !stat.isDirectory()) throw unsafePath();
      current = next;
      if (i === parts.length - 1) return { file: next, parent: path.dirname(next), stat };
    }
    return { file: root, parent: root, stat: null };
  }

  async function openExisting(key) {
    const found = inspect(key);
    if (!found?.stat) return null;
    if (!found.stat.isFile()) throw unsafePath();
    checkAbort(signal);
    let handle = null;
    try {
      handle = await fs.promises.open(found.file, fs.constants.O_RDONLY | NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile()) {
        await handle.close();
        handle = null;
        throw unsafePath();
      }
      return { handle, stat };
    } catch (err) {
      await handle?.close().catch(() => {});
      if (isMissing(err)) return null;
      rethrow(err, signal);
    }
  }

  async function put(key, body) {
    checkAbort(signal);
    const found = inspect(key, { createParents: true });
    if (!found) throw unsafePath();
    if (found.stat && !found.stat.isFile()) throw unsafePath();
    await cleanOldTemps(found.parent);
    checkAbort(signal);
    const temp = path.join(found.parent, `.${path.basename(found.file)}.tmp-${crypto.randomBytes(8).toString('hex')}`);
    let handle = null;
    let created = false;
    try {
      handle = await fs.promises.open(temp, 'wx', 0o600);
      created = true;
      await handle.writeFile(body, { signal: signal ?? undefined });
      checkAbort(signal);
      await handle.sync();
      await handle.close();
      handle = null;
      checkAbort(signal);
      const again = inspect(key);
      if (again?.stat?.isSymbolicLink()) throw unsafePath();
      if (again?.stat && !again.stat.isFile()) throw unsafePath();
      await fs.promises.rename(temp, found.file);
      created = false;
    } catch (err) {
      if (handle) await handle.close().catch(() => {});
      if (created) await fs.promises.rm(temp, { force: true }).catch(() => {});
      rethrow(err, signal);
    }
  }

  async function get(key, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
    checkAbort(signal);
    const opened = await openExisting(key);
    if (!opened) throw missing();
    const { handle, stat } = opened;
    try {
      if (stat.size > maxBytes) throw tooLarge();
      const data = await handle.readFile({ signal: signal ?? undefined });
      checkAbort(signal);
      if (data.length > maxBytes) throw tooLarge();
      return data;
    } catch (err) {
      rethrow(err, signal);
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async function head(key) {
    checkAbort(signal);
    const opened = await openExisting(key);
    if (!opened) return null;
    try {
      checkAbort(signal);
      return { size: opened.stat.size };
    } finally {
      await opened.handle.close().catch(() => {});
    }
  }

  async function del(key) {
    checkAbort(signal);
    const found = inspect(key);
    if (!found?.stat) return;
    if (!found.stat.isFile()) throw unsafePath();
    try {
      await fs.promises.unlink(found.file);
    } catch (err) {
      if (!isMissing(err)) rethrow(err, signal);
    }
    checkAbort(signal);
  }

  async function list(prefix) {
    checkAbort(signal);
    partsOf(prefix, { prefix: true });
    if (!ensureRoot(false)) return [];
    const contents = [];
    async function walk(directory, rel) {
      checkAbort(signal);
      let entries;
      try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
      } catch (err) {
        rethrow(err, signal);
      }
      for (const entry of entries) {
        checkAbort(signal);
        if (TEMP_RE.test(entry.name)) continue;
        const key = rel ? `${rel}/${entry.name}` : entry.name;
        const file = path.join(directory, entry.name);
        const stat = await fs.promises.lstat(file);
        if (stat.isSymbolicLink()) throw unsafePath();
        if (stat.isDirectory()) await walk(file, key);
        else if (stat.isFile() && key.startsWith(prefix)) contents.push({ key, size: stat.size, lastModified: Math.trunc(stat.mtimeMs) });
      }
    }
    try {
      await walk(root, '');
    } catch (err) {
      rethrow(err, signal);
    }
    return contents.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async function cleanOldTemps(directory) {
    try {
      const entries = await fs.promises.readdir(directory, { withFileTypes: true });
      const cutoff = Date.now() - HOUR_MS;
      for (const entry of entries) {
        if (!TEMP_RE.test(entry.name) || !entry.isFile()) continue;
        const file = path.join(directory, entry.name);
        const stat = await fs.promises.lstat(file);
        if (stat.isFile() && stat.mtimeMs < cutoff) await fs.promises.rm(file, { force: true });
      }
    } catch {
      /* stale temporary files never prevent a backup */
    }
  }

  return { put, get, head, del, list };
}
