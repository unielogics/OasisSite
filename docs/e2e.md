# End-to-end: the site against the public booking API

`scripts/e2e-site.ts` drives the built site in pinned Chromium against a public booking API, through
`tools/site/proxy.ts` (the site's host as nginx runs it: `dist/` with clean URLs, `404.html`, immutable `/assets`,
and the whole `/api/v1/public/*` prefix proxied to the API with cookies stripped).

```bash
pnpm e2e:site --api fixture            # tools/site/fixture-api.ts in-process (no backend needed)
pnpm e2e:site --stack site             # the dashboard's live stack named "site"
pnpm e2e:site --stack site --only links   # only the personal-link checks 10-21 (and the hygiene checks)
bash scripts/e2e-stack.sh [--only links]  # a live stack up, the e2e against it, the stack down (below)
```

Two builds are made per run (`dist-e2e-live`: `SITE_BOOKING=live` with the API's hours and availability baked in;
`dist-e2e-sms`: the launch default) and served on `--port` (3301) and `--port`+1; with `--api fixture` a third one,
`dist-e2e-catalog` (the launch default with a changed catalog as its `SITE_CATALOG_JSON` snapshot, built with
`pricing: "catalog"`: the two launch builds are the interim prices, DV-PRICE-INTERIM), is served on `--port`+3 for the
catalog check below. `--skip-build` reuses them.
Results: the console and `parity-reports/e2e-site.json`.

## The live stack

`scripts/e2e-stack.sh [e2e args]` does the whole thing in one shell, and is how it runs on the test server (one
`oasis-remote` run on the site checkout, after mirroring the backend and the dashboard):

```bash
oasis-remote ~/oasis/backend -- true; oasis-remote ~/oasis/dashboard -- true
oasis-remote ~/oasis/site -- 'bash scripts/e2e-stack.sh'               # every check
oasis-remote ~/oasis/site -- 'bash scripts/e2e-stack.sh --only links'  # the personal links
```

It is, by hand:

```bash
export PIN_PEPPER=$(openssl rand -base64 32)        # a test pepper for this run only, never a real secret
export SMS_ALLOWLIST=+12015550141,+12015550142,+12015550143,+12015550177,+12015550161,...,+12015550176
cd ~/oasis/dashboard
ALLOW_DEV_ENDPOINTS=true PUBLIC_WRITES_ENABLED=true PUBLIC_LINKS_ENABLED=true PUBLIC_SITE_URL=http://127.0.0.1:3301 \
  pnpm live:up --name site --backend ~/oasis/backend --profile design,demo,website-catalog --api-port 4081 --web-port 3281 \
  --origin http://127.0.0.1:3302
cd ~/oasis/site && pnpm e2e:site --stack site       # in the same shell: it needs the PIN_PEPPER
cd ~/oasis/dashboard && pnpm live:down --name site --drop
```

The backend checkout must carry the public booking API (backend main at or after `50ffac4`) and, for the link checks,
the personal-link API (W3c; main `0992512` has it). `website-catalog` seeds the website's services and prices as the
catalog (backend ADR 0160 plan A): without it the stack's catalog has none of the site's washes and the site refuses to
book any of them ("… can't be booked online yet"). `PUBLIC_WRITES_ENABLED=true` opens the website's public POSTs (codes,
bookings, joins; 404 while off, as in production until online booking opens). `SMS_ALLOWLIST` lets the stack text the e2e numbers (outside
production every other number is suppressed; the simulator delivers at once) and `ALLOW_DEV_ENDPOINTS` exposes the SMS
simulator's dev routes (not needed by the script itself); `PUBLIC_SITE_URL` (the live host, 3301) and `--origin` (the
launch build's host, 3302, where the link checks run) make the API accept the site hosts' `Origin` on the public POSTs.
`PUBLIC_LINKS_ENABLED=true` with a `PIN_PEPPER` turns the link routes on; the e2e runs checks 10-21 against them when the
stack answers them (else it says it skipped them) and needs the same `PIN_PEPPER` in its environment (it sets PINs for
its clients with the backend's hasher). The script reads `~/oasis/dashboard/.live-stack/site.json` (API URL, schema,
dev password, backend path, API log), first sets **Sunday closed** through `PUT /api/v1/settings/hours` as a seeded user with
`set.hours` when the design seed left it open (the owner's decision; production Settings are set by the owner), signs
in as a seeded manager through `POST /api/v1/auth/login` to read `GET /api/v1/ops/snapshot`, and reads the stack's
database through `psql` (the backend's `DATABASE_URL`, the stack's schema) for what the API does not expose: the
one-time code (the `sms_outbox` row while it is unredacted; otherwise the code is recovered from the challenge's
`sha256(id:code)` by searching the six digits, because the simulator delivers instantly and delivered one-time codes
are redacted) and the pending membership row.

### Personal links on a stack (`tools/site/stack-links.ts`)

The link checks talk to a `LinkDriver` (`tools/site/link-driver.ts`): the fixture's in-memory link API, or the stack's
real one. On a stack every link is issued the way the shop issues one: the backend's own `issueClientLink`
(`src/modules/identity/links.ts`), imported from the stack's backend checkout and run in the e2e's process against the
stack's schema (`issuedBy: staff`), and texted through the backend's own queue (`personal_link_<kind>`, the URL as a
secretVar). What a link needs is made the backend's way: the client (a `customers` row as the backend's link tests
insert it), a Gold membership (`createManualMembership`), the number's 30-day trust (`grantTrust`), a PIN
(`customer_pins` with the backend's PIN hasher and the run's pepper), an invoice (a real visit booked through the link
API by a calendar link of the same client, briefly trusted) with a staff-attached payment URL, the Gold plan's checkout
URL; expired and used links are aged or spent in their row, a revoked one is superseded by a newer link of the same kind
(the shop's next text). The texted code is read from the outbox or recovered from the challenge (above). Links switched
off: a second API process of the same backend on the same schema with `PUBLIC_LINKS_ENABLED=false` (port API+2), behind
its own site host (`--port`+6). Every page's link API answers are recorded and held to the contract the page is written
to (`src/site/link-contract.testkit.ts`). The API's per-address limit of 20 exchanges a minute is respected (the run
paces its link openings). Where the fixture and the real API differ by design:

- **16** an invoice URL off the allowlist: the real API never hands it out (`{status: link_pending}`, the managers are
  asked to text a payment link), so the page says "We'll text you a link" and nothing is followed; the fixture hands any
  URL back so the page's own allowlist ("We couldn't open the payment page") is shown.
- **10** on a stack "the API never kept the token" covers its server logs (the stack's API log and the links-off API's)
  and every row of every table of the schema (`row::text`; a link text's outbox body may carry its URL only until the
  text is final, then it is wiped), and each link's message row shows "[private link]".

## Checks

1. The API's hours say Sunday is closed; `#/visit` and the footer both read "Sunday Closed" and the visit page shows
   the API's Monday hours; the home pill, the day cards' open counts and NEXT OPEN come from the availability payload.
2. A guest booking (NEXT OPEN → guest → Hand wax → review → name, mobile, terms → Book) answers 201 with
   `deposit {dueCents: 2500, how: counter|link}`; the done step shows the reference; the appointment is in the ops
   snapshot (`"seq": N`) that the seeded manager reads (fixture: in its state).
3. The booked slot has one bay fewer (or is gone) in a fresh availability payload, and the reloaded board shows it.
4. The member path: menu → Book a time → mobile → Continue → the code step → the code → Verify → "1 of 4 this
   month" → a time → the review asks for the full name (no mobile field) → Confirm booking → 201 with
   `deposit.dueCents = 0` and `member: true`, booked under the typed name (fixture). A verified number without an active
   membership gets guest prices (the guest note "by vehicle size", no "1 of 4 this month").
5. `#/join?gold` → vehicles → details (Continue without the e-mail is refused on that step: "Add your email for the
   receipts.") → the checkout step has no card field → terms → Start Gold → 201 `pending_payment`,
   `next: checkout_link_by_sms`; a pending membership row exists for the number.
6. The honeypot (`website` non-empty) answers 202 with a fake reference and creates nothing.
   Prices and the catalog (fixture only). Interim prices (DV-PRICE-INTERIM, the live build): with the fixture's catalog
   changed (Signature Hand Wash at $50 for members, Gold at $109) the page still loads the catalog (booking keys) but
   `#/wash` keeps "from $40" with no $50/$60 and no "SAVE $", and `#/membership` keeps "from $129/mo" with no $109 or $99.
   Catalog price mode (DV-CATALOG) over `dist-e2e-catalog` (snapshot: Signature Hand Wash at $52, "SAVE $62") with the
   catalog request held: `#/wash` first shows the snapshot; released, the changed catalog shows "SAVE $60" and
   `#/membership` $109; on a second page production's unseeded catalog brings the design's services and prices back
   ("SAVE $54", no "SAVE $62", Hand wax, Interior deep clean) and none of the dashboard's own services.
7. SMS mode: Book composes `sms:+18623885827?&body=WASH booking: …` (wash, vehicle, time), Join composes
   `JOIN VIP: name · phone · car`, the design's own text links carry the texting number, and no POST reaches the API.
   Texting vs calling (DV-CONTACT): over the home view, the open menu, every hash route and the live join welcome step,
   every `sms:` link goes to `+18623885827` (none to the old number), every `tel:` link to `+12015986304` (none to the
   texting number), the Text WASH / quote / tint / member-line links are all there, 201-598-6304 is shown only on a
   `tel:` link and the "Text … " lines show 862-388-5827.
8. Theme (DV-THEME, `page.emulateMedia({ colorScheme })` and the context's `colorScheme`): a light device gets the light
   page before hydration (bundle held back) and after it; a dark device gets dark; nothing is stored by either; a live
   device change flips the page while nothing is stored; the header toggle stores its choice, which holds over a live
   device change and a reload on a device that says otherwise; the menu's Appearance Light on a dark device is stored
   and kept after a reload; no hydration error in any of them.
   Interim prices (DV-PRICE-INTERIM): the prerendered `index.html` of both launch builds and, at 390x844 and 1440x900
   in the light and the dark theme, the home view (before and after the price rows flip), every hash route (`#/tint`
   with each vehicle type), the join flow's vehicles step and the booking sheet (who, the guest wash step with an
   add-on, the review) show no "$" figure but $40, $129 and $25 (the page's whole text, hidden parts included, the
   title and the description), and $40 and $129 are there.
9. Over every page: no console error or page error, no request to another origin, no 5xx.
10-21. Personal links (`scripts/e2e-links.ts`), against the fixture's link API (the backend's own shapes, held to them
   by `tools/site/fixture-links.test.ts` with the key lists of `src/site/link-contract.testkit.ts`) or a live stack's real
   one (above, `tools/site/stack-links.ts`). They run on the launch build (`SITE_BOOKING=sms`; links do not depend on the
   booking mode), every page with the production Content-Security-Policy (the kit's `SITE_CSP` minus
   `upgrade-insecure-requests`, the test host is plain http) injected on the document, links issued as the shop issues
   them (the URL a text would carry); every 2xx answer of the link API is held to the contract keys (exchange, me, the
   verification steps, code request, booking, membership and payment starts; every route of the run answered):
   **10** the token is sent only in the body of `POST /links/exchange` (every browser request recorded: URL, headers,
   body; the fixture's request log and the site host's paths never carry it; over the whole run, every link);
   **11** scrubbed: no token in `location`, the DOM, storage, cookies or the title once hydrated, the history entry was
   replaced (go to `#/visit` and back: the scrubbed `/`), a reload does not reopen the link (memory only);
   **12** trust window: a trusted number books at once (no `/verify/*` call, booking recorded, the board from
   `/links/availability` with the session); an untrusted number is asked to confirm before anything is booked, books
   after the code, and a new link for that number then books without a code;
   **13** verify: the code request carries no phone, a verify link ends on "You're verified … until <date>", a PIN can be
   created after it ("1234" refused with the reason);
   **14** PIN lockout: the fifth wrong PIN of a page ends the page (the API's `IDENTITY_SESSION_LOCKED`: "Too many
   tries", a text-us link) and locks the PIN; the link opened again shows "Too many wrong PINs. Try again in 15 min…"
   even for the right PIN, the PIN field goes, the reset stays;
   **15** membership: `#/join?gold` (token scrubbed), code, e-mail, terms → the plan's Squarespace checkout, a pending
   membership and a checkout intent with the confirmed e-mail;
   **16** payment: the review shows the invoice the API answered (number, date, items, tax) and the balance, PIN → the
   invoice's Squarespace link; an invoice URL off the allowlist is not followed (fixture: "We couldn't open the payment
   page", a text-us link; stack: `link_pending`, "We'll text you a link", the managers asked);
   **17** dead links: expired, used, revoked and unknown tokens show their notice and the text-us link;
   **18** a link preview (a plain GET of the link URL) gets the static page and reaches no API; opening twice uses
   nothing (2 exchanges, 0 uses); a booking uses it once;
   **19** no CSP violation on any link page;
   **20** a second link in the same tab (`location.hash = '#/c/<B>'`) is exchanged and scrubbed and the page then uses
   its session;
   **21** links switched off (the fixture's gate, or a stack API with `PUBLIC_LINKS_ENABLED=false`: one exchange,
   answered 404): the home page as today (no sheet, no toast, the token scrubbed).
   Chromium logs each documented 4xx answer of the link API ("Failed to load resource: … 401") as a console line; those
   are counted and set aside for link pages only, every other console line still fails check 9.


## The theme before the first paint (`pnpm e2e:theme-paint`)

`scripts/e2e-theme-paint.ts [--dist dist] [--delay 1000]` serves a build through the same proxy (port 3305, the fixture
API on 3306), holds every request for `/assets/theme.<hash>.js` back by `--delay` ms and records every frame the
compositor produces from the navigation on (CDP `Page.startScreencast`), classified by pixels (most pixels near
`#06080A` = dark, near `#F2F3F1` = light). Six cases: the home page on a light and on a dark device with nothing stored,
with the opposite theme stored on each, and the 404 page on a light and a dark device. It fails when a frame in the
wrong theme is ever painted, when the first painted frame or the final screenshot is not the expected theme, or when no
page frame was seen. Against the build before the head script (the theme script after `#dc-root`), the light device
painted the dark markup for the whole delay.

