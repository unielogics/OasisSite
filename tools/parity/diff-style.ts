import type { Diff, ElementSnap } from './types'

const fmtRect = (r: readonly number[]): string => r.map((n) => String(Math.round(n * 1000) / 1000)).join(',')

/**
 * Compares per-element computed style, bounding rect, scroll metrics, form-control state and pseudo-element style.
 * Elements are paired by key (data-dc-tpl id + occurrence, else DOM path under the paired parent). Rect tolerance is zero.
 */
export function diffElements(
  orig: readonly ElementSnap[],
  port: readonly ElementSnap[],
  opts: { limit?: number } = {},
): Diff[] {
  const limit = opts.limit ?? 20000
  const out: Diff[] = []
  const push = (d: Diff) => {
    if (out.length < limit) out.push(d)
  }
  const byKeyPort = new Map(port.map((e) => [e.key, e]))
  const byKeyOrig = new Map(orig.map((e) => [e.key, e]))
  for (const a of orig) {
    const b = byKeyPort.get(a.key)
    const tpl = a.tpl ?? undefined
    if (!b) {
      push({ check: 'style', kind: 'element-removed', loc: a.key, orig: a.path, tpl })
      continue
    }
    if (a.tag !== b.tag) {
      push({
        check: 'style',
        kind: 'element-removed',
        loc: a.key,
        orig: `${a.tag} ${a.path}`,
        port: `${b.tag} ${b.path}`,
        tpl,
      })
      continue
    }
    if (fmtRect(a.rect) !== fmtRect(b.rect) || a.rect.some((v, i) => v !== b.rect[i])) {
      push({
        check: 'style',
        kind: 'rect',
        loc: a.key,
        name: 'rect',
        orig: fmtRect(a.rect),
        port: fmtRect(b.rect),
        tpl,
      })
    }
    if (a.scroll.some((v, i) => v !== b.scroll[i])) {
      push({
        check: 'style',
        kind: 'rect',
        loc: a.key,
        name: 'scroll',
        orig: fmtRect(a.scroll),
        port: fmtRect(b.scroll),
        tpl,
      })
    }
    const props = new Set([...Object.keys(a.cs), ...Object.keys(b.cs)])
    for (const p of props) {
      if (a.cs[p] !== b.cs[p])
        push({ check: 'style', kind: 'style', loc: a.key, name: p, orig: a.cs[p], port: b.cs[p], tpl })
    }
    const pseudos = new Set([...Object.keys(a.pseudo ?? {}), ...Object.keys(b.pseudo ?? {})])
    for (const ps of pseudos) {
      const pa = a.pseudo?.[ps]
      const pb = b.pseudo?.[ps]
      if (!pa || !pb) {
        push({
          check: 'style',
          kind: 'style',
          loc: a.key,
          name: ps,
          orig: pa ? 'present' : 'absent',
          port: pb ? 'present' : 'absent',
          tpl,
        })
        continue
      }
      for (const p of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
        if (pa[p] !== pb[p])
          push({
            check: 'style',
            kind: 'style',
            loc: a.key,
            name: `${ps} ${p}`,
            orig: pa[p],
            port: pb[p],
            tpl,
          })
      }
    }
    if (a.ctl?.value !== b.ctl?.value || a.ctl?.checked !== b.ctl?.checked) {
      push({
        check: 'style',
        kind: 'value',
        loc: a.key,
        name: 'control',
        orig: a.ctl ? JSON.stringify(a.ctl) : 'none',
        port: b.ctl ? JSON.stringify(b.ctl) : 'none',
        tpl,
      })
    }
  }
  for (const b of port) {
    if (!byKeyOrig.has(b.key))
      push({ check: 'style', kind: 'element-added', loc: b.key, port: b.path, tpl: b.tpl ?? undefined })
  }
  return out
}
