import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { buildIcons } from '../scripts/build-icons.mjs';
import { startRelayProcess } from './start-relay';

let PORT = 0;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-relay-icons-'));
const dist = path.join(root, 'dist');
let relay: ChildProcess;
let manifest: { sets: { p: string; idx: string }[] };
let shardPath: string;
let indexPath: string;

const readManifest = (file: string) => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString());

const get = (urlPath: string, headers: Record<string, string> = {}, method = 'GET') =>
  new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });

beforeAll(async () => {
  const source = path.join(root, 'source');
  fs.mkdirSync(path.join(source, 'json'), { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  fs.writeFileSync(path.join(source, 'json', 'demo.json'), JSON.stringify({
    prefix: 'demo', info: { name: 'Demo', license: { title: 'MIT', spdx: 'MIT' } }, width: 24, height: 24, icons: { home: { body: '<path d="M0 0"/>' } },
  }));
  await buildIcons({ source, out: path.join(dist, 'icons'), pinned: [] });
  manifest = readManifest(path.join(dist, 'icons', 'manifest.json.gz'));
  indexPath = `/icons/i/demo.${manifest.sets[0].idx}.json`;
  const index = readManifest(path.join(dist, 'icons', `i/demo.${manifest.sets[0].idx}.json.gz`));
  shardPath = `/icons/s/demo.0.${index.sh[0][0]}.json`;
  const started = await startRelayProcess({
    envFor: (port) => ({
      ...(process.env as Record<string, string>),
      PORT: String(port),
      DATA_DIR: path.join(root, 'data'),
      DIST_DIR: dist,
      HOST: '127.0.0.1',
    }),
  });
  PORT = started.port;
  relay = started.proc;
});

afterAll(async () => {
  if (relay && relay.exitCode === null && relay.signalCode === null) await new Promise<void>((r) => { relay.once('exit', () => r()); relay.kill('SIGTERM'); });
  fs.rmSync(root, { recursive: true, force: true });
});

describe('relay: /icons/', () => {
  it('sends a hashed shard as gzip with an immutable cache header when gzip is accepted', async () => {
    const res = await get(shardPath, { 'accept-encoding': 'gzip, deflate, br' });
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers.vary).toBe('Accept-Encoding');
    expect(res.headers['content-length']).toBe(String(res.body.length));
    expect(JSON.parse(zlib.gunzipSync(res.body).toString()).i.home).toBe('<path d="M0 0"/>');
  });

  it('sends plain bytes to a client that does not accept gzip', async () => {
    for (const accept of [undefined, 'identity', 'gzip;q=0']) {
      const res = await get(shardPath, accept ? { 'accept-encoding': accept } : {});
      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(JSON.parse(res.body.toString()).i.home).toBe('<path d="M0 0"/>');
    }
  });

  it('answers HEAD with the headers and no body', async () => {
    const res = await get(indexPath, { 'accept-encoding': 'gzip' }, 'HEAD');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(0);
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  it('never caches the manifest or the licence list forever', async () => {
    const m = await get('/icons/manifest.json', { 'accept-encoding': 'gzip' });
    expect(m.status).toBe(200);
    expect(m.headers['cache-control']).toBe('no-cache');
    expect(JSON.parse(zlib.gunzipSync(m.body).toString()).sets[0].p).toBe('demo');
    const l = await get('/icons/LICENSES.txt');
    expect(l.status).toBe(200);
    expect(l.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(l.headers['cache-control']).toBe('no-cache');
    expect(l.body.toString()).toContain('Demo (demo)');
  });

  it('answers a missing path with a 404 and JSON, with or without index.html', async () => {
    for (const withIndex of [false, true]) {
      if (withIndex) fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>app</title>');
      for (const missing of ['/icons/s/demo.9.deadbeef.json', '/icons/', '/icons/nothing', '/icons/s', '/icons/manifest.json.gz', '/icons/s/..%2f..%2findex.html', '/icons/..%2findex.html']) {
        const res = await get(missing, { 'accept-encoding': 'gzip' });
        expect([missing, res.status, res.headers['content-type']]).toEqual([missing, 404, 'application/json']);
        expect(res.body.toString()).not.toContain('<title>');
      }
    }
  });

  it('works with no index.html and still leaves the app to answer elsewhere', async () => {
    fs.rmSync(path.join(dist, 'index.html'), { force: true });
    expect((await get(shardPath)).status).toBe(200);
    expect((await get('/')).status).toBe(503);
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>app</title>');
    const app = await get('/some/board');
    expect(app.status).toBe(200);
    expect(app.body.toString()).toContain('<title>app</title>');
  });

  it('serves the same SPA shell for tracker ticket, view, and board-position paths', async () => {
    const shell = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
    for (const route of ['/t/TAB-123', '/t/inbox/', '/t/projects/project-1', '/t/views/view-1', '/b/board-1?tracker=trk-1&t=TAB-123']) {
      const response = await get(route);
      expect([route, response.status, response.headers['content-type']]).toEqual([route, 200, 'text/html; charset=utf-8']);
      expect(response.headers.location).toBeUndefined();
      expect(response.body.toString()).toBe(shell);
    }
  });

  it('only serves GET and HEAD', async () => {
    expect((await get(shardPath, {}, 'POST')).status).toBe(405);
  });
});
