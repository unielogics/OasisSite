// DV-CATALOG: when is a /public/catalog payload website-ready, and what the page takes from it (src/site/catalog.ts).
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { designCatalog, unseededCatalog, withMemberPrice } from '../../tools/site/catalog-fixture'
import { catalogTexts, configDesign, DESIGN_PLANS, DESIGN_VEHICLES, priceFacts, swapAmount, websiteCatalog, type CatalogKeys } from './catalog'
import { designComponent, ROOT } from './bridge.testkit'

const keys = (JSON.parse(fs.readFileSync(path.join(ROOT, 'site.config.json'), 'utf8')) as { catalog: CatalogKeys }).catalog
const design = () => {
  const c = new (designComponent())({})
  return { WASH: c.WASH, DURING: c.DURING, TINT: c.TINT, VEH: c.VEH, FEE: c.FEE }
}
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T

describe('the design catalog fixture is the design (what the website-catalog seed produces)', () => {
  it('converts to exactly the design logic class\'s WASH, DURING, TINT, VEH and FEE, and its plans', () => {
    const d = design()
    const { site, reason } = websiteCatalog(designCatalog(), keys, d)
    expect(reason).toBe('')
    expect(site!.wash.map(({ id, name, sub, m }) => ({ id, name, sub, m }))).toEqual(d.WASH)
    expect(site!.during!.map(({ id, name, sub, m, vip }) => ({ id, name, sub, m, ...(vip ? { vip } : {}) }))).toEqual(d.DURING)
    expect(site!.tint!.member).toEqual(d.TINT)
    expect(site!.tint!.veh).toEqual(d.VEH)
    expect(site!.fee).toBe(d.FEE)
    expect(site!.plans).toEqual({ gold: { price: 99, perks: [...DESIGN_PLANS.gold.perks] }, vip: { price: 169, perks: [...DESIGN_PLANS.vip.perks] } })
    // the design's guest rule g(m) = round(m * 1.2) gives the catalog's guest prices
    for (const x of [...site!.wash, ...site!.during!, ...site!.detail!]) expect(x.gp).toBe(Math.round(x.m * 1.2))
    for (const film of Object.keys(site!.tint!.member))
      for (const [v] of site!.tint!.veh) expect(site!.tint!.guest[film]![v]).toEqual(site!.tint!.member[film]![v]!.map((m) => Math.round(m * 1.2)))
    expect(DESIGN_VEHICLES).toEqual(d.VEH.map(([k]: [string, string]) => k))
  })

  it('the template texts read the design\'s words with its numbers, and the catalog\'s numbers with a ready one', () => {
    const d = design()
    const builtIn = catalogTexts(priceFacts(null, d, (m) => Math.round(m * 1.2)))
    expect(builtIn).toMatchObject({
      fromGold: 'from $99',
      markupLine: 'Guests can book with prices 20% higher and a ',
      tintFrom: 'Carbon and ceramic film. VIP from $229, guest from $275.',
      ack: "I understand the $25 booking fee is non-refundable, including if I cancel or don't show.",
      included: 'This wash is included. Gold $99 or VIP $169 a month.',
    })
    const ready = websiteCatalog(designCatalog(), keys, d).site
    expect(catalogTexts(priceFacts(ready, d, (m) => Math.round(m * 1.2)))).toEqual(builtIn)
    const cat = clone(designCatalog())
    cat.plans[0]!.priceCents = 10900
    cat.guestBookingFeeCents = 3000
    cat.tint.prices[0]!.memberMinCents = 21900
    cat.tint.prices[0]!.guestMinCents = 26300
    const t = catalogTexts(priceFacts(websiteCatalog(cat, keys, d).site, d, (m) => m))
    expect(t).toMatchObject({ gold: '$109', fee: '$30', saveFee: 'SAVE $30', barGold: 'Priority times · Gold from $109', tintFrom: 'Carbon and ceramic film. VIP from $219, guest from $263.' })
  })
})

describe('websiteCatalog: only a website-ready catalog is used (SAFETY)', () => {
  const d = () => design()
  const notReady = (raw: unknown) => websiteCatalog(raw, keys, d())

  it('production before the website-catalog seed is not ready: the design\'s content stays', () => {
    const r = notReady(unseededCatalog())
    expect(r.site).toBeNull()
    expect(r.reason).toMatch(/signature-hand-wash/)
  })

  it('anything that is not a catalog payload is not ready (never throws)', () => {
    for (const raw of [null, undefined, 'x', 42, [], {}, { services: 'x', addons: [] }, { services: [], addons: [] }, { services: [null, 1], addons: [{}] }])
      expect(notReady(raw).site).toBeNull()
  })

  it('a wash without its website fields, a plan without a price or perks, cents in a price or no fee: not ready', () => {
    const cases: [string, (c: ReturnType<typeof designCatalog>) => void][] = [
      ['no description', (c) => (c.services[0]!.description = '' as never)],
      ['no member price', (c) => delete (c.services[1] as Record<string, unknown>).memberPriceCents],
      ['cents', (c) => (c.services[0]!.guestPriceCents = 5450)],
      ['no duration', (c) => (c.services[0]!.durationMin = 0)],
      ['renamed key', (c) => ((c.services[1]!.key = 'exterior-wash'), (c.services[1]!.name = 'Exterior Wash'))],
      ['plan price', (c) => (c.plans[1]!.priceCents = null)],
      ['plan perks', (c) => (c.plans[0]!.perks = [])],
      ['fee', (c) => (c.guestBookingFeeCents = 2550)],
      ['markup', (c) => delete (c as Record<string, unknown>).guestMarkupPct],
    ]
    for (const [what, edit] of cases) {
      const c = clone(designCatalog())
      edit(c)
      expect(notReady(c).site, what).toBeNull()
    }
  })

  it('inside a ready catalog each section falls back to the design on its own (never an empty list)', () => {
    const c = clone(designCatalog())
    c.addons = c.addons.map((a) => ({ ...a, description: null })) as never
    c.services = c.services.filter((s) => s.category !== 'detail')
    c.quotes = []
    c.tint.prices = c.tint.prices.filter((p) => p.vehicle !== 'truck')
    const site = websiteCatalog(c, keys, d()).site!
    expect(site).not.toBeNull()
    expect(site.during).toBeNull()
    expect(site.detail).toBeNull()
    expect(site.more).toBeNull()
    expect(site.tint).toBeNull()
  })

  it('a tint matrix without a film the design switches between, or without one of its vehicle types, is the design\'s table', () => {
    const noCeramic = clone(designCatalog())
    noCeramic.tint.films = noCeramic.tint.films.filter((f) => f.key !== 'ceramic')
    expect(websiteCatalog(noCeramic, keys, d()).site!.tint).toBeNull()
    const noSedan = clone(designCatalog())
    noSedan.tint.vehicleTypes = noSedan.tint.vehicleTypes.filter((v) => v.key !== 'sedan')
    expect(websiteCatalog(noSedan, keys, d()).site!.tint).toBeNull()
  })

  it('add-ons follow the catalog: its order, a new one under its key, one it dropped is gone, the design\'s ids kept', () => {
    const c = clone(designCatalog())
    c.addons = c.addons.filter((a) => a.key !== 'odor-removal')
    c.addons.unshift({ ...c.addons[0]!, key: 'headlight-restoration', name: 'Headlight restoration', description: 'Sand, polish, seal', memberPriceCents: 4000, guestPriceCents: 4800, priceCents: 4800, vipInclusion: 'none', vipNote: null })
    const site = websiteCatalog(c, keys, d()).site!
    expect(site.during!.map((a) => a.id)).toEqual(['headlight-restoration', 'wax', 'engine', 'leather', 'stain', 'tire', 'rain', 'pet', 'deep'])
    expect(site.during![0]).toEqual({ id: 'headlight-restoration', name: 'Headlight restoration', sub: 'Sand, polish, seal', m: 40, gp: 48 })
  })

  it('a changed price is the new starting price (member and guest), never priceCents', () => {
    const c = withMemberPrice(designCatalog(), 'signature-hand-wash', 50)
    c.services[0]!.priceCents = 99900
    const site = websiteCatalog(c, keys, d()).site!
    expect(site.wash[0]).toMatchObject({ id: 'signature', m: 50, gp: 60, sub: 'Exterior + interior · about 45 min' })
  })

  it('the build checks readiness from the configuration alone (no logic class)', () => {
    expect(websiteCatalog(designCatalog(), keys, configDesign(keys)).site).not.toBeNull()
    expect(websiteCatalog(unseededCatalog(), keys, configDesign(keys)).site).toBeNull()
  })
})

describe('swapAmount', () => {
  it('replaces a whole dollar token only', () => {
    expect(swapAmount('$25 due at the counter. Pay $250 after', 25, 30)).toBe('$30 due at the counter. Pay $250 after')
    expect(swapAmount('I agree to be billed $99 a month', 99, 109)).toBe('I agree to be billed $109 a month')
    expect(swapAmount('$0', 25, 30)).toBe('$0')
    expect(swapAmount(5, 25, 30)).toBe(5)
  })
})
