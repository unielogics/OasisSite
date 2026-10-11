// The build-time environment the bridge and the prerender share (tools/prerender/site-env.ts writes it as
// .generated/<variant>/site-env.js). Everything here is public data: contact strings, catalog keys, the hours and
// availability snapshots baked into the page, and the booking mode (SITE_BOOKING=sms|live).
import type { PublicHours } from '../hours/format'
import type { Availability } from './availability'
import type { ThemeConfig } from '../client/theme'
import type { PublicCatalog } from './catalog'

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
   * website-ready (src/site/catalog.ts websiteCatalog); null: the design's built-in content until the browser's refresh
   */
  catalogSnapshot: PublicCatalog | null
  catalogSource: 'SITE_CATALOG_JSON' | 'none'
  fee: { cents: number; text: string }
  brand: string
  /** site.config.json theme: the bridge follows the device setting and stores the visitor's choice (DV-THEME) */
  theme: ThemeConfig | null
}
