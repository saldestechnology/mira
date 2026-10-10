# Rich text: UX (popover, keys, lists, phones, look)

Status: draft for Johan; the open points with the tech lead are settled (their `docs/rich-text.md` §18 reconciles this file, commit 4da81b2). Companion to the architecture spec, `docs/rich-text.md` (tech lead). It uses that spec's command names (`toggle-mark`, `set-alignment`, `set-list`, state `on | off | mixed`) and its shortcut hooks; where this file proposes something different it says so. To be appended to, or linked from, `docs/rich-text.md` as its UX section.

Scope: the formatting controls for text elements: bold, italic, underline, strikethrough; bullet and numbered lists; align left, centre, right. Nothing here changes what a text element is. Typography choices (font, size, colour) stay object-level, as in the architecture spec's recommendation.

## 1. Principles

1. **Formatting follows the selection, never the mouse.** Pressing a control never moves the caret or loses the selection; the popover is a remote control for the text the person is already editing.
2. **Every control has a key, every key has a control.** The popover is a discoverable list of the shortcuts, not a second way of working.
3. **One undo step per command**, as the architecture spec requires. The popover never adds steps of its own (opening, moving, closing).
4. **Quiet.** It appears when editing starts, stays out of the way of the text and the handles, and goes when editing ends.

## 2. The popover

### 2.1 When it shows

- Shown while a text element is in edit mode (the textarea/overlay is active), from the first moment, with a collapsed caret: so people find it without selecting first. Pressed states show the formatting at the caret (the pending typing mark).
- Hidden when editing ends (Esc, click outside, commit), when the object is locked or the board is read-only (no disabled popover: nothing to offer), and while a drag or resize is in progress.
- Not shown for a selected-but-not-editing text (selection uses the existing quick-action bar). Double-click, Enter or typing starts editing and shows it.
- Stickies and shapes get the same popover when the architecture spec enables rich text there (its open question 1); the layout does not change.

### 2.2 Where

- **Above the text element**, centred on the element's top edge, 12 px clear of the element's top selection handles (the popover never covers a handle). Horizontally clamped to the viewport with 8 px margins and to the safe area; if the element is wider than the popover it still centres on the element, not on the selection.
- **If there is no room above** (element near the top of the viewport, under the top bars) it goes **below** the element, again clear of the bottom handles. If neither fits (a very tall element filling the view) it **pins to the top of the visible canvas**, under the top bars, so it is never off screen. The existing `placePopover` logic in `src/ui/popover-layout.ts` and `visibleHeight()` (visual viewport) are used; nothing new is invented.
- It follows the element while the camera pans or zooms (re-placed on each frame, no animation), but **does not scale with zoom**: the controls stay 44 px on touch and 32 px with a mouse at any zoom.
- Pointer-events: the popover swallows pointerdown so the canvas never sees it, and holds the editor's blur (the same `holdBlur` mechanism the emoji bar uses), so a click on a control does not commit and close the edit.
- It does not overlap the **emoji bar** (`Add emoji`): that bar sits below the element; on a text element the emoji button joins the popover as its last control and the separate bar is not shown for text (one fewer thing on screen). Agreed with the tech lead.

### 2.3 Layout

One row, ink tray (the board's `--tray` chrome so it reads as part of the tool, not content), a 12 px radius, 1 px `--tray-line` hairline border, no shadow beyond the existing popover shadow. Controls are grouped by hairline dividers; individual controls use an 8 px radius:

```
┌────────────────────────────────────────────────────────┐
│  B   I   U   S  │  •≡   1≡  │  ≡L   ≡C   ≡R  │  ☺      │
└────────────────────────────────────────────────────────┘
   marks              lists        alignment        emoji
```

- **Marks**: Bold (B, set in a bold face), Italic (I, italic), Underline (U, underlined), Strikethrough (S, struck). The letter glyphs are drawn in the control itself in the UI font so each previews its own effect. These are the only letters in the row; the rest are icons.
- **Lists**: Bullet list, Numbered list. Icons: three short lines each with a dot or a numeral at the left.
- **Alignment**: Left, Centre, Right. Icons: lines with the matching flush edge. Exactly one of the three is on (or none, when mixed).
- **Emoji**: opens the existing picker (src/ui/emoji-picker.ts).
- Control size: 32 × 32 with a mouse, **44 × 44 on touch** (coarse pointer or width ≤ 860 px, as elsewhere), icon 20 px, 2 px stroke, square caps, matching the board's icon set. Gaps 2 px; dividers 1 px with 6 px margin.
- Tooltips (`data-tip`, not native `title`) show the name and shortcut: "Bold, Cmd+B" (Ctrl on Windows and Linux, resolved once).

### 2.4 States

| State | Look | Semantics |
|---|---|---|
| Off | Icon in `--tray-text` on the tray | `aria-pressed="false"` |
| On | Icon in `--on-signal` on a `--signal` fill (the board's active-tool treatment) | `aria-pressed="true"` |
| Mixed (selection partly formatted) | Outlined in `--signal`, with a short horizontal bar replacing the fill; the accessible name adds ", mixed" | `aria-pressed="mixed"` and a live-region note "mixed formatting" when the selection changes into mixed |
| Hover (mouse) | `--tray-hover` background | none |
| Focus | 2 px `--signal` outline, 2 px offset, always | native focus |
| Disabled | Not used (the popover is hidden when nothing can be edited) | n/a |

State never relies on colour alone: on is a fill **and** a pressed attribute; mixed is a bar and the word in the name.

List and alignment pairs behave as radios in one group each, but are plain buttons (`aria-pressed`) so a second press clears (list) or is a no-op (alignment on the only active one), per the architecture spec ("selecting a list button when all paragraphs already have that kind removes it").

### 2.5 Behaviour

- Pressing a control: runs the command on the selection captured **before** focus moved (the architecture spec's rule), then returns focus and the selection to the editor in the same frame. The caret and selection are visually unchanged.
- With a **collapsed caret**, a mark control sets the **pending typing mark** (the next typed characters get it) and shows pressed; moving the caret clears the pending mark to the formatting at the new position. List and alignment apply to the **paragraph** containing the caret.
- With a **selection**, marks apply to the selected characters; lists and alignment apply to every paragraph the selection touches.
- A command that changes nothing (the selection is already bold and Bold is pressed on a bold selection: that toggles it off; alignment already centre) is still a valid press and announces the result.
- The popover state refreshes on selection change, input and undo/redo, using the architecture spec's `getRichTextState` snapshot (no polling).
- A **live region** announces results, not typing: "Bold on", "Bullet list", "Aligned centre", "Mixed formatting".

## 3. Keyboard

The shortcuts are the architecture spec's hooks (the only change is noted below). They work whenever the editor has focus, whether or not the popover is visible, and they call the same command functions as the buttons.

| Keys (Cmd on macOS, Ctrl elsewhere) | Command |
|---|---|
| `Cmd+B` | Bold |
| `Cmd+I` | Italic |
| `Cmd+U` | Underline |
| `Cmd+Shift+X` | Strikethrough |
| `Cmd+Shift+8` | Bullet list |
| `Cmd+Shift+7` | Numbered list |
| `Cmd+Shift+L` / `E` / `R` | Align left / centre / right |
| `Cmd+Z`, `Cmd+Shift+Z` | Undo / redo (one command or one typing burst per step) |
| `Esc` | Close an open picker, else end editing (commits) |
| `Tab`, `Shift+Tab` | Move focus into and out of the popover (see below) |

- **Board shortcuts never fire** while the editor or popover has focus (the architecture spec's rule); the text editor's keydown already stops propagation, the popover does the same.
- **Reaching the popover from the keyboard**: `Tab` from the editor moves focus to the first control (Bold); arrows move along the row (roving tabindex, `Home`/`End` to the ends), `Space`/`Enter` press, `Tab` again leaves to the next focusable thing (the emoji control is last in the row), `Shift+Tab` or `Esc` returns to the editor with the selection restored. This **changes the editor's current "Tab commits"** behaviour to "Tab goes to the controls; Esc commits": proposed because a keyboard-only user otherwise cannot reach the controls at all. Agreed with the tech lead (section 9).
- Chord conflicts: `Cmd+Shift+L/E/R` and `Cmd+Shift+7/8` can be taken by a browser or OS (the architecture spec marks this OPEN). They are checked on macOS Safari/Chrome/Firefox and Windows Chrome/Edge/Firefox before the freeze; where a chord is taken the control still works and the tooltip shows only the shortcuts that actually work on that platform.

## 4. Lists

Lists are paragraph attributes, depth 1 in v1 (no nesting; the architecture spec's recommendation), shown in the editor and on the canvas with a marker and a hanging indent so wrapped lines align under the text, not the marker. Bullets use a filled disc; numbers count from 1 per contiguous run of numbered paragraphs, restarting after a non-numbered paragraph.

| Key | In a list item | Result |
|---|---|---|
| `Enter` | caret in a non-empty item | Splits the paragraph; the new item keeps the list kind and the paragraph's alignment. |
| `Enter` | caret in an **empty** item | **Leaves the list**: the item becomes a normal paragraph (marker removed). Pressing Enter on an empty last item twice is therefore "finish the list". |
| `Backspace` | caret at the **start** of an item | **Removes the marker** and keeps the text (the item becomes a normal paragraph); it does not merge into the previous item. A second `Backspace` then merges with the paragraph above as usual. |
| `Backspace` | elsewhere | Normal deletion. |
| `Delete` | at the end of an item | Merges the next paragraph into this one (keeps this item's list kind). |
| `Tab` | in an item | Not an indent in v1 (no nesting): it moves focus to the popover as in section 3. Indent and outdent (`Tab`/`Shift+Tab`, or `Cmd+]`/`Cmd+[`) are reserved for when nesting is added. |
| `Shift+Enter` | in an item | Same as `Enter`: there is no soft line break in v1 (every newline is a paragraph, decided with the tech lead), so it starts a new item. A soft break is a follow-up. |
| Typing `- `, `* ` or `1. ` | at an empty paragraph | Starts a bullet or numbered list and removes the typed characters. One undo restores the literal characters (the architecture spec's open question 5). Not applied to pasted or remote text. |
| Toggle (button or `Cmd+Shift+8/7`) | selection across several paragraphs | All touched paragraphs become that list kind; if all already are, all are cleared; mixed kinds become the pressed kind. |

Pasted text with line breaks is **not** turned into a list (paste creates plain paragraphs; see `docs/rich-text.md` section 10).

## 5. Phones and touch

- Controls are **44 × 44**. A single row of 9 controls plus dividers is about 410 px, wider than a 360 or 390 px screen, so under **600 px** wide the popover is **two rows**: row 1 marks and lists (Bold, Italic, Underline, Strike, Bullet, Numbered, 6 × 44 = 264 px), row 2 alignment and emoji (Left, Centre, Right, Emoji). The grouping and dividers are kept; nothing scrolls sideways.
- **Soft keyboard**: the popover is placed against the **visual viewport**, not the layout viewport (the same approach as the emoji picker): above the element if it fits between the top bars and the keyboard; otherwise it **docks just above the keyboard**, full width with 8 px margins. It never sits under the keyboard and never covers the line being typed (the editor keeps the caret in view above the dock).
- **Selection on touch**: the native selection handles and the system's own cut/copy/paste callout sit on the selected text; the popover is placed away from the selection (above the element, or docked), so the two never overlap. If the system callout would cover the popover it is the callout that wins for a moment, because the popover is not at the selection, only at the element.
- **No hover**: pressed states and the tooltip text are carried by the accessible name; tooltips are not relied on. A long-press on a control shows its name and shortcut (not needed on touch, kept for hardware keyboards on iPad).
- **Tap behaviour**: tapping a control must not dismiss the keyboard or move the caret (the blur is held, as for the emoji bar). On iOS, pointerdown is not `preventDefault`-ed for touch (WebKit drops the click of a cancelled touch tap); focus is kept with the held blur and a refocus on release, as the emoji bar does.
- **Pinch and pan** with two fingers on the canvas while editing move the camera and the popover follows; a one-finger drag outside the popover and element ends editing only on a tap (not a drag).
- Landscape phone (about 700 px wide, 320 px high): one row if it fits, else two; docked above the keyboard; the visible canvas may be only a few lines, so the popover is the only chrome in view.

## 6. The Swiss look

- **Surface**: the tray colour of the board's own chrome (`--tray`, `--tray-text`, `--tray-line`, `--signal`, `--on-signal`), so it is correct on every theme (Default, Ayu, Kanagawa, Matrix, Evergreen, light and dark) with no colours of its own. Never white on black hard-coded; never a drop-shadow tint.
- **Geometry**: an 8 px control radius inside a 12 px popover (the chrome uses the shared UI radius tokens), an 8 px grid (32 px controls, 2 px gaps, 6 px divider margins, 12 px clear of the element), 1 px hairlines. The edited board text keeps its own geometry.
- **Icons**: the board's icon set (20 px, 2 px stroke, square caps), plus the four letter controls in Instrument Sans: **B** in 700, *I* italic, U underlined and S struck, so the control shows the effect. No Bodoni (the brand rule: no Bodoni under 17 px), no emoji as icons.
- **Colour**: one accent, the board's signal colour, for "on". No red, no cobalt in this popover; the text colour of the text element is never changed by it.
- **Motion**: none (appears and disappears in place; follows the element without easing). Under `prefers-reduced-motion` nothing differs.
- **Text on the canvas**: underline and strikethrough are drawn as real decorations (one-colour rules in the text colour), a bullet is a filled disc in the text colour, numbers are tabular figures, hanging indent is a fixed 1.5 em. They render the same in the SVG canvas, in PNG export and in the editing overlay (the architecture spec's rendering rule).

## 7. Accessibility

Follows the architecture spec's section 12. In addition:

- The popover is `role="toolbar"` with `aria-label="Text formatting"` and `aria-orientation="horizontal"`, arrows move within it (roving tabindex), and it is the only focusable thing between the editor and the next element in tab order while editing.
- Every control has a stable accessible name ("Bold", "Italic", "Underline", "Strikethrough", "Bullet list", "Numbered list", "Align left", "Align centre", "Align right", "Add emoji"), `aria-pressed` and `aria-keyshortcuts`.
- Contrast: icons against the tray are at least 3:1 and the pressed state (on-signal on signal) at least 4.5:1 in every theme; this is a visual check across the five themes at 360, 390 and 1280, like the UML arrows check.
- Touch targets 44 px, focus ring always visible, forced colours: pressed is also an outline and a heavier border.

## 8. Tests and visual checks (for the build)

- Unit: placement (above, below, pinned, clamped, soft-keyboard dock), state mapping (on / off / mixed from `RichTextState`), list key rules (Enter, Enter on empty, Backspace at start, Tab not indenting), pending marks at a collapsed caret, one undo step per command.
- Visual states (Chromium, WebKit, Firefox at 360, 390, 1280; five themes for contrast): popover over a text element, over one near the top (flips below), pressed and mixed states, two-row phone layout, docked above the keyboard (the `emojiKeyboard` Proxy helper), list editing sequence.
- Keyboard-only run: reach the popover with Tab, press every control, return with Esc, undo each.

## Decisions (frozen)

Johan: "go with your picks". The tech lead's full list of 13 is in `docs/rich-text.md` (8704561); these are the ones that decide the UX. The rest (plain MCP writes flatten with a warning, selections shown only to co-editors, 20,000 / 4,000 character limits, relay client-version floor) have no screen of their own.

| Decision | UX effect |
|---|---|
| Text elements first | The popover shows only on text elements in v1. Stickies, shapes and card text get it in a later slice with the same layout. |
| No nesting | Lists are one level. `Tab` is not an indent. |
| No fonts, sizes or colours per run | The popover has no font, size or colour control; the only controls are B, I, U, S, bullets, numbers, left, centre, right, emoji. |
| No links | No link control and no `Cmd+K` inside text. Pasted links keep their text and lose the address. |
| `- ` and `1. ` start a list | Typing them at an empty paragraph starts a bullet or numbered list. One undo restores the typed characters. Not applied to pasted or remote text. |
| `Tab` goes to the popover | `Tab` from the editor moves into the popover, `Esc` returns to the editor, `Alt+F10` is the fallback. Applies only to objects that have the popover. |
| No soft break | `Shift+Enter` acts like `Enter`; every newline is a paragraph. |
| Emoji last | The emoji button is the last control in the popover; the separate "Add emoji" bar is not shown for text elements. |
| Strikethrough | `Cmd/Ctrl+Shift+X`. |
| Alignment with no selection in the text (frozen #9) | The existing alignment control in the properties panel and quick-action bar, used while the text element is selected but not being edited, aligns **all** paragraphs and updates the object's default alignment in one transaction. Inside the editor, the popover's alignment still applies to the paragraphs touched by the caret or selection (section 2.5). |
| Mixed state | `aria-pressed="mixed"` with a bar in the control. |

## Settled with the tech lead, and what was open

Settled with the tech lead:
- **Tab** moves focus into the popover and `Esc` returns to the editor (a change from "Tab commits", only for rich-capable objects). `Alt+F10` is the fallback if testing finds Tab-in disruptive.
- **No soft line break** in v1; `Shift+Enter` acts like `Enter`.
- **Emoji** is the last control of the popover on text elements.
- **Mixed** is `aria-pressed="mixed"`.
- **List keys** and the **phone** layout as written above.

Closed by the decisions above: elements first, auto-format, strikethrough chord. Nothing is open for Johan in this file.
