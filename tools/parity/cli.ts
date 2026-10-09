import './env'
import fs from 'node:fs'
import { parseArgs } from 'node:util'
import { CONSOLE_BASELINE_FILE, REPORTS_DIR, SLUGS, isSlug, isTheme } from './config'
import { launchBrowser } from './browser'
import { OriginalDriver } from './drivers'
import { formatSummary, runHarness, loadConsoleBaseline, type PortTarget } from './harness'
import { ALL_SCENARIOS, selectScenarios, themesOf } from './scenarios'
import { startOriginalServer } from './serve-original'
import { normalizeConsole } from './diff-console'
import type { HoursFixture } from './serve-dist'

const HELP = `pnpm parity [options]

  --page <slug>                              limit to one page of design/pages.json (default: all)
  --scenario <id>                            limit to one scenario id (see --list)
  --theme <light|dark>                       limit to one theme (default: both)
  --tag <tag>                                limit to scenarios carrying a tag (for example smoke)
  --all                                      every scenario on every page (what parity:all runs)
  --dist <dir>                               serve this build in-process as the port (default dist-parity)
  --hours <design|alt>                       hours fixture the in-process server answers with (default design)
  --port-url <url>                           use an already running server instead (serve:dist or production)
  --against-original                         dry run: use a second copy of the ORIGINAL as the port
  --out <dir>                                artifact root (default parity-reports)
  --list                                     list the scenarios and exit
  --update-console-baseline                  record the original's console warnings as the baseline and exit
  -h, --help
`

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      page: { type: 'string' },
      scenario: { type: 'string' },
      theme: { type: 'string' },
      tag: { type: 'string' },
      all: { type: 'boolean', default: false },
      dist: { type: 'string' },
      hours: { type: 'string' },
      'port-url': { type: 'string' },
      'against-original': { type: 'boolean', default: false },
      out: { type: 'string' },
      list: { type: 'boolean', default: false },
      'update-console-baseline': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  })
  if (values.help) {
    console.log(HELP)
    return 0
  }
  if (values.page && !isSlug(values.page)) throw new Error(`--page must be one of ${SLUGS.join(', ')}`)
  if (values.theme && !isTheme(values.theme)) throw new Error('--theme must be light or dark')
  if (values.hours && values.hours !== 'design' && values.hours !== 'alt')
    throw new Error('--hours must be design or alt')
  const filter = { page: values.page, scenario: values.scenario, tag: values.tag }
  if (
    !values.all &&
    !filter.page &&
    !filter.scenario &&
    !filter.tag &&
    !values.list &&
    !values['update-console-baseline']
  ) {
    console.error('Nothing selected. Pass --page/--scenario/--tag, or --all (pnpm parity:all).\n')
    console.error(HELP)
    return 2
  }
  const scenarios = selectScenarios(filter)
  if (values.list) {
    for (const s of ALL_SCENARIOS)
      console.log(
        `${s.page.padEnd(10)} ${s.id.padEnd(22)} ${(s.tags ?? []).join(',').padEnd(8)} ${s.steps.length + 1} steps  ${s.title}`,
      )
    return 0
  }
  if (!scenarios.length) {
    console.error('no scenario matches the filter (see --list)')
    return 2
  }
  if (values['update-console-baseline']) return updateConsoleBaseline(scenarios, values.theme)
  const port: PortTarget = values['against-original']
    ? { kind: 'original' }
    : values['port-url']
      ? { kind: 'url', url: values['port-url'] }
      : {
          kind: 'dist',
          serve: {
            dir: values.dist ?? 'dist-parity',
            hours: (values.hours as HoursFixture | undefined) ?? 'design',
          },
        }
  const result = await runHarness({
    scenarios,
    theme: values.theme as 'light' | 'dark' | undefined,
    port,
    outDir: values.out ?? REPORTS_DIR,
  })
  console.log('\n' + formatSummary(result))
  return result.ok ? 0 : 1
}

async function updateConsoleBaseline(
  scenarios: ReturnType<typeof selectScenarios>,
  theme?: string,
): Promise<number> {
  const server = await startOriginalServer()
  const browser = await launchBrowser()
  const baseline = loadConsoleBaseline()
  const found: Record<string, Set<string>> = {}
  try {
    for (const sc of scenarios) {
      for (const t of themesOf(sc, theme === 'light' || theme === 'dark' ? theme : undefined)) {
        const d = new OriginalDriver(browser, server)
        await d.open({ page: sc.page, theme: t, hash: sc.hash, touch: sc.touch })
        for (const step of sc.steps) await step.run?.(d.actions)
        const snap = await d.snapshot(false)
        for (const m of snap.console) (found[sc.page] ??= new Set()).add(normalizeConsole(m))
        await d.close()
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
  const next: Record<string, string[]> = {}
  for (const page of SLUGS)
    next[page] = [...new Set([...(baseline[page] ?? []), ...(found[page] ?? [])])].sort()
  fs.writeFileSync(CONSOLE_BASELINE_FILE, JSON.stringify(next, null, 2) + '\n')
  console.log(
    `wrote ${CONSOLE_BASELINE_FILE}: ${JSON.stringify(Object.fromEntries(Object.entries(next).map(([k, v]) => [k, v.length])))}`,
  )
  return 0
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  },
)
