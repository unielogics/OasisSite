// The link API in memory, for the fixture API (tools/site/fixture-api.ts) and the e2e: the backend's personal-link API
// (backend docs/api-spec.md section 28, ADR 0160 W3c; design docs/design/ai-assistant-and-phone-identity.md section 5;
// the routes this site calls: docs/site.md "Personal links"), answering the API's own shapes (LinkState, the code,
// booking, membership and payment answers; src/site/link-contract.testkit.ts lists them and
// tools/site/fixture-links.test.ts holds this file to them). It follows the identity core's rules (backend
// docs/api-spec.md section 27 and src/modules/identity/problems.ts): tokens are 43
// base64url characters and only their sha256 is kept, the gate answers 404 before anything else while links are off,
// sessions are bearer tokens (15 min idle, 1 h at most), opening a link uses nothing and completing it does, a PIN
// outranks a texted code, five wrong tries end a page, five wrong PINs lock the PIN for 15 minutes, memberships and
// payments need a PIN or code entered within 5 minutes, and a code goes to the link's number only (a phone field in the
// body is ignored). Every request to /links is logged as received (method, path, headers, body) so the e2e can prove
// where the token travels. Never part of the build.
import crypto from 'node:crypto'
import type http from 'node:http'

export type FixtureLinkKind = 'calendar' | 'verify' | 'pin' | 'membership' | 'pay' | 'book_again'

export interface IssueLinkInput {
  kind: FixtureLinkKind
  phone: string
  /** null for a stranger's link (no client record) */
  firstName?: string | null
  /** the stale-record rule hides the client (name, tier, invoice) until the page is verified */
  stale?: boolean
  tier?: 'gold' | 'vip' | null
  /** the number's 30-day trust is live */
  trusted?: boolean
  /** the client has this PIN */
  pin?: string | null
  expired?: boolean
  used?: boolean
  revoked?: boolean
  /** the invoice of a payment link (the API's InvoiceView is computed from it) and the payment URL staff attached */
  invoice?: { number: number; date: string; items: { name: string; priceCents: number }[]; taxCents?: number; tipCents?: number; paidCents?: number; url: string | null } | null
  /** the plan of a membership link (the API's PlanView) and its Squarespace checkout */
  plan?: { tier: 'gold' | 'vip' | null; planKey: string; name: string; monthlyPriceCents: number | null; perks?: string[]; checkoutUrl: string | null } | null
}

interface FLink {
  id: string
  hash: string
  kind: FixtureLinkKind
  phone: string
  firstName: string | null
  stale: boolean
  tier: 'gold' | 'vip' | null
  expiresAt: number
  uses: number
  maxUses: number
  exchanges: number
  maxExchanges: number
  revoked: boolean
  invoice: IssueLinkInput['invoice']
  plan: IssueLinkInput['plan']
}

interface FSession {
  linkId: string
  verified: boolean
  verifiedBy: 'pin' | 'code' | null
  stepUpAt: number | null
  codeAt: number | null
  resetCodeAt: number | null
  failures: number
  /** when this page asked for codes (3 per 10 minutes) */
  codeTimes: number[]
  idleUntil: number
  until: number
}

interface FCode {
  sessionHash: string
  purpose: CodePurpose
  code: string
  tries: number
  expiresAt: number
  used: boolean
}

/** The code request's purposes (the API's CodeBody enum). */
export type CodePurpose = 'verify' | 'pin_set' | 'pin_reset'
const PURPOSES: CodePurpose[] = ['verify', 'pin_set', 'pin_reset']

export interface LinkLogEntry {
  method: string
  path: string
  headers: Record<string, string>
  body: string
}

export interface LinkFixtureState {
  enabled: boolean
  links: Map<string, FLink>
  sessions: Map<string, FSession>
  trust: Map<string, number>
  pins: Map<string, { pin: string; fails: number; lockedUntil: number; disabled: boolean }>
  /** a PIN reset holds member privileges for 72 hours (phone -> until) */
  held: Map<string, number>
  codes: Map<string, FCode>
  bookings: { bookingRef: string; phone: string; name: string; date: string; startMin: number; serviceKey: string; serviceName: string; addonKeys: string[]; start: string; end: string; when: string; linkId: string; source: 'link' }[]
  memberships: { membershipRef: string; phone: string; planKey: string; state: 'pending' }[]
  checkouts: { membershipRef: string; phone: string; planKey: string; expectedEmail: string; checkoutUrl: string; linkId: string; state: 'open' }[]
  payStarts: { linkId: string; invoice: number; redirectUrl: string | null }[]
  log: LinkLogEntry[]
  texts: { to: string; body: string; klass: string }[]
}

export interface LinkFixtureDeps {
  base: string
  now: () => Date
  /** the board for a service (the fixture API's availability with its bookings taken out) */
  availability: (days: number, serviceKey: string) => { days: { date: string; label: string; closed: boolean; slots: { startMin: number; start: string; state: string; bays: number }[] }[] } & Record<string, unknown>
  services: { key: string; name: string }[]
  addons: { key: string; name: string }[]
  /** the fixture API's own texts list (codes are "texted" there too) */
  pushText: (t: { to: string; body: string; klass: string }) => void
}

const MIN = 60_000
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
const token = () => crypto.randomBytes(32).toString('base64url')
const POLICY: Record<FixtureLinkKind, { ttl: number; uses: number; exchanges: number; path: string }> = {
  verify: { ttl: 15 * MIN, uses: 1, exchanges: 5, path: 'v' },
  pin: { ttl: 15 * MIN, uses: 1, exchanges: 5, path: 'pin' },
  calendar: { ttl: 72 * 60 * MIN, uses: 3, exchanges: 30, path: 'c' },
  book_again: { ttl: 14 * 24 * 60 * MIN, uses: 1, exchanges: 30, path: 'c' },
  membership: { ttl: 24 * 60 * MIN, uses: 3, exchanges: 20, path: 'm' },
  pay: { ttl: 7 * 24 * 60 * MIN, uses: 3, exchanges: 30, path: 'p' },
}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * The identity core's PIN blocklist and its words (backend src/modules/identity/pin.ts pinProblem, copied: the page shows the
 * API's `detail` as it comes, and the live e2e holds the two to the same text): 4 to 6 digits; not one digit over and over,
 * not a run (wrapping 9 to 0, either way), not a common PIN (the backend's list), not a year from 1940 to 2015, not the end
 * of the client's own number.
 */
const COMMON_PINS = new Set(
  (
    '1234 1111 0000 1212 7777 1004 2000 4444 2222 6969 9999 3333 5555 6666 1122 1313 8888 4321 2001 1010 ' +
    '2580 0852 1123 1231 1984 1986 2468 1357 0123 1239 1000 1020 2121 4545 5150 1515 1414 2020 2525 3636 ' +
    '0007 0101 0911 1001 1101 1200 1221 1225 1269 1324 1342 1369 1478 1590 1597 1701 1776 1818 1919 1999 ' +
    '2002 2011 2112 2211 2323 2345 2424 2512 2727 3000 3131 3232 3434 3456 3535 3690 4040 4200 4242 4567 ' +
    '5252 5678 6262 6789 7007 7070 7272 7410 7531 7676 7890 8008 8520 8642 9090 9191 9696 9876 0258 0369 ' +
    '1029 1210 0420 0069 1066 1945 0001 0007 2580 1470'
  ).split(' '),
)
const isRun = (pin: string): boolean => {
  const d = [...pin].map(Number)
  const step = (d[1]! - d[0]! + 10) % 10
  if (step !== 1 && step !== 9) return false
  return d.every((x, i) => i === 0 || (x - d[i - 1]! + 10) % 10 === step)
}
export function pinRejected(pin: string, phone: string): string | null {
  if (!/^\d{4,6}$/.test(pin)) return 'Use 4 to 6 digits.'
  if (/^(\d)\1+$/.test(pin)) return 'Don’t use one digit over and over.'
  if (isRun(pin)) return 'Don’t use digits in a row like 1234.'
  if (COMMON_PINS.has(pin)) return 'That PIN is too common. Choose another.'
  if (pin.length === 4 && Number(pin) >= 1940 && Number(pin) <= 2015) return 'Don’t use a year. Choose another PIN.'
  const digits = phone.replace(/\D/g, '')
  if (digits.length >= pin.length && digits.endsWith(pin)) return 'Don’t use the end of your phone number.'
  return null
}

/** The API's InvoiceView of a seeded invoice: the subtotal of its items, plus tax and tip, less what was paid. */
export function invoiceView(i: NonNullable<IssueLinkInput['invoice']>) {
  const subtotalCents = i.items.reduce((n, x) => n + x.priceCents, 0)
  const taxCents = i.taxCents ?? 0
  const tipCents = i.tipCents ?? 0
  const totalCents = subtotalCents + taxCents + tipCents
  const paidCents = i.paidCents ?? 0
  return { number: i.number, date: i.date, items: i.items.map((x) => ({ name: x.name, priceCents: x.priceCents })), subtotalCents, taxCents, tipCents, totalCents, paidCents, balanceCents: totalCents - paidCents }
}

export function createLinkFixture(d: LinkFixtureDeps) {
  const st: LinkFixtureState = {
    enabled: true,
    links: new Map(),
    sessions: new Map(),
    trust: new Map(),
    pins: new Map(),
    held: new Map(),
    codes: new Map(),
    bookings: [],
    memberships: [],
    checkouts: [],
    payStarts: [],
    log: [],
    texts: [],
  }
  let seq = 500
  const now = () => d.now().getTime()

  /** Issues a link like issueClientLink: returns the token (once) and the URL a text would carry. */
  function issue(i: IssueLinkInput, siteOrigin = 'https://oasisautospanj.com'): { token: string; url: string; id: string } {
    const t = token()
    const p = POLICY[i.kind]
    const id = crypto.randomUUID()
    const l: FLink = {
      id,
      hash: sha(t),
      kind: i.kind,
      phone: i.phone,
      firstName: i.firstName === undefined ? 'Maria' : i.firstName,
      stale: !!i.stale,
      tier: i.tier ?? null,
      expiresAt: now() + (i.expired ? -MIN : p.ttl),
      uses: i.used ? p.uses : 0,
      maxUses: p.uses,
      exchanges: 0,
      maxExchanges: p.exchanges,
      revoked: !!i.revoked,
      invoice: i.invoice ?? null,
      plan: i.plan ?? null,
    }
    st.links.set(l.hash, l)
    if (i.trusted) st.trust.set(i.phone, now() + 30 * 24 * 60 * MIN)
    if (i.pin) st.pins.set(i.phone, { pin: i.pin, fails: 0, lockedUntil: 0, disabled: false })
    return { token: t, url: `${siteOrigin.replace(/\/$/, '')}/#/${p.path}/${t}`, id }
  }

  const linkById = (id: string) => [...st.links.values()].find((l) => l.id === id) ?? null
  const deadReason = (l: FLink | undefined): string | null => {
    if (!l) return 'not_found'
    if (l.revoked) return 'revoked'
    if (l.expiresAt <= now()) return 'expired'
    if (l.uses >= l.maxUses) return 'used'
    if (l.kind === 'pay' && l.invoice && invoiceView(l.invoice).balanceCents <= 0) return 'used'
    return null
  }
  const trusted = (phone: string) => (st.trust.get(phone) ?? 0) > now()
  const iso = (t: number) => new Date(t).toISOString()
  const heldUntil = (phone: string) => ((st.held.get(phone) ?? 0) > now() ? st.held.get(phone)! : null)
  /** The API's LinkState (backend docs/api-spec.md 28.2) of a page. */
  const view = (s: FSession, l: FLink) => {
    const t = now()
    const client = l.firstName !== null
    // a record the stale-record rule hides is nobody until the page is verified
    const known = client && (!l.stale || s.verified)
    const pinSet = st.pins.has(l.phone)
    const fresh = s.stepUpAt != null && t - s.stepUpAt <= 5 * MIN ? iso(s.stepUpAt + 5 * MIN) : null
    const after = pinSet ? s.resetCodeAt : s.codeAt
    return {
      kind: l.kind,
      expiresAt: iso(s.until),
      idleExpiresAt: iso(s.idleUntil),
      link: { expiresAt: iso(l.expiresAt) },
      client: { firstName: known ? l.firstName! : '', last2: l.phone.slice(-2), tier: known && !heldUntil(l.phone) ? l.tier : null },
      trust: { verified: s.verified, by: s.verified ? s.verifiedBy : null, until: trusted(l.phone) ? iso(st.trust.get(l.phone)!) : null },
      stepUp: {
        method: pinSet ? ('pin' as const) : ('code' as const),
        freshUntil: fresh,
        canSetPinUntil: client && after != null && t - after <= 10 * MIN ? iso(after + 10 * MIN) : null,
      },
      appointments:
        s.verified && known
          ? st.bookings
              .filter((b) => b.phone === l.phone)
              .map((b) => ({ ref: b.bookingRef, start: b.start, end: b.end, when: b.when, service: b.serviceName, addons: [], status: 'booked', canReschedule: true }))
          : null,
      invoice: l.kind === 'pay' && l.invoice && known ? invoiceView(l.invoice) : null,
      plan: l.kind === 'membership' && l.plan ? { tier: l.plan.tier, planKey: l.plan.planKey, name: l.plan.name, monthlyPriceCents: l.plan.monthlyPriceCents, perks: l.plan.perks ?? [] } : null,
    }
  }

  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
    res
      .writeHead(status, { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
      .end(JSON.stringify(body))
  const problem = (res: http.ServerResponse, status: number, code: string, title: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    send(res, status, { type: 'about:blank', status, code, title, ...extra }, headers)
  const grantTrust = (phone: string) => st.trust.set(phone, now() + 30 * 24 * 60 * MIN)

  /** The page's session from `Authorization: Bearer`, or the 401 the identity core answers. */
  function session(req: http.IncomingMessage): { token: string; s: FSession; l: FLink } | null {
    const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization ?? ''))
    if (!m) return null
    const s = st.sessions.get(sha(m[1]!))
    if (!s) return null
    const l = linkById(s.linkId)
    const t = now()
    if (!l || s.idleUntil <= t || s.until <= t || s.failures >= 5 || l.revoked) return null
    s.idleUntil = Math.min(t + 15 * MIN, s.until)
    return { token: m[1]!, s, l }
  }

  /** Answers a /links request (path relative to the base); false when the path is not a link route. */
  async function handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL, rawBody: () => Promise<string>): Promise<boolean> {
    if (!url.pathname.startsWith(d.base + '/') && url.pathname !== d.base) return false
    const raw = req.method === 'POST' ? await rawBody() : ''
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '')
    st.log.push({ method: req.method ?? 'GET', path: url.pathname + url.search, headers, body: raw })
    // the gate: 404 before validation while PUBLIC_LINKS_ENABLED is off
    if (!st.enabled) return problem(res, 404, 'ROUTE_NOT_FOUND', 'Route not found'), true
    const p = url.pathname.slice(d.base.length)
    let body: Record<string, unknown> = {}
    if (req.method === 'POST') {
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      } catch {
        return problem(res, 400, 'BAD_JSON', 'Malformed JSON'), true
      }
    }
    const t = now()

    if (p === '/exchange' && req.method === 'POST') {
      const tok = typeof body.token === 'string' ? body.token : ''
      const l = st.links.get(sha(tok))
      const dead = deadReason(l) ?? (l!.exchanges >= l!.maxExchanges ? 'used' : null)
      if (dead)
        return problem(res, 401, 'IDENTITY_LINK_INVALID', 'This link no longer works', { detail: 'This link expired or was replaced. Text us and we’ll send you a new one.', meta: { reason: dead } }), true
      l!.exchanges++
      const sess = token()
      const s: FSession = { linkId: l!.id, verified: trusted(l!.phone), verifiedBy: null, stepUpAt: null, codeAt: null, resetCodeAt: null, failures: 0, codeTimes: [], idleUntil: t + 15 * MIN, until: t + 60 * MIN }
      st.sessions.set(sha(sess), s)
      return send(res, 200, { session: sess, ...view(s, l!) }), true
    }

    const ses = session(req)
    if (!ses) return problem(res, 401, 'IDENTITY_SESSION_INVALID', 'Open your link again', { detail: 'Your page timed out. Open the link from our text again.' }), true
    const { s, l } = ses
    const dead = deadReason(l)
    if (dead && dead !== 'used') return problem(res, 401, 'IDENTITY_LINK_INVALID', 'This link no longer works', { meta: { reason: dead } }), true
    const pin = st.pins.get(l.phone)

    if (p === '/me' && req.method === 'GET') return send(res, 200, view(s, l)), true
    // a page asking for another kind of link's action
    const wrongPurpose = () => problem(res, 401, 'LINK_WRONG_PURPOSE', 'This link is for something else', { detail: 'This link is for something else. Text us and we’ll send you the right one.' })
    const stepUp = (need: 'verified' | 'fresh') => problem(res, 403, 'IDENTITY_STEP_UP_REQUIRED', 'Confirm it’s you', { detail: 'Enter your PIN or a texted code to continue.', meta: { need } })
    const held = () => {
      const until = heldUntil(l.phone)
      return until ? (problem(res, 403, 'LINK_PRIVILEGES_HELD', 'Your PIN was just reset', { detail: 'Your PIN was just reset, so this waits a few days. Text us if you need help.', meta: { until: iso(until) } }), true) : false
    }

    if (p === '/availability' && req.method === 'GET') {
      if (l.kind !== 'calendar' && l.kind !== 'book_again') return wrongPurpose(), true
      const days = Math.max(1, Math.min(14, Number(url.searchParams.get('days') ?? '7') || 7))
      const service = url.searchParams.get('service') || d.services[0]!.key
      if (!d.services.some((x) => x.key === service)) return problem(res, 422, 'PUBLIC_VALIDATION', `Unknown service ${service}.`), true
      const a = d.availability(days, service)
      // VIP-aware only when verified: a verified VIP member sees the held times as open
      const vip = s.verified && (!l.stale || s.verified) && l.tier === 'vip' && !heldUntil(l.phone)
      if (vip) for (const day of a.days) for (const x of day.slots) if (x.state === 'vip') x.state = x.bays === 1 ? 'last' : 'open'
      return send(res, 200, { ...a, vip }), true
    }

    if (p === '/verify/code' && req.method === 'POST') {
      // the code goes to the link's number only: a phone in the body is ignored
      // the API's CodeBody: purpose verify | pin_set | pin_reset (default verify); anything else is a 422
      if (body.purpose !== undefined && !PURPOSES.includes(body.purpose as CodePurpose))
        return problem(res, 422, 'VALIDATION_FAILED', 'Check the form', { detail: 'Invalid enum value', errors: [{ path: 'body.purpose', message: `Invalid enum value. Expected 'verify' | 'pin_set' | 'pin_reset'` }] }), true
      const purpose = (body.purpose as CodePurpose | undefined) ?? 'verify'
      if (purpose !== 'verify' && l.firstName === null) return problem(res, 409, 'IDENTITY_UNKNOWN_CLIENT', 'No client for this link', { detail: 'Text us and we’ll help you set a PIN.' }), true
      if (purpose === 'verify' && pin) return problem(res, 409, 'IDENTITY_PIN_REQUIRED', 'Enter your PIN', { detail: 'Enter your PIN to continue, or reset it with a texted code.' }), true
      if (purpose === 'pin_set' && pin) return problem(res, 409, 'IDENTITY_PIN_EXISTS', 'You already have a PIN', { detail: 'You already have a PIN. Enter it, or reset it with a texted code.' }), true
      if (purpose === 'pin_reset' && !pin) return problem(res, 409, 'IDENTITY_PIN_NOT_SET', 'No PIN yet', { detail: 'You don’t have a PIN yet. Confirm with a texted code to create one.' }), true
      s.codeTimes = s.codeTimes.filter((x) => x > t - 10 * MIN)
      if (s.codeTimes.length >= 3) return problem(res, 429, 'PUBLIC_RATE_LIMITED', 'Too many codes', { detail: 'Too many codes for this page. Try again in a few minutes.' }, { 'retry-after': '600' }), true
      s.codeTimes.push(t)
      const id = crypto.randomUUID()
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
      for (const [k, c] of st.codes) if (c.sessionHash === sha(ses.token)) st.codes.delete(k)
      st.codes.set(id, { sessionHash: sha(ses.token), purpose, code, tries: 0, expiresAt: t + 10 * MIN, used: false })
      const text = { to: l.phone, body: `Your Oasis Auto Spa code is ${code}. It expires in 10 minutes.`, klass: 'otp_code' }
      st.texts.push(text)
      d.pushText(text)
      return send(res, 202, { challengeId: id, expiresInSec: 600, purpose, to: l.phone.slice(-2) }), true
    }

    if (p === '/verify/code/confirm' && req.method === 'POST') {
      const c = st.codes.get(String(body.challengeId ?? ''))
      if (!c || c.sessionHash !== sha(ses.token) || c.used || c.expiresAt <= t) return problem(res, 410, 'PUBLIC_OTP_EXPIRED', 'That code expired. Request a new one.'), true
      if (String(body.code ?? '').replace(/\D/g, '') !== c.code) {
        c.tries++
        s.failures++
        if (s.failures >= 5) return problem(res, 429, 'IDENTITY_SESSION_LOCKED', 'Too many tries', { detail: 'Too many tries. Open the link from our text again later.' }), true
        if (c.tries >= 3) {
          c.used = true
          return problem(res, 429, 'PUBLIC_OTP_LOCKED', 'Too many tries. Request a new code.'), true
        }
        const left = Math.min(3 - c.tries, 5 - s.failures)
        return problem(res, 401, 'PUBLIC_OTP_INVALID', 'That code didn’t match', { detail: `That code didn’t match. ${left} more ${left === 1 ? 'try' : 'tries'} before you need a new one.`, meta: { attemptsLeft: left } }), true
      }
      c.used = true
      if (c.purpose === 'pin_reset') {
        s.resetCodeAt = t
        return send(res, 200, { verified: false, ...view(s, l) }), true
      }
      if (st.pins.has(l.phone)) return problem(res, 409, 'IDENTITY_PIN_REQUIRED', 'Enter your PIN', { detail: 'Enter your PIN to continue, or reset it with a texted code.' }), true
      s.verified = true
      s.verifiedBy = 'code'
      s.stepUpAt = t
      s.codeAt = t
      if (l.firstName !== null) grantTrust(l.phone)
      return send(res, 200, { verified: true, ...view(s, l) }), true
    }

    if (p === '/verify/pin' && req.method === 'POST') {
      if (pin?.disabled) return problem(res, 423, 'IDENTITY_PIN_DISABLED', 'PIN locked', { detail: 'Your PIN is locked after too many wrong tries. Reset it with a texted code.' }), true
      if (pin && pin.lockedUntil > t) {
        const minutes = Math.max(1, Math.ceil((pin.lockedUntil - t) / MIN))
        return problem(res, 429, 'IDENTITY_PIN_LOCKED', 'PIN locked for now', { detail: `Too many wrong PINs. Try again in ${minutes} min, or reset your PIN with a texted code.` }, { 'retry-after': String(minutes * 60) }), true
      }
      const given = String(body.pin ?? '')
      if (!pin || given !== pin.pin) {
        // as verifySessionPin (backend src/modules/identity/pin-service.ts): the wrong PIN counts against the PIN (locked
        // 15 min at 5, 1 h at 8, disabled at 11) and against the page; the answer is the page's (its fifth wrong entry ends
        // it), the lock shows on the next try (a new page of the link: "Too many wrong PINs. Try again in 15 min")
        s.failures++
        if (pin) {
          pin.fails++
          if (pin.fails === 5 || pin.fails === 8) pin.lockedUntil = t + (pin.fails === 5 ? 15 : 60) * MIN
          if (pin.fails >= 11) pin.disabled = true
        }
        if (s.failures >= 5) return problem(res, 429, 'IDENTITY_SESSION_LOCKED', 'Too many tries', { detail: 'Too many tries. Open the link from our text again later.' }), true
        const left = 5 - s.failures
        return problem(res, 401, 'IDENTITY_PIN_INVALID', 'That PIN didn’t match', { detail: `That PIN didn’t match. ${left} more ${left === 1 ? 'try' : 'tries'} on this page.`, meta: { attemptsLeft: left } }), true
      }
      pin.fails = 0
      s.verified = true
      s.verifiedBy = 'pin'
      s.stepUpAt = t
      grantTrust(l.phone)
      return send(res, 200, { verified: true, ...view(s, l) }), true
    }

    if ((p === '/pin' || p === '/pin/reset') && req.method === 'POST') {
      const reset = p === '/pin/reset'
      const after = reset ? s.resetCodeAt : s.codeAt
      if (after == null || t - after > 10 * MIN) return problem(res, 403, 'IDENTITY_CODE_REQUIRED', 'Confirm with a code first', { detail: 'Confirm with the code we text you, then choose your PIN within 10 minutes.' }), true
      if (l.firstName === null) return problem(res, 409, 'IDENTITY_UNKNOWN_CLIENT', 'No client for this link', { detail: 'Text us and we’ll help you set a PIN.' }), true
      if (!reset && pin) return problem(res, 409, 'IDENTITY_PIN_EXISTS', 'You already have a PIN', { detail: 'You already have a PIN. Enter it, or reset it with a texted code.' }), true
      if (reset && !pin) return problem(res, 409, 'IDENTITY_PIN_NOT_SET', 'No PIN yet', { detail: 'You don’t have a PIN yet. Confirm with a texted code to create one.' }), true
      const np = String(body.pin ?? '')
      const why = pinRejected(np, l.phone)
      if (why) return problem(res, 422, 'IDENTITY_PIN_REJECTED', 'Choose another PIN', { detail: why }), true
      st.pins.set(l.phone, { pin: np, fails: 0, lockedUntil: 0, disabled: false })
      if (reset) st.held.set(l.phone, t + 72 * 60 * MIN)
      s.verified = true
      s.verifiedBy = s.verifiedBy ?? 'code'
      s.stepUpAt = t
      grantTrust(l.phone)
      // a new PIN ends the client's other pages (the identity core re-binds this one)
      for (const [k, other] of st.sessions) if (other !== s && linkById(other.linkId)?.phone === l.phone) st.sessions.delete(k)
      return send(res, 200, { verified: true, ...view(s, l) }), true
    }

    if (p === '/bookings' && req.method === 'POST') {
      if (l.kind !== 'calendar' && l.kind !== 'book_again') return wrongPurpose(), true
      if (!s.verified) return stepUp('verified'), true
      if (typeof req.headers['idempotency-key'] !== 'string') return problem(res, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required.'), true
      // strict body (the API's zod schemas refuse unknown keys)
      const allowed = ['serviceKey', 'addonKeys', 'date', 'startMin', 'vehicle', 'name', 'email', 'smsConsent']
      const extra = Object.keys(body).filter((k) => !allowed.includes(k))
      if (extra.length) return problem(res, 422, 'VALIDATION_FAILED', 'Check the form', { detail: `Unknown field ${extra[0]}`, errors: extra.map((k) => ({ path: `body.${k}`, message: 'Unrecognized key' })) }), true
      if (l.uses >= l.maxUses) return problem(res, 409, 'IDENTITY_LINK_USED', 'This link was already used', { detail: 'This link was already used. Text us and we’ll send you a new one.' }), true
      const date = String(body.date ?? '')
      const startMin = Number(body.startMin)
      const svc = d.services.find((x) => x.key === body.serviceKey)
      const name = l.firstName ?? String(body.name ?? '').trim()
      if (!name) return problem(res, 422, 'VALIDATION_FAILED', 'Check the form', { detail: 'Enter your name.', errors: [{ path: 'body.name', message: 'Enter your name.' }] }), true
      if (!svc || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(startMin)) return problem(res, 422, 'PUBLIC_VALIDATION', 'Check the booking details.'), true
      const a = d.availability(14, svc.key)
      const day = a.days.find((x) => x.date === date)
      const slot = day?.slots.find((x) => x.startMin === startMin)
      if (!day || day.closed) return problem(res, 409, 'PUBLIC_SLOT_CLOSED', 'We’re closed at that time. Pick another.'), true
      if (!slot) return problem(res, 409, 'PUBLIC_SLOT_PAST', 'That time has passed. Pick another.'), true
      if (slot.state === 'vip' && l.tier !== 'vip') return problem(res, 409, 'PUBLIC_SLOT_VIP', `${slot.start} is held for VIP members.`), true
      if (slot.state === 'booked') return problem(res, 409, 'PUBLIC_SLOT_TAKEN', 'That time was just taken. Pick another.'), true
      l.uses++
      const bookingRef = `OAS-${String(++seq).padStart(5, '0')}`
      const addonKeys = Array.isArray(body.addonKeys) ? (body.addonKeys as string[]) : []
      const when = `${day.label} · ${slot.start}`
      // instants: the shop date at startMin, as UTC-4 (the fixture's clock is the shop's; good enough for the shape)
      const start = new Date(`${date}T00:00:00-04:00`).getTime() + startMin * MIN
      const end = start + 45 * MIN
      st.bookings.push({ bookingRef, phone: l.phone, name, date, startMin, serviceKey: svc.key, serviceName: svc.name, addonKeys, start: iso(start), end: iso(end), when, linkId: l.id, source: 'link' })
      const member = !!l.tier && !heldUntil(l.phone)
      return send(res, 201, {
        bookingRef,
        status: 'booked',
        start: iso(start),
        end: iso(end),
        deposit: member ? { dueCents: 0, how: 'counter' } : { dueCents: 2500, how: 'counter' },
        confirmationBy: 'sms',
        service: { key: svc.key, name: svc.name },
        addons: addonKeys.map((k) => ({ key: k, name: d.addons.find((a) => a.key === k)?.name ?? k })),
        when,
        member,
        bayCount: 3,
      }), true
    }

    const resched = /^\/appointments\/([^/]+)\/reschedule$/.exec(p)
    if (resched && req.method === 'POST') {
      if (l.kind !== 'calendar') return wrongPurpose(), true
      if (!s.verified) return stepUp('verified'), true
      const b = st.bookings.find((x) => x.bookingRef === decodeURIComponent(resched[1]!) && x.phone === l.phone)
      if (!b) return problem(res, 404, 'LINK_APPOINTMENT_NOT_FOUND', 'Visit not found', { detail: 'We can’t find that visit. Text us and we’ll help.' }), true
      b.date = String(body.date ?? b.date)
      b.startMin = Number(body.startMin ?? b.startMin)
      return send(res, 200, { bookingRef: b.bookingRef, status: 'booked', start: b.start, end: b.end, when: b.when }), true
    }

    if (p === '/membership/start' && req.method === 'POST') {
      if (l.kind !== 'membership' || !l.plan) return wrongPurpose(), true
      if (s.stepUpAt == null || t - s.stepUpAt > 5 * MIN) return stepUp('fresh'), true
      if (held()) return true
      const extra = Object.keys(body).filter((k) => k !== 'email' && k !== 'vehicles')
      if (extra.length) return problem(res, 422, 'VALIDATION_FAILED', 'Check the form', { detail: `Unknown field ${extra[0]}`, errors: extra.map((k) => ({ path: `body.${k}`, message: 'Unrecognized key' })) }), true
      const email = String(body.email ?? '').trim()
      if (!EMAIL.test(email)) return problem(res, 422, 'VALIDATION_FAILED', 'Check the form', { detail: 'Enter a valid email.', errors: [{ path: 'body.email', message: 'Enter a valid email.' }] }), true
      if (l.tier) return problem(res, 409, 'LINK_ALREADY_MEMBER', 'Already a member', { detail: 'You already have a membership. Text us to change your plan.' }), true
      if (!l.plan.checkoutUrl) return problem(res, 409, 'LINK_CHECKOUT_UNAVAILABLE', 'Joining online isn’t open', { detail: 'Joining online isn’t open right now. Text us and we’ll help you join.' }), true
      if (l.uses >= l.maxUses) return problem(res, 409, 'IDENTITY_LINK_USED', 'This link was already used'), true
      l.uses++
      const membershipRef = `OAS-M-${crypto.randomBytes(4).toString('hex').toUpperCase()}`
      st.memberships.push({ membershipRef, phone: l.phone, planKey: l.plan.planKey, state: 'pending' })
      st.checkouts.push({ membershipRef, phone: l.phone, planKey: l.plan.planKey, expectedEmail: email, checkoutUrl: l.plan.checkoutUrl, linkId: l.id, state: 'open' })
      return send(res, 200, { redirectUrl: l.plan.checkoutUrl, membershipRef, checkoutExpiresAt: iso(t + 72 * 60 * MIN) }), true
    }

    if (p === '/pay/start' && req.method === 'POST') {
      if (l.kind !== 'pay' || !l.invoice) return wrongPurpose(), true
      if (s.stepUpAt == null || t - s.stepUpAt > 5 * MIN) return stepUp('fresh'), true
      if (held()) return true
      if (invoiceView(l.invoice).balanceCents <= 0) return problem(res, 401, 'IDENTITY_SESSION_INVALID', 'Open your link again', { detail: 'Open the link from our text again.' }), true
      if (l.uses >= l.maxUses) return problem(res, 409, 'IDENTITY_LINK_USED', 'This link was already used'), true
      l.uses++
      st.payStarts.push({ linkId: l.id, invoice: l.invoice.number, redirectUrl: l.invoice.url })
      // the real API refuses a URL off its own allowlist (link_pending); this fixture hands back whatever was seeded so
      // the e2e can prove the page's own allowlist
      if (!l.invoice.url) return send(res, 200, { status: 'link_pending', redirectUrl: null }), true
      return send(res, 200, { status: 'redirect', redirectUrl: l.invoice.url }), true
    }

    return problem(res, 404, 'ROUTE_NOT_FOUND', 'Route not found'), true
  }

  /** Ends every page now (the e2e's "the page timed out" case). */
  function expireSessions(): void {
    for (const s of st.sessions.values()) s.idleUntil = 0
  }

  /** The state without secrets (no PIN, no code hash) for the e2e's assertions; the codes are listed, they are test data. */
  function snapshot() {
    return {
      enabled: st.enabled,
      links: [...st.links.values()].map((l) => ({ id: l.id, kind: l.kind, phone: l.phone, uses: l.uses, exchanges: l.exchanges })),
      sessions: st.sessions.size,
      trust: Object.fromEntries([...st.trust.entries()].map(([k, v]) => [k, new Date(v).toISOString()])),
      pins: Object.fromEntries([...st.pins.entries()].map(([k, v]) => [k, { set: true, fails: v.fails, locked: v.lockedUntil > now(), disabled: v.disabled }])),
      codes: [...st.codes.entries()].map(([id, c]) => ({ id, purpose: c.purpose, code: c.code, used: c.used })),
      bookings: st.bookings,
      memberships: st.memberships,
      checkouts: st.checkouts,
      payStarts: st.payStarts,
    }
  }

  return { state: st, issue, handle, expireSessions, snapshot, pinOf: (phone: string) => st.pins.get(phone)?.pin ?? null }
}

export type LinkFixture = ReturnType<typeof createLinkFixture>
