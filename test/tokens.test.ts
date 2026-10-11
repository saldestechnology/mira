import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../server/config.mjs';
import { BOARD_ID_RE, MIGRATIONS, openDirectory } from '../server/directory.mjs';
import { MAX_ACTIVE_TOKENS, TOKENS_MIGRATION, TOKEN_BOARD_ID_RE, TOKEN_PREFIX, newAccessToken, parseBoardIds } from '../server/tokens.mjs';

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_800_000_000_000;

const dirs: string[] = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokens-test-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const person = (d: ReturnType<typeof openDirectory>, role: 'owner' | 'admin' | 'member' | 'guest' = 'member') =>
  d.createUser({ email: `person${++n}@example.com`, role })!;

describe('access tokens in the directory', () => {
  it('creates a token that is found again with its owner, scope and boards', () => {
    const d = openDirectory(':memory:');
    const u = person(d);
    const made = d.createAccessToken({ userId: u.id, name: ' Claude Code ', scope: 'comment', boardIds: ['b1', 'b2'], ttlMs: 30 * DAY, now: T0 });
    expect(made.token).toMatch(new RegExp(`^${TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`));
    expect(made.expiresAt).toBe(T0 + 30 * DAY);
    const found = d.findAccessToken(made.token, T0 + 1);
    expect(found).toMatchObject({ id: made.id, userId: u.id, name: 'Claude Code', scope: 'comment', boardIds: ['b1', 'b2'], expiresAt: T0 + 30 * DAY });
    expect(found!.user).toMatchObject({ id: u.id, email: u.email, role: 'member', disabled: false });
    expect(d.listAccessTokens(u.id, T0)[0]).toMatchObject({ id: made.id, hint: made.token.slice(-4), lastUsedAt: null });
    d.touchAccessToken(made.id, T0 + 5);
    expect(d.getAccessToken(made.id, T0)?.lastUsedAt).toBe(T0 + 5);
    expect(d.createAccessToken({ userId: u.id, name: 'all', scope: 'read', ttlMs: DAY, now: T0 }).id).not.toBe(made.id);
    expect(d.findAccessToken(d.createAccessToken({ userId: u.id, name: 'x', scope: 'read', ttlMs: DAY, now: T0 }).token, T0)?.boardIds).toBeNull();
    d.close();
  });

  it('knows nothing about a token it was not given', () => {
    const d = openDirectory(':memory:');
    const u = person(d);
    const made = d.createAccessToken({ userId: u.id, name: 'a', scope: 'read', ttlMs: DAY, now: T0 });
    for (const bad of [newAccessToken(), '', made.token.slice(0, -1), `${made.token}x`, 'x'.repeat(300), `${made.token}\n`, undefined, null, 42, {}]) {
      expect(d.findAccessToken(bad as any, T0)).toBeNull();
    }
    expect(d.findAccessToken(made.token.toUpperCase(), T0)).toBeNull();
    d.close();
  });

  it('stores only a digest of the token, never the token', () => {
    const dir = tmp();
    const file = path.join(dir, 'directory.sqlite');
    const d = openDirectory(file);
    const u = person(d);
    const made = d.createAccessToken({ userId: u.id, name: 'a', scope: 'write', boardIds: ['b'], ttlMs: DAY, now: T0 });
    d.revokeAccessToken(made.id, T0);
    d.close();
    const digest = crypto.createHash('sha256').update(made.token).digest('hex');
    const bytes = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f)));
    expect(bytes.some((b) => b.includes(Buffer.from(digest)))).toBe(true);
    expect(bytes.some((b) => b.includes(Buffer.from(made.token)))).toBe(false);
    expect(bytes.some((b) => b.includes(Buffer.from(made.token.slice(TOKEN_PREFIX.length))))).toBe(false);
  });

  it('stops working when revoked, expired, or when its person is disabled or removed', () => {
    const d = openDirectory(':memory:');
    const u = person(d);
    const make = (ttlMs = DAY) => d.createAccessToken({ userId: u.id, name: 't', scope: 'write', ttlMs, now: T0 });

    const revoked = make();
    expect(d.revokeAccessToken(revoked.id, T0 + 1)).toBe(true);
    expect(d.revokeAccessToken(revoked.id, T0 + 2)).toBe(false);
    expect(d.findAccessToken(revoked.token, T0 + 3)).toBeNull();

    const brief = make(1000);
    expect(d.findAccessToken(brief.token, T0 + 999)).not.toBeNull();
    expect(d.findAccessToken(brief.token, T0 + 1000)).toBeNull();

    const live = make();
    d.updateUser(u.id, { disabled: true });
    expect(d.findAccessToken(live.token, T0 + 1)).toBeNull();
    d.updateUser(u.id, { disabled: false });
    expect(d.findAccessToken(live.token, T0 + 1)).not.toBeNull();

    d.removeUser(u.id);
    expect(d.findAccessToken(live.token, T0 + 1)).toBeNull();
    expect(d.listAccessTokensAdmin(T0 + 1)).toEqual([]);
    d.close();
  });

  it('lists active tokens only, without any digest, newest first', () => {
    const d = openDirectory(':memory:');
    const u = person(d, 'admin');
    const other = person(d);
    const a = d.createAccessToken({ userId: u.id, name: 'a', scope: 'read', ttlMs: 10 * DAY, now: T0 });
    const b = d.createAccessToken({ userId: u.id, name: 'b', scope: 'read', ttlMs: 10 * DAY, now: T0 + 10 });
    const gone = d.createAccessToken({ userId: u.id, name: 'gone', scope: 'read', ttlMs: 10 * DAY, now: T0 + 20 });
    d.createAccessToken({ userId: u.id, name: 'old', scope: 'read', ttlMs: 1000, now: T0 });
    d.createAccessToken({ userId: other.id, name: 'theirs', scope: 'read', ttlMs: 10 * DAY, now: T0 });
    d.revokeAccessToken(gone.id, T0 + 30);
    const now = T0 + DAY;
    expect(d.listAccessTokens(u.id, now).map((t: any) => t.name)).toEqual(['b', 'a']);
    expect(d.countActiveAccessTokens(u.id, now)).toBe(2);
    const admin = d.listAccessTokensAdmin(now);
    expect(admin.map((t: any) => t.name).sort()).toEqual(['a', 'b', 'theirs']);
    expect(admin.find((t: any) => t.name === 'a')).toMatchObject({ userName: u.name, email: u.email, userRole: 'admin' });
    for (const t of [...d.listAccessTokens(u.id, now), ...admin]) {
      expect(JSON.stringify(t)).not.toMatch(/hash|digest/i);
      expect(Object.keys(t)).not.toContain('token');
    }
    expect(d.revokeUserAccessTokens(u.id, now)).toBe(2);
    expect(d.revokeUserAccessTokens(u.id, now)).toBe(0);
    expect(d.findAccessToken(a.token, now)).toBeNull();
    expect(d.findAccessToken(b.token, now)).toBeNull();
    d.close();
  });

  it('deletes tokens revoked or expired more than 30 days ago when the next one is created', () => {
    const file = path.join(tmp(), 'directory.sqlite');
    const d = openDirectory(file);
    const u = person(d);
    const revoked = d.createAccessToken({ userId: u.id, name: 'revoked', scope: 'read', ttlMs: 100 * DAY, now: T0 });
    d.revokeAccessToken(revoked.id, T0);
    d.createAccessToken({ userId: u.id, name: 'expired', scope: 'read', ttlMs: DAY, now: T0 });
    d.createAccessToken({ userId: u.id, name: 'recent', scope: 'read', ttlMs: 100 * DAY, now: T0 });
    const rows = () => {
      // Close each read handle: Windows cannot remove the temp directory while one is open.
      const raw = new DatabaseSync(file);
      try {
        return (raw.prepare('SELECT name FROM access_tokens ORDER BY name').all() as { name: string }[]).map((r) => r.name);
      } finally {
        raw.close();
      }
    };
    expect(rows()).toEqual(['expired', 'recent', 'revoked']);
    d.createAccessToken({ userId: u.id, name: 'new', scope: 'read', ttlMs: DAY, now: T0 + 20 * DAY });
    expect(rows()).toEqual(['expired', 'new', 'recent', 'revoked']);
    d.createAccessToken({ userId: u.id, name: 'newer', scope: 'read', ttlMs: DAY, now: T0 + 31 * DAY + 1 });
    expect(rows()).toEqual(['new', 'newer', 'recent']);
    d.close();
  });

  it('reads a damaged board list as no board, never as every board', () => {
    const file = path.join(tmp(), 'directory.sqlite');
    const d = openDirectory(file);
    const u = person(d);
    const made = d.createAccessToken({ userId: u.id, name: 't', scope: 'write', boardIds: ['b'], ttlMs: DAY, now: T0 });
    const raw = new DatabaseSync(file);
    for (const damaged of ['not json', '[1]', '"b"', '{}', '["has space"]', JSON.stringify(Array.from({ length: 21 }, (_, i) => `b${i}`))]) {
      raw.prepare('UPDATE access_tokens SET board_ids = ?').run(damaged);
      expect(d.findAccessToken(made.token, T0)?.boardIds).toEqual([]);
    }
    raw.prepare('UPDATE access_tokens SET board_ids = NULL').run();
    expect(d.findAccessToken(made.token, T0)?.boardIds).toBeNull();
    raw.close();
    d.close();
    expect(parseBoardIds(undefined)).toBeNull();
    expect(parseBoardIds('["a","b"]')).toEqual(['a', 'b']);
  });

  it('refuses nonsense when creating', () => {
    const d = openDirectory(':memory:');
    const u = person(d);
    const base = { userId: u.id, name: 'n', scope: 'read', ttlMs: DAY, now: T0 };
    expect(() => d.createAccessToken({ ...base, scope: 'admin' })).toThrow('scope');
    expect(() => d.createAccessToken({ ...base, name: '  ' })).toThrow('name');
    expect(() => d.createAccessToken({ ...base, ttlMs: 0 })).toThrow('ttl');
    expect(() => d.createAccessToken({ ...base, boardIds: ['has space'] })).toThrow('boards');
    expect(() => d.createAccessToken({ ...base, boardIds: Array.from({ length: 21 }, (_, i) => `b${i}`) })).toThrow('boards');
    expect(() => d.createAccessToken({ ...base, userId: 'nobody' })).toThrow('FOREIGN KEY');
    expect(MAX_ACTIVE_TOKENS).toBe(20);
    d.close();
  });

  it('adds its table in migration 4 and keeps what a version 3 directory holds', () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(4);
    expect(MIGRATIONS[3]).toBe(TOKENS_MIGRATION);
    const file = path.join(tmp(), 'directory.sqlite');
    const d = openDirectory(file);
    const u = person(d, 'owner');
    d.createBoard({ id: 'board1', title: 'Kept', ownerId: u.id });
    const session = d.createSession(u.id, { ttlMs: DAY, now: T0 });
    d.close();

    const raw = new DatabaseSync(file);
    raw.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE notifications;
      UPDATE schema_meta SET value = '0' WHERE key = 'min_reader';
      DROP TABLE ticket_projection_outbox;
      DROP TABLE ticket_links;
      DROP TABLE kanban_state_mappings;
      DROP TABLE kanban_tracker_links;
      DROP TABLE saved_views;
      DROP TABLE ticket_relations;
      DROP TABLE milestones;
      DROP TABLE projects;
      DROP TABLE ticket_search;
      DROP TABLE ticket_comments;
      DROP TABLE ticket_events;
      DROP TABLE ticket_labels;
      DROP TABLE ticket_aliases;
      DROP TABLE ticket_subscriptions;
      DROP TABLE ticket_field_versions;
      DROP TABLE tickets;
      DROP TABLE ticket_states;
      DROP TABLE ticket_workflows;
      DROP TABLE ticket_counters;
      DROP TABLE labels;
      DROP TABLE trackers;
      DROP TABLE guest_sessions;
      DROP TABLE join_codes;
      DROP TABLE user_prefs;
      DROP TABLE assets;
      DROP TABLE templates;
      DROP TABLE ai_keys;
      DROP TABLE access_tokens;
      ALTER TABLE sessions DROP COLUMN user_agent;
      PRAGMA user_version = 3;
    `);
    raw.close();

    const again = openDirectory(file);
    expect(again.getUser(u.id)?.email).toBe(u.email);
    expect(again.getBoard('board1')?.title).toBe('Kept');
    expect(again.getSession(session.token, T0 + 1)?.user.id).toBe(u.id);
    const made = again.createAccessToken({ userId: u.id, name: 't', scope: 'read', ttlMs: DAY, now: T0 });
    expect(again.findAccessToken(made.token, T0)?.userId).toBe(u.id);
    again.close();
    const check = new DatabaseSync(file);
    expect((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
    check.close();
  });

  it('uses the same board id pattern as boards do', () => {
    expect(TOKEN_BOARD_ID_RE.source).toBe(BOARD_ID_RE.source);
  });
});

describe('configuration', () => {
  // each setting under both spellings, so this runs on a base that reads either
  const env = (settings: Record<string, string>) =>
    Object.fromEntries(Object.entries(settings).flatMap(([k, v]) => [[`MIRA_${k}`, v], [`TABULA_${k}`, v]]));
  const accounts = { AUTH: 'on', OWNER_EMAIL: 'owner@example.com' };
  const TOKEN = 'a'.repeat(32);
  const load = (settings: Record<string, string>) => loadConfig(env(settings));

  it('is off unless asked for', () => {
    expect(load({}).mcp).toBeUndefined();
    expect(load({ MCP: 'off' }).mcp).toBeUndefined();
    expect(load({ ...accounts }).mcp).toBeUndefined();
    expect(load({ MCP_TOKEN: TOKEN, MCP_SCOPE: 'nonsense' }).mcp).toBeUndefined();
  });

  it('refuses a value that is not on or off', () => {
    expect(() => load({ MCP: 'yes' })).toThrow(/TABULA_MCP must be on or off/);
    expect(() => load({ MCP: 'ON' })).toThrow(/TABULA_MCP must be on or off/);
  });

  it('turns on per-user tokens in accounts mode and says which settings it ignores', () => {
    expect(load({ ...accounts, MCP: 'on' }).mcp).toEqual({ mode: 'accounts', ignored: [] });
    expect(load({ ...accounts, MCP: 'on', MCP_TOKEN: TOKEN, MCP_SCOPE: 'write' }).mcp).toEqual({
      mode: 'accounts',
      ignored: ['TABULA_MCP_TOKEN', 'TABULA_MCP_SCOPE'],
    });
  });

  it('needs a long enough shared token in open mode, and a known scope', () => {
    expect(() => load({ MCP: 'on' })).toThrow(/TABULA_MCP_TOKEN/);
    expect(() => load({ MCP: 'on', MCP_TOKEN: 'short' })).toThrow(/TABULA_MCP_TOKEN/);
    expect(() => load({ MCP: 'on', MCP_TOKEN: `${'a'.repeat(16)} ${'b'.repeat(16)}` })).toThrow(/without spaces/);
    expect(() => load({ MCP: 'on', MCP_TOKEN: TOKEN, MCP_SCOPE: 'admin' })).toThrow(/TABULA_MCP_SCOPE/);
    expect(load({ MCP: 'on', MCP_TOKEN: TOKEN }).mcp).toEqual({ mode: 'open', token: TOKEN, scope: 'read', ignored: [] });
    expect(load({ MCP: 'on', MCP_TOKEN: ` ${TOKEN} `, MCP_SCOPE: 'comment' }).mcp).toMatchObject({ token: TOKEN, scope: 'comment' });
  });

  it('refuses to send tokens over plain http except to this machine', () => {
    const on = { ...accounts, MCP: 'on' };
    expect(() => load({ ...on, BASE_URL: 'http://tabula.example.com' })).toThrow(/https/);
    expect(() => load({ ...on, BASE_URL: 'http://192.168.1.5:8787' })).toThrow(/https/);
    for (const url of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787', 'https://tabula.example.com']) {
      expect(load({ ...on, BASE_URL: url }).mcp?.mode).toBe('accounts');
    }
    // not asked for: plain http is as it always was
    expect(load({ ...accounts, BASE_URL: 'http://tabula.example.com' }).mcp).toBeUndefined();
  });
});
