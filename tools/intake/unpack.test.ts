import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { IntakeError, newRegistry, readLooseFiles, runIntake, sha256, unpackBundle } from './unpack'
import { inventoryOf, renderReport } from './inventory'
import { fixtureExtracted, root } from './fixtures'
import { encodeTemplate } from '../parity/bundle'

const SLUGS = ['operations', 'payments', 'settings'] as const
const fixtures = path.join(root, 'design/fixtures')
const grab = (raw: string, t: string) =>
  raw.match(new RegExp(`<script type="__bundler/${t}">([\\s\\S]*?)</script>`))![1]!

describe('intake on the three dashboard fixtures', () => {
  const { extractedDir } = fixtureExtracted()
  const read = (...p: string[]) => fs.readFileSync(path.join(extractedDir, ...p), 'utf8')

  it('classifies every manifest entry: 1 runtime, 2 React builds, 9 fonts per page, nothing else', () => {
    const pages = SLUGS.map((s) => ({ slug: s, route: `/${s}`, file: `fixtures/${s}.bundle.html`, name: s }))
    const reg = newRegistry()
    for (const p of pages) {
      const r = unpackBundle(fs.readFileSync(path.join(fixtures, `${p.slug}.bundle.html`), 'utf8'), p, reg)
      expect(r.resources).toHaveLength(12)
      const kinds = r.resources.reduce<Record<string, number>>(
        (a, x) => ((a[x.kind] = (a[x.kind] ?? 0) + 1), a),
        {},
      )
      expect(kinds).toEqual({ runtime: 1, react: 2, font: 9 })
      expect(r.helmets.map((h) => h.fontFace)).toEqual([true, false])
      expect(r.xImports).toEqual([])
      expect(r.unreferenced).toEqual([])
      expect(r.meta.helmetLinks.map((l) => l.attrs.rel)).toEqual(['preconnect', 'preconnect'])
      expect(r.refs.filter((x) => x.where === 'css')).toHaveLength(9)
      expect(r.refs.filter((x) => x.where === 'head')).toHaveLength(1)
      expect(r.meta.runtimeSha256).toMatch(/^[0-9a-f]{64}$/)
    }
    // fonts are deduped across the three bundles by sha256: 9 distinct files, 27 uuids
    expect([...reg.bySha.values()].filter((x) => x.kind === 'font')).toHaveLength(9)
  })

  it('writes the logic byte for byte and the template with every uuid rewritten once', () => {
    for (const s of SLUGS) {
      const raw = fs.readFileSync(path.join(fixtures, `${s}.bundle.html`), 'utf8')
      const template = JSON.parse(grab(raw, 'template')) as string
      const open = /<script type="text\/x-dc"[^>]*>/.exec(template)!
      const logic = template.slice(open.index + open[0].length, template.lastIndexOf('</script>'))
      expect(read(s, 'logic.original.js')).toBe(logic)
      const tpl = read(s, 'template.html')
      expect(tpl).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
      expect(tpl.match(/url\("\/fonts\/[a-z-]+\.woff2"\)/g)).toHaveLength(42)
      expect(read(s, 'head.html')).toContain('<script src="/runtime/dc-runtime.js"></script>')
      const meta = JSON.parse(read(s, 'meta.json'))
      expect(meta.templateChars).toBe(tpl.length)
      expect(meta.preview).toEqual(s === 'operations' ? { width: 1480, height: 1000 } : null)
      expect(read(s, 'helmet.0.css')).toContain('@font-face')
      expect(read(s, 'helmet.1.css')).not.toContain('@font-face')
    }
    const manifest = JSON.parse(read('fonts/manifest.json'))
    expect(Object.keys(manifest.files)).toHaveLength(9)
    for (const [name, meta] of Object.entries<{ sha256: string }>(manifest.files)) {
      expect(sha256(fs.readFileSync(path.join(extractedDir, 'fonts', name)))).toBe(meta.sha256)
    }
    expect(read('runtime/dc-runtime.js')).toContain('// src/boot.ts')
    expect(JSON.parse(read('runtime/manifest.json')).pages).toEqual(['operations', 'payments', 'settings'])
  })

  it('the inventory sees the constructs, the theme and the hrefs', () => {
    const inv = inventoryOf(extractedDir, 'settings')
    expect(inv.elements).toBeGreaterThan(500)
    expect(inv.constructs.scIf).toBeGreaterThan(20)
    expect(inv.constructs.scFor).toBeGreaterThan(5)
    expect(inv.constructs.eventHandlers).toBeGreaterThan(50)
    expect(inv.constructs.complexExpressions).toEqual([])
    expect(inv.pseudo).toEqual({})
    expect(inv.classAttrs).toEqual({ static: 0, bound: 0 })
    expect(inv.theme).toEqual({
      attributeBinding: 'theme',
      storageKey: 'oasis-theme',
      values: ['dark', 'light'],
    })
    expect(inv.root?.height).toBe('100vh')
    expect(inv.mediaQueries).toEqual([])
    expect(Object.keys(inv.hrefs).sort()).toEqual(['.dc.html'])
    expect(inv.logic.localStorage).toBe(4)
    expect(inv.ctas.length).toBeGreaterThan(10)
    const report = renderReport([inv], 'x')
    expect(report).toContain('| settings | /settings |')
    expect(report).toContain('localStorage key `oasis-theme`')
  })
})

/** A synthetic bundle with an image, an import script, a nested page and an x-import, gzip-compressed entries. */
function syntheticBundle(opts: { compressed: boolean }) {
  const u = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`
  const RUNTIME = u(1)
  const REACT = u(2)
  const FONT = u(3)
  const IMG = u(4)
  const SCRIPT = u(5)
  const PAGE = u(6)
  const entry = (mime: string, text: string | Buffer) => {
    const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text)
    return opts.compressed
      ? { mime, compressed: true, data: zlib.gzipSync(bytes).toString('base64') }
      : { mime, data: bytes.toString('base64') }
  }
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const script = 'module.exports = { Logo: () => null };\n'
  const manifest = {
    [RUNTIME]: entry('text/javascript', '// src/boot.ts\nconsole.log(1)'),
    [REACT]: entry('text/javascript', 'window.React={}'),
    [FONT]: entry('font/woff2', Buffer.from('wOF2')),
    [IMG]: entry('image/png', png),
    [SCRIPT]: entry('text/javascript', script),
    [PAGE]: entry('text/html', '<html><body>nested</body></html>'),
  }
  const template = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<script src="${RUNTIME}"></script>
</head>
<body>
<x-dc>
<helmet data-dc-atomics>
<link rel="icon" href="${IMG}">
<style>/* latin */
@font-face { font-family: 'Fam'; src: url("${FONT}") format('woff2'); }</style>
<style>.a{background:url(${IMG})}</style>
<script>console.log('helmet')</script>
</helmet>
<div class="hero" style-hover="color:red"><img src="${IMG}" alt="">
<x-import from="${SCRIPT}" component="Logo" hint-size="1,2"/>
<iframe src="about:blank#${PAGE}#x"></iframe>
<x-import from="https://cdn.example/x.js" component="Ext"></x-import>
</div>
</x-dc>
<script type="text/x-dc" data-dc-script="" data-props='{"$preview":{"width":100},"title":"t"}'>
class Component extends DCLogic { renderVals(){ return { u: "${IMG}" } } }
</script>
</body></html>`
  const html = `<html><body><script type="__bundler/manifest">${JSON.stringify(manifest)}</script>
<script type="__bundler/ext_resources">${JSON.stringify([{ id: 'https://unpkg.com/react@18.3.1/umd/react.production.min.js', uuid: REACT }])}</script>
<script type="__bundler/page_order">${JSON.stringify([PAGE])}</script>
<script type="__bundler/template">${encodeTemplate(template)}</script></body></html>`
  return { html, ids: { RUNTIME, REACT, FONT, IMG, SCRIPT, PAGE }, png, script }
}

describe('intake on a synthetic bundle', () => {
  const page = { slug: 'home', route: '/', file: 'original/home.dc.html', name: 'Home' }

  it('names resources by MIME and loose-file match, rewrites every reference and records where it was', () => {
    const { html, ids, png } = syntheticBundle({ compressed: true })
    const loose = [{ name: 'oasis-logo.png', sha256: sha256(png) }]
    const r = unpackBundle(html, page, newRegistry(), loose)
    const byUuid = Object.fromEntries(r.resources.map((x) => [x.uuid, x]))
    expect(byUuid[ids.RUNTIME]).toMatchObject({
      kind: 'runtime',
      file: 'dc-runtime.js',
      path: '/runtime/dc-runtime.js',
    })
    expect(byUuid[ids.REACT]).toMatchObject({ kind: 'react', file: 'react.production.min.js' })
    expect(byUuid[ids.FONT]).toMatchObject({
      kind: 'font',
      file: 'fam-latin.woff2',
      path: '/fonts/fam-latin.woff2',
      family: 'Fam',
      subset: 'latin',
    })
    expect(byUuid[ids.IMG]).toMatchObject({
      kind: 'asset',
      file: 'oasis-logo.png',
      path: '/assets/oasis-logo.png',
      looseName: 'oasis-logo.png',
    })
    expect(byUuid[ids.SCRIPT]).toMatchObject({
      kind: 'import',
      path: '/assets/script-' + sha256(syntheticBundle({ compressed: false }).script).slice(0, 8) + '.js',
    })
    expect(byUuid[ids.PAGE]).toMatchObject({
      kind: 'frame',
      path: `/frames/page-${sha256('<html><body>nested</body></html>').slice(0, 8)}.html`,
    })
    expect(r.template).toContain('<img src="/assets/oasis-logo.png" alt="">')
    expect(r.template).toContain('url(/assets/oasis-logo.png)')
    expect(r.template).toContain('<iframe src="/frames/page-')
    expect(r.template).toContain('<link rel="icon" href="/assets/oasis-logo.png">')
    expect(r.logic).toContain('u: "/assets/oasis-logo.png"')
    expect(r.head).toContain('<script src="/runtime/dc-runtime.js"></script>')
    expect(r.template).not.toMatch(/0000-4000-8000/)
    const where = (uuid: string) =>
      r.refs
        .filter((x) => x.uuid === uuid)
        .map(
          (x) =>
            `${x.where}${x.attr ? `:${x.tag}.${x.attr}@${x.tpl}` : x.tpl !== undefined ? `@${x.tpl}` : ''}`,
        )
    expect(where(ids.IMG)).toEqual(['attribute:link.href@1', 'css@3', 'attribute:img.src@6', 'logic'])
    expect(where(ids.PAGE)).toEqual(['frame-marker:iframe.src@8'])
    expect(where(ids.SCRIPT)).toEqual(['attribute:x-import.from@7'])
    expect(r.unreferenced).toEqual([])
    expect(r.meta).toMatchObject({
      helmetAtomics: true,
      helmetScripts: 1,
      xImports: 2,
      preview: { width: 100 },
      dataProps: { title: 't' },
      frames: [expect.stringMatching(/^page-/)],
    })
    expect(r.meta.helmetLinks).toEqual([
      { tag: 'link', attrs: { rel: 'icon', href: '/assets/oasis-logo.png' } },
    ])
    expect(r.helmets.map((h) => [h.file, h.fontFace])).toEqual([
      ['helmet.0.css', true],
      ['helmet.1.css', false],
    ])
    expect(r.xImports).toEqual([
      {
        tpl: 7,
        from: [byUuid[ids.SCRIPT]!.path],
        url: byUuid[ids.SCRIPT]!.path,
        component: 'Logo',
        globalName: '',
        hintSize: '1,2',
        children: 2,
        unresolved: [],
      },
      {
        tpl: 9,
        from: ['https://cdn.example/x.js'],
        url: 'https://cdn.example/x.js',
        component: 'Ext',
        globalName: '',
        hintSize: null,
        children: 0,
        unresolved: ['https://cdn.example/x.js'],
      },
    ])
  })

  it('handles uncompressed entries, shares names across pages and rejects malformed bundles', () => {
    const { html, png } = syntheticBundle({ compressed: false })
    const reg = newRegistry()
    const a = unpackBundle(html, page, reg)
    const b = unpackBundle(html, { ...page, slug: 'two', route: '/two' }, reg)
    expect(a.resources.find((x) => x.kind === 'asset')!.file).toBe(`png-${sha256(png).slice(0, 8)}.png`)
    expect(b.resources.find((x) => x.kind === 'asset')!.file).toBe(
      a.resources.find((x) => x.kind === 'asset')!.file,
    )
    expect(() => unpackBundle('<html></html>', page)).toThrow(IntakeError)
    expect(() => unpackBundle(html.replace('<x-dc>', '<x-dd>').replace('</x-dc>', '</x-dd>'), page)).toThrow(
      /x-dc/,
    )
  })

  it('runIntake writes the tree, assets.json and the manifests; readLooseFiles lists the loose directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-'))
    const { html, png } = syntheticBundle({ compressed: true })
    fs.mkdirSync(path.join(dir, 'design/original/loose'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'design/original/home.dc.html'), html)
    fs.writeFileSync(path.join(dir, 'design/original/loose/oasis-logo.png'), png)
    fs.writeFileSync(path.join(dir, 'design/pages.json'), JSON.stringify([page]))
    expect(readLooseFiles(path.join(dir, 'design/original/loose'))).toEqual([
      { name: 'oasis-logo.png', sha256: sha256(png) },
    ])
    const r = runIntake({ root: dir, log: () => {} })
    expect(r.files).toContain('assets/oasis-logo.png')
    expect(r.files).toContain('home/template.html')
    expect(r.files.filter((f) => f.startsWith('imports/'))).toHaveLength(1)
    expect(r.files.filter((f) => f.startsWith('frames/'))).toHaveLength(1)
    const assets = JSON.parse(fs.readFileSync(path.join(dir, 'design/extracted/assets.json'), 'utf8'))
    expect(assets.files['assets/oasis-logo.png']).toMatchObject({
      kind: 'asset',
      mime: 'image/png',
      loose: 'oasis-logo.png',
    })
    expect(Object.values(assets.uuidToPathPerPage.home)).toContain('/assets/oasis-logo.png')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
