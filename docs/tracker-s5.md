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
| `parent` to another lane of the same kanban, lane mapped | `transitionTicket` to the mapped state (source `board`), event, projection to every other board that shows the ticket. The client's own `rank` and `parent` stand. | `parent` and `rank` restored to the card's SQL lane position |
| `parent` to a lane with no mapping | none | restored; notice `lane_unmapped` |
| `parent` to a lane of another kanban, or out of any kanban (loose) | none in v1 | restored; notice `card_stays_linked`. Detaching is the explicit `DELETE` route (section 4). |
| `rank` only (reorder inside the lane) | none, no ticket event | n/a |
| `text` changed | `updateTicket` `{title}` after coalescing (3.4); empty or over-limit after trimming is refused | `text` restored to the ticket title; notice `title_invalid` |
| `tracker`, `extProvider`, `extKey`, `extUrl`, `trackerId`, `ext`, `trackerUnmappedState` | none (already handled by s4) | stripped or repaired as in s4 |
| `desc`, `owner`, `due`, `labels`, colour, size, position | none; ordinary card fields | n/a |
| Card object deleted | remove that `ticket_links` row (outbox `remove` not needed, the card is gone). Ticket, comments, events and other boards' cards stay. No transition. | n/a |
| New card object created in a linked kanban's mapped lane | see 3.5 | see 3.5 |
| Locked or `readOnly` | the existing board rules still apply first; the guard never widens them | n/a |

A viewer cannot write the room at all. A **board editor without tracker write** (or when the workspace is hosted read-only) gets every linked-card change in the first six rows undone, notice `forbidden` or `read_only`. This is the real permission gap slice 5 closes.

Concurrent drags of the same card from two editors: updates are processed in arrival order; the second is a second transition, valid if its target lane is mapped. If the card is already in the target state the `transitionTicket` call is a no-op and produces no event.

### 3.4 Title coalescing

Typing produces many updates. The guard does not commit every one: it holds a per-card title timer (400 ms of quiet, never later than 2 s after the first pending change) and commits the last value. Until then the client's draft stands in the room. When the commit fails, `text` is restored to the ticket title as in 3.3. A title typed offline arrives as one update and is committed once.

### 3.5 Cards created or pasted into a linked kanban

- A **new** card (no tracker fields) in a mapped lane gets a ticket automatically, key allocated in SQL, `source: 'board'`, title from `text`, state from the lane, creator the actor, idempotent per `(boardId, cardId)` through the existing `ticket_links` uniqueness. This replaces the explicit `POST /links/:id/cards` for the canvas flow; the route stays for MCP and scripts.
- A card in an **unmapped** lane gets no ticket and keeps working as a plain card (no revert), shown with a "Map this lane" hint by the client.
- A **copy or paste** of a linked card arrives with tracker fields (or a forged id). The guard strips them and treats it as a new card: new ticket, new key. It does not add `cloned_from` in v1 (OPEN: tech lead, say if you want it; it needs the relation already in slice 2).
- A **duplicated board** is a new board id; it has no link rows, so s4's reconcile strips it. "Copy linked tickets too" is deferred (section 7).
- A card moved in by **template or MCP** goes through the board planners, which already refuse tracker fields.

A kanban with more than 500 cards created in one update (a paste) creates tickets for the first 500 and leaves the rest plain with notice `limit_exceeded`.

### 3.6 Notices

A new relay message `MSG_TRACKER_NOTICE` (next free code beside `MSG_COMMENT_NOTICE`), JSON `{ undone: [{ cardId, reason }] }`, reasons: `lane_unmapped`, `card_stays_linked`, `title_invalid`, `forbidden`, `read_only`, `rate_limited`, `limit_exceeded`, `conflict`. The sender gets it; peers get only the corrected state. The client (tech lead) shows a toast with a reason string, never ticket text.

### 3.7 Limits and audit

- A per-user, per-board budget of 120 guarded commits per minute; over it, further linked changes are undone with `rate_limited`. Plain card traffic is unaffected.
- Audit actions (same pattern as the s4 `test/admin.test.ts` additions): `tracker.card.move`, `tracker.card.title`, `tracker.card.create`, `tracker.card.unlink`, and `tracker.guard.reject` (actor, board, card, reason; **never** ticket or card text).
- Rejections are logged once per update, not per card.

## 4. REST additions

Only one new route is needed.

| Method and path | Request | Success response |
| --- | --- | --- |
| `DELETE /api/tracker/links/:id/cards/:cardId` | none | `200 { ticket, cardId, projectionPending }`: detaches one card from its ticket |

Behaviour: the `ticket_links` row gets `removed_at`; the card stays on the board as a plain card, its text set to the latest ticket title, tracker fields stripped; the ticket is untouched. Errors: `404 not_found` (link, or card not linked), `403 forbidden` / `read_only`, `429 rate_limited`. A second `DELETE` is `404`. Audit `tracker.card.unlink`.

`GET /api/tracker/links` gains nothing; `pendingProjections` keeps counting outbox rows. Ticket responses are unchanged.

## 5. Replays, ordering and the offline outbox

- **No `commandId` table.** Every command is a *set* of a field to a value or a transition to a state, so a replay is a no-op by change detection (no event). Title, priority, assignee, labels and due edits queued offline by the tracker frame are replayed with `PATCH` and may carry `ifUpdatedSeq` to detect that the ticket moved on; without it the replay is last-writer-wins by arrival.
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
- **Same-board history restore** is a client-side Yjs apply (`src/history.ts`), indistinguishable from drags, and would otherwise transition tickets. So the client first calls `POST /api/tracker/boards/:boardId/restore-window` (board owner or editor, tracker write): it opens a window of 15 s for that board and user in which the guard runs in `sql-wins` mode (linked-card lane and title changes are undone, not committed; deletions unlink; non-tracker fields restore normally). The window closes on its own and runs one `reconcile` on close. `DELETE` on the same path closes it early. Response `{ expiresAt }`. Errors as above plus `409 conflict` if a window is already open for another user. A restore that skips the call degrades to transitions, which is why the UI must call it (tech lead, `applyRestore`).
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
- the median guard cost on a 500-card room stays under 1 ms;
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

## 10. Open questions for review

1. Is the synchronous hold-then-correct guard (decision 1) acceptable as the primary path, or should linked-card edits require a REST command from the client (more client work, no relay hot-path code, but old clients and offline Yjs edits bypass it)?
2. History restore: the `restore-window` call (section 7), or have the server detect a restore by update size and shape?
3. Copy or paste inside a linked kanban: new ticket without `cloned_from` (this doc), or add the relation?
4. Linked-card `owner`, `due`, `labels` controls: hide, or mirror both ways?
5. Title coalescing numbers (400 ms quiet, 2 s cap) and the 120 commits per minute budget.
