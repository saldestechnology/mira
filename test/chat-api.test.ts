import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHarness, type Account } from './mcp-harness';

// docs/chat.md, API, over a real relay in accounts mode with TABULA_CHAT=on. The relay is also a hosted workspace (the
// control plane URL points nowhere), so the read-only 402 can be switched on through the internal limits route.

const CLOUD_TOKEN = 'chat-test-cloud-token-0123456789abcdef';
const h = createHarness({
  accounts: true,
  settings: { CHAT: 'on', CLOUD_TOKEN, CLOUD_URL: 'http://127.0.0.1:9', CLOUD_WORKSPACE_ID: 'chat-ws' },
  env: { NODE_ENV: 'test', TABULA_TEST_CHAT_BURST_WINDOW_MS: '600000' },
});
let owner: Account;

beforeAll(async () => {
  await h.start();
  owner = await h.signInOwner();
});
afterAll(() => h.cleanup());

const cid = () => crypto.randomUUID();
const url = (board: string) => `/api/chat/board/${board}/messages`;
const send = (who: Account, board: string, text: string, extra: Record<string, unknown> = {}) =>
  h.api(who.cookie, 'POST', url(board), { clientId: cid(), text, ...extra });
const list = (who: Account, board: string, query = '') => h.api(who.cookie, 'GET', `${url(board)}${query}`);
const internal = (body: unknown) => h.api(undefined, 'PUT', '/api/internal/limits', body, { authorization: `Bearer ${CLOUD_TOKEN}` });

/** A personal board of a team member (its owner, a moderator), and people the owner shares it with in a role. */
async function setup({ teamBoard = false } = {}) {
  const team = await h.newTeam(owner.cookie);
  const creator = await h.joinTeam(owner.cookie, team.id);
  const board = await h.newBoard(creator.cookie, teamBoard ? { teamId: team.id } : {});
  const person = async (role: 'editor' | 'commenter' | 'viewer') => {
    const who = await h.joinTeam(owner.cookie, team.id);
    await h.share(creator.cookie, board, who.user.id, role);
    return who;
  };
  const outsider = async () => h.joinTeam(owner.cookie, (await h.newTeam(owner.cookie)).id);
  return { team, creator, board, person, outsider };
}

async function makeGuest(): Promise<Account> {
  const team = await h.newTeam(owner.cookie);
  const who = await h.joinTeam(owner.cookie, team.id);
  const res = await h.api(owner.cookie, 'PATCH', `/api/members/${who.user.id}`, { role: 'guest' });
  expect(res.status).toBe(200);
  return who;
}

const auditOf = async (action: string) => (await h.api(owner.cookie, 'GET', `/api/admin/audit?action=${action}`)).body.entries as any[];

describe('chat over the API', { timeout: 60_000 }, () => {
  it('reports chat in /api/me', async () => {
    expect((await h.api(owner.cookie, 'GET', '/api/me')).body.chat).toBe(true);
  });

  it('posts as the signed-in person and ignores the author, time and order a client claims', async () => {
    const { creator, board, person } = await setup();
    const ana = await person('commenter');
    const before = Date.now();
    const res = await send(ana, board, 'Are we starting at ten?  \n\n', {
      authorId: creator.user.id, authorName: 'Someone Else', author: creator.user.id, userId: creator.user.id,
      createdAt: 1, editedAt: 2, deletedAt: 3, id: 999_999, kind: 'team', ref: 'other',
    });
    expect(res.status).toBe(201);
    const message = res.body.message;
    expect(message).toMatchObject({ kind: 'board', ref: board, authorId: ana.user.id, authorName: ana.user.name, text: 'Are we starting at ten?', editedAt: null, deleted: false });
    expect(message.id).not.toBe(999_999);
    expect(message.createdAt).toBeGreaterThanOrEqual(before - 1000);
    expect((await list(creator, board)).body).toEqual({ messages: [message], next: null });
  });

  it('answers a retried clientId with 200 and the message stored the first time', async () => {
    const { board, person } = await setup();
    const ana = await person('commenter');
    const clientId = cid();
    const first = await h.api(ana.cookie, 'POST', url(board), { clientId, text: 'once' });
    const again = await h.api(ana.cookie, 'POST', url(board), { clientId, text: 'twice' });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.message).toEqual(first.body.message);
    expect((await list(ana, board)).body.messages).toHaveLength(1);
  });

  it('pages backwards with before, 50 by default and 100 at most', async () => {
    const { creator, board } = await setup();
    await list(creator, board); // opens chat.sqlite
    const db = new DatabaseSync(path.join(h.dir, 'chat.sqlite'));
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      const insert = db.prepare(`INSERT INTO chat_messages (kind, ref, author_id, author_name, body, client_id, created_at) VALUES ('board', ?, ?, 'x', ?, ?, ?)`);
      for (let i = 0; i < 130; i++) insert.run(board, creator.user.id, `m${i}`, `seed-${i}-client`, Date.now());
    } finally {
      db.close();
    }
    const texts = (r: any) => r.body.messages.map((m: any) => m.text);
    const first = await list(creator, board);
    expect(texts(first)).toEqual(Array.from({ length: 50 }, (_, i) => `m${80 + i}`));
    const second = await list(creator, board, `?before=${first.body.next}`);
    expect(texts(second)).toEqual(Array.from({ length: 50 }, (_, i) => `m${30 + i}`));
    const third = await list(creator, board, `?before=${second.body.next}`);
    expect(texts(third)).toHaveLength(30);
    expect(third.body.next).toBeNull();
    expect((await list(creator, board, '?limit=500')).body.messages).toHaveLength(100);
    expect((await list(creator, board, '?limit=3')).body.messages).toHaveLength(3);
    expect((await list(creator, board, '?before=abc')).status).toBe(400);
    expect((await list(creator, board, '?before=-1')).status).toBe(400);
  });

  it('lets the author edit their message any time, marking it edited', async () => {
    const { creator, board, person } = await setup();
    const ana = await person('commenter');
    const ben = await person('editor');
    const posted = (await send(ana, board, 'draft')).body.message;
    const edited = await h.api(ana.cookie, 'PATCH', `/api/chat/messages/${posted.id}`, { text: 'final', authorId: ben.user.id, editedAt: 1 });
    expect(edited.status).toBe(200);
    expect(edited.body.message).toMatchObject({ id: posted.id, text: 'final', authorId: ana.user.id, createdAt: posted.createdAt });
    expect(edited.body.message.editedAt).toBeGreaterThanOrEqual(posted.createdAt);
    // nobody edits another person's words, a moderator included
    for (const who of [ben, creator, owner]) {
      const res = await h.api(who.cookie, 'PATCH', `/api/chat/messages/${posted.id}`, { text: 'rewritten' });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('not_author');
    }
    expect((await list(ana, board)).body.messages[0].text).toBe('final');
  });

  it('lets the author delete without an audit row, and a moderator delete with one', async () => {
    const { creator, board, person } = await setup();
    const ana = await person('commenter');
    const ben = await person('editor');
    const own = (await send(ana, board, 'mine, gone soon')).body.message;
    const other = (await send(ana, board, 'secret words nobody should log')).body.message;
    const kept = (await send(ana, board, 'stays')).body.message;

    expect((await h.api(ana.cookie, 'DELETE', `/api/chat/messages/${own.id}`)).status).toBe(204);
    // an editor is not a moderator
    expect((await h.api(ben.cookie, 'DELETE', `/api/chat/messages/${other.id}`)).status).toBe(403);
    // the board owner is
    expect((await h.api(creator.cookie, 'DELETE', `/api/chat/messages/${other.id}`)).status).toBe(204);
    // deleting a tombstone again changes nothing
    expect((await h.api(creator.cookie, 'DELETE', `/api/chat/messages/${other.id}`)).status).toBe(204);

    const messages = (await list(ben, board)).body.messages;
    expect(messages.map((m: any) => [m.id, m.text, m.deleted, m.deletedBy])).toEqual([
      [own.id, '', true, 'author'],
      [other.id, '', true, 'moderator'],
      [kept.id, 'stays', false, null],
    ]);
    // a tombstone cannot be edited back to life
    expect((await h.api(ana.cookie, 'PATCH', `/api/chat/messages/${own.id}`, { text: 'back' })).status).toBe(409);

    const rows = (await auditOf('chat.delete')).filter((e) => e.detail.ref === board);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: creator.user.id, detail: { kind: 'board', ref: board, messageId: other.id, authorId: ana.user.id } });
    expect(JSON.stringify(rows[0])).not.toContain('secret');
  });

  it('answers 404 for every channel and message the caller cannot see', async () => {
    const { board, person, outsider } = await setup();
    const ana = await person('commenter');
    const stranger = await outsider();
    const posted = (await send(ana, board, 'inside')).body.message;
    const missing = await list(stranger, 'no-such-board');
    expect(missing.status).toBe(404);
    const checks = [
      list(stranger, board),
      send(stranger, board, 'let me in'),
      h.api(stranger.cookie, 'PUT', `/api/chat/board/${board}/read`, { lastId: posted.id }),
      h.api(stranger.cookie, 'PATCH', `/api/chat/messages/${posted.id}`, { text: 'x' }),
      h.api(stranger.cookie, 'DELETE', `/api/chat/messages/${posted.id}`),
      h.api(owner.cookie, 'GET', '/api/chat/team/anything/messages'),
      h.api(owner.cookie, 'GET', '/api/chat/workspace/x/messages'),
      h.api(owner.cookie, 'GET', '/api/chat/room/x/messages'),
      h.api(owner.cookie, 'GET', `/api/chat/board/${encodeURIComponent('../x')}/messages`),
      h.api(owner.cookie, 'PATCH', '/api/chat/messages/99999999', { text: 'x' }),
      h.api(owner.cookie, 'DELETE', '/api/chat/messages/0'),
      h.api(owner.cookie, 'DELETE', '/api/chat/messages/abc'),
    ];
    for (const res of await Promise.all(checks)) {
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not_found');
    }
    // a hidden channel and one that does not exist look the same
    expect((await list(stranger, board)).body).toEqual(missing.body);
    expect((await h.api(undefined, 'GET', url(board))).status).toBe(401);
  });

  it('keeps viewers reading unless an administrator lets them post', async () => {
    const { board, person } = await setup();
    const vic = await person('viewer');
    expect((await list(vic, board)).status).toBe(200);
    const refused = await send(vic, board, 'hello');
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('read_only_viewer');

    expect((await h.api(owner.cookie, 'GET', '/api/admin/chat')).body).toEqual({ viewersMayPost: false, retentionDays: 365, workspaceChannel: true });
    expect((await h.api(vic.cookie, 'PUT', '/api/admin/chat', { viewersMayPost: true })).status).toBe(403);
    expect((await h.api(owner.cookie, 'PUT', '/api/admin/chat', { viewersMayPost: 'yes' })).status).toBe(400);
    expect((await h.api(owner.cookie, 'PUT', '/api/admin/chat', { retentionDays: 7 })).status).toBe(400);
    expect((await h.api(owner.cookie, 'PUT', '/api/admin/chat', { enabled: false })).status).toBe(400);
    try {
      const on = await h.api(owner.cookie, 'PUT', '/api/admin/chat', { viewersMayPost: true });
      expect(on.body).toEqual({ viewersMayPost: true, retentionDays: 365, workspaceChannel: true });
      expect((await send(vic, board, 'hello now')).status).toBe(201);
    } finally {
      await h.api(owner.cookie, 'PUT', '/api/admin/chat', { viewersMayPost: false });
    }
    expect((await send(vic, board, 'and again')).status).toBe(403);
    const rows = await auditOf('chat.settings');
    expect(rows[0]).toMatchObject({ actorId: owner.user.id, detail: { viewersMayPost: false } });
  });

  it('lets guests talk only on boards they were given', async () => {
    const { team, board } = await setup({ teamBoard: true });
    const guest = await makeGuest();
    // a guest in the board's team still has no role on its boards
    const join = await h.api(owner.cookie, 'POST', `/api/teams/${team.id}/invites`, { role: 'member' });
    expect(join.status).toBe(201);
    const teamGuest = await makeGuest();
    expect((await h.api(teamGuest.cookie, 'POST', `/api/invites/${join.body.token}/accept`)).status).toBe(200);
    expect((await list(teamGuest, board)).status).toBe(404);
    expect((await send(teamGuest, board, 'hi')).status).toBe(404);

    expect((await list(guest, board)).status).toBe(404);
    // the workspace owner shares it: the board owner cannot see a guest outside their teams
    await h.share(owner.cookie, board, guest.user.id, 'commenter');
    expect((await send(guest, board, 'thanks for having me')).status).toBe(201);
  });

  it('refuses writes with 402 while the workspace is read-only, but reads and read markers keep working', async () => {
    const { board, person } = await setup();
    const ana = await person('commenter');
    const posted = (await send(ana, board, 'before the lock')).body.message;
    expect((await internal({ readOnly: true })).status).toBe(200);
    try {
      for (const res of [
        await send(ana, board, 'during the lock'),
        await h.api(ana.cookie, 'PATCH', `/api/chat/messages/${posted.id}`, { text: 'changed' }),
        await h.api(ana.cookie, 'DELETE', `/api/chat/messages/${posted.id}`),
        await h.api(owner.cookie, 'PUT', '/api/admin/chat', { viewersMayPost: true }),
      ]) {
        expect(res.status).toBe(402);
        expect(res.body.error).toBe('read_only');
      }
      expect((await list(ana, board)).status).toBe(200);
      expect((await h.api(ana.cookie, 'PUT', `/api/chat/board/${board}/read`, { lastId: posted.id })).status).toBe(200);
      expect((await h.api(ana.cookie, 'GET', '/api/chat/unread')).status).toBe(200);
    } finally {
      await internal({ readOnly: false });
    }
    expect((await send(ana, board, 'after the lock')).status).toBe(201);
  });

  it('normalises and checks the text, and checks what a message points at', async () => {
    const { board, person } = await setup();
    const ana = await person('commenter');
    const ben = await person('commenter');
    const err = async (body: Record<string, unknown>) => {
      const res = await h.api(ana.cookie, 'POST', url(board), { clientId: cid(), ...body });
      return [res.status, res.body.error];
    };
    expect(await err({ text: '' })).toEqual([400, 'empty']);
    expect(await err({ text: ' \n\t​ ' })).toEqual([400, 'empty']);
    expect(await err({})).toEqual([400, 'empty']);
    expect(await err({ text: 'x'.repeat(2001) })).toEqual([400, 'too_long']);
    expect(await err({ text: 'x', clientId: 'bad id' })).toEqual([400, 'bad_request']);
    expect(await err({ text: 'x', objectId: '../../etc' })).toEqual([400, 'bad_request']);
    expect(await err({ text: 'x', replyTo: 'one' })).toEqual([400, 'bad_request']);
    const many = Array.from({ length: 11 }, (_, i) => `@{user${i}}`).join(' ');
    expect(await err({ text: many })).toEqual([400, 'too_many_mentions']);
    // the limit holds for what is stored: 500 mentions of nobody in the channel would become 4,000 characters of @someone
    expect(await err({ text: '@{a}'.repeat(500) })).toEqual([400, 'too_long']);

    const huge = await h.api(ana.cookie, 'POST', url(board), { clientId: cid(), text: 'x'.repeat(17 * 1024) });
    expect(huge.status).toBe(413);

    // a reply must point into the same channel
    const other = await setup();
    const elsewhere = (await send(other.creator, other.board, 'other channel')).body.message;
    expect(await err({ text: 'x', replyTo: elsewhere.id })).toEqual([400, 'bad_request']);

    const target = (await send(ben, board, 'target')).body.message;
    const res = await send(ana, board, `ok‮\r\n\r\n\r\n\r\n\r\nCafé @{${ben.user.id}} @{${other.creator.user.id}}  `, { replyTo: target.id, objectId: 'abcDEF123' });
    expect(res.status).toBe(201);
    expect(res.body.message).toMatchObject({
      text: `ok\n\n\nCafé @{${ben.user.id}} @someone`,
      replyTo: target.id,
      objectId: 'abcDEF123',
      mentions: [{ id: ben.user.id, name: ben.user.name }],
    });
  });

  it('needs the CSRF header and a matching origin on writes', async () => {
    const { board, person } = await setup();
    const ana = await person('commenter');
    const raw = (headers: Record<string, string>) =>
      fetch(`${h.base}${url(board)}`, {
        method: 'POST',
        headers: { cookie: ana.cookie, 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ clientId: cid(), text: 'forged' }),
      });
    const none = await raw({});
    expect(none.status).toBe(403);
    expect((await none.json()).error).toBe('csrf');
    expect((await raw({ 'x-tabula': '1', origin: 'https://evil.example.com' })).status).toBe(403);
    expect((await raw({ 'x-tabula': '1' })).status).toBe(201);
    expect((await list(ana, board)).body.messages).toHaveLength(1);
  });

  it('answers 429 with Retry-After when someone posts too fast, and keeps others posting', async () => {
    const { board, person } = await setup();
    const ana = await person('commenter');
    const ben = await person('commenter');
    // The relay's test-only ten-minute window prevents a loaded runner pause from expiring the burst mid-test.
    const statuses = (await Promise.all(Array.from({ length: 7 }, (_, i) => send(ana, board, `quick ${i}`)))).map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
    const limited = await send(ana, board, 'one more');
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ error: 'rate_limited' });
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(limited.body.retryAfter).toBe(Number(limited.headers.get('retry-after')));
    expect((await send(ben, board, 'not me')).status).toBe(201);
    // a retry of something already stored is not a new message and is never refused
    const stored = (await list(ana, board)).body.messages[0];
    expect((await h.api(ana.cookie, 'POST', url(board), { clientId: stored.clientId, text: 'again' })).status).toBe(200);
  });

  it('keeps a read marker per person that only moves forward, and an unread summary', async () => {
    const { board, person } = await setup();
    const ana = await person('commenter');
    const ben = await person('commenter');
    // Ben is seen before anything is said, so everything after counts
    expect((await h.api(ben.cookie, 'GET', '/api/chat/unread')).body).toEqual({ channels: [] });
    const a = (await send(ana, board, 'one')).body.message;
    const b = (await send(ana, board, `two for @{${ben.user.id}}`)).body.message;
    await send(ben, board, 'mine does not count');
    const summary = (await h.api(ben.cookie, 'GET', '/api/chat/unread')).body.channels;
    expect(summary).toEqual([{ kind: 'board', ref: board, lastId: 0, unread: 2, mentions: 1 }]);

    const read = await h.api(ben.cookie, 'PUT', `/api/chat/board/${board}/read`, { lastId: b.id });
    expect(read.body).toEqual({ kind: 'board', ref: board, lastId: b.id });
    expect((await h.api(ben.cookie, 'GET', '/api/chat/unread')).body).toEqual({ channels: [] });
    expect((await h.api(ben.cookie, 'PUT', `/api/chat/board/${board}/read`, { lastId: a.id })).body.lastId).toBe(b.id);
    expect((await h.api(ben.cookie, 'PUT', `/api/chat/board/${board}/read`, { lastId: 'x' })).status).toBe(400);
    // Ana's own messages are not unread for her
    expect((await h.api(ana.cookie, 'GET', '/api/chat/unread')).body.channels.filter((c: any) => c.ref === board)).toEqual([]);
  });

  it('describes a channel: what the caller may do and who can read it, never to an outsider', async () => {
    const { creator, board, person, outsider } = await setup();
    const ana = await person('commenter');
    const vic = await person('viewer');
    const stranger = await outsider();
    const meta = (who: Account) => h.api(who.cookie, 'GET', `/api/chat/board/${board}`);

    const mine = await meta(creator);
    expect(mine.status).toBe(200);
    expect(mine.body.access).toEqual({ write: true, moderate: true, role: 'owner', readOnly: false });
    const ids = mine.body.people.map((p: any) => p.id);
    expect(ids).toEqual(expect.arrayContaining([creator.user.id, ana.user.id, vic.user.id, owner.user.id]));
    expect(ids).not.toContain(stranger.user.id);
    expect(mine.body.people.every((p: any) => Object.keys(p).sort().join() === 'id,name')).toBe(true);

    expect((await meta(ana)).body.access).toEqual({ write: true, moderate: false, role: 'commenter', readOnly: false });
    expect((await meta(vic)).body.access).toMatchObject({ write: false, role: 'viewer' });
    try {
      await h.api(owner.cookie, 'PUT', '/api/admin/chat', { viewersMayPost: true });
      expect((await meta(vic)).body.access).toMatchObject({ write: true, role: 'viewer' });
    } finally {
      await h.api(owner.cookie, 'PUT', '/api/admin/chat', { viewersMayPost: false });
    }
    expect((await meta(stranger)).status).toBe(404);
    expect((await h.api(creator.cookie, 'GET', '/api/chat/team/x')).status).toBe(404);
    expect((await h.api(creator.cookie, 'GET', '/api/chat/board/no-such-board')).status).toBe(404);
  });

  it('gates the channel description exactly like reading the channel', async () => {
    const { creator, board, person, outsider } = await setup();
    const vic = await person('viewer');
    const gone = await person('commenter');
    const stranger = await outsider();
    const meta = (cookie: string, ref = board) => h.api(cookie, 'GET', `/api/chat/board/${ref}`);
    const messages = (cookie: string, ref = board) => h.api(cookie, 'GET', `/api/chat/board/${ref}/messages`);

    // a viewer reads the channel, so the viewer gets the description too
    expect((await meta(vic.cookie)).status).toBe(200);
    expect((await messages(vic.cookie)).status).toBe(200);

    // an outsider and a board that does not exist get the same 404, word for word, from both routes
    const hidden = await meta(stranger.cookie);
    const missing = await meta(creator.cookie, 'no-such-board-0001');
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(hidden.body).toEqual(missing.body);
    expect(hidden.body).toEqual((await messages(stranger.cookie)).body);

    // a disabled person: no description, and no longer among the people of the channel
    expect((await h.api(owner.cookie, 'PATCH', `/api/members/${gone.user.id}`, { disabled: true })).status).toBe(200);
    expect((await meta(gone.cookie)).status).toBe((await messages(gone.cookie)).status);
    expect((await meta(gone.cookie)).status).toBe(401);
    expect((await meta(creator.cookie)).body.people.map((p: any) => p.id)).not.toContain(gone.user.id);

    // a deleted board: hidden from its members, readable but not writable for workspace admins, as its messages are
    expect((await h.api(creator.cookie, 'DELETE', `/api/boards/${board}`)).status).toBe(204);
    for (const who of [creator, vic]) {
      const res = await meta(who.cookie);
      expect(res.status).toBe(404);
      expect(res.body).toEqual(hidden.body);
      expect((await messages(who.cookie)).status).toBe(404);
    }
    const admin = await meta(owner.cookie);
    expect(admin.status).toBe(200);
    expect(admin.body.access).toMatchObject({ write: false, moderate: false });
    expect((await messages(owner.cookie)).status).toBe(200);
  });

  it('limits the reads around a conversation with the same 429 and Retry-After', async () => {
    const { board, person } = await setup();
    const reads = [
      { max: 60, call: (who: Account) => h.api(who.cookie, 'GET', `/api/chat/board/${board}`) },
      { max: 60, call: (who: Account) => h.api(who.cookie, 'GET', '/api/chat/unread') },
      { max: 60, call: (who: Account) => h.api(who.cookie, 'PUT', `/api/chat/board/${board}/read`, { lastId: 0 }) },
      { max: 120, call: (who: Account) => h.api(who.cookie, 'GET', `/api/chat/board/${board}/messages`) },
    ];
    for (const { max, call } of reads) {
      const ana = await person('commenter');
      const answers = await Promise.all(Array.from({ length: max + 2 }, () => call(ana)));
      expect(answers.filter((r) => r.status === 200)).toHaveLength(max);
      const refused = answers.filter((r) => r.status === 429);
      expect(refused).toHaveLength(2);
      expect(refused[0].body).toMatchObject({ error: 'rate_limited' });
      const wait = Number(refused[0].headers.get('retry-after'));
      expect(wait).toBeGreaterThanOrEqual(1);
      expect(wait).toBeLessThanOrEqual(60);
      expect(refused[0].body.retryAfter).toBe(wait);
      // someone else is not affected
      const ben = await person('commenter');
      expect((await call(ben)).status).toBe(200);
    }
  });
});

describe('chat by default, and without it', { timeout: 60_000 }, () => {
  const off = createHarness({ accounts: true, settings: { CHAT: 'off' } });
  const on = createHarness({ accounts: true });
  const open = createHarness({ accounts: false, settings: { CHAT: 'on' } });
  beforeAll(async () => {
    await Promise.all([off.start(), on.start(), open.start()]);
  });
  afterAll(async () => {
    await Promise.all([off.cleanup(), on.cleanup(), open.cleanup()]);
  });

  it('is on in accounts mode with no setting at all', async () => {
    const who = await on.signInOwner();
    expect((await on.api(who.cookie, 'GET', '/api/me')).body.chat).toBe(true);
    expect((await on.api(who.cookie, 'GET', '/api/chat/unread')).status).toBe(200);
    expect((await on.api(who.cookie, 'GET', '/api/admin/chat')).status).toBe(200);
  });

  it('has no chat routes in accounts mode with TABULA_CHAT=off', async () => {
    const who = await off.signInOwner();
    expect((await off.api(who.cookie, 'GET', '/api/me')).body.chat).toBeUndefined();
    expect((await off.api(who.cookie, 'GET', '/api/chat/unread')).status).toBe(404);
    expect((await off.api(who.cookie, 'GET', '/api/admin/chat')).status).toBe(404);
  });

  it('has no chat in open mode, even with TABULA_CHAT=on', async () => {
    expect((await open.api(undefined, 'GET', '/api/chat/unread')).status).toBe(404);
    expect((await open.api(undefined, 'POST', '/api/chat/board/b1/messages', { clientId: cid(), text: 'x' })).status).toBe(404);
    expect(open.output()).toContain('TABULA_CHAT=on is ignored');
  });
});
