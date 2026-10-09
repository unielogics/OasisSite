/**
 * Serialises the object returned by a screen's renderVals() into the JSON-safe, ORDER-PRESERVING form that the
 * parity harness diffs. The harness injects this function (via toString) into the original bundle's page, and the
 * port's `window.__oasisParity.getVals()` MUST return exactly `serializeVals(renderVals())` so both sides agree.
 *
 * It is dependency-free and self-contained on purpose: everything it uses is declared inside the function body.
 *
 * Format
 *   string | boolean | null      as is
 *   finite number                as is
 *   NaN / Infinity / -Infinity   the strings "NaN" / "Infinity" / "-Infinity"
 *   undefined                    "[undefined]"
 *   function                     "[fn]"
 *   symbol / bigint              "[symbol]" / "<digits>n"
 *   DOM node                     "[node]"
 *   cycle                        "[circular]"
 *   Date                         "[date] <ISO string>"
 *   array                        array of serialised items
 *   Map / Set                    { "$map": [[k, v], ...] } / { "$set": [v, ...] }
 *   React element                { "$el": <tag name | "[fragment]" | "[component]">, "key": <string|null>,
 *                                  "props": <serialised props>, "ref": "[ref]" (only when a ref is set) }
 *   any other object             plain object, own enumerable string keys in insertion order
 */
export function serializeVals(root: unknown): unknown {
  const REACT_ELEMENT = Symbol.for('react.element')
  const REACT_FRAGMENT = Symbol.for('react.fragment')
  const stack = new Set<object>()
  function ser(v: unknown, depth: number): unknown {
    if (v === null) return null
    switch (typeof v) {
      case 'string':
      case 'boolean':
        return v
      case 'number':
        return Number.isFinite(v) ? v : String(v)
      case 'undefined':
        return '[undefined]'
      case 'function':
        return '[fn]'
      case 'symbol':
        return '[symbol]'
      case 'bigint':
        return String(v) + 'n'
    }
    const o = v as Record<string, unknown>
    if (depth > 60) return '[depth]'
    if (typeof Node !== 'undefined' && v instanceof Node) return '[node]'
    if (stack.has(o)) return '[circular]'
    stack.add(o)
    try {
      if (Array.isArray(v)) return v.map((x) => ser(x, depth + 1))
      if (v instanceof Date) return '[date] ' + (isNaN(v.getTime()) ? 'invalid' : v.toISOString())
      if (v instanceof Map)
        return { $map: Array.from(v.entries()).map(([k, x]) => [ser(k, depth + 1), ser(x, depth + 1)]) }
      if (v instanceof Set) return { $set: Array.from(v.values()).map((x) => ser(x, depth + 1)) }
      if (o.$$typeof === REACT_ELEMENT) {
        const type = o.type
        const out: Record<string, unknown> = {
          $el: typeof type === 'string' ? type : type === REACT_FRAGMENT ? '[fragment]' : '[component]',
          key: o.key === null || o.key === undefined ? null : String(o.key),
          props: ser(o.props, depth + 1),
        }
        if (o.ref !== null && o.ref !== undefined) out.ref = '[ref]'
        return out
      }
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(o)) out[k] = ser(o[k], depth + 1)
      return out
    } finally {
      stack.delete(o)
    }
  }
  return ser(root, 0)
}
