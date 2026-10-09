# Oasis Auto Spa — public website

The marketing site at https://oasisautospanj.com, built from the owner's Claude Design prototype ("Oasis Site v2",
a `.dc.html` bundle) with the same fidelity rule as the dashboard: the design is followed pixel for pixel, every
deviation is listed in `design-patches/DEVIATIONS.md` and owner-approved, and a parity harness proves zero
difference between the original bundle and `dist/` (DOM, computed style and rects, pixels at threshold 0,
`renderVals`, console).

Until the real design is readable the pipeline runs on the dashboard's three bundles as fixtures
(`design/fixtures/`), which is what `design/pages.json` points at today.

## Pipeline

```
design/<page bundle>.dc.html ─► tools/intake/unpack.ts ─► design/extracted/<slug>/{head.html,template.html,logic.original.js,
                                                           meta.json,imports.json,helmet.N.css}, extracted/{fonts,assets,imports,runtime}
                                 tools/intake/inventory.ts ─► docs/intake-report.md
                                 tools/intake/probe-original.ts ─► design/extracted/<slug>/probe.json (ground truth from Chromium)
design/extracted + design-patches ─► tools/dc-compile ─► .generated/<slug>.tsx, <slug>.logic.js (ES module), <slug>.page.css, bindings
.generated ─► tools/prerender/build.ts ─► dist/ (static HTML, hashed assets, hydration bundles only where needed)
dist/ vs design bundle ─► tools/parity (pnpm parity:all) ─► parity-reports/
```

See `docs/intake.md`, `docs/compiler.md`, `docs/parity.md` and `docs/deploy-contract.md`.

## Build contract (what the deploy kit relies on)

`pnpm install --frozen-lockfile && pnpm build` on Node 22 with pnpm 10.34.6 writes `dist/`:

- `dist/index.html` exists and contains the marker text **`Oasis Auto Spa`** (`site.config.json` → `marker`).
- `dist/<route>/index.html` for every other route in `design/pages.json`; `dist/404.html`; `dist/robots.txt`;
  `dist/sitemap.xml`; `dist/manifest.json` (every emitted file with its sha256, the hydrated pages, the theme script hash).
- Every other file is a content-hashed asset under **`dist/assets/<name>.<hash>.<ext>`** (CSS, fonts, images, JS).
  Nothing else is emitted at the top level, so `/assets/` can be cached as immutable and HTML as `no-cache`.
- **No inline `<script>` with executable content.** The only inline `<script>` elements are data blocks
  (`type="application/ld+json"` for the LocalBusiness JSON-LD, and in the parity variant `type="application/json"`),
  which a `script-src 'self'` CSP does not execute. All JavaScript is loaded from `/assets/*.js`.
- No React on pages without handlers or state; pages with interactivity get one esbuild IIFE bundle each.
- Environment read at build time:
  - `SITE_URL` (default `https://oasisautospanj.com`): canonical URLs, Open Graph, sitemap.
  - `SITE_HOURS_JSON`: the JSON body of `GET /api/v1/public/hours`, baked into the hours region. When it is unset or
    invalid the build uses the committed `src/data/hours.fallback.json` (Mon–Fri 8:00 AM–6:00 PM, Sat 8:00 AM–5:00 PM,
    Sunday closed) and prints a warning. The browser refreshes the region from the same endpoint (3 s timeout).
- `pnpm check:dist` verifies the output (internal links resolve, well-formed HTML, no executable inline scripts, no
  `localhost`, marker present, hashed assets only) and the deploy kit runs it after the build.

## Scripts

```bash
pnpm check              # assert:react, design:verify, eslint, tsc, vitest (intake, compiler, prerender, hours, parity utilities)
pnpm build              # dist/ (prod variant)            pnpm build:parity   # dist-parity/ (data-dc-tpl + parity hooks)
pnpm build:html         # HTML only (no asset hashing step; for a quick look)
pnpm check:dist         # output contract                 pnpm serve:dist     # static server on :3301 with a fixture hours endpoint
pnpm intake             # unpack design/pages.json        pnpm intake:inventory / pnpm intake:probe
pnpm dc:compile         # .generated/ (prod)              pnpm dc:check       # recompile in memory and compare with .generated
pnpm parity --page settings --scenario initial           pnpm parity:all     # every scenario, both themes
pnpm parity:selftest    # determinism + sensitivity gates  pnpm parity:phone  # 390x844 and 768x1024 smoke
pnpm design:verify      # design/ matches CHECKSUMS.sha256  pnpm design:checksums  # regenerate after an intake
```

Environment for the heavy scripts on the shared host: `NODE_OPTIONS=--max-old-space-size=2048`,
`PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-arm64` (set by the harness itself on arm64 Linux).

## Layout

```
design/          original bundles + loose files (design/original), fixtures, pages.json, extracted/ (intake output), CHECKSUMS
design-patches/  href-map.json, copy-map.json, <slug>.patch.json, DEVIATIONS.md
site.config.json seo.json           site-wide facts and per-page SEO slots
src/dc/          the dc runtime port (DCLogic, DCHost, text/list/style helpers, pseudo classes, x-import resolution)
src/client/      hours.ts (live hours), theme.ts (pre-hydration theme patch), the per-page hydration entries
src/data/        hours.fallback.json
tools/intake/    unpack, inventory, probe-original
tools/dc-compile/ the template compiler (+ goldens and the reference interpreter in tests/)
tools/prerender/ render, shims, head, seo, build, check-dist helpers
tools/parity/    the harness: serve-original, serve-dist, drivers, the five diffs, selftest, phone smoke, scenarios
parity/          allowlist.json, tolerances.json, console-baseline.json, fonts/ + fontconfig/ (pinned fallback fonts)
```
