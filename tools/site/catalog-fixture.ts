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

// ==== catalog v2 (GET /api/v1/public/catalog/v2, backend api-spec 26.1, ADR 0170 wave Q3d; DV-CATALOG2) ===================
//
//   designCatalogV2()   the design's own numbers in the v2 shape (design q-design-pricing.md section 9 note): the design's
//                       three vehicle types as the sizes; every wash, add-on and detail at ONE price for every size (cents =
//                       the design's guest price, memberCents = its member price), so no "from" and no per-size table; the
//                       tint packages per size with the design's ranges; Gold and VIP each at one price (the design's $99
//                       and $169 at sedan) with the design's perks and inclusions that reproduce its "included with VIP"
//                       marks. A live-mode page built from it must equal the design (src/site/bridge-live.test.ts).
//   unseededCatalogV2() production before the website-catalog seed: the dashboard's own services, no descriptions, Gold
//                       priced by pricing-defaults but without perks: not website-ready (the design's content).
//   seededCatalogV2()   production right after the seeds (plan decision 3): Signature Hand Wash $40 at Compact car only,
//                       Gold $129 at Compact car only, nothing else priced: ready, every other section on its own fallback.
//   sizedCatalogV2()    a filled grid: five sizes, prices that differ by size, a member % off, Gold at two sizes.

export const DESIGN_SIZES = [
  { key: 'sedan', label: 'Sedan / Coupe', sort: 10 },
  { key: 'suv', label: 'SUV / Crossover', sort: 20 },
  { key: 'truck', label: 'Truck / Van', sort: 30 },
]
export const DEFAULT_SIZES = [
  { key: 'compact_car', label: 'Compact car', sort: 10 },
  { key: 'large_car', label: 'Large car', sort: 20 },
  { key: 'compact_suv', label: 'Compact SUV', sort: 30 },
  { key: 'large_suv', label: 'Large SUV', sort: 40 },
  { key: 'truck', label: 'Truck', sort: 50 },
]

type Incl = { tier: string; mode: 'per_cycle' | 'every_visit'; perCycle: number | null }
const cell = (cls: string, cents: number, memberCents = cents, maxCents: number | null = null, memberMaxCents: number | null = maxCents) => ({
  class: cls,
  cents,
  maxCents,
  memberCents,
  memberMaxCents,
})
/** An item at one price for every size of `sizes` (dollars). */
function v2Item(name: string, category: string, description: string | null, guest: number, member: number, sizes: string[], includedIn: Incl[] = []) {
  const prices = sizes.map((s) => cell(s, guest * 100, member * 100))
  return { key: slug(name), name, category, description, prices, fromCents: guest * 100, fromClass: sizes[0] ?? null, memberFromCents: member * 100, includedIn }
}
const pkgV2 = (i: ReturnType<typeof v2Item>, durationMin: number, shortName = i.name) => ({ ...i, shortName, durationMin, tintFilm: null as { key: string; label: string; vlt: number[] } | null })

const WASHES_4 = (tiers: string[]): Incl[] => tiers.map((tier) => ({ tier, mode: 'per_cycle' as const, perCycle: 4 }))

export function designCatalogV2(generatedAt = '2026-06-13T14:36:00.000Z') {
  const sizes = DESIGN_SIZES.map((s) => s.key)
  const g = (m: number) => withMarkup(m * 100, MARKUP) / 100
  const add = (name: string, description: string, m: number, incl: Incl[] = []) => v2Item(name, 'addons', description, g(m), m, sizes, incl)
  const tintPkg = (film: 'carbon' | 'ceramic', name: string, description: string) => {
    const prices = (['sedan', 'suv', 'truck'] as const).map((v) => {
      const [lo, hi] = TINT_DOLLARS[film][v]
      return cell(v, withMarkup(lo * 100, MARKUP), lo * 100, withMarkup(hi * 100, MARKUP), hi * 100)
    })
    const low = prices.reduce((a, b) => (b.cents < a.cents ? b : a))
    return {
      key: slug(name),
      name,
      shortName: name,
      category: 'tint',
      description,
      durationMin: 180,
      prices,
      fromCents: low.cents,
      fromClass: low.class,
      memberFromCents: Math.min(...prices.map((p) => p.memberCents)),
      tintFilm: { key: film, label: film === 'carbon' ? 'Carbon' : 'Ceramic', vlt: [5, 20, 35, 50, 70] },
      includedIn: [] as Incl[],
    }
  }
  return {
    version: 2 as const,
    generatedAt,
    currency: 'USD' as const,
    guestBookingFeeCents: 2500,
    guestFeeCollect: 'counter' as const,
    vehicleClasses: DESIGN_SIZES,
    categories: designCatalog().categories,
    // the design's guest prices are its member prices plus 20%: members pay 1/1.2 of them (16.67% off)
    memberDisplay: { discountBp: 1667 },
    services: [
      pkgV2(v2Item('Signature Hand Wash', 'wash', 'Exterior + interior', 54, 45, sizes, WASHES_4(['gold', 'vip'])), 45),
      pkgV2(v2Item('Exterior Hand Wash', 'wash', 'Foam, hand wash, wheels, hand dry', 38, 32, sizes, WASHES_4(['gold', 'vip'])), 30),
      tintPkg('carbon', 'Carbon window tint', 'Carbon film: a deep matte look and solid heat control at a lower price · side & rear windows'),
      tintPkg('ceramic', 'Ceramic window tint', 'Ceramic film: blocks the most heat without looking darker, and won’t interfere with phone or GPS signals · side & rear windows'),
      pkgV2(v2Item('Interior detail', 'detail', 'Shampoo, steam, leather, glass', g(149), 149, sizes), 150),
      pkgV2(v2Item('Full detail', 'detail', 'Inside and out, clay bar + sealant', g(249), 249, sizes), 240),
    ],
    addons: [
      add('Hand wax', 'Carnauba, buffed by hand', 39, [{ tier: 'vip', mode: 'every_visit', perCycle: null }]),
      add('Engine bay wash', 'Degrease and dress', 45, [{ tier: 'vip', mode: 'every_visit', perCycle: null }]),
      add('Leather conditioning', 'Clean, condition, matte finish', 35, [{ tier: 'vip', mode: 'per_cycle', perCycle: 2 }]),
      add('Stain removal', 'Seats and carpets, when needed', 59, [{ tier: 'vip', mode: 'per_cycle', perCycle: 1 }]),
      add('Tire shine & dressing', 'Satin or gloss', 12),
      add('Rain-repellent glass', 'Windshield and side glass', 25),
      add('Odor removal', 'Enzyme treatment', 30),
      add('Pet hair removal', 'Rubber brush and vacuum', 35),
      add('Interior deep clean', 'Seats, carpets, vents', 60),
    ],
    quotes: designCatalog().quotes,
    tiers: [
      {
        key: 'gold',
        name: 'Gold',
        colour: '#E8C46A',
        sort: 10,
        perks: ['4 hand washes a month, interior included', 'Share across household cars', 'No booking fees', 'Member prices on everything else'],
        memberDiscountBp: 1667,
        vipBooking: false,
        householdCars: null as number | null,
        prices: [{ class: 'sedan', monthlyCents: 9900 }],
        fromMonthlyCents: 9900,
        fromClass: 'sedan',
        inclusions: [
          { serviceKey: 'signature-hand-wash', mode: 'per_cycle' as const, perCycle: 4 as number | null, group: 1 },
          { serviceKey: 'exterior-hand-wash', mode: 'per_cycle' as const, perCycle: 4 as number | null, group: 1 },
        ],
      },
      {
        key: 'vip',
        name: 'VIP',
        colour: '#1FB6FF',
        sort: 20,
        perks: ['Everything in Gold', 'Wax every wash + engine bay', 'Leather 2× and stain removal 1× a month', 'Priority booking and same-day guarantee'],
        memberDiscountBp: 1667,
        vipBooking: true,
        householdCars: null as number | null,
        prices: [{ class: 'sedan', monthlyCents: 16900 }],
        fromMonthlyCents: 16900,
        fromClass: 'sedan',
        inclusions: [
          { serviceKey: 'signature-hand-wash', mode: 'per_cycle' as const, perCycle: 4 as number | null, group: 1 },
          { serviceKey: 'exterior-hand-wash', mode: 'per_cycle' as const, perCycle: 4 as number | null, group: 1 },
          { serviceKey: 'hand-wax', mode: 'every_visit' as const, perCycle: null as number | null, group: 2 },
          { serviceKey: 'engine-bay-wash', mode: 'every_visit' as const, perCycle: null as number | null, group: 3 },
          { serviceKey: 'leather-conditioning', mode: 'per_cycle' as const, perCycle: 2 as number | null, group: 4 },
          { serviceKey: 'stain-removal', mode: 'per_cycle' as const, perCycle: 1 as number | null, group: 5 },
        ],
      },
    ],
  }
}

export type CatalogV2Payload = ReturnType<typeof designCatalogV2>

/** Production before the website-catalog seed: the dashboard's own services, no descriptions, Gold without perks. */
export function unseededCatalogV2(generatedAt = '2026-06-13T14:36:00.000Z') {
  const internal = (name: string, cents: number, durationMin = 0) => ({
    key: slug(name),
    name,
    category: 'wash',
    description: null,
    prices: [cell('compact_car', cents)],
    fromCents: cents,
    fromClass: 'compact_car',
    memberFromCents: cents,
    includedIn: [] as Incl[],
    ...(durationMin ? { shortName: name, durationMin, tintFilm: null } : {}),
  })
  return {
    version: 2 as const,
    generatedAt,
    currency: 'USD' as const,
    guestBookingFeeCents: 2500,
    guestFeeCollect: 'counter' as const,
    vehicleClasses: DEFAULT_SIZES,
    categories: [{ key: 'wash', label: 'Wash', colour: '#1FB6FF', sort: 10 }],
    memberDisplay: { discountBp: 0 },
    services: [internal('Express Hand Wash', 3500, 30), internal('Premium Hand Wash + Interior', 5500, 60)],
    addons: [internal('Wax', 2500), internal('Odor removal', 2000)],
    quotes: [],
    tiers: [
      { key: 'gold', name: 'Gold', colour: '#E8C46A', sort: 10, perks: [] as string[], memberDiscountBp: 0, vipBooking: false, householdCars: null, prices: [{ class: 'compact_car', monthlyCents: 12900 }], fromMonthlyCents: 12900, fromClass: 'compact_car', inclusions: [] },
    ],
  }
}

/** Production right after pricing-defaults and website-catalog: only the Signature wash and Gold priced, at Compact car. */
export function seededCatalogV2(generatedAt = '2026-06-13T14:36:00.000Z') {
  const d = designCatalogV2(generatedAt)
  const sig = d.services[0]!
  return {
    ...d,
    vehicleClasses: DEFAULT_SIZES,
    memberDisplay: { discountBp: 0 },
    services: [{ ...sig, prices: [cell('compact_car', 4000)], fromCents: 4000, fromClass: 'compact_car', memberFromCents: 4000, includedIn: WASHES_4(['gold']) }],
    addons: [],
    quotes: [],
    tiers: [{ ...d.tiers[0]!, memberDiscountBp: 0, prices: [{ class: 'compact_car', monthlyCents: 12900 }], fromMonthlyCents: 12900, fromClass: 'compact_car', inclusions: [{ serviceKey: 'signature-hand-wash', mode: 'per_cycle' as const, perCycle: 4 as number | null, group: 1 }] }],
  }
}

/** A filled grid: five sizes, prices that differ by size, 10% off for members, Gold sold at two sizes, VIP at one. */
export function sizedCatalogV2(generatedAt = '2026-06-13T14:36:00.000Z') {
  const d = designCatalogV2(generatedAt)
  const sizes = DEFAULT_SIZES.map((s) => s.key)
  const member = (c: number) => Math.floor((c * 9000 + 500_000) / 1_000_000) * 100 // 10% off, half up to whole dollars
  const byStep = (base: number, step: number, only = sizes) => only.map((s, n) => cell(s, (base + n * step) * 100, member((base + n * step) * 100)))
  const item = <T extends { prices: unknown[] }>(i: T, prices: ReturnType<typeof cell>[]) => {
    const low = prices.reduce((a, b) => (b.cents < a.cents ? b : a))
    return { ...i, prices, fromCents: low.cents, fromClass: low.class, memberFromCents: Math.min(...prices.map((p) => p.memberCents)) }
  }
  const tintRows = (lo: number) => sizes.map((s, n) => cell(s, (lo + n * 20) * 100, member((lo + n * 20) * 100), (lo + 60 + n * 20) * 100, member((lo + 60 + n * 20) * 100)))
  return {
    ...d,
    vehicleClasses: DEFAULT_SIZES,
    memberDisplay: { discountBp: 1000 },
    services: [
      item(d.services[0]!, byStep(40, 10)),
      // Exterior: priced at the two car sizes only (the SUVs and the truck are priced at the shop)
      item(d.services[1]!, byStep(30, 5, ['compact_car', 'large_car'])),
      item(d.services[2]!, tintRows(250)),
      item(d.services[3]!, tintRows(400)),
      item(d.services[4]!, byStep(150, 25)),
      item(d.services[5]!, byStep(250, 25)),
    ],
    addons: d.addons.map((a) => item(a, sizes.map((s) => cell(s, a.prices[0]!.cents, member(a.prices[0]!.cents))))),
    tiers: [
      { ...d.tiers[0]!, memberDiscountBp: 1000, prices: [{ class: 'compact_car', monthlyCents: 12900 }, { class: 'large_suv', monthlyCents: 15900 }], fromMonthlyCents: 12900, fromClass: 'compact_car' },
      { ...d.tiers[1]!, memberDiscountBp: 1500, prices: [{ class: 'compact_car', monthlyCents: 19900 }], fromMonthlyCents: 19900, fromClass: 'compact_car' },
    ],
  }
}
