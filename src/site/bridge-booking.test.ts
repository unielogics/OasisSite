// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
// The bridge's booking, availability, hours and join behaviour against the REAL design logic (bridge.testkit.ts), one
// block per review finding of 2026-10-10 (scratchpad findings-site.json): each test failed on the bridge before the fix.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { configCatalog, makeSite, payload, type Call, type Handler } from './bridge.testkit'
import { withToday } from './hours'
import { FALLBACK_HOURS } from './bridge.testkit'

// the page's clock is the shop's (DV-CLOCK): every date below is a New Jersey wall time
beforeAll(() => {
  process.env.TZ = 'America/New_York'
})
const at = (iso: string) => vi.setSystemTime(new Date(iso))
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  ;(window as any).__oasisNavigations = []
  window.scrollTo = (() => {}) as any
  ;(window as any).__oasisNavigate = (u: string) => (window as any).__oasisNavigations.push(u)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  delete (window as any).__oasisNavigate
})
const navigations = (): string[] => (window as any).__oasisNavigations
const smsBody = (u: string) => decodeURIComponent(u.replace(/^sms:[^?]*\?&body=/, ''))

const ok = (body: unknown, headers?: Record<string, string>) => ({ status: 200, body, headers })
const catalogRoute = (cat = configCatalog()): Handler => () => ok({ generatedAt: new Date().toISOString(), ...cat, plans: [] })
/** Answers the availability queries from a list, in order (the last one repeats). */
const availRoute = (...answers: unknown[]): Handler => {
  let n = 0
  return () => ok(answers[Math.min(n++, answers.length - 1)])
}
const posts = (calls: Call[], suffix: string) => calls.filter((c) => c.method === 'POST' && c.path.endsWith(suffix))

// Saturday Oct 10 2026; Sunday closed; the shop's last Saturday start is 4:00 PM
const SAT = '2026-10-10'
const MON = '2026-10-12'
const TUE = '2026-10-13'
const board1 = payload([
  { date: SAT, slots: [[960, 'open', 2]] },
  { date: '2026-10-11', slots: [], closed: true },
  { date: MON, slots: [[540, 'open', 3], [570, 'open', 3]] },
  { date: TUE, slots: [[540, 'open', 3]] },
])
// a refresh a few minutes later: Saturday's last start is inside the lead time, so the API lists Saturday without slots
const board2 = payload([
  { date: SAT, slots: [] },
  { date: '2026-10-11', slots: [], closed: true },
  { date: MON, slots: [[540, 'open', 3], [570, 'open', 3]] },
  { date: TUE, slots: [[540, 'open', 3]] },
])

describe('the picked day is a date, not a position in a list that moves (findings: date index, sms and live)', () => {
  it('sms mode: a refresh that drops today keeps "Monday 9:00 AM" in the composed text (was Tuesday)', async () => {
    at('2026-10-10T15:32:00-04:00')
    const t = makeSite({ booking: 'sms', availability: board1, routes: { '/api/v1/public/catalog': catalogRoute(), '/api/v1/public/availability': availRoute(board2) } })
    const c = t.c
    expect(c.days.map((d: any) => d.word)).toEqual(['Today', 'Monday', 'Tuesday'])
    c.pickSlot(1, { m: 540, st: 'open', bays: 3 }) // the board's Monday 9:00 AM
    await t.settle() // openBook's refresh lands: Saturday is gone
    expect(c.days.map((d: any) => d.word)).toEqual(['Monday', 'Tuesday'])
    expect(c.state.bk.day).toBe(0) // the position follows the date
    expect(c.sheetVals().sh.sumWhen).toBe('Monday · 9:00 AM')
    c.sheetVals().guestContinue()
    c.setState({ step: 'review' })
    c.setBk({ ack: true })
    c.sheetVals().sh.cta()
    await t.settle()
    expect(navigations()).toHaveLength(1)
    expect(smsBody(navigations()[0]!)).toBe('WASH booking: Signature Hand Wash · Sedan / Coupe · Monday 9:00 AM · Guest')
  })

  it('live mode: the booking is sent for the picked date after the list moved (refresh, then shop midnight)', async () => {
    at('2026-10-10T15:32:00-04:00')
    const t = makeSite({
      booking: 'live',
      availability: board1,
      routes: {
        '/api/v1/public/catalog': catalogRoute(),
        '/api/v1/public/availability': availRoute(board2),
        '/api/v1/public/bookings': () => ({ status: 201, body: { bookingRef: 'OAS-00042', status: 'booked', deposit: { dueCents: 2500, how: 'counter' }, confirmationBy: 'sms' } }),
      },
    })
    const c = t.c
    c.pickSlot(1, { m: 540, st: 'open', bays: 3 }) // Monday 9:00 AM
    await t.settle() // the refresh drops Saturday
    // midnight passes (Sunday): the 30 s tick re-renders with a list where Monday is "Tomorrow"
    at('2026-10-11T00:01:00-04:00')
    c.setState({ now: Date.now() })
    expect(c.sheetVals().sh.sumWhen).toBe('Tomorrow · 9:00 AM')
    c.sheetVals().guestContinue()
    c.setState({ step: 'review' })
    c.setBk({ ack: true, name: 'Jamie Rivera', phone: '201-555-0141' })
    c.sheetVals().sh.cta()
    await t.settle()
    const p = posts(t.calls, '/public/bookings')
    expect(p).toHaveLength(1)
    expect(p[0]!.body).toMatchObject({ date: MON, startMin: 540, serviceKey: 'signature-hand-wash' })
  })

  it('when the picked time is gone after a refresh, the pick is cleared and the visitor picks again', async () => {
    at('2026-10-10T15:32:00-04:00')
    const taken = payload([
      { date: MON, slots: [[540, 'booked', 0], [570, 'open', 3]] },
      { date: TUE, slots: [[540, 'open', 3]] },
    ])
    const t = makeSite({ booking: 'sms', availability: board1, routes: { '/api/v1/public/catalog': catalogRoute(), '/api/v1/public/availability': availRoute(board1, taken) } })
    const c = t.c
    c.pickSlot(1, { m: 540, st: 'open', bays: 3 })
    await t.settle()
    c.sheetVals().guestContinue()
    c.setState({ step: 'review' })
    c.setBk({ svc: 'exterior' }) // a refresh: Monday 9:00 is booked now
    await t.settle()
    expect(c.state.bk.slot).toBeNull()
    expect(c.state.step).toBe('time')
    expect(c.state.toast).toBe('That time is no longer available. Pick another time.')
  })
})

describe('the hero pill and the hours follow the clock, not the deploy (findings: OPEN NOW from the build)', () => {
  // the API's answer baked at the Saturday 11:46 AM deploy
  const baked = { ...FALLBACK_HOURS, today: { date: SAT, day: 'Saturday', weekday: 6, closed: false, openMin: 480, closeMin: 1020, openNow: true, state: 'open', reason: null }, next: { date: MON, day: 'Monday', weekday: 1, closed: false, openMin: 480, closeMin: 1080 } }

  it('withToday works today out again from the clock: Sunday is closed, Saturday 6 PM is closed, Saturday 7 AM opens later', () => {
    const sun = withToday(baked as any, new Date('2026-10-11T12:00:00-04:00'))!
    expect(sun.today).toMatchObject({ date: '2026-10-11', closed: true, state: 'closed', openNow: false })
    expect(sun.next).toMatchObject({ date: MON })
    expect(withToday(baked as any, new Date('2026-10-10T18:00:00-04:00'))!.today).toMatchObject({ date: SAT, state: 'closed', openNow: false })
    expect(withToday(baked as any, new Date('2026-10-10T07:00:00-04:00'))!.today).toMatchObject({ date: SAT, state: 'opens_later' })
    // a closure in the payload closes its day
    const holiday = { ...baked, closures: [{ date: '2026-10-12', name: 'Columbus Day', type: 'closed' }] }
    expect(withToday(holiday as any, new Date('2026-10-12T10:00:00-04:00'))!.today).toMatchObject({ closed: true, state: 'closed' })
  })

  it('the pill on Sunday reads OPENS MON, not the build\'s OPEN NOW; a stale or closed "now" is not believed', () => {
    at('2026-10-11T12:00:00-04:00')
    const t = makeSite({ booking: 'sms', hours: baked as any, availability: payload([{ date: MON, slots: [[540, 'open', 3]] }], '2026-10-10T15:46:00Z', { open: true, baysFree: 2, baysTotal: 3 }) })
    expect(t.c.bays()).toEqual({ short: 'OPENS MON 8 AM', open: false })
    at('2026-10-10T12:00:00-04:00') // Saturday noon: open, but the payload's "now" is 14 minutes old
    // payload stamps are compared with the real clock (performance), here the faked one
    vi.stubGlobal('performance', { timeOrigin: Date.now(), now: () => 0 })
    expect(t.c.bays().short).not.toBe('2 OF 3 BAYS OPEN NOW')
    expect(t.c.bays().open).toBe(true)
    t.c.__avail = payload([{ date: SAT, slots: [[780, 'open', 3]] }], new Date().toISOString(), { open: false, baysFree: 0, baysTotal: 3 })
    expect(t.c.bays()).toEqual({ short: 'CLOSED NOW', open: false })
  })

  it('a baked board drops today\'s starts that have passed', () => {
    at('2026-10-10T15:32:00-04:00')
    const t = makeSite({ booking: 'sms', availability: payload([{ date: SAT, slots: [[900, 'open', 3], [960, 'open', 2]] }]) })
    expect(t.c.days[0].slots.map((s: any) => s.m)).toEqual([960])
  })
})

describe('the availability query (findings: ignored add-ons, out-of-order answers)', () => {
  it('asks for the wash only (add-ons never change the answer) and does not refetch on an add-on toggle', async () => {
    at('2026-10-10T10:00:00-04:00')
    const t = makeSite({ booking: 'sms', availability: board1, routes: { '/api/v1/public/catalog': catalogRoute(), '/api/v1/public/availability': availRoute(board1) } })
    t.c.openBook({})
    await t.settle()
    t.c.setBk({ addons: ['wax'] })
    t.c.setBk({ addons: ['wax', 'tire'] })
    await t.settle()
    const q = t.calls.filter((c) => c.path.endsWith('/availability')).map((c) => c.url)
    expect(q).toEqual(['/api/v1/public/availability?days=7&service=signature-hand-wash'])
  })

  it('an older answer arriving last does not replace the board of the wash now chosen', async () => {
    at('2026-10-10T10:00:00-04:00')
    const sig = payload([{ date: MON, slots: [[540, 'open', 3]] }])
    const ext = payload([{ date: MON, slots: [[600, 'open', 3]] }])
    let releaseExt: () => void = () => {}
    const t = makeSite({
      booking: 'sms',
      availability: board1,
      routes: {
        '/api/v1/public/catalog': catalogRoute(),
        '/api/v1/public/availability': (call) =>
          call.url.includes('exterior') ? new Promise((r) => (releaseExt = () => r(ok(ext)))) : ok(sig),
      },
    })
    t.c.setBk({ svc: 'exterior' })
    await t.settle()
    t.c.setBk({ svc: 'signature' })
    await t.settle()
    expect(t.c.days[0].slots.map((s: any) => s.m)).toEqual([540])
    releaseExt()
    await t.settle()
    expect(t.c.days[0].slots.map((s: any) => s.m)).toEqual([540])
  })
})

describe('catalog keys come from the live catalog, fail safe (finding: wrong service and add-ons booked)', () => {
  // production on 2026-10-10: none of the design's washes, a "Wax" add-on
  const production = {
    services: [
      { key: 'express-hand-wash', name: 'Express Hand Wash' },
      { key: 'premium-hand-wash-plus-interior', name: 'Premium Hand Wash + Interior' },
    ],
    addons: [
      { key: 'wax', name: 'Wax' },
      { key: 'pet-hair-removal', name: 'Pet hair removal' },
      { key: 'leather-conditioning', name: 'Leather conditioning' },
    ],
  }
  const liveSite = (cat: any) =>
    makeSite({
      booking: 'live',
      availability: board1,
      routes: {
        '/api/v1/public/catalog': catalogRoute(cat),
        '/api/v1/public/availability': availRoute(board1),
        '/api/v1/public/bookings': () => ({ status: 201, body: { bookingRef: 'OAS-00042', status: 'booked', deposit: { dueCents: 2500, how: 'counter' }, confirmationBy: 'sms' } }),
      },
    })
  const guestReview = async (t: ReturnType<typeof makeSite>, addons: string[] = []) => {
    t.c.pickSlot(1, { m: 540, st: 'open', bays: 3 })
    await t.settle()
    t.c.sheetVals().guestContinue()
    t.c.setBk({ addons, ack: true, name: 'Jamie Rivera', phone: '201-555-0141' })
    t.c.setState({ step: 'review' })
  }

  it('a wash the catalog does not carry is never booked as a look-alike: refused, nothing posted; the board asks for the default wash', async () => {
    at('2026-10-10T10:00:00-04:00')
    const t = liveSite(production)
    await guestReview(t)
    t.c.sheetVals().sh.cta()
    await t.settle()
    expect(posts(t.calls, '/public/bookings')).toHaveLength(0)
    expect(t.c.state.toast).toMatch(/^Signature Hand Wash can't be booked online yet\. Text WASH to 862-388-5827/)
    expect(t.calls.filter((c) => c.path.endsWith('/availability')).map((c) => c.url)).toContain('/api/v1/public/availability?days=7')
  })

  it('an add-on the catalog does not carry is refused, not dropped or swapped ("Stain removal" is not "Pet hair removal")', async () => {
    at('2026-10-10T10:00:00-04:00')
    const cat = { services: [{ key: 'signature-hand-wash', name: 'Signature Hand Wash' }], addons: production.addons }
    const t = liveSite(cat)
    await guestReview(t, ['stain'])
    t.c.sheetVals().sh.cta()
    await t.settle()
    expect(posts(t.calls, '/public/bookings')).toHaveLength(0)
    expect(t.c.state.toast).toMatch(/^Stain removal can't be booked online yet/)
  })

  it('a configured key the catalog has, or the catalog item with the design\'s exact name, is booked', async () => {
    at('2026-10-10T10:00:00-04:00')
    const cat = { services: [{ key: 'signature-wash', name: 'Signature Hand Wash' }], addons: production.addons }
    const t = liveSite(cat)
    await guestReview(t, ['leather'])
    t.c.sheetVals().sh.cta()
    await t.settle()
    const p = posts(t.calls, '/public/bookings')
    expect(p).toHaveLength(1)
    expect(p[0]!.body).toMatchObject({ serviceKey: 'signature-wash', addonKeys: ['leather-conditioning'] })
  })
})

describe('members (findings: first name over the full name, member pricing without an active membership)', () => {
  const memberRoutes = (member: any, extra: Record<string, Handler> = {}) => ({
    '/api/v1/public/catalog': catalogRoute(),
    '/api/v1/public/availability': availRoute(board1),
    '/api/v1/public/otp': () => ({ status: 202, body: { challengeId: '7a3e1f0c-2b4d-4c6e-8f00-123456789abc', expiresInSec: 600 } }),
    '/api/v1/public/otp/verify': () => ok({ memberToken: 'tok_' + 'x'.repeat(40), expiresInSec: 1800, member }),
    '/api/v1/public/bookings': () => ({ status: 201, body: { bookingRef: 'OAS-00043', status: 'booked', deposit: { dueCents: member.active ? 0 : 2500, how: 'counter' }, confirmationBy: 'sms' } }),
    ...extra,
  })
  const signIn = async (t: ReturnType<typeof makeSite>) => {
    t.c.pickSlot(1, { m: 540, st: 'open', bays: 3 })
    await t.settle()
    t.c.setBk({ phone: '201-555-0199' })
    t.c.sheetVals().memberContinue()
    await t.settle()
    t.c.setBk({ code: '123456' })
    t.c.renderVals().site.codeContinue()
    await t.settle()
  }

  it('an active member books under the name they type; the first name from the code check is never sent as the name', async () => {
    at('2026-10-10T10:00:00-04:00')
    const t = makeSite({ booking: 'live', availability: board1, routes: memberRoutes({ firstName: 'Jane', tier: 'vip', washesLeft: 3, active: true }) })
    await signIn(t)
    expect(t.c.state.bk.who).toBe('member')
    expect(t.c.state.bk.name).not.toBe('Jane')
    expect(t.c.state.step).toBe('review')
    expect(t.c.renderVals().site).toMatchObject({ guestDetails: true, askPhone: false })
    t.c.sheetVals().sh.cta()
    await t.settle()
    expect(posts(t.calls, '/public/bookings')).toHaveLength(0)
    expect(t.c.state.toast).toBe('Add your full name')
    t.c.setBk({ name: 'Jane Smith' })
    t.c.sheetVals().sh.cta()
    await t.settle()
    const p = posts(t.calls, '/public/bookings')
    expect(p).toHaveLength(1)
    expect(p[0]!.body.name).toBe('Jane Smith')
    expect(p[0]!.body.memberToken).toMatch(/^tok_/)
  })

  it('a verified number without an active membership books as a guest: guest prices, the fee line and its terms', async () => {
    at('2026-10-10T10:00:00-04:00')
    const t = makeSite({ booking: 'live', availability: board1, routes: memberRoutes({ firstName: 'Jane', tier: null, washesLeft: null, active: false }) })
    await signIn(t)
    expect(t.c.state.tier).toBeNull()
    expect(t.c.state.bk.who).toBe('guest')
    expect(t.c.state.toast).toBe('No active membership on this number. You can book as a guest.')
    t.c.setState({ step: 'review' })
    const sh = t.c.sheetVals().sh
    expect(sh.lines.map((l: any) => l.label)).toContain('Booking fee · non-refundable')
    expect(sh.dueLabel).not.toBe('Due at pickup')
    t.c.setBk({ name: 'Jane Smith' })
    sh.cta()
    await t.settle()
    expect(posts(t.calls, '/public/bookings')).toHaveLength(0)
    expect(t.c.state.toast).toBe('Please confirm the booking fee terms')
  })

  it('after a join (pending payment) "Book your first wash" opens the member sign-in, not member pricing', async () => {
    at('2026-10-10T10:00:00-04:00')
    vi.useRealTimers()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const t = makeSite({
      booking: 'live',
      availability: board1,
      routes: { ...memberRoutes({ active: false }), '/api/v1/public/memberships': () => ({ status: 201, body: { memberRef: 'OAS-M-1', status: 'pending_payment', next: 'checkout_link_by_sms', tier: 'gold' } }) },
    })
    t.c.setState({ page: 'join', jn: { ...t.c.state.jn, tier: 'gold', step: 3, name: 'Jo Park', phone: '201-555-0143', email: 'jo@example.com', vehicles: [{ car: 'Tesla', plate: '' }], agree: true } })
    t.c.joinVM().jv.next()
    await vi.advanceTimersByTimeAsync(10)
    expect(t.c.state.jn.step).toBe(4)
    expect(t.c.state.tier).toBeNull()
    t.c.joinVM().jv.bookFirst()
    await vi.advanceTimersByTimeAsync(250)
    expect(t.c.state.sheet).toBe('book')
    expect(t.c.state.step).toBe('who')
    expect(t.c.state.bk.who).not.toBe('member')
  })
})

describe('Idempotency-Key and conflicts (findings: key missing/stale, 409 in flight)', () => {
  const created = (ref: string) => ({ status: 201, body: { bookingRef: ref, status: 'booked', deposit: { dueCents: 2500, how: 'counter' }, confirmationBy: 'sms' } })
  const bookingSite = (bookings: Handler, extra: Record<string, Handler> = {}) =>
    makeSite({ booking: 'live', availability: board1, routes: { '/api/v1/public/catalog': catalogRoute(), '/api/v1/public/availability': availRoute(board1), '/api/v1/public/bookings': bookings, ...extra } })
  const fillAndBook = async (t: ReturnType<typeof makeSite>) => {
    t.c.setBk({ ack: true, name: 'Jamie Rivera', phone: '201-555-0141' })
    t.c.setState({ step: 'review' })
    t.c.sheetVals().sh.cta()
    await t.settle()
  }

  it('the comparison table\'s Book (openBookGuest, not openBook) sends a key', async () => {
    at('2026-10-10T10:00:00-04:00')
    const t = bookingSite(() => created('OAS-00050'))
    t.c.renderVals().openBookGuest()
    t.c.setBk({ day: 1, slot: 540 })
    await fillAndBook(t)
    const p = posts(t.calls, '/public/bookings')
    expect(p).toHaveLength(1)
    expect(p[0]!.headers['idempotency-key']).toMatch(/.{8,}/)
    expect(t.c.state.step).toBe('done')
  })

  it('a second booking after closing the confirmation with X gets a new key; a retry of the same body keeps it; the join has its own', async () => {
    at('2026-10-10T10:00:00-04:00')
    let n = 0
    const t = bookingSite(
      () => {
        n++
        if (n === 2) throw new Error('network down')
        return created(`OAS-0005${n}`)
      },
      { '/api/v1/public/memberships': () => ({ status: 201, body: { memberRef: 'OAS-M-1', status: 'pending_payment' } }) },
    )
    t.c.pickSlot(1, { m: 540, st: 'open', bays: 3 })
    await t.settle()
    t.c.sheetVals().guestContinue()
    await fillAndBook(t)
    t.c.sheetVals().closeSheet() // X on the done step
    t.c.pickSlot(1, { m: 570, st: 'open', bays: 3 })
    await t.settle()
    t.c.sheetVals().guestContinue()
    await fillAndBook(t) // the network fails
    t.c.sheetVals().sh.cta() // the visitor taps Book again: the same request
    await t.settle()
    const keys = posts(t.calls, '/public/bookings').map((c) => c.headers['idempotency-key'])
    expect(keys).toHaveLength(3)
    expect(keys[1]).not.toBe(keys[0])
    expect(keys[2]).toBe(keys[1])
    t.c.setState({ page: 'join', jn: { ...t.c.state.jn, tier: 'gold', step: 3, name: 'Jo Park', phone: '201-555-0143', email: 'jo@example.com', vehicles: [{ car: 'Tesla', plate: '' }], agree: true } })
    t.c.joinVM().jv.next()
    await t.settle()
    const joinKey = posts(t.calls, '/public/memberships')[0]!.headers['idempotency-key']
    expect(keys).not.toContain(joinKey)
  })

  it('409 IDEMPOTENCY_IN_FLIGHT waits and sends the same request again (not "pick another time")', async () => {
    at('2026-10-10T10:00:00-04:00')
    let n = 0
    const t = bookingSite(() => (++n === 1 ? { status: 409, body: { status: 409, code: 'IDEMPOTENCY_IN_FLIGHT', title: 'Already in progress' }, headers: { 'retry-after': '1' } } : created('OAS-00060')))
    t.c.pickSlot(1, { m: 540, st: 'open', bays: 3 })
    await t.settle()
    t.c.sheetVals().guestContinue()
    t.c.setBk({ ack: true, name: 'Jamie Rivera', phone: '201-555-0141' })
    t.c.setState({ step: 'review' })
    t.c.sheetVals().sh.cta()
    await new Promise((r) => setTimeout(r, 1300))
    await t.settle()
    const p = posts(t.calls, '/public/bookings')
    expect(p).toHaveLength(2)
    expect(p[1]!.headers['idempotency-key']).toBe(p[0]!.headers['idempotency-key'])
    expect(t.c.state.step).toBe('done')
    expect(t.c.state.bk.slot).toBe(540)
  })

  it('only a PUBLIC_SLOT_* answer sends the visitor back to the times; a join conflict leaves the booking sheet alone', async () => {
    at('2026-10-10T10:00:00-04:00')
    const t = bookingSite(() => ({ status: 409, body: { status: 409, code: 'PUBLIC_SLOT_TAKEN', title: 'That time was just taken. Pick another.' } }), {
      '/api/v1/public/memberships': () => ({ status: 409, body: { status: 409, code: 'PUBLIC_ALREADY_MEMBER', title: 'This number already has a membership. Text us to change your plan.' } }),
    })
    t.c.pickSlot(1, { m: 540, st: 'open', bays: 3 })
    await t.settle()
    t.c.sheetVals().guestContinue()
    await fillAndBook(t)
    expect(t.c.state.bk.slot).toBeNull()
    expect(t.c.state.step).toBe('time')
    t.c.setBk({ slot: 570 })
    t.c.setState({ sheet: null })
    const before = t.calls.length
    t.c.setState({ page: 'join', jn: { ...t.c.state.jn, tier: 'gold', step: 3, name: 'Jo Park', phone: '201-555-0143', email: 'jo@example.com', vehicles: [{ car: 'Tesla', plate: '' }], agree: true } })
    t.c.joinVM().jv.next()
    await t.settle()
    expect(t.c.state.toast).toBe('This number already has a membership. Text us to change your plan.')
    expect(t.c.state.bk.slot).toBe(570)
    expect(t.calls.slice(before).filter((c) => c.path.endsWith('/availability'))).toHaveLength(0)
  })
})

describe('joining (finding: the API needs the receipts e-mail)', () => {
  it('live mode asks for the e-mail on the details step, and a 422 on body.email goes back there with the API\'s words', async () => {
    at('2026-10-10T10:00:00-04:00')
    const t = makeSite({
      booking: 'live',
      routes: {
        '/api/v1/public/memberships': () => ({
          status: 422,
          body: { status: 422, code: 'VALIDATION_FAILED', title: 'Check the form', detail: 'Invalid email address', errors: [{ path: 'body.email', message: 'Invalid email address' }] },
        }),
      },
    })
    const jn = { ...t.c.state.jn, tier: 'gold', step: 2, name: 'Jo Park', phone: '201-555-0143', email: '', vehicles: [{ car: 'Tesla', plate: '' }] }
    t.c.setState({ page: 'join', jn })
    t.c.joinVM().jv.next()
    expect(t.c.state.jn).toMatchObject({ step: 2, err: 'Add your email for the receipts.' })
    t.c.setJn({ email: 'jo@example.com', err: '' })
    t.c.joinVM().jv.next()
    expect(t.c.state.jn.step).toBe(3)
    t.c.setJn({ agree: true })
    t.c.joinVM().jv.next()
    await t.settle()
    expect(t.c.state.jn).toMatchObject({ step: 2, err: 'Invalid email address' })
  })

  it('sms mode keeps the e-mail optional (the text names what was given)', () => {
    at('2026-10-10T10:00:00-04:00')
    const t = makeSite({ booking: 'sms' })
    t.c.setState({ page: 'join', jn: { ...t.c.state.jn, tier: 'gold', step: 2, name: 'Jo Park', phone: '201-555-0143', email: '', vehicles: [{ car: 'Tesla', plate: '' }] } })
    t.c.joinVM().jv.next()
    expect(t.c.state.jn.step).toBe(3)
  })
})
