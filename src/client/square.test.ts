// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
// DV-LINK-CARD: Square's Web Payments SDK loader (src/client/square.ts): the URL allowlist, one lazy <script> per page, the
// card form's tokenize with intent STORE, and the client's words when anything goes wrong.
import { afterEach, describe, expect, it } from 'vitest'
import { CARD_WORDS, CardFormError, loadSquareSdk, mountCard, resetSquareLoader, sdkUrlAllowed } from './square'

const HOSTS = ['web.squarecdn.com', 'sandbox.web.squarecdn.com']
const ORIGIN = 'https://oasisautospanj.com'

afterEach(() => {
  resetSquareLoader()
  delete (window as any).Square
  for (const s of document.head.querySelectorAll('script')) s.remove()
})

describe('sdkUrlAllowed', () => {
  it('https on Square\'s CDNs, or the page\'s own origin; nothing else', () => {
    expect(sdkUrlAllowed('https://web.squarecdn.com/v1/square.js', HOSTS, ORIGIN)).toBe(true)
    expect(sdkUrlAllowed('https://sandbox.web.squarecdn.com/v1/square.js', HOSTS, ORIGIN)).toBe(true)
    expect(sdkUrlAllowed('/api/v1/public/__fixture/square.js', HOSTS, ORIGIN)).toBe(true)
    expect(sdkUrlAllowed('https://oasisautospanj.com/x.js', HOSTS, ORIGIN)).toBe(true)
    expect(sdkUrlAllowed('http://web.squarecdn.com/v1/square.js', HOSTS, ORIGIN)).toBe(false)
    expect(sdkUrlAllowed('https://web.squarecdn.com.evil.example/v1/square.js', HOSTS, ORIGIN)).toBe(false)
    expect(sdkUrlAllowed('https://evil.example/web.squarecdn.com/square.js', HOSTS, ORIGIN)).toBe(false)
    expect(sdkUrlAllowed('https://user:pw@web.squarecdn.com/v1/square.js', HOSTS, ORIGIN)).toBe(false)
    expect(sdkUrlAllowed('https://web.squarecdn.com:8443/v1/square.js', HOSTS, ORIGIN)).toBe(false)
    expect(sdkUrlAllowed('javascript:alert(1)', HOSTS, ORIGIN)).toBe(false)
    expect(sdkUrlAllowed(null, HOSTS, ORIGIN)).toBe(false)
  })
})

describe('loadSquareSdk', () => {
  it('adds one script for the page and resolves the SDK once it ran', async () => {
    const a = loadSquareSdk('https://web.squarecdn.com/v1/square.js')
    const b = loadSquareSdk('https://web.squarecdn.com/v1/square.js')
    const scripts = document.head.querySelectorAll('script')
    expect(scripts.length).toBe(1)
    expect(scripts[0]!.getAttribute('src')).toBe('https://web.squarecdn.com/v1/square.js')
    const sdk = { payments: () => ({}) }
    ;(window as any).Square = sdk
    scripts[0]!.dispatchEvent(new Event('load'))
    expect(await a).toBe(sdk)
    expect(await b).toBe(sdk)
    // loaded: no second script
    expect(await loadSquareSdk('https://web.squarecdn.com/v1/square.js')).toBe(sdk)
    expect(document.head.querySelectorAll('script').length).toBe(1)
  })

  it('a script that fails, or loads without the SDK, is the client\'s "didn\'t load"', async () => {
    const a = loadSquareSdk('https://web.squarecdn.com/v1/square.js')
    document.head.querySelector('script')!.dispatchEvent(new Event('error'))
    await expect(a).rejects.toMatchObject({ kind: 'load', message: CARD_WORDS.load })
    const b = loadSquareSdk('https://web.squarecdn.com/v1/square.js')
    document.head.querySelectorAll('script')[1]!.dispatchEvent(new Event('load'))
    await expect(b).rejects.toBeInstanceOf(CardFormError)
  })
})

describe('mountCard', () => {
  const setup = { applicationId: 'sandbox-sq0idb-x', locationId: 'L1', environment: 'sandbox' as const, sdkUrl: '' }
  const sdk = (answer: unknown, rec: any[] = []) => ({
    payments: (a: string, l: string) => {
      rec.push(['payments', a, l])
      return {
        card: async () => ({
          attach: async (el: unknown) => void rec.push(['attach', el]),
          tokenize: async (d: unknown) => (rec.push(['tokenize', d]), answer),
          destroy: async () => void rec.push(['destroy']),
        }),
      }
    },
  })

  it('attaches to the element and tokenizes with intent STORE, customer-initiated, the billing contact', async () => {
    const rec: any[] = []
    const el = document.createElement('div')
    const form = await mountCard(sdk({ status: 'OK', token: 'cnon:abc' }, rec) as any, setup, el)
    expect(await form.tokenize({ givenName: 'Maria' })).toEqual({ sourceId: 'cnon:abc' })
    await form.destroy()
    expect(rec).toEqual([
      ['payments', 'sandbox-sq0idb-x', 'L1'],
      ['attach', el],
      ['tokenize', { intent: 'STORE', customerInitiated: true, sellerKeyedIn: false, billingContact: { givenName: 'Maria' } }],
      ['destroy'],
    ])
  })

  it('a verification token the SDK gives goes along; a card it cannot read is the client\'s "check your card"', async () => {
    const el = document.createElement('div')
    const v = await mountCard(sdk({ status: 'OK', token: 'cnon:abc', details: { verificationToken: 'verf:1' } }) as any, setup, el)
    expect(await v.tokenize({})).toEqual({ sourceId: 'cnon:abc', verificationToken: 'verf:1' })
    const bad = await mountCard(sdk({ status: 'Invalid', errors: [{ message: 'raw SDK text' }] }) as any, setup, el)
    await expect(bad.tokenize({})).rejects.toMatchObject({ kind: 'input', message: CARD_WORDS.input })
  })
})
