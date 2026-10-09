import type { ConsoleMsg, Diff } from './types'

/** Strips run-specific noise (ports, blob/uuid ids, timestamps) so messages from both sides can be compared. */
export function normalizeConsole(m: ConsoleMsg): string {
  const text = m.text
    .replace(/https?:\/\/127\.0\.0\.1:\d+/g, '<origin>')
    .replace(/blob:[^\s)'"]+/g, 'blob:<id>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\s+/g, ' ')
    .trim()
  // The original runtime and the port word an unresolved binding differently; both reduce to the binding expression.
  const unresolved = /\{\{\s*([^}]+?)\s*\}\}[^]*never resolved|never resolved[^]*\{\{\s*([^}]+?)\s*\}\}/.exec(
    text,
  )
  if (unresolved) return `${m.type}: unresolved binding {{ ${unresolved[1] ?? unresolved[2]} }}`
  return `${m.type}: ${text}`
}

export interface ConsoleCompare {
  diffs: Diff[]
  orig: string[]
  port: string[]
}

function multiset(list: string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const s of list) m.set(s, (m.get(s) ?? 0) + 1)
  return m
}

/**
 * Compares the warnings/errors/page errors each side logged during a step, plus any request the network block aborted.
 * `baseline` lists normalised messages that the ORIGINAL is known to emit; an original message outside it is reported as
 * baseline drift (the browser or runtime changed under us), never silently accepted.
 */
export function diffConsole(
  orig: readonly ConsoleMsg[],
  port: readonly ConsoleMsg[],
  blocked: { orig: readonly string[]; port: readonly string[] },
  baseline: readonly string[],
): ConsoleCompare {
  const a = [
    ...orig.map(normalizeConsole),
    ...blocked.orig.map((u) => `blocked request: ${u.replace(/https?:\/\/127\.0\.0\.1:\d+/g, '<origin>')}`),
  ]
  const b = [
    ...port.map(normalizeConsole),
    ...blocked.port.map((u) => `blocked request: ${u.replace(/https?:\/\/127\.0\.0\.1:\d+/g, '<origin>')}`),
  ]
  const diffs: Diff[] = []
  const ma = multiset(a)
  const mb = multiset(b)
  for (const k of new Set([...ma.keys(), ...mb.keys()])) {
    const na = ma.get(k) ?? 0
    const nb = mb.get(k) ?? 0
    if (na !== nb)
      diffs.push({ check: 'console', kind: 'console', loc: k, orig: String(na), port: String(nb) })
  }
  const known = new Set(baseline)
  for (const k of ma.keys()) {
    if (!known.has(k))
      diffs.push({
        check: 'console',
        kind: 'console',
        loc: k,
        name: 'baseline-drift',
        orig: String(ma.get(k)),
        port: 'not in baseline',
      })
  }
  return { diffs, orig: a, port: b }
}
