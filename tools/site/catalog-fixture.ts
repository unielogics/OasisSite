// Catalog fixtures in the shape of GET /api/v1/public/catalog (backend api-spec section 26.1, ADR 0160 W2a), for the
// parity build and its server, the fixture API, the e2e and the unit tests. Never part of the build output.
//
//   designCatalog()    what the backend answers once the owner has run the `website-catalog` seed (db/seeds/website-
//                      catalog.ts): the design's own washes, add-ons, tint matrix, details, quote-only items, plans and
//                      fee, keyed the backend's way (the slug of the name). The page built from it must equal the design
//                      (pnpm parity:all serves and bakes this one).
//   unseededCatalog()  what production answers before that seed: the dashboard's own services (no description, no
//                      website prices of their own, plans without a price): the site must keep its built-in content.

/** The backend's guest rule (catalog/pricing.ts withMarkup): member + pct, rounded half up to whole dollars, in cents. */
export const withMarkup = (memberCents: number, pct: number): number => Math.floor((memberCents * (100 + pct) + 5_000) / 10_000) * 100

const MARKUP = 20

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

type Vip = 'included' | 'allowance' | 'none'

const item = (name: string, category: string, description: string | null, memberDollars: number, vipInclusion: Vip = 'none', vipNote: string | null = null, tags: string[] = []) => {
  const member = memberDollars * 100
  const guest = withMarkup(member, MARKUP)
  return { key: slug(name), name, category, description, priceCents: guest, memberPriceCents: member, guestPriceCents: guest, vipInclusion, vipNote, tags }
}

const WASH_NOTE = 'Included with Gold and VIP (4 washes a month)'

const TINT_DOLLARS: Record<'carbon' | 'ceramic', Record<'sedan' | 'suv' | 'truck', [number, number]>> = {
  carbon: { sedan: [229, 279], suv: [269, 329], truck: [249, 299] },
  ceramic: { sedan: [379, 449], suv: [429, 529], truck: [399, 479] },
}

export function designTintMatrix() {
  return {
    vehicleTypes: [
      { key: 'sedan', label: 'Sedan / Coupe' },
      { key: 'suv', label: 'SUV / Crossover' },
      { key: 'truck', label: 'Truck / Van' },
    ],
    films: [
      { key: 'carbon', label: 'Carbon', vlt: [5, 20, 35, 50, 70] },
      { key: 'ceramic', label: 'Ceramic', vlt: [5, 20, 35, 50, 70] },
    ],
    prices: (['sedan', 'suv', 'truck'] as const).flatMap((vehicle) =>
      (['carbon', 'ceramic'] as const).map((film) => {
        const [lo, hi] = TINT_DOLLARS[film][vehicle]
        return {
          vehicle,
          film,
          memberMinCents: lo * 100,
          memberMaxCents: hi * 100,
          guestMinCents: withMarkup(lo * 100, MARKUP),
          guestMaxCents: withMarkup(hi * 100, MARKUP),
        }
      }),
    ),
  }
}

export type CatalogPayload = ReturnType<typeof designCatalog>

/** The catalog after the `website-catalog` seed: equal to the design's content. */
export function designCatalog(generatedAt = '2026-06-13T14:36:00.000Z') {
  const tint = designTintMatrix()
  const tintPackage = (film: 'carbon' | 'ceramic', name: string, description: string) => {
    const rows = tint.prices.filter((p) => p.film === film)
    const member = Math.min(...rows.map((r) => r.memberMinCents))
    const guest = Math.min(...rows.map((r) => r.guestMinCents))
    return { key: slug(name), name, category: 'tint', description, priceCents: guest, memberPriceCents: member, guestPriceCents: guest, vipInclusion: 'none' as Vip, vipNote: null, tags: ['tint', film], shortName: name, durationMin: 180, tintFilm: film }
  }
  const pkg = (i: ReturnType<typeof item>, durationMin: number) => ({ ...i, shortName: i.name, durationMin, tintFilm: null as string | null })
  return {
    generatedAt,
    currency: 'USD' as const,
    guestMarkupPct: MARKUP,
    guestBookingFeeCents: 2500,
    categories: [
      { key: 'wash', label: 'Wash', colour: '#1FB6FF', sort: 10 },
      { key: 'addons', label: 'Add-ons', colour: '#7FD6FF', sort: 20 },
      { key: 'tint', label: 'Tint', colour: '#2EE59D', sort: 30 },
      { key: 'detail', label: 'Detail', colour: '#FFB547', sort: 40 },
      { key: 'quote', label: 'Quote', colour: '#8C97A1', sort: 50 },
    ],
    services: [
      pkg(item('Signature Hand Wash', 'wash', 'Exterior + interior', 45, 'included', WASH_NOTE, ['handwash', 'signature', 'premium']), 45),
      pkg(item('Exterior Hand Wash', 'wash', 'Foam, hand wash, wheels, hand dry', 32, 'included', WASH_NOTE, ['handwash', 'exterior', 'express']), 30),
      tintPackage('carbon', 'Carbon window tint', 'Carbon film: a deep matte look and solid heat control at a lower price · side & rear windows'),
      tintPackage(
        'ceramic',
        'Ceramic window tint',
        'Ceramic film: blocks the most heat without looking darker, and won’t interfere with phone or GPS signals · side & rear windows',
      ),
      pkg(item('Interior detail', 'detail', 'Shampoo, steam, leather, glass', 149, 'none', null, ['detail', 'interior']), 150),
      pkg(item('Full detail', 'detail', 'Inside and out, clay bar + sealant', 249, 'none', null, ['detail']), 240),
    ],
    addons: [
      item('Hand wax', 'addons', 'Carnauba, buffed by hand', 39, 'included'),
      item('Engine bay wash', 'addons', 'Degrease and dress', 45, 'included'),
      item('Leather conditioning', 'addons', 'Clean, condition, matte finish', 35, 'allowance', '2× / mo'),
      item('Stain removal', 'addons', 'Seats and carpets, when needed', 59, 'allowance', '1× / mo'),
      item('Tire shine & dressing', 'addons', 'Satin or gloss', 12),
      item('Rain-repellent glass', 'addons', 'Windshield and side glass', 25),
      item('Odor removal', 'addons', 'Enzyme treatment', 30),
      item('Pet hair removal', 'addons', 'Rubber brush and vacuum', 35),
      item('Interior deep clean', 'addons', 'Seats, carpets, vents', 60),
    ],
    quotes: ['Windshield replacement', 'Rim powder coating', 'Chrome delete', 'Car key copies'].map((name) => ({
      key: slug(name),
      name,
      kind: 'package' as const,
      category: 'quote',
      description: null,
    })),
    tint,
    plans: [
      {
        key: 'gold' as const,
        name: 'Gold',
        planKey: 'premium',
        planName: 'Premium',
        perks: ['4 hand washes a month, interior included', 'Share across household cars', 'No booking fees', 'Member prices on everything else'],
        priceCents: 9900 as number | null,
      },
      {
        key: 'vip' as const,
        name: 'VIP',
        planKey: 'executive',
        planName: 'Executive',
        perks: ['Everything in Gold', 'Wax every wash + engine bay', 'Leather 2× and stain removal 1× a month', 'Priority booking and same-day guarantee'],
        priceCents: 16900 as number | null,
      },
    ],
  }
}

/**
 * Production before the `website-catalog` seed (2026-10-11): the dashboard's own services under their own names (the
 * public catalog lists every active service, `visibleOnline` defaults to true), prices only from `price_cents`, no
 * description, plans without a price or perks. Some add-on keys collide with the design's (leather-conditioning, …).
 */
export function unseededCatalog(generatedAt = '2026-06-13T14:36:00.000Z') {
  const internal = (name: string, category: string, cents: number, durationMin = 0) => ({
    key: slug(name),
    name,
    category,
    description: null,
    priceCents: cents,
    memberPriceCents: cents,
    guestPriceCents: withMarkup(cents, MARKUP),
    vipInclusion: 'none' as Vip,
    vipNote: null,
    tags: [] as string[],
    ...(durationMin ? { shortName: name, durationMin, tintFilm: null } : {}),
  })
  return {
    generatedAt,
    currency: 'USD' as const,
    guestMarkupPct: MARKUP,
    guestBookingFeeCents: 2500,
    categories: [{ key: 'wash', label: 'Wash', colour: '#1FB6FF', sort: 10 }],
    services: [internal('Express Hand Wash', 'wash', 3500, 30), internal('Premium Hand Wash + Interior', 'wash', 5500, 60), internal('Executive Detail', 'detail', 22500, 180)],
    addons: [internal('Wax', 'addons', 2500), internal('Leather conditioning', 'addons', 3000), internal('Odor removal', 'addons', 2000), internal('Pet hair removal', 'addons', 2500), internal('Interior deep clean', 'addons', 4500)],
    quotes: [],
    tint: { vehicleTypes: [], films: [], prices: [] },
    plans: [
      { key: 'gold', name: 'Gold', planKey: 'premium', planName: 'Premium', perks: [], priceCents: null },
      { key: 'vip', name: 'VIP', planKey: 'executive', planName: 'Executive', perks: [], priceCents: null },
    ],
  }
}

/** A copy of a catalog with one item's member price changed (and its guest price by the markup), by key. */
export function withMemberPrice<T extends { services: { key: string }[]; addons: { key: string }[] }>(cat: T, key: string, memberDollars: number): T {
  const out = JSON.parse(JSON.stringify(cat)) as T
  for (const list of [out.services, out.addons] as Record<string, unknown>[][])
    for (const i of list)
      if (i.key === key) {
        i.memberPriceCents = memberDollars * 100
        i.guestPriceCents = withMarkup(memberDollars * 100, MARKUP)
        i.priceCents = i.guestPriceCents
      }
  return out
}
