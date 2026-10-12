// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
// DV-PRICE-INTERIM (owner, 2026-10-12, plan decision 9): with site.config.json `pricing: "interim"` (the default) the page
// shows only the Signature Hand Wash "from $40", membership "from $129/mo" (Gold) and the $25 booking fee; every other
// price reads "Priced by vehicle size — ask us" / "Ask us", and the live catalog (DV-CATALOG v1, the old member/guest
// model) never changes a price. The port writes the interim words in the bridge; the parity harness gives the ORIGINAL
// the same words as pre-render swaps (parity/allowlist.json DV-PRICE-INTERIM-*). This file holds the two together over
// every price state, value for value (the parity proof in a unit test), and scans every state for "$" figures.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeVals } from '../dc/serialize'
import { designCatalog, withMemberPrice } from '../../tools/site/catalog-fixture'
import { parseTemplate, walkEls, type ElNode } from '../../tools/dc-compile/parse'
import { applyCopy, loadPatchConfig } from '../../tools/dc-compile/patches'
import { catalogTexts, interimFigures, interimTexts, INTERIM, priceFacts } from './catalog'
import { applySwaps, designComponent, makeSite, originalSwaps, payload, ROOT, swappedDesignComponent, type Handler } from './bridge.testkit'

beforeAll(() => {
  process.env.TZ = 'America/New_York'
})
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T10:00:00-04:00'))
  window.scrollTo = (() => {}) as any
  ;(window as any).__oasisNavigate = () => {}
})
afterEach(() => {
  vi.useRealTimers()
  delete (window as any).__oasisNavigate
})

const ok = (body: unknown): ReturnType<Handler> => ({ status: 200, body })
const board = payload([
  { date: '2026-10-10', slots: [[960, 'open', 2]] },
  { date: '2026-10-11', slots: [], closed: true },
  { date: '2026-10-12', slots: [[540, 'open', 3], [570, 'last', 1]] },
])
const FEE = 25

/** Every state a price appears in: home (calculator, flipped price rows), the pages, the tint calculator, the join flow, the sheet. */
function states(c: any): Record<string, any>[] {
  const bk = c.state.bk
  const jn = c.state.jn
  const out: Record<string, any>[] = [{}, { washes: 1 }, { washes: 2 }, { washes: 3 }, { priceRevealed: true }]
  for (const page of ['membership', 'wash', 'tint', 'detailing', 'experience', 'visit']) out.push({ page }, { page, priceRevealed: true })
  for (const [film, tintVeh] of [['carbon', 'suv'], ['ceramic', 'truck'], ['carbon', 'sedan'], ['ceramic', 'sedan']]) out.push({ page: 'tint', film, tintVeh })
  for (const tier of ['gold', 'vip']) for (const step of [0, 1, 2, 3, 4]) out.push({ page: 'join', jn: { ...jn, tier, step, name: 'Jo Park', agree: step > 2 } })
  const sheet = (who: string | null, step: string, tier: string | null, svc: string, addons: string[]) => ({
    page: 'home',
    sheet: 'book',
    step,
    tier,
    bk: { ...bk, who, svc, addons, day: 1, slot: 540 },
  })
  for (const step of ['who', 'svc', 'time', 'review', 'done']) {
    for (const svc of ['signature', 'exterior']) {
      out.push(sheet('guest', step, null, svc, ['wax', 'tire', 'leather']))
      out.push(sheet('guest', step, null, svc, []))
      out.push(sheet('member', step, 'vip', svc, ['wax', 'stain', 'deep']))
      out.push(sheet('member', step, 'gold', svc, ['engine', 'rain']))
      out.push(sheet('member', step, 'gold', svc, []))
    }
    out.push(sheet(null, step, null, 'signature', []))
  }
  return out
}

/** The serialised renderVals of each state (what the parity harness diffs), with or without the bridge's own `site` key. */
function valsOver(t: ReturnType<typeof makeSite>, list: Record<string, any>[], withSite = false): Record<string, any>[] {
  const base = t.c.state
  return list.map((st) => {
    t.c.state = { ...base, ...st }
    const v = serializeVals(t.c.renderVals()) as Record<string, any>
    if (!withSite) delete v.site
    return v
  })
}

/** Every "$" figure in a value (strings anywhere inside it). */
function figures(x: unknown, out: string[] = []): string[] {
  if (typeof x === 'string') out.push(...(x.match(/\$\s?\d[\d,]*(?:\.\d+)?/g) ?? []))
  else if (Array.isArray(x)) for (const y of x) figures(y, out)
  else if (x && typeof x === 'object') for (const y of Object.values(x)) figures(y, out)
  return out
}

describe('the interim prices are the default, and the bridge renders exactly what the swapped original renders', () => {
  it('site.config.json pricing is "interim"', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'site.config.json'), 'utf8')) as { pricing?: string }
    expect(cfg.pricing).toBe('interim')
    expect(makeSite().env.pricing).toBe('interim')
  })

  for (const booking of ['sms', 'live'] as const)
    it(`every price state, value for value (${booking})`, () => {
      // the original as the harness renders it: the allow-list's DV-PRICE-INTERIM logic swaps, no bridge price code
      // (catalog mode without a catalog passes the design's values through)
      const orig = makeSite({ booking, availability: board, pricing: 'catalog', design: swappedDesignComponent() })
      const port = makeSite({ booking, availability: board })
      const list = states(port.c)
      const want = valsOver(orig, list)
      const got = valsOver(port, list)
      for (let i = 0; i < list.length; i++) expect(got[i], JSON.stringify(list[i]).slice(0, 160)).toEqual(want[i])
    })

  it('every DV-PRICE-INTERIM swap matches the design (count) and the logic swaps all change something the page shows', () => {
    const swaps = originalSwaps('DV-PRICE-INTERIM-')
    expect(swaps.filter((w) => w.target === 'logic').length).toBe(32)
    expect(swaps.filter((w) => w.target === 'template').length).toBe(23)
    // applySwaps throws on a count mismatch
    applySwaps(fs.readFileSync(path.join(ROOT, 'design/extracted/index/logic.original.js'), 'utf8'), swaps, 'logic')
    applySwaps(fs.readFileSync(path.join(ROOT, 'design/extracted/index/template.html'), 'utf8'), swaps, 'template')
  })
})

describe('no figure but the starting prices and the fee', () => {
  it('in every state, the template texts (site.cat) included', () => {
    for (const booking of ['sms', 'live'] as const) {
      const t = makeSite({ booking, availability: board })
      const allowed = new Set(interimFigures(FEE))
      for (const v of valsOver(t, states(t.c), true)) for (const f of figures(v)) expect(allowed.has(f.replace(/\s/g, '')), f).toBe(true)
    }
  })

  it('the starting prices and the words where they belong', () => {
    const t = makeSite({ availability: board })
    const v = t.vals()
    const rows = (title: string) => v.prGroups.find((g: any) => g.title === title)?.rows ?? []
    expect(rows('Hand wash')[0]).toMatchObject({ name: 'Signature Hand Wash', pre: 'from', g: '$40', v: 'Included', save: 'WITH VIP' })
    expect(rows('Hand wash')[1]).toMatchObject({ name: 'Exterior Hand Wash', pre: '', g: 'Ask us', v: 'Included', save: 'WITH VIP' })
    expect(rows('Add during your wash').find((r: any) => r.name === 'Tire shine & dressing')).toMatchObject({ g: 'Ask us', v: 'Ask us', save: 'PRICED BY SIZE' })
    expect(rows('Window tint')[0]).toMatchObject({ pre: '', g: 'Ask us' })
    expect(v.prShowMonth).toBe(false)
    expect(v.faqs[1].a).toBe('No. Guests pay a $25 non-refundable booking fee to hold a time. Members never pay it.')
    expect([v.calcGuest, v.calcGuestSub, v.calcSave, v.calcSaveSub]).toEqual(['', '', '', ''])
    expect(v.site.cat).toMatchObject({ fromGold: 'from $129', gold: '$129', goldPer: '/ month and up', vip: 'Ask us', calcDisplay: 'none', fee: '$25', saveFee: 'MEMBERS', memberFee: 'None' })
    t.c.setState({ page: 'membership' })
    expect(t.vals().compRows.find((r: any) => r.f === 'Booking fee').cells.map((c: any) => c.t)).toEqual(['$25', 'None', 'None'])
    t.c.setState({ page: 'wash' })
    expect(t.vals().washCards.map((c: any) => c.g)).toEqual(['from $40', INTERIM.priced])
    t.c.setState({ page: 'tint', film: 'ceramic', tintVeh: 'suv' })
    expect(t.vals()).toMatchObject({ tintPriceLabel: 'CERAMIC · SUV / CROSSOVER', tintVip: 'Ask us', tintGuest: '', tintSave: '' })
    t.c.setState({ page: 'join', jn: { ...t.c.state.jn, tier: 'gold', step: 3 } })
    let jv = t.vals().jv
    expect(jv.tiers.map((x: any) => [x.name, x.price])).toEqual([['Gold', 'from $129'], ['VIP', 'Ask us']])
    expect(jv.lines.map((l: any) => l.value)).toEqual(['from $129/mo', '1', '4', 'None'])
    expect(jv.due).toBe('from $129')
    expect(jv.ctaLabel).toBe('Start Gold')
    expect(jv.agreeText).toBe('I agree to be billed monthly for Gold until I cancel. Unused washes don’t roll over.')
    t.c.setState({ jn: { ...t.c.state.jn, tier: 'vip' } })
    jv = t.vals().jv
    expect([jv.lines[0].value, jv.due, jv.ctaLabel]).toEqual(['Ask us', 'Ask us', 'Start VIP'])
    t.c.setState({ page: 'home', sheet: 'book', step: 'svc', bk: { ...t.c.state.bk, who: 'guest', addons: ['wax'] } })
    const svc = t.vals().sh
    expect(svc.washes.map((w: any) => [w.price, w.note])).toEqual([['from $40', 'by vehicle size'], ['Ask us', 'by vehicle size']])
    expect(new Set(svc.addons.map((a: any) => a.price))).toEqual(new Set(['Ask us']))
    t.c.setState({ step: 'review', bk: { ...t.c.state.bk, day: 1, slot: 540 } })
    const review = t.vals().sh
    expect(review.lines.map((l: any) => l.value)).toEqual(['from $40', 'Ask us', '$25'])
    expect(review.due).toBe('$25')
    expect(review.dueSub).toBe('$25 due at the counter or by the link we text you. Pay the rest after your wash.')
    expect(review.upsell).toBe('No booking fee, with wax and engine bay included.')
    t.c.setState({ tier: 'vip', bk: { ...t.c.state.bk, who: 'member', addons: ['wax', 'tire'] } })
    const member = t.vals().sh
    expect(member.lines.map((l: any) => l.value)).toEqual(['Included', 'Included', 'Ask us'])
    expect([member.due, member.dueSub]).toEqual(['Ask us', 'Uses 1 of your 4 washes this month.'])
  })
})

describe('the catalog never brings the old prices back in interim mode', () => {
  it('a ready catalog as the build snapshot and as the live answer changes nothing; its keys still name the booking', async () => {
    const cat = withMemberPrice(designCatalog(), 'signature-hand-wash', 50)
    cat.plans[0]!.priceCents = 10900
    const plain = makeSite({ booking: 'live', availability: board })
    const list = states(plain.c)
    const want = valsOver(plain, list, true)
    const t = makeSite({ booking: 'live', availability: board, catalog: cat, routes: { '/api/v1/public/catalog': () => ok(cat), '/api/v1/public/availability': () => ok(board) } })
    expect(t.env.catalogSnapshot).toBeNull()
    t.c.__refreshAll()
    await t.settle()
    expect(t.calls.some((c) => c.path === '/api/v1/public/catalog')).toBe(true)
    expect(t.c.__site).toBeNull()
    expect(t.c.__serviceKey()).toBe('signature-hand-wash')
    t.c.setState({ bk: { ...t.c.state.bk, addons: ['wax'] } })
    expect(t.c.__addonKeys()).toEqual({ keys: ['hand-wax'], missing: [] })
    const got = valsOver(t, list, true)
    for (let i = 0; i < list.length; i++) expect(got[i], JSON.stringify(list[i]).slice(0, 160)).toEqual(want[i])
  })

  it('catalog mode keeps DV-CATALOG: the same catalog shows its prices', async () => {
    const cat = withMemberPrice(designCatalog(), 'signature-hand-wash', 50)
    const t = makeSite({ booking: 'live', availability: board, pricing: 'catalog', routes: { '/api/v1/public/catalog': () => ok(cat), '/api/v1/public/availability': () => ok(board) } })
    t.c.__refreshAll()
    await t.settle()
    expect(t.vals().prGroups[0].rows[0]).toMatchObject({ name: 'Signature Hand Wash', g: '$60', save: 'SAVE $60' })
  })
})

describe('the template texts (site.cat) equal the original markup after the swaps', () => {
  const cfg = loadPatchConfig(ROOT, 'index')
  const raw = fs.readFileSync(path.join(ROOT, 'design/extracted/index/template.html'), 'utf8')
  const swaps = originalSwaps()
  // the harness's order: the allow-list's swaps (text and attr; the one attr swap's text is unique), then the copy map
  let swapped = applySwaps(raw, swaps, 'template')
  for (const w of swaps.filter((x) => x.kind === 'attr')) swapped = swapped.split(w.find).join(w.replace)
  const byTpl = (html: string) => {
    const m = new Map<number, ElNode>()
    walkEls(parseTemplate(applyCopy(html, cfg.copyEntries, 'source')).nodes, (el) => m.set(el.tpl, el))
    return m
  }
  const orig = byTpl(swapped)
  const design = byTpl(raw)
  const interim = interimTexts(FEE)
  const d = new (designComponent())({})
  const builtIn = catalogTexts(priceFacts(null, { WASH: d.WASH, DURING: d.DURING, TINT: d.TINT, VEH: d.VEH, FEE: d.FEE }, (m) => Math.round(m * 1.2)))
  const bound = cfg.ops.filter((op): op is Extract<typeof op, { op: 'replace-text' }> => op.op === 'replace-text' && /site\.cat\./.test(op.with))

  it('every bound text: interim mode reads the swapped original, catalog mode the design', () => {
    expect(bound.length).toBe(29)
    const keyOf = (op: (typeof bound)[number]) => /site\.cat\.(\w+)/.exec(op.with)![1]!
    for (const op of bound) {
      expect(builtIn[keyOf(op)], keyOf(op)).toBe(op.expect)
      const n = design.get(op.tpl)!.children[op.child ?? 0]!
      expect(n.kind === 'text' ? n.value : null, keyOf(op)).toBe(op.expect)
    }
    // per element: the design's children with each bound text replaced by its interim value read like the original's
    for (const tpl of new Set(bound.map((op) => op.tpl))) {
      const ops = bound.filter((op) => op.tpl === tpl)
      // the element's own text (its child elements are bound on their own)
      const own = (nodes: ElNode['children']) => nodes.map((c) => (c.kind === 'text' ? c.value : '')).join('')
      const port = design.get(tpl)!.children.map((c, i) => {
        const op = ops.find((o) => (o.child ?? 0) === i)
        return op && c.kind === 'text' ? { ...c, value: interim[keyOf(op)]! } : c
      })
      expect(own(port), ops.map(keyOf).join(',')).toBe(own(orig.get(tpl)!.children))
    }
  })

  it('the calculator box: the port appends display:{{ site.cat.calcDisplay }}, the original display:none', () => {
    const op = cfg.ops.find((o) => o.op === 'set-attr' && o.dv === 'DV-PRICE-INTERIM') as Extract<(typeof cfg.ops)[number], { op: 'set-attr' }>
    const style = (els: Map<number, ElNode>) => els.get(op.tpl)!.attrs.find((a) => a.name === 'style')!.value
    expect(style(design)).toBe(op.expect)
    expect(op.value.replace('{{ site.cat.calcDisplay }}', interim.calcDisplay!)).toBe(style(orig))
    expect(interim.calcDisplay).toBe('none')
    expect(builtIn.calcDisplay).toBe('block')
  })
})
