// Builds the SiteEnv the bridge and the prerender share (src/site/env.ts) from site.config.json and the build
// environment, and writes it as .generated/<variant>/site-env.js (an ES module the compiled logic imports).
//   SITE_BOOKING=sms|live           Book/Join compose sms: links (default) or call the public booking API
//   SITE_API_ORIGIN                 API origin for the browser ('' = same origin through nginx)
//   SITE_HOURS_JSON                 GET /api/v1/public/hours body, inline or the path of a file holding it (the deploy
//                                   kit's site-deploy.sh passes a file); else src/data/hours.fallback.json + a warning
//   SITE_AVAILABILITY_JSON          GET /api/v1/public/availability body, inline or a file path (else no slots: the
//                                   board shows the hours and "text to check times")
//   SITE_CATALOG_JSON               GET /api/v1/public/catalog body, inline or a file path (DV-CATALOG): baked in only when
//                                   it is website-ready (src/site/catalog.ts), else the design's built-in content + a warning
//   SITE_PRICING=interim|catalog|live  overrides site.config.json `pricing` (DV-PRICE-INTERIM; default interim): interim
//                                   never bakes or applies the catalog's content (the old price model), only its booking fee;
//                                   catalog is DV-CATALOG (v1); live is DV-CATALOG2: SITE_CATALOG_JSON is then the body of
//                                   GET /api/v1/public/catalog/v2, baked in only when website-ready (src/site/catalog2.ts)
//   SITE_BUILD_NOW / PRERENDER_NOW  the build instant (default: now); the parity build pins it to the harness's clock
import fs from 'node:fs'
import path from 'node:path'
import type { PublicHours } from '../../src/hours/format'
import { validateAvailability, type Availability } from '../../src/site/availability'
import { catalogFee, configDesign, PRICING_MODES, websiteCatalog, type PricingMode, type PublicCatalog } from '../../src/site/catalog'
import { websiteReadyV2, type CatalogV2 } from '../../src/site/catalog2'
import type { SiteEnv } from '../../src/site/env'
import type { SiteConfig } from './seo'

/**
 * A snapshot given through the environment: the JSON itself, or the path of a file holding it (site-deploy.sh writes
 * the API's answer to a file and passes the path). Throws with a readable message when neither parses.
 */
export function readSnapshot(value: string): unknown {
  const v = value.trim()
  if (v.startsWith('{') || v.startsWith('[')) return JSON.parse(v)
  if (!fs.existsSync(v)) throw new Error(`neither JSON nor an existing file: ${v.slice(0, 80)}`)
  return JSON.parse(fs.readFileSync(v, 'utf8'))
}

export interface SiteEnvInput {
  site: SiteConfig
  hours: PublicHours
  hoursSource: 'SITE_HOURS_JSON' | 'fallback'
  availabilityJson?: string | null
  catalogJson?: string | null
  booking?: string | null
  /** SITE_PRICING (undefined/null/empty: site.config.json `pricing`, else interim) */
  pricing?: string | null
  apiOrigin?: string | null
  now: string
  warn: (s: string) => void
}

export function buildSiteEnv(i: SiteEnvInput): SiteEnv {
  const s = i.site
  let availability: Availability | null = null
  let availabilitySource: SiteEnv['availabilitySource'] = 'none'
  if (i.availabilityJson) {
    try {
      availability = validateAvailability(readSnapshot(i.availabilityJson))
      availabilitySource = 'SITE_AVAILABILITY_JSON'
    } catch (e) {
      i.warn(`SITE_AVAILABILITY_JSON is not a valid availability payload (${e instanceof Error ? e.message : String(e)}); the board shows the hours only`)
    }
  } else i.warn('SITE_AVAILABILITY_JSON is not set; the open-times board shows the hours with "text to check times" until the browser fetches live availability')
  const booking = i.booking || 'sms'
  if (booking !== 'sms' && booking !== 'live') throw new Error(`SITE_BOOKING must be sms or live, got ${booking}`)
  if (!s.contact || !s.catalog || !s.booking || !s.availability)
    throw new Error('site.config.json needs contact, catalog, booking and availability sections')
  for (const k of ['phoneE164', 'phoneDisplay', 'smsE164', 'smsDisplay'] as const)
    if (typeof s.contact[k] !== 'string' || !s.contact[k])
      throw new Error(`site.config.json contact.${k} is required (calls use phone*, texts use sms*)`)
  // DV-PRICE-INTERIM: the price mode (an unknown value fails the build rather than guessing)
  const pricing = (i.pricing || s.pricing || 'interim') as PricingMode
  if (!PRICING_MODES.includes(pricing)) throw new Error(`pricing (site.config.json or SITE_PRICING) must be ${PRICING_MODES.join(' or ')}, got ${pricing}`)
  // DV-CATALOG: the catalog snapshot, kept only when the page would use it (website-ready, pricing "catalog"); interim
  // mode keeps only its guest booking fee (a Settings value, what the API charges), never the old price model
  let catalogSnapshot: PublicCatalog | CatalogV2 | null = null
  if (pricing === 'interim') {
    if (i.catalogJson) {
      let fee: number | null = null
      try {
        fee = catalogFee(readSnapshot(i.catalogJson))
      } catch {
        /* not a catalog payload: the design's fee */
      }
      if (fee !== null) catalogSnapshot = { guestBookingFeeCents: fee * 100, services: [], addons: [] }
      i.warn(
        `pricing is interim (DV-PRICE-INTERIM): SITE_CATALOG_JSON's prices are not shown; ${fee !== null ? `only its booking fee ($${fee}) is baked` : "it has no whole-dollar booking fee, the page shows the design's"}`,
      )
    }
  } else if (pricing === 'live') {
    // DV-CATALOG2: the v2 payload, checked field by field; kept only when website-ready
    if (i.catalogJson) {
      try {
        const ready = websiteReadyV2(readSnapshot(i.catalogJson), s.catalog, Object.entries(s.catalog.services).map(([id, x]) => ({ id, name: x.name })))
        if (ready.cat) catalogSnapshot = ready.cat
        else i.warn(`SITE_CATALOG_JSON is not a website-ready catalog v2 (${ready.reason}); the page shows the design's built-in content until the browser loads GET /api/v1/public/catalog/v2`)
      } catch (e) {
        i.warn(`SITE_CATALOG_JSON is not a catalog payload (${e instanceof Error ? e.message : String(e)}); the page shows the design's built-in content`)
      }
    } else i.warn("SITE_CATALOG_JSON is not set; the page shows the design's built-in content until the browser loads GET /api/v1/public/catalog/v2")
  } else if (i.catalogJson) {
    try {
      const raw = readSnapshot(i.catalogJson)
      const ready = websiteCatalog(raw, s.catalog, configDesign(s.catalog))
      if (ready.site) catalogSnapshot = raw as PublicCatalog
      else i.warn(`SITE_CATALOG_JSON is not website-ready (${ready.reason}); the page shows the design's built-in services and prices`)
    } catch (e) {
      i.warn(`SITE_CATALOG_JSON is not a catalog payload (${e instanceof Error ? e.message : String(e)}); the page shows the design's built-in services and prices`)
    }
  } else i.warn('SITE_CATALOG_JSON is not set; the page shows the design\'s built-in services and prices until the browser loads the catalog')
  return {
    booking,
    apiOrigin: (i.apiOrigin ?? '').replace(/\/+$/, ''),
    endpoints: {
      hours: s.hours.endpoint,
      availability: s.availability.endpoint,
      bookings: s.booking.endpoints.bookings,
      otp: s.booking.endpoints.otp,
      otpVerify: s.booking.endpoints.otpVerify,
      memberships: s.booking.endpoints.memberships,
      catalog: s.booking.endpoints.catalog,
      catalogV2: s.booking.endpoints.catalogV2 ?? '/api/v1/public/catalog/v2',
    },
    timeouts: { hours: s.hours.timeoutMs, availability: s.availability.timeoutMs, api: 12000 },
    buildNow: i.now,
    tz: i.hours.tz || 'America/New_York',
    hours: i.hours,
    hoursSource: i.hoursSource,
    availability,
    availabilitySource,
    availabilityDays: s.availability.days,
    contact: s.contact,
    catalog: s.catalog,
    catalogSnapshot,
    catalogSource: catalogSnapshot ? 'SITE_CATALOG_JSON' : 'none',
    pricing,
    fee: { cents: s.booking.feeCents, text: s.booking.feeText },
    brand: s.name,
    theme: s.theme ?? null,
    // personal links (DV-LINK, W3f)
    links: s.links ?? null,
  }
}

export function writeSiteEnv(generatedDir: string, env: SiteEnv): string {
  const file = path.join(generatedDir, 'site-env.js')
  fs.mkdirSync(generatedDir, { recursive: true })
  fs.writeFileSync(
    file,
    `// AUTO-GENERATED by tools/prerender/site-env.ts. DO NOT EDIT.\n/* eslint-disable */\nconst env = ${JSON.stringify(env, null, 2)}\nexport default env\n`,
  )
  fs.writeFileSync(
    path.join(generatedDir, 'site-env.d.ts'),
    `import type { SiteEnv } from '@/site/env'\ndeclare const env: SiteEnv\nexport default env\n`,
  )
  return file
}
