// A stand-in for the backend's public API (docs/api-spec.md of the backend, section 26) for developing and testing
// the site without the live stack: hours (the committed fallback with today/next derived), availability (the
// design's pattern over the hours, with bookings taken out), catalog (DV-CATALOG: the design's content in the shape the
// backend answers after the website-catalog seed, tools/site/catalog-fixture.ts; `state.catalog` can be swapped), OTP (the code is
// returned in a dev header and listed at GET /__fixture/texts), bookings (409 when a slot is taken, honeypot 202),
// memberships (pending), and the personal-link API (tools/site/fixture-links.ts: issue links through POST
// /__fixture/links, switch the PUBLIC_LINKS_ENABLED gate through POST /__fixture/links/enabled?on=0|1, read
// /__fixture/links/state). In-memory; one process per run. Used by scripts/e2e-site.ts --api fixture and by
// `pnpm serve:dist --api fixture`. Never part of the build.
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { validatePublicHours } from '../../src/hours/format'
import type { PublicHours } from '../../src/hours/format'
import { designAvailability, type Availability } from '../../src/site/availability'
import { hoursTable, withToday } from '../../src/site/hours'
import { designCatalog, type CatalogPayload } from './catalog-fixture'
import { createLinkFixture, type LinkFixture } from './fixture-links'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export interface FixtureApiOptions {
  port?: number
  now?: () => Date
  tz?: string
  hours?: PublicHours
}

export interface FixtureApi {
  origin: string
  port: number
  state: FixtureState
  /** the link API (personal links, DV-LINK): issue links, switch the gate, read its state and request log */
  links: LinkFixture
  close(): Promise<void>
}

export interface FixtureState {
  texts: { to: string; body: string; klass: string; at: string }[]
  challenges: Map<string, { phone: string; code: string; tries: number; expiresAt: number; used: boolean }>
  tokens: Map<string, { phone: string; member: { firstName: string; tier: 'gold' | 'vip' | null; washesLeft: number | null; active: boolean } }>
  bookings: { bookingRef: string; phone: string; name: string; date: string; startMin: number; serviceKey: string; addonKeys: string[]; member: boolean }[]
  memberships: { memberRef: string; phone: string; tier: string; name: string }[]
  idem: Map<string, { status: number; body: unknown; sig: string }>
  /** phones that are members (the seeded ones) */
  members: Map<string, { firstName: string; tier: 'gold' | 'vip'; washesLeft: number }>
  /** DV-CATALOG: what GET /api/v1/public/catalog answers (the design's content; a test may swap it) */
  catalog: CatalogPayload | Record<string, unknown>
}

const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
  res
    .writeHead(status, { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
    .end(JSON.stringify(body))
const problem = (res: http.ServerResponse, status: number, code: string, title: string, extra: Record<string, unknown> = {}) =>
  json(res, status, { type: 'about:blank', status, code, title, ...extra })

const e164 = (s: string): string | null => {
  const d = String(s).replace(/\D/g, '')
  if (d.length === 10) return '+1' + d
  if (d.length === 11 && d.startsWith('1')) return '+' + d
  return null
}

export async function startFixtureApi(o: FixtureApiOptions = {}): Promise<FixtureApi> {
  const now = o.now ?? (() => new Date())
  const base = o.hours ?? validatePublicHours(JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/hours.fallback.json'), 'utf8')))
  const state: FixtureState = {
    texts: [],
    challenges: new Map(),
    tokens: new Map(),
    bookings: [],
    memberships: [],
    idem: new Map(),
    members: new Map([['+12015550199', { firstName: 'Dana', tier: 'vip', washesLeft: 3 }]]),
    catalog: designCatalog(),
  }
  let seq = 100
  // the bookable packages (availability and bookings know these keys whatever the catalog answer is swapped to)
  const services = designCatalog().services
  // the add-ons the link fixture names in its bookings (same keys as the catalog answer, W3e + W3f)
  const addons = designCatalog().addons
  // The design's pattern and `today` are computed from LOCAL hours: always in the shop's zone, whatever the process
  // zone is (the prerender shims set TZ to the shop's zone when it is unset, so an in-process fixture must not drift).
  const inShopZone = <T,>(fn: () => T): T => {
    const prev = process.env.TZ
    process.env.TZ = base.tz || 'America/New_York'
    try {
      return fn()
    } finally {
      if (prev === undefined) delete process.env.TZ
      else process.env.TZ = prev
    }
  }
  const availability = (days: number, serviceKey: string): Availability => {
    const t = now()
    const a = inShopZone(() => designAvailability(t, hoursTable(base), { days, serviceKey, tz: base.tz }))
    // bookings taken out: a booked slot loses one bay
    for (const day of a.days)
      for (const s of day.slots) {
        const taken =
          state.bookings.filter((b) => b.date === day.date && b.startMin === s.startMin).length +
          links.state.bookings.filter((b) => b.date === day.date && b.startMin === s.startMin).length // links (W3f)
        if (!taken) continue
        s.bays = Math.max(0, s.bays - taken)
        s.state = s.bays === 0 ? 'booked' : s.bays === 1 ? 'last' : s.state
      }
    for (const day of a.days) day.openCount = day.slots.filter((s) => s.state === 'open' || s.state === 'last').length
    const h = inShopZone(() => withToday(base, t))!
    const open = !!h.today && !h.today.closed && h.today.state === 'open'
    return { ...a, now: { open, baysFree: open ? 2 : 0, baysTotal: 3 } }
  }
  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let s = ''
      req.on('data', (c) => (s += c))
      req.on('end', () => resolve(s))
    })
  // ---- links (W3f): the personal-link API in memory (tools/site/fixture-links.ts) ----
  const site2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'site.config.json'), 'utf8')) as { links?: { base?: string } }
  const links = createLinkFixture({
    base: site2.links?.base ?? '/api/v1/public/links',
    now,
    availability: (days, serviceKey) => availability(days, serviceKey) as never,
    services,
    addons,
    pushText: (t) => state.texts.push({ ...t, at: now().toISOString() }),
  })

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const p = url.pathname
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,idempotency-key,authorization', 'access-control-allow-methods': 'GET,POST' }).end()
      return
    }
    if (p === '/__fixture/texts') return json(res, 200, { texts: state.texts })
    // ---- links (W3f) ----
    if (p === '/__fixture/links' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)) || '{}')
      return json(res, 201, links.issue(b, String(b.siteOrigin ?? 'https://oasisautospanj.com')))
    }
    if (p === '/__fixture/links/state') return json(res, 200, links.snapshot())
    if (p === '/__fixture/links/enabled' && req.method === 'POST') {
      links.state.enabled = url.searchParams.get('on') !== '0'
      return json(res, 200, { enabled: links.state.enabled })
    }
    if (await links.handle(req, res, url, () => readBody(req))) return
    if (p === '/__fixture/state')
      return json(res, 200, { bookings: state.bookings, memberships: state.memberships, challenges: [...state.challenges.entries()].map(([id, c]) => ({ id, phone: c.phone, code: c.code })) })
    if (p === '/api/v1/public/hours') return json(res, 200, inShopZone(() => withToday(base, now())), { 'cache-control': 'public, max-age=60' })
    if (p === '/api/v1/public/availability') {
      const days = Math.max(1, Math.min(14, Number(url.searchParams.get('days') ?? '5') || 5))
      const service = url.searchParams.get('service') || services[0]!.key
      if (!services.some((s) => s.key === service)) return problem(res, 422, 'PUBLIC_VALIDATION', `Unknown service ${service}.`)
      return json(res, 200, availability(days, service), { 'cache-control': 'public, max-age=60' })
    }
    if (p === '/api/v1/public/catalog') return json(res, 200, { ...state.catalog, generatedAt: now().toISOString() })
    if (req.method !== 'POST') return problem(res, 404, 'NOT_FOUND', 'Not found')
    let body: Record<string, unknown>
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>
    } catch {
      return problem(res, 400, 'BAD_JSON', 'Malformed JSON')
    }
    if (p === '/api/v1/public/otp') {
      const phone = e164(String(body.phone ?? ''))
      if (!phone) return problem(res, 422, 'PUBLIC_VALIDATION', 'Enter a valid mobile number.')
      const id = crypto.randomUUID()
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
      for (const [k, c] of state.challenges) if (c.phone === phone) state.challenges.delete(k)
      state.challenges.set(id, { phone, code, tries: 0, expiresAt: Date.now() + 600_000, used: false })
      state.texts.push({ to: phone, body: `Your Oasis Auto Spa code is ${code}. It expires in 10 minutes.`, klass: 'otp_code', at: now().toISOString() })
      return json(res, 202, { challengeId: id, expiresInSec: 600 }, { 'x-fixture-code': code })
    }
    if (p === '/api/v1/public/otp/verify') {
      const c = state.challenges.get(String(body.challengeId ?? ''))
      if (!c || c.used || c.expiresAt < Date.now()) return problem(res, 410, 'PUBLIC_OTP_EXPIRED', 'That code expired. Request a new one.')
      if (c.tries >= 3) return problem(res, 429, 'PUBLIC_OTP_LOCKED', 'Too many tries. Request a new code.')
      if (String(body.code ?? '') !== c.code) {
        c.tries++
        if (c.tries >= 3) return problem(res, 429, 'PUBLIC_OTP_LOCKED', 'Too many tries. Request a new code.')
        return problem(res, 401, 'PUBLIC_OTP_INVALID', `That code didn’t match. ${3 - c.tries} more tries before you need a new one.`, { meta: { attemptsLeft: 3 - c.tries } })
      }
      c.used = true
      const m = state.members.get(c.phone)
      const member = m ? { firstName: m.firstName, tier: m.tier, washesLeft: m.washesLeft, active: true } : { firstName: '', tier: null, washesLeft: null, active: false }
      const token = crypto.randomBytes(32).toString('base64url')
      state.tokens.set(token, { phone: c.phone, member })
      return json(res, 200, { memberToken: token, expiresInSec: 1800, member: { ...member, plan: m ? (m.tier === 'vip' ? 'VIP' : 'Gold') : null } })
    }
    const key = req.headers['idempotency-key']
    if (p === '/api/v1/public/bookings' || p === '/api/v1/public/memberships') {
      if (typeof key !== 'string' || !key) return problem(res, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required.')
      // keys are the caller's (the API scopes them per caller, not per route): a key used for another request is refused
      const hit = state.idem.get(String(key))
      if (hit && hit.sig !== `${p}|${JSON.stringify(body)}`)
        return problem(res, 422, 'IDEMPOTENCY_MISMATCH', 'Idempotency key reused')
      if (hit) return json(res, hit.status, hit.body, { 'idempotent-replayed': 'true' })
    }
    const remember = (status: number, out: unknown) => {
      state.idem.set(String(key), { status, body: out, sig: `${p}|${JSON.stringify(body)}` })
      return json(res, status, out)
    }
    if (p === '/api/v1/public/bookings') {
      if (typeof body.website === 'string' && body.website) return json(res, 202, { bookingRef: `OAS-${String(crypto.randomInt(1, 99999)).padStart(5, '0')}`, status: 'booked' })
      const phone = e164(String(body.phone ?? ''))
      const name = String(body.name ?? '').trim()
      const date = String(body.date ?? '')
      const startMin = Number(body.startMin)
      const serviceKey = String(body.serviceKey ?? '')
      const svc = services.find((s) => s.key === serviceKey)
      if (!phone || !name || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(startMin) || !svc)
        return problem(res, 422, 'PUBLIC_VALIDATION', 'Check the booking details.')
      let member = false
      if (typeof body.memberToken === 'string') {
        const t = state.tokens.get(body.memberToken)
        if (!t) return problem(res, 401, 'PUBLIC_TOKEN_INVALID', 'Sign in again.')
        if (t.phone !== phone) return problem(res, 422, 'PUBLIC_TOKEN_PHONE_MISMATCH', 'That code was for another number.')
        member = t.member.active
      }
      const a = availability(14, serviceKey)
      const day = a.days.find((d) => d.date === date)
      const slot = day?.slots.find((s) => s.startMin === startMin)
      if (!day || day.closed) return remember(409, { type: 'about:blank', status: 409, code: 'PUBLIC_SLOT_CLOSED', title: 'We’re closed at that time. Pick another.' })
      if (!slot) return remember(409, { type: 'about:blank', status: 409, code: 'PUBLIC_SLOT_PAST', title: 'That time has passed. Pick another.' })
      if (slot.state === 'vip' && !member) return remember(409, { type: 'about:blank', status: 409, code: 'PUBLIC_SLOT_VIP', title: `${slot.start} is held for VIP members. Join to book it with no fee.` })
      if (slot.state === 'booked') return remember(409, { type: 'about:blank', status: 409, code: 'PUBLIC_SLOT_TAKEN', title: 'That time was just taken. Pick another.' })
      const bookingRef = `OAS-${String(++seq).padStart(5, '0')}`
      state.bookings.push({ bookingRef, phone, name, date, startMin, serviceKey, addonKeys: Array.isArray(body.addonKeys) ? (body.addonKeys as string[]) : [], member })
      const when = `${day.label} · ${slot.start}`
      state.texts.push({ to: phone, body: `Booked: ${svc.name}, ${when.toLowerCase()}. ${member ? 'Members never pay a booking fee.' : '$25 booking fee due at the shop.'} Reply here to change it.`, klass: 'transactional', at: now().toISOString() })
      return remember(201, {
        bookingRef,
        status: 'booked',
        start: `${date}T${String(Math.floor(startMin / 60)).padStart(2, '0')}:${String(startMin % 60).padStart(2, '0')}:00`,
        end: null,
        bayCount: Math.max(0, slot.bays - 1),
        deposit: member ? { dueCents: 0, how: 'counter' } : { dueCents: 2500, how: 'counter' },
        confirmationBy: 'sms',
        service: { key: svc.key, name: svc.name },
        addons: [],
        when,
        member,
      })
    }
    if (p === '/api/v1/public/memberships') {
      if (typeof body.website === 'string' && body.website) return json(res, 202, { memberRef: 'OAS-M-FAKE0000', status: 'pending_payment' })
      const phone = e164(String(body.phone ?? ''))
      const tier = String(body.tier ?? '')
      if (!phone || !['gold', 'vip'].includes(tier) || !String(body.name ?? '').trim() || body.agree !== true)
        return problem(res, 422, 'PUBLIC_VALIDATION', 'Check the details.')
      // the API's MembershipBody requires the receipts e-mail (z.string().email())
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.email ?? '').trim()))
        return problem(res, 422, 'VALIDATION_FAILED', 'Check the form', { detail: 'Invalid email address', errors: [{ path: 'body.email', message: 'Invalid email address' }] })
      if (state.members.has(phone)) return remember(409, { type: 'about:blank', status: 409, code: 'PUBLIC_ALREADY_MEMBER', title: 'This number already has a membership. Text us to change your plan.' })
      const memberRef = `OAS-M-${crypto.randomBytes(4).toString('hex').toUpperCase()}`
      state.memberships.push({ memberRef, phone, tier, name: String(body.name) })
      state.texts.push({ to: phone, body: `Hi ${String(body.name).split(' ')[0]}, thanks for joining Oasis Auto Spa ${tier === 'vip' ? 'VIP' : 'Gold'}. We’ll text your secure checkout link shortly; your membership starts once it’s paid.`, klass: 'transactional', at: now().toISOString() })
      return remember(201, { memberRef, status: 'pending_payment', next: 'checkout_link_by_sms', tier, plan: tier === 'vip' ? 'VIP' : 'Gold', confirmationBy: 'sms' })
    }
    return problem(res, 404, 'NOT_FOUND', 'Not found')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(o.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const port = (server.address() as AddressInfo).port
  return { origin: `http://127.0.0.1:${port}`, port, state, links, close: () => new Promise((r) => server.close(() => r())) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[process.argv.indexOf('--port') + 1] || 3303)
  startFixtureApi({ port }).then((api) => {
    console.log(`fixture public API at ${api.origin} (texts: ${api.origin}/__fixture/texts); Ctrl-C to stop`)
    const stop = () => api.close().then(() => process.exit(0))
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
}
