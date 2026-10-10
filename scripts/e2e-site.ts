// e2e-site: the website against a public booking API, end to end in pinned Chromium (docs/e2e.md).
//
//   pnpm e2e:site --api fixture                       the in-process fixture API (tools/site/fixture-api.ts)
//   pnpm e2e:site --stack site [--dashboard ~/oasis/dashboard]   a live stack started with the dashboard's
//                                                     `pnpm live:up --name site --backend <wt> --profile design,demo`
//   options: --port 3301 (the site's host), --skip-build (reuse dist-e2e-live / dist-e2e-sms), --headed
//
// Builds the site twice (SITE_BOOKING=live with the stack's hours and availability baked in, and the launch default
// SITE_BOOKING=sms), serves each through tools/site/proxy.ts (nginx's same-origin /api/v1/public/* mapping) and checks:
// hours and availability render the API's data (Sunday closed); a guest booking creates a real appointment (seen in
// GET /api/v1/ops/snapshot as the seeded manager); the slot turns last/booked on reload; the OTP member path books
// without a fee (the code read from the fixture's texts, or recovered from the stack's challenge hash because the
// simulator delivers the text instantly and delivered one-time codes are redacted); a join creates a pending
// membership; the honeypot creates nothing; no page error, no 5xx, no external request; and in sms mode every
// Book/Join action produces an sms: link with the composed body.
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
import { startSiteProxy, type SiteProxy } from '../tools/site/proxy'
import { ROOT, CHROMIUM_FLAGS } from '../tools/parity/config'

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
  for (const first of ['amara', 'rafael']) {
    const r = await fetch(`${stack.apiUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: stack.webUrl },
      body: JSON.stringify({ email: `${first}@oasisautospa.com`, password: stack.devPassword }),
    })
    if (!r.ok) continue
    const cookie = r.headers.getSetCookie?.().map((c) => c.split(';')[0]).join('; ') ?? ''
    const cur = await getJson(`${stack.apiUrl}/api/v1/settings/hours`, { headers: { cookie } })
    if (cur.status !== 200) continue
    const days = cur.body.days as { weekday: number; open: boolean; from: string; to: string }[]
    const sunday = days.find((d) => d.weekday === 0)
    if (sunday && !sunday.open) return 'Sunday was already closed in the stack Settings'
    const put = await getJson(`${stack.apiUrl}/api/v1/settings/hours`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie, origin: stack.webUrl, 'if-match': `"${cur.body.version}"` },
      body: JSON.stringify({
        version: cur.body.version,
        days: days.map((d) => ({ weekday: d.weekday, open: d.weekday === 0 ? false : d.open, from: d.from, to: d.to })),
      }),
    })
    if (put.status === 200) return `Sunday set closed through PUT /settings/hours as ${first} (version ${cur.body.version} -> ${put.body.version})`
    if (put.status !== 403) throw new Error(`PUT /settings/hours as ${first}: ${put.status} ${JSON.stringify(put.body).slice(0, 200)}`)
  }
  throw new Error('no seeded user could set Sunday closed through the Settings API')
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

async function newPage(browser: Browser, origin: string): Promise<{ ctx: BrowserContext; page: Page; t: Tracker }> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, timezoneId: 'America/New_York', locale: 'en-US' })
  const t: Tracker = { errors: [], blocked: [], fiveHundreds: [], navigations: [], responses: [] }
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url())
    if (u.origin === origin || u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return route.continue()
    t.blocked.push(route.request().url())
    return route.abort()
  })
  await ctx.addInitScript(`window.__oasisNavigate = function (u) { (window.__oasisNavigations = window.__oasisNavigations || []).push(u) }`)
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
  const liveDir = path.join(ROOT, 'dist-e2e-live')
  const smsDir = path.join(ROOT, 'dist-e2e-sms')
  if (!values['skip-build'] || !fs.existsSync(path.join(liveDir, 'index.html'))) {
    await buildSite({ root: ROOT, variant: 'prod', outDir: liveDir, hoursJson: JSON.stringify(hours.body), availabilityJson: JSON.stringify(avail0.body), booking: 'live', apiOrigin: '', log: () => {} })
    await buildSite({ root: ROOT, variant: 'prod', outDir: smsDir, hoursJson: JSON.stringify(hours.body), availabilityJson: null, booking: 'sms', apiOrigin: '', log: () => {} })
    log('built dist-e2e-live and dist-e2e-sms')
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
          if (d.label === when[1] && slot) {
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
      // board rows: flap cells are separate spans, so Playwright sees "11:30AMOPEN" (no space before AM/PM)
      const rows = await page.locator('#dc-root button').filter({ hasText: /^\d+:\d\d(AM|PM)(OPEN|LAST 1|VIP|BOOKED)/ }).allInnerTexts()
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
      await page.locator('#dc-root input[placeholder="Email (for receipts)"]').fill('jo@example.com')
      await btn(page, /^\s*Continue\s*$/).click()
      await settle(page)
      check('join: step 4 has no card fields', (await page.locator('#dc-root input[autocomplete^="cc-"]').count()) === 0)
      await btn(page, /^\s*I agree to be billed/).click()
      await btn(page, /^\s*Start Gold/).click()
      await page.waitForSelector('#dc-root :text("checkout link is on its way")', { timeout: 20_000 })
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
    void guestKey
  } finally {
    await proxy.close()
  }

  // 8. sms mode: the buttons produce sms: links with the composed body
  const smsProxy = await startSiteProxy({ dir: smsDir, apiOrigin: api.origin, port: port + 1 })
  try {
    const { ctx, page, t } = await newPage(browser, smsProxy.origin)
    trackers.push(t)
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
    check('sms mode: Book composes an sms: link with the booking', navs.length === 1 && /^sms:\+12015986304\?&body=WASH%20booking%3A/.test(navs[0]!), navs[0])
    check('sms mode: the composed text names the wash, the vehicle and the time', /Signature%20Hand%20Wash/.test(navs[0] ?? '') && /Sedan/.test(decodeURIComponent(navs[0] ?? '')) && /(AM|PM)/.test(decodeURIComponent(navs[0] ?? '')), decodeURIComponent(navs[0] ?? ''))
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
    check('sms mode: Join composes an sms: link with the plan, name, phone and car', navs2.length === 1 && /^sms:\+12015986304\?&body=JOIN%20VIP%3A/.test(navs2[0]!) && /Sam%20Lee/.test(navs2[0]!) && /Audi/.test(navs2[0]!), navs2[0])
    const href = await page.locator('#dc-root a[href^="sms:"]').first().getAttribute('href')
    check('sms mode: the design\'s own text links keep the configured number', href === 'sms:+12015986304?&body=WASH', href ?? '')
    check('sms mode: no API write was attempted', smsProxy.log.filter((l) => l.method === 'POST').length === posts0, JSON.stringify(smsProxy.log.filter((l) => l.method === 'POST')))
    await ctx.close()
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
