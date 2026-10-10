# Intake: from a Claude Design page to `design/extracted/`

Two source formats are read, both into the same `design/extracted/` layout and `meta.json`:

- a **raw `.dc.html` document** ("Oasis Site v2", what Claude Design saves for a project): `<head>` loads
  `./support.js` (the dc runtime), `<x-dc>` holds the `<helmet>` and the template, `<script type="text/x-dc"
  data-dc-script data-props>` the logic. Its loose files sit beside it in `design/original/loose/` (`support.js`,
  `image-slot.js`, `assets/<file>`). See "Raw documents" below.
- a **"Bundled Page"** (the dashboard's three bundles, kept as fixtures for the pipeline's tests).

A Claude Design "Bundled Page" is one HTML file that carries every resource of the page in a manifest
(`<script type="__bundler/manifest">`: uuid → `{mime, compressed, data}`), the CDN resources it replaced
(`__bundler/ext_resources`), nested pages (`__bundler/page_order`) and the page document itself as a JSON string
(`__bundler/template`). In the browser the bundle's own script decodes the manifest, mints a `blob:` URL per
resource (fonts become `data:` URIs), replaces every uuid in the template with that URL and swaps the document.
The dc runtime then compiles `<x-dc>` and evaluates `class Component extends DCLogic`.

The intake does the same decoding offline, generically, and writes stable files. It never edits the bundle.

## Files

`design/pages.json` lists the pages: `[{ "slug", "route", "file", "name" }]` (`file` relative to `design/`;
`route` is the clean URL, `/` for the index): today `[{ "slug": "index", "route": "/", "file": "original/Oasis Site
v2.dc.html" }]`. `design/original/` holds the design and `design/original/loose/` the loose files that came with it
(`support.js`, `image-slot.js`, `assets/oasis-logo.png` once supplied); for a bundle, a manifest entry whose sha256
matches a loose file takes its name. `design/fonts/` holds the vendored Google Fonts, `design/probe/` the Chromium
probe, `design/fixtures/` the dashboard's three bundles for the tests. `design/CHECKSUMS.sha256` covers all of it
(`pnpm design:verify` runs in check and build; `pnpm design:checksums` after an intake).

```bash
pnpm intake:fonts           # once per design: vendor the helmet's Google Fonts into design/fonts (network)
pnpm intake                 # design/pages.json -> design/extracted/ (the directory is replaced)
pnpm intake:inventory       # docs/intake-report.md + design/extracted/<slug>/inventory.json
pnpm intake:probe           # design/probe/<slug>.json from the ORIGINAL in pinned Chromium (needs the browser)
pnpm design:checksums       # then commit design/ with its CHECKSUMS.sha256 (design:verify runs in check and build)
```

## `tools/intake/unpack.ts`

Classification of every manifest entry, by MIME and content:

| kind      | how it is recognised                                     | written to                                  | logical path     |
| --------- | -------------------------------------------------------- | ------------------------------------------- | ---------------- |
| `react`   | uuid listed in `ext_resources` (React / ReactDOM UMD)    | `runtime/react*.production.min.js`          | `/runtime/...`   |
| `runtime` | `text/javascript` whose text contains `// src/boot.ts`   | `runtime/dc-runtime.js` (one per design)    | `/runtime/...`   |
| `frame`   | uuid listed in `page_order` (a nested page, `text/html`) | `frames/<loose name or page-<sha8>.html>`   | `/frames/<file>` |
| `font`    | `font/*` or `application/font*`                          | `fonts/<family-slug>-<subset>.<ext>`        | `/fonts/<file>`  |
| `import`  | any other `text/javascript` (`x-import` modules)         | `imports/<loose name or script-<sha8>.js>`  | `/assets/<file>` |
| `asset`   | everything else (images, css, ...)                       | `assets/<loose name or <ext>-<sha8>.<ext>>` | `/assets/<file>` |

Fonts are named like the dashboard did (family slug + the `/* subset */` comment preceding the `@font-face` that
references the uuid) and deduped across pages by sha256; a sha collision with different family/subset is an error.
Names are shared across pages through a registry, so the same bytes get the same file everywhere.

Every uuid occurrence is recorded in `<slug>/refs.json` before rewriting: `attribute` (tag, attribute name and the
source `tplId` of the element, numbered like the runtime's `stamp()`), `css` (inside a helmet `<style>`), `logic`,
`head`, and `frame-marker` (`about:blank#<uuid>` on an iframe). Uuids are then rewritten **once**, in the whole page
document, to the logical paths above; the build maps logical paths to hashed URLs under `/assets/`. A uuid that
survives the rewrite fails the intake.

The page document is split into `head.html` (the design's own `<head>`: charset, viewport, runtime script),
`template.html` (the `<x-dc>` innerHTML exactly as the runtime parses it, helmet included), `logic.original.js`
(byte-exact), `helmet.N.css` (every helmet `<style>` in order; `meta.json` says which ones are `@font-face` sheets;
there is no "exactly two styles" assumption), `meta.json` (route, name, `data-props` minus `$preview`, the
`$preview` size, helmet links/metas/scripts, `data-dc-atomics`, frames, runtime sha) and `imports.json` (every
`x-import`: `from` urls after rewriting, component / global name, `hint-size`, child count, unresolved urls).

Two things the HTML parser decides for the runtime and therefore for us: a self-closing `<x-import .../>` is an
open tag, so its following siblings become its children (the browser's `innerHTML` and parse5 agree); and
`<template>` elements are refused.

## Raw documents (`tools/intake/raw.ts`)

The runtime boots a raw document twice: first from `<x-dc>.innerHTML` (the browser's body parse), then — when no
bundler resource map exists — from a re-fetch of the page's own source, slicing the text between the `<x-dc>` open
tag and the LAST `</x-dc>` (`parseDcText`). The second compile is the one that stays mounted, so the intake takes
the same raw slice as `template.html`; `logic.original.js` is the script's text byte for byte; `head.html` the
document's `<head>` with `./support.js` rewritten to `/runtime/dc-runtime.js`.

Resources are the relative references of the template (`src`, `href`, `url()`), the head (`script src`) and the
logic (quoted strings), resolved against the loose files: the runtime (`// src/boot.ts`) → `runtime/dc-runtime.js`,
other scripts (`./image-slot.js`) → `scripts/<name>` at `/assets/<name>`, `assets/<file>` → `assets/<file>` at
`/assets/<file>`. A referenced image that does not exist yet (the logo the owner has not supplied) is recorded with
`missing: true` in `assets.json`; the build substitutes a placeholder (DEVIATIONS.md DV-LOGO) and the intake accepts
the real file the moment it appears under `design/original/loose/assets/`.

`meta.json` additionally carries `source: "raw"`, `propDefaults` (every data-props entry's `default`, what the
runtime's StandaloneRoot passes as props), `title` (the helmet's `<title>`), `helmetScriptSrcs` and `fontSheets`.

### Fonts (`pnpm intake:fonts`, once)

A raw document links Google Fonts from its helmet. `tools/intake/fonts.ts` downloads, ONCE, the CSS exactly as
Google serves it to a current Chrome (variable fonts with the axes the query asks for, unicode-range subsets) and
every woff2 it references, into `design/fonts/` (`google-<n>.css` verbatim, `<family>-<subset>.woff2`,
`manifest.json` with every source URL and sha256). It is the only step of the pipeline that touches the network;
`pnpm intake` then builds `helmet.fonts.<n>.css` (the same CSS with `url(/fonts/<file>)`) from it and fails when the
helmet links a stylesheet the manifest does not cover. The compiler folds the font sheets into the page CSS before
the helmet's own styles; the helmet's preconnects and stylesheet link are dropped by a `head.drop` patch
(DEVIATIONS.md DV-FONTS). The parity harness answers the original's Google Fonts requests from the same files.

## `tools/intake/inventory.ts`

`docs/intake-report.md` is the decision sheet for the compiler and the patch layer: per page the element count,
`sc-if` / `sc-for` / `{{ }}` counts, whole and mixed attribute bindings, handlers and refs, every expression outside
the strict grammar, `style-<pseudo>` attributes by pseudo, `class=` (static/bound), the helmet sheets with their
`@media` and `@font-face` counts, `x-import`s, the root wrapper's style (width/height, i.e. whether the design is
fixed-width), the theme binding and its localStorage key, the browser APIs the logic touches (localStorage, Date,
matchMedia, location, innerWidth, fetch, timers, document, window), hrefs by scheme, the CTAs (anchors and buttons
with their text, href and handler) and the hours-like strings (times, weekdays, open/closed words).

## `tools/intake/probe-original.ts`

Ground truth from the original: for every page, the `<head>` children in order with each `<style>` classified
(`base` = BASE_CSS, `hide-x-dc`, `atomics`, `pseudo` = the scpN sheet, `full-page`, `helmet-fontface`, `helmet`),
the pseudo rules in insertion order, `#dc-root` outerHTML and its sha256, the fonts loaded, the console, the
document height. The compiler's CSS order and pseudo numbering are checked against it.

## Tests

`tools/intake/unpack.test.ts` runs the intake on the three dashboard fixtures (12 resources per page: 1 runtime,
2 React builds, 9 fonts; 9 distinct font files across the three; byte-exact logic; no uuid left; the inventory sees
the theme key, the constructs and the hrefs) and on a synthetic gzip-compressed bundle with an image, an import
script, a nested page, an `x-import`, a loose-file name match and a `data-dc-atomics` helmet.
