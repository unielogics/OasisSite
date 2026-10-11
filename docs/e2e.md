# End-to-end: the site against the public booking API

`scripts/e2e-site.ts` drives the built site in pinned Chromium against a public booking API, through
`tools/site/proxy.ts` (the site's host as nginx runs it: `dist/` with clean URLs, `404.html`, immutable `/assets`,
and the whole `/api/v1/public/*` prefix proxied to the API with cookies stripped).

```bash
pnpm e2e:site --api fixture            # tools/site/fixture-api.ts in-process (no backend needed)
pnpm e2e:site --stack site             # the dashboard's live stack named "site"
```

Two builds are made per run (`dist-e2e-live`: `SITE_BOOKING=live` with the API's hours and availability baked in;
`dist-e2e-sms`: the launch default) and served on `--port` (3301) and `--port`+1; with `--api fixture` a third one,
`dist-e2e-catalog` (the launch default with a changed catalog as its `SITE_CATALOG_JSON` snapshot), is served on
`--port`+3 for the catalog check below. `--skip-build` reuses them.
Results: the console and `parity-reports/e2e-site.json`.

## The live stack

```bash
cd ~/oasis/dashboard
ALLOW_DEV_ENDPOINTS=true SMS_ALLOWLIST=+12015550141,+12015550142,+12015550143,+12015550177 PUBLIC_SITE_URL=http://127.0.0.1:3301 \
  pnpm live:up --name site --backend ~/oasis/backend --profile design,demo --api-port 4081 --web-port 3281
cd ~/oasis/site && pnpm e2e:site --stack site
cd ~/oasis/dashboard && pnpm live:down --name site --drop
```

The backend checkout must carry the public booking API (backend main at or after `50ffac4`). `SMS_ALLOWLIST` lets the
stack queue the e2e numbers' texts (outside production every other number is suppressed) and `ALLOW_DEV_ENDPOINTS`
exposes the SMS simulator's dev routes (not needed by the script itself); `PUBLIC_SITE_URL` makes the API accept the
site host's `Origin` on the public POSTs. The script reads `~/oasis/dashboard/.live-stack/site.json` (API URL, schema,
dev password, backend path), first sets **Sunday closed** through `PUT /api/v1/settings/hours` as a seeded user with
`set.hours` when the design seed left it open (the owner's decision; production Settings are set by the owner), signs
in as a seeded manager through `POST /api/v1/auth/login` to read `GET /api/v1/ops/snapshot`, and reads the stack's
database through `psql` (the backend's `DATABASE_URL`, the stack's schema) for what the API does not expose: the
one-time code (the `sms_outbox` row while it is unredacted; otherwise the code is recovered from the challenge's
`sha256(id:code)` by searching the six digits, because the simulator delivers instantly and delivered one-time codes
are redacted) and the pending membership row.

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
   membership gets guest prices ("guest price", no "1 of 4 this month").
5. `#/join?gold` → vehicles → details (Continue without the e-mail is refused on that step: "Add your email for the
   receipts.") → the checkout step has no card field → terms → Start Gold → 201 `pending_payment`,
   `next: checkout_link_by_sms`; a pending membership row exists for the number.
6. The honeypot (`website` non-empty) answers 202 with a fake reference and creates nothing.
   Catalog (DV-CATALOG, fixture only; the live build bakes the API's catalog as `SITE_CATALOG_JSON`): with the fixture's
   catalog changed (Signature Hand Wash at $50 for members, Gold at $109) `#/wash` shows "SAVE $60" after the page's
   catalog load and `#/membership` shows $109. Over `dist-e2e-catalog` (snapshot: Signature Hand Wash at $52, "SAVE
   $62") with the catalog request held, `#/wash` first shows the snapshot; released, production's unseeded catalog
   brings the design's services and prices back ("SAVE $54", no "SAVE $62", Hand wax, Interior deep clean) and none of
   the dashboard's own services.
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
9. Over every page: no console error or page error, no request to another origin, no 5xx.
10-21. Personal links (`scripts/e2e-links.ts`, fixture mode; skipped on a stack until the backend's link API (W3c) is
   in it: the stack has no `/public/links` routes and no way to issue a link). The fixture answers the backend's own
   shapes (backend `docs/api-spec.md` section 28), held to them by `tools/site/fixture-links.test.ts` with the key lists
   of `src/site/link-contract.testkit.ts`, so these checks exercise the real contract. They run on the launch build (`SITE_BOOKING=sms`; links do not depend on the booking mode), every page with the
   production Content-Security-Policy (the kit's `SITE_CSP` minus `upgrade-insecure-requests`, the test host is plain
   http) injected on the document, links issued in the fixture (`api.links.issue`, the URL a text would carry):
   **10** the token is sent only in the body of `POST /links/exchange` (every browser request recorded: URL, headers,
   body; the fixture's request log and the site host's paths never carry it; over the whole run, every link);
   **11** scrubbed: no token in `location`, the DOM, storage, cookies or the title once hydrated, the history entry was
   replaced (go to `#/visit` and back: the scrubbed `/`), a reload does not reopen the link (memory only);
   **12** trust window: a trusted number books at once (no `/verify/*` call, booking recorded, the board from
   `/links/availability` with the session); an untrusted number is asked to confirm before anything is booked, books
   after the code, and a new link for that number then books without a code;
   **13** verify: the code request carries no phone, a verify link ends on "You're verified … until <date>", a PIN can be
   created after it ("1234" refused with the reason);
   **14** PIN lockout: five wrong PINs show "Too many wrong PINs. Try again in 15 min…", the PIN field goes, the reset
   stays;
   **15** membership: `#/join?gold` (token scrubbed), code, e-mail, terms → the plan's Squarespace checkout, a pending
   membership and a checkout intent with the confirmed e-mail;
   **16** payment: the review shows the invoice (number, date, items, tax) and the balance, PIN → the invoice's Squarespace link; an invoice URL
   off the allowlist is not followed ("We couldn't open the payment page", a text-us link);
   **17** dead links: expired, used, revoked and unknown tokens show their notice and the text-us link;
   **18** a link preview (a plain GET of the link URL) gets the static page and reaches no API; opening twice uses
   nothing (2 exchanges, 0 uses); a booking uses it once;
   **19** no CSP violation on any link page;
   **20** a second link in the same tab (`location.hash = '#/c/<B>'`) is exchanged and scrubbed and the page then uses
   its session;
   **21** links switched off (the fixture's gate, 404): the home page as today (no sheet, no toast, the token scrubbed).
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

