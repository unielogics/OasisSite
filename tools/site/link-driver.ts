// The personal-link checks (scripts/e2e-links.ts) run against two link APIs: the fixture's (tools/site/fixture-links.ts,
// in memory) and a live stack's (the real backend, tools/site/stack-links.ts). A LinkDriver is what the checks need from
// either: issue a link the way the shop does (issueClientLink), read what a text carried (the code), and read back what
// the API did (bookings, trust, the PIN, the pending membership, the link's uses) and where a token ever travelled on the
// API side. Never part of the build.
import type { IssueLinkInput } from './fixture-links'

export type { IssueLinkInput }

export interface LinkDriver {
  name: 'fixture' | 'stack'
  /** Issues a link to `i.phone` (creating the client, membership, trust, PIN, invoice or plan the input asks for). */
  issue(i: IssueLinkInput, siteOrigin: string): Promise<{ token: string; url: string }>
  /** The six digits of the newest code texted to `phone`. */
  lastCode(phone: string): Promise<string>
  /** How many visits the number has booked through links. */
  bookings(phone: string): Promise<number>
  /** The number holds a live 30-day trust. */
  trusted(phone: string): Promise<boolean>
  /** The number's client has exactly this PIN now. */
  pinIs(phone: string, pin: string): Promise<boolean>
  /** The plan key a membership link of this tier joins (the fixture's own key, the backend's dashboard plan). */
  planKey(tier: 'gold' | 'vip'): string
  /** The newest membership of the number's client and the checkout intent the link opened. */
  membership(phone: string): Promise<{ state: string; expectedEmail: string | null; planKey: string | null } | null>
  /** The newest link of the number: completions (uses) and sessions it was exchanged for. */
  usage(phone: string): Promise<{ uses: number; exchanges: number } | null>
  /**
   * Where the API side kept one of these tokens outside the body of an exchange (the fixture's request log; a stack's
   * server logs and every row of its schema, a link text's outbox body only while it is not final).
   */
  tokenSightings(tokens: string[]): Promise<string[]>
  /** The link texts this driver queued: their message rows show the link masked, never the token. */
  linkTexts(tokens: string[]): Promise<{ queued: number; masked: number; skipped: string[] }>
  /**
   * True when the API itself refuses a payment URL off its allowlist ({status: link_pending} and a note to the managers);
   * the fixture hands any URL back so the page's own allowlist can be shown.
   */
  serverChecksPayHost: boolean
  /** The API's limit on exchanges a minute from one address (the e2e paces itself under it), when it has one. */
  exchangesPerMinute?: number
  /** The managers were asked to text the number a payment link (the API's link_pending answer). */
  payLinkRequested(phone: string): Promise<boolean>
  /** Runs `fn` with the link API switched off (PUBLIC_LINKS_ENABLED=false); `fn` gets the site's origin to use. */
  linksOff(fn: (siteOrigin: string) => Promise<void>): Promise<void>
}

/** The fixture API's link routes (tools/site/fixture-links.ts) as a LinkDriver. */
export function fixtureLinkDriver(L: import('./fixture-links').LinkFixture, siteOrigin: string): LinkDriver {
  return {
    name: 'fixture',
    issue: async (i, origin) => L.issue(i, origin),
    lastCode: async () => {
      const s = L.snapshot()
      return s.codes[s.codes.length - 1]?.code ?? ''
    },
    bookings: async (phone) => L.snapshot().bookings.filter((b) => b.phone === phone).length,
    trusted: async (phone) => !!L.snapshot().trust[phone],
    pinIs: async (phone, pin) => L.pinOf(phone) === pin,
    planKey: (tier) => tier,
    membership: async (phone) => {
      const s = L.snapshot()
      const m = s.memberships.filter((x) => x.phone === phone).at(-1)
      const c = s.checkouts.filter((x) => x.phone === phone).at(-1)
      return m ? { state: m.state, expectedEmail: c?.expectedEmail ?? null, planKey: c?.planKey ?? m.planKey } : null
    },
    usage: async (phone) => {
      const l = L.snapshot().links.filter((x) => x.phone === phone).at(-1)
      return l ? { uses: l.uses, exchanges: l.exchanges } : null
    },
    tokenSightings: async (tokens) =>
      L.state.log
        .filter((l) => tokens.some((t) => l.path.includes(t) || JSON.stringify(l.headers).includes(t) || (l.body.includes(t) && !l.path.endsWith('/exchange'))))
        .map((l) => `fixture request log: ${l.method} ${l.path}`),
    linkTexts: async () => ({ queued: 0, masked: 0, skipped: [] }),
    serverChecksPayHost: false,
    payLinkRequested: async () => false,
    linksOff: async (fn) => {
      L.state.enabled = false
      try {
        await fn(siteOrigin)
      } finally {
        L.state.enabled = true
      }
    },
  }
}
