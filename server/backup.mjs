// Off-site backups (docs/backups.md). When TABULA_BACKUP_* is set the relay copies the data directory to its configured
// target on a schedule. Everything is encrypted on the instance before it leaves it: storage only sees ciphertext and opaque names.
//
//   <prefix>/objects/<objectId>              one file, content addressed (objectId = HMAC-SHA256(nameKey, plaintext))
//   <prefix>/manifests/<UTC timestamp>.json.enc   the list of files of one backup; written last, so a half done run is invisible
//
// Sealed format of both: version (1) | key id (4) | nonce (12) | AES-256-GCM ciphertext | tag (16). The additional
// authenticated data is the first five bytes plus 'obj:<objectId>' or 'manifest:<file name>', so an object cannot be
// swapped for another one, a manifest cannot be renamed, and the key id in the clear cannot be changed.
//
// The S3 client is a small SigV4 signer over the global fetch (no SDK). Nothing in this file logs, stores or throws
// the master key, the secret key, an Authorization header or a URL: errors carry a status and an S3 error code only.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { BackupError } from './backup-error.mjs';
import { COPY_JOB, copyDatabase } from './backup-copy-worker.mjs';
import { createDirClient } from './backup-dir-client.mjs';
import { withLegacyEnv } from './env.mjs';
import { createSnapshotBarrier, testCaptureDelayMs } from './snapshot-barrier.mjs';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A single file above this size fails the run (everything is read into memory once; streaming is later work). */
export const MAX_FILE_BYTES = 256 * 1024 * 1024;
const FORMAT_VERSION = 1;
const HEADER_LEN = 5;
const NONCE_LEN = 12;
const TAG_LEN = 16;
/** Bytes a sealed object adds to its plaintext. */
export const OVERHEAD = HEADER_LEN + NONCE_LEN + TAG_LEN;
const CRYPTO_CHUNK = 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_FILES = 1_000_000;
const MAX_LIST_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BODY = 64 * 1024;
const MAX_XML_NODES = 200_000;
const MAX_XML_DEPTH = 12;
const MAX_LIST_PAGES = 100_000;
const REQUEST_TIMEOUT_MS = 10_000;
const BACKOFF_MS = [500, 2_000, 8_000];
const GC_GRACE_MS = HOUR_MS;
const FIRST_RUN_MIN_MS = MINUTE_MS;
const FIRST_RUN_SPAN_MS = 4 * MINUTE_MS;
const DEFAULT_SETTLE_SECONDS = 120;
const DEFAULT_SHUTDOWN_SECONDS = 4;
const DEFAULT_VERIFY_HOURS = 24;
const DEFAULT_VERIFY_MAX_MB = 64;
const DEFAULT_SNAPSHOT_MAX_HOLD_SECONDS = 5;
/** A workspace that never goes quiet is still backed up this long after its first change that is not in a backup (or one settle time, if that is longer). */
const SETTLE_MAX_WAIT_MS = 10 * MINUTE_MS;
/** The longest wait between two settle attempts while the bucket keeps failing. */
const SETTLE_RETRY_CAP_MS = 30 * MINUTE_MS;
const STATUS_KEY = 'backup.status';
const COPY_WORKER_URL = new URL('./backup-copy-worker.mjs', import.meta.url);
/** What a deep verify may find wrong with an object: the codes of readObject that mean the stored bytes are not the object. Anything else (the network, the provider) is not damage. */
const DAMAGE_CODES = new Set(['not_found', 'tamper', 'content_mismatch', 'bad_format', 'unknown_key', 'too_large']);
/** The settings row that keeps manifests safe from pruning (restore.mjs writes it): a JSON object, manifest name to expiry in ms. */
export const PROTECTED_KEY = 'backup.protected';
const MAX_PREVIOUS_KEYS = 8;
const ERROR_MAX = 200;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const REQUIRED = ['S3_ENDPOINT', 'BUCKET', 'ACCESS_KEY', 'SECRET_KEY', 'KEY'];
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const REGION_RE = /^[A-Za-z0-9-]{1,40}$/;
const CREDENTIAL_RE = /^[\x21-\x7e]{1,512}$/;
const HEX_KEY_RE = /^[0-9a-fA-F]{64}$/;
const BASE64_KEY_RE = /^[A-Za-z0-9+/_-]{43}={0,1}$/;
const OBJECT_ID_RE = /^[0-9a-f]{64}$/;
const MANIFEST_NAME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.json\.enc$/;
const ROOM_FILE_RE = /^[A-Za-z0-9_-]{1,64}(?:~comments)?\.yjs$/;
const BOARD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VERSION_ID_RE = /^[A-Za-z0-9_-]{16}$/;
const ASSET_PATH_RE = /^assets\/([0-9a-f]{2})\/([0-9a-f]{64})$/;
const STALE_TEMP_RE = /^(?:directory|chat)\.sqlite\.backup-[0-9a-f]{16}\.tmp(?:-journal|-wal|-shm)?$/;
const STALE_SNAPSHOT_RE = /^\.backup-snapshot-[0-9a-f]{16}$/;
const S3_CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const ERRNO_RE = /^[A-Z0-9_]{2,40}$/;

const VERSION = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? 'unknown');
  } catch {
    return 'unknown';
  }
})();

export { BackupError } from './backup-error.mjs';

const aborted = () => new BackupError('aborted', 'The backup was stopped');
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const sha256Hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// ---------------------------------------------------------------- configuration

const fullName = (name) => `TABULA_BACKUP_${name}`;
const backupVar = (env, name) => (env[fullName(name)] ?? '').trim();

/** The 32 byte key from 64 hex characters, or base64 / base64url (padding optional). null when it is anything else. */
function decodeKey(raw) {
  const value = raw.trim();
  if (HEX_KEY_RE.test(value)) return Buffer.from(value, 'hex');
  if (BASE64_KEY_RE.test(value)) {
    const bytes = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (bytes.length === 32) return bytes;
  }
  return null;
}

function wholeNumber(env, name, fallback, min, max) {
  const raw = backupVar(env, name);
  if (!raw) return fallback;
  const n = /^\d{1,6}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${fullName(name)} must be a whole number from ${min} to ${max}`);
  return n;
}

/** Every spelling of a key that could end up in a message: the secrets the scrubber must remove. */
function keySpellings(raw, bytes) {
  return [raw.trim(), bytes.toString('hex'), bytes.toString('hex').toUpperCase(), bytes.toString('base64'), bytes.toString('base64url'), bytes.toString('base64').replace(/=+$/, '')];
}

/**
 * @typedef {object} BackupConfig
 * @property {'s3' | 'dir'} target
 * @property {string | undefined} endpoint origin of the S3 endpoint, for example https://fly.storage.tigris.dev
 * @property {string | undefined} bucket
 * @property {string | null | undefined} dir local export directory; null uses `<dataDir>/backup-export`
 * @property {string} prefix
 * @property {string | undefined} region
 * @property {boolean | undefined} pathStyle
 * @property {number} intervalMinutes
 * @property {number} settleSeconds quiet time after the last change before a backup is taken; 0 turns settle backups off
 * @property {number} shutdownSeconds how long a graceful shutdown may spend on a final backup; 0 turns it off
 * @property {number} snapshotMaxHoldSeconds the longest writers may be held while local snapshot copies are made
 * @property {number} verifyHours how often a slice of the newest backup is read back and decrypted; 0 turns the deep verify off
 * @property {number} verifyMaxMb the most sealed megabytes one deep verify reads
 * @property {number} keepHourlyHours
 * @property {number} keepDailyDays
 * @property {string | null} pullTokenSha256 bearer token SHA-256 for the directory export route, not enumerable
 * @property {string | undefined} accessKey not enumerable
 * @property {string | undefined} secretKey not enumerable
 * @property {Buffer} key the master key, not enumerable
 * @property {Buffer[]} previousKeys keys that can still be read, not enumerable
 * @property {string[]} secrets every spelling of a secret, for the scrubber, not enumerable
 */

/**
 * Reads TABULA_BACKUP_* (the old MIRA_ spelling too). Returns null when backups are off. Some but not all required
 * destination variables, or any invalid value, throws an error that names the variable and never the value. The secrets
 * sit on non-enumerable properties, so the config cannot be printed or serialised by accident.
 * @param {Record<string, string | undefined>} [rawEnv]
 * @param {(message: string) => void} [warn]
 * @returns {BackupConfig | null}
 */
export function loadBackupConfig(rawEnv = process.env, warn = console.warn) {
  const env = withLegacyEnv(rawEnv, warn);
  const target = backupVar(env, 'TARGET') || 's3';
  if (target !== 's3' && target !== 'dir') throw new Error('TABULA_BACKUP_TARGET must be s3 or dir');
  const rawPullTokenSha256 = backupVar(env, 'PULL_TOKEN_SHA256');
  let pullTokenSha256 = null;
  if (rawPullTokenSha256) {
    if (!HEX_KEY_RE.test(rawPullTokenSha256)) throw new Error('TABULA_BACKUP_PULL_TOKEN_SHA256 must be 64 hexadecimal characters');
    if (target !== 'dir') throw new Error('TABULA_BACKUP_PULL_TOKEN_SHA256 requires TABULA_BACKUP_TARGET=dir');
    pullTokenSha256 = rawPullTokenSha256.toLowerCase();
  }
  const rawDir = backupVar(env, 'DIR');
  if (target === 'dir' && rawDir && !path.isAbsolute(rawDir)) throw new Error('TABULA_BACKUP_DIR must be an absolute path');
  const required = target === 'dir' ? ['KEY'] : REQUIRED;
  const missing = required.filter((name) => !backupVar(env, name));
  if (missing.length === required.length) return null;
  if (missing.length) {
    throw new Error(`${required.map(fullName).join(', ')} must be set together (missing ${missing.map(fullName).join(', ')})`);
  }

  let url;
  let bucket;
  let accessKey;
  let secretKey;
  let region;
  let pathStyle;
  if (target === 's3') {
    try {
      url = new URL(backupVar(env, 'S3_ENDPOINT'));
    } catch {
      throw new Error('TABULA_BACKUP_S3_ENDPOINT is not a valid URL');
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
      throw new Error('TABULA_BACKUP_S3_ENDPOINT must be an https:// URL (http:// is only allowed for localhost)');
    }
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
      throw new Error('TABULA_BACKUP_S3_ENDPOINT must be a bare address without credentials, a path, a query or a fragment');
    }

    bucket = backupVar(env, 'BUCKET');
    if (!BUCKET_RE.test(bucket) || bucket.includes('..')) {
      throw new Error('TABULA_BACKUP_BUCKET must be 3 to 63 lowercase letters, digits, dots or hyphens');
    }
    accessKey = backupVar(env, 'ACCESS_KEY');
    secretKey = backupVar(env, 'SECRET_KEY');
    if (!CREDENTIAL_RE.test(accessKey)) throw new Error('TABULA_BACKUP_ACCESS_KEY must be printable characters without spaces');
    if (!CREDENTIAL_RE.test(secretKey)) throw new Error('TABULA_BACKUP_SECRET_KEY must be printable characters without spaces');
  }

  const rawKey = backupVar(env, 'KEY');
  const key = decodeKey(rawKey);
  if (!key) throw new Error('TABULA_BACKUP_KEY must be 32 bytes, written as 64 hex characters or as base64');
  const spellings = keySpellings(rawKey, key);
  const previousKeys = [];
  const previousRaw = backupVar(env, 'KEY_PREVIOUS')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (previousRaw.length > MAX_PREVIOUS_KEYS) throw new Error(`TABULA_BACKUP_KEY_PREVIOUS takes at most ${MAX_PREVIOUS_KEYS} keys`);
  previousRaw.forEach((part, i) => {
    const bytes = decodeKey(part);
    if (!bytes) throw new Error(`TABULA_BACKUP_KEY_PREVIOUS entry ${i + 1} must be 32 bytes, written as 64 hex characters or as base64`);
    spellings.push(...keySpellings(part, bytes));
    if (!bytes.equals(key) && !previousKeys.some((k) => k.equals(bytes))) previousKeys.push(bytes);
  });

  const prefix = backupVar(env, 'PREFIX').replace(/^\/+|\/+$/g, '') || 'tabula';
  if (prefix.length > 200 || !PREFIX_RE.test(prefix)) {
    throw new Error('TABULA_BACKUP_PREFIX must be letters, digits, . - _ and / between them, up to 200 characters');
  }
  if (target === 's3') {
    region = backupVar(env, 'REGION') || 'auto';
    if (!REGION_RE.test(region)) throw new Error('TABULA_BACKUP_REGION must be letters, digits and hyphens');
    const style = backupVar(env, 'PATH_STYLE') || 'on';
    if (style !== 'on' && style !== 'off') throw new Error('TABULA_BACKUP_PATH_STYLE must be on or off');
    pathStyle = style === 'on';
    if (!pathStyle && (LOCAL_HOSTS.has(url.hostname) || /^[\d.]+$/.test(url.hostname) || url.hostname.startsWith('['))) {
      throw new Error('TABULA_BACKUP_PATH_STYLE=off needs a DNS name in TABULA_BACKUP_S3_ENDPOINT, not an IP address or localhost');
    }
  }

  const intervalMinutes = wholeNumber(env, 'INTERVAL_MINUTES', 60, 5, 10_080);
  const settleSeconds = wholeNumber(env, 'SETTLE_SECONDS', DEFAULT_SETTLE_SECONDS, 0, 3_600);
  const shutdownSeconds = wholeNumber(env, 'SHUTDOWN_SECONDS', DEFAULT_SHUTDOWN_SECONDS, 0, 25);
  const snapshotMaxHoldSeconds = wholeNumber(env, 'SNAPSHOT_MAX_HOLD_SECONDS', DEFAULT_SNAPSHOT_MAX_HOLD_SECONDS, 1, 60);
  const verifyHours = wholeNumber(env, 'VERIFY_HOURS', DEFAULT_VERIFY_HOURS, 0, 720);
  const verifyMaxMb = wholeNumber(env, 'VERIFY_MAX_MB', DEFAULT_VERIFY_MAX_MB, 1, 4_096);
  const keepHourlyHours = wholeNumber(env, 'KEEP_HOURLY_HOURS', 48, 0, 8_760);
  const keepDailyDays = wholeNumber(env, 'KEEP_DAILY_DAYS', 30, 0, 3_650);

  const config = {
    target,
    endpoint: url ? `${url.protocol}//${url.host}` : undefined,
    bucket,
    dir: target === 'dir' ? rawDir || null : undefined,
    prefix,
    region,
    pathStyle,
    intervalMinutes,
    settleSeconds,
    shutdownSeconds,
    snapshotMaxHoldSeconds,
    verifyHours,
    verifyMaxMb,
    keepHourlyHours,
    keepDailyDays,
  };
  Object.defineProperties(config, {
    accessKey: { value: accessKey },
    secretKey: { value: secretKey },
    key: { value: key },
    previousKeys: { value: previousKeys },
    pullTokenSha256: { value: pullTokenSha256 },
    secrets: { value: [...(target === 's3' ? [accessKey, secretKey] : []), ...spellings, ...(pullTokenSha256 ? [pullTokenSha256, pullTokenSha256.toUpperCase()] : [])] },
  });
  return config;
}

/**
 * Removes what must never reach a log line, an audit row, the status or an error message: the literals it is given,
 * signatures, credential scopes, Authorization headers and the user info of a URL.
 * @param {string[]} [secrets]
 */
export function createScrubber(secrets = []) {
  const literals = [...new Set(secrets.filter((s) => typeof s === 'string' && s.length >= 4))].sort((a, b) => b.length - a.length);
  return (value) => {
    let text = String(value ?? '');
    for (const secret of literals) text = text.split(secret).join('[hidden]');
    return text
      .replace(/(signature=)[0-9a-fA-F]+/gi, '$1[hidden]')
      .replace(/(credential=)[^,&\s]+/gi, '$1[hidden]')
      .replace(/(x-amz-security-token=)[^&\s]+/gi, '$1[hidden]')
      .replace(/AWS4-HMAC-SHA256[^\n]*/g, 'AWS4-HMAC-SHA256 [hidden]')
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[hidden]@')
      .replace(/\p{Cc}+/gu, ' ');
  };
}

// ---------------------------------------------------------------- keys and sealing

const hkdf = (master, info) => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), info, 32));

/**
 * Everything derived from one master key. `keyId` (the first four bytes of its own derivation, as 8 hex characters)
 * tells a reader which key sealed an object without revealing the key.
 * @param {Buffer} master 32 bytes
 */
export function deriveKeys(master) {
  if (!Buffer.isBuffer(master) || master.length !== 32) throw new BackupError('unknown_key', 'The master key must be 32 bytes');
  const keyIdBytes = hkdf(master, 'tabula-backup/keyid/v1').subarray(0, 4);
  return {
    encKey: hkdf(master, 'tabula-backup/enc/v1'),
    nameKey: hkdf(master, 'tabula-backup/name/v1'),
    keyIdBytes: Buffer.from(keyIdBytes),
    keyId: keyIdBytes.toString('hex'),
  };
}

/**
 * The key used to write and the keys that can still be read.
 * @param {Buffer[]} masters the first one is the key objects are written with
 */
export function createKeyring(masters) {
  const all = masters.map(deriveKeys);
  const byId = new Map();
  for (const keys of all) {
    const other = byId.get(keys.keyId);
    if (other && !other.encKey.equals(keys.encKey)) throw new BackupError('unknown_key', 'Two keys have the same key id');
    byId.set(keys.keyId, keys);
  }
  return { current: all[0], byId };
}

/** The content address of a file: keyed, so the provider cannot confirm a guess about what a file contains. */
export const objectIdOf = (plaintext, keys) => hmac(keys.nameKey, plaintext).toString('hex');

/**
 * @param {Buffer} plaintext
 * @param {string} name 'obj:<objectId>' or 'manifest:<file name>'
 * @param {ReturnType<typeof deriveKeys>} keys
 */
export function seal(plaintext, name, keys) {
  const header = Buffer.concat([Buffer.from([FORMAT_VERSION]), keys.keyIdBytes]);
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', keys.encKey, nonce);
  cipher.setAAD(Buffer.concat([header, Buffer.from(name, 'utf8')]));
  const out = Buffer.allocUnsafe(HEADER_LEN + NONCE_LEN + plaintext.length + TAG_LEN);
  header.copy(out, 0);
  nonce.copy(out, HEADER_LEN);
  let pos = HEADER_LEN + NONCE_LEN;
  for (let off = 0; off < plaintext.length; off += CRYPTO_CHUNK) {
    pos += cipher.update(plaintext.subarray(off, off + CRYPTO_CHUNK)).copy(out, pos);
  }
  pos += cipher.final().copy(out, pos);
  cipher.getAuthTag().copy(out, pos);
  return out;
}

/**
 * Decrypts and verifies a sealed buffer. Throws BackupError: bad_format (too short, unknown version), unknown_key
 * (sealed with a key this instance does not hold), tamper (the tag does not match: a flipped bit, truncation, or an
 * object or manifest under another name).
 * @param {Buffer} sealed
 * @param {string} name
 * @param {ReturnType<typeof createKeyring>} keyring
 */
export function unseal(sealed, name, keyring) {
  if (!Buffer.isBuffer(sealed) || sealed.length < OVERHEAD) throw new BackupError('bad_format', 'The backup file is too short to be valid');
  if (sealed[0] !== FORMAT_VERSION) throw new BackupError('bad_format', 'The backup file has an unknown format version');
  const keys = keyring.byId.get(sealed.subarray(1, HEADER_LEN).toString('hex'));
  if (!keys) throw new BackupError('unknown_key', 'The backup file was sealed with a key this instance does not have');
  const header = sealed.subarray(0, HEADER_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', keys.encKey, sealed.subarray(HEADER_LEN, HEADER_LEN + NONCE_LEN), { authTagLength: TAG_LEN });
  decipher.setAAD(Buffer.concat([header, Buffer.from(name, 'utf8')]));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_LEN));
  const cipherText = sealed.subarray(HEADER_LEN + NONCE_LEN, sealed.length - TAG_LEN);
  const plaintext = Buffer.allocUnsafe(cipherText.length);
  try {
    let pos = 0;
    for (let off = 0; off < cipherText.length; off += CRYPTO_CHUNK) {
      pos += decipher.update(cipherText.subarray(off, off + CRYPTO_CHUNK)).copy(plaintext, pos);
    }
    pos += decipher.final().copy(plaintext, pos);
    if (pos !== plaintext.length) throw new Error('length');
  } catch {
    throw new BackupError('tamper', 'The backup file failed its integrity check (damaged, or not the file it claims to be)');
  }
  return { plaintext, keys };
}

// ---------------------------------------------------------------- paths, manifest names, retention

/**
 * A path inside a manifest is relative to the data directory and nothing else. Throws BackupError invalid_path.
 * @param {unknown} value
 * @returns {string}
 */
export function validateRelPath(value) {
  const bad = () => new BackupError('invalid_path', 'A path in the backup manifest is not a plain relative path');
  if (typeof value !== 'string' || value.length === 0 || value.length > 300) throw bad();
  if (/[\p{Cc}\\]/u.test(value) || value.startsWith('/') || /^[A-Za-z]:/.test(value)) throw bad();
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') throw bad();
  }
  return value;
}

/**
 * The hash of an image file when `rel` is `assets/<aa>/<hash>` with the shard matching the hash, else null. Images are
 * stored by the SHA-256 of their content (docs/images.md), so the name says what the bytes must be.
 * @param {unknown} rel
 */
export function assetHashOf(rel) {
  const m = typeof rel === 'string' ? ASSET_PATH_RE.exec(rel) : null;
  return m && m[2].startsWith(m[1]) ? m[2] : null;
}

/**
 * Whether `rel` is a path the engine itself writes: directory.sqlite, chat.sqlite, a top-level room file, an image
 * file under `assets/<aa>/`, or a board's history index or version file. Restore accepts nothing else from a manifest.
 * @param {unknown} rel
 */
export function isBackupPath(rel) {
  if (typeof rel !== 'string') return false;
  if (rel === 'directory.sqlite' || rel === 'chat.sqlite' || ROOM_FILE_RE.test(rel) || assetHashOf(rel) !== null) return true;
  const parts = rel.split('/');
  if (parts.length !== 3 || parts[0] !== 'history' || !BOARD_ID_RE.test(parts[1])) return false;
  if (parts[2] === 'index.json') return true;
  return parts[2].endsWith('.yjs.gz') && VERSION_ID_RE.test(parts[2].slice(0, -'.yjs.gz'.length));
}

/**
 * The protections in a stored `backup.protected` value: manifest name to expiry (ms). `active` holds the ones that have
 * not expired at `nowMs`; `changed` says whether the stored value holds anything else (expired or malformed entries).
 * Throws when the value is not a JSON object at all, so a caller can fail closed.
 * @param {string | null | undefined} stored
 * @param {number} nowMs
 * @returns {{ active: Record<string, number>, changed: boolean }}
 */
export function parseProtections(stored, nowMs) {
  if (stored === null || stored === undefined || stored === '') return { active: {}, changed: false };
  const value = JSON.parse(stored);
  if (!isObject(value)) throw new Error('not an object');
  const active = {};
  let changed = false;
  for (const [name, until] of Object.entries(value)) {
    if (parseManifestName(name) !== null && Number.isFinite(until) && until > nowMs) active[name] = until;
    else changed = true;
  }
  return { active, changed };
}

/** '20261008T193000Z.json.enc' for a time in ms. */
export function formatManifestName(ms) {
  return `${new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g, '')}.json.enc`;
}

/** The time in ms of a manifest file name, or null when it is not one. */
export function parseManifestName(name) {
  const m = typeof name === 'string' ? MANIFEST_NAME_RE.exec(name) : null;
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  return formatManifestName(ms) === name ? ms : null;
}

/**
 * Which manifests a backup keeps: the newest per UTC hour while younger than `keepHourlyHours`, the newest per UTC day
 * while younger than `keepDailyDays`, and always the newest. Everything else is `drop`. Names that are not manifest
 * names are never dropped, and neither are the `protectedNames` (the safety backups of a restore).
 * @param {string[]} names
 * @param {number} nowMs
 * @param {{ keepHourlyHours: number, keepDailyDays: number, protectedNames?: Iterable<string> }} limits
 */
export function pruneManifests(names, nowMs, { keepHourlyHours, keepDailyDays, protectedNames = [] }) {
  const items = names
    .map((name) => ({ name, at: parseManifestName(name) }))
    .filter((item) => item.at !== null)
    .sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1));
  const keep = new Set(items.length ? [items[0].name] : []);
  const known = new Set(items.map((item) => item.name));
  for (const name of protectedNames) if (known.has(name)) keep.add(name);
  const hours = new Set();
  const days = new Set();
  for (const { name, at } of items) {
    const age = Math.max(0, nowMs - at);
    if (age <= keepHourlyHours * HOUR_MS && keepHourlyHours > 0) {
      const bucket = Math.floor(at / HOUR_MS);
      if (!hours.has(bucket)) {
        hours.add(bucket);
        keep.add(name);
      }
    }
    if (age <= keepDailyDays * DAY_MS && keepDailyDays > 0) {
      const bucket = Math.floor(at / DAY_MS);
      if (!days.has(bucket)) {
        days.add(bucket);
        keep.add(name);
      }
    }
  }
  return { keep, drop: items.filter((item) => !keep.has(item.name)).map((item) => item.name) };
}

// ---------------------------------------------------------------- SigV4

/** RFC 3986 encoding of one path segment or query component. S3 signs the path as it is sent, encoded once. */
export const encodeSegment = (value) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** An object key with its slashes kept. */
export const encodeKeyPath = (key) => key.split('/').map(encodeSegment).join('/');

/** @param {[string, string][]} pairs */
export function canonicalQuery(pairs) {
  return pairs
    .map(([name, value]) => [encodeSegment(name), encodeSegment(value)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

/** 'YYYYMMDDTHHMMSSZ' */
export const amzDate = (ms) => new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g, '');

/**
 * AWS Signature Version 4. `headers` is exactly the set that is signed (lower case or not), `date` is the x-amz-date
 * value. `canonicalUri` is the path as it is sent, already encoded. Returns the pieces, so tests can compare each step
 * with the published examples.
 * @param {object} request
 */
export function signRequest({ method, canonicalUri, query = [], headers, payloadHash, date, region, service = 's3', accessKey, secretKey }) {
  const lowered = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), String(value).trim().replace(/\s+/g, ' ')])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const signedHeaders = lowered.map(([name]) => name).join(';');
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery(query),
    lowered.map(([name, value]) => `${name}:${value}\n`).join(''),
    signedHeaders,
    payloadHash,
  ].join('\n');
  const day = date.slice(0, 8);
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256Hex(canonicalRequest)].join('\n');
  let signingKey = hmac(`AWS4${secretKey}`, day);
  for (const part of [region, service, 'aws4_request']) signingKey = hmac(signingKey, part);
  const signature = hmac(signingKey, stringToSign).toString('hex');
  return {
    canonicalRequest,
    stringToSign,
    signature,
    signedHeaders,
    credentialScope: scope,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * Where a request for `key` goes: path style puts the bucket in the path, virtual hosted style in the host name.
 * `host` is what the Host header carries (a port that is not the default stays), `canonicalUri` is the signed path.
 * @param {{ endpoint: string, bucket: string, key?: string, pathStyle: boolean, query?: [string, string][] }} target
 */
export function s3Target({ endpoint, bucket, key = '', pathStyle, query = [] }) {
  const base = new URL(endpoint);
  const host = pathStyle ? base.host : `${bucket}.${base.host}`;
  const keyPath = key ? encodeKeyPath(key) : '';
  const canonicalUri = pathStyle ? `/${encodeSegment(bucket)}${keyPath ? `/${keyPath}` : ''}` : `/${keyPath}`;
  const qs = canonicalQuery(query);
  return { host, canonicalUri, url: `${base.protocol}//${host}${canonicalUri}${qs ? `?${qs}` : ''}` };
}

// ---------------------------------------------------------------- XML (the little S3 needs)

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/g, (match, entity) => {
    if (entity[0] === '#') {
      const cp = entity[1] === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : match;
    }
    return XML_ENTITIES[entity] ?? match;
  });
}

function tagEnd(text, from) {
  let quote = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  return -1;
}

/**
 * A strict little XML reader for S3 answers: elements and text only (attributes are skipped, namespaces dropped).
 * A DOCTYPE, an unbalanced tag, text outside the root, or a document that is too deep or too large is refused.
 * @param {string} text
 * @returns {{ name: string, text: string, children: any[] }}
 */
export function parseXml(text) {
  const bad = () => new BackupError('s3', 'The storage provider sent an answer that could not be read');
  if (typeof text !== 'string' || text.length > MAX_LIST_BYTES) throw bad();
  const stack = [];
  let root = null;
  let nodes = 0;
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    const chunk = text.slice(i, lt === -1 ? text.length : lt);
    if (stack.length) stack[stack.length - 1].text += decodeEntities(chunk);
    else if (chunk.trim()) throw bad();
    if (lt === -1) break;
    if (text.startsWith('<?', lt) || text.startsWith('<!--', lt)) {
      const close = text.startsWith('<?', lt) ? '?>' : '-->';
      const end = text.indexOf(close, lt + 2);
      if (end === -1) throw bad();
      i = end + close.length;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end === -1 || !stack.length) throw bad();
      stack[stack.length - 1].text += text.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (text.startsWith('<!', lt)) throw bad();
    const gt = tagEnd(text, lt + 1);
    if (gt === -1) throw bad();
    const inner = text.slice(lt + 1, gt);
    i = gt + 1;
    if (inner.startsWith('/')) {
      const closing = /^\/\s*(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)\s*$/.exec(inner);
      const open = stack.pop();
      if (!closing || !open || open.name !== closing[1]) throw bad();
      continue;
    }
    const m = /^(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)(?:\s[^]*)?$/.exec(inner.replace(/\/$/, ''));
    if (!m || ++nodes > MAX_XML_NODES || stack.length >= MAX_XML_DEPTH) throw bad();
    const node = { name: m[1], text: '', children: [] };
    if (stack.length) stack[stack.length - 1].children.push(node);
    else if (root) throw bad();
    else root = node;
    if (!inner.endsWith('/')) stack.push(node);
  }
  if (!root || stack.length) throw bad();
  return root;
}

const childText = (node, name) => node.children.find((c) => c.name === name)?.text;

/**
 * A ListObjectsV2 answer. Entries that look wrong (no key, a size or time that does not parse) are left out, which can
 * only make the caller more careful: nothing it cannot read is ever deleted.
 * @param {string} xml
 * @returns {{ contents: { key: string, size: number, lastModified: number }[], truncated: boolean, next: string | null }}
 */
export function parseListXml(xml) {
  const root = parseXml(xml);
  if (root.name !== 'ListBucketResult') throw new BackupError('s3', 'The storage provider sent an unexpected bucket listing');
  const contents = [];
  for (const node of root.children) {
    if (node.name !== 'Contents') continue;
    const key = childText(node, 'Key');
    const size = childText(node, 'Size');
    const modified = Date.parse(childText(node, 'LastModified') ?? '');
    if (typeof key !== 'string' || key.length === 0 || key.length > 1024 || /\p{Cc}/u.test(key)) continue;
    if (typeof size !== 'string' || !/^\d{1,15}$/.test(size) || !Number.isFinite(modified)) continue;
    contents.push({ key, size: Number(size), lastModified: modified });
  }
  const truncated = childText(root, 'IsTruncated') === 'true';
  const next = childText(root, 'NextContinuationToken') ?? '';
  if (truncated && (next.length === 0 || next.length > 2048)) throw new BackupError('s3', 'The storage provider sent an unusable bucket listing');
  return { contents, truncated, next: truncated ? next : null };
}

/** The S3 error code of an error answer, or null. */
export function parseErrorCode(xml) {
  try {
    const root = parseXml(xml);
    const code = root.name === 'Error' ? childText(root, 'Code')?.trim() : undefined;
    return code && S3_CODE_RE.test(code) ? code : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- S3 client

const EMPTY = Buffer.alloc(0);

function networkCode(err) {
  const code = err?.cause?.code ?? err?.code;
  return typeof code === 'string' && ERRNO_RE.test(code) ? code : null;
}

/**
 * The five S3 calls the backup needs, signed with SigV4. A request is retried up to `backoffMs.length` times on a
 * network error, a timeout, a 5xx or a 429, and never on another 4xx. Errors are BackupErrors with a status and an S3
 * error code and nothing else.
 * @param {object} options endpoint, region, bucket, accessKey, secretKey, pathStyle; fetch, now, setTimeout, clearTimeout, signal, requestTimeoutMs, backoffMs for tests
 */
export function createS3Client({
  endpoint,
  region,
  bucket,
  accessKey,
  secretKey,
  pathStyle = true,
  fetch: fetchFn = (...args) => globalThis.fetch(...args),
  now = Date.now,
  setTimeout: setTimer = (...args) => globalThis.setTimeout(...args),
  clearTimeout: clearTimer = (...args) => globalThis.clearTimeout(...args),
  signal = null,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  backoffMs = BACKOFF_MS,
}) {
  const sleep = (ms) =>
    new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimer(timer);
        reject(aborted());
      };
      const timer = setTimer(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve(undefined);
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });

  async function once(method, key, query, body, payloadHash, maxBytes, notFoundOk) {
    const date = amzDate(now());
    const target = s3Target({ endpoint, bucket, key, pathStyle, query });
    const headers = { host: target.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': date };
    const { authorization } = signRequest({ method, canonicalUri: target.canonicalUri, query, headers, payloadHash, date, region, accessKey, secretKey });
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const res = await fetchFn(target.url, {
        method,
        headers: { 'x-amz-content-sha256': payloadHash, 'x-amz-date': date, authorization },
        body: method === 'PUT' ? body : undefined,
        redirect: 'manual',
        signal: combined,
      });
      const status = res.status;
      const header = res.headers?.get?.('content-length');
      const declared = header === null || header === undefined || header === '' ? NaN : Number(header);
      const sizeHeader = Number.isFinite(declared) ? declared : null;
      if (status >= 200 && status < 300) {
        if (method === 'HEAD') return { status, size: sizeHeader, body: EMPTY };
        if (sizeHeader !== null && sizeHeader > maxBytes) throw new BackupError('too_large', 'The storage provider sent more data than expected');
        const data = Buffer.from(await res.arrayBuffer());
        if (data.length > maxBytes) throw new BackupError('too_large', 'The storage provider sent more data than expected');
        return { status, size: data.length, body: data };
      }
      let s3Code = null;
      if (method !== 'HEAD' && (sizeHeader === null || sizeHeader <= MAX_ERROR_BODY)) {
        const text = Buffer.from(await res.arrayBuffer()).subarray(0, MAX_ERROR_BODY).toString('utf8');
        s3Code = parseErrorCode(text);
      } else {
        await res.body?.cancel?.().catch(() => {});
      }
      if (status === 404 && notFoundOk) return { status, size: null, body: EMPTY };
      const detail = `${status}${s3Code ? `, ${s3Code}` : ''}`;
      if (status === 429 || status >= 500) {
        throw new BackupError('s3', `S3 ${method} failed (status ${detail})`, { status, s3Code, retryable: true });
      }
      if (status >= 300 && status < 400) throw new BackupError('s3', `S3 ${method} was redirected (status ${status}); check the endpoint and region`, { status });
      throw new BackupError('s3', `S3 ${method} failed (status ${detail})`, { status, s3Code });
    } catch (err) {
      if (signal?.aborted) throw aborted();
      if (err instanceof BackupError) throw err;
      if (timeout.aborted || err?.name === 'TimeoutError') throw new BackupError('timeout', `S3 ${method} timed out`, { retryable: true });
      const code = networkCode(err);
      throw new BackupError('network', `S3 ${method} could not reach the storage provider${code ? ` (${code})` : ''}`, { retryable: true });
    }
  }

  async function request(method, key, { query = [], body = EMPTY, maxBytes = MAX_LIST_BYTES, notFoundOk = false } = {}) {
    const payloadHash = sha256Hex(body);
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw aborted();
      try {
        return await once(method, key, query, body, payloadHash, maxBytes, notFoundOk);
      } catch (err) {
        if (!err?.retryable || attempt >= backoffMs.length) throw err;
      }
      await sleep(backoffMs[attempt]);
    }
  }

  return {
    async put(key, body) {
      await request('PUT', key, { body });
    },
    /** @returns {Promise<Buffer>} */
    async get(key, { maxBytes = MAX_MANIFEST_BYTES } = {}) {
      const res = await request('GET', key, { maxBytes, notFoundOk: true });
      if (res.status === 404) throw new BackupError('not_found', 'The backup file is not in the bucket', { status: 404 });
      return res.body;
    },
    /** @returns {Promise<{ size: number | null } | null>} null when the object does not exist */
    async head(key) {
      const res = await request('HEAD', key, { notFoundOk: true });
      return res.status === 404 ? null : { size: res.size };
    },
    async del(key) {
      await request('DELETE', key, { notFoundOk: true });
    },
    /** Every key under `prefix`, page after page. */
    async list(prefix) {
      const contents = [];
      let token = null;
      const seen = new Set();
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const query = [['list-type', '2'], ['prefix', prefix]];
        if (token) query.push(['continuation-token', token]);
        const res = await request('GET', '', { query });
        const parsed = parseListXml(res.body.toString('utf8'));
        for (const item of parsed.contents) if (item.key.startsWith(prefix)) contents.push(item);
        if (!parsed.next) return contents;
        if (seen.has(parsed.next)) throw new BackupError('s3', 'The storage provider repeated a page of the bucket listing');
        seen.add(parsed.next);
        token = parsed.next;
      }
      throw new BackupError('s3', 'The bucket listing has too many pages');
    },
  };
}

// ---------------------------------------------------------------- manifests

function parseManifest(bytes, keys, name) {
  const bad = (what) => new BackupError('invalid_manifest', `The backup manifest is not valid (${what})`);
  let data;
  try {
    data = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw bad('not JSON');
  }
  if (!isObject(data) || data.version !== FORMAT_VERSION) throw bad('version');
  if (data.keyId !== keys.keyId) throw bad('key id');
  if (typeof data.createdAt !== 'string' || !Array.isArray(data.files) || data.files.length > MAX_MANIFEST_FILES) throw bad('fields');
  let snapshotBarrier = null;
  if (data.snapshotBarrier !== undefined) {
    const barrier = data.snapshotBarrier;
    if (
      !isObject(barrier) ||
      barrier.completed !== true ||
      !Number.isSafeInteger(barrier.snapshotSeq) || barrier.snapshotSeq < 1 ||
      !Number.isSafeInteger(barrier.startedAt) || barrier.startedAt < 0 ||
      !Number.isSafeInteger(barrier.endedAt) || barrier.endedAt < barrier.startedAt
    ) throw bad('snapshot barrier');
    snapshotBarrier = { completed: true, snapshotSeq: barrier.snapshotSeq, startedAt: barrier.startedAt, endedAt: barrier.endedAt };
  }
  const paths = new Set();
  let total = 0;
  const files = data.files.map((entry) => {
    if (!isObject(entry) || typeof entry.objectId !== 'string' || !OBJECT_ID_RE.test(entry.objectId)) throw bad('file entry');
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw bad('file size');
    const filePath = validateRelPath(entry.path);
    if (paths.has(filePath)) throw bad('duplicate path');
    paths.add(filePath);
    total += entry.size;
    return { path: filePath, size: entry.size, objectId: entry.objectId };
  });
  if (isObject(data.totals) && (data.totals.files !== files.length || data.totals.bytes !== total)) throw bad('totals');
  return {
    name,
    version: FORMAT_VERSION,
    keyId: keys.keyId,
    createdAt: data.createdAt,
    appVersion: typeof data.appVersion === 'string' ? data.appVersion : null,
    ...(snapshotBarrier ? { snapshotBarrier } : {}),
    files,
    totals: { files: files.length, bytes: total },
  };
}

// ---------------------------------------------------------------- the engine

const EMPTY_STATUS = Object.freeze({
  lastSuccessAt: null,
  lastRunAt: null,
  lastError: null,
  lastFailureAt: null,
  lastFailureError: null,
  consecutiveFailures: 0,
  lastManifest: null,
  bytesStored: 0,
  objects: 0,
  manifests: 0,
  prune: null,
  verifiedAt: null,
  verifyChecked: 0,
  missingObjects: 0,
  wrongSizeObjects: 0,
  unrepairableObjects: 0,
  deepVerifiedAt: null,
  deepChecked: 0,
  deepDamaged: 0,
  deepSkipped: 0,
  deepCovered: 0,
  deepSince: null,
  deepCursor: 0,
  deepCycleOk: 0,
  snapshotSeq: 0,
});

/** Kept in the stored status so a restart carries on where the last deep verify stopped, but not part of what status() shows. */
const INTERNAL_STATUS = ['deepSince', 'deepCursor', 'deepCycleOk', 'snapshotSeq'];

const timeOrNull = (v) => (Number.isFinite(v) && v >= 0 ? v : null);
const countOr0 = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
const shareOr0 = (v) => (Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0);

function readStatus(directory, scrub) {
  const status = { ...EMPTY_STATUS };
  try {
    const stored = JSON.parse(directory?.getSetting(STATUS_KEY) ?? 'null');
    if (!isObject(stored)) return status;
    status.lastSuccessAt = timeOrNull(stored.lastSuccessAt);
    status.lastRunAt = timeOrNull(stored.lastRunAt);
    status.lastFailureAt = timeOrNull(stored.lastFailureAt);
    status.lastError = typeof stored.lastError === 'string' ? scrub(stored.lastError).slice(0, ERROR_MAX) : null;
    status.lastFailureError = typeof stored.lastFailureError === 'string' ? scrub(stored.lastFailureError).slice(0, ERROR_MAX) : null;
    status.consecutiveFailures = countOr0(stored.consecutiveFailures);
    status.lastManifest = typeof stored.lastManifest === 'string' && parseManifestName(stored.lastManifest) !== null ? stored.lastManifest : null;
    status.bytesStored = countOr0(stored.bytesStored);
    status.objects = countOr0(stored.objects);
    status.manifests = countOr0(stored.manifests);
    status.prune = isObject(stored.prune) ? stored.prune : null;
    status.verifiedAt = timeOrNull(stored.verifiedAt);
    status.verifyChecked = countOr0(stored.verifyChecked);
    status.missingObjects = countOr0(stored.missingObjects);
    status.wrongSizeObjects = countOr0(stored.wrongSizeObjects);
    status.unrepairableObjects = countOr0(stored.unrepairableObjects);
    status.deepVerifiedAt = timeOrNull(stored.deepVerifiedAt);
    status.deepChecked = countOr0(stored.deepChecked);
    status.deepDamaged = countOr0(stored.deepDamaged);
    status.deepSkipped = countOr0(stored.deepSkipped);
    status.deepCovered = shareOr0(stored.deepCovered);
    status.deepSince = timeOrNull(stored.deepSince);
    status.deepCursor = countOr0(stored.deepCursor);
    status.deepCycleOk = countOr0(stored.deepCycleOk);
    status.snapshotSeq = countOr0(stored.snapshotSeq);
  } catch {
    /* unreadable status starts again from nothing */
  }
  return status;
}

const isFileSync = (file) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/**
 * Waits for the worker thread that copies a database. Resolves when it says it is done. Rejects when it reports a failure
 * (an Error with a short `code`, and for SQLite its own wording, never a path), when it crashes or stops without an
 * answer, or, after terminating the worker, when `signal` aborts. `cleanup` runs once a terminated worker is gone.
 * @param {{ on: Function, once: Function, off: Function, terminate: () => unknown }} worker
 * @param {{ signal?: AbortSignal | null, cleanup?: () => void }} [options]
 */
export function waitForCopy(worker, { signal = null, cleanup = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      worker.off('message', onMessage);
      worker.off('exit', onExit);
      fn(value);
    };
    const failed = (code, message) => Object.assign(new Error(message), { code: typeof code === 'string' && ERRNO_RE.test(code) ? code : 'ERROR' });
    const onMessage = (message) => {
      if (message?.ok === true) finish(resolve);
      else finish(reject, failed(message?.code, typeof message?.detail === 'string' ? message.detail : 'The database copy failed'));
    };
    const onError = (err) => finish(reject, failed(err?.code, 'The database copy worker failed'));
    const onExit = (code) => finish(reject, failed('ERR_WORKER_EXIT', `The database copy worker stopped without an answer (exit code ${Number(code)})`));
    function onAbort() {
      finish(reject, aborted());
      let ended;
      try {
        ended = worker.terminate();
      } catch {
        /* a worker that cannot be terminated is gone or about to be */
      }
      Promise.resolve(ended).catch(() => {}).then(cleanup);
    }
    worker.once('message', onMessage);
    // Never removed: an 'error' nobody listens to would be thrown in the main thread.
    worker.on('error', onError);
    worker.once('exit', onExit);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const megabytes = (bytes) => (bytes >= 1024 * 1024 ? `${Math.ceil(bytes / (1024 * 1024))} MB` : `${bytes} bytes`);
const tooLarge = (rel, size, limit) => new BackupError('too_large', `${rel} is ${megabytes(size)}, more than the ${megabytes(limit)} a backup file may be`);

/**
 * What a run leaves in the data directory or the database that only means something to the process that wrote it:
 * the temporary database copies of a run that never finished, and the `running`/`nextRunAt` of the stored status.
 * Called when a volume is adopted (server/volume.mjs), whether or not backups are on, before the engine is created.
 * Everything else is kept: the status's last manifest and counts and `backup.protected` describe the bucket, which a
 * restored copy of the same workspace still shares. Returns how many files went.
 * @param {{ dataDir: string, directory?: any }} options
 */
export function clearRunState({ dataDir, directory = null }) {
  let removed = 0;
  for (const name of fs.readdirSync(dataDir)) {
    if (!STALE_TEMP_RE.test(name) && !STALE_SNAPSHOT_RE.test(name)) continue;
    fs.rmSync(path.join(dataDir, name), { recursive: STALE_SNAPSHOT_RE.test(name), force: true });
    removed++;
  }
  const stored = directory?.getSetting(STATUS_KEY);
  if (typeof stored === 'string') {
    let value = null;
    try {
      value = JSON.parse(stored);
    } catch {
      /* readStatus starts again from nothing; nothing to clear */
    }
    if (isObject(value) && (value.running !== false || value.nextRunAt != null)) {
      directory.setSetting(STATUS_KEY, JSON.stringify({ ...value, running: false, nextRunAt: null }));
    }
  }
  return removed;
}

/**
 * The backup engine. Returns null when backups are off. Nothing here throws out of a timer: a failed run is recorded
 * in the status (and the audit log in accounts mode) and tried again at the next interval.
 *
 * Besides the interval schedule (the heartbeat), `noteChange()` starts a settle timer: a backup shortly after activity
 * stops, and `finish({ budgetMs })` takes a final bounded one on a graceful shutdown (docs/backups.md, When it runs).
 *
 * @param {object} options
 * @param {BackupConfig | null} options.config
 * @param {string} options.dataDir
 * @param {any} [options.directory] accounts mode: where the status is kept and the audit rows go; without it the status lives in memory
 * @param {((room: string) => Uint8Array | null) | null} [options.boardState] the current state of a room that is open (a room name is `<boardId>` or `<boardId>~comments`); null or a room that is not open: its file is read
 * @param {any} [options.snapshotBarrier] shared with the relay and directory so writers pause during local snapshot copies
 * @param {() => void} [options.prepareSnapshot] saves open rooms after writers pause and before their files are copied
 * @param {(...args: any[]) => void} [options.log]
 * @param {any} [options.fetch]
 * @param {() => number} [options.now]
 * @param {any} [options.setTimeout]
 * @param {any} [options.clearTimeout]
 * @param {() => number} [options.random]
 * @param {number} [options.requestTimeoutMs] tests only
 * @param {number[]} [options.backoffMs] tests only: the waits before each retry of a request
 * @param {number} [options.maxFileBytes] tests only; the limit is MAX_FILE_BYTES
 * @param {(file: URL, options: object) => any} [options.workerFactory] tests only: starts the thread that copies a database (the default is `new Worker`)
 */
export function createBackup({
  config,
  dataDir,
  directory = null,
  boardState = null,
  snapshotBarrier: sharedSnapshotBarrier = null,
  prepareSnapshot = () => {},
  log = (...args) => console.error(...args),
  fetch: fetchFn = (...args) => globalThis.fetch(...args),
  now = Date.now,
  setTimeout: setTimer = (...args) => globalThis.setTimeout(...args),
  clearTimeout: clearTimer = (...args) => globalThis.clearTimeout(...args),
  random = Math.random,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  backoffMs = BACKOFF_MS,
  maxFileBytes = MAX_FILE_BYTES,
  workerFactory = (file, options) => new Worker(file, options),
}) {
  if (!config) return null;

  const hasSharedSnapshotBarrier = sharedSnapshotBarrier !== null;
  const snapshotBarrier = sharedSnapshotBarrier ?? createSnapshotBarrier({
    maxHoldMs: (config.snapshotMaxHoldSeconds ?? DEFAULT_SNAPSHOT_MAX_HOLD_SECONDS) * 1000,
    now,
  });

  const scrub = createScrubber(config.secrets ?? []);
  const say = (message) => {
    try {
      log(`backup: ${scrub(message)}`);
    } catch {
      /* a broken logger must not break a backup */
    }
  };
  const describe = (err) => {
    if (err instanceof BackupError) return scrub(err.message).slice(0, ERROR_MAX);
    const code = typeof err?.code === 'string' && ERRNO_RE.test(err.code) ? err.code : null;
    return scrub(`${code ?? err?.name ?? 'Error'}: ${err?.message ?? ''}`).slice(0, ERROR_MAX);
  };

  const keyring = createKeyring([config.key, ...(config.previousKeys ?? [])]);
  const keys = keyring.current;
  const stop = new AbortController();
  const s3Options = {
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
    pathStyle: config.pathStyle,
    fetch: fetchFn,
    now,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    requestTimeoutMs,
    backoffMs,
  };
  const backupDir = config.dir ?? path.resolve(dataDir, 'backup-export');
  const createClient = (signal) => config.target === 'dir'
    ? createDirClient({ dir: backupDir, signal })
    : createS3Client({ ...s3Options, signal });
  const s3 = createClient(stop.signal);
  /** The deep verify in progress, if any: it runs outside a run and gives way to any run, a shutdown and stop(). */
  let deepCtl = null;
  let deepPromise = null;
  /** Aborts the deep verify in progress, its request in flight included. True when there was one. */
  function cancelDeep() {
    if (!deepCtl || deepCtl.signal.aborted) return false;
    deepCtl.abort(aborted());
    return true;
  }

  const intervalMs = config.intervalMinutes * MINUTE_MS;
  const settleMs = (config.settleSeconds ?? DEFAULT_SETTLE_SECONDS) * 1000;
  const settleCapMs = Math.max(SETTLE_MAX_WAIT_MS, settleMs);
  const verifyMs = (config.verifyHours ?? DEFAULT_VERIFY_HOURS) * HOUR_MS;
  const verifyBudget = (config.verifyMaxMb ?? DEFAULT_VERIFY_MAX_MB) * 1024 * 1024;
  const trackChanges = settleMs > 0 || (config.shutdownSeconds ?? DEFAULT_SHUTDOWN_SECONDS) > 0;
  const prefix = config.prefix;
  const objectKey = (id) => `${prefix}/objects/${id}`;
  const manifestKey = (name) => `${prefix}/manifests/${name}`;

  let state = readStatus(directory, scrub);
  let running = false;
  let started = false;
  let stopped = false;
  let finishing = false;
  let finishPromise = null;
  let timer = null;
  let nextRunAt = null;
  let inFlight = null;
  let tempFile = null;
  // Settle: the first change not in a backup yet (null: nothing to back up), the last change, and a counter that tells
  // whether anything was noted while a run was going (clocks can stand still, a counter cannot).
  let dirtySince = null;
  let lastChangeAt = null;
  let changeSeq = 0;
  let firstChangeInRun = null;
  let retryNotBefore = 0;
  let settleTimer = null;
  let lastTrigger = null;
  /** Objects this process has seen in the bucket, so an unchanged file is not asked about again every run. */
  let verified = new Set();
  /** Objects uploaded by a run that did not get as far as its manifest: asked about before they are uploaded again. */
  const unpublished = new Set();
  /**
   * Objects a kept manifest names that are missing in the bucket, have the wrong size ('listing', found by every cleanup) or
   * whose contents do not decrypt ('deep', found by the deep verify). A run uploads such an object again whenever a file
   * still has that content, whatever it knows about the object. Kept in memory only: object ids never go into the status.
   * @type {Map<string, 'listing' | 'deep'>}
   */
  const suspect = new Map();
  // What an earlier process found damaged and could not name any more: shown until a whole rotation has looked again.
  let forgottenDamaged = state.deepDamaged;
  if (forgottenDamaged > 0) state = { ...state, deepCursor: 0, deepCycleOk: 0 };

  function persist() {
    try {
      directory?.setSetting(STATUS_KEY, JSON.stringify({ ...state, nextRunAt, running: false }));
    } catch (err) {
      say(`could not store the status (${describe(err)})`);
    }
  }

  function auditRow(action, detail) {
    try {
      directory?.audit(null, action, detail);
    } catch (err) {
      say(`could not write the audit row (${describe(err)})`);
    }
  }

  // ------------------------------------------------------------ read side

  /** Newest first. */
  async function listManifests() {
    const dir = `${prefix}/manifests/`;
    const items = await s3.list(dir);
    return items
      .map((item) => ({ name: item.key.slice(dir.length), size: item.size, lastModified: item.lastModified }))
      .filter((item) => MANIFEST_NAME_RE.test(item.name))
      .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  }

  async function readManifest(name) {
    if (parseManifestName(name) === null) throw new BackupError('invalid_manifest', 'Not a backup manifest name');
    const sealed = await s3.get(manifestKey(name), { maxBytes: MAX_MANIFEST_BYTES });
    const { plaintext, keys: used } = unseal(sealed, `manifest:${name}`, keyring);
    return parseManifest(plaintext, used, name);
  }

  /**
   * The file behind an object id, verified twice: the GCM tag (with the id in the additional data) and the keyed hash
   * of the plaintext, which must be the id. A different expected hash can be passed to check against a manifest, and
   * `maxSealedBytes` to refuse an object that is larger than the manifest says (too_large) without reading it.
   * @param {string} objectId
   * @param {{ expectedPlaintextHmac?: string, maxSealedBytes?: number, client?: ReturnType<typeof createS3Client> | ReturnType<typeof createDirClient> }} [options]
   */
  async function readObject(objectId, { expectedPlaintextHmac, maxSealedBytes, client = s3 } = {}) {
    if (typeof objectId !== 'string' || !OBJECT_ID_RE.test(objectId)) throw new BackupError('not_found', 'Not a backup object id');
    const sealed = await client.get(objectKey(objectId), { maxBytes: maxSealedBytes ?? MAX_FILE_BYTES + OVERHEAD });
    const { plaintext, keys: used } = unseal(sealed, `obj:${objectId}`, keyring);
    const mac = objectIdOf(plaintext, used);
    if (mac !== objectId || (expectedPlaintextHmac !== undefined && expectedPlaintextHmac !== mac)) {
      throw new BackupError('content_mismatch', 'The backup object does not contain what its name says');
    }
    return plaintext;
  }

  // ------------------------------------------------------------ what gets backed up

  // Not an error when a file cannot be removed: a worker that was just stopped can still hold it (Windows), and the
  // next start removes what is left (cleanStaleTemps).
  function removeTemp(file) {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try {
        fs.rmSync(`${file}${suffix}`, { force: true });
      } catch {
        /* see above */
      }
    }
  }

  function cleanStaleTemps() {
    try {
      for (const name of fs.readdirSync(dataDir)) {
        if (STALE_TEMP_RE.test(name)) fs.rmSync(path.join(dataDir, name), { force: true });
        else if (STALE_SNAPSHOT_RE.test(name)) fs.rmSync(path.join(dataDir, name), { recursive: true, force: true });
      }
    } catch (err) {
      say(`could not clean up old temporary files (${describe(err)})`);
    }
  }

  /** Both SQLite steps of the copy run in a worker thread, so the event loop of the server is not held (docs/backups.md, When it runs). */
  async function copyInOtherThread(source, tmp, snapshotSignal) {
    let worker;
    try {
      worker = workerFactory(COPY_WORKER_URL, {
        workerData: { job: COPY_JOB, source, tmp, statusKey: STATUS_KEY },
        // The worker gets none of this process's environment (the backup key and the S3 credentials are in it), and does not repeat Node's one time SQLite notice.
        env: {},
        execArgv: ['--disable-warning=ExperimentalWarning'],
      });
    } catch (err) {
      if (hasSharedSnapshotBarrier) throw new BackupError('copy_worker', 'The database copy worker could not be started');
      say(`the database copy could not be started in a worker thread (${describe(err)}); copying in the main thread`);
      await copyDatabase(source, tmp, STATUS_KEY);
      return;
    }
    await waitForCopy(worker, { signal: AbortSignal.any([stop.signal, snapshotSignal]), cleanup: () => removeTemp(tmp) });
  }

  /**
   * A consistent copy of a database (directory.sqlite or chat.sqlite), taken while the server uses it. The directory's
   * copy leaves out the engine's own rows; the chat database has none.
   */
  async function copyDatabaseFile(source, rel, snapshotSignal) {
    const tmp = path.join(dataDir, `${rel}.backup-${crypto.randomBytes(8).toString('hex')}.tmp`);
    tempFile = tmp;
    try {
      await copyInOtherThread(source, tmp, snapshotSignal);
      const size = fs.statSync(tmp).size;
      if (size > maxFileBytes) throw tooLarge(rel, size, maxFileBytes);
      const data = await fs.promises.readFile(tmp, { signal: snapshotSignal });
      // The file change counter (and the copy of it SQLite keeps for validity) counts the writes made to this temporary
      // copy, which differ from run to run. SQLite recomputes it, so a fixed value keeps an unchanged database unchanged.
      if (data.length >= 100 && data.toString('latin1', 0, 15) === 'SQLite format 3') {
        data.writeUInt32BE(1, 24);
        data.writeUInt32BE(1, 92);
      }
      return data;
    } finally {
      removeTemp(tmp);
      tempFile = null;
    }
  }

  async function readCapped(file, rel, signal) {
    const size = (await fs.promises.stat(file)).size;
    if (size > maxFileBytes) throw tooLarge(rel, size, maxFileBytes);
    const data = await fs.promises.readFile(file, signal ? { signal } : undefined);
    if (data.length > maxFileBytes) throw tooLarge(rel, data.length, maxFileBytes);
    return data;
  }

  const readIfThere = async (file, rel, signal) => {
    try {
      return await readCapped(file, rel, signal);
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  };

  /** One file at a time, so only one is in memory. `skipped` counts what was left out because it vanished or is damaged. */
  async function* snapshotFiles(counters, signal) {
    const database = path.join(dataDir, 'directory.sqlite');
    if (isFileSync(database)) yield { path: 'directory.sqlite', data: await copyDatabaseFile(database, 'directory.sqlite', signal) };
    // Team chat (docs/chat.md) keeps its own database, copied the same way; it exists once chat was first used.
    const chat = path.join(dataDir, 'chat.sqlite');
    if (isFileSync(chat)) yield { path: 'chat.sqlite', data: await copyDatabaseFile(chat, 'chat.sqlite', signal) };

    const names = (await fs.promises.readdir(dataDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && ROOM_FILE_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    for (const file of names) {
      const room = file.slice(0, -'.yjs'.length);
      let data = null;
      if (boardState) {
        try {
          const live = boardState(room);
          if (live) data = Buffer.from(live.buffer, live.byteOffset, live.byteLength);
        } catch (err) {
          say(`could not read the open room ${room} (${describe(err)}); using its file`);
        }
        if (data && data.length > maxFileBytes) throw tooLarge(file, data.length, maxFileBytes);
      }
      data ??= await readIfThere(path.join(dataDir, file), file, signal);
      if (data) yield { path: file, data };
      else counters.skipped++;
    }

    // Images: one file per distinct content, never changed once written, so after the first run an asset costs nothing again.
    // The name is the SHA-256 of the bytes; a file that no longer matches its name is damaged and is left out, so a restore
    // never meets it.
    const assetsRoot = path.join(dataDir, 'assets');
    let shards = [];
    try {
      shards = (await fs.promises.readdir(assetsRoot, { withFileTypes: true })).filter((e) => e.isDirectory() && /^[0-9a-f]{2}$/.test(e.name)).map((e) => e.name).sort();
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    for (const shard of shards) {
      let names = [];
      try {
        names = (await fs.promises.readdir(path.join(assetsRoot, shard), { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name).sort();
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
      for (const name of names) {
        const rel = `assets/${shard}/${name}`;
        if (assetHashOf(rel) === null) continue;
        const data = await readIfThere(path.join(assetsRoot, shard, name), rel, signal);
        if (!data) {
          counters.skipped++;
          continue;
        }
        if (crypto.createHash('sha256').update(data).digest('hex') !== name) {
          say('an image file does not match its name; it is left out of the backup');
          counters.skipped++;
          continue;
        }
        yield { path: rel, data };
      }
    }

    const root = path.join(dataDir, 'history');
    let boards = [];
    try {
      boards = (await fs.promises.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory() && BOARD_ID_RE.test(e.name)).map((e) => e.name).sort();
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    for (const board of boards) {
      // The index comes first; only the versions it lists are read, and the index stored lists only the ones that were.
      const rawIndex = await readIfThere(path.join(root, board, 'index.json'), `history/${board}/index.json`, signal);
      if (!rawIndex) continue;
      let index;
      try {
        index = JSON.parse(rawIndex.toString('utf8'));
        if (index?.v !== 1 || !Array.isArray(index.versions)) throw new Error('shape');
      } catch {
        say(`the version history index of a board is unreadable; its history is left out`);
        counters.skipped++;
        continue;
      }
      const ids = [...new Set(index.versions.map((v) => v?.id).filter((id) => typeof id === 'string' && VERSION_ID_RE.test(id)))];
      const present = new Set();
      for (const id of ids) {
        const rel = `history/${board}/${id}.yjs.gz`;
        const data = await readIfThere(path.join(root, board, `${id}.yjs.gz`), rel, signal);
        if (!data) continue;
        present.add(id);
        yield { path: rel, data };
      }
      const complete = index.versions.every((v) => present.has(v?.id));
      const stored = complete ? rawIndex : Buffer.from(JSON.stringify({ ...index, versions: index.versions.filter((v) => present.has(v?.id)) }));
      yield { path: `history/${board}/index.json`, data: stored };
    }
  }

  /**
   * Makes every backup input a local file before releasing writers. Uploads only ever read this private snapshot tree,
   * so a slow bucket cannot lengthen the write hold or mix source files from different times.
   */
  async function stageSnapshot(counters) {
    const root = path.join(dataDir, `.backup-snapshot-${crypto.randomBytes(8).toString('hex')}`);
    fs.mkdirSync(root, { mode: 0o700 });
    const files = [];
    try {
      say('snapshot barrier started');
      const snapshot = await snapshotBarrier.withSnapshot({
        signal: stop.signal,
        prepare: prepareSnapshot,
        capture: async ({ signal }) => {
          const combinedSignal = AbortSignal.any([signal, stop.signal]);
          // Relay integration tests need a deterministic window in which to send a websocket update. This is inert
          // unless the test-only variable is explicitly set, and the barrier's normal timeout still bounds it.
          const testDelayMs = testCaptureDelayMs();
          if (testDelayMs > 0) {
            if (combinedSignal.aborted) throw combinedSignal.reason ?? aborted();
            await new Promise((resolve, reject) => {
              const timer = setTimeout(() => {
                combinedSignal.removeEventListener('abort', onAbort);
                resolve();
              }, testDelayMs);
              const onAbort = () => {
                clearTimeout(timer);
                reject(combinedSignal.reason ?? aborted());
              };
              combinedSignal.addEventListener('abort', onAbort, { once: true });
            });
          }
          for await (const file of snapshotFiles(counters, combinedSignal)) {
            if (combinedSignal.aborted) throw combinedSignal.reason ?? aborted();
            const rel = validateRelPath(file.path);
            const local = path.join(root, ...rel.split('/'));
            await fs.promises.mkdir(path.dirname(local), { recursive: true, mode: 0o700 });
            await fs.promises.writeFile(local, file.data, { flag: 'wx', mode: 0o600, signal: combinedSignal });
            files.push({ path: rel, size: file.data.length });
          }
          return { changeSeqAtCapture: changeSeq };
        },
      });
      say(`snapshot barrier released after ${snapshot.endedAt - snapshot.startedAt} ms`);
      return { root, files, startedAt: snapshot.startedAt, endedAt: snapshot.endedAt, changeSeqAtCapture: snapshot.value.changeSeqAtCapture };
    } catch (err) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch (cleanupError) {
        say(`could not remove the local snapshot copy (${describe(cleanupError)})`);
      }
      if (stop.signal.aborted) throw aborted();
      if (err?.code === 'snapshot_timeout') say(`snapshot barrier exceeded ${snapshotBarrier.maxHoldMs} ms; writers were released and the snapshot will retry`);
      throw err;
    }
  }

  // ------------------------------------------------------------ one run

  /** The objects the deep verify found damaged that are not put right yet; a count from an earlier process, whose ids are gone, stays until a rotation is complete. */
  function syncDeepDamaged() {
    let found = 0;
    for (const kind of suspect.values()) if (kind === 'deep') found++;
    const shown = Math.max(found, forgottenDamaged);
    if (shown !== state.deepDamaged) state = { ...state, deepDamaged: shown };
  }

  async function putObject(objectId, data) {
    const sealed = seal(data, `obj:${objectId}`, keys);
    await s3.put(objectKey(objectId), sealed);
    return sealed.length;
  }

  async function execute(startedAt) {
    cleanStaleTemps();
    const listed = await listManifests();
    let previous = null;
    if (listed.length) {
      try {
        previous = await readManifest(listed[0].name);
      } catch (err) {
        const transient = err?.code === 'network' || err?.code === 'timeout' || err?.code === 'aborted' || (err?.code === 's3' && (err.status === 429 || err.status >= 500));
        if (!(err instanceof BackupError) || transient) throw err;
        say(`the newest manifest could not be read (${err.code}); everything is uploaded again`);
      }
    }
    const reusable = new Set(previous && previous.keyId === keys.keyId ? previous.files.map((f) => f.objectId) : []);

    const counters = { skipped: 0 };
    const entries = [];
    const handled = new Set();
    const uploaded = new Map();
    let repaired = 0;
    const snapshot = await stageSnapshot(counters);
    try {
      for (const file of snapshot.files) {
        if (stop.signal.aborted) throw aborted();
        const data = await readCapped(path.join(snapshot.root, ...file.path.split('/')), file.path, stop.signal);
        const objectId = objectIdOf(data, keys);
        entries.push({ path: file.path, size: data.length, objectId });
        if (handled.has(objectId)) continue;
        handled.add(objectId);
        if (suspect.has(objectId)) {
          // A cleanup or a deep verify found this object damaged; whatever else is known about it, put it again.
          repaired++;
        } else if (reusable.has(objectId) || unpublished.has(objectId)) {
          if (verified.has(objectId) && reusable.has(objectId)) continue;
          const found = await s3.head(objectKey(objectId));
          if (found && (found.size === null || found.size === data.length + OVERHEAD)) continue;
          if (reusable.has(objectId)) repaired++;
        }
        uploaded.set(objectId, await putObject(objectId, data));
        unpublished.add(objectId);
      }
      entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

      const unchanged =
        previous !== null &&
        previous.keyId === keys.keyId &&
        previous.files.length === entries.length &&
        previous.files.every((f, i) => f.path === entries[i].path && f.objectId === entries[i].objectId);

    // Every object is checked before a manifest names it, so a bad upload never leaves a manifest behind.
      for (const [objectId, sealedLength] of uploaded) {
        const found = await s3.head(objectKey(objectId));
        if (!found || (found.size !== null && found.size !== sealedLength)) {
          throw new BackupError('readback', 'An uploaded backup object could not be found again in the bucket');
        }
        suspect.delete(objectId);
      }
      syncDeepDamaged();

      let manifest = previous;
      let manifestName = previous?.name ?? null;
      let snapshotSeq = previous?.snapshotBarrier?.snapshotSeq ?? state.snapshotSeq;
      if (!unchanged) {
        const taken = new Set(listed.map((m) => m.name));
        let at = startedAt;
        while (taken.has(formatManifestName(at))) at += 1000;
        manifestName = formatManifestName(at);
        snapshotSeq = Math.max(state.snapshotSeq, previous?.snapshotBarrier?.snapshotSeq ?? 0) + 1;
        const body = {
          version: FORMAT_VERSION,
          keyId: keys.keyId,
          createdAt: new Date(startedAt).toISOString(),
          appVersion: VERSION,
          snapshotBarrier: { completed: true, snapshotSeq, startedAt: snapshot.startedAt, endedAt: snapshot.endedAt },
          files: entries,
          totals: { files: entries.length, bytes: entries.reduce((sum, e) => sum + e.size, 0) },
        };
        const bytes = Buffer.from(JSON.stringify(body), 'utf8');
        await s3.put(manifestKey(manifestName), seal(bytes, `manifest:${manifestName}`, keys));
        try {
          const back = unseal(await s3.get(manifestKey(manifestName), { maxBytes: MAX_MANIFEST_BYTES }), `manifest:${manifestName}`, keyring);
          if (!back.plaintext.equals(bytes)) throw new BackupError('readback', 'The manifest read back from the bucket is not the one that was written');
          manifest = parseManifest(back.plaintext, back.keys, manifestName);
        } catch (err) {
          await s3.del(manifestKey(manifestName)).catch(() => {});
          if (err instanceof BackupError && (err.code === 'readback' || err.code === 'aborted')) throw err;
          throw new BackupError('readback', `The manifest could not be read back from the bucket (${err?.code ?? 'error'})`);
        }
      }
      verified = new Set(manifest.files.map((f) => f.objectId));
      unpublished.clear();

      const unique = new Map(manifest.files.map((f) => [f.objectId, f.size]));
      return {
        objects: unique,
        changed: !unchanged,
        manifestName,
        files: manifest.files.length,
        uploaded: uploaded.size,
        repaired,
        skipped: counters.skipped,
        snapshotSeq,
        changeSeqAtCapture: snapshot.changeSeqAtCapture,
        bytesStored: [...unique.values()].reduce((sum, size) => sum + size + OVERHEAD, 0),
        bytesUploaded: [...uploaded.values()].reduce((sum, n) => sum + n, 0),
      };
    } finally {
      try {
        fs.rmSync(snapshot.root, { recursive: true, force: true });
      } catch (err) {
        say(`could not remove the local snapshot copy (${describe(err)})`);
      }
    }
  }

  /**
   * The manifests a restore has protected from pruning (restore.mjs writes them): names whose protection has not run out.
   * The ones that ran out are dropped from the stored value. null when the value cannot be read, which stops the prune.
   */
  function activeProtections(nowMs) {
    if (!directory) return [];
    try {
      const { active, changed } = parseProtections(directory.getSetting(PROTECTED_KEY), nowMs);
      if (changed) directory.setSetting(PROTECTED_KEY, JSON.stringify(active));
      return Object.keys(active);
    } catch {
      return null;
    }
  }

  /**
   * Old manifests first, then objects nothing refers to (older than an hour), and only on complete knowledge. The listing
   * of the objects and the manifests that were read are also what tells whether every object a kept manifest names is
   * there with the size it should have (`outcome.verify`; counts only), and the ones that are not become suspect.
   * @param {string} newestName
   * @param {number} nowMs
   * @param {Map<string, number>} newestObjects the objects of the newest manifest, with their sizes
   */
  async function prune(newestName, nowMs, newestObjects) {
    const outcome = { at: nowMs, manifestsDeleted: 0, objectsDeleted: 0, gcSkipped: null, error: null, manifests: null, objects: null, verify: null };
    try {
      const listed = await listManifests();
      outcome.manifests = listed.length;
      if (!listed.some((m) => m.name === newestName)) {
        outcome.gcSkipped = 'inconsistent_listing';
        return outcome;
      }
      const protectedNames = activeProtections(nowMs);
      if (protectedNames === null) {
        outcome.gcSkipped = 'unreadable_protection';
        say('the list of protected backups could not be read, so nothing is deleted this time');
        return outcome;
      }
      const { drop } = pruneManifests(listed.map((m) => m.name), nowMs, { keepHourlyHours: config.keepHourlyHours, keepDailyDays: config.keepDailyDays, protectedNames });
      for (const name of drop) {
        if (name === newestName) continue;
        await s3.del(manifestKey(name));
        outcome.manifestsDeleted++;
      }
      const kept = listed.filter((m) => !drop.includes(m.name));
      outcome.manifests = kept.length;

      const dir = `${prefix}/objects/`;
      const objects = (await s3.list(dir)).filter((item) => OBJECT_ID_RE.test(item.key.slice(dir.length)));
      outcome.objects = objects.length;
      const referenced = new Map();
      let unreadable = 0;
      for (const item of kept) {
        try {
          for (const file of (await readManifest(item.name)).files) referenced.set(file.objectId, file.size);
        } catch (err) {
          if (err?.code === 'aborted') throw err;
          unreadable++;
        }
      }
      outcome.verify = verifyListing(objects, dir, referenced, newestObjects, nowMs, unreadable > 0);
      if (unreadable) {
        outcome.gcSkipped = 'unreadable_manifest';
        say(`${unreadable} manifest(s) could not be read, so no objects are deleted this time`);
        return outcome;
      }
      for (const item of objects) {
        const id = item.key.slice(dir.length);
        if (referenced.has(id) || nowMs - item.lastModified <= GC_GRACE_MS) continue;
        await s3.del(objectKey(id));
        outcome.objectsDeleted++;
      }
      outcome.objects = objects.length - outcome.objectsDeleted;
    } catch (err) {
      outcome.error = describe(err);
      say(`pruning failed (${outcome.error})`);
    }
    return outcome;
  }

  /**
   * Compares what the kept manifests name with the bucket listing: an object that is not listed is missing, one whose listed
   * size is not its size plus the sealing overhead is the wrong size. Both are suspect until a run has put them again.
   * With a manifest that could not be read, only what the readable ones name is known, so nothing is forgotten.
   * @param {{ key: string, size: number }[]} objects
   * @param {string} dir
   * @param {Map<string, number>} referenced
   * @param {Map<string, number>} newestObjects
   * @param {number} at
   * @param {boolean} partial
   */
  function verifyListing(objects, dir, referenced, newestObjects, at, partial) {
    const listedSizes = new Map(objects.map((item) => [item.key.slice(dir.length), item.size]));
    const found = new Set();
    let missing = 0;
    let wrongSize = 0;
    for (const [id, size] of referenced) {
      const listed = listedSizes.get(id);
      if (listed === undefined) missing++;
      else if (listed === size + OVERHEAD) continue;
      else wrongSize++;
      found.add(id);
    }
    if (!partial) {
      for (const [id, kind] of suspect) {
        if (!referenced.has(id) || (kind === 'listing' && !found.has(id))) suspect.delete(id);
      }
    }
    for (const id of found) if (!suspect.has(id)) suspect.set(id, 'listing');
    syncDeepDamaged();
    let unrepairable = 0;
    for (const id of suspect.keys()) if (!newestObjects.has(id)) unrepairable++;
    return { at, checked: referenced.size, missing, wrongSize, unrepairable };
  }

  function recordSuccess(startedAt, summary, pruned) {
    const finishedAt = now();
    state = {
      ...state,
      lastRunAt: startedAt,
      lastSuccessAt: finishedAt,
      lastError: null,
      consecutiveFailures: 0,
      lastManifest: summary.manifestName,
      snapshotSeq: Math.max(state.snapshotSeq, summary.snapshotSeq ?? 0),
      bytesStored: summary.bytesStored,
      objects: pruned.objects ?? state.objects,
      manifests: pruned.manifests ?? state.manifests,
      prune: { at: pruned.at, manifestsDeleted: pruned.manifestsDeleted, objectsDeleted: pruned.objectsDeleted, gcSkipped: pruned.gcSkipped, error: pruned.error },
      deepSince: state.deepSince ?? startedAt,
      ...(pruned.verify
        ? {
            verifiedAt: pruned.verify.at,
            verifyChecked: pruned.verify.checked,
            missingObjects: pruned.verify.missing,
            wrongSizeObjects: pruned.verify.wrongSize,
            unrepairableObjects: pruned.verify.unrepairable,
          }
        : {}),
    };
    persist();
    // A run that found nothing to do is in the status (lastSuccessAt) but not in the audit log: at hourly that would be 24 rows a day of nothing.
    if (summary.changed || summary.uploaded > 0 || summary.repaired > 0 || pruned.manifestsDeleted > 0 || pruned.objectsDeleted > 0) {
      auditRow('backup.run', {
        changed: summary.changed,
        files: summary.files,
        uploaded: summary.uploaded,
        repaired: summary.repaired,
        bytes: summary.bytesUploaded,
        skipped: summary.skipped,
        manifestsDeleted: pruned.manifestsDeleted,
        objectsDeleted: pruned.objectsDeleted,
      });
    }
    say(
      summary.changed
        ? `ok: ${summary.files} files, ${summary.uploaded} uploaded, manifest ${summary.manifestName}`
        : `ok: nothing changed (${summary.files} files)`,
    );
  }

  /**
   * Reads and decrypts a slice of the newest manifest's objects (the GCM tag and the keyed hash, as a restore would), within
   * `verifyBudget` sealed bytes, in the order of the sorted object ids, starting where the last deep verify stopped. An
   * object whose bytes are not the object is suspect, so the next run puts it again; the network or the provider failing is
   * not damage, ends this check, and the object is the first one the next check looks at. Never throws. Its requests go
   * through a client of its own whose signal `ctl` aborts, so a run, a shutdown or stop() cut even a read in progress short.
   * @param {Map<string, number>} objects the newest manifest's objects with their sizes
   * @param {AbortController} ctl
   */
  async function deepVerify(objects, ctl) {
    const client = createClient(AbortSignal.any([stop.signal, ctl.signal]));
    const cut = () => ctl.signal.aborted || finishing || stop.signal.aborted;
    const ids = [...objects.keys()].sort();
    const total = ids.length;
    let at = state.deepCursor < total ? state.deepCursor : 0;
    let cycleOk = at === 0 ? 0 : state.deepCycleOk;
    let spent = 0;
    let checked = 0;
    let skipped = 0;
    let damaged = 0;
    let interrupted = false;
    let stalled = null;
    for (; at < total; at++) {
      if (cut()) {
        interrupted = true;
        break;
      }
      const id = ids[at];
      const sealedSize = objects.get(id) + OVERHEAD;
      if (sealedSize > verifyBudget) {
        skipped++;
        continue;
      }
      if (spent + sealedSize > verifyBudget) break;
      try {
        await readObject(id, { maxSealedBytes: sealedSize, client });
      } catch (err) {
        if (err?.code === 'aborted' || cut()) {
          interrupted = true;
          break;
        }
        if (!DAMAGE_CODES.has(err?.code)) {
          skipped++;
          stalled = err;
          break;
        }
        suspect.set(id, 'deep');
        damaged++;
      }
      spent += sealedSize;
      checked++;
      cycleOk++;
    }
    if (damaged) say(`the deep check found ${damaged} damaged object(s); the next run puts them again where a file still has the content`);
    if (stalled) say(`the deep check stopped early (${describe(stalled)})`);
    const complete = !interrupted && !stalled && at >= total;
    if (complete) forgottenDamaged = 0;
    let unrepairable = 0;
    for (const id of suspect.keys()) if (!objects.has(id)) unrepairable++;
    state = {
      ...state,
      deepChecked: checked,
      deepSkipped: skipped,
      deepCovered: total === 0 ? 1 : Math.min(1, cycleOk / total),
      deepCursor: complete ? 0 : at,
      deepCycleOk: complete ? 0 : cycleOk,
      unrepairableObjects: unrepairable,
      ...(interrupted || (stalled && checked === 0) ? {} : { deepVerifiedAt: now() }),
    };
    syncDeepDamaged();
  }

  /**
   * Starts the deep verify when it is due (every `verifyHours` hours since the last one, or since the first run), after a
   * run has ended and outside it, so it never holds a run up: the next run, a shutdown's final backup and a restore's
   * safety backup cancel it at once, and it carries on from where it stopped the next time. Never on shutdown.
   */
  function startDeepVerifyIfDue(trigger, objects) {
    if (deepPromise || verifyMs <= 0 || trigger === 'shutdown' || finishing || stopped || stop.signal.aborted) return;
    const since = state.deepVerifiedAt ?? state.deepSince;
    if (since === null || now() - since < verifyMs) return;
    const ctl = new AbortController();
    deepCtl = ctl;
    deepPromise = deepVerify(objects, ctl)
      .then(() => persist())
      .catch((err) => say(`the deep check of the backup failed (${describe(err)})`))
      .finally(() => {
        if (deepCtl === ctl) deepCtl = null;
        deepPromise = null;
      });
  }

  function recordFailure(startedAt, err) {
    const message = describe(err);
    state = {
      ...state,
      lastRunAt: startedAt,
      lastError: message,
      lastFailureAt: now(),
      lastFailureError: message,
      consecutiveFailures: state.consecutiveFailures + 1,
    };
    persist();
    auditRow('backup.failed', { error: message });
    say(`failed: ${message}`);
    return message;
  }

  /** The wait before the next settle attempt after `failures` runs in a row failed: the settle time, doubling up to half an hour. */
  const retryDelay = (failures) => Math.min(settleMs * 2 ** Math.max(0, failures - 1), Math.max(settleMs, SETTLE_RETRY_CAP_MS));

  /**
   * @param {'interval' | 'settle' | 'shutdown' | 'manual'} trigger why this run starts
   */
  async function run(trigger) {
    if (stopped) return { ok: false, aborted: true };
    if (running) return { ok: false, skipped: 'running' };
    // a run, whatever started it, goes before a deep verify; one it interrupted is left to the next run, not started again
    // when this one ends (a restore's safety backup is followed by the restore, which must not share the bucket with it)
    const interrupted = cancelDeep();
    running = true;
    const startedAt = now();
    const seqAtStart = changeSeq;
    firstChangeInRun = null;
    let failed = false;
    let verifyNext = null;
    try {
      const summary = await execute(startedAt);
      const pruned = await prune(summary.manifestName, now(), summary.objects);
      lastTrigger = trigger;
      recordSuccess(startedAt, summary, pruned);
      // After the success is recorded and outside the run: the check can find things to put right at the next run, but it never fails or holds up one.
      verifyNext = summary.objects;
      // What was noted while this run read the files may or may not be in it, so only a quiet run clears the mark.
      retryNotBefore = 0;
      if (changeSeq === (summary.changeSeqAtCapture ?? seqAtStart)) {
        dirtySince = null;
        lastChangeAt = null;
      } else {
        dirtySince = firstChangeInRun ?? dirtySince;
      }
      return { ok: true, changed: summary.changed, manifest: summary.manifestName, files: summary.files, uploaded: summary.uploaded };
    } catch (err) {
      if (err?.code === 'aborted') return { ok: false, aborted: true };
      failed = true;
      if (err?.code === 'snapshot_timeout') {
        dirtySince ??= now();
        lastChangeAt = now();
      }
      lastTrigger = trigger;
      return { ok: false, error: recordFailure(startedAt, err) };
    } finally {
      running = false;
      if (failed && settleMs > 0) retryNotBefore = now() + retryDelay(state.consecutiveFailures);
      afterRun();
      if (verifyNext && !interrupted) startDeepVerifyIfDue(trigger, verifyNext);
    }
  }

  /** Runs a backup now unless one is running. Never rejects. */
  function runNow(trigger = 'manual') {
    const wasRunning = running;
    const promise = run(trigger).catch((err) => ({ ok: false, error: describe(err) }));
    // A call that finds a run going must not replace the promise of that run: stop() and finish() wait for it.
    if (!wasRunning && !stopped) inFlight = promise;
    return promise;
  }

  // ------------------------------------------------------------ schedule

  function schedule(delayMs) {
    if (timer !== null) clearTimer(timer);
    nextRunAt = now() + delayMs;
    timer = setTimer(tick, delayMs);
    timer?.unref?.();
  }

  async function tick() {
    timer = null;
    nextRunAt = null;
    if (stopped || finishing) return;
    try {
      await runNow('interval');
    } catch (err) {
      say(`unexpected failure (${describe(err)})`);
    } finally {
      if (started && !stopped && !finishing) schedule(intervalMs);
    }
  }

  // ------------------------------------------------------------ settle

  function cancelSettle() {
    if (settleTimer !== null) clearTimer(settleTimer);
    settleTimer = null;
  }

  /** The settle timer: quiet for settleMs after the last change, but no later than settleCapMs after the first one, and not before a retry backoff has passed. */
  function armSettle() {
    cancelSettle();
    if (settleMs <= 0 || !started || stopped || finishing || dirtySince === null) return;
    const t = now();
    const due = Math.max(Math.min(lastChangeAt + settleMs, dirtySince + settleCapMs), retryNotBefore, t);
    settleTimer = setTimer(onSettle, due - t);
    settleTimer?.unref?.();
  }

  function onSettle() {
    settleTimer = null;
    if (stopped || finishing || dirtySince === null) return;
    // A run is going: when it ends, afterRun() arms the timer again if something was noted after it started.
    if (running) return;
    void runNow('settle');
  }

  /** After every run: arm the settle timer when there is still something to back up, drop it when there is not. */
  function afterRun() {
    if (dirtySince === null) cancelSettle();
    else armSettle();
  }

  /** Stops everything at once, without waiting for the run in progress to unwind. */
  function halt() {
    stopped = true;
    cancelDeep();
    if (timer !== null) clearTimer(timer);
    timer = null;
    nextRunAt = null;
    cancelSettle();
    stop.abort();
    if (tempFile) removeTemp(tempFile);
  }

  async function runFinal(budgetMs) {
    const outcome = { ran: false, ok: true, timedOut: false };
    finishing = true;
    cancelDeep();
    if (timer !== null) clearTimer(timer);
    timer = null;
    nextRunAt = null;
    cancelSettle();
    if (stopped || !(budgetMs > 0)) return outcome;
    if (!running && dirtySince === null) return outcome;

    // One timer for the whole budget, raced against both steps, so the total can never be longer than the budget.
    let expired = false;
    let budgetTimer = null;
    const budget = new Promise((resolve) => {
      budgetTimer = setTimer(() => {
        expired = true;
        resolve(undefined);
      }, budgetMs);
    });
    try {
      if (running && inFlight) await Promise.race([inFlight, budget]);
      if (!expired && !stopped && dirtySince !== null) {
        outcome.ran = true;
        const result = await Promise.race([runNow('shutdown'), budget]);
        outcome.ok = result?.ok === true;
      }
      if (expired && (running || dirtySince !== null)) {
        outcome.timedOut = true;
        outcome.ok = false;
        say('the final backup did not finish in time and was stopped');
        halt();
      }
    } finally {
      if (budgetTimer !== null) clearTimer(budgetTimer);
    }
    return outcome;
  }

  return {
    keyId: keys.keyId,
    /** The first run comes 1 to 5 minutes after start (so a restart loop does not hammer the bucket), then every interval. */
    start() {
      if (started || stopped) return;
      started = true;
      schedule(FIRST_RUN_MIN_MS + Math.floor(random() * FIRST_RUN_SPAN_MS));
    },
    /** Cancels the schedule and aborts a run in progress; resolves once it has stopped. */
    async stop() {
      halt();
      await inFlight?.catch(() => {});
      await deepPromise;
    },
    /** Tests: resolves when no deep verify is going. */
    deepIdle() {
      return deepPromise ?? Promise.resolve();
    },
    /**
     * Something in the data directory changed (a room was saved, an API call wrote). Marks the workspace dirty and arms
     * the settle timer; nothing else. Cheap, synchronous, never throws, and nothing at all once stopped or when both
     * the settle and the shutdown backup are off.
     */
    noteChange() {
      try {
        if (!started || stopped || !trackChanges) return;
        const t = now();
        changeSeq++;
        lastChangeAt = t;
        dirtySince ??= t;
        if (running) firstChangeInRun ??= t;
        armSettle();
      } catch {
        /* a change that cannot be noted is found by the next interval run */
      }
    },
    /**
     * Graceful shutdown: waits for a run in progress and, if anything changed since the last backup, takes one more,
     * all within `budgetMs`. When the budget ends the run is aborted (the manifest comes last, so nothing half written is
     * ever visible). Resolves within the budget and never throws; nothing is requested from the bucket when nothing changed.
     * The caller still calls stop().
     * @param {{ budgetMs?: number }} [options]
     * @returns {Promise<{ ran: boolean, ok: boolean, timedOut: boolean }>}
     */
    finish({ budgetMs } = {}) {
      finishPromise ??= runFinal(Number(budgetMs)).catch((err) => {
        say(`the final backup failed (${describe(err)})`);
        return { ran: false, ok: false, timedOut: false };
      });
      return finishPromise;
    },
    runNow,
    status() {
      const shown = { ...state };
      for (const name of INTERNAL_STATUS) delete shown[name];
      return {
        enabled: true,
        target: config.target ?? 's3',
        running,
        keyId: keys.keyId,
        intervalMinutes: config.intervalMinutes,
        settleSeconds: settleMs / 1000,
        dirty: dirtySince !== null,
        lastTrigger,
        ...shown,
        nextRunAt,
      };
    },
    listManifests,
    readManifest,
    readObject,
  };
}
