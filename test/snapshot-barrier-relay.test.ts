import { afterEach, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { envFor, harness, type Harness } from './backup-harness';
import { startRelayProcess } from './start-relay';

type Relay = { proc: ChildProcess; port: number; out: () => string; exited: Promise<void> };

let h: Harness;
const relays: Relay[] = [];
const providers: WebsocketProvider[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean | Promise<boolean>, ms: number, reason: string) {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > ms) throw new Error(reason);
    await sleep(20);
  }
}

async function startRelay(): Promise<Relay> {
  const started = await startRelayProcess({
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    envFor: (port) => ({
      ...(process.env as Record<string, string>),
      PORT: String(port),
      DATA_DIR: h.dir,
      HOST: '127.0.0.1',
      TABULA_AUTH: 'off',
      TABULA_BASE_URL: `http://127.0.0.1:${port}`,
      ...envFor(h.fake),
      TABULA_BACKUP_SETTLE_SECONDS: '1',
      TABULA_BACKUP_SNAPSHOT_MAX_HOLD_SECONDS: '60',
      TABULA_TEST_SNAPSHOT_CAPTURE_DELAY_MS: '1000',
      SAVE_DEBOUNCE_MS: '50',
    }),
  });
  const exited = new Promise<void>((resolve) => {
    if (started.proc.exitCode !== null || started.proc.signalCode !== null) resolve();
    else started.proc.once('exit', () => resolve());
  });
  const relay = { proc: started.proc, port: started.port, out: started.output, exited };
  relays.push(relay);
  return relay;
}

async function connect(relay: Relay, room: string) {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`ws://127.0.0.1:${relay.port}/sync`, room, doc, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    disableBc: true,
  });
  providers.push(provider);
  await until(() => provider.wsconnected && provider.synced, 5000, 'could not connect to the relay');
  return { doc, provider };
}

async function pong(ws: WebSocket) {
  await new Promise<void>((resolve, reject) => {
    ws.once('pong', resolve);
    ws.once('error', reject);
    ws.ping();
  });
}

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.destroy();
  for (const relay of relays.splice(0)) {
    if (relay.proc.exitCode === null && relay.proc.signalCode === null) {
      relay.proc.kill('SIGKILL');
      await relay.exited;
    }
  }
  await h?.close();
});

describe('the relay snapshot barrier', { timeout: 30_000 }, () => {
  it('keeps sockets open, queues Yjs updates during local capture, then applies them', async () => {
    h = await harness({ seed: false });
    const relay = await startRelay();
    const writer = await connect(relay, 'barrier-room');
    const watcher = await connect(relay, 'barrier-room');

    writer.doc.getMap('markers').set('point', 'before');
    await until(() => watcher.doc.getMap('markers').get('point') === 'before', 5000, 'the initial update did not reach the watcher');
    await until(() => relay.out().includes('snapshot barrier started'), 20_000, 'the settle backup did not start a snapshot');

    writer.doc.getMap('markers').set('point', 'after');
    const writerSocket = writer.provider.ws as unknown as WebSocket | null;
    if (!writerSocket) throw new Error('writer socket is not connected');
    await pong(writerSocket);
    expect(watcher.doc.getMap('markers').get('point')).toBe('before');
    expect(writer.provider.wsconnected).toBe(true);
    expect(watcher.provider.wsconnected).toBe(true);

    await until(() => relay.out().includes('snapshot barrier released after') && relay.out().includes('ok: '), 20_000, 'the snapshot did not finish');
    await until(() => watcher.doc.getMap('markers').get('point') === 'after', 5000, 'the queued update was not applied after release');
    expect(writer.provider.wsconnected).toBe(true);
    expect(watcher.provider.wsconnected).toBe(true);

    const engine = h.engine();
    const [newest] = await engine.listManifests();
    expect(newest).toBeTruthy();
    const manifest = await engine.readManifest(newest.name);
    expect(manifest.snapshotBarrier).toMatchObject({ completed: true, snapshotSeq: 1 });
    const roomFile = manifest.files.find((file: { path: string }) => file.path === 'barrier-room.yjs');
    expect(roomFile).toBeTruthy();
    const saved = new Y.Doc();
    Y.applyUpdate(saved, await engine.readObject(roomFile.objectId));
    expect(saved.getMap('markers').get('point')).toBe('before');
    saved.destroy();
    writer.doc.destroy();
    watcher.doc.destroy();
  });
});
