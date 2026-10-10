# AI toolbar

The floating bar where a person asks the AI to work on the board: summarise it, cluster stickies, generate ideas. It is the front door to the features in `docs/ai.md`; it adds no new AI capability.

Status: shipped as part of the normal board (TAB-123, TAB-141). The bar appears when AI is enabled for the person and a workspace key, an allowed personal key or plan credits are available. An interactive static mock lives in `design/ai-toolbar/index.html` (open it from the dev server at `/design/ai-toolbar/`, or as a file). The mock calls no model; every result is faked. Screenshots of every state are in the review folder, named `<state>-<theme>[-390].png`.

Read `docs/ai.md` first. This document only covers the bar: how it looks, where it sits, what it does in each state, and the words it uses. Calls, keys, proposals, limits and errors come from there.

## Summary

- **A dark tray, like the quick bar and the session bar.** Same tokens, same radius, same shadow. It belongs to the board chrome, not to the app pages.
- **Docked bottom centre, expanded the first time**, collapsible to a 40px spark button, draggable on desktop. Collapse and position are remembered per person in this browser.
- **Context first.** A context button on the left says what the AI will work on (the selection, the visible area, the whole board, or nothing but the prompt). A line under the bar says what will be sent to the provider and which key pays.
- **Three actions in v1**, as chips: Summarise, Cluster, Generate ideas. A chip arms its action and shows the cost; Run or Enter starts it. A free-text prompt runs Generate. The other chips in the Linear spec are not built, so they are not shown (see "Chips").
- **The single entry point.** The Generate, Summarise and Cluster items elsewhere in the app open this bar with their action armed (see "Entry points").
- **Nothing touches the board until the person says so.** A run produces a preview on the canvas (ghosts), and the bar offers Discard, Retry and Add to board. Add is one undo step.
- **Absent for people who cannot apply a result** (viewers, commenters), when AI is off for the person, or when no workspace key, allowed personal key or plan credits are available.
- **Multiplayer.** Others see a run in flight and its preview in the runner's colour; any editor can accept or discard it, and the first action wins. A personal key can run privately. See "Multiplayer (TAB-141)".

## Where it appears

| Who | AI enabled for this person and a key or plan credits are available | The bar |
| --- | --- | --- |
| Owner, admin, editor, guest with edit rights | yes | Shown |
| Viewer, commenter | yes | Not rendered. The shortcut does nothing. No menu item. |
| Owner, admin, member or guest | no | Not rendered. No AI menu item, banner, badge or nag. Setup is in Admin → AI. |

The rule matches `docs/ai.md`: the app mounts the bar only when `enabled` is true and `keySource` names a usable workspace or personal key, or `credits` is true. The server's `credits` capability is false until phase 2. A role change mid-session removes the bar (and closes any open preview) without a reload. The relay re-checks on every run, so hiding the bar is a convenience, not the gate. In open mode, the relay reports AI enabled only when its operator key and open-mode setting are both present.

## Anatomy

One tray, three rows. Row 2 comes first in the document and in the tab order; CSS places the chips above it.

```
+--------------------------------------------------------------------------+
| (Summarise) (Cluster) (Generate ideas)                       row 1: chips |
| ::  [3 stickies v] [ Generate sticky notes about... (clock) ] Opus 5.5 - ~1.3k|
|                                                    tokens  [ Run ]  [ - ] |
|--------------------------------------------------------------------------|
| Sends 3 selected stickies to Anthropic  -  Uses the workspace key         |
+--------------------------------------------------------------------------+
   grip   context   prompt + history       model chip        Run  collapse
```

| Part | Spec |
| --- | --- |
| Tray | `.tray`: `background: var(--tray)`, `color: var(--tray-text)`, `border-radius: var(--radius)`, `box-shadow: var(--shadow)`, plus the 1px `--tray-line` outline the other trays get on non-default themes. `overflow: hidden` so the progress rule and corners clip. Width `min(640px, 100%)` of the dock. Padding 0; rows own their padding (8px). |
| Row 1, chips | Horizontally scrollable, no scrollbar. Each chip is the app's `.chip`: 28px high, 4px radius, `color-mix(in srgb, var(--tray-text) 6%, transparent)` fill, 12.5px/500. Gap 6px. Padding 8px 8px 0. |
| Row 2 | 8px padding, 8px gaps, min height 52px. Controls 36px high. |
| Grip | 20px wide, six-dot glyph in `--tray-muted`, `cursor: grab`. Desktop only. |
| Context button | 36px, 1px `--tray-line` border, 8px radius, 12.5px/600, label plus a 14px chevron. Opens a menu. |
| Prompt | The app's `.input` look: 36px, 8px radius, 1px `--tray-line` border, 6% `--tray-text` fill, 13px. Focus: border `var(--signal)`. Placeholder `--tray-muted`. A 32px history icon button sits inside its right end. |
| Model chip | Text button, 12px/500, `--tray-muted`, hover `--tray-hover` with `--tray-text`. Opens a small popover (see "Cost and model"). |
| Run | `.btn.primary`: `var(--signal)` fill, `var(--on-signal)` text, 36px, 600. |
| Collapse | `.icon-btn`, 36px, a minus glyph on desktop, a down chevron on phones. |
| Disclosure | Row 3. 11px/16px, `--tray-muted`, 1px `--tray-line` rule above, padding 6px 12px 8px. Two segments separated by a centred dot: what is sent, then who pays. |
| Progress rule | 2px, along the tray's bottom edge, `var(--signal)`, only while running. |

Swiss rules applied: hairlines instead of boxes, one accent colour, no icons in the chips, no gradients, text sizes from the app's own set (13px controls, 12.5px chips, 11px disclosure), spacing on 8px. Chips use the 4px radius, buttons 8px, and the bar and popovers 12px. Trays keep their 1px `--tray-line` hairline; no added shadows. Avatars stay round, and the bar follows the shared UI chrome tokens.

### Chips

| Chip | Needs | Disabled tooltip |
| --- | --- | --- |
| Summarise | At least 2 stickies in the context (selection, visible area or whole board) | Context "Prompt only": "Choose what to summarise: a selection, the visible area or the whole board". Selection of 1: "Select 2 or more stickies to summarise" |
| Cluster | A selection of 2 to 200 stickies (`docs/ai.md`: "the selected stickies (2..200)") | "Select 2 or more stickies to cluster" (also when the context is not a selection); "Select 200 stickies or fewer to cluster" |
| Generate ideas | A typed prompt to run (arming it needs nothing) | (never disabled) |

A disabled chip uses `aria-disabled="true"` and stays focusable, so the tooltip (the shared tooltip, `src/ui/tooltip.ts`) explains why on hover and on keyboard focus. Disabled chips are drawn at 40% opacity like every disabled control in the app.

**A chip arms its action; it does not run it.** Decided (Johan, 2026-10-09). Clicking an enabled chip selects it:

- The chip turns solid, like the app's `.chip.on` (`--tray-text` fill, `--tray` text), and gets `aria-pressed="true"`. Only one chip is armed at a time; clicking it again, or Esc in idle, disarms it.
- The model chip names the action and its estimate in `--tray-text` at 600: "Summarise · ~1.3k tokens", or with a credit key "Summarise · ~4 credits · 1,240 left". On phones the same text is the underlined estimate in the disclosure line.
- Focus moves to the prompt. For Summarise and Cluster the placeholder becomes "Optional instruction…", so the person can add one ("as action items") before running; an empty prompt is fine.
- Run (or Enter in the prompt) starts the armed action. Run's tooltip names it ("Summarise" + "Enter").
- Generate ideas armed still needs a prompt; until one is typed Run stays disabled.
- If the context changes so the armed action is no longer available (a Cluster selection drops to one sticky), it disarms.
- After Add to board the chip disarms; after Discard, Stop or an error it stays armed, so Retry and a second try keep the choice.

Spending tokens or credits always takes a second, deliberate step, and the estimate for exactly that action is on screen when it is taken.

**Only the three v1 chips are shown.** The Linear spec lists eight: Mind map, Rewrite, Table, Slides and Translate as well. `docs/ai.md` puts text-to-diagram (Mind map) under "Next, not v1" and mentions neither Rewrite nor Translate; Table and Slides are separate tickets (TAB-121, TAB-104). A row where five of eight chips are permanently dead is clutter, and the Linear spec says the bar must never nag. The chip row is a list in code (`id`, label, `needs`, `run`), so a feature adds a chip by adding an entry, in this order: Summarise, Cluster, Generate ideas, Mind map, Rewrite, Table, Slides, Translate. The reviewer panel in the mock has a "Chips: planned set (8)" switch that shows all eight with the last five disabled ("Coming soon") so the scrolling row can be judged; that is for review only.

### Prompt

- Placeholder: "Generate sticky notes about…" (Decided (Johan, 2026-10-09)). It says what free text does in v1. With Summarise or Cluster armed: "Optional instruction…".
- Enter runs the armed action, else Generate. Shift+Enter is not needed: the prompt is one line (it scrolls horizontally). Prompts longer than the box are fine; the cap is the relay's input limit.
- **A typed prompt runs Generate stickies** (`docs/ai.md`: "a prompt, optional count 1..30"). The bar does not guess whether "summarise the retro" means Summarise; v1 has no free-form assistant; the placeholder says so (open question 5, decided).
- Up and Down in an **empty** prompt walk the history, newest first; the first Up fills the newest entry. Down past the newest empties it again. Typing leaves history mode.
- The history button (clock) opens a list of the last 6 prompts; choosing one fills the prompt.
- History is per person, local, newest first, capped at 20, de-duplicated. It is never sent anywhere except as part of a run, and it is not stored in the board.
- Run is disabled (`aria-disabled`) while nothing would run (no action armed and an empty prompt, or Generate armed with an empty prompt); its tooltip then reads "Type what to generate, or pick an action above".

### Context

The context button says what the run will read.

| Label | Meaning | Count shown in the menu |
| --- | --- | --- |
| "3 stickies" / "1 sticky" | The selection | The count |
| "Visible area" | Everything in the viewport | "23 stickies" |
| "Whole board" | Everything on the board | "42 stickies" |
| "Prompt only" | No board content; only the typed prompt is sent | "No board content" |

Defaults: with a selection, the selection; with nothing selected, **Visible area**. Selecting something switches the context to the selection; clearing the selection switches a "Selection" context to Visible area. A choice the person made in the menu sticks until the selection changes. "Selection" is disabled in the menu when nothing is selected ("Nothing selected").

`docs/ai.md` also lets a feature run on a frame, and Summarise has a `summary` or `retro` type. Neither is in the context button. A frame can be selected like any object, so it falls under "Selection" (its stickies). The `retro` type stays in the session bar, after Finish. See open question 6.

Counts are stickies in the mock because the v1 features read stickies. When the selection holds other objects the label says "3 items".

### Disclosure line (row 3)

Always visible, in every state. It says what leaves the instance and who pays.

| Context | First segment |
| --- | --- |
| Selection | "Sends 3 selected stickies to Anthropic" |
| Visible area | "Sends the 23 stickies in view to Anthropic" |
| Whole board | "Sends all 42 stickies to Anthropic" |
| Prompt only | "Sends only your prompt to Anthropic" (empty prompt: "Sends only what you type to Anthropic") |
| Any, with a prompt typed | "…and your prompt" is added before "to Anthropic", except Prompt only |

| Key source (`keySource`) | Second segment |
| --- | --- |
| `workspace` | "Uses the workspace key" |
| `user` | "Uses your key" |
| no key source, with `credits: true` | "Uses AI credits" |
| no key source, without credits | "No AI key set" (the bar is hidden in this state) |

Private notes are never sent (`docs/ai.md`); the line does not repeat that. When the relay will cut content (400 objects, 60,000 characters), the count in the line is the capped count: "Sends the 400 stickies nearest the selection to Anthropic". The mock does not show the cut case.

While running, the second segment becomes "Esc stops" (the key source is still in the model popover). In preview it is replaced by the preview text (see "Preview").

### Cost and model

The model chip shows an estimate before the run. When a chip is armed it names the action instead of the model (see "Chips"):

- Own key or workspace key: "Opus 5.5 · ~1.3k tokens". The model is the workspace's choice (`docs/ai.md`: the admin picks one per workspace), so it is information, not a control.
- Credits (phase 2): "~4 credits · 1,240 left". The model is dropped from the chip to keep it short; the popover has it.

The estimate is input tokens: about 1,000 for the frozen system prompt plus about 100 per sticky plus the typed prompt divided by four. Credits use the price table in `docs/ai.md` and an expected output of about 1,200 tokens. These are guesses made in the browser from what it is about to send; the number carries a "~". The real figure comes from the run's usage row afterwards.

The chip opens a non-modal popover (`role="dialog"`):

- **Model**: "Claude Opus 5.5", "Chosen by your workspace admin." (admins also get an "AI settings" link).
- **This run**: "About 1,300 tokens go in; the reply is capped at 4,000. That is roughly 3 credits of 1,240 left this month. An estimate, not a bill." (the credits sentence only with credits).

On phones the chip moves into the disclosure line as an underlined text button, and the popover opens from there.

## Entry points

Decided (Johan, 2026-10-09): **the bar is the single entry point for AI.** The items `docs/ai.md` lists elsewhere do not run anything themselves. Each one opens the bar (expanding it if collapsed), sets the context, arms its action and focuses the prompt, so every run goes through one place that shows the context, the estimate and the preview controls.

| Item | Opens the bar with |
| --- | --- |
| **Generate** in the sticky tray, and on the empty-board hint | Generate ideas armed; context "Prompt only" on an empty board, else as the defaults say; focus in the prompt ("Generate sticky notes about…") |
| **Summarise** in the board menu | Summarise armed; context "Whole board" |
| **Summarise** in the session bar after Finish | Summarise armed; context "Whole board" (the retro type, open question 6) |
| **Cluster** in the selection quick bar | Cluster armed; context the selection |

These items are hidden whenever the bar is (viewers, commenters, AI off). They never start a run; the person still presses Run or Enter. The mock simulates the first three with the State control: "Opened from board menu: Summarise armed", "Opened from sticky tray: Generate armed", "Opened from quick bar: Cluster armed".

## States

`data-ui` on the bar takes one of `idle`, `running`, `preview`, `error`; collapsed is a separate flag.

| State | Row 1 chips | Row 2 | Row 3 | Focus |
| --- | --- | --- | --- | --- |
| **Idle** | Live | Context button, prompt (+ history), model chip, Run, collapse | Sends… · key | Prompt, when opened by the shortcut or the button |
| **Armed** (idle with a chip selected) | The armed chip solid | Context button, prompt ("Optional instruction…"), model chip naming the action and its estimate, Run enabled, collapse | Sends… · key | Prompt |
| **Collapsed** | – | A 40px tray button with a spark glyph | – | The button, after collapsing |
| **Running** | Dimmed to 40%, not clickable | Status line replaces the prompt: "Summarising 42 stickies…". Context button dimmed (on phones it is hidden to give the status room). Model chip stays. **Stop** replaces Run. Collapse is disabled. | Sends… · "Esc stops". Progress rule along the bottom edge. | Stays on Stop |
| **Preview** | Dimmed | Summary line ("6 stickies in a new frame “Summary”"), then **Discard** (ghost), **Retry**, **Add to board** (primary). No context button, no model chip. Collapse is disabled. | "Nothing is on the board until you add it · Enter adds, Esc discards" | **Add to board** |
| **Error** | Live | Icon and message in the tray red, then the action that helps, then a dismiss ✕. No context button, no model chip. | Sends… · key | Stays where it was; the message is announced |

The chips stay in place (dimmed) while running and previewing so the bar does not change height as it changes state.

### Running

- Status text from the feature and context: "Summarising 42 stickies…", "Clustering 12 stickies…", "Generating ideas…". There is no partial text; the relay sends `progress` events and one `result`, so the bar cannot show the model's words arriving.
- The rule is a 30%-wide `--signal` segment sliding left to right, 1.4s, linear, looping. Under `prefers-reduced-motion` it is a static full-width `--signal` line; the text alone says it is working.
- Stop aborts the request (closing the stream, as `docs/ai.md` describes) and returns to idle with the prompt kept and focus in the prompt. Esc does the same.
- One run per person at a time: Run and the chips are inert while running.

### Preview

The proposal is drawn on the canvas, not in the bar.

- **Create** (`kind: 'create'`): each proposed sticky keeps its true colour (no opacity: translucent stickies turn muddy on the dark canvases) and has no shadow; a 1.5px dashed edge of `color-mix(in srgb, var(--canvas-ink) 55%, transparent)` inside its border marks it as not yet on the board. A 2px dashed outline in the same colour surrounds the whole proposal area, over a faint `color-mix(in srgb, var(--signal) 8%, transparent)` wash. The outline is 3.3:1 to 4.9:1 against the canvas in all five themes (Evergreen lowest, Matrix highest); `--signal` alone was 1.27:1 on Default. A "Preview" label sits on the outline's top-left corner: `--signal` fill, `--on-signal` text, 11px/600 uppercase, 0.08em tracking. If the proposal names a frame, the ghost frame's title is part of the preview and the summary line says so.
- **Group** (`kind: 'group'`): ghost column headers (the group titles, 13px/700, underlined by a 2px dashed `--canvas-ink` rule that turns solid on Add) over ghost copies of the stickies in their new columns, plus faint arrows (1.25px, `--canvas-ink` at 32%) from each original sticky, drawn under the stickies, to its group's header. The originals stay solid and in place until Add. The summary line reads "Moves 9 stickies into 3 groups".
- The app lays objects out itself, at `nextFree` (`docs/ai.md`); the preview uses the same layout the add will, so what is previewed is what is added.
- If the proposal is not fully visible, the viewport pans and zooms to fit the proposal area above the bar (not in the mock; the mock places proposals where they show). See open question 11.
- **Add to board** (Enter) writes the proposal as one undo step (`store.transact`) and returns to idle with the prompt cleared. A toast says "Added 6 stickies." with an **Undo** button (tooltip "Undo", chip "Ctrl/Cmd+Z"); for a group it says "Moved 9 stickies into 3 groups." The toast stays 8 seconds because it carries an action. Keyboard activation of Add returns focus to the prompt; pointer activation leaves focus alone (no on-screen keyboard on phones).
- **Discard** (Esc) writes nothing and returns to idle with the prompt kept.
- **Retry** runs the same feature again on the same context and replaces the preview.
- If the board changed under the preview so the proposal is no longer valid (a sticky it names was deleted), Add fails without writing and the bar shows an error: "The board changed while you were looking. Run it again." with Retry. This message is specified but not in the mock.

### Errors

Errors replace the status line in place. Each has a red icon and message, then one action that helps, then a dismiss ✕ (Esc does the same). The text colour is `color-mix(in srgb, var(--danger) 54%, var(--tray-text))`, the red the app already uses on trays. The message container is `role="alert"`. The bar never shows a code, a stack, a key or a provider's raw response; for hosted credits proxy errors it shows the relay's `message` verbatim, with a short default when it is missing.

| Condition (`docs/ai.md`) | Message | Action |
| --- | --- | --- |
| No key (`ai_unconfigured`, or the key was removed while the bar was open) | "AI isn't set up for this workspace." | Admin: plain text "Check the Admin → AI tab." Others: plain text "Ask a workspace admin." |
| Key rejected (`ai_key_invalid`) | "The AI key was rejected. Check it in AI settings." | Admin, or the person's own key: link "AI settings". Others: "The AI key was rejected. Ask a workspace admin to check it." |
| Rate limited (`ai_rate_limited`, with `retry-after`) | "Too many requests. Try again in 40 s." | **Retry**, disabled until the countdown ends. The number counts down live each second; at zero the text becomes "Too many requests. You can try again now." and Retry enables. |
| Proxy rate limited (`rate_limited`) | The server message verbatim; fallback: "Too many requests. Try again later." | **Retry**, disabled until `retry-after` ends when present |
| Credits exhausted (`credits_exhausted`) | The server message verbatim; fallback: "AI credits are used up. Try again later." | No Retry; try again when credits reset |
| Credits not included (`credits_not_included`) | The server message verbatim; fallback: "AI credits aren't included for this workspace." | Ask a workspace admin; no Retry |
| Model not allowed (`model_not_allowed`) | The server message verbatim; fallback: "This model is not allowed. Ask a workspace admin to change it." | No Retry |
| Reply limit too large (`max_tokens_too_large`) | The server message verbatim; fallback: "The requested reply is too large. Try a smaller request." | No Retry |
| Request too large (`request_too_large`) | The server message verbatim; fallback: "This request is too large. Reduce the amount of content and try again." | No Retry |
| Provider down (`ai_unavailable`) | The server message verbatim; fallback: "AI is temporarily unavailable. Try again in a moment." | **Retry** |
| Refused (`refused`) | "The AI declined this request. Nothing was changed." | **Edit request** (back to the prompt) |
| Offline | "You're offline. AI needs a connection." | **Retry** |

The rate-limit countdown is for the eye only. Screen readers get the static sentence once ("Too many requests. Try again in 40 seconds.") and once more when it ends ("You can try again now."); the changing number is `aria-hidden`.

A failed run keeps the prompt and the context, so Retry and Edit request lose nothing.

## Collapsed, dock and drag

- **Collapsed**: a 40px tray button with a four-point spark glyph (24px stroke, the app's icon style). Tooltip "Ask AI" with the key chip "Ctrl/Cmd+K". Click or the shortcut expands.
- **First time**: expanded. After that the last choice wins, per person per browser (`driftboard:ai-bar`).
- **Docked** (default, Decided (Johan, 2026-10-09): page-centred, above the session bar when one is running): `position: absolute` inside `.chrome`, bottom 16px, centred on the page (not on the canvas beside the rail): the dock has equal insets, `left: 244px; right: 244px` (244px clears the zoom tray), and the bar is `min(640px, 100%)` of it, so it is 640px down to 1128px and narrows to 512px at 1000px. The collapsed button and the open bar sit in the same dock, so they share one centre line and one bottom edge, and opening does not move it sideways. At 1000px and below the insets become `calc(var(--rail-clear) + 12px)` on both sides and the bar rises to bottom 64px, above the zoom tray; at 860px and below the insets are 12px (the phone layout).
- **Drag** (desktop only): the grip drags the bar anywhere inside the board area, 8px from each edge. The position is remembered as `left,bottom` in px (`driftboard:ai-bar-pos`) and clamped again on resize. Double-click on the grip, or Home while the grip has focus, docks it again. Arrow keys on the focused grip move it 8px (Shift: 32px). A dragged bar does not stack with the session bar; it stays where it was put and sits under the selection quick bar and any popover. A collapsed button stays at the bar's last left and bottom edge.
- **Phones and narrow screens** are always docked; there is no grip.

## Placement and stacking with other bottom chrome

The bar is the topmost item of a stack that grows upwards from the bottom edge. Nothing in the stack may cover another item, and the zoom tray is never covered.

| Item | Where it is today | With the AI bar |
| --- | --- | --- |
| Zoom tray | `right: 12px; bottom: 12px` | Never covered. Above 1000px the dock's insets are 244px on both sides; at 1000px and below the bar sits above it (bottom 64px = 12 + 44 + 8). |
| Session bar (`.flowbar`) | `bottom: 12px`, centred; at ≤ 860px `bottom: 60px`, left of the rail clearance to 12px | The AI bar's bottom edge is the session bar's top edge plus 8px. |
| Poll card (`.poll-card`) | `bottom: 0`, `z-index: 11`, `max-width: 560px` | Same rule: the bar stacks 8px above it when it shows. |
| Toast (`.toast`) | `position: fixed; bottom: 76px` | Must move above the bar: bottom = the bar's top + 8px. The mock does this. |
| Focus cards (`.focus-stack`) | `bottom: var(--focus-bottom, 124px)`, measured by `focus.ts` from the session bar | Must include the bar: `--focus-bottom` becomes the bar's top + 8px when the bar is docked. |
| Selection quick bar (`.quickbar`) | Placed by `placeBar` around the selection, `z-index: 12` | Always above the AI bar in z-order. In addition, the AI bar's rectangle is passed to `placeBar` as one more obstacle (it already takes connector boxes), so the quick bar flips above the selection instead of landing under the AI bar. |
| Props panel (`.props`) | At ≤ 860px `bottom: 64px` | Overlaps the bar on phones. When the props panel is open the AI bar collapses; opening the props panel is a deliberate edit gesture and wins. (Open question 12.) |
| Tooltips, popovers, dialogs | Above the chrome | Unchanged; the bar's own popovers are `z-index: 20` inside `.chrome`. |

**How the bar publishes its height.** One small function, `bottomChromeTop()`, returns the highest top edge among the visible items below the bar (session bar, poll card, and on phones the zoom tray), and sets `--ai-bottom` (the bar's bottom offset) on `.chrome`. A `ResizeObserver` on the bar sets `--ai-top` (the distance from the board's bottom edge to the top of the bar, plus 8px, or 16px when collapsed to the button). The toast, `.focus-stack` and the poll card's own offset read `--ai-top` as a floor: `bottom: max(<their current value>, var(--ai-top, 0px))`. The session bar's wrapping height is already measured by `focus.ts`; the same observer feeds both.

## Keyboard

| Key | Where | Does |
| --- | --- | --- |
| Ctrl/Cmd+K | Anywhere on the board, except while editing text on the board (where the text editor keeps the key) | Expands the bar and focuses the prompt; if the bar is open and focus is in it, collapses and focuses the spark button; if open and focus is elsewhere, focuses the prompt. Does nothing for viewers, commenters and AI-off workspaces. |
| / | Anywhere on the board when no text field has focus | Fallback for Ctrl/Cmd+K: expands the bar and focuses the prompt |
| Enter | Prompt | Runs the armed action, else Generate (when the prompt is not empty) |
| Enter | Preview, focus on the board or on Add | Adds to board |
| Esc | Menus and popovers open | Closes them, focus back to their button |
| Esc | Running | Stops |
| Esc | Preview | Discards |
| Esc | Error | Dismisses |
| Esc | Idle with a chip armed | Disarms it |
| Up / Down | Empty prompt, or while walking history | Previous or next prompt |
| Arrow keys, Home, End | Chip row (roving tabindex) | Move between chips; the row is one Tab stop |
| Arrow keys | Open menu or list | Move through items; Tab closes the menu |
| Arrow keys, Home | Grip | Move the bar 8px (Shift 32px); Home docks it |

**Shortcut: Ctrl/Cmd+K, with "/" as the fallback** (Decided (Johan, 2026-10-09)). Add it to `src/shortcuts.ts`: `{ group: 'View', keys: 'Ctrl/Cmd+K or /', action: 'Ask AI', ids: ['mod+k', '/'] }`. The spark button and the collapse button then take `data-tip-key="mod+k"` and the shared tooltip shows the chip the dialog documents. List the row only when the bar exists for the person (the shortcuts dialog filters it for viewers and AI-off workspaces).

Ctrl+K is a browser shortcut on Windows and Linux (Chrome and Firefox move to the address bar's search). A page's `keydown` handler with `preventDefault` normally wins while the page has focus, but test it in Chrome, Safari and Firefox on macOS and Windows before shipping. "/" works when no text field has focus (the user guide already uses "/" for its search), so there is always a route. Nothing on the board uses Ctrl/Cmd+K today.

### Focus order

Document order is the tab order, so row 2 comes before the chips even though the chips are drawn above it (CSS `order`):

1. Context button
2. Prompt
3. History button
4. Model chip
5. Run (or Stop; or Discard, Retry, Add to board; or the error's action and dismiss)
6. Collapse
7. Grip (desktop)
8. Chips (one Tab stop; arrows move inside)

The brief's order was context, prompt, model chip, Run, collapse, chips. Two things are added: the **history button** (it must be reachable without a mouse) and the **grip** (so moving the bar has a keyboard route). The visual order differs from the tab order for the chips; see open question 7.

Every control shows the app's focus ring (`:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px }`). The prompt keeps the app's input look: its border turns `--signal`. In the mock the ring is `--signal` on the dark tray everywhere; its contrast against `--tray` is 7.6 to 13.9 in the five themes.

Focus moves: expand focuses the prompt; collapse focuses the spark button; a preview focuses Add to board; Stop, Discard and dismiss focus the prompt; an error does not move focus (the alert is announced instead); opening a menu focuses its current item and closing returns to its button.

## ARIA

| Element | Role and attributes |
| --- | --- |
| Bar | `<section aria-label="Ask AI">` |
| Spark button | `aria-label="Ask AI"`, `aria-expanded`, `aria-controls` (the bar) |
| Chip row | `role="toolbar"`, `aria-label="AI quick actions"`; chips are toggle buttons (`aria-pressed`, true when armed) with roving `tabindex`; disabled chips use `aria-disabled="true"` and the tooltip gives the reason through `aria-describedby` |
| Context button | `aria-haspopup="menu"`, `aria-expanded`; the menu is `role="menu"` with `role="menuitemradio"` items and `aria-checked` |
| Prompt | `<input type="text" aria-label="Prompt">` (the placeholder carries the hint); `enterkeyhint="send"` |
| History | Button with `aria-label="Prompt history"`, `aria-haspopup="listbox"`; list is `role="listbox"` with `role="option"` |
| Model chip | `aria-haspopup="dialog"`, `aria-label` repeats the estimate then "Model and cost details"; popover is `role="dialog"` with `aria-label="Model and cost"` |
| Status | `role="status"`, `aria-live="polite"`. **The element stays mounted** and is visually hidden when empty; filling an element that was just inserted or un-hidden is announced unreliably. |
| Error | `role="alert"`, same rule: always mounted, hidden when empty |
| Progress rule | `aria-hidden="true"` |
| Run | `aria-disabled` while empty, not `disabled`, so the tooltip works |
| Grip | `aria-label="Move AI bar"`; hint through the tooltip: "Drag to move. Double-click to dock." |
| Preview | The summary line is plain text in the bar; Add to board takes focus, so it is announced with its name. The preview on the canvas is decorative (`aria-hidden`); its content is announced as "6 stickies in a new frame “Summary”" via the summary line |

## Theming

Everything comes from tokens already defined for the five themes (`src/themes.ts`); the bar adds none. No hex colours outside the theme blocks.

| Use | Token |
| --- | --- |
| Tray fill, text, hairlines, hover, chip and input fill | `--tray`, `--tray-text`, `--tray-line`, `--tray-hover`, `color-mix(in srgb, var(--tray-text) 6%, transparent)` |
| Muted text (disclosure, placeholder, model chip, grip) | `--tray-muted` |
| Radius, shadow | `--radius`, `--shadow` (+ the 1px `--tray-line` outline on non-default themes, as `.tray` does) |
| Primary action, progress rule, focus ring, input focus, preview outline and label | `--signal`, `--on-signal` |
| Error text and icon | `color-mix(in srgb, var(--danger) 54%, var(--tray-text))` |
| Selection (already drawn by the board) | `--wire` |
| Ghost column headers, arrows, ghost frame hairline | `--canvas-ink`, `--canvas-rule` via `color-mix` |
| Sticky colours | The existing palette at full strength; ghosts are marked by a dashed `--canvas-ink` 55% edge, not by opacity |

### Contrast (computed from the values in `src/themes.ts`)

Ratios against `--tray` unless noted. `--tray-muted` on the input fill (`--tray-text` at 6% over `--tray`) is the tightest case, so it is listed.

| Theme | Prompt and label text on tray | `--tray-muted` on tray | `--tray-muted` on input fill | Error red on tray | `--on-signal` on `--signal` (Run, Add) | `--signal` on tray (focus ring) |
| --- | --- | --- | --- | --- | --- | --- |
| Default | 13.83 | 6.41 | 5.48 | 5.70 | 11.26 | 11.26 |
| Ayu | 10.50 | 5.41 | **4.79** | 8.29 | 10.41 | 11.55 |
| Kanagawa | 12.41 | 6.35 | 5.61 | 8.20 | 9.73 | 10.72 |
| Matrix | 15.38 | 8.01 | 7.10 | 7.91 | 14.26 | 13.93 |
| Evergreen | 13.31 | 7.18 | 6.11 | 5.99 | **7.10** | 7.63 |

All text meets 4.5:1 in all five themes, so **`--tray-muted` needs no `color-mix` correction** and none was applied. The two nearest misses are Ayu muted-on-input (4.79) and Evergreen primary (7.10, still well above). Disabled controls at 40% opacity are exempt, as everywhere in the app.

Two things the numbers show that need a decision, not a fix:

- **The tray barely separates from the canvas in Ayu, Kanagawa and Matrix** (tray against canvas 1.05 to 1.11). The existing trays have the same property and rely on the 1px `--tray-line` outline. The bar does the same.
- **The preview outline uses `--canvas-ink`, not `--signal`.** `--signal` against `--canvas` is only 1.27 on Default and 1.79 on Evergreen, so the dashed edge is `--canvas-ink` at 55% (3.3 to 4.9:1 in every theme) and `--signal` carries the "Preview" label and an 8% wash.

## Phone and narrow screens

The brief sets the phone layout at 600px and below. The mock applies it up to **860px**, the width where the rest of the board chrome already reflows (`.flowbar`, `.props`). Between 601 and 860px the space between the rail and the zoom tray is 270 to 530px, too narrow for row 2.

- Full width with 12px side margins, capped at 640px and centred above 640px.
- Bottom 64px (above the zoom tray row), or 8px above the session bar when it shows. The session bar itself is at `bottom: 60px` at these widths.
- Chips: one scrolling row.
- Row 2: context button, prompt (with history), Run, collapse (a down chevron). The model chip moves into the disclosure line as an underlined button. No grip, no drag.
- Disclosure: two lines. The first segment takes the first line; key source and the model chip share the second.
- Preview and error: the message takes the full row beside the collapse chevron; the buttons go on their own row below, sharing the width (Discard, Retry, Add to board each flex to fit). An error with only a dismiss keeps it on the message row.
- Running: the context button is hidden so "Summarising 42 stickies…" is not truncated.
- The selection quick bar sits above the AI bar in z-order; nothing the bar does moves it.
- Tap targets are the app's 36px for buttons and 28px for chips. The chips are below the usual 44px guideline; they are separated by 6px and the row scrolls, but this should be checked on a device (open question 13).
- Keep the bar above the on-screen keyboard: use `visualViewport` so the dock follows the keyboard. Not in the mock.
- Drag is off; double-click to dock does not apply.

## Motion

- Expand and collapse: 160ms `opacity` and a `translateY(8px)` on the bar and the button, ease. After collapse the bar is `hidden` once the transition ends.
- The progress rule is the only other animation.
- Tooltips use the shared tooltip's own 120ms fade; the toast keeps its existing 160ms.
- `prefers-reduced-motion: reduce` removes the expand and collapse transition and makes the rule static.

## Copy

All of it, as built in the mock. Sentence case, plain, no exclamation marks, no raw codes.

| Where | Text |
| --- | --- |
| Spark button tooltip | "Ask AI" + "Ctrl/Cmd+K" |
| Collapse tooltip | "Collapse" + "Ctrl/Cmd+K" |
| Grip tooltip | "Drag to move. Double-click to dock." |
| Prompt placeholder | "Generate sticky notes about…"; with Summarise or Cluster armed: "Optional instruction…" |
| Run tooltip | The action it starts + "Enter" ("Summarise", "Cluster", "Generate sticky notes"); disabled: "Type what to generate, or pick an action above" |
| Stop tooltip | "Stop" + "Esc" |
| Chips | "Summarise", "Cluster", "Generate ideas" |
| Chip tooltips when disabled | See "Chips" |
| Context menu | "3 selected stickies" / "Nothing selected"; "Visible area" / "23 stickies"; "Whole board" / "42 stickies"; "Prompt only" / "No board content" |
| History | "No prompts yet." when empty |
| Model chip | "Opus 5.5 · ~1.3k tokens"; with credits "~4 credits · 1,240 left"; armed "Summarise · ~1.3k tokens" or "Summarise · ~4 credits · 1,240 left"; tooltip "Estimate before you run. Click for details." |
| Model popover | "Model", "Claude Opus 5.5", "Chosen by your workspace admin.", "AI settings" (admins); "This run", "About 1,300 tokens go in; the reply is capped at 4,000.", "That is roughly 3 credits of 1,240 left this month.", "An estimate, not a bill." |
| Disclosure | See "Disclosure line". "Esc stops" while running. |
| Running | "Summarising 42 stickies…", "Clustering 12 stickies…", "Generating ideas…" |
| Preview summary | "6 stickies in a new frame “Summary”"; "6 new stickies"; "Moves 9 stickies into 3 groups" |
| Preview buttons | "Discard" (Esc), "Retry" (tooltip "Run it again"), "Add to board" (Enter) |
| Preview disclosure | "Nothing is on the board until you add it" · "Enter adds, Esc discards" (create) or "Enter moves them, Esc discards" (group) |
| Toast after Add | "Added 6 stickies." + "Undo"; "Moved 9 stickies into 3 groups." + "Undo" |
| Dismiss | Tooltip "Dismiss" + "Esc" |
| Errors | See "Errors". Not in the mock: "The board changed while you were looking. Run it again." |
| Board menu (AI unavailable) | No AI entry |

## Persistence

| Key | Value |
| --- | --- |
| `driftboard:ai-bar` | `open` or `collapsed`; absent means open (the first time) |
| `driftboard:ai-bar-pos` | `left,bottom` in px; absent means docked |
| `driftboard:ai-history` | Up to 20 prompts, newest first, newline-separated |
| `driftboard:ai-private` | `1` when private runs are on (personal key only); absent means off |

The prefix is `driftboard:` like every other key, as the project's rename left it. Every read and write is in `try/catch`; if storage is blocked the bar still works and forgets. In accounts mode the history key should be suffixed with the user id and cleared on sign-out, so a shared computer does not show one person's prompts to the next (open question 14).

## Multiplayer (TAB-141)

Boards are shared, so AI runs are too. Others see a run while it happens and see its preview, and any editor can finish it. The one exception is a private run on a personal key. Examples use Ana, another editor, in their cursor colour; "you" are the person looking.

### Someone else's run in flight

- **Target outline.** A 2px outline in Ana's colour, 6px radius, 8px outside the bounds of what they ran on (their selection, or the frame). A 4px halo of their colour at 18% sits around it. The outline pulses slowly between 35% and 100% opacity over 2.4s. Under `prefers-reduced-motion` it does not pulse: it is a static, fully opaque dashed outline with no halo. "Visible area" and "Whole board" runs have no outline (there is nothing useful to circle), and "Prompt only" runs have no target at all.
- **Presence line.** "Ana is asking AI: Summarise…" in two places:
  1. as a label on the outline's top-left corner: their colour as the fill, 11px/600, sentence case, the same shape as the cursor name tags. It is drawn above the canvas objects but does not pulse;
  2. as the tooltip and accessible name of their avatar in the presence tray (top right). While they have a run or a preview, the avatar gets a 14px `--signal` badge with the spark glyph.
- **Why not near the bar.** The bar is your own tool, not a feed. Viewers and commenters have no bar but still need to know why the board is about to change. A collapsed bar has nowhere to put a line, and on a phone the bar already fills the width. The presence tray is where the board already says who is here, and the outline label puts the line on the thing that will change. Nothing new appears in the chrome, nothing moves, nothing is announced out loud. When the target is off-screen, only the avatar badge shows.
- **The prompt is never shown.** The line names the action ("Summarise", "Cluster", "Generate ideas"), never what Ana typed. A prompt can be private in a way a board edit is not.
- The line and the outline go away when the run ends: on a preview, on an error, on Stop, or when Ana leaves.

### Someone else's preview

- Drawn exactly like your own preview (full-colour ghost stickies with dashed edges, a dashed area outline over a wash), but in **their colour**: a 2px dashed `--ana` outline over an 8% `--ana` wash, with the ghosts' dashed edges mixed from their colour.
- **Label**: "Ana's AI preview", in their colour, in the same uppercase label style as your "Preview". When another person's preview is on the board, yours reads "Your AI preview", so neither label is ambiguous.
- **Actions for editors.** A small tray on the label row, right of the label: **Discard** and **Accept** (`--signal`, primary), 20px buttons. They are on the ghost area, not in your bar: your bar keeps working on your own run, and the tray says whose preview it is. Accept writes Ana's proposal as one undo step on **your** undo stack. It is applied with your role (`store.transact`, the same validation as Add), and the toast says "Added Ana's 4 stickies." with Undo. Discard writes nothing; the toast says "Discarded Ana's preview."
- **Viewers and commenters** see the preview and its label, read-only. There is no tray.
- **Ana's own bar** stays in preview state with Add to board, Discard and Retry. When someone else accepts or discards, Ana's bar returns to idle and a toast says "Ben added your preview." or "Ben discarded your preview."
- **First action wins.** Ana, Ben and you can act on the same preview within the same second. The relay settles it: the first `resolve` wins (see "Protocol"), and only the app that made it writes. Anyone else whose click arrives later writes nothing, the preview disappears for them, and they get a toast naming who acted and how: "Ana added their preview first." / "Ana discarded their preview first. Nothing was added." / "Ben added Ana's preview first." The mock shows this with "Ana acts first" (`other-preview-race-default.png`).
- **A preview outlives its owner's connection.** If Ana leaves, their preview stays, still labelled "Ana's AI preview", and any editor can accept or discard it until it expires 10 minutes after it was ready (or the board's room unloads). Their avatar badge goes with their; the label row carries their name.

### Two previews at once

- **Show (TAB-218).** Your own ready preview is drawn where the board has room, which can be off screen when the board is fitted to its stickies. Your label row has a **Show** button, and so has the bar's preview row (between Retry and Review): it flies the view to the preview, with room for the label row, at a zoom of 1 at most. It only ever runs from a click: no preview, yours or anyone's, moves the camera by itself (`test/ai-live-camera.test.ts`), and other people's label rows have no Show.
- Each preview is drawn in its owner's colour with its owner's label and its own actions. Your actions stay in your bar; theirs are on their label row.
- **Stacking order**, bottom to top: others' previews, oldest run first; then your preview; then all label rows. Your ghosts are on top because yours is the one your keyboard acts on (Enter, Esc). Label rows always sit above every ghost, so a label is never hidden by another preview.
- **A preview whose stickies all changed (TAB-221).** A cluster preview moves stickies that are already on the board. When every one of them has changed since it arrived on your screen (edited, moved, resized, put in another frame, locked, turned into another kind, or deleted), there is nothing left to draw or add, so the ghosts go and the preview keeps a short label row: the label ("Ana's AI preview"), "everything changed since it came" under it, and a **Discard** when you may settle it. It hangs over the stickies that are still there, or in the middle of the view when none is. It has no Accept or Review, and it does not move the camera. It is never wider than the room right of the rail (about 284px at 360 wide) and wraps its label; an ordinary row stacked for want of room cuts a very long name with an ellipsis, and its accessible label keeps the whole name. Your own preview's short row has no Discard, since your bar has it. Nobody's run is discarded automatically: it expires like any other, 10 minutes after it was ready.
- **Label rows avoid collisions.** Rows are placed in stacking order, each above its area's top-left corner and kept inside the board. If a row would touch a row already placed, the selection quick bar or the AI bar, it moves under its area's bottom-left corner. If that collides too, it steps down 24px at a time. Overlapping areas are allowed; previews are not moved apart, because their positions are where the stickies will land. A row never goes left of the rail (it keeps 4px from its right edge), and when no spot is free it stays beside its preview rather than at the bottom of the board. On a phone, a row wider than the room right of the rail (about 314px at 390 wide, with a long name) stacks its Discard, Review and Accept under the label (TAB-215); `npm run check:ai-review` presses all three at 390.
- Accepting one preview does not change the other. If both target the same stickies (two Cluster runs on overlapping selections), whichever is accepted second is validated against the board as it is then. If its ids moved, it fails with "The board changed while you were looking. Run it again." for the person who accepted it.

### Private runs

- **Only with a personal key.** In the model popover, under "Visibility", a switch: **Private run**. Off: "Others on this board see that you are asking AI, and see your preview." On: "Nobody else on this board sees the run or the preview until you add it."
- **Default off**, so collaboration is visible by default. The choice is remembered per person in this browser (`driftboard:ai-private`). While it is on, the disclosure line says "Uses your key · Private run", and while running "Private run · Esc stops".
- A private run publishes nothing: no presence line, no avatar badge, no outline and no ghost for anyone else. Once you add it, the stickies are ordinary edits that everyone sees.
- **Workspace keys and credits cannot be private.** The popover says so instead of showing the switch ("Runs on the workspace key can't be private: the workspace pays for them."). A run that spends the workspace's money or allowance stays visible on the board, so the people who share the bill can see what it is spent on. Admins also see it in the audit log and, in phase 2, in usage by person.
- **Private means private from collaborators, not from the workspace.** The relay still writes the audit row (`ai.<feature>`, `keySource: 'user'`) for a private run, as `docs/ai.md` requires for every run. The row holds no board text, prompt or output. No conflict with `docs/ai.md`: it allows personal keys only when an admin turns them on, and the switch exists only where a personal key is in use.

### Protocol: runs are held by the relay

Live runs are **relay-authoritative**, as built in `server/ai/live.mjs` and `server/ai/policy.mjs`; see "Live runs" in `docs/ai.md`, which is the contract. The bar only draws what the relay sends. Awareness carries nothing about AI runs, because awareness is set by each client and can be spoofed: someone could claim to be running a run, or show a preview the relay never validated.

**State.** The relay keeps each board's runs in memory as `{ id, feature, by: { id, name }, status, startedAt, readyAt, proposal, cut, error, resolvedBy }`. A run starts when the provider is about to be called, and becomes `ready` with the validated proposal or `failed` with an error code. The `progress` and `result` events of the run request carry its `runId`, so the runner's own bar knows which run is its own.
- **Nothing goes into the board document** until someone accepts. Runs are never saved, never in history, never in exports or `.drift` files.
- **Lifetime.** A `ready` run nobody settles becomes `expired` after 10 minutes. A run still `running` after 5 minutes is `failed`. A board holds at most 12 open runs; when a 13th starts, the oldest ready one expires to make room. Runs are dropped when the board's room unloads, and a relay restart forgets them all.
- **A ready run survives its owner disconnecting**, so any editor can still accept or discard it (see "Someone else's preview").

**Broadcast.** The relay sends message type 6 (`MSG_AI_RUNS`) to sockets in the board room, relay to client only:
- a `{ kind: 'snapshot', runs }` message to a socket that joins while runs are open;
- then a `{ kind: 'patch', run }` message for each change.

Every socket gets its own copy, built by `viewFor` and filtered by `canSeeRun`, so who sees what is decided on the server. A `ready` run carries its `proposal` and `cut`. `accepted`, `discarded`, `failed` and `expired` mean the run is gone, and the client removes the outline or preview. Their `resolvedBy` names who settled it, which feeds the "…first" toast and Ana's "Ben added your preview." toast.

**What the bar draws from a run.**

| From the run | Drawn as |
| --- | --- |
| `status: 'running'`, `by`, `feature` | The presence line "Ana is asking AI: Summarise…", the avatar badge and the target outline. |
| `status: 'ready'` and `proposal` | The ghosts and the "Ana's AI preview" label row. |
| `by.id` | The owner's colour: the colour that person's cursor already uses (`USER_COLORS`, looked up by user id). In open mode `by` is `{ id: null, name: null }`, so the line reads "Someone is asking AI: Summarise…" in `--canvas-ink`, and the label reads "AI preview". |
| `id` matching your own `runId` | Your own run. It is drawn as your preview, driven by your bar, not as someone else's. |

- **Where the ghosts go.** Ghosts are laid out with the same `nextFree` placement that Accept uses, on the board as it is now. What you see is therefore where the stickies land, whoever accepts.
- **The prompt is never sent to others** (`PROMPT_VISIBILITY = 'runner'`), which matches "The prompt is never shown" above.

**Settling.** Every Accept and Discard calls `POST /api/ai/runs/:id/resolve { action: 'accept' | 'discard' }`. That covers your own Add to board and Discard in the bar, and Accept and Discard on someone else's label row. The first call wins:
- **200:** an accept returns the `proposal`. The app of the person who clicked writes it with `store.transact`, as one undo step on their own stack.
- **409 `ai_run_resolved`:** someone else got there first, or the run failed or expired. The client shows the "…first" toast, using `resolvedBy` from the patch that arrives alongside.
- **409 `ai_run_running`:** the run hasn't finished yet. The bar can't send this, because Accept only appears on a ready run.
- **404 `not_found`:** the run is gone.
- **403 `forbidden`:** the policy says no.
- **402 `read_only`:** the workspace is read-only.

The relay writes an audit row, `ai.run.accept` or `ai.run.discard`. Who may resolve is `RESOLVE_POLICY = 'editors'`: anyone who can edit the board. That matches "Actions for editors" above. Viewers and commenters get the runs, so they see the outline, the line and the preview, but get no tray, and the relay would refuse them anyway.

**Not in the relay yet** (needed for this design; tracked for the build):
- **Target.** `live.mjs` has no target, so the outline around Ana's selection or frame has nothing to draw from.
  - Proposal: the run route already receives the selection ids, or the frame id. It stores them on the run as `target: { ids } | { frameId } | null` and sends them in `viewFor`.
  - Each client then computes the outline from those ids on its own board. That uses no client-supplied geometry, and the outline follows the stickies if they move.
  - Runs on the visible area, the whole board or the prompt only get `target: null`.
- **Private runs.** `live.mjs` has no private flag.
  - Proposal: the run request carries `private: true`, which is allowed only when the key that resolves is a personal key; otherwise the relay answers `400`.
  - The relay still starts the run, so `runId`, the audit row and resolve keep working. `viewFor` returns the run only to the runner (`viewer.userId === run.by.id`) and returns `null` to everyone else.
  - This keeps the rule on the server, next to `canSeeRun`, instead of trusting the client to keep quiet.

### Colour

A person's colour is their cursor colour (`USER_COLORS` in `src/palette.ts`). These are data, like sticky colours, not theme tokens. Label text is white or the ink `#18212B`, whichever contrasts more:

| Colour | Label text | Label contrast | Person colour alone against canvas, before halo (Default, Ayu, Kanagawa, Matrix, Evergreen) |
| --- | --- | --- | --- |
| `#2F6FED` | white | 4.55 | 4.01, 3.41, 3.59, 4.39, 4.04 |
| `#D64545` | white | **4.38** | 3.86, 3.54, 3.73, 4.56, 3.89 |
| `#1E9A6A` | ink | 4.56 | 3.15, 4.35, 4.58, 5.59, 3.17 |
| `#C98A00` | ink | 5.51 | **2.60**, 5.26, 5.54, 6.76, **2.62** |
| `#7A5AF8` | white | 4.52 | 3.99, 3.43, 3.62, 4.41, 4.02 |
| `#E0559B` | ink | 4.60 | 3.12, 4.39, 4.62, 5.65, 3.14 |
| `#0E9AA7` | ink | 4.80 | **2.99**, 4.58, 4.82, 5.89, 3.01 |
| `#E06D2B` | ink | 4.95 | **2.90**, 4.72, 4.97, 6.07, **2.92** |

`#D64545` misses 4.5:1 for its 11px label by a little; its label fill is darkened (`color-mix(in srgb, #D64545 90%, #18212B)` gives white text 5.04:1). Amber, teal and orange outlines fall under 3:1 on the two light canvases before the halo. The in-flight ring has a 1px `--tray` line inside and outside its 2px person-colour border; the 18% glow stays 4px wide beyond the outer line. Another person's preview draws a solid `#18212B` under-stroke at 55% opacity, 1px wider on each side than the dashed colour outline. These halos bring the outlines to at least 3:1 on the light canvases without changing cursor colours (open question 20).

### Mock

Reviewer controls: **Other person (Ana)**: none, running, preview. **Two previews**: off, side by side, overlapping. **Private run (your key)**, which also sets the key source to "your key". **Ana acts first**: Accept or Discard on their preview then loses the race. **Role** is the existing control (viewer and commenter see their preview without the tray). Parameters: `other`, `two=side|overlap`, `private=1`, `anawins=1`.

## What the build needs

For the engineer. The bar, its entry points and live previews ship with the normal board and are controlled by the per-person AI config.

- `src/ui/ai-bar.ts` and `src/ui/ai-bar.css` for the bar; `src/ai-bar-logic.ts` for the pure parts, with unit tests for context counts and defaults, chip availability and reasons, arming and what Run starts, the disclosure text, the token and credit estimate, the error-to-view mapping (including role and key source), history, position clamping and setup visibility.
- `src/ui/board.ts` mounts it in `.chrome` when `GET /api/ai/config` says it should.
- `src/shortcuts.ts` registers the Ctrl/Cmd+K row, with "/" as the second id (see "Keyboard").
- The sticky tray's Generate, the board menu's Summarise, the session bar's Summarise next to Vote results after Finish, and the quick bar's Cluster call the bar control's `open({ arm, context })` instead of running anything (see "Entry points").
- `src/ui/quickbar.ts` passes the bar's rectangle to `placeBar` as an obstacle.
- `toast()` in `src/ui/common.ts` supports an optional action button and longer duration, and reads `--ai-top`; `focus.ts` and the poll card also read `--ai-top` (see "Placement").
- The board menu has no AI entry while AI cannot run. Workspace setup is in **Admin → AI**.
- The status is recorded in `docs/ai.md` and the user-facing changelog.
- Multiplayer (TAB-141): the relay and app live-run work includes the in-flight target outline and other people's previews. Tests cover snapshots and patches, settled previews, resolve races, role-based trays, open mode, label-row collisions and reduced motion.
- Tests (from the Linear spec): context selection, preview, accept and undo, permission gating, each error state, a mock provider (no network).

## Decisions beyond the brief

1. **Only the three v1 chips, by default.** Mind map, Rewrite and Translate are treated like Table and Slides: not built, so not shown. A reviewer switch shows the planned eight.
2. **A fourth context, "Prompt only"**, so Generate can run with no board content sent, and the disclosure line can say so.
3. **A typed prompt runs Generate** when no chip is armed. Run is disabled while nothing would run.
4. **Chips and the context button are dimmed (and the chips inert) while running and previewing**, so the height does not change and nothing can start a second run.
5. **Collapse is disabled while running and previewing**, so a run or a preview is never orphaned behind a button.
6. **"Edit request" on a refusal**, and a **dismiss ✕ on every error**, so the person can get back to the prompt.
7. **"Uses AI credits"** when no key source applies and hosted credits are active (`docs/ai.md` says only "the platform with credits").
8. **The bar is centred on the page** (review, 2026-10-09), with equal 244px insets so it never reaches the zoom tray; the brief placed it between the rail and the zoom tray, which put it 78px left of the page centre at 1440px. Below 1000px it rises above the zoom tray instead of narrowing further.
9. **The phone layout runs up to 860px**, not 600, and the bar is capped at 640px there.
10. **Phone bottom offset is 64px** (zoom tray row plus 8px), because the zoom tray stays bottom right at every width and the brief says it is never covered.
11. **The estimate counts input tokens**, with the output cap in the popover rather than in the chip.
12. **History button and grip are tab stops**, after the brief's order (see "Focus order").
13. **Non-admin variants of three errors** (no key, key rejected, out of credits) that point at the workspace admin instead of a settings link the person cannot open.
14. **Toast stacks above the bar**; the quick bar is an obstacle for the bar's rectangle; both are needed in the app, not just the mock.
15. **Keyboard activation of Add returns focus to the prompt; pointer activation does not.**
16. **Ghost styling revised (review, 2026-10-09):** the brief's 55% opacity and `--signal` dashes are replaced by full-colour ghost stickies with a dashed `--canvas-ink` 55% edge, and a `--canvas-ink` 55% dashed area outline over an 8% `--signal` wash. Opacity made the sticky colours muddy on dark themes, and `--signal` was 1.27:1 on the Default canvas.

## Decided (Johan, 2026-10-09)

1. **Shortcut**: Ctrl/Cmd+K, with "/" as the fallback when no text field has focus. Replaces Ctrl/Cmd+J everywhere. Closes open question 1.
2. **Placement**: page-centred, above the session bar when one is running (as built; see "Collapsed, dock and drag"). Closes open question 2.
3. **Phone layout below 860px** (as built; see "Phone and narrow screens"). Closes open question 3.
4. **Placeholder**: "Generate sticky notes about…". Closes open question 5.
5. **Chips arm first**: a click selects the chip and shows its estimate; Run or Enter runs it (see "Chips"). Closes open question 8.
6. **Credits copy**: "Add credits", everywhere. Closes the copy half of open question 9.
7. **The bar is the single entry point**: the existing Generate, Summarise and Cluster items open it with their action armed (see "Entry points"). Closes open question 17.

## Open questions

Questions 1, 2, 3, 5, 8 and 17 are closed by the decisions above; they stay here with their answers so the numbering holds.

1. **Shortcut.** Decided (Johan, 2026-10-09): Ctrl/Cmd+K, with "/" when no text field has focus.
2. **Placement.** Decided (Johan, 2026-10-09): page-centred, `min(640px, 100% - 488px)`, above the session bar when one is running, rising above the zoom tray at 1000px and below.
3. **Tablet widths.** Decided (Johan, 2026-10-09): the phone layout applies below 860px.
4. **Planned chips.** Show the other five as "Coming soon", or keep them out until they ship? Recommendation: out. Also decide whether Table and Slides get their own entry points rather than chips.
5. **Free text means Generate.** Decided (Johan, 2026-10-09): the placeholder says so, "Generate sticky notes about…".
6. **Frames and the retro summary.** `docs/ai.md` lets a feature run on a frame and gives Summarise a `summary` or `retro` type. The bar has neither a "Frame" context nor a type switch. Should a selected frame be its own context ("Frame “Sprint retro”")? Should Summarise ask summary or retro when a session has run?
7. **Tab order versus visual order.** The brief puts the chips last in the tab order though they are drawn first. That is predictable for keyboard users who think "prompt first", but it fails the usual rule that focus follows reading order. Alternative: chips first, then row 2, no CSS reordering. The cost is one more Tab stop before the prompt (the chip row is a single stop, so it is small). Recommendation: chips first.
8. **Chip click.** Decided (Johan, 2026-10-09): chips arm first; Run or Enter runs the armed action.
9. **Credits.** Copy, decided (Johan, 2026-10-09): "Add credits", consistently (`docs/ai.md`'s "Buy credits" should be changed to match when it is next edited). Still open: the model popover's "reply is capped at 4,000" is generate's cap; Summarise and Cluster are capped at 8,000 (`docs/ai.md` "Limits"). Make it per feature, or drop the cap from the sentence. Also decide the low-balance behaviour (for example, the figure turns tray-red under 50 credits); it is not designed here.
10. **Ghosts.** Resolved in the mock (decision 16): full-colour ghosts with a dashed `--canvas-ink` edge, and a `--canvas-ink` area outline. Open only if the team wants a stronger cue, such as a slight desaturation.
11. **Off-screen proposals.** A proposal placed at `nextFree` can be outside the viewport or behind the bar. Pan and zoom to fit it above the bar on preview? That moves the person's view without being asked; restore it on Discard?
12. **Props panel on phones** (`bottom: 64px`) occupies the AI bar's place. The spec collapses the bar while it is open; alternatives are stacking the panel above the bar or hiding the panel's bottom.
13. **Chip tap size on phones** (28px). Fine for a scrolling row, but not tested on a device.
14. **History on shared computers.** Keyed by user and cleared on sign-out in accounts mode? Open mode has no accounts, so it stays.
15. **Concurrent edits during a preview.** The spec validates at Add and fails with "The board changed while you were looking. Run it again." A friendlier option is to re-validate and drop the invalid parts, but a partial add contradicts `docs/ai.md` ("An invalid proposal is an error, never a partial edit").
16. **The model chip is a button with a popover** because the model is not the person's choice (admins pick it). If per-run model choice is wanted later, the same chip becomes a menu.
17. **Existing entry points.** Decided (Johan, 2026-10-09): the bar is the single entry point; the other items open it with their action armed (see "Entry points").
18. **Dragging over content.** The bar can be dropped over the objects it is about to act on. It is draggable, so that is the person's choice, but the context button and the preview ghosts do not move to avoid it.
19. **Proposals held on the relay (TAB-141).** Answered: `docs/ai.md` ("Live runs") now says the relay holds each run and its proposal in memory only, until it is settled or expires, and a restart forgets them.
20. **Weak person colours.** Decided (Johan, 2026-10-09): a 1px dark halo on outlines, built in `ai-live.css` and `ghostMarkup`; cursors keep their colours. Red preview labels already darken toward `#18212B` to meet 4.5:1.
21. **Others' previews and the viewport.** Should a new preview from someone else ever pan your view? Proposed: never. The avatar badge and the outline are enough, and a follow (`docs/focus-requests.md`) is one click away.
22. **Leaving with a preview open.** Answered by the relay design: a ready run survives its owner disconnecting, and any editor can still accept or discard it until it expires after 10 minutes.
23. **Private by default for personal keys?** Decided off by default. Revisit if people with personal keys turn it on almost every time.

## The mock

Open `design/ai-toolbar/index.html`. The strip at the top is the reviewer panel and is not part of the design; the board below it is.

- **Theme**: all five, with the exact values from `src/themes.ts`.
- **State**: idle, collapsed, prompt typed, armed (Summarise; Cluster with 9 selected; Generate with a prompt), opened from the board menu, sticky tray or quick bar (each with its action armed), running, preview (create), preview (group), just added (undo toast), and each of the seven errors.
- **Role**: admin, editor, commenter, viewer. With AI unavailable, the board menu shows no AI entry for any role.
- **Key source**: workspace key, your key, credits (1,240 left).
- **Selected stickies and context**: 0, 1, 3, 9 or 12 selected; selection, visible area, whole board, prompt only.
- **Session bar**: on or off; the AI bar stacks above it.
- **Next run ends with**: a proposal or any of the errors. Type a prompt and press Enter, or click a chip and then Run, and the run takes 2.4 seconds.
- **Chips**: v1 only, or the planned eight.
- **Multiplayer (TAB-141)**: other person (none, running, preview), two previews (off, side by side, overlapping), private run, Ana acts first. See "Multiplayer".
- Add `?bare=1` to hide the panel (used for the screenshots); other parameters (`theme`, `state`, `role`, `ai=0`, `key`, `sel`, `ctx`, `session=1`, `chips=all`, `outcome`, `armed`) preset the controls. Resize the window to see the 860px and 600px behaviour. Ctrl/Cmd+K, "/", Esc, Enter, Up/Down, drag and the keyboard moves on the grip all work.

What is faked: all model output, estimates (the formula is in "Cost and model"), credits, history seed, and the Add (it draws the ghosts as real objects and Undo removes them).
