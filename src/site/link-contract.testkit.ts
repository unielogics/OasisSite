/* eslint-disable @typescript-eslint/no-explicit-any */
// The backend's personal-link API contract, for the site's tests and the fixture's (never part of the build): backend
// docs/api-spec.md section 28 and src/modules/public/links/http/schemas.ts (W3c, branch ws/ai-w3-links at eb2fd4d; brought up to
// wave Q3, branch ws/q3-int at e0fb612: sizes on bookings and plans, saved cards, memberships billed by Square, the deposit;
// card-routes.ts and subscribe-routes.ts),
// copied here as the key lists of every answer the site reads and the enums of what it sends. The bridge tests build
// their answers with `linkState` and the fixture's answers are checked against the lists
// (tools/site/fixture-links.test.ts), so the page, the fixture and the API cannot drift apart unnoticed.
// When the API's schemas change, change this file first.

/** LinkStateView: what the exchange (plus `session`), GET me and every verification step (plus `verified`) answer. */
export const LINK_STATE_KEYS = ['kind', 'expiresAt', 'idleExpiresAt', 'link', 'client', 'trust', 'stepUp', 'appointments', 'invoice', 'plan', 'cards', 'cardSetup']
/** LinkStateView.kind */
export const LINK_KINDS = ['calendar', 'verify', 'pin', 'membership', 'pay', 'book_again', 'card']
export const CLIENT_KEYS = ['firstName', 'last2', 'tier']
export const TRUST_KEYS = ['verified', 'by', 'until']
export const STEP_UP_KEYS = ['method', 'freshUntil', 'canSetPinUntil']
export const APPOINTMENT_KEYS = ['ref', 'start', 'end', 'when', 'service', 'addons', 'status', 'canReschedule']
export const INVOICE_KEYS = ['number', 'date', 'items', 'coverage', 'subtotalCents', 'taxCents', 'tipCents', 'totalCents', 'paidCents', 'balanceCents']
export const INVOICE_ITEM_KEYS = ['name', 'priceCents', 'listCents', 'discountBp', 'memberDiscountCents', 'classLabel']
export const COVERAGE_KEYS = ['serviceName', 'coveredCents', 'lineCents', 'differenceCents', 'planClassLabel']
export const PLAN_KEYS = ['tier', 'planKey', 'name', 'monthlyPriceCents', 'perks', 'billing', 'prices']
export const PLAN_PRICE_KEYS = ['class', 'label', 'monthlyCents', 'joinable']
/** SavedCardView and CardSetupView (ADR 0171 wave Q3a). */
export const SAVED_CARD_KEYS = ['id', 'brand', 'last4', 'expMonth', 'expYear', 'purposes']
export const CARD_SETUP_KEYS = ['consent', 'square']
export const CONSENT_KEYS = ['version', 'text', 'purposes', 'checkedByDefault']
export const SQUARE_SETUP_KEYS = ['applicationId', 'locationId', 'environment', 'sdkUrl']
export const CARD_PURPOSE_KEYS = ['membership_billing', 'no_show_fee', 'late_cancel_fee', 'balance']
/** CodeBody.purpose (the default is verify) and CodeRequested. */
export const CODE_PURPOSES = ['verify', 'pin_set', 'pin_reset']
export const CODE_REQUESTED_KEYS = ['challengeId', 'expiresInSec', 'purpose', 'to']
/** BookingBody (strict) and BookingResult. */
export const BOOKING_BODY_KEYS = ['serviceKey', 'addonKeys', 'date', 'startMin', 'vehicle', 'vehicleClass', 'name', 'email', 'smsConsent']
export const VEHICLE_BODY_KEYS = ['year', 'make', 'model', 'color', 'label', 'plate']
export const BOOKING_RESULT_KEYS = ['bookingRef', 'status', 'start', 'end', 'deposit', 'confirmationBy', 'service', 'addons', 'when', 'member', 'bayCount', 'pricing']
/** WebPricing (ADR 0170): what a booking was priced at. */
export const PRICING_KEYS = ['vehicleClass', 'vehicleClassLabel', 'confirmAtShop', 'listCents', 'discountCents', 'coveredCents', 'dueCents']
export const RESCHEDULE_RESULT_KEYS = ['bookingRef', 'status', 'start', 'end', 'when']
/** MembershipStartBody (strict) and MembershipStartResult. */
export const MEMBERSHIP_BODY_KEYS = ['email', 'planClass', 'vehicles']
export const MEMBERSHIP_RESULT_KEYS = ['redirectUrl', 'membershipRef', 'checkoutExpiresAt']
/** PayStartResult. */
export const PAY_RESULT_KEYS = ['status', 'redirectUrl']
/** DepositStartBody and DepositStartResult (ADR 0171 D2). */
export const DEPOSIT_BODY_KEYS = ['bookingRef']
export const DEPOSIT_RESULT_KEYS = ['status', 'redirectUrl', 'amountCents']
/** CardSaveBody (strict), CardSaveResult, CardRemoveResult (card-routes.ts). */
export const CARD_SAVE_BODY_KEYS = ['sourceId', 'verificationToken', 'consentVersion', 'purposes', 'cardholderName', 'postalCode']
export const CARD_SAVE_RESULT_KEYS = ['card', 'consent']
export const CARD_VIEW_KEYS = ['id', 'brand', 'last4', 'expMonth', 'expYear', 'state']
export const CARD_REMOVE_RESULT_KEYS = ['cardId', 'state']
/** MembershipSubscribeBody (strict) and MembershipEnrollmentStatus (subscribe-routes.ts). */
export const SUBSCRIBE_BODY_KEYS = ['email', 'planClass', 'vehicles', 'sourceId', 'verificationToken', 'consentVersion', 'cardholderName', 'postalCode']
export const ENROLLMENT_STATUS_KEYS = ['status', 'membershipRef']

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
  if (!LINK_KINDS.includes(o.kind)) out.push(`kind: ${o.kind}`)
  if (o.invoice !== null) {
    sameKeys('invoice', o.invoice, INVOICE_KEYS, out)
    if (typeof o.invoice?.number !== 'number') out.push('invoice.number: not a number')
    for (const [i, it] of (o.invoice?.items ?? []).entries()) sameKeys(`invoice.items[${i}]`, it, INVOICE_ITEM_KEYS, out)
    for (const [i, c] of (o.invoice?.coverage ?? []).entries()) sameKeys(`invoice.coverage[${i}]`, c, COVERAGE_KEYS, out)
  }
  if (o.plan !== null) {
    sameKeys('plan', o.plan, PLAN_KEYS, out)
    if (o.plan?.billing !== 'square' && o.plan?.billing !== 'squarespace') out.push(`plan.billing: ${o.plan?.billing}`)
    for (const [i, p] of (o.plan?.prices ?? []).entries()) sameKeys(`plan.prices[${i}]`, p, PLAN_PRICE_KEYS, out)
  }
  if (o.cards !== null) {
    if (!Array.isArray(o.cards)) out.push('cards: neither null nor a list')
    else o.cards.forEach((c: unknown, i: number) => sameKeys(`cards[${i}]`, c, SAVED_CARD_KEYS, out))
  }
  if (o.cardSetup !== null) {
    sameKeys('cardSetup', o.cardSetup, CARD_SETUP_KEYS, out)
    sameKeys('cardSetup.consent', o.cardSetup?.consent, CONSENT_KEYS, out)
    if (o.cardSetup?.consent?.checkedByDefault !== false) out.push('cardSetup.consent.checkedByDefault: not false')
    for (const [i, p] of (o.cardSetup?.consent?.purposes ?? []).entries()) sameKeys(`cardSetup.consent.purposes[${i}]`, p, ['key', 'words'], out)
    if (o.cardSetup?.square !== null) sameKeys('cardSetup.square', o.cardSetup?.square, SQUARE_SETUP_KEYS, out)
  }
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
  /** the saved cards (card and membership pages); null by default */
  cards?: unknown
  /** saved cards are on: the consent wording and Square's settings (true: the fixture's) */
  cardSetup?: unknown
}

/** The API's consent wording v1 (backend src/modules/square/consents.ts) and its purposes' words. */
export const CONSENT_V1 =
  'Save this card with Square so Oasis Auto Spa can charge it for: {purposes}. Charges are made only after the shop confirms them, except your membership’s monthly payment. You can remove the card any time from your link or by asking us.'
export const PURPOSE_WORDS: Record<string, string> = {
  membership_billing: 'your membership’s monthly payment',
  no_show_fee: 'a no-show fee',
  late_cancel_fee: 'a late-cancel fee',
  balance: 'a balance you owe',
}
/** A CardSetupView (the SDK URL: the page's own origin, as the e2e's stub is served). */
export const cardSetupAnswer = (sdkUrl = '/api/v1/public/__fixture/square.js') => ({
  consent: { version: 'v1', text: CONSENT_V1, purposes: CARD_PURPOSE_KEYS.map((key) => ({ key, words: PURPOSE_WORDS[key]! })), checkedByDefault: false },
  square: { applicationId: 'sandbox-sq0idb-fixture', locationId: 'LFIXTURE01', environment: 'sandbox', sdkUrl },
})
/** A SavedCardView. */
export const savedCardAnswer = (o: { id?: string; last4?: string; purposes?: string[] } = {}) => ({
  id: o.id ?? '7d9c1f0e-3b2a-4c5d-8e6f-0a1b2c3d4e5f',
  brand: 'VISA',
  last4: o.last4 ?? '1111',
  expMonth: 12,
  expYear: 2030,
  purposes: o.purposes ?? ['no_show_fee', 'balance'],
})

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
    cards: o.cards ?? null,
    cardSetup: o.cardSetup === true ? cardSetupAnswer() : (o.cardSetup ?? null),
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
  return {
    number: o.number ?? 20611,
    date: o.date ?? '2026-10-09',
    items: items.map((x) => ({ ...x, listCents: x.priceCents, discountBp: 0, memberDiscountCents: 0, classLabel: 'Compact car' })),
    coverage: [],
    subtotalCents,
    taxCents,
    tipCents,
    totalCents,
    paidCents,
    balanceCents: totalCents - paidCents,
  }
}

/** A PlanView. */
export const planAnswer = (tier: 'gold' | 'vip' | null = 'gold', planKey: string = tier ?? 'family', name = tier === 'vip' ? 'VIP' : tier === 'gold' ? 'Gold' : 'Family') => ({
  tier,
  planKey,
  name,
  monthlyPriceCents: tier === 'vip' ? 14900 : 9900,
  perks: ['Unlimited washes'],
  billing: 'squarespace' as 'square' | 'squarespace',
  prices: [{ class: 'compact_car', label: 'Compact car', monthlyCents: tier === 'vip' ? 14900 : 9900, joinable: true }],
})

/** A PlanView billed by Square, sold at two sizes (the second one not set up at Square yet unless `bothJoinable`). */
export const squarePlanAnswer = (tier: 'gold' | 'vip' = 'gold', bothJoinable = true) => ({
  ...planAnswer(tier),
  monthlyPriceCents: 12900,
  billing: 'square' as const,
  prices: [
    { class: 'compact_car', label: 'Compact car', monthlyCents: 12900, joinable: true },
    { class: 'large_suv', label: 'Large SUV', monthlyCents: 15900, joinable: bothJoinable },
  ],
})
