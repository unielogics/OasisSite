// site.config.json + seo.json -> the head slots of a page (title, description, canonical, Open Graph, icons) and
// the LocalBusiness JSON-LD with openingHoursSpecification built from the hours payload (closed days are absent).
import fs from 'node:fs'
import path from 'node:path'
import type { PublicHours } from '../../src/hours/format'
import { toMinutes } from '../../src/hours/format'
import type { ThemeConfig } from '../../src/client/theme'
import type { CatalogConfig, ContactConfig, LinksConfig } from '../../src/site/env'

export interface SiteConfig {
  name: string
  lang: string
  siteUrl: string
  marker: string
  /** viewport content override (e.g. "width=1480" for a fixed-width design); null keeps the design's own */
  viewport: string | null
  theme: ThemeConfig | null
  hours: { endpoint: string; timeoutMs: number; labels?: Record<string, string> }
  availability?: { endpoint: string; timeoutMs: number; days: number }
  booking?: {
    endpoints: { bookings: string; otp: string; otpVerify: string; memberships: string; catalog: string }
    feeCents: number
    feeText: string
  }
  contact?: ContactConfig
  catalog?: CatalogConfig
  /** DV-PRICE-INTERIM: "interim" (default when absent) or "catalog" (src/site/catalog.ts PricingMode) */
  pricing?: string
  /** a custom element rendered as a static placeholder (src/dc/image-slot.ts) */
  imageSlots?: { tag: string } | null
  /** per page slug: the module wrapped around the logic class */
  bridges?: Record<string, string>
  /** personal links (DV-LINK): the link API base and the redirect host allowlist */
  links?: LinksConfig | null
  parity?: { viewports?: { name: string; width: number; height: number }[] }
  /** logical asset path of the logo/icon (/assets/oasis-logo.png) or null */
  icon?: string | null
  business: {
    type: string
    telephone: string | null
    email?: string | null
    address: {
      streetAddress: string
      addressLocality: string
      addressRegion: string
      postalCode: string
      addressCountry: string
    } | null
    geo: { latitude: number; longitude: number } | null
    sameAs: string[]
    priceRange?: string | null
  }
}

export interface SeoEntry {
  title?: string
  description?: string
  /** logical asset path or absolute URL */
  image?: string | null
  noindex?: boolean
}

export interface SeoFile {
  default: SeoEntry
  pages: Record<string, SeoEntry>
}

export function loadSiteConfig(root: string): SiteConfig {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'site.config.json'), 'utf8')) as SiteConfig
  for (const k of ['name', 'lang', 'siteUrl', 'marker'] as const)
    if (typeof cfg[k] !== 'string' || !cfg[k]) throw new Error(`site.config.json: ${k} is required`)
  if (!cfg.hours || typeof cfg.hours.endpoint !== 'string')
    throw new Error('site.config.json: hours.endpoint is required')
  if (cfg.theme && (!Array.isArray(cfg.theme.values) || !cfg.theme.values.includes(cfg.theme.default)))
    throw new Error('site.config.json: theme.values must contain theme.default')
  return cfg
}

export function loadSeo(root: string): SeoFile {
  const file = path.join(root, 'seo.json')
  if (!fs.existsSync(file)) return { default: {}, pages: {} }
  const seo = JSON.parse(fs.readFileSync(file, 'utf8')) as SeoFile
  return { default: seo.default ?? {}, pages: seo.pages ?? {} }
}

export interface PageSeo {
  title: string
  description: string | null
  canonical: string
  ogImage: string | null
  noindex: boolean
}

export function seoFor(
  site: SiteConfig,
  seo: SeoFile,
  slug: string,
  route: string,
  siteUrl: string,
): PageSeo {
  const e = { ...seo.default, ...(seo.pages[slug] ?? {}) }
  const title = e.title ?? site.name
  if (!title) throw new Error(`${slug}: no title (seo.json default.title or pages.${slug}.title)`)
  const base = siteUrl.replace(/\/+$/, '')
  return {
    title,
    description: e.description ?? null,
    canonical: route === '/' ? `${base}/` : `${base}${route}`,
    ogImage: e.image ?? null,
    noindex: !!e.noindex,
  }
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const hhmm = (v: string | number | null | undefined): string => {
  const m = toMinutes(v)
  if (m === null) return ''
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** schema.org LocalBusiness. Days that are closed have no OpeningHoursSpecification entry (Sunday closed = absent). */
export function localBusinessJsonLd(
  site: SiteConfig,
  siteUrl: string,
  hours: PublicHours | null,
  image: string | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': site.business?.type || 'LocalBusiness',
    name: site.name,
    url: siteUrl.replace(/\/+$/, '') + '/',
  }
  if (image) out.image = image
  if (site.business?.telephone) out.telephone = site.business.telephone
  if (site.business?.email) out.email = site.business.email
  if (site.business?.address) out.address = { '@type': 'PostalAddress', ...site.business.address }
  if (site.business?.geo) out.geo = { '@type': 'GeoCoordinates', ...site.business.geo }
  if (site.business?.priceRange) out.priceRange = site.business.priceRange
  if (site.business?.sameAs?.length) out.sameAs = site.business.sameAs
  if (hours) {
    const spec = [...hours.week]
      .sort((a, b) => a.weekday - b.weekday)
      .filter((d) => d.open && hhmm(d.from) && hhmm(d.to))
      .map((d) => ({
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: `https://schema.org/${DAYS[d.weekday]}`,
        opens: hhmm(d.from),
        closes: hhmm(d.to),
      }))
    if (spec.length) out.openingHoursSpecification = spec
  }
  return out
}
