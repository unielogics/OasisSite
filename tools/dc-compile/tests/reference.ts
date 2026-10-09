/* eslint-disable @typescript-eslint/no-explicit-any */
// A direct transliteration of the original runtime's walk* builders (walkText, walkFor, walkIf, walkElement,
// walkXImport, collectProps, compileAttr) over our parsed tree, using the original resolve()/cssToObj()/
// hostPositionStyle(). The compiled pages are checked against it: same vals in, same markup out.
import { createElement as h, Fragment, isValidElement } from 'react'
import type { ReactNode } from 'react'
import {
  Placeholder,
  resolveExternal,
  resolveExternalGlobal,
  URL_BINDABLE_ERROR,
} from '../../../src/dc/ximport'
import type { ImportEntry } from '../../../src/dc/ximport'
import { CAMEL_ATTR } from '../parse'
import type { ElNode, Node } from '../parse'
import { original } from './original-runtime'

const { resolve, EVENT_MAP, kebabToCamel, cssToObj, hostPositionStyle } = original

export interface RefOptions {
  tplIds: boolean
  /** createPseudoSheet-compatible numbering shared by the whole render */
  pseudoClass?: (pseudo: string, css: string) => string
  /** x-import url -> module entry (what loadExternal would have cached) */
  imports?: Map<string, ImportEntry>
}

function compileAttr(raw: string): (vals: any) => any {
  const whole = raw.match(/^\s*\{\{([\s\S]+?)\}\}\s*$/)
  if (whole) {
    const p = whole[1]!
    return (vals) => resolve(vals, p)
  }
  if (raw.includes('{{')) {
    const parts = raw.split(/\{\{([\s\S]+?)\}\}/g)
    return (vals) => parts.map((s, i) => (i & 1 ? (resolve(vals, s) ?? '') : s)).join('')
  }
  return () => raw
}

type Builder = (vals: any, key: number | string) => ReactNode

function collectProps(el: ElNode, kind: 'dom' | 'x-import', o: RefOptions) {
  const propGetters: [string, (vals: any) => any][] = []
  const pseudoClasses: string[] = []
  let hintSize: string | null = null
  for (const { name, value } of el.attrs) {
    if (name === 'sc-name' || name === 'data-dc-tpl') continue
    let key = name
    if (key.startsWith(CAMEL_ATTR)) key = kebabToCamel(key.slice(CAMEL_ATTR.length))
    if (key === 'hint-size') {
      hintSize = value
      continue
    }
    if (key.startsWith('style-')) {
      pseudoClasses.push(o.pseudoClass ? o.pseudoClass(key.slice(6), value) : 'scp?')
      continue
    }
    if (kind !== 'dom') {
      if (key.includes('-') && !(key.startsWith('aria-') || key.startsWith('data-'))) key = kebabToCamel(key)
    } else {
      if (key === 'class') key = 'className'
      else if (key === 'for') key = 'htmlFor'
      else if (key.startsWith('on')) key = EVENT_MAP[key] || 'on' + key[2]!.toUpperCase() + key.slice(3)
    }
    propGetters.push([key, compileAttr(value)])
  }
  return { propGetters, pseudoClasses, hintSize }
}

function walkChildren(nodes: Node[], o: RefOptions): Builder[] {
  return nodes.map((n) => walk(n, o)).filter((b): b is Builder => b != null)
}

function walk(n: Node, o: RefOptions): Builder | null {
  if (n.kind === 'text') return walkText(n.value)
  switch (n.tag) {
    case 'sc-for':
      return walkFor(n, o)
    case 'sc-if':
      return walkIf(n, o)
    case 'x-import':
      return walkXImport(n, o)
    case 'sc-helmet':
      return () => null
    default:
      return walkElement(n, o)
  }
}

function walkText(txt: string): Builder | null {
  if (!txt.includes('{{')) {
    if (!txt.trim() && !txt.includes(' ')) return null
    return () => txt
  }
  const parts = txt.split(/\{\{([\s\S]+?)\}\}/g)
  return (vals, key) =>
    h(
      Fragment,
      { key },
      ...parts.map((p, i) => {
        if (!(i & 1)) return p
        const v = resolve(vals, p)
        if (v === undefined) return null
        if (isValidElement(v) || Array.isArray(v)) return h(Fragment, { key: i }, v as ReactNode)
        if (v === null || typeof v === 'boolean') return null
        return h('span', { key: i, className: 'sc-interp' }, String(v))
      }),
    )
}

function walkFor(el: ElNode, o: RefOptions): Builder {
  const listGet = compileAttr(el.attrs.find((a) => a.name === 'list')?.value || '')
  const asName = el.attrs.find((a) => a.name === 'as')?.value || 'item'
  const kids = walkChildren(el.children, o)
  return (vals, key) => {
    let list = listGet(vals)
    if (!Array.isArray(list)) list = []
    return h(
      Fragment,
      { key },
      list.map((item: unknown, i: number) => {
        const sub = { ...vals, [asName]: item, $index: i }
        return h(
          Fragment,
          { key: i },
          kids.map((b, j) => b(sub, j)),
        )
      }),
    )
  }
}

function walkIf(el: ElNode, o: RefOptions): Builder {
  const valGet = compileAttr(el.attrs.find((a) => a.name === 'value')?.value || '')
  const kids = walkChildren(el.children, o)
  return (vals, key) =>
    valGet(vals)
      ? h(
          Fragment,
          { key },
          kids.map((b, j) => b(vals, j)),
        )
      : null
}

function walkXImport(el: ElNode, o: RefOptions): Builder {
  const get = (n: string) => el.attrs.find((a) => a.name === n)?.value
  const globalNameGet = compileAttr(get('component-from-global-scope') || '')
  const exportNameGet = compileAttr(get('component') || get('name') || '')
  const fromRaw = get('from') || (get('component-from-global-scope') ? '' : get('src') || get('import') || '')
  const urls = fromRaw.trim() ? fromRaw.trim().split(/\s+/) : []
  const url = urls.length ? urls[urls.length - 1]! : ''
  const styleRaw = get('style')
  const styleGet = styleRaw != null ? compileAttr(styleRaw) : null
  const rest: ElNode = { ...el, attrs: el.attrs.filter((a) => a.name !== 'style') }
  const { propGetters, hintSize } = collectProps(rest, 'x-import', o)
  const hasContent = el.children.some((c) => c.kind === 'el' || c.value.trim() !== '')
  const kids = hasContent ? walkChildren(el.children, o) : []
  const urlBindable = fromRaw.includes('{{')
  const evalName = (g: (v: any) => any, vals: any) => {
    const v = g(vals)
    const s = v == null ? '' : String(v)
    return s.includes('{{') ? '' : s
  }
  return (vals, key) => {
    const globalName = evalName(globalNameGet, vals)
    const name = globalName || evalName(exportNameGet, vals)
    const entry = o.imports?.get(url) ?? null
    const r =
      !name || urlBindable
        ? { C: null, error: null }
        : globalName
          ? resolveExternalGlobal(entry, url, globalName)
          : resolveExternal(entry, name)
    const hostStyle = styleGet ? hostPositionStyle(styleGet(vals)) : undefined
    const wrapper: Record<string, any> = { key, className: 'sc-host-x' }
    if (o.tplIds) wrapper['data-dc-tpl'] = String(el.tpl)
    wrapper.style = hostStyle || { display: 'contents' }
    if (!r.C) {
      const error = urlBindable ? URL_BINDABLE_ERROR : r.error
      return h('div', wrapper, h(Placeholder, { name, hintSize, error }))
    }
    const props: Record<string, any> = {}
    for (const [k, g] of propGetters) {
      if (k === 'component' || k === 'componentFromGlobalScope' || k === 'from') continue
      const v = g(vals)
      if (k === 'dcProps') {
        if (v && typeof v === 'object') Object.assign(props, v)
        continue
      }
      props[k] = v
    }
    if (kids.length) props.children = kids.map((b, j) => b(vals, j))
    return h('div', wrapper, h(r.C, props))
  }
}

function walkElement(el: ElNode, o: RefOptions): Builder {
  const { propGetters, pseudoClasses } = collectProps(el, 'dom', o)
  const kids = walkChildren(el.children, o)
  return (vals, key) => {
    const props: Record<string, any> = { key }
    if (o.tplIds) props['data-dc-tpl'] = String(el.tpl)
    for (const [k, g] of propGetters) {
      let v = g(vals)
      if (k === 'style' && typeof v === 'string') v = cssToObj(v)
      if ((k === 'value' || k === 'checked') && v === undefined) v = k === 'checked' ? false : ''
      props[k] = v
    }
    if (pseudoClasses.length) props.className = [props.className, ...pseudoClasses].filter(Boolean).join(' ')
    return h(el.tag, props, ...kids.map((b, j) => b(vals, j)))
  }
}

/** What the original runtime would render for a parsed template. */
export function interpret(
  nodes: Node[],
  vals: Record<string, unknown>,
  tplIds = false,
  o: Partial<RefOptions> = {},
): ReactNode {
  const opts: RefOptions = { tplIds, ...o }
  const builders = walkChildren(nodes, opts)
  return h(Fragment, null, ...builders.map((b, i) => b(vals, i)))
}
