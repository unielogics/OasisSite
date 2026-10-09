import './env'
import fs from 'node:fs'
import path from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import {
  CHROMIUM_FLAGS,
  FIXED_NOW,
  FONTCONFIG_FILE,
  LOCALE,
  REPORTS_DIR,
  THEME_KEY,
  TIMEZONE,
  VIEWPORT,
  type Theme,
} from './config'
import type { ConsoleMsg } from './types'

/** Chromium with pinned flags, and FONTCONFIG_FILE pointing at the vendored fallback fonts only. */
export async function launchBrowser(): Promise<Browser> {
  fs.mkdirSync(path.join(REPORTS_DIR, '.fontcache'), { recursive: true })
  return chromium.launch({
    args: [
      ...CHROMIUM_FLAGS,
      ...(process.env.PARITY_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
      // experiments only (space separated); anything that proves necessary belongs in CHROMIUM_FLAGS
      ...(process.env.PARITY_EXTRA_FLAGS ? process.env.PARITY_EXTRA_FLAGS.split(/\s+/).filter(Boolean) : []),
    ],
    env: { ...process.env, FONTCONFIG_FILE, TZ: TIMEZONE, LANG: 'en_US.UTF-8' } as Record<string, string>,
  })
}

/** Added to every page: makes esbuild/tsx `keepNames` helpers harmless inside functions that Playwright serialises. */
const NAME_SHIM = `if (!window.__name) window.__name = function (f) { return f };`

const NO_ANIMATION_CSS =
  '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}'
const HIDE_BRANDING_CSS = '#__claude_design_branding{display:none!important}'

export interface ParityContextOptions {
  theme: Theme
  /** origins the page may talk to; everything else is aborted (data:, blob: and about: are always allowed) */
  allowedOrigins: string[]
  /** hide the "Made with Claude Design" badge that the original bundles append to <body> */
  hideBranding: boolean
  touch?: boolean
  /**
   * `paused` (default): the fake clock is installed and paused at FIXED_NOW; time only moves through clock.runFor.
   * `fixed`: Date is pinned to `fixedNow` but timers keep running (the phone smoke and the probe, which need real
   * timers for the hours fetch and the runtime's boot).
   */
  clock?: 'paused' | 'fixed'
  fixedNow?: string
  /** viewport override (the phone smoke); default VIEWPORT */
  viewport?: { width: number; height: number }
}

export interface ParityContext {
  ctx: BrowserContext
  page: Page
  /** console warnings/errors, uncaught page errors and dialogs seen since the last takeConsole() */
  takeConsole(): ConsoleMsg[]
  /** URLs of requests the network block aborted since the last takeBlocked() */
  takeBlocked(): string[]
}

export async function newParityContext(browser: Browser, opts: ParityContextOptions): Promise<ParityContext> {
  const ctx = await browser.newContext({
    viewport: { ...(opts.viewport ?? VIEWPORT) },
    deviceScaleFactor: 1,
    timezoneId: TIMEZONE,
    locale: LOCALE,
    colorScheme: 'light',
    hasTouch: opts.touch ?? false,
    serviceWorkers: 'block',
    acceptDownloads: false,
  })
  const allowed = new Set(opts.allowedOrigins)
  const blocked: string[] = []
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url())
    if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:' || allowed.has(u.origin))
      return route.continue()
    blocked.push(route.request().url())
    return route.abort()
  })
  // Fresh storage per context; the theme is seeded before the page script runs (only when nothing is stored yet, so a
  // scenario that toggles the theme keeps it across a reload).
  await ctx.addInitScript(
    `${NAME_SHIM}
    try { if (!localStorage.getItem(${JSON.stringify(THEME_KEY)})) localStorage.setItem(${JSON.stringify(THEME_KEY)}, ${JSON.stringify(opts.theme)}); } catch (e) {}
    (function () {
      var css = ${JSON.stringify(NO_ANIMATION_CSS + (opts.hideBranding ? HIDE_BRANDING_CSS : ''))};
      function ensure() {
        if (document.querySelector('style[data-parity]')) return true;
        var parent = document.head || document.documentElement;
        if (!parent) return false;
        var s = document.createElement('style');
        s.setAttribute('data-parity', '1');
        s.textContent = css;
        parent.appendChild(s);
        return true;
      }
      ensure();
      // The bundler replaces the document element while unpacking, so keep the rule alive for the whole page life.
      new MutationObserver(ensure).observe(document, { childList: true });
    })();`,
  )
  // Pin the clock: install slightly before the target, then pause AT the target so the page boots at exactly FIXED_NOW.
  // From here time only moves through ctx.clock.runFor().
  const nowText = opts.fixedNow ?? FIXED_NOW
  const t0 = new Date(nowText)
  if (Number.isNaN(t0.getTime())) throw new Error(`PARITY_FIXED_NOW is not a valid instant: ${nowText}`)
  if (!/(Z|[+-]\d\d:?\d\d)$/.test(nowText))
    throw new Error(`PARITY_FIXED_NOW needs an explicit UTC offset: ${nowText}`)
  if (opts.clock === 'fixed') {
    await ctx.clock.setFixedTime(t0)
  } else {
    await ctx.clock.install({ time: new Date(t0.getTime() - 1000) })
    await ctx.clock.pauseAt(t0)
  }

  const page = await ctx.newPage()
  let msgs: ConsoleMsg[] = []
  page.on('console', (m) => {
    const type = m.type()
    if (type === 'warning' || type === 'error') msgs.push({ type, text: m.text() })
  })
  page.on('pageerror', (e) => msgs.push({ type: 'pageerror', text: String(e.message ?? e) }))
  page.on('dialog', (d) => {
    msgs.push({ type: 'dialog', text: `${d.type()}: ${d.message()}` })
    void d.dismiss()
  })
  page.on('popup', (p) => void p.close())
  return {
    ctx,
    page,
    takeConsole: () => {
      const out = msgs
      msgs = []
      return out
    },
    takeBlocked: () => blocked.splice(0, blocked.length),
  }
}
