/* eslint-disable @typescript-eslint/no-explicit-any */
// The fixture's link API answers the backend's own shapes (backend docs/api-spec.md section 28, schemas.ts of W3c; the key
// lists in src/site/link-contract.testkit.ts), so the e2e's link checks exercise the page against the real contract.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  APPOINTMENT_KEYS,
  BOOKING_BODY_KEYS,
  BOOKING_RESULT_KEYS,
  CODE_PURPOSES,
  CODE_REQUESTED_KEYS,
  keyProblems,
  linkStateProblems,
  MEMBERSHIP_RESULT_KEYS,
  PAY_RESULT_KEYS,
  RESCHEDULE_RESULT_KEYS,
} from '../../src/site/link-contract.testkit'
import { createLinkFixture, type IssueLinkInput } from './fixture-links'

const BASE = '/api/v1/public/links'
const today = new Date().toISOString().slice(0, 10)
const fx = createLinkFixture({
  base: BASE,
  now: () => new Date(),
  availability: (_days, serviceKey) => ({
    tz: 'America/New_York',
    serviceKey,
    days: [{ date: today, label: 'Today', closed: false, slots: [{ startMin: 1380, start: '11:00 PM', state: 'open', bays: 3 }] }],
  }),
  services: [{ key: 'express-hand-wash', name: 'Express Hand Wash' }],
  addons: [{ key: 'wax', name: 'Wax' }],
  pushText: () => {},
})
let origin = ''
let server: http.Server
beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const body = () =>
      new Promise<string>((resolve) => {
        let s = ''
        req.on('data', (c) => (s += c))
        req.on('end', () => resolve(s))
      })
    if (!(await fx.handle(req, res, url, body))) res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

async function call(method: 'GET' | 'POST', p: string, body?: unknown, session?: string, headers: Record<string, string> = {}) {
  const res = await fetch(origin + BASE + p, {
    method,
    headers: { 'content-type': 'application/json', ...(session ? { authorization: 'Bearer ' + session } : {}), ...headers },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  })
  return { status: res.status, body: (await res.json()) as any }
}
let phoneSeq = 100
const open = async (i: Omit<IssueLinkInput, 'phone'>) => {
  const phone = `+1201555${String(++phoneSeq).padStart(4, '0')}`
  const { token } = fx.issue({ ...i, phone })
  const r = await call('POST', '/exchange', { token })
  expect(r.status).toBe(200)
  return { phone, session: r.body.session as string, state: r.body }
}
const lastCode = () => { const c = fx.snapshot().codes; return c[c.length - 1]! }
const codeStep = async (session: string, purpose?: string) => {
  const r = await call('POST', '/verify/code', purpose ? { purpose } : {}, session)
  expect(r.status).toBe(202)
  expect(keyProblems('code', r.body, CODE_REQUESTED_KEYS)).toEqual([])
  return call('POST', '/verify/code/confirm', { challengeId: r.body.challengeId, code: lastCode().code }, session)
}

describe('the fixture answers the API\'s shapes', () => {
  it('closed: 404 ROUTE_NOT_FOUND on every route', async () => {
    fx.state.enabled = false
    const r = await call('POST', '/exchange', { token: 'x' })
    fx.state.enabled = true
    expect(r.status).toBe(404)
    expect(r.body.code).toBe('ROUTE_NOT_FOUND')
  })

  it('exchange, me, the code purposes, the PIN, a booking, a reschedule and the appointments', async () => {
    const { session, state } = await open({ kind: 'calendar' })
    expect(linkStateProblems(state, ['session'])).toEqual([])
    expect(state.stepUp).toMatchObject({ method: 'code', freshUntil: null, canSetPinUntil: null })
    expect(state.appointments).toBeNull()
    const me = await call('GET', '/me', undefined, session)
    expect(linkStateProblems(me.body)).toEqual([])
    // the purposes are the API's enum: anything else is a 422
    expect(CODE_PURPOSES).toEqual(['verify', 'pin_set', 'pin_reset'])
    expect((await call('POST', '/verify/code', { purpose: 'link_verify' }, session)).status).toBe(422)
    const c = await codeStep(session) // default purpose: verify
    expect(c.status).toBe(200)
    expect(linkStateProblems(c.body, ['verified'])).toEqual([])
    expect(c.body.verified).toBe(true)
    expect(c.body.trust).toMatchObject({ verified: true, by: 'code' })
    expect(c.body.stepUp.freshUntil).toBeTruthy()
    expect(c.body.stepUp.canSetPinUntil).toBeTruthy()
    const pin = await call('POST', '/pin', { pin: '4826' }, session)
    expect(pin.status).toBe(200)
    expect(linkStateProblems(pin.body, ['verified'])).toEqual([])
    expect(pin.body.stepUp.method).toBe('pin')
    // a strict booking body: the API's keys and nothing else
    const full = { serviceKey: 'express-hand-wash', addonKeys: ['wax'], date: today, startMin: 1380, vehicle: { label: 'Sedan' }, name: 'X', email: 'x@example.com', smsConsent: true }
    expect(Object.keys(full).sort()).toEqual([...BOOKING_BODY_KEYS].sort())
    expect((await call('POST', '/bookings', { ...full, phone: '+12015550000' }, session, { 'idempotency-key': 'k0' })).status).toBe(422)
    const b = await call('POST', '/bookings', full, session, { 'idempotency-key': 'k1' })
    expect(b.status).toBe(201)
    expect(keyProblems('booking', b.body, BOOKING_RESULT_KEYS)).toEqual([])
    const rs = await call('POST', `/appointments/${b.body.bookingRef}/reschedule`, { date: today, startMin: 1380 }, session)
    expect(keyProblems('reschedule', rs.body, RESCHEDULE_RESULT_KEYS)).toEqual([])
    const me2 = await call('GET', '/me', undefined, session)
    expect(linkStateProblems(me2.body)).toEqual([])
    expect(me2.body.appointments).toHaveLength(1)
    expect(keyProblems('appointment', me2.body.appointments[0], APPOINTMENT_KEYS)).toEqual([])
  })

  it('a client with a PIN: method pin, verify by PIN, reset by code then /pin/reset', async () => {
    const { session, state } = await open({ kind: 'pin', pin: '7391' })
    expect(state.stepUp.method).toBe('pin')
    expect((await call('POST', '/verify/code', { purpose: 'verify' }, session)).body.code).toBe('IDENTITY_PIN_REQUIRED')
    const r = await codeStep(session, 'pin_reset')
    expect(linkStateProblems(r.body, ['verified'])).toEqual([])
    expect(r.body.verified).toBe(false)
    expect(r.body.stepUp.canSetPinUntil).toBeTruthy()
    const reset = await call('POST', '/pin/reset', { pin: '5813' }, session)
    expect(linkStateProblems(reset.body, ['verified'])).toEqual([])
    const v = await open({ kind: 'verify', pin: '7391' })
    const p = await call('POST', '/verify/pin', { pin: '7391' }, v.session)
    expect(linkStateProblems(p.body, ['verified'])).toEqual([])
    expect(p.body.trust.by).toBe('pin')
  })

  it('a stranger\'s link: firstName \'\', no PIN window, no PIN purposes', async () => {
    const { session, state } = await open({ kind: 'verify', firstName: null })
    expect(state.client.firstName).toBe('')
    expect((await call('POST', '/verify/code', { purpose: 'pin_set' }, session)).body.code).toBe('IDENTITY_UNKNOWN_CLIENT')
    const c = await codeStep(session)
    expect(c.body.stepUp.canSetPinUntil).toBeNull()
  })

  it('membership: the plan, then the start answer', async () => {
    const { session, state } = await open({ kind: 'membership', pin: '7391', plan: { tier: 'gold', planKey: 'gold', name: 'Gold', monthlyPriceCents: 9900, checkoutUrl: 'https://x.squarespace.com/c' } })
    expect(linkStateProblems(state, ['session'])).toEqual([])
    expect(state.plan).toEqual({ tier: 'gold', planKey: 'gold', name: 'Gold', monthlyPriceCents: 9900, perks: [] })
    expect((await call('POST', '/membership/start', { email: 'a@example.com' }, session)).body).toMatchObject({ code: 'IDENTITY_STEP_UP_REQUIRED', meta: { need: 'fresh' } })
    await call('POST', '/verify/pin', { pin: '7391' }, session)
    expect((await call('POST', '/membership/start', { email: 'a@example.com', plan: 'vip' }, session)).status).toBe(422)
    const m = await call('POST', '/membership/start', { email: 'a@example.com' }, session)
    expect(m.status).toBe(200)
    expect(keyProblems('membership', m.body, MEMBERSHIP_RESULT_KEYS)).toEqual([])
  })

  it('payment: the invoice (hidden by the stale-record rule until verified), then both start answers', async () => {
    const invoice = { number: 20611, date: '2026-10-09', items: [{ name: 'Signature Hand Wash', priceCents: 5000 }], taxCents: 400, url: 'https://x.squarespace.com/pay' }
    const stale = await open({ kind: 'pay', stale: true, pin: '7391', invoice })
    expect(stale.state.client.firstName).toBe('')
    expect(stale.state.invoice).toBeNull()
    const p = await call('POST', '/verify/pin', { pin: '7391' }, stale.session)
    expect(p.body.client.firstName).toBe('Maria')
    expect(p.body.invoice).toMatchObject({ number: 20611, subtotalCents: 5000, taxCents: 400, totalCents: 5400, paidCents: 0, balanceCents: 5400 })
    expect(linkStateProblems(p.body, ['verified'])).toEqual([])
    const go = await call('POST', '/pay/start', {}, stale.session)
    expect(go.body).toEqual({ status: 'redirect', redirectUrl: 'https://x.squarespace.com/pay' })
    expect(keyProblems('pay', go.body, PAY_RESULT_KEYS)).toEqual([])
    const pending = await open({ kind: 'pay', pin: '7391', invoice: { ...invoice, url: null } })
    await call('POST', '/verify/pin', { pin: '7391' }, pending.session)
    expect((await call('POST', '/pay/start', {}, pending.session)).body).toEqual({ status: 'link_pending', redirectUrl: null })
  })

  it('a page asking for another kind of link\'s action: 401 LINK_WRONG_PURPOSE', async () => {
    const { session } = await open({ kind: 'verify', trusted: true })
    expect((await call('POST', '/pay/start', {}, session)).body.code).toBe('LINK_WRONG_PURPOSE')
  })
})
