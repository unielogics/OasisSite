import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Driver } from './drivers'
import { applyAllowlist, masksFor, type AllowEntry, type AllowlistTracker, type UnitCtx } from './allowlist'
import { diffConsole } from './diff-console'
import { diffDom, hasTpl, normalizeHtml, renderTree } from './diff-dom'
import { diffPixels, type PixelMask } from './diff-pixels'
import { diffElements } from './diff-style'
import { diffVals } from './diff-vals'
import type { Scenario } from './scenarios/types'
import { pixelToleranceFor, type Tolerances } from './tolerances'
import {
  CHECK_NAMES,
  type CheckName,
  type CheckResult,
  type Diff,
  type Snapshot,
  type StepResult,
  type UnitResult,
} from './types'
import type { Theme } from './config'

export interface RunContext {
  makeOriginal: () => Driver
  makePort: () => Driver
  allowlist: readonly AllowEntry[]
  tolerances: Tolerances
  /** normalised console messages the original is known to emit, per screen */
  consoleBaseline: Partial<Record<string, string[]>>
  tracker: AllowlistTracker
  /** live mode: forgive last-digit noise between long computed decimals in renderVals (docs/parity-live.md) */
  floatNoise?: { relative: number }
  outDir: string
  log?: (line: string) => void
}

const SAMPLE = 25
const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_')

function writeJson(file: string, data: unknown): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 1) + '\n')
}

function summarize(
  check: CheckName,
  raw: Diff[],
  remaining: Diff[],
  allowed: Diff[],
  artifacts: string[],
  extra: Partial<CheckResult> = {},
): CheckResult {
  return {
    check,
    ok: remaining.length === 0,
    rawDiffs: raw.length,
    diffs: remaining.length,
    allowed: allowed.length,
    artifacts,
    sample: remaining.slice(0, SAMPLE),
    ...extra,
  }
}

export interface Comparison {
  step: StepResult
  counts: Map<string, number>
}

/** Runs the five checks on one pair of snapshots, writes the artifacts, and returns the step result. */
export function compareSnapshots(
  a: Snapshot,
  b: Snapshot,
  unit: UnitCtx,
  ctx: Pick<RunContext, 'allowlist' | 'tolerances' | 'consoleBaseline' | 'floatNoise'>,
  stepDir: string,
): Comparison {
  fs.mkdirSync(stepDir, { recursive: true })
  const counts = new Map<string, number>()
  const addCounts = (m: ReadonlyMap<string, number>) => {
    for (const [k, v] of m) counts.set(k, (counts.get(k) ?? 0) + v)
  }
  const checks = {} as Record<CheckName, CheckResult>

  // (a) DOM
  {
    const keepTpl = hasTpl(a.html) && hasTpl(b.html)
    const ta = normalizeHtml(a.html, keepTpl)
    const tb = normalizeHtml(b.html, keepTpl)
    const raw = diffDom(ta, tb)
    const r = applyAllowlist(raw, ctx.allowlist, unit)
    addCounts(r.counts)
    const artifacts: string[] = []
    if (raw.length) {
      writeJson(path.join(stepDir, 'dom.diff.json'), { keepTpl, remaining: r.remaining, allowed: r.allowed })
      fs.writeFileSync(path.join(stepDir, 'dom.orig.txt'), renderTree(ta) + '\n')
      fs.writeFileSync(path.join(stepDir, 'dom.port.txt'), renderTree(tb) + '\n')
      artifacts.push('dom.diff.json', 'dom.orig.txt', 'dom.port.txt')
    }
    checks.dom = summarize('dom', raw, r.remaining, r.allowed, artifacts, {
      note: keepTpl ? 'data-dc-tpl compared' : 'data-dc-tpl absent on one side; stripped',
    })
  }

  // (b) computed style + rects (+ the document scroll size: a full-page screenshot covers it)
  {
    const raw = diffElements(a.elements, b.elements)
    if (a.docSize.width !== b.docSize.width || a.docSize.height !== b.docSize.height) {
      raw.unshift({
        check: 'style',
        kind: 'rect',
        loc: 'document',
        name: 'scrollSize',
        orig: `${a.docSize.width}x${a.docSize.height}`,
        port: `${b.docSize.width}x${b.docSize.height}`,
      })
    }
    const r = applyAllowlist(raw, ctx.allowlist, unit)
    addCounts(r.counts)
    const artifacts: string[] = []
    if (raw.length) {
      writeJson(path.join(stepDir, 'style.diff.json'), { remaining: r.remaining, allowed: r.allowed })
      artifacts.push('style.diff.json')
    }
    checks.style = summarize('style', raw, r.remaining, r.allowed, artifacts, {
      note: `${a.elements.length} vs ${b.elements.length} elements, ${a.fullStyle ? 'full' : 'curated'} property set`,
    })
  }

  // (d) renderVals
  {
    const forgiven: string[] = []
    const raw = diffVals(a.vals, b.vals, {
      floatNoise: ctx.floatNoise,
      onForgiven: (loc) => forgiven.push(loc),
    })
    const r = applyAllowlist(raw, ctx.allowlist, unit)
    addCounts(r.counts)
    const artifacts: string[] = []
    if (raw.length || unit.step === 'initial') {
      writeJson(path.join(stepDir, 'vals.orig.json'), a.vals)
      writeJson(path.join(stepDir, 'vals.port.json'), b.vals)
      artifacts.push('vals.orig.json', 'vals.port.json')
    }
    if (raw.length) {
      writeJson(path.join(stepDir, 'vals.diff.json'), { remaining: r.remaining, allowed: r.allowed })
      artifacts.push('vals.diff.json')
    }
    checks.vals = summarize('vals', raw, r.remaining, r.allowed, artifacts, {
      ...(forgiven.length
        ? {
            note: `${forgiven.length} last-digit float differences forgiven: ${forgiven.slice(0, 6).join(', ')}`,
          }
        : {}),
    })
  }

  // (c) pixels
  {
    const masks: PixelMask[] = []
    const maskEntries = masksFor(ctx.allowlist, unit)
    for (const e of maskEntries) {
      let rect = e.matcher?.rect
        ? { x: e.matcher.rect.x, y: e.matcher.rect.y, w: e.matcher.rect.w, h: e.matcher.rect.h }
        : undefined
      if (!rect && e.matcher?.tpl) {
        const els = [...a.elements, ...b.elements].filter(
          (x) => x.tpl === e.matcher!.tpl && x.rect[2] > 0 && x.rect[3] > 0,
        )
        if (els.length) {
          const x0 = Math.min(...els.map((x) => x.rect[0]))
          const y0 = Math.min(...els.map((x) => x.rect[1]))
          const x1 = Math.max(...els.map((x) => x.rect[0] + x.rect[2]))
          const y1 = Math.max(...els.map((x) => x.rect[1] + x.rect[3]))
          rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
        }
      }
      if (rect) masks.push({ id: e.id, rect })
      else counts.set(e.id, counts.get(e.id) ?? 0)
    }
    const px = diffPixels(a.png, b.png, masks)
    for (const m of maskEntries)
      if (masks.some((x) => x.id === m.id))
        counts.set(m.id, (counts.get(m.id) ?? 0) + (px.maskUsage[m.id]! > 0 ? 1 : 0))
    fs.writeFileSync(path.join(stepDir, 'orig.png'), a.png)
    fs.writeFileSync(path.join(stepDir, 'port.png'), b.png)
    const artifacts = ['orig.png', 'port.png']
    if (px.diffPng) {
      fs.writeFileSync(path.join(stepDir, 'diff.png'), px.diffPng)
      artifacts.push('diff.png')
    }
    const tol = pixelToleranceFor(ctx.tolerances, unit)
    const within = !px.sizeMismatch && tol !== undefined && px.mismatched <= tol.maxMismatched
    const remaining = px.mismatched > 0 && !within
    const diffs: Diff[] = px.sizeMismatch
      ? [{ check: 'pixels', kind: 'pixel', loc: 'size', orig: px.sizeMismatch }]
      : px.boxes.map((bx) => ({
          check: 'pixels' as const,
          kind: 'pixel' as const,
          loc: `${bx.x},${bx.y},${bx.w},${bx.h}`,
          name: 'mismatched',
          orig: String(bx.count),
        }))
    checks.pixels = {
      check: 'pixels',
      ok: !remaining,
      rawDiffs: px.mismatched,
      diffs: remaining ? px.mismatched : 0,
      allowed: px.unmaskedMismatched - px.mismatched,
      artifacts,
      sample: remaining ? diffs : [],
      note: [
        `${px.mismatched} px differ (threshold 0)`,
        px.unmaskedMismatched !== px.mismatched
          ? `${px.unmaskedMismatched - px.mismatched} hidden by region masks`
          : '',
        within ? `within tolerance ${tol!.id} (<= ${tol!.maxMismatched}): ${tol!.reason}` : '',
      ]
        .filter(Boolean)
        .join('; '),
    }
    if (px.mismatched)
      writeJson(path.join(stepDir, 'pixels.diff.json'), {
        mismatched: px.mismatched,
        unmasked: px.unmaskedMismatched,
        boxes: px.boxes,
        size: px.sizeMismatch,
      })
  }

  // (e) console warnings
  {
    const baseline = ctx.consoleBaseline[unit.page] ?? []
    const cmp = diffConsole(a.console, b.console, { orig: a.blocked, port: b.blocked }, baseline)
    const r = applyAllowlist(cmp.diffs, ctx.allowlist, unit)
    addCounts(r.counts)
    const artifacts: string[] = []
    if (cmp.orig.length || cmp.port.length) {
      writeJson(path.join(stepDir, 'console.json'), {
        orig: cmp.orig,
        port: cmp.port,
        remaining: r.remaining,
        allowed: r.allowed,
      })
      artifacts.push('console.json')
    }
    checks.console = summarize('console', cmp.diffs, r.remaining, r.allowed, artifacts)
  }

  const hash = (x: string | Buffer) => crypto.createHash('sha1').update(x).digest('hex').slice(0, 12)
  const step: StepResult = {
    step: unit.step,
    ok: CHECK_NAMES.every((c) => checks[c].ok),
    checks,
    htmlHash: hash(a.html),
    pngHash: hash(a.png),
  }
  writeJson(path.join(stepDir, 'step.json'), step)
  return { step, counts }
}

export function unitDir(outDir: string, page: string, scenario: string, theme: Theme): string {
  return path.join(outDir, page, safe(scenario), theme)
}

export async function runUnit(ctx: RunContext, scenario: Scenario, theme: Theme): Promise<UnitResult> {
  const started = Date.now()
  const dir = unitDir(ctx.outDir, scenario.page, scenario.id, theme)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const result: UnitResult = {
    page: scenario.page,
    scenario: scenario.id,
    theme,
    ok: false,
    steps: [],
    allowlistProblems: [],
    distinctStates: 0,
    durationMs: 0,
  }
  const orig = ctx.makeOriginal()
  const port = ctx.makePort()
  const label = `${scenario.page}/${scenario.id}@${theme}`
  try {
    const open = { page: scenario.page, theme, hash: scenario.hash, touch: scenario.touch }
    await orig.open(open)
    await port.open(open)
    const steps = [
      {
        id: 'initial',
        full: true,
        keepPointer: false,
        run: undefined as undefined | ((a: Driver['actions']) => Promise<void>),
      },
      ...scenario.steps.map((s) => ({
        id: s.id,
        full: s.full ?? false,
        keepPointer: s.keepPointer ?? false,
        run: s.run,
      })),
    ]
    const seen = new Set<string>()
    for (const step of steps) {
      if (seen.has(step.id)) throw new Error(`scenario ${scenario.id}: duplicate step id "${step.id}"`)
      seen.add(step.id)
      if (step.run) {
        await step.run(orig.actions)
        await step.run(port.actions)
      }
      const pointer = { parkPointer: !step.keepPointer }
      const [sa, sb] = [await orig.snapshot(step.full, pointer), await port.snapshot(step.full, pointer)]
      const unit: UnitCtx = { page: scenario.page, scenario: scenario.id, theme, step: step.id }
      const { step: stepResult, counts } = compareSnapshots(sa, sb, unit, ctx, path.join(dir, safe(step.id)))
      const problems = ctx.tracker.record(`${label}/${step.id}`, counts)
      result.allowlistProblems.push(...problems)
      result.steps.push(stepResult)
      ctx.log?.(
        `  ${stepResult.ok && !problems.length ? 'ok  ' : 'FAIL'} ${label}/${step.id}${stepResult.ok ? '' : ' ' + failedChecks(stepResult)}`,
      )
      for (const p of problems) ctx.log?.(`       allowlist: ${p}`)
    }
    result.distinctStates = new Set(result.steps.map((s) => `${s.htmlHash}/${s.pngHash}`)).size
    result.ok = result.steps.every((s) => s.ok) && result.allowlistProblems.length === 0
  } catch (err) {
    result.error = err instanceof Error ? (err.stack ?? err.message) : String(err)
    ctx.log?.(`  ERROR ${label}: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    await Promise.allSettled([orig.close(), port.close()])
    result.durationMs = Date.now() - started
    writeJson(path.join(dir, 'result.json'), result)
  }
  return result
}

export function failedChecks(s: StepResult): string {
  return CHECK_NAMES.filter((c) => !s.checks[c].ok)
    .map((c) => `${c}(${s.checks[c].diffs})`)
    .join(' ')
}
