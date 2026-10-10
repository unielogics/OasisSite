// @vitest-environment jsdom
// DV-THEME: the device decides the theme until the visitor picks one (stored on the device); the pre-hydration script
// patches the markup and the body background, and boot hands the same decision to the logic as its theme prop.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyTheme, decideTheme, deviceTheme, readStoredTheme, storeTheme, type ThemeConfig } from './theme'
import { withThemeDecision } from './boot'
import { startTheme } from './theme.entry'

const cfg: ThemeConfig = {
  storageKey: 'oasis-theme',
  attribute: 'data-theme',
  default: 'dark',
  values: ['dark', 'light'],
  prop: 'theme',
  followSystem: true,
  background: { dark: '#06080A', light: '#F2F3F1' },
}
const mm = (light: boolean) => (q: string) => ({ matches: light && q === '(prefers-color-scheme: light)' })
const store = (v: string | null) => ({ getItem: () => v })

describe('decideTheme', () => {
  it('follows the device when nothing is stored: light -> light, dark or no preference -> the default (dark)', () => {
    expect(decideTheme(cfg, store(null), mm(true))).toEqual({ theme: 'light', stored: false })
    expect(decideTheme(cfg, store(null), mm(false))).toEqual({ theme: 'dark', stored: false })
    expect(decideTheme(cfg, null, null)).toEqual({ theme: 'dark', stored: false })
    expect(deviceTheme({ ...cfg, followSystem: false }, mm(true))).toBe('dark')
    expect(
      deviceTheme(cfg, () => {
        throw new Error('no matchMedia')
      }),
    ).toBe('dark')
  })

  it('a stored choice wins over the device; unknown values and throwing storage read as nothing stored', () => {
    expect(decideTheme(cfg, store('dark'), mm(true))).toEqual({ theme: 'dark', stored: true })
    expect(decideTheme(cfg, store('light'), mm(false))).toEqual({ theme: 'light', stored: true })
    expect(decideTheme(cfg, store('neon'), mm(true))).toEqual({ theme: 'light', stored: false })
    const blocked = {
      getItem: () => {
        throw new Error('blocked')
      },
    }
    expect(readStoredTheme(cfg, blocked)).toBeNull()
    expect(decideTheme(cfg, blocked, mm(true))).toEqual({ theme: 'light', stored: false })
  })

  it('stores only theme values and survives a storage that throws', () => {
    const set = vi.fn()
    storeTheme(cfg, { setItem: set }, 'light')
    storeTheme(cfg, { setItem: set }, 'neon')
    expect(set.mock.calls).toEqual([['oasis-theme', 'light']])
    expect(() =>
      storeTheme(
        cfg,
        {
          setItem: () => {
            throw new Error('quota')
          },
        },
        'dark',
      ),
    ).not.toThrow()
  })
})

describe('applyTheme', () => {
  it('patches the default-themed elements and sets the body background like componentDidUpdate', () => {
    document.body.innerHTML = '<div id="dc-root"><div class="sc-host"><div data-oa="1" data-theme="dark"></div></div></div>'
    const root = document.getElementById('dc-root')!
    expect(applyTheme(root, document.body, cfg, 'light')).toBe(1)
    expect(root.querySelector('[data-oa]')!.getAttribute('data-theme')).toBe('light')
    expect(document.body.style.background).toBe('rgb(242, 243, 241)')
    document.body.innerHTML = '<div id="dc-root"><div data-theme="dark"></div></div>'
    expect(applyTheme(document.getElementById('dc-root')!, document.body, cfg, 'dark')).toBe(0)
    expect(document.body.style.background).toBe('rgb(6, 8, 10)')
  })
})

describe('the pre-hydration script and boot', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
    delete (window as unknown as { __oasisTheme?: unknown }).__oasisTheme
  })

  const run = async (light: boolean, stored: string | null) => {
    document.body.innerHTML = '<div id="dc-root"><div class="sc-host"><div data-oa="1" data-theme="dark"></div></div></div>'
    document.body.removeAttribute('style')
    if (stored) localStorage.setItem('oasis-theme', stored)
    vi.stubGlobal('__OASIS_THEME__', cfg)
    vi.stubGlobal('matchMedia', mm(light))
    vi.resetModules()
    await import('./theme.entry')
    return {
      attr: document.querySelector('[data-oa]')!.getAttribute('data-theme'),
      bg: document.body.style.background,
      decision: (window as unknown as { __oasisTheme?: { theme: string; stored: boolean } }).__oasisTheme,
    }
  }

  it('decides before hydration and exposes the decision (device light, device dark, stored over device)', async () => {
    expect(await run(true, null)).toEqual({ attr: 'light', bg: 'rgb(242, 243, 241)', decision: { theme: 'light', stored: false } })
    expect(await run(false, null)).toEqual({ attr: 'dark', bg: 'rgb(6, 8, 10)', decision: { theme: 'dark', stored: false } })
    expect(await run(true, 'dark')).toEqual({ attr: 'dark', bg: 'rgb(6, 8, 10)', decision: { theme: 'dark', stored: true } })
    expect(await run(false, 'light')).toEqual({ attr: 'light', bg: 'rgb(242, 243, 241)', decision: { theme: 'light', stored: true } })
  })

  it('boot puts the decision into the design theme prop (and nothing without a valid decision)', () => {
    const props = { theme: 'dark', beads: true }
    const theme = { prop: 'theme', values: ['dark', 'light'] }
    expect(withThemeDecision(props, theme, { theme: 'light' })).toEqual({ theme: 'light', beads: true })
    expect(Object.keys(withThemeDecision(props, theme, { theme: 'light' }))).toEqual(['theme', 'beads'])
    expect(withThemeDecision(props, theme, undefined)).toBe(props)
    expect(withThemeDecision(props, theme, { theme: 'neon' })).toBe(props)
    expect(withThemeDecision(props, null, { theme: 'light' })).toBe(props)
  })
})

describe('the theme script in <head> (DV-THEME: decided before anything of the body can be painted)', () => {
  /** A document the way the parser has it while the head script runs: <html> and <head>, no <body> yet. */
  const parsing = () => {
    const doc = document.implementation.createHTMLDocument('t')
    doc.documentElement.removeChild(doc.body)
    return doc
  }
  const win = (light: boolean, stored: string | null) =>
    ({
      localStorage: { getItem: () => stored },
      matchMedia: mm(light),
      MutationObserver: window.MutationObserver,
    }) as unknown as Window
  const tick = () => new Promise((r) => setTimeout(r, 0))

  it('marks <html> and paints the canvas at once, then patches the body and the wrapper the moment the parser inserts them', async () => {
    const doc = parsing()
    const w = win(true, null)
    expect(startTheme(cfg, doc, w)).toEqual({ theme: 'light', stored: false })
    expect((w as unknown as { __oasisTheme?: unknown }).__oasisTheme).toEqual({ theme: 'light', stored: false })
    expect(doc.documentElement.getAttribute('data-oasis-theme')).toBe('light')
    expect(doc.documentElement.style.background).toBe('rgb(242, 243, 241)')
    // the parser inserts <body>, #dc-root and the design's wrapper baked dark
    const body = doc.createElement('body')
    doc.documentElement.appendChild(body)
    body.innerHTML = '<div id="dc-root"><div class="sc-host"><div data-oa="1" data-theme="dark"></div></div></div>'
    await tick()
    expect(body.querySelector('[data-oa]')!.getAttribute('data-theme')).toBe('light')
    expect(body.style.background).toBe('rgb(242, 243, 241)')
    // the body's background paints the canvas now: <html> keeps no inline style (the design's html has none)
    expect(doc.documentElement.hasAttribute('style')).toBe(false)
    // done: the observer is disconnected (a later element is the logic's business, not the script's)
    body.insertAdjacentHTML('beforeend', '<div data-theme="dark" id="late"></div>')
    await tick()
    expect(doc.getElementById('late')!.getAttribute('data-theme')).toBe('dark')
  })

  it('a dark device keeps the baked dark markup and gets the dark canvas; a stored choice wins over the device', async () => {
    const dark = parsing()
    startTheme(cfg, dark, win(false, null))
    expect(dark.documentElement.getAttribute('data-oasis-theme')).toBe('dark')
    expect(dark.documentElement.style.background).toBe('rgb(6, 8, 10)')
    const b1 = dark.createElement('body')
    dark.documentElement.appendChild(b1)
    b1.innerHTML = '<div id="not-found" data-oa="1" data-theme="dark"></div>'
    await tick()
    expect(b1.querySelector('[data-oa]')!.getAttribute('data-theme')).toBe('dark')
    expect(b1.style.background).toBe('rgb(6, 8, 10)')
    const stored = parsing()
    expect(startTheme(cfg, stored, win(false, 'light'))).toEqual({ theme: 'light', stored: true })
    const b2 = stored.createElement('body')
    stored.documentElement.appendChild(b2)
    b2.innerHTML = '<div id="not-found" data-oa="1" data-theme="dark"></div>'
    await tick()
    expect(b2.querySelector('[data-oa]')!.getAttribute('data-theme')).toBe('light')
  })
})
