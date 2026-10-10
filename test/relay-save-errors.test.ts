import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { startRelayProcess } from './start-relay';

// An unreadable room stays closed and its file stays in place. A failed save is retried without ending the process.
// The relay runs as a child process with short timers.

let PORT = 0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-save-errors-'));
let relay: ChildProcess | undefined;
let relayOutput: () => string = () => '';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, ok: () => boolean, ms = 10_000) {
  const t0 = Date.now();
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}\n${relayOutput()}`);
    await sleep(25);
  }
}

function connect(room: string, doc = new Y.Doc()) {
  const provider = new WebsocketProvider(`ws://127.0.0.1:${PORT}/sync`, room, doc, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    disableBc: true,
  });
  return { doc, provider };
}

const running = () => !!relay && relay.exitCode === null && relay.signalCode === null;

async function waitForExit(proc: ChildProcess, ms: number) {
  if (proc.exitCode !== null || proc.signalCode !== null) return true;
  let timer: NodeJS.Timeout;
  return new Promise<boolean>((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    proc.once('exit', onExit);
    timer = setTimeout(() => {
      proc.removeListener('exit', onExit);
      resolve(false);
    }, ms);
  });
}

beforeAll(async () => {
  const runtimeEnv = Object.fromEntries(
    ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR'].flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]!]],
    ),
  );
  const started = await startRelayProcess({
    envFor: (port) => ({
      ...runtimeEnv,
      PORT: String(port),
      DATA_DIR: dir,
      HOST: '127.0.0.1',
      TABULA_SKIP_DOTENV: '1',
      TABULA_AUTH: 'off',
      MIRA_AUTH: 'off',
      SAVE_DEBOUNCE_MS: '50',
      SAVE_RETRY_MS: '200',
      ROOM_UNLOAD_MS: '300',
    }),
  });
  PORT = started.port;
  relay = started.proc;
  relayOutput = started.output;
});

afterAll(async () => {
  if (relay && running()) {
    relay.kill('SIGTERM');
    if (!(await waitForExit(relay, 5_000))) {
      relay.kill('SIGKILL');
      if (!(await waitForExit(relay, 5_000))) throw new Error('relay did not exit after SIGKILL');
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('room files the relay cannot read or write', { timeout: 30_000 }, () => {
  it('leaves an undecodable room closed until its file is recovered, and serves other rooms', async () => {
    const original = new Y.Doc();
    original.getMap('meta').set('name', 'Roadmap');
    for (let i = 0; i < 5; i++) original.getMap('objects').set(`o${i}`, { text: `note ${i}` });
    const whole = Y.encodeStateAsUpdate(original);
    const cut = whole.slice(0, whole.length - 5);
    expect(() => Y.applyUpdate(new Y.Doc(), cut)).toThrow('Unexpected end of array');
    const file = path.join(dir, 'cut-room.yjs');
    fs.writeFileSync(file, cut);

    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/sync/cut-room`);
    const closed = new Promise<number>((resolve) => ws.once('close', resolve));
    try {
      expect(await closed).toBe(1011);
    } finally {
      ws.terminate();
    }
    const healthy = connect('healthy-room');
    try {
      await until('the healthy room sync', () => healthy.provider.synced);
    } finally {
      healthy.provider.destroy();
    }
    await until('the healthy room unload', () => relayOutput().includes('room healthy-room: unloaded'));
    expect(relayOutput()).not.toContain('room cut-room: loaded');
    expect(fs.readFileSync(file)).toEqual(Buffer.from(cut));
    expect(fs.readdirSync(dir).some((f) => f.startsWith('cut-room.yjs.corrupt-'))).toBe(false);

    fs.writeFileSync(file, whole);
    const recovered = connect('cut-room');
    try {
      await until('the recovered room sync', () => recovered.provider.synced);
      expect(recovered.doc.getMap('meta').get('name')).toBe('Roadmap');
      expect(recovered.doc.getMap('objects').size).toBe(5);
    } finally {
      recovered.provider.destroy();
    }
    expect(running()).toBe(true);
  });

  it('keeps running when a save fails, and saves once the disk lets it', async () => {
    const blocker = path.join(dir, 'stuck-room.yjs.tmp');
    fs.mkdirSync(blocker);
    const { doc, provider } = connect('stuck-room');
    try {
      await until('the sync', () => provider.wsconnected && provider.synced);
      doc.getMap('objects').set('a', 'kept');
      await until('a failed save', () => relayOutput().includes('room stuck-room: could not save'));
      provider.destroy();
      await until(
        'the relay to retry the failed save while the room is idle',
        () => (relayOutput().match(/room stuck-room: could not save/g)?.length ?? 0) >= 3,
      );
      expect(running()).toBe(true);
      expect(fs.existsSync(path.join(dir, 'stuck-room.yjs'))).toBe(false);
      expect(relayOutput()).not.toContain('room stuck-room: unloaded');

      fs.rmdirSync(blocker);
      const file = path.join(dir, 'stuck-room.yjs');
      await until('the retried save', () => fs.existsSync(file));
      const saved = new Y.Doc();
      Y.applyUpdate(saved, fs.readFileSync(file));
      expect(saved.getMap('objects').get('a')).toBe('kept');
    } finally {
      provider.destroy();
    }
    expect(running()).toBe(true);
  });

  it('closes repeated read failures without creating a room or changing the unreadable path', async () => {
    const file = path.join(dir, 'unreadable-room.yjs');
    fs.mkdirSync(file);
    for (let i = 0; i < 3; i++) {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/sync/unreadable-room`);
      try {
        expect(await new Promise<number>((resolve) => ws.once('close', resolve))).toBe(1011);
      } finally {
        ws.terminate();
      }
    }
    expect(fs.statSync(file).isDirectory()).toBe(true);
    expect(relayOutput()).not.toContain('room unreadable-room: loaded');
    expect(running()).toBe(true);
  });
});
