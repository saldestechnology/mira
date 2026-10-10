# Tabula brand guide

The graphic profile, taken from landing variant #27 "Mixed Media II: Editorial" (TAB-72, picked by Johan; TAB-196). It covers the website, docs, social images and print. The app itself stays Swiss, with its own UI and themes (`src/themes.ts`): Johan decided this on 2026-10-09. Editorial is the profile for the landing page, marketing and docs. The tokens here are prefixed `--tb-`, so they never clash with the app's.

Files:

- `design/brand/index.html`: the visual guide, built with the profile itself.
- `design/brand/tokens.json`: every token. `tokens.css` is generated from it with `node design/brand/build-tokens.mjs`.
- `design/brand/assets/`: the wordmark, tape, marks, paper, cutouts and torn edges (see Asset kit).

## Essence

Tabula looks like an art magazine about working together. Real things (photographed hands, scissors, tape, a marker circle) are pasted onto cream paper next to the real board UI, on a strict grid, in ink, cobalt and one red.

The idea is the headline: **paste your thinking together.** The collage is what a team does on a board. The editorial frame says it is considered, open and made by people: local-first, open source, a tool for teams, not a gadget.

## App UI

The app keeps its Swiss grid, hairline borders and calm surfaces, with gently rounded UI chrome. Its shared radii are 4 px for chips and small marks, 8 px for controls and menu rows, 12 px for toolbars, trays, menus and popovers, and 14 px for dialogs and sheets. The radius tokens are theme independent. Board content keeps its own geometry: stickies, shapes, frames, text, images, connectors, kanban cards and lanes, cursors and selection handles do not inherit the chrome radii. The text editor overlay matches the board object it edits.

## Logo and wordmark

The logo is the word **Tabula** followed by a red square full stop. There is no separate symbol yet: four favicon monogram options are on the first-look page (see First look).

**Construction**

- Bodoni Moda ExtraBold (800), tracking −0.02em, set at optical size 28. The shipped SVGs are outlines, so no font is needed to show them.
- The full stop is a **square**, not a round dot or the font's period: side 0.30em, 0.22em after the "a", bottom on the baseline.
- Colours: letters ink `#121216`, square red `#D42A18`.

**Files** (`design/brand/assets/wordmark/`)

| File | Letters | Square | Use on |
|---|---|---|---|
| `tabula-wordmark-ink.svg` | ink | red | paper, light paper, white |
| `tabula-wordmark-paper.svg` | light paper | red | ink |
| `tabula-wordmark-on-cobalt.svg` | light paper | light paper | cobalt, red, photos |

On cobalt the square turns light paper because red on cobalt is 1.26:1 and disappears. The same file works on a red block.

**Clear space**: the cap height of the T on every side (0.75em, about the width of the "a"). Nothing else enters it: no tape, no marks, no cutouts.

**Minimum size**: 80 px wide on screen (the square is then about 6 px), 20 mm in print. Smaller than that, write "Tabula" in the body face instead.

**Don'ts**

- Don't tilt, tear, tape or collage the wordmark. Everything around it may be pasted; the name is set straight.
- Don't recolour the letters red or cobalt, and don't put the red square on cobalt.
- Don't swap the square for a round dot, a period or an asterisk.
- Don't set it in another face, outline it, add a shadow, or stretch it.
- Don't put it on a busy cutout or under the paper grain at more than 20 %.

## Colour

One palette, used everywhere, including every image brief.

| Token | Hex | Role |
|---|---|---|
| `--tb-c-paper` | `#ECE9E2` | Page ground (cream). The dominant colour. |
| `--tb-c-paper-hi` | `#F7F5F0` | Light paper: torn sheets, text panels, header, board ground. |
| `--tb-c-ink` | `#121216` | Text, rules, buttons, the board toolbar, ink bands, footer. |
| `--tb-c-red` | `#D42A18` | Accent one: the full stop, emphasis words, numerals, marks, one block per composition. |
| `--tb-c-cobalt` | `#2347F5` | Accent two: full-width bands, focus rings, one block per composition. |
| `--tb-c-grey` | `#55555C` | Secondary text on paper and light paper. |

**How much of each**: about 60 % paper and light paper, 25 % cobalt, 10 % ink, 5 % red. Red is an accent: never a full-width band, never body text on cream. Cobalt carries whole sections; ink appears once or twice a page (a dark slice, the footer).

**Allowed text pairs** (light scheme)

- Ink on paper or light paper: everything.
- Grey on paper or light paper: secondary text, labels.
- Light paper on cobalt, on ink and on red: everything.
- Red on light paper: any size. Red on paper (cream): large text only (24 px and up, or 19 px bold), such as the italic word in a headline.
- Cobalt on paper: links and labels.
- Never: ink on cobalt, cobalt on ink, red on cobalt, ink on red for body text.

**Dark variant (wanted; ground not chosen yet)**: Johan wants a dark variant. The tokens below are the "Ink" direction; the first-look page also shows a "Night cobalt" ground. It is an ink ground with light-paper text. Red and cobalt get lighter versions for text and marks, and deeper versions for bands. Torn sheets stay light paper with ink text, so the collage, the cutouts and the multiply blend keep working; plain UI panels use `--tb-surface` `#1C1C22`.

| Role token | Light | Dark |
|---|---|---|
| `--tb-ground` | `#ECE9E2` | `#121216` |
| `--tb-surface` | `#F7F5F0` | `#1C1C22` |
| `--tb-sheet` (torn paper) | `#F7F5F0` | `#F7F5F0` |
| `--tb-text` | `#121216` | `#ECE9E2` |
| `--tb-text-muted` | `#55555C` | `#A3A3AB` |
| `--tb-accent` (red, text-safe on ground) | `#D42A18` | `#FF5B47` |
| `--tb-accent-2` (cobalt, text-safe on ground) | `#2347F5` | `#7B93FF` |
| `--tb-band-cobalt` | `#2347F5` | `#1E3BD6` |
| `--tb-band-red` | `#D42A18` | `#B8241A` |
| `--tb-band-ink` | `#121216` | `#1C1C22` |
| `--tb-on-band` | `#F7F5F0` | `#ECE9E2` |
| `--tb-cutout-blend` | multiply | normal |
| `--tb-grain-blend` / opacity | multiply / 0.2 | screen / 0.06 |

Dark applies with `prefers-color-scheme: dark`, unless the page sets `data-tb-scheme="light"`; `data-tb-scheme="dark"` forces it.

## Contrast

WCAG 2 ratios, computed from the hex values (`design/brand/index.html` computes the same numbers live). Text needs 4.5:1, large text 3:1; non-text marks that carry meaning (rules, focus rings, the full stop, marks) need 3:1.

### Light, text

| Foreground | Background | Ratio | Use |
|---|---|---|---|
| ink `#121216` | paper `#ECE9E2` | 15.41 | AA body |
| ink `#121216` | paper-hi `#F7F5F0` | 17.15 | AA body |
| grey `#55555C` | paper `#ECE9E2` | 6.10 | AA body |
| grey `#55555C` | paper-hi `#F7F5F0` | 6.79 | AA body |
| red `#D42A18` | paper-hi `#F7F5F0` | 4.65 | AA body |
| red `#D42A18` | paper `#ECE9E2` | 4.18 | Large only |
| cobalt `#2347F5` | paper `#ECE9E2` | 5.26 | AA body |
| cobalt `#2347F5` | paper-hi `#F7F5F0` | 5.86 | AA body |
| paper-hi `#F7F5F0` | cobalt `#2347F5` | 5.86 | AA body |
| paper `#ECE9E2` | cobalt `#2347F5` | 5.26 | AA body |
| paper-hi `#F7F5F0` | red `#D42A18` | 4.65 | AA body |
| paper-hi `#F7F5F0` | ink `#121216` | 17.15 | AA body |
| ink `#121216` | red `#D42A18` | 3.69 | Large only |
| red `#D42A18` | ink `#121216` | 3.69 | Large only |
| ink `#121216` | cobalt `#2347F5` | 2.93 | Fail: never |
| cobalt `#2347F5` | ink `#121216` | 2.93 | Fail: never |
| red `#D42A18` | cobalt `#2347F5` | 1.26 | Fail: never |

### Light, non-text (needs 3:1)

| Foreground | Background | Ratio | Use |
|---|---|---|---|
| red square, marks `#D42A18` | paper `#ECE9E2` | 4.18 | Pass |
| cobalt band, focus ring `#2347F5` | paper `#ECE9E2` | 5.26 | Pass |
| ink rules, cursor `#121216` | paper `#ECE9E2` | 15.41 | Pass |
| paper-hi focus ring `#F7F5F0` | cobalt `#2347F5` | 5.86 | Pass |
| paper-hi sheet `#F7F5F0` | ink `#121216` | 17.15 | Pass |
| red mark `#D42A18` | ink `#121216` | 3.69 | Pass |
| cobalt mark `#2347F5` | ink `#121216` | 2.93 | Fail: never |
| red block `#D42A18` | cobalt `#2347F5` | 1.26 | Fail: never |
| ink rule `#121216` | cobalt `#2347F5` | 2.93 | Fail: never |

### Dark, text

| Foreground | Background | Ratio | Use |
|---|---|---|---|
| text `#ECE9E2` | ground `#121216` | 15.41 | AA body |
| text `#ECE9E2` | surface `#1C1C22` | 13.98 | AA body |
| muted `#A3A3AB` | ground `#121216` | 7.46 | AA body |
| muted `#A3A3AB` | surface `#1C1C22` | 6.77 | AA body |
| red-hi `#FF5B47` | ground `#121216` | 6.09 | AA body |
| red-hi `#FF5B47` | surface `#1C1C22` | 5.52 | AA body |
| cobalt-hi `#7B93FF` | ground `#121216` | 6.64 | AA body |
| cobalt-hi `#7B93FF` | surface `#1C1C22` | 6.02 | AA body |
| text `#ECE9E2` | cobalt-deep band `#1E3BD6` | 6.53 | AA body |
| text `#ECE9E2` | red-deep band `#B8241A` | 5.24 | AA body |
| ink `#121216` | sheet (stays light) `#F7F5F0` | 17.15 | AA body |
| grey `#55555C` | sheet (stays light) `#F7F5F0` | 6.79 | AA body |
| red `#D42A18` | sheet (stays light) `#F7F5F0` | 4.65 | AA body |
| red-hi `#FF5B47` | cobalt-deep band `#1E3BD6` | 2.58 | Fail: never |
| red `#D42A18` | ground `#121216` | 3.69 | Large only |

### Dark, non-text (needs 3:1)

| Foreground | Background | Ratio | Use |
|---|---|---|---|
| red-hi square, marks `#FF5B47` | ground `#121216` | 6.09 | Pass |
| cobalt-hi marks, focus ring `#7B93FF` | ground `#121216` | 6.64 | Pass |
| rules, focus ring on band `#ECE9E2` | cobalt-deep band `#1E3BD6` | 6.53 | Pass |
| rules `#ECE9E2` | ground `#121216` | 15.41 | Pass |
| torn sheet `#F7F5F0` | ground `#121216` | 17.15 | Pass |

### Dark, surfaces (decorative, no minimum; never the only cue for a boundary)

| Foreground | Background | Ratio | Use |
|---|---|---|---|
| cobalt-deep band `#1E3BD6` | ground `#121216` | 2.36 | Decorative surface: fine |
| red-deep block `#B8241A` | ground `#121216` | 2.94 | Decorative surface: fine |
| surface panel `#1C1C22` | ground `#121216` | 1.10 | Decorative surface: fine |

## Type

| Role | Face | Weight | Notes |
|---|---|---|---|
| Display: headlines, wordmark, card titles, numerals | Bodoni Moda | 800 | Line height 1.02, tracking −0.01em (wordmark −0.02em). Optical sizing on. |
| Emphasis word | Bodoni Moda Italic | 500 | The italic turn at the end of a headline. Red in the hero, inherits colour elsewhere. |
| Body, UI | Instrument Sans | 400; 600 for strong; 700 for labels and buttons | Line height 1.55. |

Both are on Google Fonts under the SIL Open Font License: `family=Bodoni+Moda:ital,opsz,wght@0,6..96,500;0,6..96,800;1,6..96,500;1,6..96,800&family=Instrument+Sans:wght@400;500;600;700`.

**Scale**: ratio 1.25 on a 17 px base. Steps `--tb-step--1` 0.8rem (labels), `0` 1.0625rem (body), `1` 1.33rem (lede, h3, card titles), `2` 1.66rem, `3` 2.08rem (wordmark in the header), `4` 2.6rem (index numerals), `5` 3.25rem, `6` 4.06rem (h2), `7` 5.1rem (h1). Headlines are fluid: h1 `clamp(3rem, 6.4vw, 5.1rem)`, h2 `clamp(2.4rem, 4.6vw, 4.06rem)`.

**Numbered sections**: each feature section is a numbered page of the magazine.

- Kicker: Instrument Sans 700, 0.8rem, uppercase, tracking 0.18em, with the number in an ink box (`01`), or a 10 px red square when the section has no number. On cobalt and ink the box and square turn light paper.
- Contents index: the numerals are Bodoni Moda Italic 800 at step 4, in red, beside a Bodoni title and a grey one-line description, under a 3 px ink rule.
- Lists inside a sheet: `01` to `14` in Instrument Sans 700, 0.8rem, red, tracking 0.14em.

**Line length**: body 45 to 60ch (`--tb-measure-body`), lede 36 to 38ch, headlines about 12 to 20 characters a line.

**Don'ts**

- No third typeface, and no Bodoni for body text or anything under 17 px.
- No italic Bodoni for a whole headline: one italic turn, at the end.
- No all-caps Bodoni, no letter-spaced Bodoni, no underlined headlines.
- No light Bodoni weights at display size: 800 for roman, 500 for the italic.
- Labels are the only uppercase text.

## Layout

- **Grid**: 12 columns, 24 px gutter, content at most 1320 px wide, with 32 px margins (16 px on phones).
- **Spacing**: an 8 px scale: 4, 8, 12, 16, 24, 32, 40, 48, 56, 64, 72, 96, 120 (`--tb-space-*`). Sections are 120 px top and bottom on desktop, 72 px on phones.
- **Breakpoints**: 1100 px (card strips drop to two columns), 900 px (copy and art stack, copy first), 700 px (phone: 16 px margins, single columns).
- **Section rhythm**: bands alternate cream, cobalt and ink, never two of the same colour in a row. Feature slices alternate art left and art right: copy takes 5 columns, art 6, with an empty column between. Between slices, use a strip of cards or a full-width torn strip to break the pattern. One focal point per section.
- **Contents index**: right after the hero, a light-paper sheet with torn edges holds the numbered list of sections ("In this issue."), 4 columns on desktop, 2 on tablets, 1 on phones. Each entry links to its section.
- **Header**: sticky, 72 px, light paper with a 2 px ink rule underneath; the wordmark on the left, uppercase links on the right, and one ink button.
- **Marketing buttons**: one primary (ink fill, turns red on hover) and one secondary (light paper with an ink border). 56 px tall, 2 px border, square corners. On cobalt the primary turns light paper. The app UI uses the radii described under App UI.

## Motifs

Restraint first: each section has one focal collage. A composition uses at most one red block, one cobalt block, two tape strips, one or two cutouts and one hand mark.

**Torn paper edges**

- When: sheets that hold text (cards, tags, the contents panel, a full-width strip).
- How: `clip-path: var(--tb-torn-all)` on a light-paper box, or `--tb-torn-x` for full-width strips (top and bottom torn). Keep 16 px or more of padding inside. SVG versions are in `assets/torn-edges.svg`.
- How much: a sheet may tilt up to 2.4°. One torn panel per section, or one strip of torn cards.
- Don't: tear buttons, form fields, the header or the wordmark; tear photos; use more than one polygon shape on the same row (it reads as a pattern).

**Tape strips**

- When: to pin a sheet or the pasted board to the page.
- How: `assets/tape/tape-long.webp` and `tape-short.webp` (alpha), about a quarter of the width of what they hold, across a corner at 4° to 38°, opacity 0.93.
- How much: one or two strips per piece, at most four per section.
- Don't: tape text, tape the wordmark, or use tape as a divider.

**Cut-out photos**

- When: one real object that stands for the section (a stopwatch for history, a key for access tokens, scissors for templates), or a hand that points or writes.
- How: greyscale photos in `assets/cutouts/` (alpha). On paper or a red or cobalt block, set `mix-blend-mode: var(--tb-cutout-blend)` (multiply) so they print onto the paper. Rotate them freely (−14° to 18° on #27).
- How much: one or two per section. A hand once or twice a page.
- Don't: use colour photos, faces, logos, recognisable people, or stock objects with a glossy studio look. Don't place a cutout on ink with multiply (it disappears; the dark scheme switches to normal blend).

**Hand marks**

- When: to point at the one thing that matters: a marker circle round a detail, an underline, an asterisk, a tick, an arrow, brackets.
- How: `assets/marks/` (alpha, solid red or cobalt). Red on paper, light paper and ink; cobalt on paper and light paper only. In the dark scheme, use the lighter red and cobalt (recolour the alpha mask, or use `filter`).
- How much: one mark per section.
- Don't: write words with them, draw connectors with them, or put a red mark on cobalt.

**The pasted board**

- When: wherever the product appears. The real Tabula board UI (`assets/board/board-ui.webp`, or a fresh screenshot) sits on a light-paper mount with a 10 px padding, a hard offset shadow (`10px 12px 0` ink at 90 %) and a tilt of about 1.2° to 1.4°.
- How: connectors, guides and arrowheads go on top as a precise inline SVG overlay (a 7-unit ink line, attached at edge midpoints), never inside the image.
- How much: one board per section; it is the focal point when it appears.
- Don't: redraw the board as an illustration, or crop out its toolbar.

**Named cursors**

- When: on or near the pasted board, to show people working together.
- How: an SVG pointer at 36 to 40 px with a 2 px light-paper edge and a 2 px offset shadow, plus a name tag in the same colour (red, cobalt or ink) with light-paper text, 0.82rem bold. Names on #27: Mara (red), Idris (cobalt), Noor (ink).
- How much: up to three in the hero, one in a feature slice.
- Don't: use real people's names or photos, or small (under 36 px) outline-only cursors.

**Paper texture**

- When: once, over the whole page.
- How: `assets/paper/paper-grain.webp` as a fixed full-screen layer, `mix-blend-mode: var(--tb-grain-blend)`, opacity `var(--tb-grain-opacity)` (0.2 light, 0.06 dark), `pointer-events: none`.
- Don't: stack it twice, raise it over 0.2, or texture single elements.

**Paper scraps**: `assets/paper/scrap-red.webp`, `scrap-blue.webp`, `scrap-paper.webp` and `scrap-news.webp` (alpha) are torn pieces to back a cutout. One per composition.

## Motion

A touch of movement so the page comes alive a little. Johan called heavy animation "nauseating"; restraint wins.

- **Play once, on view**: each moment starts when its section is 30 % in view (IntersectionObserver, then unobserve) and never repeats. Four to six moments a page, not one per element.
- **Settle**: collage layers fade in and move up to 24 px into place, 500 ms opacity and 800 ms transform, staggered by about 100 ms.
- **Tape press**: a tape strip lands 3° off its final angle and eases to rest in 800 ms.
- **Marks draw**: lines and guides draw themselves with `stroke-dashoffset` (`pathLength="1"`) in 700 ms, after the layer has settled.
- **Cursor glide**: a named cursor glides 24 to 56 px into place in 700 to 800 ms.
- **Fill and drop**: poll bars fill (`scaleX`) in 900 ms; vote dots drop 28 px in 600 ms with a 100 ms stagger.
- **Hover lift**: a paper card lifts 3 px and shows its ink shadow in 350 ms.
- **Idle sway**: the only loop, on one hero cutout: at most 0.6° over 8 s, alternating, starting 2 s after the hero settles.
- **Easing**: `cubic-bezier(0.2, 0.7, 0.2, 1)` (`--tb-ease`) for everything except the sway (ease-in-out).
- **Rules**: animate only `transform`, `opacity` and `stroke-dashoffset`. No parallax, no scroll-jacking, no marquee, no word-by-word type, no stepped timing. Content shows without JavaScript: the hidden starting state exists only under a class that the script puts on `<html>`, and only when motion is allowed. With `prefers-reduced-motion: reduce` everything is static and in its end state.

## Illustration with Codex

All art is generated, not hand-drawn in SVG (hand-built SVG illustration looked cheap in Johan's reviews). SVG is only for UI glyphs, cursors and overlays such as connectors and guides.

**Process**: one Codex run at a time, from an empty slot folder, with stdin closed:
`cd <slot> && timeout 600 ~/.local/bin/codex exec --skip-git-repo-check --sandbox workspace-write -C . "<brief>" < /dev/null`. Ask for 2 or 3 options, look at each, keep the best, delete the rest. Send Codex nothing but the image brief.

**Palette, in every brief**: paper `#ECE9E2`, light paper `#F7F5F0`, ink `#121216`, signal red `#D42A18`, cobalt blue `#2347F5`, plus neutral greys.

**Style**: avant-garde art-magazine collage. Monochrome greyscale photography (high contrast, a little film grain, soft natural shadow) with one or two bold flat accents (red or cobalt paper, red or cobalt marker).

**Composition**: one subject per image, centred with wide empty margins, on plain pure white `#FFFFFF` (for cutouts and marks) or flat magenta `#FF00FF` (for paper and tape, which need clean alpha). Several small assets may share one sheet in an even grid, with wide space so nothing touches. Hands enter from one edge.

**Aspect ratios**: objects 1:1 (or a 4×2 sheet at 2:1); hands 4:5 portrait or 5:2 for a pointing arm; marks 3:2 sheets; paper and tape 3:2 sheets; textures 1:1.

**Prompt template** (fill the slots in angle brackets):

```
Use your image generation tool to create <N> image options, saved in the current directory as option-1.png … option-<N>.png (each <ASPECT>, about <W>x<H>).
Subject: <SUBJECT, one sentence: what, pose or angle, how it is cut off>.
<MEDIUM: "A strictly greyscale editorial photograph, high contrast, slight film grain, soft natural shadow." or "Drawn with a thick felt marker in <COLOUR HEX>, slightly uneven line weight and dry-brush edges, like real ink on paper.">
Background: perfectly plain <pure white #FFFFFF | flat magenta #FF00FF with no shadows on it>, seamless, no floor, no table.
PALETTE (use only these exact colours): paper #ECE9E2, light paper #F7F5F0, ink #121216, signal red #D42A18, cobalt blue #2347F5, plus neutral greys.
Style: avant-garde art-magazine collage (editorial, monochrome photography with one or two bold accent colours).
Hard rules: no text, no lettering, no numbers, no logos, no watermarks, no real or recognisable people, no faces, no connector lines or arrows between objects, no recognisable artworks, no stock-photo look, no earthy brown or terracotta tones.
AVOID: <SPECIFIC AVOIDS: colour, other objects, borders, frames, shadows on the background>.
```

**Worked prompts**

1. Cutout object:
   > Use your image generation tool to create 2 image options, saved in the current directory as option-1.png and option-2.png (each square 1:1, about 1200x1200). Subject: a single vintage brass stopwatch with a plain face and no numbers, photographed from slightly above, whole object in frame with wide empty margins. A strictly greyscale editorial photograph, high contrast, slight film grain, a very soft small shadow. Background: perfectly plain pure white #FFFFFF, seamless, no floor, no table. PALETTE (use only these exact colours): paper #ECE9E2, light paper #F7F5F0, ink #121216, signal red #D42A18, cobalt blue #2347F5, plus neutral greys. Style: avant-garde art-magazine collage (editorial, monochrome photography with one or two bold accent colours). Hard rules: no text, no lettering, no numbers, no logos, no watermarks, no real or recognisable people, no faces, no connector lines or arrows between objects, no recognisable artworks, no stock-photo look, no earthy brown or terracotta tones. AVOID: colour, other objects, hands, borders, reflections of a studio.
2. Hand gesture:
   > Use your image generation tool to create 3 image options, saved in the current directory as option-1.png … option-3.png (each portrait 4:5, about 1200x1500). Subject: an adult hand and forearm entering from the right edge, plain unbranded rolled-up sleeve, holding a thin marker pen about to draw. Hand only: no face, no jewellery, no tattoos. A strictly greyscale editorial photograph, high contrast, slight film grain, soft natural shadow. Background: perfectly plain pure white #FFFFFF, seamless, no floor, no table. PALETTE (use only these exact colours): paper #ECE9E2, light paper #F7F5F0, ink #121216, signal red #D42A18, cobalt blue #2347F5, plus neutral greys. Style: avant-garde art-magazine collage (editorial, monochrome photography with one or two bold accent colours). Hard rules: no text, no lettering, no numbers, no logos, no watermarks, no real or recognisable people, no faces, no connector lines or arrows between objects, no recognisable artworks, no stock-photo look, no earthy brown or terracotta tones. AVOID: colour, text, any other objects, frames, borders.
3. Hand mark:
   > Use your image generation tool to create 2 image options, saved in the current directory as option-1.png and option-2.png (each landscape 3:2, about 1800x1200). Subject: a sheet of hand-drawn marker marks arranged in an even 3 by 2 grid with wide empty margins so none touch: a loose imperfect oval circle, a wavy underline, a curved arrow with an open arrowhead, a quick asterisk, a pair of brackets, a tick inside a loose circle. Drawn with a thick felt marker in signal red #D42A18 (four marks) and cobalt blue #2347F5 (two marks), slightly uneven line weight and dry-brush edges, like real ink on paper. Background: perfectly plain pure white #FFFFFF. PALETTE (use only these exact colours): paper #ECE9E2, light paper #F7F5F0, ink #121216, signal red #D42A18, cobalt blue #2347F5, plus neutral greys. Style: avant-garde art-magazine collage (editorial, monochrome photography with one or two bold accent colours). Hard rules: no text, no lettering, no numbers, no logos, no watermarks, no real or recognisable people, no faces, no connector lines or arrows between objects, no recognisable artworks, no stock-photo look, no earthy brown or terracotta tones. AVOID: text, letters, numbers, any other colours, shadows, paper texture, borders, gradients.

**Avoid-list**: lettering of any kind, logos and brands, connectors or arrows that join things inside an image (draw those as SVG on top), recognisable artworks or people, faces, glossy stock looks, gradients, colour photography, cafe and coffee clichés, globes, suns, earthy brown or terracotta.

**Post-processing**

1. Cut each asset out of its sheet with ImageMagick (`magick in.png -crop WxH+X+Y +repage`).
2. Remove the background:
   - Marks on white: fill every pixel with the token colour and use the ink density as alpha (alpha = 1 − min(R, G, B), levelled so the stroke reaches full opacity). One mask can then be recoloured.
   - Photos on white: remove the near-white region connected to the edge (keep enclosed whites such as a watch face), soften the edge by under 1 px. Or skip keying and place the white-ground photo with `mix-blend-mode: multiply` on paper.
   - Paper and tape on magenta: key `#FF00FF` out to alpha.
3. Export WebP: `cwebp -q 85 -alpha_q 100 -resize <2× the displayed CSS width> 0 in.png -o out.webp`. Keep each image under 250 KB (a hero under 350 KB).
4. In the page: `width` and `height` attributes, `alt=""` and `aria-hidden="true"` for decoration, `loading="lazy"` below the fold, `decoding="async"`.

## Provenance of the app icons

Recorded 2026-10-11 for the licence audit.

| File | Made by | Licence | Third-party material |
|---|---|---|---|
| `public/favicon.svg` | The project's own design work: a hand-written SVG of three primitives (a rounded dark square, a signal-yellow bar, three light lines). It is in the initial commit (1d05edf, 2026-10-08, committed by Johan's account). It is not traced from, or derived from, any third-party artwork or icon set. | Part of the app, so AGPL-3.0 like the rest of the repository. The name, the wordmark and the monograms stay reserved (see `design/brand/assets/LICENSE.md`); this favicon is the app's interim mark, not one of the four monogram options. | None |
| `desktop/src-tauri/icons/*` (`32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.png`, `icon.icns`, `icon.ico`) | Generated from `public/favicon.svg` for the Tauri desktop shell (`docs/desktop.md`, TAB-100; added in eb5aebe). | Same as the favicon: our own work, AGPL-3.0. | None |

Neither set contains CC BY 4.0 brand art or any third-party image, so no notice entry is needed for them. When Johan picks a monogram (First look, question B) the favicon and these icons are redrawn from that monogram, and this table is updated: the monogram is brand art, with the name and wordmark reserved.

## Voice

Headlines follow one pattern: **a plain statement, then an italic turn.** "Paste your thinking *together.*" "One board, *no edges.*" "Run the room, *not the tool.*" "Yours first. *Then everyone's.*" "Start a board. *Cut the rest.*"

Short sentences, real features only, no hype, no "AI-powered" badges, no invented social proof. The page speaks like a magazine contents page: "In this issue." The product voice in the app and the docs stays plain English.

## Asset kit

Everything is in `design/brand/assets/` (about 0.45 MB). Licence: the art is CC BY 4.0; the name, the wordmark and the monograms are reserved (see `assets/LICENSE.md`).

| Folder | Files | Use |
|---|---|---|
| `wordmark/` | `tabula-wordmark-ink.svg`, `-paper.svg`, `-on-cobalt.svg` | The logo, as outlines. Pick by ground (see Logo). |
| `tape/` | `tape-long.webp`, `tape-short.webp` | Pin sheets and the board. Alpha. |
| `marks/` | circle, underline, arrow, asterisk, brackets, tick | One per section. Alpha, solid red or cobalt. |
| `paper/` | `paper-grain.webp`, `scrap-red/-blue/-paper/-news.webp` | The page grain; torn scraps to back a cutout. |
| `cutouts/` | scissors, push pin, bulldog clip, key, stopwatch, pointing hand, hand with pen | Greyscale cutouts with alpha. Multiply on paper. |
| `board/` | `board-ui.webp` | The pasted board layer (an abstract board with a toolbar, notes and frames; no connectors). |
| `monogram/` | `a-full-stop`, `b-cobalt-plate`, `c-pinned-t`, `d-stamp`: each as `.svg` (180, outlines) and `-16`, `-32`, `-48.svg` (pixel grid) | Favicon options, not final. Johan picks one; then the ICO and PNG set. |
| `torn-edges.svg`, `torn-edges.css` | `#tb-torn-all`, `#tb-torn-x`; `.tb-torn`, `.tb-torn-x` | Torn edges without the rest of the tokens. |

To use the profile in a page: link `design/brand/tokens.css`, load the two Google Fonts, put `paper-grain.webp` over the page, and build sections from the role tokens (`--tb-ground`, `--tb-sheet`, `--tb-band-cobalt` …), never the raw hex.

## Open questions for Johan

- **Asset licence**: answered (2026-10-09). CC BY 4.0 for the art; the name, the wordmark and the monograms are reserved. See `assets/LICENSE.md`.
- **Dark variant**: answered. It is wanted. Which ground (Ink or Night cobalt) is still open; see First look.
- **Logo beyond the wordmark**: open. Four monogram options are on the first-look page; see First look.
- **The app**: answered. The app stays Swiss; Editorial is for the landing page, marketing and docs.

## First look (TAB-196 next)

`design/brand/first-look.html` (http://localhost:5200/design/brand/first-look.html) shows two things for Johan to choose from. It is a first look, not the full build.

**A. Dark variant.** The same Editorial content (the hero collage with tape, cursors and the pasted board; a cobalt section; a feature slice with the watch cutout; the footer) side by side in light and dark, with a switch between two dark grounds (`?dark=night` opens the second):

- **Ink**: ground `#121216`, the dark role tokens above, unchanged.
- **Night cobalt** (new): ground `#0E1430`, surface `#171E42`, muted text `#A9AEC8`, footer `#070A1C`. The cobalt band stays full `#2347F5`, because the deeper `#1E3BD6` is only 2.28:1 on this ground and stops reading as a section.

Fixes applied in both: sheets stay light; cutouts use normal blend; marks are masks filled with red-hi and cobalt-hi; grain is screen at 0.06; the footer gets a 2 px light rule, since an ink band on an ink ground is 1.10:1; the wordmark square stays `#D42A18` (3.69:1 on Ink, 3.57:1 on Night). The page has a contrast table for each ground.

**B. Favicon monogram.** Four options in `design/brand/assets/monogram/`, pure SVG with no web font. The 180 px version is the Bodoni Moda outline; 16, 32 and 48 are redrawn on the pixel grid (hairline bar, bracketed serif wedges, hairline foot on whole pixels) so they stay sharp. Each has a filled tile, so it works in light and dark browser chrome.

- **A, Full stop**: ink T with the red square kerned under its arm, on light paper.
- **B, Cobalt plate**: light T and light square on cobalt (no red square on cobalt).
- **C, Pinned t**: a lowercase t with the red square as its dot, on ink.
- **D, Stamp**: the red square as the whole tile, with a light T cut out of it. Recommended: the clearest at 16 px, and it reads the same on every chrome and ground.

**Choices for Johan**

1. Ship the dark variant now, or later?
2. Ink or Night cobalt?
3. Which monogram (A, B, C or D; or a pair, such as D for the favicon and A for avatars)?
4. In dark, keep the wordmark square brand red `#D42A18`, or use red-hi `#FF5B47`?

After the picks: dark tokens into `tokens.json`, the dark section of this guide, and the ICO and PNG favicon set.
