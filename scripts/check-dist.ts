// check:dist — verifies a build against the contract in README.md: index.html with the marker, 404.html, robots.txt,
// sitemap.xml, manifest.json; hashed files only under assets/; well-formed HTML with <html lang> and a <title>; no
// executable inline <script>; no localhost/127.0.0.1; every internal link, script, stylesheet, image and font
// reference resolves to an emitted file; no bundle uuid left anywhere.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'parse5'
import type { DefaultTreeAdapterMap } from 'parse5'

type El = DefaultTreeAdapterMap['element']
type Node = DefaultTreeAdapterMap['node']

export interface CheckResult {
  ok: boolean
  problems: string[]
  files: number
  pages: string[]
}

const TOP_LEVEL = new Set(['index.html', '404.html', 'robots.txt', 'sitemap.xml', 'manifest.json'])
const HASHED = /^assets\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.[0-9a-f]{8}\.[a-z0-9]+$/
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const DATA_BLOCK_TYPES = new Set(['application/ld+json', 'application/json', 'importmap-ignored'])

function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isSymbolicLink()) out.push(rel + '@symlink')
    else if (e.isDirectory()) out.push(...listFiles(path.join(dir, e.name), rel))
    else out.push(rel)
  }
  return out
}

function walk(n: Node, f: (e: El) => void): void {
  if ('tagName' in n) f(n as El)
  for (const c of (n as { childNodes?: Node[] }).childNodes ?? []) walk(c, f)
}
const attr = (e: El, n: string) => e.attrs.find((a) => a.name === n)?.value

export function checkDist(dist: string, marker: string): CheckResult {
  const problems: string[] = []
  if (!fs.existsSync(dist)) return { ok: false, problems: [`${dist} does not exist`], files: 0, pages: [] }
  const files = listFiles(dist)
  const set = new Set(files)
  for (const req of TOP_LEVEL) if (!set.has(req)) problems.push(`missing ${req}`)
  for (const f of files) {
    if (f.endsWith('@symlink')) {
      problems.push(`${f.replace('@symlink', '')}: symbolic links are not allowed`)
      continue
    }
    if (TOP_LEVEL.has(f)) continue
    if (f.startsWith('assets/')) {
      if (!HASHED.test(f)) problems.push(`${f}: assets must be named <name>.<hash8>.<ext>`)
      continue
    }
    if (!/^(?:[a-z0-9-]+\/)+index\.html$/.test(f))
      problems.push(
        `${f}: unexpected top-level file (only routes/index.html, assets/ and the contract files)`,
      )
  }
  const resolves = (ref: string): boolean => {
    const clean = ref.split('#')[0]!.split('?')[0]!
    if (clean === '/' || clean === '') return set.has('index.html')
    const rel = clean.replace(/^\//, '')
    return set.has(rel) || set.has(rel.replace(/\/$/, '') + '/index.html') || set.has(rel + '.html')
  }
  const pages: string[] = []
  for (const f of files.filter((x) => x.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(dist, f), 'utf8')
    if (/localhost|127\.0\.0\.1/.test(html)) problems.push(`${f}: contains localhost`)
    if (UUID.test(html)) problems.push(`${f}: contains a bundle uuid`)
    if (!/^<!DOCTYPE html>/i.test(html)) problems.push(`${f}: missing <!DOCTYPE html>`)
    const parseErrors: string[] = []
    const doc = parse(html, {
      onParseError: (e) => parseErrors.push(`${e.code}@${e.startLine}:${e.startCol}`),
    })
    if (parseErrors.length) problems.push(`${f}: HTML parse errors: ${parseErrors.slice(0, 5).join(', ')}`)
    let lang = false
    let title = false
    let dcRoot = 0
    walk(doc as unknown as Node, (e) => {
      if (e.tagName === 'html') lang = !!attr(e, 'lang')
      if (e.tagName === 'title') title = true
      if (e.tagName === 'div' && attr(e, 'id') === 'dc-root') dcRoot++
      if (e.tagName === 'script') {
        const src = attr(e, 'src')
        const type = (attr(e, 'type') ?? '').toLowerCase()
        if (!src && !DATA_BLOCK_TYPES.has(type))
          problems.push(`${f}: inline executable <script>${type ? ` type=${type}` : ''}`)
        if (src && !resolves(src)) problems.push(`${f}: script ${src} does not resolve`)
        if (src && !src.startsWith('/assets/')) problems.push(`${f}: script ${src} is not under /assets/`)
      }
      if (e.tagName === 'link') {
        const href = attr(e, 'href') ?? ''
        const rel = attr(e, 'rel') ?? ''
        if (/^(stylesheet|preload|icon|modulepreload)$/.test(rel) && !resolves(href))
          problems.push(`${f}: <link rel=${rel}> ${href} does not resolve`)
      }
      if (e.tagName === 'a') {
        const href = attr(e, 'href') ?? ''
        if (href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/api/') && !resolves(href))
          problems.push(`${f}: link ${href} does not resolve`)
      }
      for (const name of ['src', 'poster']) {
        const v = attr(e, name)
        if (v && e.tagName !== 'script' && v.startsWith('/') && !resolves(v))
          problems.push(`${f}: ${e.tagName} ${name}=${v} does not resolve`)
      }
    })
    if (!lang) problems.push(`${f}: <html> has no lang`)
    if (!title) problems.push(`${f}: no <title>`)
    if (f !== '404.html') {
      if (dcRoot !== 1) problems.push(`${f}: expected exactly one #dc-root, found ${dcRoot}`)
      pages.push(f)
    }
    if (f === 'index.html' && !html.includes(marker))
      problems.push(`index.html: marker text ${JSON.stringify(marker)} not found`)
  }
  for (const f of files.filter((x) => x.endsWith('.css') || x.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(dist, f), 'utf8')
    if (/https?:\/\/(localhost|127\.0\.0\.1)/.test(text)) problems.push(`${f}: contains localhost`)
    if (UUID.test(text) && f.endsWith('.css')) problems.push(`${f}: contains a bundle uuid`)
    for (const m of text.matchAll(/url\(["']?(\/(?:assets|fonts)\/[^"')]+)["']?\)/g))
      if (!resolves(m[1]!)) problems.push(`${f}: url(${m[1]}) does not resolve`)
  }
  if (set.has('manifest.json')) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8')) as {
      files?: Record<string, string>
      pages?: { file: string }[]
    }
    for (const [f] of Object.entries(manifest.files ?? {}))
      if (!set.has(f)) problems.push(`manifest.json lists ${f} which is missing`)
    for (const p of manifest.pages ?? [])
      if (!set.has(p.file)) problems.push(`manifest.json page ${p.file} is missing`)
  }
  return { ok: problems.length === 0, problems, files: files.length, pages }
}

function main(argv: string[]): number {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  let dist = 'dist'
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--dist') dist = argv[++i] ?? dist
    else if (a.startsWith('--dist=')) dist = a.slice(7)
    else {
      console.error(`unknown argument ${a}`)
      return 2
    }
  }
  const marker = (
    JSON.parse(fs.readFileSync(path.join(root, 'site.config.json'), 'utf8')) as { marker: string }
  ).marker
  const r = checkDist(path.resolve(root, dist), marker)
  if (!r.ok) {
    console.error(`check:dist FAILED (${r.problems.length} problem(s)):\n  ${r.problems.join('\n  ')}`)
    return 1
  }
  console.log(`check:dist OK (${r.files} files, ${r.pages.length} page(s): ${r.pages.join(', ')})`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2))
