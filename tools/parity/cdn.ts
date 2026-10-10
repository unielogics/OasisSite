// The ORIGINAL design loads two things from the network that the harness must answer itself (it allows no origin
// but the two local servers): React / ReactDOM 18.3.1 UMD from unpkg (the dc runtime's loader, with SRI) and the
// Google Fonts stylesheet + woff2 files its helmet links. Both come from pinned local copies: the UMD builds shipped
// in the react/react-dom 18.3.1 packages (byte-identical to unpkg's, checked against the runtime's SRI hashes) and
// design/fonts (vendored once by pnpm intake:fonts, DEVIATIONS.md DV-FONTS). A request for any other external URL is
// still blocked and reported.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DESIGN_DIR, ROOT } from './config'

export interface Intercept {
  /** exact URL, or a prefix when it ends with '*' */
  url: string
  body: Buffer
  contentType: string
}

const require = createRequire(import.meta.url)

function sri(bytes: Buffer): string {
  return 'sha384-' + crypto.createHash('sha384').update(bytes).digest('base64')
}

/** The runtime's CDN URLs and their SRI hashes, read from the vendored runtime so nothing can drift. */
export function runtimeCdn(runtimeFile: string): { url: string; sri: string }[] {
  const src = fs.readFileSync(runtimeFile, 'utf8')
  const out: { url: string; sri: string }[] = []
  for (const name of ['REACT', 'REACT_DOM']) {
    const url = new RegExp(`var ${name}_URL = "([^"]+)"`).exec(src)?.[1]
    const hash = new RegExp(`var ${name}_SRI = "([^"]+)"`).exec(src)?.[1]
    if (url && hash) out.push({ url, sri: hash })
  }
  return out
}

/** Intercepts for a raw design: React UMD + Google Fonts. Empty when the design is a bundle (it carries its own). */
export function designIntercepts(runtimeFile: string | null): Intercept[] {
  const out: Intercept[] = []
  if (runtimeFile && fs.existsSync(runtimeFile)) {
    for (const { url, sri: want } of runtimeCdn(runtimeFile)) {
      const pkg = /react-dom/.test(url) ? 'react-dom' : 'react'
      const file = path.join(path.dirname(require.resolve(`${pkg}/package.json`)), 'umd', path.basename(url))
      const body = fs.readFileSync(file)
      if (sri(body) !== want)
        throw new Error(`${file} does not match the runtime's SRI for ${url} (${sri(body)} vs ${want})`)
      out.push({ url, body, contentType: 'text/javascript; charset=utf-8' })
    }
  }
  const fontsDir = path.join(DESIGN_DIR, 'fonts')
  const manifestFile = path.join(fontsDir, 'manifest.json')
  if (fs.existsSync(manifestFile)) {
    const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as {
      sources: { href: string; css: string }[]
      files: Record<string, { url: string }>
    }
    for (const s of m.sources)
      out.push({ url: s.href, body: fs.readFileSync(path.join(fontsDir, s.css)), contentType: 'text/css; charset=utf-8' })
    for (const [file, e] of Object.entries(m.files))
      out.push({ url: e.url, body: fs.readFileSync(path.join(fontsDir, file)), contentType: 'font/woff2' })
  }
  return out
}

export const RUNTIME_FILE = path.join(ROOT, 'design', 'extracted', 'runtime', 'dc-runtime.js')

let cached: Intercept[] | null = null
/** The intercepts for design/pages.json's design, computed once per process. */
export function defaultIntercepts(): Intercept[] {
  if (!cached) cached = designIntercepts(fs.existsSync(RUNTIME_FILE) ? RUNTIME_FILE : null)
  return cached
}

export function findIntercept(list: readonly Intercept[], url: string): Intercept | undefined {
  return list.find((i) => (i.url.endsWith('*') ? url.startsWith(i.url.slice(0, -1)) : i.url === url))
}
