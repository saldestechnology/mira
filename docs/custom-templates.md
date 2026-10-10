# Custom templates (spec, TAB-82)

Status: steps 1 to 4 (open mode: saving, using, thumbnails, editing, renaming, duplicating, export and import) are built and on main. Step 5 (the server, accounts mode: sharing with teams and the workspace, the HTTP API, validation, audit, offline cache, the upload offer and MCP access) is built on this branch, `feat/custom-templates-server`. The open questions at the end are decided; the text below describes what was built.

People can save part of a board, or the whole board, as a template; find it on the Templates page and the Boards page under **My templates**; start a new board from it or insert it into the current board; and edit, rename, duplicate or delete it. Templates work offline in open mode (stored in the browser) and are shared through the server in accounts mode.

## 1. What a template is

A built-in template (`src/templates.ts`) is code: a `build(b: Builder)` function. A custom template is data: a snapshot of objects and session steps.

```ts
interface CustomTemplate {
  id: string;                 // newId()
  version: 1;                 // format version of `content`
  name: string;               // 1..80 chars
  category: string;           // one of the built-in categories or "Custom" (a fixed list, see Q4)
  description: string;        // 0..280 chars
  content: TemplateContent;
  createdBy: string;          // user id (open mode: the local user id)
  createdAt: number;
  updatedAt: number;
  // accounts mode only
  scope?: 'personal' | 'team' | 'workspace';   // see open question Q1
  teamId?: string | null;
}

interface TemplateContent {
  objects: Obj[];             // normalised, see 2
  steps: Step[];              // session steps whose frameId points into `objects`, or none
  bounds: Rect;               // bounding box of `objects`, after normalising (x = y = 0)
  fonts?: { heading: string; body: string };  // board fonts at save time, applied only to a new board
  labels?: { id: string; name: string; color: string }[];  // the labels its kanban cards use (docs/kanban.md, Templates)
}
```

Kanbans (`container`, `lane`, `card`, docs/kanban.md) are checked field by field on both sides by one shared function (`templateKanbanFields` in `shared/containers.mjs`): a lane sits in a kanban of the template and a card in a lane of it or nowhere, each rank names its parent, card labels come from the template's `labels`, colours go through `kanbanColor`, text has the kanban limits, and owners, due dates and the reserved tracker fields are refused. Saving strips those, keeps the labels the cards use (renumbered `l1`, `l2`, …), and on use the labels merge by name into the board's (an existing label with the same name wins) in the same undo step as the objects.

The objects use the board's own `Obj` shape, so rendering, export and paste need no new code paths.

## 2. Saving: from a selection to `TemplateContent`

1. **Gather.** Reuse `BoardApp.gather(ids)` (the copy/duplicate path). It adds frame children recursively and the connectors whose both ends are in the set. "Whole board" means every top-level object.
2. **Normalise**, in a pure function `toTemplateContent(objs, steps, meta)` in a new `src/custom-templates.ts`, so it's unit-tested without a DOM:
   - Translate so the bounds start at (0, 0). Free connector ends are translated too.
   - Re-key every id to a short local id (`o1`, `o2`, …), rewriting `parent`, connector `from.id` / `to.id` and step `frameId`. A connector end pointing outside the set becomes a free end at the target's centre, exactly as `insertObjects` does today.
   - Drop session and collaboration state: `privateStep`, `locked`, `createdBy`, `updatedAt`, votes, poll answers, timers and comments. Comments are never saved into a template.
   - Keep `z` order but renumber it (fresh fractional keys on insert anyway).
3. **Offline-safe assets.** Icons and stickers already carry their SVG in `body` (sanitised by `sanitizeSvgBody`), and `ref` is only a label, so nothing needs fetching. Fonts are names of Fontshare families the app loads anyway. The board has no raster images today. If images are added later, the format bumps to `version: 2` and inlines them as data URLs with a size cap.
4. **Steps.** Saving the whole board includes the board's session steps. Saving a selection includes only steps whose `frameId` is inside the selection, plus steps without a frame if the user ticks **Include session steps** (default on when the board has steps).
5. **Limits.** At most 2,000 objects and 1 MB of JSON per template. The dialog says so plainly if a selection is too big.

## 3. Using a template

`instantiate(content, origin, userId)` is the inverse of step 2: it maps every local id to `newId()`, offsets by `origin`, sets `createdBy`, and returns `{ objects, steps }`. It's pure and tested, and it shares the remapping helper with `insertObjects` (extract `remapObjects(objs, idMap, offset)` from `app.ts`, used by both).

- **New board from template.** Same flow as built-ins today: `nav.open(newId(), { template })` with `template = 'custom:<id>'`. The board opens, places the content at the grid origin, applies `fonts`, and sets the steps.
- **Insert into this board** (Templates drawer on a board, and a menu item on each card): reuse `insertTemplate` placement (to the right of existing content, snapped to the grid). Insert replaces the board's steps only if the template has steps, with the same confirmation the built-ins use.
- One undo step for the whole insert (`undo.stopCapturing()` + one `transact`), as today.

## 4. Thumbnails

There's no stored image. A thumbnail is rendered on the fly from `content.objects` with the existing `objectMarkup()` into an inline `<svg viewBox="0 0 w h">`, scaled to the card. This is theme-aware for free, since the canvas markup already uses `var(--canvas-ink)` and friends, costs nothing to store, and is always current after an edit. For a template over ~400 objects the card renders a simplified preview (frames and stickies only) to keep the grid fast. Built-in templates get the same treatment by running `build()` into a throwaway `Builder`, so every card has a picture (this also fixes TAB-64's "template card thumbnails" item for free).

## 5. Storage

### Open mode: IndexedDB

A new database `driftboard:templates` (keeps the `driftboard` storage prefix on purpose, see the rename notes), object store `templates`, keyPath `id`, index `updatedAt`. A tiny wrapper `src/template-store.ts` exposes `list()`, `get(id)`, `put(t)`, `remove(id)` and an `onChange` event (BroadcastChannel, so two tabs stay in sync). Templates are per browser, like boards in open mode. Export and import of a template as a `.drift`-style JSON file (`{ format: 'tabula-template', version: 1, template }`) lets people move them between machines.

### Accounts mode: the server

Directory migration 6 (`TEMPLATES_MIGRATION` in `server/templates.mjs`, registered in `directory.mjs` like the token table):

```sql
CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  scope TEXT NOT NULL CHECK (scope IN ('personal','team','workspace')),
  team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,          -- the validated JSON TemplateContent, at most 1 MB
  object_count INTEGER NOT NULL,  -- so a list never has to parse the content
  step_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  CHECK ((scope = 'team') = (team_id IS NOT NULL))
);
CREATE INDEX templates_owner ON templates(owner_id);
CREATE INDEX templates_team ON templates(team_id);
```

`server/templates.mjs` holds the migration, every template query (`createTemplateStore`, spread into the directory the way `createTokenStore` is) and the content validator. `api.mjs` has the routes, `mcp.mjs` the two tools.

**Who sees and changes what** (`templateAccess`, used by every route and by MCP; a template the caller cannot see is `404`, one they can see but not change is `403`):

| Scope | Sees it | Changes or deletes it |
|---|---|---|
| `personal` | the owner. Workspace owners and admins also see one whose owner was removed | the owner (admins too, when the owner is gone) |
| `team` | members of the team (guests who are members too), and workspace owners and admins | the owner while still in the team, the team's admins, workspace owners and admins |
| `workspace` | every member (not guests) | workspace owners and admins only |

- **Creating:** members and up; guests get `403`. `personal` is the default. `team` needs `teamId` and membership of that team (`403 You are not a member of that team`), except that workspace owners and admins may use any team (`404` for one that does not exist). `workspace` is for workspace owners and admins only (`403`). Q2 of the open questions: members share with their teams, only owners and admins publish to everyone.
- **Moving a template** (`PATCH` with `scope`/`teamId`) follows the same rules for the place it goes to, and the caller must be allowed to change it where it is. Making a template personal is for its owner alone (a team admin cannot pull somebody else's template out of the team). `teamId` is required with `team` and refused with the other two scopes.
- **Leaving a team:** a person removed from a team keeps nothing of their team templates: they no longer see them, and the templates stay with the team (its admins and workspace owners and admins can change them).
- **Deleting a person:** `owner_id` becomes `NULL` (`ON DELETE SET NULL`, as `boards.owner_id` does). Team and workspace templates stay where they are and show no owner. A personal template of a removed person is unreachable for everybody but workspace owners and admins, who can see it (as they see every board), duplicate it or delete it.
- **Soft delete:** `deleted_at`. A deleted template is `404` everywhere, and the row is kept.
- **Per person limit:** at most 200 templates each (`409 template_limit`); deleted ones do not count.

API, with `compile()` and the same session, CSRF and read-only rules as the boards routes:

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/templates` | signed in | Metadata of every template the caller can see, newest first, never the content: `id, version, name, category, description, scope, teamId, teamName, createdBy` (the owner's id, empty when removed), `ownerName, createdAt, updatedAt, objectCount, stepCount, canChange`. |
| GET | `/api/templates/:id` | anyone who can see it | The same plus `content`. |
| POST | `/api/templates` | members and up | Body `{ name, category, description?, scope?, teamId?, content }`; unknown fields are `400`. `201` with the full template. |
| PATCH | `/api/templates/:id` | see the table | Any of `name, category, description, content, scope, teamId`; nothing to change is `400`. `200` with the full template. |
| POST | `/api/templates/:id/duplicate` | anyone who can see it, except guests | A personal copy named "<name> (copy)" owned by the caller; needs only read access to the original. `201`. |
| DELETE | `/api/templates/:id` | see the table | Soft delete, `204`. |

- **Body size:** `compile()` takes a per-route `maxBody` (default `MAX_BODY`, 64 KB). The template routes that take a body (`POST`, `PATCH`) allow 1 MiB (`TEMPLATE_BODY_LIMIT`); over that is `413`. `DRAIN_LIMIT` (the size up to which an oversized body is still read and thrown away, so the client receives the `413` instead of a reset connection) is now 2 MiB and `compile()` refuses a route whose `maxBody` is above it. The content itself is limited to 1,000,000 bytes of JSON and 2,000 objects (`400` over that), so a request of 900 KB is accepted and one of 1.2 MB is `413`.
- **Validation (security critical):** a template is data the server stores and hands to other people's browsers, so the content is rebuilt, not stored as sent. `validateTemplateContent` accepts only `objects`, `steps`, `bounds` and `fonts`, and builds each object from the fields allowed for its type: a known `type` (`TEMPLATE_OBJ_TYPES`, a test keeps it equal to `ObjType`), a unique id of up to 64 letters, digits, `-` or `_`, finite numbers within limits, `parent` pointing at a frame in the template (no loops), connector ends pointing at boxes in the template, step `frameId`s that resolve, colours without `url()` or markup, fonts as names, text with length caps and no control characters. Session and collaboration state (`privateStep`, `locked`, `createdBy`, `updatedAt`), poll and quick steps and every unknown key are dropped or refused. Nothing in the content is trusted again later: MCP and the app both read what was stored.
- **SVG bodies** (icons and stickers, `body` on `type: 'icon'` only) are checked by `svgProblem` and refused with `400` and a message that names the object and the reason ("Object 4 has an SVG body that is not allowed: it uses <script>, which an icon cannot contain"). It is an allow-list, not a clean-up: only drawing elements (no `script`, `foreignObject`, `style`, `iframe`, `embed`, `object`, `a` or animation elements), no `on*` attributes, `href`/`xlink:href` only to `#` references inside the icon or to inline `data:image/png|jpeg|gif|webp`, `url()` only to `#` references, no comments, CDATA, DOCTYPE or processing instructions, no CSS image functions (`image-set()`, `image()`, `cross-fade()`) that could name an address without `url()`, no character references other than `&amp; &lt; &gt; &quot; &apos;`, no namespace other than SVG, well-formed tags with quoted attributes, at most 100,000 characters. Anything it cannot read as a plain tag is refused. The policy is `shared/svg-safety.mjs`, shared with the app's `sanitizeSvgBody` (TAB-204), which leaves out what the policy refuses instead of refusing, and keeps animations of drawing attributes (`d`, `transform`, `opacity` and the like; never a link or a style). The app still runs `validateContent` and `sanitizeSvgBody` on whatever it fetches from the server (`validateTemplate` in the store), as it does for a file or the browser's own storage.
- **Fixed categories (Q4):** `TEMPLATE_CATEGORIES` in `server/templates.mjs` is the eight built-in categories and `Custom`, and a test keeps it equal to `CATEGORIES` and `CUSTOM_CATEGORY` in `src/templates.ts`. Anything else is `400`. A local template with some other category is uploaded as `Custom`.
- **Audit:** `template.create` (also for a duplicate, with `copiedFrom`), `template.update` and `template.delete`, with the template id, name and scope (and `teamId` for a team template), never the content. The admin dashboard has a Templates filter and a sentence for each ("ana@example.com changed the template “Retro” shared with the workspace").
- **Read-only workspaces** (hosted, `402 read_only`): `GET`s work; `POST`, `PATCH`, `DELETE` and duplicate are refused, like board writes.
- **Offline in accounts mode:** the list and the contents of the templates fetched are cached in IndexedDB (`driftboard:template-cache`), every record tagged with the server origin; a record of another origin is never used. Offline, the cache is read and saving, changing, duplicating and deleting are refused with a clear message ("You are offline. Templates can be saved when the server can be reached."). The cache is cleared on sign-out.
- **MCP (Q6):** `list_templates` (token scope `read`) and `use_template` (scope `write`, board role owner or editor) in accounts mode. MCP cannot create, change or delete a template. See `docs/mcp.md`.

## 6. UI (Swiss style, as approved)

All of this follows `src/ui/admin.css` and the TAB-8 home styles: hairline rows, 11 px uppercase labels, 8 px control radii, `--signal` only for the primary action.

- **Save as template.** Shown in three places: the quick-action bar's **More** menu for a selection, the right-click/selection menu, and **Board menu → Save board as template**. It opens a dialog (the shared `dialog()`) with fields Name (prefilled from the frame name or board name), Category (select of the built-in categories plus "Custom"; no free text), Description, Include session steps (checkbox, only when relevant), and in accounts mode **Share with**: Only me / a team / Everyone in the workspace (see Q1/Q2). A live thumbnail sits on the right. Buttons: Cancel, **Save template** (primary). A toast confirms with a "View" link to the Templates page.
- **Templates page (`#/templates`).** New first section **My templates** above the built-ins, same card grid (thumbnail on top now), plus a "Shared with me" group in accounts mode. Each custom card has **Use template** (primary) and a `⋯` menu: Insert into a board…, Edit, Rename, Duplicate, Export file, Delete (Delete opens a confirm). Category filter and search cover both groups. An empty state explains how to save one, with a small graphic from TAB-64.
- **Boards page strip.** "Start from a template" shows recently used or created custom templates first (up to 4), then built-ins.
- **Editing a template.** **Edit** opens the template in a scratch board at `#/t/:id/edit`. It's a real board UI with a fixed banner above the chrome: "Editing template **Name**". It has **Cancel** (ghost) and **Save template** (primary), plus a details button for name, category and description. The scratch board is a local, non-synced Y.Doc (no relay room, not listed on Boards); Save runs the same normalise step over the whole scratch board and writes the template; Cancel discards. Leaving with unsaved changes asks first.
- **Accounts mode.** The same pages and dialogs; the sign-in state picks where templates live (one store interface, two backends: `src/template-store.ts` for the browser, `src/template-server.ts` for the server). The Save dialog (and the details dialog of the editor) gets **Share with**: Only me, each team the person belongs to, and Everyone in the workspace for workspace owners and admins, with a line saying who can use and change it. Guests and offline sessions see why Save is off. The Templates page shows **My templates** and **Shared with me** (team and workspace templates somebody else owns), and each card has a small scope label (Only me, the team's name, Workspace) and, when shared, the owner's name. Edit, Rename and Delete appear only when the server says the person may change the template (`canChange`); Duplicate is always there (a personal copy made on the server). Editing a template one may not change is refused with a pointer to Duplicate. The library drawer groups the same way.
- **Upload offer (Q5).** The first time somebody signs in in a browser that has open-mode templates, a dialog offers to upload them as personal templates ("Not now" or "Upload N templates"). It is shown once per browser, remembered in `localStorage` under `driftboard:templates-upload-offered` whatever the answer, and nothing is uploaded without the click. A template the server refuses is reported and the rest still go up; the browser's own copies stay.
- **Built-in templates** stay read-only; "Duplicate to edit" (Q3) makes a personal copy, on the server in accounts mode.

## 7. Tests

- `custom-templates.test.ts` (pure): normalise/instantiate round-trip keeps geometry, parents, connector bindings and step frames; external connector ends become free; private and session fields are dropped; ids are fresh on every instantiate; size limits.
- `templates-server.test.ts` (in process): the server constants equal the client's (categories, `ObjType`, `UmlRelation`, step modes, size limits); every built-in template passes the validator unchanged; unknown keys are dropped; bad references, unknown types, non-finite numbers, loops, unsafe colours and about sixty hostile or malformed SVG bodies are refused (and plain drawing is accepted); the visibility and change rules for every role; migration 6 on a version 5 directory; removing a person with templates.
- `templates-api.test.ts` (black box, a relay child process in accounts mode): CRUD permissions per scope for owner, admin, team admin, member, guest and a non-member (`404`); guests refused on create and duplicate; moving between scopes; leaving a team and being removed; duplicate; soft delete; `413` over 1 MB and a 900 KB template accepted; validation rejecting bad references, unsafe SVG and categories; audit rows; the 200 template limit; read-only workspace refusal.
- `mcp-templates.test.ts` (black box): `list_templates` visibility, filters and fencing; `use_template` placing, id and reference remapping, z order, authorisation by token scope, board role and visibility, audit, rate limit and read-only; no tool creates, changes or deletes a template.
- `templates-api-client.test.ts`, `template-server.test.ts`, `template-share.test.ts`, `template-store.test.ts`: the client calls, the server backend (fetching, caching tagged with the origin, offline, saving only what changed, error messages), the seam choosing the backend by sign-in state, the sharing choices and labels, the upload offer and template files without sharing fields.
- CSS: covered by `css-colors.test.ts`; contrast pairs unchanged.

## 8. Build plan (after the spec is approved)

1. `custom-templates.ts` (normalise, instantiate, `remapObjects` extracted from `app.ts`) + tests.
2. `template-store.ts` (IndexedDB) + open-mode Save dialog, Templates page section, use and insert.
3. Thumbnails from `objectMarkup` (custom and built-in).
4. Edit mode (`#/t/:id/edit`), rename, duplicate, delete, export/import.
5. Server table, API, validation, audit + client `api.ts` + accounts-mode UI (Share with).

Steps 1–4 are independent of the server and shipped first; step 5 is built on `feat/custom-templates-server`.

## Decisions (the open questions, answered by the product owner)

- **Q1. Sharing scope.** Personal, team and workspace from day one. Personal is the default.
- **Q2. Workspace templates.** Only workspace owners and admins publish to the workspace (create one there, or move one into it). Members share with the teams they belong to.
- **Q3. Built-in templates.** "Duplicate to edit" on built-ins is done on the client (a personal copy in the same category); the built-ins themselves stay read-only. Nothing was added on the server.
- **Q4. Categories.** A fixed list only: the built-in categories plus Custom. No free text; the server validates against the same list (`TEMPLATE_CATEGORIES`, kept equal to the client's by a test).
- **Q5. Open mode to accounts mode.** After signing in, a one-time offer uploads the browser's open-mode templates as personal templates. Once per browser, remembered in `localStorage` under a `driftboard:` key, nothing uploaded without the click.
- **Q6. MCP.** MCP may list templates and use them (add one to a board the token can write to), but not create, change or delete them. Listing needs a `read` token, using one a `write` token and the editor role on the board.

Decisions made while building, which the questions did not settle:

- Guests see the team templates of teams they belong to, but not workspace templates, and cannot create or duplicate.
- Workspace owners and admins see every team and workspace template, but another person's personal templates only when the owner has been removed.
- Only workspace owners and admins change a workspace template, even the one who published it, so a demoted publisher loses that right. The owner of a team template keeps the right while still in the team.
- `use_template` over MCP adds the template's objects only: not its session steps (facilitation is not an MCP tool) and not its fonts. It places them to the right of the board's content (`nextFree`) unless `x` and `y` are given, and counts as a write for the rate limit.
- A list never carries the content (`GET /api/templates`), so the app fetches the content of each template it lists, once, and keeps it in the cache until the template changes.
- At most 200 templates per person, so one member cannot fill the disk with megabyte templates.
