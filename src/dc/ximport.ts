/* eslint-disable @typescript-eslint/no-explicit-any */
// Build-time (and hydration-time) twin of the dc runtime's x-import support (src/external.ts + walkXImport in
// dc-runtime.js). An imported module is a plain script evaluated with the runtime's calling convention
// `(React, module, exports, require)`; the compiler wraps its source as an ES module so neither the prerender nor the
// browser needs eval. Resolution rules are the runtime's: `module.exports[name]`, else a window global the script
// created, else `window[name]`, else `module.exports.default`.
import { createElement, Fragment, isValidElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { cssToObj } from './css'

export interface ImportEntry {
  url: string
  mod: Record<string, any>
  globals: Record<string, any>
  error: string | null
}

export type ImportBody = (
  React: unknown,
  module: { exports: any },
  exports: any,
  require: () => object,
) => void

const win = (): Record<string, any> => (typeof window !== 'undefined' ? (window as any) : (globalThis as any))

/** Runs a wrapped import script once, capturing the window globals it created (functions only, like the runtime). */
export function runImport(url: string, React: unknown, body: ImportBody): ImportEntry {
  const w = win()
  const module = { exports: {} as Record<string, any> }
  const before = new Set(Object.keys(w))
  try {
    body(React, module, module.exports, () => ({}))
  } catch (e) {
    return {
      url,
      mod: {},
      globals: {},
      error: 'failed to load: ' + (e instanceof Error && e.message ? e.message : String(e)),
    }
  }
  const globals: Record<string, any> = {}
  for (const k of Object.keys(w)) {
    if (!before.has(k) && typeof w[k] === 'function') globals[k] = w[k]
  }
  return { url, mod: module.exports, globals, error: null }
}

const isCustomElementName = (n: string): boolean => !n.includes('.') && n.includes('-')

function isElementClass(g: unknown): boolean {
  try {
    return typeof g === 'function' && typeof HTMLElement !== 'undefined' && g.prototype instanceof HTMLElement
  } catch {
    return false
  }
}

function isRenderableType(g: any): boolean {
  if (typeof g === 'function') return !isElementClass(g)
  return typeof g === 'object' && g !== null && typeof g.$$typeof === 'symbol'
}

function resolveDottedPath(root: any, name: string): any {
  let cur = root
  for (const seg of name.split('.')) {
    if (cur == null) return undefined
    cur = cur[seg]
  }
  return cur
}

export interface Resolved {
  C: any
  error: string | null
}

/** `host.resolveExternal(url, name)` + `host.resolveExternalError(url, name)`. */
export function resolveExternal(entry: ImportEntry | null, name: string): Resolved {
  if (!entry) return { C: null, error: null }
  const { mod, globals } = entry
  const w = win()
  const C = (mod && mod[name]) || (globals && globals[name]) || w[name] || (mod && mod.default)
  if (typeof C === 'function') return { C, error: null }
  return {
    C: null,
    error: entry.error || 'no export named "' + name + '" (has: ' + Object.keys(mod).join(', ') + ')',
  }
}

/** `host.resolveExternalGlobal(url, name)`: a renderable global or, for a custom element name, the tag itself. */
export function resolveExternalGlobal(entry: ImportEntry | null, url: string, name: string): Resolved {
  const isCE = isCustomElementName(name)
  const w = win()
  const ce = typeof customElements !== 'undefined' ? customElements : null
  if (!url) {
    if (isCE) return { C: ce && ce.get(name) ? name : null, error: null }
    const g = resolveDottedPath(w, name)
    return { C: isRenderableType(g) ? g : null, error: null }
  }
  if (!entry) return { C: null, error: null }
  if (isCE && ce && ce.get(name)) return { C: name, error: null }
  const g = entry.globals[name] ?? resolveDottedPath(w, name)
  if (isRenderableType(g)) return { C: g, error: null }
  if (name.includes('.')) return { C: null, error: null }
  return { C: name, error: null }
}

const HOST_STYLE_PROPS = new Set([
  'position',
  'left',
  'right',
  'top',
  'bottom',
  'inset',
  'width',
  'height',
  'z-index',
  'transform',
])

/** `hostPositionStyle`: only the positioning keys of the x-import's style attribute reach the sc-host-x wrapper. */
export function hostPositionStyle(style: unknown): Record<string, string> | undefined {
  const all =
    typeof style === 'string'
      ? cssToObj(style)
      : style != null && typeof style === 'object'
        ? (style as Record<string, string>)
        : null
  if (!all) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(all)) {
    const kebab = k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
    if (HOST_STYLE_PROPS.has(kebab)) out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}

export const DISPLAY_CONTENTS: Readonly<Record<string, string>> = Object.freeze({ display: 'contents' })

/** The runtime's Placeholder (what an unresolved x-import renders). */
export function Placeholder(props: {
  name: string
  hintSize: string | null
  error: string | null
}): ReactElement {
  const [w, hgt] = (props.hintSize || '100%,60px').split(',')
  return createElement(
    'div',
    {
      className: 'sc-placeholder',
      style: { width: w!.trim(), height: hgt && hgt.trim() },
      title: props.name,
    },
    props.error
      ? createElement(
          'div',
          { className: 'sc-placeholder-error' },
          (props.name ? props.name + ': ' : '') + props.error,
        )
      : null,
  )
}

export const URL_BINDABLE_ERROR =
  'x-import `from` cannot contain {{ … }} — module URLs are resolved at parse time; use a literal URL'

export interface XImportSpec {
  /** the last url of `from` (empty when the component comes from the global scope only) */
  url: string
  /** import entry for `url` (null when nothing loaded, e.g. no `from`) */
  entry: ImportEntry | null
  hintSize: string | null
  /** `from` contained {{ }}: the runtime never resolves it */
  urlBindable: boolean
}

const evalName = (v: unknown): string => {
  const s = v == null ? '' : String(v)
  return s.includes('{{') ? '' : s
}

/** Renders one x-import the way walkXImport does: component or placeholder, props with dcProps spread, children. */
export function XI(
  spec: XImportSpec,
  globalName: unknown,
  exportName: unknown,
  props: Record<string, any>,
  /** the compiled children as one fragment (its props.children are the runtime's kids array), or null */
  children: ReactNode | null,
): ReactNode {
  const g = evalName(globalName)
  const name = g || evalName(exportName)
  let r: Resolved = { C: null, error: null }
  if (name && !spec.urlBindable) {
    r = g ? resolveExternalGlobal(spec.entry, spec.url, g) : resolveExternal(spec.entry, name)
  }
  if (!r.C) {
    const error = spec.urlBindable ? URL_BINDABLE_ERROR : r.error
    return createElement(Placeholder, { name, hintSize: spec.hintSize, error })
  }
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(props)) {
    if (k === 'dcProps') {
      if (v && typeof v === 'object') Object.assign(out, v)
      continue
    }
    out[k] = v
  }
  if (children !== null && children !== undefined) {
    const inner =
      isValidElement(children) && children.type === Fragment
        ? (children.props as { children?: ReactNode }).children
        : children
    const kids = inner === undefined || inner === null ? [] : Array.isArray(inner) ? inner : [inner]
    if (kids.length) out.children = kids
  }
  return createElement(r.C, out)
}
