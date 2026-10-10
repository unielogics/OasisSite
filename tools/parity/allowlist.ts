import fs from 'node:fs'
import { SLUGS, THEMES, type Theme } from './config'
import { CHECK_NAMES, type CheckName, type Diff, type DiffKind } from './types'
import type { SwapSpec } from './bundle'

export type DeviationKind =
  'text' | 'attr' | 'reorder' | 'element-added' | 'region-mask' | 'wiring' | 'computed-style'
export const DEVIATION_KINDS: readonly DeviationKind[] = [
  'text',
  'attr',
  'reorder',
  'element-added',
  'region-mask',
  'wiring',
  'computed-style',
]

export interface Matcher {
  /** glob on the diff locator: DOM path, element key, JSON path. "*" stays inside one segment, "**" crosses segments. */
  loc?: string | string[]
  /** glob on the attribute / style-property name */
  name?: string
  /** regular expressions on the original / port value of the diff */
  orig?: string
  port?: string
  /** exact data-dc-tpl id */
  tpl?: string
  /** region-mask: viewport rectangle to blank out before the pixel diff */
  rect?: { x: number; y: number; w: number; h: number }
}

export interface Scope {
  scenarios?: string[]
  steps?: string[]
  themes?: Theme[]
  /** viewport names (site.config.json parity.viewports) */
  viewports?: string[]
  checks?: CheckName[]
}

export interface AllowEntry {
  id: string
  /** page slug (design/pages.json) or '*' */
  page: string
  kind: DeviationKind
  reason: string
  scope?: Scope
  matcher?: Matcher
  /** text|attr only: applied to the ORIGINAL before render (so pixels stay at zero), instead of matching diffs */
  swap?: {
    find: string
    replace: string
    count: number
    attr?: string
    target?: 'template' | 'logic' | 'any'
  }
  /** per (unit, step) match count bounds for diff-side entries; min defaults to 1 */
  expect?: { min?: number; max?: number }
}

export class AllowlistError extends Error {}

/** Which checks an entry may cover by default, and which diff kinds it may excuse, per deviation kind. */
export const KIND_RULES: Record<DeviationKind, { checks: CheckName[]; diffKinds: DiffKind[] }> = {
  text: { checks: ['dom', 'vals'], diffKinds: ['text', 'value'] },
  attr: { checks: ['dom', 'vals'], diffKinds: ['attr', 'value'] },
  reorder: { checks: ['dom', 'vals', 'style'], diffKinds: ['reorder', 'rect', 'style', 'value'] },
  'element-added': {
    checks: ['dom', 'vals', 'style'],
    diffKinds: ['element-added', 'element-removed', 'rect', 'style', 'text', 'attr', 'value'],
  },
  'region-mask': { checks: ['pixels', 'style'], diffKinds: ['pixel', 'rect', 'style'] },
  wiring: { checks: ['dom', 'vals', 'console'], diffKinds: ['attr', 'element-added', 'value', 'console'] },
  // a computed property that differs without any DOM or pixel change (live: an inherited custom property)
  'computed-style': { checks: ['style'], diffKinds: ['style'] },
}

export function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*'
        i++
      } else out += '[^./]*'
    } else out += c.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

function simpleGlob(glob: string, value: string): boolean {
  return new RegExp('^' + glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(value)
}

export function validateAllowlist(raw: unknown, slugs: readonly string[] = SLUGS): AllowEntry[] {
  const problems: string[] = []
  const list: unknown = Array.isArray(raw) ? raw : (raw as { entries?: unknown } | null)?.entries
  if (!Array.isArray(list)) throw new AllowlistError('allowlist must be {"entries": [...]} or an array')
  const seen = new Set<string>()
  const entries: AllowEntry[] = []
  list.forEach((item, index) => {
    const e = item as Partial<AllowEntry> | null
    const where = `entries[${index}]${e && typeof e.id === 'string' ? ` (${e.id})` : ''}`
    const bad = (msg: string) => problems.push(`${where}: ${msg}`)
    if (!e || typeof e !== 'object') return bad('not an object')
    if (typeof e.id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(e.id)) bad('id must match [A-Za-z0-9._-]+')
    else if (seen.has(e.id)) bad('duplicate id')
    else seen.add(e.id)
    if (e.page !== '*' && !slugs.includes(e.page as string))
      bad(`page must be one of ${slugs.join('|')} or *`)
    if (!DEVIATION_KINDS.includes(e.kind as DeviationKind))
      bad(`kind must be one of ${DEVIATION_KINDS.join('|')}`)
    if (typeof e.reason !== 'string' || e.reason.trim().length < 10)
      bad('reason must be a real sentence (10+ chars)')
    const kind = e.kind as DeviationKind
    const rules = KIND_RULES[kind]
    if (e.scope) {
      for (const c of e.scope.checks ?? []) {
        if (!CHECK_NAMES.includes(c)) bad(`scope.checks has unknown check "${c}"`)
        else if (rules && !rules.checks.includes(c))
          bad(`kind ${kind} cannot cover check "${c}" (allowed: ${rules.checks.join(', ')})`)
      }
      for (const t of e.scope.themes ?? [])
        if (!(THEMES as readonly string[]).includes(t)) bad(`scope.themes has unknown theme "${t}"`)
      for (const key of ['scenarios', 'steps'] as const) {
        const v = e.scope[key]
        if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x)))
          bad(`scope.${key} must be a string array`)
      }
    }
    if (e.swap) {
      if (kind !== 'text' && kind !== 'attr')
        bad(`only text and attr deviations can carry a pre-render "swap" (kind is ${kind})`)
      if (e.matcher) bad('an entry with "swap" must not also have a "matcher"')
      if (typeof e.swap.find !== 'string' || !e.swap.find) bad('swap.find must be a non-empty string')
      if (typeof e.swap.replace !== 'string') bad('swap.replace must be a string')
      if (e.swap.find === e.swap.replace) bad('swap.find equals swap.replace')
      if (!Number.isInteger(e.swap.count) || e.swap.count < 1)
        bad('swap.count must be a positive integer (the exact number of replacements)')
      if (kind === 'attr' && !e.swap.attr) bad('an attr swap needs swap.attr')
      if (e.expect) bad('"expect" does not apply to swap entries (swap.count is the contract)')
    } else {
      const m = e.matcher
      if (!m || typeof m !== 'object') bad('a matcher is required (or a swap, for text/attr)')
      else {
        const locs = m.loc === undefined ? [] : Array.isArray(m.loc) ? m.loc : [m.loc]
        for (const l of locs) {
          if (typeof l !== 'string' || !l) bad('matcher.loc must be a non-empty glob')
          else if (/^\*+$/.test(l)) bad('matcher.loc may not be a bare wildcard (over-broad)')
        }
        for (const key of ['orig', 'port'] as const) {
          const v = m[key]
          if (v === undefined) continue
          try {
            new RegExp(v)
          } catch {
            bad(`matcher.${key} is not a valid regular expression`)
          }
        }
        if (kind === 'region-mask') {
          if (!m.rect && !m.tpl) bad('region-mask needs matcher.rect or matcher.tpl')
          if (m.rect) {
            const r = m.rect
            if (![r.x, r.y, r.w, r.h].every((n) => Number.isFinite(n)) || r.w <= 0 || r.h <= 0)
              bad('matcher.rect needs numeric x,y and positive w,h')
          }
        } else if (
          !locs.length &&
          m.name === undefined &&
          m.orig === undefined &&
          m.port === undefined &&
          m.tpl === undefined
        ) {
          bad('matcher is over-broad: give at least one of loc, name, orig, port, tpl')
        }
      }
      if (e.expect) {
        const { min, max } = e.expect
        if (min !== undefined && (!Number.isInteger(min) || min < 0))
          bad('expect.min must be an integer >= 0')
        if (max !== undefined && (!Number.isInteger(max) || max < 1))
          bad('expect.max must be an integer >= 1')
        if (min !== undefined && max !== undefined && min > max) bad('expect.min > expect.max')
      }
    }
    entries.push(e as AllowEntry)
  })
  if (problems.length) throw new AllowlistError('invalid allowlist:\n  ' + problems.join('\n  '))
  return entries
}

export function loadAllowlist(file: string, slugs: readonly string[] = SLUGS): AllowEntry[] {
  if (!fs.existsSync(file)) return []
  return validateAllowlist(JSON.parse(fs.readFileSync(file, 'utf8')), slugs)
}

/** The pre-render swaps (text and attr entries with a "swap") that apply to a screen's original bundle. */
export function swapsFor(entries: readonly AllowEntry[], page: string): SwapSpec[] {
  const out: SwapSpec[] = []
  for (const e of entries) {
    if (!e.swap || (e.page !== '*' && e.page !== page)) continue
    if (e.kind !== 'text' && e.kind !== 'attr') {
      throw new AllowlistError(`${e.id}: deviation kind "${e.kind}" cannot be applied before render`)
    }
    out.push({
      id: e.id,
      kind: e.kind,
      find: e.swap.find,
      replace: e.swap.replace,
      count: e.swap.count,
      attr: e.swap.attr,
      target: e.swap.target,
    })
  }
  return out
}

/**
 * Typos in `scope` would make an entry silently inert (it would never apply, so it could never be called stale). Every
 * scope.scenarios glob must match a scenario of the entry's screen and every scope.steps glob a step of such a scenario
 * (the automatic "initial" step included).
 */
export function checkAllowlistScopes(
  entries: readonly AllowEntry[],
  catalogue: ReadonlyArray<{ id: string; page: string; steps: ReadonlyArray<{ id: string }> }>,
): string[] {
  const problems: string[] = []
  for (const e of entries) {
    if (e.swap || !e.scope) continue
    const scenarios = catalogue.filter((s) => e.page === '*' || s.page === e.page)
    for (const g of e.scope.scenarios ?? []) {
      if (!scenarios.some((s) => simpleGlob(g, s.id)))
        problems.push(`${e.id}: scope.scenarios "${g}" matches no scenario on ${e.page}`)
    }
    const inScope = scenarios.filter(
      (s) => !e.scope!.scenarios || e.scope!.scenarios.some((g) => simpleGlob(g, s.id)),
    )
    for (const g of e.scope.steps ?? []) {
      if (!inScope.some((s) => simpleGlob(g, 'initial') || s.steps.some((st) => simpleGlob(g, st.id)))) {
        problems.push(`${e.id}: scope.steps "${g}" matches no step of the scenarios in scope`)
      }
    }
  }
  return problems
}

export interface UnitCtx {
  page: string
  scenario: string
  theme: Theme
  step: string
  viewport?: string
}

export function entryApplies(e: AllowEntry, u: UnitCtx): boolean {
  if (e.swap) return false
  if (e.page !== '*' && e.page !== u.page) return false
  const s = e.scope
  if (!s) return true
  if (s.themes && !s.themes.includes(u.theme)) return false
  if (s.viewports && (!u.viewport || !s.viewports.includes(u.viewport))) return false
  if (s.scenarios && !s.scenarios.some((g) => simpleGlob(g, u.scenario))) return false
  if (s.steps && !s.steps.some((g) => simpleGlob(g, u.step))) return false
  return true
}

function entryCovers(e: AllowEntry, check: CheckName): boolean {
  return (e.scope?.checks ?? KIND_RULES[e.kind].checks).includes(check)
}

/** vals diffs carry JSON text (strings are quoted); regex matchers see the quoted form and the plain string. */
function valueForms(v: string | undefined): string[] {
  if (v === undefined) return ['']
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return [v, JSON.parse(v) as string]
    } catch {
      return [v]
    }
  }
  return [v]
}

function matcherHits(m: Matcher, d: Diff): boolean {
  if (m.loc !== undefined) {
    const globs = Array.isArray(m.loc) ? m.loc : [m.loc]
    if (!globs.some((g) => globToRegExp(g).test(d.loc))) return false
  }
  if (m.name !== undefined && !globToRegExp(m.name).test(d.name ?? '')) return false
  if (m.orig !== undefined && !valueForms(d.orig).some((v) => new RegExp(m.orig!).test(v))) return false
  if (m.port !== undefined && !valueForms(d.port).some((v) => new RegExp(m.port!).test(v))) return false
  if (m.tpl !== undefined && d.tpl !== m.tpl) return false
  return true
}

export interface ApplyResult {
  remaining: Diff[]
  allowed: Diff[]
  /** matches per entry id among the entries that apply to this unit/step */
  counts: Map<string, number>
}

/** Splits diffs into allowed and remaining, and counts matches per applicable entry. Pixel diffs are masked, not matched. */
export function applyAllowlist(
  diffs: readonly Diff[],
  entries: readonly AllowEntry[],
  unit: UnitCtx,
): ApplyResult {
  const applicable = entries.filter((e) => entryApplies(e, unit))
  const counts = new Map<string, number>(applicable.map((e) => [e.id, 0]))
  const remaining: Diff[] = []
  const allowed: Diff[] = []
  for (const d of diffs) {
    let by: string | undefined
    for (const e of applicable) {
      if (e.kind === 'region-mask' || !e.matcher) continue
      if (!entryCovers(e, d.check)) continue
      if (!KIND_RULES[e.kind].diffKinds.includes(d.kind)) continue
      if (!matcherHits(e.matcher, d)) continue
      counts.set(e.id, (counts.get(e.id) ?? 0) + 1)
      by ??= e.id
    }
    if (by) allowed.push({ ...d, allowedBy: by })
    else remaining.push(d)
  }
  return { remaining, allowed, counts }
}

/** region-mask entries that apply to a unit/step (their rect or tpl is resolved by the pixel check). */
export function masksFor(entries: readonly AllowEntry[], unit: UnitCtx): AllowEntry[] {
  return entries.filter((e) => e.kind === 'region-mask' && entryApplies(e, unit))
}

/** Accumulates per-entry match counts over a run to report stale and over-broad entries. */
export class AllowlistTracker {
  private readonly total = new Map<string, number>()
  private readonly appliedUnits = new Map<string, number>()
  readonly problems: string[] = []

  constructor(private readonly entries: readonly AllowEntry[]) {}

  record(unitLabel: string, counts: ReadonlyMap<string, number>): string[] {
    const local: string[] = []
    for (const e of this.entries) {
      if (!counts.has(e.id)) continue
      const n = counts.get(e.id) ?? 0
      this.total.set(e.id, (this.total.get(e.id) ?? 0) + n)
      this.appliedUnits.set(e.id, (this.appliedUnits.get(e.id) ?? 0) + 1)
      const min = e.expect?.min ?? 1
      const max = e.expect?.max ?? Infinity
      if (n < min)
        local.push(
          `${e.id}: matched ${n} (< min ${min}) at ${unitLabel}; stale entry, or set expect.min to 0 for a wildcard scope`,
        )
      if (n > max) local.push(`${e.id}: matched ${n} (> max ${max}) at ${unitLabel}; over-broad entry`)
    }
    this.problems.push(...local)
    return local
  }

  /** Per entry: differences matched in total and the number of steps the entry applied to (swap entries are not tracked). */
  usage(): Array<{ id: string; matched: number; steps: number }> {
    return this.entries
      .filter((e) => !e.swap)
      .map((e) => ({ id: e.id, matched: this.total.get(e.id) ?? 0, steps: this.appliedUnits.get(e.id) ?? 0 }))
  }

  /** Call once at the end of a run; entries that applied somewhere but never matched anything are stale. */
  finish(): string[] {
    for (const e of this.entries) {
      if (e.swap) continue
      if ((this.appliedUnits.get(e.id) ?? 0) > 0 && (this.total.get(e.id) ?? 0) === 0) {
        this.problems.push(`${e.id}: never matched anything in this run (stale entry)`)
      }
    }
    return this.problems
  }
}
