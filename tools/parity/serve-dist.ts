// serve:dist — a static server with the production nginx semantics the site relies on: clean URLs
// (/x -> x/index.html or x.html), 404.html for misses, immutable caching under /assets/, no-cache HTML, and fixture
// GET /api/v1/public/{hours,availability,catalog} (--hours design|alt) so hydration and the refreshes can be exercised offline.
// Usage: tsx tools/parity/serve-dist.ts [--dir dist] [--port 3301] [--hours design|alt]
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { DEFAULT_DIST_PORT, FIXED_NOW, ROOT, TIMEZONE } from './config'
import { designAvailability } from '../../src/site/availability'
import { hoursTable } from '../../src/site/hours'
import { validatePublicHours } from '../../src/hours/format'
import { designCatalog } from '../site/catalog-fixture'

export type HoursFixture = 'design' | 'alt'

export interface DistServerOptions {
  dir?: string
  port?: number
  strictPort?: boolean
  hours?: HoursFixture
  /** extra latency for the hours endpoint (ms), to exercise the client timeout */
  hoursDelayMs?: number
  /** fail the hours endpoint (status 503) */
  hoursFail?: boolean
}

export interface DistServer {
  origin: string
  port: number
  url(route: string, hash?: string): string
  /** number of hours requests served so far */
  hoursRequests(): number
  close(): Promise<void>
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

export function hoursFixture(kind: HoursFixture): string {
  const file =
    kind === 'alt'
      ? path.join(ROOT, 'tools/parity/fixtures/hours.alt.json')
      : path.join(ROOT, 'src/data/hours.fallback.json')
  return fs.readFileSync(file, 'utf8')
}

/**
 * The catalog the harness answers with (DV-CATALOG): the design's own content in the backend's shape after the
 * website-catalog seed (tools/site/catalog-fixture.ts), the same snapshot `pnpm build:parity` bakes, so the port's
 * catalog-driven content must equal the original and the refresh after mount changes nothing.
 */
export function catalogFixture(): string {
  return JSON.stringify(designCatalog(new Date(FIXED_NOW).toISOString()))
}

/**
 * The availability the harness answers with: the design's own generated pattern at the frozen instant over the hours
 * fixture (Sunday closed), exactly what `pnpm build:parity` bakes (tools/parity/build-parity.ts), so a refresh after
 * mount changes nothing. `service`/`addons` are accepted and ignored (the pattern does not depend on them).
 */
export function availabilityFixture(kind: HoursFixture, days = 5, now = new Date(FIXED_NOW)): string {
  const hours = validatePublicHours(JSON.parse(hoursFixture(kind)))
  // the design's pattern is seeded by the LOCAL date and filtered by the local time of day: the shop's zone
  const prev = process.env.TZ
  process.env.TZ = TIMEZONE
  try {
    return JSON.stringify(designAvailability(now, hoursTable(hours), { days, tz: hours.tz }))
  } finally {
    if (prev === undefined) delete process.env.TZ
    else process.env.TZ = prev
  }
}

export async function startDistServer(opts: DistServerOptions = {}): Promise<DistServer> {
  const dir = path.resolve(ROOT, opts.dir ?? 'dist')
  if (!fs.existsSync(path.join(dir, 'index.html'))) throw new Error(`${dir} has no index.html (build first)`)
  const hoursBody = hoursFixture(opts.hours ?? 'design')
  let hoursRequests = 0
  const resolveFile = (urlPath: string): { file: string; status: number } | null => {
    let p: string
    try {
      p = decodeURIComponent(urlPath)
    } catch {
      return null
    }
    if (p.includes('..') || p.includes('\0')) return null
    const rel = p.replace(/^\/+/, '')
    const candidates =
      rel === '' ? ['index.html'] : [rel, rel.replace(/\/$/, '') + '/index.html', rel + '.html']
    for (const c of candidates) {
      const f = path.join(dir, c)
      if (f.startsWith(dir) && fs.existsSync(f) && fs.statSync(f).isFile()) return { file: f, status: 200 }
    }
    return null
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/api/v1/public/hours') {
      hoursRequests++
      const send = () => {
        if (opts.hoursFail) {
          res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"unavailable"}')
          return
        }
        res
          .writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'public, max-age=60',
          })
          .end(hoursBody)
      }
      if (opts.hoursDelayMs) setTimeout(send, opts.hoursDelayMs)
      else send()
      return
    }
    if (url.pathname === '/api/v1/public/availability') {
      const days = Math.max(1, Math.min(14, Number(url.searchParams.get('days') ?? '5') || 5))
      res
        .writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' })
        .end(availabilityFixture(opts.hours ?? 'design', days))
      return
    }
    if (url.pathname === '/api/v1/public/catalog') {
      res
        .writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' })
        .end(catalogFixture())
      return
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/hooks/')) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
      return
    }
    const hit = resolveFile(url.pathname)
    if (!hit) {
      const nf = path.join(dir, '404.html')
      res
        .writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
        .end(fs.existsSync(nf) ? fs.readFileSync(nf) : 'not found')
      return
    }
    const ext = path.extname(hit.file).toLowerCase()
    const immutable = hit.file.startsWith(path.join(dir, 'assets') + path.sep)
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
    res.end(fs.readFileSync(hit.file))
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
    await listen(opts.port ?? DEFAULT_DIST_PORT)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || opts.strictPort) throw err
    await listen(0)
  }
  const port = (server.address() as AddressInfo).port
  const origin = `http://127.0.0.1:${port}`
  return {
    origin,
    port,
    url: (route, hash) => `${origin}${route}${hash ? (hash.startsWith('#') ? hash : `#${hash}`) : ''}`,
    hoursRequests: () => hoursRequests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

async function main(argv: string[]): Promise<void> {
  let dir = 'dist'
  let port = DEFAULT_DIST_PORT
  let hours: HoursFixture = 'design'
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const eq = a.indexOf('=')
    const key = eq > 0 ? a.slice(0, eq) : a
    const val = () => (eq > 0 ? a.slice(eq + 1) : argv[++i]) ?? ''
    if (key === '--dir') dir = val()
    else if (key === '--port') port = Number(val())
    else if (key === '--hours') hours = val() as HoursFixture
    else throw new Error(`unknown argument ${a}`)
  }
  const s = await startDistServer({ dir, port, strictPort: true, hours })
  console.log(
    `serve:dist ${path.resolve(ROOT, dir)} at ${s.origin} (hours fixture: ${hours}); Ctrl-C to stop`,
  )
  const stop = () => s.close().then(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
