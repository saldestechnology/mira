# Tabula

Tabula is free software under AGPL-3.0-only. It is a self-hostable alternative to hosted whiteboards for workshops and teams. Boards work offline first and sync through a relay when it is available.

![Two Tabula boards side by side: a sprint retro with sticky notes, frames and connectors on the left, and a four-lane kanban board with labelled cards on the right](docs/images/readme-hero.png)

## Features at a glance

- Whiteboards with shapes, sticky notes, connectors, UML, frames with size presets, groups and images.
- Kanban boards with lanes, cards, labels, owners and warn or block work-in-progress limits.
- Workshop templates, session steps, a shared timer, private writing, dot voting and polls.
- Accounts, teams and roles, with board comments, chat and guest join codes.
- Emoji stickers and reactions, plus emoji in text.
- Smart guides for alignment, spacing and equal-size matching while resizing.
- Five themes, version history, and import and export in several formats.
- MCP tools for AI agents, including tools for kanban cards.
- An AI bar for editors when AI is enabled and a usable key or hosted plan credits are available.
- Built-in user guide at `/docs/`, sourced from [docs/guide](docs/guide/index.md).

## Run it

Requires Node 22.13 or newer.

```bash
npm install
npm run build
npm start            # app + sync relay on http://localhost:8787
```

Open http://localhost:8787, create a board, and share its URL. Anyone who can reach the same relay (for example `http://<your-ip>:8787/#/b/<board-id>` on your network) edits with you live: cursors, selections, presence and changes all sync.

Development, with hot reload (Vite on :5173 proxies `/sync` to the relay on :8787). Set `VITE_PORT` to change Vite's port; `PORT` selects the relay port:

```bash
npm run dev
```

Docker:

```bash
docker build -t tabula .
docker run -p 8787:8787 -v tabula-data:/data tabula
```

Docker build arguments:

| Argument | Default | Meaning |
| --- | --- | --- |
| `ICON_SETS` | `all` | Choose `all`, `curated` or `demo`; `curated` builds the smaller set (see [Fonts and icons](#fonts-and-icons)) |
| `TABULA_VERSION` | empty | Embed a release label, reported by the server to the control plane |

If you ran the old `mira` image, keep mounting your existing volume (`-v mira-data:/data`) so your boards stay.

### Relay settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | HTTP + WebSocket port |
| `HOST` | `0.0.0.0` | Interface to bind |
| `DATA_DIR` | `data/` under the app root (`/data` in Docker) | Where board documents (`<board-id>.yjs`) and server data are stored |
| `DIST_DIR` | `dist/` under the app root | Built app to serve |
| `SAVE_DEBOUNCE_MS` | `1000` | Idle time in milliseconds before saving a room; the 30-second maximum wait still applies |
| `ROOM_UNLOAD_MS` | `60000` | How long an empty room stays in memory before it is unloaded |
| `QUIET` | unset | `1` silences logs |
| `TABULA_SKIP_DOTENV` | unset | Set to `1` to skip loading `.env` from the relay's working directory |

The relay reads `.env` from its working directory at startup unless `TABULA_SKIP_DOTENV=1`; real environment variables take precedence. `.env` files are gitignored.

The relay speaks the standard y-websocket protocol at `ws://host:PORT/sync/<boardId>`. In the app, **Menu → Board settings → Relay** accepts `auto` (the server that served the app), `off` (this device only), or any `wss://…/sync` URL.

### Stopping the relay

By default, edits are written to disk a second after the last change, and never later than 30 seconds after the first unsaved one. When the relay gets SIGINT, SIGTERM or SIGHUP (and SIGBREAK on Windows) it writes every open board at once, closes its databases and exits with code 0. `docker stop`, systemd and Ctrl+C all work that way. A process that is killed instead (`kill -9`, `docker kill`, a supervisor that gives up waiting) loses the edits of the last 30 seconds at most.

**On Windows** a program cannot catch being killed and there is no SIGTERM, so the relay saves only when it receives Ctrl+C (or Ctrl+Break, or its console window is closed, which Windows follows about 10 seconds later by ending it). Run it under a service wrapper that stops it with Ctrl+C and gives it a few seconds before it resorts to a hard kill:

- nssm: the default stop method (`AppStopMethodConsole`) sends Ctrl+C, but waits only 1.5 seconds before it tries something harsher. Raise it with `nssm set tabula AppStopMethodConsole 10000`.
- WinSW: sends Ctrl+C first and waits for `<stoptimeout>` (15 seconds by default) before it terminates the service.
- Never stop it with `taskkill /F` or `Stop-Process`: both end it at once and skip the save.

A Node program that starts the relay with an IPC channel (`stdio: [..., 'ipc']`) can also send it `{ type: 'shutdown' }`, which does the same on every system.

### Accounts and teams

By default Tabula is open: anyone who can reach the relay and knows a board link can edit it. Set `TABULA_AUTH=on` to switch to **accounts mode**: people sign in with an emailed link, the server keeps members, teams, boards and sharing in a SQLite directory (`<DATA_DIR>/directory.sqlite`), and the relay checks the signed-in person's role on every connection and every update (viewers cannot write). Accounts mode needs Node 22.13 or newer.

Tabula was called Mira before: the old `MIRA_*` names of these variables still work, with a deprecation warning at startup, and the `TABULA_` name wins when both are set.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TABULA_AUTH` | `off` | `on` turns accounts mode on |
| `TABULA_OWNER_EMAIL` | none | The first person to sign in with this address becomes the workspace owner. Required when `TABULA_AUTH=on` |
| `TABULA_BASE_URL` | `http://localhost:<PORT>` | Public URL, used in emailed links and as the only allowed WebSocket `Origin`. An `https://` URL makes the session cookie `Secure` and `__Host-` prefixed |
| `TABULA_MAIL` | `log` | `log` prints each email to the console, `file` appends JSON lines to `<DATA_DIR>/outbox.jsonl`, `smtp` sends through your own SMTP server (`TABULA_SMTP_URL`), `webhook` POSTs `{to, subject, text, from, template, params}` as JSON to `TABULA_MAIL_WEBHOOK_URL` |
| `TABULA_MAIL_WEBHOOK_URL` | none | Target for `TABULA_MAIL=webhook` |
| `TABULA_MAIL_WEBHOOK_TOKEN` | none | Sent as `Authorization: Bearer <token>` with each webhook request |
| `TABULA_MAIL_FROM` | `Tabula <no-reply@localhost>` | Sender address; required with `smtp`, included in webhook payloads as `from` |
| `TABULA_SMTP_URL` | none | SMTP connection for `TABULA_MAIL=smtp`, for example `smtps://user:password@smtp.example.com:465` (any provider's SMTP credentials work, including Mailgun's) |
| `TABULA_SESSION_DAYS` | `30` | Session lifetime |
| `TABULA_TRUST_PROXY` | `0` | Set to `1` behind a reverse proxy: the client IP for rate limiting is the rightmost `X-Forwarded-For` entry. Leave it off without a proxy, because anyone can forge that header |
| `TABULA_CLIENT_IP_HEADER` | `x-forwarded-for` | With `TABULA_TRUST_PROXY=1`: which header holds the client address, `x-forwarded-for` (its rightmost entry) or `fly-client-ip` (on Fly, see `docs/cloud.md`, Client addresses) |
| `TABULA_CHAT` | `off` | Set to `on` to enable board, team and workspace chat in accounts mode |
| `TABULA_JOIN_CODES` | `off` | Set to `on` to allow board-scoped guest join codes in accounts mode |

### Hosted workspaces

The hosted-workspace integration is active only with accounts mode and all three cloud variables set. Set all three together or leave them unset; a partial set prevents startup. The control plane supplies these values; self-hosted instances can leave them unset. See [docs/cloud.md](docs/cloud.md).

| Variable | Default | Meaning |
| --- | --- | --- |
| `TABULA_CLOUD_TOKEN` | none | Shared control-plane credential; at least 32 characters with no spaces |
| `TABULA_CLOUD_URL` | none | Control-plane base URL; HTTPS, or HTTP on loopback for local development |
| `TABULA_CLOUD_WORKSPACE_ID` | none | Workspace identifier at the control plane |
| `TABULA_FLY_VOLUME_ID` | none | Optional Fly volume identifier set by the control plane; a changed identifier marks a restored or replaced volume |
| `TABULA_ADOPT_VOLUME` | none | One-start confirmation to adopt a volume from another hosted workspace; set it to this workspace's id, then remove it. Adoption ends sessions and revokes join codes, invite links and MCP tokens |

### Source policy

By default, the relay does not restrict connections by source address. `proxy` mode is intended for a deployment behind a trusted proxy; its default list is loopback and Fly's proxy range. See [docs/cloud.md](docs/cloud.md#source-policy).

| Variable | Default | Meaning |
| --- | --- | --- |
| `TABULA_SOURCE_POLICY` | `off` | Set to `proxy` to reject connections outside the source allow-list |
| `TABULA_ALLOW_SOURCES` | unset; built-in list when policy is `proxy` | Comma-separated IP addresses or CIDRs that replace the default allow-list when `TABULA_SOURCE_POLICY=proxy` |

### Behind a reverse proxy

Terminate TLS in the proxy and keep these four things true (each is covered by `test/proxy.test.ts`):

1. Set `TABULA_BASE_URL` to the public **https** address. The cookie's `Secure` flag, its `__Host-` name and the allowed WebSocket `Origin` come from that value alone; `X-Forwarded-Proto` is never read.
2. Pass the public `Host` header through unchanged (nginx: `proxy_set_header Host $host;`). The CSRF check compares `Origin` with `Host`, so a proxy that rewrites `Host` makes every state-changing request fail with `403 csrf`.
3. Set `TABULA_TRUST_PROXY=1` (exactly `1`, no other value counts) and have the proxy append the real client address to `X-Forwarded-For`; the rate limiter uses the rightmost entry and ignores anything a client put to its left. Without the variable, `X-Forwarded-For` is ignored and every client of the proxy shares one rate limit.
4. Forward WebSocket upgrades (`Upgrade` and `Connection` headers) for `/sync/*`.

An open WebSocket follows role and access changes (usually at once, otherwise within about 5 seconds) and a session that has run out closes it with code 4401 within about 6 seconds. See `test/live-roles.test.ts`.

Try it locally:

```bash
npm run build
TABULA_AUTH=on TABULA_OWNER_EMAIL=you@example.com npm start
```

Open http://localhost:8787, enter that address, and open the sign-in link that the relay prints to its console. When serving the built app from another origin (for example Vite on :5173 in development), set `TABULA_BASE_URL` to that origin, otherwise sockets are refused.

The full design (roles, the HTTP API, the relay rules and the SQLite schema) is in [docs/accounts.md](docs/accounts.md).

### AI tools (MCP)

Tabula can let an AI tool such as Claude Code read and edit boards while people are working on them. It is off by default; set `TABULA_MCP=on` to serve `POST /mcp`. Tokens are bearer secrets that can change boards, so the relay refuses to start with MCP on unless `TABULA_BASE_URL` is an `https://` address (`http://localhost` is fine for trying it).

| Variable | Default | Meaning |
| --- | --- | --- |
| `TABULA_MCP` | `off` | `on` serves `/mcp` |
| `TABULA_MCP_TOKEN` | none | Open mode only: the shared secret, at least 32 characters with no spaces. Required when `TABULA_MCP=on` without accounts |
| `TABULA_MCP_SCOPE` | `read` | Open mode only: what the shared token may do, `read`, `comment` or `write` |

In accounts mode, open **AI tool access** in the board menu, name a token, pick the lowest level it needs and copy the command it shows once, for example `claude mcp add --transport http board https://your.host/mcp --header "Authorization: Bearer <token>"`. Tools that only speak stdio or OAuth need a bridge such as `mcp-remote`. The full design (tools, roles, limits, how board text is kept apart from instructions) is in [docs/mcp.md](docs/mcp.md).

### Images

The browser accepts PNG, JPEG, GIF, WebP and SVG pictures; SVG is converted to PNG before upload. The relay stores the resulting PNG, JPEG, GIF and WebP files under `DATA_DIR/assets/`, named by the SHA-256 of their content, and only serves a file through a board that owns it (see [docs/images.md](docs/images.md)). Metadata such as GPS position is removed on the server. It is on by default; the limits are set with these variables, in bytes or with a `K`, `M` or `G` suffix.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TABULA_ASSETS` | `on` | `off` turns images off: the routes answer `404` |
| `TABULA_ASSET_MAX_BYTES` | `10M` | Largest file after the browser has scaled it down |
| `TABULA_ASSET_BOARD_QUOTA` | `100M` with accounts, `50M` without | Image storage per board |
| `TABULA_ASSET_TOTAL_QUOTA` | none | Optional cap for the whole instance |

### Backups

Tabula can back up `DATA_DIR` on a schedule, encrypted on the instance first. The default target is an S3-compatible bucket (Tigris, Cloudflare R2, Backblaze B2, MinIO, AWS S3); target `dir` writes the same sealed objects and manifests to a local export directory for another process to pull. S3 needs its five destination and key variables; `dir` needs only the key. **Lose the key and the backups cannot be read by anyone.** What is backed up, how it is encrypted, the status endpoint and the limits are in [docs/backups.md](docs/backups.md). **Restore** is built as owner-only routes (`GET /api/admin/backups`, `GET /api/admin/backups/:name`, `POST /api/admin/backups/restore-board` for one board as a copy, `POST /api/admin/backups/restore` for the whole workspace, which restarts the server with exit code 75 and keeps the previous data aside); see [Restoring](docs/backups.md#restoring). The owner restores from **Admin, Backups** (status, the list of backups, one board as a copy, the whole workspace after typing `RESTORE`, and a **Restoring…** screen that waits for the server and reloads); see [In the app](docs/backups.md#in-the-app).

| Variable | Default | Meaning |
| --- | --- | --- |
| `TABULA_BACKUP_TARGET` | `s3` | `s3` writes to a bucket; `dir` writes a local export for a separate puller |
| `TABULA_BACKUP_DIR` | `<DATA_DIR>/backup-export` | Absolute export path for target `dir` |
| `TABULA_BACKUP_S3_ENDPOINT` | none | Required for `s3`. The endpoint, `https://` (`http://` for localhost only) |
| `TABULA_BACKUP_BUCKET` | none | Required for `s3`. The bucket |
| `TABULA_BACKUP_ACCESS_KEY` | none | Required for `s3`. Access key id |
| `TABULA_BACKUP_SECRET_KEY` | none | Required for `s3`. Secret access key |
| `TABULA_BACKUP_KEY` | none | Required for both targets. Encryption key: 32 bytes as 64 hex characters or base64 (`openssl rand -hex 32`). Never logged |
| `TABULA_BACKUP_KEY_PREVIOUS` | none | Older keys, comma separated, to read backups made before a key change |
| `TABULA_BACKUP_PREFIX` | `tabula` | Key prefix under the selected target |
| `TABULA_BACKUP_REGION` | `auto` | Signing region for target `s3` |
| `TABULA_BACKUP_PATH_STYLE` | `on` | For target `s3`, `off` selects virtual hosted style (`bucket.endpoint`) |
| `TABULA_BACKUP_INTERVAL_MINUTES` | `60` | Time between backups, 5 to 10080 |
| `TABULA_BACKUP_SETTLE_SECONDS` | `120` | Also back up this long after the last change (1 to 3600; `0`: only on the interval) |
| `TABULA_BACKUP_SHUTDOWN_SECONDS` | `4` | Time a graceful shutdown may spend on a final backup (1 to 25; `0`: none). Keep it under the platform's stop timeout (Fly: 5 seconds) |
| `TABULA_BACKUP_VERIFY_HOURS` | `24` | How often a slice of the newest backup is read back and decrypted to check it (1 to 720; `0`: never). The listing of the bucket is checked at every run either way |
| `TABULA_BACKUP_VERIFY_MAX_MB` | `64` | The most encrypted megabytes one such check reads (1 to 4096) |
| `TABULA_BACKUP_KEEP_HOURLY_HOURS` | `48` | Keep one backup per hour for this long (`0`: none) |
| `TABULA_BACKUP_KEEP_DAILY_DAYS` | `30` | Keep one backup per day for this long (`0`: none) |

### AI features (bring your own key)

AI features run on the relay with an API key that the workspace or the person brings; Tabula does not resell AI. Board content is sent to the chosen provider and processed under its API terms. Anthropic and OpenAI-compatible providers are supported. The AI bar can generate stickies from a prompt, summarise a board, frame or selection with action items, and cluster selected stickies into themes. Each run returns a proposal for review before it is applied. The bar appears for editors when AI is enabled and a usable workspace or personal key, or hosted plan credits, are available (see [docs/ai.md](docs/ai.md) and [docs/ai-toolbar.md](docs/ai-toolbar.md)).

| Variable | Default | Meaning |
| --- | --- | --- |
| `TABULA_AI_SECRET` | none | Accounts mode: 32 random bytes as base64 (`openssl rand -base64 32`) that encrypts stored API keys. Without it keys cannot be saved. The relay refuses to start if it is set but malformed |
| `TABULA_AI_SECRET_PREVIOUS` | none | The secret you are rotating away from, so keys written under it still open and are sealed again under the new one on next use. See "Rotating TABULA_AI_SECRET" in [docs/ai.md](docs/ai.md) |
| `TABULA_AI_API_KEY` | none | Open mode: the operator's provider key |
| `TABULA_AI_OPEN` | unset | Open mode: `1` lets the AI features use `TABULA_AI_API_KEY`. A key alone never turns AI on |
| `TABULA_AI_PROVIDER` | `anthropic` | The provider: `anthropic` or `openai-compatible` in open mode; in accounts mode each saved key carries its provider |
| `TABULA_AI_BASE_URL` | none | Open mode with `openai-compatible`: the API address, for example `https://integrate.api.nvidia.com/v1`; operator-supplied addresses may use `http://`, including a local model server |
| `TABULA_AI_MODEL` | `claude-opus-5-5` | Default Anthropic model (`claude-opus-5-5`, `claude-sonnet-5-5` or `claude-haiku-5-5`). With `openai-compatible` in open mode, set a model id the provider knows; in accounts mode each key carries its model |
| `TABULA_AI_PROXY_URL` | none | Hosted accounts mode: base URL for the workspace's Anthropic Messages proxy; HTTPS is required (HTTP is allowed for loopback tests) |
| `TABULA_AI_PROXY_TOKEN` | none | Hosted accounts mode: credential sent to the AI proxy as `x-api-key`; needed with `TABULA_AI_PROXY_URL` for plan credits |

In accounts mode a workspace owner or admin turns AI on, picks the features and the model, and enters the workspace key under **Admin, AI**; with personal keys allowed, each person can add their own under **Your AI key** in the board menu. Keys are checked with the provider when saved, encrypted at rest, shown afterwards only as their last four characters, and never logged. `TABULA_AI_API_KEY` and `TABULA_AI_OPEN` are ignored in accounts mode.

A run needs the right to edit the board, reads it without private notes, comments or author names, caps what it sends (400 objects, 60,000 characters), stops after 120 seconds or when the request is closed, and writes one audit row (`ai.generate`, `ai.summarise`, `ai.cluster`) with counts and tokens but no text. Each person can have one run at a time and 20 an hour, the workspace 200 an hour (the admin changes both), and a shared key (the workspace key, or the operator's in open mode) runs three at once, a personal key one; these counts are kept in memory and start again when the relay restarts. Saving a key is limited to 10 times an hour per person.

**Open mode warning:** with `TABULA_AI_API_KEY` and `TABULA_AI_OPEN=1` set, anyone who has a board link spends your key, because open mode has no accounts. Only do this on a private instance, and set a spending limit with the provider.

## Screenshots

Screenshots show demo data.

| Shapes panel | Quick actions |
| --- | --- |
| ![Shapes panel with Basic, Arrows, Callouts and Flowchart groups](docs/images/shapes-panel.png) | ![Quick-action bar next to a selected ellipse](docs/images/quick-actions.png) |
| **Text options** | **Locked item** |
| ![Text popover with horizontal and vertical alignment](docs/images/text-options.png) | ![Lock badge shown when hovering a locked item](docs/images/locked-badge.png) |
| **Themes (Matrix, with the picker)** | **Ayu** |
| ![Board menu with the theme picker, Matrix theme active](docs/images/themes-menu-matrix.png) | ![Ayu theme on a board](docs/images/theme-ayu.png) |
| **Accounts: sign in** | **Accounts: home screen with teams** |
| ![Sign-in screen](docs/images/signin.png) | ![Boards page with a team, personal boards and boards shared with you](docs/images/teams-home.png) |
| **Accounts: access removed** | **Accounts: roles in the Share dialog** |
| ![Banner shown when your access to a board is removed](docs/images/access-removed.png) | ![Share dialog listing a team as Editor and a person as Commenter, with the add row](docs/images/share-roles.png) |
| **Built-in template (Business Model Canvas)** | |
| ![The Business Model Canvas template on a board with the session bar ready](docs/images/template-business-model-canvas.png) | |

## What works today

| Spec area | Implemented |
| --- | --- |
| Local-first storage | Yjs document per board, persisted to IndexedDB; offline editing, reload while offline, merge on reconnect; per-user undo/redo that never reverts collaborators' work |
| Sync | Relay with rooms, on-disk persistence, catch-up for late joiners, presence (named cursors, remote selections, participant list with go to a person, requests to look at someone's view that you can follow, go to, dismiss or mute), cross-tab sync |
| Infinite canvas | Pan (space/middle-drag/trackpad/hand), zoom 2%–3200% around the pointer, pinch zoom, fit (Shift+1/2/0), minimap, viewport culling |
| Grid and smart guides | Dots, lines (with major lines), isometric or none; adaptive density; snap to grid; guides align edges and centres and match equal spacing; while resizing, dragged edges snap to equal widths or heights. Hold Alt to bypass guides and grid snapping (see [the guide](docs/guide/smart-guides.md)) |
| Geometry | 31 shapes in four groups (Basic, Arrows, Callouts, Flowchart), picked from one **Shapes** button on the left toolbar that opens a searchable shapes-only panel (click a shape to draw it, or drag it onto the board); sticky notes (own toolbar button) with a folded corner (8 colours plus any custom colour, auto-shrinking text, ink switches to white on dark notes); text (in shapes and sticky notes: aligned left/centre/right and top/middle/bottom, and it stays where it will render while you type); freehand pen; resize, rotate (Shift snaps 15°), align, distribute, z-order, lock (locked items are click-through background; press and hold 0.6 s to unlock; hovering shows a lock badge), duplicate, copy/paste (also plain text → stickies); click an item for a quick-action bar above it (colour, shape, text, align, lock, duplicate, delete); More opens the full properties panel |
| Frames | Nested frames carry their contents. Size presets cover screens, tablets, phones, A3, A4, Letter and square, with custom width and height (see [Shapes, text and sticky notes](docs/guide/shapes-text-notes.md)) |
| Groups | Group and ungroup selected items, including nested groups; enter a group to edit its members. See [the guide](docs/guide/shapes-text-notes.md#groups) |
| Images | Add PNG, JPEG, GIF, WebP or SVG pictures; move, resize, rotate, comment, and include them in PNG/SVG and `.drift` exports. See [docs/images.md](docs/images.md) and [the guide](docs/guide/images.md) |
| Themes | Default, Ayu, Kanagawa, Matrix and Evergreen, chosen under Appearance in the board menu; the whole app (canvas, grid, toolbars, and the default colour of text, drawings, icons and connectors) follows the theme; the choice is remembered on this device; exports always use the light colours on white |
| Sticky colours | Pick a colour before placing (tray beside the toolbar while the sticky tool is on), recolour selected notes, or choose any colour with “+”; custom colours are saved to the board (up to 12) and shared with everyone; your last colour is remembered on your device |
| Connectors | Bound or free ends, straight/elbow/curved routing, 10 arrowheads incl. UML and crow's foot, labels, reverse; drag from a shape's blue dots, or click a dot to add a connected copy; deleting a shape keeps its lines; connectors meet a shape's visible outline, including triangles, stars, arrows and callouts |
| UML | Class/interface/abstract/enum (edited as text: name, `--`, members), actor, use case, lifeline, state, initial/final, package, component, note; 13 relationship presets; Mermaid import (flowchart, classDiagram, stateDiagram-v2, sequenceDiagram) with auto-layout; copy selection as Mermaid |
| Fontshare | Full catalogue (100 families), searchable picker with live previews, weights per family, board heading/body fonts, offline caching via the service worker |
| Icon sets | Search 344k+ icons from 188 sets that Tabula serves itself (no third-party request), filter by set, licence and trademark notes, an Icon credits dialog; "Download for offline" stores a set on this device. Sets Tabula does not host are online only, loaded on request from Iconify with failover to its backup hosts; placed icons store their SVG (sanitised) and render offline |
| Stickers and emoji | Fluent, Twemoji and Noto emoji stickers; emoji can also be inserted into text, and the quick-action bar places sticker reactions next to a selection. Placed stickers are stored in the board, work offline and export with it (see [the guide](docs/guide/stickers.md)) |
| Team exercises | 18 templates (Start/Stop/Continue, 4Ls, Mad/Sad/Glad, Sailboat, Crazy 8s, Brainstorm + affinity map, Lean Coffee, Impact/Effort, MoSCoW, story map, journey map, empathy map, SWOT, pre-mortem, Business Model Canvas, Lean Canvas, Service Blueprint, Design Sprint agenda); session bar with steps, shared timer with chime, private writing + reveal, ask everyone to look at my view (a request each person can answer with Go to, Follow, Dismiss or Mute; it moves nobody), step editor, Markdown summary |
| Dot voting | One-click dot vote from the toolbar on any board (no template needed); dots per person can be any number or unlimited, set per step or changed live for everyone mid-vote, with the number of people on the board and dots placed so far shown alongside; click to add a dot, shift-click to remove; totals hidden until reveal; many dots on one note collapse into a counted badge; results stay on the board after the vote until cleared, with ranked results to copy |
| Polls | Facilitated polls from the toolbar's quick poll button or as a session step: a question with 2–10 options, single or multiple choice, anonymous by default or named; one answer per person, changeable until the poll closes; a card above the session bar for answering and, after reveal, a ranked list with percentages; reveal, copy results as Markdown, or add them to the board as a sticky; answers sync live and work offline, travel in `.drift` and JSON exports, and appear in the Markdown summary once revealed |
| Comments | Threaded comments pinned to a spot or an object (press C or use the speech-bubble tool): post, reply, edit, delete, resolve and reopen; pins follow the object through move, resize and rotate; a Comments panel lists open and resolved threads and flies to a pin; pins can be hidden from the board menu; comments sync live in their own room, work offline, travel in `.drift` and JSON exports, and never appear in PNG/SVG exports. In accounts mode, commenters can comment on a board without being able to edit it |
| Chat | Board, team and workspace channels in accounts mode; live messages, emoji reactions, mentions, in-app mention notices, mention emails, offline copy and unread counts (see [docs/chat.md](docs/chat.md) and [the guide](docs/guide/chat.md)) |
| Join codes | Board-scoped guest access for commenters or editors, with expiry, use limits and revocation (accounts mode; see [docs/join-codes.md](docs/join-codes.md)) |
| Accounts, teams and roles | Email sign-in, workspace and team roles, board sharing, and owner, editor, commenter and viewer access (see [docs/accounts.md](docs/accounts.md)) |
| Kanban boards | Lanes and cards with labels, owners, due dates, filters, CSV export and warn/block WIP limits (limits are checked in the browser; see [docs/kanban.md](docs/kanban.md) and [the guide](docs/guide/kanban.md)) |
| Version history | Browse earlier versions of a board, preview one read-only and restore it (board menu, owners and editors). The relay saves snapshots while people edit, before large deletions and when everyone leaves, and anyone can save a named version; a restore is an ordinary edit that syncs to everyone, shows up as a new version and undoes with Ctrl+Z. See [docs/history.md](docs/history.md) |
| Import/export | `.drift` board files, JSON snapshots, SVG, PNG (2×, real fonts), Markdown summary, Mermaid and kanban cards as CSV; drop files on the board or open them from the home screen |
| MCP tools | AI agents can read and edit boards, add comments, manage groups and use kanban card tools (see [docs/mcp.md](docs/mcp.md) and [the tool guide](docs/guide/ai-tools.md)) |
| AI bar | Generate stickies, summarise a board or selection, and cluster stickies into themes. Shown to editors only when enabled with a usable key or hosted plan credits (see [docs/ai.md](docs/ai.md) and [docs/ai-credits.md](docs/ai-credits.md)) |
| User guide | Built-in, searchable guide served at `/docs/`; source pages are in [docs/guide](docs/guide/index.md) |

### Not built yet (from the spec)

End-to-end encryption; single sign-on, passkeys and two-factor sign-in; email-bound invites; comment mentions and per-thread notifications; editable data tables outside kanban boards; PDF export; boolean shape operations; obstacle-avoiding connector routing and line jumps; character-level text merging with `Y.Text`; imports from other whiteboard formats; peer-to-peer WebRTC sync; and a public desktop release with signing, an updater and supported Windows and Linux builds.

## Fonts and icons

Fontshare fonts are free for personal and commercial use under ITF's Free Font License, which restricts redistributing or serving the font files. Tabula therefore loads fonts only from Fontshare's own servers, caches them in the user's browser for offline use, and stores boards with font names, never font files. The relay never serves fonts. PNG export inlines the fonts temporarily inside the browser to rasterise text; only pixels leave the device.

Icon sets come from [Iconify's open data](https://github.com/iconify/icon-sets) (`@iconify/json`, a build-time dependency) and carry their own licences. The build hosts only sets under CC0, Unlicense, 0BSD, MIT, ISC, Apache-2.0, BSD, OFL-1.1 and CC BY 3.0/4.0; sets Iconify marks hidden, the unmaintained Font Awesome 6 sets and every other licence (NonCommercial, ShareAlike, GPL and the like) are left out. The picker shows each set's licence, flags sets that require attribution and notes that logos are trademarks of their owners. The credits dialog lists every set, and `dist/icons/LICENSES.txt` is the same list as text.

`npm run build` writes the sets to `dist/icons/` after the app, and the relay and the Docker image serve them from there. Two sizes:

| Build | Sets | Icons | Files | Image |
| --- | --- | --- | --- | --- |
| default (`npm run build`) | 188, every allowed, maintained set | 344,033 | 77.5 MB gzip | about 141 MB |
| `ICON_SETS=curated npm run build` | 19, the popular, sticker and a few UI sets (`CURATED_SETS` in `scripts/build-icons.mjs`) | 74,686 | 18.5 MB gzip | about 86 MB |

`docker build --build-arg ICON_SETS=curated -t tabula .` builds the small image. The build reads the installed `@iconify/json` (a pinned devDependency of about 104 MB), takes about 10 seconds the first time and is cached in `node_modules/.cache/tabula-icons`, so an unchanged rebuild is a copy. `npm test` does not build the sets. See [docs/icons-selfhost.md](docs/icons-selfhost.md).

## Tests and checks

```bash
npm test             # vitest
npm run lint         # oxlint
npm run typecheck    # tsc --noEmit
npm run changelog:check  # validate changelog fragments
npm run changelog:fold   # fold fragments into CHANGELOG.md when merging
npm run test:repeat -- test/relay.test.ts --times 20   # flake gate: repeat files under CI=true
npm run visual -- --id TAB-123   # headless screenshots of the app, see docs/visual-check.md
```

Covers CRDT merging of concurrent and offline edits, undo scope, ordering, connector routing, rotated hit-testing, UML text round-trips, Mermaid import/export, markup escaping and XML validity, icon sanitising, the Fontshare catalogue format, and the relay end to end (two clients syncing, offline merge on reconnect, persistence across restarts, invalid room names).

`npm run test:repeat -- [files] [--times 20] [--platform win32] [--bail]` runs test files again and again under `CI=true` (the CI settings of `vite.config.ts`) and reports which tests failed in which runs; without files it takes the test files changed versus `origin/main`. New test files should pass it 10 to 20 times before they are merged. How to write tests that do not depend on timing: `docs/testing.md`. `--platform win32` makes tests that branch on the platform take their Windows branch (`test/platform.ts`).

`npm run visual` needs Chromium once (`npx playwright install chromium`). It starts its own throwaway relay, seeds a fixed board and writes screenshots for every state, theme and width to `tabula-review/<id>/`, so nobody needs the shared Chrome for a look at a change. See [docs/visual-check.md](docs/visual-check.md).

For relay capacity measurements with a simulated class, see [docs/capacity.md](docs/capacity.md).

### Changelog

Add a fragment for each change and let the person merging to `main` fold it into `CHANGELOG.md`. See [changelog.d/README.md](changelog.d/README.md) for the format and workflow.

## CI/CD

GitHub Actions (`.github/workflows/`):

- **CI** runs on pushes to `main`, pull requests, manual dispatch and, as the gates of the **Release** workflow, for every `v*` tag (`docs/releasing.md`: it builds the image with `TABULA_VERSION` set to the tag, pushes it to the Fly registry and can register it with the control plane). Lint, typecheck and `npm audit` run once on Linux. Tests and the app build run on Linux, macOS and Windows with Node 22, 24 and 26; the icon sets are built once, in the Linux job that uploads the `dist` artifact, and in the Docker build. The Docker image then builds with layer caching and is pushed to `ghcr.io/gettabula-app/tabula` on pushes to `main` and on tags. A docs-only push does not rebuild the image, so `:main` can carry an older guide until the next code push: build from the latest `main` before deploying. On pull requests every change starts CI and its first job skips what the change does not need, so use the `CI passed` job as the single required check for branch protection.
- Every test job ends with its slowest test files and keeps the per-file and per-test times as an artifact. On the Windows shards a single test slower than its limit in `test/timing-budget.json` (30 s, half the timeout; exemptions name their own limit and reason) fails the job, so a slow test is made cheaper before it turns into a flaky timeout. A test over its limit is first measured once more, alone: if it is within the limit the second time the log says `stalled sample` with both times and the job passes (a runner stall, not test cost); more than three tests over at once are not re-measured.
- **User guide** builds and tests the in-app guide (`docs/guide/`) on pushes to `main` that change it, since CI skips those when nothing else changed. On pull requests the same check runs inside CI, as the `User guide build` job.
- **CodeQL** scans the code on pushes, PRs and weekly. **Dependency review** blocks PRs that add dependencies with high-severity advisories.
- A newer push to the same branch or PR cancels the run in progress, so a burst of commits only builds the last one. Pushes to `main` that only touch docs or `design/` mockups start no CI run, so they never cancel a code run in progress.
- Dependabot opens grouped weekly updates for npm, Actions and the Docker base image. `@iconify/json` gets its own pull request, because a bump can rename icons.

## Project layout

```
server/relay.mjs     sync relay + static server (serves dist/icons gzipped)
scripts/build-icons.mjs  builds the icon sets into dist/icons (scripts/lib/icons-build.mjs: licence rule, packer, index)
scripts/visual-check.mjs  headless screenshots for visual QA (docs/visual-check.md)
src/store.ts         Y.Doc wrapper: objects, meta, flow, votes, undo
src/sync.ts          IndexedDB persistence, relay connection, identity, board list
src/geometry.ts      bounds, hit-testing, anchors, connector routing
src/markup.ts        SVG for every object type (live render and export)
src/render.ts        camera, grid, culling, overlay (selection, handles, guides, votes)
src/guides.ts        smart guides: alignment and equal-spacing snapping (pure)
src/app.ts           tools, selection, drag/resize/rotate, snapping, clipboard, presence
src/editor.ts        in-place text editing
src/flow.ts          facilitation: steps, timer, private writing, voting
src/polls.ts         polls: questions, answers, open and closed, reveal, results
src/templates.ts     team exercise templates
src/uml.ts, src/mermaid.ts, src/fonts.ts, src/exporters.ts
src/icons.ts         icon manifest, hosted and online sets, previews; icon-search.ts, icon-licences.ts, icon-offline.ts
src/ui/              rail, library drawer, properties, font picker, session bar, home
public/sw.js         offline cache for the app, the icon sets, Fontshare and Iconify
```

## Licence

Tabula is free software under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only). You may use, change and self-host it. If you run a changed version as a service for other people, you must offer them its source code. Third-party icon sets and fonts keep their own licences (see above).
