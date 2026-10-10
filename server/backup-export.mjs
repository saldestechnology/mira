// Read-only access to the sealed files written by the local backup target (docs/backups.md, "Pulling the export").

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createWindow } from './chat-limits.mjs';
import { createDirClient, isValidDirKey } from './backup-dir-client.mjs';

const MINUTE_MS = 60_000;
const MAX_REQUESTS = 120;
const MAX_OBJECT_BYTES = 400 * 1024 * 1024;
const MAX_LIST_LIMIT = 1000;
const TOKEN_RE = /^Bearer ([A-Za-z0-9._~+\x2f-]+=*)$/;

class ExportRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExportRequestError';
  }
}

function hasBody(req) {
  const length = req.headers['content-length'];
  if (length !== undefined && String(length).trim() !== '0') return true;
  if (req.headers['transfer-encoding']) return true;
  return Number(req.readableLength) > 0;
}

function singleQuery(query, name, { required = false } = {}) {
  const values = query.getAll(name);
  if (values.length > 1 || (required && values.length !== 1)) throw new ExportRequestError(`${name} is required exactly once`);
  return values[0] ?? null;
}

function checkQueryNames(query, allowed) {
  for (const name of query.keys()) if (!allowed.has(name)) throw new ExportRequestError('Unknown query parameter');
}

function listPrefix(value, configuredPrefix) {
  const objects = `${configuredPrefix}/objects`;
  const manifests = `${configuredPrefix}/manifests`;
  if (value === objects || value === `${objects}/`) return `${objects}/`;
  if (value === manifests || value === `${manifests}/`) return `${manifests}/`;
  throw new ExportRequestError('prefix must name the objects or manifests directory');
}

function objectKey(value, configuredPrefix) {
  if (!isValidDirKey(value)) throw new ExportRequestError('key is not a valid backup key');
  if (!value.startsWith(`${configuredPrefix}/objects/`) && !value.startsWith(`${configuredPrefix}/manifests/`)) {
    throw new ExportRequestError('key must be an object or manifest');
  }
  return value;
}

function unauthorized(res, method) {
  return sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' }, method);
}

function sendJson(res, status, body, headers = {}, method = 'GET') {
  const payload = Buffer.from(JSON.stringify(body));
  const responseHeaders = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    ...headers,
  };
  res.writeHead(status, responseHeaders);
  res.end(method === 'HEAD' ? undefined : payload);
  return method === 'HEAD' ? 0 : payload.length;
}

function sendNotFound(res, method) {
  return sendJson(res, 404, { error: 'not_found' }, {}, method);
}

function sendRateLimited(res, retryAfter, method) {
  return sendJson(res, 429, { error: 'rate_limited', message: 'Too many backup export requests. Try again later.' }, {
    'retry-after': String(retryAfter),
  }, method);
}

function createByteWindow(now) {
  let hits = [];
  return {
    wait(bytes) {
      const current = now();
      hits = hits.filter((hit) => hit.at > current - MINUTE_MS);
      if (bytes > MAX_OBJECT_BYTES) return Math.ceil(MINUTE_MS / 1000);
      let over = hits.reduce((total, hit) => total + hit.bytes, bytes) - MAX_OBJECT_BYTES;
      if (over <= 0) return 0;
      for (const hit of hits) {
        over -= hit.bytes;
        if (over <= 0) return Math.max(1, Math.ceil((hit.at + MINUTE_MS - current) / 1000));
      }
      return Math.ceil(MINUTE_MS / 1000);
    },
    record(bytes) {
      if (bytes > 0) hits.push({ at: now(), bytes });
    },
  };
}

function opened(stream) {
  return new Promise((resolve, reject) => {
    stream.once('open', resolve);
    stream.once('error', reject);
  });
}

/**
 * @param {{ backupConfig: object, dataDir: string, now?: () => number, log?: (line: string) => void }} options
 */
export function createBackupExport({ backupConfig, dataDir, now = Date.now, log = () => {} }) {
  if (backupConfig?.target !== 'dir' || typeof backupConfig.pullTokenSha256 !== 'string') {
    throw new TypeError('A directory backup target and pull token hash are required');
  }
  const dir = backupConfig.dir ?? path.resolve(dataDir, 'backup-export');
  const client = createDirClient({ dir });
  const expectedHash = Buffer.from(backupConfig.pullTokenSha256, 'hex');
  const requestWindow = createWindow({ max: MAX_REQUESTS, windowMs: MINUTE_MS }, now);
  const byteWindow = createByteWindow(now);
  const allowedMethods = { list: ['GET'], object: ['GET', 'HEAD'] };

  function logCall(kind, status, bytes) {
    try {
      log(`backup-export: ${kind} ${status} ${bytes} bytes`);
    } catch {
      // A log sink cannot change the result of a public read.
    }
  }

  function authorized(value) {
    if (typeof value !== 'string') return false;
    const match = TOKEN_RE.exec(value);
    if (!match) return false;
    const actualHash = crypto.createHash('sha256').update(match[1]).digest();
    return actualHash.length === expectedHash.length && crypto.timingSafeEqual(actualHash, expectedHash);
  }

  function admit(bytes = 0) {
    const requestWait = requestWindow.wait('workspace');
    const byteWait = bytes > 0 ? byteWindow.wait(bytes) : 0;
    const retryAfter = Math.max(requestWait, byteWait);
    if (retryAfter > 0) return retryAfter;
    requestWindow.record('workspace');
    byteWindow.record(bytes);
    return 0;
  }

  async function handle(kind, { req, res, query, method = String(req.method).toUpperCase() }) {
    let status = 500;
    let bytes = 0;
    try {
      if (hasBody(req)) {
        status = 400;
        bytes = sendJson(res, status, { error: 'bad_request', message: 'This endpoint does not accept a request body' }, {}, method);
        return;
      }
      const methods = allowedMethods[kind];
      if (!methods?.includes(method)) {
        status = 405;
        bytes = sendJson(res, status, { error: 'method_not_allowed', message: 'Method not allowed' }, { allow: methods.join(', ') }, method);
        return;
      }
      if (!authorized(req.headers.authorization)) {
        status = 401;
        bytes = unauthorized(res, method);
        return;
      }

      if (kind === 'list') {
        checkQueryNames(query, new Set(['prefix', 'after', 'limit']));
        const suppliedPrefix = singleQuery(query, 'prefix', { required: true });
        const prefix = listPrefix(suppliedPrefix, backupConfig.prefix);
        const after = singleQuery(query, 'after');
        if (after !== null && !isValidDirKey(after)) throw new ExportRequestError('after is not a valid backup key');
        const rawLimit = singleQuery(query, 'limit');
        let limit = MAX_LIST_LIMIT;
        if (rawLimit !== null) {
          if (!/^\d+$/.test(rawLimit)) throw new ExportRequestError('limit must be a whole number from 1 to 1000');
          limit = Number(rawLimit);
          if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) throw new ExportRequestError('limit must be a whole number from 1 to 1000');
        }
        const retryAfter = admit();
        if (retryAfter) {
          status = 429;
          bytes = sendRateLimited(res, retryAfter, method);
          return;
        }
        const listed = await client.list(prefix);
        const eligible = listed.filter((item) => item.key.startsWith(prefix) && (after === null || item.key > after));
        const page = eligible.slice(0, limit);
        const next = eligible.length > page.length ? page.at(-1).key : null;
        status = 200;
        bytes = sendJson(res, status, { keys: page, next }, {}, method);
        return;
      }

      if (kind !== 'object') throw new Error('Unknown backup export route');
      checkQueryNames(query, new Set(['key']));
      const key = objectKey(singleQuery(query, 'key', { required: true }), backupConfig.prefix);
      const head = await client.head(key);
      if (!head) {
        status = 404;
        bytes = sendNotFound(res, method);
        return;
      }

      if (method === 'HEAD') {
        const retryAfter = admit();
        if (retryAfter) {
          status = 429;
          bytes = sendRateLimited(res, retryAfter, method);
          return;
        }
        status = 200;
        res.writeHead(status, {
          'content-type': 'application/octet-stream',
          'content-length': String(head.size),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        res.end();
        return;
      }

      const stream = client.createReadStream(key);
      if (!stream) {
        status = 404;
        bytes = sendNotFound(res, method);
        return;
      }
      try {
        await opened(stream);
      } catch (err) {
        stream.destroy();
        throw err;
      }
      const stat = fs.fstatSync(stream.fd);
      if (!stat.isFile()) {
        stream.destroy();
        throw new ExportRequestError('key is not a regular file');
      }
      const retryAfter = admit(stat.size);
      if (retryAfter) {
        stream.destroy();
        status = 429;
        bytes = sendRateLimited(res, retryAfter, method);
        return;
      }

      status = 200;
      res.writeHead(status, {
        'content-type': 'application/octet-stream',
        'content-length': String(stat.size),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      await new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        stream.on('data', (chunk) => { bytes += chunk.length; });
        stream.once('error', () => {
          if (!res.writableEnded) res.end();
          done();
        });
        res.once('finish', done);
        res.once('close', () => {
          if (!res.writableFinished) stream.destroy();
          done();
        });
        stream.pipe(res);
      });
    } catch (err) {
      if (!res.headersSent) {
        if (err instanceof ExportRequestError || err?.code === 'invalid_path') {
          status = 400;
          bytes = sendJson(res, status, { error: 'bad_request', message: err.message }, {}, method);
        } else if (err?.code === 'ENOENT') {
          status = 404;
          bytes = sendNotFound(res, method);
        } else {
          status = 500;
          bytes = sendJson(res, status, { error: 'internal', message: 'Something went wrong' }, {}, method);
        }
      } else if (!res.writableEnded) {
        res.end();
      }
    } finally {
      logCall(kind, status, bytes);
    }
  }

  return { handle };
}
