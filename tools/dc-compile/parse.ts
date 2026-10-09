import { parseFragment } from 'parse5'
import type { DefaultTreeAdapterMap } from 'parse5'
import { CompileError } from './errors'

export const CAMEL_ATTR = 'sc-camel-'

export interface Attr {
  name: string
  value: string
}
export interface ElNode {
  kind: 'el'
  tag: string
  /** Pre-order element index as stamped by the dc runtime (data-dc-tpl). -1 for nodes synthesised by patches. */
  tpl: number
  attrs: Attr[]
  children: Node[]
}
export interface TextNode {
  kind: 'text'
  value: string
  /** Set by the patch layer: `{{= path }}` raw interpolation is only legal in patch-supplied text. */
  allowRaw?: boolean
}
export type Node = ElNode | TextNode

const RAW_WRAP: Record<string, string> = {
  select: 'sc-raw-select',
  table: 'sc-raw-table',
  tbody: 'sc-raw-tbody',
  thead: 'sc-raw-thead',
  tfoot: 'sc-raw-tfoot',
  tr: 'sc-raw-tr',
  td: 'sc-raw-td',
  th: 'sc-raw-th',
  caption: 'sc-raw-caption',
}
const RAW_UNWRAP = Object.fromEntries(Object.entries(RAW_WRAP).map(([k, v]) => [v, k]))
const ATTRS = `(?:[^>"']|"[^"]*"|'[^']*')*`
const IMPORT_SELF_CLOSE_RE = new RegExp('<(x-import|dc-import)(' + ATTRS + ')/>', 'gi')
const CAMEL_ATTR_RE = /(\s)([a-z]+[A-Z][A-Za-z0-9]*)(\s*=)/g

/**
 * The runtime's encodeCase pre-pass: self-closing x-import/dc-import expanded, helmet -> sc-helmet, camelCase
 * attributes -> sc-camel-*, raw-wrapped table tags.
 */
export function encodeCase(html: string): string {
  html = html.replace(IMPORT_SELF_CLOSE_RE, (_, t: string, a: string) => '<' + t + a + '></' + t + '>')
  html = html.replace(/<helmet(\s|>)/gi, '<sc-helmet$1')
  html = html.replace(/<\/helmet\s*>/gi, '</sc-helmet>')
  html = html.replace(
    CAMEL_ATTR_RE,
    (_, sp: string, name: string, eq: string) =>
      sp + CAMEL_ATTR + name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()) + eq,
  )
  for (const [real, alias] of Object.entries(RAW_WRAP)) {
    html = html.replace(new RegExp('(</?)' + real + '(?=[\\s>])', 'gi'), '$1' + alias)
  }
  return html
}

type P5Node = DefaultTreeAdapterMap['node']

/**
 * parse5.parseFragment with the default <template> context (what `<template>.innerHTML` does in the runtime),
 * then a pre-order tplId over EVERY element, sc-if / sc-for / sc-helmet / x-import and the helmet's children included.
 * Comments are dropped, text is kept verbatim.
 */
export function parseTemplate(html: string): { nodes: Node[]; tplCount: number } {
  const frag = parseFragment(encodeCase(html))
  let n = 0
  const convert = (p: P5Node): Node | null => {
    if (p.nodeName === '#text') return { kind: 'text', value: (p as DefaultTreeAdapterMap['textNode']).value }
    if (p.nodeName === '#comment') return null
    if (!('tagName' in p)) return null
    const el = p as DefaultTreeAdapterMap['element']
    if (el.tagName === 'template')
      throw new CompileError('<template> elements are not supported in dc templates')
    const tpl = n++
    const tag = RAW_UNWRAP[el.tagName] ?? el.tagName
    const children: Node[] = []
    for (const c of el.childNodes) {
      const cc = convert(c)
      if (cc) children.push(cc)
    }
    return { kind: 'el', tag, tpl, attrs: el.attrs.map((a) => ({ name: a.name, value: a.value })), children }
  }
  const nodes: Node[] = []
  for (const c of frag.childNodes) {
    const cc = convert(c)
    if (cc) nodes.push(cc)
  }
  return { nodes, tplCount: n }
}

export function walkEls(
  nodes: Node[],
  f: (el: ElNode, parent: ElNode | null) => void,
  parent: ElNode | null = null,
): void {
  for (const nd of nodes) {
    if (nd.kind !== 'el') continue
    f(nd, parent)
    walkEls(nd.children, f, nd)
  }
}

export const textOf = (nodes: Node[]): string =>
  nodes.map((c) => (c.kind === 'text' ? c.value : textOf(c.children))).join('')
