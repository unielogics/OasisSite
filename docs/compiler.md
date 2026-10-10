# dc compiler, runtime shim and prerender

`tools/dc-compile` turns each page of `design/pages.json` (its `design/extracted/<slug>/template.html`) into a React
render function; `src/dc` runs the original logic class unchanged behind `DCHost`; `tools/prerender` renders the
result to static HTML at build time and the browser hydrates it only where the page has behaviour. The port of the
template rules is the dashboard's (zero diff proven there), extended for what a marketing design may use.

## Pipeline

```
design/extracted/<slug>/template.html ──┐
design-patches/{href-map,copy-map,<slug>.patch}.json ─┤ tools/dc-compile ─► .generated/<variant>/<slug>.tsx
design/extracted/<slug>/helmet.N.css, runtime/ ────┘                      <slug>.bindings.json  <slug>.meta.json
design/extracted/<slug>/logic.original.js ──────────────────────────────► <slug>.logic.js (+ .d.ts)  ES module, no eval
design/extracted/imports/<name>.js ─────────────────────────────────────► imports/<name>.js  x-import wrappers
                                                                          <slug>.page.css   atomics|pseudo|FULL_PAGE|helmet sheets
```

`.generated/` is not committed: `pnpm build` compiles fresh (deterministic output; `pnpm dc:check` recompiles and
compares with what is on disk).

```bash
pnpm dc:compile                                  # .generated/ (prod)
pnpm exec tsx tools/dc-compile/index.ts --page settings --variant=parity --out /tmp/x
pnpm exec tsx tools/dc-compile/index.ts --pages design/fixtures/pages.json --extracted .tmp-snippets/fixtures-extracted
```

Flags: `--page <slug>|all`, `--check`, `--variant=prod|parity`, `--emit-tpl-ids`, `--out <dir>`, `--pages <file>`,
`--extracted <dir>`, `--allow-complex-expr`. Exit codes: 0 ok, 1 `--check` mismatch, 2 grammar / unknown attribute /
unsupported construct, 3 patch guard failed.

## Compilation rules (unchanged from the dashboard)

Parsing is the runtime's `encodeCase` pre-pass (self-closing `x-import` expanded, `helmet` → `sc-helmet`, camelCase
attributes → `sc-camel-*`, table tags wrapped) and `parse5.parseFragment`; every element gets the pre-order `tplId` the
runtime stamps into `data-dc-tpl`. Expressions follow `IDENT ('.' (IDENT | DIGITS))*`; `--allow-complex-expr` emits the
runtime's `resolve()`. Text interpolation `I()`, `sc-for` as `asArray(...).map`, `sc-if` by JS truthiness, static styles
hoisted as frozen objects, `class` → `className`, `for` → `htmlFor`, events through `EVENT_MAP`, bound `value`/`checked`
with an undefined default and a `NOOP` `onChange`, whitespace-only text dropped exactly like `walkText`. See the goldens
in `tools/dc-compile/tests/golden.test.ts`; `pages.test.ts` compiles the three fixtures and compares every render against
the reference interpreter (`tests/reference.ts`, a transliteration of the runtime's `walk*` builders on the original
`resolve()`/`cssToObj()`), in prod and parity variants, in three vals modes.

## Added for the website

- **`style-<pseudo>` attributes** become classes `scp<n>` (n in base 36, numbered by first use while the template is
  walked: parent before children, attributes in source order, `x-import` attributes included, identical
  `pseudo|css` pairs cached) and the rule `.scp<n>:<pseudo>{<css with every declaration !important>}` or
  `.scp<n>::before|after{<css>}` goes into the page CSS. `src/dc/pseudo.ts` is a verbatim port of the runtime's
  `createPseudoSheet`, `importantify`, `stripComments` and `scanUnquotedUrl`; a test compares each with the
  original functions extracted from `dc-runtime.js`, and the goldens compare the numbering with the original sheet.
  On the element, `className = [props.className, ...pseudoClasses].filter(Boolean).join(' ')` (`pc()` when bound).
- **`x-import`** (`src/dc/ximport.ts`): the `from` url must be a bundled resource (`imports.json`); the compiler
  wraps `design/extracted/imports/<name>.js` as an ES module `imports/<name>.js` that runs the script with the
  runtime's calling convention `(React, module, exports, require)` at module load and captures the window globals it
  created (`.jsx`/`.tsx` go through esbuild's classic JSX transform at build time, never Babel in the browser).
  Resolution is the runtime's: `module.exports[name]`, a created global, `window[name]`, `module.exports.default`;
  `component-from-global-scope` resolves a renderable global or a custom element name. The element renders as
  `<div class="sc-host-x" data-dc-tpl style=display:contents|positioning subset of its style>` around the component (or
  the runtime's `Placeholder` with the same error text when unresolved); props are the attributes with `-` names
  camelCased (except `aria-`/`data-`), `component`/`componentFromGlobalScope`/`from` skipped, `dcProps` spread,
  children passed as an array. External URLs fail the build (CSP `script-src 'self'`).
- **Logic as an ES module**: `<slug>.logic.js` is `import React; import { DCLogic }; const StreamableLogic = DCLogic;`
  - the original script byte for byte + `export default Component`. Strict mode did not bother any of the three
    fixtures. No `new Function`, no `unsafe-eval`.
- **Pages from `pages.json`**, `--pages`/`--extracted` for the tests, `meta.json` per page for the prerender
  (hydration decision, helmet links after head drops, CSS parts, pseudo rules, fonts and assets referenced, theme
  storage use, `$preview`).
- **Hydration decision**: a page ships a bundle when its bindings have handlers/refs, or its logic calls `setState`,
  `componentDidMount`, timers, `addEventListener` or `requestAnimationFrame`, or it has an `x-import`. Otherwise no
  React is shipped at all.

## Added for "Oasis Site v2" (a raw document)

- **`<image-slot>` (DV-IMG).** `site.config.json` `imageSlots: { tag }` names a custom element the build renders as a
  static placeholder: the element keeps its tag and attributes and gets `dangerouslySetInnerHTML` = a declarative
  shadow root (`src/dc/image-slot.ts`: image-slot.js's `:host` rules, the design's chrome gradient, the wordmark and
  the slot's caption; with a `src` the frame holds the photo). The HTML parser attaches the shadow root before any
  script runs; hydration never looks inside `dangerouslySetInnerHTML`. The helmet's `image-slot.js` is dropped
  (`head.drop` on `<script src>`).
- **Font sheets (DV-FONTS).** `meta.json` `fontSheets` (the vendored Google CSS, docs/intake.md) are folded into the
  page CSS right before the helmet's own styles.
- **`source` copy entries.** A copy-map entry with `scope: "source"` edits the template TEXT before parsing, exactly
  like the harness's pre-render swaps on the original, so a markup removal (the join flow's card fields) numbers the
  remaining elements identically on both sides. `toConfig` resolves the replacement from `site.config.json`
  (contact facts), so nothing is written twice.
- **The bridge.** `site.config.json` `bridges: { "<slug>": "@/site/<slug>.bridge" }` makes `<slug>.logic.js` import
  the module and `export default bridge(Component, env)`, with `env` from `./site-env.js` (written by the build,
  tools/prerender/site-env.ts). The original script stays byte for byte; the bridge subclasses it (docs/site.md).
- **`propDefaults`** (the data-props defaults the runtime's StandaloneRoot passes) are the host's user props; the
  parity vals are `renderVals()` alone, like the original's logic instance.
- **The build instant.** Every prerender runs with `Date` pinned to `buildNow` (`SITE_BUILD_NOW`, else now; the parity
  build: the harness's `FIXED_NOW`); a bridged page's client pins its first render to the same instant
  (`src/client/boot.tsx` `freeze`, released right before the logic's `componentDidMount`), so hydration matches
  and the design then re-renders with the real time (DV-CLOCK).

## Patch layer (`design-patches/`)

Same ops as the dashboard (`replace-text` with `{{= path }}` raw interpolation, `rewrite-href`, `set-attr`,
`wrap-if`, `remove`, `insert-before|after` and `wrap` with inline template markup), `href-map.json` (`{"dv", "map"}`),
`copy-map.json` entries (`page` instead of `screen`). Every op, copy entry and the href map carry `dv: "DV-..."`
and the build fails (exit 3) unless `design-patches/DEVIATIONS.md` has a `**DV-...**` entry for it. `<slug>.patch.json`
may also carry `head.drop: [{tag, attr, value, dv}]` to keep helmet links (e.g. external preconnects) out of the
head; a drop that matches nothing fails the build.

Designs without a bridge can bind an hours region with `set-attr data-hours="week.1.range"` plus `replace-text`
`{{= hours.week.1.range }}` (`hours` as a user prop, refreshed through `src/client/hours.ts`); "Oasis Site v2" binds
its hours, board and flows through the bridge instead (docs/site.md).

## Runtime shim (`src/dc`)

`DCLogic` (setState synchronous, re-render through the host), `DCHost` (class component: constructs the logic,
`{...userProps, ...renderVals()}`, renders `<div class="sc-host" data-sc-name>`; the React root container is
`#dc-root` on both sides), `runtime.ts` (`I`, `asArray`, `css`, `m`, `pc`, `hs`, `XI`, `resolve`), `serialize.ts`
(the parity `serializeVals`, identical to `tools/parity/vals-serialize.ts`), `parity.ts` (the `window.__oasisParity`
hook and the `data-oasis-ready` flag, present only when esbuild defines `process.env.OASIS_PARITY` as `"1"`; every
guard repeats the literal test so the production bundle drops the hook, which a build test asserts).

## Prerender and hydration (`tools/prerender`, `src/client`)

`render.ts` imports the generated modules and calls `renderToString(<DCHost/>)` under `shims.ts`: in-memory
`localStorage` seeded with the default theme, `matchMedia` matching nothing, a `location` for the route, the design's
`$preview` size as the window size, a minimal `document`, and `Date` pinned only when `PRERENDER_NOW` is set (the parity
build pins it to the harness's frozen instant; production builds use real time, so a design that bakes "today" must be
decided per design, the inventory lists Date usage). Console errors during the render, and the host's error card,
fail the build; warnings are reported.

React's `renderToString` writes `<!-- -->` between adjacent text nodes (a `{{ }}` that rendered nothing, a dropped
comment); hydration needs them and keeps them. The parity DOM check drops whitespace-only comments on both sides
(the original never has any) instead of the build failing on them, see docs/parity.md.

`head.ts` assembles the document: the design's charset and viewport (or `site.config.json` `viewport`, e.g.
`width=1480` for a fixed-width design), title/description/canonical/Open Graph from `seo.json`, icons from
`site.config.json` `icon`, the helmet's links, `<link rel=preload>` for the latin font files, one stylesheet per page
(`[atomics][pseudo][FULL_PAGE_CSS unless $preview][helmet sheets in order]`, the runtime's head order; BASE_CSS is
omitted because it only styles placeholders, streaming states and print), the LocalBusiness JSON-LD data block,
then `<div id="dc-root">` + the theme patch script + (static pages only) the hours script + the page bundle.

`src/client/boot.tsx` hydrates with `hydrateRoot` (recoverable errors go to `console.error`, which the parity console
check catches) and starts the hours refresh. `src/client/theme.entry.ts` is a 0.5 KB external script placed right after
`#dc-root`: React 18 does not reconcile attribute differences while hydrating, so the stored theme is written into
every `[data-theme="<default>"]` element before the bundle runs. `src/client/hours.ts` fetches
`/api/v1/public/hours` with a 3 s `AbortController` timeout and re-applies the formatted strings; any failure leaves
the baked strings.
