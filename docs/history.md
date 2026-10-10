# Version history

Browse earlier versions of a board, preview one read-only, and restore it. Versions are full-state snapshots kept by the relay next to the room file: taken automatically while people edit, and on demand as **named versions**. A restore is an ordinary edit: the client works out the difference between the live board and the snapshot and applies it in one transaction, so it syncs to everyone like any other change, shows up as a new version and undoes with Ctrl+Z.

Status: approved and implemented. The decisions taken on the open questions are at the end of this page.

## Where versions live

Three places were considered. The decision is server-side snapshots.

| Option | Verdict |
| --- | --- |
| `Y.Snapshot` (state vector + delete set, a few bytes each) with garbage collection off | Rejected, see below |
| Snapshots in each browser (IndexedDB) | Not enough alone: per device, not shared with collaborators, lost with browser data, and the person who needs it is rarely the one whose device saw the board before someone else wiped it. Listed under "Not in this slice" for the relay-off case |
| **Snapshots of the room state, kept by the relay** | Chosen |

Why not `Y.Snapshot` (measured with the repo's own Yjs, a 300-sticky board):

- Garbage collection is on everywhere: the relay creates `new Y.Doc({ gc: true })` (`server/relay.mjs`, `Room`), and the browser creates `new Y.Doc()` (`src/sync.ts`), whose default is on. `Y.createDocFromSnapshot` throws "Garbage-collection must be disabled in `originDoc`!" on such a doc.
- Content deleted under gc is not in the state at all. A deleted sticky's text is absent from `Y.encodeStateAsUpdate` (with gc off it stays). So existing room files and IndexedDB copies cannot give anything back, and the `.drift` file (`src/exporters.ts`) holds the board's CRDT structure but cannot bring back deleted objects or earlier values, despite the "Full history" hint in the board menu.
- Turning gc off everywhere makes the document grow without bound and without a way to forget old versions. `src/editor.ts` calls `store.update(id, { text })` on every input event, so typing is quadratic in note length. One simulated session (40 notes typed per keystroke, 100 drags of 90 moves, 60 deletes on a 300-sticky board) took the document from 480 KB to 976 KB (81 KB to 169 KB gzipped) with gc off. Every client would pay that at load, in IndexedDB and in `.drift` files, and retention (dropping old versions) would be impossible.

Snapshots of the relay's state have none of these problems: the relay already holds the compacted state, retention is just deleting files, and clients keep gc on.

## Storage

```
<DATA_DIR>/history/<boardId>/index.json
<DATA_DIR>/history/<boardId>/<versionId>.yjs.gz
```

- A version file is `gzip(Y.encodeStateAsUpdate(room.doc))` of the **board** room (`objects`, `meta`, `flow`, `votes`). The comments room is never snapshotted. It is the same bytes `Room.save()` writes to `<boardId>.yjs`, compressed.
- `<boardId>` matches the existing board id pattern. `<versionId>` is 12 random bytes, base64url (16 characters, `^[A-Za-z0-9_-]{16}$`); both are validated before they touch a path.
- `index.json` is the authority: `{ "v": 1, "versions": [Entry, ...] }`, written to a temporary file and renamed, like room files. A version file is written before its index entry and removed after its entry is, so a crash leaves at most an orphan file; orphans older than an hour are deleted by the sweep. An unreadable index is renamed `index.json.corrupt-<ms>`, logged, and the board starts with no history (the relay never fails to start over it).
- The directory is created at the first snapshot. Boards that were never saved have none. Soft-deleted boards keep their history, and it comes back when an admin restores the board. Backups are copies of `DATA_DIR`, as for room files.
- Everything is synchronous, like `Room.save()` itself (`zlib.gzipSync`, `fs.writeFileSync`), so a snapshot cannot race another one and the shutdown path (`shutdown()` saves every room, then exits) cannot lose one. Measured on a 1.1 MB state (3,000 stickies): gzip 12 ms, sha256 1 ms.

No SQLite: history must work in open mode, which never loads `node:sqlite`.

### Entry (data model)

```
id         string        16 characters
createdAt  number        ms since the epoch, server clock
kind       'auto' | 'named' | 'pre-restore' | 'restore'
label      string | null named: 1 to 80 characters, trimmed, no control characters; other kinds null (the UI words them)
by         string | null account id of whoever saved, named or restored it; null for auto and in open mode
byName     string | null their name at that moment (open mode: optional, client supplied, at most 40 characters)
objects    number        size of the `objects` map, for the list
bytes      number        size of the stored file
hash       string        hex sha256 of the uncompressed state
from       string | null 'pre-restore' and 'restore': the id of the version being restored
```

The API returns every field except `hash`.

### Sizes

Measured, board room state, raw / gzipped: 300 stickies and 37 connectors 119 KB / 18.6 KB; 1,000 stickies 386 KB / 59 KB; 3,000 stickies 1.2 MB / 178 KB. The same 300-sticky board after the heavy session above (gc on) 480 KB / 81 KB: even with gc on a document grows by roughly 10 bytes per property write, so a snapshot is as large as the room file is at that moment.

## Taking snapshots

`Room.save()` (debounced 1 second after the last update, and run when the last person leaves, when a room unloads and at shutdown) calls `history.onSave(room, bytes)` with the bytes it just wrote, for board rooms only. Errors are caught and logged and never break saving. In order:

1. **Restore pending** (see `begin-restore`): if the board has one and the state differs from the newest version, write a `restore` version (`from` = the version restored). Ignores the interval.
2. **Before a large deletion**: the room keeps the bytes and object count of its previous save (one extra copy of the state per loaded board room). If the objects dropped by at least 10 and to 70% or less of the previous count, and the previous state is not already the newest version, write the previous state as an `auto` version. This is the board as it was just before someone cleared it, and it is the case interval snapshots miss most. The new, smaller state is not snapshotted by this rule.
3. **Interval**: if the board has no version yet, or the newest is at least 10 minutes old, and the state differs from the newest version, write `auto`.
4. **Idle**: if nobody is connected (the save when the last person leaves, or the one when the room unloads a minute later) and the newest version is at least 60 seconds old and differs, write `auto`. This is the "how it looked when everyone left" version.

The first rule that applies wins: one save writes at most one version.

"Differs" is a hash comparison, computed only when a write is otherwise due. It is not a comparison of Yjs state vectors: deleting an object leaves the state vector unchanged (measured), and deletions are exactly what a restore is for. A board that was only ever opened, never saved, gets no version. Existing boards get their first version at their first save after the upgrade.

Room saves have a maximum wait: `scheduleSave` was a pure debounce, so a room that never went quiet for a full second deferred its saves, and with them its snapshots. It now saves at least every 30 seconds of continuous editing (`saveDelay` in `server/save-delay.mjs`: the debounce delay, shortened so that the first unsaved change is never older than 30 seconds). This changes how often room files are written, not what is written.

## Retention

Constants at the top of `server/history.mjs`; there are **no new environment variables**. Pruning runs after every write, once at startup, and hourly (an `unref`'d timer) over all boards.

| Kind and age | Kept |
| --- | --- |
| `auto`, up to 24 hours old | all of them |
| `auto`, 1 to 7 days | the newest per UTC hour |
| `auto`, 7 to 30 days | the newest per UTC day |
| `auto`, older than 30 days | deleted |
| `pre-restore`, `restore` | 30 days, never thinned |
| `named` | until deleted; at most 100 per board (`409 limit`) |
| Budget | 64 MB of stored files for the non-named versions of one board. Past it the oldest `auto`, then the oldest `pre-restore`/`restore`, go first. The newest version is never pruned |

Worst case for a board edited around the clock is 311 `auto` versions (144 + 144 + 23): about 5.6 MB at 18 KB each, 25 MB at 81 KB, and 55 MB at 178 KB, close to the budget. Most boards are far below this.

Never two identical neighbours: when a version is wanted whose content equals the newest version's, the newest one is relabelled (named, or turned into `pre-restore`) instead of storing a copy.

Privacy note: history keeps what people deleted. Owners can delete any version, automatic versions expire, and nothing is kept for comments. Purging a leaked secret means deleting every version that still contains it.

## Server endpoints

All under `/api/boards/:id/versions`. Errors are the usual `{error, message}`.

```
GET    /api/boards/:id/versions
  -> 200 { versions: Version[] }                 newest first; bounded by retention, so no paging
GET    /api/boards/:id/versions/:vid/state
  -> 200 application/octet-stream                the stored gzip, sent with Content-Encoding: gzip (inflated for a client that does not accept it)
POST   /api/boards/:id/versions {label, by?}
  -> 201 Version                                 a new named version of the board as it is now
  -> 200 Version                                 the newest version already had exactly this content: it is named instead
     400 bad label | 409 limit (100 named) | 409 empty (the board has no saved state yet)
PATCH  /api/boards/:id/versions/:vid {label}
  -> 200 Version                                 names an unnamed version (kind becomes 'named') or renames a named one
DELETE /api/boards/:id/versions/:vid
  -> 204
POST   /api/boards/:id/versions/:vid/begin-restore {by?}
  -> 200 { preRestore: Version | null }
```

`begin-restore` does **not** change the board; the client does that. It authorises and records the restore: (1) checks the role and that the version exists; (2) saves the board as it is now as a `pre-restore` version (the durable undo, since Ctrl+Z only lasts for this tab); `null` when the room has no state; (3) marks a restore as pending for the board for 2 minutes, so the next save becomes a `restore` version; (4) writes the audit row. The server trusts the client's intent, as comments trust authorship (`docs/comments.md`): the audit row says who asked to restore and when, and the resulting edit is an ordinary board update.

The state of a room is read through `boardState(boardId)` supplied by the relay: `Y.encodeStateAsUpdate(room.doc)` when the room is loaded, otherwise the room file. These calls never create a room (`getRoom()` is not used), so nothing is loaded for someone who may not read it.

### Authorisation

**Accounts mode**: the routes go through `api.mjs` like the cloud routes, so session, CSRF (the API's custom header on POST, PATCH and DELETE), error format and the `402 read_only` rule of hosted workspaces come for free (the routes do not set `readOnlyOk`: GETs keep working in a read-only workspace, mutations answer `402`). The board is resolved with the existing `boardFor`: no access, or a deleted board, is `404`. The caller's board role must be `owner` or `editor`, otherwise `403 forbidden` ("Only editors can see version history"). Further rules:

- Naming an unnamed version: any editor. Renaming a named one: its creator or the board owner.
- Deleting: the board owner, any version; an editor, only a named version they created.
- A version id that belongs to another board is `404`.

**Open mode**: `/api/*` otherwise answers `404`, so `history.handleOpen(req, res)` is mounted in the relay's request handler for exactly these paths and nothing else. There is no session: everyone is an owner of every board. Mutating calls (`POST`, `PATCH`, `DELETE`) still pass the same CSRF check as the accounts API (the shared `csrfOk` of `server/auth.mjs`: the custom header, and when an `Origin` header is present, the same host as the request; `403 csrf` otherwise); reads need nothing, because anyone with the board link can already read the board. An unknown board answers `{ versions: [] }`. `by` is whatever name the client sends.

### Audit (accounts mode)

| Action | Detail |
| --- | --- |
| `board.version.create` | `{boardId, versionId, label}` |
| `board.version.rename` | `{boardId, versionId, label}` (also used when naming an unnamed version) |
| `board.version.delete` | `{boardId, versionId, kind}` |
| `board.version.restore` | `{boardId, versionId, preRestoreId}` (from `begin-restore`) |

Automatic versions and retention pruning are not audited. The admin dashboard's "Boards" filter (prefix `board.`) already matches; the four actions are added to its readable sentences.

## Restore (client)

Pure logic in `src/history.ts`:

```ts
planRestore(live: Store, snap: Store, opts: { isHidden: (o: Obj) => boolean }): RestorePlan   // { add, remove, change, meta, summary: {added, removed, changed} }
applyRestore(live: Store, plan: RestorePlan): void
```

Rules (a prototype of the object and meta steps confirmed that the result equals the snapshot, that a second peer converges and that one `undo()` reverts it):

- **Objects**: in the live board but not in the snapshot: deleted. In the snapshot but not live: created with its own id. In both: the live object's fields are made equal to the snapshot's (keys missing from the snapshot deleted, differing values set; values compared as JSON, like `Store.update`). A difference in `updatedAt` alone does not count as a change. A changed object takes the snapshot's `updatedAt` verbatim, like every other field: the transaction uses raw `Y.Map` set and delete, not `Store.update`, which stamps `updatedAt = Date.now()` and would make the result differ from the snapshot. Locked objects are restored like any other (locking guards the UI, not the data).
- **Meta**: every key of `meta` except `name` and `schemaVersion`. The board's title stays: it is the board's identity in the home list and in the directory.
- **Not touched**: `flow` and `votes` (session state, not content), the comments document, the board title.
- **Private writing**: objects hidden for this person by private writing (`isHiddenNow`: a sticky with `privateStep`, created by someone else, while the live `flow.reveal` is false) are skipped in both directions, so a restore never deletes or resurrects a note its author is hiding.
- **One transaction**: `store.undo.stopCapturing()`, then `store.transact(...)` (origin `local`, so it is undoable, and a read-only store runs nothing), then `stopCapturing()` again. Ctrl+Z reverts the whole restore in one step, in the tab that did it; other tabs and people just see another update.
- **Refused** (the Restore button is disabled with a reason): a read-only store (viewer, or a read-only hosted workspace); a running session (`flow.active >= 0`); a snapshot with `meta.schemaVersion` above `SCHEMA_VERSION`, the same rule as importing a file.
- **Empty plan** (the snapshot already matches): no server call, no write, a toast says so.

Order in the UI: build the plan, confirm, `begin-restore` (on any failure show the message and change nothing), then rebuild the plan against the board as it is by then and apply it, so edits made while the dialog was open are neither lost nor duplicated. The snapshot is downloaded once, cached in memory (the last 5; versions are immutable), and used for both preview and restore. Applying a plan for a few thousand objects is a single update of about the size of the state (1.2 MB for 3,000 stickies, below the relay's 32 MB message limit).

Concurrent editing is not special-cased: the restore is computed against the restorer's view; fields that others change at the same moment resolve last writer wins, like any two simultaneous edits.

### Comments room

Not versioned in this slice, and not touched by a restore. It is a separate document with a different write rule (commenters write it), and pins are anchored by object id with an `{x, y}` fallback (`docs/comments.md`), so they degrade sensibly: a restore that brings an object back (same id) re-attaches its pins; one that removes an object leaves its pins at the fallback position. Threads about things that no longer exist can appear; that is accepted.

## Preview

Read-only, and it never touches the live document, IndexedDB or the relay:

- `openSnapshot(bytes)` builds a throwaway `Y.Doc` with `Y.applyUpdate`, wraps it in a `Store` with `setReadOnly(true)`, and has no provider and no persistence.
- The UI mounts a second `Renderer` over that store in an overlay on the board surface, with `readOnly = true`, the snapshot's `gridType` and `gridSize`, opened fitted to the content (the preview's area differs from the board's, so the live camera would not line up), and a "Fit to content" button. Drag pans and the wheel zooms. It draws no comment pins, cursors or selection.
- `Renderer` has no disposal today (a font listener and a `ResizeObserver`), so it gains `destroy()`; closing the preview calls it and `doc.destroy()`.
- Hidden notes stay hidden: `isHiddenNow(o, userId, liveReveal)` is a small pure function over the **live** `flow.reveal` and the viewer's id, so history never shows more than the board does. It restates `Flow.isHidden` (which needs a `BoardApp`); a test pins its cases.
- The live board stays mounted underneath, covered by the opaque overlay with the rest of the board chrome hidden, and keeps receiving remote updates; the preview is a frozen picture.

## UI

- **Board menu**: "Version history" in the Board group, below "Board settings". Shown for owners, editors and in open mode; absent for commenters and viewers.
- **Panel** (right side, below the top bar like the Comments panel; `src/ui/history.css`): header "Version history" with **Save version** (asks for a name) and close; a segmented All / Named filter; versions grouped by day (Today, Yesterday, then dates). A row shows the time; the title (the label, or "Automatic version", "Before restore", "Restored a version"); "212 objects (-3)" computed from the neighbouring row (a sudden drop is easy to spot); and who, for named versions. Rows are buttons, arrow keys move between them, Enter opens the preview. The selected row shows Name or Rename and Delete (second click to confirm, as for comments) according to the roles table. The top row, "Current board", is selected by default.
- **States**: loading; empty ("No earlier versions yet. Versions are saved automatically while people edit."); error with Retry; and "Version history is stored on the server and needs a connection." when the relay is off, set to another host (the API is same-origin like the rest of `src/api.ts`) or unreachable, with Save version disabled.
- **Preview banner** over the board: "Viewing the version from {date, time}" and the label if any. Beside it the comparison with the live board, "Restoring adds 4, changes 7, removes 12 items" (recomputed shortly after the live board changes), and the buttons **Restore this version**, **Name this version** and **Back to current board** (Esc). The overlay and the panel stop key events from bubbling to the board's window handler (focus stays inside them across repaints), so shortcuts, Delete and nudging cannot reach the board underneath.
- **Look**: Swiss minimalist, following `src/ui/admin.css`. Theme variables and `color-mix()` only, with the existing text and background pairs (`--tray-text` on `--tray`, `--ink` on `--canvas`, `--on-signal` on `--signal`); `--signal` only for the primary action and the selected version, never as text on `--ink`. Dialogs use the shared 14px radius, trays and popovers 12px, and controls 8px; no added shadows, hairlines (`--rule`, `--tray-line`) and 2px ink rules; 11px uppercase labels; an 8px spacing grid. At phone width a 16px gutter, no horizontal scroll, and the list gives way to the preview while one is open.
- **Restore dialog** (the existing `dialog()` helper): "Restore this version?", the counts, and "Everyone on the board will see it change. The board as it is now is saved first as a version, and you can undo this with Ctrl+Z." On success a toast, "Version restored. Press Ctrl+Z to undo."
- In a read-only hosted workspace the panel and preview work; Save, Name, Delete and Restore are disabled with the workspace's read-only message.
- Fetches go through `src/api.ts` (so the CSRF header name lives in one place). In open mode the client passes its presence name as `by`.

## Roles

| Role | See list and preview | Save or name a version | Rename or delete | Restore |
| --- | --- | --- | --- | --- |
| `owner` (also workspace owners and admins) | yes | yes | any version | yes |
| `editor` (also team members) | yes | yes | named versions they created | yes |
| `commenter` | no (`403`) | no | no | no |
| `viewer` | no (`403`) | no | no | no |
| Open mode | everyone | everyone | everyone | everyone |
| Hosted workspace, read-only | list and preview | no (`402`) | no (`402`) | no (`402`) |

Decision: read-only roles do not get history in this slice. Snapshots contain content that was later removed on purpose, and read-only roles are limited to the board as it is. Relaxing this (for example, named versions visible to viewers) is a later, deliberate step. Restoring needs the same right as editing the board; the relay would drop a non-writer's update anyway, so this adds no new enforcement beyond the API checks above.

## Offline and open mode

- **Open mode with the relay** (the default): the same server snapshots and the same UI; everyone acts as owner, authorship is asserted by clients, and there is no audit.
- **No relay** (relay setting `off`), **a relay on another host**, or the relay unreachable: history needs the server, and the panel says so. What works locally is what already does: Ctrl+Z in the tab (until it is reloaded) and exporting a `.drift` or JSON file as a manual copy before a risky change. A `.drift` is a full copy of the board as of the export; it cannot recover content deleted earlier (see above).
- Editing offline and reconnecting: edits sync as today; the relay snapshots what it has saved, so a version never contains state that has not reached the server.

## Tests

`test/history.test.ts` (in process; `createHistory({ dataDir, directory, boardState, now })` takes an injected clock, like `directory.mjs`):

- Restore: the live objects equal the snapshot's after `applyRestore` (create, delete, change, remove a field, nested JSON values such as `points` or a connector end); `meta` is restored except `name` and `schemaVersion`; `updatedAt`-only differences are not changes and a changed object takes the snapshot's `updatedAt`; one `undo()` restores the pre-restore state even when a remote peer edited in between; a second peer converges after the restore update; `flow`, `votes` and the comments document are untouched; private notes of others are neither deleted nor resurrected; refused for a read-only store (callback never runs), a running session and a newer `schemaVersion`; an empty plan runs no transaction and leaves the undo stack alone; `openSnapshot` emits no update on the live doc and is read-only; `isHiddenNow` cases; the summary counts.
- Server module: first save writes an `auto` version; an unchanged state writes none; a delete-only change counts as a change; the interval, idle (60 s) and large-deletion rules with the clock injected; a pending restore becomes a `restore` version at the next save and expires after 2 minutes; naming when the newest version has the same content stores no second file; thinning at 23 h, 25 h, 8 days and 31 days; the byte budget (newest never pruned, named exempt); the 100-named limit; a corrupt index, an orphan file and ids that try to escape the directory.

`test/history-server.test.ts` (black box: the relay spawned in open and accounts mode, like `test/comments-rooms.test.ts`):

- Accounts: `401` signed out; `404` without access and for a deleted board; `403` for viewer and commenter; `200` for editor and owner; `403 csrf` without the header; a `402` for POST, PATCH, DELETE and `begin-restore` in a read-only hosted workspace while GETs work; a version id of another board is `404`; an editor cannot delete another editor's named version, the owner can.
- A named version's `state` applied to a `Y.Doc` equals the room's state at that moment; `begin-restore` creates a `pre-restore` version equal to the earlier state, and after a client update over the socket the next save adds a `restore` version with `from`.
- Audit rows for create, rename, delete and restore; none for automatic versions.
- Open mode: the routes work without a cookie; a mutation without the CSRF header, or with a foreign `Origin`, is refused; an unknown board lists `[]`; every other `/api/*` path still answers `404`.
- No `history/` directory for a board that was never saved; nothing written for comments rooms; the room file and the existing suites behave as before.

`test/admin.test.ts` gains the four new audit actions in the known list and their sentences. `test/save-delay.test.ts` covers `saveDelay`: the plain debounce, the shortened delay once the first unsaved change is 29 seconds old, and a delay of zero beyond the maximum wait; `test/relay-save.test.ts` runs the relay and checks that a room edited without a pause is written within about 30 seconds. The exported `csrfOk` and `CSRF_HEADER` are covered in `test/history.test.ts` (the existing `createAuth` tests keep covering the rule itself).

## Not in this slice

- Highlighting what changed (visual diff) or comparing two versions; restoring part of a version (select objects and bring them back).
- Local snapshots in IndexedDB for the relay-off case, and exporting an older version as a file.
- History for the comments room; restoring `flow`, `votes` or the board title.
- Viewers or commenters seeing named versions; notifications such as "Ana restored a version"; a purge-all-history action for secrets.
- An operator switch to turn history off or tune the numbers (no environment variables yet).
- Schema migrations when restoring a version saved under an older `schemaVersion` (there is only version 1).
- Storage accounting or quotas for hosted workspaces.

## Files

New:

- `server/history.mjs`: storage (index and version files), `createHistory`, snapshot rules and retention, `onSave`, the shared actions, `routes(ctx)` for the accounts API, `handleOpen` for open mode.
- `server/save-delay.mjs`: `saveDelay`, the pure save-timing rule (debounce with a maximum wait).
- `src/history.ts`: `Version` type, `planRestore`, `applyRestore`, `openSnapshot`, `isHiddenNow`, summaries, grouping by day, the snapshot cache.
- `src/ui/history.ts`: `mountHistory(app, chrome)`: panel, preview overlay, restore dialog.
- `src/ui/history.css`: panel and overlay styles.
- `test/history.test.ts`, `test/history-server.test.ts`, `test/save-delay.test.ts` (the timing rule) and `test/relay-save.test.ts` (the relay itself, with an update every 300 ms for about 30 seconds).

Existing, registration-level lines only (`src/app.ts`, `src/sync.ts`, `src/store.ts`, `server/config.mjs`, `server/directory.mjs` are not touched, which keeps clear of the parallel rename):

- `server/relay.mjs`: import and create `history` (both modes), `history?.onSave(this, bytes)` in `Room.save()`, a `boardState(id)` helper, the open-mode branch in `onRequest`, `history` passed to `createApi`, and `saveDelay` in `scheduleSave` (the 30 second maximum wait).
- `server/api.mjs`: accept `history`, spread `...(history ? history.routes({ compile, boardFor, audit, errors }) : [])` next to the cloud routes, and let `send()` write a `Buffer` with headers.
- `server/auth.mjs`: `csrfOk` becomes a module-level export that `createAuth` returns unchanged, so open mode can run the same check without an `auth` object, and the header name becomes an exported constant (`CSRF_HEADER`) that tests use.
- `src/api.ts`: the `Version` type and six methods (`versions`, `versionState`, `saveVersion`, `nameVersion`, `deleteVersion`, `beginRestore`). `versionState` fetches the bytes directly with the same headers and error mapping, because the shared `call()` parses every body as JSON.
- `src/ui/board.ts`: import and mount `mountHistory` next to the comments, one menu item, and the `.drift` menu hint "Full history" becomes "Board with its sync data" (the file does not hold deleted content).
- `src/render.ts`: `Renderer.destroy()`.
- `src/ui/dom.ts`: a `history` icon.
- `src/ui/admin-logic.ts`: the four audit actions and their sentences.
- `test/admin.test.ts`: the audit actions.
- `docs/accounts.md`: the open-mode `404` sentence points here, the audit action list, the new data directory.
- `README.md`: a Version history row in the feature table, the `.drift` description corrected, and "version history" removed from "Not built yet".
- Fragments in `changelog.d/` (see `changelog.d/README.md`): an Added entry for version history and Changed entries for the `.drift` hint and room save maximum wait.

## Decisions

Taken when the spec was reviewed:

1. Open mode gets server history too, exactly as above (a small handler for these paths, same behaviour, no audit). It is the only place `/api/*` stops being all `404` in open mode.
2. Read-only roles (viewers, commenters) see no history.
3. The numbers stand: 10 minute interval, 24 hour / 7 day / 30 day thinning, 64 MB budget, 100 named versions, the 10 objects / 70% large-deletion rule.
4. No environment variables, so there is no operator switch to turn history off.
5. Files rather than a SQLite table, to keep open mode on one code path.
6. The `.drift` menu hint "Full history" is reworded ("Board with its sync data"), since deleted content is not in the file. Add a Changed fragment in `changelog.d/` (see `changelog.d/README.md`).
7. Restore is refused while a session runs.
8. Room saves get a maximum wait of 30 seconds (`scheduleSave`), so continuous editing no longer defers saves and snapshots. Add a Changed fragment in `changelog.d/` (see `changelog.d/README.md`).
