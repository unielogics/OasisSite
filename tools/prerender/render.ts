/* eslint-disable @typescript-eslint/no-explicit-any */
// Renders one compiled page to static markup: the inner HTML of #dc-root (renderToString of <DCHost/>, so the
// client can hydrate it) plus the serialised renderVals() for the parity variant. Console output during the render
// is captured: an error fails the build, warnings are reported.
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { DCHost } from '../../src/dc/DCHost'
import { serializeVals } from '../../src/dc/serialize'
import type { DCLogicCtor, DCRender } from '../../src/dc/types'
import type { CompiledPageMeta } from '../dc-compile/compile'
import { installShims } from './shims'
import type { ShimOptions } from './shims'

export interface RenderInput {
  meta: CompiledPageMeta
  /** directory holding <slug>.tsx and <slug>.logic.js (the compiler's --out) */
  generatedDir: string
  userProps: Record<string, unknown>
  shims: Omit<ShimOptions, 'route'>
}

export interface Rendered {
  slug: string
  /** inner HTML of #dc-root */
  html: string
  vals: unknown
  warnings: string[]
  errors: string[]
  /** React's text-boundary comments (adjacent text nodes); informational, hydration needs them */
  textBoundaries: number
  storageWrites: Record<string, string>
}

export async function loadPageModules(
  generatedDir: string,
  slug: string,
): Promise<{ render: DCRender; Logic: DCLogicCtor }> {
  const tsx = await import(/* @vite-ignore */ pathToFileURL(path.join(generatedDir, `${slug}.tsx`)).href)
  const logic = await import(
    /* @vite-ignore */ pathToFileURL(path.join(generatedDir, `${slug}.logic.js`)).href
  )
  if (typeof tsx.default !== 'function') throw new Error(`${slug}.tsx has no default render export`)
  if (typeof logic.default !== 'function')
    throw new Error(`${slug}.logic.js did not define a Component class`)
  return { render: tsx.default as DCRender, Logic: logic.default as DCLogicCtor }
}

export async function renderPage(input: RenderInput): Promise<Rendered> {
  const { meta } = input
  const handle = installShims({ ...input.shims, route: meta.route })
  const warnings: string[] = []
  const errors: string[] = []
  const origWarn = console.warn
  const origError = console.error
  console.warn = (...a: unknown[]) => warnings.push(a.map(String).join(' '))
  console.error = (...a: unknown[]) =>
    errors.push(a.map((x) => (x instanceof Error ? (x.stack ?? x.message) : String(x))).join(' '))
  try {
    const { render, Logic } = await loadPageModules(input.generatedDir, meta.slug)
    let host: DCHost | null = null
    const ref = (h: DCHost | null) => {
      host = h
    }
    const element = createElement(DCHost as any, {
      meta: { name: meta.name, slug: meta.slug },
      Logic,
      render,
      userProps: input.userProps,
      ref,
    })
    const html = renderToString(element)
    if (html.includes('role="alert"') && html.includes('This page failed to load')) {
      errors.push(`${meta.slug}: the host rendered its error card (see the errors above)`)
    }
    // renderToString does not attach refs; rebuild the vals the way DCHost does for the parity record
    void host
    let vals: unknown = null
    try {
      const logic = new Logic(input.userProps)
      vals = serializeVals({ ...input.userProps, ...(logic.renderVals() || {}) })
    } catch (e) {
      errors.push(
        `${meta.slug}: renderVals for the parity record threw: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    return {
      slug: meta.slug,
      html,
      vals,
      warnings,
      errors,
      textBoundaries: (html.match(/<!-- -->/g) ?? []).length,
      storageWrites: handle.storageWrites,
    }
  } finally {
    console.warn = origWarn
    console.error = origError
    handle.restore()
  }
}
