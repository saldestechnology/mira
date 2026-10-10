import { afterEach, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { isWindows } from './platform';
import { startRelayProcess } from './start-relay';

// A room is written a while after its last change (a second by default, SAVE_DEBOUNCE_MS here). A relay that is asked
// to stop before then must write the room first. Windows cannot deliver SIGTERM (a kill ends the process at once), so
// the request that works on every system is a message over the IPC channel; the signals are checked where the system
// has them.


type Exit = { code: number | null; signal: NodeJS.Signals | null };
type Relay = { child: ChildProcess; dir: string; port: number; exited: Promise<Exit> };

const relays: Relay[] = [];
const providers: WebsocketProvider[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(test: () => boolean, ms: number, what: string) {
  const t0 = Date.now();
  while (!test()) {
    if (Date.now() - t0 > ms) throw new Error(what);
    await sleep(20);
  }
}

async function startRelay(): Promise<Relay> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-shutdown-'));
  const started = await startRelayProcess({
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    envFor: (port) => ({
      ...(process.env as Record<string, string>),
      PORT: String(port),
      DATA_DIR: dir,
      HOST: '127.0.0.1',
      TABULA_AUTH: 'off',
      SAVE_DEBOUNCE_MS: '30000',
    }),
  });
  const child = started.proc;
  const exited = new Promise<Exit>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const relay = { child, dir, port: started.port, exited };
  relays.push(relay);
  return relay;
}

async function connect(port: number, room: string) {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/sync`, room, doc, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    disableBc: true,
  });
  providers.push(provider);
  await until(() => provider.wsconnected && provider.synced, 5000, 'could not connect');
  return doc;
}

const roomFile = (relay: Relay, room: string) => path.join(relay.dir, `${room}.yjs`);

// A second client seeing the edit means the relay has it in memory; the room file must not exist yet, so the stop
// really has unsaved work to write.
async function editWithoutSaving(relay: Relay, room: string, value: string) {
  const writer = await connect(relay.port, room);
  const watcher = await connect(relay.port, room);
  writer.getMap('objects').set('note', value);
  await until(() => watcher.getMap('objects').get('note') === value, 5000, 'the edit did not reach the relay');
  expect(fs.existsSync(roomFile(relay, room))).toBe(false);
}

function savedNote(relay: Relay, room: string) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, fs.readFileSync(roomFile(relay, room)));
  return doc.getMap('objects').get('note');
}

async function exitOf(relay: Relay) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('relay did not exit')), 10_000);
  });
  try {
    return await Promise.race([relay.exited, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

afterEach(async () => {
  for (const p of providers.splice(0)) p.destroy();
  for (const r of relays.splice(0)) {
    if (r.child.exitCode === null && r.child.signalCode === null) {
      r.child.kill('SIGKILL');
      await r.exited;
    }
    fs.rmSync(r.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('relay shutdown', { timeout: 60_000 }, () => {
  it('reports a failed final save and still saves the other rooms', async () => {
    const relay = await startRelay();
    await editWithoutSaving(relay, 'blocked-room', 'cannot be saved');
    fs.mkdirSync(`${roomFile(relay, 'blocked-room')}.tmp`);
    await editWithoutSaving(relay, 'healthy-room', 'saved despite the other failure');
    relay.child.send({ type: 'shutdown' });
    expect(await exitOf(relay)).toEqual({ code: 1, signal: null });
    expect(fs.existsSync(roomFile(relay, 'blocked-room'))).toBe(false);
    expect(savedNote(relay, 'healthy-room')).toBe('saved despite the other failure');
  });

  it('saves a room edited moments ago when asked to stop over the IPC channel, on every system', async () => {
    const relay = await startRelay();
    await editWithoutSaving(relay, 'ipc-room', 'typed just before the stop');
    relay.child.send({ type: 'shutdown' });
    expect(await exitOf(relay)).toEqual({ code: 0, signal: null });
    expect(savedNote(relay, 'ipc-room')).toBe('typed just before the stop');
  });

  it('ignores IPC messages that are not a shutdown request', async () => {
    const relay = await startRelay();
    relay.child.send({ type: 'status' });
    relay.child.send('shutdown');
    relay.child.send({ shutdown: true });
    // The relay does not acknowledge ignored IPC messages, so keep a short observation window on this channel.
    await sleep(400);
    await editWithoutSaving(relay, 'ignored-room', 'still running');
    expect(relay.child.exitCode).toBeNull();
    expect(relay.child.signalCode).toBeNull();
    relay.child.send({ type: 'shutdown' });
    expect(await exitOf(relay)).toEqual({ code: 0, signal: null });
    expect(savedNote(relay, 'ignored-room')).toBe('still running');
  });

  it.skipIf(isWindows)('saves a room edited moments ago on SIGHUP, as when a terminal closes', async () => {
    const relay = await startRelay();
    await editWithoutSaving(relay, 'hup-room', 'typed before the hangup');
    relay.child.kill('SIGHUP');
    expect(await exitOf(relay)).toEqual({ code: 0, signal: null });
    expect(savedNote(relay, 'hup-room')).toBe('typed before the hangup');
  });

  it.skipIf(isWindows)('survives SIGTERM twice in a row and still saves the room', async () => {
    const relay = await startRelay();
    await editWithoutSaving(relay, 'twice-room', 'typed before two stops');
    relay.child.kill('SIGTERM');
    relay.child.kill('SIGTERM');
    expect(await exitOf(relay)).toEqual({ code: 0, signal: null });
    expect(savedNote(relay, 'twice-room')).toBe('typed before two stops');
  });
});
