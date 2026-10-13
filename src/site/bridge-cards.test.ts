// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
// Wave Q3 on the personal link pages, against the REAL design logic (bridge.testkit.ts) and a fake of Square's Web Payments
// SDK (never the real one): DV-LINK-CARD (the card page #/k: saved cards, Remove, the card form with the consent box
// unchecked), DV-LINK-JOIN billed by Square (size -> verify -> e-mail -> card + consent -> subscribe -> wait for the first
// payment), DV-LINK-PAY (Square's checkout wording, the booking deposit, #/paid). The API is scripted in its own shapes
// (link-contract.testkit.ts, backend api-spec 28 at wave Q3).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installLinkCapture, resetLinkCapture } from '../client/link'
import { CARD_WORDS, resetSquareLoader } from '../client/square'
import { configCatalog, makeSite, payload, type Call, type Handler } from './bridge.testkit'
import { cardSetupAnswer, CONSENT_V1, exchangeAnswer as exchanged, invoiceAnswer, linkState, savedCardAnswer, squarePlanAnswer, stepAnswer as stepped } from './link-contract.testkit'
import { cardLabel, checkoutName, consentText, listWords, validateState } from './links'

beforeAll(() => {
  process.env.TZ = 'America/New_York'
})
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T10:00:00-04:00'))
  ;(window as any).__oasisNavigations = []
  window.scrollTo = (() => {}) as any
  ;(window as any).__oasisNavigate = (u: string) => (window as any).__oasisNavigations.push(u)
  resetLinkCapture()
  resetSquareLoader()
  history.replaceState(null, '', '/')
})
afterEach(() => {
  vi.useRealTimers()
  delete (window as any).__oasisNavigate
  delete (window as any).Square
  resetLinkCapture()
  document.body.innerHTML = ''
  for (const s of document.head.querySelectorAll('script')) s.remove()
})
const navigations = (): string[] => (window as any).__oasisNavigations

const TOKEN = 'Q2FyZExpbmtUb2tlbkZvck1hcmlhLTMyLWJ5dGVzLWJhc2U2'
const BASE = '/api/v1/public/links'
const board = payload([{ date: '2026-10-12', slots: [[540, 'open', 3]] }])
const ok = (body: unknown, status = 200) => ({ status, body })
const prob = (status: number, code: string, title: string, extra: Record<string, unknown> = {}) => ({ status, body: { type: 'about:blank', status, code, title, ...extra } })

/** A fake of Square's Web Payments SDK: what the page asked, and the token it answers (null: the card is not valid). */
function fakeSquare() {
  const rec = { payments: [] as unknown[], attached: [] as HTMLElement[], tokenize: [] as any[], destroyed: 0, token: 'cnon:card-nonce-ok' as string | null }
  ;(window as any).Square = {
    payments: (appId: string, locationId: string) => {
      rec.payments.push([appId, locationId])
      return {
        card: async () => ({
          attach: async (el: HTMLElement) => {
            rec.attached.push(el)
          },
          tokenize: async (details: unknown) => {
            rec.tokenize.push(details)
            return rec.token ? { status: 'OK', token: rec.token } : { status: 'Invalid', errors: [{ message: 'Card number is not valid' }] }
          },
          destroy: async () => {
            rec.destroyed++
          },
        }),
      }
    },
  }
  return rec
}

/** The element Square's form is attached to (the testkit renders no DOM: the page's block, by its id). */
function host(id: string): HTMLElement {
  const el = document.createElement('div')
  el.id = id
  document.body.appendChild(el)
  return el
}

function openWith(path: string, routes: Record<string, Handler>, booking: 'sms' | 'live' = 'sms') {
  history.replaceState(null, '', `/#/${path}/${TOKEN}`)
  installLinkCapture(window as never)
  const t = makeSite({
    booking,
    availability: board,
    routes: {
      '/api/v1/public/catalog': () => ok({ generatedAt: new Date().toISOString(), ...configCatalog(), plans: [] }),
      '/api/v1/public/availability': () => ok(board),
      ...routes,
    },
  })
  t.c.__pollMs = 0
  t.c.__lkMount()
  return t
}
const linkCalls = (calls: Call[]) => calls.filter((c) => c.path.startsWith(BASE))
const sh = (c: any) => c.sheetVals().sh
const lv = (c: any) => c.renderVals().site.link
/** A code step on the page: send, then confirm (the answer is the route's). */
async function code(t: ReturnType<typeof openWith>) {
  lv(t.c).su.sendCode()
  await t.settle()
  lv(t.c).su.setValue({ target: { value: '123456' } })
  lv(t.c).su.submit()
  await t.settle()
}

/** A card page opened and confirmed with a texted code (saving and removing need a fresh step-up). */
async function cardPage(state: Record<string, unknown>, routes: Record<string, Handler> = {}) {
  const t = openWith('k', {
    [`${BASE}/exchange`]: () => ok(exchanged({ kind: 'card', ...state })),
    [`${BASE}/verify/code`]: () => ok({ challengeId: 'c1', expiresInSec: 600, purpose: 'verify', to: '51' }, 202),
    [`${BASE}/verify/code/confirm`]: () => ok(stepped({ kind: 'card', by: 'code', ...state })),
    ...routes,
  })
  await t.settle()
  await code(t)
  return t
}

describe('DV-LINK-CARD: the card page', () => {
  const CARD_ID = '7d9c1f0e-3b2a-4c5d-8e6f-0a1b2c3d4e5f'
  const NEW_ID = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d'
  const verified = (cards: unknown[]) => stepped({ kind: 'card', cardSetup: true, cards, by: 'code' })

  it('a fresh code first; then the cards, the form (lazily loaded) and the consent unchecked; Save posts the token and the purposes', async () => {
    const sq = fakeSquare()
    const el = host('oasis-card-form')
    let saved: Call | null = null
    const t = openWith('k', {
      [`${BASE}/exchange`]: () => ok(exchanged({ kind: 'card', cardSetup: true })),
      [`${BASE}/verify/code`]: () => ok({ challengeId: 'c1', expiresInSec: 600, purpose: 'verify', to: '51' }, 202),
      [`${BASE}/verify/code/confirm`]: () => ok(verified([savedCardAnswer({ id: CARD_ID })])),
      [`${BASE}/cards`]: (call) => {
        saved = call
        return ok({ card: { id: NEW_ID, brand: 'VISA', last4: '4242', expMonth: 12, expYear: 2030, state: 'active' }, consent: { version: 'v1', purposes: call.body.purposes } }, 201)
      },
      [`${BASE}/me`]: () => ok(linkState({ kind: 'card', verified: true, fresh: true, cardSetup: true, cards: [savedCardAnswer({ id: NEW_ID, last4: '4242' }), savedCardAnswer({ id: CARD_ID })] })),
    })
    await t.settle()
    const c = t.c
    // not fresh: the step-up first, and no SDK yet
    expect(lv(c).sheetStepUp).toBe(true)
    expect(lv(c).card.show).toBe(false)
    expect(sq.payments).toEqual([])
    await code(t)
    expect(lv(c).card).toMatchObject({ show: true, empty: '', form: true, agree: false, err: '' })
    expect(lv(c).card.cards.map((x: any) => [x.label, x.sub])).toEqual([['Visa ••1111', 'Expires 12/30 · For a no-show fee and a balance you owe']])
    // the API's wording with the purposes this page asks for (a client without a membership: the fees and a balance)
    expect(lv(c).card.consent).toBe(CONSENT_V1.replace('{purposes}', 'a no-show fee, a late-cancel fee and a balance you owe'))
    expect(lv(c).card.box).toMatchObject({ background: 'transparent', border: '2px solid var(--ink4)' })
    expect(sh(c)).toMatchObject({ eyebrow: 'SAVED CARDS · MARIA ••51', title: 'Your cards', hasCta: true, ctaLabel: 'Save card' })
    // Square's form is attached to the block's element, with the API's application and location
    expect(sq.payments).toEqual([['sandbox-sq0idb-fixture', 'LFIXTURE01']])
    expect(sq.attached).toEqual([el])
    // the box is required
    sh(c).cta()
    await t.settle()
    expect(saved).toBeNull()
    expect(lv(c).card.err).toBe('Tick the box to agree, then save the card.')
    lv(c).card.toggle()
    expect(lv(c).card.agree).toBe(true)
    sh(c).cta()
    await t.settle()
    expect(sq.tokenize).toEqual([{ intent: 'STORE', customerInitiated: true, sellerKeyedIn: false, billingContact: { givenName: 'Maria' } }])
    expect(saved!.body).toEqual({ sourceId: 'cnon:card-nonce-ok', consentVersion: 'v1', purposes: ['no_show_fee', 'late_cancel_fee', 'balance'] })
    expect(saved!.headers['idempotency-key']).toBeTruthy()
    expect(saved!.headers.authorization).toBe('Bearer sess-1')
    expect(lv(c).card.note).toBe('Visa ••4242 is saved. You can remove it here any time.')
    expect(lv(c).card.cards.map((x: any) => x.label)).toEqual(['Visa ••4242', 'Visa ••1111'])
    // the consent goes back to unchecked for the next card
    expect(lv(c).card.agree).toBe(false)
    // the token never reaches the API but in the exchange
    for (const call of linkCalls(t.calls).filter((x) => !x.path.endsWith('/exchange'))) expect(JSON.stringify(call)).not.toContain(TOKEN)
  })

  it('a declined card shows the API\'s words; Remove sends DELETE and reads the cards again', async () => {
    const sq = fakeSquare()
    host('oasis-card-form')
    let removed: Call | null = null
    let after: unknown[] = [savedCardAnswer({ id: CARD_ID })]
    const t = await cardPage({ cardSetup: true, cards: [savedCardAnswer({ id: CARD_ID })] }, {
      [`${BASE}/cards`]: () => prob(422, 'CARD_DECLINED', 'Card declined', { detail: 'This card number is not valid. Please check it and try again.' }),
      [`${BASE}/cards/${CARD_ID}`]: (call) => {
        removed = call
        after = []
        return ok({ cardId: CARD_ID, state: 'disabled' })
      },
      [`${BASE}/me`]: () => ok(linkState({ kind: 'card', verified: true, fresh: true, cardSetup: true, cards: after })),
    })
    const c = t.c
    expect(lv(c).card.show).toBe(true)
    lv(c).card.toggle()
    sh(c).cta()
    await t.settle()
    expect(lv(c).card.err).toBe('This card number is not valid. Please check it and try again.')
    // a card the SDK cannot read: no request at all
    sq.token = null
    const before = linkCalls(t.calls).length
    sh(c).cta()
    await t.settle()
    expect(linkCalls(t.calls).length).toBe(before)
    expect(lv(c).card.err).toBe(CARD_WORDS.input)
    lv(c).card.cards[0].remove()
    await t.settle()
    expect(removed!.method).toBe('DELETE')
    expect(lv(c).card).toMatchObject({ note: 'The card is removed.', cards: [], empty: 'No saved cards yet.' })
  })

  it('saved cards off (no cardSetup): no form, no SDK, a text-us note', async () => {
    const sq = fakeSquare()
    host('oasis-card-form')
    const t = await cardPage({ cards: [] })
    expect(lv(t.c).card).toMatchObject({ show: true, form: false })
    expect(lv(t.c).card.closed).toMatch(/^Saving a card online isn’t open yet\. Text us at 862-388-5827/)
    expect(sh(t.c).hasCta).toBe(false)
    expect(sq.payments).toEqual([])
  })

  it('an SDK URL off the allowlist is never loaded', async () => {
    host('oasis-card-form')
    const setup = { ...cardSetupAnswer(), square: { ...cardSetupAnswer().square, sdkUrl: 'https://evil.example/v1/square.js' } }
    const t = await cardPage({ cardSetup: setup, cards: [] })
    expect(document.querySelectorAll('script').length).toBe(0)
    expect(lv(t.c).card.err).toBe(CARD_WORDS.blocked)
  })

  it('the SDK is loaded lazily: a page without a card form never asks for it', async () => {
    const t = openWith('c', { [`${BASE}/exchange`]: () => ok(exchanged({ verified: true, cardSetup: true })) })
    await t.settle()
    expect(t.c.state.sheet).toBe('book')
    expect(document.querySelectorAll('script').length).toBe(0)
    expect((window as any).Square).toBeUndefined()
  })
})

describe('DV-LINK-JOIN billed by Square: size, verify, e-mail, card + consent, subscribe, wait', () => {
  const routes = (status: string[], extra: Record<string, Handler> = {}) => {
    const answers = [...status]
    const state = (o: Record<string, unknown> = {}) => ({ kind: 'membership', plan: squarePlanAnswer('gold'), cardSetup: true, ...o })
    return {
      [`${BASE}/exchange`]: () => ok(exchanged(state())),
      [`${BASE}/verify/code`]: () => ok({ challengeId: 'c2', expiresInSec: 600, purpose: 'verify', to: '51' }, 202),
      [`${BASE}/verify/code/confirm`]: () => ok(stepped({ ...state(), by: 'code', cards: [] })),
      [`${BASE}/membership/subscribe`]: () => ok({ status: 'pending', membershipRef: 'OAS-M-1A2B3C4D' }, 202),
      [`${BASE}/membership/status`]: () => ok({ status: answers.length > 1 ? answers.shift() : answers[0], membershipRef: 'OAS-M-1A2B3C4D' }),
      ...extra,
    } as Record<string, Handler>
  }
  /** The design's hashchange handler shows the join page (componentDidMount is not run by the test kit). */
  async function joinPage(t: ReturnType<typeof openWith>) {
    await t.settle()
    expect(location.hash).toBe('#/join?gold')
    t.c.setState({ page: 'join', jn: t.c.freshJn('gold') })
  }
  async function toCardStep(t: ReturnType<typeof openWith>) {
    const c = t.c
    await joinPage(t)
    expect(c.state.page).toBe('join')
    expect(lv(c).joinStepUp).toBe(false)
    // the size picker: every size the plan is sold at; the price follows the size
    const sizes = c.renderVals().site.joinSizes
    expect(sizes.show).toBe(true)
    expect(sizes.chips.map((x: any) => x.label)).toEqual(['Compact car · $129/mo', 'Large SUV · $159/mo'])
    expect(c.joinVM().jv.tiers.find((x: any) => x.name === 'Gold')).toMatchObject({ price: '$129', per: '/mo' })
    sizes.chips[1].onClick()
    expect(c.joinVM().jv.tiers.find((x: any) => x.name === 'Gold')).toMatchObject({ price: '$159' })
    expect(c.joinVM().jv.lines.slice(0, 2).map((l: any) => [l.label, l.value])).toEqual([
      ['Gold membership', '$159/mo'],
      ['Priced for', 'Large SUV'],
    ])
    c.joinVM().jv.next()
    expect(lv(c).joinStepUp).toBe(true)
    await code(t)
    expect(c.state.jn.step).toBe(2)
    expect(c.joinVM().jv.sub).toBe('Square emails your receipts there every month. Use an email you check.')
    // an address that never receives mail is refused before the card (Square ends a subscription whose receipts bounce)
    for (const email of ['jo@example.com', 'jo@shop.test', 'jo@mail.invalid', 'jo@box.localhost']) {
      c.setJn({ email })
      c.joinVM().jv.next()
      expect(c.state.jn, email).toMatchObject({ step: 2, err: 'Use an email you check: Square sends your membership receipts there.' })
    }
    c.setJn({ email: 'jo@gmail.com' })
    c.joinVM().jv.next()
    expect(c.state.jn.step).toBe(3)
  }

  it('walks to an active membership: the card form on the card step, the consent required, the body, the wait', async () => {
    const sq = fakeSquare()
    const el = host('oasis-join-card')
    let sent: Call | null = null
    const t = openWith('m', routes(['pending', 'active'], { [`${BASE}/membership/subscribe`]: (call) => ((sent = call), ok({ status: 'pending', membershipRef: 'OAS-M-1A2B3C4D' }, 202)) }))
    await toCardStep(t)
    const c = t.c
    await t.settle()
    expect(sq.attached).toEqual([el])
    const jv = c.joinVM().jv
    expect(jv).toMatchObject({ eyebrow: 'STEP 4 OF 4 · CARD', ctaLabel: 'Join · $159/mo', due: '$159' })
    expect(jv.agreeText).toBe('I agree to be billed $159 a month for Gold until I cancel. Unused washes don’t roll over.')
    expect(lv(c).joinCard).toMatchObject({ show: true, form: true, agree: false })
    expect(lv(c).joinCard.consent).toBe(CONSENT_V1.replace('{purposes}', 'your membership’s monthly payment'))
    // the terms and the card consent are both required
    c.joinVM().jv.next()
    expect(c.state.jn.err).toBe('Please accept the membership terms.')
    c.setJn({ agree: true })
    c.joinVM().jv.next()
    await t.settle()
    expect(sent).toBeNull()
    expect(lv(c).joinCard.err).toBe('Tick the box to agree to the card being saved, then join.')
    lv(c).joinCard.toggle()
    c.joinVM().jv.next()
    await t.settle()
    expect(sent!.body).toEqual({ email: 'jo@gmail.com', planClass: 'large_suv', sourceId: 'cnon:card-nonce-ok', consentVersion: 'v1' })
    await t.settle()
    await t.settle()
    expect(linkCalls(t.calls).filter((x) => x.path.endsWith('/membership/status')).length).toBeGreaterThanOrEqual(2)
    expect(c.state.jn.step).toBe(4)
    expect(c.joinVM().jv.sub).toBe('Your Gold membership is active. Square emails your receipts every month.')
    // nothing was sent to Squarespace's flow
    expect(linkCalls(t.calls).some((x) => x.path.endsWith('/membership/start'))).toBe(false)
  })

  it('the first payment fails: the card step says so and stays', async () => {
    fakeSquare()
    host('oasis-join-card')
    const t = openWith('m', routes(['pending', 'failed']))
    await toCardStep(t)
    const c = t.c
    await t.settle()
    c.setJn({ agree: true })
    lv(c).joinCard.toggle()
    c.joinVM().jv.next()
    await t.settle()
    await t.settle()
    expect(c.state.jn.step).toBe(3)
    expect(lv(c).joinCard.err).toBe('Square couldn’t take the first payment. Check the card or use another one, then try again.')
  })

  it('an e-mail Square cannot use goes back to the e-mail step with the API\'s words', async () => {
    fakeSquare()
    host('oasis-join-card')
    const t = openWith(
      'm',
      routes(['active'], {
        [`${BASE}/membership/subscribe`]: () =>
          prob(422, 'VALIDATION_FAILED', 'Check the form', { errors: [{ path: 'body.email', message: 'Use an email you check: Square sends your membership receipts there.' }] }),
      }),
    )
    await toCardStep(t)
    const c = t.c
    await t.settle()
    c.setJn({ agree: true })
    lv(c).joinCard.toggle()
    c.joinVM().jv.next()
    await t.settle()
    expect(c.state.jn).toMatchObject({ step: 2, err: 'Use an email you check: Square sends your membership receipts there.' })
  })

  it('a size not set up at Square reads "ask us" and cannot be picked', async () => {
    const t = openWith('m', { [`${BASE}/exchange`]: () => ok(exchanged({ kind: 'membership', plan: squarePlanAnswer('gold', false), cardSetup: true })) })
    await joinPage(t)
    const chips = t.c.renderVals().site.joinSizes.chips
    expect(chips.map((x: any) => x.label)).toEqual(['Compact car · $129/mo', 'Large SUV · ask us'])
    chips[1].onClick()
    expect(t.c.state.toast).toMatch(/Large SUV isn’t open online yet/)
    expect(t.c.joinVM().jv.due).toBe('$129')
  })
})

describe('DV-LINK-PAY with Square', () => {
  it('the redirect names Square\'s checkout', async () => {
    const invoice = invoiceAnswer()
    const t = openWith('p', {
      [`${BASE}/exchange`]: () => ok(exchanged({ kind: 'pay', invoice, verified: true })),
      [`${BASE}/verify/code`]: () => ok({ challengeId: 'c3', expiresInSec: 600, purpose: 'verify', to: '51' }, 202),
      [`${BASE}/verify/code/confirm`]: () => ok(stepped({ kind: 'pay', invoice, by: 'code' })),
      [`${BASE}/pay/start`]: () => ok({ status: 'redirect', redirectUrl: 'https://square.link/u/AbC123' }),
    })
    await t.settle()
    expect(lv(t.c).pay.dueSub).toBe('You’ll pay on a secure checkout page.')
    sh(t.c).cta()
    await code(t)
    expect(navigations()).toEqual(['https://square.link/u/AbC123'])
    expect(t.c.__lkView).toMatchObject({ title: 'Opening checkout', text: 'Taking you to Square’s secure checkout to pay.' })
  })

  it('a booking whose deposit is taken by link: "Pay the $25 deposit now" opens Square\'s checkout', async () => {
    let started: Call | null = null
    const t = openWith('c', {
      [`${BASE}/exchange`]: () => ok(exchanged({ verified: true })),
      [`${BASE}/availability`]: () => ok(board),
      [`${BASE}/bookings`]: () => ok({ bookingRef: 'OAS-00042', status: 'booked', deposit: { dueCents: 2500, how: 'link' }, confirmationBy: 'sms' }, 201),
      [`${BASE}/deposit/start`]: (call) => ((started = call), ok({ status: 'redirect', redirectUrl: 'https://square.link/u/dep42', amountCents: 2500 })),
    })
    await t.settle()
    const c = t.c
    expect(lv(c).deposit.show).toBe(false)
    c.__pickDate = '2026-10-12'
    c.setBk({ day: 0, slot: 540, ack: true })
    c.setState({ step: 'review' })
    sh(c).cta()
    await t.settle()
    expect(c.state.step).toBe('done')
    expect(lv(c).deposit).toMatchObject({ show: true, label: 'Pay the $25 deposit now' })
    lv(c).deposit.pay()
    await t.settle()
    expect(started!.body).toEqual({ bookingRef: 'OAS-00042' })
    expect(navigations()).toEqual(['https://square.link/u/dep42'])
  })

  it('a deposit at the counter: no button', async () => {
    const t = openWith('c', {
      [`${BASE}/exchange`]: () => ok(exchanged({ verified: true })),
      [`${BASE}/availability`]: () => ok(board),
      [`${BASE}/bookings`]: () => ok({ bookingRef: 'OAS-00043', status: 'booked', deposit: { dueCents: 2500, how: 'counter' }, confirmationBy: 'sms' }, 201),
    })
    await t.settle()
    const c = t.c
    c.__pickDate = '2026-10-12'
    c.setBk({ day: 0, slot: 540, ack: true })
    c.setState({ step: 'review' })
    sh(c).cta()
    await t.settle()
    expect(c.state.step).toBe('done')
    expect(lv(c).deposit.show).toBe(false)
  })

  it('#/paid: back from Square\'s checkout, a thank-you notice and a clean address', () => {
    history.replaceState(null, '', '/#/paid?orderId=abc')
    const t = makeSite({ booking: 'sms', availability: board })
    t.c.__paidMount()
    expect(location.hash).toBe('')
    expect(t.c.state.sheet).toBe('link')
    expect(t.c.__lkView).toMatchObject({ tone: 'ok', title: 'Thank you', text: 'Square is confirming your payment now. Your receipt comes by email or text.' })
    // anything else is not this view
    history.replaceState(null, '', '/#/membership')
    const u = makeSite({ booking: 'sms', availability: board })
    u.c.__paidMount()
    expect(u.c.state.sheet).toBeNull()
  })
})

describe('links.ts: the wave Q3 shapes, checked', () => {
  it('cards and cardSetup: malformed rows dropped, the box never trusted to start checked, a wording without its place refused', () => {
    const st = validateState({
      ...linkState({ kind: 'card' }),
      cards: [savedCardAnswer(), { id: 'nope', brand: 'VISA' }, { ...savedCardAnswer({ id: '0f0e0d0c-0b0a-4908-8706-050403020100' }), last4: '12', purposes: ['balance', 'everything'] }],
      cardSetup: { ...cardSetupAnswer(), consent: { ...cardSetupAnswer().consent, checkedByDefault: true } },
    })
    expect(st.cards!.map((c) => [c.last4, c.purposes])).toEqual([
      ['1111', ['no_show_fee', 'balance']],
      [null, ['balance']],
    ])
    expect(st.cardSetup!.consent.version).toBe('v1')
    expect('checkedByDefault' in st.cardSetup!.consent).toBe(false)
    expect(validateState({ ...linkState(), cardSetup: { ...cardSetupAnswer(), consent: { ...cardSetupAnswer().consent, text: 'no place' } } }).cardSetup).toBeNull()
    expect(validateState({ ...linkState(), cardSetup: { ...cardSetupAnswer(), square: { applicationId: 'x y', locationId: 'L', sdkUrl: '/s.js' } } }).cardSetup!.square).toBeNull()
  })

  it('the words: consent text, card label, checkout names', () => {
    expect(listWords(['a'])).toBe('a')
    expect(listWords(['a', 'b', 'c'])).toBe('a, b and c')
    const set = validateState({ ...linkState(), cardSetup: cardSetupAnswer() }).cardSetup!
    expect(consentText(set, ['balance', 'no_show_fee'])).toBe(CONSENT_V1.replace('{purposes}', 'a no-show fee and a balance you owe'))
    expect(cardLabel({ brand: 'AMERICAN_EXPRESS', last4: '0005' })).toBe('Amex ••0005')
    expect(cardLabel({ brand: null, last4: null })).toBe('Card')
    expect(checkoutName('https://square.link/u/x')).toBe('Square’s')
    expect(checkoutName('https://checkout.square.site/x')).toBe('Square’s')
    expect(checkoutName('https://oasis.squarespace.com/x')).toBe('Squarespace’s')
    expect(checkoutName('https://evil.example/square.link')).toBe('')
  })
})
