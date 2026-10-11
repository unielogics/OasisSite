// e2e: personal links (DEVIATIONS.md DV-LINK, DV-STEPUP, DV-LINK-JOIN, DV-LINK-PAY, DV-LINK-DEAD; backend design
// docs/design/ai-assistant-and-phone-identity.md section 7, checks 10-19), run by scripts/e2e-site.ts against the
// fixture API's link routes (tools/site/fixture-links.ts) on the launch build (SITE_BOOKING=sms: links work in either
// booking mode). Every page here is served with the production Content-Security-Policy of the site (the deploy kit's
// install.sh SITE_CSP, minus upgrade-insecure-requests, which would send the plain-http test host's assets to https),
// and every request the browser makes is recorded (URL, headers, body) to prove where the token travels.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Browser, BrowserContext, Page, Request } from '@playwright/test'
import type { FixtureApi } from '../tools/site/fixture-api'
import type { SiteProxy } from '../tools/site/proxy'

/** install.sh SITE_CSP (backend deploy kit) without upgrade-insecure-requests (the e2e host is plain http). */
export const SITE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"

export interface LinkTracker {
  errors: string[]
  blocked: string[]
  fiveHundreds: string[]
  navigations: string[]
  responses: { url: string; status: number; body: string }[]
}

export interface LinkDeps {
  browser: Browser
  /** the site's host (the proxy in front of dist and the fixture API) */
  proxy: SiteProxy
  api: FixtureApi
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
const STATUS_TEXT: Record<number, string> = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 410: 'Gone', 422: 'Unprocessable Entity', 423: 'Locked', 429: 'Too Many Requests' }
const CHECKOUT = 'https://oasis-auto-spa.squarespace.com/checkout/subscribe?plan=gold'
const PAY_URL = 'https://oasis-auto-spa.squarespace.com/pay/inv-20611'
const INVOICE = { number: 'INV-20611', title: 'Signature Hand Wash · Oct 9', totalCents: 5400, balanceCents: 5400, lines: [{ label: 'Signature Hand Wash', amountCents: 5400 }] }

export async function runLinkChecks(d: LinkDeps): Promise<void> {
  const { browser, proxy, api, check } = d
  const origin = proxy.origin
  const L = api.links
  const seenAll: Seen[] = []
  const cspAll: string[] = []
  const expectedAll: string[] = []
  const tokens: string[] = []
  const issue = (i: Parameters<typeof L.issue>[0]) => {
    const r = L.issue(i, origin)
    tokens.push(r.token)
    return r
  }

  /** A page that records every request, carries the production CSP, and reports CSP violations. */
  async function open(): Promise<{ ctx: BrowserContext; page: Page; t: LinkTracker; seen: Seen[]; exchanges: string[]; close: () => Promise<void> }> {
    const { ctx, page, t } = await d.newPage(browser, origin)
    d.trackers.push(t)
    const seen: Seen[] = []
    const exchanges: string[] = []
    // the link API's documented 4xx answers (a dead link, a wrong PIN, links switched off) are logged by Chromium as
    // "Failed to load resource: … status of 4xx": expected here, every other console line still counts
    const expected: number[] = []
    page.on('response', (r) => {
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
      const s = { method: r.method(), url: r.url(), headers: r.headers(), body: r.postData() ?? '' }
      seen.push(s)
      seenAll.push(s)
    })
    page.on('response', async (r) => {
      if (r.url().endsWith('/links/exchange') && r.status() === 200) {
        try {
          exchanges.push(String(((await r.json()) as { session?: string }).session ?? ''))
        } catch {
          /* gone */
        }
      }
    })
    await page.route('**/*', async (route) => {
      const req = route.request()
      if (req.resourceType() === 'document' && new URL(req.url()).origin === origin) {
        const resp = await route.fetch()
        return route.fulfill({ response: resp, headers: { ...resp.headers(), 'content-security-policy': SITE_CSP } })
      }
      return route.fallback()
    })
    await page.addInitScript(() => {
      ;(window as any).__csp = []
      document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective} ${e.blockedURI}`))
    })
    return { ctx, page, t, seen, exchanges, close }
  }
  const go = async (page: Page, url: string) => {
    await page.goto(url, { waitUntil: 'load' })
    await d.ready(page)
  }
  const csp = async (page: Page) => {
    const v = (await page.evaluate(() => (window as any).__csp ?? []).catch(() => [])) as string[]
    cspAll.push(...v)
  }
  const btn = (page: Page, re: RegExp) => page.locator('#dc-root button').filter({ hasText: re })
  const text = (page: Page, s: string) => page.locator('#dc-root').getByText(s, { exact: false })
  const waitText = (page: Page, s: string, timeout = 15_000) => text(page, s).first().waitFor({ state: 'visible', timeout })
  const navs = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__oasisNavigations ?? [])
  const lastCode = () => {
    const s = L.snapshot()
    return s.codes[s.codes.length - 1]?.code ?? ''
  }
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
  const enterCode = async (page: Page) => {
    await btn(page, /^\s*Text me a code\s*$/).click()
    await page.locator('#dc-root input[placeholder="6-digit code"]').waitFor({ timeout: 15_000 })
    await page.locator('#dc-root input[placeholder="6-digit code"]').fill(lastCode())
    await btn(page, /^\s*Verify\s*$/).click()
  }

  // 10 + 11. the token: scrubbed before hydration, only ever in the exchange body; 12a. a trusted number books at once
  {
    const A = issue({ kind: 'calendar', phone: '+12015550161', firstName: 'Maria', tier: 'gold', trusted: true })
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
    const logged = L.state.log.filter((l) => l.path.includes(A.token) || JSON.stringify(l.headers).includes(A.token) || (l.body.includes(A.token) && !l.path.endsWith('/exchange')))
    const proxied = proxy.log.filter((l) => l.path.includes(A.token))
    check('links 10: the API and the site host never saw the token outside the exchange body (request log, paths)', logged.length === 0 && proxied.length === 0, `${logged.length} api, ${proxied.length} host`)
    // the trusted member books in the sheet without any step-up
    await go(page, `${origin}/`) // a reload: the link is gone from memory too
    const opened = await text(page, 'BOOKING FOR').count()
    check('links 11: a reload does not reopen the link (the token lived in memory only)', opened === 0)
    await close()

    const B = issue({ kind: 'calendar', phone: '+12015550161', firstName: 'Maria', tier: 'gold', trusted: true })
    const p2 = await open()
    await go(p2.page, `${origin}/#/c/${B.token}`)
    await waitText(p2.page, 'BOOKING FOR MARIA ••61')
    await pickTime(p2.page)
    await btn(p2.page, /^\s*Confirm booking/).click()
    await waitText(p2.page, 'You\'re booked')
    const done = await p2.page.locator('#dc-root').innerText()
    const steps = p2.seen.filter((s) => /\/links\/verify\//.test(s.url))
    const booked = L.snapshot().bookings.find((b) => b.phone === '+12015550161')
    check('links 12: a trusted number (verified in the last 30 days) books without a PIN or code', steps.length === 0 && !!booked && /Ref OAS-\d+/.test(done), `${steps.length} step-up calls, booking ${booked?.bookingRef}`)
    const av = p2.seen.filter((s) => s.url.includes('/api/v1/public/links/availability'))
    check('links 12: the sheet shows the client\'s own board (link availability with the session, never the public one)', av.length > 0 && av.every((s) => /^Bearer \S+$/.test(s.headers.authorization ?? '')), `${av.length} calls`)
    await csp(p2.page)
    await p2.close()
  }

  // 12b + 13. not trusted: Book asks for a texted code, then books; the number is trusted afterwards
  {
    const phone = '+12015550162'
    const A = issue({ kind: 'calendar', phone, firstName: 'Jose', tier: null })
    const { page, seen, close } = await open()
    await go(page, `${origin}/#/c/${A.token}`)
    await waitText(page, 'BOOKING FOR JOSE ••62')
    await pickTime(page)
    await btn(page, /^\s*I understand the \$25 booking fee/).click()
    await btn(page, /^\s*Book\s*$/).last().click()
    await waitText(page, 'Text me a code')
    const before = L.snapshot().bookings.filter((b) => b.phone === phone).length
    check('links 12: a number without trust is asked to confirm before the booking (no booking yet)', before === 0)
    await enterCode(page)
    await waitText(page, 'You\'re booked')
    const after = L.snapshot()
    const codeReq = seen.find((s) => s.url.endsWith('/links/verify/code'))
    check('links 13: the texted code went to the link\'s number (the request carries no phone), then the booking went through', !!codeReq && !/phone/.test(codeReq.body) && after.bookings.some((b) => b.phone === phone) && !!after.trust[phone], codeReq?.body)
    await csp(page)
    await close()
    const B = issue({ kind: 'calendar', phone, firstName: 'Jose', tier: null })
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
    const V = issue({ kind: 'verify', phone, firstName: 'Ana' })
    const { page, close } = await open()
    await go(page, `${origin}/#/v/${V.token}`)
    await waitText(page, 'Confirm it’s you')
    await enterCode(page)
    await waitText(page, 'You’re verified')
    const note = await page.locator('#dc-root').innerText()
    check('links 13: a verify link ends on "You\'re verified" with the trust date', /verified until [A-Z][a-z]{2} \d{1,2}/.test(note), note.split('\n').find((x) => x.includes('verified')))
    await btn(page, /Create a PIN for next time/).click()
    await page.locator('#dc-root input[placeholder="New PIN"]').fill('1234')
    await btn(page, /^\s*Save\s*$/).click()
    await waitText(page, 'Don’t use a run like 1234')
    await page.locator('#dc-root input[placeholder="New PIN"]').fill('4826')
    await btn(page, /^\s*Save\s*$/).click()
    await waitText(page, 'Your PIN is set')
    check('links 13: a PIN can be created after the code (an easy one is refused with the reason)', L.pinOf(phone) === '4826')
    await csp(page)
    await close()
  }

  // 14. the PIN lockout text
  {
    const phone = '+12015550164'
    const V = issue({ kind: 'verify', phone, firstName: 'Lena', pin: '7391' })
    const { page, close } = await open()
    await go(page, `${origin}/#/v/${V.token}`)
    await page.locator('#dc-root input[placeholder="PIN"]').waitFor({ timeout: 15_000 })
    for (let i = 0; i < 5; i++) {
      await page.locator('#dc-root input[placeholder="PIN"]').fill('1111')
      await btn(page, /^\s*Verify\s*$/).click()
      await page.waitForTimeout(300)
    }
    await waitText(page, 'Too many wrong PINs. Try again in 15 min')
    const fields = await page.locator('#dc-root input[placeholder="PIN"]').count()
    const reset = await btn(page, /Forgot your PIN\? Text me a code/).count()
    check('links 14: five wrong PINs show the lockout text, the PIN field goes and the reset by code stays', fields === 0 && reset === 1, `fields ${fields}, reset ${reset}`)
    await csp(page)
    await close()
  }

  // 15. membership: plan -> verify -> e-mail -> terms -> the Squarespace checkout; a pending membership + checkout intent
  {
    const phone = '+12015550165'
    const M = issue({ kind: 'membership', phone, firstName: 'Sam', plan: { key: 'gold', label: 'Gold', monthlyPriceCents: 9900, checkoutUrl: CHECKOUT } })
    const { page, close } = await open()
    await go(page, `${origin}/#/m/${M.token}`)
    await waitText(page, 'STEP 1 OF 4')
    const hash = await page.evaluate(() => location.hash)
    await btn(page, /^\s*Continue\s*$/).click()
    await waitText(page, 'CONFIRM IT’S YOU')
    await enterCode(page)
    await waitText(page, 'Joining as')
    await page.locator('#dc-root input[placeholder="Email (for receipts)"]').fill('sam@example.com')
    await btn(page, /^\s*Continue\s*$/).click()
    await btn(page, /^\s*I agree to be billed/).click()
    await btn(page, /^\s*Continue to checkout/).click()
    await page.waitForTimeout(800)
    const n = await navs(page)
    const s = L.snapshot()
    const pending = s.memberships.find((m) => m.phone === phone)
    const intent = s.checkouts.find((c) => c.phone === phone)
    check('links 15: the membership link opens the join steps for its plan (the token scrubbed: #/join?gold)', hash === '#/join?gold', hash)
    check('links 15: after a fresh code and the e-mail, the page goes to the plan\'s Squarespace checkout', n.length === 1 && n[0] === CHECKOUT, n.join(' | '))
    check('links 15: a pending membership and a checkout intent with the confirmed e-mail exist', pending?.state === 'pending' && intent?.expectedEmail === 'sam@example.com' && intent?.planKey === 'gold', JSON.stringify(intent))
    await csp(page)
    await close()
  }

  // 16. payment: review -> PIN -> the invoice's Squarespace link; a URL off the allowlist is not followed
  {
    const phone = '+12015550166'
    const P = issue({ kind: 'pay', phone, firstName: 'Ravi', pin: '7391', invoice: { ...INVOICE, url: PAY_URL } })
    const { page, close } = await open()
    await go(page, `${origin}/#/p/${P.token}`)
    await waitText(page, 'Invoice INV-20611')
    const review = await page.locator('#dc-root').innerText()
    await btn(page, /^\s*Verify & pay \$54/).click()
    await page.locator('#dc-root input[placeholder="PIN"]').fill('7391')
    await btn(page, /^\s*Verify\s*$/).click()
    await page.waitForTimeout(800)
    const n = await navs(page)
    check('links 16: the payment review shows the invoice and the balance', /PAYMENT FOR RAVI ••66/.test(review) && /Balance due/.test(review) && /\$54/.test(review))
    check('links 16: after a fresh PIN the page goes to the invoice\'s Squarespace payment link', n.length === 1 && n[0] === PAY_URL, n.join(' | '))
    await csp(page)
    await close()

    const Q = issue({ kind: 'pay', phone: '+12015550167', firstName: 'Ravi', pin: '7391', invoice: { ...INVOICE, url: 'https://pay.evil.example/inv-20611' } })
    const p2 = await open()
    await go(p2.page, `${origin}/#/p/${Q.token}`)
    await waitText(p2.page, 'Invoice INV-20611')
    await btn(p2.page, /^\s*Verify & pay \$54/).click()
    await p2.page.locator('#dc-root input[placeholder="PIN"]').fill('7391')
    await btn(p2.page, /^\s*Verify\s*$/).click()
    await waitText(p2.page, 'We couldn’t open the payment page')
    const n2 = await navs(p2.page)
    const sms = await p2.page.locator('#dc-root a[href^="sms:"]').filter({ hasText: 'Text us for a new link' }).getAttribute('href')
    check('links 16: a payment URL off the allowlist (not squarespace.com) is not followed', n2.length === 0 && String(sms).startsWith(`sms:${SMS_E164}?&body=`), `${n2.join(' | ')} ${sms}`)
    await csp(p2.page)
    await p2.close()
  }

  // 17. dead links
  {
    const cases: [string, Parameters<typeof L.issue>[0] | null, string][] = [
      ['expired', { kind: 'calendar', phone: '+12015550170', expired: true }, 'This link expired'],
      ['used', { kind: 'verify', phone: '+12015550171', used: true }, 'This link was used'],
      ['revoked', { kind: 'pay', phone: '+12015550172', revoked: true, invoice: { ...INVOICE, url: PAY_URL } }, 'This link was replaced'],
      ['unknown', null, 'This link doesn’t work'],
    ]
    for (const [name, input, title] of cases) {
      const tok = input ? issue(input).token : 'VW5rbm93bkxpbmtUb2tlbi0zMi1ieXRlcy1iYXNlNjR1cmw'
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
    const C = issue({ kind: 'calendar', phone, firstName: 'Kim', tier: 'gold', trusted: true })
    const logBefore = L.state.log.length
    const preview = await fetch(`${origin}/#/c/${C.token}`, { headers: { 'user-agent': 'facebookexternalhit/1.1' } })
    const html = await preview.text()
    const usesOf = () => L.snapshot().links.find((l) => l.phone === phone)!
    check('links 18: a link preview gets the static home page and reaches no API (the fragment never leaves the device)', preview.status === 200 && html.includes('Oasis Auto Spa') && L.state.log.length === logBefore && !proxy.log.some((l) => l.path.includes(C.token)))
    for (let i = 0; i < 2; i++) {
      const { page, close } = await open()
      await go(page, `${origin}/#/c/${C.token}`)
      await waitText(page, 'BOOKING FOR KIM ••73')
      await close()
    }
    const opened = usesOf()
    check('links 18: opening the link twice uses nothing (2 exchanges, 0 uses)', opened.uses === 0 && opened.exchanges === 2, JSON.stringify(opened))
    const { page, close } = await open()
    await go(page, `${origin}/#/c/${C.token}`)
    await waitText(page, 'BOOKING FOR KIM ••73')
    await pickTime(page)
    await btn(page, /^\s*Confirm booking/).click()
    await waitText(page, 'You\'re booked')
    check('links 18: completing (a booking) uses the link once', usesOf().uses === 1, JSON.stringify(usesOf()))
    await csp(page)
    await close()
  }

  // 20. a second link in the same tab replaces the first
  {
    const A = issue({ kind: 'calendar', phone: '+12015550174', firstName: 'Maria', trusted: true })
    const B = issue({ kind: 'calendar', phone: '+12015550175', firstName: 'Jose', trusted: true })
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

  // 21. PUBLIC_LINKS_ENABLED off: the API answers 404 and the page is the site as without a link
  {
    L.state.enabled = false
    try {
      const C = issue({ kind: 'calendar', phone: '+12015550176', firstName: 'Off', trusted: true })
      const { page, t, close } = await open()
      await go(page, `${origin}/#/c/${C.token}`)
      await page.waitForTimeout(800)
      const st = await page.evaluate(() => ({ href: location.href, sheet: !!document.querySelector('#dc-root div[style*="z-index:80"]'), toast: !!document.querySelector('#dc-root div[style*="z-index:95"]') }))
      const ex = L.state.log.filter((l) => l.path.endsWith('/exchange') && l.body.includes(C.token))
      check('links 21: with links switched off (404) the page is the home page as today: no sheet, no toast, no error, token scrubbed', !st.sheet && !st.toast && !st.href.includes(C.token) && ex.length === 1 && t.errors.filter((e) => !/^Failed to load resource: .*status of 404 /.test(e)).length === 0, JSON.stringify({ ...st, href: st.href.replace(C.token, '<token>') }))
      await csp(page)
      await close()
    } finally {
      L.state.enabled = true
    }
  }

  d.check(`links: the only console lines of the link pages were the API's documented 4xx answers (${expectedAll.length})`, expectedAll.every((e) => /status of 4\d\d /.test(e)))
  // 19. CSP clean over every link page
  check('links 19: no Content-Security-Policy violation on any link page (the production policy)', cspAll.length === 0, cspAll.slice(0, 3).join(' | '))
  // and the token of every link only ever in an exchange body, over every page of the run
  const leaks = seenAll.filter((s) => tokens.some((tok) => s.url.includes(tok) || JSON.stringify(s.headers).includes(tok) || (s.body.includes(tok) && !s.url.endsWith('/links/exchange'))))
  check(`links 10: over the whole run (${tokens.length} links) no token in a URL, a header or another body`, leaks.length === 0, leaks.slice(0, 2).map((s) => `${s.method} ${s.url}`).join(' | '))
}
