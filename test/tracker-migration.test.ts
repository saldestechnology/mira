import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ftsAvailable, MIGRATIONS, openDirectory } from '../server/directory.mjs';
import { maxReaderOf, migrate, readSchemaState } from '../server/schema.mjs';

const roots: string[] = [];
const opened: ReturnType<typeof openDirectory>[] = [];
const tmp = () => {
  const root = fs.mkdtempSync(fileURLToPath(new URL('./tracker-migration-', import.meta.url)));
  roots.push(root);
  return root;
};
const open = (file = ':memory:', options?: { ftsProbe?: (db: DatabaseSync) => boolean }) => {
  const directory = openDirectory(file, options);
  opened.push(directory);
  return directory;
};

function makeSchema11(file: string) {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, MIGRATIONS.slice(0, 11), 'directory');
    db.prepare("INSERT INTO users (id, email, name, role, disabled, created_at) VALUES ('u1', 'ada@example.com', 'Ada', 'owner', 0, 1)").run();
    db.prepare(
      `INSERT INTO access_tokens (id, user_id, name, token_hash, hint, scope, board_ids, created_at, expires_at)
       VALUES ('tok1', 'u1', 'legacy', ?, 'abcd', 'read', NULL, 1, 9999999999999)`,
    ).run('a'.repeat(64));
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const directory of opened.splice(0)) directory.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('tracker migration 13', () => {
  it('applies to a fresh directory with fixed seeds and the required FTS tokenizer', () => {
    const directory = open();
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(12);
    expect(typeof MIGRATIONS[11]).toBe('string');
    expect(ftsAvailable(directory.db)).toBe(true);
    expect(directory.db.prepare('SELECT id, name, prefix FROM trackers').all()).toEqual([{ id: 'trk_default', name: 'Tabula', prefix: 'TAB' }]);
    expect(directory.db.prepare('SELECT id, name, is_default FROM ticket_workflows').all()).toEqual([
      { id: 'wf_default', name: 'Default', is_default: 1 },
    ]);
    expect(directory.db.prepare('SELECT id, state_key, name, category, position, is_default FROM ticket_states ORDER BY position').all()).toEqual([
      { id: 'st_todo', state_key: 'todo', name: 'To do', category: 'unstarted', position: 0, is_default: 1 },
      { id: 'st_in_progress', state_key: 'in_progress', name: 'In progress', category: 'started', position: 1, is_default: 0 },
      { id: 'st_in_review', state_key: 'in_review', name: 'In review', category: 'started', position: 2, is_default: 0 },
      { id: 'st_done', state_key: 'done', name: 'Done', category: 'completed', position: 3, is_default: 0 },
      { id: 'st_cancelled', state_key: 'cancelled', name: 'Cancelled', category: 'canceled', position: 4, is_default: 0 },
    ]);
    expect(directory.db.prepare('SELECT scope, prefix, next_number FROM ticket_counters').all()).toEqual([
      { scope: 'trk_default', prefix: 'TAB', next_number: 1 },
    ]);
    expect(directory.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'ticket_search'").get()!.sql).toContain('unicode61 remove_diacritics 2');
    expect(directory.db.prepare('SELECT * FROM ticket_search WHERE ticket_search MATCH ?').all('"Tabula"')).toEqual([]);
  });

  it('upgrades schema 11 data without changing existing tables and reopens idempotently', () => {
    const file = path.join(tmp(), 'directory.sqlite');
    makeSchema11(file);
    const before = new DatabaseSync(file, { readOnly: true });
    const priorTables = before.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => String(row.name));
    const oldColumns = new Map(priorTables.filter((name) => name !== 'access_tokens').map((name) => [
      name,
      before.prepare(`PRAGMA table_info("${name.replaceAll('"', '""')}")`).all(),
    ]));
    before.close();

    const upgraded = open(file);
    expect(upgraded.getUser('u1')?.email).toBe('ada@example.com');
    expect(upgraded.findAccessToken('bad-token')).toBeNull();
    expect(upgraded.db.prepare("SELECT tracker FROM access_tokens WHERE id = 'tok1'").get()).toEqual({ tracker: null });
    for (const [name, columns] of oldColumns) {
      expect(upgraded.db.prepare(`PRAGMA table_info("${name.replaceAll('"', '""')}")`).all()).toEqual(columns);
    }
    expect(upgraded.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const state = readSchemaState(upgraded.db);
    expect(state).toEqual({ version: MIGRATIONS.length, minReader: 11, legacy: false });
    expect(upgraded.schemaReport()).toMatchObject({ build: { schema: MIGRATIONS.length, maxReader: 11 }, disk: { schema: MIGRATIONS.length, minReader: 11 } });
    expect(maxReaderOf(MIGRATIONS)).toBe(11);
    upgraded.close();

    const reopened = open(file);
    expect(reopened.db.prepare('SELECT COUNT(*) AS n FROM ticket_states').get()).toEqual({ n: 5 });
    expect(reopened.db.prepare("SELECT COUNT(*) AS n FROM users WHERE id = 'u1'").get()).toEqual({ n: 1 });
  });

  it('fails closed before migration 12 when the injected FTS probe is unavailable', () => {
    const file = path.join(tmp(), 'schema-11.sqlite');
    makeSchema11(file);
    expect(() => openDirectory(file, { ftsProbe: () => false })).toThrow(/migration 12 requires SQLite FTS5/);
    const db = new DatabaseSync(file, { readOnly: true });
    expect(Number(db.prepare('PRAGMA user_version').get()!.user_version)).toBe(11);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'trackers'").get()).toBeUndefined();
    expect(db.prepare('PRAGMA table_info(access_tokens)').all().map((column) => column.name)).not.toContain('tracker');
    expect(db.prepare("SELECT email FROM users WHERE id = 'u1'").get()).toEqual({ email: 'ada@example.com' });
    db.close();
  });

  it('adds migration 13 to a schema-12 database without changing existing tickets or their search and event rows', () => {
    const file = path.join(tmp(), 'schema-12-with-ticket.sqlite');
    const prior = new DatabaseSync(file);
    try {
      prior.exec('PRAGMA foreign_keys = ON');
      migrate(prior, MIGRATIONS.slice(0, 12), 'directory schema 12');
      prior.prepare("INSERT INTO users (id, email, name, role, disabled, created_at) VALUES ('u1', 'owner@example.com', 'Owner', 'owner', 0, 1)").run();
      prior.prepare(
        `INSERT INTO tickets (id, prefix, number, key, title, description, state_id, tracker_id, created_at, updated_at,
                              created_by_type, created_by_id, updated_seq, source)
         VALUES ('t1', 'TAB', 1, 'TAB-1', 'Existing ticket', 'unchanged', 'st_todo', 'trk_default', 2, 3, 'user', 'u1', 4, 'app')`,
      ).run();
      prior.prepare("INSERT INTO ticket_events (ticket_id, event_type, schema_version, actor_type, actor_id, source, created_at, after_json) VALUES ('t1', 'created', 1, 'user', 'u1', 'app', 2, '{\"title\":\"Existing ticket\"}')").run();
      prior.prepare("INSERT INTO ticket_search (ticket_id, title, description, comments, identifiers, aliases) VALUES ('t1', 'Existing ticket', 'unchanged', '', 'TAB-1', '')").run();
    } finally {
      prior.close();
    }

    const upgraded = open(file);
    expect(upgraded.db.prepare("SELECT id, key, title, description, project_id, milestone_id, updated_seq FROM tickets WHERE id = 't1'").get())
      .toEqual({ id: 't1', key: 'TAB-1', title: 'Existing ticket', description: 'unchanged', project_id: null, milestone_id: null, updated_seq: 4 });
    expect(upgraded.db.prepare("SELECT event_type, after_json FROM ticket_events WHERE ticket_id = 't1'").get())
      .toEqual({ event_type: 'created', after_json: '{"title":"Existing ticket"}' });
    expect(upgraded.db.prepare("SELECT title, description FROM ticket_search WHERE ticket_id = 't1'").get())
      .toEqual({ title: 'Existing ticket', description: 'unchanged' });
    expect(upgraded.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(readSchemaState(upgraded.db)).toEqual({ version: MIGRATIONS.length, minReader: 11, legacy: false });
    expect(typeof MIGRATIONS[12]).toBe('string');
    for (const table of ['projects', 'milestones', 'ticket_relations', 'saved_views']) {
      expect(upgraded.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toBeDefined();
    }
    expect(upgraded.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'projects_active_name'").get()).toBeDefined();
    expect(upgraded.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'milestones_project_due'").get()).toBeDefined();
    expect(upgraded.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'ticket_relations_normalized'").get()).toBeDefined();
    expect(upgraded.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'saved_views_shared_updated'").get()).toBeDefined();
    upgraded.db.prepare("INSERT INTO projects (id, name, state, created_at, updated_at) VALUES ('p1', 'Name', 'planned', 1, 1)").run();
    expect(() => upgraded.db.prepare("INSERT INTO projects (id, name, state, created_at, updated_at) VALUES ('p2', 'name', 'planned', 1, 1)").run())
      .toThrow(/UNIQUE constraint failed/);
    expect(() => upgraded.db.prepare(
      `INSERT INTO ticket_relations (id, ticket_id, related_ticket_id, kind, created_at, created_by_type)
       VALUES ('self', 't1', 't1', 'relates_to', 1, 'user')`,
    ).run()).toThrow(/CHECK constraint failed/);
  });

  it('validates nullable token tracker scopes in code', () => {
    const directory = open();
    const user = directory.createUser({ email: 'token@example.com', role: 'member' })!;
    const made = directory.createAccessToken({ userId: user.id, name: 'tracker reader', scope: 'read', tracker: 'read', ttlMs: 60_000 });
    expect(directory.findAccessToken(made.token)?.tracker).toBe('read');
    expect(() => directory.createAccessToken({ userId: user.id, name: 'bad tracker', scope: 'read', tracker: 'admin' as never, ttlMs: 60_000 })).toThrow(/tracker scope/);
    expect(directory.db.prepare('SELECT tracker FROM access_tokens WHERE id = ?').get(made.id)).toEqual({ tracker: 'read' });
  });
});
