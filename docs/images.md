# Images on the board

TAB-127. Status: decided by Johan on 2026-10-09 (see **Decided** below); the asset store and its API are built (slice 2), the client is next.

People want to put a picture on a board: a screenshot, a photo of a whiteboard, a logo, a diagram exported from somewhere else. Today the app has no image object, and pasting or dropping an image either does nothing (paste reads only `text/plain`) or fails with "This file is not a Tabula board." (drop). This page specifies the image object, how bytes are stored and served, and how images fit the features that already touch every object: sync, history, export, templates, backups, permissions and the AI tools.

The shape of the answer, in one paragraph: the board document holds a small **reference** to an image, never its bytes. Bytes live in a separate, **hash-addressed asset store** on the relay, written through a small authenticated API, scoped to the board that uploaded them. The browser downscales before it uploads, keeps the original blob locally until the upload succeeds, and shows the image from its own cache when offline. Everything else follows from not putting bytes in the Yjs document.

## Decided

Johan went with the recommendations on every open question, which changes this page in these places. Where the text below says otherwise, this list wins.

- **SVG is rasterised to PNG in the browser in v1.** The server accepts only PNG, JPEG, GIF and WebP; an `image/svg+xml` upload is `400 unsupported_type`. The stored `mime` is never `image/svg+xml`, the SVG sections below describe the later, real-SVG version, and `svgProblem` is not used by the asset store.
- **Sizes**: 10 MB per file, 100 MB per board, and **50 MB per board in open mode** (no accounts, anyone with a link can upload). `TABULA_ASSET_MAX_BYTES`, `TABULA_ASSET_BOARD_QUOTA` (default depends on the mode) and `TABULA_ASSET_TOTAL_QUOTA` take bytes or a number with `K`, `M` or `G`.
- **GIFs** pass through unchanged when within the caps and play once or on hover.
- **Deleted images stay in history** until the versions holding them expire; a purge action is v2.
- **JSON snapshot**: references only. `.drift`: embeds the files.
- **No images in templates** in v1, **alt text only**, **pasting a URL fetches nothing**.
- **Who may add**: owners and editors (open mode: everyone who can edit). Everyone who can open the board can view.
- **Toolbar**: **Image**, after **Frame**.

### Built so far (slice 2, server)

`server/image-header.mjs` (type by magic bytes, size from the header), `server/image-strip.mjs` (metadata removal), `server/assets.mjs` (the store, both forms of its index, the upload limiter, the body reader and the response headers), `server/asset-routes.mjs` (the handlers, shared by both modes, and the open-mode routes), the `assets` migration, `TABULA_ASSETS`, the routes in `server/api.mjs`, the `images` flag in `/api/me` and `/api/config`, the `asset.upload` audit action. Open mode keeps its index in `<DATA_DIR>/assets/index.json` because it has no database. Still to do: the garbage collector, the backup walk, the `.drift` and JSON handling, the Markdown line and the guide (slices 3 and 4).

### Built so far (slice 1, client)

`src/images.ts` (pure: file kinds by bytes, the encoding plan, placement, references), `src/asset-store.ts` (the IndexedDB blob cache and the upload queue), `src/image-loader.ts` (what the renderer draws and why not), `src/board-images.ts` (both, per board; the cache is cleared on sign-out), `src/ui/image-add.ts` (paste, drop, the **Image** button, downscaling to 2560 px, SVG rasterised to PNG, GIFs passed through), the `image` object type, its markup and placeholder, **100%** and **Alt text** in the quick-action bar, aspect-locked resize, images left out of templates (the server validator and the client both refuse them), and PNG and SVG export with the pictures inlined. Deviations from the plan above: the page's own blob cache serves offline viewing, so the service worker has no `assets` runtime cache; the object is created with a `pending:` key and rewritten to the hash after the upload (not the other way round); the `.drift` zip does not carry assets yet.

## Summary

- **Add an image** by pasting it (`Ctrl+V` with an image on the clipboard), dropping a file or files onto the board, or choosing **Image** on the left toolbar (file picker, several files allowed). Placed at the pointer or the view centre, stepped like clicked stickers when there are several.
- **A new object type `image`**: position, size, rotation, lock, z-order like every box, plus `asset` (the content hash), `mime`, natural size `nw` and `nh`, and an optional `alt` text. Corner resize keeps the proportions, as it does for icons.
- **Formats**: PNG, JPEG, GIF and WebP. An SVG file is rasterised to PNG in the browser (v1). Anything else is refused with a clear message.
- **Storage**: `<DATA_DIR>/assets/<aa>/<sha256>`, one file per distinct content, plus an `assets` table in the directory database for ownership, size and quota. Uploaded with `POST /api/boards/:id/assets` (raw body), read with `GET /api/boards/:id/assets/:hash`.
- **Downscaling** in the browser before upload: longest side at most 2560 px, re-encoded, EXIF dropped. The server enforces its own hard limits and strips metadata again, because it cannot trust the client.
- **Offline**: the blob stays in IndexedDB with a pending upload record; the object is created at once with a `pending:` reference and the picture shows from the local blob. Uploads run when the relay is reachable.
- **Not in v1**: images in templates, images created through MCP, animated GIF downscaling, fetching an image from a URL, cropping, captions.

## Decisions and why

1. **References in the document, bytes beside it.** A room is one whole-state Yjs file (`<id>.yjs`), saved in full, copied into every history version (gzip of the whole room, 64 MB budget per board), shipped in every full sync, held in memory by the relay, included in `.drift` files and in every off-site backup. A 2 MB picture inlined as base64 would be 2.7 MB in all of those places, every time, and the WebSocket limit (`maxPayload` 32 MB) would become a per-board image ceiling. Hash-addressed files cost the document about 200 bytes.
2. **Content-addressed, so copy, duplicate and undo are free.** The id of an asset is the SHA-256 of the stored bytes. Duplicating an image object, pasting it on another board, restoring a version or undoing a delete never moves bytes. Two people uploading the same screenshot store one file.
3. **Scoped to a board for access, shared on disk.** A bare hash is a capability anyone could replay if it leaked (in a log, in a screenshot of a URL). So reads are always `board id + hash`, and the server answers only when the caller can read that board and the `assets` table says that board owns that hash. The file on disk is shared; the permission is not.
4. **Downscale in the client, validate on the server.** The browser is the only place that can decode every format cheaply, and it removes most of the cost (bytes, memory, sync traffic) before anything is sent. The server still checks type, size, pixel count and metadata, with small pure functions and no image library, in keeping with the project's no-new-runtime-dependency stance.
5. **Never inline SVG as markup.** The icon path renders SVG bodies as DOM (after sanitising). An uploaded SVG comes from anyone, so it renders only through `<image>`/`<img>`, where scripts do not run, with the template allow-list as a second line of defence.
6. **No URL fetching.** Pasting a web address does not fetch it. A server-side fetch is an SSRF hole, and a client-side one leaks the board's viewers' IP addresses to a third party.

## Object model

A new member of `ObjType` (`src/types.ts`): `'image'`. Fields on `BaseObj`:

| Field | Type | Meaning |
|---|---|---|
| `asset` | `string` | `<64 hex>` once uploaded; `pending:<uuid>` while the bytes only exist on this device |
| `mime` | `string` | one of `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/svg+xml` |
| `nw`, `nh` | `number` | natural pixel size (for SVG, its viewBox size), used for the aspect ratio and the placeholder |
| `alt` | `string?` | optional description for screen readers and the Markdown summary (set in the properties panel) |

Everything else is the usual box: `x y w h rotation z locked parent createdBy updatedAt privateStep`. `text` is unused. An image can sit inside a frame (`parent`), be locked, and be hidden by a session's private-writing step like any other object.

Type switches that need a branch (found by reading the current code):

- `src/markup.ts` `objectMarkup`: `case 'image'` returns an `<image>` element (see Rendering).
- `src/render.ts`: draw path and a placeholder (grey box with the pixel size and a small "loading" or "offline" label) while the bytes are not available.
- `src/geometry.ts` `hitBox`: the generic box test is right; no change beyond making sure `image` is not treated as a connector target exclusion (images are connectable like shapes and icons).
- `src/app.ts` `doResize`: add `'image'` to the `keepAspect` condition next to `'icon'` and `'uml-actor'`.
- `src/ui/quickbar.ts` and `src/ui/props.ts`: images get lock, duplicate, delete, an **Alt text** field and **Replace image** (v2). No fill, line or text controls.
- `server/board-ops.mjs`: `OBJ_TYPES` gains `'image'` so filters and validation accept it (see MCP).
- `server/templates.mjs` and `src/template-file.ts`: refuse it (see Templates).

## Adding an image

Three ways in, all ending in the same function, `addImages(files: File[], at: Point)`:

1. **Paste.** The `paste` handler in `src/app.ts` reads only `text/plain` today. It first looks at `clipboardData.files` (and `items` of kind `file`) for `image/*`. If it finds images it calls `preventDefault()` and `addImages`; otherwise it falls through to the existing text paste. A clipboard holding both a file and text (copying an image from a web page also puts the page's HTML) prefers the file.
2. **Drop.** The drop handler in `src/ui/board.ts` takes `files[0]` and sends it to `readBoardFile`. It becomes: files whose type is an allowed image go to `addImages` at the drop point; `.drift` and `.json` keep the current import path; a mix of kinds imports the board file and ignores nothing silently (toast: "Dropped 2 images and 1 board file: images added, board file skipped. Drop it alone to import it.").
3. **Toolbar button.** A new **Image** button on the left rail (icon, tooltip "Image") opens a file picker (`accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"`, `multiple`). Placement is the view centre. It is disabled on a read-only board with the same reason text as the other drawing tools.

`addImages`:

- Takes at most 10 files per action ("Added 10 of 14 images").
- For each file: check the declared type, decode (see Downscaling), compute the hash, store the blob in the local asset store, create the object, and queue the upload. One undo step per action, however many images.
- The new image is selected and sized to fit: its natural size, scaled down so it is at most 60% of the view's shorter side, never above 1200 board units on a side, never below 24.
- Several images in one action are laid out left to right with a 24-unit gap, wrapping when the row would leave the view; a single image uses the stepped placement of clicked stickers (`place-click.ts`).
- Errors are per file and non-blocking: "photo.heic can't be added: only PNG, JPEG, GIF, WebP and SVG are supported." Other files in the same action still go in.

## Assets

### Storage

```
<DATA_DIR>/assets/ab/abcdef0123…   (64 hex chars, the SHA-256 of the stored bytes)
```

- Shard directory is the first two hex characters. No file extension: the MIME type is stored in the table and is the only source of `Content-Type`.
- Writes go to a temporary file in `<DATA_DIR>/assets/tmp/` and are renamed into place, so a crash never leaves a half-written asset. A file that already exists is not rewritten.
- The hash is computed over the bytes **after** server-side metadata stripping. The client sends its own hash as a hint (so the upload can be skipped when the asset exists, see `claim`); the server's value is the id it returns, and the client rewrites the object's `asset` if the two differ.

New table (migration `assets`) in `directory.sqlite`:

```
assets(board_id TEXT, hash TEXT, mime TEXT, bytes INTEGER, width INTEGER, height INTEGER,
       created_by TEXT NULL, created_at INTEGER, PRIMARY KEY (board_id, hash))
```

A hash uploaded to two boards is one file and two rows. In open mode (no accounts) `created_by` is null and the same table is used.

### API

All routes sit under `/api/boards/:id/assets`, carry the CSRF header `x-tabula: 1` like every state-changing call, and use `boardFor(user, id)` for the role check. The route table (`compile` in `server/api.mjs`) gets a `raw: true` option: the body is read as bytes with `readBytes(req, limit)` (a sibling of `readJson` with the same drain behaviour: reject early on `Content-Length`, stop buffering past the limit, never read more than the cap). Today there is no binary body support.

| Route | Who | What |
|---|---|---|
| `POST /api/boards/:id/assets` | owner, editor | Body: the image bytes. `Content-Type` is the declared type. Answers `201 {hash, mime, bytes, width, height}`, or `200` with the same body when this board already has the hash. Errors: `400 unsupported_type`, `400 bad_image`, `413 payload_too_large` (over the file cap), `413 too_many_pixels`, `402 storage_full` (quota), `402 read_only` (read-only workspace), `429 rate_limited`. |
| `POST /api/boards/:id/assets/claim` | owner, editor | Body: `{hash}`. Answers `200 {hash, mime, bytes, width, height}` and adds a row for this board when the caller can read **some** board that owns that hash; `404` otherwise. This is how a paste across boards, duplicating a board's objects into another board, and a re-upload of a known screenshot cost no bytes. |
| `GET /api/boards/:id/assets/:hash` | any role that can read the board | The bytes, with the headers in Security. `404` when the board has no such row, whatever exists on disk. |
| `HEAD` | same | Existence and size. |

There is no delete route. Assets are removed only by garbage collection (see History).

Other limits live in `server/config.mjs`, with these defaults: `TABULA_ASSET_MAX_BYTES` 10 MB per file (after the client's downscaling a photo is typically 300 KB to 2 MB), `TABULA_ASSET_BOARD_QUOTA` 100 MB per board, `TABULA_ASSET_TOTAL_QUOTA` unset (no instance cap) and `TABULA_ASSETS=off` to switch the whole feature off (the **Image** button is hidden and the routes answer `404`, as `TABULA_MCP` does). `/api/me` reports `images: true` when the feature is on, like `mcp: true`, so the UI knows.

### Quota

Counted per board as the sum of `bytes` over its rows. An upload that would pass the board quota is refused with `402 storage_full` and a message ("This board has used its image storage. Remove images you no longer need, or ask your administrator."). The same check sits next to the existing read-only check in the API write path. For hosted workspaces the control plane reads total bytes from `GET /api/internal/usage` (new field `storageBytes`) and may set `storageLimit` through `PUT /api/internal/limits`, enforced as `402 storage_full` the same way a seat limit is. That hook is specified here but is an open question (below), because it is a billing decision.

### Offline and the upload queue

The browser keeps an asset store with two parts, both in IndexedDB (database `tabula-assets`, separate from the Yjs persistence). On the first pending-blob write, it makes a best-effort request for persistent browser storage so eviction is less likely:

- `blobs`: `hash -> {blob, mime, width, height, boardId}`, an LRU-limited cache of everything this device has shown or created (cap 200 MB, entries for pending uploads are never evicted).
- `uploads`: `{id, boardId, hash, tries, nextAt}` records for blobs that still need to reach the server. A missing blob is kept with `lost: true`; a final server refusal is kept with `refused: <status>` and the blob stays cached. `notified: true` records that the uploader was told once.

Flow when the relay is reachable: add, downscale, hash, put the blob in `blobs`, create the object with `asset = <hash>`, `POST` the bytes, rewrite `asset` if the server hash differs, drop the upload record.

Flow when it is not (offline, or a local-only board with sync off): the object is created with `asset = pending:<uuid>` and the upload record keeps the `uuid` to hash mapping. Other people on the board cannot load a pending asset, so they still see the placeholder with "Image not uploaded yet". On reconnect the queue runs retryable records oldest first with backoff (at most 3 in parallel), uploads, then writes the real hash into the object in one transaction, so the change syncs like an edit. If the object was deleted meanwhile, the queue drops the record and the blob stays only in the LRU.

If this browser has lost the pending bytes, the uploader keeps the record as `lost` and sees "Not uploaded: add this image again" with one toast for the pass. A final refusal (400, 402, 403, 404 or 413) keeps both the record and blob, shows the existing refusal toast once, and uses the same placeholder label on the uploader's device. Neither state retries on the timer or while online; opening that board again clears a refusal and gives it one new attempt. A lost record stays lost until the image is added again. Viewers without this browser's upload record continue to see "Image not uploaded yet".

A local-only board (sync off, as in the desktop shell's default) keeps images in `blobs` and renders from blob URLs; they travel in `.drift` exports, and if the board is later connected the queue uploads them.

Hosted workspaces sit behind Fly's request-replaying edge, which cannot replay a body over 1 MB. The client recognizes a hosted workspace from the existing `workspace` field in `/api/me`; there, if the normal encoding is over **900 KB**, it tries the smaller encodings described below. A final blob over 1 MB is still added and shown from this device, with one warning for the add action. If an upload over 1 MB keeps failing with server errors, after three failures it stays queued and shows a size-specific notice; other retryable failures are reported after five. Opening the board makes blocked uploads retryable again.

The service worker (`public/sw.js`) gets an `assets` runtime cache for `GET /api/boards/*/assets/*`: cache first (the URL is content-addressed, so a cached copy is never stale), populated on first view. It is purged on sign-out together with `blobs`, because the bytes are private to the signed-in person. That carve-out is checked before the worker's existing early return for `/api/`, which stays for every other API path.

## Downscaling

In the browser, before hashing and uploading, for raster files:

1. Decode with `createImageBitmap(file, {imageOrientation: 'from-image'})`, which applies the EXIF rotation so the pixels are upright before the metadata is discarded.
2. If the longest side is over **2560** px, scale to 2560 (high-quality resampling, `imageSmoothingQuality = 'high'`, stepwise halving above 2x to avoid aliasing).
3. Re-encode through an `OffscreenCanvas`/`canvas.toBlob`, which writes no metadata:
   - **JPEG** stays JPEG at quality 0.85.
   - **PNG** stays PNG when it has transparency or is small; a large opaque PNG (a photo saved as PNG) is offered as JPEG only if it is at least 3x smaller, otherwise left as PNG. The rule is decided once, in a pure function (`chooseEncoding`) with tests.
   - **WebP** stays WebP at quality 0.85.
   - **GIF**: not re-encoded. An animated GIF cannot be downscaled on a canvas without losing the animation, so GIFs pass through unchanged if they are within the file cap and 2560 px, and are refused with an explanation if not (open question: first frame instead).
4. If the result is larger than the original (a small, already-optimised PNG), keep the original bytes (after the server-side strip).
5. Reject images over 36 megapixels or 16384 px a side before decoding when the dimensions can be read from the header (a pure function reads PNG, JPEG, GIF and WebP headers; the same function is used on the server).

For a hosted workspace only, if the normal result is still over **900 KB** (900,000 bytes), the browser tries additional quality and size steps to get under that target: quality steps for JPEG/WebP and opaque PNG, and smaller dimensions for alpha PNG. GIFs are never re-encoded.

SVG is rasterised to PNG in v1. Its `nw`/`nh` come from its `viewBox` (or `width`/`height`), falling back to 300 x 150 like a browser would; hosted uploads use the alpha-PNG size ladder.

The `image` object stores the size the person sees (`w`, `h`) separately from the natural size, so the 2560 px copy can be shown at 400 board units; a **100%** action in the quick-action bar resets `w`/`h` to `nw`/`nh`.

## Rendering

- On the board and in exports an image is an SVG `<image href=... preserveAspectRatio="none" width height>` inside the object's transform group, with the object's rotation. Locked objects render the same.
- `href` on screen is the asset URL (`/api/boards/<id>/assets/<hash>`), which is same-origin, so the CSP's `img-src 'self'` already allows it and the session cookie rides along. While the asset is only local, `href` is a `blob:` URL from `blobs` (the CSP has `blob:`). The URL is chosen by one function, `assetUrl(obj)`, used by the renderer.
- A failed load (404 after access was lost, offline with no cached copy) draws the placeholder with the reason. It never throws and never removes the object.
- Images render below connectors and above frames, by `z` like everything else. A frame's clip applies.
- Dark themes: images are never recoloured. The placeholder follows the theme's variables.

## Export, import and the other formats

| Format | Images |
|---|---|
| **PNG** | Each image is read from `blobs` or fetched, drawn into the SVG as a data URL (the rasteriser cannot load an external `href`; the exporter already inlines fonts the same way), then rasterised. A board with very many large images can exceed the canvas limit: the exporter reports it and suggests a smaller scale rather than failing silently. |
| **SVG** | Data URLs inline, so the file is self-contained (and large). A checkbox in the export menu is not needed in v1; the size is shown in the toast. |
| **.drift** (board with its sync data) — **built**: `assets/<sha256>` files and an `assets.json` manifest that maps each `asset` reference of the board to its file and type, stored without squeezing again; opening a file (as a new board, into the current board, or as the desktop app's backup copy) keeps only pictures that hold up (a reference that is a hash or pending key, bytes that are the image type they claim, a size inside the caps, at most 500 and 300 MB) and uploads them to the new board in the background | The zip gains an `assets/` folder with one file per referenced hash (`<hash>`, plus a `manifest.json` entry for the MIME type). Importing a `.drift` uploads the assets to the new board (or stores them locally) and the objects keep their hashes. This is the one format that round-trips a board completely. |
| **JSON snapshot** | References only: image objects appear as usual with `asset`, `mime`, `nw`, `nh`, and the file says so in a `note`. Embedding base64 would make the readable format unreadable. Importing it gives placeholders ("Image bytes not included in this file"). Open question: embed instead. |
| **Markdown summary** | An image with `alt` text is listed as `Image: <alt>`; without alt text as `Image (<mime>, <w> x <h>)`. |
| **Copy as Mermaid** | Ignored, as icons are. |
| **Copy and paste of objects** (`{driftboard:1, objects}`) | Carries references. Pasting into another board runs `claim` for each hash first; a claim that fails (no access to the source board) turns the pasted image into a placeholder object with a toast, rather than a broken reference. |

## History and garbage collection

Versions are full-state snapshots of the room, and an image object in an old version is just a reference. Two consequences:

- **Restoring a version must find its assets.** An asset row is kept while **any** reference to its hash exists in the live room or in a retained version of that board. That is the rule the collector enforces.
- **Deleting an image object does not delete bytes.** Undo, restore and history all need them.

The collector (`server/assets.mjs`, run daily and on start-up, off by default only when `TABULA_ASSETS=off`):

1. Marks every `asset` hash found in each board's live room (decoded from memory or file) and in every retained version of the board (the history index lists them; versions are gzip Yjs updates, decoded one at a time).
2. For each `assets` row of that board not marked, and older than a 7 day grace period (so a just-uploaded image whose object has not synced yet survives), deletes the row.
3. Deletes a file under `assets/` when no row references its hash any more.
4. Logs counts only. Writes an audit row `assets.gc` with `{rows, bytes}`.

**Built** as `server/assets-gc.mjs`, run by the relay two minutes after it starts and then daily (a refinement of the steps above: it reads each board's live room through the relay's own `boardState`, so an open room counts, and each retained version file under `history/<board>/`; a room or version that cannot be read leaves that board's images alone; a file with no row at all is removed only after it is also older than the grace period, which covers a crash between writing the file and its row). It writes the audit row `assets.gc` only when it removed something, and logs one line.

A soft-deleted board keeps its assets until the board is purged. The cost is that an image deleted from a board remains downloadable by hash through that board's old versions until the last version holding it expires (automatic versions are thinned to all of the last day, hourly for a week and daily for a month, within the 64 MB budget; named versions stay until deleted). This is the same reach history already has for text and is stated in the version history help; it is also an open question for Johan because it matters for privacy.

## Templates

**v1 refuses images in templates.** Template objects are copied to other boards and shared with teams or the workspace, but an asset is readable only through its own board, so a template that referenced board assets would show broken pictures to everyone else. The save dialog drops image objects with a notice ("2 images were left out: templates can't hold images yet"), the server validator in `server/templates.mjs` rejects an `image` object (`'image'` is not in its type allow-list, and a test pins that), and `.tabula-template.json` import ignores them the same way. The built-in templates are untouched.

v2 would give a template its own assets: a `template_assets` table keyed by template id, the same hash files on disk, copied into the target board's rows (through `claim`-like server logic) when the template is used.

## Backups

The backup engine copies the directory database, room files and history from `DATA_DIR`, picked by a filename filter (`ROOM_FILE_RE`); anything else under `DATA_DIR` is skipped by design, so **without a change, images would not be backed up while the objects pointing at them were**. The change:

- `snapshotFiles` also walks `assets/<aa>/<hash>`, yielding each as a file named by its relative path. Content-addressing fits the engine well: its manifest is keyed by a keyed hash of the path and "a changed file is uploaded once", and an asset file never changes, so after the first run an asset costs nothing again.
- The `assets` table is already in the database copy (`VACUUM INTO`).
- **Built.** `snapshotFiles` walks `assets/<aa>/<hash>` (only names that are a 64-digit hash under the shard of their first two digits, and only files whose bytes hash to their name), restore accepts those paths and moves `assets/` like `history/`, verifies each file's hash while staging, and a board copy carries the board's pictures (files from the backup unless the live store has them, rows for the new board).
- The 256 MB per-file ceiling is far above the 10 MB asset cap. The whole-file-in-memory read is bounded by the cap.
- Retention and pruning work on manifests and unreferenced objects as they do for rooms: an asset is removed from the bucket after the last manifest naming it expires.
- `docs/backups.md` ("What is backed up") and the status endpoint's counts are updated; the sentence saying uploads are embedded in `.yjs` files and there is no upload directory is replaced.
- The desktop shell's safety-net `.drift` copies already include assets once `.drift` does.

## Desktop

The Tauri shell uses the same page and the same CSP (`img-src 'self' data: blob:`), so blob URLs and same-origin asset URLs work. With the relay off (the shell's default), the board is local-only and images live in `blobs` and in the `.drift` backup copy the shell already writes. No asset protocol is needed. The 200 MB `blobs` cap applies; the shell's data folder backup copies include everything `.drift` includes.

## Permissions

- **Upload** (`POST …/assets`, `claim`): board owner and editor, the same people who can write the board room (`canWriteRoom`). Commenters and viewers cannot add images, because they cannot add objects. Workspace owners and admins count as owners.
- **View** (`GET`, `HEAD`): every role that can open the board, including viewer and commenter. Access is re-checked on every request. Losing access to the board ends access to its images at once; a copy already cached on a device stays there like the rest of the offline copy.
- **Read-only workspace**: uploads answer `402 read_only`; viewing still works.
- **Guests**: the board role decides, as everywhere.
- **Open mode**: no accounts, so anyone who can reach the relay and knows the board id can upload and read, exactly as they can edit the board. The quotas are the only limit.
- **Audit** (accounts mode): `asset.upload` with `{boardId, hash, bytes}` (no filename, no content), `assets.gc`. Both get readable sentences in the admin audit log and a **Boards** filter match, using the test that checks every server action has a sentence.
- **Rate limit**: 60 uploads per person per minute and 20 MB per person per minute, a small in-memory limiter next to the sign-in one (today only sign-in is limited).

## MCP and the other AI tools

**Built** in `summarise` (`server/board-ops.mjs`): `type`, position, size, `mime`, `nw`, `nh` and a cleaned `alt`; no asset hash, no URL; the Markdown summary lists a picture as `Image: <alt>` or `Image (<mime>, <w> x <h>)` (`imageLine` in `src/flow.ts`).

- `get_board`, `get_objects` and `list_*` return image objects as metadata (`type: 'image'`, position, size, `alt`, `mime`) with **no bytes and no URL**. `alt` is returned fenced and escaped like all board text.
- `create_objects` does **not** accept `image` in v1 (`CREATE_KEYS` stays: shape, sticky, text, frame, connector). `update_objects` can move, resize, lock and delete an image like any box but cannot change `asset`. `OBJ_TYPES` gains `'image'` so filters and validation keep working.
- Images are never sent to the model by the server in this slice. Reading what an image shows is a future AI feature and would go through the provider settings that already exist (TAB-97), on its own spec.
- Text hidden in an image is a prompt-injection surface the moment a vision feature exists. Nothing here reads it.

## Security

Everything an uploader controls is treated as hostile: the bytes, the declared type, the dimensions, the SVG.

1. **Type allow-list, by bytes.** The server accepts only the five types above. The declared `Content-Type` must be on the list **and** the magic bytes must match it (PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF`, GIF `GIF87a`/`GIF89a`, WebP `RIFF....WEBP`, SVG after its own check). A mismatch is `400 bad_image`. The stored MIME is the one the server decided, never the client's.
2. **Responses cannot be sniffed or framed or scripted.** Asset responses carry `Content-Type` from the table, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`, `Content-Disposition: inline; filename="image"` (never the uploaded name), `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`, and `Cache-Control: private, max-age=31536000, immutable`. `private` because the response is authenticated. The static handler's allow-list of MIME types is untouched; assets do not go through it.
3. **Metadata stripped on the server.** Pure functions walk the container and drop what carries personal data, without decoding pixels: JPEG APP1 (Exif, XMP), APP2 (ICC is kept only when small, since it affects colour), APP13 (IPTC) and comments; PNG `tEXt`, `zTXt`, `iTXt`, `eXIf`, `tIME`; WebP `EXIF` and `XMP ` chunks (with the RIFF size and the VP8X flags fixed); GIF comment and application extensions except the animation loop one. GPS coordinates in a phone photo are the case that matters. The client's canvas re-encode already removes them, but the server never relies on that. A file the walker cannot parse is refused (`bad_image`), not stored.
4. **Size and pixel limits before anything decodes.** Byte cap per file, a header-derived pixel cap (36 MP, 16384 per side) to stop decompression bombs that would exhaust a viewer's browser, per-board quota, per-person rate limit.
5. **SVG.** Reuses `svgProblem` and the `SVG_ELEMENTS` allow-list from `server/templates.mjs`: no scripts, no `foreignObject`, no external links (a raster `data:` image is the only allowed link target), no entities, comments or DOCTYPE, no `@import`/`expression` in styles, no `javascript:`. Two differences from icons: the body cap is raised from 100,000 characters to 1 MB for assets (a parameter of the function, the icon default unchanged), and the file must be a complete document with an `<svg>` root. It is then served with the headers above and **only ever loaded through `<image>` or `<img>`**, a context where the browser runs no script and loads no external resource, so a hole in the allow-list would still not execute anything. Exports inline the bytes as a `data:image/svg+xml` URL, same context.
6. **Path safety.** A hash is accepted only as `/^[0-9a-f]{64}$/`, the path is built from it and nothing else, board ids already match their own pattern, and no client-supplied filename is ever used on disk.
7. **No outbound requests.** There is no URL import, no SVG external reference, no server-side image processing library.
8. **Authorisation is by board, always.** See Permissions; a guessed or leaked hash is useless without access to a board that owns it.
9. **Privacy.** EXIF is removed; the stored filename is not kept; audit rows hold no content. A deleted image can survive in history until its versions expire (see History), which the help text says plainly.
10. **Quota as a safeguard.** A runaway client or a malicious editor cannot fill the disk past the board quota; the optional instance-wide cap covers many boards.

## Tests

Pure (vitest, no browser):

- `test/image-header.test.ts`: dimensions and type from PNG, JPEG, GIF and WebP headers; truncated, oversized and mismatched files; the pixel cap.
- `test/image-strip.test.ts`: JPEG, PNG, WebP and GIF metadata removal on hand-built fixtures (an Exif block with GPS, a `tEXt` chunk, an `XMP ` chunk), byte-exact output, an unparseable file refused, an already clean file unchanged.
- `test/image-encoding.test.ts`: `chooseEncoding` for transparent, opaque, large, small and animated inputs; the 2560 px scale arithmetic; the "keep the original if the result is bigger" rule.
- `test/image-placement.test.ts`: fit-to-view sizing, row layout with wrap, the 10-file cap.
- `test/image-svg.test.ts`: the template allow-list accepts a plain SVG, refuses scripts, `foreignObject`, external hrefs, entities, `javascript:`; the raised size cap.
- `test/asset-gc.test.ts`: mark and sweep over live rooms and versions, the grace period, a restore finding its asset, files removed only when unreferenced.
- `test/image-model.test.ts`: `image` object round-trips through the store, `keepAspect`, `.drift` export lists referenced assets, JSON note, Markdown line, the template validator refuses an `image`, `OBJ_TYPES` has it and `CREATE_KEYS` does not.

Relay (spawned relay like the existing server tests, accounts mode on):

- `test/assets-api.test.ts`: upload as editor `201`, repeat `200` with the same hash, viewer and commenter `403`, no session `401`, read as viewer, `404` for a hash another board owns, `claim` across boards the caller can and cannot read, wrong type, mismatched magic bytes, oversize, too many pixels, over quota `402`, read-only workspace `402`, rate limit `429`, CSRF header required, traversal-shaped hashes refused, response headers exactly as specified, an SVG with a script refused, EXIF gone from a stored JPEG, removing board access ends reads at once, audit rows written.
- `test/assets-backup.test.ts`: a snapshot contains `assets/<aa>/<hash>`; a second run uploads nothing for an unchanged asset.
- Client logic tests for the upload queue (offline create, reconnect, hash rewrite, a deleted object drops its record) with the queue's storage injected, as `icon-offline` does.

## Not in this slice

- Images in templates, images created by MCP, vision features.
- Cropping, masking, rounded corners, borders, replace image, image captions, image-to-sticky tools.
- Animated GIF downscaling, video, PDF, HEIC, AVIF.
- Fetching an image from a URL, dragging an image out of another web page by URL, a stock photo search.
- Per-image comments beyond the existing pins on an object (pins already attach to any object).
- A storage usage screen in the admin dashboard (the numbers exist; the screen follows), hosted storage billing.
- Restoring assets from an off-site backup (restore itself is not built yet).

## Slices

1. **Model and local images.** `image` type, rendering, paste, drop, **Image** button, client downscaling, `blobs` store, local-only boards, `.drift` round trip, tests for placement, encoding, header parsing. Works with sync off.
2. **Asset store and API.** `raw` route bodies, `assets` table and migration, upload/claim/get, strip, SVG check, quota, rate limit, headers, audit, upload queue, service worker cache, `/api/me` flag.
3. **Everything around it.** PNG and SVG export, JSON and Markdown handling, history garbage collector, template guard, backup walk, admin audit sentences, MCP metadata and `OBJ_TYPES`.
4. **Polish and docs.** Alt text field, **100%** action, placeholders and messages, user guide page, `docs/accounts.md`, `docs/backups.md` and `docs/history.md` updates.

Slices 1 and 2 are the only ones that need to ship together for sync; 1 alone is a usable offline feature.

## Files

### New

- `src/images.ts` (pure: allowed types, header parsing, `chooseEncoding`, placement, `assetUrl`)
- `src/asset-store.ts` (IndexedDB `blobs` and `uploads`, queue)
- `src/ui/image-add.ts` (the paste, drop and button entry, error toasts)
- `server/assets.mjs` (store, table access, strip, validation, garbage collector)
- `server/image-strip.mjs`, `server/image-header.mjs` (pure, shared with the client through a small copy or an isomorphic module)
- the tests listed above

### Existing (touched)

- `src/types.ts`, `src/markup.ts`, `src/render.ts`, `src/geometry.ts`, `src/app.ts` (paste, `keepAspect`), `src/ui/board.ts` (drop, button), `src/ui/quickbar.ts`, `src/ui/props.ts`, `src/exporters.ts`, `src/shortcuts.ts` (if the button gets a key)
- `server/api.mjs` (routes, `raw` option, limiter), `server/directory.mjs` (migration, queries), `server/config.mjs`, `server/relay.mjs` (nothing for the socket; headers for asset responses live in the API), `server/board-ops.mjs`, `server/templates.mjs` (refusal), `server/backup.mjs`, `server/cloud.mjs` (usage and limit fields, if approved)
- `public/sw.js`
- `docs/backups.md`, `docs/history.md`, `docs/accounts.md`, `docs/guide/` (a new page when it ships), `CHANGELOG.md`

## Open questions for Johan

1. **Animated GIFs.** Keep them as they are when under the caps and refuse otherwise (this spec), or take the first frame of a big one and say so? Animation on a whiteboard also costs CPU for everyone watching.
2. **Size and storage defaults.** 10 MB per file after downscaling, 100 MB per board, no instance cap. Right order of magnitude? For hosted workspaces, is storage a plan limit (and then a number per seat or per workspace), or only a safeguard?
3. **SVG uploads at all?** The allow-list plus image-only rendering is safe by design, but SVG is the format with the longest history of surprises. The alternative is to rasterise SVG in the browser at upload and store PNG, losing vector sharpness.
4. **Deleted images and history.** An image removed from the board stays fetchable through old versions until they expire (up to 30 days of dailies, longer for named versions). Is that acceptable, or should deleting an image also be able to purge it from history (a deliberate, owner-only action)?
5. **JSON snapshot.** References only (this spec) or embed the bytes as base64 for a complete, if bulky, file?
6. **Images in templates.** Is "not in v1" fine? The common wish is a logo or a diagram in a workshop template, which needs template-owned assets (v2 above).
7. **Alt text and captions.** Alt text only (this spec), or also a visible caption under the picture?
8. **Pasting a URL.** Confirm no fetching: pasting `https://…/photo.jpg` makes a sticky with the link, as today.
9. **Who may add images?** Editors and owners, as for any object. Should a commenter be able to attach an image to a comment (screenshot of a bug)? That would be a second, comment-scoped asset kind.
10. **Open mode.** Anyone who can reach the relay can upload up to the quota. Acceptable for an instance Johan runs personally, or should open mode have a stricter default quota?
11. **Name of the toolbar button and its place.** **Image** after **Frame**, before the drawers (Icons, Stickers), as drafted, or inside a drawer?
