# Linear import runbook

This runbook covers the recorded-fixture/API importer in `scripts/linear-import.mjs`. It uses the Linear GraphQL API, stores a mode-0600 source snapshot and reports, and never downloads attachment files.

## Before you start

1. Take and verify a workspace backup first. Follow [docs/backups.md](backups.md), and do not start cutover unless the section 9 backup go/no-go checklist in [docs/tracker-architecture.md](tracker-architecture.md#9-off-site-backups-precondition-to-cutover) passes.
2. Stop the relay before a write command, or use a restored copy of the workspace database. The CLI refuses when it sees a live relay PID/lock marker. It cannot prove that an unmarked process is stopped, so the operator must still confirm this.
3. Agree on the Linear freeze date, owner, state mapping, unmatched-user list, loss report, and two-week dual-run window.
4. Make sure the target database is `<data-dir>/directory.sqlite` and that the `--actor-email` account exists with the active `owner` role.

Set `LINEAR_API_KEY` in the invoking process environment using the operator's `scripts/env-get.mjs` flow. Do not put the key in a command argument, `.env` file, snapshot, report, or checkpoint. The importer reads the environment variable only inside its default HTTP transport and sends it in the Authorization header. A local fixture replay does not need a key.

Every GraphQL list request, including issues, comments, projects, cycles, labels, users, workflow states, project milestones, relations, attachments, and teams, sends `includeArchived: true`. This is required because Linear archived completed issues; omitting the flag would hide the Done history.

## Initial fetch and rehearsal

Fetch a complete source snapshot. `--record` saves scrubbed GraphQL request/response fixtures for later replay; it does not save the Authorization header.

```sh
node scripts/linear-import.mjs fetch --out ./linear-work --record ./linear-recording
```

The command writes `snapshot.json`, `checkpoint.json`, and `last-fetch.json` with mode `0600`. If a fetch stops, rerun with `--resume`; the cursor/count checkpoint and separate private partial data let it continue. Use `--replay <recording-dir>` to read recorded responses without network access.

Review the plan against the database without writing to it:

```sh
node scripts/linear-import.mjs dry-run \
  --data-dir <data-dir> --snapshot ./linear-work/snapshot.json --out ./linear-work/report
```

The report includes issue totals split into active and archived, plus archived issues grouped by their original Linear state. It also lists target state mappings with original state names, priority handling, matched/unmatched user counts, label color conflicts, duplicate aliases, comment counts, attachment source URLs, batch sizes, and the loss report. It never includes ticket titles, descriptions, or comment bodies. The CSV and HTML reports follow the same rule; attachment source URLs are intentionally shown there as references.

Resolve any duplicate alias or `keep` numbering collision before importing. `keep` is the default when every source team key is `TAB` and none of the incoming issue numbers collide; otherwise the importer allocates new `TAB` keys in issue creation order. Estimates are stored in `tickets.estimate` when available. A Linear archived completed or canceled issue stays a normal Done or Cancelled ticket with `archived_at` unset. Only an archived issue that is neither completed nor canceled receives `archived_at`.

## Import and dual run

Run the first import only after reviewing the report. `--yes` is required for every write command. Supply the workspace owner email; the CLI checks the owner role and calls the same tracker access predicate used by app writes.

```sh
node scripts/linear-import.mjs import \
  --data-dir <data-dir> --snapshot ./linear-work/snapshot.json --out ./linear-work \
  --actor-email <owner-email> --numbering keep --yes
```

The importer commits batches of 100 issues. A failed batch rolls back as a unit and the result identifies its batch number; earlier committed batches stay intact. Re-running is idempotent. A write prints a reminder to stop the relay/use a restored copy and to take a backup first.

Keep Linear read-only for the agreed two-week dual-run. Compare source and Tabula counts, review unmatched users and losses with the owner, and spot-check at least 50 tickets, 20 comments, 10 relations, and every imported project and milestone. Record changes that must be mirrored. New work should be created in Tabula during the dual run.

## Final delta, verification, and cutover

Freeze Linear writes on the agreed date. Run the final delta from the last successful import cursor. The cursor is the snapshot fetch time and is written only after a successful import; delta fetches changed issues and comments with `updatedAt > since`, creates newly added issues, updates only selected fields, and appends comments idempotently.

```sh
node scripts/linear-import.mjs delta \
  --data-dir <data-dir> --out ./linear-work --actor-email <owner-email> --yes
```

For a fixture rehearsal, pass `--snapshot <snapshot.json>` to `delta`; no network request is made. By default, delta updates no existing ticket fields; select them explicitly with `--fields title,description,state,priority,assignee,labels,due`. A field changed in Tabula after import is reported as a conflict and left untouched. Delta also backfills projects, milestones, and relations if their target tables have since been added.

Fetch a final complete snapshot after the freeze, then verify that full snapshot:

```sh
node scripts/linear-import.mjs fetch --out ./linear-work/final
node scripts/linear-import.mjs verify \
  --data-dir <data-dir> --snapshot ./linear-work/final/snapshot.json
```

Verification compares issue and alias counts/uniqueness, comments, state distribution, parent links, labels, assignees, archived Done issues, relation samples when the table exists, and every project/milestone when the tables exist. It uses deterministic SHA-256 spot checks for ticket title/description/comment bodies but prints only check names, counts, and keys. Exit code `2` means a verification mismatch; investigate and rerun before cutover.

Archive the final source snapshot and its reports under the workspace backup policy. Keep `preserved.jsonl` with that archive; it contains only source aliases, IDs, keys, relations, estimate, and parent IDs. It contains no ticket titles, descriptions, or comments. Do not cancel Linear until the off-site backup restore drill and all section 9 go/no-go items pass. After approval, disable the Linear token/integration and update internal links.

## Flags and exit codes

| Flag | Use |
|---|---|
| `--data-dir <dir>` | Opens `<dir>/directory.sqlite` through `openDirectory`; required for dry-run, import, delta, and verify. |
| `--snapshot <file>` | Read a saved snapshot instead of fetching. Required for dry-run/import/verify; optional for delta. |
| `--out <dir>` | Output directory for snapshots, checkpoints, reports, and the preserved sidecar. |
| `--actor-email <email>` | Active workspace owner who authorizes writes. |
| `--numbering keep\|allocate` | Preserve eligible Linear numbers or allocate in creation order. |
| `--mode create\|update` | Create-only default, or explicitly update selected imported fields. |
| `--fields <list>` | Update fields: `title,description,state,priority,assignee,labels,due`. |
| `--since <ISO>` | Set the delta updatedAt cursor. Otherwise delta uses `last-success.json`. |
| `--yes` | Required for import and delta database writes. |
| `--max-issues <n>` | Rehearsal limit. A limited run does not advance the successful cursor. |
| `--record <dir>` | Record scrubbed GraphQL exchanges for fixture replay. |
| `--replay <dir>` | Use previously recorded GraphQL exchanges. |
| `--resume` | Resume an incomplete fetch from its private checkpoint and partial data. |

Exit codes: `0` means the command completed, `1` means a command/authorization/import failure or a refused write, and `2` means verification found a mismatch.

## Reading losses

The `lossReport` names affected Linear issue keys for data the current database cannot represent. Custom workflow state names are mapped to the default states and retained in the report. Estimates are retained in `tickets.estimate` where that column exists. Cycles are always reported as a loss (Tabula v1 has no cycles). Projects, milestones, and relations are written only when their target tables exist; otherwise their source IDs and relationships remain in `preserved.jsonl` for a later delta/backfill. Unsupported relation kinds become `relates_to` and are listed. Attachments remain source URLs; files and Linear permission semantics are not copied. Private teams, deleted comments, and unmatched users are counted. The current GraphQL snapshot does not fetch reactions, so that loss category is marked as not queried and its count is unknown. Unmatched users stay unassigned; the importer never invites them.

## Projects, milestones and relations (tracker slice 2)

The importer writes `projects`, `milestones` and `ticket_relations` directly, inside the batch transaction, and follows the rules of the command layer:

- Project states map to `planned`, `started`, `paused`, `completed` or `canceled`. A clash with an active project name (ignoring case) gets a numeric suffix. More than 200 active projects, or more than 50 active milestones in one project, are skipped and counted in the result (`projects.skippedProjects`, `projects.skippedMilestones`). A milestone without an imported project is skipped.
- A ticket keeps its milestone only when the milestone belongs to the ticket's project.
- Relations are stored one row per pair: `blocked` becomes `blocks` with the ends swapped, `duplicate` becomes `duplicates`, `related` and `similar` become one `relates_to` row. A `blocks` cycle or a ticket over its limit of 100 relations is skipped and counted (`relations.skippedCycle`, `relations.skippedLimit`).
- Cycles are never imported: Tabula v1 has no cycles. They stay in the loss report with the affected issue keys.
- If a table is missing (an older database), the data is listed in the loss report and kept in the local `preserved.jsonl`, and a later `delta` run writes it once the tables exist.

## First rehearsal (50 issues, scratch copy)

This is step 3 of `docs/tracker-dogfood-runbook.md`, in one place. Nothing here touches the live tabulahq volume or writes to Linear.

What you need before you start:

1. **A scratch copy of tabulahq's data.** Restore the pre-import volume snapshot to a scratch volume or a local folder (never the live volume), with the relay stopped. The importer opens `<data-dir>/directory.sqlite` directly. Take a second copy of the folder first, so a rehearsal can be repeated from a clean state.
2. **The Linear key in the environment only.** The operator puts `LINEAR_API_KEY` into the shell with `scripts/env-get.mjs` from the tabula-cloud repo (it prints nothing). It never goes in argv, a file in a repo, chat or a ticket, and it is unset after the fetch.
3. **The owner's email** on that copy (`--actor-email`). The importer refuses a user who is not an owner.
4. **Node 24.10 or newer** on the PATH, and the app's dependencies installed (the script imports from `server/`).

Steps:

1. Fetch once, with archived issues: `node scripts/linear-import.mjs fetch --out ./linear-rehearsal`. Check the count it prints: the total must include the archived Done issues (the dry-run report shows active and archived separately).
2. Dry run: `node scripts/linear-import.mjs dry-run --snapshot ./linear-rehearsal/snapshot.json --data-dir <scratch copy> --actor-email <owner> --max-issues 50 --out ./linear-rehearsal/report`. Read `report.html`: users matched by email, workflow states mapped, labels merged, the loss report with issue keys. Fix mappings before going on.
3. Import into the scratch copy: the same command with `import --yes`. It stops at the first failed batch and says which.
4. Verify: `node scripts/linear-import.mjs verify --snapshot ./linear-rehearsal/snapshot.json --data-dir <scratch copy> --max-issues 50` (`--max-issues` makes it compare the same 50 issues). `scripts/linear-verify.mjs <snapshot> <data-dir>` is the same check for a full import. Every check must pass; the output has counts and keys only, never titles or bodies.
5. Spot-check in the app against the scratch copy: 10 tickets by key (including an old `TAB-` number that must keep its number), 5 comments with authors and times, and any relations and projects.
6. Repeat step 3 on the same copy to confirm nothing is created twice (the second run must report 0 created).
7. Throw the scratch copy away. The real run starts again from a fresh snapshot (runbook step 4), with no `--max-issues`.

Stop and report, and do not start the real run, if verify fails, the archived count is zero, or more than a few users are unmatched.

