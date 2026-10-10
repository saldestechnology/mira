import { afterAll, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as decoding from 'lib0/decoding';
import WebSocket from 'ws';
import { startRelayProcess } from './start-relay';

// docs/ai.md, "Live runs": the relay as `npm start` runs it in open mode tells every socket on a board about its AI runs
// (message type 6): a patch per change, and a snapshot for a socket that joins while runs are open. The provider is a
// local HTTP server that answers like the Messages API, so nothing leaves the machine and the key is made up.

const RELAY = fileURLToPath(new URL('../server/relay.mjs', import.meta.url));
let PORT = 0;
const KEY = `sk-ant-api03-${crypto.randomBytes(24).toString('hex')}`;
const MSG_AI_RUNS = 6;

const cleanEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(TABULA|MIRA)_|^ANTHROPIC_|^DATA_DIR$|^PORT$/.test(name)));

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * Answers every POST like a streamed Messages API reply whose text is `answer`. After `hold()` a reply waits until
 * `release()`; the gate stays open once released, so a request that arrives after the release is not held (the relay
 * announces a run before its provider call reaches this server, so the test cannot count on the order).
 */
function fakeProvider(answer: unknown) {
  let gate: Promise<void> | null = null;
  let open: () => void = () => {};
  const state = {
    requests: 0,
    hold: () => {
      gate = new Promise<void>((r) => (open = r));
    },
    release: () => open(),
  };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', async () => {
      state.requests++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sse('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }));
      res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
      if (gate) await gate;
      res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: JSON.stringify(answer) } }));
      res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }));
      res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }));
      res.end(sse('message_stop', { type: 'message_stop' }));
    });
  });
  return { server, state };
}

type Socket = { ws: WebSocket; runs: any[] };

function connect(board: string): Promise<Socket> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/sync/${board}`);
  ws.binaryType = 'arraybuffer';
  const sock: Socket = { ws, runs: [] };
  ws.on('message', (data: ArrayBuffer) => {
    const dec = decoding.createDecoder(new Uint8Array(data));
    if (decoding.readVarUint(dec) === MSG_AI_RUNS) sock.runs.push(JSON.parse(decoding.readVarString(dec)));
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () => {
      ws.once('pong', () => resolve(sock));
      ws.ping();
    });
    ws.once('error', reject);
  });
}

const until = async (fn: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

let relay: ChildProcess | null = null;
let dir = '';
const provider = fakeProvider({ objects: [{ text: 'An idea' }] });
const sockets: WebSocket[] = [];

afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  if (relay && relay.exitCode === null) {
    const exited = new Promise((r) => relay!.once('exit', r));
    relay.kill('SIGTERM');
    await exited;
  }
  await new Promise((r) => provider.server.close(r));
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

async function start() {
  await new Promise<void>((r) => provider.server.listen(0, '127.0.0.1', r));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-live-relay-'));
  const started = await startRelayProcess({
    entry: RELAY,
    cwd: dir,
    envFor: (port) => ({
      ...cleanEnv(),
      PORT: String(port),
      DATA_DIR: dir,
      HOST: '127.0.0.1',
      TABULA_AI_API_KEY: KEY,
      TABULA_AI_OPEN: '1',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${(provider.server.address() as AddressInfo).port}`,
    }),
  });
  PORT = started.port;
  relay = started.proc;
}

const post = async (url: string, body: unknown) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${url}`, { method: 'POST', headers: { 'x-tabula': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
};

describe('live AI runs through the relay', () => {
  it('tells every socket on the board, gives a late joiner a snapshot, and never sends the prompt', async () => {
    await start();
    const a = await connect('board1');
    const b = await connect('board1');
    const other = await connect('board2');
    sockets.push(a.ws, b.ws, other.ws);
    // The WebSocket ping/pong in connect confirms the relay processed each join before this negative assertion.
    expect([a.runs, b.runs]).toEqual([[], []]);

    provider.state.hold();
    const running = post('/api/ai/run', { feature: 'generate', boardId: 'board1', input: { prompt: 'CANARY-prompt', selection: ['s1'] }, presence: { name: 'Sam', color: '#1E9A6A' } });
    await until(() => a.runs.length >= 1 && b.runs.length >= 1);
    expect(a.runs[0]).toMatchObject({ kind: 'patch', run: { feature: 'generate', status: 'running', by: { id: null, name: 'Sam', color: '#1E9A6A' }, target: { ids: ['s1'] } } });
    const id = a.runs[0].run.id;

    // a socket that joins while the run is going is told about it
    const late = await connect('board1');
    sockets.push(late.ws);
    await until(() => late.runs.length >= 1);
    expect(late.runs[0]).toEqual({ kind: 'snapshot', runs: [expect.objectContaining({ id, status: 'running' })] });

    provider.state.release();
    const ran = await running;
    expect(ran.status).toBe(200);
    expect(ran.text).toContain(`"runId":"${id}"`);
    await until(() => [a, b, late].every((s) => s.runs.some((m) => m.run?.status === 'ready')));
    expect(b.runs.find((m) => m.run?.status === 'ready').run.proposal).toEqual({ kind: 'create', objects: [{ text: 'An idea' }] });

    const res = await post(`/api/ai/runs/${id}/resolve`, { action: 'accept' });
    expect(res.status).toBe(200);
    await until(() => [a, b, late].every((s) => s.runs.some((m) => m.run?.status === 'accepted')));
    const again = await post(`/api/ai/runs/${id}/resolve`, { action: 'discard' });
    expect(again.status).toBe(409);

    // another board heard nothing, and the prompt went to nobody
    expect(other.runs).toEqual([]);
    expect(JSON.stringify([a.runs, b.runs, late.runs])).not.toContain('CANARY');

    // a settled run is not in the snapshot of the next socket
    const after = await connect('board1');
    sockets.push(after.ws);
    expect(after.runs).toEqual([]);
    expect(provider.state.requests).toBe(1);
  }, 60_000);
});
