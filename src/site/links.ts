// Personal links on the website (DEVIATIONS.md DV-LINK, DV-STEPUP, DV-LINK-JOIN, DV-LINK-PAY, DV-LINK-DEAD): the link
// API's shapes, the checks on what it answers, and the words the page shows. Pure helpers; the flows live in the
// "links" section of index.bridge.ts and the token capture in src/client/link.ts.
//
// The API (backend design docs/design/ai-assistant-and-phone-identity.md section 5; the routes this site calls are
// listed in docs/site.md "Personal links"): everything under /api/v1/public/links, JSON only, the session as
// `Authorization: Bearer <session>`, never cached. 404 on every route while PUBLIC_LINKS_ENABLED is off.

export type LinkKind = 'calendar' | 'verify' | 'pin' | 'membership' | 'pay' | 'book_again'
export type LinkDeadReason = 'not_found' | 'expired' | 'used' | 'revoked'

export interface LinkClient {
  /** the client's first name (null for a stranger's calendar link) */
  firstName: string | null
  /** the last two digits of the number the link was texted to */
  last2: string
  /** an active membership's tier, else null */
  tier: 'gold' | 'vip' | null
}

export interface LinkTrust {
  /** the page is verified: the number's 30-day trust is live, or a PIN / code was entered on this page */
  verified: boolean
  /** ISO instant the number's trust ends (null when not trusted) */
  until: string | null
}

export interface LinkInvoice {
  number: string
  /** what the invoice is for, e.g. "Signature Hand Wash · Oct 9" */
  title: string | null
  totalCents: number
  balanceCents: number
  lines: { label: string; amountCents: number }[]
}

export interface LinkPlan {
  /** the website's plan key (site.config.json catalog.plans): gold | vip */
  key: string
  label: string
  monthlyPriceCents: number | null
}

export interface Exchanged {
  session: string
  expiresAt: string
  kind: LinkKind
  client: LinkClient
  trust: LinkTrust
  invoice: LinkInvoice | null
  plan: LinkPlan | null
  /** whether the client has a PIN (optional in the answer; unknown = null, the page then starts with a code) */
  pin: 'set' | 'none' | null
}

const KINDS: LinkKind[] = ['calendar', 'verify', 'pin', 'membership', 'pay', 'book_again']

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const cents = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0)

/** The exchange answer, checked; throws on a shape the page cannot use. */
export function validateExchange(x: unknown): Exchanged {
  const o = (x ?? {}) as Record<string, unknown>
  const session = str(o.session)
  const kind = str(o.kind) as LinkKind | null
  if (!session || !kind || !KINDS.includes(kind)) throw new Error('exchange: no session or an unknown kind')
  const c = (o.client ?? {}) as Record<string, unknown>
  const last2 = String(c.last2 ?? '').replace(/\D/g, '').slice(-2)
  const tier = c.tier === 'gold' || c.tier === 'vip' ? c.tier : null
  const t = (o.trust ?? {}) as Record<string, unknown>
  const inv = o.invoice && typeof o.invoice === 'object' ? (o.invoice as Record<string, unknown>) : null
  const plan = o.plan && typeof o.plan === 'object' ? (o.plan as Record<string, unknown>) : null
  return {
    session,
    expiresAt: str(o.expiresAt) ?? '',
    kind,
    client: { firstName: str(c.firstName)?.trim() || null, last2, tier },
    trust: { verified: t.verified === true, until: str(t.until) },
    invoice: inv
      ? {
          number: str(inv.number) ?? '',
          title: str(inv.title),
          totalCents: cents(inv.totalCents),
          balanceCents: cents(inv.balanceCents),
          lines: Array.isArray(inv.lines)
            ? (inv.lines as Record<string, unknown>[]).map((l) => ({ label: String(l?.label ?? ''), amountCents: cents(l?.amountCents) }))
            : [],
        }
      : null,
    plan: plan ? { key: String(plan.key ?? ''), label: String(plan.label ?? plan.key ?? ''), monthlyPriceCents: typeof plan.monthlyPriceCents === 'number' ? plan.monthlyPriceCents : null } : null,
    pin: o.pin === 'set' || o.pin === 'none' ? o.pin : null,
  }
}

/** "MARIA ••51" (the eyebrow's who); "••51" for a stranger. */
export function whoLabel(c: LinkClient): string {
  const dots = c.last2 ? `••${c.last2}` : ''
  return [c.firstName ? c.firstName.toUpperCase() : '', dots].filter(Boolean).join(' ')
}

/** "Maria ••51" for running text. */
export function whoText(c: LinkClient): string {
  const dots = c.last2 ? `••${c.last2}` : ''
  return [c.firstName ?? '', dots].filter(Boolean).join(' ')
}

/**
 * A redirect the page may follow: https, no credentials, and a host that is one of `hosts` or a subdomain of one
 * (squarespace.com: the membership checkouts and the invoice payment links). Anything else is refused on the page,
 * whatever the server answered.
 */
export function allowedRedirect(url: unknown, hosts: string[]): boolean {
  if (typeof url !== 'string' || url.length > 2048) return false
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false
  const h = u.hostname.toLowerCase().replace(/\.$/, '')
  return hosts.some((x) => {
    const want = x.toLowerCase()
    return h === want || h.endsWith('.' + want)
  })
}

/** $54 or $54.50 */
export function money(c: number): string {
  const v = c / 100
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })
}

/** "Nov 9" for the end of the number's trust (the shop's calendar date). */
export function trustDate(iso: string | null, tz: string): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  try {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: tz }).format(t)
  } catch {
    return ''
  }
}

/** The dead-link states: the sheet's title and the line under it (owner-facing tone: plain, short, friendly). */
export const DEAD_COPY: Record<LinkDeadReason | 'locked', { title: string; text: string }> = {
  expired: { title: 'This link expired', text: 'Links from our texts work for a limited time. Text us and we’ll send you a new one.' },
  used: { title: 'This link was used', text: 'This link was already used, so it can’t be opened again. Text us if you need a new one.' },
  revoked: { title: 'This link was replaced', text: 'We sent you a newer link, or this one was turned off. Use the newest text from us, or text us for a new one.' },
  not_found: { title: 'This link doesn’t work', text: 'We couldn’t find this link. Check that you opened the whole link from our text, or text us for a new one.' },
  locked: { title: 'Too many tries', text: 'Too many wrong tries on this page. Open the link from our text again later, or text us for help.' },
}

export function deadReason(meta: unknown): LinkDeadReason {
  const r = (meta as { reason?: unknown } | null)?.reason
  return r === 'expired' || r === 'used' || r === 'revoked' || r === 'not_found' ? r : 'not_found'
}

/** Step-up purposes of POST /links/verify/code. */
export type StepUpPurpose = 'link_verify' | 'pin_set' | 'pin_reset'

/** A PIN the server will look at: 4 to 6 digits (the server owns the blocklist). */
export const PIN_RE = /^\d{4,6}$/
