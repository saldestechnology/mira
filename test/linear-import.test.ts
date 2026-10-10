import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDirectory } from '../server/directory.mjs';
import { searchTickets, updateTicket } from '../server/tracker/tickets.mjs';
import { applyImport, BATCH_SIZE, normalizeSnapshot, planImport } from '../server/tracker/linear-import.mjs';
import { verifySnapshot } from '../scripts/linear-verify.mjs';
import graphFixture from './fixtures/linear/graphql.json';


/** Owner-only file modes exist on POSIX; Windows reports 0666 for every file, so the mode is only asserted elsewhere. */
function expectPrivateFile(file: string) {
  if (process.platform === 'win32') return;
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
}

const opened: any[] = [];
const tempDirs: string[] = [];

function id(number: number) {
  return `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
}

function newDirectory(file = ':memory:') {
  const directory: any = openDirectory(file);
  opened.push(directory);
  return directory;
}

/** Slice 2 ships projects, milestones and ticket_relations; `full: false` drops them to exercise the probe-and-report path. */
function setup({ full = false }: { full?: boolean } = {}) {
  const directory = newDirectory();
  if (!full) directory.db.exec('DROP TABLE ticket_relations; DROP TABLE milestones; DROP TABLE projects;');
  const owner = directory.createUser({ email: 'owner@example.test', name: 'Workspace Owner', role: 'owner' });
  const member = directory.createUser({ email: 'ari@example.com', name: 'Ari Member', role: 'member' });
  return { directory, owner, member, actor: { id: owner.id, role: owner.role, name: owner.name } };
}

function buildSnapshot(count = 250, { secondTeam = false }: { secondTeam?: boolean } = {}) {
  const fetchedAt = '2025-03-01T00:00:00.000Z';
  const teams = [
    { id: id(1), key: 'TAB', name: 'Core', private: false, archivedAt: null },
    { id: id(2), key: secondTeam ? 'OPS' : 'TAB', name: 'Platform', private: false, archivedAt: null },
    { id: id(3), key: 'TAB', name: 'Private work', private: true, archivedAt: null },
  ];
  const users = [
    { id: id(10), name: 'Ari Member', email: 'ARI@example.com ', active: true },
    { id: id(11), name: 'Import bot', email: null, active: false },
  ];
  const projects = [{ id: id(40), name: 'Tracker launch', description: 'Fixture project text', state: 'started', teamIds: [id(1)], createdAt: fetchedAt, updatedAt: fetchedAt, archivedAt: null }];
  const cycles = [{ id: id(41), name: 'Cycle 1', description: '', teamId: id(1), startsAt: fetchedAt, endsAt: '2025-03-15T00:00:00.000Z', completedAt: null, archivedAt: null }];
  const milestones = [{ id: id(42), name: 'Alpha', description: '', projectId: id(40), targetDate: '2025-03-15', createdAt: fetchedAt, updatedAt: fetchedAt, archivedAt: null }];
  const issues = Array.from({ length: count }, (_, index) => {
    const number = 211 + index;
    const done = index >= Math.ceil(count * 0.2);
    const canceled = index === 4;
    const issueId = id(1_000 + index);
    const state = canceled ? { id: id(2_004), name: 'Won’t do', type: 'canceled' }
      : done ? { id: id(2_003), name: 'Done', type: 'completed' }
        : index === 0 ? { id: id(2_001), name: 'Code review', type: 'started' }
          : index === 1 ? { id: id(2_000), name: 'Backlog', type: 'backlog' }
            : index === 2 ? { id: id(2_000), name: 'Open', type: 'unstarted' }
              : { id: id(2_002), name: 'In progress', type: 'started' };
    const createdAt = new Date(Date.parse(fetchedAt) + index * 60_000).toISOString();
    const issue: any = {
      id: issueId, identifier: secondTeam && index === 0 ? `OPS-${number}` : `TAB-${number}`, number,
      teamKey: secondTeam && index === 0 ? 'OPS' : 'TAB', teamId: secondTeam && index === 0 ? teams[1].id : teams[index % teams.length].id,
      teamPrivate: index === 8, title: index === 0 ? 'Unicode 🧭 **launch**' : `Issue ${number}`,
      description: index === 0 ? 'Markdown **description**\n\n- fixture body' : '', priority: index === 10 ? 9 : index === 0 ? 2 : index % 5,
      estimate: index === 0 ? 3 : null, state, assigneeEmail: index === 0 ? ' Ari@example.com ' : index === 1 ? 'missing@example.test' : null,
      creatorEmail: 'creator@example.test', labels: index === 0 ? [
        { id: id(30), name: 'Bug', color: '#aabbcc' }, { id: id(31), name: 'bug', color: '#ff0000' },
      ] : index === 1 ? [{ id: id(30), name: 'Bug', color: '#aabbcc' }] : [],
      projectId: index === 0 ? id(40) : null, cycleId: index === 0 ? id(41) : null, milestoneId: index === 0 ? id(42) : null,
      parentId: index === 1 ? id(1_000) : null, dueDate: index === 0 ? '2025-03-10' : null,
      createdAt, updatedAt: new Date(Date.parse(createdAt) + 20_000).toISOString(),
      archivedAt: done ? new Date(Date.parse(createdAt) + 10_000).toISOString() : null,
      completedAt: done ? new Date(Date.parse(createdAt) + 10_000).toISOString() : null,
      canceledAt: canceled ? new Date(Date.parse(createdAt) + 10_000).toISOString() : null,
      url: `https://linear.app/tab/issue/TAB-${number}`, comments: [], relations: [], attachments: [],
    };
    if (index === 0) {
      issue.relations = [
        { id: id(70), type: 'blocks', relatedIssueId: id(1_005) },
        { id: id(71), type: 'blocked', relatedIssueId: id(1_006) },
        { id: id(72), type: 'related', relatedIssueId: id(1_007) },
        { id: id(73), type: 'duplicate', relatedIssueId: id(1_008) },
        { id: id(74), type: 'similar', relatedIssueId: id(1_009) },
      ];
      issue.attachments = [{ url: 'https://files.example.test/design.pdf', title: 'Wireframe' }];
      issue.comments = [
        { id: id(80), body: 'Parent **comment**', createdAt: new Date(Date.parse(createdAt) + 1_000).toISOString(), editedAt: null, authorName: 'Ari Member', authorEmail: 'ari@example.com', parentId: null },
        { id: id(81), body: 'Threaded reply 🧵', createdAt: new Date(Date.parse(createdAt) + 2_000).toISOString(), editedAt: new Date(Date.parse(createdAt) + 3_000).toISOString(), authorName: 'Import bot', authorEmail: null, parentId: id(80) },
      ];
    } else if (index === 1) {
      issue.comments = [{ id: id(82), body: 'Bot comment fixture', createdAt: new Date(Date.parse(createdAt) + 1_000).toISOString(), editedAt: null, authorName: 'Import bot', authorEmail: null, parentId: null }];
    }
    return issue;
  });
  const result: any = {
    version: 1, fetchedAt, teams, users, states: [],
    labels: [
      { id: id(30), name: 'Bug', color: '#aabbcc', archivedAt: null },
      { id: id(31), name: 'bug', color: '#ff0000', archivedAt: null },
    ],
    projects, cycles, milestones, issues,
    deletedComments: [{ issueId: id(1_001), id: id(90) }],
  };
  return result;
}

function addTargetTables(db: any) {
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', state TEXT NOT NULL,
      owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, archived_at INTEGER
    );
    CREATE TABLE milestones (
      id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL, name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', start_at INTEGER, due_at INTEGER, state TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER
    );
    CREATE TABLE ticket_relations (
      id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
      related_ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
      kind TEXT NOT NULL CHECK(kind IN ('blocks', 'blocked_by', 'relates_to', 'duplicates', 'duplicated_by', 'cloned_from')),
      created_at INTEGER NOT NULL, created_by_type TEXT NOT NULL, created_by_id TEXT,
      UNIQUE(ticket_id, related_ticket_id, kind), CHECK(ticket_id <> related_ticket_id)
    );
  `);
}

const RELATION_COUNTS = [{ kind: 'blocks', count: 2 }, { kind: 'duplicates', count: 1 }, { kind: 'relates_to', count: 2 }];

function setupTemp() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'linear-import-test-'));
  tempDirs.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of opened.splice(0)) directory.close();
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('Linear import planning and writes', () => {
  it('plans 250 issues with archived counts, mappings, and every requested loss category without writes', () => {
    const { directory } = setup();
    const before = directory.db.prepare('SELECT COUNT(*) AS count FROM tickets').get().count;
    const { plan, report } = planImport({ db: directory.db, snapshot: buildSnapshot() });
    expect(plan.batches.map((batch: any) => batch.count)).toEqual([100, 100, 50]);
    expect(report.counts).toMatchObject({ issues: 250, active: 50, archived: 200 });
    expect(report.counts.archivedByState.Done).toBe(200);
    expect(report.lossReport).toMatchObject({
      workflowStates: expect.objectContaining({ count: expect.any(Number) }), estimates: { count: 0, preserved: true, preservedCount: 1, preservedKeys: ['TAB-211'] },
      cycles: expect.objectContaining({ count: 1 }), projects: expect.objectContaining({ count: 1 }), milestones: expect.objectContaining({ count: 1 }),
      relations: expect.objectContaining({ count: 1 }), unsupportedRelationTypes: expect.objectContaining({ count: 1 }),
      privateTeams: expect.objectContaining({ count: 1 }), reactions: expect.objectContaining({ count: null, keys: [] }), deletedComments: expect.objectContaining({ count: 1 }),
      attachments: expect.objectContaining({ count: 1 }), unmatchedUsers: expect.objectContaining({ count: 1 }),
    });
    expect(report.attachments.sourceUrls).toEqual([{ key: 'TAB-211', url: 'https://files.example.test/design.pdf' }]);
    expect(report.labels.colorConflictKeys).toContain('TAB-211');
    expect(directory.db.prepare('SELECT COUNT(*) AS count FROM tickets').get().count).toBe(before);
    expect(JSON.stringify(report)).not.toContain('Markdown **description**');
    expect(JSON.stringify(report)).not.toContain('Parent **comment**');
  });

  it('imports in 100 issue transactions, preserving IDs, aliases, timestamps, comments, labels and the key floor', () => {
    const { directory, actor, member } = setup();
    const snapshot = buildSnapshot();
    const result = applyImport({ db: directory.db, snapshot, actor });
    expect(result).toMatchObject({ ok: true, created: 250, batches: 3 });
    expect(directory.db.prepare('SELECT COUNT(*) AS count FROM tickets').get().count).toBe(250);
    expect(directory.db.prepare('SELECT next_number FROM ticket_counters WHERE scope = ? AND prefix = ?').get('trk_default', 'TAB').next_number).toBe(461);
    const ticket = directory.db.prepare('SELECT * FROM tickets WHERE key = ?').get('TAB-211');
    expect(ticket).toMatchObject({ title: 'Unicode 🧭 **launch**', description: 'Markdown **description**\n\n- fixture body', state_id: 'st_in_review', priority: 2, estimate: 3, assignee_user_id: member.id, due_date: '2025-03-10' });
    expect(ticket.archived_at).toBeNull();
    expect(ticket.created_at).toBe(Date.parse(snapshot.issues[0].createdAt));
    expect(ticket.updated_at).toBe(Date.parse(snapshot.issues[0].updatedAt));
    expect(directory.db.prepare('SELECT provider, external_id, display_key FROM ticket_aliases WHERE ticket_id = ? ORDER BY provider').all(ticket.id)).toEqual([
      { provider: 'linear', external_id: id(1_000), display_key: 'TAB-211' },
      { provider: 'linear-key', external_id: 'TAB-211', display_key: 'TAB-211' },
    ]);
    expect(directory.db.prepare('SELECT COUNT(*) AS count FROM ticket_labels WHERE ticket_id = ?').get(ticket.id).count).toBe(1);
    const comments = directory.db.prepare('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at').all(ticket.id);
    expect(comments).toMatchObject([
      { id: `linear-comment-${id(80)}`, actor_type: 'system', author_snapshot: 'Ari Member <ari@example.com>', body: 'Parent **comment**', created_at: Date.parse(snapshot.issues[0].comments[0].createdAt), edited_at: null, client_id: `linear:${id(80)}` },
      { id: `linear-comment-${id(81)}`, actor_type: 'system', author_snapshot: 'Import bot', body: 'Threaded reply 🧵', parent_id: `linear-comment-${id(80)}`, client_id: `linear:${id(81)}` },
    ]);
    expect(directory.db.prepare('SELECT event_type, source, idempotency_key FROM ticket_events WHERE ticket_id = ?').all(ticket.id)).toEqual([
      { event_type: 'created', source: 'linear-import', idempotency_key: `linear:${id(1_000)}` },
    ]);
    expect(directory.db.prepare('SELECT parent_ticket_id FROM tickets WHERE key = ?').get('TAB-212').parent_ticket_id).toBe(ticket.id);
    expect(directory.db.prepare('SELECT archived_at FROM tickets WHERE key = ?').get('TAB-460').archived_at).toBeNull();
    expect(result.report.archiveChoice).toContain('remain normal Done/Cancelled tickets');
  });

  it('makes imported aliases searchable straight after the import (the search row is refreshed with the alias)', () => {
    const { directory, actor } = setup({ full: true });
    const snapshot = buildSnapshot(3);
    expect(applyImport({ db: directory.db, snapshot, actor }).ok).toBe(true);
    const byUuid = searchTickets({ directory, actor, query: id(1_000) });
    expect(byUuid.entries.map((ticket: any) => ticket.key)).toContain('TAB-211');
  });

  it('supports allocate numbering by createdAt and falls back automatically for a second team key', () => {
    const { directory, actor } = setup();
    const snapshot = buildSnapshot(2, { secondTeam: true });
    snapshot.issues[0].createdAt = '2025-03-01T00:02:00.000Z';
    snapshot.issues[1].createdAt = '2025-03-01T00:01:00.000Z';
    const result = applyImport({ db: directory.db, snapshot, actor });
    expect(result.ok).toBe(true);
    expect(result.report.numbering.strategy).toBe('allocate');
    expect(directory.db.prepare('SELECT key FROM tickets WHERE key IN (?, ?) ORDER BY number').all('TAB-1', 'TAB-2')).toEqual([{ key: 'TAB-1' }, { key: 'TAB-2' }]);
    expect(directory.db.prepare('SELECT external_id, ticket_id FROM ticket_aliases WHERE provider = ?').all('linear').map((row: any) => row.ticket_id)).toEqual([
      directory.db.prepare('SELECT id FROM tickets WHERE key = ?').get('TAB-2').id,
      directory.db.prepare('SELECT id FROM tickets WHERE key = ?').get('TAB-1').id,
    ]);
  });

  it('is idempotent when re-run and appends only new comments in delta mode', () => {
    const { directory, actor } = setup();
    const first = buildSnapshot(3);
    const initial = applyImport({ db: directory.db, snapshot: first, actor });
    const counts = directory.db.prepare('SELECT (SELECT COUNT(*) FROM tickets) AS tickets, (SELECT COUNT(*) FROM ticket_comments) AS comments').get();
    const rerun = applyImport({ db: directory.db, snapshot: first, actor });
    expect(initial.created).toBe(3);
    expect(rerun).toMatchObject({ ok: true, created: 0, updated: 0 });
    expect(directory.db.prepare('SELECT (SELECT COUNT(*) FROM tickets) AS tickets, (SELECT COUNT(*) FROM ticket_comments) AS comments').get()).toEqual(counts);

    const delta = buildSnapshot(4);
    delta.issues[0].title = 'Changed by Linear';
    delta.issues[0].updatedAt = '2025-04-01T00:00:00.000Z';
    delta.issues[0].comments.push({ id: id(83), body: 'New delta comment', createdAt: '2025-04-01T00:01:00.000Z', editedAt: null, authorName: 'Ari Member', authorEmail: 'ari@example.com', parentId: null });
    const applied = applyImport({ db: directory.db, snapshot: delta, actor, options: { mode: 'update', fields: ['title'], delta: true } });
    expect(applied).toMatchObject({ ok: true, created: 1, updated: 1 });
    expect(directory.db.prepare('SELECT title FROM tickets WHERE key = ?').get('TAB-211').title).toBe('Changed by Linear');
    expect(directory.db.prepare("SELECT COUNT(*) AS count FROM ticket_comments WHERE client_id = ?").get(`linear:${id(83)}`).count).toBe(1);
    const appliedAgain = applyImport({ db: directory.db, snapshot: delta, actor, options: { mode: 'update', fields: ['title'], delta: true } });
    expect(appliedAgain.created).toBe(0);
    expect(directory.db.prepare("SELECT COUNT(*) AS count FROM ticket_comments WHERE client_id = ?").get(`linear:${id(83)}`).count).toBe(1);
  });

  it('refuses to overwrite a Tabula edit in update mode and lists the key-field conflict', () => {
    const { directory, actor } = setup({ full: true });
    const snapshot = buildSnapshot(1);
    applyImport({ db: directory.db, snapshot, actor });
    updateTicket({ directory, actor, key: 'TAB-211', patch: { title: 'Edited in Tabula' }, now: Date.parse('2025-03-02T00:00:00.000Z') });
    snapshot.issues[0].title = 'Linear changed title';
    snapshot.issues[0].updatedAt = '2025-03-03T00:00:00.000Z';
    const result = applyImport({ db: directory.db, snapshot, actor, options: { mode: 'update', fields: ['title'] } });
    expect(result).toMatchObject({ ok: true, updated: 0, conflicts: [{ key: 'TAB-211', field: 'title' }] });
    expect(directory.db.prepare('SELECT title FROM tickets WHERE key = ?').get('TAB-211').title).toBe('Edited in Tabula');
  });

  it('rolls back a failed batch while leaving earlier batches committed', () => {
    const { directory, actor } = setup();
    const snapshot = buildSnapshot(250);
    directory.db.exec("CREATE TRIGGER fail_linear_batch BEFORE INSERT ON tickets WHEN NEW.number = 311 BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    const result = applyImport({ db: directory.db, snapshot, actor });
    expect(result).toMatchObject({ ok: false, errorCode: 'batch_failed', failedBatch: 2, created: 100, batches: 2 });
    expect(directory.db.prepare('SELECT COUNT(*) AS count FROM tickets').get().count).toBe(100);
    expect(directory.db.prepare("SELECT COUNT(*) AS count FROM ticket_aliases WHERE provider = 'linear'").get().count).toBe(100);
    expect(JSON.stringify(result)).not.toContain('fixture failure');
  });

  it('stores relations in the normalised slice 2 form, projects and milestones, and keeps cycles in the loss report', () => {
    const { directory, actor } = setup({ full: true });
    const snapshot = buildSnapshot(12);
    const result = applyImport({ db: directory.db, snapshot, actor });
    expect(result.ok).toBe(true);
    expect(directory.db.prepare('SELECT id FROM projects').all()).toEqual([{ id: id(40) }]);
    expect(directory.db.prepare('SELECT id, project_id FROM milestones ORDER BY id').all()).toEqual([{ id: id(42), project_id: id(40) }]);
    expect(directory.db.prepare('SELECT kind, COUNT(*) AS count FROM ticket_relations GROUP BY kind ORDER BY kind').all()).toEqual(RELATION_COUNTS);
    expect(result.relations.written).toBe(RELATION_COUNTS.reduce((sum: number, row: any) => sum + row.count, 0));
    expect(result.report.lossReport.cycles.count).toBeGreaterThan(0);
    const issue = directory.db.prepare('SELECT project_id, milestone_id FROM tickets WHERE key = ?').get('TAB-211');
    expect(issue).toEqual({ project_id: id(40), milestone_id: id(42) });
    expect(result.report.lossReport.projects.count).toBe(0);
    expect(result.report.lossReport.relations.count).toBe(0);
  });

  it('stores one normalised row per pair and skips blocks cycles and a milestone that is not in the ticket project', () => {
    const { directory, actor } = setup({ full: true });
    const snapshot = buildSnapshot(4);
    const [a, b, c, d] = snapshot.issues;
    for (const issue of snapshot.issues) issue.relations = [];
    a.relations = [{ id: id(7001), type: 'blocks', relatedIssueId: b.id }, { id: id(7002), type: 'related', relatedIssueId: c.id }, { id: id(7003), type: 'duplicate', relatedIssueId: d.id }];
    b.relations = [{ id: id(7004), type: 'blocks', relatedIssueId: a.id }, { id: id(7005), type: 'blocked', relatedIssueId: c.id }];
    c.relations = [{ id: id(7006), type: 'related', relatedIssueId: a.id }];
    d.relations = [{ id: id(7007), type: 'duplicated_by', relatedIssueId: a.id }];
    const result = applyImport({ db: directory.db, snapshot, actor });
    expect(result.ok).toBe(true);
    expect(result.relations).toMatchObject({ skippedCycle: 1, written: 4 });
    const rows = directory.db.prepare(`SELECT s.key AS from_key, t.key AS to_key, r.kind FROM ticket_relations r
      JOIN tickets s ON s.id = r.ticket_id JOIN tickets t ON t.id = r.related_ticket_id ORDER BY s.key, t.key, r.kind`).all();
    const key = (issue: any) => `TAB-${issue.number}`;
    expect(rows.map((row: any) => `${row.from_key}>${row.to_key}:${row.kind}`).sort()).toEqual([
      `${key(a)}>${key(b)}:blocks`, `${key(a)}>${key(c)}:relates_to`, `${key(a)}>${key(d)}:duplicates`, `${key(c)}>${key(b)}:blocks`,
    ].sort());
    expect(rows.some((row: any) => ['blocked_by', 'duplicated_by'].includes(row.kind))).toBe(false);
    expect(directory.db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE milestone_id IS NOT NULL AND project_id IS NULL').get().n).toBe(0);
  });

  it('writes a private preserved sidecar with keys and source IDs only when target tables are absent', () => {
    const { directory, actor } = setup();
    const out = setupTemp();
    const snapshot = buildSnapshot(12);
    const result = applyImport({ db: directory.db, snapshot, actor, options: { out } });
    expect(result.ok).toBe(true);
    expect(result.report.lossReport).toMatchObject({ projects: { count: 1 }, milestones: { count: 1 }, cycles: { count: 1 }, relations: { count: 1 } });
    const sidecar = fs.readFileSync(path.join(out, 'preserved.jsonl'), 'utf8');
    expectPrivateFile(path.join(out, 'preserved.jsonl'));
    expect(sidecar).toContain('TAB-211');
    expect(sidecar).toContain(id(40));
    expect(sidecar).toContain(id(1_009));
    expect(sidecar).not.toContain('Unicode 🧭');
    expect(sidecar).not.toContain('Markdown **description**');
    expect(sidecar).not.toContain('Parent **comment**');
  });

  it('backfills preserved assignments and relations in a later delta after target tables appear', () => {
    const { directory, actor } = setup();
    const out = setupTemp();
    const initial = buildSnapshot(12);
    expect(applyImport({ db: directory.db, snapshot: initial, actor, options: { out } }).ok).toBe(true);
    addTargetTables(directory.db);
    const delta = buildSnapshot(0);
    const result = applyImport({ db: directory.db, snapshot: delta, actor, options: { out, mode: 'update', delta: true } });
    expect(result.ok).toBe(true);
    expect(directory.db.prepare('SELECT project_id, milestone_id FROM tickets WHERE key = ?').get('TAB-211')).toEqual({ project_id: id(40), milestone_id: id(42) });
    expect(directory.db.prepare('SELECT COUNT(*) AS count FROM ticket_relations').get().count).toBe(5);
    expect(fs.readFileSync(path.join(out, 'preserved.jsonl'), 'utf8').trim().split('\n')).toHaveLength(12);
  });

  it('verifies counts and deterministic hashes without emitting ticket or comment text, and detects tampering', () => {
    const { directory, actor } = setup();
    const snapshot = buildSnapshot(250);
    applyImport({ db: directory.db, snapshot, actor });
    const verified = verifySnapshot({ db: directory.db, snapshot });
    expect(verified.ok).toBe(true);
    const output = JSON.stringify(verified);
    expect(output).toContain('"passed":true');
    expect(output).not.toContain('Markdown **description**');
    expect(output).not.toContain('Parent **comment**');
    directory.db.prepare('UPDATE tickets SET title = ?').run('tampered title');
    directory.db.prepare('DELETE FROM ticket_comments WHERE client_id = ?').run(`linear:${id(80)}`);
    directory.db.prepare("DELETE FROM ticket_aliases WHERE provider = 'linear' AND external_id = ?").run(id(1_001));
    const failed = verifySnapshot({ db: directory.db, snapshot });
    expect(failed.ok).toBe(false);
    expect(failed.checks.some((check: any) => check.name === 'issue_count' && !check.passed)).toBe(true);
    expect(failed.checks.some((check: any) => check.name === 'comment_count' && !check.passed)).toBe(true);
    expect(failed.checks.some((check: any) => check.name === 'ticket_content_spot_checks' && !check.passed)).toBe(true);
    expect(JSON.stringify(failed)).not.toContain('tampered title');
  });

  it('rejects unknown snapshot versions and keeps validation bounded', () => {
    expect(() => normalizeSnapshot({ version: 2, issues: [] })).toThrow('Unknown Linear snapshot version.');
    const snapshot = buildSnapshot(1);
    snapshot.issues[0].title = 'x'.repeat(201);
    expect(() => normalizeSnapshot(snapshot)).toThrow('issue title exceeds the supported size.');
  });

  it('keeps SQLite work bounded when importing 2,000 issues', () => {
    function measureImport(issueCount: number) {
      const { directory, actor } = setup();
      const work = { statements: 0, rows: 0 };
      const measuredDb = {
        exec(sql: string) {
          work.statements++;
          return directory.db.exec(sql);
        },
        prepare(sql: string) {
          const statement = directory.db.prepare(sql);
          return {
            run(...args: any[]) {
              work.statements++;
              return statement.run(...args);
            },
            get(...args: any[]) {
              work.statements++;
              const row = statement.get(...args);
              if (row !== undefined) work.rows++;
              return row;
            },
            all(...args: any[]) {
              work.statements++;
              const rows = statement.all(...args);
              work.rows += rows.length;
              return rows;
            },
            iterate(...args: any[]) {
              work.statements++;
              const rows = statement.iterate(...args);
              return (function* countRows() {
                for (const row of rows) {
                  work.rows++;
                  yield row;
                }
              })();
            },
          };
        },
      };
      const result = applyImport({ db: measuredDb, snapshot: buildSnapshot(issueCount), actor });
      expect(result).toMatchObject({ ok: true, created: issueCount, batches: Math.ceil(issueCount / BATCH_SIZE) });
      expect(directory.db.prepare('SELECT COUNT(*) AS count FROM tickets').get().count).toBe(issueCount);
      return work;
    }

    const small = measureImport(100);
    const large = measureImport(2_000);
    expect(BATCH_SIZE).toBe(100);
    expect(small.statements).toBeGreaterThan(0);
    expect(small.rows).toBeGreaterThan(0);
    expect(large.statements).toBeLessThanOrEqual(small.statements * 40);
    expect(large.rows).toBeLessThanOrEqual(small.rows * 40);
  }, 120_000);

  it('keeps dry-run database bytes unchanged and the CLI requires --yes and an owner actor for writes', () => {
    const root = setupTemp();
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir);
    const database = path.join(dataDir, 'directory.sqlite');
    const directory = newDirectory(database);
    directory.createUser({ email: 'owner@example.test', name: 'Workspace Owner', role: 'owner' });
    directory.close();
    opened.pop();
    const snapshotFile = path.join(root, 'snapshot.json');
    fs.writeFileSync(snapshotFile, JSON.stringify(buildSnapshot(1)));
    const cli = path.resolve('scripts/linear-import.mjs');
    const before = fs.readFileSync(database);
    const dry = spawnSync(process.execPath, [cli, 'dry-run', '--data-dir', dataDir, '--snapshot', snapshotFile, '--out', path.join(root, 'reports')], { encoding: 'utf8' });
    expect(dry.status).toBe(0);
    expect(fs.readFileSync(database)).toEqual(before);
    expectPrivateFile(path.join(root, 'reports', 'report.json'));

    const refused = spawnSync(process.execPath, [cli, 'import', '--data-dir', dataDir, '--snapshot', snapshotFile, '--actor-email', 'owner@example.test'], { encoding: 'utf8' });
    expect(refused.status).toBe(1);
    expect(refused.stdout).toContain('"refused": true');
    expect(refused.stdout).toContain('"issues": 1');

    const noOwner = spawnSync(process.execPath, [cli, 'import', '--data-dir', dataDir, '--snapshot', snapshotFile, '--actor-email', 'missing@example.test', '--yes'], { encoding: 'utf8' });
    expect(noOwner.status).toBe(1);
    expect(`${noOwner.stdout}${noOwner.stderr}`).toContain('--actor-email must belong to an active workspace owner.');
  });

  it('writes CLI snapshots and cursor/count-only checkpoints with mode 0600 from replay fixtures', () => {
    const root = setupTemp();
    const replayDir = path.join(root, 'replay');
    const out = path.join(root, 'fetched');
    fs.mkdirSync(replayDir);
    const operations = ['LinearTeams', 'LinearUsers', 'LinearStates', 'LinearLabels', 'LinearProjects', 'LinearCycles', 'LinearMilestones', 'LinearIssues', 'LinearComments', 'LinearRelations', 'LinearAttachments'];
    operations.forEach((operationName, index) => {
      fs.writeFileSync(path.join(replayDir, `${String(index + 1).padStart(6, '0')}.json`), JSON.stringify({ request: { operationName }, response: (graphFixture as any)[operationName] }));
    });
    const cli = path.resolve('scripts/linear-import.mjs');
    const fetched = spawnSync(process.execPath, [cli, 'fetch', '--replay', replayDir, '--out', out], { encoding: 'utf8' });
    expect(fetched.status).toBe(0);
    for (const name of ['snapshot.json', 'checkpoint.json', 'last-fetch.json']) expectPrivateFile(path.join(out, name));
    const checkpoint = fs.readFileSync(path.join(out, 'checkpoint.json'), 'utf8');
    expect(checkpoint).toContain('"counts"');
    expect(checkpoint).toContain('"cursors"');
    expect(checkpoint).not.toContain('Unicode 🧭');
    expect(checkpoint).not.toContain('Parent **comment**');
    expect(fs.existsSync(path.join(out, '.partial.json'))).toBe(false);
  });
});
