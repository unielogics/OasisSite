// In-page collectors. Everything inside these functions runs in the browser (Playwright serialises them), so they may
// only use browser globals and their own arguments.
import type { ElementSnap } from './types'

/** Curated layout and paint properties compared for every element at every step (the full set only at "initial"). */
export const CURATED_PROPS: readonly string[] = [
  'display',
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'z-index',
  'float',
  'box-sizing',
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-top-style',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
  'flex-direction',
  'flex-wrap',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'align-items',
  'align-self',
  'align-content',
  'justify-content',
  'justify-items',
  'justify-self',
  'row-gap',
  'column-gap',
  'order',
  'grid-template-columns',
  'grid-template-rows',
  'grid-column-start',
  'grid-column-end',
  'overflow-x',
  'overflow-y',
  'visibility',
  'opacity',
  'transform',
  'transform-origin',
  'box-shadow',
  'filter',
  'backdrop-filter',
  'color',
  'background-color',
  'background-image',
  'background-size',
  'background-position',
  'background-repeat',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-feature-settings',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-transform',
  'text-overflow',
  'text-decoration-line',
  'white-space',
  'word-break',
  'overflow-wrap',
  'vertical-align',
  'cursor',
  'pointer-events',
  'user-select',
  'outline-style',
  'outline-width',
  'outline-color',
  'touch-action',
]

const PSEUDO_PROPS = [
  'content',
  'display',
  'color',
  'background-color',
  'opacity',
  'width',
  'height',
  'position',
]

/**
 * Returns JSON text (Playwright's own result serialiser is an order of magnitude slower on 10 MB payloads). `names` is the
 * property list; every element's `cs` is an array of values parallel to it.
 */
export function collectElements(opts: {
  props: readonly string[]
  full: boolean
  pseudoProps: readonly string[]
  /** pair elements by DOM position only (live mode: the live build carries no data-dc-tpl, so neither side may use it) */
  ignoreTpl?: boolean
}): string {
  type RawSnap = Omit<ElementSnap, 'cs'> & { cs: string[] }
  const out: RawSnap[] = []
  const root = document.getElementById('dc-root')
  let names: string[] = [...opts.props]
  if (opts.full) {
    const cs0 = getComputedStyle(document.documentElement)
    names = []
    for (let i = 0; i < cs0.length; i++) names.push(cs0[i]!)
    for (const p of opts.props) if (!names.includes(p)) names.push(p)
  }
  if (!root) return JSON.stringify({ names, els: out })

  const readStyle = (el: Element, all: boolean): string[] => {
    const cs = getComputedStyle(el)
    const list = all ? names : opts.props
    return list.map((p) => cs.getPropertyValue(p))
  }

  const record = (el: Element, key: string, path: string, tpl: string | null, withPseudo: boolean) => {
    const r = el.getBoundingClientRect()
    const snap: RawSnap = {
      key,
      tag: el.tagName.toLowerCase(),
      tpl,
      path,
      rect: [r.x, r.y, r.width, r.height],
      scroll: [el.scrollWidth, el.scrollHeight, el.clientWidth, el.clientHeight, el.scrollLeft, el.scrollTop],
      cs: readStyle(el, withPseudo && opts.full),
    }
    if (withPseudo) {
      const pseudo: Record<string, Record<string, string>> = {}
      const names = ['::before', '::after']
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) names.push('::placeholder')
      for (const name of names) {
        const ps = getComputedStyle(el, name)
        const content = ps.getPropertyValue('content')
        if (name === '::placeholder' || (content !== 'none' && content !== 'normal' && content !== '')) {
          const rec: Record<string, string> = {}
          for (const p of opts.pseudoProps) rec[p] = ps.getPropertyValue(p)
          pseudo[name] = rec
        }
      }
      if (Object.keys(pseudo).length) snap.pseudo = pseudo
    }
    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
    ) {
      snap.ctl = { value: el.value, checked: el instanceof HTMLInputElement ? el.checked : false }
    }
    out.push(snap)
  }

  record(document.documentElement, 'html', 'html', null, false)
  record(document.body, 'body', 'html/body', null, false)

  const tplSeen = new Map<string, number>()
  const walk = (el: Element, parentKey: string, parentPath: string, elemIdx: number, tagIdx: number) => {
    const tpl = opts.ignoreTpl ? null : el.getAttribute('data-dc-tpl')
    const tag = el.tagName.toLowerCase()
    const path = `${parentPath}/${tag}[${elemIdx}]`
    let key: string
    if (tpl !== null) {
      const n = tplSeen.get(tpl) ?? 0
      tplSeen.set(tpl, n + 1)
      key = `t${tpl}#${n}`
    } else {
      key = `${parentKey}>${tag}[${tagIdx}]`
    }
    record(el, key, path, tpl, true)
    const tagCount = new Map<string, number>()
    let idx = 0
    for (const child of Array.from(el.children)) {
      const ct = child.tagName.toLowerCase()
      const ti = tagCount.get(ct) ?? 0
      tagCount.set(ct, ti + 1)
      walk(child, key, path, idx++, ti)
    }
  }
  walk(root, 'root', 'dc-root', 0, 0)
  return JSON.stringify({ names, els: out })
}

/** Decodes collectElements() output into ElementSnap records (html/body only carry the curated subset). */
export function decodeElements(json: string, curated: readonly string[]): ElementSnap[] {
  const { names, els } = JSON.parse(json) as {
    names: string[]
    els: Array<Omit<ElementSnap, 'cs'> & { cs: string[] }>
  }
  return els.map((e) => {
    const list = e.cs.length === names.length ? names : curated
    const cs: Record<string, string> = {}
    list.forEach((p, i) => {
      cs[p] = e.cs[i]!
    })
    return { ...e, cs }
  })
}

export const PSEUDO_PROP_LIST: readonly string[] = PSEUDO_PROPS

export function readRootHtml(): string {
  const root = document.getElementById('dc-root')
  return root ? root.outerHTML : ''
}

/** Resolves once the event loop and React have flushed; MessageChannel is not controlled by the fake clock. */
export async function settleInPage(): Promise<void> {
  const tick = () =>
    new Promise<void>((resolve) => {
      const c = new MessageChannel()
      c.port1.onmessage = () => {
        c.port1.close()
        resolve()
      }
      c.port2.postMessage(0)
    })
  for (let i = 0; i < 3; i++) await tick()
  for (let round = 0; round < 20; round++) {
    await document.fonts.ready
    if (![...document.fonts].some((f) => f.status === 'loading')) break
    await tick()
  }
  // images: decoded (complete) before any snapshot; a broken image counts as complete too
  const imgs = Array.from(document.images)
  await Promise.all(
    imgs.map((img) =>
      img.complete
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            img.addEventListener('load', () => resolve(), { once: true })
            img.addEventListener('error', () => resolve(), { once: true })
          }),
    ),
  )
  await tick()
}
