import { migrationSql } from '../server/schema.mjs';
import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, openDirectory } from '../server/directory.mjs';

type Dir = ReturnType<typeof openDirectory>;
type WsRole = 'owner' | 'admin' | 'member' | 'guest';

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const opened: Dir[] = [];
const tmpDirs: string[] = [];

const open = (file = ':memory:') => {
  const d = openDirectory(file);
  opened.push(d);
  return d;
};
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tabula-dir-'));
  tmpDirs.push(d);
  return d;
};
const user = (d: Dir, email: string, role: WsRole = 'member') => d.createUser({ email, role })!;
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

afterEach(() => {
  for (const d of opened.splice(0)) d.close();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('migrations', () => {
  it('are idempotent when the same file is opened twice', () => {
    const file = path.join(tmp(), 'directory.sqlite');
    const first = open(file);
    const u = user(first, 'a@example.com', 'owner');
    first.close();

    const second = open(file);
    expect(second.getUser(u.id)?.email).toBe('a@example.com');
    second.close();

    const raw = new DatabaseSync(file);
    expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'users'").get()).toEqual({ n: 1 });
    raw.close();
  });

  it('migration 2 keeps the shares of a version 1 database and allows the commenter role', () => {
    const file = path.join(tmp(), 'directory.sqlite');
    const old = new DatabaseSync(file);
    old.exec('PRAGMA foreign_keys = ON');
    old.exec(migrationSql(MIGRATIONS[0]));
    old.exec('PRAGMA user_version = 1');
    const insert = (sql: string, ...params: (string | number)[]) => old.prepare(sql).run(...params);
    insert("INSERT INTO users (id, email, name, role, disabled, created_at) VALUES ('u1', 'a@example.com', 'Ada', 'member', 0, 1)");
    insert("INSERT INTO users (id, email, name, role, disabled, created_at) VALUES ('u2', 'b@example.com', 'Bob', 'member', 0, 1)");
    insert("INSERT INTO teams (id, name, archived, created_at) VALUES ('t1', 'Crew', 0, 1)");
    insert("INSERT INTO team_members (team_id, user_id, role) VALUES ('t1', 'u2', 'member')");
    insert("INSERT INTO boards (id, title, owner_id, team_id, created_at, updated_at) VALUES ('b1', 'Board', 'u1', NULL, 1, 1)");
    insert("INSERT INTO board_shares (board_id, principal_type, principal_id, role) VALUES ('b1', 'user', 'u2', 'viewer')");
    insert("INSERT INTO board_shares (board_id, principal_type, principal_id, role) VALUES ('b1', 'team', 't1', 'editor')");
    expect(() => insert("INSERT INTO board_shares (board_id, principal_type, principal_id, role) VALUES ('b1', 'user', 'u1', 'commenter')")).toThrow(/CHECK/);
    old.close();

    const d = open(file);
    expect(d.listShares('b1')).toEqual([
      { principalType: 'team', principalId: 't1', name: 'Crew', role: 'editor' },
      { principalType: 'user', principalId: 'u2', name: 'Bob', role: 'viewer' },
    ]);
    expect(d.boardRole('b1', 'u2')).toBe('editor');
    d.unshareBoard('b1', 'team', 't1');
    expect(d.boardRole('b1', 'u2')).toBe('viewer');
    d.shareBoard('b1', { principalType: 'user', principalId: 'u2', role: 'commenter' });
    expect(d.boardRole('b1', 'u2')).toBe('commenter');
    expect(d.listBoardsFor(d.getUser('u2')!).map((b) => [b.id, b.role])).toEqual([['b1', 'commenter']]);
    d.close();

    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA foreign_keys = ON');
    expect(raw.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
    const run = (sql: string, ...params: string[]) => raw.prepare(sql).run(...params);
    expect(() => run("INSERT INTO board_shares (board_id, principal_type, principal_id, role) VALUES ('b1', 'user', 'u1', 'owner')")).toThrow(/CHECK/);
    expect(() => run("INSERT INTO board_shares (board_id, principal_type, principal_id, role) VALUES ('b1', 'group', 'u1', 'viewer')")).toThrow(/CHECK/);
    expect(() => run("INSERT INTO board_shares (board_id, principal_type, principal_id, role) VALUES ('ghost', 'user', 'u1', 'viewer')")).toThrow(/FOREIGN KEY/);
    expect(() => run("INSERT INTO board_shares (board_id, principal_type, principal_id, role) VALUES ('b1', 'user', 'u2', 'viewer')")).toThrow(/UNIQUE|PRIMARY/);

    const columns = raw.prepare('PRAGMA table_info(board_shares)').all() as { name: string; pk: number; notnull: number }[];
    expect(columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name)).toEqual(['board_id', 'principal_type', 'principal_id']);
    expect(columns.every((c) => c.notnull === 1)).toBe(true);
    const indexes = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'board_shares' AND name NOT LIKE 'sqlite_%'").all();
    expect(indexes).toEqual([{ name: 'board_shares_principal' }]);
    const keys = raw.prepare('PRAGMA foreign_key_list(board_shares)').all() as { table: string; from: string; to: string; on_delete: string }[];
    expect(keys).toMatchObject([{ table: 'boards', from: 'board_id', to: 'id', on_delete: 'CASCADE' }]);
    expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'board_shares%'").get()).toEqual({ n: 2 });

    run("DELETE FROM boards WHERE id = 'b1'");
    expect(raw.prepare('SELECT COUNT(*) AS n FROM board_shares').get()).toEqual({ n: 0 });
    raw.close();
  });

  it('refuse a directory written by a newer schema', () => {
    const file = path.join(tmp(), 'directory.sqlite');
    open(file).close();
    const raw = new DatabaseSync(file);
    // a newer build that made a breaking change: its generation and the lowest reader are both ahead of this build
    raw.exec("PRAGMA user_version = 99; UPDATE schema_meta SET value = '99' WHERE key = 'min_reader'");
    raw.close();
    expect(() => openDirectory(file)).toThrow(/newer/);
  });

  it('refuse a directory of a newer build that predates min_reader, which is read strictly', () => {
    const file = path.join(tmp(), 'directory.sqlite');
    open(file).close();
    const raw = new DatabaseSync(file);
    raw.exec('DROP TABLE schema_meta; PRAGMA user_version = 99');
    raw.close();
    expect(() => openDirectory(file)).toThrow(/newer/);
  });

  it('create the parent directory of the database file', () => {
    const file = path.join(tmp(), 'nested', 'deeper', 'directory.sqlite');
    open(file);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('enforce foreign keys', () => {
    const d = open();
    expect(() => d.createSession('no-such-user', { ttlMs: MIN })).toThrow('FOREIGN KEY');
  });
});

describe('users', () => {
  it('normalise the email, default the name and return plain objects', () => {
    const d = open();
    const u = d.createUser({ email: '  Jane.Doe@Example.COM ', role: 'member' })!;
    expect(u).toMatchObject({ email: 'jane.doe@example.com', name: 'jane.doe', role: 'member', disabled: false });
    expect(Object.getPrototypeOf(u)).toBe(Object.prototype);
    expect(typeof u.createdAt).toBe('number');
    expect(d.createUser({ email: 'x@example.com', name: '  Xavier ', role: 'admin' })!.name).toBe('Xavier');
  });

  it('look users up by id and by email in any case', () => {
    const d = open();
    const u = user(d, 'a@example.com');
    expect(d.getUser(u.id)).toEqual(u);
    expect(d.getUserByEmail(' A@EXAMPLE.com ')).toEqual(u);
    expect(d.getUser('nope')).toBeNull();
    expect(d.getUserByEmail('nobody@example.com')).toBeNull();
    expect(d.getUserByEmail('not an email')).toBeNull();
  });

  it('reject duplicate, invalid and badly typed input', () => {
    const d = open();
    user(d, 'a@example.com');
    expect(() => user(d, 'A@Example.com')).toThrow('UNIQUE');
    for (const email of ['', 'plain', '@example.com', 'a@', 'a b@example.com', 'a@b@c.com', 'a@x.com,b@y.com', 'a\n@x.com', `${'a'.repeat(250)}@x.com`]) {
      expect(() => d.createUser({ email, role: 'member' })).toThrow(/invalid email/);
    }
    expect(() => d.createUser({ email: 'b@example.com', role: 'root' as WsRole })).toThrow(/invalid role/);
  });

  it('update name, role and disabled, and list users', () => {
    const d = open();
    const a = user(d, 'a@example.com');
    user(d, 'b@example.com');
    expect(d.updateUser(a.id, { name: 'Alice', role: 'admin' })).toMatchObject({ name: 'Alice', role: 'admin', disabled: false });
    expect(d.updateUser(a.id, { disabled: true })!.disabled).toBe(true);
    expect(d.updateUser(a.id, { disabled: false })!.disabled).toBe(false);
    expect(() => d.updateUser(a.id, { name: '   ' })).toThrow('invalid name');
    expect(() => d.updateUser(a.id, { role: 'god' as WsRole })).toThrow('invalid role');
    expect(() => d.updateUser('missing', { name: 'x' })).toThrow(/not found/);
    expect(d.listUsers().map((u) => u.email)).toEqual(['a@example.com', 'b@example.com']);
  });

  it('count owners', () => {
    const d = open();
    expect(d.countOwners()).toBe(0);
    user(d, 'a@example.com', 'owner');
    user(d, 'b@example.com', 'admin');
    expect(d.countOwners()).toBe(1);
  });

  it('lists the addresses of owners who are not disabled', () => {
    const d = open();
    const emails = () => d.listOwnerEmails().sort();
    expect(emails()).toEqual([]);
    user(d, 'b@example.com', 'owner');
    const off = user(d, 'off@example.com', 'owner');
    user(d, 'admin@example.com', 'admin');
    user(d, 'member@example.com', 'member');
    user(d, 'guest@example.com', 'guest');
    user(d, 'a@example.com', 'owner');
    d.updateUser(off.id, { disabled: true });
    expect(emails()).toEqual(['a@example.com', 'b@example.com']);
    d.updateUser(off.id, { disabled: false });
    expect(emails()).toEqual(['a@example.com', 'b@example.com', 'off@example.com']);
    d.updateUser(off.id, { role: 'admin' });
    expect(emails()).toEqual(['a@example.com', 'b@example.com']);
  });

  it('removeUser cascades memberships, sessions, shares and keeps their boards', () => {
    const d = open();
    const admin = user(d, 'admin@example.com', 'admin');
    const u = user(d, 'u@example.com');
    const other = user(d, 'other@example.com');
    const team = d.createTeam({ name: 'Team', creatorId: admin.id })!;
    d.addTeamMember(team.id, u.id, 'member');
    const session = d.createSession(u.id, { ttlMs: DAY, now: T0 });
    const invite = d.createInvite({ teamId: team.id, role: 'member', createdBy: u.id, ttlMs: DAY, now: T0 });
    d.createBoard({ id: 'mine', title: 'Mine', ownerId: u.id });
    d.createBoard({ id: 'shared', title: 'Shared', ownerId: other.id });
    d.shareBoard('shared', { principalType: 'user', principalId: u.id, role: 'viewer' });
    const token = d.createLoginToken({ email: 'u@example.com', ttlMs: MIN, now: T0 });

    d.removeUser(u.id);
    d.removeUser('already-gone');

    expect(d.getUser(u.id)).toBeNull();
    expect(d.getSession(session.token, T0)).toBeNull();
    expect(d.getTeamRole(team.id, u.id)).toBeNull();
    expect(d.countTeamAdmins(team.id)).toBe(1);
    expect(d.listShares('shared')).toEqual([]);
    expect(d.consumeLoginToken(token, T0)).toBeNull();
    expect(d.getBoard('mine')).toMatchObject({ id: 'mine', ownerId: null });
    expect(d.findInvite(invite.token, T0)).toMatchObject({ createdBy: null });
    expect(d.boardRole('mine', admin.id)).toBe('owner');
    expect(d.boardRole('mine', other.id)).toBeNull();
  });
});

describe('tokens at rest', () => {
  it('are stored only as SHA-256 hashes', () => {
    const file = path.join(tmp(), 'directory.sqlite');
    const d = open(file);
    const u = user(d, 'a@example.com', 'owner');
    const team = d.createTeam({ name: 'T', creatorId: u.id })!;
    const login = d.createLoginToken({ email: 'a@example.com', ttlMs: MIN, now: T0 });
    const session = d.createSession(u.id, { ttlMs: DAY, now: T0 });
    const invite = d.createInvite({ teamId: team.id, role: 'member', createdBy: u.id, ttlMs: DAY, now: T0 });

    for (const token of [login, session.token, invite.token]) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    expect(new Set([login, session.token, invite.token]).size).toBe(3);

    const raw = new DatabaseSync(file);
    const hashes = (table: string) => raw.prepare(`SELECT token_hash AS h FROM ${table}`).all().map((r) => String(r.h));
    expect(hashes('login_tokens')).toEqual([sha256(login)]);
    expect(hashes('sessions')).toEqual([sha256(session.token)]);
    expect(hashes('invites')).toEqual([sha256(invite.token)]);

    const dump = [login, session.token, invite.token];
    for (const table of ['login_tokens', 'sessions', 'invites']) {
      const rows = JSON.stringify(raw.prepare(`SELECT * FROM ${table}`).all());
      for (const token of dump) expect(rows.includes(token)).toBe(false);
    }
    raw.close();
  });
});

describe('login tokens', () => {
  it('can be consumed once, with the email normalised and the invite id returned', () => {
    const d = open();
    const plain = d.createLoginToken({ email: ' A@Example.com ', ttlMs: 15 * MIN, now: T0 });
    expect(d.consumeLoginToken(plain, T0 + 1)).toEqual({ email: 'a@example.com', inviteId: null });
    expect(d.consumeLoginToken(plain, T0 + 2)).toBeNull();

    const u = user(d, 'o@example.com', 'owner');
    const team = d.createTeam({ name: 'T', creatorId: u.id })!;
    const invite = d.createInvite({ teamId: team.id, role: 'member', createdBy: u.id, ttlMs: DAY, now: T0 });
    const withInvite = d.createLoginToken({ email: 'b@example.com', inviteId: invite.id, ttlMs: 15 * MIN, now: T0 });
    expect(d.consumeLoginToken(withInvite, T0)).toEqual({ email: 'b@example.com', inviteId: invite.id });
  });

  it('expire', () => {
    const d = open();
    const token = d.createLoginToken({ email: 'a@example.com', ttlMs: 15 * MIN, now: T0 });
    expect(d.consumeLoginToken(token, T0 + 15 * MIN)).toBeNull();
    expect(d.consumeLoginToken(token, T0 + 15 * MIN - 1)).toEqual({ email: 'a@example.com', inviteId: null });
  });

  it('reject unknown and malformed tokens', () => {
    const d = open();
    d.createLoginToken({ email: 'a@example.com', ttlMs: MIN, now: T0 });
    for (const bad of ['', 'x', 'x'.repeat(5000), undefined, null, 42, {}]) {
      expect(d.consumeLoginToken(bad as string, T0)).toBeNull();
    }
  });

  it('are pruned a day after they expire', () => {
    const file = path.join(tmp(), 'directory.sqlite');
    const d = open(file);
    d.createLoginToken({ email: 'a@example.com', ttlMs: MIN, now: T0 });
    d.createLoginToken({ email: 'b@example.com', ttlMs: MIN, now: T0 + 2 * DAY });
    const raw = new DatabaseSync(file);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM login_tokens').get()).toEqual({ n: 1 });
    raw.close();
  });
});

describe('sessions', () => {
  it('return the user, and null for garbage', () => {
    const d = open();
    const u = user(d, 'a@example.com');
    const s = d.createSession(u.id, { ttlMs: 10 * DAY, now: T0 });
    expect(s.expiresAt).toBe(T0 + 10 * DAY);
    expect(d.getSession(s.token, T0 + 1)).toMatchObject({ id: s.id, user: u, expiresAt: T0 + 10 * DAY, extended: false });
    for (const bad of ['', 'nope', 'x'.repeat(5000), undefined, null]) {
      expect(d.getSession(bad as string, T0)).toBeNull();
    }
  });

  it('slide when less than half the lifetime remains, and expire', () => {
    const d = open();
    const u = user(d, 'a@example.com');
    const s = d.createSession(u.id, { ttlMs: 10 * DAY, now: T0 });

    expect(d.getSession(s.token, T0 + 4 * DAY)).toMatchObject({ expiresAt: T0 + 10 * DAY, extended: false });
    const slid = d.getSession(s.token, T0 + 6 * DAY)!;
    expect(slid).toMatchObject({ expiresAt: T0 + 16 * DAY, extended: true });
    expect(d.getSession(s.token, T0 + 7 * DAY)).toMatchObject({ expiresAt: T0 + 16 * DAY, extended: false });
    expect(d.getSession(s.token, T0 + 12 * DAY)).toMatchObject({ expiresAt: T0 + 22 * DAY, extended: true });
    expect(d.getSession(s.token, T0 + 22 * DAY)).toBeNull();
  });

  it('expire without ever being used again', () => {
    const d = open();
    const s = d.createSession(user(d, 'a@example.com').id, { ttlMs: DAY, now: T0 });
    expect(d.getSession(s.token, T0 + DAY - 1)).not.toBeNull();
    const t = d.createSession(user(d, 'b@example.com').id, { ttlMs: DAY, now: T0 });
    expect(d.getSession(t.token, T0 + DAY)).toBeNull();
  });

  it('are rejected once revoked, and revokeUserSessions counts them', () => {
    const d = open();
    const u = user(d, 'a@example.com');
    const other = user(d, 'b@example.com');
    const s1 = d.createSession(u.id, { ttlMs: DAY, now: T0 });
    const s2 = d.createSession(u.id, { ttlMs: DAY, now: T0 });
    const s3 = d.createSession(u.id, { ttlMs: DAY, now: T0 });
    const keep = d.createSession(other.id, { ttlMs: DAY, now: T0 });

    d.revokeSession(s1.id);
    d.revokeSession('unknown');
    expect(d.getSession(s1.token, T0)).toBeNull();
    expect(d.getSession(s2.token, T0)).not.toBeNull();

    expect(d.revokeUserSessions(u.id)).toBe(2);
    expect(d.revokeUserSessions(u.id)).toBe(0);
    expect(d.getSession(s2.token, T0)).toBeNull();
    expect(d.getSession(s3.token, T0)).toBeNull();
    expect(d.getSession(keep.token, T0)).not.toBeNull();
  });

  it('are rejected for a disabled user, and disabling revokes them for good', () => {
    const d = open();
    const u = user(d, 'a@example.com');
    const s = d.createSession(u.id, { ttlMs: DAY, now: T0 });
    d.updateUser(u.id, { disabled: true });
    expect(d.getSession(s.token, T0)).toBeNull();
    d.updateUser(u.id, { disabled: false });
    expect(d.getSession(s.token, T0)).toBeNull();
    expect(d.getSession(d.createSession(u.id, { ttlMs: DAY, now: T0 }).token, T0)).not.toBeNull();
  });

  it('are rejected for a disabled user even when the session is still marked live', () => {
    const d = open();
    const u = user(d, 'a@example.com');
    d.updateUser(u.id, { disabled: true });
    const late = d.createSession(u.id, { ttlMs: DAY, now: T0 });
    expect(d.getSession(late.token, T0)).toBeNull();
  });

  it('are pruned a day after they expire', () => {
    const file = path.join(tmp(), 'directory.sqlite');
    const d = open(file);
    const u = user(d, 'a@example.com');
    d.createSession(u.id, { ttlMs: DAY, now: T0 });
    d.createSession(u.id, { ttlMs: DAY, now: T0 + 3 * DAY });
    const raw = new DatabaseSync(file);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 1 });
    raw.close();
  });
});

describe('teams', () => {
  it('makes the creator the team admin', () => {
    const d = open();
    const a = user(d, 'a@example.com');
    const team = d.createTeam({ name: '  Design ', creatorId: a.id })!;
    expect(team).toMatchObject({ name: 'Design', archived: false });
    expect(d.getTeamRole(team.id, a.id)).toBe('admin');
    expect(d.countTeamAdmins(team.id)).toBe(1);
    expect(d.getTeam(team.id)).toEqual(team);
    expect(d.getTeam('nope')).toBeNull();
    expect(() => d.createTeam({ name: ' ', creatorId: a.id })).toThrow('invalid name');
    expect(() => d.createTeam({ name: 'X', creatorId: 'ghost' })).toThrow('FOREIGN KEY');
    expect(d.listAllTeams().map((t) => t.name)).toEqual(['Design']);
  });

  it('manages members and roles', () => {
    const d = open();
    const a = user(d, 'a@example.com');
    const b = user(d, 'b@example.com');
    const c = user(d, 'c@example.com');
    const team = d.createTeam({ name: 'T', creatorId: a.id })!;

    d.addTeamMember(team.id, b.id, 'member');
    d.addTeamMember(team.id, c.id, 'member');
    expect(d.getTeamRole(team.id, b.id)).toBe('member');
    expect(d.countTeamAdmins(team.id)).toBe(1);

    d.setTeamRole(team.id, b.id, 'admin');
    expect(d.countTeamAdmins(team.id)).toBe(2);
    d.addTeamMember(team.id, b.id, 'member');
    expect(d.getTeamRole(team.id, b.id)).toBe('member');
    expect(() => d.setTeamRole(team.id, 'ghost', 'admin')).toThrow(/not a team member/);
    expect(() => d.addTeamMember(team.id, c.id, 'owner' as 'admin')).toThrow(/invalid role/);

    expect(d.listTeamMembers(team.id)).toEqual([
      { userId: a.id, name: 'a', email: 'a@example.com', role: 'admin' },
      { userId: b.id, name: 'b', email: 'b@example.com', role: 'member' },
      { userId: c.id, name: 'c', email: 'c@example.com', role: 'member' },
    ]);

    d.removeTeamMember(team.id, c.id);
    d.removeTeamMember(team.id, c.id);
    expect(d.getTeamRole(team.id, c.id)).toBeNull();
    expect(d.getTeamRole(team.id, 'ghost')).toBeNull();
  });

  it('counts the last admin correctly as admins come and go', () => {
    const d = open();
    const a = user(d, 'a@example.com');
    const b = user(d, 'b@example.com');
    const team = d.createTeam({ name: 'T', creatorId: a.id })!;
    d.addTeamMember(team.id, b.id, 'admin');
    expect(d.countTeamAdmins(team.id)).toBe(2);
    d.removeTeamMember(team.id, a.id);
    expect(d.countTeamAdmins(team.id)).toBe(1);
    d.setTeamRole(team.id, b.id, 'member');
    expect(d.countTeamAdmins(team.id)).toBe(0);
  });

  it('lists teams with the role of one user and with member counts', () => {
    const d = open();
    const a = user(d, 'a@example.com');
    const b = user(d, 'b@example.com');
    const t1 = d.createTeam({ name: 'Beta', creatorId: a.id })!;
    const t2 = d.createTeam({ name: 'alpha', creatorId: b.id })!;
    d.addTeamMember(t2.id, a.id, 'member');
    d.updateTeam(t1.id, { archived: true });

    expect(d.listTeamsFor(a.id)).toEqual([
      { ...d.getTeam(t2.id)!, role: 'member', memberCount: 2 },
      { ...d.getTeam(t1.id)!, role: 'admin', memberCount: 1, archived: true },
    ]);
    expect(d.listTeamsFor(b.id).map((t) => [t.name, t.role])).toEqual([['alpha', 'admin']]);
    expect(d.listAllTeams().map((t) => [t.name, t.role])).toEqual([['alpha', null], ['Beta', null]]);
    expect(d.listAllTeams(b.id).map((t) => [t.name, t.role])).toEqual([['alpha', 'admin'], ['Beta', null]]);
  });

  it('rename and archive', () => {
    const d = open();
    const team = d.createTeam({ name: 'Old', creatorId: user(d, 'a@example.com').id })!;
    expect(d.updateTeam(team.id, { name: 'New' })).toMatchObject({ name: 'New', archived: false });
    expect(d.updateTeam(team.id, { archived: true })).toMatchObject({ name: 'New', archived: true });
    expect(d.updateTeam(team.id, {})).toMatchObject({ name: 'New', archived: true });
    expect(() => d.updateTeam(team.id, { name: '' })).toThrow('invalid name');
    expect(() => d.updateTeam('nope', { name: 'x' })).toThrow(/not found/);
  });
});

describe('invites', () => {
  const setup = () => {
    const d = open();
    const admin = user(d, 'admin@example.com');
    const team = d.createTeam({ name: 'T', creatorId: admin.id })!;
    return { d, admin, team };
  };

  it('are found by token, never by anything else', () => {
    const { d, admin, team } = setup();
    const invite = d.createInvite({ teamId: team.id, role: 'member', createdBy: admin.id, ttlMs: DAY, now: T0 });
    expect(invite.expiresAt).toBe(T0 + DAY);
    expect(d.findInvite(invite.token, T0)).toEqual({
      id: invite.id,
      teamId: team.id,
      role: 'member',
      createdBy: admin.id,
      expiresAt: T0 + DAY,
      maxUses: null,
      uses: 0,
      revoked: false,
      createdAt: T0,
    });
    for (const bad of [invite.id, '', 'nope', undefined, null]) {
      expect(d.findInvite(bad as string, T0)).toBeNull();
    }
    expect(d.findInviteById(invite.id, T0)).toMatchObject({ id: invite.id });
    expect(d.findInviteById('nope', T0)).toBeNull();
  });

  it('are rejected when expired', () => {
    const { d, admin, team } = setup();
    const invite = d.createInvite({ teamId: team.id, role: 'member', createdBy: admin.id, ttlMs: DAY, now: T0 });
    expect(d.findInvite(invite.token, T0 + DAY - 1)).not.toBeNull();
    expect(d.findInvite(invite.token, T0 + DAY)).toBeNull();
    expect(d.findInviteById(invite.id, T0 + DAY)).toBeNull();
  });

  it('are rejected when revoked', () => {
    const { d, admin, team } = setup();
    const invite = d.createInvite({ teamId: team.id, role: 'admin', createdBy: admin.id, ttlMs: DAY, now: T0 });
    d.revokeInvite(invite.id);
    expect(d.findInvite(invite.token, T0)).toBeNull();
    expect(d.findInviteById(invite.id, T0)).toBeNull();
    expect(d.listInvites(team.id, T0)).toEqual([]);
  });

  it('are rejected when used up, and uses never exceed the maximum', () => {
    const { d, admin, team } = setup();
    const invite = d.createInvite({ teamId: team.id, role: 'member', createdBy: admin.id, ttlMs: DAY, maxUses: 2, now: T0 });
    d.recordInviteUse(invite.id);
    expect(d.findInvite(invite.token, T0)).toMatchObject({ uses: 1, maxUses: 2 });
    d.recordInviteUse(invite.id);
    d.recordInviteUse(invite.id);
    expect(d.findInvite(invite.token, T0)).toBeNull();
    expect(d.listInvites(team.id, T0)).toEqual([]);
  });

  it('count unlimited uses', () => {
    const { d, admin, team } = setup();
    const invite = d.createInvite({ teamId: team.id, role: 'member', createdBy: admin.id, ttlMs: DAY, now: T0 });
    for (let i = 0; i < 5; i++) d.recordInviteUse(invite.id);
    expect(d.findInvite(invite.token, T0)).toMatchObject({ uses: 5, maxUses: null });
  });

  it('list only the active invites of one team', () => {
    const { d, admin, team } = setup();
    const other = d.createTeam({ name: 'Other', creatorId: admin.id })!;
    const live = d.createInvite({ teamId: team.id, role: 'member', createdBy: admin.id, ttlMs: 2 * DAY, now: T0 });
    d.createInvite({ teamId: team.id, role: 'member', createdBy: admin.id, ttlMs: DAY, now: T0 });
    d.createInvite({ teamId: other.id, role: 'member', createdBy: admin.id, ttlMs: 2 * DAY, now: T0 });
    expect(d.listInvites(team.id, T0 + DAY + 1).map((i) => i.id)).toEqual([live.id]);
  });

  it('validate their arguments', () => {
    const { d, admin, team } = setup();
    const base = { teamId: team.id, createdBy: admin.id, now: T0 };
    expect(() => d.createInvite({ ...base, role: 'owner' as 'admin', ttlMs: DAY })).toThrow(/invalid role/);
    expect(() => d.createInvite({ ...base, role: 'member', ttlMs: 0 })).toThrow(/invalid ttl/);
    expect(() => d.createInvite({ ...base, role: 'member', ttlMs: DAY, maxUses: 0 })).toThrow(/invalid maxUses/);
    expect(() => d.createInvite({ ...base, teamId: 'ghost', role: 'member', ttlMs: DAY })).toThrow('FOREIGN KEY');
  });
});

describe('boards', () => {
  it('create, read and update', () => {
    const d = open();
    const a = user(d, 'a@example.com');
    const team = d.createTeam({ name: 'T', creatorId: a.id })!;
    const b = d.createBoard({ id: 'board-1', title: '  Roadmap ', ownerId: a.id })!;
    expect(b).toMatchObject({ id: 'board-1', title: 'Roadmap', ownerId: a.id, teamId: null, deletedAt: null });
    expect(b.updatedAt).toBe(b.createdAt);
    expect(d.createBoard({ id: 'b2', ownerId: a.id, teamId: team.id })).toMatchObject({ title: 'Untitled board', teamId: team.id });

    expect(d.updateBoard('board-1', { title: 'New', teamId: team.id })).toMatchObject({ title: 'New', teamId: team.id });
    expect(d.updateBoard('board-1', { teamId: null })).toMatchObject({ title: 'New', teamId: null });
    expect(d.updateBoard('board-1', {})).toMatchObject({ title: 'New', teamId: null });
    expect(() => d.updateBoard('nope', { title: 'x' })).toThrow(/not found/);
    expect(() => d.updateBoard('board-1', { teamId: 'ghost' })).toThrow('FOREIGN KEY');
    expect(d.getBoard('nope')).toBeNull();
  });

  it('only accept a valid room id, once', () => {
    const d = open();
    const a = user(d, 'a@example.com');
    for (const id of ['', 'has space', 'slash/slash', 'dot.dot', 'x'.repeat(65), '../x']) {
      expect(() => d.createBoard({ id, title: 't', ownerId: a.id })).toThrow(/invalid board id/);
    }
    d.createBoard({ id: 'x'.repeat(64), title: 't', ownerId: a.id });
    d.createBoard({ id: 'Ab_-9', title: 't', ownerId: a.id });
    expect(() => d.createBoard({ id: 'Ab_-9', title: 't', ownerId: a.id })).toThrow('UNIQUE');
    expect(() => d.createBoard({ id: 'ghostly', title: 't', ownerId: 'ghost' })).toThrow('FOREIGN KEY');
  });

  it('are soft deleted: the row stays, nobody but admins has access', () => {
    const d = open();
    const admin = user(d, 'admin@example.com', 'admin');
    const a = user(d, 'a@example.com');
    d.createBoard({ id: 'b', title: 't', ownerId: a.id });
    expect(d.boardRole('b', a.id)).toBe('owner');

    d.deleteBoard('b');
    const deletedAt = d.getBoard('b')!.deletedAt;
    expect(typeof deletedAt).toBe('number');
    d.deleteBoard('b');
    expect(d.getBoard('b')!.deletedAt).toBe(deletedAt);

    expect(d.boardRole('b', a.id)).toBeNull();
    expect(d.boardRole('b', admin.id)).toBe('owner');
    expect(d.listBoardsFor(a)).toEqual([]);
    expect(d.listBoardsFor(admin)).toEqual([]);
    expect(() => d.createBoard({ id: 'b', title: 't', ownerId: a.id })).toThrow('UNIQUE');
  });

  it('touchBoard bumps updatedAt and copies a bounded title', () => {
    const d = open();
    const a = user(d, 'a@example.com');
    const b = d.createBoard({ id: 'b', title: 'Old', ownerId: a.id })!;
    d.touchBoard('b');
    expect(d.getBoard('b')!.title).toBe('Old');
    expect(d.getBoard('b')!.updatedAt).toBeGreaterThanOrEqual(b.updatedAt);

    d.touchBoard('b', { title: 'x'.repeat(5000) });
    expect(d.getBoard('b')!.title).toHaveLength(200);
    d.touchBoard('b', { title: '   ' });
    expect(d.getBoard('b')!.title).toBe('Untitled board');
    d.touchBoard('missing', { title: 'ignored' });
    expect(d.getBoard('missing')).toBeNull();
  });

  it('share to users and teams, upsert the role, list with names and unshare', () => {
    const d = open();
    const a = user(d, 'a@example.com');
    const b = user(d, 'b@example.com');
    const team = d.createTeam({ name: 'Crew', creatorId: a.id })!;
    d.createBoard({ id: 'board', title: 't', ownerId: a.id });

    d.shareBoard('board', { principalType: 'user', principalId: b.id, role: 'viewer' });
    d.shareBoard('board', { principalType: 'team', principalId: team.id, role: 'editor' });
    d.shareBoard('board', { principalType: 'user', principalId: b.id, role: 'editor' });
    expect(d.listShares('board')).toEqual([
      { principalType: 'team', principalId: team.id, name: 'Crew', role: 'editor' },
      { principalType: 'user', principalId: b.id, name: 'b', role: 'editor' },
    ]);

    d.unshareBoard('board', 'user', b.id);
    d.unshareBoard('board', 'user', b.id);
    expect(d.listShares('board').map((s) => s.principalType)).toEqual(['team']);

    expect(() => d.shareBoard('board', { principalType: 'user', principalId: 'ghost', role: 'viewer' })).toThrow(/not found/);
    expect(() => d.shareBoard('board', { principalType: 'team', principalId: b.id, role: 'viewer' })).toThrow(/not found/);
    expect(() => d.shareBoard('board', { principalType: 'user', principalId: b.id, role: 'owner' as 'editor' })).toThrow(/invalid role/);
    expect(() => d.shareBoard('board', { principalType: 'group' as 'user', principalId: b.id, role: 'viewer' })).toThrow('invalid principal type');
    expect(() => d.shareBoard('ghost', { principalType: 'user', principalId: b.id, role: 'viewer' })).toThrow('FOREIGN KEY');
  });
});

type Scenario = keyof typeof MATRIX;
type Expected = readonly [owner: string | null, admin: string | null, member: string | null, guest: string | null];

// columns: workspace owner, admin, member, guest
const MATRIX = {
  none: ['owner', 'owner', null, null],
  creator: ['owner', 'owner', 'owner', 'owner'],
  creatorAndSharedViewer: ['owner', 'owner', 'owner', 'owner'],
  teamMember: ['owner', 'owner', 'editor', null],
  teamAdmin: ['owner', 'owner', 'owner', null],
  sharedUserViewer: ['owner', 'owner', 'viewer', 'viewer'],
  sharedUserEditor: ['owner', 'owner', 'editor', 'editor'],
  sharedTeamViewer: ['owner', 'owner', 'viewer', 'viewer'],
  sharedTeamEditor: ['owner', 'owner', 'editor', 'editor'],
  teamMemberAndSharedViewer: ['owner', 'owner', 'editor', 'viewer'],
  teamAdminAndSharedViewer: ['owner', 'owner', 'owner', 'viewer'],
  teamMemberAndBoardTeamSharedViewer: ['owner', 'owner', 'editor', 'viewer'],
  sharedUserViewerAndSharedTeamEditor: ['owner', 'owner', 'editor', 'editor'],
  sharedUserEditorAndSharedTeamViewer: ['owner', 'owner', 'editor', 'editor'],
  creatorAndSharedCommenter: ['owner', 'owner', 'owner', 'owner'],
  sharedUserCommenter: ['owner', 'owner', 'commenter', 'commenter'],
  sharedTeamCommenter: ['owner', 'owner', 'commenter', 'commenter'],
  teamMemberAndSharedCommenter: ['owner', 'owner', 'editor', 'commenter'],
  teamAdminAndSharedCommenter: ['owner', 'owner', 'owner', 'commenter'],
  teamMemberAndBoardTeamSharedCommenter: ['owner', 'owner', 'editor', 'commenter'],
  sharedUserViewerAndSharedTeamCommenter: ['owner', 'owner', 'commenter', 'commenter'],
  sharedUserCommenterAndSharedTeamViewer: ['owner', 'owner', 'commenter', 'commenter'],
  sharedUserCommenterAndSharedTeamEditor: ['owner', 'owner', 'editor', 'editor'],
  sharedUserEditorAndSharedTeamCommenter: ['owner', 'owner', 'editor', 'editor'],
} as const satisfies Record<string, Expected>;

const WS_ROLES: WsRole[] = ['owner', 'admin', 'member', 'guest'];
const scenarios = Object.keys(MATRIX) as Scenario[];

type Ctx = { d: Dir; x: { id: string }; boardTeam: { id: string }; crew: { id: string } };
type Level = 'editor' | 'commenter' | 'viewer';

const shareUser = (c: Ctx, role: Level) => c.d.shareBoard('b', { principalType: 'user', principalId: c.x.id, role });
const shareCrew = (c: Ctx, role: Level) => {
  c.d.addTeamMember(c.crew.id, c.x.id, 'member');
  c.d.shareBoard('b', { principalType: 'team', principalId: c.crew.id, role });
};

const SETUP: Record<Scenario, (c: Ctx) => void> = {
  none: () => {},
  creator: () => {},
  creatorAndSharedViewer: (c) => shareUser(c, 'viewer'),
  teamMember: (c) => c.d.addTeamMember(c.boardTeam.id, c.x.id, 'member'),
  teamAdmin: (c) => c.d.addTeamMember(c.boardTeam.id, c.x.id, 'admin'),
  sharedUserViewer: (c) => shareUser(c, 'viewer'),
  sharedUserEditor: (c) => shareUser(c, 'editor'),
  sharedTeamViewer: (c) => shareCrew(c, 'viewer'),
  sharedTeamEditor: (c) => shareCrew(c, 'editor'),
  teamMemberAndSharedViewer: (c) => {
    c.d.addTeamMember(c.boardTeam.id, c.x.id, 'member');
    shareUser(c, 'viewer');
  },
  teamAdminAndSharedViewer: (c) => {
    c.d.addTeamMember(c.boardTeam.id, c.x.id, 'admin');
    shareUser(c, 'viewer');
  },
  teamMemberAndBoardTeamSharedViewer: (c) => {
    c.d.addTeamMember(c.boardTeam.id, c.x.id, 'member');
    c.d.shareBoard('b', { principalType: 'team', principalId: c.boardTeam.id, role: 'viewer' });
  },
  sharedUserViewerAndSharedTeamEditor: (c) => {
    shareUser(c, 'viewer');
    shareCrew(c, 'editor');
  },
  sharedUserEditorAndSharedTeamViewer: (c) => {
    shareUser(c, 'editor');
    shareCrew(c, 'viewer');
  },
  creatorAndSharedCommenter: (c) => shareUser(c, 'commenter'),
  sharedUserCommenter: (c) => shareUser(c, 'commenter'),
  sharedTeamCommenter: (c) => shareCrew(c, 'commenter'),
  teamMemberAndSharedCommenter: (c) => {
    c.d.addTeamMember(c.boardTeam.id, c.x.id, 'member');
    shareUser(c, 'commenter');
  },
  teamAdminAndSharedCommenter: (c) => {
    c.d.addTeamMember(c.boardTeam.id, c.x.id, 'admin');
    shareUser(c, 'commenter');
  },
  teamMemberAndBoardTeamSharedCommenter: (c) => {
    c.d.addTeamMember(c.boardTeam.id, c.x.id, 'member');
    c.d.shareBoard('b', { principalType: 'team', principalId: c.boardTeam.id, role: 'commenter' });
  },
  sharedUserViewerAndSharedTeamCommenter: (c) => {
    shareUser(c, 'viewer');
    shareCrew(c, 'commenter');
  },
  sharedUserCommenterAndSharedTeamViewer: (c) => {
    shareUser(c, 'commenter');
    shareCrew(c, 'viewer');
  },
  sharedUserCommenterAndSharedTeamEditor: (c) => {
    shareUser(c, 'commenter');
    shareCrew(c, 'editor');
  },
  sharedUserEditorAndSharedTeamCommenter: (c) => {
    shareUser(c, 'editor');
    shareCrew(c, 'commenter');
  },
};

// Board 'b' belongs to the board team and is created by C (so C administers that team), unless the scenario makes X the creator.
function fixture(scenario: Scenario, wsRole: WsRole) {
  const d = open();
  const x = user(d, 'x@example.com', wsRole);
  const c = user(d, 'c@example.com');
  const boardTeam = d.createTeam({ name: 'Board team', creatorId: c.id })!;
  const crew = d.createTeam({ name: 'Crew', creatorId: c.id })!;
  const xCreates = scenario === 'creator' || scenario === 'creatorAndSharedViewer' || scenario === 'creatorAndSharedCommenter';
  d.createBoard({ id: 'b', title: 'B', ownerId: xCreates ? x.id : c.id, teamId: boardTeam.id });
  SETUP[scenario]({ d, x, boardTeam, crew });
  return { d, x };
}

const AFTER_DELETE: Record<WsRole, string | null> = { owner: 'owner', admin: 'owner', member: null, guest: null };

describe('boardRole matrix', () => {
  const rows = scenarios.flatMap((scenario) =>
    WS_ROLES.map((wsRole, i) => ({ scenario, wsRole, expected: MATRIX[scenario][i] })),
  );

  it.each(rows)('$wsRole / $scenario -> $expected', ({ scenario, wsRole, expected }) => {
    const { d, x } = fixture(scenario, wsRole);
    expect(d.boardRole('b', x.id)).toBe(expected);
  });

  it.each(rows)('$wsRole / $scenario on a soft-deleted board', ({ scenario, wsRole }) => {
    const { d, x } = fixture(scenario, wsRole);
    d.deleteBoard('b');
    expect(d.boardRole('b', x.id)).toBe(AFTER_DELETE[wsRole]);
  });

  it.each(rows)('$wsRole / $scenario for a disabled user', ({ scenario, wsRole }) => {
    const { d, x } = fixture(scenario, wsRole);
    d.updateUser(x.id, { disabled: true });
    expect(d.boardRole('b', x.id)).toBeNull();
  });

  it('is null for unknown boards and users and bad input', () => {
    const d = open();
    const a = user(d, 'a@example.com', 'owner');
    expect(d.boardRole('nope', a.id)).toBeNull();
    expect(d.boardRole('b', 'nope')).toBeNull();
    expect(d.boardRole(undefined as unknown as string, a.id)).toBeNull();
    expect(d.boardRole('b', undefined as unknown as string)).toBeNull();
  });

  it('ranks viewer below commenter below editor below owner, whichever way the shares are made', () => {
    const d = open();
    const c = user(d, 'c@example.com');
    const x = user(d, 'x@example.com');
    d.createBoard({ id: 'b', title: 'B', ownerId: c.id });
    const roleAfter = (role: Level) => {
      d.shareBoard('b', { principalType: 'user', principalId: x.id, role });
      return d.boardRole('b', x.id);
    };
    expect(roleAfter('viewer')).toBe('viewer');
    expect(roleAfter('commenter')).toBe('commenter');
    expect(roleAfter('editor')).toBe('editor');
    expect(roleAfter('commenter')).toBe('commenter');
    expect(roleAfter('viewer')).toBe('viewer');
    d.shareBoard('b', { principalType: 'user', principalId: c.id, role: 'viewer' });
    expect(d.boardRole('b', c.id)).toBe('owner');
  });

  it('follows team changes immediately', () => {
    const { d, x } = fixture('teamMember', 'member');
    expect(d.boardRole('b', x.id)).toBe('editor');
    const boardTeamId = d.getBoard('b')!.teamId!;
    d.removeTeamMember(boardTeamId, x.id);
    expect(d.boardRole('b', x.id)).toBeNull();
    d.addTeamMember(boardTeamId, x.id, 'admin');
    expect(d.boardRole('b', x.id)).toBe('owner');
    d.updateBoard('b', { teamId: null });
    expect(d.boardRole('b', x.id)).toBeNull();
  });
});

describe('listBoardsFor', () => {
  function world() {
    const d = open();
    const owner = user(d, 'owner@example.com', 'owner');
    const admin = user(d, 'admin@example.com', 'admin');
    const alice = user(d, 'alice@example.com');
    const bob = user(d, 'bob@example.com');
    const carol = user(d, 'carol@example.com');
    const guest = user(d, 'guest@example.com', 'guest');
    const guestMember = user(d, 'guest2@example.com', 'guest');
    const nobody = user(d, 'nobody@example.com');
    const disabled = user(d, 'disabled@example.com');

    const t1 = d.createTeam({ name: 'T1', creatorId: alice.id })!;
    const t2 = d.createTeam({ name: 'T2', creatorId: bob.id })!;
    const t3 = d.createTeam({ name: 'T3', creatorId: carol.id })!;
    d.addTeamMember(t1.id, carol.id, 'member');
    d.addTeamMember(t1.id, guestMember.id, 'member');
    d.addTeamMember(t2.id, alice.id, 'member');
    d.addTeamMember(t3.id, guest.id, 'member');
    d.addTeamMember(t1.id, disabled.id, 'admin');

    const board = (id: string, ownerId: string, teamId: string | null = null) => d.createBoard({ id, title: id, ownerId, teamId });
    board('alice-personal', alice.id);
    board('bob-personal', bob.id);
    board('t1-board', alice.id, t1.id);
    board('t1-by-carol', carol.id, t1.id);
    board('t2-board', bob.id, t2.id);
    board('t3-board', carol.id, t3.id);
    board('owner-board', owner.id);
    board('shared-to-guest', bob.id);
    board('shared-to-team', bob.id);
    board('shared-editor', bob.id);
    board('t2-shared-to-t1', bob.id, t2.id);
    board('deleted-personal', alice.id);
    board('deleted-team', alice.id, t1.id);
    board('deleted-shared', bob.id);
    board('unrelated', bob.id);

    d.shareBoard('shared-to-guest', { principalType: 'user', principalId: guest.id, role: 'viewer' });
    d.shareBoard('shared-to-team', { principalType: 'team', principalId: t3.id, role: 'viewer' });
    d.shareBoard('shared-editor', { principalType: 'user', principalId: alice.id, role: 'editor' });
    d.shareBoard('shared-editor', { principalType: 'user', principalId: guest.id, role: 'editor' });
    d.shareBoard('t2-shared-to-t1', { principalType: 'team', principalId: t1.id, role: 'viewer' });
    d.shareBoard('t1-board', { principalType: 'user', principalId: bob.id, role: 'viewer' });
    d.shareBoard('deleted-shared', { principalType: 'user', principalId: alice.id, role: 'editor' });
    d.shareBoard('deleted-shared', { principalType: 'user', principalId: guest.id, role: 'editor' });
    // commenter shares: above a viewer share (either way round), below an editor share or team membership, never reviving a deleted board
    d.shareBoard('unrelated', { principalType: 'user', principalId: carol.id, role: 'commenter' });
    d.shareBoard('bob-personal', { principalType: 'team', principalId: t3.id, role: 'commenter' });
    d.shareBoard('t2-board', { principalType: 'user', principalId: alice.id, role: 'commenter' });
    d.shareBoard('shared-to-team', { principalType: 'user', principalId: guest.id, role: 'commenter' });
    d.shareBoard('t2-shared-to-t1', { principalType: 'user', principalId: carol.id, role: 'commenter' });
    d.shareBoard('shared-editor', { principalType: 'team', principalId: t3.id, role: 'commenter' });
    d.shareBoard('deleted-personal', { principalType: 'user', principalId: carol.id, role: 'commenter' });
    d.deleteBoard('deleted-personal');
    d.deleteBoard('deleted-team');
    d.deleteBoard('deleted-shared');
    d.updateUser(disabled.id, { disabled: true });

    return { d, users: { owner, admin, alice, bob, carol, guest, guestMember, nobody, disabled } };
  }

  const asMap = (list: { id: string; role: string }[]) => Object.fromEntries(list.map((b) => [b.id, b.role]));

  it('agrees with boardRole for every board and every user', () => {
    const { d, users } = world();
    const boards = ['alice-personal', 'bob-personal', 't1-board', 't1-by-carol', 't2-board', 't3-board', 'owner-board', 'shared-to-guest', 'shared-to-team', 'shared-editor', 't2-shared-to-t1', 'deleted-personal', 'deleted-team', 'deleted-shared', 'unrelated'];
    for (const u of Object.values(users)) {
      const expected: Record<string, string> = {};
      for (const id of boards) {
        const role = d.boardRole(id, u.id);
        if (role && d.getBoard(id)!.deletedAt === null) expected[id] = role;
      }
      expect(asMap(d.listBoardsFor(u))).toEqual(expected);
    }
  });

  it('gives the expected boards to each kind of user', () => {
    const { d, users } = world();
    const list = (u: keyof typeof users) => asMap(d.listBoardsFor(users[u]));

    expect(Object.keys(list('owner'))).toHaveLength(12);
    expect(Object.values(list('admin')).every((r) => r === 'owner')).toBe(true);
    expect(list('admin')).toEqual(list('owner'));
    expect(list('alice')).toEqual({
      'alice-personal': 'owner',
      't1-board': 'owner',
      't1-by-carol': 'owner',
      't2-board': 'editor',
      'shared-editor': 'editor',
      't2-shared-to-t1': 'editor',
    });
    expect(list('carol')).toEqual({
      't1-board': 'editor',
      't1-by-carol': 'owner',
      't3-board': 'owner',
      't2-shared-to-t1': 'commenter',
      'shared-to-team': 'viewer',
      'unrelated': 'commenter',
      'bob-personal': 'commenter',
      'shared-editor': 'commenter',
    });
    expect(list('bob')).toEqual({
      'bob-personal': 'owner',
      't2-board': 'owner',
      't2-shared-to-t1': 'owner',
      't1-board': 'viewer',
      'shared-to-guest': 'owner',
      'shared-to-team': 'owner',
      'shared-editor': 'owner',
      'unrelated': 'owner',
    });
    expect(list('guest')).toEqual({
      'shared-to-guest': 'viewer',
      'shared-editor': 'editor',
      'shared-to-team': 'commenter',
      'bob-personal': 'commenter',
    });
    expect(list('guestMember')).toEqual({ 't2-shared-to-t1': 'viewer' });
    expect(list('nobody')).toEqual({});
    expect(list('disabled')).toEqual({});
  });

  it('returns board objects with the role, newest first', () => {
    const { d, users } = world();
    d.touchBoard('alice-personal');
    const list = d.listBoardsFor(users.alice);
    expect(list[0]).toMatchObject({ id: 'alice-personal', title: 'alice-personal', teamId: null, ownerId: users.alice.id, deletedAt: null, role: 'owner' });
    expect(Object.getPrototypeOf(list[0])).toBe(Object.prototype);
    const updated = list.map((b) => b.updatedAt);
    expect(updated).toEqual([...updated].sort((a, b) => b - a));
  });

  it('trusts the database, not the user object it is handed', () => {
    const { d, users } = world();
    const forged = { ...users.nobody, role: 'owner' as const };
    expect(d.listBoardsFor(forged)).toEqual([]);
    expect(d.listBoardsFor({ ...users.guest, id: 'ghost' })).toEqual([]);
    expect(d.listBoardsFor(undefined as unknown as typeof forged)).toEqual([]);
    expect(asMap(d.listBoardsFor({ ...users.guest, role: 'admin' as const }))).toEqual(asMap(d.listBoardsFor(users.guest)));
  });

  it('follows role changes', () => {
    const { d, users } = world();
    d.updateUser(users.nobody.id, { role: 'admin' });
    expect(d.listBoardsFor(users.nobody)).toHaveLength(12);
    d.updateUser(users.nobody.id, { role: 'guest' });
    expect(d.listBoardsFor(users.nobody)).toEqual([]);
  });
});

describe('transaction', () => {
  it('commits on success and rolls back on error, nested too', () => {
    const d = open();
    const a = user(d, 'a@example.com');

    expect(d.transaction(() => d.createTeam({ name: 'kept', creatorId: a.id })!.name)).toBe('kept');

    expect(() =>
      d.transaction(() => {
        d.createTeam({ name: 'lost', creatorId: a.id });
        throw new Error('boom');
      }),
    ).toThrow('boom');

    d.transaction(() => {
      d.createTeam({ name: 'outer', creatorId: a.id });
      expect(() =>
        d.transaction(() => {
          d.createTeam({ name: 'inner-lost', creatorId: a.id });
          throw new Error('inner');
        }),
      ).toThrow('inner');
      d.createTeam({ name: 'outer-2', creatorId: a.id });
    });

    expect(() =>
      d.transaction(() => {
        d.transaction(() => d.createTeam({ name: 'nested-lost', creatorId: a.id }));
        throw new Error('outer');
      }),
    ).toThrow('outer');

    expect(d.listAllTeams().map((t) => t.name).sort()).toEqual(['kept', 'outer', 'outer-2']);
  });
});

describe('audit', () => {
  it('records actions newest first with parsed detail', () => {
    const d = open();
    const a = user(d, 'a@example.com');
    d.audit(a.id, 'team.create', { teamId: 't1' });
    d.audit(null, 'system.start');
    d.audit(a.id, 'board.delete', { boardId: 'b', nested: { n: [1, 2] } });

    const rows = d.listAudit();
    expect(rows.map((r) => r.action)).toEqual(['board.delete', 'system.start', 'team.create']);
    expect(rows[0]).toMatchObject({ actorId: a.id, detail: { boardId: 'b', nested: { n: [1, 2] } } });
    expect(rows[1]).toMatchObject({ actorId: null, detail: {} });
    expect(typeof rows[0].ts).toBe('number');
    expect(d.listAudit(2)).toHaveLength(2);
    expect(d.listAudit(0)).toHaveLength(3);
    expect(d.listAudit(-5)).toHaveLength(3);
  });

  it('keeps rows after the actor is removed', () => {
    const d = open();
    const a = user(d, 'a@example.com');
    d.audit(a.id, 'x');
    d.removeUser(a.id);
    expect(d.listAudit()).toHaveLength(1);
  });
});

describe('per-person preferences', () => {
  it('start empty, are kept per person and key, and are replaced by a later value', () => {
    const d = open();
    const ana = user(d, 'ana@example.test');
    const ben = user(d, 'ben@example.test');
    expect(d.getPref(ana.id, 'chat.emailMentions')).toBeNull();
    d.setPref(ana.id, 'chat.emailMentions', '0');
    d.setPref(ana.id, 'other', 'x');
    expect(d.getPref(ana.id, 'chat.emailMentions')).toBe('0');
    expect(d.getPref(ben.id, 'chat.emailMentions')).toBeNull();
    d.setPref(ana.id, 'chat.emailMentions', '1');
    expect(d.getPref(ana.id, 'chat.emailMentions')).toBe('1');
    expect(d.getPref(ana.id, 'other')).toBe('x');
  });

  it('are refused for someone who does not exist, and go with the person who is removed', () => {
    const d = open();
    expect(() => d.setPref('nobody', 'k', 'v')).toThrow('user not found');
    const ana = user(d, 'ana@example.test');
    d.setPref(ana.id, 'k', 'v');
    d.removeUser(ana.id);
    expect(d.getPref(ana.id, 'k')).toBeNull();
  });
});
