/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { renderToStaticMarkup } from 'react-dom/server'
import { PseudoSheet } from '../../../src/dc/pseudo'
import type { ImportEntry } from '../../../src/dc/ximport'
import { Emitter } from '../emit'
import type { Bindings, EmitOptions } from '../emit'
import { parseTemplate } from '../parse'
import { interpret } from './reference'
import { fakeSheetDoc, original, root } from './original-runtime'
export { fixtureExtracted } from '../../intake/fixtures'

export const tmpDir = path.join(root, '.tmp-snippets')

export function compileSnippet(
  html: string,
  opts: Partial<EmitOptions> = {},
): { tsx: string; bindings: Bindings; pseudo: PseudoSheet } {
  const { nodes, tplCount } = parseTemplate(html)
  const em = new Emitter({ page: 't', tplIds: false, allowComplexExpr: false, ...opts })
  const r = em.emit(nodes, ['// test'], { slug: 't', route: '/t', name: 'T', variant: 'prod', tplCount })
  return { ...r, pseudo: em.pseudo }
}

/** Just the JSX body of the emitted render function, for readable assertions. */
export function bodyOf(tsx: string): string {
  const a = tsx.indexOf('    <>\n')
  const b = tsx.lastIndexOf('    </>')
  return tsx
    .slice(a + 8, b)
    .split('\n')
    .map((l) => l.replace(/^ {6}/, ''))
    .join('\n')
    .trim()
}

/** Writes a snippet module (plus optional import wrappers) and renders it with the given vals. */
export async function renderSnippet(
  html: string,
  vals: Record<string, unknown>,
  opts: Partial<EmitOptions> = {},
  extraFiles: Record<string, string> = {},
): Promise<string> {
  const { tsx } = compileSnippet(html, opts)
  const dir = path.join(
    tmpDir,
    's' +
      crypto
        .createHash('sha1')
        .update(tsx + JSON.stringify(extraFiles))
        .digest('hex')
        .slice(0, 12),
  )
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, text] of Object.entries(extraFiles)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), text)
  }
  const file = path.join(dir, 'snippet.tsx')
  fs.writeFileSync(file, tsx)
  const mod = await import(/* @vite-ignore */ file)
  return renderToStaticMarkup(mod.default(vals, { name: 'T' }))
}

/** The original runtime's rendering of the same snippet (pseudo numbering from the original createPseudoSheet). */
export function referenceMarkup(
  html: string,
  vals: Record<string, unknown>,
  tplIds = false,
  imports?: Map<string, ImportEntry>,
): { html: string; rules: string[] } {
  const { doc, rules } = fakeSheetDoc()
  const pseudoClass = original.createPseudoSheet(doc)
  const html2 = renderToStaticMarkup(
    interpret(parseTemplate(html).nodes, vals, tplIds, { pseudoClass, imports }) as any,
  )
  return { html: html2, rules }
}
