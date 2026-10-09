/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Bindings } from '../emit'

export type Mode = 'truthy' | 'falsy' | 'empty'

interface Trie {
  props: Map<string, Trie>
  list?: Trie
  idx: Map<number, Trie>
  path: string
}

const mk = (path: string): Trie => ({ props: new Map(), idx: new Map(), path })

/** `bays[].tasks[0].label` -> ['bays', '[]', 'tasks', '[0]', 'label'] */
function tokens(p: string): string[] {
  return [...p.matchAll(/\[(\d*)\]|([A-Za-z_$][A-Za-z0-9_$]*)/g)].map((m) =>
    m[2] !== undefined ? m[2] : `[${m[1]}]`,
  )
}

/**
 * Builds a generic vals object from a screen's bindings: strings for scalars, 2-element arrays for sc-for lists,
 * functions for handlers and refs, and `true` (truthy mode) or `false` (falsy mode) for sc-if conditions; in
 * `empty` mode every list is empty.
 */
export function buildVals(b: Bindings, mode: Mode): Record<string, any> {
  const rootTrie = mk('')
  for (const p of b.paths) {
    let t = rootTrie
    let acc = ''
    for (const tok of tokens(p)) {
      if (tok === '[]') {
        t.list ??= mk(acc + '[]')
        t = t.list
        acc += '[]'
      } else if (/^\[\d+\]$/.test(tok)) {
        const i = Number(tok.slice(1, -1))
        if (!t.idx.has(i)) t.idx.set(i, mk(acc + tok))
        t = t.idx.get(i)!
        acc += tok
      } else {
        if (!t.props.has(tok)) t.props.set(tok, mk(acc ? acc + '.' + tok : tok))
        t = t.props.get(tok)!
        acc = t.path
      }
    }
  }
  const handlers = new Set(b.handlers)
  const conds = new Set(b.conds)
  const gen = (t: Trie): any => {
    if (t.list) return mode === 'empty' ? [] : [gen(t.list), gen(t.list)]
    if (t.idx.size) {
      const arr: any[] = []
      for (const [i, c] of t.idx) arr[i] = gen(c)
      return arr
    }
    if (t.props.size) {
      const o: Record<string, any> = {}
      for (const [k, c] of t.props) o[k] = gen(c)
      return o
    }
    if (handlers.has(t.path)) return () => {}
    if (conds.has(t.path)) return mode !== 'falsy'
    return t.path || 'v'
  }
  return gen(rootTrie)
}
