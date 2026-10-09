import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeTemplate, extractTemplate } from './bundle'
import { buildBundle, startOriginalServer, type OriginalServer } from './serve-original'
const SCREENS = ['operations', 'payments', 'settings'] as const
const toyPages = SCREENS.map((s) => ({ slug: s, route: `/${s}`, file: `${s}.bundle.html`, name: s }))

const TEMPLATE =
  '<x-dc><button title="Open WhatsApp">Send WhatsApp receipt</button></x-dc><script type="text/x-dc">class C {}</scr' +
  'ipt>'
const toyDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-toy-'))
  for (const s of SCREENS) {
    fs.writeFileSync(
      path.join(dir, `${s}.bundle.html`),
      `<html><body>${s}<script type="__bundler/template">\n${encodeTemplate(TEMPLATE)}\n</script></body></html>`,
    )
  }
  return dir
}

let server: OriginalServer | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

describe('buildBundle', () => {
  it('serves the file untouched when nothing applies', () => {
    const dir = toyDir()
    expect(buildBundle('payments', path.join(dir, 'payments.bundle.html')).html).toBe(
      fs.readFileSync(path.join(dir, 'payments.bundle.html'), 'utf8'),
    )
  })

  it('applies text and attr swaps from a toy map and the transform hook', () => {
    const dir = toyDir()
    const { html, results } = buildBundle(
      'payments',
      path.join(dir, 'payments.bundle.html'),
      [
        { id: 'sms-text', kind: 'text', find: 'WhatsApp', replace: 'SMS', count: 2 },
        { id: 'sms-attr', kind: 'attr', attr: 'title', find: 'Open ', replace: 'Text ', count: 1 },
      ],
      (_screen, t) => t.replace('receipt', 'receipt!'),
    )
    const t = extractTemplate(html).template
    expect(t).toContain('title="Text SMS"')
    expect(t).toContain('Send SMS receipt!')
    expect(results.map((r) => r.found)).toEqual([2, 1])
  })

  it('throws on stale and over-broad swaps instead of serving a bundle that silently differs', () => {
    const dir = toyDir()
    expect(() =>
      buildBundle('payments', path.join(dir, 'payments.bundle.html'), [
        { id: 'stale', kind: 'text', find: 'Nope', replace: 'x', count: 1 },
      ]),
    ).toThrow(/stale entry/)
    expect(() =>
      buildBundle('payments', path.join(dir, 'payments.bundle.html'), [
        { id: 'wide', kind: 'text', find: 'WhatsApp', replace: 'x', count: 1 },
      ]),
    ).toThrow(/over-broad entry/)
  })
})

describe('startOriginalServer', () => {
  it('serves each screen at /orig/<screen>.html and 404s elsewhere', async () => {
    server = await startOriginalServer({ dir: toyDir(), pages: toyPages, port: 0 })
    for (const s of SCREENS) {
      const res = await fetch(server.url(s))
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      expect(await res.text()).toContain(s)
    }
    expect((await fetch(`${server.origin}/orig/unknown.html`)).status).toBe(404)
    expect((await fetch(`${server.origin}/`)).status).toBe(404)
  })

  it('serves swapped bundles per screen and keeps the hash in the page url', async () => {
    server = await startOriginalServer({
      dir: toyDir(),
      pages: toyPages,
      port: 0,
      swapsBySlug: { settings: [{ id: 'x', kind: 'text', find: 'WhatsApp', replace: 'SMS', count: 2 }] },
    })
    const settings = await (await fetch(server.url('settings'))).text()
    const payments = await (await fetch(server.url('payments'))).text()
    expect(extractTemplate(settings).template).toContain('Send SMS receipt')
    expect(extractTemplate(payments).template).toContain('Send WhatsApp receipt')
    expect(server.url('settings', 'emergency')).toMatch(/settings\.html#emergency$/)
  })

  it('refuses to start when a swap does not match', async () => {
    await expect(
      startOriginalServer({
        dir: toyDir(),
        pages: toyPages,
        port: 0,
        swapsBySlug: { settings: [{ id: 'bad', kind: 'text', find: 'Nope', replace: 'x', count: 1 }] },
      }),
    ).rejects.toThrow(/stale entry/)
  })

  it('falls back to an ephemeral port when the preferred one is taken', async () => {
    const first = await startOriginalServer({ dir: toyDir(), pages: toyPages, port: 0 })
    try {
      const second = await startOriginalServer({ dir: toyDir(), pages: toyPages, port: first.port })
      expect(second.port).not.toBe(first.port)
      await second.close()
      await expect(
        startOriginalServer({ dir: toyDir(), pages: toyPages, port: first.port, strictPort: true }),
      ).rejects.toThrow(/EADDRINUSE/)
    } finally {
      await first.close()
    }
  })
})
