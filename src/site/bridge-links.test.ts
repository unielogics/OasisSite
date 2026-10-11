// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
// Personal links on the REAL design logic (bridge.testkit.ts): DV-LINK, DV-STEPUP, DV-LINK-JOIN, DV-LINK-PAY,
// DV-LINK-DEAD. The link API is scripted per test in the API's own shapes (backend docs/api-spec.md section 28, built by
// link-contract.testkit.ts).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installLinkCapture, resetLinkCapture } from '../client/link'
import { configCatalog, makeSite, payload, type Call, type Handler } from './bridge.testkit'
import { exchangeAnswer as exchanged, invoiceAnswer, linkState, planAnswer, stepAnswer as stepped } from './link-contract.testkit'
import { allowedRedirect, planTier, shopDate, validateExchange, whoLabel } from './links'

beforeAll(() => {
  process.env.TZ = 'America/New_York'
})
const at = (iso: string) => vi.setSystemTime(new Date(iso))
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  at('2026-10-10T10:00:00-04:00')
  ;(window as any).__oasisNavigations = []
  window.scrollTo = (() => {}) as any
  ;(window as any).__oasisNavigate = (u: string) => (window as any).__oasisNavigations.push(u)
  resetLinkCapture()
  history.replaceState(null, '', '/')
})
afterEach(() => {
  vi.useRealTimers()
  delete (window as any).__oasisNavigate
  resetLinkCapture()
})
const navigations = (): string[] => (window as any).__oasisNavigations

const TOKEN = 'TGlua1Rva2VuRm9yTWFyaWEtMzItYnl0ZXMtYmFzZTY0dXI'
const TOKEN2 = 'U2Vjb25kTGlua0Zvckpvc2UtMzItYnl0ZXMtYmFzZTY0dXI'
const BASE = '/api/v1/public/links'
const MON = '2026-10-12'
const board = payload([{ date: '2026-10-10', slots: [[660, 'open', 3]] }, { date: MON, slots: [[540, 'open', 3], [570, 'vip', 1]] }])

const ok = (body: unknown, status = 200) => ({ status, body })
const prob = (status: number, code: string, title: string, extra: Record<string, unknown> = {}) => ({ status, body: { type: 'about:blank', status, code, title, ...extra } })


/** Opens the page with `#/<path>/<token>` captured exactly like the browser does (scrubbed, in memory). */
function openWith(path: string, token: string, routes: Record<string, Handler>, booking: 'sms' | 'live' = 'sms') {
  history.replaceState(null, '', `/#/${path}/${token}`)
  installLinkCapture(window as never)
  const t = makeSite({
    booking,
    availability: board,
    routes: {
      '/api/v1/public/catalog': () => ok({ generatedAt: new Date().toISOString(), ...configCatalog(), plans: [] }),
      '/api/v1/public/availability': () => ok(board),
      ...routes,
    },
  })
  t.c.__lkMount()
  return t
}
const linkCalls = (calls: Call[]) => calls.filter((c) => c.path.startsWith(BASE))
const sh = (c: any) => c.sheetVals().sh
const lv = (c: any) => c.renderVals().site.link

describe('no link, or links switched off: the site as today', () => {
  it('without a fragment nothing is exchanged and the link blocks are off', async () => {
    const t = makeSite({ booking: 'sms', availability: board, routes: {} })
    t.c.__lkMount()
    await t.settle()
    expect(linkCalls(t.calls)).toEqual([])
    const v = t.c.renderVals().site
    expect(v.sheetSummary).toBe(true)
    expect(v.link).toMatchObject({ on: false, sheetStepUp: false, joinStepUp: false, joinEmail: false, notice: { show: false }, pay: { show: false } })
  })

  it('PUBLIC_LINKS_ENABLED off (404): no sheet, no toast, the URL is scrubbed anyway', async () => {
    const t = openWith('c', TOKEN, { [`${BASE}/exchange`]: () => prob(404, 'ROUTE_NOT_FOUND', 'Route not found') })
    const before = { ...t.c.state }
    await t.settle()
    expect(location.href).not.toContain(TOKEN)
    expect(t.c.state.sheet).toBe(before.sheet)
    expect(t.c.state.toast).toBeNull()
    expect(t.c.state.page).toBe('home')
    expect(t.c.__lk).toBeNull()
    // the Book buttons still open the design's own who step
    t.c.openBook({})
    expect(t.c.state.step).toBe('who')
  })
})

describe('DV-LINK: a calendar link books for its client', () => {
  it('trusted member: the sheet opens at the wash step, "BOOKING FOR MARIA ••51", the board is the client\'s, Book posts the link booking', async () => {
    const t = openWith('c', TOKEN, {
      [`${BASE}/exchange`]: () => ok(exchanged({ tier: 'vip', verified: true })),
      [`${BASE}/availability`]: () => ok(board),
      [`${BASE}/bookings`]: () => ok({ bookingRef: 'OAS-00077', status: 'booked', deposit: { dueCents: 0, how: 'counter' }, member: true }, 201),
    })
    await t.settle()
    const c = t.c
    expect(c.state).toMatchObject({ sheet: 'book', step: 'svc', tier: 'vip' })
    expect(c.state.bk.who).toBe('member')
    expect(sh(c).eyebrow).toBe('BOOKING FOR MARIA ••51 · STEP 1 OF 3')
    expect(sh(c).canBack).toBe(false)
    // the per-client board, with the session
    const av = t.calls.filter((x) => x.path === `${BASE}/availability`)
    expect(av.length).toBeGreaterThanOrEqual(1)
    expect(av[0]!.headers.authorization).toBe('Bearer sess-1')
    expect(av[0]!.url).toBe(`${BASE}/availability?days=7&service=signature-hand-wash`)
    c.setBk({ day: 1, slot: 540 })
    c.setState({ step: 'review' })
    expect(sh(c).eyebrow).toBe('BOOKING FOR MARIA ••51 · STEP 3 OF 3')
    expect(c.renderVals().site.guestDetails).toBe(false) // the link knows the client: no name, no phone
    sh(c).cta()
    await t.settle()
    const b = t.calls.filter((x) => x.path === `${BASE}/bookings`)
    expect(b).toHaveLength(1)
    expect(b[0]!.headers.authorization).toBe('Bearer sess-1')
    expect(b[0]!.headers['idempotency-key']).toBeTruthy()
    expect(b[0]!.body).toEqual({ serviceKey: 'signature-hand-wash', addonKeys: [], date: MON, startMin: 540, vehicle: { label: 'Sedan / Coupe' } })
    expect(c.state.step).toBe('done')
    expect(sh(c).doneSub).toContain('Ref OAS-00077')
    // nothing went to the public booking API or the sms: text
    expect(t.calls.filter((x) => x.path === '/api/v1/public/bookings')).toEqual([])
    expect(navigations()).toEqual([])
  })

  it('every Book button of the page books for the link\'s client while the link is open', async () => {
    const t = openWith('c', TOKEN, { [`${BASE}/exchange`]: () => ok(exchanged({ verified: true })), [`${BASE}/availability`]: () => ok(board) })
    await t.settle()
    t.c.setState({ sheet: null })
    t.c.openBook({ svc: 'exterior' })
    expect(t.c.state).toMatchObject({ sheet: 'book', step: 'svc' })
    expect(t.c.state.bk).toMatchObject({ who: 'guest', svc: 'exterior' })
    expect(sh(t.c).eyebrow).toBe('BOOKING FOR MARIA ••51 · STEP 1 OF 3')
  })

  it('not trusted yet: Book asks to confirm (texted code), then books by itself', async () => {
    let confirmed = false
    const t = openWith('c', TOKEN, {
      [`${BASE}/exchange`]: () => ok(exchanged({ verified: false })),
      [`${BASE}/availability`]: () => ok(board),
      [`${BASE}/verify/code`]: (call) =>
        call.body.purpose === undefined || call.body.purpose === 'verify'
          ? ok({ challengeId: 'ch-1', expiresInSec: 600, purpose: 'verify', to: '51' }, 202)
          : prob(422, 'VALIDATION_FAILED', 'Check the form', { errors: [{ path: 'body.purpose', message: 'Invalid enum value' }] }),
      [`${BASE}/verify/code/confirm`]: (call) => {
        if (call.body.code !== '123456') return prob(401, 'PUBLIC_OTP_INVALID', 'That code didn’t match', { detail: 'That code didn’t match. 2 more tries before you need a new one.' })
        confirmed = true
        return ok(stepped({ by: 'code' }))
      },
      [`${BASE}/bookings`]: () => (confirmed ? ok({ bookingRef: 'OAS-00078', deposit: { dueCents: 2500, how: 'counter' } }, 201) : prob(403, 'IDENTITY_STEP_UP_REQUIRED', 'Confirm it’s you')),
    })
    await t.settle()
    const c = t.c
    c.setBk({ day: 1, slot: 540, ack: true })
    c.setState({ step: 'review' })
    sh(c).cta()
    await t.settle()
    expect(c.state.step).toBe('verify')
    expect(lv(c).sheetStepUp).toBe(true)
    expect(sh(c)).toMatchObject({ eyebrow: 'BOOKING FOR MARIA ••51', title: 'Confirm it’s you', canBack: true })
    expect(lv(c).su).toMatchObject({ send: true, sendLabel: 'Text me a code', sub: 'We’ll text a 6-digit code to ••51.' })
    lv(c).su.sendCode()
    await t.settle()
    const send = t.calls.find((x) => x.path === `${BASE}/verify/code`)!
    // the API's purposes are verify | pin_set | pin_reset (F1 of the 2026-10-11 review: 'link_verify' was a 422); no phone:
    // the code goes to the link's number
    expect(send.body).toEqual({ purpose: 'verify' })
    expect(lv(c).su).toMatchObject({ code: true, title: 'Enter the code we texted' })
    lv(c).su.setValue({ target: { value: '111111' } })
    lv(c).su.submit()
    await t.settle()
    expect(lv(c).su.err).toBe('That code didn’t match. 2 more tries before you need a new one.')
    lv(c).su.setValue({ target: { value: '12 34 56' } })
    expect(lv(c).su.value).toBe('123456')
    lv(c).su.submit()
    await t.settle()
    expect(t.calls.filter((x) => x.path === `${BASE}/bookings`)).toHaveLength(1)
    expect(c.state.step).toBe('done')
    expect(c.__lk.trust).toMatchObject({ verified: true, until: '2026-11-09T14:00:00.000Z' })
  })

  it('a record the stale-record rule hides: confirm first, then the name comes back and none is asked', async () => {
    let confirmed = false
    const t = openWith('c', TOKEN, {
      // the API hides the first name until the page is verified ('' like a stranger's)
      [`${BASE}/exchange`]: () => ok(exchanged({ firstName: null })),
      [`${BASE}/availability`]: () => ok(board),
      [`${BASE}/verify/code`]: () => ok({ challengeId: 'ch-s', expiresInSec: 600, purpose: 'verify', to: '51' }, 202),
      [`${BASE}/verify/code/confirm`]: () => {
        confirmed = true
        return ok(stepped({ firstName: 'Maria', by: 'code' }))
      },
      [`${BASE}/bookings`]: () => (confirmed ? ok({ bookingRef: 'OAS-00082' }, 201) : prob(403, 'IDENTITY_STEP_UP_REQUIRED', 'Confirm it’s you')),
    })
    await t.settle()
    const c = t.c
    expect(sh(c).eyebrow).toBe('BOOKING FOR ••51 · STEP 1 OF 3')
    c.setBk({ day: 1, slot: 540, ack: true })
    c.setState({ step: 'review' })
    sh(c).cta()
    await t.settle()
    expect(c.state.toast).not.toBe('Add your full name')
    expect(c.state.step).toBe('verify')
    lv(c).su.sendCode()
    await t.settle()
    lv(c).su.setValue({ target: { value: '123456' } })
    lv(c).su.submit()
    await t.settle()
    const b = t.calls.filter((x) => x.path === `${BASE}/bookings`)
    expect(b).toHaveLength(1)
    expect(b[0]!.body.name).toBeUndefined()
    expect(c.state.step).toBe('done')
    expect(c.__lk.client.firstName).toBe('Maria')
  })

  it('a stranger\'s calendar link asks for a full name and sends it', async () => {
    const t = openWith('c', TOKEN, {
      [`${BASE}/exchange`]: () => ok(exchanged({ firstName: null, verified: true })),
      [`${BASE}/availability`]: () => ok(board),
      [`${BASE}/bookings`]: () => ok({ bookingRef: 'OAS-00079' }, 201),
    })
    await t.settle()
    const c = t.c
    expect(sh(c).eyebrow).toBe('BOOKING FOR ••51 · STEP 1 OF 3')
    c.setBk({ day: 1, slot: 540, ack: true })
    c.setState({ step: 'review' })
    expect(c.renderVals().site).toMatchObject({ guestDetails: true, askPhone: false })
    sh(c).cta()
    await t.settle()
    expect(c.state.toast).toBe('Add your full name')
    c.setBk({ name: 'Jose Ortiz' })
    sh(c).cta()
    await t.settle()
    expect(t.calls.find((x) => x.path === `${BASE}/bookings`)!.body).toMatchObject({ name: 'Jose Ortiz' })
  })

  it('a page that timed out is opened again once with the token in memory, then the call is repeated', async () => {
    let n = 0
    const t = openWith('c', TOKEN, {
      [`${BASE}/exchange`]: () => ok(exchanged({ verified: true }, `sess-${++n}`)),
      [`${BASE}/availability`]: () => ok(board),
      [`${BASE}/bookings`]: (call) => (call.headers.authorization === 'Bearer sess-1' ? prob(401, 'IDENTITY_SESSION_INVALID', 'Open your link again') : ok({ bookingRef: 'OAS-00080' }, 201)),
    })
    await t.settle()
    t.c.setBk({ day: 1, slot: 540, ack: true })
    t.c.setState({ step: 'review' })
    sh(t.c).cta()
    await t.settle()
    const ex = t.calls.filter((x) => x.path === `${BASE}/exchange`)
    expect(ex.map((x) => x.body)).toEqual([{ token: TOKEN }, { token: TOKEN }])
    const books = t.calls.filter((x) => x.path === `${BASE}/bookings`)
    expect(books.map((x) => x.headers.authorization)).toEqual(['Bearer sess-1', 'Bearer sess-2'])
    expect(books[0]!.headers['idempotency-key']).toBe(books[1]!.headers['idempotency-key'])
    expect(t.c.state.step).toBe('done')
  })

  it('the token is sent in one place only: the exchange body', async () => {
    const t = openWith('c', TOKEN, {
      [`${BASE}/exchange`]: () => ok(exchanged({ verified: true })),
      [`${BASE}/availability`]: () => ok(board),
      [`${BASE}/bookings`]: () => ok({ bookingRef: 'OAS-00081' }, 201),
    })
    await t.settle()
    t.c.setBk({ day: 1, slot: 540, ack: true })
    t.c.setState({ step: 'review' })
    sh(t.c).cta()
    await t.settle()
    for (const call of t.calls) {
      expect(call.url).not.toContain(TOKEN)
      expect(JSON.stringify(call.headers)).not.toContain(TOKEN)
      if (call.path !== `${BASE}/exchange`) expect(JSON.stringify(call.body ?? null)).not.toContain(TOKEN)
    }
    expect(JSON.stringify(t.c.renderVals().site)).not.toContain(TOKEN)
    expect(location.href).not.toContain(TOKEN)
  })
})

describe('DV-STEPUP: PIN, lockout, create PIN', () => {
  it('a client with a PIN gets the PIN field; wrong PINs show the API\'s words; the lockout hides the field and offers the reset', async () => {
    let tries = 0
    const t = openWith('v', TOKEN, {
      [`${BASE}/exchange`]: () => ok(exchanged({ kind: 'verify', pin: 'set' })),
      [`${BASE}/verify/pin`]: () => {
        tries++
        if (tries < 5) return prob(401, 'IDENTITY_PIN_INVALID', 'That PIN didn’t match', { detail: `That PIN didn’t match. ${5 - tries} more tries on this page.` })
        return prob(429, 'IDENTITY_PIN_LOCKED', 'PIN locked for now', { detail: 'Too many wrong PINs. Try again in 15 min, or reset your PIN with a texted code.' })
      },
    })
    await t.settle()
    const c = t.c
    expect(c.state.sheet).toBe('link')
    expect(lv(c).sheetStepUp).toBe(true)
    expect(c.renderVals().site.sheetSummary).toBe(false)
    expect(sh(c)).toMatchObject({ eyebrow: 'VERIFY · MARIA ••51', title: 'Confirm it’s you' })
    expect(lv(c).su).toMatchObject({ pin: true, title: 'Enter your PIN', alt: 'Forgot your PIN? Text me a code' })
    lv(c).su.setValue({ target: { value: '12' } })
    lv(c).su.submit()
    await t.settle()
    expect(lv(c).su.err).toBe('Enter your 4 to 6 digit PIN.')
    for (let i = 0; i < 4; i++) {
      lv(c).su.setValue({ target: { value: '4826' } })
      lv(c).su.submit()
      await t.settle()
    }
    expect(lv(c).su.err).toBe('That PIN didn’t match. 1 more tries on this page.')
    lv(c).su.setValue({ target: { value: '4826' } })
    lv(c).su.submit()
    await t.settle()
    expect(lv(c).su).toMatchObject({ pin: false, title: 'Your PIN is locked', err: 'Too many wrong PINs. Try again in 15 min, or reset your PIN with a texted code.' })
    lv(c).su.altClick()
    expect(lv(c).su).toMatchObject({ send: true, title: 'Reset your PIN' })
  })

  it('five wrong tries end the page: "Too many tries"', async () => {
    const t = openWith('v', TOKEN, {
      [`${BASE}/exchange`]: () => ok(exchanged({ kind: 'verify', pin: 'set' })),
      [`${BASE}/verify/pin`]: () => prob(429, 'IDENTITY_SESSION_LOCKED', 'Too many tries'),
    })
    await t.settle()
    lv(t.c).su.setValue({ target: { value: '4826' } })
    lv(t.c).su.submit()
    await t.settle()
    expect(sh(t.c).title).toBe('Too many tries')
    expect(lv(t.c).notice).toMatchObject({ show: true, ok: false })
    expect(t.c.__lk).toBeNull()
  })

  it('a verify link: code, "You\'re verified" until the trust date, then an optional PIN', async () => {
    const t = openWith('v', TOKEN, {
      [`${BASE}/exchange`]: () => ok(exchanged({ kind: 'verify' })),
      [`${BASE}/verify/code`]: () => ok({ challengeId: 'ch-2', expiresInSec: 600, purpose: 'verify', to: '51' }, 202),
      [`${BASE}/verify/code/confirm`]: () => ok(stepped({ kind: 'verify', by: 'code', canSetPin: true })),
      [`${BASE}/pin`]: (call) =>
        call.body.pin === '1234'
          ? prob(422, 'IDENTITY_PIN_REJECTED', 'Choose another PIN', { detail: 'Don’t use a run like 1234. Choose another PIN.' })
          : ok(stepped({ kind: 'verify', by: 'code', pin: 'set' })),
    })
    await t.settle()
    const c = t.c
    lv(c).su.sendCode()
    await t.settle()
    lv(c).su.setValue({ target: { value: '654321' } })
    lv(c).su.submit()
    await t.settle()
    expect(sh(c).title).toBe('You’re verified')
    expect(lv(c).notice).toMatchObject({ show: true, ok: true, action: 'Create a PIN for next time' })
    expect(lv(c).notice.text).toContain('verified until Nov 9')
    lv(c).notice.actionClick()
    expect(lv(c).su).toMatchObject({ create: true, title: 'Create your PIN', alt: 'Skip for now' })
    lv(c).su.setValue({ target: { value: '1234' } })
    lv(c).su.submit()
    await t.settle()
    expect(lv(c).su.err).toBe('Don’t use a run like 1234. Choose another PIN.')
    lv(c).su.setValue({ target: { value: '4826' } })
    lv(c).su.submit()
    await t.settle()
    expect(sh(c).title).toBe('Your PIN is set')
    expect(t.calls.find((x) => x.path === `${BASE}/pin` && x.body.pin === '4826')).toBeTruthy()
    expect(t.c.__lk.stepUp.method).toBe('pin')
  })

  it('no PIN offer where the API opens no window to choose one (a stranger\'s link: stepUp.canSetPinUntil null)', async () => {
    const t = openWith('v', TOKEN, {
      [`${BASE}/exchange`]: () => ok(exchanged({ kind: 'verify', firstName: null })),
      [`${BASE}/verify/code`]: () => ok({ challengeId: 'ch-2b', expiresInSec: 600, purpose: 'verify', to: '51' }, 202),
      [`${BASE}/verify/code/confirm`]: () => ok(stepped({ kind: 'verify', firstName: null, by: 'code', canSetPin: false })),
    })
    await t.settle()
    lv(t.c).su.sendCode()
    await t.settle()
    lv(t.c).su.setValue({ target: { value: '654321' } })
    lv(t.c).su.submit()
    await t.settle()
    expect(sh(t.c).title).toBe('You’re verified')
    expect(lv(t.c).notice.action).toBe('')
  })

  it('stepUp.method "pin" opens the PIN entry straight away: no code is asked for first (F4 of the 2026-10-11 review)', async () => {
    const t = openWith('v', TOKEN, {
      [`${BASE}/exchange`]: () => ok(exchanged({ kind: 'verify', pin: 'set' })),
      [`${BASE}/verify/pin`]: () => ok(stepped({ kind: 'verify', pin: 'set', by: 'pin' })),
    })
    await t.settle()
    expect(lv(t.c).su).toMatchObject({ pin: true, send: false, title: 'Enter your PIN' })
    lv(t.c).su.setValue({ target: { value: '4826' } })
    lv(t.c).su.submit()
    await t.settle()
    expect(t.calls.filter((x) => x.path === `${BASE}/verify/code`)).toEqual([])
    expect(sh(t.c).title).toBe('You’re verified')
    expect(lv(t.c).notice.action).toBe('') // a client with a PIN is not offered another
  })

  it('a PIN link for a client with a PIN resets it: code (pin_reset) -> new PIN -> /pin/reset', async () => {
    const t = openWith('pin', TOKEN, {
      [`${BASE}/exchange`]: () => ok(exchanged({ kind: 'pin', pin: 'set' })),
      [`${BASE}/verify/code`]: (call) => ok({ challengeId: 'ch-3', expiresInSec: 600, purpose: call.body.purpose, to: '51' }, 202),
      [`${BASE}/verify/code/confirm`]: () => ok(stepped({ kind: 'pin', pin: 'set', canSetPin: true }, false)),
      [`${BASE}/pin/reset`]: () => ok(stepped({ kind: 'pin', pin: 'set', by: 'code' })),
    })
    await t.settle()
    const c = t.c
    expect(lv(c).su).toMatchObject({ send: true, title: 'Reset your PIN', alt: '' })
    lv(c).su.sendCode()
    await t.settle()
    expect(t.calls.find((x) => x.path === `${BASE}/verify/code`)!.body).toEqual({ purpose: 'pin_reset' })
    lv(c).su.setValue({ target: { value: '222333' } })
    lv(c).su.submit()
    await t.settle()
    expect(lv(c).su).toMatchObject({ create: true, title: 'Choose a new PIN', alt: '' })
    lv(c).su.setValue({ target: { value: '4826' } })
    lv(c).su.submit()
    await t.settle()
    expect(t.calls.find((x) => x.path === `${BASE}/pin/reset`)!.body).toEqual({ pin: '4826' })
    expect(sh(c).title).toBe('Your PIN is set')
  })

  it('a PIN set meanwhile: a code request answered "Enter your PIN" switches to the PIN field', async () => {
    const t = openWith('v', TOKEN, {
      [`${BASE}/exchange`]: () => ok(exchanged({ kind: 'verify' })),
      [`${BASE}/verify/code`]: () => prob(409, 'IDENTITY_PIN_REQUIRED', 'Enter your PIN', { detail: 'Enter your PIN to continue, or reset it with a texted code.' }),
    })
    await t.settle()
    lv(t.c).su.sendCode()
    await t.settle()
    expect(lv(t.c).su).toMatchObject({ pin: true, title: 'Enter your PIN' })
  })
})

describe('DV-LINK-DEAD', () => {
  for (const [reason, title] of [
    ['expired', 'This link expired'],
    ['used', 'This link was used'],
    ['revoked', 'This link was replaced'],
    ['not_found', 'This link doesn’t work'],
  ] as const) {
    it(`${reason}: "${title}", a text-us link to the texting number and back to home`, async () => {
      const t = openWith('c', TOKEN, { [`${BASE}/exchange`]: () => prob(401, 'IDENTITY_LINK_INVALID', 'This link no longer works', { meta: { reason } }) })
      await t.settle()
      expect(t.c.state.sheet).toBe('link')
      expect(sh(t.c)).toMatchObject({ eyebrow: 'PERSONAL LINK', title, hasCta: false })
      const n = lv(t.c).notice
      expect(n).toMatchObject({ show: true, ok: false, smsLabel: 'Text us for a new link' })
      expect(n.smsHref).toMatch(/^sms:\+18623885827\?&body=/)
      n.home()
      expect(t.c.state.sheet).toBeNull()
    })
  }

  it('a booking answered "link used" ends the link', async () => {
    const t = openWith('c', TOKEN, {
      [`${BASE}/exchange`]: () => ok(exchanged({ verified: true })),
      [`${BASE}/availability`]: () => ok(board),
      [`${BASE}/bookings`]: () => prob(409, 'IDENTITY_LINK_USED', 'This link was already used'),
    })
    await t.settle()
    t.c.setBk({ day: 1, slot: 540, ack: true })
    t.c.setState({ step: 'review' })
    sh(t.c).cta()
    await t.settle()
    expect(sh(t.c).title).toBe('This link was used')
    expect(t.c.__lk).toBeNull()
  })
})

describe('a second link in the same tab', () => {
  it('replaces the first: the new token is exchanged, the old session is no longer used', async () => {
    const t = openWith('c', TOKEN, {
      [`${BASE}/exchange`]: (call) =>
        call.body.token === TOKEN2 ? ok({ ...exchanged({ verified: true }, 'sess-B'), client: { firstName: 'Jose', last2: '77', tier: null } }) : ok(exchanged({ verified: true }, 'sess-A')),
      [`${BASE}/availability`]: () => ok(board),
    })
    await t.settle()
    expect(sh(t.c).eyebrow).toContain('MARIA ••51')
    history.pushState(null, '', `/#/c/${TOKEN2}`)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    await t.settle()
    expect(location.href).not.toContain(TOKEN2)
    expect(sh(t.c).eyebrow).toBe('BOOKING FOR JOSE ••77 · STEP 1 OF 3')
    const av = t.calls.filter((x) => x.path === `${BASE}/availability`)
    expect(av[av.length - 1]!.headers.authorization).toBe('Bearer sess-B')
  })
})

describe('DV-LINK-JOIN: plan -> verify -> e-mail -> terms -> Squarespace', () => {
  const plan = planAnswer('gold')
  it('walks the steps, verifies fresh, posts the e-mail only and redirects to the allowed checkout', async () => {
    const t = openWith('m', TOKEN, {
      [`${BASE}/exchange`]: () => ok(exchanged({ kind: 'membership', plan, verified: true })),
      [`${BASE}/verify/code`]: () => ok({ challengeId: 'ch-4', expiresInSec: 600, purpose: 'verify', to: '51' }, 202),
      [`${BASE}/verify/code/confirm`]: () => ok(stepped({ kind: 'membership', plan, by: 'code' })),
      [`${BASE}/membership/start`]: () =>
        ok({ redirectUrl: 'https://oasis-auto-spa.squarespace.com/checkout/subscribe?sku=gold', membershipRef: 'OAS-M-1A2B3C4D', checkoutExpiresAt: '2026-10-13T14:00:00.000Z' }),
    })
    await t.settle()
    const c = t.c
    expect(location.hash).toBe('#/join?gold') // the design's own join route, no token
    // the design's hashchange handler shows the join page (componentDidMount is not run by the test kit)
    c.setState({ page: 'join', jn: c.freshJn('gold') })
    expect(c.state.jn).toMatchObject({ tier: 'gold', name: 'Maria', step: 0 })
    let jv = c.joinVM().jv
    jv.tiers.find((x: any) => x.name === 'VIP').onClick()
    expect(c.state.toast).toBe('This link is for Gold. Text us to switch plans.')
    jv.next() // even a trusted number confirms for a membership
    jv = c.joinVM().jv
    expect(jv).toMatchObject({ s0: false, s2: false, eyebrow: 'STEP 2 OF 4 · CONFIRM IT’S YOU', hasCta: false })
    expect(lv(c).joinStepUp).toBe(true)
    lv(c).su.sendCode()
    await t.settle()
    lv(c).su.setValue({ target: { value: '987654' } })
    lv(c).su.submit()
    await t.settle()
    expect(c.state.jn.step).toBe(2)
    jv = c.joinVM().jv
    expect(jv).toMatchObject({ s2: false, eyebrow: 'STEP 3 OF 4 · EMAIL' })
    expect(lv(c)).toMatchObject({ joinEmail: true, joinAs: 'MARIA ••51', joinStepUp: false })
    jv.next()
    expect(c.state.jn.err).toBe('Add your email for the receipts.')
    jv.setEmail({ target: { value: 'maria@example.com' } })
    c.joinVM().jv.next()
    expect(c.state.jn.step).toBe(3)
    jv = c.joinVM().jv
    expect(jv.ctaLabel).toBe('Continue to checkout')
    jv.next()
    expect(c.state.jn.err).toBe('Please accept the membership terms.')
    c.joinVM().jv.toggleAgree()
    c.joinVM().jv.next()
    await t.settle()
    const start = t.calls.find((x) => x.path === `${BASE}/membership/start`)!
    expect(start.body).toEqual({ email: 'maria@example.com' })
    expect(start.headers.authorization).toBe('Bearer sess-1')
    expect(navigations()).toEqual(['https://oasis-auto-spa.squarespace.com/checkout/subscribe?sku=gold'])
    // nothing went to the public join
    expect(t.calls.filter((x) => x.path === '/api/v1/public/memberships')).toEqual([])
  })

  it('the join page reopened through another plan\'s button stays on the link\'s plan', async () => {
    const t = openWith('m', TOKEN, { [`${BASE}/exchange`]: () => ok(exchanged({ kind: 'membership', plan })) })
    await t.settle()
    const c = t.c
    c.setState({ page: 'join', jn: c.freshJn('gold') })
    c.setState({ page: 'home' })
    c.setState({ page: 'join', jn: c.freshJn('vip') }) // the design's "Join VIP" button
    expect(c.state.jn.tier).toBe('gold')
  })

  it('a Gold link opens Gold (the API\'s plan {tier, planKey, name}; F2 of the 2026-10-11 review)', async () => {
    const t = openWith('m', TOKEN, { [`${BASE}/exchange`]: () => ok(exchanged({ kind: 'membership', plan: planAnswer('gold') })) })
    await t.settle()
    expect(location.hash).toBe('#/join?gold')
    expect(t.c.__lkTier()).toBe('gold')
    t.c.setState({ page: 'join', jn: t.c.freshJn('gold') })
    expect(t.c.state.jn.tier).toBe('gold')
    t.c.joinVM().jv.tiers.find((x: any) => x.name === 'VIP').onClick()
    expect(t.c.state.toast).toBe('This link is for Gold. Text us to switch plans.')
  })

  it('a VIP link whose plan has no tier but a key mapped in site.config.json opens VIP', async () => {
    const t = openWith('m', TOKEN, { [`${BASE}/exchange`]: () => ok(exchanged({ kind: 'membership', plan: { ...planAnswer('vip'), tier: null } })) })
    await t.settle()
    expect(location.hash).toBe('#/join?vip')
  })

  it('a plan the website does not show is never guessed: no join page, a text-us notice', async () => {
    const t = openWith('m', TOKEN, { [`${BASE}/exchange`]: () => ok(exchanged({ kind: 'membership', plan: planAnswer(null, 'family-plan', 'Family') })) })
    await t.settle()
    const c = t.c
    expect(location.hash).not.toMatch(/join/)
    expect(c.__lkTier()).toBeNull()
    expect(sh(c).title).toBe('Let’s finish this by text')
    expect(lv(c).notice).toMatchObject({ show: true, ok: false, smsLabel: 'Text us', text: 'We can’t show the Family plan on the website. Text us and we’ll help you join.' })
    // the site's own Join buttons are the design's join again, not the link's
    c.setState({ sheet: null, page: 'join', jn: c.freshJn('vip') })
    expect(c.state.jn.tier).toBe('vip')
    expect(lv(c).joinStepUp).toBe(false)
    expect(c.joinVM().jv.eyebrow).not.toContain('CONFIRM')
  })

  it('a checkout URL off the allowlist is not followed', async () => {
    const t = openWith('m', TOKEN, {
      [`${BASE}/exchange`]: () => ok(exchanged({ kind: 'membership', plan, pin: 'set' })),
      [`${BASE}/verify/pin`]: () => ok(stepped({ kind: 'membership', plan, pin: 'set', by: 'pin' })),
      [`${BASE}/membership/start`]: () => ok({ redirectUrl: 'https://squarespace.com.evil.example/checkout', membershipRef: 'OAS-M-1', checkoutExpiresAt: '2026-10-13T14:00:00.000Z' }),
    })
    await t.settle()
    const c = t.c
    c.setState({ page: 'join', jn: c.freshJn('gold') })
    c.joinVM().jv.next()
    lv(c).su.setValue({ target: { value: '4826' } })
    lv(c).su.submit()
    await t.settle()
    c.joinVM().jv.setEmail({ target: { value: 'maria@example.com' } })
    c.joinVM().jv.next()
    c.joinVM().jv.toggleAgree()
    c.joinVM().jv.next()
    await t.settle()
    expect(navigations()).toEqual([])
    expect(c.state.jn.err).toBe('We couldn’t open the checkout. Text us at 862-388-5827 and we’ll help you finish.')
  })
})

describe('DV-LINK-PAY: review -> verify -> Squarespace', () => {
  const invoice = invoiceAnswer({ items: [{ name: 'Signature Hand Wash', priceCents: 5000 }], taxCents: 400 })
  it('the review block, then a fresh PIN, then the redirect', async () => {
    const t = openWith('p', TOKEN, {
      [`${BASE}/exchange`]: () => ok(exchanged({ kind: 'pay', invoice, verified: true, pin: 'set' })),
      [`${BASE}/verify/pin`]: () => ok(stepped({ kind: 'pay', invoice, pin: 'set', by: 'pin' })),
      [`${BASE}/pay/start`]: () => ok({ status: 'redirect', redirectUrl: 'https://oasis-auto-spa.squarespace.com/pay/inv-20611' }),
    })
    await t.settle()
    const c = t.c
    expect(c.state.sheet).toBe('link')
    expect(sh(c)).toMatchObject({ eyebrow: 'PAYMENT FOR MARIA ••51', title: 'Review & pay', hasCta: true, ctaLabel: 'Verify & pay $54' })
    // the API's invoice: items, tax, number, date (F3 of the 2026-10-11 review: the lines were empty)
    expect(lv(c).pay).toMatchObject({
      show: true,
      title: 'Invoice #20611',
      sub: 'Fri, Oct 9',
      due: '$54',
      dueLabel: 'Balance due',
      dueSub: 'You’ll pay on Squarespace’s secure checkout.',
      lines: [
        { label: 'Signature Hand Wash', value: '$50' },
        { label: 'Tax', value: '$4' },
      ],
    })
    sh(c).cta()
    expect(lv(c)).toMatchObject({ sheetStepUp: true, pay: { show: false } })
    expect(lv(c).su.pin).toBe(true)
    expect(sh(c).canBack).toBe(true)
    lv(c).su.setValue({ target: { value: '4826' } })
    lv(c).su.submit()
    await t.settle()
    expect(navigations()).toEqual(['https://oasis-auto-spa.squarespace.com/pay/inv-20611'])
    expect(sh(c).title).toBe('Opening checkout')
  })

  it('a payment URL off the allowlist: no navigation, "We couldn\'t open the payment page"', async () => {
    const t = openWith('p', TOKEN, {
      [`${BASE}/exchange`]: () => ok(exchanged({ kind: 'pay', invoice, pin: 'set' })),
      [`${BASE}/verify/pin`]: () => ok(stepped({ kind: 'pay', invoice, pin: 'set', by: 'pin' })),
      [`${BASE}/pay/start`]: () => ok({ status: 'redirect', redirectUrl: 'http://oasis-auto-spa.squarespace.com/pay' }),
    })
    await t.settle()
    sh(t.c).cta()
    lv(t.c).su.setValue({ target: { value: '4826' } })
    lv(t.c).su.submit()
    await t.settle()
    expect(navigations()).toEqual([])
    expect(sh(t.c).title).toBe('We couldn’t open the payment page')
    expect(lv(t.c).notice.smsHref).toMatch(/^sms:\+18623885827/)
  })

  it('no payment link yet: "We\'ll text you a link"; a paid invoice: "Nothing to pay"', async () => {
    const t = openWith('p', TOKEN, {
      [`${BASE}/exchange`]: () => ok(exchanged({ kind: 'pay', invoice, pin: 'set' })),
      [`${BASE}/verify/pin`]: () => ok(stepped({ kind: 'pay', invoice, pin: 'set', by: 'pin' })),
      [`${BASE}/pay/start`]: () => ok({ status: 'link_pending', redirectUrl: null }),
    })
    await t.settle()
    sh(t.c).cta()
    lv(t.c).su.setValue({ target: { value: '4826' } })
    lv(t.c).su.submit()
    await t.settle()
    expect(sh(t.c).title).toBe('We’ll text you a link')
    resetLinkCapture()
    const t2 = openWith('p', TOKEN2, { [`${BASE}/exchange`]: () => ok(exchanged({ kind: 'pay', invoice: { ...invoice, balanceCents: 0 } })) })
    await t2.settle()
    expect(sh(t2.c).title).toBe('Nothing to pay')
  })

  it('a part-paid invoice says what was paid', async () => {
    const t = openWith('p', TOKEN, { [`${BASE}/exchange`]: () => ok(exchanged({ kind: 'pay', invoice: invoiceAnswer({ items: [{ name: 'Full Detail', priceCents: 18000 }], tipCents: 2000, paidCents: 5000 }) })) })
    await t.settle()
    expect(lv(t.c).pay).toMatchObject({
      lines: [
        { label: 'Full Detail', value: '$180' },
        { label: 'Tip', value: '$20' },
      ],
      due: '$150',
      dueSub: '$50 already paid. You’ll pay the rest on Squarespace’s secure checkout.',
    })
    expect(sh(t.c).ctaLabel).toBe('Verify & pay $150')
  })

  it('an invoice the stale-record rule hides: confirm first, then the review from the step\'s answer', async () => {
    const t = openWith('p', TOKEN, {
      [`${BASE}/exchange`]: () => ok(exchanged({ kind: 'pay', firstName: null, pin: 'set' })),
      [`${BASE}/verify/pin`]: () => ok(stepped({ kind: 'pay', firstName: 'Ravi', invoice, pin: 'set', by: 'pin' })),
      [`${BASE}/pay/start`]: () => ok({ status: 'redirect', redirectUrl: 'https://oasis-auto-spa.squarespace.com/pay/inv-20611' }),
    })
    await t.settle()
    const c = t.c
    expect(sh(c).title).not.toBe('Nothing to pay')
    expect(lv(c)).toMatchObject({ sheetStepUp: true, pay: { show: false } })
    expect(lv(c).su.pin).toBe(true)
    lv(c).su.setValue({ target: { value: '4826' } })
    lv(c).su.submit()
    await t.settle()
    expect(sh(c)).toMatchObject({ eyebrow: 'PAYMENT FOR RAVI ••51', title: 'Review & pay', ctaLabel: 'Pay $54' })
    expect(lv(c).pay).toMatchObject({ show: true, title: 'Invoice #20611' })
    expect(navigations()).toEqual([])
    sh(c).cta()
    await t.settle()
    expect(navigations()).toEqual(['https://oasis-auto-spa.squarespace.com/pay/inv-20611'])
  })
})

describe('helpers', () => {
  it('allowedRedirect: https on squarespace.com or a subdomain only', () => {
    const hosts = ['squarespace.com']
    expect(allowedRedirect('https://squarespace.com/x', hosts)).toBe(true)
    expect(allowedRedirect('https://oasis.squarespace.com/checkout?x=1', hosts)).toBe(true)
    expect(allowedRedirect('http://oasis.squarespace.com/', hosts)).toBe(false)
    expect(allowedRedirect('https://squarespace.com.evil.example/', hosts)).toBe(false)
    expect(allowedRedirect('https://evilsquarespace.com/', hosts)).toBe(false)
    expect(allowedRedirect('https://user:pw@oasis.squarespace.com/', hosts)).toBe(false)
    expect(allowedRedirect('https://oasis.squarespace.com:8443/', hosts)).toBe(false)
    expect(allowedRedirect('javascript:alert(1)', hosts)).toBe(false)
    expect(allowedRedirect(null, hosts)).toBe(false)
  })

  it('validateExchange reads the API\'s LinkState and refuses an unknown kind or no session', () => {
    const x = validateExchange({
      ...exchanged({ kind: 'pay', pin: 'set', fresh: true, invoice: invoiceAnswer({ taxCents: 300 }) }),
      client: { firstName: ' Maria ', last2: '+1 51', tier: 'platinum' },
    })
    expect(x.client).toEqual({ firstName: 'Maria', last2: '51', tier: null })
    expect(x.stepUp).toEqual({ method: 'pin', freshUntil: '2026-10-10T14:05:00.000Z', canSetPinUntil: null })
    expect(x.invoice).toEqual({ number: 20611, date: '2026-10-09', items: [{ name: 'Signature Hand Wash', priceCents: 5400 }], subtotalCents: 5400, taxCents: 300, tipCents: 0, totalCents: 5700, paidCents: 0, balanceCents: 5700 })
    expect(validateExchange(exchanged({ kind: 'membership', plan: planAnswer('gold') })).plan).toEqual({ tier: 'gold', planKey: 'gold', name: 'Gold', monthlyPriceCents: 9900, perks: ['Unlimited washes'] })
    expect(validateExchange(exchanged({ firstName: null })).client.firstName).toBeNull() // '' from the API
    expect(validateExchange(exchanged()).stepUp.method).toBe('code')
    expect(() => validateExchange({ ...linkState(), kind: 'admin', session: 's' })).toThrow()
    expect(() => validateExchange(linkState())).toThrow()
    expect(whoLabel(x.client)).toBe('MARIA ••51')
  })

  it('planTier: the plan\'s tier, else its key through catalog.plans, else nothing (never a default)', () => {
    const plans = { gold: 'gold', vip: 'vip' }
    expect(planTier(planAnswer('gold') as any, plans)).toBe('gold')
    expect(planTier({ ...planAnswer('vip'), tier: null } as any, plans)).toBe('vip')
    expect(planTier(planAnswer(null, 'family-plan', 'Family') as any, plans)).toBeNull()
    expect(planTier(null, plans)).toBeNull()
  })

  it('shopDate: the invoice\'s shop date as "Fri, Oct 9"', () => {
    expect(shopDate('2026-10-09')).toBe('Fri, Oct 9')
    expect(shopDate('2026-10-9')).toBe('')
    expect(shopDate(null)).toBe('')
  })
})
