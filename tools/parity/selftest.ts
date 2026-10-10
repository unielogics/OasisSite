import './env'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { validateAllowlist } from './allowlist'
import { launchBrowser } from './browser'
import { REPORTS_DIR, SLUGS } from './config'
import { formatSummary, runHarness, type HarnessResult } from './harness'
import { startMockPort } from './mock-port'
import { selectScenarios } from './scenarios'
import type { CheckName } from './types'

/**
 * Harness self-tests (browser based, so they run through `pnpm parity:selftest`, not `pnpm check`):
 *   1. determinism  - ORIGINAL vs ORIGINAL on two fresh loads must have zero diff on all five checks, on every screen
 *                     and theme, for every scenario.
 *   2. sensitivity  - a copy of an original with a 1 px CSS change / a text change / a renderVals change, served as the
 *                     "port", must FAIL the checks that should see it.
 *   3. swaps        - a pre-render text swap on the baseline plus the same edit in the "port" is zero diff again.
 *   4. stale entry  - an allow-list entry that matches nothing, and a swap that matches nothing, must fail the run.
 *   5. port driver  - PortDriver against a mock port that satisfies the port contract (data-oasis-ready, __oasisParity).
 */

type Transform = (page: string, template: string) => string

function replaceOnce(template: string, find: string, replace: string, what: string): string {
  const first = template.indexOf(find)
  if (first < 0 || template.indexOf(find, first + 1) >= 0)
    throw new Error(`self-test mutation "${what}" needs exactly one occurrence of ${JSON.stringify(find)}`)
  return template.slice(0, first) + replace + template.slice(first + find.length)
}

/**
 * Per page: a unique static label and a unique renderVals string the sensitivity gate mutates. When a new design
 * arrives, add its page here (the gate fails loudly on a page without an entry).
 */
const TEXT_EDIT: Record<string, [string, string]> = {
  index: ['>Compare plans<', '>Compare plans!<'],
  operations: ['>Walk-in<', '>Walk-in!<'],
  payments: ['>Export CSV<', '>Export CSV!<'],
  settings: ['>Copy Monday to weekdays<', '>Copy Monday to weekdays!<'],
}
const VALS_EDIT: Record<string, [string, string]> = {
  index: ["'Wax with every wash'", "'Wax with every wash!'"],
  operations: ["'Bay Board'", "'Bay Board!'"],
  payments: ["'Net revenue'", "'Net revenue!'"],
  settings: ["'Working hours'", "'Working hours!'"],
}
const editFor = (table: Record<string, [string, string]>, page: string): [string, string] => {
  const e = table[page]
  if (!e) throw new Error(`selftest: no mutation configured for page ${page} (tools/parity/selftest.ts)`)
  return e
}

const MUTATIONS: Record<string, { transform: Transform; mustFail: CheckName[]; mustPass: CheckName[] }> = {
  'css-1px': {
    // first static `padding:Npx` after the helmet becomes N+1 px: an inline style attribute and the layout both change
    transform: (_page, t) => {
      const cut = t.indexOf('</helmet>')
      const re = /(style="[^"{]*?padding:)(\d+)(px)/
      const rest = t.slice(cut)
      if (!re.test(rest)) throw new Error('css-1px mutation found no padding')
      return (
        t.slice(0, cut) +
        rest.replace(re, (_m, a: string, n: string, c: string) => `${a}${Number(n) + 1}${c}`)
      )
    },
    mustFail: ['dom', 'style', 'pixels'],
    mustPass: ['vals', 'console'],
  },
  'text-change': {
    transform: (page, t) =>
      replaceOnce(t, editFor(TEXT_EDIT, page)[0], editFor(TEXT_EDIT, page)[1], 'text-change'),
    mustFail: ['dom', 'pixels'],
    mustPass: ['vals', 'console'],
  },
  'vals-change': {
    transform: (page, t) =>
      replaceOnce(t, editFor(VALS_EDIT, page)[0], editFor(VALS_EDIT, page)[1], 'vals-change'),
    mustFail: ['vals', 'dom', 'pixels'],
    mustPass: ['console'],
  },
}

interface GateResult {
  name: string
  ok: boolean
  lines: string[]
}

const failedChecks = (r: HarnessResult): Set<CheckName> => {
  const out = new Set<CheckName>()
  for (const u of r.units)
    for (const s of u.steps) for (const c of Object.values(s.checks)) if (!c.ok) out.add(c.check)
  return out
}

async function determinismGate(
  quick: boolean,
  browser: Awaited<ReturnType<typeof launchBrowser>>,
): Promise<GateResult> {
  const scenarios = selectScenarios(quick ? { scenario: 'initial' } : {})
  const r = await runHarness({
    scenarios,
    port: { kind: 'original' },
    allowlist: [],
    tolerances: { pixels: [] },
    outDir: path.join(REPORTS_DIR, 'selftest', 'determinism'),
    browser,
    origPort: 0,
    // one line per run is enough when everything is green; failures print in full
    log: (l) =>
      /FAIL|ERROR|allowlist/.test(l)
        ? console.log(l)
        : /^[a-z0-9-]+\/[a-z0-9-]+@(light|dark)(\/[A-Za-z0-9_-]+)?$/.test(l)
          ? process.stdout.write('.')
          : undefined,
  })
  process.stdout.write('\n')
  const lines: string[] = []
  const steps = r.units.reduce((n, u) => n + u.steps.length, 0)
  lines.push(
    `${r.units.length} runs, ${steps} steps compared ORIGINAL vs ORIGINAL (two fresh loads each) on dom, style, pixels, vals, console`,
  )
  const covered = new Set(r.units.filter((u) => u.scenario === 'initial').map((u) => `${u.page}@${u.theme}`))
  const expected = SLUGS.flatMap((s) => [`${s}@light`, `${s}@dark`])
  const missing = expected.filter((e) => !covered.has(e))
  if (missing.length) lines.push(`MISSING initial runs: ${missing.join(', ')}`)
  const inert = r.units.filter((u) => u.steps.length > 1 && u.distinctStates < 2)
  for (const u of inert) lines.push(`scenario actions changed nothing: ${u.page}/${u.scenario}@${u.theme}`)
  if (!r.ok) lines.push(formatSummary(r))
  return {
    name: 'determinism (zero diff, original vs original)',
    ok: r.ok && !missing.length && !inert.length,
    lines,
  }
}

async function sensitivityGate(
  quick: boolean,
  browser: Awaited<ReturnType<typeof launchBrowser>>,
): Promise<GateResult> {
  const lines: string[] = []
  let ok = true
  const pages = quick ? SLUGS.slice(0, 1) : SLUGS
  for (const [name, mut] of Object.entries(MUTATIONS)) {
    for (const page of pages) {
      const r = await runHarness({
        scenarios: selectScenarios({ page, scenario: 'initial' }),
        theme: 'light',
        port: { kind: 'original', serve: { transform: mut.transform } },
        allowlist: [],
        tolerances: { pixels: [] },
        outDir: path.join(REPORTS_DIR, 'selftest', 'sensitivity', name, page),
        browser,
        origPort: 0,
        log: () => {},
      })
      const failed = failedChecks(r)
      const missed = mut.mustFail.filter((c) => !failed.has(c))
      const wrong = mut.mustPass.filter((c) => failed.has(c))
      const good = !r.ok && missed.length === 0 && wrong.length === 0
      if (!good) ok = false
      lines.push(
        `${good ? 'ok  ' : 'FAIL'} ${name} on ${page}: harness ${r.ok ? 'PASSED (wrong)' : 'failed (right)'}; failing checks = ${[...failed].join(',') || 'none'}` +
          (missed.length ? `; did NOT catch: ${missed.join(',')}` : '') +
          (wrong.length ? `; should not fail: ${wrong.join(',')}` : ''),
      )
    }
  }
  return {
    name: 'sensitivity (a 1 px CSS change, a text change and a renderVals change must fail)',
    ok,
    lines,
  }
}

async function swapGate(browser: Awaited<ReturnType<typeof launchBrowser>>): Promise<GateResult> {
  const lines: string[] = []
  let ok = true
  const page = SLUGS[0]!
  const [find, replace] = editFor(TEXT_EDIT, page)
  const allowlist = validateAllowlist([
    {
      id: 'selftest-text-swap',
      page,
      kind: 'text',
      reason: 'self-test: baseline gets the same edit as the port before render',
      swap: { find, replace, count: 1 },
    },
  ])
  const common = {
    scenarios: selectScenarios({ page, scenario: 'initial' }),
    theme: 'light' as const,
    browser,
    origPort: 0,
    tolerances: { pixels: [] },
    log: () => {},
  }
  const swapped = await runHarness({
    ...common,
    port: {
      kind: 'original',
      serve: {
        transform: (s, t) => replaceOnce(t, editFor(TEXT_EDIT, s)[0], editFor(TEXT_EDIT, s)[1], 'swap'),
      },
    },
    allowlist,
    outDir: path.join(REPORTS_DIR, 'selftest', 'swap', 'applied'),
  })
  lines.push(
    `${swapped.ok ? 'ok  ' : 'FAIL'} text swap on the baseline + same edit in the port => ${swapped.ok ? 'zero diff' : 'differs'}`,
  )
  if (!swapped.ok) {
    ok = false
    lines.push(formatSummary(swapped))
  }
  const unswapped = await runHarness({
    ...common,
    port: {
      kind: 'original',
      serve: {
        transform: (s, t) => replaceOnce(t, editFor(TEXT_EDIT, s)[0], editFor(TEXT_EDIT, s)[1], 'swap'),
      },
    },
    allowlist: [],
    outDir: path.join(REPORTS_DIR, 'selftest', 'swap', 'not-applied'),
  })
  lines.push(
    `${!unswapped.ok ? 'ok  ' : 'FAIL'} same port edit WITHOUT the swap => ${unswapped.ok ? 'passed (wrong)' : 'fails (right)'}`,
  )
  if (unswapped.ok) ok = false
  return { name: 'pre-render swaps', ok, lines }
}

async function staleGate(browser: Awaited<ReturnType<typeof launchBrowser>>): Promise<GateResult> {
  const lines: string[] = []
  let ok = true
  const page = SLUGS[0]!
  const common = {
    scenarios: selectScenarios({ page, scenario: 'initial' }),
    theme: 'light' as const,
    browser,
    origPort: 0,
    tolerances: { pixels: [] },
    log: () => {},
  }
  const stale = validateAllowlist([
    {
      id: 'selftest-stale',
      page,
      kind: 'text',
      reason: 'self-test: nothing ever differs here, so this is stale',
      matcher: { loc: 'title' },
    },
  ])
  const r = await runHarness({
    ...common,
    port: { kind: 'original' },
    allowlist: stale,
    outDir: path.join(REPORTS_DIR, 'selftest', 'stale', 'entry'),
  })
  const caught = !r.ok && r.problems.some((p) => p.includes('selftest-stale'))
  lines.push(
    `${caught ? 'ok  ' : 'FAIL'} a diff-side entry that matches nothing fails the run (${r.problems[0] ?? 'no problem reported'})`,
  )
  if (!caught) ok = false
  const badSwap = validateAllowlist([
    {
      id: 'selftest-stale-swap',
      page,
      kind: 'text',
      reason: 'self-test: swap target does not exist',
      swap: { find: 'no such text anywhere', replace: 'x', count: 1 },
    },
  ])
  let threw = ''
  try {
    await runHarness({
      ...common,
      port: { kind: 'original' },
      allowlist: badSwap,
      outDir: path.join(REPORTS_DIR, 'selftest', 'stale', 'swap'),
    })
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err)
  }
  const swapCaught = /selftest-stale-swap.*stale entry/.test(threw)
  lines.push(
    `${swapCaught ? 'ok  ' : 'FAIL'} a pre-render swap that matches nothing aborts the run (${threw.slice(0, 110) || 'it did not throw'})`,
  )
  if (!swapCaught) ok = false
  return { name: 'stale and over-broad entries', ok, lines }
}

async function portDriverGate(browser: Awaited<ReturnType<typeof launchBrowser>>): Promise<GateResult> {
  const lines: string[] = []
  let ok = true
  const mock = await startMockPort()
  const mutated = await startMockPort({ transform: MUTATIONS['css-1px']!.transform })
  try {
    const scenarios = [
      ...selectScenarios({ scenario: 'initial' }),
      ...selectScenarios({ scenario: 'theme-toggle' }),
      ...selectScenarios({ scenario: 'emergency-deeplink' }),
    ]
    const clean = await runHarness({
      scenarios,
      port: { kind: 'url', url: mock.url },
      allowlist: [],
      tolerances: { pixels: [] },
      outDir: path.join(REPORTS_DIR, 'selftest', 'port-driver', 'clean'),
      browser,
      origPort: 0,
      log: () => {},
    })
    lines.push(
      `${clean.ok ? 'ok  ' : 'FAIL'} ${clean.units.length} runs through PortDriver (URL paths, hash, ready flag, __oasisParity.getVals) => ${clean.ok ? 'zero diff' : 'differs'}`,
    )
    if (!clean.ok) {
      ok = false
      lines.push(formatSummary(clean))
    }
    const bad = await runHarness({
      scenarios: selectScenarios({ page: SLUGS[0]!, scenario: 'initial' }),
      theme: 'light',
      port: { kind: 'url', url: mutated.url },
      allowlist: [],
      tolerances: { pixels: [] },
      outDir: path.join(REPORTS_DIR, 'selftest', 'port-driver', 'mutated'),
      browser,
      origPort: 0,
      log: () => {},
    })
    const failed = failedChecks(bad)
    const caught = !bad.ok && ['dom', 'style', 'pixels'].every((c) => failed.has(c as CheckName))
    lines.push(
      `${caught ? 'ok  ' : 'FAIL'} a 1 px change behind the port URL fails dom, style and pixels (failing: ${[...failed].join(',') || 'none'})`,
    )
    if (!caught) ok = false
  } finally {
    await mock.close()
    await mutated.close()
  }
  return { name: 'port driver against a mock port', ok, lines }
}

async function main(): Promise<number> {
  // `pnpm parity:selftest -- --quick` hands the separator through to the script
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: { quick: { type: 'boolean', default: false } },
    strict: true,
  })
  const quick = values.quick === true
  fs.rmSync(path.join(REPORTS_DIR, 'selftest'), { recursive: true, force: true })
  const browser = await launchBrowser()
  const gates: GateResult[] = []
  try {
    for (const gate of [
      () => determinismGate(quick, browser),
      () => sensitivityGate(quick, browser),
      () => swapGate(browser),
      () => staleGate(browser),
      () => portDriverGate(browser),
    ]) {
      const g = await gate()
      gates.push(g)
      console.log(`\n${g.ok ? 'PASS' : 'FAIL'}  ${g.name}`)
      for (const l of g.lines) console.log(`      ${l}`)
    }
  } finally {
    await browser.close()
  }
  const ok = gates.every((g) => g.ok)
  console.log(`\nparity:selftest ${ok ? 'PASSED' : 'FAILED'}${quick ? ' (quick subset)' : ''}`)
  for (const g of gates) console.log(`  ${g.ok ? 'PASS' : 'FAIL'}  ${g.name}`)
  return ok ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err)
    process.exit(1)
  },
)
