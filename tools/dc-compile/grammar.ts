import { CompileError } from './errors'

/** `IDENT ('.' (IDENT | DIGITS))*` — the only expression form the three designs use. */
export interface PathExpr {
  root: string
  segs: string[]
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const DIGITS = /^\d+$/
/** The runtime resolves these as literals, never as vals named `true` etc. */
const LITERALS = new Set(['true', 'false', 'null', 'undefined'])

export function parsePath(src: string): PathExpr | null {
  const parts = src.trim().split('.')
  const root = parts[0]!
  if (!IDENT.test(root) || LITERALS.has(root)) return null
  for (const p of parts.slice(1)) if (!IDENT.test(p) && !DIGITS.test(p)) return null
  return { root, segs: parts.slice(1) }
}

/**
 * Whole-attribute binding `^\s*\{\{([\s\S]+?)\}\}\s*$` (same regex as the runtime's compileAttr).
 * The runtime's lazy regex misparses `{{a}} x {{b}}` as one expression; here that is a build error.
 */
export function wholeBinding(raw: string, where: string): string | null {
  const m = raw.match(/^\s*\{\{([\s\S]+?)\}\}\s*$/)
  if (!m) return null
  if (m[1]!.includes('{{') || m[1]!.includes('}}')) {
    throw new CompileError(
      `${where}: attribute mixes several {{ }} bindings in a way the runtime misparses: ${JSON.stringify(raw)}`,
    )
  }
  return m[1]!
}

/** Split interpolated text/attribute into static (even index) and expression (odd index) parts. */
export const splitInterp = (raw: string): string[] => raw.split(/\{\{([\s\S]+?)\}\}/)
