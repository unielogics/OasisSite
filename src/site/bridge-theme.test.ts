// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
// DV-THEME in the bridge: a live change of the device setting is applied through the design's own state (themeOverride)
// only while the visitor has stored no choice, and is never stored; the design's header toggle and menu Dark/Light are
// stored on the device. The base class below is the design's theme mechanics in miniature (theme(), toggleTheme,
// setDark, setLight, a synchronous setState like DCLogic's).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bridge } from './index.bridge'
import type { SiteEnv } from './env'
import hours from '../data/hours.fallback.json'

class DesignLike {
  props: any
  state: any
  constructor(props?: any) {
    this.props = props || {}
    this.state = { themeOverride: null, bk: {}, sheet: null }
  }
  theme(): string {
    return this.state.themeOverride || (this.props.theme === 'light' ? 'light' : 'dark')
  }
  setState(p: any): void {
    this.state = { ...this.state, ...(typeof p === 'function' ? p(this.state) : p) }
  }
  forceUpdate(): void {}
  parseHash(): any {
    return { page: 'home', tier: 'vip' }
  }
  componentDidMount(): void {}
  componentWillUnmount(): void {}
  renderVals(): any {
    const th = this.theme()
    return {
      theme: th,
      toggleTheme: () => this.setState({ themeOverride: th === 'dark' ? 'light' : 'dark' }),
      setDark: () => this.setState({ themeOverride: 'dark' }),
      setLight: () => this.setState({ themeOverride: 'light' }),
    }
  }
}

const env = {
  booking: 'sms',
  apiOrigin: '',
  endpoints: { hours: '/h', availability: '/a', bookings: '/b', otp: '/o', otpVerify: '/v', memberships: '/m', catalog: '/c' },
  timeouts: { hours: 100, availability: 100, api: 100 },
  buildNow: '2026-06-13T10:36:00-04:00',
  tz: 'America/New_York',
  hours,
  hoursSource: 'fallback',
  availability: null,
  availabilitySource: 'none',
  availabilityDays: 5,
  contact: { phoneE164: '+12015986304', phoneDisplay: '201-598-6304', smsE164: '+18623885827', smsDisplay: '862-388-5827', email: 'x@y', smsKeyword: 'WASH', address: { line1: '', city: '', region: '', postalCode: '', country: '' }, addressShort: '', mapsUrl: '' },
  catalog: { services: {}, addons: {}, plans: {} },
  fee: { cents: 2500, text: '' },
  brand: 'Oasis Auto Spa',
  theme: { storageKey: 'oasis-theme', attribute: 'data-theme', default: 'dark', values: ['dark', 'light'], prop: 'theme', followSystem: true, background: { dark: '#06080A', light: '#F2F3F1' } },
} as unknown as SiteEnv

/** A matchMedia whose (prefers-color-scheme: light) answer the test flips, notifying the listeners like a browser. */
function device(light: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>()
  const mq = {
    get matches() {
      return light
    },
    addEventListener: (_t: string, f: any) => listeners.add(f),
    removeEventListener: (_t: string, f: any) => listeners.delete(f),
  }
  vi.stubGlobal('matchMedia', () => mq)
  return {
    set(v: boolean) {
      light = v
      for (const f of listeners) f({ matches: v })
    },
    listeners,
  }
}

const Site = bridge(DesignLike as any, env)
const mount = (theme: string) => {
  const c = new Site({ theme })
  c.componentDidMount()
  return c
}

describe('the bridge follows the device until the visitor chooses (DV-THEME)', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('applies live device changes while nothing is stored, and never stores them', () => {
    const d = device(true)
    const c = mount('light') // boot passed the pre-hydration decision
    expect(c.theme()).toBe('light')
    expect(c.state.themeOverride).toBeNull()
    d.set(false)
    expect(c.theme()).toBe('dark')
    d.set(true)
    expect(c.theme()).toBe('light')
    expect(localStorage.getItem('oasis-theme')).toBeNull()
    c.componentWillUnmount()
    expect(d.listeners.size).toBe(0)
  })

  it('stores the header toggle and the menu choice; a stored choice ignores later device changes', () => {
    const d = device(true)
    const c = mount('light')
    c.renderVals().toggleTheme()
    expect(c.theme()).toBe('dark')
    expect(localStorage.getItem('oasis-theme')).toBe('dark')
    d.set(false)
    d.set(true)
    expect(c.theme()).toBe('dark')
    c.renderVals().setLight()
    expect(localStorage.getItem('oasis-theme')).toBe('light')
    c.renderVals().setDark()
    expect(localStorage.getItem('oasis-theme')).toBe('dark')
  })

  it('without the pre-hydration decision (the script did not run) it applies the device or stored theme on mount', () => {
    device(true)
    expect(mount('dark').theme()).toBe('light')
    localStorage.setItem('oasis-theme', 'dark')
    expect(mount('dark').theme()).toBe('dark')
  })

  it('survives a storage that throws', () => {
    const d = device(true)
    const c = mount('light')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(() => c.renderVals().toggleTheme()).not.toThrow()
    expect(c.theme()).toBe('dark')
    d.set(true) // nothing was stored: the device still decides
    expect(c.theme()).toBe('light')
    vi.restoreAllMocks()
  })
})
