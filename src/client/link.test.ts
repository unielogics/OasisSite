// @vitest-environment jsdom
// DV-LINK: the token of a personal link leaves the address bar and the history entry before hydration, stays in memory,
// and a second link opened in the same tab is captured the same way.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installLinkCapture, onLink, parseLinkFragment, resetLinkCapture, takeLink } from './link'

const TOKEN = 'Q2xpZW50TGlua1Rva2VuLTMyLWJ5dGVzLWJhc2U2NHVybA'
const TOKEN2 = 'U2Vjb25kTGlua1Rva2VuLTMyLWJ5dGVzLWJhc2U2NHVybA'

beforeEach(() => {
  resetLinkCapture()
  history.replaceState(null, '', '/')
})
afterEach(() => resetLinkCapture())

describe('parseLinkFragment', () => {
  it('reads the five link routes and nothing else', () => {
    expect(parseLinkFragment(`#/c/${TOKEN}`)).toEqual({ path: 'c', token: TOKEN })
    expect(parseLinkFragment(`#/m/${TOKEN}`)).toEqual({ path: 'm', token: TOKEN })
    expect(parseLinkFragment(`#/p/${TOKEN}/`)).toEqual({ path: 'p', token: TOKEN })
    expect(parseLinkFragment(`#/pin/${TOKEN}`)).toEqual({ path: 'pin', token: TOKEN })
    expect(parseLinkFragment(`#/v/${TOKEN}`)).toEqual({ path: 'v', token: TOKEN })
    expect(parseLinkFragment('#/membership')).toBeNull()
    expect(parseLinkFragment('#/join?gold')).toBeNull()
    expect(parseLinkFragment('#/x/' + TOKEN)).toBeNull()
    expect(parseLinkFragment('#/c/')).toBeNull()
    expect(parseLinkFragment('#/c/ ab')).toBeNull()
    expect(parseLinkFragment('#/c/%20ab')).toBeNull()
    expect(parseLinkFragment('#/c/' + 'a'.repeat(257))).toBeNull()
    expect(parseLinkFragment('')).toBeNull()
  })

  it('takes the base64url token and ignores what a messaging app or a shortener adds after it', () => {
    expect(parseLinkFragment(`#/c/${TOKEN}?utm_source=sms`)).toEqual({ path: 'c', token: TOKEN })
    expect(parseLinkFragment(`#/m/${TOKEN}&x=1`)).toEqual({ path: 'm', token: TOKEN })
    expect(parseLinkFragment(`#/p/${TOKEN}.`)).toEqual({ path: 'p', token: TOKEN })
    expect(parseLinkFragment(`#/v/${TOKEN}/extra`)).toEqual({ path: 'v', token: TOKEN })
    expect(parseLinkFragment(`#/pin/${TOKEN}%20`)).toEqual({ path: 'pin', token: TOKEN })
  })
})

describe('installLinkCapture', () => {
  it('scrubs the fragment from the address bar and the history entry, and keeps the token in memory', () => {
    history.replaceState({ k: 1 }, '', `/#/c/${TOKEN}`)
    const before = history.length
    installLinkCapture(window as never)
    expect(location.href).not.toContain(TOKEN)
    expect(location.hash).toBe('')
    expect(location.pathname).toBe('/')
    expect(history.length).toBe(before) // replaced, not pushed
    expect(history.state).toEqual({ k: 1 })
    expect(JSON.stringify(localStorage)).not.toContain(TOKEN)
    expect(JSON.stringify(sessionStorage)).not.toContain(TOKEN)
    expect(takeLink()).toEqual({ path: 'c', token: TOKEN })
    expect(takeLink()).toBeNull() // taken once
  })

  it('leaves ordinary hash routes alone', () => {
    history.replaceState(null, '', '/#/membership')
    installLinkCapture(window as never)
    expect(location.hash).toBe('#/membership')
    expect(takeLink()).toBeNull()
  })

  it('scrubs a malformed link fragment too, without a link', () => {
    history.replaceState(null, '', '/#/c/ not-a-token')
    installLinkCapture(window as never)
    expect(location.hash).toBe('')
    expect(takeLink()).toBeNull()
  })

  it('a link with something added after the token is scrubbed whole and still opens', () => {
    history.replaceState(null, '', `/#/c/${TOKEN}?utm_source=sms`)
    installLinkCapture(window as never)
    expect(location.hash).toBe('')
    expect(location.href).not.toContain(TOKEN)
    expect(takeLink()).toEqual({ path: 'c', token: TOKEN })
  })

  it('a second link in the same tab: scrubbed before the design reads the hash, handed to the listener', () => {
    installLinkCapture(window as never)
    const got: string[] = []
    const seenByDesign: string[] = []
    const off = onLink((l) => got.push(l.token))
    // the design registers its hashchange handler later (componentDidMount): it must see the scrubbed URL
    const design = () => seenByDesign.push(location.hash)
    window.addEventListener('hashchange', design)
    history.pushState(null, '', `/#/m/${TOKEN2}`)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    expect(got).toEqual([TOKEN2])
    expect(seenByDesign).toEqual([''])
    expect(location.href).not.toContain(TOKEN2)
    window.removeEventListener('hashchange', design)
    off()
  })

  it('a link that arrives before anyone listens waits for takeLink', () => {
    installLinkCapture(window as never)
    history.pushState(null, '', `/#/p/${TOKEN2}`)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    expect(takeLink()).toEqual({ path: 'p', token: TOKEN2 })
  })

  it('is idempotent for one window', () => {
    history.replaceState(null, '', `/#/v/${TOKEN}`)
    installLinkCapture(window as never)
    installLinkCapture(window as never)
    expect(takeLink()?.token).toBe(TOKEN)
    const got: string[] = []
    onLink((l) => got.push(l.token))
    history.pushState(null, '', `/#/v/${TOKEN2}`)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    expect(got).toEqual([TOKEN2]) // one listener, not two
  })
})
