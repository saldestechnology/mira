# Team chat

TAB-132. Status: slices 1 (the server), 2 (board chat in the app), 3 (team and workspace channels, the Chat page, the retention job), 4 (reactions, mention notices, the mention email) 5 (removed members, erasure, the chat export, the title prefix) and 6 (object chips and **Reference selection**) are built, so slices 1 to 6 are all built. Built in slice 1: `TABULA_CHAT` (on by default wherever accounts exist, since 2026-10-10; `TABULA_CHAT=off` is the operator's opt-out; never in open mode) and `chat: true` in `/api/me`; `chat.sqlite` with its own migrations (`server/chat.mjs`), with the reactions and mentions tables already in place; the access function for board channels (`server/chat-access.mjs`); text normalisation and mention tokens (`server/chat-text.mjs`); the routes for sending, listing, editing, deleting, read markers, the unread summary and the admin chat settings (`server/chat-routes.mjs`); rate limits (`server/chat-limits.mjs`); the `/chat` socket (`server/chat-hub.mjs`); the `chat.delete` and `chat.settings` audit sentences; `chat.sqlite` in backups and restores. Built in slice 2: the client store (`src/chat.ts`: REST, one `/chat` socket per tab with reconnect and backoff, subscription while the Chat tab is open, catch-up after a reconnect, unread counts, the read marker), the offline copy and outbox (`src/chat-cache.ts`, IndexedDB `tabula-chat`), the pure rules (`src/ui/chat-logic.ts`), the right-hand tray with **Comments** and **Chat** tabs (`src/ui/side-tray.ts`), the board chat panel and button (`src/ui/chat.ts`, `src/ui/chat.css`), the `M` shortcut, the `@` people list, and `GET /api/chat/:kind/:ref` (the caller's access and the people who can read the channel, the "channel's other metadata" of Mentions). Built in slice 3: team channels and the workspace channel in the access function (`server/chat-access.mjs`; the workspace channel's ref is `main`, so its routes are `/api/chat/workspace/main/...`, not the omitted ref the API table below shows), the switch **Workspace channel** (`chat.workspaceChannel`, on by default) with `workspaceChannel` in `GET` and `PUT /api/admin/chat`, `GET /api/chat/channels` (the Chat page's list: the workspace channel, the person's teams, the teams a workspace owner or admin may read without belonging to, and boards with a message in the last 14 days, each with its unread counts) and the unread summary for all three kinds, the retention job (`server/chat-retention.mjs`: a minute after start and then daily, batches of 1,000, one `chat.retention` audit row with counts only), the Chat page `#/chat` and `#/chat/<kind>/<ref>` (`src/ui/chat-page.ts`: channel list and conversation, one screen each on a phone), the **Chat** link with the unread total in the top bar and the unread count beside a board's title on the Boards page, the admin **Chat** tab (`src/ui/chat-admin.ts`) and the **Chat** filter of the audit log. Built in slice 4: reactions (`PUT` and `DELETE /api/chat/messages/:id/reactions/:emoji`, the six of the fixed set, one of each per person, for people who may write there, 60 a minute; the `reaction` frame carries the message's full list; counts under a message, a **React** item in the message menu), mention notices (the hub's `notice`: a `mention` frame to a person who has the app open and no tab on that channel, shown as a card with **Open** and **Dismiss**, `src/ui/mention-notice.ts`), the mention email (`server/chat-notify.mjs`: queued when the person has no tab open, sent ten minutes later if nobody has opened the app since, the mention is still there and unread, they have not turned it off, and the limits of one per person per channel per ten minutes and 20 a day allow it; mail kind `chat-mention` with `template` and `params` for a webhook relay; an edit never sends again; the undocumented `TABULA_CHAT_MENTION_MAIL_AFTER_MS` shortens the ten minutes for the relay tests) and the per-person preference (`user_prefs` in the directory, `GET` and `PUT /api/me/prefs`, **Chat notifications** in the board menu and on the Chat page, on until turned off). Built in slice 5: removing a member keeps their messages with the name they were written under and no account (`Store.anonymiseAuthor`, run by the relay on the `user-removed` event; their reactions, read markers and the mentions of them go), **Erase chat messages** on a person in the admin Members list (`POST /api/admin/members/:id/chat-erase`: every message they wrote becomes a tombstone with no text, in every channel, authored by "Former member"; people watching see it at once; audit row `chat.erase` with the person and a count), **Export chat** (`GET /api/admin/members/:id/chat-export`: a JSON file of what they wrote and the reactions they gave, deleted messages without text; audit row `chat.export`), and the document title prefix `(3)` while the tab is in the background (`src/ui/title-badge.ts`). Slice 6: **Reference selection** in the composer attaches the selected object as a chip, and the chip in a message flies to that object (see Object link below). Decisions taken since the spec: chat is on by default wherever accounts exist, with no flag (`TABULA_CHAT=off` opts out; a hosted workspace gets it when it moves to an image that has this default, `chat.sqlite` is created on first use and is in the backups, guests have no chat because the routes need a user session), no chat in open mode, commenters and up post (viewers when an admin allows it), messages are kept for one year by default, AI does not read chat, no `@channel`, chat is not exported, edits are allowed any time and marked, chat is unmetered, and one tray with Comments and Chat tabs.

People who work on a board together talk next to it: in a call, in another chat tool, in the comments. Comments are threads pinned to a place or an object and are the right tool for "this sticky is wrong". They are the wrong tool for "who has the Figma link?", "are we starting at ten?" or "look at the cluster on the left". There is no free-form conversation in Tabula today, and focus requests ("look here") are a one-off nudge, not a channel.

This page specifies chat: a conversation panel on every board, and channels for teams and the workspace outside any board. It reuses what the server already knows (who someone is, which teams and boards they may see) and what the code already does well (a relay that authorises every connection, a guard that stamps authorship on the server). The central design decision is where messages live, and the answer is **not** in a board's Yjs document. [Where messages live](#where-messages-live) explains why from the history, backup and retention code.

## Summary

- **Two kinds of place to talk, one model.** A **board chat** for everyone who can open that board, and **team channels** (one per team, plus one for the whole workspace) on a new Chat page. Direct messages are v2. All are the same kind of thing: a **channel** identified by `(kind, ref)` with `kind` in `board`, `team`, `workspace`.
- **Accounts mode only in v1.** Chat needs an identity the server can trust. Open mode has none (the author of a comment there is a device id the client picks), so it has no chat. `/api/me` reports `chat: true` where it is on, and the buttons are hidden elsewhere.
- **Messages are rows in a SQLite database on the relay**, not objects in a Yjs room. The server assigns the author, the time and the order; clients send text. An append-only log with edit and soft delete, not a CRDT.
- **Live delivery over a new `/chat` WebSocket** carrying JSON events from the server to the browser (a message, an edit, a delete, a read marker, access lost). **Writes are ordinary REST calls**, so they get the CSRF header, body limits, role checks, audit rows, the hosted read-only `402` and rate limits for free.
- **Unread counts are server-side**: one read marker per person per channel, and an unread summary for the Boards page and the board's chat button.
- **Mentions** (`@name`) are validated on the server and notify the person in the app, and by email when they are away. This is the same job as TAB-53 for comments; the two share one mention format.
- **Permissions follow roles that already exist.** Board chat: anyone who can read the board reads; commenters and above write; viewers read (an admin setting lets them write too). Team and workspace channels follow team and workspace membership. Guests only ever see channels of boards and teams they are on.
- **Moderators delete, authors edit.** Same split as comments (TAB-24): nobody edits another person's words. Deleting wipes the text at once. Retention is a workspace setting. A removed member's messages are anonymised, and an administrator can erase a person's messages.
- **Offline**: unsent messages wait in an outbox in the browser and send on reconnect, idempotent by a client-generated id. The last page of each opened channel is cached for reading.
- **Plain text only.** No HTML, no Markdown in v1. Links are recognised and made clickable by the client, with `http` and `https` only.

## Decisions and why

1. **One channel model, three kinds.** The Linear issue proposes a board chat and a team chat. Both are "a list of messages that a set of people may read and a subset may write". Building them as one thing with an access function per kind means unread state, mentions, moderation, retention, limits and the offline outbox are written once.
2. **Board chat first in the slice plan.** It sits next to the work, needs no new page, and exercises all of the hard parts. Team and workspace channels come second, on the same rails.
3. **Not in Yjs.** See [Where messages live](#where-messages-live).
4. **Server-written, client-read.** Everything that makes the comment guard (TAB-24) intricate is that clients write the data and the server must repair it afterwards (mirrors, second transactions, notices). A chat log is insert-only, so the server simply is the only writer: the client posts text, the server decides author and time.
5. **Push over a socket, writes over REST.** The sync socket cannot be extended cheaply (its only messages from the client are Yjs sync and awareness; anything else is ignored) and it is per board, while team channels have no board. A second socket costs one connection and buys a channel-shaped protocol. Writing through REST means no second write path to secure.
6. **Accounts mode only.** Without a trusted identity chat is impersonation by design. Open mode keeps comments and focus requests, which need no trust.
7. **Retention and erasure are designed in, not added later.** Messages are personal data in a way board objects are not (conversation, names, mentions). Deletion is real (the text is overwritten), retention is configurable, and the backup behaviour is stated plainly.

## Where messages live

The three places a message could go, and what the existing code says about each.

| | Board's Yjs room | The `~comments` Yjs room | Server database (chosen) |
|---|---|---|---|
| **Saved** | Whole room, every save (`<id>.yjs`, 1 s debounce, 30 s max wait). Every message rewrites the board file. | Same, for the comments file. | Insert of one row. |
| **History** | Every version snapshot is the full room, so each version carries the whole chat so far (64 MB budget per board). A restore would roll the conversation back to the version. | Not snapshotted today, and restores leave it alone. | Not touched by history or restore, which is what people expect of a conversation. |
| **Backups** | Included, but only as a whole room file. | Included (`ROOM_FILE_RE` allows `~comments`), whole file. | A table in a database the backup already copies (`VACUUM INTO`). A separate database file needs one line in the backup walk. |
| **Sync** | The full state goes to every client that opens the board, however old the conversation. No pagination. | The same for comments. | Pages of 50, on demand. |
| **Unread** | Needs a per-person marker that cannot live in a shared document. | Same. | A table. |
| **Authorship** | Clients write; the server repairs afterwards (the TAB-24 guard, with a per-thread mirror and notices). | Same. | The server is the only writer. |
| **Retention, erasure** | CRDT updates keep deleted content in history and in other clients' copies. A row delete is not enough. | Same. | `DELETE` or overwrite, immediately. |
| **Who can read** | Anyone who can open the board, in all clients. | Board readers and commenters. | Chosen per channel by the server on every read. |
| **Team channels** | Have no board to live in. | Same. | Work the same as board chat. |

History and backups settle it: a chat inside a board room would be copied into every version, rolled back by every restore and rewritten whole on every message, and Yjs offers no honest way to erase a message. Comments are different in kind (they belong to objects and are part of the board's meaning), which is why they are a Yjs room.

### A separate database file

Messages go in `<DATA_DIR>/chat.sqlite`, not into `directory.sqlite`. The reasons are operational:

- The backup engine copies the directory database with a **synchronous** `VACUUM INTO` while the relay is running. A directory that also holds years of chat would make that copy longer and every backup pause the event loop for longer. Chat grows without bound by nature; the directory does not.
- Retention deletes, vacuuming and a future export or erasure tool can run against the chat file alone.
- A failure or a full disk in chat storage does not take sign-in down with it.

What it costs: no foreign keys to `users`, `teams` or `boards` (the server checks access through `directory` before any chat query and cleans up on removal events), and the backup walk needs to copy it with the same `VACUUM INTO` treatment (`snapshotFiles` yields `chat.sqlite` next to `directory.sqlite`). It is created on first use with its own `PRAGMA user_version` and migration list, following the pattern in `server/directory.mjs`.

### Schema

```
chat_messages(
  id          INTEGER PRIMARY KEY AUTOINCREMENT,   -- the order of the channel, assigned by the server
  kind        TEXT NOT NULL CHECK (kind IN ('board','team','workspace')),
  ref         TEXT NOT NULL,                       -- board id, team id, or '' for the workspace
  author_id   TEXT,                                -- NULL after the author is removed
  author_name TEXT NOT NULL,                       -- name at the time; shown only when author_id is NULL
  body        TEXT NOT NULL,                       -- plain text; '' once deleted
  reply_to    INTEGER,                             -- id of a message in the same channel
  object_id   TEXT,                                -- board chat only: a board object this message points at
  client_id   TEXT NOT NULL,                       -- uuid from the sender; makes a retry harmless
  created_at  INTEGER NOT NULL,
  edited_at   INTEGER,
  deleted_at  INTEGER,
  deleted_by  TEXT,                                -- author id, or the moderator's id
  UNIQUE (kind, ref, author_id, client_id)
)
CREATE INDEX chat_by_channel ON chat_messages (kind, ref, id);

chat_reads(user_id TEXT, kind TEXT, ref TEXT, last_id INTEGER NOT NULL, PRIMARY KEY (user_id, kind, ref))
chat_mentions(message_id INTEGER, user_id TEXT, PRIMARY KEY (message_id, user_id))
CREATE INDEX chat_mentions_by_user ON chat_mentions (user_id, message_id);
chat_reactions(message_id INTEGER, user_id TEXT, emoji TEXT, PRIMARY KEY (message_id, user_id, emoji))
```

Channels are not rows: a channel exists when someone may talk in it, and its identity is `(kind, ref)`. No setup step, no empty-channel clean-up.

## Channels and who may do what

An **access function** answers every question, once, in `server/chat-access.mjs` (pure, with the directory's lookups injected, so it is tested without a server): `chatAccess(user, kind, ref) -> {read, write, moderate} | null`. `null` means the channel does not exist for this person (the API answers `404`, never `403`, so nobody learns what exists). It builds on what the directory already provides: `boardRole`, `listTeamsFor`, `getTeamRole`, the workspace role, and the workspace read-only flag.

| Channel | Read | Write | Moderate (delete others' messages) |
|---|---|---|---|
| **Board** `board/<id>` | anyone with a role on the board, including viewers and commenters (not people who joined with a board join code: they have no chat, the chat routes need a signed-in account) | owner, editor, commenter. Viewers: read only, unless the workspace setting **Viewers may post in board chat** is on. | board owner (workspace owners and admins count as owners, as everywhere) |
| **Team** `team/<id>` | team members and workspace owners and admins (a person who only joined with a join code has no chat) | team members; not workspace admins who are not members (they read and moderate) | team admins, workspace owners and admins |
| **Workspace** `workspace/` | owner, admin, member. **Not guests.** | the same | workspace owners and admins |

Further rules:

- **A deleted board** (soft delete) keeps its chat readable to workspace admins only, like the board itself, and write-refused. Purging a board deletes its chat rows.
- **An archived team**: its channel is read-only.
- **A disabled user** has no access to anything (`boardRole` already says so).
- **A read-only workspace** (hosted) refuses chat writes with the same `402 read_only` as every other write; reading and read markers keep working (a read marker is the person's own state, not workspace content, and is listed with the other exempt routes in `docs/cloud.md`).
- **Access changes take effect at once.** The relay already emits `access-changed` when shares, team membership or roles change and closes affected sync sockets with `4410`. The chat hub subscribes to the same event, re-evaluates that person's subscriptions and sends `closed` for channels they lost.
- **The chat button is hidden** when the board's role has no `read`.

The decision on viewers is an open question; the default above treats chat as conversation, not editing, but keeps viewers silent unless an administrator opts in.

## The messages

- **Text**: up to 2000 characters, at least one non-whitespace character. Normalised on the server: NFC, `\r\n` to `\n`, control characters except `\n` and `\t` removed, invisible and bidirectional override characters removed (the same set the MCP fence strips), runs of more than two blank lines collapsed, trailing whitespace trimmed. What is stored is exactly what is shown.
- **Reply**: `reply_to` points at a message in the same channel; the UI shows a one-line quote with the author and the first 80 characters, and a tombstone says "Message deleted" if the original is gone. One level only (a reply to a reply quotes the reply). No threads in v1.
- **Mentions**: see [Mentions](#mentions).
- **Object link** (board chat only): "Look at this sticky" attaches `object_id`. In the composer, with an object selected, **Reference selection** adds a chip to the message; the server checks only that the board chat's board is the one named in the URL and that the id has the shape of an object id (it does not read the Yjs room). On render the client looks the object up live: a click flies the view to it (the focus-request fly), and a text label is taken from the object's current text when the viewer may see it (objects hidden by a session's private-writing step show "an object", never their text). A missing object shows "Object no longer on the board".
- **Edit**: the author may edit their own message, any time, `edited_at` is set and the UI shows "edited". Only the text and mentions change; `reply_to`, `object_id` and the position do not.
- **Delete**: the author deletes their own; a moderator deletes anyone's. The row stays as a tombstone (`deleted_at`, `deleted_by`) so replies keep their place, but `body` is overwritten with the empty string, and `chat_mentions` and `chat_reactions` rows are deleted. Tombstones show "Message deleted" or "Message removed by a moderator".
- **Reactions**: a small fixed set in v1 (👍 ❤️ 😄 🎉 👀 ✅), one of each per person per message, shown as counts under the message. The Linear issue suggests the sticker sets; those are colour emoji from Iconify, ship as SVG, and are worth a v2 (open question). Reactions never notify.
- **Ordering and identity**: `id` is the order. Clients sort by it and never by their own clock. The sender's own message appears greyed in the list from the moment they press send, and is replaced by the server row when it arrives.
- **Display names** are the live account name through `author_id`. `author_name` is a snapshot used only when the author has been removed. The same person shows one name everywhere and a rename changes old messages too, as it does for comments (which stamp the account's current name).

## Live delivery

### The `/chat` socket

A WebSocket at `/chat`, upgraded by the relay's existing HTTP server. Authentication is the session cookie and the `Origin` check that `/sync` applies (the origin of `TABULA_BASE_URL`), with the same close codes: `4401` signed out, `4410` access removed. It is JSON frames, text only, both directions; there is no binary and no Yjs.

Server to client:

| Frame | When |
|---|---|
| `{t:'hello', channels:[{kind,ref,unread,mentions,lastId}]}` | right after connecting: the unread summary for every channel this person can read that has messages after their marker |
| `{t:'message', kind, ref, message}` | a new message in a subscribed channel |
| `{t:'edit', kind, ref, message}` / `{t:'delete', kind, ref, id, by}` | an edit or a delete |
| `{t:'reaction', kind, ref, id, emoji, userId, on}` | a reaction toggled |
| `{t:'read', kind, ref, lastId}` | this person read the channel in another tab or device (clears the badge here) |
| `{t:'unread', kind, ref, unread, mentions}` | a message arrived in a channel that is not currently subscribed (counts only, no text) |
| `{t:'closed', kind, ref}` | access to the channel was lost |
| `{t:'readonly', on}` | hosted read-only changed, so the composer disables |

Client to server: `{t:'sub', kind, ref}`, `{t:'unsub', kind, ref}` and `{t:'ping'}`. A subscription is checked with `chatAccess` when it is made and again when access changes. At most 50 subscriptions per socket and 10 sockets per person.

Payloads for channels the person is **not** subscribed to are counts only, so a team channel's text never travels to someone who merely has the Boards page open. A browser subscribes to the channel it is looking at, and to nothing else.

### Why not the sync socket

It is attractive to add message type 6 to `/sync/<board>`. But the relay ignores every client message except sync (0) and awareness (1), the socket exists per board (team channels have no board) and only for people with the board open, and it is built around Yjs rooms. A second, small socket is cheaper to reason about than a chat dialect inside the Yjs one. The comments room's own socket stays as it is.

### Fan-out

The relay is one process per workspace, so the hub is an in-memory map from `kind/ref` to the sockets subscribed to it. A write goes: REST handler, check, insert, commit, hub `publish`. There is no external broker and none is needed; if the deployment ever runs several relays against one data directory, that breaks here and in the Yjs rooms for the same reason.

### Unread

- A **read marker** is `chat_reads.last_id`. The client sends `PUT /api/chat/<kind>/<ref>/read {lastId}` when the panel is open, visible and scrolled to the bottom, throttled to once per two seconds. The server only moves it forward.
- **Unread** = messages in the channel with `id > last_id`, not deleted, not written by the person. **Mentions** = those of them in `chat_mentions` for the person. Computed with the index `(kind, ref, id)`; for an active workspace this is a handful of range scans.
- `GET /api/chat/unread` returns the summary the `hello` frame carries, for pages that do not open the socket immediately.
- A person with no marker for a channel they just gained access to starts "caught up" at the newest message (no hundred-message backlog badge on joining a team), except that mentions of them always count.
- **Surfaces**: a badge on the board's chat button (the number of unread, red outline when there is a mention), a badge on **Chat** in the top bar (sum over channels, mentions highlighted), badges per channel on the Chat page, and the document title prefix `(3)` while the tab is hidden. Muting a channel (v2) will suppress badges but not mentions.

## API

All under `/api/chat`, JSON, `x-tabula: 1` on writes, session or nothing (the MCP bearer tokens do not reach it, see MCP). `kind` is `board`, `team` or `workspace` and `ref` the id (omitted for the workspace: `/api/chat/workspace/messages`).

| Route | What |
|---|---|
| `GET /api/chat/:kind/:ref` | the caller's access in the channel (`write`, `moderate`, `role`, `readOnly`) and the people who can read it (`id`, `name`), for the composer and the `@` list. Built in slice 2. |
| `GET /api/chat/:kind/:ref/messages?before=<id>&limit=50` | a page, newest last. `limit` up to 100. Tombstones are included with no text. Reactions and mention names included. Same `before`/`next` cursor shape as `GET /api/admin/audit`. |
| `POST /api/chat/:kind/:ref/messages` | `{clientId, text, replyTo?, objectId?}` → `201 {message}` or `200 {message}` when this `clientId` was already stored by this person (idempotent retry). Errors: `400 empty`, `400 too_long`, `404`, `403 read_only_viewer` where viewers may not post, `402 read_only`, `429 rate_limited`. |
| `PATCH /api/chat/messages/:id` | `{text}`, author only. |
| `DELETE /api/chat/messages/:id` | author, or a moderator of the channel. Audit row only for a moderator's delete. |
| `PUT /api/chat/messages/:id/reactions/:emoji` and `DELETE …` | toggle. |
| `PUT /api/chat/:kind/:ref/read` | `{lastId}`. |
| `GET /api/chat/unread` | the summary. |
| `GET /api/chat/channels` | the channels this person can talk in, with names and unread, for the Chat page: workspace, their teams, and boards with chat activity in the last 14 days. |

The route table in `server/api.mjs` (`compile`) is the pattern; no change to its machinery is needed beyond registering a module of routes (as `server/templates.mjs` and the token routes do).

## Mentions

Comments have no mentions yet (`docs/comments.md` lists them under "Not in this slice"; TAB-53 is the backlog item). Chat needs them on day one, so this section defines the format in a shared module, `src/mentions.ts` (and its server twin), meant to serve TAB-53 as well.

- **Format in the text**: `@{<userId>}`, for example `Thanks @{k3Fa9…}, can you check?`. The text stays plain; the token is data. The composer shows `@Name` and swaps in the token on send; the list swaps the token for a chip with the person's **current** name, so renames and removals are handled in one place. A token for someone who cannot read the channel, or does not exist, is turned into the literal text `@someone` by the server before storing.
- **Autocomplete**: typing `@` opens a list of people **who can read this channel** (board: everyone with a role; team: its members; workspace: members), fetched with the channel's other metadata, never the whole directory. Arrow keys and Enter to choose, Escape to close.
- **Limits**: 10 mentions per message.
- **What a mention does**: inserts `chat_mentions`, makes the channel's badge for that person a mention badge, and sends an in-app notice (a card on the board or the Chat page, like the focus-request cards) if they are online but not looking at the channel. If they are **not connected at all**, the server queues an email (below).
- **No `@channel`, `@here` or `@everyone` in v1.** They are the easiest way to make a team channel unusable (open question).
- **Email**: a mail kind `chat-mention` (template and params so a webhook mail relay can render its own, as `trial-ending` does), sent once per channel per person when the person has had no socket for 10 minutes since the mention and has not read it. Subject is generic ("You were mentioned in Roadmap 2026"), the body holds the sender's name and the first 140 characters, plus the link. Controlled by a per-person setting **Email me when I'm mentioned** (default on, in **Your name and colour** or a new **Notifications** line in the Account section), which needs a small `user_prefs(user_id, key, value)` table in the directory; there is no per-person preference storage today (the `settings` table is instance-wide). Emails are rate-limited to 1 per person per channel per 10 minutes and 20 per person per day. No digest in v1. The email needs a mail transport you chose on purpose: with the default `TABULA_MAIL=log` nothing is delivered and the body, which holds the first 140 characters of the message, is printed to the process output (a hosted workspace sends it through the mail relay with `TABULA_MAIL=webhook`).
- **Edits**: adding a mention in an edit notifies; removing one removes the mention row; an edit never re-sends an email already sent.

## Moderation, retention and personal data

### Moderation

- Moderators (table above) can delete any message. They cannot edit one (the TAB-24 rule for comments: moderation removes, it does not rewrite).
- Every moderator delete writes an audit row `chat.delete` with `{kind, ref, messageId, authorId}`. **No text** is ever written to audit rows, logs or error messages. The admin audit log gets readable sentences ("Maya removed a message by Ana in Roadmap 2026"), the filter list gets **Chat**, and the test that every server action has a sentence covers the new actions.
- Reporting, muting people, blocking and slow mode are not in v1.

### Retention

A workspace setting **Keep chat messages** (owner and admin): *1 year* (default), *90 days*, *30 days*, *Forever*. A daily job deletes rows older than the limit (and their mentions and reactions), in batches of 1,000 with a pause between them so it never holds the database for long, then `PRAGMA incremental_vacuum` or a `VACUUM` outside peak, and writes `chat.retention` with the counts only. Changing the setting writes `chat.settings`. The first run after shortening it deletes a lot; the setting's help text says so.

### Removing and erasing people

- **Removing a member** (`removeUser`, `DELETE /api/members/:id`) anonymises: `author_id` becomes NULL and `author_name` stays as the snapshot or becomes "Former member" when the account is removed for erasure; their read markers, reactions and mentions are deleted. The hook is an event the chat module listens to (`member-removed`), the same way the relay listens for `access-changed`. This matches what happens to a removed member's comments today (they stay, with the stamped name).
- **Erase a person's messages**: an owner or admin action **Erase messages** on a member row in the admin Members list (two clicks to confirm), which deletes every message that person wrote, across channels, and anonymises the replies that quoted them. This is the answer to a right-to-erasure request. It writes `chat.erase` with the user id and a count.
- **Export of a person's messages**: `GET /api/admin/members/:id/chat-export` (owner and admin) returns a JSON file of everything the person wrote. The repository has no personal-data export at all today; this slice adds only the chat part, and the general question is raised in the open questions.
- **Backups keep what was erased until they expire.** The off-site backup copies the chat database like any other file, with 48 hours of hourly and 30 days of daily copies by default. A deleted message is overwritten in the live database at once and disappears from the newest backup at the next run, but older backups still hold it until they age out. Restores are not built yet, and when they are, an erasure log must be re-applied after a restore. The admin help for **Erase messages** and for retention says this in one sentence. This is a legal and product statement, not a code detail, and it is raised below.
- **History** never held chat. Board versions, restores, `.drift` and JSON exports do not include it. A board exported and imported elsewhere leaves its conversation behind (open question).

## Limits

| What | Limit | Where it is enforced |
|---|---|---|
| Message length | 2000 characters, 1 minimum | server (after normalisation) and the composer |
| Request body | 16 KB | route option `maxBody` |
| Mentions per message | 10 | server |
| Posting | 20 messages a minute per person per channel, 60 a minute per person overall, burst of 5 in any two seconds | in-memory sliding window like the MCP limiter (`server/mcp.mjs`, `server/chat-limits.mjs`); a request over any of its limits is refused with `429` and `Retry-After` and counts against none of them |
| Editing and deleting | 20 a minute per person | same |
| Reactions | 60 a minute per person | same |
| Channel metadata, unread summary, read markers | 60 a minute per person each | same |
| Pages of messages (`GET .../messages`) | 120 a minute per person, in any channel | same |
| History page | 50 by default, 100 at most | server |
| Messages kept in the browser's list | 1,000 per channel (older ones are fetched on scroll and dropped when scrolled away) | client |
| Sockets | 10 per person, 50 subscriptions per socket | hub |
| Mail | see Mentions | server |
| Size | no per-channel cap; retention is the control | |
| Reply, reaction rows | one reply target, one of each emoji per person per message | schema |

Rate-limited requests answer `429` with `Retry-After`, and the composer shows "Slow down a moment" without losing the typed text.

## Offline

Chat is a conversation, so unlike board edits it cannot merge itself; the rule is simple:

- **Reading offline**: the last 50 messages of each channel the person opened are cached in IndexedDB (`tabula-chat`, `channels` store) and shown with an "Offline, showing saved messages" line. Sign-out clears the store.
- **Writing offline**: sending always puts the message in an **outbox** (`outbox` store: `{clientId, kind, ref, text, replyTo, objectId, createdLocal}`) and shows it greyed with "Sending…" in order. When the socket and the API are reachable, the outbox flushes oldest first, one at a time, through `POST …/messages`. `clientId` makes a retry after a lost response harmless (the server returns the stored message with `200`). A message that stays unsent shows "Not sent. Retry · Copy · Discard".
- **When sending fails for good** (`403`/`404` because access was lost, `402 read_only`, `400`) the message turns into "Not sent: <reason>" and stays in the outbox until the person discards it, so nothing typed is lost silently. The text can be copied.
- **Reconnects** refetch everything after the last known id and merge by `id`, then replay `hello` for unread counts. Duplicate frames are ignored by id.
- **Edits and deletes offline** are not queued in v1: the controls disable while offline.
- The service worker does not cache `/api/chat` (it already returns early for `/api/`); the IndexedDB cache is the offline copy.

## Interface

Swiss style, every colour from theme variables, 12 px tray and dialog radii, 8 px control radii, no added shadows and hairline borders. `src/ui/admin.css` and the new share dialog are the references.

- **On a board**: a **Chat** button in the top bar next to **Comments**, with the unread badge. The comments panel and the chat panel share one right-hand tray with two tabs, **Comments** and **Chat**, because two trays side by side do not fit a laptop and the tray already has the phone behaviour (it starts below the top bars through `--panel-top`). A board's chat is remembered per person and board as open or closed. The composer is at the bottom; the list scrolls and keeps its place when messages arrive above the fold, with a **Jump to latest** line when it is not at the bottom.
- **Chat page** `#/chat` (linked from the top bar as **Chat**): a channel list on the left (Workspace, one row per team, recent boards) with unread badges and a conversation on the right. On a phone, the list is the first screen and the conversation a second screen with a back button.
- **Messages**: a run of messages by the same person within five minutes shows the name and time once; a date line separates days; a "New messages" divider sits at the read marker; tombstones, "edited", reactions as small outlined counts, quoted replies, mention chips and object chips. Names are text. There are no avatars in v1 beyond the person's colour square with initials.
- **Composer**: a text area that grows to six lines; **Enter** sends, **Shift+Enter** a new line, **Esc** leaves the field, `@` opens people, a **Reference selection** button in board chat. Disabled with a stated reason when the person cannot write (viewer, read-only workspace, archived team, offline composes into the outbox).
- **Keyboard**: the panel is a labelled region, the list is a log (`role="log"`, `aria-live="polite"` for new messages when the panel is open), buttons are real buttons with `aria-label`s, focus never moves unprompted. One shortcut to open board chat, added to the single shortcuts table (`src/shortcuts.ts`) so the dialog and its test stay in step.
- **Themes and sizes**: all five themes (contrast checked by the existing tests); at 390 px nothing scrolls sideways.
- **Admin**: a **Chat** tab (hidden when the feature is off) with the settings below, and an **Erase messages** action in Members.

Admin settings (`settings` table, `GET`/`PUT /api/admin/chat`): **Chat on or off** for the workspace, **Workspace channel on or off**, **Viewers may post in board chat**, **Keep chat messages**.

## Security

1. **Authorship is the session.** `author_id` is taken from the authenticated user, never from the body. A client cannot post as someone else, back-date a message, set an id or choose an order. Editing and deleting check the author or moderator role on the server. This is the same guarantee TAB-24 gives comments, obtained more simply because the server is the only writer.
2. **Plain text everywhere.** The server stores normalised text and never HTML. The client renders with `textContent` (never `innerHTML`), turns `http://` and `https://` URLs into links with `target="_blank" rel="noopener noreferrer"` and shows the full address (no link text different from the target), and recognises nothing else. No Markdown, no images, no embeds, no link previews fetched by the server (no outbound requests are made on a message's behalf). Mention tokens and object chips are built by the client from validated data, not from message text.
3. **Access is checked on every read, write and subscription**, through one function, with `404` for hidden channels. A socket never carries text for a channel it has no subscription to, and subscriptions are re-checked on `access-changed`.
4. **CSRF and Origin.** The REST writes need the `x-tabula: 1` header and a matching `Origin`; the socket checks `Origin` as the sync socket does. The MCP bearer tokens do not authorise `/api/chat`: chat is the person's own voice, and a token acts for a person but should not speak for them in a conversation.
5. **Limits against flooding and abuse**: the table above, plus the total sockets and subscriptions caps, and a hub that drops a slow consumer's connection rather than buffering without bound (a send queue limit of 1 MB per socket).
6. **No content in logs, audit rows or errors.** Error logs print codes and ids. Audit details hold ids and counts. The mail body is the only place text leaves the instance, and only for a mention, truncated, and never in subject lines.
7. **SQL**: every query is parameterised; the channel key is validated against the kind (board ids match the board id pattern, team ids exist, the workspace has no ref).
8. **Invisible characters** (bidirectional overrides, zero-width joiners used to spoof names or links) are removed on write, so one rendering is the only rendering.
9. **Prompt injection.** Nothing in this slice sends chat to a model, and the MCP server gets no chat tools. If an AI feature ever reads chat (TAB-123), it must go through the same fence as board text (`fence()`), be opt-in per workspace (the default stated in the issue is no), and never see messages from channels the requesting person cannot read.
10. **Hosted tenants** are isolated by instance, so there is no cross-workspace channel to leak into.

## Open mode, desktop and MCP

- **Open mode**: no chat. The routes answer `404`, `/api/me` is not served, the buttons are hidden. A throwaway open-mode relay for a workshop has no use for persistent messages, and an ephemeral chat over awareness would be unauthenticated by construction. (Open question.)
- **Desktop shell**: it talks to a relay only when one is configured and has no chat store of its own. With no relay there is no chat, with the same hidden buttons. The offline cache and outbox are plain IndexedDB, which the shell already provides.
- **MCP**: no chat tools in v1 (see Security). Board content tools are unaffected; `list_comments` and `add_comment` stay the way to leave a durable note on a board from an AI tool.

## Tests

Pure (vitest):

- `chat-access.test.ts`: every role against every channel kind in a table (owner, admin, member, guest, team admin, team member, board owner, editor, commenter, viewer, disabled, outsider), read-only workspace, deleted board, archived team, and the viewers-may-post setting.
- `chat-text.test.ts`: normalisation (control and invisible characters, blank-line collapse, NFC, length), mention token validation, URL recognition (only http and https, no `javascript:`), object id shape.
- `chat-unread.test.ts`: marker moves forward only, own messages and tombstones do not count, catch-up on joining, mentions always count.
- `chat-outbox.test.ts`: order, idempotent retry by `clientId`, permanent failures stay visible, discard.
- `chat-limits.test.ts`: the sliding windows and the 429 shape.

Relay (spawned in accounts mode like the existing server tests):

- `chat-api.test.ts`: post, list with `before`, edit and delete as author, moderator delete and its audit row (and no row for an author's own delete), editing someone else's message refused, `404` for hidden channels, guest and viewer rules, `402` read-only, body too long, replayed `clientId` returns `200` with the same message, author spoofing in the body ignored, CSRF.
- `chat-socket.test.ts`: subscription to an allowed and a denied channel, a message reaching a subscriber and not a non-subscriber (counts only), `closed` when access is removed through a share or team change, `read` mirrored to a second tab, `4401` on sign-out, slow consumer dropped.
- `chat-retention.test.ts` and `chat-erase.test.ts`: the daily job, batches, member removal anonymising, the erase action, the export file.
- `chat-backup.test.ts`: `chat.sqlite` is in the snapshot and a second run uploads nothing for an unchanged file; an erased message is absent from the next snapshot.
- Admin tests: the audit sentences for the new actions and the **Chat** filter.

## Not in this slice

- Direct messages and group DMs (v2: a `dm` kind with a member list, access by membership).
- Threads, pins, search, message formatting, link previews, file or image attachments (images are TAB-127 and could attach later), voice or video.
- Typing indicators and read receipts per message (the read marker is per person and private).
- Mute, notification schedules, digests, push notifications and a native app badge.
- `@channel`, `@here`, user groups.
- Sticker-set reactions and custom emoji.
- Chat in exports (`.drift`, JSON, Markdown) and in board templates.
- Open mode and anything unauthenticated.
- AI features that read or write chat, and MCP chat tools.
- A general personal-data export beyond the chat messages.

## Slices

1. **Storage and API.** `chat.sqlite` and its migration, `chat-access`, text normalisation, routes (send, list, edit, delete, read, unread, reactions), limits, audit actions and sentences, `/api/me` flag, `TABULA_CHAT`, backups walk, tests. No UI.
2. **Board chat.** The `/chat` socket and hub, the client store, the right-hand tray with the **Chat** tab, composer, list, unread badge, the offline cache and outbox. Plain messages, edit, delete, replies.
3. **Team and workspace channels.** The Chat page, channel list, per-channel badges, the unread summary on the Boards page, access-change handling for teams.
4. **Mentions and notifications.** The shared mention module, autocomplete, `chat_mentions`, in-app cards, `user_prefs`, the `chat-mention` email and its limits. Align with TAB-53 so comments reuse it.
5. **Moderation, retention and people.** The admin **Chat** tab and settings, moderator delete, retention job, member-removal anonymising, **Erase messages**, chat export, the help text on backups.
6. **Reactions, object links, polish and docs.** Reactions, **Reference selection** and the fly-to chip, themes and phone checks, the user guide page, updates to `docs/accounts.md`, `docs/backups.md`, `docs/comments.md` (mentions), `docs/cloud.md` (the exempt routes) and the CHANGELOG.

Slices 1 to 3 give a usable chat; 4 and 5 are what makes it safe to leave on in a real workspace and should ship before anyone is told to rely on it.

## Files

### New

- `server/chat.mjs` (database, migration, queries, retention, anonymise and erase), `server/chat-access.mjs`, `server/chat-hub.mjs` (socket, subscriptions, fan-out), `server/chat-text.mjs`
- `src/mentions.ts`, `src/chat.ts` (client store, outbox, cache), `src/ui/chat.ts`, `src/ui/chat.css`, `src/ui/chat-page.ts`, `src/ui/chat-logic.ts` (pure)
- the tests listed above

### Existing (touched)

- `server/relay.mjs` (the `/chat` upgrade and the event wiring), `server/api.mjs` (register routes, the exempt-route list for read markers), `server/directory.mjs` (a `user_prefs` migration, the removal hook), `server/config.mjs`, `server/mailer.mjs` or `server/cloud.mjs` patterns (the `chat-mention` kind), `server/backup.mjs` (the extra file), `server/board-ops.mjs` (nothing, noted so nobody adds chat there)
- `src/api.ts`, `src/ui/board.ts` (button, tray tabs), `src/ui/comments.ts` (tray sharing), `src/ui/topbar.ts`, `src/ui/admin.ts` and `src/ui/admin-logic.ts` (tab, sentences, filter), `src/route.ts`, `src/shortcuts.ts`, `src/ui/home.ts` (badges)
- `docs/accounts.md`, `docs/backups.md`, `docs/comments.md`, `docs/cloud.md`, `docs/guide/` (a page when it ships), `CHANGELOG.md`

## Open questions for Johan

1. **Board chat first, then team channels** (this spec's slice order), or both together? Board chat alone is quick to ship and useful; the Chat page and workspace channel are the second half.
2. **Open mode.** No chat (this spec), or an unauthenticated chat in open mode with the author a device name and nothing stored? The second is easy and can be impersonated by anyone.
3. **Who may post in board chat.** Commenters and above, viewers only if an admin allows it (this spec), or everyone who can read, viewers included? And guests: only on boards they were given, as drafted?
4. **Retention default.** Decided: one year. Many workspaces will never touch the setting, so the default is the policy.
5. **Erasure and backups.** Is "an erased message disappears from the live data at once and from backups when they expire (up to 30 days)" acceptable to state to customers, or must the backup be rewritten on erasure (a much bigger feature)?
6. **Should AI features (TAB-123) ever read chat?** Default drafted is no, off by default and opt-in per workspace if ever added.
7. **Email on mention.** On by default per person (drafted), or opt-in? Any digest later?
8. **Reactions.** The small fixed emoji set (drafted) or the sticker sets from the start?
9. **One side tray with Comments and Chat tabs** (drafted), or two separate trays that exclude each other?
10. **Is a separate `chat.sqlite` the right call**, or should messages live in `directory.sqlite` for simplicity and accept the longer backup copy? Separate is drafted, for the backup pause.
11. **Workspace-wide channel**: yes (drafted, with an admin switch), or teams only?
12. **`@channel` / `@everyone`**: none in v1 (drafted). Allow for moderators only later?
13. **Chat in exports.** Should a `.drift` or JSON export include a board's chat? Drafted: no, a conversation is not board content and exports are shared more widely than conversations are.
14. **Edit window.** Authors may edit any time (drafted), or only for a period, with a visible "edited" mark either way?
15. **Personal data export.** This spec adds an admin export of one person's chat messages. Does Johan want a general personal-data export (comments, audit, account) as a separate issue?
16. **Hosted limits.** Should chat storage count toward a plan limit (messages are small; images would change this), or is it unmetered?
