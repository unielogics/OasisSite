// DV-CATALOG: the website's services, add-ons, tint table, detailing, quote-only items, plan prices and perks and the
// guest booking fee from the dashboard's Settings, through GET /api/v1/public/catalog (backend api-spec section 26.1,
// ADR 0160 wave W2a). The page gets a build-time snapshot (SITE_CATALOG_JSON, like the hours) and the bridge applies the
// API's answer after mount.
//
// SAFETY: the catalog is used only when it is WEBSITE-READY (websiteCatalog below): both of the design's washes are in it
// under their keys with a description, a duration and whole-dollar member and guest prices, both plans have a monthly
// price and perks, and the fee is whole dollars. Anything less (production before the owner runs the website-catalog
// seed, an unknown payload, a missing key, empty lists) keeps the design's built-in content exactly as it is; inside a
// ready catalog every section (add-ons, tint, detailing, quote-only items) falls back to the design's own list on its own
// when the catalog has nothing usable for it, so the page never shows an empty or a dashboard-internal list.
//
// Prices shown are the catalog's member and guest STARTING prices (memberPriceCents / guestPriceCents, a tint row's
// memberMinCents / guestMinCents, design section 3b), never priceCents (what a booking charges), with the design's own
// wording ("from $229", "SAVE $9", "Included").

/** A name as a catalog key (the backend's keys are the slug of the item's name, src/modules/public/keys.ts). */
export const slugOfName = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/**
 * The catalog entry for one of the design's items: the configured key when the live catalog has it, else the entry
 * whose name is the design's name (same slug). Nothing else: an item the catalog does not carry has no key (null) and
 * is never substituted by a look-alike.
 */
export function catalogMatch<T extends { key: string; name: string }>(items: T[], key: string | undefined, name: string): T | null {
  if (key) {
    const k = items.find((x) => x.key === key)
    if (k) return k
  }
  const want = slugOfName(name)
  return items.find((x) => x.key === want || slugOfName(x.name) === want) ?? null
}

// ---- the API's shape (only what the website reads; everything is checked, nothing trusted) -------------------------------
export interface CatalogItem {
  key: string
  name: string
  category?: string
  description?: string | null
  durationMin?: number
  priceCents?: number
  memberPriceCents?: number
  guestPriceCents?: number
  vipInclusion?: 'included' | 'allowance' | 'none'
  vipNote?: string | null
}

export interface PublicCatalog {
  generatedAt?: string
  guestMarkupPct?: number
  guestBookingFeeCents?: number
  services: CatalogItem[]
  addons: CatalogItem[]
  quotes?: { key: string; name: string; kind?: string; category?: string }[]
  tint?: {
    vehicleTypes: { key: string; label: string }[]
    films: { key: string; label: string }[]
    prices: { vehicle: string; film: string; memberMinCents: number; memberMaxCents: number; guestMinCents: number; guestMaxCents: number }[]
  }
  plans?: { key: string; name?: string; perks?: string[]; priceCents?: number | null }[]
}

/** The keys the site's configuration gives the design's items (site.config.json `catalog`). */
export interface CatalogKeys {
  services: Record<string, { key: string; name: string }>
  addons: Record<string, string>
  plans: Record<string, string>
}

// ---- the design's data model (logic.original.js: WASH, DURING, TINT, VEH, FEE, the plans of joinVM) -------------------
export interface DesignWash {
  id: string
  name: string
  sub: string
  m: number
}
export interface DesignAddon {
  id: string
  name: string
  sub: string
  m: number
  vip?: string
}
/** film -> vehicle type -> [low, high] in dollars */
export type DesignTint = Record<string, Record<string, [number, number]>>

/** The design's own content (the instance fields of the logic class), what the page shows without a ready catalog. */
export interface DesignContent {
  WASH: DesignWash[]
  DURING: DesignAddon[]
  TINT: DesignTint
  VEH: [string, string][]
  FEE: number
}

/** The design's plan prices and perks (joinVM's local `T`) and its other fixed numbers. */
export const DESIGN_PLANS = {
  gold: { price: 99, perks: ['4 hand washes a month, interior included', 'Share across household cars', 'No booking fees', 'Member prices on everything else'] },
  vip: { price: 169, perks: ['Everything in Gold', 'Wax every wash + engine bay', 'Leather 2× and stain removal 1× a month', 'Priority booking and same-day guarantee'] },
} as const
export const DESIGN_MARKUP_PCT = 20
export const DESIGN_DETAIL: readonly { name: string; sub: string; m: number }[] = [
  { name: 'Interior detail', sub: 'Shampoo, steam, leather, glass', m: 149 },
  { name: 'Full detail', sub: 'Inside and out, clay bar + sealant', m: 249 },
]
export const DESIGN_MORE: readonly string[] = ['Windshield replacement', 'Rim powder coating', 'Chrome delete', 'Car key copies']
/** The design's vehicle types (VEH keys: the page's state starts on `sedan`) */
export const DESIGN_VEHICLES: readonly string[] = ['sedan', 'suv', 'truck']
/** The design's film words (G.tintFull) */
export const DESIGN_FILMS: Record<string, string> = { carbon: 'Carbon', ceramic: 'Ceramic' }

/** What a ready catalog gives the page, in the design's units (whole dollars). */
export interface SiteCatalog {
  wash: (DesignWash & { gp: number; durationMin: number })[]
  /** null: the design's add-ons */
  during: (DesignAddon & { gp: number })[] | null
  /** null: the design's tint table */
  tint: { veh: [string, string][]; films: Record<string, string>; member: DesignTint; guest: DesignTint } | null
  /** null: the design's two details */
  detail: { name: string; sub: string; m: number; gp: number }[] | null
  /** null: the design's four quote-only names */
  more: string[] | null
  plans: Record<'gold' | 'vip', { price: number; perks: string[] }>
  fee: number
  markupPct: number
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
const text = (x: unknown): string | null => (typeof x === 'string' && x.trim() !== '' ? x.trim() : null)
/** whole dollars of a non-negative cents value that is a whole number of dollars, else null */
const dollars = (x: unknown, min = 1): number | null =>
  typeof x === 'number' && Number.isInteger(x) && x >= min * 100 && x % 100 === 0 ? x / 100 : null
const itemsOf = (x: unknown): CatalogItem[] =>
  Array.isArray(x) ? (x.filter((i) => isObj(i) && typeof i.key === 'string' && typeof i.name === 'string') as unknown as CatalogItem[]) : []

/** An item's member and guest starting prices in whole dollars, or null when it has none the website can show. */
function pricesOf(i: CatalogItem): { m: number; gp: number } | null {
  const m = dollars(i.memberPriceCents)
  const gp = dollars(i.guestPriceCents)
  return m !== null && gp !== null ? { m, gp } : null
}

export interface WebsiteCatalogResult {
  site: SiteCatalog | null
  /** why the catalog is not used (empty when it is) */
  reason: string
}

/**
 * Decides whether a /public/catalog payload is website-ready and converts it to the design's units. Never throws: an
 * unusable payload answers `site: null` and the reason (the build logs it; the page keeps the design's content).
 */
export function websiteCatalog(raw: unknown, keys: CatalogKeys, design: Pick<DesignContent, 'WASH' | 'DURING' | 'VEH'>): WebsiteCatalogResult {
  const no = (reason: string): WebsiteCatalogResult => ({ site: null, reason })
  if (!isObj(raw)) return no('not a catalog payload')
  if (!Array.isArray(raw.services) || !Array.isArray(raw.addons)) return no('no services/addons lists')
  const services = itemsOf(raw.services)
  const addons = itemsOf(raw.addons)

  // 1. the design's washes, under their keys, with the website fields (the website-catalog seed sets them)
  const wash: SiteCatalog['wash'] = []
  for (const w of design.WASH) {
    const cfg = keys.services[w.id]
    const hit = catalogMatch(services, cfg?.key, cfg?.name || w.name)
    if (!hit) return no(`the catalog has no ${cfg?.key || w.name}`)
    const description = text(hit.description)
    const p = pricesOf(hit)
    const dur = typeof hit.durationMin === 'number' && Number.isInteger(hit.durationMin) && hit.durationMin > 0 ? hit.durationMin : null
    if (!description || !p || !dur) return no(`${hit.key} has no website fields (description, duration, whole-dollar member and guest prices)`)
    wash.push({ id: w.id, name: text(hit.name) ?? w.name, sub: `${description} · about ${dur} min`, m: p.m, gp: p.gp, durationMin: dur })
  }

  // 2. both plans with a monthly price and perks
  const planList = Array.isArray(raw.plans) ? raw.plans.filter(isObj) : []
  const plans = {} as SiteCatalog['plans']
  for (const tier of ['gold', 'vip'] as const) {
    const key = keys.plans[tier] || tier
    const p = planList.find((x) => x.key === key)
    const price = p ? dollars(p.priceCents) : null
    const perks = p && Array.isArray(p.perks) ? p.perks.map(text).filter((x): x is string => !!x) : []
    if (price === null || !perks.length) return no(`the ${tier} plan has no monthly price or perks`)
    plans[tier] = { price, perks }
  }

  // 3. the guest booking fee and the guest markup
  const fee = dollars(raw.guestBookingFeeCents, 0)
  if (fee === null) return no('no whole-dollar guest booking fee')
  const markupPct = typeof raw.guestMarkupPct === 'number' && Number.isInteger(raw.guestMarkupPct) && raw.guestMarkupPct >= 0 ? raw.guestMarkupPct : null
  if (markupPct === null) return no('no guest markup')

  // 4. add-ons: the catalog's own list and order; the design's id for the ones it knows (state and booking keys)
  const designAddon = (i: CatalogItem): DesignAddon | undefined =>
    design.DURING.find((a) => catalogMatch([i], keys.addons[a.id], a.name) !== null)
  const during: NonNullable<SiteCatalog['during']> = []
  for (const i of addons) {
    const sub = text(i.description)
    const p = pricesOf(i)
    if (!sub || !p) continue // not on the website until it has a description and prices
    const vip = i.vipInclusion === 'included' ? 'incl' : i.vipInclusion === 'allowance' ? text(i.vipNote) || 'incl' : undefined
    const id = designAddon(i)?.id ?? i.key
    if (during.some((a) => a.id === id)) continue
    during.push({ id, name: text(i.name)!, sub, m: p.m, gp: p.gp, ...(vip ? { vip } : {}) })
  }

  // 5. detailing: the catalog's detail packages with the website fields
  const detail = services
    .filter((s) => s.category === 'detail')
    .map((s) => ({ s, sub: text(s.description), p: pricesOf(s) }))
    .filter((x) => x.sub && x.p)
    .map((x) => ({ name: text(x.s.name)!, sub: x.sub!, m: x.p!.m, gp: x.p!.gp }))

  // 6. quote-only items
  const more = (Array.isArray(raw.quotes) ? raw.quotes : []).map((q) => (isObj(q) ? text(q.name) : null)).filter((x): x is string => !!x)

  return {
    site: { wash, during: during.length ? during : null, tint: tintOf(raw.tint, design.VEH), detail: detail.length ? detail : null, more: more.length ? more : null, plans, fee, markupPct },
    reason: '',
  }
}

/**
 * The tint matrix in the design's shape, or null (the design's table) unless it prices every vehicle type the design
 * knows (its state starts on them) with both films the design's film switch offers.
 */
function tintOf(raw: unknown, designVeh: [string, string][]): SiteCatalog['tint'] {
  if (!isObj(raw) || !Array.isArray(raw.vehicleTypes) || !Array.isArray(raw.films) || !Array.isArray(raw.prices)) return null
  const veh: [string, string][] = raw.vehicleTypes
    .filter(isObj)
    .map((v) => [text(v.key), text(v.label)] as const)
    .filter((v): v is readonly [string, string] => !!v[0] && !!v[1])
    .map(([k, l]) => [k, l])
  const films: Record<string, string> = {}
  for (const f of raw.films.filter(isObj)) {
    const k = text(f.key)
    const l = text(f.label)
    if (k && l && k in DESIGN_FILMS) films[k] = l
  }
  if (Object.keys(films).length !== Object.keys(DESIGN_FILMS).length) return null
  if (!designVeh.every(([k]) => veh.some(([v]) => v === k))) return null
  const member: DesignTint = {}
  const guest: DesignTint = {}
  for (const film of Object.keys(DESIGN_FILMS)) {
    member[film] = {}
    guest[film] = {}
    for (const [v] of veh) {
      const row = raw.prices.find((p) => isObj(p) && p.vehicle === v && p.film === film) as Record<string, unknown> | undefined
      const r = row ? [dollars(row.memberMinCents), dollars(row.memberMaxCents), dollars(row.guestMinCents), dollars(row.guestMaxCents)] : []
      if (r.length !== 4 || r.some((x) => x === null) || r[0]! > r[1]! || r[2]! > r[3]!) return null
      member[film]![v] = [r[0]!, r[1]!]
      guest[film]![v] = [r[2]!, r[3]!]
    }
  }
  return { veh, films, member, guest }
}

/**
 * The design's items as the site's configuration names them (ids, keys, names), for a readiness check outside the page
 * (the build): the page itself checks against the logic class's own WASH, DURING and VEH.
 */
export function configDesign(keys: CatalogKeys): Pick<DesignContent, 'WASH' | 'DURING' | 'VEH'> {
  return {
    WASH: Object.entries(keys.services).map(([id, s]) => ({ id, name: s.name, sub: '', m: 0 })),
    DURING: Object.entries(keys.addons).map(([id, key]) => ({ id, name: key, sub: '', m: 0 })),
    VEH: DESIGN_VEHICLES.map((k) => [k, k] as [string, string]),
  }
}

/** The design's content with a ready catalog applied (the built-in content when there is none). */
export function designContentOf(site: SiteCatalog | null, design: DesignContent): DesignContent {
  if (!site) return design
  return {
    WASH: site.wash.map(({ id, name, sub, m }) => ({ id, name, sub, m })),
    DURING: site.during ? site.during.map(({ id, name, sub, m, vip }) => ({ id, name, sub, m, ...(vip ? { vip } : {}) })) : design.DURING,
    TINT: site.tint ? site.tint.member : design.TINT,
    VEH: site.tint ? site.tint.veh : design.VEH,
    FEE: site.fee,
  }
}

/** The plain numbers the page's texts are written from (the catalog's, else the design's). */
export interface PriceFacts {
  gold: number
  vip: number
  fee: number
  markupPct: number
  /** the lowest member and guest tint prices ("VIP from $229, guest from $275") */
  tintFrom: [number, number]
}

export function priceFacts(site: SiteCatalog | null, design: DesignContent, g: (m: number) => number): PriceFacts {
  if (!site) {
    const lows = Object.values(design.TINT).flatMap((byVeh) => Object.values(byVeh).map((r) => r[0]))
    const lo = Math.min(...lows)
    return { gold: DESIGN_PLANS.gold.price, vip: DESIGN_PLANS.vip.price, fee: design.FEE, markupPct: DESIGN_MARKUP_PCT, tintFrom: [lo, g(lo)] }
  }
  let tintFrom: [number, number]
  if (site.tint) {
    const t = site.tint
    const rows = Object.keys(t.member).flatMap((f) => t.veh.map(([v]) => [t.member[f]![v]![0], t.guest[f]![v]![0]] as [number, number]))
    tintFrom = [Math.min(...rows.map((r) => r[0])), Math.min(...rows.map((r) => r[1]))]
  } else {
    const lows = Object.values(design.TINT).flatMap((byVeh) => Object.values(byVeh).map((r) => r[0]))
    const lo = Math.min(...lows)
    tintFrom = [lo, g(lo)]
  }
  return { gold: site.plans.gold.price, vip: site.plans.vip.price, fee: site.fee, markupPct: site.markupPct, tintFrom }
}

/**
 * The template's static price texts as `site.cat` values (design-patches/index.patch.json binds each one with a
 * replace-text op, DV-CATALOG). With the design's numbers every string is the design's text, character for character.
 */
export function catalogTexts(f: PriceFacts): Record<string, string> {
  return {
    fromGold: `from $${f.gold}`,
    gold: `$${f.gold}`,
    vip: `$${f.vip}`,
    markupLine: `Guests can book with prices ${f.markupPct}% higher and a `,
    feeTerms: `$${f.fee} non-refundable booking fee`,
    goldMo: `$${f.gold}/mo`,
    vipMo: `$${f.vip}/mo`,
    fee: `$${f.fee}`,
    saveFee: `SAVE $${f.fee}`,
    vipTotal: ` · VIP $${f.vip}`,
    tintFrom: `Carbon and ceramic film. VIP from $${f.tintFrom[0]}, guest from $${f.tintFrom[1]}.`,
    joinVip: `Join VIP · $${f.vip}/mo`,
    barVip: `VIP · $${f.vip}`,
    barGold: `Priority times · Gold from $${f.gold}`,
    included: `This wash is included. Gold $${f.gold} or VIP $${f.vip} a month.`,
    guestFee: `Guest prices · $${f.fee} non-refundable booking fee`,
    ack: `I understand the $${f.fee} booking fee is non-refundable, including if I cancel or don't show.`,
  }
}

/** Replaces the dollar amount `$from` (a whole token: "$25" but not "$250") in a design string. */
export const swapAmount = (s: unknown, from: number, to: number): unknown =>
  typeof s === 'string' && from !== to ? s.replace(new RegExp(`\\$${from}(?![0-9])`, 'g'), () => `$${to}`) : s
