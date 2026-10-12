/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'parse5'
import { describe, expect, it } from 'vitest'
import { checkDist, themeScriptProblems } from '../../scripts/check-dist'
import { formatHours, validatePublicHours } from '../../src/hours/format'
import type { PublicHours } from '../../src/hours/format'
import { root } from '../intake/fixtures'
import { AssetStore } from './assets'
import { buildSite } from './build'
import { buildDocument, designViewport, notFoundDocument, robotsTxt, sitemapXml } from './head'
import { renderPage } from './render'
import { loadSeo, loadSiteConfig, localBusinessJsonLd, seoFor } from './seo'
import { installShims } from './shims'
import type { CompiledPageMeta } from '../dc-compile/compile'

const fallback = JSON.parse(
  fs.readFileSync(path.join(root, 'src/data/hours.fallback.json'), 'utf8'),
) as PublicHours
const site = loadSiteConfig(root)

describe('shims', () => {
  it('provide deterministic storage, matchMedia, location and an optional pinned Date, and restore the globals', () => {
    const g = globalThis as any
    const hadLocation = 'location' in g
    const h = installShims({
      route: '/x',
      siteUrl: 'https://example.test',
      storage: { 'oasis-theme': 'light' },
      now: '2026-06-13T10:36:00-04:00',
      timeZone: 'America/New_York',
    })
    try {
      expect(g.localStorage.getItem('oasis-theme')).toBe('light')
      g.localStorage.setItem('k', 'v')
      expect(h.storageWrites).toEqual({ k: 'v' })
      expect(g.matchMedia('(prefers-color-scheme: dark)').matches).toBe(false)
      expect(g.location.pathname).toBe('/x')
      expect(g.location.hash).toBe('')
      expect(g.innerWidth).toBe(1480)
      expect(Date.now()).toBe(new Date('2026-06-13T10:36:00-04:00').getTime())
      expect(new Date().toISOString()).toBe('2026-06-13T14:36:00.000Z')
      expect(new Date(2026, 5, 13).getFullYear()).toBe(2026)
      expect(new Date() instanceof Date).toBe(true)
    } finally {
      h.restore()
    }
    expect('location' in g).toBe(hadLocation)
    expect(Math.abs(Date.now() - new Date().getTime())).toBeLessThan(1000)
    expect(Date.now()).not.toBe(new Date('2026-06-13T10:36:00-04:00').getTime())
  })
})

describe('head and seo', () => {
  const meta = (over: Partial<CompiledPageMeta> = {}): CompiledPageMeta => ({
    slug: 'home',
    route: '/',
    name: 'Home',
    variant: 'prod',
    tplCount: 1,
    hydrated: false,
    hydratedBecause: [],
    helmetLinks: [{ tag: 'link', attrs: { rel: 'preconnect', href: 'https://x.test', crossorigin: '' } }],
    droppedHelmetLinks: [],
    helmetScripts: [],
    droppedHelmetScripts: [],
    fontSheets: [],
    propDefaults: null,
    title: null,
    source: 'bundle',
    bridge: null,
    headHtml:
      '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n',
    cssParts: [],
    pseudoRules: [],
    fontFiles: [],
    assetPaths: [],
    importModules: [],
    usesThemeStorage: false,
    preview: null,
    templateSha256: '',
    patchesSha256: '',
    dvIds: [],
    ...over,
  })

  it('builds the document in the contract order with no executable inline script', () => {
    const html = buildDocument({
      meta: meta(),
      lang: 'en',
      siteName: 'Oasis Auto Spa',
      seo: {
        title: 'T & "q"',
        description: 'D',
        canonical: 'https://s.test/',
        ogImage: null,
        noindex: false,
      },
      viewport: 'width=1480',
      cssHref: '/assets/home.abcdef12.css',
      bundleHref: null,
      themeHref: null,
      hoursHref: '/assets/hours.abcdef12.js',
      fontPreloads: ['/assets/f.abcdef12.woff2'],
      icons: [{ rel: 'icon', href: '/assets/i.abcdef12.png', type: 'image/png' }],
      jsonLd: { '@type': 'LocalBusiness', name: '</script><b>' },
      bodyHtml: '<div class="sc-host">x</div>',
      parityVals: { a: 1 },
      parityStatic: true,
    })
    const order = [
      '<meta charset',
      'name="viewport" content="width=1480"',
      '<title>T &amp; &quot;q&quot;</title>',
      'name="description"',
      'rel="canonical"',
      'og:title',
      'rel="icon"',
      'rel="preconnect" href="https://x.test" crossorigin>',
      'rel="preload"',
      'rel="stylesheet"',
      'application/ld+json',
      '<div id="dc-root" data-oasis-ready="1">',
      '__oasis-vals',
      'hours.abcdef12.js" defer',
    ]
    let last = -1
    for (const o of order) {
      const i = html.indexOf(o)
      expect(i, o).toBeGreaterThan(last)
      last = i
    }
    expect(html).toContain('"name":"<\\/script><b>"')
    expect(html).toMatch(/^<!DOCTYPE html>\n<html lang="en">/)
    expect(html).not.toMatch(/<script>(?!.*type=)/)
    expect(designViewport(meta())).toBe('width=device-width, initial-scale=1')
    expect(
      buildDocument({
        meta: meta(),
        lang: 'en',
        siteName: 's',
        seo: { title: 't', description: null, canonical: 'c', ogImage: null, noindex: true },
        viewport: null,
        cssHref: '/a.css',
        bundleHref: '/b.js',
        themeHref: '/t.js',
        hoursHref: null,
        fontPreloads: [],
        icons: [],
        jsonLd: null,
        bodyHtml: '',
        parityVals: undefined,
        parityStatic: false,
      }),
    ).toMatch(
      /content="width=device-width, initial-scale=1"[\s\S]*noindex[\s\S]*<script src="\/t.js"><\/script>\n<link rel="stylesheet" href="\/a.css">\n<\/head>\n<body>\n<div id="dc-root"><\/div>\n<script src="\/b.js" defer><\/script>/,
    )
  })

  it('check:dist accepts the theme script only as a blocking <head> script before the stylesheet (DV-THEME)', () => {
    const doc = (head: string, body: string) =>
      `<!DOCTYPE html>\n<html lang="en">\n<head>\n<title>t</title>\n${head}\n</head>\n<body>\n${body}\n</body>\n</html>\n`
    const t = '<script src="/assets/theme.abcdef12.js"></script>'
    const css = '<link rel="stylesheet" href="/assets/i.abcdef12.css">'
    const root = '<div id="dc-root"></div>'
    expect(themeScriptProblems('a.html', doc(`${t}\n${css}`, root), '/assets/theme.abcdef12.js')).toEqual([])
    // the pre-fix placement: right after #dc-root (the browser paints the dark markup while the script loads)
    expect(themeScriptProblems('a.html', doc(css, `${root}\n${t}`), '/assets/theme.abcdef12.js')).toEqual([
      'a.html: the theme script /assets/theme.abcdef12.js is in <body> (it must decide in <head>, before the first paint)',
      'a.html: expected the theme script /assets/theme.abcdef12.js once in <head>, found 0',
    ])
    expect(themeScriptProblems('a.html', doc(`${css}\n${t}`, root), '/assets/theme.abcdef12.js')).toEqual([
      'a.html: the theme script /assets/theme.abcdef12.js must come before the stylesheet',
    ])
    expect(
      themeScriptProblems('a.html', doc(`${t.replace('></script>', ' defer></script>')}\n${css}`, root), '/assets/theme.abcdef12.js'),
    ).toEqual(['a.html: the theme script /assets/theme.abcdef12.js must not be defer'])
  })

  it('seoFor merges default and page entries; JSON-LD has no Sunday when the shop is closed', () => {
    const seo = loadSeo(root)
    const s = seoFor(site, seo, 'settings', '/', 'https://oasisautospanj.com')
    expect(s.title).toContain('Oasis Auto Spa')
    expect(s.canonical).toBe('https://oasisautospanj.com/')
    expect(seoFor(site, seo, 'payments', '/payments', 'https://x.test/').canonical).toBe(
      'https://x.test/payments',
    )
    const ld = localBusinessJsonLd(site, 'https://oasisautospanj.com', validatePublicHours(fallback), null)
    expect(ld['@type']).toBe(site.business.type)
    expect(ld.name).toBe('Oasis Auto Spa')
    const spec = ld.openingHoursSpecification as { dayOfWeek: string; opens: string; closes: string }[]
    expect(spec.map((d) => d.dayOfWeek.split('/').pop())).toEqual([
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
    ])
    expect(spec[5]).toEqual({
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: 'https://schema.org/Saturday',
      opens: '08:00',
      closes: '17:00',
    })
    expect(ld.telephone).toBe(site.business.telephone)
    expect(notFoundDocument({ lang: 'en', siteName: 'S', cssHref: null, homeHref: '/' })).toContain(
      '<title>Page not found · S</title>',
    )
    expect(sitemapXml([{ loc: 'https://s/' }])).toContain('<loc>https://s/</loc>')
    expect(robotsTxt('https://s')).toContain('Sitemap: https://s/sitemap.xml')
  })
})

describe('asset store', () => {
  it('hashes by content, dedupes, rewrites logical references and reports unresolved ones', () => {
    const store = new AssetStore()
    const u1 = store.add('/fonts/a.woff2', Buffer.from('x'))
    expect(u1).toMatch(/^\/assets\/a\.[0-9a-f]{8}\.woff2$/)
    expect(store.add('/fonts/a.woff2', Buffer.from('x'))).toBe(u1)
    expect(() => store.add('/fonts/a.woff2', Buffer.from('y'))).toThrow(/different contents/)
    const u2 = store.add('/assets/a.png', Buffer.from('p'))
    const r = store.rewrite('url("/fonts/a.woff2") /assets/a.png /assets/a.png.bak', 't', true)
    expect(r.text).toBe(`url("${u1}") ${u2} /assets/a.png.bak`)
    expect(r.missing).toEqual(['/assets/a.png.bak'])
    expect(() => store.rewrite('/assets/nope.js', 't')).toThrow(
      /unresolved asset references: \/assets\/nope.js/,
    )
  })
})

describe('build on the configured page (design/pages.json: the raw Oasis Site v2 document)', { timeout: 300_000 }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-dist-'))
  const outParity = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-dist-parity-'))

  it('prerenders the home view, hydrates it, hashes every asset, self-hosts the fonts and passes check:dist', async () => {
    const r = await buildSite({
      root,
      variant: 'prod',
      outDir: out,
      hoursJson: null,
      availabilityJson: null,
      booking: 'sms',
      now: '2026-06-13T10:36:00-04:00',
      log: () => {},
    })
    expect(r.hoursSource).toBe('fallback')
    expect(r.availabilitySource).toBe('none')
    expect(r.booking).toBe('sms')
    expect(r.buildNow).toBe('2026-06-13T10:36:00-04:00')
    expect(r.placeholders).toEqual(['/assets/oasis-logo.png'])
    expect(r.pages.map((p) => p.file)).toEqual(['index.html'])
    expect(r.pages[0]!.hydrated).toBe(true)
    const check = checkDist(out, site.marker)
    expect(check.problems).toEqual([])
    const files = fs.readdirSync(path.join(out, 'assets'))
    expect(files.every((f) => /\.[0-9a-f]{8}\.[a-z0-9]+$/.test(f))).toBe(true)
    // the hydration bundle and the pre-hydration theme script (DV-THEME: the device or the stored choice decides)
    expect(files.filter((f) => f.endsWith('.js')).sort()).toEqual([
      expect.stringMatching(/^page-index\./),
      expect.stringMatching(/^theme\./),
    ])
    expect(files.filter((f) => f.endsWith('.woff2'))).toHaveLength(13)
    expect(files.some((f) => f.startsWith('image-slot'))).toBe(false)
    const index = fs.readFileSync(path.join(out, 'index.html'), 'utf8')
    expect(index).toContain(site.marker)
    expect(index).toContain('<title>Oasis Auto Spa · Concierge Hand Wash · Garfield, NJ</title>')
    expect(index).toContain('data-theme="dark"')
    expect(index).not.toContain('data-dc-tpl')
    expect(index).not.toContain('fonts.googleapis.com')
    expect(index).not.toContain('fonts.gstatic.com')
    expect(index).not.toContain('(201) 555-0123')
    expect(index).toContain('<template shadowrootmode="open">')
    expect(index).toMatch(/<img src="\/assets\/oasis-logo\.[0-9a-f]{8}\.png" alt="Oasis Auto Spa"/)
    expect(index).toMatch(/<script src="\/assets\/page-index\.[0-9a-f]{8}\.js" defer><\/script>/)
    expect((index.match(/<script/g) ?? []).length).toBe(3) // the JSON-LD data block, the theme script and the bundle
    // the theme script decides in <head>, parser-blocking, before the stylesheet (DV-THEME: nothing of the body can be
    // painted before it ran); the body ends with the markup and the deferred bundle
    expect(index).toMatch(/<script src="\/assets\/theme\.[0-9a-f]{8}\.js"><\/script>\n<link rel="stylesheet" href="\/assets\/index\.[0-9a-f]{8}\.css">[\s\S]*<\/head>/)
    expect(index.indexOf('/assets/theme.')).toBeLessThan(index.indexOf('<body>'))
    expect(index).toMatch(/<\/div>\n<script src="\/assets\/page-index\.[0-9a-f]{8}\.js" defer><\/script>\n<\/body>/)
    expect(index).toContain('"dayOfWeek":"https://schema.org/Monday","opens":"08:00","closes":"18:00"')
    expect(index).not.toContain('schema.org/Sunday')
    expect(index).toMatch(/Sunday<\/span><\/span><span style="color:var\(--ink\);font-weight:600"><span class="sc-interp">Closed<\/span>/)
    expect(index).toContain('SAT JUN 13 · 10:36 AM')
    const css = fs.readFileSync(path.join(out, 'assets', files.find((f) => f.startsWith('index.'))!), 'utf8')
    expect(css.startsWith('html,body{height:100%;margin:0}')).toBe(true)
    expect(css).toMatch(/url\(\/assets\/archivo-latin\.[0-9a-f]{8}\.woff2\)/)
    expect(css).not.toContain('/fonts/')
    expect(css).not.toContain('gstatic')
    const js = fs.readFileSync(path.join(out, 'assets', files.find((f) => f.startsWith('page-index.'))!), 'utf8')
    expect(js).toContain('"18.3.1"')
    expect(js).not.toContain('new Function(')
    expect(js).toContain('2026-06-13T10:36:00-04:00')
    expect(js).toContain('/api/v1/public/availability')
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'))
    expect(manifest.themeScript.file).toMatch(/^assets\/theme\.[0-9a-f]{8}\.js$/)
    const themeJs = fs.readFileSync(path.join(out, manifest.themeScript.file), 'utf8')
    expect(themeJs).toContain('(prefers-color-scheme: light)')
    expect(themeJs).toContain('oasis-theme')
    expect(themeJs).toContain('#F2F3F1')
    expect(js).toContain('prop:"theme"')
    expect(manifest.booking).toBe('sms')
    expect(Object.keys(manifest.files)).toContain('404.html')
    const notFound = fs.readFileSync(path.join(out, '404.html'), 'utf8')
    expect(notFound).toContain('Wrong<br>turn.')
    // the 404 follows the device and the stored choice too (DV-THEME): the same theme script in its <head>, no hard-coded
    // dark page background (the baked data-theme is the design's default, patched by the script)
    expect(notFound).toContain(`<script src="/${manifest.themeScript.file}"></script>`)
    expect(notFound.indexOf('/assets/theme.')).toBeLessThan(notFound.indexOf('</head>'))
    expect(notFound).not.toMatch(/<body[^>]*#06080A/)
    expect((notFound.match(/<script/g) ?? []).length).toBe(1)
    expect(fs.readFileSync(path.join(out, 'robots.txt'), 'utf8')).toContain(
      'Sitemap: https://oasisautospanj.com/sitemap.xml',
    )
    const sitemap = fs.readFileSync(path.join(out, 'sitemap.xml'), 'utf8')
    expect(sitemap).toContain('<loc>https://oasisautospanj.com/</loc>')
    expect(sitemap.match(/<loc>/g)).toHaveLength(1)
    // the parity variant: tpl ids in the markup, parity hook in the bundle, no baked ready flag on hydrated pages
    const p = await buildSite({
      root,
      variant: 'parity',
      outDir: outParity,
      hoursJson: null,
      availabilityJson: null,
      booking: 'sms',
      now: '2026-06-13T10:36:00-04:00',
      log: () => {},
    })
    const pindex = fs.readFileSync(path.join(outParity, 'index.html'), 'utf8')
    expect(pindex).toContain('data-dc-tpl="8"')
    expect(pindex).toContain('<div id="dc-root"><div class="sc-host"')
    expect(pindex).not.toContain('__oasis-vals')
    const pjs = fs.readFileSync(
      path.join(outParity, 'assets', fs.readdirSync(path.join(outParity, 'assets')).find((f) => f.startsWith('page-index.'))!),
      'utf8',
    )
    expect(pjs).toContain('__oasisParity')
    expect(js).not.toContain('__oasisParity')
    expect(checkDist(outParity, site.marker).problems).toEqual([])
    expect(p.pages[0]!.textBoundaries).toBe(r.pages[0]!.textBoundaries)
    fs.rmSync(out, { recursive: true, force: true })
    fs.rmSync(outParity, { recursive: true, force: true })
  })

  it('bakes SITE_AVAILABILITY_JSON (the board shows slots) and refuses an unknown SITE_BOOKING', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-dist-a-'))
    const { designAvailability } = await import('../../src/site/availability')
    const { hoursTable } = await import('../../src/site/hours')
    // the pattern is seeded by the local date and filtered by the local time of day: generate it in the shop's zone,
    // like build:parity and serve-dist do (an earlier test may have pinned the worker's TZ elsewhere)
    const tz = process.env.TZ
    process.env.TZ = 'America/New_York'
    const avail = designAvailability(new Date('2026-06-13T10:36:00-04:00'), hoursTable(fallback))
    if (tz === undefined) delete process.env.TZ
    else process.env.TZ = tz
    const r = await buildSite({
      root,
      variant: 'prod',
      outDir: dir,
      htmlOnly: true,
      hoursJson: null,
      availabilityJson: JSON.stringify(avail),
      booking: 'live',
      apiOrigin: 'https://api.example.test/',
      now: '2026-06-13T10:36:00-04:00',
      log: () => {},
    })
    expect(r.availabilitySource).toBe('SITE_AVAILABILITY_JSON')
    expect(r.booking).toBe('live')
    const index = fs.readFileSync(path.join(dir, 'index.html'), 'utf8')
    expect(index).toContain('NEXT OPEN')
    expect(index).not.toContain('TO CHECK TIMES')
    expect(index).toContain(' open</span>')
    await expect(
      buildSite({ root, variant: 'prod', outDir: dir, htmlOnly: true, hoursJson: null, booking: 'nope', log: () => {} }),
    ).rejects.toThrow(/SITE_BOOKING/)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('bakes SITE_HOURS_JSON when valid and falls back with a warning otherwise', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-dist-h-'))
    const bad = await buildSite({
      root,
      variant: 'prod',
      outDir: dir,
      htmlOnly: true,
      hoursJson: '{"week":[]}',
      log: () => {},
    })
    expect(bad.hoursSource).toBe('fallback')
    expect(bad.warnings.some((w) => w.includes('SITE_HOURS_JSON is not a valid'))).toBe(true)
    const alt = fs.readFileSync(path.join(root, 'tools/parity/fixtures/hours.alt.json'), 'utf8')
    const good = await buildSite({
      root,
      variant: 'prod',
      outDir: dir,
      htmlOnly: true,
      hoursJson: alt,
      log: () => {},
    })
    expect(good.hoursSource).toBe('SITE_HOURS_JSON')
    const index = fs.readFileSync(path.join(dir, 'index.html'), 'utf8')
    expect(index).toContain('"dayOfWeek":"https://schema.org/Monday","opens":"07:30","closes":"19:00"')
    expect(index).not.toContain('schema.org/Sunday')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('DV-PRICE-INTERIM: the prerendered page shows only the starting prices and the fee (the default)', { timeout: 300_000 }, () => {
  it('no "$" figure but $40, $129 and the fee; a ready catalog snapshot changes only the fee', async () => {
    const { designCatalog, withMemberPrice } = await import('../site/catalog-fixture')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-dist-i-'))
    const build = async (catalogJson: string | null) => {
      const r = await buildSite({ root, variant: 'prod', outDir: dir, htmlOnly: true, hoursJson: null, availabilityJson: null, catalogJson, booking: 'sms', now: '2026-06-13T10:36:00-04:00', log: () => {} })
      return { r, index: fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), manifest: JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) }
    }
    const plain = await build(null)
    expect(plain.r.pricing).toBe('interim')
    expect(plain.manifest.pricing).toBe('interim')
    const figures = new Set(plain.index.match(/\$\s?\d[\d,]*(?:\.\d+)?/g) ?? [])
    expect([...figures].sort()).toEqual(['$129', '$25', '$40'])
    expect(plain.index).toContain('from $129')
    expect(plain.index).toContain('Priced by vehicle size — ask us')
    for (const gone of ['20% higher', 'SAVE $', 'VIP $169', '$99', 'Save $', 'PRICED AS A GUEST'])
      expect(plain.index, gone).not.toContain(gone)
    const cat = withMemberPrice(designCatalog(), 'signature-hand-wash', 50)
    cat.plans[0]!.priceCents = 10900
    const snap = await build(JSON.stringify(cat))
    // only its booking fee is baked (the design's $25 here): the page is the same
    expect(snap.r.catalogSource).toBe('SITE_CATALOG_JSON')
    expect(snap.r.warnings.some((w) => w.includes('pricing is interim'))).toBe(true)
    expect(snap.index).toBe(plain.index)
    // a changed fee (Settings) is what the prerendered page says, wherever it said $25
    cat.guestBookingFeeCents = 3000
    const fee = await build(JSON.stringify(cat))
    expect(fee.index).toBe(plain.index.replace(/\$25(?![0-9])/g, '$$30'))
    expect(fee.index).toContain('$30 non-refundable booking fee')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('DV-CATALOG: the catalog snapshot (SITE_CATALOG_JSON, pricing "catalog")', { timeout: 300_000 }, () => {
  it('the design catalog prerenders the design byte for byte; a changed price is baked in; an unseeded one is not used', async () => {
    const { designCatalog, unseededCatalog, withMemberPrice } = await import('../site/catalog-fixture')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-dist-c-'))
    const build = async (catalogJson: string | null) => {
      const r = await buildSite({ root, variant: 'prod', outDir: dir, htmlOnly: true, hoursJson: null, availabilityJson: null, catalogJson, booking: 'sms', pricing: 'catalog', now: '2026-06-13T10:36:00-04:00', log: () => {} })
      return { r, index: fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), manifest: JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) }
    }
    const none = await build(null)
    expect(none.r.catalogSource).toBe('none')
    expect(none.r.warnings.some((w) => w.includes('SITE_CATALOG_JSON is not set'))).toBe(true)
    expect(none.index).toContain('from $99')
    expect(none.index).toContain('Guests can book with prices 20% higher and a ')
    const same = await build(JSON.stringify(designCatalog()))
    expect(same.r.catalogSource).toBe('SITE_CATALOG_JSON')
    expect(same.manifest.catalogSource).toBe('SITE_CATALOG_JSON')
    expect(same.index).toBe(none.index)
    const cat = withMemberPrice(designCatalog(), 'signature-hand-wash', 50)
    cat.plans[0]!.priceCents = 10900
    const changed = await build(JSON.stringify(cat))
    expect(changed.index).not.toBe(none.index)
    expect(changed.index).toContain('from $109')
    expect(changed.index).not.toContain('from $99')
    expect(none.index).not.toContain('SAVE $60')
    expect(changed.index).toContain('SAVE $60') // the Signature row: guest $60, included for members
    const unseeded = await build(JSON.stringify(unseededCatalog()))
    expect(unseeded.r.catalogSource).toBe('none')
    expect(unseeded.r.warnings.some((w) => /SITE_CATALOG_JSON is not website-ready \(the catalog has no signature-hand-wash\)/.test(w))).toBe(true)
    expect(unseeded.index).toBe(none.index)
    const broken = await build('{"services":')
    expect(broken.r.catalogSource).toBe('none')
    expect(broken.index).toBe(none.index)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('renderPage', () => {
  it('fails loudly on a logic class that throws, instead of shipping the error card', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-gen-'))
    fs.writeFileSync(
      path.join(dir, 'boom.tsx'),
      'export const meta = {}\nexport default function render() { return null as any }\n',
    )
    fs.writeFileSync(
      path.join(dir, 'boom.logic.js'),
      `import { DCLogic } from ${JSON.stringify(path.join(root, 'src/dc/DCLogic.ts'))}\nclass Component extends DCLogic { constructor(p) { super(p); throw new Error('ctor boom') } }\nexport default Component\n`,
    )
    const meta: CompiledPageMeta = {
      slug: 'boom',
      route: '/boom',
      name: 'Boom',
      variant: 'prod',
      tplCount: 0,
      hydrated: false,
      hydratedBecause: [],
      helmetLinks: [],
      droppedHelmetLinks: [],
      helmetScripts: [],
      droppedHelmetScripts: [],
      fontSheets: [],
      propDefaults: null,
      title: null,
      source: 'bundle',
      bridge: null,
      headHtml: '',
      cssParts: [],
      pseudoRules: [],
      fontFiles: [],
      assetPaths: [],
      importModules: [],
      usesThemeStorage: false,
      preview: null,
      templateSha256: '',
      patchesSha256: '',
      dvIds: [],
    }
    const r = await renderPage({
      meta,
      generatedDir: dir,
      userProps: {},
      shims: { siteUrl: 'https://x.test' },
    })
    expect(r.errors.join('\n')).toMatch(/ctor boom/)
    expect(r.errors.join('\n')).toMatch(/error card/)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('the fallback hours read Closed on Sunday and parse5 is available to the checks', () => {
    const f = formatHours(validatePublicHours(fallback))
    expect(f.week[0]!.range).toBe('Closed')
    const doc = parse('<!DOCTYPE html><html><body></body></html>')
    expect(doc.nodeName).toBe('#document')
  })
})
