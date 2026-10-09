// Reading and rewriting the original design bundles. A bundle is a self-contained HTML file whose
// <script type="__bundler/template"> holds the JSON-encoded template source: the <x-dc> markup followed by the
// <script type="text/x-dc"> logic class. Pre-render deviation swaps operate on that decoded source.

const TEMPLATE_OPEN = '<script type="__bundler/template">'

export interface SwapSpec {
  /** allow-list entry id, for reports */
  id: string
  kind: 'text' | 'attr'
  /** raw source substring to find (HTML entities exactly as written in the template source) */
  find: string
  replace: string
  /** exact number of occurrences that must be replaced; anything else is a stale/over-broad entry */
  count: number
  /** kind "attr": only occurrences inside the quoted value of this attribute are replaced */
  attr?: string
  /** restrict to the <x-dc> markup, to the logic script, or both (default) */
  target?: 'template' | 'logic' | 'any'
}

export interface SwapResult {
  id: string
  expected: number
  found: number
}

export class SwapError extends Error {}

export function extractTemplate(html: string): { start: number; end: number; template: string } {
  const open = html.indexOf(TEMPLATE_OPEN)
  if (open < 0) throw new Error('bundle has no __bundler/template script')
  const start = open + TEMPLATE_OPEN.length
  const end = html.indexOf('</script>', start)
  if (end < 0) throw new Error('unterminated __bundler/template script')
  const template = JSON.parse(html.slice(start, end)) as unknown
  if (typeof template !== 'string') throw new Error('__bundler/template is not a JSON string')
  return { start, end, template }
}

/** JSON-encode a template string so it can sit inside a <script> element (no raw "</script", no "<!--"). */
export function encodeTemplate(template: string): string {
  return JSON.stringify(template)
    .replace(/<\/(script)/gi, '<\\u002F$1')
    .replace(/<!--/g, '<\\u0021--')
}

export function replaceTemplate(html: string, template: string): string {
  const { start, end } = extractTemplate(html)
  return html.slice(0, start) + '\n' + encodeTemplate(template) + '\n' + html.slice(end)
}

function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0
  let n = 0
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++
  return n
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Splits template source into the <x-dc> markup and the logic script that follows it. */
function splitRegions(template: string): { markup: string; logic: string } {
  const i = template.indexOf('</x-dc>')
  if (i < 0) return { markup: template, logic: '' }
  const cut = i + '</x-dc>'.length
  return { markup: template.slice(0, cut), logic: template.slice(cut) }
}

function applyOne(region: string, swap: SwapSpec): { out: string; found: number } {
  if (swap.kind === 'text') {
    const found = countOccurrences(region, swap.find)
    return { out: found ? region.split(swap.find).join(swap.replace) : region, found }
  }
  if (!swap.attr) throw new SwapError(`swap ${swap.id}: kind "attr" needs an "attr" name`)
  let found = 0
  const re = new RegExp(`(\\s${escapeRe(swap.attr)}\\s*=\\s*)(?:"([^"]*)"|'([^']*)')`, 'g')
  const out = region.replace(re, (whole, head: string, dq: string | undefined, sq: string | undefined) => {
    const value = dq ?? sq ?? ''
    const n = countOccurrences(value, swap.find)
    if (!n) return whole
    found += n
    const quote = dq !== undefined ? '"' : "'"
    return head + quote + value.split(swap.find).join(swap.replace) + quote
  })
  return { out, found }
}

/**
 * Applies the swaps to decoded template source. Returns the new source and per-swap match counts. The caller decides
 * what a wrong count means (serve-original throws a SwapError: 0 matches = stale entry, more than declared = over-broad).
 */
export function applySwaps(
  template: string,
  swaps: readonly SwapSpec[],
): { template: string; results: SwapResult[] } {
  let { markup, logic } = splitRegions(template)
  const results: SwapResult[] = []
  for (const swap of swaps) {
    if (swap.kind !== 'text' && swap.kind !== 'attr') {
      throw new SwapError(`swap ${swap.id}: kind "${String(swap.kind)}" cannot be applied before render`)
    }
    if (!swap.find) throw new SwapError(`swap ${swap.id}: empty "find"`)
    const target = swap.target ?? 'any'
    let found = 0
    if (target === 'template' || target === 'any') {
      const r = applyOne(markup, swap)
      markup = r.out
      found += r.found
    }
    if (target === 'logic' || target === 'any') {
      const r = applyOne(logic, swap)
      logic = r.out
      found += r.found
    }
    results.push({ id: swap.id, expected: swap.count, found })
  }
  return { template: markup + logic, results }
}

export function checkSwapResults(screen: string, results: readonly SwapResult[]): void {
  const bad = results.filter((r) => r.found !== r.expected)
  if (bad.length) {
    throw new SwapError(
      `deviation swaps do not match the ${screen} bundle: ` +
        bad
          .map(
            (r) =>
              `${r.id} expected ${r.expected} replacement(s), found ${r.found} (${r.found === 0 ? 'stale entry' : r.found > r.expected ? 'over-broad entry' : 'partially stale entry'})`,
          )
          .join('; '),
    )
  }
}
