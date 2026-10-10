import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import WebSocket from 'ws';
import { createAssetHandlers } from '../server/asset-routes.mjs';
import { openDirectory } from '../server/directory.mjs';
import { createJoinCodeService, hashJoinCode } from '../server/join-codes.mjs';
import { appendTicketEvent } from '../server/tracker/events.mjs';
import { createTicket } from '../server/tracker/tickets.mjs';
import { createHarness, type Account } from './mcp-harness';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 });

const h = createHarness({ accounts: true, settings: { CHAT: 'on', JOIN_CODES: 'on', TRACKER: 'on' } });
let owner: Account;
const rawSockets = new Set<WebSocket>();

beforeAll(async () => {
  await h.start();
  owner = await h.signInOwner();
});

afterEach(() => {
  for (const ws of rawSockets) if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  rawSockets.clear();
});

afterAll(async () => h.cleanup());

const directoryDb = (fn: (db: DatabaseSync) => void) => {
  const db = new DatabaseSync(path.join(h.dir, 'directory.sqlite'));
  try { fn(db); } finally { db.close(); }
};

const chatDb = (fn: (db: DatabaseSync) => void) => {
  const db = new DatabaseSync(path.join(h.dir, 'chat.sqlite'));
  try { fn(db); } finally { db.close(); }
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('CDX-42 security regression gaps', () => {
  it('conceals an idempotent chat retry after the caller loses the share', async () => {
    const team = await h.newTeam(owner.cookie);
    const member = await h.joinTeam(owner.cookie, team.id);
    const board = await h.newBoard(owner.cookie);
    await h.share(owner.cookie, board, member.user.id, 'commenter');
    const clientId = h.unique('revoked-chat-client-');
    const url = `/api/chat/board/${board}/messages`;

    const first = await h.api(member.cookie, 'POST', url, { clientId, text: 'one message' });
    expect(first.status).toBe(201);
    expect((await h.api(owner.cookie, 'DELETE', `/api/boards/${board}/shares/user/${member.user.id}`)).status).toBe(204);

    const retry = await h.api(member.cookie, 'POST', url, { clientId, text: 'retry after revoke' });
    const unknown = await h.api(member.cookie, 'POST', '/api/chat/board/no-such-board-cdx42/messages', { clientId: h.unique('unknown-chat-'), text: 'x' });
    expect(retry.status).toBe(404);
    expect(retry.body).toEqual(unknown.body);

    chatDb((db) => {
      const row = db.prepare('SELECT body FROM chat_messages WHERE kind = ? AND ref = ? AND client_id = ?').get('board', board, clientId);
      expect(row?.body).toBe('one message');
      expect(Number(db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE kind = ? AND ref = ? AND client_id = ?').get('board', board, clientId)!.n)).toBe(1);
    });
  });

  describe('join-code transaction re-read', () => {
    const scenarios = [
      { label: 'a concurrent revoke', update: (row: any) => ({ ...row, revokedAt: 1_700_000_000_000 }) },
      { label: 'concurrent exhaustion', update: (row: any) => ({ ...row, uses: row.maxUses }) },
    ];

    for (const scenario of scenarios) {
      it(`creates no guest, use, or audit row after ${scenario.label}`, () => {
        const code = 'ABCD2345';
        const secret = crypto.randomBytes(32);
        const now = 1_700_000_000_000;
        let current: any = {
          id: 'join-code-cdx42',
          codeHash: hashJoinCode(code, secret),
          boardId: 'board-cdx42',
          role: 'commenter',
          expiresAt: now + 60_000,
          maxUses: 1,
          uses: 0,
          revokedAt: null,
        };
        const guests: unknown[] = [];
        const audits: unknown[] = [];
        const directory: any = {
          findJoinCodeByHash: vi.fn<(hash: string) => { id: string; codeHash: string } | null>((hash) => hash === current.codeHash ? { id: current.id, codeHash: current.codeHash } : null),
          // Model a competing transaction committing after the initial lookup and before this write transaction's re-read.
          transaction: vi.fn<(fn: () => unknown) => unknown>((fn) => {
            current = scenario.update(current);
            return fn();
          }),
          getJoinCode: vi.fn<() => any>(() => ({ ...current })),
          createGuestSession: vi.fn<(...args: unknown[]) => { sessionId: string }>((...args) => { guests.push(args); return { sessionId: 'unexpected-guest' }; }),
          audit: vi.fn<(...args: unknown[]) => void>((...args) => { audits.push(args); }),
        };

        const result = createJoinCodeService({ directory, secret, now: () => now } as any).join({ code, name: 'Guest', source: 'cdx42-race' });

        expect(result).toBeNull();
        expect(directory.findJoinCodeByHash).toHaveBeenCalledTimes(1);
        expect(directory.getJoinCode).toHaveBeenCalledTimes(1);
        expect(directory.createGuestSession).not.toHaveBeenCalled();
        expect(directory.audit).not.toHaveBeenCalled();
        expect(guests).toHaveLength(0);
        expect(audits).toHaveLength(0);
        expect(current.uses).toBe(scenario.label === 'concurrent exhaustion' ? current.maxUses : 0);
      });
    }
  });

  it('rolls back a board share when its audit insert fails', async () => {
    const team = await h.newTeam(owner.cookie);
    const member = await h.joinTeam(owner.cookie, team.id);
    const board = await h.newBoard(owner.cookie);
    const trigger = 'cdx42_fail_board_share_audit';

    directoryDb((db) => db.exec(`
      CREATE TRIGGER ${trigger} BEFORE INSERT ON audit
      WHEN NEW.action = 'board.share'
      BEGIN SELECT RAISE(ABORT, 'CDX-42 injected audit failure'); END;
    `));

    try {
      const response = await h.api(owner.cookie, 'POST', `/api/boards/${board}/shares`, {
        principalType: 'user', principalId: member.user.id, role: 'commenter',
      });
      expect(response.status).toBe(500);

      directoryDb((db) => {
        const shareCount = db.prepare('SELECT COUNT(*) AS n FROM board_shares WHERE board_id = ? AND principal_type = ? AND principal_id = ?')
          .get(board, 'user', member.user.id)!.n;
        const auditCount = db.prepare('SELECT COUNT(*) AS n FROM audit WHERE action = ? AND json_extract(detail, ?) = ?')
          .get('board.share', '$.boardId', board)!.n;
        expect(Number(shareCount)).toBe(0);
        expect(Number(auditCount)).toBe(0);
      });
    } finally {
      directoryDb((db) => db.exec(`DROP TRIGGER IF EXISTS ${trigger}`));
    }
  });

  it('rechecks access after consuming an in-flight asset upload body', async () => {
    const consumedFirstChunk = deferred();
    const finishBody = deferred();
    let revoked = false;
    const bytes = [Buffer.from('first chunk'), Buffer.from('second chunk')];
    const req: any = Readable.from((async function* () {
      yield bytes[0];
      consumedFirstChunk.resolve();
      await finishBody.promise;
      yield bytes[1];
    })());
    req.headers = { 'content-type': 'image/png' };

    const assets: unknown[] = [];
    const audit: unknown[] = [];
    const store: any = {
      limits: { maxBytes: 1024 },
      put: vi.fn<(input: unknown) => { row: { boardId: string; hash: string; mime: string; bytes: number; width: number; height: number }; created: boolean }>((input) => {
        assets.push(input);
        return { row: { boardId: 'board-cdx42', hash: 'a'.repeat(64), mime: 'image/png', bytes: 22, width: 1, height: 1 }, created: true };
      }),
    };
    const authorize = vi.fn<() => void>(() => {
      if (revoked) throw Object.assign(new Error('Not found'), { status: 404 });
    });
    const handlers: any = createAssetHandlers({ store, limiter: { take: vi.fn<() => boolean>(() => true) } });
    const pendingUpload = handlers.upload({
      boardId: 'board-cdx42', req, rateKey: 'cdx42', userId: 'user-cdx42', authorize,
      onCreated: (row: unknown) => audit.push(row),
    });

    await consumedFirstChunk.promise;
    revoked = true;
    finishBody.resolve();

    await expect(pendingUpload).rejects.toMatchObject({ status: 404 });
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(store.put).not.toHaveBeenCalled();
    expect(assets).toHaveLength(0);
    expect(audit).toHaveLength(0);
  });

  it('denies an unknown account-mode WebSocket board without creating its Yjs file', async () => {
    const board = h.unique('unknown-board-cdx42-');
    const roomFile = h.roomFile(board);
    const before = (await h.api(undefined, 'GET', '/api/health')).body;
    expect(fs.existsSync(roomFile)).toBe(false);

    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/sync/${board}`, {
      headers: { Origin: h.base, Cookie: owner.cookie },
    });
    rawSockets.add(ws);
    ws.on('error', () => undefined);
    const close = await new Promise<{ code: number; reason: string }>((resolve) => {
      ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    expect(close.code).toBe(4404);
    const after = (await h.api(undefined, 'GET', '/api/health')).body;
    expect(after.rooms).toBe(before.rooms);

    // Shutdown saves every loaded room, so this also detects an unauthorized room kept only in memory.
    await h.stop();
    expect(fs.existsSync(roomFile)).toBe(false);
  });

  it('rejects invalid tracker event fields, oversized details, and invalid idempotency keys without rows', () => {
    const directory = openDirectory(':memory:');
    try {
      const person = directory.createUser({ email: 'cdx42@example.com', role: 'owner' });
      if (!person) throw new Error('Could not create tracker event test user');
      const actor = { id: person.id, role: person.role, name: person.name };
      const ticket = createTicket({ directory, actor, title: 'CDX-42 event validation' });
      const base = { directory, ticketId: ticket.id, eventType: 'updated', actor };
      const count = () => Number(directory.db.prepare('SELECT COUNT(*) AS n FROM ticket_events WHERE ticket_id = ?').get(ticket.id)!.n);
      const initial = count();

      expect(() => appendTicketEvent({ ...base, after: { unsupportedField: true } })).toThrow(/Unsupported event field/);
      expect(count()).toBe(initial);

      expect(() => appendTicketEvent({ ...base, details: { commentId: 'x'.repeat(16 * 1024) } })).toThrow(/too large/);
      expect(count()).toBe(initial);

      expect(() => appendTicketEvent({ ...base, idempotencyKey: 'short' })).toThrow(/8 to 64 characters/);
      expect(count()).toBe(initial);
    } finally {
      directory.close();
    }
  });
});
