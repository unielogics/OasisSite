// parity:phone — smoke of dist at phone (390x844) and tablet (768x1024) viewports: every page loads from the
// in-process dist server, hydrates without console errors or page errors, the hours endpoint is answered, and a
// full-page screenshot plus the document's scroll size land in parity-reports/phone/. Informational for a
// fixed-width design (the viewport meta decides how phones scale it); a hard failure only on errors.
import './env'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { launchBrowser, newParityContext } from './browser'
import { FIXED_NOW, PAGES, PHONE_VIEWPORTS, REPORTS_DIR, THEMES } from './config'
import { startDistServer } from './serve-dist'

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { dist: { type: 'string' }, hours: { type: 'string' } },
    strict: true,
  })
  const server = await startDistServer({
    dir: values.dist ?? 'dist',
    port: 0,
    hours: values.hours === 'alt' ? 'alt' : 'design',
  })
  const browser = await launchBrowser()
  const outDir = path.join(REPORTS_DIR, 'phone')
  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
  const lines: string[] = []
  let failures = 0
  try {
    for (const vp of PHONE_VIEWPORTS) {
      // both device color schemes: the site follows the device (DV-THEME), and each must hydrate without an error
      for (const theme of THEMES) {
        for (const p of PAGES) {
          const pc = await newParityContext(browser, {
            theme,
            allowedOrigins: [server.origin],
            hideBranding: false,
            touch: true,
            clock: 'fixed',
            fixedNow: FIXED_NOW,
            viewport: { width: vp.width, height: vp.height },
          })
          const url = server.url(p.route)
          await pc.page.goto(url, { waitUntil: 'load', timeout: 45_000 })
          await pc.page.waitForSelector('#dc-root .sc-host', { state: 'attached', timeout: 30_000 })
          const hydrated = await pc.page.evaluate(
            () => !!document.querySelector('script[src*="/assets/page-"]'),
          )
          if (hydrated)
            await pc.page.waitForFunction(
              () =>
                !!document.querySelector('#dc-root [data-oasis-ready], #dc-root .sc-host') &&
                document.readyState === 'complete',
              null,
              { timeout: 30_000 },
            )
          await pc.page.waitForTimeout(500)
          const dataTheme = await pc.page.evaluate(
            () => document.querySelector('#dc-root [data-theme]')?.getAttribute('data-theme') ?? '',
          )
          const themeErrors = dataTheme && dataTheme !== theme ? [{ type: 'theme', text: `data-theme ${dataTheme} on a ${theme} device` }] : []
          const size = await pc.page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            scrollHeight: document.documentElement.scrollHeight,
            innerWidth: window.innerWidth,
          }))
          const file = path.join(outDir, `${p.slug}-${vp.name}-${theme}.png`)
          await pc.page.screenshot({ path: file, fullPage: true, animations: 'disabled', caret: 'hide' })
          const console_ = pc.takeConsole()
          const blocked = pc.takeBlocked()
          const errors = [...console_.filter((m) => m.type !== 'warning'), ...themeErrors]
          const ok = errors.length === 0 && blocked.length === 0
          if (!ok) failures++
          lines.push(
            `${ok ? 'ok  ' : 'FAIL'} ${p.slug}@${vp.name}/${theme} ${vp.width}x${vp.height}: data-theme=${dataTheme} hydrated=${hydrated} scroll ${size.scrollWidth}x${size.scrollHeight} (innerWidth ${size.innerWidth}) console ${console_.length} blocked ${blocked.length} hours requests so far ${server.hoursRequests()}` +
              (errors.length ? `\n      ${errors.map((e) => `${e.type}: ${e.text}`).join('\n      ')}` : '') +
              (blocked.length ? `\n      blocked: ${blocked.join(', ')}` : ''),
          )
          await pc.ctx.close()
        }
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
  fs.writeFileSync(path.join(outDir, 'summary.txt'), lines.join('\n') + '\n')
  console.log(lines.join('\n'))
  console.log(
    `\nparity:phone ${failures ? 'FAILED' : 'PASSED'} (${PAGES.length * PHONE_VIEWPORTS.length * THEMES.length} loads, screenshots in ${path.relative(process.cwd(), outDir)})`,
  )
  return failures ? 1 : 0
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e)
    process.exit(1)
  },
)
