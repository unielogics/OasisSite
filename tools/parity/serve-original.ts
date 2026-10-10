import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { DEFAULT_ORIGINAL_PORT, DESIGN_DIR, PAGES, ROOT, THEMES, type Theme } from './config'
import { themeSwaps } from './theme-swap'
import type { PageSpec } from '../dc-compile/pages'
import { isBundledPage } from '../intake/raw'
import { PLACEHOLDER_SIZE, transparentPng } from '../prerender/placeholder'
import {
  applySwaps,
  checkSwapResults,
  extractTemplate,
  replaceTemplate,
  type SwapResult,
  type SwapSpec,
} from './bundle'

export interface ServeOptions {
  /** Listen port. Default 4320; when it is busy the server falls back to an ephemeral port unless `strictPort`. */
  port?: number
  strictPort?: boolean
  /** Pages to serve (default: design/pages.json); `file` is relative to `dir`. */
  pages?: readonly PageSpec[]
  /** Directory the page files are relative to (default design/). */
  dir?: string
  /** Pre-render deviation swaps (text and attr), per page slug. */
  swapsBySlug?: Record<string, SwapSpec[]>
  /** Arbitrary source rewrite applied after the swaps; used by the sensitivity self-test to build a mutated "port". */
  transform?: (slug: string, template: string) => string
  /**
   * Per page and theme, the extra swaps that render the page in that theme (default: the DV-THEME swap of the data-props
   * default, tools/parity/theme-swap.ts). A theme with swaps is served as its own variant (`url(slug, hash, theme)`).
   */
  themeSwaps?: (slug: string, theme: Theme) => SwapSpec[]
}

export interface OriginalServer {
  origin: string
  port: number
  /**
   * URL of a page, rendered in `theme` when given (the DV-THEME variant; the query parameter is `run-theme`, never
   * `theme`, which support.js reads for its canvas background). The path name becomes the dc `data-sc-name` (stripped by
   * the DOM check).
   */
  url(slug: string, hash?: string, theme?: Theme): string
  swapResults: Record<string, SwapResult[]>
  close(): Promise<void>
}

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
}

/**
 * Builds the HTML served for a page: the untouched source unless swaps/transform apply. A Bundled Page's swaps operate
 * on its decoded `__bundler/template`; a RAW .dc.html document's swaps operate on the document text itself (the dc
 * runtime compiles the raw slice between <x-dc> and </x-dc> and evaluates the logic script from the same text).
 * Throws on stale swaps.
 */
export function buildBundle(
  slug: string,
  file: string,
  swaps: readonly SwapSpec[] = [],
  transform?: ServeOptions['transform'],
): { html: string; results: SwapResult[]; raw: boolean } {
  const html = fs.readFileSync(file, 'utf8')
  const raw = !isBundledPage(html)
  if (!swaps.length && !transform) return { html, results: [], raw }
  if (raw) {
    const swapped = applySwaps(html, swaps)
    checkSwapResults(slug, swapped.results)
    const final = transform ? transform(slug, swapped.template) : swapped.template
    return { html: final, results: swapped.results, raw }
  }
  const { template } = extractTemplate(html)
  const swapped = applySwaps(template, swaps)
  checkSwapResults(slug, swapped.results)
  const final = transform ? transform(slug, swapped.template) : swapped.template
  return { html: replaceTemplate(html, final), results: swapped.results, raw }
}

/**
 * Serves every page at /orig/<slug>.html. A raw document also needs what it references relatively: its loose files
 * (design/original/loose: ./support.js, ./image-slot.js) at /orig/<name>, its assets at /orig/assets/<name> (a
 * missing image, e.g. the logo the owner has not supplied, is answered with the build's placeholder so both sides
 * render the same bytes, DV-LOGO), and image-slot.js's `.image-slots.state.json` sidecar gets the 404 it gets in the
 * design tool's share view.
 */
export async function startOriginalServer(opts: ServeOptions = {}): Promise<OriginalServer> {
  const dir = opts.dir ?? DESIGN_DIR
  const pages = opts.pages ?? PAGES
  const html = new Map<string, string>()
  const swapResults: Record<string, SwapResult[]> = {}
  const themeOf = opts.themeSwaps ?? ((slug: string, theme: Theme) => themeSwaps(ROOT, slug, theme))
  let anyRaw = false
  for (const p of pages) {
    const base = opts.swapsBySlug?.[p.slug] ?? []
    const built = buildBundle(p.slug, path.join(dir, p.file), base, opts.transform)
    html.set(p.slug, built.html)
    swapResults[p.slug] = built.results
    anyRaw ||= built.raw
    for (const theme of THEMES) {
      const extra = themeOf(p.slug, theme)
      if (!extra.length) continue
      const variant = buildBundle(p.slug, path.join(dir, p.file), [...base, ...extra], opts.transform)
      html.set(`${p.slug}?${theme}`, variant.html)
      swapResults[`${p.slug}@${theme}`] = variant.results.slice(base.length)
    }
  }
  const looseDir = path.join(dir, 'original', 'loose')
  const placeholder = transparentPng(PLACEHOLDER_SIZE, PLACEHOLDER_SIZE)
  const serveFile = (res: http.ServerResponse, file: string): boolean => {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false
    res
      .writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      })
      .end(fs.readFileSync(file))
    return true
  }
  const server = http.createServer((req, res) => {
    const [pathname, query] = (req.url ?? '/').split('?') as [string, string | undefined]
    const m = /^\/orig\/([a-z0-9-]+)\.html$/.exec(pathname)
    const runTheme = new URLSearchParams(query ?? '').get('run-theme')
    const page = m ? (runTheme ? html.get(`${m[1]}?${runTheme}`) : undefined) ?? html.get(m[1]!) : undefined
    if (page) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page)
      return
    }
    if (anyRaw && pathname.startsWith('/orig/')) {
      let rel: string
      try {
        rel = decodeURIComponent(pathname.slice('/orig/'.length))
      } catch {
        rel = ''
      }
      if (rel && !rel.includes('..')) {
        if (rel.startsWith('assets/')) {
          if (serveFile(res, path.join(looseDir, rel))) return
          if (/\.png$/i.test(rel)) {
            res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }).end(placeholder)
            return
          }
        } else if (!rel.includes('/') && serveFile(res, path.join(looseDir, rel))) return
      }
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
  })
  const listen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
  try {
    await listen(opts.port ?? DEFAULT_ORIGINAL_PORT)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || opts.strictPort) throw err
    await listen(0)
  }
  const port = (server.address() as AddressInfo).port
  const origin = `http://127.0.0.1:${port}`
  return {
    origin,
    port,
    url: (slug, hash, theme) =>
      `${origin}/orig/${slug}.html${theme && html.has(`${slug}?${theme}`) ? `?run-theme=${theme}` : ''}${hash ? (hash.startsWith('#') ? hash : `#${hash}`) : ''}`,
    swapResults,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
