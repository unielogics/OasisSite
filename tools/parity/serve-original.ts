import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { DEFAULT_ORIGINAL_PORT, DESIGN_DIR, PAGES } from './config'
import type { PageSpec } from '../dc-compile/pages'
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
}

export interface OriginalServer {
  origin: string
  port: number
  /** URL of a page; the path name becomes the dc `data-sc-name` (stripped by the DOM check). */
  url(slug: string, hash?: string): string
  swapResults: Record<string, SwapResult[]>
  close(): Promise<void>
}

/** Builds the HTML served for a page: the untouched bundle unless swaps/transform apply. Throws on stale swaps. */
export function buildBundle(
  slug: string,
  file: string,
  swaps: readonly SwapSpec[] = [],
  transform?: ServeOptions['transform'],
): { html: string; results: SwapResult[] } {
  const html = fs.readFileSync(file, 'utf8')
  if (!swaps.length && !transform) return { html, results: [] }
  const { template } = extractTemplate(html)
  const swapped = applySwaps(template, swaps)
  checkSwapResults(slug, swapped.results)
  const final = transform ? transform(slug, swapped.template) : swapped.template
  return { html: replaceTemplate(html, final), results: swapped.results }
}

export async function startOriginalServer(opts: ServeOptions = {}): Promise<OriginalServer> {
  const dir = opts.dir ?? DESIGN_DIR
  const pages = opts.pages ?? PAGES
  const html = new Map<string, string>()
  const swapResults: Record<string, SwapResult[]> = {}
  for (const p of pages) {
    const built = buildBundle(
      p.slug,
      path.join(dir, p.file),
      opts.swapsBySlug?.[p.slug] ?? [],
      opts.transform,
    )
    html.set(p.slug, built.html)
    swapResults[p.slug] = built.results
  }
  const server = http.createServer((req, res) => {
    const m = /^\/orig\/([a-z0-9-]+)\.html$/.exec((req.url ?? '/').split('?')[0]!)
    const page = m ? html.get(m[1]!) : undefined
    if (!page) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page)
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
    url: (slug, hash) =>
      `${origin}/orig/${slug}.html${hash ? (hash.startsWith('#') ? hash : `#${hash}`) : ''}`,
    swapResults,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
