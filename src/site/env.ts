// The build-time environment the bridge and the prerender share (tools/prerender/site-env.ts writes it as
// .generated/<variant>/site-env.js). Everything here is public data: contact strings, catalog keys, the hours and
// availability snapshots baked into the page, and the booking mode (SITE_BOOKING=sms|live).
import type { PublicHours } from '../hours/format'
import type { Availability } from './availability'
import type { ThemeConfig } from '../client/theme'
import type { PricingMode, PublicCatalog } from './catalog'

export type BookingMode = 'sms' | 'live'

export interface ContactConfig {
  /** the number people CALL (tel: links, the visible call number, the JSON-LD telephone is business.telephone) */
  phoneE164: string
  phoneDisplay: string
  /** the number people TEXT (every sms: link, the composed booking/join texts, "Text WASH to …" lines) */
  smsE164: string
  smsDisplay: string
  email: string
  smsKeyword: string
  address: { line1: string; city: string; region: string; postalCode: string; country: string }
  addressShort: string
  mapsUrl: string
}

export interface CatalogConfig {
  services: Record<string, { key: string; name: string }>
  addons: Record<string, string>
  plans: Record<string, string>
}

export interface SiteEnv {
  /** 'sms' (launch default): Book/Join compose sms: links; 'live': the public booking API */
  booking: BookingMode
  /** origin of the API ('' = same origin through nginx) */
  apiOrigin: string
  endpoints: {
    hours: string
    availability: string
    bookings: string
    otp: string
    otpVerify: string
    memberships: string
    catalog: string
  }
  timeouts: { hours: number; availability: number; api: number }
  /** ISO instant the page was prerendered at; the client's first render is pinned to it (hydration) */
  buildNow: string
  tz: string
  hours: PublicHours | null
  hoursSource: 'SITE_HOURS_JSON' | 'fallback'
  availability: Availability | null
  availabilitySource: 'SITE_AVAILABILITY_JSON' | 'none'
  availabilityDays: number
  contact: ContactConfig
  catalog: CatalogConfig
  /**
   * DV-CATALOG: the GET /api/v1/public/catalog snapshot baked into the page (SITE_CATALOG_JSON), kept only when it is
   * website-ready (src/site/catalog.ts websiteCatalog); null: the design's built-in content until the browser's refresh.
   * Interim pricing (DV-PRICE-INTERIM) keeps only its guest booking fee: { guestBookingFeeCents, services: [], addons: [] }.
   */
  catalogSnapshot: PublicCatalog | null
  catalogSource: 'SITE_CATALOG_JSON' | 'none'
  /**
   * DV-PRICE-INTERIM: site.config.json `pricing` (SITE_PRICING overrides it for a build). "interim" (the default): only
   * "from $40" (Signature Hand Wash), "from $129/mo" (Gold) and the booking fee, every other price "Priced by vehicle
   * size — ask us", and the catalog's content (DV-CATALOG v1, the old member/guest model) is never applied (its keys still
   * are, for bookings). "catalog": DV-CATALOG as before.
   */
  pricing: PricingMode
  fee: { cents: number; text: string }
  brand: string
  /** site.config.json theme: the bridge follows the device setting and stores the visitor's choice (DV-THEME) */
  theme: ThemeConfig | null
  /** site.config.json links: personal links (DV-LINK); null = the page never exchanges a link fragment */
  links: LinksConfig | null
}

/** Personal links (DV-LINK): the link API's base path and the hosts a membership / payment redirect may go to. */
export interface LinksConfig {
  /** '/api/v1/public/links' */
  base: string
  /** squarespace.com: a redirect must be https to one of these hosts or a subdomain of one */
  redirectHosts: string[]
  /** the body of the "Text us for a new link" sms: link */
  newLinkText: string
}
