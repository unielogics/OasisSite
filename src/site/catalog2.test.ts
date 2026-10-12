/* eslint-disable @typescript-eslint/no-explicit-any */
// DV-CATALOG2: the catalog v2 checks (nothing trusted), the website-ready rule and the page's model (src/site/catalog2.ts).
import { describe, expect, it } from 'vitest'
import { designCatalogV2, seededCatalogV2, sizedCatalogV2, unseededCatalogV2 } from '../../tools/site/catalog-fixture'
import { catalogTexts, DESIGN_PLANS, priceFacts, type CatalogKeys } from './catalog'
import { dollarsOf, guestMarkupPct, liveCatalog, liveTexts, memberAt, memberCents, parseCatalogV2, priceAt, sizeDifferenceCents, tierPriceAt, tierUniform, usd, websiteReadyV2, type CatalogV2 } from './catalog2'

const KEYS: CatalogKeys = {
  services: { signature: { key: 'signature-hand-wash', name: 'Signature Hand Wash' }, exterior: { key: 'exterior-hand-wash', name: 'Exterior Hand Wash' } },
  addons: { wax: 'hand-wax', engine: 'engine-bay-wash', leather: 'leather-conditioning', stain: 'stain-removal', tire: 'tire-shine-and-dressing', rain: 'rain-repellent-glass', odor: 'odor-removal', pet: 'pet-hair-removal', deep: 'interior-deep-clean' },
  plans: { gold: 'gold', vip: 'vip' },
}
const WASH = [
  { id: 'signature', name: 'Signature Hand Wash' },
  { id: 'exterior', name: 'Exterior Hand Wash' },
]
const DURING = [
  { id: 'wax', name: 'Hand wax', sub: '', m: 39, vip: 'incl' },
  { id: 'engine', name: 'Engine bay wash', sub: '', m: 45, vip: 'incl' },
  { id: 'leather', name: 'Leather conditioning', sub: '', m: 35, vip: '2× / mo' },
  { id: 'stain', name: 'Stain removal', sub: '', m: 59, vip: '1× / mo' },
  { id: 'tire', name: 'Tire shine & dressing', sub: '', m: 12 },
  { id: 'rain', name: 'Rain-repellent glass', sub: '', m: 25 },
  { id: 'odor', name: 'Odor removal', sub: '', m: 30 },
  { id: 'pet', name: 'Pet hair removal', sub: '', m: 35 },
  { id: 'deep', name: 'Interior deep clean', sub: '', m: 60 },
]
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T
const ready = (raw: unknown): CatalogV2 => {
  const r = websiteReadyV2(raw, KEYS, WASH)
  if (!r.cat) throw new Error(r.reason)
  return r.cat
}

describe('money', () => {
  it('whole dollars round half up', () => {
    expect(dollarsOf(4050)).toBe(41)
    expect(dollarsOf(4049)).toBe(40)
    expect(dollarsOf(4000)).toBe(40)
    expect(usd(123456)).toBe('$1,235')
  })
  it('guests pay N% more from the members % off', () => {
    expect(guestMarkupPct(1667)).toBe(20)
    expect(guestMarkupPct(0)).toBe(0)
    expect(guestMarkupPct(10_000)).toBe(0)
  })
  it('a member price at a tier\'s own % off follows the backend (price-book memberCents): half up to whole dollars, never above', () => {
    expect(memberCents(3000, 1500)).toBe(2600) // 25.50 -> 26
    expect(memberCents(1200, 1500)).toBe(1000) // 10.20 -> 10
    expect(memberCents(4549, 0)).toBe(4549)
    expect(memberCents(4549, 10_000)).toBe(0)
    expect(memberCents(50, 100)).toBe(0) // 0.495 -> 0, never above the price
    expect(memberCents(4050, 1)).toBe(4000) // 40.4959 -> 40
  })
})

describe('parseCatalogV2: nothing trusted', () => {
  it('refuses what is not a v2 payload', () => {
    expect(parseCatalogV2(null).cat).toBeNull()
    expect(parseCatalogV2([]).cat).toBeNull()
    expect(parseCatalogV2({ ...designCatalogV2(), version: 1 }).reason).toMatch(/version 2/)
    expect(parseCatalogV2({ ...designCatalogV2(), guestBookingFeeCents: -1 }).reason).toMatch(/fee/)
    expect(parseCatalogV2({ ...designCatalogV2(), guestBookingFeeCents: '2500' }).cat).toBeNull()
  })

  it('drops malformed items, price rows and sizes; never invents a $0 price', () => {
    const raw: any = clone(designCatalogV2())
    raw.vehicleClasses.push({ key: 'Bad Key', label: 'x' }, { key: 'van', label: '' }, { key: 'sedan', label: 'again' })
    raw.services[0].prices = [
      { class: 'sedan', cents: 5400, maxCents: null, memberCents: 4500, memberMaxCents: null },
      { class: 'sedan', cents: 9900, maxCents: null, memberCents: 9900, memberMaxCents: null }, // a repeat
      { class: 'boat', cents: 100, maxCents: null, memberCents: 100, memberMaxCents: null }, // an unknown size
      { class: 'suv', cents: 0, maxCents: null, memberCents: 0, memberMaxCents: null }, // $0: not a price
      { class: 'truck', cents: 60.5, maxCents: null, memberCents: 50, memberMaxCents: null }, // not cents
    ]
    raw.services[1].key = 'Exterior Hand Wash' // not a key
    raw.addons[0].prices[0].memberCents = 999999 // above the price: one price
    raw.addons[1].prices[1].maxCents = 100 // a range below its start: dropped
    raw.addons.push({ key: 'ghost', name: 'Ghost', prices: [], fromCents: 0 }, 'nope', { key: 'no-name' })
    const cat = parseCatalogV2(raw).cat!
    expect(cat.vehicleClasses.map((v) => v.key)).toEqual(['sedan', 'suv', 'truck'])
    const sig = cat.services.find((s) => s.key === 'signature-hand-wash')!
    expect(sig.prices).toEqual([{ class: 'sedan', cents: 5400, maxCents: null, memberCents: 4500, memberMaxCents: null }])
    // the starting price is worked out again from what passed
    expect([sig.fromCents, sig.fromClass, sig.memberFromCents]).toEqual([5400, 'sedan', 4500])
    expect(cat.services.some((s) => s.name === 'Exterior Hand Wash')).toBe(false)
    expect(cat.addons[0]!.prices[0]!.memberCents).toBe(cat.addons[0]!.prices[0]!.cents)
    expect(cat.addons[1]!.prices.map((p) => p.class)).toEqual(['sedan', 'truck'])
    expect(cat.addons.map((a) => a.key)).not.toContain('ghost')
    expect(cat.addons.map((a) => a.key)).not.toContain('no-name')
  })

  it('a starting price the payload states but its rows do not support is not believed', () => {
    const raw: any = clone(designCatalogV2())
    raw.services[0].fromCents = 100
    raw.services[0].memberFromCents = 50
    const sig = parseCatalogV2(raw).cat!.services[0]!
    expect([sig.fromCents, sig.memberFromCents]).toEqual([5400, 4500])
  })

  it('an item without prices by size keeps its one (base) price; without one it is left out', () => {
    const raw: any = clone(designCatalogV2())
    raw.addons[0].prices = []
    raw.addons[0].fromCents = 4700
    raw.addons[1].prices = []
    raw.addons[1].fromCents = 0
    const cat = parseCatalogV2(raw).cat!
    expect(cat.addons[0]).toMatchObject({ key: 'hand-wax', prices: [], fromCents: 4700, fromClass: null })
    expect(cat.addons.some((a) => a.key === 'engine-bay-wash')).toBe(false)
  })

  it('a tier without a price at a listed size is not sold; inclusions are checked', () => {
    const raw: any = clone(designCatalogV2())
    raw.tiers[1].prices = [{ class: 'boat', monthlyCents: 100 }]
    raw.tiers[0].inclusions.push({ serviceKey: 'x', mode: 'weekly', perCycle: 1, group: 1 }, { serviceKey: 'y', mode: 'per_cycle', perCycle: -2, group: 1 })
    raw.tiers[0].fromMonthlyCents = 1
    const cat = parseCatalogV2(raw).cat!
    expect(cat.tiers.map((t) => t.key)).toEqual(['gold'])
    expect(cat.tiers[0]!.inclusions.map((i) => i.serviceKey)).toEqual(['signature-hand-wash', 'exterior-hand-wash'])
    expect(cat.tiers[0]!.fromMonthlyCents).toBe(9900)
  })
})

describe('websiteReadyV2', () => {
  it('the design fixture, a seeded production and a filled grid are ready', () => {
    for (const c of [designCatalogV2(), seededCatalogV2(), sizedCatalogV2()]) expect(websiteReadyV2(c, KEYS, WASH).reason).toBe('')
  })

  it('production before the website-catalog seed is not: none of the website washes has its fields', () => {
    expect(websiteReadyV2(unseededCatalogV2(), KEYS, WASH).reason).toMatch(/no wash of the website/)
  })

  it('each rule on its own', () => {
    const base = () => clone(seededCatalogV2()) as any
    const noSizes = base()
    noSizes.vehicleClasses = []
    expect(websiteReadyV2(noSizes, KEYS, WASH).reason).toBe('no vehicle sizes')
    const noDesc = base()
    noDesc.services[0].description = null
    expect(websiteReadyV2(noDesc, KEYS, WASH).reason).toMatch(/no wash/)
    const cents = base()
    cents.services[0].prices[0].cents = 4050
    expect(websiteReadyV2(cents, KEYS, WASH).reason).toMatch(/no wash/)
    const noPerks = base()
    noPerks.tiers[0].perks = []
    expect(websiteReadyV2(noPerks, KEYS, WASH).reason).toMatch(/Gold or VIP/)
    const otherTier = base()
    otherTier.tiers[0].key = 'family'
    expect(websiteReadyV2(otherTier, KEYS, WASH).reason).toMatch(/Gold or VIP/)
    const fee = base()
    fee.guestBookingFeeCents = 2550
    expect(websiteReadyV2(fee, KEYS, WASH).reason).toMatch(/fee/)
  })
})

describe('liveCatalog: the page model', () => {
  it('the design fixture gives the design its own content back', () => {
    const l = liveCatalog(ready(designCatalogV2()), KEYS, { WASH, DURING })
    expect(l.sizes).toEqual([
      ['sedan', 'Sedan / Coupe'],
      ['suv', 'SUV / Crossover'],
      ['truck', 'Truck / Van'],
    ])
    expect(l.wash.map((w) => [w.id, w.name, w.sub, w.m, w.g, w.uniform])).toEqual([
      ['signature', 'Signature Hand Wash', 'Exterior + interior · about 45 min', 45, 54, true],
      ['exterior', 'Exterior Hand Wash', 'Foam, hand wash, wheels, hand dry · about 30 min', 32, 38, true],
    ])
    expect(l.during!.map((a) => [a.id, a.m, a.g, a.vip])).toEqual(DURING.map((a) => [a.id, a.m, Math.round(a.m * 1.2), a.vip]))
    expect(l.tint!.member).toEqual({ carbon: { sedan: [229, 279], suv: [269, 329], truck: [249, 299] }, ceramic: { sedan: [379, 449], suv: [429, 529], truck: [399, 479] } })
    expect(l.tint!.guest.carbon!.sedan).toEqual([275, 335])
    expect(l.detail!.map((d) => [d.name, d.m, d.g])).toEqual([
      ['Interior detail', 149, 179],
      ['Full detail', 249, 299],
    ])
    expect(l.tiers.gold).toMatchObject({ price: DESIGN_PLANS.gold.price, perks: [...DESIGN_PLANS.gold.perks] })
    expect(l.tiers.vip).toMatchObject({ price: DESIGN_PLANS.vip.price, vipBooking: true })
    expect(l.fee).toBe(25)
  })

  it('a filled grid: from-prices, per-size rows, unpriced sizes, two tier prices', () => {
    const l = liveCatalog(ready(sizedCatalogV2()), KEYS, { WASH, DURING })
    const sig = l.wash[0]!
    expect([sig.g, sig.m, sig.uniform, sig.bySize.length]).toEqual([40, 36, false, 5])
    expect(priceAt(sig, 'large_suv')).toEqual({ g: 70, m: 63, gMax: null, mMax: null, gc: 7000, mc: 6300 })
    expect([sig.gc, sig.mc]).toEqual([4000, 3600])
    const ext = l.wash[1]!
    expect(ext.bySize.map((x) => x.label)).toEqual(['Compact car', 'Large car'])
    expect(priceAt(ext, 'truck')).toBeNull()
    expect(l.tint!.veh.length).toBe(5)
    expect(l.tint!.guest.carbon!.truck).toEqual([330, 390])
    const gold = l.tiers.gold!
    expect([gold.price, tierUniform(gold), tierPriceAt(gold, 'large_suv'), tierPriceAt(gold, 'truck')]).toEqual([129, false, 159, null])
    expect([gold.memberDiscountBp, l.tiers.vip!.memberDiscountBp, l.discountBp]).toEqual([1000, 1500, 1000])
  })

  it('a member price at a tier\'s % off: the catalog\'s own when the tier\'s % off is the one it shows, else worked out', () => {
    const l = liveCatalog(ready(sizedCatalogV2()), KEYS, { WASH, DURING })
    const ext = priceAt(l.wash[1]!, 'compact_car')!
    expect(memberAt(ext, 1000, l.discountBp)).toBe(2700)
    expect(memberAt(ext, 1500, l.discountBp)).toBe(2600)
  })

  it('the size difference of an included item, in cents (ADR 0170: covered up to the plan-size price)', () => {
    const raw = sizedCatalogV2()
    // Signature: $40.50 at Large car, $45.49 at Large SUV (cents a whole-dollar display would round apart)
    raw.services[0]!.prices = raw.services[0]!.prices.map((p) => (p.class === 'large_car' ? { ...p, cents: 4050, memberCents: 3600 } : p.class === 'large_suv' ? { ...p, cents: 4549, memberCents: 4100 } : p))
    const l = liveCatalog(ready(raw), KEYS, { WASH, DURING })
    const [sig, ext] = [l.wash[0]!, l.wash[1]!]
    expect(sizeDifferenceCents(sig, 'large_suv', 'large_car', l.sizes)).toBe(499) // $5, not $45 - $41 = $4
    expect(dollarsOf(sizeDifferenceCents(sig, 'large_suv', 'large_car', l.sizes)!)).toBe(5)
    expect(sizeDifferenceCents(sig, 'large_car', 'large_suv', l.sizes)).toBe(0) // a smaller car than the plan size
    expect(sizeDifferenceCents(sig, 'compact_car', null, l.sizes)).toBe(0) // the starting price: nothing to add, whatever the plan
    expect(sizeDifferenceCents(sig, 'truck', null, l.sizes)).toBeNull() // the plan size unknown
    expect(sizeDifferenceCents(sig, 'truck', 'retired_size', l.sizes)).toBeNull() // a plan size the catalog no longer lists
    // Exterior has no price at the SUV sizes: the shop prices it, the difference is not known
    expect(sizeDifferenceCents(ext, 'large_suv', 'compact_car', l.sizes)).toBeNull()
    expect(sizeDifferenceCents(ext, 'large_suv', 'large_suv', l.sizes)).toBeNull()
    expect(sizeDifferenceCents(ext, 'large_car', 'compact_car', l.sizes)).toBe(500)
    // a plan size without a price: covered up to the starting price (backend planSizeCents -> the from price)
    expect(sizeDifferenceCents(ext, 'large_car', 'truck', l.sizes)).toBe(500)
  })

  it('production after the seeds: only the Signature wash and Gold; every other section falls back', () => {
    const l = liveCatalog(ready(seededCatalogV2()), KEYS, { WASH, DURING })
    expect(l.wash.map((w) => [w.id, w.g, w.uniform])).toEqual([['signature', 40, false]])
    expect([l.during, l.tint, l.detail, l.more, l.tiers.vip]).toEqual([null, null, null, null, undefined])
    expect(l.tiers.gold!.price).toBe(129)
  })
})

describe('liveTexts', () => {
  it('the design fixture writes the design\'s own texts', () => {
    const l = liveCatalog(ready(designCatalogV2()), KEYS, { WASH, DURING })
    const design = catalogTexts(priceFacts(null, { WASH: [], DURING: [], TINT: { carbon: { sedan: [229, 279], suv: [269, 329], truck: [249, 299] }, ceramic: { sedan: [379, 449], suv: [429, 529], truck: [399, 479] } }, VEH: [], FEE: 25 }, (m) => Math.round(m * 1.2)))
    expect(liveTexts(l)).toEqual(design)
  })

  it('a filled grid: "from" prices, no "% higher" at 0% off, VIP at one price', () => {
    const l = liveCatalog(ready(sizedCatalogV2()), KEYS, { WASH, DURING })
    const t = liveTexts(l)
    expect(t.fromGold).toBe('from $129')
    expect(t.goldMo).toBe('from $129/mo')
    expect(t.goldPer).toBe('/ month and up')
    expect(t.vipMo).toBe('$199/mo')
    expect(t.included).toBe('This wash is included. Gold from $129 or VIP $199 a month.')
    expect(t.markupLine).toBe('Guests can book with prices 11% higher and a ')
    const zero = liveCatalog(ready({ ...sizedCatalogV2(), memberDisplay: { discountBp: 0 } }), KEYS, { WASH, DURING })
    expect(liveTexts(zero).markupLine).toBe('Guests can book with a ')
  })

  it('production after the seeds: VIP and tint keep the interim words, never a design figure', () => {
    const t = liveTexts(liveCatalog(ready(seededCatalogV2()), KEYS, { WASH, DURING }))
    expect(t).toMatchObject({ vip: 'Ask us', vipMo: 'Ask us', joinVip: 'Join VIP', barVip: 'VIP · Ask us', vipTotal: '', tintFrom: 'Carbon and ceramic film. Priced by vehicle size — ask us.', included: 'This wash is included. Gold $129 a month.', cardGuest: '' })
    const all = Object.values(t).join(' ')
    expect(all.match(/\$\d+/g)?.filter((x) => !['$129', '$25', '$0'].includes(x)) ?? []).toEqual([])
  })
})
