import { describe, expect, it } from 'vitest'
import {
  applySwaps,
  checkSwapResults,
  encodeTemplate,
  extractTemplate,
  replaceTemplate,
  SwapError,
  type SwapSpec,
} from './bundle'

const TEMPLATE = [
  '<!DOCTYPE html><html><head></head><body><x-dc>',
  '<a href="Oasis%20Payments.dc.html" title="Open Payments">Payments</a>',
  '<a href="Oasis%20Settings.dc.html">Settings &amp; more</a>',
  '<p>Receipt goes out by WhatsApp and email.</p>',
  '</x-dc>',
  '<script type="text/x-dc" data-dc-script>class Component { r() { return "Sent via WhatsApp"; } }</scr' +
    'ipt></body></html>',
].join('\n')

const bundle = (t: string) =>
  `<!DOCTYPE html><html><body><script type="__bundler/manifest">{}</script>\n<script type="__bundler/template">\n${encodeTemplate(t)}\n</script></body></html>`

describe('bundle template round trip', () => {
  it('extracts the decoded template and re-encodes it so it cannot close the script element', () => {
    const html = bundle(TEMPLATE)
    expect(html.match(/<\/script>/g)).toHaveLength(2)
    expect(extractTemplate(html).template).toBe(TEMPLATE)
    const next = replaceTemplate(html, TEMPLATE.replace('Payments</a>', 'Pay</a>'))
    expect(extractTemplate(next).template).toContain('Pay</a>')
    expect(next.match(/<\/script>/g)).toHaveLength(2)
  })

  it('fails loudly when the bundle has no template', () => {
    expect(() => extractTemplate('<html></html>')).toThrow(/no __bundler\/template/)
  })
})

describe('applySwaps', () => {
  const text = (over: Partial<SwapSpec>): SwapSpec => ({
    id: 't',
    kind: 'text',
    find: 'WhatsApp',
    replace: 'SMS',
    count: 2,
    ...over,
  })

  it('replaces text in the markup and the logic and reports counts', () => {
    const r = applySwaps(TEMPLATE, [text({})])
    expect(r.results).toEqual([{ id: 't', expected: 2, found: 2 }])
    expect(r.template).toContain('goes out by SMS and email')
    expect(r.template).toContain('Sent via SMS')
    expect(r.template).not.toContain('WhatsApp')
  })

  it('can be restricted to the template or the logic region', () => {
    expect(applySwaps(TEMPLATE, [text({ target: 'template', count: 1 })]).template).toContain(
      'Sent via WhatsApp',
    )
    expect(applySwaps(TEMPLATE, [text({ target: 'logic', count: 1 })]).template).toContain(
      'by WhatsApp and email',
    )
  })

  it('attr swaps only touch the quoted value of the named attribute', () => {
    const r = applySwaps(TEMPLATE, [
      {
        id: 'h',
        kind: 'attr',
        attr: 'href',
        find: 'Oasis%20Payments.dc.html',
        replace: '/payments',
        count: 1,
      },
      { id: 'x', kind: 'attr', attr: 'title', find: 'Payments', replace: 'Billing', count: 1 },
    ])
    expect(r.results.map((x) => x.found)).toEqual([1, 1])
    expect(r.template).toContain('href="/payments"')
    expect(r.template).toContain('title="Open Billing"')
    expect(r.template).toContain('>Payments</a>')
  })

  it('applies swaps in order, so a later swap sees earlier output', () => {
    const r = applySwaps('<x-dc>aXb</x-dc>', [
      text({ find: 'X', replace: 'Y', count: 1 }),
      text({ id: 'u', find: 'aYb', replace: 'done', count: 1 }),
    ])
    expect(r.template).toBe('<x-dc>done</x-dc>')
  })

  it('refuses kinds that cannot be applied before render', () => {
    expect(() =>
      applySwaps(TEMPLATE, [{ id: 'r', kind: 'reorder' as never, find: 'a', replace: 'b', count: 1 }]),
    ).toThrow(SwapError)
    expect(() => applySwaps(TEMPLATE, [text({ find: '' })])).toThrow(/empty/)
    expect(() =>
      applySwaps(TEMPLATE, [{ id: 'a', kind: 'attr', find: 'a', replace: 'b', count: 1 }]),
    ).toThrow(/attr/)
  })
})

describe('checkSwapResults', () => {
  it('passes only when every swap matched exactly its declared count', () => {
    expect(() => checkSwapResults('payments', [{ id: 'a', expected: 2, found: 2 }])).not.toThrow()
  })
  it('names stale and over-broad entries', () => {
    expect(() => checkSwapResults('payments', [{ id: 'gone', expected: 1, found: 0 }])).toThrow(
      /gone expected 1.*stale entry/,
    )
    expect(() => checkSwapResults('payments', [{ id: 'wide', expected: 1, found: 4 }])).toThrow(
      /wide expected 1.*over-broad entry/,
    )
  })
})
