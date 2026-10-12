// Personal links on the website (DEVIATIONS.md DV-LINK, DV-STEPUP, DV-LINK-JOIN, DV-LINK-PAY, DV-LINK-DEAD, DV-LINK-CARD): the link
// API's shapes, the checks on what it answers, and the words the page shows. Pure helpers; the flows live in the
// "links" section of index.bridge.ts and the token capture in src/client/link.ts.
//
// The API is the backend's personal-link API (backend docs/api-spec.md section 28, ADR 0160 W3c; design
// docs/design/ai-assistant-and-phone-identity.md section 5; the routes this site calls are listed in docs/site.md
// "Personal links"): everything under /api/v1/public/links, JSON only, the session as `Authorization: Bearer <session>`,
// never cached. 404 on every route while PUBLIC_LINKS_ENABLED is off. The shapes below are the API's `LinkState`
// (section 28.2) field for field; the fixture (tools/site/fixture-links.ts) answers the same.

export type LinkKind = 'calendar' | 'verify' | 'pin' | 'membership' | 'pay' | 'book_again' | 'card'
export type LinkDeadReason = 'not_found' | 'expired' | 'used' | 'revoked'

export interface LinkClient {
  /** the client's first name; null for a stranger's link, a name the shop does not have yet, or a record the
   *  stale-record rule hides until the page is verified (the API sends '' for all three) */
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

export interface LinkStepUp {
  /** pin: the client has a PIN (enter it, or reset it with a code); code: a texted code */
  method: 'pin' | 'code'
  /** until when the last PIN or code entered on this page counts as fresh (memberships, payments); null when none */
  freshUntil: string | null
  /** a code confirmed on this page lets it choose a PIN (a new one after a reset code) until then; null otherwise */
  canSetPinUntil: string | null
}

export interface LinkInvoice {
  /** the invoice number (the dashboard's invoice_no) */
  number: number | null
  /** the shop's calendar date of the visit, YYYY-MM-DD */
  date: string | null
  items: { name: string; priceCents: number }[]
  subtotalCents: number
  taxCents: number
  tipCents: number
  totalCents: number
  paidCents: number
  balanceCents: number
}

export interface LinkPlan {
  /** the website tier of the plan (gold | vip), null for a plan the website does not show */
  tier: 'gold' | 'vip' | null
  /** the Settings catalog's plan key */
  planKey: string
  /** the public label */
  name: string
  monthlyPriceCents: number | null
  perks: string[]
  /** how the page joins (ADR 0171 wave Q3b): square = a card and the consent here (membership/subscribe); squarespace = the checkout */
  billing: 'square' | 'squarespace'
  /** the tier's monthly price at each size it is sold at; joinable: set up at Square (always true for squarespace) */
  prices: { class: string; label: string; monthlyCents: number; joinable: boolean }[]
}

/** What a saved card may be charged for (the API's card consent purposes, in the order the consent text lists them). */
export type CardPurpose = 'membership_billing' | 'no_show_fee' | 'late_cancel_fee' | 'balance'
export const CARD_PURPOSES: readonly CardPurpose[] = ['membership_billing', 'no_show_fee', 'late_cancel_fee', 'balance']

/** One of the client's saved cards (ADR 0171 D7): never a card number, only Square's id of it, brand, last 4 and expiry. */
export interface LinkCard {
  id: string
  brand: string | null
  last4: string | null
  expMonth: number | null
  expYear: number | null
  /** what the client's live consents allow it to be charged for */
  purposes: CardPurpose[]
}

/** What a card or membership page needs to take a card (the API's cardSetup; null while saved cards are off). */
export interface CardSetup {
  consent: {
    /** sent back as consentVersion */
    version: string
    /** the wording, `{purposes}` where the purposes go ("a, b and c") */
    text: string
    purposes: { key: CardPurpose; words: string }[]
  }
  /** Square's Web Payments SDK settings (no secret); null when Square is not configured */
  square: { applicationId: string; locationId: string; environment: 'sandbox' | 'production'; sdkUrl: string } | null
}

/** What the exchange, GET me and every verification step answer (the API's LinkState). */
export interface LinkState {
  expiresAt: string
  kind: LinkKind
  client: LinkClient
  trust: LinkTrust
  stepUp: LinkStepUp
  invoice: LinkInvoice | null
  plan: LinkPlan | null
  /** the client's active saved cards (card and membership pages, verified, the client proven); null otherwise */
  cards: LinkCard[] | null
  /** the consent wording and Square's SDK settings (card and membership pages while saved cards are on); null otherwise */
  cardSetup: CardSetup | null
}

export interface Exchanged extends LinkState {
  session: string
}

const KINDS: LinkKind[] = ['calendar', 'verify', 'pin', 'membership', 'pay', 'book_again', 'card']

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const cents = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0)
const tierOf = (v: unknown): 'gold' | 'vip' | null => (v === 'gold' || v === 'vip' ? v : null)
const SIZE_KEY = /^[a-z][a-z0-9_]{0,31}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const intIn = (v: unknown, min: number, max: number): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null)
const purposeOf = (v: unknown): CardPurpose | null => (CARD_PURPOSES as readonly unknown[]).includes(v) ? (v as CardPurpose) : null

/** The saved cards of a state, checked (a malformed row is dropped). */
function cardsOf(x: unknown): LinkCard[] | null {
  if (!Array.isArray(x)) return null
  return x.flatMap((c) => {
    const o = (c ?? {}) as Record<string, unknown>
    if (typeof o.id !== 'string' || !UUID.test(o.id)) return []
    const brand = typeof o.brand === 'string' && /^[A-Z0-9_ ]{1,40}$/i.test(o.brand) ? o.brand : null
    const last4 = typeof o.last4 === 'string' && /^\d{4}$/.test(o.last4) ? o.last4 : null
    const purposes = Array.isArray(o.purposes) ? o.purposes.map(purposeOf).filter((p): p is CardPurpose => !!p) : []
    return [{ id: o.id, brand, last4, expMonth: intIn(o.expMonth, 1, 12), expYear: intIn(o.expYear, 2000, 2100), purposes }]
  })
}

/**
 * The card setup of a state, checked: null unless the consent wording has a version, a text with the {purposes} place and
 * the purposes' words. The box is unchecked on the page whatever the API says (`checkedByDefault` is not read).
 */
function cardSetupOf(x: unknown): CardSetup | null {
  if (!x || typeof x !== 'object') return null
  const o = x as Record<string, unknown>
  const c = (o.consent ?? {}) as Record<string, unknown>
  if (typeof c.version !== 'string' || !/^v\d{1,4}$/.test(c.version)) return null
  if (typeof c.text !== 'string' || !c.text.includes('{purposes}') || c.text.length > 2000) return null
  const purposes = Array.isArray(c.purposes)
    ? c.purposes.flatMap((p) => {
        const q = (p ?? {}) as Record<string, unknown>
        const key = purposeOf(q.key)
        return key && typeof q.words === 'string' && q.words.trim() && q.words.length <= 120 ? [{ key, words: q.words.trim() }] : []
      })
    : []
  if (!purposes.length) return null
  const sq = (o.square ?? null) as Record<string, unknown> | null
  const id = /^[A-Za-z0-9_-]{1,120}$/
  const square =
    sq && typeof sq.applicationId === 'string' && id.test(sq.applicationId) && typeof sq.locationId === 'string' && id.test(sq.locationId) && typeof sq.sdkUrl === 'string' && sq.sdkUrl.length <= 300
      ? { applicationId: sq.applicationId, locationId: sq.locationId, environment: sq.environment === 'production' ? ('production' as const) : ('sandbox' as const), sdkUrl: sq.sdkUrl }
      : null
  return { consent: { version: c.version, text: c.text, purposes }, square }
}

/** A plan's monthly prices by size, checked (a malformed row is dropped). */
function planPricesOf(x: unknown): LinkPlan['prices'] {
  if (!Array.isArray(x)) return []
  return x.flatMap((r) => {
    const o = (r ?? {}) as Record<string, unknown>
    const cls = typeof o.class === 'string' && SIZE_KEY.test(o.class) ? o.class : null
    const label = typeof o.label === 'string' && o.label.trim() && o.label.length <= 40 ? o.label.trim() : null
    const monthlyCents = intIn(o.monthlyCents, 1, 10_000_000)
    return cls && label && monthlyCents !== null ? [{ class: cls, label, monthlyCents, joinable: o.joinable === true }] : []
  })
}

/** A page state (exchange, me, a step's answer), checked; throws on a shape the page cannot use. */
export function validateState(x: unknown): LinkState {
  const o = (x ?? {}) as Record<string, unknown>
  const kind = str(o.kind) as LinkKind | null
  if (!kind || !KINDS.includes(kind)) throw new Error('link state: an unknown kind')
  const c = (o.client ?? {}) as Record<string, unknown>
  const last2 = String(c.last2 ?? '').replace(/\D/g, '').slice(-2)
  const t = (o.trust ?? {}) as Record<string, unknown>
  const su = (o.stepUp ?? {}) as Record<string, unknown>
  const inv = o.invoice && typeof o.invoice === 'object' ? (o.invoice as Record<string, unknown>) : null
  const plan = o.plan && typeof o.plan === 'object' ? (o.plan as Record<string, unknown>) : null
  return {
    expiresAt: str(o.expiresAt) ?? '',
    kind,
    client: { firstName: str(c.firstName)?.trim() || null, last2, tier: tierOf(c.tier) },
    trust: { verified: t.verified === true, until: str(t.until) },
    stepUp: { method: su.method === 'pin' ? 'pin' : 'code', freshUntil: str(su.freshUntil), canSetPinUntil: str(su.canSetPinUntil) },
    invoice: inv
      ? {
          number: typeof inv.number === 'number' && Number.isFinite(inv.number) ? inv.number : null,
          date: str(inv.date),
          items: Array.isArray(inv.items)
            ? (inv.items as Record<string, unknown>[]).map((l) => ({ name: String(l?.name ?? ''), priceCents: cents(l?.priceCents) }))
            : [],
          subtotalCents: cents(inv.subtotalCents),
          taxCents: cents(inv.taxCents),
          tipCents: cents(inv.tipCents),
          totalCents: cents(inv.totalCents),
          paidCents: cents(inv.paidCents),
          balanceCents: cents(inv.balanceCents),
        }
      : null,
    plan: plan
      ? {
          tier: tierOf(plan.tier),
          planKey: String(plan.planKey ?? ''),
          name: String(plan.name ?? ''),
          monthlyPriceCents: typeof plan.monthlyPriceCents === 'number' ? plan.monthlyPriceCents : null,
          perks: Array.isArray(plan.perks) ? plan.perks.filter((p): p is string => typeof p === 'string') : [],
          billing: plan.billing === 'square' ? 'square' : 'squarespace',
          prices: planPricesOf(plan.prices),
        }
      : null,
    cards: cardsOf(o.cards),
    cardSetup: cardSetupOf(o.cardSetup),
  }
}

/** The exchange answer (`{session, ...LinkState}`), checked; throws on a shape the page cannot use. */
export function validateExchange(x: unknown): Exchanged {
  const session = str((x as { session?: unknown } | null)?.session)
  if (!session) throw new Error('exchange: no session')
  return { session, ...validateState(x) }
}

/**
 * The website tier a membership link's plan opens (the design's join page has Gold and VIP): the plan's own tier, else
 * its key through site.config.json catalog.plans (design id -> plan key). null: a plan the website cannot show, so the
 * page sends the client to a text instead of guessing a plan.
 */
export function planTier(plan: LinkPlan | null | undefined, plans: Record<string, string> = {}): 'gold' | 'vip' | null {
  if (!plan) return null
  if (plan.tier) return plan.tier
  const id = Object.keys(plans).find((k) => plans[k] === plan.planKey)
  return id === 'gold' || id === 'vip' ? id : null
}

/** "Thu, Oct 9" for an invoice's shop date (YYYY-MM-DD); '' when there is none. */
export function shopDate(ymd: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd ?? '')
  if (!m) return ''
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(t)
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
 * (squarespace.com: the membership checkouts and the invoice payment links; square.link and square.site: Square's
 * payment links, ADR 0171). Anything else is refused on the page, whatever the server answered.
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

/** Step-up purposes of POST /links/verify/code (the API's CodeBody: verify | pin_set | pin_reset). */
export type StepUpPurpose = 'verify' | 'pin_set' | 'pin_reset'

/** A PIN the server will look at: 4 to 6 digits (the server owns the blocklist). */
export const PIN_RE = /^\d{4,6}$/

/** Whose secure checkout a payment URL opens ("Square's", "Squarespace's"), for the page's words; '' for neither. */
export function checkoutName(url: unknown): string {
  try {
    const h = new URL(String(url)).hostname.toLowerCase()
    if (h === 'squarespace.com' || h.endsWith('.squarespace.com')) return 'Squarespace’s'
    if (/(^|\.)(square\.link|square\.site|squareup\.com|squareupsandbox\.com)$/.test(h)) return 'Square’s'
  } catch {
    /* not a URL */
  }
  return ''
}

/** "a, b and c" (the consent's purposes, as the API joins them). */
export function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join('')
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

/** The consent text for these purposes: the API's wording with `{purposes}` filled in its own order. */
export function consentText(setup: CardSetup, purposes: readonly CardPurpose[]): string {
  const words = setup.consent.purposes.filter((p) => purposes.includes(p.key)).map((p) => p.words)
  // a replacer function: the words are the API's text, never a replacement pattern ("$&")
  return setup.consent.text.replace('{purposes}', () => listWords(words))
}

/** "Visa ••4242" for a saved card (Square's brand names: VISA, MASTERCARD, AMERICAN_EXPRESS, ...). */
export function cardLabel(c: Pick<LinkCard, 'brand' | 'last4'>): string {
  const BRAND: Record<string, string> = { VISA: 'Visa', MASTERCARD: 'Mastercard', AMERICAN_EXPRESS: 'Amex', DISCOVER: 'Discover', DISCOVER_DINERS: 'Diners', JCB: 'JCB', CHINA_UNIONPAY: 'UnionPay', INTERAC: 'Interac', EFTPOS: 'eftpos' }
  const b = c.brand ? (BRAND[c.brand.toUpperCase()] ?? 'Card') : 'Card'
  return c.last4 ? `${b} ••${c.last4}` : b
}
