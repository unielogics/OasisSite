// intake: generic unpacker for Claude Design "Bundled Page" HTML files (the format the dashboard's three bundles and
// "Oasis Site v2" share). One bundle = <script type="__bundler/manifest"> (uuid -> {mime, compressed, data}),
// __bundler/ext_resources (CDN ids -> uuids), __bundler/page_order (nested page uuids) and __bundler/template (the
// JSON-encoded page document whose uuids the browser-side unpacker replaces with blob: URLs). This tool classifies the
// manifest by MIME, writes every resource under design/extracted/ with a stable name, rewrites the uuids to
// /assets/* and /fonts/* once, and splits the page document into head / template / logic / helmet styles.
// Usage: tsx tools/intake/unpack.ts [--pages design/pages.json] [--out design/extracted]
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { parse, parseFragment, serialize } from 'parse5'
import type { DefaultTreeAdapterMap } from 'parse5'
import { parseTemplate, walkEls, textOf as textOfNodes } from '../dc-compile/parse'
import type { ElNode } from '../dc-compile/parse'
import { loadPages } from '../dc-compile/pages'
import type { PageSpec } from '../dc-compile/pages'

type El = DefaultTreeAdapterMap['element']
type P5 = DefaultTreeAdapterMap['node']

export const sha256 = (b: Buffer | string): string => crypto.createHash('sha256').update(b).digest('hex')
const sha8 = (b: Buffer | string): string => sha256(b).slice(0, 8)
const isEl = (n: P5): n is El => 'tagName' in n
const attr = (e: El, name: string): string | undefined => e.attrs.find((a) => a.name === name)?.value
const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const FONT_MIME = /^(font\/|application\/(x-)?font-|application\/vnd\.ms-fontobject)/i
const JS_MIME = /^(text|application)\/(javascript|ecmascript|x-javascript|babel|jsx)$/i

function walk(n: P5, f: (e: El) => void): void {
  if (isEl(n)) f(n)
  const kids = (n as { childNodes?: P5[] }).childNodes ?? []
  const content = (n as { content?: { childNodes: P5[] } }).content
  for (const k of kids) walk(k, f)
  if (content) for (const k of content.childNodes) walk(k, f)
}
const textOf = (e: El): string =>
  (e.childNodes as { nodeName: string; value?: string }[]).map((c) => c.value ?? '').join('')

export class IntakeError extends Error {}

export interface ManifestEntry {
  mime: string
  compressed?: boolean
  data: string
}

export type ResourceKind = 'runtime' | 'react' | 'import' | 'font' | 'asset' | 'frame'

export interface Resource {
  uuid: string
  kind: ResourceKind
  mime: string
  bytes: Buffer
  sha256: string
  /** file name under extracted/<dir>/ (runtime/, fonts/, assets/, imports/, frames/) */
  file: string
  /** the logical path references are rewritten to (/fonts/x.woff2, /assets/x.png, /assets/x.js, /frames/x.html) */
  path: string
  /** fonts: family and subset from the @font-face block that references the uuid */
  family?: string
  subset?: string
  /** name came from a sha256 match against design/original/loose/ */
  looseName?: string
}

export interface UuidRef {
  uuid: string
  where: 'attribute' | 'css' | 'logic' | 'head' | 'frame-marker'
  /** attribute refs: element tag + attribute + source tpl id */
  tag?: string
  attr?: string
  tpl?: number
}

export interface HelmetSheet {
  index: number
  file: string
  fontFace: boolean
  chars: number
  css: string
}

export interface HelmetLink {
  tag: string
  attrs: Record<string, string>
}

export interface XImportInfo {
  tpl: number
  from: string[]
  /** last `from` url (after uuid rewrite), '' when none */
  url: string
  component: string
  globalName: string
  hintSize: string | null
  /** element children (a self-closing x-import swallows its following siblings, see unpackBundle) */
  children: number
  /** urls that could not be matched to a bundled resource (external or missing) */
  unresolved: string[]
}

export interface PageMetaJson {
  slug: string
  route: string
  name: string
  sourceFile: string
  sourceSha256: string
  /** data-props minus $preview (null when absent), and the $preview block */
  dataProps: Record<string, unknown> | null
  preview: Record<string, unknown> | null
  /** data-screen-label of the root element when present */
  label: string | null
  templateChars: number
  logicChars: number
  helmets: Omit<HelmetSheet, 'css'>[]
  helmetLinks: HelmetLink[]
  helmetScripts: number
  helmetAtomics: boolean
  xImports: number
  frames: string[]
  runtimeSha256: string | null
}

export interface Unpacked {
  page: PageSpec
  sourceSha256: string
  resources: Resource[]
  refs: UuidRef[]
  /** the full page document with uuids rewritten (what head.html + template + logic come from) */
  head: string
  template: string
  logic: string
  meta: PageMetaJson
  helmets: HelmetSheet[]
  xImports: XImportInfo[]
  /** uuids present in the manifest that no text of this page references (after rewriting) */
  unreferenced: string[]
}

export interface LooseFile {
  name: string
  sha256: string
}

export function readLooseFiles(dir: string): LooseFile[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((n) => fs.statSync(path.join(dir, n)).isFile())
    .sort()
    .map((name) => ({ name, sha256: sha256(fs.readFileSync(path.join(dir, name))) }))
}

/** Names already taken across pages: sha -> name, so the same bytes get the same file everywhere. */
export interface NameRegistry {
  bySha: Map<string, { kind: ResourceKind; file: string; path: string; family?: string; subset?: string }>
  taken: Set<string>
}
export const newRegistry = (): NameRegistry => ({ bySha: new Map(), taken: new Set() })

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'font/woff2': 'woff2',
  'font/woff': 'woff',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
  'text/css': 'css',
  'text/html': 'html',
  'application/json': 'json',
  'text/plain': 'txt',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
}
const extOf = (mime: string): string =>
  EXT_BY_MIME[mime.toLowerCase()] ?? mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') ?? 'bin'

function grab(raw: string, type: string, required: boolean): string | null {
  const m = raw.match(new RegExp(`<script type="__bundler/${type}">([\\s\\S]*?)</script>`))
  if (!m) {
    if (required) throw new IntakeError(`bundle has no <script type="__bundler/${type}">`)
    return null
  }
  return m[1]!
}

/** Which @font-face block (family + preceding subset comment) references a uuid. */
function fontFaceIndex(css: string): Map<string, { family: string; subset: string }> {
  const out = new Map<string, { family: string; subset: string }>()
  const blockRe = /(?:\/\*\s*([\w-]+)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(css))) {
    const subset = m[1] ?? ''
    const body = m[2]!
    const family = body.match(/font-family:\s*['"]([^'"]+)['"]/)?.[1] ?? ''
    for (const u of body.matchAll(/url\(["']?([0-9a-f-]{36})["']?\)/g)) {
      if (UUID_RE.test(u[1]!) && !out.has(u[1]!)) out.set(u[1]!, { family, subset })
    }
  }
  return out
}

function uniqueName(reg: NameRegistry, want: string): string {
  if (!reg.taken.has(want)) return want
  const ext = path.extname(want)
  const stem = want.slice(0, want.length - ext.length)
  for (let i = 2; ; i++) {
    const c = `${stem}-${i}${ext}`
    if (!reg.taken.has(c)) return c
  }
}

/**
 * Unpacks one bundle in memory. `reg` carries names across pages (fonts and assets are shared); `loose` is the list of
 * design/original/loose files (sha256 -> name) that gives imports and images their real names.
 */
export function unpackBundle(
  raw: string,
  page: PageSpec,
  reg: NameRegistry = newRegistry(),
  loose: LooseFile[] = [],
): Unpacked {
  const sourceSha256 = sha256(raw)
  const manifest = JSON.parse(grab(raw, 'manifest', true)!) as Record<string, ManifestEntry>
  const ext = JSON.parse(grab(raw, 'ext_resources', false) ?? '[]') as { id: string; uuid: string }[]
  const pageOrder = JSON.parse(grab(raw, 'page_order', false) ?? '[]') as string[]
  const templateRaw = JSON.parse(grab(raw, 'template', true)!) as unknown
  if (typeof templateRaw !== 'string') throw new IntakeError('__bundler/template is not a JSON string')
  let template: string = templateRaw
  for (const u of Object.keys(manifest))
    if (!UUID_RE.test(u)) throw new IntakeError(`manifest key ${JSON.stringify(u)} is not a uuid`)

  const bytesOf = (uuid: string): Buffer => {
    const e = manifest[uuid]!
    const b = Buffer.from(e.data, 'base64')
    return e.compressed ? zlib.gunzipSync(b) : b
  }
  const looseBySha = new Map(loose.map((l) => [l.sha256, l.name]))
  const extByUuid = new Map(ext.map((e) => [e.uuid, e.id]))
  const pageSet = new Set(pageOrder)

  // --- the page document: locate x-dc, the logic script and the helmet styles (for font naming) -----------------
  const doc = parse(template)
  let xdc: El | undefined
  let logicEl: El | undefined
  walk(doc as unknown as P5, (e) => {
    if (e.tagName === 'x-dc' && !xdc) xdc = e
    if (e.tagName === 'script' && attr(e, 'data-dc-script') !== undefined && !logicEl) logicEl = e
  })
  if (!xdc) throw new IntakeError(`${page.file}: no <x-dc> in the page document`)
  const xdcInner = serialize(xdc as unknown as DefaultTreeAdapterMap['parentNode'])
  const logicRaw = logicEl ? textOf(logicEl) : ''
  const dataPropsRaw = logicEl ? attr(logicEl, 'data-props') : undefined
  const fontIndex = fontFaceIndex(xdcInner)

  // --- classify every manifest entry ----------------------------------------------------------------------------
  const resources: Resource[] = []
  for (const uuid of Object.keys(manifest)) {
    const entry = manifest[uuid]!
    const mime = String(entry.mime || '').toLowerCase()
    const bytes = bytesOf(uuid)
    const sha = sha256(bytes)
    const known = reg.bySha.get(sha)
    const looseName = looseBySha.get(sha)
    let kind: ResourceKind
    let dir: string
    let file: string
    let family: string | undefined
    let subset: string | undefined
    const text = (): string => bytes.toString('utf8')
    if (extByUuid.has(uuid)) {
      kind = 'react'
      dir = 'runtime'
      const id = extByUuid.get(uuid)!
      file = /react-dom/i.test(id)
        ? 'react-dom.production.min.js'
        : /\breact\b/i.test(id)
          ? 'react.production.min.js'
          : path.basename(new URL(id, 'https://x.invalid/').pathname) || `ext-${sha8(bytes)}.js`
    } else if (pageSet.has(uuid)) {
      kind = 'frame'
      dir = 'frames'
      file = looseName ?? `page-${sha8(bytes)}.html`
    } else if (JS_MIME.test(mime) && text().includes('// src/boot.ts')) {
      kind = 'runtime'
      dir = 'runtime'
      file = 'dc-runtime.js'
    } else if (FONT_MIME.test(mime)) {
      kind = 'font'
      dir = 'fonts'
      const ff = fontIndex.get(uuid)
      if (ff && ff.family) {
        family = ff.family
        subset = ff.subset
        file = `${slugify(ff.family)}${ff.subset ? '-' + ff.subset : ''}.${extOf(mime)}`
      } else file = looseName ?? `font-${sha8(bytes)}.${extOf(mime)}`
    } else if (JS_MIME.test(mime)) {
      kind = 'import'
      dir = 'imports'
      file = looseName ?? `script-${sha8(bytes)}.js`
    } else {
      kind = 'asset'
      dir = 'assets'
      file = looseName ?? `${extOf(mime)}-${sha8(bytes)}.${extOf(mime)}`
    }
    if (known) {
      if (known.kind !== kind)
        throw new IntakeError(
          `${page.file}: ${uuid} has the bytes of ${known.file} but a different kind (${kind} vs ${known.kind})`,
        )
      if (kind === 'font' && (known.family !== family || known.subset !== subset))
        throw new IntakeError(
          `${page.file}: font hash collision across (${family}/${subset}) and (${known.family}/${known.subset})`,
        )
      file = known.file
    } else if (kind !== 'runtime' && kind !== 'react') {
      file = uniqueName(reg, `${dir}/${file}`).slice(dir.length + 1)
    }
    const logical =
      kind === 'font'
        ? `/fonts/${file}`
        : kind === 'frame'
          ? `/frames/${file}`
          : kind === 'runtime' || kind === 'react'
            ? `/runtime/${file}`
            : `/assets/${file}`
    if (!known) {
      reg.bySha.set(sha, { kind, file, path: logical, family, subset })
      reg.taken.add(`${dir}/${file}`)
    }
    resources.push({ uuid, kind, mime, bytes, sha256: sha, file, path: logical, family, subset, looseName })
  }

  // --- uuid references before rewriting: attributes (with tpl ids), css, logic, head, frame markers ---------------
  const refs: UuidRef[] = []
  const parsed = parseTemplate(xdcInner)
  walkEls(parsed.nodes, (el: ElNode) => {
    for (const a of el.attrs) {
      for (const r of resources) {
        if (a.value.includes(r.uuid)) {
          refs.push({
            uuid: r.uuid,
            where: a.value.includes('about:blank#' + r.uuid) ? 'frame-marker' : 'attribute',
            tag: el.tag,
            attr: a.name,
            tpl: el.tpl,
          })
        }
      }
    }
    if (el.tag === 'style') {
      const css = textOfNodes(el.children)
      for (const r of resources)
        if (css.includes(r.uuid)) refs.push({ uuid: r.uuid, where: 'css', tpl: el.tpl })
    }
  })
  const xdcStart = template.indexOf('<x-dc')
  const xdcEnd = template.indexOf('</x-dc>')
  if (xdcStart < 0 || xdcEnd < 0)
    throw new IntakeError(`${page.file}: <x-dc> markers not found in the raw template`)
  const headPart = template.slice(0, xdcStart)
  for (const r of resources) {
    if (logicRaw.includes(r.uuid)) refs.push({ uuid: r.uuid, where: 'logic' })
    if (headPart.includes(r.uuid)) refs.push({ uuid: r.uuid, where: 'head' })
  }

  // --- rewrite uuids once, in the whole document (head, template, logic, trailing markup) --------------------------
  const rewrite = (s: string): string => {
    for (const r of resources) {
      s = s.split('about:blank#' + r.uuid).join(r.path)
      s = s.split(r.uuid).join(r.path)
    }
    return s
  }
  template = rewrite(template)
  const doc2 = parse(template)
  let xdc2: El | undefined
  let logic2: El | undefined
  let headEl: El | undefined
  walk(doc2 as unknown as P5, (e) => {
    if (e.tagName === 'x-dc' && !xdc2) xdc2 = e
    if (e.tagName === 'script' && attr(e, 'data-dc-script') !== undefined && !logic2) logic2 = e
    if (e.tagName === 'head' && !headEl) headEl = e
  })
  const templateHtml = serialize(xdc2 as unknown as DefaultTreeAdapterMap['parentNode'])
  const logic = logic2 ? textOf(logic2) : ''
  const head = headEl ? serialize(headEl as unknown as DefaultTreeAdapterMap['parentNode']) : ''
  for (const r of resources) {
    for (const [what, s] of [
      ['template', templateHtml],
      ['logic', logic],
      ['head', head],
    ] as const) {
      if (s.includes(r.uuid))
        throw new IntakeError(`${page.file}: uuid ${r.uuid} still present in ${what} after rewriting`)
    }
  }
  const referenced = new Set(refs.map((r) => r.uuid))
  const unreferenced = resources
    .filter((r) => !referenced.has(r.uuid) && r.kind !== 'react')
    .map((r) => r.uuid)

  // --- helmet: styles in order, links/metas, scripts, atomics flag ------------------------------------------------
  const frag = parseFragment(templateHtml)
  const helmetEls: El[] = []
  walk(frag as unknown as P5, (e) => {
    if (e.tagName === 'helmet' || e.tagName === 'sc-helmet') helmetEls.push(e)
  })
  const helmets: HelmetSheet[] = []
  const helmetLinks: HelmetLink[] = []
  let helmetScripts = 0
  let helmetAtomics = false
  if (helmetEls.length > 1)
    throw new IntakeError(`${page.file}: ${helmetEls.length} <helmet> elements (expected at most one)`)
  const helmet = helmetEls[0]
  if (helmet) {
    helmetAtomics = attr(helmet, 'data-dc-atomics') !== undefined
    let i = 0
    for (const c of helmet.childNodes) {
      if (!isEl(c)) continue
      if (c.tagName === 'style') {
        const css = textOf(c)
        helmets.push({
          index: i,
          file: `helmet.${i}.css`,
          fontFace: css.includes('@font-face'),
          chars: css.length,
          css,
        })
        i++
      } else if (c.tagName === 'link' || c.tagName === 'meta') {
        helmetLinks.push({ tag: c.tagName, attrs: Object.fromEntries(c.attrs.map((a) => [a.name, a.value])) })
      } else if (c.tagName === 'script') helmetScripts++
    }
  }

  // --- x-imports ---------------------------------------------------------------------------------------------------
  const xImports: XImportInfo[] = []
  const rewritten = parseTemplate(templateHtml)
  const byPath = new Map(resources.map((r) => [r.path, r]))
  // Note: a self-closing <x-import .../> is an OPEN tag to the HTML parser (the browser's and parse5's alike), so the
  // following siblings become its children in the serialized innerHTML; the runtime sees exactly that.
  walkEls(rewritten.nodes, (el) => {
    if (el.tag !== 'x-import') return
    const get = (n: string) => el.attrs.find((a) => a.name === n)?.value
    const globalName = get('component-from-global-scope') || ''
    const component = get('component') || get('name') || ''
    const fromRaw = get('from') || (globalName ? '' : get('src') || get('import') || '')
    const from = fromRaw.trim() ? fromRaw.trim().split(/\s+/) : []
    xImports.push({
      tpl: el.tpl,
      from,
      url: from.length ? from[from.length - 1]! : '',
      component,
      globalName,
      hintSize: get('hint-size') ?? null,
      children: el.children.filter((c) => c.kind === 'el').length,
      unresolved: from.filter((u) => !byPath.has(u)),
    })
  })

  // --- meta ----------------------------------------------------------------------------------------------------------
  let dataProps: Record<string, unknown> | null = null
  let preview: Record<string, unknown> | null = null
  if (dataPropsRaw) {
    try {
      const obj = JSON.parse(dataPropsRaw) as Record<string, unknown>
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        preview =
          obj.$preview && typeof obj.$preview === 'object' ? (obj.$preview as Record<string, unknown>) : null
        const rest: Record<string, unknown> = {}
        for (const k of Object.keys(obj)) if (k[0] !== '$') rest[k] = obj[k]
        dataProps = Object.keys(rest).length ? rest : null
      }
    } catch {
      dataProps = null
    }
  }
  const runtime = resources.find((r) => r.kind === 'runtime')
  const meta: PageMetaJson = {
    slug: page.slug,
    route: page.route,
    name: page.name,
    sourceFile: page.file,
    sourceSha256,
    dataProps,
    preview,
    label: templateHtml.match(/data-screen-label="([^"]*)"/)?.[1] ?? null,
    templateChars: templateHtml.length,
    logicChars: logic.length,
    helmets: helmets.map(({ css: _css, ...h }) => h),
    helmetLinks,
    helmetScripts,
    helmetAtomics,
    xImports: xImports.length,
    frames: resources.filter((r) => r.kind === 'frame').map((r) => r.file),
    runtimeSha256: runtime ? runtime.sha256 : null,
  }
  return {
    page,
    sourceSha256,
    resources,
    refs,
    head,
    template: templateHtml,
    logic,
    meta,
    helmets,
    xImports,
    unreferenced,
  }
}

export interface IntakeOptions {
  root: string
  pagesFile?: string
  outDir?: string
  log?: (line: string) => void
}

export interface IntakeResult {
  pages: Unpacked[]
  outDir: string
  files: string[]
}

/** Runs the intake for every page of pages.json and writes design/extracted/ (wholesale: the directory is replaced). */
export function runIntake(opts: IntakeOptions): IntakeResult {
  const { pages, designDir } = loadPages(opts.root, opts.pagesFile)
  const outDir = path.resolve(opts.root, opts.outDir ?? 'design/extracted')
  const log = opts.log ?? ((l: string) => console.log(l))
  const loose = readLooseFiles(path.join(designDir, 'original', 'loose'))
  const reg = newRegistry()
  const results: Unpacked[] = []
  for (const page of pages) {
    const file = path.join(designDir, page.file)
    if (!fs.existsSync(file)) throw new IntakeError(`${page.slug}: ${page.file} not found under design/`)
    results.push(unpackBundle(fs.readFileSync(file, 'utf8'), page, reg, loose))
  }
  const runtimes = new Set(results.map((r) => r.meta.runtimeSha256).filter(Boolean))
  if (runtimes.size > 1)
    throw new IntakeError(
      `the pages ship ${runtimes.size} different dc runtimes; the compiler mirrors exactly one`,
    )

  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
  const files: string[] = []
  const write = (rel: string, data: string | Buffer) => {
    const f = path.join(outDir, rel)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, data)
    files.push(rel)
  }
  const shared = new Map<string, Resource>()
  const fontFiles: Record<string, { sha256: string; family: string; subset: string; bytes: number }> = {}
  const assetFiles: Record<
    string,
    { sha256: string; mime: string; bytes: number; kind: ResourceKind; loose: string | null }
  > = {}
  const uuidToFilePerPage: Record<string, Record<string, string>> = {}
  const assetUuidPerPage: Record<string, Record<string, string>> = {}
  for (const r of results) {
    uuidToFilePerPage[r.page.slug] = {}
    assetUuidPerPage[r.page.slug] = {}
    for (const res of r.resources) {
      const rel =
        res.kind === 'font'
          ? `fonts/${res.file}`
          : res.kind === 'runtime' || res.kind === 'react'
            ? `runtime/${res.file}`
            : res.kind === 'frame'
              ? `frames/${res.file}`
              : res.kind === 'import'
                ? `imports/${res.file}`
                : `assets/${res.file}`
      if (!shared.has(rel)) {
        shared.set(rel, res)
        write(rel, res.bytes)
      } else if (shared.get(rel)!.sha256 !== res.sha256) {
        throw new IntakeError(
          `${rel}: two different contents across pages (${shared.get(rel)!.sha256.slice(0, 8)} vs ${res.sha256.slice(0, 8)})`,
        )
      }
      if (res.kind === 'font') {
        fontFiles[res.file] = {
          sha256: res.sha256,
          family: res.family ?? '',
          subset: res.subset ?? '',
          bytes: res.bytes.length,
        }
        uuidToFilePerPage[r.page.slug]![res.uuid] = res.file
      } else if (res.kind !== 'runtime' && res.kind !== 'react') {
        assetFiles[rel] = {
          sha256: res.sha256,
          mime: res.mime,
          bytes: res.bytes.length,
          kind: res.kind,
          loose: res.looseName ?? null,
        }
        assetUuidPerPage[r.page.slug]![res.uuid] = res.path
      }
    }
    const d = r.page.slug
    write(`${d}/head.html`, r.head)
    write(`${d}/template.html`, r.template)
    write(`${d}/logic.original.js`, r.logic)
    for (const h of r.helmets) write(`${d}/${h.file}`, h.css)
    write(`${d}/meta.json`, JSON.stringify(r.meta, null, 2) + '\n')
    write(`${d}/imports.json`, JSON.stringify(r.xImports, null, 2) + '\n')
    write(`${d}/refs.json`, JSON.stringify({ refs: r.refs, unreferenced: r.unreferenced }, null, 2) + '\n')
    log(
      `intake ${d}: template ${r.template.length} chars, logic ${r.logic.length} chars, ${r.helmets.length} helmet sheets, ${r.resources.length} resources (${r.resources.filter((x) => x.kind === 'font').length} fonts, ${r.xImports.length} x-imports${r.unreferenced.length ? `, ${r.unreferenced.length} unreferenced` : ''})`,
    )
  }
  write(
    'fonts/manifest.json',
    JSON.stringify({ files: sortKeys(fontFiles), uuidToFilePerPage }, null, 2) + '\n',
  )
  write(
    'assets.json',
    JSON.stringify({ files: sortKeys(assetFiles), uuidToPathPerPage: assetUuidPerPage }, null, 2) + '\n',
  )
  const runtimeRes = results.flatMap((r) => r.resources).find((x) => x.kind === 'runtime')
  write(
    'runtime/manifest.json',
    JSON.stringify(
      {
        runtimeSha256: runtimeRes ? runtimeRes.sha256 : null,
        react: Object.fromEntries(
          results
            .flatMap((r) => r.resources)
            .filter((x) => x.kind === 'react')
            .map((x) => [x.file, x.sha256]),
        ),
        pages: results.map((r) => r.page.slug),
      },
      null,
      2,
    ) + '\n',
  )
  return { pages: results, outDir, files: files.sort() }
}

const sortKeys = <T>(o: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

function main(argv: string[]): number {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  let pagesFile = 'design/pages.json'
  let outDir = 'design/extracted'
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--pages') pagesFile = argv[++i] ?? pagesFile
    else if (a.startsWith('--pages=')) pagesFile = a.slice(8)
    else if (a === '--out') outDir = argv[++i] ?? outDir
    else if (a.startsWith('--out=')) outDir = a.slice(6)
    else if (a === '-h' || a === '--help') {
      console.log('usage: tsx tools/intake/unpack.ts [--pages design/pages.json] [--out design/extracted]')
      return 0
    } else {
      console.error(`unknown argument ${a}`)
      return 2
    }
  }
  const r = runIntake({ root, pagesFile, outDir })
  console.log(
    `intake wrote ${r.files.length} files -> ${path.relative(root, r.outDir)} (run pnpm design:checksums)`,
  )
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (e) {
    if (e instanceof IntakeError) {
      console.error(`intake: ${e.message}`)
      process.exitCode = 2
    } else throw e
  }
}
