# Tracker architecture spec

**Status:** Draft for design and implementation planning
**Scope:** Architecture only. This file proposes no implementation changes.
**Decision labels:** **DECIDED** comes from Johan’s product brief. **RECOMMENDED** is this architecture’s recommendation. **OPEN** needs Johan’s decision. Unless marked otherwise, prescriptive proposals below are recommendations.

## Decisions (frozen 2026-10-10)

Johan: "go with your picks". These override any RECOMMENDED or OPEN text elsewhere in this file; sections 1 to 14 are updated only where noted.

| # | Decision | Effect on this spec |
|---|---|---|
| 1 | One workspace-wide prefix, `TAB`. | Section 2: no per-team or per-project prefixes. Open question 1 closed. |
| 2 | Default states: To do, In progress, In review, Done, Cancelled. Categories `completed` and `canceled`. | State keys `todo`, `in_progress`, `in_review`, `done`, `cancelled`; categories unstarted, started, started, completed, canceled. The Backlog state of earlier drafts is not seeded. |
| 3 | No cycles or estimates UI in v1. | The `estimate` column exists and is unused. Open question 7 closed. |
| 4 | Plain text titles, Markdown descriptions and comments. | No rich-text storage. |
| 5 | Tickets are created online only. | A create command needs a live connection to the server; the offline outbox queues edits to existing tickets only. Keys therefore have no gaps from abandoned offline creates. Section 3 offline row and section 2 gap rules apply to edits, not creates. |
| 6 | Archive only, never delete. | Open question 3 closed (soft archive, links kept). |
| 7 | Sign-in only, no public ticket links. | Deep links `/t/TAB-123` always require a session. No anonymous read. |
| 8 | A linked kanban shows the cards made on it; board guests get the ticket, with a warning when the audience is broader. | Section 4 rule stands. **Interpretation to confirm:** linking an existing kanban does not silently turn its old cards into tickets; the Link dialog offers "Create tickets for the N existing cards" (default yes), and cards created afterwards are tickets from the start. |
| 9 | GitHub App; only owners connect repos; GitHub logins are mapped to members after a one-time link; merge to Done is OFF by default, configurable per repo; comment-only by default. | Section 6b. Adds a `github_login` mapping per member (a row in the connection settings, or a `user_external_identities` table in slice 8). |
| 10 | Hosted: pending work runs on next wake for now, a control-plane tick later. Inbound webhooks: queue in the control plane, or wake through the edge only if that path is verified. | Section 6 option C now, B later. Section 6b: B unless I verify that the edge wakes a stopped machine and the app persists before returning 2xx. |
| 11 | Linear: import first, then a 2-week dual run. RPO 15 minutes, RTO 4 hours, restore drill before Linear is cancelled. A monotonic key floor in the control plane. | Sections 8 and 9. Open questions 4, 16 and 21 closed. The key floor is a control-plane table `workspace_key_floor(workspace_id, prefix, floor)` updated by the workspace on each allocation batch or daily; used at restore to set the counter to `max(restored, floor)`. |
| 12 | Theme: workspace theme, per-board override, then personal choice. The tracker follows its board. Owners and admins set the workspace theme. | Design-side. The tracker frame renders with its board's resolved theme. |

## 0. Summary, goals, non-goals, glossary, and picture

### Summary

- **DECIDED:** Replace Linear with a native Tabula tracker.
- **DECIDED:** Keep the existing canvas kanban model: a container, lanes, and cards on a board. Refine it rather than replacing it.
- **DECIDED:** Add a full tracker app inside a screen-sized frame object on the board. It is an object in the board document, not a route.
- **DECIDED:** The tracker has Inbox, My issues, All issues, Board, Projects, and Milestones views. A ticket page has comments, history, relations, and a deep link.
- **DECIDED:** Tickets, events, comments, search, saved views, and notifications live in the workspace SQL database, outside board Yjs documents.
- **DECIDED:** The server allocates human keys such as `TAB-123`. Every card on a linked kanban represents a ticket. One ticket may appear on more than one board.
- **DECIDED:** The tracker owns ticket state. Each linked kanban maps its lanes to tracker states. Moves in either place synchronize.
- **DECIDED:** The tracker ships in the AGPL open-source app. Hosted adds operational services such as backups and ticks. It does not gate tracker features.
- **RECOMMENDED:** Put tracker tables in `directory.sqlite`. This gives ticket creation, counters, aliases, users, and audit one SQLite transaction. It also places tracker records inside the existing directory database backup and restore path. A separate `tracker.sqlite` would create a cross-database consistency problem and require explicit backup/restore allow-list changes.
- **RECOMMENDED:** Treat the database as canonical. Yjs cards hold a projection and board-local layout only. A relay coordinator validates linked-card edits and updates the SQL ticket before publishing the matching card projection.
- **OPEN:** Hosted tick and webhook wake behavior needs an operational decision. A stopped machine cannot run its own timer.
### Goals

1. Give the workspace one canonical ticket record and one stable human key.
2. Keep kanban useful as a visual surface while making linked cards real ticket projections.
3. Preserve board role checks, MCP compatibility, backups, restore behavior, and the ability to self-host.
4. Make changes auditable and idempotent across browser reconnects, agents, GitHub deliveries, and restores.
5. Let future integrations implement a provider interface without adding provider-specific tables.
### Non-goals for v1

- No full project planning suite, sprint planning, capacity planning, or custom workflow builder UI.
- No private project ACLs in v1. Ticket visibility follows the workspace/linked-board rule in section 4.
- No automatic execution of ticket, comment, commit, webhook, or imported text.
- No outbound writes to GitHub in v1. GitHub is inbound only.
- No requirement to preserve every Linear-specific feature or attachment permission.
- No ticket content in board history snapshots. Board history restores the canvas projection; ticket history is the event log.
- No new hosted-only ticket API or database service.
### Glossary

| Term | Meaning |
|---|---|
| Ticket | The canonical SQL record for a unit of work. |
| Key | The immutable human-facing identifier, for example `TAB-123`. |
| Tracker frame | A screen-sized board object that opens the tracker UI in the canvas. |
| Linked kanban | A kanban object with a server-side mapping to a tracker workflow. |
| Projection | Ticket fields copied into a card so it can render without loading the full ticket. |
| Link | SQL association between one ticket and one card on one board/kanban. |
| State | A tracker workflow state. The ticket’s state is authoritative. |
| Lane mapping | A per-linked-kanban map from lane IDs to tracker state IDs. |
| Actor | A user, agent token, integration, or system process that caused a change. |
| Event sequence | The monotonically increasing committed event ID used for ordering writes. |
| Inbox event | A provider delivery received for later validation and processing. |
| Tick | A bounded server wake/run that processes due work such as notifications and retries. |
### One-page picture

    Browser / desktop
    ┌───────────────────────────────────────────────────────────────┐
    │ Board canvas: one Y.Doc per board                             │
    │                                                               │
    │  ┌───────────────────┐   ┌────────────────────────────────┐  │
    │  │ ordinary kanban   │   │ tracker frame object           │  │
    │  │ container         │   │ Inbox | My issues | All issues  │  │
    │  │ lanes + cards     │   │ Board | Projects | Milestones   │  │
    │  │                   │   │ ticket page / deep link          │  │
    │  └─────────┬─────────┘   └──────────────┬─────────────────┘  │
    └────────────┼────────────────────────────┼────────────────────┘
                 │ Yjs projection              │ tracker API / socket
                 ▼                             ▼
    ┌───────────────────────────────────────────────────────────────┐
    │ Relay (`server/relay.mjs`)                                    │
    │ auth + board access + linked-card guard + projection bridge   │
    │ MCP (`server/mcp.mjs`) uses the same planners and write path  │
    └──────────────────┬────────────────────────────────────────────┘
                       │ one SQLite transaction for ticket writes
                       ▼
    ┌───────────────────────────────────────────────────────────────┐
    │ `directory.sqlite`                                            │
    │ tickets / counters / states / links / comments / events       │
    │ FTS5 search / saved views / notification outbox                │
    │ integrations / inbound inbox / outbound webhook deliveries    │
    └──────────────────┬────────────────────────────────────────────┘
                       │
             ┌─────────┴──────────────┐
             ▼                        ▼
    `server/backup.mjs`         mailer / GitHub App / webhooks
    off-site encrypted copy    durable work; retry on tick or wake
             ▲                        ▲
             └──────── control plane ┘
                 wake/tick is an OPEN ops decision
**Existing implementation anchors:** the board is a Yjs room in `server/relay.mjs`; the SQL directory opens through `openDirectory` in `server/directory.mjs`; board card planners live in `server/board-ops.mjs`; client functions `addCard`, `moveCards`, and `editCards` live in `src/containers.ts`; layout is derived by `Store.containerLayout` in `src/store.ts` and `shared/containers.mjs`.

## 1. Data model and migrations

### Database choice

**RECOMMENDED:** Add tracker tables to `directory.sqlite`, which `server/directory.mjs` opens with `node:sqlite` `DatabaseSync`. `chat.sqlite` remains separate under `CHAT_MIGRATIONS` in `server/chat.mjs`; ticket records do not belong in chat tables such as `chat_messages`.

Reasons:
1. Ticket insert and `ticket_counters` increment can use the same `BEGIN IMMEDIATE` transaction exposed by `directory.transaction`.
2. User references can use the existing `users` table and foreign keys.
3. `directory.sqlite` is already copied by `server/backup.mjs` using `server/backup-copy-worker.mjs`.
4. `server/restore.mjs` already stages, validates, and swaps `directory.sqlite` with the workspace.
5. There is no cross-file transaction for `directory.sqlite`, `chat.sqlite`, and Yjs room files. A second tracker database would add a consistency boundary.

**Assumption:** One `directory.sqlite` belongs to one workspace. Check the hosted workspace provisioning model before implementation. If one database contains multiple workspaces, add `workspace_id` to every tracker key and uniqueness constraint before the first migration.

Do not put ticket records, comments, event bodies, connection secrets, or workflow state in board Yjs documents. A tracker frame may store only UI preferences such as selected view and panel size.
### Tables

Names below are proposed. Existing tables are identified where relevant. Integer times are Unix milliseconds, matching nearby tables.

| Table | Proposed columns and purpose |
|---|---|
| `tickets` | `id TEXT PRIMARY KEY` (internal random ID); `prefix TEXT NOT NULL`; `number INTEGER NOT NULL`; `key TEXT NOT NULL UNIQUE` (`TAB-123`); `title TEXT NOT NULL`; `description TEXT NOT NULL DEFAULT ''`; `state_id TEXT NOT NULL REFERENCES ticket_states(id) ON DELETE RESTRICT`; `tracker_id TEXT NOT NULL REFERENCES trackers(id)`; `priority INTEGER` (0 none, 1 urgent, 2 high, 3 medium, 4 low; the API speaks the names); `estimate REAL`; `parent_ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL`; `assignee_user_id TEXT REFERENCES users(id) ON DELETE SET NULL`; `project_id TEXT REFERENCES projects(id) ON DELETE SET NULL`; `milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL`; `due_date TEXT` (`YYYY-MM-DD`, a calendar date, no time zone); `archived_at INTEGER`; `created_at INTEGER NOT NULL`; `updated_at INTEGER NOT NULL`; `created_by_type TEXT NOT NULL`; `created_by_id TEXT`; `updated_seq INTEGER NOT NULL`; `source TEXT NOT NULL DEFAULT 'app'`; `UNIQUE(prefix,number)`. |
| `trackers` | `id TEXT PRIMARY KEY`; `name TEXT NOT NULL`; `prefix TEXT NOT NULL` (2 to 5 capitals); `created_at INTEGER NOT NULL`. One row per workspace in v1; the frame and cards carry `trackerId` so a second tracker needs no migration. A prefix rename inserts a `ticket_aliases` row (`provider='tabula'`) per old prefix so old keys keep resolving. |
| `ticket_external_links` | PR and commit records shown as `links[]` on a ticket: `id TEXT PRIMARY KEY`; `ticket_id TEXT REFERENCES tickets(id) ON DELETE RESTRICT`; `kind TEXT CHECK(kind IN ('pr','commit'))`; `provider TEXT NOT NULL`; `repo TEXT NOT NULL`; `number INTEGER`; `sha TEXT`; `title TEXT`; `state TEXT` (`draft|open|merged|closed`, pr only); `url TEXT NOT NULL`; `author_json TEXT`; `branch TEXT`; `at INTEGER`; `updated_at INTEGER NOT NULL`; unique `(ticket_id,provider,repo,kind,COALESCE(number,sha))`. Canvas-card links stay in `ticket_links`; the API merges both into one `links[]`. |
| `ticket_counters` | `scope TEXT NOT NULL` (the `trackers.id`); `prefix TEXT NOT NULL`; `next_number INTEGER NOT NULL CHECK(next_number > 0)`; `updated_at INTEGER NOT NULL`; `PRIMARY KEY(scope,prefix)`. |
| `ticket_field_versions` | `ticket_id TEXT REFERENCES tickets(id) ON DELETE CASCADE`; `field TEXT`; `event_seq INTEGER NOT NULL`; `actor_type TEXT`; `actor_id TEXT`; `PRIMARY KEY(ticket_id,field)`. Records server order for field-level last-writer-wins. |
| `ticket_states` | `id TEXT PRIMARY KEY`; `workflow_id TEXT NOT NULL REFERENCES ticket_workflows(id) ON DELETE RESTRICT`; `state_key TEXT NOT NULL`; `name TEXT NOT NULL`; `category TEXT NOT NULL CHECK(category IN ('backlog','unstarted','started','completed','canceled'))`; `position INTEGER NOT NULL`; `is_default INTEGER NOT NULL DEFAULT 0`; `archived_at INTEGER`; `created_at INTEGER NOT NULL`; unique `(workflow_id,state_key)`. |
| `ticket_workflows` | `id TEXT PRIMARY KEY`; `name TEXT NOT NULL`; `is_default INTEGER NOT NULL DEFAULT 0`; `version INTEGER NOT NULL DEFAULT 1`; `created_at INTEGER NOT NULL`; `updated_at INTEGER NOT NULL`. |
| `kanban_tracker_links` | `id TEXT PRIMARY KEY`; `board_id TEXT NOT NULL`; `kanban_id TEXT NOT NULL`; `workflow_id TEXT NOT NULL REFERENCES ticket_workflows(id)`; `created_at INTEGER NOT NULL`; `created_by TEXT`; `removed_at INTEGER`; unique active `(board_id,kanban_id)`. No FK to Yjs objects. |
| `kanban_state_mappings` | `kanban_link_id TEXT REFERENCES kanban_tracker_links(id) ON DELETE CASCADE`; `lane_id TEXT NOT NULL`; `state_id TEXT REFERENCES ticket_states(id) ON DELETE RESTRICT`; `created_at INTEGER NOT NULL`; `updated_at INTEGER NOT NULL`; `PRIMARY KEY(kanban_link_id,lane_id)`. |
| `ticket_links` | `id TEXT PRIMARY KEY`; `ticket_id TEXT REFERENCES tickets(id) ON DELETE RESTRICT`; `board_id TEXT NOT NULL`; `kanban_id TEXT NOT NULL`; `card_id TEXT NOT NULL`; `created_at INTEGER NOT NULL`; `created_by_type TEXT NOT NULL`; `created_by_id TEXT`; `removed_at INTEGER`; `last_projection_seq INTEGER NOT NULL DEFAULT 0`. One active link per board/kanban/card and one active card per ticket per kanban. |
| `ticket_projection_outbox` | `id INTEGER PRIMARY KEY AUTOINCREMENT`; `ticket_id TEXT REFERENCES tickets(id) ON DELETE RESTRICT`; `board_id TEXT NOT NULL`; `kanban_id TEXT NOT NULL`; `card_id TEXT NOT NULL`; `event_seq INTEGER NOT NULL`; `operation TEXT NOT NULL CHECK(operation IN ('upsert','remove'))`; `projection_json TEXT`; `created_at INTEGER NOT NULL`; `attempts INTEGER NOT NULL DEFAULT 0`; `next_attempt_at INTEGER NOT NULL`; `applied_at INTEGER`; `last_error_code TEXT`; unique `(board_id,kanban_id,card_id,event_seq)`. Durable SQL-to-Yjs projection work. |
| `ticket_labels` | `ticket_id TEXT REFERENCES tickets(id) ON DELETE CASCADE`; `label_id TEXT REFERENCES labels(id) ON DELETE RESTRICT`; `created_at INTEGER NOT NULL`; `PRIMARY KEY(ticket_id,label_id)`. |
| `labels` | `id TEXT PRIMARY KEY`; `name TEXT NOT NULL`; `color TEXT`; `created_at INTEGER NOT NULL`; `created_by TEXT`; `archived_at INTEGER`; unique active name, case-insensitive. |
| `projects` | `id TEXT PRIMARY KEY`; `name TEXT NOT NULL`; `description TEXT NOT NULL DEFAULT ''`; `state TEXT NOT NULL`; `owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL`; `created_at INTEGER NOT NULL`; `updated_at INTEGER NOT NULL`; `archived_at INTEGER`. |
| `milestones` | `id TEXT PRIMARY KEY`; `project_id TEXT REFERENCES projects(id) ON DELETE SET NULL`; `name TEXT NOT NULL`; `description TEXT NOT NULL DEFAULT ''`; `start_at INTEGER`; `due_at INTEGER`; `state TEXT NOT NULL`; `created_at INTEGER NOT NULL`; `updated_at INTEGER NOT NULL`; `archived_at INTEGER`. |
| `ticket_relations` | `id TEXT PRIMARY KEY`; `ticket_id TEXT REFERENCES tickets(id) ON DELETE RESTRICT`; `related_ticket_id TEXT REFERENCES tickets(id) ON DELETE RESTRICT`; `kind TEXT NOT NULL CHECK(kind IN ('blocks','blocked_by','relates_to','duplicates','duplicated_by','cloned_from'))`; `created_at INTEGER NOT NULL`; `created_by_type TEXT NOT NULL`; `created_by_id TEXT`; unique normalized relation; check `ticket_id <> related_ticket_id`. |
| `ticket_comments` | `id TEXT PRIMARY KEY`; `ticket_id TEXT REFERENCES tickets(id) ON DELETE RESTRICT`; `parent_id TEXT REFERENCES ticket_comments(id) ON DELETE SET NULL`; `actor_type TEXT NOT NULL`; `actor_id TEXT`; `author_snapshot TEXT NOT NULL`; `body TEXT NOT NULL`; `created_at INTEGER NOT NULL`; `edited_at INTEGER`; `deleted_at INTEGER`; `client_id TEXT`; unique `(actor_type,actor_id,client_id)` when `client_id` is non-null. |
| `ticket_events` | `id INTEGER PRIMARY KEY AUTOINCREMENT`; `ticket_id TEXT REFERENCES tickets(id) ON DELETE RESTRICT`; `event_type TEXT NOT NULL`; `schema_version INTEGER NOT NULL`; `actor_type TEXT NOT NULL`; `actor_id TEXT`; `source TEXT NOT NULL`; `idempotency_key TEXT`; `created_at INTEGER NOT NULL`; `before_json TEXT`; `after_json TEXT`; `details_json TEXT NOT NULL DEFAULT '{}'`; unique `(source,actor_type,actor_id,idempotency_key)` when key is non-null. Append through the application only. |
| `saved_views` | `id TEXT PRIMARY KEY`; `owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE`; `name TEXT NOT NULL`; `query_json TEXT NOT NULL`; `is_shared INTEGER NOT NULL DEFAULT 0`; `created_at INTEGER NOT NULL`; `updated_at INTEGER NOT NULL`. |
| `notifications` | `id TEXT PRIMARY KEY`; `user_id TEXT REFERENCES users(id) ON DELETE CASCADE`; `ticket_id TEXT REFERENCES tickets(id) ON DELETE CASCADE`; `event_id INTEGER REFERENCES ticket_events(id) ON DELETE CASCADE`; `kind TEXT NOT NULL`; `dedupe_key TEXT NOT NULL UNIQUE`; `created_at INTEGER NOT NULL`; `read_at INTEGER`; `emailed_at INTEGER`; `email_attempts INTEGER NOT NULL DEFAULT 0`; `next_email_at INTEGER`; `last_email_error_code TEXT`. Durable inbox/email-outbox row. |
| `ticket_subscriptions` | `ticket_id TEXT REFERENCES tickets(id) ON DELETE CASCADE`; `user_id TEXT REFERENCES users(id) ON DELETE CASCADE`; `reason TEXT NOT NULL`; `created_at INTEGER NOT NULL`; `PRIMARY KEY(ticket_id,user_id)`. |
| `ticket_aliases` | `id TEXT PRIMARY KEY`; `ticket_id TEXT REFERENCES tickets(id) ON DELETE CASCADE`; `provider TEXT NOT NULL`; `external_id TEXT NOT NULL`; `display_key TEXT`; `url TEXT`; `created_at INTEGER NOT NULL`; unique `(provider,external_id)`. Stores imported Linear IDs and future provider aliases. |
| `ticket_search` | FTS5 virtual table with `ticket_id UNINDEXED`, `title`, `description`, `comments`, `identifiers`, `aliases`. One row per active ticket. Maintained in the same SQL transaction as source changes. |
| `webhooks` | `id TEXT PRIMARY KEY`; `owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL`; `url TEXT NOT NULL`; `secret_ciphertext BLOB NOT NULL`; `secret_nonce BLOB NOT NULL`; `key_version INTEGER NOT NULL`; `event_filter_json TEXT NOT NULL`; `enabled INTEGER NOT NULL`; `created_at INTEGER NOT NULL`; `disabled_at INTEGER`. No plaintext signing secret. |
| `webhook_deliveries` | `id TEXT PRIMARY KEY`; `webhook_id TEXT REFERENCES webhooks(id) ON DELETE CASCADE`; `event_id INTEGER REFERENCES ticket_events(id) ON DELETE CASCADE`; `attempt INTEGER NOT NULL DEFAULT 0`; `next_attempt_at INTEGER NOT NULL`; `last_status INTEGER`; `last_error_code TEXT`; `delivered_at INTEGER`; `dead_at INTEGER`; unique `(webhook_id,event_id)`. |
| `integration_providers` | `provider TEXT PRIMARY KEY`; `schema_version INTEGER NOT NULL`; `enabled INTEGER NOT NULL`; `capabilities_json TEXT NOT NULL`; seed rows are `github` first; provider code remains authoritative. |
| `integration_connections` | `id TEXT PRIMARY KEY`; `provider TEXT REFERENCES integration_providers(provider)`; `owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL`; `status TEXT NOT NULL`; `scopes_json TEXT NOT NULL`; `external_installation_id TEXT`; `repo_allowlist_json TEXT NOT NULL`; `secret_ciphertext BLOB`; `secret_nonce BLOB`; `key_version INTEGER`; `settings_json TEXT NOT NULL`; `created_at INTEGER NOT NULL`; `updated_at INTEGER NOT NULL`; `last_event_at INTEGER`; `last_error_code TEXT`; `disconnected_at INTEGER`. |
| `integration_events` | Inbox rows: `id TEXT PRIMARY KEY`; `connection_id TEXT REFERENCES integration_connections(id) ON DELETE CASCADE`; `provider_delivery_id TEXT NOT NULL`; `event_type TEXT NOT NULL`; `received_at INTEGER NOT NULL`; `payload_hash TEXT NOT NULL`; `payload_json TEXT`; `status TEXT NOT NULL`; `attempts INTEGER NOT NULL DEFAULT 0`; `next_attempt_at INTEGER`; `processed_at INTEGER`; `dead_at INTEGER`; `error_code TEXT`; unique `(connection_id,provider_delivery_id)`. Retain normalized bounded data only. |
| `integration_event_mappings` | `id TEXT PRIMARY KEY`; `provider TEXT NOT NULL REFERENCES integration_providers(provider)`; `event_type TEXT NOT NULL`; `rule_key TEXT NOT NULL`; `action TEXT NOT NULL`; `settings_json TEXT NOT NULL`; `enabled INTEGER NOT NULL`; unique `(provider,event_type,rule_key)`. Holds configurable provider-event-to-ticket rules. |
| `integration_audit` | `id INTEGER PRIMARY KEY AUTOINCREMENT`; `connection_id TEXT`; `actor_type TEXT NOT NULL`; `actor_id TEXT`; `action TEXT NOT NULL`; `created_at INTEGER NOT NULL`; `detail_json TEXT NOT NULL DEFAULT '{}'`. Redact secrets and ticket body text. |
### Indexes and constraints

Add indexes with the new tables in the same migration:
- Ticket list indexes: `tickets(state_id,updated_at DESC)`, `tickets(assignee_user_id,state_id,updated_at DESC)`, `tickets(project_id,milestone_id,state_id)`, and partial `tickets(due_date)` for active tickets.
- Activity/link indexes: `ticket_events(ticket_id,id DESC)`, `ticket_events(id DESC)`, `ticket_comments(ticket_id,created_at,id)`, `ticket_comments(parent_id,created_at)`, `ticket_links(ticket_id,removed_at)`, `ticket_links(board_id,kanban_id,removed_at)`, and pending `ticket_projection_outbox(applied_at,next_attempt_at)`.
- Mapping/access indexes: partial unique active `ticket_links(board_id,kanban_id,card_id)` and `(kanban_id,ticket_id)`; `kanban_tracker_links(board_id,kanban_id)` for active links; `kanban_state_mappings(state_id)`; unique `ticket_aliases(provider,external_id)`; `ticket_subscriptions(user_id,ticket_id)`.
- Delivery indexes: `notifications(user_id,read_at,created_at DESC)` and unique `(user_id,dedupe_key)`; pending `webhook_deliveries(next_attempt_at)`; `integration_events(status,received_at)` and unique provider delivery per connection; `integration_connections(provider,status)`.

Use `ON DELETE RESTRICT` for tickets, states, and relation targets. V1 uses archive/soft-delete semantics, so deleting a ticket row is exceptional maintenance, not a user action. A state with tickets cannot be deleted until those tickets move elsewhere. A project or milestone cannot be hard-deleted while referenced; archive it instead. Board and Yjs object IDs are application-managed strings, not foreign keys, because board content is in a separate document.
### Migration generation and reader rules

The current checkout has 11 directory migrations and 1 chat migration. `server/schema.mjs` defines a string entry as expand-only with `min_reader = n - 1`; entries that break old readers use `{ sql, minReader }`. `migrate()` applies each entry inside its own `BEGIN IMMEDIATE` transaction, and `readSchemaState()` refuses a database whose `min_reader` is newer than the running build.
- **RECOMMENDED:** Add tracker schema as migration 12 in `server/directory.mjs:MIGRATIONS`.
- Keep migration 12 expand-only: new tables, nullable/defaulted columns, and non-unique indexes. Do not rewrite existing rows, add restrictive triggers, or drop/rename anything.
- Do not add a unique index over old data until a separate migration has checked and repaired duplicates.
- The event table is append-only by application contract. Do not add a trigger that prevents maintenance/retention before that policy is chosen.
- `scripts/release-info.mjs` will report directory schema 12, chat schema 1, and `maxReader` 11 when migration 12 is a plain string. Confirm by inspecting `npm run release-info` before publishing.
- The hosted release figures supplied for planning are v4: directory 10/chat 1 and v5: directory 11/chat 1. A v5 reader can open schema 12 under this expand-only rule. A v4 reader cannot. Do not apply migration 12 to a hosted volume while v4 can still be rolled back to that volume.
- The control plane should compare live `build.schema`, `build.maxReader`, and database `disk.schema`/`disk.minReader` from `GET /api/internal/version` before rolling an image back. See `docs/migrations.md` and `docs/cloud.md`.
- A self-hosted upgrade backs up first, starts the new binary, and applies migration 12 once. Each migration has its own transaction. The old binary remains a valid rollback only if its generation is at least the resulting `min_reader`.
- **Assumption:** Hosted v4/v5 schema figures are the release sequence to protect, not necessarily the current deployed fleet. Check the control plane’s live-release inventory before scheduling migration 12.

`ticket_search` is a new virtual table. **Assumption:** FTS5 is available in the shipped Node 26 Alpine image. The current workstation’s Node 24.10 `node:sqlite` accepted `CREATE VIRTUAL TABLE ... USING fts5`; verify in the Docker image before migration 12 ships. If it is absent, fail the capability check and decide on a supported SQLite build rather than silently degrading search.

## 2. ID allocation

### Canonical key

**RECOMMENDED:** Use one monotonically increasing counter per workspace with a workspace prefix:

    TAB-1, TAB-2, TAB-3, ...
The internal random `tickets.id` is the stable relational ID. The `tickets.key` is immutable, unique, and safe to show in cards, search, notifications, and links.
### Transaction

Create a ticket in one `directory.transaction()`:
1. Read `ticket_counters` for `(scope='workspace',prefix='TAB')`.
2. If absent, insert it with `next_number=1`.
3. Reserve `n=next_number`, then advance `next_number=n+1`.
4. Insert `tickets` with `prefix='TAB'`, `number=n`, and `key='TAB-' || n`.
5. Insert the initial `ticket_events` row and `ticket_search` row.
6. Commit. Any failure before commit rolls back both the counter and the ticket.

Use the directory transaction’s `BEGIN IMMEDIATE` behavior. Two simultaneous creates serialize at the database. Do not allocate in a browser, MCP client, importer, board document, or process-local counter.
### Gaps and reuse

- A committed key is never reused, even if the ticket is archived or later removed by repair. A transaction rollback does not consume a number. V1 has no separate reservation endpoint, so failures should not create avoidable gaps.
- A crash after commit but before response may leave a ticket the client did not see; retrying the same idempotency key returns it. A key may be skipped only by an explicitly committed reservation.
- Restore returns the counter to the restored snapshot. Compare it with the highest key in every surviving backup/import before reopening writes. A restore that loses a post-backup ticket also loses evidence of its allocated key; strict non-reuse across that lost tail needs a monotonic external key floor or a new prefix epoch. Keep the workspace read-only until that floor is known. If it cannot be proven, an owner must start a new prefix epoch before writes resume.
- Board duplication, card copy/paste, and template instantiation never reuse a key. Templates strip live tracker identity; instantiating one into a linked kanban creates a new ticket per card. An explicit ticket duplicate may add a `cloned_from` relation.
- Import uses old Linear identifiers as aliases. Imported ticket canonical keys are allocated from `TAB-...`; old identifiers remain searchable.
### Prefix scope options

| Option | Recommendation | Cost |
|---|---|---|
| Workspace prefix, one counter | **RECOMMENDED** | IDs stay short and unique across teams/projects; no rename or merge collision handling. |
| Per-team prefix | OPEN, defer | Requires stable team key, one counter per team, team rename rules, and collision handling when a ticket moves teams. |
| Per-project prefix | OPEN, defer | A ticket without a project has no prefix; moving projects changes where new IDs come from; archived projects retain counters. |
Do not encode state, team, project, or year in the key. Those values change. The open question is whether the single visible prefix should be configurable per workspace, not whether the numeric identity is server allocated.

## 3. Sync protocol: linked canvas cards and tickets

### Ownership and projection

The board stores a Yjs document. The canonical ticket and mapping live in SQL. The current kanban implementation stores cards as objects in the `objects` Y.Map and derives card order from `parent` and fractional `rank`; see `docs/kanban.md`, `src/containers.ts`, `Store.containerLayout` in `src/store.ts`, and `shared/containers.mjs`. Existing `STAGES` and `DEFAULT_KANBAN_LANES` map by default: todo → unstarted, doing → started, done → completed.

**RECOMMENDED (reconciled with `docs/tracker-ux.md` §2.3):** A linked card carries identity in the flat ext fields that `docs/kanban.md` already reserves: `extProvider:'tabula'`, `extKey` (`TAB-123`), `extUrl` (derived by the server, never trusted from a client) and `trackerId`. The linked container carries `ext:{provider:'tabula', tracker, map}`. The authoritative lane map is `kanban_state_mappings` in SQL; `ext.map` is a server-written copy for rendering and offline display, and the guard rejects client edits to it. Everything else is a compact, server-written `tracker` projection object on the card:

| Card projection field | Source of truth | Editable from linked card? |
|---|---|---|
| `ticketId` | `tickets.id` | No |
| `ticketKey` (also `extKey`) | `tickets.key` | No |
| `title` snapshot | `tickets.title` | Yes, through a server command |
| `state` (`id`, `key`, `name`, `category`) | `tickets.state_id` | No direct field edit; lane move requests a state transition |
| `assignee` (`userId`, display name) | `tickets.assignee_user_id` | Yes, through a server command |
| `labels` (`id`, `name`, color) | `ticket_labels` + `labels` | Yes, through a server command |
| `priority` | `tickets.priority` | Yes, through a server command |
| `due` | `tickets.due_date` | Yes, through a server command |
| `projectionSeq` | last applied `ticket_events.id` | No |
The card’s existing `text`/`desc` fields remain ordinary unlinked-card fields. On a linked card, title edits go to `tickets.title`; `desc` is not a ticket description. Description, comments, relations, project metadata, event history, saved views, and secrets are **not** copied into Yjs.

**RECOMMENDED:** A linked card UI shows the title and projection fields above. The tracker frame loads ticket details from the tracker API. The projection is a display and offline cache, never an authorization credential.
### Link record and lane mapping

`ticket_links` identifies one projection: `(board_id, kanban_id, card_id, ticket_id)`. `kanban_tracker_links` binds one kanban container to a workflow. `kanban_state_mappings` maps stable lane IDs to stable state IDs. Names are not keys.
- Lane rename keeps the map because the lane ID is stable.
- State rename keeps the map because the state ID is stable. Update card snapshots.
- Lane reorder does not change the mapping.
- A lane with no map cannot accept a linked ticket move or ticket creation. The UI explains “Map this lane to a tracker state.”
- A state with no lane on one board remains a valid tracker state. On that board, its card stays in its last mapped lane and displays the current state badge with an “Unmapped state” marker.
- One state may map to no more than one lane per linked kanban. Multiple lanes may not map to the same state in v1; otherwise moving a ticket from the state cannot choose a unique lane.
- A mapping change updates only projection placement. It does not change ticket state or history.
### Who writes what

| Action | Writer | Result |
|---|---|---|
| Create a card in a linked kanban | Relay tracker coordinator | Allocate ticket ID/key in SQL, create initial event, create Yjs card through `server/board-ops.mjs`, add link, write projection. |
| Edit linked-card title/assignee/labels/priority/due | Relay tracker coordinator | Validate board editor role; update ticket and event in SQL; update the projection in the same coordinated command. |
| Move a linked card to another mapped lane | Relay tracker coordinator | Resolve lane to state; transition ticket; project the state and all linked cards. |
| Edit description, comments, project, relation, workflow state in tracker | Tracker route/service in relay | Commit SQL mutation and event; update affected projections. |
| Reorder linked card within the same lane | Board planner | Change only `parent`/`rank`; no ticket event. |
| Edit or move ordinary unlinked card | Existing client/board path | Keep current `src/containers.ts` and `server/board-ops.mjs` behavior. |
| Write from MCP | `server/mcp.mjs` tool handler and shared planner | Use the same validation and SQL/Yjs coordinator as the UI. |
### Relay bridge and idempotency

The current `Room.onMessage` in `server/relay.mjs` accepts board Yjs updates and broadcasts them. `Room` schedules persistence with `SAVE_DEBOUNCE_MS`; ordinary board writes are not field-authorized. The comments room has a relay guard in `server/comment-authz.mjs` that mirrors, checks, and corrects disallowed updates.

Linked cards need a similar server-side guard:
1. The client sends a command with `commandId`, target board/kanban/card, changed fields, and an optional `expectedSeq`.
2. The relay checks session, board role, cloud read-only state, link ownership, field validation, and lane mapping.
3. A single coordinator serializes the command. In one directory transaction it inserts the event, updates ticket fields and field versions, allocates any new card ID, and records the desired projection in a durable outbox. Commit SQL before touching the shared Yjs room.
4. After commit, the coordinator applies the card mutation through `server/board-ops.mjs`’s pure planner and `applyPlan`, inside the existing `roomAccess.write`/Yjs transaction. Hold the outbound board update until the planner succeeds.
5. Mark `projectionSeq` and `ticket_links.last_projection_seq` applied, then broadcast. If the room write fails, leave the outbox pending and return the committed SQL result with `projectionPending=true`.
6. Retries with the same `commandId` return the committed result. Yjs updates tagged with origin `tracker-sync:<eventSeq>` are recognized as server projections and do not create a second ticket event.
7. The relay observer watches Yjs transactions for linked-card add/delete/move/title-field changes. It buffers those updates until the coordinator has validated or repaired them. It is a compatibility and repair path, not a second writer.

**RECOMMENDED:** Add an explicit linked-card command path before permitting arbitrary remote Yjs edits to `tracker` fields. A client-side-only convention is insufficient because `Room.onMessage` accepts remote Yjs updates. Model the guard on `comment-authz.mjs`; do not let the observer publish a forged `ticketId` or `state`.

**Assumption:** The relay can buffer a board update until the coordinator finishes applying the SQL-backed intent and Yjs projection. Check current `Room.onMessage` broadcast ordering and Yjs update lifecycle before choosing the exact hook.

Debounce and batching:
- Coalesce repeated title keystrokes from one client for 300 ms, but send a commit on blur, Enter, or before navigation.
- Batch one user gesture’s multi-card move in one SQL transaction and one board Yjs transaction. SQL commits first; a durable projection outbox bridges the two stores.
- Do not debounce state transitions beyond the command boundary. Every accepted transition has one event and sequence.
- Room file persistence may retain the existing 1-second debounce. That persistence debounce must not delay SQL commit, authorization, notification outbox creation, or projection broadcast.
### Sequence diagrams

**Tracker edit**

    Client       Relay coordinator       directory.sqlite       Yjs Room
      | PATCH commandId=abc  |                  |                   |
      |--------------------->| check role/link  |                   |
      |                      | BEGIN; ticket + event + outbox       |
      |                      |----------------->|                   |
      |                      | COMMIT seq=941   |                   |
      |                      |----------------->|                   |
      |                      | applyPlan projection                 |
      |                      |------------------------------------->|
      |                      | mark outbox applied                  |
      |<---------------------| ack seq=941; broadcast Yjs update    |
      |                      | observer sees origin tracker-sync    |
**Lane move from a board**

    Editor       Relay              SQL                 Board A / B
      | move card to lane L3         |                       |
      |---------------->| lane L3 -> state S2                |
      |                 | BEGIN; state + event + outbox      |
      |                 | COMMIT seq=942                      |
      |                 |------------------------------------>|
      |                 | project each active link            |
      |                 |------------------------------------>|
      |<----------------| ack seq=942; boards render S2       |
**Offline command replay**

    Browser IndexedDB outbox      Relay                     SQL
      | title="fix login", id=x    |                         |
      | offline; show pending      |                         |
      | reconnect, send id=x       |                         |
      |-------------------------->| validate current ticket  |
      |                           | if x exists: return result|
      |                           | else commit event seq=943|
      |                           |------------------------->|
      |<--------------------------| ack; replace optimistic projection
### Conflict rule

- **DECIDED:** A same-field conflict is field-level last-writer-wins by server sequence.
- **RECOMMENDED:** Every accepted mutation gets a committed `ticket_events.id`; update `ticket_field_versions` for each changed field in the same transaction.
- A stale client command is ordered when the relay accepts and commits it. The last committed command for `title` wins even if its local edit began earlier.
- Different fields do not overwrite each other. A title edit and due-date edit merge.
- **DECIDED:** State is tracker-owned. A lane move requests a state transition; a client cannot directly write the projected state object.
- A stale state command is resolved against the current state and the requested lane mapping. If still valid, it receives a later sequence and wins. If the state or mapping was removed, return `conflict` with the current state and mapping version.
### Failure matrix

| Failure | Required result |
|---|---|
| Browser edits an existing linked card offline, then reconnects | Keep optimistic local display. Queue commands with stable `commandId`. Relay applies them in receive/commit order. Repeated IDs return the same result. If the lane mapping is gone, reject that move and show current state plus a repair action. |
| Same field edited in canvas and tracker | Example: tracker title commit gets seq 100, canvas command gets seq 101. Seq 101 wins. Both clients receive the seq 101 projection. |
| Canvas lane move races with tracker transition | Both become serialized state commands. The later accepted command wins if its target state remains valid. State never comes from a raw Yjs field. |
| Card deleted on canvas | Remove that `ticket_links` row for this board/kanban. Ticket, comments, event history, and links on other boards stay. Card deletion is not ticket deletion. |
| User deletes a ticket | Use explicit tracker “Archive ticket” action. Set `archived_at`, append an event, remove it from ordinary views, and project an archived marker to all linked cards. Keep links for restore/audit until the user explicitly removes them. |
| Card is copied/pasted or duplicated inside a linked kanban | The new card is a new ticket with a new key. The coordinator strips any copied `ticketId`, creates a new ticket, and may add `cloned_from`. It never silently makes a second card for the same ticket in the same kanban. |
| Whole board is duplicated | Create a new board and new ticket records for its linked cards, with new keys and `cloned_from` relations. Re-key every `ticket_links` row to the new board/card IDs. Never let both boards claim the old link row. |
| Board restored as a copy by `restoreBoardCopy` | This creates a new board ID. **RECOMMENDED:** strip tracker identities and restore it as a detached snapshot; offer “Copy linked tickets too” to allocate new tickets/keys/links. Never reuse the old board’s link rows. |
| Same board restored from history | `server/history.mjs` stores Yjs snapshots; `src/history.ts:planRestore`/`applyRestore` applies them, not SQL ticket changes. Retain links only where the original card ID still exists and matches the same ticket. Missing cards unlink. Never bind an old snapshot’s card to another ticket. Run projection repair after restore. |
| Kanban is unlinked | Remove active `kanban_tracker_links`, `kanban_state_mappings`, and `ticket_links` rows for that kanban. Copy each latest ticket title into card `text`, keep its lane, strip tracker IDs/badges, and leave tickets intact. |
| A mapped lane is deleted | Refuse until the owner/editor maps its tickets to another lane or confirms the kanban unlink. Preserve every ticket state. This is stricter than current `planKanbanDelete`, which can move or delete cards. |
| A tracker state is deleted | Refuse while tickets or lane mappings refer to it. Move tickets and mappings first, then archive the state. Never cascade-delete tickets. |
| Ticket moves to a state with no lane on one board | Keep the card in its last mapped lane and show the actual tracker state plus “Unmapped state.” Do not move it to an arbitrary lane. |
| Board is deleted | Remove its active link and lane mapping rows. Tickets stay in the workspace and other board projections remain. The board delete is not a ticket archive. |
| One ticket appears on several boards and moves on one | SQL state changes once. Relay projects the new state to every active link. Each board uses its own lane mapping. |
| Two clients move the same ticket at once | Relay serializes commands. If both mappings remain valid, the second committed event wins and all projections converge. If the second targets a removed mapping, reject it. |
| Read-only viewer tries to edit or move a linked card | Reject at relay and return `read_only`/`forbidden`; do not accept a Yjs projection update. The viewer may see only what board/ticket access permits. |
| SQL commit succeeds but room projection fails | Keep the event and a durable projection-pending row. Retry on room load or next tick. Return the committed ticket result with `projectionPending=true`; do not roll back committed SQL. |
| Yjs update arrives with a forged `ticketId` | Buffer, reject/repair through the linked-card guard, and audit the actor and board without logging ticket text. |
| Relay process stops after SQL commit | Projection outbox remains in `directory.sqlite`. Reapply idempotently after room reopen. |
| Relay process stops before SQL commit | Transaction rolls back. No key is consumed and no projection is published. |
### One card mutation path

`server/board-ops.mjs` already exposes pure planners such as `planCreateKanban`, `planAddKanbanLane`, `planUpdateKanbanLane`, `planDeleteKanbanLane`, `planCreate`, `planUpdate`, `planDelete`, and `applyPlan`. `server/mcp.mjs` uses those planners through its `boardPlan` write path. The client currently mutates kanban card fields in `src/containers.ts` through `Store.transact`.

**RECOMMENDED:**
- Extend the board planner with linked-card create/update/move/delete plans. Keep planning pure and validation in one place.
- Have the tracker coordinator call the planner and `applyPlan`, as `server/mcp.mjs` does today.
- Route linked-card UI mutations and new ticket MCP mutations through the relay coordinator. Keep direct `Store.transact` for ordinary unlinked cards.
- Do not create a second independent “tracker card writer” in the UI, a webhook handler, or MCP.
- Keep `list_kanban_cards` and the existing kanban tools working. They read projections from the board, but write tools delegate linked-card mutations to the coordinator.
### Invariants tests must assert

Assert together that each active link points to one ticket, a ticket has at most one card per linked kanban but may appear on multiple boards, and every card’s `ticketId` matches SQL. Raw Yjs cannot change `ticketId`, `ticketKey`, or `state`. Each accepted ticket field change has exactly one event/sequence. Duplicate `commandId` or provider delivery IDs create no duplicate effect. A state move projects everywhere or leaves durable repair work. Card deletion unlinks one card; archive is explicit and projects to every link. Copies use new IDs/keys. Every write rechecks board/token access. Repairs are idempotent. Lane/state deletion cannot strand tickets. Read-only limits disable writes and mutating outboxes. History/board-copy restore cannot bind one card ID to two tickets.

## 4. Permissions

### Two access layers

Existing browser session and CSRF checks come from `createAuth` and `csrfOk` in `server/auth.mjs`. Board access is resolved by `directory.boardRole` and `boardFor` in `server/api.mjs`. `canWriteRoom` in `server/relay.mjs` permits board owner/editor writes; comment rooms also allow commenters. `server/tokens.mjs` stores token hashes, and `server/mcp.mjs` rechecks board role and token scope. These are the base checks.

**RECOMMENDED visibility model for v1:**
- A workspace owner, admin, or member with tracker access can open and search all workspace tickets, including tickets with no linked board.
- A board guest or external viewer can see a ticket if they can read at least one board on which that ticket has an active link.
- A board-only user’s access to the ticket page follows that same rule. There is no separate per-project restriction in v1.
- Board-only users can read the full ticket, including comments and history, when they can read a linked board. This rule is simple but has a deliberate consequence: linking a ticket onto a board grants that board’s readers access to the full ticket.
- Linking a ticket to a more widely shared board is a visibility change. Show confirmation to an editor when the new board audience is broader than the ticket’s current accessible audience.
- Project-level ACLs may narrow this later. They must not silently widen board access.

Board owner/editor/viewer and commenter access continues to come from `directory.boardRole` and existing board share/team rules. `server/join-codes.mjs:createJoinCodeService` creates a guest session for one board; a join code grants no separate workspace tracker role. **Assumption:** Confirm the exact guest role returned by `directory.createGuestSession` before implementing `ticketAccess`.
### Authorization rule

Implement one pure access function, proposed as `ticketAccess(actor,ticket)`, analogous in shape to the authorization logic in `server/comment-authz.mjs`:
1. Disabled or unauthenticated actor: no access.
2. Workspace owner/admin/member with tracker access: read all tickets; writes depend on workspace role and normal board policy.
3. Board-only actor: read a ticket only if `directory.boardRole(board_id, actor.id)` grants read access to at least one active linked board.
4. Board-only editor: may edit ticket fields only through a linked card on a board they can edit, and only fields supported by card commands. Tracker-only fields such as description, comments, relations, project, and workflow require tracker membership or an explicit broader permission.
5. Commenter: can add a ticket comment only if the ticket is visible and comment rights are granted. This follows the existing separation in `server/comment-authz.mjs`, where comments use a distinct room authorization.
6. Viewer: can read; cannot transition, comment, subscribe on behalf of another user, or mutate a link.
7. Archived or deleted board: grants no ticket access through that board. `boardFor` already returns not-found for deleted boards.
8. MCP actor: apply the token’s ticket scope and the represented user’s current access. A token never elevates its owner.
9. Integration actor: can create only the configured activity/comment/transition types for tickets matched by its connection. It cannot search or enumerate the workspace.
10. System actor: only explicit system jobs, with a fixed allow-list of event types.

Return `404` for inaccessible ticket IDs in direct get/deep-link calls, matching the existing anti-enumeration behavior documented in `docs/mcp.md`. Return `forbidden` only after a visible object has been identified.
### Leak risks and controls

| Surface | Leak | Control |
|---|---|---|
| Card projection | `TAB-123`, title, state, assignee, labels, priority, and due date can be read by anyone who can read that board. | This is intentional projection content. Require confirmation when linking to a broader audience. Never project description or comments. |
| Search and saved views | An unfiltered FTS match can reveal existence or snippets. | Add visibility predicates before returning counts, snippets, highlights, or pagination cursors. Do not return total hits for inaccessible tickets. |
| Notifications | A recipient may no longer have access after a board share changes. | Recheck visibility when listing and opening a notification; suppress or delete stale notifications. |
| Webhooks | Full ticket body can leave the workspace. | Owners only create them. Scope fields/event types. Document payload contents and allow secret rotation and disable. |
| MCP list/search | Tool results can expose tickets the represented user cannot see. | Use the same `ticketAccess` predicate for list, search, get, and saved views. Never trust a prompt-supplied board ID. |
| Deep links | Guessable keys expose ticket details if route checks only the key. | Resolve key, then apply `ticketAccess` before returning any ticket fields. |
| History/activity | Event `before_json`/`after_json` can expose previous descriptions or assignees. | Authorize before reading events; omit secrets and never store provider tokens in event JSON. |
| GitHub comments | PR titles and bodies may contain sensitive or untrusted text. | Treat as data. Apply ticket visibility to each comment/activity response. Ignore untrusted forks unless allowed by repository rules. |
### Comments and audit actors

Ticket comments are SQL rows in `ticket_comments`, not Yjs threads in `<boardId>~comments`. Reuse the principles in `server/comment-authz.mjs`: check at write time, preserve a stable author snapshot, do not let a user forge author identity, and correct/reject disallowed updates before they broadcast.

Agents and integrations are first-class actors:
- `actor_type` is `user`, `mcp_token`, `integration`, or `system`.
- `actor_id` is the user/token/connection identifier, nullable only for a system actor.
- Each token has an owner user and a token ID; audit both.
- Apply rate limits per token, per integration connection, and per user. Existing MCP limits in `server/mcp.mjs` are in-memory; durable ticket write limits should not depend on a single relay process.
- Add a rate-limit and actor-type field to the event audit. Do not store secret values or full prompt context.

## 5. Search index

### Engine and maintenance

The app uses `node:sqlite` `DatabaseSync` in `server/directory.mjs`; there is no `better-sqlite3` dependency in `package.json`. A runtime probe against this workstation’s Node 24.10 SQLite accepted FTS5. The `Dockerfile` currently builds and runs `node:26-alpine`.

**RECOMMENDED:** Use an FTS5 virtual table in `directory.sqlite` with tokenizer `unicode61 remove_diacritics 2`. Verify FTS5 in the Docker runtime before shipping. Do not rely on a workstation-only probe.

Index:

Index title, description, comment bodies subject to deletion policy, canonical `TAB-123` key, and aliases including Linear IDs. Never index private connection secrets, email addresses, notification payloads, access tokens, webhook URLs, or raw integration payloads. A public PR title/link is indexed only after it is deliberately posted as ticket activity.

Maintain `ticket_search` in the same `directory.transaction` that changes the ticket, comment, alias, or archive state. For comments, rebuild the combined comments field for that ticket within a bounded transaction. When a comment is erased, remove it from the FTS field in the same transaction. Archived tickets are excluded by default but can be searched with an explicit archived filter.
### Query behavior

Parse filters before building an FTS query. Never pass an untrusted filter string directly as SQL or raw FTS syntax.

Filter grammar:

| Filter | Meaning |
|---|---|
| `state:<key-or-name>`, `label:<name>` | Match states and labels by key/name, case-insensitively. |
| `assignee:me`, `assignee:<member name/email>`, `assignee:none` | Match the actor, a member, or no assignee. |
| `creator:me`, `creator:<member name/email>` | Match tickets created directly by that user; token-created tickets do not count as their owner's. |
| `creator:agent`, `creator:integration`, `creator:import`, `creator:system` | Match the creator type; imports include source `linear-import` or `created_by_type = 'import'`. |
| `priority:none|urgent|high|medium|low` | Match priority names stored as 0 through 4. |
| `category:backlog|unstarted|started|completed|canceled` | Match the state's category. |
| `project:<name>`, `milestone:<name>`, `project:none`, `milestone:none` | Match case-insensitive names or missing associations; named filters include archived rows, repeated milestone names match across projects, and unknown names are invalid. |
| `due:overdue`, `due:today`, `due:before-DATE`, `due:after-DATE`, `due:none`, `due:this-week` | Match due dates; today and this week use UTC, with the week Monday through Sunday. `after` includes the date. |
| `created:after-DATE`, `created:before-DATE`, `updated:after-DATE`, `updated:before-DATE` | Compare timestamps at UTC midnight; `after` includes that date and `before` is exclusive. |
| `is:blocked`, `is:blocking` | Match an incoming block from an open ticket, or an outgoing block to an open ticket. Open excludes categories `completed` and `canceled`. |
| `has:relation`, `has:parent`, `has:sub` | Match any relation, a direct parent, or direct children. |
| `parent:TAB-12`, `blocks:TAB-12`, `blocked-by:TAB-12` | Match direct children, blockers, or blocked tickets for the named key. |
| `relates:TAB-12`, `duplicates:TAB-12`, `duplicated-by:TAB-12` | Match the symmetric relation or the directed duplicate relation. |
| `has:link` | Always false until tracker slice 4 adds links. |
| `is:archived` | Include archived tickets; they are excluded by default. |

**Slice 2 decisions:** Prefix any token with `-` to negate it; comma-separated any-of values are supported for state, label, assignee, creator, priority, category, project and milestone, and `-` makes those lists none-of. Lists have at most 20 values, tokens at most 20 per call, and commas always separate values, so filter names cannot contain commas. Negation includes tickets where the field is unset. Dates must be calendar-valid `YYYY-MM-DD`; timestamp `after` includes UTC midnight on the date and `before` is exclusive. Project/milestone names and relation keys are case-insensitive; unknown names and missing or inaccessible relation keys return `invalid_filter` naming the token. Filter values stay parameterized SQL values, and FTS syntax is unchanged. Saved views validate this exact grammar. `has:link` stays false in this slice.

- Search body limit: 512 Unicode code points; filter count limit: 20; saved query JSON limit: 8 KB.
- Return at most 50 rows per page; use keyset pagination on rank bucket, `updated_at`, and `tickets.id`, not SQL `OFFSET`.
- Rank exact key/alias match first, title prefix second, title token match third, description/comment match after that. Use deterministic tie-breaking by `tickets.updated_at DESC, tickets.id`.
- Apply visibility filtering in SQL before snippets, counts, rank summaries, and continuation tokens are constructed.
- `assignee:me` uses the authenticated actor, not a caller-provided user ID.
- Escape FTS operators and quote terms. Provide a clear `invalid_filter` error with the failing token.
- Search results include canonical key, title, state, assignee display name, project, due date, and an authorized snippet. They do not include comments or hidden-board names unless access permits.
- Target: p95 under 100 ms for 100,000 active tickets and 1 million combined comment tokens on a typical hosted instance. Treat this as a target to measure, not a guaranteed bound.
### Rebuild and size limits

Add an owner-only maintenance command proposed as `tracker-search-rebuild` or an admin route. It rebuilds `ticket_search` in batches of 500 tickets, reports counts and elapsed time, and can resume from the last ticket ID. It does not alter ticket events.

Initial limits: title 200 code points, description 20,000, comment 20,000; index at most 10,000 comments and 64 KiB combined text per ticket; target 100,000 active tickets. Older comments remain in history but are omitted from the FTS row. Larger installations should measure before raising limits. Rebuild/index maintenance must not hold a board Yjs room lock.

## 6. Event log, notifications, and outbound webhooks

### Append-only event log

`ticket_events` is the authoritative per-ticket activity stream. It is not the same as existing `audit` in `directory.sqlite`: `directory.audit` appends administrative action rows, while `ticket_events` carries ticket-level before/after data and ordering.

Proposed event types: `ticket.created`, `ticket.updated` (field, from, to; covers labels, project, milestone, priority, due, title, description), `ticket.state_changed`, `ticket.assigned`, `ticket.commented` (plus edited/deleted variants `ticket.comment_edited`, `ticket.comment_deleted`), `ticket.related`, `ticket.unrelated`, `ticket.card_linked`, `ticket.card_unlinked`, `ticket.archived`, `ticket.restored`, `ticket.imported`, `ticket.cloned`, `link.pr_opened`, `link.pr_ready`, `link.pr_merged`, `link.pr_closed`, `link.commit_added`, and `integration.rule_applied` (rule id, from state, to state). These names are frozen with `docs/tracker-ux.md` §2.4. Integration activity is recorded as `link.*` events plus a `ticket_comments` row; there are no separate `integration.activity|comment|transition` events.

Each event includes `schema_version`, actor type/id, source, committed sequence, idempotency key, timestamp, and bounded `before_json`, `after_json`, or `details_json`. Event schemas are versioned independently from the SQL table. Consumers ignore unknown optional fields and reject unknown required schema versions.

Rules:
- Append the event in the same transaction as the ticket mutation.
- Store only data needed for activity and audit. Do not copy raw webhook payloads, prompts, tokens, or provider secrets.
- Comments are stored in `ticket_comments`; the matching event references the comment ID and a short preview only if the actor can read the comment.
- The event log is append-only in application code. Event retention/export remains an OPEN decision.
- Activity UI reads `ticket_events` by `ticket_id,id DESC`. `server/history.mjs` continues to serve board document versions; it does not become the ticket event store.
- A restore from backup restores events and ticket rows together because both live in `directory.sqlite`.
### Notification fan-out

Create `notifications` and email outbox rows in the same ticket transaction. Notify the assignee when assignment changes; subscribers on comment, transition, relation, or mention events; and the creator on meaningful updates subject to preferences. An optional workspace setting can notify an inbox for unassigned tickets. Do not notify the acting user by default.

Existing `server/chat-notify.mjs` has in-memory pending notices and calls the `server/mailer.mjs` `send` interface. Do not copy its in-memory timer as the durable tracker queue: use `notifications` rows and a delivery status. The email path may use the existing `mailer.send` function and mail templates, but it must process durable rows and be idempotent.

Notification kinds to freeze with design include `assigned`, `mentioned`, `commented`, `status_changed`, `due_soon`, `relation_changed`, and `integration_activity`.

At delivery time, recheck ticket access. If a user lost access, mark the notice suppressed. Respect per-user preferences and daily limits.
### Outbound webhooks

**RECOMMENDED:** Owners only may create, rotate, disable, or replay a webhook. Admins and members can inspect delivery status only if the workspace owner grants that screen access. Do not let guests or MCP tokens create endpoints in v1.
- Subscribe to a fixed event allow-list, such as `ticket.created`, `ticket.updated`, `ticket.transitioned`, `ticket.comment_added`, and `ticket.archived`.
- Sign exact UTF-8 body bytes with HMAC-SHA256 and include `X-Tabula-Timestamp` and `X-Tabula-Signature` headers. Signature input is `timestamp + "." + raw_body`.
- Reject credentials, non-HTTPS schemes, private IPs, localhost names, and DNS answers containing non-public IPs. Recheck DNS per attempt, pin the checked address, and disable redirects.
- Reuse outbound address checks in `server/ai/net-guard.mjs` (`isPublicAddress`, `guardedLookup`, `assertPublicLiteral`) as a base. `server/source-policy.mjs` is an inbound source-IP allow-list, not an SSRF guard.
- `server/mailer.mjs` also supports a webhook mode, but that mode posts mail and does not provide this webhook policy. Do not route ticket webhooks through it.
- Rate limit each endpoint to 60/minute and 1,000/hour; pause on repeated 429/5xx. Retry at 10 seconds, 1 minute, 5 minutes, 30 minutes, 2 hours, then every 6 hours for up to 8 attempts before dead-letter. **OPEN:** exact count and maximum age.
- Log event ID, attempt, status, response class, next retry, delivered/dead time, and bounded error code; omit response body by default. Owner-only replay creates a new delivery referencing the original event, records `webhook.replay` in `directory.audit`, and signs the same body with a fresh timestamp.
- Delivery is at-least-once. Consumers deduplicate by event ID and endpoint ID.
### Tick and stopped workspaces

Due-soon notices, auto-archive, email fan-out, webhook retries, and integration inbox retries need time or a wake. A hosted instance that is stopped cannot execute a process timer. `docs/cloud.md` describes the control plane and instance endpoints, but this repository has no scheduler or durable wake queue specification.

Options:

| Option | Behavior | Running-hours cost and failure mode |
|---|---|---|
| A. Run on wake only | Process due work when the app starts or on the next user request. | No extra running hours. A ticket due at 09:00 may notify at the next visit days later. Webhooks/retries also wait. |
| B. Control-plane tick | Control plane wakes a workspace at most N times/day; instance drains due rows and exits/autostops. | Each run adds boot and job duration. At 4 ticks/day × 30 seconds of active work, the upper bound is about 2 running minutes per workspace/day, excluding boot and traffic. Tick storms and fleet size need caps. |
| C. Pending-work table + next visit | All due jobs remain durable in SQL; next visit drains them. | No extra running hours. Same notification delay as A, but event loss is avoided and work is visible as pending. |
| D. External scheduler | A separate worker or queue processes due work. | Adds always-on or metered worker hours and a second service to secure, deploy, and monitor. Lowest latency if funded; more operations. |
**RECOMMENDED:** C for self-host and the first release; add B as a hosted operational service if Johan wants predictable due-soon delivery. Hosted behavior remains the same feature set; only scheduling and wake are supplied by the control plane. Tick cap `N` and whether inbound integration deliveries may trigger an immediate wake are OPEN questions in section 14.
### Mail and activity UI

- Activity UI merges ticket comments with event rows by `created_at` and event sequence, with comments represented once.
- Email uses `server/mailer.mjs:createMailer().send` with a named template and parameters, following the existing `server/chat-notify.mjs` pattern.
- Do not send every update to email. Apply dedupe keys, per-user daily caps, and preference checks.
- Self-hosted instances can use the existing mail modes (`log`, `file`, `webhook`, `smtp`). The tracker does not require hosted email.

## 6b. Integrations

### Framework

**DECIDED:** Integrations are part of the generic tracker architecture. GitHub is first. GitLab, Slack, and other providers must be addable without schema changes.

**RECOMMENDED:** Register provider implementations in code and keep connections, inbox deliveries, mappings, and audit in the generic SQL tables from section 1.

    interface IntegrationProvider {
      key: string;
      schemaVersion: number;
      verifyRequest(input: {
        rawBody: Uint8Array;
        headers: Headers;
        connection: IntegrationConnection;
      }): Promise<VerifiedDelivery>;
      parseEvent(delivery: VerifiedDelivery): NormalizedIntegrationEvent;
      matchTickets(event: NormalizedIntegrationEvent): TicketMatch[];
      applyEvent(
        event: NormalizedIntegrationEvent,
        match: TicketMatch,
        tx: TrackerTransaction
      ): Promise<IntegrationApplyResult>;
      health(connection: IntegrationConnection): Promise<IntegrationHealth>;
      revoke(connection: IntegrationConnection): Promise<void>;
    }

    type NormalizedIntegrationEvent = {
      provider: string;
      deliveryId: string;
      type: string;
      repository?: { id: string; name: string; defaultBranch?: string };
      actor?: { id: string; login: string; url?: string };
      item?: { id: string; kind: "commit" | "pull_request"; title: string;
               body?: string; branch?: string; url: string; state?: string;
               merged?: boolean; commitSha?: string };
      occurredAt: number;
      payloadHash: string;
    };
Providers may add keys under `settings_json` and normalize into this common envelope. They may not add ticket tables, provider-specific comment tables, or direct Yjs writers.
### GitHub inbound behavior

**RECOMMENDED:** Use a GitHub App. It offers installation identity, repository selection, and narrowly scoped permissions. A plain signed webhook receiver with a per-workspace secret is a fallback for self-hosted operators who do not want an App installation.

For each allowed repository:
1. Receive commit/push, pull request, and merge-related deliveries.
2. Search the commit title/body, branch name, PR title/body, and merge title/body for canonical keys such as `TAB-123` and aliases such as a Linear identifier.
3. Resolve the key through `tickets.key` and `ticket_aliases`. Do not create tickets from a mention.
4. Upsert a `ticket_external_links` row, append the matching `link.*` event and add a `ticket_comments` row. For a commit, include commit subject, commit link, and author; for a pull request or merge, include PR title, link, author, and state. Use a bounded escaped summary, not the full body.
5. For repeated PR updates, dedupe by provider item ID plus action/state revision. For commits, dedupe by commit SHA and ticket ID. Also dedupe provider delivery by `X-GitHub-Delivery`.
6. If a merge lands on the configured default branch, transition to a configured `completed`-category state, recording `integration.rule_applied` only when the current state is not canceled and the transition is not backward.
7. If one provider event mentions several tickets, process each match in the same delivery transaction where possible. Record partial failures for retry without duplicating successful ticket events.

The merge rule can be configured per repository or per workspace. Store the selected completion state by state ID. On state deletion, disable the rule rather than silently choosing another state.

**RECOMMENDED:** Default to “comment only” until an owner opts into automatic transition. Allow a connection-level and repository-level override; repository-specific settings win. A canceled ticket is never moved by a merge. A completed ticket is never moved backward by a delayed delivery.
### Secrets, rotation, and payload handling

Store GitHub App keys and installation tokens as ciphertext in `integration_connections`; store outbound webhook signing secrets as ciphertext in `webhooks`. Use the AES-256-GCM/HKDF pattern in `server/ai/keys.mjs` with `TABULA_AI_SECRET`, nonce, and key version; require that secret before enabling providers. Hosted sets this server secret through protected workspace configuration; self-hosted operators provide it in the server environment. Neither mode returns or logs secrets or puts them in board docs, events, FTS, MCP, API responses, or plaintext backups. Backups separately encrypt the database with `TABULA_BACKUP_KEY`. Rotate using `TABULA_AI_SECRET_PREVIOUS`, reseal rows, then remove the old key after re-encryption. Store bounded normalized events and hashes; do not persist raw GitHub body text. Fork PRs and commit text are untrusted data: never execute commands or fetch URLs from text, and ignore forks unless explicitly allowed.
### Webhook verification, dedupe, and loop prevention

For a plain webhook receiver:

Read raw bytes, verify `X-Hub-Signature-256` with HMAC-SHA256 and constant-time comparison, and require valid `X-GitHub-Delivery` plus an allowed installation/repository ID. Deduplicate delivery ID and provider item/action key. GitHub does not supply a signed request timestamp; where normalized events have an occurrence time, reject events older than 7 days and do not claim a signature timestamp replay window. Insert `integration_events` under unique `(connection_id,provider_delivery_id)` before processing; duplicates return success without effects. Limit each connection to 60/minute and 600/hour; queue bounded excess or return 429 when full. Cap one comment per ticket per event and 10 integration comments per ticket per 10 minutes; collapse excess updates into one activity item. V1 makes no outbound GitHub writes; if that changes, attach a Tabula operation marker and ignore its webhook echo.
### Connection permissions and ticket scope

**RECOMMENDED:** Only owners connect/disconnect, change repository allow-lists, rotate secrets, or enable auto-transition. An owner may delegate health visibility to admins; no member or MCP token reads secrets. Each connection lists repository IDs and permitted actions; unlisted repositories cannot match tickets. GitHub may touch only tickets named by key/alias and may add activity/comment or perform the guarded transition, never edit other fields. Comments follow section 4 visibility. Audit connection/rule/secret changes, rejected signatures, replay, and health failures in `integration_audit` and `directory.audit`; never log secrets, raw bodies, or full PR text.
### Auto-stop, wake, and delivery semantics

Fly Proxy autostart behavior is external to this repository. The Fly docs say that with `auto_start_machines = true`, Fly Proxy waits for an HTTP request, starts a stopped/suspended Machine when needed, and routes the request to it. The docs do not promise a durable application-level event queue. `fly-replay` is a request-routing mechanism; it is not a webhook inbox or delivery guarantee. See [Fly Proxy autostop/autostart](https://fly.io/docs/reference/fly-proxy-autostop-autostart/) and [Playing Traffic Cop with Fly-Replay](https://www.fly.io/blog/how-to-fly-replay/).

Options:

| Option | Behavior | Loss/duplication and cost |
|---|---|---|
| A. Public edge directly wakes the instance | GitHub POSTs the public app URL. Fly Proxy starts a stopped instance when autostart is enabled and routes the request. | App must persist the delivery before returning 2xx. GitHub retries failed requests, so delivery is at-least-once; unique delivery ID prevents duplicates. A request can add cold-start/runtime minutes. No durable queue exists before the app acknowledges. |
| B. Control-plane queue, replay on wake | Edge/control plane stores raw bounded request plus workspace/connection identity, then sends/replays it when the workspace wakes. | Queue is durable if separately backed up. Duplicate wake/replay is expected and deduped by delivery ID. Adds queue storage, operations, and per-event wake minutes. |
| C. Provider retries only | Return non-2xx while stopped/unreachable and rely on GitHub’s retry/redelivery behavior. | No Tabula queue cost when autostart is disabled; event loss is possible after provider retry expiry or configuration errors. A later manual redelivery may duplicate without inbox dedupe. |

If B is implemented, cap the queue at 10,000 deliveries or 100 MB per workspace, whichever comes first, and expire unprocessed deliveries after 7 days. Return 429 when full; retain a dead-letter count and show owners a manual redelivery path. At 30 seconds active work per delivery, 100 direct wakes/day cost about 0.83 instance-hours/day plus cold starts. A batched B run of 100 deliveries in 30 seconds, four times/day, costs about 0.033 instance-hours/day plus boot time.
**RECOMMENDED:** A for hosted v1 only if a real public HTTP service with `auto_start_machines=true` is configured and an acknowledged delivery is committed to `integration_events` before returning 2xx. Use B if the edge does not reliably reach stopped workspaces or if the product needs an explicit durable buffer. Do not promise queueing from `fly-replay` alone. For self-hosted deployments, require a reachable public HTTPS URL. Polling is a future fallback, not part of v1.

**Assumption:** Current app deployment uses Fly Proxy autostart for workspace HTTP requests. Check the actual `tabula-cloud` service configuration, edge route, autostart setting, and replay response path before promising delivery while stopped. The app repo has no control-plane wake queue or scheduler contract.
### Health, disconnect, and limits

Health values are `active`, `degraded`, `reauthorize`, `disabled`, or `error`. Show last delivery/processing time, error code, repositories, and scopes, never secrets. Disconnect immediately disables processing, revokes credentials when supported, ignores queued events, and keeps audit. Limit outbound webhooks to 60/minute and 1,000/hour; use section 6 retries. Initial provider limits are 25 repos/connection and 10 active connections/workspace. Degraded events remain queued with backoff; owners can replay or disconnect.

## 7. MCP tools for tickets

Existing MCP is a hand-written stateless JSON-RPC endpoint at `POST /mcp` in `server/mcp.mjs`, enabled by `TABULA_MCP=on`. It uses bearer tokens, `canWriteRoom`, board scopes, rate limits, and `fence()` in `server/board-ops.mjs`. Keep existing kanban tools compatible.
### Proposed ticket tools

| Tool | Purpose |
|---|---|
| `list_tickets` | Keyset-paginated tickets filtered by state, assignee, label, project, milestone, due, archive, and linked board. |
| `get_ticket` | One authorized ticket, current projection links, and optionally a bounded activity page. |
| `search_tickets` | Full-text and filter-grammar search from section 5. |
| `create_ticket` | Create a ticket with server-allocated key and initial event. |
| `update_ticket` | Update title, description, assignee, labels, priority, due, project, milestone. |
| `transition_ticket` | Move to a state by state ID/key; state category rules are validated server-side. |
| `comment_ticket` | Add an idempotent comment. |
| `link_ticket` | Add a ticket projection to an authorized linked kanban or link a ticket to a card. |
| `relate_tickets` | Add/remove `blocks`, `blocked_by`, `relates_to`, `duplicates`, or `cloned_from`. |
| `list_saved_views` | List only views visible to the actor. |
| `get_saved_view` | Resolve one authorized view and return its query plus a page of results. |
| `create_saved_view` | Create a personal view; shared view creation requires workspace tracker write access. |
The concrete names are proposed, not current MCP tools.
### Compatibility and output

Keep existing `list_kanban_cards`, create/update/move/bulk card tools, labels, and lanes. Linked-card reads add `ticketKey` and `ticketId`; writes delegate to the coordinator. `create_objects` and `update_objects` remain unable to bypass card planners. Responses use stable JSON plus nonce-fenced `fence()` text. Lists return `{ items, nextCursor, hasMore }` with a signed actor/filter/sort-bound keyset cursor; ticket output includes all authorized fields. Pages are 25 by default, 50 maximum; activity is 100 maximum. Respect the existing 256 KB MCP budget and return `limit_exceeded`.
### Scopes, rate limits, errors

Extend `server/tokens.mjs` and token creation UI with explicit tracker scopes: `tracker:read`, `tracker:write`, `tracker:comment`, and `tracker:transition`.

Existing `read`, `comment`, and `write` continue to authorize existing board tools. A token may receive old board scopes without new tracker scopes. Recheck token owner membership and board access on every call.

Initial limits should match or be tighter than `server/mcp.mjs`: 120 reads/minute and 30 mutations/minute per token, plus 10 ticket writes/minute for `create_ticket` and `transition_ticket`. Enforce durable workspace limits across relay instances if hosted scale-out is introduced. Audit action names as `mcp.ticket.<tool>` without storing ticket text in general `directory.audit.detail`.

Stable error codes: `invalid_input`, `invalid_filter`, `not_found`, `forbidden`, `read_only`, `conflict`, `wip_limit`, `limit_exceeded`, `rate_limited`, `idempotency_conflict`, `integration_disabled`, and `internal`.

All returned ticket text is data. Use the same nonce wrapper as existing `fence()` in `server/board-ops.mjs`. Agents must not follow instructions embedded in ticket titles, descriptions, comments, activity, PR titles, or imported Linear content.

Idempotency:

Require `idempotencyKey` on create, comment, transition, and link writes, unique by `(actor_type,actor_id,tool,idempotency_key)`. Same key/request hash returns the original result; a different hash returns `idempotency_conflict`. Keep keys for at least 30 days.

## 8. Linear importer

Operator procedure: [docs/linear-import.md](linear-import.md).
### Source and mapping

**Archived issues (known, 2026-10-10):** Linear's AI archived every Done issue. Every Linear API query the importer makes (and the Linear-to-board script 01b9936) must pass `includeArchived: true`, or the Done history is silently missing; the dry-run report must count archived issues separately so a shortfall is visible.

**RECOMMENDED:** Provide a CLI importer in the app repo using the Linear API for complete migration. Accept CSV export as a fallback when an API token cannot be provided. Keep the import credential local to the operator; never save it in a board or tracker row.

Map:

| Linear data | Tracker target |
|---|---|
| Teams | `projects` or a team metadata field; do not create one workflow per team in v1. |
| Projects | `projects`. Preserve external project ID as an alias/metadata key if needed. |
| Cycles | `milestones` when the cycle has a date range; otherwise store an import note and report the loss. |
| Milestones | `milestones`. |
| Workflow states | `ticket_states` in the default workflow; map categories to backlog/unstarted/started/completed/canceled. Preserve original state name in the import report. |
| Labels | `labels` and `ticket_labels`; merge exact normalized duplicates and report conflicts. |
| Priorities | Map to integer 0–4 with a documented Linear-to-Tabula table; unknown values become null and are reported. |
| Estimates | Out of v1 by recommendation; preserve in `ticket_events.details_json` only if export requirements need it, not as a working field. |
| Assignees | Match by normalized email to existing `users.email`; unmatched users are unassigned with a report row. Do not auto-invite. |
| Comments | `ticket_comments`, with original author name/email snapshot and original created timestamp. |
| Attachments | Copy files only when the source API grants access; store as Tabula assets and include an attachment event. Otherwise keep a source URL and report it. |
| Relations | `ticket_relations`; unsupported relation types become `relates_to` plus a loss report. |
| IDs | Store original Linear issue ID and identifier as `ticket_aliases(provider='linear',...)`. Allocate new `TAB-...` keys. |
| URLs | Keep original issue URL in the alias row for redirects/reference. |
### Idempotent import process

- Stable source key: `(provider='linear', external issue UUID)`.
- Re-running an import finds existing aliases and updates only fields explicitly selected in the import mode.
- Default mode is create-only. “Update imported tickets” is an explicit second mode and must not overwrite edits made after the previous import without a conflict report.
- Dry-run downloads and normalizes source data, matches users and states, checks duplicate aliases, estimates attachment bytes, and emits JSON plus human-readable CSV/HTML report. It performs no writes.
- Import runs in batches of 100 issues and commits each batch with ticket, alias, event, comment, and search rows together.
- Rate-limit requests using provider headers, retry 429/5xx with exponential backoff, and checkpoint the cursor in a local file with mode 0600.
- Attachments are downloaded to a temp directory, size-checked, content-type sniffed, malware-scanned if the host provides a scanner, then uploaded through the asset store. Never trust filenames or MIME headers.
- The CLI accepts a local server URL and owner credentials; it does not bypass `ticketAccess`.
- Hosted migration is run by the Tabula operator against a workspace with owner authorization. The import token is short-lived and deleted after completion.
### Loss report and cutover

Possible losses: custom Linear workflows not represented in v1, estimates, cycle semantics, private teams, emoji reactions, deleted comments, rich-text layout, external attachment permissions, automation rules, and webhook configurations. The report must count each loss category and name affected issue keys.

Cutover:
1. **Dual-run window:** 2 weeks recommended. New work is created in Tabula; Linear remains read-only except for emergency correction.
2. Run initial dry-run; resolve state/category and user-match report with the workspace owner.
3. Run initial import; compare counts and spot-check at least 50 tickets, 20 comments, 10 relations, and every imported milestone/project.
4. Keep Linear available read-only during the dual-run window. Record any changes that must be mirrored.
5. Freeze Linear writes at the agreed end date.
6. Run final delta import from the last successful cursor.
7. Verify issue count, alias uniqueness, comment count, state distribution, project/milestone assignments, attachment checksums, and a sample of deep links.
8. Export and retain the final Linear source archive under the workspace’s backup policy.
9. Disable the Linear integration/token and update internal links.
10. Do not cancel the Linear workspace until the backup go/no-go checklist in section 9 passes.

Provide a verification script in the app repo that compares source counts to imported canonical ticket/alias/comment rows and performs deterministic spot checks. It must not print imported ticket descriptions or comments.

## 9. Off-site backups: precondition to cutover

### Why this blocks cancellation

The tracker database becomes the workspace’s canonical ticket record. If it is lost, the workspace loses the only ticket history after cutover. Today’s Fly volume snapshots are same-region and retained for 14 days; they are not an off-site restore plan for a workspace that cancels its source tracker.

`docs/backups.md` and `server/backup.mjs` already provide encrypted S3-compatible backups. Configuration uses `TABULA_BACKUP_*`, including `TABULA_BACKUP_KEY`; `server/backup-copy-worker.mjs` makes SQLite copies with `VACUUM INTO`. The backup set includes `directory.sqlite`, `chat.sqlite`, board Yjs room files and live room state, board history, and assets. `server/restore.mjs` verifies a staged workspace, swaps files under a restore journal, and restarts.
### Tracker requirements

- Keep tracker tables and connection ciphertext in `directory.sqlite`, so the DB copy contains them.
- Keep integration secrets encrypted in SQLite. The off-site backup encrypts the database snapshot with `TABULA_BACKUP_KEY`; ciphertext remains ciphertext inside it.
- Keep every event, alias, comment, notification state, integration inbox row, and outbound delivery needed for recovery in `directory.sqlite`.
- `ticket_search` may be rebuilt but should be backed up initially to shorten restore time.
- Include tracker schema in `release-info` and schema checks used by restore.
- Add a coherent snapshot mechanism. Today `snapshotFiles` copies the directory first and room files a few seconds later; that is not an atomic cross-file point. Require a bounded snapshot barrier: pause ticket and board writes, save all open rooms, copy the SQL database and board documents to local snapshot files, then release writes before uploading to S3. The projection outbox repairs stale links after restore but cannot recover a SQL event omitted from the database snapshot.
- `restoreBoardCopy` must not duplicate live `ticket_links` or reuse tracker IDs. A whole workspace restore restores the SQL database and Yjs docs together, then runs link/projection reconciliation before allowing writes.
- Add a restore drill that includes a ticket create, comment, transition, GitHub inbox event, webhook delivery, linked cards on two boards, and a workspace restore. Check event IDs, aliases, counter, links, and decrypted connection health without printing secret material.
- Test key rotation, missing old key, corrupted FTS rebuild, a room file missing from a manifest, and a database ahead of the binary.
### Recovery targets and go/no-go

**RECOMMENDED targets:**
- RPO: 15 minutes or less for ticket and event data after the first successful off-site backup.
- RTO: 4 hours or less to restore a workspace and verify a sample of tickets/links.
- Settle backup default is currently 120 seconds and interval default 60 minutes in `server/backup.mjs`; validate the actual backup schedule against the RPO. A stopped workspace cannot run an in-process interval while stopped.
- Keep daily encrypted points for at least 30 days, matching the current default in `docs/backups.md`, or document the owner’s selected retention.

A restore drill must pass before the Linear workspace is cancelled:
- [ ] Off-site backup is enabled and the latest manifest is recent enough for the RPO.
- [ ] Backup can be decrypted with documented key material, including after rotation.
- [ ] A ticket, its comments, event log, aliases, counter, and FTS rows restore.
- [ ] Two linked boards restore and reconcile without duplicate ticket links.
- [ ] `TAB-123` keys do not collide with imported aliases.
- [ ] GitHub connection secrets are present only as ciphertext and health can be re-established.
- [ ] A pending notification, inbound event, and outbound webhook delivery are recovered or safely retried.
- [ ] `server/restore.mjs` completes with no unexpected files and the server starts at the restored schema.
- [ ] The workspace owner can access a restored deep link and search for an imported Linear alias.
- [ ] Restore time and measured data loss meet the chosen RTO/RPO.
- [ ] The workspace owner accepts the loss report and final import verification.

**OPEN:** The exact RPO/RTO and minimum daily retention need an operational commitment.

## 10. Hosted versus self-host

### Feature parity

**DECIDED:** Tracker UI, tickets, search, MCP, integrations, importer, workflows, and linked kanbans are available in the AGPL app. Hosted differences are operational: off-site backup setup/operation, ticks/wake, fleet upgrades, and service monitoring.

Self-hosted owners can configure S3-compatible backup, mail, `TABULA_AI_SECRET`, and a reachable integration URL. If a self-hosted server has no durable tick process, it processes pending work on wake. No tracker route or MCP tool checks “hosted” to enable a product feature.
### Flags and limits

Use `TABULA_TRACKER=on` as an emergency rollout kill switch, not a hosted-only feature flag; default on after migration/UI stabilize. `TABULA_TRACKER_INTEGRATIONS=on` may disable providers without hiding tickets. `TABULA_TRACKER_TICK=on` may enable the hosted runner; self-host can use cron/systemd. Keep existing `TABULA_MCP=on`. Cloud `readOnly` must block ticket, comment, integration, and mutating outbox writes. Limits are product defaults, not paid-tier gates.
### Upgrade, rollback, and release info

- Add only the additive migration described in section 1 for v1.
- Include directory schema and `maxReader` in `scripts/release-info.mjs`, which already derives them from `MIGRATIONS` and `CHAT_MIGRATIONS`.
- Add tracker feature health to `GET /api/internal/version` only if the control plane needs it. Do not expose secrets or ticket bodies.
- Before an upgrade, the control plane checks every volume can be opened by the previous stable build. With migration 12 expand-only, v5 schema 11 remains a valid rollback; v4 schema 10 is not.
- Do not ship schema contraction or incompatible trigger/unique-index changes until the control plane confirms no older machine can return. Use the two-release expand-then-contract rule in `docs/migrations.md`.
- Self-host rollback uses the same `min_reader` rule. If the new build has accepted writes under a non-expand migration, restore a backup or upgrade forward; do not manually lower `user_version`.
- Hosted automation adds no business tables outside the workspace database. The control plane may store tick schedule and wake metadata, but not ticket records.
### Control-plane limits push

`docs/cloud.md` describes bearer-authenticated internal routes and pushes read-only limits to the relay. Tracker should reuse existing limit propagation. No additional control-plane limits field is needed for v1 unless deployment must cap tickets or integration calls per workspace.

**Assumption:** The control plane’s current release inventory, tick scheduler, and wake queue are not specified in this app repository. Check those contracts before adding a hosted tick or webhook queue.

## 11. Rollout slices (slice plan, frozen order)

Each slice is shippable and reversible on its own. Rollback means switching the new UI or API off with `TABULA_TRACKER` and keeping the data; SQL rows are never deleted as a rollback.

### The migration gate

Every migration below is expand-only, but each one raises the directory `min_reader` to at least 11 (`server/schema.mjs`). A v4 image (generation 10) cannot open such a database. So:

> **Gate G (v4 retired):** no migration in this plan may be applied on a hosted volume while any workspace may still be rolled back to v4. Concretely: every workspace runs v5.0.1 or newer, v5.0.1 is promoted `current`, and the v4 release is withdrawn. Self-hosters are not affected, they back up before upgrading.

Slices marked **M** carry a migration and need gate G. Slices without M can ship before gate G.

| Slice | Scope | Migration | Flag | Size | Depends on |
|---|---|---|---|---|---|
| **0. Coherent snapshot barrier** | Pause ticket and board writes, save open rooms, copy `directory.sqlite` and room files to local snapshot files as one point, release, then upload (section 9). Manifest records the barrier time. Restore drill extended. | none | none | M | none. **Precondition for slice 1 reaching real data.** Off-site storage credentials are a separate precondition for cutover, not for building. |
| **1. Tickets core (no UI)** | `trackers`, `ticket_workflows`, `ticket_states` (seeded: To do, In progress, In review, Done, Cancelled), `tickets`, `ticket_counters`, `ticket_field_versions`, `labels`, `ticket_labels`, `ticket_comments`, `ticket_events`, `ticket_aliases`, `ticket_subscriptions`, `ticket_search` (FTS5), idempotency. Key allocation in one transaction. Event log. Filter grammar and search. MCP tools: `create_ticket`, `get_ticket`, `list_tickets`, `search_tickets`, `update_ticket`, `transition_ticket`, `comment_ticket`. Tracker tokens scopes. `TABULA_TRACKER=on`. Read-only cloud state blocks writes. | **M (12)** | `TABULA_TRACKER` default off until slice 3 | L | gate G, slice 0 |
| **2. Projects, relations, saved views** | `projects`, `milestones`, `ticket_relations`, `saved_views`; MCP `relate_tickets`, `list_saved_views`, `get_saved_view`, `create_saved_view`; filter grammar for project, milestone, relation. | **M (13)** | same | M | 1 |
| **3. Tracker frame and ticket page** | `tracker` board object, tabs inbox/my/all/board/projects, ticket page (comments, history, relations, subscribe, archive/restore), deep links `/t/*`, ticket chips, keyboard model. Reads and writes through slice 1 and 2 APIs. | none | `TABULA_TRACKER` on for dogfood | L | 1, 2, frozen UX contracts |
| **4. Linked kanbans, one-way projection** | `kanban_tracker_links`, `kanban_state_mappings`, `ticket_links`, `ticket_projection_outbox`; Link dialog; create ticket from a card created on a linked kanban; SQL to card projection; unlink. | **M (14)** | `TABULA_TRACKER` | L | 3 |
| **5. Bidirectional sync** | Linked-card command path, relay guard (modelled on `comment-authz.mjs`), lane moves as state transitions, field versions, offline edit outbox (edits only), multi-board repair, projection repair on room load and restore. | none | same | L | 4 |
| **6. Notifications and permissions hardening** | `notifications` table, in-app inbox, email outbox through `mailer`, preferences, `ticketAccess` complete for board guests, stale-notice suppression, due-soon on wake. | **M (15)** | same | M | 3 |
| **7. Backup and restore readiness** | Tracker data in backup validation, `restoreBoardCopy` and history restore detach tracker identity, reconcile after restore, key floor in the control plane, restore drill with tickets, go/no-go dashboard. | none (control plane gets one table) | none | L | 0, 5 |
| **8. Integrations and webhooks** | `integration_*`, `webhooks`, `webhook_deliveries`, member GitHub login mapping; GitHub App provider, inbox, `link.*` events, per-repo merge rule; signed outbound webhooks; queue-or-wake decision verified first. | **M (16)** | `TABULA_TRACKER_INTEGRATIONS` | L | 3 |
| **9. Linear importer** | CLI, dry run, report, aliases, comments, relations, users matched by email, delta run, verification script. No migration. | none | none | L | 1, 2 |
| **10. Harden, measure, cut over** | Load and permission review, restore drill passes, accessibility, docs, two-week dual run, final delta, cancel Linear after the section 9 checklist. | none | none | M | all above |

Notes:
- Migrations 12 to 16 may be merged into fewer migrations if slices ship together; the rule stays: expand-only, one gate.
- **Smallest useful dogfood: slice 0 and slice 1.** Agents and the manager can create and move tickets through MCP before any UI exists; slice 3 gives people the UI. Linear stays the record until slice 10.
- Slices 0, 3 (UI half), 5, 7 (client half), 9 and 10 do not touch the schema and can proceed in parallel with the gate being cleared.

### Test strategy per slice

This is the proposed test plan; it is not a request to run tests while drafting this spec. Unit coverage: migration safety, counter rollback/no reuse, categories, query grammar, event versions, idempotency, access, signatures, rotation, retries, and import mapping. Relay integration: use `test/start-relay.ts` as the relay process starter and `test/mcp-harness.ts` for signed-in MCP calls; extend `test/backup-harness.ts` for backup/restore. Cover Yjs updates, `roomAccess.write`, SQL failure, restart, and stale projections. UI E2E: frame/ticket flows, keyboard, comments/history, linked moves, offline reconnect, multi-board projection, viewer denial, deep links, search, notifications. Integration E2E: signatures, duplicate/expired delivery, repository allow-list, fork text, wake, DNS rebinding, retries, replay, rotation. Backup/restore: full encrypted snapshot, two projections, counter/alias, pending queues, FTS rebuild, history/copy, and key loss. Apply section 3 invariants and section 4 permissions to every affected slice.

#### Slice 2 decisions

- Ticket `project` references resolve by active project name, case-insensitively. A ticket milestone resolves within the selected project; without one, its name must identify exactly one active milestone so the project can be inferred. Clearing or changing a project with an incompatible current milestone requires clearing or changing both fields in the same update. Existing archived associations remain visible on the ticket, but cannot be newly assigned.
- A ticket pair has one relation row. Relations store `blocks`, `duplicates` and symmetric `relates_to`; `blocked_by` and `duplicated_by` normalize to the inverse endpoint order. Reads render the viewer-facing inverse, and a relation write appends one event to each ticket. `cloned_from` remains a schema-reserved kind and is not accepted by this slice's command.
- Saved-view query JSON is `{filter, sort}`. The only supported sort is `updated_desc`, matching `list_tickets` ordering and cursor semantics. Filter tokens are validated through the read-only `list_tickets` command path; later filter grammar additions can be consumed by saved views without changing their stored shape.
- Ticket association changes use the normal `updated` ticket event. Project and milestone lifecycle rows do not have a separate event stream in this schema; this slice adds the `related` and `unrelated` ticket event types.

## 12. Contracts to freeze with design before building

The names and shapes below need a design agreement. They are proposals, not existing TypeScript interfaces.
### Reconciliation with docs/tracker-ux.md section 2

The designer's proposals were checked against this spec. Accepted as written: object type `tracker`, ext fields on cards, `ext` on the container, the link record shape, the event names, the deep links, ticket chips. Changed on the architecture side:

| Topic | Designer proposal | Frozen here | Reason |
|---|---|---|---|
| State categories | `done`, `cancelled` | `backlog`, `unstarted`, `started`, `completed`, `canceled` (**designer to rename in UI copy and tokens, or we rename: one-line change, decide at freeze**) | The categories also drive API filters, integration guards and webhooks; one spelling everywhere. |
| Priority | names `none|urgent|high|medium|low` | API and MCP speak the names; storage is integer 0 to 4 in that order | Sorting in SQL. |
| Due | `YYYY-MM-DD` | `YYYY-MM-DD` (adopted; replaces the millisecond field in earlier drafts) | A due date is a calendar date, not an instant. |
| Estimate | optional number | optional number column, no UI or filters in v1 unless Johan opens question 7 | Cheap to store now, costly to migrate later. |
| Lane map | `map` on the container | SQL is authoritative; `ext.map` is a server-written copy the guard protects | A client must not be able to forge the lane to state mapping. |
| Frame fields | `trackerId`, `view`, `focusKey` | adopted | Navigation state only. |
| Tabs | six | `view` is one of `inbox | my | all | board | projects`; milestones are a section inside Projects | Matches the UX spec. |
| Description | Markdown | Markdown, 20,000 code points | Same as search limits. |

### Ticket JSON shape

    type Ticket = {
      id: string;                 // immutable internal ID
      key: string;                // immutable, e.g. "TAB-123"
      trackerId: string;
      title: string;              // one line, up to 200 code points
      description: string;        // Markdown
      state: { id: string; key: string; name: string; category: StateCategory };
      priority: "none" | "urgent" | "high" | "medium" | "low";
      assignee: null | { userId: string; name: string };
      creator: { type: "user" | "mcp_token" | "integration" | "system"; id: string | null; name: string };
      labels: Array<{ id: string; name: string; color: string | null }>;
      project: null | { id: string; name: string };
      milestone: null | { id: string; name: string; due: string | null };
      estimate: number | null;
      due: string | null;         // "YYYY-MM-DD"
      parent: null | string;      // ticket key
      relations: Array<{ kind: "blocks" | "blocked_by" | "relates_to" | "duplicates" | "duplicated_by"; key: string }>;
      links: TicketLinkRecord[];  // pr, commit, card
      aliases: string[];          // old prefixes and Linear ids, search only
      archivedAt: number | null;
      createdAt: number;
      updatedAt: number;
      updatedSeq: number;
    };

    type StateCategory = "backlog" | "unstarted" | "started" | "completed" | "canceled";

**RECOMMENDED:** Categories are fixed; state names, ids and order are configurable. Default states: Backlog, Todo, In progress, In review, Done, Cancelled (categories backlog, unstarted, started, started, completed, canceled).

### Links on a ticket (shared with the UX spec 2.4)

    type TicketLinkRecord =
      | { id: string; kind: "pr"; provider: "github"; repo: string; number: number; title: string;
          state: "draft" | "open" | "merged" | "closed"; url: string;
          author: { login: string; name?: string; avatarUrl?: string }; branch?: string; at: string }
      | { id: string; kind: "commit"; provider: "github"; repo: string; sha: string; title: string;
          url: string; author: { login: string; name?: string; avatarUrl?: string }; branch?: string; at: string }
      | { id: string; kind: "card"; boardId: string; kanbanId: string; cardId: string; at: string };

`pr` and `commit` rows live in `ticket_external_links`, `card` rows in `ticket_links`. A `card` link is returned only for boards the actor can read.

### Card fields and projection

On a linked card (flat, per `docs/kanban.md`): `extProvider: "tabula"`, `extKey: "TAB-123"`, `extUrl` (derived), `trackerId`. On the linked container: `ext: { provider: "tabula", tracker: trackerId, map: { [laneId]: stateId } }` (server-written copy of `kanban_state_mappings`).

    type CardTrackerProjection = {
      ticketId: string;
      title: string;
      state: { id: string; key: string; name: string; category: StateCategory };
      assignee: null | { userId: string; name: string };
      labels: Array<{ id: string; name: string; color: string | null }>;
      priority: "none" | "urgent" | "high" | "medium" | "low";
      due: string | null;
      projectionSeq: number;
    };

### Link record (SQL, canvas)

    type TicketLink = {
      id: string; ticketId: string;
      boardId: string; kanbanId: string; cardId: string;
      createdAt: number;
      createdBy: { type: "user" | "mcp_token" | "system"; id: string | null };
      removedAt: number | null; lastProjectionSeq: number;
    };

### Deep links

**DECIDED with design (UX spec 2.5):**
- Ticket: `/t/TAB-123` on the workspace host. It resolves the workspace and the ticket, applies `ticketAccess`, and opens the tracker with the ticket page. Not found and not permitted look the same (404 page with sign-in prompt for anonymous visitors).
- Board position: `/b/<board>?tracker=<trackerId>&t=TAB-123` places the viewer at the tracker frame with the ticket open. Needs read access to the board.
- Views: `/t/views/<viewId>`, `/t/inbox`, `/t/my`, `/t/board`, `/t/projects/<projectId>`.
- A pasted `TAB-123` renders as a ticket chip only when the viewer can read the ticket; otherwise plain text.
- Internal random ticket ids never appear in URLs.
- The client resolves chips through the existing per-ticket detail endpoint and store cache. It does not add a batch REST endpoint: lookups run at most four at a time, are capped at 100 unique keys per call, and cache missing or unreadable results for 30 seconds. Both cases remain plain text.
- Ticket and board-position routes use the ticket detail response's `resolvedKey` to replace an alias URL with the canonical key.

The client treats a valid tracker path as a route when no explicit hash navigation is active. The existing `#/t/<id>/edit` template route remains a separate hash route.

### Tracker frame object

    type TrackerFrameObject = {
      id: string; type: "tracker";
      x: number; y: number; width: number; height: number; z: number;
      version: 1;
      trackerId: string;
      view: "inbox" | "my" | "all" | "board" | "projects";
      viewId?: string;        // saved view
      focusKey?: string;      // open ticket key
    };

The object holds navigation state only. Ticket content comes from SQL-backed routes and never enters the Yjs document. Add `tracker` to the object type union in `src/types.ts`. Unknown clients follow the unknown-feature read-only rule in `docs/kanban.md`.
### Keyboard model hooks

Freeze hooks with design rather than browser key strings:

    interface TrackerKeyboardHooks {
      focusSearch(): void;
      openSelectedTicket(): void;
      createTicket(): void;
      moveSelection(delta: -1 | 1): void;
      transitionSelected(stateId: string): void;
      closeTicketPage(): void;
      switchTab(tab: "inbox" | "my" | "all" | "board" | "projects"): void;
      announce(message: string): void;
    }
Keyboard behavior must not capture typing while a text editor, input, or dialog owns focus. Canvas shortcuts continue outside the tracker frame. Board kanban navigation already has `Alt+Arrow` behavior in `src/ui/kanban.ts`; reconcile it with frame navigation.
### Notification kinds

    type NotificationKind =
      | "assigned"
      | "mentioned"
      | "commented"
      | "status_changed"
      | "due_soon"
      | "relation_changed"
      | "integration_activity";
Store a stable event reference and dedupe key. Email delivery is a preference, not a second notification kind.
### Integration contract

    type IntegrationConnectionContract = {
      id: string;
      provider: "github" | string;
      ownerUserId: string;
      status: "active" | "degraded" | "reauthorize" | "disabled" | "error";
      scopes: string[];
      repoAllowlist: Array<{ id: string; name: string; defaultBranch: string | null }>;
      settings: {
        mergeTargetStateId?: string | null;
        autoTransitionOnDefaultBranchMerge?: boolean;
      };
      createdAt: number;
      lastEventAt: number | null;
      lastErrorCode: string | null;
      secretHint?: string; // nonsecret display only; never a credential
    };
Freeze provider capabilities and per-repo override precedence, but keep provider-specific payloads out of this client contract.

## 13. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| 1 | Yjs accepts a forged linked-card projection or status. | Relay-side linked-card guard before broadcast; tracker-owned fields written only by coordinator; assert against forged Yjs updates. |
| 2 | SQL ticket state and Yjs cards diverge after crash. | Ticket event/projection outbox in `directory.sqlite`; idempotent projection repair on room load and restore. |
| 3 | A broad board share exposes full ticket details. | Confirmation when linking to a broader audience; explicit access model; no private fields in card projection; project ACL is a later narrowing feature. |
| 4 | Ticket keys collide after restore or import. | One database counter, one allocation transaction, aliases separate from canonical keys, restore and delta-import verification. |
| 5 | Old hosted image cannot read a migrated database. | Expand-only migration 12, `min_reader`/`maxReader` gate, do not deploy until v5 generation 11 is the minimum rollback target. |
| 6 | Event/notification work is delayed while hosted machine is stopped. | Durable SQL outbox, pending-work UI, control-plane tick/wake decision, documented delivery delay. |
| 7 | FTS5 is absent or differs in the shipped SQLite build. | Verify actual Docker Node 26 image before migration; startup capability check; do not create a virtual table on unsupported runtime. |
| 8 | GitHub webhook spoof, replay, or duplicate flood. | Raw-body HMAC with constant-time compare, delivery ID dedupe, replay window, repo/installation allow-list, per-connection limits. |
| 9 | Webhook target is used for SSRF or DNS rebinding. | Reuse `server/ai/net-guard.mjs` address checks, re-resolve and pin each attempt, block redirects, owner-only endpoint creation. |
| 10 | Linear cutover loses records or hidden permissions. | Dry-run/loss report, idempotent delta, counts/spot checks, encrypted off-site backup and restore drill before cancellation. |
### What to cut first

1. Email notifications; keep in-app durable notifications.
2. Auto-archive and automation rules; keep manual archive and explicit transitions.
3. Cycles and estimates; keep projects and dated milestones.
4. Attachments import; preserve external URLs and a loss report.
5. Shared saved views; keep personal saved views.
6. Multiple workflows; begin with one default workflow and custom-named states.
7. GitHub auto-transition; ship GitHub activity/comments first.
8. Advanced webhook replay UI; retain an owner-only operational replay command.
9. Cross-provider settings UI; keep the provider interface and GitHub-only UI.
10. High-scale FTS tuning; retain the required search contract and measure actual workspaces.

Do not cut server-side link validation, idempotency, event ordering, authorization, or backup/restore validation. They are correctness foundations.

## 14. OPEN QUESTIONS FOR JOHAN

Each recommendation below can be changed before the contracts in section 12 are frozen.
1. **ID prefix scope.** Options: one workspace-wide `TAB-123`; one prefix per team; one per project. **Recommendation:** workspace-wide, configurable prefix. **Cost if wrong:** changing later requires alias redirects and a long migration; team/project prefixes add rename and move semantics now.
2. **Hosted tick.** Options: A run on wake only; B control-plane tick wakes each workspace up to N times/day; C durable pending table drained on next visit; D external scheduler. **Recommendation:** C for first release, with B as the hosted operational add-on if due notifications need an SLA. **Cost if wrong:** C delays due notices and webhook retries; B adds fleet running minutes, scheduler state, and wake-failure handling; D adds a second service.
3. **Ticket deletion.** Options: hard delete; soft archive with links kept; archive and unlink all cards. **Recommendation:** soft archive, keep history and links, display archived state on every card; separate explicit “remove card link.” **Cost if wrong:** hard deletion is difficult to undo and damages history/import references; retaining links means more UI states.
4. **Dual-run end date.** Options: fixed 2 weeks; fixed 30 days; owner-selected date after verification. **Recommendation:** owner-selected date with a 2-week default and a 30-day maximum before review. **Cost if wrong:** too short risks missing final changes; too long increases duplicate-work and subscription cost.
5. **History retention.** Options: retain forever; retain 1 year online then encrypted export; configurable workspace retention. **Recommendation:** retain ticket events indefinitely during v1 and let off-site backup retention govern copies. Decide an erasure/export policy before launch. **Cost if wrong:** indefinite events increase storage and privacy obligations; pruning may remove audit context and complicate restore/import.
6. **State categories.** Options: fixed categories with custom names; fully custom categories; no categories and ordered states only. **Recommendation:** fixed five categories (`backlog`, `unstarted`, `started`, `completed`, `canceled`) with custom state IDs/names/order. **Cost if wrong:** fixed categories limit unusual workflows; fully custom categories complicate filters, automation, and integrations.
7. **Cycles and estimates in v1.** Options: both; cycles as milestones only; defer both. **Recommendation:** defer estimates; map dated cycles to milestones. **Cost if wrong:** teams may need spreadsheet workarounds; including estimates now adds import, UI, API, and reporting surface.
8. **Webhook creation rights.** Options: owners only; owners and admins; any tracker member. **Recommendation:** owners only for v1. **Cost if wrong:** restrictive delegation creates owner bottlenecks; broader access increases SSRF, data-export, and secret-management risk.
9. **GitHub connection rights and scope.** Options: owners only; owners/admins; repository owners self-serve. **Recommendation:** workspace owners only, with explicit repository allow-list. **Cost if wrong:** owner bottlenecks versus accidental workspace-wide data exposure.

10. **GitHub App or plain secret first.** Options: GitHub App; per-workspace HMAC webhook; support both in v1. **Recommendation:** GitHub App first; plain signed webhook as a self-host fallback only after the generic inbox is stable. **Cost if wrong:** App setup adds install UX; plain secret has weaker repo identity and rotation ergonomics.

11. **GitHub merge transition default.** Options: off by default; on for every repository; configurable per repo/workspace. **Recommendation:** off by default and configurable per repository, with a completed-category and no-backwards guard. **Cost if wrong:** off misses automation; on can close unrelated or incorrectly referenced tickets.

12. **Wake behavior for inbound integrations.** Options: direct Fly Proxy autostart; control-plane queue and replay; provider retries only. **Recommendation:** direct HTTP wake only after the deployed edge/autostart path is verified; otherwise control-plane queue. **Cost if wrong:** direct wake without durable queue can lose a delivery before acknowledgment; control-plane queue adds storage and operations; retry-only loses events after provider retention expires.

13. **Board duplicate and restore-copy semantics.** Options: copy tickets and allocate new keys; detach tracker identity; keep the same tickets on the new board. **Recommendation:** detach on a restored board copy by default and offer explicit “copy linked tickets”; normal card duplicate creates a new ticket. **Cost if wrong:** copying tickets creates surprising duplicates; sharing the same ticket can expose details and make duplicate lanes ambiguous.

14. **Priority scale.** Options: fixed 0–4; fixed 1–5; workspace-custom labels. **Recommendation:** fixed 0–4 with null for unset. **Cost if wrong:** import and display mapping must be migrated; custom scales complicate sorting and MCP filters.

15. **Ticket visibility for board-only guests.** Options: any linked board grants full ticket; linked board grants projection only; require workspace tracker membership. **Recommendation:** any accessible linked board grants full ticket in v1, with a broad-audience confirmation on link. **Cost if wrong:** full access is easy to understand but can expose descriptions/comments; projection-only adds separate permissions and redacted deep-link behavior.

16. **RPO/RTO and backup retention.** Options: RPO 15 minutes/RTO 4 hours; RPO 1 hour/RTO 1 day; workspace-configurable. **Recommendation:** 15 minutes/4 hours with at least 30 daily points before source cancellation. **Cost if wrong:** tighter targets increase backup/tick cost; looser targets increase lost work and downtime.

17. **Integration event retention.** Options: keep normalized inbox forever; retain 90 days; retain 30 days and keep ticket activity. **Recommendation:** keep ticket activity; prune processed inbox payload metadata after 90 days, retaining delivery IDs/hashes for dedupe. **Cost if wrong:** longer retention increases data volume/privacy exposure; shorter retention limits replay and incident investigation.

18. **Self-hosted public webhook URL.** Options: require public HTTPS; add polling fallback; support a user-operated forwarding relay. **Recommendation:** require a reachable HTTPS URL for GitHub App/webhook v1; polling is later. **Cost if wrong:** some self-hosters cannot receive inbound events; polling requires provider API credentials, rate-budget management, and cursor recovery.

19. **Notification email and tick SLA.** Options: no SLA; best-effort next wake; bounded maximum delay such as 6 hours. **Recommendation:** best-effort next wake initially, then agree a hosted tick cap and delay target before launch. **Cost if wrong:** a low cap saves running hours but delays notices; a high cap increases per-workspace run time.

20. **Linear attachment treatment.** Options: copy all accessible files; preserve links; copy files below a size cap and link the rest. **Recommendation:** copy accessible files under a configurable per-file limit and report the rest as links. **Cost if wrong:** copying can consume storage and time; links may stop working after cancellation.
21. **Key non-reuse after catastrophic restore.** Options: accept possible reuse for keys allocated after the last backup; keep a monotonic allocation ledger outside the workspace backup; change the workspace prefix epoch when the counter floor cannot be proven. **Recommendation:** preserve a small monotonic key floor in the control plane for hosted workspaces and use a new prefix epoch for self-hosts that cannot recover the floor. **Cost if wrong:** accepting reuse breaks stable references and aliases; an external ledger adds operational state and must itself survive disaster recovery.
