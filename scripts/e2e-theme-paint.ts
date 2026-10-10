// e2e-theme-paint: the theme decision happens before the first paint, also on a slow network (DEVIATIONS.md DV-THEME).
//
//   pnpm e2e:theme-paint [--dist dist] [--port 3305] [--delay 1000] [--headed]
//
// Serves a build through tools/site/proxy.ts (the fixture API behind /api/v1/public/*), holds every request for
// /assets/theme.<hash>.js back by --delay ms, and records EVERY frame the compositor produces from the navigation on
// (CDP Page.startScreencast), on a light device and on a dark device, with and without a stored choice, for the home
// page and the 404 page. Each frame is classified by its pixels (dark: most pixels near #06080A, light: most pixels near
// #F2F3F1). Fails when a light device ever shows a dark frame, a dark device a light frame, a stored choice is not the
// first theme painted, or no page frame was seen at all. Before the fix (the theme script after #dc-root) the browser
// painted the prerendered dark markup while the script was still loading.
import '../tools/parity/env'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { chromium, type Browser } from '@playwright/test'
import { PNG } from 'pngjs'
import { startFixtureApi } from '../tools/site/fixture-api'
import { startSiteProxy } from '../tools/site/proxy'
import { ROOT, CHROMIUM_FLAGS } from '../tools/parity/config'

type Theme = 'light' | 'dark'
type Kind = Theme | 'neutral' | 'other'

/** The share of pixels near each theme's page background (luminance), from a PNG frame. */
export function classifyFrame(png: Buffer): { kind: Kind; dark: number; light: number } {
  const img = PNG.sync.read(png)
  let dark = 0
  let light = 0
  let grey = 0
  const n = img.width * img.height
  for (let i = 0; i < img.data.length; i += 4) {
    const y = 0.2126 * img.data[i]! + 0.7152 * img.data[i + 1]! + 0.0722 * img.data[i + 2]!
    if (y < 48) dark++
    else if (y > 200) light++
    else if (y > 110 && y < 146) grey++
  }
  const d = dark / n
  const l = light / n
  const kind: Kind = grey / n > 0.9 ? 'neutral' : d > 0.5 ? 'dark' : l > 0.5 ? 'light' : 'other'
  return { kind, dark: Math.round(d * 100), light: Math.round(l * 100) }
}

interface Case {
  name: string
  route: string
  device: Theme
  stored: Theme | null
  /** the only theme that may ever be painted */
  want: Theme
}

async function runCase(browser: Browser, origin: string, c: Case, delay: number): Promise<{ ok: boolean; note: string }> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: c.device, locale: 'en-US', timezoneId: 'America/New_York' })
  try {
    if (c.stored) await ctx.addInitScript(`try { localStorage.setItem('oasis-theme', ${JSON.stringify(c.stored)}) } catch (e) {}`)
    let themeServedAt = 0
    await ctx.route('**/assets/theme.*.js', async (route) => {
      await new Promise((r) => setTimeout(r, delay))
      themeServedAt = Date.now()
      await route.continue()
    })
    const page = await ctx.newPage()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    // a mid-grey start page: any frame left over from before the navigation reads "neutral", never as a theme
    await page.setContent('<html><body style="margin:0;background:#808080;height:100vh"></body></html>')
    const cdp = await ctx.newCDPSession(page)
    const frames: { at: number; kind: Kind; dark: number; light: number }[] = []
    cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number }) => {
      const at = Date.now()
      try {
        frames.push({ at, ...classifyFrame(Buffer.from(f.data, 'base64')) })
      } catch {
        /* not a decodable frame */
      }
      void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
    })
    await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: 390, maxHeight: 844 })
    const t0 = Date.now()
    await page.goto(origin + c.route, { waitUntil: 'load', timeout: 30_000 })
    // a few more frames after load (hydration, the bridge's first re-render)
    await page.waitForTimeout(800)
    await cdp.send('Page.stopScreencast').catch(() => {})
    const final = classifyFrame(await page.screenshot())
    const painted = frames.filter((f) => f.kind === 'light' || f.kind === 'dark')
    const wrong = painted.filter((f) => f.kind !== c.want)
    const first = painted[0]
    const timeline = frames.map((f) => `${f.at - t0}ms:${f.kind}(${f.dark}/${f.light})`).join(' ')
    const ok =
      themeServedAt > 0 &&
      painted.length > 0 &&
      wrong.length === 0 &&
      first?.kind === c.want &&
      final.kind === c.want &&
      errors.length === 0
    const note = `theme.js held ${delay} ms (served at +${themeServedAt ? themeServedAt - t0 : -1} ms); ${frames.length} frame(s), ${painted.length} painted, ${wrong.length} in the wrong theme; first painted ${first ? `${first.kind} at +${first.at - t0} ms` : 'none'}; final ${final.kind}${errors.length ? `; page errors: ${errors.join(' | ')}` : ''}\n       frames: ${timeline}`
    return { ok, note }
  } finally {
    await ctx.close()
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      dist: { type: 'string', default: 'dist' },
      port: { type: 'string', default: '3305' },
      'api-port': { type: 'string', default: '3306' },
      delay: { type: 'string', default: '1000' },
      headed: { type: 'boolean', default: false },
    },
  })
  const dir = path.resolve(ROOT, values.dist!)
  if (!fs.existsSync(path.join(dir, 'index.html'))) {
    console.error(`${dir} has no index.html (pnpm build first)`)
    return 2
  }
  const delay = Number(values.delay)
  const api = await startFixtureApi({ port: Number(values['api-port']) })
  const proxy = await startSiteProxy({ dir, apiOrigin: api.origin, port: Number(values.port) })
  const browser = await chromium.launch({ headless: !values.headed, args: CHROMIUM_FLAGS })
  const cases: Case[] = [
    { name: 'home, light device, nothing stored', route: '/', device: 'light', stored: null, want: 'light' },
    { name: 'home, dark device, nothing stored', route: '/', device: 'dark', stored: null, want: 'dark' },
    { name: 'home, dark device, light stored', route: '/', device: 'dark', stored: 'light', want: 'light' },
    { name: 'home, light device, dark stored', route: '/', device: 'light', stored: 'dark', want: 'dark' },
    { name: '404, light device, nothing stored', route: '/no-such-page', device: 'light', stored: null, want: 'light' },
    { name: '404, dark device, nothing stored', route: '/no-such-page', device: 'dark', stored: null, want: 'dark' },
  ]
  let failures = 0
  try {
    for (const c of cases) {
      const r = await runCase(browser, proxy.origin, c, delay)
      if (!r.ok) failures++
      console.log(`${r.ok ? 'ok  ' : 'FAIL'} theme first paint: ${c.name} -> only ${c.want} frames — ${r.note}`)
    }
  } finally {
    await browser.close()
    await proxy.close()
    await api.close()
  }
  console.log(`e2e-theme-paint: ${cases.length - failures}/${cases.length} passed (${values.dist}, theme.js delayed ${delay} ms)`)
  return failures ? 1 : 0
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e)
    process.exit(1)
  },
)
