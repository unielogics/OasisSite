# The site layer: live data, booking modes, the bridge

The design ("Oasis Site v2") is one document with hash routes, a logic class of 55 KB and fabricated data (a generated
open-times board, mock booking and join flows with card fields, Sunday hours). The site keeps the design's rendering
and replaces the data and the flows through one module, the **bridge** (`src/site/index.bridge.ts`), wrapped around
the logic class at build time (`site.config.json` `bridges`, docs/compiler.md). Every change is a
`design-patches/DEVIATIONS.md` entry.

```
site.config.json ──┐
SITE_* env ────────┼─► tools/prerender/site-env.ts ─► .generated/<variant>/site-env.js ─┐
hours / availability snapshots ─┘                                                    ├─► <slug>.logic.js = design logic + bridge(Component, env)
design/extracted/index/logic.original.js ────────────────────────────────────────────┘
```

## `SiteEnv` (src/site/env.ts)

Written by the build, imported by the bridge and the prerender, bundled into the page script (public data only):

| field | from | meaning |
| --- | --- | --- |
| `booking` | `SITE_BOOKING` (`sms` default, `live`) | what Book / Join / "Pay & book" do (below) |
| `apiOrigin` | `SITE_API_ORIGIN` (`''`) | the API origin for the browser; empty = same origin (nginx proxies `/api/v1/public/*`) |
| `endpoints`, `timeouts` | `site.config.json` | `/api/v1/public/{hours,availability,bookings,otp,otp/verify,memberships,catalog}` |
| `buildNow` | `SITE_BUILD_NOW` / `PRERENDER_NOW` / now | the prerender instant; the client's first render is pinned to it (DV-CLOCK) |
| `hours`, `hoursSource` | `SITE_HOURS_JSON` or `src/data/hours.fallback.json` | the public hours payload (Sunday closed) |
| `availability`, `availabilitySource` | `SITE_AVAILABILITY_JSON` or none | the public availability payload baked into the board |
| `catalogSnapshot`, `catalogSource` | `SITE_CATALOG_JSON` or none | the public catalog payload (DV-CATALOG), kept only when it is website-ready |
| `contact`, `catalog`, `fee` | `site.config.json` | the calling number (`phoneE164`/`phoneDisplay`), the texting number (`smsE164`/`smsDisplay`), e-mail, address, maps link; the design's service and add-on ids → catalog keys; the booking fee text |

## What the bridge replaces

- **Hours (DV-HOURS).** `hoursList` (visit page, footer) comes from the hours payload, grouped and formatted the
  design's way (`src/site/hours.ts`: "Monday – Friday · 8 AM – 6 PM", "Sunday · Closed"); the design's `HOURS` table
  is rebuilt from it. After mount the bridge fetches `/api/v1/public/hours` (3 s) and re-renders, again every 5 minutes
  and when the tab comes back (`visibilitychange`); a failure leaves the baked hours. The payload's `today` is a snapshot
  (the deploy bakes the API's answer): `withToday` uses its hours only while its date is the shop's today and always
  works the open/opens-later/closed state out again from the clock; a `today` of another day (or none, the fallback
  file) is derived from the week and the payload's closures, so the hero pill never says OPEN NOW from the build.
- **Availability (DV-AVAIL).** The design's `days` getter (a `mulberry32` pattern seeded by the date) is replaced by
  the availability payload converted to the design's `{d, i, slots:[{m, st, bays}], word}` (`vip` → `members`). The
  board, the day cards, NEXT OPEN, the sheet's slots and the SMS mock's times all read it. The hero pill uses the
  payload's `now {baysFree, baysTotal}` when present, else the next bookable slot's bays. After mount, and whenever the
  sheet opens or the chosen wash changes (and with the hours, every 5 minutes), the bridge fetches
  `/api/v1/public/availability?days=7&service=<key>` (no `addons`: the API ignores them, and one URL per wash keeps the
  60-second cache in front useful; `service` is left out when the wash has no catalog key, the API then answers for its
  first package). Only the latest query's answer is applied (a sequence number), so a slow answer for another wash never
  replaces the board. The payload's `now` (bays free) is believed for 10 minutes after its `generatedAt` and never over
  its own `open: false`; today's starts that have passed are dropped from a baked board.
  The design keeps the picked day as a position in `days`, a list that moves (a refresh drops a day whose last start
  passed, midnight shifts it): the bridge remembers the picked DATE, puts the position back on it after every update, and
  builds the booking and the composed text from that date; when the date or the time is gone the pick is cleared, the
  review goes back to the times and the toast says so.
  Without any availability (no snapshot, no API) the board lists the open days with "text us" counts, the empty line
  reads "TEXT WASH TO 862-388-5827 TO CHECK TIMES" and the sheet's time step shows a note (`site.timeNote`).
- **Booking (DV-BOOK, DV-OTP).** The sheet's steps are the design's. `SITE_BOOKING=live`: the guest review step adds
  name and mobile fields (a verified member: the name only); "Book" posts `/api/v1/public/bookings`
  (`{name, phone, vehicle:{label}, serviceKey, addonKeys, date, startMin, smsConsent:true, memberToken?, website:''}`)
  with an `Idempotency-Key` per request kind (bookings and joins never share one) that is kept only for a retry of the
  identical body and dropped once the request succeeded (a new booking after closing the confirmation gets a new key);
  a problem+json answer becomes the design's toast (`detail` for a 422, else `title`); only a `PUBLIC_SLOT_*` code
  clears the slot and reloads the availability; `409 IDEMPOTENCY_IN_FLIGHT` waits `Retry-After` and sends the identical
  request again (it replays the first one's answer); the done step shows "Ref OAS-00042" and the deposit due. The
  `name` sent is only what the visitor typed (the API keeps a verified member's name as given, so the code check's first
  name is never echoed back). Members: "I'm a member · Continue" posts `/public/otp`, the added code step verifies
  through `/public/otp/verify`; only `member.active` puts the sheet on the member side (tier prices, no fee, no fee
  terms); a verified number without an active membership books as a guest (guest prices, the fee and its terms, the
  token still proves the number), and a join pending payment never sets the tier. `SITE_BOOKING=sms`: the same sheet composes the booking as a text
  ("WASH booking: Signature Hand Wash · Sedan / Coupe · Today 11:30 AM · + Hand wax · Guest") and opens
  `sms:+18623885827?&body=…` (the texting number `contact.smsE164`; calls stay on `contact.phoneE164`, DV-CONTACT); no
  API call is made.
- **Join (DV-JOIN).** Steps plan → vehicles → details → checkout (terms only, no card fields) → welcome. `live`: the
  details step also requires the receipts e-mail (the API's MembershipBody does), posts `/api/v1/public/memberships`
  (a 422 on a field goes back to the details step with the API's words); the welcome step says the Squarespace checkout
  link is on its way by text. `sms`: composes "JOIN VIP: name · phone · email · cars" (e-mail optional). "Book your first
  wash" (live) opens the sheet at the member sign-in (the membership is pending until paid).
- **First render (DV-CLOCK, DV-HASH).** The prerender pins `Date` to `buildNow`; the client pins it the same way until
  the host is about to run `componentDidMount` (`src/client/boot.tsx` `freeze`), then the bridge re-renders with the
  real time (`now`, `flapAt`) and applies the URL hash (`#/membership` etc. render after mount; the home view is the
  prerendered one).

- **Theme (DV-THEME).** `site.config.json` `theme` (`prop: "theme"`, `followSystem`, the body backgrounds) makes the
  build ship `src/client/theme.entry.ts` as `/assets/theme.<hash>.js`, a parser-blocking external script in `<head>`
  before the stylesheet (home page and 404 page; `check:dist` enforces it). It runs before the parser has created
  `<body>`, so nothing of the page can be painted before it, however slow the network: it decides the theme (a stored
  `localStorage["oasis-theme"]` choice, else the device's `prefers-color-scheme: light`, else the design's dark default),
  sets `<html data-oasis-theme>` and the theme's page background on `<html>`, exposes `window.__oasisTheme`, and watches
  the parser (a MutationObserver on the document, disconnected once the wrapper is patched or the parser is done): the
  inserted `<body>` gets the background the design's `componentDidUpdate` sets (`<html>` gives its own back) and the
  wrapper baked `data-theme="dark"` gets the decided theme before the first frame (`pnpm e2e:theme-paint` records every
  frame with the script held back 1 s). Boot passes the decision as the design's `theme` prop (`withThemeDecision`). The bridge listens to
  `matchMedia('(prefers-color-scheme: light)')` and applies a change as `themeOverride` only while nothing is stored, and
  wraps `toggleTheme`/`setDark`/`setLight` to store the visitor's choice.

`window.__oasisNavigate(url)` is a test hook: when defined, sms:/tel: navigations go to it instead of
`location.href` (scripts/e2e-site.ts).

## Catalog keys

The booking keys come from the live catalog (`GET /api/v1/public/catalog`, fetched once per page in every booking
mode, before the first availability query, and again at a live submit when it had failed). For each of the design's
washes and add-ons the bridge takes the catalog item whose key is the one configured in `site.config.json` `catalog`,
else the item whose name is the design's name (the same slug, the way the backend keys its items), and nothing else:
there is no closest match. **Fail safe:** a wash or add-on the catalog does not carry has no key; a live booking that
needs one is refused before any request ("Signature Hand Wash can't be booked online yet. Text WASH to …", "… Remove it,
or text WASH to …"), the board then asks for the API's default wash, and the sms texts name the design's items as
before. Production's catalog (2026-10-11) still carries the dashboard's own services (Express Hand Wash, Premium Hand
Wash + Interior, …) until the owner runs the backend's `website-catalog` seed, so `SITE_BOOKING=live` books nothing
until then; the seed gives every design item its key (an add-on new to the design is booked under its catalog key).

## Catalog content (DV-CATALOG)

The same catalog payload is the page's content once it is **website-ready** (`src/site/catalog.ts` `websiteCatalog`):
both washes under their keys with a description, a duration and whole-dollar member and guest prices, both plans with a
monthly price and perks, a whole-dollar fee and the guest markup. Then the design's data fields (`WASH`, `DURING`,
`TINT`, `VEH`, `FEE`) carry the catalog's content and the bridge's catalog section writes the view models' fixed
numbers again from it (price groups, wash cards, booking sheet, Gold calculator, "What VIP is worth", the join flow's
plans, the fee lines and FAQ); the template's fixed price texts are `site.cat` strings (18 `replace-text` ops). Each
section falls back to the design's list on its own (add-ons, tint, detailing, quote-only items), and anything short of
ready keeps the design's content exactly. The build bakes `SITE_CATALOG_JSON` (only when ready); the browser's catalog
load applies the live answer after mount (`forceUpdate`), so a not-ready answer brings the design's content back and a
failed load keeps the snapshot. Shown prices are the starting prices (`memberPriceCents`/`guestPriceCents`, a tint row's
`memberMinCents`/`guestMinCents`), never `priceCents`, each item's own (the booking sheet's guest prices too: the bridge
writes them by item over the design's `g(member)`); a picked add-on or vehicle type a new catalog drops leaves the
visitor's choice. Fixtures: `tools/site/catalog-fixture.ts` (`designCatalog()` =
the design's content in the backend's shape, what the parity build bakes and its server answers; `unseededCatalog()` =
production before the seed). Tests: `src/site/catalog.test.ts`, `src/site/bridge-catalog.test.ts` (every price state
equal to the built-in content with the design catalog, a changed price showing, an item's own guest price on the
booking sheet, a dropped vehicle type, the unseeded fallback),
`tools/prerender/prerender.test.ts` (the baked snapshot) and the e2e's catalog checks.

## Deployment inputs

`deploy/scripts/site-deploy.sh` (backend kit) passes `SITE_URL`, `SITE_HOURS_JSON` (from the local API) and should pass
`SITE_AVAILABILITY_JSON` (`GET /api/v1/public/availability?days=7`), `SITE_CATALOG_JSON` (`GET /api/v1/public/catalog`;
harmless before the seed: not ready, a warning, the design's content) and `SITE_BOOKING=live` once the SMS tablet is
live; until then the default `sms` keeps every Book/Join action on the design's own sms: links. nginx must proxy the
whole `/api/v1/public/` prefix (the backend's `oasis-site.conf.template` does since the booking API landed).
