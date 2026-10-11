# Deviations from the design

Every difference between the design ("Oasis Site v2", `design/original/Oasis Site v2.dc.html` with its loose files) and
what the site renders is listed here with an id, and every entry in `design-patches/*.json` (a copy-map entry, a patch
op, a head drop) carries the id of the line that explains it. The compiler fails the build (exit 3) when a patch
references an id that is not listed here. The parity allow-list (`parity/allowlist.json`) and the harness's automatic
copy-map swaps reference the same ids: the ORIGINAL is rendered with each owner decision applied as a text swap, the
port implements the decision, and the two must then match at zero diff (docs/parity.md).

Owner decisions of 2026-10-10 (hours live from the dashboard, Sunday closed, real availability and booking with an
SMS fallback until the tablet is live, no card capture, placeholders for photos, self-hosted fonts) are the source
of every entry below.

## Content and data

- **DV-HOURS** Opening hours come from `GET /api/v1/public/hours` (the dashboard's Settings), prerendered from
  `SITE_HOURS_JSON` (fallback: `src/data/hours.fallback.json`) and refreshed after mount. The design's
  `hoursList` ("Sunday 9 AM – 3 PM") and `HOURS[0] = [9,15]` are replaced: **Sunday is closed**. Rows are grouped the
  way the design groups them ("Monday – Friday") and times keep the design's format ("8 AM – 6 PM"). Hours and the board
  are fetched again every 5 minutes and when the tab comes back; the payload's `today` is used only on its own date and
  its open/closed state is always worked out again from the clock (a baked Saturday "open" never reads OPEN NOW on
  Sunday or after closing).
  Harness: the original gets `t:'9 AM – 3 PM'` → `t:'Closed'` and `HOURS = [[9,15],` → `HOURS = [[24,24],` (no Sunday
  slots) before render.
- **DV-AVAIL** The open-times board, the day cards, "NEXT OPEN", the "N OF 3 BAYS OPEN NOW" pill, the booking sheet's
  slots and the SMS mock's times show real availability from `GET /api/v1/public/availability` (prerendered from
  `SITE_AVAILABILITY_JSON`, refreshed after mount and whenever the chosen wash or add-ons change) instead of the
  design's generated pattern (`rng()` seeded by the date). `vip` slots render as the design's "VIP"/"members" state.
  Without availability (no `SITE_AVAILABILITY_JSON` and no API yet) the board shows the open days from the hours with
  "text us" counts, the empty-board line reads "TEXT WASH TO 862-388-5827 TO CHECK TIMES" (the texting number, DV-CONTACT) and the sheet's time step
  carries a note with the same advice (an added, design-styled note; hidden when slots exist). The pill counts the
  open bays of the next bookable half hour ("OPEN NOW · TEXT TO CHECK TIMES" when unknown; the payload's `now` while it
  is under 10 minutes old, "CLOSED NOW" when it says closed), the design's `1 + floor(minutes/11) % 3` is gone. The
  query is `?days=7&service=<catalog key>` (no `addons`, which the API ignores; no `service` when the wash has no catalog
  key) and only the latest query's answer is applied. The picked day is remembered as a date, not as the design's
  position in a list that moves, for the review line, the composed text and the booking. The parity build and the harness's fixture endpoint feed the port the design's
  own pattern (`designAvailability`, `src/site/availability.ts`) so the board matches the original slot for slot; the
  pill text is allow-listed (`DV-AVAIL-pill`).
- **DV-CONTACT** Every contact fact (phone, e-mail, address lines, the Google Maps link) is a copy-map entry resolved
  from `site.config.json` `contact` (`toConfig`, or `toFormat` with `${contact.…}` placeholders), so an owner correction
  changes one file. **Texting and calling are two numbers** (owner decision of 2026-10-10): every way the site lets a
  visitor TEXT the shop uses `contact.smsE164` / `smsDisplay` (**+1 862-388-5827**): the design's five `sms:` links (the
  menu's and the visit page's "Text WASH", the 07 section, the footer's "Text WASH to book", the post-join member line),
  the pricing quote and tint quote links of the logic, the bridge's composed booking/join texts (sms mode) and every
  line that says which number to text ("Text WASH to …" in the menu, the visit page's "Text …" button, the 07 section's
  big number and the SMS thread header under it, the check-in step's "Or text HERE to …", the bridge's empty-board line,
  time-step note and offline toast). CALLS stay on `contact.phoneE164` / `phoneDisplay` (**+1 201-598-6304**): the two
  `tel:` links, the footer's visible call number and the JSON-LD `telephone` (`business.telephone`). The design shows
  201-598-6304 everywhere; the harness applies the same entries to the original as text swaps. E-mail and address
  values equal the design's. The placeholder phone "(201) 555-0123" of the member sign-in field becomes "Mobile number"
  (the design's own wording for the join flow). The text keyword "WASH" stays as designed.
- **DV-CATALOG** The services, add-ons, tint table, detailing, quote-only items, plan prices and perks and the guest
  booking fee come from the dashboard's Settings through `GET /api/v1/public/catalog` (backend ADR 0160 W2a, owner
  decision: Settings is the one catalog), prerendered from `SITE_CATALOG_JSON` (the build snapshot, like the hours) and
  applied again from the browser's catalog load after mount (`src/site/catalog.ts`, the bridge's catalog section).
  **Safety:** the catalog is used only when it is *website-ready*: both of the design's washes under their keys
  (`signature-hand-wash`, `exterior-hand-wash`) with a description, a duration and whole-dollar member and guest prices,
  both plans (`gold`, `vip`) with a monthly price and perks, a whole-dollar fee and the guest markup. Anything less
  (production before the owner runs the `website-catalog` seed, an unknown payload, a missing key, cents in a price)
  keeps the design's built-in content exactly as it is, and a live answer that is not ready brings the design's content
  back (a failed load keeps what the page has). Inside a ready catalog each section falls back to the design's own list
  on its own: add-ons (only those with a description and prices, in the catalog's order; the design's ids are kept for
  the items it knows, a new one is keyed by its catalog key), tint (needs the design's three vehicle types and both
  films, carbon and ceramic, priced), detailing (the `detail` packages with a description and prices), quote-only items
  (the catalog's `quotes`). Prices shown are the catalog's member and guest **starting** prices (`memberPriceCents` /
  `guestPriceCents`, a tint row's `memberMinCents` / `guestMinCents`; never `priceCents`) in the design's words: the
  price rows ("SAVE $9", "from $229", "Included"), the wash cards, the booking sheet, the Gold calculator ("4 × ($54 wash
  + $25 fee)", "Pays off at 2 washes"), "What VIP is worth", the join flow's plan cards, terms, summary and button, the
  comparison table's fee, the fee FAQ and the review step's fee lines. The template's 18 fixed price texts ("$99",
  "$169/mo", "$25 non-refundable booking fee", "Guests can book with prices 20% higher", "VIP from $229, guest from
  $275.", …) are bound to `site.cat` with `replace-text` ops (three of them name one text node of a mixed element with
  the op's new `child` index). Unchanged design copy: the wash names in the "VIP is worth" list and the SMS demo, the
  wash cards' steps, the home page's longer Gold/VIP perk lists, the plan names (Gold, VIP), "Carbon or ceramic film ·
  side & rear windows", the film words in "Carbon and ceramic film", the VLT options and film descriptions. The guest
  price of a member price the design computes with `g()` is the catalog's item with that member price (the first one if
  two items share a member price with different guest prices), else the catalog's markup rounded half up.
  Harness: no swap; `pnpm build:parity` bakes and `serve-dist` answers the design's content in the backend's shape
  (`tools/site/catalog-fixture.ts` `designCatalog()`), so the catalog-driven page must equal the original at zero diff.

## Booking and membership

- **DV-BOOK** The booking sheet books for real. Steps who → svc → time → review → done are the design's. On review
  the guest CTA reads **"Book"** (was "Pay $25 & book"), the due line reads "Booking fee" with "$25 due at the counter
  or by the link we text you. Pay $X after your wash." (`site.config.json` `booking.feeSubPrefix`), and guests get name
  and mobile fields (live mode only; the design had no contact fields for guests), a verified member a name field only
  (the API keeps the name a verified member sends, so only a typed name is sent). Submit = `POST
  /api/v1/public/bookings` with an `Idempotency-Key` per request kind, kept only for a retry of the identical body and
  dropped after a success; a `PUBLIC_SLOT_*` problem title becomes the design's toast and the time step reloads
  availability, `409 IDEMPOTENCY_IN_FLIGHT` is retried after `Retry-After`. The wash and add-on keys come from the live
  catalog (`GET /api/v1/public/catalog`: the configured key or the item with the design's name, never a look-alike);
  a booking whose wash or add-on the catalog does not carry is refused with a "text us" toast. The done step shows the real booking reference ("Ref
  OAS-00042", plus the deposit due) and the note reads "We'll text your confirmation and a reminder the day before."
  With **`SITE_BOOKING=sms`** (the launch default, until the SMS tablet is live) the same sheet composes the booking
  as a text (wash, vehicle, time, add-ons, guest/member) and opens `sms:+18623885827?&body=…` (the texting number, DV-CONTACT) instead of calling the
  API; nothing else changes. Test hook: `window.__oasisNavigate(url)` receives the sms:/tel: URL when defined.
- **DV-OTP** Members identify by phone + one-time code (live mode): "I'm a member · Continue" posts
  `/api/v1/public/otp`, an added **code step** (design-styled, after the who step) verifies it through
  `/api/v1/public/otp/verify`, and the member token travels with the booking. Only an ACTIVE membership
  (`member.active`) puts the sheet on the member side (no fee, the member's tier prices); a verified number without one
  books as a guest (the fee line, its terms and guest prices; a toast says so). In sms mode the member path is the
  design's (phone only).
- **DV-JOIN** Joining has no card fields: step 4 ("STEP 4 OF 4 · CHECKOUT", was PAYMENT) keeps the terms checkbox
  and explains that a secure Squarespace checkout link is texted; the card number, expiry and CVC inputs are removed
  (the original gets the same removal before render, plus its card validation line), the summary reads "Due at
  checkout" (was "Due today") and the member card loses the fake "•••• 0427". Submit = `POST
  /api/v1/public/memberships` (pending until the checkout is paid; live mode requires the receipts e-mail on the details
  step, as the API does, and a field the API refuses sends the visitor back there); the welcome step reads "…your
  Squarespace checkout link is on its way by text. Your 4 washes start the moment it's paid." In sms mode the submit
  composes "JOIN VIP: name · phone · cars" as a text. "Book your first wash" (live) opens the sheet at the member sign-in
  with the phone prefilled (no member pricing while the membership is pending).

## Assets and rendering

- **DV-FONTS** Archivo (wdth 62..125, wght 400..900), Hanken Grotesk 400–800 and JetBrains Mono 500/700/800 are
  self-hosted: the exact CSS and woff2 files Google served to Chrome were downloaded once at intake
  (`design/fonts`, `manifest.json` with URLs and sha256) and are folded into the page stylesheet as
  `/assets/*.woff2`. The helmet's two preconnects and the Google stylesheet link are dropped; the built site makes no
  external request. Harness: the original's Google Fonts requests are answered from the same vendored files.
- **DV-IMG** The five `<image-slot>` placeholders (loose/image-slot.js: a drop zone, a file picker, "or browse
  files", a `.image-slots.state.json` sidecar) render as static branded placeholders: the element keeps its tag and
  attributes, its content is a declarative shadow root (the design's chrome gradient, the Oasis wordmark and the
  slot's own caption in JetBrains Mono) with image-slot.js's `:host` rules, so the element's box and computed style
  are the design's. The helmet's `image-slot.js` script is not shipped. Parity: the slot interiors are masked
  (`DV-IMG-mask-*`); the host elements are compared like any other element.
- **DV-LOGO** `assets/oasis-logo.png` is not available yet (it exceeds the design tool's read limit). The build
  references `/assets/oasis-logo.<hash>.png` and generates a 1024×1024 transparent PNG in its place (the intake
  accepts the real file in `design/original/loose/assets/`; with `height:76px;width:auto` the real logo's aspect
  ratio decides the header's centre column width). The favicon set is built from the same file (transparent until
  then). Harness: the original is served the same placeholder.
- **DV-CLOCK** The design renders the clock label, "today" and the flap animation stamp from `Date`. The prerender
  pins `Date` to the build instant, and the browser's first render is pinned to the same instant until the host is
  about to mount (hydration must match); the bridge then re-renders with the real time, exactly the design's own
  first-paint sequence.
  The page's clock is also the **shop's** clock for every visitor: the design and the bridge read it through local
  getters and the page is prerendered in the shop's zone, so `Date.now()` and `new Date()` are shifted by the gap
  between the visitor's and the shop's UTC offsets (zero in New Jersey). A visitor elsewhere sees the shop's "today",
  clock label and opening times, and hydration matches the markup (src/client/boot.tsx `installShopClock`).
- **DV-THEME** The design's theme is a data-props default (**dark**) plus the header toggle and the menu's Appearance
  Dark/Light, and nothing is remembered. The site **follows the visitor's device** (`prefers-color-scheme: light` ->
  light; dark or no preference -> dark, the design's default), follows a change of that setting live while the page is
  open, until the visitor picks a theme with the design's own controls; that choice is **remembered on the device**
  (`localStorage["oasis-theme"]`, errors ignored) and wins over the device setting on later visits
  (`site.config.json` `theme`). The markup is prerendered dark; a small external script in `<head>`, parser-blocking
  and before the stylesheet (`src/client/theme.entry.ts`, no inline script under the CSP; `check:dist` enforces the
  placement), decides before `<body>` exists, so nothing of the page is painted before it on any network: it marks
  `<html data-oasis-theme>`, paints `<html>` in the theme's background until the body takes over, patches `data-theme` on
  the wrapper the moment the parser inserts it (a MutationObserver, disconnected once done), sets the body background
  the way the design's `componentDidUpdate` does (`#F2F3F1` / `#06080A`) and exposes the decision; boot passes it as the
  design's `theme` prop so hydration matches (`pnpm e2e:theme-paint`: no frame in the other theme with the script held
  back 1 s). The bridge applies live device
  changes through the design's own `themeOverride` only while nothing is stored, and stores the toggle/Dark/Light
  choices (never the device-driven changes). Harness: the "light"/"dark" runs emulate that color scheme on both sides
  and the ORIGINAL is rendered with the run's theme as its data-props default (the **DV-THEME swap**,
  `tools/parity/theme-swap.ts`: `"default":"dark"` -> `"default":"light"` in the theme prop of the raw document's
  `data-props`, light runs only); the `stored-choice` scenario seeds the opposite theme as the stored choice and renders
  the original in it.
- **DV-HASH** `#/membership`, `#/wash`, … are client-side views of the one document. The home view is prerendered;
  a hash in the URL is applied right after mount (the design's own `hashchange` handler). The sitemap lists `/` only.
- **DV-HEAD** Additions outside `#dc-root`: `<html lang="en">`, description, canonical, Open Graph (image = the
  logo), icons from the logo, the LocalBusiness JSON-LD (address, phone, `openingHoursSpecification` Monday–Saturday
  from the hours, Sunday absent), `robots.txt`, `sitemap.xml`, a `404.html` in the design's tokens that follows the
  device theme and the stored choice like the home page (the same `<head>` theme script; no hard-coded dark page
  background; the design's dark default without JavaScript), the `<head>` theme script (DV-THEME) and
  `<html data-oasis-theme>`. The design's own `<title>` and viewport metas are kept. Harness: `<html lang>` makes every element's computed `-webkit-locale`
  `"en"` instead of `auto` (`DV-HEAD-lang`); nothing renders differently.

## Harness notes (not deviations of the site)

- **DV-PARITY-blur** `parity/tolerances.json`: at the phone width the booking sheet's glass CTA bar
  (`backdrop-filter: blur(16px)`) rasterises a 13-row band over the content it overlaps with channel differences of
  at most 3/255 on the guest review and terms steps (about 4.9k of 390x128 pixels), while DOM, computed style, rects
  and vals are identical and the original is deterministic against itself. A pixel tolerance capped at 5200 for
  those two steps in the dark theme and at 6200 in the light theme (since DV-THEME the light runs render light: the
  same rows 3390-3474 of the bar, 1-2/255 per channel, measured 5603 and 5479 px); everything else stays at
  threshold 0.

## Fixture configuration (the dashboard bundles the pipeline's tests still run on)

- **DV-F1** hrefs: the dashboard bundles link between screens by `.dc.html` file name; the fixture pages live at
  `/settings`, `/payments` and `/operations`. `href-map.json` maps the file names to those routes (the Command
  Center file name has no page here and is mapped to `/`). Allow-listed on the original side as `DV-F1-*` swaps in
  the fixture harness configuration (tests only).
