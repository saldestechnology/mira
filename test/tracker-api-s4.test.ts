import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as Y from 'yjs';
import { createHarness, until, type Account, type Body } from './mcp-harness';

const objs = (doc: { getMap(name: string): unknown }): any => doc.getMap('objects');

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLOUD_TOKEN = 'c'.repeat(48);
const h = createHarness({
  accounts: true,
  settings: { TRACKER: 'on' },
  dir: path.join(ROOT, `.tracker-api-s4-${process.pid}-${Date.now()}`),
});
let owner: Account;
let member: Account;
let viewer: Account;
let guest: Account;
let outsider: Account;
let boardId: string;
let live: ReturnType<typeof h.connect>;
let linkId: string;

const api = (who: Account, method: string, route: string, body?: unknown) => h.api(who.cookie, method, route, body);

function put(doc: Y.Doc, id: string, type: string, fields: Record<string, unknown> = {}) {
  objs(doc).set(id, new Y.Map(Object.entries({ id, type, ...fields })));
}

function seedBoard(doc: Y.Doc) {
  put(doc, 'kanban-1', 'container', { layout: 'kanban' });
  put(doc, 'lane-todo', 'lane', { parent: 'kanban-1', name: 'To do', stage: 'todo', rank: 'a0@kanban-1' });
  put(doc, 'lane-done', 'lane', { parent: 'kanban-1', name: 'Done', stage: 'done', rank: 'a1@kanban-1' });
  put(doc, 'lane-free', 'lane', { parent: 'kanban-1', name: 'Someday', rank: 'a2@kanban-1' });
  put(doc, 'card-1', 'card', { parent: 'lane-todo', rank: 'a0@lane-todo', text: 'First card', desc: 'From the board' });
  put(doc, 'card-2', 'card', { parent: 'lane-free', rank: 'a0@lane-free', text: 'Unmapped card' });

  put(doc, 'kanban-mass', 'container', { layout: 'kanban' });
  put(doc, 'mass-lane', 'lane', { parent: 'kanban-mass', name: 'To do', stage: 'todo', rank: 'a0@kanban-mass' });
  for (let i = 0; i < 501; i++) {
    const id = `mass-card-${i}`;
    put(doc, id, 'card', { parent: 'mass-lane', rank: `a${i}@mass-lane`, text: `Mass card ${i}` });
  }
}

function count(table: string) {
  const db = new DatabaseSync(path.join(h.dir, 'directory.sqlite'));
  try { return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n); } finally { db.close(); }
}

function activeLinkCount() {
  const db = new DatabaseSync(path.join(h.dir, 'directory.sqlite'));
  try { return Number(db.prepare('SELECT COUNT(*) AS n FROM kanban_tracker_links WHERE removed_at IS NULL').get()!.n); } finally { db.close(); }
}

const linkBody = (idempotencyKey = 'server-link-create-123') => ({
  boardId, kanbanId: 'kanban-1', mapping: { 'lane-todo': 'todo', 'lane-done': 'done' },
  createTickets: true, idempotencyKey,
});

beforeAll(async () => {
  await h.start();
  owner = await h.signInOwner();
  const teamId = (await h.newTeam(owner.cookie)).id;
  member = await h.joinTeam(owner.cookie, teamId);
  viewer = await h.joinTeam(owner.cookie, teamId);
  guest = await h.joinTeam(owner.cookie, teamId);
  outsider = await h.joinTeam(owner.cookie, teamId);
  const changed = await api(owner, 'PATCH', `/api/members/${guest.user.id}`, { role: 'guest' });
  if (changed.status !== 200) throw new Error(`could not make a guest (${changed.status})`);

  boardId = await h.newBoard(owner.cookie);
  await h.share(owner.cookie, boardId, member.user.id, 'editor');
  await h.share(owner.cookie, boardId, viewer.user.id, 'viewer');
  await h.share(owner.cookie, boardId, guest.user.id, 'editor');
  const doc = new Y.Doc();
  seedBoard(doc);
  fs.writeFileSync(h.roomFile(boardId), Y.encodeStateAsUpdate(doc));
  doc.destroy();
  live = h.connect(boardId, owner.cookie);
  await live.synced();
});

afterAll(async () => {
  h.closeProviders();
  await h.cleanup();
});

describe('tracker slice 4 HTTP routes', () => {
  it('links, replays, creates a later card ticket, projects ticket transitions, and unlinks cleanly', async () => {
    const suggested = await api(owner, 'GET', `/api/tracker/links/suggest?boardId=${boardId}&kanbanId=kanban-1`);
    expect(suggested.status).toBe(200);
    expect(suggested.body).toMatchObject({
      mapping: { 'lane-todo': 'todo', 'lane-done': 'done' },
      lanes: [{ laneId: 'lane-todo', stateKey: 'todo' }, { laneId: 'lane-done', stateKey: 'done' }, { laneId: 'lane-free', stateKey: null }],
      nextKey: 'TAB-1', cardCount: 2,
    });
    expect((await api(owner, 'GET', `/api/tracker/links?boardId=${boardId}`)).body.links).toEqual([]);

    const created = await api(owner, 'POST', '/api/tracker/links', linkBody());
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      link: { boardId, kanbanId: 'kanban-1', cardCount: 1 },
      created: [{ cardId: 'card-1', ticket: { key: 'TAB-1', title: 'First card', state: { key: 'todo' }, links: [{ kind: 'card', cardId: 'card-1' }] } }],
      skipped: [{ cardId: 'card-2', reason: 'unmapped_lane' }],
      projectionPending: false,
    });
    linkId = created.body.link.id;
    expect(await api(owner, 'POST', '/api/tracker/links', linkBody())).toMatchObject({ status: 201, body: created.body });
    expect(await api(owner, 'POST', '/api/tracker/links', linkBody('second-link-key-123')))
      .toMatchObject({ status: 409, body: { error: 'conflict', path: 'kanbanId' } });
    expect(await api(owner, 'GET', `/api/tracker/links/suggest?boardId=${boardId}&kanbanId=kanban-1`))
      .toMatchObject({ status: 409, body: { error: 'conflict', path: 'kanbanId' } });
    expect(count('tickets')).toBe(1);
    expect((await api(viewer, 'GET', `/api/tracker/tickets/TAB-1`)).body.ticket.links).toContainEqual(expect.objectContaining({ kind: 'card', boardId, cardId: 'card-1' }));
    expect((await api(outsider, 'GET', `/api/tracker/tickets/TAB-1`)).body.ticket.links).toEqual([]);
    await until(() => {
      const tracker = objs(live.doc).get('card-1')?.get('tracker');
      return !!tracker && typeof tracker === 'object' && (tracker as Body).ticketKey === 'TAB-1';
    });
    expect(objs(live.doc).get('card-1')?.toJSON()).toMatchObject({
      extProvider: 'tabula', extKey: 'TAB-1', tracker: { title: 'First card', state: { key: 'todo' } },
    });

    const changed = await api(owner, 'PATCH', '/api/tracker/tickets/TAB-1', { state: 'done' });
    expect(changed.status).toBe(200);
    expect(changed.body.ticket.state.key).toBe('done');
    await until(() => objs(live.doc).get('card-1')?.get('parent') === 'lane-done');
    expect(objs(live.doc).get('card-1')?.get('tracker')).toMatchObject({ state: { key: 'done' } });

    live.doc.transact(() => put(live.doc, 'card-late', 'card', {
      parent: 'lane-todo', rank: 'a9@lane-todo', text: 'Late card',
    }), 'test');
    let cardTicket: any;
    // the late card reaches the relay through the live socket; the route answers not_found until then
    await until(async () => {
      cardTicket = await api(owner, 'POST', `/api/tracker/links/${linkId}/cards`, {
        cardId: 'card-late', idempotencyKey: 'server-card-create-123',
      });
      return cardTicket.status !== 404;
    });
    expect(cardTicket.status).toBe(201);
    expect(cardTicket.body).toMatchObject({ cardId: 'card-late', ticket: { key: 'TAB-2' }, projectionPending: false });
    expect(await api(owner, 'POST', `/api/tracker/links/${linkId}/cards`, {
      cardId: 'card-late', idempotencyKey: 'server-card-create-123',
    })).toMatchObject({ status: 201, body: cardTicket.body });
    expect((await api(owner, 'POST', `/api/tracker/links/${linkId}/cards`, {
      cardId: 'card-late', idempotencyKey: 'another-card-key-123',
    })).body).toMatchObject({ error: 'conflict', path: 'cardId' });

    const unlinked = await api(owner, 'DELETE', `/api/tracker/links/${linkId}`);
    expect(unlinked.status).toBe(200);
    expect(unlinked.body).toMatchObject({ unlinked: 2, projectionPending: false, link: { removedAt: expect.any(Number) } });
    expect(count('tickets')).toBe(2);
    await until(() => !objs(live.doc).get('card-1')?.has('tracker') && !objs(live.doc).get('kanban-1')?.has('ext'));
    expect(objs(live.doc).get('card-1')?.toJSON()).toMatchObject({ text: 'First card', parent: 'lane-done' });
    expect((await api(owner, 'GET', `/api/tracker/links?boardId=${boardId}`)).body.links).toEqual([]);
    expect((await api(owner, 'GET', '/api/tracker/tickets/TAB-1')).body.ticket.links).toEqual([]);
    expect(await api(owner, 'DELETE', `/api/tracker/links/${linkId}`))
      .toMatchObject({ status: 404, body: { error: 'not_found' } });
  });

  it('returns contract errors for missing resources, invalid or duplicate mappings, and oversize batches', async () => {
    const missingBoard = await api(owner, 'GET', '/api/tracker/links');
    expect(missingBoard).toMatchObject({ status: 400, body: { error: 'invalid_input', path: 'boardId' } });
    expect(await api(owner, 'GET', `/api/tracker/links/suggest?boardId=${boardId}`))
      .toMatchObject({ status: 400, body: { error: 'invalid_input', path: 'kanbanId' } });
    expect(await api(owner, 'GET', '/api/tracker/links?boardId=missing-board'))
      .toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(await api(owner, 'GET', `/api/tracker/links/suggest?boardId=${boardId}&kanbanId=missing-kanban`))
      .toMatchObject({ status: 404, body: { error: 'not_found' } });

    const invalids = [
      { mapping: { foreign: 'todo' }, path: 'mapping.foreign' },
      { mapping: { 'lane-todo': 'missing' }, path: 'mapping.lane-todo' },
      { mapping: { 'lane-todo': 'todo', 'lane-done': 'todo' }, path: 'mapping.lane-done' },
      { mapping: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`lane-${i}`, 'todo'])), path: 'mapping' },
      { project: 'Missing', path: 'project' },
      { labels: ['Missing'], path: 'labels[0]' },
      { createTickets: null, path: 'createTickets' },
      { idempotencyKey: 'short', path: 'idempotencyKey' },
    ];
    for (const [index, invalid] of invalids.entries()) {
      const { path: expectedPath, ...fields } = invalid;
      const result = await api(owner, 'POST', '/api/tracker/links', { ...linkBody(`invalid-map-key-${index}`), ...fields });
      expect([expectedPath, result.status]).toEqual([expectedPath, 400]);
      expect(result.body).toMatchObject({ error: 'invalid_input', path: expectedPath });
    }
    const duplicateMapping = await fetch(`${h.base}/api/tracker/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: owner.cookie, 'x-mira': '1', 'x-tabula': '1' },
      body: `{"boardId":"${boardId}","kanbanId":"kanban-1","mapping":{"lane-todo":"todo","lane-todo":"done"},"idempotencyKey":"duplicate-map-key-123"}`,
    });
    expect(duplicateMapping.status).toBe(400);
    expect(await duplicateMapping.json()).toMatchObject({ error: 'invalid_input', path: 'mapping.lane-todo' });
    const created = await api(owner, 'POST', '/api/tracker/links', {
      boardId, kanbanId: 'kanban-1', mapping: { 'lane-todo': 'todo', 'lane-done': 'done' },
      idempotencyKey: 'link-for-card-error-123',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ created: [], link: { cardCount: 0 } });
    const unmappedCard = await api(owner, 'POST', `/api/tracker/links/${created.body.link.id}/cards`, {
      cardId: 'card-2', idempotencyKey: 'unmapped-card-key-123',
    });
    expect(unmappedCard).toMatchObject({ status: 400, body: { error: 'invalid_input', path: 'cardId' } });
    const badCard = await api(owner, 'POST', `/api/tracker/links/${created.body.link.id}/cards`, {
      cardId: 'missing-card', idempotencyKey: 'missing-card-key-123',
    });
    expect(badCard).toMatchObject({ status: 400, body: { error: 'invalid_input', path: 'cardId' } });
    await api(owner, 'DELETE', `/api/tracker/links/${created.body.link.id}`);
    const wrongCard = await api(owner, 'POST', '/api/tracker/links/unknown/cards', {
      cardId: 'missing-card', idempotencyKey: 'missing-card-key-123',
    });
    expect(wrongCard).toMatchObject({ status: 404, body: { error: 'not_found' } });

    const tooMany = await api(owner, 'POST', '/api/tracker/links', {
      boardId, kanbanId: 'kanban-mass', mapping: { 'mass-lane': 'todo' }, createTickets: true, idempotencyKey: 'mass-create-key-123',
    });
    expect(tooMany).toMatchObject({ status: 413, body: { error: 'limit_exceeded', path: 'createTickets' } });
    expect(activeLinkCount()).toBe(0);
  });

  it('enforces viewer, guest and non-member access on both reads and writes', async () => {
    expect((await api(viewer, 'GET', `/api/tracker/links?boardId=${boardId}`)).status).toBe(200);
    expect(await api(viewer, 'POST', '/api/tracker/links', linkBody('viewer-denied-123')))
      .toMatchObject({ status: 403, body: { error: 'forbidden' } });
    expect(await api(viewer, 'DELETE', '/api/tracker/links/unknown'))
      .toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(await api(guest, 'POST', '/api/tracker/links', linkBody('guest-denied-123')))
      .toMatchObject({ status: 403, body: { error: 'forbidden' } });
    expect(await api(guest, 'GET', `/api/tracker/links?boardId=${boardId}`))
      .toMatchObject({ status: 403, body: { error: 'forbidden' } });
    expect(await api(outsider, 'GET', `/api/tracker/links?boardId=${boardId}`))
      .toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(await api(outsider, 'POST', '/api/tracker/links', linkBody('outsider-denied-123')))
      .toMatchObject({ status: 404, body: { error: 'not_found' } });
  });

  it('applies the tracker mutation window before processing invalid payloads', async () => {
    for (let i = 0; i < 60; i++) {
      const response = await api(member, 'POST', '/api/tracker/links', { unsupported: true });
      expect(response.status).toBe(400);
    }
    expect(await api(member, 'POST', '/api/tracker/links', { unsupported: true }))
      .toMatchObject({ status: 429, body: { error: 'rate_limited' } });
  });
});

describe('tracker linked-kanban hosted read-only', () => {
  const cloud = createHarness({
    accounts: true,
    settings: {
      TRACKER: 'on', CLOUD_TOKEN, CLOUD_URL: 'http://127.0.0.1:9', CLOUD_WORKSPACE_ID: 'tracker-s4-readonly',
    },
    dir: path.join(ROOT, `.tracker-api-s4-readonly-${process.pid}-${Date.now()}`),
  });
  it('keeps reads available and blocks link writes before changing the directory', async () => {
    try {
      await cloud.start();
      const account = await cloud.signInOwner();
      const board = await cloud.newBoard(account.cookie);
      const doc = new Y.Doc();
      put(doc, 'kanban-1', 'container', { layout: 'kanban' });
      put(doc, 'lane-todo', 'lane', { parent: 'kanban-1', name: 'To do', stage: 'todo', rank: 'a0@kanban-1' });
      fs.writeFileSync(cloud.roomFile(board), Y.encodeStateAsUpdate(doc));
      doc.destroy();
      const limits = await cloud.api(undefined, 'PUT', '/api/internal/limits', { readOnly: true }, { authorization: `Bearer ${CLOUD_TOKEN}` });
      expect(limits.status).toBe(200);
      const before = new DatabaseSync(path.join(cloud.dir, 'directory.sqlite'));
      let linksBefore = 0;
      try { linksBefore = Number(before.prepare('SELECT COUNT(*) AS n FROM kanban_tracker_links').get()!.n); } finally { before.close(); }

      expect((await cloud.api(account.cookie, 'GET', `/api/tracker/links?boardId=${board}`)).status).toBe(200);
      expect(await cloud.api(account.cookie, 'POST', '/api/tracker/links', {
        boardId: board, kanbanId: 'kanban-1', mapping: { 'lane-todo': 'todo' }, idempotencyKey: 'readonly-link-key-123',
      })).toMatchObject({ status: 403, body: { error: 'read_only' } });
      const after = new DatabaseSync(path.join(cloud.dir, 'directory.sqlite'));
      try { expect(Number(after.prepare('SELECT COUNT(*) AS n FROM kanban_tracker_links').get()!.n)).toBe(linksBefore); } finally { after.close(); }
    } finally {
      await cloud.cleanup();
    }
  });
});
