// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
// DV-CATALOG against the REAL design logic (bridge.testkit.ts): the website's services, add-ons, tint table, detailing,
// quote-only items, plan prices/perks and guest fee come from GET /api/v1/public/catalog (build snapshot + the refresh
// after mount) when the catalog is website-ready, and the page is exactly the design's otherwise.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeVals } from '../dc/serialize'
import { designCatalog, unseededCatalog, withMemberPrice } from '../../tools/site/catalog-fixture'
import { makeSite, payload, type Handler } from './bridge.testkit'

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

const ok = (body: unknown): ReturnType<Handler> => ({ status: 200, body })
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T
const board = payload([
  { date: '2026-10-10', slots: [[960, 'open', 2]] },
  { date: '2026-10-11', slots: [], closed: true },
  { date: '2026-10-12', slots: [[540, 'open', 3], [570, 'last', 1]] },
])

/** Every state the design's price texts appear in: home calculator, the four pages, the join flow, the booking sheet. */
function states(c: any): Record<string, any>[] {
  const bk = c.state.bk
  const jn = c.state.jn
  const out: Record<string, any>[] = [{}, { washes: 1 }, { washes: 2 }, { washes: 3 }]
  for (const page of ['wash', 'tint', 'detailing', 'membership', 'experience', 'visit']) out.push({ page })
  for (const [film, tintVeh] of [['carbon', 'suv'], ['ceramic', 'truck'], ['carbon', 'sedan']]) out.push({ page: 'tint', film, tintVeh })
  for (const tier of ['gold', 'vip']) for (const step of [0, 1, 2, 3, 4]) out.push({ page: 'join', jn: { ...jn, tier, step, name: 'Jo Park' } })
  const sheet = (who: string, step: string, tier: string | null, addons: string[]) => ({ page: 'home', sheet: 'book', step, tier, bk: { ...bk, who, addons, day: 1, slot: 540 } })
  for (const step of ['who', 'svc', 'time', 'review', 'done']) {
    out.push(sheet('guest', step, null, ['wax', 'tire', 'leather']))
    out.push(sheet('member', step, 'vip', ['wax', 'stain', 'deep']))
    out.push(sheet('member', step, 'gold', ['engine', 'rain']))
  }
  return out
}

/** The serialised renderVals of each state (what the parity harness diffs). */
function valsOver(t: ReturnType<typeof makeSite>, list: Record<string, any>[]): unknown[] {
  const base = t.c.state
  return list.map((st) => {
    t.c.state = { ...base, ...st }
    const v = serializeVals(t.c.renderVals()) as Record<string, any>
    return v
  })
}

const routes = (cat: unknown): Record<string, Handler> => ({
  '/api/v1/public/catalog': () => ok(cat),
  '/api/v1/public/availability': () => ok(board),
})

describe('the design catalog renders the design, value for value (the parity proof in a unit test)', () => {
  it('build snapshot: every price state equals the built-in content', () => {
    const plain = makeSite({ booking: 'sms', availability: board })
    const list = states(plain.c)
    const want = valsOver(plain, list)
    const snap = makeSite({ booking: 'sms', availability: board, catalog: designCatalog() })
    expect(snap.env.catalogSource).toBe('SITE_CATALOG_JSON')
    expect(snap.c.__site).not.toBeNull()
    const got = valsOver(snap, list)
    for (let i = 0; i < list.length; i++) expect(got[i], JSON.stringify(list[i]).slice(0, 120)).toEqual(want[i])
  })

  it('live refresh (no snapshot, the live variant): the applied catalog changes nothing either', async () => {
    const plain = makeSite({ booking: 'live', availability: board })
    const list = states(plain.c)
    const want = valsOver(plain, list)
    const live = makeSite({ booking: 'live', availability: board, routes: routes(designCatalog()) })
    live.c.__refreshAll()
    await live.settle()
    expect(live.c.__site).not.toBeNull()
    const got = valsOver(live, list)
    for (let i = 0; i < list.length; i++) expect(got[i], JSON.stringify(list[i]).slice(0, 120)).toEqual(want[i])
  })
})

describe('a changed price in the catalog shows on the page', () => {
  const rows = (v: any, title: string) => v.prGroups.find((g: any) => g.title === title)?.rows ?? []

  it('live variant: the Signature wash at $50 (guest $60) after the refresh: price list, wash card, calculator, sheet', async () => {
    const t = makeSite({ booking: 'live', availability: board, routes: routes(withMemberPrice(designCatalog(), 'signature-hand-wash', 50)) })
    expect(rows(t.vals(), 'Hand wash')[0]).toMatchObject({ name: 'Signature Hand Wash', g: '$54', save: 'SAVE $54' })
    t.c.__refreshAll()
    await t.settle()
    const home = t.vals()
    expect(rows(home, 'Hand wash')[0]).toMatchObject({ name: 'Signature Hand Wash', g: '$60', v: 'Included', save: 'SAVE $60' })
    expect(home.calcGuestSub).toBe('4 × ($60 wash + $25 fee)')
    expect(home.calcGuest).toBe('$340')
    expect(home.vipMonth[0]).toEqual({ label: '4 Signature washes', value: '$240' })
    t.c.setState({ page: 'wash' })
    expect(t.vals().washCards[0]).toMatchObject({ name: 'Signature Hand Wash', g: '$60' })
    t.c.setState({ page: 'home', sheet: 'book', step: 'svc', bk: { ...t.c.state.bk, who: 'guest' } })
    expect(t.vals().sh.washes[0]).toMatchObject({ name: 'Signature Hand Wash', price: '$60', note: 'guest price' })
    t.c.setState({ step: 'review', bk: { ...t.c.state.bk, day: 1, slot: 540 } })
    expect(t.vals().sh.lines[0]).toMatchObject({ label: 'Signature Hand Wash', value: '$60' })
  })

  it('build snapshot: an add-on, a tint row, a detail, the plans and the fee', () => {
    const cat = clone(withMemberPrice(designCatalog(), 'hand-wax', 41))
    cat.tint.prices[0]!.memberMinCents = 21900
    cat.tint.prices[0]!.guestMinCents = 26300
    cat.services.find((s) => s.key === 'full-detail')!.memberPriceCents = 25900
    cat.services.find((s) => s.key === 'full-detail')!.guestPriceCents = 31100
    cat.plans[0]!.priceCents = 10900
    cat.plans[1]!.perks = ['Everything in Gold', 'Ceramic spray every month']
    cat.guestBookingFeeCents = 3000
    cat.quotes.push({ key: 'headlight-restoration', name: 'Headlight restoration', kind: 'package', category: 'quote', description: null })
    const t = makeSite({ booking: 'sms', availability: board, catalog: cat })
    const v = t.vals()
    expect(rows(v, 'Add during your wash')[0]).toMatchObject({ name: 'Hand wax', g: '$49', v: 'Included', save: 'SAVE $49' })
    expect(rows(v, 'Window tint')[0]).toMatchObject({ name: 'Sedan / Coupe', pre: 'from', v: '$219', g: '$263' })
    expect(rows(v, 'Detailing')[1]).toMatchObject({ name: 'Full detail', v: '$259', g: '$311', save: 'SAVE $52' })
    expect(rows(v, 'More services').map((r: any) => r.name)).toEqual(['Windshield replacement', 'Rim powder coating', 'Chrome delete', 'Car key copies', 'Headlight restoration'])
    expect(v.site.cat).toMatchObject({ gold: '$109', fromGold: 'from $109', fee: '$30', feeTerms: '$30 non-refundable booking fee', tintFrom: 'Carbon and ceramic film. VIP from $219, guest from $263.' })
    expect(v.calcGuestSub).toBe('4 × ($54 wash + $30 fee)')
    expect(v.faqs[1].a).toBe('No. Guests pay a $30 non-refundable booking fee to hold a time, on top of guest pricing. Members never pay it.')
    t.c.setState({ page: 'membership' })
    expect(t.vals().compRows.find((r: any) => r.f === 'Booking fee').cells.map((c: any) => c.t)).toEqual(['$30', '$0', '$0'])
    t.c.setState({ page: 'join', jn: { ...t.c.state.jn, tier: 'gold', step: 3 } })
    const jv = t.vals().jv
    expect(jv.tiers.map((x: any) => [x.name, x.price])).toEqual([['Gold', '$109'], ['VIP', '$169']])
    expect(jv.tiers[1].perks).toEqual(['Everything in Gold', 'Ceramic spray every month'])
    expect(jv.ctaLabel).toBe('Start Gold · $109/mo')
    expect(jv.due).toBe('$109')
    expect(jv.agreeText).toMatch(/^I agree to be billed \$109 a month for Gold/)
    t.c.setState({ page: 'home', sheet: 'book', step: 'review', bk: { ...t.c.state.bk, who: 'guest', addons: ['wax'], day: 1, slot: 540 } })
    const sh = t.vals().sh
    expect(sh.lines.map((l: any) => [l.label, l.value])).toEqual([
      ['Signature Hand Wash', '$54'],
      ['Hand wax', '$49'],
      ['Booking fee · non-refundable', '$30'],
    ])
    expect(sh.due).toBe('$30')
    expect(sh.dueSub).toMatch(/^\$30 due at the counter or by the link we text you\. Pay \$103 after your wash\.$/)
    expect(sh.upsell).toMatch(/^You’d pay \$133 as a guest\./)
    expect(sh.sumLines.find((l: any) => l.label === 'Booking fee').value).toBe('$30')
  })

  it('a new add-on in the catalog is offered and booked under its key; one the catalog dropped leaves the visitor\'s pick', async () => {
    const cat = clone(designCatalog())
    cat.addons.push({ ...cat.addons[0]!, key: 'headlight-restoration', name: 'Headlight restoration', description: 'Sand, polish, seal', memberPriceCents: 4000, guestPriceCents: 4800, priceCents: 4800, vipInclusion: 'none', vipNote: null })
    let posted: any = null
    const t = makeSite({
      booking: 'live',
      availability: board,
      catalog: cat,
      routes: {
        ...routes(cat),
        '/api/v1/public/bookings': (call) => {
          posted = call.body
          return { status: 201, body: { bookingRef: 'OAS-00042', status: 'booked', deposit: { dueCents: 2500, how: 'counter' }, confirmationBy: 'sms' } }
        },
      },
    })
    t.c.pickSlot(1, { m: 540, st: 'open', bays: 3 })
    await t.settle()
    t.c.sheetVals().guestContinue()
    t.c.setBk({ addons: ['tire', 'headlight-restoration'], ack: true, name: 'Jamie Rivera', phone: '201-555-0141' })
    t.c.setState({ step: 'svc' })
    expect(t.vals().sh.addons.map((a: any) => a.name)).toContain('Headlight restoration')
    t.c.setState({ step: 'review' })
    t.c.sheetVals().sh.cta()
    await t.settle()
    expect(posted).toMatchObject({ serviceKey: 'signature-hand-wash', addonKeys: ['tire-shine-and-dressing', 'headlight-restoration'] })
    // the catalog drops the tire shine: the refresh takes it off the list and out of the visitor's pick
    const fewer = clone(cat)
    fewer.addons = fewer.addons.filter((a) => a.key !== 'tire-shine-and-dressing')
    expect(t.c.__applyCatalog(fewer)).toBe(true)
    expect(t.c.state.bk.addons).toEqual(['headlight-restoration'])
    expect(t.c.DURING.map((a: any) => a.id)).not.toContain('tire')
  })
})

describe('an unseeded catalog falls back to the built-in content', () => {
  it('production before the website-catalog seed (snapshot or live): every state equals the design\'s', async () => {
    const plain = makeSite({ booking: 'live', availability: board })
    const list = states(plain.c)
    const want = valsOver(plain, list)
    const snap = makeSite({ booking: 'live', availability: board, catalog: unseededCatalog(), routes: routes(unseededCatalog()) })
    expect(snap.env.catalogSource).toBe('none')
    snap.c.__refreshAll()
    await snap.settle()
    expect(snap.c.__site).toBeNull()
    const got = valsOver(snap, list)
    for (let i = 0; i < list.length; i++) expect(got[i], JSON.stringify(list[i]).slice(0, 120)).toEqual(want[i])
    expect(snap.vals().prGroups.find((g: any) => g.title === 'Add during your wash').rows.map((r: any) => r.name)).toEqual([
      'Hand wax',
      'Engine bay wash',
      'Leather conditioning',
      'Stain removal',
      'Tire shine & dressing',
      'Rain-repellent glass',
      'Odor removal',
      'Pet hair removal',
      'Interior deep clean',
    ])
  })

  it('a ready snapshot followed by an unseeded live answer brings the design back; a failed load keeps the snapshot', async () => {
    const changed = withMemberPrice(designCatalog(), 'signature-hand-wash', 50)
    const failing = makeSite({ booking: 'sms', availability: board, catalog: changed, routes: { '/api/v1/public/catalog': () => ({ status: 503, body: {} }) } })
    failing.c.__refreshAll()
    await failing.settle()
    expect(failing.vals().prGroups.find((g: any) => g.title === 'Hand wash').rows[0].g).toBe('$60')
    const t = makeSite({ booking: 'sms', availability: board, catalog: changed, routes: routes(unseededCatalog()) })
    expect(t.vals().prGroups.find((g: any) => g.title === 'Hand wash').rows[0].g).toBe('$60')
    t.c.__refreshAll()
    await t.settle()
    expect(t.vals().prGroups.find((g: any) => g.title === 'Hand wash').rows[0].g).toBe('$54')
    expect(t.c.WASH.map((w: any) => w.name)).toEqual(['Signature Hand Wash', 'Exterior Hand Wash'])
    expect(t.vals().site.cat.gold).toBe('$99')
  })

  it('live mode still refuses a wash the catalog does not carry (the keys rule is unchanged)', async () => {
    let posted = 0
    const t = makeSite({
      booking: 'live',
      availability: board,
      routes: {
        ...routes(unseededCatalog()),
        '/api/v1/public/bookings': () => {
          posted++
          return { status: 201, body: {} }
        },
      },
    })
    t.c.pickSlot(1, { m: 540, st: 'open', bays: 3 })
    await t.settle()
    t.c.sheetVals().guestContinue()
    t.c.setBk({ ack: true, name: 'Jamie Rivera', phone: '201-555-0141' })
    t.c.setState({ step: 'review' })
    t.c.sheetVals().sh.cta()
    await t.settle()
    expect(posted).toBe(0)
    expect(t.c.state.toast).toMatch(/^Signature Hand Wash can't be booked online yet/)
  })
})
