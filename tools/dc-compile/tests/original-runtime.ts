/* eslint-disable @typescript-eslint/no-explicit-any */
// Pulls pieces of the ORIGINAL dc runtime (design/extracted/runtime/dc-runtime.js) out of the bundle so tests can
// compare the port against the real implementation rather than against a re-typed copy.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
export const runtimeFile = path.join(root, 'design/extracted/runtime/dc-runtime.js')
const src = fs.readFileSync(runtimeFile, 'utf8')

function slice(from: string, to: string): string {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`runtime slice ${from}..${to} not found`)
  return src.slice(a, b)
}

export const original = new Function(
  [
    slice('// src/expr.ts', '// src/encode.ts'),
    slice('var EVENT_MAP', 'var ATTRS'),
    slice('function kebabToCamel', 'function compileAttr'),
    slice('  var HOST_STYLE_PROPS', '  function compileTemplate'),
    slice('// src/pseudo.ts', '// src/registry.ts'),
    'return { resolve, EVENT_MAP, kebabToCamel, cssToObj, hostPositionStyle, scanUnquotedUrl, stripComments, importantify, createPseudoSheet }',
  ].join('\n'),
)() as {
  resolve(vals: any, src: string): any
  EVENT_MAP: Record<string, string>
  kebabToCamel(s: string): string
  cssToObj(css: string): Record<string, string>
  hostPositionStyle(style: unknown): Record<string, string> | undefined
  scanUnquotedUrl(css: string, i: number): number
  stripComments(css: string): string
  importantify(css: string): string
  createPseudoSheet(doc: any): (pseudo: string, css: string) => string
}

/** A stand-in document for createPseudoSheet that records the inserted rules (insertRule order). */
export function fakeSheetDoc(): { doc: any; rules: string[] } {
  const rules: string[] = []
  const sheet = { cssRules: rules, insertRule: (rule: string, index: number) => rules.splice(index, 0, rule) }
  const doc = { createElement: () => ({ sheet }), head: { appendChild: () => {} } }
  return { doc, rules }
}
