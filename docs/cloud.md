# Hosted workspaces

Tabula can run as one workspace of a hosted service: a separate control plane (billing, provisioning) starts the instance, tells it how many seats the customer paid for, and can lock it when the subscription lapses. This page is the instance side of that contract. It is generic: any control plane that speaks it will do, and **an instance without the variables below behaves exactly as described in `docs/accounts.md`**: none of the routes, tables, banners or checks here exist for it.

Not in it: creating or deleting the instance, Stripe, routing. Those belong to the control plane.

Fly's edge replays hosted requests, but Fly cannot replay request bodies over 1 MB; TAB-127 documents how image uploads stay visible and retry.

## Turning it on

| Variable | Meaning |
| --- | --- |
| `TABULA_CLOUD_TOKEN` | Shared secret, at least 32 characters, no spaces. The control plane sends it as `Authorization: Bearer <token>`, and the instance sends it back on its own calls |
| `TABULA_CLOUD_URL` | Base URL of the control plane. `https://`, or `http://` for `localhost`, `127.0.0.1` and `[::1]` only (local development). No credentials, query or fragment; a path prefix is kept, trailing slashes are dropped |
| `TABULA_CLOUD_WORKSPACE_ID` | This workspace's id at the control plane (letters, digits, `.`, `-`, `_`, up to 128). Used in the path of the instance's calls |

Cloud mode is on only when `TABULA_AUTH=on` **and** all three are set.

- None set: nothing changes, the routes below answer `404`.
- Some but not all set: the relay refuses to start and names the missing variables. A token that is too short, a URL that is not allowed or an id that does not fit refuse startup too.
- All set with `TABULA_AUTH` off: cloud mode stays off and the relay logs that the variables are ignored. (The values are still validated.)

## Calls from the control plane

The endpoints below sit under `/api/internal/`. They need the bearer token and nothing else: no cookie, no `x-tabula` header, and a session cookie that comes along is ignored. The token is compared in constant time (both sides are hashed first, so the length of a guess shows nothing). A missing or wrong token answers `401 {error: 'unauthenticated'}` with `WWW-Authenticate: Bearer`. The public edge must not forward `/api/internal/` to browsers.

For a directory backup pull, the control plane derives and keeps a separate bearer token and gives the instance only its SHA-256 digest in `TABULA_BACKUP_PULL_TOKEN_SHA256`. The instance's `/api/backup-export/` route is public to the service (bearer only, no user session), so the control plane can call it to wake a stopped machine; the returned files remain sealed ciphertext.

```
GET /api/internal/usage
  -> { seats, guests, members, updates: { auto: boolean } }
```

`seats` counts people with the role `owner`, `admin` or `member` who are not disabled. `guests` counts guests who are not disabled. `members` is everyone with an account, disabled people included.
`updates.auto` is whether other automatic updates are enabled. It defaults to `true`; security updates are always applied. It is reported here whether the setting is explicit or still at its default.

```
GET /api/internal/stats
  -> {
       boards,
       members: { active, disabled },
       guests,
       activePeople: { last7d, last30d },
       aiRuns: { last30d },
       chatMessages
     }
```

This is a counts-only response; every value is a number, and it contains no names, addresses, ids, titles or content. `boards` is the count of `boards` rows with no `deleted_at`. `members.active` counts enabled `owner`, `admin` and `member` accounts, matching `usage.seats`. `members.disabled` counts all disabled accounts (including a disabled guest); `guests` counts enabled guests, matching `usage.guests`. Together, `members.active + members.disabled + guests` equals `usage.members`.

`activePeople` counts distinct account ids with a session created or last seen in the inclusive rolling window, or an audit actor on a recorded board change in the window. The recorded changes are board create, metadata update, delete, restore, version restore, accepted AI proposal and asset upload. Session timestamps are not a log of every request, and live whiteboard edits do not record an editor id; board `updated_at` cannot identify who edited. So this is the number the instance can identify from those records, not a count of everyone who edited canvas content.

`aiRuns.last30d` counts audit rows for the current AI features (`ai.generate`, `ai.summarise` and `ai.cluster`) in the inclusive rolling 30-day window. A run is recorded after provider streaming starts, including runs that then fail; refusals before streaming and key tests are not runs. `chatMessages` counts retained rows in `chat_messages` where `deleted_at` is null, including edited messages. Deleted tombstones and messages already purged by chat retention are excluded. It is zero when chat is off. Like `usage`, this endpoint is registered only in cloud mode; in open mode it answers 404.

```
GET /api/internal/backup-status
  -> { enabled: false }                         (backups are off)
  -> { enabled: true, running, keyId, intervalMinutes, settleSeconds, dirty, lastTrigger, lastRunAt, lastSuccessAt,
       lastError, lastFailureAt, lastFailureError, consecutiveFailures, lastManifest, bytesStored, objects, manifests,
       nextRunAt, prune, verifiedAt, verifyChecked, missingObjects, wrongSizeObjects, unrepairableObjects,
       deepVerifiedAt, deepChecked, deepDamaged, deepSkipped, deepCovered,
       restore: { inProgress, maintenance, last, protectedBackups, oldData } }
```

The state of the off-site backups (`docs/backups.md`): `{enabled: false}` unless `TABULA_BACKUP_*` is set. Times are milliseconds since the epoch. `lastSuccessAt` moves on every successful run, also one that found nothing to upload; `lastFailureAt` and `lastFailureError` stay after a later success and `consecutiveFailures` counts failed runs since the last success, which is what an alert watches (for example no success for three intervals, or two failures in a row). Errors are short and hold a status and an S3 error code at most, never a key, a header or a URL. `dirty` says the workspace changed since the last backup that could hold the change, `lastTrigger` (`interval`, `settle`, `shutdown`, `manual` or `null`) why the latest run started and `settleSeconds` how long the workspace is quiet before a settle backup; a workspace that changes is backed up that long after its last change and once more when the machine is stopped (`docs/backups.md`, When it runs). `verifiedAt` and `missingObjects`, `wrongSizeObjects` and `unrepairableObjects` come from the cheap check every run makes (the bucket listing against the kept backups), and `deepVerifiedAt`, `deepChecked`, `deepDamaged`, `deepSkipped` and `deepCovered` from the deep verify that reads and decrypts a slice of the newest backup about once a day (`docs/backups.md`, Checking the backups); an alert on any of the four counts staying above 0 for more than one run catches a bucket that lost or damaged an object, and the next run puts it back where a file still has it. Counts and times only, never an object id. Like `usage` it is a plain `GET` and stays reachable while the workspace is read-only. `restore` is the state of the last restore (`docs/backups.md`, Restoring): whether one is running, whether the instance is in maintenance mode, the last result with its time and manifest name, the backups protected from pruning and the old data kept aside; names, times, counts and codes only. It is also the one call that is answered while a restore holds the instance in maintenance mode (everything else under `/api/` is `503 {error: 'restoring'}`, `/api/health` answers `{ok: true, restoring: true, ...}`). The final backup of a stop has `TABULA_BACKUP_SHUTDOWN_SECONDS` (default 4) because Fly stops a machine with SIGINT and kills it after 5 seconds, and the provisioning sets no `stop_config`. A longer wait there (`kill_timeout` in the machine's `stop_config`, with a larger `TABULA_BACKUP_SHUTDOWN_SECONDS`) is a change in tabula-cloud, not here. A whole-workspace restore ends with the process exiting with code **75**: provisioning must keep Fly's restart policy at `on-failure` (exit code 0 would leave the machine stopped), and the control plane should expect the instance to be unreachable for a short time afterwards. Every session ends with a restore and the restore keeps the live `cloud.limits`, so a lock or a seat limit set by the control plane survives it.

```
GET /api/internal/volume
  -> { volumeId, workspaceId, flyVolumeId, adoptedAt, startedAt, lastAdoption }
```

Which data volume the instance runs on (`docs/backups.md`, Volumes and restores): the ids of `DATA_DIR/volume.json`, `adoptedAt` (milliseconds, `null` if the volume was never adopted), `startedAt` (when this process started) and `lastAdoption`, the newest entry of the marker's history (`{ at, from: { workspaceId, flyVolumeId }, to: { ... }, reason }`) or `null`. Ids only. Hosted workspaces only, with the bearer token, like the other calls here.

```
GET /api/internal/version
  -> { version, startedAt, build: { schema, maxReader }, disk: { schema, minReader, legacy }, capabilities: { tracker: { fts5: boolean, enabled: boolean } }, updates: { auto: boolean } }
```

The release label (`null` if `TABULA_VERSION` was not set), process start time in milliseconds, the schema generations and rollback limits this build declares, and the generations and legacy status of its database files. Each nested schema field has `directory` and `chat` values; chat is `null` when it is off. This endpoint contains no secrets. See [migrations.md](migrations.md) for the reader rule and release contract.
`capabilities.tracker.fts5` reports the same SQLite tokenizer probe required by migration 12; `capabilities.tracker.enabled` reports whether `TABULA_TRACKER=on`. These fields let the control plane distinguish a compatible SQLite build from one with ticket tools enabled.
`updates.auto` is the current automatic update setting, defaulting to `true`; security updates are always applied.

**Contract for an adopt-volume action.** When the control plane swaps a machine's mount to another volume (a Tier 1 restore from a snapshot, or a move), it should:

1. set `TABULA_FLY_VOLUME_ID=<the new volume id>` on the machine together with the mount change (so the instance can tell a restored copy from the disk it had: a changed id is adopted on its own, every account and guest session ends, every join code is revoked and an audit row `volume.adopt` is written);
2. after the machine is back, call `GET /api/internal/volume` and check that `flyVolumeId` is the new id and that `lastAdoption.at` is newer than the swap (and `lastAdoption.to.flyVolumeId` is the new id), then record the new volume id (`fly_volume_id`) as its own;
3. then push the workspace's current limits (`PUT /api/internal/limits`, as after any resume): the volume carries the read-only flag, seats and banner as they were at snapshot time, and the instance keeps those until the control plane sends the live values;
4. if the machine does not come back, read its logs: a volume of another workspace makes the instance refuse to start with a message naming both workspace ids. Moving a volume to another workspace on purpose takes `TABULA_ADOPT_VOLUME=<the new workspace id>` for one start; remove it afterwards (the log says so while it is still set). That adoption also revokes every MCP access token and invite link the volume brought from the other workspace; a restored copy of the same workspace keeps its own.

The first deploy that sets `TABULA_FLY_VOLUME_ID` on an existing machine only records it and signs nobody out. Not verified: whether Fly exposes the volume id to the machine on its own (an environment variable or the metadata service); until that is known, the control plane must set the variable itself.

```
PUT /api/internal/limits  { seatLimit?: number | null, readOnly?: boolean, banner?: string | null, billing?: boolean, aiCredits?: boolean, trialEndsAt?: string | null, state?: string | null }
  -> { seatLimit, readOnly, banner, billing, aiCredits, trialEndsAt, state }      (what is stored now)
```

- Fields that are left out stay as they are; `null` clears `seatLimit`, `banner`, `trialEndsAt` or `state`. The lifecycle fields default to `null`, so older control planes that omit them continue to work. An empty body is `400 Nothing to change`.
- `billing` (default `true`) is `false` for a workspace that is provided free (education, internal): it has no subscription, so `/api/me` says `workspace.billing: false`, the owner sees "This workspace is provided free (education or internal). There's nothing to bill." where Manage billing would be, and `POST /api/billing/portal` answers `409 no_billing` without calling the control plane.
- `aiCredits` is optional and defaults to `false` until the control plane pushes it. It tells the hosted AI config whether the workspace plan enables the AI credits capability; `/api/me` exposes it as `workspace.aiCredits`, and `/api/ai/config` returns it as `credits`. Older instances reject this unknown field with `400`, so the control plane must retry the limits push without `aiCredits` when an older instance refuses it.
- `seatLimit` is a whole number from 1 to 100000. `banner` is at most 300 characters on a single line (no control characters), trimmed; an empty text means no banner. Unknown fields are refused with `400`, so a typo cannot silently do nothing.
- `trialEndsAt` is either null or an ISO 8601 UTC timestamp ending in `Z`, at most 40 characters, with a year from 2000 through 2100; an invalid timestamp is read as `null` and logged as a warning, and the rest of the push is applied (the field is cosmetic, so it must never block a seat limit or read-only change; the other fields stay strict and are refused with `400`). `state` is null or 1–32 lowercase letters, digits, underscores or hyphens; anything else is read as `null` with a warning. The client shows a trial end date only for `state: "trialing"`; other (including unknown) states show no trial label.
- The limits are stored in the `settings` table (`cloud.limits`, one JSON value; migration 3) and survive restarts. Each change writes an audit row `cloud.limits` with no actor (the dashboard shows "System") and tells the relay, which applies it to open sockets at once.
- This endpoint stays reachable while the workspace is read-only (it is how the lock is lifted).

```
POST /api/internal/notify  { template: 'trial-ending', date: string }
  -> { sent }                          (owners mailed)
  -> { sent: 0, duplicate: true }      (this date was notified before; nothing is sent)
```

Asks the instance to mail the workspace owners: every account with the role `owner` that is not disabled, and nobody else. It is how the control plane warns of a trial that is about to turn into a paid subscription.

- The body is strict, like the limits: unknown fields are `400`, and so is any `template` but `trial-ending` (an allowlist, so more notices can be added later). `date` is written as `7 Nov 2026` (day, three letter month, year; nothing else, so it is safe in a subject line). An empty body is `400` too.
- Each owner gets one mail through the instance's own mailer (see `TABULA_MAIL` in the README) with `template: 'trial-ending'`, `params: { link, date }` (`link` is the workspace address, `<TABULA_BASE_URL>/`) and the subject `Your Tabula trial ends on <date>`. The `text` says that the free trial of the workspace ends on that date, that the subscription then starts automatically with the card on file, and that the owner can review or cancel it under Admin, Overview, Manage billing, followed by the link on a line of its own. With a mail relay in webhook mode the relay renders its own wording from `template` and `params`; the text is what the `log`, `file` and `smtp` modes send.
- The mails are sent together and awaited. `200 {sent}` counts the owners mailed, so one owner whose mail failed does not fail the call. When every mail failed the answer is `502 {error: 'bad_gateway'}` so the control plane retries; the log says how many failed, never to whom. No owner to mail is `200 {sent: 0}`.
- **A repeat is not mailed again.** After a call that mailed at least one owner, the instance keeps the date in the `settings` table (`cloud.trialEndingNotified`). The same date again answers `200 {sent: 0, duplicate: true}` and sends nothing, also when it arrives while the first call is still sending, so a retried job never mails twice. Only the last date is kept: another date mails again. Nothing is kept after `502` or when there was no owner, so those calls can be retried.
- A call that mailed someone writes an audit row `cloud.notify` with no actor (the dashboard shows "System") and `{template, count}`. Addresses are never stored there.
- Like the limits, this endpoint stays reachable while the workspace is read-only.

## Client addresses

Every rate limit (sign-in links, MCP tokens, the AI routes, uploads) counts by the client's address. On Fly the instance never sees the visitor's connection: the edge does, and with `fly-replay` the request may pass through another machine before it arrives. So the instance must be told which header to believe (`server/client-ip.mjs`, TAB-71):

| Variable | Value | Meaning |
| --- | --- | --- |
| `TABULA_TRUST_PROXY` | `1` | Believe the header below at all. Without it the connection's address counts and both headers are ignored, so every visitor behind the edge shares one limit |
| `TABULA_CLIENT_IP_HEADER` | `fly-client-ip` | **Set this on Fly.** The address Fly's edge saw. Fly sets it itself, a visitor's own value does not survive the edge, and it stays the visitor's address through `fly-replay` |
| | `x-forwarded-for` (the default) | The rightmost `X-Forwarded-For` entry, for a single reverse proxy (Caddy, nginx) that appends the client address. Behind Fly with `fly-replay`, the rightmost entry can be the replaying machine, and then every visitor would share its limit |

Any other value refuses startup; `TABULA_CLIENT_IP_HEADER` without `TABULA_TRUST_PROXY=1` is ignored with a warning. A header value that is not an IP address falls back to the connection's address. **Recommended for hosted workspaces: `TABULA_TRUST_PROXY=1` and `TABULA_CLIENT_IP_HEADER=fly-client-ip`.**

**Checking it on the first deploy.** `GET /api/internal/client-ip` (bearer token, like the other internal calls, also while read-only) answers what the instance saw for that very request:

```json
{ "address": "203.0.113.7", "trustProxy": true, "header": "fly-client-ip",
  "seen": { "connection": "fdaa:0:…", "xForwardedFor": "203.0.113.7, 172.19.4.2", "flyClientIp": "203.0.113.7" } }
```

1. From your own machine, through the public address (not `fly ssh`), call it: `curl -s -H "Authorization: Bearer $TOKEN" https://<workspace host>/api/internal/client-ip`.
2. Compare `address` with your public address (`curl -s https://ifconfig.me`). They must be equal.
3. Look at `seen`: `flyClientIp` should be your address. If `xForwardedFor`'s last entry is not your address (it is a machine address when the request was replayed), `x-forwarded-for` would be wrong for this setup; that is the case TAB-71 was opened for.
4. Call it from a second network (a phone off Wi-Fi): a different `address`. Then rate limits are per visitor.

Only addresses come back: header values are cut at 300 and 64 characters and nothing else of the request is echoed. The tests (`test/proxy.test.ts`) run a fake Fly edge with a replay hop and show both settings: with `fly-client-ip` each visitor is limited alone, with the default every visitor shares the hop's limit.

## Source policy

On Fly every app of an organisation shares one private network (6PN), so a machine of one customer's workspace can open a connection to another workspace's instance directly (`tabula-ws-<other>.internal:8787`), skipping the edge. The application still checks every request, but the network does not separate tenants (TAB-103; the Fly spike is in tabula-cloud `docs/internal-network.md`, section 7). `TABULA_SOURCE_POLICY=proxy` closes that at the instance:

| Variable | Value | Meaning |
| --- | --- | --- |
| `TABULA_SOURCE_POLICY` | `off` (the default) | No check. Self-hosters and every other setup. |
| | `proxy` | A connection is served only when its peer address is in the list below. Any other peer is reset (HTTP request or WebSocket upgrade) and the first refusal of each address is logged as `source policy: refused a connection from <address>`. `GET /api/health` is answered whatever the peer, because the platform's own check may not come from either range. |
| `TABULA_ALLOW_SOURCES` | comma list of addresses and CIDRs | Replaces the default list; read only with `proxy`. Default: `127.0.0.0/8, ::1/128, 172.16.0.0/12`. |

Why that list: what Fly's proxy forwards (visitors, `fly-replay` from the edge, Flycast calls of the control plane) arrives from the proxy's private IPv4 range (172.16.x.x was observed in the spike), direct 6PN traffic from another app arrives from its own `fdaa:` address, and the Machines API's exec path runs on loopback. Any other value of `TABULA_SOURCE_POLICY` refuses startup, as does a bad entry in `TABULA_ALLOW_SOURCES`.

**Which image has it.** The policy is in commit 4a7be16 and later. The v4 image was built without it, so a v4 workspace ignores `TABULA_SOURCE_POLICY` and tenant-to-tenant isolation is **not in effect until the first image built after 4a7be16 (v5 or later) is rolled out**. Before a rollout starts, the isolation gate (health check, sign-in through the edge, control-plane calls, a refused direct `fdaa:` connection) must pass on a throwaway workspace; tabula-cloud's `docs/second-deploy.md` has it.

**Turning it on for hosted workspaces.** The control plane puts `TABULA_SOURCE_POLICY=proxy` in every workspace machine's environment (`src/provision.mjs` in tabula-cloud; existing machines get it with the next config update). It is not baked into the image, so a self-hosted container of the same image stays open.

**Recovery first.** If a workspace becomes unreachable after turning it on, set `TABULA_SOURCE_POLICY=off` in the machine's environment (or `fly machine update` with the env change) and restart it; nothing else changes. Visitors come through the proxy, so they are never refused; what is refused is a peer on 6PN.

**Checking it (proof steps, with Johan's go on a throwaway Fly workspace pair).** Two workspaces A and B, both created with the policy on:

1. From your machine: `curl -fsS https://<A host>/api/health` answers, and the workspace loads in a browser (the edge's replay arrives from the proxy range).
2. From a console on B (`fly ssh console --app tabula-ws-<b>`): `curl -m 5 -sS http://tabula-ws-<a>.internal:8787/api/health` answers (health stays open); `curl -m 5 -sS -o /dev/null -w '%{http_code}\n' http://tabula-ws-<a>.internal:8787/api/me` must fail with a reset (curl error 52 or 56), not `401` or `200`.
3. The same from B to `http://tabula-ws-<a>.internal:8787/` (the page) and a WebSocket attempt (for example `curl -m 5 -i -H 'Connection: Upgrade' -H 'Upgrade: websocket' ...`) must fail the same way.
4. On A, `fly logs --app tabula-ws-<a>` shows `source policy: refused a connection from fdaa:...` with B's address.
5. The control plane still reaches A: `GET /admin/workspaces/<id>` through the operator proxy, then a usage pull or `PUT /api/internal/limits` from the control plane succeeds (Flycast calls arrive through the proxy). If the control plane moves to the exec path, it runs on loopback and is unaffected.
6. **(unverified until measured)** that the proxy's range is `172.16.0.0/12` in every region and that a request replayed from another machine arrives from it. If step 1 fails, read the refused address in the log and widen `TABULA_ALLOW_SOURCES`.

Not covered: the control plane's own listeners (tabula-cloud `INTERNAL_SOURCE_POLICY`), and a request from inside the proxy range that is not Fly's proxy (the check is as strong as Fly's isolation of those addresses).

## Read-only

While `readOnly` is true:

- **Relay**: every connection is read-only for the board room and the comments room, whatever the person's role. Sockets that are already open are re-evaluated the moment the limits change, in both directions, and told about it (see below). Document updates are dropped, state requests and awareness (cursors) still work.
- **API**: every mutating route answers `402 {error: 'read_only', message}`. Not blocked: all `GET`s, `POST /api/auth/request`, `POST /api/auth/verify`, `POST /api/auth/logout`, `POST /api/auth/logout-all`, `PUT /api/internal/limits`, `POST /api/internal/notify` and `POST /api/billing/portal` (the owner has to reach billing to put things right). Signed-out writers still get `401` first.
- **App**: boards open read-only (the same switch as for viewers) with a **Workspace is read-only** badge instead of **View only**; the banner shows as described below. An open board switches within a request round trip of the change, and reconnects when the workspace is writable again.

### Telling open boards at once

A workspace that turns read-only (or writable again) does not wait for the app's next `/api/me` refresh:

- **Hint.** When `PUT /api/internal/limits` changes `readOnly`, the relay sends one small message on every open sync socket, board and comments room alike, after it has re-evaluated that socket. It is binary type **4** (y-websocket uses 0 sync, 1 awareness, 2 auth and 3 query awareness) followed by a `varString` with the JSON `{"readOnly": <bool>}`. Only a change of `readOnly` sends it: not a banner or seat limit change, and not a `PUT` that repeats the value. Sockets that are refused or already closed get nothing, and sockets that connect later need nothing, because they are checked on connect and the app reads `/api/me` on load. The relay never acts on this type when a client sends it (like any unknown type, it is ignored).
- **The app does not trust it.** The payload is only a hint. The handler (`onWorkspaceHint` in `src/sync.ts`, registered on both providers of an open board through y-websocket's per-provider `messageHandlers`) asks `/api/me` and applies the answer exactly as the five minute refresh does: store and comments read-only switch, badge and banner. The board socket and the comments socket each get the hint, and hints within 150 ms become one request. An old client that does not know type 4 logs "Unable to compute message" once per hint and carries on; the five minute refresh still catches it up.
- **Back to writable.** When a refresh shows `readOnly` going from true to false, the board disconnects and reconnects both of its rooms. The fresh state exchange (sync step 1 and 2) sends everything that was typed while the relay was dropping updates, which also clears the stuck socket described below. It is a normal CRDT merge, so nothing is overwritten. This happens whichever refresh learns about the unlock: the one the hint brought forward, the five minute one, or the first one after a hidden tab is seen again. Turning read-only never reconnects, and neither does signing out or a board the relay has refused.

What remains: edits typed in the moments between the relay flipping the switch and the hint reaching the browser are dropped by the relay. They stay in the browser and are sent by the reconnect once the workspace is writable. Until that reconnect the relay cannot apply later edits from that client either, because they build on the dropped ones, so a client that is not told about the unlock (an old client, or a lock and unlock that both fall between two refreshes of a tab that missed the hint) stays stuck until it reconnects or reloads.

## Seats

A seat is an account with the role `owner`, `admin` or `member` that is not disabled. Guests are free. When `seatLimit` is set and the seats in use have reached it:

| Action | Answer |
| --- | --- |
| Create a team invite (`POST /api/teams/:id/invites`) | `409 seat_limit` |
| Finish a sign-in that would create a new member through an invite (`POST /api/auth/verify`) | `409 seat_limit`; nobody is created, and neither the invite nor the emailed link is used up, so the same link works once a seat is free |
| Enable a disabled owner, admin or member, or turn a guest into a member, admin or owner (`PATCH /api/members/:id`) | `409 seat_limit` |

Everything else keeps working: people who already have an account sign in, roles change between owner, admin and member, people are disabled or removed (which frees a seat), existing members accept invites to more teams. `POST /api/auth/request` does not look at the limit, so it answers every address the same way as before and reveals nothing about a full workspace; the link is mailed and the refusal comes when it is used. The messages say how many seats there are and what to do (free one, or ask the owner to add seats under billing). A limit below the number of seats in use blocks new seats but removes nobody.

## What the app shows

`GET /api/me` gains `workspace: { readOnly, banner, seatLimit, seatsUsed, billing, aiCredits }` in cloud mode and only then. `aiCredits` is present for every workspace member; owners and admins also receive `trialEndsAt` and `state` in that workspace object, while these lifecycle fields are absent for members and guests. The admin-only `GET /api/admin/overview` includes both lifecycle fields at the top level. The app uses `/api/me` for:

- A thin banner with the banner text above the home screen and the board (above the board it is a single line and the editing chrome moves down). A read-only workspace without a banner text gets "This workspace is read-only."
- Read-only boards and the badge described above. A viewer stays a viewer when the workspace becomes writable again.
- Toasts with the server's message when a seat limit or the read-only lock stops an invite, a role change, an enable or a sign-in link.
- **Manage billing** on the admin dashboard's Overview, for the workspace owner only. It asks the instance for the portal address and opens it in the same tab.
- A refresh of `/api/me` every five minutes while the tab is open (skipped while the tab is hidden and run when it is seen again; nothing at all in open mode and on servers without cloud mode), and at once when the relay sends the read-only hint. The five minute refresh is the fallback if the hint is missed.

## Calls to the control plane

All with `Authorization: Bearer <TABULA_CLOUD_TOKEN>` and a 10 second timeout; redirects are not followed.

```
POST /api/billing/portal            (workspace owner only; 404 without cloud mode)
  -> { url }
```

The instance calls `POST <TABULA_CLOUD_URL>/v1/workspaces/<id>/portal` and returns its `url`. Anything but an `https://` URL, an error status, an unreadable answer or a timeout is `502 bad_gateway`. Other roles get `403`.

```
POST <TABULA_CLOUD_URL>/v1/workspaces/<id>/usage   { seats, guests, autoUpgrade? }
POST <TABULA_CLOUD_URL>/v1/workspaces/<id>/settings   { autoUpgrade }
```

Sent 30 seconds after the last change to the people in the workspace (an account created through an invite, a role change, disable or enable, a removal). A burst of changes is one report, with the counts read when it is sent, and a report that would repeat the last successful one is skipped. A failure is logged (without the token or the answer) and never reaches the request that caused the change; the control plane also pulls `GET /api/internal/usage` now and then. Reports that are still waiting when the process stops are not sent.

When the owner changes **Automatic updates** in Admin → Settings, the instance sends the setting to `POST .../settings` immediately as `{ autoUpgrade: boolean }`. It expects `200 { autoUpgrade: boolean, securityAlwaysApplied: true }`; any other answer is treated as a failure. The value is saved locally first and is not rolled back on failure. Retries happen after 30 seconds, 2 minutes, 10 minutes and every 30 minutes after that, without a limit; a newer change replaces the pending retry. On boot, an explicitly stored value is sent again after about 5 seconds. Closing the instance cancels the retry timer. Usage pushes also include `autoUpgrade` only after the owner has explicitly set the setting; it is left out while the default is in effect. The push debounce skips repeats only when counts and this optional value are unchanged.

The hosted setting is stored in the instance settings table under `updates.auto`: `1` means on, `0` means off, and no row means on by default. Turning off applies only to other updates; security updates are always installed. Self-hosted instances have no setting or admin route for this feature. On hosted instances, `GET /api/admin/updates` is available to owners and admins; `PUT /api/admin/updates { auto: boolean }` is owner-only and refused while read-only. Both answer `{ auto, synced, securityAlwaysApplied: true }`; `synced` is true before the setting has ever been explicitly set, and afterwards means the current value has been accepted by the control plane.

## Tests

`test/cloud.test.ts` covers configuration, validation, the seat rules, the portal, the usage reports, automatic update saves and retry timing, and the trial-ending notice (owners only, the duplicate guard, partial and total mail failure) in process, with a fake `fetch` and hand-driven timers (both are injectable in `createCloud`). `test/cloud-relay.test.ts` starts the relay next to a fake control plane and covers the endpoints (including the trial-ending notice through the real mail setting), the 402 rule, sockets that are open when the lock changes, the seat limit through the real sign-in flow, the portal and persistence across a restart. `test/cloud-logic.test.ts` covers the client rules, including the coalescing of hints and the unlock watcher, and `test/workspace-hint.test.ts` runs a board's chain from hint to refresh to reconnect with fake providers. The hint on the wire, who gets it, that clients cannot send it and that a reconnect sends what was typed during the lock are in `test/cloud-relay.test.ts`.
