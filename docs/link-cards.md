# Link cards

TAB-135. Status: spec for review. Nothing here is built yet.

Johan asked for "links with preview, parsed metadata and such". Today a pasted web address becomes a sticky note with the address as its text, and `docs/images.md` decided that pasting a URL fetches nothing, because a server-side fetch is an SSRF hole and a browser-side one leaks every viewer's IP address to a third party. This page specifies how link previews are added without either problem: **one guarded fetch on the relay, at the moment someone adds the link, with the result stored in the board**, so nobody's browser ever contacts the linked site to draw the card.

Most of the page is about that fetch, because it is the risky part. The card itself is small.

## Decisions (frozen 2026-10-10)

Johan: "link cards: go with the recommendations". All twelve open questions below are closed with the answer given as drafted or recommended:

1. Previews on by default for hosted workspaces, off for self-hosted accounts mode and open mode.
2. A lone pasted http(s) address makes a link card by default (Johan's decision). Also: **Turn into text** (one undo step), **Turn into link card** on a text or sticky whose content is a single address, and a one-shot **Paste as plain text** (Cmd/Ctrl+Shift+V) that skips the card.
3. Click selects; open with **Open link**, Cmd/Ctrl+click, double-click or Enter.
4. Warn when an address looks like it carries a secret.
5. Preview images count against the board's asset quota.
6. No outbound proxy setting in v1.
7. Send the person's language in `Accept-Language`.
8. SVG export wraps link cards in `<a href>`.
9. MCP may create plain link cards only; it does not trigger a fetch in v1.
10. A failed preview stays failed until someone presses Refresh.
11. Document the user agent and the opt-out; do not fetch `robots.txt` in v1.
12. v2 order: YouTube and Vimeo thumbnails first.

Layouts Compact, Card and Large are chosen from the quick bar (as drafted above).

## Summary

- **A new object type `link`**: a box that shows a link's site icon and name, title, description, preview image and domain. Click opens the page in a new tab. Its size picks one of three layouts: **compact** (one line), **card** and **large image**.
- **Add one** by pasting a web address on the board (a single `http` or `https` address on the clipboard), dropping a link from another tab, or the **Link** button on the left rail. The card appears at once with the address and domain, and fills in when the preview arrives.
- **The relay fetches the page**, never the browser: `POST /api/boards/:id/unfurl {url}`. It allows `http` and `https` on ports 80 and 443, resolves the host itself and refuses private, loopback, link-local, carrier-grade NAT, documentation, multicast and metadata addresses, **connects to the address it checked** (no second lookup, so DNS rebinding cannot swap it), follows at most 3 redirects and checks every hop the same way. Time limit 5 seconds in all, at most 1 MB of HTML, `text/html` only, no cookies, no credentials, no proxy from the environment, a fixed user agent.
- **Preview images and site icons are stored as board assets** (`docs/images.md`, TAB-127) by the relay, through the same guard and the asset store's checks: PNG, JPEG, GIF or WebP, at most 2 MB for a preview image and 256 KB for an icon, metadata stripped. Never hotlinked: no viewer's browser contacts the linked site.
- **What the board stores**: the address, the title, description and site name as plain text, the two asset hashes, when it was fetched and how it went. Boards render previews offline and on export without fetching anything.
- **Text is untrusted**: control, invisible and bidirectional characters are removed, lengths are capped, it is drawn as text only, never as markup, and the AI tools receive it fenced as untrusted content.
- **Who**: owners and editors add, refresh and edit cards; everyone who can open the board sees the stored preview. A workspace setting turns previews on or off: **on by default for hosted workspaces, off by default for self-hosted accounts mode and open mode** (opt in with `TABULA_LINK_PREVIEWS=on`). With previews off a link card is still a link: it shows the address, the domain and a letter icon.
- **No new CSP sources.** Everything the card draws comes from the board's own asset route (`'self'`). No iframes, no embeds in v1.
- **Not in v1**: embedded players (YouTube, Vimeo) and site-specific cards (GitHub, Figma, Linear, Google Docs), which are v2 and listed below; fetching from the browser; previews in templates' images.

## Decisions and why

1. **Fetch on the relay, at creation, once.** The browser cannot read other sites (CORS), and if it could, every viewer would leak their IP address to the linked site every time the board opened. Fetching on the relay when the card is added means the linked site sees one request, from the relay, and the board carries the result. The cost is the SSRF risk, which the guard below is for.
2. **Store, don't proxy.** A proxy route (`/api/preview-image?url=`) would keep the relay fetching on every view, keep the SSRF surface open on every read, and make the board depend on the linked site staying up. Storing the image as a board asset at unfurl time costs disk (capped) and gives offline rendering, export, backups and history for free, through code that already exists.
3. **Resolve, check, pin.** Checking a hostname and then letting `fetch` resolve it again is the classic DNS rebinding hole: the first answer is public, the second is `127.0.0.1`. The guard resolves once per hop, checks **every** address it got, and opens the TCP connection to that address itself, sending the original host name in the `Host` header and for TLS (SNI and certificate check). No library path that resolves again is used.
4. **Off by default where the operator's network is unknown.** A hosted instance runs on a network we know and can firewall (TAB-103). A self-hosted relay may sit inside a company network next to services that answer on *public-looking* addresses the block list cannot know about (split-horizon DNS, a reverse proxy on the same host). The operator should decide to turn on outbound fetches there.
5. **The card is useful without a preview.** Previews fail: sites block bots, pages are behind a login, the relay is offline, the operator turned them off. A link card always works as a link, shows where it goes, and can be refreshed later.
6. **The person who adds a card writes its preview.** The relay returns the metadata and the app writes it into the board, as it does for every other edit. The relay never writes into a board on its own here (unlike MCP), so the change has an author, follows the role rules, and arrives through ordinary sync.

## Object model

A new member of `ObjType` (`src/types.ts`): `'link'`. Fields on `BaseObj`:

| Field | Type | Meaning |
|---|---|---|
| `url` | `string` | The address as added, `http:` or `https:`, at most 2,048 characters, normalised (see Adding a link) |
| `title` | `string?` | The page's title: `og:title`, else `twitter:title`, else `<title>`; at most 300 characters |
| `description` | `string?` | `og:description`, else `twitter:description`, else `<meta name="description">`; at most 1,000 characters |
| `siteName` | `string?` | `og:site_name`, else the host without `www.`; at most 100 characters |
| `image` | `string?` | Asset hash of the preview image (`og:image`, else `twitter:image`) |
| `imageW`, `imageH` | `number?` | Its natural size, for the large layout's aspect ratio |
| `icon` | `string?` | Asset hash of the site icon (`<link rel="icon">` or `apple-touch-icon`, else `/favicon.ico` when it is a PNG, GIF, JPEG or WebP) |
| `finalUrl` | `string?` | Where the redirects ended, shown in the card's tooltip when it differs from `url` |
| `unfurl` | `'pending' \| 'ok' \| 'failed' \| 'off'` | The state of the preview (see The card without a preview) |
| `unfurlError` | `string?` | A fixed code when it failed: `blocked`, `timeout`, `too_large`, `not_html`, `http_status`, `unreachable`, `rate_limited` |
| `fetchedAt` | `number?` | When the preview was taken |
| `edited` | `('title' \| 'description')[]?` | Fields a person changed by hand; Refresh keeps them |

Everything else is the usual box: `x y w h rotation z locked hidden parent name createdBy updatedAt`. `text` is unused. A link card can sit in a frame, be locked, hidden, connected to, and stacked like any box.

**Layouts** come from the card's size, not from a field, so a resize switches them and two people never disagree:

- **Compact**, height under 72 units: icon, title (or the address), domain, on one line.
- **Card**, the default (320 by 112): icon and site name, title (two lines), description (two lines), domain; the image as a square thumbnail on the right when there is one.
- **Large image**, height at least 1.2 times the width of the text column, or when the person picks it from the quick bar: the image across the top at its aspect ratio, then the text.

The quick bar offers the three as **Compact**, **Card** and **Large**, which resize the card to the layout's default size.

## Adding a link

- **Paste.** The paste handler (`src/app.ts`) today turns text into stickies. A clipboard whose `text/plain` is a single line that parses as an `http:` or `https:` URL (with `URL`, after trimming), and nothing else, makes a link card at the pointer or the view centre. A URL among other text keeps today's behaviour (stickies). `Shift+Ctrl+V` ("paste as text") keeps the old behaviour for a URL too.
- **Drop** a link from another tab (`text/uri-list`): a card per address, at most 10 per drop.
- **The Link button** on the left rail (after **Image**) opens a small popover with an address field and **Add**.
- **Normalised**: the `URL` parser's form, `#fragment` kept, user and password removed (`https://user:pass@host` is refused with "Addresses with a user name or password can't be added"), at most 2,048 characters. Non-web schemes (`javascript:`, `data:`, `file:`, `mailto:` in v1) are refused at the door; the card can only ever open `http` and `https`.
- The card is created at once with `unfurl: 'pending'` (or `'off'` when previews are off), and the app asks the relay for the preview. When the answer arrives, the app writes the fields **with a non-undo origin**: undoing goes back past the whole card, not to an empty card. If the person closes the tab before the answer arrives, the card stays `pending` for everyone; after 30 seconds others see **Refresh preview** on it.

## Fetching a preview

`POST /api/boards/:id/unfurl` with `{ url }` (and the CSRF header). Answer `200 { title, description, siteName, image, imageW, imageH, icon, finalUrl, fetchedAt }` or an error with one of the codes above. The board id is in the path because the images become assets **of that board** (the asset store scopes every read to a board, `docs/images.md`).

### Who may ask

- Signed in (accounts mode), the board's owner or an editor (`canWriteRoom(role, 'board')`), the workspace not read-only, previews on for the workspace.
- Open mode: only with `TABULA_LINK_PREVIEWS=on`, counted per client address like the AI routes (`TABULA_TRUST_PROXY` rules).

### The address guard

Run for the first address and for **every redirect hop**, and for every image and icon address:

1. **Scheme and port.** `http:` or `https:` only. Port 80 for `http`, 443 for `https`, or none given. No user info. Host at most 253 characters.
2. **Literal addresses** are checked like resolved ones below. Encodings that resolvers read as IPv4 (`http://2130706433/`, `0x7f.1`, `127.1`, octal parts) are normalised by the `URL` parser first; anything it leaves that is not a plain dotted quad or a bracketed IPv6 address and still looks numeric is refused.
3. **Resolve** with the system resolver (`dns.lookup` with `all: true`, both families), at most 2 seconds. **Every** address returned must pass; one bad address refuses the hop (an attacker controls the order).
4. **Refused ranges.** IPv4: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10` (carrier-grade NAT), `127.0.0.0/8`, `169.254.0.0/16` (link-local, including the cloud metadata address `169.254.169.254`), `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`, `192.88.99.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, `224.0.0.0/4` (multicast), `240.0.0.0/4` and `255.255.255.255`. IPv6: `::` and `::1`, `fc00::/7` (unique local, which covers Fly's private network `fdaa::/16`), `fe80::/10` (link-local), `ff00::/8` (multicast), `2001:db8::/32`, `100::/64`, `fec0::/10`; and the forms that **carry an IPv4 address**, which is extracted and checked against the IPv4 list: `::ffff:0:0/96` (mapped), `::/96` (compatible), `64:ff9b::/96` (NAT64), `2002::/16` (6to4), `2001::/32` (Teredo, refused outright). The list is one pure function with a test per range.
5. **An operator's own block list** adds to it: `TABULA_LINK_PREVIEW_DENY` (CIDRs and host names, comma separated) for networks that look public but are not, such as a company's own address range. There is no allow list in v1.
6. **Connect to the checked address.** The request goes out through `node:http`/`node:https` with a `lookup` function that returns the address already checked for this hop, so nothing resolves twice. For `https` the TLS `servername` is the host name and the certificate is checked against it as usual (no `rejectUnauthorized: false`). The Happy Eyeballs fallback is off (one address, the first that passed). `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` are **ignored**; an operator who wants fetches to leave through a proxy sets `TABULA_LINK_PREVIEW_PROXY`, and then the guard's checks still apply to the target before it is handed to the proxy (open question 6).

### The request

- `GET` only, no body, no cookies (no cookie jar), no `Authorization`, no `Referer`.
- `User-Agent: TabulaLinkPreview/1.0 (+https://<this instance>/docs/link-previews)`. The page explains what the requests are and how a site can opt out. Sites that block it simply get no preview.
- `Accept: text/html,application/xhtml+xml;q=0.9`, `Accept-Language` from the person's browser (one value, so titles come in their language), `Accept-Encoding: gzip, br`.
- **Redirects** are followed by hand: at most 3, `301 302 303 307 308` only, `Location` resolved against the current address and put through the whole guard. `https` to `http` is allowed (many sites still do it) but noted in `finalUrl`.
- **Time**: 5 seconds for the whole unfurl, redirects and all, as one deadline (an `AbortSignal`), plus 2 seconds per DNS lookup inside it. Images get their own 5 seconds after the page.

### The answer

- **Status**: 2xx only. Anything else is `http_status` (the code is kept for the log, not shown).
- **Type**: `Content-Type` `text/html` or `application/xhtml+xml`, else `not_html`. A PDF, an image or a download link gets no preview and stays a link card with its domain (v2 may show a file icon).
- **Size**: the body is read up to **1 MB decoded** and the read stops as soon as `</head>` has been seen. A compressed body is counted after decoding, so a small gzip that expands to gigabytes stops at 1 MB (`too_large` only when no `</head>` came before the limit).
- **Character set** from the header or `<meta charset>`; unknown sets are read as UTF-8 with replacement characters.

### Parsing

No DOM library (the project's no-new-dependency rule, and a full HTML parser is more surface than this needs). A small tag scanner reads the `<head>`: `<title>`, `<meta property|name content>` for `og:*`, `twitter:*` and `description`, `<link rel="icon|shortcut icon|apple-touch-icon" href sizes type>` and `<base href>`. It decodes HTML entities (named and numeric), then cleans the text the way `cleanForModel` does in `server/board-ops.mjs`: control, zero-width, bidirectional and tag characters removed, whitespace collapsed, cut to the field's limit. Relative image and icon addresses are resolved against `<base>` or the final URL.

### Images and icons

- The preview image: the first `og:image` (or `og:image:secure_url`, or `twitter:image`). The icon: the largest `<link rel="icon">` or `apple-touch-icon` up to 256 px, else `/favicon.ico`.
- Each is fetched through the same guard and request rules, with `Accept: image/png,image/jpeg,image/gif,image/webp`, a 5-second deadline shared by both, and at most **2 MB** (image) and **256 KB** (icon). An ICO or SVG icon is skipped (no decoder on the server, and SVG is code); the card then shows a letter icon.
- The bytes go into the board's asset store through the same functions as an upload: type by magic bytes, size from the header, pixel cap, metadata stripped (`server/image-header.mjs`, `server/image-strip.mjs`), counted against the board's quota. A preview image that would pass the quota is dropped and the card keeps its text.
- No downscaling on the server (there is no image library); the 2 MB cap and the asset store's pixel cap bound it.

### Cache and limits

- **Cache**: the parsed answer, by normalised URL, for 24 hours, in memory (at most 2,000 entries, least recently used out), shared across boards of the instance. A hit for another board copies the asset ownership to that board (the bytes are content-addressed and stored once). **Refresh preview** skips the cache. Failures are cached for 10 minutes so a broken link is not hammered.
- **Rate limits**, kept in memory like the AI limits: 30 unfurls a minute and 300 an hour per person, 2,000 an hour per workspace, 10 a minute per client address in open mode; at most 4 fetches in flight per instance and 1 per destination host at a time. Over a limit: `429 rate_limited` with `retry-after`, and the card shows **Refresh preview** later.
- **Per board**: at most 500 link cards with stored images; past that new cards keep their text only (the asset quota applies anyway).

## The card without a preview

| `unfurl` | Shows | Actions |
|---|---|---|
| `pending` | A letter icon, the domain, the address as the title, a thin line "Loading preview…" | (after 30 s for others) **Refresh preview** |
| `ok` | The preview | **Refresh preview**, **Edit** |
| `failed` | Letter icon, domain, the address as the title, "No preview" in muted text; the reason as the tooltip ("The site didn't answer in time", "This address can't be previewed", "The page is too large", "Not a web page") | **Refresh preview**, **Edit** (type a title and description by hand) |
| `off` | Letter icon, domain, the address as the title | **Edit** |

- The **letter icon** is the first letter of the domain on a square of a colour derived from the domain (from the existing palette, so every theme has it), drawn locally. It is not a remote favicon.
- **Offline**: a stored preview draws from the asset cache like any image; a card added offline is `pending` and the app asks for its preview when the relay is reachable again, if the person who added it is still on the board (otherwise any editor can refresh).
- **Read-only boards, viewers, commenters** see whatever is stored and can click through; they see no Refresh or Edit.
- **Click** opens `url` with `window.open(url, '_blank', 'noopener,noreferrer')`. A click on a card is a selection first (as on any object); opening is the card's **Open link** button in the quick bar, `Ctrl/Cmd+click`, a double-click, or `Enter` on a selected card. That keeps dragging cards from opening tabs. The status line of the browser cannot show the address for a canvas object, so the card's tooltip shows the full address (and `finalUrl` when it differs) before you open it.

## Editing and refreshing

- **Edit** opens the card's text in place: title and description, plain text, same limits. An edited field is listed in `edited` and survives **Refresh preview**; clearing an edited field brings the fetched text back on the next refresh.
- **Refresh preview** fetches again (no cache), replaces image, icon and the fields not in `edited`, and is one undo step for the person who pressed it (unlike the first fill-in). Old image assets stay in history until their versions expire, as for images.
- Changing the address is **Edit link**: a new address refreshes everything and clears `edited`.

## Rendering

- `src/markup.ts` `objectMarkup` gets `case 'link'`: a `tray`-free card in the theme's paper colours (Swiss: square, 1 px rule, no shadow), text through `escapeXml` like every other text, images through the same `<image>` path as image objects (the asset's data or blob URL, never a remote address).
- Long words and addresses break anywhere; titles are clamped to two lines with an ellipsis.
- All five themes; on phones the quick bar's layout picker and **Open link** are in the overflow.

## Export, import and the other formats

- **PNG and SVG** draw the card with the stored image inlined, as for images. Draft: the SVG export wraps the card in an `<a href>` so the link still works in a browser (open question 8).
- **`.drift`** carries the card and its assets; **JSON** carries the fields and asset references, as for images.
- **Markdown summary**: `- [Title](https://…)` (the address alone without a title).
- **Paste between boards** copies the card and, like images, the asset bytes come along through the existing image path.
- **Templates**: a link card in a template keeps `url`, `title`, `description`, `siteName`; `image` and `icon` are dropped (templates hold no images in v1), so it shows the letter icon.

## MCP and the other AI tools

- `get_board` and `get_objects` show a link card as `{ type: 'link', url, title, description, siteName }`, fenced like all board text: **the title and description are text from a third-party page**, which can try to steer a model ("ignore previous instructions"). They get the same treatment as board text, never more trust.
- MCP can create a link card (`url` only, editors' tokens) without a preview; it does not trigger a fetch in v1 (open question 9).
- The AI features read the title, description and domain as board text.

## Privacy

- The linked site sees **the relay's address**, once, when the card is added or refreshed. No viewer's browser ever contacts it to draw the card.
- The address is stored in the board and visible to everyone who can open the board, including its query string. Addresses can carry secrets (signed download links, magic sign-in links, tokens in `?key=`). The card shows the full address in its tooltip; the paste of an address whose query looks like a token (`token`, `key`, `sig`, `signature`, `auth`, `code`, `access_token`, `X-Amz-Signature` and the like) asks "This link may contain a secret that everyone on the board will see. Add it anyway?" (open question 4).
- The relay logs an unfurl as the board id, the host name, the outcome code and the time. Never the path, the query or the page's text.
- The audit log (accounts mode) records nothing for an unfurl: adding a card is an ordinary board edit. The admin page shows the workspace's unfurl count for the last 24 hours next to the setting.

## Self-hosted, hosted, open mode and desktop

| | Default | Notes |
|---|---|---|
| Hosted workspace (`TABULA_CLOUD_*`) | **On** | Runs on Fly; the guard refuses `fdaa::/16` (Fly's private network) and the metadata address; TAB-103's network isolation is the second wall. The control plane can turn previews off per workspace through `cloud.limits` (a `linkPreviews: false` flag). |
| Self-hosted, accounts mode | **Off**, an admin turns it on under Admin, Workspace | The page warns that the relay will make requests to the internet on people's behalf, and points at `TABULA_LINK_PREVIEW_DENY` for internal networks with public-looking addresses. |
| Open mode | **Off**, `TABULA_LINK_PREVIEWS=on` turns it on | Anyone with a board link could make the relay fetch: the per-address limits apply and the operator opts in knowingly. |
| Desktop app | **Off** (no relay); with a relay configured, the relay's setting | A pasted address still makes a link card with `unfurl: 'off'`. |
| `TABULA_LINK_PREVIEWS=off` | Off everywhere on that instance, whatever the workspace setting | The operator's kill switch. |

## CSP impact

None. The card draws its image and icon from `/api/boards/:id/assets/:hash` (`'self'`, already in `img-src`), the letter icon is drawn locally, nothing is framed (`frame-ancestors` and the absent `frame-src` stay as they are), and opening a link is a navigation in a new tab, which CSP does not restrict. The relay's outbound fetches are server-side and not subject to the page's CSP. v2's embedded players would need `frame-src https://www.youtube-nocookie.com https://player.vimeo.com`, which is one of the reasons they are not in v1.

## Permissions

- Add, edit, refresh, change the address: owners and editors (open mode: everyone who can edit). Viewers and commenters: see and open.
- The unfurl route checks the board role itself (not only the client); a viewer's token cannot make the relay fetch.

## Security checklist (for the review of the build)

1. Every hop, image and icon goes through the guard; there is no code path to `fetch()` or `http.get()` with a URL that did not.
2. The connection goes to the address that was checked (the `lookup` override is tested with a resolver that answers differently the second time).
3. Redirect to a private address, to `file:`, to another port: refused.
4. IPv4-in-IPv6 forms, decimal and octal hosts, `localhost` and `*.localhost`, a host that resolves to one public and one private address: refused.
5. The body limit counts decoded bytes; a gzip bomb stops at 1 MB.
6. No environment proxy is used; no cookie is sent or kept.
7. Text is cleaned and capped; the card renders through `escapeXml`; an `og:image` of `javascript:` or `data:` is ignored.
8. Logs hold host names and codes only.
9. The rate limits and the concurrency cap hold under a burst.

## Limits

| What | Limit |
|---|---|
| Address | 2,048 characters, `http`/`https`, ports 80/443 |
| Response headers | 16 KiB; an oversized or malformed response is `unreachable` |
| Redirects | 3 |
| Time | 5 s for the page, 5 s for image and icon together, 2 s per DNS lookup |
| HTML | 1 MB decoded, reading stops at `</head>` |
| Content encoding | A single supported encoding is accepted case-insensitively; stacked or unknown encodings are `unreachable` |
| Preview image | 2 MB, PNG/JPEG/GIF/WebP, the asset store's pixel cap |
| Icon | 256 KB, PNG/JPEG/GIF/WebP |
| Title / description / site name | 300 / 1,000 / 100 characters |
| Rate | 30 a minute and 300 an hour per person, 2,000 an hour per workspace, 10 a minute per address in open mode, 4 in flight per instance, 1 per destination host |
| Cache | 24 h, 2,000 entries; failures 10 min |

## Tests

- `test/link-guard.test.ts` (pure): every refused range in both families, the IPv4-carrying IPv6 forms, numeric host forms, ports and schemes, user info, the deny list; and allowed public addresses.
- `test/link-fetch.test.ts` (in process, against local HTTP servers through an injected resolver and an injected "public" range, since the real guard would refuse `127.0.0.1`): redirects (count, relative, to a refused address, scheme change), the deadline, the body limit with and without compression, `</head>` early stop, non-HTML types, status codes, no cookies or proxy variables, DNS rebinding (a resolver that answers public then private: the connection still goes to the first address).
- `test/link-parse.test.ts`: OpenGraph, Twitter and plain HTML heads, entities, charsets, `<base>`, relative icons, hostile text (scripts in titles, bidi, 50 KB titles), missing fields.
- `test/link-unfurl-api.test.ts` (black box): roles, the workspace setting and the kill switch, open mode off by default, rate limits, the cache across boards and asset ownership, quota.
- Client: paste detection (a lone URL, a URL among text, `Shift+Ctrl+V`), layout from size, the states table, no remote image URL ever in the markup, the Markdown line, export, templates dropping assets.
- Visual: `link-card` states (pending, ok in three layouts, failed, off) in all themes at 390 and 1024.

## Not in this slice

Embedded players; site-specific cards (GitHub issue state, Figma frames, Linear issues, Google Docs titles behind sign-in); previews for PDFs and files; screenshots of pages; fetching from MCP; server-side image downscaling; refreshing old previews on a schedule.

### v2: special cases

- **YouTube and Vimeo**: the thumbnail from the oEmbed endpoint (through the guard), a play overlay, and the click still opens the site. An embedded player is a separate decision (CSP `frame-src`, privacy of the embed).
- **GitHub** issues and pull requests (state, number, labels) through the public API, unauthenticated, rate-limited per instance.
- **Linear** (TAB issues), **Figma**, **Google Docs**: these need the viewer's own sign-in, so the server cannot fetch them; v2 shows a site-specific card from the address alone (icon, kind, id).

## Slices

1. **The guard and the fetcher** (server only, no route): address checks, pinned connection, redirects, limits, parser, with the tests above. Reviewed on its own before anything calls it.
2. **The route, the cache, the limits, the settings** (`/api/boards/:id/unfurl`, workspace setting, `TABULA_LINK_PREVIEWS`, admin toggle), assets through the asset store.
3. **The card** (object type, markup, paste and drop, Link button, states, Edit, Refresh, quick bar, layouts), export, Markdown, templates, MCP read.
4. User guide page, CHANGELOG, the `/docs/link-previews` page the user agent points to, and `docs/images.md`'s "pasting a URL fetches nothing" updated to point here.

## Files

### New

- `server/link-guard.mjs` (address checks, ranges, pinned lookup), `server/link-fetch.mjs` (the request, redirects, limits), `server/link-parse.mjs` (head scanner), `server/link-routes.mjs` (route, cache, limits).
- `src/link-cards.ts` (pure: URL detection and normalising, layout from size, states, the secret-looking query check), `src/ui/link-add.ts` (paste, drop, the Link popover).
- `docs/guide/link-cards.md`, `docs/link-previews.md` (the page for site owners).
- The tests above.

### Existing (touched)

`src/types.ts`, `src/markup.ts`, `src/app.ts` (paste), `src/ui/board.ts` (rail button, drop), `src/ui/quickbar.ts`, `src/ui/props.ts`, `src/exporters.ts`, `src/flow.ts` (Markdown), `src/custom-templates.ts` and `server/templates.mjs` (drop assets), `server/board-ops.mjs` (`OBJ_TYPES`, summaries), `server/api.mjs` and `server/relay.mjs` (route, open mode), `server/assets.mjs` (ownership copy on a cache hit), the admin page, `docs/images.md`.

## Open questions for Johan

1. **Defaults**: on for hosted, off for self-hosted accounts mode and open mode (drafted). Or on everywhere with the guard, as the issue suggests for hosted only?
2. **Paste**: a lone URL becomes a link card, `Shift+Ctrl+V` keeps the old sticky (drafted). Or always a link card, with "Convert to sticky" in the quick bar?
3. **Click**: select first, open with **Open link**, `Ctrl/Cmd+click`, double-click or `Enter` (drafted), so dragging never opens a tab. Or a single click opens, like the issue says?
4. **Secrets in addresses**: warn when the query looks like a token (drafted), strip known tracking parameters (`utm_*`, `fbclid`) silently, or neither?
5. **Stored images per board**: previews count against the board's asset quota (drafted). Or a separate, smaller budget so links cannot crowd out real images?
6. **Proxy for outbound fetches**: `TABULA_LINK_PREVIEW_PROXY` for operators who route egress through a proxy (drafted, the guard still checks the target first). Needed in v1, or later?
7. **Accept-Language**: send the person's language so titles come back in it (drafted), or a fixed `en` so everyone gets the same preview?
8. **SVG export**: wrap link cards in `<a href>` so they stay clickable (drafted), or keep exports free of links?
9. **MCP**: may an MCP token trigger a preview fetch (it is an outbound request on an agent's word), or only create plain link cards (drafted)?
10. **Failed previews**: stay as they are until someone presses Refresh (drafted), or retry once by themselves the next time an editor opens the board?
11. **The `/docs/link-previews` page** for site owners (what the user agent is, how to opt out with `robots.txt` `User-agent: TabulaLinkPreview`): do we honour `robots.txt` (one more request per site, cached), or only document the user agent?
12. **v2 order**: YouTube/Vimeo thumbnails first, or GitHub cards first?
