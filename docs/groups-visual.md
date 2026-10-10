# Groups: visual states

TAB-106, slice 2. The look of selecting, hovering, entering and locking a group, and of the Group and Ungroup buttons on touch, for the five themes. It extends [groups.md](groups.md) (which says what happens) with what it looks like. Nothing here changes the data model.

The mocks are drawn from the themes' own variables in `src/themes.ts` and regenerate with `node scripts/groups-visual-mock.mjs`. Each PNG in `docs/groups-visual/` has the five themes side by side (default, ayu, kanagawa, matrix, evergreen).

## Principles

1. **A group reads as one thing with a body.** One solid outline round the whole, the members faintly visible inside it. A set of items you merely selected keeps today's look (dashed box, every member outlined), so "I selected three things" and "this is a group" never look alike.
2. **Colour is never the only cue.** Selected is a solid line, hovered a lighter line, entered a dashed line with a name chip, locked a lock badge. Each also differs in weight or shape, so they hold up in Matrix and for colour-blind people.
3. **Theme variables only.** No literal colours; every token below is built from a variable that `src/themes.ts` already defines (`css-colors.test.ts` enforces this for CSS). The overlay lives in SVG, so the strings are `var(--wire)` and friends, as `GUIDE` already does in `render.ts`.
4. **Constant on screen.** Every length goes through `px()` (1 / zoom), as the other overlays do, so lines and handles keep their thickness at 11% and at 400%.
5. **Quiet.** Nothing animates except the 120 ms fade of the dim; under `prefers-reduced-motion` that is instant.

## Tokens

Defined once, on the board's root (`.chrome` or `:root`, wherever `--guide` is read), derived from the theme. Slice 2 puts them at the top of `src/ui/group-ui.css`.

```css
:root {
  --group-line:       var(--wire);                                       /* selected outline, handles' stroke, entered dashes */
  --group-member-line: var(--graphite);                                  /* high-contrast member outlines inside a selected group */
  --group-hover:      var(--guide);                                      /* hover outline, distinct from the selected wire outline */
  --group-handle:     var(--paper);                                      /* handle fill (today a literal #fff) */
  --group-dim:        color-mix(in srgb, var(--canvas) 62%, transparent);/* the board outside an entered group */
  --group-locked:     var(--graphite);                                   /* hover outline of a locked group */
  --group-chip-bg:    var(--tray);                                       /* name chip, Done chip, lock badge */
  --group-chip-ink:   var(--tray-text);
  --group-chip-line:  var(--tray-line);
}
```

Contrast of the group lines against each theme's canvas (non-text UI needs 3:1; WCAG 1.4.11): `--wire` is 4.0 in default, 9.0 in ayu, 5.9 in kanagawa, 11.0 in matrix, and 4.3 in evergreen; `--graphite` is 5.2, 5.2, 6.7, 6.4, and 5.2; `--guide` is 4.2, 6.6, 5.6, 6.6, and 4.2. Member outlines use `--graphite` and group hover uses `--guide`, so both clear 3:1 and hover remains distinct from selection. The chips use the tray pair (10.5 to 15.4:1).

**Not in slice 2: the single-item selection.** `render.ts` still draws a single item's selection outline and handles with the constant `WIRE = '#2F6FED'` and white handles, in every theme. Its hover outline now uses the same theme-aware `--group-hover` token as a group's hover. `--wire` is defined in all five themes and equals `#2F6FED` in default, so the group selection reads `var(--wire)` and `var(--group-handle)` and looks the same as a single-item selection there; in Ayu, Kanagawa, Matrix and Evergreen the group follows the theme while single-item selections keep the old blue until the follow-up below. That interim difference is accepted: copying the constant into the group tokens would bake the Matrix problem (a fixed blue on a green board) into the new feature.

## 1. Selected: item, several items, group

`selected.png`.

| | One item (as today) | Several items (as today) | A group (new) |
|---|---|---|---|
| Outline | 1.5 px solid `--group-line` round the item | dashed 1 px (5 4) box 6 px out, plus every member outlined 1.5 px solid | **solid 1.5 px** box 6 px out round the derived rectangle, members outlined **1 px in `--group-member-line`** |
| Handles | 8 squares, 9 px, 2 px radius, fill `--group-handle`, stroke 1.5 px `--group-line`; rotate circle 10 px above | corner and edge squares on the dashed box, no rotate | the same 8 squares and rotate circle on the solid box |
| Label | none | none | **name chip** at the outline's top-left, 6 px above it: `Group · 3` (the group's `name` once it has one, else "Group" and the member count), tray colours, 11 px, 600 weight, 20 px high, 4 px radius |

The chip is the one extra mark: it is what tells a group from a plain multiple selection at a glance, and it is where the name is read. It moves with the outline, hides while dragging or resizing (so it never trails behind), and is not drawn below 30% zoom, where the solid box already says "group". Nested: the chip shows the selected group's own name only.

On touch (`pointer: coarse`) handles are 16 px (as `render.ts` already does for a single item) and the chip stays 20 px high.

## 2. Hover over a member of an unselected group

`hover.png`.

Hovering any member outlines the **whole group** a click would select: 1.5 px solid `--group-hover` (`--guide`) round the derived rectangle, 6 px out, and nothing round the member itself. The guide color has at least 3:1 contrast in every theme and differs from the solid `--group-line` used for selection, so hover cannot be mistaken for selection. A single item uses the same theme-aware hover color. No chip on hover: it would flash as the pointer crosses a board, and the outline is enough to say what the click picks. While a dot vote runs the hover goes back to the single item, because a click votes for the item ([groups.md](groups.md), Selecting).

## 3. Inside a group

`inside.png`.

- **Dim**: everything outside the entered group is covered by a `--group-dim` wash (the canvas colour at 62%), drawn between the outside items and the group's members, so members stay fully lit and the rest recede but stay legible. This reuses the dimming that exists for a focused frame step (`docs/groups.md`, "Entered state"); only the colour token is new, which makes it follow the theme on dark boards.
- **Bounds**: 1.5 px **dashed** (6 4) `--group-line` round the group's rectangle, 6 px out. Dashed against the solid of selection is the second cue besides the dim.
- **Name chip** at the top-left, as in section 1, with the **path** when nested: `Header › Notes` (names joined by a right angle quote, truncated in the middle past about 28 characters, the full path in `title`/`aria-label`).
- **Done chip** at the top-right of the bounds, same line: `Done · Esc`. It is a button (tray colours, 20 px high on a pointer, **44 px on touch**, where there is no Esc to show, so it reads just `Done`). Clicking it, pressing Esc, or tapping empty canvas leaves one level.
- Nothing else changes: members select, move, and resize as normal items inside; the chips ride at the top of the bounds and stay on screen (clamped 8 px inside the viewport, under the top bars).

Esc moves the dim and chips to the parent group if there is one, so the breadcrumb loses its last part: that is the "one level at a time" rule drawn.

## 4. A locked group

`locked.png`.

Locked things are quiet in Tabula today: nothing marks them at rest, and the badge appears when the pointer is over one (`ov.lockedHover`). Groups keep that.

- **At rest**: no mark, as for any locked item.
- **Pointer over it**: outline 1.5 px solid `--group-locked` round the group's rectangle (graphite, not wire: it is *not* about to be selected, and a blue outline would promise that), and the lock badge at the top-right corner: a 22 px circle in tray colours with a 1.5 px `--group-chip-ink` ring and the lock glyph (`render.ts` draws it with literal `#18212B` and white; use `--group-chip-bg` and `--group-chip-ink`).
- The long-press unlock lifts to the outermost locked ancestor, so the badge and outline are those of the group, never of a member inside it.
- Locked **inside** an unlocked group (a member locked on its own): the hover badge shows on the member as today.

## 5. Group and Ungroup in the quick-action bar on touch

`touch.png`.

- **Group** shows when two or more items are selected at one level; **Ungroup** shows instead when exactly one group is selected. Never both.
- Each is an **icon plus a text label** (`qb-text` button): the two icons are not common enough to carry the meaning alone, and a label costs 70 px on a bar that scrolls (TAB-239). Height 44 px and min width 44 px, which `icon-btn` already gets on `pointer: coarse`.
- Position in the bar: right after the colour and text controls, before lock, duplicate and delete, with a separator on each side, so the destructive buttons stay together at the end.
- The mock shows Group in the `.on` (signal) state only to show where it sits. Do not ship it permanently highlighted; it is a normal button.
- Icons, on the 24 px grid, 2 px stroke, `currentColor` (the SVG is in `scripts/groups-visual-mock.mjs`): **Group** is four corner brackets round a small square; **Ungroup** is two separate squares joined by a dashed path. Slice 2 adds them to `src/ui/icons.ts` as `group` and `ungroup`.
- Keyboard users have the same buttons, in the same bar, in tab order after the text controls. `aria-label` "Group" and "Ungroup"; the chip's name chip is `aria-hidden` (the layers panel and the selection announcement carry the name).

## 6. Transforming a group: resize, rotate, and what the gesture says (slice 3)

`transform.png` (pointer) and `transform-touch.png` (touch). It fills the `TODO(slice 3)` in `render.ts`: the handles and the live chip of a selected group. Behaviour is in [groups.md](groups.md) (Resize, Rotate); this is how it looks.

**Handles.** The selected group's solid box (section 1) gets the same handles as a single item, built from the existing tokens: eight squares (corners and edge midpoints) 9 px with a 2 px radius, fill `--group-handle`, stroke 1.5 px `--group-line`, and the rotate circle 10 px across on a 1 px stem 24 px above the top edge. Every one scales the group **proportionally** (groups.md), so the edge handles do not stretch one axis: they differ from the corners only in where the anchor is. On touch (`pointer: coarse`) the squares are **16 px** and the circle 16 px, each with a 44 px hit area that never reaches into a neighbouring handle (on a small group the edge handles drop out, leaving the four corners and the rotate circle, so targets never overlap).

**During the gesture.**
- The members move live; the **solid box follows** (the new union, upright again after a rotate, as groups.md says) and the handles stay on it.
- A **ghost of where it was**: the old box as a 1 px dashed (4 4) line in `--group-line-soft`, so you see how far you went. Nothing else is drawn for the old state.
- A **live chip** (the tray chip of section 1, 11 px, tabular figures) says what the gesture is doing, and replaces the "Group · N" chip while the gesture runs (the name chip hides, as in section 1):
  - resize: `<width> × <height> · <scale>%` in world units, for example `253 × 163 · 125%`, placed 12 px below and left of the dragged corner so it is never under the pointer;
  - rotate: `<angle>°`, for example `20°`, placed 12 px right of and below the rotate circle; with Shift held it snaps to 15° and the chip adds nothing else;
  - at the floor of 24 units the chip reads `Smallest size` and the box stops: no colour change, the words are the signal.
- A dashed 1 px `--group-line-soft` ray from the group's centre to the rotate circle while turning, so the pivot is visible.
- The quick-action bar and the other chips hide during the gesture (as for a drag) and come back on release.

**On touch** the chip sits **at least 56 px above the finger** and moves further up when it would cover members or leave the viewport (it is clamped 8 px inside, under the top bars); it is never under the thumb. The rotate circle is 16 px; dragging it works from anywhere in its 44 px area.

**Theme and contrast.** Nothing new is drawn in a colour of its own: `--group-line` (handles, solid box), `--group-line-soft` (ghost and ray), the tray pair (chip). The 2 px canvas casing under the box (section 1) applies to the solid box here too.

**Not in this slice.** No numeric entry, no visible grid for snapping beyond the existing guides, no animation on release (the box simply is where it is).

**For the visual-check states** (developer): `group-resize` and `group-rotate`, each held mid-gesture (pointer down, moved, not released) at 1280 and, with touch, at 360 and 390 across the five themes; `group-resize-min` for the floor. They should read the chip text from the DOM or the overlay and fail if it is missing during a gesture, and fail if a handle's hit area (44 px on touch) overlaps another's.

## What changes in code (for slice 2)

| Where | Change |
|---|---|
| `src/ui/group-ui.css` (new) | the tokens above; `.group-chip`, `.group-done` (the Done chip as an HTML button over the board, positioned from the bounds like the quick bar); 44 px `.group-done` under `(pointer: coarse)` |
| `src/render.ts` | `WIRE` to `'var(--wire, #2F6FED)'` for outlines and handles; handle fill `var(--group-handle, #fff)`; group selection: solid box plus members at `--group-member-line` plus chip; hover: `--group-hover` on the group's rectangle; entered: dim wash between outside and members plus dashed bounds; locked hover: `--group-locked` and the tray-coloured badge |
| `src/ui/quickbar.ts`, `src/ui/icons.ts` | Group and Ungroup buttons and the two icons |
| `test/css-colors.test.ts` | no new allowlist entries: every colour here is a variable (the SVG strings in `render.ts` are outside that test, so add a small test that the group overlay contains no `#` literal) |
| `scripts/visual-check.mjs` | (slice 3 states are in section 6) states `group-selected`, `group-hover`, `group-entered`, `group-locked` (and the touch bar at 360 and 390), across the five themes |

## Open points

1. **Name chip at rest on selection** adds a second mark to a selection that otherwise shows only lines. If it feels busy on boards with many groups, show it only when the group has a name, and rely on the solid box alone otherwise.
2. **Dim strength** (62%) is the one value to judge on a real board: on Matrix the outside items almost vanish (which is probably right), on the light themes they stay readable.
## Follow-up (own change, own review, own changelog fragment)

**Move single-item selection to the theme variables.** In `render.ts`, `WIRE` becomes `'var(--wire, #2F6FED)'` for `outline()`, the hover outline, handles, the rotate stem and the connection anchors, and the handle fill `#fff` becomes `var(--group-handle, #fff)`. Single items then follow the theme like groups do; in default nothing changes, and in the dark themes the selection turns from `#2F6FED` to the theme's `--wire` (contrast against the canvas goes up: 9.0 in Ayu, 11.0 in Matrix). Needs the five-theme visual check of `board-selected`, and a glance from Johan, since it is a visible change unrelated to groups.
