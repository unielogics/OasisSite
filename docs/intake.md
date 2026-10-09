# Intake: from a Claude Design bundle to `design/extracted/`

A Claude Design "Bundled Page" is one HTML file that carries every resource of the page in a manifest
(`<script type="__bundler/manifest">`: uuid → `{mime, compressed, data}`), the CDN resources it replaced
(`__bundler/ext_resources`), nested pages (`__bundler/page_order`) and the page document itself as a JSON string
(`__bundler/template`). In the browser the bundle's own script decodes the manifest, mints a `blob:` URL per
resource (fonts become `data:` URIs), replaces every uuid in the template with that URL and swaps the document.
The dc runtime then compiles `<x-dc>` and evaluates `class Component extends DCLogic`.

The intake does the same decoding offline, generically, and writes stable files. It never edits the bundle.

## Files

`design/pages.json` lists the pages: `[{ "slug", "route", "file", "name" }]` (`file` relative to `design/`;
`route` is the clean URL, `/` for the index). `design/original/` holds the real bundle(s) and `design/original/loose/`
the loose files that came with the design (`oasis-logo.png`, `image-slot.js`, `support.js`): a manifest entry whose
sha256 matches a loose file takes its name. `design/fixtures/` holds the dashboard's three bundles for the tests.

```bash
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
