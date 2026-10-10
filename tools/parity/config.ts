import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPages } from '../dc-compile/pages'
import type { PageSpec } from '../dc-compile/pages'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const DESIGN_DIR = path.join(ROOT, 'design')
export const PARITY_DIR = path.join(ROOT, 'parity')
export const FONTS_DIR = path.join(PARITY_DIR, 'fonts')
export const FONTCONFIG_FILE = path.join(PARITY_DIR, 'fontconfig', 'fonts.conf')
export const ALLOWLIST_FILE = path.join(PARITY_DIR, 'allowlist.json')
export const TOLERANCES_FILE = path.join(PARITY_DIR, 'tolerances.json')
export const CONSOLE_BASELINE_FILE = path.join(PARITY_DIR, 'console-baseline.json')
export const REPORTS_DIR = path.join(ROOT, 'parity-reports')
export const DIST_DIR = path.join(ROOT, 'dist-parity')

/** The pages under test come from design/pages.json (PARITY_PAGES overrides the file for experiments). */
export const PAGES: readonly PageSpec[] = loadPages(
  ROOT,
  process.env.PARITY_PAGES ?? 'design/pages.json',
).pages
export const SLUGS: readonly string[] = PAGES.map((p) => p.slug)
export type Theme = 'light' | 'dark'
export const THEMES: readonly Theme[] = ['light', 'dark']
export type Side = 'orig' | 'port'

export function pageOf(slug: string): PageSpec {
  const p = PAGES.find((x) => x.slug === slug)
  if (!p) throw new Error(`unknown page ${slug} (design/pages.json has ${SLUGS.join(', ')})`)
  return p
}

/** Frozen "now" of the designs (Saturday, June 13 2026, 10:36 AM Eastern). The explicit offset is mandatory. */
export const FIXED_NOW = process.env.PARITY_FIXED_NOW ?? '2026-06-13T10:36:00-04:00'
export const TIMEZONE = process.env.PARITY_TZ ?? 'America/New_York'
export const LOCALE = process.env.PARITY_LOCALE ?? 'en-US'
export interface Viewport {
  name: string
  width: number
  height: number
}
/**
 * The viewports every scenario runs at: site.config.json `parity.viewports` (the site: 390x844 phone first, the
 * design is mobile-first and fluid, and 1440x900 desktop), else the dashboard's 1480x1000 (the cc `$preview` size).
 * PARITY_VIEWPORTS=390x844,1440x900 overrides for experiments.
 */
export const VIEWPORTS: readonly Viewport[] = (() => {
  const env = process.env.PARITY_VIEWPORTS
  if (env)
    return env.split(',').map((v) => {
      const m = /^(\d+)x(\d+)$/.exec(v.trim())
      if (!m) throw new Error(`PARITY_VIEWPORTS: ${v} is not WxH`)
      return { name: `${m[1]}x${m[2]}`, width: Number(m[1]), height: Number(m[2]) }
    })
  const file = path.join(ROOT, 'site.config.json')
  if (fs.existsSync(file)) {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as { parity?: { viewports?: Viewport[] } }
    if (cfg.parity?.viewports?.length) return cfg.parity.viewports
  }
  return [{ name: 'desktop', width: 1480, height: 1000 }]
})()
/** The first configured viewport (the probe and single-viewport tools). */
export const VIEWPORT: Viewport = VIEWPORTS[0]!
export const PHONE_VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
] as const

/** The dashboard's harness uses 4310 / 3100; the site uses its own ports. */
export const DEFAULT_ORIGINAL_PORT = 4320
export const DEFAULT_DIST_PORT = 3301
export const DEFAULT_PORT_URL = `http://127.0.0.1:${DEFAULT_DIST_PORT}`

export const CHROMIUM_FLAGS = [
  '--disable-dev-shm-usage',
  '--force-color-profile=srgb',
  '--font-render-hinting=none',
  '--disable-lcd-text',
  // Without this, a re-render only re-rasterises the invalidated rectangle ("partial raster") and rounded-corner
  // antialiasing at the rectangle edge depends on which intermediate frames the compositor happened to produce, i.e. on
  // machine load. Measured on the dashboard: 40/40 identical loads with it, ~5% differing steps without (docs/parity.md).
  '--disable-partial-raster',
]

/** localStorage key the designs read their theme from (site.config.json theme.storageKey). */
export const THEME_KEY = 'oasis-theme'

export function isSlug(v: string): boolean {
  return SLUGS.includes(v)
}
export function isTheme(v: string): v is Theme {
  return (THEMES as readonly string[]).includes(v)
}
