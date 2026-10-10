import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normaliseEmail } from './config.mjs';
import { describeSchema, migrate, readSchemaState } from './schema.mjs';
import { TEMPLATES_MIGRATION, createTemplateStore } from './templates.mjs';
import { TOKENS_MIGRATION, createTokenStore } from './tokens.mjs';
import { AI_KEYS_MIGRATION, AI_KEYS_MODEL_MIGRATION, createAiKeyStore } from './ai/keys.mjs';
import { ASSETS_MIGRATION, createAssetIndex } from './assets.mjs';

export { normaliseEmail };

export const BOARD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const USER_ROLES = ['owner', 'admin', 'member', 'guest'];
const TEAM_ROLES = ['admin', 'member'];
const SHARE_ROLES = ['editor', 'commenter', 'viewer'];
const PRINCIPAL_TYPES = ['user', 'team'];
const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVITY_AUDIT_ACTIONS = [
  'board.create', 'board.update', 'board.delete', 'board.restore', 'board.version.restore', 'ai.run.accept', 'asset.upload',
];
const RANK_ROLE = { 4: 'owner', 3: 'editor', 2: 'commenter', 1: 'viewer' };

// A share role the CASE does not know ranks 0, which grants nothing.
const shareRank = (column) => `CASE ${column} WHEN 'editor' THEN 3 WHEN 'commenter' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END`;

export const MIGRATIONS = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')),
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE team_members (
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    PRIMARY KEY (team_id, user_id)
  );
  CREATE INDEX team_members_user ON team_members(user_id);
  CREATE TABLE invites (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    expires_at INTEGER NOT NULL,
    max_uses INTEGER,
    uses INTEGER NOT NULL DEFAULT 0,
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX invites_team ON invites(team_id);
  CREATE TABLE login_tokens (
    token_hash TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    invite_id TEXT REFERENCES invites(id) ON DELETE SET NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE boards (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE INDEX boards_owner ON boards(owner_id);
  CREATE INDEX boards_team ON boards(team_id);
  CREATE TABLE board_shares (
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'team')),
    principal_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
    PRIMARY KEY (board_id, principal_type, principal_id)
  );
  CREATE INDEX board_shares_principal ON board_shares(principal_type, principal_id);
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    actor_id TEXT,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '{}'
  );
  `,
  // SQLite cannot alter a CHECK constraint, so board_shares is rebuilt to allow the 'commenter' role.
  `
  CREATE TABLE board_shares_new (
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'team')),
    principal_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('editor', 'commenter', 'viewer')),
    PRIMARY KEY (board_id, principal_type, principal_id)
  );
  INSERT INTO board_shares_new (board_id, principal_type, principal_id, role)
    SELECT board_id, principal_type, principal_id, role FROM board_shares;
  DROP TABLE board_shares;
  ALTER TABLE board_shares_new RENAME TO board_shares;
  CREATE INDEX board_shares_principal ON board_shares(principal_type, principal_id);
  `,
  // Instance settings that outlive a restart (hosted workspaces keep their limits here, docs/cloud.md).
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // Personal access tokens for the MCP endpoint (docs/mcp.md).
  TOKENS_MIGRATION,
  // The browser a session signed in from, so admins can tell one person's sessions apart. NULL for older sessions.
  `
  ALTER TABLE sessions ADD COLUMN user_agent TEXT;
  `,
  // Custom templates shared through the server (docs/custom-templates.md).
  TEMPLATES_MIGRATION,
  // Encrypted provider API keys for the AI features, one for the workspace and one per person (docs/ai.md).
  AI_KEYS_MIGRATION,
  // Which board may read which image file (docs/images.md).
  ASSETS_MIGRATION,
  // Per-person preferences (docs/chat.md, Mentions): one row per person and key. The `settings` table is instance-wide.
  `
  CREATE TABLE user_prefs (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
  );
  `,
  // The model of an AI key whose provider has no fixed list of them (docs/ai.md, OpenAI-compatible).
  AI_KEYS_MODEL_MIGRATION,
  // One-board guest entry codes and their bounded guest sessions (TAB-144).
  `
  CREATE TABLE join_codes (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    code_hash TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('commenter', 'editor')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    max_uses INTEGER NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0,
    revoked_at INTEGER
  );
  CREATE INDEX join_codes_board ON join_codes(board_id, created_at DESC);
  CREATE TABLE guest_sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    join_code_id TEXT NOT NULL REFERENCES join_codes(id) ON DELETE CASCADE,
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX guest_sessions_expiry ON guest_sessions(expires_at);
  `,
  // Tracker core (docs/tracker-architecture.md, slice 1). Additive so schema 11 remains a valid reader.
  `
  ALTER TABLE access_tokens ADD COLUMN tracker TEXT;

  CREATE TABLE trackers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE ticket_workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE ticket_states (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES ticket_workflows(id) ON DELETE RESTRICT,
    state_key TEXT NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('backlog', 'unstarted', 'started', 'completed', 'canceled')),
    position INTEGER NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    archived_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (workflow_id, state_key)
  );
  CREATE TABLE tickets (
    id TEXT PRIMARY KEY,
    prefix TEXT NOT NULL,
    number INTEGER NOT NULL,
    key TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    state_id TEXT NOT NULL REFERENCES ticket_states(id) ON DELETE RESTRICT,
    tracker_id TEXT NOT NULL REFERENCES trackers(id) ON DELETE RESTRICT,
    priority INTEGER NOT NULL DEFAULT 0,
    estimate REAL,
    parent_ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
    assignee_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    project_id TEXT,
    milestone_id TEXT,
    due_date TEXT,
    archived_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    created_by_type TEXT NOT NULL,
    created_by_id TEXT,
    updated_seq INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'app',
    UNIQUE (prefix, number)
  );
  CREATE TABLE ticket_counters (
    scope TEXT NOT NULL,
    prefix TEXT NOT NULL,
    next_number INTEGER NOT NULL CHECK (next_number > 0),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope, prefix)
  );
  CREATE TABLE ticket_field_versions (
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    field TEXT NOT NULL,
    event_seq INTEGER NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    PRIMARY KEY (ticket_id, field)
  );
  CREATE TABLE labels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT,
    created_at INTEGER NOT NULL,
    created_by TEXT,
    archived_at INTEGER
  );
  CREATE UNIQUE INDEX labels_active_name ON labels(name COLLATE NOCASE) WHERE archived_at IS NULL;
  CREATE TABLE ticket_labels (
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (ticket_id, label_id)
  );
  CREATE TABLE ticket_comments (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
    parent_id TEXT REFERENCES ticket_comments(id) ON DELETE SET NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    author_snapshot TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    edited_at INTEGER,
    deleted_at INTEGER,
    client_id TEXT,
    UNIQUE (actor_type, actor_id, client_id)
  );
  CREATE UNIQUE INDEX ticket_comments_client_idempotency ON ticket_comments(actor_type, COALESCE(actor_id, ''), client_id)
    WHERE client_id IS NOT NULL;
  CREATE TABLE ticket_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
    event_type TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    source TEXT NOT NULL,
    idempotency_key TEXT,
    created_at INTEGER NOT NULL,
    before_json TEXT,
    after_json TEXT,
    details_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE (source, actor_type, actor_id, idempotency_key)
  );
  CREATE TABLE ticket_aliases (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    external_id TEXT NOT NULL,
    display_key TEXT,
    url TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (provider, external_id)
  );
  CREATE UNIQUE INDEX ticket_events_idempotency ON ticket_events(source, actor_type, COALESCE(actor_id, ''), idempotency_key)
    WHERE idempotency_key IS NOT NULL;
  CREATE TABLE ticket_subscriptions (
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (ticket_id, user_id)
  );
  CREATE VIRTUAL TABLE ticket_search USING fts5(
    ticket_id UNINDEXED, title, description, comments, identifiers, aliases,
    tokenize = 'unicode61 remove_diacritics 2'
  );

  CREATE INDEX tickets_state_updated ON tickets(state_id, updated_at DESC);
  CREATE INDEX tickets_assignee_state_updated ON tickets(assignee_user_id, state_id, updated_at DESC);
  CREATE INDEX tickets_project_milestone_state ON tickets(project_id, milestone_id, state_id);
  CREATE INDEX tickets_active_due ON tickets(due_date) WHERE archived_at IS NULL;
  CREATE INDEX ticket_events_ticket_id ON ticket_events(ticket_id, id DESC);
  CREATE INDEX ticket_events_id ON ticket_events(id DESC);
  CREATE INDEX ticket_comments_ticket_time ON ticket_comments(ticket_id, created_at, id);
  CREATE INDEX ticket_comments_parent_time ON ticket_comments(parent_id, created_at);
  CREATE INDEX ticket_aliases_external ON ticket_aliases(provider, external_id);
  CREATE INDEX ticket_subscriptions_user ON ticket_subscriptions(user_id, ticket_id);

  INSERT INTO trackers (id, name, prefix, created_at) VALUES ('trk_default', 'Tabula', 'TAB', 0);
  INSERT INTO ticket_workflows (id, name, is_default, version, created_at, updated_at)
    VALUES ('wf_default', 'Default', 1, 1, 0, 0);
  INSERT INTO ticket_states (id, workflow_id, state_key, name, category, position, is_default, created_at) VALUES
    ('st_todo', 'wf_default', 'todo', 'To do', 'unstarted', 0, 1, 0),
    ('st_in_progress', 'wf_default', 'in_progress', 'In progress', 'started', 1, 0, 0),
    ('st_in_review', 'wf_default', 'in_review', 'In review', 'started', 2, 0, 0),
    ('st_done', 'wf_default', 'done', 'Done', 'completed', 3, 0, 0),
    ('st_cancelled', 'wf_default', 'cancelled', 'Cancelled', 'canceled', 4, 0, 0);
  INSERT INTO ticket_counters (scope, prefix, next_number, updated_at) VALUES ('trk_default', 'TAB', 1, 0);
  `,
  // Tracker projects, relations and saved views. Additive so the slice 1 reader can keep using its tables.
  `
  -- minReader: 11
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL,
    owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER
  );
  CREATE TABLE milestones (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    start_at INTEGER,
    due_at INTEGER,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER
  );
  CREATE TABLE ticket_relations (
    id TEXT PRIMARY KEY,
    ticket_id TEXT REFERENCES tickets(id) ON DELETE RESTRICT,
    related_ticket_id TEXT REFERENCES tickets(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('blocks', 'blocked_by', 'relates_to', 'duplicates', 'duplicated_by', 'cloned_from')),
    created_at INTEGER NOT NULL,
    created_by_type TEXT NOT NULL,
    created_by_id TEXT,
    CHECK (ticket_id <> related_ticket_id)
  );
  CREATE TABLE saved_views (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    query_json TEXT NOT NULL,
    is_shared INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX projects_active_name ON projects(name COLLATE NOCASE) WHERE archived_at IS NULL;
  CREATE INDEX projects_state_updated ON projects(state, updated_at DESC);
  CREATE INDEX milestones_project_due ON milestones(project_id, due_at, updated_at DESC);
  CREATE INDEX milestones_active_project ON milestones(project_id, name COLLATE NOCASE) WHERE archived_at IS NULL;
  CREATE UNIQUE INDEX ticket_relations_normalized ON ticket_relations(min(ticket_id, related_ticket_id), max(ticket_id, related_ticket_id));
  CREATE INDEX ticket_relations_related ON ticket_relations(related_ticket_id, ticket_id);
  CREATE INDEX saved_views_owner_updated ON saved_views(owner_user_id, updated_at DESC);
  CREATE INDEX saved_views_shared_updated ON saved_views(updated_at DESC) WHERE is_shared = 1;
  `,
  // Tracker slice 6: the notifications table is the in-app inbox and the email outbox in one (docs/tracker-architecture.md
  // section 6, Notification fan-out). Purely additive (new table and indexes, foreign keys only CASCADE), so the build before
  // it still reads the file and the annotation below keeps `minReader` at 11, which keeps a rollback to v5.0.1 possible. One row per person per
  // event: `dedupe_key` is `ev:<event id>` for event notices and `due:<ticket id>:<due date>` for due-soon notices.
  // `suppressed_at` marks a notice whose recipient lost access.
  `
  -- minReader: 11
  CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    event_id INTEGER REFERENCES ticket_events(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('assigned', 'mentioned', 'commented', 'status_changed', 'due_soon', 'relation_changed', 'integration_activity')),
    dedupe_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read_at INTEGER,
    emailed_at INTEGER,
    email_attempts INTEGER NOT NULL DEFAULT 0,
    next_email_at INTEGER,
    last_email_error_code TEXT,
    suppressed_at INTEGER
  );
  CREATE UNIQUE INDEX notifications_user_dedupe ON notifications(user_id, dedupe_key);
  CREATE INDEX notifications_user_inbox ON notifications(user_id, read_at, created_at DESC);
  CREATE INDEX notifications_ticket ON notifications(ticket_id);
  CREATE INDEX notifications_email_due ON notifications(next_email_at)
    WHERE next_email_at IS NOT NULL AND emailed_at IS NULL AND suppressed_at IS NULL;
  `,
];

const newId = () => crypto.randomBytes(16).toString('base64url');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const validToken = (token) => typeof token === 'string' && token.length > 0 && token.length <= 256;
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const parseDetail = (json) => {
  try {
    const value = JSON.parse(json);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
};

const toUser = (r) => ({
  id: r.id,
  email: r.email,
  name: r.name,
  role: r.role,
  disabled: Boolean(r.disabled),
  createdAt: r.created_at,
});
const toTeam = (r) => ({ id: r.id, name: r.name, archived: Boolean(r.archived), createdAt: r.created_at });
const toBoard = (r) => ({
  id: r.id,
  title: r.title,
  ownerId: r.owner_id,
  teamId: r.team_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
});
const toInvite = (r) => ({
  id: r.id,
  teamId: r.team_id,
  role: r.role,
  createdBy: r.created_by,
  expiresAt: r.expires_at,
  maxUses: r.max_uses,
  uses: r.uses,
  revoked: Boolean(r.revoked),
  createdAt: r.created_at,
});
const inviteActive = (invite, now) =>
  !invite.revoked && invite.expiresAt > now && (invite.maxUses == null || invite.uses < invite.maxUses);

/** Probe the exact FTS5 tokenizer migration 12 needs. Returns false when this SQLite build lacks it. */
export function ftsAvailable(db) {
  const probe = '__tabula_tracker_fts_probe';
  try {
    db.exec(`CREATE VIRTUAL TABLE temp.${probe} USING fts5(value, tokenize = 'unicode61 remove_diacritics 2')`);
    db.exec(`DROP TABLE temp.${probe}`);
    return true;
  } catch {
    try { db.exec(`DROP TABLE IF EXISTS temp.${probe}`); } catch { /* best-effort cleanup */ }
    return false;
  }
}

/** @param {string} file @param {{ snapshotBarrier?: any, ftsProbe?: (db: any) => boolean }} [options] */
export function openDirectory(file, { ftsProbe = ftsAvailable, snapshotBarrier = null } = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000');
    // Leave a valid schema 11 file if this SQLite build cannot provide the required FTS5 tokenizer.
    if (readSchemaState(db).version < 12) {
      migrate(db, MIGRATIONS.slice(0, 11), 'directory');
      if (!ftsProbe(db)) throw new Error('directory migration 12 requires SQLite FTS5 with unicode61 remove_diacritics 2');
    }
    migrate(db, MIGRATIONS, 'directory');
  } catch (err) {
    db.close();
    throw err;
  }

  /** @type {Map<string, import('node:sqlite').StatementSync>} */
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = db.prepare(sql)));
    return s;
  };
  const get = (sql, ...params) => stmt(sql).get(...params);
  const all = (sql, ...params) => stmt(sql).all(...params);
  const run = (sql, ...params) => {
    if (snapshotBarrier?.active && !snapshotBarrier.writesAllowed) {
      // Most directory methods are synchronous. Queue their low-level writes so reads keep working and a barrier never
      // makes a caller fail or silently discard a statement. API writer handlers hold an async lease, so multi-step
      // operations arrive here only after the barrier has opened.
      snapshotBarrier.deferWrite(() => run(sql, ...params));
      return 0;
    }
    return Number(stmt(sql).run(...params).changes);
  };

  let closed = false;
  let depth = 0;
  function transaction(fn) {
    if (snapshotBarrier?.active && !snapshotBarrier.writesAllowed) {
      return snapshotBarrier.deferWrite(() => transaction(fn));
    }
    const nested = depth > 0;
    const savepoint = `sp${depth}`;
    db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    depth++;
    try {
      const result = fn();
      db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (err) {
      if (nested) db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      else db.exec('ROLLBACK');
      throw err;
    } finally {
      depth--;
    }
  }

  // users

  function getUser(id) {
    const row = typeof id === 'string' ? get('SELECT * FROM users WHERE id = ?', id) : undefined;
    return row ? toUser(row) : null;
  }

  function getUserByEmail(email) {
    const e = normaliseEmail(email);
    const row = e ? get('SELECT * FROM users WHERE email = ?', e) : undefined;
    return row ? toUser(row) : null;
  }

  function createUser(fields) {
    const { email, name, role } = fields;
    const e = normaliseEmail(email);
    if (!e) throw new Error('invalid email');
    if (!USER_ROLES.includes(role)) throw new Error('invalid role');
    const id = newId();
    run(
      'INSERT INTO users (id, email, name, role, disabled, created_at) VALUES (?, ?, ?, ?, 0, ?)',
      id,
      e,
      text(name, 100) || e.split('@')[0],
      role,
      Date.now(),
    );
    return getUser(id);
  }

  const listUsers = () => all('SELECT * FROM users ORDER BY created_at, email').map(toUser);

  // lastSeenAt is the newest sessions.last_seen of any session (revoked ones too); null for someone who never signed in.
  function listMembersAdmin(now = Date.now()) {
    return all(
      `SELECT u.*,
              (SELECT MAX(s.last_seen) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at,
              (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked = 0 AND s.expires_at > ?) AS active_sessions,
              (SELECT COUNT(*) FROM boards b WHERE b.owner_id = u.id AND b.deleted_at IS NULL) AS board_count
         FROM users u ORDER BY u.created_at, u.email`,
      now,
    ).map((r) => ({
      ...toUser(r),
      lastSeenAt: r.last_seen_at ?? null,
      activeSessions: Number(r.active_sessions),
      boardCount: Number(r.board_count),
    }));
  }

  function adminStats(now = Date.now()) {
    const byRole = { owner: 0, admin: 0, member: 0, guest: 0 };
    let active = 0;
    let disabled = 0;
    for (const r of all('SELECT role, disabled, COUNT(*) AS n FROM users GROUP BY role, disabled')) {
      const n = Number(r.n);
      byRole[r.role] += n;
      if (r.disabled) disabled += n;
      else active += n;
    }
    const teams = get('SELECT COUNT(*) AS total, COALESCE(SUM(archived <> 0), 0) AS archived FROM teams');
    const boards = get('SELECT COUNT(*) AS total, COALESCE(SUM(deleted_at IS NOT NULL), 0) AS deleted FROM boards');
    return {
      members: { total: active + disabled, active, disabled, byRole },
      teams: { total: Number(teams.total), archived: Number(teams.archived) },
      boards: { total: Number(boards.total), deleted: Number(boards.deleted) },
      sessions: { active: Number(get('SELECT COUNT(*) AS n FROM sessions WHERE revoked = 0 AND expires_at > ?', now).n) },
      signIns7d: Number(get("SELECT COUNT(*) AS n FROM audit WHERE action = 'auth.login' AND ts >= ?", now - 7 * DAY_MS).n),
    };
  }

  // Seats are the people who can do things (owner, admin, member); guests are free. Disabled people count for neither.
  function seatUsage() {
    const usage = { seats: 0, guests: 0, members: 0 };
    for (const r of all('SELECT role, disabled, COUNT(*) AS n FROM users GROUP BY role, disabled')) {
      const n = Number(r.n);
      usage.members += n;
      if (r.disabled) continue;
      if (r.role === 'guest') usage.guests += n;
      else usage.seats += n;
    }
    return usage;
  }

  /** Counts only the fields returned by GET /api/internal/stats; never selects names or board details. */
  function internalStatsCounts({ now = Date.now(), aiRunActions = [] } = {}) {
    const actions = [...new Set(aiRunActions)].filter((action) => typeof action === 'string');
    const aiRunPredicate = actions.length ? `action IN (${actions.map(() => '?').join(', ')})` : '0';
    const activityAuditPredicate = `action IN (${ACTIVITY_AUDIT_ACTIONS.map(() => '?').join(', ')})`;
    const row = get(
      `SELECT
         (SELECT COUNT(*) FROM boards WHERE deleted_at IS NULL) AS boards,
         (SELECT COUNT(*) FROM users WHERE role IN ('owner', 'admin', 'member') AND disabled = 0) AS active_members,
         (SELECT COUNT(*) FROM users WHERE disabled <> 0) AS disabled_members,
         (SELECT COUNT(*) FROM users WHERE role = 'guest' AND disabled = 0) AS guests,
         (SELECT COUNT(DISTINCT user_id) FROM (
            SELECT user_id FROM sessions WHERE created_at >= ? OR last_seen >= ?
            UNION
            SELECT actor_id AS user_id FROM audit
             WHERE ts >= ? AND actor_id IS NOT NULL
               AND ${activityAuditPredicate}
          ) AS recent_people) AS people_7d,
         (SELECT COUNT(DISTINCT user_id) FROM (
            SELECT user_id FROM sessions WHERE created_at >= ? OR last_seen >= ?
            UNION
            SELECT actor_id AS user_id FROM audit
             WHERE ts >= ? AND actor_id IS NOT NULL
               AND ${activityAuditPredicate}
          ) AS recent_people) AS people_30d,
         (SELECT COUNT(*) FROM audit WHERE ts >= ? AND ${aiRunPredicate}) AS ai_runs_30d`,
      now - 7 * DAY_MS, now - 7 * DAY_MS, now - 7 * DAY_MS,
      ...ACTIVITY_AUDIT_ACTIONS,
      now - 30 * DAY_MS, now - 30 * DAY_MS, now - 30 * DAY_MS,
      ...ACTIVITY_AUDIT_ACTIONS,
      now - 30 * DAY_MS, ...actions,
    );
    return {
      boards: Number(row.boards),
      members: { active: Number(row.active_members), disabled: Number(row.disabled_members) },
      guests: Number(row.guests),
      activePeople: { last7d: Number(row.people_7d), last30d: Number(row.people_30d) },
      aiRuns: { last30d: Number(row.ai_runs_30d) },
    };
  }

  const countOwners = () => Number(get("SELECT COUNT(*) AS n FROM users WHERE role = 'owner'").n);

  // Who a notice to the workspace owner goes to: owners who can still sign in.
  const listOwnerEmails = () =>
    all("SELECT email FROM users WHERE role = 'owner' AND disabled = 0 ORDER BY created_at, email").map((r) => r.email);

  function updateUser(id, patch) {
    if (!getUser(id)) throw new Error('user not found');
    const sets = [];
    const params = [];
    if (patch.name !== undefined) {
      const name = text(patch.name, 100);
      if (!name) throw new Error('invalid name');
      sets.push('name = ?');
      params.push(name);
    }
    if (patch.role !== undefined) {
      if (!USER_ROLES.includes(patch.role)) throw new Error('invalid role');
      sets.push('role = ?');
      params.push(patch.role);
    }
    if (patch.disabled !== undefined) {
      sets.push('disabled = ?');
      params.push(patch.disabled ? 1 : 0);
    }
    transaction(() => {
      if (sets.length) run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
      if (patch.disabled) revokeUserSessions(id);
    });
    return getUser(id);
  }

  function removeUser(id) {
    const user = getUser(id);
    if (!user) return;
    transaction(() => {
      run('DELETE FROM login_tokens WHERE email = ?', user.email);
      run("DELETE FROM board_shares WHERE principal_type = 'user' AND principal_id = ?", id);
      run('DELETE FROM users WHERE id = ?', id);
    });
  }

  // login tokens

  function createLoginToken(fields) {
    const { email, inviteId, ttlMs, now = Date.now() } = fields;
    const e = normaliseEmail(email);
    if (!e) throw new Error('invalid email');
    if (!(ttlMs > 0)) throw new Error('invalid ttl');
    const token = newToken();
    run('DELETE FROM login_tokens WHERE expires_at < ?', now - DAY_MS);
    run(
      'INSERT INTO login_tokens (token_hash, email, invite_id, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)',
      hashToken(token),
      e,
      inviteId ?? null,
      now + ttlMs,
      now,
    );
    return token;
  }

  function consumeLoginToken(token, now = Date.now()) {
    if (!validToken(token)) return null;
    const hash = hashToken(token);
    return transaction(() => {
      const row = get('SELECT email, invite_id, expires_at, used_at FROM login_tokens WHERE token_hash = ?', hash);
      if (!row || row.used_at != null || row.expires_at <= now) return null;
      const changed = run('UPDATE login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL', now, hash);
      return changed === 1 ? { email: row.email, inviteId: row.invite_id } : null;
    });
  }

  // sessions

  /** @param {string} userId @param {{ ttlMs: number, now?: number, userAgent?: string | null }} opts */
  function createSession(userId, { ttlMs, now = Date.now(), userAgent = null }) {
    if (!(ttlMs > 0)) throw new Error('invalid ttl');
    const id = newId();
    const token = newToken();
    run('DELETE FROM sessions WHERE expires_at < ?', now - DAY_MS);
    run(
      'INSERT INTO sessions (id, token_hash, user_id, created_at, last_seen, expires_at, revoked, user_agent) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
      id,
      hashToken(token),
      userId,
      now,
      now,
      now + ttlMs,
      text(userAgent, 400) || null,
    );
    return { id, token, expiresAt: now + ttlMs };
  }

  // expires_at - last_seen is the session lifetime: last_seen is only written when the expiry slides
  function getSession(token, now = Date.now()) {
    if (!validToken(token)) return null;
    const row = get(
      `SELECT s.id AS session_id, s.last_seen, s.expires_at AS session_expires,
              u.id, u.email, u.name, u.role, u.disabled, u.created_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.revoked = 0`,
      hashToken(token),
    );
    if (!row || row.session_expires <= now || row.disabled) return null;
    let expiresAt = row.session_expires;
    let extended = false;
    const lifetime = row.session_expires - row.last_seen;
    if (lifetime > 0 && expiresAt - now < lifetime / 2) {
      expiresAt = now + lifetime;
      run('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id = ?', now, expiresAt, row.session_id);
      extended = true;
    }
    return { id: row.session_id, user: toUser(row), expiresAt, extended };
  }

  function revokeSession(id) {
    if (typeof id === 'string') run('UPDATE sessions SET revoked = 1 WHERE id = ?', id);
  }

  function revokeUserSessions(userId) {
    return run('UPDATE sessions SET revoked = 1 WHERE user_id = ? AND revoked = 0', userId);
  }

  // Join codes are one-use-to-create-guest-session credentials; their secret and guest cookies are stored only as hashes.
  function createJoinCode({ boardId, createdBy, codeHash, role, createdAt, expiresAt, maxUses }) {
    const id = newId();
    run('INSERT INTO join_codes (id, board_id, created_by, code_hash, role, created_at, expires_at, max_uses, uses) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)',
      id, boardId, createdBy, codeHash, role, createdAt, expiresAt, maxUses);
    return getJoinCode(id);
  }

  const toJoinCode = (r) => ({
    id: r.id, boardId: r.board_id, createdBy: r.created_by, codeHash: r.code_hash, role: r.role,
    createdAt: r.created_at, expiresAt: r.expires_at, maxUses: r.max_uses, uses: r.uses, revokedAt: r.revoked_at,
  });

  function getJoinCode(id) {
    const row = typeof id === 'string' ? get('SELECT * FROM join_codes WHERE id = ?', id) : undefined;
    return row ? toJoinCode(row) : null;
  }

  function findJoinCodeByHash(codeHash) {
    const row = typeof codeHash === 'string' ? get('SELECT * FROM join_codes WHERE code_hash = ?', codeHash) : undefined;
    return row ? toJoinCode(row) : null;
  }

  function listJoinCodes(boardId) {
    return all('SELECT * FROM join_codes WHERE board_id = ? ORDER BY created_at DESC, id', boardId).map(toJoinCode);
  }

  function revokeJoinCode(id, now = Date.now()) {
    const row = getJoinCode(id);
    if (!row) return null;
    if (row.revokedAt === null) run('UPDATE join_codes SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', now, id);
    return getJoinCode(id);
  }

  /** Atomically spends one use and creates a guest cookie whose expiry is the code's expiry. */
  function createGuestSession(joinCodeId, { tokenHash, name, now = Date.now() }) {
    const row = getJoinCode(joinCodeId);
    if (!row || row.revokedAt !== null || row.expiresAt <= now || row.uses >= row.maxUses) return null;
    const changed = run('UPDATE join_codes SET uses = uses + 1 WHERE id = ? AND revoked_at IS NULL AND expires_at > ? AND uses < max_uses', joinCodeId, now);
    if (changed !== 1) return null;
    const id = newId();
    run('DELETE FROM guest_sessions WHERE expires_at <= ?', now - DAY_MS);
    run('INSERT INTO guest_sessions (id, token_hash, join_code_id, board_id, name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, tokenHash, joinCodeId, row.boardId, name, now, row.expiresAt);
    return { id, boardId: row.boardId, name, role: row.role, expiresAt: row.expiresAt };
  }

  function getGuestSession(tokenHash, now = Date.now()) {
    if (typeof tokenHash !== 'string') return null;
    const row = get(
      `SELECT s.id, s.board_id, s.name, s.expires_at, c.role
         FROM guest_sessions s JOIN join_codes c ON c.id = s.join_code_id
         JOIN boards b ON b.id = s.board_id
        WHERE s.token_hash = ? AND s.expires_at > ? AND c.revoked_at IS NULL AND c.expires_at > ? AND b.deleted_at IS NULL`,
      tokenHash, now, now,
    );
    return row ? { id: row.id, boardId: row.board_id, name: row.name, role: row.role, expiresAt: row.expires_at } : null;
  }

  /**
   * Every account and guest session ends, every join code is revoked and every sign-in link stops working
   * (server/volume.mjs, adopting a volume: credentials issued on the source volume must not work on the copy).
   */
  function revokeAllSessions(now = Date.now()) {
    return transaction(() => ({
      sessions: run('UPDATE sessions SET revoked = 1 WHERE revoked = 0'),
      loginTokens: run('DELETE FROM login_tokens'),
      guestSessions: run('DELETE FROM guest_sessions'),
      joinCodes: run('UPDATE join_codes SET revoked_at = ? WHERE revoked_at IS NULL', now),
    }));
  }

  /** Every MCP access token and invite link stops working: what a volume adopted from another workspace carries over (TAB-200). */
  function revokeAllGrants(now = Date.now()) {
    return transaction(() => ({
      accessTokens: run('UPDATE access_tokens SET revoked_at = ? WHERE revoked_at IS NULL', now),
      invites: run('UPDATE invites SET revoked = 1 WHERE revoked = 0'),
    }));
  }

  // Sessions for the admin console. Explicit columns: the token hash never leaves this module.
  const toActiveSession = (r) => ({
    id: r.id,
    userId: r.user_id,
    userName: r.name,
    email: r.email,
    createdAt: r.created_at,
    lastSeen: r.last_seen,
    expiresAt: r.expires_at,
    userAgent: r.user_agent ?? null,
  });
  const ACTIVE_SESSION_COLUMNS = `s.id, s.user_id, s.created_at, s.last_seen, s.expires_at, s.user_agent, u.name, u.email
    FROM sessions s JOIN users u ON u.id = s.user_id`;

  function listActiveSessions(now = Date.now()) {
    return all(
      `SELECT ${ACTIVE_SESSION_COLUMNS} WHERE s.revoked = 0 AND s.expires_at > ?
        ORDER BY s.last_seen DESC, s.created_at DESC, s.id`,
      now,
    ).map(toActiveSession);
  }

  function getActiveSession(id, now = Date.now()) {
    const row =
      typeof id === 'string'
        ? get(`SELECT ${ACTIVE_SESSION_COLUMNS} WHERE s.id = ? AND s.revoked = 0 AND s.expires_at > ?`, id, now)
        : undefined;
    return row ? toActiveSession(row) : null;
  }

  // teams

  function getTeam(id) {
    const row = typeof id === 'string' ? get('SELECT * FROM teams WHERE id = ?', id) : undefined;
    return row ? toTeam(row) : null;
  }

  function createTeam({ name, creatorId }) {
    const clean = text(name, 100);
    if (!clean) throw new Error('invalid name');
    const id = newId();
    transaction(() => {
      run('INSERT INTO teams (id, name, archived, created_at) VALUES (?, ?, 0, ?)', id, clean, Date.now());
      run("INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'admin')", id, creatorId);
    });
    return getTeam(id);
  }

  const withRole = (r) => ({ ...toTeam(r), role: r.role ?? null, memberCount: Number(r.member_count) });
  const TEAM_COLUMNS = `t.id, t.name, t.archived, t.created_at, tm.role,
    (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id) AS member_count`;

  function listTeamsFor(userId) {
    return all(
      `SELECT ${TEAM_COLUMNS} FROM teams t JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = ?
        ORDER BY t.name COLLATE NOCASE, t.created_at`,
      userId,
    ).map(withRole);
  }

  function listAllTeams(forUserId) {
    return all(
      `SELECT ${TEAM_COLUMNS} FROM teams t LEFT JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = ?
        ORDER BY t.name COLLATE NOCASE, t.created_at`,
      forUserId ?? null,
    ).map(withRole);
  }

  function updateTeam(id, patch) {
    if (!getTeam(id)) throw new Error('team not found');
    const sets = [];
    const params = [];
    if (patch.name !== undefined) {
      const name = text(patch.name, 100);
      if (!name) throw new Error('invalid name');
      sets.push('name = ?');
      params.push(name);
    }
    if (patch.archived !== undefined) {
      sets.push('archived = ?');
      params.push(patch.archived ? 1 : 0);
    }
    if (sets.length) run(`UPDATE teams SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
    return getTeam(id);
  }

  function addTeamMember(teamId, userId, role) {
    if (!TEAM_ROLES.includes(role)) throw new Error('invalid role');
    run(
      'INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT (team_id, user_id) DO UPDATE SET role = excluded.role',
      teamId,
      userId,
      role,
    );
  }

  function removeTeamMember(teamId, userId) {
    run('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', teamId, userId);
  }

  function setTeamRole(teamId, userId, role) {
    if (!TEAM_ROLES.includes(role)) throw new Error('invalid role');
    if (run('UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?', role, teamId, userId) === 0) {
      throw new Error('not a team member');
    }
  }

  function getTeamRole(teamId, userId) {
    if (typeof teamId !== 'string' || typeof userId !== 'string') return null;
    return get('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?', teamId, userId)?.role ?? null;
  }

  function listTeamMembers(teamId) {
    return all(
      `SELECT u.id, u.name, u.email, tm.role FROM team_members tm JOIN users u ON u.id = tm.user_id
        WHERE tm.team_id = ? ORDER BY u.name COLLATE NOCASE, u.email`,
      teamId,
    ).map((r) => ({ userId: r.id, name: r.name, email: r.email, role: r.role }));
  }

  const countTeamAdmins = (teamId) =>
    Number(get("SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND role = 'admin'", teamId).n);

  // invites

  function createInvite(fields) {
    const { teamId, role, createdBy, ttlMs, maxUses, now = Date.now() } = fields;
    if (!TEAM_ROLES.includes(role)) throw new Error('invalid role');
    if (!(ttlMs > 0)) throw new Error('invalid ttl');
    if (maxUses != null && !(Number.isInteger(maxUses) && maxUses > 0)) throw new Error('invalid maxUses');
    const id = newId();
    const token = newToken();
    run(
      `INSERT INTO invites (id, token_hash, team_id, role, created_by, expires_at, max_uses, uses, revoked, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
      id,
      hashToken(token),
      teamId,
      role,
      createdBy ?? null,
      now + ttlMs,
      maxUses ?? null,
      now,
    );
    return { id, token, expiresAt: now + ttlMs };
  }

  function findInvite(token, now = Date.now()) {
    if (!validToken(token)) return null;
    const row = get('SELECT * FROM invites WHERE token_hash = ?', hashToken(token));
    const invite = row ? toInvite(row) : null;
    return invite && inviteActive(invite, now) ? invite : null;
  }

  function findInviteById(id, now = Date.now()) {
    if (typeof id !== 'string') return null;
    const row = get('SELECT * FROM invites WHERE id = ?', id);
    const invite = row ? toInvite(row) : null;
    return invite && inviteActive(invite, now) ? invite : null;
  }

  function recordInviteUse(id) {
    run('UPDATE invites SET uses = uses + 1 WHERE id = ? AND (max_uses IS NULL OR uses < max_uses)', id);
  }

  function listInvites(teamId, now = Date.now()) {
    return all('SELECT * FROM invites WHERE team_id = ? ORDER BY created_at DESC, id', teamId)
      .map(toInvite)
      .filter((invite) => inviteActive(invite, now));
  }

  function revokeInvite(id) {
    run('UPDATE invites SET revoked = 1 WHERE id = ?', id);
  }

  // boards

  function getBoard(id) {
    const row = typeof id === 'string' ? get('SELECT * FROM boards WHERE id = ?', id) : undefined;
    return row ? toBoard(row) : null;
  }
  const boardTitle = (title) => text(title, 200) || 'Untitled board';

  function createBoard(fields) {
    const { id, title, ownerId, teamId } = fields;
    if (typeof id !== 'string' || !BOARD_ID_RE.test(id)) throw new Error('invalid board id');
    if (typeof ownerId !== 'string') throw new Error('board needs an owner');
    const now = Date.now();
    run(
      'INSERT INTO boards (id, title, owner_id, team_id, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
      id,
      boardTitle(title),
      ownerId,
      teamId ?? null,
      now,
      now,
    );
    return getBoard(id);
  }

  function updateBoard(id, patch) {
    if (!getBoard(id)) throw new Error('board not found');
    const sets = ['updated_at = ?'];
    const params = [Date.now()];
    if (patch.title !== undefined) {
      sets.push('title = ?');
      params.push(boardTitle(patch.title));
    }
    if (patch.teamId !== undefined) {
      sets.push('team_id = ?');
      params.push(patch.teamId);
    }
    run(`UPDATE boards SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
    return getBoard(id);
  }

  function deleteBoard(id) {
    run('UPDATE boards SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', Date.now(), id);
  }

  function restoreBoard(id) {
    return run('UPDATE boards SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL', id) === 1;
  }

  // The owner can be gone (boards.owner_id is set to NULL when a user is removed), hence the nullable owner fields.
  const toAdminBoard = (r) => ({
    id: r.id,
    title: r.title,
    ownerId: r.owner_id,
    ownerName: r.owner_name ?? null,
    teamId: r.team_id,
    teamName: r.team_name ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    shareCount: Number(r.share_count),
  });
  const ADMIN_BOARD_SELECT = `SELECT b.id, b.title, b.owner_id, u.name AS owner_name, b.team_id, t.name AS team_name,
      b.created_at, b.updated_at, b.deleted_at,
      (SELECT COUNT(*) FROM board_shares s WHERE s.board_id = b.id) AS share_count
    FROM boards b LEFT JOIN users u ON u.id = b.owner_id LEFT JOIN teams t ON t.id = b.team_id`;

  function listBoardsAdmin({ includeDeleted = false } = {}) {
    return all(`${ADMIN_BOARD_SELECT} WHERE ? = 1 OR b.deleted_at IS NULL ORDER BY b.updated_at DESC, b.id`, includeDeleted ? 1 : 0).map(toAdminBoard);
  }

  function getBoardAdmin(id) {
    const row = typeof id === 'string' ? get(`${ADMIN_BOARD_SELECT} WHERE b.id = ?`, id) : undefined;
    return row ? toAdminBoard(row) : null;
  }

  // the title comes straight from a client-controlled document, so it is bounded like every other title
  function touchBoard(id, fields) {
    const title = fields?.title;
    if (typeof id !== 'string') return;
    if (title === undefined) run('UPDATE boards SET updated_at = ? WHERE id = ?', Date.now(), id);
    else run('UPDATE boards SET updated_at = ?, title = ? WHERE id = ?', Date.now(), boardTitle(title), id);
  }

  // Guests only ever see boards shared with them, so team membership grants them nothing.
  function boardRole(boardId, userId) {
    const user = getUser(userId);
    if (!user || user.disabled) return null;
    const board = getBoard(boardId);
    if (!board) return null;
    if (user.role === 'owner' || user.role === 'admin') return 'owner';
    if (board.deletedAt != null) return null;
    if (board.ownerId === user.id) return 'owner';
    let rank = 0;
    if (board.teamId && user.role !== 'guest') {
      const teamRole = getTeamRole(board.teamId, user.id);
      if (teamRole === 'admin') return 'owner';
      if (teamRole === 'member') rank = 3;
    }
    const shared = get(
      `SELECT MAX(${shareRank('role')}) AS rank FROM board_shares
        WHERE board_id = ? AND (
          (principal_type = 'user' AND principal_id = ?)
          OR (principal_type = 'team' AND principal_id IN (SELECT team_id FROM team_members WHERE user_id = ?)))`,
      board.id,
      user.id,
      user.id,
    );
    return RANK_ROLE[Math.max(rank, Number(shared.rank ?? 0))] ?? null;
  }

  function listBoardsFor(user) {
    const current = getUser(user?.id);
    if (!current || current.disabled) return [];
    if (current.role === 'owner' || current.role === 'admin') {
      return all('SELECT * FROM boards WHERE deleted_at IS NULL ORDER BY updated_at DESC, id').map((r) => ({
        ...toBoard(r),
        role: 'owner',
      }));
    }
    const rows = all(
      `SELECT * FROM (
         SELECT b.*, MAX(
           CASE WHEN b.owner_id = $uid THEN 4 ELSE 0 END,
           CASE WHEN $member = 1 THEN CASE tm.role WHEN 'admin' THEN 4 WHEN 'member' THEN 3 ELSE 0 END ELSE 0 END,
           COALESCE((SELECT MAX(${shareRank('s.role')}) FROM board_shares s
                      WHERE s.board_id = b.id AND (
                        (s.principal_type = 'user' AND s.principal_id = $uid)
                        OR (s.principal_type = 'team' AND s.principal_id IN (SELECT team_id FROM team_members WHERE user_id = $uid)))), 0)
         ) AS level
           FROM boards b LEFT JOIN team_members tm ON tm.team_id = b.team_id AND tm.user_id = $uid
          WHERE b.deleted_at IS NULL
       ) WHERE level > 0 ORDER BY updated_at DESC, id`,
      { uid: current.id, member: current.role === 'guest' ? 0 : 1 },
    );
    return rows.map((r) => ({ ...toBoard(r), role: RANK_ROLE[r.level] }));
  }

  function shareBoard(boardId, { principalType, principalId, role }) {
    if (!PRINCIPAL_TYPES.includes(principalType)) throw new Error('invalid principal type');
    if (!SHARE_ROLES.includes(role)) throw new Error('invalid role');
    if (!(principalType === 'user' ? getUser(principalId) : getTeam(principalId))) throw new Error('principal not found');
    run(
      `INSERT INTO board_shares (board_id, principal_type, principal_id, role) VALUES (?, ?, ?, ?)
       ON CONFLICT (board_id, principal_type, principal_id) DO UPDATE SET role = excluded.role`,
      boardId,
      principalType,
      principalId,
      role,
    );
  }

  function unshareBoard(boardId, principalType, principalId) {
    run('DELETE FROM board_shares WHERE board_id = ? AND principal_type = ? AND principal_id = ?', boardId, principalType, principalId);
  }

  function listShares(boardId) {
    return all(
      `SELECT s.principal_type, s.principal_id, s.role,
              CASE s.principal_type WHEN 'user' THEN u.name ELSE t.name END AS name
         FROM board_shares s
         LEFT JOIN users u ON s.principal_type = 'user' AND u.id = s.principal_id
         LEFT JOIN teams t ON s.principal_type = 'team' AND t.id = s.principal_id
        WHERE s.board_id = ? ORDER BY s.principal_type, name COLLATE NOCASE, s.principal_id`,
      boardId,
    ).map((r) => ({ principalType: r.principal_type, principalId: r.principal_id, name: r.name, role: r.role }));
  }

  // per-person preferences

  const getPref = (userId, key) => get('SELECT value FROM user_prefs WHERE user_id = ? AND key = ?', userId, key)?.value ?? null;

  function setPref(userId, key, value) {
    if (!getUser(userId)) throw new Error('user not found');
    run('INSERT INTO user_prefs (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value', userId, key, String(value));
  }

  // settings

  const getSetting = (key) => get('SELECT value FROM settings WHERE key = ?', key)?.value ?? null;

  function setSetting(key, value) {
    run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, String(value));
  }

  // audit

  function audit(actorId, action, detail = {}) {
    run('INSERT INTO audit (ts, actor_id, action, detail) VALUES (?, ?, ?, ?)', Date.now(), actorId ?? null, action, JSON.stringify(detail ?? {}));
  }

  function listAudit(limit = 100) {
    const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 100;
    return all('SELECT id, ts, actor_id, action, detail FROM audit ORDER BY id DESC LIMIT ?', n).map((r) => ({
      id: r.id,
      ts: r.ts,
      actorId: r.actor_id,
      action: r.action,
      detail: JSON.parse(r.detail),
    }));
  }

  // `action` is a literal prefix: LIKE wildcards in it are escaped, and substr() makes the match case sensitive
  // (LIKE ignores ASCII case). `next` is the id to pass as `before`, null at the end.
  /** @param {{ limit?: number, before?: number | null, action?: string | null }} [options] */
  function listAuditPage({ limit = 50, before = null, action = null } = {}) {
    const n = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 200) : 50;
    const raw = typeof action === 'string' && action !== '' ? action : null;
    const prefix = raw === null ? null : `${raw.replace(/[\\%_]/g, '\\$&')}%`;
    const rows = all(
      `SELECT a.id, a.ts, a.actor_id, a.action, a.detail, u.name AS actor_name, u.email AS actor_email
         FROM audit a LEFT JOIN users u ON u.id = a.actor_id
        WHERE ($before IS NULL OR a.id < $before)
          AND ($prefix IS NULL OR (a.action LIKE $prefix ESCAPE '\\' AND substr(a.action, 1, length($raw)) = $raw))
        ORDER BY a.id DESC LIMIT $limit`,
      { before, prefix, raw, limit: n + 1 },
    );
    const entries = rows.slice(0, n).map((r) => ({
      id: r.id,
      ts: r.ts,
      actorId: r.actor_id,
      actorName: r.actor_name ?? null,
      actorEmail: r.actor_email ?? null,
      action: r.action,
      detail: parseDetail(r.detail),
    }));
    return { entries, next: rows.length > n ? entries[entries.length - 1].id : null };
  }

  return {
    close() {
      if (closed) return;
      closed = true;
      cache.clear();
      db.close();
    },
    /** This build's schema and the one on disk, for GET /api/internal/version (docs/migrations.md). */
    schemaReport: () => describeSchema(db, MIGRATIONS),
    db,
    transaction,
    createUser,
    getUser,
    getUserByEmail,
    listUsers,
    listMembersAdmin,
    adminStats,
    seatUsage,
    internalStatsCounts,
    countOwners,
    listOwnerEmails,
    updateUser,
    getPref,
    setPref,
    removeUser,
    createLoginToken,
    consumeLoginToken,
    createSession,
    getSession,
    createJoinCode,
    getJoinCode,
    findJoinCodeByHash,
    listJoinCodes,
    revokeJoinCode,
    createGuestSession,
    getGuestSession,
    revokeSession,
    revokeUserSessions,
    revokeAllSessions,
    revokeAllGrants,
    listActiveSessions,
    getActiveSession,
    createTeam,
    getTeam,
    listTeamsFor,
    listAllTeams,
    updateTeam,
    addTeamMember,
    removeTeamMember,
    setTeamRole,
    getTeamRole,
    listTeamMembers,
    countTeamAdmins,
    createInvite,
    findInvite,
    findInviteById,
    recordInviteUse,
    listInvites,
    revokeInvite,
    createBoard,
    getBoard,
    listBoardsFor,
    updateBoard,
    deleteBoard,
    restoreBoard,
    listBoardsAdmin,
    getBoardAdmin,
    touchBoard,
    boardRole,
    shareBoard,
    unshareBoard,
    listShares,
    getSetting,
    setSetting,
    ...createTokenStore({ get, all, run, transaction }),
    ...createTemplateStore({ get, all, run }),
    ...createAiKeyStore({ get, run, transaction }),
    ...createAssetIndex({ get, all, run }),
    audit,
    listAudit,
    listAuditPage,
  };
}
