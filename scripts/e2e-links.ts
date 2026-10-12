// e2e: personal links (DEVIATIONS.md DV-LINK, DV-STEPUP, DV-LINK-JOIN, DV-LINK-PAY, DV-LINK-DEAD; backend design
// docs/design/ai-assistant-and-phone-identity.md section 7, checks 10-21; wave Q3, ADR 0171: checks 22-26, the card page,
// a membership billed by Square, Square's checkout, the deposit and #/paid), run by scripts/e2e-site.ts on the launch build
// (SITE_BOOKING=sms: links work in either booking mode) against a link API through a LinkDriver (tools/site/link-driver.ts):
// the fixture's link routes (tools/site/fixture-links.ts) or a live stack's real backend (tools/site/stack-links.ts: links
// issued with the backend's issueClientLink and texted through its queue, codes read from the stack's outbox). Every page
// here is served with the production Content-Security-Policy of the site (the deploy kit's install.sh SITE_CSP, minus
// upgrade-insecure-requests, which would send the plain-http test host's assets to https), every request the browser
// makes is recorded (URL, headers, body) to prove where the token travels, and every 2xx answer of the link API is held
// to the contract the page is written to (src/site/link-contract.testkit.ts).
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Browser, BrowserContext, Page, Request } from '@playwright/test'
import type { LinkDriver, IssueLinkInput } from '../tools/site/link-driver'
import type { SiteProxy } from '../tools/site/proxy'
import { money, shopDate } from '../src/site/links'
import {
  BOOKING_RESULT_KEYS,
  CARD_REMOVE_RESULT_KEYS,
  CARD_SAVE_RESULT_KEYS,
  CODE_REQUESTED_KEYS,
  DEPOSIT_RESULT_KEYS,
  ENROLLMENT_STATUS_KEYS,
  keyProblems,
  linkStateProblems,
  MEMBERSHIP_RESULT_KEYS,
  PAY_RESULT_KEYS,
} from '../src/site/link-contract.testkit'

/**
 * install.sh SITE_CSP (backend deploy kit, the production policy with Square's Web Payments SDK hosts since wave Q3a) without
 * upgrade-insecure-requests (the e2e host is plain http). The SDK itself is the fixture's stub, served same-origin.
 */
export const SITE_CSP =
  "default-src 'none'; script-src 'self' https://web.squarecdn.com; style-src 'self' 'unsafe-inline' https://web.squarecdn.com; img-src 'self' data:; font-src 'self' https://square-fonts-production-f.squarecdn.com https://d1g145x70srn7h.cloudfront.net; connect-src 'self' https://web.squarecdn.com https://pci-connect.squareup.com https://o160250.ingest.sentry.io; frame-src https://web.squarecdn.com; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"

export interface LinkTracker {
  errors: string[]
  blocked: string[]
  fiveHundreds: string[]
  navigations: string[]
  responses: { url: string; status: number; body: string }[]
}

export interface LinkDeps {
  browser: Browser
  /** the site's host (the proxy in front of dist and the link API) */
  proxy: SiteProxy
  links: LinkDriver
  newPage: (browser: Browser, origin: string) => Promise<{ ctx: BrowserContext; page: Page; t: LinkTracker }>
  ready: (page: Page) => Promise<void>
  check: (name: string, ok: boolean, note?: string) => void
  trackers: LinkTracker[]
}

interface Seen {
  method: string
  url: string
  headers: Record<string, string>
  body: string
}

const SMS_E164 = '+18623885827'
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const STATUS_TEXT: Record<number, string> = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 410: 'Gone', 422: 'Unprocessable Entity', 423: 'Locked', 429: 'Too Many Requests' }
const CHECKOUT = 'https://oasis-auto-spa.squarespace.com/checkout/subscribe?plan=gold'
const PAY_URL = 'https://oasis-auto-spa.squarespace.com/pay/inv-20611'
// the API's shapes (backend docs/api-spec.md 28.2): an invoice number is the dashboard's invoice_no, a plan has its tier.
// The fixture serves this invoice; a stack books a real visit for the client and serves that visit's invoice.
const INVOICE = { number: 20611, date: '2026-10-09', items: [{ name: 'Signature Hand Wash', priceCents: 5000 }], taxCents: 400 }

export async function runLinkChecks(d: LinkDeps): Promise<void> {
  const { browser, proxy, links: L, check } = d
  const origin = proxy.origin
  const seenAll: Seen[] = []
  const cspAll: string[] = []
  const expectedAll: string[] = []
  const tokens: string[] = []
  /** when the pages asked for an exchange (a live API's per-minute limit) */
  const exchangeTimes: number[] = []
  /** every 2xx answer of the link API over the run, to hold it to the contract (src/site/link-contract.testkit.ts) */
  const replies: { route: string; body: Record<string, unknown> }[] = []
  /** the link API's answers over the run (method, path, status; the problem of a 4xx/5xx), for a failure's message */
  const trail: string[] = []
  const issue = async (i: IssueLinkInput) => {
    const r = await L.issue(i, origin)
    tokens.push(r.token)
    return r
  }

  /** A page that records every request, carries the production CSP, and reports CSP violations. */
  async function open(at = origin): Promise<{ ctx: BrowserContext; page: Page; t: LinkTracker; seen: Seen[]; exchanges: string[]; answers: any[]; statuses: { url: string; status: number }[]; close: () => Promise<void> }> {
    const { ctx, page, t } = await d.newPage(browser, at)
    d.trackers.push(t)
    const seen: Seen[] = []
    const exchanges: string[] = []
    /** every exchange answer without its session (what the API showed the page) and every link API status */
    const answers: any[] = []
    const statuses: { url: string; status: number }[] = []
    // the link API's documented 4xx answers (a dead link, a wrong PIN, links switched off) are logged by Chromium as
    // "Failed to load resource: … status of 4xx": expected here, every other console line still counts
    const expected: number[] = []
    page.on('response', (r) => {
      if (r.url().includes('/api/v1/public/links/')) statuses.push({ url: r.url(), status: r.status() })
      if (r.url().includes('/api/v1/public/links/') && r.status() >= 400 && r.status() < 500) expected.push(r.status())
    })
    const close = async () => {
      for (const status of expected) {
        const i = t.errors.findIndex((e) => e === `Failed to load resource: the server responded with a status of ${status} (${STATUS_TEXT[status] ?? ''})` || (e.startsWith('Failed to load resource') && e.includes(`status of ${status} `)))
        if (i >= 0) expectedAll.push(t.errors.splice(i, 1)[0]!)
      }
      await ctx.close()
    }
    page.on('request', (r: Request) => {
      if (r.url().endsWith('/api/v1/public/links/exchange')) exchangeTimes.push(Date.now())
      const s = { method: r.method(), url: r.url(), headers: r.headers(), body: r.postData() ?? '' }
      seen.push(s)
      seenAll.push(s)
    })
    page.on('response', async (r) => {
      const m = /\/api\/v1\/public\/links(\/[^?]*)/.exec(r.url())
      if (m && r.status() >= 400) {
        const problem = await r.text().catch(() => '')
        trail.push(`${r.request().method()} ${m[1]} ${r.status()} ${problem.slice(0, 240)}`)
      } else if (m) trail.push(`${r.request().method()} ${m[1]} ${r.status()}`)
      if (!m || r.status() < 200 || r.status() >= 300) return
      try {
        const body = (await r.json()) as Record<string, unknown>
        replies.push({ route: `${r.request().method()} ${m[1]!.replace(/\/appointments\/[^/]+\//, '/appointments/:ref/').replace(/\/cards\/[^/]+$/, '/cards/:id')}`, body })
        if (m[1] === '/exchange') {
          const { session, ...rest } = body
          exchanges.push(String(session ?? ''))
          answers.push(rest)
        }
      } catch {
        /* gone, or not JSON */
      }
    })
    await page.route('**/*', async (route) => {
      const req = route.request()
      if (req.resourceType() === 'document' && new URL(req.url()).origin === at) {
        const resp = await route.fetch()
        return route.fulfill({ response: resp, headers: { ...resp.headers(), 'content-security-policy': SITE_CSP } })
      }
      return route.fallback()
    })
    await page.addInitScript(() => {
      ;(window as any).__csp = []
      document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective} ${e.blockedURI}`))
    })
    return { ctx, page, t, seen, exchanges, answers, statuses, close }
  }
  const go = async (page: Page, url: string) => {
    // a live API allows so many exchanges a minute from one address: the run opens links faster than any person
    if (L.exchangesPerMinute && /#\/(c|m|p|pin|v)\//.test(url))
      while (exchangeTimes.filter((x) => Date.now() - x < 61_000).length >= L.exchangesPerMinute - 5) await new Promise((r) => setTimeout(r, 1000))
    await page.goto(url, { waitUntil: 'load' })
    await d.ready(page)
  }
  const csp = async (page: Page) => {
    const v = (await page.evaluate(() => (window as any).__csp ?? []).catch(() => [])) as string[]
    cspAll.push(...v)
  }
  const btn = (page: Page, re: RegExp) => page.locator('#dc-root button').filter({ hasText: re })
  const text = (page: Page, s: string) => page.locator('#dc-root').getByText(s, { exact: false })
  const waitText = async (page: Page, s: string, timeout = 15_000) => {
    try {
      await text(page, s).first().waitFor({ state: 'visible', timeout })
    } catch (e) {
      const shown = (await page.locator('#dc-root').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(-400)
      throw new Error(`"${s}" never showed; the page ends with: ${shown}\nlast link API answers:\n  ${trail.slice(-6).join('\n  ')}\n${e instanceof Error ? e.message.split('\n')[0] : e}`)
    }
  }
  /** waits for the page's exchange answer to be read (the response listener reads its body asynchronously) */
  const answered = async (answers: unknown[]) => {
    for (let i = 0; i < 100 && answers.length === 0; i++) await new Promise((r) => setTimeout(r, 100))
  }
  const navs = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__oasisNavigations ?? [])
  /** The sheet's way to a time: "Choose a time" -> the first open slot -> "Review · …". */
  const pickTime = async (page: Page) => {
    await btn(page, /^\s*Choose a time/).click()
    await page.waitForTimeout(250)
    const slot = page.locator('#dc-root button').filter({ hasText: /^\d+:\d\d (AM|PM)\s*(OPEN|LAST BAY)$/ }).first()
    await slot.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await slot.click()
    await btn(page, /^\s*Review · /).click()
    await page.waitForTimeout(250)
  }
  const enterCode = async (page: Page, phone: string) => {
    await btn(page, /^\s*Text me a code\s*$/).click()
    await page.locator('#dc-root input[placeholder="6-digit code"]').waitFor({ timeout: 15_000 })
    await page.locator('#dc-root input[placeholder="6-digit code"]').fill(await L.lastCode(phone))
    await btn(page, /^\s*Verify\s*$/).click()
  }

  // 10 + 11. the token: scrubbed before hydration, only ever in the exchange body; 12a. a trusted number books at once
  {
    const A = await issue({ kind: 'calendar', phone: '+12015550161', firstName: 'Maria', tier: 'gold', trusted: true })
    const { page, seen, close } = await open()
    // the address bar right after the parser is done, before the bundle hydrates (deferred module script)
    await page.addInitScript(() => {
      document.addEventListener('readystatechange', () => {
        if (document.readyState === 'interactive') (window as any).__hrefAtParse = location.href
      })
    })
    await go(page, `${origin}/#/c/${A.token}`)
    await waitText(page, 'BOOKING FOR MARIA ••61')
    const st = await page.evaluate((tok) => ({
      href: location.href,
      hash: location.hash,
      dom: document.documentElement.outerHTML.includes(tok),
      ls: JSON.stringify({ ...localStorage }).includes(tok),
      ss: JSON.stringify({ ...sessionStorage }).includes(tok),
      cookie: document.cookie.includes(tok),
      title: document.title.includes(tok),
    }), A.token)
    check('links 11: the token is scrubbed from the address bar (and never in the DOM, storage or cookies)', !st.href.includes(A.token) && st.hash === '' && !st.dom && !st.ls && !st.ss && !st.cookie && !st.title, JSON.stringify({ ...st, href: st.href.replace(A.token, '<token>') }))
    // the history entry: go elsewhere in the page and come back, the entry has no token
    await page.evaluate(() => (location.hash = '#/visit'))
    await page.waitForTimeout(300)
    await page.goBack()
    await page.waitForTimeout(300)
    const back = await page.evaluate(() => location.href)
    check('links 11: the history entry was replaced (back leads to the scrubbed URL)', !back.includes(A.token) && /\/$/.test(back), back.replace(A.token, '<token>'))
    const withToken = seen.filter((s) => s.url.includes(A.token) || JSON.stringify(s.headers).includes(A.token) || s.body.includes(A.token))
    const onlyExchange = withToken.every((s) => s.method === 'POST' && s.url.endsWith('/api/v1/public/links/exchange') && !s.url.includes(A.token) && !JSON.stringify(s.headers).includes(A.token) && JSON.parse(s.body).token === A.token)
    check('links 10: the token is sent only in the exchange POST body (no URL, header, Referer or other body)', withToken.length >= 1 && onlyExchange, withToken.map((s) => `${s.method} ${s.url.replace(A.token, '<token>')}`).join(' | '))
    const logged = await L.tokenSightings([A.token])
    const proxied = proxy.log.filter((l) => l.path.includes(A.token))
    check(
      `links 10: the API and the site host never saw the token outside the exchange body (${L.name === 'stack' ? 'server log, every row of the schema' : 'request log'}, host paths)`,
      logged.length === 0 && proxied.length === 0,
      `${logged.join('; ') || '0 api'}, ${proxied.length} host`,
    )
    // the trusted member books in the sheet without any step-up
    await go(page, `${origin}/`) // a reload: the link is gone from memory too
    const opened = await text(page, 'BOOKING FOR').count()
    check('links 11: a reload does not reopen the link (the token lived in memory only)', opened === 0)
    await close()

    const B = await issue({ kind: 'calendar', phone: '+12015550161', firstName: 'Maria', tier: 'gold', trusted: true })
    const p2 = await open()
    await go(p2.page, `${origin}/#/c/${B.token}`)
    await waitText(p2.page, 'BOOKING FOR MARIA ••61')
    await pickTime(p2.page)
    await btn(p2.page, /^\s*Confirm booking/).click()
    await waitText(p2.page, 'You\'re booked')
    const done = await p2.page.locator('#dc-root').innerText()
    const steps = p2.seen.filter((s) => /\/links\/verify\//.test(s.url))
    const booked = await L.bookings('+12015550161')
    const ref = /Ref (OAS-[0-9A-Z-]+)/.exec(done)?.[1]
    check('links 12: a trusted number (verified in the last 30 days) books without a PIN or code', steps.length === 0 && booked === 1 && !!ref, `${steps.length} step-up calls, ${booked} booking(s), ${ref}`)
    const av = p2.seen.filter((s) => s.url.includes('/api/v1/public/links/availability'))
    check('links 12: the sheet shows the client\'s own board (link availability with the session, never the public one)', av.length > 0 && av.every((s) => /^Bearer \S+$/.test(s.headers.authorization ?? '')), `${av.length} calls`)
    await csp(p2.page)
    await p2.close()
  }

  // 12b + 13. not trusted: Book asks for a texted code, then books; the number is trusted afterwards
  {
    const phone = '+12015550162'
    const A = await issue({ kind: 'calendar', phone, firstName: 'Jose', tier: null })
    const { page, seen, close } = await open()
    await go(page, `${origin}/#/c/${A.token}`)
    await waitText(page, 'BOOKING FOR JOSE ••62')
    await pickTime(page)
    await btn(page, /^\s*I understand the \$25 booking fee/).click()
    await btn(page, /^\s*Book\s*$/).last().click()
    await waitText(page, 'Text me a code')
    const before = await L.bookings(phone)
    check('links 12: a number without trust is asked to confirm before the booking (no booking yet)', before === 0)
    await enterCode(page, phone)
    await waitText(page, 'You\'re booked')
    const codeReq = seen.find((s) => s.url.endsWith('/links/verify/code'))
    const afterBooked = await L.bookings(phone)
    const afterTrusted = await L.trusted(phone)
    check('links 13: the texted code went to the link\'s number (the request carries no phone), then the booking went through', !!codeReq && !/phone/.test(codeReq.body) && afterBooked === 1 && afterTrusted, `${codeReq?.body} ${afterBooked} booking(s), trusted ${afterTrusted}`)
    await csp(page)
    await close()
    const B = await issue({ kind: 'calendar', phone, firstName: 'Jose', tier: null })
    const p2 = await open()
    await go(p2.page, `${origin}/#/c/${B.token}`)
    await waitText(p2.page, 'BOOKING FOR JOSE ••62')
    await pickTime(p2.page)
    await btn(p2.page, /^\s*I understand the \$25 booking fee/).click()
    await btn(p2.page, /^\s*Book\s*$/).last().click()
    await waitText(p2.page, 'You\'re booked')
    check('links 12: inside the trust window a new link for that number books without a code', p2.seen.filter((s) => /\/links\/verify\//.test(s.url)).length === 0)
    await csp(p2.page)
    await p2.close()
  }

  // 13. a verify link: code -> "You're verified" -> an optional PIN
  {
    const phone = '+12015550163'
    const V = await issue({ kind: 'verify', phone, firstName: 'Ana' })
    const { page, close } = await open()
    await go(page, `${origin}/#/v/${V.token}`)
    await waitText(page, 'Confirm it’s you')
    await enterCode(page, phone)
    await waitText(page, 'You’re verified')
    const note = await page.locator('#dc-root').innerText()
    check('links 13: a verify link ends on "You\'re verified" with the trust date', /verified until [A-Z][a-z]{2} \d{1,2}/.test(note), note.split('\n').find((x) => x.includes('verified')))
    await btn(page, /Create a PIN for next time/).click()
    await page.locator('#dc-root input[placeholder="New PIN"]').fill('1234')
    await btn(page, /^\s*Save\s*$/).click()
    await waitText(page, 'Don’t use digits in a row like 1234.')
    await page.locator('#dc-root input[placeholder="New PIN"]').fill('4826')
    await btn(page, /^\s*Save\s*$/).click()
    await waitText(page, 'Your PIN is set')
    check('links 13: a PIN can be created after the code (an easy one is refused with the reason)', await L.pinIs(phone, '4826'))
    await csp(page)
    await close()
  }

  // 14. the PIN lockout: the fifth wrong PIN of a page ends that page (the API's IDENTITY_SESSION_LOCKED: "Too many tries")
  // and locks the PIN for 15 minutes; the link opened again shows the lockout (even the right PIN is refused), the PIN
  // field goes and the reset by code stays
  {
    const phone = '+12015550164'
    const V = await issue({ kind: 'verify', phone, firstName: 'Lena', pin: '7391' })
    const { page, close } = await open()
    await go(page, `${origin}/#/v/${V.token}`)
    await page.locator('#dc-root input[placeholder="PIN"]').waitFor({ timeout: 15_000 })
    for (let i = 0; i < 5; i++) {
      await page.locator('#dc-root input[placeholder="PIN"]').fill('1111')
      await btn(page, /^\s*Verify\s*$/).click()
      await page.waitForTimeout(300)
    }
    await waitText(page, 'Too many wrong tries on this page')
    const sms = await page.locator('#dc-root a[href^="sms:"]').filter({ hasText: 'Text us for a new link' }).getAttribute('href').catch(() => null)
    check('links 14: the fifth wrong PIN of a page ends it ("Too many tries", a text-us link)', String(sms).startsWith(`sms:${SMS_E164}?&body=`), String(sms))
    await csp(page)
    await close()
    const again = await open()
    await go(again.page, `${origin}/#/v/${V.token}`)
    await again.page.locator('#dc-root input[placeholder="PIN"]').waitFor({ timeout: 15_000 })
    await again.page.locator('#dc-root input[placeholder="PIN"]').fill('7391')
    await btn(again.page, /^\s*Verify\s*$/).click()
    await waitText(again.page, 'Too many wrong PINs. Try again in 15 min')
    const fields = await again.page.locator('#dc-root input[placeholder="PIN"]').count()
    const reset = await btn(again.page, /Forgot your PIN\? Text me a code/).count()
    check('links 14: five wrong PINs lock the PIN: the link opened again shows the lockout text (even for the right PIN), the PIN field goes and the reset by code stays', fields === 0 && reset === 1, `fields ${fields}, reset ${reset}`)
    await csp(again.page)
    await again.close()
  }

  // 15. membership: plan -> verify -> e-mail -> terms -> the Squarespace checkout; a pending membership + checkout intent
  {
    const phone = '+12015550165'
    const M = await issue({ kind: 'membership', phone, firstName: 'Sam', plan: { tier: 'gold', planKey: L.planKey('gold'), name: 'Gold', monthlyPriceCents: 9900, perks: ['Unlimited washes'], checkoutUrl: CHECKOUT } })
    const { page, close } = await open()
    await go(page, `${origin}/#/m/${M.token}`)
    await waitText(page, 'STEP 1 OF 4')
    const hash = await page.evaluate(() => location.hash)
    await btn(page, /^\s*Continue\s*$/).click()
    await waitText(page, 'CONFIRM IT’S YOU')
    await enterCode(page, phone)
    await waitText(page, 'Joining as')
    await page.locator('#dc-root input[placeholder="Email (for receipts)"]').fill('sam@example.com')
    await btn(page, /^\s*Continue\s*$/).click()
    await btn(page, /^\s*I agree to be billed/).click()
    await btn(page, /^\s*Continue to checkout/).click()
    await page.waitForTimeout(800)
    const n = await navs(page)
    const m = await L.membership(phone)
    check('links 15: the membership link opens the join steps for its plan (the token scrubbed: #/join?gold)', hash === '#/join?gold', hash)
    check('links 15: after a fresh code and the e-mail, the page goes to the plan\'s Squarespace checkout', n.length === 1 && n[0] === CHECKOUT, n.join(' | '))
    check('links 15: a pending membership and a checkout intent with the confirmed e-mail exist', m?.state === 'pending' && m.expectedEmail === 'sam@example.com' && m.planKey === L.planKey('gold'), JSON.stringify(m))
    await csp(page)
    await close()
  }

  // 16. payment: review -> PIN -> the invoice's Squarespace link; a URL off the allowlist is not followed
  {
    const phone = '+12015550166'
    const P = await issue({ kind: 'pay', phone, firstName: 'Ravi', pin: '7391', invoice: { ...INVOICE, url: PAY_URL } })
    const { page, answers, close } = await open()
    await go(page, `${origin}/#/p/${P.token}`)
    await answered(answers)
    // what the API answered for this invoice (the fixture's INVOICE, or the stack's real invoice of the visit booked for Ravi)
    const inv = answers[0]?.invoice as { number: number; date: string; items: { name: string }[]; taxCents: number; balanceCents: number } | undefined
    await waitText(page, `Invoice #${inv?.number ?? '?'}`)
    const review = await page.locator('#dc-root').innerText()
    const due = money(inv?.balanceCents ?? 0)
    const reviewOk =
      !!inv &&
      /PAYMENT FOR RAVI ••66/.test(review) &&
      review.includes(shopDate(inv.date)) &&
      inv.items.length > 0 &&
      inv.items.every((x) => review.includes(x.name)) &&
      (inv.taxCents === 0 || /Tax/.test(review)) &&
      /Balance due/.test(review) &&
      review.includes(due) &&
      inv.balanceCents > 0
    await btn(page, new RegExp(`^\\s*Verify & pay ${esc(due)}`)).click()
    await page.locator('#dc-root input[placeholder="PIN"]').fill('7391')
    await btn(page, /^\s*Verify\s*$/).click()
    await page.waitForTimeout(800)
    const n = await navs(page)
    check(`links 16: the payment review shows the invoice the API answered (#${inv?.number}, ${inv ? shopDate(inv.date) : ''}, ${inv?.items.map((x) => x.name).join(', ')}), its tax and the balance ${due}`, reviewOk, review.slice(Math.max(0, review.indexOf('PAYMENT FOR'))).replace(/\s+/g, ' ').slice(0, 300))
    check('links 16: after a fresh PIN the page goes to the invoice\'s Squarespace payment link', n.length === 1 && n[0] === PAY_URL, n.join(' | '))
    await csp(page)
    await close()

    const phone2 = '+12015550167'
    const Q = await issue({ kind: 'pay', phone: phone2, firstName: 'Ravi', pin: '7391', invoice: { ...INVOICE, url: 'https://pay.evil.example/inv-20611' } })
    const p2 = await open()
    await go(p2.page, `${origin}/#/p/${Q.token}`)
    await answered(p2.answers)
    const inv2 = p2.answers[0]?.invoice as { number: number; balanceCents: number } | undefined
    await waitText(p2.page, `Invoice #${inv2?.number ?? '?'}`)
    await btn(p2.page, new RegExp(`^\\s*Verify & pay ${esc(money(inv2?.balanceCents ?? 0))}`)).click()
    await p2.page.locator('#dc-root input[placeholder="PIN"]').fill('7391')
    await btn(p2.page, /^\s*Verify\s*$/).click()
    if (L.serverChecksPayHost) {
      // the real API never hands out a URL off PAYMENT_LINK_HOSTS: {status: link_pending}, and the managers are asked to text one
      await waitText(p2.page, 'We’ll text you a link')
      const n2 = await navs(p2.page)
      const asked = await L.payLinkRequested(phone2)
      check('links 16: a payment URL off the allowlist (not squarespace.com) is not followed (the API answers link_pending, the page says a link will be texted, the managers are asked)', n2.length === 0 && asked, `${n2.join(' | ')} managers asked: ${asked}`)
    } else {
      await waitText(p2.page, 'We couldn’t open the payment page')
      const n2 = await navs(p2.page)
      const sms = await p2.page.locator('#dc-root a[href^="sms:"]').filter({ hasText: 'Text us for a new link' }).getAttribute('href')
      check('links 16: a payment URL off the allowlist (not squarespace.com) is not followed', n2.length === 0 && String(sms).startsWith(`sms:${SMS_E164}?&body=`), `${n2.join(' | ')} ${sms}`)
    }
    await csp(p2.page)
    await p2.close()
  }

  // 17. dead links
  {
    // (revoked: a newer link of the same kind to the same number replaced it, the way the shop's next text does)
    const cases: [string, IssueLinkInput | null, string][] = [
      ['expired', { kind: 'calendar', phone: '+12015550170', expired: true }, 'This link expired'],
      ['used', { kind: 'verify', phone: '+12015550171', used: true }, 'This link was used'],
      ['revoked', { kind: 'calendar', phone: '+12015550172', revoked: true }, 'This link was replaced'],
      ['unknown', null, 'This link doesn’t work'],
    ]
    for (const [name, input, title] of cases) {
      const tok = input ? (await issue(input)).token : 'VW5rbm93bkxpbmtUb2tlbi0zMi1ieXRlcy1iYXNlNjR1cmw'
      const { page, close } = await open()
      await go(page, `${origin}/#/c/${tok}`)
      let ok = true
      try {
        await waitText(page, title)
      } catch {
        ok = false
      }
      const href = await page.locator('#dc-root a[href^="sms:"]').filter({ hasText: 'Text us for a new link' }).getAttribute('href').catch(() => null)
      check(`links 17: a ${name} link shows "${title}" and a text-us link to the texting number`, ok && String(href).startsWith(`sms:${SMS_E164}?&body=`), String(href))
      await csp(page)
      await close()
    }
  }

  // 18. a link preview (an SMS app fetching the URL) does not consume it; opening does not either; completing does
  {
    const phone = '+12015550173'
    const C = await issue({ kind: 'calendar', phone, firstName: 'Kim', tier: 'gold', trusted: true })
    // every API request of the site goes through its host (the proxy): a preview that reached the API would be in its log
    const logBefore = proxy.log.length
    const preview = await fetch(`${origin}/#/c/${C.token}`, { headers: { 'user-agent': 'facebookexternalhit/1.1' } })
    const html = await preview.text()
    const usesOf = async () => (await L.usage(phone)) ?? { uses: -1, exchanges: -1 }
    check('links 18: a link preview gets the static home page and reaches no API (the fragment never leaves the device)', preview.status === 200 && html.includes('Oasis Auto Spa') && proxy.log.length === logBefore && !proxy.log.some((l) => l.path.includes(C.token)))
    for (let i = 0; i < 2; i++) {
      const { page, close } = await open()
      await go(page, `${origin}/#/c/${C.token}`)
      await waitText(page, 'BOOKING FOR KIM ••73')
      await close()
    }
    const opened = await usesOf()
    check('links 18: opening the link twice uses nothing (2 exchanges, 0 uses)', opened.uses === 0 && opened.exchanges === 2, JSON.stringify(opened))
    const { page, close } = await open()
    await go(page, `${origin}/#/c/${C.token}`)
    await waitText(page, 'BOOKING FOR KIM ••73')
    await pickTime(page)
    await btn(page, /^\s*Confirm booking/).click()
    await waitText(page, 'You\'re booked')
    const completed = await usesOf()
    check('links 18: completing (a booking) uses the link once', completed.uses === 1, JSON.stringify(completed))
    await csp(page)
    await close()
  }

  // 20. a second link in the same tab replaces the first
  {
    const A = await issue({ kind: 'calendar', phone: '+12015550174', firstName: 'Maria', trusted: true })
    const B = await issue({ kind: 'calendar', phone: '+12015550175', firstName: 'Jose', trusted: true })
    const { page, seen, exchanges, close } = await open()
    await go(page, `${origin}/#/c/${A.token}`)
    await waitText(page, 'BOOKING FOR MARIA ••74')
    await page.evaluate((tok) => (location.hash = '#/c/' + tok), B.token)
    await waitText(page, 'BOOKING FOR JOSE ••75')
    await page.waitForTimeout(500)
    const href = await page.evaluate(() => location.href)
    const avail = seen.filter((s) => s.url.includes('/links/availability'))
    const last = avail[avail.length - 1]
    check('links 20: a second link in the same tab is exchanged and scrubbed, and the page then uses its session', exchanges.length === 2 && !href.includes(B.token) && last?.headers.authorization === `Bearer ${exchanges[1]}` && exchanges[0] !== exchanges[1], `${exchanges.length} exchanges, ${href.replace(B.token, '<token>')}`)
    await csp(page)
    await close()
  }

  // 22-26. wave Q3 (ADR 0171): the card page, a membership billed by Square, Square's checkout, the deposit, #/paid. They
  // run against the fixture's link API (a stack runs PAYMENT_PROCESSOR=squarespace: saved cards and Square memberships are
  // off there, the routes answer 501), every page with the production CSP (Square's hosts) and the fixture's STUB of
  // Square's Web Payments SDK (served same-origin; never the real SDK).
  if (L.name === 'fixture') {
    const stubLoads = () => L.squareStubLoads?.() ?? -1
    const stub = (page: Page) => page.evaluate(() => (window as any).__squareStub ?? null)
    const typeCard = async (page: Page, number: string) => {
      const field = page.locator('#dc-root input[data-square-stub="card"]')
      await field.waitFor({ state: 'attached', timeout: 15_000 })
      await field.fill(number)
    }
    // 22. lazily: no page of the run so far loaded Square's SDK (none showed a card form)
    check('links 22: Square\'s SDK is loaded only where a card form shows (no earlier link page asked for it)', stubLoads() === 0, `loads ${stubLoads()}`)
    // 22. the card page: PIN, the saved cards, the form, the consent unchecked and required, save, remove, a declined card
    {
      const phone = '+12015550181'
      const K = await issue({ kind: 'card', phone, firstName: 'Lena', pin: '7391', cardsOn: true, cards: [{ last4: '0005', purposes: ['balance'] }] })
      const { page, seen, close } = await open()
      await go(page, `${origin}/#/k/${K.token}`)
      await page.locator('#dc-root input[placeholder="PIN"]').fill('7391')
      await btn(page, /^\s*Verify\s*$/).click()
      await waitText(page, 'SAVED CARDS · LENA ••81')
      await waitText(page, 'Visa ••0005')
      const consent = page.locator('#dc-root button').filter({ hasText: /^Save this card with Square so Oasis Auto Spa can charge it for: a no-show fee, a late-cancel fee and a balance you owe\./ })
      const unchecked = (await consent.locator('svg').count()) === 0
      await typeCard(page, '4111 1111 1111 1111')
      const posts = () => seen.filter((s) => s.method === 'POST' && s.url.endsWith('/links/cards'))
      await btn(page, /^\s*Save card\s*$/).click()
      await waitText(page, 'Tick the box to agree, then save the card.')
      const before = posts().length
      await consent.click()
      await btn(page, /^\s*Save card\s*$/).click()
      await waitText(page, 'Visa ••1111 is saved.')
      const body = JSON.parse(posts().at(-1)?.body || '{}')
      const s = await stub(page)
      check(
        'links 22: the card page opens after the PIN with the saved cards and Square\'s card form; the consent box (the API\'s wording) starts unchecked and is required',
        unchecked && before === 0 && stubLoads() === 1 && s?.attaches >= 1,
        JSON.stringify({ unchecked, before, loads: stubLoads(), attaches: s?.attaches }),
      )
      check(
        'links 22: Save card sends Square\'s one-time token (intent STORE, customer-initiated) with the consent version and purposes, and the list shows the new card',
        body.sourceId === 'cnon:card-nonce-ok' && body.consentVersion === 'v1' && JSON.stringify(body.purposes) === '["no_show_fee","late_cancel_fee","balance"]' && s?.tokenize?.[0]?.intent === 'STORE' && s?.tokenize?.[0]?.customerInitiated === true && !!posts().at(-1)?.headers['idempotency-key'],
        JSON.stringify({ body, tokenize: s?.tokenize?.[0] }),
      )
      // a declined card: the API's words, nothing saved
      await typeCard(page, '4000 0000 0000 0002')
      await consent.click()
      await btn(page, /^\s*Save card\s*$/).click()
      await waitText(page, 'This card was declined. Try another card, or pay at the shop.')
      // remove the first card of the list
      await page.locator('#dc-root button').filter({ hasText: /^\s*Remove\s*$/ }).first().click()
      await waitText(page, 'The card is removed.')
      const dels = seen.filter((x) => x.method === 'DELETE' && /\/links\/cards\/[0-9a-f-]{36}$/.test(x.url))
      check('links 22: a declined card shows the API\'s words; Remove sends DELETE /cards/:id and the list follows', dels.length === 1, `${dels.length} DELETE`)
      await csp(page)
      await close()
    }
    // 23. a membership billed by Square: size, PIN, e-mail, card + consent, subscribe, the wait for the first payment
    {
      const prices = [
        { class: 'compact_car', label: 'Compact car', monthlyCents: 12900, joinable: true },
        { class: 'large_suv', label: 'Large SUV', monthlyCents: 15900, joinable: true },
      ]
      const plan = { tier: 'gold' as const, planKey: L.planKey('gold'), name: 'Gold', monthlyPriceCents: 12900, perks: ['Unlimited washes'], checkoutUrl: null, billing: 'square' as const, prices }
      const run = async (phone: string, card: string) => {
        const M = await issue({ kind: 'membership', phone, firstName: 'Sam', pin: '7391', cardsOn: true, plan })
        const p = await open()
        await go(p.page, `${origin}/#/m/${M.token}`)
        await waitText(p.page, 'STEP 1 OF 4')
        await btn(p.page, /^\s*Large SUV · \$159\/mo\s*$/).click()
        await waitText(p.page, 'Priced for')
        await btn(p.page, /^\s*Continue\s*$/).click()
        await p.page.locator('#dc-root input[placeholder="PIN"]').fill('7391')
        await btn(p.page, /^\s*Verify\s*$/).click()
        await waitText(p.page, 'Square emails your receipts there every month.')
        await p.page.locator('#dc-root input[placeholder="Email (for receipts)"]').fill('sam@gmail.com')
        await btn(p.page, /^\s*Continue\s*$/).click()
        await waitText(p.page, 'STEP 4 OF 4 · CARD')
        await typeCard(p.page, card)
        await btn(p.page, /^\s*I agree to be billed \$159 a month for Gold/).click()
        await p.page.locator('#dc-root button').filter({ hasText: /^Save this card with Square so Oasis Auto Spa can charge it for: your membership’s monthly payment\./ }).click()
        await btn(p.page, /^\s*Join · \$159\/mo\s*$/).click()
        return p
      }
      const a = await run('+12015550182', '4111 1111 1111 1111')
      await waitText(a.page, 'Your Gold membership is active.')
      const sub = JSON.parse(a.seen.filter((s) => s.method === 'POST' && s.url.endsWith('/links/membership/subscribe')).at(-1)?.body || '{}')
      const polls = a.seen.filter((s) => s.method === 'GET' && s.url.endsWith('/links/membership/status')).length
      check(
        'links 23: a membership billed by Square: the size picked (Large SUV $159), a fresh PIN, the e-mail, the card and the consent, then the page waits for the first payment and opens the welcome',
        sub.planClass === 'large_suv' && sub.email === 'sam@gmail.com' && sub.sourceId === 'cnon:card-nonce-ok' && sub.consentVersion === 'v1' && polls >= 2 && !a.seen.some((s) => s.url.endsWith('/membership/start')),
        JSON.stringify({ sub, polls }),
      )
      await csp(a.page)
      await a.close()
      const b = await run('+12015550183', '4000 0000 0000 0341')
      await waitText(b.page, 'Square couldn’t take the first payment.')
      check('links 23: when Square refuses the first payment the card step says so in plain words', true)
      await csp(b.page)
      await b.close()
    }
    // 24. payment on Square's checkout: the page names it and follows the square.link URL
    {
      const phone = '+12015550184'
      const url = 'https://square.link/u/inv20611'
      const P = await issue({ kind: 'pay', phone, firstName: 'Ravi', pin: '7391', invoice: { ...INVOICE, url } })
      const { page, close } = await open()
      await go(page, `${origin}/#/p/${P.token}`)
      await waitText(page, 'You’ll pay on a secure checkout page.')
      await btn(page, /^\s*Verify & pay /).click()
      await page.locator('#dc-root input[placeholder="PIN"]').fill('7391')
      await btn(page, /^\s*Verify\s*$/).click()
      await waitText(page, 'Taking you to Square’s secure checkout to pay.')
      const n = await navs(page)
      check('links 24: a Square payment link (square.link) is followed and named as Square\'s secure checkout', n.length === 1 && n[0] === url, n.join(' | '))
      await csp(page)
      await close()
    }
    // 25. the booking deposit by link: after a link booking, "Pay the $25 deposit now" opens Square's checkout
    {
      const phone = '+12015550185'
      const C = await issue({ kind: 'calendar', phone, firstName: 'Dee', trusted: true, depositLink: true })
      const { page, seen, close } = await open()
      await go(page, `${origin}/#/c/${C.token}`)
      await waitText(page, 'BOOKING FOR DEE ••85')
      await pickTime(page)
      await btn(page, /^\s*I understand the/).click()
      // the sticky bar carries a "Book" too (hidden under the sheet); the sheet's CTA is the last one
      await btn(page, /^\s*Book\s*$/).last().click()
      await waitText(page, 'You\'re booked')
      await btn(page, /^\s*Pay the \$25 deposit now\s*$/).click()
      await page.waitForTimeout(800)
      const n = await navs(page)
      const dep = seen.filter((s) => s.method === 'POST' && s.url.endsWith('/links/deposit/start'))
      check('links 25: a booking whose deposit is taken by link offers "Pay the $25 deposit now", which opens Square\'s checkout', dep.length === 1 && n.length === 1 && /^https:\/\/square\.link\//.test(n[0]!), `${dep.length} ${n.join(' | ')}`)
      await csp(page)
      await close()
    }
    // 26. #/paid: back from Square's checkout
    {
      const { page, close } = await open()
      await go(page, `${origin}/#/paid?orderId=fixture`)
      await waitText(page, 'Square is confirming your payment now.')
      const href = await page.evaluate(() => location.href)
      check('links 26: #/paid (Square\'s way back) shows a thank-you and leaves a clean address', !href.includes('#'), href)
      await csp(page)
      await close()
    }
  }

  // 21. PUBLIC_LINKS_ENABLED off: the API answers 404 and the page is the site as without a link
  await L.linksOff(async (offOrigin) => {
    const C = await issue({ kind: 'calendar', phone: '+12015550176', firstName: 'Off', trusted: true })
    const { page, t, seen, statuses, close } = await open(offOrigin)
    await go(page, `${offOrigin}/#/c/${C.token}`)
    await page.waitForTimeout(800)
    const st = await page.evaluate(() => ({ href: location.href, sheet: !!document.querySelector('#dc-root div[style*="z-index:80"]'), toast: !!document.querySelector('#dc-root div[style*="z-index:95"]') }))
    const ex = seen.filter((s) => s.method === 'POST' && s.url.endsWith('/api/v1/public/links/exchange') && s.body.includes(C.token))
    const answered = statuses.filter((x) => x.url.endsWith('/links/exchange')).map((x) => x.status)
    check(
      'links 21: with links switched off (404) the page is the home page as today: no sheet, no toast, no error, token scrubbed',
      !st.sheet && !st.toast && !st.href.includes(C.token) && ex.length === 1 && answered.length === 1 && answered[0] === 404 && t.errors.filter((e) => !/^Failed to load resource: .*status of 404 /.test(e)).length === 0,
      JSON.stringify({ ...st, href: st.href.replace(C.token, '<token>'), exchanges: answered }),
    )
    await csp(page)
    await close()
  })

  // the contract the page is written to (src/site/link-contract.testkit.ts, the backend's schemas): every answer it got
  const contract: string[] = []
  const routes = new Set<string>()
  for (const { route, body } of replies) {
    routes.add(route)
    const { session, verified, ...state } = body
    if (route === 'POST /exchange') contract.push(...(typeof session === 'string' && session ? linkStateProblems(state) : ['exchange: no session']).map((x) => `${route} ${x}`))
    else if (route === 'GET /me') contract.push(...linkStateProblems(body).map((x) => `${route} ${x}`))
    else if (['POST /verify/code/confirm', 'POST /verify/pin', 'POST /pin', 'POST /pin/reset'].includes(route))
      contract.push(...(typeof verified === 'boolean' ? linkStateProblems(state) : ['no verified']).map((x) => `${route} ${x}`))
    else if (route === 'POST /verify/code') contract.push(...keyProblems(route, body, CODE_REQUESTED_KEYS))
    else if (route === 'POST /bookings') contract.push(...keyProblems(route, body, BOOKING_RESULT_KEYS))
    else if (route === 'POST /membership/start') contract.push(...keyProblems(route, body, MEMBERSHIP_RESULT_KEYS))
    else if (route === 'POST /pay/start') contract.push(...keyProblems(route, body, PAY_RESULT_KEYS))
    else if (route === 'POST /cards') contract.push(...keyProblems(route, body, CARD_SAVE_RESULT_KEYS))
    else if (route === 'DELETE /cards/:id') contract.push(...keyProblems(route, body, CARD_REMOVE_RESULT_KEYS))
    else if (route === 'POST /membership/subscribe' || route === 'GET /membership/status') contract.push(...keyProblems(route, body, ENROLLMENT_STATUS_KEYS))
    else if (route === 'POST /deposit/start') contract.push(...keyProblems(route, body, DEPOSIT_RESULT_KEYS))
  }
  const wanted = [
    ...['POST /exchange', 'GET /availability', 'POST /verify/code', 'POST /verify/code/confirm', 'POST /verify/pin', 'POST /pin', 'POST /bookings', 'POST /membership/start', 'POST /pay/start'],
    // wave Q3: the fixture's (a stack runs with saved cards and Square memberships off)
    ...(L.name === 'fixture' ? ['POST /cards', 'DELETE /cards/:id', 'POST /membership/subscribe', 'GET /membership/status', 'POST /deposit/start'] : []),
  ]
  const unseen = wanted.filter((r) => !routes.has(r))
  check(
    `links contract: every 2xx answer of the ${L.name} link API has the shape the page is written to (${replies.length} answers over ${routes.size} routes)`,
    contract.length === 0 && unseen.length === 0,
    [...contract.slice(0, 4), ...(unseen.length ? [`never answered: ${unseen.join(', ')}`] : [])].join(' | '),
  )
  d.check(`links: the only console lines of the link pages were the API's documented 4xx answers (${expectedAll.length})`, expectedAll.every((e) => /status of 4\d\d /.test(e)))
  // 19. CSP clean over every link page
  check('links 19: no Content-Security-Policy violation on any link page (the production policy)', cspAll.length === 0, cspAll.slice(0, 3).join(' | '))
  // and the token of every link only ever in an exchange body, over every page of the run
  const leaks = seenAll.filter((s) => tokens.some((tok) => s.url.includes(tok) || JSON.stringify(s.headers).includes(tok) || (s.body.includes(tok) && !s.url.endsWith('/links/exchange'))))
  check(`links 10: over the whole run (${tokens.length} links) no token in a URL, a header or another body`, leaks.length === 0, leaks.slice(0, 2).map((s) => `${s.method} ${s.url}`).join(' | '))
  // and on the API side: no token in its logs or (a stack) any row of its schema; a link text's message row shows it masked
  const sightings = await L.tokenSightings(tokens)
  check(`links 10: over the whole run the API kept no token (${L.name === 'stack' ? 'server logs, every row of the schema' : 'request log'})`, sightings.length === 0, sightings.slice(0, 4).join('; '))
  if (L.name === 'stack') {
    const texted = await L.linkTexts(tokens)
    check(
      `links 10: every link was texted through the backend's queue and its message row shows "[private link]", never the token (${texted.masked}/${texted.queued})`,
      texted.queued >= tokens.length && texted.masked === texted.queued && texted.skipped.length === 0,
      texted.skipped.slice(0, 3).join(' | '),
    )
  }
}
