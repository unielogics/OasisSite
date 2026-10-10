# End-to-end: the site against the public booking API

`scripts/e2e-site.ts` drives the built site in pinned Chromium against a public booking API, through
`tools/site/proxy.ts` (the site's host as nginx runs it: `dist/` with clean URLs, `404.html`, immutable `/assets`,
and the whole `/api/v1/public/*` prefix proxied to the API with cookies stripped).

```bash
pnpm e2e:site --api fixture            # tools/site/fixture-api.ts in-process (no backend needed)
pnpm e2e:site --stack site             # the dashboard's live stack named "site"
```

Two builds are made per run (`dist-e2e-live`: `SITE_BOOKING=live` with the API's hours and availability baked in;
`dist-e2e-sms`: the launch default) and served on `--port` (3301) and `--port`+1. `--skip-build` reuses them.
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
   month" → a time → Confirm booking → 201 with `deposit.dueCents = 0` and `member: true`.
5. `#/join?gold` → vehicles → details → the checkout step has no card field → terms → Start Gold → 201
   `pending_payment`, `next: checkout_link_by_sms`; a pending membership row exists for the number.
6. The honeypot (`website` non-empty) answers 202 with a fake reference and creates nothing.
7. SMS mode: Book composes `sms:+12015986304?&body=WASH booking: …` (wash, vehicle, time), Join composes
   `JOIN VIP: name · phone · car`, the design's own text links keep the configured number, and no POST reaches the API.
8. Over every page: no console error or page error, no request to another origin, no 5xx.
