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
| `catalogSnapshot`, `catalogSource` | `SITE_CATALOG_JSON` or none | the public catalog payload (DV-CATALOG), kept only when it is website-ready and `pricing` is `catalog` |
| `pricing` | `SITE_PRICING`, else `site.config.json` `pricing`, else `interim` | `interim` (DV-PRICE-INTERIM, the default): only the starting prices and the fee; `catalog`: DV-CATALOG |
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

## Personal links (DV-LINK, DV-STEPUP, DV-LINK-JOIN, DV-LINK-PAY, DV-LINK-DEAD)

A text from the shop can carry a personal link, `https://oasisautospanj.com/#/<path>/<token>` with `path` `c`
(calendar, book again), `m` (membership), `p` (payment), `pin` (create / reset a PIN) or `v` (verify), the token 43
base64url characters (backend design `docs/design/ai-assistant-and-phone-identity.md` sections 5 and 7; the identity
core in backend `docs/api-spec.md` section 27). The page takes the base64url run after the path as the token and ignores
anything a messaging app or a shortener adds after it (`/`, `.`, `?utm=…`); the whole fragment is scrubbed either way.
The site side:

```
#/c/<token> ─► src/client/link.ts (while the bundle is evaluated, before hydrateRoot): history.replaceState(…, "/")
               (address bar + history entry scrubbed), token kept in memory, a hashchange listener for a second link
           ─► bridge __lkMount (componentDidMount): POST /api/v1/public/links/exchange {token}  (the ONLY place the token goes)
           ─► session (memory) ─► calendar: the booking sheet in linked mode | verify, pin: the step-up card
                                  membership: the join steps | pay: the payment review | 401: a dead-link notice | 404: nothing
```

Nothing changes without a fragment, and a 404 from the exchange (`PUBLIC_LINKS_ENABLED` off on the API, the default)
leaves the page exactly as it is without a link (the fragment is still scrubbed). Links work in both booking modes
(`SITE_BOOKING=sms|live`): a linked booking never goes to `/public/bookings` or to an sms: text. `site.config.json`
`links` holds the base path, the redirect host allowlist (`redirectHosts`: `squarespace.com` and its subdomains, https
only, no credentials or port) and the "text us for a new link" body; the code is in `src/client/link.ts` (capture),
`src/site/links.ts` (shapes, allowlist, words) and the "links (W3f)" section of `src/site/index.bridge.ts`.

### The link API the site calls

Base `/api/v1/public/links` (same origin through nginx's `/api/v1/public/` location), JSON in and out, `credentials:
'omit'`, `cache: 'no-store'`, `referrerPolicy: 'no-referrer'`; every route but the exchange carries
`Authorization: Bearer <session>`. Problems are `application/problem+json` with `code`, `title`, `detail` (written
for the client: the page shows `detail`, else `title`) and `meta`. This is the backend's personal-link API (backend
`docs/api-spec.md` section 28, W3c) and its shapes, field for field: `src/site/link-contract.testkit.ts` copies its key
lists, the bridge tests build their answers with it, and `tools/site/fixture-links.test.ts` holds the fixture
(`tools/site/fixture-links.ts`, what the e2e runs against) to it. When the API's schemas change, change that file
first. The e2e's `--stack` mode cannot run the link checks until W3c is on the stack's backend (the stack has no
`/public/links` routes and no way to issue a link); the contract test is the guard until then.

Every verification step answers `{verified, ...LinkState}` and the page takes that state (trust, `stepUp`, a name or an
invoice the stale-record rule hid until the page was verified):

`LinkState` = `{kind, expiresAt, idleExpiresAt, link: {expiresAt}, client: {firstName ('' when unknown or hidden),
last2, tier: gold|vip|null}, trust: {verified, by: pin|code|null, until}, stepUp: {method: pin|code, freshUntil,
canSetPinUntil}, appointments: [...] | null, invoice: {number, date, items: [{name, priceCents}], subtotalCents,
taxCents, tipCents, totalCents, paidCents, balanceCents} | null, plan: {tier, planKey, name, monthlyPriceCents, perks}
| null}`.

| call | body | answer the site uses | problems the site handles |
| --- | --- | --- | --- |
| `POST /exchange` | `{token}` | `{session, ...LinkState}` | 404 (links off: nothing shown), 401 `IDENTITY_LINK_INVALID` `meta.reason` expired\|used\|revoked\|not_found (dead-link notice), 429 |
| `GET /availability?days=7&service=<key>` | | the public availability payload, the client's own (VIP-aware once verified) | any failure: back to the public board |
| `POST /verify/code` | `{purpose: verify\|pin_set\|pin_reset}` (never a phone) | 202 `{challengeId, expiresInSec, purpose, to}` | 409 `IDENTITY_PIN_REQUIRED` (switch to the PIN), `IDENTITY_PIN_EXISTS` (offer the reset), `IDENTITY_PIN_NOT_SET`, 429 limits |
| `POST /verify/code/confirm` | `{challengeId, code}` | `{verified, ...LinkState}` (`verified: false` after a `pin_reset` code) | 401 `PUBLIC_OTP_INVALID`, 429 `PUBLIC_OTP_LOCKED` / 410 `PUBLIC_OTP_EXPIRED` (ask for a new code), 409 `IDENTITY_PIN_REQUIRED` |
| `POST /verify/pin` | `{pin}` | `{verified, ...LinkState}` | 401 `IDENTITY_PIN_INVALID`, 429 `IDENTITY_PIN_LOCKED` / 423 `IDENTITY_PIN_DISABLED` (lockout text, reset only), 429 `IDENTITY_TOO_MANY_TRIES`; the page's fifth wrong PIN answers 429 `IDENTITY_SESSION_LOCKED` (the page ends) and locks the PIN, which the next page of the link shows |
| `POST /pin` | `{pin}` | `{verified, ...LinkState}` | 403 `IDENTITY_CODE_REQUIRED`, 409 `IDENTITY_PIN_EXISTS`, 422 `IDENTITY_PIN_REJECTED` (the reason, in the API's words: "Don’t use digits in a row like 1234.") |
| `POST /pin/reset` | `{pin}` (after a `pin_reset` code) | `{verified, ...LinkState}` | as `/pin` |
| `POST /bookings` + `Idempotency-Key` | `{serviceKey, addonKeys, date, startMin, vehicle: {label}, name?}` (`name` only when the link has no client name) | 201 `{bookingRef, status, start, end, deposit, confirmationBy, service, addons, when, member, bayCount}` (the page uses `bookingRef`, `deposit`, `confirmationBy`) | 403 `IDENTITY_STEP_UP_REQUIRED` (step-up, then again), `PUBLIC_SLOT_*` (pick another time), 409 `IDENTITY_LINK_USED` (dead) |
| `POST /membership/start` | `{email}` | `{redirectUrl, membershipRef, checkoutExpiresAt}` (`redirectUrl` followed only when allowed) | 403 `IDENTITY_STEP_UP_REQUIRED` (step-up, then again), 422 with an `email` error (back to the e-mail step), 409 `LINK_ALREADY_MEMBER` / `LINK_CHECKOUT_UNAVAILABLE`, 403 `LINK_PRIVILEGES_HELD` (their words) |
| `POST /pay/start` | `{}` | `{status: 'redirect', redirectUrl}` or `{status: 'link_pending', redirectUrl: null}` | 403 `IDENTITY_STEP_UP_REQUIRED`, 403 `LINK_PRIVILEGES_HELD`, 409 `IDENTITY_LINK_USED` |

On every call: 401 `IDENTITY_SESSION_INVALID` → the token (still in memory) is exchanged again once and the call
repeated (same Idempotency-Key), a failed re-exchange shows the dead-link notice; 401 `IDENTITY_LINK_INVALID`,
409 `IDENTITY_LINK_USED`, 429 `IDENTITY_SESSION_LOCKED` end the link (notice); 401 `LINK_WRONG_PURPOSE` shows its
words. `stepUp.method` picks the step-up: `pin` opens the PIN entry (with "Forgot your PIN? Text me a code"), `code` a
texted code; a 409 `IDENTITY_PIN_REQUIRED` (a PIN set meanwhile) switches to the PIN. "Create a PIN for next time" is
offered only while `stepUp.canSetPinUntil` is set (never on a stranger's link). The page treats a PIN or code entered
on it in the last 4.5 minutes as fresh (the server's rule is 5; an answer whose `stepUp.freshUntil` is null is not
fresh) and asks again for a membership or a payment otherwise; the server's 403 `IDENTITY_STEP_UP_REQUIRED` is handled
the same way. A membership link opens the join page of the plan's `tier` (else its `planKey` through `site.config.json`
`catalog.plans`); a plan the website does not show is never guessed: "Let's finish this by text". A client the
stale-record rule hides (`firstName` '' and no invoice until verified) is asked to confirm first: a booking asks for a
name only if the step's answer still has none, a payment link shows its review once the step's answer carries the
invoice.
`POST /appointments/:ref/reschedule` is in the fixture but the page does not call it yet (no reschedule UI in this
wave).

### Linked states

| link | opens | then |
| --- | --- | --- |
| calendar, book again | the booking sheet at "Choose your wash", eyebrow "BOOKING FOR MARIA ••51 · STEP 1 OF 3", no back to the who step, the tier from the link (member prices / no fee), the client's own board; every Book button of the page books for the client | review → (not trusted: the step-up card as a sheet step "Confirm it's you", then the booking goes on by itself) → `POST /bookings` → the design's done step with the reference |
| verify | the link sheet with the step-up card (PIN when set, else "Text me a code") | "You're verified" (until the trust date) + optional "Create a PIN for next time" |
| pin | the step-up card: code (`pin_set`, or `pin_reset` when a PIN exists) → new PIN | "Your PIN is set" |
| membership | `#/join?<plan>`: plan (the other plan says it is not this link's) → step-up in the join column → "Joining as MARIA ••51" + e-mail → terms ("Continue to checkout") | `POST /membership/start` → Squarespace checkout (allowlist) |
| pay | the link sheet with the payment review ("Invoice #20611", the visit's date, the items, tax and tip, what was already paid, balance due; "Verify & pay $54") | step-up (fresh every time) → `POST /pay/start` → the payment link (allowlist), "We'll text you a link", "Nothing to pay" |
| dead | the link sheet: "This link expired" / "was used" / "was replaced" / "doesn't work" / "Too many tries" | "Text us for a new link" (sms: to the texting number) and "Back to home" |

The link sheet (`state.sheet === 'link'`) hides the design's booking summary column (`site.sheetSummary`). All the view
model of the new blocks lives under `site.link` (the bridge's own key, already allow-listed for the vals check).

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

## Interim prices (DV-PRICE-INTERIM, the default)

Owner, 2026-10-12 (plan decision 9): prices depend on the vehicle size, a single wash starts at $40 and membership at
$129/month, and the real per-size catalog (public catalog v2) comes later. Until the site switches to it,
`site.config.json` `"pricing": "interim"` makes the page show only three figures: the Signature Hand Wash "from $40",
Gold "from $129" (/mo) and the $25 booking fee. Every other price reads "Priced by vehicle size — ask us", or "Ask us"
where the design's slot only fits a price; the old model's statements are gone (guests' "prices 20% higher", member vs
guest pairs, "SAVE $N", the Gold savings calculator, "A VIP month, priced as a guest", the tint savings, the "$0"
lines). The surfaces, before and after, are listed under DV-PRICE-INTERIM in `design-patches/DEVIATIONS.md`.

- **The live catalog is not applied to the content** in this mode (`__applyCatalog` keeps the design's data and
  `__site` null; the build does not bake `SITE_CATALOG_JSON`, with a warning): it carries the old member/guest model.
  It is still fetched for the booking keys (the availability query and a live booking), exactly as before.
- **Where the words come from.** The bridge's DV-PRICE-INTERIM section (`__interimHome`, `__interimPrice`,
  `__interimPages`, `__interimJoin`, `__interimSheet`) writes the interim words over the design's view models, field
  for field and key order kept; the template's fixed texts are `site.cat` values (`src/site/catalog.ts` `interimTexts`;
  catalog mode: `catalogTexts`, the design's words): the 18 DV-CATALOG ops plus 12 DV-PRICE-INTERIM ops in
  `design-patches/index.patch.json` (one `set-attr` appends `display:{{ site.cat.calcDisplay }}` to the calculator box,
  `none` in interim mode). The figures and words live in `INTERIM` (`src/site/catalog.ts`).
- **Parity.** The harness applies the same decision to the original as pre-render swaps (`parity/allowlist.json`
  `DV-PRICE-INTERIM-*`, original only), so the port matches it at zero diff. `src/site/bridge-interim.test.ts` holds the
  bridge and the swaps together over every price state; `tools/parity/copy-swaps.test.ts` checks the swaps against the
  real design document.
- **Switching to the live catalog (wave Q3c).** Set `pricing` to the new mode, remove the `DV-PRICE-INTERIM-*` swaps
  from the allow-list, and replace the bridge's DV-PRICE-INTERIM section with the catalog v2 view models; the
  DV-PRICE-INTERIM ops stay useful (their `site.cat` keys then carry the catalog's texts, `catalogTexts` gives the
  design's).

## Catalog content (DV-CATALOG, pricing "catalog")

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

`SITE_PRICING` (optional, `interim` | `catalog`) overrides `site.config.json` `pricing` for one build; the deploy kit
does not pass it, so production builds the interim prices.

`deploy/scripts/site-deploy.sh` (backend kit) passes `SITE_URL`, `SITE_HOURS_JSON` (from the local API) and should pass
`SITE_AVAILABILITY_JSON` (`GET /api/v1/public/availability?days=7`), `SITE_CATALOG_JSON` (`GET /api/v1/public/catalog`;
harmless before the seed: not ready, a warning, the design's content) and `SITE_BOOKING=live` once the SMS tablet is
live; until then the default `sms` keeps every Book/Join action on the design's own sms: links. nginx must proxy the
whole `/api/v1/public/` prefix (the backend's `oasis-site.conf.template` does since the booking API landed).
