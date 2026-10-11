// e2e-site: the website against a public booking API, end to end in pinned Chromium (docs/e2e.md).
//
//   pnpm e2e:site --api fixture                       the in-process fixture API (tools/site/fixture-api.ts)
//   pnpm e2e:site --stack site [--dashboard ~/oasis/dashboard]   a live stack started with the dashboard's
//                                                     `pnpm live:up --name site --backend <wt> --profile design,demo`
//   options: --port 3301 (the site's host), --skip-build (reuse dist-e2e-live / dist-e2e-sms / dist-e2e-catalog), --headed
//
// Builds the site twice (SITE_BOOKING=live with the stack's hours and availability baked in, and the launch default
// SITE_BOOKING=sms), serves each through tools/site/proxy.ts (nginx's same-origin /api/v1/public/* mapping) and checks:
// hours and availability render the API's data (Sunday closed); a guest booking creates a real appointment (seen in
// GET /api/v1/ops/snapshot as the seeded manager); the slot turns last/booked on reload; the OTP member path books
// without a fee (the code read from the fixture's texts, or recovered from the stack's challenge hash because the
// simulator delivers the text instantly and delivered one-time codes are redacted); a join creates a pending
// membership; the honeypot creates nothing; the catalog's prices show (DV-CATALOG: a changed price in the fixture's catalog
// appears after the page's catalog load, an unseeded catalog leaves the design's content); no page error, no 5xx, no
// external request; and in sms mode every Book/Join action produces an sms: link with the composed body.
/* eslint-disable @typescript-eslint/no-explicit-any */
import '../tools/parity/env'
import { execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { buildSite } from '../tools/prerender/build'
import { startFixtureApi, type FixtureApi } from '../tools/site/fixture-api'
import { designCatalog, unseededCatalog, withMemberPrice } from '../tools/site/catalog-fixture'
import { startSiteProxy, type SiteProxy } from '../tools/site/proxy'
import { ROOT, CHROMIUM_FLAGS } from '../tools/parity/config'
import { runLinkChecks } from './e2e-links'

interface Stack {
  name: string
  apiUrl: string
  webUrl: string
  devPassword: string
  schema: string
  backend: string
}

interface Api {
  kind: 'fixture' | 'stack'
  origin: string
  fixture?: FixtureApi
  stack?: Stack
}

/**
 * The owner's decision of 2026-10-10 (DEVIATIONS.md DV-CONTACT): people TEXT the shop at 862-388-5827 and CALL it at
 * 201-598-6304. site.config.json contact.smsE164 / phoneE164 must say the same.
 */
const SMS_E164 = '+18623885827'
const TEL_E164 = '+12015986304'
const SMS_DISPLAY = '862-388-5827'
const TEL_DISPLAY = '201-598-6304'
const CONTACT = (JSON.parse(fs.readFileSync(path.join(ROOT, 'site.config.json'), 'utf8')) as { contact: Record<string, string> }).contact
const reSms = (body: string) => new RegExp(`^sms:${SMS_E164.replace('+', '\\+')}\\?&body=${body}`)

const PHONES = {
  guest: '+12015550141',
  member: '+12015550142',
  join: '+12015550143',
}

const log = (s: string) => console.log(s)
const results: { name: string; ok: boolean; note?: string }[] = []
let failures = 0
function check(name: string, ok: boolean, note?: string): void {
  results.push({ name, ok, note })
  if (!ok) failures++
  log(`${ok ? 'ok  ' : 'FAIL'} ${name}${note ? ` — ${note}` : ''}`)
}
const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg)
}

// ---- API access ----------------------------------------------------------------------------------------------------------
async function getJson(url: string, init: RequestInit = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const r = await fetch(url, init)
  const text = await r.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    /* text */
  }
  return { status: r.status, body, headers: r.headers }
}

function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!fs.existsSync(file)) return out
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (m && !line.trim().startsWith('#')) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, '')
  }
  return out
}

/** One query against the stack's schema; `T.` in the SQL is replaced by the schema prefix. */
function psql(stack: Stack, sql: string): string {
  const url = readEnvFile(path.join(stack.backend, '.env')).DATABASE_URL
  if (!url) throw new Error(`${stack.backend}/.env has no DATABASE_URL`)
  return execFileSync('psql', [url, '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', sql.replace(/\bT\./g, `${stack.schema}.`)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/** The one-time code of a challenge: the fixture lists it; the stack keeps only sha256(id:code), recovered by search. */
async function codeFor(api: Api, challengeId: string, phone: string): Promise<string> {
  if (api.kind === 'fixture') {
    const s = await getJson(`${api.origin}/__fixture/state`)
    const c = (s.body.challenges as { id: string; code: string }[]).find((x) => x.id === challengeId)
    assert(c, `fixture: no challenge ${challengeId}`)
    return c!.code
  }
  const stack = api.stack!
  // 1. the text itself, when it is still in the outbox unredacted
  const texts = psql(stack, `select body from T.sms_outbox where to_e164 = '${phone}' and klass = 'otp_code' order by queued_at desc limit 3`)
  for (const line of texts.split('\n')) {
    const m = /\b(\d{6})\b/.exec(line)
    if (m) return m[1]!
  }
  // 2. the challenge hash (sha256 of "<id>:<code>", 6 digits: at most a million hashes)
  const hash = psql(stack, `select code_hash from T.public_otp_challenges where id = '${challengeId}'`)
  assert(/^[0-9a-f]{64}$/.test(hash), `stack: no challenge ${challengeId} (${hash})`)
  for (let n = 0; n < 1_000_000; n++) {
    const code = String(n).padStart(6, '0')
    if (crypto.createHash('sha256').update(`${challengeId}:${code}`).digest('hex') === hash) return code
  }
  throw new Error('stack: the code was not recovered from the challenge hash')
}

async function managerSession(stack: Stack): Promise<string> {
  const seeded = ['rafael', 'amara', 'sofia', 'marco', 'lena', 'daniel']
  for (const first of seeded) {
    const r = await fetch(`${stack.apiUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: stack.webUrl },
      body: JSON.stringify({ email: `${first}@oasisautospa.com`, password: stack.devPassword }),
    })
    if (r.ok) {
      const cookie = r.headers.getSetCookie?.().map((c) => c.split(';')[0]).join('; ') ?? ''
      const snap = await fetch(`${stack.apiUrl}/api/v1/ops/snapshot?window=week`, { headers: { cookie } })
      if (snap.ok) return cookie
    }
  }
  throw new Error('could not sign in as a seeded manager who may read /ops/snapshot')
}

/**
 * The owner's decision: Sunday is closed. The design seed keeps the design's Sunday 9-3, so the stack's Settings are
 * corrected through the Settings API as a seeded user with `set.hours` (the super admin first), exactly the way the
 * owner sets it in the dashboard (PUT /settings/hours with the current version). Returns what was done.
 */
async function ensureSundayClosed(stack: Stack): Promise<string> {
  const reasons: string[] = []
  for (const first of ['amara', 'rafael']) {
    const r = await fetch(`${stack.apiUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: stack.webUrl },
      body: JSON.stringify({ email: `${first}@oasisautospa.com`, password: stack.devPassword }),
    })
    if (!r.ok) {
      reasons.push(`${first}: login ${r.status}`)
      continue
    }
    const cookie = r.headers.getSetCookie?.().map((c) => c.split(';')[0]).join('; ') ?? ''
    // writes carry the session's CSRF token (answered by the login) in x-csrf-token, like the dashboard does
    const csrf = String(((await r.json()) as { csrfToken?: string }).csrfToken ?? '')
    const cur = await getJson(`${stack.apiUrl}/api/v1/settings/hours`, { headers: { cookie } })
    if (cur.status !== 200) {
      reasons.push(`${first}: GET /settings/hours ${cur.status}`)
      continue
    }
    const days = cur.body.days as { weekday: number; open: boolean; from: string; to: string }[]
    const sunday = days.find((d) => d.weekday === 0)
    if (sunday && !sunday.open) return 'Sunday was already closed in the stack Settings'
    const put = await getJson(`${stack.apiUrl}/api/v1/settings/hours`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie, origin: stack.webUrl, 'x-csrf-token': csrf, 'if-match': `"${cur.body.version}"` },
      body: JSON.stringify({
        version: cur.body.version,
        days: days.map((d) => ({ weekday: d.weekday, open: d.weekday === 0 ? false : d.open, from: d.from, to: d.to })),
      }),
    })
    if (put.status === 200) return `Sunday set closed through PUT /settings/hours as ${first} (version ${cur.body.version} -> ${put.body.version})`
    if (put.status !== 403) throw new Error(`PUT /settings/hours as ${first}: ${put.status} ${JSON.stringify(put.body).slice(0, 200)}`)
    reasons.push(`${first}: PUT /settings/hours 403`)
  }
  throw new Error(`no seeded user could set Sunday closed through the Settings API (${reasons.join('; ')})`)
}

async function snapshotText(stack: Stack, cookie: string): Promise<string> {
  const r = await fetch(`${stack.apiUrl}/api/v1/ops/snapshot?window=week`, { headers: { cookie } })
  assert(r.ok, `ops/snapshot ${r.status}`)
  return await r.text()
}

// ---- browser --------------------------------------------------------------------------------------------------------------
interface Tracker {
  errors: string[]
  blocked: string[]
  fiveHundreds: string[]
  navigations: string[]
  responses: { url: string; status: number; body: string }[]
}

async function newPage(
  browser: Browser,
  origin: string,
  timezoneId = 'America/New_York',
  colorScheme: 'light' | 'dark' = 'light',
): Promise<{ ctx: BrowserContext; page: Page; t: Tracker }> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, timezoneId, locale: 'en-US', colorScheme })
  const t: Tracker = { errors: [], blocked: [], fiveHundreds: [], navigations: [], responses: [] }
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url())
    if (u.origin === origin || u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return route.continue()
    t.blocked.push(route.request().url())
    return route.abort()
  })
  // __name: tsx's keepNames helper, referenced by named functions inside the page.evaluate callbacks (as in the harness)
  await ctx.addInitScript(
    `if (!window.__name) window.__name = function (f) { return f }; window.__oasisNavigate = function (u) { (window.__oasisNavigations = window.__oasisNavigations || []).push(u) }`,
  )
  const page = await ctx.newPage()
  page.on('console', (m) => {
    if (m.type() === 'error') t.errors.push(m.text())
  })
  page.on('pageerror', (e) => t.errors.push(`pageerror: ${e.message}`))
  page.on('response', async (r) => {
    if (r.status() >= 500) t.fiveHundreds.push(`${r.status()} ${r.url()}`)
    if (/\/api\/v1\/public\/(bookings|memberships|otp)/.test(r.url()) && r.request().method() === 'POST') {
      try {
        t.responses.push({ url: r.url(), status: r.status(), body: await r.text() })
      } catch {
        /* body gone */
      }
    }
  })
  return { ctx, page, t }
}

const navigations = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__oasisNavigations ?? [])
const ready = async (page: Page): Promise<void> => {
  await page.waitForSelector('#dc-root .sc-host', { state: 'attached', timeout: 30_000 })
  await page.waitForFunction(() => !!document.querySelector('script[src*="/assets/page-"]') && document.readyState === 'complete', null, { timeout: 30_000 })
  await page.waitForTimeout(600)
}
const btn = (page: Page, re: RegExp) => page.locator('#dc-root button').filter({ hasText: re })

/**
 * Every sms:/tel: link of the current view and every visible text node that names one of the two numbers, with
 * whether that text sits inside a tel: link (the only place the calling number may be shown).
 */
interface ContactAudit {
  sms: string[]
  tel: string[]
  texts: { text: string; inTel: boolean; inSms: boolean }[]
}
const auditContacts = (page: Page): Promise<ContactAudit> =>
  page.evaluate(
    ({ a, b }) => {
      const root = document.getElementById('dc-root')!
      const hrefs = (scheme: string) =>
        Array.from(root.querySelectorAll(`a[href^="${scheme}"]`)).map((e) => e.getAttribute('href') ?? '')
      const texts: { text: string; inTel: boolean; inSms: boolean }[] = []
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const t = n.textContent ?? ''
        if (!t.includes(a) && !t.includes(b)) continue
        const el = n.parentElement
        texts.push({ text: t.trim(), inTel: !!el?.closest('a[href^="tel:"]'), inSms: !!el?.closest('a[href^="sms:"]') })
      }
      return { sms: hrefs('sms:'), tel: hrefs('tel:'), texts }
    },
    { a: SMS_DISPLAY, b: TEL_DISPLAY },
  )
const audits: { view: string; audit: ContactAudit }[] = []

/** The page's theme: the design wrapper's data-theme, the body background, the stored choice (DV-THEME). */
const themeState = (page: Page): Promise<{ attr: string; bg: string; stored: string | null }> =>
  page.evaluate(() => {
    let stored: string | null = null
    try {
      stored = localStorage.getItem('oasis-theme')
    } catch {
      stored = null
    }
    return {
      attr: document.querySelector('#dc-root [data-oa]')?.getAttribute('data-theme') ?? '',
      bg: document.body.style.background,
      stored,
    }
  })
const BG = { light: 'rgb(242, 243, 241)', dark: 'rgb(6, 8, 10)' }
/**
 * Hydration adopted the prerendered markup: the design wrapper seen when the parser finished (before the deferred bundle
 * ran) is still the one in the document. A hydration mismatch makes React render the root again on the client (new
 * nodes) besides logging a recoverable error.
 */
const markWrapper = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    document.addEventListener('readystatechange', () => {
      if (document.readyState === 'interactive') (window as any).__oasisWrap = document.querySelector('#dc-root [data-oa]')
    })
  })
}
const adopted = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const w = (window as any).__oasisWrap as Element | null | undefined
    return !!w && w.isConnected && w === document.querySelector('#dc-root [data-oa]')
  })
const settle = (page: Page) => page.waitForTimeout(250)

// ---- the run --------------------------------------------------------------------------------------------------------------
async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      api: { type: 'string', default: 'fixture' },
      stack: { type: 'string' },
      dashboard: { type: 'string', default: path.join(os.homedir(), 'oasis', 'dashboard') },
      port: { type: 'string', default: '3301' },
      'skip-build': { type: 'boolean', default: false },
      headed: { type: 'boolean', default: false },
    },
    strict: true,
  })
  const port = Number(values.port)
  let api: Api
  if (values.stack) {
    const file = path.join(values.dashboard!, '.live-stack', `${values.stack}.json`)
    assert(fs.existsSync(file), `no live stack state at ${file} (pnpm live:up --name ${values.stack} ...)`)
    const s = JSON.parse(fs.readFileSync(file, 'utf8')) as Stack
    api = { kind: 'stack', origin: s.apiUrl, stack: { ...s, name: values.stack } }
    log(`stack ${values.stack}: api ${s.apiUrl}, schema ${s.schema}`)
  } else {
    assert(values.api === 'fixture', '--api must be fixture, or pass --stack <name>')
    const fixture = await startFixtureApi({ port: port + 2 })
    api = { kind: 'fixture', origin: fixture.origin, fixture }
    log(`fixture API at ${fixture.origin}`)
  }

  // 0. the stack's Settings follow the owner's decision (Sunday closed) before the hours are snapshotted
  if (api.kind === 'stack') log(`settings: ${await ensureSundayClosed(api.stack!)}`)

  // 1. the two builds: live (the API's hours and availability baked in) and sms (the launch default)
  const hours = await getJson(`${api.origin}/api/v1/public/hours`)
  assert(hours.status === 200, `GET /public/hours -> ${hours.status}`)
  const avail0 = await getJson(`${api.origin}/api/v1/public/availability?days=7`)
  assert(avail0.status === 200, `GET /public/availability -> ${avail0.status}`)
  const catalog0 = await getJson(`${api.origin}/api/v1/public/catalog`)
  assert(catalog0.status === 200, `GET /public/catalog -> ${catalog0.status}`)
  const liveDir = path.join(ROOT, 'dist-e2e-live')
  const smsDir = path.join(ROOT, 'dist-e2e-sms')
  // DV-CATALOG (fixture only): a changed catalog (Signature Hand Wash at $50 for members, $60 for guests; Gold $109) for
  // the live checks, and the launch default built with another changed catalog as its SNAPSHOT (Signature at $52, $62
  // for guests: no other item costs a guest $62), so an unseeded live answer restoring the design's content is observable
  const changedCatalog = withMemberPrice(designCatalog(), 'signature-hand-wash', 50)
  changedCatalog.plans[0]!.priceCents = 10900
  const catalogDir = path.join(ROOT, 'dist-e2e-catalog')
  const snapshotCatalog = withMemberPrice(designCatalog(), 'signature-hand-wash', 52)
  const dirs = api.kind === 'fixture' ? [liveDir, smsDir, catalogDir] : [liveDir, smsDir]
  if (!values['skip-build'] || dirs.some((d) => !fs.existsSync(path.join(d, 'index.html')))) {
    await buildSite({ root: ROOT, variant: 'prod', outDir: liveDir, hoursJson: JSON.stringify(hours.body), availabilityJson: JSON.stringify(avail0.body), catalogJson: JSON.stringify(catalog0.body), booking: 'live', apiOrigin: '', log: () => {} })
    await buildSite({ root: ROOT, variant: 'prod', outDir: smsDir, hoursJson: JSON.stringify(hours.body), availabilityJson: null, booking: 'sms', apiOrigin: '', log: () => {} })
    if (api.kind === 'fixture')
      await buildSite({ root: ROOT, variant: 'prod', outDir: catalogDir, hoursJson: JSON.stringify(hours.body), availabilityJson: null, catalogJson: JSON.stringify(snapshotCatalog), booking: 'sms', apiOrigin: '', log: () => {} })
    log(`built ${dirs.map((d) => path.basename(d)).join(', ')}`)
  }
  const proxy: SiteProxy = await startSiteProxy({ dir: liveDir, apiOrigin: api.origin, port })
  log(`site (live) at ${proxy.origin}`)
  const browser = await chromium.launch({
    headless: !values.headed,
    args: [...CHROMIUM_FLAGS, ...(process.env.PARITY_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])],
    env: { ...process.env, TZ: 'America/New_York' } as Record<string, string>,
  })
  const trackers: Tracker[] = []
  let cookie = ''
  let snapBefore = ''
  if (api.kind === 'stack') {
    cookie = await managerSession(api.stack!)
    snapBefore = await snapshotText(api.stack!, cookie)
  }
  const guestKey = crypto.randomUUID()
  let bookedRef = ''
  let bookedDate = ''
  let bookedStart = -1
  try {
    // 2. hours and availability render the API's data
    {
      const { ctx, page, t } = await newPage(browser, proxy.origin)
      trackers.push(t)
      await page.goto(`${proxy.origin}/#/visit`, { waitUntil: 'load' })
      await ready(page)
      // the visit page's HOURS block and the footer both list hoursList: the first "Sunday" row is the visit page's, the last the footer's
      const rowOf = (label: RegExp, which: 'first' | 'last' = 'first') =>
        page.locator('#dc-root span.sc-interp').filter({ hasText: label })[which]().evaluate((el) => el.parentElement?.parentElement?.textContent ?? '')
      const sunday = await rowOf(/^Sunday$/)
      const sun = (hours.body.week as { weekday: number; open: boolean }[]).find((w) => w.weekday === 0)!
      check('visit page: the API says Sunday is closed (the owner\'s decision, set through the Settings API)', !sun.open, JSON.stringify(sun))
      check('visit page: Sunday reads "Closed"', /Sunday\s*Closed/.test(sunday), sunday)
      const sundayFooter = await rowOf(/^Sunday$/, 'last')
      check('footer: Sunday reads "Closed"', /Sunday\s*Closed/.test(sundayFooter) && (await page.locator('#dc-root span.sc-interp').filter({ hasText: /^Sunday$/ }).count()) === 2, sundayFooter)
      const week = (hours.body.week as { weekday: number; open: boolean; from: string }[]).find((w) => w.weekday === 1)!
      const mon = await rowOf(/^Monday/)
      check('visit page: Monday row shows the API hours', /8 AM|8:00/.test(mon) === /08:00|8:00/.test(String(week.from)), mon)
      await page.goto(`${proxy.origin}/`, { waitUntil: 'load' })
      await ready(page)
      const pill = await btn(page, /BAYS OPEN NOW|OPENS /).first().innerText()
      check('home: the hero pill reads from the hours/availability', /OF \d BAYS OPEN NOW|OPENS /.test(pill), pill)
      const dayCards = await page.locator('#dc-root button').filter({ hasText: /\d+ open/ }).allInnerTexts()
      const firstDay = (avail0.body.days as { openCount: number; closed: boolean; slots: unknown[] }[]).find((d) => !d.closed && d.slots.length)
      check('home: the first day card shows the API open count', !!firstDay && dayCards.length > 0 && dayCards[0]!.includes(`${firstDay.openCount} open`), `${dayCards[0]} vs ${firstDay?.openCount}`)
      check('home: NEXT OPEN comes from the availability', (await page.locator('#dc-root :text-is("NEXT OPEN")').count()) === 1)
      await ctx.close()
    }

    // 3. a guest booking creates a real appointment
    {
      const { ctx, page, t } = await newPage(browser, proxy.origin)
      trackers.push(t)
      await page.goto(`${proxy.origin}/`, { waitUntil: 'load' })
      await ready(page)
      await btn(page, /^\s*Book it\s*$/).click()
      await settle(page)
      await btn(page, /Continue as guest/).click()
      await settle(page)
      await btn(page, /^\s*Hand wax/).click()
      await btn(page, /^\s*Review booking/).click()
      await settle(page)
      await page.locator('#dc-root input[placeholder="Full name"]').fill('Jamie Rivera')
      await page.locator('#dc-root input[placeholder="Mobile number"]').fill(PHONES.guest)
      await btn(page, /^\s*I understand the \$25 booking fee/).click()
      // the sticky bar carries a "Book" too (hidden under the sheet); the sheet's CTA is the last one
      await btn(page, /^\s*Book\s*$/).last().click()
      try {
        await page.waitForSelector('#dc-root :text("You\'re booked")', { timeout: 20_000 })
      } catch {
        const last = t.responses[t.responses.length - 1]
        throw new Error(`guest booking: the done step never appeared; last API answer ${last?.status ?? '(none)'} ${last?.body.slice(0, 300) ?? ''}`)
      }
      const done = await page.locator('#dc-root').innerText()
      const ref = /Ref (OAS-\d+)/.exec(done)?.[1] ?? ''
      bookedRef = ref
      check('guest booking: the done step shows the real booking reference', /^OAS-\d+$/.test(ref), ref)
      check('guest booking: the confirmation note', /text your confirmation/.test(done))
      const resp = t.responses.find((r) => r.url.includes('/public/bookings'))
      const body = resp ? (JSON.parse(resp.body) as Record<string, any>) : null
      check('guest booking: 201 with the fee due at the counter or by link', resp?.status === 201 && body?.deposit?.dueCents === 2500 && ['counter', 'link'].includes(body?.deposit?.how), resp?.body.slice(0, 200))
      // the answer's `when` ("Today · 8:00 AM") names the slot the way the availability payload labels it
      // (`start` is an instant: UTC on the stack, the shop's wall clock on the fixture)
      const when = /^(.+?) · (\d+:\d\d (?:AM|PM))$/.exec(String(body?.when ?? ''))
      if (when) {
        for (const d of avail0.body.days as { date: string; label: string; slots: { startMin: number; start: string }[] }[]) {
          const slot = d.slots.find((s) => s.start === when[2])
          // the nearest day with that label (a 7-day board can list two "Mon")
          if (d.label === when[1] && slot && !bookedDate) {
            bookedDate = d.date
            bookedStart = slot.startMin
          }
        }
      }
      if (api.kind === 'fixture') {
        const s = await getJson(`${api.origin}/__fixture/state`)
        check('guest booking: recorded by the API', (s.body.bookings as { bookingRef: string }[]).some((b) => b.bookingRef === ref))
      } else {
        const after = await snapshotText(api.stack!, cookie)
        const seq = Number(ref.replace(/^OAS-0*/, ''))
        check('guest booking: visible in GET /ops/snapshot as the seeded manager', after.includes(`"seq":${seq}`) && !snapBefore.includes(`"seq":${seq}`), `seq ${seq}`)
      }
      await ctx.close()
    }

    // 4. the slot taken by the booking turns last/booked on reload
    {
      const avail1 = await getJson(`${api.origin}/api/v1/public/availability?days=7`)
      const find = (a: any) => {
        for (const d of a.days as { date: string; slots: { startMin: number; state: string; bays: number }[] }[])
          if (d.date === bookedDate) return d.slots.find((s) => s.startMin === bookedStart)
        return undefined
      }
      const before = find(avail0.body)
      const after = find(avail1.body)
      const fewer = !!before && (!after || after.bays < before.bays || (after.state !== 'open' && before.state === 'open'))
      check('availability: the booked slot lost a bay (last/booked)', fewer, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`)
      const { ctx, page, t } = await newPage(browser, proxy.origin)
      trackers.push(t)
      await page.goto(`${proxy.origin}/`, { waitUntil: 'load' })
      await ready(page)
      await page.waitForTimeout(1500)
      // board rows: every flap cell is its own span (" ", "8", ":", "0", "0", "AM", "B", "O", "O", "K", "E", "D", " "), so the
      // rows are read as their text content with the whitespace removed: "8:00AMBOOKED", "11:30AMLAST1"
      const rows = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#dc-root button'))
          .map((b) => (b.textContent ?? '').replace(/\s+/g, ''))
          .filter((t) => /^\d{1,2}:\d\d(AM|PM)(OPEN|LAST|VIP|BOOKED)/.test(t)),
      )
      check('board: reloaded rows reflect the fresh availability (LAST/BOOKED present or the slot gone)', rows.length > 0 && (rows.some((r) => /LAST|BOOKED/.test(r)) || !after), rows.slice(0, 3).join(' | '))
      await ctx.close()
    }

    // 5. the member path: phone -> code -> no fee
    {
      let memberPhone = PHONES.member
      if (api.kind === 'stack') {
        const found = psql(api.stack!, `select c.phone_e164 from T.memberships m join T.customers c on c.id = m.customer_id where m.status = 'active' and c.phone_e164 is not null order by m.created_at limit 1`)
        if (found) memberPhone = found
      } else memberPhone = '+12015550199'
      const { ctx, page, t } = await newPage(browser, proxy.origin)
      trackers.push(t)
      await page.goto(`${proxy.origin}/`, { waitUntil: 'load' })
      await ready(page)
      await page.locator('#dc-root button[aria-label="Menu"]').click()
      await btn(page, /^\s*Book a time\s*$/).click()
      await settle(page)
      await page.locator('#dc-root input[placeholder="Mobile number"]').fill(memberPhone)
      await btn(page, /^\s*Continue\s*$/).click()
      await page.waitForSelector('#dc-root :text("Enter the code we texted")', { timeout: 20_000 })
      const otp = t.responses.find((r) => r.url.endsWith('/public/otp'))
      const challengeId = otp ? (JSON.parse(otp.body) as { challengeId: string }).challengeId : ''
      check('member: POST /public/otp answered 202 with a challenge', otp?.status === 202 && !!challengeId)
      const code = await codeFor(api, challengeId, memberPhone)
      await page.locator('#dc-root input[placeholder="123456"]').fill(code)
      await btn(page, /^\s*Verify\s*$/).click()
      await page.waitForSelector('#dc-root :text("Choose your wash")', { timeout: 20_000 })
      const verify = t.responses.find((r) => r.url.endsWith('/public/otp/verify'))
      const member = verify ? (JSON.parse(verify.body) as { memberToken: string; member: { active: boolean } }) : null
      check('member: the code verified into a member token', verify?.status === 200 && !!member?.memberToken && member.member.active === true, verify?.body.slice(0, 160))
      const included = await page.locator('#dc-root :text("1 of 4 this month")').count()
      check('member: the wash reads as included', included >= 1)
      await btn(page, /^\s*Choose a time/).click()
      await settle(page)
      // a sheet slot reads "11:30 AM" over "OPEN" (two lines); a board row behind the sheet reads "11:30AMOPEN" in one
      const slot = page.locator('#dc-root button').filter({ hasText: /^\d+:\d\d (AM|PM)\s*(OPEN|LAST BAY|VIP)$/ }).first()
      // the sheet's sticky header would intercept a click on a slot Playwright scrolled under it
      await slot.evaluate((el) => el.scrollIntoView({ block: 'center' }))
      await slot.click()
      await btn(page, /^\s*Review · /).click()
      await settle(page)
      const cta = await btn(page, /Confirm booking/).count()
      check('member: the review CTA is "Confirm booking" (no fee line)', cta === 1 && (await page.locator('#dc-root :text("Booking fee · non-refundable")').count()) === 0)
      // the member books under the name they type (the API keeps a verified member's name as given: the first name from
      // the code check is never sent back as the name); the number is the verified one, no mobile field
      const nameFields = await page.locator('#dc-root input[placeholder="Full name"]').count()
      const phoneFields = await page.locator('#dc-root input[placeholder="Mobile number"]').count()
      check('member: the review asks for the full name and not for the number', nameFields === 1 && phoneFields === 0, `name ${nameFields}, mobile ${phoneFields}`)
      await page.locator('#dc-root input[placeholder="Full name"]').fill('Dana Whitfield')
      await btn(page, /^\s*Confirm booking/).click()
      try {
        await page.waitForSelector('#dc-root :text("You\'re booked")', { timeout: 20_000 })
      } catch {
        const last = t.responses[t.responses.length - 1]
        throw new Error(`member booking: the done step never appeared; last API answer ${last?.status ?? '(none)'} ${last?.body.slice(0, 300) ?? ''}`)
      }
      const resp = t.responses.find((r) => r.url.includes('/public/bookings'))
      const body = resp ? (JSON.parse(resp.body) as Record<string, any>) : null
      check('member: booked with no deposit', resp?.status === 201 && body?.deposit?.dueCents === 0 && body?.member === true, resp?.body.slice(0, 200))
      if (api.kind === 'fixture') {
        const s = await getJson(`${api.origin}/__fixture/state`)
        const b = (s.body.bookings as { bookingRef: string; name: string }[]).find((x) => x.bookingRef === body?.bookingRef)
        check('member: booked under the typed full name (not the first name from the code check)', b?.name === 'Dana Whitfield', b?.name)
      }
      await ctx.close()
    }

    // 5b. a verified number without an active membership books as a guest (guest prices, the fee and its terms)
    {
      const { ctx, page, t } = await newPage(browser, proxy.origin)
      trackers.push(t)
      await page.goto(`${proxy.origin}/`, { waitUntil: 'load' })
      await ready(page)
      await page.locator('#dc-root button[aria-label="Menu"]').click()
      await btn(page, /^\s*Book a time\s*$/).click()
      await settle(page)
      await page.locator('#dc-root input[placeholder="Mobile number"]').fill(PHONES.member)
      await btn(page, /^\s*Continue\s*$/).click()
      await page.waitForSelector('#dc-root :text("Enter the code we texted")', { timeout: 20_000 })
      const otp = t.responses.find((r) => r.url.endsWith('/public/otp'))
      const challengeId = otp ? (JSON.parse(otp.body) as { challengeId: string }).challengeId : ''
      await page.locator('#dc-root input[placeholder="123456"]').fill(await codeFor(api, challengeId, PHONES.member))
      await btn(page, /^\s*Verify\s*$/).click()
      await page.waitForSelector('#dc-root :text("Choose your wash")', { timeout: 20_000 })
      const verify = t.responses.find((r) => r.url.endsWith('/public/otp/verify'))
      const active = verify ? (JSON.parse(verify.body) as { member: { active: boolean } }).member.active : null
      const guestPrices = await page.locator('#dc-root :text("guest price")').count()
      const memberPrices = await page.locator('#dc-root :text("1 of 4 this month")').count()
      check('non-member: a verified number without an active membership gets guest prices (the fee applies), not member pricing', active === false && guestPrices >= 1 && memberPrices === 0, `active=${active} guest=${guestPrices} member=${memberPrices}`)
      await ctx.close()
    }

    // 6. a join creates a pending membership
    {
      const { ctx, page, t } = await newPage(browser, proxy.origin)
      trackers.push(t)
      await page.goto(`${proxy.origin}/#/join?gold`, { waitUntil: 'load' })
      await ready(page)
      await btn(page, /^\s*Continue\s*$/).click()
      await page.locator('#dc-root input[placeholder="Year, make, model"]').fill('2021 Tesla Model 3')
      await page.locator('#dc-root input[placeholder="Plate"]').fill('abc123')
      await btn(page, /^\s*Continue\s*$/).click()
      await page.locator('#dc-root input[placeholder="Full name"]').fill('Jo Park')
      await page.locator('#dc-root input[placeholder="Mobile number"]').fill(PHONES.join)
      // the API needs the receipts e-mail: asked for on this step, not refused after the terms
      await btn(page, /^\s*Continue\s*$/).click()
      await settle(page)
      check('join: the details step asks for the e-mail before going on', (await page.locator('#dc-root :text("Add your email for the receipts.")').count()) === 1)
      await page.locator('#dc-root input[placeholder="Email (for receipts)"]').fill('jo@example.com')
      await btn(page, /^\s*Continue\s*$/).click()
      await settle(page)
      check('join: step 4 has no card fields', (await page.locator('#dc-root input[autocomplete^="cc-"]').count()) === 0)
      await btn(page, /^\s*I agree to be billed/).click()
      await btn(page, /^\s*Start Gold/).click()
      await page.waitForSelector('#dc-root :text("checkout link is on its way")', { timeout: 20_000 })
      audits.push({ view: 'join welcome (live)', audit: await auditContacts(page) })
      const resp = t.responses.find((r) => r.url.includes('/public/memberships'))
      const body = resp ? (JSON.parse(resp.body) as Record<string, any>) : null
      check('join: 201 pending_payment, checkout link by sms', resp?.status === 201 && body?.status === 'pending_payment' && body?.next === 'checkout_link_by_sms', resp?.body.slice(0, 200))
      if (api.kind === 'fixture') {
        const s = await getJson(`${api.origin}/__fixture/state`)
        check('join: recorded as a membership', (s.body.memberships as { memberRef: string }[]).some((m) => m.memberRef === body?.memberRef))
      } else {
        const status = psql(api.stack!, `select m.status from T.memberships m join T.customers c on c.id = m.customer_id where c.phone_e164 = '${PHONES.join}' order by m.created_at desc limit 1`)
        check('join: a pending membership row exists for the number', status === 'pending', status)
      }
      await ctx.close()
    }

    // 7. the honeypot creates nothing
    {
      const { ctx, page, t } = await newPage(browser, proxy.origin)
      trackers.push(t)
      await page.goto(`${proxy.origin}/`, { waitUntil: 'load' })
      await ready(page)
      const r = await page.evaluate(
        async ({ date, startMin, key }) => {
          const res = await fetch('/api/v1/public/bookings', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'idempotency-key': key },
            body: JSON.stringify({ name: 'Bot', phone: '+12015550177', vehicle: { label: 'Bot car' }, serviceKey: 'signature-hand-wash', addonKeys: [], date, startMin, smsConsent: true, website: 'http://spam' }),
          })
          return { status: res.status, body: await res.text() }
        },
        { date: bookedDate, startMin: bookedStart, key: crypto.randomUUID() },
      )
      let created = true
      if (api.kind === 'fixture') {
        const s = await getJson(`${api.origin}/__fixture/state`)
        created = (s.body.bookings as { phone: string }[]).some((b) => b.phone === '+12015550177')
      } else {
        created = (await snapshotText(api.stack!, cookie)).includes('Bot car')
      }
      check('honeypot: 202 with a fake reference and no record', r.status === 202 && /OAS-/.test(r.body) && !created, `${r.status} ${r.body.slice(0, 80)}`)
      await ctx.close()
    }

    // 7b. DV-CATALOG: the website's prices come from the catalog (fixture only: the test swaps the API's catalog)
    if (api.kind === 'fixture') {
      const fixture = api.fixture!
      const pageText = (page: Page) => page.evaluate(() => document.getElementById('dc-root')?.innerText ?? '')
      try {
        // a changed price: the Signature wash at $50 for members ($60 for guests), Gold at $109
        fixture.state.catalog = changedCatalog
        const { ctx, page, t } = await newPage(browser, proxy.origin)
        trackers.push(t)
        await page.goto(`${proxy.origin}/#/wash`, { waitUntil: 'load' })
        await ready(page)
        await page.waitForFunction(() => /SAVE \$60/.test(document.getElementById('dc-root')?.innerText ?? ''), null, { timeout: 20_000 }).catch(() => {})
        const wash = await pageText(page)
        check('catalog: a changed price in the API\'s catalog shows on the wash page after the catalog load (live build)', /SAVE \$60/.test(wash), wash.slice(0, 200).replace(/\s+/g, ' '))
        await page.goto(`${proxy.origin}/#/membership`, { waitUntil: 'load' })
        await page.waitForTimeout(800)
        check('catalog: the Gold price follows the catalog on the membership page', /\$109/.test(await pageText(page)))
        await ctx.close()
        // an unseeded catalog (production before the website-catalog seed) over a page whose build snapshot is the
        // changed catalog: the page first shows the snapshot (Signature "SAVE $62"), and the unseeded live answer brings the
        // design's own content back ("SAVE $54"), never the dashboard's list. The catalog request is held until the
        // snapshot was seen.
        fixture.state.catalog = unseededCatalog()
        const catProxy = await startSiteProxy({ dir: catalogDir, apiOrigin: api.origin, port: port + 3 })
        try {
          const u = await newPage(browser, catProxy.origin)
          trackers.push(u.t)
          let release: () => void = () => {}
          const held = new Promise<void>((r) => (release = r))
          let asked = 0
          await u.page.route('**/api/v1/public/catalog*', async (route) => {
            asked++
            await held
            await route.continue()
          })
          await u.page.goto(`${catProxy.origin}/#/wash`, { waitUntil: 'load' })
          await ready(u.page)
          const before = await pageText(u.page)
          release()
          await u.page.waitForFunction(() => !/SAVE \$62/.test(document.getElementById('dc-root')?.innerText ?? ''), null, { timeout: 20_000 }).catch(() => {})
          await u.page.waitForTimeout(500)
          const plain = await pageText(u.page)
          check('catalog: the build snapshot shows before the catalog load (Signature SAVE $62)', asked > 0 && /SAVE \$62/.test(before), `asked=${asked} ${before.slice(0, 160).replace(/\s+/g, ' ')}`)
          check(
            'catalog: an unseeded live catalog brings the built-in services and prices back (no dashboard-internal items)',
            /SAVE \$54/.test(plain) && !/SAVE \$62/.test(plain) && /Hand wax/.test(plain) && /Interior deep clean/.test(plain) && !/Express Hand Wash|Premium Hand Wash/.test(plain),
            plain.slice(0, 200).replace(/\s+/g, ' '),
          )
          await u.ctx.close()
        } finally {
          await catProxy.close()
        }
      } finally {
        fixture.state.catalog = designCatalog()
      }
    } else log('skip catalog price checks (they swap the fixture API\'s catalog)')
    void guestKey
  } finally {
    await proxy.close()
  }

  // 8. sms mode: the buttons produce sms: links with the composed body
  const smsProxy = await startSiteProxy({ dir: smsDir, apiOrigin: api.origin, port: port + 1 })
  try {
    const bookPage = await newPage(browser, smsProxy.origin)
    trackers.push(bookPage.t)
    let page = bookPage.page
    await page.goto(`${smsProxy.origin}/`, { waitUntil: 'load' })
    await ready(page)
    const posts0 = smsProxy.log.filter((l) => l.method === 'POST').length
    await btn(page, /^\s*Book it\s*$/).click()
    await settle(page)
    await btn(page, /Continue as guest/).click()
    await btn(page, /^\s*Review booking/).click()
    await settle(page)
    check('sms mode: guests have no contact fields (nothing to send to an API)', (await page.locator('#dc-root input[placeholder="Full name"]').count()) === 0)
    await btn(page, /^\s*I understand the \$25 booking fee/).click()
    await btn(page, /^\s*Book\s*$/).last().click()
    await settle(page)
    const navs = await navigations(page)
    check('sms mode: Book composes an sms: link to the texting number with the booking', navs.length === 1 && reSms('WASH%20booking%3A').test(navs[0]!), navs[0])
    check('sms mode: the composed text names the wash, the vehicle and the time', /Signature%20Hand%20Wash/.test(navs[0] ?? '') && /Sedan/.test(decodeURIComponent(navs[0] ?? '')) && /(AM|PM)/.test(decodeURIComponent(navs[0] ?? '')), decodeURIComponent(navs[0] ?? ''))
    // the design's own text links (the hero's "Text WASH to …", the footer) live on the home view
    // (the pricing section's quote link comes first in the document: every link must carry the number, and the
    // "Text WASH" links of the 07 section and the footer must be there)
    const hrefs = await page.locator('#dc-root a[href^="sms:"]').evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''))
    check(
      'sms mode: the design\'s own text links carry the texting number',
      hrefs.length > 0 && hrefs.every((h) => h.startsWith(`sms:${SMS_E164}?&body=`)) && hrefs.filter((h) => h === `sms:${SMS_E164}?&body=WASH`).length >= 2,
      hrefs.join(' | '),
    )
    await bookPage.ctx.close()
    // a fresh page for the join flow: the sms: navigation was swallowed by the test hook, so the sheet is still open
    // on the first page and a hash-only goto would keep it (and its CTA) over the join page
    const joinPage = await newPage(browser, smsProxy.origin)
    trackers.push(joinPage.t)
    page = joinPage.page
    await page.goto(`${smsProxy.origin}/#/join`, { waitUntil: 'load' })
    await ready(page)
    await btn(page, /^\s*Continue\s*$/).click()
    await page.locator('#dc-root input[placeholder="Year, make, model"]').fill('2019 Audi Q5')
    await btn(page, /^\s*Continue\s*$/).click()
    await page.locator('#dc-root input[placeholder="Full name"]').fill('Sam Lee')
    await page.locator('#dc-root input[placeholder="Mobile number"]').fill('2015550188')
    await btn(page, /^\s*Continue\s*$/).click()
    await btn(page, /^\s*I agree to be billed/).click()
    await btn(page, /^\s*Start VIP/).click()
    await settle(page)
    const navs2 = await navigations(page)
    check('sms mode: Join composes an sms: link to the texting number with the plan, name, phone and car', navs2.length === 1 && reSms('JOIN%20VIP%3A').test(navs2[0]!) && /Sam%20Lee/.test(navs2[0]!) && /Audi/.test(navs2[0]!), navs2[0])
    check('sms mode: no API write was attempted', smsProxy.log.filter((l) => l.method === 'POST').length === posts0, JSON.stringify(smsProxy.log.filter((l) => l.method === 'POST')))
    await joinPage.ctx.close()
    // 10-21. personal links (DV-LINK…, scripts/e2e-links.ts) on the launch build, against the fixture's link API; a
    // stack gets them once the backend's link API (wave W3c) is in the stack
    if (api.kind === 'fixture') await runLinkChecks({ browser, proxy: smsProxy, api: api.fixture!, newPage, ready, check, trackers })
    else log('links: skipped on a stack (the fixture API carries the link routes until the backend link API is in the stack)')
    // 8b. a visitor in another time zone: the page shows the shop's wall clock and hydrates without a mismatch
    // (DEVIATIONS.md DV-CLOCK; React logs a recoverable error and re-renders on the client otherwise)
    const far = await newPage(browser, smsProxy.origin, 'America/Los_Angeles')
    trackers.push(far.t)
    await far.page.goto(`${smsProxy.origin}/`, { waitUntil: 'load' })
    await ready(far.page)
    await settle(far.page)
    const label = await far.page.evaluate(() => (document.body.innerText.match(/[A-Z]{3} [A-Z]{3} \d{1,2} · \d{1,2}:\d{2} [AP]M/) || [''])[0])
    const shopNow = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hour12: true }).formatToParts(new Date())
    const part = (t: string) => shopNow.find((p) => p.type === t)?.value ?? ''
    const want = new RegExp(`^${part('weekday').toUpperCase()} .* · ${part('hour')}:\\d{2} ${part('dayPeriod').toUpperCase()}$`)
    check('time zone: a visitor in Los Angeles sees the shop clock', want.test(label), `${label} (shop ${part('weekday')} ${part('hour')} ${part('dayPeriod')})`)
    check('time zone: no hydration error in Los Angeles', far.t.errors.length === 0, far.t.errors.slice(0, 2).join(' | '))
    await far.ctx.close()

    // 8c. the theme follows the device until the visitor picks one, which is remembered (DV-THEME)
    {
      const errorsOf = (t: Tracker) => t.errors.filter((e) => !/Failed to load resource/.test(e))
      // device light, nothing stored: light from the first paint (the theme script alone, with the bundle held back)
      const held = await newPage(browser, smsProxy.origin, 'America/New_York', 'light')
      trackers.push(held.t)
      await held.page.route(/\/assets\/page-index\.[0-9a-f]+\.js$/, (r) => r.abort())
      await held.page.goto(`${smsProxy.origin}/`, { waitUntil: 'load' })
      const before = await themeState(held.page)
      check('theme: device light -> light before hydration (the theme script alone, no bundle)', before.attr === 'light' && before.bg === BG.light && before.stored === null, JSON.stringify(before))
      await held.ctx.close()
      held.t.errors.length = 0 // the aborted bundle's load error
      // device light / dark, nothing stored: hydrated in that theme without a hydration error
      for (const scheme of ['light', 'dark'] as const) {
        const d = await newPage(browser, smsProxy.origin, 'America/New_York', scheme)
        trackers.push(d.t)
        await markWrapper(d.page)
        await d.page.goto(`${smsProxy.origin}/`, { waitUntil: 'load' })
        await ready(d.page)
        const st = await themeState(d.page)
        const kept = await adopted(d.page)
        check(`theme: device ${scheme} -> ${scheme} page, nothing stored, hydration adopted the markup without an error`, st.attr === scheme && st.bg === BG[scheme] && st.stored === null && kept && errorsOf(d.t).length === 0, `${JSON.stringify(st)} adopted=${kept} ${errorsOf(d.t).slice(0, 2).join(' | ')}`)
        await d.ctx.close()
      }
      // a live change of the device setting flips the page while nothing is stored, and is not stored
      const live = await newPage(browser, smsProxy.origin, 'America/New_York', 'light')
      trackers.push(live.t)
      await markWrapper(live.page)
      await live.page.goto(`${smsProxy.origin}/`, { waitUntil: 'load' })
      await ready(live.page)
      await live.page.emulateMedia({ colorScheme: 'dark' })
      await settle(live.page)
      const toDark = await themeState(live.page)
      await live.page.emulateMedia({ colorScheme: 'light' })
      await settle(live.page)
      const toLight = await themeState(live.page)
      check('theme: a live device change flips the page while nothing is stored (and is not stored)', toDark.attr === 'dark' && toDark.bg === BG.dark && toLight.attr === 'light' && toLight.bg === BG.light && toLight.stored === null, `${JSON.stringify(toDark)} -> ${JSON.stringify(toLight)}`)
      // the header toggle is stored; it holds over a live device change and a reload on a device that says otherwise
      await live.page.locator('#dc-root button[aria-label="Theme"]').click()
      await settle(live.page)
      const toggled = await themeState(live.page)
      check('theme: the header toggle switches to dark and stores the choice', toggled.attr === 'dark' && toggled.bg === BG.dark && toggled.stored === 'dark', JSON.stringify(toggled))
      await live.page.emulateMedia({ colorScheme: 'dark' })
      await settle(live.page)
      await live.page.emulateMedia({ colorScheme: 'light' })
      await settle(live.page)
      const held2 = await themeState(live.page)
      check('theme: with a stored choice a live device change does nothing', held2.attr === 'dark' && held2.stored === 'dark', JSON.stringify(held2))
      await live.page.reload({ waitUntil: 'load' })
      await ready(live.page)
      const reloaded = await themeState(live.page)
      const liveKept = await adopted(live.page)
      check('theme: after a reload the stored dark wins over the light device, hydration adopted the markup without an error', reloaded.attr === 'dark' && reloaded.bg === BG.dark && liveKept && errorsOf(live.t).length === 0, `${JSON.stringify(reloaded)} adopted=${liveKept} ${errorsOf(live.t).slice(0, 2).join(' | ')}`)
      await live.ctx.close()
      // the menu's Appearance Light on a dark device is stored and wins on the next visit
      const menu = await newPage(browser, smsProxy.origin, 'America/New_York', 'dark')
      trackers.push(menu.t)
      await markWrapper(menu.page)
      await menu.page.goto(`${smsProxy.origin}/`, { waitUntil: 'load' })
      await ready(menu.page)
      await menu.page.locator('#dc-root button[aria-label="Menu"]').click()
      await settle(menu.page)
      await btn(menu.page, /^\s*Light\s*$/).click()
      await settle(menu.page)
      const picked = await themeState(menu.page)
      await menu.page.reload({ waitUntil: 'load' })
      await ready(menu.page)
      const kept = await themeState(menu.page)
      const menuKept = await adopted(menu.page)
      check('theme: menu Appearance Light on a dark device is stored and kept after a reload, hydration adopted the markup without an error', picked.attr === 'light' && picked.stored === 'light' && kept.attr === 'light' && kept.bg === BG.light && menuKept && errorsOf(menu.t).length === 0, `${JSON.stringify(picked)} -> ${JSON.stringify(kept)} adopted=${menuKept} ${errorsOf(menu.t).slice(0, 2).join(' | ')}`)
      await menu.ctx.close()
    }

    // 8d. texting vs calling (DV-CONTACT): every view's sms: links, tel: links and visible numbers
    const tour = await newPage(browser, smsProxy.origin)
    trackers.push(tour.t)
    await tour.page.goto(`${smsProxy.origin}/`, { waitUntil: 'load' })
    await ready(tour.page)
    audits.push({ view: 'home', audit: await auditContacts(tour.page) })
    await tour.page.locator('#dc-root button[aria-label="Menu"]').click()
    await settle(tour.page)
    audits.push({ view: 'menu', audit: await auditContacts(tour.page) })
    await tour.page.locator('#dc-root button[aria-label="Close"]').click()
    for (const view of ['membership', 'wash', 'tint', 'detailing', 'experience', 'visit', 'join']) {
      await tour.page.evaluate((h) => (location.hash = h), `#/${view}`)
      await tour.page.waitForTimeout(400)
      audits.push({ view: `#/${view}`, audit: await auditContacts(tour.page) })
    }
    await tour.ctx.close()
    const allSms = audits.flatMap((a) => a.audit.sms.map((h) => ({ view: a.view, h })))
    const allTel = audits.flatMap((a) => a.audit.tel.map((h) => ({ view: a.view, h })))
    const allTexts = audits.flatMap((a) => a.audit.texts.map((t) => ({ view: a.view, ...t })))
    check('contact: site.config.json texts at 862-388-5827 and calls at 201-598-6304', CONTACT.smsE164 === SMS_E164 && CONTACT.smsDisplay === SMS_DISPLAY && CONTACT.phoneE164 === TEL_E164 && CONTACT.phoneDisplay === TEL_DISPLAY, JSON.stringify(CONTACT))
    const badSms = allSms.filter((x) => !x.h.startsWith(`sms:${SMS_E164}?`) || x.h.includes(TEL_E164.slice(2)))
    check(`contact: every sms: link on every view goes to ${SMS_E164} and none to the old number (${allSms.length} links over ${audits.length} views)`, allSms.length >= 8 && badSms.length === 0, badSms.slice(0, 3).map((x) => `${x.view}: ${x.h}`).join(' | '))
    const badTel = allTel.filter((x) => x.h !== `tel:${TEL_E164}` || x.h.includes(SMS_E164.slice(2)))
    check(`contact: every tel: link goes to ${TEL_E164} and none to the texting number (${allTel.length} links)`, allTel.length >= 2 && badTel.length === 0, badTel.slice(0, 3).map((x) => `${x.view}: ${x.h}`).join(' | '))
    const wanted = ['body=WASH', 'body=Quote%20request', 'body=Tint%20quote', 'body=Hi%2C%20I%20just%20joined']
    const missing = wanted.filter((w) => !allSms.some((x) => x.h.includes(w)))
    check('contact: the Text WASH links, the pricing quote, the tint quote and the member line are all there', missing.length === 0, missing.join(', '))
    const callShown = allTexts.filter((t) => t.text.includes(TEL_DISPLAY))
    check('contact: the calling number is only shown on tel: links', callShown.length > 0 && callShown.every((t) => t.inTel && !t.inSms), callShown.filter((t) => !t.inTel || t.inSms).slice(0, 3).map((t) => `${t.view}: ${t.text}`).join(' | '))
    const textShown = allTexts.filter((t) => t.text.includes(SMS_DISPLAY))
    const textWants = [`Text WASH to ${SMS_DISPLAY}`, `Text ${SMS_DISPLAY}`, `Or text HERE to ${SMS_DISPLAY}.`]
    check(
      'contact: "Text WASH to …", the visit page\'s "Text …" button, the 07 section and the check-in step show the texting number, never on a tel: link',
      textWants.every((w) => textShown.some((t) => t.text.includes(w))) && textShown.every((t) => !t.inTel),
      textShown.map((t) => `${t.view}: ${t.text}`).slice(0, 8).join(' | '),
    )
  } finally {
    await smsProxy.close()
    await browser.close()
    await api.fixture?.close()
  }

  // 9. hygiene over every page
  const errors = trackers.flatMap((t) => t.errors)
  const blocked = trackers.flatMap((t) => t.blocked)
  const fives = trackers.flatMap((t) => t.fiveHundreds)
  check('no console error or page error on any page', errors.length === 0, errors.slice(0, 3).join(' | '))
  check('no external request', blocked.length === 0, blocked.slice(0, 3).join(' | '))
  check('no 5xx', fives.length === 0, fives.slice(0, 3).join(' | '))

  const summary = { api: api.kind, stack: api.stack?.name ?? null, bookingRef: bookedRef, results, ok: failures === 0 }
  fs.mkdirSync(path.join(ROOT, 'parity-reports'), { recursive: true })
  fs.writeFileSync(path.join(ROOT, 'parity-reports', 'e2e-site.json'), JSON.stringify(summary, null, 2) + '\n')
  log(`\ne2e-site ${failures ? 'FAILED' : 'PASSED'}: ${results.length - failures}/${results.length} checks (api ${api.kind})`)
  return failures ? 1 : 0
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e)
    process.exit(1)
  },
)
void spawnSync
