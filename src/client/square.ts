// Square's Web Payments SDK on the personal link pages only (DEVIATIONS.md DV-LINK-CARD; backend ADR 0171 D7, D8 and D12: card
// data only ever enters Square's own iframes, which keeps the site in PCI SAQ-A scope).
//
// Nothing about Square is baked into the build: the SDK's URL, the application id and the location come from the link API's
// `cardSetup.square` at runtime, and the SDK is loaded LAZILY, the first time a page shows a card form (a card page #/k, a
// membership page billed by Square #/m). The URL must be https on site.config.json `links.squareSdkHosts` (Square's CDNs:
// web.squarecdn.com, sandbox.web.squarecdn.com) or the page's own origin (the e2e's stub SDK; the site's CSP allows 'self'
// scripts anyway); anything else is refused before any request. The production CSP (the backend kit's install.sh SITE_CSP)
// lets the SDK's script, frames, styles, fonts and calls through.
//
// The SDK's surface used here (Web Payments SDK v1): Square.payments(appId, locationId).card() -> attach(element) /
// tokenize(verificationDetails) -> { status: 'OK', token } | { status, errors } / destroy(). The verification details carry
// intent STORE (the card is saved, not charged here), customerInitiated true, sellerKeyedIn false and the billing contact,
// so Square runs its buyer verification (3-D Secure) inside tokenize.

export interface SquareSetup {
  applicationId: string
  locationId: string
  environment: 'sandbox' | 'production'
  sdkUrl: string
}

export interface BillingContact {
  givenName?: string
  familyName?: string
  email?: string
}

/** The one-time token of a card (CreateCard's source_id) and, when the SDK gives one, its verification token. */
export interface CardToken {
  sourceId: string
  verificationToken?: string
}

export interface CardForm {
  tokenize(contact: BillingContact): Promise<CardToken>
  destroy(): Promise<void>
}

/** Why a card form could not load or a card could not be read (the message is written for the client). */
export class CardFormError extends Error {
  constructor(
    message: string,
    readonly kind: 'blocked' | 'load' | 'input',
  ) {
    super(message)
  }
}

/** The SDK's global (only what is used here). */
interface SquareSdk {
  payments(applicationId: string, locationId: string): {
    card(): Promise<{
      attach(el: HTMLElement | string): Promise<void>
      tokenize(details: unknown): Promise<{ status?: string; token?: string; errors?: unknown[]; details?: { verificationToken?: unknown } }>
      destroy(): Promise<unknown>
    }>
  }
}

/** The client's words when the form does not load or a card is not read. */
export const CARD_WORDS = {
  blocked: 'The card form can’t load on this page. Text us and we’ll help.',
  load: 'The card form didn’t load. Check your connection and try again.',
  input: 'Check your card details and try again.',
} as const

/** A URL the page may load Square's SDK from: https on one of `hosts` (or a subdomain), or the page's own origin. */
export function sdkUrlAllowed(url: unknown, hosts: readonly string[], origin: string): boolean {
  if (typeof url !== 'string' || url.length > 300) return false
  let u: URL
  try {
    u = new URL(url, origin)
  } catch {
    return false
  }
  if (u.username || u.password) return false
  if (u.origin === origin) return true
  if (u.protocol !== 'https:' || (u.port && u.port !== '443')) return false
  const h = u.hostname.toLowerCase()
  return hosts.some((x) => h === x.toLowerCase() || h.endsWith('.' + x.toLowerCase()))
}

type Win = Window & typeof globalThis
let loading: { url: string; p: Promise<SquareSdk> } | null = null

/** Loads the SDK once (a second form on the page reuses it); rejects with a CardFormError. */
export function loadSquareSdk(url: string, w: Win = window, timeoutMs = 20_000): Promise<SquareSdk> {
  const have = (w as unknown as { Square?: SquareSdk }).Square
  if (have && typeof have.payments === 'function') return Promise.resolve(have)
  if (loading && loading.url === url) return loading.p
  const p = new Promise<SquareSdk>((resolve, reject) => {
    const s = w.document.createElement('script')
    const t = w.setTimeout(() => reject(new CardFormError(CARD_WORDS.load, 'load')), timeoutMs)
    s.src = url
    s.async = true
    s.onload = () => {
      w.clearTimeout(t)
      const sq = (w as unknown as { Square?: SquareSdk }).Square
      if (sq && typeof sq.payments === 'function') resolve(sq)
      else reject(new CardFormError(CARD_WORDS.load, 'load'))
    }
    s.onerror = () => {
      w.clearTimeout(t)
      reject(new CardFormError(CARD_WORDS.load, 'load'))
    }
    w.document.head.appendChild(s)
  })
  loading = { url, p }
  p.catch(() => {
    if (loading?.p === p) loading = null
  })
  return p
}

/** Square's card form attached to `el`; tokenize() answers the card's one-time token (intent STORE). */
export async function mountCard(sdk: SquareSdk, setup: SquareSetup, el: HTMLElement): Promise<CardForm> {
  let card: Awaited<ReturnType<ReturnType<SquareSdk['payments']>['card']>>
  try {
    card = await sdk.payments(setup.applicationId, setup.locationId).card()
    await card.attach(el)
  } catch {
    throw new CardFormError(CARD_WORDS.load, 'load')
  }
  return {
    async tokenize(contact: BillingContact): Promise<CardToken> {
      let r: Awaited<ReturnType<typeof card.tokenize>>
      try {
        r = await card.tokenize({ intent: 'STORE', customerInitiated: true, sellerKeyedIn: false, billingContact: contact })
      } catch {
        throw new CardFormError(CARD_WORDS.input, 'input')
      }
      if (r && r.status === 'OK' && typeof r.token === 'string' && r.token.length > 0 && r.token.length <= 512) {
        const v = r.details?.verificationToken
        return { sourceId: r.token, ...(typeof v === 'string' && v.length <= 4096 ? { verificationToken: v } : {}) }
      }
      throw new CardFormError(CARD_WORDS.input, 'input')
    },
    async destroy(): Promise<void> {
      try {
        await card.destroy()
      } catch {
        /* already gone */
      }
    },
  }
}

/** Tests: forget the SDK load in flight. */
export function resetSquareLoader(): void {
  loading = null
}
