// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
// DV-CATALOG2 (site.config.json pricing "live") against the REAL design logic (bridge.testkit.ts): prices by vehicle size from
// GET /api/v1/public/catalog/v2 (build snapshot + the refresh after mount). The design fixture (designCatalogV2) gives the
// design back value for value (the parity proof in a unit test); a catalog that is not website-ready gives the interim prices
// (DV-PRICE-INTERIM) value for value; a filled grid shows "from" prices, per-size rows, the sheet priced for the chosen size,
// the size difference of a member's included wash, the join flow's size picker and the size in both requests.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeVals } from '../dc/serialize'
import { designCatalogV2, seededCatalogV2, sizedCatalogV2, unseededCatalogV2 } from '../../tools/site/catalog-fixture'
import { makeSite as makeAnySite, payload, type Handler, type SiteOptions } from './bridge.testkit'
import { INTERIM } from './catalog'

const makeSite = (o: SiteOptions = {}) => makeAnySite({ pricing: 'live', ...o })

beforeAll(() => {
  process.env.TZ = 'America/New_York'
})
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T10:00:00-04:00'))
  window.scrollTo = (() => {}) as any
  ;(window as any).__oasisNavigate = () => {}
})
afterEach(() => {
  vi.useRealTimers()
  delete (window as any).__oasisNavigate
})

const ok = (body: unknown, status = 200): ReturnType<Handler> => ({ status, body })
const board = payload([
  { date: '2026-10-10', slots: [[960, 'open', 2]] },
  { date: '2026-10-11', slots: [], closed: true },
  { date: '2026-10-12', slots: [[540, 'open', 3], [570, 'last', 1]] },
])

/** Every state a price appears in (bridge-catalog.test.ts's list plus the flipped rows and both washes). */
function states(c: any): Record<string, any>[] {
  const bk = c.state.bk
  const jn = c.state.jn
  const out: Record<string, any>[] = [{}, { washes: 1 }, { washes: 2 }, { washes: 3 }, { priceRevealed: true }]
  for (const page of ['wash', 'tint', 'detailing', 'membership', 'experience', 'visit']) out.push({ page }, { page, priceRevealed: true })
  for (const [film, tintVeh] of [['carbon', 'suv'], ['ceramic', 'truck'], ['carbon', 'sedan']]) out.push({ page: 'tint', film, tintVeh })
  for (const tier of ['gold', 'vip']) for (const step of [0, 1, 2, 3, 4]) out.push({ page: 'join', jn: { ...jn, tier, step, name: 'Jo Park', agree: step > 2 } })
  const sheet = (who: string, step: string, tier: string | null, svc: string, addons: string[]) => ({ page: 'home', sheet: 'book', step, tier, bk: { ...bk, who, svc, addons, day: 1, slot: 540 } })
  for (const step of ['who', 'svc', 'time', 'review', 'done'])
    for (const svc of ['signature', 'exterior']) {
      out.push(sheet('guest', step, null, svc, ['wax', 'tire', 'leather']))
      out.push(sheet('member', step, 'vip', svc, ['wax', 'stain', 'deep']))
      out.push(sheet('member', step, 'gold', svc, ['engine', 'rain']))
    }
  return out
}

function valsOver(t: ReturnType<typeof makeSite>, list: Record<string, any>[]): unknown[] {
  const base = t.c.state
  return list.map((st) => {
    t.c.state = { ...base, ...st }
    return serializeVals(t.c.renderVals())
  })
}

const routes = (cat: unknown, extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  '/api/v1/public/catalog/v2': () => ok(cat),
  '/api/v1/public/availability': () => ok(board),
  ...extra,
})

describe('the design fixture renders the design, value for value', () => {
  it('build snapshot: every price state equals the design\'s own content', () => {
    // the design's content: the catalog price mode without a catalog (the bridge changes no price)
    const plain = makeAnySite({ pricing: 'catalog', booking: 'sms', availability: board })
    const list = states(plain.c)
    const want = valsOver(plain, list)
    const live = makeSite({ booking: 'sms', availability: board, catalog: designCatalogV2() })
    expect(live.env.catalogSource).toBe('SITE_CATALOG_JSON')
    expect(live.c.__live).not.toBeNull()
    const got = valsOver(live, list)
    for (let i = 0; i < list.length; i++) expect(got[i], JSON.stringify(list[i]).slice(0, 140)).toEqual(want[i])
  })

  it('the refresh after mount (no snapshot): the applied catalog changes nothing either', async () => {
    const plain = makeAnySite({ pricing: 'catalog', booking: 'live', availability: board })
    const list = states(plain.c)
    const want = valsOver(plain, list)
    const live = makeSite({ booking: 'live', availability: board, routes: routes(designCatalogV2()) })
    expect(live.c.__live).toBeNull()
    live.c.__refreshAll()
    await live.settle()
    expect(live.calls.some((c) => c.path === '/api/v1/public/catalog/v2')).toBe(true)
    expect(live.calls.some((c) => c.path === '/api/v1/public/catalog')).toBe(false)
    expect(live.c.__live).not.toBeNull()
    const got = valsOver(live, list)
    for (let i = 0; i < list.length; i++) expect(got[i], JSON.stringify(list[i]).slice(0, 140)).toEqual(want[i])
  })
})

describe('not website-ready: the interim prices, never the design\'s figures', () => {
  it('production before the seed (and no catalog at all) equal the interim mode, value for value', async () => {
    const interim = makeAnySite({ pricing: 'interim', booking: 'sms', availability: board })
    const list = states(interim.c)
    const want = valsOver(interim, list)
    const snap = makeSite({ booking: 'sms', availability: board, catalog: unseededCatalogV2() })
    expect(snap.env.catalogSource).toBe('none')
    expect(snap.c.__live).toBeNull()
    expect(valsOver(snap, list)).toEqual(want)
    const none = makeSite({ booking: 'sms', availability: board, routes: routes(unseededCatalogV2()) })
    none.c.__refreshAll()
    await none.settle()
    expect(none.c.__live).toBeNull()
    expect(valsOver(none, list)).toEqual(want)
  })

  it('a live catalog that stops being ready brings the interim prices back; a failed load keeps what the page has', async () => {
    let answer: unknown = sizedCatalogV2()
    const t = makeSite({ booking: 'sms', availability: board, routes: routes(null, { '/api/v1/public/catalog/v2': () => (answer ? ok(answer) : { status: 503, body: {} }) }) })
    t.c.__refreshAll()
    await t.settle()
    expect(t.c.VEH.length).toBe(5)
    answer = null
    t.c.__catalogReady = null
    t.c.__refreshAll()
    await t.settle()
    expect(t.c.__live).not.toBeNull()
    answer = unseededCatalogV2()
    t.c.__catalogReady = null
    t.c.__refreshAll()
    await t.settle()
    expect(t.c.__live).toBeNull()
    expect(t.c.VEH.map((v: any) => v[0])).toEqual(['sedan', 'suv', 'truck'])
    expect(t.c.state.bk.vehicle).toBe('sedan')
  })
})

describe('a filled grid', () => {
  const rows = (v: any, title: string) => v.prGroups.find((g: any) => g.title === title)?.rows ?? []

  it('price rows: "from $X", the member column, per-size rows of priced sizes only', () => {
    const t = makeSite({ booking: 'sms', availability: board, catalog: sizedCatalogV2() })
    const v = t.vals()
    const sig = rows(v, 'Hand wash')[0]
    expect(sig).toMatchObject({ name: 'Signature Hand Wash', pre: 'from', g: '$40', v: 'Included', save: 'SAVE $40' })
    expect(sig.sizes.map((z: any) => z.t)).toEqual(['Compact car $40 · members $36', 'Large car $50 · members $45', 'Compact SUV $60 · members $54', 'Large SUV $70 · members $63', 'Truck $80 · members $72'])
    expect(sig.sizesNote).toBeUndefined()
    const ext = rows(v, 'Hand wash')[1]
    expect(ext).toMatchObject({ pre: 'from', g: '$30' })
    expect(ext.sizes.map((z: any) => z.t)).toEqual(['Compact car $30 · members $27', 'Large car $35 · members $32'])
    expect(ext.sizesNote).toBe('Other sizes: priced at the shop')
    // an add-on at one price for every size: the design's look, no per-size rows
    const tire = rows(v, 'Add during your wash').find((r: any) => r.name === 'Tire shine & dressing')
    expect(tire).toMatchObject({ pre: '', g: '$14', v: '$13', save: 'SAVE $1' })
    expect(tire.sizes).toBeUndefined()
    // the tint rows: every size priced for both films
    expect(rows(v, 'Window tint').map((r: any) => [r.name, r.g, r.v])).toEqual([
      ['Compact car', '$250', '$225'],
      ['Large car', '$270', '$243'],
      ['Compact SUV', '$290', '$261'],
      ['Large SUV', '$310', '$279'],
      ['Truck', '$330', '$297'],
    ])
    expect(v.site.cat).toMatchObject({ fromGold: 'from $129', goldMo: 'from $129/mo', markupLine: 'Guests can book with prices 11% higher and a ' })
    // no size is ever shown at $0
    expect(JSON.stringify(v.prGroups)).not.toMatch(/\$0[^0-9]/)
  })

  it('the booking sheet: the sizes as chips, priced for the chosen size, "At the shop" for an unpriced size', () => {
    const t = makeSite({ booking: 'sms', availability: board, catalog: sizedCatalogV2() })
    expect(t.c.state.bk.vehicle).toBe('compact_car')
    t.c.setState({ sheet: 'book', step: 'svc', bk: { ...t.c.state.bk, who: 'guest', vehicle: 'large_suv', addons: ['wax'] } })
    let sh = t.vals().sh
    expect(sh.vehicles.map((o: any) => o.label)).toEqual(['Compact car', 'Large car', 'Compact SUV', 'Large SUV', 'Truck'])
    expect(sh.washes.map((w: any) => [w.price, w.note])).toEqual([
      ['$70', 'guest price'],
      ['At the shop', 'by vehicle size'],
    ])
    expect(sh.addons[0]).toMatchObject({ name: 'Hand wax', price: '+$47' })
    t.c.setState({ step: 'review', bk: { ...t.c.state.bk, svc: 'exterior', day: 1, slot: 540 } })
    sh = t.vals().sh
    expect(sh.lines.map((l: any) => [l.label, l.value])).toEqual([
      ['Exterior Hand Wash', 'At the shop'],
      ['Hand wax', '$47'],
      ['Booking fee · non-refundable', '$25'],
    ])
    expect(sh.dueSub).toMatch(/Pay the rest after your wash\.$/)
    expect(sh.sumLines[0]).toMatchObject({ label: 'Vehicle', value: 'Large SUV' })
  })

  it('a verified member\'s included wash on a larger car: "Included", the size difference at the shop', async () => {
    const t = makeSite({
      booking: 'live',
      availability: board,
      catalog: sizedCatalogV2(),
      routes: routes(sizedCatalogV2(), {
        '/api/v1/public/otp': () => ok({ challengeId: '0b5c2a3e-1111-4c2b-9d1e-2f6a7b8c9d0e', expiresInSec: 600 }, 202),
        '/api/v1/public/otp/verify': () => ok({ memberToken: 'x'.repeat(43), expiresInSec: 1800, member: { firstName: 'Dana', tier: 'gold', washesLeft: 3, plan: 'Gold', active: true, tierName: 'Gold', planClass: 'compact_car', memberDiscountBp: 1000 } }),
      }),
    })
    t.c.setState({ sheet: 'book', step: 'who', bk: { ...t.c.state.bk, phone: '2015550199', vehicle: 'large_suv' } })
    await t.c.__memberContinue()
    t.c.setState({ bk: { ...t.c.state.bk, code: '123456' } })
    await t.c.__verifyCode()
    expect(t.c.state.tier).toBe('gold')
    let sh = t.vals().sh
    expect(sh.washes[0]).toMatchObject({ price: 'Included', note: '+$30 size difference at the shop' })
    // the Exterior wash is not priced at that size: the shop prices it, so never "$0" (a difference may still be due)
    expect(sh.washes[1]).toMatchObject({ price: 'Included', note: 'size difference, if any, at the shop' })
    t.c.setState({ step: 'review', bk: { ...t.c.state.bk, svc: 'exterior', addons: ['wax'], day: 1, slot: 540 } })
    sh = t.vals().sh
    expect(sh.lines.map((l: any) => [l.label, l.value])).toEqual([
      ['Exterior Hand Wash', 'Included'],
      ['Size difference · at the shop', 'if any'],
      ['Hand wax', '$42'],
    ])
    expect(sh.due).toBe('At the shop')
    t.c.setState({ step: 'review', bk: { ...t.c.state.bk, svc: 'signature', addons: ['wax'], day: 1, slot: 540 } })
    sh = t.vals().sh
    expect(sh.lines.map((l: any) => [l.label, l.value])).toEqual([
      ['Signature Hand Wash', 'Included'],
      ['Size difference · at the shop', '+$30'],
      ['Hand wax', '$42'],
    ])
    expect(sh.due).toBe('$72')
    // the same member on their own plan size: no difference
    t.c.setState({ step: 'svc', bk: { ...t.c.state.bk, vehicle: 'compact_car' } })
    expect(t.vals().sh.washes[0]).toMatchObject({ price: '$0', note: '1 of 4 this month' })
  })

  const verified = async (cat: unknown, member: Record<string, unknown>, vehicle: string) => {
    const t = makeSite({
      booking: 'live',
      availability: board,
      catalog: cat,
      routes: routes(cat, {
        '/api/v1/public/otp': () => ok({ challengeId: '0b5c2a3e-1111-4c2b-9d1e-2f6a7b8c9d0e', expiresInSec: 600 }, 202),
        '/api/v1/public/otp/verify': () => ok({ memberToken: 'x'.repeat(43), expiresInSec: 1800, member: { firstName: 'Dana', washesLeft: 3, active: true, ...member } }),
      }),
    })
    t.c.setState({ sheet: 'book', step: 'who', bk: { ...t.c.state.bk, phone: '2015550199', vehicle } })
    await t.c.__memberContinue()
    t.c.setState({ bk: { ...t.c.state.bk, code: '123456' } })
    await t.c.__verifyCode()
    return t
  }

  it('the size difference is the cents difference rounded half up, not a difference of rounded prices', async () => {
    const cat = sizedCatalogV2()
    cat.services[0]!.prices = cat.services[0]!.prices.map((p) => (p.class === 'large_car' ? { ...p, cents: 4050, memberCents: 3600 } : p.class === 'large_suv' ? { ...p, cents: 4549, memberCents: 4100 } : p))
    const t = await verified(cat, { tier: 'gold', plan: 'Gold', tierName: 'Gold', planClass: 'large_car', memberDiscountBp: 1000 }, 'large_suv')
    let sh = t.vals().sh
    expect(sh.washes[0]).toMatchObject({ price: 'Included', note: '+$5 size difference at the shop' })
    t.c.setState({ step: 'review', bk: { ...t.c.state.bk, svc: 'signature', addons: [], day: 1, slot: 540 } })
    sh = t.vals().sh
    expect(sh.lines.slice(0, 2).map((l: any) => [l.label, l.value])).toEqual([
      ['Signature Hand Wash', 'Included'],
      ['Size difference · at the shop', '+$5'],
    ])
    expect(sh.due).toBe('$5')
  })

  it('a verified member pays their own tier\'s % off on what the plan does not include', async () => {
    // VIP is 15% off while the catalog shows 10% (the lowest): tire shine $14 -> $11.90 -> $12 for VIP, not $13
    const t = await verified(sizedCatalogV2(), { tier: 'vip', plan: 'VIP', tierName: 'VIP', planClass: 'compact_car', memberDiscountBp: 1500 }, 'compact_car')
    expect(t.c.state.tier).toBe('vip')
    const sh = t.vals().sh
    const tire = sh.addons.find((a: any) => a.name === 'Tire shine & dressing')
    expect(tire).toMatchObject({ price: '+$12' })
  })

  describe('the guest review\'s "As VIP" line counts the wash and the size', () => {
    const review = (cat: unknown, svc: string, vehicle: string) => {
      const t = makeSite({ booking: 'sms', availability: board, catalog: cat })
      t.c.setState({ sheet: 'book', step: 'review', bk: { ...t.c.state.bk, who: 'guest', svc, vehicle, addons: ['wax'], day: 1, slot: 540 } })
      return t.vals().sh.upsell
    }
    it('VIP includes the wash at the car\'s size: $0 (wax included too)', () => {
      expect(review(sizedCatalogV2(), 'signature', 'compact_car')).toBe('You’d pay $112 as a guest. As VIP: $0, with wax and engine bay included.')
    })
    it('VIP does not include the wash: its member price at VIP\'s own % off', () => {
      const cat = sizedCatalogV2()
      cat.tiers[1]!.inclusions = cat.tiers[1]!.inclusions.filter((x) => x.serviceKey !== 'exterior-hand-wash')
      // Exterior $30 at Compact car, VIP 15% off: $25.50 -> $26
      expect(review(cat, 'exterior', 'compact_car')).toBe('You’d pay $102 as a guest. As VIP: $26, with wax and engine bay included.')
    })
    it('a car larger than any size VIP is sold at: the size difference', () => {
      // Signature $70 at Large SUV, VIP sold at Compact car only ($40): $30 at the shop
      expect(review(sizedCatalogV2(), 'signature', 'large_suv')).toBe('You’d pay $142 as a guest. As VIP: $30, with wax and engine bay included.')
      // VIP sold at Large SUV too: priced at the car's size, nothing to add
      const cat = sizedCatalogV2()
      cat.tiers[1]!.prices = [...cat.tiers[1]!.prices, { class: 'large_suv', monthlyCents: 24900 }]
      expect(review(cat, 'signature', 'large_suv')).toBe('You’d pay $142 as a guest. As VIP: $0, with wax and engine bay included.')
    })
    it('a wash without a price at the size: the interim words, never a made-up VIP price', () => {
      expect(review(sizedCatalogV2(), 'exterior', 'large_suv')).toBe(INTERIM.upsell)
    })
  })

  it('the booking request sends the size key, never a made-up vehicle', async () => {
    const t = makeSite({ booking: 'live', availability: board, catalog: sizedCatalogV2(), routes: routes(sizedCatalogV2(), { '/api/v1/public/bookings': () => ok({ bookingRef: 'OAS-00042', status: 'booked', deposit: { dueCents: 2500, how: 'counter' }, confirmationBy: 'sms' }, 201) }) })
    t.c.__refreshAll()
    await t.settle()
    t.c.__pickDate = '2026-10-12'
    t.c.setState({ sheet: 'book', step: 'review', bk: { ...t.c.state.bk, who: 'guest', vehicle: 'large_suv', ack: true, name: 'Jo Park', phone: '2015550111', day: 1, slot: 540 } })
    await t.c.__submitBooking()
    const post = t.calls.find((c) => c.path === '/api/v1/public/bookings')!
    expect(post.body.vehicleClass).toBe('large_suv')
    expect(post.body.vehicle).toBeUndefined()
    expect(post.body.serviceKey).toBe('signature-hand-wash')
  })

  it('the join flow: Gold at two sizes gets a size picker; the size sets the price and goes with the request', async () => {
    const t = makeSite({ booking: 'live', availability: board, catalog: sizedCatalogV2(), routes: routes(sizedCatalogV2(), { '/api/v1/public/memberships': () => ok({ memberRef: 'OAS-M-1', status: 'pending_payment', next: 'checkout_link_by_sms', tier: 'gold', plan: 'Gold' }, 201) }) })
    t.c.setState({ page: 'join', jn: { ...t.c.state.jn, tier: 'gold', step: 0 } })
    let v = t.vals()
    expect(v.jv.tiers.map((x: any) => [x.name, x.price, x.per])).toEqual([
      ['Gold', 'from $129', '/mo'],
      ['VIP', '$199', '/mo'],
    ])
    expect(v.site.joinSizes.show).toBe(true)
    expect(v.site.joinSizes.chips.map((c: any) => c.label)).toEqual(['Compact car · $129/mo', 'Large SUV · $159/mo'])
    expect(v.site.joinSizes.note).toBe('Other sizes: ask us.')
    v.site.joinSizes.chips[1].onClick()
    t.c.setState({ jn: { ...t.c.state.jn, step: 3, name: 'Jo Park', phone: '2015550111', email: 'jo@example.com', agree: true, vehicles: [{ car: '2020 Honda Pilot', plate: '' }] } })
    v = t.vals()
    expect(v.jv.lines.slice(0, 2).map((l: any) => [l.label, l.value])).toEqual([
      ['Gold membership', '$159/mo'],
      ['Priced for', 'Large SUV'],
    ])
    expect(v.jv.due).toBe('$159')
    expect(v.jv.ctaLabel).toBe('Start Gold · $159/mo')
    expect(v.jv.agreeText).toMatch(/^I agree to be billed \$159 a month for Gold/)
    expect(v.site.joinSizes.show).toBe(false) // only on the plan step
    await t.c.__submitJoin()
    const post = t.calls.find((c) => c.path === '/api/v1/public/memberships')!
    expect(post.body).toMatchObject({ tier: 'gold', planClass: 'large_suv' })
    // VIP at one size: no picker
    t.c.setState({ jn: { ...t.c.state.jn, tier: 'vip', step: 0 } })
    expect(t.vals().site.joinSizes.show).toBe(false)
  })

  it('sms mode: the join text names the size', () => {
    const t = makeSite({ booking: 'sms', availability: board, catalog: sizedCatalogV2() })
    t.c.setState({ page: 'join', jn: { ...t.c.state.jn, tier: 'gold', step: 3, name: 'Jo Park', phone: '2015550111', vehicles: [{ car: 'Pilot', plate: '' }] } })
    t.c.__joinClass = 'large_suv'
    expect(t.c.__composeJoin()).toBe('JOIN GOLD (Large SUV): Jo Park · 2015550111 · Pilot')
  })
})

describe('production after the seeds: the Signature wash and Gold, nothing else priced', () => {
  it('the priced items show, every other section keeps the interim words, VIP is not sold', () => {
    const t = makeSite({ booking: 'sms', availability: board, catalog: seededCatalogV2() })
    const v = t.vals()
    const wash = v.prGroups.find((g: any) => g.title === 'Hand wash').rows
    expect(wash.map((r: any) => [r.name, r.pre, r.g])).toEqual([['Signature Hand Wash', 'from', '$40']])
    expect(v.prGroups.find((g: any) => g.title === 'Add during your wash').rows[0]).toMatchObject({ g: 'Ask us' })
    expect(v.prShowMonth).toBe(false)
    expect(v.site.cat).toMatchObject({ vip: 'Ask us', joinVip: 'Join VIP', fromGold: 'from $129', gold: '$129' })
    t.c.setState({ page: 'wash' })
    expect(t.vals().washCards.map((c: any) => c.g)).toEqual(['from $40', 'Priced by vehicle size — ask us'])
    // the join page opens on VIP by default: the catalog does not sell it, so Gold
    t.c.setState({ page: 'join', jn: { ...t.c.state.jn, tier: 'vip', step: 0 } })
    expect(t.c.state.jn.tier).toBe('gold')
    expect(t.vals().jv.tiers.map((x: any) => x.name)).toEqual(['Gold'])
    // no figure but the priced ones, the fee (and what members pay: $0), anywhere on the home view
    const figures = JSON.stringify(serializeVals(t.c.renderVals())).match(/\$\d[\d,]*/g) ?? []
    expect([...new Set(figures)].filter((x) => !['$40', '$129', '$25', '$65', '$260', '$131', '$0'].includes(x))).toEqual([])
  })
})
