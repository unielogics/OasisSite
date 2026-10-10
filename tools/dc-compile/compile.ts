import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { transformSync } from 'esbuild'
import { PseudoSheet } from '../../src/dc/pseudo'
import { Emitter } from './emit'
import type { Bindings } from './emit'
import { CompileError } from './errors'
import { loadPages } from './pages'
import type { PageSpec } from './pages'
import { applyCopy, applyCopyToTree, applyPatches, checkDeviationsListed, loadPatchConfig } from './patches'
import type { HeadDrop } from './patches'
import { parseTemplate, textOf, walkEls } from './parse'
import type { PageMetaJson, XImportInfo } from '../intake/unpack'

export const COMPILER_VERSION = '2.0.0'

export type Variant = 'prod' | 'parity'

export interface CompileOptions {
  root: string
  variant: Variant
  tplIds: boolean
  allowComplexExpr: boolean
  /** design/extracted by default */
  extractedDir?: string
  /** pages.json to read (design/pages.json by default) */
  pagesFile?: string
}

/** relative path -> file bytes. Page outputs are relative to --out; shared outputs too (imports/...). */
export type Outputs = Record<string, string | Buffer>

const sha = (b: string | Buffer): string => crypto.createHash('sha256').update(b).digest('hex')

export interface RuntimeCss {
  base: string
  fullPage: string
  atomics: string
}

/** The CSS constants of the ORIGINAL runtime, read from the extracted runtime so they cannot drift. */
export function runtimeCss(extractedDir: string): RuntimeCss {
  const file = path.join(extractedDir, 'runtime', 'dc-runtime.js')
  if (!fs.existsSync(file)) throw new CompileError(`no runtime at ${file} (run pnpm intake)`)
  const src = fs.readFileSync(file, 'utf8')
  const fp = src.match(/var FULL_PAGE_CSS = ("(?:[^"\\]|\\.)*");/)
  if (!fp) throw new CompileError('could not find FULL_PAGE_CSS in the extracted runtime')
  const at = src.match(/var ATOMIC_CSS = \(\s*(?:\/\/[^\n]*\n\s*)*("(?:[^"\\]|\\.)*")\s*\);/)
  if (!at) throw new CompileError('could not find ATOMIC_CSS in the extracted runtime')
  const base = src.match(/var BASE_CSS = `([\s\S]*?)`;/)
  if (!base) throw new CompileError('could not find BASE_CSS in the extracted runtime')
  return { fullPage: JSON.parse(fp[1]!) as string, atomics: JSON.parse(at[1]!) as string, base: base[1]! }
}

export interface CssPart {
  kind: 'atomics' | 'pseudo' | 'full-page' | 'helmet-fontface' | 'helmet'
  chars: number
  file?: string
}

/** What the prerender needs to know about a compiled page (written as <slug>.meta.json). */
export interface CompiledPageMeta {
  slug: string
  route: string
  name: string
  variant: Variant
  tplCount: number
  /** the page ships a hydration bundle (handlers, state, timers or x-imports in the logic/template) */
  hydrated: boolean
  hydratedBecause: string[]
  /** helmet links/metas to put in <head>, in order, after head drops */
  helmetLinks: PageMetaJson['helmetLinks']
  droppedHelmetLinks: PageMetaJson['helmetLinks']
  /** helmet <script src> values the design ships (after head drops); the port emits none of them unless listed in `shipHelmetScripts` */
  helmetScripts: string[]
  droppedHelmetScripts: string[]
  /** vendored font stylesheets folded into the page CSS (raw documents) */
  fontSheets: string[]
  /** the runtime's StandaloneRoot defaults from data-props (the host's user props) */
  propDefaults: Record<string, unknown> | null
  title: string | null
  source: 'bundle' | 'raw'
  /** the bridge module wrapped around the logic class (site.config.json `bridges`), null when none */
  bridge: string | null
  /** the design's own head (charset, viewport, runtime script), informational */
  headHtml: string
  cssParts: CssPart[]
  pseudoRules: string[]
  /** fonts referenced by the page CSS: /fonts/<file> */
  fontFiles: string[]
  /** logical asset paths referenced by the template, logic or CSS (/assets/...) */
  assetPaths: string[]
  /** x-import wrapper modules this page imports (relative to .generated) */
  importModules: string[]
  /** the page needs the pre-hydration theme script: the logic reads localStorage[<key>] (site.config.json
   *  theme.storageKey), or the design's theme prop (theme.prop) defaults to theme.default */
  usesThemeStorage: boolean
  preview: Record<string, unknown> | null
  templateSha256: string
  patchesSha256: string
  dvIds: string[]
}

export interface PageResult {
  outputs: Outputs
  shared: Outputs
  bindings: Bindings
  meta: CompiledPageMeta
  tplCount: number
}

const read = (...p: string[]): string => fs.readFileSync(path.join(...p), 'utf8')

function dropHelmetLinks(links: PageMetaJson['helmetLinks'], scripts: string[], drops: HeadDrop[]) {
  const kept: PageMetaJson['helmetLinks'] = []
  const dropped: PageMetaJson['helmetLinks'] = []
  const keptScripts: string[] = []
  const droppedScripts: string[] = []
  const used = new Set<number>()
  for (const l of links) {
    const i = drops.findIndex((d) => d.tag === l.tag && l.attrs[d.attr] === d.value)
    if (i >= 0) {
      used.add(i)
      dropped.push(l)
    } else kept.push(l)
  }
  for (const src of scripts) {
    const i = drops.findIndex((d) => d.tag === 'script' && d.attr === 'src' && d.value === src)
    if (i >= 0) {
      used.add(i)
      droppedScripts.push(src)
    } else keptScripts.push(src)
  }
  drops.forEach((d, i) => {
    if (!used.has(i))
      throw new CompileError(
        `patch guard failed: head.drop <${d.tag} ${d.attr}="${d.value}"> matches no helmet element`,
        3,
      )
  })
  return { kept, dropped, keptScripts, droppedScripts }
}

export interface SiteCompileConfig {
  name: string
  theme?: { storageKey?: string; prop?: string | null; default?: string } | null
  imageSlots?: { tag: string } | null
  bridges?: Record<string, string>
}

export function readSiteConfig(root: string): SiteCompileConfig {
  const file = path.join(root, 'site.config.json')
  if (!fs.existsSync(file)) return { name: '' }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as SiteCompileConfig
}

/** The import wrapper module: the script source as a function body with the runtime's calling convention. */
export function importWrapper(logicalUrl: string, file: string, source: string): { js: string; dts: string } {
  const kind = /\.(jsx|tsx)$/i.test(file) ? 'jsx' : /\.ts$/i.test(file) ? 'ts' : 'js'
  let code = source
  if (kind !== 'js') {
    // the runtime would use Babel (preset react + typescript) in the browser; esbuild does the same transform here
    code = transformSync(source, {
      loader: kind === 'jsx' ? (file.endsWith('.tsx') ? 'tsx' : 'jsx') : 'ts',
      jsx: 'transform',
      jsxFactory: 'React.createElement',
      jsxFragment: 'React.Fragment',
      format: 'esm',
      target: 'es2022',
      sourcefile: file,
    }).code
  }
  const js =
    `// AUTO-GENERATED by tools/dc-compile from design/extracted/imports/${file}. DO NOT EDIT.\n` +
    `// x-import module ${logicalUrl} (sha256:${sha(source).slice(0, 16)}), evaluated with the dc runtime's calling convention.\n` +
    `/* eslint-disable */\n` +
    `import * as React from 'react'\n` +
    `import { runImport } from '@/dc/ximport'\n` +
    `export const entry = runImport(${JSON.stringify(logicalUrl)}, React, function (React, module, exports, require) {\n` +
    code.replace(/\n?$/, '\n') +
    `})\n`
  const dts = `import type { ImportEntry } from '@/dc/ximport'\nexport declare const entry: ImportEntry\n`
  return { js, dts }
}

export function compilePage(page: PageSpec, opts: CompileOptions): PageResult {
  const { root } = opts
  const extracted = opts.extractedDir ?? path.join(root, 'design', 'extracted')
  const dir = path.join(extracted, page.slug)
  if (!fs.existsSync(path.join(dir, 'template.html')))
    throw new CompileError(`${page.slug}: no intake output at ${dir} (run pnpm intake)`)
  const templateSource = read(dir, 'template.html')
  const metaJson = JSON.parse(read(dir, 'meta.json')) as PageMetaJson
  const xImports = JSON.parse(read(dir, 'imports.json')) as XImportInfo[]
  const cfg = loadPatchConfig(root, page.slug)
  checkDeviationsListed(root, cfg, page.slug)
  const rt = runtimeCss(extracted)

  // source-scope copy entries edit the template text BEFORE parsing (the harness applies the same text swaps to the
  // original before render), so element numbering stays identical on both sides
  const template = applyCopy(templateSource, cfg.copyEntries, 'source')
  const { nodes, tplCount } = parseTemplate(template)
  // helmet styles must equal the extracted helmet.N.css files (the intake and the compiler see the same template)
  const helmetCss: string[] = []
  let helmets = 0
  walkEls(nodes, (el) => {
    if (el.tag === 'sc-helmet') helmets++
    if (el.tag === 'style') helmetCss.push(textOf(el.children))
  })
  if (helmets > 1) throw new CompileError(`${page.slug}: ${helmets} <helmet> elements`)
  if (helmetCss.length !== metaJson.helmets.length)
    throw new CompileError(
      `${page.slug}: ${helmetCss.length} helmet styles in template.html, meta.json lists ${metaJson.helmets.length}`,
    )
  metaJson.helmets.forEach((h, i) => {
    if (read(dir, h.file) !== helmetCss[i])
      throw new CompileError(`${page.slug}: ${h.file} differs from the template's helmet`)
  })

  applyPatches(nodes, cfg, page.slug)
  applyCopyToTree(nodes, cfg.copyEntries)

  // x-import modules: logical url (/assets/x.js) -> wrapper module path under .generated/imports
  const importFiles = new Map<string, string>()
  const assetsJson = fs.existsSync(path.join(extracted, 'assets.json'))
    ? (JSON.parse(read(extracted, 'assets.json')) as { files: Record<string, { kind: string }> })
    : { files: {} }
  for (const [rel, info] of Object.entries(assetsJson.files)) {
    if (info.kind === 'import') importFiles.set('/assets/' + rel.slice('imports/'.length), rel)
  }
  const importMap = new Map<string, string>()
  for (const [url, rel] of importFiles)
    importMap.set(url, './imports/' + path.basename(rel).replace(/\.(jsx|tsx|ts)$/i, '.js'))
  for (const x of xImports)
    for (const u of x.unresolved)
      if (!importMap.has(u)) {
        // reported by the emitter with the tpl id; nothing to do here
      }

  const site = readSiteConfig(root)
  const meta = { slug: page.slug, route: page.route, name: page.name, variant: opts.variant, tplCount }
  const header = [
    '// AUTO-GENERATED by tools/dc-compile. DO NOT EDIT.',
    `// source: design/extracted/${page.slug}/template.html sha256:${sha(templateSource).slice(0, 16)} patches sha256:${cfg.sha.slice(0, 16)} compiler:${COMPILER_VERSION} variant:${opts.variant}${opts.tplIds ? ' tpl-ids' : ''}`,
  ]
  const pseudo = new PseudoSheet()
  const emitter = new Emitter({
    page: page.slug,
    tplIds: opts.tplIds || opts.variant === 'parity',
    allowComplexExpr: opts.allowComplexExpr,
    pseudo,
    imports: importMap,
    imageSlot: site.imageSlots ? { tag: site.imageSlots.tag, brand: site.name } : undefined,
  })
  const { tsx, bindings } = emitter.emit(nodes, header, meta)

  // page CSS in the order the runtime puts the sheets into <head>: atomics (helmet compile) and the pseudo sheet in
  // first-use order, FULL_PAGE_CSS (boot, unless $preview), then the helmet's own styles at render time.
  const parts: CssPart[] = []
  const chunks: string[] = []
  const pushPart = (kind: CssPart['kind'], css: string, file?: string) => {
    parts.push({ kind, chars: css.length, ...(file ? { file } : {}) })
    chunks.push(css)
  }
  const atomics = metaJson.helmetAtomics ? rt.atomics : null
  const pseudoCss = pseudo.size ? pseudo.css() : null
  if (emitter.pseudoBeforeHelmet) {
    if (pseudoCss) pushPart('pseudo', pseudoCss)
    if (atomics) pushPart('atomics', atomics)
  } else {
    if (atomics) pushPart('atomics', atomics)
    if (pseudoCss) pushPart('pseudo', pseudoCss)
  }
  if (!metaJson.preview) pushPart('full-page', rt.fullPage)
  for (const f of metaJson.fontSheets ?? []) pushPart('helmet-fontface', read(dir, f.file), f.file)
  metaJson.helmets.forEach((h, i) =>
    pushPart(h.fontFace ? 'helmet-fontface' : 'helmet', helmetCss[i]!, h.file),
  )
  const pageCss = chunks.join('\n')

  // the logic class as an ES module: DCLogic/StreamableLogic/React in scope like the runtime's evalDcLogic, no eval
  const logicSrc = applyCopy(read(dir, 'logic.original.js'), cfg.copyEntries, 'logic')
  if (/^\s*(import|export)\s/m.test(logicSrc))
    throw new CompileError(`${page.slug}: the logic script contains import/export statements`)
  const bridge = site.bridges?.[page.slug] ?? null
  const logicJs =
    `// AUTO-GENERATED by tools/dc-compile. DO NOT EDIT.\n` +
    `// source: design/extracted/${page.slug}/logic.original.js sha256:${sha(logicSrc).slice(0, 16)} (the original DCLogic script as an ES module)\n` +
    (bridge
      ? `// bridge: ${bridge} wraps the class (never edits it); ./site-env.js is written by the build (tools/prerender/site-env.ts)\n`
      : '') +
    `/* eslint-disable */\n` +
    `import * as React from 'react'\n` +
    `import { DCLogic } from '@/dc/DCLogic'\n` +
    (bridge ? `import { bridge } from ${JSON.stringify(bridge)}\nimport env from './site-env.js'\n` : '') +
    `const StreamableLogic = DCLogic\n` +
    `void React\n` +
    logicSrc.replace(/\s*$/, '\n') +
    (bridge
      ? `export default bridge((typeof Component !== 'undefined' && Component) || undefined, env)\n`
      : `export default (typeof Component !== 'undefined' && Component) || undefined\n`)
  const logicDts = `import type { DCLogicCtor } from '@/dc/types'\ndeclare const Component: DCLogicCtor\nexport default Component\n`

  const because: string[] = []
  if (bindings.handlers.length) because.push(`${bindings.handlers.length} handler/ref bindings`)
  for (const [what, re] of [
    ['setState', /\bsetState\s*\(/],
    ['componentDidMount', /\bcomponentDidMount\s*\(/],
    ['setInterval', /\bsetInterval\s*\(/],
    ['setTimeout', /\bsetTimeout\s*\(/],
    ['addEventListener', /\baddEventListener\s*\(/],
    ['requestAnimationFrame', /\brequestAnimationFrame\s*\(/],
  ] as const) {
    if (re.test(logicSrc)) because.push(what)
  }
  if (bindings.ximports.length) because.push(`${bindings.ximports.length} x-import`)

  const { kept, dropped, keptScripts, droppedScripts } = dropHelmetLinks(
    metaJson.helmetLinks,
    metaJson.helmetScriptSrcs ?? [],
    cfg.headDrops,
  )
  const fontFiles = [
    ...new Set([...pageCss.matchAll(/url\(["']?(\/fonts\/[^"')]+)["']?\)/g)].map((m) => m[1]!)),
  ].sort()
  const assetPaths = [
    ...new Set(
      [...`${tsx}\n${logicSrc}\n${pageCss}`.matchAll(/\/assets\/[A-Za-z0-9._-]+/g)].map((m) => m[0]),
    ),
  ].sort()
  const importModules = [
    ...new Set(
      bindings.ximports.flatMap((x) => (x.url && importMap.get(x.url) ? [importMap.get(x.url)!] : [])),
    ),
  ].sort()
  const themeKey = site.theme?.storageKey ?? null
  const compiled: CompiledPageMeta = {
    slug: page.slug,
    route: page.route,
    name: page.name,
    variant: opts.variant,
    tplCount,
    hydrated: because.length > 0,
    hydratedBecause: because,
    helmetLinks: kept,
    droppedHelmetLinks: dropped,
    helmetScripts: keptScripts,
    droppedHelmetScripts: droppedScripts,
    fontSheets: (metaJson.fontSheets ?? []).map((f) => f.file),
    propDefaults: metaJson.propDefaults ?? null,
    title: metaJson.title ?? null,
    source: metaJson.source ?? 'bundle',
    bridge,
    headHtml: fs.existsSync(path.join(dir, 'head.html')) ? read(dir, 'head.html') : '',
    cssParts: parts,
    pseudoRules: pseudo.rules(),
    fontFiles,
    assetPaths,
    importModules,
    // the page gets the pre-hydration theme script: its logic reads the stored theme itself, or its theme is a prop
    // that boot fills with the script's decision (site.config.json theme.prop, DV-THEME)
    usesThemeStorage:
      (themeKey !== null && logicSrc.includes(`'${themeKey}'`)) ||
      (themeKey !== null && logicSrc.includes(`"${themeKey}"`)) ||
      (!!site.theme?.prop && (metaJson.propDefaults ?? {})[site.theme.prop] === site.theme.default),
    preview: metaJson.preview,
    templateSha256: sha(templateSource),
    patchesSha256: cfg.sha,
    dvIds: cfg.dvIds,
  }

  const outputs: Outputs = {
    [`${page.slug}.tsx`]: tsx,
    [`${page.slug}.bindings.json`]: JSON.stringify(bindings, null, 2) + '\n',
    [`${page.slug}.page.css`]: pageCss,
    [`${page.slug}.logic.js`]: logicJs,
    [`${page.slug}.logic.d.ts`]: logicDts,
    [`${page.slug}.meta.json`]: JSON.stringify(compiled, null, 2) + '\n',
  }
  const shared: Outputs = {}
  for (const mod of importModules) {
    const url = [...importMap.entries()].find(([, m]) => m === mod)![0]
    const rel = importFiles.get(url)!
    const { js, dts } = importWrapper(url, path.basename(rel), read(extracted, rel))
    shared[mod.slice(2)] = js
    shared[mod.slice(2).replace(/\.js$/, '.d.ts')] = dts
  }
  return { outputs, shared, bindings, meta: compiled, tplCount }
}

export interface CompileAll {
  perPage: Record<string, Outputs>
  shared: Outputs
  metas: Record<string, CompiledPageMeta>
  bindings: Record<string, Bindings>
  tplCounts: Record<string, number>
  pages: PageSpec[]
}

export function compilePages(opts: CompileOptions, only?: readonly string[]): CompileAll {
  const { pages } = loadPages(opts.root, opts.pagesFile)
  const selected = only ? pages.filter((p) => only.includes(p.slug)) : pages
  if (only)
    for (const s of only)
      if (!pages.some((p) => p.slug === s))
        throw new CompileError(`unknown page ${s} (pages.json has ${pages.map((p) => p.slug).join(', ')})`)
  const out: CompileAll = { perPage: {}, shared: {}, metas: {}, bindings: {}, tplCounts: {}, pages: selected }
  for (const p of selected) {
    const r = compilePage(p, opts)
    out.perPage[p.slug] = r.outputs
    out.metas[p.slug] = r.meta
    out.bindings[p.slug] = r.bindings
    out.tplCounts[p.slug] = r.tplCount
    for (const [k, v] of Object.entries(r.shared)) {
      const prev = out.shared[k]
      if (prev !== undefined && String(prev) !== String(v))
        throw new CompileError(`shared output ${k} differs between pages`)
      out.shared[k] = v
    }
  }
  return out
}
