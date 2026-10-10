// intake:fonts — self-hosts the Google Fonts a design links from its helmet. Run ONCE at intake (it is the only step
// of the pipeline that talks to the network): for every `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?…">`
// in design/pages.json's pages it downloads the CSS exactly as Google serves it to a current Chrome (variable fonts,
// unicode-range subsets, the wdth/wght axes the query asks for) and every woff2 the CSS references, and writes
// design/fonts/: google-<n>.css (verbatim), <family>-<subset>[-<weight>][-<style>].woff2 and manifest.json (query URL,
// every file's source URL, sha256 and @font-face descriptors). `pnpm intake` then builds helmet.fonts.css from it and
// never fetches anything; the built site makes no external request at all (DEVIATIONS.md DV-FONTS).
// Usage: tsx tools/intake/fonts.ts [--pages design/pages.json] [--out design/fonts] [--force]
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { parse } from 'parse5'
import type { DefaultTreeAdapterMap } from 'parse5'
import { loadPages } from '../dc-compile/pages'

type El = DefaultTreeAdapterMap['element']
type P5 = DefaultTreeAdapterMap['node']

/** A current desktop Chrome: Google serves the woff2 + unicode-range form of the CSS to it. Pinned, so the download is reproducible. */
export const FONT_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'

export interface FontFace {
  family: string
  subset: string
  style: string
  weight: string
  stretch: string | null
  display: string | null
  url: string
  unicodeRange: string | null
}

export interface FontFileEntry {
  url: string
  sha256: string
  bytes: number
  family: string
  subset: string
  weight: string
  style: string
  stretch: string | null
}

export interface FontsManifest {
  /** the helmet <link> hrefs the CSS files were fetched for, in page order */
  sources: { href: string; css: string; sha256: string; faces: number; fetchedAt: string; userAgent: string }[]
  files: Record<string, FontFileEntry>
}

const sha256 = (b: Buffer | string): string => crypto.createHash('sha256').update(b).digest('hex')
const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/** Every @font-face block of a Google Fonts stylesheet with the subset comment (e.g. "latin") that precedes it. */
export function parseFontFaces(css: string): FontFace[] {
  const out: FontFace[] = []
  const re = /(?:\/\*\s*([\w-]+)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css))) {
    const body = m[2]!
    const prop = (name: string): string | null => {
      const r = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'i').exec(body)
      return r ? r[1]!.trim() : null
    }
    const src = prop('src') ?? ''
    const url = /url\((["']?)([^"')]+)\1\)/.exec(src)?.[2]
    if (!url) continue
    out.push({
      family: (prop('font-family') ?? '').replace(/^['"]|['"]$/g, ''),
      subset: m[1] ?? '',
      style: prop('font-style') ?? 'normal',
      weight: prop('font-weight') ?? '400',
      stretch: prop('font-stretch'),
      display: prop('font-display'),
      url,
      unicodeRange: prop('unicode-range'),
    })
  }
  return out
}

/** Stable file names: family-subset, plus the weight and style when a family/subset pair has several faces. */
export function fileNamesFor(faces: FontFace[]): Map<string, string> {
  const byUrl = new Map<string, string>()
  const groups = new Map<string, FontFace[]>()
  for (const f of faces) {
    const k = `${slugify(f.family)}|${f.subset}`
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(f)
  }
  const taken = new Set<string>()
  for (const f of faces) {
    if (byUrl.has(f.url)) continue
    const group = groups.get(`${slugify(f.family)}|${f.subset}`)!
    const distinctUrls = new Set(group.map((g) => g.url)).size
    let stem = `${slugify(f.family)}${f.subset ? '-' + f.subset : ''}`
    if (distinctUrls > 1) {
      stem += `-${f.weight.replace(/\s+/g, '-')}`
      if (f.style !== 'normal') stem += `-${f.style}`
    }
    let name = `${stem}.woff2`
    for (let i = 2; taken.has(name); i++) name = `${stem}-${i}.woff2`
    taken.add(name)
    byUrl.set(f.url, name)
  }
  return byUrl
}

/** The helmet stylesheet links of a page that point at Google Fonts. */
export function googleFontLinks(pageHtml: string): string[] {
  const doc = parse(pageHtml)
  const hrefs: string[] = []
  const walk = (n: P5): void => {
    if ('tagName' in n) {
      const e = n as El
      if (e.tagName === 'link') {
        const rel = (e.attrs.find((a) => a.name === 'rel')?.value ?? '').toLowerCase()
        const href = e.attrs.find((a) => a.name === 'href')?.value ?? ''
        if (rel.split(/\s+/).includes('stylesheet') && /^https:\/\/fonts\.googleapis\.com\//.test(href))
          hrefs.push(href)
      }
    }
    for (const c of (n as { childNodes?: P5[] }).childNodes ?? []) walk(c)
  }
  walk(doc as unknown as P5)
  return hrefs
}

/** Rewrites every gstatic url() of a Google CSS to /fonts/<file> (the logical path the build hashes). */
export function localizeFontCss(css: string, byUrl: ReadonlyMap<string, string>): string {
  return css.replace(/url\((["']?)([^"')]+)\1\)/g, (whole, _q: string, url: string) => {
    const file = byUrl.get(url)
    return file ? `url(/fonts/${file})` : whole
  })
}

export interface FontsIntakeOptions {
  root: string
  pagesFile?: string
  outDir?: string
  force?: boolean
  fetchImpl?: typeof fetch
  log?: (line: string) => void
}

export async function runFontsIntake(o: FontsIntakeOptions): Promise<FontsManifest> {
  const log = o.log ?? ((l: string) => console.log(l))
  const f = o.fetchImpl ?? fetch
  const { pages, designDir } = loadPages(o.root, o.pagesFile)
  const outDir = path.resolve(o.root, o.outDir ?? 'design/fonts')
  if (fs.existsSync(path.join(outDir, 'manifest.json')) && !o.force)
    throw new Error(`${path.relative(o.root, outDir)}/manifest.json exists: the fonts were vendored already (--force re-downloads)`)
  const hrefs: string[] = []
  for (const p of pages) {
    const html = fs.readFileSync(path.join(designDir, p.file), 'utf8')
    for (const h of googleFontLinks(html)) if (!hrefs.includes(h)) hrefs.push(h)
  }
  if (!hrefs.length) throw new Error('no Google Fonts stylesheet link in any page helmet; nothing to vendor')
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
  const manifest: FontsManifest = { sources: [], files: {} }
  const fetchedAt = new Date().toISOString()
  for (let i = 0; i < hrefs.length; i++) {
    const href = hrefs[i]!
    const res = await f(href, { headers: { 'user-agent': FONT_UA, accept: 'text/css,*/*;q=0.1' } })
    if (!res.ok) throw new Error(`${href}: HTTP ${res.status}`)
    const css = await res.text()
    const faces = parseFontFaces(css)
    if (!faces.length) throw new Error(`${href}: no @font-face block in the response (wrong user agent?)`)
    const names = fileNamesFor(faces)
    const cssFile = `google-${i}.css`
    fs.writeFileSync(path.join(outDir, cssFile), css)
    manifest.sources.push({ href, css: cssFile, sha256: sha256(css), faces: faces.length, fetchedAt, userAgent: FONT_UA })
    for (const face of faces) {
      const file = names.get(face.url)!
      if (manifest.files[file]) continue
      const r = await f(face.url, { headers: { 'user-agent': FONT_UA } })
      if (!r.ok) throw new Error(`${face.url}: HTTP ${r.status}`)
      const bytes = Buffer.from(await r.arrayBuffer())
      if (bytes.subarray(0, 4).toString('latin1') !== 'wOF2') throw new Error(`${face.url}: not a woff2 file`)
      fs.writeFileSync(path.join(outDir, file), bytes)
      manifest.files[file] = {
        url: face.url,
        sha256: sha256(bytes),
        bytes: bytes.length,
        family: face.family,
        subset: face.subset,
        weight: face.weight,
        style: face.style,
        stretch: face.stretch,
      }
      log(`fonts: ${file} ${bytes.length} B (${face.family} ${face.subset} ${face.weight}${face.stretch ? ' ' + face.stretch : ''})`)
    }
  }
  manifest.files = Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => (a < b ? -1 : 1)))
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  log(`fonts: ${Object.keys(manifest.files).length} files from ${hrefs.length} stylesheet(s) -> ${path.relative(o.root, outDir)} (run pnpm design:checksums)`)
  return manifest
}

/** The vendored fonts of a helmet stylesheet href, or null when design/fonts does not cover it. */
export function vendoredFonts(
  fontsDir: string,
  href: string,
): { css: string; localCss: string; files: Record<string, FontFileEntry> } | null {
  const file = path.join(fontsDir, 'manifest.json')
  if (!fs.existsSync(file)) return null
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as FontsManifest
  const src = manifest.sources.find((s) => s.href === href)
  if (!src) return null
  const css = fs.readFileSync(path.join(fontsDir, src.css), 'utf8')
  const byUrl = new Map<string, string>()
  const files: Record<string, FontFileEntry> = {}
  for (const face of parseFontFaces(css)) {
    const entry = Object.entries(manifest.files).find(([, e]) => e.url === face.url)
    if (!entry) throw new Error(`design/fonts/manifest.json has no file for ${face.url} (re-run pnpm intake:fonts)`)
    byUrl.set(face.url, entry[0])
    files[entry[0]] = entry[1]
  }
  return { css, localCss: localizeFontCss(css, byUrl), files }
}

async function main(argv: string[]): Promise<number> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  let pagesFile: string | undefined
  let outDir: string | undefined
  let force = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const eq = a.indexOf('=')
    const key = eq > 0 ? a.slice(0, eq) : a
    const val = () => (eq > 0 ? a.slice(eq + 1) : argv[++i]) ?? ''
    if (key === '--pages') pagesFile = val()
    else if (key === '--out') outDir = val()
    else if (key === '--force') force = true
    else {
      console.error(`unknown argument ${a}`)
      return 2
    }
  }
  await runFontsIntake({ root, pagesFile, outDir, force })
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error(e instanceof Error ? e.message : e)
      process.exit(1)
    },
  )
}
