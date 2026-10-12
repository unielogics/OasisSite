// The personal-link checks against a LIVE stack (the dashboard's `pnpm live:up`, the real backend API with
// PUBLIC_LINKS_ENABLED=true and a test PIN_PEPPER): links are issued exactly as the shop issues them, with the backend's own
// issueClientLink (src/modules/identity/links.ts) in this process against the stack's schema, and texted through the
// backend's own message queue (template personal_link_<kind>, the URL as a secretVar), so the message rows the link
// leaves behind can be read back. What a link needs is made the way the backend makes it: the client (a customers row as the
// backend's own link tests insert it), a Gold membership (createManualMembership), the number's 30-day trust
// (grantTrust), a PIN (customer_pins with the backend's PIN hasher and the stack's pepper), an invoice (a real visit booked
// through the link API by a calendar link of the same client) with a staff-attached payment URL, a plan's checkout URL.
// The code a text carried is read from the stack's sms_outbox while it is unredacted, else recovered from the challenge's
// hash (the simulator delivers at once and a delivered code is wiped). Links switched off: a second API process of the same
// backend on the same schema with PUBLIC_LINKS_ENABLED=false, behind its own site host. Never part of the build.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { LinkDriver, IssueLinkInput } from './link-driver'
import type { SiteProxy } from './proxy'

export interface StackLinkOptions {
  /** the backend checkout the stack runs */
  backend: string
  /** the stack's schema (e2e_<name>) and the backend's DATABASE_URL */
  schema: string
  dbUrl: string
  /** the stack's API */
  apiUrl: string
  /** the stack's API log (the token must never be in it) */
  apiLog: string
  /** the stack's PIN_PEPPER (generated for the run, exported to live:up and to this process) */
  pinPepper: string
  /** a site host in front of another API origin (for the links-off API) */
  startProxy: (apiOrigin: string, port: number) => Promise<SiteProxy>
  /** the port of that links-off site host */
  offPort: number
  log: (s: string) => void
}

export interface StackLinks extends LinkDriver {
  close(): Promise<void>
}

const q = (s: string): string => `'${s.replace(/'/g, "''")}'`
const MIN = 60_000

/** True when the stack answers the link routes (401 for a bad token) rather than 404 (PUBLIC_LINKS_ENABLED=false). */
export async function stackLinksEnabled(apiUrl: string): Promise<boolean> {
  const r = await fetch(`${apiUrl}/api/v1/public/links/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'probe' }),
  })
  return r.status !== 404
}

export async function createStackLinks(o: StackLinkOptions): Promise<StackLinks> {
  const be = (rel: string): Promise<any> => import(pathToFileURL(path.join(o.backend, rel)).href)
  const [dbm, ids, clockm, links, trust, pin, plans, members, queue, mconfig, recipients, envm, otp, tiers] = await Promise.all([
    be('src/platform/db.ts'),
    be('src/platform/ids.ts'),
    be('src/platform/clock.ts'),
    be('src/modules/identity/links.ts'),
    be('src/modules/identity/trust.ts'),
    be('src/modules/identity/pin.ts'),
    be('src/modules/memberships/plans.ts'),
    be('src/modules/memberships/service.ts'),
    be('src/modules/messaging/queue.ts'),
    be('src/modules/messaging/config.ts'),
    be('src/modules/messaging/db/recipients.ts'),
    be('src/config/env.ts'),
    be('src/modules/public/otp.ts'),
    be('src/modules/public/tiers.ts'),
  ])
  const clock = clockm.systemClock
  const newId = ids.createIdGenerator(clock)
  const db = dbm.createDb({ url: o.dbUrl, searchPath: `${o.schema},public`, poolMax: 4, applicationName: 'site-e2e-links' })
  const env = envm.loadEnv({
    NODE_ENV: 'development',
    DATABASE_URL: o.dbUrl,
    SMS_ALLOWLIST: process.env.SMS_ALLOWLIST ?? '',
    PUBLIC_LINKS_ENABLED: 'true',
    PIN_PEPPER: o.pinPepper,
    SESSION_SECRET: crypto.randomBytes(32).toString('base64'),
  })
  const mq = new queue.DbMessageQueue({ clock, newId, config: mconfig.messagingConfig(env) })
  const hasher = pin.pinHasherFromEnv({ PIN_PEPPER: o.pinPepper })
  const locationId: string = (await db.selectFrom('locations').select('id').orderBy('created_at').orderBy('id').executeTakeFirstOrThrow()).id
  const tx = <T>(fn: (t: any) => Promise<T>): Promise<T> => db.transaction().execute(fn)
  const texts: { token: string; messageId: string | null; skipped: string | null }[] = []
  const offLogs: string[] = []
  let off: { proc: ChildProcess; proxy: SiteProxy } | null = null

  function psql(sql: string): string {
    // the statement goes on stdin: the whole-schema scan of a wave Q3 backend (many tables) is too long for an argument (E2BIG)
    return execFileSync('psql', [o.dbUrl, '-Atq', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
      input: sql.replace(/\bT\./g, `${o.schema}.`),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    }).trim()
  }

  async function customerOf(phone: string, firstName: string | null | undefined): Promise<string> {
    const have = await db.selectFrom('customers').select('id').where('phone_e164', '=', phone).where('deleted_at', 'is', null).executeTakeFirst()
    if (have) return have.id
    const id = newId()
    await db
      .insertInto('customers')
      .values({
        id,
        full_name: `${firstName ?? 'Client'} Linktest`,
        phone_e164: phone,
        phone_display: null,
        email: null,
        notes: null,
        sms_opted_in: true,
        sms_opt_in_source: 'online',
        synthetic: false,
        needs_details: false,
      })
      .execute()
    return id
  }

  async function api(method: string, p: string, o2: { session?: string; body?: unknown; key?: string } = {}): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (o2.session) headers.authorization = `Bearer ${o2.session}`
    if (o2.key) headers['idempotency-key'] = o2.key
    const r = await fetch(`${o.apiUrl}/api/v1/public/links${p}`, { method, headers, ...(o2.body !== undefined ? { body: JSON.stringify(o2.body) } : {}) })
    const text = await r.text()
    let body: any = text
    try {
      body = JSON.parse(text)
    } catch {
      /* text */
    }
    return { status: r.status, body }
  }

  /** A real visit for the client, booked through a calendar link of theirs (trusted for the moment), and its invoice. */
  async function invoiceFor(customerId: string, phone: string): Promise<string> {
    const now = clock.now()
    const cal = await tx(async (t) => {
      await trust.grantTrust(t, { locationId, phone, customerId, verifiedBy: 'code', now })
      return links.issueClientLink(t, { newId, now }, { locationId, kind: 'calendar', customerId, issuedBy: 'staff' })
    })
    try {
      const ex = await api('POST', '/exchange', { body: { token: cal.token } })
      if (ex.status !== 200) throw new Error(`invoice setup: exchange ${ex.status} ${JSON.stringify(ex.body).slice(0, 200)}`)
      const board = await api('GET', '/availability?days=7', { session: ex.body.session })
      if (board.status !== 200) throw new Error(`invoice setup: availability ${board.status}`)
      const day = (board.body.days as any[]).find((d) => (d.slots as any[]).some((s) => s.state === 'open' || s.state === 'last'))
      const slot = day && (day.slots as any[]).find((s) => s.state === 'open' || s.state === 'last')
      if (!slot) throw new Error('invoice setup: no open time this week')
      const b = await api('POST', '/bookings', {
        session: ex.body.session,
        key: `site-e2e-invoice-${crypto.randomUUID()}`,
        body: { serviceKey: board.body.serviceKey, addonKeys: [], date: day.date, startMin: slot.startMin },
      })
      if (b.status !== 201) throw new Error(`invoice setup: booking ${b.status} ${JSON.stringify(b.body).slice(0, 200)}`)
    } finally {
      await tx(async (t) => {
        await t.updateTable('client_links').set({ revoked_at: clock.now(), revoke_reason: 'staff' }).where('id', '=', cal.id).execute()
        await trust.revokeTrust(t, { locationId, phone, customerId, reason: 'staff', now: clock.now() })
      })
    }
    const inv = await db.selectFrom('invoices').select('id').where('customer_id', '=', customerId).orderBy('created_at', 'desc').executeTakeFirstOrThrow()
    return inv.id
  }

  async function setPin(customerId: string, value: string): Promise<void> {
    const now = clock.now()
    const prev = await db.selectFrom('customer_pins').select('version').where('customer_id', '=', customerId).executeTakeFirst()
    const row = {
      pin_hash: await hasher.hash(customerId, value),
      version: (prev?.version ?? 0) + 1,
      failed_attempts: 0,
      lock_level: 0,
      locked_until: null,
      set_at: new Date(now.getTime() - 2 * 86_400_000),
      reset_hold_until: null,
      cleared_at: null,
    }
    if (prev) await db.updateTable('customer_pins').set(row).where('customer_id', '=', customerId).execute()
    else await db.insertInto('customer_pins').values({ customer_id: customerId, ...row }).execute()
  }

  // a backend before ADR 0170 maps the website's tiers to its own plan keys (tierSpec: gold -> premium); since wave Q1a the
  // tiers ARE the plans, keyed gold and vip (planByKey still resolves the old keys)
  const planKeyOf = (tier: 'gold' | 'vip'): string => (typeof tiers.tierSpec === 'function' ? tiers.tierSpec(tier).planKey : tier)

  async function issue(i: IssueLinkInput, siteOrigin: string): Promise<{ token: string; url: string }> {
    const customerId = await customerOf(i.phone, i.firstName)
    const now = clock.now()
    if (i.tier) {
      const active = await db.selectFrom('memberships').select('id').where('customer_id', '=', customerId).where('status', '=', 'active').executeTakeFirst()
      if (!active)
        await tx((t) =>
          members.createManualMembership(t, { locationId, clock, newId }, { customerId, planKey: planKeyOf(i.tier!), planLabel: i.tier === 'gold' ? 'Gold' : 'VIP' }, { userId: 'site-e2e', name: 'Site e2e', audit: {} }),
        )
    }
    if (i.pin) await setPin(customerId, i.pin)
    let invoiceId: string | null = null
    if (i.invoice) {
      invoiceId = await invoiceFor(customerId, i.phone)
      await db.updateTable('invoices').set({ payment_link_url: i.invoice.url }).where('id', '=', invoiceId).execute()
    }
    let planKey: string | null = null
    if (i.plan) {
      planKey = planKeyOf(i.plan.tier ?? 'gold')
      await plans.ensurePlans(db, { locationId, clock, newId })
      await db.updateTable('membership_plans').set({ checkout_url: i.plan.checkoutUrl }).where('location_id', '=', locationId).where('key', '=', planKey).execute()
    }
    if (i.trusted) await tx((t) => trust.grantTrust(t, { locationId, phone: i.phone, customerId, verifiedBy: 'code', now }))
    const issueOne = () =>
      tx(async (t) => {
        const link = await links.issueClientLink(t, { newId, now: clock.now(), siteUrl: siteOrigin }, { locationId, kind: i.kind, customerId, invoiceId, planKey, issuedBy: 'staff' })
        // texted as the shop texts a link: the URL only as a secretVar (the message row keeps it masked)
        const target = await recipients.loadCustomerTarget(t, locationId, customerId)
        const out = await mq.enqueueFor(t, {
          locationId,
          customerId,
          recipient: target.recipient,
          appointmentId: null,
          templateKey: `personal_link_${i.kind}`,
          vars: i.firstName ? { first: i.firstName } : {},
          secretVars: { link: link.url },
          purpose: 'personal_link',
          senderKind: 'staff',
        })
        texts.push({ token: link.token, messageId: out.queued ? out.messageId : null, skipped: out.queued ? null : `${out.skipped}${out.detail ? ` (${out.detail})` : ''}` })
        return link
      })
    const link = await issueOne()
    if (i.revoked) await issueOne() // a newer link of the same kind to the same number supersedes it, as the shop's next text does
    if (i.expired)
      await db
        .updateTable('client_links')
        .set({ created_at: new Date(now.getTime() - 3 * 60 * MIN), expires_at: new Date(now.getTime() - 60 * MIN) })
        .where('id', '=', link.id)
        .execute()
    if (i.used) await db.updateTable('client_links').set({ uses: link.maxUses, consumed_at: now }).where('id', '=', link.id).execute()
    return { token: link.token, url: link.url }
  }

  async function lastCode(phone: string): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const row = psql(`select id || ' ' || code_hash from T.public_otp_challenges where phone_e164 = ${q(phone)} order by created_at desc limit 1`)
      const [id, hash] = row.split(' ')
      if (id && hash) {
        for (const line of psql(`select body from T.sms_outbox where to_e164 = ${q(phone)} and klass = 'otp_code' order by queued_at desc limit 5`).split('\n')) {
          const m = /\b(\d{6})\b/.exec(line)
          if (m && otp.hashCode(id, m[1]!) === hash) return m[1]!
        }
        for (let n = 0; n < 1_000_000; n++) {
          const code = String(n).padStart(6, '0')
          if (otp.hashCode(id, code) === hash) return code
        }
        throw new Error(`stack: the code of challenge ${id} was not recovered`)
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error(`stack: no code was requested for ${phone}`)
  }

  async function linksOff(fn: (siteOrigin: string) => Promise<void>): Promise<void> {
    const port = Number(new URL(o.apiUrl).port) + 2
    const offUrl = `http://127.0.0.1:${port}`
    const logFile = path.join(os.tmpdir(), `site-e2e-links-off-${process.pid}.log`)
    offLogs.push(logFile)
    const fd = fs.openSync(logFile, 'w')
    const siteOrigin = `http://127.0.0.1:${o.offPort}`
    const proc = spawn('pnpm', ['exec', 'tsx', 'src/server.ts'], {
      cwd: o.backend,
      detached: true,
      stdio: ['ignore', fd, fd],
      env: {
        ...process.env,
        NODE_ENV: 'development',
        DATABASE_URL: o.dbUrl,
        DB_SEARCH_PATH: `${o.schema},public`,
        HOST: '127.0.0.1',
        PORT: String(port),
        JOBS_ENABLED: 'false',
        SMS_DISPATCH_MODE: 'inline',
        HOOKS_PORT: '0',
        COOKIE_SECURE: 'false',
        SESSION_SECRET: crypto.randomBytes(32).toString('base64'),
        PUBLIC_API_URL: siteOrigin,
        PUBLIC_DASHBOARD_URL: siteOrigin,
        PUBLIC_SITE_URL: siteOrigin,
        ALLOWED_ORIGINS: siteOrigin,
        // the stack's own pg-boss schema name (live:down --drop removes it); jobs stay off
        PGBOSS_SCHEMA: `pgboss_${o.schema.replace(/^e2e_/, '')}`,
        PUBLIC_LINKS_ENABLED: 'false',
        PIN_PEPPER: '',
      },
    })
    proc.unref()
    off = { proc, proxy: null as unknown as SiteProxy }
    const t0 = Date.now()
    for (;;) {
      try {
        if ((await fetch(`${offUrl}/readyz`, { signal: AbortSignal.timeout(2000) })).status === 200) break
      } catch {
        /* not up yet */
      }
      if (Date.now() - t0 > 90_000) throw new Error(`the links-off API did not start (${logFile})`)
      await new Promise((r) => setTimeout(r, 400))
    }
    if (await stackLinksEnabled(offUrl)) throw new Error('the links-off API answers the link routes')
    off.proxy = await o.startProxy(offUrl, o.offPort)
    o.log(`links off: a second API on ${offUrl} (PUBLIC_LINKS_ENABLED=false), its site host ${off.proxy.origin}`)
    try {
      await fn(off.proxy.origin)
    } finally {
      await stopOff()
    }
  }

  async function stopOff(): Promise<void> {
    if (!off) return
    const { proc, proxy } = off
    off = null
    await proxy?.close()
    for (const target of [-proc.pid!, proc.pid!]) {
      try {
        process.kill(target, 'SIGTERM')
        break
      } catch {
        /* gone */
      }
    }
    for (let i = 0; i < 120; i++) {
      try {
        process.kill(proc.pid!, 0)
      } catch {
        return
      }
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  async function tokenSightings(tokens: string[]): Promise<string[]> {
    if (!tokens.length) return []
    const out: string[] = []
    for (const file of [o.apiLog, ...offLogs]) {
      if (!fs.existsSync(file)) continue
      const text = fs.readFileSync(file, 'utf8')
      const hits = tokens.filter((t) => text.includes(t)).length
      if (hits) out.push(`${path.basename(file)}: ${hits} token(s)`)
    }
    const tables = psql(`select table_name from information_schema.tables where table_schema = ${q(o.schema)} and table_type = 'BASE TABLE' order by 1`).split('\n').filter(Boolean)
    const scan = (values: string[], col: string) => values.map((t) => `strpos(${col}, ${q(t)}) > 0`).join(' or ')
    const any = (col: string) => scan(tokens, col)
    const countsOf = (values: string[]) => psql(tables.map((t) => `select ${q(t)} || ' ' || count(*) from T."${t}" x where ${scan(values, 'x::text')}`).join(' union all '))
    // the scan finds what is there: the link texts' masked message rows ("[private link]") are seen by the same query
    if (!/^messages [1-9]/m.test(countsOf(['[private link]']))) throw new Error('the schema scan does not see the masked link texts in messages')
    const counts = countsOf(tokens)
    for (const line of counts.split('\n')) {
      const [table, n] = line.split(' ')
      if (!table || n === '0') continue
      if (table === 'sms_outbox') {
        // the outbox carries a link text's URL until the text is final, then the body is wiped
        const bad = psql(`select klass || '/' || state from T.sms_outbox where (${any('body')}) and (klass <> 'personal_link' or state in ('delivered', 'failed', 'expired', 'cancelled'))`)
        if (bad) out.push(`sms_outbox: ${bad.split('\n').join(', ')}`)
        continue
      }
      out.push(`${table}: ${n} row(s)`)
    }
    return out
  }

  async function linkTexts(tokens: string[]): Promise<{ queued: number; masked: number; skipped: string[] }> {
    const mine = texts.filter((t) => tokens.includes(t.token))
    const ids = mine.map((t) => t.messageId).filter((x): x is string => !!x)
    let masked = 0
    if (ids.length) {
      const rows = await db.selectFrom('messages').select(['id', 'body']).where('id', 'in', ids).execute()
      masked = rows.filter((r: any) => typeof r.body === 'string' && r.body.includes('[private link]') && !tokens.some((t) => r.body.includes(t))).length
    }
    return { queued: ids.length, masked, skipped: mine.filter((t) => t.skipped).map((t) => t.skipped!) }
  }

  return {
    name: 'stack',
    issue,
    lastCode,
    bookings: async (phone) =>
      Number(psql(`select count(*) from T.appointments a join T.customers c on c.id = a.customer_id where c.phone_e164 = ${q(phone)} and a.source = 'link'`)),
    trusted: async (phone) =>
      psql(`select count(*) from T.phone_trust where phone_e164 = ${q(phone)} and revoked_at is null and expires_at > now()`) !== '0',
    pinIs: async (phone, value) => {
      const r = await db
        .selectFrom('customer_pins as p')
        .innerJoin('customers as c', 'c.id', 'p.customer_id')
        .select(['p.customer_id', 'p.pin_hash'])
        .where('c.phone_e164', '=', phone)
        .executeTakeFirst()
      return !!r?.pin_hash && (await hasher.verify(r.customer_id, value, r.pin_hash))
    },
    planKey: planKeyOf,
    membership: async (phone) => {
      const line = psql(
        `select m.status || '|' || coalesce(k.expected_email, '') || '|' || coalesce(k.plan_key, '') from T.memberships m join T.customers c on c.id = m.customer_id ` +
          `left join T.membership_checkouts k on k.membership_id = m.id where c.phone_e164 = ${q(phone)} order by m.created_at desc limit 1`,
      )
      if (!line) return null
      const [state, email, key] = line.split('|')
      return { state: state!, expectedEmail: email || null, planKey: key || null }
    },
    usage: async (phone) => {
      const line = psql(
        `select l.uses || ' ' || (select count(*) from T.client_link_sessions s where s.link_id = l.id) from T.client_links l where l.phone_e164 = ${q(phone)} order by l.created_at desc limit 1`,
      )
      if (!line) return null
      const [uses, exchanges] = line.split(' ').map(Number)
      return { uses: uses!, exchanges: exchanges! }
    },
    tokenSightings,
    linkTexts,
    serverChecksPayHost: true,
    // the exchange route's own limit (backend src/modules/public/links/http/routes.ts: 20 a minute per address)
    exchangesPerMinute: 20,
    payLinkRequested: async (phone) =>
      psql(
        `select count(*) from T.notifications n join T.invoices i on n.source_ref = 'pay_link_request:' || i.id::text join T.customers c on c.id = i.customer_id where n.kind = 'payments.link_requested' and c.phone_e164 = ${q(phone)}`,
      ) !== '0',
    linksOff,
    close: async () => {
      await stopOff()
      await dbm.destroyDb(db)
    },
  }
}
