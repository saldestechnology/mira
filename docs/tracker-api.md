# Tracker REST API

Slice 4 (linked kanbans) endpoints: see `docs/tracker-s4-api.md` once merged.

This reference describes the session REST API mounted at `/api/tracker/`. It is derived from `server/tracker/api-routes.mjs`, `server/tracker/inbox-routes.mjs`, their supporting modules, and the REST route tests. It does not describe the separate MCP interface.

## Access and request protection

- `TABULA_TRACKER` defaults to `off`; the only accepted values are `on` and `off`. The core tracker routes are registered only when account authentication and the tracker feature are both enabled. Inbox and notification preference routes are registered when the tracker feature is enabled and still require a signed-in session.
- Send the Tabula session cookie. A bearer MCP token by itself does not authenticate these REST routes. Missing or expired sessions return `401 unauthenticated`.
- Safe methods (`GET`, `HEAD`, `OPTIONS`) do not need a CSRF header. State-changing requests need `x-tabula: 1`; the legacy `x-mira: 1` header is also accepted. If an `Origin` header is present, its host must match the request `Host`. A failed check returns `403 csrf`.
- Core tracker routes are available to workspace owners, admins, members, and viewers. Viewers may read but cannot write. Guest-link requests to tracker paths are hidden as `404`; core routes do not use linked-board access as a substitute for workspace tracker access. `GET /api/me` includes `tracker: true` only when the signed-in user can access the enabled core tracker; otherwise the key is omitted. Inbox rows are personal and are filtered against the caller's current ticket access, including linked-board access where applicable.
- Hosted read-only mode leaves core reads available and rejects core tracker mutations with `403 read_only`. Inbox read, mark-read, and preference routes do not use the tracker mutation limiter; inbox writes follow the general API path and return `402 read_only` in hosted read-only mode.

For examples, set `TABULA_URL` to the server origin and `TABULA_COOKIE` to the session cookie value. Include the CSRF header on every mutation.

## Common responses and limits

Errors are JSON objects with `error` and `message`; core tracker validation errors may also include `path`, and optimistic conflicts may include the current `ticket`.

| Status | Error code(s) | When it is returned |
| --- | --- | --- |
| 400 | `invalid_input`, `invalid_filter`, `bad_request` | Invalid fields, filters, cursors, query values, JSON, or inbox input |
| 401 | `unauthenticated` | No valid session |
| 402 | `read_only` | General API write rejected in hosted read-only mode, including inbox writes |
| 403 | `csrf`, `forbidden`, `read_only` | CSRF failure, write access denied, or core tracker write in hosted read-only mode |
| 404 | `not_found` | Missing or inaccessible resources, hidden guest access, or disabled/unregistered route |
| 405 | `method_not_allowed` | A known route was called with an unsupported method; the response includes an `Allow` header |
| 409 | `conflict` | Stale ticket update or a conflicting operation |
| 413 | `limit_exceeded`, `payload_too_large` | A documented tracker limit or request-body size was exceeded |
| 429 | `rate_limited` | Core tracker mutation window is full; the response includes `Retry-After` in seconds |
| 500 | `internal` | Unexpected server error |

JSON request bodies are limited to 64 KiB by default; inbox read and notification preference bodies are limited to 8 KiB. Core tracker mutations are limited to 60 per signed-in user in a fixed 60-second window. A bulk request counts as one mutation. The limiter covers routes marked as tracker mutations, including ticket, label, project, milestone, view, relation, comment, archive/restore, and subscription writes. It does not cover inbox reads, mark-read, or notification preference writes.

## Metadata

### `GET /api/tracker/meta`

Returns `enabled`, `trackerId`, `prefix`, `states[]`, `labels[]`, `members[]`, active `projects[]`, active `milestones[]`, accessible `views[]`, and `me`. State rows contain `id`, `key`, `name`, `category`, and `position`; labels contain `id`, `name`, and `color`; members are active owners, admins, and members and contain `userId`, `name`, and `initials` (no email). Project entries contain `id`, `name`, and `state`; milestone entries contain `id`, `name`, `projectId`, and `due`; view entries contain `id`, `name`, `shared`, and `mine`. `me` contains `userId`, `canWrite`, and `canCreate`; hosted read-only mode makes the latter two false.

```sh
curl -b "$TABULA_COOKIE" "$TABULA_URL/api/tracker/meta"
```

## Tickets

### Routes

| Method and path | Request | Success response |
| --- | --- | --- |
| `GET /api/tracker/tickets` | Optional `q`, repeated `filter`, `limit`, `cursor`; or `updatedSince` | Page: `{ tickets, nextCursor }`; incremental poll: `{ tickets, seq, more? }` |
| `POST /api/tracker/tickets` | `title`, optional `description`, `state`, `priority`, `assignee` or `assigneeId`, `labels`, `due`, `parent`; required `idempotencyKey` | `201 { ticket }` |
| `GET /api/tracker/tickets/:key` | Ticket key or alias | `{ ticket, comments, events, subscribed, resolvedKey? }` |
| `PATCH /api/tracker/tickets/:key` | Any supported ticket patch fields below; optional `ifUpdatedSeq` | `{ ticket }` |
| `POST /api/tracker/tickets/:key/transition` | `{ state }` | `{ ticket }` |
| `POST /api/tracker/tickets/:key/archive` | No body | `{ ticket }` |
| `POST /api/tracker/tickets/:key/restore` | No body | `{ ticket }` |
| `POST /api/tracker/tickets/bulk` | `{ keys, patch }` | `{ batchId, results }` |

Ticket keys and aliases are matched without regard to case. An alias detail lookup includes `resolvedKey` with the canonical key.

A full ticket object contains `id`, `key`, `trackerId`, `title`, `description`, `state { id, key, name, category }`, `priority` (`none`, `urgent`, `high`, `medium`, or `low`), `assignee { userId, name } | null`, `creator { type, id, name }`, `labels[]` (`id`, `name`, `color`), `project { id, name } | null`, `milestone { id, name, due } | null`, `estimate`, `due`, `parent`, `relations[]` (`kind`, `key`), `links[]`, `aliases[]`, `archivedAt`, `createdAt`, `updatedAt`, and `updatedSeq`. List/search rows are summaries: `id`, `key`, `title`, `state`, `assignee`, `project`, `due`, `archivedAt`, `updatedAt`, `updatedSeq`, and `snippet`, plus row extras described below. Do not expect list rows to contain every detail field.

Ticket creation requires an 8–64 character `idempotencyKey`. Supply at most one of `assignee` and `assigneeId`; the former accepts `"me"`, an active member name, or an email, while the latter accepts an active workspace member ID or `null`. `state` accepts an active workflow state name or key; `priority` is `none`, `urgent`, `high`, `medium`, or `low`. `labels` is a list of active label names (up to 20; each name is limited to 64 characters) and replaces the set on update. `due` is a calendar date in `YYYY-MM-DD`; `parent` is a ticket key or `null`. A patch may include `title`, `description`, `state`, `priority`, `assignee`, `assigneeId`, `labels`, `due`, `parent`, `project`, `milestone`, or `archived`. Set `archived` to a boolean. `project` accepts an active project name or `null`; `milestone` accepts an active milestone name or `null`, and may be ambiguous when names repeat across projects. Other fields accept `null` only where their validators allow it.

If `ifUpdatedSeq` does not match the current ticket sequence, the update returns `409 conflict` and includes the current ticket. The archive and restore routes are aliases for setting `archived` to `true` and `false`.

A bulk patch accepts up to 50 distinct keys and fields `state`, `priority`, `assignee` or `assigneeId`, `labels`, `labelsAdd`, `labelsRemove`, `project`, `milestone`, `due`, and `archived`. Each ticket is handled independently. Each result is either `{ key, ok: true, ticket, before }` or `{ key, ok: false, error: { error, message, path? }, ticket? }`; the current ticket may be included for a conflict. Bulk patches do not accept `ifUpdatedSeq`.

Ticket list/search pagination:

- `limit` defaults to 20 and must be from 1 to 50.
- `cursor` is opaque and is bound to the normalized query and filters. Reuse it only with the same `q` and `filter` values.
- `q` is limited to 512 Unicode code points. Search snippets escape HTML and use only `<mark>` tags around matches.
- Repeated `filter=field:value` tokens are ANDed; at most 20 are allowed. Supported forms are:
  - `assignee:me` or `assignee:<exact active member name or email>` (case-insensitive)
  - `state:<state key or name>`
  - `label:<label name>`
  - `due:overdue`, `due:today`, or `due:before-YYYY-MM-DD`
  - `is:archived`
  - `created:after-YYYY-MM-DD` (inclusive from UTC start of that date)
- Archived tickets are excluded unless `is:archived` is present. `due:today` uses UTC; `due:overdue` excludes archived, completed, and canceled tickets. `due:before-...` is strictly before the given date.
- `has:link` parses but currently returns no matches. `project` and `milestone` filters are unavailable and return `400 invalid_filter`. Other unsupported tokens also return `400 invalid_filter`.

For incremental ticket polling, send `updatedSince=<sequence>`. The response contains up to 200 tickets with `updatedSeq > updatedSince`, ordered by sequence, plus the current maximum `seq`. If `more: true` is present, continue from the last returned ticket's `updatedSeq`.

```sh
curl -b "$TABULA_COOKIE" --get "$TABULA_URL/api/tracker/tickets" \
  --data-urlencode 'filter=state:started' \
  --data-urlencode 'filter=assignee:me' \
  --data-urlencode 'limit=20'
```

### Ticket comments and events

| Method and path | Request | Success response |
| --- | --- | --- |
| `GET /api/tracker/tickets/:key/comments` | Optional `before` comment ID and `limit` | `{ comments, nextBefore }` |
| `GET /api/tracker/tickets/:key/events` | Optional `before` event ID and `limit` | `{ events, nextBefore }` |
| `POST /api/tracker/tickets/:key/comments` | `{ body, clientId? }` | `201 { comment, ticket }` |
| `PATCH /api/tracker/tickets/:key/comments/:id` | `{ body }`; author only | `{ comment, ticket }` |
| `DELETE /api/tracker/tickets/:key/comments/:id` | No body; author or workspace owner/admin | `{ comment, ticket }` |

The detail response embeds up to the latest 50 comments and 50 events. The separate routes default to 50 items and accept `limit=1..100`; `before` must identify an item on that ticket. Pages are displayed oldest first and `nextBefore` retrieves an older page. Comment rows contain `id`, `author`, `body` when not deleted, `createdAt`, `edited`, `deleted`, and `actorType`. Deleted comments are tombstones without `body`. Event rows contain `eventSeq`, `eventType`, `schemaVersion`, `actor { type, id }`, `source`, `createdAt`, `before`, `after`, and `details`.

`clientId` on comment creation is optional and makes retries idempotent. Editing is limited to the author. Deletion is soft; a workspace owner or admin may also delete a comment. Deleted comments are omitted from counts and ticket search text. Comment edit events record the comment ID and new body length, not the body.

```sh
curl -b "$TABULA_COOKIE" -H 'content-type: application/json' \
  -H 'x-tabula: 1' -H "Origin: $TABULA_URL" \
  -d '{"body":"The retry path is covered.","clientId":"comment-client-17"}' \
  "$TABULA_URL/api/tracker/tickets/TAB-12/comments"
```

### Relations and subscriptions

| Method and path | Request | Success response |
| --- | --- | --- |
| `POST /api/tracker/tickets/:key/relations` | `{ relation, otherKey }` | `{ ticket }` |
| `DELETE /api/tracker/tickets/:key/relations` | `relation` and `otherKey` in JSON body or query | `{ ticket }` |
| `PUT /api/tracker/tickets/:key/subscription` | No body | `{ subscribed: true }` |
| `DELETE /api/tracker/tickets/:key/subscription` | No body | `{ subscribed: false }` |

Relation kinds are `blocks`, `blocked_by`, `relates_to`, `duplicates`, and `duplicated_by`. A ticket can have at most 100 relations. For relation deletion, when the same field appears in both the JSON body and query string, the values must match. A blocking cycle returns `409 conflict` with the current ticket. Subscription operations are idempotent and do not create ticket activity events.

```sh
curl -b "$TABULA_COOKIE" -H 'content-type: application/json' \
  -H 'x-tabula: 1' -H "Origin: $TABULA_URL" \
  -d '{"relation":"blocks","otherKey":"TAB-13"}' \
  "$TABULA_URL/api/tracker/tickets/TAB-12/relations"
```

`commentCount` counts non-deleted comments; `subIssueCount` counts all child tickets, including archived children; `subIssueDone` counts children in completed or canceled states; `blocked` is true when an active blocking relation points to the ticket. Ticket list, detail, and mutation responses include these row extras plus `prs`, which is currently `null`.

## Labels

### Routes

- `GET /api/tracker/labels` returns `{ labels: [...] }`; each label has `id`, `name`, `color`, and `createdAt`.
- `POST /api/tracker/labels` accepts `{ name, color? }`, where color is `#RRGGBB` or `null`, and returns `201 { label }`. An active duplicate name returns `409 conflict`.

```sh
curl -b "$TABULA_COOKIE" -H 'content-type: application/json' \
  -H 'x-tabula: 1' -H "Origin: $TABULA_URL" \
  -d '{"name":"Bug","color":"#D02020"}' "$TABULA_URL/api/tracker/labels"
```

## Projects and milestones

### Routes

| Method and path | Request | Success response |
| --- | --- | --- |
| `GET /api/tracker/projects` | Optional `archived=0|1` | `{ projects }` |
| `POST /api/tracker/projects` | `{ name, description?, state?, ownerId? }` | `201 { project }` |
| `GET /api/tracker/projects/:id` | Project ID | `{ project }` |
| `PATCH /api/tracker/projects/:id` | `name?`, `description?`, `state?`, `ownerId?`, `archived?` | `{ project }` |
| `GET /api/tracker/projects/:id/milestones` | Project ID | `{ milestones }` |
| `POST /api/tracker/projects/:id/milestones` | `{ name, description?, due, state? }` | `201 { milestone }` |
| `PATCH /api/tracker/milestones/:id` | `name?`, `description?`, `due?`, `state?`, `archived?` | `{ milestone }` |

Projects are active by default; `archived=1` includes archived rows, and `GET /api/tracker/projects/:id` can read an archived project. Project rows contain `id`, `name`, `description`, `state`, `owner { userId, name } | null`, `createdAt`, `updatedAt`, `archivedAt`, `ticketCount`, and `doneCount`. Project states are `planned`, `started`, `paused`, `completed`, and `canceled`. `ownerId` accepts an active workspace member ID, `"me"`, or `null` to clear the owner; project names are limited to 100 characters.

The project milestones route lists active milestones. Milestone rows contain `id`, `projectId`, `projectName`, `name`, `description`, `due`, `state`, `createdAt`, `updatedAt`, `archivedAt`, `ticketCount`, and `doneCount`. Milestone states are `planned`, `started`, and `completed`. Creating a milestone requires a calendar-valid `YYYY-MM-DD` due date; patching may set `due: null`. Names are limited to 100 characters. Projects allow at most 200 active rows; each project allows at most 50 active milestones. Counts include archived tickets; `doneCount` includes completed or canceled states.

```sh
curl -b "$TABULA_COOKIE" -H 'content-type: application/json' \
  -H 'x-tabula: 1' -H "Origin: $TABULA_URL" \
  -d '{"name":"Payments","state":"started","ownerId":"me"}' \
  "$TABULA_URL/api/tracker/projects"
```

## Saved views

### Routes

- `GET /api/tracker/views` returns the caller's views and shared views.
- `POST /api/tracker/views` accepts `{ name, filter, shared? }` and returns `201 { view }`.
- `GET /api/tracker/views/:id/tickets` accepts `limit` and `cursor`; returns `{ view, tickets, nextCursor }`.
- `PATCH /api/tracker/views/:id` accepts optional `name`, `filter`, and `shared`; only the owner may update.
- `DELETE /api/tracker/views/:id` is owner-only and returns `204` with no body.

A view has base fields `id`, `ownerUserId`, `name`, `filter[]`, `sort`, `shared`, `createdAt`, and `updatedAt`. List/create/patch responses also add `owner { userId, name }`, `ownerName`, and `mine`; the nested `view` in the tickets response contains the base fields. The sort is currently `updated_desc`. Names are limited to 80 characters, filters use the ticket filter grammar and allow at most 20 tokens, and each member may own at most 100 views. The serialized query is limited to 8 KB.

```sh
curl -b "$TABULA_COOKIE" -H 'content-type: application/json' \
  -H 'x-tabula: 1' -H "Origin: $TABULA_URL" \
  -d '{"name":"My started work","filter":["state:started"],"shared":false}' \
  "$TABULA_URL/api/tracker/views"
```

## Activity feed

### `GET /api/tracker/feed?since=<sequence>`

Returns `{ events, seq }`. Events are readable ticket events in ascending ID order and contain `id`, `ticketKey`, `eventType`, `at`, and `actor { type, id, name }`. At most 200 events are returned. With no `since` or `since=0`, the response has no events and gives the current maximum `seq`; save it, then poll with that sequence. When a page has 200 events, continue from the last returned event ID. For a shorter page, continue from `seq`.

```sh
curl -b "$TABULA_COOKIE" "$TABULA_URL/api/tracker/feed?since=123"
```

## Inbox and notification preferences

### Routes

| Method and path | Request | Success response |
| --- | --- | --- |
| `GET /api/tracker/inbox` | Optional `limit`, opaque `before`, `unread=1` | `{ items, nextCursor, unread }` |
| `GET /api/tracker/inbox/unread` | None | `{ unread }` |
| `POST /api/tracker/inbox/read` | `{ ids: string[] }` or `{ all: true }` | `{ updated, unread }` |
| `GET /api/tracker/notification-prefs` | None | `{ kinds, prefs }` |
| `PUT /api/tracker/notification-prefs` | `{ prefs }` | `{ kinds, prefs }` |

Inbox rows are newest first and contain `id`, `kind`, `createdAt`, `readAt`, `ticket { key, title, state, assignee, priority }`, `actor { name } | null`, `preview`, and `detail`. `preview` is nullable text. `detail` is null or a kind-specific object: status changes use `{ state }`, relation changes use `{ key, relation }`, integration activity uses `{ text }`, and due-soon notices use `{ dueDate }`; other kinds currently return null. Limit defaults to 30 and is clamped to 1–50. `unread=1` filters to unread rows. Use the opaque `before` cursor from `nextCursor` to fetch older rows. The response's `unread` is the caller's current unread count.

Mark-read accepts at most 100 nonempty string IDs, or `{ all: true }`; do not send both. It only changes the caller's notifications. Both inbox write bodies are limited to 8 KiB. Preference kinds are `assigned`, `mentioned`, `commented`, `status_changed`, `due_soon`, `relation_changed`, and `integration_activity`. Each preference accepts `both`, `app`, or `off`; omitted preferences keep their current values. Initial defaults are `both` for `assigned`, `mentioned`, and `due_soon`, and `app` for the other kinds.

Inbox input validation and invalid inbox cursors use `400 bad_request` (the inbox route wrapper maps its validation errors); an invalid `limit` value that is not numeric also returns `400 bad_request`.

```sh
curl -b "$TABULA_COOKIE" -H 'content-type: application/json' \
  -H 'x-tabula: 1' -H "Origin: $TABULA_URL" \
  -d '{"prefs":{"assigned":"both","commented":"off"}}' \
  "$TABULA_URL/api/tracker/notification-prefs"
```
