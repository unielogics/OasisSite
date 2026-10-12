// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
// The personal-link blocks (DV-LINK, DV-STEPUP, DV-LINK-JOIN, DV-LINK-PAY, DV-LINK-DEAD) have no counterpart in the
// design, so the parity harness cannot compare them. Two pins instead:
//
// 1. Port goldens: the patched template (the compiler's own steps: source copy entries, parse, patches, template copy
//    entries) rendered by the reference interpreter (a transliteration of the original dc runtime's walk*) with the
//    bridge's real view model in each linked state; the sheet (or the join page) is written as indented HTML and
//    compared with src/site/__goldens__/link-<state>.html. `UPDATE_GOLDENS=1` writes them; a missing golden fails.
// 2. Style tokens: every style declaration of the new blocks is one the design itself uses somewhere in its template
//    (same property, same value), so the blocks are built from the design's own type, colours, radii and spacing.
//
// Without a link the new blocks render nothing: the third block below checks the whole page markup is identical with
// and without the link patch ops (the parity harness then proves it against the original).
import fs from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyCopy, applyCopyToTree, applyPatches, loadPatchConfig, type PatchConfig } from '../../tools/dc-compile/patches'
import { parseTemplate } from '../../tools/dc-compile/parse'
import { interpret } from '../../tools/dc-compile/tests/reference'
import { installLinkCapture, resetLinkCapture } from '../client/link'
import { configCatalog, makeSite, payload, ROOT, type Handler } from './bridge.testkit'
import { exchangeAnswer, invoiceAnswer, planAnswer, stepAnswer, type LinkStateOpts } from './link-contract.testkit'

const LINK_DVS = ['DV-LINK', 'DV-STEPUP', 'DV-LINK-JOIN', 'DV-LINK-PAY', 'DV-LINK-DEAD', 'DV-LINK-CARD']
const GOLDENS = path.join(ROOT, 'src/site/__goldens__')
const UPDATE = process.env.UPDATE_GOLDENS === '1'

beforeAll(() => {
  process.env.TZ = 'America/New_York'
})
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T10:00:00-04:00'))
  ;(window as any).__oasisNavigate = () => {}
  window.scrollTo = (() => {}) as any
  resetLinkCapture()
  history.replaceState(null, '', '/')
})
afterEach(() => {
  vi.useRealTimers()
  resetLinkCapture()
})

function patchedTree(cfg: PatchConfig) {
  const src = fs.readFileSync(path.join(ROOT, 'design/extracted/index/template.html'), 'utf8')
  const { nodes } = parseTemplate(applyCopy(src, cfg.copyEntries, 'source'))
  applyPatches(nodes, cfg, 'index')
  applyCopyToTree(nodes, cfg.copyEntries)
  return nodes
}
const CFG = loadPatchConfig(ROOT, 'index')
const TREE = patchedTree(CFG)
const TREE_NO_LINKS = patchedTree({ ...CFG, ops: CFG.ops.filter((o) => !LINK_DVS.includes(o.dv)) })

/** The page's markup for the vals (props as the host passes them: user props + renderVals). */
const render = (tree: ReturnType<typeof patchedTree>, vals: any): string => renderToStaticMarkup(interpret(tree, { theme: 'dark', beads: true, stickyBar: true, ...vals }) as any)

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
/** One element per line, children indented: a golden a reviewer can read. */
function pretty(el: Element, depth = 0): string {
  const pad = '  '.repeat(depth)
  const attrs = [...el.attributes].map((a) => ` ${a.name}="${a.value.replace(/"/g, '&quot;')}"`).join('')
  const tag = el.tagName.toLowerCase()
  const kids = [...el.childNodes]
    .map((n) => (n.nodeType === 1 ? pretty(n as Element, depth + 1) : n.nodeType === 3 && n.textContent!.trim() ? `${'  '.repeat(depth + 1)}${n.textContent!.trim()}` : ''))
    .filter(Boolean)
  if (VOID.has(tag)) return `${pad}<${tag}${attrs}>`
  if (!kids.length) return `${pad}<${tag}${attrs}></${tag}>`
  return `${pad}<${tag}${attrs}>\n${kids.join('\n')}\n${pad}</${tag}>`
}

function region(html: string, selector: string): string {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html')
  const el = doc.querySelector(selector)
  if (!el) throw new Error(`no ${selector} in the render`)
  return pretty(el) + '\n'
}

function golden(name: string, text: string): void {
  const file = path.join(GOLDENS, `${name}.html`)
  if (UPDATE) {
    fs.mkdirSync(GOLDENS, { recursive: true })
    fs.writeFileSync(file, text)
    return
  }
  expect(fs.existsSync(file), `missing golden ${path.relative(ROOT, file)} (UPDATE_GOLDENS=1 writes it)`).toBe(true)
  expect(text).toBe(fs.readFileSync(file, 'utf8'))
}

const TOKEN = 'R29sZGVuTGlua1Rva2VuLTMyLWJ5dGVzLWJhc2U2NHVybDA'
const BASE = '/api/v1/public/links'
const board = payload([{ date: '2026-10-12', slots: [[540, 'open', 3], [570, 'open', 2]] }])
const ok = (body: unknown, status = 200) => ({ status, body })
const prob = (status: number, code: string, title: string, extra: Record<string, unknown> = {}) => ({ status, body: { type: 'about:blank', status, code, title, ...extra } })
// the API's own shapes (backend docs/api-spec.md section 28; link-contract.testkit.ts)
const ex = (o: LinkStateOpts = {}) => exchangeAnswer(o, 'sess-g')

async function linked(pathLetter: string, routes: Record<string, Handler>) {
  history.replaceState(null, '', `/#/${pathLetter}/${TOKEN}`)
  installLinkCapture(window as never)
  const t = makeSite({
    booking: 'sms',
    availability: board,
    routes: { '/api/v1/public/catalog': () => ok({ ...configCatalog(), plans: [] }), [`${BASE}/availability`]: () => ok(board), ...routes },
  })
  t.c.__lkMount()
  await t.settle()
  return t
}
const SHEET = 'div[style*="z-index:80"]'
const JOIN = 'div[style*="min-height:100svh"]'
const lv = (c: any) => c.renderVals().site.link

describe('port goldens of the linked states', () => {
  it('calendar link: the wash step "BOOKING FOR MARIA ••51", then the verify step', async () => {
    const t = await linked('c', { [`${BASE}/exchange`]: () => ok(ex()) })
    golden('link-book-svc', region(render(TREE, t.vals()), SHEET))
    t.c.setBk({ day: 0, slot: 540, ack: true })
    t.c.setState({ step: 'review' })
    t.c.sheetVals().sh.cta()
    await t.settle()
    expect(t.c.state.step).toBe('verify')
    golden('link-book-verify', region(render(TREE, t.vals()), SHEET))
  })

  it('step-up: code, wrong code, create PIN; PIN locked', async () => {
    const t = await linked('v', {
      [`${BASE}/exchange`]: () => ok(ex({ kind: 'verify' })),
      [`${BASE}/verify/code`]: () => ok({ challengeId: 'c1', expiresInSec: 600, purpose: 'verify', to: '51' }, 202),
      [`${BASE}/verify/code/confirm`]: () => prob(401, 'PUBLIC_OTP_INVALID', 'That code didn’t match', { detail: 'That code didn’t match. 2 more tries before you need a new one.' }),
    })
    golden('link-stepup-send', region(render(TREE, t.vals()), SHEET))
    lv(t.c).su.sendCode()
    await t.settle()
    lv(t.c).su.setValue({ target: { value: '111111' } })
    lv(t.c).su.submit()
    await t.settle()
    golden('link-stepup-code-wrong', region(render(TREE, t.vals()), SHEET))
    t.c.__lkStepUp('pinset', { purpose: 'pin_set', mode: 'create', optional: true })
    golden('link-stepup-create', region(render(TREE, t.vals()), SHEET))

    resetLinkCapture()
    const p = await linked('v', {
      [`${BASE}/exchange`]: () => ok(ex({ kind: 'verify', pin: 'set' })),
      [`${BASE}/verify/pin`]: () => prob(429, 'IDENTITY_PIN_LOCKED', 'PIN locked for now', { detail: 'Too many wrong PINs. Try again in 15 min, or reset your PIN with a texted code.' }),
    })
    golden('link-stepup-pin', region(render(TREE, p.vals()), SHEET))
    lv(p.c).su.setValue({ target: { value: '4826' } })
    lv(p.c).su.submit()
    await p.settle()
    golden('link-stepup-pin-locked', region(render(TREE, p.vals()), SHEET))
  })

  it('verified notice and dead link', async () => {
    const t = await linked('v', { [`${BASE}/exchange`]: () => ok(ex({ kind: 'verify', verified: true })) })
    golden('link-verified', region(render(TREE, t.vals()), SHEET))
    resetLinkCapture()
    const d = await linked('c', { [`${BASE}/exchange`]: () => prob(401, 'IDENTITY_LINK_INVALID', 'This link no longer works', { meta: { reason: 'expired' } }) })
    golden('link-dead-expired', region(render(TREE, d.vals()), SHEET))
  })

  it('payment review', async () => {
    const t = await linked('p', {
      [`${BASE}/exchange`]: () =>
        ok(ex({ kind: 'pay', invoice: invoiceAnswer({ items: [{ name: 'Signature Hand Wash', priceCents: 5400 }, { name: 'Hand wax', priceCents: 1500 }], paidCents: 1500 }) })),
    })
    golden('link-pay-review', region(render(TREE, t.vals()), SHEET))
  })

  it('membership: the verify step and the e-mail step on the join page', async () => {
    const t = await linked('m', {
      [`${BASE}/exchange`]: () => ok(ex({ kind: 'membership', plan: planAnswer('gold') })),
      [`${BASE}/verify/code`]: () => ok({ challengeId: 'c2', expiresInSec: 600, purpose: 'verify', to: '51' }, 202),
      [`${BASE}/verify/code/confirm`]: () => ok(stepAnswer({ kind: 'membership', plan: planAnswer('gold'), by: 'code' })),
    })
    t.c.setState({ page: 'join', jn: t.c.freshJn('gold') })
    t.c.joinVM().jv.next()
    golden('link-join-verify', region(render(TREE, t.vals()), JOIN))
    lv(t.c).su.sendCode()
    await t.settle()
    lv(t.c).su.setValue({ target: { value: '123456' } })
    lv(t.c).su.submit()
    await t.settle()
    expect(t.c.state.jn.step).toBe(2)
    golden('link-join-email', region(render(TREE, t.vals()), JOIN))
  })
})

describe('without a link the page markup is what it was before the link blocks', () => {
  it('home, the open sheet at every step, the join page: identical with and without the link ops', async () => {
    const t = makeSite({ booking: 'sms', availability: board, routes: { '/api/v1/public/catalog': () => ok({ ...configCatalog(), plans: [] }) } })
    const c = t.c
    const same = () => expect(render(TREE, t.vals())).toBe(render(TREE_NO_LINKS, t.vals()))
    same()
    c.openBook({})
    same()
    c.sheetVals().guestContinue()
    same()
    c.setBk({ day: 0, slot: 540 })
    c.setState({ step: 'review' })
    same()
    c.setState({ step: 'done' })
    same()
    c.setState({ sheet: null, page: 'join', jn: c.freshJn('gold') })
    for (const step of [0, 1, 2, 3, 4]) {
      c.setJn({ step })
      same()
    }
  })
})

describe('style tokens: the link blocks use the design\'s own declarations', () => {
  const decls = (html: string): string[] => {
    const out: string[] = []
    for (const m of html.matchAll(/\sstyle="([^"]*)"/g))
      for (const d of m[1]!.split(';')) {
        const x = d.trim()
        // a bound style ({{ site.link.card.box }}) is the design's own style object (its terms box), written by the bridge
        if (x && !/^\{\{ [a-zA-Z0-9_.]+ \}\}$/.test(x)) out.push(x.replace(/\s*:\s*/, ':'))
      }
    return out
  }
  const design = new Set(decls(fs.readFileSync(path.join(ROOT, 'design/extracted/index/template.html'), 'utf8').replace(/&#39;/g, "'")))
  const ops = CFG.ops.filter((o) => LINK_DVS.includes(o.dv))

  it('there are link blocks to check (one op per DV id)', () => {
    expect(new Set(ops.map((o) => o.dv))).toEqual(new Set(LINK_DVS))
  })

  it('every declaration of every link block occurs in the design template', () => {
    const off: string[] = []
    for (const o of ops) {
      if (!('html' in o)) continue
      for (const d of decls(o.html)) if (!design.has(d)) off.push(`${o.dv}: ${d}`)
    }
    expect(off).toEqual([])
  })

  it('no classes, no <style>, no inline script or event attribute strings in the link blocks', () => {
    for (const o of ops) {
      if (!('html' in o)) continue
      expect(o.html).not.toMatch(/\sclass=|<style|<script|javascript:/i)
      for (const m of o.html.matchAll(/\son[A-Z][a-zA-Z]*="([^"]*)"/g)) expect(m[1]).toMatch(/^\{\{ [a-zA-Z0-9_.]+ \}\}$/)
    }
  })
})
