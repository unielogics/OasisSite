import type { Diff, JsonValue } from './types'

const clip = (v: unknown): string | undefined => {
  if (v === undefined) return undefined
  const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v)
  return s.length > 240 ? s.slice(0, 237) + '...' : s
}

const isObj = (v: unknown): v is { [k: string]: JsonValue } =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** A long computed decimal such as "35.342997615581005%" (at least 9 fractional digits, optional % or px). */
const LONG_DECIMAL = /^(-?\d+\.\d{9,})(%|px)?$/

/**
 * Two computed floats that differ only in their last digits (live mode: the API gives integer cents and the class
 * divides, the design accumulated floats). Both must be long decimals with the same unit, and within `relative`.
 */
export function floatNoise(x: string, y: string, relative: number): boolean {
  const mx = LONG_DECIMAL.exec(x)
  const my = LONG_DECIMAL.exec(y)
  if (!mx || !my || (mx[2] ?? '') !== (my[2] ?? '')) return false
  const a = Number(mx[1])
  const b = Number(my[1])
  return Math.abs(a - b) <= relative * Math.max(1, Math.abs(a), Math.abs(b))
}

export interface DiffValsOptions {
  limit?: number
  /** forgive last-digit noise between long computed decimals (off by default; the fixture parity run never uses it) */
  floatNoise?: { relative: number }
  /** called with the JSON path of every pair forgiven that way */
  onForgiven?: (loc: string, orig: string, port: string) => void
}

/**
 * Ordered JSON diff of two serialised renderVals() results. Locators are JSON paths (`kpis[0].sub`). Object key ORDER is
 * compared (style objects are order-sensitive: React diffs and serialises them in key order): a different order is
 * reported as kind "reorder" at the object's path; value differences are kind "value".
 */
export function diffVals(a: JsonValue, b: JsonValue, opts: DiffValsOptions = {}): Diff[] {
  const limit = opts.limit ?? 5000
  const out: Diff[] = []
  const push = (d: Diff) => {
    if (out.length < limit) out.push(d)
  }
  const walk = (x: JsonValue | undefined, y: JsonValue | undefined, path: string) => {
    if (out.length >= limit) return
    if (x === undefined || y === undefined) {
      push({ check: 'vals', kind: 'value', loc: path || '$', orig: clip(x), port: clip(y) })
      return
    }
    if (Array.isArray(x) && Array.isArray(y)) {
      const n = Math.max(x.length, y.length)
      for (let i = 0; i < n; i++) walk(x[i], y[i], `${path}[${i}]`)
      return
    }
    if (isObj(x) && isObj(y)) {
      const ka = Object.keys(x)
      const kb = Object.keys(y)
      const common = ka.filter((k) => k in y)
      const commonB = kb.filter((k) => k in x)
      if (common.some((k, i) => k !== commonB[i])) {
        push({
          check: 'vals',
          kind: 'reorder',
          loc: path || '$',
          name: 'keys',
          orig: ka.join(','),
          port: kb.join(','),
        })
      }
      const keys = [...ka, ...kb.filter((k) => !(k in x))]
      for (const k of keys) walk(x[k], y[k], path ? `${path}.${k}` : k)
      return
    }
    if (
      opts.floatNoise &&
      typeof x === 'string' &&
      typeof y === 'string' &&
      floatNoise(x, y, opts.floatNoise.relative)
    ) {
      opts.onForgiven?.(path, x, y)
      return
    }
    if (x !== y || typeof x !== typeof y) {
      push({ check: 'vals', kind: 'value', loc: path || '$', orig: clip(x), port: clip(y) })
    }
  }
  walk(a, b, '')
  return out
}
