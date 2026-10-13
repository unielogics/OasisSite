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
- **DV-CATALOG** (only with `site.config.json` `"pricing": "catalog"`; the default interim prices, DV-PRICE-INTERIM,
  never apply the catalog's content) The services, add-ons, tint table, detailing, quote-only items, plan prices and perks and the guest
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
  side & rear windows", the film words in "Carbon and ceramic film", the VLT options and film descriptions. Every item
  shows its own guest price, also on the booking sheet, where the design's logic asks `g(member)` (the bridge writes the
  wash and add-on prices, the review and summary lines, "Pay $X after your wash" and the guest upsell from each item, so
  two items with one member price and different guest prices never share one); `g()` itself answers only for the
  design's fallback values that have no catalog item behind them: the catalog's markup, rounded half up. When a new
  catalog drops a vehicle type the visitor had picked (tint page or booking sheet), the choice moves to the list's first
  type, as a dropped add-on leaves the picks.
  Harness: no swap; `pnpm build:parity` bakes and `serve-dist` answers the design's content in the backend's shape
  (`tools/site/catalog-fixture.ts` `designCatalog()`), so the catalog-driven page must equal the original at zero diff.

- **DV-PRICE-INTERIM** Interim website prices (owner, 2026-10-12, plan decision 9): prices depend on the vehicle size,
  a single wash starts at **$40** and membership at **$129/month**; the real per-size catalog (public catalog v2) comes
  later. Until the site switches to it, `site.config.json` `"pricing": "interim"` (the default; `SITE_PRICING` overrides
  it for a build) shows ONLY the Signature Hand Wash "from $40", Gold "from $129" and the booking fee; every other
  price reads "Priced by vehicle size — ask us", or "Ask us" where the design's slot only fits a price, in the design's
  own typography and components. Every statement of the old price model goes (guests' "prices 20% higher", member vs
  guest pairs, "SAVE $N", the Gold savings calculator, "A VIP month, priced as a guest", the tint savings, the $0
  statements); no new figure and no new perk. Unchanged: the booking fee wording and amount (the catalog's
  `guestBookingFeeCents`, a Settings value, when it has a whole-dollar one, else the design's $25; the build bakes it
  and the browser's catalog load applies it, wherever the page says "$25"), the perks bullets, hours, the
  booking and join flows, links, theme. In interim mode the live catalog (DV-CATALOG v1, the old member/guest model) is
  never applied to the page's content (neither the build snapshot nor the browser's load; its keys still name the
  booked wash and add-ons, and its fee is the fee); `"pricing": "catalog"` brings DV-CATALOG back unchanged. The port writes the interim words
  in the bridge (`src/site/index.bridge.ts` DV-PRICE-INTERIM section over the design's view models, `site.cat` from
  `src/site/catalog.ts` `interimTexts` for the template's texts: the 18 DV-CATALOG ops plus 12 new ops, one of them a
  `set-attr` that appends `display:{{ site.cat.calcDisplay }}` to the calculator box).
  Surfaces (route / element: before → after):
  - home hero / "Become a member" button: "from $99" → "from $129".
  - home 01 Membership / the Gold savings calculator ("How often do you wash?", "AS A GUEST $216 · 4 × ($54 wash + $25
    fee)", "GOLD MEMBER $99", "Save $117/mo"): shown → hidden (`display:none`; its numbers emptied, the hidden Gold
    figure reads $129).
  - home 01 / Gold card: "$99 / month" → "$129 / month and up" (the 56px slot cannot hold "from $129" next to "/ month"
    on a phone).
  - home 01 / VIP card: "$169 / month" → "Ask us" (the "/ month" line is empty: with any sub-line "Ask us" breaks over
    two lines on a phone).
  - home 01 / guest line: "Guests can book with prices 20% higher and a $25 non-refundable booking fee." → "Guests can
    book with a $25 non-refundable booking fee."
  - home, #/wash, #/tint, #/detailing / pricing intro: "Everyone sees guest pricing. Here's what the same visit costs as a
    VIP member." → "Priced by vehicle size — ask us, and we'll reply with a quote."
  - pricing / booking fee row: "$25 GUEST | $0 SAVE $25" → "$25 GUEST | None MEMBERS".
  - pricing / price rows (wash, add-ons, tint, detailing; GUEST and AS VIP columns, the flip): "$54 / $54 GUEST /
    Included SAVE $54", "$47 / $39 SAVE $8", "from $275 …" → Signature Hand Wash "from $40 / $40 GUEST / Included WITH
    VIP"; every other row "Ask us / Ask us GUEST / Ask us PRICED BY SIZE" (an item the design includes with VIP keeps
    "Included" with "WITH VIP"); the tint page rows' "VIP $229–$279 · guest $275–$335" → "Priced by vehicle size — ask
    us"; "More services" unchanged.
  - home, #/wash / "A VIP MONTH, PRICED AS A GUEST" (what VIP is worth, "Guest total $458 · VIP $169", "Save $289/mo"):
    shown → not shown (`prShowMonth` false, its numbers emptied).
  - FAQ / the guest fee answer: "…to hold a time, on top of guest pricing. Members never pay it." → "…to hold a time.
    Members never pay it."
  - #/membership / comparison header: "Gold $99/mo", "VIP $169/mo" → "from $129/mo", "Ask us"; row "Booking fee $25 /
    $0 / $0" → "$25 / None / None".
  - #/wash / wash cards: "Guest $54", "Guest $38" → "from $40", "Priced by vehicle size — ask us".
  - #/tint / tint card on the home page: "Carbon and ceramic film. VIP from $229, guest from $275." → "Carbon and
    ceramic film. Priced by vehicle size — ask us."
  - #/tint / tint calculator price block: "VIP · CERAMIC · SEDAN / COUPE / $379 – $449 / Guest ~~$455 – $539~~ · save
    $76+" → "CERAMIC · SEDAN / COUPE / Ask us / Priced by vehicle size".
  - home / VIP section: "VIP members book first and pay $0 for their washes. …", "Join VIP · $169/mo" → "VIP members
    book first. Guests can book any open time.", "Join VIP".
  - sticky bar: "VIP · $169/mo", "Priority times · Gold from $99" → "VIP · Ask us", "Priority times · Gold from
    $129" (the design's format; "/mo" would end in an ellipsis on a phone).
  - #/join / plan cards: "$99/mo", "$169/mo" → "from $129/mo", "Ask us" (the "/mo" span binds each plan's own suffix,
    `t.per`: Gold "/mo", VIP none, so "Ask us" carries no "/mo"); summary "Gold membership $99/mo", "Booking fees
    $0", "Due at checkout $99" → "from $129/mo" (VIP "Ask us"), "None", "from $129" (VIP "Ask us"); terms "I agree to be
    billed $99 a month for Gold until I cancel. …" → "I agree to be billed monthly for Gold until I cancel. …"; button
    "Start Gold · $99/mo" → "Start Gold".
  - booking sheet / who step: "This wash is included. Gold $99 or VIP $169 a month.", "Guest prices · $25 non-refundable
    booking fee" → "This wash is included. Gold from $129 a month.", "Priced by vehicle size · $25 non-refundable booking
    fee".
  - booking sheet / wash step: guest "$54 guest price", "$38 guest price", add-ons "+$47" → "from $40 by vehicle size",
    "Ask us by vehicle size", "Ask us"; member "$0" → "Included" (add-ons the member pays: "Ask us").
  - booking sheet / review and summary: wash "$54", add-ons "$47", "Pay $101 after your wash.", member "Due at pickup
    $35", "AS A VIP THIS VISIT IS $0 · You'd pay $126 as a guest. As VIP: $0, with wax and engine bay included." →
    "from $40" (Exterior "Ask us"), "Ask us", "Pay the rest after your wash.", "Ask us", "AS A VIP MEMBER · No booking
    fee, with wax and engine bay included."; the $25 fee lines unchanged.
  - head (seo.json description, JSON-LD): no price figure before or after (`priceRange` "$$" is not a figure).
  Harness: the ORIGINAL gets the same words as pre-render swaps (`parity/allowlist.json` `DV-PRICE-INTERIM-*`, 23 on the
  markup, 32 on the logic; original only, because the port's switch is the bridge's, not a copy-map change), so the port
  must match it at zero diff. `src/site/bridge-interim.test.ts` renders the design with those swaps under the bridge in
  catalog mode against the interim bridge over every price state, value for value, and checks every `site.cat` text
  against the swapped markup; the build and the e2e scan the prerendered page and every view for "$" figures other than
  $40, $129 and the fee.

- **DV-CATALOG2** Prices by vehicle size (owner, 2026-10-12, plan decisions 1-3; backend ADR 0170, api-spec 26.1;
  design q-design-pricing.md section 9), only with `site.config.json` `"pricing": "live"` (the default stays
  `"interim"`, DV-PRICE-INTERIM, until the owner has filled the size grid). The content comes from `GET
  /api/v1/public/catalog/v2`, prerendered from `SITE_CATALOG_JSON` (the v2 body) and applied again from the browser's
  load after mount (`src/site/catalog2.ts`, the bridge's DV-CATALOG2 section). **Nothing is trusted**: every field is
  checked, a malformed item, price row, size or tier is dropped, the starting prices are worked out again from the rows
  that passed. **Website-ready**: at least one size, at least one of the design's washes with a description, a duration
  and a whole-dollar price, at least one of the design's tiers (Gold, VIP) sold online with whole-dollar prices and
  perks, a whole-dollar booking fee; anything less shows the interim prices (DV-PRICE-INTERIM), as does every section
  the catalog does not price (add-ons, tint, detailing, a tier it does not sell): **never the design's old figures**
  (plan decision 9), which is where this entry departs from design section 9 ("falls back to the design's own content").
  What changes with a ready catalog:
  - **Sizes**: the catalog's sizes (`vehicleClasses`) replace the design's three vehicle types as the booking sheet's
    vehicle chips; the tint page lists the sizes priced for both films (its own list).
  - **Price rows**: "from $X" (the lowest price over the sizes) unless the item has one price for every size (then the
    design's "$X"); the AS VIP column is the catalog's member price (`memberCents`; "SAME PRICE" when members pay the
    price); an item a tier includes reads "Included" (VIP's inclusions give the add-ons their "included with VIP" /
    "2× / mo with VIP" words). A new **per-size block** under a row's description lists the priced sizes ("Compact car
    $40 · members $36", "Other sizes: priced at the shop") only when more than one size is priced at different prices;
    a size without a price is never shown as $0.
  - **Booking sheet**: priced for the chosen size; a size the item has no price for reads "At the shop" ("by vehicle
    size"); a member's included wash reads the design's "$0 · 1 of 4 this month" (the tier's own count), and a verified
    member whose plan size is known sees "Included · +$N size difference at the shop" (no % off on the difference,
    plan decision 2; the cents difference rounded half up once) with a "Size difference · at the shop" review line;
    when the site cannot know the difference (no price at the chosen size, or an unknown plan size on a car above the
    starting price) the wash reads "Included · size difference, if any, at the shop", the review line "if any" and
    what is due "At the shop", never "$0"; add-ons a member's tier includes are covered up to their plan-size price like
    the wash (review Q4 F4): "Included" on the plan's size, "Included +$N at the shop" on a larger car (counted in what
    is due), "Included · size difference, if any, at the shop" when the site cannot know it; others the member price at
    the size at the member's own tier's % off; the review's due amounts follow. The guest upsell's "As VIP: $X" counts
    the wash too (nothing when VIP includes it at the car's size, else the size difference from the best size VIP is
    sold at, or VIP's member price when VIP does not include it), the size difference of the add-ons VIP includes, and
    the add-ons VIP does not include, at VIP's % off;
    anything unpriced keeps the interim words. The request sends `vehicleClass` (the size key) and no made-up
    `vehicle.label`.
  - **Join flow**: the plan cards are the design's tiers the catalog sells ("from $129" when the price depends on the
    size); a **size picker** (the design's chips, "VEHICLE SIZE", only when the tier is sold at more than one size)
    sets the monthly price of the summary, the terms and the button; the request sends `planClass`; the sms text names
    the size.
  - **Gold savings calculator** and **What VIP is worth**: the design's formulas and labels at the catalog's prices
    (the Signature wash's starting price, the fee, Gold's and VIP's starting prices, the add-ons VIP includes); a figure
    the catalog cannot give hides the block.
  - The template's static price texts (`site.cat`) are the design's words with the catalog's numbers (`liveTexts`),
    "Guests can book with prices N% higher" from the members' % off (no statement at 0%).
  Harness: with `tools/site/catalog-fixture.ts` `designCatalogV2()` (the design's own numbers: one price for every
  size, member = the design's member price, Gold $99 and VIP $169 at one size) every view model value equals the
  design's (`src/site/bridge-live.test.ts`) and the two new blocks are `sc-if`s that are false; `pnpm parity:all` runs
  the default interim mode unchanged.

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
  and explains that a secure link to pay is texted (a Squarespace checkout, or with Square a membership page: neutral words
  since wave Q3); the card number, expiry and CVC inputs are removed
  (the original gets the same removal before render, plus its card validation line), the summary reads "Due at
  checkout" (was "Due today") and the member card loses the fake "•••• 0427". Submit = `POST
  /api/v1/public/memberships` (pending until the checkout is paid; live mode requires the receipts e-mail on the details
  step, as the API does, and a field the API refuses sends the visitor back there); the welcome step reads "…your
  secure link to pay is on its way by text. Your 4 washes start the moment it's paid." In sms mode the submit
  composes "JOIN VIP: name · phone · cars" as a text. "Book your first wash" (live) opens the sheet at the member sign-in
  with the phone prefilled (no member pricing while the membership is pending).

## Personal links (owner decisions of 2026-10-10; backend design ai-assistant-and-phone-identity.md sections 5 and 7)

Everything below happens only when the page is opened from a personal link the shop texted
(`https://oasisautospanj.com/#/c|m|p|pin|v|k/<token>`) AND the link API answers (`PUBLIC_LINKS_ENABLED` on the API). Without
a link fragment, or when the API answers 404 (links switched off, the default), the site renders and behaves exactly as
the entries above say: the new blocks are `sc-if`s that render nothing, and the parity runs stay at zero. The linked
states have no counterpart in the design, so they are not in the parity harness: they are pinned by port goldens
(`src/site/__goldens__/link-*.html`, rendered from the patched template with the bridge's own view model), a style-token
test (every declaration of the new blocks is one the design itself uses) and the e2e (docs/e2e.md checks 10-21).

- **DV-LINK** The token rides in the URL fragment (never sent to a server, never in a Referer or a link preview).
  `src/client/link.ts` takes it out of the address bar and the history entry (`history.replaceState`, same document)
  while the bundle is evaluated, before hydration, keeps it in memory only and hands it to the bridge, which sends it
  in one place: the JSON body of `POST /api/v1/public/links/exchange`. The answer is a bearer session (memory only;
  `Authorization: Bearer` on every later call; a session that timed out is exchanged again once with the token still
  in memory). A second link opened in the same tab (a fragment navigation, no reload) is captured by a `hashchange`
  listener that runs before the design's, scrubbed the same way and replaces the first link (its session is dropped).
  A **calendar** or **book again** link opens the design's booking sheet at "Choose your wash" in linked mode: the
  eyebrow reads "BOOKING FOR MARIA ••51 · STEP 1 OF 3" (first name and the last two digits of the number the link was
  texted to; "••51" alone for a stranger, who is then asked a full name on the review step, and for a record the API
  hides until verified, which confirms first and is asked a name only if the API still has none), the who / phone / code steps
  are skipped (the wash step has no back button), an active member's tier comes from the link (member prices, no fee),
  the board (home and sheet) is the client's own (`GET /links/availability`, never cached, VIP-aware once verified),
  every Book button of the page books for that client while the link is open, and "Book" posts
  `POST /links/bookings` (Idempotency-Key per body) instead of the public booking or the sms: text, in both booking
  modes. A number that is not trusted yet confirms first (the step-up block, DV-STEPUP) and the booking then goes on by
  itself; a trusted number (verified in the last 30 days) books without it. On the link sheet the booking summary column
  is hidden (`wrap-if site.sheetSummary` around the design's right column; true everywhere else).
- **DV-STEPUP** "Confirm it's you": a design-styled card (the member sign-in card's frame, input and button, the code
  step's error line and link button, the done step's note) with three modes: the client's **PIN** (4-6 digits; a PIN
  outranks a code once set: the API's `stepUp.method` says which to show first), a **texted code** ("Text me a code" sends a 6-digit code to the link's number only, then the
  code field), and **create / reset a PIN** (after a code). Wrong entries show the API's own words ("That PIN didn't
  match. 3 more tries on this page."); a locked PIN shows the lockout text ("Too many wrong PINs. Try again in 15 min, or
  reset your PIN with a texted code.") and only the reset; five wrong tries end the page (DV-LINK-DEAD "Too many
  tries"). A verify link shows it at once and ends on "You're verified" (until when the number is trusted, plus an
  optional "Create a PIN for next time" while the API keeps a window open for it, never on a stranger's link); a PIN link sets or resets the PIN ("Your PIN is
  set"). The note under the card says the PIN or code is only ever asked on this page, never by text.
- **DV-LINK-JOIN** A **membership** link opens the design's join steps for the link's plan (its tier, Gold or VIP; a
  plan the website does not show opens no join page but a "Let's finish this by text" note): plan (the other plan says
  "This link is for Gold. Text us to switch plans.") → **verify** (the step-up card in the join column, "STEP 2 OF 4 ·
  CONFIRM IT'S YOU"; a PIN or code from the last 5 minutes is required for every membership) → **e-mail** ("STEP 3 OF
  4 · EMAIL": a "Joining as MARIA ••51" line and the design's e-mail field; the name and phone fields are not shown, the
  link already knows them) → the design's terms step ("Continue to checkout") → `POST /links/membership/start {email}`
  and a redirect to the plan's Squarespace checkout. The vehicles step is skipped (the request carries the e-mail only).
  **Billed by Square** (the API's `plan.billing` is `square`; backend ADR 0171 D8, wave Q3b): plan with a **size picker**
  (the design's chips under the plan card, only when the plan is sold at more than one size; a size not set up at Square
  reads "ask us" and cannot be picked; the plan card, the summary, the terms and the button carry the chosen size's
  monthly price) → verify → e-mail ("Square emails your receipts there every month") → a fresh PIN or code is required
  before the card step → **card step** ("STEP 4 OF 4 · CARD": a design-styled card block above the design's terms box with
  Square's card form, DV-LINK-CARD, and the consent box, unchecked, with the API's wording for the membership's monthly
  payment) → `POST /links/membership/subscribe {email, planClass, sourceId, verificationToken?, consentVersion}` → the
  page waits ("Setting up your membership with Square…") asking `GET /links/membership/status` every 2 seconds for up
  to 2 minutes: `active` opens the design's welcome step ("Your Gold membership is active. Square emails your receipts
  every month."), `failed` shows "Square couldn't take the first payment…" on the card step, a longer wait ends on "Almost
  there … We'll text you as soon as your membership is active." A refused e-mail goes back to the e-mail step, a size no
  longer open online to the plan step. Billed by Squarespace (the default): the flow above, unchanged.
- **DV-LINK-PAY** A **payment** link opens the link sheet with a review block (the design's review card: the invoice
  number, the visit's date, its items with tax and tip, what was already paid, "Balance due" and the amount) and the design's CTA "Verify & pay $54" → the
  step-up card (fresh PIN or code, every time) → `POST /links/pay/start` → a redirect to the invoice's payment link.
  "We'll text you a link" when the invoice has no payment link yet; "Nothing to pay" when it is paid. An invoice the
  API hides until the page is verified (the stale-record rule) shows after the step-up.
  **Redirect allowlist** (DV-LINK-JOIN too): the page follows only `https://` URLs on `site.config.json`
  `links.redirectHosts` (squarespace.com and its subdomains), whatever the API answered; anything else shows "We
  couldn't open the payment page. Text us at 862-388-5827 …" and navigates nowhere.
  **Square** (ADR 0171 D3, wave Q2b): the review reads "You'll pay on a secure checkout page." and the redirect
  "Taking you to Square's secure checkout to pay." (or Squarespace's, by the URL's host); `links.redirectHosts` carries
  `=square.link` and `=checkout.square.site` beside `squarespace.com`: an entry written `=host` allows that host only
  (review Q4 SEC-3: never another seller's `*.square.site` store, never the sandbox's `sandbox.square.link`), a plain
  entry the host and its subdomains. **Deposit**: after a booking on a calendar link whose deposit
  the shop takes by link (the answer's `deposit.how` `link`), the done step has a button "Pay the $25 deposit now" (the
  design's secondary button) → `POST /links/deposit/start {bookingRef}` → Square's checkout (allowlist), "Your deposit is
  paid", "We'll text you a payment link shortly", or "There's no deposit to pay online for this visit. Pay at the
  counter." **`#/paid`**: Square's checkout sends the client back to `/#/paid` (the payment link's `redirect_url`); the
  page scrubs it and shows a notice "Thank you · Square is confirming your payment now. Your receipt comes by email or
  text." (a static view: the page does not know the payment).
- **DV-LINK-CARD** A **card** link (`#/k/<token>`, backend ADR 0171 D7 and D12, wave Q3a) opens the link sheet for saving a
  card with Square: a fresh PIN or code first (saving and removing need one), then "SAVED CARDS · MARIA ••51 / Your
  cards": the client's saved cards from the API (`cards`: "Visa ••4242 · Expires 12/28 · For a no-show fee and a balance
  you owe", each with Remove → `DELETE /links/cards/:id`), "No saved cards yet.", and an "Add a card" block (the step-up
  card's frame) with **Square's card form** and the **consent box, unchecked**, carrying the API's wording
  (`cardSetup.consent.text` with the purposes filled in: a no-show fee, a late-cancel fee and a balance, plus the
  membership's monthly payment for a member); the design's CTA "Save card" → Square's one-time token →
  `POST /links/cards {sourceId, verificationToken?, consentVersion, purposes}` (Idempotency-Key) → "Visa ••4242 is saved.
  You can remove it here any time." A declined card, the daily lock, an outdated wording (reloaded) and a missing
  step-up show the API's words. Without `cardSetup` (saved cards off: the default) the page says "Saving a card online
  isn't open yet. Text us…". **Square's Web Payments SDK** (`src/client/square.ts`) is loaded only on these two pages
  (the card page, a membership page billed by Square) and only when the card form shows: its URL, application id and
  location come from the API's `cardSetup.square` at runtime (nothing about Square is in the build); the URL must be
  https on `site.config.json` `links.squareSdkHosts` (Square's CDNs) or the page's own origin; the card form is
  Square's own iframe (the card number never reaches the page: PCI SAQ-A); `tokenize` is called with intent STORE,
  customer-initiated, the client's first name as the billing contact. The production CSP (the backend kit's
  `install.sh SITE_CSP`) lets Square's hosts through; this is the one external script the site loads, at runtime, on
  link pages only (README "Build contract", docs/deploy-contract.md).
- **DV-LINK-DEAD** A link the API refuses (`401 IDENTITY_LINK_INVALID` with `meta.reason`) opens the link sheet with
  "This link expired", "This link was used", "This link was replaced" or "This link doesn't work" (and "Too many tries"
  after five wrong entries), a plain line saying what to do, a "Text us for a new link" sms: link to the texting number
  (DV-CONTACT) and "Back to home". The same notice block carries the step-up's success notes ("You're verified", "Your
  PIN is set") with the done step's check mark.

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
