// The site's host as nginx runs it, for the e2e: static files from a dist/ with the production semantics (clean URLs,
// 404.html, immutable /assets, no-cache HTML) and the whole /api/v1/public/* prefix proxied to the API origin
// (deploy/nginx/oasis-site.conf.template of the backend kit: cookies stripped, everything else under /api 404).
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

export interface SiteProxy {
  origin: string
  port: number
  /** every proxied request: method, path, status */
  log: { method: string; path: string; status: number }[]
  close(): Promise<void>
}

export async function startSiteProxy(o: { dir: string; apiOrigin: string; port?: number }): Promise<SiteProxy> {
  const dir = path.resolve(o.dir)
  if (!fs.existsSync(path.join(dir, 'index.html'))) throw new Error(`${dir} has no index.html (build first)`)
  const api = new URL(o.apiOrigin)
  const log: SiteProxy['log'] = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname.startsWith('/api/v1/public/')) {
      const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: api.host }
      delete headers.cookie
      const up = http.request(
        { host: api.hostname, port: api.port, method: req.method, path: url.pathname + url.search, headers },
        (r) => {
          log.push({ method: req.method ?? 'GET', path: url.pathname, status: r.statusCode ?? 0 })
          res.writeHead(r.statusCode ?? 502, r.headers)
          r.pipe(res)
        },
      )
      up.on('error', () => {
        log.push({ method: req.method ?? 'GET', path: url.pathname, status: 502 })
        res.writeHead(502, { 'content-type': 'application/problem+json' }).end('{"status":502,"title":"API unreachable"}')
      })
      req.pipe(up)
      return
    }
    if (url.pathname.startsWith('/api') || url.pathname.startsWith('/hooks') || url.pathname.startsWith('/dev-storage') || /\/\.[^/]+/.test(url.pathname)) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
      return
    }
    let p: string
    try {
      p = decodeURIComponent(url.pathname)
    } catch {
      p = '/'
    }
    const rel = p.replace(/^\/+/, '')
    const candidates = rel === '' ? ['index.html'] : [rel, rel.replace(/\/$/, '') + '/index.html', rel + '.html']
    const hit = candidates.map((c) => path.join(dir, c)).find((f) => f.startsWith(dir) && !rel.includes('..') && fs.existsSync(f) && fs.statSync(f).isFile())
    if (!hit) {
      const nf = path.join(dir, '404.html')
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }).end(fs.existsSync(nf) ? fs.readFileSync(nf) : 'not found')
      return
    }
    const ext = path.extname(hit).toLowerCase()
    const immutable = hit.startsWith(path.join(dir, 'assets') + path.sep)
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' })
    res.end(fs.readFileSync(hit))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(o.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const port = (server.address() as AddressInfo).port
  return { origin: `http://127.0.0.1:${port}`, port, log, close: () => new Promise((r) => server.close(() => r())) }
}
