// Runtime helpers imported by the compiled pages (.generated/*.tsx). They reproduce the semantics of the dc runtime's
// walkText / walkFor / compileAttr / collectProps, see docs/compiler.md. Keep them small and side-effect free.
import { Fragment, createElement, isValidElement } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { cssToObj } from './css'
import { hostPositionStyle as hostPositionStyleOf } from './ximport'
import type { DCRenderCtx } from './types'

export { cssToObj, kebabToCamel } from './css'
export { XI, DISPLAY_CONTENTS, hostPositionStyle } from './ximport'
export type { ImportEntry, XImportSpec } from './ximport'

/* eslint-disable @typescript-eslint/no-explicit-any */

export const NOOP = (): void => {}

/** `style` binding: strings go through cssToObj, objects pass straight to React (as the runtime does). */
export function css(v: unknown): CSSProperties | undefined {
  return (typeof v === 'string' ? cssToObj(v) : v) as CSSProperties | undefined
}

/** Mixed-attribute interpolation: `resolve(x) ?? ''` then joined, i.e. String(x ?? ''). */
export const m = (x: unknown): string => String(x ?? '')

/** Pseudo classes: `[props.className, ...pseudoClasses].filter(Boolean).join(' ')` (pcs is the pre-joined list). */
export const pc = (cls: unknown, pcs: string): string => [cls, pcs].filter(Boolean).join(' ')

/** x-import host style: the positioning subset of a bound style, else display:contents. */
export function hs(v: unknown): Record<string, string> {
  const s = hostPositionStyleOf(v)
  return s || { display: 'contents' }
}

function warnsEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' || process.env.OASIS_PARITY === '1'
}

const warned = new Set<string>()
function warnOnce(ctx: DCRenderCtx | undefined, what: string): void {
  if (!warnsEnabled()) return
  const key = (ctx?.name ?? '?') + '\0' + what
  if (warned.has(key)) return
  warned.add(key)
  console.warn(`[oasis] ${ctx?.name ?? 'template'}: ${what}`)
}

/** Test hook: forget which warnings were already printed. */
export function resetWarnings(): void {
  warned.clear()
}

/** sc-for list: anything that is not an array renders nothing (warning unless null/undefined). */
export function asArray(v: unknown, src?: string, ctx?: DCRenderCtx): any[] {
  if (Array.isArray(v)) return v
  if (v !== undefined && v !== null)
    warnOnce(ctx, `sc-for list="${src ?? '?'}" is not an array (${typeof v})`)
  return []
}

/**
 * Text interpolation `{{ expr }}`:
 *   undefined -> nothing (+ one dev warning); React element / array -> Fragment; null / boolean -> nothing;
 *   everything else, including '' and 0, -> <span class="sc-interp">String(v)</span>.
 */
export function I(v: unknown, src?: string, ctx?: DCRenderCtx): ReactNode {
  if (v === undefined) {
    warnOnce(ctx, `{{ ${src ?? '?'} }} never resolved — rendered as empty`)
    return null
  }
  if (isValidElement(v) || Array.isArray(v)) return createElement(Fragment, null, v as ReactNode)
  if (v === null || typeof v === 'boolean') return null
  return createElement('span', { className: 'sc-interp' }, String(v))
}

// ---- resolve(): verbatim port of the dc runtime's expression resolver. Only used by templates compiled with
// --allow-complex-expr; the Oasis designs use nothing but identifiers and dotted paths.
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*/
const NUMBER_RE = /^-?\d+(\.\d+)?$/

export function resolve(vals: any, src: string): any {
  const expr = String(src).trim()
  if (!expr) return undefined
  if (expr[0] === '(' && expr[expr.length - 1] === ')' && parensWrapWhole(expr)) {
    return resolve(vals, expr.slice(1, -1))
  }
  const eq = findTopLevelEquality(expr)
  if (eq) {
    const lv = resolve(vals, expr.slice(0, eq.index))
    const rv = resolve(vals, expr.slice(eq.index + eq.op.length))
    switch (eq.op) {
      case '===':
        return lv === rv
      case '!==':
        return lv !== rv
      case '==':
        return lv == rv
      default:
        return lv != rv
    }
  }
  if (expr[0] === '!') return !resolve(vals, expr.slice(1))
  if (expr === 'true') return true
  if (expr === 'false') return false
  if (expr === 'null') return null
  if (expr === 'undefined') return undefined
  if (NUMBER_RE.test(expr)) return Number(expr)
  if (expr.length >= 2 && (expr[0] === '"' || expr[0] === "'") && expr[expr.length - 1] === expr[0]) {
    return expr.slice(1, -1)
  }
  return resolvePath(vals, expr)
}

function parensWrapWhole(expr: string): boolean {
  let depth = 0
  for (let i = 0; i < expr.length - 1; i++) {
    if (expr[i] === '(') depth++
    else if (expr[i] === ')') {
      depth--
      if (depth === 0) return false
    }
  }
  return true
}

function findTopLevelEquality(expr: string): { index: number; op: string } | null {
  let depth = 0
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]
    if (c === '[' || c === '(') depth++
    else if (c === ']' || c === ')') depth--
    else if (depth === 0 && (c === '=' || c === '!') && expr[i + 1] === '=') {
      if (i > 0 && (expr[i - 1] === '=' || expr[i - 1] === '!')) continue
      if (!expr.slice(0, i).trim()) continue
      const op = expr[i + 2] === '=' ? c + '==' : c + '='
      return { index: i, op }
    }
  }
  return null
}

function resolvePath(vals: any, expr: string): any {
  const head = expr.match(IDENT_RE)
  if (!head) return undefined
  let cur = vals == null ? undefined : vals[head[0]]
  let i = head[0].length
  while (i < expr.length) {
    if (expr[i] === '.') {
      const mm = expr.slice(i + 1).match(IDENT_RE) || expr.slice(i + 1).match(/^\d+/)
      if (!mm) return undefined
      cur = cur == null ? undefined : cur[mm[0]]
      i += 1 + mm[0].length
    } else if (expr[i] === '[') {
      let depth = 1
      let j = i + 1
      while (j < expr.length && depth > 0) {
        if (expr[j] === '[') depth++
        else if (expr[j] === ']') {
          depth--
          if (depth === 0) break
        }
        j++
      }
      if (depth !== 0) return undefined
      const key = resolve(vals, expr.slice(i + 1, j))
      cur = cur == null ? undefined : cur[key]
      i = j + 1
    } else {
      return undefined
    }
  }
  return cur
}

export const R = resolve
