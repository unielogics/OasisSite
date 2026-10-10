// intake:probe — renders every page's ORIGINAL bundle in the pinned Chromium and records what the dc runtime
// actually produced: the <head> children in order (classified), #dc-root outerHTML, the pseudo-class sheet
// (.scpN rules in insertion order), the fonts that loaded, the console. design/probe/<slug>.json is the ground
// truth the compiler's head/pseudo/CSS tests compare against (the probe never looks at the port).
// Usage: tsx tools/intake/probe-original.ts [--pages design/pages.json] [--out design/probe] [--theme light|dark]
import '../parity/env'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchBrowser, newParityContext } from '../parity/browser'
import { defaultIntercepts } from '../parity/cdn'
import { settleInPage } from '../parity/collect'
import { ROOT, THEME_KEY, VIEWPORT, type Theme } from '../parity/config'
import { startOriginalServer } from '../parity/serve-original'
import { loadPages } from '../dc-compile/pages'

export interface HeadEntry {
  tag: string
  attrs: Record<string, string>
  /** style elements: how the harness classifies them */
  kind?:
    | 'base'
    | 'hide-x-dc'
    | 'atomics'
    | 'pseudo'
    | 'full-page'
    | 'helmet-fontface'
    | 'helmet'
    | 'canvas'
    | 'unknown'
  /** style elements: the text (first 200 chars) and a sha256 of the whole text */
  textHead?: string
  sha256?: string
  chars?: number
}

export interface ProbeResult {
  slug: string
  theme: Theme
  title: string
  head: HeadEntry[]
  pseudoRules: string[]
  rootHtml: string
  rootSha256: string
  fonts: { family: string; weight: string; style: string; status: string }[]
  console: { type: string; text: string }[]
  blocked: string[]
  viewport: { width: number; height: number }
  scrollHeight: number
}

const IN_PAGE_COLLECT = `(() => {
  const sha = null;
  const out = { head: [], pseudoRules: [], rootHtml: '', title: document.title, fonts: [], scrollHeight: document.documentElement.scrollHeight };
  for (const el of Array.from(document.head.children)) {
    const attrs = {};
    for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;
    const entry = { tag: el.tagName.toLowerCase(), attrs };
    if (el.tagName === 'STYLE') {
      const text = el.textContent || '';
      entry.textHead = text.slice(0, 200);
      entry.chars = text.length;
      entry.text = text;
      const rules = el.sheet ? Array.from(el.sheet.cssRules).map((r) => r.cssText) : [];
      if (rules.length && rules.every((r) => /^\\.scp[0-9a-z]+:/.test(r))) { entry.kind = 'pseudo'; out.pseudoRules.push(...rules); }
      else if (text.includes('.sc-placeholder{') && text.includes('sc-logic-error')) entry.kind = 'base';
      else if (text.trim() === 'x-dc{display:none!important}') entry.kind = 'hide-x-dc';
      else if (text.startsWith('.fx{display:flex}')) entry.kind = 'atomics';
      else if (text === 'html,body{height:100%;margin:0}#dc-root,#dc-root>.sc-host{height:100%}') entry.kind = 'full-page';
      else if (attrs['data-dc-canvas'] !== undefined) entry.kind = 'canvas';
      else if (text.includes('@font-face')) entry.kind = 'helmet-fontface';
      else if (attrs['data-parity'] !== undefined) entry.kind = 'unknown';
      else entry.kind = 'helmet';
    }
    out.head.push(entry);
  }
  const root = document.getElementById('dc-root');
  out.rootHtml = root ? root.outerHTML : '';
  for (const f of document.fonts) out.fonts.push({ family: f.family, weight: f.weight, style: f.style, status: f.status });
  return JSON.stringify(out);
})()`

export async function probePages(
  opts: { pagesFile?: string; outDir?: string; theme?: Theme; log?: (l: string) => void } = {},
): Promise<ProbeResult[]> {
  const { pages } = loadPages(ROOT, opts.pagesFile)
  const outDir = path.resolve(ROOT, opts.outDir ?? 'design/probe')
  const theme: Theme = opts.theme ?? 'light'
  const log = opts.log ?? ((l: string) => console.log(l))
  const crypto = await import('node:crypto')
  const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
  const server = await startOriginalServer({ pages, port: 0 })
  const browser = await launchBrowser()
  const results: ProbeResult[] = []
  try {
    for (const p of pages) {
      const pc = await newParityContext(browser, {
        theme,
        allowedOrigins: [server.origin],
        hideBranding: true,
        intercepts: defaultIntercepts(),
      })
      await pc.page.goto(server.url(p.slug), { waitUntil: 'load', timeout: 45_000 })
      await pc.page.waitForSelector('#dc-root .sc-host', { state: 'attached', timeout: 30_000 })
      // the clock is paused: never wait on setTimeout here; MessageChannel ticks are not under the fake clock
      await pc.page.evaluate(settleInPage)
      await pc.ctx.clock.runFor(50)
      await pc.page.evaluate(settleInPage)
      const raw = JSON.parse((await pc.page.evaluate(IN_PAGE_COLLECT)) as string) as {
        head: (HeadEntry & { text?: string })[]
        pseudoRules: string[]
        rootHtml: string
        title: string
        fonts: ProbeResult['fonts']
        scrollHeight: number
      }
      // drop the harness's own style and the bundler's resource map script from the record
      const head = raw.head
        .filter((h) => !(h.tag === 'style' && h.attrs['data-parity'] !== undefined))
        .map((h) => {
          const { text, ...rest } = h
          return text !== undefined ? { ...rest, sha256: sha(text) } : rest
        })
      const r: ProbeResult = {
        slug: p.slug,
        theme,
        title: raw.title,
        head,
        pseudoRules: raw.pseudoRules,
        rootHtml: raw.rootHtml,
        rootSha256: sha(raw.rootHtml),
        fonts: raw.fonts,
        console: pc.takeConsole(),
        blocked: pc.takeBlocked(),
        viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
        scrollHeight: raw.scrollHeight,
      }
      results.push(r)
      fs.mkdirSync(outDir, { recursive: true })
      fs.writeFileSync(path.join(outDir, `${p.slug}.json`), JSON.stringify(r, null, 2) + '\n')
      log(
        `probe ${p.slug}@${theme}: head ${r.head.length} entries [${r.head
          .filter((h) => h.tag === 'style')
          .map((h) => h.kind)
          .join(
            ', ',
          )}], ${r.pseudoRules.length} pseudo rules, root ${r.rootHtml.length} chars, ${r.fonts.filter((f) => f.status === 'loaded').length}/${r.fonts.length} fonts loaded, ${r.console.length} console, ${r.blocked.length} blocked`,
      )
      await pc.ctx.close()
    }
  } finally {
    await browser.close()
    await server.close()
  }
  return results
}

async function main(argv: string[]): Promise<number> {
  let pagesFile: string | undefined
  let outDir: string | undefined
  let theme: Theme = 'light'
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const eq = a.indexOf('=')
    const key = eq > 0 ? a.slice(0, eq) : a
    const val = () => (eq > 0 ? a.slice(eq + 1) : argv[++i]) ?? ''
    if (key === '--pages') pagesFile = val()
    else if (key === '--out') outDir = val()
    else if (key === '--theme') theme = val() as Theme
    else {
      console.error(`unknown argument ${a}`)
      return 2
    }
  }
  await probePages({ pagesFile, outDir, theme })
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error(e instanceof Error ? (e.stack ?? e.message) : e)
      process.exit(1)
    },
  )
}
export { THEME_KEY }
