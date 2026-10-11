# Tracker slice 5: bidirectional sync (contract)

Status: contract for review, written before any code. It extends `docs/tracker-architecture.md` section 3 and `docs/tracker-s4-api.md`, and follows the conventions of `docs/tracker-api.md` (session cookie, `x-tabula: 1` on mutations, error shape `{ error, message, path? }`, `409` carries `ticket`, hosted read-only `403 read_only`, guests `404`). Everything stays behind `TABULA_TRACKER=on`. **No migration**: the columns slice 5 needs already exist in migration 15 (`ticket_links.last_projection_seq`, the outbox, `ticket_field_versions`), and every command is naturally idempotent (see Replays). A reviewer who finds a case that needs a column should say so, because then this becomes an M slice under the `minReader 11` rule.

## 1. What slice 4 already gives us (do not rebuild)

- SQL to card projection through a durable outbox, retried with backoff and on room load (`server/tracker/projection.mjs`).
- `reconcileTrackerProjection`: strips server-owned fields from unlinked objects and repairs linked ones from SQL, about 200 ms after a client update (non-resetting timer) and on room load; leaves other providers' `ext` alone. This is a **repair path that runs after the update was broadcast**.
- `SERVER_TRACKER_FIELDS` refused by MCP and stripped from templates.
- Link, unlink, `POST /links/:id/cards`, `pendingProjections`, audit actions `tracker.link.*`.
- `updateTicket` / `transitionTicket` already write `ticket_field_versions` per changed field, are change-detecting (a patch that changes nothing makes no event), accept `ifUpdatedSeq`, and enqueue the projection in the same transaction.

Slice 5 adds the other direction and the guarantees around it.

## 2. Decisions

1. **Raw Yjs edits on linked cards are the primary path for moves and titles; they are checked synchronously before anyone sees them.** The canvas keeps working as it does today (drag a card, type a title). The relay applies the client update to the room doc, inspects what changed on linked cards, commits the SQL command, and either keeps the change or undoes it, all while the outbound update is held (`Room.held`, the same mechanism `Room.guarded` uses for comments). Peers see only the final state. This is possible because `node:sqlite` is synchronous: no await sits between "apply" and "broadcast". It also means offline Yjs edits and old clients need no new protocol.
2. **There is no new "move" REST route.** The tracker frame, MCP and scripts move tickets with the existing `POST /api/tracker/tickets/:key/transition` and `PATCH`; the projection moves the card. A second move route would be a second writer (architecture 3, "One card mutation path").
3. **Fields other than lane and title go through REST only.** `assignee`, `priority`, `labels`, `due` are edited with `PATCH /api/tracker/tickets/:key`. The card's plain `owner`, `due`, `labels` fields on a linked card are ignored by the guard and are not projected (display uses `card.tracker.*`). OPEN for the designer and tech lead: the card editor must hide or re-route those controls for linked cards.
4. **SQL is canonical, field-level last-writer-wins by commit order** (architecture 3, Conflict rule). The guard commits in the order updates arrive at the relay.
5. **Fail closed.** If the guard cannot decide (directory error, unknown link state) it undoes the change and says so; it never lets an unchecked change on a linked card stand.
6. The s4 `reconcileTrackerProjection` timer stays as the **backstop** (history restore, crashes, anything the synchronous guard missed). The synchronous guard is the new front line.

## 3. The guard

### 3.1 Where it runs

For board rooms in accounts mode with `TABULA_TRACKER=on`, `Room.onMessage` routes Yjs sync updates from a writer socket through `trackerGuard.run(actor, apply)`, shaped like `createCommentGuard`:

1. Take a mirror-free snapshot of the linked cards of this room (see 3.2), apply the update, collect the changed object ids (the s4 `changedObjectIds` already does this), and keep only linked cards, linked containers' lanes and lane objects.
2. Classify each change (3.3), run the SQL commands, build corrections.
3. Apply corrections in a second transaction with origin `tracker-guard`, enqueue projections, broadcast one merged update, then send the sender a notice (3.6).

A room with no active links costs one cached boolean check per update. The "has links" cache is invalidated by link, unlink and card-create commands in the same process. A budget like comments: median under 1 ms per update in a 500-card room, enforced by a test.

### 3.2 What the guard knows

From SQL per board: active `kanban_tracker_links`, their lane to state map, and active `ticket_links` (card to ticket, with `updated_seq`). Loaded lazily per room and kept in memory with the invalidation above; every decision re-checks the ticket row in the command transaction, so a stale cache can only cause an extra check, not a wrong write.

### 3.3 Classification and result

| Change by a board editor on a linked card | Guard action | Revert on failure |
| --- | --- | --- |
| `parent` to another lane of the same kanban, lane mapped | If the card carries `moveBase` and the ticket's `state` field version (`ticket_field_versions.event_seq`) is newer than it, the move is stale: undone with `conflict` (section 5). Otherwise `transitionTicket` to the mapped state (source `board`), event, projection to every other board that shows the ticket. The client's own `rank` and `parent` stand. The guard removes `moveBase` after processing. | `parent` and `rank` restored to the card's SQL lane position |
| `parent` to a lane with no mapping | none | restored; notice `lane_unmapped` |
| `parent` to a lane of another kanban, or out of any kanban (loose) | none in v1 | restored; notice `card_stays_linked`. Detaching is the explicit `DELETE` route (section 4); to move the card to another linked kanban the user unlinks it and links it again there. |
| `rank` only (reorder inside the lane) | none, no ticket event | n/a |
| `text` changed | Checked at once (3.4): permission, the shared title validator, rate. Only the SQL commit is coalesced. | `text` restored at once; notice `title_invalid`, `forbidden`, `read_only` or `rate_limited` |
| `tracker`, `extProvider`, `extKey`, `extUrl`, `trackerId`, `ext`, `trackerUnmappedState` | none (already handled by s4) | stripped or repaired as in s4 |
| `desc`, `owner`, `due`, `labels`, colour, size, position | none; ordinary card fields | n/a |
| Card object deleted | Set `removed_at` on that `ticket_links` row (no outbox `remove`, the card is gone). Ticket, comments, events and other boards' cards stay. No transition. If the card comes back with its id (undo, Ctrl+Z), see 3.5 "Delete then undo". | n/a |
| Whole kanban container deleted | All its `ticket_links` rows get `removed_at` and the `kanban_tracker_links` row (and its mappings) is removed, as an unlink, in one transaction. Tickets stay. | n/a |
| Mapped lane deleted (alone, or as part of a bigger update) | Undone whole, notice `lane_mapped`. Old clients can still send it, and deleting a lane deletes every card in it. Unmapped lanes of a linked kanban delete as today (their cards were never linked). | the lane and its cards restored |
| New card object created in a linked kanban's mapped lane | see 3.5 | see 3.5 |
| Locked or `readOnly` | the existing board rules still apply first; the guard never widens them | n/a |

Guests and share-link editors resolve to **no tracker write** (the guard's actor is never null): their linked-card changes are undone with `forbidden`. A viewer cannot write the room at all. A **board editor without tracker write** (or when the workspace is hosted read-only) gets every linked-card change in the first six rows undone, notice `forbidden` or `read_only`. This is the real permission gap slice 5 closes.

Concurrent drags of the same card from two editors: updates are processed in arrival order; the second is a second transition, valid if its target lane is mapped. If the card is already in the target state the `transitionTicket` call is a no-op and produces no event.

### 3.4 Titles

- **What the title is.** A card's `text` may have several lines. The ticket title is the **first line**, trimmed. The guard validates and stores only that line, using the same title validator and stripper as REST and MCP (`cleanText`-based, in `server/tracker/tickets.mjs`: no second implementation). The rest of the card text is ordinary card text: never sent to SQL, never changed by the guard. When the projection writes a title it replaces only the first line and keeps the remaining lines.
- **Checks are synchronous and on the first update.** Permission (tracker write), validity (empty after trim, over-limit, hidden or control characters) and the rate budget are checked when the update arrives; a failure is undone at once, inside the held broadcast, so peers never see a draft a forbidden actor typed.
- **Only the SQL commit is coalesced**, and only for permitted actors: 400 ms of quiet, never later than 2 s after the first pending change, one `updateTicket {title}` for the last value. Until the commit the permitted editor's draft stands in the room and peers see it (it is what that editor is typing; if the commit later fails, `text` is restored and the sender gets the notice). A title typed offline arrives as one update and is committed once.

### 3.5 Cards created or pasted into a linked kanban

- **One auto-create rule**, for every writer (canvas, MCP, templates, AI runs, import): a card with no tracker fields in a mapped lane gets a ticket **once its first line is non-empty after trim** (the add-card flow may create the card empty and type afterwards; an empty card has no ticket yet and no notice). Key allocated in SQL, `source` `board` for the canvas and the writer's own source otherwise, title from the first line, state from the lane, creator the actor, idempotent per `(boardId, cardId)` through the existing `ticket_links` uniqueness. The explicit `POST /links/:id/cards` stays for scripts. At most 500 tickets per update; beyond that the rest stay plain with one notice `limit_exceeded`.
- **Delete then undo.** A card that arrives with an id whose `ticket_links` row has `removed_at` set, and whose `trackerId` and `extKey` still match that ticket, whose ticket is not archived and whose kanban is still linked, **re-activates that link** instead of creating a ticket. Anything else with copied tracker fields is a paste (below).
- A card in an **unmapped** lane gets no ticket and keeps working as a plain card (no revert), shown with a "Map this lane" hint by the client.
- A **copy or paste** of a linked card arrives with tracker fields (or a forged id). The guard strips them and treats it as a new card: new ticket, new key. It does not add `cloned_from` in v1 (OPEN: tech lead, say if you want it; it needs the relation already in slice 2).
- A **duplicated board** is a new board id; it has no link rows, so s4's reconcile strips it. "Copy linked tickets too" is deferred (section 7).
- A card moved in by **template or MCP** goes through the board planners, which already refuse tracker fields.


### 3.6 Notices

A new relay message `MSG_TRACKER_NOTICE` (next free code beside `MSG_COMMENT_NOTICE`), JSON `{ undone: [{ cardId, reason }] }`, reasons: `lane_unmapped`, `lane_mapped`, `card_stays_linked`, `title_invalid`, `forbidden`, `read_only`, `rate_limited`, `bulk_change`, `limit_exceeded`, `conflict`. Every entry names its card id (the tech lead's client drops undo-stack entries for exactly those cards); a reason is never applied to other cards. The sender gets it; peers get only the corrected state. The client (tech lead) shows a toast with a reason string, never ticket text.

### 3.7 Limits, transactions and audit

- **Budget counts updates, not commits**: about 240 guarded updates per minute per user and board. Over it, further linked changes are undone with `rate_limited`. An offline reconnect is one update, so it is never starved by the budget.
- **Bulk threshold**: an update that touches more than 100 linked cards is **refused whole** with `bulk_change` (nothing applied, nothing partial). This is the safety under history restore, big pastes of linked cards and a client that forgot the restore window (section 7).
- **One SQL transaction per update**: all commands from one client update (transitions, titles, creates, unlinks) run in a single directory transaction, so a 500-card paste costs one fsync, not 500, and cannot stall other rooms. If it rolls back, every linked change of that update is undone.
- Audit actions (same pattern as the s4 `test/admin.test.ts` additions): `tracker.card.move`, `tracker.card.title`, `tracker.card.create`, `tracker.card.unlink`, and `tracker.guard.reject` (actor, board, reasons, count; **never** ticket or card text). `tracker.guard.reject` is written at most once per user, board and minute.

### 3.8 Writers that do not go through a socket

MCP (`move_kanban_card`, `move_kanban_cards`, `update_kanban_card`), REST board operations, templates and AI runs edit the room doc without `Room.onMessage`, so the guard never sees them. They must not rely on the 200 ms reconciler to undo them silently (the agent would be told it succeeded). Decision: **the board planners refuse**. On a linked card a lane move, a `text` change, or an `owner`, `due` or `labels` change throws an `invalid` error `Linked card: use transition_ticket / update_ticket` (REST: `POST /tickets/:key/transition`, `PATCH /tickets/:key`) with `path` naming the field. Creating cards in a mapped lane is allowed and follows the auto-create rule above. A test per tool proves the refusal and that the room is unchanged.

## 4. REST additions

Only one new route is needed.

| Method and path | Request | Success response |
| --- | --- | --- |
| `DELETE /api/tracker/links/:id/cards/:cardId` | none | `200 { ticket, cardId, projectionPending }`: detaches one card from its ticket |

Behaviour: the `ticket_links` row gets `removed_at`; the card stays on the board as a plain card, its text set to the latest ticket title, tracker fields stripped; the ticket is untouched. Errors: `404 not_found` (link, or card not linked), `403 forbidden` / `read_only`, `429 rate_limited`. A second `DELETE` is `404`. Audit `tracker.card.unlink`.

`GET /api/tracker/links` gains nothing; `pendingProjections` keeps counting outbox rows. Ticket responses are unchanged.

## 5. Replays, ordering and the offline outbox

- **No `commandId` table.** Every command is a *set* of a field to a value or a transition to a state, so a replay is a no-op by change detection (no event). Title, priority, assignee, labels and due edits queued offline by the tracker frame are replayed with `PATCH` and may carry `ifUpdatedSeq` to detect that the ticket moved on; without it the replay is last-writer-wins by arrival.
- **Stale offline moves.** Arrival-order last-writer-wins would let a days-old drag re-open a ticket that was cancelled meanwhile. So the canvas path gets the equivalent of `ifUpdatedSeq`: the client writes `moveBase = card.tracker.projectionSeq` on the card in the same transaction as a `parent` change. The guard compares it with the ticket's `state` field version; if the state changed after `moveBase`, the move is undone with `conflict` and the card shows the current state. A move without `moveBase` (old client) falls back to last-writer-wins. `moveBase` is a client-writable field that the guard removes after processing; it is never projected. (Client change: tech lead.)
- **Offline edits on the canvas** are Yjs updates; they reach the guard as one update on reconnect and are processed in order (3.3). A move into a lane whose mapping was removed meanwhile is undone with `lane_unmapped`.
- **"Offline edit outbox (edits only)"** means: field edits (title, assignee, priority, labels, due, comment text) queue in the browser with the stored request and replay after reconnect; moves and creates are *not* queued by the tracker frame (they are Yjs and use the path above). Client work, tech lead.
- **Order and projection**: the commit order is the order of `ticket_events.id`. Projection carries `projectionSeq`; an outbox row older than `last_projection_seq` is dropped, never applied (s4 behaviour, asserted again).
- **Multi-board**: a ticket shown on several kanbans projects to each through its own lane map. A transition from board A projects to board B in the outbox as in s4; a ticket whose state has no lane on B gets `trackerUnmappedState: true` there and stays in its last lane.

## 6. Failure behaviour (additions to architecture 3's matrix)

| Failure | Result |
| --- | --- |
| Guard exception after the SQL command committed | Corrections are built from SQL, not from the exception: the card is repaired on the next outbox drain; the sender gets the notice `conflict`. The SQL result stands. |
| Directory write fails (disk, locked) | The linked change is undone (fail closed), notice `conflict`, error logged without text. |
| Relay stops between SQL commit and Yjs correction | The client's change may be in the saved room file; on load, s4's `reconcileTrackerProjection` plus the outbox drain converge it to SQL. |
| Two relays or a restart race | Not supported: one relay per workspace (unchanged). |
| Ticket archived while its card is moved | Transition refused (`archived`), card restored, notice `conflict`. Archived tickets keep a marker (s4). |
| Lane deleted that a mapping uses | Refused at the board path today only for unlinked kanbans; slice 5 adds the refusal for mapped lanes in `planDeleteKanbanLane` and the client store: the lane cannot be deleted until the kanban is unlinked or the lane is unmapped. OPEN: mapping edit (PATCH) is still not in this slice, so in practice "unlink first". |
| Tracker state archived while mapped | Already refused by the tracker (architecture 3); unchanged. |

## 7. History restore, board copy and the slice 7 hook

- **One reconcile entry point**: `reconcileTrackerProjection({ directory, roomAccess, boardId, ... })` (s4) is the only function that restores consistency between SQL and a room. Slice 5 adds no second one. It gains a `mode: 'sql-wins'` flag that also resets `parent` and `rank` of linked cards to the SQL lane, and removes links whose card no longer exists (card deleted by a restore).
- **Same-board history restore** is a client-side Yjs apply (`src/history.ts`), indistinguishable from drags, and would otherwise transition tickets. The window is an optimisation, not the only safety: the bulk threshold (3.7) refuses an unannounced restore whole, so a skipped call, a window lost on relay restart, or another tab restoring cannot mass-transition tickets. The client first calls `POST /api/tracker/boards/:boardId/restore-window` (board owner or editor, tracker write): it opens a window of 15 s for that board and user in which the guard runs in `sql-wins` mode (linked-card lane and title changes are undone, not committed; a card that the restore deletes is unlinked **and a ticket event is written** (type `unlinked`, source `restore`, so the ticket history shows why it left the board; confirm the event type against the `ticket_events` CHECK, else use `updated` with details); non-tracker fields restore normally). The window closes on its own and runs one `reconcile` on close; the client calls `DELETE` on the same path after `applyRestore` finishes. Response `{ expiresAt }`. Errors as above plus `409 conflict` if a window is already open for another user. A restore that skips the call is refused as `bulk_change` when it touches more than 100 linked cards; a small one is processed as ordinary moves.
- **`restoreBoardCopy`** creates a new board id, which has no link rows; s4's room-load reconcile already strips tracker fields from it, so the copy is a detached snapshot. Slice 5 adds the test only (copy has no tracker fields; the original's links are untouched). "Copy linked tickets too" is deferred to slice 7.
- **Slice 7 depends on this**: workspace restore restores `directory.sqlite` and the room files together and then calls the same reconcile for every board with links before writes are allowed. Slice 7 also owns the snapshot barrier use, the key floor and the restore drill. **Off-site storage** (architecture section 9) remains a cutover precondition, not a build dependency: devops' backup puller is built; what is still needed before Linear is cancelled is the configured S3-compatible bucket and `TABULA_BACKUP_*` credentials on the hosted volume, a successful off-site backup inside the RPO, and one passed restore drill with tickets. None of that blocks building slices 5 or 7.

## 8. Tests (every guard test first proves the forbidden or changed write reached an observer)

Rule for all relay-backed tests: wait until a second connected client has **seen** the client's change before asserting on the correction, and assert the final state on a fresh client and in the saved file. Relay-backed tests cannot run in the Codex sandbox; the orchestrating session runs them.

Unit (pure guard against an in-memory doc and a real in-memory directory):

- lane move to a mapped lane makes one `transitioned` event and one field-version row; the same move replayed makes none;
- move to unmapped lane, other kanban, or out of kanban is undone with the right reason;
- a title change commits once after quiet; empty or over-limit is undone; a rapid sequence makes one event;
- delete of a card removes one link, no ticket event, other boards untouched;
- new card in a mapped lane makes exactly one ticket; the same card seen twice (re-sync) makes one; a paste with a copied `extKey` makes a new ticket and strips the copied fields; unmapped lane makes none;
- editor without tracker write, hosted read-only, and rate limit all undo;
- archived ticket move is undone; two quick moves converge on the last valid state;
- `sql-wins` mode resets lane and title and unlinks deleted cards;
- the median guard cost on a 500-card room stays under 1 ms; a 500-card paste is one SQL transaction;
- permission, validity and rate on a title are checked on the first update (peer never sees a forbidden draft); multi-line text keeps lines 2+ untouched;
- stale `moveBase` is undone with `conflict`; a missing `moveBase` is last-writer-wins;
- an update touching more than 100 linked cards is refused whole (`bulk_change`), with and without a restore window;
- delete then undo re-activates the link; deleting the kanban container unlinks all; deleting a mapped lane is undone (`lane_mapped`);
- an empty new card gets no ticket until its first line has text; MCP-, template- and import-created cards in a mapped lane get tickets; guests and share-link editors get `forbidden`;
- every non-socket writer (MCP `move_kanban_card`, `move_kanban_cards`, `update_kanban_card`, REST board ops) refuses the field and leaves the room unchanged;
- invariants from architecture 3 ("Invariants tests must assert"), each as a named test: one card per ticket per kanban; `ticketId`, `ticketKey`, state never taken from Yjs; one event per accepted change; repairs idempotent; lane and state deletion cannot strand tickets.

Relay-backed (real sockets, `test/start-relay.ts`):

- editor drags a card: observer sees the final lane only, never an intermediate wrong one (held broadcast), ticket shows the new state;
- editor without tracker write drags: observer first sees nothing change (held), sender gets `forbidden`;
- offline batch (moves and a title in one update) is processed in order;
- restart after a committed move before the correction: reload converges;
- restore window: a history restore with the window open changes no ticket; without the window, it does (documents why the call is required);
- `restoreBoardCopy` copy carries no tracker fields.

Migration: none, so no new `schema-matrix` entry. The rollback floor test from s4 still passes untouched.

## 9. Work split and size

- Server (Codex, me gating): `server/tracker/guard.mjs` (classifier, title timer, commands), relay hook, notices, `DELETE` card route, restore window, `planDeleteKanbanLane` refusal, audit, docs. About 5 to 6 days.
- Client (tech lead): notice toast, hide linked-card owner/due/labels controls, call `restore-window` around `applyRestore`, block deleting mapped lanes, offline field outbox in the tracker frame. About 3 days.
- Black-box (haiku subagents, me): the cases in section 8 against a real relay. About 1 day.

## 10. Review outcome (tech lead, on 92cdeeb)

Accepted and folded in above: server-side writers refuse (3.8); title checks are synchronous and only the commit is coalesced, title = first line, shared validator (3.4); `moveBase` for stale offline moves (3, 5); budget counts updates, bulk threshold, one transaction per update, audit rate (3.7); delete then undo, container delete, mapped-lane delete (3.3, 3.5); auto-create rules for all writers, guests (3.5); restore-window kept with the bulk threshold underneath and a ticket event on unlink (7); notices carry card ids (3.6).

Answers: hold-then-correct is the primary path for moves and creates; keep the restore-window; paste makes a new ticket without `cloned_from`; hide the linked card's owner, due and labels controls and show the ticket's values read-only with an "Edit in tracker" link (no mirroring, because mirroring is a second writer); on unlink, projecting assignee, due and labels into the plain fields is deferred; 400 ms and 2 s are fine.

Remaining open: the exact `ticket_events` type for an unlink-by-restore (3.3/7).
