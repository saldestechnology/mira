import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.json\.enc$/;
const OBJECT_ID_RE = /^[a-f0-9]{64}$/;
const SLUG_RE = /^[a-z0-9-]{1,63}$/;
const WORKSPACE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})*$/;
const SKIP_STATES = new Set(['suspended', 'deleted', 'provisioning']);
const VALID_STATES = new Set(['running', 'stopped', ...SKIP_STATES]);

export class PullerError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'PullerError';
    this.code = code;
  }
}

function fail(code) {
  throw new PullerError(code);
}

function asMs(now) {
  const value = typeof now === 'function' ? now() : now ?? Date.now();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') return Date.parse(value);
  return Number(value);
}

function asIso(now) {
  const ms = asMs(now);
  if (!Number.isFinite(ms)) fail('invalid_clock');
  return new Date(ms).toISOString();
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}

function validateWorkspace(workspace) {
  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) fail('invalid_workspace');
  if (Object.keys(workspace).some((key) => !['id', 'slug', 'state'].includes(key))) fail('invalid_workspace');
  if (typeof workspace.id !== 'string' || !WORKSPACE_ID_RE.test(workspace.id)) fail('invalid_workspace_id');
  if (typeof workspace.slug !== 'string' || !SLUG_RE.test(workspace.slug)) fail('invalid_workspace_slug');
  if (typeof workspace.state !== 'string' || !VALID_STATES.has(workspace.state)) fail('invalid_workspace_state');
  return workspace;
}

export function pullToken(pullMaster, workspaceId) {
  if (typeof pullMaster !== 'string' || pullMaster.length === 0) fail('invalid_pull_master');
  if (typeof workspaceId !== 'string' || !WORKSPACE_ID_RE.test(workspaceId)) fail('invalid_workspace_id');
  return crypto.createHmac('sha256', Buffer.from(pullMaster, 'utf8'))
    .update(`tabula-backup-pull/${workspaceId}`, 'utf8')
    .digest('base64url');
}

export function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail('invalid_config');
  const required = [
    'storeDir', 'stateDir', 'pullMasterFile', 'workspacesFile', 'prefix', 'baseUrlTemplate',
    'concurrency', 'keepDaily', 'keepWeekly', 'objectGraceDays', 'metricsFile', 'requestTimeoutSeconds',
  ];
  const keys = Object.keys(config);
  if (keys.some((key) => !required.includes(key)) || required.some((key) => !Object.hasOwn(config, key))) fail('invalid_config_fields');
  for (const key of ['storeDir', 'stateDir', 'pullMasterFile', 'workspacesFile', 'metricsFile']) {
    if (typeof config[key] !== 'string' || !path.isAbsolute(config[key]) || path.resolve(config[key]) === path.parse(config[key]).root) fail(`invalid_${key}`);
  }
  if (typeof config.prefix !== 'string' || !PREFIX_RE.test(config.prefix)) fail('invalid_prefix');
  if (typeof config.baseUrlTemplate !== 'string' || (config.baseUrlTemplate.match(/\{slug\}/g) ?? []).length !== 1) fail('invalid_base_url_template');
  try {
    const url = new URL(config.baseUrlTemplate.replace('{slug}', 'workspace-placeholder'));
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('invalid_base_url_template');
  } catch {
    fail('invalid_base_url_template');
  }
  const integer = (key, min, max) => {
    if (!Number.isSafeInteger(config[key]) || config[key] < min || config[key] > max) fail(`invalid_${key}`);
  };
  integer('concurrency', 1, 32);
  integer('keepDaily', 0, 3650);
  integer('keepWeekly', 0, 520);
  integer('objectGraceDays', 1, 36500);
  integer('requestTimeoutSeconds', 1, 3600);
  return { ...config };
}

function validatePrefix(prefix) {
  if (typeof prefix !== 'string' || !PREFIX_RE.test(prefix)) fail('invalid_prefix');
  return prefix;
}

function validateKey(key, expectedPrefix, type) {
  if (typeof key !== 'string' || key.length > 512 || !/^[A-Za-z0-9._/-]+$/.test(key) || key.startsWith('/')) fail('invalid_key');
  const parts = key.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) fail('invalid_key');
  const expected = `${expectedPrefix}/${type}/`;
  if (!key.startsWith(expected)) fail('invalid_key');
  const name = key.slice(expected.length);
  if (!name || name.includes('/')) fail('invalid_key');
  if (type === 'objects' && !OBJECT_ID_RE.test(name)) fail('invalid_key');
  if (type === 'manifests' && parseManifestName(name) === null) fail('invalid_key');
  return key;
}

export function parseManifestName(name) {
  const match = typeof name === 'string' ? MANIFEST_RE.exec(name) : null;
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(ms);
  const formatted = `${date.toISOString().replace(/[-:]|\.\d{3}/g, '')}.json.enc`;
  return formatted === name ? ms : null;
}

async function ensureDirectoryTree(directory) {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  const pieces = absolute.slice(root.length).split(path.sep).filter(Boolean);
  for (const piece of pieces) {
    current = path.join(current, piece);
    let stat;
    try {
      stat = await fs.promises.lstat(current);
    } catch (error) {
      if (!isMissing(error)) throw new PullerError('filesystem_error');
      try {
        await fs.promises.mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (mkdirError?.code !== 'EEXIST') throw new PullerError('filesystem_error');
      }
      try {
        stat = await fs.promises.lstat(current);
      } catch {
        throw new PullerError('filesystem_error');
      }
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('unsafe_path');
  }
  if (absolute !== root) {
    try {
      await fs.promises.chmod(absolute, 0o700);
    } catch {
      throw new PullerError('filesystem_error');
    }
  }
  return absolute;
}

async function inspectDirectoryTree(directory) {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  try {
    const rootStat = await fs.promises.lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('unsafe_path');
  } catch {
    fail('unsafe_path');
  }
  for (const piece of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, piece);
    let stat;
    try {
      stat = await fs.promises.lstat(current);
    } catch (error) {
      if (isMissing(error)) return false;
      throw new PullerError('filesystem_error');
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('unsafe_path');
  }
  return true;
}

async function safeLstat(file) {
  try {
    return await fs.promises.lstat(file);
  } catch (error) {
    if (isMissing(error)) return null;
    throw new PullerError('filesystem_error');
  }
}

async function safeExistingFile(file) {
  const stat = await safeLstat(file);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) fail('unsafe_path');
  return stat;
}

async function atomicWriteFile(file, data, mode = 0o600) {
  const parent = await ensureDirectoryTree(path.dirname(file));
  const target = path.join(parent, path.basename(file));
  await safeExistingFile(target);
  const temp = path.join(parent, `.${path.basename(file)}.tmp-${crypto.randomBytes(8).toString('hex')}`);
  let handle;
  try {
    handle = await fs.promises.open(temp, 'wx', mode);
    await handle.writeFile(data);
    await handle.sync();
    await handle.chmod(mode);
    await handle.close();
    handle = null;
    await ensureDirectoryTree(parent);
    await safeExistingFile(target);
    await fs.promises.rename(temp, target);
    const dir = await fs.promises.open(parent, fs.constants.O_RDONLY);
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch {
    await handle?.close().catch(() => {});
    await fs.promises.rm(temp, { force: true }).catch(() => {});
    throw new PullerError('filesystem_error');
  }
}

async function readJsonSafe(file, fallback) {
  if (!(await inspectDirectoryTree(path.dirname(file)))) return fallback;
  const stat = await safeExistingFile(file);
  if (!stat) return fallback;
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    throw new PullerError('invalid_state_file');
  }
}

function safeFailureCode(error) {
  if (error instanceof PullerError && /^[a-z0-9_]{1,64}$/.test(error.code)) return error.code;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'request_timeout';
  return 'request_failed';
}

function emit(log, message) {
  if (typeof log === 'function') log(message);
}

function header(response, name) {
  if (response?.headers?.get) return response.headers.get(name);
  const key = Object.keys(response?.headers ?? {}).find((value) => value.toLowerCase() === name.toLowerCase());
  return key ? response.headers[key] : null;
}

function retryAfterMs(response, now) {
  const value = header(response, 'retry-after');
  if (value === null || value === undefined || value === '') return null;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - asMs(now);
  return Number.isFinite(ms) ? Math.max(0, Math.min(60_000, ms)) : null;
}

async function requestWithRetry({ fetcher, url, token, timeoutMs, now, limits }) {
  const retries = limits.retries ?? 3;
  const sleep = limits.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const baseBackoffMs = limits.baseBackoffMs ?? 1000;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let response;
    try {
      const signal = typeof limits.timeoutSignal === 'function'
        ? limits.timeoutSignal(timeoutMs)
        : typeof globalThis.AbortSignal?.timeout === 'function' ? globalThis.AbortSignal.timeout(timeoutMs) : undefined;
      response = await fetcher(url, { method: 'GET', headers: { authorization: `Bearer ${token}` }, signal });
    } catch {
      if (attempt >= retries) throw new PullerError('network_error');
      await sleep(Math.min(60_000, baseBackoffMs * (2 ** attempt)));
      continue;
    }
    if (response.status === 401) throw new PullerError('http_401');
    if (response.status === 404) throw new PullerError('route_disabled');
    if ([429, 502, 503, 504].includes(response.status)) {
      if (attempt >= retries) throw new PullerError(`http_${response.status}`);
      const delay = response.status === 429 ? retryAfterMs(response, now) : null;
      await sleep(delay ?? Math.min(60_000, baseBackoffMs * (2 ** attempt)));
      continue;
    }
    if (!response.ok) throw new PullerError(`http_${response.status}`);
    return response;
  }
  throw new PullerError('request_failed');
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    throw new PullerError('invalid_list_response');
  }
}

async function* bodyChunks(response) {
  const body = response.body;
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) yield Buffer.from(chunk);
    return;
  }
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        yield Buffer.from(item.value);
      }
    } finally {
      reader.releaseLock?.();
    }
    return;
  }
  if (typeof response.arrayBuffer === 'function') {
    yield Buffer.from(await response.arrayBuffer());
    return;
  }
  fail('empty_response_body');
}

async function writeAll(handle, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const result = await handle.write(chunk, offset, chunk.length - offset);
    if (!result.bytesWritten) fail('filesystem_error');
    offset += result.bytesWritten;
  }
}

async function localFileMatches(workspaceDir, key, size) {
  const file = path.join(workspaceDir, ...key.split('/'));
  if (!(await inspectDirectoryTree(path.dirname(file)))) return false;
  const stat = await safeExistingFile(file);
  return Boolean(stat && stat.size === size);
}

async function downloadAtomic({ workspaceDir, key, expectedSize, response }) {
  const parts = key.split('/');
  const parent = await ensureDirectoryTree(path.join(workspaceDir, ...parts.slice(0, -1)));
  const target = path.join(parent, parts.at(-1));
  await safeExistingFile(target);
  const temp = path.join(parent, `.${parts.at(-1)}.tmp-${crypto.randomBytes(8).toString('hex')}`);
  let handle;
  let size = 0;
  try {
    handle = await fs.promises.open(temp, 'wx', 0o600);
    for await (const chunk of bodyChunks(response)) {
      size += chunk.length;
      if (size > expectedSize) fail('size_mismatch');
      await writeAll(handle, chunk);
    }
    if (size !== expectedSize) fail('size_mismatch');
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    handle = null;
    await ensureDirectoryTree(parent);
    await safeExistingFile(target);
    await fs.promises.rename(temp, target);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.promises.rm(temp, { force: true }).catch(() => {});
    if (error instanceof PullerError) throw error;
    throw new PullerError('download_failed');
  }
}

async function safeWalkFiles(directory, relative = '') {
  if (!(await inspectDirectoryTree(directory))) return [];
  const stat = await safeLstat(directory);
  if (!stat) return [];
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('unsafe_path');
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!/^[A-Za-z0-9._-]+$/.test(entry.name) || entry.name === '.' || entry.name === '..') fail('unsafe_path');
    const child = path.join(directory, entry.name);
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    const childStat = await fs.promises.lstat(child);
    if (childStat.isSymbolicLink()) fail('unsafe_path');
    if (childStat.isDirectory()) files.push(...await safeWalkFiles(child, rel));
    else if (childStat.isFile()) files.push({ file: child, relative: rel, size: childStat.size });
    else fail('unsafe_path');
  }
  return files;
}

function isoWeekKey(ms) {
  const date = new Date(ms);
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day + 3);
  const weekYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(weekYear, 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return `${weekYear}-W${String(week).padStart(2, '0')}`;
}

function retainedManifestNames(names, nowMs, keepDaily, keepWeekly) {
  const valid = names
    .map((name) => ({ name, at: parseManifestName(name) }))
    .filter((item) => item.at !== null)
    .sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
  const keep = new Set(valid.length ? [valid[0].name] : []);
  const dayStart = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate());
  const dailyStart = dayStart - Math.max(0, keepDaily - 1) * 24 * 60 * 60 * 1000;
  const days = new Set();
  for (const item of valid) {
    if (item.at < dailyStart) continue;
    const day = new Date(item.at).toISOString().slice(0, 10);
    if (!days.has(day) && days.size < keepDaily) {
      keep.add(item.name);
      days.add(day);
    }
  }
  const weekCandidates = valid.filter((item) => item.at < dailyStart);
  const weeks = new Set();
  for (const item of weekCandidates) {
    const week = isoWeekKey(item.at);
    if (!weeks.has(week) && weeks.size < keepWeekly) {
      keep.add(item.name);
      weeks.add(week);
    }
  }
  return keep;
}

async function removeKey(workspaceDir, key) {
  const parts = key.split('/');
  const parent = path.join(workspaceDir, ...parts.slice(0, -1));
  if (!(await inspectDirectoryTree(parent))) return false;
  const stat = await safeLstat(path.join(parent, parts.at(-1)));
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isFile()) fail('unsafe_path');
  await fs.promises.unlink(path.join(parent, parts.at(-1)));
  return true;
}

export async function retention({
  workspaceDir,
  stateDir,
  slug,
  prefix = 'tabula',
  now = Date.now,
  keepDaily = 7,
  keepWeekly = 4,
  objectGraceDays = 35,
  listedObjects = [],
  completeListing = true,
  failed = false,
  dryRun = false,
  log = () => {},
}) {
  validatePrefix(prefix);
  if (failed || !completeListing) return { deleted: [], keptManifests: [] };
  const nowMs = asMs(now);
  const base = path.resolve(workspaceDir);
  await inspectDirectoryTree(base);
  const manifestDir = path.join(base, ...`${prefix}/manifests`.split('/'));
  const manifestFiles = await safeWalkFiles(manifestDir);
  const manifests = manifestFiles.filter((item) => !item.relative.includes('/') && parseManifestName(item.relative) !== null);
  const keep = retainedManifestNames(manifests.map((item) => item.relative), nowMs, keepDaily, keepWeekly);
  const deleted = [];
  for (const item of manifests) {
    if (keep.has(item.relative)) continue;
    const key = `${prefix}/manifests/${item.relative}`;
    deleted.push(key);
    if (dryRun) emit(log, `would delete ${slug ?? ''} ${key}`.trim());
    else await removeKey(base, key);
  }

  const seenFile = stateDir && slug ? path.join(stateDir, `${slug}.seen.json`) : null;
  const savedSeen = seenFile ? await readJsonSafe(seenFile, { lastSeen: {} }) : { lastSeen: {} };
  if (!savedSeen || typeof savedSeen !== 'object' || Array.isArray(savedSeen) || !savedSeen.lastSeen || typeof savedSeen.lastSeen !== 'object' || Array.isArray(savedSeen.lastSeen)) fail('invalid_seen_file');
  const lastSeen = { ...savedSeen.lastSeen };
  for (const item of listedObjects) {
    validateKey(item.key, prefix, 'objects');
    lastSeen[item.key] = new Date(nowMs).toISOString();
  }
  const current = new Set(listedObjects.map((item) => item.key));
  const objectDir = path.join(base, ...`${prefix}/objects`.split('/'));
  const objectFiles = await safeWalkFiles(objectDir);
  const graceMs = objectGraceDays * 24 * 60 * 60 * 1000;
  for (const item of objectFiles) {
    if (/^\..+\.tmp-[a-f0-9]{16}$/.test(item.relative)) continue;
    if (item.relative.includes('/') || !OBJECT_ID_RE.test(item.relative)) fail('invalid_key');
    const key = `${prefix}/objects/${item.relative}`;
    if (current.has(key)) continue;
    const lastSeenAt = Date.parse(lastSeen[key] ?? '');
    if (!Number.isFinite(lastSeenAt) || nowMs - lastSeenAt < graceMs) continue;
    deleted.push(key);
    if (dryRun) emit(log, `would delete ${slug ?? ''} ${key}`.trim());
    else {
      await removeKey(base, key);
      delete lastSeen[key];
    }
  }
  if (seenFile && !dryRun) await atomicWriteFile(seenFile, `${JSON.stringify({ lastSeen }, null, 2)}\n`);
  return { deleted, keptManifests: [...keep].sort() };
}

async function listStoredFiles(workspaceDir, prefix) {
  const root = path.join(workspaceDir, ...prefix.split('/'));
  const files = await safeWalkFiles(root);
  return { files: files.length, bytes: files.reduce((sum, item) => sum + item.size, 0) };
}

function initialState(workspace) {
  return {
    workspaceId: workspace.id,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    files: 0,
    bytes: 0,
    newFiles: 0,
    newBytes: 0,
    lastManifest: null,
  };
}

export async function pullWorkspace({ workspace, baseUrl, token, storeDir, stateDir, fetch: fetcher = globalThis.fetch, now = Date.now, log = () => {}, limits = {} }) {
  validateWorkspace(workspace);
  if (typeof baseUrl !== 'string' || typeof token !== 'string' || !token || typeof fetcher !== 'function') fail('invalid_pull_options');
  const prefix = validatePrefix(limits.prefix ?? 'tabula');
  const root = path.resolve(storeDir);
  const stateRoot = stateDir ? path.resolve(stateDir) : null;
  const workspaceDir = path.join(root, workspace.slug);
  const stateFile = stateRoot ? path.join(stateRoot, `${workspace.slug}.json`) : null;
  const existing = stateFile ? await readJsonSafe(stateFile, initialState(workspace)) : initialState(workspace);
  const state = { ...initialState(workspace), ...existing, workspaceId: workspace.id };
  const attemptedAt = asIso(now);
  state.lastAttemptAt = attemptedAt;
  state.lastError = null;
  state.newFiles = 0;
  state.newBytes = 0;
  const dryRun = limits.dryRun === true;
  if (!dryRun && stateFile) await atomicWriteFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  const timeoutMs = (limits.requestTimeoutSeconds ?? 120) * 1000;
  let firstRequest = true;
  const retryFetch = async (url) => {
    const firstTimeout = firstRequest && workspace.state === 'stopped' ? 60_000 : timeoutMs;
    const response = await requestWithRetry({ fetcher, url, token, timeoutMs: firstTimeout, now, limits });
    firstRequest = false;
    return response;
  };
  let downloadedCount = 0;
  let downloadedBytes = 0;
  try {
    if (dryRun) await inspectDirectoryTree(workspaceDir);
    else {
      await ensureDirectoryTree(root);
      await ensureDirectoryTree(workspaceDir);
    }
    const routeList = async (kind) => {
      const fullPrefix = `${prefix}/${kind}/`;
      const results = [];
      const seen = new Set();
      let after = null;
      for (let page = 0; page < 100_000; page++) {
        const url = new URL('/api/backup-export/list', baseUrl);
        url.searchParams.set('prefix', fullPrefix);
        url.searchParams.set('limit', '1000');
        if (after !== null) url.searchParams.set('after', after);
        const response = await retryFetch(url);
        const body = await responseJson(response);
        if (!body || !Array.isArray(body.keys) || body.keys.length > 1000 || !(body.next === null || typeof body.next === 'string')) fail('invalid_list_response');
        let prior = null;
        for (const item of body.keys) {
          if (!item || typeof item !== 'object') fail('invalid_list_response');
          const key = validateKey(item.key, prefix, kind);
          if (!Number.isSafeInteger(item.size) || item.size < 0 || (prior !== null && key <= prior) || (after !== null && key <= after) || seen.has(key)) fail('invalid_list_response');
          prior = key;
          seen.add(key);
          results.push({ key, size: item.size, lastModified: item.lastModified ?? null });
        }
        if (body.next === null) return results;
        if (typeof body.next !== 'string' || body.next.length > 512 || body.next !== prior || (after !== null && body.next <= after)) fail('invalid_list_response');
        after = body.next;
      }
      throw new PullerError('too_many_list_pages');
    };
    const objects = await routeList('objects');
    const manifests = await routeList('manifests');
    const seenFile = stateRoot ? path.join(stateRoot, `${workspace.slug}.seen.json`) : null;
    if (seenFile && !dryRun) {
      const savedSeen = await readJsonSafe(seenFile, { lastSeen: {} });
      if (!savedSeen || typeof savedSeen !== 'object' || !savedSeen.lastSeen || typeof savedSeen.lastSeen !== 'object' || Array.isArray(savedSeen.lastSeen)) fail('invalid_seen_file');
      const lastSeen = { ...savedSeen.lastSeen };
      const listedAt = asIso(now);
      for (const item of objects) lastSeen[item.key] = listedAt;
      await atomicWriteFile(seenFile, `${JSON.stringify({ lastSeen }, null, 2)}\n`);
    }
    const toPull = [...objects, ...manifests];
    for (const item of toPull) {
      const matches = await localFileMatches(workspaceDir, item.key, item.size);
      if (matches) continue;
      if (dryRun) {
        emit(log, `would fetch ${workspace.slug} ${item.key}`);
        continue;
      }
      const url = new URL('/api/backup-export/object', baseUrl);
      url.searchParams.set('key', item.key);
      emit(log, `fetch ${workspace.slug} ${item.key}`);
      const response = await retryFetch(url);
      await downloadAtomic({ workspaceDir, key: item.key, expectedSize: item.size, response });
      downloadedCount++;
      downloadedBytes += item.size;
      state.newFiles = downloadedCount;
      state.newBytes = downloadedBytes;
    }
    const newestManifest = manifests
      .map((item) => item.key.slice(`${prefix}/manifests/`.length))
      .filter((name) => parseManifestName(name) !== null)
      .sort((a, b) => parseManifestName(b) - parseManifestName(a))[0] ?? null;
    if (!dryRun) {
      await retention({
        workspaceDir,
        stateDir: stateRoot,
        slug: workspace.slug,
        prefix,
        now,
        keepDaily: limits.keepDaily ?? 7,
        keepWeekly: limits.keepWeekly ?? 4,
        objectGraceDays: limits.objectGraceDays ?? 35,
        listedObjects: objects,
        completeListing: true,
        failed: false,
        log,
      });
      const totals = await listStoredFiles(workspaceDir, prefix);
      state.files = totals.files;
      state.bytes = totals.bytes;
      state.lastSuccessAt = asIso(now);
      state.lastError = null;
      state.lastManifest = newestManifest;
      await atomicWriteFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    } else {
      await retention({
        workspaceDir,
        stateDir: stateRoot,
        slug: workspace.slug,
        prefix,
        now,
        keepDaily: limits.keepDaily ?? 7,
        keepWeekly: limits.keepWeekly ?? 4,
        objectGraceDays: limits.objectGraceDays ?? 35,
        listedObjects: objects,
        completeListing: true,
        failed: false,
        dryRun: true,
        log,
      });
    }
    return { ok: true, skipped: false, state: { ...state }, downloadedFiles: downloadedCount, downloadedBytes };
  } catch (error) {
    const code = safeFailureCode(error);
    state.lastError = code;
    state.newFiles = downloadedCount;
    state.newBytes = downloadedBytes;
    if (!dryRun) {
      try {
        const totals = await listStoredFiles(workspaceDir, prefix);
        state.files = totals.files;
        state.bytes = totals.bytes;
      } catch {
        // Keep the last known totals when the store path itself is unsafe or unavailable.
      }
    }
    emit(log, `failed ${workspace.slug} ${code}`);
    if (!dryRun && stateFile) {
      try {
        await atomicWriteFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
      } catch {
        // A broken state path must not turn the error into a message that could reveal request details.
      }
    }
    return { ok: false, skipped: false, state: { ...state }, error: code, downloadedFiles: downloadedCount, downloadedBytes };
  }
}

function metricNumber(value, nowMs, absent = 0) {
  if (value === null || value === undefined) return absent;
  const number = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(number) ? number : absent;
}

function metricSeconds(value, nowMs, absent = 0) {
  return value === null || value === undefined ? absent : Math.floor(metricNumber(value, nowMs, absent) / 1000);
}

function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export async function writeMetrics({ metricsFile, workspaces, states = {}, results = {}, now = Date.now, lastRunAt = now }) {
  const nowMs = asMs(now);
  const lastRunSeconds = Math.floor(asMs(lastRunAt) / 1000);
  const metricDefs = [
    ['tabula_backup_age_seconds', 'Seconds since the last successful backup pull.', 'gauge'],
    ['tabula_backup_last_attempt_timestamp_seconds', 'Unix timestamp of the last backup pull attempt.', 'gauge'],
    ['tabula_backup_last_success_timestamp_seconds', 'Unix timestamp of the last successful backup pull.', 'gauge'],
    ['tabula_backup_stored_bytes', 'Bytes stored locally for the workspace.', 'gauge'],
    ['tabula_backup_files', 'Files stored locally for the workspace.', 'gauge'],
    ['tabula_backup_has_manifest', 'Whether a manifest has been pulled for the workspace.', 'gauge'],
    ['tabula_backup_last_run_ok', 'Whether the last backup pull run succeeded or was intentionally skipped.', 'gauge'],
  ];
  const lines = [];
  for (const [name, help, type] of metricDefs) lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  for (const workspace of workspaces) {
    const state = states[workspace.slug] ?? initialState(workspace);
    const label = `workspace="${escapeLabel(workspace.slug)}"`;
    const success = metricNumber(state.lastSuccessAt, nowMs, NaN);
    const age = Number.isFinite(success) ? Math.max(0, (nowMs - success) / 1000) : 1e12;
    const result = results[workspace.slug];
    const ok = result?.skipped || result?.ok === true ? 1 : result ? 0 : 1;
    lines.push(`tabula_backup_age_seconds{${label}} ${Number.isFinite(age) ? age : 1e12}`);
    lines.push(`tabula_backup_last_attempt_timestamp_seconds{${label}} ${metricSeconds(state.lastAttemptAt, nowMs)}`);
    lines.push(`tabula_backup_last_success_timestamp_seconds{${label}} ${metricSeconds(state.lastSuccessAt, nowMs)}`);
    lines.push(`tabula_backup_stored_bytes{${label}} ${Number.isSafeInteger(state.bytes) && state.bytes >= 0 ? state.bytes : 0}`);
    lines.push(`tabula_backup_files{${label}} ${Number.isSafeInteger(state.files) && state.files >= 0 ? state.files : 0}`);
    lines.push(`tabula_backup_has_manifest{${label}} ${state.lastManifest ? 1 : 0}`);
    lines.push(`tabula_backup_last_run_ok{${label}} ${ok}`);
  }
  lines.push(
    '# HELP tabula_backup_puller_last_run_timestamp_seconds Unix timestamp of the last puller run.',
    '# TYPE tabula_backup_puller_last_run_timestamp_seconds gauge',
    `tabula_backup_puller_last_run_timestamp_seconds ${lastRunSeconds}`,
    '# HELP tabula_backup_workspaces_total Number of configured workspaces.',
    '# TYPE tabula_backup_workspaces_total gauge',
    `tabula_backup_workspaces_total ${workspaces.length}`,
  );
  await atomicWriteFile(metricsFile, `${lines.join('\n')}\n`);
  return `${lines.join('\n')}\n`;
}

async function readMasterFile(file) {
  if (!(await inspectDirectoryTree(path.dirname(file)))) throw new PullerError('pull_master_unavailable');
  let stat;
  try {
    stat = await fs.promises.lstat(file);
  } catch {
    throw new PullerError('pull_master_unavailable');
  }
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o022) !== 0) throw new PullerError('unsafe_pull_master_file');
  let master;
  try {
    master = await fs.promises.readFile(file, 'utf8');
  } catch {
    throw new PullerError('pull_master_unavailable');
  }
  master = master.replace(/\r?\n$/, '');
  if (!master) throw new PullerError('empty_pull_master');
  return master;
}

function parseArguments(argv) {
  const args = { config: null, only: null, dryRun: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--config' && argv[index + 1]) args.config = argv[++index];
    else if (arg === '--only' && argv[index + 1]) args.only = argv[++index];
    else if (arg === '--dry-run') args.dryRun = true;
    else fail('invalid_arguments');
  }
  if (!args.config || (args.only !== null && !SLUG_RE.test(args.only))) fail('invalid_arguments');
  return args;
}

async function runPool(items, concurrency, task) {
  const results = Array.from({ length: items.length });
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await task(items[index]);
      } catch (error) {
        results[index] = { ok: false, skipped: false, error: safeFailureCode(error), state: initialState(items[index]) };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export async function main({ argv = [], env = process.env, fetch: fetcher = globalThis.fetch, now = Date.now, log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  void env;
  let args;
  let config;
  let master;
  let workspaces;
  try {
    args = parseArguments(argv);
    let raw;
    try {
      raw = JSON.parse(await fs.promises.readFile(args.config, 'utf8'));
    } catch {
      throw new PullerError('invalid_config_file');
    }
    config = validateConfig(raw);
    master = await readMasterFile(config.pullMasterFile);
    try {
      workspaces = JSON.parse(await fs.promises.readFile(config.workspacesFile, 'utf8'));
    } catch {
      throw new PullerError('invalid_workspaces_file');
    }
    if (!Array.isArray(workspaces)) throw new PullerError('invalid_workspaces_file');
    const slugs = new Set();
    const ids = new Set();
    for (const workspace of workspaces) {
      validateWorkspace(workspace);
      if (slugs.has(workspace.slug) || ids.has(workspace.id)) throw new PullerError('duplicate_workspace');
      slugs.add(workspace.slug);
      ids.add(workspace.id);
    }
    if (args.only) workspaces = workspaces.filter((workspace) => workspace.slug === args.only);
  } catch (error) {
    emit(log, `configuration error ${safeFailureCode(error)}`);
    return 2;
  }
  if (typeof fetcher !== 'function') {
    emit(log, 'configuration error invalid_fetch');
    return 2;
  }
  const states = {};
  const results = {};
  const runAt = asIso(now);
  const completed = await runPool(workspaces, config.concurrency, async (workspace) => {
    if (SKIP_STATES.has(workspace.state)) {
      const state = await readJsonSafe(path.join(config.stateDir, `${workspace.slug}.json`), initialState(workspace));
      states[workspace.slug] = { ...initialState(workspace), ...state, workspaceId: workspace.id };
      if (!args.dryRun) {
        await atomicWriteFile(path.join(config.stateDir, `${workspace.slug}.json`), `${JSON.stringify(states[workspace.slug], null, 2)}\n`);
      }
      const result = { ok: true, skipped: true, state: states[workspace.slug] };
      results[workspace.slug] = result;
      emit(log, `skipped ${workspace.slug} ${workspace.state}`);
      return result;
    }
    const baseUrl = config.baseUrlTemplate.replace('{slug}', workspace.slug);
    const token = pullToken(master, workspace.id);
    const result = await pullWorkspace({
      workspace,
      baseUrl,
      token,
      storeDir: config.storeDir,
      stateDir: config.stateDir,
      fetch: fetcher,
      now,
      log,
      limits: {
        prefix: config.prefix,
        requestTimeoutSeconds: config.requestTimeoutSeconds,
        keepDaily: config.keepDaily,
        keepWeekly: config.keepWeekly,
        objectGraceDays: config.objectGraceDays,
        dryRun: args.dryRun,
      },
    });
    states[workspace.slug] = result.state;
    results[workspace.slug] = result;
    return result;
  });
  for (let index = 0; index < workspaces.length; index++) {
    const workspace = workspaces[index];
    if (results[workspace.slug]) continue;
    const result = completed[index];
    states[workspace.slug] = result.state;
    results[workspace.slug] = result;
    emit(log, `failed ${workspace.slug} ${result.error}`);
  }
  if (!args.dryRun) {
    try {
      await writeMetrics({ metricsFile: config.metricsFile, workspaces, states, results, now, lastRunAt: runAt });
    } catch {
      emit(log, 'metrics write failed');
    }
  }
  return completed.every((result) => result.ok) ? 0 : 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main({ argv: process.argv.slice(2) }).then((code) => {
    process.exitCode = code;
  }, () => {
    process.exitCode = 2;
  });
}
