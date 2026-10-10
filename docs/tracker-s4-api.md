# Tracker slice 4 REST: linked kanbans

Status: contract for the server side of slice 4 (one-way SQL-to-card projection). It sits next to `docs/tracker-api.md` and follows its conventions: session cookie, `x-tabula: 1` on mutations, error shape `{ error, message, path? }`, everything behind `TABULA_TRACKER=on`. Schema is migration 15 (expand-only, `min_reader` 11): `kanban_tracker_links`, `kanban_state_mappings`, `ticket_links`, `ticket_projection_outbox` (`docs/tracker-architecture.md` section 1).

## Rules

- A kanban container on a board is linked to the workspace tracker once (one active link per `(boardId, kanbanId)`).
- `mapping` is `{ [laneId]: stateKey }`. One state per lane and one lane per state. Every `laneId` must be a lane of that kanban; every `stateKey` must be an active state of the tracker's workflow. Lanes left out stay unmapped: tickets cannot be created or moved into them.
- Access: the actor must be an owner or editor of the board and have tracker write. Viewers and guests get `403 forbidden`; a board the actor cannot see is `404 not_found`. Hosted read-only gives `403 read_only`. Reads (`GET`) need board read access and tracker read.
- The server writes `extProvider:'tabula'`, `extKey`, `extUrl`, `trackerId` and the `tracker` projection on linked cards, and `ext:{provider, tracker, map}` on the container. Clients and MCP cannot set these fields.
- A tracker state change moves the card to the mapped lane. If the state has no lane the card stays where it is with an "unmapped state" marker. Lane moves on the board go through the existing board path and are not propagated back in this slice (one-way projection).
- Projection is applied after the SQL commit, driven by the outbox, and retried when the room loads. When the room could not be written at once the response carries `projectionPending: true`; the SQL result stands.

## Objects

Link (`pendingProjections` counts card updates not yet written to the board; poll `GET /links` until it is 0 when a response said `projectionPending: true`; the feed carries no projection events):

```json
{
  "id": "lnk_...",
  "boardId": "...",
  "kanbanId": "...",
  "workflowId": "...",
  "mapping": [{ "laneId": "...", "stateKey": "todo", "stateId": "..." }],
  "cardCount": 17,
  "pendingProjections": 0,
  "createdAt": 1760000000000,
  "createdBy": "userId"
}
```

## Routes

| Method and path | Request | Success response |
| --- | --- | --- |
| `GET /api/tracker/links?boardId=` | `boardId` required; optional `kanbanId` | `200 { links: Link[] }` (active links only) |
| `GET /api/tracker/links/suggest?boardId=&kanbanId=` | both required | `200 { mapping, lanes, stateNotMapped, nextKey, cardCount }` |
| `POST /api/tracker/links` | body below | `201 { link, created, skipped, projectionPending }` |
| `DELETE /api/tracker/links/:id` | none | `200 { link, unlinked }` |
| `POST /api/tracker/links/:id/cards` | `{ cardId, idempotencyKey }` | `201 { ticket, cardId, projectionPending }` |

### `GET /api/tracker/links/suggest`

Read-only. Suggests a mapping from lane names and state names and categories (lane name equals a state name or key, case-insensitive, first; then the default stage mapping todo, doing, done to unstarted, started, completed; one state per lane, one lane per state).

```json
{
  "mapping": { "<laneId>": "todo", "<laneId>": "done" },
  "lanes": [
    { "laneId": "...", "name": "Backlog", "stateKey": null },
    { "laneId": "...", "name": "Doing", "stateKey": "in_progress" }
  ],
  "stateNotMapped": ["cancelled"],
  "nextKey": "TAB-124",
  "cardCount": 18
}
```

`stateNotMapped` lists active state keys with no suggested lane (the dialog warns that cards moved there in the tracker will leave the board). `nextKey` is the key the first created ticket would get; it is advisory and the real keys come from `created`. Errors: `404 not_found` (board or kanban), `409 conflict` when the kanban is already linked (`path: "kanbanId"`).

### `POST /api/tracker/links`

```json
{
  "boardId": "...",
  "kanbanId": "...",
  "mapping": { "<laneId>": "todo" },
  "createTickets": true,
  "project": "Launch",
  "labels": ["design"],
  "idempotencyKey": "8 to 64 characters"
}
```

`createTickets` defaults to false. When true, one ticket is created for every existing card in a mapped lane, in one SQL transaction with the link: title from the card text, `desc` as description, owner as assignee (when the owner is a member), due, the card's labels by name; `project` (by name, may be `null`) and `labels` (by name, extra) apply to every created ticket. The ticket state is the one mapped to the card's lane. Cards in unmapped lanes, and cards that already carry a link, are returned in `skipped` as `{ cardId, reason }` (`unmapped_lane`, `already_linked`, `empty_title`) and no ticket is made.

Response:

```json
{
  "link": { "...": "Link" },
  "created": [{ "cardId": "...", "ticket": { "key": "TAB-124", "...": "ticket row as in tracker-api.md" } }],
  "skipped": [{ "cardId": "...", "reason": "unmapped_lane" }],
  "projectionPending": false
}
```

`idempotencyKey` makes a retry return the first result without making a second link or tickets. Errors (all `path`-carrying where it applies):

| Status | Error | Cause |
| --- | --- | --- |
| 400 | `invalid_input` | `mapping.<laneId>` is not a lane of the kanban, two lanes map one state, two states on one lane (impossible in the object form; duplicates are rejected on repeated keys), an unknown `stateKey` (`path: "mapping.<laneId>"`), unknown `project` or label name, bad `idempotencyKey` |
| 403 | `forbidden`, `read_only` | not a board editor/owner with tracker write; hosted read-only |
| 404 | `not_found` | board or kanban unknown to the actor |
| 409 | `conflict` | kanban already linked (`path: "kanbanId"`) |
| 413 | `limit_exceeded` | more than 500 cards to create at once (`path: "createTickets"`); link the kanban without creating, then create per card |
| 429 | `rate_limited` | tracker mutation window |

### `DELETE /api/tracker/links/:id`

Removes the link (`removedAt` set). Tickets are kept as they are, nothing is deleted. The cards stay on the board as ordinary cards: the server strips `extProvider`, `extKey`, `extUrl`, `trackerId` and the `tracker` projection from them and `ext` from the container. Response `{ link: { ...Link, removedAt }, unlinked: <number of cards>, projectionPending }`. A second DELETE of the same id is `404 not_found`.

### `POST /api/tracker/links/:id/cards`

Creates a ticket for one card of a linked kanban that has none yet (a card added after linking). State comes from the card's lane; the lane must be mapped. Errors: `400 invalid_input` (`path: "cardId"`, card is not on this kanban or its lane is unmapped), `409 conflict` (card already linked).

## Ticket rows and `links[]`

A ticket linked to a card gains `{ "kind": "card", "boardId", "kanbanId", "cardId", "linkId" }` entries in its `links[]` (merged with PR and commit links). The entry is visible only if the actor can read that board.

## Not in this slice

Lane move to ticket transition from the board (two-way), mapping edit after linking (PATCH), and multiple cards per ticket on one kanban. These land with later slices; the DELETE and re-link route is the path until then.
