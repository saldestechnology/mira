# The tracker: UX spec

Status: draft for Johan, written with the tech lead's architecture spec. Section 2 is the contract both specs freeze together.
Owner: designer. Scope: how it looks and behaves. Storage, sync, auth, webhooks and limits are the architecture spec's job.

## 1. Summary

The **tracker** is a full issue tracker (the thing we use Linear for) that lives **on the board** as a screen-sized frame object. You pan and zoom to it like any frame, work in it in place, or press one key to open it full screen. It has five tabs: **Inbox, My issues, All issues, Board, Projects**. A ticket has a page with comments, history, relations, a stable ID (`TAB-123`) and a deep link. A canvas kanban can be **linked** to the tracker: every card becomes a ticket and every lane maps to a tracker state. A GitHub integration posts merged pull requests onto their tickets and shows commits and PRs that mention `TAB-123`.

Principles:

1. **One surface, two scales.** The tracker on the canvas and the tracker full screen are the same UI at different sizes, with the same state (tab, filter, open ticket). Nothing is lost by opening or closing it.
2. **Keyboard first, pointer complete.** Every action has a key; every key has a visible button. The list is operable without a mouse and without a menu.
3. **The ticket is the unit.** Everything else (a card, a PR, a commit, a comment) points at a ticket by its key.
4. **The canvas stays the canvas.** A linked card is still a card you can drag, group and draw connectors to. It only gains a key and a state that the tracker owns.
5. **Swiss.** Grid, hairlines, one typeface for work, numerals that line up, two accents used sparingly (section 11).

Not in this spec: sprints/cycles, time tracking, SLAs, custom workflows beyond states, GitLab/Bitbucket (the integration model leaves room), a public issue portal.

## Decisions (frozen 2026-10-10)

Johan: "go with your picks". The table matches the architecture spec's decisions (docs/tracker-architecture.md, 9b3fbc9) and says what each one means for the screens. These override any earlier text in this file.

| # | Decision | UX effect |
|---|---|---|
| 1 | One workspace-wide prefix, `TAB`. | Keys are always `TAB-n`. No prefix picker in the New issue dialog, the Link dialog or settings. "Also known as" still shows old and imported ids. |
| 2 | Default states: To do, In progress, In review, Done, Cancelled. Categories `completed` and `canceled`. | The state picker, glyph table and board lanes use these five; no Backlog lane in the tracker Board tab or in the default mapping. |
| 3 | No cycles or estimates UI in v1. | No Estimate property, column, filter or sort anywhere; no sprint or cycle views. The field stays in the data. |
| 4 | Plain text titles, Markdown descriptions and comments. | Titles have no formatting. Description and comments are Markdown text with Preview, not a rich-text editor (5.1, 5.2). Smaller build, simpler paste. |
| 5 | Tickets are created online only. | New issue, Create tickets from stickies and the Link dialog's create option are disabled offline with a plain reason; drafts are kept. Edits to existing tickets work offline and sync (section 10). No provisional keys. |
| 6 | Archive only, never delete. | No Delete anywhere; Archive, banner and Restore (5.1). |
| 7 | Sign-in only, no public ticket links. | `/t/TAB-123` always asks for sign-in. No "Share ticket publicly". Copy link copies the signed-in link. |
| 8 | A linked kanban shows the cards made on it; board guests get the ticket, with a warning when the audience is broader. | Default of 9.1 stands. **Linking an existing kanban**: the Link dialog's last step offers a checkbox **"Create tickets for the N existing cards"**, **on by default**, so linking never silently leaves old cards unlinked or silently changes them: the review step lists the keys that will be created, and unticking leaves those cards as plain cards. Cards created afterwards are tickets from the start. When a board has guests outside the workspace, the Link dialog and the card's **Ticket** section show: "N guests on this board will see these tickets." with the names, before the user confirms. |
| 9 | GitHub App; only owners connect repos; logins mapped to members after a one-time link; merge to Done is OFF by default, configurable per repo; comment-only by default. | The Integrations screen's Connect and repo toggles are owner-only (admins see status). A **Link my GitHub account** row appears for each member until done (one click, one OAuth round trip); until then their PRs show the GitHub login. Merge rules start as "no change" per repo (7.4). |
| 10 | Hosted: pending work runs on next wake; webhooks queue. | Integration events may arrive late on a hosted workspace that was asleep: the Integrations activity log shows "Received 14:03, applied 14:09" when the gap is over a minute; there is no spinner or promise of real time. |
| 11 | Linear: import first, then a two-week dual run. | An **Import from Linear** screen (admin): connect, a dry-run report (counts, users matched, states mapped, losses), then run; imported tickets show "Imported from Linear" and their old ids as aliases. |
| 12 | Theme: workspace theme, per-board override, then personal choice. Owners and admins set the workspace theme. The tracker follows its board. | Section 11, Theme. Owners and admins see **Workspace theme** in settings; the board menu keeps its Theme list, now showing "Board theme" with **Use workspace theme** as the first option. |

## 2. Contract (frozen with the tech lead)

Names here are **proposals**. Where the architecture spec already has a name, it wins and this section is edited to match. Marked ⟂ = must be identical in both specs.

### 2.1 Vocabulary ⟂

| Term | Meaning |
|---|---|
| Tracker | One issue database for a workspace, shown by one or more tracker frames. `trackerId`. In v1 one tracker per workspace; the frame shows it. |
| Tracker frame | The board object that renders a tracker. Type `tracker` (frame-like box; see 3.1). Fields: `trackerId`, `view` (current tab id), `focusKey` (open ticket key, optional). |
| Ticket | An issue. Key `PREFIX-N` (`TAB-123`): `PREFIX` is the tracker prefix (2 to 5 capitals), `N` a never-reused integer. The key is permanent; renaming the prefix keeps old keys resolving. |
| State | A named step of the workflow, each with a **category**: `backlog`, `unstarted`, `started`, `completed`, `canceled` (frozen with the architecture spec; the UI says "Done" and "Cancelled" in default state names, the category names are for code and API only). Default states (frozen): To do, In progress, In review, Done, Cancelled (keys `todo`, `in_progress`, `in_review`, `done`, `cancelled`; categories unstarted, started, started, completed, canceled). **No Backlog state is seeded**; the `backlog` category exists for workspaces that add one. |
| Project | A group of tickets with a name, lead, target date, and optional milestones. |
| Milestone | A dated step inside a project. |
| Relation | `blocks` / `blocked by`, `relates to`, `duplicate of` / `duplicated by`, `parent` / `sub-issue`. |
| View | A saved filter + sort + grouping + layout. Personal or shared. |
| Link | A record that ties an outside thing to a ticket: a PR, a commit, a canvas card. |

### 2.2 Ticket fields ⟂

`key`, `title` (one line, up to 200 code points), `description` (Markdown text), `state` (state id), `priority` (API names `none | urgent | high | medium | low`, stored as an integer 0 to 4 in that order), `assignee` (user id), `creator`, `labels[]`, `project`, `milestone`, `estimate` (optional number: stored, **no UI in v1**), `due` (`YYYY-MM-DD`), `parent`, `relations[]`, `links[]`, `createdAt`, `updatedAt`, `archivedAt`.

Card fields that exist today and map: `text` → `title`, `desc` → `description`, `ownerId` → `assignee`, `due` → `due`, `labels` → `labels` (tracker labels replace the board label set for linked cards), lane → `state`.

### 2.3 Card link fields ⟂

The kanban spec reserves `extProvider`, `extKey`, `extUrl` for Linear/Jira. The tracker uses the same flat fields so one mechanism serves both:

| Field on a card | Value |
|---|---|
| `extProvider` | `'tabula'` for a tracker ticket |
| `extKey` | `TAB-123` |
| `extUrl` | the deep link (4.2); derived, never trusted from the client |
| `trackerId` | which tracker (needed when a workspace has more than one later) |

A container with `ext: { provider: 'tabula', tracker, map }` is a **linked kanban**. The real lane-to-state map lives in the tracker's database and is edited only through the Link dialog (9.2). `ext.map` (`{ laneId: stateId }`) is a **server-written copy** the client reads to draw lanes and cannot edit.

### 2.4 Link records and events ⟂

A ticket's `links[]` holds one record per outside thing:

```
{ id, kind: 'pr' | 'commit' | 'card',
  provider: 'github',            // pr, commit
  repo: 'owner/name',            // pr, commit
  number: 482,                   // pr
  sha: 'a1b2c3d…',               // commit (full; shown as 7)
  title: 'Fix lane drop on iPad',// pr: PR title; commit: first line
  state: 'draft'|'open'|'merged'|'closed',  // pr only
  url, 
  author: { login, name, avatarUrl? },
  branch?: 'fix/lane-drop',
  at: ISO time }                 // opened/merged/committed time
```

**Activity events** (the feed, history and notifications read these) ⟂:

`ticket.created`, `ticket.updated` (field, from, to), `ticket.state_changed`, `ticket.assigned`, `ticket.commented`, `ticket.related`, `ticket.unrelated`, `ticket.card_linked`, `ticket.card_unlinked`, `link.pr_opened`, `link.pr_ready`, `link.pr_merged`, `link.pr_closed`, `link.commit_added`, `integration.rule_applied` (rule id, from state, to state).

Every event has `id`, `at`, `actor` (user, or `{ kind: 'integration', provider }`, or `{ kind: 'agent', tokenId }`), `key`, and the payload above.

### 2.5 Deep links ⟂

Tracker links use path routes, so they can be opened directly, refreshed, and handled by the app's sign-in gate.

- Ticket: `/t/TAB-123` on the workspace host. Opens the tracker (full screen on phone, the tracker frame focused on a canvas) with the ticket page open. Works for a signed-in member; others see the normal access screen.
- Board position: `/b/<board>?tracker=<trackerId>&t=TAB-123` places the viewer at the tracker frame with the ticket open.
- Tab or view: `/t/views/<viewId>`, `/t/inbox`, `/t/my`, `/t/board`, `/t/projects/<projectId>`.
- A pasted `TAB-123` in a comment, description or chat renders as a **ticket chip** (key + state glyph + title, one line) that links to `/t/TAB-123`. A key that does not resolve stays plain text.

## 3. The frame on the board

### 3.1 What it is

A tracker frame is a box on the canvas, default **1440 × 900 board units** (a laptop screen; it appears in the new frame Size menu as a preset family), resizable like any frame, never rotated, always above its own board objects in z-order only when selected for typing (it participates in z-order like a frame, so ink and notes can be placed over it if someone wants to annotate).

Object type `tracker`; a frame in every other respect (selection handles, move, copy, lock, layers panel, export as an image of the current view). It is **not** a container for other objects: dropping a sticky on it does not adopt it. Connectors may attach to the frame itself or to a **ticket row** (6.3).

Duplicating a tracker frame makes a second window on the same tracker, with its own tab and filter. It does not copy tickets.

### 3.2 Zoom and pan: two modes

The frame has two modes. The mode is the single most important rule of this surface.

| Mode | When | What the pointer does inside the frame |
|---|---|---|
| **Overview** (frame is small on screen) | The frame is under about **560 px wide on screen**, or it is not focused | It behaves like any object: drag moves it, wheel and pinch zoom/pan the canvas, double-click enters Work mode. Contents are drawn as a **snapshot**: tab bar, the first rows of the current view, a count. No live hit targets inside. |
| **Work** (frame is focused) | Double-click, `Enter`, clicking the tab bar while the frame is large enough, or the **Open** chip | The frame's interior is live: clicks, typing, scroll inside lists. Wheel scrolls the **list**, not the canvas, while the pointer is over a scroll area that can still scroll; at the end of the list or over non-scroll areas, wheel passes through to canvas pan. `Ctrl/Cmd + wheel` and pinch **always** zoom the canvas. Dragging on empty frame background pans the canvas. |

Rules:

1. **Entering Work mode never moves the camera.** A tracker half off-screen stays half off-screen; to get the whole tracker, the user zooms to it (`Shift+2`, "zoom to selection") or presses Full screen.
2. **Leaving Work mode**: `Esc` (first press: closes an open popover or ticket peek; second: leaves Work mode and selects the frame), or click on the canvas outside the frame. `Esc` never closes the tracker's full screen unless nothing else is open.
3. **Scaling**: the interior is real DOM, scaled with the canvas (a CSS transform on a screen-sized surface) down to **40 %** on screen, below that it falls back to the snapshot. Text under 9 px on screen is never drawn live. At 40 to 100 % it is fully live (small but exact); above 100 % it re-lays out at 100 % scale and the extra size becomes sharper text, not a bigger UI (so zooming in to 200 shows the same layout with crisp type, and the user can read it without the UI reflowing).
4. **Frame resize** changes the available layout width (list columns collapse by the breakpoints in 5.1), not the scale.
5. **Snapshot** is cheap and shared: drawn by the board renderer as SVG from a small per-view summary (tab name, up to 12 row summaries, counts) that the tracker publishes; it works for viewers whose tracker panel has not loaded yet, in exports, and in thumbnails.
6. **Presence**: other people's cursors inside a tracker in Work mode appear as the normal named cursors, positioned in frame coordinates. A person's open ticket shows as a small initials badge on that row ("Mara is here").
7. **Multiplayer**: tab, filter and open ticket are **per viewer** (not stored on the object) so that one person's filtering does not change everyone's screen. Only `trackerId`, size and position are shared. `view` and `focusKey` on the object are the **default** for a viewer who has not chosen yet, and what an export or snapshot shows.

### 3.3 Open full screen

- **Open** chip on the frame's top-right corner (visible when selected or hovered, always visible in Work mode), `F` with the frame selected, `Shift+Enter` in Work mode, or the **expand** icon in the tracker's own header.
- Full screen is the board's chrome replaced by the tracker: it fills the viewport, below the board's top bar (which collapses to a thin strip with the board name and a **Back to board** button). It is a route state (`/t/...`) so the browser Back button leaves it, and a refresh returns to it.
- It is the **same component and state** as the frame: tab, filter, scroll position, open ticket. Closing returns to the canvas **exactly where the camera was**, with the frame selected; nothing is re-fitted.
- In full screen the tracker has room for the ticket page as a right-hand **side panel** (list stays visible) on screens over 1100 px, otherwise as a full page.
- `Esc` closes: popover → ticket (back to list) → full screen (back to the board).
- If the person opened a ticket deep link and has no board context (a link from chat or GitHub), the tracker opens full screen with **Back to board** replaced by the workspace's boards menu.

### 3.4 Printing and export

PNG/PDF export of the board draws the snapshot. **Export view as CSV** is in the All issues tab menu. Print of a ticket (browser print) uses a print stylesheet: ticket page only, one column, no chrome.

## 4. Tabs

The tab bar is the frame's top row: five tabs on the left, the **⌘K** command box and **New issue** on the right. In a narrow frame (under 720 board units wide) tabs collapse to their icons plus the current tab's name.

### 4.1 Inbox

Personal. A single list of **things that need you**, newest first, grouped by day:

- Assigned to you, mentioned you, commented on a ticket you follow, state changed on a ticket you follow, a PR you authored was merged, a ticket you created was closed.
- Each row: unread dot, ticket key, title, one-line reason ("Mara commented", "PR #482 merged"), time. Unread rows are bold.
- **Actions** (keyboard in 6): `E` mark done (removes it), `U` mark unread, `S` snooze (to this afternoon, tomorrow, next week, pick a date), `Enter` open the ticket peek, `X` select, `Shift+E` mark all in the selection done.
- A row for a ticket the person can no longer open says "No longer available" (it lost access) and offers only Mark done.
- Counts: the tab shows the unread count (a numeral; never a red badge unless something is overdue and assigned to you).

### 4.2 My issues

A fixed view: assigned to me, not done. Same list as All issues with the filter locked to me, so every list feature works. Sub-tabs (a segmented control, `[` and `]`): **Active** (default: started + unstarted), **Created by me**, **Following**. Grouped by state by default, ordered by priority then due date.

### 4.3 All issues

The workhorse. A **list/table** with these parts, top to bottom:

1. **View bar**: current view name (a menu: personal views, shared views, "All issues", **Save as view…**), then a **Filter** button with active filter chips, then **Group** and **Sort** menus and a **Display** menu (columns, density), then the result count.
2. **Filter bar** (opens under the view bar): chips you build with a keyboard-friendly picker. Fields: state, state category, assignee (incl. *No one*, *Me*), creator, label, project, milestone, priority, due (overdue, today, this week, none, range), created/updated range, has PR, PR state, has relation (*blocked*), parent/sub-issue, text. Operators: is / is not / any of / none of. `F` opens it; type to pick a field, `Tab` to the value, `Enter` to add the chip; `Backspace` on an empty box removes the last chip. A text search box sits at its end (title, description, key).
3. **Group by**: none, state (default), assignee, project, priority, label, milestone, due week. Groups collapse; the group header shows count and, for state, the state glyph.
4. **Sort by**: updated (default), created, priority, due, title, manual (only when ungrouped and in a project). Direction toggles. Sort is a stable multi-key sort (a second key can be added).
5. **Rows** (table, one line each, 36 px comfortable / 28 px compact):

   | Column | Content |
   |---|---|
   | Priority | glyph (4 bars: urgent has the bold mark) |
   | Key | `TAB-123`, tabular figures |
   | State | glyph + name (name hidden under 720 units) |
   | Title | one line, truncated; label chips follow; sub-issue count and PR chip at the end |
   | Project | name |
   | Assignee | initials badge |
   | Due | date; overdue in red text **and** the word "overdue" in the title attribute and live region |
   | Updated | relative time |

   Columns are chosen in **Display**; the frame width decides how many fit (priority, key, state, title, assignee are never dropped; the rest drop right to left).
6. **Inline edit**: with a row focused, `S` state, `A` assignee, `P` priority, `L` labels, `D` due, `M` project, each a small picker opening in place; `1`..`5` in the priority picker. The change applies on pick; nothing needs a Save.
7. **Bulk**: `X` selects the row, `Shift+Arrow` extends, `Cmd/Ctrl+A` selects all in the view; the selection bar replaces the view bar showing the count and the same pickers. One undo step per bulk action.
8. **Saved views**: **Save as view…** stores filters, group, sort, columns and the layout (list/board). A view is **Personal** or **Shared** (workspace members who can edit tickets; only the creator or an admin edits a shared view). Views appear in the view menu and in the **⌘K** box; a view has a stable URL. Edited-but-unsaved views show a **Modified** mark and a **Reset / Save** pair.
9. **Create**: `C` anywhere in the tracker opens **New issue** (a compact dialog on desktop, a full sheet on phone): title, description, and a one-row property bar (state defaulting to the view's group, assignee, priority, project, labels, due). `Cmd/Ctrl+Enter` creates; `Cmd/Ctrl+Shift+Enter` creates and starts another. A row can also be created inline at the end of a group ("+ New issue in In progress").

### 4.4 Board (the tracker's own kanban)

The same filter/view bar over a **kanban of tracker states**: one lane per state (Cancelled hidden by default), cards are tickets. It is the same component as the canvas kanban's card, drawn inside the tracker; dragging between lanes changes state. Group by (rows): none (default), assignee, project, priority.

This tab exists so the tracker works fully without ever linking a canvas kanban. It is the **preferred way to run a sprint-less flow** and it is the thing the canvas kanban mirrors when linked (section 9).

- Lane header: state glyph, name, count; `+` adds a ticket in that state. A lane over a **WIP limit** (state setting, optional) uses the same warn/block rules as the canvas kanban.
- Drag with pointer or keyboard (`Alt+Arrow` or `Space` to lift, arrows to move, `Space` to drop, `Esc` to cancel), mirroring the canvas kanban keyboard.
- Card shows: key, title (up to 3 lines), priority glyph, labels, assignee badge, due chip, PR chip.
- Within a lane, order is **manual** (rank) when the view is ungrouped, else by the view's sort.

### 4.5 Projects

- **List of projects**: row = name, status (Planned, Active, Paused, Completed, Cancelled), lead, target date, a **progress bar** (done / total tickets, with a started segment), ticket count. Filters: status, lead, mine.
- **Project page**: header (name, status, lead, dates), description, **Milestones** (list; each has name, date, progress), the project's tickets (All issues component locked to the project, group by milestone by default), and a **Progress** strip (a step chart of done over time, small, no axes beyond the date range).
- **Milestones**: reorderable list; each has a name, target date, description; a ticket picks one milestone of its project. Completed when all its tickets are done; overdue shows in text.
- **Create project**: `C` while on this tab (name, lead, target date). Archive, not delete, is the default; delete needs a typed confirmation of the name.

## 5. The ticket page

### 5.1 Layout

Two columns when there is room (frame over 900 units wide or full screen over 1100 px), one column otherwise. Left (about 8 of 12 columns): **title, description, sub-issues, relations, linked work, activity**. Right (4 columns): **properties**.

```
TAB-123  In progress ▾                         ⋯  ←  →  ✕
┌───────────────────────────────────────────────┬────────────────────┐
│ Frame size presets do not keep aspect          │ STATE      In progress
│ ───────────────────────────────────────────── │ ASSIGNEE   Mara
│ Description …                                  │ PRIORITY   High
│                                                │ PROJECT    Frames
│ SUB-ISSUES  2 of 4                  +          │ MILESTONE  Beta
│ RELATIONS   blocks TAB-130                  +  │ LABELS     ui  tablet
│ LINKED WORK                                    │ DUE        Fri 16 Oct
│  ◐ PR #482  Fix lane drop     merged  Mara     │ CREATED    Mara, 2 d
│  ● a1b2c3d  Add presets       Mara             │ ON CANVAS  Sprint retro →
│ ACTIVITY                                       │
│  …                                             │
└───────────────────────────────────────────────┴────────────────────┘
```

- **Header strip**: key (tabular, with a **copy link** action on click), state button (a picker), a **Subscribe / Subscribed** toggle (a bell button; `Shift+S`; subscribers get Inbox entries for comments, state changes and linked PRs; you are subscribed automatically when you create, are assigned, comment or are mentioned), then ⋯ (copy link, copy key, copy as Markdown, duplicate, move to project, **archive**; there is no delete), previous/next in the current list (`J`/`K`, also arrows in the strip), close.
- **Title**: Bodoni Moda 800 (the one place it is used at app size; see 11), editable in place (click or `Enter`), one line that wraps.
- **Description**: Markdown text (no rich-text storage). One editing surface: a plain text area with Markdown shown as typed, a **Preview** toggle (`Cmd/Ctrl+Shift+P`) that renders it, and light helpers that insert text (`-` continues a list, `Tab` indents it, `@` mentions people, `TAB-` autocompletes ticket keys); paste an image to attach (workspace file store; size limit from architecture). Autosaves 800 ms after the last key; shows **Saved** / **Saving** / **Offline, will sync** in the header strip.
- **Properties column**: each row is a label (small caps) and a value that opens a picker. Same keys as the list (`S A P L D M`). Read-only roles see plain values.
- **Sub-issues**: a progress mini-bar ("2 of 4"), rows (key, state glyph, title, assignee), **+** adds one (inline title field), drag to reorder, `Enter` opens one. A sub-issue's page shows its parent as a breadcrumb in the header.
- **Relations**: grouped by type; each row has the other ticket's key chip, state glyph, title, and a remove (×) on hover/focus. **+** opens a picker: choose relation type, then search tickets by key or title. `blocked by` an open ticket shows a **Blocked** mark on the ticket's list row. Duplicate: marking duplicate closes it (state Cancelled, category cancelled) after a confirm and keeps the pointer.
- **Linked work** (7.1): PRs and commits from GitHub, and the **On canvas** link (9.5).
- **Activity** (5.2): comments and history in one feed.
- **Also known as**: under the title, one quiet grey line ("Also known as ENG-45, OLD-12") for old prefixes and imported Linear ids; each opens this ticket when used in a link or search. Absent when there are none. Search and ⌘K match aliases.
- **Archived**: an archived ticket is hidden from every ordinary view and search (the filter has **Include archived**). Its page shows a banner across the top, "Archived on 12 Oct. Restore", with a **Restore** button (state and card come back); fields are read-only until restored.

### 5.2 Comments and history

One chronological feed, oldest first (so the composer sits at the bottom), with a filter **All / Comments / History** (default All; History collapses runs of field changes: "Mara changed state, assignee and priority · 3 changes").

- **Comment**: author, time, body (Markdown, rendered as the description is, smaller), **edit** (own), **delete** (own or admin, leaves "Comment deleted" row), **react** (the board's emoji picker; a small reaction row), **reply** (one level of threading). `Cmd/Ctrl+Enter` posts. `@` mentions notify the person (Inbox). Pasting a PR or commit URL renders its chip.
- **History rows**: a glyph, "Mara moved this from Todo to In progress", time. Field changes show old → new. Integration events are attributed to the integration ("GitHub · merged PR #482 moved this to Done" with the rule noted). **Actors that are not people** (an agent's access token, the GitHub integration, an import) never get a person's avatar: they show a square **label badge** ("Agent · claude-code", "GitHub", "Import") in the same place and the same grey, so a feed can be scanned for who is human. The ticket's creator line says "Created by Mara" or "Created by agent claude-code" / "Created from GitHub" / "Imported from Linear" from the `source` (`app`, `import`, `mcp`, `integration`).
- **Resolve**: threads can be resolved (collapsed with "Resolved by Idris" and re-opened by a reply).
- **Edit history**: edited comments show "edited" with the time; there is no per-edit diff in v1.
- **Unsent drafts** are kept per ticket in the browser.
- Time shows relative under a week, then a date; the absolute time is in the title attribute and tooltip. Everything is live: new comments appear without a refresh, and **the viewer's scroll never jumps** (a "New comments ↓" pill when they are not at the bottom).

### 5.3 Peek vs page

Opening a ticket from a list in the frame shows it **in place of the list** inside the same frame (a Back arrow, or `Esc`, returns to the list with the scroll position and selected row preserved). In full screen over 1100 px it opens as the right-hand side panel so the list stays visible; `Shift+Enter` or the **expand** icon in the panel makes it the whole area. Next/previous ticket stays within the list the person came from.

## 6. Keyboard-first

The tracker captures keys only in Work mode or full screen. On the canvas, with the frame selected but not entered, **only** `Enter` (enter Work mode), `F` (full screen) and the normal canvas keys apply, so the board shortcuts are never swallowed by a tracker the person is not using.

### 6.1 Global (inside the tracker)

| Key | Action |
|---|---|
| `Cmd/Ctrl+K` | Command box: go to tab, ticket by key or title, run an action ("assign to me", "move to project…"), saved views |
| `G` then `I / M / A / B / P` | Go to Inbox / My issues / All issues / Board / Projects |
| `C` | New issue (or new project on Projects) |
| `/` | Focus the list's search/filter box |
| `F` | Open the filter bar |
| `?` | Shortcut sheet (a list; also reachable from the menu, so it is never keyboard-only) |
| `Shift+Enter` | Full screen / expand panel |
| `Esc` | Close the topmost thing: picker → filter bar → ticket → full screen → Work mode |
| `Cmd/Ctrl+Z`, `Shift+Cmd/Ctrl+Z` | Undo / redo the last tracker change (the toast says what: "State changed. Undo") |

### 6.2 In a list or board

| Key | Action |
|---|---|
| `↑ ↓` or `J K` | Move the row cursor (a 2 px cobalt left bar, plus the row's background; never colour alone: the focused row also draws an outline in forced-colours) |
| `← →` | Collapse/expand a group; on the board, move between lanes |
| `Enter` | Open the ticket |
| `Space` | Peek (a small preview) / on the board lift or drop a card |
| `X` | Select; `Shift+↑↓` extends; `Cmd/Ctrl+A` all |
| `S A P L D M` | State, assignee, priority, labels, due, project pickers on the cursor row or selection |
| `Cmd/Ctrl+Shift+C` | Copy the ticket link; `Cmd/Ctrl+Alt+C` copies the key `TAB-123`. **Copy branch name** (`tab-123-frame-size-presets`) is in the ⋯ menu and ⌘K |
| `Home / End`, `PgUp / PgDn` | First/last, page |
| `Delete` / `Backspace` | Archive (with undo toast). Tickets are never deleted |

### 6.3 On the canvas

- A ticket row or card can be the target of a **connector** (draw an arrow from a sticky to `TAB-123` on a linked kanban card; on a tracker frame list, connectors snap to the frame edge only, not to rows, because rows move).
- `Cmd/Ctrl+K` on the canvas, with a tracker frame present, also offers **Ticket TAB-…**: jumps to the frame and opens the ticket.

### 6.4 Pickers

Every picker is a type-ahead list: arrows move, `Enter` picks, `Esc` closes without a change, digits pick by position where the list is short (priority 0..4, state 1..6). The picker opens at the row (or the property) it was called from, never at a fixed place.

### 6.5 Announcements

A visually hidden live region says what changed ("TAB-123 moved to In progress", "Assigned to Mara", "3 selected"). Lists use `role="grid"` with row and cell roles; the board uses the canvas kanban's accessible pattern.

## 7. Integrations: GitHub

### 7.1 On a ticket

**Linked work** is a section on the ticket page (before Activity) with one row per link, newest first, collapsed to the 5 most recent plus "Show 7 more":

- **Pull request row**: state glyph (draft, open, merged, closed, each its own shape and word), `#482`, title (one line), repo `owner/name` (grey), author initials badge and name, relative time of the last state change, and an **external-link** affordance (the whole row opens GitHub in a new tab; a separate **Copy link** appears on hover/focus). A merged PR whose rule moved the ticket says "Moved this to Done" on a second line in grey.
- **Commit row**: a small dot glyph, `a1b2c3d` (7 characters, mono, tabular), first line of the message, repo, author, time. Commits belonging to a linked PR are **grouped under that PR** (collapsed, "4 commits") so a busy PR is one row.
- **How a link is made**: a PR or commit **mentions the key** in its title, branch name, or message (`TAB-123`, `fixes TAB-123`, `closes TAB-123`). Unknown keys are ignored. The ticket page also has **Link a pull request** (paste a URL) for the rest.
- **Unlink**: a link made by mention is removed automatically if the mention is removed; a manually pasted link has a **Remove** action. Removing is allowed for editors; it adds a history row.

**Branch name helper**: ⋯ **Copy branch name** copies `tab-123-short-title` (lowercase, ASCII, 50 characters). A GitHub branch named that way links without a message mention.

### 7.2 In the activity feed

New history rows, each with the GitHub mark in the glyph column and the actor shown as the **GitHub user** (not a workspace member unless the account is linked):

- "**PR #482 opened** by Mara · Fix lane drop on iPad" (link)
- "**PR #482 ready for review**"
- "**PR #482 merged** by Mara · moved this to **Done** (rule: merge → Done)"
- "**PR #482 closed** without merging"
- "**Commit a1b2c3d** by Mara · Add presets" (consecutive commits by the same author within an hour collapse: "3 commits by Mara")

A merged PR also **posts a comment-like system row on the ticket and sends an Inbox entry** to the ticket's assignee and creator ("PR #482 merged"), not a real comment, so the comment count stays the human count. These rows are not editable or deletable; History filter shows them; the Comments filter hides them.

### 7.3 Compact PR chip on a canvas card

On a linked canvas card (9.3), when the ticket has at least one PR, a **chip** shows the most relevant one: the open PR if any (newest), else the latest merged, else the latest closed.

```
[◐ #482]   open       [● #482]  merged      [○ #482]  closed     [◌ #482]  draft
```

- Size: 18 px tall, 4 px padding, glyph + `#482`, Instrument Sans 600 11 px, square corners, a 1 px ink border, light-paper fill; **merged** inverts to ink fill with light-paper text, so it reads in monochrome and at 40 % zoom without colour. Open and draft use the outline; closed has a strike through the number.
- More than one PR: `#482 +1`.
- Click: on the canvas it opens the ticket page's Linked work (in the tracker frame or a peek); **Cmd/Ctrl-click** opens the PR on GitHub. Tooltip and accessible name: "Pull request 482, merged, Fix lane drop on iPad".
- At low zoom (card text under 9 px on screen) the chip collapses to the glyph alone.
- It sits in the card's meta row, after the owner badge and due chip, never replaces them; in the narrow lane width (200) it wraps to a second meta row.

### 7.4 Integrations screen

Reached from the tracker's ⋯ menu (**Integrations**) and the workspace settings; admin only to change, members can read the status. It is a full page inside the tracker frame (or full screen), not a modal.

**Layout**: a list of providers ("GitHub", disabled placeholders "GitLab · later", "Slack · later" are **not shown** in v1; no teasers). One card for GitHub:

1. **Connection**: state ("Connected as `acme` (organisation)", "Not connected"), who connected it and when, **Connect GitHub** / **Disconnect**. Connect goes through the GitHub App install flow in a new tab; the page then shows "Waiting for GitHub…" and resolves by itself when the install webhook arrives (or **I've installed it, check again**). Scopes are listed in plain words before the button: "Read pull requests and commits, read repository names. Tabula never changes your code."
2. **Repositories**: a table, one row per repository the GitHub App can see: a toggle **Link this repo**, the repo name, default branch, and **Last event** time. Search box, **Select all visible**. A repo with the toggle off sends nothing to Tabula (the app is told, not just filtered).
3. **Rules** (per repo, with an **All repos** default set): sentences with pickers, never a form of fields. **Every state change starts as "no change"**: a new connection only links and comments until an owner picks a state for a rule (frozen with the architecture spec's "comment only until opted in"). The examples below show the pickers an owner would set:

   | Rule | Sentence |
   |---|---|
   | PR opened | When a pull request that mentions a ticket is **opened**, move the ticket to **[In progress ▾]** |
   | Ready for review | When it is **ready for review**, move to **[In review ▾]** |
   | PR merged | When it is **merged**, move to **[Done ▾]** |
   | PR closed (not merged) | When it is **closed without merging**, move to **[no change ▾]** |
   | Magic words | **`fixes TAB-123`** and **`closes TAB-123`** in the PR description count as the ticket being completed when the PR merges; plain mentions only link (toggle, on) |
   | Only if | the ticket is not already completed or canceled (toggle, on): a rule never reopens a finished ticket |
   | Branch pattern | optional: only PRs targeting **[main ▾]** apply a state change (default: the repo's default branch) |
   | Comment back | optional, off: Tabula comments on the PR with the ticket title and link |

   Each rule shows a one-line **"Would do this"** preview from the last real event ("PR #482 merged → TAB-123 moves from In review to Done"), and **Test with the last event** that runs the rule in dry-run and says what it would do.
4. **Activity log**: the last 50 integration events with a status each (Applied, Linked, Ignored: reason, Failed: reason), filterable; each row links to the PR and the ticket. This is the debugging surface and the answer to "why did my ticket move?".

**Phone**: the screen is one column; the repo table becomes a list with the toggle on the right; rules are sentences stacked, each picker a full-width control.

### 7.5 Empty and error states (integrations and linked work)

| Situation | What the user sees |
|---|---|
| No integration, no links | Ticket page: the **Linked work** section is hidden entirely (no empty box). Integrations screen: "Link your code. Merged pull requests will move their tickets." and **Connect GitHub** (admin) or "Ask an admin to connect GitHub." (member). |
| Connected, no repo linked | "GitHub is connected, but no repository is linked yet." + the repo table with every toggle off and **Link repositories**. |
| Repo linked, no events yet | "Waiting for the first pull request. Mention a ticket key like TAB-123 in its title or branch." with a **Send a test event** (admin). |
| A PR mentions a key that does not exist | The PR is shown in the Activity log as **Ignored: unknown ticket TAB-9999**; nothing appears on tickets. |
| Rule target state was deleted | The rule row shows **State removed. Pick another.** in red text with a warning glyph; the rule is paused (not applied) until fixed; an Inbox item for admins says so once. |
| GitHub is unreachable or the app was uninstalled | A banner at the top of the screen and on the tracker header's ⋯: "GitHub access was removed. Existing links stay; new pull requests will not appear." with **Reconnect**. Linked work keeps showing stored data, with a grey "as of 12 Oct, 14:03". |
| Webhook delivery failing | Activity log row **Failed: could not apply (retrying)**; after retries stop, **Failed** and a **Retry** button for admins. Never silent. |
| Rate limited | "GitHub is slow to answer. Updates are delayed." (a grey banner, auto-clears). |
| Permission lost on a repo | The repo row shows **No access** and its toggle is disabled. |
| A ticket with links is archived | Links are kept with the ticket; new PR events still link to it and show on the archived ticket, but rules do not change its state. |
| Merged PR but the ticket was moved by someone since | The rule only applies if the ticket is not completed/canceled; otherwise history shows "PR #482 merged · no state change (already Done)". |
| Two PRs for one ticket | Both show; the chip shows the open one. A merge applies its rule once, a later merge applies to a ticket already done and so does nothing. |
| Offline | The Integrations screen is read-only with "You are offline." |

Every error message says what happened, what still works, and the one thing to do.

## 8. Phone

At 360 to 600 px wide the tracker is **always full screen** (the canvas frame is only a snapshot card that says "Open tracker"); the on-canvas Work mode does not exist on a phone, because a screen-sized frame at phone zoom has no usable interior. Tapping the snapshot opens full screen; Back returns to the board with the same camera.

- **Navigation**: a bottom tab bar with five icons and labels (Inbox, Mine, All, Board, Projects), each 56 px tall minimum with the safe-area inset; the top strip shows the tab name, a search button and **+** (New issue). Hidden when the keyboard is open.
- **Lists**: rows become two lines: line 1 priority glyph, key, title; line 2 state glyph + name, assignee badge, due, PR chip; 64 px tall, full-width tap target. Group headers stick. Pull-down refreshes only when offline sync is pending (never as the only way).
- **Swipe actions** on a row (only as a shortcut; every one is also in the row's ⋯ and the ticket page): swipe right = **Assign to me**, swipe left = **Done** (state category completed), with an Undo toast.
- **Filter**: a **Filter** button opens a bottom sheet with the same fields, applied as chips; **Save as view** at its end.
- **Board**: lanes are horizontal pages (one lane per screen with the neighbours peeking 24 px), a lane switcher strip (state glyphs + counts) on top; **Move to…** on the card's ⋯ sheet is the move action (drag between lanes needs two screens and is not the primary path), long-press-drag works within the lane to reorder.
- **Ticket**: one column; properties are a horizontally scrolling **chip row** under the title (each chip a picker sheet), then description, sub-issues, relations, linked work, activity. A sticky **comment composer** bar at the bottom ("Add a comment…") expands upward; it sits above the keyboard (uses the visual viewport as the emoji picker does).
- **Pickers** are bottom sheets with 48 px rows and a search field that does not autofocus unless the list is long (over 12 items), so the keyboard does not open over a short list.
- **Targets**: 44 px minimum everywhere; the key chip, state glyph and PR chip in a list row are not separate targets; the whole row opens the ticket.
- **Integrations screen**: 7.4, phone paragraph.
- Landscape phone behaves like a small tablet (side panel disabled under 700 px wide).

Tablets (iPad): the frame on the canvas is touchable in Work mode (a two-finger pan/pinch always moves the canvas); full screen uses the two-column layout; the keyboard shortcuts work with a hardware keyboard.

## 9. Linking a canvas kanban to the tracker

### 9.1 What linking means

A kanban container can be **linked** to a tracker. After linking:

- **Every card is a ticket.** A card with no `extKey` gets a new ticket created from it (title, description, owner → assignee, due, labels) and an `extKey`. A ticket made from a card starts in the state its lane maps to.
- **Every lane maps to a tracker state** (one lane per state in v1; a state may have no lane).
- **The ticket is the source of truth** for title, description, state, assignee, due, labels, priority. The card is a **view** of it. Moving a card between lanes changes the ticket's state; changing the ticket's state moves the card to the lane mapped to it.
- **Position** within a lane (`rank`) and the card's canvas look stay on the board; they are not tickets' data.
- A new ticket created in the tracker **appears on the linked kanban** in the lane for its state if the container opts in: **Show tickets: All / Filtered (a saved view) / Only cards made here** (default **Only cards made here**, so linking a retro board does not fill it with 400 backlog tickets).
- Deleting a card asks: **Delete the card only (ticket stays)** or **Delete card and archive ticket** (default: card only). Archiving a ticket in the tracker removes its card from the board's lanes (the card object is kept by history for restore); **Restore** on the ticket brings the card back to its lane.

### 9.2 The linking flow

Entry: container ⋯ menu → **Link to tracker…** (also on the tracker's Board tab menu: **Link a canvas kanban**, and in ⌘K).

A three-step dialog (a sheet on phone), each step a single decision:

1. **Choose the tracker and where new tickets go**: tracker (one in v1; shown for the future), **Project** (optional; every new ticket from this board joins it) and **Team labels** to add (optional).
2. **Map the lanes**: a two-column list, left each lane (name + card count), right a state picker (default: matched by name, else by the lane's **stage** `todo/doing/done` → Todo/In progress/Done; unmatched lanes default to To do with a visible "Check this" mark). A state can be picked for one lane only: a state already taken is shown greyed with "Used by Doing" in the picker, so the map is always unique. A warning line, not an error, for a state with no lane ("Cancelled has no lane: cards moved there in the tracker will leave the board"). Option: **Create lanes for states without one** (off by default).
3. **Review**: "**18 cards will become tickets** (TAB-124 to TAB-141). Their state follows the lane." with a table preview of the first 6 and **Link and create tickets**. The numbers are reserved at confirmation so concurrent linking cannot collide. A **Dry run** preview needs no click; Cancel changes nothing.

Unlinking (⋯ → **Unlink from tracker**): asks "Keep the tickets (cards become plain cards that show the key) or delete cards' keys (tickets stay in the tracker, cards forget them)?" Default keep keys as plain text on the card.

### 9.3 What a linked card looks like

A linked card is the normal canvas card (kanban spec) with these changes, in order, in a **header line**:

```
┌────────────────────────────┐
│ TAB-124            ▲  ◐    │  key (left), priority, state glyph (only when the lane maps to >1 state or the state differs from the lane's)
│ Frame size presets         │  title, up to 3 lines
│ #ui  #tablet               │  labels
│ [M] Fri 16   [◐ #482]  3✎  │  owner badge, due, PR chip, comment count
└────────────────────────────┘
```

- **Key** in Instrument Sans 700, tabular, grey, small; it is the card's anchor to the tracker and the thing to click: **click the key** opens the ticket (peek in the tracker frame if one exists on this board, else a ticket sheet, else the deep link); the card body keeps the card behaviours (select, drag, double-click to edit title).
- **Priority** glyph appears for urgent and high only (not for medium/low/none) to keep cards calm.
- **Left border**: a 3 px ink bar, the **linked marker**; unlinked cards have no bar. It is a shape cue, so it does not rely on colour.
- A card whose ticket is **done** shows the struck-through title and a check (the kanban `done` stage already does the check); **canceled** is greyed with a cross.
- A card with a **blocked** ticket shows a small bar glyph and the word "Blocked" at the end of the meta row (and in the accessible name).
- **Out of sync**: if the ticket cannot be reached (offline, access lost), the card shows a grey **cloud-off** glyph in the header and "Showing the last saved version"; edits are allowed locally and queue; for lost access the card shows "No access to TAB-124" and its fields as last known, locked.
- **Pending** (being created): a thin animated line under the key (one pulse, then static for reduced motion) until the key is assigned; the card is usable meanwhile.
- **Collapsed size** (narrow lane, 200): key + title only; the meta row wraps.
- **Low zoom**: the same rules as cards (text hides under 9 px); key and linked bar remain.

**Moving**: dragging a linked card to a lane changes the ticket state to the lane's mapped state (a toast "TAB-124 moved to In review" with Undo). Dropping it on a lane with **no mapping** is refused with "That lane isn't linked to a state. Map it in Link to tracker." The WIP limits on the lane apply as before.

**Editing**: card fields edit the ticket in place; conflicts follow the tracker (last write wins per field; the card shows "changed by Mara" briefly via the same pulse as other people's edits).

**The card dialog** gains a **Ticket** section at the top (key, state, a link **Open ticket**, **Copy key**, **Unlink from tracker**) and the property fields write through to the ticket.

### 9.4 Mapping rules in detail

- **One lane per state, one state per lane** within a linked kanban (v1, frozen with the architecture spec: otherwise a ticket moved in the tracker could not choose its lane). A ticket moved to a state lands in that state's lane at the **end**. Two lanes that want the same state ("Next" and "Later" both Todo) means one of them stays unmapped.
- A state with no lane: the ticket leaves the board's visible lanes (the card is hidden from the container, kept in a hidden **Unlaned** drawer on the container header showing a count "3 elsewhere", so nothing is lost and the user can map a lane).
- Renaming a lane never renames a state; the mapping is by id.
- Deleting a lane that is mapped asks where its cards go (a state picker: "Move the 6 cards to…") and updates the map.
- Adding a lane asks nothing: it is unmapped and shown with a **Not linked** chip until mapped, and cards dropped there are refused (above).

### 9.5 The other direction: the ticket knows its card

The ticket page's **On canvas** property lists each linked card as "Sprint retro → Doing" with the board name, the lane, and a **Go to card** link that centres the camera on the card (board deep link with `card=`). A ticket can be on several boards (several boards linking the same project); each is a row. A ticket with no card shows **Add to a board…** that offers the linked kanbans (creates its card in the lane for its state).

### 9.6 Making a ticket from loose things

- A **sticky** or **loose card** → **Turn into ticket** in the quick-action bar when the board has a linked kanban or a tracker (asks only which project and state if it can't infer): the sticky becomes a card in the kanban's lane and a ticket; the original text is the title.
- **Selection of stickies → Create tickets** (one per note, in the linked kanban's first lane for Todo, or in the tracker's first unstarted state, To do, if no kanban is linked): the workshop-to-backlog move. Shows the count and the first titles before it runs; one undo step.
- Pasting a tracker deep link on the canvas makes a **ticket card** (linked card on the nearest linked kanban, or a free-standing card with the key) instead of a link preview.

## 10. States, loading, errors (the tracker as a whole)

| Situation | Behaviour |
|---|---|
| First open, no tickets | **Inbox**: "Nothing needs you." (Bodoni, one line) + a grey sentence "Tickets that are assigned to you or mention you land here." **All issues**: "No issues yet." + **New issue** (`C`) + **Import from Linear / CSV** (admin). **Board**: the empty lanes with "+ New issue" in each. **Projects**: "Group tickets into projects with milestones." + **New project**. |
| Loading | A skeleton of 8 rows (grey hairlines, no animation under reduced motion). The tabs, view bar and **New issue** are usable immediately. Under 200 ms nothing shows. |
| Filter returns nothing | "No issues match." + the active chips and **Clear filters**. |
| Offline | A thin grey line in the header: "Offline. Changes are saved here and will sync." Editing existing tickets keeps working on loaded data and syncs later. **Creating a ticket needs a connection**: **New issue**, **Create tickets** and the Link dialog's create option are disabled while offline with "Needs a connection to get a ticket number." (the draft stays, so nothing typed is lost). There are no provisional keys, so numbers have no gaps. |
| Sync conflict on a field | Last write wins; the loser sees a toast "Mara changed the title at the same time. Yours was kept / replaced" with **See history**. |
| Ticket not found / no access | Page: "TAB-999 doesn't exist, or you don't have access." + **Go to All issues**. Never reveals which. |
| Permission: read-only member | Properties show as plain text; composer says "You can read this tracker."; hidden actions, not disabled ones. |
| Rate or size limit | "That's too long (4,000 characters max)." right at the field with the count. |
| Save failure | The header strip says **Not saved. Retry** (a button); the draft stays on screen; nothing is dropped silently. |
| Destructive actions | Archive is undoable by toast. Tickets cannot be deleted. Removing a card's link to a ticket is a separate action (9.2, 9.3) and never archives the ticket. |

Empty-state headlines are the **only** body-adjacent use of Bodoni Moda besides ticket titles and numerals; they are one line, never a paragraph, never an illustration, with one clear next action.

## 11. The Swiss look

The tracker lives inside a tool whose own chrome is the dark **ink toolbar**; the tracker's surface is the **paper** side of the brand (`docs/brand.md`): content on `--tb-c-paper-hi`, rules in ink, one typeface for work.

**Grid and rhythm**
- A 12-column grid inside the frame with 24 px gutters at full screen, 16 px in a small frame; an 8 px baseline. Everything aligns: the key column, state column, title column and the property labels share their left edges across rows and pages.
- Rows separate with **1 px hairlines** in `--tb-c-grey` at 25 %; section heads with a **2 px ink rule** above (the brand's magazine rule). No cards-in-cards, no shadows and no gradients. The board content keeps its square geometry; surrounding app chrome uses the shared UI radius tokens.
- Whitespace does the grouping: 24 px between ticket sections, 8 between rows' content, heads align to the grid, never centred except empty states.

**Type** (the brand has two faces; the tracker uses them as follows)
- **Instrument Sans** for everything that is work: list rows 14 px/20 (13 px compact), properties, comments 15 px/22, buttons 700, labels 11 px **uppercase** 700 with 0.14em tracking. **Tabular figures** (`font-variant-numeric: tabular-nums`) for keys, counts, dates and times so columns line up.
- **Bodoni Moda 800** only at 20 px and up: the **ticket title** (28 px page, 22 px peek), **tab empty states**, **big numerals** (project progress "12 / 18"; the brand rule "no Bodoni under 17 px" holds, so tab counts stay Instrument Sans). The **one italic turn** at the end of an empty-state headline ("Nothing needs *you*.").
- Ticket key: Instrument Sans 700 with `TAB-` in grey and the number in ink, so the number scans; in the page header the key is Bodoni Italic 500 22 px in red **only** when the ticket is overdue and assigned to the viewer, otherwise ink. (Red is the rare accent.)

**Theme**
- Johan's rule: a theme can be set for the whole **workspace** and per **board**, and the board overrides. The tracker frame follows **the board it sits on** (resolved theme = board theme, else workspace theme, else the person's own choice). In full screen the tracker keeps the theme of the board it was opened from; opened from a deep link with no board, it uses the workspace theme.
- Today the app has neither: the theme is a **per-browser personal setting** (`driftboard:theme` in local storage, chosen in the board menu's Theme list; `applyTheme` sets the colour variables on the document). Workspace and per-board themes are new work (a stored `theme` on the workspace and on the board, and the resolution above); the tracker reads the same colour variables as the board, so it needs nothing of its own once they exist. The tracker's ink and paper treatment below is defined against the variables (`--paper`, `--ink`, `--rule`, `--signal`, `--danger`), not fixed hex, so every theme (Default, Ayu, Kanagawa, Matrix, Evergreen) works.

**Colour**
- Ground `paper-hi` `#F7F5F0`; text `ink` `#121216`; secondary `grey` `#55555C`; **cobalt** `#2347F5` for focus, selection, the row cursor, links and the active tab's underline (3 px); **red** `#D42A18` for overdue, errors, and urgent only. State glyphs are **ink**, never rainbow, so a screen of tickets reads as a page, not a dashboard; **colour is never the only signal** (every state has a shape and a word; overdue has text).
- Dark scheme: ground is the board's dark ground, text light paper, the lighter cobalt and red of the brand; hairlines at 30 % light paper. Same layout, same glyphs.
- Labels are outlined chips (1 px border in the label colour, ink text) with the name always visible, so label colours add information without carrying it alone.

**State glyphs** (16 px, 1.5 px stroke, square caps, geometric; ink)

| Category | Glyph | Meaning |
|---|---|---|
| backlog (only if a workspace adds one) | dashed circle | not planned |
| unstarted (To do) | empty circle | planned |
| started (In progress) | circle with the right half filled | moving |
| started (In review) | circle with three quarters filled | nearly |
| completed | filled circle with a check | finished |
| canceled | circle with a cross | dropped |

Priority is four ascending bars (filled = level; urgent is a filled square with an exclamation mark); none is a dash. All have text equivalents.

**Chrome of the frame**
- Header: tabs as text (Instrument Sans 600 14 px, uppercase off), active tab a 3 px cobalt underline and ink text, inactive grey; tab bar sits on the 2 px ink rule. No pill buttons, no icon-only tabs above 720 units.
- Buttons: primary = ink fill, light-paper text, 8 px radius, turns cobalt on hover (the site turns red; in-app the accent is cobalt); secondary = 1 px ink border with the same radius. Height 32 px in a frame, 44 px on a phone.
- Focus ring: 2 px cobalt outline, 2 px offset, always; never removed.
- Motion: 120 ms for hover and picker; row reorder 160 ms; one pulse for incoming remote changes; **none** under `prefers-reduced-motion` (state changes cut).
- The **snapshot** (3.2) uses the same type and rules, so zoomed far out the tracker reads as a printed table on the canvas: key column, title column, a state glyph; **no** tiny text under 9 px; when too small it is just the grid of hairlines and the frame's name in Bodoni.
- Hard paper motifs (torn edges, tape, cut-outs) **do not** appear inside the tracker: it is an instrument, not an illustration. The exception is the empty-state of Projects and Inbox, where a single hand mark (one red circle) may circle the primary action, once per screen, at most.

## 12. Accessibility

- All of section 6 is the keyboard model; a visible button exists for every shortcut.
- Roles: lists `grid`, rows `row`, tabs `tablist`, pickers `listbox`, ticket properties a `dl`, the feed a `feed` with `article` per entry; live region for changes (6.5).
- Contrast: all pairs follow the brand's tables; grey text only on paper-hi, 4.5:1; non-text (glyphs, focus) 3:1.
- Touch targets 44 px on touch devices; list rows are whole-row targets.
- Reduced motion, forced colours (glyph shapes, outlines), 200 % zoom (the layout reflows by the frame-width rules) and screen-reader order (title, properties, description, relations, linked work, activity) are tested.
- The canvas snapshot has an accessible name ("Tracker, All issues, 214 issues") and is a single focus stop; **Enter** enters it.

## 13. Build slices (for planning, not a promise)

1. Tracker frame object, snapshot, Work mode/full screen, All issues list with filters and ticket page (no integrations, no linking).
2. Inbox, My issues, saved views, keyboard model, command box.
3. Board tab and the **linking** of a canvas kanban (9), with the card changes.
4. Projects and milestones.
5. GitHub: link records, activity rows, PR chip, Integrations screen and rules.
6. Phone layout and polish; import from Linear.

Each slice ships with a visual-check state at 360, 390 and 1280 in light and dark, and a keyboard-only test.

## 14. Questions

Closed by the frozen decisions above: one prefix, default states, linked-kanban visibility (and the existing-card prompt), online-only creation, Markdown text, GitHub identity, merge default, sign-in only, Linear import, theme. Still open for Johan:

1. **Who sees "guests will see these tickets"?** Everyone who links, or only owners and admins (proposed: whoever links)?
2. **Personal theme vs board theme.** Does a board or workspace theme win for everyone on that board (proposed, so a shared screen looks the same to all), or may a person keep their own?
3. **Workspace theme default for new workspaces.** The product default theme, or the paper light treatment of this spec?
4. **Notifications.** Inbox only in v1 (proposed), or also email for mentions and assignments?
