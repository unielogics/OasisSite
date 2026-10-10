import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PNG } from 'pngjs'
import { beforeEach, describe, expect, it } from 'vitest'
import { validateAllowlist, type AllowEntry } from './allowlist'
import { compareSnapshots } from './runner'
import type { ElementSnap, Snapshot } from './types'

/** the dashboard fixture pages this test's entries name (design/pages.json lists the site's page only) */
const validate = (raw: unknown) => validateAllowlist(raw, ['payments', 'settings', 'operations'])

const png = (paint: (x: number, y: number) => number): Buffer => {
  const img = new PNG({ width: 32, height: 32 })
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const i = (y * 32 + x) * 4
      img.data[i] = img.data[i + 1] = img.data[i + 2] = paint(x, y)
      img.data[i + 3] = 255
    }
  }
  return PNG.sync.write(img)
}

const el = (key: string, over: Partial<ElementSnap> = {}): ElementSnap => ({
  key,
  tag: 'div',
  tpl: key.startsWith('t') ? key.slice(1).split('#')[0]! : null,
  path: key,
  rect: [0, 0, 10, 10],
  scroll: [10, 10, 10, 10, 0, 0],
  cs: { display: 'block' },
  ...over,
})

const snap = (side: 'orig' | 'port', over: Partial<Snapshot> = {}): Snapshot => ({
  side,
  html: '<div id="dc-root"><div class="sc-host" data-sc-name="x"><p data-dc-tpl="1">Hello</p></div></div>',
  elements: [el('t1#0')],
  vals: { title: 'Hello', style: { a: 1, b: 2 } },
  png: png(() => 255),
  console: [],
  blocked: [],
  fullStyle: false,
  docSize: { width: 32, height: 32 },
  ...over,
})

const unit = { page: 'payments' as const, scenario: 'ranges', theme: 'light' as const, step: 'range-today' }
let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-runner-'))
})
const ctx = (allowlist: AllowEntry[] = []) => ({ allowlist, tolerances: { pixels: [] }, consoleBaseline: {} })

describe('compareSnapshots', () => {
  it('passes identical snapshots on all five checks and writes the artifacts', () => {
    const { step } = compareSnapshots(
      snap('orig'),
      snap('port', { html: snap('port').html.replace('data-sc-name="x"', 'data-sc-name="oasis"') }),
      unit,
      ctx(),
      path.join(dir, 's'),
    )
    expect(step.ok).toBe(true)
    expect(Object.values(step.checks).map((c) => c.ok)).toEqual([true, true, true, true, true])
    expect(fs.readdirSync(path.join(dir, 's')).sort()).toEqual([
      'diff.png',
      'orig.png',
      'port.png',
      'step.json',
    ])
    expect(JSON.parse(fs.readFileSync(path.join(dir, 's', 'step.json'), 'utf8')).step).toBe('range-today')
  })

  it('fails every check that sees a difference, with machine-readable detail', () => {
    const b = snap('port', {
      html: snap('port').html.replace('Hello', 'Hullo'),
      elements: [el('t1#0', { rect: [0, 0, 10, 11] })],
      vals: { title: 'Hullo', style: { b: 2, a: 1 } },
      png: png((x, y) => (x === 3 && y === 3 ? 0 : 255)),
      console: [{ type: 'error', text: 'boom' }],
    })
    const { step } = compareSnapshots(snap('orig'), b, unit, ctx(), path.join(dir, 's'))
    expect(step.ok).toBe(false)
    expect(Object.fromEntries(Object.entries(step.checks).map(([k, v]) => [k, v.diffs]))).toEqual({
      dom: 1,
      style: 1,
      vals: 2,
      pixels: 1,
      console: 1,
    })
    expect(step.checks.dom.sample[0]).toMatchObject({ kind: 'text', orig: 'Hello', port: 'Hullo' })
    expect(step.checks.pixels.artifacts).toContain('diff.png')
    expect(fs.existsSync(path.join(dir, 's', 'dom.diff.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 's', 'vals.diff.json'))).toBe(true)
  })

  it('compares data-dc-tpl only when both sides have it', () => {
    const noTpl = snap('port', { html: '<div id="dc-root"><div class="sc-host"><p>Hello</p></div></div>' })
    const { step } = compareSnapshots(snap('orig'), noTpl, unit, ctx(), path.join(dir, 's'))
    expect(step.checks.dom.ok).toBe(true)
    expect(step.checks.dom.note).toContain('stripped')
  })

  it('lets the allow-list excuse listed differences only, and counts the matches', () => {
    const entries = validate([
      {
        id: 'title-text',
        page: 'payments',
        kind: 'text',
        reason: 'copy changes WhatsApp to SMS',
        matcher: { orig: '^Hello$', port: '^Hullo$' },
        scope: { checks: ['dom', 'vals'] },
      },
      {
        id: 'title-val',
        page: 'payments',
        kind: 'text',
        reason: 'same change seen in renderVals',
        matcher: { loc: 'title' },
      },
    ])
    const b = snap('port', {
      html: snap('port').html.replace('Hello', 'Hullo'),
      vals: { title: 'Hullo', style: { a: 1, b: 2 } },
    })
    const { step, counts } = compareSnapshots(snap('orig'), b, unit, ctx(entries), path.join(dir, 's'))
    expect(step.ok).toBe(true)
    expect(step.checks.dom.allowed).toBe(1)
    expect(step.checks.vals.allowed).toBe(1)
    expect(Object.fromEntries(counts)).toMatchObject({ 'title-text': 2, 'title-val': 1 })
    const unlisted = snap('port', {
      html: snap('port').html.replace('Hello', 'Hallo'),
      vals: { title: 'Hallo', style: { a: 1, b: 2 } },
    })
    expect(compareSnapshots(snap('orig'), unlisted, unit, ctx(entries), path.join(dir, 't')).step.ok).toBe(
      false,
    )
  })

  it('region masks blank the pixel diff and report usage; unused masks count as zero', () => {
    const entries = validate([
      {
        id: 'mask-hit',
        page: 'payments',
        kind: 'region-mask',
        reason: 'nondeterministic blur region',
        matcher: { rect: { x: 0, y: 0, w: 8, h: 8 } },
      },
      {
        id: 'mask-miss',
        page: 'payments',
        kind: 'region-mask',
        reason: 'region that never differs',
        matcher: { rect: { x: 20, y: 20, w: 8, h: 8 } },
      },
    ])
    const b = snap('port', { png: png((x, y) => (x === 3 && y === 3 ? 0 : 255)) })
    const { step, counts } = compareSnapshots(snap('orig'), b, unit, ctx(entries), path.join(dir, 's'))
    expect(step.checks.pixels.ok).toBe(true)
    expect(step.checks.pixels.allowed).toBe(1)
    expect(Object.fromEntries(counts)).toEqual({ 'mask-hit': 1, 'mask-miss': 0 })
  })

  it('resolves a tpl mask from the element rects of both sides', () => {
    const entries = validate([
      {
        id: 'tpl-mask',
        page: 'payments',
        kind: 'region-mask',
        reason: 'masks one element',
        matcher: { tpl: '1' },
      },
    ])
    const b = snap('port', { png: png((x, y) => (x === 3 && y === 3 ? 0 : 255)) })
    expect(
      compareSnapshots(snap('orig'), b, unit, ctx(entries), path.join(dir, 's')).step.checks.pixels.ok,
    ).toBe(true)
  })

  it('only a declared tolerance forgives pixels, and it says so', () => {
    const b = snap('port', { png: png((x, y) => (x === 3 && y === 3 ? 0 : 255)) })
    const tol = {
      pixels: [
        {
          id: 'blur',
          page: 'payments' as const,
          maxMismatched: 1,
          reason: 'backdrop-filter software rasterisation jitter',
        },
      ],
    }
    const ok = compareSnapshots(snap('orig'), b, unit, { ...ctx(), tolerances: tol }, path.join(dir, 's'))
    expect(ok.step.checks.pixels.ok).toBe(true)
    expect(ok.step.checks.pixels.note).toContain('within tolerance blur')
    const tight = { pixels: [{ ...tol.pixels[0]!, maxMismatched: 0 }] }
    expect(
      compareSnapshots(snap('orig'), b, unit, { ...ctx(), tolerances: tight }, path.join(dir, 't')).step
        .checks.pixels.ok,
    ).toBe(false)
  })

  it('treats a differently sized screenshot as a pixel failure', () => {
    const big = new PNG({ width: 33, height: 32 })
    const b = snap('port', { png: PNG.sync.write(big) })
    const { step } = compareSnapshots(snap('orig'), b, unit, ctx(), path.join(dir, 's'))
    expect(step.checks.pixels.ok).toBe(false)
    expect(step.checks.pixels.sample[0]!.orig).toContain('32x32')
  })
})
