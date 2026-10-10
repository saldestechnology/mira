import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDirectory } from '../server/directory.mjs';
import { normalizeSnapshot } from '../server/tracker/linear-import.mjs';

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function issueKey(issue) {
  return issue.identifier || `${issue.teamKey}-${issue.number}`;
}

function mapSource(snapshot, db) {
  const result = new Map();
  for (const issue of snapshot.issues) {
    const row = db.prepare("SELECT ticket_id FROM ticket_aliases WHERE provider = 'linear' AND external_id = ?").get(issue.id);
    if (row) result.set(issue.id, row.ticket_id);
  }
  return result;
}

function targetCategory(type) {
  if (type === 'completed') return 'completed';
  if (type === 'canceled' || type === 'cancelled') return 'canceled';
  return type === 'started' ? 'started' : 'unstarted';
}

function relationKind(type) {
  switch (String(type).toLowerCase()) {
    case 'blocks': return 'blocks';
    case 'blocked':
    case 'blocked_by': return 'blocked_by';
    case 'duplicate':
    case 'duplicates': return 'duplicates';
    case 'duplicated_by': return 'duplicated_by';
    default: return 'relates_to';
  }
}

function stableRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function sample(items, count) {
  const selected = [...items];
  const random = stableRandom(0x4c494e45);
  for (let index = selected.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [selected[index], selected[swap]] = [selected[swap], selected[index]];
  }
  return selected.slice(0, Math.min(count, selected.length));
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function importedComments(db, ticketId) {
  return db.prepare(`SELECT body, created_at, client_id FROM ticket_comments
    WHERE ticket_id = ? AND client_id LIKE 'linear:%' ORDER BY created_at, client_id`).all(ticketId);
}

function snapshotComments(issue) {
  return [...issue.comments].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id)).map((comment) => comment.body);
}

function labelCount(db, ticketId) {
  return Number(db.prepare('SELECT COUNT(*) AS count FROM ticket_labels WHERE ticket_id = ?').get(ticketId).count);
}

function expectedLabelCount(issue) {
  return new Set(issue.labels.map((label) => label.name.trim().toLocaleLowerCase('en-US'))).size;
}

function countCheck(name, expected, actual, keys = []) {
  return { name, passed: expected === actual, expected, actual, keys };
}

function keysForCountMismatch(rows, expected, actual) {
  return expected === actual ? [] : rows.slice(0, 50).map(issueKey);
}

/** Compare a complete normalized source snapshot with its imported database rows. */
export function verifySnapshot({ db, snapshot: rawSnapshot } = {}) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const checks = [];
  const ticketIds = mapSource(snapshot, db);
  const actualIssueCount = Number(db.prepare("SELECT COUNT(*) AS count FROM ticket_aliases WHERE provider = 'linear'").get().count);
  checks.push(countCheck('issue_count', snapshot.issues.length, actualIssueCount, keysForCountMismatch(snapshot.issues, snapshot.issues.length, actualIssueCount)));

  const duplicateAliases = db.prepare(`SELECT provider, external_id, COUNT(*) AS count FROM ticket_aliases
    WHERE provider IN ('linear', 'linear-key') GROUP BY provider, external_id HAVING COUNT(*) > 1`).all();
  const linearKeyCount = Number(db.prepare("SELECT COUNT(*) AS count FROM ticket_aliases WHERE provider = 'linear-key'").get().count);
  checks.push(countCheck('alias_uniqueness', 0, duplicateAliases.length, []));
  checks.push(countCheck('identifier_alias_count', snapshot.issues.length, linearKeyCount, []));

  const expectedComments = snapshot.issues.reduce((sum, issue) => sum + issue.comments.length, 0);
  const actualComments = Number(db.prepare("SELECT COUNT(*) AS count FROM ticket_comments WHERE client_id LIKE 'linear:%'").get().count);
  checks.push(countCheck('comment_count', expectedComments, actualComments));

  const expectedStateCounts = {};
  for (const issue of snapshot.issues) {
    const category = targetCategory(issue.state.type);
    expectedStateCounts[category] = (expectedStateCounts[category] ?? 0) + 1;
  }
  const importedStateCounts = db.prepare(`SELECT s.category, COUNT(*) AS count FROM tickets t
    JOIN ticket_aliases a ON a.ticket_id = t.id AND a.provider = 'linear'
    JOIN ticket_states s ON s.id = t.state_id GROUP BY s.category`).all();
  const actualStateCounts = Object.fromEntries(importedStateCounts.map((row) => [row.category, Number(row.count)]));
  const stateCountsMatch = Object.keys({ ...expectedStateCounts, ...actualStateCounts }).every((category) => expectedStateCounts[category] === actualStateCounts[category]);
  checks.push({ name: 'state_distribution', passed: stateCountsMatch, expected: expectedStateCounts, actual: actualStateCounts, keys: [] });

  const parentMismatches = [];
  for (const issue of snapshot.issues) {
    if (!issue.parentId) continue;
    const child = ticketIds.get(issue.id);
    const parent = ticketIds.get(issue.parentId);
    const row = child ? db.prepare('SELECT parent_ticket_id FROM tickets WHERE id = ?').get(child) : null;
    if (!row || row.parent_ticket_id !== parent) parentMismatches.push(issueKey(issue));
  }
  checks.push(countCheck('parent_links', 0, parentMismatches.length, unique(parentMismatches)));

  const labelMismatches = [];
  for (const issue of snapshot.issues) {
    const ticketId = ticketIds.get(issue.id);
    if (ticketId && labelCount(db, ticketId) !== expectedLabelCount(issue)) labelMismatches.push(issueKey(issue));
  }
  checks.push(countCheck('label_counts', 0, labelMismatches.length, unique(labelMismatches)));

  let expectedMatchedAssignees = 0;
  const assigneeMismatches = [];
  for (const issue of snapshot.issues) {
    const ticketId = ticketIds.get(issue.id);
    if (!ticketId) continue;
    const email = typeof issue.assigneeEmail === 'string' ? issue.assigneeEmail.trim().toLowerCase() : '';
    const users = email ? db.prepare("SELECT id FROM users WHERE role IN ('owner', 'admin', 'member') AND disabled = 0 AND lower(trim(email)) = ?").all(email) : [];
    const expected = users.length === 1 ? users[0].id : null;
    if (expected) expectedMatchedAssignees++;
    const actual = db.prepare('SELECT assignee_user_id FROM tickets WHERE id = ?').get(ticketId)?.assignee_user_id ?? null;
    if (actual !== expected) assigneeMismatches.push(issueKey(issue));
  }
  const actualMatchedAssignees = Number(db.prepare(`SELECT COUNT(*) AS count FROM tickets t
    JOIN ticket_aliases a ON a.ticket_id = t.id AND a.provider = 'linear' WHERE t.assignee_user_id IS NOT NULL`).get().count);
  checks.push(countCheck('assignee_match_count', expectedMatchedAssignees, actualMatchedAssignees, unique(assigneeMismatches)));

  const archivedDoneIssues = snapshot.issues.filter((issue) => issue.archivedAt && (issue.state.type === 'completed' || issue.completedAt));
  const archivedDone = archivedDoneIssues.length;
  let actualArchivedDone = 0;
  for (const issue of archivedDoneIssues) {
    const ticketId = ticketIds.get(issue.id);
    if (ticketId && db.prepare(`SELECT 1 FROM tickets t JOIN ticket_states s ON s.id = t.state_id
      WHERE t.id = ? AND s.category = 'completed' AND t.archived_at IS NULL`).get(ticketId)) actualArchivedDone++;
  }
  checks.push(countCheck('archived_done_count', archivedDone, actualArchivedDone));

  const textSample = sample(snapshot.issues, 50);
  const textMismatches = [];
  for (const issue of textSample) {
    const ticketId = ticketIds.get(issue.id);
    const row = ticketId ? db.prepare('SELECT title, description FROM tickets WHERE id = ?').get(ticketId) : null;
    const sourceHash = hash([issue.title, issue.description, snapshotComments(issue)]);
    const dbHash = hash([row?.title ?? null, row?.description ?? null, ticketId ? importedComments(db, ticketId).map((comment) => comment.body) : []]);
    if (sourceHash !== dbHash) textMismatches.push(issueKey(issue));
  }
  checks.push({ name: 'ticket_content_spot_checks', passed: textMismatches.length === 0, expected: textSample.length, actual: textSample.length - textMismatches.length, keys: unique(textMismatches) });

  const comments = snapshot.issues.flatMap((issue) => issue.comments.map((comment) => ({ issue, comment })));
  const commentSample = sample(comments, 20);
  const commentMismatches = [];
  for (const { issue, comment } of commentSample) {
    const row = db.prepare("SELECT body FROM ticket_comments WHERE client_id = ? AND client_id LIKE 'linear:%'").get(`linear:${comment.id}`);
    if (!row || hash(comment.body) !== hash(row.body)) commentMismatches.push(issueKey(issue));
  }
  checks.push({ name: 'comment_body_spot_checks', passed: commentMismatches.length === 0, expected: commentSample.length, actual: commentSample.length - commentMismatches.length, keys: unique(commentMismatches) });

  const relationTable = tableExists(db, 'ticket_relations');
  if (relationTable) {
    const relations = snapshot.issues.flatMap((issue) => issue.relations.map((relation) => ({ issue, relation })));
    const relationSample = sample(relations, 10);
    const relationMismatches = [];
    for (const { issue, relation } of relationSample) {
      const ticketId = ticketIds.get(issue.id);
      const relatedTicketId = ticketIds.get(relation.relatedIssueId);
      const exists = ticketId && relatedTicketId && db.prepare(`SELECT 1 FROM ticket_relations
        WHERE ticket_id = ? AND related_ticket_id = ? AND kind = ?`).get(ticketId, relatedTicketId, relationKind(relation.type));
      if (!exists) relationMismatches.push(issueKey(issue));
    }
    checks.push({ name: 'relation_spot_checks', passed: relationMismatches.length === 0, expected: relationSample.length, actual: relationSample.length - relationMismatches.length, keys: unique(relationMismatches) });
  } else {
    checks.push({ name: 'relation_spot_checks', passed: true, expected: 0, actual: 0, skipped: true, keys: [] });
  }

  const projectTable = tableExists(db, 'projects');
  const milestoneTable = tableExists(db, 'milestones');
  const projectMismatches = [];
  if (projectTable) {
    for (const project of snapshot.projects) if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(project.id)) projectMismatches.push(project.id);
  }
  checks.push(countCheck('projects', 0, projectMismatches.length, unique(projectMismatches)));
  const milestoneMismatches = [];
  if (milestoneTable) {
    for (const milestone of snapshot.milestones) if (!db.prepare('SELECT 1 FROM milestones WHERE id = ?').get(milestone.id)) milestoneMismatches.push(milestone.id);
    for (const cycle of snapshot.cycles) {
      if (cycle.startsAt && cycle.endsAt && !db.prepare('SELECT 1 FROM milestones WHERE id = ?').get(`linear-cycle:${cycle.id}`)) milestoneMismatches.push(`cycle:${cycle.id}`);
    }
  }
  checks.push(countCheck('milestones', 0, milestoneMismatches.length, unique(milestoneMismatches)));
  const assignmentMismatches = [];
  for (const issue of snapshot.issues) {
    const ticketId = ticketIds.get(issue.id);
    if (!ticketId) continue;
    const row = db.prepare('SELECT project_id, milestone_id FROM tickets WHERE id = ?').get(ticketId);
    const expectedProject = projectTable ? issue.projectId : null;
    const expectedMilestone = milestoneTable ? issue.milestoneId ?? (issue.cycleId && snapshot.cycles.find((cycle) => cycle.id === issue.cycleId)?.startsAt && snapshot.cycles.find((cycle) => cycle.id === issue.cycleId)?.endsAt ? `linear-cycle:${issue.cycleId}` : null) : null;
    if (row.project_id !== expectedProject || row.milestone_id !== expectedMilestone) assignmentMismatches.push(issueKey(issue));
  }
  checks.push(countCheck('project_milestone_assignments', 0, assignmentMismatches.length, unique(assignmentMismatches)));

  return { ok: checks.every((check) => check.passed), checks };
}

function unique(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

async function main(argv) {
  const [snapshotFile, dataDir] = argv;
  if (!snapshotFile || !dataDir) throw new Error('Usage: node scripts/linear-verify.mjs <snapshot.json> <data-dir>');
  const snapshot = JSON.parse(await (await import('node:fs/promises')).readFile(snapshotFile, 'utf8'));
  const databaseFile = `${dataDir}/directory.sqlite`;
  const directory = openDirectory(databaseFile);
  try {
    const result = verifySnapshot({ db: directory.db, snapshot });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 2;
  } finally {
    directory.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write('Linear verification failed.\n');
    process.exitCode = 1;
  });
}
