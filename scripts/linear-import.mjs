#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDirectory, normaliseEmail } from '../server/directory.mjs';
import { requireTicketWrite } from '../server/tracker/access.mjs';
import { applyImport, planImport } from '../server/tracker/linear-import.mjs';
import { createReplayTransport, fetchSnapshot } from './lib/linear-source.mjs';
import { verifySnapshot } from './linear-verify.mjs';

const WRITE_COMMANDS = new Set(['import', 'delta']);
const ALLOWED_FLAGS = new Set(['--data-dir', '--snapshot', '--out', '--actor-email', '--numbering', '--mode', '--fields', '--since', '--yes', '--max-issues', '--record', '--resume', '--replay']);

function parseArgs(argv) {
  const command = argv[0];
  if (!['fetch', 'dry-run', 'import', 'delta', 'verify'].includes(command)) throw new Error('Command must be fetch, dry-run, import, delta, or verify.');
  const flags = {};
  for (let index = 1; index < argv.length; index++) {
    const name = argv[index];
    if (!ALLOWED_FLAGS.has(name)) throw new Error(`Unknown option: ${name}`);
    if (name === '--yes' || name === '--resume') {
      flags[name.slice(2)] = true;
      continue;
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${name} needs a value.`);
    flags[name.slice(2)] = value;
  }
  if (flags.numbering && !['keep', 'allocate'].includes(flags.numbering)) throw new Error('--numbering must be keep or allocate.');
  if (flags.mode && !['create', 'update'].includes(flags.mode)) throw new Error('--mode must be create or update.');
  if (flags['max-issues'] && (!/^\d+$/.test(flags['max-issues']) || Number(flags['max-issues']) < 1)) throw new Error('--max-issues must be a positive integer.');
  if (flags.fields) {
    const allowed = new Set(['title', 'description', 'state', 'priority', 'assignee', 'labels', 'due']);
    const fields = flags.fields.split(',').filter(Boolean);
    if (fields.some((field) => !allowed.has(field))) throw new Error('--fields accepts title,description,state,priority,assignee,labels,due.');
    flags.fields = [...new Set(fields)];
  }
  return { command, flags };
}

function writePrivate(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, content, { mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
}

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`${label} could not be read as JSON.`); }
}

function csvEscape(value) {
  const text = String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

function reportCsv(report) {
  const rows = [['kind', 'key', 'detail', 'count', 'url']];
  for (const state of report.stateMapping ?? []) for (const key of state.keys) rows.push(['state', key, state.linearName, 1, '']);
  for (const [category, value] of Object.entries(report.lossReport ?? {})) {
    for (const key of value.keys ?? []) rows.push(['loss', key, category, 1, '']);
  }
  for (const attachment of report.attachments?.sourceUrls ?? []) rows.push(['attachment', attachment.key, 'source_url', 1, attachment.url]);
  return `${rows.map((row) => row.map(csvEscape).join(',')).join('\r\n')}\r\n`;
}

function htmlEscape(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function reportHtml(report) {
  const lossRows = Object.entries(report.lossReport ?? {}).map(([name, value]) => `<tr><th>${htmlEscape(name)}</th><td>${Number(value.count) || 0}</td><td>${htmlEscape((value.keys ?? []).join(', '))}</td></tr>`).join('');
  const urls = (report.attachments?.sourceUrls ?? []).map((item) => `<li><code>${htmlEscape(item.key)}</code> ${htmlEscape(item.url)}</li>`).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Linear import report</title><body><h1>Linear import report</h1><p>Issues: ${report.counts.issues}; active: ${report.counts.active}; archived: ${report.counts.archived}.</p><h2>Loss report</h2><table><thead><tr><th>Category</th><th>Count</th><th>Keys</th></tr></thead><tbody>${lossRows}</tbody></table><h2>Attachment source URLs</h2><ul>${urls}</ul></body></html>\n`;
}

function writeReports(out, report) {
  if (!out) return;
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  writePrivate(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writePrivate(path.join(out, 'report.csv'), reportCsv(report));
  writePrivate(path.join(out, 'report.html'), reportHtml(report));
}

function truncateSnapshot(snapshot, maxIssues) {
  if (!maxIssues) return snapshot;
  const ids = new Set(snapshot.issues.slice(0, maxIssues).map((issue) => issue.id));
  return { ...snapshot, issues: snapshot.issues.slice(0, maxIssues), deletedComments: (snapshot.deletedComments ?? []).filter((row) => ids.has(row.issueId)) };
}

function dataDirectory(flags) {
  if (!flags['data-dir']) throw new Error('--data-dir is required for this command.');
  const directory = path.resolve(flags['data-dir']);
  const database = path.join(directory, 'directory.sqlite');
  if (!fs.existsSync(database)) throw new Error('--data-dir must contain an existing directory.sqlite.');
  return { directory, database };
}

function findActor(directory, emailValue) {
  const email = normaliseEmail(emailValue);
  if (!email) throw new Error('--actor-email must be a valid workspace owner email.');
  const user = directory.db.prepare('SELECT id, email, name, role, disabled FROM users WHERE email = ? COLLATE NOCASE').get(email);
  if (!user || user.role !== 'owner' || user.disabled) throw new Error('--actor-email must belong to an active workspace owner.');
  const actor = { id: user.id, email: user.email, name: user.name, role: user.role, workspaceRole: user.role, disabled: Boolean(user.disabled) };
  try { requireTicketWrite(actor, { id: 'tracker-access-check' }); } catch { throw new Error('The owner actor cannot write tracker tickets.'); }
  return actor;
}

function looksLive(dataDir) {
  for (const marker of ['relay.pid', 'relay.lock', '.relay.pid', 'server.pid']) {
    const file = path.join(dataDir, marker);
    if (!fs.existsSync(file)) continue;
    try {
      const pid = Number(fs.readFileSync(file, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); return true; } catch (error) { if (error?.code === 'EPERM') return true; }
      } else return true;
    } catch { return true; }
  }
  return false;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function readSnapshot(flags) {
  if (!flags.snapshot) throw new Error('--snapshot is required for this command.');
  return truncateSnapshot(readJson(path.resolve(flags.snapshot), 'Snapshot'), flags['max-issues'] ? Number(flags['max-issues']) : null);
}

function cleanCheckpointResume(out, resume) {
  if (!resume) return null;
  const checkpointFile = path.join(out, 'checkpoint.json');
  const partialFile = path.join(out, '.partial.json');
  let checkpoint;
  try { checkpoint = readJson(checkpointFile, 'Checkpoint'); } catch { return null; }
  if (Object.values(checkpoint.completed ?? {}).every(Boolean)) return null;
  let partial = {};
  try { partial = readJson(partialFile, 'Partial snapshot'); } catch { /* first request has not completed */ }
  return { checkpoint, partial };
}

async function fetchAndSave(flags, out, { since = flags.since } = {}) {
  if (!out) throw new Error('--out is required for fetch.');
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const resume = cleanCheckpointResume(out, flags.resume);
  const transport = flags.replay ? createReplayTransport(path.resolve(flags.replay)) : undefined;
  const snapshot = await fetchSnapshot({
    ...(transport ? { transport } : {}), since,
    record: flags.record ? path.resolve(flags.record) : undefined,
    resume,
    onCheckpoint: (checkpoint, partial) => {
      writePrivate(path.join(out, '.partial.json'), `${JSON.stringify(partial)}\n`);
      writePrivate(path.join(out, 'checkpoint.json'), `${JSON.stringify(checkpoint, null, 2)}\n`);
    },
  });
  const limited = truncateSnapshot(snapshot, flags['max-issues'] ? Number(flags['max-issues']) : null);
  writePrivate(path.join(out, 'snapshot.json'), `${JSON.stringify(limited, null, 2)}\n`);
  try { fs.unlinkSync(path.join(out, '.partial.json')); } catch { /* optional */ }
  const cursor = { version: 1, cursor: snapshot.fetchedAt, counts: { issues: snapshot.issues.length, comments: snapshot.issues.reduce((total, issue) => total + issue.comments.length, 0) } };
  writePrivate(path.join(out, 'last-fetch.json'), `${JSON.stringify(cursor, null, 2)}\n`);
  return limited;
}

function optionSet(flags, command) {
  return {
    numbering: flags.numbering ?? 'auto', mode: flags.mode ?? 'create', fields: flags.fields ?? [],
    delta: command === 'delta',
    out: flags.out ? path.resolve(flags.out) : undefined,
  };
}

function usageError(error) {
  const message = error instanceof Error ? error.message : 'Linear import failed.';
  process.stderr.write(`${message}\n`);
}

const USAGE = `Usage: node scripts/linear-import.mjs <command> [flags]
Commands: fetch, dry-run, import, delta, verify (see docs/linear-import.md)
Flags: --data-dir --snapshot --out --actor-email --numbering keep|allocate --mode create|update --fields --since --yes --max-issues --record --resume --replay
Writes need --yes and a stopped relay (or a restored copy). The Linear key comes from LINEAR_API_KEY in the environment only.
`;

async function main(argv) {
  if (argv[0] === '--help' || argv[0] === '-h' || argv.length === 0) {
    process.stdout.write(USAGE);
    return;
  }
  const { command, flags } = parseArgs(argv);
  if (command === 'fetch') {
    const snapshot = await fetchAndSave(flags, flags.out ? path.resolve(flags.out) : null);
    printJson({ ok: true, fetchedAt: snapshot.fetchedAt, counts: { issues: snapshot.issues.length, comments: snapshot.issues.reduce((sum, issue) => sum + issue.comments.length, 0) } });
    return;
  }

  if (command === 'dry-run') {
    if (!flags.out) throw new Error('--out is required for dry-run reports.');
    const { database } = dataDirectory(flags);
    const directory = openDirectory(database);
    try {
      const snapshot = readSnapshot(flags);
      const { plan, report } = planImport({ db: directory.db, snapshot, options: optionSet(flags, command) });
      writeReports(flags.out ? path.resolve(flags.out) : null, report);
      printJson({ plan, report });
    } finally { directory.close(); }
    return;
  }

  if (command === 'verify') {
    const { database } = dataDirectory(flags);
    const directory = openDirectory(database);
    try {
      const result = verifySnapshot({ db: directory.db, snapshot: readSnapshot(flags) });
      printJson(result);
      if (!result.ok) process.exitCode = 2;
    } finally { directory.close(); }
    return;
  }

  if (WRITE_COMMANDS.has(command)) {
    const { directory: dataDir, database } = dataDirectory(flags);
    const writingAllowed = Boolean(flags.yes);
    if (writingAllowed) {
      process.stderr.write('Reminder: stop the relay or use a restored copy, and take a backup first.\n');
      if (looksLive(dataDir)) throw new Error('The tracker data directory looks live; stop the relay or use a restored copy.');
    }
    const dbDirectory = openDirectory(database);
    try {
      let snapshot;
      if (command === 'delta' && !flags.snapshot) {
        const cursorFile = path.join(flags.out ? path.resolve(flags.out) : dataDir, 'last-success.json');
        let since = flags.since;
        if (!since && fs.existsSync(cursorFile)) since = readJson(cursorFile, 'Last successful cursor').cursor;
        const out = flags.out ? path.resolve(flags.out) : dataDir;
        if (!writingAllowed && fs.existsSync(path.join(out, 'snapshot.json'))) snapshot = truncateSnapshot(readJson(path.join(out, 'snapshot.json'), 'Snapshot'), flags['max-issues'] ? Number(flags['max-issues']) : null);
        else if (!writingAllowed) throw new Error('--yes is required for delta; provide --snapshot to print a dry-run summary without fetching.');
        else snapshot = await fetchAndSave(flags, out, { since });
      } else snapshot = readSnapshot(flags);
      const resultPlan = planImport({ db: dbDirectory.db, snapshot, options: optionSet(flags, command) });
      if (!writingAllowed) {
        printJson({ refused: true, reason: '--yes is required for import and delta writes.', plan: resultPlan.plan, report: resultPlan.report });
        process.stderr.write('No database writes were made. Stop the relay or use a restored copy, and take a backup first.\n');
        process.exitCode = 1;
        return;
      }
      const actor = findActor(dbDirectory, flags['actor-email']);
      const options = optionSet(flags, command);
      options.out = flags.out ? path.resolve(flags.out) : dataDir;
      if (command === 'delta') options.mode = 'update';
      const result = applyImport({ db: dbDirectory.db, snapshot, actor, options });
      if (flags.out) writeReports(path.resolve(flags.out), result.report ?? resultPlan.report);
      printJson(result);
      if (!result.ok) process.exitCode = 1;
      else if (!flags['max-issues']) {
        const cursorFile = path.join(flags.out ? path.resolve(flags.out) : dataDir, 'last-success.json');
        writePrivate(cursorFile, `${JSON.stringify({ version: 1, cursor: snapshot.fetchedAt, counts: { issues: snapshot.issues.length } }, null, 2)}\n`);
      }
    } finally { dbDirectory.close(); }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    usageError(error);
    process.exitCode = 1;
  });
}

export { main, parseArgs };
