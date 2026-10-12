// DV-CATALOG2: the website's prices BY VEHICLE SIZE from the dashboard's Settings, through GET /api/v1/public/catalog/v2
// (backend ADR 0170 wave Q3d, api-spec 26.1; design q-design-pricing.md section 9). site.config.json `"pricing": "live"`
// (the default stays "interim", DV-PRICE-INTERIM, until the owner has filled the size grid). The page gets a build-time
// snapshot (SITE_CATALOG_JSON with the v2 body) and the bridge applies the API's answer again after mount.
//
// NOTHING IS TRUSTED: every field is checked here; a malformed item, price row, size or tier is dropped (never shown as $0),
// the starting prices are worked out again from the rows that passed, and a price row of a size the payload does not list
// is ignored. The catalog is used only when it is WEBSITE-READY (websiteReadyV2): at least one size, at least one wash with
// a description, a duration and a whole-dollar price, at least one tier sold online that the design can show (its Gold or
// VIP card) with a whole-dollar price and perks, and a whole-dollar booking fee. Anything less keeps the design's own
// content. Inside a ready catalog each section falls back to the design's own content on its own (add-ons, tint,
// detailing, quote-only items, a design tier the catalog does not sell).
//
// Display: whole dollars, rounded half up (money is integer cents). A size without a price is never shown as $0: the
// per-size table lists only priced sizes, the booking sheet says "At the shop" for an unpriced size.
import { catalogMatch, DESIGN_FILMS, DESIGN_STATIC_TEXTS, interimTexts, type CatalogKeys, type DesignAddon, type DesignTint } from './catalog'

// ---- the API's shape (api-spec 26.1 GET /public/catalog/v2) -------------------------------------------------------------
export interface V2Price {
  class: string
  cents: number
  maxCents: number | null
  memberCents: number
  memberMaxCents: number | null
}
export interface V2IncludedIn {
  tier: string
  mode: 'per_cycle' | 'every_visit'
  /** per_cycle: visits a cycle (null: unlimited); null for every_visit */
  perCycle: number | null
}
export interface V2Item {
  key: string
  name: string
  shortName: string | null
  category: string
  description: string | null
  durationMin: number | null
  prices: V2Price[]
  fromCents: number
  fromClass: string | null
  memberFromCents: number
  tintFilm: { key: string; label: string } | null
  includedIn: V2IncludedIn[]
}
export interface V2Inclusion {
  serviceKey: string
  mode: 'per_cycle' | 'every_visit'
  perCycle: number | null
  group: number
}
export interface V2Tier {
  key: string
  name: string
  perks: string[]
  memberDiscountBp: number
  vipBooking: boolean
  householdCars: number | null
  prices: { class: string; monthlyCents: number }[]
  fromMonthlyCents: number
  fromClass: string
  inclusions: V2Inclusion[]
}
export interface CatalogV2 {
  version: 2
  guestBookingFeeCents: number
  guestFeeCollect: 'counter' | 'link'
  vehicleClasses: { key: string; label: string }[]
  memberDisplay: { discountBp: number }
  services: V2Item[]
  addons: V2Item[]
  quotes: { key: string; name: string }[]
  tiers: V2Tier[]
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
const text = (x: unknown): string | null => (typeof x === 'string' && x.trim() !== '' && x.length <= 500 ? x.trim() : null)
const KEY = /^[a-z0-9][a-z0-9_-]{0,79}$/
const keyOf = (x: unknown): string | null => (typeof x === 'string' && KEY.test(x) ? x : null)
/** non-negative integer cents below $100,000 */
const centsOf = (x: unknown): number | null => (typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < 10_000_000 ? x : null)
const intOf = (x: unknown, min: number, max: number): number | null => (typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max ? x : null)

/** Whole dollars of a cents amount, rounded half up (the shop's display rule). */
export const dollarsOf = (cents: number): number => Math.floor((cents + 50) / 100)
/** "$40" */
export const usd = (cents: number): string => '$' + dollarsOf(cents).toLocaleString('en-US')
/** a whole number of dollars */
export const wholeDollars = (cents: number): boolean => cents % 100 === 0
/**
 * The backend's member price (catalog/price-book.ts memberCents, plan decision 2): price x (1 - % off), rounded half up to
 * whole dollars, never above the price; 0 % leaves the price as it is.
 */
export function memberCents(cents: number, discountBp: number): number {
  if (discountBp <= 0) return cents
  if (discountBp >= 10_000) return 0
  return Math.min(cents, Math.floor((cents * (10_000 - discountBp) * 2 + 1_000_000) / 2_000_000) * 100)
}

function includedInOf(x: unknown): V2IncludedIn[] {
  if (!Array.isArray(x)) return []
  const out: V2IncludedIn[] = []
  for (const r of x) {
    if (!isObj(r)) continue
    const tier = keyOf(r.tier)
    const mode = r.mode === 'per_cycle' || r.mode === 'every_visit' ? r.mode : null
    const perCycle = r.perCycle === null || r.perCycle === undefined ? null : intOf(r.perCycle, 1, 999)
    if (!tier || !mode || (r.perCycle !== null && r.perCycle !== undefined && perCycle === null)) continue
    out.push({ tier, mode, perCycle: mode === 'every_visit' ? null : perCycle })
  }
  return out
}

/** One item, or null when it cannot be shown. Price rows of an unknown size, malformed rows and repeats are dropped. */
function itemOf(x: unknown, sizes: string[]): V2Item | null {
  if (!isObj(x)) return null
  const key = keyOf(x.key)
  const name = text(x.name)
  if (!key || !name) return null
  const prices: V2Price[] = []
  if (Array.isArray(x.prices))
    for (const p of x.prices) {
      if (!isObj(p)) continue
      const cls = typeof p.class === 'string' && sizes.includes(p.class) ? p.class : null
      const cents = centsOf(p.cents)
      if (!cls || cents === null || cents === 0 || prices.some((q) => q.class === cls)) continue
      const max = p.maxCents === null || p.maxCents === undefined ? null : centsOf(p.maxCents)
      if (p.maxCents !== null && p.maxCents !== undefined && (max === null || max < cents)) continue
      // a member price above the price, or malformed: one price (the member pays the price)
      const m = centsOf(p.memberCents)
      const memberCents = m !== null && m <= cents ? m : cents
      const mm = p.memberMaxCents === null || p.memberMaxCents === undefined ? null : centsOf(p.memberMaxCents)
      const memberMaxCents = max === null ? null : mm !== null && mm <= max && mm >= memberCents ? mm : max
      prices.push({ class: cls, cents, maxCents: max, memberCents, memberMaxCents })
    }
  prices.sort((a, b) => sizes.indexOf(a.class) - sizes.indexOf(b.class))
  // the starting price is worked out again from the rows that passed (the payload's own is not trusted)
  let fromCents: number
  let fromClass: string | null
  let memberFromCents: number
  if (prices.length) {
    const low = prices.reduce((a, b) => (b.cents < a.cents ? b : a))
    fromCents = low.cents
    fromClass = low.class
    memberFromCents = Math.min(...prices.map((p) => p.memberCents))
  } else {
    // an item without prices by size: its one (base) price, for every size
    const base = centsOf(x.fromCents)
    if (base === null || base === 0) return null
    fromCents = base
    fromClass = null
    const m = centsOf(x.memberFromCents)
    memberFromCents = m !== null && m <= base ? m : base
  }
  const film = isObj(x.tintFilm) ? { key: keyOf(x.tintFilm.key), label: text(x.tintFilm.label) } : null
  return {
    key,
    name,
    shortName: text(x.shortName),
    category: keyOf(x.category) ?? '',
    description: text(x.description),
    durationMin: intOf(x.durationMin, 1, 24 * 60),
    prices,
    fromCents,
    fromClass,
    memberFromCents,
    tintFilm: film && film.key && film.label ? { key: film.key, label: film.label } : null,
    includedIn: includedInOf(x.includedIn),
  }
}

function tierOf(x: unknown, sizes: string[]): V2Tier | null {
  if (!isObj(x)) return null
  const key = keyOf(x.key)
  const name = text(x.name)
  if (!key || !name) return null
  const prices: V2Tier['prices'] = []
  if (Array.isArray(x.prices))
    for (const p of x.prices) {
      if (!isObj(p)) continue
      const cls = typeof p.class === 'string' && sizes.includes(p.class) ? p.class : null
      const c = centsOf(p.monthlyCents)
      if (!cls || c === null || c === 0 || prices.some((q) => q.class === cls)) continue
      prices.push({ class: cls, monthlyCents: c })
    }
  prices.sort((a, b) => sizes.indexOf(a.class) - sizes.indexOf(b.class))
  // a tier without a price is not sold online (plan decision 3)
  if (!prices.length) return null
  const low = prices.reduce((a, b) => (b.monthlyCents < a.monthlyCents ? b : a))
  const inclusions: V2Inclusion[] = []
  if (Array.isArray(x.inclusions))
    for (const r of x.inclusions) {
      if (!isObj(r)) continue
      const serviceKey = keyOf(r.serviceKey)
      const mode = r.mode === 'per_cycle' || r.mode === 'every_visit' ? r.mode : null
      const perCycle = r.perCycle === null || r.perCycle === undefined ? null : intOf(r.perCycle, 1, 999)
      const group = intOf(r.group, 1, 999)
      if (!serviceKey || !mode || group === null || (r.perCycle !== null && r.perCycle !== undefined && perCycle === null)) continue
      inclusions.push({ serviceKey, mode, perCycle: mode === 'every_visit' ? null : perCycle, group })
    }
  return {
    key,
    name,
    perks: Array.isArray(x.perks) ? x.perks.map(text).filter((p): p is string => !!p).slice(0, 12) : [],
    memberDiscountBp: intOf(x.memberDiscountBp, 0, 10_000) ?? 0,
    vipBooking: x.vipBooking === true,
    householdCars: intOf(x.householdCars, 1, 99),
    prices,
    fromMonthlyCents: low.monthlyCents,
    fromClass: low.class,
    inclusions,
  }
}

export interface ParsedV2 {
  cat: CatalogV2 | null
  /** why there is none (empty when there is one) */
  reason: string
}

/** Checks a GET /public/catalog/v2 payload field by field. Never throws. */
export function parseCatalogV2(raw: unknown): ParsedV2 {
  const no = (reason: string): ParsedV2 => ({ cat: null, reason })
  if (!isObj(raw)) return no('not a catalog payload')
  if (raw.version !== 2) return no('not a catalog v2 payload (version 2)')
  const vehicleClasses: CatalogV2['vehicleClasses'] = []
  if (Array.isArray(raw.vehicleClasses))
    for (const v of raw.vehicleClasses) {
      if (!isObj(v)) continue
      const key = keyOf(v.key)
      const label = text(v.label)
      if (key && label && label.length <= 40 && !vehicleClasses.some((x) => x.key === key)) vehicleClasses.push({ key, label })
    }
  const sizes = vehicleClasses.map((v) => v.key)
  const list = (x: unknown) => (Array.isArray(x) ? x.map((i) => itemOf(i, sizes)).filter((i): i is V2Item => !!i) : [])
  const fee = centsOf(raw.guestBookingFeeCents)
  if (fee === null) return no('no booking fee')
  const tiers = Array.isArray(raw.tiers) ? raw.tiers.map((t) => tierOf(t, sizes)).filter((t): t is V2Tier => !!t) : []
  const bp = isObj(raw.memberDisplay) ? intOf(raw.memberDisplay.discountBp, 0, 10_000) : null
  return {
    cat: {
      version: 2,
      guestBookingFeeCents: fee,
      guestFeeCollect: raw.guestFeeCollect === 'link' ? 'link' : 'counter',
      vehicleClasses,
      memberDisplay: { discountBp: bp ?? 0 },
      services: list(raw.services),
      addons: list(raw.addons),
      quotes: Array.isArray(raw.quotes)
        ? raw.quotes.flatMap((q) => {
            if (!isObj(q)) return []
            const key = keyOf(q.key)
            const name = text(q.name)
            return key && name ? [{ key, name }] : []
          })
        : [],
      tiers,
    },
    reason: '',
  }
}

// ---- what the design can show -----------------------------------------------------------------------------------------------
/** The design's tiers (its two plan cards, joinVM's T): Gold and VIP. */
export type DesignTier = 'gold' | 'vip'
export const DESIGN_TIERS: readonly DesignTier[] = ['gold', 'vip']

/** The catalog tier of a design tier: site.config.json catalog.plans names its key (gold -> "gold"). */
export const tierFor = (cat: CatalogV2, keys: CatalogKeys, id: DesignTier): V2Tier | null => cat.tiers.find((t) => t.key === (keys.plans[id] || id)) ?? null

/** A wash of the catalog for one of the design's washes (its configured key, else the design's name). */
export const washFor = (cat: CatalogV2, keys: CatalogKeys, id: string, name: string): V2Item | null => {
  const cfg = keys.services[id]
  return catalogMatch(cat.services, cfg?.key, cfg?.name || name)
}

/** An item the website can list as a priced wash: a description, a duration and a whole-dollar starting price. */
const washReady = (i: V2Item | null): i is V2Item => !!i && !!i.description && !!i.durationMin && wholeDollars(i.fromCents)

export interface ReadyV2 {
  cat: CatalogV2 | null
  reason: string
}

/**
 * Website-ready (design section 9): at least one size; at least one of the design's washes with a description, a
 * duration and a whole-dollar price; at least one of the design's tiers sold online with a whole-dollar price and perks;
 * a whole-dollar booking fee. `cat: null` with the reason otherwise (the build logs it; the page keeps the design's content).
 */
export function websiteReadyV2(raw: unknown, keys: CatalogKeys, designWash: { id: string; name: string }[]): ReadyV2 {
  const p = parseCatalogV2(raw)
  const no = (reason: string): ReadyV2 => ({ cat: null, reason })
  if (!p.cat) return no(p.reason)
  const cat = p.cat
  if (!cat.vehicleClasses.length) return no('no vehicle sizes')
  if (!designWash.some((w) => washReady(washFor(cat, keys, w.id, w.name))))
    return no('no wash of the website (Signature or Exterior Hand Wash) with a description, a duration and a whole-dollar price')
  if (!DESIGN_TIERS.some((id) => {
    const t = tierFor(cat, keys, id)
    return !!t && t.perks.length > 0 && t.prices.every((x) => wholeDollars(x.monthlyCents))
  }))
    return no('no Gold or VIP tier sold online with whole-dollar prices and perks')
  if (!wholeDollars(cat.guestBookingFeeCents)) return no('no whole-dollar booking fee')
  return { cat, reason: '' }
}

// ---- the page's model in the design's units ----------------------------------------------------------------------------------
/**
 * One size's price of an item, in whole dollars (g: the regular "guest" price, m: the member price at the catalog's shown
 * % off; ranges for tint) for display, and in cents (gc, mc) for any sum or difference (rounded once, at the end).
 */
export interface SizePrice {
  g: number
  m: number
  gMax: number | null
  mMax: number | null
  gc: number
  mc: number
}

/** An item as the page shows it. */
export interface LiveItem {
  key: string
  name: string
  sub: string
  /** the starting prices (whole dollars; gc, mc in cents) */
  g: number
  m: number
  gc: number
  mc: number
  /** one price for every size (no "from"): every size priced alike, or an item without prices by size */
  uniform: boolean
  /** priced sizes only, in size order */
  bySize: { class: string; label: string; p: SizePrice }[]
  /** the item has no prices by size: its one price is every size's */
  base: boolean
  includedIn: V2IncludedIn[]
}

export interface LiveTier {
  id: DesignTier
  key: string
  name: string
  perks: string[]
  /** the starting monthly price in whole dollars and its size */
  price: number
  fromClass: string
  /** the priced sizes, in size order */
  prices: { class: string; label: string; price: number }[]
  vipBooking: boolean
  inclusions: V2Inclusion[]
  /** the tier's member % off (basis points) */
  memberDiscountBp: number
}

/** What a ready v2 catalog gives the page. */
export interface LiveCatalog {
  /** the sizes [key, label], smallest first (the design's VEH) */
  sizes: [string, string][]
  /** the design's washes the catalog prices (the design's ids), in the design's order */
  wash: (LiveItem & { id: string; durationMin: number })[]
  /** null: the design's add-ons */
  during: (LiveItem & { id: string; vip?: string })[] | null
  /** null: the design's tint table; the sizes priced for both films, member and guest ranges */
  tint: { veh: [string, string][]; films: Record<string, string>; member: DesignTint; guest: DesignTint } | null
  /** null: the design's two details */
  detail: LiveItem[] | null
  /** null: the design's four quote-only names */
  more: string[] | null
  /** the design's tiers the catalog sells (Gold, VIP) */
  tiers: Partial<Record<DesignTier, LiveTier>>
  /** the booking fee, whole dollars */
  fee: number
  feeCollect: 'counter' | 'link'
  /** the members' % off shown ("prices N% higher" for guests): the lowest of the tiers sold */
  discountBp: number
  /** every catalog item by key (bookings, the sheet's prices) */
  items: Record<string, LiveItem>
}

function liveItem(i: V2Item, sizes: [string, string][], sub: string): LiveItem {
  const label = (k: string) => sizes.find(([s]) => s === k)?.[1] ?? k
  const bySize = i.prices.map((p) => ({
    class: p.class,
    label: label(p.class),
    p: {
      g: dollarsOf(p.cents),
      m: dollarsOf(p.memberCents),
      gMax: p.maxCents === null ? null : dollarsOf(p.maxCents),
      mMax: p.memberMaxCents === null ? null : dollarsOf(p.memberMaxCents),
      gc: p.cents,
      mc: p.memberCents,
    },
  }))
  const base = i.prices.length === 0
  const first = bySize[0]
  const uniform =
    base ||
    (bySize.length === sizes.length &&
      bySize.every((x) => x.p.gMax === null && x.p.g === first!.p.g && x.p.m === first!.p.m))
  return {
    key: i.key,
    name: i.name,
    sub,
    g: dollarsOf(i.fromCents),
    m: dollarsOf(i.memberFromCents),
    gc: i.fromCents,
    mc: i.memberFromCents,
    uniform,
    bySize,
    base,
    includedIn: i.includedIn,
  }
}

/** "incl" (every visit / unlimited) or "2× / mo" for an add-on a tier includes (the design's DURING `vip` field). */
export function inclusionWord(r: { mode: 'per_cycle' | 'every_visit'; perCycle: number | null } | undefined): string | undefined {
  if (!r) return undefined
  return r.mode === 'every_visit' || r.perCycle === null ? 'incl' : `${r.perCycle}× / mo`
}

/**
 * Converts a website-ready catalog to the page's model. `design` names the design's washes and add-ons (ids and names) so
 * the items it knows keep their ids (state and booking keys).
 */
export function liveCatalog(cat: CatalogV2, keys: CatalogKeys, design: { WASH: { id: string; name: string }[]; DURING: DesignAddon[] }): LiveCatalog {
  const sizes: [string, string][] = cat.vehicleClasses.map((v) => [v.key, v.label])
  const items: Record<string, LiveItem> = {}
  for (const i of [...cat.services, ...cat.addons]) items[i.key] = liveItem(i, sizes, i.description ?? '')
  const vipTier = tierFor(cat, keys, 'vip')
  const vipOf = (i: V2Item) => inclusionWord(vipTier ? i.includedIn.find((r) => r.tier === vipTier.key) : undefined)
  // 1. the design's washes the catalog carries with the website's fields (an unpriced or bare one is not listed)
  const wash: LiveCatalog['wash'] = []
  for (const w of design.WASH) {
    const hit = washFor(cat, keys, w.id, w.name)
    if (!washReady(hit)) continue
    wash.push({ ...liveItem(hit, sizes, `${hit.description} · about ${hit.durationMin} min`), id: w.id, durationMin: hit.durationMin! })
  }
  // 2. add-ons: the catalog's own list and order; the design's id for the ones it knows
  const designAddon = (i: V2Item): DesignAddon | undefined => design.DURING.find((a) => catalogMatch([i], keys.addons[a.id], a.name) !== null)
  const during: NonNullable<LiveCatalog['during']> = []
  for (const i of cat.addons) {
    if (!i.description) continue
    const id = designAddon(i)?.id ?? i.key
    if (during.some((a) => a.id === id)) continue
    const vip = vipOf(i)
    during.push({ ...liveItem(i, sizes, i.description), id, ...(vip ? { vip } : {}) })
  }
  // 3. tint: one package per film of the design's switch (carbon, ceramic), priced at the same sizes
  const films: Record<string, string> = {}
  const pkg: Record<string, V2Item> = {}
  for (const s of cat.services)
    if (s.tintFilm && s.tintFilm.key in DESIGN_FILMS && !pkg[s.tintFilm.key] && s.prices.length) {
      pkg[s.tintFilm.key] = s
      films[s.tintFilm.key] = s.tintFilm.label
    }
  let tint: LiveCatalog['tint'] = null
  if (Object.keys(pkg).length === Object.keys(DESIGN_FILMS).length) {
    const veh = sizes.filter(([k]) => Object.values(pkg).every((p) => p.prices.some((x) => x.class === k)))
    if (veh.length) {
      const member: DesignTint = {}
      const guest: DesignTint = {}
      for (const [film, p] of Object.entries(pkg)) {
        member[film] = {}
        guest[film] = {}
        for (const [k] of veh) {
          const r = p.prices.find((x) => x.class === k)!
          member[film]![k] = [dollarsOf(r.memberCents), dollarsOf(r.memberMaxCents ?? r.memberCents)]
          guest[film]![k] = [dollarsOf(r.cents), dollarsOf(r.maxCents ?? r.cents)]
        }
      }
      tint = { veh, films, member, guest }
    }
  }
  // 4. detailing: the catalog's detail packages with a description
  const detail = cat.services.filter((s) => s.category === 'detail' && s.description).map((s) => liveItem(s, sizes, s.description!))
  // 5. quote-only items
  const more = cat.quotes.map((q) => q.name)
  // 6. the design's tiers the catalog sells
  const tiers: LiveCatalog['tiers'] = {}
  for (const id of DESIGN_TIERS) {
    const t = tierFor(cat, keys, id)
    if (!t || !t.perks.length || !t.prices.every((x) => wholeDollars(x.monthlyCents))) continue
    tiers[id] = {
      id,
      key: t.key,
      name: t.name,
      perks: t.perks,
      price: dollarsOf(t.fromMonthlyCents),
      fromClass: t.fromClass,
      prices: t.prices.map((x) => ({ class: x.class, label: sizes.find(([k]) => k === x.class)?.[1] ?? x.class, price: dollarsOf(x.monthlyCents) })),
      vipBooking: t.vipBooking,
      inclusions: t.inclusions,
      memberDiscountBp: t.memberDiscountBp,
    }
  }
  return {
    sizes,
    wash,
    during: during.length ? during : null,
    tint,
    detail: detail.length ? detail : null,
    more: more.length ? more : null,
    tiers,
    fee: dollarsOf(cat.guestBookingFeeCents),
    feeCollect: cat.guestFeeCollect,
    discountBp: cat.memberDisplay.discountBp,
    items,
  }
}

/** An item's price at a size: its own row, or every size's one price for an item without prices by size; null: at the shop. */
export function priceAt(i: LiveItem, size: string): SizePrice | null {
  if (i.base) return { g: i.g, m: i.m, gMax: null, mMax: null, gc: i.gc, mc: i.mc }
  return i.bySize.find((x) => x.class === size)?.p ?? null
}

/**
 * A member's price (cents) at a tier's own % off: the catalog's member price when the tier's % off is the one the catalog
 * shows (memberDisplay), else worked out the way the backend does.
 */
export const memberAt = (p: SizePrice, discountBp: number, shownBp: number): number => (discountBp === shownBp ? p.mc : memberCents(p.gc, discountBp))

/**
 * What a member still pays at the shop (cents) for an item the plan includes, on a car of `size`, the plan priced at
 * `planClass` (plan decision 2, backend price-book priceLine: covered up to min(price at the size, price at the plan size);
 * a plan size without a price is covered up to the starting price; the difference gets no % off). null: the site cannot know
 * it, so it never shows $0 for it: the size has no price (the shop prices it, "Confirm price"), or the plan size is unknown
 * (or no longer listed) and the car costs more than the starting price.
 */
export function sizeDifferenceCents(i: LiveItem, size: string, planClass: string | null, sizes: [string, string][]): number | null {
  const visit = priceAt(i, size)
  if (!visit) return null
  if (visit.gc <= i.gc) return 0
  if (planClass === null || !sizes.some(([k]) => k === planClass)) return null
  return Math.max(0, visit.gc - (priceAt(i, planClass)?.gc ?? i.gc))
}

/** A tier's monthly price at a size (whole dollars), or null when it is not sold at that size. */
export const tierPriceAt = (t: LiveTier, size: string): number | null => t.prices.find((x) => x.class === size)?.price ?? null

/** One price for the tier at every size it is sold at. */
export const tierUniform = (t: LiveTier): boolean => t.prices.every((x) => x.price === t.prices[0]!.price)

/** "N% higher" for guests from the members' % off (0: no member price, no statement). */
export const guestMarkupPct = (bp: number): number => (bp > 0 && bp < 10_000 ? Math.round((10_000 / (10_000 - bp)) * 100 - 100) : 0)

/** "$99" for a tier with one price, "from $129" when its price depends on the size. */
export const tierText = (t: LiveTier): string => (tierUniform(t) ? '' : 'from ') + '$' + t.price

/**
 * The template's static price texts (`site.cat`, the same keys as catalogTexts / interimTexts) from a live catalog: the
 * design's words with the catalog's numbers where the catalog has them, the interim words (DV-PRICE-INTERIM) where it
 * does not (a design tier it does not sell, no tint packages): never the design's old figures. With
 * designCatalogV2() every string is the design's, character for character.
 */
export function liveTexts(l: LiveCatalog): Record<string, string> {
  const t = interimTexts(l.fee)
  const gold = l.tiers.gold
  const vip = l.tiers.vip
  const f = l.fee
  const pct = guestMarkupPct(l.discountBp)
  const from = Math.min(...[gold, vip].filter((x): x is LiveTier => !!x).map((x) => x.price))
  const sig = l.wash.find((w) => w.id === 'signature') ?? null
  const out: Record<string, string> = {
    ...t,
    fromGold: `from $${from}`,
    markupLine: pct > 0 ? `Guests can book with prices ${pct}% higher and a ` : 'Guests can book with a ',
    feeTerms: `$${f} non-refundable booking fee`,
    fee: `$${f}`,
    saveFee: `SAVE $${f}`,
    guestFee: `Guest prices · $${f} non-refundable booking fee`,
    ack: `I understand the $${f} booking fee is non-refundable, including if I cancel or don't show.`,
    memberFee: DESIGN_STATIC_TEXTS.memberFee!,
    calcDisplay: gold && sig ? DESIGN_STATIC_TEXTS.calcDisplay! : 'none',
    priceIntro: vip ? DESIGN_STATIC_TEXTS.priceIntro! : 'Prices by vehicle size. Members never pay the booking fee.',
  }
  if (gold) {
    const uni = tierUniform(gold)
    Object.assign(out, {
      gold: `$${gold.price}`,
      goldPer: uni ? DESIGN_STATIC_TEXTS.goldPer : '/ month and up',
      goldMo: `${tierText(gold)}/mo`,
      barGold: `Priority times · Gold from $${gold.price}`,
    })
  } else Object.assign(out, { barGold: `Priority times · VIP from $${from}` })
  if (vip) {
    const uni = tierUniform(vip)
    Object.assign(out, {
      vip: `$${vip.price}`,
      vipPer: uni ? DESIGN_STATIC_TEXTS.vipPer : '/ month and up',
      vipMo: `${tierText(vip)}/mo`,
      joinVip: `Join VIP · ${tierText(vip)}/mo`,
      barVip: `VIP · $${vip.price}`,
      barPer: DESIGN_STATIC_TEXTS.barPer,
      vipTotal: ` · VIP $${vip.price}`,
      vipFirst: DESIGN_STATIC_TEXTS.vipFirst,
      upsellHead: DESIGN_STATIC_TEXTS.upsellHead,
    })
  }
  out.included = `This wash is included. ${[gold ? `Gold ${tierText(gold)}` : '', vip ? `VIP ${tierText(vip)}` : ''].filter(Boolean).join(' or ')} a month.`
  // the wash cards: "Guest $54" when both of the design's washes are priced, else each card's own words
  const both = ['signature', 'exterior'].every((id) => l.wash.some((w) => w.id === id))
  out.cardGuest = both ? DESIGN_STATIC_TEXTS.cardGuest! : ''
  if (l.tint) {
    const tt = l.tint
    const rows = Object.keys(tt.member).flatMap((film) => tt.veh.map(([k]) => [tt.member[film]![k]![0], tt.guest[film]![k]![0]] as [number, number]))
    const m = Math.min(...rows.map((r) => r[0]))
    const g = Math.min(...rows.map((r) => r[1]))
    const same = rows.every((r) => r[0] === r[1])
    out.tintFrom = same ? `Carbon and ceramic film. From $${g}.` : `Carbon and ceramic film. VIP from $${m}, guest from $${g}.`
    out.tintLead = same ? '' : DESIGN_STATIC_TEXTS.tintLead!
    out.tintSep = same ? '' : DESIGN_STATIC_TEXTS.tintSep!
  }
  return out
}
