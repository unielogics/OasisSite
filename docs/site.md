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
| `contact`, `catalog`, `fee` | `site.config.json` | the calling number (`phoneE164`/`phoneDisplay`), the texting number (`smsE164`/`smsDisplay`), e-mail, address, maps link; the design's service and add-on ids → catalog keys; the booking fee text |

## What the bridge replaces

- **Hours (DV-HOURS).** `hoursList` (visit page, footer) comes from the hours payload, grouped and formatted the
  design's way (`src/site/hours.ts`: "Monday – Friday · 8 AM – 6 PM", "Sunday · Closed"); the design's `HOURS` table
  is rebuilt from it. After mount the bridge fetches `/api/v1/public/hours` (3 s) and re-renders; a failure leaves the
  baked hours. A payload without `today` (the fallback file) gets `today`/`next` derived from the week and the clock.
- **Availability (DV-AVAIL).** The design's `days` getter (a `mulberry32` pattern seeded by the date) is replaced by
  the availability payload converted to the design's `{d, i, slots:[{m, st, bays}], word}` (`vip` → `members`). The
  board, the day cards, NEXT OPEN, the sheet's slots and the SMS mock's times all read it. The hero pill uses the
  payload's `now {baysFree, baysTotal}` when present, else the next bookable slot's bays. After mount, and whenever the
  sheet opens or the chosen wash/add-ons change, the bridge fetches `/api/v1/public/availability?days=7&service=<key>&addons=…`.
  Without any availability (no snapshot, no API) the board lists the open days with "text us" counts, the empty line
  reads "TEXT WASH TO 862-388-5827 TO CHECK TIMES" and the sheet's time step shows a note (`site.timeNote`).
- **Booking (DV-BOOK, DV-OTP).** The sheet's steps are the design's. `SITE_BOOKING=live`: the guest review step adds
  name and mobile fields; "Book" posts `/api/v1/public/bookings` with an `Idempotency-Key` minted when the sheet opens
  (`{name, phone, vehicle:{label}, serviceKey, addonKeys, date, startMin, smsConsent:true, memberToken?, website:''}`);
  a problem+json answer becomes the design's toast (`title`), a 409 also clears the slot and reloads the availability;
  the done step shows "Ref OAS-00042" and the deposit due. Members: "I'm a member · Continue" posts `/public/otp`, the
  added code step verifies through `/public/otp/verify`, the token travels with the booking (no fee), the member's
  tier sets the prices. `SITE_BOOKING=sms`: the same sheet composes the booking as a text
  ("WASH booking: Signature Hand Wash · Sedan / Coupe · Today 11:30 AM · + Hand wax · Guest") and opens
  `sms:+18623885827?&body=…` (the texting number `contact.smsE164`; calls stay on `contact.phoneE164`, DV-CONTACT); no
  API call is made.
- **Join (DV-JOIN).** Steps plan → vehicles → details → checkout (terms only, no card fields) → welcome. `live`: posts
  `/api/v1/public/memberships`; the welcome step says the Squarespace checkout link is on its way by text. `sms`: composes
  "JOIN VIP: name · phone · email · cars". "Book your first wash" (live) opens the sheet at the member sign-in.
- **First render (DV-CLOCK, DV-HASH).** The prerender pins `Date` to `buildNow`; the client pins it the same way until
  the host is about to run `componentDidMount` (`src/client/boot.tsx` `freeze`), then the bridge re-renders with the
  real time (`now`, `flapAt`) and applies the URL hash (`#/membership` etc. render after mount; the home view is the
  prerendered one).

- **Theme (DV-THEME).** `site.config.json` `theme` (`prop: "theme"`, `followSystem`, the body backgrounds) makes the
  build ship `src/client/theme.entry.ts` as `/assets/theme.<hash>.js`, a blocking script right after `#dc-root`: it
  decides the theme (a stored `localStorage["oasis-theme"]` choice, else the device's `prefers-color-scheme: light`, else
  the design's dark default), patches `data-theme`, sets the body background and exposes `window.__oasisTheme`; boot
  passes the decision as the design's `theme` prop (`withThemeDecision`). The bridge listens to
  `matchMedia('(prefers-color-scheme: light)')` and applies a change as `themeOverride` only while nothing is stored, and
  wraps `toggleTheme`/`setDark`/`setLight` to store the visitor's choice.

`window.__oasisNavigate(url)` is a test hook: when defined, sms:/tel: navigations go to it instead of
`location.href` (scripts/e2e-site.ts).

## Catalog keys

`site.config.json` `catalog` maps the design's service ids (`signature`, `exterior`) and add-on ids to the backend's
catalog keys (the slug of the service name in the dashboard's catalog, `GET /api/v1/public/catalog`). In every booking
mode the bridge fetches the catalog once, before the first availability query (which 422s on a key the API does not
know): a configured key that exists is used as is;
otherwise the service is matched to the catalog by name words ("Signature Hand Wash" → the closest package, e.g. the
seeded "Premium Hand Wash + Interior"), else the first package; an add-on without a configured or name match is left out
of the booking (the person still sees the design's add-on list). Once the owner's catalog carries the website's services
the configured keys resolve directly. The design's prices stay static content (owner decision).

## Deployment inputs

`deploy/scripts/site-deploy.sh` (backend kit) passes `SITE_URL`, `SITE_HOURS_JSON` (from the local API) and should pass
`SITE_AVAILABILITY_JSON` (`GET /api/v1/public/availability?days=7`) and `SITE_BOOKING=live` once the SMS tablet is
live; until then the default `sms` keeps every Book/Join action on the design's own sms: links. nginx must proxy the
whole `/api/v1/public/` prefix (the backend's `oasis-site.conf.template` does since the booking API landed).
