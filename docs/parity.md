# Parity harness

The design bundle is the source of truth. The harness renders the **original** bundle (served by `serve-original`
on port 4320, offline) and the **port** (`dist-parity/`, served by `serve-dist` with clean URLs and a fixture hours
endpoint) side by side in the same pinned Chromium, performs the same scenario actions on both, and fails on any
difference that is not explicitly listed in `parity/allowlist.json`. It is the dashboard's harness
(`OasisDashboard/tools/parity`, see its docs/parity.md for the rationale of every pin) vendored and keyed by
`design/pages.json` instead of the three dashboard screens.

- Code: `tools/parity/**`. Data: `parity/` (`fonts/`, `fontconfig/`, `allowlist.json`, `tolerances.json`,
  `console-baseline.json`). Output: `parity-reports/` (gitignored).

```bash
export PATH=$HOME/.local/bin:$PATH NODE_OPTIONS=--max-old-space-size=2048
pnpm build:parity                 # dist-parity/ with data-dc-tpl, the __oasisParity hook and PRERENDER_NOW pinned
pnpm parity --list                # the scenario catalogue (one `initial` per page at least)
pnpm parity --page settings --scenario sections --theme dark
pnpm parity:all                   # every scenario, both themes (the gate)
pnpm parity --scenario initial --against-original      # dry run: a second copy of the ORIGINAL stands in for the port
pnpm parity --hours alt           # the in-process server answers the hours endpoint with tools/parity/fixtures/hours.alt.json
pnpm parity:selftest [-- --quick] # determinism + sensitivity + swap + stale + port-driver gates
pnpm parity:phone                 # dist (prod) at 390x844 and 768x1024: no console errors, screenshots, scroll size
pnpm parity --update-console-baseline
```

`pnpm parity` serves `dist-parity/` itself on an ephemeral port (`--dist <dir>`, `--port-url` to use a running
server instead, for example the production host). Ports: serve-original 4320, `pnpm serve:dist` 3301. Run one heavy
process at a time on the shared box (`flock /tmp/oasis-heavy.lock`).

## The port contract

1. **Build and URL.** `pnpm build:parity` writes `dist-parity/`; every page is a full page load at its clean route
   (`/`, `/payments`, ... from `design/pages.json`), hashes allowed (`/#emergency`).
2. **Mount point.** `<div id="dc-root"><div class="sc-host" data-sc-name="..."> ...template DOM... </div></div>`,
   the same element structure as the original runtime produces, `span.sc-interp` wrappers and whitespace text
   nodes included. `data-sc-name` may differ; the DOM check strips it.
3. **Ready flag.** Hydrated pages set `data-oasis-ready="1"` on `#dc-root` after mount (`DCHost.componentDidMount`);
   static pages have it baked into the HTML. The harness waits for it, then for `document.fonts.ready`, every
   image's `complete`, and three event-loop turns.
4. **`window.__oasisParity.getVals()`** on hydrated pages returns `serializeVals({...userProps, ...renderVals()})`
   (`src/dc/serialize.ts` = `tools/parity/vals-serialize.ts`). Static pages carry the same JSON in
   `<script type="application/json" id="__oasis-vals">`. The driver reads the hook, else the block, else the React
   fiber (the original's path).
5. **`data-dc-tpl`** on every element, numbered like the original runtime (the parity compile emits it).
6. **Theme.** `localStorage["oasis-theme"]`, seeded by the harness before any page script; the theme script patches
   the baked default before hydration. `data-theme` stays on the wrapper div inside `#dc-root`.
7. **CSS.** One stylesheet per page with the runtime's sheets in the runtime's order (docs/compiler.md). `html` and
   `body` are part of the computed-style check.
8. **No timers to become ready.** The clock is frozen; hydration and re-renders happen from events.
9. **No network** except the two local origins; a blocked request is a console difference. The hours fetch goes to
   the in-process server's fixture endpoint.
10. **Fixture data.** The parity build pins `PRERENDER_NOW` to the harness's `FIXED_NOW`
    (`2026-06-13T10:36:00-04:00`, `America/New_York`) so anything the design bakes from `Date` matches.

## Environment and determinism

Identical to the dashboard: Chromium flags `--disable-dev-shm-usage --force-color-profile=srgb
--font-render-hinting=none --disable-lcd-text --disable-partial-raster`, deviceScaleFactor 1, `FONTCONFIG_FILE`
pointing at `parity/fontconfig/fonts.conf` with only the vendored fallback fonts (`parity/fonts`, checksums in
`MANIFEST.json`, verified by a unit test), `timezoneId America/New_York`, `locale en-US`, the clock installed and
paused at `FIXED_NOW` (time moves only through `runFor`), a fresh context per run and side, an injected
`animation:none` rule, the "Made with Claude Design" badge hidden on the original, the pointer parked at (0,0),
settling through `MessageChannel` round trips (not the fake clock). Viewport 1480x1000; screenshots are
**full page**, and the document scroll size is compared (a marketing page is taller than the viewport).

## The five checks

| Check     | What is compared                                                                                                                                                                                                            | Tolerance                     |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `dom`     | `#dc-root` outerHTML re-parsed and normalised: `data-sc-name` and `data-oasis-ready` dropped, `data-dc-tpl` kept when both sides have it, attributes sorted, **whitespace-only comments dropped** (see below)               | exact                         |
| `style`   | per element (paired by `data-dc-tpl` + occurrence, else DOM path): rect, scroll metrics, control value, `::before/::after/::placeholder`, ~90 curated properties (the full set at `initial`), plus the document scroll size | exact (0 px)                  |
| `pixels`  | full-page screenshots, pixelmatch threshold 0, antialiasing not forgiven                                                                                                                                                    | 0 px unless `tolerances.json` |
| `vals`    | ordered JSON diff of `serializeVals(renderVals())`, key order compared                                                                                                                                                      | exact, minus allow-list       |
| `console` | warnings, errors, page errors, dialogs and blocked requests as multisets, normalised; original messages outside `console-baseline.json` are `baseline-drift`                                                                | exact                         |

**Why whitespace-only comments are dropped.** `renderToString` writes `<!-- -->` between adjacent text nodes (a
`{{ }}` that rendered nothing between two static strings, a dropped HTML comment) so that hydration can split them;
React keeps those comments in the DOM. The original is client-rendered and has two bare text nodes there. Comments
have no rendering, and the dc runtime never emits a comment of its own (its template walk drops them), so dropping
whitespace-only comment nodes on both sides hides nothing the design could produce. The plan asked the build to
fail on `<!-- -->` instead; stripping them from the HTML would break hydration (React would then find one merged text
node), which is the opposite of what the plan wanted, hence this normalisation. The count is reported per page by the
build (`textBoundaries` in `dist/manifest.json`).

## Deviations: `parity/allowlist.json`

The format and the kinds are the dashboard's (`text`, `attr`, `reorder`, `element-added`, `region-mask`, `wiring`,
`computed-style`; `swap` for pre-render text/attr swaps on the original, `matcher` + `scope` + `expect` for diff-side
entries; stale and over-broad entries fail the run), with `page` (a slug or `*`) instead of `screen`. Entry ids
reference the `DV-...` lines of `design-patches/DEVIATIONS.md`. The fixture configuration carries the `DV-F1-*` href
swaps (the dashboard bundles link by `.dc.html` file name).

Expected for the real design (not needed by the fixtures): an `attr` entry with `matcher: { name: "src", orig:
"^blob:", port: "^/assets/" }` for images (the original mints `blob:` URLs, the port serves hashed files), and
`text` entries for the hours region (the baked strings differ from the design's placeholder text).

## Scenarios

`tools/parity/scenarios/<slug>.ts`, registered in `scenarios/index.ts` by slug; a page without a module gets the
automatic `initial` scenario. The dashboard's Settings (`sections`, `theme-toggle`, `emergency-deeplink`), Payments
and Operations catalogues are kept for the fixtures. After adding a scenario: `pnpm parity --scenario <id>
--against-original` must be green and `pnpm parity:selftest` re-proves the gate.

## Self-tests (`pnpm parity:selftest`)

1. determinism (original vs original, every scenario, both themes, zero diff; inert scenarios flagged);
2. sensitivity (a 1 px padding change, a static label change and a `renderVals` change must fail exactly the checks
   that can see them; the per-page edit targets live in `selftest.ts` `TEXT_EDIT`/`VALS_EDIT` and must be added for a
   new design);
3. swaps (a text swap on the baseline plus the same edit in the port is zero diff; without the swap it fails);
4. stale entries (an allow-list entry that matches nothing fails the run, a swap that matches nothing aborts it);
5. port driver (`PortDriver` against `mock-port.ts`, the originals served at the pages' routes with the ready flag and
   the hook; a 1 px change behind that URL fails dom, style and pixels).

`--quick` runs gate 1 on `initial` and gate 2 on the first page only.

## Phone smoke (`pnpm parity:phone`)

Loads every page of `dist/` at 390x844 and 768x1024 with touch emulation and a fixed (not paused) clock, waits for
hydration, records the document scroll size, a full-page screenshot (`parity-reports/phone/`) and the console; fails
on any error, page error or blocked request. It is a smoke test, not a layout check: a fixed-width design is scaled
by its viewport meta (decided per design in `site.config.json` `viewport`).
