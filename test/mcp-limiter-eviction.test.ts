import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createMcp } from '../server/mcp.mjs';

const WINDOW_MS = 60_000;
const CALL_LIMIT = 120;
const WRITE_LIMIT = 30;
const KEY_LIMIT = 50_000;

function fixture() {
  let time = 10_000;
  let requestId = 0;
  const tokens = new Map<string, string>();
  const user = { id: 'test-user', name: 'Test user', role: 'member' };
  const rooms = new Map([
    ['board', new Y.Doc()],
    ['board~comments', new Y.Doc()],
  ]);
  const directory = {
    findAccessToken(token: string) {
      const id = tokens.get(token);
      return id ? { id, userId: id, user, scope: 'write', boardIds: null } : null;
    },
    touchAccessToken() {},
    getBoard(id: string) {
      return id === 'board' ? { id, title: 'Test board', deletedAt: null, updatedAt: time } : null;
    },
    boardRole(id: string) {
      return id === 'board' ? 'editor' : null;
    },
    audit() {},
  };
  const server = createMcp({
    config: { mcp: { mode: 'accounts' } },
    directory,
    cloud: null,
    canWriteRoom: () => true,
    roomAccess: {
      exists: (room: string) => rooms.has(room),
      read: (room: string, read: (doc: Y.Doc) => unknown) => read(rooms.get(room)!),
      write: (room: string, _origin: string, write: (doc: Y.Doc) => unknown) => write(rooms.get(room)!),
    },
    log: () => {},
    now: () => time,
  } as Parameters<typeof createMcp>[0] & { now: () => number });

  function addToken(token: string) {
    tokens.set(token, token);
    return token;
  }

  function post(token: string, message: Record<string, unknown>) {
    const req = new EventEmitter() as EventEmitter & {
      method: string;
      headers: Record<string, string>;
      socket: { remoteAddress: string };
    };
    req.method = 'POST';
    req.headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    req.socket = { remoteAddress: '127.0.0.1' };

    const response = {
      status: 0,
      headers: new Map<string, string>(),
      body: undefined as unknown,
      headersSent: false,
      setHeader(name: string, value: string | number) {
        this.headers.set(name.toLowerCase(), String(value));
      },
      writeHead(status: number, headers: Record<string, string | number> = {}) {
        this.status = status;
        for (const [name, value] of Object.entries(headers)) this.headers.set(name.toLowerCase(), String(value));
        this.headersSent = true;
      },
      end(body?: string | Buffer) {
        if (body !== undefined) this.body = JSON.parse(String(body));
      },
    };

    queueMicrotask(() => {
      req.emit('data', Buffer.from(JSON.stringify(message)));
      req.emit('end');
    });
    return server.handle(req, response).then(() => response);
  }

  function rpc(token: string, method: string, params?: Record<string, unknown>) {
    return post(token, { jsonrpc: '2.0', id: ++requestId, method, ...(params === undefined ? {} : { params }) });
  }

  function tool(token: string, name: string, args: Record<string, unknown>) {
    return rpc(token, 'tools/call', { name, arguments: args });
  }

  function createObject(token: string, x: number) {
    return tool(token, 'create_objects', {
      boardId: 'board',
      objects: [{ type: 'sticky', text: 'Saved by the limiter test', x, y: 0 }],
    });
  }

  return {
    addToken,
    createObject,
    get board() { return rooms.get('board')!; },
    rpc,
    setTime(value: number) { time = value; },
    tool,
  };
}

function expectToolSuccess(body: unknown) {
  const result = (body as { result?: { content?: unknown[]; isError?: boolean } }).result;
  expect(result?.content).toBeDefined();
  expect(result?.isError).not.toBe(true);
}

describe('MCP token limiters', () => {
  it('limits 120 calls per token, with exact retry time and a fresh window after rejected calls', async () => {
    const h = fixture();
    const exhausted = h.addToken('exhausted-call-token');
    const other = h.addToken('other-call-token');

    for (let i = 0; i < CALL_LIMIT; i++) expect((await h.rpc(exhausted, 'ping')).status).toBe(200);

    const firstRefusal = await h.rpc(exhausted, 'ping');
    expect(firstRefusal.status).toBe(429);
    expect(firstRefusal.headers.get('retry-after')).toBe('60');
    expect(firstRefusal.body).toMatchObject({ error: { data: { error: 'rate_limited', retryAfterSec: 60 } } });
    expect((await h.rpc(other, 'ping')).status).toBe(200);

    h.setTime(10_000 + WINDOW_MS - 1);
    const lastSecondRefusal = await h.rpc(exhausted, 'ping');
    expect(lastSecondRefusal.status).toBe(429);
    expect(lastSecondRefusal.headers.get('retry-after')).toBe('1');
    for (let i = 1; i < CALL_LIMIT; i++) expect((await h.rpc(exhausted, 'ping')).status).toBe(429);

    h.setTime(10_000 + WINDOW_MS);
    expect((await h.rpc(exhausted, 'ping')).status).toBe(200);
  });

  it('limits 30 successful writes per token, leaves reads available, and does not count refused writes', async () => {
    const h = fixture();
    const exhausted = h.addToken('exhausted-write-token');
    const other = h.addToken('other-write-token');

    for (let i = 0; i < WRITE_LIMIT; i++) {
      const written = await h.createObject(exhausted, i);
      expect(written.status).toBe(200);
      expectToolSuccess(written.body);
    }
    expect(h.board.getMap('objects').size).toBe(WRITE_LIMIT);

    const firstRefusal = await h.createObject(exhausted, WRITE_LIMIT);
    expect(firstRefusal.status).toBe(429);
    expect(firstRefusal.headers.get('retry-after')).toBe('60');
    expect(firstRefusal.body).toMatchObject({ error: { data: { error: 'rate_limited', retryAfterSec: 60 } } });
    expect(h.board.getMap('objects').size).toBe(WRITE_LIMIT);

    const readWhileWritesAreBlocked = await h.tool(exhausted, 'get_board', { boardId: 'board' });
    expect(readWhileWritesAreBlocked.status).toBe(200);
    expect(readWhileWritesAreBlocked.body).toMatchObject({ result: { content: [{ type: 'text' }] } });
    expectToolSuccess(readWhileWritesAreBlocked.body);
    const otherWrite = await h.createObject(other, 0);
    expect(otherWrite.status).toBe(200);
    expectToolSuccess(otherWrite.body);
    expect(h.board.getMap('objects').size).toBe(WRITE_LIMIT + 1);

    h.setTime(10_000 + WINDOW_MS - 1);
    const lastSecondRefusal = await h.createObject(exhausted, WRITE_LIMIT);
    expect(lastSecondRefusal.status).toBe(429);
    expect(lastSecondRefusal.headers.get('retry-after')).toBe('1');
    for (let i = 1; i < WRITE_LIMIT; i++) {
      expect((await h.createObject(exhausted, WRITE_LIMIT + i)).status).toBe(429);
    }
    expect(h.board.getMap('objects').size).toBe(WRITE_LIMIT + 1);

    h.setTime(10_000 + WINDOW_MS);
    const afterWindow = await h.createObject(exhausted, WRITE_LIMIT);
    expect(afterWindow.status).toBe(200);
    expectToolSuccess(afterWindow.body);
    expect(h.board.getMap('objects').size).toBe(WRITE_LIMIT + 2);
  });

  it('evicts the oldest key at capacity while a recently refused hot token keeps its exhausted count', { timeout: 120_000 }, async () => {
    const h = fixture();
    const hot = h.addToken('hot-token');
    const oldest = h.addToken('oldest-token');

    for (let i = 0; i < CALL_LIMIT; i++) expect((await h.rpc(hot, 'ping')).status).toBe(200);
    for (let i = 0; i < CALL_LIMIT; i++) expect((await h.rpc(oldest, 'ping')).status).toBe(200);
    for (let i = 0; i < KEY_LIMIT - 2; i++) {
      const token = h.addToken(`filler-${i}`);
      expect((await h.rpc(token, 'ping')).status).toBe(200);
    }

    const hotRefusal = await h.rpc(hot, 'ping');
    expect(hotRefusal.status).toBe(429);
    expect(hotRefusal.headers.get('retry-after')).toBe('60');

    const overflow = await h.rpc(h.addToken('overflow-token'), 'ping');
    expect(overflow.status).toBe(200);
    expect((await h.rpc(hot, 'ping')).status).toBe(429);
    expect((await h.rpc(oldest, 'ping')).status).toBe(200);
  });
});
