// Verbatim ports of the dc runtime's pseudo-class sheet (src/pseudo.ts in dc-runtime.js): a `style-<pseudo>="css"`
// attribute becomes a class `scp<n>` (n in base 36, numbered by first use while the template is walked) and a rule
// `.scp<n>:<pseudo>{<css with every declaration !important>}`, or `.scp<n>::<pseudo>{<css>}` for before/after.
// The compiler reproduces the numbering at build time and writes the rules into the page's static CSS; a unit test
// compares every function here with the original runtime's.

export function scanUnquotedUrl(css: string, i: number): number {
  if (
    (css[i] !== 'u' && css[i] !== 'U') ||
    css.slice(i, i + 4).toLowerCase() !== 'url(' ||
    /[a-z0-9_-]/i.test(css[i - 1] ?? '')
  ) {
    return -1
  }
  let j = i + 4
  while (j < css.length && /\s/.test(css[j]!)) j++
  if (css[j] === '"' || css[j] === "'") return -1
  while (j < css.length && css[j] !== ')') {
    if (css[j] === '\\') j++
    j++
  }
  return j < css.length ? j + 1 : css.length
}

export function stripComments(css: string): string {
  let out = ''
  let quote = ''
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!
    if (quote) {
      if (c === '\\') {
        out += c + (css[i + 1] ?? '')
        i++
        continue
      }
      if (c === quote) quote = ''
      out += c
    } else if (c === "'" || c === '"') {
      quote = c
      out += c
    } else if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      i = end === -1 ? css.length : end + 1
      out += ' '
    } else {
      const end = scanUnquotedUrl(css, i)
      if (end === -1) out += c
      else {
        out += css.slice(i, end)
        i = end - 1
      }
    }
  }
  return out
}

export function importantify(css: string): string {
  css = stripComments(css)
  const decls: string[] = []
  let start = 0
  let depth = 0
  let quote = ''
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
    } else if (c === "'" || c === '"') quote = c
    else if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    else if (c === ';' && depth === 0) {
      decls.push(css.slice(start, i))
      start = i + 1
    } else {
      const end = scanUnquotedUrl(css, i)
      if (end !== -1) i = end - 1
    }
  }
  decls.push(css.slice(start))
  return decls
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => (/!\s*important$/i.test(d) ? d : d + ' !important'))
    .join(';')
}

/** The rule text the runtime inserts for one pseudo class. */
export function pseudoRule(cls: string, pseudo: string, css: string): string {
  const isPseudoElement = pseudo === 'before' || pseudo === 'after'
  const sel = isPseudoElement ? '.' + cls + '::' + pseudo : '.' + cls + ':' + pseudo
  return sel + '{' + (isPseudoElement ? css : importantify(css)) + '}'
}

/** Build-time twin of createPseudoSheet: same cache key, same numbering, same rule text, in insertion order. */
export class PseudoSheet {
  private readonly cache = new Map<string, string>()
  private readonly ruleList: string[] = []
  private n = 0

  add(pseudo: string, css: string): string {
    const k = pseudo + '|' + css
    const hit = this.cache.get(k)
    if (hit) return hit
    const cls = 'scp' + (this.n++).toString(36)
    this.ruleList.push(pseudoRule(cls, pseudo, css))
    this.cache.set(k, cls)
    return cls
  }

  get size(): number {
    return this.n
  }

  /** One rule per line (the runtime inserts them into an empty <style> through insertRule). */
  rules(): string[] {
    return [...this.ruleList]
  }

  css(): string {
    return this.ruleList.join('\n')
  }
}
