# Oasis Auto Spa — public website

The marketing site at https://oasisautospanj.com, built from the owner's Claude Design prototype **"Oasis Site v2"**
(`design/original/Oasis Site v2.dc.html`, a raw design document with its loose files) with the same fidelity rule as the
dashboard: the design is followed pixel for pixel, every deviation is listed in `design-patches/DEVIATIONS.md` with a
DV id (the owner's decisions of 2026-10-10: live hours with Sunday closed, real availability and booking with an SMS
fallback, no card capture, placeholder photos, self-hosted fonts, the theme following the visitor's device, a separate
texting number), and a parity harness proves zero difference between
the original and `dist/` (DOM, computed style and rects, pixels at threshold 0, `renderVals`, console) at 390x844 and
1440x900 in both themes, with the owner's decisions applied to the original as text swaps.

## Pipeline

```
design/original/Oasis Site v2.dc.html + loose/ ─► tools/intake (unpack.ts, raw.ts, fonts.ts) ─► design/extracted/index/{head.html,
                                                   template.html, logic.original.js, helmet.0.css, helmet.fonts.0.css, meta.json, …},
                                                   extracted/{fonts,scripts,runtime}, design/fonts (vendored Google Fonts), design/probe
design/extracted + design-patches ─► tools/dc-compile ─► .generated/<variant>/index.tsx, index.logic.js (design logic + src/site/index.bridge.ts),
                                                          index.page.css, site-env.js (SITE_* env, hours and availability snapshots)
.generated ─► tools/prerender/build.ts ─► dist/ (prerendered home view, one hydration bundle, hashed assets, 404, robots, sitemap)
dist-parity vs the original ─► tools/parity (pnpm parity:all) ─► parity-reports/     dist vs an API ─► scripts/e2e-site.ts
```

See `docs/intake.md`, `docs/compiler.md`, `docs/site.md` (the bridge: hours, availability, booking modes), `docs/parity.md`,
`docs/e2e.md` and `docs/deploy-contract.md`.

## Build contract (what the deploy kit relies on)

`pnpm install --frozen-lockfile && pnpm build` on Node 22 with pnpm 10.34.6 writes `dist/`:

- `dist/index.html` exists and contains the marker text **`Oasis Auto Spa`** (`site.config.json` → `marker`); the hash
  routes (`#/membership`, `#/wash`, `#/tint`, `#/detailing`, `#/experience`, `#/visit`, `#/join`) are client-side views
  of the same document. `dist/404.html` (in the design's tokens), `dist/robots.txt`, `dist/sitemap.xml` (`/` only),
  `dist/manifest.json` (every file with its sha256, the build instant, the booking mode, the placeholder assets).
- Every other file is a content-hashed asset under **`dist/assets/<name>.<hash>.<ext>`** (CSS, 13 self-hosted woff2 files,
  the logo and icons, one JS bundle). `/assets/` can be cached as immutable, HTML as `no-cache`.
- **No inline `<script>` with executable content** (the only inline script is the LocalBusiness JSON-LD data block; the
  theme script, DV-THEME, is the external `/assets/theme.<hash>.js`, a parser-blocking script in `<head>` before the
  stylesheet, on the home page and the 404 page; `pnpm check:dist` enforces the placement);
  **no external request** of any kind (fonts, scripts and images are all under `/assets/`).
- Environment read at build time: `SITE_URL`, `SITE_HOURS_JSON` (fallback: `src/data/hours.fallback.json`, Sunday
  closed), `SITE_AVAILABILITY_JSON`, `SITE_CATALOG_JSON` (DV-CATALOG), `SITE_BOOKING` (`sms` default | `live`), `SITE_API_ORIGIN` (default same origin),
  `SITE_BUILD_NOW` — see `docs/deploy-contract.md`.
- `pnpm check:dist` verifies the output and the deploy kit runs it after the build.

## Scripts

```bash
pnpm check              # assert:react, design:verify, eslint, tsc, vitest
pnpm build              # dist/ (prod)                    pnpm build:parity   # dist-parity/ at the harness's frozen instant
pnpm check:dist         # output contract                 pnpm serve:dist     # static server on :3301 with fixture hours/availability
pnpm intake:fonts       # once per design: vendor the helmet's Google Fonts (the only network step)
pnpm intake             # design/pages.json -> design/extracted   pnpm intake:inventory / pnpm intake:probe / pnpm design:checksums
pnpm parity --page index --scenario sheet-guest          pnpm parity:all     # every scenario, both themes, both viewports (the gate)
pnpm parity:selftest    # determinism + sensitivity gates  pnpm parity:phone  # dist at 390x844 and 768x1024
pnpm e2e:site --api fixture | --stack site               # the booking flows against the fixture API or a live stack (docs/e2e.md)
pnpm e2e:theme-paint                                     # every painted frame with theme.js held back 1 s: no dark frame on a light device
```

Environment for the heavy scripts on the shared host: `NODE_OPTIONS=--max-old-space-size=2048`,
`PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-arm64` (set by the harness itself on arm64 Linux). Ports: static server
3301, e2e sms host 3302, fixture API 3303, theme-paint host 3305 and its fixture API 3306, original server 4320.

## Owner inputs still open

- `assets/oasis-logo.png` (DV-LOGO): drop it in `design/original/loose/assets/`, run `pnpm intake && pnpm design:checksums`.
- Photos for the five `<image-slot>`s (DV-IMG): a `src` on the slot renders the photo in the same frame.
- Contact corrections (DV-CONTACT): `site.config.json` `contact` (`smsE164`/`smsDisplay` = the number people text,
  `phoneE164`/`phoneDisplay` = the number people call) and `business` (the JSON-LD telephone).
- `SITE_BOOKING=live` in the deploy once the SMS tablet is live (until then Book/Join open the design's sms: texts).

## Layout

```
design/          the original document + loose files (design/original), design/fonts, design/probe, fixtures, pages.json, extracted/, CHECKSUMS
design-patches/  index.patch.json, copy-map.json (incl. toConfig contact entries), href-map.json, DEVIATIONS.md
site.config.json seo.json           site facts (contact, catalog keys, booking endpoints, parity viewports) and the page's SEO
src/dc/          the dc runtime port (DCLogic, DCHost, text/list/style helpers, image-slot placeholder, x-import resolution)
src/site/        env.ts, hours.ts, availability.ts, index.bridge.ts (the site layer over the design's logic)
src/client/      boot.tsx (hydration + the build-instant freeze), hours/theme helpers for designs without a bridge
tools/intake/    unpack, raw, fonts, inventory, probe-original
tools/dc-compile/ the template compiler (+ goldens and the reference interpreter in tests/)
tools/prerender/ render, shims, head, seo, site-env, placeholder, build, check-dist helpers
tools/parity/    the harness: serve-original (raw + bundles), cdn intercepts, serve-dist, drivers, diffs, selftest, phone, scenarios/site.ts
tools/site/      fixture-api.ts (the public API contract in memory), proxy.ts (the nginx host for the e2e)
scripts/         e2e-site.ts, check-dist.ts, assert-react.mjs, verify-design.mjs
parity/          allowlist.json, tolerances.json, console-baseline.json, fonts/ + fontconfig/ (pinned fallback fonts)
```
