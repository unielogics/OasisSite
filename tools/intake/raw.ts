// intake for a RAW .dc.html document (what Claude Design saves for a project, as opposed to a "Bundled Page"):
//   <head> … <script src="./support.js"> … </head>  the dc runtime, loaded by the document itself
//   <x-dc><helmet>meta/title/link/script/style</helmet> template …</x-dc>
//   <script type="text/x-dc" data-dc-script data-props="…">class Component extends DCLogic …</script>
// The runtime boots it twice: first from `<x-dc>.innerHTML` (the browser's body parse), then — when no bundler
// resource map exists — from a re-fetch of the page's own source, slicing the text between the <x-dc> open tag and the
// LAST </x-dc> (parseDcText). The second compile is the one that stays mounted, so the intake takes the same raw
// slice as the template. Resources are the loose files beside the document (design/original/loose: the runtime,
// helmet scripts, assets/<file>); relative references in the template, the head and the logic are rewritten once to
// the logical paths the build hashes (/assets/<file>, /runtime/dc-runtime.js). A referenced file that does not exist
// yet (the logo the owner has not supplied) is recorded as `missing`; the build substitutes a placeholder (DV-LOGO).
// Google Fonts stylesheets linked from the helmet come from design/fonts (pnpm intake:fonts) as helmet.fonts.N.css.
import fs from 'node:fs'
import path from 'node:path'
import { parse, serialize } from 'parse5'
import type { DefaultTreeAdapterMap } from 'parse5'
import { parseTemplate, walkEls, textOf as textOfNodes } from '../dc-compile/parse'
import type { PageSpec } from '../dc-compile/pages'
import { vendoredFonts } from './fonts'
import {
  IntakeError,
  describePage,
  newRegistry,
  sha256,
  type FontSheet,
  type LooseFile,
  type NameRegistry,
  type Resource,
  type ResourceKind,
  type Unpacked,
  type UuidRef,
} from './unpack'

type El = DefaultTreeAdapterMap['element']
type P5 = DefaultTreeAdapterMap['node']

const isEl = (n: P5): n is El => 'tagName' in n
const attr = (e: El, name: string): string | undefined => e.attrs.find((a) => a.name === name)?.value
const textOf = (e: El): string =>
  (e.childNodes as { nodeName: string; value?: string }[]).map((c) => c.value ?? '').join('')

function walk(n: P5, f: (e: El) => void): void {
  if (isEl(n)) f(n)
  for (const k of (n as { childNodes?: P5[] }).childNodes ?? []) walk(k, f)
}

export function isBundledPage(raw: string): boolean {
  return /<script type="__bundler\/(manifest|template)">/.test(raw)
}

export const RUNTIME_MARKER = '// src/boot.ts'

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
  woff2: 'font/woff2',
  woff: 'font/woff',
  mp4: 'video/mp4',
  webm: 'video/webm',
}
const mimeOf = (file: string): string => MIME_BY_EXT[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream'
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico)$/i

/** A relative reference: no scheme, not protocol-relative, not absolute, not a fragment, not a template binding. */
export function isLocalRef(v: string): boolean {
  const s = v.trim()
  if (!s || s.includes('{{')) return false
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#|\?)/i.test(s)) return false
  return /^[A-Za-z0-9_./ -]+$/.test(s)
}
const normalizeRef = (v: string): string => v.trim().replace(/^(\.\/)+/, '')

export interface RawOptions {
  /** design/original/loose */
  looseDir: string
  /** design/fonts (pnpm intake:fonts) */
  fontsDir: string
}

interface RefHit {
  text: string
  where: UuidRef['where']
  tag?: string
  attr?: string
  tpl?: number
}

export function unpackRawDocument(
  raw: string,
  page: PageSpec,
  reg: NameRegistry = newRegistry(),
  loose: LooseFile[] = [],
  o: RawOptions,
): Unpacked {
  const sourceSha256 = sha256(raw)
  const open = /<x-dc(?:\s[^>]*)?>/.exec(raw)
  if (!open) throw new IntakeError(`${page.file}: no <x-dc> in the document`)
  const close = raw.lastIndexOf('</x-dc>')
  if (close < 0 || close < open.index) throw new IntakeError(`${page.file}: <x-dc> is not closed`)
  let template = raw.slice(open.index + open[0].length, close)

  const doc = parse(raw)
  let headEl: El | undefined
  let logicEl: El | undefined
  walk(doc as unknown as P5, (e) => {
    if (e.tagName === 'head' && !headEl) headEl = e
    if (e.tagName === 'script' && attr(e, 'data-dc-script') !== undefined && !logicEl) logicEl = e
  })
  let head = headEl ? serialize(headEl as unknown as DefaultTreeAdapterMap['parentNode']) : ''
  let logic = logicEl ? textOf(logicEl) : ''
  const dataPropsRaw = logicEl ? attr(logicEl, 'data-props') : undefined

  // --- references: template attributes and style url(), head script src, quoted strings in the logic -------------
  const hits: RefHit[] = []
  const parsed = parseTemplate(template)
  walkEls(parsed.nodes, (el) => {
    for (const a of el.attrs) {
      if (!['src', 'href', 'poster', 'from', 'data-src'].includes(a.name)) continue
      if (isLocalRef(a.value)) hits.push({ text: a.value, where: 'attribute', tag: el.tag, attr: a.name, tpl: el.tpl })
    }
    if (el.tag === 'style') {
      const css = textOfNodes(el.children)
      for (const m of css.matchAll(/url\((["']?)([^"')]+)\1\)/g))
        if (isLocalRef(m[2]!)) hits.push({ text: m[2]!, where: 'css', tpl: el.tpl })
    }
  })
  if (headEl) {
    walk(headEl as unknown as P5, (e) => {
      for (const a of e.attrs)
        if ((a.name === 'src' || a.name === 'href') && isLocalRef(a.value))
          hits.push({ text: a.value, where: 'head', tag: e.tagName, attr: a.name })
    })
  }
  const distinct = [...new Set(hits.map((h) => normalizeRef(h.text)))]
  for (const t of distinct) {
    for (const q of ['"', "'", '`'])
      if (logic.includes(q + t + q) || logic.includes(q + './' + t + q)) hits.push({ text: t, where: 'logic' })
  }

  // --- resources: every distinct reference resolved against the loose files ---------------------------------------
  const looseFile = (rel: string): string | null => {
    const f = path.join(o.looseDir, rel)
    return fs.existsSync(f) && fs.statSync(f).isFile() ? f : null
  }
  const resources: Resource[] = []
  const byRef = new Map<string, Resource>()
  const runtimeFile = loose.find((l) => {
    const f = looseFile(l.name)
    return f && /\.js$/i.test(l.name) && fs.readFileSync(f, 'utf8').includes(RUNTIME_MARKER)
  })
  for (const ref of distinct) {
    const base = path.posix.basename(ref)
    const candidate = looseFile(ref) ?? looseFile(base) ?? looseFile(path.posix.join('assets', base))
    const isRuntime = !!runtimeFile && (ref === runtimeFile.name || base === runtimeFile.name)
    let kind: ResourceKind
    let dir: string
    let file: string
    let bytes: Buffer
    let missing = false
    if (isRuntime) {
      kind = 'runtime'
      dir = 'runtime'
      file = 'dc-runtime.js'
      bytes = fs.readFileSync(candidate ?? looseFile(runtimeFile!.name)!)
    } else if (candidate) {
      bytes = fs.readFileSync(candidate)
      if (/\.(m?js)$/i.test(base)) {
        kind = 'script'
        dir = 'scripts'
      } else {
        kind = 'asset'
        dir = 'assets'
      }
      file = base
    } else if (IMAGE_EXT.test(base)) {
      kind = 'asset'
      dir = 'assets'
      file = base
      bytes = Buffer.alloc(0)
      missing = true
    } else {
      throw new IntakeError(`${page.file}: reference ${JSON.stringify(ref)} has no file under design/original/loose`)
    }
    const sha = sha256(bytes)
    const known = missing ? undefined : reg.bySha.get(sha)
    if (known) file = known.file
    else if (kind !== 'runtime') {
      if (reg.taken.has(`${dir}/${file}`))
        throw new IntakeError(`${page.file}: two different files want the name ${dir}/${file}`)
    }
    const logical = kind === 'runtime' ? `/runtime/${file}` : `/assets/${file}`
    if (!known && !missing) {
      reg.bySha.set(sha, { kind, file, path: logical })
      reg.taken.add(`${dir}/${file}`)
    }
    const res: Resource = {
      uuid: ref,
      kind,
      mime: mimeOf(file),
      bytes,
      sha256: missing ? '' : sha,
      file,
      path: logical,
      looseName: candidate ? path.relative(o.looseDir, candidate) : undefined,
      missing,
    }
    resources.push(res)
    byRef.set(ref, res)
  }

  // --- fonts: vendored Google Fonts stylesheets for the helmet's <link rel=stylesheet> --------------------------------
  const fontSheets: (FontSheet & { css: string })[] = []
  const helmetFrag = parseTemplate(template)
  let n = 0
  walkEls(helmetFrag.nodes, (el, parent) => {
    if (el.tag !== 'link' || parent?.tag !== 'sc-helmet') return
    const rel = (el.attrs.find((a) => a.name === 'rel')?.value ?? '').toLowerCase().split(/\s+/)
    const href = el.attrs.find((a) => a.name === 'href')?.value ?? ''
    if (!rel.includes('stylesheet') || !/^https:\/\/fonts\.googleapis\.com\//.test(href)) return
    const v = vendoredFonts(o.fontsDir, href)
    if (!v)
      throw new IntakeError(
        `${page.file}: the helmet links ${href} but design/fonts does not cover it (run pnpm intake:fonts once, then pnpm design:checksums)`,
      )
    const files: string[] = []
    for (const [file, e] of Object.entries(v.files)) {
      const bytes = fs.readFileSync(path.join(o.fontsDir, file))
      if (sha256(bytes) !== e.sha256)
        throw new IntakeError(`design/fonts/${file} does not match its manifest sha256`)
      const known = reg.bySha.get(e.sha256)
      if (!known) {
        reg.bySha.set(e.sha256, { kind: 'font', file, path: `/fonts/${file}`, family: e.family, subset: e.subset })
        reg.taken.add(`fonts/${file}`)
      }
      resources.push({
        uuid: e.url,
        kind: 'font',
        mime: 'font/woff2',
        bytes,
        sha256: e.sha256,
        file,
        path: `/fonts/${file}`,
        family: e.family,
        subset: e.subset,
      })
      files.push(file)
    }
    fontSheets.push({ file: `helmet.fonts.${n}.css`, href, chars: v.localCss.length, files, css: v.localCss })
    n++
  })

  // --- rewrite every reference once: attribute values, url(), head, quoted logic strings ---------------------------
  const refs: UuidRef[] = hits.map((h) => ({ uuid: normalizeRef(h.text), where: h.where, tag: h.tag, attr: h.attr, tpl: h.tpl }))
  const rewriteText = (s: string, where: 'template' | 'head' | 'logic'): string => {
    for (const [ref, res] of byRef) {
      const forms = [...new Set([ref, './' + ref])]
      for (const form of forms) {
        if (where === 'logic') {
          for (const q of ['"', "'", '`']) s = s.split(q + form + q).join(q + res.path + q)
        } else {
          s = s.replace(new RegExp(`(=\\s*)(["'])${escapeRe(form)}\\2`, 'g'), `$1$2${res.path}$2`)
          s = s.replace(new RegExp(`url\\((["']?)${escapeRe(form)}\\1\\)`, 'g'), `url(${res.path})`)
        }
      }
    }
    return s
  }
  template = rewriteText(template, 'template')
  head = rewriteText(head, 'head')
  logic = rewriteText(logic, 'logic')
  const referenced = new Set(refs.map((r) => r.uuid))
  const unreferenced = resources.filter((r) => r.kind !== 'font' && !referenced.has(r.uuid)).map((r) => r.uuid)

  return describePage({
    page,
    source: 'raw',
    sourceSha256,
    resources,
    refs,
    head,
    templateHtml: template,
    logic,
    dataPropsRaw,
    unreferenced,
    fontSheets,
  })
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
