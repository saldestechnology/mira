# Backups

Tabula can back up its data directory on a schedule, **encrypted on the instance before anything leaves it**. The default target is an S3-compatible bucket (Tigris, Cloudflare R2, Backblaze B2, MinIO, AWS S3). A directory target keeps the same sealed objects and manifests on the instance volume for another process to pull. Backups are off unless you configure a target and its key.

> **Losing the key means losing the backups.** Every backup is encrypted with `TABULA_BACKUP_KEY`. Without that key (and, after a key change, the older keys that sealed older backups) the backups **cannot be read by anyone, including us**. There is no recovery and no reset. Keep a copy of the key somewhere that is not the server it protects, such as a password manager. On the hosted service, the operator holds the master copy of each workspace's key.

Restore is built, as owner-only API routes and as functions of the server (see [Restoring](#restoring)), and the owner uses it from the **Backups tab of the admin dashboard** (see [In the app](#in-the-app)). It has been tested against a faithful in-memory S3 and with crashes injected at every step of the swap, but **not against a real provider and not on a real Fly machine**, and a backup that has never been restored is not a backup. Do a restore drill before you rely on it.

## What is backed up

Everything below is relative to `DATA_DIR`.

| What | How it is read | Backed up |
| --- | --- | --- |
| `directory.sqlite` | `VACUUM INTO` a temporary file next to it, taken while the server runs, in a worker thread (see [When it runs](#when-it-runs)); the temporary file is deleted afterwards, also on an error | yes (accounts mode; in open mode only if the file exists) |
| `<boardId>.yjs` and `<boardId>~comments.yjs` | a room that is **open** is taken from the server's memory (everything typed so far, including what is not saved yet); any other room from its file | yes |
| `history/<boardId>/index.json` and the version files it lists | `index.json` is read first, then only the versions it lists that still exist; the stored index lists exactly the versions that were stored | yes |
| `assets/<aa>/<sha256>` | the images people add to boards (docs/images.md): one file per distinct content, named by the SHA-256 of its bytes and never changed once written. Each file is read and hashed; one that does not match its name is damaged and is left out (and counted in `skipped`), so a restore never meets it. After the first run an image costs nothing again, because its name does not change | yes |
| `chat.sqlite` (and its `-wal` and `-shm` working files) | chat messages, mentions, reactions and read markers (`docs/chat.md`). Read with `VACUUM INTO` like the directory. **A message that was erased or deleted disappears from the newest backup at the next run, but older backups still hold it until they age out** (48 hours of hourly and 30 days of daily copies by default); after a restore, erasures made since that backup are not re-applied by themselves | yes (accounts mode with chat on) |
| `assets/tmp/`, `assets/index.json`, any other name under `assets/` | working files and the open-mode index (open mode has no backups) | no |
| `*.tmp`, `directory.sqlite-wal`, `directory.sqlite-shm` | working files | no |
| `outbox.jsonl` | the mail outbox of `TABULA_MAIL=file` (sign-in links) | no |
| `history/<boardId>/index.json.corrupt-*`, version files the index does not list | set-aside and unreferenced files (the history sweep removes the latter) | no |
| anything else, links, and files whose names do not fit the patterns above | not Tabula's | no |

This is everything the server writes into `DATA_DIR`. Images are separate files under `assets/` (the board documents hold only a reference to each), which is why they have a row of their own above: without it a backup would have the boards and none of their pictures. Which board may read which file is in the `assets` table of `directory.sqlite`, which is backed up with the database.

In the database copy the engine leaves out its own traces (the `backup.status` setting and the `backup.run` and `backup.failed` audit rows) and fixes the SQLite file change counter. Without that, every run would change the database it is about to copy, and no run would ever be "nothing changed". A restored database therefore has no backup status and no backup audit rows (a restore removes them from a database that carries them).

## Turning it on

The default `s3` target is on when its five required variables are set. The `dir` target needs only `TABULA_BACKUP_KEY`. Missing destination variables or malformed values are startup errors that name the variable and never print its value.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TABULA_BACKUP_TARGET` | `s3` | `s3` writes to the configured bucket; `dir` writes a local export directory |
| `TABULA_BACKUP_DIR` | `<DATA_DIR>/backup-export` | For target `dir`, an optional absolute path for the local export. It is created when needed |
| `TABULA_BACKUP_PULL_TOKEN_SHA256` | unset | For target `dir`, the 64-character SHA-256 hex digest of the bearer token allowed to pull the export. The token itself is held by the control plane |
| `TABULA_BACKUP_S3_ENDPOINT` | required for `s3` | The S3 endpoint, for example `https://fly.storage.tigris.dev` or `https://<account>.r2.cloudflarestorage.com`. `https://`, or `http://` for `localhost`, `127.0.0.1` and `[::1]` only. A bare address: no credentials, path, query or fragment |
| `TABULA_BACKUP_BUCKET` | required for `s3` | The bucket (3 to 63 lower case letters, digits, dots, hyphens) |
| `TABULA_BACKUP_ACCESS_KEY` | required for `s3` | Access key id |
| `TABULA_BACKUP_SECRET_KEY` | required for `s3` | Secret access key |
| `TABULA_BACKUP_KEY` | required | The encryption key: 32 random bytes as 64 hex characters or as base64. Make one with `openssl rand -hex 32` |
| `TABULA_BACKUP_KEY_PREVIOUS` | none | Older keys, comma separated, for **reading** backups sealed before a key change. Writing always uses `TABULA_BACKUP_KEY` |
| `TABULA_BACKUP_PREFIX` | `tabula` | Everything is stored under this key prefix. Letters, digits, `. - _` and `/` between them |
| `TABULA_BACKUP_REGION` | `auto` | For target `s3`, the signing region. `auto` is right for Tigris and R2; AWS needs the bucket's region |
| `TABULA_BACKUP_PATH_STYLE` | `on` | For target `s3`, `on`: `https://endpoint/bucket/key`. `off`: `https://bucket.endpoint/key` (needs a DNS name, not an IP address) |
| `TABULA_BACKUP_INTERVAL_MINUTES` | `60` | Time between runs, 5 to 10080 |
| `TABULA_BACKUP_SETTLE_SECONDS` | `120` | Quiet time after the last change before a backup is taken, 1 to 3600. `0`: no settle backups (see [When it runs](#when-it-runs)) |
| `TABULA_BACKUP_SHUTDOWN_SECONDS` | `4` | How long a graceful shutdown may spend on a final backup, 1 to 25. `0`: no final backup. Keep it under the time the platform waits before it kills the process (5 seconds on Fly) |
| `TABULA_BACKUP_SNAPSHOT_MAX_HOLD_SECONDS` | `5` | Maximum time to hold writers while local snapshot copies are made, 1 to 60 |
| `TABULA_BACKUP_VERIFY_HOURS` | `24` | How often a slice of the newest backup is read back and decrypted (the [deep verify](#checking-the-backups)), 1 to 720. `0`: no deep verify. The cheap check of every run is not switched off by this |
| `TABULA_BACKUP_VERIFY_MAX_MB` | `64` | The most sealed (encrypted) megabytes one deep verify reads, 1 to 4096. An object larger than this is never read by it |
| `TABULA_BACKUP_KEEP_HOURLY_HOURS` | `48` | Keep the newest backup of every hour for this long. `0`: no hourly points |
| `TABULA_BACKUP_KEEP_DAILY_DAYS` | `30` | Keep the newest backup of every day (UTC) for this long. `0`: no daily points |

The old `MIRA_BACKUP_*` spelling works with the usual deprecation warning. Two examples of retention: an hourly backup with 48 hours of hourly points and 30 days of daily points is the default; a once-a-day backup that keeps a week is `TABULA_BACKUP_INTERVAL_MINUTES=1440 TABULA_BACKUP_KEEP_HOURLY_HOURS=0 TABULA_BACKUP_KEEP_DAILY_DAYS=7`. The newest backup is always kept, whatever these say.

For target `s3`, give the credentials the least they need on that bucket (or prefix): put, get, head, delete and list. The key and the secret key are never written to the log, the status, the audit log or an error message.

## Writing to a directory (target dir)

Use `TABULA_BACKUP_TARGET=dir` when another process will pull the backup from the instance volume. It needs only `TABULA_BACKUP_KEY`; S3 settings are ignored. Set `TABULA_BACKUP_DIR` to an absolute path when the export should live somewhere else. By default the files go to `<DATA_DIR>/backup-export`.

The directory holds the same encrypted, sealed objects and manifests that the S3 target writes. The machine holding this copy does not need the key, and nothing leaves the volume by itself: a separate puller must fetch or copy the files. The export directory lives on the instance volume and is excluded from every backup walk, so a backup never includes its own output. A whole-workspace restore also leaves the export directory in place.

## Pulling the export

The read-only pull route is off unless backups use target `dir` and `TABULA_BACKUP_PULL_TOKEN_SHA256` is set. The control plane keeps the bearer token and gives the instance only its SHA-256 digest. Send it as `Authorization: Bearer <token>`:

```
GET  /api/backup-export/list?prefix=<configured-prefix>/objects/&after=<key>&limit=<n>
  -> { keys: [{ key, size, lastModified }], next: <key|null> }
GET  /api/backup-export/object?key=<key>
HEAD /api/backup-export/object?key=<key>
```

`prefix` is required and can name only the configured prefix's `objects` or `manifests` directory. Pages are sorted by key, default to 1000 entries and are capped at 1000; pass `next` as the exclusive `after` value for the next page. `HEAD` returns the object's size without its bytes. The route allows 120 requests and 400 MB of object bytes per sliding minute per workspace; an over-limit response has `429` and `Retry-After`.

The route returns only the sealed AES-256-GCM objects and manifests, whose names are keyed hashes or manifest names. The puller cannot decrypt them without the backup key. The route is public to the instance (bearer only, no browser session) so a request can wake a stopped hosted machine; keep the token in the control plane and rotate it by changing the digest and token together.

## When it runs

A backup starts for one of four reasons, which the status calls the **trigger** (`lastTrigger`): `interval`, `settle`, `shutdown`, or `manual` (a restore takes a safety backup first).

**The interval run** is the heartbeat. The first run starts a random one to five minutes after the server starts (so a restart loop does not hit the bucket every few seconds), then another one interval after each run ends. It runs whether or not anything changed, so it also finds what no signal told the server about, for example after a crash. A run never overlaps another: a tick that arrives during a run is skipped.

**The settle run** closes the gap between two interval runs. A hosted workspace machine stops when it is idle, and a visit shorter than the next interval (edit, close the tab, the machine stops) would otherwise be lost to the schedule and not backed up at all until someone woke the machine again, which for a workspace nobody opens is no limit at all. So every change starts a timer: a room that is saved (boards and comments), an API call that wrote and succeeded (boards, members, sessions, settings, images, version history, everything in the directory) and, in open mode where there is no accounts API, an image or version-history write. Reads and refused calls change nothing, and a websocket message is not a change by itself: a room is saved a second after its last edit, and that save is the signal. When nothing has changed for `TABULA_BACKUP_SETTLE_SECONDS` (default 2 minutes) a backup runs. Every new change starts the wait again, but a workspace that never goes quiet is still backed up 10 minutes after its first change that is not in a backup yet (or one settle time, if that is longer). A change made while a run is going is not lost: when the run ends and something was noted after it started, the timer starts again, and a backup only clears the "changed" mark when nothing was noted since it started. A run that fails leaves the mark and tries again after one settle time, then twice as long each time up to half an hour, so a bucket that is down is retried and not hammered. `TABULA_BACKUP_SETTLE_SECONDS=0` turns settle runs off; the interval schedule is the same either way.

**The shutdown run** is a last bounded backup when the server is asked to stop (SIGINT, SIGTERM, SIGHUP, SIGBREAK or an IPC `shutdown` message; this is what Fly sends when it stops an idle machine). The order is: save every open room, then the backup, then close the databases and exit. If a run is going the server waits for it, and if anything changed since the last backup it takes one more; nothing is requested from the bucket when nothing changed. All of it must fit in `TABULA_BACKUP_SHUTDOWN_SECONDS` (default **4**). When that time is up the run is stopped. Because the manifest is written last, a stopped run leaves no half-written backup visible, only objects the next run reuses or the cleanup removes. The server then waits up to 2 more seconds for the stopped run to let go of the database, so the longest a shutdown takes because of backups is the budget plus those 2 seconds, and in practice the stop takes milliseconds. **The default is 4 because Fly stops a machine with SIGINT and kills it after 5 seconds by default**, and the control plane's provisioning sets no `stop_config`, so there is nothing longer to use yet. A longer wait (and with it a larger `TABULA_BACKUP_SHUTDOWN_SECONDS`) is a separate change in tabula-cloud: `kill_timeout` in the machine's `stop_config`. `TABULA_BACKUP_SHUTDOWN_SECONDS=0` turns it off. A restore that holds the server in maintenance mode stops the backups itself, and the shutdown run is skipped.

**What is still not guaranteed.** A crash, an out-of-memory kill or any kill without a signal between a change and its settle run (default 2 minutes) loses that change from the backups; the data on the volume is still there, and the next interval run after the restart takes it. A change made while the stop is already running is saved to disk but may miss the final backup. A bucket that does not answer within the budget leaves the last good backup as the newest.

**What it costs.** A run that finds nothing different writes no manifest, but it still asks the bucket for the manifest list and the newest manifest, checks the objects it knows and prunes: about ten requests. Settle runs only follow real changes, so a busy workspace costs at most one such run every 10 minutes and a quiet one none; with the defaults the extra cost is a few dozen requests a day for a workspace that is used a few times a day. The shutdown run adds one when something changed. The check of the bucket listing ([Checking the backups](#checking-the-backups)) costs no request of its own, because the cleanup already lists the objects and reads the kept manifests; the deep verify adds one request for each object it reads, at most once every `TABULA_BACKUP_VERIFY_HOURS` and within `TABULA_BACKUP_VERIFY_MAX_MB` (about 64 MB a day by default). Settle and shutdown runs are audited like the others, and only when they did something (below); a timer that fires is not audited.

A failed run is tried again by the next settle attempt or interval, whichever comes first; nothing a backup does can stop the relay or slow a board.

### Snapshot barrier

Before copying files, the relay saves every open room and briefly pauses board, directory and chat request writes. Reads continue, and websocket clients stay connected: writable Yjs updates wait in the relay and are applied after the local copies are complete. SQLite copies, room files, history and assets are staged locally during this same point; uploads happen after writers are released.

The default hold limit is 5 seconds, configured with `TABULA_BACKUP_SNAPSHOT_MAX_HOLD_SECONDS` (1 to 60 seconds). It covers waiting for active writes and making all local copies, not bucket uploads. If a snapshot would exceed the limit, it is abandoned, writers are released, and the failed run follows the usual retry backoff.

The log records `snapshot barrier started` and `snapshot barrier released after <milliseconds> ms` on success. If the limit is reached it records `snapshot barrier exceeded <hold limit in milliseconds> ms; writers were released and the snapshot will retry`. Each manifest records the completed barrier's start and end times and its increasing `snapshotSeq`; restore checks those fields and accepts older manifests without them with a legacy-manifest log line.

**The database copy runs in a worker thread.** Copying a database is two slow SQLite calls (`VACUUM INTO` a temporary file, then a second pass on the copy that removes the engine's own rows, which keeps an unchanged database unchanged, and vacuums it again), and SQLite calls hold the thread that makes them. In the main thread that stopped the event loop, so every websocket message waited. `server/backup-copy-worker.mjs` now does both steps in a `node:worker_threads` worker, one worker for each database, started for the copy and gone when it is done; it gets the two paths and the name of the status setting and nothing from the environment (no key, no credentials). The main thread waits for its answer, then reads the file and fixes the header as before, so the stored bytes are the same as the in-thread copy gave (a test compares them). A failure comes back as a short code, and for SQLite its own fixed wording (`file is not a database`), never a path, so the status says what it said before. When the engine is stopped during the copy the worker is terminated, the temporary files are removed (once more when the thread is gone) and the run ends as stopped. If a worker cannot be created at all, the copy is done in the main thread, with one log line for each copy.

Measured on a development laptop (Apple M1 Pro, Node 24) with a database made of audit rows, median of 5 copies (`copyDatabase` in the main thread against the worker, longest gap of a 1 ms timer on the main thread):

| Database | Copy in the main thread: wall time, loop held | Copy in a worker: wall time, loop held |
| --- | --- | --- |
| 3 MB | 26 ms, 26 ms | 42 ms, 2 ms |
| 15 MB | 102 ms, 102 ms | 120 ms, 2 ms |
| 75 MB | 530 ms, 530 ms | 545 ms, 2 ms |

The copy takes about as long as before (the worker adds a start of some 15 ms), but the main thread is free while it runs. A whole run over a 75 MB directory database still holds the loop for up to about 100 ms in one piece (was about 520 ms): hashing, sealing and signing the 80 MB file happen in the main thread, as they do for every file of a backup. A small shared-CPU virtual machine will be several times slower than the laptop, so expect the copy in seconds for tens of MB, now without the server waiting for it. Not measured on a real Fly machine.

One run:

1. Copies the database and reads the rooms and history as above, one file at a time. Each file is read once, hashed, and (if needed) uploaded from that same buffer.
2. Compares with the newest manifest. A file whose content is already in the bucket is not uploaded again; after a restart the engine first asks (HEAD) whether each such object is still there, once. An object that an earlier cleanup or deep verify found missing or damaged ([Checking the backups](#checking-the-backups)) is uploaded again without asking.
3. Uploads the new objects, then checks that each of them is in the bucket with the right size.
4. If nothing changed since the newest manifest, writes no new manifest and records the success. Otherwise writes the manifest **last**, reads it back, decrypts it and compares it with what it wrote. A manifest that does not read back is deleted and the run fails.
5. Prunes: the manifests the retention settings no longer keep, then objects no kept manifest refers to **and** that are more than an hour old. If any kept manifest cannot be read (damaged, or sealed with a key that is not configured), no object is deleted that time and the status says so. The same listing is also compared with the kept manifests (every object they name must be there, with the size it should have).
6. When it is due, the deep verify reads and decrypts a slice of the newest backup. It starts after the run has ended, outside it: it cannot fail the run, and it never holds up another one. The next run (a timer, a settle, the safety backup before a restore, a button), a shutdown's final backup and `stop()` cancel it at once, also in the middle of reading an object, and it carries on from the object it stopped at after the next run (the run that interrupted it does not start it again, so a restore's safety backup leaves the bucket to the restore).

A crash or a failure before step 4 leaves unreferenced objects in the bucket but no manifest, so the half-finished backup is invisible, and the next run's cleanup removes the objects once they are an hour old.

## Checking the backups

A backup that is not there when it is needed is not a backup, and the bucket can lose or damage an object between two runs (someone deletes by hand, a lifecycle rule, a provider fault, a bit that flips). Three things notice that, and one repairs it.

**On every run, for free: the listing.** The cleanup lists `objects/` and reads every kept manifest, to know which objects are still needed. The same two lists say whether every object a kept manifest names is in the bucket (`missingObjects`) and whether it has the size the manifest gives plus the 33 bytes of sealing (`wrongSizeObjects`). `verifyChecked` is how many objects that was and `verifiedAt` when. This is done even when the cleanup is skipped because one kept manifest cannot be read (it then covers what the readable manifests name), and not when the bucket cannot be listed, the listing does not show the newest manifest, or the list of protected backups cannot be read (the numbers then stay as they were). It is a finding, not a failure: the run succeeds, nothing is deleted because of it (a missing object is not in the listing and a wrong-size one is referenced), and the status says what is wrong in counts. It cannot see an object that has the right size and the wrong bytes.

**Once every `TABULA_BACKUP_VERIFY_HOURS` (default 24): the deep verify.** After the first run past that time, when the run itself has succeeded and has ended, the engine also reads a slice of the **newest** backup's objects and decrypts them with the same reader a restore uses: the GCM tag (which includes the object's name, so an object stored under another name fails) and the keyed hash of the contents. It stops at `TABULA_BACKUP_VERIFY_MAX_MB` (default 64) of sealed bytes: the size of an object is known from the manifest, so an object that does not fit in what is left is the first one the next verify reads, a stored object larger than the manifest says is refused before its body is read (`too_large`), and an object larger than the whole budget is skipped and counted. The order is the sorted object ids, continuing after the last object the previous verify read (the position is kept in the stored status, as a number, so a restart carries on), so over several days every object is covered; `deepCovered` is the share of the newest backup's objects read in the current round (0 to 1; it reaches 1 when the round is complete and starts again from 0 at the next verify). Records: `deepVerifiedAt`, `deepChecked` (objects read this time), `deepDamaged`, `deepSkipped` and `deepCovered`.

- **Damage** is an object that is gone (`not_found`), fails its integrity check (`tamper`: a flipped bit, a truncation, an object under another object's name), does not hold what its name says (`content_mismatch`), is not in the sealed format or was sealed with a key id this instance does not hold (`bad_format`, `unknown_key`), or is larger than the manifest says. It makes the object suspect (below).
- **A provider that fails** (network, timeout, 429, 5xx, a 403 on a read) is not damage. The verify stops there, counts it in `deepSkipped`, and the object is the first one the next verify reads. A verify that could not read anything does not count as having run, so it is tried again at the next run.
- It never makes a run fail, never reads more than its budget, stops at once when the engine is stopped, and **does not run during the final backup of a shutdown** or in the first run of a new installation (the clock starts with the first run). A restarted server goes by the stored time, so a restart neither skips a due verify nor brings one forward. The safety backup of a restore is an ordinary run, so when a verify is due it waits for it (seconds at most).
- `TABULA_BACKUP_VERIFY_HOURS=0` turns it off.

**The repair.** An object the listing found missing or the wrong size, or the deep verify found damaged, is **suspect** (in memory only). The next run does not trust anything it knows about a suspect object: when a file still has that content, the object is uploaded again (the PUT replaces what is there), the usual check that the upload is in the bucket with the right size follows, and the object is no longer suspect. The run is audited as `backup.run` with `uploaded` and `repaired` counted, also when nothing else changed; there are no audit rows for the checks themselves. The numbers go back to 0 at the cleanup of that same run.

**What cannot be repaired.** An object that only an older, still kept manifest names, and that no file has any more, cannot be put back; a restore of that older backup would fail on it. It stays suspect, is counted in `unrepairableObjects`, and is never deleted while that manifest is kept. When the manifest ages out (see the retention settings) nothing names the object, it is no longer reported, and the cleanup removes what is left of it. The same holds for an object found damaged in the newest backup whose file changed before the repair run: the new backup does not need it, the older one still names it, so it is counted in `unrepairableObjects` from that run on, until the older backup ages out.

**Not guaranteed.**
- A restart forgets which objects are suspect (object ids are never written to the status), so a damaged object that was found and not repaired yet is found again by the deep verify, not by a HEAD. Until a whole round has been read again `deepDamaged` keeps the count of before the restart, and the round starts again from the first object.
- The listing is compared with what the provider says now. A provider whose listing lags behind (an eventually consistent one) can report an object as missing for a moment; the cost is one needless upload.
- Only the newest backup's objects are read, and only `TABULA_BACKUP_VERIFY_MAX_MB` of them a day: an older backup is checked only as far as the listing goes (an object that is there and the right size), and a 100 GB bucket takes weeks to read. Raise the budget if that matters, or run the restore drill.
- The position in the rotation is a number: when files are added or removed between two verifies an object can be read a little later or earlier than the round would have it, but no object is left out for good.
- Not tested against a real provider.

## How it is encrypted

One page, because you should be able to check it.

- **Keys.** From the master key `K` (32 bytes) three values are derived with HKDF-SHA256 (empty salt): `encKey` (info `tabula-backup/enc/v1`), `nameKey` (`tabula-backup/name/v1`) and the **key id** (the first 4 bytes of the derivation with info `tabula-backup/keyid/v1`, shown as 8 hex characters). The key id says which key sealed a file and tells nothing about the key.
- **Object names.** A file is stored as `<prefix>/objects/<objectId>`, where `objectId = hex(HMAC-SHA256(nameKey, file contents))`. The same contents get the same name (so unchanged files are stored once, across runs and across paths), but the provider cannot compute the name of a file it guesses without `nameKey`, so it cannot confirm what a file contains.
- **Sealing.** Every object and every manifest is `version (1 byte, =1) | key id (4) | nonce (12, random) | AES-256-GCM ciphertext | tag (16)`. The additional authenticated data is the first five bytes followed by `obj:<objectId>` for an object or `manifest:<file name>` for a manifest. So a flipped bit, a truncated file, an object stored under another object's name, a manifest copied over another manifest and a changed key id all fail the integrity check. A reader also checks that the contents hash (with `nameKey`) to the object id.
- **Manifests.** `<prefix>/manifests/<UTC timestamp>.json.enc`, for example `20261008T193000Z.json.enc`, sealed as above. Inside: `{version: 1, keyId, createdAt, appVersion, files: [{path, size, objectId}], totals: {files, bytes}}`. Paths are relative to `DATA_DIR` and are only ever plain relative paths: no `..`, no leading `/`, no backslash, no drive letter, no empty or `.` segment. They are validated when written and again when read.
- **What the provider sees:** the number and sizes of objects (plus 33 bytes each), the times of writes, and the fact that you back up on a schedule. Not paths, board names, counts of boards or any content.
- **Key change.** Set the new key as `TABULA_BACKUP_KEY` and put the old one in `TABULA_BACKUP_KEY_PREVIOUS`. The reader picks the key from the key id in each file; a key id it has no key for is a clear error (`unknown_key`). A new key has a new `nameKey`, so every object gets a new name: **the first run after a key change uploads everything again**. The old objects are removed by the normal cleanup once the manifests that refer to them age out of the retention window. Keep the old key in `TABULA_BACKUP_KEY_PREVIOUS` until then; while a kept manifest cannot be read, object cleanup is skipped (and the old manifests still age out and are deleted).

## Reading a backup

You do not need Tabula to read one. Download a manifest and the objects it names with any S3 tool, then decrypt with Node and your key:

```js
// usage: TABULA_BACKUP_KEY=<key> node decrypt.mjs <downloaded file> <obj:OBJECTID | manifest:FILENAME> > plaintext
import crypto from 'node:crypto';
import fs from 'node:fs';

const [file, name] = process.argv.slice(2);
const raw = process.env.TABULA_BACKUP_KEY.trim();
const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const derive = (info) => Buffer.from(crypto.hkdfSync('sha256', key, Buffer.alloc(0), info, 32));

const sealed = fs.readFileSync(file);
const header = sealed.subarray(0, 5); // version 1, then the key id
const decipher = crypto.createDecipheriv('aes-256-gcm', derive('tabula-backup/enc/v1'), sealed.subarray(5, 17));
decipher.setAAD(Buffer.concat([header, Buffer.from(name)]));
decipher.setAuthTag(sealed.subarray(sealed.length - 16));
process.stdout.write(Buffer.concat([decipher.update(sealed.subarray(17, sealed.length - 16)), decipher.final()]));
```

Decrypt the newest manifest (`manifest:20261008T193000Z.json.enc`), read its `files`, decrypt each object (`obj:<objectId>`) and write it to its `path` under an empty data directory. `directory.sqlite` is a complete SQLite database. That is a manual restore without any of the checks of [Restoring](#restoring); use that when you can.

In code, the engine exposes the read side that restore uses (`createBackup(...)` in `server/backup.mjs`): `listManifests()` (newest first), `readManifest(name)` (verified, decrypted, paths validated) and `readObject(objectId)` (verified twice: the GCM tag and the keyed hash of the contents). They throw a `BackupError` with a stable `code`: `bad_format`, `unknown_key`, `tamper` (a flipped bit, a truncated file, or an object or manifest under another name look the same to GCM), `content_mismatch`, `invalid_manifest`, `invalid_path`, `not_found`, `s3`, `network`, `timeout`, `too_large`, `readback`.

## Restoring

Restore needs **accounts mode and a working backup configuration, including the key** that sealed the backup you want back (the current `TABULA_BACKUP_KEY`, or the old one in `TABULA_BACKUP_KEY_PREVIOUS`). Without the key a backup cannot be read, listed or restored by anyone. Both kinds of restore are for the workspace **owner** (not admins), are written to the audit log, and are refused with `{error: 'backups_off'}` while backups are not configured. The routes and the functions below are what the screen ([In the app](#in-the-app)) and an operator use.

### Two kinds of restore

| | One board, as a copy | The whole workspace |
| --- | --- | --- |
| What it does | Puts one board of a backup into the live workspace as a **new board** | Replaces everything in `DATA_DIR` with the backup |
| Downtime | none | the server restarts (a minute or less) |
| What it touches | adds one board; the live board, its history and everything else are never changed | everything: people, teams, boards, rooms, history, settings |
| Sessions | untouched | **everybody is signed out** and signs in again |
| Version history | not restored (the copy starts without any) | restored with the rest |
| Undo | delete the copy | the previous data is kept aside (see [The old data](#the-old-data)) |

**A board copy** reads the backup's database and the board's two room files (`<id>.yjs`, `<id>~comments.yjs`), checks them, and creates a board with a fresh id, owned by the person who restored it, titled `Restored: <title> <YYYY-MM-DD>` (cut to 200 characters; the date stays). The copy goes to the board's original team only if that team still exists **and** the person is a member of it (the rule board creation has); otherwise it goes to their personal space and the answer says so (`fallback: 'personal'` and the message "The original team no longer exists or you cannot see it, so the copy is in your personal space."). It never refuses because of the team. The room files are written first (a temporary file, then a rename) and the board becomes visible last; if anything fails, what was written is removed. A board that is not in the backup, or has no saved content in it, is `board_not_in_backup`. Board creation's own limits apply: guests cannot create boards, and a hosted workspace that is read-only refuses the copy (402). A board's pictures come with it: for each image the backed-up database lists for the board, the file is taken from the backup (checked against its hash) unless the live store already has it, and the copy gets its own row for it, so the copy shows what the original showed. A picture the backup does not hold is left out and shows as missing; it never stops the copy. The document inside the copy carries the new name, so the board's first save does not turn it back into the old title.

**A whole restore** goes through these steps, and nothing live changes until step 4 is done:

1. **Confirmation and guards.** The owner types the word `RESTORE`. One restore (of either kind) runs at a time per process (a second answers 409 `restore_in_progress`), and at most one whole restore is started in 10 minutes, counting the restart a restore causes (429 `rate_limited` with `Retry-After`). Board copies are limited to ten in ten minutes.
2. **Safety backup.** A backup run of the live data, now. It must succeed: if it fails or is stopped, the restore is refused with `safety_backup_failed` and nothing changes (a backup that is already running is waited for, then a new one is taken). The manifest it produced, and the manifest being restored, are **protected from pruning for 7 days** (setting `backup.protected`; the retention rules cannot delete them, and an expired protection is dropped at the next prune). There is no override.
3. **Download and checks, into `DATA_DIR/.restore-<id>/`** (the same volume, so the final moves are renames). Space is checked first: the volume must have at least twice the size of the backup plus 64 MB free, else `not_enough_space` with `needed` and `free`. Every file is verified three ways (the AES-GCM tag with the object id, the keyed hash equal to the object id, and the size equal to the manifest's), every path must be one the backup engine writes (`directory.sqlite`, a top-level room `*.yjs`, `assets/<aa>/<sha256>` with the shard matching the hash, `history/<board>/index.json` and `*.yjs.gz`) and nothing else, duplicate paths (also under another letter case) are refused, and a file is never written outside the staging directory. Then the staged database is opened on a copy: `PRAGMA integrity_check` must be `ok`, a schema newer than this Tabula is refused (`schema_too_new`; an older one is fine and is migrated before the swap), the app's own code must be able to open it, it must not be owned only by disabled owners, and every room is applied to a throwaway document, every history index read as JSON every history version unzipped and read, and every image file hashed (its SHA-256 must be its name). Anything wrong deletes the staging directory and refuses; the live data was not touched.
4. **The staged database is made ready**, inside the staging directory: every account and guest session and every login token is deleted, **every join code is revoked, every access token (MCP) and every invite link in it is revoked** (a restore must not bring back a credential that was revoked after the backup), the backup status and backup audit rows are removed, the hosted workspace's limits (`cloud.*` settings: read-only, seats, banner) are the **live** ones, not the backup's, and the restore is recorded (`restore.status`, `restore.keep`, the protection of step 2 and an audit row `restore.done` with the manifest name and counts).
5. **Maintenance mode.** The API answers `503 {error: 'restoring'}` to everything except `GET /api/internal/backup-status` and `/api/health`; every open socket is closed with code **`4503`** and new ones are closed with it; every open room is saved to its file, once, and then nothing may save again; the live AI runs (docs/ai.md) are dropped without a broadcast, and a provider call still out finds its run gone and changes nothing, since the AI routes answer 503 and the sockets that carried the runs are closed; the backup schedule stops and the database is closed.
6. **The swap.** A journal `DATA_DIR/restore.json` is written (atomically, flushed) before the first rename. Then every live file (`directory.sqlite` with its `-wal` and `-shm`, every room file, `history/` and `assets/`) is **moved** into `DATA_DIR/.pre-restore-<ms>/`, the staged files are moved into place, and the directory is flushed. Files that are not Tabula's data (`outbox.jsonl`, notes) stay where they are.
7. **Leave.** The HTTP answer `202 {ok: true, restarting: true, keepOldFor}` is sent and flushed first, then the process exits with code **75**. Provisioning sets Fly's restart policy to `on-failure`, so a non-zero code starts the machine again; exit code 0 would leave it stopped. Under systemd or Docker, `Restart=on-failure` or `restart: on-failure` (or `always`) does the same; a server started by hand has to be started again by hand. On the next start the journal is deleted and the restored data is what the server serves. If the owner's connection is gone, the process leaves after at most five seconds.

Edits made while the backup was downloading are not in the safety backup (it was taken first) but they are not lost: the rooms are saved at step 5 and end up in the old data directory with everything else that was live at the swap.

### If the server stops in the middle

`restore.json` says how far the swap got, and **`recoverOnStart()` runs before the database is opened** (also in open mode). Every step checks before it renames, so it can itself be interrupted and run again. Phases of the journal: `swapping`, `moved-old`, `moved-new`, `done`, and for an undo `rolling-back` and `rolled-back`.

- `swapping`: no new file has moved, so the old files go back. Undone.
- `moved-old`: all old files are out of the way. If every new file is already in place the swap is **finished**; otherwise the new files go back out and the old files go back in. Undone.
- `moved-new`: finished; the staging directory is removed.
- `done`: the journal is deleted. This is also the normal start after a restore.
- `rolled-back`: stays until the server is up and has written the failure to the database and the audit log (`restore.failed`, error `interrupted` or `swap_failed`); then it is deleted.

The data directory is therefore **either wholly the old data or wholly the new data**, never a mixture (the tests stop the process at every boundary of the swap, and again at every boundary of the recovery). A journal that cannot be read, or a file in the way of an undo, makes the server refuse to start with a message instead of guessing; nothing is deleted, and the message says to look at this page. Staging directories of a crashed download are removed at start by name (`.restore-` and 16 hex digits). If the swap itself fails with an I/O error (a full or failing disk), it is undone at once, the answer is `500 restore_failed` with `restarting: true`, and the process still exits with 75 so it starts clean.

### The old data

Everything that was live is in `DATA_DIR/.pre-restore-<ms>/` (the time of the swap), whole, including `directory.sqlite`: stop the server and move the files back to undo a restore by hand. It is kept **7 days**. If keeping it would put the volume above about **80% used** (checked after the download, so the new data is counted), it is kept only until the **next successful backup after the restore, and at least 24 hours**; the confirmation step says which applies (`keepOldFor`: `7 days` or `until the next successful backup (at least 24 h)`, with a `reason`). Whichever applies, it is **never removed before a backup has succeeded after the restore**. A sweep runs a minute after start and then hourly; it removes only directories named `.pre-restore-` and digits, exactly, that are real directories (a link or a file with such a name is left alone), whose age (the time in the name) can be told, and it never follows a link. `keepOldData: false` is not supported in this version.

### Routes

All need a signed-in **owner** (401 signed out, 403 for anyone else, admins included) and, for the POSTs, the `x-tabula: 1` header. Both POSTs also work while a hosted workspace is read-only (an owner locked out for billing may need them), except that a board copy is refused there (402). Unknown fields are refused with 400.

```
GET  /api/admin/backups
  -> { backups: [{name, createdAt, files, bytes, keyId, protected, protectedUntil, readable, error?}],
       truncated, status: {target, lastSuccessAt, lastFailureAt, lastFailureError, consecutiveFailures, nextRunAt,
       running, intervalMinutes, keyId, bytesStored, objects, manifests, dirty, lastTrigger,
       verifiedAt, missingObjects, wrongSizeObjects, unrepairableObjects, deepVerifiedAt, deepDamaged, deepCovered},
       restore: {inProgress, maintenance, last, protectedBackups, oldData} }
GET  /api/admin/backups/:name
  -> { name, createdAt, appVersion, keyId, files, bytes, boards, protected, confirmWord: 'RESTORE',
       keepOldFor, reason, space: {needed, free, enough} }
GET  /api/admin/backups/:name/boards
  -> { boards: [{id, title, teamId, teamName | null, deleted}], truncated }
POST /api/admin/backups/restore-board   { manifest, boardId }
  -> 200 { ok, boardId, title, teamId, fallback?, message? }
POST /api/admin/backups/restore         { manifest, confirm: 'RESTORE' }
  -> 202 { ok: true, restarting: true, keepOldFor }
```

The list is newest first, at most 200 backups, each read (and so verified) once; a backup that cannot be read is listed with `readable: false` and the reason (`unknown_key`, `tamper`, ...). `status` is the backup engine's own status for the owner: exactly the sanitised fields named above (times in ms since the epoch or `null`, `lastFailureError` the short error the engine keeps, the checks of [Checking the backups](#checking-the-backups) as counts and one share), nothing else; the rest of the status stays with the control plane (see [Status](#status)).

**The boards of one backup** (`GET /api/admin/backups/:name/boards`) are what the board picker lists. Only that backup's `directory.sqlite` is downloaded and checked like any other restore object (the authentication tag with the object id, the keyed hash, the size, an allowed path, free space for it), written to a temporary directory `DATA_DIR/.restore-<id>/`, opened **read only**, queried and **always deleted again**, also when anything fails. The answer holds the boards that have saved content in that backup (`<id>.yjs` is in the manifest, so each one can be restored), most recently edited first, at most 500 (`truncated` says there were more), with titles and team names cleaned like the title of a board copy (control characters become spaces, at most 200 and 80 characters) and `deleted` for a board that was deleted when the backup was made. It is not a restore: nothing is recorded as one. The audit row is `backup.boards` with the manifest name and a count, never a title, an id or any content. At most 20 reads a minute per owner (`429 rate_limited` with `Retry-After`); `409 restore_in_progress` while a restore runs and `503 restoring` in maintenance mode; the other errors are those of any restore object. Errors are `{error, message}` plus plain facts: `needed` and `free` for `not_enough_space`, `detail` for `safety_backup_failed` (the short storage error), `restarting: true` when the server is about to restart. Codes: `bad_request`, `confirmation_mismatch` (400), `read_only` (402), `forbidden`, `manifest_not_found`, `board_not_in_backup` (404), `backups_off`, `restore_in_progress` (409), `rate_limited` (429), `unknown_key`, `tamper`, `content_mismatch`, `invalid_manifest`, `invalid_path`, `unexpected_file`, `duplicate_path`, `size_mismatch`, `backup_incomplete`, `no_directory`, `invalid_backup`, `schema_too_new`, `integrity_check_failed`, `no_active_owner` (422), `s3`, `network`, `timeout`, `safety_backup_failed` (502), `not_enough_space`, `space_unknown` (507), `restore_failed` (500). The same operations are plain functions of `createRestore(...)` in `server/restore.mjs` (`listBackups`, `previewManifest`, `restoreBoardCopy`, `restoreWorkspace`, `recoverOnStart`, `status`), so an operator tool can use them without HTTP.

`restore` in `GET /api/internal/backup-status` (and in the list above) is `{inProgress: null | 'workspace' | 'board', maintenance, last: {kind, result: 'done' | 'failed', at, manifest, error?, files?, bytes?, boards?, keepOldFor?} | null, protectedBackups: [{manifest, until}], oldData: [{name, restoredAt, keepOldFor}]}`. It holds names, times, counts and codes, never content. The audit log gets `restore.started`, `restore.done` and `restore.failed` (owner as actor, manifest name, counts and an error code only), `backup.list`, `backup.preview` and `backup.boards` (the manifest name and a count) for the reads, and `restore.old_data_removed` (no actor) when the sweep removes an old directory.

### In the app

The owner finds all of this under **Admin, Backups** (`#/admin/backups`). Only owners see the tab, and every owner sees it, also when backups are off; admins do not see it, and the address as an admin shows the Overview instead. The list is the one of [Routes](#routes); the tab draws on `GET /api/admin/backups` for the list and the status and on the other routes for the rest.

- **Not set up.** When the routes answer `backups_off` the tab says so and nothing else: on a hosted workspace with an **Add backups** button that opens the workspace's billing (the same owner flow as **Manage billing** in the Overview, never a page of ours), on a self-hosted server with a link to the part of the user guide that names the `TABULA_BACKUP_*` settings.
- **Status and list.** The status block shows the target (`S3 bucket` or `Directory`), the last backup and how it went (with the engine's short reason when it failed), failures in a row, the next run, how often, the key id (8 characters) and the stored size; one sentence in words says how the last restore ended (done, or failed and why) and when. A notice shows while a restore runs. The list is newest first with the time in UTC and relative, the files, the size, the key and a note: `Protected until <date>` (the seven days the safety backup and the restored backup are protected from pruning) or `Unreadable: <reason>`. An unreadable backup is grey and cannot be opened. Past 200 backups the tab says the older ones are not listed.
- **One backup.** **Details** opens the preview in place (not a dialog): when it was made, the app version, files, boards, size, key, whether there is room for a whole restore, and how long the old data would be kept after one, in the words of the server (`keepOldFor` and `reason`). Two actions: **Restore a board as a copy** and **Restore the whole workspace**.
- **A board as a copy.** The boards of the backup are listed with a search box (it filters in the browser by title and team); pick one and press **Make a copy**. The answer is a line with a link to the new board and, when the copy went to the personal space, the server's message. Nothing else changes, and the button can be pressed again for another copy. While a hosted workspace is read-only the button is off, with the reason; a `402` from the server does the same.
- **The whole workspace.** Its own screen lists what will happen: everybody is signed out and signs in again (and access tokens and invite links are revoked); the workspace is away for about a minute; a safety backup is made first and a failure stops everything; the current data is moved aside, not deleted, and kept for `keepOldFor` with the server's `reason`; edits made after the backup exist only in that old-data folder. **Restore this backup** stays off until the field holds `RESTORE` exactly (capital letters, no spaces) and while the preview says there is not enough room (the screen says how much is missing). The button is a plain button, not the highlighted one: it is not the safe choice.
- **Restoring…** After the server accepts the restore the whole window shows **Restoring…** and asks `GET /api/health` after 2 seconds, then after 1.5 times the last wait, never more than 15 seconds apart. When the answer is `{ok: true}` without `restoring` the page reloads, and everybody lands on the sign-in. After 3 minutes without such an answer it stops and says it is taking longer than expected, with **Check again** (starts over) and **Reload the page**. A page does not reload by itself twice within 20 seconds. If the answer to the request is lost (a dropped connection, a gateway page, or `restarting: true` on an error that came after the point of no return) the screen shows as well, because the restore may be running: a server that is up and not restoring just sends the page to a reload.
- **Anywhere in the app.** Any answer that is exactly **503 with the JSON error `restoring`** puts the same screen up, also while someone is on a board or the home screen. Other 503s (the AI routes' `ai_unavailable`, a gateway page, any other JSON error) do not.
- **Close code 4503.** When a restore takes the server over, every open socket is closed with **4503**. The board then stops reconnecting (the reason is `restoring`, no longer "access removed"), the status chip reads **Restoring…** and the same screen waits for the server and reloads. Reloading with `#/b/<id>` in the address brings the person back to that board after signing in again. The other close codes (4401, 4403, 4404, 4410) are unchanged.

Errors are shown as plain sentences, never as codes: one table in `src/ui/backups-logic.ts` maps `not_enough_space` (with the room needed and free), `safety_backup_failed`, `confirmation_mismatch`, `rate_limited` (with the wait from `Retry-After`), `restore_in_progress`, `board_not_in_backup`, `read_only`, `backups_off`, `manifest_not_found`, `unknown_key`, `tamper`, `invalid_path`, `unexpected_file`, `duplicate_path`, `no_directory`, `forbidden` and the other codes of [Routes](#routes), with one sentence for anything else.

### Not covered

- Edits made between the safety backup and the swap exist only in `.pre-restore-<ms>/`, not in the bucket.
- AI provider keys (`ai_keys`) come back as they were in the backup.
- A hosted workspace's people and seat usage change with a restore; the control plane is told (the usage report is sent after the restart).
- The app's boards that are open in a browser get close code `4503` and show **Restoring…** until the server is back (see [In the app](#in-the-app)); the page then reloads and everybody signs in again, because every session is gone. An older app that does not know `4503` keeps reconnecting and fails with "sign in again" (`4401`).
- Not tested against a real S3 provider, a real Fly restart, or a data directory of production size.

## Rehearsing a restore locally

`npm run drill:local` rehearses, on your own machine, the restore drill of the ops runbook (section 8) as far as it can
run without Fly: a relay started exactly as `npm start` starts it, backing up to the in-memory S3 of the backup tests,
with a fake control plane for the hosted parts. It runs `test/drill/*.drill.test.ts` (never part of `npm test` or CI;
`test/drill-config.test.ts` checks that) and prints a checklist of the runbook boxes, each passed, failed or not
rehearsed with the reason and its duration, followed by a filled drill record (section 9). It exits with 1 when a box
failed, and takes about half a minute.

It seeds one workspace with every kind of data (an owner, a member and a workspace admin, a team, a board with objects
and a comment, a board with a picture, a named version and a chat message) and then goes through these boxes:

- 8.2: a backup runs by itself and its bucket keys say nothing about the workspace; an edit followed by a graceful stop
  is in the bucket; a workspace admin who is not the owner is refused on every backup route; a board restored as a copy,
  with its comment and picture, and the copy of a board whose team no longer exists; a whole restore (maintenance mode,
  exit 75, the start that follows, everyone signed out, the safety backup protected); both ways the old data is kept;
  a lost data directory restored from the bucket on an empty server; another key; a damaged object; a key rotation; a
  missing object that the prune reports and the next run repairs; and a search of every log, the audit log and the status
  for the key, the S3 secret and a request signature.
- 8.1, local analogue: a copy of the data directory started with a new `TABULA_FLY_VOLUME_ID` is adopted as a restored
  copy (see Volumes and restores).

What it does not cover: Fly volume snapshots and mounts, the real bucket provider, Stripe and the control plane's own
side, real recovery times and data loss (the times in the record are local only and not representative), the daily deep
verify (it cannot be started early without a new hook), the Restoring… screen in a browser, and a swap that is cut off
in the middle, which `test/restore-swap.test.ts` and `test/restore-relay.test.ts` cover.

## Volumes and restores

The backups above restore data **into** a running server. A hosted workspace can also be brought back a level lower: an operator restores a Fly volume snapshot into a **new** volume and points the machine at it (the ops runbook's Tier 1 restore). The server then runs on a copy of an older disk, and it must notice: anything that was live on the disk when the snapshot was taken (sessions, a half-done backup run) belongs to the past, and a volume of **another** workspace, attached by mistake, must never be served.

**The marker.** `DATA_DIR/volume.json` says which workspace and which Fly volume the data was last served as:

```
{ version: 1, volumeId, workspaceId, flyVolumeId, createdAt, adoptedAt, history: [{ at, from: { workspaceId, flyVolumeId }, to: { ... }, reason }] }
```

`volumeId` is random, made once when the marker is first written, and never changes (a restored copy keeps it, so the history reads as one line). `workspaceId` is `TABULA_CLOUD_WORKSPACE_ID` in a hosted workspace, else `null`; `flyVolumeId` is `TABULA_FLY_VOLUME_ID`, else `null`. `history` keeps the last 20 adoptions (`reason` is `operator` or `restored-copy`). The file is written to a temporary file next to it, flushed and renamed, like the restore journal. It is not part of a backup and a restore leaves it in place: it describes the disk, not the data. A marker that cannot be read stops the start; do not delete it unless you are sure the volume belongs to this workspace.

**At every start**, right after the restore recovery above and before the database is opened (`server/volume.mjs`):

| The marker | The environment | What happens |
| --- | --- | --- |
| none | anything | It is written with the current ids. An existing volume is adopted silently on its first start with this release, as before. |
| this workspace, same Fly volume | | Nothing. |
| another workspace (hosted mode) | | **The server refuses to start.** The message on stderr names both workspaces and how to adopt; nothing is served, the exit code is 1. |
| another workspace (hosted mode) | `TABULA_ADOPT_VOLUME=<this workspace id>` | **Adopted** (reason `operator`). |
| `flyVolumeId` set | `TABULA_FLY_VOLUME_ID` is a different id | **Adopted** (reason `restored-copy`): a restored snapshot, or another volume of the same workspace. |
| `flyVolumeId` is `null` | `TABULA_FLY_VOLUME_ID` set | The id is **only recorded**: no adoption, nobody is signed out. This is the first deploy that sets the variable. |
| `workspaceId` is `null` (hosted mode) | | The workspace is recorded, no adoption. |
| this workspace | `TABULA_ADOPT_VOLUME=<this workspace id>` | Nothing to adopt; the log says the variable can be removed. |

`TABULA_ADOPT_VOLUME` that is not this server's `TABULA_CLOUD_WORKSPACE_ID`, or that is set outside a hosted workspace, stops the start with a message. A `TABULA_FLY_VOLUME_ID` that is not 1 to 128 letters, digits, `.`, `-` or `_` does too. Outside a hosted workspace the marker has no workspace and only `TABULA_FLY_VOLUME_ID` can lead to an adoption; a hosted volume started without `TABULA_CLOUD_*` is served and keeps its workspace on record.

**Adopting** does, in this order, and stops the start on the first step that fails (nothing half adopted is served; the next start finds the old marker and adopts again, which is safe to repeat):

1. Checks that no restore is pending. The restore recovery has already run (it finishes or undoes an interrupted restore and removes staging directories), so this only confirms that no `.restore-*` staging directory is left and that a `restore.json` still there is a `rolled-back` one (the old data is back; the journal waits for the restore engine to record the failure). `.pre-restore-*` directories are kept: they are this workspace's older data and expire as described in [The old data](#the-old-data).
2. Clears what a backup run left mid-way: the temporary database copies (`directory.sqlite.backup-*.tmp`) and the `running` and `nextRunAt` of the stored backup status. The rest of the status (the last manifest, counts) and the backups protected from pruning stay: they describe the bucket, which the copy still shares, and the next run compares against the bucket anyway.
3. Accounts mode: **every account and guest session is ended, every join code is revoked and every sign-in link deleted**, always. Everybody signs in again. When the volume came from **another workspace** (`TABULA_ADOPT_VOLUME`, reason `operator`), **every access token (MCP) and invite link is revoked too**: they belong to the other workspace. A restored copy of the same workspace (reason `restored-copy`) keeps them.
4. Accounts mode: writes an audit row `volume.adopt` with no actor (the dashboard shows "System") and `{ from: { workspaceId, flyVolumeId }, to: { ... }, reason }`.
5. Writes the marker with the new ids, `adoptedAt` and the history entry.

One log line per adoption names the volume and both sets of ids (ids only). In a hosted workspace the control plane is sent a usage report after the start, as after a restore. The control plane reads the marker with `GET /api/internal/volume` ([cloud.md](cloud.md)).

## Status

In a hosted workspace (see [cloud.md](cloud.md)) the control plane reads the status with the bearer token:

```
GET /api/internal/backup-status
  -> { enabled: false }                                    backups are off
  -> { enabled: true, target, running, keyId, intervalMinutes, settleSeconds, dirty, lastTrigger,
       lastRunAt, lastSuccessAt, lastError,
       lastFailureAt, lastFailureError, consecutiveFailures,
       lastManifest, bytesStored, objects, manifests, nextRunAt, prune,
       verifiedAt, verifyChecked, missingObjects, wrongSizeObjects, unrepairableObjects,
       deepVerifiedAt, deepChecked, deepDamaged, deepSkipped, deepCovered,
       restore }                                               restore: see Restoring
```

Times are milliseconds since the epoch (UTC) or `null`.

- `lastRunAt` is when the latest run started, `lastSuccessAt` when the latest successful run ended. A run that finds nothing changed is a success. `lastError` is the error of the latest run (`null` after a success); `lastFailureAt` and `lastFailureError` are the latest failure ever and stay after a later success; `consecutiveFailures` counts failed runs since the last success. Errors are short and contain a status and an S3 error code at most, never a header, a URL, a key or a file's contents. A stopped run (shutdown) is not a failure.
- `lastManifest` is the newest manifest; `bytesStored` is the stored (encrypted) size of the objects it refers to, counting a shared object once; `manifests` is how many manifests are kept and `objects` how many objects the bucket holds under the prefix after the last cleanup.
- `prune` is `{at, manifestsDeleted, objectsDeleted, gcSkipped, error}` for the latest cleanup. `gcSkipped` is `unreadable_manifest`, `unreadable_protection` or `inconsistent_listing` when objects were deliberately not deleted. A cleanup that fails (`error`) does not fail the backup.
- `nextRunAt` is the scheduled time of the next interval run, `null` while a scheduled run is in progress or when stopped; `running` is true during any run. A pending settle run does not move it.
- `dirty` is true while the workspace has changed since the latest backup that could have contained the change, and `lastTrigger` is why the latest run started: `interval`, `settle`, `shutdown`, `manual`, or `null` before the first run of this process. Neither is stored: after a restart `dirty` is false and the interval heartbeat covers what was missed. `settleSeconds` is `TABULA_BACKUP_SETTLE_SECONDS`. None of them holds a secret.

- `verifiedAt` is when the latest cleanup compared the bucket listing with the kept manifests, `verifyChecked` how many distinct objects they name, `missingObjects` and `wrongSizeObjects` how many of those were not in the bucket or had the wrong size, and `unrepairableObjects` how many suspect objects no file has any more (see [Checking the backups](#checking-the-backups)). `deepVerifiedAt`, `deepChecked`, `deepDamaged`, `deepSkipped` and `deepCovered` are the same for the deep verify: when it last ran, how many objects the latest one read, how many damaged objects are known and not put right yet, how many it could not read (a provider that failed, or an object larger than its budget) and the share of the newest backup read in the current round (0 to 1). All are counts, times and one share; the status never holds an object id. The owner's list of backups shows `verifiedAt`, `missingObjects`, `wrongSizeObjects`, `unrepairableObjects`, `deepVerifiedAt`, `deepDamaged` and `deepCovered`.

A sensible alert: `lastSuccessAt` older than three intervals, or `consecutiveFailures` of two or more, or `missingObjects`, `wrongSizeObjects`, `unrepairableObjects` or `deepDamaged` above 0 for more than one run (a repair takes the next run), or `verifiedAt` older than three intervals. The status is kept in the directory's `settings` table (`backup.status`), so it survives a restart. In open mode (no directory) it lives in memory and there is no endpoint.

Each successful run that did something writes an audit row `backup.run` (no actor; only counts: `changed`, `files`, `uploaded`, `repaired`, `bytes`, `skipped`, `manifestsDeleted`, `objectsDeleted`; a run that put suspect objects back is audited even when nothing else changed) and each failed run `backup.failed` (the short error). The trigger is not in the row. A run that found nothing to do is in the status but not in the audit log, whatever started it, and a settle timer that fires is never audited. With nobody editing, the hourly heartbeat adds no rows at all.

## Limits and caveats

- **256 MB per file.** A bigger file fails the run with a clear error that names the file. Files are read whole into memory, so a run needs memory for a few times the largest file; streaming is later work.
- **Skew.** The database is copied first and the rooms a few seconds later, so a board created or renamed in between can be in one and not yet in the other. A room that has never been saved has no file and is in the next run.
- **History.** A version added after a board's index was read is in the next run. A version the index lists but whose file is gone is left out, and the stored index leaves it out too.
- **A board history index that cannot be read** (the server sets such a file aside on its own) leaves that board's history out of the run; the run still succeeds and counts it as skipped.
- **Redirects are not followed** and a request times out after 10 seconds; 5xx, 429 and network errors are retried up to three times with a growing wait, other 4xx never. Check the endpoint and region if you see a redirect error.
- **Providers.** Path style is the default because it works almost everywhere; some providers want virtual hosted style (`TABULA_BACKUP_PATH_STYLE=off`). Only the plain S3 API is used (PUT, GET, HEAD, DELETE, ListObjectsV2).
- **One instance per prefix.** Two servers backing up to the same prefix would compare against each other's manifests; the one hour grace on cleanup only protects an upload that is in progress.
- **The bucket is not locked.** Someone who can delete in the bucket can delete backups. Use credentials, versioning or object lock on the provider side if that is a concern; the engine itself deletes only what the retention rules say.
