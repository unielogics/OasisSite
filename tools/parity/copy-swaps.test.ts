// The owner's contact decision (DV-CONTACT, 2026-10-10) applied to the real design: every way to TEXT the shop uses
// contact.smsE164 / smsDisplay, every way to CALL it keeps contact.phoneE164 / phoneDisplay. The copy map is the one
// source of both the port's compile and the harness's swaps on the original, so checking the swapped original checks
// the entries themselves (counts, contexts) against the design.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildBundle } from './serve-original'
import { copyMapSwaps } from './copy-swaps'
import { DESIGN_DIR, PAGES, ROOT } from './config'

const contact = (
  JSON.parse(fs.readFileSync(path.join(ROOT, 'site.config.json'), 'utf8')) as {
    contact: { phoneE164: string; phoneDisplay: string; smsE164: string; smsDisplay: string }
  }
).contact
const count = (hay: string, needle: string) => hay.split(needle).length - 1

describe('contact numbers on the swapped original (DV-CONTACT)', () => {
  const page = PAGES.find((p) => p.slug === 'index')!
  const { html } = buildBundle('index', path.join(DESIGN_DIR, page.file), copyMapSwaps(ROOT, 'index'))

  it('texts and calls are separate numbers in site.config.json', () => {
    expect(contact.smsE164).toMatch(/^\+1\d{10}$/)
    expect(contact.phoneE164).toMatch(/^\+1\d{10}$/)
  })

  it('every sms: link (markup and logic) carries the texting number, every tel: link the calling number', () => {
    const sms = html.match(/sms:[^?'"&]*/g) ?? []
    const tel = html.match(/tel:[^?'"&]*/g) ?? []
    // menu, visit, 07 section, footer, post-join member line (markup) + the pricing quote and the tint quote (logic)
    expect(sms).toHaveLength(7)
    expect(new Set(sms)).toEqual(new Set([`sms:${contact.smsE164}`]))
    expect(tel).toHaveLength(2)
    expect(new Set(tel)).toEqual(new Set([`tel:${contact.phoneE164}`]))
  })

  it('every visible "text us at" number is the texting number; the footer call link shows the calling number', () => {
    expect(html).toContain(`Text WASH to ${contact.smsDisplay}</a>`)
    expect(html).toContain(`Text ${contact.smsDisplay}</a>`)
    expect(html).toContain(`margin-top:2px;">${contact.smsDisplay}</span>`)
    expect(html).toContain(`color:var(--ink3);">${contact.smsDisplay}</div>`)
    expect(html).toContain(`Or text HERE to ${contact.smsDisplay}.`)
    expect(html).toContain(`<a href="tel:${contact.phoneE164}">${contact.phoneDisplay}</a>`)
    if (contact.smsDisplay !== contact.phoneDisplay) {
      expect(count(html, contact.smsDisplay)).toBe(5)
      expect(count(html, contact.phoneDisplay)).toBe(1)
    }
  })
})
