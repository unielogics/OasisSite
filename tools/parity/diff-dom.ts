import { parseFragment, type DefaultTreeAdapterMap } from 'parse5'
import type { Diff } from './types'

type P5Node = DefaultTreeAdapterMap['childNode']
type P5Element = DefaultTreeAdapterMap['element']

export type DomNode =
  | { t: 'el'; tag: string; attrs: Array<[string, string]>; children: DomNode[]; tpl: string | null }
  | { t: 'text'; v: string }
  | { t: 'comment'; v: string }

export const hasTpl = (html: string): boolean => /\sdata-dc-tpl="/.test(html)

function convert(node: P5Node, keepTpl: boolean): DomNode | null {
  switch (node.nodeName) {
    case '#text':
      return { t: 'text', v: (node as DefaultTreeAdapterMap['textNode']).value }
    case '#comment': {
      // renderToString separates adjacent text nodes with `<!-- -->` so hydration can split them; the original
      // (client-rendered) has two text nodes and no comment there. Whitespace-only comments are dropped on both sides.
      const data = (node as DefaultTreeAdapterMap['commentNode']).data
      if (data.trim() === '') return null
      return { t: 'comment', v: data }
    }
    default: {
      const el = node as P5Element
      if (!('tagName' in el)) return null
      const attrs: Array<[string, string]> = []
      let tpl: string | null = null
      for (const a of el.attrs) {
        // data-sc-name: the original derives it from the file name. data-oasis-ready: the port's ready flag on #dc-root.
        if (a.name === 'data-sc-name' || a.name === 'data-oasis-ready') continue
        if (a.name === 'data-dc-tpl') {
          tpl = a.value
          if (!keepTpl) continue
        }
        attrs.push([a.name, a.value])
      }
      // Attribute order is not semantic (React sets props in object order); values, including the whole `style`
      // string, are compared byte for byte.
      attrs.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
      const kids = el.nodeName === 'template' ? [] : el.childNodes
      return {
        t: 'el',
        tag: el.tagName,
        attrs,
        tpl: keepTpl ? tpl : null,
        children: kids.map((c) => convert(c, keepTpl)).filter((c): c is DomNode => c !== null),
      }
    }
  }
}

/**
 * Parses #dc-root's outerHTML through parse5. data-sc-name and the port's data-oasis-ready flag are always dropped;
 * data-dc-tpl only when `keepTpl`.
 */
export function normalizeHtml(html: string, keepTpl: boolean): DomNode[] {
  const frag = parseFragment(html)
  return frag.childNodes.map((c) => convert(c as P5Node, keepTpl)).filter((c): c is DomNode => c !== null)
}

function sig(n: DomNode): string {
  return n.t === 'el' ? `${n.tag}${n.tpl !== null ? `@${n.tpl}` : ''}` : n.t === 'text' ? '#text' : '#comment'
}

function seg(n: DomNode, idx: number): string {
  return n.t === 'el' ? `${n.tag}[${idx}]${n.tpl !== null ? `#${n.tpl}` : ''}` : `#${n.t}[${idx}]`
}

function describe(n: DomNode): string {
  if (n.t !== 'el')
    return n.t === 'text' ? JSON.stringify(n.v.length > 60 ? n.v.slice(0, 57) + '...' : n.v) : `<!--${n.v}-->`
  const shown = n.attrs
    .filter(([k]) => k !== 'style')
    .slice(0, 3)
    .map(([k, v]) => `${k}="${v.length > 30 ? v.slice(0, 27) + '...' : v}"`)
  const size = countNodes(n) - 1
  return `<${n.tag}${shown.length ? ' ' + shown.join(' ') : ''}>${size ? ` (+${size} descendants)` : ''}`
}

function countNodes(n: DomNode): number {
  return n.t === 'el' ? 1 + n.children.reduce((a, c) => a + countNodes(c), 0) : 1
}

/** Aligns two sibling lists; returns index pairs for matched nodes and the unmatched remainder on each side. */
function align(a: DomNode[], b: DomNode[]): { pairs: Array<[number, number]>; reordered: boolean } {
  const sa = a.map(sig)
  const sb = b.map(sig)
  if (sa.length === sb.length && sa.every((s, i) => s === sb[i]))
    return { pairs: sa.map((_, i) => [i, i]), reordered: false }
  // Same multiset in a different order: a reorder. Pair the k-th occurrence of each signature.
  if (sa.length === sb.length && [...sa].sort().join('\u0000') === [...sb].sort().join('\u0000')) {
    const seen = new Map<string, number[]>()
    sb.forEach((s, i) => seen.set(s, [...(seen.get(s) ?? []), i]))
    const used = new Map<string, number>()
    const pairs: Array<[number, number]> = sa.map((s, i) => {
      const k = used.get(s) ?? 0
      used.set(s, k + 1)
      return [i, seen.get(s)![k]!]
    })
    return { pairs, reordered: true }
  }
  // General case: longest common subsequence on signatures (trim the common head and tail first).
  let head = 0
  while (head < sa.length && head < sb.length && sa[head] === sb[head]) head++
  let tail = 0
  while (
    tail < sa.length - head &&
    tail < sb.length - head &&
    sa[sa.length - 1 - tail] === sb[sb.length - 1 - tail]
  )
    tail++
  const ma = sa.slice(head, sa.length - tail)
  const mb = sb.slice(head, sb.length - tail)
  const dp: number[][] = Array.from({ length: ma.length + 1 }, () => new Array<number>(mb.length + 1).fill(0))
  for (let i = ma.length - 1; i >= 0; i--) {
    for (let j = mb.length - 1; j >= 0; j--) {
      dp[i]![j] = ma[i] === mb[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const pairs: Array<[number, number]> = []
  for (let i = 0; i < head; i++) pairs.push([i, i])
  let i = 0
  let j = 0
  while (i < ma.length && j < mb.length) {
    if (ma[i] === mb[j]) {
      pairs.push([head + i, head + j])
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++
    else j++
  }
  for (let k = 0; k < tail; k++) pairs.push([sa.length - tail + k, sb.length - tail + k])
  return { pairs, reordered: false }
}

export interface DomDiffOptions {
  /** stop collecting after this many diffs (the count is then a lower bound) */
  limit?: number
}

/** Structural diff of two normalised trees. Diff kinds: text, attr, element-added, element-removed, reorder. */
export function diffDom(a: DomNode[], b: DomNode[], opts: DomDiffOptions = {}): Diff[] {
  const limit = opts.limit ?? 5000
  const out: Diff[] = []
  const push = (d: Diff) => {
    if (out.length < limit) out.push(d)
  }

  const walk = (na: DomNode, nb: DomNode, path: string) => {
    if (out.length >= limit) return
    if (na.t === 'text' && nb.t === 'text') {
      if (na.v !== nb.v) push({ check: 'dom', kind: 'text', loc: path, orig: na.v, port: nb.v })
      return
    }
    if (na.t === 'comment' && nb.t === 'comment') {
      if (na.v !== nb.v)
        push({ check: 'dom', kind: 'text', loc: path, orig: `<!--${na.v}-->`, port: `<!--${nb.v}-->` })
      return
    }
    if (na.t !== 'el' || nb.t !== 'el') return
    const tpl = na.tpl ?? undefined
    const names = new Set([...na.attrs.map(([k]) => k), ...nb.attrs.map(([k]) => k)])
    const ma = new Map(na.attrs)
    const mb = new Map(nb.attrs)
    for (const name of [...names].sort()) {
      const va = ma.get(name)
      const vb = mb.get(name)
      if (va !== vb) push({ check: 'dom', kind: 'attr', loc: path, name, orig: va, port: vb, tpl })
    }
    const { pairs, reordered } = align(na.children, nb.children)
    if (reordered) {
      push({
        check: 'dom',
        kind: 'reorder',
        loc: path,
        name: 'children',
        orig: na.children.map(sig).join(','),
        port: nb.children.map(sig).join(','),
        tpl,
      })
    }
    const matchedA = new Set(pairs.map((p) => p[0]))
    const matchedB = new Set(pairs.map((p) => p[1]))
    na.children.forEach((c, i) => {
      if (!matchedA.has(i))
        push({
          check: 'dom',
          kind: 'element-removed',
          loc: `${path}/${seg(c, i)}`,
          orig: describe(c),
          tpl: c.t === 'el' ? (c.tpl ?? undefined) : undefined,
        })
    })
    nb.children.forEach((c, i) => {
      if (!matchedB.has(i))
        push({
          check: 'dom',
          kind: 'element-added',
          loc: `${path}/${seg(c, i)}`,
          port: describe(c),
          tpl: c.t === 'el' ? (c.tpl ?? undefined) : undefined,
        })
    })
    for (const [ia, ib] of [...pairs].sort((x, y) => x[0] - y[0])) {
      walk(na.children[ia]!, nb.children[ib]!, `${path}/${seg(na.children[ia]!, ia)}`)
    }
  }

  const roots = align(a, b)
  const matchedA = new Set(roots.pairs.map((p) => p[0]))
  const matchedB = new Set(roots.pairs.map((p) => p[1]))
  a.forEach((c, i) => {
    if (!matchedA.has(i)) push({ check: 'dom', kind: 'element-removed', loc: seg(c, i), orig: describe(c) })
  })
  b.forEach((c, i) => {
    if (!matchedB.has(i)) push({ check: 'dom', kind: 'element-added', loc: seg(c, i), port: describe(c) })
  })
  for (const [ia, ib] of roots.pairs) walk(a[ia]!, b[ib]!, seg(a[ia]!, ia))
  return out
}

/** Pretty one-node-per-line rendering for dom.diff.txt style artifacts and debugging. */
export function renderTree(nodes: DomNode[], indent = ''): string {
  return nodes
    .map((n) => {
      if (n.t === 'text') return `${indent}${JSON.stringify(n.v)}`
      if (n.t === 'comment') return `${indent}<!--${n.v}-->`
      const attrs = n.attrs.map(([k, v]) => ` ${k}="${v}"`).join('')
      const kids = n.children.length ? `\n${renderTree(n.children, indent + '  ')}\n${indent}` : ''
      return `${indent}<${n.tag}${attrs}>${kids}</${n.tag}>`
    })
    .join('\n')
}
