# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Facilitators and small teams who run workshops, retros, planning and everyday collaboration on a shared board, in a browser. A second confirmed audience is education: a teacher running a class, with students joining as guests with a link (the site has an education page). Some users run the software themselves (self-hosting); others use the hosted service.

## Product Purpose

Tabula is a shared whiteboard: sticky notes, shapes, connectors, frames and groups, kanban boards, workshop sessions (steps, shared timer, private writing, dot voting, polls), comments and chat, with accounts, teams and roles. It is free software (AGPL-3.0-only), works offline first and syncs through a relay when one is available. An issue tracker that lives on the board is being dogfooded on the team's own workspace behind a feature flag; it is not shipped to customers and is not part of the public claims. Success: a team can run a session or keep its work on one board without paying per seat for a hosted whiteboard, and without losing data when the network is bad.

## Positioning

Wording from the CGO agent (Johan delegated it), to be used as written:

"Tabula is free software you can run yourself: the same AGPL-3.0 app that powers our hosted workspaces runs on your own server, and every board works offline and syncs when it reconnects. Workshop facilitation is part of the board rather than an add-on: steps, a shared timer, private writing, dot voting and polls, with kanban alongside. Agents can read and edit boards through MCP, and people see every change."

No prices, numbers or competitor names in positioning copy. Claims about tablets, phones or classrooms, and about the tracker, are not made until they are verified and shipped (see Capabilities and Constraints).

## Operating Context

Boards are shared by URL. Open mode (no accounts) and accounts mode (teams, roles, guests joining with a code) both exist. The app is used on laptops. iPad and iPhone touch support is built but unverified on real devices until Johan's device check, so it is not claimed. Hosted workspaces run the same open-source app; the marketing site (gettabula.app) and the user guide are separate surfaces in the same brand family.

## Capabilities and Constraints

- Works offline; no calls to third-party services from the app are acceptable by default (fonts and icons from Fontshare and Iconify are a pending licence decision with CGO, D-O20).
- Five themes (Default, Ayu, Kanagawa, Matrix, Evergreen); every UI must work in all five.
- The tracker, the AI bar, chat and guest join codes are separate capabilities with their own flags or settings.
- Prices live in one constants file on the site and are never typed into copy.

## Brand Commitments

The name Tabula, the wordmark and the monograms are reserved (see `design/brand/assets/LICENSE.md`); the brand art is CC BY 4.0. The graphic profile for the marketing site and docs is the Editorial profile recorded in `docs/brand.md`. Visual decisions are not recorded here.

## Evidence on Hand

The README, `docs/` (specs, user guide in `docs/guide`), `docs/brand.md`, screenshots in `docs/images`, the live site at gettabula.app, and the app itself. There are no customer testimonials, case studies, benchmarks or usage numbers on hand, and none may be invented.

## Product Principles

1. Free software first: nothing in the open product is held back from self-hosters.
2. Local-first: it keeps working with a bad or no connection.
3. Accessible by default: keyboard operable, phone-sized targets, readable contrast in every theme.
4. Honest copy: no invented proof, no fake numbers; claims come from what the product does.
5. Facilitation is a feature of the board, not a separate tool.

## Accessibility & Inclusion

WCAG AA contrast and focus visibility, 44 px touch targets on touch devices, full keyboard operation, reduced-motion respect, and screen-reader names for controls. Phone and tablet use is a design target (touch targets, soft-keyboard behaviour), but it is not claimed publicly until verified on real devices.
