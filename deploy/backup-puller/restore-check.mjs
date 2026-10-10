import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.json\.enc$/;
const OBJECT_ID_RE = /^[a-f0-9]{64}$/;
const SEALED_OVERHEAD = 5 + 12 + 16;
const MAX_OBJECT_BYTES = 256 * 1024 * 1024 + SEALED_OVERHEAD;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024 + SEALED_OVERHEAD;

function currentMs(now) {
  const value = typeof now === 'function' ? now() : now;
  if (value instanceof Date) return value.getTime();
  return typeof value === 'string' ? Date.parse(value) : Number(value);
}

function manifestTime(name) {
  const match = typeof name === 'string' ? MANIFEST_RE.exec(name) : null;
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const canonical = `${new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g, '')}.json.enc`;
  return canonical === name ? ms : null;
}

export function decodeRestoreKey(value) {
  if (typeof value !== 'string') throw new Error('missing_key');
  const raw = value.trim();
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, 'hex');
  else key = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (key.length !== 32) throw new Error('invalid_key');
  return key;
}

function deriveKeys(master) {
  const derive = (info) => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), info, 32));
  const keyIdBytes = derive('tabula-backup/keyid/v1').subarray(0, 4);
  return {
    encKey: derive('tabula-backup/enc/v1'),
    nameKey: derive('tabula-backup/name/v1'),
    keyIdBytes,
    keyId: keyIdBytes.toString('hex'),
  };
}

export function unseal(sealed, name, master) {
  if (!Buffer.isBuffer(sealed) || sealed.length < SEALED_OVERHEAD || sealed[0] !== 1) throw new Error('bad_format');
  const keys = deriveKeys(master);
  if (!sealed.subarray(1, 5).equals(keys.keyIdBytes)) throw new Error('unknown_key');
  const header = sealed.subarray(0, 5);
  const decipher = crypto.createDecipheriv('aes-256-gcm', keys.encKey, sealed.subarray(5, 17), { authTagLength: 16 });
  decipher.setAAD(Buffer.concat([header, Buffer.from(name, 'utf8')]));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  try {
    return { plaintext: Buffer.concat([decipher.update(sealed.subarray(17, sealed.length - 16)), decipher.final()]), keys };
  } catch {
    throw new Error('integrity_error');
  }
}

export function objectIdOf(plaintext, keys) {
  return crypto.createHmac('sha256', keys.nameKey).update(plaintext).digest('hex');
}

function validRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 300 || value.startsWith('/') || /[\\\p{Cc}]/u.test(value)) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  return value.split('/').every((part) => part && part !== '.' && part !== '..');
}

async function inspectDirectoryTree(directory) {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  const rootStat = await fs.promises.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('unsafe_path');
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.promises.lstat(current);
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw new Error('filesystem_error');
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('unsafe_path');
  }
  return true;
}

async function scanStore(store) {
  const root = path.resolve(store);
  if (!(await inspectDirectoryTree(root))) throw new Error('store_missing');
  const entries = [];
  async function walk(directory, relative = '') {
    const children = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const child of children) {
      if (!/^[A-Za-z0-9._-]+$/.test(child.name) || child.name === '.' || child.name === '..') throw new Error('invalid_store_name');
      const file = path.join(directory, child.name);
      const rel = relative ? `${relative}/${child.name}` : child.name;
      const stat = await fs.promises.lstat(file);
      if (stat.isSymbolicLink()) throw new Error('unsafe_path');
      if (stat.isDirectory()) await walk(file, rel);
      else if (stat.isFile()) entries.push({ file, relative: rel, size: stat.size });
      else throw new Error('unsafe_path');
    }
  }
  await walk(root);
  return entries;
}

function parentKind(relative) {
  const parts = relative.split('/');
  if (parts.length < 3) return null;
  const parent = parts.at(-2);
  const name = parts.at(-1);
  if (parent === 'objects') return { kind: 'objects', name, prefixParts: parts.slice(0, -2) };
  if (parent === 'manifests') return { kind: 'manifests', name, prefixParts: parts.slice(0, -2) };
  return null;
}

async function checkSealedFile(item, maxBytes) {
  if (item.size < SEALED_OVERHEAD || item.size > maxBytes) return false;
  const handle = await fs.promises.open(item.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const head = Buffer.alloc(5);
    const { bytesRead } = await handle.read(head, 0, 5, 0);
    return bytesRead === 5 && head[0] === 1;
  } finally {
    await handle.close();
  }
}

export async function structureCheck({ store, now = Date.now, maxAgeHours = 26 }) {
  const problems = [];
  let entries;
  try {
    entries = await scanStore(store);
  } catch (error) {
    return { ok: false, manifest: null, files: 0, bytes: 0, problems: [error?.message ?? 'store_error'] };
  }
  const manifests = [];
  let objectFiles = 0;
  let sealedBytes = 0;
  for (const item of entries) {
    const location = parentKind(item.relative);
    if (!location) {
      problems.push('unexpected_store_file');
      continue;
    }
    const validName = location.kind === 'objects' ? OBJECT_ID_RE.test(location.name) : manifestTime(location.name) !== null;
    if (!validName) {
      problems.push(`invalid_${location.kind}_name`);
      continue;
    }
    const maxBytes = location.kind === 'objects' ? MAX_OBJECT_BYTES : MAX_MANIFEST_BYTES;
    if (!(await checkSealedFile(item, maxBytes))) problems.push(`invalid_${location.kind}_format`);
    else {
      sealedBytes += item.size;
      if (location.kind === 'objects') objectFiles++;
      else manifests.push({ ...item, name: location.name, at: manifestTime(location.name), prefixParts: location.prefixParts });
    }
  }
  manifests.sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
  const newest = manifests[0] ?? null;
  if (!newest) problems.push('manifest_missing');
  else if (currentMs(now) - newest.at > maxAgeHours * 60 * 60 * 1000) problems.push('manifest_too_old');
  return {
    ok: problems.length === 0,
    manifest: newest?.name ?? null,
    files: objectFiles,
    bytes: sealedBytes,
    problems,
  };
}

function parseManifest(plaintext, keys) {
  let manifest;
  try {
    manifest = JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new Error('invalid_manifest');
  }
  if (!manifest || manifest.version !== 1 || manifest.keyId !== keys.keyId || !Array.isArray(manifest.files)) throw new Error('invalid_manifest');
  const paths = new Set();
  let bytes = 0;
  for (const entry of manifest.files) {
    if (!entry || !validRelativePath(entry.path) || paths.has(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 0 || !OBJECT_ID_RE.test(entry.objectId)) throw new Error('invalid_manifest');
    paths.add(entry.path);
    bytes += entry.size;
    if (!Number.isSafeInteger(bytes)) throw new Error('invalid_manifest');
  }
  if (manifest.totals && (manifest.totals.files !== manifest.files.length || manifest.totals.bytes !== bytes)) throw new Error('invalid_manifest');
  return { files: manifest.files, bytes };
}

export async function restoreCheck({ store, key, structureOnly = false, now = Date.now, maxAgeHours = 26 }) {
  if (structureOnly) return structureCheck({ store, now, maxAgeHours });
  const problems = [];
  let entries;
  try {
    entries = await scanStore(store);
  } catch (error) {
    return { ok: false, manifest: null, files: 0, bytes: 0, problems: [error?.message ?? 'store_error'] };
  }
  const manifests = entries
    .map((item) => ({ ...item, location: parentKind(item.relative) }))
    .filter((item) => item.location?.kind === 'manifests' && manifestTime(item.location.name) !== null)
    .sort((a, b) => manifestTime(b.location.name) - manifestTime(a.location.name));
  const newest = manifests[0];
  if (!newest) return { ok: false, manifest: null, files: 0, bytes: 0, problems: ['manifest_missing'] };
  let keyBytes;
  try {
    keyBytes = Buffer.isBuffer(key) ? key : decodeRestoreKey(key);
  } catch (error) {
    return { ok: false, manifest: newest.location.name, files: 0, bytes: 0, problems: [error?.message ?? 'invalid_key'] };
  }
  let parsed;
  let keys;
  try {
    const sealed = await fs.promises.readFile(newest.file);
    const opened = unseal(sealed, `manifest:${newest.location.name}`, keyBytes);
    keys = opened.keys;
    parsed = parseManifest(opened.plaintext, keys);
  } catch (error) {
    return { ok: false, manifest: newest.location.name, files: 0, bytes: 0, problems: [error?.message ?? 'manifest_error'] };
  }
  let verifiedFiles = 0;
  let verifiedBytes = 0;
  for (const entry of parsed.files) {
    const objectFile = path.join(path.dirname(newest.file), '..', 'objects', entry.objectId);
    try {
      const stat = await fs.promises.lstat(objectFile);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('unsafe_path');
      const sealed = await fs.promises.readFile(objectFile);
      const opened = unseal(sealed, `obj:${entry.objectId}`, keyBytes);
      if (opened.plaintext.length !== entry.size || objectIdOf(opened.plaintext, opened.keys) !== entry.objectId) throw new Error('object_mismatch');
      verifiedFiles++;
      verifiedBytes += opened.plaintext.length;
    } catch (error) {
      const code = error?.code === 'ENOENT' ? 'object_missing' : error?.message ?? 'object_error';
      problems.push(`${entry.path}:${code}`);
    }
  }
  return {
    ok: problems.length === 0 && verifiedFiles === parsed.files.length && verifiedBytes === parsed.bytes,
    manifest: newest.location.name,
    files: parsed.files.length,
    bytes: parsed.bytes,
    problems,
  };
}

function parseArgs(argv) {
  const args = { store: null, keyEnv: 'TABULA_RESTORE_KEY', structureOnly: false, maxAgeHours: 26 };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--store' && argv[index + 1]) args.store = argv[++index];
    else if (arg === '--key-env' && argv[index + 1]) args.keyEnv = argv[++index];
    else if (arg === '--structure-only') args.structureOnly = true;
    else if (arg === '--max-age-hours' && argv[index + 1]) args.maxAgeHours = Number(argv[++index]);
    else throw new Error('invalid_arguments');
  }
  if (!args.store || !path.isAbsolute(args.store) || !/^[A-Z_][A-Z0-9_]*$/.test(args.keyEnv) || !Number.isFinite(args.maxAgeHours) || args.maxAgeHours < 0) throw new Error('invalid_arguments');
  return args;
}

export async function main({ argv = [], env = process.env, now = Date.now, write = (line) => process.stdout.write(`${line}\n`) } = {}) {
  let summary;
  try {
    const args = parseArgs(argv);
    const key = args.structureOnly ? undefined : env[args.keyEnv];
    summary = await restoreCheck({ store: args.store, key, structureOnly: args.structureOnly, now, maxAgeHours: args.maxAgeHours });
  } catch (error) {
    summary = { ok: false, manifest: null, files: 0, bytes: 0, problems: [error?.message ?? 'check_failed'] };
  }
  write(JSON.stringify(summary));
  return summary.ok ? 0 : 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  }, () => {
    process.exitCode = 1;
  });
}
