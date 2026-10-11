import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { freePort } from './free-port';
import { RELAY_START_MS } from './relay-timing';

// Shared by the black-box MCP tests: a relay child process, the HTTP API as a signed-in person, raw JSON-RPC to /mcp.
// Settings are passed under both the TABULA_ and the MIRA_ spelling and the CSRF header under both names, so the
// helpers work whichever the relay on this branch reads. Cookies are kept as whatever name=value the server sets.

export type Body = any;
export type Res = { status: number; body: Body; headers: Headers };
export type Account = { cookie: string; user: Body; email: string };

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A relay that dies on its own (not through stop()) must fail the test that was waiting on it, with the relay's own
// output, instead of letting every wait time out and every later request meet ECONNREFUSED (docs/testing.md).
const relayGuards = new Set<() => string | null>();
const relayDied = () => {
  for (const guard of relayGuards) {
    const message = guard();
    if (message) return message;
  }
  return null;
};

// 30 s: a disk save under the relay's debounce can take that long on a shared Windows runner (the test timeout is 60 s).
export const until = async (fn: () => boolean | Promise<boolean>, ms = 30_000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    const died = relayDied();
    if (died) throw new Error(died);
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await sleep(20);
  }
};

const dual = (settings: Record<string, string>) =>
  Object.fromEntries(Object.entries(settings).flatMap(([k, v]) => [[`MIRA_${k}`, v], [`TABULA_${k}`, v]]));

export interface HarnessOptions {
  accounts?: boolean;
  /** Settings without a prefix, for example { MCP: 'on' }. */
  settings?: Record<string, string>;
  /** Plain environment variables such as ROOM_UNLOAD_MS. */
  env?: Record<string, string>;
  port?: number;
  dir?: string;
}

export function createHarness(options: HarnessOptions = {}) {
  // taken from the system when the relay first starts, and kept for the restarts of a test that stops and starts it
  let port = options.port ?? 0;
  const dir = options.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  let base = '';
  const outbox = path.join(dir, 'outbox.jsonl');
  const OWNER = 'owner@example.com';
  let proc: ChildProcess | null = null;
  let output = '';
  // set when the relay exits without stop() having asked it to
  let died: string | null = null;
  let stopping = false;
  const guard = () => died;
  relayGuards.add(guard);
  let ipSeq = 0;
  let seq = 0;

  const unique = (tag: string) => `${tag}${++seq}x${Math.random().toString(36).slice(2, 7)}`;
  const nextIp = () => `10.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}.9`;

  const start = async (extra: Record<string, string> = {}) => {
    if (!port) port = await freePort();
    base = `http://127.0.0.1:${port}`;
    return new Promise<void>((resolve, reject) => {
      output = '';
      died = null;
      stopping = false;
      const settings = {
        ...(options.accounts ? { AUTH: 'on', OWNER_EMAIL: OWNER, MAIL: 'file', TRUST_PROXY: '1' } : {}),
        BASE_URL: base,
        ...options.settings,
      };
      const p = spawn(process.execPath, ['server/relay.mjs'], {
        env: { ...process.env, PORT: String(port), DATA_DIR: dir, HOST: '127.0.0.1', QUIET: '', ...dual(settings), ...options.env, ...extra },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      proc = p;
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      p.stdout!.on('data', (d) => {
        output += String(d);
        if (/relay on http/.test(output)) done(resolve);
      });
      p.stderr!.on('data', (d) => {
        output += String(d);
      });
      p.on('error', (e) => done(() => reject(e)));
      p.on('close', (code, signal) => {
        if (p === proc && !stopping) died = `relay exited with ${code ?? signal}: ${output.slice(-1500)}`;
        done(() => reject(new Error(`relay exited with ${code}: ${output.slice(0, 1500)}`)));
      });
      setTimeout(() => done(() => reject(new Error(`relay did not start: ${output.slice(-400)}`))), RELAY_START_MS);
    });
  };

  const stop = () =>
    new Promise<void>((resolve) => {
      const p = proc;
      stopping = true;
      if (!p || p.exitCode !== null || p.signalCode !== null) return resolve();
      p.once('exit', () => resolve());
      p.kill('SIGTERM');
    });

  const cleanup = async () => {
    await stop();
    relayGuards.delete(guard);
    fs.rmSync(dir, { recursive: true, force: true });
  };

  async function api(cookie: string | undefined, method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    if (died) throw new Error(died);
    let res: Response;
    let text: string;
    let stage = 'fetch';
    try {
      res = await fetch(base + urlPath, {
        method,
        headers: {
          'x-mira': '1',
          'x-tabula': '1',
          ...(cookie ? { cookie } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      stage = 'response body read';
      text = await res.text();
    } catch (cause) {
      const causeMessage = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
      const nestedCause = cause instanceof Error && cause.cause instanceof Error
        ? `; cause=${cause.cause.name}: ${cause.cause.message}`
        : '';
      const relayState = proc
        ? `pid=${proc.pid ?? 'unknown'} exitCode=${String(proc.exitCode)} signalCode=${String(proc.signalCode)} at failure snapshot`
        : 'no relay process';
      const exitDetails = died ?? 'no relay exit event observed at failure snapshot';
      const outputTail = output ? output.slice(-1500) : '(empty)';
      throw new Error(`API ${method} ${urlPath} failed during ${stage} (${causeMessage}${nestedCause}); relay ${relayState}; ${exitDetails}; recent relay output:\n${outputTail}`, { cause });
    }
    let parsed: Body;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  const mails = (): { to: string; text: string }[] =>
    fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

  async function signIn(email: string, invite?: string): Promise<Account> {
    const before = mails().length;
    const asked = await api(undefined, 'POST', '/api/auth/request', { email, invite }, { 'x-forwarded-for': nextIp() });
    const fresh = mails().slice(before);
    if (asked.status !== 200 || fresh.length !== 1) throw new Error(`no sign-in mail for ${email} (status ${asked.status})`);
    const token = decodeURIComponent(/token=([^\s&]+)/.exec(fresh[0].text)![1]);
    const verify = await api(undefined, 'POST', '/api/auth/verify', { token });
    if (verify.status !== 200) throw new Error(`verify failed with ${verify.status}`);
    const cookie = verify.headers.getSetCookie()[0].split(';')[0];
    return { cookie, user: verify.body.user, email };
  }

  const signInOwner = () => signIn(OWNER);

  async function newTeam(cookie: string, name = unique('Team')) {
    const res = await api(cookie, 'POST', '/api/teams', { name });
    if (res.status !== 201) throw new Error(`could not create a team (${res.status})`);
    return res.body as Body;
  }

  async function joinTeam(adminCookie: string, teamId: string, role: 'member' | 'admin' = 'member') {
    const invite = await api(adminCookie, 'POST', `/api/teams/${teamId}/invites`, { role });
    if (invite.status !== 201) throw new Error(`could not create an invite (${invite.status})`);
    return signIn(`${unique('user')}@example.com`, invite.body.token);
  }

  async function newBoard(cookie: string, extra: Record<string, unknown> = {}) {
    const id = unique('board');
    const res = await api(cookie, 'POST', '/api/boards', { id, ...extra });
    if (res.status !== 201) throw new Error(`could not create a board (${res.status} ${JSON.stringify(res.body)})`);
    return id;
  }

  const share = async (cookie: string, board: string, principalId: string, role: 'editor' | 'commenter' | 'viewer') => {
    const res = await api(cookie, 'POST', `/api/boards/${board}/shares`, { principalType: 'user', principalId, role });
    if (res.status !== 201) throw new Error(`could not share (${res.status})`);
  };

  /** Creates an access token through the API and returns the secret. */
  async function newToken(cookie: string, input: Record<string, unknown> = {}): Promise<{ token: string; id: string }> {
    const res = await api(cookie, 'POST', '/api/me/tokens', { name: unique('token'), scope: 'write', ...input });
    if (res.status !== 201) throw new Error(`could not create a token (${res.status} ${JSON.stringify(res.body)})`);
    return { token: res.body.token, id: res.body.id };
  }

  // ---------------------------------------------------------------- MCP over HTTP

  async function rpc(token: string | undefined, message: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-forwarded-for': nextIp(),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: typeof message === 'string' ? message : JSON.stringify(message),
    });
    const text = await res.text();
    let parsed: Body;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  let rpcId = 0;
  const call = (token: string | undefined, method: string, params?: unknown, headers?: Record<string, string>) =>
    rpc(token, { jsonrpc: '2.0', id: ++rpcId, method, params }, headers);

  /** The JSON inside a tool result, whether or not it is fenced. */
  const payloadOf = (text: string): Body => {
    const m = /\[board-content nonce=([0-9a-f]+)\]\n([\s\S]*)\n\[\/board-content nonce=\1\]$/.exec(text);
    return JSON.parse(m ? m[2] : text);
  };

  /** Calls a tool. `error` is set for a tool failure; `data` is the parsed payload either way. */
  async function tool(token: string | undefined, name: string, args: Record<string, unknown> = {}) {
    const res = await call(token, 'tools/call', { name, arguments: args });
    if (res.status !== 200 || !res.body?.result) return { res, error: undefined as string | undefined, data: undefined as Body, text: '' };
    const text: string = res.body.result.content[0].text;
    const data = payloadOf(text);
    return { res, error: res.body.result.isError ? (data.error as string) : undefined, data, text };
  }

  // ---------------------------------------------------------------- documents

  const roomFile = (name: string) => path.join(dir, `${name}.yjs`);

  /** The saved state of a room, or an empty document. */
  const savedDoc = (name: string) => {
    const doc = new Y.Doc();
    if (fs.existsSync(roomFile(name))) Y.applyUpdate(doc, fs.readFileSync(roomFile(name)));
    return doc;
  };

  const providers = new Set<WebsocketProvider>();
  const wsFor = (cookie?: string) =>
    class extends WebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols, { headers: cookie ? { Origin: base, Cookie: cookie } : { Origin: base } });
      }
    };

  /** A live editor of a room, as a browser would be. */
  function connect(room: string, cookie?: string) {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(`ws://127.0.0.1:${port}/sync`, room, doc, {
      WebSocketPolyfill: wsFor(cookie) as unknown as typeof globalThis.WebSocket,
      disableBc: true,
    });
    providers.add(provider);
    return { doc, provider, synced: () => until(() => provider.wsconnected && provider.synced) };
  }

  const closeProviders = () => {
    for (const p of providers) p.destroy();
    providers.clear();
  };

  return {
    get port() { return port; }, dir, get base() { return base; }, OWNER, start, stop, cleanup, output: () => output, relayPid: () => proc?.pid ?? null,
    api, signIn, signInOwner, newTeam, joinTeam, newBoard, share, newToken, rpc, call, tool, payloadOf,
    roomFile, savedDoc, connect, closeProviders, unique, nextIp, mails,
  };
}

export type Harness = ReturnType<typeof createHarness>;
