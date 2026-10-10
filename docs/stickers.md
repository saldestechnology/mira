# Stickers and emojis

Stickers are emoji placed on a board, drawn in full colour. A sticker is an existing **icon** object whose Iconify set is an emoji set, plus one flag. This slice adds a Stickers drawer, a larger default size, a flag that hides the colour control, and a small reaction picker in the quick-action bar. It adds no object type, no render path, no server endpoint, no schema bump and no service worker change.

## Why the icon type is enough

The design question was whether the icon object can already draw colour emoji. It can, and the code shows it:

- `iconMarkup` (`src/markup.ts`) embeds the stored SVG body. The only transform is `sanitizeSvgBody`, which strips scripts, event handlers and `javascript:` links. Colours are untouched.
- The body's `color` reaches only elements that use `currentColor`. It is the literal `textColor` on icons placed from the library, and otherwise the stroke default `var(--canvas-ink)`, which the themes vary. Emoji sets paint explicit fills, and the sets offered below have no `currentColor`, so no theme can recolour them. Themes change many tokens (`src/themes.ts`); only their `currentColor` parts follow `--canvas-ink`.
- Iconify probe, first 60 icons of each set:

| Set | Bodies with explicit colour | Bodies with `currentColor` | Mean body (characters) |
| --- | --- | --- | --- |
| `fluent-emoji-flat` | 60 / 60 | 0 | 1,697 |
| `twemoji` | 60 / 60 | 0 | 1,575 |
| `noto` | 60 / 60 | 0 | 4,110 |
| `fluent-emoji` (3D) | 60 / 60 | 0 | 21,799 |
| `fluent-emoji-high-contrast` | 5 / 60 | 60 / 60 | 1,735 |

`fluent-emoji-high-contrast` is monochrome: its colour comes from `textColor`, so it reads as an icon with a working Colour control. It is an icon, not a sticker, and it is excluded. A 10-icon sample of the first four sets had no `<style>` elements and no `class` attributes.

- Everything else a sticker needs already works for icons: resize keeps aspect (`app.ts`, `keepAspect` for `icon`), rotate, z-order, frames, undo, copy and paste (`insertObjects` clones the body under a fresh id), `.drift` and JSON export and import, offline storage (the body lives in the board document, persisted by `y-indexeddb` in `src/sync.ts`), and PNG and SVG export (`objectMarkup` inlines the body, so export fetches nothing).

A new object type would add a second render path, sanitiser, export branch and schema shape for no visible gain. The `sticker` flag exists only for what differs: no colour control, a "Sticker" label, and a sticker that stays a sticker if its set later leaves the list.

## A bug the icon code has today

Some Iconify bodies carry SVG `id`s that gradients refer to. In the probe, 14 of 60 `noto` bodies and 60 of 60 `fluent-emoji` bodies have them, and two different Fluent icons (`grinning-face` and `grinning-face-with-big-eyes`) share 10 ids. Whether their gradient definitions differ was not checked, and the fix does not depend on it. Board objects are inlined into one document, both in the live renderer (`render.ts` sets each object's `innerHTML`) and in export (`exportSvg` joins every `objectMarkup`). The browser resolves `url(#id)` to the first element with that id, so two stickers can take each other's gradients.

Copy and duplicate keep the body and give the copy a new object id, so the fix cannot be made at placement. It goes in `iconMarkup`: every icon's body has its ids scoped by object id at render and export time. This also changes any existing icon whose body has ids, and changes nothing for icons without them. Add a Fixed fragment in `changelog.d/` (see `changelog.d/README.md`).

## Data model

The object is the existing `icon` object plus one optional field:

```ts
// src/types.ts, BaseObj, icon fields
type: 'icon'
ref: string                                  // 'fluent-emoji-flat:party-popper' (existing)
body: string                                 // SVG body as fetched; stored unscoped (existing)
viewBox: [number, number, number, number]    // existing
sticker?: boolean                            // NEW: true on stickers and reactions; absent on icons
```

Stickers do not set `textColor`. The library sets `'#18212B'` on icons, which has no effect on colour emoji and is left out for stickers.

Example stored object:

```json
{ "id": "V3k…", "type": "icon", "ref": "fluent-emoji-flat:party-popper", "body": "<path …/>",
  "viewBox": [0, 0, 32, 32], "sticker": true, "x": 240, "y": 96, "w": 120, "h": 120,
  "rotation": 0, "z": "a1", "font": "satoshi", "createdBy": "…", "updatedAt": 1789000000000 }
```

Configuration, in the new `src/stickers.ts`:

```ts
export interface StickerSet { prefix: string; label: string; default?: true }
export const STICKER_SETS: StickerSet[];   // fluent-emoji-flat (default), twemoji, noto
export const REACTIONS: string[];          // 16 full names from fluent-emoji-flat, listed below
export const STICKER_SIZE = 120;           // longest side, in board units (icons use 64)
export const REACTION_SIZE = 40;
export const isSticker = (o: Obj): boolean => o.type === 'icon' && o.sticker === true;
export function stickerSize(width: number, height: number, longest = STICKER_SIZE): { w: number; h: number };
export function scopeSvgIds(body: string, objectId: string): string;
```

Reactions, all present in `fluent-emoji-flat` (checked against Iconify): `thumbs-up`, `red-heart`, `party-popper`, `face-with-tears-of-joy`, `eyes`, `fire`, `rocket`, `sparkles`, `clapping-hands`, `thinking-face`, `hundred-points`, `check-mark-button`, `cross-mark`, `raising-hands`, `folded-hands`, `star-struck`.

Sets offered in the drawer (licences from Iconify's collections index):

| Prefix | Name | Licence | Attribution | Body | Status |
| --- | --- | --- | --- | --- | --- |
| `fluent-emoji-flat` | Fluent Emoji Flat | MIT | no | 1.7 KB | default |
| `twemoji` | Twitter Emoji | CC-BY-4.0 | yes | 1.6 KB | offered |
| `noto` | Noto Emoji | Apache-2.0 | no | 4.1 KB | offered |

Each placed sticker copies its body into the board document, and every duplicate copies it again. Sets with large bodies are not offered (see Not in this slice).

## Behaviour

- **Placing.** Dropping or clicking a Stickers tile calls `placeSticker(app, name, at?, longest?)`. It awaits `iconData(name)`, sizes the object with `stickerSize(width, height, longest)` (longest side `STICKER_SIZE` by default), and calls `app.placeAt` (drop, at the drop point) or `placeClicked` in `ui/place-click.ts` (click: the view centre, then 24 units right and down from the last click placement while it is still where it was put) with `type: 'icon'` and `{ ref, body, viewBox, sticker: true }`. The creator, z-order, frame parenting, snapping and undo come from the existing `makeObj` and `createObject`. The new sticker is selected, as any object is.
- **Rendering.** `iconMarkup` runs `scopeSvgIds(sanitizeSvgBody(body), o.id)`. `scopeSvgIds` collects the ids the body defines (`id="X"` or `id='X'`), then rewrites only those: each `id` attribute, each `url(#X)` (quoted or not), and each `href="#X"` or `xlink:href="#X"` (single or double quotes) that names a defined id becomes `i<objectId>-X`. References to ids the body does not define are left alone, and a body with no ids comes back unchanged. The rewrite runs on each render; the offered bodies are at most about 10 KB, so it is not cached. Object ids come from `newId()` and use only `A-Za-z0-9-_`, so the new ids are valid. Animation timing references (`begin="x.end"`) are not rewritten; the offered sets have no animations in the sample, and the implementation checks this.
- **Colour.** Stickers have no colour control. `HAS_STROKE` excludes stickers, which hides the Colour swatch in the properties panel and the Line swatch in the quick bar. The properties title reads "Sticker".
- **Resize and rotate.** Unchanged from icons: resize keeps aspect, rotation works.
- **Double-click.** Does nothing, as for icons.
- **Reactions.** A React button in the quick bar, built with the existing `menu` helper, opens `reactionPicker(app)`: the 16 `REACTIONS` as a 4 × 4 grid. Clicking one closes the popover and calls `placeSticker` at `REACTION_SIZE`, with its centre 20 units right of and 20 units above the top-right corner of the selection's bounds. A reaction is a plain sticker: it does not follow its item, has no count, and is removed like any object (delete or Ctrl+Z). With several items selected, one reaction is placed at the bounds of the selection. Reaction previews and bodies come from one pin file the build writes (`docs/icons-selfhost.md`).
- **Failure.** A sticker that cannot be fetched shows the existing toast ("That icon could not be loaded. Check your connection and try again.") and places nothing.
- **Copy.** Copy, paste and duplicate clone the body and give a new id; the render-time scope keeps the copy's ids apart.
- **Emoji typed as text.** Unchanged. Emoji typed into text and sticky notes are plain Unicode text and are not affected.
- **Strings.** All new text says "Sticker" or "Stickers". No new product-name text and no new `MIRA_*` environment names are added.

## UI

- **Rail.** A Stickers button after Icons, with a new `stickers` glyph in `ICONS` (`src/ui/dom.ts`).
- **Drawer.** Title "Stickers", then:
  - a search box ("Search stickers", 250 ms debounce as in the Icons tab);
  - a "Set" label over a segmented control of set labels, one per `STICKER_SETS` entry, with `fluent-emoji-flat` selected by default;
  - a grid of square hairline tiles with 4 px corners (`.sticker-grid` with `.sticker-tile` buttons holding a 28 px image), each with title and aria-label "`<name>`. Click to add, or drag onto the board.";
  - with an empty search, `collectionIcons(set)` (limit 160), as the Icons tab does; with a query, `searchIcons(query, set)`.
- **Note.** Under the grid: "`<set label>` stickers are licensed CC BY and need attribution when you publish." when the chosen set has `attribution` (from `iconSets()`), otherwise "Stickers are emoji from open-source sets. Placed stickers are stored in the board and work offline." A Licences link opens the icon credits dialog.
- **Quick bar.** One React button (`menu('stickers', 'React with a sticker', …)`), placed after the arrange group and before the Delete group. It is shown for any non-empty selection on a board that is not read-only. Its popover uses the quick bar's own `popover` placement.
- **Style.** Swiss rules on the tray: theme variables only (no literal colours), 12px popover and tray radii, 8px search control, 4px tiles and chips, no added shadows, 1px hairlines and a 2px rule under the search box, labels 11px uppercase, spacing on an 8px grid. The active set chip is the only signal-coloured element, with on-signal text; text uses only the pairs the theme test checks (tray text and tray muted on tray, on-signal on signal). The React popover shows a "React" label over a 4 × 4 grid.
- **Mobile.** At 360 px the quick bar with React must fit without horizontal scroll, and the drawer keeps a 16px gutter with no horizontal scroll. The bar already has `max-width: calc(100% - 24px)` and an inner scroller (`src/styles.css`); the check is that a single sticker's bar, and a single sticky's bar, fit at 360 px without the inner scroller activating.

## Roles

| Role | Stickers drawer | Place a sticker | React |
| --- | --- | --- | --- |
| owner, editor | yes | yes | yes |
| commenter | no (button disabled) | no | no |
| viewer | no (button disabled) | no | no |

Open mode (accounts off): everyone may place and react, as they can add icons today.

Enforcement, all existing:

- The Stickers rail button is disabled while the board is read-only. The read-only sync in `src/ui/board.ts` loops over every rail button, and drawer buttons have no `dataset.tool`, so the Icons button is already disabled for viewers today and the new button needs no extra code. The drawer closes on read-only, as it does today.
- `dropItem` returns early when `app.readOnly` (`src/ui/library.ts`), so a drop does nothing. `placeSticker` repeats the check.
- `Store.transact` does nothing while read-only (`src/store.ts`).
- The quick bar is hidden when read-only (`visible()` in `src/ui/quickbar.ts`), so no React button appears.
- Stickers are board-room objects. The relay drops board-room updates from commenters and viewers (`docs/comments.md`), so a modified client cannot write a sticker through.

The comments room holds only comment text, so comments cannot carry stickers.

## Export and import

- **SVG and PNG.** Stickers export as icons do: the body is inlined, the ids are scoped, nothing is fetched. PNG rasterises that SVG.
- **Mermaid.** Skips icons (`toMermaid` in `src/mermaid.ts`), so it skips stickers too.
- **`.drift`.** Carries the full Yjs state, which includes `body` and `sticker`. Opening it restores both.
- **JSON.** `toJson` writes `objects` verbatim, so `sticker` and `body` are included. `insertImported` clones them through `insertObjects`.
- **Old clients.** A sticker opens as an icon: it shows the Colour control, which changes nothing. `sticker` is optional, and `validate` checks the format, that `objects` is an array, and `schemaVersion`, so `SCHEMA_VERSION` stays at 1.
- **Bodies in imports.** Imported bodies pass through the same sanitiser and id scoping at render time as any icon. No extra check is added.
- **Credits.** Exports carry no attribution line.

## Offline

Updated for TAB-101: the sets are hosted by Tabula (`docs/icons-selfhost.md`), so the drawer no longer depends on Iconify.

- **Placed stickers.** The body is in the board document, persisted in IndexedDB. A placed sticker renders offline with no fetch, and PNG and SVG export work offline.
- **Stickers drawer.** Search, browsing and placing a new sticker read `/icons/` on the relay. The service worker keeps every index and shard the device fetched in the `tabula-icons-v1` cache (cache first; the manifest is network first), so anything seen once works offline. A "Download for offline" row stores the three sticker sets (6.8 MB to send, about 42 MB stored) on purpose, and shows when an update is available.
- **Reactions.** The 16 bodies are in one file (`pin.<hash>.json`, about 6 KB), so the picker costs one request, and the service worker keeps it. A test requires the pinned names to equal `REACTIONS`.
- **Service worker.** `public/sw.js` has an `/icons/` branch and a cache that outlives app versions; `VERSION` is `tabula-v2`. The Iconify rule stays for sets that are not hosted.

## Tests

Automated (`npm test`, vitest):

- `test/stickers.test.ts` (new):
  - `scopeSvgIds` rewrites defined ids in `id`, `url(#…)` and `href="#…"`/`xlink:href` forms, with double and single quotes;
  - `scopeSvgIds` leaves references to undefined ids and bodies without ids unchanged;
  - `STICKER_SETS` prefixes are unique, and `REACTIONS` has 16 unique names;
  - `stickerSize` keeps aspect and sets the longest side to the `longest` argument, for square and wide sizes;
  - `isSticker` is true only with `sticker: true` on an icon;
  - store round trip: a sticker created in a `Store`, encoded with `Y.encodeStateAsUpdate` and applied to a fresh `Y.Doc`, reads back `sticker`, `body`, `viewBox` and `ref`;
  - a read-only `Store` creates no sticker (same pattern as `test/store-readonly.test.ts`).
- `test/core.test.ts` (extended):
  - two icon objects with the same body, combined in one document, have no shared ids, and every `url(#…)` in each resolves to an id of its own object;
  - sticker markup has no external `href` or `url(http`, and carries its body inline.

Manual, in the dev server:

- Place Fluent flat, Twemoji and Noto stickers in each theme (Default, Ayu, Kanagawa, Matrix, Evergreen). Colours must not change.
- Duplicate two Fluent stickers (Ctrl+D). Each keeps its own gradients.
- Select a sticker. There is no Colour or Line swatch, the title reads "Sticker", and the quick bar offers lock, duplicate, delete, More and React.
- React adds one sticker next to the selection, and Ctrl+Z removes it.
- Go offline (DevTools) and reload. Placed stickers render, and PNG and SVG export work.
- Accounts mode, as a viewer and as a commenter: the Stickers button is disabled, the quick bar is hidden, and a drop does nothing.
- At 360 px width, the quick bar with React fits without its inner scroller.
- `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` pass.

## Not in this slice

- **Fluent 3D (`fluent-emoji`).** Its bodies average about 22 KB, roughly 13 times the flat set, and each placed copy stores its body in the board document. Left out for board size; it can be revisited if the storage cost is acceptable.
- **OpenMoji (`openmoji`).** Licensed CC-BY-SA-4.0. Its share-alike term would need a decision about exported boards before it is offered.
- **Other sets not sampled.** `emojione`, `emojione-v1`, `fxemoji` and `streamline-emojis`, and `emojione-monotone` and `noto-v1` (by name), are left out until sampled.
- **Giphy and animated GIFs.** Needs an API key held on the server behind a proxy route under `/api/` (never in the client); an external call per search with rate limits and a content-rating filter; a raster object (`<image href>`), not an SVG body; storage for 0.5 to 5 MB files outside the board document, which means an asset store that does not exist yet; caching for the media CDN in the service worker; Giphy's attribution rules; and PNG export captures one frame.
- **Attached reactions.** Reactions that follow their item, show counts, or record who reacted. This needs a reaction map on the object or a comment-style record, and probably the comments document, so that commenters can react without editing the board.
- **Custom uploads, sticker packs, animated emoji, skin tones, and search across every Iconify set.**
- **Credit lines in exports.**
- **A keyboard shortcut for the Stickers drawer.**
- **Hiding emoji sets from the Icons tab.** The Icons tab already offers emoji sets (`POPULAR_SETS` in `src/icons.ts`), and it stays as it is. `src/icons.ts` is not edited.

## Files

NEW:

- `docs/stickers.md`: this spec.
- `src/stickers.ts`: `STICKER_SETS`, `REACTIONS`, the sizes, `isSticker`, `stickerSize` and `scopeSvgIds`. No DOM and no UI imports.
- `src/ui/stickers.ts`: `stickersTab(app, draggable)`, `placeSticker(app, name, at?, longest?)`, and `reactionPicker(app)`.
- `test/stickers.test.ts`: the unit tests listed above.

EXISTING (one line each):

- `src/types.ts`: `sticker?: boolean` on the icon fields of `BaseObj`.
- `src/markup.ts`: `iconMarkup` runs `scopeSvgIds` on the sanitised body of every icon.
- `src/ui/library.ts`: `'stickers'` in `DrawerTab`, its title and body dispatch; a `{ kind: 'sticker' }` variant in `DropItem`, routed to `placeSticker`.
- `src/ui/board.ts`: a Stickers rail button after Icons (the existing read-only loop disables it with the rest), and `'stickers'` added to the `drawerBtn` tab union.
- `src/ui/props.ts`: `HAS_STROKE` excludes stickers; the title reads "Sticker".
- `src/ui/quickbar.ts`: one line that pushes the React group, built with `menu` and `reactionPicker`, for non-read-only selections.
- `src/ui/dom.ts`: a `stickers` glyph in `ICONS`.
- `src/styles.css`: `.stickers-label`, `.sticker-sets`, `.sticker-grid`, `.sticker-tile`, `.stickers-note`, `.reaction-grid` and the React popover rules; theme variables only, role-based radii and no added shadows.
- `test/core.test.ts`: the two icon-markup cases listed above.
- `README.md`: a row in the "What works today" table for stickers and reactions.
- Fragments in `changelog.d/` (see `changelog.d/README.md`): an Added entry for stickers and reactions and a Fixed entry for the gradient id collision.

Untouched: `src/app.ts` and `src/render.ts` (the rename is editing them), `src/exporters.ts`, `src/icons.ts`, `src/store.ts`, `src/sync.ts`, `public/sw.js` and `server/`.

## Decisions

Settled before implementation:

1. Default set: `fluent-emoji-flat`.
2. OpenMoji is left out.
3. Fluent 3D is left out, because each placed copy stores about 22 KB in the board document. The offered sets are `fluent-emoji-flat`, `twemoji` and `noto`.
4. Exports get no credit line.
5. Default size is 120.
6. Reactions stay in this slice.
7. Reaction bodies are fetched as needed, not bundled.
8. The Stickers button is disabled for read-only users.
9. The Icons tab stays as it is, and `src/icons.ts` is not touched.

Changes made while implementing: the empty-search view is `collectionIcons(set)` for every set, replacing the starter grid, so that each set behaves the same. `stickerSize` takes width and height rather than the viewBox. The drawer takes no close callback, since the Icons tab does not close on placement either.
