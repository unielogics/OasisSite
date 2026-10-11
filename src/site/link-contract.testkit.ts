/* eslint-disable @typescript-eslint/no-explicit-any */
// The backend's personal-link API contract, for the site's tests and the fixture's (never part of the build): backend
// docs/api-spec.md section 28 and src/modules/public/links/http/schemas.ts (W3c, branch ws/ai-w3-links at eb2fd4d),
// copied here as the key lists of every answer the site reads and the enums of what it sends. The bridge tests build
// their answers with `linkState` and the fixture's answers are checked against the lists
// (tools/site/fixture-links.test.ts), so the page, the fixture and the API cannot drift apart unnoticed.
// When the API's schemas change, change this file first.

/** LinkStateView: what the exchange (plus `session`), GET me and every verification step (plus `verified`) answer. */
export const LINK_STATE_KEYS = ['kind', 'expiresAt', 'idleExpiresAt', 'link', 'client', 'trust', 'stepUp', 'appointments', 'invoice', 'plan']
export const CLIENT_KEYS = ['firstName', 'last2', 'tier']
export const TRUST_KEYS = ['verified', 'by', 'until']
export const STEP_UP_KEYS = ['method', 'freshUntil', 'canSetPinUntil']
export const APPOINTMENT_KEYS = ['ref', 'start', 'end', 'when', 'service', 'addons', 'status', 'canReschedule']
export const INVOICE_KEYS = ['number', 'date', 'items', 'subtotalCents', 'taxCents', 'tipCents', 'totalCents', 'paidCents', 'balanceCents']
export const INVOICE_ITEM_KEYS = ['name', 'priceCents']
export const PLAN_KEYS = ['tier', 'planKey', 'name', 'monthlyPriceCents', 'perks']
/** CodeBody.purpose (the default is verify) and CodeRequested. */
export const CODE_PURPOSES = ['verify', 'pin_set', 'pin_reset']
export const CODE_REQUESTED_KEYS = ['challengeId', 'expiresInSec', 'purpose', 'to']
/** BookingBody (strict) and BookingResult. */
export const BOOKING_BODY_KEYS = ['serviceKey', 'addonKeys', 'date', 'startMin', 'vehicle', 'name', 'email', 'smsConsent']
export const VEHICLE_BODY_KEYS = ['year', 'make', 'model', 'color', 'label', 'plate']
export const BOOKING_RESULT_KEYS = ['bookingRef', 'status', 'start', 'end', 'deposit', 'confirmationBy', 'service', 'addons', 'when', 'member', 'bayCount']
export const RESCHEDULE_RESULT_KEYS = ['bookingRef', 'status', 'start', 'end', 'when']
/** MembershipStartBody (strict) and MembershipStartResult. */
export const MEMBERSHIP_BODY_KEYS = ['email', 'vehicles']
export const MEMBERSHIP_RESULT_KEYS = ['redirectUrl', 'membershipRef', 'checkoutExpiresAt']
/** PayStartResult. */
export const PAY_RESULT_KEYS = ['status', 'redirectUrl']

const sameKeys = (where: string, x: unknown, keys: string[], out: string[]): void => {
  if (!x || typeof x !== 'object') {
    out.push(`${where}: not an object`)
    return
  }
  const got = Object.keys(x).sort()
  const want = [...keys].sort()
  if (JSON.stringify(got) !== JSON.stringify(want)) out.push(`${where}: keys ${got.join(',')} != ${want.join(',')}`)
}

/** What differs between an answer and the API's LinkState (plus `extra` top-level keys such as session or verified). */
export function linkStateProblems(x: unknown, extra: string[] = []): string[] {
  const out: string[] = []
  sameKeys('state', x, [...LINK_STATE_KEYS, ...extra], out)
  const o = (x ?? {}) as Record<string, any>
  sameKeys('link', o.link, ['expiresAt'], out)
  sameKeys('client', o.client, CLIENT_KEYS, out)
  if (typeof o.client?.firstName !== 'string') out.push('client.firstName: not a string')
  sameKeys('trust', o.trust, TRUST_KEYS, out)
  sameKeys('stepUp', o.stepUp, STEP_UP_KEYS, out)
  if (o.stepUp?.method !== 'pin' && o.stepUp?.method !== 'code') out.push(`stepUp.method: ${o.stepUp?.method}`)
  if (o.appointments !== null) {
    if (!Array.isArray(o.appointments)) out.push('appointments: neither null nor a list')
    else o.appointments.forEach((a: unknown, i: number) => sameKeys(`appointments[${i}]`, a, APPOINTMENT_KEYS, out))
  }
  if (o.invoice !== null) {
    sameKeys('invoice', o.invoice, INVOICE_KEYS, out)
    if (typeof o.invoice?.number !== 'number') out.push('invoice.number: not a number')
    for (const [i, it] of (o.invoice?.items ?? []).entries()) sameKeys(`invoice.items[${i}]`, it, INVOICE_ITEM_KEYS, out)
  }
  if (o.plan !== null) sameKeys('plan', o.plan, PLAN_KEYS, out)
  return out
}

export function keyProblems(where: string, x: unknown, keys: string[]): string[] {
  const out: string[] = []
  sameKeys(where, x, keys, out)
  return out
}

export interface LinkStateOpts {
  kind?: string
  tier?: 'gold' | 'vip' | null
  /** the page is verified (by the number's trust unless `by` says otherwise) */
  verified?: boolean
  by?: 'pin' | 'code' | null
  /** null: '' in the answer (a stranger, a placeholder name, a record the stale rule hides) */
  firstName?: string | null
  /** the client has a PIN (stepUp.method 'pin') */
  pin?: 'set' | 'none'
  /** a PIN or code entered on this page counts as fresh */
  fresh?: boolean
  /** the page may choose a PIN now (after a code) */
  canSetPin?: boolean
  invoice?: unknown
  plan?: unknown
}

/** A LinkState in the API's exact shape (instants around 2026-10-10 10:00 New York). */
export function linkState(o: LinkStateOpts = {}): Record<string, unknown> {
  const verified = !!o.verified
  return {
    kind: o.kind ?? 'calendar',
    expiresAt: '2026-10-10T15:00:00.000Z',
    idleExpiresAt: '2026-10-10T14:15:00.000Z',
    link: { expiresAt: '2026-10-13T14:00:00.000Z' },
    client: { firstName: o.firstName === undefined ? 'Maria' : (o.firstName ?? ''), last2: '51', tier: o.tier ?? null },
    trust: { verified, by: verified ? (o.by ?? null) : null, until: verified ? '2026-11-09T14:00:00.000Z' : null },
    stepUp: {
      method: o.pin === 'set' ? 'pin' : 'code',
      freshUntil: o.fresh ? '2026-10-10T14:05:00.000Z' : null,
      canSetPinUntil: o.canSetPin ? '2026-10-10T14:10:00.000Z' : null,
    },
    appointments: verified ? [] : null,
    invoice: o.invoice ?? null,
    plan: o.plan ?? null,
  }
}

/** The exchange's answer: `{session, ...LinkState}`. */
export const exchangeAnswer = (o: LinkStateOpts = {}, session = 'sess-1') => ({ session, ...linkState(o) })

/** A verification step's answer: `{verified, ...LinkState}` (a verifying step is fresh and verified by its method). */
export const stepAnswer = (o: LinkStateOpts = {}, verified = true) => ({ verified, ...linkState({ verified, fresh: verified, ...o }) })

/** An InvoiceView. */
export function invoiceAnswer(o: { number?: number; date?: string; items?: { name: string; priceCents: number }[]; taxCents?: number; tipCents?: number; paidCents?: number } = {}) {
  const items = o.items ?? [{ name: 'Signature Hand Wash', priceCents: 5400 }]
  const subtotalCents = items.reduce((n, x) => n + x.priceCents, 0)
  const taxCents = o.taxCents ?? 0
  const tipCents = o.tipCents ?? 0
  const totalCents = subtotalCents + taxCents + tipCents
  const paidCents = o.paidCents ?? 0
  return { number: o.number ?? 20611, date: o.date ?? '2026-10-09', items, subtotalCents, taxCents, tipCents, totalCents, paidCents, balanceCents: totalCents - paidCents }
}

/** A PlanView. */
export const planAnswer = (tier: 'gold' | 'vip' | null = 'gold', planKey: string = tier ?? 'family', name = tier === 'vip' ? 'VIP' : tier === 'gold' ? 'Gold' : 'Family') => ({
  tier,
  planKey,
  name,
  monthlyPriceCents: tier === 'vip' ? 14900 : 9900,
  perks: ['Unlimited washes'],
})
